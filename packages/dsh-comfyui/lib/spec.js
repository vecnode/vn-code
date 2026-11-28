/**
 * dsh-comfyui — the project spec: the small file a person (or an agent) edits,
 * and the checks that make a bad one fail HERE rather than in the app.
 *
 * WHY A SPEC AT ALL: a ComfyUI workflow JSON is a serialized canvas - numeric
 * node ids, links that point at array positions, and `widgets_values`, an
 * UNNAMED array whose meaning depends on the node class's input order and on
 * whether that class inserts a `control_after_generate` value after its seed.
 * Editing one by hand means counting array positions. A spec names every value
 * (`"ckpt_name": "@checkpoint"`), names every wire (`"model": "ckpt.MODEL"`),
 * and the compiler derives both generated files from it - so the file a person
 * edits is the file they can read.
 *
 * The sigil is ONE character: a string value starting with `@` is a BINDING,
 * resolved from `bindings`. `"@checkpoint"` is how a template says "whichever
 * checkpoint this machine has" without baking a filename into a document that
 * outlives the download.
 *
 * Every refusal is a finding with ComfyUI's own `type` where one exists, plus
 * the node KEY and input NAME, because those are what the person is looking at.
 */

import { ComfyError } from './errors.js'
import { knows, linkInputs, nodeIn, outputSlot, widgetInputs } from './nodes.js'

/** The keys a project may carry, so a typo is refused instead of ignored. */
const PROJECT_KEYS = ['name', 'title', 'description', 'requires', 'bindings', 'nodes', 'notes', 'tags', 'template', 'source', 'generated']
const NODE_KEYS = ['key', 'class', 'title', 'pos', 'size', 'widgets', 'wires', 'controlAfterGenerate', 'notes', 'color', 'mode']

/** A slug the project folder can be named with. */
export function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** A finding list as one sentence, or '' when there is nothing to say. */
export function summarizeFindings(findings) {
  const errors = findings.filter((entry) => entry.severity === 'error')
  const warnings = findings.filter((entry) => entry.severity === 'warning')
  const parts = []
  if (errors.length > 0) parts.push(errors.length + ' error(s)')
  if (warnings.length > 0) parts.push(warnings.length + ' warning(s)')
  return parts.join(', ')
}

/** One finding, shaped like the rest of the package. */
function finding(severity, type, message, where = {}) {
  return { severity, type, message, ...where }
}

/**
 * Validate and normalize a project spec.
 *
 * It does NOT need a complete catalog: with the built-in core table it checks
 * every node it knows and says which ones it could not check, which is the
 * honest answer on a machine where ComfyUI is not running yet.
 *
 * @param raw - the parsed `project.json`.
 * @param catalog - the node catalog in force.
 * @returns `{ project, findings }` - `findings` with any `error` means the
 *          project must not be compiled.
 * @throws ComfyError when the file is not a project at all.
 */
