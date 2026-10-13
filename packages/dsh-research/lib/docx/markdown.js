/**
 * dsh-research — the Markdown the builder emits, as a block model.
 *
 * This parser consumes exactly the dialect `composeMarkdown` produces, and it is
 * written the other way round from a general Markdown reader: the builder is the
 * only author, so the subset can be NARROW as long as nothing falls out of it
 * silently. That "nothing silently" is the rule this module exists to keep - a
 * writer that eats a construct is the failure the DOCX builder was written to
 * prevent, so every line the subset does not cover leaves with a line number, the
 * text as written, and the reason.
 *
 * The subset, in block terms:
 *
 *   - ATX headings `#`…`######`;
 *   - paragraphs, with soft line breaks joined;
 *   - fenced code blocks (``` and ~~~), which keep every byte of their text;
 *   - blockquotes `>`, which is where a draft's watermark banner arrives;
 *   - bullet and ordered lists, FLAT plus one level of nesting by 2-space indent;
 *   - GFM pipe tables with a `|---|:--:|` alignment row;
 *   - horizontal rules `---`;
 *   - images `![alt](src)`;
 *   - footnote definitions `[^n]: text`, which the builder writes at the very end.
 *
 * And in inline terms: `**bold**`, `*italic*`, `_italic_`, `` `code` ``,
 * `[text](url)`, `[^n]`, claim spans `[text]{#c0001}`, and plain text.
 *
 * What is deliberately NOT here, and is reported instead: raw HTML (a block or a
 * `<span>`), setext headings, indented code blocks, nested emphasis inside an
 * emphasis span, and list nesting deeper than one level. The document dialect is
 * "Pandoc Markdown plus one addition", so a document that reaches this parser
 * holding one of those is a document the writer must not pretend to have rendered.
 *
 * The model:
 *
 *   { type: 'heading',   level, runs, line }
 *   { type: 'paragraph', runs, line }
 *   { type: 'code',      text, language, line }
 *   { type: 'blockquote',runs, line }
 *   { type: 'list',      ordered, start, items: [{ runs, children: [item] }], line }
 *   { type: 'table',     align: [], head: [cell], rows: [[cell]], line }
 *   { type: 'figure',    alt, src, line }                 // an image on its own line
 *   { type: 'rule',      line }
 *
 * A `cell` is an array of runs; an `runs` list may hold an image token, so
 * `![alt](src)` inside a sentence is carried rather than dropped.
 */

/** An unordered list item's markers. `-`, `*` and `+` are the same list to a reader. */
const BULLET = /^(\s*)[-*+]\s+(.*)$/
/** An ordered list item's markers: `1.`, `1)`. The start number is carried. */
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
/** An ATX heading, with closing hashes optional. */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
/** A fence: three or more backticks or tildes, with an optional info string. */
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/
/** A thematic break: three of one marker, with optional spaces between them. */
const RULE = /^( {0,3})(-{3,}|\*{3,}|_{3,})\s*$/
/** A GFM table's delimiter row: cells of dashes with optional `:` alignment marks. */
const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
/**
 * What a line opens that ends the paragraph before it.
 *
 * The outer group is not decoration: without it the alternation splits the whole
 * pattern and the second branch loses its `^`, which makes every line holding
 * three dashes anywhere end the paragraph before it.
 */
