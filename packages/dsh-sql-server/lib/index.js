/**
 * dsh-sql-server — Node half.
 *
 * One row, seven tools, two bundled skills, no route and no browser tab. "Is there
 * a SQL Server on this machine, and which driver does the application connect
 * with" is a host question whose answer is prose and numbers, so there is nothing
 * for the right bar to draw: the same shape as `dsh-ollama` and `dsh-wsl`.
 *
 * WHY IT EXISTS: this pack could already drive Docker (`dsh-docker`) and already
 * taught a page to speak to a database from JavaScript (`dsh-research`'s ledgers).
 * Neither could answer the question a person actually asks when they clone a
 * repository that expects SQL Server - "what do I run on THIS machine, and why does
 * `pyodbc` still fail after the container is up" - because the answer spans a
 * container, a client, a TCP port and a MACHINE-WIDE ODBC DRIVER, and the fourth is
 * installed by an MSI that needs an administrator.
 *
 * WHAT IT IS NOT: not a migration tool, not a schema author, not a backup
 * scheduler. It creates ONE database and loads dumps; everything else it reports.
 *
 * Zero npm dependencies, no engine bundled, no network egress of its own: the
 * server is the user's own container or their own instance, and the image is
 * pulled by the container CLI they already installed.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './cli.js'
import { odbcDrivers } from './discover.js'
import { driverState } from './driver.js'
import { buildTools } from './tools.js'
import { CAPS } from './validate.js'

export const name = 'dsh-sql-server'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The two skills this row ships, as files beside this module. */
export const SKILL_FILES = [
  { name: 'sql-server-ops', file: '../skills/sql-server-ops/SKILL.md' },
  { name: 'sql-script-ingest', file: '../skills/sql-script-ingest/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['sql_status', 'sql_server', 'sql_driver', 'sql_query', 'sql_script', 'sql_database', 'sql_restore'],
  skills: SKILL_FILES.map((entry) => entry.name),
  transports: ['container (docker exec + the image\'s own sqlcmd)', 'host (sqlcmd on PATH)'],
  actions: { sql_server: ['status', 'start', 'stop', 'restart', 'remove', 'logs'], sql_driver: ['status', 'plan', 'install'], sql_database: ['list', 'create', 'tables', 'columns', 'count'] },
  caps: { ...CAPS },
  notBuilt: ['a native SQL Server install', 'backups', 'schema authoring beyond CREATE DATABASE', 'a browser tab', 'schema/data diffing'],
}

/**
 * The row's shared dependencies, one per boot.
 *
 * Every side effect is injectable so the package's check can drive every branch
 * without a server: `runner` is the process runner, `sleep` is the readiness
 * poll's clock, and the two ODBC reads are functions so a scripted answer can
 * stand in for a registry.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ env, platform, runner, sleep, odbcDrivers, driverState }`.
 */
export function createDeps(ctx, options = {}) {
  const deps = {
    ctx: ctx,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    runner: options.runner ?? runProcess,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-sql-server] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-sql-server] ' + text),
    },
  }
  deps.odbcDrivers = options.odbcDrivers ?? (() => odbcDrivers(deps))
  deps.driverState = options.driverState ?? (() => driverState(deps))
  return deps
}

/**
 * The one activation line.
 *
 * It does NOT probe: a `docker ps` or a registry read at every harness start is a
 * process per boot for a fact nobody asked for, and a machine with no SQL Server
 * would print the same happy line either way. `sql_status` is the tool that asks.
 */
export function activationLine() {
  return 'active: seven sql_* tools (status, server, driver, query, script, database, restore) over the container this row owns or the sqlcmd on this PATH; ask `sql_status` what this machine has - the ODBC driver is the half a container cannot give you'
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
 * skips the skills, never the tools) and the installers also copy the folders into
 * `$DSH_HOME/skills`, so a host without the registry still gets them from the
 * filesystem provider.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the two bundled sql skills were not registered')
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
            provider: 'dsh-sql-server',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-sql-server: skill ' + skillName,
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
    ctx.effect(() => ctx.tools.register(tool), 'dsh-sql-server: tool ' + tool.name)
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
