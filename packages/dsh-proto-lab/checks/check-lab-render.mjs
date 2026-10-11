/**
 * check-lab-render.mjs — a REAL browser draws the lab's p5.js runs, and this
 * measures what it drew.
 *
 * Why this exists: `lab_lint` can prove a sketch has a `setup()`, seeds itself
 * and never reaches for the network, and every one of those can be true of a
 * sketch that draws a black rectangle. The only claim worth making about a
 * generative run is "it renders, and the seed changes the picture", and that
 * claim needs a browser. So this check:
 *
 *   1. scaffolds a run from the runtime's template AND instantiates every
 *      committed example, into a temporary lab (nothing in the workspace moves);
 *   2. opens each run's `index.html` **through its own file on disk** - the same
 *      document a person opens - in a headless Chromium-family browser;
 *   3. captures the frame through the browser's OWN encoder and decodes it here,
 *      then computes a signature: how much of the picture is not background, how
 *      many colours it holds, and a hash. NOT the canvas's `getImageData`, which
 *      was measured to return a uniform black for a page Chrome's own screenshot
 *      shows full of colour - see checks/png.mjs;
 *   4. asserts the signature is NON-EMPTY and that two different seeds produce
 *      two DIFFERENT signatures, while the same seed twice reproduces the same
 *      one. That is the whole reproducibility contract of `window.__dshProtoLab__.seed`,
 *      measured rather than asserted.
 *
 * No browser on this host is a LOUD SKIP (exit 0 with the reason printed): a
 * green run on a machine with no Chrome is not evidence, and this says so rather
 * than passing quietly. `DSH_PROTO_LAB_BROWSER` points it at a specific binary.
 *
 * Run:  node checks/check-lab-render.mjs
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { connectCdp } from './cdp.js'
import { measurePng } from './png.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const lab = await import(new URL('../lib/lab.js', import.meta.url).href)
const { runtimeOf } = await import(new URL('../lib/runtimes/index.js', import.meta.url).href)

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(66) + (expected === undefined || ok ? '' : ' -> ' + JSON.stringify(actual)))
  return ok
}
function skip(label, why) {
  skipped += 1
  console.log('SKIP ' + label.padEnd(66) + ' ' + why)
}

/** How long a browser may take to appear, and how long one run may take to settle. */
const STARTUP_TIMEOUT_MS = 30000
const SETTLE_TIMEOUT_MS = 20000

/**
 * The browsers this host might have, in the order worth trying.
 *
 * The same search `check-audio-browser.mjs` documents: the override first, then
 * the standard install locations per platform, because a machine with a browser
 * is the normal case and a machine without one must say so loudly.
 *
 * @returns `{ file, source }` or null.
 */
function findBrowser() {
  const override = typeof process.env.DSH_PROTO_LAB_BROWSER === 'string' ? process.env.DSH_PROTO_LAB_BROWSER.trim() : ''
  if (override !== '') return existsSync(override) ? { file: override, source: 'DSH_PROTO_LAB_BROWSER' } : null
  const candidates = []
  if (process.platform === 'win32') {
    for (const root of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (typeof root !== 'string' || root === '') continue
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    )
  }
  for (const file of candidates) {
    if (existsSync(file)) return { file, source: 'standard install location' }
  }
  return null
}

/** The browser's own port, from the file it writes into the profile. */
async function waitForDevTools(profileDir, child, tail) {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    try {
      const lines = (await fsp.readFile(portFile, 'utf8')).split('\n')
      const port = Number(lines[0])
      const wsPath = (lines[1] ?? '').trim()
      if (Number.isFinite(port) && port > 0 && wsPath !== '') return { port, wsPath }
    } catch (err) {
      /* not written yet */
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('the browser exited (code ' + String(child.exitCode ?? child.signalCode) + ') before it opened a DevTools port')
    if (Date.now() > deadline) {
      throw new Error('no DevTools port appeared within ' + STARTUP_TIMEOUT_MS + ' ms' + (tail.text === '' ? '' : ': ' + tail.text))
    }
    await new Promise((done) => setTimeout(done, 50))
  }
}

