/**
 * dsh-research — the ledgers.
 *
 * Three append-only JSONL files inside a run: `ledger/sources.jsonl` (what was
 * read), `ledger/claims.jsonl` (what the document asserts, and how far each
 * assertion has been checked) and `ledger/reviews.jsonl` (what a reviewer said).
 *
 * **Append-only, one line per REVISION, is the whole point.** A claim whose
 * wording changes is appended again rather than edited in place, because
 * verification belongs to a specific wording: if a claim said "raises completion
 * by 12 points" and was checked against a source, and the sentence is then edited
 * to "raises completion by 25 points", the old verdict is about a sentence that no
 * longer exists. This module therefore folds each id to its LAST row (that is the
 * current claim) while keeping every earlier row as the trail that shows what was
 * verified and when it stopped being true.
 *
 * A row that would change nothing is NOT appended - the same source ingested twice
 * and the same claim declared twice are one row each - so a ledger's length means
 * "how many times something actually changed" rather than "how many times a tool
 * was called".
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ResearchError, messageOf, sizeOf, stamp } from './run.js'
import { SOURCE_KINDS, isClaimId, isKey, isStrength, normalizeLocator, normalizeStatistic, parseClaimId, parseKey } from './syntax.js'

/** The three ledgers, relative to a run folder. */
export const LEDGER_PATHS = {
  sources: 'ledger/sources.jsonl',
  claims: 'ledger/claims.jsonl',
  reviews: 'ledger/reviews.jsonl',
}

/** The status a claim starts at, and the vocabulary it can move through. */
export const CLAIM_STATUSES = [
  'unverified',
  'located',
  'supported',
  'partially-supported',
  'unsupported',
  'contradicted',
  'misattributed',
  'not-checked',
]

/** The statuses a `draft=clean` build refuses to publish. */
export const BLOCKING_STATUSES = ['unsupported', 'contradicted', 'misattributed']

/** The rungs, in the order they are earned. Every status names the rung that gave it. */
export const RUNGS = ['r0-structure', 'r1-record', 'r2-locate', 'r3-support', 'r4-audit']

/** One ledger file's absolute path. */
export function ledgerPath(runDir, which) {
  const relative = LEDGER_PATHS[which]
  if (relative === undefined) throw new ResearchError('BAD_LEDGER', 'no ledger named ' + JSON.stringify(String(which)))
  return path.join(runDir, ...relative.split('/'))
}

/**
 * Read a JSONL ledger.
 *
 * A malformed line is a REFUSAL naming its line number, never a skipped row: a
 * ledger that silently drops a claim is worse than one that refuses to be read,
 * because the document still cites it and nothing says why it vanished.
 */
export async function readJsonl(file) {
  const text = await fsp.readFile(file, 'utf8').catch((err) => {
    if (err && err.code === 'ENOENT') return null
    throw err
  })
  if (text === null) return []
  const rows = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const row = JSON.parse(line)
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('not a JSON object')
      rows.push(row)
    } catch (err) {
      throw new ResearchError(
        'MALFORMED_LEDGER',
        path.basename(file) + ' line ' + (index + 1) + ' is not a JSON object: ' + messageOf(err) + ' - fix or remove that one line; nothing else in the ledger is affected',
      )
    }
  }
  return rows
}

/** Append one row. The only write this module performs. */
export async function appendJsonl(file, row) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
  return row
}

/**
 * The current row per id: the LAST row that names it.
 *
 * Order follows each id's last appearance, so a ledger reads as the history of
 * what is currently true rather than as the order things were first mentioned.
 */
export function foldLatest(rows, field = 'id') {
  const last = new Map()
  for (const row of rows ?? []) {
    const key = row === null || row === undefined ? undefined : row[field]
    if (typeof key !== 'string' || key === '') continue
    last.delete(key)
    last.set(key, row)
  }
  return [...last.values()]
}

