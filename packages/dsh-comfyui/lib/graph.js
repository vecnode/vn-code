/**
 * dsh-comfyui — the validator and the reader for files this package did not
 * write.
 *
 * TWO JOBS, ONE VOCABULARY.
 *
 * `validatePrompt` applies the checks ComfyUI's own `execution.validate_prompt`
 * and `execution.validate_inputs` apply, offline, before anything is queued:
 * a class that does not exist, a required input nobody set, a link that points
 * at a node or slot that is not there, a wire whose type does not match, a
 * widget value outside the server's list or its min/max, a dependency cycle, a
 * graph with no output node. Each finding carries ComfyUI's OWN `type` string
 * (`required_input_missing`, `return_type_mismatch`, `value_not_in_list`,
 * `dependency_cycle`, `prompt_no_outputs`, ...) because a defect found here
 * would be the same defect found there, and translating between two
 * vocabularies for one problem is how an agent learns the wrong lesson.
 *
 * `workflowToPrompt` reads a UI workflow - the file the app's "Save" writes and
 * a person drags into the canvas - and derives the API prompt from it. It needs
 * the FULL catalog, and says so when it does not have one: `widgets_values` is
 * an unnamed array, so without the class's input order the numbers cannot be
 * attributed to names. A guess here would produce a prompt that runs and means
 * something else.
 *
 * Measured on ComfyUI 0.21.1: a UI workflow stores links as OBJECTS
 * (`{id, origin_id, origin_slot, target_id, target_slot, type}`), while every
 * install before the 0.4 canvas stored ARRAYS (`[id, origin, slot, target,
 * slot, type]`). Both are read; only the object form is written.
 */

import { ComfyError } from './errors.js'
import { coerce } from './compile.js'
import { nodeIn } from './nodes.js'
import { typesCompatible } from './spec.js'

/** Node modes the frontend uses: 0 always, 2 never, 4 bypass. */
export const MODE_ALWAYS = 0
export const MODE_NEVER = 2
export const MODE_BYPASS = 4

/** The classes the FRONTEND draws that never reach an API prompt. */
const VIRTUAL_CLASSES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'GroupNode'])

/** One finding, shaped like the rest of the package. */
function finding(severity, type, message, where = {}) {
  return { severity, type, message, ...where }
}

/**
 * Validate an API prompt against the catalog.
 *
 * @param prompt - `{ "<id>": { class_type, inputs } }`.
 * @param catalog - the catalog in force.
 * @returns `{ findings, nodeErrors }` - `nodeErrors` is keyed by node id, the
 *          way `/prompt`'s `node_errors` is, so the two can be compared.
 */
