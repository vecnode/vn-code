/**
 * dsh-research — the document model as OOXML parts.
 *
 * A `.docx` is an OPC package: a ZIP holding a small set of XML parts that name
 * each other by relationship id. This module turns the block model into those
 * parts, and every rule below exists because a real Word refuses the file when it
 * is broken:
 *
 *   1. **Every part named in `[Content_Types].xml` must exist, and every part that
 *      exists must be named there.** Both lists are produced by `buildParts`, so
 *      they cannot drift.
 *   2. **A relationship id is allocated in a deterministic order**, never
 *      randomised: styles, settings, numbering and footnotes first, then the
 *      hyperlinks sorted by target, then the images sorted by name. Two builds of
 *      one input therefore carry the same ids, which is part of the byte-identity
 *      this writer promises.
 *   3. **`w:updateFields` is what makes a table of contents appear without F9.**
 *      A TOC is a FIELD, and Word only evaluates fields on open when the document
 *      says to - without it a reader meets the empty result of a field nobody ran.
 *   4. **A footnote part needs two notes before any real one.** Word reads
 *      `word/footnotes.xml` positionally: the separator at `w:id="-1"` and the
 *      continuation separator at `w:id="0"`, then the document's own notes from
 *      `w:id="1"`. A file whose first note is a real one renders its text as the
 *      separator rule.
 *   5. **The reference list is a paragraph STYLE, not a list.** Every paragraph
 *      after the heading whose text equals the run's reference heading takes the
 *      `Bibliography` style, which carries the hanging indent of half an inch.
 *      That is the stated rule, and no other list is affected by it.
 *
 * Nothing here reads a file, spawns anything, or asks a clock.
 */

import { headingRuleOf, paperStyleOf } from './styles.js'
import { xmlAttr, xmlEscape, xmlStrip, wOnOff, wText, wVal } from './xml.js'

/** The XML declaration every part opens with, once, at the very first byte. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** The WordprocessingML namespace, prefixed `w` in every document part. */
export const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** The relationships namespace, on the document root and on every `.rels` part. */
export const R_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The package relationships namespace, on the two `.rels` parts. */
const PACKAGE_REL_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** The content-type namespace, on `[Content_Types].xml`. */
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'

/** Where a relationship's type name lives, so no type string is spelled twice. */
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/**
 * The timestamp a document carries when the caller gives none.
 *
 * A FIXED constant rather than the clock: the bytes of a document must depend on
 * its input alone, so two builds of one Markdown file hash the same. A caller that
 * passes `created` gets different bytes, which is what proves the determinism is
 * real rather than a constant output.
 */
export const DEFAULT_CREATED = '1980-01-01T00:00:00Z'

/** The document's own language, written into the style defaults so it cannot vary by machine. */
const LANGUAGE = 'en-US'

/** The image format a source with no usable extension gets. */
const DEFAULT_IMAGE_EXTENSION = 'png'

/** The extension-to-content-type table. An extension outside it falls back to `png`. */
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}

/* ------------------------------------------------------------------------- *
 * Relationships and property parts
 * ------------------------------------------------------------------------- */

/** One relationship: an id, a type name, and a target. */
function rel(id, type, target, mode = null) {
  return { id, type, target, mode }
}

/** A relationship as XML, with `TargetMode="External"` only where it belongs. */
function relXml(one) {
  return (
    '<Relationship Id=' +
    xmlAttr(one.id) +
    ' Type=' +
    xmlAttr(REL_TYPE + one.type) +
    ' Target=' +
    xmlAttr(one.target) +
    (one.mode === null ? '' : ' TargetMode=' + xmlAttr(one.mode)) +
    '/>'
  )
}

/** A `.rels` part, from its relationships, in the order they were allocated. */
function relsXml(relationships) {
  return (
    XML_DECLARATION +
    '<Relationships xmlns=' +
    xmlAttr(PACKAGE_REL_NAMESPACE) +
    '>' +
    relationships.map(relXml).join('') +
    '</Relationships>'
  )
}

/** The package's own relationships: the document, and the two property parts. */
export function packageRels() {
  return relsXml([
    rel('rId1', 'officeDocument', 'word/document.xml'),
    rel('rId2', 'metadata/core-properties', 'docProps/core.xml'),
    rel('rId3', 'extended-properties', 'docProps/app.xml'),
  ])
}

/** The document's relationships: the four fixed parts, then the links, then the images. */
export function documentRels(plan) {
  const relationships = [
    rel('rId1', 'styles', 'styles.xml'),
    rel('rId2', 'settings', 'settings.xml'),
    rel('rId3', 'numbering', 'numbering.xml'),
    rel('rId4', 'footnotes', 'footnotes.xml'),
  ]
  for (const link of plan.links) relationships.push(rel(link.id, 'hyperlink', link.url, 'External'))
  for (const image of plan.images) relationships.push(rel(image.id, 'image', image.target))
  return relsXml(relationships)
}