/** Whether two rows say the same thing, so an unchanged write is not appended. */
function sameRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Read every source revision and the current record per key. */
export async function readSources(runDir) {
  const file = ledgerPath(runDir, 'sources')
  const rows = await readJsonl(file)
  const current = foldLatest(rows, 'key')
  return { file, rows, current }
}

/** Read every claim revision and the current row per id. */
export async function readClaims(runDir) {
  const file = ledgerPath(runDir, 'claims')
  const rows = await readJsonl(file)
  const current = foldLatest(rows, 'id')
  return { file, rows, current }
}

/** Read the review ledger. */
export async function readReviews(runDir) {
  const file = ledgerPath(runDir, 'reviews')
  const rows = await readJsonl(file)
  return { file, rows, current: foldLatest(rows, 'id') }
}

/** The current sources, by key. */
export function sourcesByKey(current) {
  const map = new Map()
  for (const record of current ?? []) map.set(record.key, record)
  return map
}

/** The current claims, by id. */
export function claimsById(current) {
  const map = new Map()
  for (const row of current ?? []) map.set(row.id, row)
  return map
}

/**
 * A source record, validated and completed.
 *
 * Only `key`, `kind` and `title` are required. Everything else is optional and
 * stored as `''` rather than `undefined`, because a builder that has to guard
 * every field is a builder that eventually prints `undefined` into a reference
 * list - the one place a reader would see the machinery.
 */
export function normalizeSource(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResearchError('BAD_SOURCE', 'a source is an object with at least a key, a kind and a title')
  }
  const key = parseKey(input.key)
  const kind = typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'journal-article'
  if (!SOURCE_KINDS.includes(kind)) {
    throw new ResearchError('BAD_SOURCE', 'kind must be one of ' + SOURCE_KINDS.join(', ') + ' (got ' + JSON.stringify(kind) + ')')
  }
  const title = String(input.title ?? '').trim()
  if (title === '') {
    throw new ResearchError('BAD_SOURCE', 'source ' + key + ' needs a title: it is what a reader uses to find it')
  }
  const authors = Array.isArray(input.authors)
    ? input.authors
        .filter((author) => author !== null && typeof author === 'object')
        .map((author) => ({
          family: String(author.family ?? '').trim(),
          given: String(author.given ?? '').trim(),
        }))
        .filter((author) => author.family !== '' || author.given !== '')
    : []
  const text = (value, max = 500) => String(value ?? '').trim().slice(0, max)
  const record = {
    key,
    kind,
    title: title.slice(0, 1000),
    authors,
    year: text(input.year, 24),
    container: text(input.container, 500),
    editor: Array.isArray(input.editor) ? input.editor.length : 0,
    volume: text(input.volume, 40),
    issue: text(input.issue, 40),
    pages: text(input.pages, 60),
    edition: text(input.edition, 40),
    publisher: text(input.publisher, 300),
    place: text(input.place, 200),
    doi: text(input.doi, 200).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
    url: text(input.url, 1000),
    isbn: text(input.isbn, 40),
    issn: text(input.issn, 40),
    accessed: text(input.accessed, 24),
    note: text(input.note, 2000),
  }
  if (Array.isArray(input.editor) && input.editor.length > 0) {
    record.editors = input.editor
      .filter((one) => one !== null && typeof one === 'object')
      .map((one) => ({ family: String(one.family ?? '').trim(), given: String(one.given ?? '').trim() }))
  }
  return record
}

/**
 * Ingest one source: append a revision, unless nothing about it changed.
 *
 * @returns `{ record, revision, changed }`.
 */