export function validatePrompt(prompt, catalog) {
  const findings = []
  if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) {
    return { findings: [finding('error', 'prompt_invalid', 'An API prompt is an object keyed by node id, each value { class_type, inputs }; that is not what this is.')], nodeErrors: {} }
  }
  const ids = Object.keys(prompt)
  if (ids.length === 0) {
    return { findings: [finding('error', 'prompt_empty', 'The prompt has no nodes, so there is nothing to run.')], nodeErrors: {} }
  }
  const nodeErrors = {}
  const add = (id, entry) => {
    const list = nodeErrors[id] ?? []
    list.push(entry)
    nodeErrors[id] = list
    findings.push(entry)
  }

  for (const id of ids) {
    const node = prompt[id]
    if (node === null || typeof node !== 'object') {
      add(id, finding('error', 'bad_node', 'node ' + id + ' is not an object.', { node: id }))
      continue
    }
    const classType = typeof node.class_type === 'string' ? node.class_type : ''
    if (classType === '') {
      add(id, finding('error', 'missing_node_type', 'node ' + id + ' has no `class_type`.', { node: id }))
      continue
    }
    const spec = nodeIn(catalog, classType)
    if (spec === null) {
      const entry = catalog.complete
        ? finding('error', 'missing_node_type', 'node ' + id + ' is class "' + classType + '", which this server does not have (a custom node missing from custom_nodes/ is the usual cause).', { node: id, class: classType })
        : finding('warning', 'class_unverified', 'node ' + id + ' is class "' + classType + '", which the built-in core table does not cover; nothing here can confirm it exists.', { node: id, class: classType })
      add(id, entry)
      continue
    }
    const inputs = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {}
    for (const input of spec.inputs) {
      if (input.kind === 'hidden' || input.optional) continue
      if (!(input.name in inputs)) {
        add(id, finding('error', 'required_input_missing', 'node ' + id + ' (' + classType + ') has no value for required input "' + input.name + '".', { node: id, input: input.name, class: classType }))
      }
    }
    for (const [name, value] of Object.entries(inputs)) {
      const inputSpec = spec.inputs.find((input) => input.name === name)
      if (inputSpec === undefined) {
        add(id, finding('warning', 'unknown_input', 'node ' + id + ' (' + classType + ') has an input "' + name + '" that the class does not declare, so the server ignores it. Its inputs: ' + spec.inputs.filter((input) => input.kind !== 'hidden').map((input) => input.name).join(', ') + '.', { node: id, input: name }))
        continue
      }
      if (Array.isArray(value)) {
        // A wire: [ "<source id>", slot ].
        if (value.length !== 2 || !Number.isInteger(value[1])) {
          add(id, finding('error', 'bad_linked_input', 'node ' + id + ' input "' + name + '" is a wire but is not a [node id, slot] pair: ' + JSON.stringify(value) + '.', { node: id, input: name }))
          continue
        }
        const sourceId = String(value[0])
        const source = prompt[sourceId]
        if (source === undefined) {
          add(id, finding('error', 'bad_linked_input', 'node ' + id + ' input "' + name + '" wires from node ' + sourceId + ', which is not in this prompt.', { node: id, input: name }))
          continue
        }
        const sourceSpec = nodeIn(catalog, typeof source.class_type === 'string' ? source.class_type : '')
        if (sourceSpec === null) continue
        const slot = value[1]
        if (slot < 0 || slot >= sourceSpec.outputs.length) {
          add(id, finding('error', 'bad_linked_input', 'node ' + id + ' input "' + name + '" wires from node ' + sourceId + ' (' + source.class_type + ') slot ' + slot + ', which does not exist; that class has ' + sourceSpec.outputs.length + ' output(s).', { node: id, input: name }))
          continue
        }
        const received = sourceSpec.outputs[slot].type
        if (!compatible(received, inputSpec.type)) {
          add(id, finding('error', 'return_type_mismatch', 'node ' + id + ' input "' + name + '" is ' + inputSpec.type + ', but node ' + sourceId + ' (' + source.class_type + ') output ' + slot + ' is ' + received + '. ComfyUI refuses this wire.', { node: id, input: name, received: received, expected: inputSpec.type }))
        }
        continue
      }
      if (inputSpec.kind === 'link') {
        add(id, finding('error', 'invalid_input_type', 'node ' + id + ' input "' + name + '" needs a wire (' + inputSpec.type + ') but was given the value ' + JSON.stringify(value) + '.', { node: id, input: name }))
        continue
      }
      const result = coerce(value, inputSpec)
      if (result.error !== '') add(id, finding('error', result.type, 'node ' + id + ' (' + classType + ') input "' + name + '": ' + result.error, { node: id, input: name }))
    }
  }

  const cycle = cycleInPrompt(prompt, catalog)
  if (cycle.length > 0) findings.push(finding('error', 'dependency_cycle', 'the prompt has a dependency cycle: ' + cycle.join(' -> ') + '.', { nodes: cycle }))

  const outputs = ids.filter((id) => {
    const spec = nodeIn(catalog, prompt[id] && typeof prompt[id].class_type === 'string' ? prompt[id].class_type : '')
    return spec !== null && spec.outputNode
  })
  if (outputs.length === 0) {
    const unknown = ids.filter((id) => nodeIn(catalog, prompt[id] && typeof prompt[id].class_type === 'string' ? prompt[id].class_type : '') === null).length
    if (unknown > 0) findings.push(finding('warning', 'output_unverified', 'no node in this prompt is a KNOWN output node, and ' + unknown + ' class(es) could not be checked against a catalog.'))
    else findings.push(finding('error', 'prompt_no_outputs', 'no node in this prompt is an output node, so ComfyUI answers `prompt_no_outputs` and runs nothing. A graph executes to its output nodes, not to every node.', { }))
  }

  const reached = reachableFromOutputs(prompt, outputs)
  const orphans = ids.filter((id) => !reached.has(id))
  if (orphans.length > 0) {
    findings.push(finding('warning', 'unreachable_node', 'node(s) ' + orphans.join(', ') + ' do not feed any output, so they never execute (the queue runs what an output needs, nothing more).', { nodes: orphans }))
  }
  return { findings, nodeErrors }
}

