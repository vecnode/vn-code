/**
 * dsh-writing — the persistent document store.
 *
 * WHERE a document lives, and why it is here rather than in the workspace:
 *
 *   - **Many documents, not one file.** A page you are writing is a DOCUMENT the
 *     tab owns, with a name, a page setup and a revision - the shape
 *     `dsh-diagrams` gives a diagram and `dsh-pdf` gives its index. A `.docx` in
 *     the conversation folder is an EXPORT of that document (and an import back
 *     into it), never the live copy, so nothing here can overwrite a file the
 *     person wrote by hand.
 *   - **A file per conversation**, under `$DSH_HOME/dsh-writing/sessions/`, plus
 *     one `library.json` for documents published to every conversation. The host
 *     is the only writer, the browser reads it over this plugin's authenticated
 *     routes, and the state survives a reload, a restart or the browser closing.
 *   - **Not a session event.** `@deepseek-ai/dsh-session-persistence` refuses a
 *     log carrying a type outside `KNOWN_SESSION_EVENT_TYPES` unless the event is
 *     marked ignorable, which `Session.append()` cannot do - the same reason
 *     `dsh-diagrams`' store is a file (its README has the whole argument).
 *
 * Every write is atomic (private temp name, then rename over the target), the
 * whole file is capped, and both budgets are enforced at the WRITE with a typed
 * error naming the numbers, so the model and the person are told what to do
 * rather than finding a file that grew too big to load.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_TITLE_CHARS,
  documentBytes,
  documentStats,
  normalizeBlocks,
  normalizeDocument,
  normalizeFont,
  normalizeFontSize,
  normalizePage,
  pageDimensions,
} from './model.js'
import { normalizeSheetDocument, normalizeSheets, sheetBytes, sheetStats } from './sheet.js'

/** At most this many documents per conversation. */
export const MAX_DOCUMENTS = 64
/** One document's own budget, in bytes (page setup plus blocks). */
export const MAX_DOCUMENT_BYTES = 512 * 1024
/** Every document in one conversation together is cut here. */
export const MAX_CONVERSATION_BYTES = 4 * 1024 * 1024
/**
 * The whole file is refused above this size. Deliberately far above the
 * conversation budget: because that budget is enforced first, nothing this
 * plugin writes can reach this number, so crossing it means the file is not one
 * of ours. It then reads as EMPTY rather than throwing - losing documents must
 * never break a conversation - which is exactly why the budget above must bind.
 */
export const MAX_STATE_BYTES = 16 * 1024 * 1024
/** The id grammar; also what the client puts in a tab address. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
/** How many history entries one document keeps. */
export const MAX_HISTORY = 20

/** A typed store failure the routes turn into a 4xx. */
function storeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * The harness config root: `$DSH_HOME`, else `~/.dsh` - the same resolution the
 * installer, the terminal and the pack's own stores use.
 * @param env - environment to read.
 * @returns the absolute DSH home path.
 */
export function resolveHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/** A filesystem-safe file name for a session id, plus a short hash so two ids that sanitize alike stay apart. */
function safeSessionName(sessionId) {
  const base = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 10)
  return base + '-' + digest
}

/** Slug one title into an id candidate. */
function slugify(text, fallback) {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const trimmed = slug.replace(/-+$/g, '')
  return trimmed.length > 0 ? trimmed : fallback
}

/** One entry as the index and the tab rail show it, without the blocks. */
function summarize(entry, scope) {
  const isSheet = entry.kind === 'sheet'
  const stats = isSheet ? sheetStats(entry) : documentStats(entry)
  const page = isSheet ? null : normalizePage(entry.page)
  const dimensions = page ? pageDimensions(page) : { widthMm: null, heightMm: null }
  return {
    id: entry.id,
    kind: isSheet ? 'sheet' : 'page',
    scope,
    title: entry.title,
    revision: Number.isFinite(entry.revision) ? entry.revision : 1,
    by: entry.by === 'model' ? 'model' : 'user',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    page,
    // A workbook has no page geometry and no document font of its own, and it
    // says so with nulls rather than pretending to be a page.
    font: isSheet ? null : entry.font ?? '',
    fontSize: isSheet ? null : entry.fontSize,
    sheets: isSheet ? normalizeSheets(entry.sheets).map((sheet) => sheet.name) : null,
    widthMm: dimensions.widthMm,
    heightMm: dimensions.heightMm,
    origin: entry.origin ?? null,
    blocks: stats.blocks,
    words: stats.words,
    characters: stats.characters,
    // A workbook counts its FILLED CELLS where a page counts words, because that
    // is the number that tells a person how much is in it.
    filled: isSheet ? stats.filled : null,
    bytes: isSheet ? sheetBytes(entry) : documentBytes(entry),
    history: Array.isArray(entry.history) ? entry.history.length : 0,
  }
}

