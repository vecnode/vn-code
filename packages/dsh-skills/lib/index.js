/**
 * dsh-skills — Node half.
 *
 * The SKILLS BROWSER's host side: three authenticated `connection.fetch` routes
 * under /api/dsh-skills/*, the same mechanism dsh-editor and dsh-pdf use.
 *
 *   GET  /api/dsh-skills/list?session=<id>        the effective catalog
 *   GET  /api/dsh-skills/body?session=&name=      one skill's markdown
 *   POST /api/dsh-skills/save                     write that markdown back
 *
 * WHY A ROUTE IS NEEDED AT ALL. The harness already ships a `skills/list`
 * Remote, and it is the wrong catalog for this surface on purpose: it answers
 * `{ name, description, whenToUse, modelInvocable }` for USER-invocable skills
 * only, with no path, no source, no provider and no body — it exists to feed the
 * composer's `/` menu. Showing a skill, saying where it came from and editing its
 * document all need the registry itself, which lives on the HOST
 * (`ctx.skills`, from `@deepseek-ai/dsh-skill`).
 *
 * WHAT "THE EFFECTIVE CATALOG" MEANS HERE, and why it is the right list: this
 * reads `ctx.skills.snapshot({ cwd, scope })` — the SAME registry, with the SAME
 * workspace cwd and the SAME agent scope, that the system prompt's skill catalog
 * and the `skill` tool read. So the modal cannot disagree with what the model was
 * given: a skill shadowed by a higher-ranked copy is one row, not two, and the row
 * names the copy that actually won. `cwd` comes from the session (the live header
 * while it runs, the stored header otherwise) exactly as dsh-editor resolves it,
 * and `scope` selects the agent preset's layer — resolved through
 * `agentPresets.standingKeyFor` for a cold session, so a preset-mounted skill is
 * still listed.
 *
 * PATHS COME FROM `get()`, NOT FROM `list()`. The registry's summary type
 * deliberately carries no path (`toSummary` drops it), so each entry is loaded
 * once through `ctx.skills.get(name, …)` to obtain the definition — which is
 * where `path` and `content` live. A handful of small Markdown files per request;
 * the catalog is memoized for a moment so opening the modal is one round of reads.
 *
 * EVERY WRITE IS ADDRESSED BY SKILL NAME, NEVER BY PATH. The client sends a
 * skill's name and the new text; the path written is the one the REGISTRY just
 * resolved for that name, so a request cannot name a file this plugin would not
 * have offered. Before the write the text is checked for the frontmatter the
 * registry requires (a text-level guard — this pack ships no YAML parser, and the
 * registry's own parser stays the authority), the target must be a regular `.md`
 * file, and the save is refused (409) when the file's stat moved since the client
 * opened it, so a save cannot silently clobber a concurrent edit by the agent.
 * The publish itself is atomic (private temp beside the target, then a rename).
 *
 * NO CORE ROW IS TOUCHED and nothing is patched: this row reads a shipped service
 * and answers its own routes.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-skills'

/** Version marker, logged at activation; the client's constant must match it. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-skills'
const LIST_ROUTE = API_ROOT + '/list'
const BODY_ROUTE = API_ROOT + '/body'
const SAVE_ROUTE = API_ROOT + '/save'

/** A skill document above this size is refused (read and write). */
const MAX_TEXT_BYTES = 1024 * 1024

/** How long one catalog reading is reused, so a modal open is one set of reads. */
const CATALOG_TTL_MS = 1500

// ---------------------------------------------------------------------------
// HTTP plumbing (mirrors dsh-editor's)
// ---------------------------------------------------------------------------
/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Typed failure → HTTP response. */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

function readErrorToResponse(err) {
  const status = typeof err.status === 'number' ? err.status : 500
  const code = err.code || 'IO_ERROR'
  const message = err.message || String(err)
  return json(status, { ok: false, error: { code, message } })
}

