/**
 * check-lab-node.mjs — the lab engine, without a harness and without a browser.
 *
 * What this proves, and why each half is worth the bytes:
 *
 *   - **the runtime contract**. Every registered runtime is driven through the
 *     same five functions with the same shapes. A runtime is what makes this lab
 *     growable, so "adding a runtime is one module and one line" has to be a
 *     claim a check can hold: the moment a module drifts, this fails.
 *   - **the path policy**. A lab is written by a tool and read by a browser
 *     route, so the refusals matter more than the successes: `..`, an absolute
 *     path, a symlink out of the tree, and a `\\`-spelled escape are each driven
 *     and each must be refused with its own code.
 *   - **the rounds**. Scaffold every runtime, instantiate every example, lint
 *     both, and assert the catalog agrees with the disk - then break a run on
 *     purpose and assert the lint CATCHES it. A lint nobody has seen fail is a
 *     lint that does not work.
 *   - **no toolchain is a warning, not a pass**. On a host with no
 *     openFrameworks the C++ is checked structurally and the answer says
 *     `not-compiled`; that sentence is asserted here, so a future edit cannot
 *     quietly turn a skip into a claim.
 *
 * Everything runs against a temporary root: it creates nothing in the workspace,
 * touches no user file, and can be run on any machine at any time.
 *
 * Run:  node checks/check-lab-node.mjs
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = path.resolve(import.meta.dirname, '..')
const lab = await import(pathToFileURL(path.join(packageRoot, 'lib', 'lab.js')).href)
const { runtimes, runtimeOf } = await import(pathToFileURL(path.join(packageRoot, 'lib', 'runtimes', 'index.js')).href)
const { buildTools, TOOL_NAMES } = await import(pathToFileURL(path.join(packageRoot, 'lib', 'tools.js')).href)
const { slugify, seedFromName, substitute, jsLiteral, integerOf } = await import(pathToFileURL(path.join(packageRoot, 'lib', 'util.js')).href)

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(66) + (expected === undefined || ok ? '' : ' -> ' + JSON.stringify(actual)))
  return ok
}
function skip(label, why) {
  skipped += 1
  console.log('SKIP ' + label.padEnd(66) + ' ' + why)
}
/** Assert that one call is refused, and with which code. */
async function refused(label, body, code) {
  try {
    await body()
    check(label, 'no refusal', code)
  } catch (err) {
    check(label, err instanceof lab.LabError ? err.code : String(err && err.message), code)
  }
}

const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-proto-lab-node-')))
const env = { ...process.env, DSH_PROTO_LAB_ROOT: root }

console.log('check-lab-node: the engine, offline')
console.log('  temp root ' + root)

// ---------------------------------------------------------------------------
// 1. The registry: the contract every runtime satisfies
// ---------------------------------------------------------------------------
{
  const registry = runtimes()
  check('every registered runtime passes the contract', registry.problems.join('; '), '')
  check('the runtimes this build ships', registry.entries.map((entry) => entry.id).join(','), 'p5js,openframeworks')
  for (const entry of registry.entries) {
    const detected = await entry.detect({ env })
    check(entry.id + ': detect answers with a summary and detail', typeof detected.summary === 'string' && detected.summary.length > 0 && Array.isArray(detected.detail), true)
    check(entry.id + ': it declares a kind and a non-empty extension list', (entry.kind === 'web' || entry.kind === 'native') && entry.extensions.length > 0, true)
    check(entry.id + ': it has a tagline and a label', typeof entry.tagline === 'string' && entry.tagline.length > 0 && typeof entry.label === 'string', true)
  }
  check(
    'the template module is NOT registered (a runtime that never ran is worse than an absent one)',
    registry.entries.some((entry) => entry.id === 'CHANGEME'),
    false,
  )
}

