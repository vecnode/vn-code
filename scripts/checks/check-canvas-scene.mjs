// check-canvas-scene.mjs — the SCENE language, hermetically.
//
// This is the layer the Canvas tab's agent tools are being moved onto: an agent
// writes Excalidraw SKELETONS, the HOST validates/stores/patches them, and the
// BROWSER materializes them with Excalidraw's own `convertToExcalidrawElements`.
// No DOM is needed for the host's half, which is exactly why this check can be
// exhaustive where a browser check has to be selective.
//
// What it is really defending: every refusal carries a CODE the model can act on,
// nothing is silently dropped (an accepted key that the validator forgets to carry
// is the same bug as an ignored field), the normalised output RE-VALIDATES
// byte-identically - the property that lets a patch on a stored scene pass the same
// validation the original write did - and the fields the STORE owns cannot be
// rewritten through a patch.
//
// Run:  node scripts/checks/check-canvas-scene.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCENE_LIMITS, SKELETON_TYPES, applySceneOps, emptyScene, sceneProblems, sceneSummary, validateScene, validateSkeleton } from '../../packages/dsh-canvas/lib/scene.js'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const source = readFileSync(path.join(repo, 'packages', 'dsh-canvas', 'lib', 'scene.js'), 'utf8')
const PRESETS = ['github-social', 'og', 'poster-a3']

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
/** The codes one refusal carries, so a test can name what it expects. */
const codesOf = (result) => (result.errors ?? []).map((error) => error.code)
const pathsOf = (result) => (result.errors ?? []).map((error) => error.path)

const scene = (elements, extra = {}) => ({ name: 'Test scene', preset: 'github-social', elements, ...extra })

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------
check('the language knows the kinds Excalidraw draws', SKELETON_TYPES.join(','), 'rectangle,ellipse,diamond,arrow,line,freedraw,text,frame')
check('...and a scene is capped', SCENE_LIMITS.elements, 400)
check('an unknown kind is refused by NAME', codesOf(validateSkeleton({ type: 'hexagon' }, 'e')).join(','), 'ELEMENT_TYPE')
// The one kind that is deliberately missing, and the refusal has to say why rather
// than looking like a typo: an image element needs a files map and the asset route.
const image = validateSkeleton({ type: 'image', x: 0, y: 0 }, 'e')
check('an image is refused as UNSUPPORTED, not unknown', codesOf(image).join(','), 'ELEMENT_UNSUPPORTED')
check('...and the refusal explains what it needs', image.errors[0].message.includes('files map') && image.errors[0].message.includes('asset route'))

// ---------------------------------------------------------------------------
// Geometry and defaults
// ---------------------------------------------------------------------------
const rect = validateSkeleton({ type: 'rectangle', x: 10, y: 20, width: 100, height: 50 }, 'e')
check('a bare rectangle validates', rect.ok, true)
check('...with x/y/w/h kept', [rect.element.x, rect.element.y, rect.element.width, rect.element.height].join(','), '10,20,100,50')
check('...and the editor\u2019s own defaults filled in', [rect.element.strokeColor, rect.element.backgroundColor, rect.element.strokeWidth, rect.element.roughness, rect.element.opacity, rect.element.angle].join('|'), '#1e1e1e|transparent|2|1|100|0')
check('a missing x/y is the origin, not a refusal', validateSkeleton({ type: 'rectangle', width: 10, height: 10 }, 'e').element.x, 0)
check('a shape with no size at all is refused', codesOf(validateSkeleton({ type: 'rectangle', x: 0, y: 0 }, 'e')).join(','), 'ELEMENT_SIZE')
check('a negative size is refused', codesOf(validateSkeleton({ type: 'rectangle', x: 0, y: 0, width: -1, height: 10 }, 'e')).join(','), 'ELEMENT_SIZE')
check('a non-number coordinate is refused', codesOf(validateSkeleton({ type: 'rectangle', x: 'ten', y: 0, width: 10, height: 10 }, 'e')).join(','), 'ELEMENT_NUMBER')
check('a coordinate past the cap is refused', codesOf(validateSkeleton({ type: 'rectangle', x: 999999, y: 0, width: 10, height: 10 }, 'e')).join(','), 'ELEMENT_RANGE')
check('a text element with no size is fine (the editor measures it)', validateSkeleton({ type: 'text', text: 'hi' }, 'e').ok, true)
check('a flat arrow is fine', validateSkeleton({ type: 'arrow', x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] }, 'e').ok, true)

