/**
 * dsh-shaders — Node half.
 *
 * One row owns everything: the seven `shader_*` tools, the five bundled skills,
 * this conversation's shader store plus the shared library, a content-addressed
 * cache of rendered frames, and six authenticated routes - so it ships its
 * browser half with the Loader entry.
 *
 * WHAT IT IS NOT: not a render farm, not a shader host for other people's pages,
 * not a C++ toolchain (an FFGL plugin is emitted as a SCAFFOLD and never built),
 * and not a network client. The one child process it can start is the browser a
 * person already installed, argv-only, in a throwaway profile, with every name
 * resolved to NOTFOUND except loopback, and only when a tool asks for a compile.
 *
 * The rung ladder is the whole discipline: v1-static, v2-compiled, v3-drawn,
 * v4-measured - and an answer always says which rung it reached.
 */

import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runJobs } from './compile.js'
import { emit, TARGETS } from './emit.js'
import { getExample, listLinks, search, summary } from './kit.js'
import { MAX_ARTIFACT_FILES, ShaderStore, artifactDir, pruneArtifacts, storeRoot, verificationOf } from './store.js'
import { buildTools, verifySource } from './tools.js'
import { DIALECTS, assemble, detectDialect, lint, parseParams } from './verify.js'
import { resolveEngine } from './engine.js'

export const name = 'dsh-shaders'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The five skills, as files beside this module. */
export const SKILL_FILES = [
  { name: 'glsl-fundamentals', file: '../skills/glsl-fundamentals/SKILL.md' },
  { name: 'fragment-shaders', file: '../skills/fragment-shaders/SKILL.md' },
  { name: 'shader-web', file: '../skills/shader-web/SKILL.md' },
  { name: 'shader-isf-ffgl', file: '../skills/shader-isf-ffgl/SKILL.md' },
  { name: 'shader-debugging', file: '../skills/shader-debugging/SKILL.md' },
]

/** What this row offers, for the README and the package check. */
export const CAPABILITIES = {
  tools: ['shader_write', 'shader_verify', 'shader_render', 'shader_read', 'shader_publish', 'shader_target', 'shader_kit'],
  routes: ['/api/dsh-shaders/state', '/api/dsh-shaders/shader', '/api/dsh-shaders/example', '/api/dsh-shaders/artifact', '/api/dsh-shaders/render-report', '/api/dsh-shaders/health'],
  skills: SKILL_FILES.map((entry) => entry.name),
  dialects: DIALECTS,
  targets: TARGETS,
  rungs: ['v1-static', 'v2-compiled', 'v3-drawn', 'v4-measured'],
  notBuilt: ['compiling an FFGL binary', 'a desktop-GLSL compiler', 'hosting a shader for another machine', 'multi-pass ping-pong rendering', 'any network request'],
}

/** The manifest line this row prints at activation. */
export function activationLine(deps) {
  const engine = deps.engine ?? resolveEngine({ env: deps.env })
  const corpus = summary()
  const counts = []
  if (corpus.radiant !== null) counts.push(String(corpus.radiant.sources) + ' Radiant fragment(s)')
  if (corpus.skills !== null) counts.push(String(corpus.skills.modules + corpus.skills.gallery + corpus.skills.templates) + ' shader-skills file(s)')
  if (corpus.links !== null) counts.push(String(corpus.links.links) + ' curated link(s)')
  return (
    'active: seven shader_* tools · ' +
    (engine === null ? 'NO browser found, so compiles stop at v1-static (install Chrome/Edge or set DSH_SHADERS_ENGINE)' : 'compiles with ' + engine.file) +
    (counts.length === 0 ? ' · the vendored corpus is missing' : ' · ' + counts.join(', ')) +
    ' · nothing is started until a tool asks'
  )
}

/**
 * The row's dependencies, one per boot. Everything is injectable so the package
 * check drives every branch without a browser and without touching a real home.
 */
