/**
 * dsh-comfyui — a project on disk, and the build that turns it into files
 * ComfyUI consumes.
 *
 * A PROJECT IS A FOLDER. `project.json` is the source of truth and is the only
 * file a person edits; `workflow.json`, `prompt.json`, `README.md` and
 * `build.json` are GENERATED and say so at the top. That split is the whole
 * point: a generated canvas is not hand-editable (its `widgets_values` is an
 * unnamed positional array), so keeping it as the source would mean every edit
 * is a counting exercise - while keeping the spec as the source means the
 * canvas can always be regenerated from something readable.
 *
 * `build.json` is the receipt: which spec bytes were compiled, against WHICH
 * catalog, when, with which findings, and which rung of the ladder was reached.
 * A question about a workflow somebody was handed is answerable from the
 * folder, the same way `dsh-research`'s build record answers it for a document.
 *
 * TWO DIALECTS, because a person has two ways in:
 *   - spec-driven: `project.json` holds `nodes`, `bindings`, `requires`, and
 *     every build rewrites the canvas;
 *   - workflow-driven: `comfy_project` action=import copied a workflow the app
 *     saved, `project.json` records `source: "workflow"`, and a build derives
 *     `prompt.json` from `workflow.json` WITHOUT touching the canvas - the file
 *     the app wrote stays the file the app reads.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ComfyError } from './errors.js'
import { compileProject, describeCatalog } from './compile.js'
import { outputsOf, parseWorkflow, validatePrompt, workflowToPrompt } from './graph.js'
import { checkPromptFiles } from './files.js'
import { readSpec, slugify, summarizeFindings } from './spec.js'

/** The environment variable that moves where projects live. */
export const ROOT_ENV = 'DSH_COMFYUI_ROOT'

/** The ladder, in order. Every answer names the rung it reached, never more. */
export const RUNGS = ['v1-structural', 'v2-schema', 'v3-queued', 'v4-executed']

/** The file names every project folder uses. */
export const FILES = { spec: 'project.json', workflow: 'workflow.json', prompt: 'prompt.json', readme: 'README.md', build: 'build.json' }

/** The schema of `build.json`; a reader can tell an old receipt from a new one. */
export const BUILD_SCHEMA = 1

/** Where projects live: the workspace by default, so the agent can edit them. */
export function projectsRoot(env = process.env, cwd = process.cwd()) {
  const fromEnv = env[ROOT_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(cwd || process.cwd(), fromEnv.trim())
  return path.join(cwd || process.cwd(), 'comfyui')
}

/** One project's folder. */
export function projectDir(root, slug) {
  return path.join(root, slug)
}

/** The five paths of one project. */
export function projectPaths(root, slug) {
  const dir = projectDir(root, slug)
  return {
    dir,
    spec: path.join(dir, FILES.spec),
    workflow: path.join(dir, FILES.workflow),
    prompt: path.join(dir, FILES.prompt),
    readme: path.join(dir, FILES.readme),
    build: path.join(dir, FILES.build),
  }
}

/** A JSON file, or null when it is absent or unreadable. */
export function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ComfyError('BAD_JSON', file + ' is not readable JSON: ' + error.message, { path: file })
  }
}

/** Write a JSON file through a temporary name, so a reader never sees half of one. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temporary, file)
  return file
}

/** Write a text file the same way. */
export function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.tmp'
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
  return file
}

/** The sha256 of a buffer, as the build receipt records it. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Every project in a root, newest build first.
 *
 * A folder with no `project.json` is not a project and is skipped silently: a
 * person's `comfyui/` folder may hold output images too.
 */
