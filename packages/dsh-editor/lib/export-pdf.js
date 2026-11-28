/**
 * dsh-editor — a Markdown document, printed to a PDF on the Desktop.
 *
 * The reader is looking at the rendered document in the right bar; "Export PDF"
 * turns THAT document into a file they can send. Two halves:
 *
 *   - **Markdown → one self-contained HTML page.** No stylesheet, font or image
 *     is fetched: the print stylesheet is inlined and every local image is
 *     embedded as a data URI, so the page renders with the print engine's own
 *     fonts and nothing leaves the machine. Remote images are NOT fetched (the
 *     pack starts no network egress of its own): they keep their alt text.
 *   - **HTML → PDF with the browser already on the machine.** A throwaway
 *     Chromium-family process (`--headless=new`, a private profile, a resolver
 *     that fails every name) is asked to `--print-to-pdf` the temp page. This is
 *     the same engine `dsh-screenshot` uses, and the reason it is a browser
 *     rather than a hand-written PDF writer: real font fallback (a Chinese
 *     README prints its Chinese), real tables, real page breaks and clickable
 *     links, with no bundled binary, no npm dependency and no font file to
 *     ship.
 *
 * The PDF lands in `~/Desktop` (or `$DSH_EDITOR_PDF_DIR`), never replacing an
 * existing file: a second export of the same document is `name (2).pdf`.
 *
 * Failures are typed (`NO_ENGINE`, `NO_DESKTOP`, `RENDER_FAILED`,
 * `RENDER_TIMEOUT`, `IO_ERROR`) so the route can answer a status and a message
 * a person can act on instead of a stack trace.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** How long the print engine has to answer with a PDF. */
export const PRINT_TIMEOUT_MS = 45000
/** A local image larger than this is left as its alt text rather than embedded. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** The image budget for one document, so a screenshot gallery cannot balloon it. */
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024
/** The largest document the renderer accepts (the editor's own read ceiling). */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

function pdfError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/** Wait for one short interval. */
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/** Escape text for an HTML text node. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/** Escape text for a double-quoted HTML attribute. */
function escapeAttribute(text) {
  return escapeHtml(text).replace(/\n/g, ' ')
}

// ---------------------------------------------------------------------------
// Inline Markdown
// ---------------------------------------------------------------------------

/** The characters a backslash may escape. */
const ESCAPABLE = '\\`*_{}[]()#+-.!|>~'

/**
 * Find the closing delimiter for an emphasis span. The opener has already been
 * checked to be followed by a non-space; the closer must be preceded by one.
 *
 * @param text - the inline source.
 * @param from - index just past the opener.
 * @param delimiter - the exact delimiter that closes it.
 * @param wordBoundary - refuse an intraword `_` (a snake_case identifier is not emphasis).
 * @returns the index of the closer, or -1.
 */
function findEmphasisClose(text, from, delimiter, wordBoundary) {
  let index = text.indexOf(delimiter, from)
  while (index !== -1) {
    const before = text[index - 1]
    const after = text[index + delimiter.length]
    const escaped = index > 0 && text[index - 1] === '\\'
    const intraword = wordBoundary && /\w/.test(before || '') && /\w/.test(after || '')
    if (!escaped && !intraword && index > from && !/\s/.test(before || ' ')) return index
    index = text.indexOf(delimiter, index + 1)
  }
  return -1
}

/** The URL a link or image destination may keep. */
function safeHref(url) {
  const value = String(url).trim()
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value
  if (value.startsWith('#')) return value
  return null
}

const IMAGE_MIME = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

/** Whether a path is inside a directory (both already resolved). */
function insideDirectory(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/**
 * The data URI for one relative image, or `null`.
 *
 * Relative only, resolved against the document's own folder and verified to
 * stay inside the workspace root: a document cannot make the export read an
 * arbitrary file. Remote images are `null` on purpose - the export fetches
 * nothing - and so is a file over the image budget.
 */
function imageDataUrl(ctx, source) {
  if (typeof source !== 'string' || source === '') return null
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) return null
  let clean = source.split('#')[0].split('?')[0]
  try {
    clean = decodeURIComponent(clean)
  } catch (err) {
    // keep the literal spelling
  }
  if (clean === '' || path.isAbsolute(clean) || /^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('\\\\')) return null
  const root = ctx.rootDir
  if (typeof root !== 'string' || root === '') return null
  let rootReal
  try {
    rootReal = ctx.rootReal ?? realpathSync(root)
  } catch (err) {
    return null
  }
  ctx.rootReal = rootReal
  const base = typeof ctx.filePath === 'string' && ctx.filePath !== '' ? path.dirname(ctx.filePath) : rootReal
  const target = path.resolve(base, clean)
  if (!insideDirectory(rootReal, target)) return null
  let real
  try {
    real = realpathSync(target)
  } catch (err) {
    return null
  }
  if (!insideDirectory(rootReal, real)) return null
  let size
  let bytes
  try {
    const stat = statSync(real)
    size = stat.size
    if (!stat.isFile() || size <= 0 || size > MAX_IMAGE_BYTES) return null
    if (ctx.images.bytes + size > MAX_TOTAL_IMAGE_BYTES) return null
    bytes = readFileSync(real)
  } catch (err) {
    return null
  }
  const mime = IMAGE_MIME[path.extname(real).toLowerCase()]
  if (mime === undefined) return null
  ctx.images.bytes += size
  ctx.images.count += 1
  return 'data:' + mime + ';base64,' + bytes.toString('base64')
}

