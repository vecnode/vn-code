/**
 * dsh-comfyui — the six tools, and the prose that is the product.
 *
 * Every answer is written for the reader that has to decide what to do next, so
 * each one carries its CONDITIONS with its facts:
 *
 *   - `comfy_status` keeps four things apart that fail independently: an install
 *     on disk, a server answering on loopback, a node catalog, and an
 *     interpreter. It starts nothing and names the ports it tried;
 *   - `comfy_nodes` answers from the catalog IN FORCE and says which that is
 *     (`/object_info`, a cached catalog, or the built-in core table);
 *   - `comfy_project` writes a folder; `new` rebinds a template to the models
 *     this machine actually has, and says every rebinding it made;
 *   - `comfy_validate` runs ComfyUI's own checks offline and names the rung it
 *     reached, so "it compiles" is never printed as "it runs";
 *   - `comfy_run` is the only tool that queues work, and reports what the
 *     server's `/history` says came out - or the node that raised;
 *   - `comfy_test` is the ladder over the whole shipped library: compile always,
 *     run when a server answers, one rung per item.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { ComfyError, messageOf } from './errors.js'
import { findServer, fetchObjectInfo, writeCache, readCache, listCache, discoverInstall, queuePrompt, waitForHistory, formatMilliseconds, formatBytes } from './client.js'
import { cliCommand, cliVersion, cliJson, envFacts, whichFacts, depsArgv, runArgv, launchArgv, stopArgv, promptIdFromRunText, explainCliFailure, READ_TIMEOUT_MS, RUN_TIMEOUT_MS } from './cli.js'
import { coreCatalog, catalogFromObjectInfo, categoriesIn, searchCatalog, nodeIn, widgetInputs, SOURCES } from './nodes.js'
import { inventory } from './files.js'
import { slugify } from './spec.js'
import { describeCatalog, CONTROL_AFTER_GENERATE } from './compile.js'
import { validatePrompt, parseWorkflow, workflowToPrompt, findingsFromNodeErrors, errorsOf, errorSentenceFromResponse, outputsOf } from './graph.js'
import { buildFromSpec, createProject, importProject, listProjects, projectPaths, projectsRoot, readJson, RUNGS, FILES, describeOutputs } from './projects.js'
import { listExamples, readExample, requirementLine } from './examples.js'

/** The output shape every tool returns: prose for the model, a view for the card. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** A card for the transcript. */
function present(title) {
  return {
    presentCall: () => ({ card: 'generic', title, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title, content: result && result.text ? result.text : '' }),
  }
}

/** A refusal: a sentence, and a view a caller can branch on. */
function refusal(code, message, extra) {
  return { text: message, view: { ok: false, code, ...(extra ?? {}) } }
}

/** The same refusal for any thrown failure, keeping a typed code when there is one. */
function failureOf(error) {
  if (error instanceof ComfyError) return refusal(error.code, error.message, { ...error.extra })
  return refusal('FAILED', messageOf(error))
}

/** Pad a column, clipping it to its width. */
function cell(value, width) {
  const text = String(value === undefined || value === null ? '' : value)
  const cut = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text
  return cut.padEnd(width)
}

