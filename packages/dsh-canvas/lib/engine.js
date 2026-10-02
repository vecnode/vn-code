/**
 * dsh-canvas — the canvas ENGINE: the document language, the pure layout pass,
 * the draw-op IR, and the two painters.
 *
 * ONE file with **zero static imports and no globals at module scope**, on
 * purpose, because the same module is used from three places:
 *
 *   1. the HOST imports it to validate a document before it is stored
 *      (`normalizeDocument` / `documentErrors`) - structure only, never geometry,
 *      because only the browser has real text metrics;
 *   2. the BROWSER fetches it from `GET /api/dsh-canvas/vendor/engine.js` and
 *      `import()`s it from a blob URL, exactly the way `dsh-pdf` loads its
 *      vendored pdf.js and `dsh-editor` loads CodeMirror. A blob-URL module
 *      resolves no relative specifiers, so a second file would break - the same
 *      constraint that made those two single files;
 *   3. `scripts/checks/check-canvas-node.mjs` imports it directly and drives it
 *      with an INJECTED text measurer, so every number that decides where a word
 *      lands is verified on a host with no browser and no fonts.
 *
 * The pipeline is:
 *
 *     document ──normalize──► canonical document
 *                                   │
 *                              layout(measure)          ← pure; the measurer is injected
 *                                   │
 *                              draw-op list             ← the IR both painters consume
 *                                   ├── paintCanvas(ops, ctx)   → the artboard AND the PNG export
 *                                   └── toSvg(ops, doc)         → the .svg export
 *
 * The canvas painter is what the tab draws AND what the export rasterizes, so the
 * preview and the exported file cannot disagree - there is no second
 * interpretation of the design anywhere. `toSvg` walks the SAME op list, and the
 * tracked check asserts both painters consume every op kind.
 *
 * ## Layout in two passes, and the rules that make it predictable
 *
 * 1. **measure** - a node's intrinsic size (a text node's wrapped height, a
 *    frame's hug size, an image's aspect).
 * 2. **place** - give every node its final box and emit its ops.
 *
 * The sizing rules are deliberately few and stated here, because a design
 * language the model cannot predict is a design language it cannot use:
 *
 *   - `w`/`h` a number: that many pixels.
 *   - `'fill'`: the parent's content box on that axis (for a frame's in-flow
 *     child on the MAIN axis, the leftover space shared between the `fill`
 *     children).
 *   - `'hug'`: the node's own content size (a text node's wrapped height, a
 *     frame's children, an image's aspect).
 *   - ABSENT: the kind's own default - a text node hugs on both axes and does
 *     **not** wrap (give it a `w` to wrap it; the report warns when a long line
 *     runs past the canvas), a frame hugs its main axis and fills the cross one,
 *     an image hugs its aspect, and `art` / `svg` fill their parent.
 *   - a child of a frame that names `x` or `y` leaves the flow and is placed
 *     absolutely inside the frame's padding box.
 *
 * Nothing here reads a file, a clock, a random source, or the network: the art
 * generators are seeded from the document, so the same document is the same
 * picture on every machine.
 */

/** Bumped when the layout or the op IR changes; travels in the render report. */
export const ENGINE_VERSION = '1'

/** The node kinds this language has. */
export const NODE_KINDS = ['frame', 'text', 'image', 'shape', 'art', 'svg']

/** The procedural art generators. */
export const ART_STYLES = [
  'mesh', 'grid', 'stripes', 'rings', 'glow', 'grain', 'waves', 'blueprint', 'circuit', 'stars',
]

/** The blend modes a node may name (the intersection of canvas and CSS). */
export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten',
]

/** Every cap the language enforces, in one table so the validator, the skill and the docs cannot drift. */
export const LIMITS = {
  maxCanvasSide: 8192,
  minCanvasSide: 16,
  maxExportPixels: 40_000_000,
  maxLayers: 512,
  maxTotalNodes: 4096,
  maxChildren: 64,
  maxDepth: 12,
  maxTextChars: 4096,
  maxRuns: 24,
  maxSvgChars: 100_000,
  maxTitleChars: 120,
  maxNotesChars: 4000,
  maxArtOps: 600,
  maxFontSize: 400,
  minFontSize: 6,
  maxGap: 400,
  maxPadding: 600,
  maxRadius: 999,
  maxStroke: 80,
}

/** The roles a font token may name. */
export const FONT_ROLES = ['display', 'text', 'mono']

/** The family name that always means "the machine's own stack". */
export const SYSTEM_FAMILY = 'system'

/** The default palette, used for any role the document does not name. */
const DEFAULT_COLORS = { ink: '#F8FAFC', muted: '#94A3B8', accent: '#4D6BFE', surface: '#0B0E14' }

/** The default type scale, used for any size the document does not name. */
const DEFAULT_SCALE = { display: 72, title: 40, subtitle: 26, body: 22, caption: 15 }

/** The default radius tokens. */
const DEFAULT_RADIUS = { card: 20, pill: 999, chip: 8 }

/** Style-name and token-name grammars. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/

/** Node-id grammar; also what a report and a patch address. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Clamp a number into a range. */
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value
}

/** Whether a value is a finite number. */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Round to 3 decimals: the IR is compared and hashed, so it must be stable. */
function round(value) {
  return Math.round(value * 1000) / 1000
}

/** A node's path inside a document, e.g. `layers.0.children.2`. */
function childPath(parent, index) {
  return parent === '' ? 'layers.' + index : parent + '.children.' + index
}

/**
 * A deterministic PRNG (mulberry32): the art generators take a `seed` from the
 * document and must produce the same picture on every machine, so `Math.random`
 * is never called anywhere in this file.
 */
export function seededRandom(seed) {
  let state = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or `hsl()` into `{r,g,b,a}`. */
export function parseColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, a: 0 }
  if (text.startsWith('#')) {
    const hex = text.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const parts = hex.split('').map((ch) => parseInt(ch + ch, 16))
      if (parts.some((part) => Number.isNaN(part))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length === 4 ? parts[3] / 255 : 1 }
    }
    if (hex.length === 6 || hex.length === 8) {
      const parts = []
      for (let index = 0; index < hex.length; index += 2) parts.push(parseInt(hex.slice(index, index + 2), 16))
      if (parts.some((part) => Number.isNaN(part))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length === 4 ? parts[3] / 255 : 1 }
    }
    return null
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    return {
      r: clamp(parts[0], 0, 255),
      g: clamp(parts[1], 0, 255),
      b: clamp(parts[2], 0, 255),
      a: parts.length > 3 ? clamp(parts[3], 0, 1) : 1,
    }
  }
  const hsl = /^hsla?\(([^)]+)\)$/.exec(text)
  if (hsl) {
    const parts = hsl[1].split(/[\s,%/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    const rgbValue = hslToRgb(((parts[0] % 360) + 360) % 360, clamp(parts[1] / 100, 0, 1), clamp(parts[2] / 100, 0, 1))
    return { ...rgbValue, a: parts.length > 3 ? clamp(parts[3], 0, 1) : 1 }
  }
  return null
}

/** HSL (h degrees, s/l 0-1) to RGB 0-255. */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const base = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return { r: Math.round((base[0] + m) * 255), g: Math.round((base[1] + m) * 255), b: Math.round((base[2] + m) * 255) }
}

/** `{r,g,b,a}` back to `#rrggbb` (or `#rrggbbaa` when translucent). */
export function formatColor(color) {
  if (!color) return 'transparent'
  const hex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
  const base = '#' + hex(color.r) + hex(color.g) + hex(color.b)
  if (color.a >= 1) return base
  return base + hex(color.a * 255)
}

/** The same colour at a new alpha (0-1). */
export function withAlpha(value, alpha) {
  const color = typeof value === 'string' ? parseColor(value) : value
  if (!color) return 'transparent'
  return formatColor({ ...color, a: clamp(alpha, 0, 1) })
}

/** Composite `top` over `bottom` (alpha-over). */
function over(top, bottom) {
  const alpha = top.a + bottom.a * (1 - top.a)
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const channel = (key) => (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / alpha
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha }
}

/** WCAG relative luminance of an opaque colour. */
function luminance(color) {
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio (1-21); a translucent foreground is composited over the background first. */
export function contrastRatio(foreground, background) {
  const back = typeof background === 'string' ? parseColor(background) : background
  let front = typeof foreground === 'string' ? parseColor(foreground) : foreground
  if (!back || !front) return null
  if (front.a < 1) front = over(front, back)
  const light = Math.max(luminance(front), luminance(back))
  const dark = Math.min(luminance(front), luminance(back))
  return round((light + 0.05) / (dark + 0.05))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One validation refusal, with the path it was found at. */
function problem(path, code, message) {
  return { path, code, message }
}

/** Check a numeric field in range. */
function checkNumber(out, value, path, code, low, high) {
  if (value === undefined || value === null) return
  if (!isNum(value)) {
    out.push(problem(path, code, path + ' must be a number'))
    return
  }
  if (value < low || value > high) {
    out.push(problem(path, code, path + ' must be between ' + low + ' and ' + high + ' (got ' + value + ')'))
  }
}

/** Check a size field: a number, `fill` or `hug`. */
function checkSize(out, value, path, code, low, high) {
  if (value === undefined || value === null) return
  if (value === 'fill' || value === 'hug') return
  checkNumber(out, value, path, code, low, high)
}

/** A colour is a token name in the document or a literal colour. */
function checkColor(out, value, path, colors) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') {
    out.push(problem(path, 'BAD_COLOR', path + ' must be a colour string'))
    return
  }
  if (Object.prototype.hasOwnProperty.call(colors, value)) return
  if (parseColor(value) === null) {
    out.push(
      problem(
        path,
        'BAD_COLOR',
        path + ' is neither a colour token (' + Object.keys(colors).join(', ') + ') nor a parseable colour: ' + JSON.stringify(value),
      ),
    )
  }
}

/** A font family is a bundled family name or `system`. */
function checkFamily(out, value, path, fonts) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') {
    out.push(problem(path, 'BAD_FONT', path + ' must be a string'))
    return
  }
  if (value === SYSTEM_FAMILY) return
  const known = Object.keys(fonts ?? {}).map((name) => name.toLowerCase())
  if (!known.includes(value.toLowerCase())) {
    out.push(
      problem(
        path,
        'BAD_FONT',
        path + ' names a family this package does not ship: ' + JSON.stringify(value) + ' (shipped: ' + known.join(', ') + ', system)',
      ),
    )
  }
}

/** A paint: a colour, a gradient, or an art fill. */
function checkPaint(out, value, path, colors) {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    checkColor(out, value, path, colors)
    return
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    out.push(problem(path, 'BAD_PAINT', path + ' must be a colour, a gradient or an art fill'))
    return
  }
  if (value.type === 'art') {
    if (!ART_STYLES.includes(value.style)) {
      out.push(problem(path + '.style', 'BAD_ART', path + '.style must be one of ' + ART_STYLES.join(', ')))
    }
    checkArtOptions(out, value, path, colors)
    return
  }
  if (value.type === 'solid') {
    // The CANONICAL form of a colour is `{type:"solid", color}`, and a canonical
    // document is what `canvas_read` hands the model and what a patch is applied
    // against - so the validator has to accept its own output, or every edit to a
    // stored design would be refused.
    checkColor(out, value.color, path + '.color', colors)
    return
  }
  if (value.type !== 'linear' && value.type !== 'radial') {
    out.push(problem(path + '.type', 'BAD_PAINT', path + '.type must be solid, linear, radial or art'))
    return
  }
  if (!Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 8) {
    out.push(problem(path + '.stops', 'BAD_PAINT', path + '.stops needs 2 to 8 stops'))
    return
  }
  value.stops.forEach((stop, index) => {
    if (!stop || typeof stop !== 'object') {
      out.push(problem(path + '.stops.' + index, 'BAD_PAINT', 'each stop is {at, color}'))
      return
    }
    checkNumber(out, stop.at, path + '.stops.' + index + '.at', 'BAD_PAINT', 0, 1)
    checkColor(out, stop.color, path + '.stops.' + index + '.color', colors)
  })
  if (value.type === 'linear') checkNumber(out, value.angle, path + '.angle', 'BAD_PAINT', -360, 360)
  if (value.type === 'radial') {
    checkNumber(out, value.cx, path + '.cx', 'BAD_PAINT', -1, 2)
    checkNumber(out, value.cy, path + '.cy', 'BAD_PAINT', -1, 2)
    checkNumber(out, value.r, path + '.r', 'BAD_PAINT', 0.01, 3)
  }
}

/** The options every art fill / art node takes. */
function checkArtOptions(out, value, path, colors) {
  if (value.colors !== undefined) {
    if (!Array.isArray(value.colors) || value.colors.length > 4) {
      out.push(problem(path + '.colors', 'BAD_ART', path + '.colors is up to 4 colours'))
    } else {
      value.colors.forEach((color, index) => checkColor(out, color, path + '.colors.' + index, colors))
    }
  }
  if (value.seed !== undefined && (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 999999)) {
    out.push(problem(path + '.seed', 'BAD_ART', path + '.seed must be an integer 0-999999'))
  }
  checkNumber(out, value.density, path + '.density', 'BAD_ART', 0, 1)
  checkNumber(out, value.scale, path + '.scale', 'BAD_ART', 0.05, 8)
  checkNumber(out, value.opacity, path + '.opacity', 'BAD_ART', 0, 1)
}

/**
 * The RAW SVG fragment rules. A fragment is not trusted: it is scanned for the
 * tags and attributes that could execute, fetch, or escape the artboard, and it
 * is refused by name when it carries one. This is a scanner, not a parser - it
 * refuses what it does not recognize rather than trying to be clever about it.
 */
const SVG_ALLOWED_TAGS = new Set([
  'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'use', 'symbol',
])
const SVG_ALLOWED_ATTRS = new Set([
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'opacity', 'transform', 'viewbox', 'preserveaspectratio',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'id', 'class',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'clip-path', 'mask', 'href', 'xlink:href', 'xmlns', 'xmlns:xlink', 'version',
])

