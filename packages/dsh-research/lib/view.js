/**
 * dsh-research — what the panel reads.
 *
 * `run.js` knows a run's FILES, `ledger.js` knows its two ledgers, and `doc.js`
 * knows its document. None of them should know about the others - that is what
 * keeps each one testable on its own - so this module is the one place they are
 * composed into the payload the Research tab polls.
 *
 * It exists rather than being assembled inside each caller for one reason: the
 * panel and the `rs_read what=run` tool must see the SAME run. Two composition
 * sites drift, and a panel that disagrees with the tool about how many claims a
 * run has is a panel nobody can trust.
 *
 * Everything here is BOUNDED. The tab re-reads this payload every 1500 ms while it
 * is visible, so a ledger with 10 000 rows must not be sent whole: each list is
 * capped, the cap is reported in `notes`, and the counts in `ledger` stay exact so
 * a truncated list never reads as the whole truth.
 */

import { ResearchError, projectView } from './run.js'
import { claimStatusOf, readClaims, readSources } from './ledger.js'
import { assembleDocument, scanDocument, validateStructure, wordCount } from './doc.js'
import { locatorLabel } from './syntax.js'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** How many rows of each ledger the panel receives. */
export const MAX_PANEL_CLAIMS = 200
export const MAX_PANEL_SOURCES = 200
export const MAX_PANEL_SECTIONS = 100
/** How much of one claim's text, reason or title travels. */
export const CLAIM_TEXT_CHARS = 400
export const REASON_CHARS = 300
export const REF_TEXT_CHARS = 200

/** One string, capped, with the marker that says it was capped. */
function cut(value, max) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** A claim, as the panel draws it. */
export function claimView(row) {
  const bindings = Array.isArray(row.sources) ? row.sources : []
  return {
    id: String(row.id ?? ''),
    text: cut(row.text, CLAIM_TEXT_CHARS),
    section: String(row.section ?? ''),
    strength: String(row.strength ?? 'descriptive'),
    status: claimStatusOf(row),
    tier: row.tier === null || row.tier === undefined ? '' : String(row.tier),
    strengthVerdict: row.strengthVerdict === null || row.strengthVerdict === undefined ? '' : String(row.strengthVerdict),
    checkedAt: typeof row.checkedAt === 'string' ? row.checkedAt : '',
    judge: cut(row.judge, 120),
    reason: cut(row.reason, REASON_CHARS),
    revision: Number.isFinite(Number(row.revision)) ? Number(row.revision) : 1,
    sources: bindings.map((binding) => ({
      key: String(binding && binding.key ? binding.key : ''),
      locator: binding && binding.locator ? locatorLabel(binding.locator) : '',
    })),
  }
}

/** A source, as the panel draws it: what it is, and what can be checked against it. */
export function sourceView(record) {
  const files = Array.isArray(record.files) ? record.files : []
  return {
    key: String(record.key ?? ''),
    kind: String(record.kind ?? ''),
    year: String(record.year ?? ''),
    title: cut(record.title, REF_TEXT_CHARS),
    container: cut(record.container, REF_TEXT_CHARS),
    authors: (Array.isArray(record.authors) ? record.authors : []).slice(0, 8).map((author) => ({
      family: String(author.family ?? ''),
      given: String(author.given ?? ''),
    })),
    files: files.length,
    bytes: files.reduce((total, file) => total + (Number(file.bytes) || 0), 0),
    hasText: record.text !== undefined && record.text !== null,
    textSource: record.text === undefined || record.text === null ? '' : String(record.text.source ?? ''),
    textChars: record.text === undefined || record.text === null ? 0 : Number(record.text.chars) || 0,
    doi: String(record.doi ?? ''),
    url: String(record.url ?? ''),
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    revision: Number.isFinite(Number(record.revision)) ? Number(record.revision) : 1,
  }
}

/**
 * The plan, as the panel needs it: the question in one paragraph, the method
 * record's own counts, and whether a disclosure exists.
 *
 * The QUESTION travels because a frame gate asks "is this the question?" and a
 * person who cannot see the question is answering blind. Before this, the column
 * showed the gates, the outline, the claims and the sources and never the one
 * sentence all of them are about.
 */