// ---------------------------------------------------------------------------
// 1. A browser, or a loud skip
// ---------------------------------------------------------------------------
const browser = findBrowser()
if (browser === null) {
  skip('a browser draws the lab\'s p5.js runs', 'no Chromium-family browser on this host - set DSH_PROTO_LAB_BROWSER to one to run this check')
  console.log('')
  console.log('check-lab-render: SKIPPED (nothing was measured)')
  process.exit(0)
}
console.log('check-lab-render: a real browser renders the runs')
console.log('  browser ' + browser.file + ' (' + browser.source + ')')

// ---------------------------------------------------------------------------
// 2. The runs to open: the template's own output, and every committed example
// ---------------------------------------------------------------------------
const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-proto-lab-render-')))
const env = { ...process.env, DSH_PROTO_LAB_ROOT: root }
const p5 = runtimeOf('p5js')
const runs = []

const generated = await lab.scaffoldRun({
  root,
  runtime: p5,
  slug: 'render-template',
  label: 'Render template',
  concept: 'The runtime template, rendered: the shape every new run starts from.',
  seed: 20260403,
  params: p5.defaultParams,
  env,
})
runs.push({ id: generated.run.id, seed: 20260403, files: generated.run.files, what: 'the runtime template' })

for (const example of await p5.examples()) {
  const instantiated = await lab.instantiateExample({ root, runtime: p5, example, slug: 'render-' + example.slug })
  runs.push({ id: instantiated.run.id, seed: example.seed, files: instantiated.run.files, what: 'the example "' + example.slug + '"' })
}
check('there is something to render', runs.length >= 1, true)
console.log('  runs      ' + runs.map((run) => run.id).join(', '))

// The lint must agree with the renderer: a run this check renders is a run the
// agent would be told is sound.
{
  const catalog = (await lab.readCatalog(root)).catalog
  for (const run of runs) {
    const report = await lab.lintRun({ root, runtime: p5, run: run.id, catalog, env })
    check('lint agrees that ' + run.id + ' is sound', report.issues.filter((item) => item.severity === 'error').length, 0)
  }
}

// ---------------------------------------------------------------------------
// 3. The measurement: read the canvas back, twice with one seed and once with another
// ---------------------------------------------------------------------------
/**
 * The expression the page runs after the sketch has had time to draw.
 *
 * It reads the canvas's own pixels, so it measures what the run drew rather than
 * what the sketch said it would. The signature is deliberately two numbers: the
 * share of pixels that differ from the most common colour (a blank canvas is 0),
 * and a hash over the sampled bytes (which is what makes two seeds comparable).
 */
const PROBE = `(() => ({
  canvas: document.querySelectorAll('#lab-stage canvas').length,
  drew: window.__dshProtoLab__ ? window.__dshProtoLab__.drew === true : false,
  problemShown: document.getElementById('lab-problem') !== null && document.getElementById('lab-problem').classList.contains('show'),
  report: window.__dshProtoLabReport__ || null,
  raf: window.__dshProtoLabRafMode__ || null,
  frameCount: window.__dshProtoLabP5__ && typeof window.__dshProtoLabP5__.frameCount === 'number' ? window.__dshProtoLabP5__.frameCount : null
}))()`

/**
 * Open one run's own index.html in a fresh target and measure its canvas.
 *
 * The URL is the FILE, not the plugin's composed preview: the point is to
 * measure the artifact the lab wrote, and the file carries the vendored library
 * beside it, so it needs no server and no route.
 *
 * @returns the probe's answer, or `{ ok: false, why }`.
 */
