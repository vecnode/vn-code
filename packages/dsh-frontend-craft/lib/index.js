/**
 * dsh-frontend-craft — the host half.
 *
 * One row ("frontend-craft") owns the package's whole surface:
 *
 *   - the five tools (`fe_context`, `fe_detect`, `fe_direction`, `fe_render`,
 *     `fe_artifact`), which are the runtime the vendored skill corpus calls;
 *   - the four routes the Frontend tab reads;
 *   - the bundled `frontend-craft` skill, registered from this package's own
 *     folder so a profile gets it without an install step (the installers also
 *     copy it into $DSH_HOME/skills, which is where a filesystem skill lives).
 *
 * What it deliberately does NOT have: any network call, any child process, any
 * download, any state under $DSH_HOME that outlives the process. The detector is
 * a 4.5 MB wasm module built from Impeccable's Apache-2.0 Rust crates and
 * committed under lib/vendor/impeccable/; the corpus is markdown committed under
 * skills/. "Installing Impeccable" is not a step this package has, by design.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import { FrontendError, resolveTarget, sessionRoot } from './paths.js'
import { directivesFor, readContext } from './context.js'
import { buildTools, pickDirection, scanTarget } from './tools.js'
import { PACKAGE_VERSION, RULE_COUNT, VERSION, detector, RULES } from './vendor.js'

export const name = 'dsh-frontend-craft'
export const inject = ['connection', 'tools']

/** The row's marker, kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = PACKAGE_VERSION

/** Every route this plugin owns; the tab names them by hand. */
const API_ROOT = '/api/dsh-frontend-craft'
export const STATE_ROUTE = API_ROOT + '/state'
export const SCAN_ROUTE = API_ROOT + '/scan'
export const ARTIFACTS_ROUTE = API_ROOT + '/artifacts'
export const RULES_ROUTE = API_ROOT + '/rules'
export const DIRECTION_ROUTE = API_ROOT + '/direction'
export const RENDER_IMAGE_ROUTE = API_ROOT + '/render-image'

/** The bundled skill this row registers. */
export const SKILLS = [{ name: 'frontend-craft', file: '../skills/frontend-craft/SKILL.md' }]

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** The plugin's shared dependencies, one per boot. */
export function createDeps(ctx, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const log = {
    info: (message) => ctx.logger?.info?.('[dsh-frontend-craft] ' + message),
    warn: (message) => ctx.logger?.warn?.('[dsh-frontend-craft] ' + message),
    debug: (message) => ctx.logger?.debug?.('[dsh-frontend-craft] ' + message),
  }
  /** The last scan, direction round and render per session. Memory only. */
  const lastScan = new Map()
  const deals = new Map()
  const picks = new Map()
  const renders = new Map()
  return {
    ctx,
    env,
    log,
    home,
    root: path.join(home, 'dsh-frontend-craft'),
    remember(session, report) {
      if (typeof session !== 'string' || session === '') return
      lastScan.set(session, {
        at: Date.now(),
        target: report.target,
        files: report.files,
        counts: report.counts,
        byRule: report.byRule.map((entry) => ({ id: entry.id, count: entry.count, name: entry.rule ? entry.rule.name : null, category: entry.rule ? entry.rule.category : null })),
        ms: report.ms,
      })
    },
    lastScanOf(session) {
      return lastScan.get(session) ?? null
    },
    rememberDeal(session, deal) {
      if (typeof session !== 'string' || session === '') return
      deals.set(session, deal)
    },
    dealOf(session) {
      return deals.get(session) ?? null
    },
    rememberPick(session, choice) {
      if (typeof session !== 'string' || session === '') return
      picks.set(session, choice)
    },
    pickOf(session) {
      return picks.get(session) ?? null
    },
    rememberRender(session, summary) {
      if (typeof session !== 'string' || session === '') return
      renders.set(session, summary)
    },
    renderOf(session) {
      return renders.get(session) ?? null
    },
    state() {
      const handle = detector()
      return {
        ok: true,
        version: PLUGIN_VERSION,
        corpus: VERSION.upstream,
        rules: RULE_COUNT,
        detector: handle.ok === true ? { ok: true } : { ok: false, message: handle.message },
      }
    },
  }
}