export function listProjects(root) {
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const paths = projectPaths(root, entry.name)
    if (!existsSync(paths.spec)) continue
    let manifest = null
    let error = ''
    try {
      manifest = readJson(paths.spec)
    } catch (err) {
      error = err.message
    }
    const build = existsSync(paths.build) ? readJson(paths.build) : null
    found.push({
      slug: entry.name,
      title: manifest !== null && typeof manifest.title === 'string' && manifest.title !== '' ? manifest.title : entry.name,
      source: manifest !== null && typeof manifest.source === 'string' ? manifest.source : 'spec',
      nodes: manifest !== null && Array.isArray(manifest.nodes) ? manifest.nodes.length : 0,
      built: existsSync(paths.prompt) && existsSync(paths.workflow),
      build: build === null
        ? null
        : {
            at: typeof build.builtAt === 'string' ? build.builtAt : '',
            ok: build.ok === true,
            rung: typeof build.rung === 'string' ? build.rung : '',
            errors: build.counts !== null && typeof build.counts === 'object' ? build.counts.errors : null,
          },
      error,
    })
  }
  return found.sort((left, right) => {
    const leftAt = left.build === null ? '' : left.build.at
    const rightAt = right.build === null ? '' : right.build.at
    if (leftAt !== rightAt) return String(rightAt).localeCompare(String(leftAt))
    return left.slug.localeCompare(right.slug)
  })
}

/**
 * The rung a compile-only pass reached.
 *
 * It is the ONLY honest answer to "did it work": without a server a graph can
 * be structurally sound and still name a checkpoint that is not on this
 * machine, and the two are not the same claim.
 */
export function compileRung(findings, catalog) {
  const errors = findings.filter((entry) => entry.severity === 'error').length
  if (errors > 0) return 'v0-failed'
  return catalog !== null && catalog.complete === true ? 'v2-schema' : 'v1-structural'
}

/**
 * Compile one spec-driven project and write its four generated files.
 *
 * @param options - `{ root, slug, catalog, controlAfterGenerate, now, dryRun }`.
 * @returns a report: `{ ok, rung, findings, files, prompt, workflow, counts, catalog }`.
 */
export function buildProject(options) {
  const paths = projectPaths(options.root, options.slug)
  const raw = readJson(paths.spec)
  if (raw === null) throw new ComfyError('NO_PROJECT', 'no ' + FILES.spec + ' in ' + paths.dir + '. `comfy_project` action=new writes one.', { path: paths.dir })
  return buildFromSpec({ raw, paths, catalog: options.catalog, controlAfterGenerate: options.controlAfterGenerate, now: options.now, dryRun: options.dryRun === true })
}

/** The spec-driven half of `buildProject`, split out so the check can drive it. */
export function buildFromSpec({ raw, paths, catalog, controlAfterGenerate, now, dryRun, install }) {
  const specText = JSON.stringify(raw ?? {}, null, 2)
  if (raw !== null && typeof raw === 'object' && raw.source === 'workflow') {
    return buildFromWorkflowFile({ raw, paths, catalog, now, dryRun, install })
  }
  if (raw !== null && typeof raw === 'object' && raw.source === 'prompt') {
    return buildFromPromptFile({ raw, paths, catalog, now, dryRun, install })
  }
  const { project, findings } = readSpec(raw, catalog)
  const compiled = compileProject(project, catalog, { controlAfterGenerate })
  findings.push(...compiled.findings)
  const validated = validatePrompt(compiled.prompt, catalog)
  findings.push(...validated.findings)
  // The install's own files: the check nobody else could make without a server.
  // It runs on the COMPILED prompt, where `@bindings` are already filenames.
  const files = checkPromptFiles({ prompt: compiled.prompt, catalog, install, requires: project.requires })
  findings.push(...files.findings)
  const errors = findings.filter((entry) => entry.severity === 'error')
  const rung = compileRung(findings, catalog)
  const report = {
    ok: errors.length === 0,
    rung,
    findings,
    prompt: compiled.prompt,
    workflow: compiled.workflow,
    widgetOrder: compiled.widgetOrder,
    files: {},
    fileCheck: { checked: files.checked.length, missing: files.missing, roots: files.roots, skipped: files.skipped },
    counts: { nodes: project.nodes.length, links: compiled.workflow.links.length, errors: errors.length, warnings: findings.filter((entry) => entry.severity === 'warning').length },
    catalog: { source: catalog.source, version: catalog.version, origin: catalog.origin, complete: catalog.complete === true, described: describeCatalog(catalog) },
  }
  if (dryRun === true) return report
  const builtAt = typeof now === 'function' ? now() : new Date().toISOString()
  report.files.workflow = writeJson(paths.workflow, compiled.workflow)
  report.files.prompt = writeJson(paths.prompt, compiled.prompt)
  report.files.build = writeJson(paths.build, {
    schema: BUILD_SCHEMA,
    project: project.name,
    source: 'spec',
    builtAt,
    specSha256: sha256(specText),
    catalog: report.catalog,
    widgetOrder: compiled.widgetOrder,
    rung,
    ok: report.ok,
    counts: report.counts,
    fileCheck: report.fileCheck,
    findings: findings.slice(0, 200),
    files: { workflow: FILES.workflow, prompt: FILES.prompt },
    note: 'workflow.json and prompt.json are GENERATED from project.json by dsh-comfyui. Edit the spec, then build again - editing the canvas loses the edit on the next build.',
  })
  report.files.readme = writeText(paths.readme, readmeFor({ project, report, manifest: raw }))
  return report
}

