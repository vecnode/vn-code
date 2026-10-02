/**
 * dsh-canvas — DESIGN SETS: one design, derived to the sizes a launch actually needs.
 *
 * A repository needs a social preview, a square for a post and an Open Graph card; a
 * product needs a banner and a story. They are the SAME design, and typing it three
 * times is how a family drifts apart - one card gets the old headline, another keeps a
 * colour the palette moved on from.
 *
 * So a set is a SOURCE and a list of destinations, and the derivation is a pure
 * function of the source document and the target preset:
 *
 *   - every NUMBER in the document is multiplied by the width ratio (positions, sizes,
 *     radii, padding, gaps, borders, letter spacing, shadows, and the type scale), so
 *     the composition keeps its proportions and its optical rhythm;
 *   - the type scale is clamped to the language's own limits, so a small destination
 *     cannot produce unreadable type and a print size cannot overflow a node;
 *   - the result is centred in the taller canvas rather than stretched into it, which
 *     is what a designer does with a square: keep the design, add the room.
 *
 * What it deliberately does NOT do is re-compose. A design made for 1280x640 dropped
 * onto a 1200x1200 canvas keeps its proportions and gains margin; if a destination
 * needs a different ARRANGEMENT, that is a different archetype and a different design,
 * not a derivation. The lints and the render are what tell the two apart.
 */
import { LIMITS, clone } from './engine.js'
import { PRESETS } from './presets.js'

/**
 * The sets that ship. `source` is the preset the design was made for; `targets` are
 * the destinations it can be derived to, in the order they are written out.
 */
export const SETS = [
  {
    id: 'launch',
    title: 'Launch set',
    intent: 'A launch that has to exist in three places at once: the repository card, the square post and the link preview.',
    source: 'github-social',
    targets: ['github-social', 'linkedin-square', 'og'],
  },
  {
    id: 'social',
    title: 'Social set',
    intent: 'One announcement across the social destinations this package knows, so the family looks deliberate everywhere it lands.',
    source: 'github-social',
    targets: ['github-social', 'linkedin-post', 'x-post', 'og'],
  },
  {
    id: 'repository',
    title: 'Repository set',
    intent: 'A project header and the card that links to it, derived from the same design so the two can never disagree.',
    source: 'github-readme',
    targets: ['github-readme', 'github-social'],
  },
]

/** One set by id, or null. */
export function setById(id) {
  const wanted = String(id ?? '')
  return SETS.find((entry) => entry.id === wanted) ?? null
}

/** The sets as rows for the state route and the index. */
export function setGallery() {
  return SETS.map((entry) => ({
    id: entry.id,
    title: entry.title,
    intent: entry.intent,
    source: entry.source,
    targets: entry.targets.slice(),
    sizes: entry.targets.map((id) => {
      const preset = PRESETS[id]
      return preset ? preset.width + '\u00d7' + preset.height : id
    }),
  }))
}

/** A number, scaled and kept inside a range. */
function scaled(value, ratio, min, max) {
  if (typeof value !== 'number') return value
  const next = Math.round(value * ratio)
  return Math.max(min, Math.min(max, next))
}

/** Padding is a number, [t, r, b, l] or {top,right,bottom,left}. */
function scalePadding(padding, ratio) {
  if (typeof padding === 'number') return scaled(padding, ratio, 0, LIMITS.maxPadding)
  if (Array.isArray(padding)) return padding.map((value) => scaled(value, ratio, 0, LIMITS.maxPadding))
  if (padding && typeof padding === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(padding)) out[key] = scaled(value, ratio, 0, LIMITS.maxPadding)
    return out
  }
  return padding
}

/** Every number a node carries, multiplied. */
function scaleNode(node, ratio, depth) {
  if (depth === 0) {
    if (typeof node.x === 'number') node.x = Math.max(0, Math.round(node.x * ratio))
    if (typeof node.y === 'number') node.y = Math.max(0, Math.round(node.y * ratio))
  } else {
    if (typeof node.x === 'number') node.x = Math.round(node.x * ratio)
    if (typeof node.y === 'number') node.y = Math.round(node.y * ratio)
  }
  if (typeof node.w === 'number') node.w = Math.max(1, Math.round(node.w * ratio))
  if (typeof node.h === 'number') node.h = Math.max(1, Math.round(node.h * ratio))
  if (typeof node.radius === 'number' && node.radius < 100) node.radius = scaled(node.radius, ratio, 0, LIMITS.maxRadius)
  if (node.padding !== undefined) node.padding = scalePadding(node.padding, ratio)
  if (typeof node.gap === 'number') node.gap = Math.round(node.gap * ratio)
  if (typeof node.size === 'number') node.size = scaled(node.size, ratio, 6, LIMITS.maxFontSize)
  if (typeof node.letterSpacing === 'number') node.letterSpacing = Math.round(node.letterSpacing * ratio * 10) / 10
  if (typeof node.strokeWidth === 'number') node.strokeWidth = Math.max(0, Math.round(node.strokeWidth * ratio))
  if (node.border && typeof node.border.width === 'number') node.border = { ...node.border, width: Math.max(0, Math.round(node.border.width * ratio)) }
  if (node.shadow && typeof node.shadow === 'object') {
    node.shadow = {
      ...node.shadow,
      ...(typeof node.shadow.x === 'number' ? { x: Math.round(node.shadow.x * ratio) } : {}),
      ...(typeof node.shadow.y === 'number' ? { y: Math.round(node.shadow.y * ratio) } : {}),
      ...(typeof node.shadow.blur === 'number' ? { blur: Math.round(node.shadow.blur * ratio) } : {}),
    }
  }
  for (const child of node.children ?? []) scaleNode(child, ratio, depth + 1)
}

