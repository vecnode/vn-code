/**
 * dsh-research — the page, font and heading shape of each paper style.
 *
 * A citation style answers "how is a source named". A PAPER style answers "what
 * does the page look like", and the two are not the same question: a run records
 * its citation style, and this module is what turns that id into a page. Keeping
 * them apart is why adding a citation style does not silently change a page.
 *
 * Everything here is DATA, and every value states its rule:
 *
 *   - **Sizes are twips and half-points**, because that is what OOXML stores. One
 *     point is 20 twips; one point is 2 half-points. A decimal inch or an integer
 *     point never reaches a part.
 *   - **The page is US Letter for every paper style.** The student styles are
 *     written against a Letter default and none of the six pins a different sheet;
 *     guessing A4 for one of them would be inventing a rule.
 *   - **Margins are 1in/1440twips for every style**, which APA 7 requires and the
 *     others accept.
 *   - **APA and MLA are double spaced.** That is the one spacing rule a grader
 *     checks by eye, and it is stated here rather than inside the OOXML writer.
 *   - **Heading formats are the real difference between the styles.** APA's three
 *     levels descend in one particular way (a centred bold level 1, a flush-left
 *     bold level 2, a bold-italic level 3); the others descend by size and weight.
 *   - **The title block is centred for APA, both Chicagos and MLA, and flush left
 *     for IEEE and Vancouver**, which is what each of those styles prints.
 *
 * TWO HONEST LIMITS, stated here rather than discovered by a reader:
 *
 *   1. **IEEE is rendered SINGLE COLUMN.** IEEE conference and journal templates
 *      are two-column, and a two-column section is a `w:cols` property this writer
 *      does not emit: it would change where every table, figure and footnote
 *      lands, and a two-column document produced without the template's other
 *      rules is worse than an honest single-column one. So every IEEE document
 *      from this writer is single column, and `columns` below says `1`.
 *   2. The fonts are the ones each style names as its default on a machine that
 *      has it. A style whose official instruction names a font this host does not
 *      ship (MLA's Times New Roman is not installed everywhere) still WRITES that
 *      name, because the document is what a reader's machine opens, not this one.
 */

/** One inch in twips, which is the unit every page measurement is written in. */
export const TWIPS_PER_INCH = 1440

/** One point in twips, and in half-points: the two OOXML size units. */
export const TWIPS_PER_POINT = 20
export const HALF_POINTS_PER_POINT = 2

/** The page every style in this build uses: US Letter, in twips. */
const LETTER = { width: 12240, height: 15840 }

/** The margins every style in this build uses: one inch on each side. */
const ONE_INCH = { top: 1440, right: 1440, bottom: 1440, left: 1440 }

/** A heading rule: bold, italic, centred, and nothing else. */
function heading(bold, italic = false, align = 'left') {
  return { bold, italic, align }
}

/** A spacing rule: the line rule, its value, and the space after a paragraph. */
function spacing(line, lineRule, after) {
  return { line, lineRule, after }
}

/**
 * One descriptor per paper style, in the registry's own order plus `plain`.
 *
 * `plain` is not a citation style: it is a document with none of them applied,
 * for a reader who wants the words and nothing else. It is in this list because
 * the DOCX writer is also the renderer for a document that was never assigned a
 * style, and a caller must be able to ask for that by name.
 */
const DESCRIPTORS = [
  {
    id: 'apa7',
    label: 'APA 7th edition',
    font: 'Times New Roman',
    sizeHalfPoints: 24,
    spacing: spacing(480, 'auto', 0),
    headings: [heading(true, false, 'center'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'center', bold: false },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'chicago-notes',
    label: 'Chicago (notes and bibliography)',
    font: 'Times New Roman',
    sizeHalfPoints: 24,
    spacing: spacing(240, 'auto', 0),
    headings: [heading(true, false, 'center'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'center', bold: false },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'chicago-author-date',
    label: 'Chicago (author-date)',
    font: 'Times New Roman',
    sizeHalfPoints: 24,
    spacing: spacing(240, 'auto', 0),
    headings: [heading(true, false, 'center'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'center', bold: false },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'mla9',
    label: 'MLA 9th edition',
    font: 'Times New Roman',
    sizeHalfPoints: 24,
    spacing: spacing(480, 'auto', 0),
    headings: [heading(true, false, 'center'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'center', bold: false },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'ieee',
    label: 'IEEE',
    font: 'Times New Roman',
    sizeHalfPoints: 20,
    spacing: spacing(240, 'auto', 0),
    headings: [heading(true, false, 'left'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'left', bold: true },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'vancouver',
    label: 'Vancouver',
    font: 'Times New Roman',
    sizeHalfPoints: 22,
    spacing: spacing(240, 'auto', 0),
    headings: [heading(true, false, 'left'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'left', bold: true },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
  {
    id: 'plain',
    label: 'No citation style',
    font: 'Times New Roman',
    sizeHalfPoints: 22,
    spacing: spacing(240, 'auto', 0),
    headings: [heading(true, false, 'left'), heading(true, false, 'left'), heading(true, true, 'left')],
    titleBlock: { align: 'left', bold: true },
    columns: 1,
    page: LETTER,
    margins: ONE_INCH,
  },
]

/** Every paper style this writer can render, in the describer's order. */
export const PAPER_STYLES = Object.freeze(DESCRIPTORS.map((one) => one.id))

/** The heading rule for a level, clamped to what this build declares (levels 1-6). */
export function headingRuleOf(descriptor, level) {
  const rules = descriptor.headings
  const index = Math.min(Math.max(Number(level) || 1, 1), rules.length) - 1
  return rules[index] ?? rules[rules.length - 1]
}

/** One descriptor, or null for an id this build does not render. */
export function paperStyleOf(id) {
  return DESCRIPTORS.find((one) => one.id === id) ?? null
}

/** A `w:sz` value as a decimal point size, for a report or a message. */
export function pointsOf(halfPoints) {
  return Number(halfPoints) / HALF_POINTS_PER_POINT
}
