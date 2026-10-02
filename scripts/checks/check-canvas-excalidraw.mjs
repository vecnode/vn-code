// check-canvas-excalidraw.mjs — prove, in a REAL browser, the part of the Canvas
// tab's Excalidraw surface that no other check can: that the COMMITTED artifact
// loads from this package's own vendor tree the way the client loader loads it,
// that it mounts inside a pane, that its stylesheet is what makes it usable, and
// that the imperative API an agent tool would drive really answers.
//
// Why this exists: `check-canvas-node.mjs` drives the host half and
// `check-canvas-browser.mjs` the design engine, but neither can see a third-party
// editor that only exists once a browser has evaluated 3 MiB of it. The vendored
// artifact is also the one thing in this package whose bytes are not written
// here - so it is checked from BOTH sides: `vendor/excalidraw/build.mjs --check`
// re-hashes it against VERSION.json offline, and this file proves the bytes do
// what they claim in a real Chromium.
//
// It needs a Chromium-family browser. With none installed it SKIPS LOUDLY and
// exits 0, like every other browser check here.
//
// Run:  node scripts/checks/check-canvas-excalidraw.mjs [--keep]
export {} // (import-free: ESM for the dynamic imports below)

const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = await import('node:fs')
const { createServer } = await import('node:http')
const { spawn, spawnSync } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const keep = process.argv.includes('--keep')
const vendorDir = path.join(repo, 'packages', 'dsh-canvas', 'lib', 'vendor', 'excalidraw')
const clientSource = readFileSync(path.join(repo, 'packages', 'dsh-canvas', 'lib', 'client.js'), 'utf8')
const nodeSource = readFileSync(path.join(repo, 'packages', 'dsh-canvas', 'lib', 'index.js'), 'utf8')

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

// ---------------------------------------------------------------------------
// The record and the artifact, OFFLINE. `build.mjs --check` is the authority on
// the bytes; these assertions are about the CONTRACT around them - that the two
// routes the client asks for are the two files that exist, and that the record
// still declares what has not been vendored.
// ---------------------------------------------------------------------------
const recordPath = path.join(vendorDir, 'VERSION.json')
check('the vendored record is committed', existsSync(recordPath))
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { files: {} }
check('it pins the versions the build used', record.pins?.['@excalidraw/excalidraw'], '0.18.1')
check('it names the trims it applied', (record.trims ?? []).join(','), 'locales-stubbed,mermaid-dialog-stubbed')
check('the bundle is committed at the size the record states', statSync(path.join(vendorDir, 'excalidraw.min.js')).size, record.files?.['excalidraw.min.js']?.bytes)
check('the stylesheet is committed too', statSync(path.join(vendorDir, 'excalidraw.css')).size, record.files?.['excalidraw.css']?.bytes)
check(
  'every licence the artifact needs travels with it',
  ['LICENSE-excalidraw.txt', 'LICENSE-react.txt', 'LICENSE-react-dom.txt'].filter((name) => existsSync(path.join(vendorDir, name))).length,
  3,
)
const build = spawnSync(process.execPath, [path.join(repo, 'packages', 'dsh-canvas', 'vendor', 'excalidraw', 'build.mjs'), '--check'], { encoding: 'utf8' })
check('vendor build --check re-hashes the artifact offline', build.status === 0)
if (build.status !== 0) console.log('     ' + String(build.stderr ?? '').split('\n').filter(Boolean).slice(0, 4).join('\n     '))
// The two halves must agree on the routes: the client asks for these exact paths
// and the host registers them, and a typo on either side is a 404 nobody sees
// until the surface is opened.
check('the client loads the bundle from this package\u2019s own route', clientSource.includes("const EXCALIDRAW_JS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.js'"))
check('...and the stylesheet first', clientSource.includes("const EXCALIDRAW_CSS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.css'"))
check('...as a CLASSIC script, not a module import', clientSource.includes("script.setAttribute('src', EXCALIDRAW_JS_ROUTE + '?v=' + PLUGIN_VERSION)") && clientSource.includes('window.DSHExcalidraw'))
check('...and it sets the asset path Excalidraw reads once', clientSource.includes("window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH"))
check(
  'the host registers both routes with the registry\u2019s own shape',
  nodeSource.includes("const EXCALIDRAW_JS_ROUTE = API_ROOT + '/vendor/excalidraw.js'") &&
    nodeSource.includes("register(EXCALIDRAW_JS_ROUTE, ['GET', 'HEAD']") &&
    nodeSource.includes("register(EXCALIDRAW_CSS_ROUTE, ['GET', 'HEAD']"),
)
check('...and answers 304 over the recorded hash', nodeSource.includes("cache-control': 'no-cache'") && nodeSource.includes('if-none-match'))

