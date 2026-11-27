/**
 * dsh-rea - the engine.
 *
 * Everything a tool needs that is NOT a tool: where the REA binary is, how one
 * argv array is run, what a target is allowed to be, where an investigation is
 * stored and how a stored one is summarised. Kept free of `ctx` so the tracked
 * check can drive every rule on a machine that has no REA at all.
 *
 * THREE RULES THIS FILE ENFORCES.
 *
 * 1. ARGV, NEVER A SHELL. `spawn(command, args)` with an array: a target path
 *    with a space, a quote or a `;` is one argument, not syntax. The same rule
 *    the rest of the pack's host tools hold.
 * 2. A TARGET IS SCOPED. An investigation reads a program the user pointed at,
 *    so the path must be inside the session workspace or inside a root the
 *    caller named for that one call. A URL needs `allowUrl` because REA would
 *    then reach the network on the user's behalf - this package starts no
 *    egress of its own, and the opt-in is per call.
 * 3. OUTPUT IS BOUNDED. Captures are capped per stream and the stored JSON has
 *    a ceiling; a 200 MB asar dump is refused by name instead of filling the
 *    disk. `rea_read` is how a large investigation is walked, in slices.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** How much of one stream is kept for the answer / the stored report. */
export const MAX_STREAM_BYTES = 2 * 1024 * 1024
/** The ceiling on one stored report. Above this an inspect is refused by name. */
export const MAX_REPORT_BYTES = 32 * 1024 * 1024
/** One inspect's default deadline, and the ceiling a caller may ask for. */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
/** The commands REA's own help must name before `rea_inspect` will run one. */
const COMMAND_SHAPE = /^[a-z][a-z0-9-]{2,63}$/

/** The directory this row keeps its investigations under. */
export function storeRoot(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'dsh-rea')
}

/**
 * Resolve the REA program without running it: the caller's override first, then
 * `rea` on PATH. No `npx` fallback on purpose - `npx rea-agents` would download
 * on first use, and a tool that silently installs something is the one thing
 * this pack does not ship.
 * @returns `{ command, source }` or `{ command: '', source: 'missing' }`.
 */
export function resolveRea(env = process.env, platform = process.platform) {
  const override = env.DSH_REA_CLI
  if (override && override !== '') {
    return existsSync(override) ? { command: override, source: 'DSH_REA_CLI' } : { command: '', source: 'missing-override' }
  }
  const names = platform === 'win32' ? ['rea.cmd', 'rea.exe', 'rea'] : ['rea']
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== '')
  const exts = platform === 'win32' ? String(env.PATHEXT ?? '.CMD;.EXE;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return { command: candidate, source: 'PATH' }
        } catch {
          // an unreadable PATH entry is not a candidate
        }
      }
      if (platform === 'win32' && name !== 'rea') continue
      for (const ext of exts) {
        if (ext === '') continue
        const withExt = path.join(dir, 'rea' + ext)
        if (existsSync(withExt)) {
          try {
            if (statSync(withExt).isFile()) return { command: withExt, source: 'PATH' }
          } catch {
            // as above
          }
        }
      }
    }
  }
  return { command: '', source: 'missing' }
}

/**
 * Whether one REA command name is well formed. A name is data, but it is still
 * matched to a shape so a caller cannot smuggle a flag into the command slot.
 */
export function isCommandName(name) {
  return typeof name === 'string' && COMMAND_SHAPE.test(name)
}

/** Build the argv for one inspect. Pure: the check drives this directly. */
export function buildInspectArgs({ command, target, json = true, provider, out } = {}) {
  if (!isCommandName(command)) throw new Error('not a REA command name: ' + JSON.stringify(command))
  if (typeof target !== 'string' || target.trim() === '') throw new Error('no target given')
  const args = [command, target]
  if (json) args.push('--json')
  if (provider !== undefined && provider !== '') {
    if (!/^[a-z][a-z0-9-]{2,31}$/.test(provider)) throw new Error('not a provider name: ' + JSON.stringify(provider))
    args.push('--provider', provider)
  }
  if (out !== undefined && out !== '') args.push('--out', out)
  return args
}

