/**
 * dsh-proto-lab — the p5.js runtime.
 *
 * p5.js is the runtime that always works: nothing is installed, nothing is
 * compiled, and a run is a folder a browser opens. It is also the runtime with
 * the most ways to be subtly wrong, which is what the `lint` below is for - an
 * unseeded sketch, a CDN import, a reference to a library the run does not carry.
 *
 * WHAT A RUN IS
 *
 *   index.html   the shell: the vendored p5, the seed, the generated controls
 *   sketch.js    the prototype: setup() + draw() and the algorithm's state
 *   p5.min.js    the library, copied from lib/vendor/ so the run is offline
 *   README.md    what it is and how to run it
 *   NOTES.md     the seed, what to look at, what to try
 *
 * The split is deliberate and is the thing that differs from a single-artifact
 * sketch: the shell is GENERATED and the sketch is the artifact. Re-running
 * `lab_new` over a run replaces the shell and the library and leaves the sketch,
 * so a run can be brought forward without losing the work in it.
 *
 * REPRODUCIBILITY
 *
 * The seed reaches the sketch as `window.__LAB.seed` and every tunable as a named
 * entry in `window.__LAB.params`. The shell overlays `?seed=` and any parameter
 * name from the query string, so ONE file is both the committed run and a seed
 * scrubber - which is what the preview tab's Reroll does, and what the headless
 * render check uses to prove that two seeds give two pictures.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUDGETS } from '../capabilities.js'
import { LabError } from '../lab.js'
import { notesOf, readmeOf } from '../describe.js'
import { digest, integerOf, isSlug, jsLiteral, substitute } from '../util.js'

/** The default seed when a caller asks for none. */
const DEFAULT_SEED = 0

/** The parameters a new run opens with - the shape every example follows. */
const DEFAULT_PARAMS = [
  { name: 'particles', min: 200, max: 6000, value: 1800, step: 50 },
  { name: 'scale', min: 0.0006, max: 0.006, value: 0.0018, step: 0.0002 },
  { name: 'flow', min: 0.3, max: 4, value: 1.6, step: 0.1 },
  { name: 'speed', min: 0, max: 3, value: 1, step: 0.05 },
  { name: 'life', min: 20, max: 420, value: 160, step: 5 },
  { name: 'weight', min: 0.2, max: 3, value: 1, step: 0.05 },
  { name: 'veil', min: 0, max: 24, value: 8, step: 1 },
]

/**
 * The parameters a newly scaffolded run opens with, adapted to THIS machine.
 *
 * The shape is fixed - the seven quantities every generated flow-field run has -
 * but the POPULATION is scaled by the host's own size, because a prototype whose
 * first frame already stutters is a prototype nobody can read. A workstation gets
 * the full 4000; a small container gets something it can actually run at 60 fps.
 * This is the one number where the machine leaks into generated content, and it
 * leaks in deliberately rather than by accident.
 *
 * @param machine - `{ scale, cores, memoryGiB }` from `lib/capabilities.js`.
 * @returns a fresh parameter list.
 */
export function defaultParams(machine = {}) {
  const scale = Number.isFinite(machine.scale) ? Math.max(0.25, Math.min(1, machine.scale)) : 0.5
  const particles = Math.round((800 + 3200 * scale) / 50) * 50
  return DEFAULT_PARAMS.map((slot) => (slot.name === 'particles' ? { ...slot, value: particles } : { ...slot }))
}

/** This runtime's name, everywhere. */
export const id = 'p5js'
/** What a person reads in `lab_runtimes`. */
export const label = 'p5.js'
/** A browser draws it. */
export const kind = 'web'
/** One line for the tools' answers. */
export const tagline = 'Sketch in the browser: a canvas, a seed, and sliders generated from the sketch itself.'
/** The extensions a p5.js run may contain (README/NOTES are always allowed). */
export const extensions = ['.html', '.js', '.css', '.json', '.md', '.txt']

/** Where this runtime's templates live, and where its examples live. */
const here = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES = path.join(here, 'templates')
const VENDOR = path.join(path.dirname(here), 'vendor', 'p5.min.js')
const SKILL_DIR = path.join(path.dirname(path.dirname(here)), 'skills', 'p5js-prototypes')

/** One template file's text, from the `lib/runtimes/templates/` kit beside it. */
async function template(name) {
  return fsp.readFile(path.join(TEMPLATES, name + '.template'), 'utf8')
}

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** Whether a path exists. */
async function present(target) {
  try {
    await fsp.stat(target)
    return true
  } catch (err) {
    return false
  }
}