export function readSpec(raw, catalog) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ComfyError('SPEC_INVALID', 'project.json must be a JSON object with `name` and `nodes`, not ' + (Array.isArray(raw) ? 'an array' : typeof raw) + '.')
  }
  const findings = []
  for (const key of Object.keys(raw)) {
    if (!PROJECT_KEYS.includes(key)) {
      findings.push(finding('warning', 'unknown_field', 'project.json has an unknown field "' + key + '", which nothing reads. Known fields: ' + PROJECT_KEYS.join(', ') + '.'))
    }
  }
  const name = slugify(raw.name ?? '')
  if (name === '') {
    findings.push(finding('error', 'missing_name', 'project.json needs a `name` (a folder-safe slug, e.g. "text-to-image").'))
  }
  const requires = normalizeRequires(raw.requires, findings)
  const bindings = raw.bindings !== null && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings) ? { ...raw.bindings } : {}
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : []
  if (nodesRaw.length === 0) {
    findings.push(finding('error', 'missing_nodes', 'project.json needs a non-empty `nodes` array; a graph with no nodes is not a project.'))
  }

  const seen = new Map()
  const nodes = []
  for (const [index, entry] of nodesRaw.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push(finding('error', 'bad_node', 'nodes[' + index + '] is not an object.'))
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!NODE_KEYS.includes(key)) {
        findings.push(finding('warning', 'unknown_field', 'nodes[' + index + '] has an unknown field "' + key + '", which nothing reads. Known fields: ' + NODE_KEYS.join(', ') + '.'))
      }
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) {
      findings.push(finding('error', 'bad_key', 'nodes[' + index + '] needs a `key` matching [A-Za-z][A-Za-z0-9_.-]* (it is how other nodes refer to it), got ' + JSON.stringify(entry.key) + '.'))
      continue
    }
    if (seen.has(key)) {
      findings.push(finding('error', 'duplicate_key', 'two nodes share the key "' + key + '"; keys are node identities, so they must be unique.'))
      continue
    }
    seen.set(key, true)
    const classType = typeof entry.class === 'string' ? entry.class.trim() : ''
    if (classType === '') {
      findings.push(finding('error', 'missing_class', 'node "' + key + '" has no `class`; it must name a ComfyUI node class such as KSampler.', { node: key }))
      continue
    }
    const node = {
      key,
      class: classType,
      title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : '',
      pos: Array.isArray(entry.pos) && entry.pos.length === 2 && entry.pos.every((value) => Number.isFinite(value)) ? [Number(entry.pos[0]), Number(entry.pos[1])] : null,
      size: Array.isArray(entry.size) && entry.size.length === 2 && entry.size.every((value) => Number.isFinite(value)) ? [Number(entry.size[0]), Number(entry.size[1])] : null,
      widgets: {},
      wires: {},
      controlAfterGenerate: entry.controlAfterGenerate !== null && typeof entry.controlAfterGenerate === 'object' && !Array.isArray(entry.controlAfterGenerate) ? { ...entry.controlAfterGenerate } : {},
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      mode: Number.isInteger(entry.mode) ? entry.mode : 0,
    }
    if (entry.widgets !== null && entry.widgets !== undefined) {
      if (typeof entry.widgets !== 'object' || Array.isArray(entry.widgets)) {
        findings.push(finding('error', 'bad_widgets', 'node "' + key + '" has `widgets` that is not an object; it maps an input name to a value.', { node: key }))
      } else {
        node.widgets = { ...entry.widgets }
      }
    }
    if (entry.wires !== null && entry.wires !== undefined) {
      if (typeof entry.wires !== 'object' || Array.isArray(entry.wires)) {
        findings.push(finding('error', 'bad_wires', 'node "' + key + '" has `wires` that is not an object; it maps an input name to "<nodeKey>.<OUTPUT>" (or ".<slot>").', { node: key }))
      } else {
        node.wires = { ...entry.wires }
      }
    }
    nodes.push(node)
  }

  const byKey = new Map(nodes.map((node) => [node.key, node]))
  for (const node of nodes) {
    const spec = nodeIn(catalog, node.class)
    if (spec === null) {
      if (catalog.complete) {
        findings.push(finding('error', 'missing_node_type', 'node "' + node.key + '" is class "' + node.class + '", which this server does not have. A custom node missing from custom_nodes/ is the usual cause.', { node: node.key, class: node.class }))
      } else {
        findings.push(finding('warning', 'class_unverified', 'node "' + node.key + '" is class "' + node.class + '", which the built-in core table does not cover, so nothing here can confirm it exists. `comfy_status` names a server whose `/object_info` can.', { node: node.key, class: node.class }))
      }
      continue
    }
    if (spec.deprecated) {
      findings.push(finding('warning', 'deprecated_class', 'node "' + node.key + '" uses "' + node.class + '", which the server marks deprecated.', { node: node.key, class: node.class }))
    }
    // Widgets: every name must be a widget input of THIS class, and every
    // required widget must be set (or be an escape-hatch node).
    const widgets = widgetInputs(spec)
    const names = new Set(widgets.map((input) => input.name))
    for (const name of Object.keys(node.widgets)) {
      if (!names.has(name)) {
        findings.push(finding('error', 'unknown_widget', 'node "' + node.key + '" ("' + node.class + '") has no widget input "' + name + '". Its widgets: ' + (names.size === 0 ? '(none)' : [...names].join(', ')) + '.', { node: node.key, input: name, class: node.class }))
      }
    }
    if (node.widgetsValues === null) {
      for (const input of widgets) {
        if (input.optional || input.name in node.widgets) continue
        const fallback = input.options !== undefined && input.options.default !== undefined ? input.options.default : input.enum !== null && input.enum.length > 0 ? input.enum[0] : undefined
        if (fallback === undefined) {
          findings.push(finding('warning', 'unset_widget', 'node "' + node.key + '" ("' + node.class + '") leaves widget "' + input.name + '" unset and the class has no default for it; the compiled prompt will omit it.', { node: node.key, input: input.name }))
        }
      }
    }
    // Wires: the input must exist and be linkable, and the source must resolve.
    const linkable = new Set(linkInputs(spec).map((input) => input.name))
    const widgetLinkable = new Set(widgets.map((input) => input.name))
    for (const [input, target] of Object.entries(node.wires)) {
      if (!linkable.has(input) && !widgetLinkable.has(input)) {
        findings.push(finding('error', 'unknown_input', 'node "' + node.key + '" ("' + node.class + '") has no input named "' + input + '", so nothing can be wired into it. Its inputs: ' + [...linkable, ...widgetLinkable].join(', ') + '.', { node: node.key, input }))
        continue
      }
      const resolved = resolveWire(target, byKey, catalog)
      if (resolved.error !== '') {
        findings.push(finding('error', resolved.type, 'node "' + node.key + '" input "' + input + '": ' + resolved.error, { node: node.key, input }))
        continue
      }
      if (resolved.key === node.key) {
        findings.push(finding('error', 'dependency_cycle', 'node "' + node.key + '" wires its own input "' + input + '" from itself.', { node: node.key, input }))
      }
      const targetSpec = nodeIn(catalog, byKey.get(resolved.key).class)
      if (targetSpec !== null && targetSpec.outputs.length > 0) {
        const targetType = targetSpec.outputs[resolved.slot].type
        const inputSpec = spec.inputs.find((entry) => entry.name === input)
        if (inputSpec !== undefined && !typesCompatible(targetType, inputSpec.type)) {
          findings.push(finding('error', 'return_type_mismatch', 'node "' + node.key + '" input "' + input + '" is ' + inputSpec.type + ', but "' + resolved.key + '" output ' + resolved.slot + ' ("' + targetSpec.outputs[resolved.slot].name + '") is ' + targetType + '. ComfyUI refuses this wire.', { node: node.key, input }))
        }
      }
    }
  }

  const cycle = findCycle(nodes, catalog)
  if (cycle.length > 0) {
    findings.push(finding('error', 'dependency_cycle', 'the graph has a dependency cycle: ' + cycle.join(' -> ') + '. A node cannot wait for its own output.', { nodes: cycle }))
  }

  const outputNodes = nodes.filter((node) => {
    const spec = nodeIn(catalog, node.class)
    return spec !== null && spec.outputNode
  })
  if (outputNodes.length === 0 && nodes.length > 0) {
    const unknown = nodes.filter((node) => nodeIn(catalog, node.class) === null).length
    if (unknown > 0) {
      findings.push(finding('warning', 'output_unverified', 'no node in this project is a known OUTPUT node (SaveImage, SaveVideo, PreviewImage, ...), and ' + unknown + ' class(es) could not be checked; ComfyUI answers `prompt_no_outputs` for a prompt with nothing to run.', {}))
    } else {
      findings.push(finding('error', 'prompt_no_outputs', 'no node in this project is an OUTPUT node, so ComfyUI would refuse the prompt with `prompt_no_outputs`. Add a SaveImage / SaveVideo / PreviewImage and wire it.', {}))
    }
  }

  return {
    project: {
      name,
      title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : name,
      description: typeof raw.description === 'string' ? raw.description : '',
      requires,
      bindings,
      nodes,
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      template: typeof raw.template === 'string' ? raw.template : '',
      source: typeof raw.source === 'string' ? raw.source : 'spec',
      byKey,
      findings,
    },
    findings,
  }
}

