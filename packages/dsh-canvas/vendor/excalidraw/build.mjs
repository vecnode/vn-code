/**
 * build.mjs - build, trim and PIN the vendored Excalidraw surface.
 *
 *   node build.mjs            build lib/vendor/excalidraw/ and rewrite VERSION.json
 *   node build.mjs --check    re-hash the committed artifacts OFFLINE and compare
 *
 * WHY A BUILD ROOT AND A COMMITTED ARTIFACT, not a dependency and not a
 * submodule. This pack ships ZERO npm dependencies (the profile installs live
 * links, so a package dependency would not even be installed), and the
 * distribution carries `lib/vendor/` while skipping build inputs - which is why
 * `packages/dsh-editor/vendor/node_modules` (CodeMirror), `packages/dsh-pdf/
 * vendor` (pdf.js) and `packages/dsh-canvas/vendor` (this) all exist and none of
 * them is shipped. A submodule would put a second checkout inside a repository
 * whose install flow is "clone, run the installer": it would need a step no
 * entry point performs, and its source tree would have to be either shipped
 * (multipling the distribution) or special-cased. So: pin the versions, build
 * here, commit the artifact, and let `--check` hold the artifact to the record.
 *
 * THREE THINGS ARE DONE TO THE UPSTREAM BUILD, and all three are DECLARED in
 * VERSION.json so nothing about the artifact is implicit:
 *
 *   1. LOCALES ARE STUBBED. The 55 locale modules are DYNAMIC imports
 *      (`import('./locales/xx-XX.js')`) and esbuild's iife format cannot
 *      code-split, so every one of them is otherwise inlined: measured, 1.59 MiB
 *      of the bundle. Excalidraw fetches locales at runtime from
 *      `EXCALIDRAW_ASSET_PATH` anyway and falls back to its built-in English, so
 *      the shipped surface is English and every other language is a follow-up.
 *   2. THE MERMAID DIALOG IS STUBBED. `@excalidraw/mermaid-to-excalidraw` drags
 *      the whole of mermaid in behind it - measured, 3.37 MiB - for one toolbar
 *      tool. The stub throws a sentence if it is ever invoked, and VERSION.json
 *      says so, so the missing tool is a declared build flag and not a mystery.
 *   3. PATCHES, if any exist, are applied. `patches/index.mjs` (optional) may
 *      export `{ name, setup(build) }` entries - esbuild plugins, which is the
 *      honest form of a patch here because the artifact IS the build: a text
 *      diff against a minified 500 KiB file would rot on the next version bump.
 *      Whatever runs is named in VERSION.json's `patches`, and the artifact hash
 *      is what proves the set was what produced it.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.join(here, '..', '..')
const outDir = path.join(packageDir, 'lib', 'vendor', 'excalidraw')
const recordPath = path.join(outDir, 'VERSION.json')

const pins = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
const PINS = {
  '@excalidraw/excalidraw': pins.dependencies['@excalidraw/excalidraw'],
  react: pins.dependencies.react,
  'react-dom': pins.dependencies['react-dom'],
  esbuild: pins.devDependencies.esbuild,
}

/** The artifact names this build writes, and the licence texts that travel with them. */
const ARTIFACTS = ['excalidraw.min.js', 'excalidraw.css']
/**
 * The licence texts. `react` and `react-dom` ship one inside the tarball; the
 * Excalidraw package does NOT (its `files` list is `dist/*`, so the npm tarball
 * carries no LICENSE at all) - and a vendored artifact without its licence is
 * not shippable, so that one is FETCHED from the pinned tag and verified against
 * the hash below. The pin is what makes the fetch safe: an upstream text that
 * changed would fail the build loudly instead of being vendored silently.
 */
const LICENCES = [
  { file: 'LICENSE-excalidraw.txt', from: null, url: 'https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/LICENSE', sha256: '1352d204fdb90d5e482c13139d848bc2c9300a9a7de358a0a558a23e72d0d8be' },
  { file: 'LICENSE-react.txt', from: 'react' },
  { file: 'LICENSE-react-dom.txt', from: 'react-dom' },
]

/** The trim, as esbuild plugins: each one is named in VERSION.json. */
async function trimPlugins() {
  const applied = []
  const stubs = {
    name: 'dsh-canvas: trim',
    setup(api) {
      // 1. the 55 lazy locale modules
      api.onResolve({ filter: /^\.\/locales\/.+\.js$/ }, (args) => ({ path: args.path, namespace: 'stub-locale' }))
      api.onLoad({ filter: /.*/, namespace: 'stub-locale' }, () => ({ contents: 'export default {}', loader: 'js' }))
      applied.push('locales-stubbed')
      // 2. the Mermaid-to-Excalidraw dialog
      api.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (args) => ({ path: args.path, namespace: 'stub-mermaid' }))
      api.onLoad({ filter: /.*/, namespace: 'stub-mermaid' }, () => ({
        contents:
          'export const parseMermaidToExcalidraw = async () => { throw new Error("the Mermaid dialog is not part of this vendored build") };' +
          'export default { parseMermaidToExcalidraw }',
        loader: 'js',
      }))
      applied.push('mermaid-dialog-stubbed')
    },
  }
  const list = [stubs]
  // 3. whatever THIS repository adds on top
  const patchFile = path.join(here, 'patches', 'index.mjs')
  if (existsSync(patchFile)) {
    const loaded = await import('file:///' + patchFile.replace(/\\/g, '/'))
    const patches = Array.isArray(loaded.default) ? loaded.default : Array.isArray(loaded.patches) ? loaded.patches : []
    for (const patch of patches) {
      list.push(patch)
      applied.push(String(patch.name))
    }
  }
  return { list, applied }
}

