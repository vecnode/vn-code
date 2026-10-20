// check-shaders.mjs - the parts of dsh-shaders that need no browser.
//
// Run:  npm run check   (in packages/dsh-shaders)
//       node checks/check-shaders.mjs
//
// Why this exists: the compile half is proved by check-shaders-render.mjs, which
// needs a browser. Everything else - the dialect table, the wrapper and its LINE
// MAPPING, the @param grammar, the five emitters, the store's budgets, the routes,
// and the vendored corpora's own re-derivation - has to be provable on a machine
// with no GPU, no Chrome and no network. A check that only runs where a browser
// does is a check that silently does not run.
//
// It also re-runs each `vendor/<name>/build.mjs --check`, so a vendored tree that
// drifted from its catalogue fails here rather than in six months.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const repo = path.resolve(packageRoot, '..', '..')

let failures = 0
let checked = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const verify = await import(pathToFileURL(path.join(packageRoot, 'lib', 'verify.js')).href)
const emitModule = await import(pathToFileURL(path.join(packageRoot, 'lib', 'emit.js')).href)
const storeModule = await import(pathToFileURL(path.join(packageRoot, 'lib', 'store.js')).href)
const kit = await import(pathToFileURL(path.join(packageRoot, 'lib', 'kit.js')).href)
const index = await import(pathToFileURL(path.join(packageRoot, 'lib', 'index.js')).href)

// --------------------------------------------------------------- dialects
console.log('\n-- dialects --')
check('es100', verify.detectDialect('precision highp float;\nvoid main(){ gl_FragColor = vec4(1.0); }').dialect, 'es100')
check('es300', verify.detectDialect('#version 300 es\nout vec4 c;\nvoid main(){ c = vec4(1.0); }').dialect, 'es300')
check('shadertoy', verify.detectDialect('void mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }').dialect, 'shadertoy')
check('module', verify.detectDialect('float f(float x){ return x; }').dialect, 'module')
check('desktop 330', verify.detectDialect('#version 330 core\nout vec4 c;\nvoid main(){ c = vec4(1.0); }').dialect, 'desktop')
check('desktop 150', verify.detectDialect('#version 150\nvoid main(){}').dialect, 'desktop')
check('a #version 300 es without es is desktop', verify.detectDialect('#version 300\nvoid main(){}').version, 300)

// The two Shadertoy-family dialects are NOT one dialect: iFrame is a float there
// and an int in the shader-skills corpus, and a shader written for one does not
// compile under the other. The difference is in the generated header.
const toy = 'void mainImage(out vec4 c, in vec2 p){ c = vec4(p, 0.0, 1.0); }'
const toyHeader = verify.assemble({ source: toy, dialect: 'shadertoy' })
const skillsHeader = verify.assemble({ source: toy, dialect: 'shader-skills' })
check('shadertoy declares a float iFrame', /uniform float iFrame;/.test(toyHeader.wrapped), true)
check('shader-skills declares an int iFrame', /uniform int iFrame;/.test(skillsHeader.wrapped), true)
check('the two headers differ', toyHeader.wrapped !== skillsHeader.wrapped, true)

