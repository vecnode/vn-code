// check-dist-layout.mjs - the DISTRIBUTION feature's own tracked check.
//
// Why this exists: a distribution is a COPY of this repository produced by two
// independent halves (scripts/dist.ps1 on Windows, scripts/dist.sh everywhere
// else), and the failure mode that matters is the quiet one - a bundle added
// under packages/ that the ship list does not carry, a skip rule that lets 200 MB
// of build inputs into the archive, or one half learning a flag the other never
// heard of. None of that needs a build to detect, so none of it needs a runner
// either: this is Node only, identical on every platform, and it says what it
// checked.
//
// Run:  node scripts/checks/check-dist-layout.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const failures = []
const notes = []

function fail(message) { failures.push(message) }
function note(message) { notes.push(message) }

/**
 * A file's lines with its comments removed.
 *
 * Several checks below are about what a launcher DOES, and these files document
 * themselves heavily - install.sh says "NOT PowerShell, ever" and theme.sh's own
 * header names the bashisms it must avoid. Testing the raw text would fail every
 * one of them on its own explanation, so the checks that are about behaviour read
 * the code with `#`, `rem` and `::` lines dropped.
 */
function code(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*(#|rem\b|::)/i.test(line)).join('\n')
}

function read(relative) {
  const file = path.join(repo, relative)
  if (!existsSync(file)) {
    fail(`${relative} is missing.`)
    return null
  }
  return readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------------------
// 1. The ship list, and the two halves that read it
// ---------------------------------------------------------------------------
const manifest = read('scripts/dist-manifest.txt')
const ps = read('scripts/dist.ps1')
const sh = read('scripts/dist.sh')
const bat = read('scripts/distribute.bat')
const distributeSh = read('scripts/distribute.sh')
const gitignore = read('.gitignore')

/** The manifest's rules, as { kind, path }. */
function parseManifest(text) {
  const rules = []
  for (const line of text.split(/\r?\n/)) {
    const text2 = line.trim()
    if (!text2 || text2.startsWith('#')) continue
    const match = /^(include|skipdir|skippath|skipfile)\s+(\S+)$/.exec(text2)
    if (!match) {
      fail(`dist-manifest.txt: cannot read the rule '${text2}'.`)
      continue
    }
    rules.push({ kind: match[1], path: match[2] })
  }
  return rules
}

if (manifest) {
  const rules = parseManifest(manifest)
  const includes = rules.filter((rule) => rule.kind === 'include').map((rule) => rule.path)
  const skipdirs = rules.filter((rule) => rule.kind === 'skipdir').map((rule) => rule.path)

  // Everything the application needs to RUN, or the folder is not a distribution.
  for (const required of ['packages', '.dsh-version.json', 'scripts', 'README.md', 'LICENSE', 'docs']) {
    if (!includes.includes(required)) fail(`dist-manifest.txt does not ship '${required}'.`)
  }

  // node_modules is 200 MB of build INPUTS for artifacts that are already
  // committed under lib/vendor/ - losing this rule multiplies the archive by
  // twenty. target/ is the shell's Rust build tree. Both are load-bearing.
  for (const required of ['node_modules', 'target', 'gen', 'dist']) {
    if (!skipdirs.includes(required)) fail(`dist-manifest.txt lost its 'skipdir ${required}' rule.`)
  }

  // No rule may reach outside the repository.
  for (const rule of rules) {
    if (rule.path.includes('..')) fail(`dist-manifest.txt: '${rule.path}' reaches outside the repository.`)
  }

  // --- every registered bundle must be carried by an include -----------------
  // A package is a bundle when its package.json declares dsh.bundle. Anything
  // under packages/ that is a bundle and is NOT under an included tree would be
  // silently missing from every distribution.
  let packages = []
  try {
    packages = readdirSync(path.join(repo, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch { fail('packages/ cannot be read.') }

  const bundles = []
  for (const name of packages) {
    const manifestPath = path.join(repo, 'packages', name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let json = null
    try { json = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { }
    if (json && json.dsh && json.dsh.bundle) bundles.push({ name, dir: `packages/${name}` })
  }
  if (bundles.length === 0) fail('No bundle found under packages/ (a package.json with dsh.bundle).')
  for (const bundle of bundles) {
    const covered = includes.some((include) => include === 'packages' || bundle.dir === include || bundle.dir.startsWith(`${include}/`))
    if (!covered) fail(`The bundle '${bundle.name}' (${bundle.dir}) is not under any include rule - it would not ship.`)
  }

  // --- every bundle in the pin manifest must exist as a package -------------
  // .dsh-version.json is the pack's own registry of what it contains; a bundle
  // listed there but missing from packages/ means the manifest is stale.
  const pinText = read('.dsh-version.json')
  if (pinText) {
    let pin = null
    try { pin = JSON.parse(pinText) } catch { fail('.dsh-version.json does not parse.') }
    if (pin && pin.packages) {
      for (const name of Object.keys(pin.packages)) {
        if (!bundles.some((bundle) => bundle.name === name)) {
          fail(`.dsh-version.json lists '${name}', which is not an installed bundle under packages/.`)
        }
      }
    }
    if (pin && !pin.dsh) fail('.dsh-version.json has no "dsh" pin - the shell has no fallback for it.')
  }

  note(`${bundles.length} bundles, ${includes.length} include rules, ${rules.length - includes.length} skip rules`)
}

// ---------------------------------------------------------------------------
// 2. The two halves must not drift
// ---------------------------------------------------------------------------
if (ps && sh) {
  // Both read the ONE ship list rather than carrying their own.
  for (const [name, text] of [['scripts/dist.ps1', ps], ['scripts/dist.sh', sh]]) {
    if (!text.includes('dist-manifest.txt')) fail(`${name} does not read scripts/dist-manifest.txt.`)
  }

  // The same flags, both halves. A flag only one half knows is a run that fails
  // on half the matrix.
  const flags = ['-Version', '-SkipBuild', '-NoZip', '-Run', '-Verify', '-KeepVerifyHome', '-OutDir', '-Clean', '-NoPause', '-Help']
  for (const flag of flags) {
    if (!ps.includes(flag)) fail(`scripts/dist.ps1 does not handle ${flag}.`)
    if (!sh.includes(flag)) fail(`scripts/dist.sh does not handle ${flag}.`)
  }

  // The same files generated for the distribution.
  for (const generated of ['START-HERE', 'DIST-README.txt', 'BUILD-INFO.json', 'SHA256SUMS.txt']) {
    if (!ps.includes(generated)) fail(`scripts/dist.ps1 never generates ${generated}.`)
    if (!sh.includes(generated)) fail(`scripts/dist.sh never generates ${generated}.`)
  }

  // The sentinel list - one entry per shipped family, the guard that catches a
  // copy that flattened or nested a tree - must be the SAME list in both halves.
  const sentinelsOf = (text) => new Set(
    text.match(/(?:^|[\s'"])(?:\.dsh-version\.json|app\/[^\s'"]+|assets\/[^\s'"]+|docs\/[^\s'"]+|packages\/[^\s'"]+|scripts\/[^\s'"]+)/gm)
      ?.map((value) => value.trim().replace(/^['"]/, '')) ?? [],
  )
  const psSentinels = sentinelsOf(ps)
  const shSentinels = sentinelsOf(sh)
  const wanted = [
    'packages/dsh-vn-master/package.json',
    'packages/dsh-pdf/lib/vendor/pdf.min.mjs',
    'packages/dsh-diagrams/lib/vendor/mermaid.min.js',
    'packages/dsh-editor/lib/vendor/cm6.min.js',
    'packages/dsh-cmdbar/lib/client.js',
    'app/README.md',
    'assets/vncode.svg',
  ]
  for (const sentinel of wanted) {
    if (!psSentinels.has(sentinel)) fail(`scripts/dist.ps1 does not check the sentinel '${sentinel}'.`)
    if (!shSentinels.has(sentinel)) fail(`scripts/dist.sh does not check the sentinel '${sentinel}'.`)
  }

  // The launch token is a live credential: both halves must redact it in
  // anything they print from the ready line, and neither may echo the raw line.
  for (const [name, text] of [['scripts/dist.ps1', ps], ['scripts/dist.sh', sh]]) {
    if (!/token=REDACTED/.test(text)) fail(`${name} does not redact the launch token.`)
  }
  if (!/Test-LoopbackUrl|127\.0\.0\.1:\*/.test(ps) || !/loopback/.test(sh)) {
    fail('A distribution half does not refuse a ready line that is not a loopback address.')
  }
}

// ---------------------------------------------------------------------------
// 3. The entry points, and the rule that keeps dist/ out of GitHub
// ---------------------------------------------------------------------------
// Every launcher lives in scripts/ - the repository root carries no .bat and no
// .sh at all - so each one reaches its worker through `%~dp0` (cmd) or its own
// directory (POSIX) and a run works from any current directory. That is what is
// asserted here: the two distributer entry points must call the worker BESIDE
// them, as a FILE, never an inline command.
if (bat) {
  // Batch only, so Windows asks no execution-policy question before starting,
  // and it must forward to the same worker the workflow calls.
  if (!/%~dp0dist\.ps1/.test(bat)) fail('scripts/distribute.bat does not call the dist.ps1 beside it (%~dp0dist.ps1).')
  if (/^\s*(pwsh|powershell)\s+-Command/m.test(bat)) fail('scripts/distribute.bat runs PowerShell inline instead of a file.')
}
if (distributeSh && !/"\$script_dir\/dist\.sh"/.test(distributeSh)) {
  fail('scripts/distribute.sh does not call the dist.sh beside it ($script_dir/dist.sh).')
}

if (gitignore && !/^dist\/?$/m.test(gitignore)) {
  fail('.gitignore does not ignore dist/ - the distribution must never be committed.')
}

// ---------------------------------------------------------------------------
// 4. The workflow: the matrix, the same scripts, three operating systems
// ---------------------------------------------------------------------------
// PARKED, NOT DELETED FOREVER. `.github/workflows/distribute.yml` was removed on
// purpose for now (the push that removed it says so), so this file reads it
// OPTIONALLY: the section below is skipped LOUDLY rather than failing, and every
// assertion in it comes back the moment the workflow does. Restore it with
//   git log --diff-filter=D --name-only -- .github/workflows/distribute.yml
// and then `git checkout <sha>^ -- .github/workflows/distribute.yml`.
const workflowPath = '.github/workflows/distribute.yml'
const workflow = existsSync(path.join(repo, workflowPath)) ? readFileSync(path.join(repo, workflowPath), 'utf8') : null
if (workflow === null) {
  console.log('skip the workflow section                          (' + workflowPath + ' is parked - no CI for now)')
}
if (workflow) {
  // The matrix's own `os:` values, and nothing else. The comments above the
  // matrix name the retired labels on purpose - to record why they left - so a
  // plain text search over the file would fail on its own explanation.
  const matrixOs = [...workflow.matchAll(/^\s*-\s+os:\s*(\S+)\s*$/gm)].map((match) => match[1])
  if (matrixOs.length === 0) fail('.github/workflows/distribute.yml has no readable matrix of `- os:` entries.')

  // The labels a build MUST have. These are the images GitHub publishes today;
  // `macos-13` used to be here and was retired, which is the failure this list
  // exists to catch - a label that no longer resolves fails the whole run at
  // scheduling time, before any step can report why.
  for (const runner of ['windows-2022', 'macos-15-intel', 'macos-15', 'ubuntu-22.04']) {
    if (!matrixOs.includes(runner)) fail(`.github/workflows/distribute.yml does not build on ${runner}.`)
  }

  // ...and the labels it must NOT have, because GitHub has retired them. Naming
  // a dead image is not a style question: the run never starts.
  for (const retired of ['macos-13', 'macos-12', 'macos-11', 'windows-2019', 'ubuntu-20.04']) {
    if (matrixOs.includes(retired)) {
      fail(`.github/workflows/distribute.yml builds on '${retired}', a retired runner image.`)
    }
  }

  // The ARM64 legs produce artifacts no other leg can, and they are REQUIRED.
  // They were staged behind `experimental` / continue-on-error while the newer
  // toolchains settled; each has been green on every run since, and a leg that
  // may fail without failing the run is exactly how an ARM64 archive silently
  // stops appearing in a release. Making one optional again is a deliberate
  // two-file act - the workflow and this assertion.
  for (const arm of ['windows-11-arm', 'ubuntu-22.04-arm']) {
    if (!workflow.includes(arm)) {
      fail(`.github/workflows/distribute.yml no longer builds on ${arm}, so that ARM64 archive would silently stop shipping.`)
    }
  }
  if (/experimental:\s*true/.test(workflow) || /continue-on-error:/.test(workflow)) {
    fail('.github/workflows/distribute.yml marks a leg experimental / continue-on-error - every leg in this matrix is required now.')
  }

  for (const script of ['scripts/dist.ps1', 'scripts/dist.sh']) {
    if (!workflow.includes(script)) fail(`.github/workflows/distribute.yml never runs ${script}.`)
  }
  // The end-to-end check the local run also makes.
  if (!workflow.includes('-Verify')) fail('.github/workflows/distribute.yml does not run the end-to-end verify.')
  // Artifacts always; the workflow_dispatch trigger is how a run is inspected
  // without pushing a tag.
  if (!workflow.includes('workflow_dispatch')) fail('.github/workflows/distribute.yml has no workflow_dispatch trigger.')
  if (!workflow.includes('upload-artifact')) fail('.github/workflows/distribute.yml uploads no artifacts.')

  // The shell's unit tests are the ONLY thing that executes keystate.rs /
  // readyline.rs / windowstate.rs: the build legs run `cargo build --release`,
  // which runs no test, and every check in this repository reads the Rust as
  // TEXT. A workflow that never calls `cargo test` makes 56 passing tests
  // invisible to CI - which is what it was until this assertion existed.
  if (!workflow.includes('cargo test')) {
    fail('.github/workflows/distribute.yml never runs `cargo test` - the shell\'s unit tests would only ever run on a laptop.')
  }

  // A push gets a fast answer, not artifact churn: six archives uploaded per
  // push and expired unused. The upload is gated by event for exactly that.
  if (!workflow.includes("github.event_name != 'push'")) {
    fail('.github/workflows/distribute.yml does not gate its artifact upload by event - a push would upload archives nobody asked for.')
  }

  // The GitHub-official actions are pinned to a COMMIT, never to a tag. A tag is
  // mutable, so `@v4` is a pin a compromised release can move under this
  // repository; the comment beside each SHA records which major it is.
  const mutablePins = [...workflow.matchAll(/uses:\s*(actions\/[A-Za-z0-9_.-]+)@(?![0-9a-f]{40}\b)(\S+)/g)]
    .map((match) => `${match[1]}@${match[2]}`)
  if (mutablePins.length > 0) {
    fail(`.github/workflows/distribute.yml pins GitHub-official actions by a mutable ref (${mutablePins.join(', ')}) - pin the commit SHA and keep the major in a comment.`)
  }

  // --- every entry point that ships must be able to trigger a rebuild --------
  // The push filter is a list of paths, and a file missing from it means a change
  // to it builds nothing - silent, and only visible as a stale artifact later.
  // The list is read from the workflow's own `paths:` block, not re-typed.
  const pathsBlock = /^\s*paths:\s*\n((?:\s*-\s*'[^']+'\s*\n)+)/m.exec(workflow)
  const watched = pathsBlock
    ? pathsBlock[1].split(/\r?\n/).map((line) => /-\s*'([^']+)'/.exec(line)?.[1]).filter(Boolean)
    : []
  if (watched.length === 0) fail('.github/workflows/distribute.yml has no readable paths: filter.')
  // The launchers all live under scripts/ now, so ONE glob covers them; a push
  // that edits any of them has to build. `scripts/**` is therefore required.
  if (!watched.includes('scripts/**')) {
    fail(".github/workflows/distribute.yml's paths: filter does not watch 'scripts/**' - a change to a launcher would build nothing.")
  }
}

// ---------------------------------------------------------------------------
// 5. The console contract: one shared layer, five entry points, two hosts
// ---------------------------------------------------------------------------
// The entry points are the only files a person double-clicks, AND THEY ALL LIVE
// IN scripts/ - so the shared layer is `console\adapt.cmd` / `console/theme.*`
// NEXT TO THEM, not a folder away. The failure mode this section exists for is
// drift: a sixth launcher, or an edit to one of the five, that quietly stops
// asking the shared layer how to behave and starts deciding for itself.
// Everything below is a property that must hold in EVERY entry point, so it is
// asserted in a loop rather than five times by hand.
const consoleFiles = {
  adapt: 'scripts/console/adapt.cmd',
  themePs: 'scripts/console/theme.ps1',
  themeSh: 'scripts/console/theme.sh',
}
const consoleText = {}
for (const [key, file] of Object.entries(consoleFiles)) {
  consoleText[key] = read(file)
  if (consoleText[key] !== null && consoleText[key].trim().length === 0) fail(`${file} is empty.`)
}

const windowsEntries = ['scripts/install.bat', 'scripts/uninstall.bat', 'scripts/run-web.bat', 'scripts/run-desktop.bat', 'scripts/distribute.bat']
const posixEntries = ['scripts/install.sh', 'scripts/uninstall.sh', 'scripts/run-web.sh', 'scripts/distribute.sh']

for (const entry of windowsEntries) {
  const text = read(entry)
  if (text === null) continue

  // -NoTerminal is the LAUNCHER's flag: adapt.cmd above is the file that acts on
  // it, and not one Windows worker declares a parameter for it. PowerShell stops
  // on an argument it cannot bind, so a launcher that forwards it turns a
  // documented flag into a failed run - which is exactly what every one of them
  // did until this assertion existed.
  if (!/:-NoTerminal=%/.test(text)) {
    fail(`${entry} does not strip -NoTerminal before forwarding; its worker declares no such parameter, so the run would fail with a PowerShell parameter error.`)
  }

  // It must consult the shared layer - which sits BESIDE every one of them in
  // scripts/, so the path is `%~dp0console\adapt.cmd`...
  if (!text.includes('console\\adapt.cmd')) {
    fail(`${entry} does not call console\\adapt.cmd - its console behaviour is its own.`)
  }

  // ...using the documentation's exact three lines, in order.
  if (!/if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%\*"/.test(text)) {
    fail(`${entry} is missing the 'if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"' guard.`)
  }

  // The guard exists for ONE reason: after the Windows Terminal relaunch `%*` is
  // only the --from-terminal marker, so anything that forwards `%*` a second
  // time would replace the caller's real flags with it. Exactly one occurrence
  // of `%*` is therefore allowed, and it is the guard's.
  const stars = text.split('%*').length - 1
  if (stars !== 1) {
    fail(`${entry} mentions %* ${stars} times; only the VNCODE_ARGV guard may, or the relaunched run loses its flags.`)
  }

  // Flags are forwarded from VNCODE_ARGS, which is what the guard protects.
  if (!text.includes('%VNCODE_ARGS%')) {
    fail(`${entry} never forwards %VNCODE_ARGS% - it cannot be passing the real flags.`)
  }

  // The pause is a WINDOW decision owned by the shared layer.
  if (!/%VNCODE_PAUSE%/.test(text)) {
    fail(`${entry} ignores VNCODE_PAUSE - it would hold a scripted run open.`)
  }

  // The preflight failure the shared layer reports must be handled, not ignored.
  if (!/errorlevel 2/.test(text)) {
    fail(`${entry} does not handle adapt.cmd's exit 2 (no PowerShell on this machine).`)
  }
  if (!/errorlevel 10/.test(text)) {
    fail(`${entry} does not handle adapt.cmd's exit 10 (a Windows Terminal window owns the run).`)
  }

  // Every one of them answers help, whether by routing to a worker (-Help) or by
  // owning the text itself (run-desktop.bat, which has no worker).
  if (!/-Help/.test(text)) fail(`${entry} never mentions -Help.`)
}

// ---------------------------------------------------------------------------
// 5b. A NO-ARGUMENT run must not be able to abort a launcher
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS FOR, because nothing else here could see it. A double-click
// passes NO arguments, so the entry point's `set "VNCODE_ARGV=%*"` left the
// variable UNDEFINED - cmd removes a variable that is set to nothing - and cmd
// CANNOT expand a `:-flag=` substitution on an undefined variable. It emits the
// modifier as literal text instead, so the console layer's pause rule
//   if not "%VNCODE_ARGS:-NoPause=%"=="%VNCODE_ARGS%" set "VNCODE_PAUSE=0"
// became `if not "-NoPause=VNCODE_ARGS"=="VNCODE_ARGS" set ...` - an `if`
// with ONE token - which cmd answers with "set was unexpected at this time." and
// which aborts the whole file on the spot. Every Windows launcher therefore
// flashed a console and died having printed NOTHING when it was double-clicked,
// while every run WITH flags worked perfectly: and every check had only ever
// driven the flagged path, so nothing here could see it.
//
// An `if defined ...` on the same line cannot repair it: cmd expands every `%VAR%`
// on a line BEFORE it runs any of that line, so the garbage appears even inside a
// branch that is skipped (measured - the guard was tried first and the same line
// still aborted). The variable has to BE DEFINED, and scripts\console\adapt.cmd is
// where that happens: it stores "no arguments" as ONE SPACE, a defined value that
// holds no flag and that never reaches a child as an argument, so every
// substitution downstream reads the double-click exactly as it reads a flagged
// run.
//
// Asserted TWICE on purpose, because the static half alone cannot prove it: the
// normalisation must still be in adapt.cmd, AND calling adapt.cmd with no
// arguments must really come back with both names defined and no parse error. The
// second is the only test in this file that executes any of this.
if (consoleText.adapt) {
  if (!/if not defined VNCODE_ARGV set "VNCODE_ARGV= "/.test(consoleText.adapt)) {
    fail('scripts/console/adapt.cmd no longer stores "no arguments" as one space; on a double-click both argument variables are then UNDEFINED and cmd aborts the launcher with "set was unexpected at this time."')
  }
  if (!/set "VNCODE_ARGS=%VNCODE_ARGV%"/.test(code(consoleText.adapt))) {
    fail('scripts/console/adapt.cmd does not derive VNCODE_ARGS from VNCODE_ARGV.')
  }
  if (process.platform !== 'win32') {
    note('skipped the no-argument launcher run (cmd.exe only exists on Windows)')
  } else {
    // A DOUBLE-CLICK, reproduced: the documented three-line contract with nothing
    // in `%*`, then adapt.cmd, then whatever it left behind. VNCODE_NO_WT keeps
    // it from opening a Windows Terminal window, and the file lives in a temp
    // directory, so a check never touches the tree or the desktop.
    const probeDir = mkdtempSync(path.join(tmpdir(), 'vncode-args-'))
    const probe = path.join(probeDir, 'probe.bat')
    try {
      writeFileSync(probe, [
        '@echo off',
        'if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"',
        `call "${path.join(repo, 'scripts', 'console', 'adapt.cmd')}" "%~f0" "vncode"`,
        'if errorlevel 10 exit /b 0',
        'if errorlevel 2 exit /b 2',
        'echo ARGV=[%VNCODE_ARGV%]',
        'echo ARGS=[%VNCODE_ARGS%]',
        'echo PAUSE=[%VNCODE_PAUSE%]',
        'exit /b 0',
        '',
      ].join('\r\n'), 'ascii')
      const result = spawnSync('cmd.exe', ['/d', '/c', probe], {
        encoding: 'utf8',
        env: { ...process.env, VNCODE_NO_WT: '1' },
        windowsHide: true,
        timeout: 30000,
      })
      const output = `${result.stdout || ''}${result.stderr || ''}`
      if (/unexpected at this time/i.test(output)) {
        fail('a launcher with NO arguments aborts: cmd reports "set was unexpected at this time.", so an argument variable is undefined and a `%VAR:-flag=%` substitution cannot expand.')
      } else if (!/^ARGS=\[ \]$/m.test(output) || !/^ARGV=\[ \]$/m.test(output)) {
        fail(`calling scripts/console/adapt.cmd with no arguments did not leave one space in both argument variables; it answered: ${output.trim()}`)
      } else {
        note('a no-argument launcher run reaches the end of the console layer (the double-click path)')
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  }
}

for (const entry of posixEntries) {
  const text = read(entry)
  if (text === null) continue
  if (!text.includes('console/theme.sh')) {
    fail(`${entry} does not source scripts/console/theme.sh - its colour policy is its own.`)
  }
  // The POSIX half must never reach for PowerShell: that is a standing rule, and
  // it is about what the script RUNS, not about what its comments explain.
  if (/powershell|pwsh/i.test(code(text))) {
    fail(`${entry} runs PowerShell; the macOS/Linux half must never require it.`)
  }
}

// The sh workers must ACCEPT the entry points' flags. An unknown option is a
// hard error in all of them (exit 2), so a flag the entry forwards and the
// worker has never heard of breaks the run rather than being ignored. -NoTerminal
// is the sharpest case: it is a WINDOWS console decision, so on macOS/Linux it
// means nothing at all - and install.sh / START-HERE.sh still hand it straight
// through, which makes "accepted and ignored" the only correct answer. run-web.sh
// parses its own flags and is therefore its own worker, so it belongs here too.
for (const worker of ['scripts/install-all.sh', 'scripts/uninstall-all.sh', 'scripts/dist.sh', 'scripts/run-web.sh']) {
  const text = read(worker)
  if (text === null) continue
  for (const flag of ['-Help', '-NoPause', '-NoTerminal']) {
    if (!text.includes(flag)) fail(`${worker} does not accept ${flag}, which its entry point can forward.`)
  }
}

// The generated START-HERE.bat has to hold the same rule the hand-written
// launchers do, and it is emitted as TEXT by dist.ps1 - so the strip is asserted
// where it is written. Its POSIX twin needs no counterpart: START-HERE.sh hands
// the caller's flags to install-all.sh, which accepts the flag (above) instead of
// being shielded from it.
if (ps && !ps.includes('%VN_SHELL_ARGS:-NoTerminal=%')) {
  fail('scripts/dist.ps1 generates a START-HERE.bat that forwards -NoTerminal to install-all.ps1 / vncode.exe, neither of which declares it.')
}

// ...and the APP gets a third, narrower set again. -NoPause is the installer's
// own switch but NOT the shell's, and the shell names an unknown flag instead of
// ignoring it - so a generated START-HERE that handed -NoPause to vncode.exe
// would install the pack correctly and then report "vncode FAILED". That is
// measured, not hypothetical: it is what the first version of this assertion
// caught. run-desktop.bat drops the same flag for the same reason.
if (ps && !ps.includes('%VN_APP_ARGS:-NoPause=%')) {
  fail('scripts/dist.ps1 generates a START-HERE.bat that forwards -NoPause to vncode.exe, which does not declare it - the app would refuse to start.')
}
if (sh && !sh.includes('-NoPause|--no-pause|-NoTerminal|--no-terminal) ;;')) {
  fail('scripts/dist.sh does not filter the launcher-owned flags out of what its generated START-HERE.sh hands to ./vncode.')
}

// adapt.cmd MUST NOT use setlocal: its whole job is to leave VNCODE_PS,
// VNCODE_ARGS and VNCODE_PAUSE set for the caller, and setlocal would
// discard all three on return.
if (consoleText.adapt) {
  if (/^\s*setlocal\b/im.test(consoleText.adapt)) {
    fail('scripts/console/adapt.cmd uses setlocal - its decisions would vanish on return.')
  }
  // The relaunch marker is what stops an infinite window-opening loop.
  if (!consoleText.adapt.includes('VNCODE_CONSOLE')) {
    fail('scripts/console/adapt.cmd has no VNCODE_CONSOLE marker - the relaunch could loop.')
  }
  // A failed wt.exe must fall back to this console rather than losing the run.
  if (!/fellthrough|continuing in this window/i.test(consoleText.adapt)) {
    fail('scripts/console/adapt.cmd does not fall back when wt.exe fails to launch.')
  }
}

// theme.sh is sourced by scripts that run under dash and macOS sh, so bashisms
// are defects: `[[ ]]`, `function`, arrays and `local` outside a function would
// work on the machine of whoever wrote them and fail on somebody else's.
if (consoleText.themeSh) {
  const shCode = code(consoleText.themeSh)
  for (const [pattern, what] of [[/\[\[/, '[[ ]]'], [/^\s*function\s/m, 'the `function` keyword'], [/\$\{?[A-Za-z_]+\[@\]/, 'an array']]) {
    if (pattern.test(shCode)) fail(`scripts/console/theme.sh uses ${what}, which is not POSIX sh.`)
  }
}

// A launcher that exists but does not ship is a launcher nobody gets - and one
// that SHIPS but should not is the factory landing inside the product.
if (manifest) {
  const rules = parseManifest(manifest)
  const shipped = rules.filter((rule) => rule.kind === 'include').map((rule) => rule.path)
  const skippedPaths = rules.filter((rule) => rule.kind === 'skippath').map((rule) => rule.path)

  // Every launcher now lives under scripts/, so `include scripts` is what ships
  // it - and losing that one include would take the whole console layer, every
  // worker AND every entry point out of the archive at once.
  for (const entry of [...windowsEntries, ...posixEntries]) {
    if (!existsSync(path.join(repo, entry))) {
      fail(`${entry} is missing - it is one of the pack's entry points.`)
      continue
    }
    // The distributer is deliberately NOT shipped: it builds distributions, and
    // a distribution is the product, not the workshop.
    if (entry === 'scripts/distribute.bat' || entry === 'scripts/distribute.sh') continue
    if (!shipped.includes('scripts')) {
      fail(`dist-manifest.txt does not ship 'scripts' - the folder would have no ${entry}.`)
    }
  }

  // ...and the exclusions must be explicit, because `include scripts` would
  // otherwise sweep the whole workshop into every archive: the two distributer
  // workers and the two distributer entry points.
  for (const tool of ['scripts/dist.ps1', 'scripts/dist.sh', 'scripts/distribute.bat', 'scripts/distribute.sh']) {
    if (!skippedPaths.includes(tool)) {
      fail(`dist-manifest.txt does not exclude '${tool}' - the distributer would ship inside its own output.`)
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The single-file build: one container, three halves that must agree
// ---------------------------------------------------------------------------
// scripts/dist.ps1 writes it, scripts/dist.sh writes it, and
// app/src-tauri/src/payload.rs reads it. Nothing type-checks across that seam:
// the Rust tests build their own container by hand, and this check never runs
// either distributer. So the three are pinned against each other here.
//
// The magic is the sharpest of these, and it is not cosmetic. It is the ONLY
// thing that decides whether a file is a single-file build - there is no
// signature scan, on purpose, because the shell's own bytes can contain
// anything. A typo in one half therefore does not fail loudly: it turns every
// download into "this is an ordinary shell with no folder", which is a shell
// that starts nothing at all.
const payload = read('app/src-tauri/src/payload.rs')
const MAGIC = 'VNHRNS01'
const TAIL = 16
if (payload !== null) {
  if (!payload.includes(`b"${MAGIC}"`)) {
    fail(`app/src-tauri/src/payload.rs does not read the container magic "${MAGIC}".`)
  }
  // The reader takes the magic plus a u64 length off the end of the file, and
  // the producers append exactly that. The number lives in both; pin it.
  if (!payload.includes(`const TAIL_LEN: u64 = ${TAIL};`)) {
    fail(`app/src-tauri/src/payload.rs no longer reads a ${TAIL} byte tail, which is what the distributers append.`)
  }
  for (const key of ['zipStart', 'zipLen']) {
    if (!payload.includes(`"${key}"`)) {
      fail(`app/src-tauri/src/payload.rs does not read the trailer field "${key}".`)
    }
  }
}

for (const [name, text] of [['scripts/dist.ps1', ps], ['scripts/dist.sh', sh]]) {
  if (text === null) continue
  if (!text.includes(`'${MAGIC}'`)) {
    fail(`${name} never writes the container magic "${MAGIC}", so what it builds would not be a payload.`)
  }
  // The trailer's keys are a wire format between a PowerShell script, a POSIX
  // script and a Rust reader; each half naming them itself is the failure.
  for (const key of ['"zipStart"', '"zipLen"']) {
    if (!text.includes(key)) fail(`${name} does not write the trailer field ${key}.`)
  }
  // The self-check that catches a shell whose printf will not emit a NUL byte,
  // or a write that stopped short: the file must be exactly as long as its
  // three parts add up to.
  if (!text.includes(`+ ${TAIL}`) && !text.includes(`+ 16`)) {
    fail(`${name} does not check that the single-file build is as long as its parts add up to.`)
  }
}

// The single-file build sits BESIDE the folder, so its name has to differ from
// it: on unix the bare artifact name is already the directory's, which is why
// that half takes .run and not a name matching the folder.
if (ps !== null && !ps.includes("$script:OneFileSuffix = '.exe'")) {
  fail('scripts/dist.ps1 no longer names the Windows single-file build .exe.')
}
if (sh !== null && !sh.includes('$artifact.run')) {
  fail('scripts/dist.sh no longer names the unix single-file build .run - it would collide with the folder of the same name.')
}

// ---------------------------------------------------------------------------
// 7. The PowerShell installers never capture a native command's stderr
// ---------------------------------------------------------------------------
// Windows PowerShell 5.1 makes an ERROR RECORD out of every line a native
// command writes to stderr the moment that stderr is captured at all - `2>&1`
// and `2>$null` BOTH do it. With `2>&1` the record is printed as a full
// "At line:... CategoryInfo... FullyQualifiedErrorId : NativeCommandError"
// block, so npm's own deprecation warnings read as failures in a CI log; and
// under `$ErrorActionPreference = 'Stop'`, which both installers set at the top,
// the record is TERMINATING.
//
// That second half is the one that bites: the pnpm bootstrap sits under 'Stop'
// with no guard of its own, so a single `npm warn deprecated` would abort the
// install it was only informing about. Measured on Windows PowerShell 5.1, not
// assumed - `2>&1` throws there, while an unmerged call writes the same text as
// an ordinary line and leaves the exit code as the only verdict.
//
// `code()` drops the `#` lines, which matters here: the comments explaining this
// rule have to name the very token the rule is about.
for (const worker of ['scripts/install-all.ps1', 'scripts/uninstall-all.ps1']) {
  const text = read(worker)
  if (text === null) continue
  code(text)
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('2>&1')) {
        fail(
          `${worker}:${index + 1} merges a native command's stderr (${line.trim()}) - Windows PowerShell 5.1 turns that into a NativeCommandError, and under $ErrorActionPreference 'Stop' it is terminating.`
        )
      }
    })
  // The two calls that drive npm and npx, named so that an edit which adds the
  // redirect back is caught even if it is written differently.
  if (!/&\s*\$npm install[^\n]*\|\s*Out-Host/.test(text)) {
    fail(`${worker} no longer runs the pnpm bootstrap as a plain, unmerged native call.`)
  }
  if (!/&\s*\$npx --yes \$spec @Arguments \| Out-Host/.test(text)) {
    fail(`${worker} no longer runs dsh as a plain, unmerged native call.`)
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log('check-dist-layout: the ship list, the two halves, the entry points and the workflow')
for (const line of notes) console.log(`  - ${line}`)
if (failures.length > 0) {
  console.log('')
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`\ncheck-dist-layout: ${failures.length} problem(s).`)
  process.exit(1)
}
console.log('\ncheck-dist-layout: OK')
