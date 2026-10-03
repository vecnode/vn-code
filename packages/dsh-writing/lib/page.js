/**
 * dsh-writing — the page breaker (pure).
 *
 * A word processor's page is not a scroll: text ends at the bottom margin and
 * continues on the next page, and the person has to SEE that as they type. This
 * file decides which blocks land on which page, and it decides it with the block
 * heights INJECTED (`measure`), exactly the way `dsh-canvas`'s engine takes its
 * text measurer: the host can run this with a stub, a check can run it with a
 * fixed table, and only the browser half supplies a real one (it renders the
 * block into a hidden box at the page's own content width and reads the height).
 *
 * WHAT THIS DOES NOT DO, and the README says so out loud: a block that does not
 * fit is MOVED to the next page, never SPLIT across two. A paragraph longer than
 * a page therefore overflows its own page and is reported (`overflow: true`) -
 * real line-level splitting needs a line-box measurement this version does not
 * take. That is the one honest gap in alpha.1, and it is visible rather than
 * silent.
 *
 * Everything is millimetres, matching the model: this file OWNS the page
 * geometry (the size table, the orientation, the margins), model.js re-exports
 * it, and this file therefore has NO imports at all - which is what lets the
 * browser half fetch it from this plugin's own route and import it from a blob
 * URL (the shape `dsh-canvas` uses for its engine), so the page breaker that
 * runs in the tab and the one the checks drive are the SAME code.
 */
/** The page sizes this plugin can write, in millimetres. */
export const PAGE_SIZES = {
  a4: { label: 'A4', width: 210, height: 297 },
  letter: { label: 'Letter', width: 215.9, height: 279.4 },
}

/** The default page: A4 portrait with 25.4 mm (one inch) margins. */
export function defaultPage() {
  return { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } }
}

/** Clamp one margin to a sane page range. */
function clampMargin(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(100, Math.max(0, Math.round(number * 10) / 10))
}

/**
 * Normalize a page description. An unknown size falls back to A4 (never to
 * `undefined`, which would emit a `.docx` with no `w:pgSz`), and orientation is
 * the only two values OOXML has.
 *
 * @param page - a partial page description.
 * @returns a complete, in-range page.
 */
export function normalizePage(page) {
  const source = page && typeof page === 'object' ? page : {}
  const size = Object.prototype.hasOwnProperty.call(PAGE_SIZES, source.size) ? source.size : 'a4'
  const orientation = source.orientation === 'landscape' ? 'landscape' : 'portrait'
  const defaults = defaultPage().margins
  const margins = source.margins && typeof source.margins === 'object' ? source.margins : {}
  return {
    size,
    orientation,
    margins: {
      top: clampMargin(margins.top, defaults.top),
      right: clampMargin(margins.right, defaults.right),
      bottom: clampMargin(margins.bottom, defaults.bottom),
      left: clampMargin(margins.left, defaults.left),
    },
  }
}

/**
 * The page's own dimensions in millimetres, with orientation applied - the one
 * place the portrait size is rotated, so the writer, the paginator and the
 * stylesheet cannot disagree about which way round Letter is.
 *
 * @param page - a page (normalized or not).
 * @returns `{ widthMm, heightMm }`.
 */
export function pageDimensions(page) {
  const normalized = normalizePage(page)
  const size = PAGE_SIZES[normalized.size]
  const portrait = { widthMm: size.width, heightMm: size.height }
  if (normalized.orientation !== 'landscape') return portrait
  return { widthMm: size.height, heightMm: size.width }
}

/** A block taller than its page still gets a page, and is marked. */
export const MAX_BLOCKS_PER_PAGE = 400
/** At most this many fragments one BLOCK may be broken into (a runaway guard). */
export const MAX_FRAGMENTS_PER_BLOCK = 400

