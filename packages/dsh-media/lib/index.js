/**
 * dsh-media — host half.
 *
 * The pack's media machinery, in one place, because the agent and the video tab
 * must not be able to disagree about a file:
 *
 *   - **three tools** (`media_probe`, `media_run`, `media_frames`) built in
 *     `lib/tools.js`, all of them resolving ffmpeg/ffprobe through `lib/ffmpeg.js`;
 *   - **two skills** (`ffmpeg-cli`, `ffprobe-cli`) registered from this package's
 *     own `skills/` folder and copied into `$DSH_HOME/skills` by both installers;
 *   - **the pinned copy**: `lib/binaries.json` names the exact static build to
 *     fetch per platform with its SHA-256, and `POST /provision` (or a tool
 *     call that needs a binary) installs it into `$DSH_HOME/dsh-media/bin/`;
 *   - **the routes the video tab lives on** (`dsh-video` is a client-only
 *     bundle): `GET /file` streams a media file with HTTP RANGE support so a
 *     2 GB film seeks instead of being read into memory, `GET /report` is the
 *     same ffprobe summary `media_probe` prints, and `POST /remux` + `GET /job`
 *     turn a container a browser cannot open into a cached MP4 it can.
 *
 * Why the video routes live HERE rather than in dsh-video: a remux is ffmpeg,
 * and ffmpeg has exactly one owner in this pack. dsh-video ships the tab, the
 * player and the dress; dsh-media ships the bytes, the probe and the transcode,
 * so a profile that installs one and not the other gets an honest sentence
 * instead of two half-implementations of the same path policy.
 *
 * Nothing here reads a file the caller did not name, nothing runs a shell, and
 * no route accepts a path it does not re-validate: see `lib/paths.js`.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { ensureBinary, installDir, installStatus, platformKey, readStamp, resolveBinaries, resolveHome, startProvision, versionOf } from './ffmpeg.js'
import { errorToResponse, fail, httpError, json, readJsonBody } from './http.js'
import { resolveDirectory, resolveTarget } from './paths.js'
import { formatBytes, formatDuration, playability, probeJson, summarize } from './probe.js'
import { clampTimeout, runBinary } from './run.js'
import { buildTools, sessionOf } from './tools.js'

/** The row's identity, and the services activation waits for. */
export const name = 'dsh-media'
export const inject = ['connection', 'tools']

/** This build's marker (the tracked checks pin it against package.json). */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** Every route this plugin owns, kept in sync with dsh-video's client by hand. */
const API_ROOT = '/api/dsh-media'
export const STATE_ROUTE = API_ROOT + '/state'
export const HEALTH_ROUTE = API_ROOT + '/health'
export const PROVISION_ROUTE = API_ROOT + '/provision'
export const REPORT_ROUTE = API_ROOT + '/report'
export const FILE_ROUTE = API_ROOT + '/file'
export const REMUX_ROUTE = API_ROOT + '/remux'
export const JOB_ROUTE = API_ROOT + '/job'

/**
 * The extensions the video surface claims, and the only ones `GET /file` will
 * stream. Audio formats are deliberately absent: WAV/AIFF/FLAC belong to
 * dsh-audio's waveform and MP3/M4A/Ogg to the shipped preview's own player, so
 * claiming them here would take a surface away rather than add one.
 */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ogv', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'mts']

/** What a browser can be handed, by extension. */
const CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
}

/** One remux/transcode may run this long before it is killed. */
const JOB_TIMEOUT_MS = 15 * 60 * 1000
/** How long a finished job's result is remembered. */
const JOB_TTL_MS = 60 * 60 * 1000
/** At most this many remuxes run at once. */
const MAX_JOBS = 2
/** The cache of browser-playable copies. */
const CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024

