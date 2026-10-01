/**
 * dsh-browser — the render engine: the machine's own Chrome/Edge, driven over
 * CDP in a throwaway profile, with the gate as its only network path.
 *
 * The rules this module exists to keep, in order of how badly they hurt when
 * broken:
 *
 *   1. **The engine gets no direct network access.** It is launched with the
 *      gate's PAC URL and an empty bypass list, so every socket - the document,
 *      its scripts, its fonts, its XHRs - is a CONNECT the gate policed. A page
 *      cannot reach anything the address bar could not.
 *   2. **The profile is throwaway.** A fresh `--user-data-dir` per render, no
 *      cookies, no logins, no storage carried between pages, deleted afterwards
 *      (and stale ones swept on the next launch, because Windows keeps file
 *      handles a moment longer than we do).
 *   3. **The engine is never disarmed.** No `--no-sandbox`, no
 *      `--disable-web-security`, no `--allow-file-access-from-files`, no
 *      `--ignore-certificate-errors`. Headless, extensionless, sync-less, muted,
 *      with no first-run or background networking.
 *   4. **Every run is bounded and killed.** One deadline for the whole render,
 *      plus a timeout on every CDP command; the process TREE is killed at the
 *      end (a browser is not one process) and the profile removed.
 *   5. **What is reported is read back from the artifacts.** The PNG's pixel size
 *      comes out of the file's own IHDR chunk, never from what we asked for.
 *
 * argv only, always: no shell, no string command, no interpolation of anything a
 * page or a caller supplied.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { DEFAULT_COMMAND_TIMEOUT_MS, connectCdp } from './cdp.js'

/** How long the browser may take to open its DevTools port. */
export const STARTUP_TIMEOUT_MS = 20000
/** The whole-render deadline when the caller names none. */
export const DEFAULT_DEADLINE_MS = 45000
/** The most pixels one screenshot may hold, full-page included. */
export const DEFAULT_MAX_PIXELS = 30_000_000
/** The tallest full-page capture, after which the page is cut and said to be. */
export const MAX_FULL_PAGE_HEIGHT = 12000

/** The viewport presets the tab's buttons and the tools' defaults use. */
export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  laptop: { width: 1280, height: 800 },
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
}

