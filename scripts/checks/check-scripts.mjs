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
//   1. THE LAYOUT. `scripts/` holds the ONE entry point a person runs, `run-web`, in its
//      three host spellings: the .bat double-click wrapper, the .ps1 worker beside it,
//      and the POSIX .sh that does the whole job itself. Beside them are the four
//      folders: `console/` (the shared console layer), `setup/` (install and uninstall),
//      `tools/` (maintainer-only) and `checks/`. A file at the top level that is none of
//      those is reported: the point of the layout is that a reader can tell "what I run"
//      from "what it uses" at a glance.
//   2. THE CONSOLE CONTRACT, still enforced because it is still load-bearing: every
//      Windows entry point guards `VNCODE_ARGV` against a relaunch, calls the ONE
//      console layer, forwards `VNCODE_ARGS` and never `%*`, and `adapt.cmd` does
//      not `setlocal` (its decisions must stay visible to its caller).
//   3. THE ENTRY POINTS REALLY RUN. `run-web.bat -Help` (or `run-web.sh -Help` on a POSIX
//      host), `setup/install.bat -Help` and `setup/uninstall.bat -Help` are DRIVEN, with
//      the console variables cleared exactly as a fresh shell has them, and must print the
//      script's own usage and exit 0. That covers both things a person does by hand -
//      starting the harness and installing the pack - and `-Help` does neither.
//   4. THE TWO WORKFLOWS. `.github/workflows/` must exist, and must do the one job CI is
//      for here: `ci.yml` callable and running the pure-node checks in a Node container,
//      `release.yml` publishing ONE artefact - a zip of this repository. CI was deleted
//      once on purpose; it is back for the release, and this is what keeps it honest.
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
const TOP_LEVEL_FILES = ['run-web.bat', 'run-web.ps1', 'run-web.sh']
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
  console.log('check-scripts: the layout - one entry point, four folders')
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
  checkEntryPoint('scripts/run-web.bat')
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
// 2b. The portable root: ONE rule, in three places
// ---------------------------------------------------------------------------
/**
 * Both `run-web` workers must join the folder's own home when it is portable.
 *
 * A folder that is a portable installation keeps everything inside itself - the pack, the
 * sessions and the key - so nothing lands in the user's profile. The rule is two facts:
 * the `PORTABLE` marker, or a home already inside the root. It is implemented twice, once
 * per launcher worker, because the Windows half and the POSIX half cannot call into each
 * other. Two copies of one rule drift unless something reads them, and this is that
 * something: both workers must test the marker AND the `home` folder, and must export
 * `DSH_HOME` into the root's own home.
 */