export function createDeps(ctx, options = {}) {
  const env = options.env ?? process.env
  const root = options.root ?? storeRoot(env)
  const store = new ShaderStore({ root })
  const library = new ShaderStore({ root, fixedFile: 'library.json' })
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  return {
    ctx,
    env,
    root,
    artifactDir: options.artifactDir ?? artifactDir(env),
    storeFor: (scope) => (scope === 'library' ? library : store),
    compile: options.compile ?? runJobs,
    engine: options.engine ?? resolveEngine({ env }),
    kit: options.kit ?? { summary, search, getExample, listLinks },
    workspaceOf:
      options.workspaceOf ??
      ((sessionId) => {
        const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
        const cwd = session?.header?.cwd
        return typeof cwd === 'string' && cwd !== '' ? cwd : null
      }),
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-shaders] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-shaders] ' + text),
      debug: (text) => ctx.logger?.debug?.('[dsh-shaders] ' + text),
    },
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
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

/** Register the bundled skills. A missing registry skips them, never the tools. */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the five bundled shader skills were not registered')
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
            provider: 'dsh-shaders',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-shaders: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + (err && err.message ? err.message : String(err)))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function badRequest(code, message) {
  return json({ ok: false, error: { code, message } }, 400)
}

/** The one place a route turns a session id into a store key. */
function sessionOf(request) {
  const url = new URL(request.url)
  return url.searchParams.get('session') ?? ''
}

/**
 * The routes this row owns.
 *
 * @param deps - the row's dependencies.
 * @returns `[{ path, methods, fetch }]`
 */
