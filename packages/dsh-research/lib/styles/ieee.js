/**
 * dsh-research — IEEE.
 *
 * IEEE is a NUMBERED style: a source is cited by the position it holds in the
 * reference list, and the list is in citation order rather than alphabetical. So
 * the number is never a property of the record - it is handed in through `ctx` by
 * the caller that assembled the list - and a style that printed a number of its
 * own would renumber somebody's bibliography.
 *
 * The author's name is given INITIALS FIRST (`J. Smith`) because the list is read
 * as a sequence of references and the surname has to line up down the page; the
 * conjunction is `and` rather than `&`, which is the one place IEEE and APA part
 * company on the same list of two names.
 */

import {
  authorsOf,
  containerOf,
  editionLabel,
  enDashPages,
  familyOf,
  givenOf,
  initialsOf,
  issueOf,
  italic,
  joinWith,
  kindOf,
  linkOf,
  locatorOf,
  numberFor,
  peopleOf,
  placeOf,
  publisherOf,
  run,
  titleOf,
  trimEnd,
  volumeOf,
  withNote,
  yearOf,
} from './common.js'

/** Bracket a citation number the way IEEE does, and nothing at all without one. */
function numberPrefix(ctx, index = 0) {
  const number = numberFor(ctx, index)
  return number === 0 ? '' : '[' + number + '] '
}

/** `J. Smith` — initials first, which is IEEE's order for every list it keeps. */
function referenceName(person) {
  const initials = initialsOf(givenOf(person))
  const family = familyOf(person)
  return initials === '' ? family : initials + ' ' + family
}

/**
 * The author element: `and` before the last name, and a comma before it only once
 * there are three names, because IEEE does not comma a list of two.
 */
function referenceAuthors(authors) {
  const names = authors.map(referenceName)
  return joinWith(names, 'and', names.length > 2)
}

/** `J. Smith` and `A. B. Jones`, for the editors of a chapter. */
function editorName(person) {
  return referenceName(person)
}

/** The atomic in-text form: the citation number, or nothing when the caller supplied none. */
function inText(source, ctx) {
  const number = numberFor(ctx)
  return number === 0 ? '' : String(number)
}

/**
 * A group is `[1]`, `[1, p. 7]`, or `[1], [2]` — each source bracketed on its own,
 * because two bracketed numbers in one pair of brackets would read as one range.
 */
function group(items, ctx) {
  const parts = (Array.isArray(items) ? items : []).map((item, index) => {
    const number = numberFor(ctx, index)
    const locator = locatorOf(item)
    const body = number === 0 ? '' : String(number)
    if (body === '' && locator === '') return '[]'
    if (locator === '') return '[' + body + ']'
    return '[' + (body === '' ? locator : body + ', ' + locator) + ']'
  })
  return parts.join(', ')
}

/** The tail IEEE keeps in one comma-separated run: volume, issue, pages, year, DOI. */
function tailParts(source) {
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = enDashPages(source.pages)
  const year = yearOf(source)
  const parts = []
  if (volume !== '') parts.push('vol. ' + volume)
  if (issue !== '') parts.push('no. ' + issue)
  if (pages !== '') parts.push('pp. ' + pages)
  if (year !== '') parts.push(year)
  const link = linkOf(source)
  if (link !== null && link.form === 'doi') parts.push('doi: ' + link.value)
  return parts
}

/** The bracketed-numbered entry for a periodical item: an italic container and a comma tail. */
function periodicalRuns(source) {
  const runs = []
  const container = containerOf(source)
  if (container !== '') runs.push(italic(container))
  const tail = tailParts(source)
  if (tail.length > 0) runs.push(run((runs.length > 0 ? ', ' : '') + tail.join(', ') + '.'))
  return runs
}

