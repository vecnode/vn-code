/**
 * dsh-huggingface — one bounded child process, and the CLI it runs.
 *
 * `spawn` with an argv ARRAY and no shell: a repo id is data, never a command.
 * Every call has a deadline and a byte cap, and a CLI that is not installed is a
 * normal result (`bin: null`) rather than an exception - the cache scan needs no
 * CLI at all, and saying "no hf on this PATH" is more useful than a stack trace.
 *
 * TWO MEASURED TRAPS, both handled here because they are silent:
 *
 *   1. `hf --version` writes the version to STDOUT and a "a new version is
 *      available (2.5.0), you are using 1.26.1" hint to STDERR. Parsing stderr
 *      first reports the version that is NOT installed. Standard output wins.
 *   2. `hf <cmd> --help` exits NON-ZERO (measured: -1 on this install). An exit
 *      code is therefore not a verdict; a call is judged by whether its stdout
 *      parses, and `--help` is never run by this row.
 */

import { spawn } from 'node:child_process'

/** The programs tried, in order, when `DSH_HF_CLI` is not set. */
export const CLI_CANDIDATES = ['hf', 'huggingface-cli']

/** The variable that pins a binary PATH does not cover. */
export const CLI_ENV = 'DSH_HF_CLI'

/**
 * Run one argv array and collect its output.
 *
 * @param argv - the program and its arguments, one element each.
 * @param options - `{ timeoutMs, maxBytes, env, cwd }`.
 * @returns `{ status, stdout, stderr, timedOut, error }`; `status` is null when
 *   the program could not start at all (ENOENT, EACCES).
 */
export function runProcess(argv, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000
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
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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

/**
 * Read a version out of the two streams, in the order that is correct.
 *
 * @param stdout - what the program wrote to stdout.
 * @param stderr - what it wrote to stderr.
 * @returns the version string, or ''.
 */
export function parseVersion(stdout, stderr) {
  const first = /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)/.exec(String(stdout ?? ''))
  if (first !== null) return first[1]
  // Only the lines that are not the "new version available" advertisement.
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    if (/available|To update|pip install|conda/i.test(line)) continue
    const match = /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)/.exec(line)
    if (match !== null) return match[1]
  }
  return ''
}

/**
 * Find the CLI, once per boot.
 *
 * The answer is cached on `deps.cache.cli` because it cannot change while the
 * process runs, and a status call should cost one process, not three.
 *
 * @param deps - `{ env, runner, cache }`.
 * @returns `{ bin, version, source, tried }`; `bin` is null when none started.
 */
export async function resolveCli(deps) {
  if (deps.cache?.cli !== undefined) return deps.cache.cli
  const pinned = typeof deps.env?.[CLI_ENV] === 'string' ? deps.env[CLI_ENV].trim() : ''
  const candidates = pinned === '' ? CLI_CANDIDATES : [pinned]
  const tried = []
  let answer = { bin: null, version: '', source: '', tried }
  for (const candidate of candidates) {
    const result = await deps.runner([candidate, '--version'], { timeoutMs: 8000, maxBytes: 64_000, env: deps.env })
    const started = result !== null && result !== undefined && result.status !== null
    tried.push({ bin: candidate, started })
    if (!started) continue
    answer = {
      bin: candidate,
      version: parseVersion(result.stdout, result.stderr),
      source: pinned === '' ? 'PATH' : CLI_ENV,
      tried,
    }
    break
  }
  if (deps.cache) deps.cache.cli = answer
  return answer
}
