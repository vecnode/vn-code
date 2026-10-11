/**
 * dsh-proto-lab — the lab itself: where it is, what a run is, and the one rule
 * that keeps every write inside it.
 *
 * The lab is the folder the agent prototypes into. It is NOT part of this
 * package and NOT part of this repository: it lives at `<workspace>/lab/`, one
 * real directory per run, and `.gitignore` keeps the whole tree out of every
 * commit. What ships is the generator, the example library and these
 * conventions - so the same bundle works in this repository, in a standalone
 * clone, and in whatever workspace the user opens next.
 *
 * Three decisions are load-bearing, and each of them is why a function below
 * exists rather than an inline `path.join`:
 *
 *   - A run is named `<runtime>/<slug>` and nothing else. Both segments are
 *     validated against the SLUG grammar BEFORE any filesystem call, so a run id
 *     is a name and never a path fragment.
 *   - Every path this module hands out is realpath-checked INSIDE the lab root,
 *     and a symlinked component is refused. A lab is written by a tool, read by
 *     a browser route and edited by a person; a link is the one thing that can
 *     make an edit land somewhere else.
 *   - The catalog is a convenience, never the truth. A run folder that exists on
 *     disk but is absent from `catalog.json` is still a run (it is listed, and
 *     `lab_lint` says the entry is missing); a catalog entry with no folder is
 *     not. Deleting a file by hand can therefore never make the lab lie about
 *     what is in it.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { digest, integerOf, isSlug, slugify } from './util.js'

/** The catalog's own format marker. A file with another one is not read. */
export const CATALOG_VERSION = 1
/** Where the lab lives, relative to a workspace root. */
export const LAB_DIRNAME = 'lab'
/** The folder this lab owns on a Desktop: runs, prints and compiled apps inside it. */
export const DESKTOP_DIRNAME = 'vncode-lab'
/** The environment override, for a lab that lives somewhere else entirely. */
export const ROOT_ENV = 'DSH_PROTO_LAB_ROOT'
/** How many runs the catalog remembers before the oldest are dropped. */
export const CATALOG_MAX_RUNS = 500
/**
 * The largest single file a run may carry.
 *
 * 2 MiB, and the number is not arbitrary: a p5.js run carries the vendored
 * library BESIDE its sketch (1.06 MiB of p5 1.11.13), because a run is a folder
 * that works on its own. A cap below that would make the runtime's own scaffold
 * refuse the runtime's own file. What this still catches is the real failure -
 * a sketch that inlines a base64 image, or a runtime that copies a binary into a
 * folder of source.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** The largest a whole run may be. */