// ---------------------------------------------------------------------------
// The artifact, in a browser.
// ---------------------------------------------------------------------------
function findBrowser() {
  const configured = process.env.DSH_CANVAS_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)) {
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
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

const browser = findBrowser()
if (browser === null) {
  console.log('skip the Excalidraw surface in a real browser                (no Chromium-family browser on this host)')
  console.log('     set DSH_CANVAS_BROWSER to a chrome/edge/chromium binary to run it')
} else {
  // The page loads the surface EXACTLY the way `loadExcalidraw()` does - a
  // stylesheet link and a classic script with a cache-busting query - so a
  // loader that only worked because of how this check fetched it would fail here.
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>excalidraw surface</title>
<link rel="stylesheet" data-plugin-css="dsh-canvas/excalidraw.css" href="/excalidraw.css?v=check">
<style>html,body{margin:0;height:100%;background:#fff}#pane{position:absolute;inset:0}</style></head><body>
<div id="pane"></div>
<script>
(async () => {
  const report = { errors: [] }
  const post = (value) => fetch('/report', { method: 'POST', body: JSON.stringify(value) }).catch(() => {})
  window.addEventListener('error', (event) => report.errors.push('window error: ' + event.message))
  window.addEventListener('unhandledrejection', (event) => report.errors.push('rejection: ' + String(event.reason && event.reason.message ? event.reason.message : event.reason)))
  try {
    const script = document.createElement('script')
    script.setAttribute('src', '/excalidraw.js?v=check')
    const loaded = new Promise((resolve, reject) => {
      script.addEventListener('load', () => resolve(true))
      script.addEventListener('error', () => reject(new Error('the script tag never loaded')))
    })
    document.head.appendChild(script)
    await loaded
    window.EXCALIDRAW_ASSET_PATH = '/vendor/'
    const surface = window.DSHExcalidraw
    report.surfaceKeys = Object.keys(surface).join(',')
    report.version = surface.version
    const pane = document.getElementById('pane')
    const started = performance.now()
    let api = null
    surface.mount(pane, { theme: 'light', excalidrawAPI: (value) => { api = value } })
    await new Promise((resolve) => setTimeout(resolve, 2500))
    report.mountMs = Math.round(performance.now() - started)
    const shell = pane.querySelector('.excalidraw')
    report.hasShell = shell !== null
    report.canvases = pane.querySelectorAll('canvas').length
    report.buttons = pane.querySelectorAll('button').length
    report.primary = shell ? getComputedStyle(shell).getPropertyValue('--color-primary').trim() : ''
    const box = (shell || pane).getBoundingClientRect()
    report.box = Math.round(box.width) + 'x' + Math.round(box.height)
    report.api = api !== null
    if (api !== null) {
      // WHAT AN AGENT TOOL WILL SEND: a skeleton, not a full Excalidraw element.
      const elements = surface.convertToExcalidrawElements([
        { type: 'rectangle', x: 60, y: 60, width: 240, height: 120, label: { text: 'canvas', fontSize: 20 } },
        { type: 'ellipse', x: 340, y: 70, width: 110, height: 110, label: { text: 'agent', fontSize: 14 } },
      ])
      api.updateScene({ elements })
      await new Promise((resolve) => setTimeout(resolve, 900))
      const scene = api.getSceneElements()
      report.elements = scene.length
      report.kinds = scene.map((element) => element.type).join(',')
      const json = surface.serializeAsJSON(scene, api.getAppState(), api.getFiles(), 'local')
      report.jsonBytes = json.length
      report.jsonType = JSON.parse(json).type
      // exportToSvg is ASYNC in this line of Excalidraw: awaiting it is not
      // decoration, it is the difference between an element and a Promise.
      const svg = await surface.exportToSvg({ elements: scene, appState: api.getAppState(), files: api.getFiles() })
      report.svgBytes = new XMLSerializer().serializeToString(svg).length
      const canvas = pane.querySelector('canvas')
      if (canvas !== null) { try { report.png = canvas.toDataURL('image/png') } catch (err) { report.pngError = String(err.message) } }
    }
    report.ok = true
  } catch (err) {
    report.errors.push(String(err && err.message ? err.message : err))
  }
  await post(report)
})()
</script></body></html>`

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-excalidraw-'))
  let reported = null
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/report') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        reported = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof reported.png === 'string' && reported.png.length > 0) {
          writeFileSync(path.join(sandbox, 'surface.png'), Buffer.from(reported.png.split(',')[1], 'base64'))
          delete reported.png
        }
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
      })
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
      return
    }
    if (url.pathname === '/excalidraw.js' || url.pathname === '/excalidraw.css') {
      // The COMMITTED artifact, byte for byte, with the route's own headers.
      const name = url.pathname === '/excalidraw.js' ? 'excalidraw.min.js' : 'excalidraw.css'
      response.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-cache',
        etag: '"' + String(record.files?.[name]?.sha256 ?? '').slice(0, 32) + '"',
      })
      response.end(readFileSync(path.join(vendorDir, name)))
      return
    }
    response.writeHead(404)
    response.end('no')
  })

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
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
      '--window-size=1100,760',
      'http://127.0.0.1:' + port + '/',
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
  while (reported === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    child.kill()
  } catch (err) {
    /* already gone */
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
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
    console.log(browserOutput.split('\n').slice(0, 16).map((line) => '       ' + line).join('\n'))
  } else {
    for (const error of reported.errors ?? []) console.log('     page error: ' + error)
    check('the committed artifact loads as a classic script', typeof reported.surfaceKeys === 'string' && reported.surfaceKeys.includes('mount'))
    console.log('     the surface exposes: ' + String(reported.surfaceKeys))
    check('...and it is the pinned version', reported.version, '0.18.1')
    check('it mounts in a pane', reported.hasShell, true)
    check('...with Excalidraw\u2019s own canvases', (reported.canvases ?? 0) >= 2, true)
    check('...its own UI', (reported.buttons ?? 0) >= 6, true)
    // THE STYLESHEET IS NOT OPTIONAL: without it this variable (declared by
    // Excalidraw's own CSS) resolves to nothing and the editor is unusable.
    check('...and its stylesheet applied', reported.primary, '#6965db')
    console.log('     mounted in ' + String(reported.mountMs) + 'ms, pane ' + String(reported.box) + ', ' + String(reported.canvases) + ' canvas(es), ' + String(reported.buttons) + ' button(s)')
    check('the imperative API answers', reported.api, true)
    check('a skeleton scene becomes real elements', reported.elements, 4)
    // The ORDER is Excalidraw's (containers first, then the bound text it creates
    // for each label), so the assertion is over the SET and not over a sequence
    // this check would be inventing.
    check('...of the kinds the skeleton asked for', String(reported.kinds).split(',').sort().join(','), 'ellipse,rectangle,text,text')
    check('...and serializes as an .excalidraw document', reported.jsonType === 'excalidraw' && (reported.jsonBytes ?? 0) > 500)
    check('the SVG export path answers too', (reported.svgBytes ?? 0) > 500)
    if (keep && existsSync(path.join(sandbox, 'surface.png'))) {
      writeFileSync(path.join(repo, '.scratch', 'canvas-excalidraw-surface.png'), readFileSync(path.join(sandbox, 'surface.png')))
      console.log('')
      console.log('the painted canvas was kept at .scratch/canvas-excalidraw-surface.png')
    }
  }

  if (!keep) {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (err) {
      console.log('note: could not remove ' + sandbox + ' (' + (err && err.code ? err.code : 'error') + ') - delete it by hand')
    }
  }
}

console.log('')
console.log(failures === 0 ? 'all canvas Excalidraw checks passed' : failures + ' canvas Excalidraw check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
