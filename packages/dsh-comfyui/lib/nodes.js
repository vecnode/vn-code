/**
 * dsh-comfyui — the node catalog, and the small built-in table that lets a
 * project compile on a machine with no server running.
 *
 * WHAT A CATALOG IS: `/object_info` is the only authority on what a node class
 * accepts, what it returns and which of its inputs are WIDGETS (a value typed
 * into the node) rather than LINKS (a wire from another node's output). That
 * distinction is what turns a readable spec into a workflow the app can open
 * and a prompt the server will accept, so it is not a nicety - it is the
 * compiler's input.
 *
 * The response has TWO shapes in one document, and this module flattens both:
 *
 *   - a classic node (`class X: INPUT_TYPES()`), where an input is
 *     `[type, options]` and `type` is a string, or a LIST of strings (a combo
 *     whose options are files on this machine);
 *   - a V3 node (`IO.ComfyNode.define_schema`), whose `/object_info` is
 *     `GET_NODE_INFO_V1()` - the same `[type, options]` tuple, with combos
 *     typed `"COMBO"` and their options under `options`.
 *
 * Measured on ComfyUI 0.21.1 (ComfyUI Desktop 2): `RepeatImageBatch` answers
 * through the V3 path, `KSampler` and `LoadImage` through the classic one, and
 * `CLIPTextEncode` mixes the two (its `text` input is declared `IO.STRING`).
 * A parser that handled only one shape would misread half the catalog.
 *
 * WHY A TABLE EXISTS AT ALL: a class list is version-specific, so a snapshot
 * shipped in a package would be worse than none - but the eighteen core nodes
 * the shipped examples use are stable enough to declare, and with them
 * `comfy_test` compiles the whole library on a laptop where ComfyUI is not
 * running. The table NEVER overrules a server: a live catalog replaces it
 * wholesale, and a project built against the table is reported as
 * `widgetOrder: "core-table"` so a reader knows what was verified.
 */

/** The catalog sources, best first. */
export const SOURCES = { server: 'server', cache: 'cache', core: 'core-table' }

/** Inputs whose options are files on THIS machine - no snapshot can know them. */
export const FILE_INPUTS = {
  ckpt_name: 'checkpoints',
  lora_name: 'loras',
  vae_name: 'vae',
  unet_name: 'diffusion_models',
  clip_name: 'text_encoders',
  clip_name1: 'text_encoders',
  clip_name2: 'text_encoders',
  clip_name3: 'text_encoders',
  control_net_name: 'controlnet',
  upscale_model_name: 'upscale_models',
  style_model_name: 'style_models',
  image: 'input',
  model: 'diffusion_models',
}

/**
 * The core port table.
 *
 * eighteen nodes, each entry transcribed from the installed 0.21.1 source
 * (`nodes.py`, `comfy_extras/nodes_audio.py`, `nodes_video.py`, `nodes_images.py`)
 * and asserted by the package check against a fixture of the real `/object_info`
 * shapes. `kind` is what the compiler needs: `widget` values go in
 * `widgets_values` AND in the API prompt's `inputs`, `link` values only ever
 * carry a wire, and `hidden` values are supplied by the server (`prompt`,
 * `extra_pnginfo`) so they must never appear in either.
 */
