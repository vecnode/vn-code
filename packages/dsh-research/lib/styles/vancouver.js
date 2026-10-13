/**
 * dsh-research — Vancouver.
 *
 * Vancouver is the numbered style of the biomedical journals: a source is cited
 * by its position in the list, the list follows citation order, and the entry is
 * built to be read as a sequence of full stops rather than as a sentence.
 *
 * Two rules distinguish it from IEEE, which is also numbered:
 *
 *   - the initials carry no periods and follow the family name (`Smith J`,
 *     `Jones AB`), because that is what the ICMJE's own examples print;
 *   - a page range keeps the hyphen the record holds instead of becoming an en
 *     dash, which is why this style is the exception to the dash rule.
 *
 * The style abbreviates nothing itself. Vancouver's journal abbreviations come
 * from an external list this package does not ship, and inventing one from a
 * title would print a journal name no reader could look up - so the container is
 * printed exactly as the record stores it.
 */

import {
  authorsOf,
  compactInitialsOf,
  containerOf,
  editionLabel,
  familyOf,
  givenOf,
  issueOf,
  kindOf,
  linkOf,
  locatorOf,
  numberFor,
  placeOf,
  publisherOf,
  run,
  textOf,
  titleOf,
  trimEnd,
  volumeOf,
  withNote,
  yearOf,
} from './common.js'

/** `Smith J` — family first, initials with no periods, which is Vancouver's form. */
function referenceName(person) {
  const family = familyOf(person)
  const initials = compactInitialsOf(givenOf(person))
  return initials === '' ? family : family + ' ' + initials
}

/**
 * The author element: names separated by commas with no conjunction, and an
 * author list past six names cut at the sixth, which is the ICMJE's rule for a
 * reference list that would otherwise be longer than the article citing it.
 */
function referenceAuthors(authors) {
  const names = authors.map(referenceName)
  if (names.length > 6) return names.slice(0, 6).join(', ') + ', et al.'
  return names.join(', ')
}

/** The atomic in-text form: the citation number, or nothing when the caller supplied none. */
function inText(source, ctx) {
  const number = numberFor(ctx)
  return number === 0 ? '' : String(number)
}

/**
 * A group is `(1)`, or `(1, 45)` when the citation carried a locator. This is the
 * bare number of the in-text form with its parentheses put back, because a
 * citation that stands alone in a sentence needs none.
 */
function group(items, ctx) {
  const parts = (Array.isArray(items) ? items : []).map((item, index) => {
    const number = numberFor(ctx, index)
    const locator = locatorOf(item)
    const body = number === 0 ? '' : String(number)
    if (body === '' && locator === '') return ''
    if (locator === '') return body
    return body === '' ? locator : body + ', ' + locator
  })
  return '(' + parts.filter((part) => part !== '').join(', ') + ')'
}

/**
 * A periodical entry: `Year;Volume(Issue):Pages.`
 *
 * Every piece is optional and a missing one takes its punctuation with it - a
 * record with no volume must not render `2024;:45-67`.
 */
function periodicalTail(source) {
  const year = yearOf(source)
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = textOf(source.pages)
  const volumeIssue = volume === '' ? '' : volume + (issue === '' ? '' : '(' + issue + ')')
  let locator = volumeIssue
  if (pages !== '') locator = locator === '' ? pages : locator + ':' + pages
  if (locator === '') return year === '' ? '' : year + '.'
  return (year === '' ? '' : year + ';') + locator + '.'
}

/** A book, a report or a thesis: title, edition, then `Place: Publisher; Year.` */
function volumeRuns(source) {
  const runs = []
  const title = titleOf(source)
  if (title !== '') runs.push(run(title + '. '))
  const edition = editionLabel(source)
  if (edition !== '') runs.push(run(edition + ' '))
  const place = placeOf(source)
  const publisher = publisherOf(source)
  const year = yearOf(source)
  const imprint = place !== '' && publisher !== '' ? place + ': ' + publisher : publisher || place
  const close = []
  if (imprint !== '') close.push(imprint)
  if (year !== '') close.push(year)
  if (close.length > 0) runs.push(run(close.join('; ') + '.'))
  return runs
}

/** A page on the web: the title, the site, the year it was published, and where it was read. */
function webRuns(source) {
  const runs = []
  const title = titleOf(source)
  if (title !== '') runs.push(run(title + '. '))
  const site = containerOf(source)
  const year = yearOf(source)
  const cited = textOf(source.accessed)
  if (site !== '') runs.push(run(site + (year === '' ? '' : '; ' + year)))
  else if (year !== '') runs.push(run(year))
  if (cited !== '') runs.push(run((site === '' && year === '' ? '' : ' ') + '[cited ' + cited + ']'))
  if (runs.length > 0) runs.push(run('.'))
  const link = linkOf(source)
  if (link !== null) runs.push(run(' Available from: ' + link.value))
  return runs
}

/** One reference-list entry, as runs. Vancouver italicises nothing, so these are plain. */
function reference(source, ctx) {
  const kind = kindOf(source)
  const runs = []
  const number = numberFor(ctx)
  if (number !== 0) runs.push(run(number + '. '))

  const authors = authorsOf(source)
  if (authors.length > 0) runs.push(run(referenceAuthors(authors) + '. '))

  if (kind === 'journal-article') {
    const title = titleOf(source)
    if (title !== '') runs.push(run(title + '. '))
    const container = containerOf(source)
    if (container !== '') runs.push(run(container + '. '))
    const tail = periodicalTail(source)
    if (tail !== '') runs.push(run(tail))
  } else if (kind === 'web') {
    runs.push(...webRuns(source))
  } else if (kind === 'chapter' || kind === 'conference-paper') {
    const title = titleOf(source)
    if (title !== '') runs.push(run(title + '. '))
    const container = containerOf(source)
    if (container !== '') runs.push(run('In: ' + container + '. '))
    runs.push(...volumeRuns({ ...source, title: '' }))
  } else {
    runs.push(...volumeRuns(source))
  }

  // A DOI is the reference's own address and is printed as Vancouver's own
  // `doi:` element; a record with no DOI is cited by its URL in Vancouver's
  // words. Both are here because a reader who cannot find the source has been
  // handed a citation that does not work.
  const link = linkOf(source)
  if (kind !== 'web' && link !== null) {
    if (link.form === 'doi') runs.push(run(' doi:' + link.value))
    else runs.push(run(' Available from: ' + link.value))
  }

  return trimEnd(withNote(runs, source))
}

export default {
  id: 'vancouver',
  label: 'Vancouver',
  order: 'citation',
  referenceHeading: 'References',
  inText,
  group,
  note() {
    return null
  },
  reference,
}