/** A readable message for anything a service can throw. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Resolve one host service by name, or undefined (a bare context has no `get`). */
function serviceOf(ctx, serviceName) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
  } catch (err) {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The session view: which project folder, and which agent scope
// ---------------------------------------------------------------------------
/**
 * Resolve the catalog's VIEW for one conversation: the project cwd that selects
 * project skill roots, the agent scope that selects the preset's layer, and the
 * registry that serves that composition.
 *
 * Nothing here is fatal. A conversation whose folder cannot be resolved still
 * lists every skill that is not tied to a project, and says so in a `warning`
 * rather than failing the whole modal — a browser is more useful than a refusal
 * when the missing half is "the project's own skills".
 *
 * @param ctx - the plugin context.
 * @param sessionId - the conversation the browser is showing, if any.
 * @returns {Promise<{ cwd?: string, scope?: unknown, registry?: unknown, warning: string }>}
 */
async function viewFor(ctx, sessionId) {
  const out = { cwd: undefined, scope: undefined, registry: undefined, warning: '' }
  out.registry = serviceOf(ctx, 'skills')
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    out.warning = 'No conversation was named, so skills tied to a project folder may be missing.'
    return out
  }
  // The live agent is what selects an agent preset's LAYER, and it is looked up
  // first because a running conversation is the common case. It carries no
  // header, so cwd and preset come from the session itself (below).
  let live
  try {
    const agents = serviceOf(ctx, 'agents')
    live = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  } catch (err) {
    live = undefined
  }
  let preset
  // WHERE THE HEADER COMES FROM, in order of freshness: the live Session (what
  // dsh-editor reads for its own workspace root), then the projected session
  // query the shipped skill catalog uses, then the stored header — which is the
  // one a conversation that is not running in this process still has.
  try {
    const sessions = serviceOf(ctx, 'sessions')
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = session !== undefined && session !== null ? session.header : undefined
    if (header !== undefined && header !== null) {
      if (typeof header.cwd === 'string' && header.cwd.length > 0) out.cwd = header.cwd
      if (typeof header.agentPreset === 'string') preset = header.agentPreset
    }
  } catch (err) {
    /* fall through to the next source */
  }
  if (out.cwd === undefined || preset === undefined) {
    const sessionQuery = serviceOf(ctx, 'sessionQuery')
    if (sessionQuery !== undefined && sessionQuery !== null && typeof sessionQuery.observeSession === 'function') {
      let observation
      try {
        observation = await sessionQuery.observeSession(sessionId)
        const header = observation !== undefined && observation !== null ? observation.header : undefined
        if (header !== undefined && header !== null) {
          if (out.cwd === undefined && typeof header.cwd === 'string' && header.cwd.length > 0) out.cwd = header.cwd
          if (preset === undefined && typeof header.agentPreset === 'string') preset = header.agentPreset
        }
        const values = observation !== undefined && observation !== null && observation.projections !== undefined && observation.projections !== null ? observation.projections.values : undefined
        if (preset === undefined && values !== undefined && values !== null && typeof values.agentPreset === 'string') preset = values.agentPreset
      } catch (err) {
        /* fall through to the stored header */
      } finally {
        // An observation is a borrowed read and its own disposal is what releases
        // it (the shipped catalog wraps it in a `using` for the same reason).
        try {
          if (observation !== undefined && observation !== null && typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
        } catch (err) {
          /* nothing this plugin can do about a failing dispose */
        }
      }
    }
  }
  if (out.cwd === undefined || preset === undefined) {
    try {
      const persistence = serviceOf(ctx, 'sessionPersistence')
      if (persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
        const snapshot = await persistence.stat(sessionId)
        const header = snapshot !== undefined && snapshot !== null ? snapshot.header : undefined
        if (header !== undefined && header !== null) {
          if (out.cwd === undefined && typeof header.cwd === 'string' && header.cwd.length > 0) out.cwd = header.cwd
          if (preset === undefined && typeof header.agentPreset === 'string') preset = header.agentPreset
        }
      }
    } catch (err) {
      /* an unreadable store degrades to the global layer, below */
    }
  }
  const presets = serviceOf(ctx, 'agentPresets')
  if (live !== undefined && live !== null) {
    // The preset's own registry view, when the deployment composes per session:
    // this is the exact registry the shipped skill catalog reads.
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function') {
      try {
        const scoped = presets.serviceFor(live, 'skills')
        if (scoped !== undefined && scoped !== null) out.registry = scoped
      } catch (err) {
        /* fall back to the global registry */
      }
    }
    out.scope = live
  } else if (preset !== undefined && presets !== undefined && presets !== null && typeof presets.standingKeyFor === 'function') {
    // A cold conversation: the standing key for its recorded preset, resolved
    // without creating an Agent (the same call the shipped catalog makes).
    try {
      out.scope = await presets.standingKeyFor(preset)
    } catch (err) {
      out.scope = undefined
    }
  }
  if (out.cwd === undefined) {
    out.warning = 'The folder of this conversation could not be resolved, so project skills may be missing.'
  }
  return out
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------
/** The catalog reading that is currently memoized, if it is still fresh. */
let catalogMemo = null

/**
 * The invocation policy of one skill, defaulted to "both may invoke it".
 *
 * The registry permits an undefined policy on a loaded definition (its own
 * validator only checks the SHAPE when one is present), so a provider that never
 * set it must not turn a listing into a TypeError — an absent policy means the
 * same thing a fresh runtime registration gets: the model and the user.
 */
function invocationOf(skill) {
  const policy = skill !== undefined && skill !== null && typeof skill.invocation === 'object' && skill.invocation !== null ? skill.invocation : {}
  return {
    modelInvocable: policy.modelInvocable !== false,
    userInvocable: policy.userInvocable !== false,
  }
}

/**
 * Where one skill's TEXT is held, which decides when a saved file is loaded.
 *
 * The shipped filesystem provider (`@deepseek-ai/dsh-skill-filesystem`, whose
 * name in the box is `filesystem`) watches its roots, so a file it serves is
 * re-read as soon as it changes. Any OTHER provider is a plugin that read the
 * file (or holds the text outright) when the harness started, so its definition
 * is what the model keeps getting until the next start — the browser states
 * exactly that instead of promising a reload that will not happen. Erring towards
 * "restart" is the safe direction: a restart always re-reads the file.
 */
function provenanceOf(skill) {
  const provider = skill !== undefined && skill !== null && typeof skill.provider === 'string' ? skill.provider : ''
  const runtime = provider !== 'filesystem'
  return { runtime, reload: runtime ? 'restart' : 'live' }
}

/**
 * One skill, as the browser needs it: the registry's own summary plus the file
 * the winning definition came from.
 *
 * @param summary - the registry summary (name, description, source, provider, invocation).
 * @param definition - the loaded definition, or undefined when loading failed.
 * @param stats - the file's stat, or undefined.
 */
function describeEntry(summary, definition, stats) {
  const filePath = definition !== undefined && typeof definition.path === 'string' ? definition.path : null
  const base = definition !== undefined && definition.resourceBase && definition.resourceBase.kind === 'directory' ? definition.resourceBase.path : null
  const provenance = provenanceOf(summary)
  const policy = invocationOf(summary)
  return {
    name: summary.name,
    description: summary.description,
    whenToUse: typeof summary.whenToUse === 'string' ? summary.whenToUse : '',
    // A registration need not name its source bucket; the registry's own badge
    // for one is `runtime`, so an absent source means exactly that.
    source: typeof summary.source === 'string' && summary.source.length > 0 ? summary.source : 'runtime',
    provider: typeof summary.provider === 'string' ? summary.provider : '',
    modelInvocable: policy.modelInvocable,
    userInvocable: policy.userInvocable,
    path: filePath,
    dir: base !== null ? base : filePath !== null ? path.dirname(filePath) : null,
    // A directory-bundle skill is the `SKILL.md` every provider looks for; a flat
    // one is a single Markdown file in a shared root. The difference matters to a
    // reader (which file do I create next to it?) and is free to state.
    kind: filePath === null ? 'runtime' : path.basename(filePath).toLowerCase() === 'skill.md' ? 'bundle' : 'file',
    editable: filePath !== null,
    characters: definition !== undefined && typeof definition.content === 'string' ? definition.content.length : 0,
    bytes: stats !== undefined ? stats.size : null,
    mtimeMs: stats !== undefined ? stats.mtimeMs : null,
    runtime: provenance.runtime,
    reload: provenance.reload,
  }
}

/** The file stamp of one skill document, or undefined when it cannot be read. */
async function statOf(filePath) {
  if (filePath === null) return undefined
  try {
    const stats = await fsp.stat(filePath)
    return stats.isFile() ? stats : undefined
  } catch (err) {
    return undefined
  }
}

/**
 * The effective catalog, with each entry's file loaded once.
 *
 * A definition that fails to load is NOT dropped: the row still appears, with
 * `editable: false` and no path, because "this skill is advertised but could not
 * be read" is exactly the fact a person opening a skills browser wants to see.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the conversation the browser is showing.
 * @param fresh - bypass the short memo (used after a save).
 */
async function catalogOf(ctx, sessionId, fresh = false) {
  const view = await viewFor(ctx, sessionId)
  const registry = view.registry
  if (registry === undefined || registry === null || typeof registry.snapshot !== 'function') {
    throw httpError(
      503,
      'NO_REGISTRY',
      'No skill registry is mounted in this profile, so there is no catalog to show.',
    )
  }
  // The memo is keyed on the view alone, and a `fresh` read REPLACES it for
  // every key: a save followed by a plain reload must never hand back the
  // catalog that was read before the write.
  const key = String(sessionId) + '\u0000' + String(view.cwd)
  if (!fresh && catalogMemo !== null && catalogMemo.key === key && Date.now() - catalogMemo.at < CATALOG_TTL_MS) {
    return catalogMemo.value
  }
  let snapshot
  try {
    snapshot = await registry.snapshot({ cwd: view.cwd, scope: view.scope })
  } catch (err) {
    throw httpError(500, 'LIST_FAILED', 'The skill registry could not be listed: ' + messageOf(err))
  }
  const summaries = Array.isArray(snapshot.skills) ? snapshot.skills : []
  const skills = []
  const unreadable = []
  for (const summary of summaries) {
    let definition
    try {
      definition = await registry.get(summary.name, { cwd: view.cwd, scope: view.scope })
    } catch (err) {
      definition = undefined
      unreadable.push(summary.name + ': ' + messageOf(err))
    }
    const filePath = definition !== undefined && typeof definition.path === 'string' ? definition.path : null
    skills.push(describeEntry(summary, definition, await statOf(filePath)))
  }
  const value = {
    ok: true,
    cwd: view.cwd === undefined ? null : view.cwd,
    complete: snapshot.complete !== false,
    warning: view.warning,
    unreadable,
    skills,
  }
  catalogMemo = { key, at: Date.now(), value }
  return value
}

// ---------------------------------------------------------------------------
// One skill's document
// ---------------------------------------------------------------------------
/**
 * Rebuild the frontmatter for a skill whose provider named no file.
 *
 * A runtime registration carries only the BODY it was given — the provider
 * parsed the frontmatter away — so the browser can still show the document a
 * person expects to see by putting those fields back at the top. It is marked
 * read-only and never saved, so the synthesis is a view, not an edit surface.
 */
function synthesizeDocument(definition) {
  const lines = ['---', 'name: ' + definition.name, 'description: ' + definition.description]
  if (typeof definition.whenToUse === 'string' && definition.whenToUse.length > 0) {
    lines.push('whenToUse: ' + definition.whenToUse)
  }
  lines.push('---', '')
  return lines.join('\n') + definition.content + '\n'
}

/**
 * The text-level guard every save must pass: the registry reads a skill out of
 * the frontmatter block, so a document without `name:` and `description:` in one
 * would be silently dropped from the catalog by the very next listing.
 *
 * This is deliberately NOT a YAML parse — this pack ships zero npm dependencies
 * and the registry's own parser (inside core) stays the authority — so it checks
 * the two fields it can check honestly and leaves the rest to that parser. A
 * document that passes here and still fails to load is reported by the next
 * `/list`, and the save's own answer carries the re-read verdict.
 *
 * @param text - the document as it would be written.
 * @returns `{ name, description }` from the frontmatter.
 * @throws a typed 400 when the document would not be a skill.
 */
function checkDocument(text) {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    throw httpError(400, 'NO_FRONTMATTER', 'A skill document must start with a --- frontmatter block naming the skill.')
  }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) {
    throw httpError(400, 'NO_FRONTMATTER', 'The --- frontmatter block is not closed.')
  }
  const block = normalized.slice(4, end)
  const field = (key) => {
    const match = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(block)
    return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
  }
  const skillName = field('name')
  const description = field('description')
  if (skillName === '') {
    throw httpError(400, 'NO_NAME', 'The frontmatter must carry a name: field — without it the registry ignores the file.')
  }
  if (description === '') {
    throw httpError(400, 'NO_DESCRIPTION', 'The frontmatter must carry a description: field — without it the registry ignores the file.')
  }
  return { name: skillName, description }
}

