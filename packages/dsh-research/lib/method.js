/**
 * dsh-research — the method record.
 *
 * A run's `plan/method.md` is prose an author writes and nothing can check. The
 * METHOD RECORD is the same thing as data: which databases were searched, when,
 * with what string, what was included and excluded, and how many records survived
 * each step. It is written to `plan/method.json`, validated on the way in, and
 * printed back into the document as a PRISMA-shaped flow.
 *
 * Why a record rather than a paragraph: "we searched PubMed and Web of Science"
 * is a sentence no one can reproduce and no check can read. Four fields - the
 * databases, the date of access, the string, and the counts - are what makes a
 * search reproducible, and the counts are the only place a review can lie to
 * itself without noticing: `included` cannot exceed `screened`, and `screened`
 * cannot exceed `identified`. That arithmetic is checked here rather than trusted.
 *
 * The split between this module and `doc.js` is deliberate:
 *
 *   - `normalizeMethod` REFUSES a record that is incomplete or contradictory at
 *     the moment it is written (`rs_plan`), because a record written wrong is a
 *     record a reader will trust.
 *   - `methodProblems` reports what is wrong with a record ALREADY ON DISK - one
 *     hand-edited, or written by a different version - as an r0 problem, so a
 *     contradiction that arrived another way is still named rather than believed.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ResearchError } from './run.js'

/** Where the machine-readable record lives, beside the prose it replaces. */
export const METHOD_FILE = 'plan/method.json'
/** The generated human view of that record. Never a source of truth. */
export const METHOD_MD = 'plan/method.md'

/**
 * The fields a record must carry, in the order a reader meets them.
 *
 * Closed on purpose, exactly like `SOURCE_KINDS` and `LOCATOR_KINDS`: a field this
 * package does not know is a field nothing validates, and accepting one silently
 * would be the plugin pretending to understand a search it never read.
 */
export const METHOD_REQUIRED = ['databases', 'accessed', 'search', 'include', 'exclude', 'screening']
/** Optional, and validated when present. */
export const METHOD_OPTIONAL = ['registration', 'platforms', 'notes']
/** The three counts, in the order they must not increase. */
export const SCREENING_STEPS = ['identified', 'screened', 'included']

const MAX_LIST = 40
const MAX_ITEM_CHARS = 300
const MAX_SEARCH_CHARS = 4000
const MAX_NOTES_CHARS = 2000
const MAX_DATABASES = 30
const MAX_DATABASE_CHARS = 80

/** One message per refusal this module can raise, asserted by the package check. */
export const METHOD_CODES = ['BAD_METHOD', 'METHOD_COUNTS']

function bad(detail) {
  return new ResearchError('BAD_METHOD', detail)
}

/** A string list: trimmed, non-empty, capped, and never silently deduplicated. */
function stringList(value, field, { min = 0, max = MAX_LIST } = {}) {
  if (!Array.isArray(value)) throw bad('`' + field + '` is a list of strings (got ' + JSON.stringify(value) + ')')
  if (value.length < min) throw bad('`' + field + '` needs at least ' + min + ' entr' + (min === 1 ? 'y' : 'ies'))
  if (value.length > max) throw bad('`' + field + '` holds at most ' + max + ' entries (got ' + value.length + ')')
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw bad('every entry of `' + field + '` is a string (got ' + JSON.stringify(entry) + ')')
    const text = entry.trim()
    if (text === '') throw bad('`' + field + '` has an empty entry - drop it rather than leaving a blank')
    if (text.length > MAX_ITEM_CHARS) throw bad('an entry of `' + field + '` is at most ' + MAX_ITEM_CHARS + ' characters (got ' + text.length + ')')
    out.push(text)
  }
  return out
}

/**
 * A date of access, as `YYYY-MM-DD`.
 *
 * A REAL calendar date, not a shape that looks like one: `2026-02-31` matches the
 * pattern and cannot be true, and a search date nobody can trust is worse than an
 * absent one. The round trip through `Date` is what rejects it.
 */
