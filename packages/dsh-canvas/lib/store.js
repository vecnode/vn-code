/**
 * dsh-canvas — WHERE a design lives, and why not somewhere cleverer.
 *
 * The reasoning is `dsh-diagrams`' reasoning, restated here because the choice is
 * the same and for the same reasons:
 *
 *   - **Not a session event.** `@deepseek-ai/dsh-session-persistence` refuses a
 *     log carrying a type outside `KNOWN_SESSION_EVENT_TYPES` unless the envelope
 *     sets `ignorable: true`, and `Session.append()` cannot set that marker - so a
 *     plugin-owned event type would make a conversation unreadable.
 *   - **Not a projection.** A projection unit needs a `zod` schema object and
 *     this pack ships zero npm dependencies (the profile installs live links, so
 *     a package dependency is not installed beside it).
 *   - **A file per conversation**, under `$DSH_HOME/dsh-canvas/`:
 *     `sessions/<session>.json` for the designs a chat asked for, `library.json`
 *     for the harness-wide ones, and `assets/` for the images a design may
 *     reference, content-addressed so the same picture imported twice costs one
 *     copy. The host is the only writer; the browser reads it over the plugin's
 *     own authenticated route; the model reads it back through `canvas_read` -
 *     which is what makes a design survive compaction, a reload, or the browser
 *     closing.
 *
 * Every write is atomic (a private temp name, then a rename over the target), the
 * whole store is capped, and the per-conversation DOCUMENT budget - not the file
 * cap - is the thing that binds, so crossing the file cap means the file is not
 * ours.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** At most this many designs per conversation (and in the library). */
export const MAX_DESIGNS = 64
/** One design document is cut here (a poster, not a book). */
export const MAX_DOCUMENT_BYTES = 256 * 1024
/**
 * All the documents in one conversation together are cut here. This is the budget
 * the WRITE enforces, with a typed error the model can act on, instead of a file
 * that grows too large to load.
 */
export const MAX_CONVERSATION_DOCUMENT_BYTES = 4 * 1024 * 1024
/** The whole per-conversation file is refused above this (see the note above). */
export const MAX_STATE_BYTES = 16 * 1024 * 1024
/** Asset caps: one image, how many, and the whole cache. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024
export const MAX_ASSETS = 256
export const MAX_ASSET_TOTAL_BYTES = 256 * 1024 * 1024
/** Title length cap; the id is derived from it. */
export const MAX_TITLE_CHARS = 120
/** The id grammar; also what the browser puts in a tab address and a patch names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
/** The two places a design can live. */
export const SCOPES = ['conversation', 'library']

/** One typed store failure. */
export function storeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** The harness config root: `$DSH_HOME`, else `~/.dsh` (the resolution the installer and the terminal use). */
export function resolveHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/** A filesystem-safe file name for a session id, plus a short hash so two ids that sanitize alike stay apart. */
function safeSessionName(sessionId) {
  const base = String(sessionId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80)
  const digest = createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 10)
  return base + '-' + digest
}

/** Slug one title into an id candidate. */
export function slugify(text, fallback = 'design') {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const trimmed = slug.replace(/-+$/g, '')
  return trimmed.length > 0 ? trimmed : fallback
}

/**
 * What the BROWSER reported about THIS revision, in one objective word.
 *
 * Exactly `dsh-diagrams`' vocabulary, because it is the honest one and the model
 * already reads it elsewhere:
 *
 *   - `drawn`   - a renderer reported success FOR THIS REVISION, and the report
 *                 carries the PNG path the model can read with `read_image`;
 *   - `failed`  - a renderer reported failure FOR THIS REVISION, with its own
 *                 error; what the user sees is that error, not a picture;
 *   - `stale`   - the newest report names a DIFFERENT revision, so this revision
 *                 has never been drawn whatever the older report said;
 *   - `pending` - no report at all.
 *
 * A revision that validates is NOT a picture, and only a renderer can report one,
 * so `state` is never optimistic. Options are OMITTED when there is nothing to
 * say (a key that is only sometimes meaningful must be absent, never null: the
 * tool registry validates the value against the declared schema and rejects
 * `undefined`, which JSON drops).
 */