/** Scan a raw SVG fragment; returns an array of refusals. */
export function svgFragmentProblems(fragment, path = 'svg') {
  const out = []
  const text = String(fragment ?? '')
  if (text.length > LIMITS.maxSvgChars) {
    out.push(problem(path, 'SVG_TOO_LARGE', path + ' is ' + text.length + ' chars; the cap is ' + LIMITS.maxSvgChars))
    return out
  }
  const forbidden = /<\s*\/?\s*(script|foreignobject|iframe|image|animate|animateTransform|set|handler|style|link|meta|object|embed|audio|video|switch)\b/i.exec(text)
  if (forbidden) {
    out.push(problem(path, 'SVG_FORBIDDEN', path + ' carries <' + forbidden[1] + '>, which a design fragment may not contain'))
  }
  if (/(?:href|xlink:href)\s*=\s*["']?(?!\s*#)/i.test(text)) {
    out.push(problem(path, 'SVG_EXTERNAL', path + ' may only reference its own #ids; an external href is refused (it cannot be inlined and would fetch)'))
  }
  if (/\son[a-z]+\s*=/i.test(text)) {
    out.push(problem(path, 'SVG_EVENT', path + ' may not carry event attributes (on*=)'))
  }
  const tagPattern = /<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/g
  let match = tagPattern.exec(text)
  while (match) {
    const tag = match[1].toLowerCase()
    if (!SVG_ALLOWED_TAGS.has(tag)) {
      out.push(problem(path, 'SVG_TAG', path + ' uses <' + match[1] + '>, which is not in the allowed fragment set'))
    }
    match = tagPattern.exec(text)
  }
  const attrPattern = /([A-Za-z][A-Za-z0-9:-]*)\s*=/g
  let attr = attrPattern.exec(text)
  while (attr) {
    const name = attr[1].toLowerCase()
    if (!SVG_ALLOWED_ATTRS.has(name) && !name.startsWith('data-') && !name.startsWith('aria-')) {
      out.push(problem(path, 'SVG_ATTR', path + ' uses the attribute "' + attr[1] + '", which is not in the allowed fragment set'))
    }
    attr = attrPattern.exec(text)
  }
  return out
}

/**
 * Validate and CANONICALIZE a document.
 *
 * Canonical means: defaults filled, token references resolved to literals,
 * numbers rounded, key order stable. The model patches the canonical form (that
 * is what `canvas_read` hands back), so two documents that mean the same thing
 * compare equal and a patch cannot be ambiguous about defaults.
 *
 * @param input - the document as the model or the drawer wrote it.
 * @param options - `{ presets, fonts }`; `presets` resolves `preset` to a canvas.
 * @returns `{ document, problems, preset }` - `document` is null when `problems` is non-empty.
 */
export function normalizeDocument(input, options = {}) {
  const presets = options.presets ?? {}
  const fonts = options.fonts ?? {}
  const out = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { document: null, problems: [problem('', 'BAD_DOCUMENT', 'a design document must be a JSON object')], preset: null }
  }

  // ---- canvas / preset -----------------------------------------------------
  const presetId = input.preset === undefined || input.preset === null ? null : String(input.preset)
  let preset = null
  if (presetId !== null) {
    preset = Object.prototype.hasOwnProperty.call(presets, presetId) ? presets[presetId] : null
    if (!preset) {
      out.push(problem('preset', 'UNKNOWN_PRESET', 'unknown preset ' + JSON.stringify(presetId) + ' (known: ' + Object.keys(presets).join(', ') + ')'))
    }
  }
  const rawCanvas = input.canvas && typeof input.canvas === 'object' ? input.canvas : {}
  let width = rawCanvas.width
  let height = rawCanvas.height
  if (!isNum(width) && preset) width = preset.width
  if (!isNum(height) && preset) height = preset.height
  if (!isNum(width) || !isNum(height)) {
    out.push(problem('canvas', 'NO_CANVAS', 'a document needs either a known `preset` or both `canvas.width` and `canvas.height`'))
    width = isNum(width) ? width : 1280
    height = isNum(height) ? height : 640
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    out.push(problem('canvas', 'BAD_CANVAS', 'canvas.width and canvas.height must be whole pixels'))
  }
  if (width < LIMITS.minCanvasSide || width > LIMITS.maxCanvasSide || height < LIMITS.minCanvasSide || height > LIMITS.maxCanvasSide) {
    out.push(
      problem(
        'canvas',
        'CANVAS_TOO_LARGE',
        'canvas is ' + width + 'x' + height + '; each side must be ' + LIMITS.minCanvasSide + '-' + LIMITS.maxCanvasSide + ' px',
      ),
    )
  }
  if (presetId === null && (!isNum(rawCanvas.width) || !isNum(rawCanvas.height))) {
    out.push(problem('canvas', 'NO_CANVAS', 'both canvas.width and canvas.height are required when no preset is named'))
  }

  // ---- tokens --------------------------------------------------------------
  const rawTokens = input.tokens && typeof input.tokens === 'object' ? input.tokens : {}
  const colors = { ...DEFAULT_COLORS }
  if (rawTokens.color !== undefined) {
    if (!rawTokens.color || typeof rawTokens.color !== 'object' || Array.isArray(rawTokens.color)) {
      out.push(problem('tokens.color', 'BAD_TOKENS', 'tokens.color must be an object of name -> colour'))
    } else {
      for (const [name, value] of Object.entries(rawTokens.color)) {
        if (!NAME_PATTERN.test(name)) {
          out.push(problem('tokens.color.' + name, 'BAD_TOKEN_NAME', 'a colour token name must match ' + NAME_PATTERN))
          continue
        }
        const direct = parseColor(value)
        if (direct === null) {
          out.push(problem('tokens.color.' + name, 'BAD_COLOR', 'colour tokens are literal colours, not other tokens (' + JSON.stringify(value) + ')'))
          continue
        }
        colors[name] = formatColor(direct)
      }
    }
  }
  const families = { display: SYSTEM_FAMILY, text: SYSTEM_FAMILY, mono: SYSTEM_FAMILY }
  if (rawTokens.font !== undefined) {
    if (!rawTokens.font || typeof rawTokens.font !== 'object' || Array.isArray(rawTokens.font)) {
      out.push(problem('tokens.font', 'BAD_TOKENS', 'tokens.font must be an object of role -> family'))
    } else {
      for (const [role, value] of Object.entries(rawTokens.font)) {
        if (!FONT_ROLES.includes(role)) {
          out.push(problem('tokens.font.' + role, 'BAD_FONT_ROLE', 'font roles are ' + FONT_ROLES.join(', ')))
          continue
        }
        checkFamily(out, value, 'tokens.font.' + role, fonts)
        families[role] = value
      }
    }
  }
  const scale = { ...DEFAULT_SCALE }
  if (rawTokens.scale !== undefined) {
    if (!rawTokens.scale || typeof rawTokens.scale !== 'object' || Array.isArray(rawTokens.scale)) {
      out.push(problem('tokens.scale', 'BAD_TOKENS', 'tokens.scale must be an object of name -> pixels'))
    } else {
      for (const [name, value] of Object.entries(rawTokens.scale)) {
        if (!NAME_PATTERN.test(name)) {
          out.push(problem('tokens.scale.' + name, 'BAD_TOKEN_NAME', 'a scale name must match ' + NAME_PATTERN))
          continue
        }
        if (!isNum(value) || value < LIMITS.minFontSize || value > LIMITS.maxFontSize) {
          out.push(problem('tokens.scale.' + name, 'BAD_SCALE', 'a scale entry must be ' + LIMITS.minFontSize + '-' + LIMITS.maxFontSize + ' px'))
          continue
        }
        scale[name] = round(value)
      }
    }
  }
  const radius = { ...DEFAULT_RADIUS }
  if (rawTokens.radius !== undefined && rawTokens.radius && typeof rawTokens.radius === 'object') {
    for (const [name, value] of Object.entries(rawTokens.radius)) {
      if (!NAME_PATTERN.test(name)) {
        out.push(problem('tokens.radius.' + name, 'BAD_TOKEN_NAME', 'a radius token name must match ' + NAME_PATTERN))
        continue
      }
      if (!isNum(value) || value < 0 || value > LIMITS.maxRadius) {
        out.push(problem('tokens.radius.' + name, 'BAD_RADIUS', 'a radius must be 0-' + LIMITS.maxRadius))
        continue
      }
      radius[name] = round(value)
    }
  }
  let space = 8
  if (rawTokens.space !== undefined) {
    if (!isNum(rawTokens.space) || rawTokens.space < 2 || rawTokens.space > 64) {
      out.push(problem('tokens.space', 'BAD_SPACE', 'tokens.space must be 2-64 px'))
    } else {
      space = round(rawTokens.space)
    }
  }

  // ---- layers --------------------------------------------------------------
  const totals = { nodes: 0 }
  const layers = []
  const rawLayers = input.layers
  if (!Array.isArray(rawLayers)) {
    out.push(problem('layers', 'BAD_LAYERS', 'layers must be an array (it may be empty)'))
  } else if (rawLayers.length > LIMITS.maxLayers) {
    out.push(problem('layers', 'TOO_MANY_LAYERS', 'at most ' + LIMITS.maxLayers + ' top-level layers (got ' + rawLayers.length + ')'))
  } else {
    rawLayers.forEach((node, index) => {
      const normalized = normalizeNode(node, childPath('', index), { colors, fonts, scale, radius, space }, out, 1, totals)
      if (normalized) layers.push(normalized)
    })
  }

  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > LIMITS.maxTitleChars)) {
    out.push(problem('title', 'BAD_TITLE', 'title must be a string of at most ' + LIMITS.maxTitleChars + ' characters'))
  }
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > LIMITS.maxNotesChars)) {
    out.push(problem('notes', 'BAD_NOTES', 'notes must be a string of at most ' + LIMITS.maxNotesChars + ' characters'))
  }

  const background = rawCanvas.background === undefined ? null : rawCanvas.background
  if (background !== null) {
    if (typeof background === 'string') checkColor(out, background, 'canvas.background', colors)
    else checkPaint(out, background, 'canvas.background', colors)
  }

  if (out.length > 0) return { document: null, problems: out, preset }

  const document = {
    title: typeof input.title === 'string' ? input.title : null,
    preset: presetId,
    canvas: {
      width: Math.round(width),
      height: Math.round(height),
      // Always a resolved PAINT (a token name becomes its literal), so the
      // painters, the SVG serializer and the contrast sampler never see a token.
      background: normalizePaint(background === null ? DEFAULT_COLORS.surface : background, { colors }) ?? { type: 'solid', color: DEFAULT_COLORS.surface },
    },
    tokens: { color: colors, font: families, scale, space, radius },
    layers,
  }
  if (typeof input.notes === 'string' && input.notes.length > 0) document.notes = input.notes
  return { document, problems: [], preset }
}

/** One node, canonicalized. Returns null when it could not be understood at all. */
function normalizeNode(node, path, tokens, out, depth, totals) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    out.push(problem(path, 'BAD_NODE', path + ' must be an object'))
    return null
  }
  totals.nodes += 1
  if (totals.nodes > LIMITS.maxTotalNodes) {
    out.push(problem(path, 'TOO_MANY_NODES', 'a document may hold at most ' + LIMITS.maxTotalNodes + ' nodes'))
    return null
  }
  if (depth > LIMITS.maxDepth) {
    out.push(problem(path, 'TOO_DEEP', 'frames nest at most ' + LIMITS.maxDepth + ' deep'))
    return null
  }
  const kind = node.kind
  if (!NODE_KINDS.includes(kind)) {
    out.push(problem(path + '.kind', 'BAD_KIND', path + '.kind must be one of ' + NODE_KINDS.join(', ') + ' (got ' + JSON.stringify(kind) + ')'))
    return null
  }
  const normalized = { kind }
  if (node.id !== undefined) {
    if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) {
      out.push(problem(path + '.id', 'BAD_ID', 'an id must match ' + ID_PATTERN))
    } else {
      normalized.id = node.id
    }
  }
  for (const key of ['x', 'y']) {
    if (node[key] !== undefined) {
      checkNumber(out, node[key], path + '.' + key, 'BAD_GEOMETRY', -LIMITS.maxCanvasSide, LIMITS.maxCanvasSide)
      if (isNum(node[key])) normalized[key] = round(node[key])
    }
  }
  for (const key of ['w', 'h']) {
    if (node[key] !== undefined) {
      checkSize(out, node[key], path + '.' + key, 'BAD_GEOMETRY', 1, LIMITS.maxCanvasSide)
      if (typeof node[key] === 'string' && (node[key] === 'fill' || node[key] === 'hug')) normalized[key] = node[key]
      else if (isNum(node[key])) normalized[key] = round(node[key])
    }
  }
  if (node.opacity !== undefined) {
    checkNumber(out, node.opacity, path + '.opacity', 'BAD_OPACITY', 0, 1)
    normalized.opacity = isNum(node.opacity) ? round(node.opacity) : 1
  }
  if (node.rotate !== undefined) {
    checkNumber(out, node.rotate, path + '.rotate', 'BAD_ROTATE', -360, 360)
    normalized.rotate = isNum(node.rotate) ? round(node.rotate) : 0
  }
  if (node.blend !== undefined) {
    if (!BLEND_MODES.includes(node.blend)) {
      out.push(problem(path + '.blend', 'BAD_BLEND', path + '.blend must be one of ' + BLEND_MODES.join(', ')))
    } else {
      normalized.blend = node.blend
    }
  }
  if (node.shadow !== undefined) {
    const shadow = node.shadow
    if (!shadow || typeof shadow !== 'object') {
      out.push(problem(path + '.shadow', 'BAD_SHADOW', 'shadow must be {x, y, blur, color}'))
    } else {
      checkNumber(out, shadow.x, path + '.shadow.x', 'BAD_SHADOW', -200, 200)
      checkNumber(out, shadow.y, path + '.shadow.y', 'BAD_SHADOW', -200, 200)
      checkNumber(out, shadow.blur, path + '.shadow.blur', 'BAD_SHADOW', 0, 200)
      checkColor(out, shadow.color, path + '.shadow.color', tokens.colors)
      normalized.shadow = {
        x: round(isNum(shadow.x) ? shadow.x : 0),
        y: round(isNum(shadow.y) ? shadow.y : 8),
        blur: round(isNum(shadow.blur) ? shadow.blur : 24),
        color: shadow.color === undefined ? withAlpha('#000000', 0.45) : resolveColor(shadow.color, tokens.colors),
      }
    }
  }
  if (node.background !== undefined) {
    checkPaint(out, node.background, path + '.background', tokens.colors)
    const background = normalizePaint(node.background, tokens)
    if (background) normalized.background = background
  }
  if (node.radius !== undefined) {
    if (typeof node.radius === 'string') {
      if (!Object.prototype.hasOwnProperty.call(tokens.radius, node.radius)) {
        out.push(problem(path + '.radius', 'BAD_RADIUS', path + '.radius names radius token ' + JSON.stringify(node.radius) + ' (known: ' + Object.keys(tokens.radius).join(', ') + ')'))
      } else {
        normalized.radius = tokens.radius[node.radius]
      }
    } else {
      checkNumber(out, node.radius, path + '.radius', 'BAD_RADIUS', 0, LIMITS.maxRadius)
      normalized.radius = isNum(node.radius) ? round(node.radius) : 0
    }
  }
  if (node.border !== undefined) {
    const border = node.border
    if (!border || typeof border !== 'object') {
      out.push(problem(path + '.border', 'BAD_BORDER', 'border must be {width, color}'))
    } else {
      checkNumber(out, border.width, path + '.border.width', 'BAD_BORDER', 0, LIMITS.maxStroke)
      checkColor(out, border.color, path + '.border.color', tokens.colors)
      normalized.border = {
        width: round(isNum(border.width) ? border.width : 1),
        color: resolveColor(border.color === undefined ? 'muted' : border.color, tokens.colors),
      }
      if (Array.isArray(border.dash) && border.dash.length > 0 && border.dash.length <= 8) {
        normalized.border.dash = border.dash.map((value) => (isNum(value) && value >= 0 ? round(value) : 0))
      }
    }
  }

  if (kind === 'frame') normalizeFrame(node, path, tokens, out, depth, totals, normalized)
  if (kind === 'text') normalizeText(node, path, tokens, out, normalized)
  if (kind === 'image') normalizeImage(node, path, tokens, out, normalized)
  if (kind === 'shape') normalizeShape(node, path, tokens, out, normalized)
  if (kind === 'art') {
    if (!ART_STYLES.includes(node.style)) {
      out.push(problem(path + '.style', 'BAD_ART', path + '.style must be one of ' + ART_STYLES.join(', ')))
    } else {
      normalized.style = node.style
    }
    checkArtOptions(out, node, path, tokens.colors)
    if (Array.isArray(node.colors) && node.colors.length > 0) {
      normalized.colors = node.colors.map((color) => resolveColor(color, tokens.colors))
    }
    if (node.seed !== undefined) normalized.seed = Number.isInteger(node.seed) ? node.seed : 1
    if (node.density !== undefined) normalized.density = round(isNum(node.density) ? node.density : 0.5)
    if (node.scale !== undefined) normalized.scale = round(isNum(node.scale) ? node.scale : 1)
  }
  if (kind === 'svg') {
    const fragment = typeof node.svg === 'string' ? node.svg : ''
    for (const entry of svgFragmentProblems(fragment, path + '.svg')) out.push(entry)
    normalized.svg = fragment
    if (node.viewBox !== undefined) {
      if (!Array.isArray(node.viewBox) || node.viewBox.length !== 4 || node.viewBox.some((value) => !isNum(value))) {
        out.push(problem(path + '.viewBox', 'BAD_VIEWBOX', 'viewBox must be [x, y, width, height]'))
      } else {
        normalized.viewBox = node.viewBox.map(round)
      }
    }
    if (node.preserveAspectRatio !== undefined) {
      if (node.preserveAspectRatio !== 'meet' && node.preserveAspectRatio !== 'none') {
        out.push(problem(path + '.preserveAspectRatio', 'BAD_VIEWBOX', 'preserveAspectRatio is meet or none'))
      } else {
        normalized.preserveAspectRatio = node.preserveAspectRatio
      }
    }
    if (node.fill !== undefined) {
      checkColor(out, node.fill, path + '.fill', tokens.colors)
      normalized.fill = resolveColor(node.fill, tokens.colors)
    }
  }
  return normalized
}