// ---------------------------------------------------------------------------
// 2. Names and paths: the refusals are the feature
// ---------------------------------------------------------------------------
{
  check('slugify folds a sentence into a folder name', slugify('A Flow Field, v2!'), 'a-flow-field-v2')
  check('slugify drops diacritics rather than the word', slugify('Café Nocturne'), 'cafe-nocturne')
  check('slugify refuses to invent a name', slugify('···'), '')
  check('a seed derived from a name is stable', seedFromName('p5js/flow-field'), seedFromName('p5js/flow-field'))
  check('two names get two seeds', seedFromName('a') === seedFromName('b'), false)
  check('substitution is one pass, so a value may contain a token', substitute('{{A}} and {{B}}', { A: '{{B}}', B: 'x' }), '{{B}} and x')
  check('a JSON literal cannot close a script tag', jsLiteral('</script><script>'), '"\\u003c/script\\u003e\\u003cscript\\u003e"')
  check('integerOf takes an integer and refuses nonsense', integerOf('42.9', 0) + ',' + integerOf('nope', 7), '42,7')

  check('parseRunId accepts <runtime>/<slug>', lab.parseRunId('p5js/flow-field').id, 'p5js/flow-field')
  const bad = ['p5js', 'p5js/flow-field/extra', '../etc/passwd', 'c:/windows', 'p5js/..', 'p5js/Flow_Field']
  for (const value of bad) {
    let shape = 'accepted'
    try {
      lab.parseRunId(value)
    } catch (err) {
      shape = err.code
    }
    check('parseRunId refuses ' + JSON.stringify(value), shape === 'accepted' ? 'accepted' : 'refused', 'refused')
  }

  await refused('ensureInside refuses ..', () => lab.ensureInside({ root, relative: '../escape' }), 'PATH_ESCAPE')
  await refused('ensureInside refuses an absolute path', () => lab.ensureInside({ root, relative: path.join(os.tmpdir(), 'x') }), 'PATH_ABSOLUTE')
  await refused('ensureInside refuses a backslash-spelled escape', () => lab.ensureInside({ root, relative: 'p5js\\..\\..\\escape' }), 'PATH_ESCAPE')
  await refused('ensureInside refuses a NUL byte', () => lab.ensureInside({ root, relative: 'a\u0000b' }), 'PATH_NUL')
  check('ensureInside permits a path inside the lab', (await lab.ensureInside({ root, relative: 'p5js/x/sketch.js' })).startsWith(root), true)

  // A symlink out of the lab is the one construct that could make a file inside
  // it be a file outside it, so it is refused - the canonical-path prefix check
  // catches it before anything is read or written, which is why the code is
  // ESCAPE and not SYMLINK: the path really does resolve outside the root.
  try {
    await fsp.mkdir(path.join(root, 'linky'), { recursive: true })
    await fsp.symlink(os.tmpdir(), path.join(root, 'linky', 'outside'), 'junction')
    await fsp.writeFile(path.join(os.tmpdir(), 'dsh-proto-lab-escape-probe.txt'), 'x')
    try {
      await refused('a symlink out of the lab is refused', () => lab.ensureInside({ root, relative: 'linky/outside/dsh-proto-lab-escape-probe.txt' }), 'PATH_ESCAPE')
    } finally {
      await fsp.rm(path.join(os.tmpdir(), 'dsh-proto-lab-escape-probe.txt'), { force: true })
    }
  } catch (err) {
    skip('a symlink out of the lab is refused', 'this host could not create a link: ' + String(err && err.message))
  }
}