/** The workflow-driven half: a canvas the app wrote, whose prompt is derived. */
function buildFromWorkflowFile({ raw, paths, catalog, now, dryRun, install }) {
  const findings = []
  if (!existsSync(paths.workflow)) {
    throw new ComfyError('NO_WORKFLOW', 'this project is source "workflow" but ' + paths.workflow + ' is gone. Re-import it with `comfy_project` action=import.', { path: paths.workflow })
  }
  const workflowRaw = readJson(paths.workflow)
  const parsed = parseWorkflow(workflowRaw)
  findings.push(...parsed.findings)
  let prompt = {}
  try {
    const derived = workflowToPrompt(parsed, catalog)
    prompt = derived.prompt
    findings.push(...derived.findings)
  } catch (error) {
    if (!(error instanceof ComfyError)) throw error
    findings.push({ severity: 'error', type: error.code, message: error.message })
  }
  const validated = Object.keys(prompt).length === 0 ? { findings: [], nodeErrors: {} } : validatePrompt(prompt, catalog)
  findings.push(...validated.findings)
  const fileCheck = checkPromptFiles({ prompt, catalog, install })
  findings.push(...fileCheck.findings)
  const errors = findings.filter((entry) => entry.severity === 'error')
  const report = {
    ok: errors.length === 0,
    rung: compileRung(findings, catalog),
    findings,
    prompt,
    workflow: workflowRaw,
    widgetOrder: 'workflow-file',
    files: {},
    fileCheck: { checked: fileCheck.checked.length, missing: fileCheck.missing, roots: fileCheck.roots, skipped: fileCheck.skipped },
    counts: { nodes: parsed.nodes.length, links: parsed.links.length, errors: errors.length, warnings: findings.filter((entry) => entry.severity === 'warning').length },
    catalog: { source: catalog.source, version: catalog.version, origin: catalog.origin, complete: catalog.complete === true, described: describeCatalog(catalog) },
  }
  if (dryRun === true) return report
  const builtAt = typeof now === 'function' ? now() : new Date().toISOString()
  if (Object.keys(prompt).length > 0) report.files.prompt = writeJson(paths.prompt, prompt)
  report.files.build = writeJson(paths.build, {
    schema: BUILD_SCHEMA,
    project: typeof raw.name === 'string' ? raw.name : path.basename(paths.dir),
    source: 'workflow',
    builtAt,
    workflowSha256: sha256(JSON.stringify(workflowRaw)),
    catalog: report.catalog,
    widgetOrder: 'workflow-file',
    rung: report.rung,
    ok: report.ok,
    counts: report.counts,
    findings: findings.slice(0, 200),
    files: { workflow: FILES.workflow, prompt: FILES.prompt },
    note: 'workflow.json was written by ComfyUI and is NOT regenerated: prompt.json is derived from it on every build.',
  })
  report.files.readme = writeText(paths.readme, readmeForWorkflow({ raw, report, parsed }))
  return report
}

