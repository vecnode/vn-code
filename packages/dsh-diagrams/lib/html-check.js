/**
 * dsh-diagrams — the HTML check: what an `html` diagram must be before it is
 * stored, and what is only advised.
 *
 * WHY THIS EXISTS
 * ---------------
 * An authored `html` diagram is a whole DOCUMENT that this plugin then serves
 * into a sandboxed frame. Mermaid and TikZ cannot reach the network or run
 * script; a document can, so "it parses" is not a strong enough verdict for it.
 * The rules below are a faithful port of the contract the upstream design kit
 * ships in `scripts/self_check.py` (vendored at `lib/vendor/design/scripts/`),
 * which the author of that kit runs over every one of the 204 examples they
 * publish. The pack does not run Python, so the contract is re-implemented here
 * in zero-dependency JavaScript - and `checks/check-diagrams-kit.mjs` proves the
 * port by running BOTH over all 204 vendored examples and requiring the same
 * answer.
 *
 * TWO TIERS, AND WHY THEY ARE NOT THE SAME TIER
 * ---------------------------------------------
 *   - A **safety finding** is a REFUSAL (`ok: false`): a remote asset, an
 *     executable attribute, a forbidden element, or a script that is not the
 *     kit's own motion controller. A document like that is not a diagram with a
 *     typo in it; it is something that would run in the user's browser the
 *     moment it opened, and no amount of advisory wording makes that acceptable.
 *   - A **craft finding** is a WARNING (`ok` stays true): no drawing, no
 *     accessible name, a node budget blown, an animation with no reduced-motion
 *     fallback, a palette that will not survive the dark theme. The upstream
 *     treats these as errors because it is linting its own published gallery;
 *     here a person may legitimately overrule one, exactly like the Mermaid
 *     linter's "nodes with no edges" - so it informs and does not block.
 *
 * The one place the two tiers meet is the MOTION CONTRACT: a document that
 * carries the canonical motion script is claiming to implement it, so its
 * violations are refusals; a document with no script is a static picture and its
 * motion-shaped findings are warnings.
 *
 * @module
 */

/** Elements that can pull in, execute or replace content, and are never a diagram. */
const FORBIDDEN_ELEMENTS = ['base', 'embed', 'object', 'iframe', 'applet', 'frame', 'frameset']
/** Attributes that name a resource. */
const REFERENCE_ATTRIBUTES = ['src', 'href', 'xlink:href', 'poster', 'srcset', 'action', 'formaction', 'data']
/** Attributes that hold CSS. */
const CSS_ATTRIBUTES = ['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']
/** The only script the kit's own examples carry. */
const MOTION_SCRIPT_ATTRIBUTE = 'data-diagram-controls'
/** Motion modes the canonical controller understands. */
const MOTION_MODES = ['none', 'reveal', 'step', 'loop']
/** The five controls the canonical controller binds. */
const MOTION_ACTIONS = ['play', 'pause', 'replay', 'prev', 'next']
/** The upstream's own budget: above this a diagram is two diagrams. */
export const MAX_NODES = 9
/** How many findings of each tier are handed back. */
export const MAX_FINDINGS = 12

/** One finding: `{ kind, text }`, the shape the store and the tool already carry. */
const finding = (kind, text) => ({ kind, text })

/**
 * One forgiving HTML tokenizer.
 *
 * Deliberately not a parser: this runs over documents a model wrote, so it has
 * to keep going through the malformed ones instead of throwing. It yields
 * elements with their attributes and their depth, the TEXT of every
 * `<script>`/`<style>`, and whether a `<script>` was closed - which is all the
 * rules below need, and none of the tree-building the pack's zero-dependency
 * rule would make expensive.
 *
 * @param html - the document source.
 * @returns `{ elements, scripts, styles, cssTexts, closedScripts }`.
 */