/** The two skills this package ships, as files beside this module. */
const SKILL_FILES = [
  { name: 'ffmpeg-cli', file: '../skills/ffmpeg-cli/SKILL.md' },
  { name: 'ffprobe-cli', file: '../skills/ffprobe-cli/SKILL.md' },
]

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * @param text - the file's contents.
 * @returns `{ meta, content }`.
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, content: normalized.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!entry) continue
    let value = entry[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    meta[entry[1]] = value
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/** One skill's own header, parsed out of its file. */
export function readSkill(entry) {
  const file = fileURLToPath(new URL(entry.file, import.meta.url))
  const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
  return { file, meta, content }
}

/**
 * Register the bundled skills. The registry is resolved lazily (its absence
 * only skips the skills, never the tools) and a missing file is a warning
 * rather than a failure - the installers also copy these files into
 * `$DSH_HOME/skills`, so a host without the registry still gets the catalog
 * entry from the filesystem provider.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn }`.
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled ffmpeg/ffprobe skills were not registered')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const { meta, content } = readSkill(entry)
      if (content.length === 0) {
        log.warn('skill file is empty: ' + entry.file)
        continue
      }
      const skillName = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name
      ctx.effect(
        () =>
          skills.register({
            name: skillName,
            description: typeof meta.description === 'string' ? meta.description : '',
            whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
            content,
            provider: 'dsh-media',
          }),
        'dsh-media: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// The capability snapshot
// ---------------------------------------------------------------------------
/**
 * The one status both the state and health routes answer with: which binary is
 * in use and where it came from, what the pinned copy is doing, and the caps
 * every call in this plugin obeys.
 */
export async function snapshot(deps, options = {}) {
  const resolved = resolveBinaries({ home: deps.home, env: deps.env })
  const describe = async (name) => {
    const entry = resolved[name]
    if (entry.file === null) {
      return { found: false, source: entry.source, path: '', version: '', missing: entry.missing ?? '' }
    }
    const version = options.withVersion === false ? { line: '' } : await versionOf(entry.file, { signal: options.signal })
    return { found: true, source: entry.source, path: entry.file, version: version.line ?? '', description: version.description ?? '' }
  }
  return {
    version: PLUGIN_VERSION,
    platform: resolved.key,
    home: deps.home,
    binaries: { ffmpeg: await describe('ffmpeg'), ffprobe: await describe('ffprobe') },
    provision: resolved.install,
    installDir: installDir({ home: deps.home, key: resolved.key }),
    pinned: resolved.pinned,
    caps: {
      maxArgs: 200,
      maxFrames: 24,
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      maxOutputChars: 1_000_000,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      maxJobs: MAX_JOBS,
      cacheMaxBytes: CACHE_MAX_BYTES,
    },
    routes: [STATE_ROUTE, HEALTH_ROUTE, PROVISION_ROUTE, REPORT_ROUTE, FILE_ROUTE, REMUX_ROUTE, JOB_ROUTE],
    tools: ['media_probe', 'media_run', 'media_frames'],
    skills: SKILL_FILES.map((entry) => entry.name),
  }
}

// ---------------------------------------------------------------------------
// Jobs: a remux or a transcode, in the background
// ---------------------------------------------------------------------------
/** Every job this process knows about, by id. */
const jobs = new Map()

/** The plugin's shared dependencies, one per boot. */
export function createDeps(ctx, options = {}) {
  const env = options.env ?? process.env
  const home = resolveHome(env)
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-media] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-media] ' + text),
  }
  return { ctx, env, home, log }
}

/** The cache directory for browser-playable copies. */
function cacheDir(home) {
  return path.join(home, 'dsh-media', 'playable')
}

/** The identity of one file, as a cache key: content never keys on a name. */
function cacheKeyFor(file, stat, mode) {
  return createHash('sha256').update(file + '\u0000' + stat.size + '\u0000' + Math.round(stat.mtimeMs) + '\u0000' + mode).digest('hex').slice(0, 32)
}

/** One cached copy's path, or null when that key is not a key. */
export function cachePathFor(home, key) {
  if (!/^[0-9a-f]{32}$/.test(String(key ?? ''))) return null
  return path.join(cacheDir(home), key + '.mp4')
}

/** Every cached copy, oldest first - what the LRU prunes from. */
async function listCache(home) {
  try {
    const names = await fsp.readdir(cacheDir(home))
    const entries = []
    for (const entry of names) {
      if (!/^[0-9a-f]{32}\.mp4$/.test(entry)) continue
      const file = path.join(cacheDir(home), entry)
      try {
        const stats = await fsp.stat(file)
        entries.push({ file, size: stats.size, mtimeMs: stats.mtimeMs })
      } catch (err) {
        /* it vanished between the listing and the stat */
      }
    }
    return entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  } catch (err) {
    return []
  }
}

/** Keep the cache under its ceiling by removing the oldest copies. */
async function pruneCache(home, log) {
  const entries = await listCache(home)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  while (total > CACHE_MAX_BYTES && entries.length > 0) {
    const oldest = entries.shift()
    try {
      await fsp.rm(oldest.file, { force: true })
      total -= oldest.size
      log?.info?.('pruned a cached playable copy (' + formatBytes(oldest.size) + ')')
    } catch (err) {
      break
    }
  }
}