export const MAX_RUN_BYTES = 8 * 1024 * 1024
/** The most parameter slots a run may declare. */
export const MAX_PARAMS = 24
/** The most characters a concept may carry (it is a line, not an essay). */
export const MAX_CONCEPT_CHARS = 240

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** A refusal the caller is meant to read. */
export class LabError extends Error {
  /**
   * @param message - what is wrong, in the caller's terms.
   * @param code - a stable code a check can assert on.
   */
  constructor(message, code = 'LAB_REFUSED') {
    super(message)
    this.name = 'LabError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Where the lab is
// ---------------------------------------------------------------------------
/**
 * Whether a directory is this repository.
 *
 * The marker is deliberately two files that only this pack has, not the presence
 * of a `lab/` folder (which would make the answer depend on the thing being
 * resolved) and not a git directory (which a worktree, an export or a
 * distribution does not carry in the same place).
 *
 * @param dir - the candidate root.
 * @returns true when it looks like the vncode tree.
 */
async function looksLikeThisRepo(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    if (manifest && manifest.name === 'vncode') return true
  } catch (err) {
    /* not this repo, or not readable */
  }
  try {
    const stat = await fsp.stat(path.join(dir, 'packages', 'dsh-vn-master'))
    return stat.isDirectory()
  } catch (err) {
    return false
  }
}

/**
 * The lab root, the PRINTS folder and the APPS folder.
 *
 * Resolution order, and the provenance is returned rather than implied because
 * `lab_open` prints it and a user pointing DSH_PROTO_LAB_ROOT at a folder needs to
 * see that the tool agreed with them:
 *
 *   1. `env[ROOT_ENV]` when it is a non-empty string (absolute, or relative to the
 *      workspace) - the lab is then exactly where that says, and prints and apps
 *      live inside it;
 *   2. the DESKTOP, which is where the things this lab makes are meant to arrive:
 *      a prototype is a thing you open, and a print is a thing you look at, so they
 *      belong where a person can see them rather than buried in the checkout. The
 *      folder is `~/Desktop/vncode-lab/` with `runs/` (the prototypes), `prints/`
 *      (saved PNGs) and `apps/` (compiled binaries) inside it;
 *   3. `<workspace>/lab` when there is no Desktop to write to - a container, a CI
 *      machine, a server. The lab still works; it is simply not on a desktop.
 *
 * `workspace` is the session's own `cwd` when the caller could supply it (the
 * harness validates and stores it), else the process working directory - which is
 * what the harness runs each conversation's tools with.
 *
 * @param options - `{ env, workspace, home }`.
 * @returns `{ root, prints, apps, workspace, source, repo }`.
 */
export async function resolveLabRoot(options = {}) {
  const env = options.env ?? process.env
  const workspace =
    typeof options.workspace === 'string' && options.workspace.trim() !== ''
      ? path.resolve(options.workspace)
      : process.cwd()
  const repo = await looksLikeThisRepo(workspace)
  const configured = typeof env[ROOT_ENV] === 'string' ? env[ROOT_ENV].trim() : ''
  if (configured !== '') {
    const root = path.resolve(workspace, configured)
    return { root, prints: path.join(root, 'prints'), apps: path.join(root, 'apps'), workspace, source: ROOT_ENV, repo }
  }
  const desktop = await desktopRoot({ env, home: options.home })
  if (desktop !== null) {
    const root = path.join(desktop, DESKTOP_DIRNAME, 'runs')
    return {
      root,
      prints: path.join(desktop, DESKTOP_DIRNAME, 'prints'),
      apps: path.join(desktop, DESKTOP_DIRNAME, 'apps'),
      workspace,
      source: 'desktop',
      repo,
    }
  }
  return {
    root: path.join(workspace, LAB_DIRNAME),
    prints: path.join(workspace, LAB_DIRNAME, 'prints'),
    apps: path.join(workspace, LAB_DIRNAME, 'apps'),
    workspace,
    source: 'workspace',
    repo,
  }
}

/**
 * The Desktop this machine actually has, or null.
 *
 * The variable is tried first because Linux distributions disagree about the
 * folder's name and a user who has said where it is should be believed; the
 * conventional locations come after it. Existence is what decides - a Desktop path
 * that is not there would silently become a new folder one level up, which is the
 * wrong answer to "where is the desktop".
 *
 * @param options - `{ env, home }`.
 * @returns the absolute path, or null.
 */
export async function desktopRoot(options = {}) {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : os.homedir()
  const candidates = []
  const configured = typeof env.XDG_DESKTOP_DIR === 'string' ? env.XDG_DESKTOP_DIR.trim() : ''
  if (configured !== '') candidates.push(path.resolve(home, configured))
  candidates.push(path.join(home, 'Desktop'))
  candidates.push(path.join(home, 'OneDrive', 'Desktop'))
  candidates.push(path.join(home, 'OneDrive - Personal', 'Desktop'))
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') {
    candidates.push(path.join(env.USERPROFILE, 'Desktop'))
    candidates.push(path.join(env.USERPROFILE, 'OneDrive', 'Desktop'))
  }
  for (const candidate of candidates) {
    const ok = await fsp
      .stat(candidate)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    if (ok) return candidate
  }
  return null
}

/**
 * The canonical, real path of something that may not exist yet.
 *
 * `realpath` is taken of the deepest ancestor that DOES exist and the missing
 * tail is appended. That is not a nicety on Windows: a temporary directory is
 * handed out as an 8.3 short path (`C:\Users\LUISAR~1\AppData\Local\Temp\...`)
 * while `realpath` answers with the long one, so comparing a hand-built path
 * against a realpath'ed root would report an escape that is not one - and the
 * same happens to any workspace that is itself reached through a symlink, a
 * junction or a mapped drive.
 *
 * @param target - the path.
 * @returns the canonical path.
 */
