/**
 * dsh-proto-lab — the row, and everything it mounts.
 *
 * This is the host half: the five `lab_*` tools, the three bundled skills, and
 * the four routes the Lab tab reads. The split is the one every package in this
 * pack uses - `lib/lab.js` and `lib/runtimes/` know nothing about the harness
 * (they take a root, an environment and a log sink), so the same engine can be
 * driven by `checks/check-lab-node.mjs` with no harness at all. This file is the
 * cordis glue: it decides WHEN those things happen (lazily), registers them, and
 * disposes them when the row unloads.
 *
 * The three surfaces, and who owns what:
 *
 *   - the TOOLS write runs into the workspace's own `lab/` folder. Every path is
 *     resolved and refused by `lib/lab.js`, so nothing here decides what a legal
 *     path is. The workspace is the process working directory, which is what the
 *     harness runs a conversation's tools with - the same resolution
 *     `dsh-supercollider` documents, and the reason a route needs no session id.
 *   - the ROUTES serve ONE self-contained document per run (see
 *     `previewDocument`) plus the vendored library. The tab's frame runs it with
 *     `sandbox="allow-scripts"`, which gives the page an opaque origin, so it can
 *     fetch NOTHING - not even this plugin's own routes. That is why the preview
 *     inlines the library and the sketch instead of referencing them: a page that
 *     cannot fetch is a page that cannot leak, and a run that needed a real
 *     second file gets it by opening `index.html` in a browser.
 *   - the CLIENT is one tab. It draws the document it is handed and names a run;
 *     it never composes a path of its own.
 */

import fsp from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalRoot, listRuns, readCatalog, resolveLabRoot } from './lab.js'
import { runtimes } from './runtimes/index.js'
import { buildTools, TOOL_NAMES } from './tools.js'

/** The row's identity. */
export const name = 'dsh-proto-lab'
/** The services activation waits for: the HTTP bridge and the tool registry. */
export const inject = ['connection', 'tools']

/** This build's marker. It must equal package.json's version. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** Every route this plugin owns. */
const API_ROOT = '/api/dsh-proto-lab'
export const STATE_ROUTE = API_ROOT + '/state'
export const PREVIEW_ROUTE = API_ROOT + '/preview'
export const VENDOR_ROUTE = API_ROOT + '/vendor/p5.js'

/** The three skills this package ships, as files beside this module. */
const SKILL_FILES = [
  { name: 'p5js-prototypes', file: '../skills/p5js-prototypes/SKILL.md' },
  { name: 'openframeworks-prototypes', file: '../skills/openframeworks-prototypes/SKILL.md' },
  { name: 'prototyping-lab', file: '../skills/prototyping-lab/SKILL.md' },
]

/** The vendored library, read once and cached. */
const VENDOR_FILE = fileURLToPath(new URL('./vendor/p5.min.js', import.meta.url))

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * The same deliberately small parser every package in this pack uses: the
 * frontmatter is `name`, `description` and `whenToUse`, one per line. A document
 * without frontmatter still works - it is registered under its file name with an
 * empty description.
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[entry[1]] = value
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/** One skill's own header, parsed out of its file. */
export function readSkill(entry) {
  const file = fileURLToPath(new URL(entry.file, import.meta.url))
  const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
  return { file, meta, content }
}

/**
 * Register the bundled skills.
 *
 * The registry is resolved lazily - its absence skips the skills and never the
 * tools - and a missing file is a warning rather than a failure, because both
 * installers also copy these folders into `$DSH_HOME/skills`, so a host without
 * the registry still gets them from the filesystem provider.
 *
 * Each skill is registered with its own `path` and a `resourceBase` pointing at
 * the skill's DIRECTORY, which is what makes its `examples/` folder reachable:
 * the harness's directory-bundle convention is that a resource is named relative
 * to the folder the SKILL.md lives in, so a loaded skill can read
 * `examples/<slug>/sketch.js` beside it.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn, info }`.
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the three bundled skills were not registered')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const { file, meta, content } = readSkill(entry)
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
            provider: 'dsh-proto-lab',
            // `source` is required by the registry's own definition validator
            // (it throws `source must be a string` without one) and `path` is
            // what makes the entry file-backed, so a skills browser can show and
            // edit the document the model was actually given.
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-proto-lab: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// The lab, as the tab sees it
// ---------------------------------------------------------------------------
/**
 * Everything the Lab tab needs for one workspace.
 *
 * @param env - the environment.
 * @returns the state view.
 */