// ---------------------------------------------------------------------------
// Colours, styles, ranges
// ---------------------------------------------------------------------------
for (const [label, value] of [['3-digit', '#fff'], ['6-digit', '#1e1e1e'], ['8-digit', '#11223344'], ['transparent', 'transparent']]) {
  check('a ' + label + ' colour is accepted', validateSkeleton({ type: 'rectangle', width: 10, height: 10, strokeColor: value }, 'e').ok, true)
}
check('a colour NAME is refused (the editor wants hex)', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, strokeColor: 'red' }, 'e')).join(','), 'ELEMENT_COLOR')
check('an unknown fill style is refused', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, fillStyle: 'plaid' }, 'e')).join(','), 'ELEMENT_FILL_STYLE')
check('an unknown stroke style is refused', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, strokeStyle: 'wavy' }, 'e')).join(','), 'ELEMENT_STROKE_STYLE')
check('opacity is capped at 100', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, opacity: 140 }, 'e')).join(','), 'ELEMENT_RANGE')
check('roughness is capped at 2', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, roughness: 9 }, 'e')).join(','), 'ELEMENT_RANGE')
check('an angle past 360 is refused', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, angle: 999 }, 'e')).join(','), 'ELEMENT_RANGE')
// Roundness has THREE spellings upstream and one that this validator emits, so all
// four go through here - the second of which was a real bug twice over.
for (const [label, value] of [['true', true], ['false', false], ['null', null], ['a radius', 12], ['its own output', { type: 3 }]]) {
  check('roundness accepts ' + label, validateSkeleton({ type: 'rectangle', width: 10, height: 10, roundness: value }, 'e').ok, true)
}
check('roundness refuses a string', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, roundness: 'round' }, 'e')).join(','), 'ELEMENT_RANGE')

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
check('text keeps its string and size', [validateSkeleton({ type: 'text', text: 'Ship' }, 'e').element.text, validateSkeleton({ type: 'text', text: 'Ship', fontSize: 40 }, 'e').element.fontSize].join('|'), 'Ship|40')
check('a text element with no string is refused', codesOf(validateSkeleton({ type: 'text', fontSize: 20 }, 'e')).join(','), 'ELEMENT_TEXT')
check('a font size past the cap is refused', codesOf(validateSkeleton({ type: 'text', text: 'x', fontSize: 900 }, 'e')).join(','), 'ELEMENT_RANGE')
check('an unknown font family is refused', codesOf(validateSkeleton({ type: 'text', text: 'x', fontFamily: 4 }, 'e')).join(','), 'ELEMENT_FONT')
check('a known font family is kept', validateSkeleton({ type: 'text', text: 'x', fontFamily: 5 }, 'e').element.fontFamily, 5)
check('an unknown alignment is refused', codesOf(validateSkeleton({ type: 'text', text: 'x', textAlign: 'justify' }, 'e')).join(','), 'ELEMENT_ALIGN')
check('a long text is refused by length', codesOf(validateSkeleton({ type: 'text', text: 'x'.repeat(SCENE_LIMITS.textChars + 1) }, 'e')).join(','), 'ELEMENT_TEXT_LONG')

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
check('a rectangle label is kept', validateSkeleton({ type: 'rectangle', width: 10, height: 10, label: { text: 'Hi', fontSize: 22 } }, 'e').element.label.text, 'Hi')
check('a label on a text element is refused', codesOf(validateSkeleton({ type: 'text', text: 'x', label: { text: 'y' } }, 'e')).join(','), 'ELEMENT_LABEL')
check('a label with no string is refused', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, label: { fontSize: 20 } }, 'e')).join(','), 'ELEMENT_LABEL')
check('a long label is refused by length', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, label: { text: 'x'.repeat(SCENE_LIMITS.labelChars + 1) } }, 'e')).join(','), 'ELEMENT_LABEL_LONG')

