/**
 * dsh-image-upscale — Node half.
 *
 * One row, four tools, no route and no browser half: enlarging an image is a
 * host question ("make this file bigger without making it worse?") and the answer
 * is a file on disk, so there is nothing for the right bar to draw.
 *
 * Why the row exists: upscaling is the one image operation the harness has no
 * tool for, and doing it by hand means a shell command that downloads a wheel,
 * a model and 2 GB of CUDA that the machine may already have. What this row adds
 * is the DISCOVERY of what is already here — a Python with torch, a GPU, a 4.7 MB
 * model — and four tools that make the result a new file with its numbers
 * attached.
 *
 * What it deliberately does not do:
 *
 *   - **bundle an engine.** No binary, no weights, no wheel: the machine's own
 *     Python and torch, the same way dsh-ocr uses the machine's tesseract;
 *   - **download on its own.** The one network call is `upscale_fetch_weights`,
 *     and it refuses until `confirm` repeats the model's name;
 *   - **replace an image.** Every write is a NEW file; `overwrite` exists and is
 *     off by default, because the point of an upscale is a second copy.
 *
 * The engine probe costs a torch import (seconds), so it is resolved once per
 * boot and cached here; a conversation that enlarges ten images pays once.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultWeightsDir, engine } from './python.js'
import { buildTools } from './tools.js'

export const name = 'dsh-image-upscale'

export const inject = ['tools']

/** Keep in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The one skill this row ships, as a file beside this module. */
const SKILL_FILES = [{ name: 'image-upscale', file: '../skills/image-upscale/SKILL.md' }]

/** The capabilities the README states. */
export const CAPABILITIES = {
  tools: ['upscale_info', 'upscale_image', 'upscale_batch', 'upscale_fetch_weights'],
  routes: [],
  models: ['realesr-general-x4v3', 'realesr-animevideov3', 'RealESRGAN_x4plus', 'RealESRGAN_x2plus'],
  formats: ['jpg', 'png', 'webp'],
  caps: {
    imageTimeoutMs: 300000,
    batchTimeoutMs: 3600000,
    maxScale: 8,
    maxTargetWidth: 16384,
    tileThresholdPixels: 1400000,
  },
  notBuilt: ['install', 'a bundled engine', 'automatic download', 'replacing the original', 'upscaling SVG'],
}

/**
 * The plugin's shared dependencies, one per boot.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ env, platform, dshHome }`, for the checks.
 */
export function createDeps(ctx, options = {}) {
  const env = options.env ?? process.env
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-image-upscale] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-image-upscale] ' + text),
  }
  const weightsDir = () => options.weightsDir ?? defaultWeightsDir(options.dshHome ?? env.DSH_HOME)
  return {
    ctx,
    env,
    log,
    weightsDir,
    /** The engine probe, cached by `python.js` across calls and rows. */
    engine: (extra = {}) => engine({ env, platform: options.platform, weightsDir: weightsDir(), ...extra }),
  }
}

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
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/**
 * Register the bundled skill. The registry is resolved lazily: its absence only
 * skips the skill, never the tools.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled image-upscale skill was not registered')
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
            provider: 'dsh-image-upscale',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-image-upscale: skill ' + skillName,
      )
      count += 1
    } catch (error) {
      log.warn('could not register skill ' + entry.name + ': ' + String(error && error.message))
    }
  }
  return count
}

/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  const tools = buildTools(deps)
  log1(ctx, 'active: 4 tools over the machine\'s own Python + torch; weights in ' + deps.weightsDir())
  const skillCount = registerSkills(ctx, deps.log)
  if (skillCount > 0) log1(ctx, 'registered ' + skillCount + ' bundled skill(s)')
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-image-upscale: tool ' + tool.name)
  }
}

function log1(ctx, text) {
  ctx.logger?.info?.('[dsh-image-upscale] ' + text)
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  CAPABILITIES,
  PLUGIN_VERSION,
  registerSkills,
  parseSkillFile,
}