/** Every file under a directory, relative, forward slashes, sorted. */
async function walk(dir, prefix = '') {
  const found = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const child = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      found.push(...(await walk(path.join(dir, entry.name), child)))
      continue
    }
    if (entry.isFile()) found.push(child)
  }
  return found.sort()
}

/**
 * What the p5 runtime needs on this machine.
 *
 * Nothing is installed and nothing is executed: the honest answer is about
 * whether the vendored library is on disk (so a run is self-contained and
 * offline) and whether a browser exists to open it with - which the preview tab
 * also needs. The browser probe is a PATH/filesystem look, never a launch, so
 * `lab_runtimes` stays cheap.
 *
 * @param options - `{ env }`.
 * @returns `{ available, summary, detail, commands }`.
 */
export async function detect(options = {}) {
  const detail = []
  let available = false
  try {
    const stat = await fsp.stat(VENDOR)
    available = stat.isFile()
    detail.push('library: ' + VENDOR + ' (' + stat.size + ' bytes, vendored - no CDN, no network)')
  } catch (err) {
    detail.push('library: MISSING at ' + VENDOR + ' - rebuild it with `node vendor/build.mjs`')
  }
  detail.push('runtime: the browser draws it; nothing is installed and nothing is compiled')
  return {
    available,
    summary: available
      ? 'ready - a run opens in any browser, offline'
      : 'the vendored p5.min.js is missing, so a run would not load its library',
    detail,
    commands: ['open the run\'s index.html in a browser', 'or use the package\'s Lab tab in the right bar'],
  }
}

/**
 * The one file a p5 run needs that is not generated: the library.
 *
 * Copied INTO the run rather than referenced from the package, because a run is
 * meant to be a folder you can move, zip or open straight off the disk, and
 * because a `file://` page cannot reach the plugin's route.
 */
export async function library() {
  const content = await fsp.readFile(VENDOR)
  return [{ path: 'p5.min.js', content }]
}

/** The files a p5.js run carries, as the README describes them. */
const FILES = [
  { path: 'sketch.js', what: '**the prototype.** setup(), draw(), and the algorithm\'s state. Edit this.' },
  { path: 'index.html', what: 'the shell: the library, the seed, the generated controls, Save PNG. Regenerated.' },
  { path: 'p5.min.js', what: 'p5.js, vendored by the plugin so the run is offline. Regenerated.' },
  { path: 'NOTES.md', what: 'the seed, what to look at, what to try next.' },
]

/** How to open one, which is the part a reader needs first. */
const WHERE = [
  '## Run it',
  '',
  '- **In this app**: open the run in the right bar\'s **Lab** tab. It reloads when the files change.',
  '- **On its own**: open `index.html` in a browser. It loads `p5.min.js` from this folder, so it works offline.',
  '- **Another seed**: open `index.html?seed=42`. Any parameter can ride along: `?seed=42&particles=900`.',
  '',
  '## Editing the shell',
  '',
  'Add a parameter by adding an entry to the `params` array in `index.html` and reading it with',
  '`P(\'name\')` in `sketch.js`. The control is generated from that array, so there is no second',
  'place to keep in step.',
].join('\n')

/** The observations this runtime's own algorithm invites. */
const LOOK = [
  'Where the field is calm and where it churns: that is the noise scale talking, not the particles.',
  'Run it for a minute. Density should keep arriving rather than settling into a texture.',
]
/** The three moves worth making first. */
const TRY = [
  'Reroll a few seeds and keep the one where the structure reads as one gesture.',
  'Push `particles` up until the frame starts to cost something, then find the number just below it.',
  'Change ONE thing in `sketch.js` at a time (the respawn rule, the brightness mapping, the veil) and keep what survives.',
]

/** The two generated documents, from the one place that writes them. */
async function documentsOf(spec) {
  return {
    readme: readmeOf({
      label: spec.label,
      id: spec.id,
      concept: spec.concept,
      seed: spec.seed,
      runtimeLabel: label,
      files: FILES,
      where: WHERE,
      params: spec.params,
      paramNotes: spec.paramNotes,
    }),
    notes: notesOf({
      slug: spec.slug,
      concept: spec.concept,
      seed: spec.seed,
      seedWhere: 'the `seed` field of `window.__LAB` in `index.html`, or `?seed=N`',
      runtimeLabel: label,
      runtimeNote: 'the browser draws it; nothing is installed and nothing is compiled',
      look: LOOK,
      try_: TRY,
    }),
  }
}