/** The argv for one help / version call. */
export function buildProbeArgs(kind) {
  if (kind === 'help') return ['--help']
  if (kind === 'version') return ['--version']
  throw new Error('unknown probe: ' + String(kind))
}

/** True when the string is an http(s) URL. */
export function isUrl(target) {
  return /^https?:\/\//i.test(String(target))
}

/**
 * The scope guard. A local target must resolve INSIDE the workspace or inside an
 * explicitly allowed root; a URL needs `allowUrl`. Symlinks are resolved first,
 * so a link inside the workspace cannot point the analysis somewhere else.
 * @returns the resolved absolute path (or the URL, unchanged).
 */
export function assertTargetAllowed({ target, workspace, allowRoot, allowUrl = false, platform = process.platform, realpath = true }) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('no target given')
  if (isUrl(target)) {
    if (!allowUrl) {
      throw new Error(
        'refused: ' + target + ' is a URL, and this row starts no network egress on its own. Pass allowUrl:true for this call if the user asked for that page.',
      )
    }
    return target
  }
  if (!workspace) throw new Error('refused: no session workspace is known, so no local target can be scoped')
  const fold = (value) => (platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value))
  const resolveOne = (value) => {
    const absolute = path.resolve(value)
    if (!realpath) return absolute
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
  const inside = (candidate, root) => {
    const a = fold(resolveOne(candidate))
    const b = fold(resolveOne(root))
    return a === b || a.startsWith(b + path.sep)
  }
  if (inside(target, workspace)) return resolveOne(target)
  if (allowRoot && allowRoot !== '' && inside(target, allowRoot)) return resolveOne(target)
  throw new Error(
    'refused: ' +
      path.resolve(target) +
      ' is outside the session workspace (' +
      path.resolve(workspace) +
      '). Move the target into the workspace, or pass allowRoot with the folder the user authorised for this call.',
  )
}

/** Run one argv array. Never a shell; never a command string. */
export function runRea(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env = process.env, maxBytes = MAX_STREAM_BYTES } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let cutOut = false
    let cutErr = false
    let timedOut = false
    const collect = (chunk, into, flag) => {
      if (into === 'out') {
        if (stdout.length >= maxBytes) {
          cutOut = true
          return
        }
        const room = maxBytes - stdout.length
        stdout = Buffer.concat([stdout, chunk.subarray(0, room)])
        if (chunk.length > room) cutOut = true
      } else {
        if (stderr.length >= maxBytes) {
          cutErr = true
          return
        }
        const room = maxBytes - stderr.length
        stderr = Buffer.concat([stderr, chunk.subarray(0, room)])
        if (chunk.length > room) cutErr = true
      }
      void flag
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'out'))
    child.stderr.on('data', (chunk) => collect(chunk, 'err'))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, Math.min(Math.max(1_000, timeoutMs), MAX_TIMEOUT_MS))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String(error && error.message ? error.message : error), timedOut: false, cutOut: false, cutErr: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        cutOut,
        cutErr,
      })
    })
  })
}

/** Parse a `--json` answer defensively: REA may print a banner before the JSON. */
export function parseReaJson(text) {
  const value = String(text ?? '').trim()
  if (value === '') return { ok: false, error: 'empty output' }
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    // fall through: find the first object/array and parse from there
  }
  const object = value.indexOf('{')
  const array = value.indexOf('[')
  const start = object < 0 ? array : array < 0 ? object : Math.min(object, array)
  if (start < 0) return { ok: false, error: 'no JSON in the output' }
  const end = Math.max(value.lastIndexOf('}'), value.lastIndexOf(']'))
  if (end <= start) return { ok: false, error: 'no complete JSON value in the output' }
  try {
    return { ok: true, value: JSON.parse(value.slice(start, end + 1)) }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** A filesystem-safe slug, short enough to keep an id readable. */
export function slugOf(target) {
  const base = String(target).replace(/^https?:\/\//i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (base === '' ? 'target' : base).slice(0, 40).toLowerCase()
}

/** A sortable, unique-enough investigation id. */
export function newInvestigationId(target, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const digest = Buffer.from(String(target)).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6)
  return stamp + '-' + slugOf(target) + '-' + digest
}

/** `investigations/<id>/` under the store root. */
export function investigationDir(id, env = process.env) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error('not an investigation id: ' + JSON.stringify(id))
  return path.join(storeRoot(env), 'investigations', id)
}

