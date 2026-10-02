// check-canvas-browser.mjs â€” prove, in a REAL browser, the parts of dsh-canvas
// that no Node check can: that the engine survives being imported from a blob URL,
// that the vendored OFL faces actually load and measure, that the canvas painter
// puts ink on a canvas, and that the PNG the export path produces is EXACTLY the
// preset's pixel size.
//
// Why this exists: `check-canvas-node.mjs` drives the engine with a SYNTHETIC
// measurer, which is what makes the layout arithmetic verifiable on any host - but
// it deliberately proves nothing about real font metrics, about `createImageBitmap`
// or about what a canvas encoder emits. This check is the other half: it serves the
// plugin's own engine and font files over loopback, loads them in a throwaway
// headless Chromium, runs one archetype document through layout -> paint -> PNG,
// and posts the numbers back.
//
// It needs a Chromium-family browser. With none installed it SKIPS LOUDLY and
// exits 0 - a check that downloads a browser to pass is not a check. The browser is
// launched with a throwaway profile under a temp directory that is deleted at the
// end, `--headless=new`, no network beyond the loopback server this file starts,
// and every failure is reported with the browser's own console output.
//
// Run:  node scripts/checks/check-canvas-browser.mjs [--keep]
export {} // (import-free: ESM for the dynamic imports below)

const { promises: fsp } = await import('node:fs')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { createServer } = await import('node:http')
const { spawn } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const keep = process.argv.includes('--keep')
const canvasDir = path.join(repo, 'packages/dsh-canvas')

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/**
 * A Chromium-family browser on this machine, or null.
 *
 * The same three families `dsh-browser`'s engine resolves, resolved here rather
 * than imported: a check may reach into another package's files, but a package
 * may not, and this one has no reason to own an engine resolver.
 */
