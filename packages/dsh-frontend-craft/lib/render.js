/**
 * dsh-frontend-craft — the rendered page, measured.
 *
 * The 61 vendored rules read SOURCE. This file is the other half: a throwaway
 * headless Chrome renders the page the workspace actually produces, and the
 * measurements a reader can act on come back as findings - contrast pairs,
 * tap-target sizes, horizontal overflow, line length, type too small to read,
 * a skipped heading level, an image with no alt.
 *
 * The engine is the machine's own Chrome or Edge, resolved from PATH or the
 * standard install folders. Nothing is downloaded, and the page cannot reach the
 * network: every name resolves to NOTFOUND except loopback, so a remote font or
 * CDN script fails and the render says what it could not load.
 *
 * The two rules that keep this honest:
 *   - **loopback or a workspace file, nothing else.** A URL is accepted only
 *     when its host is 127.0.0.1 / localhost / [::1]; a path is accepted only
 *     inside the conversation's workspace and only when it is HTML.
 *   - **the profile is throwaway.** A fresh `--user-data-dir` per render, deleted
 *     afterwards, and the process is killed by pid - never by name.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { connectCdp } from './cdp.js'

/** Startup and total budgets: a render that hangs must not hold the session. */
export const STARTUP_TIMEOUT_MS = 20000
export const RENDER_TIMEOUT_MS = 45000
/** The viewports a call may ask for, and the default pair. */
export const DEFAULT_VIEWPORTS = [
  { width: 1440, height: 900, label: 'desktop' },
  { width: 390, height: 844, label: 'phone' },
]
export const MAX_VIEWPORTS = 4
/** How many findings per measured rule a render reports. */
export const MAX_PER_RULE = 6

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
  const dirs = String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter((value) => value !== '')
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * The browser this host has, or `null`. Resolved once per render, never cached:
 * a person who installs Chrome mid-session should not have to restart.
 */
export function resolveEngine(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const override = env.DSH_FRONTEND_ENGINE
  if (typeof override === 'string' && override !== '' && existsSync(override)) return { file: override, kind: 'override', source: 'DSH_FRONTEND_ENGINE' }
  for (const candidate of engineCandidates(platform, env)) {
    if (existsSync(candidate.file)) return { ...candidate, source: 'install' }
  }
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const found = onPath(names, env, platform)
  if (found !== null) return { file: found, kind: 'path', source: 'PATH' }
  return null
}

/** The engine's argv: headless, one throwaway profile, no network but loopback. */
export function buildArgs({ profileDir, width, height, dpr = 1 }) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    // Every name fails except loopback: a local dev server renders, a remote
    // font or CDN script does not, and nothing leaves this machine.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
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

/**
 * What a target may be: an HTML file inside the workspace, or a loopback URL.
 * Anything else is refused with a sentence rather than rendered.
 */
export function targetToUrl(target, workspace) {
  const value = String(target ?? '').trim()
  if (value === '') return { ok: false, message: 'A render needs a target: an HTML file in the workspace, or a loopback URL (http://127.0.0.1:5173/).' }
  if (/^https?:\/\//i.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch (err) {
      return { ok: false, message: 'That is not a URL: ' + value }
    }
    const host = url.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
      return { ok: false, message: 'A render only accepts a LOOPBACK url - 127.0.0.1, localhost or [::1]. ' + url.hostname + ' is not loopback; a public page is what dsh-browser (or web_fetch) is for.' }
    }
    return { ok: true, url: url.toString(), kind: 'url' }
  }
  const file = path.resolve(workspace, value)
  const inside = file === workspace || file.startsWith(workspace + path.sep)
  if (!inside) return { ok: false, message: 'That path is outside the conversation workspace: ' + value }
  if (!existsSync(file)) return { ok: false, message: 'No such file: ' + value }
  if (!/\.x?html?$/i.test(file)) return { ok: false, message: 'A render takes an HTML file (.html / .htm). For a framework app, run its dev server and pass the loopback URL.' }
  return { ok: true, url: pathToFileURL(file).toString(), kind: 'file' }
}

