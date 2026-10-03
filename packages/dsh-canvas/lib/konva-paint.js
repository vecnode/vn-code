/**
 * dsh-canvas — THE KONVA PAINTER.
 *
 * This is the file that makes the Canvas tab a KONVA EDITOR rather than a canvas that
 * happens to have Konva listening to it. It takes the list of draw operations the engine's
 * layout produced and turns each one into a REAL KONVA NODE: a `Konva.Rect`, a
 * `Konva.Ellipse`, a `Konva.Line`, a `Konva.Path`, a `Konva.Image`, and a `Konva.Shape`
 * whose `sceneFunc` draws a line of text. The stage that holds them is the artboard.
 *
 * WHY IT LIVES IN ITS OWN FILE, with zero static imports. The same bargain `engine.js`
 * makes: the browser imports this from a blob URL (so it can never reach into the shell's
 * module table), it is a plain file served by this package's own route, and a check can
 * fetch and import it directly. It also keeps `client.js` - which is already the largest
 * file in the pack - from growing a second painter inside it.
 *
 * WHY IT REPLAYS OPS INSTEAD OF WALKING THE DOCUMENT. The engine already owns layout: it
 * resolves tokens, measures and wraps text, and produces boxes in DESIGN pixels. A second
 * walk of the document here would be a second layout, and the two would disagree the first
 * time a word wrapped. So this file knows ONE thing - how an operation becomes a Konva node
 * - and the picture it produces is the picture the export produces, for the same reason.
 *
 * THE ENGINE IS STILL THE REFERENCE PAINTER, and that is deliberate rather than timid:
 * `check-canvas-browser.mjs` renders the same design through both painters and compares the
 * pixels, so "Konva draws what the engine drew" is a MEASUREMENT rather than a hope. Where
 * the two differ, the difference is a bug in this file, not a matter of taste.
 *
 * TEXT IS DRAWN BY THE ENGINE'S OWN RULES, inside a Konva node. A `Konva.Text` would wrap,
 * measure and baseline the string its own way - a second text engine beside the one that
 * produced the op, and the exact drift this pack refuses - so a text op becomes a
 * `Konva.Shape` whose `sceneFunc` makes the same `fillText` call the engine makes, at the
 * same baseline, with the same per-character tracking. The node is still a Konva node:
 * it can be selected, transformed, cached and exported.
 */

/** Every op kind this painter knows, so a caller can assert the list and not guess. */
export const KONVA_PAINT_KINDS = ['rect', 'ellipse', 'line', 'polygon', 'path', 'text', 'image', 'svg']

/** A stop list as Konva wants it: `[at, color, at, color, ...]`, clamped to 0..1. */
function stopsOf(paint) {
  const stops = Array.isArray(paint.stops) ? paint.stops : []
  const flat = []
  for (const stop of stops) {
    const at = Math.max(0, Math.min(1, typeof stop.at === 'number' ? stop.at : 0))
    flat.push(at, stop.color)
  }
  return flat
}

/**
 * The FILL of a node, as Konva props, in the node's OWN local space.
 *
 * The engine paints a linear gradient from an angle measured across the box and a radial one
 * from a fractional centre with the radius scaled by the box's longer side, and it computes
 * those points in ABSOLUTE design pixels. Konva takes explicit points too, but in the SHAPE'S
 * LOCAL SPACE - and what that space's origin is depends on the shape:
 *
 *   - a `Konva.Rect` (or an Image) is placed AT its top-left, so its local origin is (x, y);
 *   - a `Konva.Ellipse` is placed at its CENTRE, so its local origin is (cx, cy) - the bug
 *     this painter's parity check caught first: every ellipse gradient was offset by its own
 *     radii, which is a fully saturated difference across half a blob;
 *   - a `Konva.Path` and a `Konva.Line` are drawn from the coordinates inside their own data
 *     (absolute, in this op list) with the node at (0, 0), so their local origin IS the
 *     canvas origin and the points stay absolute.
 *
 * `origin` is that offset, and the arithmetic above is done once, absolutely, then moved into
 * the shape's own space - which is what makes a gradient land where the engine put it.
 */