async function canonicalPath(target) {
  let current = path.resolve(target)
  const missing = []
  for (;;) {
    try {
      const real = await fsp.realpath(current)
      return path.join(real, ...missing.reverse())
    } catch (err) {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * The canonical, real root of a lab, whether or not it exists.
 *
 * @param root - the path from `resolveLabRoot`.
 * @returns the canonical root.
 */
export async function canonicalRoot(root) {
  return canonicalPath(root)
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
/**
 * A run id validated against the grammar, before any path is built from it.
 *
 * @param value - the caller's `run`.
 * @returns `{ runtime, slug, id }`.
 * @throws LabError when it is not `<runtime>/<slug>`.
 */
export function parseRunId(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : ''
  const parts = text.split('/').filter((part) => part !== '')
  if (parts.length !== 2) {
    throw new LabError('a run is named "<runtime>/<slug>" - got ' + JSON.stringify(value), 'RUN_ID_SHAPE')
  }
  const [runtime, slug] = parts
  if (!isSlug(runtime)) throw new LabError('not a runtime name: ' + JSON.stringify(runtime), 'RUN_ID_RUNTIME')
  if (!isSlug(slug)) {
    throw new LabError(
      'not a run slug: ' + JSON.stringify(slug) + ' (lower case letters, digits and single dashes)',
      'RUN_ID_SLUG',
    )
  }
  return { runtime, slug, id: runtime + '/' + slug }
}

/**
 * A file path inside a run, validated as one.
 *
 * @param value - the caller's `file`, relative to the run folder.
 * @returns the relative path with forward slashes.
 * @throws LabError when it is absolute, empty, or walks up.
 */
export function parseRunFile(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : ''
  if (text === '') throw new LabError('no file was named', 'FILE_EMPTY')
  if (text.includes('\0')) throw new LabError('a path may not contain a NUL byte', 'FILE_NUL')
  if (path.posix.isAbsolute(text) || /^[A-Za-z]:/.test(text)) {
    throw new LabError('a file inside a run is named relative to it - got ' + JSON.stringify(value), 'FILE_ABSOLUTE')
  }
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new LabError('no file was named', 'FILE_EMPTY')
  if (segments.some((segment) => segment === '..')) {
    throw new LabError('a file inside a run may not walk up: ' + JSON.stringify(value), 'FILE_ESCAPE')
  }
  return segments.join('/')
}

// ---------------------------------------------------------------------------
// The path policy
// ---------------------------------------------------------------------------
/**
 * A path inside the lab, refused unless it really is inside it.
 *
 * The rule, in order, and the reason for each step:
 *
 *   1. a `..` segment or an absolute path is refused on the STRING, before the
 *      filesystem is asked anything;
 *   2. the whole path is canonicalized (`realpath` of the deepest ancestor that
 *      exists, plus the missing tail) and must still begin with the canonical
 *      root - which is what catches an 8.3 short path, a junction and a symlink
 *      all at once, and is why the check is a prefix check on REAL paths rather
 *      than on the strings the caller handed in;
 *   3. every component that exists is `lstat`ed; a symlink is refused. The lab is
 *      written by a tool and read by a browser route, and a link is the one
 *      construct that lets a file inside the lab be a file outside it - so the
 *      lab supports no links at all, which is a policy a reader can hold in
 *      their head.
 *
 * `mode: 'write'` additionally refuses a component that exists and is not a
 * directory (the caller asked for a file inside it, which can never work).
 *
 * @param options - `{ root, relative, mode }`.
 * @returns the canonical absolute path.
 * @throws LabError when it is not inside the root.
 */
export async function ensureInside(options) {
  const mode = options.mode ?? 'read'
  const relative = String(options.relative ?? '').replace(/\\/g, '/')
  if (relative.includes('\0')) throw new LabError('a path may not contain a NUL byte', 'PATH_NUL')
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new LabError('an absolute path is not a path inside the lab: ' + relative, 'PATH_ABSOLUTE')
  }
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new LabError('a path inside the lab may not walk up: ' + relative, 'PATH_ESCAPE')
  }

  const real = await canonicalPath(options.root)
  const canonical = await canonicalPath(path.join(real, ...segments))
  const inside = canonical === real || canonical.startsWith(real + path.sep)
  if (!inside) {
    throw new LabError('that path is outside the lab: ' + relative + ' resolves to ' + canonical, 'PATH_ESCAPE')
  }

  let current = real
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let stat = null
    try {
      stat = await fsp.lstat(current)
    } catch (err) {
      // Not there yet. For a write that is the normal case - the run's folder,
      // and the runtime's above it, are created by the write itself - and
      // everything below a missing component is missing too.
      return canonical
    }
    if (stat.isSymbolicLink()) {
      throw new LabError('the lab carries no symbolic links (refused at ' + segments.slice(0, index + 1).join('/') + ')', 'PATH_SYMLINK')
    }
    // Only an intermediate component has to be a directory; the last one is the
    // file (or the folder) the caller is about to write.
    if (mode === 'write' && index < segments.length - 1 && !stat.isDirectory()) {
      throw new LabError('not a directory: ' + segments.slice(0, index + 1).join('/'), 'PATH_NOT_DIR')
    }
  }
  return canonical
}

/** The absolute folder of one run, refused unless the id is well formed. */
export async function runDir(root, runId) {
  const parsed = parseRunId(runId)
  const relative = parsed.runtime + '/' + parsed.slug
  return { parsed, dir: await ensureInside({ root, relative, mode: 'write' }) }
}

/**
 * One file inside one run.
 *
 * @param options - `{ root, run, file, mode }`.
 * @returns `{ parsed, dir, file, absolute }`.
 */
export async function runFile(options) {
  const { parsed, dir } = await runDir(options.root, options.run)
  const file = parseRunFile(options.file)
  const absolute = await ensureInside({ root: options.root, relative: parsed.runtime + '/' + parsed.slug + '/' + file, mode: options.mode ?? 'read' })
  return { parsed, dir, file, absolute }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
/**
 * A directory, created if it is missing.
 *
 * @param dir - the absolute path.
 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Write one file atomically, inside the lab, refusing anything oversize.
 *
 * The bytes go to a sibling temporary file and are renamed over the target, so a
 * reader (the preview tab, a browser, an editor with the file open) sees either
 * the old file or the new one and never half of either. Windows refuses a rename
 * onto a file that is open in another process, so one retry after removing the
 * target is attempted and its failure is reported with the path - a locked file
 * the user has open is a real answer, not a mystery.
 *
 * @param options - `{ root, relative, content, maxBytes }`.
 * @returns `{ absolute, bytes, sha256 }`.
 */
export async function writeInside(options) {
  const absolute = await ensureInside({ root: options.root, relative: options.relative, mode: 'write' })
  const buffer = Buffer.isBuffer(options.content) ? options.content : Buffer.from(String(options.content), 'utf8')
  const cap = options.maxBytes ?? MAX_FILE_BYTES
  if (buffer.byteLength > cap) {
    throw new LabError(
      'the file is ' + buffer.byteLength + ' bytes, over the ' + cap + '-byte cap for a run: ' + options.relative,
      'FILE_TOO_BIG',
    )
  }
  await ensureDir(path.dirname(absolute))
  const temporary = absolute + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  await fsp.writeFile(temporary, buffer)
  try {
    await fsp.rename(temporary, absolute)
  } catch (err) {
    try {
      await fsp.rm(absolute, { force: true })
      await fsp.rename(temporary, absolute)
    } catch (second) {
      await fsp.rm(temporary, { force: true })
      throw new LabError('could not replace ' + options.relative + ': ' + messageOf(second), 'FILE_LOCKED')
    }
  }
  const info = digest(buffer)
  return { absolute, bytes: info.bytes, sha256: info.sha256 }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------
/** An empty catalog. */
export function emptyCatalog() {
  return { version: CATALOG_VERSION, runs: {} }
}

/**
 * The lab's own record of what has been made in it.
 *
 * A missing file is an empty catalog; an unreadable or wrong-version one is an
 * empty catalog WITH a note, because a corrupt index must never stop the agent
 * from working - it only means the lab cannot list what it made, which the
 * caller is told.
 *
 * @param root - the lab root.
 * @returns `{ catalog, file, note }`.
 */
export async function readCatalog(root) {
  const file = path.join(await canonicalRoot(root), 'catalog.json')
  let text = null
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    return { catalog: emptyCatalog(), file, note: null }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { catalog: emptyCatalog(), file, note: 'catalog.json is not an object - reading the lab from disk instead' }
    }
    if (parsed.version !== CATALOG_VERSION) {
      return {
        catalog: emptyCatalog(),
        file,
        note: 'catalog.json is version ' + String(parsed.version) + ', this build writes version ' + CATALOG_VERSION + ' - reading the lab from disk instead',
      }
    }
    const runs = parsed.runs !== null && typeof parsed.runs === 'object' && !Array.isArray(parsed.runs) ? parsed.runs : {}
    return { catalog: { version: CATALOG_VERSION, runs }, file, note: null }
  } catch (err) {
    return { catalog: emptyCatalog(), file, note: 'catalog.json is not valid JSON (' + messageOf(err) + ') - reading the lab from disk instead' }
  }
}

/**
 * Record one run in the catalog, atomically.
 *
 * @param options - `{ root, entry }`.
 * @returns the catalog that was written.
 */
export async function writeCatalogEntry(options) {
  const { catalog, file } = await readCatalog(options.root)
  const entry = { ...options.entry }
  entry.updated = new Date().toISOString()
  if (typeof entry.created !== 'string') entry.created = entry.updated
  catalog.runs[entry.id] = entry

  const ids = Object.keys(catalog.runs)
  if (ids.length > CATALOG_MAX_RUNS) {
    const ordered = ids
      .map((id) => ({ id, updated: String(catalog.runs[id]?.updated ?? '') }))
      .sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0))
    for (const victim of ordered.slice(0, ids.length - CATALOG_MAX_RUNS)) delete catalog.runs[victim.id]
  }

  const body = JSON.stringify(catalog, null, 2) + '\n'
  await ensureDir(path.dirname(file))
  const temporary = file + '.tmp-' + process.pid
  await fsp.writeFile(temporary, body)
  try {
    await fsp.rename(temporary, file)
  } catch (err) {
    await fsp.rm(temporary, { force: true })
    throw new LabError('could not write catalog.json: ' + messageOf(err), 'CATALOG_LOCKED')
  }
  return catalog
}

