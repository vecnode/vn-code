/**
 * dsh-research — the document dialect.
 *
 * ONE module owns the syntax, because two things must never disagree about it:
 * the writer that validates a claim against its ledger row, and the builder that
 * replaces a citation with the style's in-text form. A regex copied into both
 * places is a regex that drifts.
 *
 * The dialect is standard Pandoc Markdown plus exactly ONE addition:
 *
 *   - a **claim** is a bracketed span with an id: `[the claim, as written]{#c0142}`.
 *     The id is the ledger key. Claim text may NOT contain brackets - that is the
 *     one restriction the grammar imposes, and `findClaimSpans` is what enforces it
 *     by simply not matching a nested span.
 *   - a **citation** is Pandoc's own: `[@key]`, `[@key, p. 7]`, `[-@key]` (author
 *     suppressed) and several in one bracket: `[@a, p. 1; @b]`. A locator is
 *     whatever text follows the key's comma, because every style writes its
 *     locators differently and the style module is what understands them.
 *
 * Why Pandoc's syntax rather than an invention: a document written this way opens
 * unchanged in Zotero, in pandoc, and in any Markdown editor, and the user's own
 * toolchain can build it even if this plugin never runs. Nothing here is a
 * private format.
 */

import { ResearchError } from './run.js'

/** A citation key: lowercase, digits and dashes. Legal in a BibTeX key too. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A claim id: `c` and at least four digits, so ids sort and never collide. */
export const CLAIM_ID_PATTERN = /^c[0-9]{4,}$/
/** What a locator may point at. Closed on purpose: a rung reads these. */
export const LOCATOR_KINDS = ['page', 'quote', 'section', 'table', 'figure', 'paragraph', 'timestamp']

/**
 * The kinds of source this plugin can cite.
 *
 * Closed, and shared with the import engine (`lib/refs.js` maps RIS/BibTeX/
 * MEDLINE/EndNote type tags onto exactly these), because a record whose kind no
 * style can format is a record that fails at the last step. The package's check
 * asserts that every kind the importer can produce is in this list.
 */
export const SOURCE_KINDS = [
  'journal-article',
  'book',
  'chapter',
  'conference-paper',
  'report',
  'thesis',
  'preprint',
  'web',
  'dataset',
  'standard',
]

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** Whether a value is a legal citation key. */
export function isKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

/** A legal citation key, or a refusal that says what the rule is. */
export function parseKey(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!isKey(key)) {
    throw new ResearchError(
      'BAD_KEY',
      'a citation key is 1-64 characters of lowercase letters, digits and dashes, starting with a letter or digit' +
        (key === '' ? ' (none was given)' : ' (got ' + JSON.stringify(key.slice(0, 64)) + ')'),
    )
  }
  return key
}

/** Whether a value is a legal claim id. */
export function isClaimId(value) {
  return typeof value === 'string' && CLAIM_ID_PATTERN.test(value)
}

/** A legal claim id, or a refusal. */
export function parseClaimId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!isClaimId(id)) {
    throw new ResearchError('BAD_CLAIM_ID', 'a claim id looks like `c0142` (got ' + JSON.stringify(id.slice(0, 32)) + ')')
  }
  return id
}

/**
 * The next free claim id.
 *
 * Ids are never reused, and they are allocated from the HIGHEST id in the ledger
 * even when earlier ones were rewritten away: a document that drops claim 7 and
 * adds another must not give the new one a name a reader already associates with
 * the old text.
 */