// ---------------------------------------------------------------------------

/**
 * Render one run of inline Markdown to HTML.
 *
 * A scanner, not a pile of replacements: code spans, links and images are
 * consumed whole, so an asterisk inside `` `a*b` `` or a bracket in a URL never
 * becomes emphasis. Authored inline HTML is drawn LITERALLY (escaped), which is
 * the shipped preview's own contract; only block-level HTML is rebuilt (below).
 */
export function renderInline(text, ctx) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    // Backslash escape.
    if (char === '\\' && index + 1 < text.length && ESCAPABLE.includes(text[index + 1])) {
      out += escapeHtml(text[index + 1])
      index += 2
      continue
    }
    // Code span: a run of backticks closes on the same-length run.
    if (char === '`') {
      let run = 1
      while (text[index + run] === '`') run += 1
      const fence = '`'.repeat(run)
      const close = text.indexOf(fence, index + run)
      if (close !== -1) {
        let code = text.slice(index + run, close).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
        out += '<code>' + escapeHtml(code) + '</code>'
        index = close + run
        continue
      }
      out += escapeHtml(fence)
      index += run
      continue
    }
    // Image: ![alt](destination "title") or ![alt][reference].
    if (char === '!' && text[index + 1] === '[') {
      const link = parseLink(text, index + 1, ctx)
      if (link !== null) {
        const alt = renderInline(link.label, ctx).replace(/<[^>]*>/g, '')
        const source = imageDataUrl(ctx, link.href)
        if (source !== null) {
          out += '<img src="' + escapeAttribute(source) + '" alt="' + escapeAttribute(stripTags(alt)) + '">'
        } else {
          out += '<span class="md-altImage">' + escapeHtml(stripTags(alt) || 'image') + '</span>'
        }
        index = link.end
        continue
      }
    }
    // Link: [label](destination "title"), [label][reference] or [label].
    if (char === '[') {
      const link = parseLink(text, index, ctx)
      if (link !== null) {
        const label = renderInline(link.label, ctx)
        const href = safeHref(link.href)
        out += href === null ? label : '<a href="' + escapeAttribute(href) + '">' + label + '</a>'
        index = link.end
        continue
      }
    }
    // Autolink: <https://...> or <mailto:...>.
    if (char === '<') {
      const close = text.indexOf('>', index + 1)
      if (close !== -1) {
        const target = text.slice(index + 1, close)
        if (/^(?:https?:\/\/|mailto:)/i.test(target)) {
          out += '<a href="' + escapeAttribute(target) + '">' + escapeHtml(target) + '</a>'
          index = close + 1
          continue
        }
      }
      out += '&lt;'
      index += 1
      continue
    }
    // A source entity is already an entity: keep it instead of escaping the &.
    if (char === '&') {
      const match = /^&(?:#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]{1,31});/i.exec(text.slice(index))
      if (match !== null) {
        out += match[0]
        index += match[0].length
        continue
      }
      out += '&amp;'
      index += 1
      continue
    }
    // Emphasis: strong before emphasis, so ** reads as one delimiter.
    if (char === '*' || char === '_' || char === '~') {
      const strong = text[index + 1] === char
      const triple = strong && text[index + 2] === char
      const delimiter = triple ? char.repeat(3) : strong ? char.repeat(2) : char
      if (char === '~' && !strong) {
        out += '~'
        index += 1
        continue
      }
      const after = text[index + delimiter.length]
      if (after !== undefined && !/\s/.test(after)) {
        const close = findEmphasisClose(text, index + delimiter.length, delimiter, char === '_')
        if (close !== -1) {
          const inner = renderInline(text.slice(index + delimiter.length, close), ctx)
          if (delimiter.length === 3) out += '<strong><em>' + inner + '</em></strong>'
          else if (delimiter.length === 2) out += char === '~' ? '<del>' + inner + '</del>' : '<strong>' + inner + '</strong>'
          else out += '<em>' + inner + '</em>'
          index = close + delimiter.length
          continue
        }
      }
      out += escapeHtml(delimiter)
      index += delimiter.length
      continue
    }
    out += escapeHtml(char)
    index += 1
  }
  return out
}

/** Strip tags from already-rendered inline HTML (for alt text). */
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** Find the matching `]` for a `[` at `open`, honouring nesting. */
function matchingBracket(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Find the matching `)` for a `(` at `open`, honouring escapes and nesting. */
function matchingParen(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Split a destination into URL and optional title. */
function splitDestination(raw) {
  let value = raw.trim()
  let title = ''
  if (value.startsWith('<')) {
    const close = value.indexOf('>')
    if (close !== -1) {
      title = value.slice(close + 1).trim()
      value = value.slice(1, close)
    }
  } else {
    const match = /^(\S+)\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))\s*$/.exec(value)
    if (match !== null) {
      title = match[2] ?? match[3] ?? match[4] ?? ''
      value = match[1]
    }
  }
  if (title === '') {
    const inlineTitle = /\s+["'(]([^"')]*)["')]\s*$/.exec(value)
    if (inlineTitle !== null && !/\s/.test(value.slice(0, inlineTitle.index))) {
      title = inlineTitle[1]
      value = value.slice(0, inlineTitle.index)
    }
  }
  return { href: value.replace(/\\(.)/g, '$1'), title }
}