/** A job as the routes report it. */
function jobView(job) {
  return {
    id: job.id,
    state: job.state,
    mode: job.mode,
    file: job.file,
    name: path.basename(job.file),
    percent: job.percent,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
    message: job.message,
    error: job.error,
    command: job.command,
    cache: job.state === 'done' ? job.id : '',
    url: job.state === 'done' ? FILE_ROUTE + '?cache=' + job.id : '',
    bytes: job.bytes ?? null,
  }
}

/** Drop finished jobs nobody will ask about again. */
function reapJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && now - (job.finishedAt ?? job.startedAt) > JOB_TTL_MS) jobs.delete(id)
  }
}

/**
 * Start (or join) the job that makes one file playable in a browser.
 *
 * @param deps - the plugin's dependencies.
 * @param request - `{ session, path, mode }`.
 * @returns the job view.
 */
export async function startPlayableJob(deps, request) {
  reapJobs()
  const target = await resolveTarget(deps.ctx, { session: request.session, path: request.path, extensions: VIDEO_EXTENSIONS, label: 'video' })
  const ffprobe = await ensureBinary('ffprobe', { home: deps.home, env: deps.env, log: deps.log })
  if (!ffprobe.ok) throw httpError(503, 'NO_FFPROBE', ffprobe.message)
  const answer = await probeJson({ file: ffprobe.file, path: target.file })
  if (!answer.ok && answer.json === null) throw httpError(415, 'UNREADABLE', 'ffprobe could not read that file: ' + answer.error)
  const facts = summarize({ file: target.file, name: path.basename(target.file), size: target.size, json: answer.json, path: target.file })
  const verdict = playability(facts).verdict
  const mode = request.mode === 'remux' || request.mode === 'transcode' ? request.mode : verdict === 'remux' ? 'remux' : 'transcode'
  if (verdict === 'playable') {
    return { id: '', state: 'not-needed', mode: 'none', file: target.file, name: path.basename(target.file), percent: 100, message: 'a browser plays this file as it is', command: '', cache: '', url: '', elapsedMs: 0 }
  }
  const stats = statSync(target.file)
  const id = cacheKeyFor(target.file, stats, mode)
  const cached = cachePathFor(deps.home, id)
  const running = jobs.get(id)
  if (running) return jobView(running)
  if (cached !== null && existsSync(cached)) {
    const stats2 = statSync(cached)
    const job = {
      id,
      state: 'done',
      mode,
      file: target.file,
      percent: 100,
      message: 'already converted',
      error: '',
      command: '',
      startedAt: Date.now() - 1,
      finishedAt: Date.now(),
      bytes: stats2.size,
    }
    jobs.set(id, job)
    return jobView(job)
  }
  const active = [...jobs.values()].filter((job) => job.state === 'running')
  if (active.length >= MAX_JOBS) throw httpError(429, 'TOO_MANY_JOBS', 'Two conversions are already running; wait for one to finish.')

  const ffmpeg = await ensureBinary('ffmpeg', { home: deps.home, env: deps.env, log: deps.log })
  if (!ffmpeg.ok) throw httpError(503, 'NO_FFMPEG', ffmpeg.message)
  const argv = convertArgs({ mode, file: target.file, output: cached, facts })
  const job = {
    id,
    state: 'running',
    mode,
    file: target.file,
    percent: 0,
    message: mode === 'remux' ? 'remuxing (no re-encode)' : 'transcoding',
    error: '',
    command: 'ffmpeg ' + argv.map((entry) => (/\s/.test(entry) ? '"' + entry + '"' : entry)).join(' '),
    startedAt: Date.now(),
    finishedAt: null,
    durationSec: facts.durationSec,
    bytes: null,
  }
  jobs.set(id, job)
  runConvert({ deps, job, argv, ffmpeg: ffmpeg.file, output: cached }).catch((err) => {
    job.state = 'failed'
    job.error = messageOf(err)
    job.finishedAt = Date.now()
    deps.log.warn('a conversion failed: ' + job.error)
  })
  return jobView(job)
}