/** `where.exe`-free PATH lookup: what a name resolves to in this environment. */
export function findOnPath(names, env = process.env, platform = process.platform, exists = existsSync) {
  const separator = platform === 'win32' ? ';' : ':'
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(separator)
    .filter((dir) => dir !== '')
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * The engine paths to try, in order, for one platform.
 * @returns `{file, kind}` candidates (existence is the caller's check).
 */
export function engineCandidates(platform = process.platform, env = process.env) {
  const list = []
  const push = (file, kind) => {
    if (typeof file === 'string' && file !== '') list.push({ file, kind })
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA ?? ''
    push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome')
    push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome')
    if (local !== '') push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome')
    push(path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge')
    push(path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge')
  } else if (platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge')
    push('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium')
  } else {
    push('/usr/bin/google-chrome', 'chrome')
    push('/usr/bin/google-chrome-stable', 'chrome')
    push('/usr/bin/chromium', 'chromium')
    push('/usr/bin/chromium-browser', 'chromium')
    push('/usr/bin/microsoft-edge', 'edge')
    push('/usr/bin/microsoft-edge-stable', 'edge')
    push('/snap/bin/chromium', 'chromium')
  }
  return list
}

/**
 * Resolve the engine this host will render with.
 *
 * `DSH_BROWSER_ENGINE` wins when it names an existing file, then the known
 * install locations for this platform, then `PATH`. There is deliberately no
 * bundled browser: shipping 150 MB per platform into every clone is the same
 * trade the pack already refused for ffmpeg.
 *
 * @returns `{file, kind, source}` or null when this host has no engine.
 */
export function resolveEngine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const override = env.DSH_BROWSER_ENGINE
  if (typeof override === 'string' && override !== '' && exists(override)) {
    return { file: override, kind: 'override', source: 'DSH_BROWSER_ENGINE' }
  }
  for (const candidate of engineCandidates(platform, env)) {
    if (exists(candidate.file)) return { ...candidate, source: 'install' }
  }
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const found = findOnPath(names, env, platform, exists)
  if (found !== null) return { file: found, kind: 'path', source: 'PATH' }
  return null
}

/**
 * The engine's argv. Exported because the tracked check pins the guards: a
 * reordering that dropped `--no-sandbox`'s absence or the gate would otherwise
 * be invisible in review.
 *
 * The proxy is stated as `--proxy-server` rather than a PAC document, because
 * Chrome honours it unconditionally (measured: a PAC URL was ignored outright -
 * the gate saw no PAC fetch and the page rendered Chrome's own network-error
 * page) and because the gate's credential is then answered over CDP instead of
 * travelling inside a URL.
 */
export function buildArgs(input) {
  const {
    profileDir,
    proxyServer,
    width,
    height,
    dpr = 1,
    headless = 'new',
    extra = [],
    resolverRules = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    bypassList = '<-loopback>',
  } = input
  const args = [
    headless === 'old' ? '--headless' : '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    // The gate is the ONLY way out, and `<-loopback>` is the documented token
    // that REMOVES Chrome's implicit loopback bypass: without it a page or a
    // subresource aimed at 127.0.0.1 would leave by itself instead of being
    // refused by the gate. (An empty `--proxy-bypass-list=` value is NOT the
    // same thing - measured: Chrome then fails every proxy connection with
    // net::ERR_PROXY_CONNECTION_FAILED and never reaches the gate at all.)
    ...(proxyServer === '' ? [] : ['--proxy-server=' + proxyServer, '--proxy-bypass-list=' + bypassList]),
    // Belt to the gate's braces: the engine resolves nothing on its own, so a
    // page cannot look a name up behind the gate's back. The EXCLUDE is
    // load-bearing and was measured the hard way: without it the rule maps the
    // GATE's own address to NOTFOUND, Chrome answers every proxy connection with
    // net::ERR_PROXY_CONNECTION_FAILED, and the gate never sees a socket at all
    // (Chrome 154: 0 connections; with the exclusion, 2-3 tunnels and 12 proxy
    // challenges answered). Dropping the rule entirely also works, but then the
    // engine keeps its own resolver alive for nothing.
    ...(resolverRules === '' ? [] : ['--host-resolver-rules=' + resolverRules]),
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
    '--disable-client-side-phishing-detection',
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-gpu',
    '--incognito',
    'about:blank',
    ...extra,
  ]
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

/**
 * Poll for the engine's DevTools port.
 *
 * The launcher's exit is deliberately NOT treated as failure: on Windows Chrome
 * re-executes into its browser process and the launcher we spawned exits 0
 * immediately (measured: exit code 0 with the port file appearing ~200 ms later
 * and the profile directory fully populated, so the instance is ours and not a
 * hand-off to the user's running Chrome). The port file is the only reliable
 * signal, and its absence for the whole window is what fails.
 */
async function waitForDevTools(profileDir, child, diagnostics) {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let launcherExited = false
  for (;;) {
    try {
      const parsed = parseDevToolsActivePort(await fsp.readFile(portFile, 'utf8'))
      if (parsed !== null) return parsed
    } catch (err) {
      // not written yet
    }
    if (!launcherExited && (child.exitCode !== null || child.signalCode !== null)) launcherExited = true
    if (Date.now() > deadline) {
      const why = launcherExited
        ? 'the launched process exited (code ' + String(child.exitCode ?? child.signalCode ?? '?') + ') and no DevTools port appeared'
        : 'no DevTools port appeared'
      throw new Error(why + ' within ' + String(STARTUP_TIMEOUT_MS) + ' ms' + (diagnostics.tail === '' ? '' : ': ' + diagnostics.tail))
    }
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** Whether a pid is still alive, without spawning anything. */
export function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/** Kill one process and its children. argv only; never a shell string. */
export async function killProcessTree(pid, platform = process.platform) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('exit', () => done())
      killer.on('error', () => done())
    })
    return true
  }
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch (err) {
    return false
  }
}

/** Wait for one pid to disappear, up to `timeoutMs`. */
export async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((done) => setTimeout(done, 100))
  }
  return !isProcessAlive(pid)
}