export function buildRoutes(deps) {
  const routes = []

  routes.push({
    path: '/api/dsh-shaders/state',
    methods: ['GET', 'HEAD'],
    async fetch(request) {
      const session = sessionOf(request)
      if (session === '') return badRequest('BAD_REQUEST', 'a session id is required')
      const store = deps.storeFor('session')
      const state = store.readState(session)
      const shaders = store.list(session).map((entry) => ({
        id: entry.id,
        title: entry.title,
        dialect: entry.dialect,
        kind: entry.kind,
        revision: entry.revision,
        bytes: entry.bytes,
        verification: verificationOf(entry),
        params: (entry.params ?? []).filter((param) => param.name !== null && param.name !== undefined).map((param) => ({ name: param.name, uniform: param.uniform, type: param.type, min: param.min, max: param.max, default: param.default, description: param.description })),
      }))
      const engine = deps.engine ?? resolveEngine({ env: deps.env })
      return json({
        ok: true,
        corrupt: state.corrupt === true,
        shaders,
        capabilities: {
          engine: engine === null ? null : { file: engine.file, kind: engine.kind, source: engine.source },
          dialects: DIALECTS,
          targets: TARGETS,
          rungs: CAPABILITIES.rungs,
          kit: deps.kit.summary(),
        },
      })
    },
  })

  routes.push({
    path: '/api/dsh-shaders/shader',
    methods: ['GET', 'POST'],
    async fetch(request) {
      const session = sessionOf(request)
      if (session === '') return badRequest('BAD_REQUEST', 'a session id is required')
      const store = deps.storeFor('session')
      if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        if (id === '') return badRequest('BAD_REQUEST', 'an id is required')
        const entry = store.get(session, id)
        if (entry === null) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'no shader called ' + id } }, 404)
        return json({ ok: true, shader: { ...entry, verification: verificationOf(entry) } })
      }
      let body
      try {
        body = await request.json()
      } catch (err) {
        return badRequest('BAD_REQUEST', 'the body must be JSON')
      }
      const source = String(body.source ?? '')
      if (source.trim() === '') return badRequest('BAD_REQUEST', 'a source is required')
      try {
        const entry = store.write(session, {
          id: body.id,
          title: body.title,
          kind: body.kind,
          dialect: body.dialect,
          source,
          includes: body.includes,
          params: body.params,
          by: 'human',
        })
        return json({ ok: true, shader: { id: entry.id, revision: entry.revision, bytes: entry.bytes } })
      } catch (err) {
        return json({ ok: false, error: { code: err.code ?? 'FAILED', message: String(err.message ?? err) } }, 400)
      }
    },
  })

  // The sandboxed frame: one vendored page, verbatim. It is served ONLY when the
  // page passed the offline-clean rule at vendor time, and the client draws it in
  // an iframe with `sandbox="allow-scripts"` and no same-origin.
  routes.push({
    path: '/api/dsh-shaders/example',
    methods: ['GET', 'HEAD'],
    async fetch(request) {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (id === '') return badRequest('BAD_REQUEST', 'an id is required')
      const found = deps.kit.getExample('radiant/' + id)
      if (found.found !== true || found.page === undefined || found.page === null) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'no vendored page called ' + id } }, 404)
      }
      const file = path.join(deps.vendorRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor'), 'radiant', found.page)
      const root = path.join(deps.vendorRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor'), 'radiant')
      const within = path.relative(root, file)
      if (within.startsWith('..') || path.isAbsolute(within)) return badRequest('BAD_REQUEST', 'that page is outside the vendored tree')
      if (!existsSync(file)) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'the page is missing from this install' } }, 404)
      const html = readFileSync(file, 'utf8')
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // A vendored page must not be able to navigate or fetch; the iframe
          // sandbox is the second lock on the same door.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; canvas-src 'self'",
          'cache-control': 'no-store',
        },
      })
    },
  })

  routes.push({
    path: '/api/dsh-shaders/artifact',
    methods: ['GET', 'HEAD'],
    async fetch(request) {
      const name = new URL(request.url).searchParams.get('name') ?? ''
      if (!/^[0-9a-f]{32}\.png$/.test(name)) return badRequest('BAD_REQUEST', 'an artifact name is a 32-character sha256 prefix plus .png')
      const file = path.join(deps.artifactDir, name)
      const within = path.relative(deps.artifactDir, file)
      if (within.startsWith('..') || path.isAbsolute(within)) return badRequest('BAD_REQUEST', 'that name is outside the artifact cache')
      if (!existsSync(file)) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'no such frame' } }, 404)
      const bytes = await fsp.readFile(file)
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.length), 'cache-control': 'no-cache' },
      })
    },
  })

  routes.push({
    path: '/api/dsh-shaders/render-report',
    methods: ['POST'],
    async fetch(request) {
      let body
      try {
        body = await request.json()
      } catch (err) {
        return badRequest('BAD_REQUEST', 'the body must be JSON')
      }
      const session = String(body.session ?? '')
      const id = String(body.id ?? '')
      if (session === '' || id === '') return badRequest('BAD_REQUEST', 'session and id are required')
      // A report is accepted even for a shader that no longer exists: the browser
      // is describing a picture it drew, and dropping that silently would make the
      // tab's status line a lie.
      const result = deps.storeFor('session').report(session, id, body)
      return json({ ok: true, ...result })
    },
  })

  routes.push({
    path: '/api/dsh-shaders/health',
    methods: ['GET', 'HEAD'],
    async fetch() {
      const engine = deps.engine ?? resolveEngine({ env: deps.env })
      const kit = deps.kit.summary()
      return json({
        ok: true,
        version: PLUGIN_VERSION,
        engine: engine === null ? null : { file: engine.file, kind: engine.kind, source: engine.source },
        dialects: DIALECTS,
        targets: TARGETS,
        kit: { radiant: kit.radiant === null ? null : kit.radiant.pages, skills: kit.skills === null ? null : kit.skills.modules + kit.skills.gallery + kit.skills.templates, links: kit.links === null ? null : kit.links.links },
        artifacts: { files: MAX_ARTIFACT_FILES, dir: deps.artifactDir },
      })
    },
  })

  return routes
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
  deps.log.info('registered ' + String(skillCount) + ' bundled skill(s)')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-shaders: tool ' + tool.name)
  }
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection !== undefined && connection !== null && typeof connection.fetch?.register === 'function') {
    for (const route of buildRoutes(deps)) {
      ctx.effect(() => connection.fetch.register(route), 'dsh-shaders: route ' + route.path)
    }
  } else {
    deps.log.warn('connection registry unavailable - the query and artifact routes were not registered')
  }
  // The artifact cache is bounded by count, pruned on the first request that
  // writes one; a boot is a good moment to reclaim a previous run's overshoot.
  try {
    pruneArtifacts(deps.artifactDir)
  } catch (err) {
    /* never fatal */
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  buildRoutes,
  createDeps,
  registerSkills,
  parseSkillFile,
  activationLine,
  verifySource,
  assemble,
  detectDialect,
  lint,
  parseParams,
  emit,
  summary,
  search,
  getExample,
  listLinks,
  CAPABILITIES,
  PLUGIN_VERSION,
  SKILL_FILES,
}