export function tokenize(html) {
  const source = String(html ?? '')
  const elements = []
  const scripts = []
  const styles = []
  const cssTexts = []
  let closedScripts = 0
  let depth = 0
  let index = 0

  // An SVG `<desc>` holds prose, and `<title>` holds a name: both are read as
  // TEXT. Without `desc` here its content is tokenized as markup and its own
  // accessible name reads as empty - which is how the first draft of this port
  // refused 207 of the kit's own examples.
  const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'desc'])

  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) break
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const end = source.indexOf('>', open)
      index = end === -1 ? source.length : end + 1
      continue
    }
    const close = source.indexOf('>', open)
    if (close === -1) break
    let body = source.slice(open + 1, close)
    let selfClosing = false
    if (body.endsWith('/')) {
      selfClosing = true
      body = body.slice(0, -1)
    }
    const isEnd = body.startsWith('/')
    if (isEnd) body = body.slice(1)
    const nameMatch = /^([A-Za-z][A-Za-z0-9:_-]*)/.exec(body)
    if (!nameMatch) {
      index = close + 1
      continue
    }
    const name = nameMatch[1].toLowerCase()

    if (isEnd) {
      depth = Math.max(0, depth - 1)
      index = close + 1
      continue
    }

    const attributes = parseAttributes(body.slice(nameMatch[0].length))
    const element = { name, attributes, depth, selfClosing, text: '' }
    elements.push(element)

    if (RAW_TEXT.has(name)) {
      // A raw-text element runs to its own closing tag; the text is content, not
      // markup, which is exactly why a `<script>` is checked by its BYTES and why
      // a `<title>` is checked by its TEXT.
      const closing = new RegExp('</' + name + '\\s*>', 'i')
      const rest = source.slice(close + 1)
      const match = closing.exec(rest)
      const text = match ? rest.slice(0, match.index) : rest
      element.text = decodeEntities(text)
      if (name === 'script') {
        scripts.push({ attributes, body: text, closed: Boolean(match), depth })
        if (match) closedScripts += 1
      } else if (name === 'style') {
        styles.push({ attributes, body: text, closed: Boolean(match), depth })
        cssTexts.push(text)
      }
      index = match ? close + 1 + match.index + match[0].length : source.length
      continue
    }

    if (!selfClosing && !isVoidElement(name)) depth += 1
    index = close + 1
  }

  // The CSS an element carries, from `style` and from the SVG presentation
  // attributes that can name a resource (`fill`, `filter`, `mask`, `marker`...).
  // Collected in one pass so `checkCss` sees every place a URL could hide.
  for (const element of elements) {
    for (const attribute of element.attributes) {
      if (CSS_ATTRIBUTES.includes(attribute.name) && attribute.value) cssTexts.push(attribute.value)
    }
  }

  return { elements, scripts, styles, cssTexts, closedScripts }
}

/** Void elements, which never open a level. */
function isVoidElement(name) {
  return ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(name)
}

/** Attributes of one start tag, lowercased names, entity-decoded values. */
function parseAttributes(text) {
  const attributes = []
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attributes.push({ name: match[1].toLowerCase(), value: decodeEntities(value) })
  }
  return attributes
}

/** The five entities that matter in an attribute holding a URL or CSS. */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

/** CSS escapes, resolved the way a browser resolves them, before any CSS rule runs. */
function normalizeCssEscapes(text) {
  return String(text).replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|(.))/gs, (_, hex, literal) => {
    if (hex) {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    }
    return literal ?? ''
  })
}

/**
 * Is this the one remote stylesheet a kit example is allowed to name?
 *
 * The upstream allows exactly `https://fonts.googleapis.com/css2?...`. The
 * composed document strips it (the plugin starts no network request of its own),
 * but it must be RECOGNISED here rather than refused, or every one of the
 * upstream's own examples would fail the check.
 *
 * @param value - the `href`.
 * @returns true when it is the approved Google Fonts stylesheet.
 */
export function isApprovedFontsStylesheet(value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return false
  let url
  try {
    url = new URL(raw)
  } catch (err) {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname !== 'fonts.googleapis.com') return false
  return url.pathname === '/css' || url.pathname === '/css2'
}

/**
 * Why a reference is refused, or null when it is fine.
 *
 * A `#fragment` is a reference inside the document; anything else is a resource
 * the frame would have to fetch, and the frame's own CSP would refuse it anyway.
 *
 * @param element - the element carrying it.
 * @param attribute - the attribute carrying it.
 * @returns a sentence, or null.
 */
