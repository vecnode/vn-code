#!/usr/bin/env node
//  scripts/checks/check-scripts.mjs - the scripts/ tree and its console contract.
//
//  This replaces check-dist-layout.mjs, which owned a DISTRIBUTION: the ship list,
//  the single-file payload and every bundle being carried by an include. That
//  machinery was erased deliberately - the distribution is now this app beside the
//  pack it installs, and the panel's Install button runs scripts/setup/install.* -
//  so the parts of that check which still test something live here, and the parts
//  that tested the erased machinery are gone with it.
//
//  What this proves:
//
//   1. THE LAYOUT. `scripts/` holds the two entry points a person runs (run-web,
//      run-desktop), each with the worker or twin it needs, and the three folders:
//      `console/` (the shared console layer), `setup/` (install and uninstall) and
//      `tools/` (maintainer-only). A file at the top level that is none of those is
//      reported: the point of the layout is that a reader can tell "what I run"
//      from "what it uses" at a glance.
//   2. THE CONSOLE CONTRACT, still enforced because it is still load-bearing: every
//      Windows entry point guards `VNCODE_ARGV` against a relaunch, calls the ONE
//      console layer, forwards `VNCODE_ARGS` and never `%*`, and `adapt.cmd` does
//      not `setlocal` (its decisions must stay visible to its caller).
//   3. THE ENTRY POINTS REALLY RUN. `setup/install.bat -Help` and
//      `setup/uninstall.bat -Help` are DRIVEN, with the console variables cleared
//      exactly as the app clears them, and must print the worker's usage and exit
//      0. That is the whole path the panel's buttons take: locate, spawn through
//      the console layer, and read an exit code - and `-Help` installs nothing.
//   4. NO CI. `.github/workflows/` must not exist; Actions was removed on purpose
//      and a deleted CI must not quietly return on a push.
//
//  Run:  node scripts/checks/check-scripts.mjs
//  POSIX entry points are checked for shape only; driving them needs a POSIX host,
//  which SKIPS LOUDLY here rather than pretending.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const scripts = path.join(repo, 'scripts')
const failures = []
const notes = []

const fail = (message) => failures.push(message)

const read = (relative) => {
  const full = path.join(repo, relative)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
}

// ---------------------------------------------------------------------------
// 1. The layout
// ---------------------------------------------------------------------------
const TOP_LEVEL_FILES = [
  'run-web.bat',
  'run-web.ps1',
  'run-web.sh',
  'run-desktop.bat',
  'run-desktop.sh',
]
const TOP_LEVEL_FOLDERS = ['checks', 'console', 'setup', 'tools']

function checkLayout() {
  for (const name of [...TOP_LEVEL_FILES, ...TOP_LEVEL_FOLDERS]) {
    if (!fs.existsSync(path.join(scripts, name))) fail(`scripts/${name} is missing`)
  }
  const unexpected = fs
    .readdirSync(scripts)
    .filter((name) => !TOP_LEVEL_FILES.includes(name) && !TOP_LEVEL_FOLDERS.includes(name))
  if (unexpected.length) {
    fail(
      `scripts/ has entries that are neither an entry point nor one of the four folders: ${unexpected.join(', ')} - an entry point belongs at the top, everything else in a folder`,
    )
  }
  // The setup entry points are what the panel's two buttons run.
  for (const name of ['install.bat', 'install.sh', 'uninstall.bat', 'uninstall.sh']) {
    if (!fs.existsSync(path.join(scripts, 'setup', name))) fail(`scripts/setup/${name} is missing`)
  }
  // ...and the workers they forward to must travel beside them, because both
  // resolve the repository root from their own folder.
  for (const name of ['install-all.ps1', 'install-all.sh', 'uninstall-all.ps1', 'uninstall-all.sh']) {
    if (!fs.existsSync(path.join(scripts, 'setup', name))) fail(`scripts/setup/${name} is missing`)
  }
  console.log('check-scripts: the layout - two entry points, four folders')
}

// ---------------------------------------------------------------------------
// 2. The console contract
// ---------------------------------------------------------------------------
// The three lines every Windows entry point holds, in this order. The guard on the
// first is what keeps the real flags when Windows Terminal relaunches an entry
// point; the second is the ONE place console behaviour is decided.
const GUARD = 'if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"'
const CONSOLE_CALL = /call\s+"%~dp0(\.\.\\)?console\\adapt\.cmd"\s+"%~f0"/i

function checkEntryPoint(relative) {
  const text = read(relative)
  if (text === null) {
    fail(`${relative} is missing`)
    return
  }
  if (!text.includes(GUARD)) {
    fail(`${relative} lost the VNCODE_ARGV guard, so a relaunch would drop the flags`)
  }
  if (!CONSOLE_CALL.test(text)) {
    fail(`${relative} does not call the shared console layer (console\\adapt.cmd)`)
  }
  if (/%\*/.test(text.replace(/set "VNCODE_ARGV=%\*"/g, ''))) {
    fail(`${relative} forwards %* - an entry point forwards %VNCODE_ARGS% and never %*`)
  }
  if (!text.includes('%VNCODE_ARGS%')) {
    fail(`${relative} never forwards %VNCODE_ARGS%`)
  }
}

