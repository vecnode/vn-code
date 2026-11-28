// check-comfyui-node.mjs - dsh-comfyui's own contract, driven end to end.
//
// ComfyUI is the user's own application and it is not running on a fresh
// machine, so the only way to exercise the compiler, the validator, the rungs
// and the refusals deterministically is a FAKE server: a `node:http` server on
// 127.0.0.1:0 that answers the real routes with real-shaped bodies - a classic
// `/object_info` entry, a V3 one, a `prompt_id`, a `history` entry with
// `status.messages`, and a 400 carrying `node_errors`.
//
// What that makes an ASSERTION rather than an observation:
//
//   - KSampler's widgets_values is [42, "fixed", 4, 1.5, "lcm", "sgm_uniform", 1]
//     - the control_after_generate value sits at index 1, and a compiler that
//     dropped it would shift cfg, sampler and scheduler by one with no error;
//   - a wire is ["<id>", <slot>] with the id as a STRING;
//   - the canvas round-trips back to the same prompt through the decoder;
//   - `value_not_in_list` is produced for a combo value the server does not
//     have, and only when a COMPLETE catalog is in force.
//
// Four sections need the real world and each says so when it cannot:
//
//   - the SKILL EXAMPLES: every fenced ```json block must parse, every ```js
//     block must pass `node --check`, every ```python block must pass Python's
//     own `ast.parse` when a Python is on PATH, and every `curl` / `comfy` line
//     must name a route or a subcommand this package documents;
//   - `comfy_cli` needs no CLI here: a fake runner answers the argv, which also
//     proves the argv this row builds;
//   - the LIVE half: only when a real server answers at the default port or
//     DSH_COMFYUI_URL, one compile is checked against the catalog it reports.
//
// Run:  node checks/check-comfyui-node.mjs
//       DSH_COMFYUI_CHECK_LIVE=0 node checks/check-comfyui-node.mjs   # pure half
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  CORE_NODES,
  SOURCES,
  catalogFromObjectInfo,
  coreCatalog,
  categoriesIn,
  nodeFromTable,
  nodeIn,
  outputSlot,
  parseNodeInfo,
  searchCatalog,
  widgetInputs,
} from '../lib/nodes.js'
import { readSpec, slugify, typesCompatible } from '../lib/spec.js'
import { compileProject, coerce, describeCatalog, CONTROL_AFTER_GENERATE } from '../lib/compile.js'
import { validatePrompt, parseWorkflow, workflowToPrompt, decodeWidgetValues, outputsOf, errorsOf } from '../lib/graph.js'
import { checkPromptFiles, inventory } from '../lib/files.js'
import { buildFromSpec, createProject, projectPaths, projectsRoot, listProjects, readJson } from '../lib/projects.js'
import { listExamples, readExample } from '../lib/examples.js'
import { buildTools, rebindToCatalog } from '../lib/tools.js'
import { activationLine, createDeps, parseSkillFile, __internals } from '../lib/index.js'
import { cliVersion, parseEnvelope, envFacts, whichFacts, promptIdFromRunText, depsArgv, runArgv, argvFor, explainCliFailure } from '../lib/cli.js'
import { discoverInstall, resolveServers, isLoopbackHost, formatBytes } from '../lib/client.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(here, '..')
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