export function verificationOf(entry) {
  const current = Number.isFinite(entry && entry.revision) ? entry.revision : 0
  const report = entry ? entry.render : null
  if (!report) return { state: 'pending', revision: current }
  const reported = Number.isFinite(report.revision) ? report.revision : null
  if (reported === null || reported !== current) {
    const stale = { state: 'stale', revision: current }
    if (reported !== null) stale.reported = reported
    if (typeof report.at === 'string' && report.at.length > 0) stale.at = report.at
    return stale
  }
  const verdict = { state: report.ok ? 'drawn' : 'failed', revision: current, reported: current }
  if (typeof report.error === 'string' && report.error.length > 0) verdict.error = report.error
  if (typeof report.path === 'string' && report.path.length > 0) verdict.path = report.path
  if (typeof report.width === 'number') verdict.width = report.width
  if (typeof report.height === 'number') verdict.height = report.height
  if (typeof report.at === 'string' && report.at.length > 0) verdict.at = report.at
  return verdict
}

/** One design's summary, for the list, the tab rail and the library. */
export function summarize(entry, scope) {
  const lints = Array.isArray(entry.lints) ? entry.lints : []
  return {
    id: entry.id,
    scope,
    title: entry.title ?? entry.id,
    preset: entry.preset ?? null,
    revision: Number.isFinite(entry.revision) ? entry.revision : 0,
    document: entry.document,
    verification: verificationOf(entry),
    // The browser's numbers and judgements travel with the summary: the rail's
    // pill, the conversation card and `canvas_read` must not be able to disagree.
    metrics: entry.metrics ?? null,
    lints,
    errors: lints.filter((entry_) => entry_.level === 'error').length,
    warnings: lints.filter((entry_) => entry_.level === 'warn').length,
    fonts: Array.isArray(entry.fonts) ? entry.fonts : [],
    bytes: Buffer.byteLength(JSON.stringify(entry.document), 'utf8'),
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    by: entry.by ?? 'model',
  }
}

/** One entry's document size in bytes. */
function documentBytes(entry) {
  return Buffer.byteLength(JSON.stringify(entry.document), 'utf8')
}

/**
 * The per-conversation (or harness-wide library) design store.
 *
 * The class is identical for both scopes; only the file name differs, which is
 * what keeps the library from growing a second set of rules.
 */
export class CanvasStore {
  /**
   * @param options - `{ home, scope, sessionId, log }`; `scope` is
   *   `'conversation'` (one file per session) or `'library'` (one file for the
   *   whole harness).
   */
  constructor(options = {}) {
    this.home = options.home ?? resolveHome()
    this.scope = options.scope === 'library' ? 'library' : 'conversation'
    this.sessionId = options.sessionId ?? null
    this.log = options.log ?? { warn() {}, info() {}, debug() {} }
    this.root = path.join(this.home, 'dsh-canvas')
    this.dir = path.join(this.root, 'sessions')
    this.file = this.scope === 'library' ? path.join(this.root, 'library.json') : path.join(this.dir, safeSessionName(this.sessionId) + '.json')
    this.state = null
  }

  /** The empty state. */
  static empty() {
    return { version: 1, order: [], designs: {} }
  }