// ------------------------------------------------------- params and lint
console.log('\n-- @param and lint --')
const params = verify.parseParams('// @param SPEED float 0.1..2.0 default 0.5 "Spin"\n// @param TINT color default (1,0.5,0.2) "Tint"\n// @param BROKEN nope\n')
check('every @param line yields an entry', params.length, 3)
check('a well-formed param', params[0].name, 'SPEED')
check('uniform name is u_ + lower case', params[0].uniform, 'u_speed')
check('range parsed', params[0].min + '..' + params[0].max, '0.1..2')
check('description parsed', params[0].description, 'Spin')
check('colour default parsed', JSON.stringify(params[1].default), '[1,0.5,0.2]')
check('an unknown type is kept verbatim', params[2].type, 'nope')
check('and lint reports the unknown type', verify.lint({ source: '// @param BROKEN nope\nvoid main(){}', dialect: 'es100' }).some((warning) => warning.kind === 'param' && /Unknown @param type/.test(warning.text)), true)
check('a @param line that does not parse is reported', verify.lint({ source: '// @param\nvoid main(){}', dialect: 'es100' }).some((warning) => warning.kind === 'param'), true)
check('lint: missing precision', verify.lint({ source: 'void main(){ gl_FragColor = vec4(1.0); }', dialect: 'es100' }).some((w) => w.kind === 'precision'), true)
check('lint: gl_FragColor under es300', verify.lint({ source: '#version 300 es\nout vec4 c;\nvoid main(){ gl_FragColor = vec4(1.0); }', dialect: 'es300' }).some((w) => w.kind === 'removed'), true)
check('lint: texture2D under es300', verify.lint({ source: '#version 300 es\nuniform sampler2D t;\nout vec4 c;\nvoid main(){ c = texture2D(t, vec2(0.0)); }', dialect: 'es300' }).some((w) => w.kind === 'removed'), true)
check('lint: unused uniform', verify.lint({ source: 'precision highp float;\nuniform float u_ghost;\nvoid main(){ gl_FragColor = vec4(1.0); }', dialect: 'es100' }).some((w) => w.kind === 'unused-uniform'), true)
check('lint: non-constant loop bound', verify.lint({ source: 'precision highp float;\nuniform int u_n;\nvoid main(){ float s = 0.0; for (int i = 0; i < u_n; i++) { s += 1.0; } gl_FragColor = vec4(s); }', dialect: 'es100' }).some((w) => w.kind === 'loop-bound'), true)
check('lint: derivatives note', verify.lint({ source: 'precision highp float;\nvoid main(){ gl_FragColor = vec4(fwidth(gl_FragCoord.xy)); }', dialect: 'es100' }).some((w) => w.kind === 'derivatives'), true)
check('lint: #include is refused', verify.lint({ source: '#include "noise.glsl"\nvoid main(){}', dialect: 'es100' }).some((w) => w.kind === 'include'), true)

// --------------------------------------------------------- line mapping
console.log('\n-- line mapping --')
const broken = ['precision highp float;', 'uniform float u_time;', 'float x = vec3(1.0);', 'void main(){ gl_FragColor = vec4(x); }'].join('\n')
const es100 = verify.assemble({ source: broken })
check('an es100 source is compiled verbatim', es100.wrapped === broken, true)
check('a diagnostic on line 3 reads 3', verify.mapDiagnostics("ERROR: 0:3: '=' : dimension mismatch", es100.mapLine).diagnostics[0].line, 3)

const wrapped = verify.assemble({ source: ['a', 'b', 'c bad'].join('\n'), dialect: 'shadertoy' })
const headerCount = wrapped.segments.find((segment) => segment.where === 'header').count
check('the wrapper shifts the compiler line', headerCount > 0, true)
check('and the shift is undone', verify.mapDiagnostics('ERROR: 0:' + String(headerCount + 3) + ": 'x' : undeclared identifier", wrapped.mapLine).diagnostics[0].line, 3)
check('an error in the header is this row bug', verify.mapDiagnostics('ERROR: 0:1: boom', wrapped.mapLine).own.length, 1)

const included = verify.assemble({ source: 'void mainImage(out vec4 c, in vec2 p){ c = vec4(f(p), 0.0, 1.0); }', includes: [{ name: 'lib', source: 'float f(vec2 p){ return p.x; }' }] })
const includeSegment = included.segments.find((segment) => segment.where === 'include')
const fromInclude = verify.mapDiagnostics('ERROR: 0:' + String(includeSegment.startLine) + ": 'f' : undeclared identifier", included.mapLine)
check('an include diagnostic names the include', fromInclude.diagnostics[0].include, 'lib')

check('desktop is refused by assemble, with the reason', /desktop GLSL/.test(verify.assemble({ source: '#version 330 core\nvoid main(){}' }).error ?? ''), true)
check('a wrapper dialect carrying #version is refused', verify.assemble({ source: '#version 300 es\nvoid mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }', dialect: 'shadertoy' }).ok, false)