// ---------------------------------------------------------------------------
// Points (arrows, lines, freedraw)
// ---------------------------------------------------------------------------
check('an arrow with no points is refused', codesOf(validateSkeleton({ type: 'arrow', width: 10, height: 0 }, 'e')).join(','), 'ELEMENT_POINTS')
check('an arrow with ONE point is refused', codesOf(validateSkeleton({ type: 'arrow', points: [[0, 0]] }, 'e')).join(','), 'ELEMENT_POINTS')
check('a malformed point is named by INDEX', pathsOf(validateSkeleton({ type: 'line', points: [[0, 0], [1, 'two']] }, 'e')).join(','), 'e.points.1')
check('too many points is refused', codesOf(validateSkeleton({ type: 'freedraw', points: Array.from({ length: SCENE_LIMITS.points + 1 }, () => [0, 0]) }, 'e')).join(','), 'ELEMENT_POINTS_MANY')
check('a good arrowhead is kept', validateSkeleton({ type: 'arrow', points: [[0, 0], [1, 1]], endArrowhead: 'triangle' }, 'e').element.endArrowhead, 'triangle')
check('a made-up arrowhead is refused', codesOf(validateSkeleton({ type: 'arrow', points: [[0, 0], [1, 1]], endArrowhead: 'spike' }, 'e')).join(','), 'ELEMENT_ARROWHEAD')

// ---------------------------------------------------------------------------
// Nothing is silently dropped: unknown keys out, ACCEPTED keys carried
// ---------------------------------------------------------------------------
check('an unknown field is refused, not ignored', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, colour: '#fff' }, 'e')).join(','), 'ELEMENT_UNKNOWN_KEY')
check('...and the message says why that matters', validateSkeleton({ type: 'rectangle', width: 10, height: 10, colour: '#fff' }, 'e').errors[0].message.includes('you did not write'))
check('a frameId is CARRIED, not accepted and dropped', validateSkeleton({ type: 'rectangle', width: 10, height: 10, frameId: 'frame-1' }, 'e').element.frameId, 'frame-1')
check('a non-string frameId is refused', codesOf(validateSkeleton({ type: 'rectangle', width: 10, height: 10, frameId: 3 }, 'e')).join(','), 'ELEMENT_FRAME_ID')
check('a name is carried', validateSkeleton({ type: 'rectangle', width: 10, height: 10, name: 'card' }, 'e').element.name, 'card')

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
check('a scene needs a name', codesOf(validateScene({ preset: 'github-social', elements: [] }, { presets: PRESETS })).join(','), 'SCENE_NAME')
check('a scene needs a preset', codesOf(validateScene({ name: 'x', elements: [] }, { presets: PRESETS })).join(','), 'SCENE_PRESET')
check('an UNKNOWN preset is refused', codesOf(validateScene(scene([], { preset: 'billboard' }), { presets: PRESETS })).join(','), 'SCENE_PRESET')
check('a scene with no preset known to this host still validates when none is declared', validateScene(scene([], { preset: 'anything' })).ok, true)
check('elements must be an array', codesOf(validateScene({ name: 'x', preset: 'github-social', elements: {} }, { presets: PRESETS })).join(','), 'SCENE_ELEMENTS')
check('a blank scene is legal', validateScene(scene([]), { presets: PRESETS }).ok, true)
check('too many elements is refused', codesOf(validateScene(scene(Array.from({ length: SCENE_LIMITS.elements + 1 }, () => ({ type: 'rectangle', width: 1, height: 1 }))), { presets: PRESETS })).join(','), 'SCENE_TOO_MANY')
check('a bad element is named by its own path', pathsOf(validateScene(scene([{ type: 'rectangle', width: 10, height: 10 }, { type: 'nope' }]), { presets: PRESETS })).join(','), 'elements.1.type')
check('a scene that is not an object is refused by shape', codesOf(validateScene('hello', { presets: PRESETS })).join(','), 'SCENE_SHAPE')