function fillProps(paint, box, origin) {
  if (!paint) return {}
  if (typeof paint === 'string') return { fill: paint }
  if (paint.type === 'solid') return { fill: paint.color }
  const ox = origin && Number.isFinite(origin.x) ? origin.x : 0
  const oy = origin && Number.isFinite(origin.y) ? origin.y : 0
  if (paint.type === 'radial') {
    const width = box.w ?? 0
    const height = box.h ?? 0
    const cx = (box.x ?? 0) + width * (paint.cx ?? 0.5)
    const cy = (box.y ?? 0) + height * (paint.cy ?? 0.5)
    const radius = Math.max(0.01, Math.max(width, height) * (paint.r ?? 0.7))
    return {
      fillRadialGradientStartPoint: { x: cx - ox, y: cy - oy },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndPoint: { x: cx - ox, y: cy - oy },
      fillRadialGradientEndRadius: radius,
      fillRadialGradientColorStops: stopsOf(paint),
    }
  }
  const angle = ((paint.angle ?? 180) * Math.PI) / 180
  const halfW = (box.w ?? 0) / 2
  const halfH = (box.h ?? 0) / 2
  const cx = (box.x ?? 0) + halfW
  const cy = (box.y ?? 0) + halfH
  const dx = Math.cos(angle) * halfW
  const dy = Math.sin(angle) * halfH
  return {
    fillLinearGradientStartPoint: { x: cx - dx - ox, y: cy - dy - oy },
    fillLinearGradientEndPoint: { x: cx + dx - ox, y: cy + dy - oy },
    fillLinearGradientColorStops: stopsOf(paint),
  }
}

/** The stroke props, and only when the engine would have stroked at all. */
function strokeProps(op) {
  if (!op.stroke || !(op.strokeWidth > 0)) return {}
  const props = { stroke: op.stroke, strokeWidth: op.strokeWidth }
  if (Array.isArray(op.dash) && op.dash.length > 0) props.dash = op.dash
  return props
}

/**
 * The props EVERY op carries, whatever its kind: opacity, blend mode and shadow - the
 * three the engine applies around the op rather than inside it.
 */
function commonProps(op) {
  const props = {}
  if (typeof op.opacity === 'number' && op.opacity < 1) props.opacity = Math.max(0, op.opacity)
  if (op.blend && op.blend !== 'normal') props.globalCompositeOperation = op.blend
  if (op.shadow) {
    props.shadowColor = op.shadow.color
    props.shadowBlur = op.shadow.blur
    props.shadowOffsetX = op.shadow.x
    props.shadowOffsetY = op.shadow.y
  }
  if (op.rotate) {
    // THE ENGINE TURNS A BOX ABOUT ITS CENTRE (`paintCanvas` translates to the centre,
    // rotates, translates back). Konva turns a node about its origin, so the node is placed
    // by its centre with an offset of half its size - the same point, reached Konva's way.
    const width = Number.isFinite(op.w) ? op.w : 0
    const height = Number.isFinite(op.h) ? op.h : 0
    props.rotation = op.rotate
    props.offsetX = width / 2
    props.offsetY = height / 2
    props.x = (Number.isFinite(op.x) ? op.x : op.cx ?? 0) + width / 2
    props.y = (Number.isFinite(op.y) ? op.y : op.cy ?? 0) + height / 2
  }
  return props
}

/** A rounded-rectangle path, the shape the engine clips and rounds with. */
function roundedPath(context, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius ?? 0, Math.min(Math.abs(w), Math.abs(h)) / 2))
  context.beginPath()
  if (r <= 0) {
    context.rect(x, y, w, h)
    context.closePath()
    return
  }
  context.moveTo(x + r, y)
  context.lineTo(x + w - r, y)
  context.arcTo(x + w, y, x + w, y + r, r)
  context.lineTo(x + w, y + h - r)
  context.arcTo(x + w, y + h, x + w - r, y + h, r)
  context.lineTo(x + r, y + h)
  context.arcTo(x, y + h, x, y + h - r, r)
  context.lineTo(x, y + r)
  context.arcTo(x, y, x + r, y, r)
  context.closePath()
}

/**
 * ONE OP, as a Konva node.
 *
 * @returns a `Konva.Node`, or null for a kind this painter does not know (or an image whose
 *   bytes never arrived - the engine skips that too, and `lintLayout` reports it).
 */