export function normalizeDate(value, field = 'accessed') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) {
    throw bad('`' + field + '` is a calendar date as `YYYY-MM-DD` (got ' + JSON.stringify(String(value)) + ')')
  }
  const [year, month, day] = text.split('-').map((part) => Number(part))
  const date = new Date(Date.UTC(year, month - 1, day))
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  if (!real) throw bad('`' + field + '` is not a real date: ' + text)
  return text
}

/** Whether a string is a date this module would accept, without throwing. */
export function isDate(value) {
  try {
    normalizeDate(value)
    return true
  } catch {
    return false
  }
}

/** A whole number of records, which cannot be negative or fractional. */
function count(value, field) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw bad('`screening.' + field + '` is a whole number of records, 0 or more (got ' + JSON.stringify(value) + ')')
  }
  return number
}

/**
 * A method record, validated, or a refusal that says which rule it broke.
 *
 * `METHOD_COUNTS` is a SEPARATE code from `BAD_METHOD` because it is a different
 * kind of wrong: the shape is fine and the numbers contradict each other. A caller
 * that reads the code can tell "you typed the field wrong" from "your review
 * screened fewer records than it included".
 */
export function normalizeMethod(input) {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('a method record is an object: ' + METHOD_REQUIRED.join(', ') + ' (and optionally ' + METHOD_OPTIONAL.join(', ') + ')')
  }
  for (const key of Object.keys(input)) {
    if (!METHOD_REQUIRED.includes(key) && !METHOD_OPTIONAL.includes(key)) {
      throw bad('`' + key + '` is not a field of a method record. It holds ' + METHOD_REQUIRED.join(', ') + ' (and optionally ' + METHOD_OPTIONAL.join(', ') + ')')
    }
  }
  for (const field of METHOD_REQUIRED) {
    if (input[field] === undefined || input[field] === null) {
      throw bad('`' + field + '` is required: a search a reader cannot reproduce is not a method')
    }
  }

  const databases = stringList(input.databases, 'databases', { min: 1, max: MAX_DATABASES })
  for (const name of databases) {
    if (name.length > MAX_DATABASE_CHARS) throw bad('a database name is at most ' + MAX_DATABASE_CHARS + ' characters (got ' + name.length + ' in ' + JSON.stringify(name.slice(0, 40)) + ')')
  }
  const accessed = normalizeDate(input.accessed)
  const search = typeof input.search === 'string' ? input.search.trim() : ''
  if (search === '') throw bad('`search` is the query as it was actually run - it cannot be empty')
  if (search.length > MAX_SEARCH_CHARS) throw bad('`search` is at most ' + MAX_SEARCH_CHARS + ' characters (got ' + search.length + ')')
  const include = stringList(input.include, 'include', { min: 1 })
  // An empty `exclude` is legitimate - a search may have excluded nothing - but the
  // field has to be there, because "nothing was excluded" and "nobody said" are
  // different statements and only one of them is a method.
  const exclude = stringList(input.exclude, 'exclude', { min: 0 })

  const screening = input.screening
  if (screening === null || typeof screening !== 'object' || Array.isArray(screening)) {
    throw bad('`screening` is an object: ' + SCREENING_STEPS.join(', '))
  }
  for (const key of Object.keys(screening)) {
    if (!SCREENING_STEPS.includes(key)) throw bad('`screening.' + key + '` is not one of ' + SCREENING_STEPS.join(', '))
  }
  for (const field of SCREENING_STEPS) {
    if (screening[field] === undefined || screening[field] === null) throw bad('`screening.' + field + '` is required')
  }
  const counts = {
    identified: count(screening.identified, 'identified'),
    screened: count(screening.screened, 'screened'),
    included: count(screening.included, 'included'),
  }
  const broken = SCREENING_STEPS.filter((field, index) => index > 0 && counts[field] > counts[SCREENING_STEPS[index - 1]])
  if (broken.length > 0) {
    throw new ResearchError(
      'METHOD_COUNTS',
      'the screening counts cannot be true: ' +
        SCREENING_STEPS.map((field) => field + '=' + counts[field]).join(', ') +
        ' - records are removed at each step, never added, so ' +
        SCREENING_STEPS.join(' >= ') +
        '. Fix the record (or the review) rather than the arithmetic.',
    )
  }

  const record = { databases, accessed, search, include, exclude, screening: counts }
  if (input.registration !== undefined && input.registration !== null && String(input.registration).trim() !== '') {
    record.registration = String(input.registration).trim().slice(0, MAX_ITEM_CHARS)
  }
  if (input.platforms !== undefined && input.platforms !== null) {
    record.platforms = stringList(input.platforms, 'platforms', { min: 0, max: 10 })
  }
  if (input.notes !== undefined && input.notes !== null && String(input.notes).trim() !== '') {
    const notes = String(input.notes).trim()
    if (notes.length > MAX_NOTES_CHARS) throw bad('`notes` is at most ' + MAX_NOTES_CHARS + ' characters (got ' + notes.length + ')')
    record.notes = notes
  }
  return record
}