/**
 * Whether an output type may feed an input - ComfyUI's `validate_node_input`
 * rule, reached through `spec.typesCompatible` so the compiler and the
 * validator cannot disagree about a wire.
 */
function compatible(received, wanted) {
  return typesCompatible(received, wanted)
}

/** The first cycle among prompt ids, as a readable path, or []. */
function cycleInPrompt(prompt, catalog) {
  const state = new Map()
  const stack = []
  let found = null
  const walk = (id) => {
    if (found !== null) return
    const mark = state.get(id) ?? 0
    if (mark === 1) {
      found = stack.slice(stack.indexOf(id)).concat([id])
      return
    }
    if (mark === 2) return
    state.set(id, 1)
    stack.push(id)
    const node = prompt[id]
    if (node !== null && typeof node === 'object' && node.inputs !== null && typeof node.inputs === 'object') {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof prompt[String(value[0])] === 'object') walk(String(value[0]))
      }
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const id of Object.keys(prompt)) walk(id)
  if (found === null) return []
  return found.map((id) => {
    const node = prompt[id]
    const classType = node && typeof node.class_type === 'string' ? node.class_type : '?'
    return id + ' (' + classType + ')'
  })
}

/** Everything an output node depends on, itself included. */
function reachableFromOutputs(prompt, outputs) {
  const seen = new Set()
  const stack = [...outputs]
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const node = prompt[id]
    if (node === null || typeof node !== 'object' || node.inputs === null || typeof node.inputs !== 'object') continue
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2) stack.push(String(value[0]))
    }
  }
  return seen
}

/**
 * A UI workflow's node/link lists, normalized.
 *
 * @returns `{ nodes, links, findings }`; `links` always in the object form.
 * @throws ComfyError when the file is not a workflow (a subgraph-only export is
 *         the case worth naming, because it LOOKS like one).
 */