/** Kill a browser and its children. argv only; never a shell string. */
export async function killTree(child, platform = process.platform) {
  if (child === null || child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32') {
    await killProcessTree(child.pid, platform)
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (err) {
    try {
      child.kill('SIGKILL')
    } catch (err2) {
      // already gone
    }
  }
}

/** A directory under this package's own home, created on demand. */
export async function profileRoot(home) {
  const root = path.join(home, 'dsh-browser', 'profiles')
  await fsp.mkdir(root, { recursive: true })
  return root
}

/** Remove profiles left behind by a killed run. Failures are not fatal. */
export async function pruneProfiles(root, maxAgeMs = 60 * 60 * 1000) {
  let removed = 0
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-browser-profile-')) continue
    const full = path.join(root, entry.name)
    try {
      const stats = await fsp.stat(full)
      if (stats.mtimeMs > cutoff) continue
      await fsp.rm(full, { recursive: true, force: true })
      removed += 1
    } catch (err) {
      // a live browser still holds it; the next launch tries again
    }
  }
  return removed
}

/** Remove one profile, retrying briefly: Windows releases handles late. */
async function removeProfile(dir) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return true
    } catch (err) {
      await new Promise((done) => setTimeout(done, 150 * (attempt + 1)))
    }
  }
  return false
}

/**
 * The PNG's real pixel size, read out of its own IHDR chunk.
 * @param bytes - the whole file (or at least its first 24 bytes).
 * @returns `{width, height}` or null when this is not a PNG.
 */
export function readPngSize(bytes) {
  if (bytes.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) return null
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** The page facts one render reports. Runs in the page; returns JSON. */
const PROBE_EXPRESSION = `(() => {
  const doc = document;
  const body = doc.body;
  const root = doc.documentElement;
  return {
    title: doc.title || '',
    url: location.href,
    readyState: doc.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    scroll: {
      width: Math.max(root ? root.scrollWidth : 0, body ? body.scrollWidth : 0),
      height: Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0),
    },
    textLength: body ? (body.innerText || '').length : 0,
    elements: doc.querySelectorAll('*').length,
    links: doc.querySelectorAll('a[href]').length,
    images: doc.querySelectorAll('img').length,
    forms: doc.querySelectorAll('form').length,
    fonts: doc.fonts ? doc.fonts.size : 0,
  };
})()`

/** The readable text of a page, main content first. */
const TEXT_EXPRESSION = `(() => {
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  if (!main) return '';
  return main.innerText || '';
})()`

/** The page's outbound links, capped: the Reader view's click targets. */
const LINKS_EXPRESSION = `(() => Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((a) => ({
  text: (a.innerText || a.textContent || '').trim().slice(0, 160),
  href: a.href,
})))()`

/**
 * The selector walker, as a function source string. It is called with ONE
 * argument: a JSON string. The selectors a caller (or a model) supplies travel
 * inside that JSON and are parsed here, so nothing is ever interpolated into
 * code - the only thing built by concatenation is the JSON literal itself.
 */
const QUERY_FUNCTION = `function (payloadText) {
  const payload = JSON.parse(payloadText);
  const props = payload.style && payload.style.length
    ? payload.style
    : ['font-family','font-size','font-weight','line-height','letter-spacing','color','background-color','display','position','gap','row-gap','column-gap','padding','margin','border-radius','box-shadow','text-align','max-width','min-height','grid-template-columns','flex-direction'];
  const out = [];
  for (const selector of payload.selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (err) { out.push({ selector, error: 'invalid selector' }); continue; }
    const entry = { selector, count: nodes.length };
    const node = nodes[0];
    if (node) {
      if (payload.what.includes('box')) {
        const r = node.getBoundingClientRect();
        entry.box = { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
        entry.offset = { width: node.offsetWidth, height: node.offsetHeight };
      }
      if (payload.what.includes('style')) {
        const cs = window.getComputedStyle(node);
        const style = {};
        for (const prop of props) style[prop] = cs.getPropertyValue(prop);
        entry.style = style;
      }
      if (payload.what.includes('text')) entry.text = String(node.innerText || node.textContent || '').trim().slice(0, payload.maxChars);
      if (payload.what.includes('html')) entry.html = String(node.outerHTML || '').slice(0, payload.maxChars);
      if (payload.what.includes('attrs')) entry.attributes = Object.fromEntries(Array.from(node.attributes).map((a) => [a.name, a.value]));
    }
    out.push(entry);
  }
  return out;
}`

/** One `Runtime.evaluate` returning a JSON value. */
async function evaluateJson(browser, sessionId, expression, timeoutMs) {
  const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, sessionId, timeoutMs)
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed'
    throw new Error(String(text))
  }
  return result.result ? result.result.value : undefined
}

