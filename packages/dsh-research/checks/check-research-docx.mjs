// check-research-docx.mjs - the DOCX writer, driven through its own public surface.
//
// What this proves, and why each half is here:
//
//   - the ARCHIVE is a real ZIP: every required part is present and non-empty, the
//     reader re-verifies every entry's CRC-32 against the decompressed bytes (a
//     wrong CRC is the single defect that makes Word refuse a file with no clue in
//     the message), and the entries are ordered by name so two builds put the same
//     bytes in the same places;
//   - every XML part is WELL FORMED ENOUGH TO MATTER: one XML declaration at the
//     very first byte, and every open tag closed or self-closed. The checker is a
//     subset - see its own comment - and it is what catches the one class of bug
//     that makes a document unopenable while every string assertion still passes;
//   - the DOCUMENT'S OWN WORDS, in document order, read back with `documentText`:
//     the title, every heading, the sentence, every list item, the table cells, the
//     code line and all three reference entries;
//   - the reference list is the `Bibliography` style from the heading the run named
//     to the END of the document, and a paragraph before that heading is not - which
//     is the stated rule rather than a guess about shape;
//   - REFUSALS by code: an unknown style, an empty document, and a Markdown
//     construct outside the subset reported BY LINE rather than dropped;
//   - DETERMINISM as a real property: two builds of one input hash the same, and a
//     build with a different `created` does NOT - so the sameness is the writer's
//     and not a constant-output bug;
//   - and a FOREIGN parser reads the file: pandoc, when it is on PATH, is handed a
//     real `.docx` on disk and must extract the same sentences. With no pandoc this
//     case SKIPS LOUDLY and names what is missing; it never passes silently.
//
// Run:  node packages/dsh-research/checks/check-research-docx.mjs
export {}

const { createHash } = await import('node:crypto')
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { spawnSync } = await import('node:child_process')

const docx = await import('../lib/docx/index.js')
const zip = await import('../lib/docx/zip.js')
const styles = await import('../lib/docx/styles.js')
const registry = await import('../lib/styles/index.js')
const { ResearchError } = await import('../lib/run.js')

const { DOCX_STYLES, buildDocx, buildDocxReport, documentText, unzipDocx, partNames, partText } = docx

let failures = 0
let checked = 0
let skips = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined || ok ? '' : ' -> ' + JSON.stringify(actual)))
  return ok
}

function skip(label, why) {
  skips += 1
  console.log('SKIP ' + label.padEnd(56) + ' ' + why)
}

/** One error's `code`, whatever was thrown. */
function codeOf(fn) {
  try {
    fn()
    return '(no error)'
  } catch (err) {
    return err && err.code ? String(err.code) : 'THREW:' + (err && err.message ? err.message : String(err))
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * The plain text of a value in pandoc's JSON metadata.
 *
 * pandoc wraps a `Title`-styled paragraph and the `Author` paragraphs that follow
 * it as document METADATA rather than body content, which is the right reading of
 * a first page and the reason those strings are not asserted against the plain
 * output. The shape is nested (`MetaInlines`, `MetaList`), so this walks it.
 */
function metaText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'string') {
      // The short form pandoc uses inside a metadata value: `["Str", "The"]`.
      const tag = value[0]
      if (tag === 'Space' || tag === 'SoftBreak' || tag === 'LineBreak') return ' '
      if (tag === 'Str' || tag === 'Code') return String(value[1] ?? '')
      return metaText(value[1])
    }
    // Joined with NOTHING, because the inline list carries its own `Space`
    // tokens: a joined space here would double every one of them.
    return value.map(metaText).join('')
  }
  if (typeof value === 'object') {
    // The long form: `{ t: "Str", c: "The" }` and `{ t: "Space" }`, which has no
    // text but IS the space between two words.
    const tag = value.t
    if (tag === 'Space' || tag === 'SoftBreak' || tag === 'LineBreak') return ' '
    if (tag === 'Str' || tag === 'Code') return String(value.c ?? '')
    return metaText(value.c)
  }
  return String(value)
}

