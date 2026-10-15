#!/usr/bin/env node
// check-pane.mjs - the pane's contract, which is a contract about TWO BUILDS.
//
// The pane is opt-in (`cargo build --features pane`), so the one thing that has to be true
// is that the two builds DISAGREE, in both directions:
//
//   the DEFAULT build compiles no engine at all, and refuses `-Mode embed` BY NAME;
//   the build WITH the pane accepts it, and its usage text says so.
//
// Both halves are asserted, in that order, and the default binary is rebuilt at the end.
// A check that only drove the pane build would pass while `-Mode embed` was a no-op
// everywhere; one that only drove the default build would pass while the pane did not
// exist. Neither is worth having.
//
// It SKIPS LOUDLY (exit 0) when this host cannot build the pane - no cargo, no way to
// resolve `wry` from crates.io, or no system WebKitGTK on Linux - because that is the
// pack's rule for a check a host cannot run: a green run there is not evidence, and the
// output says so. A build failure that is NOT one of those host reasons is a FAILURE, not a
// skip, so a compile error can never hide behind the skip.
//
// It starts no window and needs no browser engine at runtime: `-Mode embed -Help` parses
// the flag and prints the usage, which is the observable that proves the mode is real.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const app = path.join(root, 'app')
const exeName = process.platform === 'win32' ? 'vncode.exe' : 'vncode'

const failures = []
const fail = (message) => failures.push(message)
const skip = (message) => {
  console.log(`check-pane: SKIP - ${message}`)
  process.exit(0)
}
const check = (what, ok, detail) => {
  if (ok) {
    console.log(`  ok    ${what}`)
  } else {
    console.log(`  FAIL  ${what}`)
    fail(`${what}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** A failed build is only a SKIP when it failed for a reason that is about the HOST. */
const HOST_REASONS =
  /failed to (download|get|select|fetch)|network|registry|crates\.io index|no matching package|timed out|pkg-config|webkit2gtk|gtk\+|cannot find -l|linker .* not found|could not find system library/i

function build(extra) {
  const args = ['build', '-p', 'vn-shell']
  if (extra) args.push(...extra)
  const started = Date.now()
  const built = spawnSync('cargo', args, { cwd: app, encoding: 'utf8', shell: false })
  const text = `${built.stdout ?? ''}${built.stderr ?? ''}`
  return { status: built.status, text, seconds: Math.round((Date.now() - started) / 1000), args }
}

function run(args) {
  const binary = path.join(app, 'target', 'debug', exeName)
  if (!fs.existsSync(binary)) return { status: null, stdout: '', stderr: '' }
  return spawnSync(binary, args, { encoding: 'utf8', shell: false })
}

// ---------------------------------------------------------------------------
// Is there a cargo to build with at all?
// ---------------------------------------------------------------------------
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: false })
if (cargo.error || cargo.status !== 0) {
  skip('no cargo on PATH - the pane is a Rust build, so this host cannot run this check')
}

// ---------------------------------------------------------------------------
// The build WITH the pane
// ---------------------------------------------------------------------------
console.log('check-pane: building the pane (cargo build -p vn-shell --features pane)...')
const pane = build(['--features', 'pane'])
if (pane.status !== 0) {
  if (HOST_REASONS.test(pane.text)) {
    skip(`the pane cannot be built on this host: ${pane.text.trim().split('\n').pop()}`)
  }
  fail(`the pane build failed:\n${pane.text}`)
  report()
}
console.log(`  ok    the pane build links (${pane.seconds}s, wry + the OS engine bindings)`)

// The flag is a real mode in THIS build, and the usage text admits it.
const embedHelp = run(['-Mode', 'embed', '-Help'])
check('the pane build accepts -Mode embed', embedHelp.status === 0, `exit ${embedHelp.status}`)
check(
  'the pane build\'s usage names -Mode embed',
  (embedHelp.stdout ?? '').includes('-Mode embed'),
)
// The flag list the rest of the repo depends on is still complete in this build.
for (const flag of ['-Port', '-DshHome', '-DshVersion', '-Mode', '-Help']) {
  check(`the pane build's usage still names ${flag}`, (embedHelp.stdout ?? '').includes(flag))
}

// The pane's own rules - the rectangle, the visibility table, the loopback re-check, the
// permission answer, and the purge of what the engine records about where the pane went - are
// unit tests in the crate, and they run with the feature on. Two of them write real files, so
// they are given a scratch root inside the checkout: a host that denies %TEMP% to a child would
// otherwise turn those into a failure about the host rather than about the code, which is the
// same reason `check-shell.mjs` points VNCODE_TEST_DIR here.
const scratch = path.join(root, '.scratch', 'cargo-test')
fs.mkdirSync(scratch, { recursive: true })
const paneTests = spawnSync('cargo', ['test', '-p', 'vn-shell-pane', '--features', 'pane'], {
  cwd: app,
  encoding: 'utf8',
  shell: false,
  env: { ...process.env, VNCODE_TEST_DIR: scratch },
})
check(
  'the pane\'s own tests pass with the feature on',
  paneTests.status === 0,
  `${(paneTests.stdout ?? '').split('\n').filter((line) => line.includes('test result')).join(' | ')}`,
)

// ---------------------------------------------------------------------------
// The build WITHOUT it - and the two must disagree
// ---------------------------------------------------------------------------
console.log('check-pane: rebuilding the default shell (cargo build -p vn-shell)...')
const plain = build(null)
if (plain.status !== 0) {
  fail(`the default build failed:\n${plain.text}`)
  report()
}
console.log(`  ok    the default build compiles no engine (${plain.seconds}s)`)

const noPane = run(['-Mode', 'embed'])
check('the default build refuses -Mode embed', noPane.status === 1, `exit ${noPane.status}`)
check(
  'the refusal says this build draws no web view',
  /draws no web view/.test(noPane.stderr ?? ''),
  noPane.stderr ?? '',
)
check(
  'the refusal names the mode that does work',
  /chrome/.test(noPane.stderr ?? ''),
  noPane.stderr ?? '',
)

const plainHelp = run(['-Help'])
check('the default build\'s usage does NOT promise a pane', plainHelp.status === 0 && !(plainHelp.stdout ?? '').includes('-Mode embed'))
check(
  'the default build\'s usage still names every flag it takes',
  ['-Port', '-DshHome', '-DshVersion', '-Mode', '-Help'].every((flag) =>
    (plainHelp.stdout ?? '').includes(flag),
  ),
)

// ---------------------------------------------------------------------------
report()

function report() {
  if (failures.length > 0) {
    console.error(`\ncheck-pane: ${failures.length} problem(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(
    '\ncheck-pane: OK - the default build promises no pane, and the pane build has one',
  )
}
