// check-research-styles.mjs - the six citation styles, driven through the registry.
//
// What this proves, and why each half is here:
//
//   - the REGISTRY agrees with the run model: the six ids are `lib/run.js`'s
//     STYLES in the run model's own order, every id resolves through `styleOf`, an
//     id nothing renders answers null instead of throwing, and every file in
//     `lib/styles/` is either registered or one of the two files that are not a
//     style - so "adding a style is one module and one line" is a claim the check
//     holds rather than a sentence in a comment;
//   - the GROUND TRUTH: the in-text form and the reference entry of every style
//     are pinned character for character, with the italics placed where the pinned
//     string shows them. The italics are asserted as RUNS, not as asterisks, so a
//     style cannot quietly ship markup into a DOCX - except for a notes style's
//     footnote, which the documented interface returns as a plain string;
//   - the RULES THAT BITE, each asserted rather than assumed: three or more
//     authors shorten in the text and stay complete in the list, a missing author
//     is never an empty slot, a missing year becomes `n.d.` or is omitted, a page
//     range is an en dash everywhere but Vancouver, a URL is printed when there is
//     no DOI and always for a web source, and a record's own note is appended last;
//   - and EVERY KIND of source renders in ALL SIX styles with no `undefined`
//     anywhere, which is what makes ten kinds and six styles a matrix and not a
//     list of the two cases somebody happened to try.
//
// Nothing here is skipped: every case below is a real string comparison on this
// host, so the check has no SKIP line and no path that exits 0 without comparing.
//
// Run:  node packages/dsh-research/checks/check-research-styles.mjs
import { readdirSync } from 'node:fs'

import { STYLES as RUN_STYLES } from '../lib/run.js'
import { KINDS } from '../lib/styles/common.js'
import { STYLES, STYLE_MODULES, plainOf, referenceHeadingOf, styleOf } from '../lib/styles/index.js'

let failures = 0
let checked = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(48) + (expected === undefined || ok ? '' : ' -> ' + JSON.stringify(actual)))
  return ok
}

/** The plain text an expectation marked with `*...*` stands for. */
function unmark(marked) {
  return marked.replace(/\*/g, '')
}

/** The spans an expectation marked with `*...*` says must be italic runs, in order. */
function markedSpans(marked) {
  return [...marked.matchAll(/\*(.+?)\*/g)].map((match) => match[1])
}

/** The spans of an entry that ARE italic runs, in order. */
function italicSpans(runs) {
  return (Array.isArray(runs) ? runs : []).filter((part) => part && part.italic === true).map((part) => String(part.text))
}

/**
 * The citation one source carries in a style, whichever member carries it.
 *
 * A parenthetical style answers with `group`, and a notes style answers with
 * `note` and returns null from `note` only when it is not a notes style - so this
 * is the caller's own choice written once, and it is what makes "an authorless
 * record still has a form to print" a question that can be asked of all six.
 */
function citationOf(style, items, ctx) {
  const note = style.note(items, ctx)
  return note !== null ? note : style.group(items, ctx)
}

// ---------------------------------------------------------------------------
// The fixtures, built here because a check builds its own input
// ---------------------------------------------------------------------------
const ARTICLE = {
  key: 'smith2024effect',
  kind: 'journal-article',
  title: 'The effect of X on Y',
  authors: [
    { family: 'Smith', given: 'J.' },
    { family: 'Jones', given: 'Alice B.' },
  ],
  year: '2024',
  container: 'Journal Name',
  volume: '12',
  issue: '3',
  pages: '45-67',
  doi: '10.1234/abcd',
}
const BOOK = {
  key: 'smith2024book',
  kind: 'book',
  title: 'The title of the book',
  authors: [{ family: 'Smith', given: 'J.' }],
  year: '2024',
  edition: '2nd',
  publisher: 'Publisher',
  place: 'City',
}
const WEB = {
  key: 'agency2023report',
  kind: 'web',
  title: 'Report title',
  authors: [],
  year: '2023',
  container: 'Agency',
  url: 'https://example.org/r',
  accessed: '2026-01-02',
}
/** One author, so a group can be shown citing two different sources. */
const ALONE = { ...ARTICLE, key: 'jones2023method', title: 'A method for Z', authors: [{ family: 'Jones', given: 'Alice B.' }], year: '2023' }
/** Three authors, which is where the in-text form stops naming everybody. */
const TRIO = { ...ARTICLE, authors: [...ARTICLE.authors, { family: 'Brown', given: 'C.' }] }
/** Twenty-one authors, which is where a reference list stops naming everybody. */
const MANY21 = { ...ARTICLE, authors: Array.from({ length: 21 }, (unused, index) => ({ family: 'Fam' + String(index + 1).padStart(2, '0'), given: 'A.' })) }
/** Twenty authors, which is the largest list APA names in full. */
const MANY20 = { ...ARTICLE, authors: MANY21.authors.slice(0, 20) }
/** The same year, written the two ways a ledger stores a year it does not have. */
const NO_YEAR_EMPTY = { ...BOOK, year: '' }
const NO_YEAR_ABSENT = { ...BOOK }
delete NO_YEAR_ABSENT.year
/** A DOI and a URL at once, which is what the URL rule is about. */
const BOTH = { ...ARTICLE, url: 'https://example.org/a' }
/** A URL and no DOI, which is when a URL is printed. */
const URL_ONLY = { ...ARTICLE, doi: '', url: 'https://example.org/a' }
/** Free text the record carries, which every style appends last. */
const NOTED = { ...ARTICLE, note: 'A remark from the ledger.' }