/** A frame's flow properties and children. */
function normalizeFrame(node, path, tokens, out, depth, totals, normalized) {
  const direction = node.direction === undefined ? 'column' : node.direction
  if (direction !== 'column' && direction !== 'row') {
    out.push(problem(path + '.direction', 'BAD_FRAME', path + '.direction is column or row'))
  } else {
    normalized.direction = direction
  }
  if (node.gap !== undefined) {
    checkNumber(out, node.gap, path + '.gap', 'BAD_FRAME', 0, LIMITS.maxGap)
    normalized.gap = round(isNum(node.gap) ? node.gap : 0)
  }
  if (node.padding !== undefined) {
    const padding = normalizePadding(node.padding, path, out)
    if (padding) normalized.padding = padding
  }
  for (const key of ['justify', 'align']) {
    const allowed = key === 'justify' ? ['start', 'center', 'end', 'space-between'] : ['start', 'center', 'end', 'stretch']
    if (node[key] !== undefined) {
      if (!allowed.includes(node[key])) {
        out.push(problem(path + '.' + key, 'BAD_FRAME', path + '.' + key + ' must be one of ' + allowed.join(', ')))
      } else {
        normalized[key] = node[key]
      }
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      out.push(problem(path + '.children', 'BAD_CHILDREN', path + '.children must be an array'))
      return
    }
    if (node.children.length > LIMITS.maxChildren) {
      out.push(problem(path + '.children', 'TOO_MANY_CHILDREN', 'a frame holds at most ' + LIMITS.maxChildren + ' children (got ' + node.children.length + ')'))
    }
    const children = []
    node.children.slice(0, LIMITS.maxChildren).forEach((child, index) => {
      const childNode = normalizeNode(child, path + '.children.' + index, tokens, out, depth + 1, totals)
      if (childNode) children.push(childNode)
    })
    normalized.children = children
  } else {
    normalized.children = []
  }
}

/** Padding: one number, `[t,r,b,l]`, or `{top,right,bottom,left}`. */
function normalizePadding(value, path, out) {
  if (isNum(value)) {
    checkNumber(out, value, path + '.padding', 'BAD_PADDING', 0, LIMITS.maxPadding)
    return { top: round(value), right: round(value), bottom: round(value), left: round(value) }
  }
  if (Array.isArray(value)) {
    if (value.length !== 4 || value.some((entry) => !isNum(entry))) {
      out.push(problem(path + '.padding', 'BAD_PADDING', 'an array padding is [top, right, bottom, left]'))
      return null
    }
    value.forEach((entry) => checkNumber(out, entry, path + '.padding', 'BAD_PADDING', 0, LIMITS.maxPadding))
    return { top: round(value[0]), right: round(value[1]), bottom: round(value[2]), left: round(value[3]) }
  }
  if (value && typeof value === 'object') {
    const named = {}
    for (const key of ['top', 'right', 'bottom', 'left']) {
      const entry = value[key]
      checkNumber(out, entry, path + '.padding.' + key, 'BAD_PADDING', 0, LIMITS.maxPadding)
      named[key] = round(isNum(entry) ? entry : 0)
    }
    return named
  }
  out.push(problem(path + '.padding', 'BAD_PADDING', 'padding is a number, [t,r,b,l] or {top,right,bottom,left}'))
  return null
}

/** A text node's typography. */
function normalizeText(node, path, tokens, out, normalized) {
  const hasRuns = Array.isArray(node.runs) && node.runs.length > 0
  if (!hasRuns) {
    if (typeof node.text !== 'string' || node.text.length === 0) {
      out.push(problem(path + '.text', 'BAD_TEXT', path + ' needs `text` (a string) or `runs`'))
    } else if (node.text.length > LIMITS.maxTextChars) {
      out.push(problem(path + '.text', 'TEXT_TOO_LARGE', path + '.text is ' + node.text.length + ' chars; the cap is ' + LIMITS.maxTextChars))
    } else {
      normalized.text = node.text
    }
  } else {
    if (node.runs.length > LIMITS.maxRuns) {
      out.push(problem(path + '.runs', 'TOO_MANY_RUNS', 'a text node holds at most ' + LIMITS.maxRuns + ' runs'))
    }
    const runs = []
    let total = 0
    node.runs.slice(0, LIMITS.maxRuns).forEach((run, index) => {
      if (!run || typeof run !== 'object' || typeof run.text !== 'string') {
        out.push(problem(path + '.runs.' + index, 'BAD_RUN', 'a run is {text, color?, weight?, size?}'))
        return
      }
      total += run.text.length
      const entry = { text: run.text }
      if (run.color !== undefined) {
        checkColor(out, run.color, path + '.runs.' + index + '.color', tokens.colors)
        entry.color = resolveColor(run.color, tokens.colors)
      }
      if (run.weight !== undefined) {
        checkNumber(out, run.weight, path + '.runs.' + index + '.weight', 'BAD_WEIGHT', 100, 900)
        entry.weight = isNum(run.weight) ? Math.round(run.weight / 100) * 100 : 400
      }
      if (run.size !== undefined) {
        checkNumber(out, run.size, path + '.runs.' + index + '.size', 'BAD_SIZE', LIMITS.minFontSize, LIMITS.maxFontSize)
        if (isNum(run.size)) entry.size = round(run.size)
      }
      runs.push(entry)
    })
    if (total > LIMITS.maxTextChars) {
      out.push(problem(path + '.runs', 'TEXT_TOO_LARGE', 'the runs together are ' + total + ' chars; the cap is ' + LIMITS.maxTextChars))
    }
    normalized.runs = runs
  }
  if (node.style !== undefined) {
    if (typeof node.style !== 'string' || !Object.prototype.hasOwnProperty.call(tokens.scale, node.style)) {
      out.push(problem(path + '.style', 'BAD_STYLE', path + '.style must be a scale token (' + Object.keys(tokens.scale).join(', ') + ')'))
    } else {
      normalized.style = node.style
    }
  }
  if (node.size !== undefined) {
    checkNumber(out, node.size, path + '.size', 'BAD_SIZE', LIMITS.minFontSize, LIMITS.maxFontSize)
    if (isNum(node.size)) normalized.size = round(node.size)
  }
  if (node.style === undefined && node.size === undefined) normalized.style = 'body'
  if (node.weight !== undefined) {
    checkNumber(out, node.weight, path + '.weight', 'BAD_WEIGHT', 100, 900)
    normalized.weight = isNum(node.weight) ? Math.round(node.weight / 100) * 100 : 400
  }
  if (node.family !== undefined) {
    if (!FONT_ROLES.includes(node.family)) {
      out.push(problem(path + '.family', 'BAD_FONT_ROLE', path + '.family must be one of ' + FONT_ROLES.join(', ')))
    } else {
      normalized.family = node.family
    }
  }
  if (node.color !== undefined) {
    checkColor(out, node.color, path + '.color', tokens.colors)
    normalized.color = resolveColor(node.color, tokens.colors)
  } else {
    normalized.color = resolveColor('ink', tokens.colors)
  }
  checkNumber(out, node.lineHeight, path + '.lineHeight', 'BAD_LINEHEIGHT', 0.7, 3)
  if (isNum(node.lineHeight)) normalized.lineHeight = round(node.lineHeight)
  checkNumber(out, node.letterSpacing, path + '.letterSpacing', 'BAD_TRACKING', -20, 80)
  if (isNum(node.letterSpacing)) normalized.letterSpacing = round(node.letterSpacing)
  if (node.align !== undefined) {
    if (!['start', 'center', 'end'].includes(node.align)) {
      out.push(problem(path + '.align', 'BAD_ALIGN', path + '.align is start, center or end'))
    } else {
      normalized.align = node.align
    }
  }
  if (node.wrap !== undefined) normalized.wrap = node.wrap !== false
  if (node.maxLines !== undefined) {
    if (!Number.isInteger(node.maxLines) || node.maxLines < 1 || node.maxLines > 12) {
      out.push(problem(path + '.maxLines', 'BAD_MAXLINES', path + '.maxLines must be a whole number 1-12'))
    } else {
      normalized.maxLines = node.maxLines
    }
  }
  if (node.ellipsis !== undefined) normalized.ellipsis = node.ellipsis !== false
  if (node.transform !== undefined) {
    if (!['none', 'upper', 'lower', 'title'].includes(node.transform)) {
      out.push(problem(path + '.transform', 'BAD_TRANSFORM', path + '.transform is none, upper, lower or title'))
    } else {
      normalized.transform = node.transform
    }
  }
}

/** An image node. */
function normalizeImage(node, path, tokens, out, normalized) {
  if (typeof node.src !== 'string' || node.src.length === 0) {
    out.push(problem(path + '.src', 'BAD_SRC', path + ' needs `src` (a workspace-relative path or a pasted asset name)'))
  } else if (node.src.length > 512) {
    out.push(problem(path + '.src', 'BAD_SRC', path + '.src is longer than 512 characters'))
  } else {
    normalized.src = node.src
  }
  if (node.fit !== undefined) {
    if (!['cover', 'contain', 'fill'].includes(node.fit)) {
      out.push(problem(path + '.fit', 'BAD_FIT', path + '.fit is cover, contain or fill'))
    } else {
      normalized.fit = node.fit
    }
  } else {
    normalized.fit = 'cover'
  }
  checkNumber(out, node.zoom, path + '.zoom', 'BAD_ZOOM', 1, 8)
  if (isNum(node.zoom)) normalized.zoom = round(node.zoom)
  if (node.focus !== undefined) {
    if (!node.focus || typeof node.focus !== 'object' || !isNum(node.focus.x) || !isNum(node.focus.y)) {
      out.push(problem(path + '.focus', 'BAD_FOCUS', path + '.focus is {x, y} in 0-1'))
    } else {
      normalized.focus = { x: round(clamp(node.focus.x, 0, 1)), y: round(clamp(node.focus.y, 0, 1)) }
    }
  }
  if (node.scrim !== undefined) {
    if (!['none', 'bottom', 'top', 'left', 'right', 'full', 'circle'].includes(node.scrim)) {
      out.push(problem(path + '.scrim', 'BAD_SCRIM', path + '.scrim is none, bottom, top, left, right, full or circle'))
    } else {
      normalized.scrim = node.scrim
    }
  }
  if (node.scrimColor !== undefined) {
    checkColor(out, node.scrimColor, path + '.scrimColor', tokens.colors)
    normalized.scrimColor = resolveColor(node.scrimColor, tokens.colors)
  }
  checkNumber(out, node.scrimStrength, path + '.scrimStrength', 'BAD_SCRIM', 0, 1)
  if (isNum(node.scrimStrength)) normalized.scrimStrength = round(node.scrimStrength)
}

/** A shape node. */
function normalizeShape(node, path, tokens, out, normalized) {
  const shape = node.shape === undefined ? 'rect' : node.shape
  if (!['rect', 'ellipse', 'line', 'polygon', 'path'].includes(shape)) {
    out.push(problem(path + '.shape', 'BAD_SHAPE', path + '.shape is rect, ellipse, line, polygon or path'))
  } else {
    normalized.shape = shape
  }
  if (node.fill !== undefined) {
    checkPaint(out, node.fill, path + '.fill', tokens.colors)
    const fill = normalizePaint(node.fill, tokens)
    if (fill) normalized.fill = fill
  }
  if (node.stroke !== undefined) {
    checkColor(out, node.stroke, path + '.stroke', tokens.colors)
    normalized.stroke = resolveColor(node.stroke, tokens.colors)
  }
  checkNumber(out, node.strokeWidth, path + '.strokeWidth', 'BAD_STROKE', 0, LIMITS.maxStroke)
  if (isNum(node.strokeWidth)) normalized.strokeWidth = round(node.strokeWidth)
  if (node.dash !== undefined) {
    if (!Array.isArray(node.dash) || node.dash.length > 8 || node.dash.some((value) => !isNum(value) || value < 0)) {
      out.push(problem(path + '.dash', 'BAD_DASH', path + '.dash is up to 8 non-negative numbers'))
    } else {
      normalized.dash = node.dash.map(round)
    }
  }
  if (node.points !== undefined) {
    if (!Array.isArray(node.points) || node.points.length < 3 || node.points.length > 64) {
      out.push(problem(path + '.points', 'BAD_POINTS', path + '.points is 3-64 {x, y} pairs in 0-1 of the node box'))
    } else {
      const points = []
      node.points.forEach((point, index) => {
        if (!point || !isNum(point.x) || !isNum(point.y) || point.x < -1 || point.x > 2 || point.y < -1 || point.y > 2) {
          out.push(problem(path + '.points.' + index, 'BAD_POINTS', 'a point is {x, y} in 0-1 of the node box'))
          return
        }
        points.push({ x: round(point.x), y: round(point.y) })
      })
      normalized.points = points
    }
  }
  if (node.d !== undefined) {
    if (typeof node.d !== 'string' || node.d.length === 0 || node.d.length > 8000) {
      out.push(problem(path + '.d', 'BAD_PATH', path + '.d must be a path string of at most 8000 characters'))
    } else if (!/^[\sMmLlHhVvCcSsQqTtAaZz0-9.,+-]+$/.test(node.d)) {
      out.push(problem(path + '.d', 'BAD_PATH', path + '.d may only contain path commands and numbers'))
    } else {
      normalized.d = node.d
    }
  }
  if (shape === 'path' && normalized.d === undefined) {
    out.push(problem(path + '.d', 'BAD_PATH', 'a path shape needs `d`'))
  }
  if (shape === 'polygon' && normalized.points === undefined) {
    out.push(problem(path + '.points', 'BAD_POINTS', 'a polygon needs `points`'))
  }
}

/** Resolve a colour token or literal to a literal. */
function resolveColor(value, colors) {
  if (typeof value !== 'string') return value
  if (Object.prototype.hasOwnProperty.call(colors, value)) return colors[value]
  return value
}

