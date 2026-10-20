/**
 * dsh-shaders — this conversation's shaders on disk.
 *
 * One JSON file per conversation under `$DSH_HOME/dsh-shaders/state/`, plus one
 * shared `library.json` for a published shader, the same shape and the same two
 * rules the pack's diagram store follows:
 *
 *   - **written atomically.** A half-written state file loses every shader in the
 *     conversation at once, so a write goes to a temp file beside the target and
 *     is renamed over it.
 *   - **bounded.** A conversation has a byte budget that binds BEFORE the file
 *     cap, so an agent cannot fill the store until it reads back as empty. One
 *     shader is capped on its own, because a pasted 2 MB fragment is a mistake
 *     and not a shader.
 *
 * A stored shader carries a `revision` that only ever increases. That is what
 * makes a verification honest: a report about revision 3 is not a report about
 * revision 4, and `verificationOf` says `stale` rather than pretending.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** One shader's ceiling. A 34 KB gallery piece is the largest real one measured. */
export const MAX_SOURCE_BYTES = 256 * 1024
/** One conversation's ceiling across every shader in it. */
export const MAX_STATE_BYTES = 8 * 1024 * 1024
/** How many shaders one conversation may hold. */
export const MAX_ENTRIES = 200

const SCHEMA = 1

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** The directory a session's state lives in, created on demand. */
function stateRoot(root) {
  return path.join(root, 'state')
}

export class ShaderStore {
  /**
   * @param options - `{ root, fixedFile }`. `fixedFile` names one shared file
   *   instead of one per key (the library).
   */
  constructor(options) {
    this.root = options.root
    this.fixedFile = options.fixedFile ?? null
  }

  fileFor(key) {
    if (this.fixedFile !== null) return path.join(this.root, this.fixedFile)
    const safe = String(key ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    if (safe === '') throw fail('BAD_KEY', 'a store key is required')
    return path.join(stateRoot(this.root), safe + '.json')
  }

  /** The whole file, or an empty state. A corrupt file is reported, never silently empty. */
  readState(key) {
    const file = this.fileFor(key)
    if (!existsSync(file)) return { schema: SCHEMA, shaders: [], corrupt: false }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.shaders)) {
        return { schema: SCHEMA, shaders: [], corrupt: true }
      }
      return { schema: SCHEMA, shaders: parsed.shaders, corrupt: false }
    } catch (err) {
      return { schema: SCHEMA, shaders: [], corrupt: true }
    }
  }

  list(key) {
    const state = this.readState(key)
    // The source is dropped rather than set to `undefined`: a key that survives as
    // undefined is still a key, and it makes a JSON answer lie about its shape.
    return state.shaders.map((entry) => {
      const listed = { ...entry, includeCount: (entry.includes ?? []).length }
      delete listed.source
      delete listed.includes
      return listed
    })
  }

  get(key, id) {
    const state = this.readState(key)
    return state.shaders.find((entry) => entry.id === id) ?? null
  }

  /**
   * Write (or replace) one shader.
   *
   * @throws `NO_ID` / `TOO_LARGE` / `BUDGET` / `BAD_INPUT`
   */
  write(key, value) {
    const id = String(value.id ?? '').trim()
    if (id === '' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw fail('BAD_INPUT', 'a shader id must be lower-case letters, digits and dashes: ' + JSON.stringify(value.id))
    const source = String(value.source ?? '')
    if (source.trim() === '') throw fail('BAD_INPUT', 'a shader needs a source')
    const bytes = Buffer.byteLength(source)
    if (bytes > MAX_SOURCE_BYTES) {
      throw fail('TOO_LARGE', 'this shader is ' + String(bytes) + ' bytes; one shader may be at most ' + String(MAX_SOURCE_BYTES) + '. Split it or trim it.')
    }
    const includes = Array.isArray(value.includes)
      ? value.includes
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && typeof entry.source === 'string')
          .map((entry) => ({ name: entry.name, source: entry.source }))
      : []
    const includeBytes = includes.reduce((sum, entry) => sum + Buffer.byteLength(entry.source), 0)
    if (bytes + includeBytes > MAX_SOURCE_BYTES) {
      throw fail('TOO_LARGE', 'the source plus its ' + String(includes.length) + ' included module(s) is ' + String(bytes + includeBytes) + ' bytes; the ceiling is ' + String(MAX_SOURCE_BYTES) + '.')
    }

    const state = this.readState(key)
    const existing = state.shaders.find((entry) => entry.id === id)
    const revision = existing === undefined ? 1 : existing.revision + 1
    const entry = {
      id,
      title: String(value.title ?? existing?.title ?? id),
      kind: value.kind === 'vertex' ? 'vertex' : 'fragment',
      dialect: String(value.dialect ?? existing?.dialect ?? 'es100'),
      source,
      includes,
      params: Array.isArray(value.params) ? value.params : [],
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      bytes,
      revision,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      by: value.by === 'human' ? 'human' : 'model',
      // A rewrite invalidates the browser's verdict: the picture was of the
      // PREVIOUS source, so the report is cleared rather than kept beside it.
      render: null,
    }

    const others = state.shaders.filter((entry_) => entry_.id !== id)
    const total = others.reduce((sum, entry_) => sum + (entry_.bytes ?? 0) + (entry_.includes ?? []).reduce((inner, include) => inner + Buffer.byteLength(include.source ?? ''), 0), 0)
    if (total + bytes + includeBytes > MAX_STATE_BYTES) {
      throw fail('BUDGET', 'this conversation already holds ' + String(others.length) + ' shader(s) using its ' + String(Math.round(MAX_STATE_BYTES / 1024)) + ' KiB budget. Delete one with shader_write { remove: true } first.')
    }
    if (others.length + 1 > MAX_ENTRIES) {
      throw fail('BUDGET', 'this conversation already holds ' + String(others.length) + ' shaders; the limit is ' + String(MAX_ENTRIES) + '.')
    }

    state.shaders = [...others, entry].sort((a, b) => (a.id < b.id ? -1 : 1))
    this.#persist(key, state)
    return entry
  }

  /** Store a browser's render report against the revision it is about. */
  report(key, id, report) {
    const state = this.readState(key)
    const entry = state.shaders.find((candidate) => candidate.id === id)
    if (entry === undefined) return { stored: false, reason: 'NO_SUCH_SHADER' }
    entry.render = {
      revision: Number(report.revision ?? entry.revision),
      ok: report.ok === true,
      dialect: String(report.dialect ?? entry.dialect),
      at: new Date().toISOString(),
      phase: report.phase === undefined ? null : String(report.phase),
      error: report.error === undefined || report.error === null ? null : String(report.error).slice(0, 600),
      ms: Number.isFinite(Number(report.ms)) ? Math.round(Number(report.ms)) : null,
    }
    this.#persist(key, state)
    return { stored: true, revision: entry.render.revision }
  }

  remove(key, id) {
    const state = this.readState(key)
    const before = state.shaders.length
    state.shaders = state.shaders.filter((entry) => entry.id !== id)
    if (state.shaders.length === before) return { removed: false, reason: 'NO_SUCH_SHADER' }
    this.#persist(key, state)
    return { removed: true }
  }

  /** Write the state atomically: temp file beside the target, then rename. */
  #persist(key, state) {
    const file = this.fileFor(key)
    const bytes = Buffer.byteLength(JSON.stringify(state))
    if (bytes > MAX_STATE_BYTES * 1.5) {
      throw fail('BUDGET', 'the state file would be ' + String(bytes) + ' bytes, past the ceiling.')
    }
    // Synchronous on purpose: the registry calls a tool's execute() once and
    // expects the write to have happened when it returns.
    const dir = path.dirname(file)
    mkdirSync(dir, { recursive: true })
    const temp = path.join(dir, '.' + path.basename(file) + '.' + randomUUID() + '.tmp')
    writeFileSync(temp, JSON.stringify(state, null, 1), 'utf8')
    renameSync(temp, file)
  }
}

