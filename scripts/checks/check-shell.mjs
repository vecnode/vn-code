#!/usr/bin/env node
// check-shell.mjs - the native app, DRIVEN.
//
// What this proves, and why each one is here:
//
//   1. IT BUILDS, and it is small. `cargo build --release` in `app/` (skipped, loudly,
//      when there is no cargo and no binary on this host), then a size ceiling a
//      dependency that draws a window or a web view cannot sneak past.
//   2. IT ANSWERS. `-Version`, `-Help`, and the flag the deleted web view used to answer:
//      `-Mode embed` must FAIL BY NAME. A flag that quietly means something else is the
//      bug this whole revision exists to remove.
//   3. THE BRIDGE. `vncode start` is run against a THROWAWAY TREE: a `.dsh-version.json`,
//      a copied binary, a home, and STUB scripts - `scripts/setup/install.*` and
//      `scripts/run-web.*` that record what they were given and exit 0. So the app is
//      driven end to end - install-when-missing, the key prompt declined at a pipe, the
//      launcher handed the right flags - WITHOUT starting node, binding a port or
//      opening a tab.
//   4. THE ENVIRONMENT IS COMPOSED, NOT INHERITED. Each stub reads `DSH_HOME`,
//      `VNCODE_HOME` and the console markers out of its OWN environment and says what it
//      saw, so an inherited home or a leaked `VNCODE_CONSOLE` is a failure here rather
//      than a mystery on somebody's machine. That leak is not hypothetical: the old app's
//      first Install button ran a full install while being asked for `-Help`.
//   5. NO KEY IS WRITTEN when there is no terminal to ask at, and no launch token reaches
//      the console.
//   6. THE WEB HALF STANDS ALONE. `scripts/run-web.* -Help` answers with no app involved.
//
// Every fixture lives under `.scratch/` inside the repository. A check must not depend on
// a temp directory the host may deny - that is how a real bug once looked like a failure
// of the host - and `VNCODE_TEST_DIR` points the Rust tests at the same place.
//
// Run:  node scripts/checks/check-shell.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const app = path.join(repo, 'app')
const scratch = path.join(repo, '.scratch')
const isWindows = process.platform === 'win32'

const failures = []
const notes = []
const fail = (message) => failures.push(message)
const note = (message) => notes.push(message)

const built = path.join(app, 'target', 'release', 'vncode' + (isWindows ? '.exe' : ''))

// ---------------------------------------------------------------------------
// 1. It builds, and it is small
// ---------------------------------------------------------------------------
function build() {
  if (!fs.existsSync(built)) {
    const cargo = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'vn-shell'], {
      cwd: app,
      encoding: 'utf8',
    })
    if (cargo.error) {
      note(`cargo could not run (${cargo.error.message}) - the binary checks are SKIPPED`)
      return false
    }
    if (cargo.status !== 0) {
      fail(`cargo build failed:\n${cargo.stdout}\n${cargo.stderr}`)
      return false
    }
  }
  const size = fs.statSync(built).size
  note(`the binary is ${(size / 1024 / 1024).toFixed(2)} MB`)
  // The release budget is 6 MB and CI owns it; this is the ceiling that catches the
  // regression by SHAPE - a GUI stack or a web engine arriving as a dependency.
  if (size > 12 * 1024 * 1024) {
    fail(`the binary is ${(size / 1024 / 1024).toFixed(1)} MB - something with a GUI in it came back`)
  }
  return true
}

