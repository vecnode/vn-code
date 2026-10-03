/**
 * dsh-writing — the page document model (pure).
 *
 * One small vocabulary, and the pack's rule applies to it exactly as it does to
 * a Canvas design: what the model holds is what the person edits and what the
 * `.docx` writer emits, so nothing here may depend on a browser, a DOM or a
 * file. Everything in this file is a pure function of its arguments, which is
 * what lets `check-writing-node.mjs` drive the whole model with no harness.
 *
 * A document is:
 *
 *   { title, page: PAGE, blocks: BLOCK[], createdAt, updatedAt, revision, by }
 *
 *   BLOCK = { type, level?, ordered?, align?, runs: RUN[] }
 *   RUN   = { text, marks: MARK[] }
 *
 * `type` is one of {@link BLOCK_TYPES}. A LIST has `ordered` and a 0-based
 * `level`; a HEADING has `level` 1..6. `runs[].text` may contain `\n` (a soft
 * line break inside one paragraph - Writer's Shift+Enter) and `\t`. Marks are
 * the six inline attributes a `.docx` run can carry without a style table.
 *
 * Page geometry is MILLIMETRES throughout, because that is what `w:pgSz` and
 * `w:pgMar` are (twips are converted at the OOXML boundary, never here) and what
 * a person types into a margin field. A page is:
 *
 *   { size: 'a4'|'letter', orientation: 'portrait'|'landscape',
 *     margins: { top, right, bottom, left } }
 */
import { defaultPage, normalizePage, pageDimensions } from './page.js'

/**
 * The page geometry lives in `page.js` and is re-exported here, because that
 * file must have no imports (the browser half imports it from a blob URL) and
 * because a caller of the model should not have to know that.
 */
export { PAGE_SIZES, defaultPage, normalizePage, pageDimensions } from './page.js'

/** The block types, and the only ones the writer knows how to emit. */
export const BLOCK_TYPES = ['paragraph', 'heading', 'listItem', 'quote', 'code', 'pageBreak']
/** The inline marks, in the order the toolbar shows them. */
export const MARKS = ['b', 'i', 'u', 's', 'code']
/** At most this many blocks in one document. */
export const MAX_BLOCKS = 4000
/** At most this many characters in one block. */
export const MAX_BLOCK_CHARS = 20000
/** At most this many characters in one title. */
export const MAX_TITLE_CHARS = 120
/** One document's own budget, in bytes of UTF-8 source text. */
export const MAX_DOCUMENT_BYTES = 512 * 1024
/** At most this many characters in one font family name. */
export const MAX_FONT_CHARS = 128
/** The document's default size in points when it names none: Word's own default. */
export const DEFAULT_FONT_SIZE = 12
/** The smallest and largest run size a document may carry, in points. */
export const MIN_FONT_SIZE = 4
export const MAX_FONT_SIZE = 400
/** How a run may be marked, as the OOXML writer spells them. */
const MARK_SET = new Set(MARKS)
/** Heading levels the writer emits a style for. */
const MAX_HEADING_LEVEL = 6

/** Strip the characters a document may not carry, keeping tab and soft break. */
function cleanText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Normalize one run's marks: known marks only, in {@link MARKS} order, deduped. */
function normalizeMarks(marks) {
  const list = Array.isArray(marks) ? marks : []
  const wanted = new Set(list.filter((mark) => MARK_SET.has(mark)))
  return MARKS.filter((mark) => wanted.has(mark))
}

/**
 * A font family name, as the host's own font list spells it.
 *
 * The family is a STRING and not an id on purpose: `w:rFonts w:ascii` carries a
 * name, so a document written here opens on a machine that has that font, and
 * one that does not falls back the way Word's own fallback does. An empty string
 * means "the application's default", which is why it is dropped rather than
 * stored.
 *
 * @param value - the family name.
 * @returns the cleaned name, or `''`.
 */
export function normalizeFont(value) {
  const text = cleanText(value).replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_FONT_CHARS)
  return text
}

/**
 * A font size in POINTS, rounded to half a point - because half a point is the
 * unit `w:sz` carries (its value is half-points), and a size this model cannot
 * represent is a size the writer would silently round anyway.
 *
 * @param value - the size.
 * @param fallback - what to answer when the value is missing or unusable.
 * @returns the size in points.
 */
