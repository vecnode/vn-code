/**
 * dsh-canvas — the STYLE LIBRARY, and the transform that applies one.
 *
 * The package ships two things a design is built from, and they are deliberately
 * separate:
 *
 *   - **Archetypes** (`lib/archetypes/`) are COMPOSITIONS: where the words, the
 *     panels and the art sit on a preset's canvas.
 *   - **Styles** (`lib/styles/<id>.json`) are LOOKS: the palette, the type
 *     behaviour, the shape language, the surface treatment, and the rules a
 *     designer follows when using them.
 *
 * A style is DATA, not code, so a person can read it, diff it and add one without
 * touching the engine - and applying it is one PURE function, which is what makes
 * "re-style this design" a safe operation rather than a rewrite.
 *
 * ## What "applying a style" means, precisely
 *
 * `applyStyle` changes how a design LOOKS and never where anything is. Geometry
 * (`x`, `y`, `w`, `h`, the flow inside frames) is untouched: a style that moved
 * things would be a second composition, which is what archetypes are for.
 *
 *   1. **Tokens.** Colour roles are replaced, and every colour LITERAL in the
 *      document that was one of the old role values is rewritten to the new value
 *      for that role. That is the whole trick: a canonical document has literals
 *      everywhere (that is what canonical means), so a style has to remap by ROLE,
 *      and the old role values are the map.
 *   2. **Type.** The family roles, the display weight and tracking, the line
 *      height, and a scale FACTOR applied as a delta against the style the design
 *      was last styled with - so applying the same style twice is a no-op and
 *      switching styles back and forth returns the original type sizes exactly.
 *   3. **Shape and surface.** The radius scale, the border weight and colour, the
 *      shadow, the canvas background and the art treatment (which generator to
 *      prefer, at what opacity).
 *   4. **Nothing else.** A style cannot change a document's preset, its layers'
 *      count or order, or any text.
 *
 * ## What it cannot do, and says so
 *
 * The language has no blur, so a "glassy" style is translucent panels plus a
 * hairline plus a soft shadow rather than a real backdrop filter; a style whose
 * `surface` note says that is telling the truth rather than pretending. The same
 * goes for gradients on text and for anything else the node kinds do not have.
 */
import { clone, formatColor, parseColor } from '../engine.js'

/** The colour roles a style may set, in the order a swatch shows them. */
export const STYLE_ROLES = ['surface', 'panel', 'ink', 'muted', 'accent', 'accent-ink', 'line', 'warm']

/** A colour value as a canonical literal. */
function literal(value) {
  const parsed = typeof value === 'string' ? parseColor(value) : null
  return parsed ? formatColor(parsed) : null
}

/**
 * The colour map a style implies: every role the document ALREADY has, paired with
 * the style's value for that role. A role the style does not name keeps the
 * document's own value, so a style can be partial without erasing a palette.
 *
 * @param document - the canonical document being restyled.
 * @param style - the style pack.
 * @returns `{ palette, map }` - the new token block and the literal-to-literal map.
 */
export function colourPlan(document, style) {
  const oldPalette = (document.tokens && document.tokens.color) || {}
  const palette = { ...oldPalette }
  const map = new Map()
  // A role the style leaves ALONE must leave its tints alone too. That is what
  // makes the whole transform idempotent: on a second application every role is
  // unchanged, so every tint is unchanged, and the document is a fixed point.
  const untouched = new Set()
  for (const [role, value] of Object.entries(style.color ?? {})) {
    const to = literal(value) ?? (typeof value === 'string' && oldPalette[value] ? oldPalette[value] : null)
    if (!to) continue
    const from = literal(oldPalette[role])
    palette[role] = to
    if (from === to) {
      untouched.add(role)
      continue
    }
    if (from && from !== to) map.set(from, to)
  }
  // A style may also say "this role is the same as that one" (a hairline that is
  // the muted ink at 30%, say) - resolved above through the palette lookup.
  return { palette, map, oldPalette, untouched, surface: palette.surface }
}

/** Rewrite one colour through the map, RE-TINTING anything that is not a role value. */
function remap(value, map, plan) {
  if (typeof value !== 'string') return value
  const key = literal(value)
  if (!key) return value
  if (map.has(key)) return map.get(key)
  if (!plan) return value
  return retint(key, plan) ?? value
}