/**
 * Parse a link starting at a `[`.
 *
 * @returns `{ label, href, title, end }` (end is one past the whole link) or null.
 */
function parseLink(text, open, ctx) {
  const close = matchingBracket(text, open)
  if (close === -1) return null
  const label = text.slice(open + 1, close)
  let cursor = close + 1
  if (text[cursor] === '(') {
    const end = matchingParen(text, cursor)
    if (end === -1) return null
    const target = splitDestination(text.slice(cursor + 1, end))
    if (target.href === '') return null
    return { label, href: target.href, title: target.title, end: end + 1 }
  }
  if (text[cursor] === '[') {
    const refClose = matchingBracket(text, cursor)
    if (refClose === -1) return null
    const reference = text.slice(cursor + 1, refClose) || label
    const entry = ctx.refs ? ctx.refs.get(normalizeReference(reference)) : undefined
    if (entry === undefined) return null
    return { label, href: entry.href, title: entry.title, end: refClose + 1 }
  }
  const shortcut = ctx.refs ? ctx.refs.get(normalizeReference(label)) : undefined
  if (shortcut === undefined) return null
  return { label, href: shortcut.href, title: shortcut.title, end: close + 1 }
}

/** Reference labels match case- and whitespace-insensitively. */
function normalizeReference(label) {
  return String(label).trim().replace(/\s+/g, ' ').toLowerCase()
}

// ---------------------------------------------------------------------------
// Block Markdown
// ---------------------------------------------------------------------------

const BLOCK_HTML_TAGS = new Set([
  'a', 'address', 'article', 'aside', 'blockquote', 'br', 'center', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'img', 'main', 'nav', 'ol',
  'p', 'picture', 'pre', 'section', 'summary', 'table', 'ul',
])
/** Tags whose markdown-looking contents stay Markdown (the preview's containers). */
const HTML_CONTAINERS = new Set(['article', 'aside', 'blockquote', 'center', 'details', 'div', 'figure', 'footer', 'header', 'main', 'nav', 'section'])
/** Tags that are never drawn: they are dropped with their contents. */
const HTML_DROP_TAGS = new Set([
  'applet', 'audio', 'base', 'button', 'canvas', 'embed', 'form', 'frame', 'frameset', 'iframe', 'input', 'link',
  'math', 'meta', 'noscript', 'object', 'option', 'portal', 'script', 'select', 'style', 'svg', 'template',
  'textarea', 'video',
])
/** Every tag a raw block may keep. */
const HTML_ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'legend', 'li', 'main', 'mark',
  'nav', 'ol', 'p', 'picture', 'pre', 'q', 's', 'section', 'small', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
])
const HTML_VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const HTML_GLOBAL_ATTRIBUTES = new Set(['align', 'colspan', 'dir', 'headers', 'height', 'lang', 'open', 'reversed', 'rowspan', 'scope', 'start', 'title', 'type', 'valign', 'width'])
const HTML_TAG_ATTRIBUTES = {
  a: new Set(['href', 'name']),
  details: new Set(['open']),
  img: new Set(['alt', 'src']),
  ol: new Set(['reversed', 'start', 'type']),
  time: new Set(['datetime']),
}

/** Drop a dangerous element together with everything inside it. */
function dropElement(html, tag) {
  const pattern = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi')
  return html.replace(pattern, '')
}

/** Keep only attributes this renderer can draw safely. */
function sanitizeAttributes(tag, raw, ctx) {
  const kept = []
  const attribute = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = attribute.exec(raw)) !== null) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const allowed = HTML_GLOBAL_ATTRIBUTES.has(name) || (HTML_TAG_ATTRIBUTES[tag] && HTML_TAG_ATTRIBUTES[tag].has(name))
    if (!allowed) continue
    if (name === 'href') {
      const href = safeHref(value)
      if (href !== null) kept.push(['href', href])
      continue
    }
    if (name === 'src') {
      const source = imageDataUrl(ctx, value)
      if (source !== null) kept.push(['src', source])
      continue
    }
    kept.push([name, value])
  }
  return kept
}

/** Render one raw tag, keeping an allowlisted tag or nothing. */
function sanitizeTag(tagHtml, ctx) {
  const parsed = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)>$/.exec(tagHtml)
  if (parsed === null) return ''
  const closing = parsed[1] === '/'
  const name = parsed[2].toLowerCase()
  const selfClosing = parsed[4] === '/'
  if (!HTML_ALLOWED_TAGS.has(name)) return ''
  if (closing) return '</' + name + '>'
  const attributes = sanitizeAttributes(name, parsed[3], ctx)
  // A PDF has no pointer: a collapsed `<details>` would print its summary and
  // swallow the content, so every one is drawn open.
  if (name === 'details' && !attributes.some(([key]) => key === 'open')) attributes.push(['open', ''])
  if (name === 'img' && !attributes.some(([key]) => key === 'src')) return ''
  const rendered = attributes.map(([key, value]) => (value === '' ? ' ' + key : ' ' + key + '="' + escapeAttribute(value) + '"')).join('')
  if (selfClosing || HTML_VOID_TAGS.has(name)) return '<' + name + rendered + '>'
  return '<' + name + rendered + '>'
}

/**
 * Sanitize one authored HTML fragment.
 *
 * This is a document the person owns, printed in a throwaway browser, so this
 * is not the client's security boundary - it is what keeps the print page the
 * same safe subset the preview draws: script/style/iframe and friends gone with
 * their contents, event handlers and `javascript:` gone, presentation kept.
 */