async function readPlan(dir) {
  const read = (file) => fsp.readFile(path.join(dir, file), 'utf8').catch(() => null)
  const rq = await read('plan/rq.md')
  const methodText = await read('plan/method.json')
  const disclosureText = await read('plan/disclosure.json')

  let method = null
  if (methodText !== null) {
    try {
      const record = JSON.parse(methodText)
      const screening = record.screening ?? {}
      method = {
        databases: Array.isArray(record.databases) ? record.databases.length : 0,
        accessed: String(record.accessed ?? ''),
        identified: Number(screening.identified ?? 0),
        screened: Number(screening.screened ?? 0),
        included: Number(screening.included ?? 0),
      }
    } catch {
      method = null
    }
  }

  let authors = 0
  let disclosureOk = false
  if (disclosureText !== null) {
    try {
      const record = JSON.parse(disclosureText)
      authors = Array.isArray(record.authors) ? record.authors.length : 0
      disclosureOk = true
    } catch {
      disclosureOk = false
    }
  }

  // The question is prose and prose is compared by a person, not by a parser:
  // whitespace is collapsed so a hard-wrapped rq.md is one paragraph on screen,
  // and the text is capped because a panel is a preview, never the document.
  const question = String(rq ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    rq: cut(question, 900),
    method,
    disclosure: { exists: disclosureOk, authors },
  }
}

/**
 * One run, as the panel reads it: the run, its gates, its passport, its files, its
 * two ledgers (bounded), its outline, and whether the document and the ledgers
 * currently agree.
 *
 * `structure` travels as CODES plus counts rather than full problem objects: the
 * panel shows a chip and the codes, and the detail is one `rs_read` away. Sending
 * every problem text on every poll would be the payload that grows without bound.
 */
export async function projectDetail(options) {
  const base = await projectView(options)
  const dir = base.run.path
  const notes = [...base.notes]

  const { rows: claimRows, current: claims } = await readClaims(dir)
  const { rows: sourceRows, current: sources } = await readSources(dir)

  const document = await assembleDocument(dir)
  const scan = scanDocument(document.text)
  const structure = validateStructure({
    scan,
    claims,
    sourcesByKey: new Map(sources.map((record) => [record.key, record])),
  })

  if (claims.length > MAX_PANEL_CLAIMS) notes.push('the panel shows the first ' + MAX_PANEL_CLAIMS + ' of ' + claims.length + ' claims')
  if (sources.length > MAX_PANEL_SOURCES) notes.push('the panel shows the first ' + MAX_PANEL_SOURCES + ' of ' + sources.length + ' sources')

  const plan = await readPlan(dir)

  return {
    ...base,
    // `claims`/`sources`/`reviews` keep their original meaning - how many ROWS each
    // ledger file holds, or null when there is no such file yet - and `current`
    // adds how many are live after folding the revisions. Both are here because a
    // panel showing "12 claims" beside a truth of 9 live ones would be lying about
    // something a person is entitled to know exactly.
    ledger: {
      ...base.ledger,
      current: { claims: claims.length, sources: sources.length },
    },
    claims: claims.slice(0, MAX_PANEL_CLAIMS).map(claimView),
    sources: sources.slice(0, MAX_PANEL_SOURCES).map(sourceView),
    outline: {
      source: document.source,
      words: wordCount(document.text),
      parts: document.parts.map((part) => ({ slug: part.slug, file: part.file })),
      sections: scan.sections.slice(0, MAX_PANEL_SECTIONS).map((section) => ({
        slug: section.slug,
        title: cut(section.title, 120),
        level: section.level,
        words: section.words,
        claims: section.claims.length,
      })),
      citations: scan.citationKeys.length,
    },
    structure: {
      ok: structure.ok,
      errors: structure.errors.length,
      warnings: structure.warnings.length,
      // Unique codes, in the order they were found: the chip names them and the
      // detail is an `rs_read` away.
      codes: [...new Set(structure.problems.map((problem) => problem.code))],
    },
    document: { source: document.source, words: wordCount(document.text) },
    plan,
    notes,
  }
}

/** One run's detail, or a refusal that names the run. */
export async function projectDetailOrThrow(options) {
  try {
    return await projectDetail(options)
  } catch (err) {
    throw err instanceof ResearchError ? err : new ResearchError('UNKNOWN_RUN', String(err && err.message ? err.message : err))
  }
}