function referenceProblem(element, attribute) {
  const value = String(attribute.value ?? '').trim()
  if (value.length === 0 || value.startsWith('#')) return null
  if (element.name === 'link' && attribute.name === 'href' && isApprovedFontsStylesheet(value)) return null
  const rel = (element.attributes.find((one) => one.name === 'rel')?.value ?? '').toLowerCase()
  if (element.name === 'a' && attribute.name === 'href' && value.startsWith('https://')) {
    return 'a link to ' + value + ' is allowed only as a `data-*`-free href; the frame cannot navigate, so remove it or make it a text note'
  }
  return (
    '`' + attribute.name + '="' + value + '"` on <' + element.name + '> is a remote reference' +
    (rel.includes('stylesheet') ? ' (the only remote stylesheet allowed is the Google Fonts one)' : '') +
    '. A diagram is self-contained: inline the asset, or drop it.'
  )
}

/** Every reference problem in one document, in document order. */
function checkReferences(elements, refusals) {
  for (const element of elements) {
    for (const attribute of element.attributes) {
      if (!REFERENCE_ATTRIBUTES.includes(attribute.name)) continue
      // `<use href="#id">`, `<a href="#x">` and a `data:` image are all local.
      if (attribute.name === 'data' && element.name !== 'object') continue
      const problem = referenceProblem(element, attribute)
      if (problem) refusals.push(finding('safety', problem))
    }
  }
}

/** CSS that would fetch something, or that the frame's CSP would silently drop. */
function checkCss(cssTexts, refusals) {
  for (const raw of cssTexts) {
    const text = normalizeCssEscapes(raw)
    if (/@import\b/i.test(text)) {
      refusals.push(finding('safety', 'CSS `@import` is not allowed: a diagram is one file with no imports.'))
    }
    const urls = text.match(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi) ?? []
    for (const call of urls) {
      const value = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(call)
      const target = String(value?.[1] ?? value?.[2] ?? value?.[3] ?? '').trim()
      if (target.length === 0) continue
      if (!target.startsWith('#')) {
        refusals.push(finding('safety', 'CSS `url(' + target + ')` is not a fragment reference. Inline the asset as a data URI or drop it.'))
      }
    }
    if (/(?:-webkit-)?image-set\s*\(/i.test(text)) {
      refusals.push(finding('safety', 'CSS `image-set()` is not allowed: a diagram carries one rendering of one asset.'))
    }
    if (/(?:https?:)?\/\//i.test(text.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      refusals.push(finding('safety', 'a remote reference in CSS is not allowed; inline the asset or drop it.'))
    }
  }
}

/** Elements and attributes that execute or replace the document. */
function checkExecutable(elements, refusals) {
  for (const element of elements) {
    if (FORBIDDEN_ELEMENTS.includes(element.name)) {
      refusals.push(finding('safety', '<' + element.name + '> is not allowed in a diagram file.'))
    }
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith('on')) {
        refusals.push(finding('safety', 'the executable attribute `' + attribute.name + '` on <' + element.name + '> is not allowed; the frame runs no handler of yours.'))
      }
      if (attribute.name === 'srcdoc') {
        refusals.push(finding('safety', '`srcdoc` on <' + element.name + '> is not allowed: it embeds a second document.'))
      }
    }
  }
}

/**
 * Scripts: at most one, and it must BE the kit's motion controller.
 *
 * @param scripts - from {@link tokenize}.
 * @param motionHash - the sha256 of the canonical controller's body.
 * @param sha256 - the hash function to use (injected so this module stays pure).
 * @returns `{ refusals, motion }` where `motion` is true when the canonical
 *   controller is present.
 */