export async function labState(env = process.env) {
  const resolved = await resolveLabRoot({ env, workspace: process.cwd() })
  const root = await canonicalRoot(resolved.root)
  const { runs, notes } = await listRuns(root)
  const { catalog, note } = await readCatalog(root)
  const { entries, problems } = runtimes()
  return {
    version: PLUGIN_VERSION,
    root,
    source: resolved.source,
    workspace: resolved.workspace,
    repo: resolved.repo,
    exists: await fsp
      .stat(root)
      .then((stat) => stat.isDirectory())
      .catch(() => false),
    runs: runs.map((item) => ({
      id: item.id,
      runtime: item.runtime,
      slug: item.slug,
      files: item.files,
      bytes: item.bytes,
      modified: item.modified,
      concept: typeof catalog.runs[item.id]?.concept === 'string' ? catalog.runs[item.id].concept : '',
      seed: Number.isFinite(Number(catalog.runs[item.id]?.seed)) ? Number(catalog.runs[item.id].seed) : null,
    })),
    runtimes: entries.map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind, tagline: entry.tagline })),
    notes: [...notes, ...(note === null ? [] : [note]), ...problems],
  }
}

/**
 * Compose the ONE page the tab frames for a run.
 *
 * Inlined, deliberately, and this is the whole reason the route exists rather
 * than a static file being served:
 *
 *   - the tab frames it with `sandbox="allow-scripts"` and no
 *     `allow-same-origin`, so the page has an opaque origin and every fetch it
 *     makes - even to this plugin's own routes - is cross-origin and refused by
 *     the app's own auth. A document that must not fetch is therefore assembled
 *     with everything already in it: the library, the sketch, the stylesheet.
 *   - a run's `index.html` off the disk is not that document (it references
 *     `p5.min.js` and `sketch.js` beside it), so the shell is read and its
 *     references are REPLACED by their contents.
 *   - remote references are left alone and will simply fail inside the frame:
 *     the CSP below permits no network, which is the honest outcome for a run
 *     that reaches for a CDN. `lab_lint` reports them as errors, and opening the
 *     file in a browser shows exactly what the run does.
 *
 * @param options - `{ env, run, seed }`.
 * @returns `{ html, run, inlined, seed }`.
 */