/** The content types: a default per extension, and an override per named part. */
export function contentTypes(plan) {
  const defaults = [['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']]
  for (const extension of plan.imageExtensions) defaults.push([extension, IMAGE_TYPES[extension]])
  const overrides = [
    ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
    ['/word/footnotes.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ]
  const body =
    defaults.map(([extension, type]) => '<Default Extension=' + xmlAttr(extension) + ' ContentType=' + xmlAttr(type) + '/>').join('') +
    overrides.map(([part, type]) => '<Override PartName=' + xmlAttr(part) + ' ContentType=' + xmlAttr(type) + '/>').join('')
  return XML_DECLARATION + '<Types xmlns=' + xmlAttr(CONTENT_TYPES_NAMESPACE) + '>' + body + '</Types>'
}

/** Core properties. The two dates come from the caller, never from a clock. */
export function coreProperties(options) {
  const created = String(options.created ?? DEFAULT_CREATED)
  const author = (Array.isArray(options.authors) ? options.authors : [])
    .filter((one) => typeof one === 'string' && one.trim() !== '')
    .join('; ')
  const members = [
    ['dc:title', xmlStrip(options.title ?? '')],
    ['dc:creator', author],
    ['cp:lastModifiedBy', author],
    ['dcterms:created', created],
    ['dcterms:modified', created],
  ]
  return (
    XML_DECLARATION +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    members.map(([tag, value]) => '<' + tag + '>' + xmlEscape(value) + '</' + tag + '>').join('') +
    '</cp:coreProperties>'
  )
}

/** Extended properties: the application name, and nothing that varies by machine. */
export function appProperties() {
  return (
    XML_DECLARATION +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>dsh-research</Application>' +
    '</Properties>'
  )
}

/**
 * Settings, whose one non-default member is the reason this part exists.
 *
 * `w:updateFields` makes Word evaluate the document's fields - the table of
 * contents above all - when it opens the file, instead of showing the placeholder
 * a field carries until someone presses F9. Everything else is written explicitly
 * so the part is a function of the input alone.
 */
export function settings() {
  return (
    XML_DECLARATION +
    '<w:settings xmlns:w=' +
    xmlAttr(W_NAMESPACE) +
    '><w:zoom w:percent="100"/>' +
    '<w:defaultTabStop w:val="720"/>' +
    '<w:characterSpacingControl w:val="doNotCompress"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '<w:updateFields w:val="true"/>' +
    '</w:settings>'
  )
}

/* ------------------------------------------------------------------------- *
 * Numbering
 * ------------------------------------------------------------------------- */

/** The bullet characters, one per level, which is what makes a nested list readable. */
const BULLETS = ['\u2022', '\u25e6', '\u25aa']

/** The indents per level, in twips: a half inch at the top, then a quarter inch each. */
const INDENTS = [
  { left: 720, hanging: 360 },
  { left: 1080, hanging: 360 },
  { left: 1440, hanging: 360 },
]

/** One level of an abstract numbering definition, for a bullet list or a decimal one. */
function numberingLevel(index, kind) {
  const bullet = kind === 'bullet'
  return (
    '<w:lvl w:ilvl="' +
    index +
    '"><w:start w:val="1"/><w:numFmt w:val=' +
    xmlAttr(bullet ? 'bullet' : 'decimal') +
    '/><w:lvlText w:val=' +
    xmlAttr(bullet ? BULLETS[index] : '%' + (index + 1) + '.') +
    '/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' +
    INDENTS[index].left +
    '" w:hanging="' +
    INDENTS[index].hanging +
    '"/></w:pPr>' +
    (bullet ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : '') +
    '</w:lvl>'
  )
}

/**
 * The two lists a document can use: one abstract definition each and one numbering
 * instance each. `w:numId="1"` is bullets everywhere and `w:numId="2"` is decimal,
 * which is the contract `listProperties` writes against.
 */
export function numbering() {
  const bullets = [0, 1, 2].map((index) => numberingLevel(index, 'bullet')).join('')
  const decimals = [0, 1, 2].map((index) => numberingLevel(index, 'decimal')).join('')
  return (
    XML_DECLARATION +
    '<w:numbering xmlns:w=' +
    xmlAttr(W_NAMESPACE) +
    '>' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    bullets +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    decimals +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  )
}

/* ------------------------------------------------------------------------- *
 * Styles
 * ------------------------------------------------------------------------- */

/** A paragraph style with its properties, as the child elements OOXML wants. */
function styleXml(id, name, properties) {
  return '<w:style w:type="paragraph" w:styleId=' + xmlAttr(id) + '><w:name w:val=' + xmlAttr(name) + '/>' + properties + '</w:style>'
}

/** A character style, which is what a hyperlink and a footnote reference are. */
function characterStyleXml(id, name, properties) {
  return '<w:style w:type="character" w:styleId=' + xmlAttr(id) + '><w:name w:val=' + xmlAttr(name) + '/>' + properties + '</w:style>'
}

/** The `<w:rPr>` a style sets, with its children in OOXML's own order. */
function runProperties(properties) {
  const parts = []
  const font = properties.font
  if (font !== undefined) parts.push('<w:rFonts w:ascii=' + xmlAttr(font) + ' w:hAnsi=' + xmlAttr(font) + ' w:cs=' + xmlAttr(font) + '/>')
  if (properties.bold !== undefined) parts.push(wOnOff('w:b', properties.bold), wOnOff('w:bCs', properties.bold))
  if (properties.italic !== undefined) parts.push(wOnOff('w:i', properties.italic), wOnOff('w:iCs', properties.italic))
  if (properties.color !== undefined) parts.push(wVal('w:color', properties.color))
  if (properties.underline !== undefined) parts.push(wVal('w:u', properties.underline))
  if (properties.sizeHalfPoints !== undefined) {
    parts.push(wVal('w:sz', String(properties.sizeHalfPoints)), wVal('w:szCs', String(properties.sizeHalfPoints)))
  }
  if (properties.superscript === true) parts.push(wVal('w:vertAlign', 'superscript'))
  return parts.length === 0 ? '' : '<w:rPr>' + parts.join('') + '</w:rPr>'
}

/** The `<w:pPr>` a style sets: spacing, alignment, keep-with-next, indentation. */
function paragraphProperties(properties, descriptor) {
  const spacing = properties.spacing ?? descriptor.spacing
  const parts = [
    '<w:spacing w:before="0" w:after="' +
      spacing.after +
      '" w:line="' +
      spacing.line +
      '" w:lineRule=' +
      xmlAttr(spacing.lineRule) +
      '/>',
  ]
  if (properties.align !== undefined) parts.push(wVal('w:jc', properties.align))
  if (properties.keepNext === true) parts.push(wOnOff('w:keepNext', true))
  if (properties.hanging === true) parts.push('<w:ind w:left="720" w:hanging="720"/>')
  if (properties.indentLeft !== undefined) parts.push('<w:ind w:left="' + properties.indentLeft + '"/>')
  return '<w:pPr>' + parts.join('') + '</w:pPr>'
}

/**
 * `word/styles.xml`: the document defaults, the six heading levels, and every named
 * paragraph the writer references by id.
 *
 * The heading formats come from the style descriptor, so APA's centred bold level 1
 * and IEEE's flush-left one are DATA rather than a branch in the writer.
 */
export function stylesXml(descriptor) {
  const font = descriptor.font
  const size = descriptor.sizeHalfPoints
  const docDefaults =
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=' +
    xmlAttr(font) +
    ' w:hAnsi=' +
    xmlAttr(font) +
    ' w:cs=' +
    xmlAttr(font) +
    '/><w:sz w:val="' +
    size +
    '"/><w:szCs w:val="' +
    size +
    '"/><w:lang w:val=' +
    xmlAttr(LANGUAGE) +
    '/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="' +
    descriptor.spacing.after +
    '" w:line="' +
    descriptor.spacing.line +
    '" w:lineRule=' +
    xmlAttr(descriptor.spacing.lineRule) +
    '/></w:pPr></w:pPrDefault></w:docDefaults>'

  const titleSpacing = { line: descriptor.spacing.line, lineRule: descriptor.spacing.lineRule, after: 240 }
  const normal = styleXml('Normal', 'Normal', paragraphProperties({}, descriptor) + runProperties({ font, sizeHalfPoints: size }))
  const title = styleXml('Title', 'Title', paragraphProperties({ align: descriptor.titleBlock.align, spacing: titleSpacing }, descriptor) + runProperties({ bold: descriptor.titleBlock.bold, sizeHalfPoints: size + 8 }))
  const subtitle = styleXml('Subtitle', 'Subtitle', paragraphProperties({ align: descriptor.titleBlock.align, spacing: titleSpacing }, descriptor) + runProperties({ italic: true, sizeHalfPoints: size + 4 }))
  const author = styleXml('Author', 'Author', paragraphProperties({ align: descriptor.titleBlock.align }, descriptor) + runProperties({ font, sizeHalfPoints: size }))
  const affiliation = styleXml('Affiliation', 'Affiliation', paragraphProperties({ align: descriptor.titleBlock.align }, descriptor) + runProperties({ italic: true, font, sizeHalfPoints: size }))

  const headings = []
  for (let level = 1; level <= 6; level += 1) {
    const rule = headingRuleOf(descriptor, level)
    // Levels 4-6 declare no rule of their own in any of the six styles: they
    // descend by italic weight from level 3, which is what the styles that define
    // them do.
    const headingSize = level === 1 ? size + 4 : level === 2 ? size + 2 : size
    headings.push(
      styleXml(
        'Heading' + level,
        'heading ' + level,
        paragraphProperties({ align: rule.align, keepNext: true, spacing: { line: descriptor.spacing.line, lineRule: descriptor.spacing.lineRule, after: 160 } }, descriptor) +
          runProperties({ bold: rule.bold, italic: level <= 3 ? rule.italic : true, sizeHalfPoints: headingSize, color: '000000' }),
      ),
    )
  }

  const quote = styleXml(
    'Quote',
    'Quote',
    paragraphProperties({ indentLeft: 720, spacing: { line: descriptor.spacing.line, lineRule: descriptor.spacing.lineRule, after: descriptor.spacing.after } }, descriptor) +
      runProperties({ italic: true }),
  )
  const codeBlock = styleXml('CodeBlock', 'Code Block', paragraphProperties({ spacing: { line: 240, lineRule: 'auto', after: 0 } }, descriptor) + runProperties({ font: 'Consolas', sizeHalfPoints: 20 }))
  const caption = styleXml(
    'Caption',
    'Caption',
    paragraphProperties({ spacing: { line: descriptor.spacing.line, lineRule: descriptor.spacing.lineRule, after: 160 } }, descriptor) +
      runProperties({ italic: true, sizeHalfPoints: Math.max(16, size - 2) }),
  )
  // The hanging indent is the whole reason the reference list is a paragraph style:
  // a bibliography is read by scanning author names down a straight left edge.
  const bibliography = styleXml(
    'Bibliography',
    'Bibliography',
    paragraphProperties({ hanging: true, spacing: { line: descriptor.spacing.line, lineRule: descriptor.spacing.lineRule, after: 0 } }, descriptor) +
      runProperties({ font, sizeHalfPoints: size }),
  )
  const footnoteText = styleXml('FootnoteText', 'footnote text', paragraphProperties({ spacing: { line: 240, lineRule: 'auto', after: 0 } }, descriptor) + runProperties({ sizeHalfPoints: 18 }))

  return (
    XML_DECLARATION +
    '<w:styles xmlns:w=' +
    xmlAttr(W_NAMESPACE) +
    '>' +
    docDefaults +
    normal +
    title +
    subtitle +
    author +
    affiliation +
    headings.join('') +
    quote +
    codeBlock +
    caption +
    bibliography +
    footnoteText +
    characterStyleXml('Hyperlink', 'Hyperlink', runProperties({ color: '0563C1', underline: 'single' })) +
    characterStyleXml('FootnoteReference', 'footnote reference', runProperties({ superscript: true })) +
    '</w:styles>'
  )
}

/* ------------------------------------------------------------------------- *
 * Footnotes
 * ------------------------------------------------------------------------- */

/**
 * The separator notes.
 *
 * Word reads the first two entries of `word/footnotes.xml` positionally, so these
 * come before the document's own notes whatever order the notes were collected in.
 */
function specialFootnote(id, type) {
  return (
    '<w:footnote w:type=' +
    xmlAttr(type) +
    ' w:id=' +
    xmlAttr(String(id)) +
    '><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:r><w:separator/></w:r></w:p></w:footnote>'
  )
}

/** The `<w:rPr>` of one footnote run: a code span keeps its monospaced font. */
function noteRunProperties(run) {
  return run.code === true ? '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>' : ''
}

/** `word/footnotes.xml`: the two separators, then one `w:footnote` per note. */
export function footnotesXml(notes) {
  const body = [specialFootnote(-1, 'separator'), specialFootnote(0, 'continuationSeparator')]
  for (const note of notes) {
    const runs = note.runs
      .map((run) => '<w:r>' + noteRunProperties(run) + wText(run.text) + '</w:r>')
      .join('')
    body.push(
      '<w:footnote w:id=' +
        xmlAttr(String(note.id)) +
        '><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>' +
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
        '<w:r>' +
        wText(' ') +
        '</w:r>' +
        runs +
        '</w:p></w:footnote>',
    )
  }
  return XML_DECLARATION + '<w:footnotes xmlns:w=' + xmlAttr(W_NAMESPACE) + '>' + body.join('') + '</w:footnotes>'
}

/* ------------------------------------------------------------------------- *
 * The body
 * ------------------------------------------------------------------------- */

/** The `<w:rPr>` of one text run, in OOXML's own child order: rFonts, b, i. */
function textRunProperties(run) {
  const parts = []
  if (run.code === true) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (run.bold === true) parts.push('<w:b/>', '<w:bCs/>')
  if (run.italic === true) parts.push('<w:i/>', '<w:iCs/>')
  return parts.length === 0 ? '' : '<w:rPr>' + parts.join('') + '</w:rPr>'
}

/** The DrawingML for one inline image, at the size its pixels and dpi imply. */
function drawingXml(image) {
  const extent = image.extentEmu
  return (
    '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' +
    extent.cx +
    '" cy="' +
    extent.cy +
    '"/>' +
    '<wp:docPr id="' +
    image.docPrId +
    '" name=' +
    xmlAttr('Picture ' + image.docPrId) +
    ' descr=' +
    xmlAttr(image.alt) +
    '/>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr><pic:cNvPr id="' +
    image.docPrId +
    '" name=' +
    xmlAttr(image.name) +
    '/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed=' +
    xmlAttr(image.relId) +
    '/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' +
    extent.cx +
    '" cy="' +
    extent.cy +
    '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
  )
}

/**
 * One run list as `w:r` elements.
 *
 * An image with no embedded data is not a run at all: it is a report, and its alt
 * text becomes the caption the caller writes in its place. That is the difference
 * between a document with a missing picture and a document Word calls damaged.
 */
function runsXml(runs, plan, report, line) {
  const parts = []
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (run.type === 'break') {
      parts.push('<w:r><w:br/></w:r>')
      continue
    }
    if (run.type === 'note') {
      const note = plan.notes.get(run.number)
      if (note === null || note === undefined) {
        // A reference with no definition is REPORTED, never invented: an empty
        // footnote would read as a source nobody can see. It is reported ONCE per
        // number, because the same `[^3]` twice is one hole in the document.
        if (!report.reportedNotes.has(run.number)) {
          report.reportedNotes.add(run.number)
          report.missingNotes.push({ number: run.number, line })
        }
        parts.push('<w:r>' + wText('[^' + run.number + ']') + '</w:r>')
        continue
      }
      parts.push('<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id=' + xmlAttr(String(note.id)) + '/></w:r>')
      continue
    }
    if (run.type === 'image') {
      const image = plan.imageFor(run.src)
      if (image === undefined) {
        report.missingImages.push({ src: run.src, alt: run.alt, line })
        continue
      }
      // An image inside a sentence is drawn like a figure, and counted like one.
      report.images += 1
      parts.push('<w:r>' + drawingXml({ ...image, alt: xmlStrip(run.alt) }) + '</w:r>')
      continue
    }
    if (run.type === 'link') {
      const link = plan.links.find((one) => one.url === run.href)
      const inner = runsXml(run.runs, plan, report, line)
      if (link === undefined) parts.push(inner)
      else parts.push('<w:hyperlink r:id=' + xmlAttr(link.id) + ' w:history="1">' + inner + '</w:hyperlink>')
      continue
    }
    const text = run.type === 'code' ? run.text : run.type === 'text' ? run.text : ''
    if (text === '') continue
    parts.push('<w:r>' + textRunProperties(run) + wText(text) + '</w:r>')
  }
  return parts.join('')
}

/** A `w:val` on `w:jc`, from GFM's alignment token. */
function justificationOf(align) {
  if (align === 'center') return 'center'
  if (align === 'right') return 'right'
  return 'left'
}

/** The `<w:numPr>` a list paragraph carries, from its level. */
function listProperties(ordered, level) {
  return '<w:numPr><w:ilvl w:val="' + level + '"/><w:numId w:val="' + (ordered === true ? 2 : 1) + '"/></w:numPr>'
}

/** One list, as paragraphs: each item at its own level, and its children below it. */
function listXml(block, plan, report, styleOfBlock) {
  const parts = []
  const emit = (item, level) => {
    const style = styleOfBlock(item)
    const properties =
      '<w:pPr>' + listProperties(block.ordered, level) + (style === null ? '' : '<w:pStyle w:val=' + xmlAttr(style) + '/>') + '</w:pPr>'
    parts.push('<w:p>' + properties + runsXml(item.runs, plan, report, item.line) + '</w:p>')
    report.paragraphs.push({ style, text: item.text })
    for (const child of item.children) emit(child, 1)
  }
  for (const item of block.items) emit(item, 0)
  return parts.join('')
}

/** A table: a `w:tbl` with a grid, a repeating header row, and one row per record. */
function tableXml(block, plan, report, contentWidth) {
  const columns = Math.max(block.align.length, 1)
  // A cell width of `NaN` is not a rounding error: `w:w="NaN"` is not a number to
  // Word or to pandoc, and pandoc drops the whole table rather than complaining.
  const width = Math.max(1, Math.floor(contentWidth / columns))
  const cell = (runs, align) =>
    '<w:tc><w:tcPr><w:tcW w:w="' +
    width +
    '" w:type="dxa"/></w:tcPr>' +
    '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val=' +
    xmlAttr(justificationOf(align)) +
    '/></w:pPr>' +
    runsXml(runs, plan, report, block.line) +
    '</w:p></w:tc>'
  const row = (cells, header) =>
    '<w:tr>' + (header ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + cells.map((runs, index) => cell(runs, block.align[index])).join('') + '</w:tr>'
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>' +
    '</w:tblPr><w:tblGrid>' +
    Array.from({ length: columns }, () => '<w:gridCol w:w="' + width + '"/>').join('') +
    '</w:tblGrid>' +
    row(block.head, true) +
    block.rows.map((cells) => row(cells, false)).join('') +
    '</w:tbl>' +
    // Word merges two adjacent tables into one unless a paragraph separates them,
    // and a merged table is not what the Markdown said.
    '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p>'
  )
}

/** The body of `word/document.xml`, with the section properties the style sets. */
export function documentXml(body, descriptor, toc) {
  const section =
    '<w:sectPr><w:pgSz w:w="' +
    descriptor.page.width +
    '" w:h="' +
    descriptor.page.height +
    '"/>' +
    '<w:pgMar w:top="' +
    descriptor.margins.top +
    '" w:right="' +
    descriptor.margins.right +
    '" w:bottom="' +
    descriptor.margins.bottom +
    '" w:left="' +
    descriptor.margins.left +
    '" w:header="720" w:footer="720" w:gutter="0"/>' +
    '<w:cols w:space="720" w:num="' +
    descriptor.columns +
    '"/>' +
    '<w:docGrid w:linePitch="360"/></w:sectPr>'
  const contents = toc
    ? '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r>' +
      wText('Contents') +
      '</w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r>' +
      wText('Update this field in Word.') +
      '</w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    : ''
  return (
    XML_DECLARATION +
    '<w:document xmlns:w=' +
    xmlAttr(W_NAMESPACE) +
    ' xmlns:r=' +
    xmlAttr(R_NAMESPACE) +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    '<w:body>' +
    contents +
    body.join('') +
    section +
    '</w:body></w:document>'
  )
}

/* ------------------------------------------------------------------------- *
 * The parts, assembled
 * ------------------------------------------------------------------------- */

/** The extension a source name implies, lowercased, or the image default. */
export function extensionOf(src) {
  const name = String(src ?? '').split(/[?#]/)[0]
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  const extension = match === null ? '' : match[1].toLowerCase()
  return IMAGE_TYPES[extension] === undefined ? DEFAULT_IMAGE_EXTENSION : extension
}

/** The name an image is stored under inside the package. */
function mediaName(index, extension) {
  return 'image' + index + '.' + extension
}

/**
 * Every image in the run model, as a relationship and a target.
 *
 * Sorted by source name and numbered from 1, because the relationship id and the
 * stored name are what make a document byte-identical between two builds.
 */
export function imagePlan(images) {
  return [...images]
    .sort((left, right) => (left.src < right.src ? -1 : left.src > right.src ? 1 : 0))
    .map((image, index) => ({
      src: image.src,
      extension: extensionOf(image.src),
      name: mediaName(index + 1, extensionOf(image.src)),
      target: 'media/' + mediaName(index + 1, extensionOf(image.src)),
      storedAs: 'word/media/' + mediaName(index + 1, extensionOf(image.src)),
      docPrId: index + 1,
      id: 'rId' + (5 + index),
      extentEmu: image.extentEmu,
      bytes: image.data,
    }))
}

/** The images a run list uses, in reading order, appending to `found`. */
function imagesIn(runs, found) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (run.type === 'image' && !found.includes(run.src)) found.push(run.src)
    else if (run.type === 'link') imagesIn(run.runs, found)
  }
}

/** The link targets a run list uses, in reading order, appending to `found`. */
function linksIn(runs, found) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (run.type === 'link') {
      if (!found.includes(run.href)) found.push(run.href)
      linksIn(run.runs, found)
    }
  }
}

