/**
 * dsh-media — the maintainer's tool for the PIN, not the plugin's runtime.
 *
 * `lib/binaries.json` is the only thing this pack ships instead of a 130-170 MB
 * archive per platform, and it is worth exactly as much as its hashes are
 * current. This script is how they stay that way:
 *
 *   node packages/dsh-media/tools/binaries.mjs --check
 *       Offline. Validates the manifest's shape - every entry has an https URL,
 *       a 64-hex SHA-256, a positive byte count and a known archive kind, and
 *       every URL comes from one of the two hosts the manifest is allowed to
 *       name. This is what the tracked checks run.
 *
 *   node packages/dsh-media/tools/binaries.mjs --update [--tag <tag>] [--mac <version>]
 *       Network. Re-reads BtbN's FFmpeg-Builds release assets (and evermeet's
 *       own release info for the macOS x86_64 pair) and rewrites the manifest.
 *       GitHub computes a SHA-256 for every release asset and hands it back in
 *       the API, which is where `--update` takes it from - no download, a
 *       second's work. `--tag latest` follows the rolling build; a date-named
 *       autobuild tag (the default is the newest one) is what a release should
 *       pin, because it keeps its bytes.
 *
 *   node packages/dsh-media/tools/binaries.mjs --verify
 *       Network + disk. Downloads EVERY pinned archive and compares what
 *       arrives against the hash in the manifest. This is what proves the pin
 *       is real rather than transcribed - it is slow (about 600 MB across the
 *       five entries) and it is the only way to be sure, so it is its own flag
 *       rather than something `--update` does behind your back.
 *
 * The macOS arm64 gap is deliberate and explained in the manifest's own
 * `notPinned` block: no Apple-Silicon build publishes both a versioned URL and
 * a checksum, and pinning a URL that moves would break verification instead of
 * strengthening it.
 *
 * `--update` never invents an entry from a partial answer: a platform BtbN did
 * not publish in that tag is left as it was and named in the report.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.join(here, '..', 'lib', 'binaries.json')
const ALLOWED_HOSTS = new Set(['github.com', 'evermeet.cx'])
const ARCHIVE_KINDS = new Set(['zip', 'tar.xz'])
const USER_AGENT = 'dsh-media-binaries'
/** BtbN's asset names, per platform key. Only the STATIC lgpl build is pinned. */
const BTBN = [
  { key: 'win32-x64', match: /^ffmpeg-(N-\d+-g[0-9a-f]+)-win64-lgpl\.zip$/, kind: 'zip' },
  { key: 'win32-arm64', match: /^ffmpeg-(N-\d+-g[0-9a-f]+)-winarm64-lgpl\.zip$/, kind: 'zip' },
  { key: 'linux-x64', match: /^ffmpeg-(N-\d+-g[0-9a-f]+)-linux64-lgpl\.tar\.xz$/, kind: 'tar.xz' },
  { key: 'linux-arm64', match: /^ffmpeg-(N-\d+-g[0-9a-f]+)-linuxarm64-lgpl\.tar\.xz$/, kind: 'tar.xz' },
]
/** evermeet ships one zip per program; both land in the darwin-x64 entry. */
const EVERMEET = ['ffmpeg', 'ffprobe']

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''))
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------
function validate(manifest) {
  const platforms = manifest && typeof manifest.platforms === 'object' && manifest.platforms !== null ? manifest.platforms : null
  check('the manifest has a platforms object', platforms !== null)
  if (platforms === null) return
  const keys = Object.keys(platforms)
  check('it pins at least the four BtbN targets', keys.length >= 4, keys.join(', '))
  for (const key of keys) {
    const entry = platforms[key]
    check(key + ': names its build and version', typeof entry.build === 'string' && entry.build !== '' && typeof entry.version === 'string' && entry.version !== '')
    const archives = Array.isArray(entry.archives) ? entry.archives : []
    check(key + ': has at least one archive', archives.length >= 1)
    for (const archive of archives) {
      const url = String(archive.url ?? '')
      let host = ''
      try {
        host = new URL(url).host
      } catch (err) {
        host = ''
      }
      check(key + ': ' + (url.split('/').pop() || '(no url)') + ' is https on a known host', url.startsWith('https://') && ALLOWED_HOSTS.has(host), host)
      check(key + ': ' + (url.split('/').pop() || '(no url)') + ' carries a SHA-256', /^[0-9a-f]{64}$/.test(String(archive.sha256 ?? '')))
      check(key + ': ' + (url.split('/').pop() || '(no url)') + ' carries a byte count', Number.isInteger(archive.bytes) && archive.bytes > 0, String(archive.bytes))
      check(key + ': ' + (url.split('/').pop() || '(no url)') + ' names a known archive kind', ARCHIVE_KINDS.has(String(archive.kind ?? '')), String(archive.kind))
    }
  }
  check('it says out loud what it does NOT pin', manifest.notPinned !== undefined && typeof manifest.notPinned === 'object')
}

