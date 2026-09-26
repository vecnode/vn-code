/**
 * dsh-media — which file a call is allowed to touch, and why.
 *
 * The policy is stated, not implied, and it is the same for the tools and for
 * the routes the video tab reads:
 *
 *   - a SESSION-RELATIVE path is resolved inside that conversation's workspace,
 *     and both the workspace and the target go through `realpath`, so a symlink
 *     that points out of the workspace is refused rather than followed;
 *   - an ABSOLUTE path is read as given (through `realpath`, so the reported
 *     path is the real one) - that is the door a chat attachment under
 *     `$DSH_HOME/attachments/v1/files/...` and a file in Downloads come
 *     through, and it is a deliberate one, because "analyse this video" is a
 *     question about a file wherever it happens to live;
 *   - either way the target must be a REGULAR file, and a caller may name the
 *     extensions it accepts (the video tab does; the agent's tools do not,
 *     because ffprobe identifies a file by its content and a `.bin` can be a
 *     perfectly good MPEG-TS).
 *
 * The workspace lookup is the same two-step one dsh-editor, dsh-gittree and
 * dsh-pdf perform - the live session header first, then session persistence -
 * duplicated here because a bundle may not reach into another bundle's files.
 */
import { existsSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { httpError } from './http.js'

/**
 * The workspace root of one session.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the session the request belongs to.
 * @returns {Promise<string>} the session's cwd.
 */
export async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
  try {
    const sessions = get('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = live && live.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch (err) {
    /* fall through to persistence */
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (err) {
    /* fall through to the typed failure below */
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Whether a path is absolute in either spelling Windows and POSIX accept. */
export function isAbsolutePath(value) {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value)
}

/** The lower-cased extension of a path ('' for none and for dotfiles). */
export function extensionOf(file) {
  const name = String(file ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Resolve one requested path to a readable file under the policy above.
 *
 * @param ctx - the plugin context, for the workspace lookup.
 * @param request - `{ session, path, extensions, label, maxBytes }`.
 * @returns `{ file, scope, relative, size }`.
 */
export async function resolveTarget(ctx, request) {
  const label = request.label ?? 'media file'
  const value = typeof request.path === 'string' ? request.path.trim() : ''
  if (value === '') throw httpError(400, 'BAD_REQUEST', 'A file path is required.')
  if (value.includes('\u0000')) throw httpError(400, 'BAD_REQUEST', 'That path is not a path.')
  const normalized = value.replace(/\\/g, '/')
  let target
  let scope
  let rootReal = null
  if (isAbsolutePath(value)) {
    try {
      target = await fsp.realpath(path.resolve(value))
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'No such file: ' + value)
    }
    scope = 'absolute'
  } else {
    const root = await sessionRoot(ctx, request.session)
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
    const candidate = path.resolve(rootReal, ...normalized.split('/').filter((segment) => segment !== '' && segment !== '.'))
    try {
      target = await fsp.realpath(candidate)
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'No such file in this workspace: ' + value)
    }
    const inside = target === rootReal || target.startsWith(rootReal + path.sep)
    if (!inside) throw httpError(403, 'OUTSIDE_WORKSPACE', 'That path points outside the conversation workspace: ' + value)
    scope = 'workspace'
  }
  if (Array.isArray(request.extensions) && request.extensions.length > 0) {
    const extension = extensionOf(target)
    if (!request.extensions.includes(extension)) {
      throw httpError(415, 'NOT_MEDIA', 'This only reads ' + request.extensions.map((entry) => '*.' + entry).join(', ') + ', and that is a *.' + (extension || '(none)') + ' file: ' + path.basename(target))
    }
  }
  let stats
  try {
    stats = await fsp.stat(target)
  } catch (err) {
    throw httpError(404, 'NOT_FOUND', 'No such file: ' + target)
  }
  if (!stats.isFile()) throw httpError(400, 'NOT_A_FILE', 'That is not a regular file: ' + target)
  if (Number.isFinite(request.maxBytes) && request.maxBytes > 0 && stats.size > request.maxBytes) {
    throw httpError(413, 'TOO_LARGE', 'That file is ' + Math.round(stats.size / (1024 * 1024)) + ' MB; this call reads up to ' + Math.round(request.maxBytes / (1024 * 1024)) + ' MB.')
  }
  const relative = scope === 'workspace' && rootReal !== null ? target.slice(rootReal.length + 1).replace(/\\/g, '/') : null
  return { file: target, scope, relative, size: stats.size, label }
}

/** Whether a file exists and is a regular file (no throw, for the tools). */
export function isFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch (err) {
    return false
  }
}

/**
 * Resolve one requested DIRECTORY under the same policy as a file: `''` or `.`
 * is the conversation workspace itself, a relative path stays inside it, an
 * absolute one is used as given. With `create`, the directory is made (and its
 * parents) - which is what an output folder means - and without it the path
 * must already be a directory.
 *
 * @param ctx - the plugin context.
 * @param request - `{ session, path, create, label }`.
 * @returns `{ directory }`.
 *
 * A `..` is deliberately NOT stripped from a relative path: it is resolved and
 * then caught by the containment check, so `../elsewhere` is REFUSED rather than
 * quietly reinterpreted as `<workspace>/elsewhere`, which is a different
 * directory than the caller asked for.
 */
export async function resolveDirectory(ctx, request) {
  const label = request.label ?? 'directory'
  const value = typeof request.path === 'string' ? request.path.trim() : ''
  const create = request.create === true
  if (value.includes('\u0000')) throw httpError(400, 'BAD_REQUEST', 'That path is not a path.')
  if (value === '' || value === '.' || value === './') {
    const root = await sessionRoot(ctx, request.session)
    try {
      return { directory: await fsp.realpath(path.resolve(root)) }
    } catch (err) {
      throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
  }
  const normalized = value.replace(/\\/g, '/')
  const absolute = isAbsolutePath(value)
  let rootReal = null
  if (!absolute) {
    const root = await sessionRoot(ctx, request.session)
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
  }
  const candidate = absolute
    ? path.resolve(value)
    : path.resolve(rootReal, ...normalized.split('/').filter((segment) => segment !== '' && segment !== '.'))
  if (create) {
    try {
      await fsp.mkdir(candidate, { recursive: true })
    } catch (err) {
      throw httpError(400, 'CANNOT_CREATE', 'Could not create that ' + label + ': ' + (err && err.message ? String(err.message) : String(err)))
    }
  }
  let real
  try {
    real = await fsp.realpath(candidate)
  } catch (err) {
    throw httpError(404, 'NOT_FOUND', 'No such ' + label + ': ' + value)
  }
  if (rootReal !== null) {
    const inside = real === rootReal || real.startsWith(rootReal + path.sep)
    if (!inside) throw httpError(403, 'OUTSIDE_WORKSPACE', 'That ' + label + ' points outside the conversation workspace: ' + value)
  }
  let stats
  try {
    stats = await fsp.stat(real)
  } catch (err) {
    throw httpError(404, 'NOT_FOUND', 'No such ' + label + ': ' + value)
  }
  if (!stats.isDirectory()) throw httpError(400, 'NOT_A_DIRECTORY', 'That ' + label + ' is not a directory: ' + value)
  return { directory: real }
}