/** Every run list a block holds, so image and link plans can be gathered first. */
function runListsOf(blocks) {
  const lists = []
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'blockquote') lists.push(block.runs)
    else if (block.type === 'list') {
      for (const item of block.items) {
        lists.push(item.runs)
        for (const child of item.children) lists.push(child.runs)
      }
    } else if (block.type === 'table') {
      lists.push(...block.head, ...block.rows.flat())
    }
  }
  return lists
}

/**
 * Every image source a document shows, in reading order.
 *
 * A figure is an image on its own line, which the parser promotes to a block: its
 * source is not in any run list, so gathering only run lists would leave the one
 * image a document is most likely to have without a relationship.
 */
function imageSourcesOf(blocks, runLists) {
  const found = []
  for (const block of blocks) {
    if (block.type === 'figure' && !found.includes(block.src)) found.push(block.src)
  }
  for (const runs of runLists) imagesIn(runs, found)
  return found
}

/**
 * Build every part of a document.
 *
 * @param options - the block model plus the title block fields and the resolved
 *                  images, all already normalised by the caller.
 * @returns `{ parts, plan, report }` where `parts` is an ordered list of
 *          `[name, text]`, ready for the ZIP writer, and `report` carries the
 *          counts and the two things this writer refuses to invent.
 */