export function sanitizeHtml(html, ctx) {
  let value = String(html)
  for (const tag of HTML_DROP_TAGS) value = dropElement(value, tag)
  value = value.replace(/<!--[\s\S]*?-->/g, '')
  value = value.replace(/<[^>]+>/g, (tag) => sanitizeTag(tag, ctx))
  return value
}

/** The indentation width of a line (tabs count as four). */
function indentOf(line) {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }
  return width
}

/** Remove up to `width` columns of leading indentation. */
function stripIndent(line, width) {
  let removed = 0
  let index = 0
  while (index < line.length && removed < width) {
    if (line[index] === ' ') {
      removed += 1
      index += 1
    } else if (line[index] === '\t') {
      removed += 4
      index += 1
    } else break
  }
  return line.slice(index)
}

/** A list marker, or null. */
function listMarker(line) {
  const match = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line)
  if (match === null) return null
  const marker = match[2]
  return {
    indent: match[1].length,
    marker,
    ordered: /\d/.test(marker[0]),
    contentStart: match[1].length + marker.length + Math.max(1, Math.min(match[3].length, 4)),
    rest: match[4],
  }
}

/** The text of a heading line, or null. */
function atxHeading(line) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line)
  if (match === null) return null
  return { level: match[1].length, text: (match[2] ?? '').trim() }
}

/** A thematic break, ignoring list markers. */
function isThematicBreak(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
}

/** The opening fence of a fenced code block, or null. */
function fenceOpen(line) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/.exec(line)
  if (match === null) return null
  return { fence: match[1], info: (match[2] ?? '').trim() }
}
/** Whether a line opens a block-level HTML element. */
function htmlBlockOpen(line) {
  const match = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/.exec(line)
  if (match === null) return null
  const tag = match[1].toLowerCase()
  if (!BLOCK_HTML_TAGS.has(tag) && !HTML_DROP_TAGS.has(tag)) return null
  return { tag }
}

/** Whether a line starts a block (and therefore ends a paragraph). */
function startsBlock(line) {
  return (
    line.trim() === '' ||
    atxHeading(line) !== null ||
    fenceOpen(line) !== null ||
    isThematicBreak(line) ||
    /^ {0,3}>/.test(line) ||
    listMarker(line) !== null ||
    htmlBlockOpen(line) !== null
  )
}