/** Register the bundled skill, tolerating a profile with no skills service. */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skills service unavailable - the bundled frontend-craft skill was not registered (the installer still copies it into $DSH_HOME/skills)')
    return 0
  }
  let count = 0
  for (const entry of SKILLS) {
    try {
      const file = path.resolve(packageRoot(), 'lib', entry.file)
      const text = readFileSync(file, 'utf8')
      const description = /^---\r?\n[\s\S]*?^description:\s*"([\s\S]*?)"\s*$/m.exec(text)
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      ctx.effect(
        () =>
          skills.register({
            name: entry.name,
            description: description ? description[1].replace(/\s+/g, ' ').trim() : 'Front-end design craft: the Impeccable corpus and its 61-rule detector.',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
            content: body,
          }),
        'dsh-frontend-craft: skill ' + entry.name,
      )
      count += 1
    } catch (err) {
      log.warn('could not register the ' + entry.name + ' skill: ' + String(err && err.message))
    }
  }
  return count
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** The tab's routes. Exact paths: the fetch registry matches exact paths. */
export function registerRoutes(deps) {
  const connection = typeof deps.ctx.get === 'function' ? deps.ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-frontend-craft/* routes were not registered')
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            const status = err instanceof FrontendError && err.code === 'NO_WORKSPACE' ? 409 : 500
            return json(status, { ok: false, code: (err && err.code) || 'ROUTE_FAILED', message: String(err && err.message ? err.message : err) })
          }
        },
      }),
    )
  }

  register(STATE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const session = new URL(request.url).searchParams.get('session') ?? ''
    const state = deps.state()
    let root = null
    let platform = null
    let directives = []
    let artifacts = null
    try {
      root = await sessionRoot(deps.ctx, session)
      const snapshot = readContext(root)
      platform = snapshot.platform
      directives = directivesFor(snapshot)
      artifacts = {
        product: snapshot.product === null ? null : { schema: snapshot.product.schema, ok: snapshot.product.ok, problems: snapshot.product.problems },
        design: snapshot.design === null ? null : { ok: snapshot.design.ok, problems: snapshot.design.problems },
        briefs: snapshot.briefs.map((brief) => ({ slug: brief.slug, ok: brief.ok })),
        config: snapshot.config.present,
      }
    } catch (err) {
      // A tab opened outside a session still gets the corpus facts.
      root = null
    }
    return json(200, { ...state, root, platform, directives, artifacts, lastScan: deps.lastScanOf(session), direction: { deal: deps.dealOf(session), pick: deps.pickOf(session) }, render: deps.renderOf(session) })
  })

  register(SCAN_ROUTE, ['POST'], async (request) => {
    let body
    try {
      body = await request.json()
    } catch (err) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'A scan request is JSON: { session, target?, rules?, includeAdvisory? }.' })
    }
    const session = typeof body?.session === 'string' ? body.session : ''
    const report = await scanTarget(deps, {
      session,
      target: typeof body?.target === 'string' ? body.target : '',
      rules: Array.isArray(body?.rules) ? body.rules : [],
      includeAdvisory: body?.includeAdvisory !== false,
    })
    deps.remember(session, report)
    return json(200, { ok: true, report })
  })

  register(ARTIFACTS_ROUTE, ['GET', 'HEAD'], async (request) => {
    const session = new URL(request.url).searchParams.get('session') ?? ''
    const root = await sessionRoot(deps.ctx, session)
    const snapshot = readContext(root)
    const cap = 96 * 1024
    const cut = (text) => (text.length > cap ? text.slice(0, cap) + '\n\n… truncated' : text)
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    return json(200, {
      ok: true,
      root,
      platform: snapshot.platform,
      product: snapshot.product === null ? null : { text: cut(snapshot.product.text), schema: snapshot.product.schema, ok: snapshot.product.ok, problems: snapshot.product.problems },
      design: snapshot.design === null ? null : { text: cut(snapshot.design.text), ok: snapshot.design.ok, problems: snapshot.design.problems },
      briefs: snapshot.briefs.map((brief) => ({ slug: brief.slug, ok: brief.ok, problems: brief.problems, path: brief.path })),
      config: snapshot.config,
    })
  })

  register(RULES_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, rules: RULES }))

  // The direction round's two halves: what was dealt, and the pick. The deal is
  // made by `fe_direction` (the agent authors the directions); the tab can only
  // RECORD a choice, which is the one thing a person owns in that round.
  //
  // ONE registration for this path, not two: `connection.fetch` keys routes by
  // EXACT PATH and throws on a second one ("is already registered"), which is
  // how this row failed to activate entirely. Methods share a handler and branch.
  register(DIRECTION_ROUTE, ['GET', 'HEAD', 'POST'], async (request) => {
    if (request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch (err) {
        return json(400, { ok: false, code: 'BAD_BODY', message: 'A direction request is JSON: { session, pick }.' })
      }
      const session = typeof body?.session === 'string' ? body.session : ''
      const verdict = pickDirection(deps.dealOf(session), body?.pick)
      if (!verdict.ok) return json(409, { ok: false, code: 'NO_DEAL', message: verdict.message })
      deps.rememberPick(session, verdict.choice)
      return json(200, { ok: true, pick: verdict.choice, deal: deps.dealOf(session) })
    }
    const session = new URL(request.url).searchParams.get('session') ?? ''
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    return json(200, { ok: true, deal: deps.dealOf(session), pick: deps.pickOf(session) })
  })

  // One rendered viewport's PNG. The id and width name a directory this plugin
  // created; both are validated and the resolved path is checked again, so a
  // crafted id can never walk out of the renders root.
  register(RENDER_IMAGE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const id = String(url.searchParams.get('id') ?? '')
    const width = String(url.searchParams.get('w') ?? '')
    if (!/^[0-9a-f]{16}$/.test(id) || !/^[0-9]{3,5}$/.test(width)) {
      return json(400, { ok: false, code: 'BAD_ID', message: 'A render id is 16 hex characters and a width is a number; both come from a fe_render result.' })
    }
    const rendersRoot = path.resolve(path.join(deps.root, 'renders'))
    const file = path.resolve(path.join(rendersRoot, id, 'page-' + width + '.png'))
    if (!file.startsWith(rendersRoot + path.sep) || !existsSync(file)) {
      return json(404, { ok: false, code: 'NOT_FOUND', message: 'No render ' + id + ' at ' + width + 'px. Render the page again to produce one.' })
    }
    const headers = { 'content-type': 'image/png', 'cache-control': 'no-store' }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(readFileSync(file), { status: 200, headers })
  })

  return () => {
    for (const off of offs) {
      try {
        off()
      } catch (err) {
        /* already gone */
      }
    }
  }
}

/**
 * Activate the row.
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  const handle = detector()
  deps.log.info(
    'active: Impeccable ' +
      VERSION.upstream.skillVersion +
      ' @ ' +
      VERSION.upstream.commit.slice(0, 7) +
      ', ' +
      RULE_COUNT +
      ' rules, detector ' +
      (handle.ok === true ? 'loaded' : 'FAILED - ' + handle.message),
  )
  const count = registerSkills(ctx, deps.log)
  if (count > 0) deps.log.info('- registered ' + count + ' bundled skill')
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-frontend-craft: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes(deps), 'dsh-frontend-craft: routes')
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = { createDeps, registerRoutes, registerSkills, buildTools, scanTarget, resolveTarget }
