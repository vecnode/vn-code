/**
 * dsh-writing — the XML the OOXML reader needs, and no more.
 *
 * `word/document.xml` is a tree of elements with attributes and text, and this
 * package has no XML dependency (the pack's rule: zero npm dependencies, engines
 * vendored or already on disk). A browser would have `DOMParser`; the host half
 * does the unzipping, so the host needs a parser, and this is it: ~180 lines that
 * understand what a document part actually contains.
 *
 * Deliberately absent, each with the reason it is not needed here:
 *
 *   - **Namespaces are not resolved.** OOXML prefixes are load-bearing and the
 *     reader matches on them (`w:p`), so each node carries `name` (as written)
 *     and `local` (after the colon); nothing depends on a namespace URI.
 *   - **No DTDs, no entities beyond the five predefined and numeric escapes.** A
 *     `<!DOCTYPE>` is skipped rather than expanded, which is also what makes this
 *     parser safe on a file from anywhere: there is no external resolution and no
 *     entity expansion to abuse.
 *   - **No validation.** A malformed part throws one typed error at the offset it
 *     was found - the caller turns that into "this file is not a document".
 *
 * Both ceilings are real and enforced while walking, not after: a part that
 * claims a million nodes is refused as it is read.
 */
/** At most this many elements in one part. */
export const MAX_XML_NODES = 200_000
/** At most this many characters in one part. */
export const MAX_XML_CHARS = 32 * 1024 * 1024
/** At most this deep a part may nest. */
export const MAX_XML_DEPTH = 200

/** A typed XML failure. */
function xmlError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Escape text for element content.
 * @param text - raw text.
 * @returns the escaped text.
 */
export function escapeXml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Escape text for a double-quoted attribute value.
 * @param text - raw text.
 * @returns the escaped text.
 */
export function escapeAttr(text) {
  return escapeXml(text).replaceAll('"', '&quot;')
}

/** Decode the entity forms OOXML parts actually use. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch (err) {
        return whole
      }
    }
    switch (body) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return whole
    }
  })
}

/** One element: its name as written, its local name, its attributes and children. */
function element(name, attrs) {
  return { name, local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, attrs, children: [] }
}

/**
 * Parse one XML document into a tree.
 *
 * @param text - the part's text.
 * @returns the document node: `{ name: '#document', attrs: {}, children: [...] }`,
 *   whose children are elements and strings (text runs).
 */
export function parseXml(text) {
  const source = String(text ?? '')
  if (source.length > MAX_XML_CHARS) throw xmlError('TOO_LARGE', 'The XML part is larger than the parser accepts.')
  const root = element('#document', {})
  const stack = [root]
  let index = 0
  let nodes = 0
  // One text buffer per open element, so a text run between two tags cannot be
  // attached to the wrong parent.
  const append = (value) => {
    if (value.length === 0) return
    stack[stack.length - 1].children.push(decodeEntities(value))
  }
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) {
      append(source.slice(index))
      break
    }
    append(source.slice(index, open))
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      index = close === -1 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const close = source.indexOf(']]>', open + 9)
      const body = close === -1 ? source.slice(open + 9) : source.slice(open + 9, close)
      // CDATA is literal: no entity decoding, which is the one thing it means.
      if (body.length > 0) stack[stack.length - 1].children.push(body)
      index = close === -1 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<?', open)) {
      const close = source.indexOf('?>', open + 2)
      index = close === -1 ? source.length : close + 2
      continue
    }
    if (source.startsWith('<!', open)) {
      // A DOCTYPE (or any other declaration) is skipped whole. Nothing in a
      // document part needs it, and skipping is what keeps this parser free of
      // entity expansion.
      const close = source.indexOf('>', open + 2)
      index = close === -1 ? source.length : close + 1
      continue
    }
    const close = source.indexOf('>', open)
    if (close === -1) throw xmlError('BAD_XML', 'An element is not closed at offset ' + open + '.')
    const inner = source.slice(open + 1, close).trim()
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (stack.length === 1) throw xmlError('BAD_XML', 'A closing tag </' + name + '> has no open element.')
      const node = stack.pop()
      if (node.name !== name) {
        throw xmlError('BAD_XML', 'Expected </' + node.name + '> but found </' + name + '>.')
      }
      index = close + 1
      continue
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameMatch = /^([^\s/>]+)/.exec(body)
    if (!nameMatch) throw xmlError('BAD_XML', 'An element has no name at offset ' + open + '.')
    const name = nameMatch[1]
    const attrs = {}
    const attrSource = body.slice(name.length)
    const attrPattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let match = attrPattern.exec(attrSource)
    while (match) {
      const raw = match[3] !== undefined ? match[3] : match[4]
      attrs[match[1]] = decodeEntities(raw)
      match = attrPattern.exec(attrSource)
    }
    nodes += 1
    if (nodes > MAX_XML_NODES) throw xmlError('TOO_LARGE', 'The XML part has more elements than the parser accepts.')
    if (stack.length > MAX_XML_DEPTH) throw xmlError('TOO_DEEP', 'The XML part nests deeper than the parser accepts.')
    const node = element(name, attrs)
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    index = close + 1
  }
  if (stack.length !== 1) throw xmlError('BAD_XML', 'The part ends with ' + (stack.length - 1) + ' element(s) still open.')
  return root
}

/** Every descendant element with this local name, in document order. */
export function findAll(node, localName) {
  const out = []
  const walk = (current) => {
    for (const child of current.children) {
      if (typeof child === 'string') continue
      if (child.local === localName) out.push(child)
      walk(child)
    }
  }
  if (node) walk(node)
  return out
}

/** The first child element with this local name, or null. */
export function firstChild(node, localName) {
  if (!node) return null
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (localName === null || child.local === localName) return child
  }
  return null
}

/** Every direct child element with this local name. */
export function childrenNamed(node, localName) {
  const out = []
  if (!node) return out
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (child.local === localName) out.push(child)
  }
  return out
}

/** An attribute by its full name (`w:val`) or, failing that, by local name. */
export function attrOf(node, name) {
  if (!node || !node.attrs) return undefined
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name]
  const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key === local || key.endsWith(':' + local)) return value
  }
  return undefined
}

/** All text under one element, concatenated. */
export function textContent(node) {
  if (!node) return ''
  let out = ''
  for (const child of node.children) out += typeof child === 'string' ? child : textContent(child)
  return out
}