function checkScripts(scripts, motionHash, sha256) {
  const refusals = []
  let motion = false
  if (scripts.length === 0) return { refusals, motion }
  if (scripts.length > 1) {
    refusals.push(finding('safety', 'at most one script is allowed; this document has ' + scripts.length + '.'))
  }
  for (const script of scripts) {
    if (!script.closed) refusals.push(finding('safety', 'the script is never closed; a document must end its own tags.'))
    const names = script.attributes.map((attribute) => attribute.name)
    if (names.length !== 1 || names[0] !== MOTION_SCRIPT_ATTRIBUTE) {
      refusals.push(
        finding(
          'safety',
          'a script may carry only `' + MOTION_SCRIPT_ATTRIBUTE + '`. The only script a diagram may run is the kit\u2019s own motion controller - read it with diagram_kit({action:"reference", ref:"animation"}) and copy it exactly.',
        ),
      )
      continue
    }
    const digest = sha256(String(script.body ?? ''))
    if (motionHash && digest !== motionHash) {
      refusals.push(
        finding(
          'safety',
          'this motion controller is not the canonical one (its body hashes to ' +
            digest.slice(0, 12) +
            ', the kit\u2019s is ' +
            motionHash.slice(0, 12) +
            '). Read the controller with diagram_kit({action:"example", id:"template-motion"}) and use it unchanged.',
        ),
      )
      continue
    }
    motion = true
  }
  return { refusals, motion }
}

/** The accessible-SVG contract, which is also what makes the picture exportable. */
function checkSvgs(elements, warnings, refusals) {
  const svgs = elements.filter((element) => element.name === 'svg')
  if (svgs.length === 0) {
    warnings.push(finding('structure', 'there is no <svg> in this document, so there is nothing to draw.'))
    return
  }
  const accessible = svgs.filter((element) => !element.attributes.some((attribute) => attribute.name === 'aria-hidden' && attribute.value === 'true'))
  if (accessible.length === 0) {
    refusals.push(finding('structure', 'every <svg> is aria-hidden, so the diagram has no accessible name at all.'))
    return
  }
  const ids = new Map()
  for (const element of elements) {
    const id = element.attributes.find((attribute) => attribute.name === 'id')
    if (id && id.value) ids.set(id.value, (ids.get(id.value) ?? 0) + 1)
  }
  const seenNaming = new Set()
  accessible.forEach((svg, index) => {
    const label = 'svg ' + (index + 1)
    const role = svg.attributes.find((attribute) => attribute.name === 'role')
    if (!role || role.value !== 'img') refusals.push(finding('structure', label + ' needs role="img".'))
    const own = elements.indexOf(svg)
    const title = elements.slice(own + 1).find((element) => element.depth === svg.depth + 1 && element.name === 'title')
    const desc = elements.slice(own + 1).find((element) => element.depth === svg.depth + 1 && element.name === 'desc')
    if (!title || !desc) {
      refusals.push(finding('structure', label + ' needs a <title> and a <desc> as its first children, in that order.'))
      return
    }
    if (elements.slice(own + 1, elements.indexOf(title)).some((element) => element.depth === svg.depth + 1)) {
      refusals.push(finding('structure', label + ' must open with its <title>, before any other child.'))
    }
    const titleId = title.attributes.find((attribute) => attribute.name === 'id')?.value ?? ''
    const descId = desc.attributes.find((attribute) => attribute.name === 'id')?.value ?? ''
    // The accessible name has to SAY something: an empty <title> passes every
    // structural rule and still leaves a screen reader with nothing.
    if (String(title.text ?? '').trim().length === 0 || String(desc.text ?? '').trim().length === 0) {
      refusals.push(finding('structure', label + ' needs a non-empty <title> and <desc>.'))
    }
    if (!titleId || !descId) {
      refusals.push(finding('structure', label + ' must give its <title> and <desc> ids, so aria-labelledby can name them.'))
      return
    }
    if (titleId === '' || descId === '' || titleId === 'title' || descId === 'desc') {
      refusals.push(finding('structure', label + ' must prefix its <title>/<desc> ids with the diagram\u2019s own name (never a bare "title"/"desc").'))
      return
    }
    if (seenNaming.has(titleId) || seenNaming.has(descId)) {
      refusals.push(finding('structure', label + ' reuses an accessible-naming id (' + titleId + ' / ' + descId + '); ids must be unique.'))
    }
    seenNaming.add(titleId)
    seenNaming.add(descId)
    if ((ids.get(titleId) ?? 0) > 1) refusals.push(finding('structure', 'the id "' + titleId + '" is declared more than once.'))
    if ((ids.get(descId) ?? 0) > 1) refusals.push(finding('structure', 'the id "' + descId + '" is declared more than once.'))
    const labelled = svg.attributes.find((attribute) => attribute.name === 'aria-labelledby')?.value ?? ''
    if (labelled.split(/\s+/).filter(Boolean).join(' ') !== titleId + ' ' + descId) {
      refusals.push(finding('structure', label + ' needs aria-labelledby="' + titleId + ' ' + descId + '" (title then desc).'))
    }
  })
}