/** Split one table row on unescaped pipes. */
function splitTableRow(line) {
  const cells = []
  let cell = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && line[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  if (line.trim().startsWith('|') && cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (line.trim().endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells
}

/** A table's delimiter row, or null. */
function tableDelimiter(line) {
  if (!line.includes('|')) return null
  const cells = splitTableRow(line)
  if (cells.length === 0) return null
  const alignments = []
  for (const cell of cells) {
    const value = cell.trim()
    if (!/^:?-{1,}:?$/.test(value)) return null
    alignments.push(value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : value.startsWith(':') ? 'left' : '')
  }
  return alignments
}

/** Collect reference definitions and remove them from the block source. */
function collectReferences(lines) {
  const refs = new Map()
  const kept = []
  // A fenced block is code: a `[label]: url` example inside it is not a
  // definition, and lifting it out would both edit the example and add a link
  // the document never made.
  let fence = null
  for (const line of lines) {
    if (fence !== null) {
      kept.push(line)
      const marker = fence.fence[0] === '`' ? '`' : '~'
      if (new RegExp('^ {0,3}' + marker + '{' + fence.fence.length + ',}[ \\t]*$').test(line)) fence = null
      continue
    }
    const opened = fenceOpen(line)
    if (opened !== null) {
      fence = opened
      kept.push(line)
      continue
    }
    const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/.exec(line)
    // A footnote definition (`[^1]: ...`) is not a reference: it stays in the
    // source, drawn as the literal text it is rather than silently removed.
    if (match === null || match[1].startsWith('^')) {
      kept.push(line)
      continue
    }
    refs.set(normalizeReference(match[1]), { href: match[2] ?? match[3] ?? '', title: match[4] ?? match[5] ?? match[6] ?? '' })
  }
  return { refs, lines: kept }
}

/** Render a list starting at `start`; returns HTML and the next index. */
function renderList(lines, start, ctx) {
  const first = listMarker(lines[start])
  const ordered = first.ordered
  const baseIndent = first.indent
  const items = []
  let index = start
  let loose = false
  while (index < lines.length) {
    const marker = listMarker(lines[index])
    if (marker === null || marker.indent !== baseIndent || marker.ordered !== ordered) break
    const content = [marker.rest]
    let itemIndex = index + 1
    let sawBlank = false
    while (itemIndex < lines.length) {
      const line = lines[itemIndex]
      if (line.trim() === '') {
        sawBlank = true
        content.push('')
        itemIndex += 1
        continue
      }
      const indent = indentOf(line)
      const next = listMarker(line)
      if (indent <= baseIndent) break
      if (next !== null && next.indent <= baseIndent) break
      content.push(stripIndent(line, marker.contentStart))
      itemIndex += 1
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop()
    if (sawBlank) loose = true
    items.push({ lines: content, ordered, number: ordered ? Number.parseInt(marker.marker, 10) : null })
    index = itemIndex
    // Between items: allow blank lines (the next loop iteration reads them as
    // the end of the list; consume them here).
    let lookahead = index
    while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead += 1
    if (lookahead < lines.length) {
      const next = listMarker(lines[lookahead])
      if (next !== null && next.indent === baseIndent && next.ordered === ordered) {
        if (lookahead > index) loose = true
        index = lookahead
      }
    }
  }
  const startNumber = items.length > 0 && items[0].number !== null ? items[0].number : 1
  let html = ordered ? '<ol' + (startNumber !== 1 ? ' start="' + startNumber + '"' : '') + '>' : '<ul>'
  for (const item of items) {
    const task = /^\[([ xX])\][ \t]+/.exec(item.lines[0] ?? '')
    if (task !== null) item.lines[0] = item.lines[0].slice(task[0].length)
    let inner = renderBlocks(item.lines, ctx, { tight: !loose })
    if (!loose) inner = unwrapSingleParagraph(inner)
    if (task !== null) {
      const box = '<span class="md-task" aria-hidden="true">' + (task[1].trim() === '' ? '\u2610' : '\u2611') + '</span> '
      inner = inner.startsWith('<p>') ? '<p>' + box + inner.slice(3) : box + inner
    }
    html += '<li>' + inner + '</li>'
  }
  return { html: html + (ordered ? '</ol>' : '</ul>'), next: index }
}

/** A tight item's single paragraph loses its `<p>` wrapper. */
function unwrapSingleParagraph(html) {
  const trimmed = html.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('</p>') === trimmed.length - 4 && trimmed.indexOf('<p>') === 0) {
    return trimmed.slice(3, -4)
  }
  return html
}

/** Render a blockquote body at the given depth. */
function renderBlocks(lines, ctx, options = {}) {
  let html = ''
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }

    // Fenced code.
    const fence = fenceOpen(line)
    if (fence !== null) {
      const body = []
      const marker = fence.fence[0] === '`' ? '`' : '~'
      const close = new RegExp('^ {0,3}' + marker + '{' + fence.fence.length + ',}[ \\t]*$')
      let cursor = index + 1
      while (cursor < lines.length && close.test(lines[cursor]) === false) {
        body.push(lines[cursor])
        cursor += 1
      }
      const language = fence.info.split(/\s+/)[0] || ''
      html += '<pre' + (language !== '' ? ' class="language-' + escapeAttribute(language) + '"' : '') + '><code>' + escapeHtml(body.join('\n')) + '</code></pre>'
      index = cursor < lines.length ? cursor + 1 : cursor
      continue
    }

    // ATX heading.
    const heading = atxHeading(line)
    if (heading !== null) {
      const level = Math.min(6, Math.max(1, heading.level))
      html += '<h' + level + '>' + renderInline(heading.text, ctx) + '</h' + level + '>'
      index += 1
      continue
    }

    // Setext heading: a paragraph line underlined by = or -.
    if (index + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[index + 1]) && !startsBlock(line)) {
      const level = lines[index + 1].trim().startsWith('=') ? 1 : 2
      html += '<h' + level + '>' + renderInline(line.trim(), ctx) + '</h' + level + '>'
      index += 2
      continue
    }

    // Thematic break.
    if (isThematicBreak(line)) {
      html += '<hr>'
      index += 1
      continue
    }

    // Table.
    const table = tableDelimiter(index + 1 < lines.length ? lines[index + 1] : '')
    if (table !== null && line.includes('|')) {
      const header = splitTableRow(line)
      if (header.length === table.length) {
        let body = ''
        let cursor = index + 2
        while (cursor < lines.length && lines[cursor].trim() !== '' && lines[cursor].includes('|') && !startsBlock(lines[cursor])) {
          const cells = splitTableRow(lines[cursor])
          const padded = table.map((_, cell) => cells[cell] ?? '')
          body += '<tr>' + padded.map((cell, cellIndex) => '<td' + alignmentAttr(table[cellIndex]) + '>' + renderInline(cell.trim(), ctx) + '</td>').join('') + '</tr>'
          cursor += 1
        }
        html +=
          '<table><thead><tr>' +
          header.map((cell, cellIndex) => '<th' + alignmentAttr(table[cellIndex]) + '>' + renderInline(cell.trim(), ctx) + '</th>').join('') +
          '</tr></thead><tbody>' +
          body +
          '</tbody></table>'
        index = cursor
        continue
      }
    }

    // Blockquote: strip the marker and render the body as blocks.
    if (/^ {0,3}>/.test(line)) {
      const body = []
      let cursor = index
      while (cursor < lines.length && /^ {0,3}>/.test(lines[cursor])) {
        body.push(lines[cursor].replace(/^ {0,3}>[ \t]?/, ''))
        cursor += 1
      }
      html += '<blockquote>' + renderBlocks(body, ctx, options) + '</blockquote>'
      index = cursor
      continue
    }

    // List.
    if (listMarker(line) !== null) {
      const list = renderList(lines, index, ctx)
      html += list.html
      index = list.next
      continue
    }

    // Authored HTML: a container keeps its contents as MARKDOWN (the README
    // header is `<div align="center">`, blank line, `# title`), anything else
    // is one sanitized fragment.
    const htmlOpen = htmlBlockOpen(line)
    if (htmlOpen !== null) {
      if (HTML_CONTAINERS.has(htmlOpen.tag) && /^ {0,3}<[a-zA-Z][^>]*>\s*$/.test(line)) {
        const openTag = line.trim()
        const closePattern = new RegExp('^ {0,3}<\\/' + htmlOpen.tag + '\\s*>\\s*$', 'i')
        let closeIndex = index + 1
        let depth = 1
        const openPattern = new RegExp('^ {0,3}<' + htmlOpen.tag + '\\b[^>]*>\\s*$', 'i')
        while (closeIndex < lines.length) {
          if (openPattern.test(lines[closeIndex])) depth += 1
          if (closePattern.test(lines[closeIndex])) {
            depth -= 1
            if (depth === 0) break
          }
          closeIndex += 1
        }
        if (closeIndex < lines.length) {
          html += sanitizeTag(openTag, ctx) + renderBlocks(lines.slice(index + 1, closeIndex), ctx, options) + '</' + htmlOpen.tag + '>'
          index = closeIndex + 1
          continue
        }
      }
      const fragment = []
      let cursor = index
      while (cursor < lines.length && lines[cursor].trim() !== '') {
        fragment.push(lines[cursor])
        cursor += 1
      }
      html += sanitizeHtml(fragment.join('\n'), ctx)
      index = cursor
      continue
    }

    // Paragraph: until a blank line or the next block opener.
    const paragraph = []
    let cursor = index
    while (cursor < lines.length && lines[cursor].trim() !== '' && !(cursor > index && startsBlock(lines[cursor]))) {
      paragraph.push(lines[cursor])
      cursor += 1
    }
    html += renderParagraph(paragraph, ctx)
    index = cursor
  }
  return html
}

