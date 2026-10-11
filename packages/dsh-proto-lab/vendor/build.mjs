/**
 * dsh-proto-lab — the vendored p5.js build.
 *
 * p5.js is the one engine this plugin needs on BOTH sides of the app: the browser
 * draws a run, and the headless render check drives the same bytes to prove that
 * a generated sketch actually draws something (and that two seeds draw two
 * different things). The harness profile installs a bundle as a live LINK, so a
 * package dependency is never installed and the browser half cannot
 * `import 'p5'` - the library is therefore vendored, exactly like dsh-pdf's
 * pdf.js and dsh-diagrams' Mermaid.
 *
 * WHY 1.x AND NOT 2.x
 *
 * p5 2.x is ESM-first: its published `dist/` splits the library into modules that
 * import each other by bare specifier, and `browser: lib/p5.min.js` no longer
 * exists as a self-contained classic script. A self-contained browser file is
 * load-bearing here for two reasons that are not preferences:
 *
 *   - the harness's Connection fetch registry registers EXACT routes only, so a
 *     module graph would need one route per module;
 *   - a run is a FOLDER on disk that must work opened straight off the
 *     filesystem (`file://`), where a bare-specifier import cannot resolve at all.
 *
 * 1.11.13 is the last 1.x release. That is the line virtually every sketch, book
 * and tutorial in the world targets, so an agent writing p5 from memory is
 * writing 1.x, and a runtime that pins the line the ecosystem is on is the one
 * whose output runs.
 *
 * WHY THE LIBRARY IS COPIED INTO EVERY RUN
 *
 * `lib/runtimes/p5js.js` copies these bytes into `p5.min.js` beside `sketch.js`,
 * so a run is self-contained - movable, zippable, openable with no server and no
 * network. The alternative (a CDN, which is what most p5 examples do) is network
 * egress this pack does not ship, and it is also the difference between an
 * example that runs in five years and one that runs until somebody moves the CDN.
 *
 * Usage:
 *   node build.mjs            rebuild the vendored library from the pinned version
 *   node build.mjs --check    report drift against lib/vendor/VERSION.json
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.dirname(here)
const outDir = path.join(pkgRoot, 'lib', 'vendor')
const versionFile = path.join(outDir, 'VERSION.json')
const check = process.argv.includes('--check')

const pin = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
const version = pin.dependencies.p5
if (typeof version !== 'string' || version.length === 0) {
  console.error('[dsh-proto-lab/vendor] vendor/package.json pins no p5 version')
  process.exit(1)
}

/** The files copied out of the installed package: source path -> published name. */
const FILES = [
  ['lib/p5.min.js', 'p5.min.js'],
  ['license.txt', 'LICENSE'],
]

/** `sha256` of one file's bytes. */
function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Install the pin when it is not installed yet.
 *
 * `--ignore-scripts` because p5's own install hooks are for its build and test
 * tooling and this copy only reads two published files; `--no-audit --no-fund`
 * because neither is a statement about a tree nothing runs.
 */
function install() {
  if (existsSync(path.join(here, 'node_modules', 'p5', 'package.json'))) return true
  console.log('[dsh-proto-lab/vendor] installing p5@' + version + ' ...')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error('[dsh-proto-lab/vendor] npm install failed with status ' + String(result.status))
    return false
  }
  return existsSync(path.join(here, 'node_modules', 'p5', 'package.json'))
}

// ---------------------------------------------------------------------------
// --check: re-hash what is committed, offline, and say what drifted
// ---------------------------------------------------------------------------
if (check) {
  const failures = []
  if (!existsSync(versionFile)) {
    console.error('[dsh-proto-lab/vendor] lib/vendor/VERSION.json is missing - run `node build.mjs`')
    process.exit(1)
  }
  const recorded = JSON.parse(readFileSync(versionFile, 'utf8'))
  if (recorded.version !== version) {
    failures.push('VERSION.json records p5 ' + String(recorded.version) + ', vendor/package.json pins ' + version)
  }
  for (const [source, published] of FILES) {
    const file = path.join(outDir, published)
    if (!existsSync(file)) {
      failures.push(published + ' is missing from lib/vendor/')
      continue
    }
    const entry = recorded.files?.['lib/vendor/' + published]
    if (entry === undefined) {
      failures.push(published + ' is not recorded in VERSION.json')
      continue
    }
    const size = statSync(file).size
    const sha256 = hash(file)
    if (entry.bytes !== size) failures.push(published + ': recorded ' + entry.bytes + ' bytes, is ' + size)
    if (entry.sha256 !== sha256) failures.push(published + ': sha256 differs from the recorded one')
  }
  if (failures.length > 0) {
    console.error('[dsh-proto-lab/vendor] the vendored library does not match its record:')
    for (const failure of failures) console.error('  - ' + failure)
    process.exit(1)
  }
  console.log('[dsh-proto-lab/vendor] ok - p5 ' + version + ' matches lib/vendor/VERSION.json (checked offline)')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// build: copy the published files and record what was copied
// ---------------------------------------------------------------------------
if (!install()) {
  console.error('[dsh-proto-lab/vendor] p5 is not installed and could not be installed')
  process.exit(1)
}
const packageRoot = path.join(here, 'node_modules', 'p5')
const installed = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
if (installed.version !== version) {
  console.error('[dsh-proto-lab/vendor] node_modules holds p5 ' + String(installed.version) + ', the pin is ' + version)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const files = {}
for (const [source, published] of FILES) {
  const from = path.join(packageRoot, source)
  if (!existsSync(from)) {
    console.error('[dsh-proto-lab/vendor] p5 ' + version + ' has no ' + source + ' - the pin is wrong for this layout')
    process.exit(1)
  }
  const to = path.join(outDir, published)
  copyFileSync(from, to)
  files['lib/vendor/' + published] = { bytes: statSync(to).size, sha256: hash(to) }
}

const record = {
  package: 'p5',
  version,
  upstream: 'https://github.com/processing/p5.js',
  license: 'LGPL-2.1',
  files,
  notices: ['lib/vendor/LICENSE'],
  why: '1.x is the last line with a self-contained classic-script browser build, which a run opened off the filesystem and a route-registered bundle both need.',
  note: 'GENERATED by vendor/build.mjs - never hand-edit anything under lib/vendor/.',
}
writeFileSync(versionFile, JSON.stringify(record, null, 2) + '\n')
console.log('[dsh-proto-lab/vendor] wrote p5 ' + version + ' -> lib/vendor/p5.min.js (' + files['lib/vendor/p5.min.js'].bytes + ' bytes)')
