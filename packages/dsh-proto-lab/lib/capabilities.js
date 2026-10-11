/**
 * dsh-proto-lab — the capability model: what can be verified HERE, how deeply,
 * and what that costs.
 *
 * A prototyping lab spans two worlds that are verified in completely different
 * ways. A p5.js run is proved by a BROWSER drawing it; an openFrameworks run is
 * proved by a COMPILER accepting it. Neither proof exists everywhere, and the
 * failure this file exists to prevent is the quiet one: a check that reports
 * "sound" about a run nothing ever ran.
 *
 * So verification is organised as an ordered list of TIERS, deepest last. A tier
 * is a claim, and the claim is always stated with the tier that made it:
 *
 *   t0 structure   the source is read and judged by its own runtime, offline,
 *                  with no toolchain at all. Every host, always.
 *   t1 parse       the language's own parser accepts the source - `node --check`
 *                  for JavaScript, `g++ -fsyntax-only` for C++. Needs a compiler,
 *                  not a library.
 *   t2 compile     the source builds against the RUNTIME'S OWN library, which is
 *                  the strongest claim available without running anything. Needs
 *                  the toolchain AND the framework installed.
 *   t3 render      the run actually draws: a real browser for a p5.js run (or for
 *                  anything that draws a page), a real window for a native run.
 *                  Needs a graphics stack and, on a server, a virtual display.
 *   t4 measure     the drawing is measured - pixels read back, a signature
 *                  compared across two seeds, a frame cost sampled - which is the
 *                  only tier that can answer "did the seed change the picture".
 *
 * Three rules hold the model together, and each is a bug this package will not
 * ship:
 *
 *   - **A tier that did not run is reported as not run.** Never as a pass. The
 *     answer names the tier, what it would have needed, and how to provide it.
 *   - **Deeper is slower and rarer.** t3/t4 spawn a browser or a window and take
 *     seconds; t0/t1 take milliseconds. The default answer is therefore the
 *     DEEPEST TIER THE HOST CAN SUPPORT, not the deepest tier that exists, and a
 *     caller who wants to wait asks for it explicitly (`lab_runtimes` `deep`).
 *   - **The host decides.** A tier is available because its precondition was
 *     FOUND on this machine, never because the platform is usually able to.
 *
 * MEMORY AND SPEED
 *
 * The same model carries the two practical constraints of a prototyping machine.
 * `machine()` reads what this host actually has (cores, memory, a browser, a
 * compiler) and the runtimes adapt their generated defaults to it - a container
 * with 2 GB of RAM gets a smaller population in `params` than a workstation with
 * 32 GB, because the alternative is a prototype that is born stuttering. And a
 * run that is meant to be QUICK states its budget: `lab_lint` reports what it can
 * see of it (an allocation inside a draw loop, a population past the host's own
 * comfort), and this module publishes the numbers those warnings are about.
 */

import { spawnSync } from 'node:child_process'
import os from 'node:os'

/** The tiers, shallowest first. `id` is what an answer names. */
export const TIERS = [
  {
    id: 't0-structure',
    label: 'Structure',
    claim: 'the source is read and judged by its own runtime',
    needs: [],
    cost: 'milliseconds',
    always: true,
  },
  {
    id: 't1-parse',
    label: 'Parse',
    claim: 'the language\'s own parser accepts the source',
    needs: ['a compiler or interpreter for the language'],
    cost: 'milliseconds',
  },
  {
    id: 't2-compile',
    label: 'Compile',
    claim: 'the source builds against the framework\'s own library',
    needs: ['a compiler', 'the framework installed'],
    cost: 'seconds',
  },
  {
    id: 't3-render',
    label: 'Render',
    claim: 'the run actually draws a frame',
    needs: ['a browser (web) or a window and a graphics stack (native)'],
    cost: 'seconds',
  },
  {
    id: 't4-measure',
    label: 'Measure',
    claim: 'the drawing is measured: pixels read back, two seeds compared',
    needs: ['everything t3 needs', 'a canvas whose pixels can be read'],
    cost: 'tens of seconds',
  },
]

/** One tier by id. */
export function tierOf(id) {
  return TIERS.find((tier) => tier.id === id) ?? null
}

/** The tiers a set of ids implies, in order (a tier needs everything below it). */
export function throughTier(id) {
  const index = TIERS.findIndex((tier) => tier.id === id)
  return index === -1 ? [] : TIERS.slice(0, index + 1)
}

