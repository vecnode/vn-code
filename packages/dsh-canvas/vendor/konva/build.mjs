/**
 * dsh-canvas/vendor/konva/build.mjs - fetch, pin and record the vendored Konva surface.
 *
 * WHY KONVA IS VENDORED. The Canvas tab's interaction layer needs an object model
 * with hit testing, transform handles and marquee selection, and this pack declares
 * ZERO npm dependencies in shipped packages: the profile installs every bundle as a
 * live LINK, so a `dependency` is not installed and a plugin cannot `import` one at
 * runtime. The engine is therefore fetched from its own upstream, pinned by hash and
 * committed - the same bargain the vendored CodeMirror, Mermaid, pdf.js and fonts
 * make.
 *
 * WHY THE TARBALL RATHER THAN `npm install`. Konva publishes the browser build ready
 * to use (`konva.min.js` is one self-contained UMD file at the package root), so an
 * install step would add a dependency tree, a lockfile and a `node_modules` - three
 * things to audit - to copy two files out. This script reads them out of the PINNED
 * npm tarball instead, verifying the tarball's own published sha512 BEFORE anything
 * is extracted, so the bytes have one provenance and one hash.
 *
 * THE TWO PINS ARE DIFFERENT AND BOTH MATTER:
 *   - the TARBALL's sha512, hardcoded below, is what the registry publishes for
 *     10.7.0 (from the signed packument). A tampered or substituted tarball fails
 *     before a byte is extracted.
 *   - each EXTRACTED file's sha256 is recorded in lib/vendor/konva/VERSION.json as it
 *     is written, and `--check` re-hashes the committed bytes against that record
 *     OFFLINE. That is the half a check can run on any machine, and it is what makes
 *     a hand-edited or half-copied `konva.min.js` a failure instead of a mystery.
 *
 * WHAT IS TRIMMED. Nothing is removed from the bundle: it is upstream's own browser
 * build, byte for byte, with two mechanical normalisations that are recorded in
 * VERSION.json rather than hidden -
 *   - CRLF is normalised to LF, because `.gitattributes` stores text as LF
 *     (`* text=auto eol=lf`) and this file's bytes are hashed: a CRLF-hashed file
 *     would report phantom drift on every clean checkout.
 *   - the trailing newline is made exactly one, so the record and the checkout agree.
 * There is no patch and no fork, so nothing here needs to be re-derived when the
 * package is bumped - and there is no credential to redact: Konva is MIT, it carries
 * no service keys, and `check-no-secrets.mjs` scans the artifact like any other file.
 *
 * Usage:
 *   node build.mjs            fetch the pinned tarball and (re)write lib/vendor/konva/
 *   node build.mjs --check    verify the committed files against VERSION.json (offline)
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outDir = path.join(packageRoot, 'lib', 'vendor', 'konva')
const versionFile = path.join(outDir, 'VERSION.json')

/**
 * The pin. `integrity` is the sha512 the registry publishes for this tarball, and it
 * is checked BEFORE extraction; the version also lives in this folder's package.json
 * so `pins.konva` is the one place a bump is read from.
 */
const PIN = {
  name: 'konva',
  version: JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).pins.konva,
  tarball: 'https://registry.npmjs.org/konva/-/konva-10.7.0.tgz',
  integrity: 'sha512-2CwuytBrOlTh7WHCSeXyUeysB2rpwHruUUDD5etYtrzijkCVH+00+CQz5fJUGI0hm7mzxxDLYLw4Wpo+8QGJ4g==',
  licence: 'MIT',
  homepage: 'https://konvajs.org/',
}

/**
 * What is taken out of the tarball, and under which name it is committed. The licence
 * comes along because a distribution ships the artifact and the MIT text that covers
 * it; the rest of the package (TypeScript sources, the ESM tree, the type maps) is
 * not shipped at all.
 */
const ARTIFACTS = [
  { from: 'package/konva.min.js', file: 'konva.min.js', kind: 'script', note: 'upstream\u2019s own UMD browser build: one self-contained file that leaves `globalThis.Konva` behind' },
  { from: 'package/LICENSE', file: 'LICENSE-konva.txt', kind: 'licence', note: 'Konva is MIT; this is the text the distribution ships beside the artifact' },
]

const check = process.argv.includes('--check')

/** sha256 of a buffer, hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** LF-normalised text with exactly one trailing newline. */
function normalise(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
  return Buffer.from(text, 'utf8')
}