/** GET/HEAD /api/dsh-skills/list — the effective catalog for one conversation. */
async function handleList(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    const value = await catalogOf(ctx, sessionId, url.searchParams.get('fresh') === '1')
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return json(200, value)
  } catch (err) {
    return readErrorToResponse(err)
  }
}

/** GET/HEAD /api/dsh-skills/body?session=&name= — one skill's markdown. */
async function handleBody(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    const skillName = url.searchParams.get('name') || ''
    if (skillName.length === 0) return fail(400, 'BAD_REQUEST', 'A skill name is required.')
    const view = await viewFor(ctx, sessionId)
    const registry = view.registry
    if (registry === undefined || registry === null || typeof registry.get !== 'function') {
      throw httpError(503, 'NO_REGISTRY', 'No skill registry is mounted in this profile, so there is no skill to show.')
    }
    let definition
    try {
      definition = await registry.get(skillName, { cwd: view.cwd, scope: view.scope })
    } catch (err) {
      throw httpError(500, 'READ_FAILED', 'The skill could not be loaded: ' + messageOf(err))
    }
    if (definition === undefined) {
      throw httpError(404, 'NOT_FOUND', 'This conversation has no skill named "' + skillName + '".')
    }
    const filePath = typeof definition.path === 'string' ? definition.path : null
    const provenance = provenanceOf(definition)
    const policy = invocationOf(definition)
    const invocation = { modelInvocable: policy.modelInvocable, userInvocable: policy.userInvocable }
    if (filePath === null) {
      const text = synthesizeDocument(definition)
      return json(200, {
        ok: true,
        name: definition.name,
        path: null,
        text,
        editable: false,
        notice:
          'This skill is held by "' +
          String(definition.provider) +
          '", which named no file, so there is nothing here to edit — the text above is what the model is given.',
        version: null,
        bytes: Buffer.byteLength(text, 'utf8'),
        mtimeMs: null,
        size: null,
        source: typeof definition.source === 'string' && definition.source.length > 0 ? definition.source : 'runtime',
        provider: String(definition.provider),
        runtime: provenance.runtime,
        reload: provenance.reload,
        ...invocation,
      })
    }
    const stats = await statOf(filePath)
    if (stats === undefined) {
      throw httpError(404, 'NOT_FOUND', 'The skill file is no longer on disk: ' + filePath)
    }
    if (stats.size > MAX_TEXT_BYTES) {
      throw httpError(413, 'TOO_LARGE', 'The skill file is larger than 1 MiB and was not opened.')
    }
    const buffer = await fsp.readFile(filePath)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch (err) {
      throw httpError(415, 'NOT_TEXT', 'The skill file is not UTF-8 text.', err)
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return json(200, {
      ok: true,
      name: definition.name,
      path: filePath,
      text,
      editable: true,
      notice: '',
      version: String(stats.mtimeMs) + ':' + String(stats.size),
      bytes: buffer.byteLength,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      source: typeof definition.source === 'string' && definition.source.length > 0 ? definition.source : 'runtime',
      provider: String(definition.provider),
      runtime: provenance.runtime,
      reload: provenance.reload,
      ...invocation,
    })
  } catch (err) {
    return readErrorToResponse(err)
  }
}