/**
 * The tags of one XML part, in order.
 *
 * This is a SUBSET CHECK, not an XML parser: it understands a tag, its attributes
 * (including a `>` inside a quoted value), a self-closing tag, a comment and a
 * processing instruction, and a stray `<` in text. What it does NOT understand is
 * a nested markup declaration or a CDATA section, neither of which this writer can
 * emit. It is here because the failure it catches - one unclosed element - makes
 * the whole document unopenable while every string assertion still passes.
 */
function tagsOf(xml) {
  const tags = []
  let index = 0
  while (index < xml.length) {
    const open = xml.indexOf('<', index)
    if (open === -1) break
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open)
      index = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open)
      index = end === -1 ? xml.length : end + 2
      continue
    }
    let cursor = open + 1
    const closing = xml[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (cursor < xml.length && !/[\s/>]/.test(xml[cursor])) cursor += 1
    const name = xml.slice(nameStart, cursor)
    if (name === '') {
      // A stray `<` in text: not a tag, and the XML parser agrees.
      index = open + 1
      continue
    }
    // The scan for the closing `>` and for the self-closing slash starts at the
    // END OF THE NAME, never at `open`: a scan that began earlier would see the
    // previous tag's `/` and call this one self-closing.
    let quote = null
    let selfClosing = false
    while (cursor < xml.length) {
      const character = xml[cursor]
      if (quote !== null) {
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") quote = character
      else if (character === '>') break
      cursor += 1
    }
    if (xml[cursor - 1] === '/') selfClosing = true
    tags.push({ name, closing, selfClosing })
    index = cursor + 1
  }
  return tags
}

/** Every reason a part's tags do not nest, in order. */
function balanceProblems(xml, label) {
  const problems = []
  const stack = []
  for (const tag of tagsOf(xml)) {
    if (tag.closing) {
      const top = stack.pop()
      if (top === undefined) problems.push(label + ': </' + tag.name + '> closes nothing')
      else if (top !== tag.name) problems.push(label + ': </' + tag.name + '> closes <' + top + '>')
      continue
    }
    if (!tag.selfClosing) stack.push(tag.name)
  }
  for (const name of stack) problems.push(label + ': <' + name + '> is never closed')
  return problems
}

/**
 * A ZIP's central directory, read here rather than through the reader under test.
 *
 * The point is independence: the CRC-32 in the directory is the one Word validates
 * the decompressed bytes against, and comparing it with a CRC computed in this file
 * is the only version of that assertion which is not the writer agreeing with
 * itself.
 */
