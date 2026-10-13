/**
 * dsh-research — the row, and everything it mounts.
 *
 * The host half: the `rs_*` tools, the bundled skill, and the routes the Research
 * tab reads. The split is the one every package in this pack uses - `lib/run.js`,
 * `lib/ledger.js`, `lib/doc.js`, `lib/build.js` and `lib/tools.js` know nothing
 * about cordis (they take a root, an environment and a log sink), so the same
 * engine is driven by `checks/check-research-node.mjs` with no harness at all.
 * This file is the cordis glue: it decides WHEN those things happen, registers
 * them, and disposes them when the row unloads.
 *
 * What this plugin is NOT, and the reason it can be installed without a trust
 * conversation (SECURITY.md):
 *
 *   - **it opens no socket.** Not on activation, not on a timer, not on a tool
 *     call. Literature arrives as a file the person or the agent already has:
 *     `rs_cite` hashes and stores it, and the harness's own `web_fetch` /
 *     `web_search` are the agent's way to reach the network. There is no resolver,
 *     no DOI lookup and no update ping in this package.
 *   - **it spawns nothing and reads no credential.** No child process (so no
 *     `pdftotext`, no pandoc, no engine found on PATH), no
 *     `$DSH_HOME/.credentials.yaml`, and no environment variable except its own
 *     root and the home directory it looks for a Desktop in.
 *   - **it writes only inside a run folder** under the research root, through the
 *     containment checks in `lib/run.js`, and it never deletes anything.
 *
 * Why the workspace is `process.cwd()`: the harness runs a conversation's tools
 * with the session's own working directory, which is the resolution
 * `dsh-supercollider` documents. A route has no session and therefore no cwd of
 * its own, so it uses the process's - and the ROOT, not the workspace, is what the
 * browser half ever sees, because a run folder is all it addresses.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import {
  PLUGIN_VERSION,
  ROOT_ENV,
  ResearchError,
  answerGate,
  canonicalRoot,
  healthView,
  messageOf,
  projectView,
  readRun,
  readRunText,
  resolveRoot,
  stateView,
  writeRunFile,
} from './run.js'
import { GATE_IDS, TOOL_NAMES, buildTools, workspaceOf } from './tools.js'
import { FORMATS_READY, ensureIntegrityGate, readRunState, runBuild } from './build.js'
import { readSources, sourcesByKey } from './ledger.js'
import { projectDetail } from './view.js'
import {
  API_ROOT,
  API_ROUTES,
  ARTIFACT_ROUTE,
  BUILD_ROUTE,
  FILE_ROUTE,
  GATE_ROUTE,
  HEALTH_ROUTE,
  PROJECT_ROUTE,
  SOURCE_ROUTE,
  STATE_ROUTE,
} from './api.js'

/**
 * The skills this package ships, as files beside this module.
 *
 * Registered at activation AND copied into `$DSH_HOME/skills` by both installers:
 * the registry is what a `skill` tool call reads in this session, and the copy is
 * what a filesystem provider reads in a profile whose registry the row never
 * reached. Either alone leaves a machine where the skill exists but cannot load.
 */
const SKILL_FILES = [
  { name: 'research-project', file: '../skills/research-project/SKILL.md' },
  { name: 'research-sources', file: '../skills/research-sources/SKILL.md' },
  { name: 'research-writing', file: '../skills/research-writing/SKILL.md' },
  { name: 'research-verification', file: '../skills/research-verification/SKILL.md' },
  { name: 'research-review', file: '../skills/research-review/SKILL.md' },
]

/** The row's identity. */
export const name = 'dsh-research'
/** The services activation waits for: the HTTP bridge and the tool registry. */
export const inject = ['connection', 'tools']

/** What this build offers, reported by every view that lists it. */
const CAPABILITIES = { tools: TOOL_NAMES, routes: API_ROUTES, formats: FORMATS_READY }

/** How long a gate answer may be, so one route cannot be used as a file dump. */
const MAX_BODY_CHARS = 64 * 1024

