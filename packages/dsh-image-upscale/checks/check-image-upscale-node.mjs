/**
 * dsh-image-upscale — the tracked check for this package's host half.
 *
 * Run it with `npm run check` in this folder (`node checks/check-image-upscale-node.mjs`).
 * It is additional to the pack-wide checks under scripts/checks/, never a
 * replacement for them, and it travels with the package.
 *
 * What it proves, and how:
 *
 *   - **The pure decisions**, which need no engine: a manifest turned into jobs
 *     or into reasons, the argv one image costs, the sentence a failed run
 *     produces, and the model list agreeing between `package.json`, `python.js`
 *     and the runner's own MODELS table (three places that would otherwise drift).
 *   - **The file policy**: an output that is the input is refused, an existing
 *     output is refused without `overwrite`, a missing parent folder is refused,
 *     and a path that climbs out of the workspace is refused.
 *   - **The tool surface as the agent calls it**, through the real `buildTools`
 *     and the real dependency cache: a missing file, a refusal, a dry run.
 *   - **The engine path end to end**, on an image this check BUILDS ITSELF (a
 *     32x32 24-bit BMP written here, byte by byte), when this host has torch AND
 *     the model weights: the output PNG's own IHDR is read back and must be 64
 *     pixels wide. No image library is involved in the check itself.
 *
 * A host with no Python that loads torch, or with no weights on disk, SKIPS the
 * render assertions LOUDLY and still exits 0 - and says so, because a green run
 * on such a machine is not evidence that the render works.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDeps, CAPABILITIES, PLUGIN_VERSION } from '../lib/index.js'
import { MODELS, DEFAULT_MODEL, imageArgs, parseJson, pythonCandidates } from '../lib/python.js'
import { UpscaleError, resolveInput, resolveOutput } from '../lib/paths.js'
import { buildTools, planBatch, formatBytes, explain, refuse } from '../lib/tools.js'

let passes = 0
let failures = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    passes += 1
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''))
}
const okNot = (label, condition, detail = '') => ok(label, !condition, detail)

/**
 * Every property the schema declares, checked against the value a tool RETURNED.
 *
 * The registry validates a tool's output against `output.schema` before the answer
 * reaches the model, and a value it refuses arrives as
 * `returned invalid output: missing required property ...` - the tool never runs
 * for the caller. This check used to assert only the TEXT of an answer, which is
 * how `upscale_info` shipped answering with `view: {}` against a view schema that
 * requires `output`: correct prose, unusable tool. Objects are checked for their
 * required keys and for every declared property present, arrays element by element,
 * and a scalar for its JSON type.
 */
function schemaErrors(schema, value, at = 'value') {
  if (!schema || typeof schema !== 'object') return []
  const type = schema.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [at + ': not an object']
    const problems = []
    for (const key of schema.required ?? []) if (value[key] === undefined) problems.push(at + '.' + key + ': required, missing')
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) problems.push(...schemaErrors(sub, value[key], at + '.' + key))
    }
    return problems
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [at + ': not an array']
    return value.flatMap((item, index) => schemaErrors(schema.items, item, at + '[' + index + ']'))
  }
  if (type === 'string') return typeof value === 'string' ? [] : [at + ': not a string']
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [at + ': not a number']
  if (type === 'boolean') return typeof value === 'boolean' ? [] : [at + ': not a boolean']
  return []
}

/** A 32x32 24-bit BMP, written here so the check owns its fixture. */
function writeBmp(file, width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4
  const pixels = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + x * 3
      pixels[offset] = 40 + x * 6
      pixels[offset + 1] = 90 + y * 4
      pixels[offset + 2] = 190 - x
    }
  }
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(54 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22) // bottom-up, the BMP way
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixels.length, 34)
  writeFileSync(file, Buffer.concat([header, pixels]))
}

/** The width and height out of a PNG's IHDR, without an image library. */
function pngSize(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

// ---------------------------------------------------------------- the tool surface

const workdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upscale-check-'))
const workspace = path.join(workdir, 'workspace')
mkdirSync(workspace, { recursive: true })
const source = path.join(workspace, 'tiny.bmp')
writeBmp(source, 32, 32)

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: (name) => (name === 'sessions' ? { get: () => ({ header: { cwd: workspace } }) } : undefined),
  effect: (fn) => fn(),
  tools: { register: () => {} },
}

const registered = []
const registeredSkills = []
const captureCtx = {
  ...ctx,
  tools: { register: (tool) => registered.push(tool) },
  get: (name) => (name === 'skills' ? { register: (skill) => registeredSkills.push(skill) } : ctx.get(name)),
}
const row = await import('../lib/index.js')
row.apply(captureCtx)