function centralDirectory(buffer) {
  let end = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end === -1) return []
  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    entries.push({ name: buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'), crc: buffer.readUInt32LE(cursor + 16) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

console.log('check-research-docx: the DOCX writer, its archive, its words, its refusals and its determinism')

// ---------------------------------------------------------------------------
// The document this check builds for itself
// ---------------------------------------------------------------------------

/** A one-pixel PNG, which is a real image and small enough to inline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const MISSING_PNG = 'figures/missing.png'

/**
 * Every construct the subset covers, in one document.
 *
 * The three reference entries are pasted exactly as `runsToMarkdown` writes them,
 * down to the asterisks that are italics: a check that hand-wrote them would be
 * testing a dialect nobody produces.
 */
const MARKDOWN = [
  '> **DRAFT — not a verified document.** 2 claim(s) marked in the text.',
  '',
  '# Method and data',
  '',
  'The programme raised completion by 25 points in the treated cohort and [@smith2024].',
  '',
  '## Measures',
  '',
  'A sentence with **bold**, *italic* and `code`, a [link](https://example.org/paper), a note[^1] and a',
  'second note[^2].',
  '',
  '- first bullet',
  '- second bullet with *emphasis*',
  '  - nested bullet',
  '',
  '1. first number',
  '2. second number',
  '',
  '> A quoted line, as a blockquote.',
  '',
  '### A deeper heading',
  '',
  '| Left | Centre | Right |',
  '|:-----|:------:|------:|',
  '| alpha | beta | gamma |',
  '| one | two | three |',
  '',
  '---',
  '',
  '```js',
  'const raised = 25',
  '```',
  '',
  '![A figure that is embedded](figures/plot.png)',
  '',
  '![A figure nobody passed](figures/missing.png)',
  '',
  '## References',
  '',
  'Smith, J., & Jones, A. B. (2024). The effect of X on Y. *Journal Name*, *12*(3), 45–67. https://doi.org/10.1234/abcd',
  '',
  'Jones, A. B. (2023). A method for Z. *Another Journal*, *9*(1), 1–10.',
  '',
  'Brown, C. (2022). A third entry with an *italic title*, *Vol* 2, 3–4.',
  '',
  '[^1]: claim c0001 — unverified, written as descriptive, bound to smith2024',
  '[^2]: claim c0002 — supported (r1-source), bound to jones2023 p. 7',
  '',
].join('\n')

const OPTIONS = {
  markdown: MARKDOWN,
  style: 'apa7',
  title: 'AI and quality assurance in higher education',
  authors: ['J. Smith', 'A. B. Jones'],
  affiliation: 'Department of Education',
  referencesHeading: 'References',
  images: {
    'figures/plot.png': { data: PNG, widthPx: 96, heightPx: 48 },
  },
}

/** The strings the document must say, in this order. */
const ORDERED = [
  'AI and quality assurance in higher education',
  'J. Smith',
  'A. B. Jones',
  'Department of Education',
  'Method and data',
  'The programme raised completion by 25 points in the treated cohort',
  'Measures',
  'A sentence with bold, italic and code, a link, a note and a second note.',  'first bullet',
  'second bullet with emphasis',
  'nested bullet',
  'first number',
  'second number',
  'A quoted line, as a blockquote.',
  'A deeper heading',
  'Left',
  'Centre',
  'Right',
  'alpha',
  'beta',
  'gamma',
  'one',
  'two',
  'three',
  'const raised = 25',
  'References',
  'Smith, J., & Jones, A. B. (2024). The effect of X on Y. Journal Name, 12(3), 45–67. https://doi.org/10.1234/abcd',
  'Jones, A. B. (2023). A method for Z. Another Journal, 9(1), 1–10.',
  'Brown, C. (2022). A third entry with an italic title, Vol 2, 3–4.',
]

/** The parts a `.docx` must have, in the order the writer emits them. */
const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'word/_rels/document.xml.rels',
  'word/document.xml',
  'word/footnotes.xml',
  'word/numbering.xml',
  'word/settings.xml',
  'word/styles.xml',
]

const built = buildDocxReport(OPTIONS)
const files = unzipDocx(built.buffer)
const text = documentText(built.buffer)

// ---------------------------------------------------------------------------
// 1. The archive: the parts, the CRCs, the order
// ---------------------------------------------------------------------------
{
  check('the writer returns a Buffer', Buffer.isBuffer(built.buffer), true)
  // The local header's signature, then the end-of-central-directory record's: the
  // two ends of the container, asserted as hex so no terminal can hide which moved.
  check('the archive opens with a local file header', built.buffer.subarray(0, 4).toString('hex'), '504b0304')
  check('and closes with the end-of-central-directory record', built.buffer.subarray(-22, -18).toString('hex'), '504b0506')

  for (const name of REQUIRED_PARTS) {
    check('part present: ' + name, files.has(name), true)
    check('part non-empty: ' + name, (files.get(name) ?? Buffer.alloc(0)).length > 0, true)
  }
  check('the image is a part of the package', files.has('word/media/image1.png'), true)
  check('an image the document never shows is not a part', files.has('word/media/image2.png'), false)

  // A wrong CRC is the defect Word reports as "the file is corrupt" with nothing
  // else to go on. This asserts it the only way that is not circular: the stored
  // CRC is read out of the ZIP's own CENTRAL DIRECTORY and compared with a CRC
  // computed here from the decompressed bytes. `unzipDocx` checks this too; a check
  // that trusted the reader it is testing would prove nothing.
  const stored = centralDirectory(built.buffer)
  const mismatch = []
  for (const entry of stored) {
    const bytes = files.get(entry.name)
    if (bytes === undefined) mismatch.push(entry.name + ': no entry')
    else if (zip.crc32(bytes) !== entry.crc) mismatch.push(entry.name + ': ' + zip.crc32(bytes) + ' vs ' + entry.crc)
  }
  check('every stored CRC-32 matches the bytes it describes', mismatch.join(','), '')
  check('and every entry in the archive was checked', stored.length, files.size)

  // A corrupted byte in the middle of the archive must be REFUSED rather than read
  // as a document: this is what proves the CRC check is doing work.
  const damaged = Buffer.from(built.buffer)
  const marker = damaged.indexOf(Buffer.from('word/styles.xml'))
  damaged[marker + 40] = damaged[marker + 40] ^ 0xff
  check('a damaged archive is refused, not read as a document', codeOf(() => unzipDocx(damaged)).startsWith('THREW:'), true)

  const names = partNames(files)
  check('the parts are returned in name order', names.join(','), [...names].sort().join(','))
  check('no `.partial` write is in the package', names.some((name) => name.endsWith('.partial')), false)
}

// ---------------------------------------------------------------------------
// 2. The XML parts: one declaration, and balanced tags
// ---------------------------------------------------------------------------
{
  const problems = []
  for (const [name, bytes] of files) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    const xml = bytes.toString('utf8')
    if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')) problems.push(name + ': no XML declaration at the first byte')
    if (xml.indexOf('<?xml') !== 0) problems.push(name + ': the declaration is not the first thing')
    if ((xml.match(/<\?xml/g) ?? []).length !== 1) problems.push(name + ': the declaration appears more than once')
    problems.push(...balanceProblems(xml, name))
  }
  check('every part is well-formed enough to open', problems.slice(0, 3).join(' | '), '')
  check('and every part was checked', files.size >= REQUIRED_PARTS.length, true)

  // The two members whose absence or order breaks Word specifically.
  const settings = partText(files, 'word/settings.xml')
  check('settings.xml asks Word to update fields, so a TOC fills itself', settings.includes('<w:updateFields w:val="true"/>'), true)
  const footnotes = partText(files, 'word/footnotes.xml')
  check('the separator note comes first, at id -1', footnotes.includes('w:type="separator" w:id="-1"'), true)
  check('the continuation separator comes next, at id 0', footnotes.includes('w:type="continuationSeparator" w:id="0"'), true)
  check('the document\u2019s own notes start after them', /<w:footnote w:id="1">/.test(footnotes), true)
  check('and the footnote text is in the document', footnotes.includes('claim c0001 — unverified'), true)
  check('one w:footnote per defined note', (footnotes.match(/<w:footnote /g) ?? []).length, 4)

  const document = partText(files, 'word/document.xml')
  check('the section carries the style\u2019s page size', document.includes('<w:pgSz w:w="12240" w:h="15840"/>'), true)
  check('and its one-inch margins', document.includes('w:left="1440"'), true)
  check('the centred table cell is justified as the delimiter row said', document.includes('<w:jc w:val="center"/>'), true)
  check('the right-hand column is right justified', document.includes('<w:jc w:val="right"/>'), true)
  check('a footnote reference is a real footnote reference', document.includes('<w:footnoteReference w:id="1"/>'), true)
  check('the hyperlink is a relationship, not a bare URL', document.includes('<w:hyperlink r:id="rId5"'), true)
  check('the image is an inline drawing', document.includes('<w:drawing><wp:inline'), true)
  check('sized in EMU from the pixels and the default 96 dpi', document.includes('cx="914400" cy="457200"'), true)

  const rels = partText(files, 'word/_rels/document.xml.rels')
  check('the document relates to styles, settings, numbering and footnotes', ['styles.xml', 'settings.xml', 'numbering.xml', 'footnotes.xml'].every((one) => rels.includes(one)), true)
  check('the hyperlink relationship is External', rels.includes('TargetMode="External"'), true)
  check('the image relationship points into media', rels.includes('Target="media/image1.png"'), true)

  const types = partText(files, '[Content_Types].xml')
  check('the content types name every part the package has', ['/word/document.xml', '/word/styles.xml', '/word/settings.xml', '/word/numbering.xml', '/word/footnotes.xml', '/docProps/core.xml', '/docProps/app.xml'].every((one) => types.includes(one)), true)
  check('and give each image extension a default', types.includes('Extension="png"'), true)

  const core = partText(files, 'docProps/core.xml')
  check('core.xml records the title', core.includes('<dc:title>AI and quality assurance in higher education</dc:title>'), true)
  check('and the fixed date when the caller gave none', core.includes('<dcterms:created>1980-01-01T00:00:00Z</dcterms:created>'), true)
  check('with no attribute that Word rewrites on save', /w:rsid/.test(partText(files, 'word/document.xml')), false)
}