export function normalizeFontSize(value, fallback = DEFAULT_FONT_SIZE) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(number * 2) / 2))
}

/** The run properties `w:rFonts`/`w:sz` can carry, in one place: marks, font, size. */
function runProperties(raw, defaults) {
  const marks = normalizeMarks(raw ? raw.marks : null)
  const font = normalizeFont(raw ? raw.font : null)
  const size = raw && (raw.size !== undefined && raw.size !== null) ? normalizeFontSize(raw.size, defaults.fontSize) : null
  const properties = { marks }
  // A property equal to the DOCUMENT's default is left ABSENT: it changes
  // nothing on screen or in the file, and leaving it on every run would make a
  // document that was opened and saved without an edit stop being byte-stable.
  if (font.length > 0 && font !== defaults.font) properties.font = font
  if (size !== null && size !== defaults.fontSize) properties.size = size
  return properties
}

/** Whether two runs' properties are the same, so their text may merge. */
function sameProperties(left, right) {
  return (
    left.marks.join(',') === right.marks.join(',') &&
    (left.font ?? '') === (right.font ?? '') &&
    (left.size ?? null) === (right.size ?? null)
  )
}

/**
 * Normalize a block's runs: text cleaned, empty runs dropped, adjacent runs with
 * the SAME marks, font and size merged.
 *
 * The merge is not cosmetic. `<w:r>` elements are what a `.docx` carries, and
 * one per keystroke would make a 400-word page a hundred thousand bytes; more
 * importantly the reverse direction (read a `.docx`) produces exactly this shape,
 * so a document that was opened and saved without an edit is byte-stable.
 *
 * @param runs - the runs to normalize.
 * @param defaults - `{ font, fontSize }` of the owning document.
 * @returns the normalized runs (never fewer than one, possibly empty text).
 */
export function normalizeRuns(runs, defaults = defaultRunDefaults()) {
  const list = Array.isArray(runs) ? runs : []
  const out = []
  for (const raw of list) {
    const text = cleanText(raw && typeof raw.text === 'string' ? raw.text : '')
    if (text.length === 0) continue
    const properties = runProperties(raw, defaults)
    const last = out[out.length - 1]
    if (last && sameProperties(last, properties)) {
      last.text += text
      continue
    }
    out.push({ text, ...properties })
  }
  if (out.length === 0) out.push({ text: '', marks: [] })
  return out
}

/** The defaults a caller without a document gets: no family, {@link DEFAULT_FONT_SIZE}. */
function defaultRunDefaults() {
  return { font: '', fontSize: DEFAULT_FONT_SIZE }
}

/** A block's total character count (what a caret offset is measured in). */
export function blockLength(block) {
  return normalizeRuns(block ? block.runs : null).reduce((total, run) => total + run.text.length, 0)
}

/**
 * Normalize one block. An unknown `type` becomes a paragraph rather than
 * disappearing: a block that vanishes is a paragraph the person wrote and lost.
 *
 * @param block - a partial block.
 * @param defaults - `{ font, fontSize }` of the owning document.
 * @returns a complete block.
 */
export function normalizeBlock(block, defaults = defaultRunDefaults()) {
  const source = block && typeof block === 'object' ? block : {}
  const type = BLOCK_TYPES.includes(source.type) ? source.type : 'paragraph'
  const out = { type }
  if (type === 'heading') {
    const level = Number(source.level)
    out.level = Number.isFinite(level) ? Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.round(level))) : 1
  }
  if (type === 'listItem') {
    out.ordered = source.ordered === true
    const level = Number(source.level)
    out.level = Number.isFinite(level) ? Math.min(4, Math.max(0, Math.round(level))) : 0
  }
  if (source.align === 'center' || source.align === 'right' || source.align === 'justify') out.align = source.align
  out.runs = normalizeRuns(source.runs, defaults)
  return out
}

/**
 * Normalize a block list: every block normalized, a leading page break dropped,
 * consecutive page breaks collapsed, and a document with no blocks given one
 * empty paragraph (an empty page is still a page).
 *
 * @param blocks - the blocks to normalize.
 * @param defaults - `{ font, fontSize }` of the owning document.
 * @returns the normalized blocks, at most {@link MAX_BLOCKS}.
 */