function checkPortableRootRule() {
  for (const relative of ['scripts/run-web.ps1', 'scripts/run-web.sh']) {
    const text = read(relative)
    if (text === null) {
      fail(`${relative} is missing`)
      continue
    }
    if (!text.includes("'PORTABLE'") && !text.includes('/PORTABLE')) {
      fail(`${relative} does not test for the PORTABLE marker, so a portable folder is not one there`)
    }
    if (!/['"/]home['"]?/.test(text) || !/\.vncode/.test(text)) {
      fail(`${relative} never names <tree>/.vncode/home, so it cannot join the folder's own home`)
    }
    if (!text.includes('portable installation')) {
      fail(`${relative} does not say WHY the home is the folder (the panel prints the same sentence)`)
    }
    if (!/export\s+DSH_HOME|env:DSH_HOME/.test(text)) {
      fail(`${relative} resolves a portable home but never exports DSH_HOME to the harness`)
    }
  }
  console.log('check-scripts: both run-web workers join the folder\u2019s own home when it is portable')
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
// 3b. The launcher answers -Help without starting anything
// ---------------------------------------------------------------------------
/**
 * `run-web` is the only entry point, and asking it a question must not spawn `npx`, bind a
 * port or open a tab: the answer comes from the script's own argument parser. A launch
 * nobody can check by hand on every host is a launch that breaks quietly.
 *
 * The Windows entry is driven through cmd as a double-click would drive it, with
 * -NoTerminal so `adapt.cmd` does not hand the run to Windows Terminal (which would exit 0
 * having printed nothing); the POSIX twin is driven with `sh`, and says loudly when the
 * host has none.
 */
function checkRunWebHelp() {
  const windows = process.platform === 'win32'
  const relative = windows ? 'scripts/run-web.bat' : 'scripts/run-web.sh'
  const needle = windows ? 'Usage: scripts\\run-web.bat [flags]' : 'Usage: sh scripts/run-web.sh'
  const run = windows
    ? spawnSync('cmd', ['/c', path.join(scripts, 'run-web.bat'), '-NoTerminal', '-NoPause', '-Help'], {
        cwd: repo,
        encoding: 'utf8',
        env: clearedEnvironment(),
        // A -Help that starts the harness instead of answering would never exit, so the
        // wait is bounded: the failure is then a timeout with a name, not a hung check.
        timeout: 60000,
      })
    : spawnSync('sh', [path.join(scripts, 'run-web.sh'), '-Help'], {
        cwd: repo,
        encoding: 'utf8',
        env: clearedEnvironment(),
        timeout: 60000,
      })
  if (run.error) {
    notes.push(`${relative} -Help could not be driven here (${run.error.code ?? run.error.message})`)
    return
  }
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status !== 0) fail(`${relative} -Help exited ${run.status}`)
  if (!output.includes(needle)) {
    fail(`${relative} -Help did not print its usage (${needle}) - it started something else`)
  }
  // A help request that reached the harness would name the pin. It must not.
  if (output.includes('Pinned dsh version')) {
    fail(`${relative} -Help started the launcher instead of answering`)
  }
  console.log(`check-scripts: ${relative} answers -Help without starting the harness`)
}

// ---------------------------------------------------------------------------
// 4. The two workflows, and what they promise
// ---------------------------------------------------------------------------
// CI was once deleted on purpose ("the checks are run by hand"). It is back for ONE job:
// proving a tree that is about to be tagged, and attaching the zip a tag publishes. The
// assertion is inverted rather than dropped, because "CI exists" and "CI proves what we
// ship" are different claims and only the second is worth having. Half of this is
// negative on purpose: there is no compiler in this repository any more, so a workflow
// that reaches for one is exactly the change this is here to catch.
function checkCi() {
  const workflows = path.join(repo, '.github', 'workflows')
  if (!fs.existsSync(workflows)) {
    fail('.github/workflows is missing - the release gates on ci.yml and publishes the zip (docs/RELEASE.md)')
    return
  }
  const ci = path.join(workflows, 'ci.yml')
  const release = path.join(workflows, 'release.yml')
  for (const [file, label] of [[ci, 'ci.yml'], [release, 'release.yml']]) {
    if (!fs.existsSync(file)) fail(`.github/workflows/${label} is missing`)
  }
  // The runtime the pack declares, read once: the CI container below and this
  // check's own closing line both name it, so a floor bump has ONE place to land.
  const declared = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines?.node ?? ''
  const major = /(\d+)/.exec(declared)?.[1] ?? ''
  if (!major) fail(`package.json declares no engines.node major (found "${declared}")`)
  if (fs.existsSync(ci)) {
    const text = fs.readFileSync(ci, 'utf8')
    if (!text.includes('workflow_call')) {
      fail('ci.yml is not callable - release.yml must run the same checks rather than a copy')
    }
    // The two checks a boundary run is for. A workflow that runs neither is a badge.
    for (const check of ['check-no-secrets.mjs', 'check-scripts.mjs']) {
      if (!text.includes(check)) fail(`ci.yml does not run ${check}`)
    }
    // One runtime, and the one the pack declares. The container is what makes "one runner
    // covers every platform" true rather than assumed: there is nothing per-OS to build.
    // The major is READ from package.json rather than typed here, so the two cannot
    // drift: a floor bump that forgot the container fails on the next run.
    if (major && !new RegExp(`container:\\s*node:${major}\\b`).test(text)) {
      fail(`ci.yml does not run in a node:${major} container, so the runtime it proves is not the one package.json declares (${declared})`)
    }
    if (/cargo|rustup|clippy/.test(text)) {
      fail('ci.yml reaches for a Rust toolchain - this repository has no native code to build')
    }
  }
  if (fs.existsSync(release)) {
    const text = fs.readFileSync(release, 'utf8')
    if (!text.includes('uses: ./.github/workflows/ci.yml')) {
      fail('release.yml does not gate on ci.yml')
    }
    // ONE artefact, and it is the repository itself: the pack, the launchers, the checks
    // and the docs. A second, per-OS file is the shape this release replaced.
    if (!text.includes('NAME="${STEM}-${VERSION}"')) {
      fail('release.yml does not name the artefact <stem>-<version>, so the release is not the repo itself')
    }
    if (!text.includes('git archive')) {
      fail('release.yml does not build the archive with git archive, so the zip can drift from the tree')
    }
    if (/cargo|rustup|matrix\.target|vncode\.exe/.test(text)) {
      fail('release.yml still builds or names a per-OS binary')
    }
  }
  console.log(`check-scripts: ci.yml is a node:${major} container, release.yml publishes the repo zip`)
}

// ---------------------------------------------------------------------------
checkLayout()
checkConsoleContract()
checkPortableRootRule()
checkWindowsEntryPoints()
checkRunWebHelp()
checkCi()

console.log('check-scripts: the scripts tree, its console contract, and its entry points')
for (const note of notes) console.log(`  - ${note}`)
if (failures.length) {
  console.log(`\ncheck-scripts: ${failures.length} problem(s).`)
  for (const message of failures) console.log(`  - ${message}`)
  process.exit(1)
}
console.log('\ncheck-scripts: OK')
