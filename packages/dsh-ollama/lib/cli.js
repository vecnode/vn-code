/**
 * dsh-ollama — one bounded child process, for `ollama --version` only.
 *
 * The CLI is read, never driven: pulling, deleting and generating all go
 * through the daemon's HTTP API, because that is where the numbers are. The one
 * question the API cannot answer is "which client version is installed", and
 * that is what this runner is for.
 *
 * `spawn` with an argv ARRAY and no shell: a version string is not a command.
 * The answer is bounded in time and in bytes, and a missing CLI is a normal
 * result (`status: null`) rather than an exception - the daemon may be a
 * container on the other end of a socket, with no `ollama` on this PATH.
 */

import { spawn } from 'node:child_process'

/**
 * Run one argv array and collect its output.
 *
 * @param argv - the program and its arguments, one element each.
 * @param options - `{ timeoutMs, maxBytes, env }`.
 * @returns `{ status, stdout, stderr, timedOut, error }`; `status` is null when
 *   the program could not start at all.
 */
export function runProcess(argv, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 1_000_000
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: options.env ?? process.env,
      })
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', timedOut: false, error: error && error.message ? String(error.message) : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch (error) {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ status: null, stdout, stderr, timedOut, error: error && error.message ? String(error.message) : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ status: code, stdout, stderr, timedOut })
    })
  })
}
