#!/usr/bin/env node
//  scripts/checks/check-shell.mjs - the native shell, DRIVEN rather than read.
//
//  What this proves, and why each one is here rather than in a `cargo test`:
//
//   1. the ready-line refusals. A stub CLI prints a ready line naming a host that
//      is NOT loopback, and the shell must not open it and must say so. That rule
//      is unit-tested in Rust too, but the unit test cannot prove the WIRING: that
//      the URL the harness really printed is the one that reaches the policy.
//   2. the launch token never leaves memory. The same stub prints a ready line
//      carrying a recognisable token. The check then reads every byte the shell
//      wrote: stdout, stderr, every file under the home it was given, and the log
//      the panel draws. The token must appear in NONE of them. The shell has to
//      hold it (the pane and the browser hand-off need it), so "not written down"
//      is a claim that can only be tested by running it.
//   3. Stop really stops. The stub BINDS the port it is told to use and spawns a
//      grandchild of its own. After `stop` on stdin the check asserts the port is
//      refused again, the grandchild's pid is gone, and the shell SAID so - the
//      `free=yes` line is the shell's own measurement, not this check's.
//   4. the flags. `-Help` prints the set the launchers share, an unknown flag is
//      refused BY NAME, and a `-Mode` this build cannot honour is refused rather
//      than silently downgraded.
//   5. the move off Tauri is complete: `app/src-tauri` is gone, the shell's source
//      is a cargo workspace under `app/`, and the ship list carries it.
//   6. M0's claim: the home is one the app CREATED and proved, and the child's
//      environment is composed rather than inherited. An unwritable inherited
//      `DSH_HOME` falls through to `<app root>/home`; the same path as `-DshHome`
//      refuses by name; a writable inherited one is joined. The stub prints the
//      environment it was handed, so this is read back out of the CHILD.
//
//  Every run is confined to a scratch app root (`VNCODE_HOME`) and a scratch harness
//  home, so this check never writes into a person's own `~/.dsh` or `%LOCALAPPDATA%`.
//
//  Run:  node scripts/checks/check-shell.mjs
//        VNCODE_SHELL=/path/to/vncode  to test an already-built binary
//
//  A host with no Rust toolchain and no built binary SKIPS LOUDLY (exit 0). That
//  is not a pass: read the output.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const app = path.join(repo, 'app')
const scratch = path.join(repo, '.scratch', 'check-shell')
const failures = []
const notes = []

const fail = (message) => failures.push(message)
const skip = (message) => {
  console.log(`check-shell: SKIP - ${message}`)
  process.exit(0)
}

/** A token recognisable in a haystack, assembled so this file holds no literal. */
const TOKEN = ['check', 'shell', '1234567890abcdef'].join('-')
const EVIL_HOST = 'not-loopback.example'

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------
const exeName = process.platform === 'win32' ? 'vncode.exe' : 'vncode'

function builtBinary() {
  // DEBUG FIRST, because that is the profile this check builds (`cargo build`). A
  // release binary left over from an earlier build would otherwise be tested
  // instead - measured: this check reported an "unknown command" for a headless
  // command that existed, because it was driving a release build from before the
  // change.
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(app, 'target', profile, exeName)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function findBinary() {
  if (process.env.VNCODE_SHELL) {
    const given = process.env.VNCODE_SHELL
    if (!fs.existsSync(given)) skip(`VNCODE_SHELL names ${given}, which does not exist`)
    return given
  }
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: false })
  if (cargo.error || cargo.status !== 0) {
    const existing = builtBinary()
    if (existing) {
      notes.push('cargo is missing, so the binary on disk was tested AS IS - it may be stale')
      return existing
    }
    skip('no cargo on PATH and no built vncode binary - build it with `cargo build` in app/')
  }
  // Built EVERY run, not only when one is missing: cargo is a no-op while the
  // sources are current, and a check that tested a stale binary would report OK
  // about code nobody has.
  console.log('check-shell: building the shell (cargo build -p vn-shell)...')
  const build = spawnSync('cargo', ['build', '-p', 'vn-shell'], {
    cwd: app,
    encoding: 'utf8',
    shell: false,
  })
  if (build.status !== 0) {
    fail(`cargo build failed:\n${build.stdout ?? ''}${build.stderr ?? ''}`)
    report()
  }
  const built = builtBinary()
  if (!built) fail('cargo reported success but no vncode binary was produced')
  return built
}