export function buildParts(options) {
  const descriptor = paperStyleOf(options.style)
  const blocks = options.blocks
  const runLists = runListsOf(blocks)
  // A table is laid out inside the text column, which is the page less its
  // margins: a grid wider than the column is a table Word pushes off the page.
  const contentWidth = descriptor.page.width - descriptor.margins.left - descriptor.margins.right

  const linkUrls = []
  for (const runs of runLists) linksIn(runs, linkUrls)
  const links = linkUrls.map((url, index) => ({ id: 'rId' + (5 + index), url }))
  // Only the images the document actually shows become relationships: an image the
  // caller passed but no line references is not a part of this package.
  const imageSources = imageSourcesOf(blocks, runLists)
  const images = imagePlan(options.images.filter((one) => imageSources.includes(one.src)))
  const imageExtensions = [...new Set(images.map((one) => one.extension))].sort()

  const report = { headings: 0, paragraphs: [], missingNotes: [], missingImages: [], footnotes: [], tables: 0, images: 0, reportedNotes: new Set() }
  const plan = {
    links,
    images,
    notes: new Map(),
    imageFor(src) {
      return images.find((one) => one.src === src)
    },
  }

  // Footnotes are numbered from the REFERENCES, in reading order, and a definition
  // the document never refers to stays out of the document - it is not a note.
  const referenced = []
  for (const runs of runLists) gatherNotes(runs, referenced)
  const definitions = options.definitions ?? new Map()
  for (let index = 0; index < referenced.length; index += 1) {
    const number = referenced[index]
    if (plan.notes.has(number)) continue
    const text = definitions.get(number)
    if (text === undefined) {
      plan.notes.set(number, null)
      report.reportedNotes.add(number)
      report.missingNotes.push({ number, line: options.noteLines?.get(number) ?? 0 })
      continue
    }
    const note = { id: plan.notes.size + 1, number, runs: noteRuns(text) }
    plan.notes.set(number, note)
    report.footnotes.push(note)
  }

  const styleOfBlock = referenceStyleRule(blocks, options.referencesHeading)

  const body = []
  const record = (style, text) => report.paragraphs.push({ style, text })

  // The title block: title, subtitle, authors, affiliation, in that order, because
  // that is the order a first page reads in every one of the six styles.
  const titleLines = [
    ['Title', options.title],
    ['Subtitle', options.subtitle],
  ]
  for (const [style, value] of titleLines) {
    if (typeof value !== 'string' || value.trim() === '') continue
    body.push(paragraph(style, null, [{ type: 'text', text: value.trim() }], plan, report, 1))
    record(style, value.trim())
  }
  for (const one of Array.isArray(options.authors) ? options.authors : []) {
    if (typeof one !== 'string' || one.trim() === '') continue
    body.push(paragraph('Author', null, [{ type: 'text', text: one.trim() }], plan, report, 1))
    record('Author', one.trim())
  }
  if (typeof options.affiliation === 'string' && options.affiliation.trim() !== '') {
    body.push(paragraph('Affiliation', null, [{ type: 'text', text: options.affiliation.trim() }], plan, report, 1))
    record('Affiliation', options.affiliation.trim())
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      report.headings += 1
      const style = 'Heading' + Math.min(Math.max(block.level, 1), 6)
      body.push(paragraph(style, null, block.runs, plan, report, block.line))
      record(style, block.text)
      continue
    }
    if (block.type === 'rule') {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>')
      record(null, '')
      continue
    }
    if (block.type === 'code') {
      for (const line of String(block.text ?? '').split('\n')) {
        body.push(paragraph('CodeBlock', null, [{ type: 'text', text: line === '' ? ' ' : line }], plan, report, block.line))
        record('CodeBlock', line)
      }
      continue
    }
    if (block.type === 'figure') {
      const image = plan.imageFor(block.src)
      if (image === undefined) {
        // A figure is its own block, so its missing bytes are NOT reported by
        // `runsXml` - there is no run to write. This is where it is reported, and
        // the branch is one of exactly two places a missing image is named.
        report.missingImages.push({ src: block.src, alt: block.alt, line: block.line })
        body.push(paragraph('Caption', null, [{ type: 'text', text: block.alt }], plan, report, block.line))
        record('Caption', block.alt)
      } else {
        // `images` counts what is ON THE PAGE, not what the Markdown asked for: it
        // is the number a reader would count, and every missing one is already
        // named in `unsupported` by its source.
        report.images += 1
        body.push(
          '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr><w:r>' +
            drawingXml({ ...image, alt: xmlStrip(block.alt) }) +
            '</w:r></w:p>',
        )
        record('Caption', block.alt)
      }
      continue
    }
    if (block.type === 'table') {
      report.tables += 1
      body.push(tableXml(block, plan, report, contentWidth))
      record(null, '')
      continue
    }
    if (block.type === 'list') {
      body.push(listXml(block, plan, report, styleOfBlock))
      continue
    }
    if (block.type === 'paragraph' || block.type === 'blockquote') {
      const style = styleOfBlock(block)
      body.push(paragraph(style, null, block.runs, plan, report, block.line))
      record(style, block.text)
    }
  }

  const parts = [
    ['[Content_Types].xml', contentTypes({ imageExtensions })],
    ['_rels/.rels', packageRels()],
    ['docProps/app.xml', appProperties()],
    ['docProps/core.xml', coreProperties({ created: options.created, title: options.title, authors: options.authors })],
    ['word/_rels/document.xml.rels', documentRels(plan)],
    ['word/document.xml', documentXml(body, descriptor, options.toc === true)],
    ['word/footnotes.xml', footnotesXml(report.footnotes)],
    ['word/numbering.xml', numbering()],
    ['word/settings.xml', settings()],
    ['word/styles.xml', stylesXml(descriptor)],
  ]
  return { parts, plan, report }
}

