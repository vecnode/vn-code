/**
 * dsh-ollama — Node half.
 *
 * One row, five tools, no browser surface and no route. "What did this model do
 * on this machine" is a host question whose answer is numbers and prose, so
 * there is nothing for the right bar to draw and nothing to serve - the same
 * shape as `dsh-wsl` and `dsh-ocr`.
 *
 * WHY IT EXISTS: every surface in this pack can CALL a model; none can tell a
 * reader that `qwen2.5:7b` did 41.2 tok/s here at 8k context with a 3.1 s cold
 * load, that a second run's first token arrives sooner because the weights
 * stayed resident, or that a number was taken at temperature 0 with a fixed
 * seed on a stated digest. Ollama reports exactly those fields in every
 * response and nothing in the pack read them.
 *
 * WHAT IT IS NOT: not a second conversation (no chat UI), not a model manager
 * beyond list/show/pull/delete, not a remote-inference client (the loopback
 * fence in `client.js` is a refusal, not a default), and not a daemon starter -
 * `ollama_status` names the command that starts one.
 *
 * Zero npm dependencies, no engine bundled, no network egress of its own: the
 * daemon is the user's own service at `127.0.0.1:11434`, and the skills teach
 * their own code against it.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './cli.js'
import { resolveHost } from './client.js'
import { buildTools } from './tools.js'
import { CAPS } from './validate.js'

export const name = 'dsh-ollama'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The three skills, as files beside this module. */
export const SKILL_FILES = [
  { name: 'ollama-api', file: '../skills/ollama-api/SKILL.md' },
  { name: 'ollama-inference-metrics', file: '../skills/ollama-inference-metrics/SKILL.md' },
  { name: 'ollama-python', file: '../skills/ollama-python/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['ollama_status', 'ollama_run', 'ollama_bench', 'ollama_models', 'ollama_embed'],
  endpoints: ['/api/version', '/api/tags', '/api/ps', '/api/show', '/api/generate', '/api/chat', '/api/embed', '/api/embeddings', '/api/pull', '/api/delete'],
  skills: SKILL_FILES.map((entry) => entry.name),
  caps: { ...CAPS },
  notBuilt: ['starting or stopping the daemon', 'model create / copy / push', 'a chat UI', 'routing OpenAI-compatible traffic through this row', 'remote inference by default'],
}

/**
 * The row's shared dependencies, one per boot.
 *
 * Every side effect is injectable so the package's check can drive every branch
 * without a daemon: `fetch` and `now` are the transport and the clock, `runner`
 * is the bounded child process behind the CLI version, and `cache` is the
 * short-lived model list that keeps one answer to one request.
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
    cache: { tags: null, tagsAt: 0, show: new Map() },
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-ollama] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-ollama] ' + text),
    },
  }
}

/**
 * The one activation line.
 *
 * It does NOT probe the daemon: a request per harness start is a request nobody
 * asked for, and a machine whose Ollama is not running would print the same
 * happy line either way. `ollama_status` is the tool that asks.
 *
 * @param deps - the row's dependencies.
 */
export function activationLine(deps) {
  const config = resolveHost(deps.env)
  if (!config.allowed) {
    return 'inert: ' + config.reason
  }
  return (
    'active: five ollama_* tools over ' +
    (config.raw === '' ? config.origin : config.origin + ' (OLLAMA_HOST=' + config.raw + ')') +
    (config.remote ? ', a daemon on ANOTHER machine (allowed by DSH_OLLAMA_ALLOW_REMOTE=1)' : ', this machine\'s own daemon (loopback)') +
    '; nothing is started - ask `ollama_status` whether it is up'
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
 * Register the bundled skills. The registry is resolved lazily (its absence
 * only skips the skills, never the tools) and the installers also copy the
 * folders into `$DSH_HOME/skills`, so a host without the registry still gets
 * them from the filesystem provider.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the three bundled ollama skills were not registered')
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
            content: content,
            provider: 'dsh-ollama',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-ollama: skill ' + skillName,
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
    ctx.effect(() => ctx.tools.register(tool), 'dsh-ollama: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  registerSkills,
  parseSkillFile,
  activationLine,
  resolveHost,
  CAPABILITIES,
  PLUGIN_VERSION,
  SKILL_FILES,
}
