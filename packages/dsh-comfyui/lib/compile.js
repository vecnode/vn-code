/**
 * dsh-comfyui — the compiler: a project spec becomes the two files ComfyUI
 * actually consumes.
 *
 *   prompt.json    the API prompt `/prompt` accepts: `{ "<id>": { class_type,
 *                  inputs, _meta } }`, where a wire is `[ "<id>", slot ]`.
 *   workflow.json  the canvas the APP opens: nodes with positions, an `inputs`
 *                  array per node, and `links`, which is what a person drags
 *                  around and what the frontend's "Save" would have written.
 *
 * The two are not interchangeable and are produced together because each is
 * unreadable to the other consumer: `/prompt` wants ids and slot numbers; the
 * canvas wants geometry and widget arrays.
 *
 * THE HARD PART, AND WHY THE CATALOG IS REQUIRED: `widgets_values` is an
 * UNNAMED array. Its meaning is the class's input order, and there is one trap
 * with no syntactic marker at all - a class whose INT input declares
 * `control_after_generate: true` gets an EXTRA string value right after that
 * input ("fixed" / "increment" / "decrement" / "randomize"). Measured on
 * ComfyUI 0.21.1: `KSampler.seed` has it, so its array is
 * `[seed, "fixed", steps, cfg, sampler_name, scheduler, denoise]`, and a
 * compiler that omits the extra value silently shifts every widget after the
 * seed - the graph opens, the values are wrong, and nothing reports it. That is
 * the defect this module exists to make impossible.
 *
 * Positions are computed when the spec does not give them (columns by depth, so
 * a compiled graph reads left-to-right instead of stacking at the origin), and
 * every emitted file records WHICH catalog built it, so a graph compiled
 * against the built-in table is never presented as one checked against a
 * server.
 */

import { ComfyError } from './errors.js'
import { linkInputs, nodeIn, SOURCES, widgetInputs } from './nodes.js'
import { resolveWire } from './spec.js'

/** The workflow format version this package writes (the 0.4 object-link form). */
export const WORKFLOW_VERSION = 0.4

/** The default `control_after_generate` value: a build must be reproducible. */
export const DEFAULT_CONTROL_AFTER_GENERATE = 'fixed'

/** The four values ComfyUI's frontend offers after a control widget. */
export const CONTROL_AFTER_GENERATE = ['fixed', 'increment', 'decrement', 'randomize']

/** A canvas column's width and a row's height, in pixels. */
const COLUMN_WIDTH = 400
const ROW_HEIGHT = 300

/** One finding, shaped like the rest of the package. */
function finding(severity, type, message, where = {}) {
  return { severity, type, message, ...where }
}

/**
 * Resolve `@bindings` and coerce every widget value to the type its input
 * declares.
 *
 * A binding is the project's promise that "whichever checkpoint this machine
 * has" is a decision made at build time, not a filename frozen into a document.
 * An unresolved binding is an ERROR, never a silent default: a graph built with
 * a checkpoint nobody chose is a graph whose first run fails with
 * `value_not_in_list`, one step removed from the cause.
 *
 * @returns `{ values, findings }` where `values` is `Map<nodeKey, {input: value}>`.
 */
export function resolveWidgetValues(project, catalog) {
  const values = new Map()
  const findings = []
  for (const node of project.nodes) {
    const spec = nodeIn(catalog, node.class)
    const resolved = {}
    for (const [inputName, rawValue] of Object.entries(node.widgets)) {
      const inputSpec = spec === null ? null : spec.inputs.find((input) => input.name === inputName) ?? null
      let value = rawValue
      if (typeof value === 'string' && value.startsWith('@')) {
        const binding = value.slice(1)
        if (!(binding in project.bindings)) {
          findings.push(
            finding(
              'error',
              'BINDING_UNRESOLVED',
              'node "' + node.key + '" input "' + inputName + '" asks for the binding "@' + binding + '", which this project does not declare. Declared bindings: ' + (Object.keys(project.bindings).join(', ') || '(none)') + '. Set it in project.json\'s `bindings`, or pass it to `comfy_project` action=new.',
              { node: node.key, input: inputName, binding },
            ),
          )
          continue
        }
        value = project.bindings[binding]
      }
      const coerced = coerce(value, inputSpec)
      if (coerced.error !== '') {
        findings.push(finding('error', coerced.type, 'node "' + node.key + '" input "' + inputName + '": ' + coerced.error, { node: node.key, input: inputName }))
        continue
      }
      resolved[inputName] = coerced.value
    }
    values.set(node.key, resolved)
  }
  return { values, findings }
}

