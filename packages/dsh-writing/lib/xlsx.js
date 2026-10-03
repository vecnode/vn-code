/**
 * dsh-writing — the `.xlsx` codec: a plain grid out, and a real workbook back in.
 *
 * The Sheet tab edits a grid of values, and this is the half of it that talks to
 * the rest of the world. It is written against the format rather than against a
 * library, for the same two reasons `ooxml.js` is: the pack ships **zero npm
 * dependencies**, and a workbook's container is small enough to own — a ZIP of
 * XML parts ({@link module:dsh-writing/lib/zip.js} and
 * {@link module:dsh-writing/lib/xml.js} beside this file).
 *
 * WHY THIS AND NOT A RENDERER. A `.xlsx` is what LibreOffice, Excel and —
 * through `@deepseek-ai/libreoffice-kit` — the harness itself already read: the
 * shipped office preview converts a workbook to PDF with the bundled LibreOffice
 * and paints that. So this codec's output is not judged by this file's opinion of
 * itself: the check writes a grid, hands the bytes to LibreOffice and asserts
 * that it loads and converts. A part that is malformed, mis-typed or mis-escaped
 * fails there.
 *
 * THE ONE THING A SPREADSHEET CANNOT DO WITHOUT. A formula cell is written with
 * NO cached value, because this codec does not evaluate formulas and a stale
 * cached value would be painted as if it were the answer. `<calcPr
 * fullCalcOnLoad="1"/>` in the workbook part is therefore load-bearing: it is what
 * makes the application calculate the grid when the file is opened, and nothing
 * else in the file asks for it.
 *
 * WHAT THE READER DOES WITH WHAT IT DOES NOT UNDERSTAND: it COUNTS it, in the
 * same loss vocabulary the `.docx` reader uses (declared in `model.js`, so a tab
 * shows one banner for both). Charts, images, merged cells, number formats,
 * defined names, pivot tables, comments, hidden sheets and anything else it
 * walked past become one entry each — silently discarding a quarter of somebody's
 * workbook is the one failure mode worth this extra code.
 */
import { describeLoss, lossEntry, mergeLoss } from './model.js'
import { zipSync, unzipSync } from './zip.js'
import { attrOf, childrenNamed, escapeAttr, escapeXml, firstChild, parseXml, textContent } from './xml.js'

/** The spreadsheet namespace every part this codec writes lives in. */
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
/** The relationship namespace, which is what `r:id` on a sheet resolves through. */
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** The base every officeDocument relationship type is built from. */
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
/** The package relationship namespace, for the two property parts. */
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
/** At most this many rows are read from one sheet. */
export const MAX_ROWS = 200
/** At most this many columns are read from one sheet: A..BZ. */
export const MAX_COLS = 78
/** At most this many characters in a sheet name — Excel's own limit, and it refuses the file over it. */
const MAX_SHEET_NAME_CHARS = 31
/** The seven characters Excel forbids in a sheet name; each becomes `-`. */
const FORBIDDEN_IN_SHEET_NAME = /[:\\/?*\[\]]/g

/**
 * One sentence per loss kind, in the voice `ooxml.js` uses. They live in one
 * table rather than at each call site because the same kind is counted from
 * several places (a chart is a `<drawing>` in a sheet and a part under
 * `xl/charts/`) and the report must say the same thing either way.
 */
const LOSS_NOTES = {
  chart: 'saving this workbook would drop its charts',
  image: 'saving this workbook would drop its images',
  'merged-cell': 'saving this workbook would drop its merged cells',
  format: 'saving this workbook would drop its number formats, cell styles, conditional formatting and data validation',
  formatting: 'saving this workbook would flatten its rich text to plain text',
  'defined-name': 'saving this workbook would drop its defined names',
  pivot: 'saving this workbook would drop its pivot tables',
  comment: 'saving this workbook would drop its comments',
  'hidden-sheet': 'saving this workbook would show its sheets that were hidden',
  'too-large': 'the sheet is larger than this tab holds; the rest was not read',
  other: 'an element this tab does not read was skipped',
}

/** The package relationships: the workbook part and the two property parts. */
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' +
  PKG_RELS +
  '"><Relationship Id="rId1" Type="' +
  REL_BASE +
  'officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="' +
  REL_BASE +
  'extended-properties" Target="docProps/app.xml"/></Relationships>'