/**
 * Break a block list into pages.
 *
 * A block that does not fit is broken at a LINE boundary and continues on the
 * next page - which is what "a new page when this one finishes" means for a text
 * editor, and the reason a paragraph is never left overflowing the bottom margin
 * while the next page sits empty. The line data comes from `measureLines`, which
 * only the browser can take; when it is absent or useless the fallback is the
 * older rule (move the whole block, mark it if it cannot fit anywhere), so a
 * host without a measurable font still lays out pages rather than dying.
 *
 * Each entry a page carries is a FRAGMENT of a block:
 *
 *   { index, from, to, topMm, heightMm, overflow, split }
 *
 * `from`/`to` are character offsets into that block's text, so the fragments of
 * one block tile it exactly: the first starts at 0, each continues where the one
 * before ended, and the last ends at the block's length. The renderer slices the
 * runs by `[from, to)` and the editor splices edits back by the same range, which
 * is why a paragraph can be edited across a page boundary without the model ever
 * holding a half paragraph.
 *
 * @param options - `{ blocks, page, measure, measureLines, footerMm }`.
 * @param options.blocks - the normalized blocks, in document order.
 * @param options.page - the page description (normalized inside).
 * @param options.measure - `(block, index) => number` in millimetres. A
 *   non-finite or negative answer is treated as zero rather than crashing the
 *   tab: a measurer that failed is a layout that is wrong, not a page that dies.
 * @param options.measureLines - `(block, index) => { heights, ends } | null`:
 *   the height of each rendered line in millimetres and the character offset at
 *   the END of each line. `ends` must increase and both arrays must be the same
 *   length; anything else is treated as no line data at all.
 * @param options.footerMm - space reserved at the bottom for a page number
 *   (default 0; the client reserves its own footer height).
 * @returns `{ pages, overflow, content }`.
 */
