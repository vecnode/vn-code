/**
 * dsh-wsl - the WSL engine.
 *
 * Everything here is about ONE program: `wsl.exe`, the Windows Subsystem for
 * Linux launcher. This package does not ship a Linux, does not start one for you
 * and never writes inside a distribution - it asks the launcher what exists and
 * then runs an argv array in it.
 *
 * WHY THIS IS NOT A SHELL. `wsl.exe ... -- <argv>` is handed an argv ARRAY and
 * no shell, exactly like every other spawn in this pack: the words the agent
 * wrote are arguments, never a command line, so a `;` or a `$()` in them is a
 * character in an argument. `wsl_run` refuses a single-string command by name
 * for that reason.
 *
 * WHY THE OUTPUT IS DECODED HERE. `wsl.exe` writes UTF-16LE when its stdout is a
 * pipe - a byte order a terminal hides and Node reads as "N\0A\0M\0E\0" - so the
 * listing is captured as a Buffer and decoded by {@link decodeWslOutput}. Getting
 * this wrong is not cosmetic: the parser would see one giant token per distro.
 *
 * WHY `--cd` AND NOT A `cd &&`. `wsl.exe --cd <dir>` changes the working
 * directory of the process it starts. The alternative - `sh -c "cd X && ..."` -
 * is a shell, which is exactly what this package refuses to become.
 */

import { spawn } from 'node:child_process'

/** The launcher. Windows resolves it through PATH (System32). */
export const WSL_EXE = 'wsl.exe'

/** The default deadline for one command, and the ceiling a caller may ask for. */
export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_TIMEOUT_MS = 600000

/** How much of one stream is kept. Past this the answer says it was cut. */
export const MAX_OUTPUT_BYTES = 1000000

/** How many argv elements, and how long each may be. */
export const MAX_ARGV = 200
export const MAX_ARG_LENGTH = 8192

/** A refusal shape every tool returns instead of throwing. */
export function refusal(text) {
  return { text: String(text), view: { ok: false } }
}

/**
 * Decode what `wsl.exe` wrote.
 *
 * The launcher answers in UTF-16LE on a pipe regardless of the console code page;
 * a BOM or a NUL in the high byte settles it. A payload with no NUL at all is
 * plain UTF-8 (some builds answer a command's own output, not the launcher's).
 * @param buffer - the raw stdout/stderr bytes.
 */
export function decodeWslOutput(buffer) {
  if (!buffer || buffer.length === 0) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
  // A UTF-16LE ASCII payload has a NUL in every odd byte.
  let nulsAtOdd = 0
  const probe = Math.min(bytes.length, 4096)
  for (let index = 1; index < probe; index += 2) if (bytes[index] === 0) nulsAtOdd += 1
  const pairs = Math.floor(probe / 2)
  if (bom || (pairs > 0 && nulsAtOdd / pairs > 0.5)) {
    return (bom ? bytes.subarray(2) : bytes).toString('utf16le')
  }
  return bytes.toString('utf8')
}

/**
 * Parse the table `wsl.exe -l -v` prints.
 *
 * The HEADER IS LOCALIZED, so it is not looked for by name: a distribution row is
 * the one that ends in a version digit and has its columns separated by two or
 * more spaces. The asterisk is the default marker. That is why the header can be
 * in Spanish, Chinese or anything else and the parse still works - and why a line
 * that does not match is simply skipped instead of ending the list.
 * @param text - decoded launcher output.
 * @returns `{ distros: [{ name, state, version, default }], default }`.
 */
export function parseDistroList(text) {
  const distros = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    const match = /^(\*)?\s*(\S.*?)\s{2,}(\S+)\s+(\d+)$/.exec(line)
    if (match === null) continue
    const name = match[2].trim()
    if (name === '' || /^name$/i.test(name)) continue
    distros.push({
      name: name,
      state: match[3],
      version: Number(match[4]),
      default: match[1] === '*',
    })
  }
  const chosen = distros.find((entry) => entry.default)
  return { distros: distros, default: chosen === undefined ? '' : chosen.name }
}

/** Parse `wsl.exe -l -q`: one name per line, UTF-16 too. */
export function parseDistroNames(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, '').trim())
    .filter((line) => line !== '')
}

