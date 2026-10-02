/**
 * dsh-canvas — where an export lands, and how a file name is chosen.
 *
 * Two destinations, and both are deliberate:
 *
 *   - the **Desktop** by default, because a banner is something a person keeps
 *     and the Desktop is where that person is looking (the same choice
 *     `dsh-diagrams` and the screenshot control made);
 *   - the **conversation workspace** on request, because a README header or a
 *     LinkedIn banner often belongs in the repository the design is about -
 *     resolved with the same `realpath` containment `dsh-editor` uses for its
 *     saves, so a symlinked folder cannot smuggle a write outside the workspace.
 *
 * Nothing here ever overwrites: a name that exists gets `-2`, `-3`, … and the
 * caller is told the absolute path it got. The Desktop resolution is duplicated
 * from `dsh-diagrams` (which duplicated it from `dsh-themes`) on purpose: this
 * pack ships zero npm dependencies and one bundle may not reach into another
 * bundle's files, so the copies stay in step behaviourally rather than by import.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One typed export failure. */
export function exportError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** The first candidate that names an existing directory, else null. */
async function firstDirectory(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      const info = await fsp.stat(candidate)
      if (info.isDirectory()) return candidate
    } catch (err) {
      /* not there: try the next one */
    }
  }
  return null
}

/** The Desktop a freedesktop host names in `user-dirs.dirs`. */
async function xdgDesktop() {
  const configHome = process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, '.config') : null)
  if (configHome === null) return null
  let text
  try {
    text = await fsp.readFile(path.join(configHome, 'user-dirs.dirs'), 'utf8')
  } catch (err) {
    return null
  }
  const match = /^[ \t]*XDG_DESKTOP_DIR[ \t]*=[ \t]*"([^"]*)"/m.exec(text)
  if (match === null) return null
  const home = process.env.HOME || os.homedir()
  const value = match[1].replace(/^\$HOME(?=\/|$)/, home)
  return path.isAbsolute(value) ? value : null
}

/**
 * Where this host keeps its Desktop, resolved PER REQUEST and never cached: a
 * Windows profile can be redirected into OneDrive, a Linux desktop can name its
 * own folder, and either can change while this row is mounted. The home folder is
 * the last resort, so an export always has somewhere to go.
 */
export async function desktopDirectory() {
  const profile = process.env.USERPROFILE
  const home = process.env.HOME
  let osHome = null
  try {
    osHome = os.homedir()
  } catch (err) {
    osHome = null
  }
  const directory = await firstDirectory([
    profile ? path.join(profile, 'Desktop') : null,
    profile ? path.join(profile, 'OneDrive', 'Desktop') : null,
    home ? path.join(home, 'Desktop') : null,
    await xdgDesktop(),
    osHome ? path.join(osHome, 'Desktop') : null,
    osHome ? path.join(osHome, 'OneDrive', 'Desktop') : null,
    profile,
    home,
    osHome,
  ])
  if (directory === null) throw exportError('NO_DESKTOP', 'this host has no Desktop or home folder to save the export into')
  return directory
}

/**
 * Write one file into a directory under a name that does not exist yet.
 *
 * @param options - `{ directory, baseName, ext, bytes, overwrite }`. `overwrite`
 *   is for a RENDER of a known revision: the same revision is the same picture,
 *   so it replaces its own file instead of accumulating `-2`, `-3`, ….
 * @returns `{ path, name, bytes, created }`.
 */
export async function writeCreateExclusive(options) {
  const directory = options.directory
  if (typeof directory !== 'string' || directory.length === 0) throw exportError('NO_DIRECTORY', 'no directory to write into')
  mkdirSync(directory, { recursive: true })
  const base = sanitizeName(options.baseName) || 'design'
  const ext = String(options.ext ?? 'png').replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'png'
  if (options.overwrite === true) {
    const target = path.join(directory, base + '.' + ext)
    try {
      writeFileSync(target, options.bytes, { mode: 0o644 })
    } catch (err) {
      throw exportError('IO_ERROR', 'could not write ' + target + ': ' + (err && err.message ? err.message : err))
    }
    return { path: target, name: base + '.' + ext, bytes: options.bytes.length, created: true }
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base + '.' + ext : base + '-' + (attempt + 1) + '.' + ext
    const target = path.join(directory, name)
    if (existsSync(target)) continue
    try {
      // `wx` is the atomic create-exclusive: a race loses rather than overwrites.
      writeFileSync(target, options.bytes, { flag: 'wx', mode: 0o644 })
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw exportError('IO_ERROR', 'could not write ' + target + ': ' + (err && err.message ? err.message : err))
    }
    return { path: target, name, bytes: options.bytes.length, created: true }
  }
  throw exportError('NAME_TAKEN', 'could not find a free file name in ' + directory + ' after 100 attempts')
}

/** A file name safe on every platform, keeping the model's words. */
export function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
}

/**
 * Resolve a workspace-relative path for a file that must NOT exist yet.
 *
 * The parent folder must already exist inside the workspace and is realpath
 * checked, so a symlinked folder cannot smuggle a write outside the conversation
 * folder. Mirrors `dsh-editor`'s own create path; nothing here creates
 * directories.
 *
 * @param cwd - the session workspace root (absolute).
 * @param rel - the new file's path, relative to the workspace root.
 * @returns the absolute target path.
 */
export async function resolveNewInside(cwd, rel) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw exportError('NO_WORKSPACE', 'the conversation folder is not available')
  if (typeof rel !== 'string' || rel.length === 0) throw exportError('BAD_REQUEST', 'a file name is required')
  const normalized = rel.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw exportError('BAD_REQUEST', 'the path must be relative to the conversation folder')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw exportError('BAD_REQUEST', 'the path cannot contain empty, "." or ".." segments')
  }
  const rootReal = await fsp.realpath(path.resolve(cwd)).catch(() => {
    throw exportError('NO_FOLDER', 'the conversation folder does not exist on disk')
  })
  const parent = segments.slice(0, -1).join('/')
  const parentAbs = parent.length > 0 ? path.resolve(rootReal, parent) : rootReal
  const parentReal = await fsp.realpath(parentAbs).catch(() => {
    throw exportError('NO_FOLDER', 'the folder ' + (parent || '.') + ' does not exist in the conversation folder')
  })
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  if (parentReal !== rootReal && !parentReal.startsWith(rootPrefix)) {
    throw exportError('OUTSIDE_WORKSPACE', 'the path escapes the conversation folder')
  }
  return path.join(parentReal, segments[segments.length - 1])
}

/** A short human size for a status line. */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/** Whether a path is an existing regular file (a re-check after a write). */
export function fileInfo(file) {
  try {
    const info = statSync(file)
    return { exists: true, bytes: info.size, at: info.mtime.toISOString() }
  } catch (err) {
    return { exists: false, bytes: 0, at: null }
  }
}
