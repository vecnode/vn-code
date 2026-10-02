// packages/dsh-canvas/vendor/build.mjs — fetch and pin the bundled font subsets.
//
// dsh-canvas ships two OFL families so a design renders and exports the SAME
// pixels on a machine that has neither installed. The files are committed, their
// upstream URLs and SHA-256 hashes are recorded beside them, and nothing is ever
// downloaded at install or at boot: this script is the only thing that talks to
// the network, and `--check` proves the committed bytes still match the record
// (offline), which is what `check-canvas-node.mjs` runs.
//
// Why Google's own CSS endpoint rather than a hand-picked URL: the latin subset
// URL carries a content hash in its path and changes when the family is updated,
// so a hardcoded URL rots silently. Asking for the family and reading the
// `/* latin */` block is the documented way to get the current file - and the
// hash is recorded at the moment of the fetch, so a later update is a visible
// diff rather than a surprise.
//
// Usage:
//   node packages/dsh-canvas/vendor/build.mjs            # fetch/refresh, write files + VERSION.json
//   node packages/dsh-canvas/vendor/build.mjs --check    # verify the committed files against VERSION.json (offline)
//
// Licence: both families are SIL Open Font License 1.1. Their OFL texts are
// fetched and committed beside the fonts, and lib/fonts.js reports them.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const fontDir = path.join(packageRoot, 'lib', 'vendor', 'fonts')
const versionFile = path.join(fontDir, 'VERSION.json')

/** The subsets a design needs: latin only. A poster is not a Cyrillic novel. */
const SUBSET = 'latin'

/** The families this package bundles, with the weights a design language uses. */
const FAMILIES = [
  {
    family: 'Inter',
    weights: [400, 600, 700],
    slug: 'inter',
    licenceUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt',
    licenceFile: 'OFL-Inter.txt',
    homepage: 'https://fonts.google.com/specimen/Inter',
    designer: 'Rasmus Andersson',
  },
  {
    family: 'Space Grotesk',
    weights: [500, 700],
    slug: 'space-grotesk',
    licenceUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/OFL.txt',
    licenceFile: 'OFL-SpaceGrotesk.txt',
    homepage: 'https://fonts.google.com/specimen/Space+Grotesk',
    designer: 'Florian Karsten',
  },
]

/** The UA that makes Google's CSS endpoint answer with woff2 blocks rather than ttf. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const check = process.argv.includes('--check')

/** sha256 of a buffer, hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * The licence text as LF.
 *
 * The repository stores and checks out text as LF (`.gitattributes`:
 * `* text=auto eol=lf`), and this file's bytes are HASHED into VERSION.json and
 * re-checked offline - so a fetched CRLF licence would be hashed as CRLF, stored
 * as LF, and fail `--check` on every clean checkout. Normalising at FETCH time is
 * what makes the hash mean the same thing everywhere; the fonts themselves are
 * binary and are never touched.
 */
function toLf(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/**
 * The latin `@font-face` URL for one weight, read out of Google's own CSS.
 * @param family - the family name.
 * @param weight - the numeric weight.
 * @returns the woff2 URL.
 */
async function latinUrlFor(family, weight) {
  const url = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+') + ':wght@' + weight + '&display=swap'
  const response = await fetch(url, { headers: { 'user-agent': UA } })
  if (!response.ok) throw new Error('Google Fonts CSS answered ' + response.status + ' for ' + family + ' ' + weight)
  const css = await response.text()
  // Blocks look like: /* latin */ @font-face { ... src: url(...) ... }
  const blocks = css.split('/*').map((chunk) => '/*' + chunk)
  const latin = blocks.find((block) => block.trim().startsWith('/* ' + SUBSET + ' */'))
  if (!latin) throw new Error('no ' + SUBSET + ' subset block in the CSS for ' + family + ' ' + weight)
  const match = /url\((https:\/\/[^)]+\.woff2)\)/.exec(latin)
  if (!match) throw new Error('no woff2 URL in the ' + SUBSET + ' block for ' + family + ' ' + weight)
  return match[1]
}

/** Read VERSION.json, or null. */
function readVersion() {
  if (!existsSync(versionFile)) return null
  try {
    return JSON.parse(readFileSync(versionFile, 'utf8'))
  } catch (err) {
    return null
  }
}