export const CORE_NODES = {
  CheckpointLoaderSimple: {
    displayName: 'Load Checkpoint',
    category: 'loaders',
    outputs: ['MODEL', 'CLIP', 'VAE'],
    inputs: [{ name: 'ckpt_name', type: 'COMBO', kind: 'widget', fileFolder: 'checkpoints' }],
  },
  LoraLoader: {
    displayName: 'Load LoRA',
    category: 'loaders',
    outputs: ['MODEL', 'CLIP'],
    inputs: [
      { name: 'model', type: 'MODEL', kind: 'link' },
      { name: 'clip', type: 'CLIP', kind: 'link' },
      { name: 'lora_name', type: 'COMBO', kind: 'widget', fileFolder: 'loras' },
      { name: 'strength_model', type: 'FLOAT', kind: 'widget', options: { default: 1, min: -100, max: 100, step: 0.01 } },
      { name: 'strength_clip', type: 'FLOAT', kind: 'widget', options: { default: 1, min: -100, max: 100, step: 0.01 } },
    ],
  },
  CLIPTextEncode: {
    displayName: 'CLIP Text Encode (Prompt)',
    category: 'conditioning',
    outputs: ['CONDITIONING'],
    inputs: [
      { name: 'text', type: 'STRING', kind: 'widget', options: { default: '', multiline: true } },
      { name: 'clip', type: 'CLIP', kind: 'link' },
    ],
  },
  EmptyLatentImage: {
    displayName: 'Empty Latent Image',
    category: 'latent',
    outputs: ['LATENT'],
    inputs: [
      { name: 'width', type: 'INT', kind: 'widget', options: { default: 512, min: 16, max: 16384, step: 8 } },
      { name: 'height', type: 'INT', kind: 'widget', options: { default: 512, min: 16, max: 16384, step: 8 } },
      { name: 'batch_size', type: 'INT', kind: 'widget', options: { default: 1, min: 1, max: 4096 } },
    ],
  },
  KSampler: {
    displayName: 'KSampler',
    category: 'sampling',
    outputs: ['LATENT'],
    inputs: [
      { name: 'model', type: 'MODEL', kind: 'link' },
      { name: 'seed', type: 'INT', kind: 'widget', controlAfterGenerate: true, options: { default: 0, min: 0, max: 18446744073709551615 } },
      { name: 'steps', type: 'INT', kind: 'widget', options: { default: 20, min: 1, max: 10000 } },
      { name: 'cfg', type: 'FLOAT', kind: 'widget', options: { default: 8, min: 0, max: 100, step: 0.1 } },
      { name: 'sampler_name', type: 'COMBO', kind: 'widget' },
      { name: 'scheduler', type: 'COMBO', kind: 'widget' },
      { name: 'positive', type: 'CONDITIONING', kind: 'link' },
      { name: 'negative', type: 'CONDITIONING', kind: 'link' },
      { name: 'latent_image', type: 'LATENT', kind: 'link' },
      { name: 'denoise', type: 'FLOAT', kind: 'widget', options: { default: 1, min: 0, max: 1, step: 0.01 } },
    ],
  },
  VAEDecode: {
    displayName: 'VAE Decode',
    category: 'latent',
    outputs: ['IMAGE'],
    inputs: [
      { name: 'samples', type: 'LATENT', kind: 'link' },
      { name: 'vae', type: 'VAE', kind: 'link' },
    ],
  },
  VAEEncode: {
    displayName: 'VAE Encode',
    category: 'latent',
    outputs: ['LATENT'],
    inputs: [
      { name: 'pixels', type: 'IMAGE', kind: 'link' },
      { name: 'vae', type: 'VAE', kind: 'link' },
    ],
  },
  SaveImage: {
    displayName: 'Save Image',
    category: 'image',
    outputNode: true,
    outputs: [],
    inputs: [
      { name: 'images', type: 'IMAGE', kind: 'link' },
      { name: 'filename_prefix', type: 'STRING', kind: 'widget', options: { default: 'ComfyUI' } },
      { name: 'prompt', type: 'PROMPT', kind: 'hidden' },
      { name: 'extra_pnginfo', type: 'EXTRA_PNGINFO', kind: 'hidden' },
    ],
  },
  PreviewImage: {
    displayName: 'Preview Image',
    category: 'image',
    outputNode: true,
    outputs: [],
    inputs: [{ name: 'images', type: 'IMAGE', kind: 'link' }],
  },
  LoadImage: {
    displayName: 'Load Image',
    category: 'image',
    outputs: ['IMAGE', 'MASK'],
    inputs: [{ name: 'image', type: 'COMBO', kind: 'widget', fileFolder: 'input', options: { imageUpload: true } }],
  },
  ImageScale: {
    displayName: 'Upscale Image',
    category: 'image/upscaling',
    outputs: ['IMAGE'],
    inputs: [
      { name: 'image', type: 'IMAGE', kind: 'link' },
      { name: 'upscale_method', type: 'COMBO', kind: 'widget', enum: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'] },
      { name: 'width', type: 'INT', kind: 'widget', options: { default: 512, min: 0, max: 16384, step: 1 } },
      { name: 'height', type: 'INT', kind: 'widget', options: { default: 512, min: 0, max: 16384, step: 1 } },
      { name: 'crop', type: 'COMBO', kind: 'widget', enum: ['disabled', 'center'] },
    ],
  },
  EmptyImage: {
    displayName: 'Empty Image',
    category: 'image',
    outputs: ['IMAGE'],
    inputs: [
      { name: 'width', type: 'INT', kind: 'widget', options: { default: 512, min: 1, max: 16384, step: 1 } },
      { name: 'height', type: 'INT', kind: 'widget', options: { default: 512, min: 1, max: 16384, step: 1 } },
      { name: 'batch_size', type: 'INT', kind: 'widget', options: { default: 1, min: 1, max: 4096 } },
      { name: 'color', type: 'INT', kind: 'widget', options: { default: 0, min: 0, max: 16777215, step: 1, display: 'color' } },
    ],
  },
  RepeatImageBatch: {
    displayName: 'Repeat Image Batch',
    category: 'image/batch',
    outputs: ['IMAGE'],
    inputs: [
      { name: 'image', type: 'IMAGE', kind: 'link' },
      { name: 'amount', type: 'INT', kind: 'widget', options: { default: 1, min: 1, max: 4096 } },
    ],
  },
  CreateVideo: {
    displayName: 'Create Video',
    category: 'video',
    outputs: ['VIDEO'],
    inputs: [
      { name: 'images', type: 'IMAGE', kind: 'link' },
      { name: 'fps', type: 'FLOAT', kind: 'widget', options: { default: 30, min: 1, max: 120, step: 1 } },
      { name: 'audio', type: 'AUDIO', kind: 'link', optional: true },
    ],
  },
  SaveVideo: {
    displayName: 'Save Video',
    category: 'video',
    outputNode: true,
    outputs: [],
    inputs: [
      { name: 'video', type: 'VIDEO', kind: 'link' },
      { name: 'filename_prefix', type: 'STRING', kind: 'widget', options: { default: 'video/ComfyUI' } },
      { name: 'format', type: 'COMBO', kind: 'widget', options: { default: 'auto' } },
      { name: 'codec', type: 'COMBO', kind: 'widget', options: { default: 'auto' } },
      { name: 'prompt', type: 'PROMPT', kind: 'hidden' },
      { name: 'extra_pnginfo', type: 'EXTRA_PNGINFO', kind: 'hidden' },
    ],
  },
  EmptyLatentAudio: {
    displayName: 'Empty Latent Audio',
    category: 'latent/audio',
    outputs: ['LATENT'],
    inputs: [
      { name: 'seconds', type: 'FLOAT', kind: 'widget', options: { default: 47.6, min: 1, max: 1000, step: 0.1 } },
      { name: 'batch_size', type: 'INT', kind: 'widget', options: { default: 1, min: 1, max: 4096 } },
    ],
  },
  VAEDecodeAudio: {
    displayName: 'VAE Decode Audio',
    category: 'latent/audio',
    outputs: ['AUDIO'],
    inputs: [
      { name: 'samples', type: 'LATENT', kind: 'link' },
      { name: 'vae', type: 'VAE', kind: 'link' },
    ],
  },
  SaveAudio: {
    displayName: 'Save Audio (FLAC)',
    category: 'audio',
    outputNode: true,
    outputs: [],
    inputs: [
      { name: 'audio', type: 'AUDIO', kind: 'link' },
      { name: 'filename_prefix', type: 'STRING', kind: 'widget', options: { default: 'audio/ComfyUI' } },
      { name: 'prompt', type: 'PROMPT', kind: 'hidden' },
      { name: 'extra_pnginfo', type: 'EXTRA_PNGINFO', kind: 'hidden' },
    ],
  },
}

/** A widget's value type, from the declared type string. */
export function widgetKind(type) {
  if (type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN') return type
  return null
}

/** Whether a declared type is a link type (no widget of its own). */
export function isLinkType(type) {
  return !(type === 'COMBO' || widgetKind(type) !== null)
}

/**
 * One catalog entry from the core table.
 *
 * @param classType - the class name.
 * @param entry - a `CORE_NODES` value.
 * @returns a normalized `NodeSpec`.
 */
export function nodeFromTable(classType, entry) {
  return {
    class: classType,
    displayName: entry.displayName ?? classType,
    category: entry.category ?? '',
    description: entry.description ?? '',
    outputNode: entry.outputNode === true,
    deprecated: false,
    experimental: false,
    pythonModule: 'nodes',
    inputs: entry.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      kind: input.kind,
      optional: input.optional === true,
      enum: Array.isArray(input.enum) ? input.enum.slice() : null,
      options: input.options ?? {},
      controlAfterGenerate: input.controlAfterGenerate === true,
      fileFolder: input.fileFolder ?? FILE_INPUTS[input.name] ?? null,
    })),
    outputs: entry.outputs.map((type) => ({ name: type, type })),
    source: SOURCES.core,
  }
}

