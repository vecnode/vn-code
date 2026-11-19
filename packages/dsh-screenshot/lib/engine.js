/**
 * dsh-screenshot — a page, captured.
 *
 * One pipeline: a throwaway Chrome/Edge on the host, driven over CDP, asked for
 * ONE picture at ONE size. Everything about the picture is decided before the
 * engine starts - viewport, device scale, colour scheme, full page or one
 * element - because a screenshot is not a render you can re-measure afterwards:
 * what was captured is what the file holds.
 *
 * The two rules that keep this honest:
 *
 *   - **loopback and workspace files by default; a public page only when the
 *     caller says so.** The resolver maps every name to NOTFOUND except
 *     loopback, so a local dev server renders and a remote font or CDN script
 *     does not, and nothing leaves the machine. A remote target is the ONE thing
 *     that needs `allowRemote`, and then the engine gets the real network - which
 *     is why the answer always states which mode it ran in.
 *   - **the size is read back out of the file, never assumed.** `Page.captureScreenshot`
 *     is asked for a clip; the PNG's own IHDR is what the answer reports. A
 *     device-scale factor that did not apply shows up as a smaller picture
 *     instead of a silent lie.
 *
 * The profile is throwaway (a fresh `--user-data-dir` per capture, deleted
 * afterwards) and the process is killed by pid - never by name. The engine is
 * never disarmed: no `--no-sandbox`, no `--disable-web-security`, no
 * `--ignore-certificate-errors`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { connectCdp } from './cdp.js'

/** Startup and total budgets: a capture that hangs must not hold the session. */
export const STARTUP_TIMEOUT_MS = 20000
export const CAPTURE_TIMEOUT_MS = 45000
/** The largest viewport a call may ask for, in CSS pixels. */
export const MAX_VIEWPORT = 4096
/** The ceiling on a full-page capture: Chrome's own texture limit is 16384. */
export const MAX_CAPTURE_HEIGHT = 12000
/** The pixel ceiling on one picture, so a full page cannot exhaust memory. */
export const MAX_CAPTURE_PIXELS = 40_000_000
/** How long a page may take to deliver its images before the shot is taken. */
export const IMAGE_SETTLE_MS = 6000

/**
 * The sizes a screenshot is usually wanted at. `og` is the 1200x630 card and
 * `square` the 1080 grid tile, because those two are why people screenshot a
 * page for a README in the first place.
 */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
  og: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
}

/** Where a browser might be, per platform, before PATH is consulted. */
export function engineCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((value) => typeof value === 'string' && value !== '')
    const out = []
    for (const root of roots) {
      out.push({ file: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' })
      out.push({ file: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' })
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      { file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
      { file: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
    ]
  }
  return [
    { file: '/usr/bin/google-chrome', kind: 'chrome' },
    { file: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { file: '/usr/bin/chromium', kind: 'chromium' },
    { file: '/usr/bin/chromium-browser', kind: 'chromium' },
    { file: '/usr/bin/microsoft-edge', kind: 'edge' },
  ]
}

function onPath(names, env, platform) {
  const dirs = String(env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((value) => value !== '')
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * The browser this host has, or `null`. Resolved once per capture, never cached:
 * a person who installs Chrome mid-session should not have to restart.
 */
export function resolveEngine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const override = env.DSH_SCREENSHOT_ENGINE
  if (typeof override === 'string' && override !== '' && existsSync(override)) return { file: override, kind: 'override', source: 'DSH_SCREENSHOT_ENGINE' }
  for (const candidate of engineCandidates(platform, env)) {
    if (existsSync(candidate.file)) return { ...candidate, source: 'install' }
  }
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const found = onPath(names, env, platform)
  if (found !== null) return { file: found, kind: 'path', source: 'PATH' }
  return null
}

/**
 * The engine's argv: headless, one throwaway profile, and - unless the caller
 * asked for a remote page - a resolver that fails every name but loopback.
 *
 * `--force-device-scale-factor` is what makes a `dpr: 2` capture a real retina
 * picture rather than a bigger CSS viewport; the emulation override below sets
 * the same number per shot, and the two must agree or the file is smaller than
 * asked for (the answer reports the file's own size, so that cannot hide).
 */
export function buildArgs({ profileDir, width, height, dpr = 1, allowRemote = false }) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--window-size=' + String(width) + ',' + String(height),
    '--force-device-scale-factor=' + String(dpr),
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-gpu',
    '--incognito',
    'about:blank',
  ]
  if (!allowRemote) {
    // Every name fails except loopback: a local dev server renders, a remote
    // font or CDN script does not, and nothing leaves this machine.
    args.splice(3, 0, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]')
  }
  return args
}

/** Parse a `DevToolsActivePort` file: the port on line 1, the ws path on line 2. */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const port = Number(lines[0])
  const wsPath = (lines[1] ?? '').trim()
  if (!Number.isFinite(port) || port <= 0 || wsPath === '') return null
  return { port, wsPath }
}

async function waitForDevTools(profileDir, child) {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    try {
      const parsed = parseDevToolsActivePort(await fsp.readFile(portFile, 'utf8'))
      if (parsed !== null) return parsed
    } catch (err) {
      // not written yet
    }
    if (Date.now() > deadline) {
      const why = child.exitCode !== null ? 'the launched process exited (code ' + String(child.exitCode) + ') and no DevTools port appeared' : 'no DevTools port appeared'
      throw new Error(why + ' within ' + String(STARTUP_TIMEOUT_MS) + ' ms')
    }
    await new Promise((done) => setTimeout(done, 60))
  }
}

/** Kill one pid tree, by pid only. */
export function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err2) {
      /* already gone */
    }
  }
}

