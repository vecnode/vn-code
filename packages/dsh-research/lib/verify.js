/**
 * dsh-research — the rungs that need no reader.
 *
 * The ladder is `r0-structure` (in `doc.js`), `r1-record` and `r2-locate` here,
 * then `r3-support` and `r4-audit`, which are the ones that need a JUDGE and are
 * therefore the agent's job rather than this module's.
 *
 * What makes these two trustworthy is that they are boring: they read files that
 * are already in the run and compare strings. No model, no network, no judgement -
 * so this is also what a ROUTE may re-run any time the panel asks, which is the
 * rule the design set (a route runs no model, and can therefore honestly say which
 * rungs it re-ran).
 *
 * Two rules are the whole value of this file:
 *
 *   1. **A rung that could not run says so.** A source with no stored text has not
 *      "passed" `r1`; it is `uncheckable`, and the report names it. The quiet
 *      failure this prevents is a run that looks fully checked because every check
 *      that could not run was silently skipped.
 *   2. **A miss is not an inconclusive.** A quote that is not in the text we have
 *      is `locate-miss` ONLY when the text is known to be complete; when the
 *      extractor reported no coverage, the honest answer is `locate-inconclusive`.
 *      Telling an author their quote is not in the paper when the extraction was
 *      partial is the worst answer this package could give, and it is the one an
 *      eager implementation gives by default.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { ResearchError, messageOf, sizeOf, stamp } from './run.js'
import { claimStatusOf, readClaims, readSources, sourcesByKey } from './ledger.js'

/** The rungs this module can run, in order. */
export const FILE_RUNGS = ['r1-record', 'r2-locate']
/** How much of a source's text the title match looks at. */
export const TITLE_WINDOW_CHARS = 6000
/** The fraction of a title's significant words that must be found. */
export const TITLE_MATCH_FLOOR = 0.6
/** How many bytes of stored source files are hashed in one `r1` run. */
export const MAX_HASH_BYTES = 32 * 1024 * 1024
/** The context window reported around a located quote. */
export const LOCATE_CONTEXT_CHARS = 160

/** Words a title can carry that say nothing about which paper it is. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'onto', 'over', 'under',
  'between', 'among', 'about', 'after', 'before', 'during', 'their', 'there', 'where', 'which', 'while',
  'study', 'studies', 'paper', 'article', 'review', 'analysis', 'research', 'results', 'effect', 'effects',
])

/**
 * Text as a searcher should see it.
 *
 * Four normalisations, each of which is a real mismatch between a quote a person
 * copied and the text an extractor produced:
 *   - case, because nobody quotes with matching case;
 *   - curly quotes and dashes turned straight, because a PDF is full of them and a
 *     keyboard is not;
 *   - whitespace collapsed to single spaces, because a line break inside a sentence
 *     is not a difference;
 *   - and a HYPHEN AT A LINE BREAK removed (`comple-\ntion` -> `completion`), which
 *     is the commonest way a PDF's text layer breaks a word and the commonest
 *     reason a correct quote fails to match.
 */
