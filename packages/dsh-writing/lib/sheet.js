/**
 * dsh-writing — the SHEET document: a workbook this plugin keeps, and the rules
 * that make one safe to store.
 *
 * `lib/xlsx.js` is the codec (the file format); this file is the DOCUMENT - the
 * shape the store holds, the caps it enforces and the facts its summary needs.
 * They are separate for the same reason `model.js` and `ooxml.js` are: one is
 * what a person edits, the other is what a file carries, and the store must be
 * able to hold a document that no file has been written from yet.
 *
 * A sheet document is:
 *
 *   { kind: 'sheet', title, sheets: SHEET[], createdAt, updatedAt, revision, by }
 *   SHEET = { name, rows: CELL[][] }        CELL = null | { value, formula? }
 *
 * WHICH DOCUMENT IS WHICH lives in `kind`, and it is written into every stored
 * document: the conversation's rail lists pages and workbooks together, and the
 * one field is what decides whether a tab opens the page editor or the grid.
 */
import { MAX_TITLE_CHARS, lossEntry, mergeLoss } from './model.js'
import { MAX_COLS, MAX_ROWS, readXlsx, writeXlsx } from './xlsx.js'

/** At most this many sheets in one workbook. */
export const MAX_SHEETS = 12
/** At most this many characters in one sheet's name (Excel's own limit). */
export const SHEET_NAME_CHARS = 31
/** At most this many characters in one cell's text. */
export const MAX_CELL_CHARS = 4096
/** One workbook's own budget, in bytes of JSON source. */
export const MAX_SHEET_BYTES = 512 * 1024

/** A typed failure the routes turn into a 4xx. */
function sheetError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * One sheet name, as Excel will accept it: trimmed, at most
 * {@link SHEET_NAME_CHARS} characters, with the characters a workbook forbids
 * (`: \ / ? * [ ]`) replaced rather than dropped - a name with a slash in it
 * should still be recognisable. Blank becomes `SheetN`, and a duplicate gets
 * `-2`, `-3`, because two sheets with one name is a file Excel refuses to open.
 *
 * @param name - the requested name.
 * @param index - the sheet's position (for the fallback).
 * @param taken - the names already used, lower-cased.
 * @returns the name to use.
 */
export function normalizeSheetName(name, index, taken) {
  const base = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:\\/?*[\]]/g, '-')
    .trim()
    .slice(0, SHEET_NAME_CHARS)
  const stem = base.length > 0 ? base : 'Sheet' + (index + 1)
  let candidate = stem
  for (let attempt = 2; taken.has(candidate.toLowerCase()) && attempt < 1000; attempt += 1) {
    candidate = (stem + '-' + attempt).slice(0, SHEET_NAME_CHARS)
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/** One cell, normalized: an empty cell is `null` and nothing else. */
function normalizeCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell
  if (typeof cell === 'boolean') return cell
  if (typeof cell === 'object') {
    const formula = typeof cell.formula === 'string' ? cell.formula.replace(/^=/, '').trim().slice(0, MAX_CELL_CHARS) : ''
    const value = typeof cell.value === 'string' ? cell.value.slice(0, MAX_CELL_CHARS) : Number.isFinite(cell.value) || typeof cell.value === 'boolean' ? cell.value : ''
    if (formula.length === 0 && value === '') return null
    return formula.length > 0 ? { value, formula } : value
  }
  const text = String(cell).slice(0, MAX_CELL_CHARS)
  return text.length === 0 ? null : text
}

/**
 * Normalize a workbook's sheets: the caps applied at the WRITE, the names made
 * legal, ragged rows padded to the widest so `rows[r][c]` is always defined, and
 * a workbook with no sheets given one empty one (a workbook with no sheets is a
 * file Excel refuses to open).
 *
 * @param sheets - the sheets to normalize.
 * @returns the normalized sheets.
 */
export function normalizeSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : []
  const taken = new Set()
  const out = []
  for (const [index, sheet] of list.slice(0, MAX_SHEETS).entries()) {
    const source = sheet && typeof sheet === 'object' ? sheet : {}
    const rows = []
    const sourceRows = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : []
    for (const row of sourceRows) {
      const cells = Array.isArray(row) ? row.slice(0, MAX_COLS).map(normalizeCell) : []
      rows.push(cells)
    }
    // Rectangular, because the grid draws a table: a shorter row must not make
    // the cell under it a different address than the one that was saved.
    const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
    for (const row of rows) {
      while (row.length < width) row.push(null)
    }
    if (rows.length === 0) rows.push([])
    out.push({ name: normalizeSheetName(source.name, index, taken), rows })
  }
  if (out.length === 0) out.push({ name: 'Sheet1', rows: [[]] })
  return out
}

/**
 * A new, empty workbook: one sheet, one row, one column - the smallest grid a
 * person can type in (a zero-cell grid has nowhere to put the caret).
 *
 * @param title - the document's title.
 * @returns a sheet document without an id.
 */
export function createSheetDocument(title = 'Untitled') {
  return { kind: 'sheet', title: String(title).slice(0, MAX_TITLE_CHARS), sheets: [{ name: 'Sheet1', rows: [[null]] }] }
}

/**
 * Normalize an incoming sheet document (from a route, a file, or the store).
 *
 * @param input - a partial document.
 * @param options - `{ existing, now, by }`.
 * @returns a complete sheet document.
 */