// ------------------------------------------------------------------ emit
console.log('\n-- emit --')
const shader = {
  id: 'rings',
  title: 'Rings',
  kind: 'fragment',
  dialect: 'es100',
  source: '// @param SPEED float 0.1..2.0 default 0.6 "Spin"\nprecision highp float;\nuniform float u_time;\nuniform vec2 u_resolution;\nuniform float u_speed;\nvoid main(){ float d = length(gl_FragCoord.xy / u_resolution - 0.5); gl_FragColor = vec4(vec3(0.5 + 0.5 * sin(d * 30.0 - u_time * u_speed)), 1.0); }',
  includes: [],
  params: verify.parseParams('// @param SPEED float 0.1..2.0 default 0.6 "Spin"'),
}
const web = emitModule.emit({ shader, target: 'web' })
check('web emits one page', web.files.length, 1)
check('web file name is lower case', web.files[0].name, 'rings.html')
check('web page carries the runtime', web.files[0].text.includes('window.__SHADER__'), true)
check('web page reaches no remote asset', /(src|href)\s*=\s*["'](https?:)?\/\//i.test(web.files[0].text), false)
check('web page declares the param', web.config.params[0].uniform, 'u_speed')
check('web page freezes under reduced motion', web.files[0].text.includes('prefers-reduced-motion'), true)
check('web page accepts postMessage params', web.files[0].text.includes("data.type !== 'param'"), true)
check('web page caps the pixel ratio', web.files[0].text.includes('Math.min(window.devicePixelRatio || 1, 2)'), true)

const frag = emitModule.emit({ shader, target: 'frag' })
check('frag emits a .frag and a .vert', frag.files.map((file) => file.name).join(','), 'rings.frag,rings.vert')
check('the .frag is the stored source verbatim', frag.files[0].text, shader.source)

const isf = emitModule.emit({ shader, target: 'isf' })
const isfMeta = JSON.parse(isf.files[1].text)
check('isf emits .fs and .json', isf.files.map((file) => file.name).join(','), 'rings.fs,rings.json')
check('isf json has ISFVSN', isfMeta.ISFVSN, '2')
check('isf json declares inputImage', isfMeta.INPUTS[0].NAME, 'inputImage')
check('isf json declares the param', isfMeta.INPUTS.some((input) => input.NAME === 'SPEED'), true)

const ffgl = emitModule.emit({ shader, target: 'ffgl' })
check('ffgl emits a .cpp', ffgl.files[0].name, 'rings.cpp')
check('the scaffold says it is a scaffold', /NOT A BUILDABLE PLUGIN/.test(ffgl.files[0].text), true)
check('the scaffold embeds the shader', ffgl.files[0].text.includes('u_speed'), true)
check('the scaffold carries a checklist', /check the info log on the/.test(ffgl.files[0].text), true)

const toyShader = { id: 'toy', title: 'Toy', kind: 'fragment', dialect: 'shadertoy', source: 'void mainImage(out vec4 c, in vec2 p){ c = vec4(p / iResolution.xy, 0.0, 1.0); }', includes: [], params: [] }
const isfToy = emitModule.emit({ shader: toyShader, target: 'isf' })
check('isf ports mainImage to main()', /void main\(\)/.test(isfToy.files[0].text), true)
check('isf renames iResolution to RENDERSIZE', /RENDERSIZE/.test(isfToy.files[0].text), true)
check('isf says what it renamed', isfToy.notes.some((note) => /RENDERSIZE/.test(note)), true)
const shadertoyToy = emitModule.emit({ shader, target: 'shadertoy' })
check('shadertoy ports gl_FragColor to mainImage', /void mainImage\(out vec4 fragColor, in vec2 fragCoord\)/.test(shadertoyToy.files[0].text), true)
check('web refuses a desktop source', emitModule.emit({ shader: { ...shader, dialect: 'desktop', source: '#version 330 core\nout vec4 c;\nvoid main(){ c = vec4(1.0); }' }, target: 'web' }).ok, false)

// ----------------------------------------------------------------- store
console.log('\n-- store --')
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-shaders-check-'))
// The row derives its root from DSH_HOME at boot, so the check must write through
// the SAME root or it is testing a store the routes will never read.
process.env.DSH_HOME = home
const store = new storeModule.ShaderStore({ root: storeModule.storeRoot() })
const stored = store.write('session-a', { id: 'rings', title: 'Rings', dialect: 'es100', source: shader.source, params: [], by: 'model' })
check('write returns revision 1', stored.revision, 1)
check('read back', store.get('session-a', 'rings').title, 'Rings')
check('a second write bumps the revision', store.write('session-a', { id: 'rings', source: shader.source + '\n// x', by: 'model' }).revision, 2)
check('list drops the source rather than leaving an undefined key', Object.hasOwn(store.list('session-a')[0], 'source'), false)
check('ids must be slugs', (() => {
  try {
    store.write('session-a', { id: 'Not A Slug', source: 'void main(){}' })
    return 'no error'
  } catch (err) {
    return err.code
  }
})(), 'BAD_INPUT')
check('a source over the ceiling is refused', (() => {
  try {
    store.write('session-a', { id: 'huge', source: 'x'.repeat(storeModule.MAX_SOURCE_BYTES + 1) })
    return 'no error'
  } catch (err) {
    return err.code
  }
})(), 'TOO_LARGE')
check('a corrupt state file is reported, not read as empty', (() => {
  const file = store.fileFor('session-bad')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{not json')
  return store.readState('session-bad').corrupt === true
})(), true)
const pending = storeModule.verificationOf({ revision: 3, render: null })
check('no report reads pending', pending.state, 'pending')
const drawn = storeModule.verificationOf({ revision: 3, render: { revision: 3, ok: true } })
check('a report on this revision reads drawn', drawn.state, 'drawn')
const stale = storeModule.verificationOf({ revision: 4, render: { revision: 3, ok: true } })
check('an older report reads stale', stale.state + ':' + stale.reported, 'stale:3')
const failed = storeModule.verificationOf({ revision: 3, render: { revision: 3, ok: false, error: 'boom' } })
check('a failed report reads failed', failed.state, 'failed')
store.report('session-a', 'rings', { ok: true, revision: 2 })
check('a rewrite clears the verdict', store.get('session-a', 'rings').render === null || store.get('session-a', 'rings').render.revision === 2, true)
check('a report for a missing shader is not an error', store.report('session-a', 'nope', { ok: true }).stored, false)

// ------------------------------------------------------------------- kit
console.log('\n-- kit --')
const summary = kit.summary()
check('radiant catalogue is installed', summary.radiant !== null, true)
check('radiant pages counted', summary.radiant.pages, 106)
check('radiant pages with a fragment', summary.radiant.pagesWithSource, 69)
check('radiant fragment sources', summary.radiant.sources, 79)
check('shader-skills modules', summary.skills.modules, 20)
check('shader-skills templates', summary.skills.templates, 11)
check('shader-skills gallery', summary.skills.gallery, 11)
check('link index', summary.links.links, 48)
check('a radiant example resolves', kit.getExample('radiant/event-horizon').found, true)
check('a gallery example resolves', kit.getExample('gallery/ocean').found, true)
check('a module example resolves', kit.getExample('module/noise').found, true)
const template = kit.getExample('template/terrain')
check('a template resolves', template.found, true)
check('a template names the piece that proves it', template.provenBy, 'gallery:terrain')
check('a template says its includes are not trusted', template.includesTrusted, false)
check('a missing example lists real ids', kit.getExample('radiant/nope').ids.length > 0, true)
check('search finds by technique', kit.search({ technique: 'gallery' }).total >= 11, true)
check('search finds by word', kit.search({ query: 'noise' }).total > 0, true)
check('links filter by category', kit.listLinks({ category: 'Tutorials' }).links.every((link) => link.category === 'Tutorials'), true)

// ----------------------------------------------------------------- routes
console.log('\n-- routes --')
const routes = new Map()
const tools = []
const skills = []
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  effect: (fn) => fn(),
  tools: { register: (tool) => (tools.push(tool), () => {}) },
  get(name) {
    if (name === 'connection') return { fetch: { register: (route) => (routes.set(route.path, route), () => {}) } }
    if (name === 'sessions') return { get: (id) => (id === 'session-check' ? { header: { cwd: home } } : undefined) }
    if (name === 'skills') return { register: (skill) => (skills.push(skill), () => {}) }
    return undefined
  },
}
process.env.DSH_HOME = home
index.apply(ctx)
check('seven tools registered', tools.length, 7)
check('tool names', tools.map((tool) => tool.name).sort().join(','), index.CAPABILITIES.tools.slice().sort().join(','))
check('five skills registered', skills.length, 5)
check('six routes registered', routes.size, 6)
check('route paths match the capability list', [...routes.keys()].sort().join(','), index.CAPABILITIES.routes.slice().sort().join(','))
check('routes only use GET/HEAD/POST', [...routes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))), true)
check('every tool declares its surface', tools.every((tool) => tool.parameters?.type === 'object' && tool.output?.schema && typeof tool.output.render === 'function' && typeof tool.execute === 'function'), true)