/** POST /api/dsh-skills/save — write one skill's markdown back to its file. */
async function handleSave(ctx, request) {
  try {
    let payload
    try {
      payload = await request.json()
    } catch (err) {
      return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    }
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    const skillName = typeof payload.name === 'string' ? payload.name : ''
    const text = typeof payload.text === 'string' ? payload.text : null
    if (skillName.length === 0) return fail(400, 'BAD_REQUEST', 'A skill name is required.')
    if (text === null) return fail(400, 'BAD_REQUEST', 'Expected a text field.')
    const content = Buffer.from(text, 'utf8')
    if (content.byteLength > MAX_TEXT_BYTES) {
      throw httpError(413, 'TOO_LARGE', 'The document would be larger than 1 MiB and was not saved.')
    }
    const view = await viewFor(ctx, sessionId)
    const registry = view.registry
    if (registry === undefined || registry === null || typeof registry.get !== 'function') {
      throw httpError(503, 'NO_REGISTRY', 'No skill registry is mounted in this profile, so there is no skill to save.')
    }
    let definition
    try {
      definition = await registry.get(skillName, { cwd: view.cwd, scope: view.scope })
    } catch (err) {
      throw httpError(500, 'READ_FAILED', 'The skill could not be loaded: ' + messageOf(err))
    }
    if (definition === undefined) {
      throw httpError(404, 'NOT_FOUND', 'This conversation has no skill named "' + skillName + '".')
    }
    const target = typeof definition.path === 'string' ? definition.path : null
    if (target === null) {
      throw httpError(
        409,
        'NOT_FILE_BACKED',
        'This skill is held by "' +
          String(definition.provider) +
          '" and names no file, so there is nothing to write.',
      )
    }
    // Defence in depth: every provider in the box yields a Markdown skill
    // document, and this route is only ever asked to write one of those.
    if (path.extname(target).toLowerCase() !== '.md') {
      throw httpError(409, 'NOT_MARKDOWN', 'The skill is not backed by a Markdown file, so it was not written.')
    }
    // Refuse BEFORE touching the disk: a document the registry would drop must
    // never replace a working one.
    checkDocument(text)
    const before = await statOf(target)
    if (before === undefined) {
      throw httpError(404, 'NOT_FOUND', 'The skill file is no longer on disk: ' + target)
    }
    const expected = payload.expected
    if (expected !== null && typeof expected === 'object' && typeof expected.mtimeMs === 'number') {
      const sameMtime = Math.abs(before.mtimeMs - expected.mtimeMs) < 1
      const sameSize = expected.size === undefined || expected.size === null || before.size === expected.size
      if (!sameMtime || !sameSize) {
        return json(409, {
          ok: false,
          error: {
            code: 'CHANGED_ON_DISK',
            message: 'The skill file changed on disk since it was opened — reload it before saving.',
            current: { mtimeMs: before.mtimeMs, size: before.size },
          },
        })
      }
    }
    // Atomic publish: a private temp beside the target, then a rename over it
    // (node's rename replaces an existing file on Windows too).
    const tmp = target + '.dsh-skills-' + process.pid + '-' + Date.now() + '.tmp'
    try {
      await fsp.writeFile(tmp, content, { flag: 'wx' })
      try {
        await fsp.rename(tmp, target)
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw httpError(500, 'IO_ERROR', 'The skill could not be written: ' + messageOf(err), err)
    }
    const after = await statOf(target)
    // Re-read what was just written and run the same guard: the answer states
    // whether the file still looks like a skill, instead of leaving the person to
    // discover it in the next listing.
    let saved
    try {
      saved = checkDocument(await fsp.readFile(target, 'utf8'))
    } catch (err) {
      saved = null
    }
    const provenance = provenanceOf(definition)
    return json(200, {
      ok: true,
      name: saved !== null ? saved.name : skillName,
      path: target,
      renamed: saved !== null && saved.name !== skillName,
      version: after !== undefined ? String(after.mtimeMs) + ':' + String(after.size) : null,
      bytes: content.byteLength,
      mtimeMs: after !== undefined ? after.mtimeMs : null,
      size: after !== undefined ? after.size : null,
      runtime: provenance.runtime,
      reload: provenance.reload,
      warning:
        saved === null
          ? 'The file was written, but it no longer reads as a skill — reload the catalog and check the frontmatter.'
          : '',
    })
  } catch (err) {
    return readErrorToResponse(err)
  }
}

/**
 * Activate the plugin row: register the authenticated routes.
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  const connection = ctx.get ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-skills] connection service unavailable - skill routes not registered')
    return
  }
  ctx.effect(() => {
    ctx.logger?.debug?.('[dsh-skills] node half active (' + PLUGIN_VERSION + ')')
    // `requestBody: 'buffered'` is REQUIRED for the same reason dsh-editor
    // records: Connection's HTTP bridge picks the streaming branch when it is
    // left undefined, and building a streaming Request for a bodyless method
    // (GET/HEAD) throws before the handler ever runs.
    const offList = connection.fetch.register({
      path: LIST_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => handleList(ctx, request),
    })
    const offBody = connection.fetch.register({
      path: BODY_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => handleBody(ctx, request),
    })
    const offSave = connection.fetch.register({
      path: SAVE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleSave(ctx, request),
    })
    return () => {
      catalogMemo = null
      try {
        offList()
      } catch (e) {}
      try {
        offBody()
      } catch (e) {}
      try {
        offSave()
      } catch (e) {}
      ctx.logger?.debug?.('[dsh-skills] node half disposed')
    }
  }, 'dsh-skills: catalog routes')
}