export function normalizeSheetDocument(input, { existing = null, now = new Date().toISOString(), by = 'user' } = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const title = String(source.title ?? (existing ? existing.title : 'Untitled')).trim().slice(0, MAX_TITLE_CHARS)
  return {
    kind: 'sheet',
    title: title.length > 0 ? title : 'Untitled',
    sheets: normalizeSheets(source.sheets ?? (existing ? existing.sheets : null)),
    createdAt: existing ? existing.createdAt : typeof source.createdAt === 'string' ? source.createdAt : now,
    updatedAt: now,
    revision: (existing && Number.isFinite(existing.revision) ? existing.revision : 0) + 1,
    by: by === 'model' ? 'model' : 'user',
  }
}

/** One workbook's source size in UTF-8 bytes, as the store's budget counts it. */
export function sheetBytes(doc) {
  return Buffer.byteLength(JSON.stringify({ sheets: normalizeSheets(doc && doc.sheets) }), 'utf8')
}

/**
 * The workbook's own facts, for the rail and the status bar.
 * @param doc - a sheet document.
 * @returns `{ sheets, blocks, words, characters, filled }` - `blocks` is kept so
 *   one summary shape serves both document kinds.
 */
export function sheetStats(doc) {
  const sheets = normalizeSheets(doc && doc.sheets)
  let filled = 0
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (cell !== null) filled += 1
      }
    }
  }
  return { sheets: sheets.length, blocks: sheets.length, words: filled, characters: 0, filled }
}

/**
 * One cell in the CODEC's shape, which is `null | { value, formula? }`.
 *
 * This document keeps a cell as a bare scalar when it is plain (`12`, `'North'`,
 * `true`) and only makes it an object when it carries a formula - because that is
 * the compact JSON a store wants - while `lib/xlsx.js` speaks one shape for every
 * cell. The two meet HERE and nowhere else, which is why a change to either side
 * cannot silently drop a cell again: this is the only place that knows both.
 *
 * @param cell - a stored cell.
 * @returns the codec's cell.
 */
export function toCodecCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'object') {
    const value = cell.value === undefined || cell.value === null ? '' : cell.value
    return cell.formula ? { value, formula: cell.formula } : { value }
  }
  return { value: cell }
}

/**
 * One cell back in this document's shape: a bare scalar unless it carries a
 * formula.
 * @param cell - the codec's cell.
 * @returns the stored cell.
 */
export function fromCodecCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'object') {
    const value = cell.value === undefined || cell.value === null ? '' : cell.value
    return cell.formula ? { value, formula: cell.formula } : value
  }
  return cell
}

/**
 * A `.xlsx` as a sheet document, plus what the reader could not hold.
 * @param bytes - the file's bytes.
 * @returns `{ document, loss, meta }`.
 */
export function readSheetFile(bytes) {
  const read = readXlsx(bytes)
  const workbook = read.workbook && Array.isArray(read.workbook.sheets) ? read.workbook : { sheets: [] }
  const title = workbook.title
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    rows: (Array.isArray(sheet.rows) ? sheet.rows : []).map((row) => (Array.isArray(row) ? row.map(fromCodecCell) : [])),
  }))
  return {
    document: { kind: 'sheet', title: typeof title === 'string' && title.length > 0 ? title.slice(0, MAX_TITLE_CHARS) : 'Untitled', sheets: normalizeSheets(sheets) },
    loss: read.loss,
    meta: { sheets: sheets.length },
  }
}

/**
 * One sheet document as `.xlsx` bytes.
 * @param doc - a sheet document.
 * @param options - `{ title, now }`.
 * @returns the file's bytes.
 */
export function writeSheetFile(doc, { title = null, now = new Date() } = {}) {
  const name = String(title ?? (doc && doc.title) ?? 'Workbook').slice(0, MAX_TITLE_CHARS)
  const sheets = normalizeSheets(doc && doc.sheets).map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.map((row) => row.map(toCodecCell)),
  }))
  return writeXlsx({ sheets }, { title: name, now })
}

/** Both document kinds' loss vocabularies, in one place. */
export function mergeSheetLoss(...reports) {
  return mergeLoss(...reports)
}

/** A loss entry for one workbook feature this tab cannot represent. */
export function sheetLoss(kind, count, note) {
  return lossEntry(kind, count, note)
}

/**
 * The workbook as plain text: one line per sheet, tab-separated cells. This is
 * the same shape `documentText` gives a page, so an export menu can offer "text"
 * for either kind without a second vocabulary.
 *
 * @param doc - a sheet document.
 * @returns the text.
 */
export function sheetText(doc) {
  const lines = []
  for (const sheet of normalizeSheets(doc && doc.sheets)) {
    lines.push('# ' + sheet.name)
    for (const row of sheet.rows) {
      lines.push(row.map((cell) => (cell === null ? '' : cellText(cell))).join('\t'))
    }
  }
  return lines.join('\n') + '\n'
}

/** One cell as the text a person would have typed. */
export function cellText(cell) {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'object') return cell.formula ? '=' + cell.formula : String(cell.value ?? '')
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  return String(cell)
}

/** The guard the routes use before they touch a workbook they were handed. */
export function assertSheetBudget(doc) {
  const bytes = sheetBytes(doc)
  if (bytes > MAX_SHEET_BYTES) {
    throw sheetError('TOO_LARGE', 'The workbook is larger than the ' + Math.round(MAX_SHEET_BYTES / 1024) + ' KiB per-document limit.')
  }
  return bytes
}