/** Relative luminance (WCAG) of a parsed colour, 0..1. */
function luminance(colour) {
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b)
}

/** Hue in degrees, and saturation 0..1. */
function hueSat(colour) {
  const r = colour.r / 255
  const g = colour.g / 255
  const b = colour.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return { hue: 0, sat: 0 }
  let hue
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return { hue, sat: max === 0 ? 0 : delta / max }
}

/** How far apart two hues are, 0..180. */
function hueGap(a, b) {
  const raw = Math.abs(a - b) % 360
  return raw > 180 ? 360 - raw : raw
}

/**
 * Re-tint a literal that is NOT one of the old role values.
 *
 * A design written by hand carries colours that are not the palette: a lighter
 * tint of the accent behind a highlighted word (`#A9BBFF` where the accent is
 * `#4d6bfe`), a slightly dimmed ink, a hairline half a step off. Remapping only the
 * exact role values would leave those behind, and on a light style a pale tint that
 * was legible on near-black is invisible - a real design failure, not a cosmetic
 * one.
 *
 * The rule is deliberately simple and explainable:
 *
 *   1. Find the OLD role this colour is nearest to - by hue first (a tint keeps its
 *      role's hue) and then by lightness, with greys matched to greys.
 *   2. Take that role's NEW colour as the base.
 *   3. Push the base the SAME WAY the base already sits relative to the new surface
 *      - toward white when the base is lighter than the surface, toward black when
 *      it is darker - by how far the original sat from its own role.
 *
 * So a highlight stays a highlight, a dim note stays dim, and both stay legible
 * whether the style is light or dark. It never fires for a colour that IS a role
 * value, so the palette itself is always exact.
 */
function retint(key, plan) {
  const { palette, oldPalette, surface } = plan
  const colour = parseColor(key)
  if (!colour) return null
  const target = hueSat(colour)
  let best = null
  for (const [role, oldValue] of Object.entries(oldPalette)) {
    const old = parseColor(oldValue)
    if (!old) continue
    const from = hueSat(old)
    // A grey has no hue worth matching on; two greys match on lightness alone.
    const hueScore = target.sat < 0.08 || from.sat < 0.08 ? (target.sat < 0.08 && from.sat < 0.08 ? 0 : 90) : hueGap(target.hue, from.hue)
    if (hueScore > 40) continue
    const distance = hueScore + Math.abs(luminance(colour) - luminance(old)) * 60
    if (!best || distance < best.distance) best = { distance, role, old, oldLuma: luminance(old) }
  }
  if (!best) return null
  // A role this style did not change keeps its tints: the identity case, and the
  // reason applying the same style twice is a no-op rather than a slow drift.
  if (plan.untouched && plan.untouched.has(best.role)) return key
  const newValue = palette[best.role]
  const base = parseColor(newValue)
  if (!base) return null
  const baseLuma = luminance(base)
  const fromSurface = luminance(colour) - best.oldLuma
  if (Math.abs(fromSurface) < 0.01) return formatColor(base)
  const toward = baseLuma >= (surface ?? 0) ? 1 : -1
  const amount = Math.min(0.85, Math.abs(fromSurface) * 1.8)
  const mix = (channel, to) => Math.round(channel + (to - channel) * amount)
  const target255 = toward > 0 ? 255 : 0
  return formatColor({ r: mix(base.r, target255), g: mix(base.g, target255), b: mix(base.b, target255), a: base.a })
}

/** Rewrite a paint (a solid, a gradient, or an art fill). */
function remapPaint(paint, map, plan) {
  if (!paint || typeof paint !== 'object') return paint
  if (paint.type === 'solid') return { ...paint, color: remap(paint.color, map, plan) }
  if (Array.isArray(paint.stops)) return { ...paint, stops: paint.stops.map((stop) => ({ ...stop, color: remap(stop.color, map, plan) })) }
  return paint
}

/** The style a document was last styled with, or null. */
function previousStyle(document, styles) {
  if (!document || typeof document.style !== 'string') return null
  return styles[document.style] ?? null
}

