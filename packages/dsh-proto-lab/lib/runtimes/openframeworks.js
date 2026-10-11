/**
 * dsh-proto-lab — the openFrameworks runtime.
 *
 * openFrameworks is the runtime that produces an APP: three C++ files that a
 * projectGenerator turns into a project and a toolchain turns into a window. It is
 * deliberately the opposite of p5.js in this lab, and the difference is the point
 * - a prototype that must be walked past, hovered over and left running is a
 * different animal from one that is looked at, and the lab carries both.
 *
 * WHAT A RUN IS
 *
 *   src/ofApp.h     the prototype's declaration: state, params, the virtuals
 *   src/ofApp.cpp   the prototype: setup(), update(), draw()
 *   src/main.cpp    the window, the loop, and the headless switches
 *   addons.make     which addons the project needs (empty by default)
 *   README.md       what it is, and the exact command that makes it build
 *   NOTES.md        the seed, what to look at, what to try
 *   .gitignore      obj/, bin/<slug> and the shared libs: the APP IS NEVER COMMITTED
 *
 * WHY THE PROJECT FILES ARE NOT SHIPPED
 *
 * `config.make` and a platform project file are not source; they are the
 * projectGenerator's output for one openFrameworks version on one platform, and a
 * checked-in copy of them is wrong the moment either changes - a broken build is
 * worse than an absent one, because it looks like the run's fault. So this runtime
 * writes the three files that ARE the prototype, plus the two facts a tool needs
 * (`addons.make`, and a `.gitignore` that keeps build output out of the
 * repository), and the README carries the one command that fills the rest in.
 * That is also why the scaffold needs no openFrameworks installed: writing a
 * prototype must never depend on a 500 MB download.
 *
 * WHAT "CHECKED" MEANS HERE
 *
 * Without openFrameworks the lint is structural - the three files exist, ofApp.h
 * declares the virtuals, ofApp.cpp defines every one of them, main.cpp really
 * starts the loop. WITH openFrameworks (found through `DSH_OF_ROOT`/`OF_ROOT` or
 * the standard install locations) it is a real compile: `g++ -fsyntax-only` over
 * the run's sources against the install's own include paths. The structural half
 * runs everywhere and always; the compile half is the one that can prove the C++
 * is C++, and it says so loudly when it cannot run rather than passing quietly.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runProcess } from '../capabilities.js'
import { LabError } from '../lab.js'
import { notesOf, readmeOf } from '../describe.js'
import { integerOf, jsLiteral, slugify, substitute } from '../util.js'

/** This runtime's name, everywhere. */
export const id = 'openframeworks'
/** What a person reads in `lab_runtimes`. */
export const label = 'openFrameworks'
/** A toolchain builds it. */
export const kind = 'native'
/** One line for the tools' answers. */
export const tagline = 'Three C++ files that become an app: ofApp::setup() and ofApp::draw(), built with the projectGenerator.'
/** The extensions an openFrameworks run may contain. */
export const extensions = ['.cpp', '.h', '.hpp', '.cc', '.mk', '.make', '.json', '.md', '.txt', '.glsl', '.frag', '.vert']

/** The root overrides, in the order they are tried. */
export const ROOT_VARS = ['DSH_OF_ROOT', 'OF_ROOT']
/** Where a real install usually sits, per platform. */
const COMMON_ROOTS = [
  'of',
  'openFrameworks',
  'Documents/of',
  'Documents/openFrameworks',
  'Desktop/of',
  'dev/of',
  'code/of',
]

/** Where this runtime's templates live, and where its examples live. */
const here = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES = path.join(here, 'templates')
const SKILL_DIR = path.join(path.dirname(path.dirname(here)), 'skills', 'openframeworks-prototypes')

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
 * Whether a directory is an openFrameworks root.
 *
 * The marker is `libs/openFrameworks/ofMain.h`, the header every openFrameworks
 * translation unit includes first. A folder that merely has an `of_v...` name is
 * not an install: the name survives a download that was never unpacked, and a run
 * that "found" one would fail to compile for a reason the user cannot see.
 *
 * @param dir - the candidate.
 * @returns `{ ok, version }` - the version is read from the folder or the header.
 */