/** The catalog a machine with no server and no cache can still compile against. */
export function coreCatalog() {
  const nodes = new Map()
  for (const [classType, entry] of Object.entries(CORE_NODES)) nodes.set(classType, nodeFromTable(classType, entry))
  return {
    source: SOURCES.core,
    origin: '',
    version: '',
    fetchedAt: '',
    complete: false,
    nodes,
    note: 'the built-in core table (' + nodes.size + ' nodes the shipped examples use); a live server replaces it whole',
  }
}

/**
 * One `/object_info` entry, flattened.
 *
 * @param classType - the key the server used.
 * @param info - that key's value.
 * @returns a `NodeSpec`, or null when the entry is not shaped like one.
 */
export function parseNodeInfo(classType, info) {
  if (info === null || typeof info !== 'object') return null
  const declared = info.input !== null && typeof info.input === 'object' ? info.input : {}
  const order = info.input_order !== null && typeof info.input_order === 'object' ? info.input_order : {}
  const inputs = []
  for (const section of ['required', 'optional']) {
    const group = declared[section]
    if (group === null || typeof group !== 'object') continue
    const names = Array.isArray(order[section]) ? order[section] : Object.keys(group)
    for (const name of names) {
      if (!(name in group)) continue
      const input = parseInputEntry(name, group[name], section === 'optional')
      if (input !== null) inputs.push(input)
    }
  }
  const hidden = declared.hidden
  if (hidden !== null && typeof hidden === 'object') {
    for (const name of Object.keys(hidden)) inputs.push({ name, type: 'HIDDEN', kind: 'hidden', optional: true, enum: null, options: {}, controlAfterGenerate: false, fileFolder: null })
  }
  const types = Array.isArray(info.output) ? info.output : []
  const names = Array.isArray(info.output_name) && info.output_name.length === types.length ? info.output_name : types
  return {
    class: classType,
    displayName: typeof info.display_name === 'string' && info.display_name !== '' ? info.display_name : classType,
    category: typeof info.category === 'string' ? info.category : '',
    description: typeof info.description === 'string' ? info.description : '',
    outputNode: info.output_node === true,
    deprecated: info.deprecated === true,
    experimental: info.experimental === true,
    pythonModule: typeof info.python_module === 'string' ? info.python_module : '',
    inputs,
    outputs: types.map((type, index) => ({ name: String(names[index] ?? type), type: String(type) })),
    source: SOURCES.server,
  }
}

