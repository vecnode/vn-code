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
// NO CREDENTIAL SHIPS IN THE ARTIFACT. Excalidraw's published build carries its
// own OSS Firebase config - api key included - so the vendored copy put a
// `google_api_key` in this PUBLIC repository and GitHub's secret scanning opened
// an alert against it. The value is removed by a BUILD PATCH
// (`vendor/excalidraw/patches/index.mjs`, named in the record's `patches`), and
// these two assertions are what keeps it removed: the record must still name the
// patch, and the artifact itself must contain no Google-key-shaped literal and
// must carry the blanked api key. `check-no-secrets.mjs` scans every staged file
// for the same shape; this one is here so the failure names the CAUSE.
check('the record names the repository patch that was applied', (record.patches ?? []).join(','), 'firebase-api-key-redacted')
{
  const bundleText = readFileSync(path.join(vendorDir, 'excalidraw.min.js'), 'utf8')
  const googleKey = bundleText.match(/\bAIza[0-9A-Za-z_-]{35}\b/g) || []
  check('the bundle carries no Google API key', googleKey.length, 0)
  check('...and the api key it shipped is blanked, not restructured', bundleText.includes('"apiKey":""'))
}
check(
  'every licence the artifact needs travels with it',
  ['LICENSE-excalidraw.txt', 'LICENSE-react.txt', 'LICENSE-react-dom.txt'].filter((name) => existsSync(path.join(vendorDir, name))).length,
  3,
)
const build = spawnSync(process.execPath, [path.join(repo, 'packages', 'dsh-canvas', 'vendor', 'excalidraw', 'build.mjs'), '--check'], { encoding: 'utf8' })
check('vendor build --check re-hashes the artifact offline', build.status === 0)
if (build.status !== 0) console.log('     ' + String(build.stderr ?? '').split('\n').filter(Boolean).slice(0, 4).join('\n     '))
// THE SERVED PAGE IS ONE TEMPLATE LITERAL, and this file has now paid for that
// twice: a backtick inside a comment in the page silently ENDS the template, and
// the failure reads as a syntax error 200 lines away (once) or as a page that
// never boots (the worse case). The canvas panel check pins the same thing for the
// same reason, so it is pinned here too - against this file's own source.
{
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const TICK = String.fromCharCode(96)
  const open = own.indexOf('const PAGE = ' + TICK)
  const close = open === -1 ? -1 : own.indexOf(TICK, open + 13)
  const body = open === -1 || close === -1 ? null : own.slice(open + 13, close)
  check('the served page is one literal, with no stray backtick', body !== null && body.indexOf(TICK) === -1, true)
}
// The two halves must agree on the routes: the client asks for these exact paths
// and the host registers them, and a typo on either side is a 404 nobody sees
// until the surface is opened.
check('the client loads the bundle from this package\u2019s own route', clientSource.includes("const EXCALIDRAW_JS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.js'"))
check('...and the stylesheet first', clientSource.includes("const EXCALIDRAW_CSS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.css'"))
check('...as a CLASSIC script, not a module import', clientSource.includes("script.setAttribute('src', EXCALIDRAW_JS_ROUTE + '?v=' + PLUGIN_VERSION)") && clientSource.includes('window.DSHExcalidraw'))
check('...and it sets the asset path Excalidraw reads once', clientSource.includes("window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH"))
check(
  '...which is the editor\u2019s OWN namespace, with the trailing slash `new URL` needs',
  clientSource.includes("const EXCALIDRAW_ASSET_PATH = '/api/dsh-canvas/vendor/excalidraw/'"),
)
check(
  'the host registers both routes with the registry\u2019s own shape',
  nodeSource.includes("const EXCALIDRAW_JS_ROUTE = API_ROOT + '/vendor/excalidraw.js'") &&
    nodeSource.includes("register(EXCALIDRAW_JS_ROUTE, ['GET', 'HEAD']") &&
    nodeSource.includes("register(EXCALIDRAW_CSS_ROUTE, ['GET', 'HEAD']"),
)
check('...and answers 304 over the recorded hash', nodeSource.includes("cache-control': 'no-cache'") && nodeSource.includes('if-none-match'))