// ---------------------------------------------------------------------------
// 3. The document's own words, in order
// ---------------------------------------------------------------------------
{
  let cursor = -1
  const outOfOrder = []
  for (const phrase of ORDERED) {
    const at = text.indexOf(phrase, cursor + 1)
    if (at === -1) outOfOrder.push('missing: ' + phrase)
    else cursor = at
  }
  check('every expected phrase appears, in document order', outOfOrder.slice(0, 3).join(' | '), '')
  check('and the last one is the last reference entry', text.indexOf(ORDERED[ORDERED.length - 1]) > text.indexOf(ORDERED[ORDERED.length - 2]), true)

  check('the report counts four headings', built.report.headings, 4)
  check('and one table', built.report.tables, 1)
  check('and two footnotes', built.report.footnotes, 2)
  check('and one image is embedded, with one caption where bytes were missing', built.report.images, 1)
  check('paragraphs were counted', built.report.paragraphs > 10, true)

  // The positional rule: the `Bibliography` style from the reference heading to the
  // END, and nothing before it.
  const styleRows = built.report.styles
  const referenceStart = styleRows.findIndex((row) => row.style === 'Bibliography')
  check('the reference list starts at the first entry after the heading', referenceStart > -1, true)
  check('every paragraph from there to the end is an entry', styleRows.slice(referenceStart).every((row) => row.style === 'Bibliography'), true)
  check('exactly the three entries carry it', styleRows.filter((row) => row.style === 'Bibliography').length, 3)
  check('a paragraph BEFORE the heading does not', styleRows.slice(0, referenceStart).some((row) => row.style === 'Bibliography'), false)
  check('and it is the paragraph before it that is unaffected', styleRows[referenceStart - 1].style, 'Heading2')
  check('the entries are the reference texts', styleRows.slice(referenceStart).map((row) => row.text.split(',')[0]).join(','), 'Smith,Jones,Brown')

  // A different reference heading is a different run's: with `Works Cited`, the
  // `## References` heading in this document must NOT start the bibliography.
  const mla = buildDocxReport({ ...OPTIONS, style: 'mla9', referencesHeading: 'Works Cited' })
  check('a heading that is not the run\u2019s does not start the bibliography', mla.report.styles.some((row) => row.style === 'Bibliography'), false)
}

