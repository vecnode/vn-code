/**
 * dsh-media — where the ffmpeg and ffprobe this plugin runs actually come from.
 *
 * The pack ships no binary in the repository: a static ffmpeg is 130-170 MB per
 * platform and would be multiplied into every clone, every distribution and
 * every CI cache - and a committed Windows build helps no one on macOS. What
 * THIS plugin ships instead is a pin: `lib/binaries.json` names, per platform
 * and architecture, the exact official static build to fetch and its SHA-256.
 * On first need the copy is downloaded ONCE into
 * `$DSH_HOME/dsh-media/bin/<platform>-<arch>/`, verified against that hash
 * before anything is executed, extracted with the host's own `tar`, and
 * remembered by an `install.json` stamp. From then on it is a local file like
 * any other, and every later call - and every later boot - costs nothing.
 *
 * The order of business is deliberate:
 *
 *   1. `DSH_MEDIA_FFMPEG` / `DSH_MEDIA_FFPROBE` - an explicit path wins, always.
 *   2. `ffmpeg` / `ffprobe` on PATH - the machine's own install is used as it is
 *      rather than downloading a second copy of the same program. This is why a
 *      developer machine downloads nothing at all.
 *   3. the provisioned copy under `$DSH_HOME/dsh-media/bin/` - what a machine
 *      with no ffmpeg of its own ends up using. `DSH_MEDIA_PREFER_BUNDLED=1`
 *      makes this win over PATH as well, for a deployment that wants one known
 *      build everywhere.
 *   4. nothing: the plugin says so in a sentence naming this list, and (unless
 *      `DSH_MEDIA_NO_INSTALL=1`) starts the pinned download in the BACKGROUND,
 *      so a tool call answers immediately instead of blocking on 160 MB.
 *
 * A machine with no pinned build for its platform (or a download that will not
 * finish) still loses nothing but the fallback: a PATH install, `brew install
 * ffmpeg`, or the two environment variables are all first-class ways to have
 * ffmpeg, and the plugin reports which one answered.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { runQuiet } from './run.js'

/** Where the pinned builds are recorded. */
const MANIFEST_FILE = new URL('./binaries.json', import.meta.url)
/** How long a download may take, and how long it may stall, before it is given up. */
const DOWNLOAD_DEADLINE_MS = 60 * 60 * 1000
const DOWNLOAD_STALL_MS = 120 * 1000
/** The most any pinned archive may be, whatever the manifest says. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
/** A lock older than this is a killed process, not a running download. */
const LOCK_STALE_MS = 30 * 60 * 1000
/** The `-version` banner, cached per binary path. */
const versionCache = new Map()

/** `$DSH_HOME` (or `~/.dsh`), the same resolution every package here performs. */
export function resolveHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : ''
  return configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

/** `win32-x64`, `darwin-arm64`, `linux-x64` - the key one pinned build hangs off. */
export function platformKey(platform = process.platform, arch = process.arch) {
  return platform + '-' + arch
}

/** The file name of one program on one platform. */
export function binaryName(name, platform = process.platform) {
  return platform === 'win32' ? name + '.exe' : name
}

/** The pinned manifest, as data. A missing or broken file is an empty table. */
export function loadManifest() {
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(MANIFEST_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { platforms: {} }
  } catch (err) {
    return { platforms: {}, error: err && err.message ? String(err.message) : String(err) }
  }
}

/** The pinned entry for one platform key, or null when this release pins none. */
export function pinFor(key, manifest = loadManifest()) {
  const table = manifest.platforms && typeof manifest.platforms === 'object' ? manifest.platforms : {}
  const entry = table[key]
  return entry && typeof entry === 'object' ? entry : null
}

/** Where a provisioned copy lives for this platform. */
export function installDir({ home = resolveHome(), key = platformKey() } = {}) {
  return path.join(home, 'dsh-media', 'bin', key)
}