/**
 * One input of an `/object_info` entry: `[type, options]`, in either shape.
 *
 * A type that is an ARRAY is a combo whose options are that array; the string
 * `"COMBO"` is the V3 spelling of the same thing with the options in
 * `options.options`. `forceInput` turns a widget into a link-only input, which
 * is the difference between a value written into `widgets_values` and a wire.
 */
function parseInputEntry(name, raw, optional) {
  let type = raw
  let options = {}
  if (Array.isArray(raw)) {
    type = raw[0]
    if (raw[1] !== null && typeof raw[1] === 'object') options = raw[1]
  }
  let enumValues = null
  let declaredType = type
  if (Array.isArray(type)) {
    enumValues = type.map((value) => String(value))
    declaredType = 'COMBO'
  } else if (type === 'COMBO') {
    enumValues = Array.isArray(options.options) ? options.options.map((value) => String(value)) : null
  } else if (typeof type !== 'string') {
    return null
  }
  const forceInput = options.forceInput === true
  // `"COMBO"` is a widget even when this build of the server put no option list
  // in the entry (the core table has none offline): a combo with unknown options
  // is a dropdown nobody can check, not a wire.
  const kind = forceInput ? 'link' : enumValues !== null || declaredType === 'COMBO' || widgetKind(declaredType) !== null ? 'widget' : 'link'
  return {
    name,
    type: declaredType,
    kind,
    optional: optional === true || options.optional === true,
    enum: enumValues,
    options,
    controlAfterGenerate: options.control_after_generate === true,
    fileFolder: FILE_INPUTS[name] ?? null,
  }
}