// ---------------------------------------------------------------------------
// Runs on disk
// ---------------------------------------------------------------------------
/**
 * Every run folder the lab actually has, read from the disk.
 *
 * This is the truth the catalog is compared against. `<runtime>/<slug>` is two
 * levels by construction, so the walk is exactly two `readdir` levels and a
 * `stat` - never a recursive scan, whose cost would grow with the lab.
 *
 * @param root - the lab root.
 * @returns `{ runs, notes }`, newest first by mtime.
 */
export async function listRuns(root) {
  const real = await canonicalRoot(root)
  const notes = []
  let runtimeNames = []
  try {
    runtimeNames = (await fsp.readdir(real, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isSlug(entry.name))
      .map((entry) => entry.name)
  } catch (err) {
    return { runs: [], notes: [`the lab folder does not exist yet (${real})`] }
  }
  const runs = []
  for (const runtime of runtimeNames) {
    let slugNames = []
    try {
      slugNames = (await fsp.readdir(path.join(real, runtime), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && isSlug(entry.name))
        .map((entry) => entry.name)
    } catch (err) {
      notes.push('could not read ' + runtime + ': ' + messageOf(err))
      continue
    }
    for (const slug of slugNames) {
      const dir = path.join(real, runtime, slug)
      let files = []
      let bytes = 0
      let modified = null
      try {
        const walk = async (relative) => {
          const entries = await fsp.readdir(path.join(dir, relative), { withFileTypes: true })
          for (const entry of entries) {
            const child = relative === '' ? entry.name : relative + '/' + entry.name
            if (entry.isDirectory()) {
              await walk(child)
              continue
            }
            if (!entry.isFile()) continue
            files.push(child)
            try {
              const stat = await fsp.stat(path.join(dir, child))
              bytes += stat.size
              if (modified === null || stat.mtimeMs > modified) modified = stat.mtimeMs
            } catch (err) {
              /* a file that vanished mid-walk is not a run's problem */
            }
          }
        }
        await walk('')
      } catch (err) {
        notes.push('could not walk ' + runtime + '/' + slug + ': ' + messageOf(err))
      }
      runs.push({
        id: runtime + '/' + slug,
        runtime,
        slug,
        dir,
        files: files.sort(),
        bytes,
        modified: modified === null ? null : new Date(modified).toISOString(),
      })
    }
  }
  runs.sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')))
  return { runs, notes }
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------
/**
 * A parameter list reduced to the shape the catalog and the shells understand.
 *
 * A parameter is `{ name, min, max, value, step }` - numbers only, because that
 * is what both shells can turn into a control without a syntax to agree on, and
 * because a prototype's tunables are quantities (how many, how fast, how big)
 * far more often than they are choices. A caller's extra keys are dropped rather
 * than stored, so the catalog cannot fill with a runtime's private fields.
 *
 * @param value - the caller's `params`.
 * @returns `{ params, dropped }`.
 */
export function normalizeParams(value) {
  if (value === undefined || value === null) return { params: [], dropped: 0 }
  if (!Array.isArray(value)) {
    throw new LabError('`params` is an array of { name, min, max, value, step } - got ' + typeof value, 'PARAMS_SHAPE')
  }
  if (value.length > MAX_PARAMS) {
    throw new LabError('a run declares at most ' + MAX_PARAMS + ' parameters - got ' + value.length, 'PARAMS_TOO_MANY')
  }
  const seen = new Set()
  const params = []
  let dropped = 0
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped += 1
      continue
    }
    const name = slugify(raw.name ?? '', 32)
    if (name === '' || seen.has(name)) {
      dropped += 1
      continue
    }
    const min = Number.isFinite(Number(raw.min)) ? Number(raw.min) : 0
    const max = Number.isFinite(Number(raw.max)) ? Number(raw.max) : 1
    const low = Math.min(min, max)
    const high = Math.max(min, max)
    const value_ = Number.isFinite(Number(raw.value)) ? Number(raw.value) : low
    const step = Number.isFinite(Number(raw.step)) && Number(raw.step) > 0 ? Number(raw.step) : (high - low) / 100 || 0.01
    seen.add(name)
    params.push({
      name,
      min: low,
      max: high,
      value: Math.min(high, Math.max(low, value_)),
      step,
    })
  }
  return { params, dropped }
}

/**
 * Materialize one run from a runtime's own templates.
 *
 * The files come from the runtime module (`scaffold`), the paths are validated
 * one by one, and nothing is written until every file has been built - so a
 * runtime that throws half way through leaves no half-run on disk.
 *
 * @param options - `{ root, runtime, slug, concept, seed, params, overwrite, env }`.
 * @returns `{ run, files, warnings }`.
 */
export async function scaffoldRun(options) {
  const entry = options.runtime
  const slug = options.slug
  if (!isSlug(slug)) throw new LabError('not a run slug: ' + JSON.stringify(slug), 'RUN_ID_SLUG')
  const id = entry.id + '/' + slug
  const root = options.root
  const target = await ensureInside({ root, relative: entry.id + '/' + slug, mode: 'write' })

  const built = await entry.scaffold({
    slug,
    id,
    concept: options.concept,
    seed: options.seed,
    params: options.params,
    env: options.env,
  })
  if (!Array.isArray(built) || built.length === 0) {
    throw new LabError('the ' + entry.id + ' runtime produced no files', 'RUNTIME_EMPTY')
  }

  const files = []
  for (const file of built) {
    const relative = parseRunFile(file.path)
    files.push({ path: relative, content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8') })
  }

  const exists = await fsp
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  if (exists && options.overwrite !== true) {
    throw new LabError('that run already exists: ' + id + ' (pass overwrite, or choose another slug)', 'RUN_EXISTS')
  }

  const warnings = []
  let total = 0
  const written = []
  for (const file of files) {
    if (file.content.byteLength > MAX_FILE_BYTES) {
      throw new LabError('the ' + entry.id + ' runtime produced a ' + file.content.byteLength + '-byte file (' + file.path + '), over the cap', 'FILE_TOO_BIG')
    }
    total += file.content.byteLength
    if (total > MAX_RUN_BYTES) throw new LabError('the run would exceed ' + MAX_RUN_BYTES + ' bytes', 'RUN_TOO_BIG')
    const result = await writeInside({ root, relative: entry.id + '/' + slug + '/' + file.path, content: file.content })
    written.push({ path: file.path, bytes: result.bytes, sha256: result.sha256 })
  }

  const entryRecord = {
    id,
    runtime: entry.id,
    slug,
    label: options.label,
    concept: options.concept,
    seed: options.seed,
    params: options.params,
    files: written.map((file) => file.path).sort(),
    bytes: total,
    example: options.example ?? null,
  }
  await writeCatalogEntry({ root, entry: entryRecord })
  return { run: { ...entryRecord, dir: target }, files: written, warnings }
}

/**
 * Copy one of a runtime's committed examples into the lab.
 *
 * The example library is the part of this package that is meant to grow: every
 * example is a real, checked run - the same files a scaffold would write, already
 * written by hand, kept beside the skill that explains it in
 * `skills/<skill>/examples/<slug>/`. The runtime's `materialize` turns one into
 * the file set, and everything after that is the same write path a scaffold uses,
 * so an instantiated example is a run in every respect, including its catalog
 * entry.
 *
 * @param options - `{ root, runtime, example, slug, overwrite }`.
 * @returns `{ run, files }`.
 */
export async function instantiateExample(options) {
  const entry = options.runtime
  const example = options.example
  const slug = options.slug ?? example.slug
  if (!isSlug(slug)) throw new LabError('not a run slug: ' + JSON.stringify(slug), 'RUN_ID_SLUG')
  const id = entry.id + '/' + slug
  const root = options.root
  const target = await ensureInside({ root, relative: entry.id + '/' + slug, mode: 'write' })
  const exists = await fsp
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  if (exists && options.overwrite !== true) {
    throw new LabError('that run already exists: ' + id + ' (pass overwrite, or choose another slug)', 'RUN_EXISTS')
  }

  const built = await entry.materialize({ ...example, slug })
  const files = built.map((file) => ({
    path: parseRunFile(file.path),
    content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8'),
  }))

  const written = []
  let total = 0
  for (const file of files) {
    total += file.content.byteLength
    if (file.content.byteLength > MAX_FILE_BYTES) {
      throw new LabError('the example file ' + file.path + ' is over the per-file cap', 'FILE_TOO_BIG')
    }
    const result = await writeInside({ root, relative: entry.id + '/' + slug + '/' + file.path, content: file.content })
    written.push({ path: file.path, bytes: result.bytes, sha256: result.sha256 })
  }

  const record = {
    id,
    runtime: entry.id,
    slug,
    label: example.label,
    concept: example.concept,
    seed: example.seed,
    params: [],
    files: written.map((file) => file.path).sort(),
    bytes: total,
    example: example.slug,
  }
  await writeCatalogEntry({ root, entry: record })
  return { run: { ...record, dir: target }, files: written }
}

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------
/**
 * An issue, sorted so the loudest comes first.
 *
 * @param severity - 'error' or 'warn'.
 * @param code - a stable code (`no-sketch`, `stray-extension`).
 * @param message - one sentence a person can act on.
 * @param file - the file it is about, when it is about one.
 */
function issue(severity, code, message, file) {
  return { severity, code, message, file: file ?? null }
}

/**
 * Judge one settled run: what the runtime requires, plus the lab's own rules.
 *
 * The two halves are deliberately separate. The runtime owns "is this a
 * prototype in MY language" (a p5 run has a `sketch.js` calling `setup()`; an
 * openFrameworks run has a `src/ofApp.cpp` defining `setup()`), and the lab owns
 * "is this a run" (a README, a NOTES, a catalog entry, no stray binary, inside
 * the size caps). A new runtime therefore cannot weaken the lab's rules by
 * forgetting them.
 *
 * @param options - `{ root, runtime, run, catalog }`.
 * @returns `{ id, ok, issues, files, bytes }`.
 */
export async function lintRun(options) {
  const entry = options.runtime
  const parsed = parseRunId(options.run)
  if (parsed.runtime !== entry.id) {
    throw new LabError('run ' + parsed.id + ' is a ' + parsed.runtime + ' run, not ' + entry.id, 'RUN_RUNTIME_MISMATCH')
  }
  const target = await runDir(options.root, parsed.id)
  const files = []
  /** Everything found, from the lab's rules and from the runtime's. */
  const issues = []
  let bytes = 0
  try {
    const walk = async (relative) => {
      const entries = await fsp.readdir(path.join(target.dir, relative), { withFileTypes: true })
      for (const file of entries) {
        const child = relative === '' ? file.name : relative + '/' + file.name
        if (file.isDirectory()) {
          await walk(child)
          continue
        }
        if (file.isSymbolicLink()) {
          issues.push(issue('error', 'symlink', 'the lab carries no symbolic links', child))
          continue
        }
        if (!file.isFile()) continue
        files.push(child)
        const stat = await fsp.stat(path.join(target.dir, child))
        bytes += stat.size
        if (stat.size > MAX_FILE_BYTES) {
          issues.push(issue('error', 'file-too-big', 'is ' + stat.size + ' bytes, over the ' + MAX_FILE_BYTES + '-byte cap', child))
        }
      }
    }
    await walk('')
  } catch (err) {
    return { id: parsed.id, ok: false, issues: [issue('error', 'missing-run', 'there is no run folder at ' + parsed.id)], files: [], bytes: 0 }
  }
  files.sort()

  if (!files.includes('README.md')) {
    issues.push(issue('error', 'no-readme', 'a run has a README.md saying what it is and how to run it', null))
  }
  if (!files.includes('NOTES.md')) {
    issues.push(issue('error', 'no-notes', 'a run has a NOTES.md: the seed, what to look at, what to try', null))
  }
  const stray = files.filter((file) => !entry.extensions.includes(path.extname(file).toLowerCase()) && !['README.md', 'NOTES.md', 'example.json', '.gitignore', '.gitkeep'].includes(path.basename(file)) && !file.endsWith('/.gitkeep'))
  for (const file of stray) {
    issues.push(issue('warn', 'stray-file', 'not a file this runtime knows how to regenerate (' + entry.extensions.join(' ') + ')', file))
  }
  if (bytes > MAX_RUN_BYTES) {
    issues.push(issue('error', 'run-too-big', 'the run is ' + bytes + ' bytes, over the ' + MAX_RUN_BYTES + '-byte cap', null))
  }
  const recorded = options.catalog?.runs?.[parsed.id]
  if (recorded === undefined) {
    issues.push(issue('warn', 'no-catalog-entry', 'the run is on disk but not in catalog.json - `lab_new` adds one', null))
  } else {
    const onDisk = files.join(',')
    const inCatalog = Array.isArray(recorded.files) ? [...recorded.files].sort().join(',') : ''
    if (inCatalog !== onDisk) {
      issues.push(
        issue('warn', 'catalog-drift', 'the catalog lists different files than the folder holds' + (inCatalog === '' ? '' : ' (' + inCatalog + ' vs ' + onDisk + ')'), null),
      )
    }
  }

  let fromRuntime = []
  try {
    // `machine` is the host's own capability report, passed straight through: a
    // runtime that can compile needs to know WHICH compiler and whether this
    // process is allowed to run it, and a runtime that cannot must not guess.
    fromRuntime = (await entry.lint({ dir: target.dir, files, bytes, env: options.env, machine: options.machine ?? null })) ?? []
  } catch (err) {
    issues.push(issue('error', 'lint-failed', 'the ' + entry.id + ' runtime could not read the run: ' + messageOf(err), null))
  }
  for (const found of fromRuntime) {
    issues.push(issue(found.severity === 'warn' ? 'warn' : 'error', String(found.code ?? 'runtime'), String(found.message ?? ''), found.file ?? null))
  }

  const ordered = issues.sort((a, b) => (a.severity === b.severity ? String(a.file ?? '').localeCompare(String(b.file ?? '')) : a.severity === 'error' ? -1 : 1))
  return { id: parsed.id, ok: ordered.every((item) => item.severity !== 'error'), issues: ordered, files, bytes }
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------
/**
 * One file of one run, capped, with its digest.
 *
 * @param options - `{ root, run, file, maxBytes }`.
 * @returns `{ path, text, bytes, sha256, truncated }`.
 */
export async function readRunFile(options) {
  const { file, absolute } = await runFile({ root: options.root, run: options.run, file: options.file, mode: 'read' })
  const buffer = await fsp.readFile(absolute)
  const cap = options.maxBytes ?? MAX_FILE_BYTES
  const truncated = buffer.byteLength > cap
  const slice = truncated ? buffer.subarray(0, cap) : buffer
  const info = digest(buffer)
  return {
    run: parseRunId(options.run).id,
    path: file,
    absolute,
    text: slice.toString('utf8'),
    bytes: info.bytes,
    sha256: info.sha256,
    truncated,
  }
}

/** One run's folder listing, without reading the file bodies. */
export async function readRun(root, runId, catalog) {
  const { parsed, dir } = await runDir(root, runId)
  const listing = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (listing === null) {
    return { id: parsed.id, dir, exists: false, files: [], bytes: 0, entry: catalog?.runs?.[parsed.id] ?? null }
  }
  const files = []
  let bytes = 0
  const walk = async (relative) => {
    for (const item of await fsp.readdir(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative === '' ? item.name : relative + '/' + item.name
      if (item.isDirectory()) {
        await walk(child)
        continue
      }
      files.push(child)
      const stat = await fsp.stat(path.join(dir, child)).catch(() => null)
      if (stat !== null) bytes += stat.size
    }
  }
  await walk('')
  files.sort()
  return { id: parsed.id, dir, exists: true, files, bytes, entry: catalog?.runs?.[parsed.id] ?? null }
}

/** Re-exported so a caller does not have to import two modules for one idea. */
export { integerOf, isSlug, slugify }