  /**
   * The state, read from disk on first use. A file past {@link MAX_STATE_BYTES}
   * reads as EMPTY rather than throwing: losing designs must never break a
   * conversation, which is exactly why the document budget is what binds.
   */
  read() {
    if (this.state !== null) return this.state
    try {
      if (!existsSync(this.file)) {
        this.state = CanvasStore.empty()
        return this.state
      }
      if (statSync(this.file).size > MAX_STATE_BYTES) {
        this.log.warn('[dsh-canvas] the state file is larger than this plugin can have written; reading it as empty: ' + this.file)
        this.state = CanvasStore.empty()
        return this.state
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.state =
        parsed && typeof parsed === 'object' && parsed.designs && typeof parsed.designs === 'object'
          ? { version: 1, order: Array.isArray(parsed.order) ? parsed.order.filter((id) => typeof id === 'string') : [], designs: parsed.designs }
          : CanvasStore.empty()
    } catch (err) {
      this.log.warn('[dsh-canvas] could not read ' + this.file + ': ' + (err && err.message ? err.message : err))
      this.state = CanvasStore.empty()
    }
    return this.state
  }

  /** Write the whole state atomically (private temp name, then rename). */
  write() {
    const state = this.read()
    mkdirSync(this.scope === 'library' ? this.root : this.dir, { recursive: true })
    const payload = JSON.stringify(state, null, 2)
    const temp = this.file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
    return state
  }

  /** Every design, in `order` first and then any stragglers, newest last. */
  list() {
    const state = this.read()
    const seen = new Set()
    const out = []
    for (const id of state.order) {
      if (!state.designs[id]) continue
      seen.add(id)
      out.push(summarize(state.designs[id], this.scope))
    }
    for (const [id, entry] of Object.entries(state.designs)) {
      if (seen.has(id)) continue
      out.push(summarize(entry, this.scope))
    }
    return out
  }

  /** One entry (the raw record, with its document), or null. */
  get(id) {
    const state = this.read()
    const key = String(id ?? '')
    return Object.prototype.hasOwnProperty.call(state.designs, key) ? state.designs[key] : null
  }

  /** A free id for a title, never colliding with an existing design. */
  freeId(title) {
    const state = this.read()
    const base = slugify(title, 'design')
    if (!state.designs[base]) return base
    for (let index = 2; index < 200; index += 1) {
      const candidate = base + '-' + index
      if (!state.designs[candidate]) return candidate
    }
    throw storeError('ID_EXHAUSTED', 'could not find a free id for "' + base + '"')
  }

  /**
   * Create or replace one design. The DOCUMENT is already validated by the
   * caller (the tools and the routes both go through the same validator), so this
   * only enforces the caps and the bookkeeping.
   *
   * @returns the stored entry.
   */
  put(options) {
    const state = this.read()
    const id = String(options.id)
    if (!ID_PATTERN.test(id)) throw storeError('BAD_ID', 'the id ' + JSON.stringify(id) + ' must match ' + ID_PATTERN)
    const existing = state.designs[id] ?? null
    if (!existing && state.order.length >= MAX_DESIGNS) {
      throw storeError('TOO_MANY_DESIGNS', 'this ' + (this.scope === 'library' ? 'library' : 'conversation') + ' already holds ' + MAX_DESIGNS + ' designs; delete one first')
    }
    const entry = {
      id,
      title: typeof options.title === 'string' && options.title.length > 0 ? options.title.slice(0, MAX_TITLE_CHARS) : existing ? existing.title : id,
      preset: options.preset ?? null,
      document: options.document,
      revision: (Number.isFinite(existing && existing.revision) ? existing.revision : 0) + 1,
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      by: options.by ?? 'model',
      // A write INVALIDATES the previous verdict: the picture the browser drew
      // was of the previous revision, and `verificationOf` turns that into
      // `stale` the moment the revision moves. The record is kept, not dropped,
      // so the tab can still show the last picture while the new one is pending.
      render: existing ? existing.render ?? null : null,
      metrics: existing ? existing.metrics ?? null : null,
      lints: existing ? existing.lints ?? [] : [],
      fonts: existing ? existing.fonts ?? [] : [],
      history: existing && Array.isArray(existing.history) ? existing.history.slice(-19) : [],
    }
    if (existing && options.note) {
      entry.history.push({ revision: entry.revision, at: entry.updatedAt, note: String(options.note).slice(0, 200) })
    }
    const bytes = documentBytes(entry)
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw storeError('DOCUMENT_TOO_LARGE', 'this document is ' + Math.round(bytes / 1024) + ' KB; the cap is ' + Math.round(MAX_DOCUMENT_BYTES / 1024) + ' KB')
    }
    const others = Object.values(state.designs).filter((other) => other.id !== id).reduce((sum, other) => sum + documentBytes(other), 0)
    if (others + bytes > MAX_CONVERSATION_DOCUMENT_BYTES) {
      throw storeError(
        'DOCUMENT_BUDGET',
        'this would put ' + Math.round((others + bytes) / 1024) + ' KB of designs in one conversation; the budget is ' +
          Math.round(MAX_CONVERSATION_DOCUMENT_BYTES / 1024) + ' KB. Delete or shrink a design first.',
      )
    }
    state.designs[id] = entry
    if (!state.order.includes(id)) state.order.push(id)
    this.write()
    return entry
  }

