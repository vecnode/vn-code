/**
 * dsh-docker — the one process runner.
 *
 * Everything this plugin does to a machine goes through `runProcess`: one
 * program, an ARGV ARRAY, no shell string. That is not a style preference - the
 * docker CLI is root-equivalent (anything that can talk to the daemon can mount
 * the host), so a caller must never be able to append a second command. With an
 * argv array a quote, a `;` or a `$(...)` is a character in an argument.
 *
 * What it guarantees, because each one has a way of being wrong:
 *
 *   - **no shell** (`shell: false`), so nothing is interpolated;
 *   - **a deadline**, after which the WHOLE process tree is killed. `docker pull`
 *     and a hung daemon both keep children, and `child.kill()` alone leaves
 *     them behind: on Windows the tree is killed with `taskkill /T /F`, on POSIX
 *     the child is spawned detached (its own process group) and the GROUP is
 *     signalled;
 *   - **capped streams**. A container's log can be gigabytes; each stream is
 *     held to `maxBytes` and the answer says it was cut;
 *   - **a composed environment**, not the harness's. Only the variables a
 *     container engine actually reads are inherited - `PATH` and the Docker /
 *     Podman context variables - so one plugin's state cannot leak into the
 *     daemon client, and none of the harness's own `DSH_*` markers reach it.
 *
 * The runner is injected through the row's deps (`createDeps`), which is what
 * lets the package's own check drive every branch with scripted answers and no
 * docker on the machine at all.
 */

import { spawn } from 'node:child_process'

/** A read (list, inspect, logs) is killed after this long. */
export const READ_TIMEOUT_MS = 15_000
/** A lifecycle action (start, stop, restart, remove) gets longer. */
export const ACTION_TIMEOUT_MS = 60_000
/** A pull is a network operation and may legitimately take minutes. */
export const PULL_TIMEOUT_MS = 15 * 60_000
/** Starting a Docker Desktop / podman machine waits for the engine at most this long. */
export const START_TIMEOUT_MS = 120_000
/** Most bytes kept from either stream. */
export const MAX_STREAM_BYTES = 1024 * 1024
/** Refuse an argv longer than this: nothing this plugin builds needs more. */
export const MAX_ARGV = 64

/** The two CLIs this row speaks, in the order it prefers them. */
export const ENGINE_CANDIDATES = ['docker', 'podman']

/**
 * The environment a container CLI may inherit.
 *
 * `DOCKER_HOST`, `DOCKER_CONTEXT` and their Podman twins are deliberately
 * inherited: the CLI's own configuration is how a person points it at a remote
 * engine or a rootless socket, and re-implementing that here would be a second,
 * wrong answer. Everything else is this plugin's own choice.
 */
const ENV_KEEP = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'PROGRAMW6432',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINER_SSHKEY',
  'PODMAN_CONNECTIONS_CONF',
]

/** One error's message, whatever was thrown. */
export function messageOf(error) {
  if (error === null || error === undefined) return 'the command failed'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * The environment one CLI call gets.
 *
 * The keys are matched case-insensitively and kept with THIS process's spelling:
 * Windows spells `PATH` as `Path`, and a map that renames it hands the child an
 * environment where nothing is on the path.
 */
export function childEnv(source) {
  const from = source === undefined || source === null ? {} : source
  const keep = new Set(ENV_KEEP.map((name) => name.toUpperCase()))
  const env = {}
  for (const [key, value] of Object.entries(from)) {
    if (!keep.has(key.toUpperCase())) continue
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  // The hints docker prints on first use are noise in an answer, and colour is
  // never wanted in a parsed stream.
  env.DOCKER_CLI_HINTS = 'false'
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return env
}

/** Kill one child AND everything it spawned. */
export function killTree(child) {
  if (child === null || child === undefined || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    // `child.kill()` leaves a `docker` wrapper's children running: taskkill /T is
    // the only call that reaches the tree.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      /* the process may already be gone */
    }
    return
  }
  try {
    // `detached: true` made this pid a process-group leader, so the negative pid
    // reaches every child it started.
    process.kill(-child.pid, 'SIGKILL')
  } catch (err) {
    try {
      child.kill('SIGKILL')
    } catch (inner) {
      /* already gone */
    }
  }
}

/**
 * Run one program with an argv array.
 *
 * @param file - the program (a name resolved through PATH, or an absolute path).
 * @param argv - the arguments, one array element each.
 * @param options - `{ env, cwd, timeoutMs, maxBytes }`.
 * @returns `{ file, argv, code, signal, stdout, stderr, timedOut, truncated, error, elapsedMs }`.
 *   `error` is set only when the process could not be started at all (ENOENT,
 *   EACCES); a non-zero exit is `code`, not `error`.
 */
export function runProcess(file, argv, options = {}) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : []
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : READ_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_STREAM_BYTES
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child = null
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: childEnv(options.env),
        windowsHide: true,
        shell: false,
        // POSIX: a process group is what makes a timeout kill the tree.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({
        file: file,
        argv: args,
        code: null,
        signal: '',
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        error: messageOf(err),
        elapsedMs: Date.now() - startedAt,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let graceTimer = null

    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      const current = target === 'out' ? stdout : stderr
      if (current.length >= maxBytes) {
        truncated = true
        return
      }
      const room = maxBytes - current.length
      const kept = text.length > room ? text.slice(0, room) : text
      if (kept.length < text.length) truncated = true
      if (target === 'out') stdout += kept
      else stderr += kept
    }

    const finish = (code, signal, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      resolve({
        file: file,
        argv: args,
        code: code === undefined ? null : code,
        signal: typeof signal === 'string' ? signal : '',
        stdout: stdout,
        stderr: stderr,
        timedOut: timedOut,
        truncated: truncated,
        error: typeof error === 'string' ? error : '',
        elapsedMs: Date.now() - startedAt,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // A killed tree still has to report; a wedged process must not wedge the
      // caller, so the answer is settled anyway after a short grace period.
      graceTimer = setTimeout(() => finish(null, 'SIGKILL'), 3000)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => append('out', chunk))
    child.stderr?.on('data', (chunk) => append('err', chunk))
    child.on('error', (err) => finish(null, '', messageOf(err)))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** Parse `--format '{{json .}}'` output: one JSON object per line. */
export function parseJsonLines(text) {
  const rows = []
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') rows.push(value)
    } catch (err) {
      // A daemon that printed a warning on stdout before the JSON must not throw
      // away every row after it; the bad line is simply not a row.
    }
  }
  return rows
}

/** Parse one JSON document, or null when the text is not JSON at all. */
export function parseJson(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    // A docker client can print its JSON after a line of advice; find the object.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch (inner) {
      return null
    }
  }
}

/** The first non-empty line of a stream, trimmed and clipped. */
export function firstLine(text, limit = 300) {
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > limit ? trimmed.slice(0, limit) + '\u2026' : trimmed
  }
  return ''
}

/** Cut a text to `limit` characters, saying when it was cut. */
export function clipText(text, limit = 24_000) {
  const value = String(text === undefined || text === null ? '' : text)
  if (value.length <= limit) return value
  return value.slice(0, limit) + '\n\u2026 [' + (value.length - limit) + ' more characters; the answer is cut]'
}