export function paginate({ blocks, page, measure, measureLines, footerMm = 0 } = {}) {
  const list = Array.isArray(blocks) ? blocks : []
  const { widthMm, heightMm } = pageDimensions(page)
  const margins = page && page.margins ? page.margins : { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 }
  const top = Number.isFinite(margins.top) ? margins.top : 25.4
  const bottom = Number.isFinite(margins.bottom) ? margins.bottom : 25.4
  const left = Number.isFinite(margins.left) ? margins.left : 25.4
  const right = Number.isFinite(margins.right) ? margins.right : 25.4
  const contentWidthMm = Math.max(10, widthMm - left - right)
  const usable = Math.max(10, heightMm - top - bottom - (Number.isFinite(footerMm) ? footerMm : 0))
  const measureBlock = typeof measure === 'function' ? measure : () => 0
  const measureBlockLines = typeof measureLines === 'function' ? measureLines : null
  const round = (value) => Math.round(value * 100) / 100
  /** Half a millimetre of slack, so a line that fits to the pixel is not pushed. */
  const EPS = 0.01

  const pages = []
  let current = null
  let y = 0
  let overflow = 0
  const startPage = () => {
    current = { index: pages.length, blocks: [] }
    pages.push(current)
    y = 0
  }
  const place = (index, from, to, heightMm, split) => {
    const over = heightMm > usable + EPS
    if (over) overflow += 1
    current.blocks.push({ index, from, to, topMm: round(top + y), heightMm: round(heightMm), overflow: over, split })
    y += heightMm
    if (current.blocks.length > MAX_BLOCKS_PER_PAGE) startPage()
  }
  /** Line data, validated: a measurer that answered nonsense is no measurer. */
  const linesOf = (block, index) => {
    if (measureBlockLines === null) return null
    let lines = null
    try {
      lines = measureBlockLines(block, index)
    } catch (err) {
      return null
    }
    if (!lines || !Array.isArray(lines.heights) || !Array.isArray(lines.ends)) return null
    if (lines.heights.length !== lines.ends.length || lines.heights.length < 1) return null
    for (let at = 0; at < lines.ends.length; at += 1) {
      if (!Number.isFinite(lines.ends[at]) || !Number.isFinite(lines.heights[at])) return null
      if (at > 0 && lines.ends[at] <= lines.ends[at - 1]) return null
    }
    return lines
  }

  for (let index = 0; index < list.length; index += 1) {
    const block = list[index]
    if (block && block.type === 'pageBreak') {
      // A break at the very top of a page is the break itself, not a blank page.
      if (current !== null && current.blocks.length > 0) startPage()
      continue
    }
    if (current === null) startPage()
    const raw = Number(measureBlock(block, index))
    const heightMm = Number.isFinite(raw) && raw > 0 ? raw : 0
    if (y + heightMm <= usable + EPS || (current.blocks.length === 0 && heightMm <= usable + EPS)) {
      place(index, 0, null, heightMm, false)
      continue
    }
    // It does not fit. With line data it continues on the next page; without it
    // the whole block moves (or, on a page with room for nothing, stays and is
    // marked).
    const lines = linesOf(block, index)
    if (lines === null || lines.heights.length <= 1) {
      if (current.blocks.length > 0 && heightMm <= usable + EPS) {
        startPage()
        place(index, 0, null, heightMm, false)
        continue
      }
      if (current.blocks.length > 0 && heightMm > usable + EPS) startPage()
      place(index, 0, null, heightMm, false)
      continue
    }
    let line = 0
    let guard = 0
    while (line < lines.heights.length && guard < MAX_FRAGMENTS_PER_BLOCK) {
      guard += 1
      if (current === null) startPage()
      let used = 0
      let fit = 0
      while (line + fit < lines.heights.length && y + used + lines.heights[line + fit] <= usable + EPS) {
        used += lines.heights[line + fit]
        fit += 1
      }
      if (fit === 0) {
        // Nothing fits here: a fresh page first, unless this page is already
        // fresh - in which case one line is taller than a whole page and it goes
        // where it is, marked.
        if (current.blocks.length > 0) {
          startPage()
          continue
        }
        const from = line === 0 ? 0 : lines.ends[line - 1]
        const to = lines.ends[line]
        place(index, from, to, lines.heights[line], true)
        line += 1
        if (line < lines.heights.length) startPage()
        continue
      }
      const from = line === 0 ? 0 : lines.ends[line - 1]
      const to = lines.ends[line + fit - 1]
      const whole = line === 0 && line + fit === lines.heights.length
      place(index, from, to, used, !whole)
      line += fit
      if (line < lines.heights.length) startPage()
    }
  }
  if (pages.length === 0) pages.push({ index: 0, blocks: [] })
  return {
    pages,
    overflow,
    content: {
      widthMm: round(contentWidthMm),
      heightMm: round(usable),
      marginsMm: { top, right, bottom, left },
    },
  }
}

/**
 * A measurer that needs no browser: one fixed height per block TYPE, with a
 * character-count term for prose. It exists for the two callers that have no
 * DOM - `check-writing-node.mjs` and the client's very first paint, before a
 * hidden box has been measured - and it is deliberately crude and visible in the
 * source rather than clever: a page break decided by a wrong height is a page
 * break the person will move by hand anyway.
 *
 * @param options - `{ lineMm, charMm, headingMm, codeLineMm }`.
 * @returns `(block) => number` in millimetres.
 */
export function estimateMeasure({ lineMm = 6.5, headingMm = 11, codeLineMm = 5, charsPerLine = 90 } = {}) {
  return (block) => {
    if (!block) return 0
    const text = Array.isArray(block.runs) ? block.runs.map((run) => run.text).join('') : ''
    // A soft break starts a line whether or not the first one is full, which is
    // why the count is per hard line and then wrapped.
    const lines = text
      .split('\n')
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
    if (block.type === 'heading') return headingMm * Math.max(1, lines)
    if (block.type === 'code') return codeLineMm * lines
    return lineMm * lines
  }
}