export function nextClaimId(rows) {
  let highest = 0
  for (const row of rows ?? []) {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (!isClaimId(id)) continue
    const value = Number(id.slice(1))
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return 'c' + String(highest + 1).padStart(4, '0')
}

/**
 * Every claim span in a document, in reading order.
 *
 * A span whose text contains a bracket is not a span: the grammar cannot express
 * it, and silently matching a truncated one would put the wrong text in the
 * ledger. `build` reports such a line as a problem instead (see `doc.js`).
 */
export function findClaimSpans(text) {
  const found = []
  const source = String(text ?? '')
  const pattern = /\[([^[\]]+)\]\{#(c[0-9]{4,})\}/g
  for (const match of source.matchAll(pattern)) {
    found.push({ start: match.index, end: match.index + match[0].length, id: match[2], text: match[1] })
  }
  return found
}

/**
 * A bracket that LOOKS like a claim span but is not well formed.
 *
 * This is the quiet failure the span grammar can otherwise produce: a typo like
 * `{#c12}` (too few digits) or an unclosed bracket is a claim the author believes
 * is tracked and the ledger has never heard of. It is reported by name and by
 * line, never ignored.
 */
export function findBrokenClaimMarkers(text) {
  const found = []
  const source = String(text ?? '')
  for (const match of source.matchAll(/\{[^}]*#[^}]*\}/g)) {
    if (/#c[0-9]{4,}\}/.test(match[0])) continue
    found.push({ index: match.index, marker: match[0] })
  }
  return found
}

/**
 * Every citation in a document, in reading order.
 *
 * Scanned by hand rather than by one regex, because a citation can hold SEVERAL
 * keys with their own locators and the split has to respect the bracket it lives
 * in: `[@a, p. 1; @b]` is two citations in one bracket, and `[see @a]` is prose,
 * not a citation. A bracket that contains no `@key` at all is left alone, which is
 * what keeps an ordinary Markdown link or a `[note]` out of the reference list.
 */
export function findCitations(text) {
  const found = []
  const source = String(text ?? '')
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('[', index)
    if (open === -1) break
    // A footnote reference (`[^1]`) and a bracketed span (`[]{#c1}`) are not
    // citations, and neither is a Markdown link's text.
    const close = source.indexOf(']', open + 1)
    if (close === -1) break
    const inner = source.slice(open + 1, close)
    const cites = parseCiteList(inner)
    if (cites === null || cites.length === 0) {
      index = open + 1
      continue
    }
    found.push({ start: open, end: close + 1, raw: source.slice(open, close + 1), cites })
    index = close + 1
  }
  return found
}

/**
 * One bracket's contents as citations, or null when it is not a citation at all.
 *
 * `-@key` suppresses the author (`(2024)` instead of `(Smith, 2024)`), which every
 * author-date style needs for a sentence that already names the author.
 */
export function parseCiteList(inner) {
  const parts = String(inner ?? '').split(';')
  const cites = []
  for (const part of parts) {
    const piece = part.trim()
    const match = /^(-?)@([A-Za-z0-9][A-Za-z0-9-]*)\s*(?:,\s*([\s\S]*))?$/.exec(piece)
    if (match === null) return null
    cites.push({
      suppressAuthor: match[1] === '-',
      key: match[2].toLowerCase(),
      locator: match[3] === undefined ? '' : match[3].trim(),
    })
  }
  return cites
}

/**
 * A bracket that LOOKS like a citation but does not parse as one.
 *
 * The quiet failure this closes: `[see @smith2024]` (a prefix, which Pandoc
 * accepts and this dialect does not), `[as @x notes]`, or a misplaced comma all
 * leave a bracket that mentions a key. If it is not a citation, the reference
 * never enters the list - and the document would show a citation-shaped string
 * with nothing behind it, which is the exact failure this plugin exists to
 * prevent. So it is reported by name, as an error, and `rs_write` refuses it.
 */
export function findBrokenCitations(text) {
  const source = String(text ?? '')
  const claimed = new Set(findCitations(source).map((citation) => citation.start))
  const found = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('[', index)
    if (open === -1) break
    const close = source.indexOf(']', open + 1)
    if (close === -1) break
    if (claimed.has(open)) {
      index = close + 1
      continue
    }
    const inner = source.slice(open + 1, close)
    if (inner.includes('@') && !inner.startsWith('^') && !inner.startsWith('#')) {
      found.push({ index: open, raw: source.slice(open, close + 1), why: 'a citation must be the whole bracket: `[@key]`, `[@key, p. 7]` or `[@a; @b]`' })
    }
    index = close + 1
  }
  return found
}

/**
 * A locator, validated.
 *
 * `page` and `quote` are the two a rung can actually check: a quote is what
 * `r2-locate` searches for in the source's own text, and a page is where it
 * expects to find it. The others are recorded so a human can follow them, and a
 * claim whose only locator is one of those cannot reach `r2` - which is the
 * honest answer, not a failure.
 */
export function normalizeLocator(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchError('BAD_LOCATOR', 'a locator is an object like { kind: "page", page: 7 } or { kind: "quote", quote: "…" }')
  }
  const kind = typeof value.kind === 'string' ? value.kind : ''
  if (!LOCATOR_KINDS.includes(kind)) {
    throw new ResearchError(
      'BAD_LOCATOR',
      'locator kind must be one of ' + LOCATOR_KINDS.join(', ') + ' (got ' + JSON.stringify(kind) + ')',
    )
  }
  const locator = { kind }
  if (value.page !== undefined && value.page !== null && value.page !== '') {
    const page = Number(value.page)
    if (!Number.isFinite(page) || page < 1) throw new ResearchError('BAD_LOCATOR', 'a locator page is a positive number (got ' + JSON.stringify(value.page) + ')')
    locator.page = Math.floor(page)
  }
  for (const field of ['quote', 'section', 'table', 'figure', 'paragraph', 'timestamp', 'label']) {
    if (value[field] === undefined || value[field] === null) continue
    const text = String(value[field]).trim()
    if (text === '') continue
    if (text.length > 2000) throw new ResearchError('BAD_LOCATOR', 'a locator field is at most 2000 characters (got ' + text.length + ' in `' + field + '`)')
    locator[field] = text
  }
  // A locator with a kind and nothing else is not a locator, it is a promise.
  const payload = Object.keys(locator).filter((field) => field !== 'kind' && field !== 'label')
  if (payload.length === 0) {
    throw new ResearchError('BAD_LOCATOR', 'a `' + kind + '` locator needs at least one of: page, quote, section, table, figure, paragraph, timestamp')
  }
  if (kind === 'page' && locator.page === undefined) {
    throw new ResearchError('BAD_LOCATOR', 'a `page` locator needs the page number')
  }
  if (kind === 'quote' && locator.quote === undefined) {
    throw new ResearchError('BAD_LOCATOR', 'a `quote` locator needs the quoted words, exactly as they appear in the source')
  }
  return locator
}

/** A locator as a person reads it. Used in reports and in the panel. */
export function locatorLabel(locator) {
  if (locator === null || locator === undefined) return ''
  const bits = []
  if (locator.section !== undefined) bits.push('§' + locator.section)
  if (locator.page !== undefined) bits.push('p. ' + locator.page)
  if (locator.table !== undefined) bits.push('table ' + locator.table)
  if (locator.figure !== undefined) bits.push('figure ' + locator.figure)
  if (locator.paragraph !== undefined) bits.push('¶' + locator.paragraph)
  if (locator.timestamp !== undefined) bits.push('@' + locator.timestamp)
  if (locator.quote !== undefined) bits.push('“' + (locator.quote.length > 60 ? locator.quote.slice(0, 59) + '…' : locator.quote) + '”')
  return bits.join(' ')
}

/**
 * The confidence a claim is written with, which is what `r3` compares a source
 * against. A source that shows a correlation cannot support a claim that says
 * "causes", and the ladder reports that as `overstated` rather than as a failure.
 */
export const STRENGTHS = ['causal', 'associational', 'descriptive', 'theoretical', 'normative']

/** Whether a value is a legal claim strength. */
export function isStrength(value) {
  return typeof value === 'string' && STRENGTHS.includes(value)
}

/** One message per refusal this module can raise, for the checks that assert them. */
export const SYNTAX_CODES = ['BAD_KEY', 'BAD_CLAIM_ID', 'BAD_LOCATOR']

export { messageOf }