/**
 * What this machine actually is.
 *
 * Read once per call from the platform's own answers - `os.cpus()`, `os.totalmem()`
 * - plus two cheap probes: is there a C++ compiler on PATH, and is there a
 * Chromium-family browser where the platform keeps one. Nothing here launches
 * anything.
 *
 * The two derived numbers are the ones the runtimes use:
 *
 *   - `tier` is the DEEPEST verification this host can perform at all, which is
 *     what `lab_runtimes` reports and what a check compares itself against.
 *   - `scale` is a coarse 0..1 size for generated defaults. It exists so that a
 *     2-core / 2 GB container does not get the same particle count as a 32-core
 *     workstation: a prototype that stutters on the machine it was written for is
 *     a prototype nobody can read.
 *
 * @param options - `{ env, platform }`.
 * @returns `{ platform, arch, cores, memoryGiB, compilers, browser, tier, scale, notes }`.
 */
export async function machine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cores = Math.max(1, os.cpus()?.length ?? 1)
  const memoryGiB = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10
  const notes = []

  // The C++ side. `c++`/`g++`/`clang++`/`cl` are the four names that answer on the
  // platforms this pack supports, and the probe is careful about ONE distinction
  // that matters more than the version string: a compiler that is not installed
  // and a compiler this process is not ALLOWED to run are different facts, and
  // reporting the second as the first is the quiet lie this whole module exists
  // to prevent (measured: a confined run gets `EPERM` from `spawnSync('g++')` on
  // a machine where g++ is installed and works in a terminal).
  const compilers = []
  for (const name of [env.CXX, 'c++', 'g++', 'clang++', 'cl'].filter((value) => typeof value === 'string' && value !== '')) {
    const where = await which(name, env)
    if (where === null) continue
    const found = spawnSync(name, name === 'cl' ? [] : ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const blocked = found.error !== undefined && (found.error.code === 'EPERM' || found.error.code === 'EACCES')
    const version = blocked
      ? 'version unknown - this process may not run it'
      : String(found.stdout ?? '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '') ?? 'version not reported'
    compilers.push({ name, file: where, version: version.slice(0, 80), runnable: !blocked })
    if (blocked) notes.push(name + ' is on PATH at ' + where + ' but this process is not allowed to run it (EPERM): compilation will be attempted and will report the refusal rather than pretending it passed')
    break
  }

  // The browser: checked for EXISTENCE only. Launching one is the expensive part
  // and belongs to the caller that wants tier 3, not to a capability report.
  const browser = await findBrowser({ env, platform })
  if (browser !== null) notes.push('browser: ' + browser.file + ' (' + browser.source + ')')
  else notes.push('browser: none found - a p5.js run can be written but not rendered or measured here')

  const tier = browser !== null ? 't4-measure' : compilers.length > 0 ? 't2-compile' : 't0-structure'
  // A coarse comfort scale: enough memory and cores for a few thousand particles
  // with room for the browser itself.
  const scale = Math.max(0.25, Math.min(1, Math.min(cores / 8, memoryGiB / 8)))
  if (memoryGiB < 4) notes.push('low memory (' + memoryGiB + ' GiB): generated populations are scaled down to ' + Math.round(scale * 100) + '%')

  // What the CONFINEMENT denies, as opposed to what the machine lacks. This is
  // the difference between "your machine cannot render" and "this process may not
  // start a browser", and only the second one is worth telling a user to re-run
  // outside the sandbox.
  const blocked = []
  if (compilers.length > 0 && compilers[0].runnable === false) blocked.push('compilers (a child process is refused: EPERM)')
  if (browser !== null) {
    // Not launched here - that is tier 3's cost - but the ladder must not claim a
    // tier whose first step is a spawn when every spawn has been refused.
    const probe = spawnSync(browser.file, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const denied = probe.error !== undefined && (probe.error.code === 'EPERM' || probe.error.code === 'EACCES')
    if (denied) {
      blocked.push('the browser (a child process is refused: EPERM)')
      notes.push('a browser is installed but this process may not launch it: tier 3/4 needs an unconfined run')
    }
  }

  return { platform, arch: process.arch, cores, memoryGiB, compilers, browser, tier, scale, blocked, notes }
}

/**
 * Where one executable is, without running it.
 *
 * The second half of the not-installed / not-allowed distinction above: the
 * filesystem is asked whether the binary EXISTS before a process is spawned,
 * because existence is answerable cheaply and under any confinement.
 *
 * @param name - the executable's name (or a path).
 * @param env - the environment (`PATH`, `PATHEXT`).
 * @returns the resolved file, or null.
 */
export async function which(name, env = process.env) {
  const fsp = await import('node:fs/promises')
  const path = (await import('node:path')).default
  const extensions = process.platform === 'win32' ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((value) => value !== '') : ['']
  const candidates = []
  if (name.includes('/') || name.includes('\\')) {
    candidates.push(name)
  } else {
    for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
      if (directory === '') continue
      for (const extension of extensions) candidates.push(path.join(directory, name + (path.extname(name) === '' ? extension.toLowerCase() : '')))
      candidates.push(path.join(directory, name))
    }
  }
  for (const candidate of candidates) {
    const ok = await fsp
      .stat(candidate)
      .then((stat) => stat.isFile())
      .catch(() => false)
    if (ok) return candidate
  }
  return null
}

/**
 * Run one program with an argv array, and distinguish the four outcomes that
 * matter instead of collapsing them into `status !== 0`.
 *
 * `blocked` is the one this exists for. A confined process is refused a child
 * (`EPERM` on the spawn itself) and the compiler it could not run is still
 * installed; reporting that as "the source does not compile" would be a wrong
 * answer about the user's code, and reporting it as a pass would be a wrong
 * answer about the work. So it is its own outcome, and every caller states it.
 *
 * @param options - `{ file, args, cwd, timeoutMs }`.
 * @returns `{ ok, blocked, status, output, reason }`.
 */
export function runProcess(options) {
  const args = Array.isArray(options.args) ? options.args : []
  const found = spawnSync(options.file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 120_000,
  })
  const code = found.error === undefined ? null : String(found.error.code ?? '')
  if (code === 'EPERM' || code === 'EACCES') {
    return { ok: false, blocked: true, status: null, output: '', reason: 'this process is not allowed to run ' + options.file + ' (' + code + ')' }
  }
  if (found.error !== undefined) {
    return { ok: false, blocked: false, status: null, output: '', reason: String(found.error.message ?? found.error) }
  }
  return {
    ok: found.status === 0,
    blocked: false,
    status: found.status,
    output: String(found.stdout ?? '') + String(found.stderr ?? ''),
    reason: found.status === 0 ? '' : 'the program exited with ' + String(found.status),
  }
}