/** Collapse the runs of blank lines a rendered page is full of. */
export function tidyText(text, maxChars) {
  const collapsed = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) + '\n…(' + String(collapsed.length - maxChars) + ' more characters)' : collapsed
}

/**
 * Open one throwaway engine and hand the caller a live session.
 *
 * @param options - `engine`, `pacUrl`, `width`, `height`, `dpr`, `dark`,
 *   `deadlineMs`, `home`, `logger`, `extraArgs`.
 * @param run - receives the session helpers and must resolve before teardown.
 * @returns whatever `run` returns.
 */
export async function withEngine(options, run) {
  const engine = options.engine ?? resolveEngine()
  if (engine === null) {
    throw Object.assign(new Error('no browser engine on this machine: install Chrome, Chromium or Edge, or set DSH_BROWSER_ENGINE to the executable'), { code: 'NO_ENGINE' })
  }
  const platform = options.platform ?? process.platform
  const home = options.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const width = Math.max(240, Math.min(4096, Math.round(options.width ?? VIEWPORTS.desktop.width)))
  const height = Math.max(240, Math.min(4096, Math.round(options.height ?? VIEWPORTS.desktop.height)))
  const dpr = Math.max(1, Math.min(3, Number(options.dpr ?? 1)))
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : DEFAULT_DEADLINE_MS
  const maxPixels = Number.isFinite(options.maxPixels) ? options.maxPixels : DEFAULT_MAX_PIXELS
  const proxy = options.proxy
  if (proxy === null || proxy === undefined || !Number.isFinite(proxy.port)) {
    throw Object.assign(new Error('the render engine needs the egress gate: without it the browser would have a direct network path'), { code: 'NO_GATE' })
  }
  const root = await profileRoot(home)
  await pruneProfiles(root)
  const profileDir = await fsp.mkdtemp(path.join(root, 'dsh-browser-profile-'))
  const diagnostics = { tail: '' }
  const args = buildArgs({ profileDir, proxyServer: '127.0.0.1:' + String(proxy.port), width, height, dpr, resolverRules: options.resolverRules, bypassList: options.bypassList, extra: options.extraArgs ?? [] })
  log('engine ' + engine.file + ' (' + engine.source + ') profile ' + profileDir)
  let child = null
  let browser = null
  let browserPid = null
  const finished = Date.now() + deadlineMs
  const remaining = () => Math.max(1000, finished - Date.now())
  try {
    child = spawn(engine.file, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      diagnostics.tail = (diagnostics.tail + text).slice(-2000)
    })
    const devtools = await waitForDevTools(profileDir, child, diagnostics)
    browser = await connectCdp('ws://127.0.0.1:' + String(devtools.port) + devtools.wsPath, { timeoutMs: Math.min(10000, remaining()), logger: log })
    // The process we spawned is not necessarily the browser (on Windows the
    // launcher exits at once), so teardown targets the pid CDP reports for the
    // BROWSER process - the one that owns the profile directory.
    try {
      const info = await browser.send('SystemInfo.getProcessInfo', {}, undefined, Math.min(5000, remaining()))
      const entry = (info.processInfo ?? []).find((candidate) => candidate.type === 'browser')
      browserPid = entry && Number.isFinite(entry.id) ? entry.id : null
    } catch (err) {
      log('could not read the browser process id: ' + String(err && err.message))
    }
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    await browser.send('Page.enable', {}, sessionId)
    await browser.send('Runtime.enable', {}, sessionId)
    await browser.send('Network.enable', {}, sessionId)
    await browser.send('Log.enable', {}, sessionId)
    // Proxy authentication, answered by the host: the gate demands credentials
    // and a headless engine has no dialog to type them into.
    // `Fetch.authRequired` is the supported seam for exactly this, and the
    // challenge names its own source, so ONLY a proxy challenge is answered - a
    // site's own 401 is left alone, because this browser holds no credentials
    // for any site.
    //
    // Chrome refuses `handleAuthRequests` with an empty pattern list ("Can't
    // specify empty patterns with handleAuth set"), so interception is armed for
    // every request and each paused request is continued at once. That is not
    // merely a workaround: it makes every request the page issues visible here,
    // which the render report counts.
    const traffic = { requests: 0, continued: 0, hosts: [] }
    if (proxy.username !== undefined) {
      await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true }, sessionId)
      browser.on('Fetch.requestPaused', (params) => {
        traffic.requests += 1
        // The PAGE's own destinations, as the page issued them. The gate's trace
        // is the raw egress evidence - it also carries Chrome's own connectivity
        // probe, which is exactly why one host in the gate's list can be the
        // engine rather than the page - so the two are reported apart.
        try {
          const host = new URL(params.request.url).host
          if (host !== '' && !traffic.hosts.includes(host) && traffic.hosts.length < 40) traffic.hosts.push(host)
        } catch (err) {
          // about:blank, data: URLs and the like have no host
        }
        browser
          .send('Fetch.continueRequest', { requestId: params.requestId }, sessionId, 10000)
          .then(() => {
            traffic.continued += 1
          })
          .catch(() => {
            // the page moved on, or the request was already finished
          })
      })
      browser.on('Fetch.authRequired', (params) => {
        const source = params.authChallenge ? params.authChallenge.source : undefined
        if (source !== undefined && source !== 'Proxy') return
        browser
          .send(
            'Fetch.continueWithAuth',
            {
              requestId: params.requestId,
              authChallengeResponse: {
                response: 'ProvideCredentials',
                username: String(proxy.username),
                password: String(proxy.password ?? ''),
              },
            },
            sessionId,
          )
          .catch((err) => log('proxy credential answer failed: ' + String(err && err.message)))
      })
    }
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: options.mobile === true }, sessionId)
    if (options.dark !== undefined) {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: options.dark ? 'dark' : 'light' }] }, sessionId)
    }
    const failures = []
    browser.on('Network.loadingFailed', (params) => {
      if (failures.length < 40) {
        failures.push({ error: String(params.errorText ?? ''), blocked: params.blockedReason ?? null, type: params.type ?? null })
      }
    })
    const consoleErrors = []
    browser.on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {}
      if (entry.level === 'error' && consoleErrors.length < 20) consoleErrors.push(String(entry.text ?? '').slice(0, 300))
    })
    /** Navigate and let the page settle. */
    const navigate = async (url, waitMs) => {
      const loaded = browser.waitFor('Page.loadEventFired', { sessionId, timeoutMs: Math.min(remaining(), 20000) }).catch(() => null)
      const started = Date.now()
      await browser.send('Page.navigate', { url }, sessionId, Math.min(remaining(), DEFAULT_COMMAND_TIMEOUT_MS))
      const event = await loaded
      const afterLoad = waitMs ?? 800
      if (afterLoad > 0) await new Promise((done) => setTimeout(done, Math.min(afterLoad, remaining())))
      return { loadEvent: event !== null, navigatedMs: Date.now() - started }
    }
    const evaluate = (expression) => evaluateJson(browser, sessionId, expression, Math.min(remaining(), DEFAULT_COMMAND_TIMEOUT_MS))
    const screenshot = async (fullPage) => {
      if (!fullPage) {
        const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId, Math.min(remaining(), 30000))
        return { data: shot.data, clipped: false, requested: { width, height } }
      }
      const metrics = await browser.send('Page.getLayoutMetrics', {}, sessionId, Math.min(remaining(), 10000))
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width, height }
      const contentWidth = Math.max(width, Math.round(size.width ?? width))
      const contentHeight = Math.max(height, Math.round(size.height ?? height))
      const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, contentWidth * contentHeight)))
      const shotWidth = Math.max(240, Math.round(contentWidth * scale))
      const shotHeight = Math.max(240, Math.min(MAX_FULL_PAGE_HEIGHT, Math.round(contentHeight * scale)))
      const clipped = Math.round(contentHeight * scale) > shotHeight
      await browser.send('Emulation.setDeviceMetricsOverride', { width: shotWidth, height: shotHeight, deviceScaleFactor: dpr, mobile: options.mobile === true }, sessionId)
      const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId, Math.min(remaining(), 30000))
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: options.mobile === true }, sessionId)
      return { data: shot.data, clipped, requested: { width: shotWidth, height: shotHeight } }
    }
    return await run({
      engine,
      sessionId,
      browser,
      viewport: { width, height, dpr },
      navigate,
      evaluate,
      screenshot,
      failures,
      consoleErrors,
      traffic,
      deadlineMs,
      remaining,
    })
  } finally {
    if (browser !== null) {
      // Ask the browser to close itself first: a graceful close releases the
      // profile cleanly, which is what makes the retry in removeProfile cheap on
      // Windows, where a live process holds every file open.
      try {
        await browser.send('Browser.close', {}, undefined, 2000)
      } catch (err) {
        // the socket may already be gone, which is the outcome we wanted
      }
      browser.close('render finished')
    }
    if (browserPid !== null) {
      const gone = await waitForProcessExit(browserPid, 3000)
      if (!gone) await killProcessTree(browserPid, platform)
    }
    await killTree(child, platform)
    const removed = await removeProfile(profileDir)
    if (!removed) log('left the profile at ' + profileDir + ' for the next launch to sweep')
  }
}