export async function previewDocument(options) {
  const env = options.env ?? process.env
  const resolved = await resolveLabRoot({ env, workspace: process.cwd() })
  const root = await canonicalRoot(resolved.root)
  const run = String(options.run ?? '')
  const runtimeId = run.split('/')[0]
  const entry = runtimes().entries.find((item) => item.id === runtimeId)
  if (entry === undefined) {
    throw new Error('there is no runtime called ' + JSON.stringify(runtimeId) + ' - a run is named "<runtime>/<slug>"')
  }

  const directory = path.join(root, runtimeId, run.split('/')[1] ?? '')
  const shellPath = path.join(directory, 'index.html')
  let html
  try {
    html = await fsp.readFile(shellPath, 'utf8')
  } catch (err) {
    throw new Error('this run has no index.html to preview: ' + messageOf(err))
  }

  // The seed, first: a framed document has no URL to read, so the tab's seed is
  // handed in through the one global the shell checks before `location.search`.
  const seed = Number.isFinite(Number(options.seed)) && options.seed !== null && options.seed !== undefined ? Math.trunc(Number(options.seed)) : null
  if (seed !== null) {
    const marker = '<body>'
    const at = html.indexOf(marker)
    const injected = '<script>window.__LAB_SEED = ' + seed + ';</script>'
    html = at === -1 ? injected + html : html.slice(0, at + marker.length) + injected + html.slice(at + marker.length)
  }

  const inlined = []
  const library = await fsp.readFile(VENDOR_FILE, 'utf8')
  html = html.replace(/<script([^>]*)\ssrc=["']p5\.min\.js["']([^>]*)><\/script>/, () => {
    inlined.push('p5.js')
    return '<script>\n' + library + '\n</script>'
  })

  // The sketch and any stylesheet the shell names, each replaced by its bytes.
  const references = [...html.matchAll(/<script([^>]*)\ssrc=["']([^"':]+\.js)["']([^>]*)><\/script>/g)].map((match) => match[2])
  for (const reference of references) {
    let text
    try {
      text = await fsp.readFile(path.join(directory, reference), 'utf8')
    } catch (err) {
      html = html.replace(
        new RegExp('<script([^>]*)\\ssrc=["\']' + reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']([^>]*)></script>'),
        '<script>window.__LAB_LOAD_FAILED = ' + JSON.stringify(reference + ': ' + messageOf(err)) + ';</script>',
      )
      continue
    }
    inlined.push(reference)
    html = html.replace(
      new RegExp('<script([^>]*)\\ssrc=["\']' + reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']([^>]*)></script>'),
      () => '<script>\n' + text + '\n</script>',
    )
  }

  return { html, run, inlined, seed }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** A JSON response. */
function json(status, value) {
  return new Response(JSON.stringify(value, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The vendored p5.js, served once and cached in memory. */
let vendorState = null
export async function serveVendor() {
  if (vendorState === null) {
    const bytes = await fsp.readFile(VENDOR_FILE)
    const { createHash } = await import('node:crypto')
    vendorState = { bytes, etag: '"' + createHash('sha1').update(bytes).digest('hex') + '"' }
  }
  return new Response(vendorState.bytes, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      etag: vendorState.etag,
      'x-dsh-proto-lab-vendor': 'p5',
    },
  })
}

/**
 * Register the three routes on the connection's fetch registry.
 *
 * @param deps - `{ ctx, env, log }`.
 * @returns a disposer.
 */
export function registerRoutes(deps) {
  const connection = typeof deps.ctx.get === 'function' ? deps.ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-proto-lab/* routes were not registered')
    return () => {}
  }
  const env = deps.env ?? process.env
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        // REQUIRED: Connection's HTTP bridge picks the streaming branch for a
        // route that leaves this undefined.
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            deps.log.warn(routePath + ' failed: ' + messageOf(err))
            return json(500, { ok: false, error: messageOf(err) })
          }
        },
      }),
    )
  }

  /** The tab's header: the lab, its runs, and the runtimes that can be written. */
  register(STATE_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...(await labState(env)) }))

  /** The page the tab frames. One run, composed here, self-contained. */
  register(PREVIEW_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const composed = await previewDocument({ env, run: url.searchParams.get('run') ?? '', seed: url.searchParams.get('seed') })
    return new Response(composed.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The document is already self-contained, so the page is allowed
        // NOTHING: no fetch, no frame, no object, no form, and only the inline
        // scripts it was assembled with. `img-src`/`font-src`/`media-src` keep
        // `data:` and `blob:` because a sketch may generate them itself.
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
      },
    })
  })

  /** The pinned p5.js: what the plugin's own copy is, for anyone who wants it. */
  register(VENDOR_ROUTE, ['GET', 'HEAD'], () => serveVendor())

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

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - the cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const env = process.env
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-proto-lab] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-proto-lab] ' + text),
    debug: (text) => ctx.logger?.debug?.('[dsh-proto-lab] ' + text),
  }

  const { entries, problems } = runtimes()
  for (const problem of problems) log.warn(problem)
  log.info(
    'active: ' + entries.length + ' runtime(s) (' + entries.map((entry) => entry.id).join(', ') + '), ' +
      TOOL_NAMES.length + ' tools, ' + SKILL_FILES.length + ' skills',
  )

  const skillCount = registerSkills(ctx, log)
  log.info('registered ' + skillCount + ' bundled skill(s)')

  for (const tool of buildTools({ env, log })) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-proto-lab: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes({ ctx, env, log }), 'dsh-proto-lab: routes')

  // Nothing here holds a process, a socket or a timer: a run is files on disk and
  // the routes read them per request. The only state is the vendored library's
  // bytes, which is a cache and not a resource.
  ctx.effect(
    () => () => {
      vendorState = null
    },
    'dsh-proto-lab: vendor cache',
  )
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  parseSkillFile,
  readSkill,
  registerSkills,
  registerRoutes,
  labState,
  previewDocument,
  serveVendor,
  SKILL_FILES,
  TOOL_NAMES,
  STATE_ROUTE,
  PREVIEW_ROUTE,
  VENDOR_ROUTE,
  VENDOR_FILE,
}