/** One error's message, whatever was thrown. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A run is being written while the tab polls it: a cached answer would be
      // the one thing this tab must never show.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** A non-JSON body: a file's bytes, with the type the caller asked for. */
function bytes(status, buffer, type, extra = {}) {
  return new Response(buffer, {
    status,
    headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  })
}

/** The refusal shape every route answers with. `code` is what a caller asserts on. */
function refused(err) {
  if (err instanceof ResearchError) return json(400, { ok: false, code: err.code, message: err.message })
  return json(500, { ok: false, code: 'INTERNAL', message: messageOf(err) })
}

/** The workspace a route runs in: the process's own, since a route has no session. */
function routeEnv() {
  return { env: process.env, workspace: process.cwd() }
}

/**
 * Register this row's four routes.
 *
 * @param options - `{ ctx, log }`.
 * @returns a disposer that unregisters every route it added.
 */
export function registerRoutes(options) {
  const { ctx, log } = options
  const connection = ctx.get('connection')
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    log.warn('no connection service - the Research tab has no routes to read')
    return () => {}
  }
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
            log.warn(routePath + ' failed: ' + messageOf(err))
            return refused(err)
          }
        },
      }),
    )
  }

  /** The tab's opening read: where runs live and what is in them. */
  register(STATE_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...(await stateView({ ...routeEnv(), ...CAPABILITIES })) }))

  /** One run, in one round trip, because the panel polls it while the agent works. */
  register(PROJECT_ROUTE, ['GET', 'HEAD'], async (request) => {
    const slug = new URL(request.url).searchParams.get('slug') ?? ''
    return json(200, { ok: true, ...(await projectDetail({ ...routeEnv(), ...CAPABILITIES, slug })) })
  })

  /**
   * Answer a gate.
   *
   * This route exists because the gate is the one thing in this plugin that a
   * MODEL must not do: `g2-intake` asks whether the person ran the experiments,
   * and an agent answering it would make the ledger a record of the agent's
   * assumptions. The answer is appended with a timestamp, the route refuses an
   * override without a reason, and every later `rs_open` quotes the answer back in
   * the user's own words.
   *
   * It is behind the harness's session check like every other pack route - the
   * connection service mounts it, so this plugin invents no gate of its own.
   */
  register(GATE_ROUTE, ['POST'], async (request) => {
    let body = null
    try {
      body = await request.json()
    } catch (err) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the gate route takes a JSON body: ' + messageOf(err) })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the gate route takes a JSON object' })
    }
    for (const field of ['slug', 'id', 'value']) {
      if (typeof body[field] !== 'string' || body[field] === '') {
        return json(400, { ok: false, code: 'BAD_BODY', message: 'the gate body needs a non-empty `' + field + '`' })
      }
    }
    for (const field of ['text', 'reason']) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return json(400, { ok: false, code: 'BAD_BODY', message: '`' + field + '` must be a string' })
      }
      if (typeof body[field] === 'string' && body[field].length > MAX_BODY_CHARS) {
        return json(400, { ok: false, code: 'TEXT_TOO_LONG', message: '`' + field + '` is at most ' + MAX_BODY_CHARS + ' characters' })
      }
    }
    try {
      // The root is resolved HERE rather than inside answerGate, because resolving
      // it needs the environment and a workspace - and a route is the only caller
      // that has either. `answerGate` takes a resolved root, like `readPassport`
      // and `readRun` do.
      const resolved = await resolveRoot(routeEnv())
      const root = await canonicalRoot(resolved.root)
      const answered = await answerGate({
        root,
        slug: body.slug,
        id: body.id,
        value: body.value,
        text: body.text ?? '',
        reason: body.reason ?? '',
      })
      return json(200, { ok: true, slug: answered.slug, gate: answered.gate, answer: answered.entry })
    } catch (err) {
      return refused(err)
    }
  })

  /**
   * One source: its record, and the text a locator is checked against.
   *
   * The panel opens this when a claim's locator is clicked, which is why it is a
   * route rather than something the tab computes: the text lives on the host, and
   * sending all of it with every project poll would be the one payload that grows
   * without bound.
   */
  register(SOURCE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const slug = url.searchParams.get('slug') ?? ''
    const key = url.searchParams.get('key') ?? ''
    const resolved = await resolveRoot(routeEnv())
    const root = await canonicalRoot(resolved.root)
    const { dir } = await readRun(root, slug)
    const { current } = await readSources(dir)
    const record = sourcesByKey(current).get(key)
    if (record === undefined) {
      return json(404, { ok: false, code: 'UNKNOWN_SOURCE', message: 'no source named ' + JSON.stringify(key) + ' in ' + slug })
    }
    const maxChars = Math.min(Number(url.searchParams.get('maxChars') ?? 40_000) || 40_000, 200_000)
    const text =
      record.text === undefined
        ? null
        : await fsp
            .readFile(path.join(dir, ...String(record.text.file).split('/')), 'utf8')
            .catch(() => null)
    return json(200, {
      ok: true,
      slug,
      source: record,
      text: text === null ? null : { chars: text.length, truncated: text.length > maxChars, body: text.slice(0, maxChars) },
    })
  })

  /**
   * A built artifact's bytes.
   *
   * `name` is a BASENAME and nothing else - no separators, no `..` - so this route
   * can only serve a file the build wrote into `build/`, and a crafted name cannot
   * reach the rest of the run.
   */
  register(ARTIFACT_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const slug = url.searchParams.get('slug') ?? ''
    const name = url.searchParams.get('name') ?? ''
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name.includes('..')) {
      return json(400, { ok: false, code: 'BAD_PATH', message: 'name is a basename inside build/, e.g. `paper.md`' })
    }
    const resolved = await resolveRoot(routeEnv())
    const root = await canonicalRoot(resolved.root)
    const { dir } = await readRun(root, slug)
    const file = path.join(dir, 'build', name)
    const stat = await fsp.stat(file).catch(() => null)
    if (stat === null || !stat.isFile()) {
      return json(404, { ok: false, code: 'NO_SUCH_FILE', message: 'no built file named ' + name + ' in ' + slug })
    }
    const type = name.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : name.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : name.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : name.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8'
    return bytes(200, await fsp.readFile(file), type, { 'content-disposition': 'inline; filename="' + name + '"' })
  })

  /**
   * Build a format - the SAME code path `rs_build` drives.
   *
   * One implementation and two callers is the rule that keeps the panel and the
   * agent from disagreeing about what a clean build requires, so this route adds
   * no rule of its own: it answers the gate question the same way and refuses with
   * the same codes.
   */
  register(BUILD_ROUTE, ['POST'], async (request) => {
    let body = null
    try {
      body = await request.json()
    } catch (err) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the build route takes a JSON body: ' + messageOf(err) })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the build route takes a JSON object' })
    }
    if (typeof body.slug !== 'string' || body.slug === '') {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the build body needs a non-empty `slug`' })
    }
    const draft = body.draft === 'clean' ? 'clean' : 'watermark'
    const resolved = await resolveRoot(routeEnv())
    const root = await canonicalRoot(resolved.root)
    const { dir, record } = await readRun(root, body.slug)
    const { answered } = await ensureIntegrityGate({ root, slug: body.slug, draft })
    try {
      const result = await runBuild({
        runDir: dir,
        format: typeof body.format === 'string' && body.format !== '' ? body.format : 'md',
        draft,
        styleId: typeof body.style === 'string' && body.style !== '' ? body.style : record.style,
        slug: body.slug,
        integrityAnswered: answered,
      })
      return json(200, { ok: true, outputs: result.outputs, report: result.report })
    } catch (err) {
      return refused(err)
    }
  })

  /**
   * Save ONE text file inside a run - the person's own edit, from the panel.
   *
   * It answers with the STRUCTURE VERDICT, which is the whole reason a human edit
   * is not validated the way an agent's write is: the edit is allowed, and what it
   * did to the ledger's agreement with the document is reported immediately, in
   * the panel, by code. A person who deletes a claim's marker, or writes a
   * citation whose key does not exist, sees `span-unrecorded` or `unknown-source`
   * on the spot rather than at the next build.
   */
  register(FILE_ROUTE, ['GET', 'HEAD', 'POST'], async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'POST') {
      // GET: read one text file of a run, for the panel's editor.
      const maxChars = Number(url.searchParams.get('maxChars') ?? 200_000) || 200_000
      try {
        const answer = await readRunText({
          ...routeEnv(),
          slug: url.searchParams.get('slug') ?? '',
          file: url.searchParams.get('file') ?? '',
          maxChars,
        })
        return json(200, { ok: true, slug: answer.slug, file: answer.file, bytes: answer.bytes, chars: answer.chars, truncated: answer.truncated, text: answer.text })
      } catch (err) {
        return refused(err)
      }
    }
    let body = null
    try {
      body = await request.json()
    } catch (err) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the file route takes a JSON body: ' + messageOf(err) })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the file route takes a JSON object' })
    }
    for (const field of ['slug', 'file']) {
      if (typeof body[field] !== 'string' || body[field] === '') {
        return json(400, { ok: false, code: 'BAD_BODY', message: 'the file body needs a non-empty `' + field + '`' })
      }
    }
    if (typeof body.text !== 'string') {
      return json(400, { ok: false, code: 'BAD_BODY', message: 'the file body needs the `text` to save' })
    }
    const resolved = await resolveRoot(routeEnv())
    const root = await canonicalRoot(resolved.root)
    try {
      const written = await writeRunFile({ root, slug: body.slug, file: body.file, text: body.text })
      const state = await readRunState(written.dir)
      const counts = state.claims.length
      return json(200, {
        ok: true,
        file: written.file,
        bytes: written.bytes,
        // The verdict travels with the save, so the panel never has to ask twice.
        structure: {
          ok: state.structure.ok,
          words: state.document.text.trim() === '' ? 0 : state.document.text.split(/\s+/).filter(Boolean).length,
          claims: counts,
          errors: state.structure.errors.map((one) => ({ code: one.code, detail: one.detail })),
          warnings: state.structure.warnings.map((one) => ({ code: one.code, detail: one.detail })),
        },
      })
    } catch (err) {
      return refused(err)
    }
  })

  /** The same snapshot the tracked checks read, with the refusal codes spelled out. */
  register(HEALTH_ROUTE, ['GET', 'HEAD'], async () => {
    const health = await healthView({ ...routeEnv(), ...CAPABILITIES })
    return json(200, { ...health, codes: REFUSAL_CODES })
  })

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