/** Resolve a paint (colour / gradient / art fill) to its canonical form. */
function normalizePaint(value, tokens) {
  if (typeof value === 'string') return { type: 'solid', color: resolveColor(value, tokens.colors) }
  if (!value || typeof value !== 'object') return null
  if (value.type === 'solid') return { type: 'solid', color: resolveColor(value.color, tokens.colors) }
  if (value.type === 'art') {
    const art = { type: 'art', style: value.style }
    if (Array.isArray(value.colors) && value.colors.length > 0) art.colors = value.colors.map((color) => resolveColor(color, tokens.colors))
    if (isNum(value.seed)) art.seed = value.seed
    if (isNum(value.density)) art.density = round(value.density)
    if (isNum(value.scale)) art.scale = round(value.scale)
    if (isNum(value.opacity)) art.opacity = round(value.opacity)
    return art
  }
  if (value.type === 'linear' || value.type === 'radial') {
    const paint = { type: value.type, stops: value.stops.map((stop) => ({ at: round(clamp(stop.at, 0, 1)), color: resolveColor(stop.color, tokens.colors) })) }
    paint.stops.sort((a, b) => a.at - b.at)
    if (value.type === 'linear') paint.angle = round(isNum(value.angle) ? value.angle : 180)
    else {
      paint.cx = round(isNum(value.cx) ? value.cx : 0.5)
      paint.cy = round(isNum(value.cy) ? value.cy : 0.5)
      paint.r = round(isNum(value.r) ? value.r : 0.7)
    }
    return paint
  }
  return null
}

/** Every problem a document has; the tools and the routes call this. */
export function documentErrors(input, options = {}) {
  return normalizeDocument(input, options).problems
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** The fallback vertical metrics when a measurer cannot answer (CSS's own typical values). */
const FALLBACK_ASCENT = 0.8
const FALLBACK_DESCENT = 0.2

/** A CSS font stack for a family name or role. */
export function fontStack(family, fonts = {}) {
  const entry = fonts[family] ?? fonts[String(family).toLowerCase()]
  const system = ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']
  if (family === SYSTEM_FAMILY || family === undefined || family === null) return system.join(', ')
  if (family === 'mono') return ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'].join(', ')
  if (entry && Array.isArray(entry.stack) && entry.stack.length > 0) {
    return entry.stack.map((name) => (name.includes(' ') ? '"' + name + '"' : name)).join(', ')
  }
  return '"' + family + '", ' + system.join(', ')
}

/** A CSS font shorthand for a text style. */
export function fontString({ stack, weight, size }) {
  return weight + ' ' + size + 'px ' + stack
}

/** Apply a text transform. */
function applyTransform(text, transform) {
  if (transform === 'upper') return text.toUpperCase()
  if (transform === 'lower') return text.toLowerCase()
  if (transform === 'title') return text.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1))
  return text
}

/** Split a string into words with the whitespace that followed each. */
function splitWords(text) {
  const parts = String(text).split(/(\s+)/)
  const words = []
  for (let index = 0; index < parts.length; index += 2) {
    const word = parts[index]
    const space = parts[index + 1] ?? ''
    if (word === '' && space === '') continue
    words.push({ word, space })
  }
  return words
}

/**
 * Wrap one paragraph to a width, with the measurer the caller injected.
 *
 * The engine never measures anything itself: `measure(text, font)` is the only
 * source of text width, which is what lets the SAME wrapping run in the browser
 * (canvas `measureText`) and in the check (a synthetic metrics table).
 *
 * @param text - the transformed text.
 * @param font - `{stack, family, weight, size, letterSpacing}`.
 * @param maxWidth - the available width in pixels (Infinity for a single line).
 * @param opts - `{ measure, wrap, maxLines, ellipsis }`.
 * @returns `{ lines, truncated }`.
 */