/**
 * Apply one style to a canonical document.
 *
 * @param document - a document from `normalizeDocument` (canonical). It is NOT
 *   mutated: the result is a clone.
 * @param style - the style pack (`lib/styles/<id>.json`).
 * @param options - `{ styles }` - the whole table, needed only to read the factor
 *   of the style the document already carries (so a switch is a delta, not a
 *   compound). Without it a switch still works; re-applying the SAME style twice
 *   would then multiply twice, which is why the table is passed everywhere in the
 *   package.
 * @returns `{ document, notes }` - the restyled clone and what the transform did,
 *   as lines a person or a model can read.
 */
export function applyStyle(document, style, options = {}) {
  if (!document || typeof document !== 'object') throw new Error('applyStyle needs a document')
  if (!style || typeof style.id !== 'string') throw new Error('applyStyle needs a style pack')
  const styles = options.styles ?? {}
  const notes = []
  const out = clone(document)
  const plan = colourPlan(document, style)
  const { palette, map } = plan
  // The re-tint context: the surface the design now sits on, so a colour that is
  // not a role value is pushed the way its role already sits relative to it.
  plan.surface = luminance(parseColor(palette.surface) ?? { r: 255, g: 255, b: 255, a: 1 })
  const fix = (value) => remap(value, map, plan)
  const fixPaint = (paint) => remapPaint(paint, map, plan)
  out.tokens = { ...(out.tokens ?? {}), color: palette }

  // ---- type ---------------------------------------------------------------
  const previous = previousStyle(document, styles)
  const oldFactor = previous && previous.scale && typeof previous.scale.factor === 'number' ? previous.scale.factor : 1
  const newFactor = style.scale && typeof style.scale.factor === 'number' ? style.scale.factor : 1
  const delta = oldFactor === 0 ? 1 : newFactor / oldFactor
  if (delta !== 1) {
    const scale = {}
    for (const [name, value] of Object.entries(out.tokens.scale ?? {})) {
      const next = Math.round(value * delta)
      scale[name] = Math.max(6, Math.min(400, next))
    }
    out.tokens.scale = scale
    notes.push('type scale \u00d7' + (Math.round(delta * 100) / 100) + ' (the style\u2019s own factor, applied against the last one, so switching back restores the sizes)')
  }
  if (style.font) {
    out.tokens.font = { ...(out.tokens.font ?? {}), ...style.font }
    notes.push('families: ' + Object.values(style.font).join(', '))
  }
  if (style.space !== undefined) out.tokens.space = style.space
  if (style.radius) {
    out.tokens.radius = { ...(out.tokens.radius ?? {}), ...style.radius }
    notes.push('radius scale replaced')
  }
  if (style.color) notes.push('palette replaced (' + Object.keys(style.color).join(', ') + '), and every literal that was a role value remapped to its new role')

  // ---- the canvas surface -------------------------------------------------
  if (style.background) {
    // A surface the STYLE names is already the new palette resolved: it must not go
    // through the old->new remap, or the style's own colour would be re-tinted as if
    // it were the document's (which is how a light style's own background came out
    // near-black, and why applying a style twice was not a no-op).
    const background = resolveSurface(style.background, palette)
    out.canvas = { ...out.canvas, background }
  } else {
    out.canvas = { ...out.canvas, background: fixPaint(out.canvas.background) }
  }

  // ---- the layers ---------------------------------------------------------
  const borderWeight = style.border && typeof style.border.weight === 'number' ? style.border.weight : null
  const borderColour = style.border ? resolveRef(style.border.color, palette) : null
  const shadow = style.shadow && style.shadow.kind && style.shadow.kind !== 'none' ? style.shadow : null
  const preferredArt = Array.isArray(style.art && style.art.preferred) ? style.art.preferred : null
  const artOpacity = style.art && typeof style.art.opacity === 'number' ? style.art.opacity : null
  let restyledArt = 0
  let replacedSurface = 0

  const restyleNode = (node, depth) => {
    if (!node || typeof node !== 'object') return
    if (node.color) node.color = fix(node.color)
    if (Array.isArray(node.runs)) node.runs = node.runs.map((run) => (run.color ? { ...run, color: fix(run.color) } : run))
    if (node.fill) node.fill = fixPaint(node.fill)
    if (node.background) node.background = fixPaint(node.background)
    if (node.stroke) node.stroke = fix(node.stroke)
    if (node.shadow && node.shadow.color) node.shadow = { ...node.shadow, color: fix(node.shadow.color) }
    if (node.scrimColor) node.scrimColor = fix(node.scrimColor)
    if (Array.isArray(node.colors)) node.colors = node.colors.map((color) => fix(color))

    if (node.kind === 'text' && (node.style === 'display' || node.style === 'title')) {
      if (style.scale && typeof style.scale.displayWeight === 'number') node.weight = style.scale.displayWeight
      if (style.scale && typeof style.scale.displayTracking === 'number') node.letterSpacing = style.scale.displayTracking
      if (style.scale && typeof style.scale.lineHeight === 'number') node.lineHeight = style.scale.lineHeight
    }
    if (node.kind === 'frame' || node.kind === 'shape') {
      if (style.radius && typeof node.radius === 'number') {
        // The radius is snapped to the CLOSEST value in the style's scale, which is
        // a projection: a value already in the scale maps to itself, so a second
        // application changes nothing - a pill included, because a style may well
        // set its pill to something square, and that IS its shape language.
        const isPill = node.radius >= 100
        const values = [style.radius.card, style.radius.chip].filter((value) => typeof value === 'number')
        const declared = [style.radius.card, style.radius.chip, style.radius.pill].filter((value) => typeof value === 'number')
        if (declared.includes(node.radius)) {
          // Already one of this style's own radii: nothing to do.
        } else if (isPill) {
          if (typeof style.radius.pill === 'number') node.radius = style.radius.pill
        } else if (values.length > 0) {
          node.radius = values.reduce((best, value) => (Math.abs(value - node.radius) < Math.abs(best - node.radius) ? value : best))
        }
      }
      // The style's border and shadow belong to a PANEL, not to every box. A frame
      // filled with the surface or the panel colour is a panel and takes the style's
      // edge; a frame filled with the accent is a BUTTON, and giving it a dark
      // hairline and a glow is how a pill ends up looking notched. The fills are
      // already remapped at this point, so they are compared against the palette.
      if (node.border && borderWeight !== null) {
        node.border = { ...node.border, width: borderWeight, color: borderColour ?? node.border.color }
      } else if (!node.border && borderWeight !== null && borderWeight > 0 && depth === 0 && isPanel(node, palette)) {
        node.border = { width: borderWeight, color: borderColour ?? palette.line ?? palette.muted ?? palette.ink }
        replacedSurface += 1
      } else if (node.border && borderColour) {
        node.border = { ...node.border, color: borderColour }
      }
      if (style.shadow) {
        if (node.shadow) node.shadow = shadowSpec(style.shadow, palette)
        else if (depth === 0 && isPanel(node, palette)) node.shadow = shadowSpec(style.shadow, palette)
      }
    }
    if (node.kind === 'art') {
      if (preferredArt && preferredArt.length > 0) node.style = preferredArt[0]
      if (artOpacity !== null) node.opacity = artOpacity
      restyledArt += 1
    }
    for (const child of node.children ?? []) restyleNode(child, depth + 1)
  }
  for (const layer of out.layers ?? []) restyleNode(layer, 0)
  if (restyledArt > 0) notes.push(restyledArt + ' art layer(s) switched to the style\u2019s own generator')
  if (replacedSurface > 0) notes.push(replacedSurface + ' top-level panel(s) given the style\u2019s border and shadow')

  out.style = style.id
  return { document: out, notes }
}