/** The in-page measurement. Serialised and evaluated; no closures, no imports. */
function measureInPage() {
  const MAX_ELEMENTS = 4000
  const MAX_TEXT = 200
  const MAX_TARGETS = 120
  const MAX_PARAGRAPHS = 80
  const MAX_IMAGES = 40

  const visible = (element) => {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || '')
    if (!match) return null
    const parts = match[1].split(/[,/\s]+/).filter((part) => part !== '').map(Number)
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }

  const toHex = (color) =>
    '#' +
    [color.r, color.g, color.b]
      .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
      .join('')

  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })

  const luminance = (color) => {
    const channel = (value) => {
      const unit = value / 255
      return unit <= 0.03928 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }

  const ratio = (a, b) => {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  const effectiveBackground = (element) => {
    let node = element
    let color = null
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node)
      const parsed = parseColor(style.backgroundColor)
      if (parsed && parsed.a > 0) {
        color = color === null ? parsed : blend(color, parsed)
        if (color.a >= 0.999 || parsed.a >= 0.999) return color
      }
      node = node.parentElement
    }
    const base = { r: 255, g: 255, b: 255, a: 1 }
    return color === null ? base : blend(color, base)
  }

  const selectorOf = (element) => {
    if (!element || element.nodeType !== 1) return ''
    if (element.id) return '#' + element.id
    const tag = element.tagName.toLowerCase()
    const classes = [...element.classList].slice(0, 2).map((name) => '.' + name).join('')
    return tag + classes
  }

  const elements = [...document.querySelectorAll('body *')].slice(0, MAX_ELEMENTS)
  const colors = []
  const targets = []
  const paragraphs = []
  const small = []
  const images = []
  const overflow = []
  const headings = []

  for (const element of elements) {
    if (!visible(element)) continue
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()

    if (/^H[1-6]$/.test(element.tagName)) {
      headings.push({ level: Number(element.tagName.slice(1)), text: (element.textContent || '').trim().slice(0, 60), selector: selectorOf(element) })
    }

    // Text leaves only: an element with element children does not own its text.
    if (element.children.length === 0) {
      const text = (element.textContent || '').trim()
      if (text.length > 1 && colors.length < MAX_TEXT) {
        const fontSize = Number.parseFloat(style.fontSize) || 16
        const fontWeight = Number(style.fontWeight) || 400
        const color = parseColor(style.color)
        const background = effectiveBackground(element)
        if (color !== null) {
          const foreground = color.a < 1 ? blend(color, background) : color
          const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)
          const contrast = ratio(foreground, background)
          if (contrast < (large ? 3 : 4.5)) {
            colors.push({
              selector: selectorOf(element),
              text: text.slice(0, 40),
              color: toHex(foreground),
              background: toHex(background),
              ratio: Math.round(contrast * 100) / 100,
              fontSize,
              large,
            })
          }
        }
        if (fontSize < 12 && small.length < MAX_TEXT) small.push({ selector: selectorOf(element), text: text.slice(0, 40), fontSize })
      }
    }

    if (targets.length < MAX_TARGETS) {
      const interactive = element.matches('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')
      if (interactive) {
        targets.push({ selector: selectorOf(element), tag: element.tagName.toLowerCase(), w: Math.round(rect.width), h: Math.round(rect.height), text: (element.textContent || '').trim().slice(0, 30) })
      }
    }

    if (paragraphs.length < MAX_PARAGRAPHS && element.matches('p, li')) {
      const fontSize = Number.parseFloat(style.fontSize) || 16
      const width = rect.width
      if (width > 0) {
        // ~0.5em per character is the honest estimate without a text measurement
        paragraphs.push({ selector: selectorOf(element), width: Math.round(width), fontSize, chars: Math.round(width / (fontSize * 0.5)) })
      }
    }

    if (images.length < MAX_IMAGES && element.tagName === 'IMG') {
      images.push({ selector: selectorOf(element), alt: element.getAttribute('alt'), src: String(element.getAttribute('src') || '').slice(0, 80) })
    }

    if (overflow.length < 20 && rect.right > window.innerWidth + 2 && style.position !== 'fixed') {
      overflow.push({ selector: selectorOf(element), right: Math.round(rect.right), width: Math.round(rect.width) })
    }
  }

  return {
    url: location.href,
    title: document.title || '',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    colors,
    targets,
    paragraphs,
    small,
    images,
    overflow,
    headings,
    counts: { elements: elements.length },
  }
}