/**
 * Every refusal a caller can meet, in one place.
 *
 * A check asserts this list against the codes the code actually throws, because a
 * code that only exists in a README is a code nobody can handle.
 */
export const REFUSAL_CODES = [
  'BAD_SLUG',
  'BAD_ROOT',
  'BAD_TITLE',
  'BAD_KIND',
  'BAD_STYLE',
  'BAD_STRUCTURE',
  'BAD_LANGUAGE',
  'BAD_PATH',
  'BAD_BODY',
  'BAD_KEY',
  'BAD_SOURCE',
  'BAD_CLAIM',
  'BAD_CLAIM_ID',
  'BAD_LOCATOR',
  'BAD_LEDGER',
  'BAD_TEXT',
  'BAD_PART',
  'BAD_SECTION',
  'BAD_FORMAT',
  'RUN_EXISTS',
  'UNKNOWN_RUN',
  'UNKNOWN_SOURCE',
  'UNKNOWN_CITATION',
  'UNKNOWN_STYLE',
  'UNKNOWN_CLAIM',
  'BAD_STATUS',
  'BAD_VERDICT',
  'BAD_JUDGE',
  'STATUS_REQUIRES_EVIDENCE',
  'RUNG_ORDER',
  'BAD_FINDING',
  'BAD_ROLE',
  'BAD_SEVERITY',
  'BAD_CRITERION',
  'BAD_REPLY',
  'BAD_SCORE',
  'UNKNOWN_FINDING',
  'NOT_ANSWERED',
  'NO_REVIEW',
  'CONCESSION_BELOW_THRESHOLD',
  'CONSECUTIVE_CONCESSION',
  'BROKEN_CITATION',
  'NO_SUCH_FILE',
  'NOT_A_FILE',
  'NOT_TEXT',
  'BAD_EXTENSION',
  'TOO_LARGE',
  'MALFORMED_JSON',
  'MALFORMED_LEDGER',
  'PATH_ESCAPE',
  'GATE_UNKNOWN',
  'GATE_ALREADY_ANSWERED',
  'VALUE_INVALID',
  'TEXT_REQUIRED',
  'REASON_REQUIRED',
  'TEXT_TOO_LONG',
  'CLAIM_UNDECLARED',
  'CLAIM_SPAN_MISSING',
  'FORMAT_NOT_YET',
  'DOC_EMPTY',
  'BUILD_BLOCKED',
  'BLOCKING_CLAIMS',
  'REFS_EMPTY',
  'STYLES_UNAVAILABLE',
  'REFS_UNAVAILABLE',
]

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * The same deliberately small parser every package in this pack uses: the
 * frontmatter is `name`, `description` and `whenToUse`, one per line. A document
 * without frontmatter still works - it is registered under its file name.
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