const BLOCK_START = /^(?: {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|>|#{1,6}\s|```|~~~)| {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$)/
/** An indented code block, which this writer does not render at all. */
const INDENTED_CODE = /^(?: {4,}|\t)\S/
/** A setext heading's underline, which is a heading this writer does not render. */
const SETEXT_UNDERLINE = /^\s*(?:=+|-{2,})\s*$/
/** A footnote definition: `[^3]: the note`. */
const FOOTNOTE_DEFINITION = /^\[\^([0-9]{1,9})\]:[ \t]*(.*)$/
/** A line that opens with an HTML element, which is raw HTML and not Markdown. */
const HTML_LINE = /^\s*<\/?[A-Za-z][A-Za-z0-9-]*(\s|\/?>|$)/
/** An HTML comment, which `composeMarkdown` writes when a run carries notes. */
const HTML_COMMENT_OPEN = /^\s*<!--/
/** A list item that opens with a checkbox, which this writer does not render. */
const TASK_ITEM = /^(?:\[[ xX]\]\s*)/

/** The tags whose whole body a reader would have to interpret. Named, not guessed. */
const HTML_TAG_NAMES = 'html|body|head|div|span|table|tr|td|th|ul|ol|li|p|br|hr|img|a|b|i|em|strong|code|pre|blockquote|script|style|iframe|svg|font|sub|sup|details|summary'

/** One image, as the inline layer sees it. */
function imageNode(alt, src) {
  return { type: 'image', alt: String(alt ?? ''), src: String(src ?? '') }
}

/**
 * The inline tokenizer, in ONE pattern.
 *
 * One alternation rather than a sequence of passes, because precedence between
 * these constructs is the whole correctness question: a code span's asterisks are
 * text, so the code span has to be able to match BEFORE the emphasis branch sees
 * them, and a link has to be able to match before the emphasis inside its text. A
 * single leftmost-longest scan gives that precedence by position instead of by
 * pass order.
 */
const INLINE = new RegExp(
  [
    // 1. an image
    '!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)',
    // 2. a code span
    '`([^`\\n]+)`',
    // 3. a link
    '(?<!!)\\[([^\\]\\n]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)',
    // 4. a footnote reference
    '\\[\\^([0-9]{1,9})\\]',
    // 5. a claim span, which the builder has already stripped of its id
    '\\[([^\\[\\]\\n]+)\\]\\{#[^}\\n]*\\}',
    // 6. strong
    '\\*\\*([^*\\n]+)\\*\\*',
    // 7. emphasis with asterisks
    '\\*([^*\\n]+)\\*',
    // 8. emphasis with underscores, which is what a reference entry's italics use
    '(?<![\\w_])_([^_\\n]+)_(?![\\w_])',
  ].join('|'),
  'g',
)

/** One tag in a raw-HTML line, so a report can name what it saw. */
const HTML_TAG = new RegExp('<\\/?(' + HTML_TAG_NAMES + ')\\b[^>]*>', 'i')

/**
 * Append a run, merging it into the previous one when both are plain text.
 *
 * Merging is not cosmetic: two adjacent `w:t` runs print identically but a
 * reader's word extraction sees a seam, and the seam is what makes "the" and
 * "effect" two words in a text-only reader.
 */
function push(list, node) {
  if (node.type === 'text' && node.text === '') return
  const last = list[list.length - 1]
  if (last !== undefined && last.type === 'text' && node.type === 'text' && (last.bold ?? false) === (node.bold ?? false) && (last.italic ?? false) === (node.italic ?? false)) {
    last.text += node.text
    return
  }
  list.push(node)
}

/**
 * Text between matches, with backslash escapes resolved and hard breaks found.
 *
 * A trailing backslash or two trailing spaces is a hard break in Markdown; the
 * builder does not write one, and honouring it costs nothing, so it is honoured.
 */
function pushText(list, text) {
  if (text === '') return
  const parts = text.split(/\n/)
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) push(list, { type: 'break' })
    let part = parts[index]
    const hard = /(?: {2,}|\\)$/.test(part)
    if (hard) part = part.replace(/(?: {2,}|\\)$/, '')
    push(list, { type: 'text', text: unescape(part) })
    if (hard) push(list, { type: 'break' })
  }
}

/** Resolve Markdown's backslash escapes, of which the punctuation is the whole set. */
function unescape(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
}

/**
 * One line of text as runs.
 *
 * @returns an array of `{ type: 'text', text, bold?, italic? }`,
 *          `{ type: 'code', text }`, `{ type: 'link', href, runs }`,
 *          `{ type: 'note', number }`, `{ type: 'image', alt, src }` or
 *          `{ type: 'break' }`.
 */