/**
 * Every file of a new p5.js run.
 *
 * @param spec - `{ slug, id, concept, seed, params, label, env }`.
 * @returns `{ path, content }[]`.
 */
export async function scaffold(spec) {
  const seed = integerOf(spec.seed, DEFAULT_SEED)
  const params = spec.params
  const slug = spec.slug
  const label = spec.label ?? slug
  const concept = spec.concept
  const values = {
    SLUG: slug,
    LABEL: label,
    CONCEPT: concept,
    SEED: String(seed),
    SEED_JSON: jsLiteral(seed),
    RUNTIME: id,
    RUNTIME_JSON: jsLiteral(id),
    SLUG_JSON: jsLiteral(slug),
    LABEL_JSON: jsLiteral(label),
    CONCEPT_JSON: jsLiteral(concept),
    PARAMS_JSON: JSON.stringify(params, null, 2),
  }
  const documents = await documentsOf({ slug, id: spec.id ?? id + '/' + slug, label, concept, seed, params })

  return [
    { path: 'index.html', content: substitute(await template('index.html'), values) },
    { path: 'sketch.js', content: substitute(await template('sketch.js'), values) },
    { path: 'README.md', content: documents.readme },
    { path: 'NOTES.md', content: documents.notes },
    // The library is read, not templated: it is somebody else's bytes, and it is
    // copied into the run so the run is a folder that works on its own.
    ...(await library()),
  ]
}

/**
 * Whether a run is still a p5.js prototype that will actually draw.
 *
 * Each rule is a mistake that has been made in a real sketch, and each message
 * says what to DO - the model reads this and fixes it in one pass.
 *
 * @param run - `{ dir, files, bytes, env }`.
 * @returns `{ severity, code, message, file }[]`.
 */
