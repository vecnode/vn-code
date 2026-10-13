/**
 * dsh-research — Chicago 17th edition, notes and bibliography.
 *
 * This is a NOTES style, and that decides its whole shape: a source is cited in a
 * footnote, so `inText` and `group` are empty and `note` carries the citation -
 * the caller that asked for an in-text form gets nothing rather than a
 * parenthetical Chicago does not use, which makes the missing call visible
 * instead of quietly printing the wrong convention.
 *
 * The note and the bibliography name the same author differently, and both are
 * Chicago's rule rather than a preference:
 *
 *   - a NOTE names every author in reading order (`J. Smith and Alice B. Jones`),
 *     because a footnote is read as a sentence;
 *   - a BIBLIOGRAPHY inverts the first author and keeps the rest in reading order
 *     (`Smith, J., and Alice B. Jones`), because the list is scanned down its left
 *     margin. The comma before `and` is part of that: it separates the inverted
 *     name from the conjunction.
 *
 * A title inside a quotation mark takes its comma or its full stop INSIDE the
 * mark, which is where American punctuation puts it when the title ends the
 * clause.
 */

import {
  authorsOf,
  closed,
  containerOf,
  editionLabel,
  enDashPages,
  givenFirstOf,
  invertedOf,
  issueOf,
  italic,
  joinWith,
  kindOf,
  linkOf,
  locatorOf,
  longDate,
  peopleOf,
  placeOf,
  plainOf,
  publisherOf,
  run,
  textOf,
  titleOf,
  trimEnd,
  volumeOf,
  withNote,
  yearOf,
} from './common.js'

/** Chicago's own mark for a record with no date. */
const NO_DATE = 'n.d.'

/** `J. Smith` — a note names an author in reading order. */
function noteName(person) {
  return givenFirstOf(person)
}

/**
 * The author element of a NOTE: `and` before the last name, with a comma before
 * it only once three are named. Past ten names Chicago shortens to the first name
 * and `et al.`, because a footnote is not where a full author list belongs.
 */
function noteAuthors(authors) {
  if (authors.length > 10) return noteName(authors[0]) + ' et al.'
  return joinWith(authors.map(noteName), 'and', authors.length > 2)
}

/**
 * The author element of a BIBLIOGRAPHY entry: the first name inverted, the rest
 * in reading order, `and` before the last with a comma in front of it.
 */
function bibliographyAuthors(authors) {
  if (authors.length > 10) return invertedOf(authors[0]) + ' et al.'
  const names = [invertedOf(authors[0]), ...authors.slice(1).map(givenFirstOf)]
  return joinWith(names, 'and', true)
}

/** `edited by Alice B. Jones` — how a chapter names the person who edited the book. */
function editorPhrase(editors) {
  return 'edited by ' + editors.map(givenFirstOf).join(', ')
}

/** `City: Publisher, 2024` — and whichever of the three a record actually has. */
function imprintBody(source, year) {
  const place = placeOf(source)
  const publisher = publisherOf(source)
  const body = place !== '' && publisher !== '' ? place + ': ' + publisher : publisher || place
  return body === '' ? year : body + ', ' + year
}

/** `(City: Publisher, 2024)` — the same imprint, in the parentheses a note closes with. */
function noteImprint(source, year) {
  return '(' + imprintBody(source, year) + ')'
}

/**
 * The periodical body a note and a bibliography entry share: volume, issue, year
 * and pages, each taking its own punctuation with it when the record lacks it.
 *
 * `lead` says whether the italic container is already on the page, because the
 * space before the volume belongs to the pair rather than to the volume.
 */
function periodicalBody(source, year, lead) {
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = enDashPages(source.pages)
  let body = lead ? ' ' : ''
  if (volume !== '') body += volume
  if (issue !== '') body += (volume === '' ? '' : ', ') + 'no. ' + issue
  body += ' (' + year + ')'
  if (pages !== '') body += ': ' + pages
  return body
}

/** The access date a source that can change is cited with, or ''. */
function accessedPhrase(source) {
  const spelled = longDate(textOf(source.accessed))
  return spelled === '' ? '' : spelled
}

/**
 * The URL a record with no DOI is cited by.
 *
 * A DOI is printed as the https URL Chicago itself uses - see `trailingUrl` - so
 * a bibliography entry a reader can follow is one a reader can FIND. A bare DOI
 * number is not an address.
 */
function trailingUrl(source) {
  const link = linkOf(source)
  if (link === null) return []
  const address = link.form === 'doi' ? 'https://doi.org/' + link.value : link.value
  return [run(' ' + address + '.')]
}