/** A NUL-terminated string out of a tar header field. */
function cstr(buffer, start, end) {
  const slice = buffer.subarray(start, end)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

/**
 * Every regular file in a POSIX tar, as `name -> bytes`.
 *
 * A tar is 512-byte blocks: a header, then the file's bytes padded up to the next
 * block. `x`/`g` records are PAX extended headers - they carry attributes for the
 * NEXT entry (a long path, most often) and their payload is text, so the one field
 * this reader needs from them is `path`. Two zero blocks end the archive, but a
 * shorter read is treated as an error rather than a quiet truncation: a half-read
 * tarball must not produce a half-written artifact.
 */
function untar(buffer) {
  const files = new Map()
  let offset = 0
  let pendingPath = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(cstr(header, 124, 136).trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const padded = dataStart + Math.ceil(size / 512) * 512
    if (!Number.isFinite(size) || padded > buffer.length + 512) throw new Error('the tarball is truncated at byte ' + offset)
    if (type === 'x' || type === 'g') {
      const record = buffer.subarray(dataStart, dataEnd).toString('utf8')
      const match = /^\d+ path=(.*)$/m.exec(record)
      if (match) pendingPath = match[1]
    } else if (type === '0' || type === '\u0000') {
      const prefix = cstr(header, 345, 500)
      const raw = cstr(header, 0, 100)
      const name = pendingPath ?? (prefix.length > 0 ? prefix + '/' + raw : raw)
      pendingPath = null
      if (!name.endsWith('/')) files.set(name, buffer.subarray(dataStart, dataEnd))
    }
    offset = padded
  }
  return files
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
    console.error('FAIL no ' + path.relative(packageRoot, versionFile) + ' - run `node packages/dsh-canvas/vendor/konva/build.mjs` first')
    process.exitCode = 1
    return
  }
  let failures = 0
  for (const [name, meta] of Object.entries(record.files)) {
    const file = path.join(outDir, name)
    if (!existsSync(file)) {
      console.error('FAIL missing ' + name + ' - the vendored Konva surface is not in this checkout')
      failures += 1
      continue
    }
    const bytes = readFileSync(file)
    const digest = sha256(bytes)
    if (digest !== meta.sha256) {
      console.error('FAIL ' + name + ' hashes to ' + digest.slice(0, 16) + ', the record says ' + meta.sha256.slice(0, 16))
      failures += 1
    }
    if (bytes.length !== meta.bytes) {
      console.error('FAIL ' + name + ' is ' + bytes.length + ' bytes, the record says ' + meta.bytes)
      failures += 1
    }
    if (meta.lf === true && bytes.includes(13)) {
      console.error('FAIL ' + name + ' carries CR - .gitattributes stores these text files as LF, so this checkout would report drift forever')
      failures += 1
    }
  }
  if (failures === 0) {
    console.log('ok   ' + Object.keys(record.files).length + ' Konva file(s) match ' + path.relative(packageRoot, versionFile) + ' (' + record.pins.konva + ')')
  } else {
    console.error(failures + ' Konva file(s) FAILED')
  }
  process.exitCode = failures === 0 ? 0 : 1
}

/** Fetch the pinned tarball, verify it, extract what ships and write the record. */
async function runUpdate() {
  const response = await fetch(PIN.tarball)
  if (!response.ok) throw new Error('the Konva tarball answered ' + response.status + ' for ' + PIN.tarball)
  const tarball = Buffer.from(await response.arrayBuffer())
  // THE PIN IS CHECKED BEFORE ANYTHING IS EXTRACTED. `integrity` is base64 of the
  // sha512 the registry publishes, so this compares like for like.
  const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')
  if (integrity !== PIN.integrity) {
    throw new Error('the Konva tarball does not match the pin\n  expected ' + PIN.integrity + '\n  got      ' + integrity)
  }
  const files = untar(gunzipSync(tarball))
  mkdirSync(outDir, { recursive: true })
  const recorded = {}
  let total = 0
  for (const artifact of ARTIFACTS) {
    const source = files.get(artifact.from)
    if (!source) throw new Error('the tarball carries no ' + artifact.from)
    const bytes = artifact.kind === 'script' ? normalise(source) : normalise(source)
    writeFileSync(path.join(outDir, artifact.file), bytes)
    recorded[artifact.file] = {
      from: artifact.from,
      url: PIN.tarball,
      sha256: sha256(bytes),
      bytes: bytes.length,
      lf: true,
      note: artifact.note,
    }
    total += bytes.length
    console.log('ok   ' + artifact.file.padEnd(22) + String(bytes.length).padStart(8) + ' bytes  ' + sha256(bytes).slice(0, 16))
  }
  const digest = sha256(Buffer.from(Object.values(recorded).map((entry) => entry.sha256).sort().join('\n')))
  const record = {
    generatedBy: 'packages/dsh-canvas/vendor/konva/build.mjs',
    note: 'The vendored Konva surface for the Canvas tab: ONE self-contained UMD browser build and the MIT text that covers it, taken out of the pinned npm tarball. Nothing is forked and nothing is patched - the only mechanical change is CRLF-to-LF with one trailing newline, because .gitattributes stores text as LF and these bytes are hashed, so a CRLF-hashed file would report phantom drift on every clean checkout. `--check` re-hashes both files OFFLINE from this record; the tarball itself is verified against the registry\u2019s published sha512 before a byte is extracted.',
    pins: { konva: PIN.version },
    integrity: PIN.integrity,
    licence: PIN.licence,
    homepage: PIN.homepage,
    global: 'Konva',
    route: '/api/dsh-canvas/vendor/konva.js',
    files: recorded,
    digest,
  }
  writeFileSync(versionFile, JSON.stringify(record, null, 2) + '\n')
  console.log('')
  console.log('wrote ' + Object.keys(recorded).length + ' file(s), ' + Math.round(total / 1024) + ' KB, digest ' + digest.slice(0, 16))
  console.log('now run: node packages/dsh-canvas/vendor/konva/build.mjs --check')
}

if (check) runCheck()
else await runUpdate()