/** A table cell's alignment, as a class. */
function alignmentAttr(alignment) {
  return alignment ? ' class="md-align-' + alignment + '"' : ''
}

/** A paragraph, with hard breaks where the source asks for one. */
function renderParagraph(lines, ctx) {
  const parts = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const hard = / {2,}$/.test(line) || /\\$/.test(line)
    const value = hard ? line.replace(/\\$/, '').replace(/ {2,}$/, '') : line
    parts.push(renderInline(value, ctx))
    if (hard && index < lines.length - 1) parts.push('<br>')
  }
  return '<p>' + parts.join('\n') + '</p>'
}

// ---------------------------------------------------------------------------
// The print page
// ---------------------------------------------------------------------------

/** The stylesheet the print engine uses; no external asset is named. */
export const PRINT_CSS = `
@page{size:A4;margin:16mm 15mm 18mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:"Segoe UI","Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:10.5pt;line-height:1.65;color:#1f2328;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4,h5,h6{margin:1.2em 0 .5em;line-height:1.3;font-weight:600;break-after:avoid;page-break-after:avoid}
h1{font-size:21pt;padding-bottom:.25em;border-bottom:1px solid #d8dee4}
h2{font-size:16pt;padding-bottom:.2em;border-bottom:1px solid #e4e8ed}
h3{font-size:13pt}
h4{font-size:11.5pt}
h5,h6{font-size:10.5pt}
p{margin:.65em 0}
a{color:#0b62c4;text-decoration:none}
strong{font-weight:600}
ul,ol{margin:.65em 0;padding-left:1.7em}
/* The bullet is a character rather than the engine's marker glyph: headless
   Windows Chrome substitutes a font for the disc marker, and the PDF then
   carries a glyph no other viewer draws as a bullet. */
ul{list-style:none;padding-left:1.4em}
ul>li{position:relative}
ul>li::before{content:"\\2022";position:absolute;left:-1em;color:#57606a}
ul ul>li::before{content:"\\25E6"}
ul ul ul>li::before{content:"\\25AA"}
li{margin:.2em 0}
li>p{margin:.2em 0}
li>ul,li>ol{margin:.2em 0}
blockquote{margin:.8em 0;padding:.15em 0 .15em 12px;border-left:3px solid #d0d7de;color:#57606a}
blockquote p{margin:.3em 0}
code{font-family:Consolas,"SFMono-Regular",Menlo,"DejaVu Sans Mono",monospace;font-size:.88em;background:#f2f4f7;padding:.12em .35em;border-radius:3px}
pre{margin:.8em 0;padding:10px 12px;background:#f6f8fa;border:1px solid #e4e8ed;border-radius:5px;overflow:visible;white-space:pre-wrap;word-break:break-word;break-inside:avoid;page-break-inside:avoid}
pre code{background:none;padding:0;font-size:9pt;line-height:1.5}
table{border-collapse:collapse;margin:.8em 0;max-width:100%;font-size:.95em}
th,td{border:1px solid #d0d7de;padding:5px 9px;vertical-align:top}
th{background:#f6f8fa;font-weight:600}
tr{break-inside:avoid;page-break-inside:avoid}
td.md-align-right,th.md-align-right{text-align:right}
td.md-align-center,th.md-align-center{text-align:center}
td.md-align-left,th.md-align-left{text-align:left}
img{max-width:100%;height:auto}
hr{margin:1.5em 0;border:0;border-top:1px solid #d8dee4}
summary{font-weight:600;cursor:default;list-style:none}
summary::-webkit-details-marker{display:none}
details{margin:.7em 0}
.md-task{margin-right:.35em}
.md-altImage{color:#57606a;font-style:italic}
kbd{font-family:Consolas,monospace;font-size:.85em;border:1px solid #d0d7de;border-bottom-width:2px;border-radius:4px;padding:.05em .35em;background:#f6f8fa}
`