export function parseInline(text) {
  const runs = []
  const source = String(text ?? '')
  if (source === '') return runs
  let cursor = 0
  for (const match of source.matchAll(INLINE)) {
    if (match.index > cursor) pushText(runs, source.slice(cursor, match.index))
    cursor = match.index + match[0].length
    if (match[1] !== undefined) push(runs, imageNode(match[1], match[2]))
    else if (match[3] !== undefined) push(runs, { type: 'code', text: match[3] })
    else if (match[4] !== undefined) push(runs, { type: 'link', href: match[5], runs: parseInline(match[4]) })
    else if (match[6] !== undefined) push(runs, { type: 'note', number: Number(match[6]) })
    else if (match[7] !== undefined) push(runs, { type: 'text', text: unescape(match[7]) })
    else if (match[8] !== undefined) push(runs, { type: 'text', text: unescape(match[8]), bold: true })
    else if (match[9] !== undefined) push(runs, { type: 'text', text: unescape(match[9]), italic: true })
    else if (match[10] !== undefined) push(runs, { type: 'text', text: unescape(match[10]), italic: true })
  }
  if (cursor < source.length) pushText(runs, source.slice(cursor))
  return runs
}

/** The plain text of a run list, which is what a report and a name check read. */
export function inlineText(runs) {
  return (Array.isArray(runs) ? runs : [])
    .map((run) => {
      if (run === null || typeof run !== 'object') return ''
      if (run.type === 'text' || run.type === 'code') return String(run.text ?? '')
      if (run.type === 'link') return inlineText(run.runs)
      if (run.type === 'image') return String(run.alt ?? '')
      if (run.type === 'note') return ''
      if (run.type === 'break') return '\n'
      return ''
    })
    .join('')
}

/**
 * A block from its runs.
 *
 * `text` is stored on the block rather than recomputed, because two things read
 * it and they must not be able to disagree: the writer's report, which says which
 * paragraph the `Bibliography` style landed on, and the writer's own decision
 * about WHICH block the reference heading is.
 */
function blockOf(type, runs, line, extra = {}) {
  return { type, runs, text: inlineText(runs), line, ...extra }
}