export function normalizeBlocks(blocks, defaults = defaultRunDefaults()) {
  const list = Array.isArray(blocks) ? blocks : []
  const out = []
  for (const block of list) {
    const normalized = normalizeBlock(block, defaults)
    if (normalized.type === 'pageBreak' && (out.length === 0 || out[out.length - 1].type === 'pageBreak')) continue
    out.push(normalized)
    if (out.length >= MAX_BLOCKS) break
  }
  if (out.length === 0) out.push({ type: 'paragraph', runs: [{ text: '', marks: [] }] })
  return out
}

/** The document's plain text, one line per block (a page break is a blank line). */
export function documentText(doc) {
  const blocks = normalizeBlocks(doc ? doc.blocks : null, docDefaults(doc))
  return blocks
    .map((block) => (block.type === 'pageBreak' ? '' : block.runs.map((run) => run.text).join('')))
    .join('\n')
}

/**
 * The document's own run defaults: the family and size a run inherits when it
 * names neither.
 *
 * @param doc - a document (or anything at all).
 * @returns `{ font, fontSize }`.
 */
export function docDefaults(doc) {
  return {
    font: normalizeFont(doc ? doc.font : null),
    fontSize: normalizeFontSize(doc ? doc.fontSize : null),
  }
}

/** One block's plain text. */
export function blockText(block) {
  return normalizeRuns(block ? block.runs : null)
    .map((run) => run.text)
    .join('')
}

/** The document's word count (whitespace-delimited, like Writer's own counter). */
export function documentWords(doc) {
  const text = documentText(doc).trim()
  return text.length === 0 ? 0 : text.split(/\s+/).length
}

/**
 * The document's own facts, for the toolbars and the store's summaries.
 * @param doc - a document.
 * @returns `{ blocks, words, characters, pages: null }` (`pages` needs a
 *   measurer and is filled in by the browser half or by LibreOffice).
 */
export function documentStats(doc) {
  const blocks = normalizeBlocks(doc ? doc.blocks : null, docDefaults(doc))
  const text = documentText(doc)
  return { blocks: blocks.length, words: documentWords(doc), characters: text.length }
}

/** Inline one run's text as Markdown, marks included. */
function runToMarkdown(run) {
  let text = run.text
  if (text.length === 0) return ''
  // A backtick inside a code span would break the span; the model allows it, so
  // it is escaped rather than silently producing different Markdown.
  if (run.marks.includes('code')) text = '`' + text.replaceAll('`', '\\`') + '`'
  if (run.marks.includes('b')) text = '**' + text + '**'
  if (run.marks.includes('i')) text = '*' + text + '*'
  if (run.marks.includes('s')) text = '~~' + text + '~~'
  if (run.marks.includes('u')) text = '<u>' + text + '</u>'
  return text
}

/** One block's runs as Markdown. */
function blockInline(block) {
  return block.runs.map(runToMarkdown).join('')
}

/**
 * The document as Markdown - the format the pack's own editor and the shipped
 * preview already read, and the one export that needs no conversion engine.
 *
 * A page break has no Markdown spelling, so it becomes the HTML comment this
 * file's own reader turns back into one: the round trip is the model's, and
 * saying otherwise would be a lie in a file somebody diffed.
 *
 * @param doc - a document.
 * @returns Markdown text.
 */
export function documentMarkdown(doc) {
  const blocks = normalizeBlocks(doc ? doc.blocks : null, docDefaults(doc))
  const lines = []
  let fence = false
  for (const block of blocks) {
    if (block.type === 'code') {
      lines.push('```')
      lines.push(blockInline(block))
      lines.push('```')
      continue
    }
    if (fence) fence = false
    if (block.type === 'pageBreak') {
      lines.push('')
      lines.push('<!-- page-break -->')
      lines.push('')
      continue
    }
    if (block.type === 'heading') {
      lines.push('#'.repeat(block.level) + ' ' + blockInline(block))
      continue
    }
    if (block.type === 'quote') {
      lines.push('> ' + blockInline(block))
      continue
    }
    if (block.type === 'listItem') {
      const indent = '  '.repeat(block.level)
      lines.push(indent + (block.ordered ? '1. ' : '- ') + blockInline(block))
      continue
    }
    lines.push(blockInline(block))
  }
  return lines.join('\n') + '\n'
}