/**
 * Render one Markdown document to the HTML the print engine receives.
 *
 * @param markdown - the document's text.
 * @param options - `{ title, filePath, rootDir }` (all optional).
 * @returns a complete, self-contained HTML document.
 */
export function buildPrintDocument(markdown, options = {}) {
  const source = String(markdown).replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const references = collectReferences(lines)
  const ctx = {
    refs: references.refs,
    filePath: options.filePath,
    rootDir: options.rootDir,
    images: { bytes: 0, count: 0 },
  }
  const body = renderBlocks(references.lines, ctx)
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : 'Document'
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<style>' + PRINT_CSS + '</style>\n' +
    '</head>\n<body>\n' + body + '\n</body>\n</html>\n'
  )
}

// ---------------------------------------------------------------------------
// The print engine
// ---------------------------------------------------------------------------

/** Where a browser might be, per platform, before PATH is consulted. */
export function engineCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((value) => typeof value === 'string' && value !== '')
    const out = []
    for (const root of roots) {
      out.push({ file: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' })
      out.push({ file: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' })
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      { file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
      { file: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
    ]
  }
  return [
    { file: '/usr/bin/google-chrome', kind: 'chrome' },
    { file: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { file: '/usr/bin/chromium', kind: 'chromium' },
    { file: '/usr/bin/chromium-browser', kind: 'chromium' },
    { file: '/usr/bin/microsoft-edge', kind: 'edge' },
    { file: '/snap/bin/chromium', kind: 'chromium' },
  ]
}

/** The browser on this host, or null. Not cached: an install mid-session counts. */
export function resolvePdfEngine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  for (const variable of ['DSH_EDITOR_PDF_ENGINE', 'DSH_SCREENSHOT_ENGINE']) {
    const override = env[variable]
    if (typeof override === 'string' && override !== '' && existsSync(override)) return { file: override, kind: 'override', source: variable }
  }
  for (const candidate of engineCandidates(platform, env)) {
    if (existsSync(candidate.file)) return { ...candidate, source: 'install' }
  }
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const directories = String(env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((value) => value !== '')
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return { file: candidate, kind: 'path', source: 'PATH' }
    }
  }
  return null
}

/** The Desktop a freedesktop host names in `user-dirs.dirs` (`XDG_DESKTOP_DIR`). */
async function xdgDesktop(env) {
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null)
  if (configHome === null) return null
  let text
  try {
    text = await fsp.readFile(path.join(configHome, 'user-dirs.dirs'), 'utf8')
  } catch (err) {
    return null
  }
  const match = /^[ \t]*XDG_DESKTOP_DIR[ \t]*=[ \t]*"([^"]*)"/m.exec(text)
  if (match === null) return null
  const home = env.HOME
  if (typeof home !== 'string' || home === '') return null
  const value = match[1].replace(/^\$HOME(?=\/|$)/, home)
  return path.isAbsolute(value) ? value : null
}

/**
 * The folder an export lands in: the Desktop of the machine running the harness.
 *
 * Resolved PER REQUEST and never cached, because a Windows profile can be
 * redirected into OneDrive and a Linux desktop can name its own folder
 * (`~/.config/user-dirs.dirs`); the home folder is the last resort so an export
 * always has somewhere to go. `DSH_EDITOR_PDF_DIR` is the one override - a test
 * and a person whose "Desktop" is somewhere else use the same switch - and it is
 * created if missing. The plain `~/Desktop` spelling is never assumed.
 *
 * @param env - the environment to read (default `process.env`).
 * @returns {Promise<string>} an existing directory.
 */
export async function exportDirectory(env = process.env) {
  const override = env.DSH_EDITOR_PDF_DIR
  if (typeof override === 'string' && override !== '') {
    const directory = path.resolve(override)
    try {
      await fsp.mkdir(directory, { recursive: true })
    } catch (err) {
      throw pdfError(500, 'NO_DESKTOP', 'The export folder is not available: ' + directory, err)
    }
    return directory
  }
  const profile = env.USERPROFILE
  const home = env.HOME
  let osHome = null
  try {
    osHome = os.homedir()
  } catch (err) {
    osHome = null
  }
  const candidates = [
    // Windows, plain and OneDrive-redirected.
    profile ? path.join(profile, 'Desktop') : null,
    profile ? path.join(profile, 'OneDrive', 'Desktop') : null,
    // macOS / Linux, plain and configured.
    home ? path.join(home, 'Desktop') : null,
    await xdgDesktop(env),
    osHome ? path.join(osHome, 'Desktop') : null,
    osHome ? path.join(osHome, 'OneDrive', 'Desktop') : null,
    // Nowhere better: the home folder itself.
    profile,
    home,
    osHome,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      const info = await fsp.stat(candidate)
      if (info.isDirectory()) return candidate
    } catch (err) {
      /* try the next candidate */
    }
  }
  throw pdfError(500, 'NO_DESKTOP', 'This host has no Desktop or home folder to save the export into.')
}

/** A file-name stem that cannot escape the folder or confuse Windows. */
export function exportStem(name) {
  let stem = String(name ?? '')
    .replace(/\.(?:md|markdown|mdown|txt)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (stem === '') stem = 'document'
  return stem.slice(0, 120)
}

/** Kill one pid tree, by pid only (Chrome re-executes on Windows). */
function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err2) {
      // already gone
    }
  }
}