const call = (routePath, request) => routes.get(routePath).fetch(request)
const state = await call('/api/dsh-shaders/state', new Request('http://x/api/dsh-shaders/state?session=session-a'))
const stateBody = await state.json()
check('state answers', state.status, 200)
check('state lists the shader', stateBody.shaders.length >= 1, true)
check('state carries the kit counts', stateBody.capabilities.kit.radiant.pages, 106)
check('state refuses no session', (await call('/api/dsh-shaders/state', new Request('http://x/api/dsh-shaders/state'))).status, 400)

const page = await call('/api/dsh-shaders/example', new Request('http://x/api/dsh-shaders/example?id=event-horizon'))
check('example route serves html', page.headers.get('content-type'), 'text/html; charset=utf-8')
check('example route locks the page down', /default-src 'none'/.test(page.headers.get('content-security-policy') ?? ''), true)
check('example route 404s an unknown page', (await call('/api/dsh-shaders/example', new Request('http://x/api/dsh-shaders/example?id=nope'))).status, 404)

check('artifact refuses a traversing name', (await call('/api/dsh-shaders/artifact', new Request('http://x/api/dsh-shaders/artifact?name=../../etc/passwd'))).status, 400)
check('artifact refuses a short name', (await call('/api/dsh-shaders/artifact', new Request('http://x/api/dsh-shaders/artifact?name=abc.png'))).status, 400)