/** Split one line of Markdown into runs, honouring the inline marks this model has. */
function runsFromInline(text) {
  const runs = []
  let buffer = ''
  let index = 0
  const source = String(text ?? '')
  const push = (value, marks) => {
    if (value.length === 0) return
    runs.push({ text: value, marks })
  }
  const flush = () => {
    push(buffer, [])
    buffer = ''
  }
  while (index < source.length) {
    const rest = source.slice(index)
    // Longest token first, so `**` is never read as two `*`.
    const token = [
      ['**', 'b'],
      ['~~', 's'],
      ['<u>', 'u-open'],
      ['</u>', 'u-close'],
      ['`', 'code'],
    ].find(([needle]) => rest.startsWith(needle))
    if (token) {
      const [needle, mark] = token
      if (mark === 'u-open' || mark === 'u-close') {
        // Underline is the one mark with an HTML spelling; it is read by
        // scanning to its closing tag rather than by a token stack, because a
        // `<u>` may legally wrap other marks.
        flush()
        const close = mark === 'u-open' ? source.indexOf('</u>', index + 3) : -1
        if (mark === 'u-open' && close !== -1) {
          for (const inner of runsFromInline(source.slice(index + 3, close))) {
            runs.push({ text: inner.text, marks: inner.marks.concat('u') })
          }
          index = close + 4
          continue
        }
        index += needle.length
        continue
      }
      flush()
      if (mark === 'code') {
        const close = source.indexOf('`', index + 1)
        const body = close === -1 ? source.slice(index + 1) : source.slice(index + 1, close)
        push(body.replaceAll('\\`', '`'), ['code'])
        index = close === -1 ? source.length : close + 1
        continue
      }
      const close = source.indexOf(needle, index + needle.length)
      const body = close === -1 ? source.slice(index + needle.length) : source.slice(index + needle.length, close)
      for (const inner of runsFromInline(body)) push(inner.text, inner.marks.concat(mark))
      index = close === -1 ? source.length : close + needle.length
      continue
    }
    const italic = rest[0] === '*' || rest[0] === '_'
    if (italic) {
      flush()
      const close = source.indexOf(rest[0], index + 1)
      const body = close === -1 ? rest.slice(1) : source.slice(index + 1, close)
      for (const inner of runsFromInline(body)) push(inner.text, inner.marks.concat('i'))
      index = close === -1 ? source.length : close + 1
      continue
    }
    buffer += source[index]
    index += 1
  }
  flush()
  return runs.length > 0 ? runs : [{ text: '', marks: [] }]
}

/**
 * Blocks from plain text: one paragraph per line, no marks. Blank lines are kept
 * as empty paragraphs - a person's spacing is content, not noise.
 *
 * @param text - the text to read.
 * @returns blocks.
 */
export function blocksFromText(text) {
  const lines = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  return normalizeBlocks(lines.map((line) => ({ type: 'paragraph', runs: [{ text: line, marks: [] }] })))
}

/**
 * Blocks from Markdown: headings, lists, quotes, fenced code, the page-break
 * comment this plugin writes, and the inline marks above. A subset, named as
 * one - what it does not understand stays text, which is the whole point of
 * reading Markdown rather than rejecting it.
 *
 * @param markdown - the Markdown to read.
 * @returns blocks.
 */
export function blocksFromMarkdown(markdown) {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const blocks = []
  let fence = null
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence === null) {
        fence = []
        continue
      }
      blocks.push({ type: 'code', runs: normalizeRuns([{ text: fence.join('\n'), marks: [] }]) })
      fence = null
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    if (/^\s*<!--\s*page-break\s*-->\s*$/i.test(line)) {
      blocks.push({ type: 'pageBreak', runs: [{ text: '', marks: [] }] })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, runs: runsFromInline(heading[2]) })
      continue
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (list) {
      blocks.push({
        type: 'listItem',
        ordered: /\d/.test(list[2]),
        level: Math.min(4, Math.floor(list[1].replaceAll('\t', '  ').length / 2)),
        runs: runsFromInline(list[3]),
      })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      blocks.push({ type: 'quote', runs: runsFromInline(quote[1]) })
      continue
    }
    if (line.trim().length === 0) {
      // A blank line is a SEPARATOR, not an empty paragraph: it is what ends the
      // block before it. (Spacing between paragraphs is a property of the
      // document's styles, not something a run of blank lines should encode.)
      continue
    }
    blocks.push({ type: 'paragraph', runs: runsFromInline(line) })
  }
  if (fence !== null) blocks.push({ type: 'code', runs: normalizeRuns([{ text: fence.join('\n'), marks: [] }]) })
  return normalizeBlocks(blocks)
}