// ---------------------------------------------------------------------------
// 3. The lab root
// ---------------------------------------------------------------------------
{
  const explicit = await lab.resolveLabRoot({ env: { DSH_PROTO_LAB_ROOT: 'elsewhere/lab' }, workspace: root })
  check('the root override wins and its provenance is reported', explicit.source + ' ' + explicit.root, 'DSH_PROTO_LAB_ROOT ' + path.join(root, 'elsewhere', 'lab'))
  // With no override the lab goes to the DESKTOP when there is one, and to
  // `<workspace>/lab` when there is not. Both are asserted, because both are a
  // supported machine and a check that only knows one of them would fail on the
  // other - a container or a CI runner is exactly where "no Desktop" happens.
  const fallback = await lab.resolveLabRoot({ env: {}, workspace: root })
  check(
    'with no override the lab is on the Desktop when the machine has one',
    fallback.source === 'desktop' ? path.basename(path.dirname(fallback.root)) + '/' + path.basename(fallback.root) : fallback.source,
    'vncode-lab/runs',
  )
  check('and it carries a prints and an apps folder with it', path.basename(fallback.prints) + '/' + path.basename(fallback.apps), 'prints/apps')
  const headless = await lab.resolveLabRoot({ env: {}, workspace: root, home: path.join(root, 'no-such-home') })
  check('a machine with no Desktop falls back to <workspace>/lab', headless.root, path.join(root, 'lab'))
  check('and that fallback also carries prints and apps', path.basename(headless.prints) + '/' + path.basename(headless.apps), 'prints/apps')
  check('the resolved root need not exist yet', (await lab.canonicalRoot(headless.root)).endsWith('lab'), true)
}

// ---------------------------------------------------------------------------
// 3b. The capability model: what can be verified HERE, and how deeply
// ---------------------------------------------------------------------------
{
  const capabilities = await import(pathToFileURL(path.join(packageRoot, 'lib', 'capabilities.js')).href)
  check('the ladder is ordered shallowest first', capabilities.TIERS.map((tier) => tier.id).join(','), 't0-structure,t1-parse,t2-compile,t3-render,t4-measure')
  check('every tier states what it needs and what it costs', capabilities.TIERS.every((tier) => Array.isArray(tier.needs) && typeof tier.cost === 'string' && typeof tier.claim === 'string'), true)
  check('t0 needs nothing, because it always runs', capabilities.TIERS[0].always === true && capabilities.TIERS[0].needs.length, 0)
  check('a deeper tier implies the shallower ones', capabilities.throughTier('t2-compile').map((tier) => tier.id).join(','), 't0-structure,t1-parse,t2-compile')
  check('an unknown tier implies nothing', capabilities.throughTier('t9-nope').length, 0)
  check('the frame budget is one frame at 60 Hz', Number(capabilities.BUDGETS.frameMs.toFixed(2)), 16.67)

  const host = await capabilities.machine({ env })
  check('the machine report names the cores and the memory', host.cores >= 1 && host.memoryGiB > 0, true)
  check('the machine report names a tier this host can reach', capabilities.tierOf(host.tier) !== null, true)
  check('the size scale is bounded and usable', host.scale >= 0.25 && host.scale <= 1, true)
  check('the machine report says what it could NOT find', host.notes.length > 0, true)
  check('the browser probe is cheap: it reports the same answer twice', JSON.stringify(await capabilities.findBrowser({ env })), JSON.stringify(host.browser))

  // The adaptation itself: the p5.js defaults are a function of the host, and a
  // small machine gets a smaller first population - which is the whole point of
  // asking the machine anything.
  const p5 = runtimeOf('p5js')
  const small = p5.defaultParams({ scale: 0.25 }).find((slot) => slot.name === 'particles').value
  const large = p5.defaultParams({ scale: 1 }).find((slot) => slot.name === 'particles').value
  check('a small host gets a smaller opening population', small < large, true)
  check('the population stays inside the declared slider range', small >= 200 && large <= 6000, true)
  check('and a caller who says nothing still gets a usable list', p5.defaultParams().length, p5.defaultParams({ scale: 1 }).length)
}

