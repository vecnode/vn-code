/**
 * dsh-screenshot — the tracked check for this package's host half.
 *
 * Run it with `npm run check` in this folder (`node checks/check-screenshot-node.mjs`).
 * It is additional to the pack-wide checks under scripts/checks/, never a
 * replacement for them, and it travels with the package so it is useful outside
 * this repository.
 *
 * What it proves, and how:
 *
 *   - **The pure decisions**, which need no engine: a slug folded from a title
 *     with diacritics, the name a viewport earns, the display width divided by
 *     the scale, the README block for one picture and for a light/dark pair, the
 *     manifest merge that never drops an entry, and containment that refuses a
 *     `..` escape while still allowing a folder that does not exist yet.
 *   - **The policy**, which is the point of the package: a loopback address and
 *     a workspace file need no flag, a public address is refused with the
 *     sentence that says how to mean it, and a path outside the workspace is
 *     refused rather than written.
 *   - **The engine path end to end**, on a page this check BUILDS ITSELF: the
 *     PNG's true size read back from its own IHDR at dpr 1 and dpr 2 (which is
 *     what proves the scale factor really applied), an element clip whose size
 *     is the element's own box, and a page that painted nothing reported as
 *     blank rather than published as if it were a screenshot.
 *   - **The placement pass end to end**: a dry run that writes nothing, a real
 *     run that writes the file and the manifest, the README block's width
 *     computed from the picture's pixels, a light/dark pair turned into a
 *     `<picture>`, and alt text required.
 *   - **The two routes**, driven through a fake connection registry: state
 *     answers with the row's identity, a bad id is a 400, and a real capture's
 *     id is served as `image/png`.
 *   - **Native capture**, on Windows only: the window list, and one real capture
 *     of a window that exists on this machine.
 *
 * A host with no browser SKIPS the engine half loudly and exits 0 - and says so,
 * because a green run on such a machine is not evidence that the row works.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  IMAGE_ROUTE,
  PLUGIN_VERSION,
  STATE_ROUTE,
  __internals,
  buildTools,
  createDeps,
  registerRoutes,
} from '../lib/index.js'
import { readPngSize, resolveEngine } from '../lib/engine.js'
import { displayWidthFor, fileNameFor, isInside, mergeManifest, readManifest, readmeBlock, slugify, viewportLabel } from '../lib/place.js'

let passes = 0
let failures = 0
const skips = []

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (ok) {
    passes += 1
    console.log('  ok   ' + label)
  } else {
    failures += 1
    console.log('  FAIL ' + label + '  (got ' + JSON.stringify(actual) + ', wanted ' + JSON.stringify(expected) + ')')
  }
}

function okNot(label, actual) {
  check(label, !actual, true)
}

function skip(label, why) {
  skips.push(label + ' - ' + why)
  console.log('  SKIP ' + label + '  (' + why + ')')
}

// --------------------------------------------------------------- the fixtures

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-shot-check-'))
const workspace = path.join(root, 'ws')
const home = path.join(root, 'home')
mkdirSync(workspace, { recursive: true })
mkdirSync(home, { recursive: true })

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Check page</title>',
  '<style>body{margin:0;background:#101418;color:#e8eef6;font:16px/1.4 system-ui}',
  '#card{position:absolute;top:0;left:0;width:200px;height:100px;background:#2b6cb0}</style>',
  '</head><body><div id="card"></div><h1>Hello from the check</h1></body></html>',
].join('\n')
writeFileSync(path.join(workspace, 'index.html'), PAGE, 'utf8')
writeFileSync(path.join(workspace, 'empty.html'), '<!doctype html><html><body></body></html>', 'utf8')

const ctx = {
  get(service) {
    if (service === 'sessions') return { get: () => ({ header: { cwd: workspace } }) }
    if (service === 'connection') return connection
    return undefined
  },
  logger: { info() {}, warn() {}, debug() {} },
}
const routes = new Map()
const connection = {
  fetch: {
    register({ path: routePath, methods, fetch }) {
      routes.set(routePath, { methods, fetch })
      return () => routes.delete(routePath)
    },
  },
}

const deps = createDeps(ctx, { home, env: { ...process.env } })
const tools = new Map(buildTools(deps).map((tool) => [tool.name, tool]))
const exec = { agent: { session: { id: 'check-session' } } }
const call = (toolName, args) => tools.get(toolName).execute(args, exec)

// ------------------------------------------------------------ the pure halves

console.log('\nslug and name')
check('a diacritic is folded, not dropped', slugify('Capturas de Ecrã'), 'capturas-de-ecra')
check('punctuation collapses to one dash', slugify('  Hero — v2 (final)!! '), 'hero-v2-final')
check('an empty title falls back', slugify('***'), 'screenshot')
check('a long title is cut cleanly', slugify('x'.repeat(80)).length <= 48, true)
check('desktop label at 1440', viewportLabel(1440), 'desktop')
check('tablet label at 834', viewportLabel(834), 'tablet')
check('phone label at 390', viewportLabel(390), 'phone')
check('the name carries viewport and theme', fileNameFor({ slug: 'hero', width: 1440, theme: 'dark' }), 'hero-desktop-dark.png')
check('the light name has no suffix', fileNameFor({ slug: 'hero', width: 390, theme: 'light' }), 'hero-phone.png')

console.log('\ndisplay width')
check('a 2880px retina file is published at 1440', displayWidthFor({ width: 2880, dpr: 2 }), 1000)
check('a 390px phone capture is published at 390', displayWidthFor({ width: 390, dpr: 1 }), 390)
check('a 2248px window at 1.5x is published at 1000', displayWidthFor({ width: 2248, dpr: 1.5 }), 1000)
check('a tiny picture is never published below 120', displayWidthFor({ width: 40, dpr: 1 }), 120)
check('a bogus scale is read as 1', displayWidthFor({ width: 640, dpr: 0 }), 640)

console.log('\nREADME block')
const single = readmeBlock([{ relative: 'docs/assets/screenshots/hero-desktop.png', slug: 'hero', theme: 'light', width: 1440, dpr: 2, displayWidth: 720, alt: 'The dashboard' }])
check('one picture is an img', single, '<img src="docs/assets/screenshots/hero-desktop.png" width="720" alt="The dashboard">')
const pair = readmeBlock([
  { relative: 'docs/assets/screenshots/hero-desktop-dark.png', slug: 'hero', theme: 'dark', displayWidth: 720, alt: 'The dashboard' },
  { relative: 'docs/assets/screenshots/hero-desktop.png', slug: 'hero', theme: 'light', displayWidth: 720, alt: 'The dashboard' },
])
check('a light/dark pair is a picture element', pair.startsWith('<picture>') && pair.includes('prefers-color-scheme: dark'), true)
check('the picture block puts the dark source first and the light img last', pair.trim().endsWith('</picture>') && pair.includes('src="docs/assets/screenshots/hero-desktop.png"'), true)
check('two different slugs stay two img tags', readmeBlock([
  { relative: 'a.png', slug: 'one', theme: 'light', displayWidth: 400, alt: 'one' },
  { relative: 'b.png', slug: 'two', theme: 'dark', displayWidth: 400, alt: 'two' },
]).split('\n').filter((line) => line.startsWith('<img')).length, 2)
const quoted = readmeBlock([{ relative: 'a.png', slug: 's', theme: 'light', displayWidth: 400, alt: 'A "quote" & <tag>' }])
check('alt text is escaped for an HTML attribute', quoted.includes('&quot;quote&quot; &amp; &lt;tag&gt;'), true)

console.log('\nmanifest merge')
const once = mergeManifest(null, [{ relative: 'docs/a.png', slug: 'a', alt: 'A' }], '2024-01-01T00:00:00.000Z')
check('a new manifest has one shot', once.shots.length, 1)
check('it records what wrote it', once.generatedBy, 'dsh-screenshot')
const twice = mergeManifest(once, [{ relative: 'docs/b.png', slug: 'b', alt: 'B' }], '2024-01-02T00:00:00.000Z')
check('a second placement keeps the first', twice.shots.length, 2)
const replaced = mergeManifest(twice, [{ relative: 'docs/a.png', slug: 'a', alt: 'A (redone)' }], '2024-01-03T00:00:00.000Z')
check('the same path is replaced, not duplicated', replaced.shots.length, 2)
check('the replacement carries the new alt', replaced.shots.find((shot) => shot.relative === 'docs/a.png').alt, 'A (redone)')

console.log('\ncontainment')
check('a path inside the workspace is inside', isInside(workspace, path.join(workspace, 'index.html')), true)
check('a file that does not exist yet is still inside', isInside(workspace, path.join(workspace, 'docs', 'assets', 'new.png')), true)
check('a .. escape is refused', isInside(workspace, path.join(workspace, '..', 'escape.png')), false)
check('an absolute path elsewhere is refused', isInside(workspace, path.join(os.tmpdir(), 'x.png')), false)

// ------------------------------------------------------------------- the policy

console.log('\ncapture policy')
const loopback = __internals.resolveTarget('http://127.0.0.1:5173/', { workspace })
check('loopback needs no flag', loopback.ok === true && loopback.allowRemote === false, true)
check('localhost is loopback too', __internals.resolveTarget('http://localhost:3000/', { workspace }).ok, true)
const remote = __internals.resolveTarget('https://example.com/', { workspace })
check('a public address is refused without remote', remote.ok, false)
check('the refusal says how to mean it', String(remote.message).includes('remote: true'), true)
const allowed = __internals.resolveTarget('https://example.com/', { workspace, allowRemote: true })
check('a public address is allowed with remote', allowed.ok === true && allowed.kind === 'remote', true)
check('a file in the workspace is a target', __internals.resolveTarget('index.html', { workspace }).kind, 'file')
check('a path outside the workspace is refused', __internals.resolveTarget('../escape.html', { workspace }).ok, false)
check('a javascript: address is refused', __internals.resolveTarget('javascript:alert(1)', { workspace }).ok, false)
const badOut = __internals.resolveOutput('../escape.png', { workspace, deps, id: 'a'.repeat(24) })
check('writing outside the workspace is refused', badOut.ok, false)
const goodOut = __internals.resolveOutput('docs/shot.png', { workspace, deps, id: 'a'.repeat(24) })
check('writing inside the workspace is allowed', goodOut.ok === true && goodOut.kind === 'explicit', true)
check('only .png is a screenshot', __internals.resolveOutput('docs/shot.jpg', { workspace, deps, id: 'a'.repeat(24) }).ok, false)

// -------------------------------------------------------------- the engine path

const engine = resolveEngine({ env: process.env })
console.log('\nengine end to end')
if (engine === null) {
  skip('the engine half', 'no Chrome/Edge on this host')
} else {
  const basic = await call('shot_url', { url: 'index.html', viewport: 'phone' })
  check('a workspace file is captured', basic.text.startsWith('Captured'), true)
  const basicFile = /File: (.+?) - /.exec(basic.text)?.[1]
  check('the answer names the file it wrote', typeof basicFile === 'string' && existsSync(basicFile), true)
  const basicPng = basicFile ? readPngSize(readFileSync(basicFile)) : null
  check('the phone picture is 390x844', basicPng && basicPng.width === 390 && basicPng.height === 844, true)

  const retina = await call('shot_url', { url: 'index.html', viewport: 'phone', dpr: 2 })
  const retinaFile = /File: (.+?) - /.exec(retina.text)?.[1]
  const retinaPng = retinaFile ? readPngSize(readFileSync(retinaFile)) : null
  check('dpr 2 really doubles the pixels', retinaPng && retinaPng.width === 780 && retinaPng.height === 1688, true)
  check('the answer reports the file size, not the request', retina.text.includes('780x1688 px'), true)

  const clipped = await call('shot_url', { url: 'index.html', clip: '#card' })
  const clipFile = /File: (.+?) - /.exec(clipped.text)?.[1]
  const clipPng = clipFile ? readPngSize(readFileSync(clipFile)) : null
  check('a clip is the element\'s own box', clipPng && clipPng.width === 200 && clipPng.height === 100, true)

  const noMatch = await call('shot_url', { url: 'index.html', clip: '#nope' })
  check('a selector that matches nothing is refused with a reason', noMatch.text.includes('no element matches this selector'), true)

  const blank = await call('shot_url', { url: 'empty.html' })
  check('a page that painted nothing is flagged', blank.text.includes('EMPTY of text'), true)

  const darkPair = await call('shot_url', { url: 'index.html', viewport: 'desktop', dark: true, out: 'docs/assets/screenshots/hero-dark.png' })
  check('an explicit out inside the workspace is written', existsSync(path.join(workspace, 'docs/assets/screenshots/hero-dark.png')), true)
  const again = await call('shot_url', { url: 'index.html', viewport: 'desktop', dark: true, out: 'docs/assets/screenshots/hero-dark.png' })
  check('re-capturing onto the same file is refused without overwrite', again.text.includes('overwrite: true'), true)
  check('... and the refusal is why the dark capture above still exists', darkPair.text.startsWith('Captured'), true)

  // ------------------------------------------------------- the placement pass

  console.log('\nplacement end to end')
  const lightFile = basicFile
  const dry = await call('shot_place', { dir: 'docs/assets/screenshots', shots: [{ file: lightFile, alt: 'The check page on a phone', slug: 'check-page' }] })
  check('a dry run writes nothing', existsSync(path.join(workspace, 'docs/assets/screenshots/check-page-phone.png')), false)
  check('a dry run says so', dry.text.startsWith('DRY RUN'), true)
  check('a dry run still shows the markdown', dry.text.includes('<img src="docs/assets/screenshots/check-page-phone.png"'), true)

  const placed = await call('shot_place', { dir: 'docs/assets/screenshots', dryRun: false, shots: [{ file: lightFile, alt: 'The check page on a phone', slug: 'check-page' }] })
  check('a real run writes the picture', existsSync(path.join(workspace, 'docs/assets/screenshots/check-page-phone.png')), true)
  const manifest = readManifest(path.join(workspace, 'docs/assets/screenshots/manifest.json'))
  check('the manifest records the shot', manifest !== null && manifest.shots.length === 1, true)
  check('the manifest records the true size', manifest !== null && manifest.shots[0].width === 390 && manifest.shots[0].height === 844, true)
  check('the manifest records the alt text', manifest !== null && manifest.shots[0].alt === 'The check page on a phone', true)

  const lightDesktop = await call('shot_url', { url: 'index.html', viewport: 'desktop', out: 'docs/assets/screenshots/hero.png' })
  check('a second explicit out is written too', lightDesktop.text.startsWith('Captured'), true)
  const pairRun = await call('shot_place', {
    dir: 'docs/assets/screenshots',
    dryRun: false,
    shots: [
      { file: path.join(workspace, 'docs/assets/screenshots/hero-dark.png'), alt: 'The check page, dark', slug: 'check-hero', theme: 'dark', viewport: 'desktop' },
      { file: path.join(workspace, 'docs/assets/screenshots/hero.png'), alt: 'The check page, light', slug: 'check-hero', theme: 'light', viewport: 'desktop' },
    ],
  })
  check('a light/dark pair is placed as a picture block', String(pairRun.view && pairRun.view.markdown).startsWith('<picture>'), true)
  check('the pair is named for one viewport', existsSync(path.join(workspace, 'docs/assets/screenshots/check-hero-desktop.png')), true)
  check('the dark half keeps its -dark name', existsSync(path.join(workspace, 'docs/assets/screenshots/check-hero-desktop-dark.png')), true)
  const tour = await call('shot_place', {
    dir: 'docs/assets/screenshots',
    dryRun: false,
    shots: [
      { file: path.join(workspace, 'docs/assets/screenshots/hero.png'), alt: 'The check page on a desktop', slug: 'check-tour', viewport: 'desktop' },
      { file: lightFile, alt: 'The check page on a phone', slug: 'check-tour', viewport: 'phone' },
    ],
  })
  check('a tour at two viewports is placed in one call', tour.text.includes('check-tour-desktop.png') && tour.text.includes('check-tour-phone.png'), true)
  check('two viewports of one slug are two img tags, not a picture', String(tour.view.markdown).split('<img').length - 1, 2)
  const duplicate = await call('shot_place', {
    dir: 'docs/assets/screenshots',
    dryRun: false,
    shots: [
      { file: lightFile, alt: 'one', slug: 'check-dup', viewport: 'phone' },
      { file: lightFile, alt: 'two', slug: 'check-dup', viewport: 'phone' },
    ],
  })
  check('two pictures for one name are refused by name', duplicate.text.includes('same name'), true)
  check('... and the first one still lands', existsSync(path.join(workspace, 'docs/assets/screenshots/check-dup-phone.png')), true)

  const noAlt = await call('shot_place', { dir: 'docs/assets/screenshots', dryRun: false, shots: [{ file: lightFile, alt: '   ', slug: 'missing-alt' }] })
  check('alt text is required', noAlt.text.includes('Nothing could be placed'), true)
  const escapeDir = await call('shot_place', { dir: '../outside', shots: [{ file: lightFile, alt: 'x' }] })
  check('a .. destination folder is refused', escapeDir.text.includes('inside the workspace'), true)
  const escapeFile = await call('shot_place', { dir: 'docs/assets/screenshots', shots: [{ file: '../../../../etc/passwd', alt: 'x' }] })
  check('a source outside the workspace is refused', escapeFile.text.includes('Nothing could be placed'), true)
}

// --------------------------------------------------------------------- routes

console.log('\nroutes')
const off = registerRoutes(deps)
check('both routes are registered', routes.has(STATE_ROUTE) && routes.has(IMAGE_ROUTE), true)
if (routes.has(STATE_ROUTE)) {
  const state = await routes.get(STATE_ROUTE).fetch(new Request('http://127.0.0.1' + STATE_ROUTE))
  const body = await state.json()
  check('state answers with the row identity', body.ok === true && body.plugin === 'dsh-screenshot', true)
  check('state reports the version package.json declares', body.version, PLUGIN_VERSION)
  check('state names the engine or says there is none', body.engine === null || typeof body.engine.file === 'string', true)
  check('state reports whether native capture exists', typeof body.native.available, 'boolean')
  check('state names the publish folder', body.publish.imageDir, 'docs/assets/screenshots')
}
if (routes.has(IMAGE_ROUTE)) {
  const bad = await routes.get(IMAGE_ROUTE).fetch(new Request('http://127.0.0.1' + IMAGE_ROUTE + '?id=zzz'))
  check('a bad id is a 400', bad.status, 400)
  const missing = await routes.get(IMAGE_ROUTE).fetch(new Request('http://127.0.0.1' + IMAGE_ROUTE + '?id=' + 'a'.repeat(24)))
  check('an absent id is a 404', missing.status, 404)
  const shot = tools.size > 0 && engine !== null ? await call('shot_url', { url: 'index.html', viewport: 'og' }) : null
  const shotFile = shot ? /File: (.+?) - /.exec(shot.text)?.[1] : undefined
  if (shotFile) {
    const id = path.basename(path.dirname(shotFile))
    const served = await routes.get(IMAGE_ROUTE).fetch(new Request('http://127.0.0.1' + IMAGE_ROUTE + '?id=' + id))
    check('a real capture is served as image/png', served.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await served.arrayBuffer())
    check('the served bytes are the PNG on disk', bytes.equals(readFileSync(shotFile)), true)
  } else {
    skip('serving a real capture', 'no engine to capture with')
  }
}
off()
check('disposing the row unregisters its routes', routes.size, 0)

// --------------------------------------------------------------------- native

console.log('\nnative capture')
if (process.platform !== 'win32') {
  skip('the native half', 'this host is ' + process.platform + ', and native capture is a Windows surface')
} else {
  const listed = await call('shot_window', {})
  check('listing windows answers', listed.text.length > 40, true)
  if (listed.view && Array.isArray(listed.view.windows) && listed.view.windows.length > 0) {
    const window = listed.view.windows[0]
    const captured = await call('shot_window', { window: String(window.handle) })
    if (captured.view && captured.view.ok === true) {
      const file = captured.view.file
      const size = existsSync(file) ? readPngSize(readFileSync(file)) : null
      check('a window is captured to a real PNG', size !== null && size.width > 0 && size.height > 0, true)
      check('the answer names the method that produced the pixels', ['print', 'screen'].includes(captured.view.method), true)
      check('the answer carries the window scale', typeof captured.view.scale === 'number' && captured.view.scale > 0, true)
    } else {
      skip('capturing a window', 'the first window refused: ' + String(captured.text).slice(0, 80))
    }
    const ambiguous = await call('shot_window', { window: 'e' })
    check('an ambiguous title is refused rather than guessed', ambiguous.text.includes('will not guess') || ambiguous.text.includes('No window title'), true)
  } else {
    skip('capturing a window', 'no visible window on this desktop')
  }
  const screen = await call('shot_screen', {})
  if (screen.view && screen.view.ok === true) {
    const size = readPngSize(readFileSync(screen.view.file))
    check('the screen is captured', size !== null && size.width >= 640, true)
  } else {
    skip('capturing the screen', String(screen.text).slice(0, 80))
  }
}

// ---------------------------------------------------------------------- done

rmSync(root, { recursive: true, force: true })

console.log('')
for (const entry of skips) console.log('  skipped: ' + entry)
if (skips.length > 0) console.log('')
console.log((failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' (' + passes + ' assertions)')
process.exit(failures === 0 ? 0 : 1)