/**
 * The style table, at the size a reader accepts and not one element more: one
 * font, the two fills the format REQUIRES (`none` and `gray125` — a reader
 * rejects a fill list without them), one border, one cell style, one cell format
 * and the `Normal` cell style that names it. No number format, no colour and no
 * font name is invented, because a grid of plain values has none to declare and a
 * guessed one would be a lie about the file.
 */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="' +
  MAIN_NS +
  '"><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

/** Add one loss entry, or add to the count of a kind already reported. */
function count(loss, kind, amount = 1) {
  if (amount <= 0) return
  const existing = loss.find((entry) => entry.kind === kind)
  if (existing) existing.count += amount
  else loss.push(lossEntry(kind, amount, LOSS_NOTES[kind] ?? ''))
}

/**
 * One increment per element under the single `other` kind: a `pageMargins` here
 * and an `extLst` there are one line of the report, not two, but each element
 * that was skipped is still one more thing a save would lose.
 */
function countUnknown(node, loss) {
  count(loss, 'other')
  for (const child of node.children) if (typeof child !== 'string') countUnknown(child, loss)
}

/** The root element of a parsed part, or null. */
function rootElement(tree) {
  for (const child of tree.children) if (typeof child !== 'string') return child
  return null
}

/**
 * The column letters for a 0-based column index: A, B, … Z, AA, … — the address
 * form a cell's `r` carries, and it has to keep going past Z, because that
 * attribute is the only thing that says which column a value belongs to.
 */
function columnLetters(index) {
  let value = index + 1
  let out = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    out = String.fromCharCode(65 + remainder) + out
    value = Math.floor((value - 1) / 26)
  }
  return out
}

/**
 * One cell as XML, or an empty string when the cell is empty.
 *
 * `null`, `''` and `undefined` all mean the same thing — no cell — and it is
 * OMITTED rather than written as an empty `<c>`: a 60x26 grid of empty elements
 * is a file nobody should have to parse, and every reader treats the two
 * spellings identically. `xml:space="preserve"` is on every `t` because a cell's
 * leading or trailing space is content a person typed.
 *
 * A FORMULA cell carries no `<v>` even when the grid holds a value for it: the
 * cached value this codec could write is the one it read, and a formula the
 * application has not recalculated must not be presented as an answer.
 *
 * @param ref - the cell's address, e.g. `B7`.
 * @param cell - the cell (`{ value, formula }`), or null.
 * @returns the `c` element, or `''`.
 */
function cellXml(ref, cell) {
  const source = cell ?? {}
  const formula = String(source.formula ?? '').trim().replace(/^=/, '')
  if (formula.length > 0) return '<c r="' + ref + '"><f>' + escapeXml(formula) + '</f></c>'
  const value = source.value
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '"><v>' + String(value) + '</v></c>'
  if (typeof value === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (value ? '1' : '0') + '</v></c>'
  // A non-finite number has no numeric spelling in the format, so it is written
  // as the text it prints as rather than dropped or written as `<v>NaN</v>`.
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>'
}

/** One sheet's `sheetData`, with `<row r="1">` numbering and empty rows omitted. */
function sheetDataXml(rows) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  list.forEach((row, rowIndex) => {
    const cells = []
    const source = Array.isArray(row) ? row : []
    source.forEach((cell, columnIndex) => {
      const xml = cellXml(columnLetters(columnIndex) + (rowIndex + 1), cell)
      if (xml.length > 0) cells.push(xml)
    })
    if (cells.length > 0) out.push('<row r="' + (rowIndex + 1) + '">' + cells.join('') + '</row>')
  })
  return out.join('')
}

/** One worksheet part. */
function worksheetXml(rows) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="' +
    MAIN_NS +
    '"><sheetData>' +
    sheetDataXml(rows) +
    '</sheetData></worksheet>'
  )
}

/**
 * One sheet name per sheet, legal for Excel: trimmed, at most 31 characters, the
 * seven characters Excel forbids replaced by `-`, a blank name given `SheetN`, and
 * a DUPLICATE given `-2`, `-3`, … A workbook with two sheets called `Data` is a
 * file Excel refuses to open at all, so a collision is repaired here rather than
 * handed to the application as a corrupted file.
 *
 * @param sheets - the workbook's sheets, in order.
 * @returns the legal names, in the same order.
 */
