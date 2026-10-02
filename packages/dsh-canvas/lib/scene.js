/**
 * dsh-canvas — THE SCENE LANGUAGE.
 *
 * This is what an agent writes and what a person opens: a list of Excalidraw
 * SKELETONS (`{ type: 'rectangle', x, y, width, height, ... }`), the compact shape
 * Excalidraw's own `convertToExcalidrawElements` takes. The awkward part of that
 * choice is stated rather than hidden: skeletons cannot be EXPANDED here, because
 * expansion is Excalidraw's own code and it needs a browser. So the division is:
 *
 *   - the HOST owns the language: it validates, stores, patches and summarizes the
 *     skeletons, and it is the side the model talks to;
 *   - the BROWSER owns the materialization: `convertToExcalidrawElements` turns
 *     what the host validated into the elements the editor draws.
 *
 * That split is why this file is pure - no DOM, no fs, no network - and why every
 * refusal here carries a CODE the model can act on. A scene that validates is not a
 * picture (only a renderer can say that); it is a document that the editor will be
 * able to draw, which is the strongest claim the host can make alone.
 *
 * WHAT IS DELIBERATELY ABSENT. `image` is refused by name: an Excalidraw image
 * element needs a `fileId` and a matching entry in the scene's `files` map, and the
 * bytes would have to come from this package's asset route - so images land when
 * that route does, rather than as a half-implemented element the editor drops
 * silently. `frame` is allowed (it is a container Excalidraw understands).
 */

/** The element kinds this language accepts, and what each one must carry. */
export const SKELETON_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'freedraw', 'text', 'frame']
/** Named so a refusal can say WHY rather than "unknown type". */
export const REFUSED_TYPES = { image: 'an image element needs a files map and this package\u2019s asset route, which does not exist yet - draw a rectangle where the picture goes, or paste it into the editor by hand' }

export const SCENE_LIMITS = {
  elements: 400,
  textChars: 2000,
  labelChars: 500,
  points: 1000,
  coordinate: 200000,
  fontSize: { min: 4, max: 400 },
  strokeWidth: { min: 0, max: 64 },
  opacity: { min: 0, max: 100 },
  angle: { min: -360, max: 360 },
  roughness: { min: 0, max: 2 },
  nameChars: 120,
  patches: 64,
  patchDepth: 12,
}