export function parseWorkflow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ComfyError('WORKFLOW_INVALID', 'A UI workflow is a JSON object with `nodes` and `links`; that is not one.')
  }
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const links = Array.isArray(raw.links) ? raw.links : []
  if (nodes.length === 0) {
    const subgraphs = raw.definitions !== null && typeof raw.definitions === 'object' && Array.isArray(raw.definitions.subgraphs) ? raw.definitions.subgraphs : []
    if (subgraphs.length > 0) {
      throw new ComfyError(
        'SUBGRAPH_ONLY',
        'This file has no top-level nodes: its graph lives inside a subgraph definition (' + subgraphs.map((entry) => JSON.stringify(entry.name ?? entry.id ?? '')).join(', ') + '). A subgraph is a frontend construct with virtual input/output nodes this package does not lower. Open it in ComfyUI, ungroup it (or right-click the subgraph and pick "Unpack"), then save again - or export the API form with "Export (API)".',
      )
    }
    throw new ComfyError('WORKFLOW_EMPTY', 'This workflow has no nodes, so there is nothing to read.')
  }
  const findings = []
  const normalized = []
  const seen = new Set()
  for (const [index, node] of nodes.entries()) {
    if (node === null || typeof node !== 'object') {
      findings.push(finding('warning', 'bad_node', 'nodes[' + index + '] is not an object and was skipped.'))
      continue
    }
    const id = Number(node.id)
    if (!Number.isInteger(id)) {
      findings.push(finding('warning', 'bad_node', 'nodes[' + index + '] has no integer id and was skipped.'))
      continue
    }
    if (seen.has(id)) {
      findings.push(finding('warning', 'duplicate_id', 'two nodes share id ' + id + '; the later one was skipped.'))
      continue
    }
    seen.add(id)
    normalized.push({
      id,
      type: typeof node.type === 'string' ? node.type : '',
      mode: Number.isInteger(node.mode) ? node.mode : MODE_ALWAYS,
      title: typeof node.title === 'string' ? node.title : '',
      inputs: Array.isArray(node.inputs) ? node.inputs : [],
      outputs: Array.isArray(node.outputs) ? node.outputs : [],
      widgetsValues: Array.isArray(node.widgets_values) ? node.widgets_values : [],
      widgetsValuesIsObject: node.widgets_values !== null && typeof node.widgets_values === 'object' && !Array.isArray(node.widgets_values),
      properties: node.properties !== null && typeof node.properties === 'object' ? node.properties : {},
    })
  }
  return { nodes: normalized, links: links.map(normalizeLink).filter(Boolean), findings }
}

/** One link, from either stored shape. */
function normalizeLink(entry) {
  if (Array.isArray(entry) && entry.length >= 5) {
    return { id: Number(entry[0]), origin_id: Number(entry[1]), origin_slot: Number(entry[2]), target_id: Number(entry[3]), target_slot: Number(entry[4]), type: String(entry[5] ?? '') }
  }
  if (entry === null || typeof entry !== 'object') return null
  return {
    id: Number(entry.id),
    origin_id: Number(entry.origin_id),
    origin_slot: Number(entry.origin_slot),
    target_id: Number(entry.target_id),
    target_slot: Number(entry.target_slot),
    type: typeof entry.type === 'string' ? entry.type : '',
  }
}

/**
 * A UI workflow as an API prompt.
 *
 * The three frontend-only constructs are handled rather than tripped over:
 * `Reroute` is followed through (it is a bend in a wire, not a node),
 * `PrimitiveNode` supplies a literal to the widget it feeds, and a MUTED node
 * (mode 2) is dropped. A BYPASSED node (mode 4) is refused by name, because
 * bypass rewires the graph and silently dropping the node would run a
 * different graph than the one on screen.
 *
 * @param workflow - a `parseWorkflow` result.
 * @param catalog - a COMPLETE catalog.
 * @returns `{ prompt, findings }` - feed `prompt` to `validatePrompt`.
 * @throws ComfyError('SCHEMA_REQUIRED') without a complete catalog.
 */