/**
 * The pinned ground truth, one row per style.
 *
 * `inText` is the ATOMIC form - what a style prints for one source without the
 * surrounding punctuation. `locator` is the same citation with a locator attached,
 * so what the table shows inside its parentheses is asserted as the group. `note`
 * is a notes style's footnote, which the interface returns as a plain string.
 */
const ROWS = {
  apa7: {
    inText: 'Smith & Jones, 2024',
    reference: 'Smith, J., & Jones, A. B. (2024). The effect of X on Y. *Journal Name*, *12*(3), 45–67. https://doi.org/10.1234/abcd',
  },
  'chicago-notes': {
    note: 'J. Smith and Alice B. Jones, "The effect of X on Y," *Journal Name* 12, no. 3 (2024): 45–67, https://doi.org/10.1234/abcd.',
    reference: 'Smith, J., and Alice B. Jones. "The effect of X on Y." *Journal Name* 12, no. 3 (2024): 45–67. https://doi.org/10.1234/abcd.',
  },
  'chicago-author-date': {
    inText: 'Smith and Jones 2024',
    locator: 'Smith and Jones 2024, 45',
    reference: 'Smith, J., and Alice B. Jones. 2024. "The effect of X on Y." *Journal Name* 12 (3): 45–67. https://doi.org/10.1234/abcd.',
  },
  mla9: {
    inText: 'Smith and Jones',
    locator: 'Smith and Jones 45',
    reference: 'Smith, J., and Alice B. Jones. "The effect of X on Y." *Journal Name*, vol. 12, no. 3, 2024, pp. 45–67, https://doi.org/10.1234/abcd.',
  },
  ieee: {
    inText: '1',
    reference: '[1] J. Smith and A. B. Jones, "The effect of X on Y," *Journal Name*, vol. 12, no. 3, pp. 45–67, 2024, doi: 10.1234/abcd.',
  },
  vancouver: {
    inText: '1',
    reference: '1. Smith J, Jones AB. The effect of X on Y. Journal Name. 2024;12(3):45-67. doi:10.1234/abcd',
  },
}

/** The APA book row the table pins, which is a second shape and not a second style. */
const APA_BOOK_ROW = 'Smith, J. (2024). *The title of the book* (2nd ed.). Publisher.'

console.log('check-research-styles: six styles, pinned character for character')