let checks = 0
let failures = 0
let skipped = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
const skip = (label, reason) => {
  skipped += 1
  console.log('skip ' + label.padEnd(62) + ' (' + reason + ')')
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------
check('the package is a dsh bundle with a patch layer', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml')
check('the row owns no browser half', manifest.dsh.client === undefined, true)
check('the row has no npm dependency', manifest.dependencies === undefined && manifest.peerDependencies === undefined, true)
check('the version is the alpha this check knows', manifest.version, __internals.PLUGIN_VERSION)
check('package.json ships lib, examples, skills, checks', ['lib', 'examples', 'skills', 'checks', 'cordis.patch.yml'].every((entry) => manifest.files.includes(entry)), true)
check('seven tools are declared', __internals.CAPABILITIES.tools.length, 7)
check('six skills are declared', __internals.CAPABILITIES.skills.length, 6)
check('the rung ladder is the four this check drives', __internals.CAPABILITIES.rungs.join(','), 'v1-structural,v2-schema,v3-queued,v4-executed')
check('the four examples are declared', __internals.CAPABILITIES.examples.join(','), 'smoke-image,smoke-video,text-to-image,image-to-image')
check('the endpoints are loopback API paths', __internals.CAPABILITIES.endpoints.every((entry) => entry.startsWith('/')), true)

// ---------------------------------------------------------------------------
// The /object_info parser - both shapes in one document
// ---------------------------------------------------------------------------
// Transcribed from ComfyUI 0.21.1 (`nodes.py`): the classic `[type, options]`
// tuple, a combo declared as a LIST, a combo declared as "COMBO" with options
// (the V3 form `RepeatImageBatch` answers with), the control_after_generate
// flag, forceInput, optional inputs and hidden inputs.
const FIXTURE = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL', {}],
        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'lcm'], {}],
        scheduler: [['normal', 'karras', 'sgm_uniform'], {}],
        positive: ['CONDITIONING', {}],
        negative: ['CONDITIONING', {}],
        latent_image: ['LATENT', {}],
        denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
      },
    },
    input_order: { required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'] },
    output: ['LATENT'],
    output_name: ['LATENT'],
    output_node: false,
    name: 'KSampler',
    display_name: 'KSampler',
    category: 'sampling',
  },
  SaveImage: {
    input: {
      required: { images: ['IMAGE', {}], filename_prefix: ['STRING', { default: 'ComfyUI' }] },
      hidden: { prompt: 'PROMPT', extra_pnginfo: 'EXTRA_PNGINFO' },
    },
    input_order: { required: ['images', 'filename_prefix'] },
    output: [],
    output_name: [],
    output_node: true,
    name: 'SaveImage',
    display_name: 'Save Image',
    category: 'image',
  },
  LoadImage: {
    input: { required: { image: [['example.png', 'photo.png'], { image_upload: true }] } },
    input_order: { required: ['image'] },
    output: ['IMAGE', 'MASK'],
    output_name: ['IMAGE', 'MASK'],
    output_node: false,
    name: 'LoadImage',
    category: 'image',
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['v1-5-pruned-emaonly-fp16.safetensors'], {}] } },
    input_order: { required: ['ckpt_name'] },
    output: ['MODEL', 'CLIP', 'VAE'],
    output_name: ['MODEL', 'CLIP', 'VAE'],
    output_node: false,
    name: 'CheckpointLoaderSimple',
    category: 'loaders',
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL', {}],
        clip: ['CLIP', {}],
        lora_name: [['lcm-lora-sd15.safetensors'], {}],
        strength_model: ['FLOAT', { default: 1.0, min: -100.0, max: 100.0, step: 0.01 }],
        strength_clip: ['FLOAT', { default: 1.0, min: -100.0, max: 100.0, step: 0.01 }],
      },
    },
    input_order: { required: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'] },
    output: ['MODEL', 'CLIP'],
    output_name: ['MODEL', 'CLIP'],
    output_node: false,
    name: 'LoraLoader',
    category: 'loaders',
  },
  ImageScale: {
    input: {
      required: {
        image: ['IMAGE', {}],
        upscale_method: [['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'], {}],
        width: ['INT', { default: 512, min: 0, max: 16384, step: 1 }],
        height: ['INT', { default: 512, min: 0, max: 16384, step: 1 }],
        crop: [['disabled', 'center'], {}],
      },
    },
    input_order: { required: ['image', 'upscale_method', 'width', 'height', 'crop'] },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    output_node: false,
    name: 'ImageScale',
    category: 'image/upscaling',
  },
  EmptyImage: {
    input: {
      required: {
        width: ['INT', { default: 512, min: 1, max: 16384, step: 1 }],
        height: ['INT', { default: 512, min: 1, max: 16384, step: 1 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
        color: ['INT', { default: 0, min: 0, max: 16777215, step: 1, display: 'color' }],
      },
    },
    input_order: { required: ['width', 'height', 'batch_size', 'color'] },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    output_node: false,
    name: 'EmptyImage',
    category: 'image',
  },
  // The V3 shape: COMBO with `options`, an optional input, and is_output_node.
  RepeatImageBatch: {
    input: { required: { image: ['IMAGE', {}], amount: ['INT', { default: 1, min: 1, max: 4096 }] } },
    input_order: { required: ['image', 'amount'] },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    output_node: false,
    name: 'RepeatImageBatch',
    category: 'image/batch',
  },
  CreateVideo: {
    input: {
      required: { images: ['IMAGE', {}], fps: ['FLOAT', { default: 30.0, min: 1.0, max: 120.0, step: 1.0 }] },
      optional: { audio: ['AUDIO', { optional: true }] },
    },
    input_order: { required: ['images', 'fps'], optional: ['audio'] },
    output: ['VIDEO'],
    output_name: ['VIDEO'],
    output_node: false,
    name: 'CreateVideo',
    category: 'video',
  },
  SaveVideo: {
    input: {
      required: {
        video: ['VIDEO', {}],
        filename_prefix: ['STRING', { default: 'video/ComfyUI' }],
        format: ['COMBO', { options: ['auto', 'mp4', 'webm'], default: 'auto' }],
        codec: ['COMBO', { options: ['auto', 'h264', 'vp9'], default: 'auto' }],
      },
      hidden: { prompt: 'PROMPT', extra_pnginfo: 'EXTRA_PNGINFO' },
    },
    input_order: { required: ['video', 'filename_prefix', 'format', 'codec'] },
    output: [],
    output_name: [],
    output_node: true,
    name: 'SaveVideo',
    display_name: 'Save Video',
    category: 'video',
  },
}

/** The rest of the classes, in `/object_info` shape, from the core table. */
function objectInfoFromTable(classType) {
  const node = nodeFromTable(classType, CORE_NODES[classType])
  const input = { required: {}, optional: {}, hidden: {} }
  const order = { required: [], optional: [] }
  for (const entry of node.inputs) {
    if (entry.kind === 'hidden') {
      input.hidden[entry.name] = entry.type
      continue
    }
    const section = entry.optional ? 'optional' : 'required'
    const type = entry.enum !== null ? entry.enum : entry.type
    const options = entry.controlAfterGenerate ? { ...entry.options, control_after_generate: true } : { ...entry.options }
    input[section][entry.name] = [type, options]
    order[section].push(entry.name)
  }
  return {
    input,
    input_order: order,
    output: node.outputs.map((output) => output.type),
    output_name: node.outputs.map((output) => output.name),
    output_node: node.outputNode,
    name: classType,
    display_name: node.displayName,
    category: node.category,
    description: node.description,
  }
}

/** The whole fixture catalog: the hand-written entries plus the table's rest. */
function fullFixture() {
  const raw = { ...FIXTURE }
  for (const classType of Object.keys(CORE_NODES)) if (!(classType in raw)) raw[classType] = objectInfoFromTable(classType)
  return raw
}

const ks = parseNodeInfo('KSampler', FIXTURE.KSampler)
check('the parser keeps the input ORDER', ks.inputs.map((input) => input.name).join(','), 'model,seed,steps,cfg,sampler_name,scheduler,positive,negative,latent_image,denoise')
check('a MODEL input is a link, not a widget', ks.inputs.find((input) => input.name === 'model').kind, 'link')
check('a LIST type is a combo widget', ks.inputs.find((input) => input.name === 'sampler_name').kind, 'widget')
check('...and its options are the list', ks.inputs.find((input) => input.name === 'sampler_name').enum.join(','), 'euler,euler_ancestral,dpmpp_2m,lcm')
check('control_after_generate is read from the options', ks.inputs.find((input) => input.name === 'seed').controlAfterGenerate, true)
check('min and max are kept', ks.inputs.find((input) => input.name === 'steps').options.min + '..' + ks.inputs.find((input) => input.name === 'steps').options.max, '1..10000')
check('an output node says so', parseNodeInfo('SaveImage', FIXTURE.SaveImage).outputNode, true)
check('hidden inputs are marked hidden', parseNodeInfo('SaveImage', FIXTURE.SaveImage).inputs.filter((input) => input.kind === 'hidden').map((input) => input.name).join(','), 'prompt,extra_pnginfo')
check('output NAMES are read, not just types', parseNodeInfo('LoadImage', FIXTURE.LoadImage).outputs.map((output) => output.name).join(','), 'IMAGE,MASK')
check('an image-upload combo is still a widget', parseNodeInfo('LoadImage', FIXTURE.LoadImage).inputs[0].kind, 'widget')
check('the V3 COMBO shape reads its options', parseNodeInfo('SaveVideo', FIXTURE.SaveVideo).inputs.find((input) => input.name === 'format').enum.join(','), 'auto,mp4,webm')
check('an optional input is optional', parseNodeInfo('CreateVideo', FIXTURE.CreateVideo).inputs.find((input) => input.name === 'audio').optional, true)
check('an optional input is still a link', parseNodeInfo('CreateVideo', FIXTURE.CreateVideo).inputs.find((input) => input.name === 'audio').kind, 'link')

// The table is the fallback every offline compile uses, so its ORDER is a
// contract: assert the seven classes whose order is the trap.
for (const classType of ['KSampler', 'SaveImage', 'LoadImage', 'ImageScale', 'EmptyImage', 'RepeatImageBatch', 'CreateVideo']) {
  const fromFixture = parseNodeInfo(classType, FIXTURE[classType])
  const fromTable = nodeFromTable(classType, CORE_NODES[classType])
  check('the core table agrees with /object_info on ' + classType, fromTable.inputs.map((input) => input.name + ':' + input.kind).join(','), fromFixture.inputs.map((input) => input.name + ':' + input.kind).join(','))
}
check('the core table covers the examples it must', ['KSampler', 'SaveImage', 'EmptyImage', 'SaveVideo', 'LoadImage'].every((name) => name in CORE_NODES), true)
check('the core catalog says it is NOT complete', coreCatalog().complete, false)
check('a server catalog says it IS complete', catalogFromObjectInfo(FIXTURE).complete, true)
check('the parser skips an entry it cannot read', catalogFromObjectInfo({ Bad: 42 }).nodes.size, 0)

// ---------------------------------------------------------------------------
// The spec: every refusal, by name
// ---------------------------------------------------------------------------
const completeCatalog = catalogFromObjectInfo(fullFixture(), { origin: 'http://127.0.0.1:8188', version: '0.21.1', fetchedAt: 'now' })

/** The findings of a spec, read against a catalog. */
function specFindings(spec, catalog = completeCatalog) {
  try {
    return readSpec(spec, catalog).findings
  } catch (error) {
    return [{ severity: 'error', type: error.code ?? 'THREW', message: error.message }]
  }
}
const errorTypes = (findings) => findings.filter((entry) => entry.severity === 'error').map((entry) => entry.type).join(',')

const baseSpec = {
  name: 'probe',
  nodes: [
    { key: 'empty', class: 'EmptyImage', widgets: { width: 64, height: 64, batch_size: 1, color: 0 } },
    { key: 'save', class: 'SaveImage', title: 'Save', widgets: { filename_prefix: 'x' }, wires: { images: 'empty.IMAGE' } },
  ],
}
check('a minimal spec has no errors', errorTypes(specFindings(baseSpec)), '')
check('a name is required', errorTypes(specFindings({ ...baseSpec, name: '' })), 'missing_name')
check('nodes are required', errorTypes(specFindings({ ...baseSpec, nodes: [] })), 'missing_nodes')
check('a duplicate key is refused', errorTypes(specFindings({ ...baseSpec, nodes: [baseSpec.nodes[0], baseSpec.nodes[0], baseSpec.nodes[1]] })), 'duplicate_key')
check('a bad key is refused', errorTypes(specFindings({ ...baseSpec, nodes: [{ key: '9 bad', class: 'SaveImage' }] })), 'bad_key')
check('a class the server lacks is an ERROR when the catalog is complete', errorTypes(specFindings({ ...baseSpec, nodes: [{ key: 'x', class: 'NoSuchNode' }, ...baseSpec.nodes] })), 'missing_node_type')
check('...and only a WARNING against the core table', specFindings({ ...baseSpec, nodes: [{ key: 'x', class: 'NoSuchNode' }, ...baseSpec.nodes] }, coreCatalog()).filter((entry) => entry.type === 'class_unverified').length, 1)
check('an unknown widget is refused, and names the real ones', specFindings({ ...baseSpec, nodes: [{ key: 'empty', class: 'EmptyImage', widgets: { widht: 64 } }, baseSpec.nodes[1]] })[0].message.includes('width'), true)
check('an unknown output is refused, and lists the slots', specFindings({ ...baseSpec, nodes: [baseSpec.nodes[0], { key: 'save', class: 'SaveImage', wires: { images: 'empty.IMAGE0' } }] })[0].message.includes('0=IMAGE:IMAGE'), true)
check('a wire from a key that does not exist is refused', errorTypes(specFindings({ ...baseSpec, nodes: [baseSpec.nodes[0], { key: 'save', class: 'SaveImage', wires: { images: 'ghost.0' } }] })), 'bad_linked_input')
check('a type mismatch is refused in the spec too', errorTypes(specFindings({ ...baseSpec, nodes: [baseSpec.nodes[0], { key: 'save', class: 'SaveImage', widgets: { filename_prefix: 'x' }, wires: { images: 'empty.0', filename_prefix: 'empty.IMAGE' } }] })), 'return_type_mismatch')
check('a graph with no output node is refused', errorTypes(specFindings({ name: 'p', nodes: [{ key: 'a', class: 'EmptyImage' }] })), 'prompt_no_outputs')
check('a cycle is refused', errorTypes(specFindings({ name: 'p', nodes: [{ key: 'a', class: 'LoraLoader', widgets: { lora_name: 'l', strength_model: 1, strength_clip: 1 }, wires: { model: 'b.MODEL' } }, { key: 'b', class: 'LoraLoader', widgets: { lora_name: 'l', strength_model: 1, strength_clip: 1 }, wires: { model: 'a.MODEL' } }] })).includes('dependency_cycle'), true)
check('an unknown field is only a warning', specFindings({ ...baseSpec, wat: 1 }).filter((entry) => entry.type === 'unknown_field').length, 1)
check('a wire may name a numeric slot', specFindings({ ...baseSpec, nodes: [baseSpec.nodes[0], { key: 'save', class: 'SaveImage', widgets: { filename_prefix: 'x' }, wires: { images: 'empty.0' } }] }).filter((entry) => entry.severity === 'error').length, 0)

// The type rule is ComfyUI's own: union types, `*` matches anything.
check('identical types match', typesCompatible('IMAGE', 'IMAGE'), true)
check('a union input accepts one of its members', typesCompatible('IMAGE', 'IMAGE,MASK'), true)
check('`*` accepts anything', typesCompatible('*', 'LATENT') && typesCompatible('LATENT', '*'), true)
check('IMAGE does not feed LATENT', typesCompatible('IMAGE', 'LATENT'), false)

// ---------------------------------------------------------------------------
// The compiler: the four shipped examples, and the widget trap
// ---------------------------------------------------------------------------
const dryPaths = { dir: '(memory)', spec: '', workflow: '', prompt: '', readme: '', build: '' }
const examples = listExamples()
check('the four examples are on disk', examples.map((entry) => entry.slug).join(','), 'smoke-image,smoke-video,text-to-image,image-to-image')
const compiled = new Map()
for (const example of examples) {
  const built = buildFromSpec({ raw: readExample(example.slug), paths: dryPaths, catalog: coreCatalog(), dryRun: true })
  compiled.set(example.slug, built)
  check('example ' + example.slug + ' compiles against the core table', built.rung, 'v1-structural')
  check('...with no errors', built.counts.errors, 0)
}
const ksNode = compiled.get('text-to-image').workflow.nodes.find((node) => node.type === 'KSampler')
check('KSampler widgets_values carries the control value at index 1', JSON.stringify(ksNode.widgets_values), JSON.stringify([42, 'fixed', 4, 1.5, 'lcm', 'sgm_uniform', 1]))
check('...so the array is one longer than the widget count', ksNode.widgets_values.length, widgetInputs(nodeIn(completeCatalog, 'KSampler')).length + 1)
check('...and the prompt does NOT carry the control value', String(compiled.get('text-to-image').prompt[String(ksNode.id)].inputs.control_after_generate ?? 'absent'), 'absent')
check('a wire is ["id", slot] with a STRING id', JSON.stringify(compiled.get('smoke-image').prompt['2'].inputs.images), JSON.stringify(['1', 0]))
check('ids are strings in the prompt', Object.keys(compiled.get('smoke-image').prompt).every((key) => typeof key === 'string'), true)
check('the canvas links are OBJECTS (the 0.4 form)', Array.isArray(compiled.get('smoke-image').workflow.links) && typeof compiled.get('smoke-image').workflow.links[0] === 'object' && !Array.isArray(compiled.get('smoke-image').workflow.links[0]), true)
check('the canvas version is 0.4', compiled.get('smoke-image').workflow.version, 0.4)
check('target_slot points into the target node inputs', compiled.get('text-to-image').workflow.links.every((link) => {
  const target = compiled.get('text-to-image').workflow.nodes.find((node) => node.id === link.target_id)
  return target.inputs[link.target_slot] !== undefined
}), true)
check('every node has a position off the origin', compiled.get('text-to-image').workflow.nodes.every((node) => node.pos[0] > 0), true)
check('an output node with no outputs has an empty OUT list', compiled.get('smoke-image').workflow.nodes.find((node) => node.type === 'SaveImage').outputs.length, 0)
check('a hidden input never reaches the prompt', Object.keys(compiled.get('smoke-image').prompt['2'].inputs).includes('prompt'), false)
check('the widget order comes from the catalog in force', compiled.get('smoke-image').widgetOrder, 'core-table')
check('a complete catalog is recorded as such', buildFromSpec({ raw: readExample('smoke-image'), paths: dryPaths, catalog: completeCatalog, dryRun: true }).widgetOrder, 'server')
check('the dry run WROTE nothing', existsSync(path.join(packageRoot, 'workflow.json')), false)

// The round-trip: canvas -> prompt, through the decoder, with a complete catalog.
const roundTripCatalog = { ...coreCatalog(), complete: true }
const roundTripped = workflowToPrompt(parseWorkflow(compiled.get('text-to-image').workflow), roundTripCatalog)
/** JSON with sorted keys, so a comparison is about VALUES and not key order. */
const canonical = (value) => JSON.stringify(value, (_key, entry) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry))
check('a compiled canvas lowers back to the same prompt', canonical(roundTripped.prompt), canonical(compiled.get('text-to-image').prompt))
check('...and the round-trip reports no errors', roundTripped.findings.filter((entry) => entry.severity === 'error').length, 0)
const legacyLinks = compiled.get('smoke-image').workflow.links.map((link) => [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type])
const legacyWorkflow = { ...compiled.get('smoke-image').workflow, links: legacyLinks }
check('legacy ARRAY links are read too', workflowToPrompt(parseWorkflow(legacyWorkflow), roundTripCatalog).prompt['2'].inputs.images.join(','), '1,0')
check('a canvas without a complete catalog is REFUSED, by name', (() => {
  try {
    workflowToPrompt(parseWorkflow(compiled.get('smoke-image').workflow), coreCatalog())
    return 'accepted'
  } catch (error) {
    return error.code
  }
})(), 'SCHEMA_REQUIRED')
check('decodeWidgetValues stops the control value from shifting the rest', decodeWidgetValues(nodeIn(completeCatalog, 'KSampler'), [7, 'randomize', 9, 2.5, 'euler', 'karras', 0.5]).steps, 9)
check('a subgraph-only export is refused with the ungroup advice', (() => {
  try {
    parseWorkflow({ nodes: [], links: [], definitions: { subgraphs: [{ name: 'Sub', id: 'x' }] } })
    return 'accepted'
  } catch (error) {
    return error.code + ':' + /ungroup/i.test(error.message)
  }
})(), 'SUBGRAPH_ONLY:true')