/**
 * Register the bundled skills.
 *
 * The registry is resolved lazily - its absence skips the skills and never the
 * tools - and a missing file is a warning rather than a failure, because both
 * installers also copy these folders into `$DSH_HOME/skills`, so a host without
 * the registry still gets them from the filesystem provider. Each skill is
 * registered with its own `path` and a `resourceBase` pointing at the skill's
 * DIRECTORY, so anything beside the document is reachable by name.
 *
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled skill was not registered (the installers also copy it into $DSH_HOME/skills)')
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
            provider: 'dsh-research',
            // `source` is required by the registry's own definition validator and
            // `path` is what makes the entry file-backed, so a skills browser can
            // show and edit the document the model was actually given.
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-research: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

/**
 * Activate the row.
 *
 * @param ctx - the cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-research] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-research] ' + text),
    debug: (text) => ctx.logger?.debug?.('[dsh-research] ' + text),
  }

  log.info(
    'active: ' + TOOL_NAMES.length + ' tools, ' + GATE_IDS.length + ' gates, ' + API_ROUTES.length + ' routes, ' +
      FORMATS_READY.length + ' formats; no socket, no child process',
  )

  const skillCount = registerSkills(ctx, log)
  log.info('registered ' + skillCount + ' bundled skill(s)')

  for (const tool of buildTools({ env: process.env, log })) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-research: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes({ ctx, log }), 'dsh-research: routes')

  // Nothing here holds a process, a socket or a timer: a run is files on disk and
  // a route reads them per request. There is no state to dispose and therefore no
  // cache to invalidate - which is the point of the design, not an oversight.
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  PLUGIN_VERSION,
  ROOT_ENV,
  REFUSAL_CODES,
  TOOL_NAMES,
  GATE_IDS,
  API_ROOT,
  API_ROUTES,
  STATE_ROUTE,
  PROJECT_ROUTE,
  GATE_ROUTE,
  SOURCE_ROUTE,
  ARTIFACT_ROUTE,
  FILE_ROUTE,
  BUILD_ROUTE,
  HEALTH_ROUTE,
  SKILL_FILES,
  parseSkillFile,
  registerSkills,
  // The model, re-exported so a check can drive it without a cordis context.
  answerGate,
  canonicalRoot,
  healthView,
  projectView,
  readRun,
  resolveRoot,
  stateView,
  workspaceOf,
}