/** Read a png's real size from its own IHDR, never from the request. */
export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Clamp a requested viewport to something a screenshot can hold. */
export function viewportFor(input = {}) {
  const preset = typeof input.viewport === 'string' ? VIEWPORTS[input.viewport] : undefined
  const width = Number(input.width ?? preset?.width ?? VIEWPORTS.desktop.width)
  const height = Number(input.height ?? preset?.height ?? VIEWPORTS.desktop.height)
  return {
    width: Math.max(240, Math.min(MAX_VIEWPORT, Math.round(Number.isFinite(width) ? width : VIEWPORTS.desktop.width))),
    height: Math.max(240, Math.min(MAX_VIEWPORT, Math.round(Number.isFinite(height) ? height : VIEWPORTS.desktop.height))),
    dpr: Math.max(1, Math.min(3, Number(input.dpr ?? 1) || 1)),
  }
}

/** The in-page box of one selector, in CSS pixels, with a reason when it is absent. */
function boxInPage(selector) {
  return `(() => {
    let el = null
    try { el = document.querySelector(${JSON.stringify(selector)}) } catch (err) { return { error: 'that is not a valid CSS selector: ' + String(err && err.message) } }
    if (el === null) return { error: 'no element matches this selector' }
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { error: 'the element has no box (' + rect.width + 'x' + rect.height + '); it may be display:none' }
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }
  })()`
}

/**
 * One capture, end to end.
 *
 * @param options - `{ engine, url, width, height, dpr, dark, fullPage, clip, settleMs, allowRemote, outPath, deadlineMs, logger }`.
 * @returns `{ ok, png, size, title, finalUrl, clipped, blank, note, timingMs }`, or `{ ok: false, code, message }`.
 */
