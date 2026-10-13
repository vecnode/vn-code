/**
 * dsh-research — the helpers the six citation styles share.
 *
 * A style is a PURE FUNCTION of one ledger record. Nothing in `lib/styles/`
 * reads a clock, a socket or a file, and nothing is cached between calls, so the
 * same record always renders the same characters and
 * `checks/check-research-styles.mjs` can pin an exact string. Anything that does
 * not live in the record is handed in by the caller through `ctx` - a citation
 * number, because a list numbered in citation order knows the number and the
 * record does not.
 *
 * The helpers below are the pieces the six styles must not disagree about: how a
 * name becomes initials, how a page range becomes an en dash, which element a
 * record is missing, and how an entry's italics become runs.
 */

/**
 * The source kinds a record can declare, which is also the list every style
 * renders.
 *
 * A kind outside this list falls to a style's generic branch rather than to a
 * guess: the ledger stores what the Markdown said, and a style that silently
 * treated an unknown kind as a journal article would print a container the
 * record may not have.
 */
export const KINDS = [
  'journal-article',
  'book',
  'chapter',
  'report',
  'web',
  'thesis',
  'preprint',
  'dataset',
  'standard',
  'conference-paper',
]

/** One run of a reference entry — the unit a DOCX writer needs. */
export function run(text) {
  return { text: String(text) }
}

/** An italic run: the emphasis a bibliography carries, as a property and not as markup. */
export function italic(text) {
  return { text: String(text), italic: true }
}

/**
 * Concatenate element runs, putting `separator` only BETWEEN the elements that
 * are present.
 *
 * A record is usually missing something, and building an entry by appending
 * pieces is how a missing volume becomes `, , 45–67`: this joins what exists and
 * leaves no separator pointing at nothing.
 *
 * @param elements - an array of runs arrays, each possibly empty.
 * @param separator - the text between two present elements (`', '`, `'. '`).
 */
export function joinRuns(elements, separator) {
  const runs = []
  for (const element of elements) {
    if (!Array.isArray(element) || element.length === 0) continue
    if (runs.length > 0) runs.push(run(separator))
    runs.push(...element)
  }
  return runs
}

/**
 * Drop the whitespace an element left at the end of an entry.
 *
 * `Publisher. ` is easier to build than `Publisher.`, and a reference list where
 * every entry ends in a space is a reference list whose strings nobody can
 * compare. A run left empty by the trim is dropped with it.
 */
export function trimEnd(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return Array.isArray(runs) ? runs : []
  const last = runs[runs.length - 1]
  if (!last || typeof last.text !== 'string') return runs
  const text = last.text.replace(/\s+$/, '')
  if (text === last.text) return runs
  const next = [...runs.slice(0, -1), { ...last, text }]
  return next.filter((part) => part.text !== '')
}

/**
 * A runs array as plain text.
 *
 * This is what a plain-text fallback, an unstyled paragraph and the check all
 * compare, so it is defined once here and re-exported by the registry. A missing
 * or malformed entry contributes NOTHING rather than the string `undefined`,
 * which is the failure this exists to prevent.
 */
export function plainOf(runs) {
  if (!Array.isArray(runs)) return ''
  let text = ''
  for (const part of runs) {
    if (part && typeof part.text === 'string') text += part.text
  }
  return text
}

/** Any value as trimmed text, with a non-string (or nothing) becoming ''. */
export function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** The kind a record declares, or `misc` for one this build does not know. */
export function kindOf(source) {
  const kind = textOf(source?.kind)
  return KINDS.includes(kind) ? kind : 'misc'
}

/** Whether a record is a page on the open web, which its URL cites as nothing else can. */
export function isWeb(source) {
  return kindOf(source) === 'web'
}

/** A record's year as stored, or '' when it has none — each style decides what that means. */
export function yearOf(source) {
  return source && source.year !== undefined && source.year !== null ? String(source.year).trim() : ''
}

/** A record's title, or ''. */
export function titleOf(source) {
  return textOf(source?.title)
}

/** The journal, the book a chapter sits in, or the site a page is on. */
export function containerOf(source) {
  return textOf(source?.container)
}

/** The body that published the work. */
export function publisherOf(source) {
  return textOf(source?.publisher)
}

