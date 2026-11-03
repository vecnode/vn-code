/**
 * dsh-image-upscale — which file a call may read, and which file it may create.
 *
 * The same stated policy dsh-media, dsh-pdf and dsh-ocr apply, duplicated here
 * because a bundle may not reach into another bundle's files:
 *
 *   - a SESSION-RELATIVE path is resolved inside that conversation's workspace,
 *     and both the workspace and the target go through `realpath`, so a symlink
 *     pointing out of the workspace is refused rather than followed;
 *   - an ABSOLUTE path is taken as given - that is the door a screenshot in
 *     Downloads or a chat attachment under `$DSH_HOME/attachments/...` comes
 *     through;
 *   - the INPUT must already be a regular file.
 *
 * The OUTPUT is the one thing this plugin does that the readers do not: it
 * creates a file, so the policy has an extra clause. A relative output is
 * resolved inside the workspace, its PARENT must already exist and resolve
 * inside the workspace too (a `..` cannot climb out through a folder that
 * happens to be a symlink), and an existing file is refused unless the caller
 * said `overwrite`. Overwriting is the one thing a person must ask for by name:
 * the whole point of this row is producing a SECOND copy of an image and never
 * touching the one that exists.
 */
import { existsSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export class UpscaleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UpscaleError'
    this.code = code
  }
}

/** The workspace root of one session. */
export async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new UpscaleError('BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
  try {
    const sessions = get('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = live && live.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch (error) {
    /* fall through to persistence */
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (error) {
    /* fall through to the typed failure below */
  }
  throw new UpscaleError('NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Whether a path is absolute in either spelling Windows and POSIX accept. */
export function isAbsolutePath(value) {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value)
}

/** A path as the caller wrote it, split into segments ('' and '.' dropped). */
function segmentsOf(value) {
  return value.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.')
}

async function workspaceRoot(ctx, sessionId) {
  const root = await sessionRoot(ctx, sessionId)
  try {
    return await fsp.realpath(path.resolve(root))
  } catch (error) {
    throw new UpscaleError('NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
  }
}

/** Resolve an EXISTING regular file. */
export async function resolveInput(ctx, request) {
  const value = typeof request.path === 'string' ? request.path.trim() : ''
  if (value === '') throw new UpscaleError('BAD_REQUEST', 'A file path is required.')
  if (value.includes('\u0000')) throw new UpscaleError('BAD_REQUEST', 'That path is not a path.')
  let target
  let scope
  let rootReal = null
  if (isAbsolutePath(value)) {
    try {
      target = await fsp.realpath(path.resolve(value))
    } catch (error) {
      throw new UpscaleError('NOT_FOUND', 'No such file: ' + value)
    }
    scope = 'absolute'
  } else {
    rootReal = await workspaceRoot(ctx, request.session)
    const candidate = path.resolve(rootReal, ...segmentsOf(value))
    try {
      target = await fsp.realpath(candidate)
    } catch (error) {
      throw new UpscaleError('NOT_FOUND', 'No such file in this workspace: ' + value)
    }
    const inside = target === rootReal || target.startsWith(rootReal + path.sep)
    if (!inside) throw new UpscaleError('OUTSIDE_WORKSPACE', 'That path points outside the conversation workspace: ' + value)
    scope = 'workspace'
  }
  let stats
  try {
    stats = await fsp.stat(target)
  } catch (error) {
    throw new UpscaleError('NOT_FOUND', 'No such file: ' + target)
  }
  if (!stats.isFile()) throw new UpscaleError('NOT_A_FILE', 'That is not a regular file: ' + target)
  const relative = scope === 'workspace' && rootReal !== null ? target.slice(rootReal.length + 1).replace(/\\/g, '/') : null
  return { file: target, scope, relative, size: stats.size }
}

/**
 * Resolve a path this call will WRITE to.
 *
 * The parent must exist: creating it would mean guessing a tree the caller never
 * named, and a typo would leave an empty folder behind instead of an error.
 *
 * @returns `{ file, scope, relative, exists }`.
 */
export async function resolveOutput(ctx, request) {
  const value = typeof request.path === 'string' ? request.path.trim() : ''
  if (value === '') throw new UpscaleError('BAD_REQUEST', 'An output path is required.')
  if (value.includes('\u0000')) throw new UpscaleError('BAD_REQUEST', 'That path is not a path.')
  const overwrite = request.overwrite === true
  let target
  let scope
  let rootReal = null
  if (isAbsolutePath(value)) {
    target = path.resolve(value)
    scope = 'absolute'
  } else {
    rootReal = await workspaceRoot(ctx, request.session)
    target = path.resolve(rootReal, ...segmentsOf(value))
    const parent = await fsp.realpath(path.dirname(target)).catch(() => null)
    if (parent === null) {
      throw new UpscaleError('NO_PARENT', 'The folder for this output does not exist: ' + path.dirname(target))
    }
    const inside = parent === rootReal || parent.startsWith(rootReal + path.sep)
    if (!inside) throw new UpscaleError('OUTSIDE_WORKSPACE', 'That output points outside the conversation workspace: ' + value)
    target = path.join(parent, path.basename(target))
    scope = 'workspace'
  }
  const exists = existsSync(target)
  if (exists && !overwrite) {
    throw new UpscaleError(
      'EXISTS',
      'That output already exists: ' + target + '. This row writes a NEW file and never replaces one on its own - pass `overwrite: true` if replacing it is what you mean.',
    )
  }
  if (exists) {
    const stats = await fsp.stat(target).catch(() => null)
    if (stats !== null && !stats.isFile()) throw new UpscaleError('NOT_A_FILE', 'That output is not a regular file: ' + target)
  }
  const relative = scope === 'workspace' && rootReal !== null ? target.slice(rootReal.length + 1).replace(/\\/g, '/') : null
  return { file: target, scope, relative, exists }
}

/** Whether a file exists and is a regular file (no throw, for the tools). */
export function isFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch (error) {
    return false
  }
}