// ---------------------------------------------------------------------------
// 4. Parameters
// ---------------------------------------------------------------------------
{
  const { params, dropped } = lab.normalizeParams([
    { name: 'Particles Count', min: 10, max: 5, value: 99, step: 0 },
    { name: 'particles-count', min: 0, max: 1 },
    { name: '', min: 0, max: 1 },
    'nonsense',
  ])
  check('a parameter name is slugified', params[0].name, 'particles-count')
  check('a reversed range is normalized, not trusted', params[0].min + '..' + params[0].max, '5..10')
  check('a value outside the range is clamped', params[0].value, 10)
  check('a zero step is replaced with a usable one', params[0].step > 0, true)
  check('a duplicate name is dropped', params.length + '/' + dropped, '1/3')
  await refused('too many parameters is refused', () => lab.normalizeParams(Array.from({ length: 30 }, (_, index) => ({ name: 'p' + index }))), 'PARAMS_TOO_MANY')
  await refused('a non-array params is refused', () => lab.normalizeParams({ n: 1 }), 'PARAMS_SHAPE')
}

// ---------------------------------------------------------------------------
// 5. Every runtime: scaffold, lint, examples, instantiate
// ---------------------------------------------------------------------------
const catalogNow = async () => (await lab.readCatalog(root)).catalog
const runsOnDisk = []
for (const entry of runtimes().entries) {
  const slug = 'gen-' + entry.id
  const made = await lab.scaffoldRun({
    root,
    runtime: entry,
    slug,
    label: 'Gen ' + entry.id,
    concept: 'A generated run for the engine check.',
    seed: 1234,
    params: entry.defaultParams ?? [],
    env,
  })
  runsOnDisk.push(made.run.id)
  check(entry.id + ': it scaffolded its own files', made.run.files.length > 1, true)
  const empties = made.files.filter((file) => file.bytes === 0).map((file) => file.path)
  check(entry.id + ': only a placeholder is empty', empties.every((name) => name.endsWith('.gitkeep')) ? '' : empties.join(','), '')
  check(entry.id + ': the README and the NOTES are always written', made.run.files.includes('README.md') && made.run.files.includes('NOTES.md'), true)
  check(entry.id + ': every file has a digest', made.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)), true)

  const reported = await lab.lintRun({ root, runtime: entry, run: made.run.id, catalog: await catalogNow(), env })
  const errors = reported.issues.filter((item) => item.severity === 'error')
  check(entry.id + ': a freshly scaffolded run has no errors', errors.map((item) => item.code + ': ' + item.message).join(' | '), '')
  check(entry.id + ': it linted a run it did not write by hand', reported.files.length, made.run.files.length)

  await refused('a second scaffold of the same slug is refused', () => lab.scaffoldRun({ root, runtime: entry, slug, concept: 'again', seed: 1, params: [], env }), 'RUN_EXISTS')

  const examples = await entry.examples()
  if (examples.length === 0) {
    skip(entry.id + ': examples instantiate', 'this runtime ships no example yet')
    continue
  }
  for (const example of examples) {
    check(entry.id + ': example ' + example.slug + ' names a concept and a seed', example.concept.length > 10 && Number.isInteger(example.seed), true)
    const instantiated = await lab.instantiateExample({ root, runtime: entry, example, slug: 'ex-' + example.slug })
    runsOnDisk.push(instantiated.run.id)
    check(entry.id + ': example ' + example.slug + ' instantiates as a whole run', instantiated.run.files.includes('README.md') && instantiated.run.files.includes('NOTES.md'), true)
    const report = await lab.lintRun({ root, runtime: entry, run: instantiated.run.id, catalog: await catalogNow(), env })
    check(entry.id + ': example ' + example.slug + ' lints clean', report.issues.filter((item) => item.severity === 'error').map((item) => item.code + ': ' + item.message).join(' | '), '')
  }
}