/**
 * Derive one document for one destination preset.
 *
 * @param document - the source, canonical.
 * @param targetPresetId - the destination.
 * @returns `{ document, ratio, offsetY, notes }` or `{ error }`.
 */
export function deriveFor(document, targetPresetId) {
  const target = PRESETS[targetPresetId]
  if (!target) return { error: { code: 'UNKNOWN_PRESET', message: 'unknown destination ' + JSON.stringify(targetPresetId) } }
  const sourceWidth = document.canvas ? document.canvas.width : 0
  const sourceHeight = document.canvas ? document.canvas.height : 0
  if (!sourceWidth || !sourceHeight) return { error: { code: 'NO_CANVAS', message: 'the source design has no canvas' } }
  const ratio = target.width / sourceWidth
  const out = clone(document)
  const fullBleedWidths = new Set()
  out.preset = target.id
  out.canvas = { ...out.canvas, width: target.width, height: target.height }
  const notes = []
  // The type scale is the one place a linear scale is not enough: a caption that was
  // 15px in a 1280-wide card is 14px in a 1200-wide one, and 15px is already the floor
  // for a feed. It is rounded up to a whole pixel so a card never lands on 14.4px.
  if (out.tokens && out.tokens.scale) {
    const scale = {}
    for (const [name, value] of Object.entries(out.tokens.scale)) {
      scale[name] = scaled(value, ratio, 6, LIMITS.maxFontSize)
    }
    out.tokens.scale = scale
  }
  if (out.tokens && out.tokens.radius) {
    const radius = {}
    for (const [name, value] of Object.entries(out.tokens.radius)) radius[name] = value >= 100 ? value : scaled(value, ratio, 0, LIMITS.maxRadius)
    out.tokens.radius = radius
  }
  for (const layer of out.layers ?? []) scaleNode(layer, ratio, 0)

  // A full-bleed layer follows the CANVAS, not the composition: a background that
  // stopped short of the edge would be a stripe. Everything else keeps its place
  // relative to everything else, which is what makes a derived design recognisably the
  // same design.
  const scaledWidth = Math.round(sourceWidth * ratio)
  for (const layer of out.layers ?? []) {
    if (typeof layer.w === 'number' && Math.abs(layer.w - scaledWidth) <= 2) {
      layer.x = 0
      layer.w = target.width
      fullBleedWidths.add(layer)
    }
  }
  notes.push('full-bleed layers widened to the destination canvas')
  const scaledHeight = Math.round(sourceHeight * ratio)
  const offsetY = target.height > scaledHeight ? Math.round((target.height - scaledHeight) / 2) : 0
  if (offsetY !== 0) {
    // A full-bleed backdrop follows the CANVAS, not the composition: a background that
    // stopped 40px short of the edge would be a stripe, not a background.
    for (const layer of out.layers ?? []) {
      const fullBleed = typeof layer.h === 'number' && typeof layer.w === 'number' && Math.abs(layer.h - scaledHeight) <= 2
      if (fullBleed) {
        layer.h = target.height
        layer.y = 0
        continue
      }
      if (typeof layer.y === 'number') layer.y = layer.y + offsetY
    }
    notes.push('centred in the taller canvas (offset ' + offsetY + 'px)')
  }
  if (ratio !== 1) notes.push('every number \u00d7' + (Math.round(ratio * 1000) / 1000))
  notes.push(target.width + '\u00d7' + target.height + ' from ' + sourceWidth + '\u00d7' + sourceHeight)
  return { document: out, ratio, offsetY, notes }
}

/**
 * Derive a whole set.
 *
 * @returns `{ rows: [{ preset, document, notes }], error? }` - every destination, in
 *   the order the set names them, or an error naming the first one that failed.
 */
export function deriveSet(document, setId) {
  const set = setById(setId)
  if (!set) return { error: { code: 'UNKNOWN_SET', message: 'unknown set ' + JSON.stringify(setId) } }
  const rows = []
  for (const target of set.targets) {
    const derived = deriveFor(document, target)
    if (derived.error) return { error: derived.error }
    rows.push({ preset: target, document: derived.document, ratio: derived.ratio, notes: derived.notes })
  }
  return { rows, set }
}
