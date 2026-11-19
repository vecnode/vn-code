/**
 * dsh-rust-dev — Node half.
 *
 * One row, six tools, no browser surface and no route. "What does this workspace
 * need, and why did it break" is a host question whose answer is prose and
 * numbers, so there is nothing for the right bar to draw - the same shape as
 * `dsh-sql-server` and `dsh-ollama`, not like `dsh-docker`.
 *
 * WHY IT EXISTS: every harness can already RUN `cargo`. What none of them can do
 * is hand a reader the SHAPE of the failure - six distinct diagnostics instead of
 * eleven hundred lines, the four facts that fail independently on a Rust machine,
 * the crate that is compiled twice, or which frames of a backtrace are the
 * caller's own. That is what this row is for, and it is why the skills ship with
 * it: the tools answer, the skills teach the triage order.
 *
 * WHAT IT IS NOT: not a toolchain installer (no `rustup toolchain install`, no
 * `cargo install` - it prints the command), not a registry client (every cargo
 * call is `--offline` until the caller passes `fetch: true`), not a language
 * server (rust-analyzer is reported by `rust_status`, never driven), and not a
 * replacement for the harness's own shell.
 *
 * Zero npm dependencies, nothing bundled, no network egress of its own: cargo,
 * rustc and rustup are the user's own programs.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTools, LIMITS } from './tools.js'

export const name = 'dsh-rust-dev'
export const inject = ['tools']

/** Kept in step with package.json. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The four skills, as files beside this module. */
export const SKILL_FILES = [
  { name: 'rust-workspaces', file: '../skills/rust-workspaces/SKILL.md' },
  { name: 'rust-diagnostics', file: '../skills/rust-diagnostics/SKILL.md' },
  { name: 'rust-debugging', file: '../skills/rust-debugging/SKILL.md' },
  { name: 'rust-ui-apps', file: '../skills/rust-ui-apps/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['rust_status', 'cargo_check', 'cargo_test', 'cargo_build', 'rust_deps', 'rust_backtrace'],
  skills: SKILL_FILES.map((entry) => entry.name),
  limits: { ...LIMITS },
  notBuilt: [
    'installing a toolchain, a component or a crate',
    'fetching from the registry unless the caller passes fetch: true',
    'driving rust-analyzer as a language server',
    'cargo publish / any registry write',
    'a UI tab (host-only row)',
  ],
}

/**
 * The row's dependencies, one per boot.
 *
 * `cwd` and `runner` are injectable so the package check can drive the tools in a
 * fixture workspace without chdir, and `log` is injectable so a check can assert
 * what the activation line said.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ cwd, env, log }`.
 */
export function createDeps(ctx, options = {}) {
  return {
    ctx,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    log: options.log ?? {
      warn: (text) => ctx.logger?.warn?.('[dsh-rust-dev] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-rust-dev] ' + text),
    },
  }
}

/**
 * The one activation line.
 *
 * It probes NOTHING: a `cargo --version` per harness start is a child process
 * nobody asked for, and a machine without a toolchain would print the same line
 * either way. `rust_status` is the tool that asks.
 */
export function activationLine() {
  return (
    'active: six rust_* / cargo_* tools over this machine\'s own cargo, rustc and rustup, plus four skills; ' +
    'nothing is built, fetched or installed until a tool is called - ask `rust_status` first'
  )
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/** Split one skill document into its frontmatter and its body. */
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

/** Register the bundled skills; a missing registry skips the skills, never the tools. */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the four bundled rust skills were not registered')
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
            provider: 'dsh-rust-dev',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-rust-dev: skill ' + skillName,
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
  deps.log.info(activationLine())
  const skillCount = registerSkills(ctx, deps.log)
  deps.log.info('registered ' + skillCount + ' bundled skill(s)')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-rust-dev: tool ' + tool.name)
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
  LIMITS,
}