async function inspectRoot(dir) {
  const header = path.join(dir, 'libs', 'openFrameworks', 'ofMain.h')
  try {
    const stat = await fsp.stat(header)
    if (!stat.isFile()) return { ok: false, version: null }
  } catch (err) {
    return { ok: false, version: null }
  }
  // `of_v0.12.1_vs_release` / `of_v0.12.0_osx_release` both carry the version.
  const match = /(?:^|[\\/])of_v?(\d+\.\d+(?:\.\d+)?)[^\\/]*$/.exec(dir)
  return { ok: true, version: match === null ? null : match[1] }
}

/**
 * The openFrameworks install on this machine, or why there is none.
 *
 * Search order: the two documented overrides, then `of_v*` folders in the home
 * directory and in the usual development folders, then the platform's own
 * locations. The answer names every path it tried, because "set DSH_OF_ROOT to
 * your openFrameworks folder" is only actionable next to the list of what was
 * looked for.
 *
 * @param options - `{ env, platform }`.
 * @returns `{ root, version, source, candidates }`.
 */
export async function findRoot(options = {}) {
  const env = options.env ?? process.env
  const candidates = []
  for (const name of ROOT_VARS) {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    if (value === '') continue
    const root = path.resolve(value)
    candidates.push(root)
    const inspected = await inspectRoot(root)
    if (inspected.ok) return { root, version: inspected.version, source: name, candidates }
  }

  const home = os.homedir()
  const seeds = [home, ...COMMON_ROOTS.map((relative) => path.join(home, relative))]
  for (const base of seeds) {
    let names = []
    try {
      names = (await fsp.readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^of_v?\d/.test(entry.name))
        .map((entry) => entry.name)
    } catch (err) {
      continue
    }
    for (const name of names.sort().reverse()) {
      const root = path.join(base, name)
      candidates.push(root)
      const inspected = await inspectRoot(root)
      if (inspected.ok) return { root, version: inspected.version, source: 'standard location', candidates }
    }
  }
  return { root: null, version: null, source: null, candidates }
}

/** What a built app is called, per platform. */
function appFileName(slug) {
  return process.platform === 'win32' ? slug + '.exe' : slug
}

/**
 * What the openFrameworks runtime needs on this machine.
 *
 * @param options - `{ env }`.
 * @returns `{ available, summary, detail, commands }`.
 */
export async function detect(options = {}) {
  const found = await findRoot({ env: options.env })
  const candidates = options.detailed === true ? found.candidates : found.candidates.slice(-6)
  const compiler = process.env.CXX ?? (process.platform === 'win32' ? 'g++' : 'c++')
  const probe = runProcess({ file: compiler, args: ['--version'], timeoutMs: 20000 })
  // Three answers, not two: a compiler that is missing, one that works, and one
  // this process is not allowed to execute. Collapsing the third into "missing" is
  // how a lint ends up blaming the user's C++ for the confinement.
  const compilerState = probe.ok ? 'found' : probe.blocked ? 'blocked (this process may not run it)' : 'NOT found'
  const hasCompiler = probe.ok || probe.blocked
  const detail = [
    'sources: src/main.cpp, src/ofApp.h, src/ofApp.cpp - written by lab_new, ready to build',
    'generator: the openFrameworks projectGenerator makes config.make and the platform project',
  ]
  const commands = []
  if (found.root === null) {
    detail.push('openFrameworks: NOT FOUND')
    detail.push('  looked in: ' + (candidates.length === 0 ? '(nothing to look in)' : candidates.join(', ')))
    detail.push('  set DSH_OF_ROOT (or OF_ROOT) to your openFrameworks folder, e.g. C:\\of_v0.12.1_vs_release')
    detail.push('  download: https://openframeworks.cc/download/ (the plugin never downloads it for you)')
    detail.push('compiler: ' + compiler + ' ' + compilerState)
  } else {
    detail.push('openFrameworks: ' + found.root + (found.version === null ? '' : ' (v' + found.version + ')') + ' via ' + found.source)
    detail.push('compiler: ' + compiler + ' ' + compilerState)
    commands.push('run the projectGenerator over the run folder, then `make` (or open the generated project)')
  }
  return {
    available: true,
    summary:
      found.root === null
        ? 'a run can be written anywhere; building it needs openFrameworks, which is not on this machine'
        : 'ready - openFrameworks ' + (found.version ?? '(version not in the folder name)') + ' at ' + found.root,
    detail,
    commands,
  }
}