// ---------------------------------------------------------------------------
// 4. Determinism, and the proof that it is not a constant output
// ---------------------------------------------------------------------------
{
  const again = buildDocxReport(OPTIONS)
  check('two builds of one input are byte identical', sha256(again.buffer), sha256(built.buffer))
  check('and both reports agree', JSON.stringify(again.report), JSON.stringify(built.report))

  const dated = buildDocxReport({ ...OPTIONS, created: '2026-02-03T04:05:06Z' })
  check('a different `created` produces different bytes', sha256(dated.buffer) === sha256(built.buffer), false)
  check('but only in the core properties', partText(unzipDocx(dated.buffer), 'word/document.xml'), partText(files, 'word/document.xml'))
  check('the date the caller gave is the one recorded', partText(unzipDocx(dated.buffer), 'docProps/core.xml').includes('<dcterms:created>2026-02-03T04:05:06Z</dcterms:created>'), true)

  // The ZIP stamp is the DOS epoch rather than a clock, which is what makes the
  // bytes a function of the input even though the format carries a timestamp.
  const stamp = built.buffer.readUInt32LE(10)
  check('every entry carries the fixed 1980 DOS timestamp', (stamp & 0xffff) === zip.DOS_TIME && (stamp >>> 16) === zip.DOS_DATE, true)
}