/** The check: every recorded file is present and hashes to what the record says. */
function runCheck() {
  const record = readVersion()
  if (!record) {
    console.error('FAIL no ' + path.relative(packageRoot, versionFile) + ' - run the vendorer first')
    process.exitCode = 1
    return
  }
  let failures = 0
  let files = 0
  for (const entry of Object.values(record.families)) {
    for (const [weight, meta] of Object.entries(entry.files)) {
      files += 1
      const file = path.join(fontDir, meta.file)
      if (!existsSync(file)) {
        console.error('FAIL missing ' + meta.file + ' (' + entry.family + ' ' + weight + ')')
        failures += 1
        continue
      }
      const bytes = readFileSync(file)
      const digest = sha256(bytes)
      if (digest !== meta.sha256) {
        console.error('FAIL ' + meta.file + ' hashes to ' + digest.slice(0, 16) + ', the record says ' + meta.sha256.slice(0, 16))
        failures += 1
      }
      if (bytes.length !== meta.bytes) {
        console.error('FAIL ' + meta.file + ' is ' + bytes.length + ' bytes, the record says ' + meta.bytes)
        failures += 1
      }
    }
    if (entry.licence) {
      const licence = path.join(fontDir, entry.licence)
      if (!existsSync(licence)) {
        console.error('FAIL missing licence text ' + entry.licence)
        failures += 1
      } else if (sha256(readFileSync(licence)) !== entry.licenceSha256) {
        console.error('FAIL ' + entry.licence + ' does not match the recorded hash')
        failures += 1
      }
    }
  }
  if (failures === 0) console.log('ok   ' + files + ' font file(s) match ' + path.relative(packageRoot, versionFile))
  else console.error(failures + ' font file(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}

/** Fetch everything and write the fonts + the record. */
async function runUpdate() {
  mkdirSync(fontDir, { recursive: true })
  const families = {}
  let total = 0
  for (const spec of FAMILIES) {
    const files = {}
    for (const weight of spec.weights) {
      const url = await latinUrlFor(spec.family, weight)
      const response = await fetch(url, { headers: { 'user-agent': UA } })
      if (!response.ok) throw new Error('font download answered ' + response.status + ' for ' + url)
      const bytes = Buffer.from(await response.arrayBuffer())
      const file = spec.slug + '-' + SUBSET + '-' + weight + '.woff2'
      writeFileSync(path.join(fontDir, file), bytes)
      files[String(weight)] = { file, sha256: sha256(bytes), bytes: bytes.length, url, subset: SUBSET }
      total += bytes.length
      console.log('ok   ' + file.padEnd(34) + String(bytes.length).padStart(7) + ' bytes  ' + sha256(bytes).slice(0, 16))
    }
    const licenceResponse = await fetch(spec.licenceUrl, { headers: { 'user-agent': UA } })
    if (!licenceResponse.ok) throw new Error('licence download answered ' + licenceResponse.status + ' for ' + spec.licenceUrl)
    const licenceBytes = toLf(Buffer.from(await licenceResponse.arrayBuffer()))
    writeFileSync(path.join(fontDir, spec.licenceFile), licenceBytes)
    families[spec.family] = {
      family: spec.family,
      designer: spec.designer,
      homepage: spec.homepage,
      licence: spec.licenceFile,
      licenceUrl: spec.licenceUrl,
      licenceSha256: sha256(licenceBytes),
      files,
    }
  }
  const digest = sha256(Buffer.from(Object.values(families).flatMap((entry) => Object.values(entry.files).map((file) => file.sha256)).sort().join('\n')))
  const record = {
    generatedBy: 'packages/dsh-canvas/vendor/build.mjs',
    note: 'Fetched from Google Fonts\u2019 own CSS endpoint (latin subsets) and pinned by SHA-256; both families are SIL Open Font License 1.1 and their licence texts sit beside them. Licence texts are normalised to LF before hashing, because .gitattributes stores text as LF (`* text=auto eol=lf`) and a CRLF-hashed file would report phantom drift on every clean checkout.',
    digest,
    families,
  }
  writeFileSync(versionFile, JSON.stringify(record, null, 2) + '\n')
  console.log('')
  console.log('wrote ' + Object.keys(families).length + ' families, ' + Math.round(total / 1024) + ' KB of woff2, digest ' + digest.slice(0, 16))
  console.log('now run: node packages/dsh-canvas/vendor/build.mjs --check')
}

if (check) runCheck()
else await runUpdate()