/** The install stamp of a provisioned copy, or null when there is none. */
export function readStamp({ home, key } = {}) {
  const file = path.join(installDir({ home, key }), 'install.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

/** Whether both programs are actually present in an install directory. */
function installComplete(dir, platform) {
  return ['ffmpeg', 'ffprobe'].every((name) => {
    try {
      return statSync(path.join(dir, binaryName(name, platform))).isFile()
    } catch (err) {
      return false
    }
  })
}

/**
 * Find one program on PATH, honouring the host's own executable suffixes.
 *
 * @param name - `'ffmpeg'` or `'ffprobe'`.
 * @param env - the environment to search.
 * @returns the absolute path, or null.
 */
export function findOnPath(name, env = process.env) {
  const platform = process.platform
  const raw = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : ''
  if (raw === '') return null
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of raw.split(path.delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch (err) {
        /* keep looking */
      }
    }
  }
  return null
}

/**
 * Every way this plugin can find one program, in the order it prefers them.
 *
 * @param options - `{ home, env, preferBundled }`.
 * @returns `{ ffmpeg, ffprobe, platform, key, bundled, pinned, install }`.
 */
export function resolveBinaries(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? resolveHome(env)
  const key = platformKey()
  const platform = process.platform
  const dir = installDir({ home, key })
  const bundled = installComplete(dir, platform)
  const preferBundled = options.preferBundled ?? env.DSH_MEDIA_PREFER_BUNDLED === '1'
  const pinned = pinFor(key)
  const locate = (name) => {
    const override = name === 'ffmpeg' ? env.DSH_MEDIA_FFMPEG : env.DSH_MEDIA_FFPROBE
    if (typeof override === 'string' && override.trim() !== '') {
      const file = path.resolve(override.trim())
      try {
        if (statSync(file).isFile()) return { file, source: 'env' }
      } catch (err) {
        return { file: null, source: 'env-missing', missing: file }
      }
    }
    const bundledFile = path.join(dir, binaryName(name, platform))
    if (bundled && preferBundled) return { file: bundledFile, source: 'bundled' }
    const onPath = findOnPath(name, env)
    if (onPath !== null) return { file: onPath, source: 'path' }
    if (bundled) return { file: bundledFile, source: 'bundled' }
    return { file: null, source: 'none' }
  }
  return {
    platform,
    key,
    home,
    dir,
    bundled,
    pinned: pinned !== null,
    install: installStatus({ home, key }),
    ffmpeg: locate('ffmpeg'),
    ffprobe: locate('ffprobe'),
  }
}

/**
 * The `-version` banner's first line for one binary, cached per path.
 *
 * @returns `{ ok, line, description }` - ffmpeg's own words, or why there are none.
 */
export async function versionOf(file, options = {}) {
  if (typeof file !== 'string' || file === '') return { ok: false, line: '', description: 'no binary' }
  const cached = versionCache.get(file)
  if (cached) return cached
  const result = await runQuiet({
    file,
    args: ['-version'],
    timeoutMs: 20_000,
    maxOutputChars: 8_000,
    signal: options.signal,
  })
  const first = String(result.output).split('\n').find((line) => line.trim() !== '') ?? ''
  const value = {
    ok: result.ok,
    line: first.trim(),
    description: first.trim() === '' ? 'the binary did not report a version (exit ' + String(result.code) + ')' : '',
  }
  if (result.ok) versionCache.set(file, value)
  return value
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------
/**
 * The status of the pinned copy on this machine.
 *
 * `state` is one of:
 *   - `installed`   both programs are on disk, with the stamp that says so;
 *   - `installing`  a download is running in THIS process (`progress`);
 *   - `absent`      nothing installed, nothing running;
 *   - `failed`      the last attempt failed (`error`), and can be retried;
 *   - `unsupported` this release pins no build for this platform or architecture.
 */
export function installStatus({ home = resolveHome(), key = platformKey() } = {}) {
  const active = runningInstalls.get(key)
  const stamp = readStamp({ home, key })
  const complete = installComplete(installDir({ home, key }), process.platform)
  const pinned = pinFor(key)
  if (active) return { ...active, state: 'installing' }
  if (stamp && complete) {
    return {
      state: 'installed',
      key,
      build: stamp.build ?? '',
      version: stamp.version ?? '',
      license: stamp.license ?? '',
      installedAt: stamp.installedAt ?? '',
      bytes: stamp.bytes ?? 0,
    }
  }
  const lastFailure = installFailures.get(key)
  if (lastFailure) return { state: 'failed', key, error: lastFailure, ...(pinned ? { build: pinned.build ?? '' } : {}) }
  if (!pinned) return { state: 'unsupported', key, message: unsupportedMessage(key) }
  return { state: 'absent', key, build: pinned.build ?? '', version: pinned.version ?? '', bytes: totalBytes(pinned) }
}

/** What to say when this release pins nothing for the host's platform. */
function unsupportedMessage(key) {
  return (
    'No ffmpeg build is pinned for ' +
    key +
    ' in this release, so it cannot be downloaded automatically. Install it with the platform package manager (winget install Gyan.FFmpeg, brew install ffmpeg, apt install ffmpeg), or point DSH_MEDIA_FFMPEG and DSH_MEDIA_FFPROBE at binaries you already have.'
  )
}

/** The declared download size of one pinned entry. */
function totalBytes(pinned) {
  const archives = Array.isArray(pinned.archives) ? pinned.archives : []
  return archives.reduce((sum, archive) => sum + (Number(archive.bytes) || 0), 0)
}

/** Downloads running in this process, per platform key. */
const runningInstalls = new Map()
/** The last failure per platform key, in this process. */
const installFailures = new Map()

/**
 * Start (or join) the pinned download for this platform.
 *
 * Returns immediately: the download continues in the background and its
 * progress is visible in `installStatus`. Two callers - a tool call and the
 * video tab, say - share ONE download, and a second process that finds a live
 * lock leaves it alone rather than fighting over the same directory.
 *
 * @param options - `{ home, log, key, force, entry }`. `entry` may supply its
 *   own pinned archives (a company mirror, a private build, a test fixture);
 *   the manifest's entry for this platform is the default and is otherwise the
 *   only thing that is ever downloaded.
 * @returns the install status right now.
 */
export function startProvision(options = {}) {
  const home = options.home ?? resolveHome()
  const key = options.key ?? platformKey()
  const log = options.log ?? { warn() {}, info() {} }
  const running = runningInstalls.get(key)
  if (running) return { ...running, state: 'installing' }
  const pinned = options.entry ?? pinFor(key)
  if (!pinned) return { state: 'unsupported', key, message: unsupportedMessage(key) }
  const installed = installStatus({ home, key })
  if (installed.state === 'installed' && options.force !== true) return installed

  installFailures.delete(key)
  const status = {
    key,
    build: pinned.build ?? '',
    version: pinned.version ?? '',
    license: pinned.license ?? '',
    url: (pinned.archives ?? []).map((archive) => archive.url).join(' '),
    bytes: totalBytes(pinned),
    received: 0,
    percent: 0,
    startedAt: new Date().toISOString(),
    message: 'downloading the pinned build',
  }
  runningInstalls.set(key, status)
  const task = provision({ home, key, pinned, status, log })
    .then((result) => {
      runningInstalls.delete(key)
      if (!result.ok) installFailures.set(key, result.error)
      return result
    })
    .catch((err) => {
      runningInstalls.delete(key)
      const message = err && err.message ? String(err.message) : String(err)
      installFailures.set(key, message)
      log.warn?.('provisioning failed: ' + message)
      return { ok: false, error: message }
    })
  // A failed background download must not be an unhandled rejection.
  task.catch(() => {})
  return { ...status, state: 'installing' }
}

/** The whole provisioning pipeline for one pinned entry. */
async function provision({ home, key, pinned, status, log }) {
  const dir = installDir({ home, key })
  await fsp.mkdir(dir, { recursive: true })
  const lock = path.join(dir, '.install.lock')
  if (!(await takeLock(lock))) {
    const message = 'another dsh process is already downloading the pinned ffmpeg build'
    status.message = message
    return { ok: false, error: message }
  }
  const temp = await fsp.mkdtemp(path.join(dir, '.download-'))
  try {
    const archives = Array.isArray(pinned.archives) ? pinned.archives : []
    if (archives.length === 0) throw new Error('the pinned entry names no archive')
    const extracted = []
    for (const archive of archives) {
      const file = path.join(temp, 'archive-' + extracted.length)
      await download(archive, file, status, log)
      const target = path.join(temp, 'unpacked-' + extracted.length)
      await fsp.mkdir(target, { recursive: true })
      await extract(file, target, log)
      extracted.push(target)
    }
    const platform = process.platform
    for (const name of ['ffmpeg', 'ffprobe']) {
      const wanted = binaryName(name, platform)
      const found = await findFile(extracted, wanted)
      if (found === null) throw new Error('the pinned archive does not contain ' + wanted)
      const destination = path.join(dir, wanted)
      // Copy through a partial name and rename, so a binary that exists is
      // always a complete binary - a half-written ffmpeg.exe is unexecutable.
      const partial = destination + '.partial'
      await fsp.copyFile(found, partial)
      if (platform !== 'win32') await fsp.chmod(partial, 0o755)
      await fsp.rename(partial, destination)
    }
    const stamp = {
      key,
      build: pinned.build ?? '',
      version: pinned.version ?? '',
      license: pinned.license ?? '',
      source: (pinned.archives ?? []).map((archive) => ({ url: archive.url, sha256: archive.sha256 })),
      bytes: totalBytes(pinned),
      installedAt: new Date().toISOString(),
    }
    await fsp.writeFile(path.join(dir, 'install.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
    status.message = 'installed'
    versionCache.clear()
    log.info?.('provisioned ' + key + ' into ' + dir)
    return { ok: true, dir }
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(lock, { recursive: true, force: true }).catch(() => {})
  }
}

/** Take the install lock, stealing it when the process that wrote it is gone. */
async function takeLock(lock) {
  try {
    await fsp.mkdir(lock)
    return true
  } catch (err) {
    try {
      const stats = await fsp.stat(lock)
      if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false
      await fsp.rm(lock, { recursive: true, force: true })
      await fsp.mkdir(lock)
      return true
    } catch (err2) {
      return false
    }
  }
}

/** Download one archive, hashing it as it arrives. */
async function download(archive, file, status, log) {
  const url = String(archive.url ?? '')
  const expected = String(archive.sha256 ?? '').toLowerCase()
  if (url === '' || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('the pinned entry for this archive is incomplete')
  const declared = Number(archive.bytes) || 0
  const cap = declared > 0 ? Math.min(MAX_ARCHIVE_BYTES, Math.max(declared + 1024 * 1024, Math.floor(declared * 1.05))) : MAX_ARCHIVE_BYTES
  const controller = new AbortController()
  let stall = null
  const resetStall = () => {
    if (stall !== null) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS)
    if (typeof stall.unref === 'function') stall.unref()
  }
  const deadline = setTimeout(() => controller.abort(), DOWNLOAD_DEADLINE_MS)
  if (typeof deadline.unref === 'function') deadline.unref()
  let handle = null
  try {
    resetStall()
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error('the download answered HTTP ' + response.status)
    const hash = createHash('sha256')
    handle = await fsp.open(file, 'w')
    let received = 0
    const base = Number(status.received) || 0
    const stream = Readable.fromWeb(response.body)
    for await (const chunk of stream) {
      resetStall()
      received += chunk.length
      if (received > cap) throw new Error('the download is larger than the pinned size (' + received + ' bytes)')
      hash.update(chunk)
      await handle.write(chunk)
      // One progress field, read by the state route and the video tab.
      status.received = base + received
      status.percent = status.bytes > 0 ? Math.min(99, Math.round((status.received / status.bytes) * 100)) : 0
    }
    await handle.close()
    handle = null
    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error('the download does not match its pinned SHA-256 (expected ' + expected + ', got ' + actual + ') - it was discarded')
    }
    status.percent = Math.min(99, Math.round(((base + received) / (status.bytes || base + received)) * 100))
    log.info?.('verified ' + path.basename(url) + ' (' + received + ' bytes)')
  } catch (err) {
    const aborted = controller.signal.aborted
    throw new Error(
      aborted
        ? 'the download of ' + url + ' timed out or stalled'
        : err && err.message
          ? String(err.message)
          : String(err),
    )
  } finally {
    if (stall !== null) clearTimeout(stall)
    clearTimeout(deadline)
    if (handle !== null) await handle.close().catch(() => {})
  }
}

/**
 * Unpack one archive with the host's own `tar`.
 *
 * bsdtar is what Windows 10+ and macOS ship as `tar`, and it reads ZIP as well
 * as tar.xz; GNU tar on Linux reads the tar.xz builds. Using the system tool
 * keeps this plugin free of an npm archive dependency - which this pack does
 * not have anywhere - at the cost of naming the one thing that must exist.
 */
async function extract(file, target, log) {
  const tar = process.platform === 'win32' && process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
  const result = await runQuiet({ file: existsSync(tar) ? tar : 'tar', args: ['-xf', file, '-C', target], timeoutMs: 15 * 60 * 1000, maxOutputChars: 20_000 })
  if (!result.ok) {
    throw new Error(
      'the pinned archive could not be unpacked with `tar` (exit ' + String(result.code) + (result.output ? ': ' + result.output.trim().split('\n')[0] : '') + '). Windows 10+, macOS and Linux all ship one; a minimal container needs it installed.',
    )
  }
  log.info?.('unpacked ' + path.basename(file))
}

/**
 * Find one file by name anywhere under a set of roots, preferring a `bin/`
 * directory - which is where every pinned build puts the executables.
 */
async function findFile(roots, wanted, depth = 0) {
  const candidates = []
  const walk = async (dir, level) => {
    if (level > 4) return
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, level + 1)
      else if (entry.name === wanted) candidates.push(full)
    }
  }
  for (const root of roots) await walk(root, depth)
  if (candidates.length === 0) return null
  const inBin = candidates.find((candidate) => path.basename(path.dirname(candidate)) === 'bin')
  return inBin ?? candidates[0]
}

/**
 * Resolve one program for a call, starting the pinned download when there is
 * nothing to run - the "answer now, install in the background" contract every
 * tool here follows.
 *
 * @param name - `'ffmpeg'` or `'ffprobe'`.
 * @param options - `{ home, env, log, install }`.
 * @returns `{ ok: true, file, source }` or `{ ok: false, code, message }`.
 */
export async function ensureBinary(name, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? resolveHome(env)
  const found = resolveBinaries({ home, env })[name]
  if (found.file !== null) return { ok: true, file: found.file, source: found.source }
  const message =
    found.source === 'env-missing'
      ? 'The ' +
        (name === 'ffmpeg' ? 'DSH_MEDIA_FFMPEG' : 'DSH_MEDIA_FFPROBE') +
        ' path does not exist: ' +
        String(found.missing) +
        '. Fix it or unset it and this plugin will use the pinned copy or PATH.'
      : 'Neither ffmpeg nor ffprobe is available here.'
  if (options.install === false || env.DSH_MEDIA_NO_INSTALL === '1') {
    return { ok: false, code: found.source === 'env-missing' ? 'ENV_MISSING' : 'NO_FFMPEG', message }
  }
  const status = startProvision({ home, log: options.log })
  if (status.state === 'installing') {
    return {
      ok: false,
      code: 'PROVISIONING',
      message:
        'No ffmpeg on this machine yet, so the pinned static build (' +
        (status.bytes > 0 ? Math.round(status.bytes / (1024 * 1024)) + ' MB, ' : '') +
        'ffmpeg ' +
        (status.version || status.build || 'pinned') +
        ') is downloading into ' +
        installDir({ home }) +
        ' right now. Call this tool again in a minute - the download is shared and already running.',
    }
  }
  if (status.state === 'installed') {
    return { ok: false, code: 'RETRY', message: 'The pinned ffmpeg build just finished installing; call this tool again.' }
  }
  if (status.state === 'failed') {
    return {
      ok: false,
      code: 'PROVISION_FAILED',
      message:
        'The pinned ffmpeg build could not be installed: ' +
        status.error +
        ' Install ffmpeg with the platform package manager (winget install Gyan.FFmpeg, brew install ffmpeg, apt install ffmpeg), or point DSH_MEDIA_FFMPEG at a binary you have.',
    }
  }
  return { ok: false, code: 'NO_FFMPEG', message: status.message ? status.message : message }
}