// ---------------------------------------------------------------------------
// 2. It answers, and refuses what it no longer has
// ---------------------------------------------------------------------------
function runBinary(args, options = {}) {
  const result = spawnSync(built, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    timeout: 120_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

function answers() {
  const version = runBinary(['-Version'])
  if (version.status !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)) {
    fail(`-Version did not answer with a version: ${JSON.stringify(version.stdout)}`)
  }

  const help = runBinary(['-Help'])
  if (help.status !== 0) fail(`-Help exited ${help.status}`)
  for (const word of ['install', 'uninstall', 'status', 'key', '-DshHome', '-Port']) {
    if (!help.stdout.includes(word)) fail(`-Help never mentions ${word}`)
  }
  if (help.stdout.includes('embed')) {
    fail('-Help advertises an embedded web view this build does not have')
  }

  // The pane's mode. It must be a refusal that NAMES the flag: "we removed it" and "it
  // silently does nothing now" are different promises.
  const embed = runBinary(['-Mode', 'embed'])
  if (embed.status === 0) fail('-Mode embed was accepted by a build with no web view')
  if (!/unknown flag/i.test(embed.stderr)) {
    fail(`-Mode embed was refused without naming the flag: ${JSON.stringify(embed.stderr)}`)
  }
}

// ---------------------------------------------------------------------------
// 3-5. The bridge, against stubs
// ---------------------------------------------------------------------------
/** A stub script: records what it was given, then exits 0. `up` walks to the tree root. */
function stubScript(recordName, up) {
  // `up` is `..` from `scripts/` and `../..` from `scripts/setup/`: the two stubs live at
  // different depths, and a record written one level too high is a check that fails for
  // its own bug rather than the app's.
  if (isWindows) {
    const parents = up.replace(/\//g, '\\')
    return [
      '@echo off',
      `echo args=%* > "%~dp0${parents}\\${recordName}"`,
      `echo DSH_HOME=%DSH_HOME% >> "%~dp0${parents}\\${recordName}"`,
      `echo VNCODE_HOME=[%VNCODE_HOME%] >> "%~dp0${parents}\\${recordName}"`,
      `echo VNCODE_CONSOLE=[%VNCODE_CONSOLE%] >> "%~dp0${parents}\\${recordName}"`,
      `echo TMP=[%TMP%] >> "%~dp0${parents}\\${recordName}"`,
      'exit /b 0',
      '',
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `record="$(dirname "$0")/${up}/${recordName}"`,
    '{',
    '  echo "args=$*"',
    '  echo "DSH_HOME=$DSH_HOME"',
    '  echo "VNCODE_HOME=[$VNCODE_HOME]"',
    '  echo "VNCODE_CONSOLE=[$VNCODE_CONSOLE]"',
    '  echo "TMP=[$TMPDIR]"',
    '} > "$record"',
    'exit 0',
    '',
  ].join('\n')
}

function bridge() {
  const root = path.join(scratch, `shell-bridge-${process.pid}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts', 'setup'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })

  // The pin is what makes the tree a tree: `repo_root()` walks up from the binary for it.
  fs.writeFileSync(path.join(root, '.dsh-version.json'), JSON.stringify({ dsh: '9.9.9' }))
  fs.copyFileSync(built, path.join(root, 'bin', path.basename(built)))

  const setup = path.join(root, 'scripts', 'setup')
  const ext = isWindows ? '.bat' : '.sh'
  fs.writeFileSync(path.join(setup, 'install' + ext), stubScript('install-record.txt', '../..'))
  fs.writeFileSync(path.join(setup, 'uninstall' + ext), stubScript('uninstall-record.txt', '../..'))
  fs.writeFileSync(
    path.join(root, 'scripts', 'run-web' + ext),
    stubScript('runweb-record.txt', '..'),
  )

  const home = path.join(root, 'data', 'home')
  const binary = path.join(root, 'bin', path.basename(built))
  // The seed of every "it printed the wrong thing" report: an inherited home and an
  // inherited console marker. Neither may reach a child, and neither may be believed.
  const env = { ...process.env, VNCODE_HOME: path.join(root, 'data'), VNCODE_CONSOLE: '1' }
  env.VNCODE_ARGV = 'do-not-leak'
  delete env.DSH_HOME
  delete env.DEEPSEEK_API_KEY

  const run = (args) =>
    spawnSync(binary, args, { encoding: 'utf8', cwd: root, env, timeout: 180_000 })

  // --- start, with nothing installed -------------------------------------
  const start = run(['start'])
  if (start.error) {
    fail(`start could not run: ${start.error.message}`)
    return
  }
  if (start.status !== 0) {
    fail(`vncode start exited ${start.status}\n${start.stdout}\n${start.stderr}`)
  }
  const printed = `${start.stdout}\n${start.stderr}`
  if (/token=/i.test(printed)) fail('a launch token reached the console')

  const install = readRecord(root, 'install-record.txt')
  if (!install) {
    fail('vncode start did not run the installer for a home with no pack in it')
  } else {
    if (!install.includes('-DshHome')) fail(`the installer was not told the home: ${install}`)
    if (!install.includes(home)) fail(`the installer was not told THIS home (${home}): ${install}`)
    if (!install.includes('VNCODE_HOME=[]')) {
      fail(`the app's own root leaked into the installer: ${install}`)
    }
    if (!install.includes('DSH_HOME=' + home)) {
      fail(`the installer's DSH_HOME is not the chosen home: ${install}`)
    }
    if (!install.includes('VNCODE_CONSOLE=[]')) {
      fail(`the launcher's console marker leaked into the installer: ${install}`)
    }
  }

  const runweb = readRecord(root, 'runweb-record.txt')
  if (!runweb) {
    fail('vncode start never ran the web launcher - the bridge is the whole point')
  } else {
    if (!runweb.includes('-DshHome')) fail(`the launcher was not told the home: ${runweb}`)
    if (!runweb.includes(home)) fail(`the launcher was not told THIS home (${home}): ${runweb}`)
    if (isWindows && !runweb.includes('-NoTerminal')) {
      fail(`the launcher was not told -NoTerminal, so a relaunch would look like an instant exit: ${runweb}`)
    }
    if (!runweb.includes('DSH_HOME=' + home)) {
      fail(`the launcher's DSH_HOME is not the chosen home: ${runweb}`)
    }
    if (!runweb.includes('VNCODE_HOME=[]')) {
      fail(`the app's own root leaked into the launcher: ${runweb}`)
    }
    if (!runweb.includes('VNCODE_CONSOLE=[]')) {
      fail(`the console marker leaked into the launcher: ${runweb}`)
    }
  }

  // --- the key is not asked for at a pipe, and nothing is written ---------
  const envFile = path.join(home, '.env')
  if (fs.existsSync(envFile)) {
    fail(`a key file was written with no terminal to ask at: ${envFile}`)
  }
  if (!/not a terminal/.test(printed)) {
    fail(`start did not say why it skipped the key prompt: ${printed}`)
  }

  // --- status reports the same home, and starts nothing ------------------
  const status = run(['status'])
  if (status.status !== 0) fail(`status exited ${status.status}`)
  if (!status.stdout.includes(home)) {
    fail(`status does not name the home in use (${home}):\n${status.stdout}`)
  }
  if (!/launcher:/.test(status.stdout)) fail('status does not name the launcher')

  fs.rmSync(root, { recursive: true, force: true })
  note('start, the installer and the launcher were driven against stub scripts')
}

function readRecord(root, name) {
  const file = path.join(root, name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

// ---------------------------------------------------------------------------
// 6. The web half stands alone
// ---------------------------------------------------------------------------
function webHalf() {
  const script = path.join(repo, 'scripts', 'run-web' + (isWindows ? '.bat' : '.sh'))
  if (!fs.existsSync(script)) {
    fail(`${script} is missing - launching only the web is a supported thing to do`)
    return
  }
  // THE CONSOLE MARKERS ARE CLEARED, and that is the whole point of running it here.
  // `adapt.cmd` marks a run it has set up with `VNCODE_CONSOLE`, and an entry point that
  // sees the marker takes its arguments from the relaunched shell instead of `%*` - so a
  // check that inherited the marker would test a path no double-click ever takes. It was
  // measured: with the marker inherited, `run-web.bat -Help` started a real harness.
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('VNCODE_')) env[name] = value
  }
  const result = isWindows
    ? spawnSync('cmd', ['/c', script, '-Help'], { encoding: 'utf8', cwd: repo, env })
    : spawnSync('sh', [script, '-Help'], { encoding: 'utf8', cwd: repo, env })
  if (result.status !== 0) {
    fail(`run-web -Help exited ${result.status}: ${result.stdout}${result.stderr}`)
    return
  }
  if (!/Usage/i.test(`${result.stdout}${result.stderr}`)) {
    fail('run-web -Help printed no usage')
  }
  note('scripts/run-web.* answers on its own, with no vncode binary involved')
}

// ---------------------------------------------------------------------------
fs.mkdirSync(scratch, { recursive: true })

if (build()) {
  answers()
  bridge()
  webHalf()
}

console.log('check-shell: the native app, driven')
for (const line of notes) console.log(`  - ${line}`)
if (failures.length) {
  console.log(`\ncheck-shell: ${failures.length} problem(s).`)
  for (const message of failures) console.log(`  - ${message}`)
  process.exit(1)
}
console.log('\ncheck-shell: OK')