/**
 * What is wrong with a record ALREADY ON DISK, as r0 problems.
 *
 * Lenient where `normalizeMethod` is strict, and that is the whole point: this
 * reads a file a person may have edited by hand or that an older version wrote, so
 * it reports rather than throws. A `warning` is a field a reader needs and does not
 * have; the counting contradiction is an `error`, because a clean build must not
 * hand over a review whose own numbers do not add up.
 */
export function methodProblems(record) {
  const problems = []
  if (record === null || record === undefined) return problems
  if (typeof record !== 'object' || Array.isArray(record)) {
    return [{ code: 'method-incomplete', severity: 'error', detail: METHOD_FILE + ' is not an object: expected ' + METHOD_REQUIRED.join(', ') }]
  }
  const missing = []
  for (const field of METHOD_REQUIRED) {
    const value = record[field]
    // An explicitly EMPTY `exclude` is a legitimate statement - a search may exclude
    // nothing - so it counts as present. An empty `databases` or `include` does not:
    // those fields have to say something, which is the same rule `normalizeMethod`
    // applies on the way in.
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0 && field !== 'exclude')
    if (empty) missing.push(field)
  }
  if (missing.length > 0) {
    problems.push({
      code: 'method-incomplete',
      severity: 'warning',
      detail: METHOD_FILE + ' does not say ' + missing.join(', ') + ' - a search a reader cannot reproduce is not a method',
      fields: missing,
    })
  }
  const screening = record.screening
  if (screening !== null && typeof screening === 'object' && !Array.isArray(screening)) {
    const values = SCREENING_STEPS.map((field) => screening[field])
    const numeric = values.every((value) => Number.isInteger(value) && value >= 0)
    if (!numeric) {
      problems.push({ code: 'method-counts', severity: 'error', detail: METHOD_FILE + ' screening counts are not whole numbers: ' + JSON.stringify(screening) })
    } else {
      const broken = SCREENING_STEPS.filter((field, index) => index > 0 && values[index] > values[index - 1])
      if (broken.length > 0) {
        problems.push({
          code: 'method-counts',
          severity: 'error',
          detail: METHOD_FILE + ' counts cannot be true (' + SCREENING_STEPS.map((field) => field + '=' + screening[field]).join(', ') + '): records are removed at each step, never added',
        })
      }
    }
  } else if (screening !== undefined && screening !== null) {
    problems.push({ code: 'method-counts', severity: 'error', detail: METHOD_FILE + ' `screening` is an object: ' + SCREENING_STEPS.join(', ') })
  }
  if (record.accessed !== undefined && record.accessed !== null && !isDate(record.accessed)) {
    problems.push({ code: 'method-date', severity: 'warning', detail: METHOD_FILE + ' `accessed` is not a real `YYYY-MM-DD` date: ' + JSON.stringify(String(record.accessed)) })
  }
  return problems
}

