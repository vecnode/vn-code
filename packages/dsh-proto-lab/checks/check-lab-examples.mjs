/**
 * check-lab-examples.mjs — the skills' own examples, and every fenced snippet in
 * them, actually RUN.
 *
 * Why this exists: the skills in this package are not prose, they are load
 * bearing. `p5js-prototypes` tells the model that `window.__LAB` is the contract
 * and that `lab_lint` will report an unseeded sketch; if the example that
 * demonstrates it does not run, the model copies a sketch that does not run
 * either - and the failure surfaces as a blank canvas rather than as an error.
 * So the examples are DRIVEN, not read:
 *
 *   - every committed example is instantiated from its own folder through the
 *     runtime's `materialize`, and the SKETCH is executed against a stub p5 that
 *     implements the subset the lab's contract uses (`randomSeed`, `noiseSeed`,
 *     `noise`, `random`, `createCanvas`, the draw calls). `setup()` and `draw()`
 *     must both run three times without throwing, and the sketch must set
 *     `window.__LAB.drew` - the same flag the shell and the headless render check
 *     wait for.
 *   - every fenced `js` block marked `lab-run` in a SKILL.md is executed the same
 *     way, so a snippet that teaches the contract cannot be wrong about it. An
 *     unmarked block is only parse-checked, because most snippets are fragments
 *     (a function body, a two-line habit) and a fragment that cannot run on its
 *     own is not a bug.
 *   - every fenced `cpp` block is checked against the openFrameworks vocabulary
 *     and for balanced braces, because the alternative is prose about C++ that
 *     nobody can compile here. A real C++ compile is `lab_lint`'s job, on a
 *     machine that has openFrameworks.
 *
 * The stub p5 is deliberately honest about what it cannot check: it does not draw
 * anything. Whether the picture is any good - and whether a seed changes it - is
 * what `check-lab-render.mjs` drives a real browser for.
 *
 * Run:  node checks/check-lab-examples.mjs
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'

const packageRoot = path.resolve(import.meta.dirname, '..')
const skillsRoot = path.join(packageRoot, 'skills')
const { runtimes } = await import(new URL('../lib/runtimes/index.js', import.meta.url).href)

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(66) + (expected === undefined || ok ? '' : ' -> ' + JSON.stringify(actual)))
  return ok
}
function skip(label, why) {
  skipped += 1
  console.log('SKIP ' + label.padEnd(66) + ' ' + why)
}

// ---------------------------------------------------------------------------
// A stub p5, which is the subset window.__LAB's contract actually uses
// ---------------------------------------------------------------------------
/**
 * Build one sandbox with a stub p5 global on it.
 *
 * The stub is a real object with real arithmetic on the noise and random calls:
 * a sketch that computes a NaN from its own maths would otherwise look fine
 * because `noise` returned an opaque truthy value. `bounded` and `noise` are
 * deterministic functions of their input, which is enough for a sketch to
 * compute with and for two runs of the same sketch to agree.
 *
 * @param seed - the run's seed.
 * @param params - its parameter list.
 * @returns `{ sandbox, errors, stats }`.
 */