export async function capturePage(options) {
  const engine = options.engine
  if (!engine) {
    return {
      ok: false,
      code: 'NO_ENGINE',
      message:
        'No Chromium-family browser on this host, so there is nothing to capture with. Install Google Chrome or Microsoft Edge, or point DSH_SCREENSHOT_ENGINE at the executable. A desktop window does not need one - that is `shot_window`.',
    }
  }
  const width = options.width
  const height = options.height
  const dpr = options.dpr ?? 1
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : CAPTURE_TIMEOUT_MS
  const settleMs = Number.isFinite(options.settleMs) ? Math.max(0, Math.min(15000, options.settleMs)) : 400
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-screenshot-'))
  const args = buildArgs({ profileDir, width, height, dpr, allowRemote: options.allowRemote === true })
  const child = spawn(engine.file, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
  const started = Date.now()
  let client = null
  try {
    const { port, wsPath } = await waitForDevTools(profileDir, child)
    client = await connectCdp('ws://127.0.0.1:' + String(port) + wsPath, { timeoutMs: 10000 })
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: width < 600 }, sessionId)
    if (options.dark !== undefined) {
      await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: options.dark === true ? 'dark' : 'light' }] }, sessionId)
    }
    const loaded = client.waitFor('Page.loadEventFired', { sessionId, timeoutMs: Math.min(20000, deadlineMs) })
    await client.send('Page.navigate', { url: options.url }, sessionId)
    let note = ''
    try {
      await loaded
    } catch (err) {
      // A page that never fires load is still worth a picture: the shot is what
      // it looks like NOW, and the note says the load event never arrived.
      note = 'the load event never fired; the picture is the page as it stood at the deadline'
    }
    // Fonts settle after load, and so do images: a shot taken before either is a
    // picture of fallback fonts and empty boxes.
    await client.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(() => true) : true', awaitPromise: true, returnByValue: true }, sessionId)
    await client.send(
      'Runtime.evaluate',
      {
        expression:
          'Promise.race([' +
          '  Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((done) => { i.addEventListener("load", done, { once: true }); i.addEventListener("error", done, { once: true }); setTimeout(done, ' +
          String(IMAGE_SETTLE_MS) +
          ') }))),' +
          '  new Promise((done) => setTimeout(done, ' +
          String(IMAGE_SETTLE_MS) +
          ')),' +
          ']).then(() => true)',
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )
    if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs))

    const facts = await client.send(
      'Runtime.evaluate',
      {
        expression:
          '({ title: document.title || "", url: location.href, text: document.body ? document.body.innerText.length : 0, elements: document.body ? document.body.querySelectorAll("*").length : 0 })',
        returnByValue: true,
      },
      sessionId,
    )
    const page = facts && facts.result ? facts.result.value : null

    let clip = null
    let clipped = false
    if (typeof options.clip === 'string' && options.clip !== '') {
      const measured = await client.send('Runtime.evaluate', { expression: boxInPage(options.clip), returnByValue: true }, sessionId)
      const box = measured && measured.result ? measured.result.value : null
      if (!box || box.error) return { ok: false, code: 'NO_ELEMENT', message: 'Nothing to clip to: ' + (box && box.error ? box.error : 'the selector measured nothing') + '. The page is otherwise fine; drop `clip` for the whole viewport.', page }
      clip = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: Math.max(1, Math.ceil(box.width)), height: Math.max(1, Math.ceil(box.height)), scale: 1 }
    } else if (options.fullPage === true) {
      const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId)
      const content = metrics.cssContentSize ?? metrics.contentSize ?? null
      const contentHeight = content ? Number(content.height) : 0
      const wanted = contentHeight > 0 ? Math.ceil(contentHeight) : height
      const bounded = Math.min(wanted, MAX_CAPTURE_HEIGHT)
      clipped = wanted > bounded
      clip = { x: 0, y: 0, width, height: Math.max(1, bounded), scale: 1 }
    }
    if (clip !== null) {
      const pixels = Math.ceil(clip.width * dpr) * Math.ceil(clip.height * dpr)
      if (pixels > MAX_CAPTURE_PIXELS) {
        return {
          ok: false,
          code: 'TOO_MANY_PIXELS',
          message:
            'That capture would be ' + String(Math.round(pixels / 1_000_000)) + ' million pixels (' + String(Math.ceil(clip.width * dpr)) + 'x' + String(Math.ceil(clip.height * dpr)) + '), past the ' + String(MAX_CAPTURE_PIXELS / 1_000_000) + 'MP ceiling. Ask for a smaller viewport, drop `dpr`, or clip to one element.',
          page,
        }
      }
    }
    const request = { format: 'png', fromSurface: true }
    if (clip !== null) {
      request.clip = clip
      request.captureBeyondViewport = true
    }
    const shot = await client.send('Page.captureScreenshot', request, sessionId)
    const png = Buffer.from(String(shot.data ?? ''), 'base64')
    const size = readPngSize(png)
    if (size === null) return { ok: false, code: 'NOT_A_PNG', message: 'The engine answered with something that is not a PNG, so nothing was written.' }
    // A page that painted nothing is a picture of an empty box, which is a
    // confusing artifact to commit. It is still returned - with the flag - so a
    // person can look and decide.
    const blank = page !== null && Number(page.text) === 0 && Number(page.elements) <= 1
    if (options.outPath) {
      await fsp.mkdir(path.dirname(options.outPath), { recursive: true })
      await fsp.writeFile(options.outPath, png)
    }
    return {
      ok: true,
      png,
      size,
      title: page ? String(page.title ?? '') : '',
      finalUrl: page ? String(page.url ?? options.url) : options.url,
      clipped,
      blank,
      textLength: page ? Number(page.text) : null,
      elements: page ? Number(page.elements) : null,
      note,
      timingMs: Date.now() - started,
    }
  } catch (err) {
    return { ok: false, code: 'CAPTURE_FAILED', message: 'The capture failed: ' + String(err && err.message ? err.message : err) }
  } finally {
    // Ask the browser to exit over CDP FIRST. On Windows the process we spawned
    // re-executes into the real browser and exits, so killing OUR pid can miss
    // it; `Browser.close` is the only reliable stop, and killTree is the belt.
    if (client !== null) {
      try {
        await client.send('Browser.close', {}, undefined, 3000)
      } catch (err) {
        // already gone
      }
      client.close()
    }
    killTree(child.pid)
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}