/** A generated README: what this is, how to open it, what it needs, what was checked. */
export function readmeFor({ project, report, manifest }) {
  const lines = []
  lines.push('# ' + project.title)
  lines.push('')
  lines.push('<!-- GENERATED by dsh-comfyui from project.json. Edit the spec, then rebuild. -->')
  lines.push('')
  if (project.description !== '') {
    lines.push(project.description)
    lines.push('')
  }
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push('| project | `' + project.name + '` |')
  lines.push('| nodes | ' + report.counts.nodes + ' |')
  lines.push('| links | ' + report.counts.links + ' |')
  lines.push('| built | ' + report.rung + ' · ' + (report.ok ? 'no errors' : report.counts.errors + ' error(s)') + ' |')
  lines.push('| catalog | ' + report.catalog.described + ' |')
  lines.push('')
  lines.push('## Open it')
  lines.push('')
  lines.push('Drag `workflow.json` onto the ComfyUI canvas. The canvas is generated from `project.json`; a change made in the app is lost on the next build, so change the spec instead.')
  lines.push('')
  lines.push('## Run it')
  lines.push('')
  lines.push('```')
  lines.push('comfy_run  project=' + project.name)
  lines.push('```')
  lines.push('')
  lines.push('`comfy_run` queues `prompt.json` on the server, waits for `/history`, and reports the files it wrote. `comfy_validate` runs the same checks without queueing anything.')
  lines.push('')
  const models = Object.entries(project.requires.models ?? {})
  const inputs = project.requires.inputFiles ?? []
  if (models.length > 0 || inputs.length > 0) {
    lines.push('## What it needs')
    lines.push('')
    for (const [folder, list] of models) {
      for (const name of list) lines.push('- `models/' + folder + '/' + name + '`')
    }
    for (const name of inputs) lines.push('- `input/' + name + '`')
    lines.push('')
    lines.push('A file that is not there is reported by `comfy_validate` by name; nothing here downloads one.')
    lines.push('')
  }
  lines.push('## The graph')
  lines.push('')
  lines.push('| key | class | title |')
  lines.push('|---|---|---|')
  for (const node of project.nodes) {
    lines.push('| `' + node.key + '` | `' + node.class + '` | ' + node.title + ' |')
  }
  lines.push('')
  if (Object.keys(project.bindings).length > 0) {
    lines.push('## Bindings')
    lines.push('')
    lines.push('| name | value |')
    lines.push('|---|---|')
    for (const [name, value] of Object.entries(project.bindings)) lines.push('| `@' + name + '` | ' + ('`' + String(value) + '`') + ' |')
    lines.push('')
  }
  const errors = report.findings.filter((entry) => entry.severity === 'error')
  const warnings = report.findings.filter((entry) => entry.severity === 'warning')
  if (report.findings.length > 0) {
    lines.push('## Findings from the build')
    lines.push('')
    for (const entry of [...errors, ...warnings]) lines.push('- **' + entry.severity + '** `' + entry.type + '` — ' + entry.message)
    lines.push('')
  }
  if (manifest !== null && typeof manifest.notes === 'string' && manifest.notes !== '') {
    lines.push('## Notes')
    lines.push('')
    lines.push(manifest.notes)
    lines.push('')
  }
  return lines.join('\n')
}