/**
 * Whether a node is a PANEL: a frame whose own fill is the style's surface or panel
 * colour. That is the box a border and a shadow belong to - not a chip, not a rule,
 * not a button painted in the accent.
 */
function isPanel(node, palette) {
  if (!node || node.kind !== 'frame' || !node.background || node.background.type !== 'solid') return false
  const fill = literal(node.background.color)
  if (!fill) return false
  return [palette.surface, palette.panel].filter(Boolean).map((colour) => literal(colour)).includes(fill)
}

/** A style's shadow spec as a node shadow. */
function shadowSpec(shadow, palette) {
  const colour = resolveRef(shadow.color, palette) ?? '#00000073'
  if (shadow.kind === 'hard') return { x: Number(shadow.x ?? 6), y: Number(shadow.y ?? 6), blur: 0, color: withAlpha(colour, shadow.alpha ?? 1) }
  if (shadow.kind === 'glow') return { x: 0, y: 0, blur: Number(shadow.blur ?? 48), color: withAlpha(colour, shadow.alpha ?? 0.55) }
  return { x: Number(shadow.x ?? 0), y: Number(shadow.y ?? 18), blur: Number(shadow.blur ?? 48), color: withAlpha(colour, shadow.alpha ?? 0.35) }
}

/** A colour with a new alpha, keeping it a literal. */
function withAlpha(value, alpha) {
  const parsed = parseColor(value)
  if (!parsed) return value
  return formatColor({ ...parsed, a: Math.max(0, Math.min(1, alpha)) })
}

