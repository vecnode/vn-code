/**
 * dsh-huggingface — Node half.
 *
 * One row, five tools, no browser surface and no route. "What does this repo
 * weigh and do I already have it" is a host question whose answer is a table and
 * a verdict, so there is nothing for the right bar to draw and nothing to serve -
 * the same shape as `dsh-ollama` and `dsh-image-upscale`.
 *
 * WHY IT EXISTS: a Hub repo directory is a directory like any other on disk, so a
 * listing says `models--lukey03--Qwen3.5-9B-abliterated` and stops there. It does
 * not say that the entry is 17.9 GB, that forty of the fifty entries on this
 * machine are a config.json and nothing else, that the repo's licence is gated,
 * or that the cached revision is three commits behind the Hub's. Those are the
 * facts a person needs BEFORE 18 GB of bandwidth, and nothing in the pack read
 * them. The CLI's own `cache ls --json` answers in human strings ("17.9G",
 * "3 months ago"), which is why the scan here is of the directory tree.
 *
 * WHAT IT IS NOT: not a downloader that acts on its own (the only bytes-moving
 * call needs `confirm` and a ceiling), not a client for the Hub API (the user's
 * own `hf` does the talking, and its `--format json` is the contract), not a
 * model runner (that is `dsh-transformers` / `dsh-ollama`), and not a cache
 * cleaner that acts silently (an unconfirmed removal is the CLI's own dry run).
 *
 * Zero npm dependencies, no engine bundled, no socket, and no network egress of
 * its own: every call is one the caller asked for.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './cli.js'
import { resolveCacheRoot } from './paths.js'
import { buildTools } from './tools.js'
import { CAPS } from './validate.js'

export const name = 'dsh-huggingface'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The two skills, as files beside this module. */
export const SKILL_FILES = [
  { name: 'huggingface-hub', file: '../skills/huggingface-hub/SKILL.md' },
  { name: 'huggingface-cache', file: '../skills/huggingface-cache/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['hf_status', 'hf_search', 'hf_repo', 'hf_cache', 'hf_download'],
  env: ['DSH_HF_CLI', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'HF_HOME', 'TRANSFORMERS_CACHE', 'HF_TOKEN', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'],
  skills: SKILL_FILES.map((entry) => entry.name),
  caps: { ...CAPS },
  notBuilt: ['uploading', 'creating or deleting repos on the Hub', 'a chat or inference surface', 'reading, echoing or accepting a token', 'running the CLI\'s own updater'],
}

/**
 * The row's shared dependencies, one per boot.
 *
 * `runner` is injectable so the package check can drive every branch with a fake
 * CLI and assert the exact argv, which is the only way to prove the `-y` and
 * `--dry-run` decisions without deleting somebody's cache.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ env, runner, now, platform }`.
 */
export function createDeps(ctx, options = {}) {
  return {
    ctx,
    env: options.env ?? process.env,
    runner: options.runner ?? runProcess,
    now: options.now ?? (() => Date.now()),
    platform: options.platform ?? process.platform,
    cache: {},
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-huggingface] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-huggingface] ' + text),
    },
  }
}

/**
 * The one activation line.
 *
 * It does NOT resolve the CLI (that is one child process nobody asked for at
 * boot) and does not read the cache: it names where the cache would be, and
 * `hf_status` is the tool that answers what is in it.
 *
 * @param deps - the row's dependencies.
 */
export function activationLine(deps) {
  const root = resolveCacheRoot(deps.env)
  return (
    'active: five hf_* tools over the machine\'s own `hf` CLI; cache ' +
    root.root +
    ' (' + root.from + ')' +
    '; nothing is downloaded without `confirm`, and no token is ever read'
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
 * Register the bundled skills.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the two bundled huggingface skills were not registered')
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
            provider: 'dsh-huggingface',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-huggingface: skill ' + skillName,
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
    ctx.effect(() => ctx.tools.register(tool), 'dsh-huggingface: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  registerSkills,
  parseSkillFile,
  activationLine,
  CAPABILITIES,
  PLUGIN_VERSION,
  SKILL_FILES,
}