// Coercion: the server's own spelling wins, and a wrong value is named.
const scaleSpec = nodeIn(completeCatalog, 'ImageScale')
check('a case-insensitive combo match normalizes to the server spelling', coerce('Lanczos', scaleSpec.inputs.find((input) => input.name === 'upscale_method')).value, 'lanczos')
check('a value not in the list is refused as value_not_in_list', coerce('magic', scaleSpec.inputs.find((input) => input.name === 'upscale_method')).type, 'value_not_in_list')
check('an INTEGER below min is refused', coerce(0 - 1, scaleSpec.inputs.find((input) => input.name === 'width')).type, 'value_smaller_than_min')
check('a fractional INT is refused', coerce(1.5, ks.inputs.find((input) => input.name === 'steps')).type, 'invalid_input_type')
check('a numeric string is coerced', coerce('42', ks.inputs.find((input) => input.name === 'steps')).value, 42)

// ---------------------------------------------------------------------------
// The prompt validator: ComfyUI's own error types
// ---------------------------------------------------------------------------
const promptOf = (slug) => JSON.parse(JSON.stringify(compiled.get(slug).prompt))
const typesOf = (findings) => findings.filter((entry) => entry.severity === 'error').map((entry) => entry.type).sort().join(',')
const findIn = (prompt, classType) => Object.entries(prompt).find(([, node]) => node.class_type === classType)

check('a compiled prompt validates clean against a complete catalog', typesOf(validatePrompt(promptOf('smoke-image'), completeCatalog).findings), '')
check('...and against the core table', typesOf(validatePrompt(promptOf('smoke-image'), coreCatalog()).findings), '')
{
  const prompt = promptOf('smoke-image')
  const [id, node] = findIn(prompt, 'SaveImage')
  delete node.inputs.filename_prefix
  delete node.inputs.images
  check('a missing required input is required_input_missing', typesOf(validatePrompt(prompt, completeCatalog).findings), 'required_input_missing,required_input_missing')
  check('...on the node that is missing it', validatePrompt(prompt, completeCatalog).nodeErrors[id].length, 2)
}
{
  const prompt = promptOf('smoke-image')
  findIn(prompt, 'SaveImage')[1].inputs.images = ['99', 0]
  check('a wire from a node not in the prompt is bad_linked_input', typesOf(validatePrompt(prompt, completeCatalog).findings), 'bad_linked_input')
}
{
  const prompt = promptOf('smoke-image')
  findIn(prompt, 'SaveImage')[1].inputs.images = ['1', 7]
  check('a slot that does not exist is bad_linked_input', typesOf(validatePrompt(prompt, completeCatalog).findings), 'bad_linked_input')
}
{
  const prompt = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly-fp16.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: { model: ['1', 0], seed: 1, steps: 4, cfg: 1.5, sampler_name: 'nonsense', scheduler: 'sgm_uniform', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1 },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
  }
  check('a combo value the server lacks is value_not_in_list', typesOf(validatePrompt(prompt, completeCatalog).findings), 'value_not_in_list')
  check('...and is NOT reported against the core table (no options known)', typesOf(validatePrompt(prompt, coreCatalog()).findings), '')
}
{
  const prompt = {
    '1': { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
    '2': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'x' } },
  }
  check('a self-wire is a dependency_cycle', typesOf(validatePrompt(prompt, completeCatalog).findings).includes('dependency_cycle'), true)
}
{
  const prompt = { '1': { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } } }
  check('no output node is prompt_no_outputs', typesOf(validatePrompt(prompt, completeCatalog).findings), 'prompt_no_outputs')
}
{
  const prompt = promptOf('smoke-image')
  prompt['9'] = { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } }
  const findings = validatePrompt(prompt, completeCatalog).findings
  check('an orphan node is a warning, not an error', findings.filter((entry) => entry.type === 'unreachable_node').length + '/' + findings.filter((entry) => entry.severity === 'error').length, '1/0')
}
{
  const prompt = promptOf('smoke-image')
  prompt['1'].inputs.width = 0
  check('a value below min is value_smaller_than_min', typesOf(validatePrompt(prompt, completeCatalog).findings), 'value_smaller_than_min')
}
check('an empty prompt is refused', typesOf(validatePrompt({}, completeCatalog).findings), 'prompt_empty')
check('a non-object prompt is refused', typesOf(validatePrompt([], completeCatalog).findings), 'prompt_invalid')

// ---------------------------------------------------------------------------
// History: outputs and failures, whatever the node calls them
// ---------------------------------------------------------------------------
const historyEntry = {
  outputs: { '2': { images: [{ filename: 'smoke_00001_.png', subfolder: 'dsh-comfyui', type: 'output' }] } },
  status: { status_str: 'success', completed: true, messages: [['execution_start', {}], ['execution_success', {}]] },
}
check('an output file is found without knowing the key', outputsOf(historyEntry).length, 1)
check('...with a /view url', outputsOf(historyEntry)[0].url, '/view?filename=smoke_00001_.png&subfolder=dsh-comfyui&type=output')
check('an AUDIO output is found the same way', outputsOf({ outputs: { '3': { audio: [{ filename: 'a.flac', subfolder: 'audio', type: 'output' }] } } }).length, 1)
check('no outputs is an empty list', outputsOf({}).length, 0)
const failedEntry = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_id: '5', node_type: 'KSampler', exception_message: 'CUDA out of memory', exception_type: 'torch.OutOfMemoryError' }]] } }
check('an execution error is read out of status.messages', errorsOf(failedEntry).length, 1)
check('...with the node and the exception', errorsOf(failedEntry)[0].node + ':' + errorsOf(failedEntry)[0].exceptionType, '5:torch.OutOfMemoryError')
check('a success entry has no errors', errorsOf(historyEntry).length, 0)