/**
 * A new, empty document. `id` is the store's business, so it is not set here:
 * this is the shape the store and the writer both take.
 *
 * @param options - `{ title, by, now, page, font, fontSize }`.
 * @returns a complete document without an id.
 */
export function createDocument({ title = 'Untitled', by = 'user', now = new Date().toISOString(), page = null, font = null, fontSize = null } = {}) {
  return {
    title: String(title).slice(0, MAX_TITLE_CHARS),
    page: normalizePage(page),
    font: normalizeFont(font),
    fontSize: normalizeFontSize(fontSize),
    blocks: [{ type: 'paragraph', runs: [{ text: '', marks: [] }] }],
    createdAt: now,
    updatedAt: now,
    revision: 1,
    by: by === 'model' ? 'model' : 'user',
  }
}

/**
 * Normalize an incoming document (from the route, the writer's reader or the
 * store) into the one shape everything else may assume.
 *
 * @param input - a partial document.
 * @param options - `{ existing, now, by }`; `existing` keeps `createdAt` and
 *   carries the revision forward instead of resetting it.
 * @returns a complete document.
 */
export function normalizeDocument(input, { existing = null, now = new Date().toISOString(), by = 'user' } = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const title = String(source.title ?? (existing ? existing.title : 'Untitled')).trim().slice(0, MAX_TITLE_CHARS)
  const font = source.font !== undefined ? source.font : existing ? existing.font : null
  const fontSize = source.fontSize !== undefined ? source.fontSize : existing ? existing.fontSize : null
  // The document's own defaults are settled FIRST, because every run's font and
  // size are compared against them (a run that says what the document already
  // says carries neither).
  const defaults = { font: normalizeFont(font), fontSize: normalizeFontSize(fontSize) }
  return {
    title: title.length > 0 ? title : 'Untitled',
    page: normalizePage(source.page ?? (existing ? existing.page : null)),
    ...defaults,
    blocks: normalizeBlocks(source.blocks ?? (existing ? existing.blocks : null), defaults),
    createdAt: existing ? existing.createdAt : typeof source.createdAt === 'string' ? source.createdAt : now,
    updatedAt: now,
    revision: (existing && Number.isFinite(existing.revision) ? existing.revision : 0) + 1,
    by: by === 'model' ? 'model' : 'user',
  }
}

/**
 * The document's source size in UTF-8 bytes, as the store's budget counts it.
 * @param doc - a document.
 * @returns the byte count.
 */
export function documentBytes(doc) {
  const defaults = docDefaults(doc)
  return Buffer.byteLength(
    JSON.stringify({ page: normalizePage(doc && doc.page), ...defaults, blocks: normalizeBlocks(doc && doc.blocks, defaults) }),
    'utf8',
  )
}

/** A loss report entry for one document feature this model cannot represent. */
export function lossEntry(kind, count, note) {
  return { kind, count, note }
}

/**
 * Merge loss reports, summing the counts of the same kind.
 * @param reports - loss arrays (or `null`).
 * @returns one loss array, in first-seen order.
 */
export function mergeLoss(...reports) {
  const order = []
  const byKind = new Map()
  for (const report of reports) {
    for (const entry of Array.isArray(report) ? report : []) {
      if (!entry || typeof entry.kind !== 'string') continue
      const existing = byKind.get(entry.kind)
      if (existing) {
        existing.count += Number.isFinite(entry.count) ? entry.count : 1
      } else {
        const fresh = { kind: entry.kind, count: Number.isFinite(entry.count) ? entry.count : 1, note: String(entry.note ?? '') }
        byKind.set(entry.kind, fresh)
        order.push(entry.kind)
      }
    }
  }
  return order.map((kind) => byKind.get(kind))
}

/** One sentence naming what a loss report means, for the tab's banner. */
export function describeLoss(loss) {
  const entries = Array.isArray(loss) ? loss : []
  if (entries.length === 0) return ''
  return entries.map((entry) => entry.count + ' ' + entry.kind + (entry.note ? ' (' + entry.note + ')' : '')).join(', ')
}