export async function appendSource(runDir, input, now) {
  const record = normalizeSource(input)
  const { file, current } = await readSources(runDir)
  const existing = current.find((one) => one.key === record.key) ?? null
  const payload = { ...record, revision: existing === null ? 1 : Number(existing.revision ?? 1) + 1, updatedAt: stamp(now) }
  if (existing !== null) {
    const comparable = (one) => {
      const copy = { ...one }
      delete copy.revision
      delete copy.updatedAt
      delete copy.addedAt
      return copy
    }
    if (sameRow(comparable(existing), comparable(payload))) {
      return { record: existing, revision: Number(existing.revision ?? 1), changed: false }
    }
    payload.addedAt = typeof existing.addedAt === 'string' ? existing.addedAt : stamp(now)
  } else {
    payload.addedAt = stamp(now)
  }
  await appendJsonl(file, { ...payload, ...(input.files === undefined ? {} : { files: input.files }), ...(input.text === undefined ? {} : { text: input.text }), ...(input.provenance === undefined ? {} : { provenance: input.provenance }) })
  return { record: payload, revision: payload.revision, changed: true }
}

/** Attach files and/or extracted text to a source that is already in the ledger. */
export async function attachToSource(runDir, key, patch, now) {
  const parsed = parseKey(key)
  const { current } = await readSources(runDir)
  const existing = current.find((one) => one.key === parsed) ?? null
  if (existing === null) {
    throw new ResearchError('UNKNOWN_SOURCE', 'no source named ' + parsed + ' - ingest it first (rs_cite action=add)')
  }
  const files = Array.isArray(existing.files) ? existing.files : []
  const nextFiles = Array.isArray(patch.files) ? [...files, ...patch.files] : files
  // A file that is already attached by hash is not attached twice: re-running an
  // ingest must not grow the record.
  const seen = new Set()
  const deduped = nextFiles.filter((file) => {
    const hash = file && typeof file.sha256 === 'string' ? file.sha256 : ''
    if (hash === '' || seen.has(hash)) return false
    seen.add(hash)
    return true
  })
  const record = {
    ...existing,
    files: deduped,
    ...(patch.text === undefined ? {} : { text: patch.text }),
    ...(patch.provenance === undefined ? {} : { provenance: { ...(existing.provenance ?? {}), ...patch.provenance } }),
    revision: Number(existing.revision ?? 1) + 1,
    updatedAt: stamp(now),
  }
  const { file } = await readSources(runDir)
  await appendJsonl(file, record)
  return record
}

/**
 * A claim row, from what the document says and what the caller declared.
 *
 * `text` comes from the SPAN, not from the caller: the document is the source of
 * truth for the prose, and a ledger row that disagrees with the sentence it points
 * at is a row nothing can check.
 */
export function claimRow(input) {
  const id = parseClaimId(input.id)
  const text = String(input.text ?? '').trim()
  if (text === '') throw new ResearchError('BAD_CLAIM', 'claim ' + id + ' has no text - a claim span must contain the sentence it claims')
  const strength = input.strength ?? 'descriptive'
  if (!isStrength(strength)) {
    throw new ResearchError('BAD_CLAIM', 'claim ' + id + ' strength must be causal, associational, descriptive, theoretical or normative (got ' + JSON.stringify(strength) + ')')
  }
  const sources = Array.isArray(input.sources)
    ? input.sources.map((binding) => {
        if (binding === null || typeof binding !== 'object') {
          throw new ResearchError('BAD_CLAIM', 'claim ' + id + ': a source binding is { key, locator }')
        }
        const key = parseKey(binding.key)
        const locator = normalizeLocator(binding.locator ?? null)
        return { key, locator }
      })
    : []
  return {
    id,
    text: text.slice(0, 2000),
    section: String(input.section ?? '').trim().slice(0, 120),
    strength,
    // The numbers the sentence rests on, as data. A claim that reports a test and
    // reports it wrongly is a defect a reader can see; a claim that reports one in
    // prose only is a defect nobody can.
    statistic: normalizeStatistic(input.statistic ?? null),
    sources,
    status: 'unverified',
    tier: null,
    strengthVerdict: null,
    checkedAt: null,
    judge: null,
    reason: '',
    // What a file-checking rung found about this claim. Cleared with the verdict
    // when the wording changes, for the same reason: a finding is about a sentence.
    findings: [],
    createdAt: stamp(input.now),
  }
}