/** The upstream's take on style: no element is `hidden`, focusable attributes are paired. */
function checkStyleRules(elements, refusals) {
  for (const element of elements) {
    if (element.name === 'style' || element.name === 'script') continue
    const hidden = element.attributes.find((attribute) => attribute.name === 'hidden')
    const focusable = element.attributes.find((attribute) => attribute.name === 'focusable')
    if (hidden && focusable && focusable.value === 'false') {
      refusals.push(finding('motion', '<' + element.name + '> cannot be both hidden and focusable="false": the static frame must be visible.'))
    }
  }
}

/** Everything the canonical motion controller needs in the markup to work. */
function checkMotion(elements, cssTexts, html, refusals, warnings) {
  const motionElements = elements.filter((element) => element.attributes.some((attribute) => attribute.name.startsWith('data-motion-')))
  const roots = elements.filter((element) => element.attributes.some((attribute) => attribute.name === 'data-motion-root'))
  if (motionElements.length === 0) return
  if (roots.length !== 1) {
    refusals.push(finding('motion', 'motion markup needs exactly one data-motion-root; found ' + roots.length + '.'))
    return
  }
  const root = roots[0]
  const attribute = (element, name) => element.attributes.find((one) => one.name === name)?.value ?? ''
  const mode = attribute(root, 'data-motion-mode')
  if (!MOTION_MODES.includes(mode)) {
    refusals.push(finding('motion', 'data-motion-mode must be one of ' + MOTION_MODES.join(', ') + '; found "' + mode + '".'))
  }
  const countText = attribute(root, 'data-step-count')
  if (!/^[0-9]+$/.test(countText)) {
    refusals.push(finding('motion', 'data-step-count must be an ASCII decimal integer; found "' + countText + '".'))
    return
  }
  const count = Number(countText)
  if (count < 1 || count > 8) {
    refusals.push(finding('motion', 'a semantic step count must be 1..8; found ' + count + '.'))
  }
  const items = elements.filter((element) => element.attributes.some((one) => one.name === 'data-motion-item'))
  if (items.length > 12) {
    refusals.push(finding('motion', 'the motion item budget is 12; found ' + items.length + '.'))
  }
  const steps = []
  items.forEach((item, index) => {
    const step = attribute(item, 'data-step')
    const decorative = item.attributes.some((one) => one.name === 'data-motion-decorative')
    if (!/^[0-9]+$/.test(step)) {
      refusals.push(finding('motion', 'motion item ' + (index + 1) + ' has a non-decimal data-step ("' + step + '").'))
      return
    }
    if (decorative) {
      if (attribute(item, 'aria-hidden') !== 'true' || attribute(item, 'focusable') !== 'false') {
        refusals.push(finding('motion', 'decorative motion item ' + (index + 1) + ' needs aria-hidden="true" and focusable="false".'))
      }
      return
    }
    steps.push(Number(step))
    if (!attribute(item, 'aria-label')) {
      refusals.push(finding('motion', 'semantic motion item ' + (index + 1) + ' needs a non-empty aria-label: it is what the step is announced as.'))
    }
  })
  const unique = [...new Set(steps)].sort((a, b) => a - b)
  const expected = Array.from({ length: count }, (_, index) => index + 1)
  if (unique.join(',') !== expected.join(',')) {
    refusals.push(finding('motion', 'semantic steps must be contiguous 1..' + count + '; found ' + (unique.join(',') || 'none') + '.'))
  }
  // The upstream's rule counts the STEPS that are crowded, not the items: three
  // items sharing one step is one crowded step, not three. Counting the items
  // refused three of the kit's own animated examples, which is exactly the kind
  // of near-miss the corpus check exists to catch.
  const perStep = new Map()
  for (const step of steps) perStep.set(step, (perStep.get(step) ?? 0) + 1)
  const crowded = [...perStep.values()].filter((count) => count > 2)
  if (crowded.length > 2) {
    refusals.push(finding('motion', 'no more than two semantic items may share a step; ' + crowded.length + ' steps are crowded.'))
  }
  const controls = elements.filter((element) => element.attributes.some((one) => one.name === 'data-motion-controls'))
  const status = elements.filter((element) => element.attributes.some((one) => one.name === 'data-motion-status'))
  const modeChanges = mode === 'reveal' || mode === 'step' || mode === 'loop'
  if (modeChanges && controls.length === 0) {
    refusals.push(finding('motion', mode + ' mode needs one in-root data-motion-controls group with the five playback actions.'))
  } else if (controls.length > 1) {
    refusals.push(finding('motion', 'exactly one data-motion-controls group is allowed; found ' + controls.length + '.'))
  }
  if (controls.length > 0) {
    const actions = new Set()
    for (const element of elements) {
      const action = element.attributes.find((one) => one.name === 'data-motion-action')
      if (action) actions.add(action.value)
    }
    const missing = MOTION_ACTIONS.filter((action) => !actions.has(action))
    if (missing.length > 0) {
      refusals.push(finding('motion', 'the control group is missing actions: ' + missing.join(', ') + '.'))
    }
  }
  if (modeChanges && status.length === 0) {
    refusals.push(finding('motion', 'a controlled animation needs one data-motion-status live region with role="status" aria-live="polite" aria-atomic="true".'))
  }
  for (const one of status) {
    if (attribute(one, 'role') !== 'status' || attribute(one, 'aria-live') !== 'polite' || attribute(one, 'aria-atomic') !== 'true') {
      refusals.push(finding('motion', 'data-motion-status needs role="status", aria-live="polite" and aria-atomic="true".'))
    }
  }
  const css = cssTexts.join('\n')
  if (!/prefers-reduced-motion/i.test(css)) {
    warnings.push(finding('motion', 'no prefers-reduced-motion fallback: a reader who asks for less motion still gets it.'))
  }
  if (modeChanges && !/@media\s+print/i.test(css)) {
    warnings.push(finding('motion', 'no @media print fallback: a printed animation can come out as its first frame only.'))
  }
  if (modeChanges && !/<noscript[\s>]/i.test(String(html ?? ''))) {
    warnings.push(finding('motion', 'no <noscript>: with script off the reader sees the frame the markup starts in, which deserves a sentence.'))
  }
}