function findBrowser() {
  const configured = process.env.DSH_CANVAS_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    for (const root of programFiles) {
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

const browser = findBrowser()
if (browser === null) {
  console.log('skip every canvas browser check                        (no Chromium-family browser on this host)')
  console.log('     set DSH_CANVAS_BROWSER to a chrome/edge/chromium binary to run it')
  process.exitCode = 0
} else {
  console.log('browser: ' + browser)
  console.log('')

  // -------------------------------------------------------------------------
  // The page: import the engine from a blob URL, load the vendored faces, lay out
  // an archetype, paint it, encode the PNG and the feed thumbnail, post the facts.
  // -------------------------------------------------------------------------
  const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-canvas browser check</title>
<style>
  body{margin:0;background:#111;color:#eee;font:14px/1.5 system-ui,sans-serif}
  #stage{padding:16px}
  canvas{display:block;box-shadow:0 8px 30px #0008;margin-bottom:12px}
  #feed{border:1px solid #555}
  #log{white-space:pre-wrap;padding:0 16px 16px;color:#9f9}
</style></head>
<body>
<div id="stage"><canvas id="art"></canvas><canvas id="feed"></canvas></div>
<div id="log"></div>
<script>
const log = (line) => { document.getElementById('log').textContent += line + '\\n' }
const post = (body) => fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

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

async function blobUrlFor(url) {
  const response = await fetch(url)
  const text = await response.text()
  return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
}

async function run() {
  const started = Date.now()
  const report = { ok: false, errors: [], console: [] }
  try {
    // 1. The engine, exactly the way the client loads it: fetched from the
    //    plugin's route and imported from a blob URL.
    const engine = await import(await blobUrlFor('/engine.js'))
    report.engineVersion = engine.ENGINE_VERSION
    report.hasLayout = typeof engine.layout === 'function'

    // 2. The vendored faces, through @font-face from the plugin's font routes,
    //    awaited before anything is measured.
    const families = await (await fetch('/fonts.json')).json()
    report.families = Object.keys(families)
    for (const [family, entry] of Object.entries(families)) {
      for (const [weight, meta] of Object.entries(entry.weights)) {
        const face = new FontFace(family, 'url(' + meta.url + ')', { weight })
        await face.load()
        document.fonts.add(face)
      }
    }
    await document.fonts.ready
    report.fontsReady = document.fonts.check('700 72px "Space Grotesk"') && document.fonts.check('400 22px "Inter"')

    // 3. A real document, validated by the engine, laid out with REAL metrics.
    const archetypes = await (await fetch('/archetypes.json')).json()
    const archetype = archetypes.find((entry) => entry.id === 'editorial-split') || archetypes[0]
    report.archetype = archetype.id
    const presets = await (await fetch('/presets.json')).json()
    const verdict = engine.normalizeDocument(archetype.document, { presets, fonts: families })
    report.problems = verdict.problems.length
    if (!verdict.document) throw new Error('the archetype did not validate: ' + JSON.stringify(verdict.problems.slice(0, 2)))

    const measure = measurer()
    const laid = engine.layout(verdict.document, { measure, assets: {}, fonts: families })
    report.ops = laid.ops.length
    report.boxes = laid.boxes.length
    report.canvas = laid.width + 'x' + laid.height
    report.textOps = laid.ops.filter((op) => op.kind === 'text').length
    report.warnings = laid.warnings.map((entry) => entry.code)
    const headline = laid.boxes.find((entry) => entry.kind === 'text' && entry.font && entry.font.size > 40)
    report.headlineLines = headline ? headline.lines : 0
    report.headlineHeight = headline ? Math.round(headline.box.h) : 0
    // The synthetic measurer the Node check uses answers half the font size per
    // character. If the REAL face produced exactly the same answer the face was
    // never in play - so the same string is measured three ways: through the
    // bundled stack, with a bare sans-serif stack, and by the synthetic formula.
    // The bundled family has to differ from BOTH, or what loaded is not what is
    // being measured.
    const probe = 'One agent. Your whole toolchain.'
    report.probeEngine = Math.round(measure(probe, { stack: '"Space Grotesk", sans-serif', weight: 700, size: 72 }))
    report.probeSynthetic = Math.round(probe.length * 72 * 0.5)
    report.probeFallback = Math.round(measure(probe, { stack: 'sans-serif', weight: 700, size: 72 }))
    report.realMetricsDiffer = report.probeEngine !== report.probeSynthetic && report.probeEngine !== report.probeFallback

    // 4. The canvas painter, onto a real canvas, at the preset's own size.
    const art = document.getElementById('art')
    art.width = laid.width
    art.height = laid.height
    const context = art.getContext('2d')
    engine.paintCanvas(laid.ops, context, { scale: 1, images: {}, assets: {} })
    const pixels = context.getImageData(0, 0, art.width, art.height).data
    let ink = 0
    let colors = new Set()
    for (let index = 0; index < pixels.length; index += 4 * 97) {
      const key = (pixels[index] >> 4) + ',' + (pixels[index + 1] >> 4) + ',' + (pixels[index + 2] >> 4)
      colors.add(key)
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 60) ink += 1
    }
    report.distinctColours = colors.size
    report.inkSamples = ink

    // 5. The PNG the export path produces, and its own header.
    const blob = await new Promise((resolve) => art.toBlob(resolve, 'image/png'))
    report.pngBytes = blob.size
    // The picture itself travels back, so this check can leave the REAL rendered
    // PNG behind (a screenshot of the page would be a picture of a canvas; this is
    // the canvas).
    report.png = art.toDataURL('image/png').split(',')[1]
    const header = new Uint8Array(await blob.slice(0, 33).arrayBuffer())
    const view = new DataView(header.buffer)
    report.pngWidth = view.getUint32(16)
    report.pngHeight = view.getUint32(20)
    report.pngSignature = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47

    // 6. The feed thumbnail (25% - roughly a phone feed), and the SVG export.
    const feed = document.getElementById('feed')
    const feedScale = 0.25
    feed.width = Math.round(laid.width * feedScale)
    feed.height = Math.round(laid.height * feedScale)
    const feedContext = feed.getContext('2d')
    feedContext.save()
    feedContext.scale(feedScale, feedScale)
    engine.paintCanvas(laid.ops, feedContext, { scale: 1, images: {}, assets: {} })
    feedContext.restore()
    report.feed = feed.width + 'x' + feed.height
    const feedBlob = await new Promise((resolve) => feed.toBlob(resolve, 'image/png'))
    report.feedBytes = feedBlob.size

    const svg = engine.toSvg(laid.ops, verdict.document, {})
    report.svgBytes = svg.length
    report.svgRoot = svg.startsWith('<svg ')
    report.svgText = svg.includes('<text ')
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    report.svgParses = parsed.querySelector('parsererror') === null

    report.ms = Date.now() - started
    report.ok = true
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err))
  }
  await post(report)
  log(report.ok ? 'canvas browser check finished in ' + report.ms + 'ms' : 'FAILED: ' + report.errors.join(' | '))
}

window.addEventListener('error', (event) => { post({ ok: false, errors: ['window error: ' + event.message] }) })
run()
</script>
</body></html>`

  // -------------------------------------------------------------------------
  // The loopback server: the plugin's own files, exactly as the routes serve them
  // -------------------------------------------------------------------------
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-browser-'))
  const fontsDir = path.join(canvasDir, 'lib', 'vendor', 'fonts')
  const fontRecord = JSON.parse(readFileSync(path.join(fontsDir, 'VERSION.json'), 'utf8'))
  const fontTable = {}
  for (const [family, entry] of Object.entries(fontRecord.families)) {
    const weights = {}
    for (const [weight, meta] of Object.entries(entry.files)) {
      weights[weight] = { url: '/fonts/' + meta.file, file: meta.file }
    }
    fontTable[family] = { family, stack: [family, 'sans-serif'], weights }
  }
  const archetypeDir = path.join(canvasDir, 'lib', 'archetypes')
  const archetypes = []
  for (const entry of await fsp.readdir(archetypeDir)) {
    if (!entry.endsWith('.json')) continue
    const parsed = JSON.parse(await fsp.readFile(path.join(archetypeDir, entry), 'utf8'))
    archetypes.push({ id: parsed.id, presets: parsed.presets, document: parsed.document })
  }
  const presetModule = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'presets.js').replace(/\\/g, '/')).href)

  let reported = null
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/report') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        reported = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof reported.png === 'string' && reported.png.length > 0) {
          // The rendered design, written the moment it arrives: the browser may be
          // killed as soon as this response is sent.
          writeFileSync(path.join(sandbox, 'design.png'), Buffer.from(reported.png, 'base64'))
          delete reported.png
        }
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(PAGE)
        return
      }
      if (url.pathname === '/engine.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        response.end(await fsp.readFile(path.join(canvasDir, 'lib', 'engine.js'), 'utf8'))
        return
      }
      if (url.pathname === '/fonts.json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(fontTable))
        return
      }
      if (url.pathname === '/presets.json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(presetModule.PRESETS))
        return
      }
      if (url.pathname === '/archetypes.json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(archetypes))
        return
      }
      if (url.pathname.startsWith('/fonts/')) {
        const name = path.basename(url.pathname)
        const file = path.join(fontsDir, name)
        if (!existsSync(file) || !name.endsWith('.woff2')) {
          response.writeHead(404)
          response.end('no')
          return
        }
        response.writeHead(200, { 'content-type': 'font/woff2' })
        response.end(readFileSync(file))
        return
      }
      response.writeHead(404)
      response.end('no')
    } catch (err) {
      response.writeHead(500)
      response.end(String(err && err.message ? err.message : err))
    }
  })

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const pageUrl = 'http://127.0.0.1:' + port + '/'
  const profile = path.join(sandbox, 'profile')

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--user-data-dir=' + profile,
      '--window-size=1400,1000',
      '--virtual-time-budget=30000',
      pageUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let browserOutput = ''
  child.stdout.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })

  const deadline = Date.now() + 90_000
  while (reported === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  // The report is the result; the browser is stopped as soon as it is in. The
  // design PNG travelled WITH the report, so nothing here depends on the browser
  // exiting tidily (and nothing waits on a virtual-time budget).
  try {
    child.kill()
  } catch (err) {
    /* already gone */
  }
  // Wait for it to actually exit before touching its profile: a killed Chrome
  // still holds its `Default/` files for a moment, and deleting a live profile is
  // an EBUSY, not a failure of anything this check is about.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  server.close()

  console.log('')
  if (reported === null) {
    check('the page reported its results', false, true)
    console.log('     the browser said:')
    console.log(browserOutput.split('\n').slice(0, 20).map((line) => '       ' + line).join('\n'))
  } else {
    for (const error of reported.errors ?? []) console.log('     page error: ' + error)
    check('the engine imported from a blob URL', reported.hasLayout, true)
    check('the engine reports its version', reported.engineVersion, '1')
    check('both vendored families are served', (reported.families ?? []).sort().join(','), 'Inter,Space Grotesk')
    check('the vendored faces actually load', reported.fontsReady, true)
    check('the archetype validates in the browser too', reported.problems, 0)
    check('the layout produced draw ops', (reported.ops ?? 0) > 5, true)
    check('the layout produced node boxes', (reported.boxes ?? 0) > 3, true)
    check('the canvas is the preset size', reported.canvas, '1280x640')
    check('the headline wrapped with REAL font metrics', (reported.headlineLines ?? 0) >= 1, true)
    check('the bundled face measures differently from the fallback', reported.realMetricsDiffer, true)
    console.log('     widths at 72px: bundled ' + reported.probeEngine + 'px, bare sans-serif ' + reported.probeFallback + 'px, synthetic ' + reported.probeSynthetic + 'px')
    check('the painter put ink on the canvas', (reported.inkSamples ?? 0) > 10, true)
    check('the canvas is not one flat colour', (reported.distinctColours ?? 0) > 2, true)
    check('the PNG has a real signature', reported.pngSignature, true)
    check('the PNG is EXACTLY the preset size', (reported.pngWidth ?? 0) + 'x' + (reported.pngHeight ?? 0), '1280x640')
    check('the PNG has bytes', (reported.pngBytes ?? 0) > 1000, true)
    check('the feed thumbnail is 25%', reported.feed, '320x160')
    check('the feed thumbnail is a real PNG too', (reported.feedBytes ?? 0) > 500, true)
    check('the SVG export has a root element', reported.svgRoot, true)
    check('the SVG export carries the text', reported.svgText, true)
    check('the SVG export parses as XML', reported.svgParses, true)
    check('no layout warnings on a clean archetype', (reported.warnings ?? []).filter((code) => ['TEXT_OVERFLOW', 'TEXT_TRUNCATED', 'TEXT_UNWRAPPED'].includes(code)).length, 0)
    if (keep && existsSync(path.join(sandbox, 'design.png'))) {
      writeFileSync(path.join(repo, '.scratch', 'canvas-browser.png'), readFileSync(path.join(sandbox, 'design.png')))
      console.log('')
      console.log('the rendered design was kept at .scratch/canvas-browser.png')
    } else if (keep) {
      console.log('')
      console.log('note: the page sent no design PNG back')
    }
  }

  if (!keep) {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (err) {
      // A profile the browser has not finished releasing is not a check failure;
      // the path is printed so a person can delete it.
      console.log('note: could not remove ' + sandbox + ' (' + (err && err.code ? err.code : 'error') + ') - delete it by hand')
    }
  }
  console.log('')
  console.log(failures === 0 ? 'all canvas browser checks passed' : failures + ' canvas browser check(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}