/** Turn one viewport's measurements into findings a reader can act on. */
export function findingsFrom(measurements, viewport) {
  const findings = []
  const where = measurements.url
  const push = (rule, name, description, snippet) => findings.push({ antipattern: rule, name, description, severity: 'warning', category: 'quality', file: where, line: 0, snippet, measured: true })

  const contrast = measurements.colors.slice(0, MAX_PER_RULE)
  for (const entry of contrast) {
    push(
      'render-contrast',
      'Text below WCAG AA contrast',
      entry.selector + ' reads ' + entry.color + ' on ' + entry.background + ' — ' + entry.ratio + ':1 at ' + entry.fontSize + 'px (' + (entry.large ? 'large text needs 3:1' : 'normal text needs 4.5:1') + ').',
      entry.selector + ' "' + entry.text + '" ' + entry.ratio + ':1',
    )
  }

  const smallTargets = measurements.targets.filter((entry) => entry.w < 24 || entry.h < 24).slice(0, MAX_PER_RULE)
  for (const entry of smallTargets) {
    push('render-tap-target', 'Touch target under 24px', entry.selector + ' is ' + entry.w + '×' + entry.h + 'px; WCAG 2.2 asks for at least 24×24 CSS pixels.', entry.selector + ' ' + entry.w + '×' + entry.h)
  }

  if (measurements.document.scrollWidth > measurements.viewport.width + 1 || measurements.overflow.length > 0) {
    const worst = measurements.overflow.slice(0, 3).map((entry) => entry.selector + ' ends at ' + entry.right + 'px')
    push(
      'render-overflow',
      'The page scrolls horizontally',
      'At ' + viewport.width + 'px the document is ' + measurements.document.scrollWidth + 'px wide' + (worst.length > 0 ? '; ' + worst.join(', ') : '') + '. Something has a fixed width, a long unbreakable string, or a negative margin.',
      'scrollWidth ' + measurements.document.scrollWidth + ' > ' + measurements.viewport.width,
    )
  }

  const longLines = measurements.paragraphs.filter((entry) => entry.chars > 95).slice(0, MAX_PER_RULE)
  for (const entry of longLines) {
    push('render-line-length', 'Line longer than ~95 characters', entry.selector + ' is ' + entry.width + 'px at ' + entry.fontSize + 'px — roughly ' + entry.chars + ' characters per line. Reading comfort is 45-75.', entry.selector + ' ~' + entry.chars + 'ch')
  }

  const tiny = measurements.small.slice(0, MAX_PER_RULE)
  for (const entry of tiny) {
    push('render-small-type', 'Body text under 12px', entry.selector + ' is ' + entry.fontSize + 'px: "' + entry.text + '".', entry.selector + ' ' + entry.fontSize + 'px')
  }

  let previous = 0
  for (const heading of measurements.headings) {
    if (previous !== 0 && heading.level > previous + 1) {
      push('render-heading-skip', 'Heading level skipped', 'h' + previous + ' is followed by h' + heading.level + ' ("' + heading.text + '"). Screen readers and the document outline both lose a rung.', 'h' + previous + ' then h' + heading.level + ' ("' + heading.text + '")')
    }
    previous = heading.level
  }

  const noAlt = measurements.images.filter((entry) => entry.alt === null || String(entry.alt).trim() === '').slice(0, MAX_PER_RULE)
  for (const entry of noAlt) {
    push('render-missing-alt', 'Image with no alt text', entry.selector + ' (' + entry.src + ') has no alt attribute; a decorative image needs alt="" so a screen reader can skip it.', entry.selector)
  }

  return findings
}

/** Read a png's real size from its own IHDR, never from the request. */
export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Render one target at each viewport and measure it.
 *
 * @returns `{ ok, engine, target, viewports: [{ viewport, png, size, measurements, findings, timingMs }], errors }`.
 */