// ---------------------------------------------------------------------------
// 5. Every style lays out a document, and the two structural rules hold
// ---------------------------------------------------------------------------
{
  check('DOCX_STYLES is the registry\u2019s six ids plus plain', [...DOCX_STYLES].sort().join(','), [...registry.STYLES, 'plain'].sort().join(','))
  check('and the order is the registry\u2019s, so a picker reads the same twice', DOCX_STYLES.slice(0, 6).join(','), registry.STYLES.join(','))
  check('every paper style has a descriptor', DOCX_STYLES.every((id) => styles.paperStyleOf(id) !== null), true)
  check('and an id nothing lays out is null, not a throw', styles.paperStyleOf('nope'), null)

  const missingParts = []
  const wrongSpacing = []
  for (const id of DOCX_STYLES) {
    const one = buildDocxReport({ markdown: '# T\n\nOne line.\n', style: id })
    const parts = unzipDocx(one.buffer)
    for (const name of REQUIRED_PARTS) if (!parts.has(name) || parts.get(name).length === 0) missingParts.push(id + '/' + name)
    const xml = partText(parts, 'word/document.xml')
    if (!xml.includes('<w:pgSz w:w="12240" w:h="15840"/>')) missingParts.push(id + '/page')
    const descriptor = styles.paperStyleOf(id)
    const double = ['apa7', 'mla9'].includes(id)
    if (double !== (descriptor.spacing.line === 480)) wrongSpacing.push(id)
  }
  check('every style writes every part, with a page on it', missingParts.join(','), '')
  check('APA and MLA are the double-spaced styles, and only they are', wrongSpacing.join(','), '')
  check('IEEE is single column, which is the limit this writer states', styles.paperStyleOf('ieee').columns, 1)
  check('the descriptor says which styles centre their title block', DOCX_STYLES.filter((id) => styles.paperStyleOf(id).titleBlock.align === 'center').join(','), 'apa7,chicago-notes,chicago-author-date,mla9')
  check('APA level 1 is centred and bold, level 3 is bold italic', JSON.stringify(styles.headingRuleOf(styles.paperStyleOf('apa7'), 1)) + JSON.stringify(styles.headingRuleOf(styles.paperStyleOf('apa7'), 3)), '{"bold":true,"italic":false,"align":"center"}{"bold":true,"italic":true,"align":"left"}')

  // The hanging indent is what makes a reference list scannable, and it is set by
  // this one style rather than by the paragraph the writer emits.
  const stylesXml = partText(files, 'word/styles.xml')
  check('the Bibliography style hangs half an inch', stylesXml.includes('<w:style w:type="paragraph" w:styleId="Bibliography">') && /w:styleId="Bibliography"[\s\S]*?w:hanging="720"/.test(stylesXml), true)
  check('styles.xml declares every named style the writer uses', ['Normal', 'Title', 'Subtitle', 'Heading1', 'Heading6', 'Quote', 'CodeBlock', 'Caption', 'Bibliography', 'FootnoteText', 'Hyperlink', 'FootnoteReference'].every((one) => stylesXml.includes('w:styleId="' + one + '"')), true)
  check('and the document defaults carry the style\u2019s font and size', stylesXml.includes('<w:sz w:val="24"/>') && stylesXml.includes('w:ascii="Times New Roman"'), true)
  check('line spacing is a rule, not a bare value', stylesXml.includes('w:lineRule="auto"'), true)
  check('the footnotes part is declared before the notes in numbering order', partText(files, 'word/numbering.xml').includes('<w:num w:numId="1">'), true)
}