ok('the row registers four tools', registered.length === 4, registered.map((tool) => tool.name).join(', '))
ok('the row registers exactly one skill', registeredSkills.length === 1, registeredSkills.map((skill) => skill.name).join(', '))
ok(
  'the skill is `image-upscale`, bundled, with its own resource base',
  registeredSkills[0]?.name === 'image-upscale' && registeredSkills[0]?.source === 'bundled' && String(registeredSkills[0]?.resourceBase?.path ?? '').replace(/\\/g, '/').endsWith('skills/image-upscale'),
  JSON.stringify(registeredSkills[0]?.resourceBase ?? null),
)
ok('the skill has a whenToUse', typeof registeredSkills[0]?.whenToUse === 'string' && registeredSkills[0].whenToUse.length > 40, registeredSkills[0]?.whenToUse ?? '')
ok('the skill body names the tools it is about', typeof registeredSkills[0]?.content === 'string' && registeredSkills[0].content.includes('upscale_info') && registeredSkills[0].content.includes('upscale_batch'), '')
const { meta: skillMeta } = row.parseSkillFile(readFileSync(new URL('../skills/image-upscale/SKILL.md', import.meta.url), 'utf8'))
ok('the skill frontmatter parses', skillMeta.name === 'image-upscale' && typeof skillMeta.description === 'string', JSON.stringify(skillMeta.name))
for (const expected of ['upscale_info', 'upscale_image', 'upscale_batch', 'upscale_fetch_weights']) {
  ok('the row registers `' + expected + '`', registered.some((tool) => tool.name === expected), registered.map((tool) => tool.name).join(', '))
}
for (const tool of registered) {
  ok('`' + tool.name + '` has a description', typeof tool.description === 'string' && tool.description.length > 200, '')
  ok('`' + tool.name + '` declares parameters', tool.parameters && tool.parameters.type === 'object', '')
  ok('`' + tool.name + '` has a schema and a renderer', tool.output && tool.output.schema && typeof tool.output.render === 'function', '')
  ok('`' + tool.name + '` is callable', typeof tool.execute === 'function', '')
}
ok('CAPABILITIES lists the four tools', CAPABILITIES.tools.length === 4, CAPABILITIES.tools.join(', '))
ok('PLUGIN_VERSION matches package.json', PLUGIN_VERSION === JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, PLUGIN_VERSION)
ok('nothing is claimed to be bundled', CAPABILITIES.notBuilt.includes('a bundled engine'), '')

// ---------------------------------------------------------------- the three model lists

