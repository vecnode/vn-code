/**
 * dsh-writing — the `.docx` codec: the model out, and a Word file back in.
 *
 * This is the half of the Writing tab that talks to the rest of the world, and
 * it is written against the format rather than against a library, because the
 * pack ships no dependencies and because a document's own container is small
 * enough to own: a ZIP of XML parts ({@link module:dsh-writing/lib/zip.js} and
 * {@link module:dsh-writing/lib/xml.js} beside this file).
 *
 * WHY THIS AND NOT A RENDERER. A `.docx` is what Writer, Word and - through
 * `@deepseek-ai/libreoffice-kit` - the harness itself already read: the shipped
 * office preview converts a document to PDF with the bundled LibreOffice and
 * paints that. So this codec's output is not judged by this file's opinion of
 * itself: `check-writing-node.mjs` writes a document, hands the bytes to
 * LibreOffice and asserts that it loads and paginates. A part that is malformed,
 * mis-typed or mis-escaped fails there.
 *
 * WHAT THE READER DOES WITH WHAT IT DOES NOT UNDERSTAND: it COUNTS it. Every
 * construct this model cannot hold (tables, images, footnotes, fields, tracked
 * changes, equations, comments, content controls, extra sections) is reported as
 * a loss entry with a kind, a count and a sentence - and the tab shows that
 * before a save that would drop it. Silently discarding half a manuscript is the
 * one failure mode worth the extra code.
 */
import {
  PAGE_SIZES,
  MAX_BLOCKS,
  MAX_TITLE_CHARS,
  blockText,
  defaultPage,
  docDefaults,
  documentBytes,
  lossEntry,
  mergeLoss,
  normalizeBlocks,
  normalizeFont,
  normalizeFontSize,
  normalizePage,
  pageDimensions,
} from './model.js'
import { zipSync, unzipSync } from './zip.js'
import { attrOf, childrenNamed, escapeAttr, escapeXml, findAll, firstChild, parseXml, textContent } from './xml.js'