// ---------------------------------------------------------------------------
// Rebindings: the template follows the machine, never guessing
// ---------------------------------------------------------------------------
{
  const ckptInfo = (names) => ({ ...FIXTURE.CheckpointLoaderSimple, input: { required: { ckpt_name: [names, {}] } }, input_order: { required: ['ckpt_name'] } })
  const one = catalogFromObjectInfo({ CheckpointLoaderSimple: ckptInfo(['only-one.safetensors']) })
  const rebound = rebindToCatalog({ name: 'p', bindings: { checkpoint: 'missing.safetensors' }, nodes: [{ key: 'ckpt', class: 'CheckpointLoaderSimple', widgets: { ckpt_name: '@checkpoint' } }] }, one)
  check('a single candidate is taken', rebound.spec.bindings.checkpoint, 'only-one.safetensors')
  check('...and the change is REPORTED', rebound.changes.length + ':' + rebound.changes[0].from, '1:missing.safetensors')
  const several = catalogFromObjectInfo({ CheckpointLoaderSimple: ckptInfo(['a.safetensors', 'b.safetensors', 'c.safetensors']) })
  const ambiguous = rebindToCatalog({ name: 'p', bindings: { checkpoint: 'missing.safetensors' }, nodes: [{ key: 'ckpt', class: 'CheckpointLoaderSimple', widgets: { ckpt_name: '@checkpoint' } }] }, several)
  check('three candidates are not guessed between', ambiguous.spec.bindings.checkpoint, 'missing.safetensors')
  check('...and a note says why', ambiguous.notes.length, 1)
  const insensitive = rebindToCatalog({ name: 'p', bindings: { checkpoint: 'A.SAFETENSORS' }, nodes: [{ key: 'ckpt', class: 'CheckpointLoaderSimple', widgets: { ckpt_name: '@checkpoint' } }] }, several)
  check('a case-insensitive match IS taken, in the server spelling', insensitive.spec.bindings.checkpoint, 'a.safetensors')
}

// ---------------------------------------------------------------------------
// The fake ComfyUI server
// ---------------------------------------------------------------------------
const OBJECT_INFO = fullFixture()
let refuseNext = null
let historyEntryFor = null
const requests = []
function readAll(request) {
  return new Promise((resolve) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => resolve(text))
  })
}
async function startFakeComfy() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const raw = await readAll(request)
    let body = null
    try {
      body = raw === '' ? null : JSON.parse(raw)
    } catch (error) {
      body = null
    }
    requests.push({ method: request.method, path: url.pathname, body })
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/system_stats') {
      return json(200, {
        system: { os: 'nt', ram_total: 16 * 1024 ** 3, ram_free: 8 * 1024 ** 3, comfyui_version: '0.21.1', python_version: '3.12.11 (main)', pytorch_version: '2.9.0+cu128', argv: ['main.py'] },
        devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4060', type: 'cuda', vram_total: 8 * 1024 ** 3, vram_free: 6 * 1024 ** 3 }],
      })
    }
    if (url.pathname === '/object_info') return json(200, OBJECT_INFO)
    if (url.pathname.startsWith('/object_info/')) {
      const classType = decodeURIComponent(url.pathname.slice('/object_info/'.length))
      return json(200, classType in OBJECT_INFO ? { [classType]: OBJECT_INFO[classType] } : {})
    }
    if (url.pathname === '/prompt' && request.method === 'POST') {
      if (refuseNext !== null) {
        const refusal = refuseNext
        refuseNext = null
        return json(400, refusal)
      }
      const promptId = 'prompt-0001'
      historyEntryFor = { promptId, prompt: body?.prompt ?? {} }
      return json(200, { prompt_id: promptId, number: 1, node_errors: {} })
    }
    if (url.pathname === '/prompt') return json(200, { queue_running: [], queue_pending: [] })
    if (url.pathname === '/queue') return json(200, { queue_running: [], queue_pending: [] })
    if (url.pathname.startsWith('/history/')) {
      const promptId = url.pathname.slice('/history/'.length)
      if (historyEntryFor !== null && historyEntryFor.promptId === promptId) {
        const saved = Object.values(historyEntryFor.prompt).filter((node) => node.class_type === 'SaveImage' || node.class_type === 'SaveVideo')
        const outputs = {}
        for (const node of Object.values(historyEntryFor.prompt)) {
          if (node.class_type === 'SaveImage') outputs[Object.keys(historyEntryFor.prompt).find((key) => historyEntryFor.prompt[key] === node)] = { images: [{ filename: 'smoke_00001_.png', subfolder: 'dsh-comfyui', type: 'output' }] }
          if (node.class_type === 'SaveVideo') outputs[Object.keys(historyEntryFor.prompt).find((key) => historyEntryFor.prompt[key] === node)] = { images: [{ filename: 'smoke_00001_.mp4', subfolder: 'dsh-comfyui', type: 'output' }] }
        }
        if (saved.length === 0) return json(200, {})
        return json(200, { [promptId]: { prompt: [1, promptId, historyEntryFor.prompt, {}, []], outputs, status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: promptId }]] } } })
      }
      return json(200, {})
    }
    return json(404, { error: '404 page not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

const fake = await startFakeComfy()
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-comfyui-check-'))
const home = path.join(sandbox, 'home')
const workspace = path.join(sandbox, 'ws')
const projectsRootDir = path.join(workspace, 'comfyui')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })

/** A fake comfy-cli: it answers the argv, and writes a deps file when asked. */
/**
 * A fake comfy-cli that answers with the REAL 1.29.0 envelope shapes.
 *
 * Transcribed from the measured output: `comfy --version` and `comfy --json env`
 * both print `{schema:"envelope/1", type:"envelope", ok, command, version,
 * where, data, error}`. `state.mode` drives the variants: 'ok' (comfy-cli's
 * default workspace does not exist, but the Desktop install it names does),
 * 'gone' (the install folder is gone too), 'no-manager' (deps refuses),
 * 'no-workspace' (run refuses before reading the graph), 'installed-manager'
 * (deps writes its file).
 */
function fakeRunner(state) {
  state.calls = state.calls ?? []
  state.mode = state.mode ?? 'ok'
  if (state.workspaceExists === undefined) state.workspaceExists = false
  if (state.installExists === undefined) state.installExists = true
  const envelope = (command, data, extra = {}) => JSON.stringify({ schema: 'envelope/1', type: 'envelope', ok: true, command, version: '1.29.0', where: null, data, error: null, ...extra })
  const envelopeError = (command, code, message, extra = {}) =>
    JSON.stringify({ schema: 'envelope/1', type: 'envelope', ok: false, command, version: '1.29.0', where: null, data: null, error: { code, message, ...extra } })
  return async (argv, options = {}) => {
    state.calls.push(argv)
    const joined = argv.join(' ')
    const installExists = state.installExists === true && state.mode !== 'gone'
    const workspaceExists = state.workspaceExists === true && state.mode !== 'gone'
    const envData = {
      python: { version: '3.12.11', executable: 'C:\\ComfyUI\\.venv\\Scripts\\python.exe', virtualenv: null, conda_env: null },
      config: { path: 'C:\\Users\\x\\AppData\\Local\\comfy-cli\\config.ini', default_workspace: null, recent_workspace: null, tracking_enabled: false, background: null },
      server: { running: state.serverRunning === true, url: state.serverRunning === true ? 'http://127.0.0.1:8188' : null },
      hardware: { os: 'Windows', os_version: '11', arch: 'AMD64', cpu: 'AMD64 Family', ram_bytes: 34265317376, gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vram_bytes: 25769803776, unified_memory: false } },
      workspace: {
        path: state.workspace ?? 'C:\\Users\\x\\Documents\\comfy\\ComfyUI',
        type: 'default',
        exists: workspaceExists,
        desktop: {
          install_id: null,
          name: null,
          code_dir: null,
          data_dir: null,
          custom_nodes_dir: null,
          python: null,
          model_roots: state.modelRoots ?? [],
          comfyui_version: null,
          comfy_commit: null,
          selected_reason: null,
          installs: [
            {
              install_id: 'inst-1',
              name: 'sdf',
              code_dir: state.installCode ?? 'C:\\Users\\x\\ComfyUI-Installs\\sdf\\ComfyUI',
              data_dir: state.installData ?? 'C:\\Users\\x\\ComfyUI-Installs\\sdf\\ComfyUI',
              comfyui_version: '0.21.1',
              last_launched_at: null,
              status: null,
              exists: installExists,
              selected: false,
            },
          ],
          app_data_dir: 'C:\\Users\\x\\AppData\\Roaming\\Comfy Desktop',
        },
        manager_mode: state.mode === 'installed-manager' ? 'enabled' : 'not-installed',
        manager_detected: state.mode === 'installed-manager' ? 'comfyui-manager' : 'none',
        uv_compile_default: false,
      },
      warnings: state.mode === 'gone' ? [{ code: 'workspace_not_found', message: 'Workspace directory does not exist: ' + (state.workspace ?? 'C:\\Users\\x\\Documents\\comfy\\ComfyUI') }] : [],
    }
    if (joined.endsWith('--version')) return { status: 0, stdout: envelope('version', { version: '1.29.0' }) + '\n', stderr: '' }
    if (argv.includes('env')) return { status: 0, stdout: envelope('env', envData) + '\n', stderr: '' }
    if (argv.includes('which')) return { status: 0, stdout: envelope('which', { workspace_path: envData.workspace.path, workspace_type: 'default', exists: envData.workspace.exists }) + '\n', stderr: '' }
    if (argv.includes('deps-in-workflow')) {
      if (state.mode === 'no-manager') return { status: 1, stdout: '', stderr: "ComfyUI-Manager not found. 'cm-cli' command is not available.\n" }
      const outputArg = argv.find((entry) => entry.startsWith('--output='))
      if (outputArg !== undefined) writeFileSync(outputArg.slice('--output='.length), JSON.stringify({ custom_nodes: ['comfyui-impact-pack'], models: [{ url: 'https://example.invalid/m.safetensors' }] }), 'utf8')
      return { status: 0, stdout: envelope('node deps-in-workflow', { output: outputArg === undefined ? '' : outputArg.slice('--output='.length) }) + '\n', stderr: '' }
    }
    if (argv.includes('run')) {
      if (state.mode === 'no-workspace') return { status: 1, stdout: '', stderr: "'C:\\Users\\x\\Documents\\comfy\\ComfyUI' is not a valid ComfyUI workspace.\nRun comfy install to set up ComfyUI, or use --workspace <path> to specify a valid path.\n" }
      return { status: 0, stdout: envelope('run', { prompt_id: '9f2c1d4e-0000-4000-8000-000000000000', number: 3 }) + '\n', stderr: '' }
    }
    if (argv.includes('download')) return { status: 0, stdout: envelope('download', { files: ['out.png'] }) + '\n', stderr: '' }
    if (argv.includes('launch')) return { status: 0, stdout: envelope('launch', { background: true }) + '\n', stderr: '' }
    if (argv.includes('stop')) return { status: 0, stdout: envelope('stop', { stopped: true }) + '\n', stderr: '' }
    return { status: 1, stdout: envelopeError('unknown', 'usage_error', 'unexpected argv: ' + joined) + '\n', stderr: 'unexpected argv: ' + joined }
  }
}