/** A fixed-width table: the header line, then one line per row. */
function table(headers, rows) {
  if (rows.length === 0) return headers.join('  ')
  const widths = headers.map((header, index) => Math.min(46, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))))
  const line = (cells) => cells.map((value, index) => cell(value, widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** The workspace folder for a session, or '' when the host cannot name one. */
function workspaceOf(ctx, exec, sessionId) {
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
  if (header && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const live = sessions && typeof sessions.get === 'function' && sessionId !== '' ? sessions.get(sessionId) : undefined
    const cwd = live && live.header ? live.header.cwd : undefined
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch (error) {
    // fall through
  }
  return ''
}

/** The session id one call belongs to. */
function sessionOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  return session && typeof session.id === 'string' ? session.id : ''
}

/**
 * The catalog in force, and how it was obtained.
 *
 * Order is deliberate: a live server first (it is the only complete catalog),
 * then the newest cached one (a server that has since stopped still left the
 * truth it reported), then the built-in core table (enough to compile the
 * shipped examples on a machine where nothing is installed).
 *
 * A live read is cached, so the second call in a session costs no request.
 */
async function catalogFor(deps, options = {}) {
  const env = deps.env ?? process.env
  const found = await findServer(deps, { signal: options.signal, timeoutMs: options.probeTimeoutMs })
  if (found.server !== null) {
    try {
      const raw = await fetchObjectInfo(deps, found.server.origin, { signal: options.signal })
      const catalog = catalogFromObjectInfo(raw, { origin: found.server.origin, version: found.server.version, fetchedAt: new Date().toISOString() })
      const file = writeCache(env, found.server.origin, { schema: 1, origin: found.server.origin, version: found.server.version, fetchedAt: catalog.fetchedAt, objectInfo: raw })
      return { catalog, server: found.server, probed: found.probed, servers: found.servers, cacheFile: file, note: '' }
    } catch (error) {
      if (error instanceof ComfyError && error.code === 'TIMEOUT') {
        return { catalog: coreCatalog(), server: found.server, probed: found.probed, servers: found.servers, cacheFile: '', note: 'the server answered but /object_info timed out (' + error.message + ')' }
      }
      throw error
    }
  }
  const cached = listCache(env)
  if (cached.length > 0) {
    const record = readCache(env, cached[0].origin)
    if (record !== null) {
      const catalog = catalogFromObjectInfo(record.objectInfo, { origin: record.origin, version: record.version, fetchedAt: record.fetchedAt })
      catalog.source = SOURCES.cache
      for (const node of catalog.nodes.values()) node.source = SOURCES.cache
      return { catalog, server: null, probed: found.probed, servers: found.servers, cacheFile: cached[0].file, note: 'no server answered, so this catalog is the one cached from ' + (record.origin === '' ? 'an earlier server' : record.origin) + (record.fetchedAt === '' ? '' : ' at ' + record.fetchedAt) }
    }
  }
  return {
    catalog: coreCatalog(),
    server: null,
    probed: found.probed,
    servers: found.servers,
    cacheFile: '',
    note: found.servers.allowed ? 'no server answered and no catalog is cached, so this is the built-in core table' : found.servers.reason,
  }
}

/** Where this session's projects live. */
function rootOf(deps, exec) {
  const cwd = workspaceOf(deps.ctx, exec, sessionOf(exec))
  return projectsRoot(deps.env ?? process.env, cwd === '' ? process.cwd() : cwd)
}

/** The install on disk, with comfy-cli's own view of the workspaces when it is there. */
function installOf(deps, cliFacts = null) {
  return discoverInstall({ env: deps.env ?? process.env, platform: deps.platform, cli: cliFacts })
}

/**
 * The install, asking comfy-cli only when the cheap discovery found no base path.
 *
 * A Desktop config that points at a deleted folder is exactly the machine where
 * comfy-cli's \`env\` still knows a live install, and it is the only machine that
 * needs the extra process - everywhere else this costs nothing.
 */
async function installFor(deps) {
  const plain = installOf(deps)
  if (plain.base !== '') return plain
  const cli = await cliFactsOf(deps)
  return cli.facts === null ? plain : installOf(deps, cli.facts)
}

/**
 * The comfy-cli facts, read ONCE per call.
 *
 * `comfy env` is the only place a Desktop install's `code_dir`/`data_dir` are
 * written down, so it is worth a Python start - but it is also one process, so
 * every tool that needs it takes this result rather than asking again.
 */
async function cliFactsOf(deps, options = {}) {
  const env = deps.env ?? process.env
  if (typeof deps.runner !== 'function') return { version: { found: false, command: '', version: '', error: 'no runner' }, facts: null, which: null, envAnswer: null }
  const version = await cliVersion(deps.runner, env, { timeoutMs: options.timeoutMs ?? 8000 })
  if (!version.found) return { version, facts: null, which: null, envAnswer: null }
  const envAnswer = await cliJson(deps.runner, ['env'], { env, command: version.command, timeoutMs: READ_TIMEOUT_MS })
  const whichAnswer = await cliJson(deps.runner, ['which'], { env, command: version.command, timeoutMs: READ_TIMEOUT_MS })
  return {
    version,
    facts: envFacts(envAnswer.data),
    which: whichFacts(whichAnswer.data),
    envAnswer,
  }
}

/** Resolve a `project` argument: a slug under the root, or a path to a folder. */
function projectPathsFor(root, argument) {
  const text = String(argument ?? '').trim()
  if (text === '') return null
  const asSlug = slugify(text)
  if (asSlug !== '' && existsSync(projectPaths(root, asSlug).spec)) return projectPaths(root, asSlug)
  const resolved = path.resolve(text)
  if (existsSync(path.join(resolved, FILES.spec))) return projectPaths(path.dirname(resolved), path.basename(resolved))
  if (asSlug !== '' && existsSync(projectPaths(root, asSlug).dir)) return projectPaths(root, asSlug)
  return null
}

/** The one project a call names, or a refusal naming what is there. */
function requireProject(root, argument) {
  const paths = projectPathsFor(root, argument)
  if (paths === null) {
    const available = listProjects(root).map((entry) => entry.slug)
    throw new ComfyError('NO_PROJECT', 'no project "' + String(argument ?? '') + '" under ' + root + '. There: ' + (available.join(', ') || '(none - `comfy_project` action=new writes one, or action=list the examples)') + '.')
  }
  return paths
}

/** A findings list as a compact block: errors first, each with its type. */
function findingsBlock(findings, limit = 40) {
  const ordered = [...findings.filter((entry) => entry.severity === 'error'), ...findings.filter((entry) => entry.severity === 'warning')]
  if (ordered.length === 0) return ''
  const lines = []
  for (const entry of ordered.slice(0, limit)) {
    const where = [entry.node === undefined ? '' : 'node ' + entry.node, entry.input === undefined ? '' : 'input ' + entry.input].filter((part) => part !== '').join(' · ')
    lines.push('  ' + entry.severity.toUpperCase() + ' ' + entry.type + (where === '' ? '' : ' (' + where + ')') + ': ' + entry.message)
  }
  if (ordered.length > limit) lines.push('  … ' + (ordered.length - limit) + ' more')
  return lines.join('\n')
}

/**
 * A spec rebuilt against the models this machine actually has.
 *
 * The rule is deliberately narrow: a binding that feeds a FILE input (a
 * checkpoint, a LoRA, an input image) is replaced only when the server's own
 * list does not contain it - and then only by an exact case-insensitive match
 * or, when the list has exactly one entry, by that entry. Anything less certain
 * is left alone and reported, because silently pointing a graph at the wrong
 * checkpoint produces an image nobody asked for.
 */
export function rebindToCatalog(spec, catalog) {
  const changes = []
  const notes = []
  if (catalog === null || catalog.complete !== true) {
    notes.push('no complete catalog, so bindings were left exactly as the template declares them')
    return { spec, changes, notes }
  }
  const next = JSON.parse(JSON.stringify(spec))
  for (const node of next.nodes ?? []) {
    const nodeSpec = nodeIn(catalog, node.class)
    if (nodeSpec === null) continue
    for (const [inputName, value] of Object.entries(node.widgets ?? {})) {
      if (typeof value !== 'string' || !value.startsWith('@')) continue
      const bindingName = value.slice(1)
      if (!(bindingName in (next.bindings ?? {}))) continue
      const inputSpec = nodeSpec.inputs.find((input) => input.name === inputName)
      if (inputSpec === undefined || inputSpec.enum === null || inputSpec.enum.length === 0) continue
      const current = String(next.bindings[bindingName])
      if (inputSpec.enum.includes(current)) continue
      const insensitive = inputSpec.enum.find((option) => option.toLowerCase() === current.toLowerCase())
      const replacement = insensitive ?? (inputSpec.enum.length === 1 ? inputSpec.enum[0] : '')
      if (replacement === '') {
        notes.push(
          '@' +
            bindingName +
            ' is "' +
            current +
            '", which is not in this server\'s list for ' +
            node.class +
            '.' +
            inputName +
            ', and the list has ' +
            inputSpec.enum.length +
            ' entries so nothing was chosen: set it to one of ' +
            inputSpec.enum.slice(0, 6).join(', ') +
            (inputSpec.enum.length > 6 ? ', …' : '') +
            '.',
        )
        continue
      }
      changes.push({ binding: bindingName, from: current, to: replacement, why: inputSpec.enum.length === 1 ? 'the only file this server lists for ' + node.class + '.' + inputName : 'a case-insensitive match in this server\'s list' })
      next.bindings[bindingName] = replacement
    }
  }
  return { spec: next, changes, notes }
}

/** The sentence a machine with no server gets, naming what would start one. */
function noServerText(install, probed) {
  const lines = []
  lines.push('No ComfyUI server answered. Tried: ' + (probed.filter((entry) => !entry.up).map((entry) => entry.origin).join(', ') || '(nothing - the URL was refused)') + '.')
  if (install !== null && install.found) {
    lines.push('ComfyUI is installed here' + (install.version === '' ? '' : ' (' + install.version + ')') + (install.app === '' ? '' : ' at ' + install.app) + '.')
    lines.push('Start it: open the ComfyUI app, or run `python main.py` in that folder. ComfyUI Desktop picks a port from 8000 upwards (not 8188), which is why this row tries both.')
  } else {
    lines.push('No ComfyUI install was found either. `comfy_status` names the places this row looks and DSH_COMFYUI_DIR pins one.')
  }
  lines.push('Nothing was started. Compiling a project needs no server; queueing one does.')
  return lines.join('\n')
}

/** Build the six tools. @param deps - `{ ctx, env, fetch, now, sleep, log }`. */
export function buildTools(deps) {
  /** `comfy_status`: the four facts, kept apart. */
  const status = {
    name: 'comfy_status',
    description: [
      'Report what this machine has for ComfyUI, keeping apart four things that fail independently: an INSTALL on disk (a Desktop base path, a portable folder or a checkout - with its version, its python and how many model files each folder holds), a SERVER answering on loopback (`/system_stats`, with the device and VRAM), the NODE CATALOG in force (`/object_info` from a server, a cached one, or the built-in core table), and the projects in the workspace.',
      'Call this FIRST. ComfyUI Desktop does NOT use port 8188 - it picks 8000 upwards - so this tool tries 8188 and the Desktop ports and reports each probe. It also lists the node catalogs cached from earlier servers, which is what lets a project compile with the app closed.',
      'It never starts ComfyUI, downloads a model or writes anything except the catalog cache. Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutSeconds: { type: 'number', description: 'Deadline for a single probe: 1-60 s. Default 2.5. A server that is there answers in milliseconds.' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI status'),
    async execute(args, exec) {
      try {
        const env = deps.env ?? process.env
        // comfy-cli FIRST: its `env` names the Desktop installs and their data
        // dirs, which is how a machine whose Desktop config points at a folder
        // that is gone still gets its models found.
        const cli = await cliFactsOf(deps, { timeoutMs: 8000 })
        const install = installOf(deps, cli.facts)
        const stock = inventory(install)
        const caches = listCache(env)
        // One probe pass, one catalog read: `catalogFor` already reports what
        // every origin said, so asking it twice would double every timeout on a
        // machine where nothing answers.
        const resolved = await catalogFor(deps, { signal: exec && exec.signal, probeTimeoutMs: Number.isFinite(args.timeoutSeconds) ? Math.min(60, Math.max(1, args.timeoutSeconds)) * 1000 : undefined })
        const found = { server: resolved.server, probed: resolved.probed, servers: resolved.servers }
        const catalog = resolved
        const root = rootOf(deps, exec)
        const projects = listProjects(root)

        const lines = []
        const headline = []
        if (install.found) {
          headline.push('ComfyUI ' + (install.version === '' ? '(version unknown)' : install.version))
          if (install.app !== '') headline.push('source ' + install.app)
          if (install.base !== '') headline.push('base ' + install.base + ' (' + install.baseSource + ')')
        } else {
          headline.push('ComfyUI: no install found on this machine')
        }
        lines.push(headline.join(' · '))
        if (install.found && install.base === '') {
          lines.push('Base path: none with models/ and custom_nodes/. A model filename cannot be checked against the disk here - the server\'s own lists are the only source of truth until one exists.')
        } else if (install.base !== '') {
          const folders = Object.entries(stock.folders).filter(([, entry]) => entry.count > 0)
          lines.push('Models: ' + (folders.length === 0 ? 'no model files in ' + path.join(install.base, 'models') : stock.files + ' file(s) — ' + folders.map(([folder, entry]) => folder + ' ' + entry.count + ' (' + entry.first.slice(0, 2).join(', ') + (entry.count > 2 ? ', …' : '') + ')').join(' · ')))
          lines.push('custom_nodes: ' + (install.customNodes.length === 0 ? '(none)' : install.customNodes.length + ' (' + install.customNodes.slice(0, 8).join(', ') + (install.customNodes.length > 8 ? ', …' : '') + ')'))
        }
        if (install.python !== '') lines.push('python: ' + install.python)
        lines.push('')
        if (found.server !== null) {
          const server = found.server
          lines.push('Server: ' + server.origin + (server.version === '' ? '' : ' · ComfyUI ' + server.version))
          if (server.device !== '') lines.push('Device: ' + server.device + (server.deviceType === '' ? '' : ' (' + server.deviceType + ')') + (server.vramTotal === null ? '' : ' · ' + formatBytes(server.vramTotal) + ' VRAM total, ' + formatBytes(server.vramFree) + ' free'))
          if (server.ramTotal !== null) lines.push('RAM: ' + formatBytes(server.ramTotal) + (server.pythonVersion === '' ? '' : ' · python ' + server.pythonVersion) + (server.pytorchVersion === '' ? '' : ' · torch ' + server.pytorchVersion))
        } else {
          lines.push(noServerText(install, found.probed))
        }
        lines.push('')
        const catalogInfo = catalog.catalog
        lines.push(
          'Catalog: ' +
            (catalogInfo.source === SOURCES.server
              ? '/object_info from ' + catalogInfo.origin + ' · ' + catalogInfo.nodes.size + ' classes · also cached'
              : catalogInfo.source === SOURCES.cache
                ? 'cached (' + catalogInfo.nodes.size + ' classes' + (catalogInfo.fetchedAt === '' ? '' : ', ' + catalogInfo.fetchedAt) + ') · ' + catalog.cacheFile
                : 'built-in core table · ' + catalogInfo.nodes.size + ' classes (the nodes the shipped examples use)'),
        )
        if (catalog.note !== '') lines.push('  ' + catalog.note)
        if (caches.length > 0) lines.push('Cached catalogs: ' + caches.slice(0, 4).map((entry) => (entry.origin === '' ? entry.file : entry.origin) + (entry.version === '' ? '' : ' (' + entry.version + ')') + ' · ' + entry.classes + ' classes').join(' ; '))
        lines.push('')
        if (cli.version.found) {
          const facts = cli.facts
          const where = facts === null ? '' : facts.workspace
          const exists = facts === null ? null : facts.workspaceExists
          lines.push('comfy-cli: ' + cli.version.version + ' (' + cli.version.command + ')')
          if (where !== '') lines.push('  workspace: ' + where + (exists === true ? '' : exists === false ? ' — DOES NOT EXIST' : ''))
          if (facts !== null && facts.serverRunning !== null) lines.push('  it reports a server ' + (facts.serverRunning ? 'RUNNING' + (facts.serverUrl === '' ? '' : ' at ' + facts.serverUrl) : 'not running'))
          if (facts !== null && facts.gpu !== '') lines.push('  hardware: ' + facts.gpu + (facts.vramBytes === null ? '' : ' · ' + formatBytes(facts.vramBytes) + ' VRAM') + (facts.ramBytes === null ? '' : ' · ' + formatBytes(facts.ramBytes) + ' RAM'))
          if (facts !== null && facts.installs.length > 0) {
            lines.push('  Desktop install' + (facts.installs.length === 1 ? '' : 's') + ' it knows: ' + facts.installs.map((entry) => (entry.name === '' ? '(unnamed)' : entry.name) + (entry.exists ? '' : ' [gone]') + (entry.dataDir === '' ? '' : ' → ' + entry.dataDir)).join(' ; '))
          }
          if (facts !== null && facts.managerMode !== '') lines.push('  ComfyUI-Manager: ' + facts.managerMode + ' (needed by `comfy node deps-in-workflow`)')
          if (cli.envAnswer !== null && cli.envAnswer.ok === false && cli.envAnswer.error !== '') lines.push('  `comfy env` said: ' + cli.envAnswer.error)
        } else {
          lines.push('comfy-cli: no `comfy` on PATH' + (cli.version.error === '' ? '' : ' (' + cli.version.error + ')') + '. `pip install comfy-cli` gives this machine a second, cross-platform way to install, launch, run a workflow and resolve its node dependencies - `comfy_cli` drives it once it is there. Without it the seven HTTP tools are unaffected.')
        }
        lines.push('')
        lines.push('Projects in ' + root + ': ' + projects.length + (projects.length === 0 ? '' : ' (' + projects.filter((entry) => entry.built).length + ' built)'))
        for (const entry of projects.slice(0, 10)) lines.push('  ' + entry.slug + (entry.built ? ' · ' + (entry.build === null ? 'built' : entry.build.rung) : ' · not built') + (entry.error === '' ? '' : ' · ' + entry.error))
        if (install.notes.length > 0) {
          lines.push('')
          for (const note of install.notes) lines.push('Note: ' + note)
        }
        lines.push('')
        lines.push('Next: `comfy_nodes` to read the catalog, `comfy_project` action=new (template=<example> or spec=<JSON>) to write a project, `comfy_validate` to check one, `comfy_test` action=compile to check them all.')
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            install: { found: install.found, app: install.app, base: install.base, baseSource: install.baseSource, version: install.version, python: install.python, models: install.models, modelRoots: install.modelRoots, inventory: stock, customNodes: install.customNodes, configFile: install.configFile },
            server: found.server,
            probed: found.probed,
            servers: { explicit: found.servers.explicit, origins: found.servers.origins, allowed: found.servers.allowed },
            cli: { found: cli.version.found, command: cli.version.command, version: cli.version.version, facts: cli.facts, which: cli.which },
            catalog: { source: catalogInfo.source, classes: catalogInfo.nodes.size, origin: catalogInfo.origin, version: catalogInfo.version, fetchedAt: catalogInfo.fetchedAt, complete: catalogInfo.complete === true, file: catalog.cacheFile, described: describeCatalog(catalogInfo) },
            caches,
            projects: { root, count: projects.length, built: projects.filter((entry) => entry.built).length },
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `comfy_nodes`: the catalog in force, by category, by class, or by search. */
  const nodes = {
    name: 'comfy_nodes',
    description: [
      'Read the ComfyUI node catalog: `categories` (every category with its class count), `node` (one class\'s exact inputs and outputs - type, whether it is a WIDGET or a LINK, default/min/max and the option list a combo accepts), or `search` (by class, display name, category or description).',
      'This is the catalog a project is compiled and validated against, and every answer says WHERE it came from: a live `/object_info`, a cached catalog from an earlier server, or the built-in core table of eighteen nodes. A class the catalog does not have is not "missing" when the catalog is the core table - it is UNVERIFIED, and the difference decides whether a project can be trusted.',
      'Read-only. Use `node` before wiring an unfamiliar class: the input ORDER is what its `widgets_values` array means.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['categories', 'node', 'search'], description: 'What to answer. Default categories.' },
        node: { type: 'string', description: 'The class to describe, e.g. KSampler. Required by action=node.' },
        query: { type: 'string', description: 'What to look for (a class name, a display name, a category or a word from a description). Required by action=search.' },
        limit: { type: 'number', description: 'How many search hits: 1-200. Default 40.' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI nodes'),
    async execute(args, exec) {
      try {
        const action = typeof args.action === 'string' ? args.action : 'categories'
        const { catalog, server } = await catalogFor(deps, { signal: exec && exec.signal })
        const source = describeCatalog(catalog)
        if (action === 'categories') {
          const groups = categoriesIn(catalog)
          const rows = groups.map((group) => [group.category, String(group.count), group.classes.slice(0, 6).join(', ') + (group.classes.length > 6 ? '…' : '')])
          return {
            text: 'Node catalog: ' + source + ' · ' + catalog.nodes.size + ' classes in ' + groups.length + ' categories\n\n' + table(['CATEGORY', 'N', 'EXAMPLES'], rows),
            view: { ok: true, source: catalog.source, complete: catalog.complete === true, classes: catalog.nodes.size, categories: groups.map((group) => ({ category: group.category, count: group.count })) },
          }
        }
        if (action === 'node') {
          const wanted = String(args.node ?? '').trim()
          if (wanted === '') return refusal('BAD_ARGUMENT', 'action=node needs `node` (a class name, e.g. KSampler).')
          const spec = nodeIn(catalog, wanted)
          if (spec === null) {
            const near = searchCatalog(catalog, wanted, 6)
            return refusal('NO_NODE', 'This catalog has no class "' + wanted + '".' + (near.length === 0 ? '' : ' Nearest: ' + near.map((node) => node.class).join(', ') + '.') + (catalog.complete ? '' : ' The catalog in force is the built-in core table (' + catalog.nodes.size + ' classes); start ComfyUI and call `comfy_status` for the full one.'), { classes: near.map((node) => node.class) })
          }
          const rows = spec.inputs.map((input) => [
            input.name,
            input.type,
            input.kind === 'hidden' ? 'hidden' : input.kind,
            input.optional ? 'yes' : '',
            input.enum === null ? (input.options !== undefined && input.options.default !== undefined ? String(input.options.default) : '') : input.enum.slice(0, 5).join(' | ') + (input.enum.length > 5 ? ' | …(' + input.enum.length + ')' : ''),
          ])
          const lines = []
          lines.push(spec.class + ' — ' + spec.displayName + (spec.category === '' ? '' : ' · ' + spec.category) + (spec.outputNode ? ' · OUTPUT NODE' : '') + (spec.deprecated ? ' · deprecated' : ''))
          lines.push('catalog: ' + source)
          if (spec.description !== '') lines.push('', spec.description)
          lines.push('', table(['INPUT', 'TYPE', 'KIND', 'OPT', 'DEFAULT / OPTIONS'], rows))
          if (spec.outputs.length > 0) {
            lines.push('', table(['SLOT', 'OUTPUT', 'TYPE'], spec.outputs.map((output, index) => [String(index), output.name, output.type])))
          } else {
            lines.push('', 'This class has no outputs (it is an output node: the graph runs to it).')
          }
          const widgets = widgetInputs(spec)
          if (widgets.length > 0) {
            const withControl = widgets.filter((input) => input.controlAfterGenerate).map((input) => input.name)
            lines.push('', 'widgets_values order: ' + widgets.map((input) => input.name).join(', ') + (withControl.length === 0 ? '' : ' — and an extra control_after_generate value right after ' + withControl.join(', ') + ' ("' + CONTROL_AFTER_GENERATE.join('" / "') + '")'))
          }
          return { text: lines.join('\n'), view: { ok: true, source: catalog.source, node: spec } }
        }
        if (action === 'search') {
          const query = String(args.query ?? '').trim()
          if (query === '') return refusal('BAD_ARGUMENT', 'action=search needs `query`.')
          const limit = Number.isFinite(args.limit) ? Math.min(200, Math.max(1, args.limit)) : 40
          const hits = searchCatalog(catalog, query, limit)
          if (hits.length === 0) return refusal('NO_MATCH', 'Nothing in this catalog matches "' + query + '". It has ' + catalog.nodes.size + ' classes' + (catalog.complete ? '' : ', and it is the built-in core table rather than a server\'s full catalog') + '.', { source: catalog.source })
          const rows = hits.map((node) => [node.class, node.category, String(node.inputs.filter((input) => input.kind === 'widget').length), String(node.inputs.filter((input) => input.kind === 'link').length), node.outputs.map((output) => output.type).join(',') || (node.outputNode ? 'OUTPUT' : ''), node.outputNode ? 'yes' : ''])
          return {
            text: table(['CLASS', 'CATEGORY', 'WIDGETS', 'LINKS', 'OUTPUTS', 'OUT NODE'], rows) + '\n\n' + hits.length + ' hit(s) in ' + source,
            view: { ok: true, source: catalog.source, query, hits: hits.map((node) => node.class) },
          }
        }
        return refusal('BAD_ARGUMENT', 'action must be one of categories, node, search.')
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `comfy_project`: new, list, show, build, import. */
  const project = {
    name: 'comfy_project',
    description: [
      'Work with ComfyUI projects on disk. A project is a FOLDER: `project.json` is the SOURCE (a small readable spec - nodes by KEY, values by NAME, wires by `<key>.<OUTPUT>`), and `workflow.json` + `prompt.json` + `README.md` + `build.json` are GENERATED from it.',
      'Actions: `new` writes a project from a shipped `template` (see `comfy_test` action=compile for the library) or from an inline `spec` object, and REBINDS the model filenames to what this machine actually has - reporting every rebinding; `list` shows the projects; `show` prints one spec and its build receipt; `build` compiles and writes the generated files; `import` takes a `workflow.json` or an API prompt the app produced and makes a project of it.',
      'A spec value starting with `@` is a BINDING, resolved from `bindings` - that is how a template says "whichever checkpoint this machine has" without freezing a filename into it. `new` picks `@checkpoint` / `@lora` / `@inputImage` from the server\'s own file lists when the declared one is not there; it never guesses between two candidates.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['new', 'list', 'show', 'build', 'import'], description: 'What to do. Default list.' },
        project: { type: 'string', description: 'A project slug under the workspace projects root (or a path to its folder). Required by show, build and (for the imported name) import.' },
        template: { type: 'string', description: 'For action=new: a shipped example slug (smoke-image, smoke-video, text-to-image, image-to-image).' },
        spec: { type: 'object', description: 'For action=new: the whole spec inline ({ name, title, description, requires, bindings, nodes }). Takes precedence over template.' },
        name: { type: 'string', description: 'For action=new: the folder name (slug). Defaults to the spec\'s own name. For import: the name to give the imported project.' },
        bindings: { type: 'object', description: 'For action=new: overrides for the spec\'s bindings, e.g. {"checkpoint": "sdxl.safetensors", "prompt": "a cat"}. Only the named keys are replaced.' },
        source: { type: 'string', description: 'For action=import: the path to a workflow.json or prompt.json (relative to the workspace).' },
        overwrite: { type: 'boolean', description: 'For action=new: replace an existing project.json. Default false.' },
        dryRun: { type: 'boolean', description: 'For action=build: compile and report without writing the generated files. Default false.' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI project'),
    async execute(args, exec) {
      try {
        const action = typeof args.action === 'string' ? args.action : 'list'
        const root = rootOf(deps, exec)
        if (action === 'list') {
          const projects = listProjects(root)
          if (projects.length === 0) {
            const examples = listExamples()
            return {
              text:
                'No projects under ' +
                root +
                '.\n\nShipped examples you can turn into a project with `comfy_project` action=new template=<slug>:\n' +
                table(['SLUG', 'NODES', 'NEEDS'], examples.map((entry) => [entry.slug, String(entry.nodes), requirementLine(entry)])) +
                '\n\n`comfy_test` action=compile checks them all without writing anything.',
              view: { ok: true, root, projects: [], examples: examples.map((entry) => entry.slug) },
            }
          }
          const rows = projects.map((entry) => [entry.slug, entry.source, String(entry.nodes), entry.built ? (entry.build === null ? 'built' : entry.build.rung) : '—', entry.error === '' ? '' : entry.error])
          return {
            text: table(['PROJECT', 'SOURCE', 'NODES', 'BUILT', 'ISSUE'], rows) + '\n\n' + projects.length + ' project(s) in ' + root + '. `comfy_project` action=show project=<slug> prints one.',
            view: { ok: true, root, projects },
          }
        }
        if (action === 'new') {
          let spec = null
          let templateName = ''
          if (args.spec !== null && typeof args.spec === 'object' && !Array.isArray(args.spec)) {
            spec = args.spec
          } else if (typeof args.template === 'string' && args.template !== '') {
            templateName = slugify(args.template)
            spec = readExample(templateName)
            if (spec === null) {
              return refusal('NO_TEMPLATE', 'No shipped example "' + args.template + '". Available: ' + listExamples().map((entry) => entry.slug).join(', ') + '.', { examples: listExamples().map((entry) => entry.slug) })
            }
          } else {
            return refusal('BAD_ARGUMENT', 'action=new needs either `template` (a shipped example) or `spec` (the whole project inline).')
          }
          const next = JSON.parse(JSON.stringify(spec))
          if (typeof args.name === 'string' && args.name.trim() !== '') next.name = args.name.trim()
          next.bindings = next.bindings !== null && typeof next.bindings === 'object' ? next.bindings : {}
          if (args.bindings !== null && typeof args.bindings === 'object' && !Array.isArray(args.bindings)) Object.assign(next.bindings, args.bindings)
          if (templateName !== '') next.template = templateName
          const { catalog } = await catalogFor(deps, { signal: exec && exec.signal })
          const rebound = rebindToCatalog(next, catalog)
          const created = createProject({ root, spec: rebound.spec, overwrite: args.overwrite === true })
          const paths = created.paths
          const built = buildFromSpec({ raw: readJson(paths.spec), paths, catalog, now: () => new Date().toISOString(), dryRun: false, install: await installFor(deps) })
          const lines = []
          lines.push('Created ' + created.slug + ' at ' + paths.dir)
          lines.push('  project.json    the spec (the file to edit)')
          lines.push('  workflow.json   GENERATED — drag it onto the ComfyUI canvas')
          lines.push('  prompt.json     GENERATED — what comfy_run queues')
          lines.push('  build.json      the receipt: catalog, rung, findings')
          lines.push('')
          lines.push('Build: ' + built.rung + ' · ' + built.counts.nodes + ' nodes · ' + built.counts.links + ' links · catalog ' + built.catalog.described)
          for (const change of rebound.changes) lines.push('  rebound @' + change.binding + ': "' + change.from + '" -> "' + change.to + '" (' + change.why + ')')
          for (const note of rebound.notes) lines.push('  note: ' + note)
          const block = findingsBlock(built.findings)
          if (block !== '') lines.push('', 'Findings:', block)
          lines.push('')
          lines.push(built.ok ? 'Next: `comfy_validate` re-checks it without writing, `comfy_run` queues it.' : 'Next: fix the findings above in project.json, then `comfy_project` action=build. `comfy_validate` explains them without writing.')
          return {
            text: lines.join('\n'),
            view: {
              ok: true,
              project: created.slug,
              dir: paths.dir,
              rung: built.rung,
              built: built.ok,
              counts: built.counts,
              bindings: rebound.spec.bindings,
              rebound: rebound.changes,
              notes: rebound.notes,
              findings: built.findings,
              files: Object.fromEntries(Object.entries(built.files).map(([key, value]) => [key, path.basename(String(value))])),
            },
          }
        }
        if (action === 'show') {
          const paths = requireProject(root, args.project)
          const spec = readJson(paths.spec)
          const build = existsSync(paths.build) ? readJson(paths.build) : null
          const lines = []
          lines.push(spec.title !== undefined ? String(spec.title) : path.basename(paths.dir) + ' — ' + paths.dir)
          if (typeof spec.description === 'string' && spec.description !== '') lines.push('', spec.description)
          lines.push('', 'source: ' + (typeof spec.source === 'string' ? spec.source : 'spec') + ' · ' + (Array.isArray(spec.nodes) ? spec.nodes.length : 0) + ' node(s) in project.json')
          if (build !== null) {
            lines.push('built: ' + (typeof build.builtAt === 'string' ? build.builtAt : '?') + ' · ' + (typeof build.rung === 'string' ? build.rung : '?') + ' · ' + (build.counts !== null && typeof build.counts === 'object' ? build.counts.nodes + ' nodes, ' + build.counts.errors + ' error(s)' : '') + ' · ' + (build.catalog !== null && typeof build.catalog === 'object' ? build.catalog.described : ''))
          } else {
            lines.push('built: never — `comfy_project` action=build writes prompt.json and workflow.json')
          }
          if (spec.source === 'workflow') {
            lines.push('', 'This project\'s source is workflow.json (written by ComfyUI). prompt.json is derived from it on every build.')
          } else {
            lines.push('', 'Nodes:')
            for (const node of spec.nodes ?? []) lines.push('  ' + node.key + '  ' + node.class + (node.title === undefined ? '' : '  "' + node.title + '"') + (node.wires === undefined ? '' : '  <- ' + Object.entries(node.wires).map(([input, target]) => input + '=' + target).join(', ')))
            const bindings = spec.bindings !== null && typeof spec.bindings === 'object' ? Object.entries(spec.bindings) : []
            if (bindings.length > 0) {
              lines.push('', 'Bindings:')
              for (const [name, value] of bindings) lines.push('  @' + name + ' = ' + JSON.stringify(value))
            }
          }
          return { text: lines.join('\n'), view: { ok: true, project: path.basename(paths.dir), spec, build } }
        }
        if (action === 'build') {
          const paths = requireProject(root, args.project)
          const { catalog, note } = await catalogFor(deps, { signal: exec && exec.signal })
          const built = buildFromSpec({ raw: readJson(paths.spec), paths, catalog, now: () => new Date().toISOString(), dryRun: args.dryRun === true, install: await installFor(deps) })
          const lines = []
          lines.push((args.dryRun === true ? 'Build (dry run) ' : 'Built ') + path.basename(paths.dir) + ': ' + built.rung + ' · ' + built.counts.nodes + ' nodes · ' + built.counts.links + ' links')
          lines.push('catalog: ' + built.catalog.described + (note === '' ? '' : ' (' + note + ')'))
          const block = findingsBlock(built.findings)
          if (block !== '') lines.push('', 'Findings:', block)
          if (args.dryRun !== true) lines.push('', 'Wrote: ' + Object.values(built.files).map((file) => path.basename(String(file))).join(', '))
          lines.push('', built.ok ? 'Next: `comfy_run` queues prompt.json, or drag workflow.json onto the canvas.' : 'Next: fix the findings above, then build again.')
          return { text: lines.join('\n'), view: { ok: built.ok, project: path.basename(paths.dir), rung: built.rung, counts: built.counts, findings: built.findings, files: built.files, catalog: built.catalog } }
        }
        if (action === 'import') {
          const source = String(args.source ?? '').trim()
          if (source === '') return refusal('BAD_ARGUMENT', 'action=import needs `source`: the path to a workflow.json or prompt.json.')
          const file = path.resolve(workspaceOf(deps.ctx, exec, sessionOf(exec)) || process.cwd(), source)
          if (!existsSync(file)) return refusal('NO_FILE', 'no file at ' + file + '.')
          let raw
          try {
            raw = JSON.parse(readFileSync(file, 'utf8'))
          } catch (error) {
            return refusal('BAD_JSON', file + ' is not readable JSON: ' + messageOf(error))
          }
          const { catalog } = await catalogFor(deps, { signal: exec && exec.signal })
          const imported = importProject({ root, name: typeof args.name === 'string' ? args.name : path.basename(file, '.json'), source: raw, catalog, now: () => new Date().toISOString() })
          const lines = []
          lines.push('Imported ' + path.basename(file) + ' as project "' + imported.slug + '" (' + imported.kind + ') at ' + imported.paths.dir)
          lines.push('Build: ' + imported.report.rung + ' · ' + imported.report.counts.nodes + ' nodes')
          const block = findingsBlock(imported.report.findings)
          if (block !== '') lines.push('', 'Findings:', block)
          if (imported.kind === 'workflow' && imported.report.ok === false) lines.push('', 'A canvas needs the server\'s full node catalog to be lowered to a prompt (widgets_values is an unnamed array). Start ComfyUI, then `comfy_project` action=build again.')
          return { text: lines.join('\n'), view: { ok: imported.report.ok, project: imported.slug, kind: imported.kind, rung: imported.report.rung, findings: imported.report.findings, counts: imported.report.counts } }
        }
        return refusal('BAD_ARGUMENT', 'action must be one of new, list, show, build, import.')
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `comfy_validate`: ComfyUI's own checks, offline. */
  const validate = {
    name: 'comfy_validate',
    description: [
      'Check a project - or a single workflow.json / prompt.json - against ComfyUI\'s own rules, WITHOUT queueing anything: a class the server does not have, a required input nobody set, a link into a slot that does not exist, a wire whose type does not match, a widget value outside the server\'s list or its min/max, a dependency cycle, a graph with no output node. Every finding carries the `type` string `/prompt` would return (`required_input_missing`, `return_type_mismatch`, `value_not_in_list`, `dependency_cycle`, `prompt_no_outputs`, ...) plus the node KEY and input NAME.',
      'It reports the RUNG it reached: `v2-schema` when the catalog in force is a complete server catalog (the same one the server validates against) and there are no errors, `v1-structural` when it is the built-in core table - structurally sound, but nothing here could confirm the classes exist. A file with a `nodes` array is read as a CANVAS and needs a complete catalog (its `widgets_values` is an unnamed array); a file of `{class_type, inputs}` values is read as a PROMPT and does not.',
      'Read-only: it never writes a project, never queues a prompt, never starts ComfyUI.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'A project slug (or folder path) to validate.' },
        file: { type: 'string', description: 'A workflow.json or prompt.json to validate instead of a project (relative to the workspace).' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI validate'),
    async execute(args, exec) {
      try {
        const hasProject = typeof args.project === 'string' && args.project.trim() !== ''
        const hasFile = typeof args.file === 'string' && args.file.trim() !== ''
        if (hasProject === hasFile) return refusal('BAD_ARGUMENT', 'pass exactly one of `project` (a slug) or `file` (a workflow.json / prompt.json).')
        const { catalog, note } = await catalogFor(deps, { signal: exec && exec.signal })
        if (hasProject) {
          const root = rootOf(deps, exec)
          const paths = requireProject(root, args.project)
          const built = buildFromSpec({ raw: readJson(paths.spec), paths, catalog, dryRun: true, install: await installFor(deps) })
          const lines = []
          lines.push('Validate ' + path.basename(paths.dir) + ': ' + built.rung + ' · ' + built.counts.nodes + ' nodes · ' + (built.ok ? 'no errors' : built.counts.errors + ' error(s), ' + built.counts.warnings + ' warning(s)'))
          lines.push('catalog: ' + built.catalog.described + (note === '' ? '' : ' — ' + note))
          const block = findingsBlock(built.findings)
          lines.push('')
          lines.push(block === '' ? 'No findings. What that proves: ' + (built.rung === 'v2-schema' ? 'every class exists in this server, every required input is set, every wire type matches and every value is in the server\'s list - the same checks /prompt runs.' : 'the graph is structurally sound, against the built-in core table which covers only the nodes the shipped examples use. Start ComfyUI to check the classes themselves.') : block)
          const fileCheck = built.fileCheck ?? null
          if (fileCheck !== null && fileCheck.checked > 0) lines.push('', 'Files: ' + fileCheck.checked + ' name(s) checked against the install on disk (' + fileCheck.missing + ' missing)' + (fileCheck.roots.length === 0 ? '' : ' in ' + fileCheck.roots.join(', ')) + '.')
          else if (fileCheck !== null && fileCheck.skipped !== '') lines.push('', 'Files: none checked - ' + fileCheck.skipped + '.')
          lines.push('')
          lines.push(built.ok ? 'Next: `comfy_run` queues it (a compiled graph is not a finished render: only /history says what it produced).' : 'Fix these in project.json, then `comfy_project` action=build.')
          return { text: lines.join('\n'), view: { ok: built.ok, rung: built.rung, findings: built.findings, counts: built.counts, catalog: built.catalog, project: path.basename(paths.dir) } }
        }
        const file = path.resolve(workspaceOf(deps.ctx, exec, sessionOf(exec)) || process.cwd(), String(args.file))
        if (!existsSync(file)) return refusal('NO_FILE', 'no file at ' + file + '.')
        let raw
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
        } catch (error) {
          return refusal('BAD_JSON', file + ' is not readable JSON: ' + messageOf(error))
        }
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.nodes)) {
          const parsed = parseWorkflow(raw)
          const findings = [...parsed.findings]
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
          const errors = findings.filter((entry) => entry.severity === 'error')
          const rung = errors.length > 0 ? 'v0-failed' : catalog.complete === true ? 'v2-schema' : 'v1-structural'
          const lines = ['Validate canvas ' + path.basename(file) + ': ' + rung + ' · ' + parsed.nodes.length + ' nodes · ' + (errors.length === 0 ? 'no errors' : errors.length + ' error(s)'), 'catalog: ' + describeCatalog(catalog) + (note === '' ? '' : ' — ' + note), '']
          const block = findingsBlock(findings)
          lines.push(block === '' ? 'The canvas lowers to a prompt with no findings.' : block)
          return { text: lines.join('\n'), view: { ok: errors.length === 0, rung, kind: 'workflow', findings, nodes: parsed.nodes.length, catalog: describeCatalog(catalog) } }
        }
        const validated = validatePrompt(raw, catalog)
        const errors = validated.findings.filter((entry) => entry.severity === 'error')
        const rung = errors.length > 0 ? 'v0-failed' : catalog.complete === true ? 'v2-schema' : 'v1-structural'
        const lines = ['Validate prompt ' + path.basename(file) + ': ' + rung + ' · ' + Object.keys(raw).length + ' nodes · ' + (errors.length === 0 ? 'no errors' : errors.length + ' error(s)'), 'catalog: ' + describeCatalog(catalog) + (note === '' ? '' : ' — ' + note), '']
        const block = findingsBlock(validated.findings)
        lines.push(block === '' ? 'No findings.' : block)
        return { text: lines.join('\n'), view: { ok: errors.length === 0, rung, kind: 'prompt', findings: validated.findings, nodes: Object.keys(raw).length, catalog: describeCatalog(catalog) } }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `comfy_run`: the one tool that queues work. */
  const run = {
    name: 'comfy_run',
    description: [
      'Queue a compiled prompt on the ComfyUI server and report what came out: the files `/history` lists (with their `/view` URLs), the node titles that produced them, how long the queue took, and - on failure - the node and the exception. This is the ONLY tool here that executes anything.',
      'It builds a project first (writing `prompt.json`/`workflow.json`) and refuses to queue one that has validation errors: a graph with a missing input is a 400 with `node_errors`, not a render. Pass `file` instead to queue a standalone prompt.json or workflow.json.',
      'A refusal keeps the server\'s own words: `/prompt` answers a rejected graph with `node_errors`, which is the most useful text in the API. Queueing more than ComfyUI can do is not faster - the queue is serial on one GPU - so this waits for its own prompt and reports its own duration.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'A project slug (or folder path) to build and queue.' },
        file: { type: 'string', description: 'A prompt.json or workflow.json to queue instead of a project (relative to the workspace).' },
        waitSeconds: { type: 'number', description: 'How long to wait for the render: 10-3600 s. Default 600. A CPU-only SD 1.5 render at 512px and 4 steps is 10-25 s; a 30-step SDXL render on a CPU is minutes.' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI run'),
    async execute(args, exec) {
      try {
        const hasProject = typeof args.project === 'string' && args.project.trim() !== ''
        const hasFile = typeof args.file === 'string' && args.file.trim() !== ''
        if (hasProject === hasFile) return refusal('BAD_ARGUMENT', 'pass exactly one of `project` (a slug) or `file` (a prompt.json / workflow.json).')
        const install = discoverInstall({ env: deps.env ?? process.env, platform: deps.platform })
        const { catalog, server, probed, note } = await catalogFor(deps, { signal: exec && exec.signal })
        if (server === null) {
          return refusal('SERVER_DOWN', noServerText(install, probed) + (note === '' ? '' : '\n(' + note + ')'), { probed })
        }
        let prompt = {}
        let built = null
        let label = ''
        if (hasProject) {
          const root = rootOf(deps, exec)
          const paths = requireProject(root, args.project)
          label = path.basename(paths.dir)
          built = buildFromSpec({ raw: readJson(paths.spec), paths, catalog, now: () => new Date().toISOString(), dryRun: false, install: await installFor(deps) })
          if (!built.ok) {
            return refusal('PROJECT_INVALID', 'not queued: ' + built.counts.errors + ' validation error(s) in ' + label + '. A graph like this is a 400 with `node_errors`, not a render.\n' + findingsBlock(built.findings) + '\nFix them in project.json (or with the app), then run again.', { findings: built.findings, rung: built.rung })
          }
          prompt = built.prompt
        } else {
          const file = path.resolve(workspaceOf(deps.ctx, exec, sessionOf(exec)) || process.cwd(), String(args.file))
          if (!existsSync(file)) return refusal('NO_FILE', 'no file at ' + file + '.')
          const raw = readJson(file)
          label = path.basename(file)
          const looksLikePrompt = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !Array.isArray(raw.nodes) && Object.values(raw).every((value) => value !== null && typeof value === 'object' && typeof value.class_type === 'string')
          if (!looksLikePrompt) {
            const parsed = parseWorkflow(raw)
            const derived = workflowToPrompt(parsed, catalog)
            prompt = derived.prompt
            const validated = validatePrompt(prompt, catalog)
            const errors = [...derived.findings, ...validated.findings].filter((entry) => entry.severity === 'error')
            if (errors.length > 0) return refusal('PROJECT_INVALID', 'not queued: the canvas lowers to a prompt with ' + errors.length + ' error(s).\n' + findingsBlock(errors), { findings: errors })
          } else {
            prompt = raw
          }
        }
        const waitMs = (Number.isFinite(args.waitSeconds) ? Math.min(3600, Math.max(10, args.waitSeconds)) : 600) * 1000
        const queued = await queuePrompt(deps, server.origin, prompt, { signal: exec && exec.signal })
        const partial = findingsFromNodeErrors(queued.node_errors)
        const waited = await waitForHistory(deps, server.origin, queued.prompt_id, { timeoutMs: waitMs, signal: exec && exec.signal })
        const lines = []
        if (waited.timedOut) {
          return refusal(
            'TIMEOUT',
            'Queued as ' + queued.prompt_id + ' on ' + server.origin + ', and it was still not in /history after ' + Math.round(waitMs / 1000) + ' s. That is not a failure - a first run pays the model load, and a CPU render is slow. Ask again with a bigger waitSeconds, or watch the ComfyUI console; `/queue` still lists it if it is waiting.',
            { promptId: queued.prompt_id, origin: server.origin, waitedMs: waited.waitedMs },
          )
        }
        if (waited.dropped) {
          return refusal('DROPPED', 'Queued as ' + queued.prompt_id + ' and it left the queue without a history entry: the server restarted, or the item was deleted. Nothing here retries - run it again.', { promptId: queued.prompt_id })
        }
        const entry = waited.entry
        const errors = errorsOf(entry)
        const files = describeOutputs(entry, prompt)
        const statusStr = entry !== null && entry.status !== null && typeof entry.status === 'object' && typeof entry.status.status_str === 'string' ? entry.status.status_str : ''
        lines.push(label + ' · ' + (errors.length === 0 && statusStr !== 'error' ? 'completed' : 'FAILED') + ' · ' + formatMilliseconds(waited.waitedMs) + ' · prompt ' + queued.prompt_id)
        lines.push('server: ' + server.origin + (server.version === '' ? '' : ' · ComfyUI ' + server.version) + (server.device === '' ? '' : ' · ' + server.device))
        if (partial.length > 0) {
          lines.push('', 'The server accepted it with node_errors (those OUTPUT branches will be skipped):')
          lines.push(findingsBlock(partial))
        }
        if (errors.length > 0) {
          lines.push('')
          for (const error of errors) {
            lines.push('NODE ' + error.node + (error.nodeType === '' ? '' : ' (' + error.nodeType + ')') + (error.exceptionType === '' ? '' : ' raised ' + error.exceptionType) + ':')
            lines.push('  ' + (error.message === '' ? '(no message)' : error.message.split('\n').slice(0, 12).join('\n  ')))
          }
        }
        if (files.length > 0) {
          lines.push('', 'Files (' + files.length + '):')
          const install = await installFor(deps)
          for (const file of files) {
            const onDisk = install.base === '' ? '' : path.join(install.base, 'output', file.subfolder, file.filename)
            lines.push('  ' + (file.subfolder === '' ? file.filename : file.subfolder + '/' + file.filename) + '  ·  ' + file.nodeTitle + '  ·  ' + server.origin + file.url)
            if (onDisk !== '') lines.push('    on disk: ' + onDisk)
          }
        } else if (errors.length === 0) {
          lines.push('', 'No files: the output node saved nothing. A graph runs to its OUTPUT nodes - a preview inside the app is not a saved file.')
        }
        if (entry !== null && entry.status !== null && typeof entry.status === 'object' && entry.status.completed === false) lines.push('', 'The history entry says completed: false — read the messages above rather than the file list.')
        lines.push('', 'Rung: v4-executed (queued and finished with a history entry' + (files.length > 0 ? ' and ' + files.length + ' file(s)' : '') + ').')
        return {
          text: lines.join('\n'),
          view: {
            ok: errors.length === 0,
            rung: 'v4-executed',
            promptId: queued.prompt_id,
            origin: server.origin,
            waitedMs: waited.waitedMs,
            files,
            errors,
            findings: partial,
            status: statusStr,
            project: label,
          },
        }
      } catch (error) {
        if (error instanceof ComfyError && error.code === 'HTTP_ERROR' && error.extra && error.extra.body) {
          const body = error.extra.body
          const findings = findingsFromNodeErrors(body.node_errors)
          const sentence = errorSentenceFromResponse(body)
          const text = ['The server REFUSED the prompt (HTTP ' + error.extra.status + ').' + (sentence === '' ? '' : ' ' + sentence), findings.length === 0 ? '' : findingsBlock(findings), '', 'This is /prompt\'s own validation - the same checks `comfy_validate` runs offline. Fix the graph, then run again.'].filter((line) => line !== '').join('\n')
          return { text, view: { ok: false, code: 'PROMPT_REFUSED', findings, status: error.extra.status, error: body.error ?? null } }
        }
        return failureOf(error)
      }
    },
  }

  /** `comfy_test`: the ladder over the shipped library. */
  const test = {
    name: 'comfy_test',
    description: [
      'Compile the shipped example library - and optionally the projects in the workspace - and report ONE RUNG per item, so "it compiles" is never printed as "it runs": `v1-structural` (the spec, the wires and the graph are sound, checked against the built-in core table), `v2-schema` (checked against a complete server catalog: every class exists, every value is in the server\'s own list), `v3-queued` (the server accepted it), `v4-executed` (a history entry finished and files came out).',
      'action=compile (the default) writes NOTHING: it compiles every example in memory against the catalog in force. That is the check to run after changing this package, and the one that works on a machine where ComfyUI is not running.',
      'action=run queues each item on a live server and waits for it, one at a time (the ComfyUI queue is serial - a model is loaded on one device). The two model-free smoke examples prove the server, the queue and the output folder work before a 2 GB download is blamed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['compile', 'run'], description: 'compile (default, writes nothing) or run (queues each item, needs a server).' },
        examples: { type: 'array', items: { type: 'string' }, description: 'Only these example slugs. Default: every shipped example.' },
        includeProjects: { type: 'boolean', description: 'Also compile the projects in the workspace root. Default false (they are yours, not the library).' },
        waitSeconds: { type: 'number', description: 'For action=run: seconds per item. Default 180, max 3600.' },
      },
    },
    output: OUTPUT,
    ...present('ComfyUI test'),
    async execute(args, exec) {
      try {
        const action = typeof args.action === 'string' ? args.action : 'compile'
        const only = Array.isArray(args.examples) && args.examples.length > 0 ? args.examples.map((entry) => slugify(entry)) : null
        const { catalog, server, probed, note } = await catalogFor(deps, { signal: exec && exec.signal })
        const examples = listExamples()
        const chosen = only === null ? examples : examples.filter((entry) => only.includes(entry.slug))
        if (chosen.length === 0) {
          return refusal('NO_EXAMPLES', 'No shipped example matches ' + JSON.stringify(args.examples) + '. The library: ' + examples.map((entry) => entry.slug).join(', ') + '.')
        }
        const root = rootOf(deps, exec)
        const items = chosen.map((entry) => ({ slug: entry.slug, kind: 'example', title: entry.title }))
        if (args.includeProjects === true) {
          for (const entry of listProjects(root)) items.push({ slug: entry.slug, kind: 'project', title: entry.title, paths: projectPaths(root, entry.slug) })
        }
        if (action === 'run' && server === null) {
          return refusal('SERVER_DOWN', 'action=run needs a ComfyUI server and none answered.\n\n' + noServerText(discoverInstall({ env: deps.env ?? process.env, platform: deps.platform }), probed) + '\n\n`comfy_test` action=compile checks the same library without one.', { probed })
        }
        const rows = []
        const results = []
        const waitMs = (Number.isFinite(args.waitSeconds) ? Math.min(3600, Math.max(10, args.waitSeconds)) : 180) * 1000
        for (const item of items) {
          if (item.kind === 'example') {
            const spec = readExample(item.slug)
            const probePaths = { dir: '(in memory)', spec: '', workflow: '', prompt: '', readme: '', build: '' }
            const built = buildFromSpec({ raw: spec, paths: probePaths, catalog, dryRun: true, install: await installFor(deps) })
            const firstError = built.findings.find((entry) => entry.severity === 'error')
            if (action !== 'run' || firstError !== undefined) {
              rows.push([item.slug, built.rung, String(built.counts.nodes), firstError === undefined ? (built.counts.warnings === 0 ? '—' : built.counts.warnings + ' warning(s)') : firstError.type + ': ' + firstError.message.slice(0, 80)])
              results.push({ slug: item.slug, kind: item.kind, rung: built.rung, ok: built.ok, findings: built.findings, counts: built.counts })
              continue
            }
            // Run: queue it and wait.
            const started = Date.now()
            try {
              const queued = await queuePrompt(deps, server.origin, built.prompt, { signal: exec && exec.signal })
              const waited = await waitForHistory(deps, server.origin, queued.prompt_id, { timeoutMs: waitMs, signal: exec && exec.signal })
              const files = waited.entry === null ? [] : outputsOf(waited.entry)
              const errors = waited.entry === null ? [] : errorsOf(waited.entry)
              const rung = waited.timedOut ? 'v3-queued' : errors.length === 0 && files.length > 0 ? 'v4-executed' : 'v3-queued'
              const why = waited.timedOut ? 'timed out after ' + Math.round(waitMs / 1000) + ' s' : errors.length > 0 ? 'NODE ' + errors[0].node + ': ' + String(errors[0].message).split('\n')[0].slice(0, 90) : files.length === 0 ? 'finished with no files' : String(files.length) + ' file(s)'
              rows.push([item.slug, rung, String(built.counts.nodes), formatMilliseconds(Date.now() - started) + ' · ' + why])
              results.push({ slug: item.slug, kind: item.kind, rung, ok: rung === 'v4-executed', promptId: queued.prompt_id, files, errors, waitedMs: Date.now() - started })
            } catch (error) {
              const body = error instanceof ComfyError ? error.extra?.body : null
              const findings = body === null ? [] : findingsFromNodeErrors(body.node_errors)
              const why = findings.length > 0 ? 'REFUSED · ' + findings[0].type + ': ' + findings[0].message.slice(0, 80) : messageOf(error)
              rows.push([item.slug, 'v0-failed', String(built.counts.nodes), why])
              results.push({ slug: item.slug, kind: item.kind, rung: 'v0-failed', ok: false, error: messageOf(error), findings })
            }
            continue
          }
          // A workspace project.
          const built = buildFromSpec({ raw: readJson(item.paths.spec), paths: item.paths, catalog, dryRun: action !== 'run', install: await installFor(deps) })
          const firstError = built.findings.find((entry) => entry.severity === 'error')
          rows.push([item.slug, built.rung, String(built.counts.nodes), firstError === undefined ? (built.counts.warnings === 0 ? '—' : built.counts.warnings + ' warning(s)') : firstError.type + ': ' + firstError.message.slice(0, 80)])
          results.push({ slug: item.slug, kind: item.kind, rung: built.rung, ok: built.ok, findings: built.findings, counts: built.counts })
        }
        const passed = results.filter((entry) => entry.ok).length
        const lines = []
        lines.push('ComfyUI library · ' + action + (server === null ? ' (offline)' : ' on ' + server.origin) + ' · catalog ' + describeCatalog(catalog))
        if (note !== '') lines.push('  ' + note)
        lines.push('')
        lines.push(table(['ITEM', 'RUNG', 'NODES', 'RESULT'], rows))
        lines.push('')
        lines.push(passed + ' of ' + results.length + ' at the rung they should reach. ' + (action === 'compile' ? 'Nothing was written and nothing was queued.' : 'Each item was queued and awaited in turn.'))
        const ladder = results.reduce((counts, entry) => {
          counts[entry.rung] = (counts[entry.rung] ?? 0) + 1
          return counts
        }, {})
        lines.push('Rungs: ' + RUNGS.filter((rung) => ladder[rung] !== undefined).map((rung) => rung + ' ×' + ladder[rung]).join(' · ') + (ladder['v0-failed'] === undefined ? '' : ' · v0-failed ×' + ladder['v0-failed']))
        if (ladder['v1-structural'] !== undefined) lines.push('v1-structural means the graph is sound but no server catalog confirmed the classes: start ComfyUI for v2.')
        return {
          text: lines.join('\n'),
          view: { ok: results.every((entry) => entry.rung !== 'v0-failed'), action, origin: server === null ? '' : server.origin, catalog: describeCatalog(catalog), results, rungs: ladder, passed, total: results.length },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /**
   * `comfy_cli`: the second test path, through comfy-cli.
   *
   * It is not a convenience wrapper. `comfy run --workflow` converts a UI
   * canvas itself, submits it and waits - so running the workflow this package
   * GENERATED through a program that never saw its compiler is an independent
   * check on the canvas, and `comfy node deps-in-workflow` answers the one
   * question a project cannot answer by itself: which custom nodes it needs
   * before it is opened at all.
   */
  /**
   * `comfy_cli`: the second test path, through comfy-cli.
   *
   * It is not a convenience wrapper. `comfy run --workflow` converts a UI canvas
   * itself, submits it and waits - so running the workflow this package
   * GENERATED through a program that never saw its compiler is an independent
   * check on the canvas. `comfy node deps-in-workflow` answers the one question a
   * project cannot answer by itself: which custom nodes it needs before it is
   * opened at all.
   *
   * TWO PRE-FLIGHT REFUSALS, both measured on 1.29.0 and both reported as
   * sentences rather than raw stderr:
   *   - no workspace: comfy-cli's default is `<HOME>/comfy/ComfyUI`, which on a
   *     Desktop machine does not exist. This row passes `--workspace` naming the
   *     tree `comfy_status` found, so the command has a chance;
   *   - no ComfyUI-Manager in that workspace: `deps-in-workflow` resolves node
   *     packs through the Manager's `cm-cli`, and a Desktop install keeps its
   *     Manager inside the app. `comfy run --workflow` does not need it.
   */
  const cli = {
    name: 'comfy_cli',
    description: [
      'Drive comfy-cli (`comfy`, from `pip install comfy-cli`) - the cross-platform way to set up, launch and run ComfyUI on Windows, macOS and Linux, and the second opinion on a workflow this package wrote.',
      'Actions: `status` (the CLI version, its own `env` view - workspace and whether it EXISTS, the Desktop installs it knows, the running server, the GPU - and `which`); `deps` (`comfy node deps-in-workflow` on a project\'s workflow.json: the custom nodes and model files it needs); `run` (`comfy run --workflow <file> --wait`, which converts a UI canvas itself and submits it - an independent check on the graph, and the only path that works when this row cannot reach the API); `launch` (`comfy launch --background`, so a server exists to test against); `stop` (`comfy stop`).',
      'Every call is an argv array with the global `--json` BEFORE the subcommand, no shell, and a deadline. When `workspace` is not given and comfy-cli\'s own default does not exist, this passes `--workspace` naming the install `comfy_status` found - otherwise `comfy node ...` refuses with "not a valid ComfyUI workspace" on every Desktop machine.',
      'It NEVER runs `comfy install`, installs a node, downloads a model or removes anything: those change a person\'s machine, and the `comfyui-cli` skill names each command so the person decides.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'deps', 'run', 'launch', 'stop'], description: 'What to do. Default status.' },
        project: { type: 'string', description: 'For deps and run: a project slug. Its workflow.json is built first when it is missing or stale.' },
        file: { type: 'string', description: 'For deps and run: a workflow.json path instead of a project.' },
        workspace: { type: 'string', description: 'The ComfyUI tree comfy-cli should act on. Default: the one comfy_status found, when comfy-cli\'s own default does not exist.' },
        timeoutSeconds: { type: 'number', description: 'For run: how long the CLI may take. Default 900, max 3600. For launch: default 120.' },
        download: { type: 'boolean', description: 'For run: after the CLI reports a prompt_id, fetch the outputs with `comfy download` into the project folder. Default false.' },
      },
    },
    output: OUTPUT,
    ...present('comfy-cli'),
    async execute(args, exec) {
      try {
        const env = deps.env ?? process.env
        const action = typeof args.action === 'string' ? args.action : 'status'
        if (typeof deps.runner !== 'function') return refusal('NO_RUNNER', 'this row has no process runner, so comfy-cli cannot be driven.')
        const command = cliCommand(env)
        const version = await cliVersion(deps.runner, env)
        const missingText =
          'No usable comfy-cli: `' +
          command +
          '` did not answer' +
          (version.error === '' ? '' : ' (' + version.error + ')') +
          '.\n\nInstall it with `pip install comfy-cli` (Python 3.10+, Windows/macOS/Linux), then `comfy setup -y`. It also accepts a binary PATH does not carry: set DSH_COMFY_CLI to its full path.\n\nThe seven HTTP tools need none of it: `comfy_status`, `comfy_nodes`, `comfy_project`, `comfy_validate`, `comfy_run` and `comfy_test` work with the ComfyUI app alone. It adds `comfy launch --background` (a server to test against), `comfy run --workflow` (an independent run of the generated canvas) and `comfy node deps-in-workflow` (which node packs a graph needs).'

        const envAnswer = version.found ? await cliJson(deps.runner, ['env'], { env, command }) : null
        const facts = envAnswer === null ? null : envFacts(envAnswer.data)
        const whichAnswer = version.found ? await cliJson(deps.runner, ['which'], { env, command }) : null
        const which = whichAnswer === null ? null : whichFacts(whichAnswer.data)

        if (action === 'status') {
          if (!version.found) return refusal('CLI_MISSING', missingText, { command })
          const lines = ['comfy-cli ' + version.version + ' (' + command + ')']
          const workspacePath = which !== null && which.workspace !== '' ? which.workspace : facts === null ? '' : facts.workspace
          const exists = which !== null && which.exists !== null ? which.exists : facts === null ? null : facts.workspaceExists
          if (workspacePath !== '') lines.push('workspace: ' + workspacePath + (exists === true ? '' : exists === false ? '  (DOES NOT EXIST)' : ''))
          if (facts !== null && facts.workspaceType !== '') lines.push('workspace type: ' + facts.workspaceType)
          if (facts !== null && facts.python !== '') lines.push('python: ' + facts.python + (facts.pythonVersion === '' ? '' : ' (' + facts.pythonVersion + ')'))
          if (facts !== null && facts.serverRunning !== null) lines.push('server: ' + (facts.serverRunning ? 'RUNNING' + (facts.serverUrl === '' ? '' : ' at ' + facts.serverUrl) : 'not running'))
          if (facts !== null && facts.gpu !== '') lines.push('hardware: ' + facts.gpu + (facts.vramBytes === null ? '' : ' · ' + formatBytes(facts.vramBytes) + ' VRAM') + (facts.ramBytes === null ? '' : ' · ' + formatBytes(facts.ramBytes) + ' RAM'))
          if (facts !== null && facts.installs.length > 0) {
            lines.push('')
            lines.push('Desktop installs comfy-cli knows about:')
            for (const install of facts.installs) {
              lines.push('  ' + (install.name === '' ? '(unnamed)' : install.name) + (install.exists ? '' : ' [the folder is GONE]') + ' · code ' + (install.codeDir === '' ? '?' : install.codeDir) + (install.dataDir === '' ? '' : ' · data ' + install.dataDir))
            }
          }
          if (facts !== null && facts.managerMode !== '') {
            lines.push('')
            lines.push('ComfyUI-Manager: ' + facts.managerMode + (facts.managerMode === 'not-installed' ? ' — `comfy node install` and `node deps-in-workflow` need it; `comfy run` does not' : ''))
          }
          if (facts !== null && facts.warnings.length > 0) {
            lines.push('')
            for (const warning of facts.warnings) lines.push('warning: ' + warning.message)
          }
          lines.push('')
          lines.push('`comfy launch --background` starts a server comfy-cli manages; `comfy stop` stops it. `comfy_cli` action=deps answers which custom nodes a project needs; action=run tests the generated canvas through the CLI itself.')
          return {
            text: lines.join('\n'),
            view: {
              ok: true,
              command,
              version: version.version,
              workspace: workspacePath,
              workspaceExists: exists,
              which: which === null ? '' : which.workspace,
              comfyuiVersion: facts === null ? '' : facts.comfyuiVersion,
              python: facts === null ? '' : facts.python,
              serverRunning: facts === null ? null : facts.serverRunning,
              serverUrl: facts === null ? '' : facts.serverUrl,
              gpu: facts === null ? '' : facts.gpu,
              vramBytes: facts === null ? null : facts.vramBytes,
              managerMode: facts === null ? '' : facts.managerMode,
              installs: facts === null ? [] : facts.installs,
              warnings: facts === null ? [] : facts.warnings,
              envOk: envAnswer !== null && envAnswer.ok,
            },
          }
        }
        if (!version.found) return refusal('CLI_MISSING', missingText, { command })

        /**
         * The workspace to pass. comfy-cli's own default is a guess that is
         * usually wrong on a Desktop machine, and its refusal happens BEFORE it
         * reads the graph, so a real tree is the difference between working and
         * a message about `comfy install`.
         */
        const workspaceFor = async () => {
          if (typeof args.workspace === 'string' && args.workspace.trim() !== '') return { workspace: args.workspace.trim(), why: 'the `workspace` you gave' }
          const exists = which !== null && which.exists !== null ? which.exists : facts === null ? true : facts.workspaceExists
          if (exists === true) return { workspace: '', why: '' }
          const install = await installFor(deps)
          if (install.app !== '') return { workspace: install.app, why: "comfy-cli's own workspace does not exist, so this passes the install comfy_status found" }
          if (install.base !== '') return { workspace: install.base, why: "comfy-cli's own workspace does not exist, so this passes the base path comfy_status found" }
          return { workspace: '', why: '' }
        }

        // deps and run both need a workflow FILE, which is what the CLI reads.
        let workflowFile = ''
        let label = ''
        if (action === 'deps' || action === 'run') {
          const hasProject = typeof args.project === 'string' && args.project.trim() !== ''
          const hasFile = typeof args.file === 'string' && args.file.trim() !== ''
          if (hasProject === hasFile) return refusal('BAD_ARGUMENT', 'pass exactly one of `project` (a slug) or `file` (a workflow.json).')
          if (hasProject) {
            const root = rootOf(deps, exec)
            const paths = requireProject(root, args.project)
            const { catalog } = await catalogFor(deps, { signal: exec && exec.signal })
            const raw = readJson(paths.spec)
            if (raw !== null && typeof raw === 'object' && raw.source === 'workflow') {
              workflowFile = paths.workflow
            } else {
              const built = buildFromSpec({ raw, paths, catalog, now: () => new Date().toISOString(), dryRun: false, install: await installFor(deps) })
              if (!built.ok) return refusal('PROJECT_INVALID', 'not handed to the CLI: ' + built.counts.errors + ' validation error(s) in ' + path.basename(paths.dir) + '.\n' + findingsBlock(built.findings), { findings: built.findings })
              workflowFile = paths.workflow
            }
            label = path.basename(paths.dir)
            if (!existsSync(workflowFile)) return refusal('NO_WORKFLOW', 'this project has no workflow.json yet (' + workflowFile + '). `comfy_project` action=build writes it.', { path: workflowFile })
          } else {
            workflowFile = path.resolve(workspaceOf(deps.ctx, exec, sessionOf(exec)) || process.cwd(), String(args.file))
            label = path.basename(workflowFile)
            if (!existsSync(workflowFile)) return refusal('NO_FILE', 'no file at ' + workflowFile + '.')
          }
        }

        if (action === 'deps') {
          const where = await workspaceFor()
          const outFile = path.join(path.dirname(workflowFile), '.deps.json')
          const answer = await cliJson(deps.runner, ['node', 'deps-in-workflow', '--workflow=' + workflowFile, '--output=' + outFile], { env, command, workspace: where.workspace, timeoutMs: 180000 })
          const lines = ['comfy node deps-in-workflow · ' + label]
          if (where.why !== '') lines.push('  ' + where.why + (where.workspace === '' ? '' : ': ' + where.workspace))
          lines.push('exit code: ' + (answer.status === null ? 'n/a' : answer.status) + (answer.envelope !== null ? ' · envelope ok=' + String(answer.envelope.ok) : ''))
          const explained = explainCliFailure(String(answer.stderr ?? '') + '\n' + String(answer.error ?? ''))
          if (explained !== '') lines.push('', explained)
          let parsed = null
          try {
            parsed = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null
          } catch (error) {
            parsed = null
          }
          if (parsed !== null && typeof parsed === 'object') {
            const nodes = collectNames(parsed, /custom_?nodes?|nodes?|packs?/i)
            const models = collectNames(parsed, /models?|checkpoints?|loras?/i)
            if (nodes.length > 0) lines.push('', 'custom nodes it needs: ' + nodes.join(', '))
            if (models.length > 0) lines.push('model files it names: ' + models.join(', '))
            if (nodes.length === 0 && models.length === 0) lines.push('', 'the deps file has no node or model list this row recognises; its keys: ' + Object.keys(parsed).join(', '))
            const { catalog } = await catalogFor(deps, { signal: exec && exec.signal })
            const known = nodes.filter((name) => nodeIn(catalog, name) !== null)
            if (nodes.length > 0) lines.push('of those, ' + known.length + ' name(s) match a node CLASS in the catalog (' + describeCatalog(catalog) + ')' + (known.length === 0 ? ' - expected: a deps list names node PACKS, not classes' : ''))
          } else {
            if (answer.stdout !== '') lines.push('', 'the CLI said:', answer.stdout.split('\n').slice(-8).join('\n'))
            if (answer.stderr !== '') lines.push('', 'stderr:', answer.stderr.split('\n').slice(-8).join('\n'))
          }
          return { text: lines.join('\n'), view: { ok: answer.ok, exitCode: answer.status, workflow: workflowFile, workspace: where.workspace, deps: parsed, error: answer.error } }
        }

        if (action === 'run') {
          const where = await workspaceFor()
          const timeoutMs = (Number.isFinite(args.timeoutSeconds) ? Math.min(3600, Math.max(30, args.timeoutSeconds)) : Math.round(RUN_TIMEOUT_MS / 1000)) * 1000
          const started = Date.now()
          const result = await deps.runner(runArgv(command, workflowFile, { workspace: where.workspace }), { timeoutMs, env })
          const elapsed = Date.now() - started
          if (result === null || result.status === null) return refusal('CLI_FAILED', 'comfy did not start: ' + (result === null ? 'no result' : result.error ?? 'unknown') + '.')
          const text = (String(result.stdout ?? '') + '\n' + String(result.stderr ?? '')).trim()
          const promptId = promptIdFromRunText(String(result.stdout ?? ''))
          const lines = ['comfy run --workflow ' + label + ' --wait']
          if (where.why !== '') lines.push('  ' + where.why + (where.workspace === '' ? '' : ': ' + where.workspace))
          lines.push('exit code ' + result.status + (result.timedOut ? ' (KILLED at the ' + Math.round(timeoutMs / 1000) + ' s deadline)' : '') + ' · ' + formatMilliseconds(elapsed))
          if (promptId !== '') lines.push('prompt_id: ' + promptId)
          const explained = explainCliFailure(text)
          if (explained !== '') lines.push('', explained)
          const tail = text.split('\n').slice(-24).join('\n')
          if (tail !== '') lines.push('', tail)
          if (args.download === true && promptId !== '' && result.status === 0) {
            const outDir = path.join(path.dirname(workflowFile), 'outputs')
            const fetched = await deps.runner([command, 'download', promptId, '-o', outDir], { timeoutMs: 300000, env })
            lines.push('', 'comfy download -> ' + outDir + ' · exit code ' + (fetched === null ? 'n/a' : fetched.status) + (fetched !== null && String(fetched.stdout ?? '').trim() !== '' ? '\n' + String(fetched.stdout).trim().split('\n').slice(-10).join('\n') : ''))
          } else if (promptId !== '') {
            lines.push('', 'the CLI submitted the job itself; `comfy download ' + promptId + ' -o <dir>` fetches the files, or pass download:true.')
          }
          lines.push('', 'Rung: ' + (result.status === 0 ? 'v4-executed via comfy-cli' : 'v0-failed via comfy-cli') + ' — the CLI converted the canvas, submitted it and waited, so this is an independent run of the graph comfy_project generated.')
          return { text: lines.join('\n'), view: { ok: result.status === 0, rung: result.status === 0 ? 'v4-executed' : 'v0-failed', exitCode: result.status, elapsedMs: elapsed, promptId, workflow: workflowFile, workspace: where.workspace, explanation: explained, timedOut: result.timedOut === true } }
        }

        if (action === 'launch') {
          const timeoutMs = (Number.isFinite(args.timeoutSeconds) ? Math.min(900, Math.max(10, args.timeoutSeconds)) : 120) * 1000
          const where = await workspaceFor()
          const result = await deps.runner(launchArgv(command, { workspace: where.workspace }), { timeoutMs, env })
          const text = (String(result.stdout ?? '') + '\n' + String(result.stderr ?? '')).trim()
          if (result === null || result.status === null) return refusal('CLI_FAILED', 'comfy did not start: ' + (result === null ? 'no result' : result.error ?? 'unknown') + '.')
          const probe = await findServer(deps, { timeoutMs: 5000, signal: exec && exec.signal })
          const lines = ['comfy launch --background · exit code ' + result.status + (result.timedOut ? ' (timed out)' : '')]
          if (where.why !== '') lines.push('  ' + where.why + (where.workspace === '' ? '' : ': ' + where.workspace))
          const explained = explainCliFailure(text)
          if (explained !== '') lines.push('', explained)
          if (text !== '') lines.push('', text.split('\n').slice(-16).join('\n'))
          lines.push('')
          if (probe.server !== null) lines.push('A server answers now at ' + probe.server.origin + (probe.server.version === '' ? '' : ' · ComfyUI ' + probe.server.version) + '. `comfy_status` and `comfy_run` can use it.')
          else lines.push('No server answered yet at ' + probe.probed.map((entry) => entry.origin).join(', ') + '. A background launch loads models on first use, so give it a moment and call `comfy_status`.')
          return { text: lines.join('\n'), view: { ok: result.status === 0, exitCode: result.status, server: probe.server, probed: probe.probed, workspace: where.workspace } }
        }

        if (action === 'stop') {
          const result = await deps.runner(stopArgv(command), { timeoutMs: 60000, env })
          const text = (String(result.stdout ?? '') + '\n' + String(result.stderr ?? '')).trim()
          return {
            text: 'comfy stop · exit code ' + (result === null ? 'n/a' : result.status) + (text === '' ? '' : '\n\n' + text.split('\n').slice(-12).join('\n')),
            view: { ok: result !== null && result.status === 0, exitCode: result === null ? null : result.status },
          }
        }
        return refusal('BAD_ARGUMENT', 'action must be one of status, deps, run, launch, stop.')
      } catch (error) {
        return failureOf(error)
      }
    },
  }
  return [status, nodes, project, validate, run, test, cli]
}

/** Every string a deps file lists under a matching key, deduplicated. */
function collectNames(value, keyPattern, depth = 0) {
  const found = []
  if (value === null || typeof value !== 'object' || depth > 4) return found
  for (const [key, entry] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const list = Array.isArray(entry) ? entry : [entry]
      for (const item of list) {
        if (typeof item === 'string' && item !== '') found.push(item)
        else if (item !== null && typeof item === 'object') {
          const name = typeof item.name === 'string' ? item.name : typeof item.id === 'string' ? item.id : typeof item.url === 'string' ? item.url : ''
          if (name !== '') found.push(name)
        }
      }
      continue
    }
    if (entry !== null && typeof entry === 'object') found.push(...collectNames(entry, keyPattern, depth + 1))
  }
  return [...new Set(found)]
}