/** The files an openFrameworks run carries, as the README describes them. */
const FILES = [
  { path: 'src/ofApp.h', what: 'the prototype\'s declaration: state, params, the virtuals' },
  { path: 'src/ofApp.cpp', what: '**the prototype.** `setup()`, `update()`, `draw()`. Edit this.' },
  { path: 'src/main.cpp', what: 'the window, the loop, `--seed` / `--frames` / `--headless` / `--png`' },
  { path: 'addons.make', what: 'the addons this project needs. Empty by default.' },
  { path: 'NOTES.md', what: 'the seed, what to look at, what to try next.' },
]

/**
 * How to turn the three files into an app.
 *
 * The projectGenerator is the only correct source of `config.make` and the
 * platform project - they belong to one openFrameworks version on one platform -
 * so the run carries this paragraph instead of a stale copy of them.
 */
function whereToBuild(slug) {
  return [
    '## Build it',
    '',
    'No build files and no app are committed or shipped: `config.make` and the platform',
    'project belong to one openFrameworks version on one platform, and the executable is',
    'build output. `.gitignore` keeps both out of the repository.',
    '',
    '1. Let the projectGenerator fill in the build files for YOUR openFrameworks and platform:',
    '',
    '   ```',
    '   # macOS / Linux',
    '   $OF_ROOT/projectGenerator/projectGenerator -o"$(pwd)" -p$(uname -s | tr \'[:upper:]\' \'[:lower:]\') .',
    '   # Windows (PowerShell), Visual Studio',
    '   & "$env:OF_ROOT\\projectGenerator\\projectGenerator.exe" -o"$PWD" -pvs .',
    '   ```',
    '',
    '   It takes a folder that already looks like a project and adds `config.make`, `Makefile`',
    '   and the platform files beside these sources. Re-run it after adding an addon to',
    '   `addons.make`.',
    '',
    '2. Build and run:',
    '',
    '   ```',
    '   make && make RunRelease      # Makefile platforms (macOS, Linux, MinGW)',
    '   # or open the generated .sln / .xcodeproj and press Run',
    '   ```',
    '',
    '3. Headless, which is how a check (or a script) proves it drew something:',
    '',
    '   ```',
    '   ./bin/' + appFileName(slug) + ' --headless --frames 120 --png frame.png',
    '   ```',
  ].join('\n')
}

/** The observations this runtime's own algorithm invites. */
const LOOK = [
  'Where the flow is calm and where it churns: that is `noiseScale`, not the particles.',
  'Let it run for a minute. A system with a lifecycle keeps arriving; a still picture settles.',
]
/** The moves worth making first. */
const TRY = [
  'Move `kSeed`, build, and keep the field that reads as one gesture.',
  'Raise `params.particles` until the frame starts to cost something, then back off.',
  'Change ONE thing at a time (the respawn rule, the brightness mapping, the veil) and keep what survives.',
  '`update()` is where time lives. If something looks frame-rate dependent, it is advancing in `draw()`.',
]

/** What a person has to know about the numbers, in one paragraph. */
const PARAM_NOTES =
  '`src/ofApp.h` holds the `Params` struct and `kSeed`; `src/ofApp.cpp` is the algorithm. ' +
  'Keys: `r` a new field, `n` noise scale, `f` flow, `c` clear, space saves a PNG.'

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
      where: whereToBuild(spec.slug),
      params: [],
      paramNotes: spec.paramNotes ?? PARAM_NOTES,
    }),
    notes: notesOf({
      slug: spec.slug,
      concept: spec.concept,
      seed: spec.seed,
      seedWhere: '`kSeed` in `src/ofApp.h`, or `--seed N` at run time',
      runtimeLabel: label,
      runtimeNote: 'C++, built by your own install - nothing is shipped',
      look: LOOK,
      try_: TRY,
    }),
  }
}