/** The craft rules this plugin adds on top of the upstream contract. */
function checkCraft(elements, html, warnings) {
  const nodes = elements.filter((element) => {
    if (['style', 'script', 'defs', 'title', 'desc', 'metadata', 'style'].includes(element.name)) return false
    if (element.name === 'svg' || element.name === 'g') return false
    return element.depth <= 2
  })
  if (nodes.length > MAX_NODES) {
    warnings.push(finding('density', nodes.length + ' top-level marks where the kit\u2019s own budget is ' + MAX_NODES + ': above nine, this is probably two diagrams.'))
  }
  const text = String(html ?? '')
  // The token names travel between the kit's generations: the newer pages declare
  // `--color-paper`, the older ones a numbered form. Matching the prefix accepts
  // both; matching NEITHER is the finding worth making, and it is the one that
  // predicts whether the panel can adapt the document to the dark theme.
  if (!/--color-(paper|ink|muted|accent)/.test(text)) {
    warnings.push(
      finding(
        'theme',
        'this document declares none of the kit\u2019s colour tokens (--color-paper/--color-ink/--color-muted/--color-accent), so the panel cannot adapt it to the dark theme.',
      ),
    )
  }
  if (!/var\(--font-(sans|serif|mono)\)/.test(text)) {
    warnings.push(finding('type', 'no --font-sans/--font-serif/--font-mono in use: the type will not follow the reader\u2019s fonts.'))
  }
}