/** `requires`, with every folder a map of names. */
function normalizeRequires(raw, findings) {
  const requires = { models: {}, nodes: [], inputFiles: [], customNodes: [] }
  if (raw === null || raw === undefined) return requires
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    findings.push(finding('warning', 'bad_requires', '`requires` is not an object, so nothing is declared as needed.'))
    return requires
  }
  if (raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
    for (const [folder, list] of Object.entries(raw.models)) {
      if (!Array.isArray(list)) continue
      requires.models[folder] = list.map(String).filter((entry) => entry !== '')
    }
  }
  if (Array.isArray(raw.nodes)) requires.nodes = raw.nodes.map(String)
  if (Array.isArray(raw.customNodes)) requires.customNodes = raw.customNodes.map(String)
  if (Array.isArray(raw.inputFiles)) requires.inputFiles = raw.inputFiles.map(String)
  return requires
}

/**
 * A wire target: `"<key>.<OUTPUT>"`, `"<key>.<slot>"`, or `"<key>"` for slot 0.
 *
 * @returns `{ key, slot, error, type }` - `error` is '' on success.
 */
export function resolveWire(target, byKey, catalog) {
  const text = String(target ?? '').trim()
  if (text === '') return { key: '', slot: -1, error: 'has an empty wire target.', type: 'bad_linked_input' }
  const dot = text.lastIndexOf('.')
  const key = dot === -1 ? text : text.slice(0, dot)
  const suffix = dot === -1 ? '' : text.slice(dot + 1)
  if (!byKey.has(key)) {
    return {
      key,
      slot: -1,
      error: 'wires from "' + key + '", which is not a node key in this project. Keys: ' + ([...byKey.keys()].join(', ') || '(none)') + '.',
      type: 'bad_linked_input',
    }
  }
  const source = byKey.get(key)
  const spec = nodeIn(catalog, source.class)
  if (suffix === '') {
    if (spec !== null && spec.outputs.length === 0) {
      return { key, slot: -1, error: 'wires from "' + key + '" (' + source.class + '), which has no outputs.', type: 'bad_linked_input' }
    }
    return { key, slot: 0, error: '', type: '' }
  }
  if (spec === null) {
    // No schema: only an explicit slot number can be trusted.
    const numeric = Number(suffix)
    if (Number.isInteger(numeric) && numeric >= 0) return { key, slot: numeric, error: '', type: '' }
    return {
      key,
      slot: -1,
      error: 'names output "' + suffix + '" of "' + key + '" (' + source.class + '), and that class is not in the catalog in force, so the output name cannot be resolved to a slot. Write "' + key + '.<number>" instead, or start ComfyUI so its `/object_info` can be read.',
      type: 'unknown_output',
    }
  }
  const numeric = Number(suffix)
  const slot = /^\d+$/.test(suffix) ? outputSlot(spec, numeric) : outputSlot(spec, suffix)
  if (slot === -1) {
    return {
      key,
      slot: -1,
      error: '"' + key + '" (' + source.class + ') has no output "' + suffix + '". Its outputs: ' + (spec.outputs.length === 0 ? '(none)' : spec.outputs.map((output, index) => index + '=' + output.name + ':' + output.type).join(', ')) + '.',
      type: 'unknown_output',
    }
  }
  return { key, slot, error: '', type: '' }
}