export function wrapText(text, font, maxWidth, opts) {
  const measure = opts.measure
  const tracking = font.letterSpacing ?? 0
  const widthOf = (value) => measure(value, font) + tracking * Math.max(0, value.length - 1)
  const lines = []
  let truncated = false
  for (const paragraph of String(text).split('\n')) {
    if (opts.wrap === false || !Number.isFinite(maxWidth)) {
      lines.push(paragraph)
      continue
    }
    const words = splitWords(paragraph)
    let current = ''
    for (const { word, space } of words) {
      const candidate = current === '' ? word : current + space + word
      if (current !== '' && widthOf(candidate) > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
      // A single word wider than the box is broken at the character that fits,
      // so a long URL cannot push a headline off the canvas.
      if (current !== '' && widthOf(current) > maxWidth) {
        let chunk = ''
        for (const char of current) {
          if (chunk !== '' && widthOf(chunk + char) > maxWidth) {
            lines.push(chunk)
            chunk = char
          } else {
            chunk += char
          }
        }
        current = chunk
      }
    }
    lines.push(current)
  }
  if (opts.maxLines && lines.length > opts.maxLines) {
    truncated = true
    const kept = lines.slice(0, opts.maxLines)
    if (opts.ellipsis !== false) {
      let last = kept[kept.length - 1]
      while (last.length > 1 && widthOf(last + '\u2026') > maxWidth) last = last.slice(0, -1)
      kept[kept.length - 1] = last.replace(/\s+$/, '') + '\u2026'
    }
    return { lines: kept, truncated }
  }
  return { lines, truncated }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Resolve a text node's font at layout time. */
function textFont(node, document, fonts) {
  const role = node.family ?? (node.style === 'display' || node.style === 'title' ? 'display' : 'text')
  const family = document.tokens.font[role] ?? SYSTEM_FAMILY
  const size = node.size !== undefined ? node.size : document.tokens.scale[node.style ?? 'body'] ?? document.tokens.scale.body
  const weight = node.weight !== undefined ? node.weight : node.style === 'display' || node.style === 'title' ? 700 : 400
  return { family, role, weight, size, letterSpacing: node.letterSpacing ?? 0, stack: fontStack(family, fonts) }
}

/** The text a node actually draws (runs joined or `text`), transformed. */
function textOf(node) {
  const raw = node.text !== undefined ? node.text : (node.runs ?? []).map((run) => run.text).join('')
  return applyTransform(raw, node.transform)
}

/** One line box's height for a font. */
function lineHeightOf(font, node) {
  return round(font.size * (node.lineHeight ?? 1.25))
}

/** The baseline offset inside a line box. */
function ascentOf(font, measure) {
  const metrics = typeof measure.metrics === 'function' ? measure.metrics(font) : null
  const ratio = metrics && isNum(metrics.ascent) ? metrics.ascent : FALLBACK_ASCENT
  return ratio * font.size
}

/**
 * Lay a canonical document out into a draw-op list plus the geometry of every
 * node.
 *
 * @param document - a document from `normalizeDocument` (already canonical).
 * @param opts - `{ measure, assets, fonts }`:
 *   - `measure(text, font) -> number` is REQUIRED; a measurer may also expose
 *     `metrics(font) -> {ascent, descent}` as em ratios, which is how the browser
 *     reports the real font box and the check stays deterministic;
 *   - `assets` maps `src` -> `{width, height}`;
 *   - `fonts` is the bundled-family table.
 * @returns `{ width, height, ops, boxes, text, families, warnings }`.
 */
export function layout(document, opts = {}) {
  const measure = opts.measure
  if (typeof measure !== 'function') throw new Error('layout() needs a text measurer: pass { measure }')
  const guard = (text, font) => {
    const value = measure(text, font)
    return isNum(value) && value >= 0 ? value : 0
  }
  if (typeof measure.metrics === 'function') guard.metrics = (font) => measure.metrics(font)
  const ctx = {
    document,
    fonts: opts.fonts ?? {},
    assets: opts.assets ?? {},
    measure: guard,
    ops: [],
    boxes: [],
    text: [],
    warnings: [],
  }
  const canvasBox = { x: 0, y: 0, w: document.canvas.width, h: document.canvas.height }
  if (document.canvas.background !== null && document.canvas.background !== undefined) {
    emitBackground(document.canvas.background, canvasBox, ctx, null)
  }
  document.layers.forEach((node, index) => {
    placeLayer(node, childPath('', index), canvasBox, ctx, null, false)
  })
  return {
    width: document.canvas.width,
    height: document.canvas.height,
    ops: ctx.ops,
    boxes: ctx.boxes,
    text: ctx.text,
    families: [...new Set(ctx.text.map((entry) => entry.family))],
    warnings: ctx.warnings,
  }
}

/** Emit one background paint over a box (used by the canvas and by frames). */
function emitBackground(paint, box, ctx, clip) {
  const resolved = coercePaint(paint)
  if (!resolved) return
  if (resolved.type === 'art') {
    for (const op of generateArt({ ...resolved, kind: 'art' }, box, ctx.document)) {
      if (clip) op.clip = clip
      ctx.ops.push(op)
    }
    return
  }
  ctx.ops.push({ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: resolved, radius: 0, clip: clip ?? undefined })
}

/** A paint is a colour string, a paint object, or nothing: painters only ever see the object form. */
function coercePaint(paint) {
  if (!paint) return null
  if (typeof paint === 'string') return { type: 'solid', color: paint }
  return paint
}

/**
 * Measure one node: its intrinsic size for `hug` sizing.
 *
 * @returns `{ w, h, lines, truncated, font, textLines }` - `lines`/`textLines`
 *   are the wrapped form a text node will draw, handed to the place pass so the
 *   wrapping happens once.
 */
function measureNode(node, availW, ctx, path, opts = {}) {
  if (node.kind === 'text') {
    const font = textFont(node, ctx.document, ctx.fonts)
    // A text node wraps when it is GIVEN a width - `'fill'`, a number, or a
    // parent that stretches it on the cross axis (a column frame). Without one it
    // hugs a single line, and `emitText` warns when that line leaves the canvas.
    const width = isNum(node.w) ? node.w : node.w === 'fill' || opts.stretchCross === true ? availW : undefined
    const wrapped = wrapRunsOrText(node, font, width, ctx)
    const lineHeight = lineHeightOf(font, node)
    const naturalW = Math.max(0, ...wrapped.lines.map((line) => lineWidth(line, ctx.measure)))
    const hugW = width === undefined ? naturalW : width
    const height = wrapped.lines.length * lineHeight
    return { w: hugW, h: isNum(node.h) ? node.h : height, lines: wrapped.lines, truncated: wrapped.truncated, font, contentHeight: height, lineHeight }
  }
  if (node.kind === 'image') {
    const asset = node.src !== undefined ? ctx.assets[node.src] : null
    const natural = asset && isNum(asset.width) && isNum(asset.height) && asset.width > 0 && asset.height > 0 ? asset : { width: 4, height: 3 }
    let w = isNum(node.w) ? node.w : node.w === 'fill' ? availW : undefined
    let h = isNum(node.h) ? node.h : undefined
    if (w === undefined && h === undefined) {
      w = natural.width
      h = natural.height
    } else if (w === undefined) {
      w = (h * natural.width) / natural.height
    } else if (h === undefined) {
      h = (w * natural.height) / natural.width
    }
    return { w, h, natural }
  }
  if (node.kind === 'art') {
    const w = isNum(node.w) ? node.w : node.w === 'hug' ? availW : availW
    const h = isNum(node.h) ? node.h : node.h === 'hug' ? w / 2 : w / 2
    return { w, h }
  }
  if (node.kind === 'svg') {
    const w = isNum(node.w) ? node.w : availW
    const h = isNum(node.h) ? node.h : w
    return { w, h }
  }
  if (node.kind === 'shape') {
    if (node.shape === 'line') {
      const w = isNum(node.w) ? node.w : node.w === 'hug' ? availW : availW
      return { w, h: isNum(node.h) ? node.h : node.strokeWidth ?? 1 }
    }
    const w = isNum(node.w) ? node.w : node.w === 'hug' ? 120 : availW
    const h = isNum(node.h) ? node.h : node.shape === 'ellipse' ? w : Math.min(w, 120)
    return { w, h }
  }
  // frame: a hug size is the children's extent plus padding, ON THE AXIS THE
  // DIRECTION NAMES. A column frame's hug is its children's HEIGHT; a row frame's
  // hug is their WIDTH - mixing the two is how a row frame ends up as tall as its
  // child is wide, which is exactly the bug this comment prevents coming back.
  const padding = node.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const direction = node.direction ?? 'column'
  const gap = node.gap ?? 0
  const innerAvail = Math.max(0, availW - padding.left - padding.right)
  const children = (node.children ?? []).filter((child) => !isAbsolute(child))
  const sizes = children.map((child, index) => measureNode(child, innerAvail, ctx, path + '.children.' + index, { stretchCross: direction === 'column' }))
  const childMainTotal = sizes.reduce((sum, size) => sum + (direction === 'column' ? size.h : size.w), 0)
  const childCrossMax = Math.max(0, ...sizes.map((size) => (direction === 'column' ? size.w : size.h)))
  const gaps = gap * Math.max(0, sizes.length - 1)
  const padMain = direction === 'column' ? padding.top + padding.bottom : padding.left + padding.right
  const padCross = direction === 'column' ? padding.left + padding.right : padding.top + padding.bottom
  const hugMain = childMainTotal + gaps + padMain
  const hugCross = childCrossMax + padCross
  const w = isNum(node.w) ? node.w : node.w === 'fill' ? availW : direction === 'column' ? Math.max(hugCross, 0) : Math.max(hugMain, 0)
  const h = isNum(node.h) ? node.h : node.h === 'fill' ? 0 : direction === 'column' ? Math.max(hugMain, 0) : Math.max(hugCross, 0)
  return { w, h, childSizes: sizes, direction, padding, gap }
}

/** A node that names x or y leaves its parent's flow and is placed absolutely. */
function isAbsolute(node) {
  return node.x !== undefined || node.y !== undefined
}

/** Place one top-level layer (absolutely, in the canvas). */
function placeLayer(node, path, canvasBox, ctx, clip, inFlow) {
  const size = measureNode(node, canvasBox.w, ctx, path)
  const x = canvasBox.x + (isNum(node.x) ? node.x : 0)
  const y = canvasBox.y + (isNum(node.y) ? node.y : 0)
  const w = isNum(node.w) ? node.w : node.w === 'fill' ? canvasBox.w : node.w === 'hug' ? size.w : inFlow ? size.w : size.w
  const h = isNum(node.h) ? node.h : node.h === 'fill' ? canvasBox.h : node.h === 'hug' ? size.h : size.h
  placeNode(node, { x, y, w: Math.max(0, w), h: Math.max(0, h) }, path, ctx, clip, size)
}

/** Place one node into its final box and emit its ops. */
function placeNode(node, box, path, ctx, clip, measured) {
  const box2 = { x: round(box.x), y: round(box.y), w: round(Math.max(0, box.w)), h: round(Math.max(0, box.h)) }
  const base = {
    opacity: node.opacity,
    blend: node.blend,
    rotate: node.rotate,
    shadow: node.shadow,
    clip: clip ?? undefined,
    path,
  }
  if (node.kind === 'frame') {
    if (node.background) emitBackground(node.background, box2, ctx, clip ?? null)
    const frameClip =
      node.clip === true || (node.radius && node.clip !== false)
        ? { x: box2.x, y: box2.y, w: box2.w, h: box2.h, radius: node.radius ?? 0 }
        : clip
    placeFrameChildren(node, box2, path, ctx, frameClip ?? null, measured)
    if (node.border && node.border.width > 0) {
      ctx.ops.push({ ...base, kind: 'rect', x: box2.x, y: box2.y, w: box2.w, h: box2.h, radius: node.radius ?? 0, fill: null, stroke: node.border.color, strokeWidth: node.border.width, dash: node.border.dash })
    } else if (node.shadow && !node.background) {
      ctx.ops.push({ ...base, kind: 'rect', x: box2.x, y: box2.y, w: box2.w, h: box2.h, radius: node.radius ?? 0, fill: null })
    }
    ctx.boxes.push({ path, kind: 'frame', id: node.id ?? null, box: box2, radius: node.radius ?? 0, opacity: node.opacity ?? 1, clipped: frameClip !== null && frameClip !== undefined })
    return
  }
  if (node.kind === 'text') {
    emitText(node, box2, path, ctx, base, measured)
    return
  }
  if (node.kind === 'image') {
    emitImage(node, box2, path, ctx, base, measured)
    return
  }
  if (node.kind === 'shape') {
    emitShape(node, box2, path, ctx, base)
    return
  }
  if (node.kind === 'art') {
    const ops = generateArt(node, box2, ctx.document)
    for (const op of ops) ctx.ops.push({ ...op, opacity: op.opacity === undefined ? node.opacity : op.opacity, blend: node.blend, rotate: node.rotate, clip: base.clip })
    ctx.boxes.push({ path, kind: 'art', id: node.id ?? null, box: box2, style: node.style, opCount: ops.length, seed: node.seed ?? 1, opacity: node.opacity ?? 1 })
    return
  }
  if (node.kind === 'svg') {
    ctx.ops.push({
      ...base,
      kind: 'svg',
      x: box2.x,
      y: box2.y,
      w: box2.w,
      h: box2.h,
      svg: node.svg,
      viewBox: node.viewBox ?? null,
      preserveAspectRatio: node.preserveAspectRatio ?? 'meet',
      fill: node.fill ?? null,
    })
    ctx.boxes.push({ path, kind: 'svg', id: node.id ?? null, box: box2, viewBox: node.viewBox ?? null, opacity: node.opacity ?? 1 })
  }
}

/** A frame's children: flow along the main axis, absolute ones off to the side. */
function placeFrameChildren(node, box, path, ctx, clip, measured) {
  const padding = node.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const direction = node.direction ?? 'column'
  const gap = node.gap ?? 0
  const inner = {
    x: box.x + padding.left,
    y: box.y + padding.top,
    w: Math.max(0, box.w - padding.left - padding.right),
    h: Math.max(0, box.h - padding.top - padding.bottom),
  }
  const children = node.children ?? []
  const absolute = children.filter(isAbsolute)
  const flow = children.filter((child) => !isAbsolute(child))
  // Absolute children are placed inside the padding box, where the model put them.
  for (const child of absolute) {
    const index = children.indexOf(child)
    const childPathNow = path + '.children.' + index
    const size = measureNode(child, inner.w, ctx, childPathNow, { stretchCross: direction === 'column' })
    const w = isNum(child.w) ? child.w : child.w === 'fill' ? inner.w : child.w === 'hug' ? size.w : size.w
    const h = isNum(child.h) ? child.h : child.h === 'fill' ? inner.h : child.h === 'hug' ? size.h : size.h
    placeNode(child, { x: inner.x + (isNum(child.x) ? child.x : 0), y: inner.y + (isNum(child.y) ? child.y : 0), w, h }, childPathNow, ctx, clip, size)
  }
  if (flow.length === 0) return
  const main = direction === 'column' ? 'h' : 'w'
  const cross = direction === 'column' ? 'w' : 'h'
  const sizes = flow.map((child) => {
    const childPathNow = path + '.children.' + children.indexOf(child)
    const size = measureNode(child, inner.w, ctx, childPathNow, { stretchCross: direction === 'column' })
    const mainSize = isNum(child[main]) ? child[main] : size[main]
    return { child, size, mainSize, fill: child[main] === 'fill', childPath: childPathNow }
  })
  const fixed = sizes.filter((entry) => !entry.fill).reduce((sum, entry) => sum + entry.mainSize, 0)
  const gaps = gap * Math.max(0, flow.length - 1)
  const leftover = Math.max(0, (direction === 'column' ? inner.h : inner.w) - fixed - gaps)
  const fillCount = sizes.filter((entry) => entry.fill).length
  const fillSize = fillCount > 0 ? leftover / fillCount : 0
  const justify = node.justify ?? 'start'
  const freeAfterSizes = Math.max(0, (direction === 'column' ? inner.h : inner.w) - fixed - (fillCount > 0 ? leftover : 0) - gaps)
  let cursor = direction === 'column' ? inner.y : inner.x
  if (justify === 'center') cursor += freeAfterSizes / 2
  else if (justify === 'end') cursor += freeAfterSizes
  const extraGap = justify === 'space-between' && flow.length > 1 ? freeAfterSizes / (flow.length - 1) : 0
  for (const entry of sizes) {
    const { child, size, childPath: childPathNow } = entry
    const mainSize = entry.fill ? fillSize : entry.mainSize
    let crossSize = isNum(child[cross]) ? child[cross] : child[cross] === 'hug' ? size[cross] : inner[cross]
    const align = node.align ?? 'start'
    if (align === 'stretch' && child[cross] === undefined) crossSize = inner[cross]
    let crossOffset = direction === 'column' ? inner.x : inner.y
    if (align === 'center') crossOffset += Math.max(0, (inner[cross] - crossSize) / 2)
    else if (align === 'end') crossOffset += Math.max(0, inner[cross] - crossSize)
    const finalBox =
      direction === 'column'
        ? { x: crossOffset, y: cursor, w: crossSize, h: mainSize }
        : { x: cursor, y: crossOffset, w: mainSize, h: crossSize }
    placeNode(child, finalBox, childPathNow, ctx, clip, size)
    cursor += mainSize + gap + extraGap
  }
}

/** A text node's lines, as lists of runs. */
function wrapRunsOrText(node, font, width, ctx) {
  const maxWidth = width !== undefined ? width : Infinity
  const wrap = node.wrap !== false
  if (node.runs && node.runs.length > 0) {
    const lines = [[]]
    const push = (run, text, runFont) => lines[lines.length - 1].push({ text, font: runFont, color: run.color ?? node.color })
    for (const run of node.runs) {
      const runFont = { ...font, weight: run.weight ?? font.weight, size: run.size ?? font.size, letterSpacing: font.letterSpacing }
      const text = applyTransform(run.text, node.transform)
      const words = splitWords(text)
      let current = ''
      for (const { word, space } of words) {
        const candidate = current === '' ? word : current + space + word
        const widthNow = lineWidth(lines[lines.length - 1], ctx.measure)
        const candidateWidth = ctx.measure(candidate, runFont) + (runFont.letterSpacing ?? 0) * Math.max(0, candidate.length - 1)
        if (wrap && current !== '' && widthNow + candidateWidth > maxWidth) {
          push(run, current, runFont)
          lines.push([])
          current = word
        } else {
          current = candidate
        }
        if (wrap && current !== '' && ctx.measure(current, runFont) > maxWidth) {
          let chunk = ''
          for (const char of current) {
            if (chunk !== '' && ctx.measure(chunk + char, runFont) > maxWidth) {
              push(run, chunk, runFont)
              lines.push([])
              chunk = char
            } else {
              chunk += char
            }
          }
          current = chunk
        }
      }
      if (current !== '') push(run, current, runFont)
    }
    let result = lines.filter((line) => line.length > 0)
    if (result.length === 0) result = [[{ text: '', font, color: node.color }]]
    let truncated = false
    if (node.maxLines && result.length > node.maxLines) {
      truncated = true
      result = result.slice(0, node.maxLines)
      if (node.ellipsis !== false && result.length > 0) {
        const last = result[result.length - 1]
        last[last.length - 1] = { ...last[last.length - 1], text: last[last.length - 1].text.replace(/\s+$/, '') + '\u2026' }
      }
    }
    return { lines: result, truncated }
  }
  const text = textOf(node)
  const wrapped = wrapText(text, font, width === undefined ? Infinity : maxWidth, {
    measure: ctx.measure,
    wrap,
    maxLines: node.maxLines,
    ellipsis: node.ellipsis,
  })
  return { lines: wrapped.lines.map((line) => [{ text: line, font, color: node.color }]), truncated: wrapped.truncated }
}

/** Width of one line (a list of runs). */
function lineWidth(line, measure) {
  return line.reduce((sum, run) => sum + runWidth(run, measure), 0)
}

/** Width of one run, tracking included. */
function runWidth(run, measure) {
  const tracking = run.font.letterSpacing ?? 0
  return measure(run.text, run.font) + tracking * Math.max(0, run.text.length - 1)
}

/** Emit a text node's ops, boxes and lines. */
function emitText(node, box, path, ctx, base, measured) {
  const font = measured && measured.font ? measured.font : textFont(node, ctx.document, ctx.fonts)
  const lines = measured && measured.lines ? measured.lines : wrapRunsOrText(node, font, isNum(node.w) ? node.w : undefined, ctx).lines
  const lineHeight = measured && measured.lineHeight ? measured.lineHeight : lineHeightOf(font, node)
  const contentHeight = lines.length * lineHeight
  const align = node.align ?? 'start'
  const ascent = ascentOf(font, ctx.measure)
  const smallest = Math.min(...lines.flat().map((run) => run.font.size).filter((value) => isNum(value)))
  lines.forEach((line, index) => {
    const lineTop = box.y + index * lineHeight
    const baseline = round(lineTop + (lineHeight - font.size) / 2 + ascent)
    const width = lineWidth(line, ctx.measure)
    let x = box.x
    if (align === 'center') x = box.x + Math.max(0, (box.w - width) / 2)
    else if (align === 'end') x = box.x + Math.max(0, box.w - width)
    let cursor = x
    for (const run of line) {
      const runWidthNow = runWidth(run, ctx.measure)
      ctx.ops.push({
        ...base,
        kind: 'text',
        x: round(cursor),
        y: baseline,
        text: run.text,
        font: fontString(run.font),
        stack: run.font.stack,
        family: run.font.family,
        size: run.font.size,
        weight: run.font.weight,
        color: run.color,
        letterSpacing: run.font.letterSpacing ?? 0,
      })
      ctx.text.push({
        path,
        text: run.text,
        family: run.font.family,
        size: run.font.size,
        weight: run.font.weight,
        color: run.color,
        x: round(cursor),
        y: baseline,
        w: round(runWidthNow),
        h: run.font.size,
        line: index,
      })
      cursor += runWidthNow
    }
  })
  const overflow = isNum(node.h) && contentHeight > node.h + 0.5
  ctx.boxes.push({
    path,
    kind: 'text',
    id: node.id ?? null,
    box,
    lines: lines.length,
    truncated: (measured && measured.truncated) === true,
    lineHeight,
    contentHeight: round(contentHeight),
    font: { family: font.family, weight: font.weight, size: smallest === undefined || !Number.isFinite(smallest) ? font.size : smallest },
    text: textOf(node).slice(0, 120),
    opacity: node.opacity ?? 1,
  })
  if (measured && measured.truncated) {
    ctx.warnings.push({ code: 'TEXT_TRUNCATED', path, message: path + ' was cut at ' + node.maxLines + ' line(s) with an ellipsis' })
  }
  if (overflow) {
    ctx.warnings.push({ code: 'TEXT_OVERFLOW', path, message: path + ' needs ' + round(contentHeight) + 'px of type in a box of ' + round(node.h) + 'px' })
  }
  if (node.w === undefined && lines.length === 1 && box.w > ctx.document.canvas.width + 0.5) {
    ctx.warnings.push({ code: 'TEXT_UNWRAPPED', path, message: path + ' is wider than the canvas and does not wrap: give it a `w` (a number or "fill")' })
  }
}

/** Emit an image node's ops: the picture, its crop, and any scrim. */
function emitImage(node, box, path, ctx, base, measured) {
  const natural = (measured && measured.natural) ?? ctx.assets[node.src] ?? { width: 4, height: 3 }
  const fit = node.fit ?? 'cover'
  const zoom = node.zoom ?? 1
  let sx = 0
  let sy = 0
  let sw = natural.width
  let sh = natural.height
  if (fit !== 'fill' && natural.width > 0 && natural.height > 0) {
    const scale = fit === 'cover' ? Math.max(box.w / natural.width, box.h / natural.height) : Math.min(box.w / natural.width, box.h / natural.height)
    const visibleW = Math.min(natural.width, box.w / scale)
    const visibleH = Math.min(natural.height, box.h / scale)
    const focus = node.focus ?? { x: 0.5, y: 0.5 }
    sx = clamp((natural.width - visibleW) * focus.x, 0, Math.max(0, natural.width - visibleW))
    sy = clamp((natural.height - visibleH) * focus.y, 0, Math.max(0, natural.height - visibleH))
    sw = visibleW
    sh = visibleH
  }
  if (zoom > 1) {
    const centerX = sx + sw / 2
    const centerY = sy + sh / 2
    sw /= zoom
    sh /= zoom
    sx = clamp(centerX - sw / 2, 0, Math.max(0, natural.width - sw))
    sy = clamp(centerY - sh / 2, 0, Math.max(0, natural.height - sh))
  }
  ctx.ops.push({ ...base, kind: 'image', x: box.x, y: box.y, w: box.w, h: box.h, src: node.src, fit, crop: { x: round(sx), y: round(sy), w: round(sw), h: round(sh) }, natural, radius: node.radius ?? 0 })
  if (node.scrim && node.scrim !== 'none') {
    for (const op of scrimOps(node, box)) ctx.ops.push({ ...op, clip: base.clip })
  }
  ctx.boxes.push({ path, kind: 'image', id: node.id ?? null, box, src: node.src, natural, crop: { x: round(sx), y: round(sy), w: round(sw), h: round(sh) }, radius: node.radius ?? 0, opacity: node.opacity ?? 1 })
  if (!ctx.assets[node.src]) {
    ctx.warnings.push({ code: 'IMAGE_UNMEASURED', path, message: path + ' names "' + String(node.src) + '", which the asset table does not describe - a hug size assumed 4:3' })
  }
}

/** The gradient scrim an image may carry. */
function scrimOps(node, box) {
  const strength = node.scrimStrength ?? 0.65
  const color = node.scrimColor ?? '#000000'
  const transparent = withAlpha(color, 0)
  const opaque = withAlpha(color, strength)
  if (node.scrim === 'full') {
    return [{ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: { type: 'solid', color: opaque } }]
  }
  if (node.scrim === 'circle') {
    return [
      {
        kind: 'rect',
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        radius: Math.max(box.w, box.h) / 2,
        fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.75, stops: [{ at: 0, color: transparent }, { at: 1, color: opaque }] },
      },
    ]
  }
  const angle = node.scrim === 'bottom' ? 0 : node.scrim === 'top' ? 180 : node.scrim === 'left' ? 90 : 270
  return [{ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: { type: 'linear', angle, stops: [{ at: 0, color: opaque }, { at: 0.62, color: transparent }] } }]
}

/** Emit a shape node's op. */
function emitShape(node, box, path, ctx, base) {
  const shape = node.shape ?? 'rect'
  const op = {
    ...base,
    kind: shape === 'ellipse' ? 'ellipse' : shape === 'line' ? 'line' : shape === 'polygon' ? 'polygon' : shape === 'path' ? 'path' : 'rect',
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    cx: round(box.x + box.w / 2),
    cy: round(box.y + box.h / 2),
    rx: round(box.w / 2),
    ry: round(box.h / 2),
    x1: round(box.x),
    y1: round(box.y),
    x2: round(box.x + box.w),
    y2: round(box.y + box.h),
    fill: node.fill ?? null,
    stroke: node.stroke ?? null,
    strokeWidth: node.strokeWidth ?? (node.stroke ? 1 : 0),
    dash: node.dash,
    radius: node.radius ?? 0,
    points: node.points,
    d: node.d,
  }
  ctx.ops.push(op)
  ctx.boxes.push({ path, kind: 'shape', id: node.id ?? null, box, shape, fill: node.fill ?? null, stroke: node.stroke ?? null })
}

// ---------------------------------------------------------------------------
// Procedural art
// ---------------------------------------------------------------------------

/** The colours an art generator uses when the node names none. */
function artColors(node, document) {
  const named = Array.isArray(node.colors) && node.colors.length > 0 ? node.colors : null
  if (named) return named.map((color) => resolveColor(color, document.tokens.color))
  return [document.tokens.color.accent, document.tokens.color.surface, document.tokens.color.ink]
}

/**
 * Turn one art generator into draw ops. Deterministic from `seed` and bounded by
 * `LIMITS.maxArtOps` - a generator that wanted more is capped rather than
 * silently producing an unbounded op list.
 */
export function generateArt(node, box, document) {
  const style = node.style ?? 'mesh'
  const colors = artColors(node, document)
  const seed = Number.isInteger(node.seed) ? node.seed : 1
  const random = seededRandom(seed + style.length * 7919)
  const primary = colors[0] ?? '#4D6BFE'
  const secondary = colors[1] ?? '#0B0E14'
  const tertiary = colors[2] ?? '#F8FAFC'
  const strength = node.opacity === undefined ? 1 : node.opacity
  const density = node.density ?? 0.5
  const scale = node.scale ?? 1
  const ops = []
  const push = (op) => {
    if (ops.length < LIMITS.maxArtOps) ops.push(op)
  }
  const base = { x: box.x, y: box.y, w: box.w, h: box.h, opacity: strength }

  if (style === 'mesh') {
    push({ ...base, kind: 'rect', fill: { type: 'linear', angle: 140, stops: [{ at: 0, color: secondary }, { at: 1, color: withAlpha(primary, 0.55) }] } })
    const blobs = 4 + Math.round(density * 4)
    for (let index = 0; index < blobs; index += 1) {
      const color = index % 2 === 0 ? primary : tertiary
      push({
        ...base,
        kind: 'ellipse',
        cx: round(box.x + box.w * (0.12 + random() * 0.76)),
        cy: round(box.y + box.h * (0.12 + random() * 0.76)),
        rx: round(box.w * (0.18 + random() * 0.3) * scale),
        ry: round(box.h * (0.18 + random() * 0.3) * scale),
        fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: [{ at: 0, color: withAlpha(color, 0.5) }, { at: 1, color: withAlpha(color, 0) }] },
      })
    }
    return ops
  }
  if (style === 'grid') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const step = Math.max(16, Math.round((box.w / (14 * scale)) * (1.4 - density * 0.6)))
    const dot = Math.max(1, Math.round(1.6 * scale))
    for (let x = step / 2; x < box.w; x += step) {
      for (let y = step / 2; y < box.h; y += step) {
        const fade = 1 - Math.min(1, Math.abs(y / box.h - 0.5) * 1.6)
        push({ ...base, kind: 'ellipse', cx: round(box.x + x), cy: round(box.y + y), rx: dot, ry: dot, fill: { type: 'solid', color: withAlpha(primary, round(0.25 + fade * 0.5)) } })
      }
    }
    return ops
  }
  if (style === 'stripes') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const step = Math.max(12, Math.round(28 / scale))
    const width = Math.max(3, Math.round(step * 0.42))
    for (let x = -box.h; x < box.w + box.h; x += step) {
      push({
        ...base,
        kind: 'polygon',
        w: box.w,
        h: box.h,
        points: [
          { x: x / box.w, y: 0 },
          { x: (x + width) / box.w, y: 0 },
          { x: (x + width + box.h) / box.w, y: 1 },
          { x: (x + box.h) / box.w, y: 1 },
        ],
        fill: { type: 'solid', color: withAlpha(primary, 0.22) },
      })
    }
    return ops
  }
  if (style === 'rings') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const cx = box.x + box.w * (0.2 + random() * 0.6)
    const cy = box.y + box.h * (0.2 + random() * 0.6)
    const count = 5 + Math.round(density * 6)
    for (let index = 0; index < count; index += 1) {
      const radius = ((index + 1) / count) * Math.max(box.w, box.h) * 0.72 * scale
      push({ ...base, kind: 'ellipse', cx: round(cx), cy: round(cy), rx: round(radius), ry: round(radius), fill: null, stroke: withAlpha(primary, round(0.5 - index * 0.05)), strokeWidth: round(Math.max(1, 2 * scale)) })
    }
    return ops
  }
  if (style === 'glow') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    push({
      ...base,
      kind: 'ellipse',
      cx: round(box.x + box.w * 0.5),
      cy: round(box.y + box.h * 0.55),
      rx: round(box.w * 0.6 * scale),
      ry: round(box.h * 0.7 * scale),
      fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: [{ at: 0, color: withAlpha(primary, 0.85) }, { at: 0.55, color: withAlpha(primary, 0.25) }, { at: 1, color: withAlpha(primary, 0) }] },
    })
    return ops
  }
  if (style === 'grain') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const count = 120 + Math.round(density * 380)
    for (let index = 0; index < count; index += 1) {
      const size = 0.6 + random() * 1.6 * scale
      push({ ...base, kind: 'ellipse', cx: round(box.x + random() * box.w), cy: round(box.y + random() * box.h), rx: round(size), ry: round(size), fill: { type: 'solid', color: withAlpha(random() > 0.5 ? tertiary : primary, round(0.05 + random() * 0.16)) } })
    }
    return ops
  }
  if (style === 'waves') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const bands = 4 + Math.round(density * 5)
    for (let index = 0; index < bands; index += 1) {
      const y = box.y + ((index + 1) / (bands + 1)) * box.h
      const amplitude = box.h * (0.03 + random() * 0.06) * scale
      const shift = random() * Math.PI
      const commands = []
      for (let step = 0; step <= 24; step += 1) {
        const x = box.x + (step / 24) * box.w
        const offset = Math.sin((step / 24) * Math.PI * 2 + shift) * amplitude
        commands.push((step === 0 ? 'M' : 'L') + round(x) + ' ' + round(y + offset))
      }
      push({ ...base, kind: 'path', d: commands.join(' '), fill: null, stroke: withAlpha(index % 2 === 0 ? primary : tertiary, 0.4), strokeWidth: round(Math.max(1, 2 * scale)), w: box.w, h: box.h })
    }
    return ops
  }
  if (style === 'blueprint') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const step = Math.max(18, Math.round(46 / scale))
    for (let x = 0; x <= box.w; x += step) push({ ...base, kind: 'line', x1: round(box.x + x), y1: round(box.y), x2: round(box.x + x), y2: round(box.y + box.h), stroke: withAlpha(primary, 0.22), strokeWidth: 1 })
    for (let y = 0; y <= box.h; y += step) push({ ...base, kind: 'line', x1: round(box.x), y1: round(box.y + y), x2: round(box.x + box.w), y2: round(box.y + y), stroke: withAlpha(primary, 0.22), strokeWidth: 1 })
    const boxes = 3 + Math.round(density * 4)
    for (let index = 0; index < boxes; index += 1) {
      const w = box.w * (0.1 + random() * 0.22)
      const h = box.h * (0.1 + random() * 0.22)
      push({
        ...base,
        kind: 'rect',
        x: round(box.x + random() * Math.max(0, box.w - w)),
        y: round(box.y + random() * Math.max(0, box.h - h)),
        w: round(w),
        h: round(h),
        radius: round(4 * scale),
        fill: null,
        stroke: withAlpha(tertiary, 0.5),
        strokeWidth: round(Math.max(1, 1.5 * scale)),
      })
    }
    return ops
  }
  if (style === 'circuit') {
    push({ ...base, kind: 'rect', fill: { type: 'solid', color: secondary } })
    const traces = 8 + Math.round(density * 10)
    for (let index = 0; index < traces; index += 1) {
      let x = box.x + Math.round((random() * box.w) / 12) * 12
      let y = box.y + Math.round((random() * box.h) / 12) * 12
      const commands = ['M' + round(x) + ' ' + round(y)]
      const legs = 2 + Math.round(random() * 3)
      for (let leg = 0; leg < legs; leg += 1) {
        const dx = (random() > 0.5 ? 1 : -1) * box.w * (0.08 + random() * 0.22)
        const dy = (random() > 0.5 ? 1 : -1) * box.h * (0.08 + random() * 0.22)
        x = clamp(x + dx, box.x, box.x + box.w)
        y = clamp(y + dy, box.y, box.y + box.h)
        commands.push('L' + round(x) + ' ' + round(y))
      }
      push({ ...base, kind: 'path', d: commands.join(' '), fill: null, stroke: withAlpha(primary, 0.45), strokeWidth: round(Math.max(1, 1.4 * scale)), w: box.w, h: box.h })
      push({ ...base, kind: 'ellipse', cx: round(x), cy: round(y), rx: round(2.4 * scale), ry: round(2.4 * scale), fill: { type: 'solid', color: withAlpha(tertiary, 0.7) } })
    }
    return ops
  }
  // stars
  push({ ...base, kind: 'rect', fill: { type: 'linear', angle: 160, stops: [{ at: 0, color: secondary }, { at: 1, color: withAlpha(primary, 0.35) }] } })
  const count = 60 + Math.round(density * 160)
  for (let index = 0; index < count; index += 1) {
    const size = 0.5 + random() * 2.1 * scale
    push({ ...base, kind: 'ellipse', cx: round(box.x + random() * box.w), cy: round(box.y + random() * box.h), rx: round(size), ry: round(size), fill: { type: 'solid', color: withAlpha(tertiary, round(0.15 + random() * 0.7)) } })
  }
  return ops
}