function sheetNames(sheets) {
  const used = new Set()
  return sheets.map((sheet, index) => {
    const cleaned = String((sheet && sheet.name) ?? '').trim().replace(FORBIDDEN_IN_SHEET_NAME, '-').slice(0, MAX_SHEET_NAME_CHARS)
    const base = cleaned.length > 0 ? cleaned : 'Sheet' + (index + 1)
    let name = base
    let suffix = 2
    while (used.has(name.toLowerCase())) {
      const tail = '-' + suffix
      name = base.slice(0, MAX_SHEET_NAME_CHARS - tail.length) + tail
      suffix += 1
    }
    used.add(name.toLowerCase())
    return name
  })
}

/** The workbook part: its sheet list, and the calculation the formula cells need. */
function workbookXml(names) {
  const sheets = names
    .map((name, index) => '<sheet name="' + escapeAttr(name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>')
    .join('')
  // `fullCalcOnLoad` is what makes the application compute the formula cells this
  // writer emitted with no cached value. Without it they are blank on open.
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="' +
    MAIN_NS +
    '" xmlns:r="' +
    R_NS +
    '"><sheets>' +
    sheets +
    '</sheets><calcPr fullCalcOnLoad="1"/></workbook>'
  )
}

/** The workbook part's relationships: one per sheet, then its style table. */
function workbookRelsXml(sheetCount) {
  const rels = []
  for (let index = 0; index < sheetCount; index += 1) {
    rels.push(
      '<Relationship Id="rId' + (index + 1) + '" Type="' + REL_BASE + 'worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>',
    )
  }
  rels.push('<Relationship Id="rId' + (sheetCount + 1) + '" Type="' + REL_BASE + 'styles" Target="styles.xml"/>')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + PKG_RELS + '">' + rels.join('') + '</Relationships>'
}

/** The content types: an Override per worksheet, because the extension is `.xml` and defaults to `application/xml`. */
function contentTypesXml(sheetCount) {
  let overrides = ''
  for (let index = 0; index < sheetCount; index += 1) {
    overrides +=
      '<Override PartName="/xl/worksheets/sheet' +
      (index + 1) +
      '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    overrides +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
  )
}

/** The core properties, so a workbook carries the title it was written under. */
function coreXml(title, now) {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' +
    escapeXml(title) +
    '</dc:title><dc:creator>dsh-writing</dc:creator><cp:lastModifiedBy>dsh-writing</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' +
    stamp +
    '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' +
    stamp +
    '</dcterms:modified></cp:coreProperties>'
  )
}

/** The extended properties: the application that wrote the file. */
const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>dsh-writing</Application><AppVersion>1.0</AppVersion></Properties>'

/**
 * Write one workbook as `.xlsx` bytes.
 *
 * The parts written, and no others: `[Content_Types].xml`, `_rels/.rels`, the two
 * `docProps` parts, `xl/workbook.xml` with its rels, `xl/styles.xml` and one
 * `xl/worksheets/sheetN.xml` per sheet. A part nobody reads is a part that can be
 * wrong.
 *
 * @param workbook - `{ sheets: [{ name, rows }] }`. An empty or missing sheet list
 *   writes ONE empty sheet named `Sheet1`, because a workbook with no sheets is a
 *   file no application opens.
 * @param options - `{ now, title }`: the timestamp the parts and the ZIP entries
 *   carry, and the core property title (default `Workbook`).
 * @returns the file's bytes.
 */
export function writeXlsx(workbook, { now = new Date(), title = null } = {}) {
  const sheets =
    Array.isArray(workbook && workbook.sheets) && workbook.sheets.length > 0 ? workbook.sheets : [{ name: 'Sheet1', rows: [] }]
  const names = sheetNames(sheets)
  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml(sheets.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'docProps/core.xml', data: coreXml(String(title ?? 'Workbook'), now) },
    { name: 'docProps/app.xml', data: APP_XML },
    { name: 'xl/workbook.xml', data: workbookXml(names) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(sheets.length) },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ]
  sheets.forEach((sheet, index) => {
    files.push({ name: 'xl/worksheets/sheet' + (index + 1) + '.xml', data: worksheetXml(sheet && sheet.rows) })
  })
  return zipSync(files, { date: now })
}

/** A typed failure the routes turn into a 4xx. */
export function xlsxError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Read a `.xlsx` into a workbook.
 *
 * @param bytes - the file's bytes.
 * @returns `{ workbook, loss }`: `{ sheets: [{ name, rows }] }` in workbook order,
 *   and the loss report for everything the grid could not hold.
 * @throws a typed error (`NOT_A_ZIP`, `NO_WORKBOOK_PART`, `BAD_XML`, `NO_SHEETS`)
 *   when the bytes are not a spreadsheet.
 */