// ---------------------------------------------------------------------------
// The stub CLI
// ---------------------------------------------------------------------------
const stubPath = path.join(scratch, 'stub-cli.mjs')

/**
 * A stand-in for `dsh web`: it takes the SAME argv the real CLI takes, binds the
 * port it was given, prints a ready line, and stays alive until it is killed.
 *
 * `VNCODE_STUB_MODE=evil` swaps the ready line for one naming a foreign host.
 *
 * It also prints the environment it was GIVEN. That is not decoration: M0's whole
 * claim is that the child's environment is composed rather than inherited, and the
 * only proof of a composed environment is the child reading it back.
 */
function writeStub() {
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(
    stubPath,
    `import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const at = argv.indexOf('--port')
const port = Number(argv[at + 1])
const mode = process.env.VNCODE_STUB_MODE ?? 'good'
const token = process.env.VNCODE_STUB_TOKEN
const evilHost = process.env.VNCODE_STUB_HOST ?? 'example.invalid'
const grandchildPidFile = process.env.VNCODE_STUB_PID_FILE

// What this child was GIVEN, which is what the shell says it composed.
process.stdout.write('[stub] DSH_HOME=' + (process.env.DSH_HOME ?? '(unset)') + '\\n')
process.stdout.write('[stub] VNCODE_HOME=' + (process.env.VNCODE_HOME ?? '(unset)') + '\\n')
process.stdout.write('[stub] npm_config_cache=' + (process.env.npm_config_cache ?? '(unset)') + '\\n')
process.stdout.write('[stub] VNCODE_CONSOLE=' + (process.env.VNCODE_CONSOLE ?? '(unset)') + '\\n')
process.stdout.write('[stub] TEMP=' + (process.env.TEMP ?? '(unset)') + '\\n')

// A grandchild of our own: the process TREE is what Stop must take down, and a
// supervisor that only killed its direct child would leave this one alive.
if (grandchildPidFile) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  })
  fs.writeFileSync(grandchildPidFile, String(child.pid))
}

// The ready line the real CLI prints, against a host the shell must refuse. The
// port is NOT bound in this mode: there is no instance to reach.
if (mode === 'evil') {
  process.stdout.write('dsh web: http://' + evilHost + ':' + port + '/?token=' + token + '\\n')
  setInterval(() => {}, 1000)
} else {
  // The port is really HELD, so "the port came free" is a measurement.
  const server = net.createServer(() => {})
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=' + token + '\\n')
  })
  setInterval(() => {}, 1000)
}
`,
  )
}

// ---------------------------------------------------------------------------
// Running the shell
// ---------------------------------------------------------------------------
const isFree = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
    socket.setTimeout(1500, () => {
      socket.destroy()
      resolve(true)
    })
  })

/**
 * Start `vncode -Mode headless` against the stub and collect everything it says.
 *
 * Every run is confined to a scratch APP ROOT (`VNCODE_HOME`) and a scratch harness
 * home, so a check can never write into the machine's own `~/.dsh` or into the
 * `%LOCALAPPDATA%\vncode` a person's real app uses. `env` overrides either, which is
 * how the confined-home cases are built.
 */