export async function lint(run) {
  const found = []
  const has = (name) => run.files.includes(name)
  const read = async (name) => (has(name) ? fsp.readFile(path.join(run.dir, name), 'utf8') : null)

  const html = await read('index.html')
  const sketch = await read('sketch.js')
  const shellPresent = html !== null
  if (!shellPresent) {
    found.push({ severity: 'error', code: 'no-shell', message: 'a p5.js run has an index.html shell - re-run `lab_new` for this slug to regenerate it', file: null })
  }
  if (sketch === null) {
    found.push({ severity: 'error', code: 'no-sketch', message: 'a p5.js run has a sketch.js - that is the prototype', file: null })
  }
  if (!has('p5.min.js')) {
    found.push({ severity: 'warn', code: 'no-library', message: 'p5.min.js is not in this run: it will not open offline (`lab_new` writes it)', file: null })
  }
  if (html !== null) {
    // The reference is matched as a SCRIPT TAG, not as a bare string: the shell's
    // own comments name both files, so a substring test would pass on a shell
    // that had stopped loading either one.
    if (!/<script[^>]*\ssrc=["'](?:\.\/)?sketch\.js["']/i.test(html)) {
      found.push({ severity: 'error', code: 'shell-no-sketch', message: 'index.html does not load sketch.js (the shell must reference it with <script src="sketch.js">)', file: 'index.html' })
    }
    if (!/<script[^>]*\ssrc=["'](?:\.\/)?p5\.min\.js["']/i.test(html)) {
      found.push({ severity: 'warn', code: 'shell-no-library', message: 'index.html does not load p5.min.js with a script tag, so nothing defines createCanvas', file: 'index.html' })
    }
    const remote = html.match(/https?:\/\/[^"'`)\s]+/g) ?? []
    if (remote.length > 0) {
      found.push({
        severity: 'error',
        code: 'remote-asset',
        message: 'a lab run is offline: ' + remote[0] + ' would be fetched from the network (vendor the file beside the run instead)',
        file: 'index.html',
      })
    }
  }
  if (sketch !== null) {
    if (!/\bfunction\s+setup\s*\(/.test(sketch)) found.push({ severity: 'error', code: 'no-setup', message: 'sketch.js defines no `function setup()` - p5 calls it once to build the canvas', file: 'sketch.js' })
    if (!/\bfunction\s+draw\s*\(/.test(sketch)) found.push({ severity: 'error', code: 'no-draw', message: 'sketch.js defines no `function draw()` - p5 calls it every frame', file: 'sketch.js' })
    if (!/\b(randomSeed|noiseSeed)\s*\(/.test(sketch)) {
      found.push({ severity: 'error', code: 'unseeded', message: 'sketch.js never seeds: call randomSeed(window.__LAB.seed) and noiseSeed(window.__LAB.seed) so a seed always gives the same picture', file: 'sketch.js' })
    }
    if (!/__LAB/.test(sketch)) {
      found.push({ severity: 'warn', code: 'no-lab-object', message: 'sketch.js does not read `window.__LAB`, so the seed and the sliders cannot reach it', file: 'sketch.js' })
    }
    if (!/__LAB\.drew/.test(sketch) && !/\bspec\.drew\s*=/.test(sketch)) {
      found.push({ severity: 'warn', code: 'no-drew-flag', message: 'set `window.__LAB.drew = true` (or `spec.drew` when `spec` is `window.__LAB`) at the end of the first draw() so the shell and the render check can tell a drawn frame from a black one', file: 'sketch.js' })
    }
    const remote = sketch.match(/https?:\/\/[^"'`)\s]+/g) ?? []
    if (remote.length > 0) {
      found.push({ severity: 'error', code: 'remote-asset', message: 'sketch.js references ' + remote[0] + ' - a run is offline; keep anything it needs beside it', file: 'sketch.js' })
    }
    const loads = sketch.match(/\bload(Image|Font|Table|Strings|JSON|Bytes|XML)\s*\(\s*['"]([^'"]+)['"]/g) ?? []
    for (const call of loads) {
      found.push({
        severity: 'warn',
        code: 'loads-a-file',
        message: call + ' loads a file beside the run: it works when index.html is opened directly, but NOT in the app\'s preview, which composes one self-contained page',
        file: 'sketch.js',
      })
    }
    if (!/\bcreateCanvas\s*\(/.test(sketch) && !/new\s+p5\s*\(/.test(sketch)) {
      found.push({ severity: 'warn', code: 'no-canvas', message: 'sketch.js never calls createCanvas - a run is a canvas in a page', file: 'sketch.js' })
    }

    // QUICK APPS. A sketch in a browser shares its one thread with the interface,
    // so an allocation inside draw() is not a style question - it is the reason
    // the frame time grows with the population and the controls start to lag.
    // These are the three shapes that actually show up in generated sketches, and
    // each message names the RULE rather than the syntax.
    const drawBody = extractFunction(sketch, 'draw')
    if (drawBody !== null) {
      const allocates = drawBody.match(/\bnew\s+(Array|Map|Set|Float32Array|Uint8Array|Uint8ClampedArray|Object)\s*\(/g) ?? []
      if (allocates.length > 0) {
        found.push({
          severity: 'warn',
          code: 'allocates-in-draw',
          message: 'draw() allocates (' + allocates[0] + ') every frame: build the buffer once in setup() and reuse it - one frame at 60 fps is ' + BUDGETS.frameMs.toFixed(1) + ' ms in total',
          file: 'sketch.js',
        })
      }
      if (/\bfor\s*\([^)]*\b(width|height)\b/.test(drawBody) || /\bloadPixels\s*\(/.test(drawBody)) {
        found.push({
          severity: 'warn',
          code: 'per-pixel-loop',
          message: 'draw() walks the whole canvas every frame: a per-pixel pass belongs in a buffer built once, or in a shader',
          file: 'sketch.js',
        })
      }
    }
    const population = /['"]particles['"][^}]*?\bvalue\s*:\s*(\d+)/.exec(html ?? '')
    if (population !== null) {
      const count = Number(population[1])
      if (count > BUDGETS.heavyParticles) {
        found.push({
          severity: 'warn',
          code: 'heavy-population',
          message: 'the run opens with ' + count + ' particles, past the ' + BUDGETS.heavyParticles + ' this lab treats as heavy: open lower and raise it with the slider while you watch the frame',
          file: 'index.html',
        })
      }
    }
  }
  return found
}

/**
 * The body of one top-level function, balanced by braces.
 *
 * A regex cannot find the end of a JavaScript function, and the quick-app rules
 * below have to look INSIDE `draw()` - a `new Array(...)` in `setup()` is exactly
 * right and the same line in `draw()` is the bug. So the body is taken by walking
 * the braces from the function's opening one.
 *
 * @param source - the file's text.
 * @param name - the function to extract.
 * @returns the body, or null when the function is not there as a declaration.
 */
export function extractFunction(source, name) {
  const start = new RegExp('\\bfunction\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(String(source))
  if (start === null) return null
  let depth = 1
  let index = start.index + start[0].length
  const from = index
  for (; index < source.length && depth > 0; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
  }
  return depth === 0 ? source.slice(from, index - 1) : null
}

/**
 * Every example this runtime ships, read from beside its skill.
 *
 * A sibling of the template files and NOT a copy of a lab run: examples are
 * committed (the lab is not), so they are the only p5.js runs that survive a
 * fresh clone, and `lab_new action=example` copies one into the lab. `example.json`
 * carries the same fields a scaffold records, so an instantiated example appears
 * in the catalog exactly like a generated run.
 *
 * @param options - `{ kitDir }` (defaults to this runtime's skill folder).
 * @returns `{ id, slug, label, concept, seed, dir, files }[]`.
 */
export async function examples(options = {}) {
  const root = options.kitDir ?? path.join(SKILL_DIR, 'examples')
  let names = []
  try {
    names = (await fsp.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (err) {
    return []
  }
  const found = []
  for (const name of names.sort()) {
    if (!isSlug(name)) continue
    const dir = path.join(root, name)
    let meta = null
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, 'example.json'), 'utf8'))
    } catch (err) {
      // A folder that is not an example is skipped; one that claims to be an
      // example and cannot be read IS a failure, because it would be an example
      // the tools offer and cannot instantiate.
      if (await present(path.join(dir, 'example.json'))) {
        throw new LabError('example ' + name + ' has an unreadable example.json: ' + messageOf(err), 'EXAMPLE_META')
      }
      continue
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) continue
    const files = (await walk(dir)).filter((file) => path.basename(file) !== 'p5.min.js' && path.basename(file) !== 'example.json')
    found.push({
      id: id + '/' + name,
      slug: String(meta.slug ?? name),
      label: String(meta.label ?? name),
      concept: String(meta.concept ?? ''),
      seed: integerOf(meta.seed, 0),
      params: String(meta.params ?? ''),
      paramsTable: Array.isArray(meta.paramsTable) ? meta.paramsTable : null,
      dir,
      files,
    })
  }
  return found
}

/**
 * The files an example turns into: its own bytes, the shell it runs in, its
 * documents, and the library.
 *
 * The shell is NOT part of an example folder and must not be: `index.html` is
 * generated, and an example that carried its own copy would be a second thing to
 * keep in step with the runtime - the exact drift the generated shell exists to
 * prevent. An example carries the one file that is the prototype (`sketch.js`)
 * plus its metadata, and gets the same shell a scaffold writes.
 *
 * @param example - one entry from `examples()`.
 * @returns `{ path, content }[]`.
 */
export async function materialize(example) {
  const values = {
    SLUG: example.slug,
    LABEL: example.label,
    CONCEPT: example.concept,
    SEED: String(example.seed),
    SEED_JSON: jsLiteral(example.seed),
    RUNTIME: id,
    RUNTIME_JSON: jsLiteral(id),
    SLUG_JSON: jsLiteral(example.slug),
    LABEL_JSON: jsLiteral(example.label),
    CONCEPT_JSON: jsLiteral(example.concept),
    PARAMS_JSON: JSON.stringify(example.paramsTable ?? DEFAULT_PARAMS, null, 2),
  }
  const files = [{ path: 'index.html', content: substitute(await template('index.html'), values) }]
  for (const name of example.files) {
    const text = await fsp.readFile(path.join(example.dir, name), 'utf8')
    files.push({ path: name, content: substitute(text, values) })
  }
  const documents = await documentsOf({
    slug: example.slug,
    id: example.id,
    label: example.label,
    concept: example.concept,
    seed: example.seed,
    params: example.paramsTable ?? DEFAULT_PARAMS,
    paramNotes: example.params === '' ? undefined : example.params,
  })
  files.push({ path: 'README.md', content: documents.readme })
  files.push({ path: 'NOTES.md', content: documents.notes })
  files.push(...(await library()))
  return files
}

/** The vendored library's digest, so a check can prove the run's copy is the package's. */
export async function libraryDigest() {
  return digest(await fsp.readFile(VENDOR))
}

/**
 * The runtime as one object, which is the shape the registry registers.
 *
 * The named exports above stay, because they are what a person reads and what a
 * test drives one at a time; this is the assembly, and it lives at the END of the
 * file so every method is defined by the time it is built.
 */
export default {
  id,
  label,
  kind,
  tagline,
  extensions,
  defaultParams,
  detect,
  scaffold,
  materialize,
  lint,
  examples,
  library,
  libraryDigest,
  extractFunction,
}