/** The fields a verification leaves behind, all of which a wording change clears. */
const VERDICT_FIELDS = ['status', 'tier', 'strengthVerdict', 'checkedAt', 'judge', 'reason', 'findings']

/**
 * Record one claim, appending only when something changed.
 *
 * **A changed wording invalidates the verification.** That is the rule this
 * function exists for: `status`, `tier`, the rung, the judge and the reason are
 * cleared when `text`, `strength`, the statistic or the source bindings differ from
 * the current row, and the returned `invalidated` says whether it happened, so the
 * caller can tell the user that a claim they had already checked is now unverified.
 * Keeping a verdict across an edit would be the quietest way this whole ledger could
 * lie.
 *
 * The statistic belongs on that list even though it is not part of the sentence: a
 * verdict says "this passage supports what this claim asserts", and `p = .032` is
 * part of what it asserts. Correcting a number is changing the claim, and the check
 * that was made about the old number is about a claim that no longer exists.
 */
export async function appendClaim(runDir, input, now) {
  const row = claimRow({ ...input, now })
  const { file, current } = await readClaims(runDir)
  const existing = current.find((one) => one.id === row.id) ?? null
  if (existing === null) {
    await appendJsonl(file, row)
    return { row, added: true, invalidated: false, revision: 1 }
  }
  const sameWording =
    existing.text === row.text &&
    existing.strength === row.strength &&
    JSON.stringify(existing.statistic ?? null) === JSON.stringify(row.statistic ?? null) &&
    JSON.stringify(existing.sources ?? []) === JSON.stringify(row.sources)
  const samePlacement = existing.section === row.section
  if (sameWording && samePlacement) {
    return { row: existing, added: false, invalidated: false, revision: Number(existing.revision ?? 1) }
  }
  const carried = {}
  for (const field of VERDICT_FIELDS) carried[field] = existing[field] === undefined ? null : existing[field]
  const next = {
    ...row,
    ...(sameWording ? carried : {}),
    revision: Number(existing.revision ?? 1) + 1,
    revisedAt: stamp(now),
    createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : row.createdAt,
  }
  await appendJsonl(file, next)
  return { row: next, added: true, invalidated: !sameWording, revision: next.revision }
}

/**
 * Record what a FILE rung found, on a source or on a claim.
 *
 * Findings are not verdicts: `bytes-tampered` is a fact about a file, and
 * `locate-miss` is a fact about a string, neither of which says whether a claim is
 * true. They are stored on the row they are about, appended like everything else,
 * and CLEARED when a claim's wording changes - a finding about a sentence that no
 * longer exists is not a finding.
 *
 * @returns the new row.
 */
export async function applyFindings(runDir, input, now) {
  const target = input.target === 'source' ? 'sources' : 'claims'
  const field = target === 'sources' ? 'key' : 'id'
  const file = ledgerPath(runDir, target)
  const rows = await readJsonl(file)
  const current = foldLatest(rows, field)
  const existing = current.find((row) => row[field] === input.id) ?? null
  if (existing === null) {
    throw new ResearchError(
      target === 'sources' ? 'UNKNOWN_SOURCE' : 'UNKNOWN_CLAIM',
      'no ' + (target === 'sources' ? 'source' : 'claim') + ' named ' + JSON.stringify(String(input.id ?? '')) + ' - a finding records what was checked, it cannot create it',
    )
  }
  const previous = Array.isArray(existing.findings) ? existing.findings : []
  // A rung RE-runs, so its own findings are replaced rather than piled up; another
  // rung's are kept, because r1 and r2 answer different questions.
  const kept = previous.filter((one) => one === null || one === undefined || one.rung !== input.rung)
  const next = {
    ...existing,
    findings: [...kept, ...(Array.isArray(input.findings) ? input.findings : [])],
    revision: Number(existing.revision ?? 1) + 1,
    checkedAt: stamp(now),
  }
  if (input.status !== undefined) next.status = input.status
  if (input.tier !== undefined) next.tier = input.tier
  if (input.context !== undefined) next.locatedContext = input.context
  await appendJsonl(file, next)
  return next
}