// ---------------------------------------------------------------------------
// --update
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(url + ' answered HTTP ' + response.status)
  return await response.json()
}

/** The digests GitHub publishes for one release's assets. */
async function btbnRelease(tag) {
  const wanted = tag === '' ? 'releases?per_page=1' : 'releases/tags/' + encodeURIComponent(tag)
  const answer = await fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/' + wanted)
  const release = Array.isArray(answer) ? answer[0] : answer
  if (!release || !Array.isArray(release.assets)) throw new Error('that release has no assets')
  return release
}

/**
 * The newest DATE-NAMED autobuild tag.
 *
 * Not the `latest` release: that one is rolling, so its assets are replaced by
 * the next build and a hash taken from it would be wrong within hours. An
 * `autobuild-<date>` tag keeps its bytes, and BtbN retains them for years
 * (38 releases spanning two years, measured) - which is what makes a pin a pin.
 */
async function newestAutobuild() {
  const releases = await fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=20')
  const list = Array.isArray(releases) ? releases : []
  const found = list.find((release) => /^autobuild-\d{4}-\d{2}-\d{2}/.test(String(release.tag_name ?? '')))
  if (!found) throw new Error('no date-named autobuild release in the newest 20 - pass --tag explicitly')
  return String(found.tag_name)
}

/** The macOS x86_64 pair, from evermeet's own release info. */
async function evermeetArchives(version, options) {
  const wanted = version === '' ? 'release' : version
  const archives = []
  for (const name of EVERMEET) {
    const info = await fetchJson('https://evermeet.cx/ffmpeg/info/' + name + '/' + wanted)
    const zip = info && info.download && info.download.zip ? info.download.zip : null
    if (!zip || typeof zip.url !== 'string') throw new Error('evermeet has no zip for ' + name)
    // evermeet publishes a GPG signature, not a checksum, so the hash here is
    // MEASURED: this download is what makes the pin a pin. Both zips together
    // are about 52 MB, which is why only the macOS entry pays for this.
    if (options.hash === false) {
      archives.push({ url: zip.url, sha256: '', bytes: Number(zip.size) || 0, kind: 'zip', version: String(info.version ?? wanted), program: name })
      continue
    }
    const response = await fetch(zip.url, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok || !response.body) throw new Error('evermeet answered HTTP ' + response.status + ' for ' + name)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of Readable.fromWeb(response.body)) {
      bytes += chunk.length
      hash.update(chunk)
    }
    archives.push({ url: zip.url, sha256: hash.digest('hex'), bytes, kind: 'zip', version: String(info.version ?? wanted), program: name })
    console.log('  - darwin-x64: ' + name + ' ' + info.version + ' (' + bytes + ' bytes, hashed here)')
  }
  return archives
}