/**
 * One widget value, in the type its input declares.
 *
 * A COMBO is matched against the server's own option list, and a
 * case-insensitive match is normalized to the server's spelling - so a spec
 * that says "SGM Uniform" builds against a server that spells it
 * "sgm_uniform", instead of failing on a detail nobody meant to type.
 */
export function coerce(value, inputSpec) {
  if (inputSpec === null) return { value, error: '', type: '' }
  const type = inputSpec.type
  if (type === 'INT') {
    const number = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(number) || !Number.isInteger(number)) {
      return { value, error: 'expected an integer, got ' + JSON.stringify(value) + '.', type: 'invalid_input_type' }
    }
    if (inputSpec.options !== undefined && typeof inputSpec.options.min === 'number' && number < inputSpec.options.min) {
      return { value: number, error: 'value ' + number + ' is smaller than the minimum ' + inputSpec.options.min + '.', type: 'value_smaller_than_min' }
    }
    if (inputSpec.options !== undefined && typeof inputSpec.options.max === 'number' && number > inputSpec.options.max) {
      return { value: number, error: 'value ' + number + ' is bigger than the maximum ' + inputSpec.options.max + '.', type: 'value_bigger_than_max' }
    }
    return { value: number, error: '', type: '' }
  }
  if (type === 'FLOAT') {
    const number = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(number)) return { value, error: 'expected a number, got ' + JSON.stringify(value) + '.', type: 'invalid_input_type' }
    if (inputSpec.options !== undefined && typeof inputSpec.options.min === 'number' && number < inputSpec.options.min) {
      return { value: number, error: 'value ' + number + ' is smaller than the minimum ' + inputSpec.options.min + '.', type: 'value_smaller_than_min' }
    }
    if (inputSpec.options !== undefined && typeof inputSpec.options.max === 'number' && number > inputSpec.options.max) {
      return { value: number, error: 'value ' + number + ' is bigger than the maximum ' + inputSpec.options.max + '.', type: 'value_bigger_than_max' }
    }
    return { value: number, error: '', type: '' }
  }
  if (type === 'BOOLEAN') return { value: value === true || value === 'true' || value === 1, error: '', type: '' }
  if (type === 'STRING') return { value: String(value), error: '', type: '' }
  if (type === 'COMBO') {
    if (inputSpec.enum !== null && inputSpec.enum.length > 0) {
      const text = String(value)
      if (inputSpec.enum.includes(text)) return { value: text, error: '', type: '' }
      const insensitive = inputSpec.enum.find((option) => option.toLowerCase() === text.toLowerCase())
      if (insensitive !== undefined) return { value: insensitive, error: '', type: '' }
      const shown = inputSpec.enum.slice(0, 12)
      return {
        value,
        error:
          'value ' +
          JSON.stringify(text) +
          ' is not in this server\'s list for that input. Options: ' +
          shown.join(', ') +
          (inputSpec.enum.length > shown.length ? ', … (' + inputSpec.enum.length + ' total)' : '') +
          '.',
        type: 'value_not_in_list',
      }
    }
    return { value: String(value), error: '', type: '' }
  }
  // A link type used as a widget value: the class declared it as a widget
  // through a shape this compiler does not model, so pass it through untouched
  // rather than guessing a conversion.
  return { value, error: '', type: '' }
}

/**
 * Compile a validated project.
 *
 * @param project - a `readSpec` project.
 * @param catalog - the catalog in force.
 * @param options - `{ controlAfterGenerate }` default for seed widgets.
 * @returns `{ prompt, workflow, ids, order, widgetOrder, findings }`; any
 *          `findings` entry with severity `error` means nothing should be run.
 */
export function compileProject(project, catalog, options = {}) {
  const findings = []
  const { values, findings: bindingFindings } = resolveWidgetValues(project, catalog)
  findings.push(...bindingFindings)

  // Ids: declaration order, 1-based, because that is what a hand-written
  // ComfyUI workflow looks like and what a reader expects to see.
  const ids = new Map()
  for (const [index, node] of project.nodes.entries()) ids.set(node.key, index + 1)

  const prompt = {}
  for (const node of project.nodes) {
    const spec = nodeIn(catalog, node.class)
    const inputs = {}
    for (const [inputName, value] of Object.entries(values.get(node.key) ?? {})) inputs[inputName] = value
    for (const [inputName, target] of Object.entries(node.wires)) {
      const resolved = resolveWire(target, project.byKey, catalog)
      if (resolved.error !== '') {
        findings.push(finding('error', resolved.type, 'node "' + node.key + '" input "' + inputName + '": ' + resolved.error, { node: node.key, input: inputName }))
        continue
      }
      inputs[inputName] = [String(ids.get(resolved.key)), resolved.slot]
    }
    const title = node.title !== '' ? node.title : spec !== null ? spec.displayName : node.class
    prompt[String(ids.get(node.key))] = { class_type: node.class, inputs, _meta: { title } }
  }

  const workflow = buildWorkflow(project, catalog, ids, values, options, findings)
  const widgetOrder = catalogueSourceOf(project, catalog)
  return { prompt, workflow, ids, widgetOrder, findings }
}