/** Excalidraw's own defaults, applied when a skeleton leaves a field out. */
const DEFAULTS = { strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, angle: 0, fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', roundness: null }

/** Colours are hex or the one word Excalidraw accepts for "nothing painted". */
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/
const FILL_STYLES = ['solid', 'hachure', 'cross-hatch', 'zigzag']
const STROKE_STYLES = ['solid', 'dashed', 'dotted']
const TEXT_ALIGNS = ['left', 'center', 'right']
const VERTICAL_ALIGNS = ['top', 'middle', 'bottom']
const ARROWHEADS = [null, 'arrow', 'bar', 'dot', 'triangle']
/** The keys a skeleton may carry. An unknown key is REFUSED, not ignored: a field
 *  the host silently drops is a design the model believes it wrote. */
const ALLOWED_KEYS = new Set([
  'type', 'id', 'x', 'y', 'width', 'height', 'angle',
  'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness', 'seed',
  'text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign',
  'points', 'startArrowhead', 'endArrowhead',
  'label', 'frameId', 'name',
])

function fail(errors, path, code, message) {
  errors.push({ path, code, message })
  return errors
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate one skeleton in place-free fashion: `{ ok, errors, element }`.
 *
 * @param {unknown} input
 * @param {string} path  where it sits, so the model gets `elements.3.x`
 */
export function validateSkeleton(input, path = 'elements.0') {
  const errors = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(errors, path, 'ELEMENT_SHAPE', 'an element must be an object like { type: \'rectangle\', x, y, width, height }')
    return { ok: false, errors, element: null }
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(errors, path + '.' + key, 'ELEMENT_UNKNOWN_KEY', 'unknown field "' + key + '" - the editor would ignore it, so the host refuses it rather than storing a design you did not write')
    }
  }
  const type = input.type
  if (typeof type !== 'string' || type === '') {
    fail(errors, path + '.type', 'ELEMENT_TYPE', 'every element needs a type, one of: ' + SKELETON_TYPES.join(', '))
    return { ok: false, errors, element: null }
  }
  if (Object.prototype.hasOwnProperty.call(REFUSED_TYPES, type)) {
    fail(errors, path + '.type', 'ELEMENT_UNSUPPORTED', type + ': ' + REFUSED_TYPES[type])
    return { ok: false, errors, element: null }
  }
  if (!SKELETON_TYPES.includes(type)) {
    fail(errors, path + '.type', 'ELEMENT_TYPE', '"' + type + '" is not a kind this canvas draws; use one of: ' + SKELETON_TYPES.join(', '))
    return { ok: false, errors, element: null }
  }

  const element = { type }
  if (typeof input.id === 'string' && input.id.length > 0) element.id = input.id.slice(0, 64)
  if (typeof input.name === 'string' && input.name.length > 0) element.name = input.name.slice(0, SCENE_LIMITS.nameChars)
  // A frame's children name it, so the field is CARRIED rather than allowed and then
  // dropped: a key this validator accepts but does not keep is exactly the silent
  // loss that refusing unknown keys exists to prevent.
  if (input.frameId !== undefined) {
    if (typeof input.frameId !== 'string') fail(errors, path + '.frameId', 'ELEMENT_FRAME_ID', 'frameId must be the id of a frame in the same scene')
    else element.frameId = input.frameId.slice(0, 64)
  }

  // Geometry: required for every kind, and a shape with no size is a shape nobody
  // can click, so zero is refused for the drawable kinds while a line may be flat.
  for (const axis of ['x', 'y']) {
    const value = input[axis]
    if (value === undefined) element[axis] = 0
    else if (!isFiniteNumber(value)) fail(errors, path + '.' + axis, 'ELEMENT_NUMBER', axis + ' must be a number')
    else if (Math.abs(value) > SCENE_LIMITS.coordinate) fail(errors, path + '.' + axis, 'ELEMENT_RANGE', axis + ' is ' + value + '; keep it within \u00b1' + SCENE_LIMITS.coordinate)
    else element[axis] = value
  }
  for (const axis of ['width', 'height']) {
    const value = input[axis]
    if (value === undefined) element[axis] = type === 'text' || type === 'arrow' || type === 'line' || type === 'freedraw' ? 0 : 0
    else if (!isFiniteNumber(value)) fail(errors, path + '.' + axis, 'ELEMENT_NUMBER', axis + ' must be a number')
    else if (value < 0) fail(errors, path + '.' + axis, 'ELEMENT_SIZE', axis + ' cannot be negative')
    else if (value > SCENE_LIMITS.coordinate) fail(errors, path + '.' + axis, 'ELEMENT_RANGE', axis + ' is larger than ' + SCENE_LIMITS.coordinate)
    else element[axis] = value
  }
  if (element.width === 0 && element.height === 0 && (type === 'rectangle' || type === 'ellipse' || type === 'diamond' || type === 'frame')) {
    fail(errors, path, 'ELEMENT_SIZE', 'a ' + type + ' needs a width and a height - both are zero, so nothing would be drawn')
  }

  for (const [key, allowed] of [['strokeColor', COLOR_PATTERN], ['backgroundColor', COLOR_PATTERN]]) {
    const value = input[key]
    if (value === undefined) element[key] = DEFAULTS[key]
    else if (typeof value !== 'string' || !allowed.test(value)) fail(errors, path + '.' + key, 'ELEMENT_COLOR', key + ' must be a hex colour (#rgb, #rrggbb, #rrggbbaa) or "transparent"')
    else element[key] = value
  }
  if (input.fillStyle === undefined) element.fillStyle = DEFAULTS.fillStyle
  else if (!FILL_STYLES.includes(input.fillStyle)) fail(errors, path + '.fillStyle', 'ELEMENT_FILL_STYLE', 'fillStyle must be one of: ' + FILL_STYLES.join(', '))
  else element.fillStyle = input.fillStyle
  if (input.strokeStyle === undefined) element.strokeStyle = DEFAULTS.strokeStyle
  else if (!STROKE_STYLES.includes(input.strokeStyle)) fail(errors, path + '.strokeStyle', 'ELEMENT_STROKE_STYLE', 'strokeStyle must be one of: ' + STROKE_STYLES.join(', '))
  else element.strokeStyle = input.strokeStyle

  const numeric = [
    ['strokeWidth', input.strokeWidth, SCENE_LIMITS.strokeWidth, DEFAULTS.strokeWidth],
    ['opacity', input.opacity, SCENE_LIMITS.opacity, DEFAULTS.opacity],
    ['angle', input.angle, SCENE_LIMITS.angle, DEFAULTS.angle],
    ['roughness', input.roughness, SCENE_LIMITS.roughness, DEFAULTS.roughness],
  ]
  for (const [key, value, range, fallback] of numeric) {
    if (value === undefined) element[key] = fallback
    else if (!isFiniteNumber(value)) fail(errors, path + '.' + key, 'ELEMENT_NUMBER', key + ' must be a number')
    else if (value < range.min || value > range.max) fail(errors, path + '.' + key, 'ELEMENT_RANGE', key + ' must be between ' + range.min + ' and ' + range.max)
    else element[key] = value
  }
  if (input.roundness !== undefined) {
    // Excalidraw's own three spellings: `true` means "the default radius", `false`
    // and `null` mean sharp corners, and a number is an explicit radius. The object
    // form is what this validator EMITS, so it must also accept it - otherwise
    // `validate(normalize(x))` fails and a patch on a stored scene could never pass.
    // (The first cut refused `roundness: true` and the second refused its own
    // output; both were found by driving the pair, and the check now pins it.)
    if (input.roundness === true) element.roundness = { type: 3 }
    else if (input.roundness === null || input.roundness === false) element.roundness = null
    else if (isFiniteNumber(input.roundness) && input.roundness >= 0 && input.roundness <= 100) element.roundness = { type: 3 }
    else if (typeof input.roundness === 'object' && input.roundness !== null && [1, 2, 3].includes(input.roundness.type)) element.roundness = { type: input.roundness.type }
    else fail(errors, path + '.roundness', 'ELEMENT_RANGE', 'roundness is true, false, null, or a radius up to 100')
  } else element.roundness = DEFAULTS.roundness
  if (input.seed !== undefined) {
    if (!isFiniteNumber(input.seed)) fail(errors, path + '.seed', 'ELEMENT_NUMBER', 'seed must be a number')
    else element.seed = Math.trunc(input.seed)
  }

  if (type === 'text') {
    if (typeof input.text !== 'string') fail(errors, path + '.text', 'ELEMENT_TEXT', 'a text element needs its string in "text"')
    else if (input.text.length > SCENE_LIMITS.textChars) fail(errors, path + '.text', 'ELEMENT_TEXT_LONG', 'text is ' + input.text.length + ' characters; the cap is ' + SCENE_LIMITS.textChars)
    else element.text = input.text
    if (input.fontSize === undefined) element.fontSize = DEFAULTS.fontSize
    else if (!isFiniteNumber(input.fontSize)) fail(errors, path + '.fontSize', 'ELEMENT_NUMBER', 'fontSize must be a number')
    else if (input.fontSize < SCENE_LIMITS.fontSize.min || input.fontSize > SCENE_LIMITS.fontSize.max) {
      fail(errors, path + '.fontSize', 'ELEMENT_RANGE', 'fontSize must be between ' + SCENE_LIMITS.fontSize.min + ' and ' + SCENE_LIMITS.fontSize.max)
    } else element.fontSize = input.fontSize
    if (input.fontFamily === undefined) element.fontFamily = DEFAULTS.fontFamily
    else if (![1, 2, 3, 5, 6, 7, 8, 9].includes(input.fontFamily)) fail(errors, path + '.fontFamily', 'ELEMENT_FONT', 'fontFamily is one of 1 (hand-drawn), 2 (normal), 3 (code), 5-9 (the other faces the editor ships)')
    else element.fontFamily = input.fontFamily
    for (const [key, allowed] of [['textAlign', TEXT_ALIGNS], ['verticalAlign', VERTICAL_ALIGNS]]) {
      if (input[key] === undefined) element[key] = DEFAULTS[key]
      else if (!allowed.includes(input[key])) fail(errors, path + '.' + key, 'ELEMENT_ALIGN', key + ' must be one of: ' + allowed.join(', '))
      else element[key] = input[key]
    }
  }

  if (input.label !== undefined) {
    if (type !== 'rectangle' && type !== 'ellipse' && type !== 'diamond' && type !== 'arrow') {
      fail(errors, path + '.label', 'ELEMENT_LABEL', 'a label belongs on a rectangle, an ellipse, a diamond or an arrow')
    } else if (input.label === null || typeof input.label !== 'object' || typeof input.label.text !== 'string') {
      fail(errors, path + '.label', 'ELEMENT_LABEL', 'label must be { text: "..." }')
    } else if (input.label.text.length > SCENE_LIMITS.labelChars) {
      fail(errors, path + '.label.text', 'ELEMENT_LABEL_LONG', 'the label is ' + input.label.text.length + ' characters; the cap is ' + SCENE_LIMITS.labelChars)
    } else {
      const label = { text: input.label.text }
      if (input.label.fontSize !== undefined) {
        if (!isFiniteNumber(input.label.fontSize) || input.label.fontSize < SCENE_LIMITS.fontSize.min || input.label.fontSize > SCENE_LIMITS.fontSize.max) {
          fail(errors, path + '.label.fontSize', 'ELEMENT_RANGE', 'label.fontSize must be between ' + SCENE_LIMITS.fontSize.min + ' and ' + SCENE_LIMITS.fontSize.max)
        } else label.fontSize = input.label.fontSize
      }
      element.label = label
    }
  }

  if (type === 'arrow' || type === 'line' || type === 'freedraw') {
    const points = input.points
    if (points === undefined) fail(errors, path + '.points', 'ELEMENT_POINTS', 'a ' + type + ' needs "points": an array of [x, y] pairs, at least two of them')
    else if (!Array.isArray(points) || points.length < 2) fail(errors, path + '.points', 'ELEMENT_POINTS', 'points must be an array of [x, y] pairs with at least two entries')
    else if (points.length > SCENE_LIMITS.points) fail(errors, path + '.points', 'ELEMENT_POINTS_MANY', 'points holds ' + points.length + ' entries; the cap is ' + SCENE_LIMITS.points)
    else {
      const clean = []
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]
        if (!Array.isArray(point) || point.length !== 2 || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
          fail(errors, path + '.points.' + index, 'ELEMENT_POINTS', 'point ' + index + ' must be [x, y] with two numbers')
          continue
        }
        clean.push([point[0], point[1]])
      }
      if (clean.length === points.length) element.points = clean
    }
    for (const key of ['startArrowhead', 'endArrowhead']) {
      if (input[key] === undefined) continue
      if (!ARROWHEADS.includes(input[key])) fail(errors, path + '.' + key, 'ELEMENT_ARROWHEAD', key + ' must be null, arrow, bar, dot or triangle')
      else element[key] = input[key]
    }
  }

  return { ok: errors.length === 0, errors, element: errors.length === 0 ? element : null }
}