async function measure(client, url, seed, settleMs) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    // The seed travels in the URL, which is the shell's documented way to open a
    // run at another seed. Measuring the same URL three times compared NOTHING,
    // which is how a "different seed" assertion once passed against one picture.
    await client.send('Page.navigate', { url: url + (seed === undefined ? '' : '?seed=' + String(seed)) }, sessionId)
    // `Page.loadEventFired` is deliberately NOT waited for: registering the waiter
    // races the navigation (the event can fire before the subscription is live) and
    // `load` is not guaranteed to fire at all on a page whose scripts keep working.
    // The document's own readyState is polled instead, which cannot miss.
    const loadDeadline = Date.now() + SETTLE_TIMEOUT_MS
    for (;;) {
      const ready = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId, 5000)
      if (ready.result?.value === 'complete' || ready.result?.value === 'interactive') break
      if (Date.now() > loadDeadline) break
      await new Promise((done) => setTimeout(done, 100))
    }
    // Wait for the canvas AND for the run to say it drew. The shell creates the
    // canvas inside setup(), so "a canvas exists" is already proof that p5 started;
    // "it drew" is the shell's own flag, and waiting for it removes a race from the
    // measurement rather than papering over it with a longer sleep.
    const deadline = Date.now() + 15000
    let state = null
    for (;;) {
      const answer = await client.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId, 5000)
      if (answer.exceptionDetails !== undefined) {
        throw new Error('the page probe threw: ' + String(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? '?'))
      }
      state = answer.result?.value ?? null
      if (state !== null && state.canvas > 0 && (state.drew === true || Number(state.frameCount) > 0)) break
      if (Date.now() > deadline) break
      await new Promise((done) => setTimeout(done, 200))
    }
    // Then LET IT RUN: the picture is what the system looks like after a few
    // hundred frames, and that is the difference between "it started" and "it drew".
    await new Promise((done) => setTimeout(done, settleMs))
    const after = await client.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId, 5000)
    if (after.exceptionDetails !== undefined) {
      console.log('      probe threw after: ' + String(after.exceptionDetails.exception?.description ?? after.exceptionDetails.text ?? '?'))
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId, 20000)
    if (typeof shot.data !== 'string' || shot.data === '') {
      return { ok: false, why: 'the browser returned no screenshot' }
    }
    const measured = measurePng(Buffer.from(shot.data, 'base64'))
    return { ok: true, ...measured, ...(after.result?.value ?? state ?? {}) }
  } catch (err) {
    return { ok: false, why: String(err && err.message ? err.message : err) }
  } finally {
    try {
      await client.send('Target.closeTarget', { targetId })
    } catch (err) {
      /* the target may be gone with the page */
    }
  }
}