/** A style value that names another role, resolved through the style's palette. */
function resolveRef(value, palette) {
  if (typeof value !== 'string') return value
  return palette[value] ?? value
}

/** A background spec: `{type:'solid', color:'surface'}` or a gradient or an art fill. */
function resolveSurface(spec, palette) {
  if (!spec || typeof spec !== 'object') return spec
  if (spec.type === 'solid') return { type: 'solid', color: resolveRef(spec.color, palette) }
  if (Array.isArray(spec.stops)) return { type: spec.type === 'radial' ? 'radial' : 'linear', angle: spec.angle ?? 160, stops: spec.stops.map((stop) => ({ at: stop.at, color: resolveRef(stop.color, palette) })) }
  if (spec.type === 'art') return { type: 'art', style: spec.style, colors: (spec.colors ?? []).map((colour) => resolveRef(colour, palette)), seed: spec.seed ?? 7, opacity: spec.opacity ?? 0.5 }
  return spec
}

/**
 * A style's swatch: five colours plus the family it sets, which is what a gallery
 * row needs to be recognisable without rendering anything.
 *
 * @param style - the style pack.
 * @returns `{ colours: string[], display: string, surface: string }`.
 */
export function styleSwatch(style) {
  const colours = []
  for (const role of ['surface', 'panel', 'ink', 'muted', 'accent', 'warm']) {
    const value = style.color ? style.color[role] : null
    const literalValue = literal(value)
    if (literalValue && !colours.includes(literalValue)) colours.push(literalValue)
  }
  return {
    colours: colours.slice(0, 6),
    display: (style.font && style.font.display) || 'Space Grotesk',
    surface: literal(style.color ? style.color.surface : null) ?? '#0b0e14',
  }
}

/** Whether a style declares everything the transform needs. */
export function styleProblems(style) {
  const problems = []
  if (!style || typeof style !== 'object') return ['a style must be a JSON object']
  if (typeof style.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(style.id)) problems.push('id must match /^[a-z0-9][a-z0-9-]{0,31}$/')
  if (typeof style.name !== 'string' || style.name.length === 0) problems.push('name is required')
  if (typeof style.intent !== 'string' || style.intent.length < 20) problems.push('intent should say what the style is FOR, in a sentence')
  if (!style.color || typeof style.color !== 'object' || Object.keys(style.color).length < 3) problems.push('color needs at least three roles (surface, ink, accent)')
  for (const [role, value] of Object.entries(style.color ?? {})) {
    if (!STYLE_ROLES.includes(role)) problems.push('unknown colour role "' + role + '" (known: ' + STYLE_ROLES.join(', ') + ')')
    else if (!literal(value) && !(style.color && typeof value === 'string' && style.color[value])) problems.push('colour role "' + role + '" is neither a colour nor another role name')
  }
  if (!style.font || typeof style.font !== 'object') problems.push('font roles are required (display, text, mono)')
  if (!style.scale || typeof style.scale.factor !== 'number') problems.push('scale.factor is required')
  if (!style.rules || !Array.isArray(style.rules.do) || !Array.isArray(style.rules.dont)) problems.push('rules.do and rules.dont are required')
  if (!Array.isArray(style.gates) || style.gates.length === 0) problems.push('at least one quality gate is required')
  return problems
}