/** The per-conversation (or shared library) document state. */
export class WritingStore {
  /**
   * @param options - `{ root, fixedFile }`.
   * @param options.root - absolute directory the store owns.
   * @param options.fixedFile - when set, this store keeps ONE file with that name
   *   directly under `root`, whatever key it is asked for. That is the LIBRARY:
   *   named once, a published document is the same document in every
   *   conversation, which is what makes its id citable from a chat that did not
   *   write it.
   */
  constructor({ root, fixedFile = null } = {}) {
    this.root = root ?? path.join(resolveHome(), 'dsh-writing')
    this.sessionsDir = path.join(this.root, 'sessions')
    this.fixedFile = fixedFile ?? null
    /** `library` for the shared store, `conversation` for a per-chat one. */
    this.scope = this.fixedFile ? 'library' : 'conversation'
    /** Loaded scopes, by store key. */
    this.loaded = new Map()
  }

  /** Absolute path of one scope's state file. */
  fileFor(scopeKey) {
    if (this.fixedFile) return path.join(this.root, this.fixedFile)
    return path.join(this.sessionsDir, safeSessionName(scopeKey) + '.json')
  }

  /** The empty state for a conversation that has none yet. */
  empty(sessionId) {
    return { version: 1, sessionId: String(sessionId), updatedAt: new Date().toISOString(), order: [], documents: {} }
  }