/** Twips per millimetre: 1440 twips to the inch, 25.4 mm to the inch. */
const TWIPS_PER_MM = 1440 / 25.4
/** The OOXML namespace prefixes a document part needs. */
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** The heading styles this writer emits, and their half-point sizes. */
const HEADING_SIZES = [36, 30, 26, 24, 22, 22]
/** A `.docx` is a zip; this is every part this writer produces. */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
/** Package relationships: the main part, and the two property parts. */
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
/** The document part's own relationships (its styles and its numbering). */
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`

/** One paragraph property element, or nothing. */
function pPrXml(block) {
  const parts = []
  if (block.type === 'heading') parts.push('<w:pStyle w:val="Heading' + block.level + '"/>')
  else if (block.type === 'quote') parts.push('<w:pStyle w:val="Quote"/>')
  else if (block.type === 'code') parts.push('<w:pStyle w:val="Code"/>')
  else if (block.type === 'listItem') parts.push('<w:pStyle w:val="ListParagraph"/>')
  if (block.type === 'listItem') {
    // numId 1 is the bullet list, numId 2 the numbered one; both abstract
    // definitions carry four levels (see numberingXml).
    parts.push('<w:numPr><w:ilvl w:val="' + block.level + '"/><w:numId w:val="' + (block.ordered ? 2 : 1) + '"/></w:numPr>')
  }
  if (block.align) parts.push('<w:jc w:val="' + (block.align === 'justify' ? 'both' : block.align) + '"/>')
  return parts.length === 0 ? '' : '<w:pPr>' + parts.join('') + '</w:pPr>'
}

/**
 * One run's properties, in the order the OOXML schema lists them.
 *
 * The order is not cosmetic: `w:rPr` is a SEQUENCE, and a `w:strike` written
 * after a `w:u` is a file Word may object to while LibreOffice accepts it - which
 * is exactly the kind of difference a check written against one engine cannot
 * find for you.
 */
function rPrXml(run) {
  const parts = []
  if (run.marks.includes('code')) parts.push('<w:rStyle w:val="CodeChar"/>')
  // The family goes into all three slots (ascii, hAnsi, cs): a name in `w:ascii`
  // alone leaves complex-script text in whatever the reader's default is, which
  // is how one paragraph ends up looking like two documents.
  if (typeof run.font === 'string' && run.font.length > 0) {
    const family = escapeAttr(run.font)
    parts.push('<w:rFonts w:ascii="' + family + '" w:hAnsi="' + family + '" w:cs="' + family + '"/>')
  }
  if (run.marks.includes('b')) parts.push('<w:b/>')
  if (run.marks.includes('i')) parts.push('<w:i/>')
  if (run.marks.includes('s')) parts.push('<w:strike/>')
  if (Number.isFinite(run.size)) {
    // `w:sz` is HALF-points, which is why the model rounds a size to half a point.
    const half = String(Math.round(run.size * 2))
    parts.push('<w:sz w:val="' + half + '"/><w:szCs w:val="' + half + '"/>')
  }
  if (run.marks.includes('u')) parts.push('<w:u w:val="single"/>')
  return parts.length === 0 ? '' : '<w:rPr>' + parts.join('') + '</w:rPr>'
}

/**
 * One run's text, with the two things a `w:t` cannot carry: a soft line break is
 * `<w:br/>` and a tab is `<w:tab/>`. `xml:space="preserve"` is on every `w:t`
 * because a run's leading or trailing space is content a person typed.
 *
 * @param text - the run's text.
 * @returns the `w:t` / `w:br` / `w:tab` sequence.
 */
function textXml(text) {
  const out = []
  const segments = String(text).split('\n')
  segments.forEach((segment, segmentIndex) => {
    if (segmentIndex > 0) out.push('<w:br/>')
    const pieces = segment.split('\t')
    pieces.forEach((piece, pieceIndex) => {
      // The separator goes before every piece but the first, so a LEADING tab
      // survives too: splitting "a\tb" and "\tb" differ only in where the empty
      // piece is, and both emit one `w:tab` in the right place.
      if (pieceIndex > 0) out.push('<w:tab/>')
      if (piece.length > 0) out.push('<w:t xml:space="preserve">' + escapeXml(piece) + '</w:t>')
    })
  })
  return out.join('')
}

/** One block as OOXML. */
function blockXml(block) {
  if (block.type === 'pageBreak') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  const runs = block.runs
    .map((run) => '<w:r>' + rPrXml(run) + textXml(run.text) + '</w:r>')
    .join('')
  return '<w:p>' + pPrXml(block) + runs + '</w:p>'
}

/** The section properties: page size and margins, which is where page setup lives. */
function sectPrXml(page) {
  const normalized = normalizePage(page)
  const { widthMm, heightMm } = pageDimensions(normalized)
  const twips = (value) => String(Math.round(value * TWIPS_PER_MM))
  const size = PAGE_SIZES[normalized.size]
  const landscape = normalized.orientation === 'landscape'
  return (
    '<w:sectPr><w:pgSz w:w="' +
    twips(landscape ? size.height : size.width) +
    '" w:h="' +
    twips(landscape ? size.width : size.height) +
    '"' +
    (landscape ? ' w:orient="landscape"' : '') +
    '/><w:pgMar w:top="' +
    twips(normalized.margins.top) +
    '" w:right="' +
    twips(normalized.margins.right) +
    '" w:bottom="' +
    twips(normalized.margins.bottom) +
    '" w:left="' +
    twips(normalized.margins.left) +
    '" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
  )
}

/**
 * The paragraph styles, so a heading is an OUTLINE LEVEL and not just big text -
 * plus the document's own run defaults, which are where a font chosen once for
 * the whole document belongs (a `w:rFonts` on every run would say the same thing
 * a thousand times, and would make "change the document font" impossible).
 *
 * The size is ALWAYS written (a document always has one), and the family only
 * when the document names one: an absent `w:rFonts` in `docDefaults` means "the
 * application's default", which is exactly what an empty family means here.
 *
 * @param doc - the document whose defaults to write.
 */
function stylesXml(doc) {
  const headings = HEADING_SIZES.map(
    (size, index) =>
      '<w:style w:type="paragraph" w:styleId="Heading' +
      (index + 1) +
      '"><w:name w:val="heading ' +
      (index + 1) +
      '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="' +
      (9 - index) +
      '"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="' +
      index +
      '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' +
      size +
      '"/><w:szCs w:val="' +
      size +
      '"/></w:rPr></w:style>',
  ).join('')
  const defaults = docDefaults(doc)
  const half = String(Math.round(defaults.fontSize * 2))
  const family = defaults.font.length > 0 ? '<w:rFonts w:ascii="' + escapeAttr(defaults.font) + '" w:hAnsi="' + escapeAttr(defaults.font) + '" w:cs="' + escapeAttr(defaults.font) + '"/>' : ''
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="' +
    W_NS +
    '"><w:docDefaults><w:rPrDefault><w:rPr>' +
    family +
    '<w:sz w:val="' +
    half +
    '"/><w:szCs w:val="' +
    half +
    '"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    headings +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/></w:rPr></w:style>' +
    '</w:styles>'
  )
}

/** Four list levels, bulleted and numbered. */
function numberingXml() {
  const levels = (format, text, font) =>
    [0, 1, 2, 3]
      .map(
        (level) =>
          '<w:lvl w:ilvl="' +
          level +
          '"><w:start w:val="1"/><w:numFmt w:val="' +
          format +
          '"/><w:lvlText w:val="' +
          text +
          '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' +
          (720 + level * 360) +
          '" w:hanging="360"/></w:pPr>' +
          (font ? '<w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:hint="default"/></w:rPr>' : '') +
          '</w:lvl>',
      )
      .join('')
  // The bullet glyphs Word itself uses per level, drawn from Symbol/Courier New
  // so LibreOffice and Word both have the face.
  const bulletTexts = ['\u2022', 'o', '\u25aa', '\u2022']
  const bulletLevels = [0, 1, 2, 3]
    .map(
      (level) =>
        '<w:lvl w:ilvl="' +
        level +
        '"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="' +
        escapeAttr(bulletTexts[level]) +
        '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' +
        (720 + level * 360) +
        '" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>',
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="' +
    W_NS +
    '"><w:abstractNum w:abstractNumId="0">' +
    bulletLevels +
    '</w:abstractNum><w:abstractNum w:abstractNumId="1">' +
    levels('decimal', '%1.', null) +
    '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>'
  )
}

/** The core properties, so a document carries the title it was written under. */
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
function appXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>dsh-writing</Application><AppVersion>1.0</AppVersion></Properties>'
  )
}

/**
 * Write one document as `.docx` bytes.
 *
 * @param doc - the document (its `blocks` and `page` are what this reads).
 * @param options - `{ title, now }`; `title` defaults to the document's own.
 * @returns the file's bytes.
 */
export function writeDocx(doc, { title = null, now = new Date() } = {}) {
  const blocks = normalizeBlocks(doc && doc.blocks)
  const page = normalizePage(doc && doc.page)
  const name = String(title ?? (doc && doc.title) ?? 'Untitled').slice(0, MAX_TITLE_CHARS)
  const body = blocks.map(blockXml).join('')
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="' +
    W_NS +
    '" xmlns:r="' +
    R_NS +
    '"><w:body>' +
    body +
    sectPrXml(page) +
    '</w:body></w:document>'
  return zipSync(
    [
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'docProps/core.xml', data: coreXml(name, now) },
      { name: 'docProps/app.xml', data: appXml() },
      { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml(doc) },
      { name: 'word/numbering.xml', data: numberingXml() },
    ],
    { date: now },
  )
}

/** A `w:val` boolean: present and not a false word means true. */
function valBool(value) {
  if (value === undefined || value === null) return false
  const text = String(value).toLowerCase()
  return !(text === '0' || text === 'false' || text === 'off' || text === 'none')
}

/** A typed failure the routes turn into a 4xx. */
export function docxError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Read a `.docx` into the model.
 *
 * @param bytes - the file's bytes.
 * @returns `{ document, loss, meta }`: the model (no id, no title unless the
 *   file carries one), the loss report, and the parts that were read.
 * @throws a typed error (`NOT_A_ZIP`, `NO_DOCUMENT_PART`, `BAD_XML`, …) when the
 *   bytes are not a Word document.
 */
export function readDocx(bytes) {
  let parts
  try {
    parts = unzipSync(bytes)
  } catch (err) {
    throw docxError('NOT_A_ZIP', 'This file is not a Word document (it is not a ZIP archive): ' + err.message)
  }
  const main = parts.get('word/document.xml')
  if (!main) {
    throw docxError('NO_DOCUMENT_PART', 'This ZIP has no word/document.xml, so it is not a Word document.')
  }
  let tree
  try {
    tree = parseXml(main.toString('utf8'))
  } catch (err) {
    throw docxError('BAD_XML', 'The document part could not be read: ' + err.message)
  }
  const styles = readStyles(parts.get('word/styles.xml'))
  const styleTable = styles.table
  const numbering = readNumbering(parts.get('word/numbering.xml'))
  const loss = []
  // `w:body` sits inside `w:document`, which sits inside the document node the
  // parser returns - so it is FOUND rather than assumed to be a direct child.
  const body = findAll(tree, 'body')[0] ?? null
  const blocks = []
  let page = defaultPage()
  if (body) {
    // The body's own children, one level at a time. A content control is the one
    // wrapper worth descending through: the paragraphs INSIDE it are ordinary
    // text a person wrote, and dropping them because of the wrapper would lose
    // more than the wrapper is worth.
    const walkBody = (parent) => {
      for (const child of parent.children) {
        if (typeof child === 'string') continue
        switch (child.local) {
          case 'p':
            if (blocks.length < MAX_BLOCKS) blocks.push(...paragraphBlocks(child, styleTable, numbering, loss))
            else count(loss, 'block-limit', 'the document is longer than this tab holds; the rest was not read')
            break
          case 'tbl':
            count(loss, 'table', 'saving this document would drop its tables')
            break
          case 'sectPr': {
            const read = pageFromSectPr(child)
            if (read) page = read
            break
          }
          case 'sdt':
            count(loss, 'content-control', 'saving this document would drop its content controls')
            walkBody(firstChild(child, 'sdtContent') ?? child)
            break
          default:
            count(loss, 'other', 'an element this tab does not read was skipped')
            break
        }
      }
    }
    walkBody(body)
  }
  const title = readCoreTitle(parts.get('docProps/core.xml'))
  // The document's own defaults come from `docDefaults`, and they are what every
  // run is measured against: a run that says Calibri 11 in a Calibri 11 document
  // carries NEITHER, which is what keeps an opened-and-saved file byte-stable and
  // what makes "change the document font" one write instead of hundreds.
  const defaults = styles.defaults
  const document = {
    title: title ?? 'Untitled',
    page,
    ...defaults,
    blocks: normalizeBlocks(blocks, defaults),
  }
  return {
    document,
    loss: mergeLoss(loss),
    meta: {
      parts: [...parts.keys()].sort(),
      bytes: documentBytes(document),
      hasStyles: parts.has('word/styles.xml'),
      hasNumbering: parts.has('word/numbering.xml'),
      hasMedia: [...parts.keys()].some((name) => name.startsWith('word/media/')),
    },
  }
}

/** Add one loss entry. */
function count(loss, kind, note) {
  const existing = loss.find((entry) => entry.kind === kind)
  if (existing) existing.count += 1
  else loss.push(lossEntry(kind, 1, note))
}

/**
 * The paragraph style table (styleId → `{ name, outlineLvl }`) and the
 * document's own run defaults, from `styles.xml`.
 *
 * @param part - the `word/styles.xml` part, or undefined.
 * @returns `{ table, defaults }`; a part that cannot be read yields an empty
 *   table and the model's own defaults rather than an error, because a document
 *   with an unreadable style table is still a document with text in it.
 */
function readStyles(part) {
  const table = new Map()
  const defaults = { font: '', fontSize: normalizeFontSize(null) }
  if (!part) return { table, defaults }
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    return { table, defaults }
  }
  const rPrDefault = findAll(tree, 'rPrDefault')[0]
  if (rPrDefault) {
    const rPr = firstChild(rPrDefault, 'rPr') ?? rPrDefault
    const fonts = firstChild(rPr, 'rFonts')
    // `w:ascii` first, then `w:hAnsi`: a file may carry one without the other,
    // and either one names the family the person chose.
    const family = fonts ? attrOf(fonts, 'w:ascii') ?? attrOf(fonts, 'w:hAnsi') : undefined
    if (family !== undefined) defaults.font = normalizeFont(family)
    const size = attrOf(firstChild(rPr, 'sz'), 'w:val')
    if (size !== undefined) defaults.fontSize = normalizeFontSize(Number(size) / 2)
  }
  for (const style of findAll(tree, 'style')) {
    const id = attrOf(style, 'w:styleId')
    if (!id) continue
    // `w:name` carries its value in `w:val`, like every other OOXML property
    // element - reading it as text content yields an empty string and quietly
    // makes every named style unrecognisable.
    const name = String(attrOf(firstChild(style, 'name'), 'w:val') ?? '')
    const pPr = firstChild(style, 'pPr')
    const outline = pPr ? attrOf(firstChild(pPr, 'outlineLvl'), 'w:val') : undefined
    table.set(id, { name, outlineLvl: outline === undefined ? null : Number(outline) })
  }
  return { table, defaults }
}

/** numId → `{ ordered, levels }`, so a list knows what kind of list it is. */
function readNumbering(part) {
  const abstract = new Map()
  const byNum = new Map()
  if (!part) return byNum
  let tree
  try {
    tree = parseXml(part.toString('utf8'))
  } catch (err) {
    return byNum
  }
  for (const entry of findAll(tree, 'abstractNum')) {
    const id = attrOf(entry, 'w:abstractNumId')
    if (id === undefined) continue
    const formats = new Map()
    for (const level of childrenNamed(entry, 'lvl')) {
      const ilvl = Number(attrOf(level, 'w:ilvl') ?? 0)
      formats.set(ilvl, String(attrOf(firstChild(level, 'numFmt'), 'w:val') ?? 'bullet'))
    }
    abstract.set(String(id), formats)
  }
  for (const entry of findAll(tree, 'num')) {
    const id = attrOf(entry, 'w:numId')
    const ref = attrOf(firstChild(entry, 'abstractNumId'), 'w:val')
    if (id === undefined || ref === undefined) continue
    byNum.set(String(id), abstract.get(String(ref)) ?? new Map())
  }
  return byNum
}

/** The document title from the core properties, or null. */
function readCoreTitle(part) {
  if (!part) return null
  try {
    const tree = parseXml(part.toString('utf8'))
    const title = findAll(tree, 'title')[0]
    const text = title ? textContent(title).trim() : ''
    return text.length > 0 ? text.slice(0, MAX_TITLE_CHARS) : null
  } catch (err) {
    return null
  }
}

/** Page setup from one `w:sectPr`, or null when it says nothing. */
function pageFromSectPr(sectPr) {
  const size = firstChild(sectPr, 'pgSz')
  const margin = firstChild(sectPr, 'pgMar')
  if (!size && !margin) return null
  const page = defaultPage()
  if (size) {
    const width = Number(attrOf(size, 'w:w')) / TWIPS_PER_MM
    const height = Number(attrOf(size, 'w:h')) / TWIPS_PER_MM
    const landscape = String(attrOf(size, 'w:orient') ?? '') === 'landscape' || (Number.isFinite(width) && Number.isFinite(height) && width > height)
    page.orientation = landscape ? 'landscape' : 'portrait'
    // Choose the named size by the PORTRAIT pair, whichever way round the file
    // wrote it: a Letter document written landscape is still Letter.
    const portraitWidth = landscape ? height : width
    const portraitHeight = landscape ? width : height
    let best = null
    for (const [key, value] of Object.entries(PAGE_SIZES)) {
      const delta = Math.abs(value.width - portraitWidth) + Math.abs(value.height - portraitHeight)
      if (best === null || delta < best.delta) best = { key, delta }
    }
    // Within 2 mm of a known size is that size; anything else keeps A4's label
    // and takes the file's own geometry only through orientation, because the
    // model names sizes rather than carrying arbitrary dimensions.
    if (best && best.delta <= 4) page.size = best.key
  }
  if (margin) {
    const mm = (name, fallback) => {
      const twips = Number(attrOf(margin, name))
      return Number.isFinite(twips) ? Math.round((twips / TWIPS_PER_MM) * 10) / 10 : fallback
    }
    page.margins = {
      top: mm('w:top', page.margins.top),
      right: mm('w:right', page.margins.right),
      bottom: mm('w:bottom', page.margins.bottom),
      left: mm('w:left', page.margins.left),
    }
  }
  return normalizePage(page)
}

/**
 * One `w:p` as one or two blocks: a paragraph containing nothing but a
 * page-break run becomes a page break, and everything else becomes its own
 * block with the style, list and alignment the file carries.
 *
 * @param node - the `w:p` element.
 * @param styleTable - the paragraph style table.
 * @param numbering - numId → level formats.
 * @param loss - the loss report, appended to.
 * @returns the blocks this paragraph produced.
 */
function paragraphBlocks(node, styleTable, numbering, loss) {
  const pPr = firstChild(node, 'pPr')
  const styleId = pPr ? String(attrOf(firstChild(pPr, 'pStyle'), 'w:val') ?? '') : ''
  const style = styleTable.get(styleId) ?? null
  const runs = []
  let sawPageBreak = false
  const walk = (parent) => {
    for (const child of parent.children) {
      if (typeof child === 'string') continue
      switch (child.local) {
        case 'r':
          if (readRun(child, runs, loss)) sawPageBreak = true
          break
        case 'hyperlink':
          count(loss, 'hyperlink', 'saving this document would drop its links')
          walk(child)
          break
        case 'ins':
          count(loss, 'tracked-change', 'saving this document would accept its tracked insertions')
          walk(child)
          break
        case 'del':
          count(loss, 'tracked-change', 'saving this document would drop its tracked deletions')
          break
        case 'fldSimple':
          count(loss, 'field', 'saving this document would drop its fields (dates, references, a table of contents)')
          walk(child)
          break
        case 'sdt':
          count(loss, 'content-control', 'saving this document would drop its content controls')
          walk(firstChild(child, 'sdtContent') ?? child)
          break
        case 'bookmarkStart':
        case 'bookmarkEnd':
        case 'proofErr':
        case 'commentRangeStart':
        case 'commentRangeEnd':
          if (child.local.startsWith('comment')) count(loss, 'comment', 'saving this document would drop its comments')
          break
        case 'commentReference':
          count(loss, 'comment', 'saving this document would drop its comments')
          break
        case 'oMath':
        case 'oMathPara':
          count(loss, 'equation', 'saving this document would drop its equations')
          break
        default:
          if (child.local !== 'pPr') count(loss, 'other', 'an element this tab does not read was skipped')
          break
      }
    }
  }
  walk(node)
  const text = runs.map((run) => run.text).join('')
  // A paragraph whose whole content is a page break IS a page break (that is how
  // Writer and Word both spell one). A page break beside text is the case this
  // model cannot represent, and it is reported rather than dropped.
  if (sawPageBreak) {
    if (text.length === 0) return [{ type: 'pageBreak', runs: [{ text: '', marks: [] }] }]
    count(loss, 'other', 'a page break inside a paragraph became a line break')
  }

  const block = { type: 'paragraph', runs }
  const headingLevel = headingLevelOf(styleId, style)
  const numPr = pPr ? firstChild(pPr, 'numPr') : null
  if (numPr) {
    // A list is a list first: a List Paragraph style carries no outline level, so
    // this cannot collide with a heading, but the order is stated anyway.
    const numId = String(attrOf(firstChild(numPr, 'numId'), 'w:val') ?? '')
    const level = Number(attrOf(firstChild(numPr, 'ilvl'), 'w:val') ?? 0)
    const formats = numbering.get(numId)
    const format = formats ? String(formats.get(Number.isFinite(level) ? level : 0) ?? 'bullet') : 'bullet'
    block.type = 'listItem'
    block.ordered = format !== 'bullet'
    block.level = Math.min(4, Math.max(0, Number.isFinite(level) ? level : 0))
  } else if (headingLevel !== null) {
    block.type = 'heading'
    block.level = headingLevel
  } else if (style && /quote/i.test(style.name)) {
    block.type = 'quote'
  } else if (style && /(preformatted|code|htmlpre)/i.test(style.name)) {
    block.type = 'code'
  }
  const jc = pPr ? String(attrOf(firstChild(pPr, 'jc'), 'w:val') ?? '') : ''
  if (jc === 'both') block.align = 'justify'
  else if (jc === 'center' || jc === 'right') block.align = jc
  return [block]
}

/** The heading level a paragraph style means, or null. */
function headingLevelOf(styleId, style) {
  if (style && style.outlineLvl !== null && Number.isFinite(style.outlineLvl) && style.outlineLvl >= 0 && style.outlineLvl <= 5) {
    return style.outlineLvl + 1
  }
  const byId = /^heading\s*(\d)$/i.exec(styleId)
  if (byId) return Math.min(6, Math.max(1, Number(byId[1])))
  const byName = style ? /^heading\s*(\d)$/i.exec(style.name.trim()) : null
  if (byName) return Math.min(6, Math.max(1, Number(byName[1])))
  return null
}

/**
 * A run property that is ON when its element is present: `<w:b/>` and
 * `<w:b w:val="1"/>` both mean bold, `<w:b w:val="0"/>` (and `false`/`off`)
 * means a direct override back to regular - which is a real thing a style table
 * does, so the three cases are answered separately rather than by one
 * truthiness test.
 */
function runFlag(rPr, name) {
  const element = firstChild(rPr, name)
  if (!element) return false
  const value = attrOf(element, 'w:val')
  return value === undefined ? true : valBool(value)
}

/**
 * Read one `w:r` into runs, carrying its marks and its breaks.
 * @returns `{ pageBreak }` - true when the run carried `<w:br w:type="page"/>`,
 *   which the PARAGRAPH decides about, because a page break alone is a page
 *   break and a page break beside text is a loss.
 */
function readRun(node, runs, loss) {
  const rPr = firstChild(node, 'rPr')
  const marks = []
  let font = ''
  let size = null
  let pageBreak = false
  if (rPr) {
    if (runFlag(rPr, 'b')) marks.push('b')
    if (runFlag(rPr, 'i')) marks.push('i')
    const underline = firstChild(rPr, 'u')
    if (underline && String(attrOf(underline, 'w:val') ?? 'single') !== 'none') marks.push('u')
    if (firstChild(rPr, 'strike') || firstChild(rPr, 'dstrike')) marks.push('s')
    const styleId = String(attrOf(firstChild(rPr, 'rStyle'), 'w:val') ?? '')
    if (/code/i.test(styleId)) marks.push('code')
    if (firstChild(rPr, 'vertAlign')) count(loss, 'other', 'a superscript or subscript became plain text')
    // A run's own family and size. They are only KEPT when they differ from the
    // document's defaults - `normalizeBlocks` at the end of the read does that,
    // which is what makes one write of "document font" beat a thousand runs.
    const fonts = firstChild(rPr, 'rFonts')
    const family = fonts ? attrOf(fonts, 'w:ascii') ?? attrOf(fonts, 'w:hAnsi') : undefined
    if (family !== undefined) font = String(family)
    const half = attrOf(firstChild(rPr, 'sz'), 'w:val')
    const points = half === undefined ? Number.NaN : Number(half) / 2
    if (Number.isFinite(points) && points > 0) size = points
  }
  let text = ''
  const push = () => {
    if (text.length > 0) {
      const run = { text, marks: [...marks] }
      if (font.length > 0) run.font = font
      if (size !== null) run.size = size
      runs.push(run)
      text = ''
    }
  }
  const walk = (parent) => {
    for (const child of parent.children) {
      if (typeof child === 'string') {
        // Text directly inside a run is unusual but legal; keep it.
        text += child
        continue
      }
      switch (child.local) {
        case 't':
          text += textContent(child)
          break
        case 'br':
          if (String(attrOf(child, 'w:type') ?? '') === 'page') pageBreak = true
          else text += '\n'
          break
        case 'tab':
          text += '\t'
          break
        case 'noBreakHyphen':
          text += '\u2011'
          break
        case 'softHyphen':
        case 'rPr':
          break
        case 'drawing':
        case 'pict':
        case 'object':
          count(loss, 'image', 'saving this document would drop its images and drawings')
          break
        case 'footnoteReference':
          count(loss, 'footnote', 'saving this document would drop its footnotes')
          break
        case 'endnoteReference':
          count(loss, 'endnote', 'saving this document would drop its endnotes')
          break
        case 'footnoteRef':
        case 'endnoteRef':
          break
        case 'fldChar':
        case 'instrText':
          count(loss, 'field', 'saving this document would drop its fields')
          break
        case 'commentReference':
          count(loss, 'comment', 'saving this document would drop its comments')
          break
        case 'sym':
          count(loss, 'other', 'a symbol this tab does not read was skipped')
          break
        default:
          if (child.local !== 'lastRenderedPageBreak') count(loss, 'other', 'an element this tab does not read was skipped')
          break
      }
    }
  }
  walk(node)
  push()
  return pageBreak
}

/** The human file name for one document's `.docx`. */
export function docxFileName(title) {
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return (base.length > 0 ? base : 'document') + '.docx'
}

/** Every block's plain text, as a list - the shape a LibreOffice text check asserts on. */
export function blockLines(doc) {
  return normalizeBlocks(doc && doc.blocks).map((block) => (block.type === 'pageBreak' ? '' : blockText(block)))
}