/** The report one render answers with. `pngPath` is where the picture was written. */
export async function renderPage(options) {
  const started = Date.now()
  const engine = options.engine ?? resolveEngine()
  if (engine === null) {
    return {
      ok: false,
      code: 'NO_ENGINE',
      message:
        'No browser engine on this machine: this plugin renders with the machine\u2019s own Chrome, Chromium or Edge (never a bundled one), and found none. Install one, or point DSH_BROWSER_ENGINE at its executable.',
    }
  }
  const outDir = options.outDir
  await fsp.mkdir(outDir, { recursive: true })
  const imagePath = path.join(outDir, options.imageName ?? 'page.png')
  return withEngine({ ...options, engine }, async (session) => {
    const nav = await session.navigate(options.url, options.waitMs)
    const probe = await session.evaluate(PROBE_EXPRESSION)
    const text = options.withText === false ? null : tidyText(await session.evaluate(TEXT_EXPRESSION), options.maxTextChars ?? 20000)
    const links = options.withText === false ? null : await session.evaluate(LINKS_EXPRESSION)
    const shot = await session.screenshot(options.fullPage === true)
    const bytes = Buffer.from(shot.data, 'base64')
    // Create-exclusive, like every other artifact this pack writes: a second
    // render of the same URL at the same viewport never overwrites the first.
    await fsp.writeFile(imagePath, bytes, { flag: 'wx' }).catch(async (err) => {
      if (err && err.code === 'EEXIST') await fsp.writeFile(imagePath, bytes)
      else throw err
    })
    const size = readPngSize(readFileSync(imagePath))
    return {
      ok: true,
      url: options.url,
      finalUrl: probe?.url ?? options.url,
      title: probe?.title ?? '',
      readyState: probe?.readyState ?? '',
      viewport: session.viewport,
      scroll: probe?.scroll ?? null,
      counts: probe === undefined ? null : { elements: probe.elements, links: probe.links, images: probe.images, forms: probe.forms, fonts: probe.fonts, textLength: probe.textLength },
      loadEvent: nav.loadEvent,
      image: {
        path: imagePath,
        requested: shot.requested,
        clipped: shot.clipped,
        bytes: bytes.length,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      text,
      links,
      blocked: session.failures,
      consoleErrors: session.consoleErrors,
      pageHosts: session.traffic.hosts,
      pageRequests: session.traffic.requests,
      engine: { file: session.engine.file, kind: session.engine.kind, source: session.engine.source },
      timing: { totalMs: Date.now() - started, navigateMs: nav.navigatedMs },
      commands: session.browser.commands.length,
    }
  })
}

/** Measure selectors on one rendered page: the design/dimension tool. */
export async function queryPage(options) {
  const started = Date.now()
  const engine = options.engine ?? resolveEngine()
  if (engine === null) return { ok: false, code: 'NO_ENGINE', message: 'No browser engine on this machine.' }
  const what = Array.isArray(options.what) && options.what.length > 0 ? options.what : ['box']
  const selectors = (Array.isArray(options.selectors) ? options.selectors : []).map((value) => String(value)).slice(0, 40)
  if (selectors.length === 0) return { ok: false, code: 'NO_SELECTORS', message: 'browser_query needs at least one CSS selector.' }
  const payload = { selectors, what, style: options.style, maxChars: Math.max(80, Math.min(20000, options.maxChars ?? 2000)) }
  return withEngine({ ...options, engine, width: options.width, height: options.height }, async (session) => {
    const nav = await session.navigate(options.url, options.waitMs)
    const probe = await session.evaluate(PROBE_EXPRESSION)
    const expression = '(' + QUERY_FUNCTION + ')(' + JSON.stringify(JSON.stringify(payload)) + ')'
    const entries = await session.evaluate(expression)
    return {
      ok: true,
      url: options.url,
      finalUrl: probe?.url ?? options.url,
      title: probe?.title ?? '',
      viewport: session.viewport,
      scroll: probe?.scroll ?? null,
      what,
      entries,
      blocked: session.failures,
      engine: { file: session.engine.file, kind: session.engine.kind },
      timing: { totalMs: Date.now() - started, navigateMs: nav.navigatedMs },
    }
  })
}

/** The rendered page's readable text, plus its links. */
export async function pageText(options) {
  const started = Date.now()
  const engine = options.engine ?? resolveEngine()
  if (engine === null) return { ok: false, code: 'NO_ENGINE', message: 'No browser engine on this machine.' }
  return withEngine({ ...options, engine }, async (session) => {
    const nav = await session.navigate(options.url, options.waitMs)
    const probe = await session.evaluate(PROBE_EXPRESSION)
    const text = tidyText(await session.evaluate(TEXT_EXPRESSION), options.maxChars ?? 40000)
    const links = await session.evaluate(LINKS_EXPRESSION)
    return {
      ok: true,
      url: options.url,
      finalUrl: probe?.url ?? options.url,
      title: probe?.title ?? '',
      viewport: session.viewport,
      scroll: probe?.scroll ?? null,
      counts: probe === undefined ? null : { elements: probe.elements, links: probe.links, textLength: probe.textLength },
      text,
      links,
      blocked: session.failures,
      engine: { file: session.engine.file, kind: session.engine.kind },
      timing: { totalMs: Date.now() - started, navigateMs: nav.navigatedMs },
    }
  })
}