/**
 * What is known about a stored shader's verification, as four honest states.
 *
 * `pending` - nothing has reported on this revision.
 * `drawn`   - a browser drew THIS revision.
 * `failed`  - a browser reported a failure for THIS revision.
 * `stale`   - the only report is about an older revision.
 */
export function verificationOf(entry) {
  const revision = Number(entry.revision ?? 0)
  const render = entry.render ?? null
  if (render === null || render === undefined) return { state: 'pending', revision, reported: null }
  if (Number(render.revision) !== revision) return { state: 'stale', revision, reported: Number(render.revision) }
  return { state: render.ok === true ? 'drawn' : 'failed', revision, reported: Number(render.revision) }
}

/** The directory this row owns inside the harness home. */
export function storeRoot(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-shaders')
}

/**
 * Where rendered frames are cached, content addressed by the bytes of the frame.
 *
 * A PNG is named by its own sha256, so two shaders that draw the same frame share
 * one file and a frame is never overwritten by a different one.
 */
export function artifactDir(env = process.env) {
  return path.join(storeRoot(env), 'artifacts')
}

/** Keep the artifact cache from growing without bound. */
export const MAX_ARTIFACT_FILES = 400

/** Delete the oldest artifacts past the cap. Never throws. */
export function pruneArtifacts(directory, keep = MAX_ARTIFACT_FILES) {
  try {
    if (!existsSync(directory)) return 0
    const entries = readdirSync(directory).filter((name) => name.endsWith('.png'))
    if (entries.length <= keep) return 0
    const stats = entries
      .map((name) => {
        try {
          return { name, at: statSync(path.join(directory, name)).mtimeMs }
        } catch (err) {
          return { name, at: null }
        }
      })
      .filter((entry) => entry.at !== null)
      .sort((a, b) => a.at - b.at)
    let removed = 0
    for (const entry of stats.slice(0, Math.max(0, stats.length - keep))) {
      try {
        unlinkSync(path.join(directory, entry.name))
        removed += 1
      } catch (err) {
        /* a file another request is reading */
      }
    }
    return removed
  } catch (err) {
    return 0
  }
}

/** Write one PNG into the artifact cache; returns its name and byte count. */
export async function writeArtifact(directory, bytes) {
  await fsp.mkdir(directory, { recursive: true })
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.png'
  const file = path.join(directory, name)
  const relative = path.relative(directory, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('refusing to write outside the artifact directory')
  if (!existsSync(file)) await fsp.writeFile(file, bytes)
  return { name, bytes: bytes.length, file }
}