  /**
   * The scope's state, from memory or from disk on first use. A file that is
   * unreadable, malformed or oversized reads as empty rather than crashing the
   * row.
   * @param scopeKey - the conversation id, or `library`.
   * @returns the live state object (callers must not mutate it directly).
   */
  state(scopeKey) {
    const key = String(scopeKey)
    const cached = this.loaded.get(key)
    if (cached) return cached
    let state = this.empty(key)
    const file = this.fileFor(key)
    try {
      if (existsSync(file) && statSync(file).size <= MAX_STATE_BYTES) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.order) && parsed.documents && typeof parsed.documents === 'object') {
          const documents = {}
          for (const [id, entry] of Object.entries(parsed.documents)) {
            if (!ID_PATTERN.test(id) || !entry || typeof entry !== 'object') continue
            // A stored document is one of TWO kinds, and the kind decides which
            // half of the model the rest of this file reads. `page` is the
            // default so a file written before sheets existed still loads.
            const kind = entry.kind === 'sheet' ? 'sheet' : 'page'
            const shared = {
              id,
              kind,
              title: String(entry.title ?? 'Untitled').slice(0, MAX_TITLE_CHARS),
              createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
              updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
              revision: Number.isFinite(entry.revision) ? entry.revision : 1,
              by: entry.by === 'model' ? 'model' : 'user',
              origin: entry.origin && typeof entry.origin === 'object' ? entry.origin : null,
              history: Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY) : [],
            }
            documents[id] =
              kind === 'sheet'
                ? { ...shared, sheets: normalizeSheets(entry.sheets) }
                : {
                    ...shared,
                    page: normalizePage(entry.page),
                    font: normalizeFont(entry.font),
                    fontSize: normalizeFontSize(entry.fontSize),
                    blocks: normalizeBlocks(entry.blocks, { font: normalizeFont(entry.font), fontSize: normalizeFontSize(entry.fontSize) }),
                  }
          }
          state = {
            version: 1,
            sessionId: key,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            order: parsed.order.filter((id) => typeof id === 'string' && documents[id]).slice(0, MAX_DOCUMENTS),
            documents,
          }
        }
      }
    } catch (err) {
      state = this.empty(key)
    }
    this.loaded.set(key, state)
    return state
  }

  /** Persist one scope's state atomically. */
  save(scopeKey) {
    const state = this.state(scopeKey)
    state.updatedAt = new Date().toISOString()
    mkdirSync(this.sessionsDir, { recursive: true })
    const file = this.fileFor(scopeKey)
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch (cleanupErr) {
        /* nothing else to do */
      }
      throw err
    }
    return state
  }

  /**
   * The scope's documents, in creation order.
   * @param scopeKey - the conversation id, or `library`.
   * @returns `{ scopeKey, scope, updatedAt, documents: summaries[] }`.
   */
  list(scopeKey) {
    const state = this.state(scopeKey)
    return {
      scopeKey: state.sessionId,
      scope: this.scope,
      updatedAt: state.updatedAt,
      documents: state.order.map((id) => summarize(state.documents[id], this.scope)).filter(Boolean),
    }
  }

  /** One document with its blocks, or undefined. */
  get(scopeKey, id) {
    const entry = this.state(scopeKey).documents[id]
    if (!entry) return undefined
    return { ...entry, scope: this.scope, summary: summarize(entry, this.scope) }
  }

  /** Every id in the scope, in creation order. */
  ids(scopeKey) {
    return [...this.state(scopeKey).order]
  }

  /** Claim a unique id for a new document in one scope. */
  claimId(scopeKey, requested, title) {
    const state = this.state(scopeKey)
    if (typeof requested === 'string' && requested.length > 0) {
      if (!ID_PATTERN.test(requested)) {
        throw storeError('BAD_ID', 'A document id must be lowercase letters, digits and dashes (max 48 characters).')
      }
      return requested
    }
    const base = slugify(title, 'document')
    if (!state.documents[base]) return base
    for (let n = 2; n < 1000; n += 1) {
      const candidate = (base + '-' + n).slice(0, 48)
      if (!state.documents[candidate]) return candidate
    }
    throw storeError('LIMIT', 'Could not find a free document id.')
  }

  /**
   * Create or replace one document. The state-carrying write every caller uses.
   *
   * @param scopeKey - the conversation id, or `library`.
   * @param input - `{ id?, title?, page?, blocks?, by?, note?, origin?, expectedRevision? }`.
   * @returns the stored entry.
   */
  write(scopeKey, input) {
    const state = this.state(scopeKey)
    const requestedId = typeof input.id === 'string' && input.id.length > 0 ? input.id : null
    const existing = requestedId ? state.documents[requestedId] : undefined
    // Optimistic concurrency: the tab echoes the revision it loaded, and a save
    // whose document moved underneath it is REFUSED rather than silently
    // clobbering another tab's work. Only a caller that names an existing
    // document can conflict, so a fresh create needs no revision.
    if (
      existing &&
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null &&
      Number.isFinite(Number(input.expectedRevision)) &&
      Number(input.expectedRevision) !== existing.revision
    ) {
      throw storeError(
        'CONFLICT',
        'This document changed since it was loaded (revision ' + existing.revision + ', not ' + input.expectedRevision + ').',
      )
    }
    if (!existing && state.order.length >= MAX_DOCUMENTS) {
      throw storeError('LIMIT', 'This conversation already holds ' + MAX_DOCUMENTS + ' documents; delete one first.')
    }
    const kind = input.kind === 'sheet' || (existing && existing.kind === 'sheet') ? 'sheet' : 'page'
    const normalized =
      kind === 'sheet'
        ? normalizeSheetDocument(
            { title: input.title ?? (existing ? existing.title : 'Untitled'), sheets: input.sheets ?? (existing ? existing.sheets : null) },
            { existing, by: input.by },
          )
        : normalizeDocument(
            {
              title: input.title ?? (existing ? existing.title : 'Untitled'),
              page: input.page ?? (existing ? existing.page : null),
              font: input.font !== undefined ? input.font : existing ? existing.font : null,
              fontSize: input.fontSize !== undefined ? input.fontSize : existing ? existing.fontSize : null,
              blocks: input.blocks ?? (existing ? existing.blocks : null),
            },
            { existing, by: input.by },
          )
    const bytes = kind === 'sheet' ? sheetBytes(normalized) : documentBytes(normalized)
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw storeError('TOO_LARGE', 'The document is larger than the ' + Math.round(MAX_DOCUMENT_BYTES / 1024) + ' KiB per-document limit.')
    }
    assertConversationBudget(state, existing ? existing.id : null, bytes)
    const id = existing ? existing.id : this.claimId(scopeKey, requestedId, normalized.title)
    const now = new Date().toISOString()
    const entry = {
      id,
      ...normalized,
      updatedAt: now,
      origin: input.origin === undefined ? (existing ? existing.origin : null) : input.origin,
      history: (existing ? existing.history : [])
        .concat([{ at: now, by: normalized.by, note: String(input.note ?? (existing ? 'edited' : 'created')).slice(0, 200) }])
        .slice(-MAX_HISTORY),
    }
    state.documents[id] = entry
    if (!existing) state.order.push(id)
    this.save(scopeKey)
    return entry
  }

  /**
   * Record where a document was imported from, without touching its content -
   * so "reload from disk" knows the path and can check the stat first.
   * @param scopeKey - the conversation id, or `library`.
   * @param id - the document id.
   * @param origin - `{ path, mtimeMs, size, importedAt }` or null.
   */
  setOrigin(scopeKey, id, origin) {
    const entry = this.state(scopeKey).documents[id]
    if (!entry) return undefined
    entry.origin = origin
    this.save(scopeKey)
    return entry
  }

  /** Remove one document. */
  remove(scopeKey, id) {
    const state = this.state(scopeKey)
    if (!state.documents[id]) return false
    delete state.documents[id]
    state.order = state.order.filter((entry) => entry !== id)
    this.save(scopeKey)
    return true
  }

  /** Copy one document of one scope into another store under its own id. */
  copyInto(source, scopeKey, id, { by = 'user', note = 'published' } = {}) {
    const entry = source.get(scopeKey, id)
    if (!entry) throw storeError('NOT_FOUND', 'No document "' + id + '" in this conversation.')
    return this.write(this.fixedFile ? 'library' : scopeKey, {
      id: entry.id,
      kind: entry.kind === 'sheet' ? 'sheet' : 'page',
      title: entry.title,
      page: entry.page,
      font: entry.font,
      fontSize: entry.fontSize,
      sheets: entry.sheets,
      blocks: entry.blocks,
      by,
      note,
      origin: entry.origin,
    })
  }

  /** Drop one scope from memory (its file stays until the session is deleted). */
  forget(scopeKey) {
    this.loaded.delete(String(scopeKey))
  }
}

/** Every document's bytes in one scope. */
function totalBytes(state) {
  let total = 0
  for (const id of state.order) {
    const entry = state.documents[id]
    if (entry) total += documentBytes(entry)
  }
  return total
}

/**
 * Refuse a write that would push a conversation past its document budget.
 * @param state - the scope's live state.
 * @param id - the document being written (its current bytes are replaced).
 * @param bytes - the new document's size.
 */
function assertConversationBudget(state, id, bytes) {
  const existing = id ? state.documents[id] : undefined
  const previous = existing ? documentBytes(existing) : 0
  const next = totalBytes(state) - previous + bytes
  if (next > MAX_CONVERSATION_BYTES) {
    throw storeError(
      'BUDGET',
      'This conversation already holds ' +
        Math.round(totalBytes(state) / 1024) +
        ' KiB of documents and this one would bring it to ' +
        Math.round(next / 1024) +
        ' KiB, over the ' +
        Math.round(MAX_CONVERSATION_BYTES / 1024) +
        ' KiB limit. Delete a document first.',
    )
  }
}

/** Every session file the store owns, for diagnostics and pruning. */
export function listSessionFiles(root) {
  const dir = path.join(root, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
}