// THE PROPERTY: the normalised output RE-VALIDATES, byte-identically. Without it a
// stored scene could never be patched (the patch re-validates the stored form), and
// an idempotent validator is also the only way "the write and the patch agree" is a
// fact rather than a hope.
const sample = scene([
  { type: 'rectangle', id: 'card', x: 48, y: 48, width: 400, height: 200, backgroundColor: '#eef2ff', roundness: true, label: { text: 'Ship plugins', fontSize: 36 } },
  { type: 'text', x: 48, y: 300, width: 600, height: 30, text: 'vncode', fontSize: 22, fontFamily: 2 },
  { type: 'arrow', x: 500, y: 400, width: 100, height: 0, points: [[0, 0], [100, 0]], endArrowhead: 'arrow' },
  { type: 'ellipse', x: 10, y: 10, width: 50, height: 50, strokeStyle: 'dashed', opacity: 60 },
])
const first = validateScene(sample, { presets: PRESETS })
check('a realistic scene validates', first.ok, true)
const second = validateScene(first.scene, { presets: PRESETS })
check('...and its NORMALISED form re-validates', second.ok, true)
check('...byte-identically (validation is idempotent)', JSON.stringify(first.scene), JSON.stringify(second.scene))
check('the scene keeps what the name and preset said', [first.scene.name, first.scene.preset].join('|'), 'Test scene|github-social')

// ---------------------------------------------------------------------------
// Pointer ops
// ---------------------------------------------------------------------------
const patched = applySceneOps(first.scene, [
  { op: 'set', at: 'elements.0.x', value: 60 },
  { op: 'set', at: 'name', value: 'Renamed' },
  { op: 'insert', at: 'elements.-', value: { type: 'diamond', x: 0, y: 0, width: 20, height: 20 } },
  { op: 'remove', at: 'elements.1' },
], { presets: PRESETS })
check('a four-op patch applies', patched.ok, true)
check('...the set landed', patched.scene.elements[0].x, 60)
check('...the name changed', patched.scene.name, 'Renamed')
check('...the insert appended', patched.scene.elements[patched.scene.elements.length - 1].type, 'diamond')
check('...and the remove took one out', patched.scene.elements.length, first.scene.elements.length)
check('...and the result is still a valid scene', validateScene(patched.scene, { presets: PRESETS }).ok, true)
check('insert at 0 puts it first', applySceneOps(first.scene, [{ op: 'insert', at: 'elements.0', value: { type: 'frame', x: 0, y: 0, width: 10, height: 10 } }], { presets: PRESETS }).scene.elements[0].type, 'frame')
// A PATCH CANNOT LEAVE A SCENE THE WRITE PATH WOULD REFUSE, which is the property
// that makes an agent's second write as safe as its first.
const breaking = applySceneOps(first.scene, [{ op: 'set', at: 'elements.0.width', value: -5 }], { presets: PRESETS })
check('a patch that breaks the scene is refused', breaking.ok, false)
check('...with the write path\u2019s own code', codesOf(breaking).includes('ELEMENT_SIZE'), true)
check('an empty patch is refused', codesOf(applySceneOps(first.scene, [], { presets: PRESETS })).join(','), 'SCENE_OPS')
check('too many ops are refused', codesOf(applySceneOps(first.scene, Array.from({ length: SCENE_LIMITS.patches + 1 }, () => ({ op: 'set', at: 'name', value: 'x' })), { presets: PRESETS })).join(','), 'SCENE_TOO_MANY_OPS')
check('an unknown op is refused', codesOf(applySceneOps(first.scene, [{ op: 'rename', at: 'name', value: 'x' }], { presets: PRESETS })).join(','), 'SCENE_OP_KIND')
check('an op with no value is refused', codesOf(applySceneOps(first.scene, [{ op: 'set', at: 'name' }], { presets: PRESETS })).join(','), 'SCENE_OP_VALUE')
check('an index out of range is refused', codesOf(applySceneOps(first.scene, [{ op: 'set', at: 'elements.99.x', value: 1 }], { presets: PRESETS })).join(','), 'SCENE_OP_PATH')
check('a path that does not exist is refused', codesOf(applySceneOps(first.scene, [{ op: 'set', at: 'elements.0.colour', value: '#fff' }], { presets: PRESETS })).join(','), 'SCENE_OP_PATH')
check('insert into a non-array is refused', codesOf(applySceneOps(first.scene, [{ op: 'insert', at: 'name.-', value: 'x' }], { presets: PRESETS })).join(','), 'SCENE_OP_PATH')
check('a path deeper than the cap is refused', codesOf(applySceneOps(first.scene, [{ op: 'set', at: 'a.b.c.d.e.f.g.h.i.j.k.l.m', value: 1 }], { presets: PRESETS })).join(','), 'SCENE_OP_PATH')
check('a malformed op is refused by shape', codesOf(applySceneOps(first.scene, [{ at: 'name' }], { presets: PRESETS })).join(','), 'SCENE_OP_SHAPE')
// The STORE owns identity and revision: a model that can rewrite a revision can
// defeat the check that a render belongs to the thing it drew.
for (const owned of ['id', 'revision', 'createdAt', 'updatedAt']) {
  check('a patch cannot rewrite ' + owned, codesOf(applySceneOps(first.scene, [{ op: 'set', at: owned, value: 1 }], { presets: PRESETS })).join(','), 'SCENE_OP_OWNED')
}