/**
 * Ask the browser to print one HTML file.
 *
 * Chrome can write its progress line before the file is complete and, on
 * Windows, the process we spawned may hand off and exit first. So the PDF is
 * waited for by its own bytes (present, non-empty, stable across a second read),
 * not by the exit code; a process that dies with no file reports its stderr.
 */
async function printHtml(engine, htmlPath, pdfPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PRINT_TIMEOUT_MS
  const profileDir = htmlPath + '.profile'
  await fsp.mkdir(profileDir, { recursive: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--password-store=basic',
    '--use-mock-keychain',
    '--user-data-dir=' + profileDir,
    '--no-pdf-header-footer',
    '--print-to-pdf=' + pdfPath,
    '--virtual-time-budget=5000',
    '--run-all-compositor-stages-before-draw',
    // Nothing may be fetched: the page is self-contained, and a name that is
    // not already inline (a remote image was dropped during rendering) cannot
    // become a request this plugin started.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    pathToFileURL(htmlPath).href,
  ]
  const child = spawn(engine.file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  const deadline = Date.now() + timeoutMs
  let exitState = null
  exited.then((state) => {
    exitState = state
  })
  try {
    for (;;) {
      let size = 0
      try {
        const stat = await fsp.stat(pdfPath)
        size = stat.size
      } catch (err) {
        size = 0
      }
      if (size > 0) {
        await delay(120)
        let settled = 0
        try {
          settled = (await fsp.stat(pdfPath)).size
        } catch (err) {
          settled = 0
        }
        if (settled === size) return await fsp.readFile(pdfPath)
      }
      if (exitState !== null) {
        await delay(250)
        try {
          const stat = await fsp.stat(pdfPath)
          if (stat.size > 0) return await fsp.readFile(pdfPath)
        } catch (err) {
          // fall through to the failure below
        }
        const why = exitState.signal !== null ? 'was killed by ' + exitState.signal : 'exited with code ' + String(exitState.code)
        throw pdfError(500, 'RENDER_FAILED', 'The print engine ' + why + ' before it wrote a PDF.' + (stderr.trim() !== '' ? ' ' + stderr.trim() : ''))
      }
      if (Date.now() > deadline) {
        throw pdfError(504, 'RENDER_TIMEOUT', 'The print engine did not write a PDF within ' + String(Math.round(timeoutMs / 1000)) + ' s.')
      }
      await delay(120)
    }
  } finally {
    killTree(child.pid)
    if (exitState === null) {
      await Promise.race([exited, delay(1500)])
    }
  }
}

/**
 * Print one Markdown document and publish the PDF as a NEW file in `~/Desktop`.
 *
 * @param options - `{ markdown, filePath, title, rootDir, env, engine, logger }`.
 * @returns `{ ok, name, path, bytes }`; throws a typed error otherwise.
 */
export async function exportMarkdownToPdf(options) {
  const markdown = typeof options.markdown === 'string' ? options.markdown : ''
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw pdfError(413, 'TOO_LARGE', 'The document is larger than ' + String(MAX_MARKDOWN_BYTES / 1024 / 1024) + ' MiB and was not exported.')
  }
  const env = { ...process.env, ...(options.env ?? {}) }
  const engine = options.engine === undefined ? resolvePdfEngine({ env }) : options.engine
  if (engine === null) {
    throw pdfError(
      503,
      'NO_ENGINE',
      'No Chromium-family browser was found to print with. Install Google Chrome or Microsoft Edge, or point DSH_EDITOR_PDF_ENGINE at the executable.',
    )
  }
  const destination = await exportDirectory(env)

  const stem = exportStem(options.title ?? (typeof options.filePath === 'string' ? path.basename(options.filePath) : 'document'))
  const html = buildPrintDocument(markdown, {
    title: stem,
    filePath: options.filePath,
    rootDir: options.rootDir,
  })
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-editor-pdf-'))
  const htmlPath = path.join(tempDir, 'document.html')
  const pdfPath = path.join(tempDir, 'document.pdf')
  try {
    await fsp.writeFile(htmlPath, html, 'utf8')
    const pdf = await printHtml(engine, htmlPath, pdfPath, { timeoutMs: options.timeoutMs })
    if (pdf.length === 0 || pdf.toString('latin1', 0, 5) !== '%PDF-') {
      throw pdfError(500, 'RENDER_FAILED', 'The print engine wrote something that is not a PDF, so nothing was saved.')
    }
    let published = null
    for (let attempt = 1; attempt <= 500; attempt += 1) {
      const name = attempt === 1 ? stem + '.pdf' : stem + ' (' + attempt + ').pdf'
      const target = path.join(destination, name)
      try {
        await fsp.copyFile(pdfPath, target, fsConstants.COPYFILE_EXCL)
        published = { name, path: target, bytes: pdf.length }
        break
      } catch (err) {
        if (err && err.code === 'EEXIST') continue
        throw pdfError(500, 'IO_ERROR', 'Could not save the PDF in ' + destination + '.', err)
      }
    }
    if (published === null) {
      throw pdfError(409, 'TOO_MANY_EXPORTS', 'There are already 500 exports named "' + stem + '" in ' + destination + '.')
    }
    return { ok: true, ...published }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The pure helpers a check drives without a browser or a Desktop. */
export const __internals = {
  collectReferences,
  exportStem,
  imageDataUrl,
  normalizeReference,
  renderBlocks,
  renderInline,
  sanitizeHtml,
  splitTableRow,
  startsBlock,
  tableDelimiter,
}