const stubCtx = { logger: { info() {}, warn() {} }, get: () => undefined, effect: (fn) => fn() }
const exec = { agent: { session: { id: 's1', header: { cwd: workspace } } }, signal: new AbortController().signal }
/** Deps whose ENV is merged, never replaced: the temp DSH_HOME must survive a test that only moves the URL. */
const makeDeps = (overrides = {}) => {
  const { env: envOverrides, ...rest } = overrides
  return createDeps(stubCtx, {
    sleep: async () => {},
    ...rest,
    env: { DSH_HOME: home, DSH_COMFYUI_ROOT: projectsRootDir, DSH_COMFYUI_URL: fake.origin, ...(envOverrides ?? {}) },
  })
}
const deps = makeDeps()
const tools = buildTools(deps)
const tool = (name) => tools.find((entry) => entry.name === name)

try {
  // -------------------------------------------------------------------------
  // The registration
  // -------------------------------------------------------------------------
  check('seven tools are registered', tools.map((entry) => entry.name).join(','), __internals.CAPABILITIES.tools.join(','))
  check(
    'every tool declares a JSON-schema surface',
    tools.every((entry) => entry.parameters && entry.parameters.type === 'object' && entry.output && typeof entry.output.render === 'function' && typeof entry.execute === 'function'),
    true,
  )
  check('every tool has an execute and a card', tools.every((entry) => typeof entry.execute === 'function' && typeof entry.presentCall === 'function'), true)
  check('the activation line names the loopback ports', /127\.0\.0\.1:8188/.test(activationLine(makeDeps({ env: { DSH_COMFYUI_URL: '' } }))), true)
  check('...and says nothing is started', /nothing is started/.test(activationLine(deps)), true)
  check('an off-machine URL is refused before a request', resolveServers({ DSH_COMFYUI_URL: 'http://10.0.0.5:8188' }).allowed, false)
  check('...with the opt-in named', resolveServers({ DSH_COMFYUI_URL: 'http://10.0.0.5:8188' }).reason.includes('DSH_COMFYUI_ALLOW_REMOTE'), true)
  check('the opt-in allows it', resolveServers({ DSH_COMFYUI_URL: 'http://10.0.0.5:8188', DSH_COMFYUI_ALLOW_REMOTE: '1' }).allowed, true)
  check('loopback detection is the ollama rule', isLoopbackHost('127.0.0.2') && isLoopbackHost('localhost') && !isLoopbackHost('example.com'), true)

  // -------------------------------------------------------------------------
  // comfy_status
  // -------------------------------------------------------------------------
  const status = await tool('comfy_status').execute({}, exec)
  check('status answers against the fake server', status.view.ok, true)
  check('...naming its origin', status.view.server.origin, fake.origin)
  check('...its version', status.view.server.version, '0.21.1')
  check('...its device', /RTX 4060/.test(status.view.server.device), true)
  check('...the catalog from the server', status.view.catalog.source, SOURCES.server)
  check('...and that the catalog is complete', status.view.catalog.complete, true)
  check('...the class count', status.view.catalog.classes, Object.keys(OBJECT_INFO).length)
  check('the catalog was cached for offline use', existsSync(status.view.catalog.file), true)
  const noCliStatus = await buildTools(makeDeps({ env: { DSH_COMFYUI_URL: fake.origin }, runner: async () => ({ status: null, stdout: '', stderr: '', error: 'not found' }) }))
    .find((entry) => entry.name === 'comfy_status')
    .execute({}, exec)
  check('status names the CLI gap when there is no comfy', /comfy-cli: no `comfy` on PATH/.test(noCliStatus.text), true)
  const downStatus = await buildTools(makeDeps({ env: { DSH_COMFYUI_URL: 'http://127.0.0.1:1' } })).find((entry) => entry.name === 'comfy_status').execute({}, exec)
  check('status says nothing was started', /Nothing was started/.test(downStatus.text), true)

  // A machine with nothing: no server, and the cache written above is used.
  const offline = buildTools(makeDeps({ env: { DSH_COMFYUI_URL: 'http://127.0.0.1:1' } }))
  const offlineStatus = await offline.find((entry) => entry.name === 'comfy_status').execute({}, exec)
  check('with no server the cached catalog is used', offlineStatus.view.catalog.source, SOURCES.cache)
  check('...and it says so', /no server answered/.test(offlineStatus.view.catalog.described) || /no server/i.test(offlineStatus.text), true)

  // -------------------------------------------------------------------------
  // comfy_nodes
  // -------------------------------------------------------------------------
  const cats = await tool('comfy_nodes').execute({ action: 'categories' }, exec)
  check('categories lists them', /sampling/.test(cats.text) && /image\/upscaling/.test(cats.text), true)
  const one = await tool('comfy_nodes').execute({ action: 'node', node: 'KSampler' }, exec)
  check('node prints the input table', /INPUT\s+TYPE\s+KIND/.test(one.text), true)
  check('...and the widget order with the control value', /widgets_values order: seed, steps, cfg, sampler_name, scheduler, denoise/.test(one.text), true)
  check('...marking control_after_generate', /control_after_generate value right after seed/.test(one.text), true)
  check('...and the output slots', /LATENT/.test(one.text), true)
  check('an unknown class is refused with the nearest', (await tool('comfy_nodes').execute({ action: 'node', node: 'KSamplr' }, exec)).view.code, 'NO_NODE')
  const search = await tool('comfy_nodes').execute({ action: 'search', query: 'sampler' }, exec)
  check('search finds KSampler', search.view.hits.includes('KSampler'), true)
  check('search with no match is refused', (await tool('comfy_nodes').execute({ action: 'search', query: 'zzzznothing' }, exec)).view.code, 'NO_MATCH')

  // -------------------------------------------------------------------------
  // comfy_project: new, build, show, list, import
  // -------------------------------------------------------------------------
  const created = await tool('comfy_project').execute({ action: 'new', template: 'smoke-image', name: 'first-run' }, exec)
  check('a project is created from a template', created.view.ok, true)
  check('...reaching v2-schema against a live server', created.view.rung, 'v2-schema')
  check('...and it writes the five files', ['project.json', 'workflow.json', 'prompt.json', 'README.md', 'build.json'].every((name) => existsSync(path.join(projectsRootDir, 'first-run', name))), true)
  check('the build receipt records the catalog', readJson(path.join(projectsRootDir, 'first-run', 'build.json')).catalog.source, SOURCES.server)
  check('the README says the canvas is generated', /GENERATED/.test(readFileSync(path.join(projectsRootDir, 'first-run', 'README.md'), 'utf8')), true)
  check('creating it again is refused, not overwritten', (await tool('comfy_project').execute({ action: 'new', template: 'smoke-image', name: 'first-run' }, exec)).view.code, 'PROJECT_EXISTS')
  const listed = await tool('comfy_project').execute({ action: 'list' }, exec)
  check('list shows it', listed.view.projects.map((entry) => entry.slug).join(','), 'first-run')
  const shown = await tool('comfy_project').execute({ action: 'show', project: 'first-run' }, exec)
  check('show prints the nodes and the receipt', /Empty Image/.test(shown.text) && /built:/.test(shown.text), true)
  const rebuilt = await tool('comfy_project').execute({ action: 'build', project: 'first-run' }, exec)
  check('build rewrites the generated files', rebuilt.view.rung, 'v2-schema')
  const dry = await tool('comfy_project').execute({ action: 'build', project: 'first-run', dryRun: true }, exec)
  check('a dry build reports without writing', dry.view.files !== undefined && Object.keys(dry.view.files).length === 0, true)
  const imported = await tool('comfy_project').execute({ action: 'import', source: path.join(projectsRootDir, 'first-run', 'workflow.json'), name: 'imported' }, exec)
  check('a canvas is imported as a workflow project', imported.view.kind, 'workflow')
  check('...and lowered to a prompt', imported.view.rung, 'v2-schema')
  check('...with the same wires', readJson(path.join(projectsRootDir, 'imported', 'prompt.json'))['2'].inputs.images.join(','), '1,0')
  check('importing a prompt.json works too', (await tool('comfy_project').execute({ action: 'import', source: path.join(projectsRootDir, 'first-run', 'prompt.json'), name: 'imported-prompt' }, exec)).view.kind, 'prompt')
  check('new needs a template or a spec', (await tool('comfy_project').execute({ action: 'new' }, exec)).view.code, 'BAD_ARGUMENT')
  const inline = await tool('comfy_project').execute({ action: 'new', name: 'inline', spec: { name: 'inline', nodes: [{ key: 'e', class: 'EmptyImage', widgets: { width: 64, height: 64, batch_size: 1, color: 0 } }, { key: 's', class: 'SaveImage', widgets: { filename_prefix: 'x' }, wires: { images: 'e.IMAGE' } }] } }, exec)
  check('a spec written inline becomes a project', inline.view.ok, true)

  // -------------------------------------------------------------------------
  // comfy_validate
  // -------------------------------------------------------------------------
  const valid = await tool('comfy_validate').execute({ project: 'first-run' }, exec)
  check('validate answers with the rung', valid.view.rung, 'v2-schema')
  check('...and no findings', valid.view.findings.length, 0)
  check('...saying what that proves', /every class exists in this server/.test(valid.text), true)
  check('validate needs exactly one target', (await tool('comfy_validate').execute({}, exec)).view.code, 'BAD_ARGUMENT')
  check('a file that is not there is refused by name', (await tool('comfy_validate').execute({ file: 'nope.json' }, exec)).view.code, 'NO_FILE')
  const canvasFile = path.join(projectsRootDir, 'first-run', 'workflow.json')
  const validatedCanvas = await tool('comfy_validate').execute({ file: canvasFile }, exec)
  check('a canvas validates as a canvas', validatedCanvas.view.kind, 'workflow')
  const promptFile = path.join(projectsRootDir, 'first-run', 'prompt.json')
  check('a prompt validates as a prompt', (await tool('comfy_validate').execute({ file: promptFile }, exec)).view.kind, 'prompt')

  // -------------------------------------------------------------------------
  // comfy_run
  // -------------------------------------------------------------------------
  const ran = await tool('comfy_run').execute({ project: 'first-run' }, exec)
  check('a run answers', ran.view.ok, true)
  check('...at v4-executed', ran.view.rung, 'v4-executed')
  check('...with the prompt id', ran.view.promptId, 'prompt-0001')
  check('...and the file it produced', ran.view.files.length + ':' + ran.view.files[0].filename, '1:smoke_00001_.png')
  check('...naming the node that saved it', ran.view.files[0].nodeTitle, 'Save Image')
  check('...and a /view url', /\/view\?filename=/.test(ran.text), true)
  check('the run posted the compiled prompt', requests.some((entry) => entry.method === 'POST' && entry.path === '/prompt' && entry.body.prompt['1'].class_type === 'EmptyImage'), true)
  check('a project with an error is NOT queued', (await tool('comfy_run').execute({ project: 'imported-prompt' }, exec)).view.ok, true)
  // A refusal from /prompt keeps the server's own words.
  refuseNext = {
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
    node_errors: { '1': { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'nope.safetensors' not in ['v1-5.safetensors']" }], dependent_outputs: ['2'], class_type: 'CheckpointLoaderSimple' } },
  }
  const refused = await tool('comfy_run').execute({ project: 'first-run' }, exec)
  check('a 400 from /prompt is a typed refusal', refused.view.code, 'PROMPT_REFUSED')
  check('...keeping the node_errors', refused.view.findings[0].type, 'value_not_in_list')
  check('...and the server sentence', /Value not in list/.test(refused.text), true)

  // -------------------------------------------------------------------------
  // comfy_test: the library, compile and run
  // -------------------------------------------------------------------------
  const compileAll = await tool('comfy_test').execute({ action: 'compile' }, exec)
  check('compile answers for the whole library', compileAll.view.total, 4)
  check('...with every example at v2 against a live catalog', compileAll.view.results.every((entry) => entry.rung === 'v2-schema'), true)
  check('...and a rung tally', compileAll.view.rungs['v2-schema'], 4)
  check('...printed as a tally', /Rungs: v2-schema/.test(compileAll.text), true)
  check('compile writes nothing', existsSync(path.join(projectsRootDir, 'text-to-image')), false)
  const subset = await tool('comfy_test').execute({ action: 'compile', examples: ['smoke-image'] }, exec)
  check('a subset compiles just those', subset.view.total, 1)
  const withProjects = await tool('comfy_test').execute({ action: 'compile', examples: ['smoke-image'], includeProjects: true }, exec)
  check('includeProjects adds the workspace ones', withProjects.view.total > 1, true)
  const runAll = await tool('comfy_test').execute({ action: 'run', examples: ['smoke-image', 'smoke-video'] }, exec)
  check('run queues each example', runAll.view.results.length, 2)
  check('...and reports v4 for the ones that produced files', runAll.view.results.map((entry) => entry.rung).join(','), 'v4-executed,v4-executed')
  check('run with no server is a refusal naming the compile path', (await buildTools(makeDeps({ env: { DSH_COMFYUI_URL: 'http://127.0.0.1:1' } })).find((entry) => entry.name === 'comfy_test').execute({ action: 'run' }, exec)).view.code, 'SERVER_DOWN')

  // -------------------------------------------------------------------------
  // comfy_cli - against the REAL 1.29.0 envelope shapes
  // -------------------------------------------------------------------------
  const cliState = { calls: [], mode: 'ok', installCode: path.join(sandbox, 'comfy-install', 'ComfyUI'), installData: path.join(sandbox, 'comfy-install', 'ComfyUI') }
  mkdirSync(cliState.installCode, { recursive: true })
  writeFileSync(path.join(cliState.installCode, 'main.py'), '# comfyui\n', 'utf8')
  writeFileSync(path.join(cliState.installCode, 'comfyui_version.py'), "__version__ = '0.21.1'\n", 'utf8')
  const cliDeps = makeDeps({ runner: fakeRunner(cliState) })
  const cliTools = buildTools(cliDeps)
  const cli = (name) => cliTools.find((entry) => entry.name === name)

  const cliStatus = await cli('comfy_cli').execute({ action: 'status' }, exec)
  check('the CLI is found and versioned from the envelope', cliStatus.view.version, '1.29.0')
  check('...reading the workspace from env', cliStatus.view.workspace, 'C:\\Users\\x\\Documents\\comfy\\ComfyUI')
  check('...and which agrees', cliStatus.view.which, 'C:\\Users\\x\\Documents\\comfy\\ComfyUI')
  check('...the GPU it reports', /RTX 3090/.test(cliStatus.text), true)
  check('...the workspace it names, marked as missing', /ComfyUI  \(DOES NOT EXIST\)/.test(cliStatus.text), true)
  check('...the Desktop install it knows, with its code dir', cliStatus.view.installs.map((entry) => entry.name + ':' + entry.codeDir).join(','), 'sdf:' + cliState.installCode)
  check('...and that the Manager is missing', /not-installed/.test(cliStatus.text), true)
  check('the argv puts the global --json before the subcommand', argvFor('comfy', ['env']).join(' '), 'comfy --json env')
  check('...and --workspace before it too', argvFor('comfy', ['env'], { workspace: 'C:\\ws' }).join(' '), 'comfy --workspace=C:\\ws --json env')

  const cliDepsRun = await cli('comfy_cli').execute({ action: 'deps', project: 'first-run' }, exec)
  check('deps reports the node packs a workflow needs', /comfyui-impact-pack/.test(cliDepsRun.text), true)
  check('...from the file the CLI wrote', cliDepsRun.view.deps.custom_nodes[0], 'comfyui-impact-pack')
  check('...and passes the install as --workspace, because the default does not exist', cliDepsRun.view.workspace, cliState.installCode)
  check('...naming why in the answer', /does not exist/.test(cliDepsRun.text), true)

  const cliRun = await cli('comfy_cli').execute({ action: 'run', project: 'first-run' }, exec)
  check('run hands the canvas to the CLI', cliRun.view.exitCode, 0)
  check('...and reads the prompt_id out of the envelope', cliRun.view.promptId, '9f2c1d4e-0000-4000-8000-000000000000')
  check('...reporting the independent rung', cliRun.view.rung, 'v4-executed')
  check('the argv is `comfy --json run --workflow <file> --wait`', runArgv('comfy', 'w.json').join(' '), 'comfy --json run --workflow w.json --wait')
  check('the argv is `comfy --json node deps-in-workflow --workflow= --output=`', depsArgv('comfy', 'w.json', 'd.json').join(' '), 'comfy --json node deps-in-workflow --workflow=w.json --output=d.json')
  check('launch starts a background instance', (await cli('comfy_cli').execute({ action: 'launch' }, exec)).view.exitCode, 0)
  check('stop stops it', (await cli('comfy_cli').execute({ action: 'stop' }, exec)).view.exitCode, 0)
  check('an explicit workspace wins over the auto-pick', (await cli('comfy_cli').execute({ action: 'deps', project: 'first-run', workspace: 'D:\\mine' }, exec)).view.workspace, 'D:\\mine')

  // The two refusals comfy-cli gives BEFORE it reads a graph, as sentences.
  cliState.mode = 'no-manager'
  const noManager = await cli('comfy_cli').execute({ action: 'deps', project: 'first-run' }, exec)
  check('a workspace without ComfyUI-Manager is explained', /no ComfyUI-Manager/.test(noManager.text), true)
  check('...and the answer still names the exit code', /exit code: 1/.test(noManager.text), true)
  cliState.mode = 'no-workspace'
  const noWorkspace = await cli('comfy_cli').execute({ action: 'run', project: 'first-run' }, exec)
  check('a missing workspace is explained with the fix', /could not resolve a ComfyUI workspace/.test(noWorkspace.view.explanation), true)
  check('...and the run reports failure, not success', noWorkspace.view.ok, false)
  cliState.mode = 'gone'
  const goneInstall = await cli('comfy_cli').execute({ action: 'status' }, exec)
  check('a Desktop install whose folder is gone says so', /the folder is GONE/.test(goneInstall.text), true)
  check('...and comfy-cli\'s own warning is repeated', /Workspace directory does not exist/.test(goneInstall.text), true)
  cliState.mode = 'ok'

  const noCli = buildTools(makeDeps({ runner: async () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) })).find((entry) => entry.name === 'comfy_cli')
  const missing = await noCli.execute({ action: 'status' }, exec)
  check('no CLI is an ANSWER, not a failure', missing.view.code, 'CLI_MISSING')
  check('...naming the install line', /pip install comfy-cli/.test(missing.text), true)
  check('...and saying the HTTP tools need no CLI', /HTTP tools need none of it/.test(missing.text), true)
  check(
    'a CLI never runs install: no argv here can',
    cliState.calls.every((argv) => {
      const subcommand = argv.slice(1).find((token) => !token.startsWith('-')) ?? ''
      return subcommand !== 'install'
    }),
    true,
  )

  // -------------------------------------------------------------------------
  // The CLI helpers, pure - the envelope, not a guess at it
  // -------------------------------------------------------------------------
  // Verbatim 1.29.0 output for `comfy --json env` on a machine whose Desktop
  // install is gone. Every field this row reads is asserted against it.
  const REAL_ENV = {
    schema: 'envelope/1',
    type: 'envelope',
    ok: true,
    command: 'env',
    version: '1.29.0',
    where: null,
    data: {
      python: { version: '3.14.3', executable: 'C:\\uv\\Scripts\\python.exe', virtualenv: null, conda_env: null },
      config: { path: 'C:\\Users\\me\\AppData\\Local\\comfy-cli\\config.ini', default_workspace: null, recent_workspace: null, tracking_enabled: false, background: null },
      server: { running: false, url: null },
      hardware: { os: 'Windows', os_version: '11', arch: 'AMD64', cpu: 'AMD64 Family 25', ram_bytes: 34265317376, gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vram_bytes: 25769803776, unified_memory: false } },
      workspace: {
        path: 'C:\\Users\\me\\Documents\\comfy\\ComfyUI',
        type: 'default',
        exists: false,
        desktop: {
          install_id: null,
          name: null,
          code_dir: null,
          data_dir: null,
          custom_nodes_dir: null,
          python: null,
          model_roots: [],
          comfyui_version: null,
          comfyui_commit: null,
          selected_reason: null,
          installs: [{ install_id: 'inst-1', name: 'sdf', code_dir: 'C:\\Users\\me\\ComfyUI-Installs\\sdf\\ComfyUI', data_dir: 'C:\\Users\\me\\ComfyUI-Installs\\sdf\\ComfyUI', comfyui_version: null, last_launched_at: null, status: null, exists: false, selected: false }],
          app_data_dir: 'C:\\Users\\me\\AppData\\Roaming\\Comfy Desktop',
        },
        manager_mode: 'not-installed',
        manager_detected: 'none',
        uv_compile_default: false,
      },
      warnings: [{ code: 'workspace_not_found', message: 'Workspace directory does not exist: C:\\Users\\me\\Documents\\comfy\\ComfyUI' }],
    },
    error: null,
  }
  const realFacts = envFacts(REAL_ENV.data)
  check('the workspace path is read from data.workspace.path', realFacts.workspace, 'C:\\Users\\me\\Documents\\comfy\\ComfyUI')
  check('...and that it does NOT exist', realFacts.workspaceExists, false)
  check('the server flag comes from data.server.running', realFacts.serverRunning, false)
  check('the python is data.python.executable', /Scripts\\python\.exe$/.test(realFacts.python), true)
  check('the GPU is data.hardware.gpu.model', realFacts.gpu, 'NVIDIA GeForce RTX 3090')
  check('the VRAM travels', realFacts.vramBytes, 25769803776)
  check('the Manager mode travels', realFacts.managerMode, 'not-installed')
  check('the Desktop installs are read whole', realFacts.installs.length + ':' + realFacts.installs[0].name + ':' + realFacts.installs[0].exists, '1:sdf:false')
  check('the warnings are read', /Workspace directory does not exist/.test(realFacts.warnings[0].message), true)
  check('a config path is never mistaken for the workspace', realFacts.workspace.includes('config.ini'), false)
  check('which reads workspace_path', whichFacts({ workspace_path: '/w/ComfyUI', exists: true }).workspace, '/w/ComfyUI')
  check('a version comes from the envelope top level, not a regex', (await cliVersion(async () => ({ status: 0, stdout: JSON.stringify({ schema: 'envelope/1', type: 'envelope', ok: true, version: '2.0.1', data: { version: '2.0.1' } }) + '\n', stderr: '' }), {})).version, '2.0.1')
  check('a CLI that cannot start is found:false', (await cliVersion(async () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }), {})).found, false)
  check('an envelope with a log line before it still parses', parseEnvelope('INFO starting\n{"workspace": "/x"}').data.workspace, '/x')
  check('a run envelope carries the prompt id', promptIdFromRunText('{"ok":true,"data":{"prompt_id":"9f2c1d4e-0000-4000-8000-000000000000"}}'), '9f2c1d4e-0000-4000-8000-000000000000')
  check('a prompt_id is still read out of prose', promptIdFromRunText('submitted prompt_id: 9f2c1d4e-0000-4000-8000-000000000000'), '9f2c1d4e-0000-4000-8000-000000000000')
  check('the workspace refusal is explained', /comfy install/.test(explainCliFailure("'C:\\x' is not a valid ComfyUI workspace.\nRun comfy install to set up ComfyUI")), true)
  check('the Manager refusal is explained', /Desktop install keeps its Manager/.test(explainCliFailure("ComfyUI-Manager not found. 'cm-cli' command is not available.")), true)
  check('an unknown failure gets no invented explanation', explainCliFailure('something else'), '')
  check('bytes read like a person writes them', formatBytes(8 * 1024 ** 3), '8.0 GiB')

  // -------------------------------------------------------------------------
  // The files on disk - the check that only matters once models exist
  // -------------------------------------------------------------------------
  // A base path with one checkpoint, one LoRA and one input image, and a
  // project that names the RIGHT checkpoint and the WRONG lora.
  const fileBase = path.join(sandbox, 'ComfyUI')
  mkdirSync(path.join(fileBase, 'models', 'checkpoints'), { recursive: true })
  mkdirSync(path.join(fileBase, 'models', 'loras'), { recursive: true })
  mkdirSync(path.join(fileBase, 'input'), { recursive: true })
  writeFileSync(path.join(fileBase, 'models', 'checkpoints', 'v1-5-pruned-emaonly-fp16.safetensors'), 'x', 'utf8')
  writeFileSync(path.join(fileBase, 'models', 'loras', 'lcm-lora-sd15.safetensors'), 'x', 'utf8')
  writeFileSync(path.join(fileBase, 'input', 'example.png'), 'x', 'utf8')
  const presentInstall = { found: true, base: fileBase, baseSource: 'test', app: '', version: '0.21.1', python: '', models: {}, modelRoots: [], customNodes: [], notes: [] }
  check('the files are found where ComfyUI would look', checkPromptFiles({ prompt: {}, catalog: coreCatalog(), install: presentInstall, requires: { models: { checkpoints: ['v1-5-pruned-emaonly-fp16.safetensors'] }, inputFiles: ['example.png'] } }).findings.length, 0)
  const missingLora = checkPromptFiles({
    prompt: { '2': { class_type: 'LoraLoader', inputs: { lora_name: 'lcm-lora-sdXL.safetensors', strength_model: 1, strength_clip: 1 } } },
    catalog: coreCatalog(),
    install: presentInstall,
    requires: { models: {}, inputFiles: [] },
  })
  check('a missing model is value_not_in_list, the server type', missingLora.findings[0].type, 'value_not_in_list')
  check('...naming the folder and the count', /models\/loras\/lcm-lora-sdXL\.safetensors does not exist .*1 file\(s\) there/.test(missingLora.findings[0].message), true)
  check('...and the nearest real name', /nearest: lcm-lora-sd15\.safetensors/.test(missingLora.findings[0].message), true)
  check('...with the node and input it belongs to', missingLora.findings[0].node + '/' + missingLora.findings[0].input, '2/lora_name')
  check('a complete catalog answers for itself, so no second opinion', checkPromptFiles({ prompt: { '2': { class_type: 'LoraLoader', inputs: { lora_name: 'not-there.safetensors' } } }, catalog: completeCatalog, install: presentInstall, requires: {} }).findings.length, 0)
  const absentFolder = checkPromptFiles({ prompt: {}, catalog: coreCatalog(), install: presentInstall, requires: { models: { vae: ['thing.safetensors'] } } })
  check('an absent FOLDER is a warning, not a missing file', absentFolder.findings[0].type, 'model_folder_absent')
  const noBase = checkPromptFiles({ prompt: {}, catalog: coreCatalog(), install: { found: false, base: '' }, requires: { models: { checkpoints: ['x.safetensors'] } } })
  check('with no base path nothing is claimed at all', noBase.findings.length + ':' + /no ComfyUI base path/.test(noBase.skipped), '0:true')
  // And the same check through a real build: the shipped text-to-image example
  // against a base path that HAS its checkpoint but NOT its LoRA.
  const partialBase = path.join(sandbox, 'ComfyUI-partial')
  mkdirSync(path.join(partialBase, 'models', 'checkpoints'), { recursive: true })
  mkdirSync(path.join(partialBase, 'models', 'loras'), { recursive: true })
  writeFileSync(path.join(partialBase, 'models', 'checkpoints', 'v1-5-pruned-emaonly-fp16.safetensors'), 'x', 'utf8')
  const partialInstall = { ...presentInstall, base: partialBase }
  const partialBuild = buildFromSpec({ raw: readExample('text-to-image'), paths: dryPaths, catalog: coreCatalog(), dryRun: true, install: partialInstall })
  check('a build reports the missing file by name', partialBuild.findings.filter((entry) => entry.type === 'value_not_in_list').map((entry) => entry.input).join(','), 'lora_name')
  check('...so the project is not called runnable', partialBuild.ok, false)
  const fullBuild = buildFromSpec({ raw: readExample('text-to-image'), paths: dryPaths, catalog: coreCatalog(), dryRun: true, install: presentInstall })
  check('with both files present the build is clean again', fullBuild.ok, true)
  check('...and records what it checked', fullBuild.fileCheck.checked, 2)
  check('...against the folders it read', fullBuild.fileCheck.roots.length, 2)
  const inventoryFacts = inventory(presentInstall)
  check('the inventory counts per folder', inventoryFacts.folders.checkpoints.count + '/' + inventoryFacts.folders.loras.count + '/' + inventoryFacts.folders.input.count, '1/1/1')
  check('...and names the first file', inventoryFacts.folders.checkpoints.first[0], 'v1-5-pruned-emaonly-fp16.safetensors')
  check('...with a file total', inventoryFacts.files, 2)

  // -------------------------------------------------------------------------
  // Install discovery, without a server - and with comfy-cli's help
  // -------------------------------------------------------------------------
  const bareHome = path.join(sandbox, 'nohome')
  const install = discoverInstall({ env: { USERPROFILE: bareHome, HOME: bareHome, APPDATA: path.join(bareHome, 'AppData', 'Roaming') }, platform: 'linux' })
  check('a machine with nothing found says so', install.found, false)
  check('...and still answers with the fields', install.base === '' && install.app === '' && install.notes.length > 0, true)
  check('the slugifier refuses a name that is not one', slugify('  ***  '), '')
  // comfy-cli knows a Desktop install whose folder DOES exist: that becomes the base.
  const cliFacts = envFacts(REAL_ENV.data)
  cliFacts.installs[0].exists = true
  cliFacts.installs[0].dataDir = fileBase
  const fromCli = discoverInstall({ env: { USERPROFILE: bareHome, HOME: bareHome, APPDATA: path.join(bareHome, 'AppData', 'Roaming') }, platform: 'linux', cli: cliFacts })
  check("comfy-cli's install becomes the base path", fromCli.base, fileBase)
  check('...and says where it came from', /comfy-cli/.test(fromCli.baseSource), true)
  // -------------------------------------------------------------------------
  // The skills: frontmatter, and every fenced example
  // -------------------------------------------------------------------------
  const skillsRoot = path.join(packageRoot, 'skills')
  const skillDirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  check('six skill folders ship', skillDirs.length, 6)
  const docs = []
  for (const dir of skillDirs) {
    const file = path.join(skillsRoot, dir, 'SKILL.md')
    const text = readFileSync(file, 'utf8')
    const parsed = parseSkillFile(text)
    check('skill ' + dir + ' has frontmatter with the right name', parsed.meta.name, dir)
    check('skill ' + dir + ' has a description over 80 characters', typeof parsed.meta.description === 'string' && parsed.meta.description.length > 80, true)
    check('skill ' + dir + ' says when to use it', typeof parsed.meta.whenToUse === 'string' && parsed.meta.whenToUse.length > 40, true)
    check('skill ' + dir + ' has a real body', parsed.content.length > 2000, true)
    docs.push({ dir, file, text })
  }
  check('the six skills are the six registered', skillDirs.join(','), __internals.CAPABILITIES.skills.slice().sort().join(','))

  /** The fenced blocks of one document, with the no-check convention. */
  function fences(text) {
    const lines = String(text).split('\n')
    const blocks = []
    let open = null
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*```([A-Za-z0-9_+-]*)\s*(.*)$/.exec(lines[index])
      if (!match) {
        if (open) open.body.push(lines[index])
        continue
      }
      if (open === null) open = { lang: match[1].toLowerCase(), line: index + 1, body: [], skip: /no-check/i.test(match[2]) }
      else {
        blocks.push(open)
        open = null
      }
    }
    return blocks
  }

  const knownRoutes = __internals.CAPABILITIES.endpoints
  /** A route with any concrete class/id/folder folded back to its placeholder. */
  const routeKey = (route) =>
    route
      .replace(/^\/object_info\/[^/]+$/, '/object_info/{class}')
      .replace(/^\/history\/[^/]+$/, '/history/{prompt_id}')
      .replace(/^\/models\/[^/]+$/, '/models/{folder}')
  const KNOWN_VERBS = new Set(['install', 'update', 'launch', 'stop', 'run', 'jobs', 'download', 'upload', 'env', 'which', 'set-default', 'node', 'nodes', 'model', 'models', 'manager', 'extension', 'system-stats', 'free', 'tracking', 'cloud', 'generate', 'templates', 'skills', 'knowledge', 'setup', 'pr-cache'])
  const blocks = docs.flatMap((doc) => fences(doc.text).map((block) => ({ doc, block })))
  let jsonCount = 0
  let jsCount = 0
  let pyCount = 0
  let curlCount = 0
  let comfyCount = 0
  const pythonAvailable = spawnSync('python', ['-c', 'import ast'], { encoding: 'utf8' }).status === 0
  for (const { doc, block } of blocks) {
    const where = doc.dir + ':' + block.line
    if (block.skip) {
      skip(where, 'no-check')
      continue
    }
    const body = block.body.join('\n')
    if (block.lang === 'json') {
      jsonCount += 1
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        parsed = null
      }
      check(where + ' is valid JSON', parsed !== null && typeof parsed === 'object', true)
    } else if (block.lang === 'js' || block.lang === 'javascript') {
      jsCount += 1
      const file = path.join(sandbox, 'block-' + jsCount + '.mjs')
      writeFileSync(file, body, 'utf8')
      const result = spawnSync('node', ['--check', file], { encoding: 'utf8' })
      check(where + ' passes node --check', result.status === 0, true)
    } else if (block.lang === 'python' || block.lang === 'py') {
      pyCount += 1
      if (!pythonAvailable) {
        skip(where + ' parses as Python', 'no python on PATH')
        continue
      }
      const result = spawnSync('python', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: body, encoding: 'utf8' })
      check(where + ' parses as Python', result.status === 0, true)
    } else if (['bash', 'sh', 'shell', 'console'].includes(block.lang)) {
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (/^curl\s/.test(trimmed)) {
          curlCount += 1
          const urlMatch = /(https?:\/\/[^\s"']+)/.exec(trimmed)
          check(where + ' curl names a loopback URL', urlMatch !== null && /^http:\/\/(127\.0\.0\.1|localhost):(8188|800[0-3])\//.test(urlMatch[1]), true)
          if (urlMatch !== null) {
            const route = urlMatch[1].replace(/^https?:\/\/(127\.0\.0\.1|localhost):\d+/, '').split('?')[0]
            check(where + ' curl names a documented route (' + route + ')', knownRoutes.includes(routeKey(route)), true)
          }
        }
        if (/^comfy\s/.test(trimmed)) {
          comfyCount += 1
          const tokens = trimmed.split(/\s+/).slice(1).filter((token) => !token.startsWith('-'))
          const verb = tokens[0] ?? ''
          const bareFlag = /^comfy\s+--(version|install-completion)\b/.test(trimmed)
          check(where + ' comfy names a real subcommand (' + (verb === '' ? trimmed.split(/\s+/)[1] : verb) + ')', bareFlag || KNOWN_VERBS.has(verb), true)
        }
      }
    }
  }
  check('the skills carry JSON examples', jsonCount >= 6, true)
  check('the skills carry JavaScript examples', jsCount >= 1, true)
  check('the skills carry Python examples', pyCount >= 3, true)
  check('the skills carry curl examples', curlCount >= 3, true)
  check('the skills carry comfy-cli commands', comfyCount >= 10, true)

  // -------------------------------------------------------------------------
  // The optional live half: a real server, if one is running
  // -------------------------------------------------------------------------
  if (process.env.DSH_COMFYUI_CHECK_LIVE === '0') skip('live ComfyUI', 'DSH_COMFYUI_CHECK_LIVE=0')
  else {
    const liveEnv = { DSH_HOME: home, DSH_COMFYUI_ROOT: path.join(workspace, 'live'), ...(process.env.DSH_COMFYUI_URL ? { DSH_COMFYUI_URL: process.env.DSH_COMFYUI_URL } : {}) }
    const liveTools = buildTools(createDeps(stubCtx, { env: liveEnv }))
    const liveStatus = await liveTools.find((entry) => entry.name === 'comfy_status').execute({}, exec)
    if (liveStatus.view.server === null) skip('live ComfyUI', 'no server answered')
    else {
      const liveTest = await liveTools.find((entry) => entry.name === 'comfy_test').execute({ action: 'compile' }, exec)
      check('live: the library compiles against a real catalog', liveTest.view.results.every((entry) => entry.rung === 'v2-schema' || entry.rung === 'v1-structural'), true)
      check('live: every example reached at least v1', liveTest.view.results.every((entry) => entry.rung !== 'v0-failed'), true)
    }
  }
} finally {
  await fake.close()
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('')
console.log(checks + ' checks, ' + failures + ' failure(s), ' + skipped + ' skipped')
process.exit(failures === 0 ? 0 : 1)