export function readXlsx(bytes) {
  let parts
  try {
    parts = unzipSync(bytes)
  } catch (err) {
    throw xlsxError('NOT_A_ZIP', 'This file is not a spreadsheet (it is not a ZIP archive): ' + err.message)
  }
  const workbookPart = parts.get('xl/workbook.xml')
  if (!workbookPart) {
    throw xlsxError('NO_WORKBOOK_PART', 'This ZIP has no xl/workbook.xml, so it is not a spreadsheet.')
  }
  let tree
  try {
    tree = parseXml(workbookPart.toString('utf8'))
  } catch (err) {
    throw xlsxError('BAD_XML', 'The workbook part could not be read: ' + err.message)
  }
  const loss = []
  const root = rootElement(tree)
  const listed = childrenNamed(firstChild(root, 'sheets'), 'sheet')
  for (const entry of listed) {
    // `veryHidden` is hidden too, and the grid has nowhere to keep either state.
    if (String(attrOf(entry, 'state') ?? 'visible') !== 'visible') count(loss, 'hidden-sheet')
  }
  count(loss, 'defined-name', childrenNamed(firstChild(root, 'definedNames'), 'definedName').length)

  // The sheet list first, then the worksheet parts as a fallback: the relationship
  // table is metadata, and a file whose rels are missing or point nowhere is still
  // a readable workbook. It must not be refused over a table nobody needs.
  const rels = readWorkbookRels(parts)
  const worksheets = [...parts.keys()].filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)).sort()
  const used = new Set()
  const sheets = listed.map((entry, index) => {
    const id = attrOf(entry, 'r:id')
    const target = id === undefined ? undefined : rels.get(String(id))
    const name = String(attrOf(entry, 'name') ?? '').trim()
    const sheet = { name: name.length > 0 ? name : 'Sheet' + (index + 1), path: null }
    if (target !== undefined && parts.has(target) && !used.has(target)) {
      used.add(target)
      sheet.path = target
    }
    return sheet
  })
  const unclaimed = worksheets.filter((name) => !used.has(name))
  for (const sheet of sheets) {
    if (sheet.path !== null) continue
    const next = unclaimed.shift()
    if (next !== undefined) sheet.path = next
  }
  let readable = sheets.filter((sheet) => sheet.path !== null)
  if (readable.length === 0) {
    // Nothing named a sheet that exists: every worksheet part is a sheet, in name
    // order, which is the same answer the relationship table would have given.
    readable = worksheets.map((path, index) => ({ name: 'Sheet' + (index + 1), path }))
  }
  if (readable.length === 0) throw xlsxError('NO_SHEETS', 'This workbook has no worksheets.')

  const shared = readSharedStrings(parts.get('xl/sharedStrings.xml'))
  countPackageLoss(parts, loss)
  countStyleLoss(parts.get('xl/styles.xml'), loss)
  const workbook = {
    sheets: readable.map((sheet) => ({ name: sheet.name, rows: readWorksheet(parts.get(sheet.path), shared, loss) })),
  }
  return { workbook, loss: mergeLoss(loss) }
}

/**
 * The workbook's relationship targets by id, resolved to part paths. Only a
 * `/worksheet` relationship names a sheet: styles, theme and shared strings are
 * relationships in the same table, and reading one as a sheet would add an empty
 * grid nobody asked for.
 */
function readWorkbookRels(parts) {
  const targets = new Map()
  const part = parts.get('xl/_rels/workbook.xml.rels')
  if (!part) return targets
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    return targets
  }
  for (const rel of childrenNamed(rootElement(tree), 'Relationship')) {
    const id = attrOf(rel, 'Id')
    const target = attrOf(rel, 'Target')
    if (id === undefined || target === undefined) continue
    const type = String(attrOf(rel, 'Type') ?? '')
    if (type.length > 0 && !type.endsWith('/worksheet')) continue
    const raw = String(target)
    targets.set(String(id), raw.startsWith('/') ? raw.slice(1) : 'xl/' + raw.replace(/^\.\//, ''))
  }
  return targets
}

/**
 * The whole workbook's shared string table, one `{ text, rich }` per `<si>`. A
 * shared string is either a plain `<t>` or a set of rich-text `<r>` runs; the runs
 * are CONCATENATED because a grid holds a value, and `rich` is what makes the cell
 * that reads it report the styling as a loss.
 */
function readSharedStrings(part) {
  const table = []
  if (!part) return table
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    throw xlsxError('BAD_XML', 'The shared string table could not be read: ' + err.message)
  }
  for (const item of childrenNamed(rootElement(tree), 'si')) table.push(readTextRuns(item))
  return table
}