/** The sha256 of one file, as VERSION.json records it. */
function hashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The digest over every artifact, so one number names the whole surface. */
function digestOf(files) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file + '\0' + hashOf(path.join(outDir, file)) + '\0')
  return hash.digest('hex')
}

if (process.argv.includes('--check')) {
  if (!existsSync(recordPath)) {
    console.error('no ' + path.relative(packageDir, recordPath) + ': run `node build.mjs` in packages/dsh-canvas/vendor/excalidraw first')
    process.exit(1)
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const problems = []
  for (const name of ARTIFACTS.concat(record.licences || [])) {
    const file = path.join(outDir, name)
    if (!existsSync(file)) {
      problems.push(name + ': missing')
      continue
    }
    const actual = hashOf(file)
    const expected = (record.files || {})[name]
    if (expected === undefined) problems.push(name + ': not recorded in VERSION.json')
    else if (expected.sha256 !== actual) problems.push(name + ': sha256 ' + actual + ' but VERSION.json records ' + expected.sha256)
    else if (expected.bytes !== statSync(file).size) problems.push(name + ': ' + statSync(file).size + ' bytes but VERSION.json records ' + expected.bytes)
  }
  for (const [name, version] of Object.entries(PINS)) {
    if ((record.pins || {})[name] !== version) problems.push('pin ' + name + ': package.json says ' + version + ', VERSION.json records ' + String((record.pins || {})[name]))
  }
  if (problems.length > 0) {
    console.error('the vendored Excalidraw artifact does not match VERSION.json:')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  console.log('the vendored Excalidraw artifact matches VERSION.json (' + digestOf(ARTIFACTS).slice(0, 16) + '…)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const { list, applied } = await trimPlugins()

await build({
  entryPoints: [path.join(here, 'entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: path.join(outDir, 'excalidraw.min.js'),
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  plugins: list,
})

// Excalidraw keeps its stylesheet SEPARATE (its own build emits it), and the
// surface is unusable without it: `--color-primary` and every layout rule live
// there. It travels as a second artifact rather than being inlined, because a
// classic script cannot carry CSS.
copyFileSync(path.join(here, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'index.css'), path.join(outDir, 'excalidraw.css'))
for (const licence of LICENCES) {
  const target = path.join(outDir, licence.file)
  if (licence.from === null) {
    const response = await fetch(licence.url)
    if (response.ok !== true) throw new Error('could not fetch ' + licence.url + ' (HTTP ' + response.status + ')')
    const text = (await response.text()).replace(/\r\n/g, '\n')
    const actual = createHash('sha256').update(text).digest('hex')
    if (actual !== licence.sha256) {
      throw new Error(
        'the licence at ' + licence.url + ' hashes to ' + actual + ', but this build pins ' + licence.sha256 + ' - re-pin it deliberately, or vendor the text by hand',
      )
    }
    writeFileSync(target, text)
    continue
  }
  const source = path.join(here, 'node_modules', licence.from, 'LICENSE')
  if (!existsSync(source)) throw new Error('no LICENSE beside ' + licence.from + ' - the vendored tree must carry it')
  copyFileSync(source, target)
}

const files = {}
for (const name of ARTIFACTS) {
  const file = path.join(outDir, name)
  files[name] = { bytes: statSync(file).size, sha256: hashOf(file) }
}
for (const licence of LICENCES) {
  const file = path.join(outDir, licence.file)
  const record = { bytes: statSync(file).size, sha256: hashOf(file) }
  if (licence.url !== undefined) record.url = licence.url
  if (licence.from !== null) record.from = licence.from
  files[licence.file] = record
}

writeFileSync(
  recordPath,
  JSON.stringify(
    {
      generatedBy: 'packages/dsh-canvas/vendor/excalidraw/build.mjs',
      note:
        'The vendored Excalidraw surface for the Canvas tab: ONE classic script plus the stylesheet it cannot live without. Built from the pinned versions below, with the trims named in `trims` and any repository patches named in `patches`. `node build.mjs --check` re-hashes every file here OFFLINE, so the committed artifact cannot drift from this record. React is bundled (Excalidraw takes it as a peer and a script tag cannot reach the shell\u2019s module table), which means the page carries a SECOND React: nothing may pass a component across that boundary. The .js/.css files are TEXT and are pinned to LF in .gitattributes, because these hashes would otherwise report phantom drift on a Windows checkout.',
      pins: PINS,
      trims: applied,
      patches: applied.filter((name) => name !== 'locales-stubbed' && name !== 'mermaid-dialog-stubbed'),
      unshipped: {
        locales: 'the 55 locale modules are stubbed; Excalidraw fetches them at runtime from EXCALIDRAW_ASSET_PATH and falls back to English',
        fonts: 'Excalidraw ships 234 font files (12.5 MB) fetched at runtime from EXCALIDRAW_ASSET_PATH; none is vendored yet, so text falls back to the faces the bundle already carries',
      },
      digest: digestOf(ARTIFACTS),
      files,
    },
    null,
    2,
  ) + '\n',
)

const kib = (bytes) => (bytes / 1024).toFixed(1) + ' KiB'
console.log('built the vendored Excalidraw surface (trims: ' + applied.join(', ') + ')')
for (const name of ARTIFACTS) console.log('  ' + name.padEnd(20) + kib(files[name].bytes) + '  ' + files[name].sha256.slice(0, 16) + '\u2026')
console.log('  digest             ' + digestOf(ARTIFACTS).slice(0, 16) + '\u2026')
