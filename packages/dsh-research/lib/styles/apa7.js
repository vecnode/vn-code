/**
 * dsh-research — APA 7th edition.
 *
 * The two things a reader recognises APA by, and why each is what it is:
 *
 *   - the reference list inverts every author and joins the last with `&`
 *     (`Smith, J., & Jones, A. B.`), because APA is an author-date system: the
 *     list is what a reader scans by name, and `&` is what tells them at a glance
 *     that this is not a footnote style;
 *   - the container of a periodical is italic while the title of the article is
 *     not, because in APA the italic marks the work the piece sits INSIDE.
 *
 * Three or more authors become `First et al.` in the text while the reference
 * list still names all of them: a parenthetical has to stay readable, and a
 * reference list has to stay complete, so APA splits the two rather than choosing.
 *
 * Titles are printed AS STORED. A formatter that recased a title would be editing
 * the author's words, and the ledger holds what the source page said.
 */

import {
  authorsOf,
  closed,
  containerOf,
  editionLabel,
  enDashPages,
  familyOf,
  givenOf,
  initialsOf,
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

/** APA's own mark for a record with no date. */
const NO_DATE = 'n.d.'
/** The DOI is a URL in APA 7, written as one. */
const DOI_PREFIX = 'https://doi.org/'

/**
 * The bracketed description APA puts after the title of a work that is not a
 * book, an article or a chapter. Which KIND a record is decides it, so the record
 * cannot forget to say.
 */
const DESCRIPTORS = {
  thesis: 'Thesis',
  preprint: 'Preprint',
  dataset: 'Data set',
  standard: 'Standard',
}

/** `Smith, J.` — initials after the family name, which is APA's inverted form. */
function referenceName(person) {
  const initials = initialsOf(givenOf(person))
  const family = familyOf(person)
  return initials === '' ? family : family + ', ' + initials
}

/** `J. Smith` — the order an editor is named in inside a chapter's entry. */
function editorName(person) {
  const initials = initialsOf(givenOf(person))
  const family = familyOf(person)
  return initials === '' ? family : initials + ' ' + family
}

/**
 * The author element of a reference entry.
 *
 * APA 7 lists up to 20 names. A work with 21 or more keeps the first 19, an
 * ellipsis and the LAST name, because an entry is found by the name that opens it
 * and confirmed by the name that closes it. `&` (never `and`) is the conjunction,
 * with a comma before it even when only two names are listed.
 */
function referenceAuthors(authors) {
  const names = authors.map(referenceName)
  if (names.length > 20) return names.slice(0, 19).join(', ') + ', \u2026 ' + names[names.length - 1]
  return joinWith(names, '&', true)
}

/**
 * The atomic in-text form for one source.
 *
 * The reference list names 20 authors; a parenthetical does not. One and two
 * names are printed in full and three or more shorten at the first name, which is
 * the whole point of the split - and there is no date to print for a record that
 * has none, so `n.d.` stands where the year would.
 */
function inText(source) {
  const authors = authorsOf(source)
  const year = yearOf(source) === '' ? NO_DATE : yearOf(source)
  if (authors.length === 0) {
    // APA moves the title into the author position, and a title used that way is
    // quoted: it names the work rather than a person. The comma sits inside the
    // closing quotation mark, which is APA's own placement.
    return '"' + shortTitle(titleOf(source)) + '," ' + year
  }
  if (authors.length === 1) return familyOf(authors[0]) + ', ' + year
  if (authors.length === 2) return familyOf(authors[0]) + ' & ' + familyOf(authors[1]) + ', ' + year
  return familyOf(authors[0]) + ' et al., ' + year
}

/** A parenthetical group: the sources separated by `;`, each with its locator after the year. */
function group(items) {
  const parts = (Array.isArray(items) ? items : []).map((item) => {
    const body = inText(item?.source)
    const locator = locatorOf(item)
    return locator === '' ? body : body + ', ' + locator
  })
  return '(' + parts.join('; ') + ')'
}

/** What belongs after the title, before the container: an edition and a description. */
function titleTail(source, kind, standalone, title) {
  const edition = standalone ? editionLabel(source) : ''
  const descriptor = DESCRIPTORS[kind] ?? ''
  let tail = ''
  if (edition !== '') tail += ' (' + edition + ')'
  if (descriptor !== '') tail += ' [' + descriptor + ']'
  // A title that already ends in a stop keeps it: `Title..` is the doubling a
  // bibliography is remembered for.
  return tail + (/[.!?]$/.test(title) ? '' : '.') + ' '
}

/** The periodical element: an italic container and an italic volume, plain issue and pages. */
function periodicalRuns(source) {
  const container = containerOf(source)
  const volume = volumeOf(source)
  const issue = issueOf(source)
  const pages = enDashPages(source.pages)
  const volumeIssue = volume === '' ? [] : [italic(volume), ...(issue === '' ? [] : [run('(' + issue + ')')])]
  const tail = joinRuns(
    [container === '' ? [] : [italic(container)], volumeIssue, pages === '' ? [] : [run(pages)]],
    ', ',
  )
  return tail.length === 0 ? [] : [...tail, run('. ')]
}

/** A chapter or a conference paper: the work it sits in, its editors, and its pages. */
function containerRuns(source) {
  const editors = peopleOf(source.editor)
  const runs = []
  if (editors.length === 0) runs.push(run('In '))
  else {
    const names = editors.map(editorName).join(', ')
    runs.push(run('In ' + names + (editors.length === 1 ? ' (Ed.), ' : ' (Eds.), ')))
  }
  const container = containerOf(source)
  if (container !== '') runs.push(italic(container))
  const pages = enDashPages(source.pages)
  if (pages !== '') runs.push(run(' (pp. ' + pages + ')'))
  runs.push(run('. '))
  const publisher = publisherOf(source)
  if (publisher !== '') runs.push(run(publisher + '. '))
  return runs
}

/**
 * The body that published a standalone work.
 *
 * A `web` source names its SITE (the container) and an issued work names its
 * publisher, and APA 7 prints neither a place nor a URL that duplicates a DOI.
 */
function bodyRuns(source, kind) {
  if (kind === 'web') {
    const site = containerOf(source)
    return site === '' ? [] : [run(site + '. ')]
  }
  const publisher = publisherOf(source) || containerOf(source)
  return publisher === '' ? [] : [run(publisher + '. ')]
}

/** The source element, which differs by what the work IS. */
function sourceRuns(source, kind) {
  if (kind === 'journal-article') return periodicalRuns(source)
  if (kind === 'chapter' || kind === 'conference-paper') return containerRuns(source)
  return bodyRuns(source, kind)
}

/** One reference-list entry, as runs so the italics reach a DOCX. */
function reference(source) {
  const kind = kindOf(source)
  const authors = authorsOf(source)
  const title = titleOf(source)
  // A standalone work's title is italic in its own slot; a piece of a periodical
  // or of a book is set in roman, because the italic belongs to the container.
  const standalone = !(kind === 'journal-article' || kind === 'chapter' || kind === 'conference-paper')
  const byTitle = authors.length === 0 && title !== ''
  const runs = []

  if (authors.length > 0) runs.push(run(closed(referenceAuthors(authors)) + ' '))
  else if (title !== '') {
    // No author: the title moves into the author position, carrying its edition
    // and its description with it, and is printed exactly once.
    runs.push(standalone ? italic(title) : run(title))
    runs.push(run(titleTail(source, kind, standalone, title)))
  }

  runs.push(run('(' + (yearOf(source) === '' ? NO_DATE : yearOf(source)) + '). '))

  if (!byTitle && title !== '') {
    runs.push(standalone ? italic(title) : run(title))
    runs.push(run(titleTail(source, kind, standalone, title)))
  }

  runs.push(...sourceRuns(source, kind))

  const link = linkOf(source)
  if (link !== null) runs.push(run(link.form === 'doi' ? DOI_PREFIX + link.value : link.value))

  return trimEnd(withNote(runs, source))
}

export default {
  id: 'apa7',
  label: 'APA 7th edition',
  order: 'alphabetical',
  referenceHeading: 'References',
  inText,
  group,
  note() {
    return null
  },
  reference,
}