export function opToKonva(konva, op, images) {
  if (!op || typeof op !== 'object') return null
  const box = { x: op.x ?? 0, y: op.y ?? 0, w: op.w ?? 0, h: op.h ?? 0 }
  const common = commonProps(op)
  let node = null
  if (op.kind === 'rect') {
    node = new konva.Rect({
      x: Number.isFinite(common.x) ? common.x : op.x,
      y: Number.isFinite(common.y) ? common.y : op.y,
      width: op.w,
      height: op.h,
      cornerRadius: op.radius ?? 0,
      ...(op.fill ? fillProps(op.fill, box, { x: op.x, y: op.y }) : {}),
      ...strokeProps(op),
    })
  } else if (op.kind === 'ellipse') {
    node = new konva.Ellipse({
      x: op.cx,
      y: op.cy,
      radiusX: Math.max(0, op.rx),
      radiusY: Math.max(0, op.ry),
      ...(op.fill ? fillProps(op.fill, { x: op.cx - op.rx, y: op.cy - op.ry, w: op.rx * 2, h: op.ry * 2 }, { x: op.cx, y: op.cy }) : {}),
      ...strokeProps(op),
    })
  } else if (op.kind === 'line') {
    node = new konva.Line({ points: [op.x1, op.y1, op.x2, op.y2], stroke: op.stroke ?? '#ffffff', strokeWidth: op.strokeWidth ?? 1, ...(Array.isArray(op.dash) && op.dash.length > 0 ? { dash: op.dash } : {}) })
  } else if (op.kind === 'polygon') {
    const points = []
    for (const point of op.points ?? []) points.push(op.x + point.x * op.w, op.y + point.y * op.h)
    node = new konva.Line({
      points,
      closed: true,
      ...(op.fill ? fillProps(op.fill, box, { x: 0, y: 0 }) : {}),
      ...strokeProps(op),
    })
  } else if (op.kind === 'path') {
    node = new konva.Path({ data: op.d, ...(op.fill ? fillProps(op.fill, box, { x: 0, y: 0 }) : { fill: undefined }), ...strokeProps(op) })
  } else if (op.kind === 'image' || op.kind === 'svg') {
    const image = op.kind === 'image' ? (images ?? {})[op.src] : (images ?? {})['svg:' + op.path]
    if (!image) return null
    const crop = op.kind === 'image' ? op.crop : null
    node = new konva.Image({
      x: op.x,
      y: op.y,
      width: op.w,
      height: op.h,
      image,
      cornerRadius: op.radius ?? 0,
      ...(crop && crop.w > 0 && crop.h > 0 ? { crop: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } } : {}),
    })
  } else if (op.kind === 'text') {
    // THE ENGINE'S OWN TEXT RULES, in a Konva node: the same font shorthand, the same
    // baseline, the same per-character tracking when the op asks for it. `listening` is left
    // to the caller.
    node = new konva.Shape({
      sceneFunc(context) {
        context.setAttr('font', op.font)
        context.setAttr('fillStyle', op.color ?? '#ffffff')
        context.setAttr('textAlign', 'start')
        context.setAttr('textBaseline', 'alphabetic')
        if (op.letterSpacing) {
          let cursor = op.x
          for (const character of String(op.text ?? '')) {
            context.fillText(character, cursor, op.y)
            const measured = typeof context.measureText === 'function' ? context.measureText(character).width : 0
            cursor += measured + op.letterSpacing
          }
          return
        }
        context.fillText(op.text, op.x, op.y)
      },
      // A HIT REGION, so the node can be picked like any other: the text's own line box,
      // measured with the same font the paint uses.
      hitFunc(context) {
        context.setAttr('font', op.font)
        const measured = typeof context.measureText === 'function' ? context.measureText(String(op.text ?? '')).width : 0
        const size = 16
        context.beginPath()
        context.rect(op.x, op.y - size, Math.max(1, measured), size * 1.4)
        context.closePath()
        context.fillStrokeShape(this)
      },
    })
  } else {
    return null
  }
  if (!node) return null
  // The rotation/offset/centre props LAST, because they reposition the node: applying them
  // before the kind-specific geometry would be overwritten by it.
  node.setAttrs(common)
  // A CLIP IS THE ENGINE'S ROUNDED RECTANGLE around the op, so the node is wrapped in a
  // group that carries it: Konva clips with a function, and this is the same path.
  if (op.clip) {
    const group = new konva.Group({
      clipFunc(context) {
        roundedPath(context, op.clip.x, op.clip.y, op.clip.w, op.clip.h, op.clip.radius ?? 0)
      },
    })
    group.add(node)
    return group
  }
  return node
}

/**
 * THE WHOLE OP LIST, as Konva nodes in paint order.
 *
 * Order is the picture: a later op paints over an earlier one, and Konva draws children in
 * the order they were added - so this array is the document's own layering, handed over
 * unchanged.
 */
export function opsToKonva(konva, ops, images) {
  const nodes = []
  for (const op of ops ?? []) {
    const node = opToKonva(konva, op, images)
    if (node) nodes.push(node)
  }
  return nodes
}

/**
 * A STAGE that holds one prepared design, at a given scale.
 *
 * This is the ONE entry point both the artboard and the export use, which is what makes
 * "what the model reads is what the person sees" structural instead of aspirational: the
 * artboard builds a stage on screen at the zoom, and the export builds one OFF screen at
 * the file's own scale, from the same op list, with the same nodes.
 *
 * @returns `{ stage, layer, nodes }`. The caller owns the stage and must destroy it.
 */
export function stageFor(konva, container, prepared, options = {}) {
  const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1
  const listening = options.listening === true
  const stage = new konva.Stage({
    container: container ?? undefined,
    width: Math.max(1, Math.round((prepared?.width ?? 1) * scale)),
    height: Math.max(1, Math.round((prepared?.height ?? 1) * scale)),
  })
  stage.scale({ x: scale, y: scale })
  const layer = new konva.Layer({ listening })
  stage.add(layer)
  const nodes = opsToKonva(konva, prepared?.ops ?? [], prepared?.images ?? {})
  for (const node of nodes) layer.add(node)
  layer.draw()
  return { stage, layer, nodes }
}