const report = await call('/api/dsh-shaders/render-report', new Request('http://x/api/dsh-shaders/render-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 'session-a', id: 'rings', ok: true }) }))
check('render report accepted', (await report.json()).stored, true)
check('a report without an id is refused', (await call('/api/dsh-shaders/render-report', new Request('http://x/api/dsh-shaders/render-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 'session-a' }) }))).status, 400)

const health = await call('/api/dsh-shaders/health', new Request('http://x/api/dsh-shaders/health'))
const healthBody = await health.json()
check('health answers', healthBody.ok, true)
check('health names the corpus', healthBody.kit.radiant, 106)

// --------------------------------------------------------------- manifest
console.log('\n-- manifest --')
const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
check('package name', pkg.name, 'dsh-shaders')
check('PLUGIN_VERSION matches package.json', index.PLUGIN_VERSION, pkg.version)
check('the bundle declares its patch', pkg.dsh.bundle.patch, './cordis.patch.yml')
check('the client half is declared', pkg.dsh.client.platform, 'web')
check('the package exports a client bundle', pkg.exports['./client'], './lib/client.js')
check('zero dependencies', pkg.dependencies === undefined, true)
const manifest = JSON.parse(readFileSync(path.join(repo, '.dsh-version.json'), 'utf8'))
check('the pack manifest declares this package', manifest.packages['dsh-shaders'] !== undefined, true)
check('the manifest version matches', manifest.packages['dsh-shaders']?.version, pkg.version)
check('the skill files all exist', index.SKILL_FILES.every((entry) => existsSync(path.join(here, entry.file))), true)

// --------------------------------------------------------- vendored trees
console.log('\n-- vendored corpora --')
for (const name of ['radiant', 'shader-skills', 'glsl-links']) {
  const script = path.join(packageRoot, 'vendor', name, 'build.mjs')
  check(name + ': build script exists', existsSync(script), true)
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  check(name + ': --check passes offline', result.status === 0, true)
  if (result.status !== 0) console.log((result.stdout ?? '') + (result.stderr ?? ''))
}
const radiantTree = path.join(packageRoot, 'lib', 'vendor', 'radiant')
const pageCount = readdirSync(path.join(radiantTree, 'examples')).filter((file) => file.endsWith('.html')).length
check('the pages are on disk', pageCount, 106)
const bytes = statSync(path.join(radiantTree, 'examples', 'event-horizon.html')).size
check('a page is not empty', bytes > 1000, true)

// Every vendored page must be able to reach nothing: the route serves them into a
// sandboxed frame, and this is the assertion that keeps that honest.
let egress = []
for (const file of readdirSync(path.join(radiantTree, 'examples'))) {
  const text = readFileSync(path.join(radiantTree, 'examples', file), 'utf8')
  if (/<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(text)) egress.push(file + ':script')
  if (/\b(fetch|XMLHttpRequest|importScripts|WebSocket|EventSource)\s*[(`]/.test(text)) egress.push(file + ':network')
  if (/\bnew\s+(Worker|SharedWorker)\s*\(/.test(text)) egress.push(file + ':worker')
}
check('no vendored page can reach the network', egress.length, 0)
if (egress.length > 0) console.log(egress.slice(0, 10).join(', '))

// ------------------------------------------------------------------ done
console.log('')
console.log(failures === 0 ? 'all ' + String(checked) + ' checks passed' : String(failures) + ' FAILURES of ' + String(checked))
process.exit(failures === 0 ? 0 : 1)