// ---------------------------------------------------------------------------
// 6. The lint must FIRE: break a run on purpose, once per runtime
// ---------------------------------------------------------------------------
{
  const p5 = runtimeOf('p5js')
  const target = path.join(root, 'p5js', 'gen-p5js')
  const sketchFile = path.join(target, 'sketch.js')
  const original = await fsp.readFile(sketchFile, 'utf8')
  // Unseeding is done by DELETING the calls, not by mangling the name: a rule
  // that fires on a comment would be a rule that fires on nothing.
  const unseededText = original
    .split('\n')
    .filter((line) => !/^\s*(randomSeed|noiseSeed)\s*\(/.test(line))
    .join('\n')
  check('the seeded example really does seed', unseededText !== original && !/^\s*randomSeed\s*\(/m.test(unseededText), true)
  await fsp.writeFile(sketchFile, unseededText)
  const unseeded = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: removing the seed is caught as an error', unseeded.issues.some((item) => item.code === 'unseeded' && item.severity === 'error'), true)

  await fsp.writeFile(sketchFile, original + '\n// loose end\nloadImage("data/missing.png");\n')
  const loads = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: a file the preview cannot inline is a warning naming the reason', loads.issues.some((item) => item.code === 'loads-a-file' && item.severity === 'warn'), true)

  await fsp.writeFile(sketchFile, original + '\nfetch("https://example.com/x.json");\n')
  const remote = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: reaching for the network is caught as an error', remote.issues.some((item) => item.code === 'remote-asset' && item.severity === 'error'), true)

  await fsp.writeFile(sketchFile, original)
  const restored = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: restoring the file makes it clean again', restored.ok && restored.issues.filter((item) => item.severity === 'error').length, 0)

  const of = runtimeOf('openframeworks')
  const ofApp = path.join(root, 'openframeworks', 'gen-openframeworks', 'src', 'ofApp.cpp')
  const source = await fsp.readFile(ofApp, 'utf8')
  await fsp.writeFile(ofApp, source.replace(/void\s+ofApp::draw\s*\(/, 'void ofApp::drawRenamed('))
  const broken = await lab.lintRun({ root, runtime: of, run: 'openframeworks/gen-openframeworks', catalog: await catalogNow(), env })
  check('openframeworks: a missing draw() definition is caught', broken.issues.some((item) => item.code === 'source-missing-draw'), true)

  await fsp.writeFile(ofApp, source)
  const ofAfter = await lab.lintRun({ root, runtime: of, run: 'openframeworks/gen-openframeworks', catalog: await catalogNow(), env })
  check('openframeworks: the freshly generated C++ is structurally sound', ofAfter.ok, true)
  const compileClaim = ofAfter.issues.find((item) => item.code === 'not-compiled')
  if (compileClaim === undefined) {
    check('openframeworks: with an install present, the C++ is compiled', ofAfter.issues.every((item) => item.severity !== 'error'), true)
  } else {
    check('openframeworks: without an install the answer SAYS it was not compiled', /NOT compiled/i.test(compileClaim.message) && compileClaim.severity === 'warn', true)
    skip('openframeworks: the C++ really compiles against openFrameworks', 'no openFrameworks on this host - set DSH_OF_ROOT to run this')
  }

  // A stray file, a broken shell and a missing NOTES are the three lab rules.
  const shell = path.join(root, 'p5js', 'gen-p5js', 'index.html')
  const shellText = await fsp.readFile(shell, 'utf8')
  await fsp.writeFile(shell, shellText.replace(/<script([^>]*)\ssrc="sketch\.js"/, '<script$1 src="gone.js"'))
  const noSketch = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: a shell that stopped loading the sketch is caught', noSketch.issues.some((item) => item.code === 'shell-no-sketch'), true)
  await fsp.writeFile(shell, shellText)

  await fsp.writeFile(path.join(root, 'p5js', 'gen-p5js', 'stray.bin'), Buffer.alloc(64, 7))
  const stray = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5: a file the runtime cannot regenerate is a warning', stray.issues.some((item) => item.code === 'stray-file'), true)
  await fsp.rm(path.join(root, 'p5js', 'gen-p5js', 'stray.bin'), { force: true })

  await fsp.rm(path.join(root, 'p5js', 'gen-p5js', 'NOTES.md'), { force: true })
  const noNotes = await lab.lintRun({ root, runtime: p5, run: 'p5js/gen-p5js', catalog: await catalogNow(), env })
  check('p5js: a run with no NOTES is an error', noNotes.issues.some((item) => item.code === 'no-notes' && item.severity === 'error'), true)
}

// ---------------------------------------------------------------------------
// 7. The catalog is a convenience, never the truth
// ---------------------------------------------------------------------------
{
  const catalog = await lab.readCatalog(root)
  check('the catalog records every run it made', Object.keys(catalog.catalog.runs).length >= runsOnDisk.length, true)
  check('the catalog records a run\'s seed and concept', Number.isInteger(catalog.catalog.runs['p5js/gen-p5js'].seed), true)

  // A run made by hand - no catalog entry - is still a run, and the lint says so
  // as a WARNING rather than pretending the folder is not there. The source is
  // taken from a run this check has not been editing (an example, not the broken
  // one), so the reasoning is about the catalog and nothing else.
  const handmade = path.join(root, 'p5js', 'by-hand')
  await fsp.mkdir(handmade, { recursive: true })
  const donor = path.join(root, 'p5js', 'ex-flow-field')
  for (const name of ['sketch.js', 'README.md', 'NOTES.md', 'index.html']) {
    await fsp.copyFile(path.join(donor, name), path.join(handmade, name))
  }
  const listed = await lab.listRuns(root)
  check('a run made by hand is listed from the disk', listed.runs.some((run) => run.id === 'p5js/by-hand'), true)
  const handReport = await lab.lintRun({ root, runtime: runtimeOf('p5js'), run: 'p5js/by-hand', catalog: catalog.catalog, env })
  check('a run with no catalog entry warns rather than failing', handReport.issues.some((item) => item.code === 'no-catalog-entry' && item.severity === 'warn'), true)

  // Drift is the other half of the same question: a catalog entry that exists but
  // no longer matches the folder.
  await lab.writeCatalogEntry({
    root,
    entry: { id: 'p5js/by-hand', runtime: 'p5js', slug: 'by-hand', label: 'By hand', concept: 'copied', seed: 1, params: [], files: ['sketch.js'], bytes: 1, example: null },
  })
  const drifted = await lab.lintRun({ root, runtime: runtimeOf('p5js'), run: 'p5js/by-hand', catalog: (await lab.readCatalog(root)).catalog, env })
  check('a catalog that disagrees with the folder is reported as drift', drifted.issues.some((item) => item.code === 'catalog-drift'), true)

  // A corrupt catalog must not stop the lab: the runs are on disk.
  await fsp.writeFile(path.join(root, 'catalog.json'), '{ not json')
  const broken = await lab.readCatalog(root)
  check('a corrupt catalog is reported, not fatal', typeof broken.note === 'string' && Object.keys(broken.catalog.runs).length === 0, true)
  const listedAnyway = await lab.listRuns(root)
  check('and the runs are still listed from the disk', listedAnyway.runs.length >= runsOnDisk.length, true)
  await fsp.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog.catalog, null, 2))
}

// ---------------------------------------------------------------------------
// 8. The five tools, through the registry's own contract
// ---------------------------------------------------------------------------
{
  const tools = buildTools({ env, log: { warn() {}, info() {} } })
  check('the tool surface is five, named by intent', tools.map((tool) => tool.name).join(','), TOOL_NAMES.join(','))
  for (const tool of tools) {
    check(tool.name + ': its arguments are closed to anything else', tool.parameters.additionalProperties, false)
    // The registry enforces the declared schema, so it has to BE one: every
    // property typed, and every `required` name actually declared.
    const properties = Object.keys(tool.parameters.properties ?? {})
    const untyped = properties.filter((name) => typeof tool.parameters.properties[name].type !== 'string')
    const undeclared = (tool.parameters.required ?? []).filter((name) => !properties.includes(name))
    check(tool.name + ': every argument is declared and typed', untyped.length === 0 && undeclared.length === 0, true)
    check(tool.name + ': it renders a text part', tool.output.render({}, { text: 'x', view: { ok: true } })[0].type, 'text')
    check(tool.name + ': it carries a card for the conversation', typeof tool.output.presentationMeta, 'function')
  }
  check('lab_new requires a runtime', (tools[2].parameters.required ?? []).join(','), 'runtime')
  check('lab_read requires a run', (tools[3].parameters.required ?? []).join(','), 'run')

  const exec = { agent: { session: { meta: { cwd: root } } } }
  const opened = await tools[0].execute({ action: 'info' }, exec)
  check('lab_open reports the root it resolved', opened.view.root, root)
  check('lab_open counts the runs on disk', opened.view.runs >= runsOnDisk.length, true)
  check('lab_open names a next step', /lab_runtimes/.test(opened.text), true)

  const created = await tools[2].execute({ runtime: 'p5js', concept: 'A tiny tool-driven run', params: [{ name: 'n', min: 1, max: 10, value: 4 }] }, exec)
  check('lab_new derives a slug from the concept', created.view.run, 'p5js/a-tiny-tool-driven-run')
  check('lab_new reports the folder it wrote', typeof created.view.root, 'string')
  check('lab_new explains where the seed came from', /derived from the run name/.test(created.text), true)

  const read = await tools[3].execute({ run: created.view.run, file: 'sketch.js' }, exec)
  check('lab_read returns one file with its digest', /sha256 [0-9a-f]{16}/.test(read.text), true)
  const listing = await tools[3].execute({ run: created.view.run }, exec)
  check('lab_read without a file lists the run', read.view.files === undefined && listing.view.files.length > 0, true)

  const linted = await tools[4].execute({ run: created.view.run }, exec)
  check('lab_lint judges one run', linted.view.run, created.view.run)
  const all = await tools[4].execute({}, exec)
  check('lab_lint with no run judges them all', all.view.runs >= runsOnDisk.length, true)

  const runtimesText = await tools[1].execute({ action: 'list' }, exec)
  check('lab_runtimes lists what this build ships', /p5js/.test(runtimesText.text) && /openframeworks/.test(runtimesText.text), true)
  const examplesText = await tools[1].execute({ action: 'examples' }, exec)
  check('lab_runtimes lists the examples it ships', /flow-field/.test(examplesText.text), true)
  const info = await tools[1].execute({ action: 'info', runtime: 'p5js', run: created.view.run }, exec)
  check('lab_runtimes info lints a run when asked', info.view.run, created.view.run)

  const refusedTool = await tools[2].execute({ runtime: 'nope', concept: 'x' }, exec)
  check('an unknown runtime is an ANSWER, not a throw', refusedTool.view.ok === false && /no runtime called/.test(refusedTool.text), true)
  const escape = await tools[3].execute({ run: 'p5js/gen-p5js', file: '../../../etc/passwd' }, exec)
  check('a file that walks out of the run is refused in the answer', escape.view.ok === false && /may not walk up|outside the lab/.test(escape.text), true)
  const noName = await tools[2].execute({ runtime: 'p5js' }, exec)
  check('lab_new with neither concept nor slug refuses', noName.view.ok === false && /needs a `concept`/.test(noName.text), true)
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
await fsp.rm(root, { recursive: true, force: true })
console.log('')
if (failures > 0) {
  console.log('check-lab-node: ' + failures + ' FAILED of ' + checked + (skipped > 0 ? ' (' + skipped + ' skipped loudly)' : ''))
  process.exit(1)
}
console.log('check-lab-node: OK — ' + checked + ' assertions' + (skipped > 0 ? ', ' + skipped + ' skipped loudly' : ''))