/**
 * The record, read from disk.
 *
 * A missing file is `null` and is NOT a defect: a run may legitimately have no
 * search record (a theoretical paper), and a rung that failed a run for not having
 * one would be inventing a requirement. A file that does not PARSE is reported to
 * the caller, which turns it into an r0 problem rather than a thrown error - the
 * same rule `doc.js` follows for a document problem.
 */
export async function readMethodRecord(runDir) {
  const file = path.join(runDir, ...METHOD_FILE.split('/'))
  const text = await fsp.readFile(file, 'utf8').catch(() => null)
  if (text === null) return { record: null, file, exists: false, problem: null }
  try {
    return { record: JSON.parse(text), file, exists: true, problem: null }
  } catch (err) {
    return {
      record: null,
      file,
      exists: true,
      problem: { code: 'method-incomplete', severity: 'error', detail: METHOD_FILE + ' is not valid JSON: ' + String(err && err.message ? err.message : err) },
    }
  }
}

/** One line per count, which is what the flow diagram and the panel both show. */
export function screeningLine(record) {
  if (record === null || record === undefined || typeof record.screening !== 'object') return ''
  const counts = record.screening
  return SCREENING_STEPS.map((field) => counts[field] + ' ' + field).join(' -> ')
}

/**
 * The record as the Markdown a person reads, written to `plan/method.md`.
 *
 * It says it is GENERATED, because a hand-edit of this file is a change that the
 * next `rs_plan` overwrites - and a person who does not know that will lose work.
 */
export function renderMethodMd(record) {
  const lines = [
    '<!-- GENERATED from plan/method.json by rs_plan. Edit the RECORD, not this file: the next write replaces it. -->',
    '',
    '# Method',
    '',
    '- **Databases**: ' + record.databases.join(', '),
    '- **Accessed**: ' + record.accessed,
    '- **Registration**: ' + (record.registration === undefined ? '_(none recorded)_' : record.registration),
    '',
    '## Search string',
    '',
    '```text',
    record.search,
    '```',
    '',
    '## Inclusion criteria',
    '',
  ]
  for (const item of record.include) lines.push('- ' + item)
  lines.push('', '## Exclusion criteria', '')
  if (record.exclude.length === 0) lines.push('- _(nothing was excluded)_')
  else for (const item of record.exclude) lines.push('- ' + item)
  lines.push('', '## Screening', '')
  lines.push('| step | records |')
  lines.push('|---|---|')
  for (const field of SCREENING_STEPS) lines.push('| ' + field + ' | ' + record.screening[field] + ' |')
  if (record.notes !== undefined) lines.push('', '## Notes', '', record.notes)
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * The record as the document's own apparatus: the flow a reader checks the review
 * against.
 *
 * It is a Markdown table rather than a picture because every writer in this package
 * already renders one - `md`, `docx`, `html` and `tex` parse the same Markdown, so
 * a flow drawn here cannot be present in one artifact and missing from another.
 */
export function renderMethodFlow(record) {
  const lines = ['## Search and screening', '']
  lines.push('| stage | what it is |')
  lines.push('|---|---|')
  lines.push('| databases | ' + record.databases.join(', ') + ' |')
  lines.push('| date of access | ' + record.accessed + ' |')
  lines.push('| search string | `' + record.search.replace(/[`|]/g, ' ').replace(/\s+/g, ' ').trim() + '` |')
  lines.push('| included if | ' + record.include.join('; ') + ' |')
  lines.push('| excluded if | ' + (record.exclude.length === 0 ? '_(nothing was excluded)_' : record.exclude.join('; ')) + ' |')
  for (const field of SCREENING_STEPS) lines.push('| ' + field + ' | ' + record.screening[field] + ' record(s) |')
  if (record.registration !== undefined) lines.push('| registration | ' + record.registration + ' |')
  return lines
}

/** The record as one line, for a report or a tool's answer. */
export function methodSummary(record) {
  if (record === null || record === undefined) return 'no method record'
  return (
    record.databases.length +
    ' database(s), accessed ' +
    record.accessed +
    ', ' +
    SCREENING_STEPS.map((field) => record.screening[field] + ' ' + field).join(' -> ')
  )
}