/**
 * Convert a Windows path to the path the distribution sees.
 *
 * The two shapes that matter: a drive letter (`C:\Users\x` -> `/mnt/c/Users/x`)
 * and the two UNC spellings a distribution exposes (`\\wsl$\Ubuntu\home\x` and
 * `\\wsl.localhost\Ubuntu\home\x` -> `/home/x`). A path that is already POSIX is
 * returned unchanged, so a caller can be sloppy about which side it is on.
 * @param input - a Windows or POSIX path.
 * @returns the POSIX form.
 */
export function windowsToWslPath(input) {
  const value = String(input)
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(value)
  if (drive !== null) {
    const rest = drive[2].split(/[\\/]+/).filter((segment) => segment !== '')
    return '/mnt/' + drive[1].toLowerCase() + (rest.length === 0 ? '' : '/' + rest.join('/'))
  }
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\/]+\\(.*)$/i.exec(value)
  if (unc !== null) {
    const rest = unc[1].split(/[\\/]+/).filter((segment) => segment !== '')
    return '/' + rest.join('/')
  }
  if (value.startsWith('/')) return value
  return value.split(/[\\/]+/).join('/')
}

/**
 * Convert a distribution path back to a Windows one.
 * @param input - a POSIX path, usually `/mnt/<drive>/...` or `/home/...`.
 * @param distro - required for a path that is not under `/mnt/<drive>`.
 * @returns the Windows form, or null when a distribution path needs a name this
 *   call did not get.
 */
export function wslToWindowsPath(input, distro) {
  const value = String(input)
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value
  const mounted = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(value)
  if (mounted !== null) {
    const tail = (mounted[2] || '').split('/').filter((segment) => segment !== '')
    return mounted[1].toUpperCase() + ':\\' + tail.join('\\')
  }
  if (typeof distro !== 'string' || distro === '') return null
  const tail = value.split('/').filter((segment) => segment !== '')
  return '\\\\wsl$\\' + distro + '\\' + tail.join('\\')
}

/**
 * Validate the argv a caller asked to run.
 * @returns `{ argv }` or `{ error }` - never a partially accepted list.
 */
export function validateArgv(argv) {
  if (argv === null || argv === undefined) return { error: '`argv` is required: an ARRAY of strings, one per argument.' }
  if (typeof argv === 'string') {
    return {
      error:
        '`argv` must be an ARRAY of strings, not one command line: this tool passes arguments to the launcher and never a string to a shell. Write ["sh", "-n", "scripts/run-web.sh"] instead of "sh -n scripts/run-web.sh".',
    }
  }
  if (!Array.isArray(argv)) return { error: '`argv` must be an array of strings.' }
  if (argv.length === 0) return { error: '`argv` is empty: nothing to run.' }
  if (argv.length > MAX_ARGV) return { error: '`argv` has ' + argv.length + ' elements; the limit is ' + MAX_ARGV + '.' }
  const clean = []
  for (const item of argv) {
    if (typeof item !== 'string') return { error: 'Every `argv` element must be a string; got ' + typeof item + '.' }
    if (item.includes('\u0000')) return { error: 'An argv element contains a NUL byte.' }
    if (item.length > MAX_ARG_LENGTH) return { error: 'An argv element is longer than ' + MAX_ARG_LENGTH + ' characters.' }
    clean.push(item)
  }
  return { argv: clean }
}

/**
 * The launcher's own arguments for one run.
 *
 * Order matters to `wsl.exe`: the distribution first, then the options, then `--`
 * and the program. `--cd` is used rather than a `cd` inside a shell because the
 * point of this package is that no shell is involved.
 * @param options - `{ distro, cwd, argv }`; `cwd` is a POSIX path.
 */
export function buildWslArgs(options) {
  const args = []
  if (typeof options.distro === 'string' && options.distro !== '') args.push('-d', options.distro)
  if (typeof options.cwd === 'string' && options.cwd !== '') args.push('--cd', options.cwd)
  args.push('--')
  for (const item of options.argv) args.push(item)
  return args
}

