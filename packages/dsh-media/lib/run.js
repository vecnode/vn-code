/**
 * dsh-media — running one media binary, carefully.
 *
 * Everything this plugin executes goes through THIS module, and the rules are
 * the same for every caller:
 *
 *   - **argv only, never a shell.** `spawn(file, args)` with no `shell: true`,
 *     so an argument is an argument: a path with a space, a filter graph with
 *     quotes, a `%` in a filename and a literal `&` all arrive at ffmpeg as
 *     themselves. Nothing is parsed, nothing is interpolated, and there is no
 *     string a caller could write that becomes a second command.
 *   - **a deadline, always.** A media file is untrusted input and ffmpeg on a
 *     damaged file can decode for a very long time; a call that runs past its
 *     timeout is killed and reported as killed, never left running.
 *   - **bounded output.** ffmpeg is chatty (a full `-loglevel debug` run of a
 *     two-hour video is hundreds of megabytes). The capture keeps a head and a
 *     tail and says how much it dropped, so a tool answer stays an answer.
 *   - **an abortable call.** The agent's own signal (a cancelled turn) kills the
 *     child the same way a timeout does.
 *
 * The runner knows nothing about ffmpeg: it takes a binary, an argv array and
 * limits, and it reports the exit code, the combined log and the elapsed time.
 */
import { spawn } from 'node:child_process'

/** What one call may run for when the caller says nothing. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** The ceiling a caller may ask for. Ten minutes of decoding is already a lot. */
export const MAX_TIMEOUT_MS = 600_000
/** Characters of combined output kept when the caller says nothing. */
export const DEFAULT_MAX_OUTPUT = 200_000
/** The hard ceiling on kept output, whatever a caller asks for. */
export const MAX_OUTPUT = 1_000_000

const DROPPED_MARK = '\n… [output dropped: '

/**
 * Trim a captured stream to `cap` characters, keeping the head and the tail.
 *
 * The head is where ffmpeg names the input it read and the streams it found;
 * the tail is where it says what it wrote and how it failed. The middle of a
 * progress log is the part nobody reads, which is why it is the part dropped -
 * and the marker names the count so the answer stays honest about it.
 */
function trim(text, cap) {
  if (text.length <= cap) return { text, dropped: 0 }
  const head = Math.floor(cap / 2)
  const tail = cap - head
  const dropped = text.length - cap
  return { text: text.slice(0, head) + DROPPED_MARK + dropped + ' characters] …\n' + text.slice(text.length - tail), dropped }
}

/**
 * Run one binary to completion.
 *
 * @param options - `{ file, args, cwd, timeoutMs, maxOutputChars, env, signal,
 *   onOutput }`. `onOutput(text, source)` is called with every chunk as it
 *   arrives, which is how the remux job reads ffmpeg's own `-progress` lines
 *   while the command is still running; it never replaces the captured output,
 *   only observes it.
 * @returns `{ code, signal, timedOut, aborted, ms, stdout, stderr, output, dropped }`.
 */
export function runBinary(options) {
  const file = options.file
  const args = Array.isArray(options.args) ? options.args.map((value) => String(value)) : []
  const timeoutMs = clampTimeout(options.timeoutMs)
  const maxOutputChars = clampOutput(options.maxOutputChars)
  const started = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        // `windowsHide` matters on Windows: without it a console window flashes
        // for every call. `stdin: 'ignore'` is the other half of never waiting
        // for input - ffmpeg would otherwise sit on a prompt reading a tty.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env,
      })
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        ms: Date.now() - started,
        stdout: '',
        stderr: '',
        output: 'could not start ' + file + ': ' + (err && err.message ? err.message : String(err)),
        dropped: 0,
        spawnError: err && err.message ? String(err.message) : String(err),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let dropped = 0
    let settled = false
    let timedOut = false
    let aborted = false
    let timer = null

    const onAbort = () => {
      aborted = true
      kill()
    }

    const kill = () => {
      try {
        // SIGKILL, not SIGTERM: ffmpeg traps SIGTERM for a graceful shutdown of
        // an encode, and a plugin timeout must not wait for that to finish.
        child.kill('SIGKILL')
      } catch (err) {
        /* the child is already gone */
      }
    }

    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', onAbort)
      }
      const combined = stderr.length > 0 && stdout.length > 0 ? stderr + '\n' + stdout : stderr + stdout
      const kept = trim(combined, maxOutputChars)
      resolve({
        code: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        timedOut,
        aborted,
        ms: Date.now() - started,
        stdout: trim(stdout, maxOutputChars).text,
        stderr: trim(stderr, maxOutputChars).text,
        output: kept.text,
        dropped: dropped + kept.dropped,
        spawnError: spawnError ?? null,
      })
    }

    const capture = (which) => (chunk) => {
      const text = String(chunk)
      if (which === 'out') stdout += text
      else stderr += text
      if (typeof options.onOutput === 'function') {
        try {
          options.onOutput(text, which)
        } catch (err) {
          /* an observer must never break the run it is watching */
        }
      }
      // Keep the buffers from growing without bound on a very chatty run: the
      // trim above is what the caller sees, and this stops the capture from
      // holding a gigabyte to produce a 200k answer.
      if (stdout.length + stderr.length > maxOutputChars * 4) {
        const out = trim(stdout, maxOutputChars * 2)
        const err = trim(stderr, maxOutputChars * 2)
        dropped += out.dropped + err.dropped
        stdout = out.text
        stderr = err.text
      }
    }

    child.stdout.on('data', capture('out'))
    child.stderr.on('data', capture('err'))
    child.on('error', (err) => finish(null, null, err && err.message ? String(err.message) : String(err)))
    child.on('close', (code, signal) => finish(code, signal, null))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      // A pending timer must never hold the process open on its own.
      if (typeof timer.unref === 'function') timer.unref()
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else if (typeof options.signal.addEventListener === 'function') options.signal.addEventListener('abort', onAbort)
    }
  })
}

/** A caller's timeout, clamped to what this module allows. */
export function clampTimeout(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS
  if (number <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, number)
}

/** A caller's output cap, clamped to what this module allows. */
export function clampOutput(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_OUTPUT
  if (number <= 0) return DEFAULT_MAX_OUTPUT
  return Math.min(MAX_OUTPUT, number)
}

/**
 * Run a binary and give back only its combined output, for the small fact
 * lookups this plugin makes for itself (a `-version` banner, a list of
 * encoders). A failure is data, never a throw.
 *
 * @param options - the same shape `runBinary` takes, plus `successCodes`.
 * @returns `{ ok, code, output, ms }`.
 */
export async function runQuiet(options) {
  const successCodes = Array.isArray(options.successCodes) ? options.successCodes : [0]
  const result = await runBinary(options)
  return {
    ok: result.code !== null && successCodes.includes(result.code),
    code: result.code,
    output: result.output,
    ms: result.ms,
  }
}
