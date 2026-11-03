/**
 * dsh-sql-server — the one process runner.
 *
 * Every call this row makes to a machine goes through `runProcess`: ONE program,
 * an ARGV ARRAY, no shell string. `sqlcmd` takes a password on the command line
 * and `docker` can mount the host, so a caller must never be able to append a
 * second command: with an argv array a quote, a `;` or a `$(...)` is a character
 * in an argument, not syntax.
 *
 * What it guarantees, because each has a way of being wrong:
 *
 *   - **no shell** (`shell: false`), so nothing is interpolated;
 *   - **a deadline**, after which the WHOLE process tree is killed. A `.sql`
 *     dump that is still running after an hour, and a daemon that never answers,
 *     both keep children: on Windows the tree is killed with `taskkill /T /F`, on
 *     POSIX the child is detached into its own process group and the GROUP is
 *     signalled;
 *   - **a bounded answer**. Each stream is held to `maxBytes` and the answer says
 *     it was cut, because a script's stderr can be a million identical lines;
 *   - **a composed environment**, not the harness's. Only what a database client
 *     or the container CLI reads is inherited, so no `DSH_*` marker and no other
 *     plugin's secrets reach the child;
 *   - **stdin as a stream**. A 1.2 GB `.sql` file is not held in memory: the
 *     caller hands an async iterable of chunks and the child writes it with
 *     backpressure, which is how `sql_script` avoids both a temp copy and a heap.
 */

import { spawn } from 'node:child_process'

/** A read (list, status, a small query) is killed after this long. */
export const READ_TIMEOUT_MS = 15_000
/** One query a caller asked for gets longer than a status probe. */
export const QUERY_TIMEOUT_MS = 120_000
/** A lifecycle action (start, stop, restart, remove) gets longer. */
export const ACTION_TIMEOUT_MS = 180_000
/** A `.sql` script's default deadline: an hour is a dump, not a typo. */
export const SCRIPT_TIMEOUT_MS = 60 * 60_000
/** The most a script may ask for. */
export const MAX_SCRIPT_TIMEOUT_MS = 6 * 60 * 60_000
/** Most bytes kept from either stream. */
export const MAX_STREAM_BYTES = 1024 * 1024
/** Chunk size when a caller's file is streamed into a child's stdin. */
export const STDIN_CHUNK_BYTES = 64 * 1024

/**
 * The environment a database client or a container CLI may inherit.
 *
 * `TDSDUMP`, `SQLCMDPASSWORD`-style variables and the Docker context variables
 * are inherited on purpose: a person's own configuration is how they point a
 * client at an instance, and re-implementing that here would be a second, wrong
 * answer. Everything else is this plugin's own choice.
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
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'ODBCINI',
  'ODBCSYSINI',
  'ODBCINSTINI',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
]

/** One error's message, whatever was thrown. */
export function messageOf(error) {
  if (error === null || error === undefined) return 'the command failed'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * The environment one child gets.
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
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return env
}

/** Kill one child AND everything it spawned. */
export function killTree(child) {
  if (child === null || child === undefined || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      /* the process may already be gone */
    }
    return
  }
  try {
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
 * @param options - `{ env, cwd, timeoutMs, maxBytes, stdin, onStdoutChunk, extraEnv }`.
 *   `extraEnv` is merged AFTER the composed environment and is how a password
 *   reaches `sqlcmd` through `SQLCMDPASSWORD` instead of through argv, where the
 *   process list would show it.
 *   `stdin` is a string/Buffer, or an async iterable of those (a file stream);
 *   an iterable is written with backpressure, so a multi-gigabyte script costs
 *   one chunk of memory.
 * @returns `{ file, argv, code, signal, stdout, stderr, timedOut, truncated, error, elapsedMs, stdinBytes, stdinError }`.
 *   `error` is set only when the process could not be started at all (ENOENT,
 *   EACCES); a non-zero exit is `code`, not `error`.
 */
export function runProcess(file, argv, options = {}) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : []
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : READ_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_STREAM_BYTES
  const wantsStdin = options.stdin !== undefined && options.stdin !== null

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child = null
    const env = childEnv(options.env)
    for (const [key, value] of Object.entries(options.extraEnv === undefined || options.extraEnv === null ? {} : options.extraEnv)) {
      if (typeof value === 'string') env[key] = value
    }
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: env,
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
        stdinBytes: 0,
        stdinError: '',
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let graceTimer = null
    let stdinBytes = 0
    let stdinError = ''
    let stdinDone = !wantsStdin

    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      if (target === 'out' && typeof options.onStdoutChunk === 'function') {
        try {
          options.onStdoutChunk(text)
        } catch (err) {
          /* a progress hook must never take the call down */
        }
      }
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
        stdinBytes: stdinBytes,
        stdinError: stdinError,
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

    // The write side: a string, a Buffer, or an async iterable (a file stream).
    if (wantsStdin && child.stdin) {
      const source = options.stdin
      const write = (chunk) =>
        new Promise((done, fail) => {
          if (child.stdin === null || child.stdin.destroyed) {
            done()
            return
          }
          const ok = child.stdin.write(chunk, (err) => (err ? fail(err) : done()))
          if (ok === false) child.stdin.once('drain', () => {})
        })
      const pump = async () => {
        try {
          if (typeof source === 'string' || Buffer.isBuffer(source)) {
            const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
            for (let offset = 0; offset < buffer.length; offset += STDIN_CHUNK_BYTES) {
              const slice = buffer.subarray(offset, Math.min(buffer.length, offset + STDIN_CHUNK_BYTES))
              await write(slice)
              stdinBytes += slice.length
            }
          } else if (typeof source[Symbol.asyncIterator] === 'function') {
            for await (const chunk of source) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
              if (buffer.length === 0) continue
              const written = await write(buffer)
              stdinBytes += buffer.length
              if (written === false) break
            }
          }
        } catch (err) {
          // EPIPE means the child stopped reading (a syntax error ends sqlcmd
          // early). It is the CHILD's story, reported through its stderr and its
          // exit code, not a failure of this call - so it is recorded, not thrown.
          stdinError = messageOf(err)
        } finally {
          stdinDone = true
          try {
            child.stdin?.end()
          } catch (err) {
            /* already closed */
          }
        }
      }
      pump()
    } else if (wantsStdin) {
      stdinDone = true
    }
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

/** True when a failed spawn means "no such program", as opposed to a real error. */
export function isMissingProgram(result) {
  const text = (result.error || '') + ' ' + (result.stderr || '')
  return /ENOENT|not found|is not recognized|command not found|No such file/i.test(text) && (result.code === null || result.code === 127 || result.code === 9009)
}
