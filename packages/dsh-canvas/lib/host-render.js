/**
 * dsh-canvas — THE UNATTENDED RENDERER.
 *
 * The package's rule is that the HOST CANNOT PAINT: real text metrics live in a
 * browser, and the PNG must come from the same code path that draws the artboard, or
 * "it looked right in the tab" becomes a bug class. That rule is about WHERE the
 * pixels come from, not about who is watching - so this file starts a headless
 * Chromium on the host, serves it the very same engine the tab loads, and takes the
 * PNG back over loopback.
 *
 * What it buys, in the order it matters:
 *
 *   - `canvas_render` and `canvas_export` work with NO app page open (the tab still
 *     does the work when it is there, because a person watching the render happen is
 *     worth more than a fast answer);
 *   - a file can be produced without asking anyone to refresh a browser;
 *   - the whole render path is testable on a machine with no app running at all.
 *
 * What it needs: a Chromium-family browser (Edge, Chrome or Chromium - the same three
 * families `dsh-browser` resolves) and nothing else. No network beyond loopback, no
 * npm package, no service. `DSH_CANVAS_BROWSER` points it at a specific binary.
 *
 * The browser runs with a THROWAWAY PROFILE under a temp directory, `--headless=new`,
 * `--disable-gpu`, no extensions, no first-run pages, and the loopback server serves
 * exactly four things: the page, the engine, the document and the report endpoint.
 * The temp profile is removed when the render finishes, whatever the outcome.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fontFaceCss, fontFiles, fontTable } from './fonts.js'

const ENGINE_FILE = fileURLToPath(new URL('./engine.js', import.meta.url))
const FONT_DIR = fileURLToPath(new URL('./vendor/fonts/', import.meta.url))

/** A Chromium-family browser on this machine, or null. */
export function findBrowser(env = process.env) {
  const configured = env.DSH_CANVAS_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/** Whether an unattended render is possible on this host, and why not. */
export function hostRenderStatus(env = process.env) {
  const browser = findBrowser(env)
  return {
    available: browser !== null,
    browser,
    route: 'the host renderer (headless)',
    reason: browser ? null : 'no Chromium-family browser was found; set DSH_CANVAS_BROWSER to a chrome/edge/chromium binary',
  }
}

/** The page: import the engine, load the faces, lay out, paint, post the PNG back. */
function pageFor(payload) {
  const faces = Object.keys(fontTable())
    .map((family) => fontFaceCss(family, (file) => readFileSync(path.join(FONT_DIR, file)).toString('base64')))
    .filter(Boolean)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-canvas host render</title>
<style>${faces}
  body{margin:0;background:#000;color:#eee;font:14px/1.4 system-ui,sans-serif}
  canvas{display:block}
</style></head>
<body><canvas id="art"></canvas><canvas id="feed"></canvas>
<script>
const FONTS = ${JSON.stringify(payload.fonts)}
const SCALE = ${JSON.stringify(payload.scale)}
const FEED = 0.25
function measurer() {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  const measure = (text, font) => {
    context.font = (font.weight || 400) + ' ' + (font.size || 16) + 'px ' + (font.stack || 'sans-serif')
    return context.measureText(text).width
  }
  measure.metrics = (font) => {
    context.font = (font.weight || 400) + ' ' + (font.size || 16) + 'px ' + (font.stack || 'sans-serif')
    const metrics = context.measureText('Hxg')
    if (typeof metrics.fontBoundingBoxAscent === 'number' && metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent > 0) {
      const size = font.size || 16
      return { ascent: metrics.fontBoundingBoxAscent / size, descent: metrics.fontBoundingBoxDescent / size }
    }
    return { ascent: 0.8, descent: 0.2 }
  }
  return measure
}
/** The assets the document names, as bitmaps, from the data URLs the host sent. */
async function loadImages(names, sources) {
  const images = {}
  for (const name of names) {
    const source = sources[name]
    if (!source) continue
    try {
      const response = await fetch(source)
      const blob = await response.blob()
      images[name] = await createImageBitmap(blob)
    } catch (err) {
      /* an asset the browser refuses is reported by the lints, not crashed on */
    }
  }
  return images
}
function paint(engine, prepared, canvas, scale, images) {
  canvas.width = Math.max(1, Math.round(prepared.width * scale))
  canvas.height = Math.max(1, Math.round(prepared.height * scale))
  canvas.style.width = Math.round(prepared.width * scale) + 'px'
  canvas.style.height = Math.round(prepared.height * scale) + 'px'
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
  engine.paintCanvas(prepared.ops, context, { scale, images: images || prepared.images || {}, assets: {} })
}
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(new Error('the canvas could not be encoded'))
    reader.readAsDataURL(blob)
  })
}
async function main() {
  const report = { ok: false, stage: 'start' }
  try {
    const response = await fetch('/engine.js')
    const engineUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }))
    report.stage = 'engine'
    const engine = await import(engineUrl)
    if (document.fonts && document.fonts.ready) await document.fonts.ready
    report.stage = 'layout'
    const measure = measurer()
    const documentJson = await (await fetch('/document.json')).json()
    const doc = documentJson.document
    const assets = documentJson.assets || {}
    const wanted = []
    const collect = (node) => {
      if (node.kind === 'image' && typeof node.src === 'string') wanted.push(node.src)
      for (const child of node.children || []) collect(child)
    }
    for (const layer of doc.layers || []) collect(layer)
    const images = await loadImages(wanted, assets)
    const laid = engine.layout(doc, { measure, assets, fonts: FONTS, images })
    report.stage = 'paint'
    const art = document.getElementById('art')
    paint(engine, laid, art, SCALE, images)
    paint(engine, laid, document.getElementById('feed'), FEED, images)
    report.stage = 'encode'
    const format = documentJson.format === 'jpg' || documentJson.format === 'jpeg' ? 'jpg' : documentJson.format === 'svg' ? 'svg' : 'png'
    if (format === 'svg') {
      const svg = engine.toSvg(laid.ops, { width: laid.width, height: laid.height, background: doc.canvas ? doc.canvas.background : null, images })
      report.ok = true
      report.format = 'svg'
      report.svg = svg
      report.width = laid.width
      report.height = laid.height
    } else {
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png'
      const png = await base64Of(await new Promise((resolve) => art.toBlob(resolve, mime, format === 'jpg' ? 0.92 : undefined)))
      const feed = await base64Of(await new Promise((resolve) => document.getElementById('feed').toBlob(resolve, 'image/png')))
      report.ok = true
      report.format = format
      report.png = png
      report.feed = feed
      report.width = art.width
      report.height = art.height
      report.feedWidth = document.getElementById('feed').width
      report.feedHeight = document.getElementById('feed').height
    }
    report.metrics = {
      ops: laid.ops.length,
      boxes: laid.boxes.length,
      textNodes: laid.boxes.filter((entry) => entry.kind === 'text').length,
      lines: laid.ops.filter((op) => op.kind === 'text').length,
      smallestType: laid.boxes.filter((entry) => entry.kind === 'text').reduce((min, entry) => Math.min(min, entry.font && entry.font.size ? entry.font.size : 999), 999),
      families: Object.keys(FONTS),
    }
    // The lints are taken HERE, from the same laid-out design the pixels came from:
    // the host cannot lay anything out itself (no real metrics), so a report produced
    // without a page must have the page's own measurements behind it.
    const preset = documentJson.preset
    if (preset) report.lints = engine.lintLayout(laid, doc, preset, { assets })
  } catch (err) {
    report.error = err && err.message ? err.message : String(err)
  }
  await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) })
}
main()
</script></body></html>`
}

/**
 * Render one canonical document on the host.
 *
 * @param options.document - a canonical document (`normalizeDocument`'s output).
 * @param options.scale - 1 or 2 (design pixels are multiplied by exactly this).
 * @param options.assets - `{ name: dataUrl }` for the images the document names.
 * @param options.timeoutMs - how long the browser is given (default 90 s).
 * @param options.env - the environment to resolve the browser with.
 * @returns `{ ok, png, feed, width, height, metrics, browser, ms }` or `{ ok: false, error }`.
 */
export async function renderOnHost(options = {}) {
  const env = options.env ?? process.env
  const browser = findBrowser(env)
  if (!browser) {
    return { ok: false, error: 'no Chromium-family browser was found; set DSH_CANVAS_BROWSER to a chrome/edge/chromium binary' }
  }
  const scale = options.scale === 2 ? 2 : 1
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 90000
  const started = Date.now()
  const profile = mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-render-'))
  const engineSource = readFileSync(ENGINE_FILE, 'utf8')
  const payload = { document: options.document, scale, fonts: fontTable(), format: options.format ?? 'png' }
  const page = pageFor(payload)
  let settle = null
  const answered = new Promise((resolve) => {
    settle = resolve
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/report') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"ok":true}')
          settle(body)
        } catch (err) {
          response.writeHead(400).end('{}')
        }
      })
      return
    }
    if (url.pathname === '/engine.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(engineSource)
      return
    }
    if (url.pathname === '/document.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ document: options.document, assets: options.assets ?? {}, preset: options.preset ?? null, format: options.format ?? 'png' }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  let child = null
  const cleanup = () => {
    try {
      if (child && child.exitCode === null) child.kill()
    } catch (err) {
      /* a browser that already exited is not an error */
    }
    try {
      server.close()
    } catch (err) {
      /* closing a closed server is not an error */
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch (err) {
      /* a locked profile on Windows is left for the OS to reap */
    }
  }
  try {
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--hide-scrollbars',
        '--mute-audio',
        '--user-data-dir=' + profile,
        '--window-size=1600,1200',
        'http://127.0.0.1:' + port + '/',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    const timer = setTimeout(() => settle({ ok: false, error: 'the browser did not report within ' + Math.round(timeoutMs / 1000) + 's' }), timeoutMs)
    const report = await answered
    clearTimeout(timer)
    if (!report || !report.ok) {
      return { ok: false, error: (report && report.error) || 'the render produced no picture', stage: report && report.stage, browser }
    }
    return {
      ok: true,
      format: report.format ?? 'png',
      png: report.png ? Buffer.from(report.png, 'base64') : null,
      svg: typeof report.svg === 'string' ? report.svg : null,
      feed: report.feed ? Buffer.from(report.feed, 'base64') : null,
      width: report.width,
      height: report.height,
      feedWidth: report.feedWidth,
      feedHeight: report.feedHeight,
      metrics: report.metrics,
      lints: Array.isArray(report.lints) ? report.lints : [],
      scale,
      browser,
      ms: Date.now() - started,
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), browser }
  } finally {
    cleanup()
  }
}

/** The font files this renderer inlines, for a health route or a log line. */
export function hostRenderFonts() {
  return fontFiles().map((entry) => entry.family + ' ' + entry.weight)
}
