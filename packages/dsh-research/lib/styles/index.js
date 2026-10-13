/**
 * dsh-research — the citation style registry.
 *
 * One module per style, one line to register it, and one check that drives every
 * registered module (`checks/check-research-styles.mjs`). Adding a seventh style
 * is therefore mechanical:
 *
 *   1. write `lib/styles/<id>.js` with the interface below and `export default`;
 *   2. import it here and add it to `STYLE_MODULES` AND to `STYLES`, in the order
 *      a person should meet them;
 *   3. add the same id to `STYLES` in `lib/run.js`, because a run RECORDS the
 *      style it will be built in - a recorded style with no renderer is a run that
 *      fails at the last step instead of the first, and the check fails until the
 *      two lists agree.
 *
 * Every style module default-exports:
 *
 *   id                the id, which equals its own file name and one of run.js's STYLES
 *   label             what a person reads in a picker
 *   order             'alphabetical' (sort by the entry's own text) or 'citation'
 *   referenceHeading  what the list is headed, which is not decoration: `Works
 *                     Cited` is not a synonym for `Bibliography`
 *   inText(source, ctx)          the atomic form without surrounding punctuation;
 *                                '' for a style that cites somewhere else
 *   group(items, ctx)            the full parenthetical, WITH punctuation
 *   note(items, ctx)             the footnote text for a notes style, else null
 *   reference(source, ctx)       one list entry as RUNS, so italics survive into
 *                                a DOCX rather than being lost as markup
 *
 * `ctx` carries what the record cannot: `{ number }` (1-based, citation order) for
 * a numeric style, and `{ numbers }` when one group cites several sources at once.
 *
 * `styleOf` answers null for an id this build does not know rather than throwing,
 * because the caller decides what an unknown style means: a refusal when a run is
 * being created, and a fallback when a run written by another build is being read.
 */

import apa7 from './apa7.js'
import chicagoAuthorDate from './chicago-author-date.js'
import chicagoNotes from './chicago-notes.js'
import ieee from './ieee.js'
import mla9 from './mla9.js'
import vancouver from './vancouver.js'
import { plainOf } from './common.js'

/**
 * The six ids this build renders, in the order `lib/run.js` lists them.
 *
 * The order is DECLARED rather than derived from the modules below, because a run
 * records a style by id and this is the list a picker shows. The check asserts the
 * two lists agree, so the copy cannot drift.
 */
export const STYLES = ['apa7', 'chicago-notes', 'chicago-author-date', 'mla9', 'ieee', 'vancouver']

/** Every registered module, in `STYLES` order. This is the registry. */
export const STYLE_MODULES = [apa7, chicagoNotes, chicagoAuthorDate, mla9, ieee, vancouver]

/** One style module, or null for an id this build has no renderer for. */
export function styleOf(id) {
  return STYLE_MODULES.find((style) => style.id === id) ?? null
}

/** The heading a style gives its reference list, or null for an unknown style. */
export function referenceHeadingOf(id) {
  return styleOf(id)?.referenceHeading ?? null
}

export { plainOf }