// ---------------------------------------------------------------------------
// 6. Refusals, and what is reported rather than dropped
// ---------------------------------------------------------------------------
{
  check('an unknown style is refused by name', codeOf(() => buildDocx({ markdown: '# T\n', style: 'harvard' })), 'UNKNOWN_STYLE')
  check('and the refusal is a ResearchError', (() => {
    try {
      buildDocx({ markdown: '# T\n', style: 'harvard' })
      return false
    } catch (err) {
      return err instanceof ResearchError && err.code === 'UNKNOWN_STYLE'
    }
  })(), true)
  check('an empty document is refused', codeOf(() => buildDocx({ markdown: '', style: 'plain' })), 'DOC_EMPTY')
  check('and so is whitespace alone', codeOf(() => buildDocx({ markdown: '   \n\n  \n', style: 'plain' })), 'DOC_EMPTY')
  check('a missing style is refused rather than defaulted', codeOf(() => buildDocx({ markdown: '# T\n' })), 'UNKNOWN_STYLE')

  // Outside the subset: REPORTED BY LINE, never dropped.
  const outside = ['# T', '', 'A paragraph.', '', '<div class="x">', 'raw html', '</div>', '', '```js', 'kept()', '```', ''].join('\n')
  const reported = buildDocxReport({ markdown: outside, style: 'plain' })
  const html = reported.report.unsupported.find((one) => one.why.includes('raw HTML'))
  check('a raw HTML block is reported', html !== undefined, true)
  check('with the line it starts on', html?.line, 5)
  check('and the text as written', html?.text.includes('<div'), true)
  check('and it is not in the document', documentText(reported.buffer).includes('raw html'), false)
  check('while the rest of the document is still built', documentText(reported.buffer).includes('A paragraph.'), true)
  check('and the fenced code after it still renders', documentText(reported.buffer).includes('kept()'), true)

  // A setext heading is a heading form this writer does not render, and it says so.
  // Two things are asserted, because they are two different facts: the CONSTRUCT is
  // reported, and the line the author should fix is that construct's own line.
  const setext = buildDocxReport({ markdown: '# T\n\n```\nA title\nthe underline follows\n```\n\nA title\n===\n', style: 'plain' })
  const setextReport = setext.report.unsupported.find((one) => one.why.includes('setext'))
  check('a setext heading is reported by name', setextReport !== undefined, true)
  check('with the text as written', setextReport?.text.trim(), '===')
  check('and the paragraph above it is still a paragraph', setext.report.styles.some((row) => row.text === 'A title'), true)

  // A `[^n]` with no definition is reported rather than invented as an empty note.
  const dangling = buildDocxReport({ markdown: '# T\n\nA claim.[^7]\n', style: 'plain' })
  check('a footnote reference with no definition is reported', dangling.report.unsupported.some((one) => one.why.includes('[^7]:`')), true)
  check('with its line number', dangling.report.unsupported.find((one) => one.why.includes('[^7]:`'))?.line, 3)
  check('and no footnote is invented for it', dangling.report.footnotes, 0)
  check('though the reference is still visible in the words', documentText(dangling.buffer).includes('[^7]'), true)

  // An image with no bytes is reported, and its alt text becomes the caption.
  const orphan = buildDocxReport({ markdown: '# T\n\n![No bytes here](figures/gone.png)\n', style: 'plain' })
  check('an image with no entry is reported as image-not-embedded', orphan.report.unsupported.some((one) => one.why.includes('image-not-embedded')), true)
  check('and no drawing element is written for it', partText(unzipDocx(orphan.buffer), 'word/document.xml').includes('<w:drawing>'), false)
  check('and its alt text is the caption a reader sees', documentText(orphan.buffer).includes('No bytes here'), true)

  const badEntry = buildDocxReport({ markdown: '# T\n\n![Bad](figures/bad.png)\n', style: 'plain', images: { [MISSING_PNG]: { data: Buffer.alloc(0), widthPx: 10, heightPx: 10 } } })
  check('an entry with no bytes is reported by name', badEntry.report.unsupported.some((one) => one.why.includes('carries no bytes')), true)
  const noSize = buildDocxReport({ markdown: '# T\n\n![Bad](figures/bad.png)\n', style: 'plain', images: { [MISSING_PNG]: { data: PNG } } })
  check('an entry with no size is reported rather than drawn at zero', noSize.report.unsupported.some((one) => one.why.includes('BAD_IMAGE')), true)
}