/** The repo-hygiene file that keeps build output and the app out of every commit. */
function gitignore(slug) {
  return [
    '# Build output. The app is NEVER committed: it is 5 MB and it is a function',
    '# of this machine\'s toolchain, not of the source in src/.',
    'obj/',
    'bin/' + slug,
    'bin/' + slug + '.exe',
    'bin/' + slug + '.app',
    'bin/*.dSYM/',
    'libs/',
    '*.o',
    '*.d',
    '*.a',
    '*.so',
    '*.dylib',
    '*.dll',
    '',
    '# The projectGenerator\'s output for YOUR openFrameworks and platform. It is',
    '# regenerated by one command (see README.md) and is wrong on any other machine,',
    '# so it is not content either.',
    '/Makefile',
    '/config.make',
    '*.sln',
    '*.vcxproj',
    '*.vcxproj.*',
    '*.xcodeproj/',
    '',
    '# bin/data/ IS content - a prototype\'s assets belong in the repository.',
    '!bin/data/',
    '!bin/data/**',
    '',
  ].join('\n')
}

/**
 * Every file of a new openFrameworks run.
 *
 * @param spec - `{ slug, id, concept, seed, params, env }`.
 * @returns `{ path, content }[]`.
 */
export async function scaffold(spec) {
  const seed = integerOf(spec.seed, 0)
  const label = spec.label ?? spec.slug
  const values = {
    SLUG: spec.slug,
    LABEL: label,
    CONCEPT: spec.concept,
    SEED: String(seed),
    SEED_JSON: jsLiteral(seed),
    RUNTIME: id,
  }
  return [
    { path: 'src/ofApp.h', content: substitute(await template('ofApp.h'), values) },
    { path: 'src/ofApp.cpp', content: substitute(await template('ofApp.cpp'), values) },
    { path: 'src/main.cpp', content: substitute(await template('main.cpp'), values) },
    { path: 'addons.make', content: '# One addon per line, then re-run the projectGenerator (see README.md).\n' },
    { path: 'bin/data/.gitkeep', content: '' },
    { path: '.gitignore', content: gitignore(spec.slug) },
    ...(await extras({ slug: spec.slug, id: spec.id ?? id + '/' + spec.slug, label, concept: spec.concept, seed })),
  ]
}

/** The documents and the project's own two facts, from one place. */
async function extras(spec) {
  const documents = await documentsOf(spec)
  return [
    { path: 'README.md', content: documents.readme },
    { path: 'NOTES.md', content: documents.notes },
  ]
}

/**
 * The include paths an openFrameworks compile needs under one install.
 *
 * Only the ones that exist are returned, so an install laid out slightly
 * differently still gets as far as it can rather than failing on a path that was
 * never there.
 *
 * @param root - the openFrameworks root.
 * @returns the `-I` list.
 */
async function includePaths(root) {
  const bases = [
    'libs/openFrameworks',
    'libs/openFrameworks/3d',
    'libs/openFrameworks/app',
    'libs/openFrameworks/communication',
    'libs/openFrameworks/events',
    'libs/openFrameworks/gl',
    'libs/openFrameworks/graphics',
    'libs/openFrameworks/math',
    'libs/openFrameworks/sound',
    'libs/openFrameworks/types',
    'libs/openFrameworks/utils',
    'libs/openFrameworks/video',
    'libs/glm/include',
    'libs/glfw/include',
    'libs/freetype/include',
    'libs/freetype/include/freetype2',
    'libs/utf8/include',
    'libs/json/include',
    'libs/tess2/include',
    'libs/uriparser/include',
    'libs/pugixml/include',
    'libs/curl/include',
    'libs/rtAudio/include',
    'libs/glm/include/glm',
  ]
  const found = []
  for (const base of bases) {
    const full = path.join(root, base)
    try {
      const stat = await fsp.stat(full)
      if (stat.isDirectory()) found.push(full)
    } catch (err) {
      /* an install need not carry every library */
    }
  }
  return found
}