/** Which catalog decided the widget layout - the fact a build record carries. */
function catalogueSourceOf(project, catalog) {
  if (catalog.complete) return catalog.source
  const everyKnown = project.nodes.every((node) => nodeIn(catalog, node.class) !== null)
  return everyKnown ? catalog.source : catalog.source + '-partial'
}

/**
 * The canvas.
 *
 * `inputs` carries the classic frontend form on purpose: an entry appears for a
 * link input, and for a widget input ONLY when a wire feeds it (with
 * `widget: { name }` marking the conversion). That is what every ComfyUI before
 * the 0.4 canvas wrote, and the current frontend migrates it on load - so the
 * file opens on old installs and new ones, which the current object-only form
 * does not.
 */
function buildWorkflow(project, catalog, ids, values, options, findings) {
  const order = topologicalOrder(project)
  const orderIndex = new Map(order.map((key, index) => [key, index]))
  const positions = layout(project, order)
  const links = []
  const linkIdsByTarget = new Map()
  let linkId = 0

  for (const node of project.nodes) {
    for (const [inputName, target] of Object.entries(node.wires)) {
      const resolved = resolveWire(target, project.byKey, catalog)
      if (resolved.error !== '') continue
      const targetNode = nodeIn(catalog, project.byKey.get(resolved.key).class)
      linkId += 1
      const type = targetNode !== null && targetNode.outputs[resolved.slot] !== undefined ? targetNode.outputs[resolved.slot].type : '*'
      links.push({ id: linkId, origin_id: ids.get(resolved.key), origin_slot: resolved.slot, target_id: ids.get(node.key), target_slot: -1, type })
      const list = linkIdsByTarget.get(node.key) ?? []
      list.push({ input: inputName, id: linkId })
      linkIdsByTarget.set(node.key, list)
    }
  }

  const nodes = []
  for (const node of project.nodes) {
    const spec = nodeIn(catalog, node.class)
    const wired = new Map((linkIdsByTarget.get(node.key) ?? []).map((entry) => [entry.input, entry.id]))
    const inputs = []
    if (spec !== null) {
      for (const input of spec.inputs) {
        if (input.kind === 'hidden') continue
        const link = wired.get(input.name)
        if (input.kind === 'link') {
          if (link === undefined) continue
          inputs.push({ name: input.name, type: input.type, link })
          continue
        }
        if (link !== undefined) inputs.push({ name: input.name, type: input.type, widget: { name: input.name }, link })
      }
    }
    // The target_slot of every link into this node is its position in `inputs`.
    for (const entry of linkIdsByTarget.get(node.key) ?? []) {
      const at = inputs.findIndex((input) => input.name === entry.input)
      const link = links.find((candidate) => candidate.id === entry.id)
      if (link !== undefined) link.target_slot = at === -1 ? inputs.length : at
    }
    const outputs = (spec === null ? [] : spec.outputs).map((output, slot) => ({
      name: output.name,
      type: output.type,
      links: links.filter((link) => link.origin_id === ids.get(node.key) && link.origin_slot === slot).map((link) => link.id),
      slot_index: slot,
    }))
    for (const output of outputs) if (output.links.length === 0) output.links = null
    const widgets = spec === null ? [] : widgetInputs(spec)
    const widgetsValues = []
    const resolved = values.get(node.key) ?? {}
    for (const input of widgets) {
      if (input.name in resolved) widgetsValues.push(resolved[input.name])
      else if (input.options !== undefined && input.options.default !== undefined) widgetsValues.push(input.options.default)
      else if (input.enum !== null && input.enum.length > 0) widgetsValues.push(input.enum[0])
      else widgetsValues.push('')
      if (input.controlAfterGenerate) {
        const chosen = node.controlAfterGenerate[input.name] ?? options.controlAfterGenerate ?? DEFAULT_CONTROL_AFTER_GENERATE
        if (!CONTROL_AFTER_GENERATE.includes(chosen)) {
          findings.push(
            finding(
              'warning',
              'bad_control_after_generate',
              'node "' + node.key + '" input "' + input.name + '" asks for control_after_generate "' + String(chosen) + '", which is not one of ' + CONTROL_AFTER_GENERATE.join(', ') + '; "fixed" was used.',
              { node: node.key, input: input.name },
            ),
          )
          widgetsValues.push(DEFAULT_CONTROL_AFTER_GENERATE)
        } else {
          widgetsValues.push(chosen)
        }
      }
    }
    const title = node.title !== '' ? node.title : spec !== null ? spec.displayName : node.class
    nodes.push({
      id: ids.get(node.key),
      type: node.class,
      pos: positions.get(node.key) ?? [0, 0],
      size: node.size ?? estimateSize(spec),
      flags: {},
      order: orderIndex.get(node.key) ?? 0,
      mode: node.mode,
      inputs,
      outputs,
      title,
      properties: { 'Node name for S&R': node.class },
      widgets_values: widgetsValues,
    })
  }

  return {
    revision: 0,
    last_node_id: project.nodes.length,
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { ds: { scale: 1, offset: [0, 0] } },
    version: WORKFLOW_VERSION,
  }
}