// ---------------------------------------------------------------------------
// The summary a tool answer and the note are written from
// ---------------------------------------------------------------------------
const summary = sceneSummary(patched.scene)
check('the summary counts the elements', summary.elements, patched.scene.elements.length)
// The patch set a name, moved the rectangle, inserted a diamond and REMOVED the
// text element - so the kinds are these four, and the character count below is the
// rectangle's label alone. Both numbers are asserted against the scene BEFORE the
// patch too, because "the summary follows the patch" is the fact worth having.
check('...and groups them by kind', Object.keys(summary.byType).sort().join(','), 'arrow,diamond,ellipse,rectangle')
check('...counting the characters the design carries', summary.textChars, 'Ship plugins'.length)
check('...which fell when the patch removed the text element', sceneSummary(first.scene).textChars, 'Ship pluginsvncode'.length)
check('...and measures the bounds', summary.bounds !== null && summary.bounds.width > 0, true)
check('an empty scene has no bounds', sceneSummary(emptyScene('x', 'og')).bounds, null)
// An arrow carries its extent in POINTS, not in width/height, so a summary that
// ignored them would report a scene at the origin.
check('the bounds follow an arrow\u2019s points', sceneSummary({ elements: [{ type: 'arrow', x: 100, y: 100, width: 0, height: 0, points: [[0, 0], [200, 50]] }] }).bounds.width, 200)
check('problems read as paths, codes and sentences', sceneProblems([{ path: 'elements.0.x', code: 'ELEMENT_NUMBER', message: 'x must be a number' }]), 'elements.0.x [ELEMENT_NUMBER]: x must be a number')
check('a whole-scene problem reads without a leading dot', sceneProblems([{ path: '', code: 'SCENE_SHAPE', message: 'a scene is an object' }]), 'SCENE_SHAPE: a scene is an object')

// ---------------------------------------------------------------------------
// The file is pure: the host half must not reach for a browser
// ---------------------------------------------------------------------------
check('the scene language imports nothing at all', /^import /m.test(source), false)
check('...and never touches the DOM', /\bdocument\.|\bwindow\./.test(source), false)
check('...and never reads a file', /node:fs|readFileSync|require\(/.test(source), false)

console.log('')
console.log(failures === 0 ? 'all canvas scene checks passed' : failures + ' canvas scene check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