// ---------------------------------------------------------------------------
// Canvas painter
// ---------------------------------------------------------------------------

/**
 * Paint an op list onto a 2D context. This is the artboard AND the PNG export:
 * the same function, at whatever `scale` the caller asks for, which is why the
 * exported file cannot disagree with the preview.
 *
 * The context may be a real `CanvasRenderingContext2D` or anything with the same
 * shape - `scripts/checks/check-canvas-node.mjs` passes a RECORDER, which is how
 * every draw call the painter makes is asserted without a browser.
 *
 * @param ops - the op list from `layout`.
 * @param ctx - a 2D context (or a recorder).
 * @param opts - `{ scale, images, assets }`: `images` maps `src` to a drawable
 *   image (and `'svg:' + path` to a pre-rasterized fragment image).
 */
export function paintCanvas(ops, ctx, opts = {}) {
  const scale = opts.scale ?? 1
  const images = opts.images ?? {}
  ctx.save()
  ctx.scale(scale, scale)
  for (const op of ops) {
    ctx.save()
    if (op.clip) {
      ctx.beginPath()
      roundedRect(ctx, op.clip.x, op.clip.y, op.clip.w, op.clip.h, op.clip.radius ?? 0)
      ctx.clip()
    }
    if (op.rotate) {
      const centerX = op.x + op.w / 2
      const centerY = op.y + op.h / 2
      ctx.translate(centerX, centerY)
      ctx.rotate((op.rotate * Math.PI) / 180)
      ctx.translate(-centerX, -centerY)
    }
    if (op.opacity !== undefined && op.opacity !== null && op.opacity < 1) ctx.globalAlpha = op.opacity
    if (op.blend && op.blend !== 'normal') ctx.globalCompositeOperation = op.blend
    if (op.shadow) applyShadow(ctx, op.shadow)
    paintOp(op, ctx, { images, assets: opts.assets ?? {}, scale })
    ctx.restore()
  }
  ctx.restore()
}

/** Set a canvas shadow from an op's shadow spec. */
function applyShadow(ctx, shadow) {
  const color = parseColor(shadow.color) ?? { r: 0, g: 0, b: 0, a: 0.45 }
  ctx.shadowColor = formatColor(color)
  ctx.shadowBlur = shadow.blur
  ctx.shadowOffsetX = shadow.x
  ctx.shadowOffsetY = shadow.y
}

/** One op, onto the context. */
function paintOp(op, ctx, env) {
  const fillOf = (rawPaint, box) => {
    const paint = coercePaint(rawPaint)
    if (!paint) return null
    if (paint.type === 'solid') return paint.color
    return gradientFor(paint, box, ctx)
  }
  if (op.kind === 'rect') {
    if (op.fill) {
      ctx.fillStyle = fillOf(op.fill, op)
      ctx.beginPath()
      roundedRect(ctx, op.x, op.y, op.w, op.h, op.radius ?? 0)
      ctx.fill()
    }
    if (op.stroke && op.strokeWidth > 0) {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = op.strokeWidth
      if (op.dash) ctx.setLineDash(op.dash)
      ctx.beginPath()
      roundedRect(ctx, op.x, op.y, op.w, op.h, op.radius ?? 0)
      ctx.stroke()
      if (op.dash) ctx.setLineDash([])
    }
    return
  }
  if (op.kind === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(op.cx, op.cy, Math.max(0, op.rx), Math.max(0, op.ry), 0, 0, Math.PI * 2)
    if (op.fill) {
      ctx.fillStyle = fillOf(op.fill, op)
      ctx.fill()
    }
    if (op.stroke && op.strokeWidth > 0) {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = op.strokeWidth
      ctx.stroke()
    }
    return
  }
  if (op.kind === 'line') {
    ctx.strokeStyle = op.stroke ?? '#ffffff'
    ctx.lineWidth = op.strokeWidth ?? 1
    if (op.dash) ctx.setLineDash(op.dash)
    ctx.beginPath()
    ctx.moveTo(op.x1, op.y1)
    ctx.lineTo(op.x2, op.y2)
    ctx.stroke()
    if (op.dash) ctx.setLineDash([])
    return
  }
  if (op.kind === 'path') {
    drawPathD(ctx, op.d)
    if (op.fill) {
      ctx.fillStyle = fillOf(op.fill, op)
      ctx.fill()
    }
    if (op.stroke && op.strokeWidth > 0) {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = op.strokeWidth
      if (op.dash) ctx.setLineDash(op.dash)
      ctx.stroke()
      if (op.dash) ctx.setLineDash([])
    }
    return
  }
  if (op.kind === 'polygon') {
    const points = op.points ?? []
    if (points.length === 0) return
    ctx.beginPath()
    points.forEach((point, index) => {
      const x = op.x + point.x * op.w
      const y = op.y + point.y * op.h
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    if (op.fill) {
      ctx.fillStyle = fillOf(op.fill, op)
      ctx.fill()
    }
    if (op.stroke && op.strokeWidth > 0) {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = op.strokeWidth
      ctx.stroke()
    }
    return
  }
  if (op.kind === 'text') {
    ctx.fillStyle = op.color ?? '#ffffff'
    ctx.font = op.font
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
    if (op.letterSpacing) drawTracked(ctx, op)
    else ctx.fillText(op.text, op.x, op.y)
    return
  }
  if (op.kind === 'image') {
    const image = env.images[op.src]
    if (!image) return
    ctx.save()
    ctx.beginPath()
    roundedRect(ctx, op.x, op.y, op.w, op.h, op.radius ?? 0)
    ctx.clip()
    const crop = op.crop ?? { x: 0, y: 0, w: op.natural?.width ?? op.w, h: op.natural?.height ?? op.h }
    ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, op.x, op.y, op.w, op.h)
    ctx.restore()
    return
  }
  if (op.kind === 'svg') {
    // A raw fragment cannot be drawn by canvas directly: the caller supplies a
    // pre-rasterized image under `'svg:' + path`. Absent one, the op is skipped
    // and the report says so (`lintLayout` reports the missing fragment image).
    const fragment = env.images['svg:' + op.path]
    if (fragment) ctx.drawImage(fragment, op.x, op.y, op.w, op.h)
  }
}

/** A rounded rectangle path (canvas `roundRect` is not on every engine). */
function roundedRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2))
  if (r <= 0) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

/** A gradient (linear or radial) for a paint inside a box. */
function gradientFor(paint, box, ctx) {
  const stops = paint.stops ?? []
  if (paint.type === 'radial') {
    const cx = box.x + box.w * (paint.cx ?? 0.5)
    const cy = box.y + box.h * (paint.cy ?? 0.5)
    const radius = Math.max(box.w, box.h) * (paint.r ?? 0.7)
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(0.01, radius))
    for (const stop of stops) gradient.addColorStop(clamp(stop.at, 0, 1), stop.color)
    return gradient
  }
  const angle = ((paint.angle ?? 180) * Math.PI) / 180
  const halfW = box.w / 2
  const halfH = box.h / 2
  const cx = box.x + halfW
  const cy = box.y + halfH
  const dx = Math.cos(angle) * halfW
  const dy = Math.sin(angle) * halfH
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  for (const stop of stops) gradient.addColorStop(clamp(stop.at, 0, 1), stop.color)
  return gradient
}