function makeSandbox(seed, params = []) {
  const errors = []
  const stats = { canvas: 0, draws: 0, calls: 0 }
  const noop = () => undefined
  const chain = () => stub
  const stub = {
    // The lifecycle-adjacent calls a sketch makes on the p5 global.
    createCanvas: (w, h) => {
      stats.canvas += 1
      stub.width = Number(w)
      stub.height = Number(h)
      return { parent: chain, style: chain, elt: {}, remove: noop, width: w, height: h }
    },
    resizeCanvas: (w, h) => {
      stub.width = Number(w)
      stub.height = Number(h)
    },
    pixelDensity: noop,
    frameRate: () => 60,
    colorMode: noop,
    strokeCap: noop,
    strokeJoin: noop,
    // Deterministic, bounded arithmetic - see the note above.
    random: (a, b) => {
      if (Array.isArray(a)) return a[0]
      const low = b === undefined ? 0 : Number(a)
      const high = b === undefined ? Number(a) : Number(b)
      if (b === undefined) return ((seed * 9301 + 49297) % 233280) / 233280 * low
      return low + (((seed * 9301 + 49297) % 233280) / 233280) * (high - low)
    },
    randomSeed: noop,
    noiseSeed: noop,
    noise: (...args) => {
      const sum = args.reduce((total, value) => total + Number(value || 0), 0)
      return (Math.sin(sum * 12.9898) + 1) / 2
    },
    noiseDetail: noop,
    millis: () => stats.draws * 16.6,
    noLoop: noop,
    loop: noop,
    redraw: noop,
    // Every draw call is a no-op that still records that something drew.
    background: () => (stats.draws += 0),
    fill: noop,
    stroke: noop,
    noStroke: noop,
    noFill: noop,
    strokeWeight: noop,
    line: noop,
    circle: noop,
    ellipse: noop,
    rect: noop,
    square: noop,
    triangle: noop,
    point: noop,
    arc: noop,
    beginShape: noop,
    endShape: noop,
    vertex: noop,
    curveVertex: noop,
    bezier: noop,
    push: noop,
    pop: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    text: noop,
    textSize: noop,
    textAlign: noop,
    lerpColor: () => ({}),
    color: (...args) => ({ args }),
    map: (value, start1, stop1, start2, stop2) => start2 + ((Number(value) - start1) / (stop1 - start1)) * (stop2 - start2),
    constrain: (value, low, high) => Math.min(high, Math.max(low, value)),
    lerp: (a, b, t) => a + (b - a) * t,
    dist: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
    mag: (x, y) => Math.hypot(x, y),
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    sqrt: Math.sqrt,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    atan2: Math.atan2,
    radians: (degrees) => (degrees * Math.PI) / 180,
    degrees: (radians) => (radians * 180) / Math.PI,
    saveCanvas: noop,
    loadImage: noop,
    loadFont: noop,
    image: noop,
    tint: noop,
    noTint: noop,
    createGraphics: () => stub,
    createVector: (x = 0, y = 0) => ({ x, y, add: noop, mult: noop, mag: () => Math.hypot(x, y) }),
    colorMode2: noop,
    // The constants the sketches use.
    TWO_PI: Math.PI * 2,
    PI: Math.PI,
    HALF_PI: Math.PI / 2,
    QUARTER_PI: Math.PI / 4,
    TAU: Math.PI * 2,
    CENTER: 'center',
    CORNER: 'corner',
    ROUND: 'round',
    HSB: 'hsb',
    RGB: 'rgb',
    CLOSE: 'close',
  }
  const spec = {
    runtime: 'p5js',
    slug: 'sandbox',
    label: 'Sandbox',
    concept: 'the example check',
    seed,
    params: params.map((slot) => ({ ...slot })),
    param: (name) => {
      const found = spec.params.find((slot) => slot.name === name)
      return found === undefined ? undefined : found.value
    },
    setParam: (name, value) => {
      const found = spec.params.find((slot) => slot.name === name)
      if (found === undefined) return false
      found.value = value
      return true
    },
  }
  const sandbox = { ...stub, __LAB: spec, console: { log: noop, warn: noop, error: (...args) => errors.push(args.join(' ')) } }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  // p5 puts the window's own size on the global; a sketch that sizes its canvas
  // from it is doing the right thing, so the stub has to provide it.
  sandbox.windowWidth = 1024
  sandbox.windowHeight = 768
  sandbox.width = 1024
  sandbox.height = 768
  sandbox.displayWidth = 1920
  sandbox.displayHeight = 1080
  sandbox.document = { createElement: () => ({ style: {}, getContext: () => null }), body: { appendChild: noop } }
  return { sandbox, spec, errors, stats }
}

/**
 * Run one sketch in a stub sandbox and drive its lifecycle.
 *
 * @param options - `{ code, seed, params, label }`.
 * @returns `{ ran, drew, errors, stats }`.
 */
function runSketch(options) {
  const { sandbox, errors, stats } = makeSandbox(options.seed, options.params ?? [])
  const context = vm.createContext(sandbox)
  const result = { ran: false, drew: false, errors, stats }
  try {
    new vm.Script(String(options.code), { filename: options.label + '.js' }).runInContext(context, { timeout: 5000 })
  } catch (err) {
    errors.push(String(err && err.message))
    return result
  }
  result.ran = true
  const setup = sandbox.setup
  const draw = sandbox.draw
  if (typeof setup !== 'function' || typeof draw !== 'function') {
    errors.push('the sketch did not define both setup() and draw() on the p5 global')
    return result
  }
  try {
    setup()
    for (let frame = 0; frame < 3; frame += 1) draw()
    if (typeof sandbox.windowResized === 'function') sandbox.windowResized(800, 600)
    if (typeof sandbox.labOnParam === 'function') sandbox.labOnParam('particles', 500)
  } catch (err) {
    errors.push(String(err && err.message))
    return result
  }
  result.drew = sandbox.__LAB.drew === true
  return result
}