/** The prompt-driven half: an imported API prompt is already the truth. */
function buildFromPromptFile({ raw, paths, catalog, now, dryRun, install }) {
  if (!existsSync(paths.prompt)) {
    throw new ComfyError('NO_PROMPT', 'this project is source "prompt" but ' + paths.prompt + ' is gone. Re-import it with `comfy_project` action=import.', { path: paths.prompt })
  }
  const prompt = readJson(paths.prompt)
  const validated = validatePrompt(prompt, catalog)
  const findings = [...validated.findings]
  const files = checkPromptFiles({ prompt, catalog, install })
  findings.push(...files.findings)
  const errors = findings.filter((entry) => entry.severity === 'error')
  const report = {
    ok: errors.length === 0,
    rung: compileRung(findings, catalog),
    findings,
    prompt,
    workflow: null,
    widgetOrder: 'prompt-file',
    fileCheck: { checked: files.checked.length, missing: files.missing, roots: files.roots, skipped: files.skipped },
    counts: { nodes: Object.keys(prompt ?? {}).length, links: 0, errors: errors.length, warnings: findings.filter((entry) => entry.severity === 'warning').length },
    catalog: { source: catalog.source, version: catalog.version, origin: catalog.origin, complete: catalog.complete === true, described: describeCatalog(catalog) },
    files: {},
  }
  if (dryRun === true) return report
  const builtAt = typeof now === 'function' ? now() : new Date().toISOString()
  report.files.build = writeJson(paths.build, {
    schema: BUILD_SCHEMA,
    project: typeof raw.name === 'string' ? raw.name : path.basename(paths.dir),
    source: 'prompt',
    builtAt,
    promptSha256: sha256(JSON.stringify(prompt)),
    catalog: report.catalog,
    widgetOrder: 'prompt-file',
    rung: report.rung,
    ok: report.ok,
    counts: report.counts,
    findings: findings.slice(0, 200),
    files: { prompt: FILES.prompt },
    note: 'this project came in as an API prompt: prompt.json is the source and no canvas exists for it.',
  })
  report.files.readme = writeText(
    paths.readme,
    [
      '# ' + (typeof raw.title === 'string' && raw.title !== '' ? raw.title : path.basename(paths.dir)),
      '',
      '<!-- GENERATED by dsh-comfyui. prompt.json is the SOURCE here: it was imported as an API prompt and is never rewritten. -->',
      '',
      typeof raw.description === 'string' && raw.description !== '' ? raw.description : 'An API prompt imported with `comfy_project` action=import.',
      '',
      '| | |',
      '|---|---|',
      '| project | `' + path.basename(paths.dir) + '` |',
      '| nodes | ' + report.counts.nodes + ' |',
      '| rung | ' + report.rung + ' · ' + (report.ok ? 'no errors' : report.counts.errors + ' error(s)') + ' |',
      '| catalog | ' + report.catalog.described + ' |',
      '',
      'An API prompt has no canvas: there is nothing to drag into the app, and no `workflow.json` here.',
      'Run it with `comfy_run project=' + path.basename(paths.dir) + '`.',
      findings.length === 0 ? '' : '',
      ...findings.filter((entry) => entry.severity === 'error').map((entry) => '- **error** `' + entry.type + '` — ' + entry.message),
    ].join('\n'),
  )
  return report
}

/** The same README for a project whose source is the canvas. */
export function readmeForWorkflow({ raw, report, parsed }) {
  const name = typeof raw.name === 'string' ? raw.name : 'project'
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : name
  const lines = []
  lines.push('# ' + title)
  lines.push('')
  lines.push('<!-- GENERATED by dsh-comfyui. workflow.json is the SOURCE here: it came out of ComfyUI and is never rewritten. -->')
  lines.push('')
  if (typeof raw.description === 'string' && raw.description !== '') {
    lines.push(raw.description)
    lines.push('')
  }
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push('| project | `' + name + '` |')
  lines.push('| nodes | ' + parsed.nodes.length + ' |')
  lines.push('| links | ' + parsed.links.length + ' |')
  lines.push('| prompt | ' + report.rung + ' · ' + (report.ok ? 'derived' : report.counts.errors + ' error(s)') + ' |')
  lines.push('| catalog | ' + report.catalog.described + ' |')
  lines.push('')
  lines.push('## Open it')
  lines.push('')
  lines.push('`workflow.json` IS the file the app saved: drag it onto the canvas to edit it there, then save it back into this folder and rebuild so `prompt.json` follows.')
  lines.push('')
  lines.push('## Run it')
  lines.push('')
  lines.push('```')
  lines.push('comfy_run  project=' + name)
  lines.push('```')
  lines.push('')
  lines.push('`comfy_run` queues `prompt.json`, which is DERIVED from the canvas - `widgets_values` is an unnamed array, so the derivation needs the server\'s node catalog and is redone on every build.')
  lines.push('')
  const errors = report.findings.filter((entry) => entry.severity === 'error')
  const warnings = report.findings.filter((entry) => entry.severity === 'warning')
  if (report.findings.length > 0) {
    lines.push('## Findings from the build')
    lines.push('')
    for (const entry of [...errors, ...warnings]) lines.push('- **' + entry.severity + '** `' + entry.type + '` — ' + entry.message)
    lines.push('')
  }
  return lines.join('\n')
}

