/**
 * dsh-comfyui — "does this machine actually HAVE the files this graph names?"
 *
 * THE QUESTION NOBODY ELSE ANSWERS. With a server running, `/object_info`
 * answers it: a combo's options ARE the filenames in that folder, so a missing
 * checkpoint comes back as `value_not_in_list` from ComfyUI's own validator. With
 * no server, nothing did - a project compiled, validated, and reported a clean
 * `v1-structural` while naming a 2 GB checkpoint that is not on the disk.
 *
 * So this module reads the INSTALL instead of the server: the base path
 * `comfy_status` found, `models/<folder>/`, `input/`, and any extra model root
 * comfy-cli reports. It checks an API PROMPT - the compiled one, with its
 * `@bindings` already resolved - because a spec's raw `"@checkpoint"` is not a
 * filename and checking it would report a missing file called "@checkpoint".
 *
 * It runs ONLY for a file input whose option list the catalog did not know (a
 * complete catalog means the server already answered, and a second opinion from
 * the filesystem could disagree with a folder path the server resolves
 * differently).
 *
 * The finding keeps ComfyUI's own type, `value_not_in_list`, because that is the
 * sentence `/prompt` would return for the same file - and it carries the two
 * things a person needs: how many files ARE in that folder, and the nearest name
 * to the one the graph wants. `v1-structural` on a machine whose models happen to
 * be there is a real claim; without this check it was a claim nobody had made.
 */

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { FILE_INPUTS } from './nodes.js'

/** The folders a file input can come from, as the ComfyUI base path names them. */
export function folderOf(inputName) {
  return FILE_INPUTS[inputName] ?? null
}

/** Every file in one folder, relative and slash-separated, bounded in depth. */
export function filesIn(dir, options = {}) {
  const files = []
  const depthLimit = Number.isInteger(options.depth) ? options.depth : 2
  const extensions = options.extensions ?? null
  if (!existsSync(dir)) return files
  const walk = (current, prefix, depth) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        if (depth < depthLimit) walk(path.join(current, entry.name), relative, depth + 1)
        continue
      }
      if (extensions !== null && !extensions.test(entry.name)) continue
      files.push(relative)
    }
  }
  walk(dir, '', 0)
  return files.sort()
}

/** The extensions ComfyUI's own loaders accept, so a stray .txt is not a candidate. */
const MODEL_EXTENSIONS = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i

/** The extensions an `input/` file may have. */
const INPUT_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|mp4|webm|mov|mkv|wav|mp3|flac|ogg|m4a|aiff?)$/i

/**
 * The nearest names to one that was asked for, so a typo is visible.
 *
 * Not a Levenshtein table: a person's mistake is almost always a wrong folder, a
 * different version string, or a dropped path prefix, and those show up as a
 * shared stem. Three candidates, no more - the finding is a pointer, not a list.
 */
export function nearestNames(wanted, candidates, limit = 3) {
  const target = String(wanted).toLowerCase()
  const stem = target.replace(/\.[^.]+$/, '')
  const scored = []
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const otherStem = lower.replace(/\.[^.]+$/, '')
    let score = 0
    if (lower === target) score = 100
    else if (otherStem === stem) score = 90
    else if (otherStem.startsWith(stem) || stem.startsWith(otherStem)) score = 70
    else if (otherStem.includes(stem) || stem.includes(otherStem)) score = 50
    else if (lower.includes(target)) score = 30
    if (score > 0) scored.push({ candidate, score })
  }
  scored.sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
  const picked = scored.slice(0, limit).map((entry) => entry.candidate)
  if (picked.length > 0) return picked
  return candidates.slice(0, limit)
}

/**
 * A checker bound to one install: `check(folder, name, where)` records a finding
 * or nothing, and remembers what it looked at.
 */
function makeChecker(install) {
  const findings = []
  const checked = []
  const roots = []
  const base = install.base
  // A Desktop install can keep its models in a shared folder beside the app
  // (comfy-cli reports those as `model_roots`): they are searched too, so a file
  // that IS on the machine is never reported missing.
  const extraRoots = Array.isArray(install.modelRoots) ? install.modelRoots.filter((root) => typeof root === 'string' && root !== '') : []
  const seen = new Set()
  const check = (folder, declared, where) => {
    if (typeof declared !== 'string' || declared === '') return
    const key = folder + '/' + declared
    if (seen.has(key)) return
    seen.add(key)
    const primary = folder === 'input' ? path.join(base, 'input') : path.join(base, 'models', folder)
    const extras = folder === 'input' ? [] : extraRoots.map((root) => path.join(root, folder)).filter((dir) => dir !== primary)
    const dirs = [primary, ...extras].filter((dir) => existsSync(dir))
    const extensions = folder === 'input' ? INPUT_EXTENSIONS : MODEL_EXTENSIONS
    if (dirs.length === 0) {
      findings.push({
        severity: 'warning',
        type: 'model_folder_absent',
        message: 'the graph needs "' + declared + '" from ' + (folder === 'input' ? 'input/' : 'models/' + folder + '/') + ', and that folder does not exist under ' + base + '. Nothing can be checked about the file until it does.',
        ...where,
      })
      return
    }
    for (const dir of dirs) if (!roots.includes(dir)) roots.push(dir)
    checked.push({ folder, declared })
    for (const dir of dirs) if (existsSync(path.join(dir, declared))) return
    const candidates = []
    for (const dir of dirs) candidates.push(...filesIn(dir, { extensions, depth: 2 }))
    const nearest = nearestNames(declared, candidates)
    const count = candidates.length
    findings.push({
      severity: 'error',
      type: 'value_not_in_list',
      message:
        (folder === 'input' ? 'input/' + declared : 'models/' + folder + '/' + declared) +
        ' does not exist on this machine (' +
        (count === 0 ? 'that folder is empty' : count + ' file(s) there') +
        (nearest.length === 0 ? '' : '; nearest: ' + nearest.join(', ')) +
        '). ComfyUI refuses a prompt naming a file it does not have with value_not_in_list, so this graph cannot run yet. Put the file in that folder, or point the binding at one of the names above.',
      path: path.join(primary, declared),
      searched: dirs,
      ...where,
    })
  }
  return { check, findings, checked, roots }
}