/** The ffmpeg arguments one conversion uses. */
function convertArgs({ mode, file, output, facts }) {
  const map = ['-map', '0:v?', '-map', '0:a?']
  if (mode === 'remux') {
    // A remux copies the streams, so the container is the only thing that
    // changes - unless the source carries a subtitle MP4 cannot hold, which is
    // why only video and audio are mapped and the rest is dropped by name in
    // the job's message rather than failing the whole conversion.
    return ['-nostdin', '-n', '-i', file, ...map, '-c', 'copy', '-movflags', '+faststart', output]
  }
  const hasVideo = facts.video.length > 0
  if (!hasVideo) {
    return ['-nostdin', '-n', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]
  }
  return ['-nostdin', '-n', '-i', file, ...map, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output]
}

/** Run one conversion, reporting progress from ffmpeg's own `-progress` stream. */
async function runConvert({ deps, job, argv, ffmpeg, output }) {
  await fsp.mkdir(cacheDir(deps.home), { recursive: true })
  const args = [...argv]
  // `-progress pipe:1` makes ffmpeg print machine-readable progress to stdout,
  // which is the only honest way to show a percent: it is ffmpeg's own count of
  // what it has written, not an estimate.
  args.splice(args.length - 1, 0, '-progress', 'pipe:1', '-nostats')
  const result = await runBinary({
    file: ffmpeg,
    args,
    timeoutMs: JOB_TIMEOUT_MS,
    maxOutputChars: 200_000,
    onOutput: (chunk, source) => {
      if (source !== 'out') return
      // `-progress` writes key=value lines, and a chunk boundary can split one:
      // keep a small tail so a split `out_time_us` is still read.
      const buffer = (job.progressTail ?? '') + chunk
      const matches = [...buffer.matchAll(/out_time_us=(\d+)/g)]
      if (matches.length > 0 && job.durationSec && job.durationSec > 0) {
        const seconds = Number(matches[matches.length - 1][1]) / 1_000_000
        job.percent = Math.max(0, Math.min(99, Math.round((seconds / job.durationSec) * 100)))
      }
      job.progressTail = buffer.slice(-64)
    },
  })
  job.finishedAt = Date.now()
  if (result.code === 0 && existsSync(output)) {
    job.state = 'done'
    job.percent = 100
    job.bytes = statSync(output).size
    job.message = 'ready — ' + formatBytes(job.bytes) + ' in ' + Math.round((job.finishedAt - job.startedAt) / 1000) + 's'
    await pruneCache(deps.home, deps.log)
    return
  }
  // A partial file must never be served as if it were whole.
  await fsp.rm(output, { force: true }).catch(() => {})
  job.state = 'failed'
  job.error =
    (result.timedOut ? 'the conversion was killed after ' + Math.round(JOB_TIMEOUT_MS / 1000) + 's' : 'ffmpeg exited ' + String(result.code)) +
    ': ' +
    (String(result.output).trim().split('\n').filter(Boolean).pop() ?? 'no output')
  job.message = 'failed'
}

// ---------------------------------------------------------------------------
// Streaming one file, with ranges
// ---------------------------------------------------------------------------
/** Parse one `Range` header against a known size. */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    // A suffix range: the LAST n bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/** A streamed response for one file, honouring `Range` and `HEAD`. */
function streamFile(request, file, size, type, extraHeaders = {}) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    ...extraHeaders,
  }
  const range = request.headers.get('range')
  if (range === null) {
    headers['content-length'] = String(size)
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers })
  }
  const parsed = parseRange(range, size)
  if (parsed === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': 'bytes */' + size },
    })
  }
  const length = parsed.end - parsed.start + 1
  headers['content-length'] = String(length)
  headers['content-range'] = 'bytes ' + parsed.start + '-' + parsed.end + '/' + size
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
  return new Response(Readable.toWeb(createReadStream(file, { start: parsed.start, end: parsed.end })), { status: 206, headers })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * Register every route on the connection's fetch registry.
 *
 * @param deps - the plugin's dependencies.
 * @returns a disposer that unregisters everything.
 */