export function workflowToPrompt(workflow, catalog) {
  if (catalog === null || catalog.complete !== true) {
    throw new ComfyError(
      'SCHEMA_REQUIRED',
      'Reading a UI workflow needs the FULL node catalog, and only a server (or its cache) has one: `widgets_values` is an unnamed array, so the class\'s input order is what turns it into names. Start ComfyUI, call `comfy_status` to find its address, then call this again. A prompt.json needs none of this - validate that instead.',
    )
  }
  const findings = [...workflow.findings]
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  const linksByTarget = new Map()
  const linksById = new Map()
  for (const link of workflow.links) {
    linksById.set(link.id, link)
    const list = linksByTarget.get(link.target_id) ?? []
    list.push(link)
    linksByTarget.set(link.target_id, list)
  }

  /** The node at the far end of a wire, following reroutes. */
  const originOf = (link) => {
    let current = link
    let guard = 0
    while (current !== undefined && guard < 64) {
      guard += 1
      const node = byId.get(current.origin_id)
      if (node === undefined) return null
      if (node.type === 'Reroute') {
        const incoming = (linksByTarget.get(node.id) ?? [])[0]
        if (incoming === undefined) return null
        current = incoming
        continue
      }
      return { node, slot: current.origin_slot }
    }
    return null
  }

  const prompt = {}
  for (const node of workflow.nodes) {
    if (VIRTUAL_CLASSES.has(node.type)) continue
    if (node.mode === MODE_NEVER) {
      findings.push(finding('warning', 'muted_node', 'node ' + node.id + ' (' + node.type + ') is muted, so it is not part of the prompt.'))
      continue
    }
    if (node.mode === MODE_BYPASS) {
      throw new ComfyError(
        'BYPASSED_NODE',
        'node ' + node.id + ' (' + node.type + ') is BYPASSED. Bypass rewires the graph through the node\'s matching input and output, and dropping the node instead would run a different graph than the one on screen. Un-bypass it in ComfyUI (Ctrl+B) and save again.',
      )
    }
    const spec = nodeIn(catalog, node.type)
    if (spec === null) {
      findings.push(finding('error', 'missing_node_type', 'node ' + node.id + ' is class "' + node.type + '", which this server does not have.', { node: String(node.id), class: node.type }))
      continue
    }
    const inputs = {}
    const links = linksByTarget.get(node.id) ?? []
    for (const link of links) {
      const target = node.inputs[link.target_slot]
      const name = target !== undefined && typeof target.name === 'string' ? target.name : ''
      if (name === '') {
        findings.push(finding('warning', 'bad_linked_input', 'node ' + node.id + ' has a link into slot ' + link.target_slot + ', which is not one of its inputs.'))
        continue
      }
      const origin = originOf(link)
      if (origin === null) {
        findings.push(finding('error', 'bad_linked_input', 'node ' + node.id + ' input "' + name + '" wires from node ' + link.origin_id + ', which is not in this file.', { node: String(node.id), input: name }))
        continue
      }
      if (origin.node.type === 'PrimitiveNode') {
        // A primitive is a literal typed into a widget: no node, no wire.
        const value = origin.node.widgetsValues.length > 0 ? origin.node.widgetsValues[0] : undefined
        inputs[name] = value
        continue
      }
      inputs[name] = [String(origin.node.id), origin.slot]
    }
    if (node.widgetsValuesIsObject) {
      findings.push(finding('warning', 'widgets_values_object', 'node ' + node.id + ' (' + node.type + ') stores `widgets_values` as an object rather than an array. Only the wired inputs are read; set its widgets in ComfyUI and save again for a complete prompt.'))
    } else {
      const decoded = decodeWidgetValues(spec, node.widgetsValues, findings, node)
      for (const [name, value] of Object.entries(decoded)) if (!(name in inputs)) inputs[name] = value
    }
    prompt[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title !== '' ? node.title : spec.displayName },
    }
  }
  return { prompt, findings }
}

/**
 * `widgets_values` as names.
 *
 * The order is the class's widget inputs, in declaration order, and the LENGTH
 * is not the number of widgets: a widget input that declares
 * `control_after_generate` carries a second value right after itself. The
 * decode is positional, so a length mismatch is reported rather than guessed
 * at - a shifted array is exactly the defect this feature would otherwise
 * introduce.
 */