/** Where it was published, which APA 7 no longer prints and Chicago still does. */
export function placeOf(source) {
  return textOf(source?.place)
}

/** A record's free text, which every style appends last. */
export function noteOf(source) {
  return textOf(source?.note)
}

/** A record's DOI, without the `https://doi.org/` prefix a style may add. */
export function doiOf(source) {
  return textOf(source?.doi)
}

/** A record's URL as stored — never rewritten, so a permalink stays the permalink. */
export function urlOf(source) {
  return textOf(source?.url)
}

/** The date a record was read, which only a web source needs. */
export function accessedOf(source) {
  return textOf(source?.accessed)
}

/** A record's volume, or ''. */
export function volumeOf(source) {
  return textOf(source?.volume)
}

/** A record's issue, or ''. */
export function issueOf(source) {
  return textOf(source?.issue)
}

/** The free text a citation carried (`p. 7`, `45`, `ch. 2`), or ''. */
export function locatorOf(item) {
  return textOf(item?.locator)
}

/**
 * A list of `{ family, given }` people, with unusable entries dropped.
 *
 * A ledger is written by hand as often as by a scraper, so an empty entry or a
 * stray string can appear among the objects. Dropping it HERE is what keeps an
 * empty author slot - `, . (2024).` or the literal `undefined` - out of all six
 * styles at once instead of in six places.
 *
 * A name stored in `given` alone is still a name: a corporate author or a
 * hand-typed record has no family/given split, and rendering its family as an
 * empty string would print the work as though nobody wrote it.
 */
export function peopleOf(list) {
  const people = []
  if (!Array.isArray(list)) return people
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const family = textOf(entry.family)
    const given = textOf(entry.given)
    if (family === '' && given === '') continue
    people.push(family === '' ? { family: given, given: '' } : { family, given })
  }
  return people
}

/** A record's authors, in the order it lists them. */
export function authorsOf(source) {
  return peopleOf(source?.authors)
}

/** An author's family name, or their whole name when the record carries no split. */
export function familyOf(person) {
  return textOf(person?.family)
}

/** An author's given name as stored (`J.`, `Alice B.`), or ''. */
export function givenOf(person) {
  return textOf(person?.given)
}

/** `Alice B. Jones` — given first, which is how a note and a chapter's editor are named. */
export function givenFirstOf(person) {
  const family = familyOf(person)
  const given = givenOf(person)
  return given === '' ? family : given + ' ' + family
}

/** `Jones, Alice B.` — the inverted form a bibliography uses for its FIRST author. */
export function invertedOf(person) {
  const family = familyOf(person)
  const given = givenOf(person)
  return given === '' ? family : family + ', ' + given
}

/**
 * Initials from a given name: `Alice B.` -> `A. B.`, `Jean-Luc` -> `J.-L.`.
 *
 * A hyphenated given name keeps its hyphen, because `J.-L.` is what a reader
 * recognises and collapsing it to `J. L.` would name a different person.
 */
export function initialsOf(given) {
  return textOf(given)
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) =>
      part
        .split('-')
        .filter((piece) => /[A-Za-z]/.test(piece))
        .map((piece) => piece[0].toUpperCase() + '.')
        .join('-'),
    )
    .filter((part) => part !== '')
    .join(' ')
}

/** The same initials with nothing between them: `Alice B.` -> `AB`, which is Vancouver's rule. */
export function compactInitialsOf(given) {
  return initialsOf(given).replace(/[^A-Za-z]/g, '')
}

/**
 * `45-67` -> `45–67`.
 *
 * Every style but Vancouver sets a page range with an EN DASH; a record may carry
 * a plain hyphen from a scraper or from a hand-typed ledger, so the conversion
 * happens here. Only a hyphen BETWEEN TWO DIGITS is a range: a hyphen inside a
 * word, a negative number or an already-correct en dash is left as the record
 * wrote it.
 */
export function enDashPages(value) {
  return textOf(value).replace(/(\d)\s*-\s*(?=\d)/g, '$1\u2013')
}

/**
 * An edition as a label: `2nd` -> `2nd ed.`, and a record that already says
 * `2nd ed.` is left alone.
 *
 * The ledger stores whatever the source page printed, and `2nd ed. ed.` is the
 * failure this avoids.
 */