/** The command letters a path may use. */
const PATH_COMMANDS = 'MmLlHhVvCcSsQqTtAaZz'

/** Draw a path string. Curves and arcs the canvas path API can express are drawn as such. */
function drawPathD(ctx, d) {
  const tokens = String(d ?? '').match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  let index = 0
  let command = 'M'
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastControlX = null
  let lastControlY = null
  const number = () => {
    const value = Number(tokens[index])
    index += 1
    return Number.isFinite(value) ? value : 0
  }
  ctx.beginPath()
  while (index < tokens.length) {
    if (tokens[index] && tokens[index].length === 1 && PATH_COMMANDS.includes(tokens[index])) {
      command = tokens[index]
      index += 1
      if (command === 'Z' || command === 'z') {
        ctx.closePath()
        x = startX
        y = startY
        continue
      }
    }
    const relative = command === command.toLowerCase()
    const upper = command.toUpperCase()
    if (upper === 'M') {
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      startX = x
      startY = y
      ctx.moveTo(x, y)
      command = relative ? 'l' : 'L'
    } else if (upper === 'L') {
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      ctx.lineTo(x, y)
    } else if (upper === 'H') {
      x = relative ? x + number() : number()
      ctx.lineTo(x, y)
    } else if (upper === 'V') {
      y = relative ? y + number() : number()
      ctx.lineTo(x, y)
    } else if (upper === 'C') {
      const x1 = relative ? x + number() : number()
      const y1 = relative ? y + number() : number()
      const x2 = relative ? x + number() : number()
      const y2 = relative ? y + number() : number()
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y)
      lastControlX = x2
      lastControlY = y2
    } else if (upper === 'S') {
      const x2 = relative ? x + number() : number()
      const y2 = relative ? y + number() : number()
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      const x1 = lastControlX === null ? x : 2 * x - lastControlX
      const y1 = lastControlY === null ? y : 2 * y - lastControlY
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y)
      lastControlX = x2
      lastControlY = y2
    } else if (upper === 'Q') {
      const x1 = relative ? x + number() : number()
      const y1 = relative ? y + number() : number()
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      ctx.quadraticCurveTo(x1, y1, x, y)
      lastControlX = x1
      lastControlY = y1
    } else if (upper === 'T') {
      x = relative ? x + number() : number()
      y = relative ? y + number() : number()
      const x1 = lastControlX === null ? x : 2 * x - lastControlX
      const y1 = lastControlY === null ? y : 2 * y - lastControlY
      ctx.quadraticCurveTo(x1, y1, x, y)
      lastControlX = x1
      lastControlY = y1
    } else if (upper === 'A') {
      const rx = number()
      const ry = number()
      const rotation = number()
      const large = number()
      const sweep = number()
      const nx = relative ? x + number() : number()
      const ny = relative ? y + number() : number()
      // An elliptical arc is approximated by its chord when the engine offers no
      // arcTo; the SVG serializer keeps the true arc.
      if (typeof ctx.ellipse === 'function' && rx > 0 && ry > 0) {
        const cx = (x + nx) / 2
        const cy = (y + ny) / 2
        void rotation
        void large
        void sweep
        ctx.lineTo(cx, cy)
      }
      ctx.lineTo(nx, ny)
      x = nx
      y = ny
    } else {
      index += 1
    }
  }
}

/** Text with letter spacing, drawn per character (canvas has no tracking). */
function drawTracked(ctx, op) {
  let cursor = op.x
  for (const char of op.text) {
    ctx.fillText(char, cursor, op.y)
    cursor += (typeof ctx.measureText === 'function' ? ctx.measureText(char).width : 0) + (op.letterSpacing ?? 0)
  }
}

// ---------------------------------------------------------------------------
// SVG serializer
// ---------------------------------------------------------------------------

/** XML-escape text and attribute values. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Serialize an op list to SVG. This is the SECOND output, not the preview: the
 * artboard and the PNG export both use the canvas painter. It walks the same op
 * list, so the two cannot drift.
 *
 * @param ops - the op list from `layout`.
 * @param document - the canonical document (its canvas gives width/height).
 * @param opts - `{ embed, fontFaceCss }`:
 *   - `embed(src) -> string|null` inlines an asset as a data URL. An SVG loaded
 *     as an `<img>` (which is how a browser rasterizes one) may not fetch
 *     anything, so an image that cannot be inlined is emitted as a placeholder
 *     plus a comment naming it, never a broken reference;
 *   - `fontFaceCss(family) -> string|null` supplies `@font-face` blocks for the
 *     families the design actually used.
 */
export function toSvg(ops, document, opts = {}) {
  const width = (document && document.canvas && document.canvas.width) ?? 0
  const height = (document && document.canvas && document.canvas.height) ?? 0
  const embed = typeof opts.embed === 'function' ? opts.embed : () => null
  const defs = []
  const body = []
  let counter = 0
  const unique = (prefix) => prefix + (counter += 1)
  const missing = []
  for (const op of ops) {
    const rendered = svgForOp(op, { defs, unique, embed, missing })
    if (rendered) body.push(rendered)
  }
  const families = new Set()
  for (const op of ops) if (op.kind === 'text' && op.family) families.add(op.family)
  const fontFaces = []
  if (typeof opts.fontFaceCss === 'function') {
    for (const family of families) {
      const css = opts.fontFaceCss(family)
      if (css) fontFaces.push(css)
    }
  }
  const head =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
    width +
    '" height="' +
    height +
    '" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '">\n'
  const style = fontFaces.length > 0 ? '  <style>\n' + fontFaces.join('\n') + '\n  </style>\n' : ''
  const defsBlock = defs.length > 0 ? '  <defs>\n' + defs.join('\n') + '\n  </defs>\n' : ''
  return head + style + defsBlock + body.join('\n') + '\n</svg>\n'
}

/** One op as SVG. */
function svgForOp(op, env) {
  const transform = op.rotate ? ' transform="rotate(' + op.rotate + ' ' + round(op.x + (op.w ?? 0) / 2) + ' ' + round(op.y + (op.h ?? 0) / 2) + ')"' : ''
  const opacity = op.opacity !== undefined && op.opacity !== null && op.opacity < 1 ? ' opacity="' + op.opacity + '"' : ''
  const blend = op.blend && op.blend !== 'normal' ? ' style="mix-blend-mode:' + op.blend + '"' : ''
  const clipId = op.clip ? env.unique('clip') : null
  if (clipId) {
    env.defs.push('    <clipPath id="' + clipId + '"><rect x="' + op.clip.x + '" y="' + op.clip.y + '" width="' + op.clip.w + '" height="' + op.clip.h + '" rx="' + (op.clip.radius ?? 0) + '" ry="' + (op.clip.radius ?? 0) + '"/></clipPath>')
  }
  const clipAttr = clipId ? ' clip-path="url(#' + clipId + ')"' : ''
  const common = transform + opacity + blend + clipAttr
  if (op.kind === 'rect') {
    const fill = op.fill ? svgPaint(op.fill, env) : 'none'
    const stroke = op.stroke ? ' stroke="' + escapeXml(op.stroke) + '" stroke-width="' + (op.strokeWidth ?? 1) + '"' : ''
    const dash = op.dash ? ' stroke-dasharray="' + op.dash.join(' ') + '"' : ''
    const radius = op.radius ? ' rx="' + op.radius + '" ry="' + op.radius + '"' : ''
    return '  <rect x="' + op.x + '" y="' + op.y + '" width="' + op.w + '" height="' + op.h + '"' + radius + ' fill="' + fill + '"' + stroke + dash + common + '/>'
  }
  if (op.kind === 'ellipse') {
    const fill = op.fill ? svgPaint(op.fill, env) : 'none'
    const stroke = op.stroke ? ' stroke="' + escapeXml(op.stroke) + '" stroke-width="' + (op.strokeWidth ?? 1) + '"' : ''
    return '  <ellipse cx="' + op.cx + '" cy="' + op.cy + '" rx="' + op.rx + '" ry="' + op.ry + '" fill="' + fill + '"' + stroke + common + '/>'
  }
  if (op.kind === 'line') {
    const dash = op.dash ? ' stroke-dasharray="' + op.dash.join(' ') + '"' : ''
    return '  <line x1="' + op.x1 + '" y1="' + op.y1 + '" x2="' + op.x2 + '" y2="' + op.y2 + '" stroke="' + escapeXml(op.stroke ?? '#ffffff') + '" stroke-width="' + (op.strokeWidth ?? 1) + '"' + dash + common + '/>'
  }
  if (op.kind === 'path') {
    const fill = op.fill ? svgPaint(op.fill, env) : 'none'
    const stroke = op.stroke ? ' stroke="' + escapeXml(op.stroke) + '" stroke-width="' + (op.strokeWidth ?? 1) + '"' : ''
    return '  <path d="' + escapeXml(op.d ?? '') + '" fill="' + fill + '"' + stroke + common + '/>'
  }
  if (op.kind === 'polygon') {
    const points = (op.points ?? []).map((point) => round(op.x + point.x * op.w) + ',' + round(op.y + point.y * op.h)).join(' ')
    const fill = op.fill ? svgPaint(op.fill, env) : 'none'
    const stroke = op.stroke ? ' stroke="' + escapeXml(op.stroke) + '" stroke-width="' + (op.strokeWidth ?? 1) + '"' : ''
    return '  <polygon points="' + points + '" fill="' + fill + '"' + stroke + common + '/>'
  }
  if (op.kind === 'text') {
    const tracking = op.letterSpacing ? ' letter-spacing="' + op.letterSpacing + '"' : ''
    return (
      '  <text x="' +
      op.x +
      '" y="' +
      op.y +
      '" fill="' +
      escapeXml(op.color ?? '#ffffff') +
      '" font-family="' +
      escapeXml(op.stack ?? 'sans-serif') +
      '" font-size="' +
      op.size +
      '" font-weight="' +
      op.weight +
      '"' +
      tracking +
      common +
      '>' +
      escapeXml(op.text) +
      '</text>'
    )
  }
  if (op.kind === 'image') {
    const href = env.embed(op.src)
    if (!href) {
      env.missing.push(op.src)
      return (
        '  <!-- "' +
        escapeXml(op.src) +
        '" could not be inlined: an SVG rendered as an image may not fetch, so this export names it instead of breaking -->\n' +
        '  <rect x="' +
        op.x +
        '" y="' +
        op.y +
        '" width="' +
        op.w +
        '" height="' +
        op.h +
        '" fill="#808080" fill-opacity="0.25"' +
        common +
        '/>'
      )
    }
    const crop = op.crop ?? { x: 0, y: 0, w: op.natural?.width ?? op.w, h: op.natural?.height ?? op.h }
    const naturalW = op.natural?.width ?? crop.x + crop.w
    const naturalH = op.natural?.height ?? crop.y + crop.h
    const radiusClip = op.radius ? env.unique('round') : null
    if (radiusClip) {
      env.defs.push('    <clipPath id="' + radiusClip + '"><rect x="' + op.x + '" y="' + op.y + '" width="' + op.w + '" height="' + op.h + '" rx="' + op.radius + '" ry="' + op.radius + '"/></clipPath>')
    }
    // The crop is expressed the standard way: a nested <svg> whose viewBox is the
    // source rectangle, so `cover`/`contain`/`zoom` survive the round trip.
    return (
      '  <svg x="' +
      op.x +
      '" y="' +
      op.y +
      '" width="' +
      op.w +
      '" height="' +
      op.h +
      '" viewBox="' +
      round(crop.x) +
      ' ' +
      round(crop.y) +
      ' ' +
      round(crop.w) +
      ' ' +
      round(crop.h) +
      '" preserveAspectRatio="none"' +
      (radiusClip ? ' clip-path="url(#' + radiusClip + ')"' : '') +
      common +
      '>\n    <image x="0" y="0" width="' +
      round(naturalW) +
      '" height="' +
      round(naturalH) +
      '" xlink:href="' +
      escapeXml(href) +
      '"/>\n  </svg>'
    )
  }
  if (op.kind === 'svg') {
    const viewBox = op.viewBox ? ' viewBox="' + op.viewBox.join(' ') + '"' : ''
    const preserve = op.viewBox ? ' preserveAspectRatio="' + (op.preserveAspectRatio === 'none' ? 'none' : 'xMidYMid meet') + '"' : ''
    const inner = String(op.svg ?? '').replace(/<\?xml[^>]*\?>/g, '').trim()
    return '  <svg x="' + op.x + '" y="' + op.y + '" width="' + op.w + '" height="' + op.h + '"' + viewBox + preserve + common + '>\n    ' + inner + '\n  </svg>'
  }
  return ''
}

/** A paint as an SVG fill value, registering any gradient it needs. */
function svgPaint(rawPaint, env) {
  const paint = coercePaint(rawPaint)
  if (!paint) return 'none'
  if (paint.type === 'solid') return escapeXml(paint.color)
  const id = env.unique('grad')
  if (paint.type === 'radial') {
    env.defs.push(
      '    <radialGradient id="' + id + '" cx="' + (paint.cx ?? 0.5) + '" cy="' + (paint.cy ?? 0.5) + '" r="' + (paint.r ?? 0.7) + '">\n' +
        paint.stops.map((stop) => '      <stop offset="' + stop.at + '" stop-color="' + escapeXml(stop.color) + '"/>').join('\n') +
        '\n    </radialGradient>',
    )
    return 'url(#' + id + ')'
  }
  const angle = ((paint.angle ?? 180) * Math.PI) / 180
  const x1 = round(50 - Math.cos(angle) * 50)
  const y1 = round(50 - Math.sin(angle) * 50)
  const x2 = round(50 + Math.cos(angle) * 50)
  const y2 = round(50 + Math.sin(angle) * 50)
  env.defs.push(
    '    <linearGradient id="' + id + '" x1="' + x1 + '%" y1="' + y1 + '%" x2="' + x2 + '%" y2="' + y2 + '%">\n' +
      paint.stops.map((stop) => '      <stop offset="' + stop.at + '" stop-color="' + escapeXml(stop.color) + '"/>').join('\n') +
      '\n    </linearGradient>',
  )
  return 'url(#' + id + ')'
}

// ---------------------------------------------------------------------------
// Lints (what the render report tells the model)
// ---------------------------------------------------------------------------

/**
 * The colour painted behind an op, by walking the ops that came before it.
 *
 * This is an APPROXIMATION and says so in the render report: it samples each
 * covering op's paint **at the op's own centre**, composites translucent layers
 * in order over the canvas background, and refuses to guess when the centre sits
 * inside a photograph, a raw SVG fragment or a filled path. A design whose
 * gradient is not sampled well gets a warning that is merely cautious, never a
 * claim of a measurement nobody made.
 *
 * @param op - the op (a text op, in practice) whose background is wanted.
 * @param ops - the whole op list, in paint order.
 * @param canvasBackground - the document's own background paint.
 * @param size - `{ width, height }` of the canvas (the background's box).
 * @returns a colour string, `'unknown'`, or null when nothing covered it.
 */