function startShell({ mode = 'good', label, env = {}, dshHome } = {}) {
  const home = dshHome === undefined ? path.join(scratch, `home-${label}`) : dshHome
  const appRoot = path.join(scratch, `app-${label}`)
  if (dshHome === undefined) {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(home, { recursive: true })
  }
  fs.rmSync(appRoot, { recursive: true, force: true })
  fs.mkdirSync(appRoot, { recursive: true })
  const pidFile = path.join(scratch, `grandchild-${label}.pid`)
  fs.rmSync(pidFile, { force: true })
  const args = ['-Mode', 'headless', '-DshVersion', '0.0.0-check']
  // The flag is only passed when a home was named: `-DshHome` is the STRICT rung of
  // the ladder, so an inherited-home case must not carry one.
  if (dshHome !== undefined && dshHome !== null) args.push('-DshHome', dshHome)
  const child = spawn(binary, args, {
    cwd: repo,
    env: {
      ...process.env,
      // The seam: the shell runs THIS instead of the pinned harness, through the
      // same argv and the same ready-line watch as the real thing.
      VNCODE_STUB_CLI: process.execPath,
      VNCODE_STUB_ARGS: JSON.stringify([stubPath]),
      VNCODE_STUB_MODE: mode,
      VNCODE_STUB_HOST: EVIL_HOST,
      VNCODE_STUB_TOKEN: TOKEN,
      VNCODE_STUB_PID_FILE: pidFile,
      // The app's own root and the home the run starts from, both in scratch. The
      // caller's overrides win, which is how a refused or a joined inherited home is
      // built.
      VNCODE_HOME: appRoot,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { child, home, appRoot, pidFile, out: '', err: '', exit: null }
  child.stdout.on('data', (chunk) => (state.out += chunk))
  child.stderr.on('data', (chunk) => (state.err += chunk))
  child.on('exit', (code) => (state.exit = code))
  return state
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(state, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  fail(`timed out after ${timeoutMs}ms waiting for ${what}\n--- stdout ---\n${state.out}\n--- stderr ---\n${state.err}`)
  return false
}

const runningPort = (state) => {
  const match = state.out.match(/running on http:\/\/127\.0\.0\.1:(\d+)\//)
  return match ? Number(match[1]) : null
}

/** Every file under a directory, for the "no secret on disk" scan. */
function filesUnder(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(full)
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------
async function checkRefusal() {
  const state = startShell({ mode: 'evil', label: 'evil' })
  await waitFor(state, () => /does not name a loopback address/.test(state.out + state.err), 15000, 'the refusal of a foreign ready line')
  // The shell must NOT have reached "running": it refused the URL, so there is
  // nothing to show.
  if (/running on http/.test(state.out)) {
    fail('the shell reported a running instance after refusing a non-loopback ready line')
  }
  if (state.out.includes(TOKEN) || state.err.includes(TOKEN)) {
    fail('the refusal path echoed the launch token')
  }
  state.child.stdin.end('quit\n')
  await waitFor(state, () => state.exit !== null, 15000, 'the refusal run to exit')
  console.log('check-shell: a ready line naming a foreign host is refused, and the token is not echoed')
}

async function checkLifetime() {
  const state = startShell({ mode: 'good', label: 'good' })
  if (!(await waitFor(state, () => runningPort(state) !== null, 20000, 'the ready line'))) return
  const port = runningPort(state)

  if (await isFree(port)) {
    // Sanity: if the stub never held the port, the "free again" assertion below
    // would pass for the wrong reason.
    fail(`the stub was expected to hold port ${port}, but nothing is listening on it`)
  }

  // 1. The token was never echoed, on either stream.
  if (state.out.includes(TOKEN)) fail('the launch token reached stdout')
  if (state.err.includes(TOKEN)) fail('the launch token reached stderr')
  // ...and the safe line is still useful: it names the address.
  if (!/http:\/\/127\.0\.0\.1:\d+\//.test(state.out)) {
    fail('the running line does not name the loopback address at all')
  }

  // 2. Stop, and the shell's OWN measurement of the port.
  state.child.stdin.write('stop\n')
  if (!(await waitFor(state, () => /\[vncode\] stopped port=\d+ free=yes/.test(state.out), 20000, 'the free=yes line'))) {
    return
  }
  if (!(await isFree(port))) {
    fail(`the shell said the port was free, but something still holds ${port}`)
  }

  // 3. The grandchild: a supervisor that killed only its direct child would leave
  //    a path holding the port.
  if (fs.existsSync(state.pidFile)) {
    const pid = Number(fs.readFileSync(state.pidFile, 'utf8').trim())
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) {
      fail(`the harness's grandchild (pid ${pid}) survived Stop`)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* it is already gone */
      }
    }
  } else {
    notes.push('the stub recorded no grandchild pid, so the tree kill was not observed')
  }

  await waitFor(state, () => state.exit !== null, 15000, 'the shell to exit after Stop')

  // 4. Nothing on disk carries the token: every file the run created, plus the
  //    log the panel would draw. BOTH roots are scanned, because M0 changed where
  //    files land: the home is the harness's, the app root is this app's.
  for (const directory of [state.home, state.appRoot]) {
    for (const file of filesUnder(directory)) {
      const text = fs.readFileSync(file, 'utf8')
      if (text.includes(TOKEN)) fail(`${path.relative(repo, file)} contains the launch token`)
    }
  }
  const created = filesUnder(state.home).length + filesUnder(state.appRoot).length
  console.log(
    `check-shell: start, ready line, stop - port freed, tree killed, ${created} file(s) created by the run, none carrying the token`,
  )
}

/**
 * M0: the child's environment is COMPOSED, and the home is one this app can write.
 *
 * Three cases, and each one is the behaviour the revision exists for:
 *
 *   1. an inherited `DSH_HOME` that cannot be written FALLS THROUGH to
 *      `<app root>/home` - the app comes up, where the old build refused with a
 *      sentence asking the person to start it differently;
 *   2. the same impossible path given as `-DshHome` still REFUSES, naming the flag -
 *      an explicit instruction is never silently ignored;
 *   3. a writable inherited `DSH_HOME` is JOINED, and the app's own `home/` is never
 *      created, so an app started from inside a harness session shares that session's
 *      home rather than making a second one.
 *
 * The stub prints the environment it was given, so every claim here is read back out
 * of the CHILD rather than out of the shell's own log line.
 */
async function checkConfinedHome() {
  // A directory that cannot exist: its parent is a FILE, which no platform allows.
  const blocker = path.join(scratch, 'confined-home-blocker')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(blocker, 'a file, not a directory')
  const impossible = path.join(blocker, 'home')

  // 1. inherited and unwritable: fall through to the app's own home. The MACHINE's
  //    temp is made unwritable in the same run, because that is the pair measured on a
  //    real machine: `%TEMP%` refused the child while the app's own root worked, and
  //    the harness's spill store died on `mkdtemp` because of it.
  const confined = startShell({
    label: 'confined',
    env: { DSH_HOME: impossible, TEMP: impossible, TMP: impossible, TMPDIR: impossible },
  })
  if (!(await waitFor(confined, () => runningPort(confined) !== null, 20000, 'a ready line with an unwritable inherited home'))) {
    return
  }
  const expected = path.join(fs.realpathSync(confined.appRoot), 'home')
  if (!confined.out.includes(`[stub] DSH_HOME=${expected}`)) {
    fail(`the child was not given <app root>/home\nexpected: ${expected}\n--- stdout ---\n${confined.out}`)
  }
  // ...and the temp it was given must be one it can write in, which the machine's was
  // not: the app's own `<app root>/tmp`.
  const expectedTemp = path.join(fs.realpathSync(confined.appRoot), 'tmp')
  if (!confined.out.toLowerCase().includes(`[stub] temp=${expectedTemp.toLowerCase()}`)) {
    fail(`the child was not given a writable temp\nexpected: ${expectedTemp}\n--- stdout ---\n${confined.out}`)
  }
  if (!confined.out.includes('for temp instead')) {
    fail(`moving the child's temp was not explained\n--- stdout ---\n${confined.out}`)
  }
  if (!confined.out.includes('was refused')) {
    fail(`the refused inherited home was not named\n--- stdout ---\n${confined.out}`)
  }
  if (!confined.out.includes('[stub] VNCODE_HOME=(unset)')) {
    fail('VNCODE_HOME reached the child: the harness knows DSH_HOME and nothing else')
  }
  if (!confined.out.includes('[stub] VNCODE_CONSOLE=(unset)')) {
    fail('a console marker reached the harness - the panel inherits them from the launcher')
  }
  confined.child.stdin.write('stop\n')
  await waitFor(confined, () => confined.exit !== null, 20000, 'the confined run to stop')

  // 2. the same path as -DshHome: a refusal, by name, before anything is spawned.
  const strict = startShell({ label: 'strict', dshHome: impossible })
  if (!(await waitFor(strict, () => strict.exit !== null, 20000, 'the refusal of an impossible -DshHome'))) {
    return
  }
  if (strict.exit !== 1) fail(`an impossible -DshHome exited ${strict.exit}, expected 1`)
  if (!/-DshHome names/.test(strict.err + strict.out)) {
    fail(`the refusal did not name the flag\n--- stderr ---\n${strict.err}`)
  }
  if (runningPort(strict) !== null) {
    fail('a harness was started despite an impossible -DshHome')
  }

  // 3. a writable inherited DSH_HOME is joined, and no second home is made.
  const shared = path.join(scratch, 'shared-home')
  fs.rmSync(shared, { recursive: true, force: true })
  fs.mkdirSync(shared, { recursive: true })
  const joined = startShell({ label: 'joined', dshHome: null, env: { DSH_HOME: shared } })
  if (!(await waitFor(joined, () => runningPort(joined) !== null, 20000, 'a ready line on a joined home'))) {
    return
  }
  if (!joined.out.includes(`[stub] DSH_HOME=${shared}`)) {
    fail(`a writable inherited home was not joined\n--- stdout ---\n${joined.out}`)
  }
  if (!joined.out.includes('from the inherited DSH_HOME')) {
    fail(`the panel does not say the home was inherited\n--- stdout ---\n${joined.out}`)
  }
  if (fs.existsSync(path.join(joined.appRoot, 'home'))) {
    fail('the app created its own home as well as joining the inherited one')
  }
  joined.child.stdin.write('stop\n')
  await waitFor(joined, () => joined.exit !== null, 20000, 'the joined run to stop')

  console.log(
    'check-shell: an unwritable inherited home falls through, an impossible -DshHome refuses by name, a writable one is joined',
  )
}

async function checkSetupButtons() {
  // The panel's Install and Uninstall buttons run `scripts/setup/install.*` with
  // `-NoTerminal -NoPause` and stream its output into the log. This drives the
  // SAME path through the shell's own headless commands, with `-Help` as the one
  // invocation that installs nothing - so the plumbing (locate, spawn through the
  // console layer, stream, read an exit code) is proved without changing a
  // profile.
  const state = startShell({ mode: 'good', label: 'setup' })
  if (!(await waitFor(state, () => runningPort(state) !== null, 20000, 'the ready line'))) return

  state.child.stdin.write('install -Help\n')
  if (!(await waitFor(state, () => /\[vncode\] install finished successfully/.test(state.out), 90000, 'the installer to answer -Help'))) {
    return
  }
  if (!/Usage: scripts\\setup\\install\.bat/.test(state.out)) {
    fail("the installer's own usage never reached the shell's log")
  }
  if (/(adding|removing) dsh-/.test(state.out)) {
    fail('install -Help changed the profile - the console layer dropped the flag')
  }
  // The uninstaller goes through the same runner, so one run of each is what
  // proves both buttons rather than one button and a copy of its code.
  state.child.stdin.write('uninstall -Help\n')
  if (!(await waitFor(state, () => /\[vncode\] uninstall finished successfully/.test(state.out), 90000, 'the uninstaller to answer -Help'))) {
    return
  }
  if (!/Usage: scripts\\setup\\uninstall\.bat/.test(state.out)) {
    fail("the uninstaller's own usage never reached the shell's log")
  }

  state.child.stdin.write('stop\n')
  await waitFor(state, () => state.exit !== null, 20000, 'the shell to exit')
  console.log('check-shell: install and uninstall run through the panel path, and -Help changes nothing')
}

function checkFlags() {
  const help = spawnSync(binary, ['-Help'], { encoding: 'utf8', shell: false })
  if (help.status !== 0) fail(`-Help exited ${help.status}`)
  for (const flag of ['-Port', '-DshHome', '-DshVersion', '-Mode', '-Help']) {
    if (!help.stdout.includes(flag)) fail(`-Help never mentions ${flag}`)
  }
  const unknown = spawnSync(binary, ['-NotAFlag'], { encoding: 'utf8', shell: false })
  if (unknown.status !== 1) fail(`an unknown flag exited ${unknown.status}, expected 1`)
  if (!/unknown flag/.test(unknown.stderr ?? '')) fail('an unknown flag was not named as such')
  if (!/-notaflag/i.test(unknown.stderr ?? '')) fail('an unknown flag was refused without naming it')

  const badMode = spawnSync(binary, ['-Mode', 'sideways'], { encoding: 'utf8', shell: false })
  if (badMode.status !== 1) fail(`-Mode sideways exited ${badMode.status}, expected 1`)
  if (!/panel, chrome or headless/.test(badMode.stderr ?? '')) {
    fail('-Mode sideways was refused without listing what it accepts')
  }
  // `embed` is a mode this app does NOT have - it draws no web view - and the flag
  // is refused BY NAME rather than quietly opening a browser instead. A test that
  // only checked the accepted spellings would let this build promise a pane.
  const noPane = spawnSync(binary, ['-Mode', 'embed'], { encoding: 'utf8', shell: false })
  if (noPane.status !== 1) fail(`-Mode embed exited ${noPane.status}, expected 1`)
  if (!/draws no web view/.test(noPane.stderr ?? '')) {
    fail('-Mode embed was refused without saying that this app has no web view')
  }
  if (!/chrome/.test(noPane.stderr ?? '')) {
    fail('-Mode embed was refused without naming the mode that does work')
  }
  console.log('check-shell: the flag set, both refusals, and no promised pane behave')
}

function checkTauriIsGone() {
  // The move is a claim about the SOURCE TREE, and a half-finished move is worse
  // than either end of it: two supervisors in one folder is how a "fix" lands in
  // the one nobody runs.
  if (fs.existsSync(path.join(app, 'src-tauri'))) {
    fail('app/src-tauri still exists - the Tauri launcher was not removed')
  }
  if (!fs.existsSync(path.join(app, 'Cargo.toml'))) {
    fail('app/Cargo.toml is missing - the shell is no longer a cargo workspace')
  }
  for (const crate of ['vn-shell-core', 'vn-shell-runtime', 'vn-shell-egui', 'vn-shell']) {
    if (!fs.existsSync(path.join(app, 'crates', crate, 'Cargo.toml'))) {
      fail(`app/crates/${crate} is missing`)
    }
  }
  if (fs.existsSync(path.join(app, 'ui'))) {
    fail('app/ui still exists - the HTML splash has no place in the egui shell')
  }
  // The old distribution machinery is gone, deliberately: the distribution is now
  // this app beside the pack the panel installs.
  for (const gone of ['dist.ps1', 'dist.sh', 'run-dist.bat', 'run-dist.ps1', 'dist-manifest.txt']) {
    if (fs.existsSync(path.join(repo, 'scripts', gone))) {
      fail(`scripts/${gone} is back - the old distribution machinery was erased on purpose`)
    }
  }
  for (const needed of ['setup/install.bat', 'setup/install.sh', 'console/adapt.cmd']) {
    if (!fs.existsSync(path.join(repo, 'scripts', needed))) {
      fail(`scripts/${needed} is missing - the panel's Install button runs it`)
    }
  }
  console.log('check-shell: the Tauri launcher is gone and the workspace is in its place')
}

function checkCargoTests() {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: false })
  if (cargo.error || cargo.status !== 0) {
    notes.push('cargo is missing, so the shell\'s own tests were not run')
    return
  }
  // VNCODE_TEST_DIR is how the tests get a scratch root on a host that denies the
  // system temp directory - which is exactly the host the pack's checks run on.
  // VNCODE_HOME and DSH_HOME are pointed into the same scratch tree for the same
  // reason M0 added them: a unit test must never create, join or probe a person's
  // own harness home.
  const test = spawnSync('cargo', ['test', '--workspace', '--quiet'], {
    cwd: app,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      VNCODE_TEST_DIR: path.join(scratch, 'cargo-test'),
      VNCODE_HOME: path.join(scratch, 'cargo-test', 'app-root'),
      DSH_HOME: path.join(scratch, 'cargo-test', 'dsh-home'),
    },
  })
  const output = `${test.stdout ?? ''}${test.stderr ?? ''}`
  if (test.status !== 0) {
    fail(`cargo test --workspace failed:\n${output.split('\n').slice(-40).join('\n')}`)
    return
  }
  const passed = [...output.matchAll(/test result: ok\. (\d+) passed/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  )
  if (passed === 0) fail('cargo test reported success but ran no tests')
  console.log(`check-shell: ${passed} unit test(s) in the workspace pass`)
}

// ---------------------------------------------------------------------------
function report() {
  console.log('check-shell: the native shell')
  for (const note of notes) console.log(`  - ${note}`)
  if (failures.length) {
    console.log(`\ncheck-shell: ${failures.length} problem(s).`)
    for (const message of failures) console.log(`  - ${message}`)
    process.exit(1)
  }
  console.log('\ncheck-shell: OK')
  process.exit(0)
}

const binary = findBinary()
if (failures.length) report()
writeStub()
checkTauriIsGone()
checkFlags()
await checkRefusal()
await checkLifetime()
await checkConfinedHome()
await checkSetupButtons()
checkCargoTests()
report()