export function registerRoutes(deps) {
  const connection = typeof deps.ctx.get === 'function' ? deps.ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-media/* routes were not registered')
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            return errorToResponse(err)
          }
        },
      }),
    )
  }

  register(STATE_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...(await snapshot(deps)) }))
  register(HEALTH_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...(await snapshot(deps)) }))

  /** Start the pinned download. Idempotent: a second call joins the first. */
  register(PROVISION_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const status = startProvision({ home: deps.home, log: deps.log, force: body.force === true })
    return json(200, { ok: true, provision: status, binaries: (await snapshot(deps)).binaries })
  })

  /** The facts a reader needs, as JSON - what the video tab's panel shows. */
  register(REPORT_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const target = await resolveTarget(deps.ctx, { session: url.searchParams.get('session') ?? '', path: url.searchParams.get('path') ?? '', label: 'media file' })
    const ffprobe = await ensureBinary('ffprobe', { home: deps.home, env: deps.env, log: deps.log, install: url.searchParams.get('install') !== '0' })
    if (!ffprobe.ok) {
      return json(200, {
        ok: true,
        unavailable: true,
        reason: ffprobe.code,
        message: ffprobe.message,
        file: target.file,
        name: path.basename(target.file),
        size: target.size,
        sizeText: formatBytes(target.size),
      })
    }
    const answer = await probeJson({ file: ffprobe.file, path: target.file })
    if (!answer.ok && answer.json === null) {
      return json(200, { ok: true, unreadable: true, message: answer.error, file: target.file, name: path.basename(target.file), size: target.size, sizeText: formatBytes(target.size) })
    }
    const facts = summarize({ file: target.file, name: path.basename(target.file), size: target.size, json: answer.json, path: target.file })
    return json(200, { ok: true, file: target.file, name: path.basename(target.file), size: target.size, sizeText: facts.sizeText, facts, source: 'ffprobe' })
  })

  /**
   * The bytes. Either the file the caller named (re-validated here, exactly as
   * the tools validate it) or one of this plugin's own cached conversions, by
   * key - a caller never names a cache path, only the key it was handed.
   */
  register(FILE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const key = url.searchParams.get('cache')
    if (key !== null) {
      const file = cachePathFor(deps.home, key)
      if (file === null || !existsSync(file)) throw httpError(404, 'NO_SUCH_CACHE', 'No cached conversion with that key.')
      const stats = statSync(file)
      return streamFile(request, file, stats.size, 'video/mp4', { 'x-dsh-media-cache': '1' })
    }
    const target = await resolveTarget(deps.ctx, {
      session: url.searchParams.get('session') ?? '',
      path: url.searchParams.get('path') ?? '',
      extensions: VIDEO_EXTENSIONS,
      label: 'video',
    })
    const extension = target.file.slice(target.file.lastIndexOf('.') + 1).toLowerCase()
    const type = CONTENT_TYPES[extension] ?? 'application/octet-stream'
    return streamFile(request, target.file, target.size, type)
  })

  /** Start the conversion that makes one file playable. */
  register(REMUX_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const job = await startPlayableJob(deps, { session: body.session, path: body.path, mode: body.mode })
    return json(200, { ok: true, job })
  })

  /** One job's progress. */
  register(JOB_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const id = url.searchParams.get('id') ?? ''
    const job = jobs.get(id)
    if (!job) {
      // A job this process has forgotten may still have left its copy behind.
      const file = cachePathFor(deps.home, id)
      if (file !== null && existsSync(file)) {
        const stats = statSync(file)
        return json(200, { ok: true, job: { id, state: 'done', percent: 100, bytes: stats.size, cache: id, url: FILE_ROUTE + '?cache=' + id, message: 'cached', command: '', error: '', elapsedMs: 0 } })
      }
      throw httpError(404, 'NO_SUCH_JOB', 'No conversion with that id.')
    }
    return json(200, { ok: true, job: jobView(job) })
  })

  return () => {
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch (err) {
        /* an unregister that throws must not stop the others */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  const resolved = resolveBinaries({ home: deps.home, env: deps.env })
  deps.log.info(
    'active: ffmpeg ' +
      (resolved.ffmpeg.file ? resolved.ffmpeg.source + ' at ' + resolved.ffmpeg.file : 'NOT FOUND (' + resolved.install.state + ')') +
      ', ffprobe ' +
      (resolved.ffprobe.file ? resolved.ffprobe.source : 'NOT FOUND') +
      ', pinned copy ' +
      resolved.install.state,
  )
  const skillCount = registerSkills(ctx, deps.log)
  deps.log.info('registered ' + skillCount + ' bundled skill(s)')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-media: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes(deps), 'dsh-media: routes')
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  parseRange,
  convertArgs,
  cacheKeyFor,
  cachePathFor,
  jobView,
  startPlayableJob,
  summarize,
  snapshot,
  sessionOf,
  VIDEO_EXTENSIONS,
  cacheDir,
  jobs,
  installStatus,
  readStamp,
  platformKey,
  formatDuration,
}