/** Every stored investigation, newest first. */
export function listInvestigations(env = process.env) {
  const dir = path.join(storeRoot(env), 'investigations')
  if (!existsSync(dir)) return []
  const rows = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metaPath = path.join(dir, entry.name, 'meta.json')
    try {
      rows.push({ id: entry.name, ...JSON.parse(readFileSync(metaPath, 'utf8')) })
    } catch {
      rows.push({ id: entry.name, target: '', kind: 'unknown', created: '' })
    }
  }
  return rows.sort((a, b) => String(b.created).localeCompare(String(a.created)))
}

/**
 * Store one investigation: the meta a person reads and the report as REA
 * returned it. A report over MAX_REPORT_BYTES is refused rather than written.
 */
export function storeInvestigation({ id, target, command, provider, payload, text, code, env = process.env, now = new Date() }) {
  const raw = payload === undefined ? String(text ?? '') : JSON.stringify(payload, null, 2)
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_REPORT_BYTES) {
    throw new Error('refused: the report is ' + Math.round(bytes / 1024 / 1024) + ' MB, over the ' + MAX_REPORT_BYTES / 1024 / 1024 + ' MB ceiling; narrow the target and inspect again')
  }
  const dir = investigationDir(id, env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'report.json'), raw, 'utf8')
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, target, command, provider: provider ?? null, created: now.toISOString(), bytes, exitCode: code ?? null }, null, 2),
    'utf8',
  )
  return { id, dir, bytes }
}

/** Read one stored investigation. */
export function readInvestigation(id, env = process.env) {
  const dir = investigationDir(id, env)
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  const raw = readFileSync(path.join(dir, 'report.json'), 'utf8')
  return { meta, raw }
}

/**
 * The summary a model reads first: counts and the top-level keys REA returned,
 * never the whole document. A shape this row does not recognise is reported as
 * keys rather than guessed at.
 */
export function summarize(payload, { maxKeys = 24 } = {}) {
  if (payload === null || payload === undefined) return ['(no JSON payload)']
  if (Array.isArray(payload)) return ['array of ' + payload.length + ' item(s)']
  if (typeof payload !== 'object') return ['scalar: ' + JSON.stringify(payload)]
  const lines = []
  const keys = Object.keys(payload)
  for (const key of keys.slice(0, maxKeys)) {
    const value = payload[key]
    if (Array.isArray(value)) lines.push('  ' + key + ': ' + value.length + ' item(s)')
    else if (value !== null && typeof value === 'object') lines.push('  ' + key + ': {' + Object.keys(value).slice(0, 8).join(', ') + '}')
    else lines.push('  ' + key + ': ' + JSON.stringify(value))
  }
  if (keys.length > maxKeys) lines.push('  ... ' + (keys.length - maxKeys) + ' more top-level key(s)')
  return lines
}

/** A bounded slice of a stored report, by 1-based line range. */
export function sliceReport(raw, { offset = 1, limit = 120 } = {}) {
  const lines = String(raw).split('\n')
  const start = Math.max(1, Math.min(lines.length || 1, Math.floor(offset)))
  const count = Math.max(1, Math.min(2_000, Math.floor(limit)))
  const slice = lines.slice(start - 1, start - 1 + count)
  return {
    text: slice.join('\n'),
    start,
    end: start + slice.length - 1,
    total: lines.length,
  }
}