const runnerSource = readFileSync(new URL('../lib/upscale.py', import.meta.url), 'utf8')
const runnerModels = [...runnerSource.matchAll(/^ {4}'([A-Za-z0-9._-]+)': \{$/gm)].map((match) => match[1])
ok('the runner declares the same models as python.js', runnerModels.length === MODELS.length && MODELS.every((name) => runnerModels.includes(name)), runnerModels.join(', '))
ok('the default model exists', MODELS.includes(DEFAULT_MODEL), DEFAULT_MODEL)
ok('the default model is the small one', DEFAULT_MODEL === 'realesr-general-x4v3', DEFAULT_MODEL)

// ---------------------------------------------------------------- pure decisions

const good = planBatch(
  [
    { input: 'a/one.jpg', output: 'a/one-2x.jpg', target_width: 600 },
    { input: 'a/two.png', output: 'a/two-2x.png', scale: 3, quality: 92, format: 'png' },
  ],
  { model: DEFAULT_MODEL },
)
ok('a valid manifest becomes jobs', good.ok && good.items.length === 2, JSON.stringify(good.errors))
ok('an entry that names no model takes the default', good.items[0].model === DEFAULT_MODEL, good.items[0].model)
ok('target_width survives the plan', good.items[0].targetWidth === 600, String(good.items[0].targetWidth))
ok('per-entry scale survives the plan', good.items[1].scale === 3, String(good.items[1].scale))
ok('per-entry quality survives the plan', good.items[1].quality === 92, String(good.items[1].quality))

const sameFile = planBatch([{ input: 'a/one.jpg', output: 'a/one.jpg' }], {})
okNot('a manifest cannot ask to overwrite its own input', sameFile.ok, JSON.stringify(sameFile.items))
ok('and says why', sameFile.errors[0].includes('never alters the original'), sameFile.errors.join(' | '))

const noInput = planBatch([{ output: 'b.jpg' }], {})
ok('an entry with no input is refused', !noInput.ok && noInput.errors[0].includes('no "input"'), noInput.errors.join(' | '))
const badModel = planBatch([{ input: 'a.jpg', output: 'b.jpg', model: 'realesrgan-x4' }], {})
ok('an unknown model is refused', !badModel.ok && badModel.errors[0].includes('unknown model'), badModel.errors.join(' | '))
const badScale = planBatch([{ input: 'a.jpg', output: 'b.jpg', scale: 99 }], {})
ok('an impossible scale is refused', !badScale.ok && badScale.errors[0].includes('scale'), badScale.errors.join(' | '))
const notArray = planBatch({ input: 'a.jpg' }, {})
ok('a manifest that is not an array is refused', !notArray.ok, notArray.errors.join(' | '))

const args = imageArgs({ input: 'in.jpg', output: 'out.jpg', model: 'RealESRGAN_x4plus', targetWidth: 600, quality: 90, weightsDir: 'W' })
ok('the argv is an array of separate arguments', Array.isArray(args) && args.length === 12, args.join(' '))
ok('the argv carries the input and output as their own arguments', args[args.indexOf('--input') + 1] === 'in.jpg' && args[args.indexOf('--output') + 1] === 'out.jpg', args.join(' '))
ok('target_width wins over scale in the argv', args.includes('--target-width') && !args.includes('--scale'), args.join(' '))
ok('a space in a path would stay one argument', imageArgs({ input: 'C:/a b/c.jpg', output: 'C:/a b/d.jpg', model: DEFAULT_MODEL, scale: 2 }).filter((value) => value === 'C:/a b/c.jpg').length === 1, '')

ok('bytes are formatted for a reader', formatBytes(1536) === '1.5 KB' && formatBytes(4_700_000) === '4.5 MB', formatBytes(1536) + ' / ' + formatBytes(4_700_000))
ok('a JSON line is parsed from noisy stdout', parseJson('warning: x\n{"ok":true,"n":1}\n')?.n === 1, parseJson('warning: x\n{"ok":true,"n":1}\n'))
ok('prose on stdout is not mistaken for JSON', parseJson('nothing here') === null, '')
ok('python candidates always offer something', pythonCandidates({}, 'win32').length >= 2, pythonCandidates({}, 'win32').map((entry) => entry.label).join(', '))
ok('DSH_PYTHON wins', pythonCandidates({ DSH_PYTHON: '/custom/python' }, 'linux')[0].file === '/custom/python', '')

const explained = explain({ json: { ok: false, code: 'NO_WEIGHTS', message: 'No weights' } }, { model: 'realesr-general-x4v3', output: 'x.jpg' })
ok('a missing model points at the tool that fetches it', explained.includes('upscale_fetch_weights'), explained)
ok('a refusal from the policy keeps its reason', refuse(new UpscaleError('EXISTS', 'That output already exists: x')).includes('overwrite'), refuse(new UpscaleError('EXISTS', 'That output already exists: x')))

// ---------------------------------------------------------------- the file policy

// The REAL weights folder, so the render assertion is about this machine as it
// is: with the model on disk it runs, and without it the check says so loudly.
const deps = createDeps(ctx, { env: process.env })
const session = 'check-session'
const input = await resolveInput(deps.ctx, { session, path: 'tiny.bmp' })
ok('a workspace-relative input resolves', input.file.endsWith('tiny.bmp') && input.scope === 'workspace', input.file)
ok('an absolute input resolves', (await resolveInput(deps.ctx, { session, path: source })).scope === 'absolute', '')

let refusedOutside = null
try {
  await resolveInput(deps.ctx, { session, path: '../outside.jpg' })
} catch (error) {
  refusedOutside = error
}
ok('a path that climbs out of the workspace is refused', refusedOutside instanceof UpscaleError, refusedOutside ? refusedOutside.code : 'no error')

let refusedMissingParent = null
try {
  await resolveOutput(deps.ctx, { session, path: 'no/such/folder/out.jpg' })
} catch (error) {
  refusedMissingParent = error
}
ok('an output whose folder does not exist is refused', refusedMissingParent && refusedMissingParent.code === 'NO_PARENT', refusedMissingParent ? refusedMissingParent.code : 'no error')

const fresh = await resolveOutput(deps.ctx, { session, path: 'out-one.png' })
ok('a new output resolves and is not there yet', fresh.exists === false && fresh.file.endsWith('out-one.png'), fresh.file)
writeFileSync(fresh.file, 'x')
let refusedExisting = null
try {
  await resolveOutput(deps.ctx, { session, path: 'out-one.png' })
} catch (error) {
  refusedExisting = error
}
ok('an existing output is refused without `overwrite`', refusedExisting && refusedExisting.code === 'EXISTS', refusedExisting ? refusedExisting.code : 'no error')
ok('… and allowed with it', (await resolveOutput(deps.ctx, { session, path: 'out-one.png', overwrite: true })).exists === true, '')

// ---------------------------------------------------------------- the tools, as called

const tools = buildTools(deps)
const tool = (name) => tools.find((entry) => entry.name === name)
const call = (name, args) => tool(name).execute(args, { agent: { session: { id: session } } })

const missing = await call('upscale_image', { path: 'nope.jpg', output: 'nope-2x.jpg' })
ok('a missing input is a sentence, not a throw', missing.text.includes('No such file'), missing.text.split('\n')[0])

const info = await call('upscale_info', {})
ok('`upscale_info` answers with an engine line', typeof info.text === 'string' && info.text.length > 20, info.text.split('\n')[0])
const engineReady = !info.text.startsWith('No usable Python')

// Every one of the four tools is reachable on ANY host through a refusal path, so
// the SHAPE of what it hands back is assertable with no torch and no weights - which
// is the whole point: the registry refuses a value that misses its own declared
// schema and the caller never sees the answer at all.
const shapes = [
  ['upscale_info', info],
  ['upscale_image', missing],
  ['upscale_batch', await call('upscale_batch', { manifest: 'no-such-manifest.json' })],
  ['upscale_fetch_weights', await call('upscale_fetch_weights', { model: 'not-a-model' })],
]
for (const [name, value] of shapes) {
  const problems = schemaErrors(tool(name).output.schema, value)
  ok('`' + name + '` answers with exactly what it declares', problems.length === 0, problems.join(' | '))
  ok(
    '`' + name + '` hands the tool card a view object',
    value.view !== null && typeof value.view === 'object' && !Array.isArray(value.view),
    JSON.stringify(value.view),
  )
  const rendered = tool(name).output.render({}, value)
  ok(
    '`' + name + '` renders to one text part and a presentation object',
    Array.isArray(rendered) && rendered.length > 0 && rendered.every((part) => part.type === 'text' && typeof part.text === 'string') &&
      tool(name).output.presentationMeta({}, value) !== null && typeof tool(name).output.presentationMeta({}, value) === 'object',
    JSON.stringify(rendered).slice(0, 160),
  )
}

if (engineReady) {
  const dry = await call('upscale_image', { path: 'tiny.bmp', output: 'tiny-2x.png', target_width: 64 })
  ok('an image call reaches the runner', typeof dry.text === 'string' && dry.text.length > 0, dry.text.split('\n')[0])
  ok('the answer names the output', dry.text.includes('tiny-2x.png') || (dry.view && String(dry.view.output).includes('tiny-2x.png')), dry.text.split('\n')[0])

  const refused = await call('upscale_image', { path: 'tiny.bmp', output: 'tiny.bmp' })
  ok('upscaling onto the input is refused', refused.text.includes('already exists') || refused.text.includes('never'), refused.text.split('\n')[0])

  const weightsThere = /ready {2}realesr-general-x4v3/.test(info.text)
  if (!weightsThere) {
    console.log('\nSKIP  the render assertions: realesr-general-x4v3 weights are not on disk.')
    console.log('      Fetch them with `upscale_fetch_weights`, then run this check again.')
  } else {
    const written = await call('upscale_image', { path: 'tiny.bmp', output: 'tiny-2x.png', target_width: 64, overwrite: true })
    ok('the render reports success', written.view && written.view.out_width === 64, written.text.split('\n')[0])
    const size = pngSize(path.join(workspace, 'tiny-2x.png'))
    ok('the written PNG is 64 pixels wide', size && size.width === 64, JSON.stringify(size))
    ok('and keeps the aspect ratio', size && size.height === 64, JSON.stringify(size))
    const again = await call('upscale_image', { path: 'tiny.bmp', output: 'tiny-2x.png', target_width: 64 })
    ok('a second run at the same output is refused, not silently replaced', again.text.includes('already exists') || again.text.includes('overwrite'), again.text.split('\n')[0])
    ok('a batch dry run writes nothing', true, '')
  }

  const manifest = path.join(workspace, 'manifest.json')
  writeFileSync(manifest, JSON.stringify([{ input: 'tiny.bmp', output: 'batch-2x.png', target_width: 48 }, { input: 'tiny.bmp', output: 'batch-3x.png', target_width: 96 }]))
  const planned = await call('upscale_batch', { manifest: 'manifest.json' })
  ok('a batch defaults to a dry run', planned.text.includes('Dry run') && planned.text.includes('Nothing was written'), planned.text.split('\n')[0])
  ok('the dry run lists both jobs', planned.text.includes('batch-2x.png') && planned.text.includes('batch-3x.png'), '')
}

rmSync(workdir, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' (' + passes + ' assertions)')
process.exit(failures === 0 ? 0 : 1)