async function update(options) {
  const manifest = readManifest()
  const platforms = { ...(manifest.platforms ?? {}) }
  const tag = options.tag !== '' ? options.tag : await newestAutobuild()
  const release = await btbnRelease(tag)
  const releaseTag = String(release.tag_name ?? '')
  console.log('BtbN release ' + releaseTag + ' (' + String(release.published_at ?? '') + ')')
  const buildLabel = 'BtbN FFmpeg-Builds ' + releaseTag
  let matched = 0
  for (const target of BTBN) {
    const asset = release.assets.find((entry) => target.match.test(String(entry.name ?? '')))
    if (!asset) {
      console.log('  - ' + target.key + ': not published in this tag, left as it was')
      continue
    }
    const digest = String(asset.digest ?? '')
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      console.log('  - ' + target.key + ': the API published no sha256 digest, left as it was')
      failures += 1
      continue
    }
    const version = target.match.exec(String(asset.name))[1]
    platforms[target.key] = {
      build: buildLabel,
      version,
      license: 'LGPL-2.1-or-later (static, no GPL components)',
      archives: [
        {
          url: String(asset.browser_download_url),
          sha256: digest.slice('sha256:'.length),
          bytes: Number(asset.size) || 0,
          kind: target.kind,
        },
      ],
    }
    matched += 1
    console.log('  - ' + target.key + ': ' + asset.name + ' (' + asset.size + ' bytes)')
  }
  // Silently leaving every entry alone is the failure mode worth refusing: a
  // refresh that changed nothing looks exactly like a refresh that worked.
  if (matched === 0) {
    console.log('')
    console.log('That tag carries none of the static lgpl assets this manifest pins (the rolling `latest` release does not - use a date-named autobuild tag). Nothing was written.')
    failures += 1
    return
  }
  try {
    const mac = await evermeetArchives(options.mac, { hash: options.hashMac })
    platforms['darwin-x64'] = {
      build: 'evermeet.cx release ' + mac[0].version + ' (x86_64; runs on Apple Silicon under Rosetta 2)',
      version: mac[0].version,
      license: 'GPL-3.0-or-later (the evermeet builds are GPL)',
      archives: mac.map((entry) => ({ url: entry.url, sha256: entry.sha256, bytes: entry.bytes, kind: 'zip' })),
    }
  } catch (err) {
    console.log('  - darwin-x64: could not read evermeet (' + (err && err.message ? err.message : String(err)) + '), left as it was')
  }
  manifest.platforms = platforms
  manifest.generated = new Date().toISOString().slice(0, 10)
  manifest.updatedBy = 'node packages/dsh-media/tools/binaries.mjs --update'
  if (options.dryRun) {
    console.log(JSON.stringify(manifest, null, 2))
    return
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('wrote ' + path.relative(process.cwd(), manifestPath))
  // evermeet publishes no hash, so a refresh ALWAYS leaves hashes to fill in by
  // hand for macOS; say so rather than letting an empty field ship as a pin.
  const empty = Object.entries(manifest.platforms).flatMap(([key, entry]) =>
    (entry.archives ?? []).filter((archive) => !/^[0-9a-f]{64}$/.test(String(archive.sha256 ?? ''))).map((archive) => key + ' ' + archive.url),
  )
  if (empty.length > 0) {
    console.log('')
    console.log('These entries have no hash yet - run --verify (it hashes what it downloads) or fill them in by hand:')
    for (const line of empty) console.log('  ' + line)
  }
}

// ---------------------------------------------------------------------------
// --verify
// ---------------------------------------------------------------------------
async function verify() {
  const manifest = readManifest()
  for (const [key, entry] of Object.entries(manifest.platforms ?? {})) {
    for (const archive of entry.archives ?? []) {
      const expected = String(archive.sha256 ?? '')
      const name = key + ' ' + String(archive.url).split('/').pop()
      if (!/^[0-9a-f]{64}$/.test(expected)) {
        check(name + ' has a pinned hash to verify against', false, 'the manifest records none')
        continue
      }
      const started = Date.now()
      try {
        const response = await fetch(archive.url, { headers: { 'user-agent': USER_AGENT } })
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of Readable.fromWeb(response.body)) {
          bytes += chunk.length
          hash.update(chunk)
        }
        const actual = hash.digest('hex')
        const same = actual === expected
        const sizeSame = archive.bytes ? bytes === Number(archive.bytes) : true
        check(name, same && sizeSame, same ? bytes + ' bytes in ' + Math.round((Date.now() - started) / 1000) + 's' : 'sha256 ' + actual + ' (manifest says ' + expected + ')')
      } catch (err) {
        check(name, false, err && err.message ? err.message : String(err))
      }
    }
  }
}

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
if (argv.includes('--check')) {
  const manifest = readManifest()
  validate(manifest)
  console.log('')
  console.log(failures === 0 ? 'the pinned manifest is well formed' : failures + ' manifest check(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
} else if (argv.includes('--update')) {
  await update({ tag: flag('--tag', ''), mac: flag('--mac', ''), hashMac: !argv.includes('--no-hash-mac'), dryRun: argv.includes('--dry-run') })
  process.exitCode = failures === 0 ? 0 : 1
} else if (argv.includes('--verify')) {
  await verify()
  console.log('')
  console.log(failures === 0 ? 'every pinned archive matches its hash' : failures + ' pinned archive(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
} else {
  console.log('usage: node packages/dsh-media/tools/binaries.mjs --check | --update [--tag <tag>] [--mac <version>] [--no-hash-mac] [--dry-run] | --verify')
  process.exitCode = 2
}
