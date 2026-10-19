/**
 * dsh-docker — Node half.
 *
 * One row, nine tools, eight routes and one browser tab. The row exists because
 * a container engine is the one thing a developer's machine has that neither the
 * harness nor this pack could see: it is a program on PATH with a daemon behind
 * it, and the agent's shell tool can already call it - badly and unsafely, one
 * free-form string at a time.
 *
 * What this row adds, and what it deliberately does not:
 *
 *   - **the CLI is the API.** No socket to `dockerd`, no HTTP client, no
 *     re-implementation of contexts. `docker` (or `podman`, which speaks the same
 *     dialect for every verb here) is what runs, with an argv array and no shell;
 *   - **an engine state, not an error.** "Docker Desktop is closed" is the normal
 *     state on Windows 11 and macOS, so it is a first-class answer and
 *     `docker_start` is the action that fixes it;
 *   - **a validated command surface.** Nine tools, a fixed verb set, every value
 *     checked against a positive grammar, removals confirmed by repeating the
 *     target, and no `exec`, no `system prune` and no free-form `run`;
 *   - **a tab.** `docker_state`'s answer is rendered as a surface a person can
 *     click: containers, images, logs, inspect, start/stop/remove, pull and run.
 *
 * The routes are `/api/dsh-docker/*`, exact paths, behind the harness's session
 * check (the connection service mounts them), and they are the tab's only door.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess } from './cli.js'
import { detectCli, engineInfo, spawnDetached, startEngine, startPlanFor } from './engine.js'
import { DockerError, actOn, inspectTarget, listContainers, listImages, logsOf, pruneDangling, pullImage, runImage, stateView } from './docker.js'
import { errorToResponse, httpError, json, readJsonBody } from './http.js'
import { buildTools } from './tools.js'

export const name = 'dsh-docker'

export const inject = ['connection', 'tools']

/** Keep in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** Every route this row owns; the client bundle hard-codes the same strings. */
const API_ROOT = '/api/dsh-docker'
export const STATE_ROUTE = API_ROOT + '/state'
export const LOGS_ROUTE = API_ROOT + '/logs'
export const INSPECT_ROUTE = API_ROOT + '/inspect'
export const ACTION_ROUTE = API_ROOT + '/action'
export const PULL_ROUTE = API_ROOT + '/pull'
export const RUN_ROUTE = API_ROOT + '/run'
export const START_ROUTE = API_ROOT + '/start'
export const HEALTH_ROUTE = API_ROOT + '/health'
export const API_ROUTES = [STATE_ROUTE, LOGS_ROUTE, INSPECT_ROUTE, ACTION_ROUTE, PULL_ROUTE, RUN_ROUTE, START_ROUTE, HEALTH_ROUTE]

/** The one skill this row ships, as a file beside this module. */
const SKILL_FILES = [{ name: 'docker-cli', file: '../skills/docker-cli/SKILL.md' }]

/** The capabilities both the health route and the README state. */
export const CAPABILITIES = {
  tools: ['docker_state', 'docker_ps', 'docker_images', 'docker_inspect', 'docker_logs', 'docker_pull', 'docker_run', 'docker_action', 'docker_start'],
  routes: API_ROUTES,
  engines: ['docker', 'podman'],
  actions: ['start', 'stop', 'restart', 'pause', 'unpause', 'remove', 'prune'],
  caps: { readTimeoutMs: 15000, actionTimeoutMs: 60000, pullTimeoutMs: 900000, maxStreamBytes: 1048576, maxTail: 2000 },
  notBuilt: ['exec', 'system prune', 'compose', 'volume remove', 'network create'],
}

/** One error's message, whatever was thrown. */
function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

/**
 * The row's dependencies, one per boot.
 *
 * Every side effect is injectable so the package's check can drive every branch
 * without a docker on the machine: `runner` is the process runner, `sleep` is
 * the start poll's clock, `spawnDetached` launches a GUI app, and `exists` is
 * what the Docker Desktop path check uses.
 *
 * @param ctx - the plugin context (inject: connection, tools).
 * @param options - `{ env, platform, runner, spawnDetached, sleep, exists }`.
 */
export function createDeps(ctx, options = {}) {
  return {
    ctx: ctx,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    runner: options.runner ?? runProcess,
    spawnDetached: options.spawnDetached ?? spawnDetached,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    exists: options.exists ?? existsSync,
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-docker] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-docker] ' + text),
    },  }
}

/**
 * The one activation line.
 *
 * It does NOT probe the engine: spawning `docker --version` at every harness
 * start would be a process per boot for a fact nobody asked for, and a machine
 * whose Docker Desktop is closed would print the same happy line either way.
 * `docker_state` is the tool that asks.
 */