/**
 * Validate a whole scene. `presets` is the set of destination ids this host knows
 * (the export size and the safe areas still come from there), passed in so this file
 * stays free of the presets table.
 *
 * @returns `{ ok, errors, scene }` where `scene` is the NORMALIZED scene: defaults
 *          filled, coordinates rounded, unknown fields gone.
 */
export function validateScene(input, options = {}) {
  const errors = []
  const presetIds = options.presets ?? null
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(errors, '', 'SCENE_SHAPE', 'a scene is an object: { name, preset, elements: [...] }')
    return { ok: false, errors, scene: null }
  }
  const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null
  if (name === null) fail(errors, 'name', 'SCENE_NAME', 'a scene needs a name')
  else if (name.length > SCENE_LIMITS.nameChars) fail(errors, 'name', 'SCENE_NAME', 'the name is ' + name.length + ' characters; the cap is ' + SCENE_LIMITS.nameChars)
  const preset = typeof input.preset === 'string' ? input.preset : null
  if (preset === null) fail(errors, 'preset', 'SCENE_PRESET', 'a scene needs a preset: the export size and the safe areas come from it')
  else if (presetIds !== null && !presetIds.includes(preset)) fail(errors, 'preset', 'SCENE_PRESET', '"' + preset + '" is not a preset this host knows; call canvas_read with no id to list them')
  if (!Array.isArray(input.elements)) {
    fail(errors, 'elements', 'SCENE_ELEMENTS', 'elements must be an array of skeletons (it may be empty, which is a blank scene)')
    return { ok: false, errors, scene: null }
  }
  if (input.elements.length > SCENE_LIMITS.elements) {
    fail(errors, 'elements', 'SCENE_TOO_MANY', 'this scene has ' + input.elements.length + ' elements; the cap is ' + SCENE_LIMITS.elements)
  }
  const elements = []
  for (let index = 0; index < Math.min(input.elements.length, SCENE_LIMITS.elements); index += 1) {
    const result = validateSkeleton(input.elements[index], 'elements.' + index)
    if (!result.ok) errors.push(...result.errors)
    else elements.push(result.element)
  }
  if (errors.length > 0) return { ok: false, errors, scene: null }
  return { ok: true, errors: [], scene: { name, preset, elements } }
}