export function editionLabel(source) {
  const raw = textOf(source?.edition)
  if (raw === '') return ''
  if (/\bed\.?$/i.test(raw) || /\bedition$/i.test(raw)) return /\.$/.test(raw) ? raw : raw + '.'
  return raw + ' ed.'
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * An ISO date as `January 2, 2026`, or '' when it is not an ISO date.
 *
 * Chicago spells an access date out, and this uses a month table rather than
 * `new Date(...)`: parsing through the platform would read the machine's time
 * zone, and a citation that changes with the reader's clock is a citation two
 * builds cannot compare.
 */
export function longDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(textOf(value))
  if (match === null) return ''
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''
  return MONTHS[month - 1] + ' ' + String(day) + ', ' + match[1]
}

/**
 * The address a style cites, decided once for all six styles.
 *
 * A `web` source is cited BY its URL - that is what citing a page means, and the
 * address may be the only stable thing about it. Otherwise the DOI wins and a
 * URL is the fallback for a record that has no DOI.
 *
 * @returns `{ form: 'doi' | 'url', value }`, or null when a record carries neither.
 */
export function linkOf(source) {
  const doi = doiOf(source)
  const url = urlOf(source)
  if (isWeb(source)) {
    if (url !== '') return { form: 'url', value: url }
    return doi === '' ? null : { form: 'doi', value: doi }
  }
  if (doi !== '') return { form: 'doi', value: doi }
  return url === '' ? null : { form: 'url', value: url }
}

/**
 * `A, B, & C` or `A and B` — the two list shapes the six styles need.
 *
 * `commaBeforeLast` is what separates them, and it is not decoration: APA puts a
 * comma before `&` even when two names are listed, IEEE does not comma a list of
 * two, and MLA and Chicago do, because their first name is inverted and the
 * comma is what separates the name from the conjunction.
 */
export function joinWith(parts, conjunction, commaBeforeLast = false) {
  const list = parts.filter((part) => typeof part === 'string' && part !== '')
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return list[0] + (commaBeforeLast ? ',' : '') + ' ' + conjunction + ' ' + list[1]
  return list.slice(0, -1).join(', ') + (commaBeforeLast ? ',' : '') + ' ' + conjunction + ' ' + list[list.length - 1]
}

/**
 * The first few words of a title, which is what a style prints where an author
 * would stand when the record names none. Five words is the ceiling APA, MLA and
 * Chicago each set for that shortened form.
 */
export function shortTitle(title, words = 5) {
  const parts = textOf(title).split(/\s+/).filter((part) => part !== '')
  return parts.length <= words ? parts.join(' ') : parts.slice(0, words).join(' ')
}

/**
 * Text closed with exactly one full stop.
 *
 * A given name is stored as an initial (`J.`) as often as in full (`Alice B.`), so
 * an element that appends its own stop to `Smith, J.` prints `Smith, J..` - the
 * one mistake every reader of a bibliography notices. Text that already ends in a
 * stop is left alone.
 */
export function closed(text) {
  const value = String(text)
  return /[.!?]$/.test(value) ? value : value + '.'
}

/** A citation number as a positive integer, or 0 for anything else. */function positiveNumber(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

/**
 * The citation number for one item of a group.
 *
 * A number is never a property of a record, so the caller supplies it: a numeric
 * style is handed `ctx.number` for a single citation, or `ctx.numbers` when one
 * group cites several sources at once. A caller that supplied neither gets 0 and
 * the style prints no number - which is visible and fixable, while a style that
 * invented `1` would silently renumber somebody's bibliography.
 */
export function numberFor(ctx, index = 0) {
  const list = Array.isArray(ctx?.numbers) ? ctx.numbers : null
  if (list !== null) return positiveNumber(list[index])
  const base = positiveNumber(ctx?.number)
  return base === 0 ? 0 : base + index
}

/**
 * The record's own free text, appended last.
 *
 * `note` is where a person writes what the record does not have a field for, and
 * a style that dropped it would lose the sentence they typed. It goes at the END
 * because everything before it is the citation proper.
 */
export function withNote(runs, source) {
  const note = noteOf(source)
  return note === '' ? runs : [...runs, run(' ' + note)]
}
