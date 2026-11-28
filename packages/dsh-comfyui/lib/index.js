/**
 * dsh-comfyui — Node half.
 *
 * One row, seven tools, four bundled skills, no browser surface and no route.
 * "Which node class does this graph name that the server does not have, and
 * which widget value is not in its list" is a host question whose answer is a
 * graph, a JSON file and prose - so there is nothing for the right bar to draw
 * and nothing to serve, the same shape as `dsh-ollama` and `dsh-docker`.
 *
 * WHY IT EXISTS: ComfyUI is a graph editor, and a graph is a file with two
 * dialects that are not interchangeable - the CANVAS the app saves (numeric ids,
 * links as array positions, `widgets_values` as an UNNAMED positional array that
 * shifts by one when a class declares `control_after_generate`) and the API
 * PROMPT `/prompt` accepts (ids as keys, wires as `[id, slot]`). Nothing in the
 * harness can turn one into the other, nothing can tell a reader "this class does
 * not exist on this server", and nothing can say which of the two things a
 * workflow does wrong: fail to open, or fail to run. This row answers those, and
 * then runs the graph and reports what came out.
 *
 * WHAT IT IS NOT: not a UI for ComfyUI (the app is the UI), not a model
 * downloader, not a node-package installer (both change a person's machine; the
 * skills name the commands and the person decides), and not a second queue -
 * `comfy_run` submits to the user's own server and waits for its own prompt.
 *
 * Zero npm dependencies, no engine bundled, no network egress of its own: the
 * server is the user's own ComfyUI on loopback, and `comfy_cli` drives the
 * user's own comfy-cli.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './cli.js'
import { resolveServers, DEFAULT_PORT, DESKTOP_PORTS, cacheRoot } from './client.js'
import { buildTools } from './tools.js'

export const name = 'dsh-comfyui'
export const inject = ['tools']

/** Kept in step with package.json by the package's own check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The six skills, as files beside this module. */
export const SKILL_FILES = [
  { name: 'comfyui-fundamentals', file: '../skills/comfyui-fundamentals/SKILL.md' },
  { name: 'comfyui-workflow-json', file: '../skills/comfyui-workflow-json/SKILL.md' },
  { name: 'comfyui-api', file: '../skills/comfyui-api/SKILL.md' },
  { name: 'comfyui-cli', file: '../skills/comfyui-cli/SKILL.md' },
  { name: 'comfyui-node-class', file: '../skills/comfyui-node-class/SKILL.md' },
  { name: 'comfyui-projects', file: '../skills/comfyui-projects/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['comfy_status', 'comfy_nodes', 'comfy_project', 'comfy_validate', 'comfy_run', 'comfy_test', 'comfy_cli'],
  endpoints: ['/system_stats', '/object_info', '/object_info/{class}', '/prompt', '/history', '/history/{prompt_id}', '/queue', '/view', '/models', '/models/{folder}', '/upload/image', '/embeddings', '/features', '/api/jobs'],
  skills: SKILL_FILES.map((entry) => entry.name),
  rungs: ['v1-structural', 'v2-schema', 'v3-queued', 'v4-executed'],
  examples: ['smoke-image', 'smoke-video', 'text-to-image', 'image-to-image'],
  projectFiles: ['project.json', 'workflow.json', 'prompt.json', 'README.md', 'build.json'],
  notBuilt: [
    'a ComfyUI UI of its own',
    'installing ComfyUI, a custom node pack or a model',
    'starting a server except through comfy-cli (`comfy launch --background`)',
    'the WebSocket feed (this row polls /history)',
    'remote servers unless DSH_COMFYUI_ALLOW_REMOTE=1',
    'lowering a subgraph export (it names the ungroup step instead)',
  ],
}

/**
 * The row's shared dependencies, one per boot.
 *
 * `fetch`, `now`, `sleep` and `runner` are injectable so the package check can
 * drive every branch without a server and without a CLI: a fake ComfyUI answers
 * the routes, and a fake runner answers `comfy --version`.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ env, fetch, now, sleep, runner, platform }`.
 */
export function createDeps(ctx, options = {}) {
  return {
    ctx,
    env: options.env ?? process.env,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? (() => performance.now()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    runner: options.runner ?? runProcess,
    platform: options.platform ?? process.platform,
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-comfyui] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-comfyui] ' + text),
    },
  }
}

/**
 * The one activation line.
 *
 * It does NOT probe a server: a request per harness start is a request nobody
 * asked for, and a machine whose ComfyUI is closed would print the same happy
 * line either way. `comfy_status` is the tool that asks.
 *
 * @param deps - the row's dependencies.
 */
export function activationLine(deps) {
  const servers = resolveServers(deps.env)
  if (!servers.allowed) return 'inert: ' + servers.reason
  const where = servers.explicit ? servers.origins[0] : '127.0.0.1:' + DEFAULT_PORT + ' and the Desktop ports ' + DESKTOP_PORTS.join('/')
  return (
    'active: seven comfy_* tools over ' +
    where +
    (servers.remote ? ' (allowed by DSH_COMFYUI_ALLOW_REMOTE=1 - not this machine)' : ' (this machine)') +
    '; nothing is started - ask `comfy_status` whether a server answers, and `comfy_project` action=new writes a project with or without one'
  )
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * @param text - the file's contents.
 * @returns `{ meta, content }`.
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, content: normalized.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!entry) continue
    let value = entry[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    meta[entry[1]] = value
  }
  return { meta: meta, content: normalized.slice(match[0].length).trim() }
}

/**
 * Register the bundled skills. The registry is resolved lazily (its absence only
 * skips the skills, never the tools) and both installers also copy the folders
 * into `$DSH_HOME/skills`, so a host without the registry still gets them from
 * the filesystem provider.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the six bundled ComfyUI skills were not registered (the installers copy them into $DSH_HOME/skills)')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const file = fileURLToPath(new URL(entry.file, import.meta.url))
      const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
      if (content.length === 0) {
        log.warn('skill file is empty: ' + entry.file)
        continue
      }
      const skillName = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name
      ctx.effect(
        () =>
          skills.register({
            name: skillName,
            description: typeof meta.description === 'string' ? meta.description : '',
            whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
            content,
            provider: 'dsh-comfyui',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-comfyui: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + (err && err.message ? err.message : String(err)))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info(activationLine(deps))
  const skillCount = registerSkills(ctx, deps.log)
  deps.log.info('registered ' + skillCount + ' bundled skill(s)')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-comfyui: tool ' + tool.name)
  }
}

/** Exported for the package's check: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  registerSkills,
  parseSkillFile,
  activationLine,
  resolveServers,
  cacheRoot,
  CAPABILITIES,
  PLUGIN_VERSION,
  SKILL_FILES,
}