/**
 * Check one `html` diagram.
 *
 * @param source - the document.
 * @param options - `{ motionHash, sha256 }`. `motionHash` is the canonical
 *   controller's body hash recorded by the kit build; without it a script that
 *   claims to be the controller is refused rather than trusted.
 * @returns `{ ok, status, refusals, warnings, counts }`. `status` is `'ok'` when
 *   there is no refusal and `'error'` when there is, which is the same
 *   vocabulary Mermaid and TikZ use.
 */
export function checkHtml(source, { motionHash = null, sha256 } = {}) {
  const hash = typeof sha256 === 'function' ? sha256 : () => ''
  const text = String(source ?? '')
  const refusals = []
  const warnings = []

  if (text.trim().length === 0) {
    return {
      ok: false,
      status: 'error',
      refusals: [finding('source', 'the document is empty.')],
      warnings: [],
      counts: { elements: 0, scripts: 0, svgs: 0 },
    }
  }
  if (!/<svg[\s>]/i.test(text)) {
    refusals.push(finding('structure', 'there is no <svg> in this document, so there is nothing to draw.'))
  }

  const tokenized = tokenize(text)
  checkExecutable(tokenized.elements, refusals)
  checkReferences(tokenized.elements, refusals)
  checkCss(tokenized.cssTexts, refusals)
  const scriptVerdict = checkScripts(tokenized.scripts, motionHash, hash)
  refusals.push(...scriptVerdict.refusals)
  checkSvgs(tokenized.elements, warnings, refusals)
  if (scriptVerdict.motion) {
    checkMotion(tokenized.elements, tokenized.cssTexts, text, refusals, warnings)
  } else if (tokenized.elements.some((element) => element.attributes.some((one) => one.name.startsWith('data-motion-')))) {
    warnings.push(finding('motion', 'this document carries motion markup but not the kit\u2019s canonical controller, so the steps will not play.'))
  }
  checkStyleRules(tokenized.elements, refusals)
  checkCraft(tokenized.elements, text, warnings)

  // Deduplicate: one document with the same mistake in five places says it once.
  const unique = (list) => {
    const seen = new Set()
    const kept = []
    for (const entry of list) {
      if (seen.has(entry.text)) continue
      seen.add(entry.text)
      kept.push(entry)
    }
    return kept.slice(0, MAX_FINDINGS)
  }

  const finalRefusals = unique(refusals)
  const finalWarnings = unique(warnings)
  return {
    ok: finalRefusals.length === 0,
    status: finalRefusals.length === 0 ? 'ok' : 'error',
    refusals: finalRefusals,
    warnings: finalWarnings,
    counts: {
      elements: tokenized.elements.length,
      scripts: tokenized.scripts.length,
      svgs: tokenized.elements.filter((element) => element.name === 'svg').length,
    },
  }
}

/**
 * The first `<svg>` of a document, lifted into a standalone SVG file.
 *
 * The export path needs this, and it is a transform rather than a re-render: the
 * picture's own `<style>` comes with it, so what is exported is what was drawn.
 *
 * @param source - the document.
 * @returns `{ svg, width, height }`, or null when the document has no SVG.
 */
export function extractSvg(source) {
  const text = String(source ?? '')
  const start = text.search(/<svg[\s>]/i)
  if (start === -1) return null
  // Walk forward to the matching close, counting nested <svg> elements.
  let depth = 0
  let index = start
  while (index < text.length) {
    const next = text.indexOf('<svg', index)
    const closing = text.indexOf('</svg', index)
    if (closing === -1) break
    if (next !== -1 && next < closing) {
      depth += 1
      index = next + 4
      continue
    }
    depth -= 1
    index = closing + 5
    if (depth === 0) {
      const end = text.indexOf('>', closing)
      if (end === -1) break
      const svg = text.slice(start, end + 1)
      const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
      const parts = viewBox ? viewBox[1].trim().split(/[\s,]+/).map(Number) : []
      return {
        svg,
        width: Number.isFinite(parts[2]) ? parts[2] : null,
        height: Number.isFinite(parts[3]) ? parts[3] : null,
      }
    }
  }
  return null
}