/**
 * The Chromium-family browser this host has, if any.
 *
 * The same search the render check documents, minus the launch: this is a
 * capability report, so it must stay cheap. `DSH_PROTO_LAB_BROWSER` is the
 * override for a machine that keeps its browser somewhere unusual.
 *
 * @param options - `{ env, platform }`.
 * @returns `{ file, source }` or null.
 */
export async function findBrowser(options = {}) {
  const fsp = await import('node:fs/promises')
  const path = (await import('node:path')).default
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const override = typeof env.DSH_PROTO_LAB_BROWSER === 'string' ? env.DSH_PROTO_LAB_BROWSER.trim() : ''
  if (override !== '') {
    const ok = await fsp
      .stat(override)
      .then((stat) => stat.isFile())
      .catch(() => false)
    return ok ? { file: override, source: 'DSH_PROTO_LAB_BROWSER' } : null
  }
  const candidates = []
  if (platform === 'win32') {
    // `ProgramFiles` is often NOT in the environment a process is handed (measured
    // under this pack's own harness: `env['PROGRAMFILES']` is undefined while
    // `Path` is present), so the two standard roots are spelled out as well.
    // Missing a browser that is right there would cost the whole t3/t4 ladder.
    const roots = [
      env['PROGRAMFILES'],
      env['PROGRAMFILES(X86)'],
      env.LOCALAPPDATA,
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      env.SystemDrive === undefined ? 'C:' : String(env.SystemDrive) + '\\',
    ].filter((root) => typeof root === 'string' && root !== '')
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const file of candidates) {
    const ok = await fsp
      .stat(file)
      .then((stat) => stat.isFile())
      .catch(() => false)
    if (ok) return { file, source: 'standard install location' }
  }
  return null
}

/**
 * The numbers a "quick app" is judged against, in one place.
 *
 * A frame at 60 Hz is 16.7 ms and there is no arguing with that; a population
 * that costs more than a few milliseconds a frame is a population that will not
 * hold 60 fps on a laptop. Publishing them here rather than scattering them
 * through the runtimes is what lets a lint message quote the same number the
 * skill teaches.
 */
export const BUDGETS = {
  /** One frame at 60 Hz. */
  frameMs: 1000 / 60,
  /** Above this, a generated population is reported as "check the frame cost". */
  comfortableParticles: 6000,
  /** Above this, a p5.js run is drawing something a person will feel. */
  heavyParticles: 20000,
  /** The population a low-memory host is scaled down to. */
  lowMemoryParticles: 1200,
}