/**
 * The text of a string item (`si` or `is`).
 *
 * `rPh` is a phonetic HINT for a reader that speaks the language, not part of the
 * value, so it is skipped rather than concatenated into the text.
 *
 * @param node - the `si` or `is` element, or null.
 * @returns `{ text, rich }` — the concatenated text, and whether it came as runs.
 */
function readTextRuns(node) {
  const chunks = []
  let rich = false
  if (node) {
    for (const child of node.children) {
      if (typeof child === 'string') continue
      if (child.local === 't') chunks.push(textContent(child))
      else if (child.local === 'r') {
        rich = true
        for (const text of childrenNamed(child, 't')) chunks.push(textContent(text))
      }
    }
  }
  return { text: chunks.join(''), rich }
}

/** A cell address as `{ row, column }` (1-based row, 0-based column), or null. */
function cellAddress(value) {
  if (value === undefined || value === null) return null
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(value))
  if (!match) return null
  const letters = match[1].toUpperCase()
  let column = 0
  for (let index = 0; index < letters.length; index += 1) column = column * 26 + (letters.charCodeAt(index) - 64)
  const row = Number(match[2])
  if (row < 1) return null
  return { row, column: column - 1 }
}

/**
 * One `c` as a cell, or null when it holds nothing.
 *
 * An empty cell is NULL and not `''`: the writer omits exactly that cell, so read
 * and write agree on what empty means and a round trip is stable.
 *
 * The types, one each: `s` is an index into the shared string table, `inlineStr`
 * is the text in the cell, `str` is a formula's cached string result, `b` is
 * `1`/`0`, `e` is an error such as `#DIV/0!` — which is a VALUE a person sees and
 * therefore not a loss — and NO `t` at all is a number, where `0` is the number
 * zero and neither an empty string nor an empty cell.
 *
 * @param node - the `c` element.
 * @param shared - the shared string table.
 * @param loss - the loss report, appended to.
 * @returns the cell, or null.
 */
function readCell(node, shared, loss) {
  const type = String(attrOf(node, 't') ?? '')
  let valueNode = null
  let formulaNode = null
  let inlineNode = null
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (child.local === 'v') valueNode = child
    else if (child.local === 'f') formulaNode = child
    else if (child.local === 'is') inlineNode = child
    else countUnknown(child, loss)
  }
  const formula = formulaNode === null ? '' : textContent(formulaNode).trim().replace(/^=/, '')
  const raw = valueNode === null ? null : textContent(valueNode)
  let value
  switch (type) {
    case 's': {
      const item = raw === null ? undefined : shared[Number(raw)]
      if (item === undefined) {
        // A shared-string index past the end of the table is a broken part, not an
        // empty cell: the text is gone, and saying so is the point of the report.
        if (raw !== null) count(loss, 'other')
        value = ''
      } else {
        // Rich text is reported where it is USED: a save would drop the styling of
        // the cells this grid holds, not of table entries nobody read.
        if (item.rich) count(loss, 'formatting')
        value = item.text
      }
      break
    }
    case 'inlineStr': {
      const read = readTextRuns(inlineNode)
      if (read.rich) count(loss, 'formatting')
      value = read.text
      break
    }
    case 'str':
      value = raw === null ? undefined : raw
      break
    case 'b':
      value = raw === null ? undefined : raw === '1'
      break
    case 'e':
      value = raw === null ? undefined : raw
      break
    default: {
      if (raw === null || raw.length === 0) break
      const number = Number(raw)
      value = Number.isFinite(number) ? number : raw
      break
    }
  }
  if (formula.length > 0) return { value: value === undefined || value === '' ? '' : value, formula }
  if (value === undefined || value === '') return null
  return { value }
}

/**
 * One worksheet part as a rectangular grid.
 *
 * The grid is built at the FULL size and trimmed afterwards, which is what makes
 * every row the same length and every `rows[r][c]` defined: the width is the widest
 * populated row, and a short row is padded with nulls rather than left ragged.
 *
 * @param part - the worksheet part's bytes.
 * @param shared - the shared string table.
 * @param loss - the loss report, appended to.
 * @returns `rows[r][c]`.
 */
