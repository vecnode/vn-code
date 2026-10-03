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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * THE FONTS, and why they are a SUBSET rather than the tree as shipped.
 *
 * Excalidraw fetches its faces at runtime, and it builds each URL as
 * `new URL('fonts/<Family>/<file>', EXCALIDRAW_ASSET_PATH)` - so this package
 * serves them from ONE EXACT ROUTE PER FILE under its own vendor prefix, which is
 * the same pattern `fonts.js` already uses for this package's own faces.
 *
 * What is shipped is every LATIN family and nothing else. The tree as published is
 * 234 files / 12.5 MiB, of which the CJK face (Xiaolai) alone is 209 files and
 * 12.1 MiB - a fifth of a gigabyte of distribution for characters none of this
 * pack's designs contains. The eight Latin families are 25 files / 429 KiB, and
 * the skipped ones are NAMED in VERSION.json rather than silently dropped, so the
 * day someone needs CI text the record says what to add.
 */
const SKIPPED_FONT_FAMILIES = ['Xiaolai']

/**
 * Copy every font file this build ships, into `lib/vendor/excalidraw/fonts/`.
 * @returns `{ recorded, skipped, files, bytes }` - per family, per file, hashed.
 */
function copyFonts() {
  const sourceRoot = path.join(here, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
  const targetRoot = path.join(outDir, 'fonts')
  const recorded = {}
  const skipped = []
  let files = 0
  let bytes = 0
  if (!existsSync(sourceRoot)) throw new Error('no fonts beside the pinned Excalidraw package - cannot vendor the faces')
  for (const family of readdirSync(sourceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (SKIPPED_FONT_FAMILIES.includes(family)) {
      skipped.push(family)
      continue
    }
    const familyDir = path.join(targetRoot, family)
    mkdirSync(familyDir, { recursive: true })
    recorded[family] = {}
    for (const name of readdirSync(path.join(sourceRoot, family)).sort()) {
      if (!name.endsWith('.woff2')) continue
      const source = path.join(sourceRoot, family, name)
      const target = path.join(familyDir, name)
      copyFileSync(source, target)
      const size = statSync(target).size
      recorded[family][name] = { bytes: size, sha256: hashOf(target) }
      files += 1
      bytes += size
    }
  }
  return { recorded, skipped, files, bytes }
}

/** The trim, as esbuild plugins: each one is named in VERSION.json. */async function trimPlugins() {
  const applied = []
  const patched = []
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
  // 3. whatever THIS repository adds on top. A patch is NOT a trim: it is named
  // separately in VERSION.json (`patches`), because "what this build deleted" and
  // "what this repository changed" are different facts about the artifact, and
  // recording a patch under `trims` would make the record a lie about upstream.
  const patchFile = path.join(here, 'patches', 'index.mjs')
  if (existsSync(patchFile)) {
    const loaded = await import('file:///' + patchFile.replace(/\\/g, '/'))
    const patches = Array.isArray(loaded.default) ? loaded.default : Array.isArray(loaded.patches) ? loaded.patches : []
    for (const patch of patches) {
      list.push(patch)
      patched.push(String(patch.name))
    }
  }
  return { list, applied, patched }
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
  // THE FONTS, file by file: a face that went missing is a 404 the editor swallows
  // silently (it falls back), so nothing but a hash check would ever notice.
  let checkedFonts = 0
  for (const [family, entries] of Object.entries((record.fonts || {}).families || {})) {
    for (const [name, expected] of Object.entries(entries)) {
      const file = path.join(outDir, 'fonts', family, name)
      checkedFonts += 1
      if (!existsSync(file)) {
        problems.push('fonts/' + family + '/' + name + ': missing')
        continue
      }
      const actual = hashOf(file)
      if (expected.sha256 !== actual) problems.push('fonts/' + family + '/' + name + ': sha256 ' + actual + ' but VERSION.json records ' + expected.sha256)
      else if (expected.bytes !== statSync(file).size) problems.push('fonts/' + family + '/' + name + ': size drifted')
    }
  }
  if (problems.length > 0) {
    console.error('the vendored Excalidraw artifact does not match VERSION.json:')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  console.log(
    'the vendored Excalidraw artifact matches VERSION.json (' +
      digestOf(ARTIFACTS).slice(0, 16) +
      '\u2026, ' +
      String(checkedFonts) +
      ' font file(s) hashed, ' +
      String(((record.fonts || {}).skipped || []).length) +
      ' family(ies) declared skipped)',
  )
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const { list, applied, patched } = await trimPlugins()

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

// THE FACES: copied, hashed, and served by this package's own routes. The skipped
// families are NAMED, because "the CJK text is boxes" is a question whose answer
// should be in the record rather than in a commit message.
const fonts = copyFonts()
const fontDigest = createHash('sha256')
for (const [family, entries] of Object.entries(fonts.recorded)) {
  for (const [name, meta] of Object.entries(entries)) fontDigest.update('fonts/' + family + '/' + name + '\0' + meta.sha256 + '\0')
}

writeFileSync(
  recordPath,
  JSON.stringify(
    {
      generatedBy: 'packages/dsh-canvas/vendor/excalidraw/build.mjs',
      note:
        'The vendored Excalidraw surface for the Canvas tab: ONE classic script, the stylesheet it cannot live without, and the LATIN FACES it fetches at runtime (every URL it builds is `new URL(\'fonts/<Family>/<file>\', EXCALIDRAW_ASSET_PATH)`, so this package serves one exact route per file under its own vendor prefix). Built from the pinned versions below, with the trims named in `trims` and any repository patches named in `patches`. `node build.mjs --check` re-hashes every file here OFFLINE - artifacts, licences and every font - so the committed tree cannot drift from this record. React is bundled (Excalidraw takes it as a peer and a script tag cannot reach the shell\u2019s module table), which means the page carries a SECOND React: nothing may pass a component across that boundary. The .js/.css files are TEXT and are pinned to LF in .gitattributes, because these hashes would otherwise report phantom drift on a Windows checkout; the .woff2 faces are binary and are never touched.',
      pins: PINS,
      trims: applied,
      patches: patched,
      unshipped: {
        locales: 'the 55 locale modules are stubbed; Excalidraw fetches them at runtime from EXCALIDRAW_ASSET_PATH and falls back to English',
        cjkFonts: 'the Xiaolai (CJK) family is NOT vendored: ' + String(fonts.skipped.join(', ')) + ' - 209 of the 234 published files and 12.1 MiB, which no design in this pack contains. Add it to SKIPPED_FONT_FAMILIES\' sibling list to ship it.',
      },
      digest: digestOf(ARTIFACTS),
      files,
      fonts: {
        families: fonts.recorded,
        skipped: fonts.skipped,
        files: fonts.files,
        bytes: fonts.bytes,
        digest: fontDigest.digest('hex'),
      },
    },
    null,
    2,
  ) + '\n',
)

const kib = (bytes) => (bytes / 1024).toFixed(1) + ' KiB'
console.log('built the vendored Excalidraw surface (trims: ' + applied.join(', ') + (patched.length > 0 ? '; patches: ' + patched.join(', ') : '') + ')')
for (const name of ARTIFACTS) console.log('  ' + name.padEnd(20) + kib(files[name].bytes) + '  ' + files[name].sha256.slice(0, 16) + '\u2026')
console.log('  digest             ' + digestOf(ARTIFACTS).slice(0, 16) + '\u2026')
console.log(
  '  fonts              ' +
    String(fonts.files) +
    ' file(s) in ' +
    String(Object.keys(fonts.recorded).length) +
    ' families, ' +
    kib(fonts.bytes) +
    (fonts.skipped.length > 0 ? '  (skipped: ' + fonts.skipped.join(', ') + ')' : ''),
)
