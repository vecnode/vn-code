/**
 * dsh-research — Chicago 17th edition, author-date.
 *
 * The same manual as `chicago-notes.js`, with the citation moved out of the
 * footnote and into the sentence: `(Smith and Jones 2024, 45)`. That one decision
 * changes the reference list too - the year comes up next to the author instead of
 * sitting inside the imprint, because the year is what the reader is matching the
 * parenthetical against.
 *
 * The list is still headed `References` rather than `Bibliography`, which is how
 * Chicago marks the difference between the two systems: an author-date list holds
 * only what was cited, and a notes bibliography may hold what was consulted.
 *
 * The author element follows the same rule as the notes bibliography - the first
 * name inverted, the rest in reading order, `and` before the last with a comma in
 * front of it - so a person switching between the two systems reads the same list.
 */

import {
  authorsOf,
  closed,
  containerOf,
  editionLabel,
  enDashPages,
  familyOf,
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
  publisherOf,
  run,
  shortTitle,
  textOf,
  titleOf,
  trimEnd,
  volumeOf,
  withNote,
  yearOf,
} from './common.js'

/** Chicago's own mark for a record with no date. */
const NO_DATE = 'n.d.'
/** Chicago cites a DOI as the URL it resolves to. */
const DOI_PREFIX = 'https://doi.org/'

/**
 * The author element: the first name inverted, the rest in reading order, and a
 * comma before `and` even when only two are named - the comma separates the
 * inverted name from the conjunction. Past ten names the entry shortens to the
 * first name and `et al.`
 */
function referenceAuthors(authors) {
  if (authors.length > 10) return invertedOf(authors[0]) + ' et al.'
  const names = [invertedOf(authors[0]), ...authors.slice(1).map(givenFirstOf)]
  return joinWith(names, 'and', true)
}

/** The address a style prints for a DOI or a URL, difference included. */
function linkText(link) {
  return link.form === 'doi' ? DOI_PREFIX + link.value : link.value
}

/** The date a source that can change is cited with, or ''. */
function accessedPhrase(source) {
  return longDate(textOf(source?.accessed))
}

/** The title element: italic for a whole work, in quotation marks for part of one. */
function titleElement(title, part) {
  return part ? [run('"' + title + '." ')] : [italic(title), run('. ')]
}

/**
 * The atomic in-text form: `Smith and Jones 2024`, and never a comma between the
 * name and the year, because the comma is what introduces the locator.
 */
function inText(source) {
  const authors = authorsOf(source)
  const year = yearOf(source) === '' ? NO_DATE : yearOf(source)
  if (authors.length === 0) return '"' + shortTitle(titleOf(source)) + '" ' + year
  if (authors.length === 1) return familyOf(authors[0]) + ' ' + year
  if (authors.length === 2) return familyOf(authors[0]) + ' and ' + familyOf(authors[1]) + ' ' + year
  return familyOf(authors[0]) + ' et al. ' + year
}

/** A parenthetical group: `(Smith and Jones 2024, 45)`. */
function group(items) {
  const parts = (Array.isArray(items) ? items : []).map((item) => {
    const body = inText(item?.source)
    const locator = locatorOf(item)
    return locator === '' ? body : body + ', ' + locator
  })
  return '(' + parts.join('; ') + ')'
}

/** `12 (3): 45–67` — the volume and issue in parentheses, which is what dates the journal. */
function periodicalBody(source, lead) {
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = enDashPages(source.pages)
  let body = lead ? ' ' : ''
  if (volume !== '') body += volume
  if (issue !== '') body += ' (' + issue + ')'
  if (pages !== '') body += ': ' + pages
  return body
}

/** `City: Publisher`, and whichever of the two a record actually has. */
function imprintBody(source) {
  const place = placeOf(source)
  const publisher = publisherOf(source)
  if (place !== '' && publisher !== '') return place + ': ' + publisher
  return publisher || place
}

/** One reference-list entry, as runs so the italics reach a DOCX. */
function reference(source) {
  const kind = kindOf(source)
  const authors = authorsOf(source)
  const title = titleOf(source)
  const year = yearOf(source) === '' ? NO_DATE : yearOf(source)
  const part = kind === 'journal-article' || kind === 'chapter' || kind === 'conference-paper' || kind === 'web'
  const byTitle = authors.length === 0 && title !== ''
  const runs = []

  if (authors.length > 0) runs.push(run(closed(referenceAuthors(authors)) + ' '))
  else if (byTitle) runs.push(...titleElement(title, part))

  runs.push(run(year + '. '))

  if (!byTitle && title !== '') runs.push(...titleElement(title, part))

  if (kind === 'journal-article') {
    const container = containerOf(source)
    if (container !== '') runs.push(italic(container))
    runs.push(run(periodicalBody(source, container !== '') + '.'))
    const link = linkOf(source)
    if (link !== null) runs.push(run(' ' + linkText(link) + '.'))
  } else if (kind === 'chapter' || kind === 'conference-paper') {
    const container = containerOf(source)
    if (container !== '') runs.push(run('In '), italic(container))
    const editors = peopleOf(source.editor)
    if (editors.length > 0) runs.push(run(', edited by ' + editors.map(givenFirstOf).join(', ')))
    const pages = enDashPages(source.pages)
    if (pages !== '') runs.push(run(', ' + pages))
    const imprint = imprintBody(source)
    if (imprint !== '') runs.push(run('. ' + imprint))
    runs.push(run('.'))
  } else if (kind === 'web') {
    const site = containerOf(source)
    if (site !== '') runs.push(run(site + '. '))
    const accessed = accessedPhrase(source)
    if (accessed !== '') runs.push(run('Accessed ' + accessed + '. '))
    const link = linkOf(source)
    if (link !== null) runs.push(run(linkText(link) + '.'))
  } else {
    // A book, a report, a thesis: the title has been printed, and what follows is
    // the edition and the body that published it.
    const edition = editionLabel(source)
    if (edition !== '') runs.push(run(edition + ' '))
    const imprint = imprintBody(source)
    if (imprint !== '') runs.push(run(imprint + '.'))
  }

  // The journal branch placed its own link, and a web source placed its address
  // above. Everything else takes the link here, so a record with no DOI is still
  // cited by the URL it came from.
  const trailing = linkOf(source)
  if (kind !== 'web' && kind !== 'journal-article' && trailing !== null) runs.push(run(' ' + linkText(trailing) + '.'))

  return trimEnd(withNote(runs, source))
}

export default {
  id: 'chicago-author-date',
  label: 'Chicago 17th edition, author-date',
  order: 'alphabetical',
  referenceHeading: 'References',
  inText,
  group,
  note() {
    return null
  },
  reference,
}