export function decodeWidgetValues(spec, values, findings = [], node = null) {
  const widgets = spec.inputs.filter((input) => input.kind === 'widget')
  const decoded = {}
  let cursor = 0
  for (const input of widgets) {
    if (cursor >= values.length) break
    decoded[input.name] = values[cursor]
    cursor += 1
    if (input.controlAfterGenerate && typeof values[cursor] === 'string' && ['fixed', 'increment', 'decrement', 'randomize'].includes(values[cursor])) cursor += 1
  }
  if (cursor !== values.length && node !== null) {
    findings.push(
      finding(
        'warning',
        'widgets_values_length',
        'node ' + node.id + ' (' + spec.class + ') has ' + values.length + ' widget value(s) but its inputs account for ' + cursor + '. The values are matched in order, so anything after the mismatch is attributed by position.',
        { node: String(node.id), class: spec.class },
      ),
    )
  }
  return decoded
}

/**
 * The files a finished prompt produced.
 *
 * `/history` stores them per node under a key that depends on the node
 * (`images` for SaveImage, `audio` for SaveAudio, `video` for SaveVideo), so the
 * shape is read generically: any array of `{ filename, subfolder, type }` is an
 * artifact, whatever it is called.
 */
export function outputsOf(historyEntry) {
  const outputs = historyEntry !== null && typeof historyEntry === 'object' && historyEntry.outputs !== null && typeof historyEntry.outputs === 'object' ? historyEntry.outputs : {}
  const files = []
  for (const [nodeId, value] of Object.entries(outputs)) {
    if (value === null || typeof value !== 'object') continue
    for (const [key, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        if (typeof item.filename !== 'string') continue
        files.push({
          node: nodeId,
          key,
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : 'output',
          url: '/view?filename=' + encodeURIComponent(item.filename) + '&subfolder=' + encodeURIComponent(typeof item.subfolder === 'string' ? item.subfolder : '') + '&type=' + encodeURIComponent(typeof item.type === 'string' ? item.type : 'output'),
        })
      }
    }
  }
  return files
}

/** The execution errors a `/history` entry recorded, as sentences. */
export function errorsOf(historyEntry) {
  const status = historyEntry !== null && typeof historyEntry === 'object' && historyEntry.status !== null && typeof historyEntry.status === 'object' ? historyEntry.status : {}
  const messages = Array.isArray(status.messages) ? status.messages : []
  const found = []
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue
    const [event, data] = message
    if (event !== 'execution_error' && event !== 'execution_interrupted') continue
    const body = data !== null && typeof data === 'object' ? data : {}
    found.push({
      event,
      node: body.node_id === undefined ? '' : String(body.node_id),
      nodeType: typeof body.node_type === 'string' ? body.node_type : '',
      exceptionType: typeof body.exception_type === 'string' ? body.exception_type : '',
      message: typeof body.exception_message === 'string' ? body.exception_message : '',
    })
  }
  return found
}

/** Whether a `/prompt` response is the refusal `node_errors` describes. */
export function errorSentenceFromResponse(body) {
  if (body === null || typeof body !== 'object') return ''
  const error = body.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : ''
    const details = typeof error.details === 'string' ? error.details : ''
    return (message + (details !== '' ? ' ' + details : '')).trim()
  }
  return ''
}

/** Every `node_errors` entry as findings, for a failed `/prompt`. */
export function findingsFromNodeErrors(nodeErrors) {
  const findings = []
  if (nodeErrors === null || typeof nodeErrors !== 'object') return findings
  for (const [nodeId, entry] of Object.entries(nodeErrors)) {
    const errors = entry !== null && typeof entry === 'object' && Array.isArray(entry.errors) ? entry.errors : []
    const classType = entry !== null && typeof entry === 'object' && typeof entry.class_type === 'string' ? entry.class_type : ''
    for (const error of errors) {
      findings.push(
        finding('error', typeof error.type === 'string' ? error.type : 'node_error', (typeof error.message === 'string' ? error.message : 'node error') + (typeof error.details === 'string' && error.details !== '' ? ': ' + error.details : ''), {
          node: nodeId,
          class: classType,
        }),
      )
    }
  }
  return findings
}

/** Whether a class is one the frontend draws but the server never sees. */
export function isVirtualClass(classType) {
  return VIRTUAL_CLASSES.has(classType)
}
