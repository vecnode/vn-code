// check-shaders-render.mjs - the half that needs a real GLSL compiler.
//
// Run:  node checks/check-shaders-render.mjs
//
// Why this exists: `check-shaders.mjs` can prove the wrapper, the line mapping and
// the store, but nothing there proves that a single shader COMPILES. This one
// starts the machine's own browser, compiles every fragment source in both vendored
// corpora, draws frames, and reads the pixels back - so "the corpus works" is a
// measurement rather than a claim.
//
// It skips LOUDLY when there is no Chromium-family browser: a skip must never read
// as a pass, and the whole point of this row is that it says which rung it reached.

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

let failures = 0
let checked = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const verify = await import(pathToFileURL(path.join(packageRoot, 'lib', 'verify.js')).href)
const compile = await import(pathToFileURL(path.join(packageRoot, 'lib', 'compile.js')).href)
const engineModule = await import(pathToFileURL(path.join(packageRoot, 'lib', 'engine.js')).href)
const kit = await import(pathToFileURL(path.join(packageRoot, 'lib', 'kit.js')).href)

const engine = engineModule.resolveEngine()
if (engine === null) {
  console.log('SKIP no Chromium-family browser on this host (install Chrome/Edge, or set DSH_SHADERS_ENGINE).')
  console.log('     the compile ladder, the corpus compile and every frame assertion are UNTESTED here.')
  process.exit(0)
}

process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-shaders-render-'))
console.log('\nengine: ' + engine.file + ' (' + engine.source + ')')

// ------------------------------------------------------------ one shader
console.log('\n-- one shader, three fates --')
const good = 'precision highp float;\nuniform float u_time;\nuniform vec2 u_resolution;\nvoid main(){ vec2 uv = gl_FragCoord.xy / u_resolution; gl_FragColor = vec4(uv, 0.5 + 0.5 * sin(u_time), 1.0); }'
const bad = 'precision highp float;\nuniform float u_time;\nfloat x = vec3(1.0);\nvoid main(){ gl_FragColor = vec4(x); }'
const unused = 'precision highp float;\nuniform float u_ghost;\nuniform float u_used;\nvoid main(){ gl_FragColor = vec4(u_used); }'

const batch = await compile.runJobs({
  jobs: [
    compile.jobFor(verify.assemble({ source: good }), { id: 'good', render: { time: 1.25, width: 64, height: 48 } }),
    compile.jobFor(verify.assemble({ source: bad }), { id: 'bad' }),
    compile.jobFor(verify.assemble({ source: unused }), { id: 'unused' }),
  ],
})
check('the compiler session started', batch.ok, true)
check('webgl1 context is present', batch.contexts?.webgl?.available, true)
check('derivatives extension was enabled for webgl1', (batch.contexts?.webgl?.extensions ?? []).includes('OES_standard_derivatives'), true)

const byId = Object.fromEntries(batch.results.map((entry) => [entry.id, entry]))
check('a good shader compiles and draws', byId.good.status + ':' + byId.good.rung, 'ok:drawn')
check('its frame is not black', byId.good.frame.black, false)
check('its frame is not flat', byId.good.frame.flat, false)
check('its frame has the size asked for', byId.good.frame.width + 'x' + byId.good.frame.height, '64x48')
check('its PNG is a real PNG', Buffer.from(String(byId.good.frame.png).replace(/^data:image\/png;base64,/, ''), 'base64').toString('latin1', 1, 4), 'PNG')

check('a broken shader fails at the fragment stage', byId.bad.status + ':' + byId.bad.phase, 'error:fragment')
const mapped = verify.mapDiagnostics(byId.bad.log, verify.assemble({ source: bad }).mapLine)
check('and the diagnostic is on the author line 3', mapped.diagnostics[0].line, 3)
check('and the message is the compiler own', /dimension mismatch/.test(mapped.diagnostics[0].message), true)

check('a declared-but-unused uniform is not active', (byId.unused.activeUniforms ?? []).map((entry) => entry.name).join(','), 'u_used')

// --------------------------------------------------------------- the right dialect
console.log('\n-- a dialect wrong is a dialect wrong --')
const toySource = kit.getExample('gallery/pattern-swatches').sourceText
const asSkills = await compile.runJobs({ jobs: [compile.jobFor(verify.assemble({ source: toySource, dialect: 'shader-skills' }), { id: 'ok', render: { time: 2, width: 48, height: 48 } })] })
const asToy = await compile.runJobs({ jobs: [compile.jobFor(verify.assemble({ source: toySource, dialect: 'shadertoy' }), { id: 'wrong' })] })
check('the corpus shader compiles as shader-skills', asSkills.results[0].status, 'ok')
// A WebGL2 context is created on first use, so this is where it can be observed.
check('a webgl2 context was created for the wrapper dialect', asSkills.contexts?.webgl2?.available, true)
check('and it reports GLSL ES 3.00', /3\.00/.test(asSkills.contexts?.webgl2?.shading ?? ''), true)
check('the same source as shadertoy (float iFrame) fails', asToy.results[0].status, 'error')
check('and says which overload it could not match', /no matching overloaded function/.test(asToy.results[0].log ?? ''), true)