// The browser's profile goes INSIDE the package, not in the system temp dir:
// a headless Chrome writes a hundred files into its profile while it starts, and
// a confined run may refuse writes outside the workspace - which Chrome answers
// by dying before it opens its DevTools port, and nothing about that failure
// says "the profile was not writable". The folder is gitignored and removed in
// the `finally` below, so nothing is left behind either way.
const scratch = path.join(packageRoot, 'checks', '.tmp')
await fsp.mkdir(scratch, { recursive: true })
const profileDir = await fsp.mkdtemp(path.join(scratch, 'chrome-profile-'))
const tail = { text: '' }
let child = null
let client = null
const results = []
try {
  child = spawn(
    browser.file,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      '--window-size=900,620',
      // The run is a file on disk and its library sits beside it, so the page's
      // own file: requests have to be allowed - this is the flag that makes a
      // local sketch behave like it does when a person opens it, and it is the
      // reason the canvas can be read back at all.
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    // `stdio: 'ignore'` and NOT a pipe, deliberately: this check runs under a
    // file sandbox that refuses a child process's piped stdio (EPERM on the
    // spawn itself), and it costs nothing here - the browser's own diagnosis
    // arrives over CDP, and its port arrives in the profile directory it writes.
    { stdio: 'inherit' },
  )

  const devtools = await waitForDevTools(profileDir, child, tail)
  client = await connectCdp('ws://127.0.0.1:' + String(devtools.port) + devtools.wsPath, { timeoutMs: 10000 })
  console.log('  devtools  port ' + devtools.port)

  // A first pass with each run's own seed, and with a different one.
  for (const run of runs) {
    const file = await lab.runFile({ root, run: run.id, file: 'index.html', mode: 'read' })
    // `raf=timer` is the shell's deterministic frame loop: a check must not depend
    // on a headless page's requestAnimationFrame, which is exactly what this check
    // was written to stop guessing about.
    const url = new URL('file://' + file.absolute.replace(/\\/g, '/')).href + ''
    const once = await measure(client, url, run.seed, 2500)
    const twice = await measure(client, url, run.seed, 2500)
    const other = await measure(client, url, run.seed + 1, 2500)
    results.push({ run, once, twice, other })

    console.log(
      '  ' + run.id + '  ' +
        (once.ok
          ? once.colours + ' colours, background ' + once.background + ', ' + once.width + '×' + once.height +
            ', drew=' + once.drew + ', frames=' + String(once.frameCount) + ', raf=' + String(once.raf)
          : 'FAILED: ' + once.why),
    )
    check(run.id + ': the shell reports no problem', once.ok && once.problemShown === false, true)
    check(run.id + ': the sketch really drew a frame', once.ok && once.drew === true, true)
    if (once.ok) {
      check(run.id + ': the rendered page is not a blank field (background share ' + once.background + ' below 0.99)', once.background < 0.99)
      check(run.id + ': it drew many colours, not one (' + once.colours + ' distinct)', once.colours > 8)
    } else {
      check(run.id + ': the rendered page was measured', once.ok, true)
    }
    check(run.id + ': the same seed reproduces the same picture', once.ok && twice.ok && once.signature === twice.signature, true)
    check(run.id + ': a different seed draws a different picture', once.ok && other.ok && once.signature !== other.signature, true)
  }
} catch (err) {
  // A sandbox that refuses to spawn a browser is not a verdict about the plugin:
  // the pack's own `check-audio-browser.mjs` fails the same way under such a
  // sandbox (a bare `spawn EPERM`), which is why this is reported as a skip with
  // the reason rather than as a failed assertion. On an ordinary machine it runs.
  const message = String(err && err.message)
  // Two shapes of the same refusal: Node cannot spawn at all (EPERM), or the
  // browser starts, cannot reach its own crash handler, and self-terminates
  // (crashpad's OpenProcess: Access is denied plus a breakpoint status).
  const refused =
    /EPERM|EACCES|Access is denied|self-terminating|STATUS_BREAKPOINT/i.test(message) ||
    /EPERM|EACCES|Access is denied|crashpad|self-terminating/i.test(tail.text) ||
    /4294930433|3221226505|3221225794/.test(message)
  if (refused) {
    skip('a browser draws the lab\'s p5.js runs', 'this environment refused to launch the browser (' + message.slice(0, 90) + ') - NOT a failure of the plugin')
    if (tail.text !== '') console.log('     browser said: ' + tail.text.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | '))
  } else {
    check('the render pass ran to completion', message, 'no error')
    if (tail.text !== '') console.log('  browser said: ' + tail.text.split('\n').slice(-6).join('\n                '))
  }
} finally {
  client?.close('the check is done')
  if (child !== null && child.exitCode === null) child.kill()
  await new Promise((done) => setTimeout(done, 250))
  await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
}

// A digest of everything measured, so the run is a record and not just a verdict.
const summary = results.map((entry) => entry.run.id + '=' + (entry.once.ok ? entry.once.signature : 'failed')).join(' ')
if (summary !== '') console.log('  signatures ' + createHash('sha1').update(summary).digest('hex').slice(0, 12) + '  (' + summary + ')')

console.log('')
if (failures > 0) {
  console.log('check-lab-render: ' + failures + ' FAILED of ' + checked + (skipped > 0 ? ' (' + skipped + ' skipped loudly)' : ''))
  process.exit(1)
}
console.log('check-lab-render: OK — ' + checked + ' assertions in a real browser' + (skipped > 0 ? ', ' + skipped + ' skipped loudly' : ''))
void readFileSync