/**
 * The environment a child gets.
 *
 * A COMPOSED environment, not an inherited one - but composed for `wsl.exe`
 * specifically, and that is a correction rather than a preference: the first
 * version of this list carried only PATH and SystemRoot, and the launcher then
 * answered "CreateProcessParseCommon: Failed to translate <cwd>" on every machine
 * where the service had to start, because it needs the profile variables to find
 * its own data. The allowlist below is what Windows needs to run a program; what
 * it deliberately does NOT carry is anything of the harness's (`DSH_HOME`,
 * credentials, API keys), and nothing of it reaches the Linux side anyway - the
 * distribution builds its own environment, and only `WSLENV`-listed names cross.
 */
export const CHILD_ENV_NAMES = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'PATH',
  'Path',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ComSpec',
]

export function childEnv(base) {
  const source = base || process.env
  const env = {}
  for (const name of CHILD_ENV_NAMES) {
    if (typeof source[name] === 'string') env[name] = source[name]
  }
  // The launcher's own variables are its business: a person who set WSLENV or
  // WSL_UTF8 wants it honoured.
  for (const name of Object.keys(source)) {
    if (/^WSL/i.test(name) && typeof source[name] === 'string') env[name] = source[name]
  }
  return env
}

/**
 * The launcher's own flags, which never take a `--`.
 *
 * THIS IS THE ONE TRAP IN THE WHOLE INTERFACE. `wsl.exe -l -v` lists the
 * distributions; `wsl.exe -- -l -v` asks the launcher to RUN a program named
 * `-l` inside the default distribution - which on a machine whose default is
 * `docker-desktop-data` fails with "CreateProcessParseCommon: Failed to
 * translate <cwd>" and tells a person their Ubuntu is not installed. Listing and
 * probing therefore go through {@link runLauncher}; a program goes through
 * {@link runInWsl}.
 */
export function launcherArgs(args) {
  return args.slice()
}

/** Run the launcher itself (`-l -v`, `--version`, `--status`). */
export async function runLauncher(args, options = {}) {
  return await spawnWsl(launcherArgs(args), options)
}

/**
 * Run one program inside a distribution.
 *
 * A buffer is captured (the launcher may answer UTF-16), the child is killed on
 * the deadline, and on Windows the whole tree is killed with it: `wsl.exe` is a
 * relay, and a relay that exits leaves the Linux side running unless the tree
 * goes - which is the difference between "the command timed out" and "the command
 * is still eating a core".
 *
 * @param options - `{ argv, distro, cwd, timeoutMs, env, platform }`.
 * @returns `{ code, stdout, stderr, durationMs, timedOut, error }` - `error` is a
 *   sentence for the reader, never a thrown exception.
 */
export async function runInWsl(options) {
  const checked = validateArgv(options.argv)
  if (checked.error !== undefined) return { error: checked.error }
  const args = buildWslArgs({ distro: options.distro, cwd: options.cwd, argv: checked.argv })
  return await spawnWsl(args, options)
}

/**
 * The one spawn. `args` is already the launcher's complete argument list.
 * @param args - launcher arguments, `--` and program included when there is one.
 * @param options - `{ timeoutMs, env, platform }`.
 */
async function spawnWsl(args, options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    return {
      error:
        'WSL is a Windows feature and this host is ' +
        platform +
        '. On macOS or Linux the shell you want is already here: use the harness\'s own `bash` / `pwsh` tool instead of a distribution.',
    }
  }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS))
  // The CHILD'S OWN working directory is a known-good place, not ours. `wsl.exe`
  // translates its current directory into the distribution before it starts
  // anything, so a path the launcher always knows removes one variable. A caller
  // who wants a directory says so through `cwd`, which becomes `--cd` on the
  // Linux side.
  const hostCwd = childEnv(options.env).SystemRoot || childEnv(options.env).windir || 'C:\\'
  const started = Date.now()
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve({ durationMs: Date.now() - started, ...value })
    }
    let child
    try {
      child = spawn(WSL_EXE, args, {
        windowsHide: true,
        cwd: hostCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(options.env),
      })
    } catch (err) {
      finish({ error: 'Could not start ' + WSL_EXE + ': ' + (err && err.message ? err.message : String(err)) })
      return
    }
    const out = []
    const errOut = []
    let outBytes = 0
    let errBytes = 0
    let cut = false
    child.stdout.on('data', (chunk) => {
      if (outBytes >= MAX_OUTPUT_BYTES) {
        cut = true
        return
      }
      out.push(chunk)
      outBytes += chunk.length
    })
    child.stderr.on('data', (chunk) => {
      if (errBytes >= MAX_OUTPUT_BYTES) {
        cut = true
        return
      }
      errOut.push(chunk)
      errBytes += chunk.length
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, platform)
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ error: 'Could not run ' + WSL_EXE + ': ' + (err && err.message ? err.message : String(err)) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({
        code: code === null ? -1 : code,
        stdout: decodeWslOutput(Buffer.concat(out)),
        stderr: decodeWslOutput(Buffer.concat(errOut)),
        timedOut: timedOut,
        cut: cut,
      })
    })
  })
}