/** Write a new project folder from a spec object. An existing folder is refused. */
export function createProject({ root, spec, overwrite = false }) {
  const slug = slugify(spec.name ?? '')
  if (slug === '') throw new ComfyError('BAD_NAME', 'a project needs a name (lower case, digits and dashes).')
  const paths = projectPaths(root, slug)
  if (existsSync(paths.spec) && overwrite !== true) {
    throw new ComfyError('PROJECT_EXISTS', 'a project called "' + slug + '" is already at ' + paths.dir + '. Pass overwrite:true to replace its project.json, or pick another name.', { path: paths.dir })
  }
  mkdirSync(paths.dir, { recursive: true })
  const clean = { ...spec, name: slug }
  writeJson(paths.spec, clean)
  return { slug, paths, spec: clean }
}

/**
 * Import a workflow or an API prompt the app produced.
 *
 * A prompt (`{ id: { class_type, inputs } }`) needs nothing but a folder and a
 * `prompt.json`; a canvas needs the catalog to be lowered, and says so when the
 * catalog in force is the built-in table rather than a server's.
 *
 * @returns `{ slug, paths, kind, report }`.
 */
export function importProject({ root, name, source, catalog, now }) {
  const slug = slugify(name ?? 'imported-workflow')
  if (slug === '') throw new ComfyError('BAD_NAME', 'give the imported project a name.')
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new ComfyError('IMPORT_INVALID', 'that file is not a workflow or a prompt; both are JSON objects.')
  }
  const looksLikePrompt = Object.values(source).length > 0 && Object.values(source).every((value) => value !== null && typeof value === 'object' && typeof value.class_type === 'string')
  const paths = projectPaths(root, slug)
  mkdirSync(paths.dir, { recursive: true })
  if (looksLikePrompt) {
    writeJson(paths.prompt, source)
    writeJson(paths.spec, {
      name: slug,
      title: slug,
      description: 'Imported API prompt. A prompt has no canvas, so there is no workflow.json here.',
      source: 'prompt',
      importedAt: typeof now === 'function' ? now() : new Date().toISOString(),
      nodes: [],
    })
    const validated = validatePrompt(source, catalog)
    return {
      slug,
      paths,
      kind: 'prompt',
      report: { ok: validated.findings.every((entry) => entry.severity !== 'error'), rung: compileRung(validated.findings, catalog), findings: validated.findings, prompt: source, workflow: null, counts: { nodes: Object.keys(source).length, links: 0, errors: validated.findings.filter((entry) => entry.severity === 'error').length, warnings: validated.findings.filter((entry) => entry.severity === 'warning').length } },
    }
  }
  const parsed = parseWorkflow(source)
  writeJson(paths.workflow, source)
  writeJson(paths.spec, {
    name: slug,
    title: typeof source.title === 'string' && source.title !== '' ? source.title : slug,
    description: 'Imported from a ComfyUI canvas: workflow.json is the source, prompt.json is derived from it.',
    source: 'workflow',
    importedAt: typeof now === 'function' ? now() : new Date().toISOString(),
    nodes: [],
  })
  const report = buildFromWorkflowFile({ raw: readJson(paths.spec), paths, catalog, now, dryRun: false })
  return { slug, paths, kind: 'workflow', report }
}

/** The spec text one project holds, or '' when there is none. */
export function specTextOf(paths) {
  return existsSync(paths.spec) ? readFileSync(paths.spec, 'utf8') : ''
}

/** A one-line summary of a report, for a tool's prose. */
export function reportLine(report) {
  const summary = summarizeFindings(report.findings)
  return report.rung + (summary === '' ? '' : ' · ' + summary)
}

/** The classes in a workflow, for a status answer. */
export function classesInWorkflow(workflow) {
  const nodes = workflow !== null && typeof workflow === 'object' && Array.isArray(workflow.nodes) ? workflow.nodes : []
  return [...new Set(nodes.map((node) => String(node.type)))].sort()
}

/** Every output file a finished history entry lists, plus its node titles. */
export function describeOutputs(entry, prompt) {
  const files = outputsOf(entry)
  const titles = new Map()
  for (const [id, node] of Object.entries(prompt ?? {})) {
    const meta = node !== null && typeof node === 'object' && node._meta !== null && typeof node._meta === 'object' ? node._meta : {}
    titles.set(String(id), typeof meta.title === 'string' ? meta.title : typeof node.class_type === 'string' ? node.class_type : id)
  }
  return files.map((file) => ({ ...file, nodeTitle: titles.get(String(file.node)) ?? file.node }))
}