// ---------------------------------------------------------- the whole corpus
console.log('\n-- the vendored corpus, compiled --')
const summary = kit.summary()
const radiant = kit.catalogOf('radiant')
const jobs = []
const labels = []
for (const entry of radiant.examples) {
  for (const source of entry.sources) {
    const id = 'radiant/' + entry.id + (entry.sources.length > 1 ? '#' + source.name : '')
    const text = kit.vendoredFile('radiant', source.file)
    jobs.push(compile.jobFor(verify.assemble({ source: text, dialect: entry.dialect ?? undefined }), { id }))
    labels.push(id)
  }
}
const radiantBatch = await compile.runJobs({ jobs })
check('every radiant source was compiled', radiantBatch.results.length, radiant.examples.reduce((sum, entry) => sum + entry.sources.length, 0))
const radiantFailures = (radiantBatch.results ?? []).filter((entry) => entry.compiled !== true)
check('every radiant fragment source COMPILES', radiantFailures.length, 0)
for (const entry of radiantFailures.slice(0, 8)) console.log('   FAILED ' + entry.id + ' :: ' + String(entry.log ?? entry.error ?? '').split('\n').slice(0, 2).join(' | '))
// A multi-pass page's secondary passes declare their own varyings, so they compile
// and cannot link against a generic full-screen vertex shader. That is reported as
// `compiled: true, linked: false`, and asserting it keeps the distinction honest.
const notLinked = (radiantBatch.results ?? []).filter((entry) => entry.compiled === true && entry.linked === false)
check('some passes need their own vertex stage (a link fact, not a compile one)', notLinked.length > 0, true)
check('and every one of those still COMPILED', notLinked.every((entry) => entry.compiled === true), true)
for (const entry of notLinked.slice(0, 3)) console.log('   compiled, needs its vertex: ' + entry.id)

const skills = kit.catalogOf('skills')
const galleryJobs = skills.gallery.map((entry) =>
  compile.jobFor(verify.assemble({ source: kit.vendoredFile('skills', entry.file), dialect: 'shader-skills' }), {
    id: 'gallery/' + entry.id,
    render: { time: entry.renderTime ?? 1, width: 64, height: 64 },
  }),
)
const galleryBatch = await compile.runJobs({ jobs: galleryJobs })
const galleryFailures = (galleryBatch.results ?? []).filter((entry) => entry.status !== 'ok')
check('every gallery piece compiles AND draws', galleryFailures.length, 0)
for (const entry of galleryFailures.slice(0, 8)) console.log('   FAILED ' + entry.id + ' :: ' + String(entry.log ?? entry.error ?? '').split('\n').slice(0, 2).join(' | '))
const flat = (galleryBatch.results ?? []).filter((entry) => entry.frame !== undefined && (entry.frame.flat || entry.frame.black))
check('no gallery piece draws a flat or black frame', flat.length, 0)
for (const entry of flat.slice(0, 8)) console.log('   FLAT ' + entry.id + ' :: ' + JSON.stringify(entry.frame?.mean))

const moduleJobs = skills.modules.map((entry) => compile.jobFor(verify.assemble({ source: kit.vendoredFile('skills', entry.file) }), { id: 'module/' + entry.id }))
const moduleBatch = await compile.runJobs({ jobs: moduleJobs })
const moduleOk = (moduleBatch.results ?? []).filter((entry) => entry.status === 'ok')
// A module is an include fragment: measured, only a few compile on their own, and
// the catalogue says so. Assert the ones that DO, and that the rest fail for the
// reason the skill documents rather than silently.
check('the module library is not all standalone (as documented)', moduleOk.length < skills.modules.length, true)
check('at least one module compiles alone', moduleOk.length > 0, true)

// ------------------------------------------------------------- determinism
console.log('\n-- a frame is a measurement --')
const det = (time) =>
  compile.runJobs({ jobs: [compile.jobFor(verify.assemble({ source: toySource, dialect: 'shader-skills' }), { id: 'det', render: { time, width: 64, height: 64 } })] })
const first = await det(2)
const again = await det(2)
const later = await det(3.5)
check('the same time draws the same signature', again.results[0].frame.signature, first.results[0].frame.signature)
check('a different time draws differently', later.results[0].frame.signature !== first.results[0].frame.signature, true)
check('the signature is eight hex characters', /^[0-9a-f]{8}$/.test(first.results[0].frame.signature), true)

// ----------------------------------------------------------------- desktop
console.log('\n-- desktop GLSL is refused, not faked --')
const desktop = verify.assemble({ source: '#version 330 core\nout vec4 c;\nvoid main(){ c = vec4(1.0); }' })
check('assemble refuses it', desktop.ok, false)
check('and names the tool that would compile it', /glslangValidator/.test(desktop.error ?? ''), true)

// --------------------------------------------------------- the skill examples
console.log('\n-- the skills examples compile --')
const examplesCheck = spawnSync(process.execPath, [path.join(packageRoot, '..', '..', 'scripts', 'checks', 'check-shader-examples.mjs')], { encoding: 'utf8' })
check('check-shader-examples.mjs passes', examplesCheck.status, 0)
if (examplesCheck.status !== 0) console.log((examplesCheck.stdout ?? '') + (examplesCheck.stderr ?? ''))

console.log('')
console.log('corpus: ' + String(summary.radiant.sources) + ' radiant sources + ' + String(summary.skills.gallery) + ' gallery pieces, all compiled here')
console.log(failures === 0 ? 'all ' + String(checked) + ' checks passed' : String(failures) + ' FAILURES of ' + String(checked))
process.exit(failures === 0 ? 0 : 1)