/** One paragraph, styled, from its runs. */
function paragraph(style, align, runs, plan, report, line) {
  const properties =
    (style === null ? '' : '<w:pStyle w:val=' + xmlAttr(style) + '/>') + (align === null ? '' : wVal('w:jc', align))
  return '<w:p>' + (properties === '' ? '' : '<w:pPr>' + properties + '</w:pPr>') + runsXml(runs, plan, report, line) + '</w:p>'
}

/** The note numbers a run list refers to, in reading order, appending to `found`. */
function gatherNotes(runs, found) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (run.type === 'note' && !found.includes(run.number)) found.push(run.number)
    else if (run.type === 'link') gatherNotes(run.runs, found)
  }
}

/** One footnote definition's text as runs, so an italic mark survives into the note. */
function noteRuns(text) {
  const runs = []
  const source = String(text ?? '')
  let cursor = 0
  for (const match of source.matchAll(/\*([^*\n]+)\*/g)) {
    if (match.index > cursor) runs.push({ text: source.slice(cursor, match.index) })
    runs.push({ text: match[1], italic: true })
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) runs.push({ text: source.slice(cursor) })
  return runs.length === 0 ? [{ text: source }] : runs
}

/**
 * The positional rule that gives the reference list its style.
 *
 * From the heading whose text equals the run's reference heading - case
 * insensitively, because a heading is prose and the option is a key - every
 * paragraph for the REST of the document is an entry: after a heading in a list,
 * in a blockquote, anywhere. Nothing before it is affected, which is the whole
 * point of the rule being positional rather than a guess about shape.
 *
 * @returns a function from a block (or list item) to the style name, or null.
 */
export function referenceStyleRule(blocks, referencesHeading) {
  const wanted = String(referencesHeading ?? 'References').trim().toLowerCase()
  const styles = new Map()
  let references = false
  const visit = (block) => {
    if (block.type === 'heading') {
      if (String(block.text ?? '').trim().toLowerCase() === wanted) references = true
      return
    }
    if (block.type === 'paragraph' || block.type === 'blockquote') {
      styles.set(block, references ? 'Bibliography' : null)
      return
    }
    if (block.type === 'list') {
      for (const item of block.items) {
        styles.set(item, references ? 'Bibliography' : null)
        for (const child of item.children) styles.set(child, references ? 'Bibliography' : null)
      }
    }
  }
  for (const block of blocks) visit(block)
  return (block) => styles.get(block) ?? null
}
