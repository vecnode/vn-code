/**
 * dsh-research — MLA 9th edition.
 *
 * MLA is an author-page style: the in-text form names the author and the PAGE,
 * and never the year, because the year belongs to the entry in the list rather
 * than to the sentence making the point. That is why `inText` here prints a name
 * and nothing else - a caller with a locator adds it, which is what `group` does.
 *
 * The list is headed `Works Cited`, which is not a synonym for `References`: the
 * heading says that only the works actually cited appear, and a list that grew a
 * work nobody cited would be mislabelled by its own heading.
 *
 * Two or three names are spelled out and four or more shorten to `et al.`, and the
 * first author is inverted while the rest are not - the entry is found by the
 * surname at the left margin.
 */

import {
  authorsOf,
  closed,
  containerOf,
  editionLabel,
  enDashPages,
  familyOf,
  givenOf,
  issueOf,
  italic,
  joinRuns,
  joinWith,
  kindOf,
  linkOf,
  locatorOf,
  peopleOf,
  publisherOf,
  run,
  shortTitle,
  titleOf,
  trimEnd,
  volumeOf,
  withNote,
  yearOf,
} from './common.js'

/** `Smith, J.` — the first author of an entry is inverted, and the rest are not. */
function referenceName(person) {
  const family = familyOf(person)
  const given = givenOf(person)
  return given === '' ? family : family + ', ' + given
}

/** `Alice B. Jones` — every author after the first is named in reading order. */
function plainName(person) {
  const family = familyOf(person)
  const given = givenOf(person)
  return given === '' ? family : given + ' ' + family
}

/**
 * The author element: `Smith, J., and Alice B. Jones` for two, `Smith, J., et al.`
 * from three, because a Works Cited entry is scanned at its left margin.
 */
function referenceAuthors(authors) {
  if (authors.length > 2) return referenceName(authors[0]) + ', et al.'
  const names = [referenceName(authors[0]), ...authors.slice(1).map(plainName)]
  return joinWith(names, 'and', true)
}

/**
 * The atomic in-text form: the family name alone, `and` for two authors, `et al.`
 * for three or more. There is no year, and a record with no author is cited by
 * its title - which MLA puts in quotation marks when the work is part of
 * something larger.
 */
function inText(source) {
  const authors = authorsOf(source)
  if (authors.length === 0) return '"' + shortTitle(titleOf(source)) + '"'
  if (authors.length === 1) return familyOf(authors[0])
  if (authors.length === 2) return familyOf(authors[0]) + ' and ' + familyOf(authors[1])
  return familyOf(authors[0]) + ' et al.'
}

/** A parenthetical group: `(Smith and Jones 45)`, the locator after the name with no comma. */
function group(items) {
  const parts = (Array.isArray(items) ? items : []).map((item) => {
    const body = inText(item?.source)
    const locator = locatorOf(item)
    return locator === '' ? body : body + ' ' + locator
  })
  return '(' + parts.join('; ') + ')'
}

/**
 * The periodical tail: `, vol. 12, no. 3, 2024, pp. 45–67.` with only what exists.
 *
 * `lead` says whether the italic container is already on the page, because the
 * comma that separates the two belongs to the pair and not to the tail: a record
 * with no container must not begin its pages with a comma. `url` is the last
 * element MLA keeps, and it takes the same comma as the rest.
 */
function periodicalRuns(source, lead, url) {
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = enDashPages(source.pages)
  const year = yearOf(source)
  const elements = [
    volume === '' ? [] : [run('vol. ' + volume)],
    issue === '' ? [] : [run('no. ' + issue)],
    year === '' ? [] : [run(year)],
    pages === '' ? [] : [run('pp. ' + pages)],
    url === '' ? [] : [run(url)],
  ]
  const tail = joinRuns(elements, ', ')
  if (tail.length === 0) return []
  return [...(lead ? [run(', ')] : []), ...tail, run('.')]
}

/** A chapter or a conference paper: what it sits in, in what edition, and on which pages. */
function containerRuns(source) {
  const runs = []
  const container = containerOf(source)
  if (container !== '') runs.push(italic(container))
  const editors = peopleOf(source.editor)
  if (editors.length > 0) {
    runs.push(run((runs.length > 0 ? ', ' : '') + 'edited by ' + editors.map(plainName).join(', ')))
  }
  const edition = editionLabel(source)
  const tail = []
  if (edition !== '') tail.push(edition)
  const pages = enDashPages(source.pages)
  if (pages !== '') tail.push('pp. ' + pages)
  const publisher = publisherOf(source)
  if (publisher !== '') tail.push(publisher)
  const year = yearOf(source)
  if (year !== '') tail.push(year)
  if (tail.length > 0) runs.push(run((runs.length > 0 ? ', ' : '') + tail.join(', ') + '.'))
  return runs
}

/** A book: the italic title, then edition, publisher and year. */
function bookRuns(source) {
  const runs = []
  const edition = editionLabel(source)
  const tail = []
  if (edition !== '') tail.push(edition)
  const publisher = publisherOf(source)
  if (publisher !== '') tail.push(publisher)
  const year = yearOf(source)
  if (year !== '') tail.push(year)
  if (tail.length > 0) runs.push(run((runs.length > 0 ? ', ' : '') + tail.join(', ') + '.'))
  return runs
}

/** A page on the web: the site it is on, the year, and where it was read. */
function webRuns(source) {
  const runs = []
  const site = containerOf(source)
  if (site !== '') runs.push(italic(site))
  const tail = []
  const year = yearOf(source)
  if (year !== '') tail.push(year)
  const link = linkOf(source)
  if (link !== null) tail.push(link.value)
  if (tail.length > 0) runs.push(run((runs.length > 0 ? ', ' : '') + tail.join(', ') + '.'))
  return runs
}

/**
 * One entry in Works Cited, as runs.
 *
 * A work that stands on its own - a book, a report, a whole site - carries its
 * title in italics; a work that is PART of something larger carries it in
 * quotation marks, and the something larger is the italic.
 */
function reference(source) {
  const kind = kindOf(source)
  const authors = authorsOf(source)
  const title = titleOf(source)
  const part = kind === 'journal-article' || kind === 'chapter' || kind === 'conference-paper' || kind === 'web'
  const runs = []

  if (authors.length > 0) runs.push(run(closed(referenceAuthors(authors)) + ' '))
  if (title !== '') {
    if (part) runs.push(run('"' + title + '." '))
    else runs.push(italic(title), run('. '))
  }

  const link = linkOf(source)
  // MLA 9 prints a DOI as the https URL a reader can follow, and prints a bare
  // URL when there is no DOI. Either way the entry ends with an address, because
  // a Works Cited entry that cannot be followed is a citation that does not work.
  const url = link === null ? '' : link.form === 'doi' ? 'https://doi.org/' + link.value : link.value

  if (kind === 'journal-article') {
    const container = containerOf(source)
    if (container !== '') runs.push(italic(container))
    runs.push(...periodicalRuns(source, container !== '', url))
  } else if (kind === 'chapter' || kind === 'conference-paper') {
    runs.push(...containerRuns(source))
    if (url !== '') runs.push(run(' ' + url))
  } else if (kind === 'web') runs.push(...webRuns(source))
  else {
    runs.push(...bookRuns(source))
    if (url !== '') runs.push(run(' ' + url))
  }

  return trimEnd(withNote(runs, source))
}

export default {
  id: 'mla9',
  label: 'MLA 9th edition',
  order: 'alphabetical',
  referenceHeading: 'Works Cited',
  inText,
  group,
  note() {
    return null
  },
  reference,
}