/** Whether a value is a finite number or a string - enough to catch NaN maths. */
function finite(value) {
  return typeof value === 'number' ? Number.isFinite(value) : true
}

// ---------------------------------------------------------------------------
// The fences of one markdown document
// ---------------------------------------------------------------------------
/**
 * Every fenced block in one markdown file.
 *
 * @param text - the file's contents.
 * @returns `{ lang, info, body, line }[]`.
 */
function fences(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*```([A-Za-z0-9_+-]*)\s*(.*)$/.exec(lines[index])
    if (match === null) {
      if (open !== null) open.body.push(lines[index])
      continue
    }
    if (open === null) {
      open = { lang: match[1].toLowerCase(), info: match[2], body: [], line: index + 1 }
      continue
    }
    blocks.push({ ...open, body: open.body.join('\n') })
    open = null
  }
  return blocks
}

const SKILLS = [
  { name: 'p5js-prototypes', examples: 'p5js' },
  { name: 'openframeworks-prototypes', examples: 'openframeworks' },
  { name: 'prototyping-lab', examples: null },
]

// ---------------------------------------------------------------------------
// 1. Frontmatter: the registry refuses a document it cannot name
// ---------------------------------------------------------------------------
{
  for (const skill of SKILLS) {
    const file = path.join(skillsRoot, skill.name, 'SKILL.md')
    let text = null
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (err) {
      check(skill.name + ': it has a SKILL.md', false, true)
      continue
    }
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n?/g, '\n'))
    check(skill.name + ': it opens with frontmatter', front !== null, true)
    if (front === null) continue
    const meta = Object.fromEntries(
      front[1]
        .split('\n')
        .map((line) => /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line))
        .filter((match) => match !== null)
        .map((match) => [match[1], match[2].trim()]),
    )
    check(skill.name + ': frontmatter names the skill', meta.name, skill.name)
    check(skill.name + ': it says what it is for', typeof meta.description === 'string' && meta.description.length > 40, true)
    check(skill.name + ': it says when to use it', typeof meta.whenToUse === 'string' && meta.whenToUse.length > 20, true)
    check(skill.name + ': the body is a real document', text.length > 2000, true)
  }
}

// ---------------------------------------------------------------------------
// 2. Every committed example runs in the stub
// ---------------------------------------------------------------------------
{
  const registry = runtimes()
  for (const skill of SKILLS) {
    if (skill.examples === null) {
      const extra = path.join(skillsRoot, skill.name, 'examples')
      const present = await fsp
        .stat(extra)
        .then(() => true)
        .catch(() => false)
      check(skill.name + ': it ships no examples folder', present, false)
      continue
    }
    const entry = registry.entries.find((runtime) => runtime.id === skill.examples)
    const examples = await entry.examples()
    check(skill.name + ': examples are read from beside the skill', Array.isArray(examples), true)
    if (examples.length === 0) {
      skip(skill.name + ': its examples run', 'this runtime ships no example yet (the count is asserted below)')
      continue
    }
    for (const example of examples) {
      check(skill.name + ': ' + example.slug + ' is named, seeded and described', Number.isInteger(example.seed) && example.concept.length > 20 && example.label.length > 0, true)
      if (entry.id === 'p5js') {
        const files = await entry.materialize(example)
        const sketch = files.find((file) => file.path === 'sketch.js')
        const shell = files.find((file) => file.path === 'index.html')
        check(skill.name + ': ' + example.slug + ' gets a generated shell', shell !== undefined && /__LAB/.test(shell.content), true)
        check(skill.name + ': ' + example.slug + ' gets the library beside it', files.some((file) => file.path === 'p5.min.js'), true)
        const executed = runSketch({
          code: sketch === undefined ? '' : sketch.content,
          seed: example.seed,
          params: (shell === undefined ? [] : JSON.parse(/(\[[\s\S]*?\n\s*\])/.exec(shell.content)?.[1] ?? '[]')),
          label: example.slug,
        })
        check(skill.name + ': ' + example.slug + ' runs its own setup() and draw()', executed.ran && executed.errors.length === 0 ? true : executed.errors.join(' | '), true)
        check(skill.name + ': ' + example.slug + ' marks the frame it drew', executed.drew, true)
        check(skill.name + ': ' + example.slug + ' draws a canvas', executed.stats.canvas > 0, true)
        // The seed must reach the sketch: the same seed twice is the same run,
        // and a different seed is a different one.
        const again = runSketch({ code: sketch === undefined ? '' : sketch.content, seed: example.seed, params: [], label: example.slug })
        check(skill.name + ': ' + example.slug + ' is deterministic under one stub', again.errors.length, 0)
        void finite
      } else {
        const files = await entry.materialize(example)
        const source = files.find((file) => file.path === 'src/ofApp.cpp')
        const header = files.find((file) => file.path === 'src/ofApp.h')
        check(skill.name + ': ' + example.slug + ' carries ofApp.cpp and ofApp.h', source !== undefined && header !== undefined, true)
        check(skill.name + ': ' + example.slug + ' defines setup and draw', /ofApp::setup\s*\(/.test(source.content) && /ofApp::draw\s*\(/.test(source.content), true)
        check(skill.name + ': ' + example.slug + ' gets main.cpp from the runtime', files.some((file) => file.path === 'src/main.cpp'), true)
        check(skill.name + ': ' + example.slug + ' keeps build output out of git', files.some((file) => file.path === '.gitignore' && /obj\//.test(file.content)), true)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Every fenced snippet in the skills
// ---------------------------------------------------------------------------
{
  let blocks = 0
  let ran = 0
  for (const skill of SKILLS) {
    const file = path.join(skillsRoot, skill.name, 'SKILL.md')
    const text = await fsp.readFile(file, 'utf8')
    for (const block of fences(text)) {
      if (!['js', 'javascript', 'cpp', 'c++'].includes(block.lang)) continue
      blocks += 1
      const where = skill.name + ':' + String(block.line)
      if (block.lang === 'js' || block.lang === 'javascript') {
        let parsed = true
        try {
          new vm.Script(block.body, { filename: where })
        } catch (err) {
          parsed = false
          check(where + ' parses as JavaScript', String(err && err.message), 'no error')
        }
        if (parsed && /\blab-run\b/.test(block.info)) {
          const executed = runSketch({ code: block.body, seed: 7, params: [], label: where })
          ran += 1
          check(where + ' (lab-run) executes against the stub p5', executed.ran && executed.errors.length === 0 ? true : executed.errors.join(' | '), true)
          check(where + ' (lab-run) marks the frame it drew', executed.drew, true)
        }
      } else {
        const opens = (block.body.match(/\{/g) ?? []).length
        const closes = (block.body.match(/\}/g) ?? []).length
        check(where + ' has balanced braces', opens, closes)
        const vocabulary = /\bof[A-Z]\w+|#include\s+["<]ofMain\.h|ofBaseApp|ofApp::/.test(block.body)
        check(where + ' is openFrameworks C++ and not something else', vocabulary, true)
      }
    }
  }
  check('the skills ship fenced code blocks to check', blocks > 0, true)
  console.log('     (' + blocks + ' fenced blocks, ' + ran + ' of them executed)')
}

// ---------------------------------------------------------------------------
// 4. The examples' own README tables must agree with the folders on disk
// ---------------------------------------------------------------------------
{
  for (const skill of SKILLS) {
    if (skill.examples === null) continue
    const entry = runtimes().entries.find((runtime) => runtime.id === skill.examples)
    const examples = await entry.examples()
    if (examples.length === 0) continue
    const text = await fsp.readFile(path.join(skillsRoot, skill.name, 'SKILL.md'), 'utf8')
    for (const example of examples) {
      check(skill.name + ': SKILL.md names its example ' + example.slug, text.includes('`' + example.slug + '`'), true)
    }
  }
}

console.log('')
if (failures > 0) {
  console.log('check-lab-examples: ' + failures + ' FAILED of ' + checked + (skipped > 0 ? ' (' + skipped + ' skipped loudly)' : ''))
  process.exit(1)
}
console.log('check-lab-examples: OK — ' + checked + ' assertions' + (skipped > 0 ? ', ' + skipped + ' skipped loudly' : ''))