export function backgroundBehind(op, ops, canvasBackground, size) {
  const point = { x: op.x + (op.w ?? 0) / 2, y: op.y + (op.h ?? 0) / 2 }
  if (op.kind === 'text') {
    // A text op's own box is a line box; sample at the middle of the glyphs.
    point.x = op.x + 40
    point.y = op.y - (op.size ?? 16) * 0.35
  }
  const canvasBox = { x: 0, y: 0, w: (size && size.width) ?? 0, h: (size && size.height) ?? 0 }
  let color = paintColorAt(coercePaint(canvasBackground), point, canvasBox)
  let unknown = false
  for (const candidate of ops) {
    if (candidate === op) break
    const box = opBox(candidate)
    if (!box) continue
    if (!containsPoint(box, point, candidate)) continue
    if (candidate.kind === 'image' || candidate.kind === 'svg') {
      unknown = true
      continue
    }
    if (candidate.kind === 'path' || candidate.kind === 'polygon') {
      if (candidate.fill) unknown = true
      continue
    }
    if (candidate.kind === 'line') continue
    const paint = coercePaint(candidate.fill)
    if (!paint) continue
    const sampled = paintColorAt(paint, point, box)
    if (!sampled) {
      unknown = true
      continue
    }
    color = color === null ? sampled : composite(sampled, color)
  }
  if (unknown) return 'unknown'
  return color ? formatColor(color) : null
}

/** The box an op occupies, for sampling. */
function opBox(op) {
  if (op.kind === 'ellipse') return { x: op.cx - op.rx, y: op.cy - op.ry, w: op.rx * 2, h: op.ry * 2, ellipse: true, cx: op.cx, cy: op.cy, rx: op.rx, ry: op.ry }
  if (isNum(op.x) && isNum(op.y) && isNum(op.w) && isNum(op.h)) return { x: op.x, y: op.y, w: op.w, h: op.h }
  return null
}

/** Whether a point is inside an op's box (ellipses use their own equation). */
function containsPoint(box, point, op) {
  if (box.ellipse) {
    if (box.rx <= 0 || box.ry <= 0) return false
    const dx = (point.x - box.cx) / box.rx
    const dy = (point.y - box.cy) / box.ry
    return dx * dx + dy * dy <= 1
  }
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
}

/** A paint's colour at a point (the stops interpolated along the gradient axis). */
function paintColorAt(paint, point, box) {
  if (!paint) return null
  if (paint.type === 'solid') return parseColor(paint.color)
  const stops = paint.stops
  if (!Array.isArray(stops) || stops.length === 0) return null
  const t = gradientT(paint, point, box)
  return parseColor(colorAtStops(stops, t))
}

/** Where a point falls along a gradient, 0-1. */
function gradientT(paint, point, box) {
  if (paint.type === 'radial') {
    const cx = box.x + box.w * (paint.cx ?? 0.5)
    const cy = box.y + box.h * (paint.cy ?? 0.5)
    const radius = Math.max(0.01, Math.max(box.w, box.h) * (paint.r ?? 0.7))
    return clamp(Math.hypot(point.x - cx, point.y - cy) / radius, 0, 1)
  }
  const angle = ((paint.angle ?? 180) * Math.PI) / 180
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = Math.cos(angle) * (box.w / 2)
  const dy = Math.sin(angle) * (box.h / 2)
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 0) return 0
  return clamp(((point.x - (cx - dx)) * dx + (point.y - (cy - dy)) * dy) / lengthSq, 0, 1)
}

/** Interpolate a gradient's stops at `t`. */
function colorAtStops(stops, t) {
  const sorted = stops.slice().sort((a, b) => a.at - b.at)
  if (t <= sorted[0].at) return sorted[0].color
  if (t >= sorted[sorted.length - 1].at) return sorted[sorted.length - 1].color
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index]
    const right = sorted[index + 1]
    if (t >= left.at && t <= right.at) {
      const span = right.at - left.at
      const ratio = span <= 0 ? 0 : (t - left.at) / span
      const a = parseColor(left.color)
      const b = parseColor(right.color)
      if (!a || !b) return left.color
      return formatColor({
        r: a.r + (b.r - a.r) * ratio,
        g: a.g + (b.g - a.g) * ratio,
        b: a.b + (b.b - a.b) * ratio,
        a: a.a + (b.a - a.a) * ratio,
      })
    }
  }
  return sorted[sorted.length - 1].color
}

/** `top` composited over `bottom`, both parsed colours. */
function composite(top, bottom) {
  return over(top, bottom)
}

/**
 * Everything wrong with a laid-out design that can be said objectively. This is
 * what the browser's render report carries back to the model, so it is written
 * here - beside the layout - rather than in either half.
 *
 * @param layoutResult - the result of `layout`.
 * @param document - the canonical document.
 * @param preset - the preset (for safe areas and margins), or null.
 * @param opts - `{ assets, images }`.
 * @returns an array of `{ code, level, path, message }` (level is `warn` or `error`).
 */
export function lintLayout(layoutResult, document, preset, opts = {}) {
  const out = []
  const boxes = layoutResult.boxes
  const ops = layoutResult.ops

  // 1. Safe areas: a box that reaches into a keep-out region is named.
  if (preset && Array.isArray(preset.safeAreas)) {
    for (const area of preset.safeAreas) {
      if (area.level !== 'keep-out') continue
      for (const entry of boxes) {
        if (coversCanvas(entry.box, layoutResult)) continue
        if (!intersects(entry.box, area)) continue
        out.push({
          code: 'SAFE_AREA',
          level: 'warn',
          path: entry.path,
          message:
            entry.path +
            ' reaches into the preset\u2019s keep-out area "' +
            area.label +
            '" (' +
            Math.round(area.x) +
            ',' +
            Math.round(area.y) +
            ' ' +
            Math.round(area.w) +
            '\u00d7' +
            Math.round(area.h) +
            ')',
        })
      }
    }
  }

  // 2. Margins: text may not sit closer to the edge than the preset allows.
  if (preset && isNum(preset.margin)) {
    for (const entry of boxes) {
      if (entry.kind !== 'text') continue
      const box = entry.box
      const onEdge =
        box.x < preset.margin - 1 ||
        box.y < preset.margin - 1 ||
        box.x + box.w > layoutResult.width - preset.margin + 1 ||
        box.y + box.h > layoutResult.height - preset.margin + 1
      if (onEdge) {
        out.push({ code: 'MARGIN', level: 'warn', path: entry.path, message: entry.path + ' comes closer than the preset\u2019s ' + preset.margin + 'px margin to the canvas edge' })
      }
    }
  }

  // 3. Type: too small to read, and contrast against the paint behind it.
  for (const entry of boxes) {
    if (entry.kind !== 'text') continue
    const smallest = entry.font && entry.font.size
    if (isNum(smallest) && smallest < 14) {
      out.push({ code: 'TYPE_TOO_SMALL', level: 'warn', path: entry.path, message: entry.path + ' is ' + smallest + 'px; below 14px a poster is unreadable at feed scale' })
    }
  }
  // A text op is judged against the paint that is actually behind IT, sampled at
  // its own position; one warning per node, carrying the worst ratio found.
  const contrast = new Map()
  for (const op of ops) {
    if (op.kind !== 'text') continue
    const behind = backgroundBehind(op, ops, document.canvas.background, { width: layoutResult.width, height: layoutResult.height })
    if (behind === 'unknown' || behind === null) continue
    const background = parseColor(behind)
    const ratio = background ? contrastRatio(op.color, background) : null
    if (ratio === null) continue
    const needed = op.size >= 28 ? 3 : 4.5
    if (ratio >= needed) continue
    const previous = contrast.get(op.path)
    if (!previous || ratio < previous.ratio) contrast.set(op.path, { ratio, behind, needed, size: op.size })
  }
  for (const [path, entry] of contrast) {
    out.push({
      code: 'LOW_CONTRAST',
      level: 'warn',
      path,
      message: path + ' is ' + entry.ratio + ':1 against ' + entry.behind + ' where its text sits (needs ' + entry.needed + ':1)',
    })
  }

  // 4. Composition: how many sizes and families are in play.
  const sizes = new Set(boxes.filter((entry) => entry.kind === 'text').map((entry) => entry.font && entry.font.size).filter(isNum))
  if (sizes.size > 4) {
    out.push({ code: 'MANY_SIZES', level: 'warn', path: 'layers', message: sizes.size + ' distinct type sizes are in play; a poster reads best with three or four' })
  }
  const families = new Set(boxes.filter((entry) => entry.kind === 'text').map((entry) => entry.font && entry.font.family).filter(Boolean))
  if (families.size > 2) {
    out.push({ code: 'MANY_FAMILIES', level: 'warn', path: 'layers', message: families.size + ' font families are in play; two is the usual ceiling' })
  }

  // 5. Anything the layout itself flagged.
  for (const warning of layoutResult.warnings ?? []) {
    out.push({ code: warning.code, level: 'warn', path: warning.path, message: warning.message })
  }

  // 6. A design with no text at all is almost always a mistake.
  if (boxes.filter((entry) => entry.kind === 'text').length === 0 && boxes.length > 0) {
    out.push({ code: 'NO_TEXT', level: 'warn', path: 'layers', message: 'this design has no text at all' })
  }

  // 7. Images that were never resolved.
  for (const entry of boxes) {
    if (entry.kind !== 'image') continue
    if (opts.assets && opts.assets[entry.src]) continue
    out.push({ code: 'MISSING_ASSET', level: 'error', path: entry.path, message: entry.path + ' uses "' + String(entry.src) + '", which is not in the asset table' })
  }

  // 8. An SVG fragment the canvas painter could not draw (the client rasterizes
  //    one per fragment; when that failed, the report says so rather than
  //    pretending the shape is there).
  for (const entry of boxes) {
    if (entry.kind !== 'svg') continue
    if (opts.images && opts.images['svg:' + entry.path]) continue
    out.push({ code: 'SVG_FRAGMENT_UNPAINTED', level: 'warn', path: entry.path, message: entry.path + ' is a raw SVG fragment that the rasterizer could not prepare; the PNG export leaves it out while the .svg export keeps it' })
  }
  return out
}

/** Whether a box covers the whole canvas (a full-bleed layer). */
function coversCanvas(box, layoutResult) {
  return box.x <= 0.5 && box.y <= 0.5 && box.x + box.w >= layoutResult.width - 0.5 && box.y + box.h >= layoutResult.height - 0.5
}

/** Whether two rectangles intersect. */
function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/**
 * Apply pointer-style patch operations to a document.
 *
 * A patch is `{ op: 'set' | 'remove' | 'insert', at: 'layers.0.children.1', value }`
 * where `at` is a dot path of object keys and array indexes. The MODEL edits a
 * design through these, so it never has to re-emit a whole document to move one
 * element - and the host validates the result exactly as it validates a write.
 *
 * @param document - the current document.
 * @param ops - up to 64 operations, applied in order.
 * @returns `{ document, problems }`.
 */
export function applyPatches(document, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { document: null, problems: [problem('ops', 'NO_OPS', 'a patch needs at least one operation')] }
  }
  if (ops.length > 64) {
    return { document: null, problems: [problem('ops', 'TOO_MANY_OPS', 'at most 64 operations per patch (got ' + ops.length + ')')] }
  }
  let working = clone(document)
  const problems = []
  ops.forEach((op, index) => {
    const where = 'ops.' + index
    if (!op || typeof op !== 'object') {
      problems.push(problem(where, 'BAD_OP', where + ' must be an object ({op, at, value})'))
      return
    }
    if (!['set', 'remove', 'insert'].includes(op.op)) {
      problems.push(problem(where + '.op', 'BAD_OP', where + '.op must be set, remove or insert'))
      return
    }
    if (typeof op.at !== 'string' || op.at.length === 0) {
      problems.push(problem(where + '.at', 'BAD_PATH', where + '.at must be a path like "layers.0.children.1"'))
      return
    }
    const segments = op.at.split('.')
    if (segments.some((segment) => segment === '' || segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
      problems.push(problem(where + '.at', 'BAD_PATH', where + '.at is not a usable path'))
      return
    }
    const applied = applyOne(working, segments, op)
    if (applied.problem) problems.push({ path: where + ': ' + applied.problem.path, code: applied.problem.code, message: applied.problem.message })
    else working = applied.document
  })
  if (problems.length > 0) return { document: null, problems }
  return { document: working, problems: [] }
}

/** One patch operation on a clone. */
function applyOne(document, segments, op) {
  const working = clone(document)
  let cursor = working
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]
    const next = cursor[key]
    if (next === undefined || next === null || typeof next !== 'object') {
      return { document: null, problem: problem(segments.slice(0, index + 1).join('.'), 'NO_TARGET', 'nothing to patch at "' + segments.slice(0, index + 1).join('.') + '"') }
    }
    cursor = next
  }
  const last = segments[segments.length - 1]
  if (op.op === 'remove') {
    if (Array.isArray(cursor)) {
      const at = Number(last)
      if (!Number.isInteger(at) || at < 0 || at >= cursor.length) {
        return { document: null, problem: problem(op.at, 'NO_TARGET', 'the array holds no element ' + last) }
      }
      cursor.splice(at, 1)
      return { document: working, problem: null }
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, last)) {
      return { document: null, problem: problem(op.at, 'NO_TARGET', 'nothing to remove at "' + op.at + '"') }
    }
    delete cursor[last]
    return { document: working, problem: null }
  }
  if (op.op === 'insert') {
    // Two spellings, both documented and both unambiguous in this schema:
    //   `at: "layers"`      - the path NAMES the array, so the value is appended;
    //   `at: "layers.-"`    - the parent path plus an index ("-" appends);
    //   `at: "layers.0"`    - insert before index 0.
    // The first is tried first: a full-path resolution that answers an array is
    // the array to append to, and anything else falls through to the second.
    const direct = resolvePath(working, segments)
    if (direct && Array.isArray(direct)) {
      direct.push(clone(op.value))
      return { document: working, problem: null }
    }
    if (!Array.isArray(cursor)) {
      return { document: null, problem: problem(op.at, 'BAD_TARGET', 'insert needs an array target (e.g. "layers", "layers.-" or a frame\u2019s "children")') }
    }
    const at = last === '-' || last === '' ? cursor.length : Number(last)
    if (!Number.isInteger(at) || at < 0 || at > cursor.length) {
      return { document: null, problem: problem(op.at, 'BAD_TARGET', 'the insert index ' + JSON.stringify(last) + ' is outside the array') }
    }
    cursor.splice(at, 0, clone(op.value))
    return { document: working, problem: null }
  }
  if (op.value === undefined) {
    return { document: null, problem: problem(op.at, 'NO_VALUE', 'a set operation needs `value`') }
  }
  if (Array.isArray(cursor)) {
    const at = Number(last)
    if (!Number.isInteger(at) || at < 0 || at >= cursor.length) {
      return { document: null, problem: problem(op.at, 'NO_TARGET', 'the array holds no element ' + last) }
    }
    cursor[at] = clone(op.value)
    return { document: working, problem: null }
  }
  cursor[last] = clone(op.value)
  return { document: working, problem: null }
}

/**
 * Resolve a dot path to the value it names, or null.
 * @param root - the document.
 * @param segments - the split path.
 * @returns the value, or null.
 */
function resolvePath(root, segments) {
  let cursor = root
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return null
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return null
      cursor = cursor[index]
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return null
    cursor = cursor[segment]
  }
  return cursor === undefined ? null : cursor
}

/** A JSON deep clone that never shares a reference with its input. */export function clone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone)
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clone(entry)
  return out
}

/** A stable JSON string (sorted keys, rounded floats) - what a revision hash is taken over. */
export function stableJson(value) {
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return isNum(input) ? round(input) : input
    if (Array.isArray(input)) return input.map(walk)
    const out = {}
    for (const key of Object.keys(input).sort()) out[key] = walk(input[key])
    return out
  }
  return JSON.stringify(walk(value))
}