/**
 * Whether an output of one type may feed an input of another.
 *
 * ComfyUI's rule (`comfy_execution.validation.validate_node_input`): both sides
 * are comma-separated type sets, `*` matches anything, and a NON-EMPTY
 * intersection is enough. Reproducing it here is the difference between a
 * validator that agrees with the server and one that refuses valid graphs.
 */
export function typesCompatible(receivedType, inputType) {
  const received = String(receivedType ?? '')
  const wanted = String(inputType ?? '')
  if (received === wanted) return true
  if (received === '*' || wanted === '*') return true
  const left = new Set(received.split(',').map((entry) => entry.trim()))
  const right = new Set(wanted.split(',').map((entry) => entry.trim()))
  if (left.has('*') || right.has('*')) return true
  for (const entry of left) if (right.has(entry)) return true
  return false
}

/** The first dependency cycle among the node keys, as a readable path, or []. */
export function findCycle(nodes, catalog) {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const state = new Map()
  const stack = []
  let found = null
  const walk = (key) => {
    if (found !== null) return
    const mark = state.get(key) ?? 0
    if (mark === 1) {
      const at = stack.indexOf(key)
      found = stack.slice(at).concat([key])
      return
    }
    if (mark === 2) return
    state.set(key, 1)
    stack.push(key)
    const node = byKey.get(key)
    if (node !== undefined) {
      for (const target of Object.values(node.wires)) {
        const resolved = resolveWire(target, byKey, catalog)
        if (resolved.error === '' && resolved.key !== '') walk(resolved.key)
      }
    }
    stack.pop()
    state.set(key, 2)
  }
  for (const node of nodes) walk(node.key)
  return found ?? []
}

/** Whether a catalog can speak about every class in the project. */
export function fullyKnown(project, catalog) {
  return project.nodes.every((node) => knows(catalog, node.class))
}