/** A blank scene, so "start me one" needs no invented JSON. */
export function emptyScene(name, preset) {
  return { name: String(name ?? 'untitled'), preset: String(preset ?? ''), elements: [] }
}

/**
 * Apply POINTER OPS to a scene, then re-validate the whole thing: a patch can never
 * leave a scene the write path would have refused, which is the property that makes
 * an agent's second write as safe as its first.
 *
 * Paths are dot-separated (`elements.3.x`, `name`, `preset`); `insert` accepts `-`
 * to append. `id`, `revision` and the timestamps are owned by the store and are
 * refused here, because a model that can rewrite a revision can defeat the check
 * that a render belongs to the thing it drew.
 */
export function applySceneOps(scene, ops, options = {}) {
  const presetIds = options.presets ?? null
  const errors = []
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, errors: fail([], 'ops', 'SCENE_OPS', 'a patch is an array of { op, at, value } - at least one') }
  }
  if (ops.length > SCENE_LIMITS.patches) {
    return { ok: false, errors: fail([], 'ops', 'SCENE_TOO_MANY_OPS', 'a patch carries at most ' + SCENE_LIMITS.patches + ' operations') }
  }
  const draft = JSON.parse(JSON.stringify(scene ?? {}))
  const FORBIDDEN = new Set(['id', 'revision', 'createdAt', 'updatedAt'])
  const segmentsOf = (at) => String(at ?? '').split('.').filter((part) => part !== '')
  const resolveParent = (segments) => {
    let node = draft
    for (let index = 0; index < segments.length - 1; index += 1) {
      const key = segments[index]
      if (node === null || typeof node !== 'object' || !(key in node)) return null
      node = node[key]
    }
    return node
  }
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    const where = 'ops.' + index
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string' || typeof op.at !== 'string') {
      errors.push({ path: where, code: 'SCENE_OP_SHAPE', message: 'each operation is { op: "set" | "remove" | "insert", at: "elements.0.x", value }' })
      continue
    }
    if (!['set', 'remove', 'insert'].includes(op.op)) {
      errors.push({ path: where + '.op', code: 'SCENE_OP_KIND', message: 'op must be set, remove or insert' })
      continue
    }
    if (op.op !== 'remove' && op.value === undefined) {
      errors.push({ path: where + '.value', code: 'SCENE_OP_VALUE', message: 'op "' + op.op + '" needs a value' })
      continue
    }
    const segments = segmentsOf(op.at)
    if (segments.length === 0 || segments.length > SCENE_LIMITS.patchDepth) {
      errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'at must be a path like elements.0.x (at most ' + SCENE_LIMITS.patchDepth + ' segments)' })
      continue
    }
    if (FORBIDDEN.has(segments[0])) {
      errors.push({ path: where + '.at', code: 'SCENE_OP_OWNED', message: '"' + segments[0] + '" belongs to the store, not to a patch' })
      continue
    }
    const parent = resolveParent(segments)
    const last = segments[segments.length - 1]
    if (parent === null || typeof parent !== 'object') {
      errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'no such place: ' + op.at })
      continue
    }
    if (op.op === 'set') {
      if (Array.isArray(parent)) {
        const at = last === '-' ? parent.length : Number(last)
        if (!Number.isInteger(at) || at < 0 || at >= parent.length) {
          errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'index ' + last + ' is not in ' + segments.slice(0, -1).join('.') + ' (' + parent.length + ' entries)' })
          continue
        }
        parent[at] = op.value
      } else if (!(last in parent)) {
        errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: '"' + last + '" is not a field of ' + segments.slice(0, -1).join('.') })
        continue
      } else parent[last] = op.value
      continue
    }
    if (op.op === 'remove') {
      if (Array.isArray(parent)) {
        const at = Number(last)
        if (!Number.isInteger(at) || at < 0 || at >= parent.length) {
          errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'index ' + last + ' is not in ' + segments.slice(0, -1).join('.') + ' (' + parent.length + ' entries)' })
          continue
        }
        parent.splice(at, 1)
      } else if (FORBIDDEN.has(last) || !(last in parent)) {
        errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: '"' + last + '" is not a removable field of ' + segments.slice(0, -1).join('.') })
        continue
      } else delete parent[last]
      continue
    }
    // insert
    if (!Array.isArray(parent)) {
      errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'insert needs an array to insert into; ' + segments.slice(0, -1).join('.') + ' is not one' })
      continue
    }
    const at = last === '-' ? parent.length : Number(last)
    if (!Number.isInteger(at) || at < 0 || at > parent.length) {
      errors.push({ path: where + '.at', code: 'SCENE_OP_PATH', message: 'index ' + last + ' is out of range for ' + segments.slice(0, -1).join('.') + ' (' + parent.length + ' entries)' })
      continue
    }
    parent.splice(at, 0, op.value)
  }
  if (errors.length > 0) return { ok: false, errors, scene: null }
  // RE-VALIDATION, not a diff: the result must be a scene the write path would take.
  const validated = validateScene({ name: draft.name, preset: draft.preset, elements: draft.elements }, { presets: presetIds })
  return validated
}