/** One footnote, without the closing full stop, so a locator can land before it. */
function noteBody(source) {
  const kind = kindOf(source)
  const authors = authorsOf(source)
  const title = titleOf(source)
  const year = yearOf(source) === '' ? NO_DATE : yearOf(source)
  const runs = []

  if (authors.length > 0) runs.push(run(noteAuthors(authors) + ', '))

  if (kind === 'journal-article') {
    if (title !== '') runs.push(run('"' + title + '," '))
    const container = containerOf(source)
    if (container !== '') runs.push(italic(container))
    runs.push(run(periodicalBody(source, year, container !== '')))
  } else if (kind === 'chapter' || kind === 'conference-paper') {
    if (title !== '') runs.push(run('"' + title + '," '))
    const container = containerOf(source)
    if (container !== '') runs.push(run('in '), italic(container))
    const editors = peopleOf(source.editor)
    if (editors.length > 0) runs.push(run(', ' + editorPhrase(editors)))
    const pages = enDashPages(source.pages)
    runs.push(run(' ' + noteImprint(source, year)))
    if (pages !== '') runs.push(run(', ' + pages))
  } else if (kind === 'web') {
    if (title !== '') runs.push(run('"' + title + '," '))
    const site = containerOf(source)
    const head = []
    if (site !== '') head.push(site)
    head.push(year)
    runs.push(run(head.join(', ')))
    const accessed = accessedPhrase(source)
    if (accessed !== '') runs.push(run(', accessed ' + accessed))
    const link = linkOf(source)
    if (link !== null) runs.push(run(', ' + link.value))
  } else {
    // A book, a report, a thesis: the title carries the emphasis and the imprint
    // closes the sentence.
    if (title !== '') runs.push(italic(title))
    const edition = editionLabel(source)
    if (edition !== '') runs.push(run(', ' + edition))
    runs.push(run(' ' + noteImprint(source, year)))
  }

  // A web source printed its address inside its own branch. The address goes
  // before the full stop the caller adds, because a note ends with one full stop
  // either way and an address does not. A DOI is printed as the https URL Chicago
  // itself uses, not as a bare number: a note a reader cannot follow is a note
  // that does not do its job.
  if (kind !== 'web') {
    const link = linkOf(source)
    if (link !== null) runs.push(run(', ' + (link.form === 'doi' ? 'https://doi.org/' + link.value : link.value)))
  }

  return runs
}

/** One bibliography entry, as runs. */
function bibliographyBody(source) {
  const kind = kindOf(source)
  const authors = authorsOf(source)
  const title = titleOf(source)
  const year = yearOf(source) === '' ? NO_DATE : yearOf(source)
  const runs = []

  if (authors.length > 0) runs.push(run(closed(bibliographyAuthors(authors)) + ' '))

  if (kind === 'journal-article') {
    if (title !== '') runs.push(run('"' + title + '." '))
    const container = containerOf(source)
    if (container !== '') runs.push(italic(container))
    runs.push(run(periodicalBody(source, year, container !== '')))
    runs.push(run('.'))
  } else if (kind === 'chapter' || kind === 'conference-paper') {
    if (title !== '') runs.push(run('"' + title + '." '))
    const container = containerOf(source)
    if (container !== '') runs.push(run('In '), italic(container))
    const editors = peopleOf(source.editor)
    if (editors.length > 0) runs.push(run(', ' + editorPhrase(editors)))
    const pages = enDashPages(source.pages)
    if (pages !== '') runs.push(run(', ' + pages))
    runs.push(run('. ' + imprintBody(source, year) + '.'))
  } else if (kind === 'web') {
    if (title !== '') runs.push(run('"' + title + '." '))
    const site = containerOf(source)
    const head = []
    if (site !== '') head.push(site)
    head.push(year)
    runs.push(run(head.join(', ')))
    const accessed = accessedPhrase(source)
    if (accessed !== '') runs.push(run('. Accessed ' + accessed))
    const link = linkOf(source)
    if (link !== null) runs.push(run('. ' + link.value))
    runs.push(run('.'))
  } else {
    if (title !== '') runs.push(italic(title), run('.'))
    const edition = editionLabel(source)
    if (edition !== '') runs.push(run(' ' + edition))
    runs.push(run(' ' + imprintBody(source, year) + '.'))
  }

  // A web source prints its address above, inside its own branch.
  if (kind !== 'web') runs.push(...trailingUrl(source))

  return runs
}

/**
 * The footnote text for one or more cited sources.
 *
 * A footnote is a STRING, which is the interface this package's styles share, so
 * the italics an entry carries cannot travel with it: the note is punctuated for
 * a reader and the bibliography is where the emphasis is carried into a DOCX.
 */
function note(items) {
  const parts = (Array.isArray(items) ? items : []).map((item) => {
    const runs = noteBody(item?.source)
    const locator = locatorOf(item)
    if (locator !== '') runs.push(run(', ' + locator))
    runs.push(run('.'))
    return plainOf(withNote(trimEnd(runs), item?.source))
  })
  return parts.join(' ')
}

/** One bibliography entry, as runs so the italics reach a DOCX. */
function reference(source) {
  return trimEnd(withNote(bibliographyBody(source), source))
}

export default {
  id: 'chicago-notes',
  label: 'Chicago 17th edition, notes and bibliography',
  order: 'alphabetical',
  referenceHeading: 'Bibliography',
  inText() {
    // Chicago cites in a note, so there is no author-date form to print.
    return ''
  },
  group() {
    // Nor a parenthetical: `note()` is where this style's citation lives.
    return ''
  },
  note,
  reference,
}