export function normalizeForSearch(value) {
  return String(value ?? '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a quote appears in a text, and where.
 *
 * @returns `{ found, index }` - `index` is into the NORMALISED text, which is what
 * the caller needs to cut a context window out of.
 */
export function locateQuote(text, quote) {
  const haystack = normalizeForSearch(text)
  const needle = normalizeForSearch(quote)
  if (needle === '') return { found: false, index: -1 }
  const index = haystack.indexOf(needle)
  return { found: index !== -1, index }
}

/** Whether a stored text is complete enough for a miss to mean anything. */
export function textIsComplete(text) {
  if (text === null || text === undefined) return false
  const coverage = text.coverage
  if (coverage === null || coverage === undefined) return false
  return Number(coverage) >= 0.9
}

/** The significant words of a title, for the match test. */
export function titleWords(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !TITLE_STOPWORDS.has(word))
    .slice(0, 12)
}

/** One finding: a code, which rung produced it, and the sentence a reader needs. */
function finding(code, rung, detail, extra = {}) {
  return { code, rung, detail, ...extra }
}

/**
 * **r1-record** — the source is what it says it is.
 *
 * Five things are checked, and each has its own code because each one means
 * something different to the person reading the report:
 *   - the stored bytes still hash to the name they are filed under
 *     (`bytes-tampered` is the one that catches a file replaced by hand);
 *   - bytes this run could not hash - because the ceiling stopped it - are
 *     named (`bytes-unhashed`) rather than passed over, since an unread source
 *     is unverified, not verified;
 *   - the record has the fields a reference cannot be built without
 *     (`field-missing`);
 *   - every field names where it came from (`origin-missing`), because a field
 *     nobody typed is a field nobody can be wrong about;
 *   - and the title it claims appears in the text that was ingested
 *     (`title-mismatch`) - the guard against a record pointing at a real paper
 *     that is not the paper the document quotes.
 *
 * @returns `{ findings, checked, uncheckable, hashedBytes }` - and NO status
 * change: r1 is about sources, and a source's health is a fact about the record,
 * not a verdict about a claim. `hashedBytes` is what the ceiling actually let
 * the run read, so a caller can say how much was proved.
 */
export async function r1Sources(options) {
  const dir = options.dir
  const findings = []
  const uncheckable = []
  let checked = 0
  let hashed = 0

  for (const record of options.sources ?? []) {
    const key = String(record.key ?? '')
    const perSource = []
    const files = Array.isArray(record.files) ? record.files : []

    // --- the bytes
    if (files.length === 0) {
      perSource.push(finding('bytes-missing', 'r1-record', 'no file is stored for ' + key + ', so nothing about this source can be read from the run'))
    }
    for (const file of files) {
      const sha256 = String(file.sha256 ?? '')
      if (sha256 === '') {
        perSource.push(finding('bytes-missing', 'r1-record', key + ' has a file entry with no hash, so it cannot be checked at all'))
        continue
      }
      // The ceiling is reported, never skipped in silence: a source this run
      // did not hash has NOT been proven to be the bytes that were ingested,
      // and an unread byte is exactly what `bytes-tampered` exists to catch.
      const bytes = Number(file.bytes) || 0
      if (hashed + bytes > MAX_HASH_BYTES) {
        perSource.push(
          finding(
            'bytes-unhashed',
            'r1-record',
            key + ': ' + sizeOf(bytes) + ' of stored bytes were NOT hashed because this run stops at ' + sizeOf(MAX_HASH_BYTES) + ', so those bytes are unverified rather than proved authentic',
            { bytes, limit: MAX_HASH_BYTES, sha256 },
          ),
        )
        continue
      }
      const absolute = await findStoredFile(dir, sha256)
      if (absolute === null) {
        perSource.push(finding('bytes-missing', 'r1-record', 'the stored file for ' + key + ' (' + sha256.slice(0, 12) + '…) is not in sources/ - it was moved or deleted'))
        continue
      }
      const buffer = await fsp.readFile(absolute).catch(() => null)
      if (buffer === null) continue
      hashed += buffer.length
      if (createHash('sha256').update(buffer).digest('hex') !== sha256) {
        perSource.push(finding('bytes-tampered', 'r1-record', 'the bytes filed as ' + sha256.slice(0, 12) + '… for ' + key + ' no longer hash to that name, so what is stored is not what was ingested'))
      }
    }

    // --- the record
    const provenance = record.provenance !== null && typeof record.provenance === 'object' ? record.provenance : {}
    const needs = record.kind === 'journal-article' || record.kind === 'chapter' || record.kind === 'conference-paper' ? ['title', 'year', 'container'] : ['title', 'year']
    for (const field of needs) {
      if (String(record[field] ?? '').trim() === '') {
        perSource.push(finding('field-missing', 'r1-record', key + ' has no ' + field + ', so a reference list cannot be complete for it'))
      }
    }
    for (const field of Object.keys(record)) {
      if (['key', 'revision', 'addedAt', 'updatedAt', 'provenance', 'files', 'text', 'findings'].includes(field)) continue
      const value = record[field]
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue
      if (provenance[field] === undefined) {
        perSource.push(finding('origin-missing', 'r1-record', key + ': `' + field + '` has no recorded origin, so a reader cannot tell whether a service supplied it or a person typed it'))
      }
    }

    // --- the title, against the text that was actually ingested
    const text = await readSourceText(dir, record)
    if (text === null) {
      uncheckable.push({ key, why: 'no text is stored for this source, so its title cannot be matched against it and a quote in it cannot be located' })
      perSource.push(finding('text-missing', 'r1-record', key + ' has no stored text: read it with the pdf_* tools and ingest what they return as `text=`'))
    } else {
      const words = titleWords(record.title)
      if (words.length === 0) {
        perSource.push(finding('title-uncheckable', 'r1-record', key + '\'s title has no significant words to match on'))
      } else {
        const window = normalizeForSearch(text).slice(0, TITLE_WINDOW_CHARS)
        const hit = words.filter((word) => window.includes(word))
        const ratio = hit.length / words.length
        if (ratio < TITLE_MATCH_FLOOR) {
          perSource.push(
            finding('title-mismatch', 'r1-record', key + ': only ' + Math.round(ratio * 100) + '% of the title\'s significant words appear in the ingested text (' + hit.join(', ') + ' of ' + words.join(', ') + ') - the record may name a different paper from the one stored', { ratio }),
          )
        } else {
          checked += 1
        }
      }
    }
    findings.push(...perSource)
  }
  return { findings, checked, uncheckable, hashedBytes: hashed }
}

/**
 * **r2-locate** — the quote is really in the source.
 *
 * A claim is only checkable here when it has a `quote` locator AND its source has
 * stored text. Everything else is reported as what it is:
 *   - `claim-unsourced` - no source at all;
 *   - `locator-missing` - a source but no locator;
 *   - `locate-uncheckable` - a locator of a kind this rung cannot search (a page
 *     number is a human's pointer, not a string to find), or a source with no text.
 *
 * @returns `{ findings, located, uncheckable, changed }` where `changed` lists the
 * claims whose status moved to `located`.
 */
export async function r2Claims(options) {
  const dir = options.dir
  const byKey = options.sourcesByKey ?? sourcesByKey(options.sources ?? [])
  const texts = new Map()
  const findings = []
  const located = []
  const uncheckable = []

  for (const claim of options.claims ?? []) {
    const id = String(claim.id ?? '')
    const bindings = Array.isArray(claim.sources) ? claim.sources : []
    if (bindings.length === 0) {
      findings.push(finding('claim-unsourced', 'r2-locate', 'claim ' + id + ' rests on no source, so no quote of it can be located', { id }))
      continue
    }
    let decided = false
    for (const binding of bindings) {
      const record = byKey.get(String(binding.key ?? ''))
      if (record === undefined) {
        findings.push(finding('unknown-source', 'r2-locate', 'claim ' + id + ' is bound to ' + String(binding.key) + ', which is not in the ledger', { id, key: String(binding.key) }))
        continue
      }
      const locator = binding.locator === null || binding.locator === undefined ? null : binding.locator
      if (locator === null) {
        findings.push(finding('locator-missing', 'r2-locate', 'claim ' + id + ' binds ' + record.key + ' with no locator, so there is nothing to look for', { id, key: record.key }))
        continue
      }
      if (locator.kind !== 'quote') {
        uncheckable.push({ id, key: record.key, why: 'the locator is a `' + locator.kind + '`, which is a pointer a reader follows rather than a string this rung can search' })
        continue
      }
      if (texts.get(record.key) === undefined) texts.set(record.key, await readSourceText(dir, record))
      const text = texts.get(record.key)
      if (text === null) {
        uncheckable.push({ id, key: record.key, why: 'no text is stored for ' + record.key + ', so its quote cannot be searched for' })
        continue
      }
      const result = locateQuote(text, locator.quote)
      if (result.found) {
        const normal = normalizeForSearch(text)
        located.push({ id, key: record.key, at: result.index, context: normal.slice(Math.max(0, result.index - LOCATE_CONTEXT_CHARS), result.index + String(locator.quote).length + LOCATE_CONTEXT_CHARS) })
        decided = true
        continue
      }
      // Not found. WHICH answer that is depends on whether the text is complete -
      // this is the distinction that keeps a partial extraction from slandering a
      // source that says exactly what the claim says it does. It is the TEXT
      // RECORD's own coverage that decides, never the body's: the body is a string
      // and has no coverage, and reading it as one makes every miss inconclusive,
      // which is the bug this comment exists to keep fixed.
      if (textIsComplete(record.text)) {
        findings.push(finding('locate-miss', 'r2-locate', 'claim ' + id + '\'s quote is NOT in the stored text of ' + record.key + ' (the extractor reported complete coverage), so either the quote is wrong or the source does not say it', { id, key: record.key, quote: String(locator.quote).slice(0, 120) }))
      } else {
        uncheckable.push({ id, key: record.key, why: 'the quote was not found, but the extraction reports no coverage, so this is INCONCLUSIVE rather than a miss - the text may simply be incomplete' })
        findings.push(finding('locate-inconclusive', 'r2-locate', 'claim ' + id + '\'s quote was not found in the stored text of ' + record.key + ' and that text is not known to be complete, so nothing can be concluded', { id, key: record.key }))
      }
    }
    if (decided) continue
  }
  return { findings, located, uncheckable }
}

/** The stored text of a source, or null when there is none. */
export async function readSourceText(dir, record) {
  const text = record === null || record === undefined ? null : record.text
  if (text === null || text === undefined) return null
  const file = String(text.file ?? '')
  if (file === '') return null
  const absolute = path.join(dir, ...file.split('/'))
  const body = await fsp.readFile(absolute, 'utf8').catch(() => null)
  return body
}

/** The stored bytes of a source, found by hash whatever extension they carry. */
export async function findStoredFile(dir, sha256) {
  const sourcesDir = path.join(dir, 'sources')
  const entries = await fsp.readdir(sourcesDir).catch(() => [])
  for (const name of entries) {
    if (name.startsWith(String(sha256)) && !name.endsWith('.partial')) return path.join(sourcesDir, name)
  }
  return null
}

/**
 * The ladder, as it stands right now: what each rung says, and what it cannot say.
 *
 * `r3`/`r4` are listed with the counts they WOULD need (claims with a located quote
 * and no verdict) rather than being run: they need a reader, and a report that
 * claimed to have run them would be the lie this whole file is written to avoid.
 */
export async function ladderReport(options) {
  const dir = options.dir
  const { current: sources } = await readSources(dir)
  const { current: claims } = await readClaims(dir)
  const byKey = sourcesByKey(sources)

  const r1 = await r1Sources({ dir, sources })
  const r2 = await r2Claims({ dir, claims, sourcesByKey: byKey })

  const statuses = {}
  for (const claim of claims) {
    const status = claimStatusOf(claim)
    statuses[status] = (statuses[status] ?? 0) + 1
  }
  const awaitingJudge = claims
    .filter((claim) => claimStatusOf(claim) === 'located' || (Array.isArray(claim.sources) && claim.sources.length > 0))
    .length

  return {
    at: stamp(options.now),
    sources: sources.length,
    claims: claims.length,
    rungs: [
      {
        rung: 'r1-record',
        state: r1.findings.length > 0 ? 'findings' : r1.checked > 0 ? 'ok' : 'nothing-to-check',
        checked: r1.checked,
        hashedBytes: r1.hashedBytes,
        hashLimit: MAX_HASH_BYTES,
        findings: r1.findings,
        uncheckable: r1.uncheckable,
      },
      {
        rung: 'r2-locate',
        state: r2.findings.length > 0 ? 'findings' : r2.located.length > 0 ? 'ok' : 'nothing-to-check',
        located: r2.located.length,
        findings: r2.findings,
        uncheckable: r2.uncheckable,
      },
      { rung: 'r3-support', state: 'needs-a-reader', waiting: awaitingJudge, why: 'a verdict about whether a passage SUPPORTS a claim is a judgement, so it is recorded by the agent with `rs_verify action=support` and never by a route' },
      { rung: 'r4-audit', state: 'needs-a-reader', waiting: 0, why: 'the adversarial pass reads the same passages again with the opposite instruction' },
    ],
    statuses,
  }
}

export { messageOf, ResearchError }