/** What one scene holds, as numbers a tool answer and a note can use. */
export function sceneSummary(scene) {
  const elements = Array.isArray(scene?.elements) ? scene.elements : []
  const byType = {}
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let chars = 0
  for (const element of elements) {
    byType[element.type] = (byType[element.type] ?? 0) + 1
    const x = Number(element.x) || 0
    const y = Number(element.y) || 0
    const x2 = x + (Number(element.width) || 0)
    const y2 = y + (Number(element.height) || 0)
    // Arrows and lines carry their extent in points instead of a size.
    const points = Array.isArray(element.points) ? element.points : null
    let px = x2
    let py = y2
    if (points !== null) for (const point of points) {
      px = Math.max(px, x + (Number(point[0]) || 0))
      py = Math.max(py, y + (Number(point[1]) || 0))
    }
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
    if (typeof element.text === 'string') chars += element.text.length
    if (element.label && typeof element.label.text === 'string') chars += element.label.text.length
  }
  return {
    elements: elements.length,
    byType,
    textChars: chars,
    bounds: elements.length === 0 ? null : { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
  }
}

/** One line per code, for a tool answer that has to fit in a sentence or three. */
export function sceneProblems(errors) {
  return (errors ?? []).map((error) => (error.path === '' ? error.code : error.path + ' [' + error.code + ']') + ': ' + error.message).join('\n  ')
}