/**
 * A real syntax check of a run's sources against one openFrameworks install.
 *
 * `-fsyntax-only` is the right depth: it parses and type-checks every line the
 * compiler would see, and it needs no link step, no GL context and no 5 MB
 * executable in the run folder. That is exactly the claim a run should have to
 * support - "this is C++ that compiles against openFrameworks" - without this
 * package ever building anything the user did not ask it to.
 *
 * @param options - `{ dir, files, root, compiler, machine }`.
 * @returns `{ ok, blocked, compiler, output, includeCount, skipped, reason }`.
 */
export async function syntaxCheck(options) {
  const sources = options.files.filter((file) => /^src\/.*\.(cpp|cc)$/.test(file)).map((file) => path.join(options.dir, file))
  if (sources.length === 0) {
    return { ok: false, blocked: false, compiler: null, output: 'no src/*.cpp to check', includeCount: 0, skipped: true, reason: 'the run has no C++ translation unit' }
  }
  const includes = await includePaths(options.root)
  // The compiler is chosen from what the HOST probe actually found on PATH -
  // never a bare `c++` that may not exist on Windows - and a refused child is
  // reported as refused.
  const detected = options.machine?.compilers?.[0]
  const compiler = options.compiler ?? (detected === undefined ? process.env.CXX ?? (process.platform === 'win32' ? 'g++' : 'c++') : detected.name)
  const args = [
    '-fsyntax-only',
    '-std=c++17',
    '-I' + path.join(options.dir, 'src'),
    ...includes.map((include) => '-I' + include),
    ...sources,
  ]
  const result = runProcess({ file: compiler, args, timeoutMs: 120_000 })
  if (result.blocked) {
    return { ok: false, blocked: true, compiler, output: result.reason, includeCount: includes.length, skipped: false, reason: result.reason }
  }
  if (result.status === null) {
    return { ok: false, blocked: false, compiler, output: result.reason, includeCount: includes.length, skipped: false, reason: result.reason }
  }
  const output = result.output
  return { ok: result.status === 0, blocked: false, compiler, output: output.trim(), includeCount: includes.length, skipped: false, reason: result.reason }
}

/**
 * Whether a run is still an openFrameworks prototype, structurally and - when
 * openFrameworks is installed - by actually compiling it.
 *
 * @param run - `{ dir, files, bytes, env }`.
 * @returns `{ severity, code, message, file }[]`.
 */