/** A node's box on the canvas, from how much text it has to show. */
function estimateSize(spec) {
  if (spec === null) return [320, 120]
  const widgets = widgetInputs(spec).length
  const slots = Math.max(linkInputs(spec).length, spec.outputs.length)
  const height = Math.max(90, 46 + widgets * 26 + Math.max(0, slots - widgets) * 22)
  return [320, height]
}

/**
 * The execution order the canvas records: a node's `order` is its index in a
 * topological pass, which is what the frontend writes after it sorts the graph.
 */
function topologicalOrder(project) {
  const pending = new Map(project.nodes.map((node) => [node.key, new Set(Object.values(node.wires).map((target) => String(target).split('.')[0]))]))
  const done = []
  const seen = new Set()
  while (done.length < project.nodes.length) {
    let progressed = false
    for (const node of project.nodes) {
      if (seen.has(node.key)) continue
      const waiting = [...(pending.get(node.key) ?? [])].filter((key) => !seen.has(key) && project.byKey.has(key))
      if (waiting.length > 0) continue
      seen.add(node.key)
      done.push(node.key)
      progressed = true
    }
    if (!progressed) {
      // A cycle: everything left is emitted in declaration order, which is what
      // the validator has already reported as an error.
      for (const node of project.nodes) if (!seen.has(node.key)) {
        seen.add(node.key)
        done.push(node.key)
      }
    }
  }
  return done
}

/**
 * Put the nodes on the canvas: one column per dependency depth, one row per
 * node in that column.
 *
 * Without this every node lands on (0,0) and the person opens a graph they
 * cannot see - the difference between a workflow that is CORRECT and one that
 * is usable.
 */
function layout(project, order) {
  const depth = new Map()
  for (const key of order) {
    const node = project.byKey.get(key)
    if (node === undefined) continue
    if (node.pos !== null) {
      depth.set(key, 0)
      continue
    }
    let deepest = -1
    for (const target of Object.values(node.wires)) {
      const source = String(target).split('.')[0]
      const value = depth.get(source)
      if (typeof value === 'number' && value > deepest) deepest = value
    }
    depth.set(key, deepest + 1)
  }
  const rowsIn = new Map()
  const positions = new Map()
  for (const key of order) {
    const node = project.byKey.get(key)
    if (node === undefined) continue
    if (node.pos !== null) {
      positions.set(key, node.pos)
      continue
    }
    const column = depth.get(key) ?? 0
    const row = rowsIn.get(column) ?? 0
    rowsIn.set(column, row + 1)
    positions.set(key, [40 + column * COLUMN_WIDTH, 40 + row * ROW_HEIGHT])
  }
  return positions
}

/** The classes a project uses that the catalog does not know. */
export function unknownClasses(project, catalog) {
  return project.nodes.filter((node) => nodeIn(catalog, node.class) === null).map((node) => node.class)
}

/** The catalog's own name for where it came from, for a build record. */
export function describeCatalog(catalog) {
  if (catalog.source === SOURCES.core) return 'built-in core table (' + catalog.nodes.size + ' nodes)'
  if (catalog.source === SOURCES.cache) return 'cached /object_info' + (catalog.version === '' ? '' : ' from ComfyUI ' + catalog.version) + (catalog.fetchedAt === '' ? '' : ', ' + catalog.fetchedAt)
  return '/object_info from ' + (catalog.origin === '' ? 'the server' : catalog.origin) + (catalog.version === '' ? '' : ' (ComfyUI ' + catalog.version + ')')
}

/** A compiled project as a ComfyError when there is nothing to compile. */
export function assertCompiled(result) {
  const errors = result.findings.filter((entry) => entry.severity === 'error')
  if (errors.length === 0) return result
  throw new ComfyError('PROJECT_INVALID', errors.length + ' error(s) stop this project from compiling: ' + errors.map((entry) => entry.message).join(' '), { findings: errors })
}