/** The answer when there is no install to check against. */
function noInstall() {
  return { findings: [], checked: [], missing: 0, roots: [], skipped: 'no ComfyUI base path with models/ and input/ was found, so no file could be checked' }
}

/**
 * Check an API prompt's file-named inputs, and anything the spec declares.
 *
 * @param options - `{ prompt, catalog, install, requires }`.
 * @returns `{ findings, checked, missing, roots, skipped }`.
 */
export function checkPromptFiles(options) {
  const install = options.install ?? null
  const catalog = options.catalog ?? null
  const prompt = options.prompt !== null && typeof options.prompt === 'object' ? options.prompt : {}
  const requires = options.requires !== null && typeof options.requires === 'object' ? options.requires : null
  if (install === null || typeof install.base !== 'string' || install.base === '') return noInstall()
  const checker = makeChecker(install)

  for (const [nodeId, node] of Object.entries(prompt)) {
    if (node === null || typeof node !== 'object' || typeof node.class_type !== 'string') continue
    const inputs = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {}
    for (const [inputName, value] of Object.entries(inputs)) {
      if (Array.isArray(value) || value === null || typeof value === 'object') continue
      const folder = folderForNode(catalog, node.class_type, inputName)
      if (folder === null || folder.fromCatalog === true) continue
      if (typeof value !== 'string') continue
      checker.check(folder.folder, value, { node: nodeId, input: inputName })
    }
  }

  // What the spec DECLARES it needs, even when no node in it names the file.
  if (requires !== null) {
    for (const [folder, list] of Object.entries(requires.models ?? {})) {
      if (!Array.isArray(list)) continue
      for (const name of list) checker.check(folder, name, { declared: true })
    }
    for (const name of Array.isArray(requires.inputFiles) ? requires.inputFiles : []) checker.check('input', name, { declared: true })
  }

  return { findings: checker.findings, checked: checker.checked, missing: checker.findings.filter((entry) => entry.severity === 'error').length, roots: checker.roots, skipped: '' }
}

/** Which folder one input reads from, and whether the catalog already answered it. */
function folderForNode(catalog, classType, inputName) {
  const spec = catalog === null ? null : catalog.nodes.get(classType) ?? null
  const inputSpec = spec === null ? null : spec.inputs.find((input) => input.name === inputName) ?? null
  if (inputSpec !== null && inputSpec.enum !== null) return { folder: '', fromCatalog: true }
  const folder = inputSpec !== null && inputSpec.fileFolder !== null ? inputSpec.fileFolder : folderOf(inputName)
  if (folder === null) return null
  return { folder, fromCatalog: false }
}

/**
 * The install's own inventory, for `comfy_status`: what each folder holds, with
 * the first few names, so a reader can see a checkpoint is there without asking
 * for it.
 */
export function inventory(install, options = {}) {
  if (install === null || typeof install.base !== 'string' || install.base === '') return { folders: {}, files: 0, roots: [] }
  const perFolder = Number.isInteger(options.perFolder) ? options.perFolder : 4
  const folders = {}
  let files = 0
  const modelsDir = path.join(install.base, 'models')
  if (existsSync(modelsDir)) {
    let entries = []
    try {
      entries = readdirSync(modelsDir, { withFileTypes: true })
    } catch (error) {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const names = filesIn(path.join(modelsDir, entry.name), { extensions: MODEL_EXTENSIONS, depth: 2 })
      folders[entry.name] = { count: names.length, first: names.slice(0, perFolder) }
      files += names.length
    }
  }
  const inputDir = path.join(install.base, 'input')
  if (existsSync(inputDir)) {
    const names = filesIn(inputDir, { extensions: INPUT_EXTENSIONS, depth: 1 })
    folders.input = { count: names.length, first: names.slice(0, perFolder) }
  }
  const roots = [modelsDir, inputDir].filter((dir) => existsSync(dir))
  return { folders, files, roots }
}