  /** Remove one design; returns whether it existed. */
  remove(id) {
    const state = this.read()
    const key = String(id ?? '')
    if (!state.designs[key]) return false
    delete state.designs[key]
    state.order = state.order.filter((entry) => entry !== key)
    this.write()
    return true
  }

  /**
   * Record what the browser said about one revision: the verdict, the picture it
   * wrote, and the measurements and lints that came with it.
   */
  recordRender(id, report) {
    const state = this.read()
    const key = String(id ?? '')
    const entry = state.designs[key]
    if (!entry) return null
    entry.render = {
      revision: Number.isFinite(report.revision) ? report.revision : entry.revision,
      ok: report.ok === true,
      at: new Date().toISOString(),
    }
    if (typeof report.error === 'string' && report.error.length > 0) entry.render.error = report.error
    if (typeof report.path === 'string' && report.path.length > 0) entry.render.path = report.path
    if (typeof report.width === 'number') entry.render.width = report.width
    if (typeof report.height === 'number') entry.render.height = report.height
    if (Array.isArray(report.lints)) entry.lints = report.lints.slice(0, 64)
    if (report.metrics && typeof report.metrics === 'object') entry.metrics = report.metrics
    if (Array.isArray(report.fonts)) entry.fonts = report.fonts.slice(0, 8)
    this.write()
    return entry
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** PNG / JPEG / GIF / WebP dimensions, read from the file's own header. */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 16) return null
  // PNG: 8-byte signature, then IHDR with width/height as big-endian u32.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' }
  }
  // GIF: "GIF87a"/"GIF89a", then little-endian u16 width/height.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: 'gif' }
  }
  // WebP: RIFF....WEBP with a VP8/VP8L/VP8X chunk.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width, height, format: 'webp' }
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, format: 'webp' }
    }
    if (kind === 'VP8L' && bytes.length >= 25) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' }
    }
    return null
  }
  // JPEG: SOI, then segments; SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 carry the size.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = bytes.readUInt16BE(offset + 2)
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
      if (isSof) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), format: 'jpeg' }
      offset += 2 + Math.max(2, length)
    }
    return null
  }
  return null
}

/** The suffix an image's own bytes imply, or null. */
export function imageExtension(bytes) {
  const size = imageSize(bytes)
  if (size) return size.format === 'jpeg' ? 'jpg' : size.format
  return null
}

/**
 * The asset store: every image a design may reference, content-addressed and
 * capped. One directory for the whole harness, because a picture imported in one
 * conversation is the same picture in the next.
 */
export class AssetStore {
  constructor(options = {}) {
    this.home = options.home ?? resolveHome()
    this.log = options.log ?? { warn() {} }
    this.dir = path.join(this.home, 'dsh-canvas', 'assets')
    this.index = path.join(this.dir, 'index.json')
    this.cache = null
  }

  read() {
    if (this.cache !== null) return this.cache
    try {
      if (!existsSync(this.index)) {
        this.cache = { version: 1, assets: {} }
        return this.cache
      }
      const parsed = JSON.parse(readFileSync(this.index, 'utf8'))
      this.cache = parsed && typeof parsed === 'object' && parsed.assets && typeof parsed.assets === 'object' ? { version: 1, assets: parsed.assets } : { version: 1, assets: {} }
    } catch (err) {
      this.log.warn('[dsh-canvas] could not read the asset index: ' + (err && err.message ? err.message : err))
      this.cache = { version: 1, assets: {} }
    }
    return this.cache
  }