/**
 * A whole `/object_info` response as a catalog.
 *
 * @param raw - the parsed response body.
 * @param meta - `{ origin, version, fetchedAt }`.
 */
export function catalogFromObjectInfo(raw, meta = {}) {
  const nodes = new Map()
  let skipped = 0
  for (const [classType, info] of Object.entries(raw)) {
    const parsed = parseNodeInfo(classType, info)
    if (parsed === null) {
      skipped += 1
      continue
    }
    nodes.set(classType, parsed)
  }
  return {
    source: SOURCES.server,
    origin: typeof meta.origin === 'string' ? meta.origin : '',
    version: typeof meta.version === 'string' ? meta.version : '',
    fetchedAt: typeof meta.fetchedAt === 'string' ? meta.fetchedAt : '',
    complete: true,
    nodes,
    note: skipped === 0 ? '' : skipped + ' /object_info entr(ies) were not shaped like a node and were skipped',
  }
}

/** The one node class, from any catalog. */
export function nodeIn(catalog, classType) {
  if (catalog === null || catalog === undefined) return null
  return catalog.nodes.get(classType) ?? null
}

/** Whether a catalog can speak about a class at all. */
export function knows(catalog, classType) {
  return nodeIn(catalog, classType) !== null
}

/** Every class name, sorted. */
export function classesIn(catalog) {
  return [...catalog.nodes.keys()].sort()
}

/** The classes grouped by their `category`, sorted, with counts. */
export function categoriesIn(catalog) {
  const groups = new Map()
  for (const node of catalog.nodes.values()) {
    const key = node.category === '' ? '(uncategorised)' : node.category
    const list = groups.get(key) ?? []
    list.push(node.class)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .map(([category, classes]) => ({ category, count: classes.length, classes: classes.sort() }))
    .sort((left, right) => left.category.localeCompare(right.category))
}

/**
 * A search over the catalog: class, display name, category and description.
 *
 * Ranking is "class matches first, then the others", so a query for "KSampler"
 * does not put fifty conditioning nodes above the node that is literally named
 * that.
 */
export function searchCatalog(catalog, query, limit = 40) {
  const needle = String(query).toLowerCase().trim()
  if (needle === '') return []
  const scored = []
  for (const node of catalog.nodes.values()) {
    let score = 0
    if (node.class.toLowerCase() === needle) score = 100
    else if (node.class.toLowerCase().startsWith(needle)) score = 80
    else if (node.class.toLowerCase().includes(needle)) score = 60
    else if (node.displayName.toLowerCase().includes(needle)) score = 40
    else if (node.category.toLowerCase().includes(needle)) score = 20
    else if (node.description.toLowerCase().includes(needle)) score = 10
    if (score > 0) scored.push({ node, score })
  }
  return scored
    .sort((left, right) => right.score - left.score || left.node.class.localeCompare(right.node.class))
    .slice(0, limit)
    .map((entry) => entry.node)
}

/** The widget inputs of a node, in the order the frontend lays them out. */
export function widgetInputs(node) {
  return node.inputs.filter((input) => input.kind === 'widget')
}

/** The link inputs of a node (what a wire may target). */
export function linkInputs(node) {
  return node.inputs.filter((input) => input.kind === 'link')
}

/** The outputs of a node, as `name -> slot index` plus the slot table. */
export function outputSlot(node, nameOrIndex) {
  if (typeof nameOrIndex === 'number') {
    return Number.isInteger(nameOrIndex) && nameOrIndex >= 0 && nameOrIndex < node.outputs.length ? nameOrIndex : -1
  }
  const wanted = String(nameOrIndex)
  const exact = node.outputs.findIndex((output) => output.name === wanted)
  if (exact !== -1) return exact
  const insensitive = node.outputs.findIndex((output) => output.name.toLowerCase() === wanted.toLowerCase())
  return insensitive
}