/** Kill one child, and on Windows its whole tree. */
function killTree(child, platform) {
  try {
    child.kill('SIGKILL')
  } catch (err) {
    /* already gone */
  }
  if (platform !== 'win32' || typeof child.pid !== 'number') return
  try {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {})
  } catch (err) {
    /* the direct kill is all we get */
  }
}

/**
 * Ask the launcher what distributions this machine has.
 *
 * Two questions, because they fail differently: `-l -v` carries state, version
 * and the default marker; `-l -q` answers names even where the table cannot be
 * parsed (an older build, an odd locale). The table is preferred and `-q` is the
 * fallback.
 * @returns `{ ok, distros, default, version, error }`.
 */
export async function listDistros(options = {}) {
  let last = null
  // The FIRST launch after the service has been idle can fail while it boots,
  // with "CreateProcessParseCommon: Failed to translate ..." - measured on this
  // machine, on a cold `wsl.exe`, four times out of four until a call warmed it.
  // So a launcher-shaped startup failure is retried a few times, slowly, because
  // the alternative is telling a person their Ubuntu is not installed. Only the
  // READ-ONLY questions retry: `wsl_run` never does, or a command with a side
  // effect would run twice.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await listOnce(options)
    if (result.distros.length > 0) return result
    last = result
    if (!looksCold(result)) break
    await delay(1200)
  }
  return last
}

/** Whether a failure is the launcher's own cold start rather than an answer. */
function looksCold(result) {
  const said = String((result && result.raw) || '') + ' ' + String((result && result.error) || '')
  return /CreateProcessParseCommon|Failed to translate|WslService|wslservice|0x800701|WSL_E_/i.test(said)
}

/** Wait, without a dependency. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One listing attempt: the table first, the names-only fallback second. */
async function listOnce(options) {
  const table = await runLauncher(['-l', '-v'], { timeoutMs: 20000, env: options.env, platform: options.platform })
  if (table.error !== undefined) return { ok: false, error: table.error, distros: [], default: '' }
  const parsed = parseDistroList(table.stdout)
  if (parsed.distros.length > 0) return { ok: true, distros: parsed.distros, default: parsed.default, raw: table.stdout }
  const names = await runLauncher(['-l', '-q'], { timeoutMs: 20000, env: options.env, platform: options.platform })
  if (names.error !== undefined) return { ok: false, error: names.error, distros: [], default: '' }
  const list = parseDistroNames(names.stdout).map((name) => ({ name: name, state: 'unknown', version: 0, default: false }))
  if (list.length === 0) {
    const said = (table.stderr || table.stdout || '').trim()
    return {
      ok: false,
      distros: [],
      default: '',
      raw: said,
      error:
        'WSL is installed but reports no distribution' +
        (said === '' ? '.' : ': ' + said) +
        ' Install one with `wsl.exe --install -d Ubuntu` (that needs a terminal, not this tool), or run `wsl.exe --update` if the launcher itself is too old for `--cd`.',
    }
  }
  return { ok: true, distros: list, default: '', raw: names.stdout }
}

/** Whether the WSL launcher exists at all, without running anything meaningful. */
export async function hasLauncher(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runLauncher(['--version'], { timeoutMs: 15000, env: options.env, platform: platform })
    if (result.error !== undefined) {
      await delay(1200)
      continue
    }
    // `--version` on a modern launcher prints WSL version lines; an old one errors
    // with "Invalid command line option", which still proves the program exists.
    if (result.code === 0 || /wsl|WSL/i.test(result.stdout + result.stderr)) return true
    return false
  }
  return false
}