  write() {
    const state = this.read()
    mkdirSync(this.dir, { recursive: true })
    const temp = this.index + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
    writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.index)
    return state
  }

  /** Every asset, newest last. */
  list() {
    const state = this.read()
    return Object.values(state.assets)
      .map((entry) => ({ name: entry.name, bytes: entry.bytes, width: entry.width ?? null, height: entry.height ?? null, at: entry.at ?? null }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }

  /** The absolute path of one asset, or null when the name is not one of ours. */
  path(name) {
    const key = String(name ?? '')
    const state = this.read()
    // The index is keyed by the content digest; a DESIGN references the file
    // name (digest + extension), so the lookup is by `name`, not by digest.
    const record = Object.values(state.assets).find((entry) => entry.name === key)
    if (!record) return null
    const file = path.join(this.dir, record.name)
    return existsSync(file) ? file : null
  }

  /**
   * Add one image. Identity is the SHA-256 of the bytes, so importing the same
   * picture twice costs one copy and a re-import is a no-op.
   *
   * @param options - `{ bytes, ext?, label? }`.
   * @returns the asset record.
   */
  add(options) {
    const bytes = options.bytes
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw storeError('BAD_ASSET', 'the asset has no bytes')
    if (bytes.length > MAX_ASSET_BYTES) {
      throw storeError('ASSET_TOO_LARGE', 'the image is ' + Math.round(bytes.length / 1024) + ' KB; the cap is ' + Math.round(MAX_ASSET_BYTES / 1024) + ' KB')
    }
    const size = imageSize(bytes)
    if (!size) {
      throw storeError('BAD_ASSET', 'this is not a PNG, JPEG, GIF or WebP image (assets must be pictures the browser can decode)')
    }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const state = this.read()
    const ext = options.ext && /^[a-z0-9]{2,4}$/.test(options.ext) ? options.ext : size.format === 'jpeg' ? 'jpg' : size.format
    const name = digest + '.' + ext
    const existing = state.assets[digest]
    if (existing && existsSync(path.join(this.dir, existing.name))) {
      return { ...existing, deduplicated: true }
    }
    const keys = Object.keys(state.assets)
    if (keys.length >= MAX_ASSETS) {
      const total = Object.values(state.assets).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
      if (total >= MAX_ASSET_TOTAL_BYTES) {
        throw storeError('ASSET_BUDGET', 'the asset cache holds ' + keys.length + ' images (' + Math.round(total / 1024 / 1024) + ' MB); delete one before adding another')
      }
    }
    mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, name)
    const temp = file + '.' + process.pid + '.tmp'
    writeFileSync(temp, bytes, { mode: 0o600 })
    renameSync(temp, file)
    const record = {
      name,
      bytes: bytes.length,
      width: size.width,
      height: size.height,
      format: size.format,
      label: typeof options.label === 'string' ? options.label.slice(0, 120) : null,
      at: new Date().toISOString(),
    }
    state.assets[digest] = record
    this.write()
    return record
  }

  /** Remove one asset by the name a design references. */
  remove(name) {
    const key = String(name ?? '')
    const state = this.read()
    const record = Object.values(state.assets).find((entry) => entry.name === key)
    if (!record) return false
    for (const [digest, entry] of Object.entries(state.assets)) {
      if (entry.name !== key) continue
      delete state.assets[digest]
      break
    }
    const file = path.join(this.dir, key)
    try {
      if (existsSync(file)) rmSync(file)
    } catch (err) {
      this.log.warn('[dsh-canvas] could not delete ' + file + ': ' + (err && err.message ? err.message : err))
    }
    this.write()
    return true
  }

  /** The `src` -> `{width, height}` table the layout needs, from the index alone. */
  table() {
    const out = {}
    for (const entry of Object.values(this.read().assets)) {
      out[entry.name] = { width: entry.width, height: entry.height, bytes: entry.bytes }
    }
    return out
  }
}

/** The directory the browser's rendered PNGs land in. */
export function rendersDirectory(home, sessionId) {
  return path.join(home ?? resolveHome(), 'dsh-canvas', 'renders', safeSessionName(sessionId))
}

/** The file a render report is written to (one per revision, so a re-render overwrites its own). */
export function renderPath(home, sessionId, designId, revision, scale) {
  const suffix = scale && scale !== 1 ? '@' + String(scale).replace('.', '_') + 'x' : ''
  return path.join(rendersDirectory(home, sessionId), designId + '-r' + revision + suffix + '.png')
}

/** Every file the pack might have written, for a status or a cleanup. */
export function canvasRoot(home) {
  return path.join(home ?? resolveHome(), 'dsh-canvas')
}

/** Whether a directory holds anything (used by the status line). */
export function directorySummary(dir) {
  try {
    if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0 }
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
    let bytes = 0
    for (const entry of entries) {
      try {
        bytes += statSync(path.join(dir, entry.name)).size
      } catch (err) {
        /* ignore */
      }
    }
    return { exists: true, files: entries.length, bytes }
  } catch (err) {
    return { exists: false, files: 0, bytes: 0 }
  }
}
