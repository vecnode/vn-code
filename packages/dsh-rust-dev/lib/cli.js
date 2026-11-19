/**
 * dsh-rust-dev — one bounded child process, argv only.
 *
 * Every process this row starts goes through here, for four reasons that are
 * rules rather than preferences:
 *
 *   1. **argv, never a shell.** A crate name, a path or a `--` argument that
 *      arrived from a model must not be re-parsed by cmd.exe or sh.
 *   2. **A deadline.** `cargo` compiles dependencies, and a compile can take
 *      minutes or hang on a build script. A call with no deadline is a call that
 *      owns the harness' event loop.
 *   3. **A byte ceiling.** A failing workspace build is megabytes of compiler
 *      output; the cap is what keeps one bad call from filling the context.
 *   4. **A tree kill.** `cargo build` spawns rustc children. Killing the parent
 *      alone leaves them writing into `target/`, so on a timeout the whole tree
 *      goes - `taskkill /T` on Windows, a process-group kill elsewhere.
 *
 * Truncation is REPORTED, never silent: an answer that quietly dropped half the
 * diagnostics would be worse than a timeout.
 */

import { spawn } from 'node:child_process'

/** Kill a child and everything it started. */
export function killTree(child) {
  if (child === null || child === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    } catch (error) {
      /* fall through to kill() */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch (error) {
    /* already gone */
  }
}

/**
 * Run one argv array and collect its output.
 *
 * @param argv - the program and its arguments, one element each; never a string.
 * @param options - `{ cwd, timeoutMs, maxBytes, env }`.
 * @returns `{ status, stdout, stderr, timedOut, truncated, error, elapsedMs }`;
 *   `status` is null when the program could not start at all.
 */
export function runArgv(argv, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 2_000_000
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let truncated = false
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ timedOut, truncated, elapsedMs: Date.now() - startedAt, ...result })
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: options.env ?? process.env,
      })
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', error: error && error.message ? String(error.message) : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const take = (current, chunk) => {
      if (current.length >= maxBytes) {
        truncated = true
        return current
      }
      const room = maxBytes - current.length
      if (chunk.length > room) {
        truncated = true
        return current + chunk.slice(0, room)
      }
      return current + chunk
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = take(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = take(stderr, chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ status: null, stdout, stderr, error: error && error.message ? String(error.message) : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ status: code, stdout, stderr })
    })
  })
}

/**
 * The first line of a program's `--version`, which is all a version probe needs.
 *
 * @param argv - the program and its version flag.
 * @returns the line, or `''` when the program is missing or printed nothing.
 */
export async function versionLine(argv, options = {}) {
  const result = await runArgv(argv, { timeoutMs: 15_000, maxBytes: 64_000, ...options })
  if (result.status === null) return ''
  const text = String(result.stdout || result.stderr || '').trim()
  return text.split('\n')[0].trim()
}