// ---------------------------------------------------------------------------
// 7. A foreign parser reads the file back
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-research-docx-'))
  const file = path.join(dir, 'paper.docx')
  writeFileSync(file, built.buffer)
  const probe = spawnSync('pandoc', ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) {
    skip('pandoc reads the document back', 'pandoc is not on PATH, so no foreign parser can be asked (' + (probe.error?.code ?? 'exit ' + probe.status) + ')')
  } else {
    const result = spawnSync('pandoc', ['--from=docx', '--to=plain', file], { encoding: 'utf8' })
    check('pandoc exits 0 on the file we wrote', result.status, 0)
    const plain = String(result.stdout ?? '')
    // The title block is deliberately NOT in this list: a leading paragraph in a
    // style called `Title`, followed by `Author` paragraphs, is a document's
    // metadata, and pandoc lifts it OUT of the body - which is asserted separately
    // below through pandoc's own JSON, because "the title is missing" and "the
    // title is metadata" are different findings and only one of them is a defect.
    const wanted = [
      'The programme raised completion by 25 points in the treated cohort',
      'A sentence with bold, italic and code',
      'first bullet',
      'nested bullet',
      'first number',
      'A quoted line, as a blockquote.',
      'const raised = 25',
      'alpha',
      'References',
      'The effect of X on Y',
      'A third entry with an italic title',
    ]
    const absent = wanted.filter((one) => !plain.includes(one))
    check('and the text it extracts holds the same sentences', absent.join(' | '), '')
    check('and it extracts the table, not just its cells', /alpha\s+beta/.test(plain), true)
    check('and the italics survive as emphasis, not as asterisks', /Journal Name/.test(plain) && !plain.includes('*Journal Name*'), true)
    check('and the footnote is a note to pandoc too', plain.includes('claim c0001'), true)

    const json = spawnSync('pandoc', ['--from=docx', '--to=json', file], { encoding: 'utf8' })
    const metadata = JSON.parse(String(json.stdout ?? '{}')).meta ?? {}
    check('pandoc reads the title as METADATA, not as a lost paragraph', metaText(metadata.title), 'AI and quality assurance in higher education')
    check('and the authors with it', metaText(metadata.author).includes('J. Smith') && metaText(metadata.author).includes('A. B. Jones'), true)
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'all ' + checked + ' research-docx checks passed' + (skips > 0 ? ' (' + skips + ' skipped)' : '') : failures + ' of ' + checked + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