export async function lint(run) {
  const found = []
  const has = (name) => run.files.includes(name)
  const read = async (name) => (has(name) ? fsp.readFile(path.join(run.dir, name), 'utf8') : null)

  const header = await read('src/ofApp.h')
  const source = await read('src/ofApp.cpp')
  const main = await read('src/main.cpp')

  if (header === null) found.push({ severity: 'error', code: 'no-header', message: 'an openFrameworks run has src/ofApp.h declaring the app class', file: null })
  if (source === null) found.push({ severity: 'error', code: 'no-source', message: 'an openFrameworks run has src/ofApp.cpp - that is the prototype', file: null })
  if (main === null) found.push({ severity: 'error', code: 'no-main', message: 'an openFrameworks run has src/main.cpp opening the window and starting the loop', file: null })

  if (header !== null) {
    if (!/class\s+ofApp\s*:\s*public\s+ofBaseApp/.test(header)) {
      found.push({ severity: 'error', code: 'not-an-app', message: 'src/ofApp.h declares no `class ofApp : public ofBaseApp`', file: 'src/ofApp.h' })
    }
    for (const method of ['setup', 'update', 'draw']) {
      if (!new RegExp('\\b' + method + '\\s*\\(').test(header)) {
        found.push({ severity: 'error', code: 'header-missing-' + method, message: 'src/ofApp.h declares no `' + method + '()` - openFrameworks calls it', file: 'src/ofApp.h' })
      }
    }
  }
  if (source !== null && header !== null) {
    for (const method of ['setup', 'update', 'draw']) {
      if (!new RegExp('void\\s+ofApp::' + method + '\\s*\\(').test(source)) {
        found.push({ severity: 'error', code: 'source-missing-' + method, message: 'src/ofApp.cpp defines no `void ofApp::' + method + '()` - the header declares it', file: 'src/ofApp.cpp' })
      }
    }
    if (/\bofApp::draw\s*\([^)]*\)\s*\{[^}]*\b(time|age|position)\s*\+=/s.test(source)) {
      found.push({
        severity: 'warn',
        code: 'time-in-draw',
        message: 'src/ofApp.cpp looks like it advances state inside draw(); move it to update() so the frame rate cannot change the behaviour',
        file: 'src/ofApp.cpp',
      })
    }
  }
  if (main !== null && !/\bofRunApp\s*\(/.test(main)) {
    found.push({ severity: 'error', code: 'main-no-loop', message: 'src/main.cpp never calls ofRunApp - nothing would run', file: 'src/main.cpp' })
  }

  // The compile half. Without an install it is reported as a NOTE, never as a
  // pass: a structural lint that claimed "it compiles" would be the exact lie
  // this check exists to prevent.
  const root = await findRoot({ env: run.env })
  if (root.root === null) {
    found.push({
      severity: 'warn',
      code: 'not-compiled',
      message: 'openFrameworks was not found, so the C++ was checked structurally and NOT compiled (set DSH_OF_ROOT to compile it)',
      file: null,
    })
  } else {
    const checked = await syntaxCheck({ dir: run.dir, files: run.files, root: root.root, machine: run.machine })
    if (checked.blocked) {
      // The compiler is installed and this process is not allowed to run it.
      // That is a fact about the confinement, and saying it is NOT the same as
      // saying the C++ is wrong - which is the answer a wrong `compile-failed`
      // would give.
      found.push({
        severity: 'warn',
        code: 'not-compiled',
        message: 'the C++ was checked structurally and NOT compiled: ' + checked.reason + ' (re-run outside the confinement to compile it)',
        file: null,
      })
    } else if (!checked.ok) {
      const first = firstCompilerError(checked.output)
      found.push({
        severity: 'error',
        code: 'compile-failed',
        message: 'the C++ does not compile against openFrameworks' + (root.version === null ? '' : ' ' + root.version) + ' with ' + String(checked.compiler) + ': ' + first,
        file: null,
      })
    }
  }
  return found
}

/** The first line of a compiler's output that is actually a diagnosis. */
export function firstCompilerError(output) {
  const lines = String(output ?? '').split('\n')
  const error = lines.find((line) => /:\s+error:/.test(line))
  if (error !== undefined) return error.trim().slice(0, 400)
  const first = lines.find((line) => line.trim() !== '')
  return first === undefined ? '(the compiler printed nothing)' : first.trim().slice(0, 400)
}

/**
 * Every example this runtime ships, read from beside its skill.
 *
 * An example folder carries the SAME file names a run has - `src/ofApp.h`,
 * `src/ofApp.cpp`, optionally its own `src/main.cpp` - plus `example.json`. A
 * `src/main.cpp` that is absent means "use the runtime's template", so an example
 * that wants the standard window and headless switches does not fork them.
 *
 * @param options - `{ kitDir }`.
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
    if (slugify(name) !== name) continue
    const dir = path.join(root, name)
    let meta = null
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, 'example.json'), 'utf8'))
    } catch (err) {
      // A folder that is not an example is skipped; one that claims to be an
      // example and cannot be read IS a failure, because it would be an example
      // the tools offer and then fail to instantiate.
      if (await present(path.join(dir, 'example.json'))) {
        throw new LabError('example ' + name + ' has an unreadable example.json: ' + messageOf(err), 'EXAMPLE_META')
      }
      continue
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) continue
    const slug = String(meta.slug ?? name)
    const files = (await walk(dir)).filter((file) => path.basename(file) !== 'example.json')
    if (!files.includes('src/ofApp.h') || !files.includes('src/ofApp.cpp')) {
      throw new LabError('example ' + name + ' is not an openFrameworks run: src/ofApp.h and src/ofApp.cpp are required', 'EXAMPLE_FILES')
    }
    found.push({
      id: id + '/' + slug,
      slug,
      label: String(meta.label ?? slug),
      concept: String(meta.concept ?? ''),
      seed: integerOf(meta.seed, 0),
      params: String(meta.params ?? ''),
      dir,
      files,
    })
  }
  return found
}

/**
 * The files an example turns into: its own sources, the runtime's template for
 * anything it did not carry, and the documents and facts every run has.
 *
 * @param example - one entry from `examples()`.
 * @returns `{ path, content }[]`.
 */