function readWorksheet(part, shared, loss) {
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    throw xlsxError('BAD_XML', 'A worksheet part could not be read: ' + err.message)
  }
  const root = rootElement(tree)
  const grid = Array.from({ length: MAX_ROWS }, () => new Array(MAX_COLS).fill(null))
  // Sets, not counters: a cell that carries its own `r` can name a row or column
  // the row element does not, and one row beyond the cap must count once.
  const droppedRows = new Set()
  const droppedColumns = new Set()
  let lastRow = -1
  let lastColumn = -1
  if (root) {
    for (const child of root.children) {
      if (typeof child === 'string') continue
      switch (child.local) {
        case 'sheetData': {
          let rowNumber = 0
          for (const rowNode of childrenNamed(child, 'row')) {
            const declared = Number(attrOf(rowNode, 'r'))
            rowNumber = Number.isInteger(declared) && declared > 0 ? declared : rowNumber + 1
            let column = -1
            for (const cellNode of childrenNamed(rowNode, 'c')) {
              // The address on the CELL is the more specific statement of where a
              // value lives; without it the column continues left to right from the
              // row's own number, so a file that omits `r` cannot shift the row.
              const address = cellAddress(attrOf(cellNode, 'r'))
              const atRow = address === null ? rowNumber : address.row
              const atColumn = address === null ? column + 1 : address.column
              column = atColumn
              if (atRow > MAX_ROWS) {
                droppedRows.add(atRow)
                continue
              }
              if (atColumn >= MAX_COLS) {
                droppedColumns.add(atColumn)
                continue
              }
              const cell = readCell(cellNode, shared, loss)
              if (cell === null) continue
              grid[atRow - 1][atColumn] = cell
              if (atRow - 1 > lastRow) lastRow = atRow - 1
              if (atColumn > lastColumn) lastColumn = atColumn
            }
          }
          break
        }
        // The features a grid cannot hold are counted ONCE at their container:
        // their children are the same feature, not more of it, and a merged range
        // counted twice would inflate the report.
        case 'mergeCells':
          count(loss, 'merged-cell')
          break
        case 'conditionalFormatting':
        case 'dataValidation':
          count(loss, 'format')
          break
        case 'dataValidations':
          count(loss, 'format', childrenNamed(child, 'dataValidation').length)
          break
        case 'drawing':
          count(loss, 'chart')
          break
        case 'legacyDrawing':
          count(loss, 'comment')
          break
        default:
          countUnknown(child, loss)
          break
      }
    }
  }
  // One increment per ROW and per COLUMN beyond the cap, not per cell: a 100k-row
  // sheet would otherwise report a six-figure count nobody can read.
  count(loss, 'too-large', droppedRows.size + droppedColumns.size)
  const width = lastColumn + 1
  return grid.slice(0, lastRow + 1).map((row) => row.slice(0, width))
}

/**
 * The loss that lives in parts rather than in a sheet: charts, images, comments
 * and pivot tables are separate parts, and a sheet only points at them.
 */
function countPackageLoss(parts, loss) {
  for (const name of parts.keys()) {
    if (name.startsWith('xl/charts/')) count(loss, 'chart')
    else if (name.startsWith('xl/media/')) count(loss, 'image')
    else if (name.startsWith('xl/pivot')) count(loss, 'pivot')
    else if (/^xl\/comments[^/]*\.xml$/.test(name)) count(loss, 'comment')
  }
}

/**
 * The style table's loss: a number format beyond General, and every cell format
 * after the first, which is the default an unstyled cell uses. A style part that
 * cannot be parsed is decoration and is passed over — it must not make a readable
 * workbook unreadable.
 */
function countStyleLoss(part, loss) {
  if (!part) return
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    return
  }
  const root = rootElement(tree)
  if (root === null) return
  for (const format of childrenNamed(firstChild(root, 'numFmts'), 'numFmt')) {
    const code = attrOf(format, 'formatCode')
    if (code !== undefined && String(code) !== 'General') count(loss, 'format')
  }
  const entries = childrenNamed(firstChild(root, 'cellXfs'), 'xf')
  count(loss, 'format', entries.length - 1)
}

/**
 * One sentence naming what a loss report means, for the tab's banner.
 *
 * Shared with the `.docx` half (`model.js` owns it) rather than spelled a second
 * time here: a tab that shows a workbook's report beside a document's must say
 * the same thing about the same kind, and the kinds are the same vocabulary.
 *
 * @param loss - a loss report from {@link readXlsx}.
 * @returns the sentence, or `''` for an empty report.
 */
export { describeLoss }