// THE FACES. Excalidraw resolves every one it fetches as
// `new URL('fonts/<Family>/<file>', EXCALIDRAW_ASSET_PATH)`, so the question worth
// pinning is not "were some fonts copied" but "is every face this bundle can ask
// for either vendored or DECLARED skipped". The second half is the load-bearing
// one: the bundle names 230 files and this package deliberately ships 25 of them,
// and without the declaration a missing face is a 404 the editor swallows as a
// silent fallback - the CJK text simply draws as boxes and nothing says why.
const referencedFaces = new Set()
for (const match of readFileSync(path.join(vendorDir, 'excalidraw.min.js'), 'utf8').matchAll(/\.\/fonts\/([A-Za-z]+)\/([A-Za-z0-9._-]+\.woff2)/g)) {
  referencedFaces.add(match[1] + '/' + match[2])
}
const skippedFamilies = new Set(record.fonts?.skipped ?? [])
const vendoredFaces = new Set()
for (const [family, entries] of Object.entries(record.fonts?.families ?? {})) for (const name of Object.keys(entries)) vendoredFaces.add(family + '/' + name)
const facesMissing = []
const skippedReached = new Set()
for (const face of referencedFaces) {
  if (vendoredFaces.has(face)) continue
  const family = face.split('/')[0]
  if (skippedFamilies.has(family)) skippedReached.add(family)
  else facesMissing.push(face)
}
check('the vendor tree ships the LATIN faces', vendoredFaces.size, 25)
check('...and the bundle can reach them', referencedFaces.size > 20)
check('...while NOTHING it can ask for is missing outside a DECLARED skip', facesMissing.length, 0)
if (facesMissing.length > 0) console.log('     missing: ' + facesMissing.slice(0, 6).join(', '))
console.log(
  '     faces: ' +
    String(vendoredFaces.size) +
    ' vendored of ' +
    String(referencedFaces.size) +
    ' referenced \u00b7 skipped: ' +
    (skippedFamilies.size === 0 ? 'none' : [...skippedFamilies].join(', ') + ' (' + String(skippedReached.size) + ' reached by the bundle)'),
)
{
  const sample = Object.entries(record.fonts?.families ?? {})[0]
  if (sample !== undefined) {
    const bytes = readFileSync(path.join(vendorDir, 'fonts', sample[0], Object.keys(sample[1])[0]))
    check('a vendored face is a real woff2 file, at the recorded size', bytes.subarray(0, 4).toString('latin1') + ':' + String(bytes.length), 'wOF2:' + String(Object.values(sample[1])[0].bytes))
  }
}

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
    // THE ASSET BASE THE CLIENT SETS, to the letter: the editor resolves
    // './fonts/<Family>/<file>' against it, and a base without its trailing slash
    // would resolve to the wrong directory - so the check uses the client's own
    // constant rather than a hand-typed copy.
    window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'
    const surface = window.DSHExcalidraw
    report.surfaceKeys = Object.keys(surface).join(',')
    report.version = surface.version
    const pane = document.getElementById('pane')
    const started = performance.now()
    const PROBE_ID = 'dsh-canvas/probe-item'
    const SEED_ID = 'dsh-canvas/seeded-item'
    let api = null
    /** What the change callback last reported: the pack's own save seam. */
    let latestLibrary = []
    // The library is READ through the change callback, not a getter: this line of
    // Excalidraw exposes updateLibrary on the imperative API and reports what the
    // library became through onLibraryChange. The seeded item arrives the way the
    // pack's own library does - through initialData.
    surface.mount(pane, {
      theme: 'light',
      initialData: {
        libraryItems: [{
          id: SEED_ID,
          status: 'published',
          name: 'seeded',
          elements: surface.convertToExcalidrawElements([{ type: 'rectangle', x: 0, y: 0, width: 100, height: 40 }]),
          created: Date.now(),
        }],
      },
      excalidrawAPI: (value) => { api = value },
      onLibraryChange: (items) => {
        latestLibrary = Array.isArray(items) ? items : []
        report.librarySeen = latestLibrary.map((item) => item.id)
      },
    })
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

      // THE LIBRARY'S TWO SEAMS, driven directly because that is what the pack's
      // client bundle uses: Excalidraw persists NOTHING by itself (its own hook
      // takes an adapter the host supplies), so the pack LOADS from what it stored
      // and SAVES what the change callback reports. This proves Excalidraw honours
      // both ends; check-client-bundles.mjs proves the pack's own half.
      report.seededFromInitialData = Array.isArray(report.librarySeen) && report.librarySeen.indexOf(SEED_ID) !== -1
      await api.updateLibrary({
        libraryItems: [{
          id: PROBE_ID,
          status: 'published',
          name: 'probe banner',
          elements: surface.convertToExcalidrawElements([{ type: 'rectangle', x: 0, y: 0, width: 300, height: 100, label: { text: 'probe', fontSize: 18 } }]),
          created: Date.now(),
        }],
        merge: true,
        openLibraryMenu: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 700))
      report.libraryCount = Array.isArray(report.librarySeen) ? report.librarySeen.length : null
      report.libraryHasProbe = Array.isArray(report.librarySeen) && report.librarySeen.indexOf(PROBE_ID) !== -1
      // A SECOND mount, from scratch, in a second pane: the pack's own persistence
      // is what makes the library survive a reload, and this proves the seam it
      // relies on - a fresh mount accepts the library it is handed and reports it
      // back through the change callback.
      const pane2 = document.createElement('div')
      pane2.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:120px;visibility:hidden'
      document.body.appendChild(pane2)
      const second = surface.mount(pane2, {
        theme: 'light',
        initialData: { libraryItems: latestLibrary },
        onLibraryChange: (items) => { report.secondLibrary = Array.isArray(items) ? items.map((item) => item.id) : [] },
      })
      await new Promise((resolve) => setTimeout(resolve, 2400))
      report.secondLibraryHasProbe = Array.isArray(report.secondLibrary) && report.secondLibrary.indexOf(PROBE_ID) !== -1
      try { second.root.unmount() } catch (err) { /* already gone */ }    }
    report.ok = true
  } catch (err) {
    report.errors.push(String(err && err.message ? err.message : err))
  }
  await post(report)
})()
</script></body></html>`

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-excalidraw-'))
  let reported = null
  /** Every face the editor asked for, in order: the end-to-end font evidence. */
  const fontRequests = []
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
    if (url.pathname.startsWith('/excalidraw/fonts/')) {
      // A FACE, on the path the editor builds for it: './fonts/<Family>/<file>'
      // resolved against '/excalidraw/'. Every request is COUNTED, because "the
      // editor really fetched a face" is the end-to-end fact this check exists for.
      const relative = url.pathname.slice('/excalidraw/fonts/'.length).split('/')
      const file = path.join(vendorDir, 'fonts', ...relative.map((part) => decodeURIComponent(part)))
      fontRequests.push(relative.join('/'))
      if (!existsSync(file)) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('no such face')
        return
      }
      const bytes = readFileSync(file)
      response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': String(bytes.length) })
      response.end(bytes)
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
    // THE LIBRARY, which is where the house examples go. Excalidraw persists
    // nothing on its own, so what is proved here is that it honours BOTH seams the
    // pack uses: it loads a library handed to it as `initialData`, and it reports
    // every change through `onLibraryChange` (which is what the pack saves).
    check('a library handed over as initialData is loaded', reported.seededFromInitialData, true)
    check('...and an item merged in later reaches the change callback', reported.libraryHasProbe, true)
    console.log('     the library reported ' + String(reported.libraryCount) + ' item(s)')
    // THE FACES, end to end: the editor resolved one through EXCALIDRAW_ASSET_PATH
    // and this server answered it from the vendored tree. Nothing is asserted about
    // WHICH face (that is the editor's business, and it depends on the glyphs on
    // screen) - only that the path it builds is the path this package serves, which
    // is the fact that would otherwise be a silent fallback.
    check('the editor fetched a face through its asset path', fontRequests.length > 0, true)
    check('...on the vendored path, not a 404', fontRequests.every((face) => vendoredFaces.has(face)), true)
    console.log('     faces fetched: ' + (fontRequests.length === 0 ? 'none' : [...new Set(fontRequests)].join(', ')))
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