export function activationLine() {
  return 'active: the docker CLI (or podman when docker is absent) as nine tools and one tab; ask `docker_state` whether this machine\'s engine is up'
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
 * Register the bundled skill. The registry is resolved lazily (its absence only
 * skips the skill, never the tools) and the installers also copy the file into
 * `$DSH_HOME/skills`, so a host without the registry still gets the entry from
 * the filesystem provider.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled docker-cli skill was not registered')
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
            provider: 'dsh-docker',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-docker: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** The one search-param boolean, with its default. */
function flag(url, name, fallback) {
  const value = url.searchParams.get(name)
  if (value === null) return fallback
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Register every route on the connection's fetch registry.
 *
 * @param deps - the row's dependencies.
 * @returns a disposer that unregisters everything.
 */
export function registerRoutes(deps) {
  const connection = typeof deps.ctx.get === 'function' ? deps.ctx.get('connection') : undefined
  if (connection === null || connection === undefined || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-docker/* routes were not registered')
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods: methods,
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            return errorToResponse(err)
          }
        },
      }),
    )
  }

  /** The engine, its containers, its images; `?disk=1` adds `system df`. */
  register(STATE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const view = await stateView(deps, { disk: flag(url, 'disk', false), all: flag(url, 'all', true) })
    return json(200, view)
  })

  /** One container's tail. */
  register(LOGS_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const { cli } = await ensureForRoute(deps)
    const found = await logsOf(deps, cli, { id: url.searchParams.get('id') ?? '', tail: url.searchParams.get('tail') ?? undefined, since: url.searchParams.get('since') ?? '' })
    return json(200, { ok: true, ...found })
  })

  /** One container or image, summarised. */
  register(INSPECT_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const { cli } = await ensureForRoute(deps)
    const kind = url.searchParams.get('kind') ?? ''
    const found = await inspectTarget(deps, cli, { id: url.searchParams.get('id') ?? '', kind: kind === 'image' || kind === 'container' ? kind : '' })
    return json(200, { ok: true, kind: found.kind, facts: found.facts })
  })

  /** A lifecycle action, a removal or a prune. */
  register(ACTION_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'BAD_BODY', 'The action route takes a JSON object.')
    const { cli } = await ensureForRoute(deps)
    const verb = String(body.action === undefined ? '' : body.action).toLowerCase()
    if (verb === 'prune') {
      const done = await pruneDangling(deps, cli, { kind: body.kind, confirm: body.confirm })
      return json(200, { ok: true, action: 'prune', kind: done.kind, text: done.text })
    }
    const done = await actOn(deps, cli, { action: verb, kind: body.kind, id: body.id, confirm: body.confirm, force: body.force === true })
    return json(200, { ok: true, action: done.action, kind: done.kind, id: done.id, text: done.text })
  })

  /** `docker pull`. */
  register(PULL_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'BAD_BODY', 'The pull route takes a JSON object.')
    const { cli } = await ensureForRoute(deps)
    const done = await pullImage(deps, cli, { image: body.image })
    return json(200, { ok: true, image: done.image, elapsedMs: done.elapsedMs, text: done.text })
  })

  /** `docker run`, from a validated spec. */
  register(RUN_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'BAD_BODY', 'The run route takes a JSON object.')
    const { cli } = await ensureForRoute(deps)
    const started = await runImage(deps, cli, body)
    return json(200, { ok: true, id: started.id, image: started.image, name: started.name, text: started.text })
  })

  /** Start the engine (Docker Desktop / podman machine) and wait for its daemon. */
  register(START_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const seconds = Number(body === null || body === undefined ? undefined : body.waitSeconds)
    const cli = await detectCli(deps)
    if (cli === null) throw new DockerError('NO_CLI', 'No `docker` or `podman` CLI on PATH, so there is no engine this plugin can start.')
    const before = await engineInfo(deps, cli)
    if (before.daemon === 'up') return json(200, { ok: true, started: false, engine: before, already: true })
    const plan = await startPlanFor(deps, cli)
    if (plan.kind === '') return json(200, { ok: false, started: false, plan: { kind: '', label: '', hint: plan.hint }, engine: before, message: plan.hint })
    const started = await startEngine(deps, cli, { waitMs: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined })
    return json(200, {
      ok: started.ok === true,
      started: started.started === true,
      waitedMs: started.waitedMs ?? 0,
      plan: { kind: started.plan.kind, label: started.plan.label, hint: started.plan.hint },
      engine: started.info ?? before,
      message: started.message ?? '',
    })
  })

  /** What this row offers, for a client that found the route before the tab. */
  register(HEALTH_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, plugin: name, version: PLUGIN_VERSION, ...CAPABILITIES }))

  return () => {
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch (err) {
        /* an unregister that throws must not stop the others */
      }
    }
  }
}

/** The CLI and a live engine for one route, with the refusal as a typed error. */
async function ensureForRoute(deps) {
  const cli = await detectCli(deps)
  if (cli === null) throw new DockerError('NO_CLI', 'No `docker` or `podman` CLI on PATH on this machine.')
  const info = await engineInfo(deps, cli)
  if (info.daemon !== 'up') {
    throw new DockerError('ENGINE_DOWN', 'The ' + info.cli + ' engine is not answering: ' + (info.reason === '' ? 'no server object.' : info.reason))
  }
  return { cli: cli, info: info }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info(activationLine())
  const skillCount = registerSkills(ctx, deps.log)
  deps.log.info('registered ' + skillCount + ' bundled skill(s)')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-docker: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes(deps), 'dsh-docker: routes')
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  registerRoutes,
  registerSkills,
  parseSkillFile,
  activationLine,
  stateView,
  listContainers,
  listImages,
  inspectTarget,
  logsOf,
  pullImage,
  runImage,
  actOn,
  pruneDangling,
  detectCli,
  engineInfo,
  startPlanFor,
  startEngine,
  API_ROUTES,
  CAPABILITIES,
}