export async function renderTarget(options) {
  const target = options.target
  const engine = options.engine ?? resolveEngine()
  if (engine === null) {
    return {
      ok: false,
      code: 'NO_ENGINE',
      message:
        'No Chromium-family browser on this host, so the rendered page cannot be measured. Install Google Chrome or Microsoft Edge (any platform), or point DSH_FRONTEND_ENGINE at the executable. The 61 source rules still run without one.',
      target,
    }
  }
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-frontend-render-'))
  const viewports = (options.viewports ?? DEFAULT_VIEWPORTS).slice(0, MAX_VIEWPORTS)
  const first = viewports[0]
  const args = buildArgs({ profileDir, width: first.width, height: first.height })
  const child = spawn(engine.file, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
  const started = Date.now()
  let client = null
  const results = []
  const errors = []
  try {
    const { port, wsPath } = await waitForDevTools(profileDir, child)
    client = await connectCdp('ws://127.0.0.1:' + String(port) + wsPath, { timeoutMs: 10000 })
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)

    for (const viewport of viewports) {
      const startedViewport = Date.now()
      await client.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 }, sessionId)
      const loaded = client.waitFor('Page.loadEventFired', { sessionId, timeoutMs: 20000 })
      await client.send('Page.navigate', { url: target.url }, sessionId)
      try {
        await loaded
      } catch (err) {
        errors.push('navigation at ' + viewport.width + 'px: ' + String(err && err.message))
      }
      // Fonts settle after load; a screenshot taken before them measures the fallback.
      await client.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(() => true) : true', awaitPromise: true, returnByValue: true }, sessionId)
      await new Promise((done) => setTimeout(done, 120))
      const measured = await client.send('Runtime.evaluate', { expression: '(' + measureInPage.toString() + ')()', returnByValue: true }, sessionId)
      const measurements = measured && measured.result ? measured.result.value : null
      if (!measurements) {
        const why = measured && measured.exceptionDetails ? measured.exceptionDetails.exception?.description ?? measured.exceptionDetails.text : 'no value and no exception'
        errors.push('measurement at ' + viewport.width + 'px returned nothing: ' + String(why).slice(0, 300))
        continue
      }
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: options.fullPage === true }, sessionId)
      const png = Buffer.from(String(shot.data ?? ''), 'base64')
      results.push({
        viewport: { width: viewport.width, height: viewport.height, label: viewport.label ?? String(viewport.width) + 'px' },
        png,
        size: readPngSize(png),
        measurements,
        findings: findingsFrom(measurements, viewport),
        timingMs: Date.now() - startedViewport,
      })
    }
    return { ok: results.length > 0, engine: { file: engine.file, kind: engine.kind, source: engine.source }, target, viewports: results, errors, timingMs: Date.now() - started }
  } catch (err) {
    return { ok: false, code: 'RENDER_FAILED', message: 'The render failed: ' + String(err && err.message ? err.message : err), engine: { file: engine.file, kind: engine.kind, source: engine.source }, target, viewports: results, errors, timingMs: Date.now() - started }
  } finally {
    if (client !== null) client.close()
    killTree(child.pid)
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The sentence a render's answer starts with. */
export function renderSummary(report) {
  if (report.ok !== true) return String(report.message ?? 'the render failed')
  const lines = []
  lines.push('rendered ' + report.target.url)
  lines.push('engine: ' + report.engine.file + ' (' + report.engine.source + ') · ' + report.viewports.length + ' viewport' + (report.viewports.length === 1 ? '' : 's') + ' · ' + Math.round(report.timingMs) + ' ms')
  for (const entry of report.viewports) {
    const findings = entry.findings
    lines.push('')
    lines.push(entry.viewport.label + ' ' + entry.viewport.width + '×' + entry.viewport.height + ' — ' + (entry.size ? entry.size.width + '×' + entry.size.height + ' png' : 'no picture') + ' · ' + findings.length + ' measured finding' + (findings.length === 1 ? '' : 's'))
    for (const finding of findings.slice(0, 10)) lines.push('  ' + finding.antipattern + ' — ' + finding.snippet)
  }
  if (report.errors.length > 0) {
    lines.push('')
    lines.push('what could not be read: ' + report.errors.join('; '))
  }
  lines.push('')
  lines.push('These are MEASURED rules (render-*), not the 61 source rules: they describe this render at these sizes. They do not judge the design — look at the picture, and read the craft floor.')
  return lines.join('\n')
}