export async function materialize(example) {
  const values = { SLUG: example.slug, LABEL: example.label, CONCEPT: example.concept, SEED: String(example.seed) }
  const files = []
  for (const name of example.files) {
    const text = await fsp.readFile(path.join(example.dir, name), 'utf8')
    files.push({ path: name, content: substitute(text, values) })
  }
  if (!example.files.includes('src/main.cpp')) {
    files.push({ path: 'src/main.cpp', content: substitute(await template('main.cpp'), values) })
  }
  files.push({ path: 'addons.make', content: '# One addon per line, then re-run the projectGenerator (see README.md).\n' })
  files.push({ path: 'bin/data/.gitkeep', content: '' })
  files.push({ path: '.gitignore', content: gitignore(example.slug) })
  files.push(...(await extras({ ...example, paramNotes: example.params === '' ? undefined : example.params })))
  return files
}

/** openFrameworks ships no library a run must carry: this is honest about that. */
export async function library() {
  return []
}

/**
 * Compile a freshly scaffolded run, on the deepest tier this host supports.
 *
 * This is the "adaptable to the machine" half of the runtime, and it is the only
 * honest way to answer "does this lab's C++ actually compile": a check that never
 * compiled anything cannot say its templates are sound. It scaffolds into a
 * throwaway directory (so nothing in the workspace moves), compiles with
 * `-fsyntax-only`, and always removes the directory - including when the compile
 * fails, which is the case that matters.
 *
 * With no openFrameworks the answer is not a failure and not a pass: it says
 * which tier was reached, what the next one needs, and how to provide it.
 *
 * @param options - `{ env }`.
 * @returns `{ ok, tier, summary, detail }`.
 */
export async function checkScaffold(options = {}) {
  const env = options.env ?? process.env
  const found = await findRoot({ env })
  if (found.root === null) {
    return {
      ok: true,
      tier: 't0-structure',
      summary: 'structure only: no openFrameworks on this host, so nothing was compiled',
      detail: [
        'the template is checked structurally everywhere (ofBaseApp, the virtuals, the loop)',
        'set DSH_OF_ROOT (or OF_ROOT) to this machine\'s openFrameworks folder to compile it here',
      ],
    }
  }
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-proto-lab-of-'))
  try {
    const files = await scaffold({ slug: 'compile-probe', id: 'openframeworks/compile-probe', label: 'Compile probe', concept: 'A compile probe.', seed: 1, env })
    for (const file of files) {
      const target = path.join(scratch, file.path)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, file.content)
    }
    const checked = await syntaxCheck({ dir: scratch, files: files.map((file) => file.path), root: found.root })
    const compiler = checked.compiler ?? 'the C++ compiler'
    return {
      ok: checked.ok,
      tier: 't2-compile',
      summary: checked.ok
        ? 'the template compiles against openFrameworks ' + (found.version ?? '(version not in the folder name)') + ' with ' + compiler
        : 'the template does NOT compile against openFrameworks: ' + firstCompilerError(checked.output),
      detail: checked.ok
        ? ['include paths: ' + String(checked.includeCount) + ' from ' + found.root]
        : String(checked.output ?? '').split('\n').filter((line) => line.trim() !== '').slice(0, 6),
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The runtime as one object, which is the shape the registry registers.
 *
 * The named exports stay, because they are what a person reads and what this
 * package's own check drives one at a time (the syntax check in particular);
 * this is the assembly, at the END of the file so every method is defined.
 */
export default {
  id,
  label,
  kind,
  tagline,
  extensions,
  detect,
  scaffold,
  materialize,
  lint,
  examples,
  library,
  findRoot,
  syntaxCheck,
  checkScaffold,
}