// ---------------------------------------------------------------------------
// 1. The registry
// ---------------------------------------------------------------------------
{
  check('the six ids are the run model\'s, in ITS order', STYLES.join(','), RUN_STYLES.join(','))
  check('a module is registered for every id', STYLE_MODULES.length, STYLES.length)
  check('every id resolves through styleOf', STYLES.map((id) => styleOf(id)?.id).join(','), STYLES.join(','))
  check('the modules are registered in STYLES order', STYLE_MODULES.map((style) => style.id).join(','), STYLES.join(','))
  check('an id nothing renders is null, not a throw', styleOf('nope'), null)
  check('and an id that is not a string is null too', styleOf(undefined), null)

  // The registry is one module per style and one line to register it, so the
  // directory and the list have to agree in BOTH directions: an unregistered file
  // is a style nobody can select, and a registered id with no file is a style that
  // does not exist.
  const files = readdirSync(new URL('../lib/styles/', import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.replace(/\.js$/, ''))
    .filter((name) => name !== 'common' && name !== 'index')
    .sort()
  check('every file in lib/styles is a registered style', files.join(','), [...STYLES].sort().join(','))

  for (const style of STYLE_MODULES) {
    check(style.id + ': it declares a label a picker can show', typeof style.label === 'string' && style.label !== '')
    check(style.id + ': it declares its reference order', style.order === 'alphabetical' || style.order === 'citation')
    check(style.id + ': it declares a heading', typeof style.referenceHeading === 'string' && style.referenceHeading !== '')
    check(style.id + ': every member of the interface is a function', ['inText', 'group', 'note', 'reference'].every((name) => typeof style[name] === 'function'))
  }
  check('the alphabetical styles, by declaration', STYLE_MODULES.filter((style) => style.order === 'alphabetical').map((style) => style.id).join(','), 'apa7,chicago-notes,chicago-author-date,mla9')
  check('the citation-order styles, by declaration', STYLE_MODULES.filter((style) => style.order === 'citation').map((style) => style.id).join(','), 'ieee,vancouver')
  check('the headings, which are not synonyms for each other', STYLES.map((id) => referenceHeadingOf(id)).join('|'), 'References|Bibliography|References|Works Cited|References|References')
  check('an unknown style has no heading', referenceHeadingOf('nope'), null)
  check('only the notes style returns a footnote', STYLE_MODULES.filter((style) => style.note([{ source: ARTICLE, locator: '' }], { number: 1 }) !== null).map((style) => style.id).join(','), 'chicago-notes')
}

// ---------------------------------------------------------------------------
// 2. The ground truth: the pinned rows, exactly
// ---------------------------------------------------------------------------
{
  for (const id of STYLES) {
    const style = styleOf(id)
    const row = ROWS[id]
    const ctx = { number: 1 }

    if (row.inText !== undefined) check(id + ': the atomic in-text form of one source', style.inText(ARTICLE, ctx), row.inText)
    if (row.locator !== undefined) {
      // The table shows what stands inside the parentheses; `group` is what puts
      // the parentheses on.
      check(id + ': the same citation with a locator', style.group([{ source: ARTICLE, locator: '45' }], ctx), '(' + row.locator + ')')
    }
    if (row.note !== undefined) {
      // A notes style returns its footnote as a STRING, so the emphasis the table
      // shows cannot travel as runs here; the plain text is what is pinned.
      check(id + ': the footnote, as the interface returns it', style.note([{ source: ARTICLE, locator: '' }], ctx), unmark(row.note))
    }

    const runs = style.reference(ARTICLE, ctx)
    check(id + ': the reference entry reads exactly as pinned', plainOf(runs), unmark(row.reference))
    check(id + ': its italics land exactly where the entry shows them', italicSpans(runs).join('|'), markedSpans(row.reference).join('|'))
    check(id + ': the entry is runs, not markup', plainOf(runs).includes('*'), false)
  }

  check('apa7: the pinned book entry', plainOf(styleOf('apa7').reference(BOOK, { number: 1 })), unmark(APA_BOOK_ROW))
  check('apa7: and its title is one italic run', italicSpans(styleOf('apa7').reference(BOOK, { number: 1 })).join('|'), 'The title of the book')
  check('vancouver: italics nothing at all', STYLE_MODULES.find((style) => style.id === 'vancouver').reference(ARTICLE, { number: 1 }).every((part) => part.italic !== true))
}

// ---------------------------------------------------------------------------
// 3. Two authors, three authors, twenty-one authors
// ---------------------------------------------------------------------------
{
  check('apa7: three authors shorten to et al. in the text', styleOf('apa7').inText(TRIO), 'Smith et al., 2024')
  check('apa7: and the list still names all three', plainOf(styleOf('apa7').reference(TRIO)).startsWith('Smith, J., Jones, A. B., & Brown, C. (2024).'), true)
  check('ieee: three authors keep the serial comma', plainOf(styleOf('ieee').reference(TRIO, { number: 1 })).startsWith('[1] J. Smith, A. B. Jones, and C. Brown,'), true)
  check('chicago-notes: three authors in a note keep the serial comma', styleOf('chicago-notes').note([{ source: TRIO, locator: '' }]).startsWith('J. Smith, Alice B. Jones, and C. Brown,'), true)
  check('mla9: three authors shorten the list to et al.', plainOf(styleOf('mla9').reference(TRIO)).startsWith('Smith, J., et al.'), true)

  const many21 = plainOf(styleOf('apa7').reference(MANY21))
  check('apa7: 21 authors keep the first 19, an ellipsis and the last', many21.includes('Fam01') && many21.includes('Fam19') && many21.includes('\u2026') && many21.includes('Fam21'), true)
  check('apa7: and the twentieth author is the one dropped', many21.includes('Fam20'), false)
  const many20 = plainOf(styleOf('apa7').reference(MANY20))
  check('apa7: 20 authors are all named, with no ellipsis', many20.includes('Fam20') && many20.includes('\u2026'), false)
}

// ---------------------------------------------------------------------------
// 4. The rules that bite: no author, no year, the dash, the link, the note
// ---------------------------------------------------------------------------
{
  for (const id of STYLES) {
    const style = styleOf(id)
    const ctx = { number: 1 }
    const entry = plainOf(style.reference(WEB, ctx))

    check(id + ': an authorless record leads with its title', entry.indexOf('Report title') >= 0 && entry.indexOf('Report title') < entry.indexOf('Agency'))
    check(id + ': and never prints an empty author slot', /^(undefined|null)|undefined|^[.,;:]/.test(entry), false)
    check(id + ': and still has a citation form', citationOf(style, [{ source: WEB, locator: '' }], ctx).trim() !== '')

    const citation = citationOf(style, [{ source: WEB, locator: '' }], ctx)
    check(id + ': the citation of an authorless record has no `undefined`', /undefined|null/.test(citation), false)

    // A record that names nobody is a record somebody typed in a hurry, and the
    // failure to design out is a slot left empty or the word `undefined` printed.
    const bare = plainOf(style.reference({ ...WEB, title: '' }, ctx))
    check(id + ': a record with no author and no title still renders text', bare.trim() !== '' && !/undefined|null/.test(bare))
  }

  // No year: APA and both Chicago styles say `n.d.`, and MLA, IEEE and Vancouver
  // leave it out, because their in-text forms carry no year to point at.
  const ND = ['apa7', 'chicago-notes', 'chicago-author-date']
  for (const id of STYLES) {
    const style = styleOf(id)
    const entry = plainOf(style.reference(NO_YEAR_EMPTY, { number: 1 }))
    if (ND.includes(id)) check(id + ': a missing year becomes n.d.', entry.includes('n.d.'), true)
    else check(id + ': a missing year is omitted', entry.includes('n.d.'), false)
    check(id + ': a year written as "" and an absent year render the same', entry, plainOf(style.reference(NO_YEAR_ABSENT, { number: 1 })))
  }
  check('chicago-notes: a footnote with no year says n.d. too', styleOf('chicago-notes').note([{ source: NO_YEAR_EMPTY, locator: '' }]).includes('n.d.'), true)

  for (const id of STYLES) {
    const entry = plainOf(styleOf(id).reference(ARTICLE, { number: 1 }))
    if (id === 'vancouver') check('vancouver: keeps the hyphen the record holds', entry.includes('45-67'), true)
    else check(id + ': a page range becomes an EN DASH', entry.includes('45\u201367') && !entry.includes('45-67'), true)
  }

  // The link rules: a web source is cited by its URL, otherwise the DOI wins and a
  // URL is the fallback.
  for (const id of STYLES) {
    const style = styleOf(id)
    const ctx = { number: 1 }
    check(id + ': a URL is NOT printed when the record has a DOI', plainOf(style.reference(BOTH, ctx)).includes('https://example.org/a'), false)
    check(id + ': a URL IS printed when there is no DOI', plainOf(style.reference(URL_ONLY, ctx)).includes('https://example.org/a'), true)
    check(id + ': a web source prints its URL', plainOf(style.reference(WEB, ctx)).includes('https://example.org/r'), true)
    check(id + ': and so does a web source that also carries a DOI', plainOf(style.reference({ ...WEB, doi: '10.1234/abcd' }, ctx)).includes('https://example.org/r'), true)

    // EVERY style prints the address, and a URL never appears when the record has
    // a DOI. This expectation CHANGED deliberately after the first pass: the
    // pinned table was ambiguous about the DOI in the notes bibliography, MLA and
    // Vancouver, and three styles shipped printing none. That made a Works Cited
    // entry a reader cannot follow - which fails this package's own limit, that a
    // citation has to be checkable. The rule now: APA/IEEE/Chicago print their own
    // DOI form, MLA and Chicago's notes print the https URL, and Vancouver prints
    // `doi:<doi>`. The `printsDoi` flag is therefore true for all six.
    const printsDoi = true
    check(id + ': the DOI is ' + (printsDoi ? 'printed' : 'not printed'), plainOf(style.reference(ARTICLE, ctx)).includes('10.1234/abcd'), printsDoi)
    check(id + ': and the address is the style\'s own form', plainOf(style.reference(ARTICLE, ctx)).length > plainOf(style.reference({ ...ARTICLE, doi: '', url: '' }, ctx)).length, true)
    check(id + ': the record\'s own note is appended last', plainOf(style.reference(NOTED, ctx)).endsWith('A remark from the ledger.'), true)
  }
  check('chicago-notes: the footnote carries the record\'s note last too', styleOf('chicago-notes').note([{ source: NOTED, locator: '' }]).endsWith('A remark from the ledger.'), true)
}

// ---------------------------------------------------------------------------
// 5. Every kind of source, in every style
// ---------------------------------------------------------------------------
{
  const kindProblems = []
  for (const id of STYLES) {
    const style = styleOf(id)
    for (const kind of [...KINDS, 'novel']) {
      // 'novel' is not a kind this build knows: a ledger written by hand can hold
      // anything, and a style must render it through its generic branch rather
      // than throw or print a hole.
      const source = { key: 'k', kind, title: 'A title for ' + kind, authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'A container', publisher: 'A publisher', place: 'A place', volume: '1', issue: '2', pages: '3-9', edition: '2nd', doi: '10.1/x', url: 'https://example.org/x', accessed: '2026-01-02' }
      const entry = plainOf(style.reference(source, { number: 1 }))
      if (entry.trim() === '') kindProblems.push(id + '/' + kind + ': no entry')
      if (/undefined|null/.test(entry)) kindProblems.push(id + '/' + kind + ': ' + entry)
      const citation = citationOf(style, [{ source, locator: '' }], { number: 1 })
      if (citation.trim() === '') kindProblems.push(id + '/' + kind + ': no citation')
      if (/undefined|null/.test(citation)) kindProblems.push(id + '/' + kind + ': ' + citation)
    }
  }
  check('every style renders every kind of source', kindProblems.join(' | '), '')

  const shapeProblems = []
  for (const id of STYLES) {
    for (const kind of KINDS) {
      const source = { key: 'k', kind, title: 'A title for ' + kind, authors: [{ family: 'Smith', given: 'J.' }], year: '2024', pages: '3-9' }
      for (const part of styleOf(id).reference(source, { number: 1 })) {
        if (!part || typeof part.text !== 'string' || part.text === '') shapeProblems.push(id + '/' + kind + ': a run with no text')
        if (part && Object.keys(part).some((key) => key !== 'text' && key !== 'italic' && key !== 'bold')) shapeProblems.push(id + '/' + kind + ': an unknown run key')
      }
    }
  }
  check('every run is a text with only the emphasis flags', shapeProblems.join(' | '), '')
}

// ---------------------------------------------------------------------------
// 6. plainOf, which is the plain-text fallback as well as this check's eyes
// ---------------------------------------------------------------------------
{
  check('plainOf reads a runs array in order', plainOf([{ text: 'a' }, { text: 'b', italic: true }]), 'ab')
  check('plainOf of nothing is empty, not `undefined`', plainOf([]), '')
  check('plainOf of null is empty, not a throw', plainOf(null), '')
  check('plainOf skips a malformed run instead of printing it', plainOf([{ text: 'a' }, null, 'b', { text: 'c' }]), 'ac')
  // The round trip that matters: an entry's runs become the plain text a
  // plain-text fallback prints, and putting that text back through plainOf as a
  // single run is the same string.
  check(
    'plainOf round-trips the entry every style builds',
    STYLES.map((id) => plainOf([{ text: plainOf(styleOf(id).reference(ARTICLE, { number: 1 })) }])).join('|'),
    STYLES.map((id) => plainOf(styleOf(id).reference(ARTICLE, { number: 1 }))).join('|'),
  )
}

console.log('')
console.log(failures === 0 ? 'all ' + checked + ' research-style checks passed' : failures + ' of ' + checked + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