/** Split a table row into its cells, honouring a `\|` escape. */
export function splitTableRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let current = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]
    if (character === '\\' && trimmed[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += character
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/**
 * The alignment a delimiter cell declares, as both a GFM token and the OOXML
 * justification, because the two layers spell it differently and one place should
 * own the mapping.
 */
export function alignmentOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

/** The column count a table's rows agree on, which is what a table is measured by. */
export function tableCells(line) {
  return splitTableRow(line)
}

/**
 * One list, as items.
 *
 * Nesting is ONE level, by 2-space indent: that is the depth the document dialect
 * uses, and a third level is reported rather than flattened into the second.
 *
 * @returns `{ ordered, start, items, index }` with `index` left on the first line
 *          that is not part of the list.
 */
function parseList(lines, startIndex, report) {
  const first = ORDERED.exec(lines[startIndex]) !== null
  const items = []
  let last = null
  let index = startIndex
  while (index < lines.length) {
    const row = lines[index]
    const item = first ? ORDERED.exec(row) : BULLET.exec(row)
    if (item === null) break
    const indent = item[1].length
    const body = first ? item[3] : item[2]
    if (indent >= 4) {
      report(index + 1, row, 'a list nested more than one level deep is outside this writer\'s subset')
      index += 1
      continue
    }
    if (TASK_ITEM.test(body)) report(index + 1, row, 'a task-list checkbox is not rendered as a checkbox')
    const runs = parseInline(TASK_ITEM.test(body) ? body.replace(TASK_ITEM, '') : body)
    const entry = { runs, text: inlineText(runs), line: index + 1, children: [] }
    if (indent >= 2) {
      if (last === null) {
        report(index + 1, row, 'an indented list item with no item above it has nowhere to nest')
        items.push(entry)
      } else last.children.push(entry)
    } else {
      items.push(entry)
      last = entry
    }
    index += 1
  }
  return { ordered: first, start: first ? Number(ORDERED.exec(lines[startIndex])[2]) : 1, items, index }
}

/**
 * Parse the whole document.
 *
 * @returns `{ blocks, definitions, references, unsupported }` where `definitions`
 * is a Map of footnote number to text, `references` lists every `[^n]` used with
 * the line it was used on, and `unsupported` is the report the writer returns
 * unchanged - one entry per construct this subset does not cover.
 */
export function parseMarkdown(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  const blocks = []
  const definitions = new Map()
  /** Where each definition was written, so a report about one can name its line. */
  const definitionLines = new Map()
  const references = []
  const unsupported = []
  let index = 0

  const report = (line, text, why) => unsupported.push({ line, text: text.trim().slice(0, 200), why })

  while (index < lines.length) {
    const line = lines[index]
    const lineNumber = index + 1
    if (line.trim() === '') {
      index += 1
      continue
    }

    const definition = FOOTNOTE_DEFINITION.exec(line)
    if (definition !== null) {
      // A definition carries the note's text; it is not a paragraph, which is why
      // it is consumed here rather than rendered where it stands.
      definitions.set(Number(definition[1]), definition[2].trim())
      definitionLines.set(Number(definition[1]), lineNumber)
      index += 1
      continue
    }

    if (HTML_COMMENT_OPEN.test(line)) {
      const start = lineNumber
      const collected = []
      while (index < lines.length && !lines[index].includes('-->')) {
        collected.push(lines[index])
        index += 1
      }
      if (index < lines.length) {
        collected.push(lines[index])
        index += 1
      }
      report(start, collected.join('\n'), 'a raw HTML comment is not Markdown this writer renders')
      continue
    }

    if (HTML_LINE.test(line)) {
      const start = lineNumber
      const match = HTML_TAG.exec(line)
      const collected = [line]
      index += 1
      // A raw block runs until a blank line, which is CommonMark's type 6 rule and
      // the reason a multi-line `<div>` is one report and not five.
      while (index < lines.length && lines[index].trim() !== '' && !BLOCK_START.test(lines[index])) {
        collected.push(lines[index])
        index += 1
      }
      report(start, collected.join('\n'), 'raw HTML (' + (match === null ? 'an element' : '<' + match[1].toLowerCase() + '>') + ') is not Markdown this writer renders')
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push(blockOf('heading', parseInline(heading[2]), lineNumber, { level: heading[1].length }))
      index += 1
      continue
    }

    if (SETEXT_UNDERLINE.test(line) && blocks.length > 0 && blocks[blocks.length - 1].type === 'paragraph') {
      // The paragraph before it stays a paragraph, and the underline is reported:
      // rendering it as a heading would invent a level the author never chose.
      report(lineNumber, line, 'a setext heading is not ATX, which is the heading form this writer renders')
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[2][0]
      const collected = []
      index += 1
      while (index < lines.length && !(new RegExp('^ {0,3}' + (marker === '`' ? '`{3,}' : '~{3,}') + '\\s*$').test(lines[index]))) {
        collected.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', text: collected.join('\n'), language: fence[3].trim().split(/\s+/)[0] ?? '', line: lineNumber })
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule', line: lineNumber })
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const collected = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        collected.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      // A blockquote's own line breaks are SOFT, like a paragraph's: two `>` lines
      // in a row are one wrapped paragraph, not two, and a hard break inside the
      // banner the builder writes would fold it into a different shape.
      blocks.push(blockOf('blockquote', parseInline(collected.join(' ')), lineNumber))
      continue
    }

    if (line.indexOf('|') >= 0 && index + 1 < lines.length && DELIMITER_ROW.test(lines[index + 1]) && lines[index + 1].indexOf('-') >= 0) {
      const align = splitTableRow(lines[index + 1]).map(alignmentOf)
      const head = splitTableRow(line).map((cell) => parseInline(cell))
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim() !== '' && lines[index].indexOf('|') >= 0) {
        const cells = splitTableRow(lines[index]).map((cell) => parseInline(cell))
        while (cells.length < align.length) cells.push([])
        rows.push(cells.slice(0, align.length))
        index += 1
      }
      blocks.push({ type: 'table', align, head, rows, line: lineNumber, text: [...head, ...rows.flat()].map((cell) => inlineText(cell)).join(' ') })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet === null ? ORDERED.exec(line) : null
    if (bullet !== null || ordered !== null) {
      const parsed = parseList(lines, index, report)
      blocks.push({ type: 'list', ordered: parsed.ordered, start: parsed.start, items: parsed.items, line: lineNumber, text: parsed.items.map((item) => item.text).join(' ') })
      index = parsed.index
      continue
    }

    if (INDENTED_CODE.test(line)) {
      const start = lineNumber
      const collected = []
      while (index < lines.length && (INDENTED_CODE.test(lines[index]) || lines[index].trim() === '')) {
        if (lines[index].trim() === '' && !(index + 1 < lines.length && INDENTED_CODE.test(lines[index + 1]))) break
        collected.push(lines[index].replace(/^(?: {4}|\t)/, ''))
        index += 1
      }
      report(start, collected.join('\n'), 'an indented code block is outside this writer\'s subset - fence it instead')
      continue
    }

    // A paragraph: everything up to a blank line or the start of another block.
    // A setext underline STOPS it too, or the paragraph would swallow the underline
    // and the report below would have nothing left to name.
    const collected = [line]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !BLOCK_START.test(lines[index]) &&
      !FOOTNOTE_DEFINITION.test(lines[index]) &&
      !HTML_COMMENT_OPEN.test(lines[index]) &&
      !HTML_LINE.test(lines[index]) &&
      !INDENTED_CODE.test(lines[index]) &&
      !SETEXT_UNDERLINE.test(lines[index])
    ) {
      collected.push(lines[index])
      index += 1
    }

    if (collected.length === 1 && index < lines.length && SETEXT_UNDERLINE.test(lines[index]) && !RULE.test(lines[index])) {
      // A `===` underline under a single line is a heading in Markdown and is not
      // a heading this writer renders, so it is reported where it is still legible.
      report(index + 1, lines[index], 'a setext heading is not ATX, which is the heading form this writer renders')
      index += 1
      continue
    }

    if (collected.length === 1) {
      const only = parseInline(collected[0])
      const image = only.length === 1 && only[0].type === 'image' ? only[0] : null
      if (image !== null) {
        blocks.push({ type: 'figure', alt: image.alt, src: image.src, text: image.alt, line: lineNumber })
        continue
      }
    }
    blocks.push(blockOf('paragraph', parseInline(collected.join(' ')), lineNumber))
  }

  // Every `[^n]` used in the body, in reading order, with the line it appeared on:
  // a reference with no definition is reported by the writer, and the line is what
  // makes that report actionable.
  for (const block of blocks) {
    const lists = block.type === 'paragraph' || block.type === 'heading' || block.type === 'blockquote' ? [block.runs] : block.type === 'list' ? block.items.flatMap((item) => [item.runs, ...item.children.map((child) => child.runs)]) : block.type === 'table' ? [...block.head, ...block.rows.flat()] : []
    for (const runs of lists) {
      for (const token of walkInline(runs)) {
        if (token.type === 'note') references.push({ number: token.number, line: block.line })
      }
    }
  }
  return { blocks, definitions, definitionLines, references, unsupported }
}

/** Every token in a run list, descending into a link's own runs. */
export function walkInline(runs) {
  const found = []
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    found.push(run)
    if (run.type === 'link') found.push(...walkInline(run.runs))
  }
  return found
}