function checkConsoleContract() {
  for (const name of ['run-web.bat', 'run-desktop.bat']) checkEntryPoint(`scripts/${name}`)
  for (const name of ['install.bat', 'uninstall.bat']) checkEntryPoint(`scripts/setup/${name}`)

  const adapt = read('scripts/console/adapt.cmd')
  if (adapt === null) {
    fail('scripts/console/adapt.cmd is missing')
    return
  }
  // `setlocal` here would hide VNCODE_ARGS/VNCODE_PAUSE/VNCODE_PS from the caller
  // that has to act on them, which is the whole reason this file is not a worker.
  if (/^\s*setlocal\b/im.test(adapt)) {
    fail('scripts/console/adapt.cmd calls setlocal - its decisions must stay visible to its caller')
  }
  if (!adapt.includes('if not defined VNCODE_ARGV set "VNCODE_ARGV= "')) {
    fail('adapt.cmd lost the one-space normalisation of VNCODE_ARGV (the double-click path needs it)')
  }
  for (const code of ['exit /b 0', 'exit /b 2']) {
    if (!adapt.includes(code)) fail(`adapt.cmd no longer answers ${code}`)
  }
  for (const theme of ['scripts/console/theme.ps1', 'scripts/console/theme.sh']) {
    if (!fs.existsSync(path.join(repo, theme))) fail(`${theme} is missing`)
  }
  console.log('check-scripts: the console contract holds for every entry point')
}

// ---------------------------------------------------------------------------
// 3. The entry points, really run
// ---------------------------------------------------------------------------
/**
 * The variables the console layer uses to carry state from an entry point to its
 * relaunched self.
 *
 * A run started by the app MUST have these cleared, and this check clears them for
 * the same reason: with `VNCODE_CONSOLE` inherited, an entry point does not set
 * `VNCODE_ARGV` from `%*` and `adapt.cmd` returns immediately - so `-Help` is
 * dropped and the installer runs for real. Measured on a machine whose harness was
 * launched by run-web.bat, where the first version of this check started an
 * install while asking for help.
 */
const CONSOLE_VARIABLES = [
  'VNCODE_CONSOLE',
  'VNCODE_ARGV',
  'VNCODE_ARGS',
  'VNCODE_PAUSE',
  'VNCODE_NOPAUSE',
  'VNCODE_QUIET',
  'VNCODE_NO_WT',
]

function clearedEnvironment() {
  const env = { ...process.env }
  for (const name of CONSOLE_VARIABLES) delete env[name]
  return env
}

function checkWindowsEntryPoints() {
  if (process.platform !== 'win32') {
    notes.push('not a Windows host, so setup\\install.bat and setup\\uninstall.bat were not driven')
    return
  }
  for (const [name, needle] of [
    ['install.bat', 'Usage: scripts\\setup\\install.bat [flags]'],
    ['uninstall.bat', 'Usage: scripts\\setup\\uninstall.bat [flags]'],
  ]) {
    const relative = `scripts/setup/${name}`
    const run = spawnSync('cmd', ['/c', path.join(scripts, 'setup', name), '-NoTerminal', '-NoPause', '-Help'], {
      cwd: repo,
      encoding: 'utf8',
      env: clearedEnvironment(),
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    if (run.status !== 0) fail(`${relative} -Help exited ${run.status}`)
    if (!output.includes(needle)) {
      fail(`${relative} -Help did not print its usage (${needle}) - it ran something else`)
    }
    // -Help must not install or uninstall: the words below only appear on a run
    // that went to work.
    if (/(adding|removing) dsh-/.test(output)) {
      fail(`${relative} -Help started changing the profile`)
    }
  }
  console.log('check-scripts: install.bat and uninstall.bat answer -Help without touching anything')
}

// ---------------------------------------------------------------------------
// 4. No CI
// ---------------------------------------------------------------------------
function checkNoCi() {
  if (fs.existsSync(path.join(repo, '.github', 'workflows'))) {
    fail('.github/workflows exists - the deleted CI came back (see docs/RELEASE.md)')
  }
  console.log('check-scripts: no .github/workflows - CI stays deleted')
}

// ---------------------------------------------------------------------------
checkLayout()
checkConsoleContract()
checkWindowsEntryPoints()
checkNoCi()

console.log('check-scripts: the scripts tree, its console contract, and its entry points')
for (const note of notes) console.log(`  - ${note}`)
if (failures.length) {
  console.log(`\ncheck-scripts: ${failures.length} problem(s).`)
  for (const message of failures) console.log(`  - ${message}`)
  process.exit(1)
}
console.log('\ncheck-scripts: OK')