/** A book or a chapter: the italic title, the edition, and the place and publisher it came from. */
function volumeRuns(source, kind) {
  const runs = []
  const title = titleOf(source)
  if (kind === 'chapter') {
    const editors = peopleOf(source.editor)
    if (title !== '') runs.push(run('"' + title + '," '))
    if (editors.length > 0) runs.push(run('in ' + editors.map(editorName).join(', ') + ', '))
    const container = containerOf(source)
    if (container !== '') runs.push(italic(container))
  } else if (title !== '') runs.push(italic(title))

  const place = placeOf(source)
  const publisher = publisherOf(source)
  const year = yearOf(source)
  const imprint = place !== '' && publisher !== '' ? place + ': ' + publisher : publisher || place
  const close = []
  if (imprint !== '') close.push(imprint)
  if (year !== '') close.push(year)

  // An edition closes with its own full stop and the imprint starts a new element
  // after it, which is how IEEE sets a book: `..., 2nd ed. City: Publisher, 2024.`
  const edition = editionLabel(source)
  if (edition !== '') {
    runs.push(run((runs.length > 0 ? ', ' : '') + edition))
    if (close.length > 0) runs.push(run(' ' + close.join(', ') + '.'))
  } else if (close.length > 0) {
    runs.push(run((runs.length > 0 ? ', ' : '') + close.join(', ') + '.'))
  }
  return runs
}

/** A page on the web: the title, the site, the year, and the address it was read at. */
function webRuns(source) {
  const runs = []
  const title = titleOf(source)
  if (title !== '') runs.push(run('"' + title + '," '))
  const site = containerOf(source)
  if (site !== '') runs.push(run(site))
  const year = yearOf(source)
  if (year !== '') runs.push(run((runs.length > 0 ? ', ' : '') + year))
  if (runs.length > 0) runs.push(run('.'))
  const link = linkOf(source)
  if (link !== null) runs.push(run(' [Online]. Available: ' + link.value))
  return runs
}

/** One reference-list entry, as runs so the italics reach a DOCX. */
function reference(source, ctx) {
  const kind = kindOf(source)
  const runs = []
  const prefix = numberPrefix(ctx)
  if (prefix !== '') runs.push(run(prefix))

  // No author: the entry simply opens with its title, which is what a reader of a
  // numbered list scans for when there is no name to scan for.
  const authors = authorsOf(source)
  if (authors.length > 0) runs.push(run(referenceAuthors(authors) + ', '))

  const title = titleOf(source)
  if (kind === 'journal-article' || kind === 'preprint') {
    // A preprint is cited by the same shape as a periodical: quoted title, italic
    // repository, and the DOI tail. Without this branch an arXiv entry printed its
    // title and its year and nothing else, so the one field a reader needs to get
    // the paper (the DOI) was the field the entry dropped.
    if (title !== '') runs.push(run('"' + title + '," '))
    runs.push(...periodicalRuns(source))
  } else if (kind === 'conference-paper') {
    // IEEE sets a conference paper as `"Title," in <Proceedings>, pp. x-y, year,
    // doi: ...`. The container IS the venue, so it has to be printed and italicised:
    // a branch that fell through to the book shape would name the publisher and
    // drop the conference, which is the one field a reader searches for.
    if (title !== '') runs.push(run('"' + title + '," '))
    const container = containerOf(source)
    if (container !== '') runs.push(run('in '), italic(container))
    const tail = tailParts(source)
    if (tail.length > 0) runs.push(run((runs.length > 0 ? ', ' : '') + tail.join(', ') + '.'))
  } else if (kind === 'web') {
    runs.push(...webRuns(source))
  } else {
    runs.push(...volumeRuns(source, kind))
  }

  // A URL is the fallback a record with no DOI is cited by, and IEEE asks for it
  // in its own words. A DOI was already placed inside the entry's tail.
  const link = linkOf(source)
  if (kind !== 'web' && link !== null && link.form === 'url') runs.push(run(' [Online]. Available: ' + link.value))

  return trimEnd(withNote(runs, source))
}

export default {
  id: 'ieee',
  label: 'IEEE',
  order: 'citation',
  referenceHeading: 'References',
  inText,
  group,
  note() {
    return null
  },
  reference,
}