/** The current claim for an id, or null. */
export function claimOf(current, id) {
  if (!isClaimId(id)) return null
  return (current ?? []).find((row) => row.id === id) ?? null
}

/**
 * Record a verification verdict against the claim as it is NOW written.
 *
 * This is the only way a claim's status moves, and it is deliberately narrow:
 *
 *   - the claim must exist, so a verdict cannot invent one;
 *   - the status must be in the closed vocabulary, so nothing can write
 *     `pretty-sure` and have a reader believe it;
 *   - the row it appends carries the Wording it judged (`text`) as well as the
 *     verdict, so a later edit that changes the sentence is visible as a claim
 *     whose `text` no longer matches the row the verdict names;
 *   - and `judge` is mandatory, because "who decided this" is the question a
 *     reader asks of every verdict in the ledger.
 *
 * It never refuses a verdict for being unwelcome - `unsupported` and
 * `contradicted` are results, not errors. What refuses a verdict is missing
 * evidence, and that gate lives with the rung that produces it.
 */
export async function recordVerdict(runDir, input, now) {
  const { file, current } = await readClaims(runDir)
  const existing = current.find((row) => row.id === input.id) ?? null
  if (existing === null) {
    throw new ResearchError('UNKNOWN_CLAIM', 'no claim named ' + JSON.stringify(String(input.id ?? '')) + ' in this run - a verdict records what was judged, it cannot create it')
  }
  if (!CLAIM_STATUSES.includes(input.status)) {
    throw new ResearchError('BAD_STATUS', 'status must be one of ' + CLAIM_STATUSES.join(', ') + ' (got ' + JSON.stringify(String(input.status ?? '')) + ')')
  }
  const judge = String(input.judge ?? '').trim()
  if (judge === '') {
    throw new ResearchError('BAD_STATUS', 'a verdict names its judge: `judge` is what a reader uses to weigh it')
  }
  const next = {
    ...existing,
    status: input.status,
    tier: typeof input.tier === 'string' && input.tier !== '' ? input.tier : existing.tier ?? null,
    strengthVerdict: typeof input.strengthVerdict === 'string' && input.strengthVerdict !== '' ? input.strengthVerdict : existing.strengthVerdict ?? null,
    reason: String(input.reason ?? '').slice(0, 2000),
    judge: judge.slice(0, 200),
    checkedAt: stamp(now),
    revision: Number(existing.revision ?? 1) + 1,
  }
  await appendJsonl(file, next)
  return next
}

/** A claim's status, defaulted rather than trusted. */
export function claimStatusOf(row) {
  const status = row === null || row === undefined ? '' : row.status
  return CLAIM_STATUSES.includes(status) ? status : 'unverified'
}

/** The statuses present in a set of claims, counted. */
export function statusCounts(claims) {
  const counts = {}
  for (const status of CLAIM_STATUSES) counts[status] = 0
  for (const claim of claims ?? []) {
    const status = claimStatusOf(claim)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/** One source, as a person reads it in a report. */
export function sourceLabel(record) {
  if (record === null || record === undefined) return ''
  const family = Array.isArray(record.authors) && record.authors.length > 0 ? record.authors[0].family : ''
  const year = typeof record.year === 'string' && record.year !== '' ? record.year : 'n.d.'
  return (family === '' ? record.title : family + ' ' + year) + ' [' + record.key + ']'
}

/** The absolute path of a stored source file, from its hash and extension. */
export function sourceFilePath(runDir, sha256, extension) {
  const ext = typeof extension === 'string' && /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : '.bin'
  return path.join(runDir, 'sources', String(sha256) + ext)
}

/** The absolute path of a source's extracted text, from its hash. */
export function sourceTextPath(runDir, sha256) {
  return path.join(runDir, 'sources', String(sha256) + '.txt')
}

export { sizeOf, messageOf }
