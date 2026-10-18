/**
 * dsh-frontend-craft — which folder a call may read, and which files it scans.
 *
 * The policy is the pack's own, stated once here because a bundle may not reach
 * into another bundle's files:
 *
 *   - a SESSION-RELATIVE target resolves inside that conversation's workspace,
 *     through `realpath` on both the root and the target, so a symlink pointing
 *     out is refused rather than followed;
 *   - an ABSOLUTE target is read as given - a design audit of a checkout
 *     somewhere else on this machine is a legitimate question - through
 *     `realpath`, so the path reported back is the real one.
 *
 * The workspace lookup is the same two-step one the other rows perform: the live
 * session header first, then session persistence.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** A refusal a tool can print: a code, and a sentence a reader can act on. */
export class FrontendError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FrontendError'
    this.code = code
  }
}

/** The workspace root of one session. */
export async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new FrontendError('BAD_REQUEST', 'A session id is required.')
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
  throw new FrontendError('NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
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

/** The two engines' inputs. A `.html` file is the static engine; the rest are text. */
export const HTML_EXTENSIONS = ['html', 'htm']
export const TEXT_EXTENSIONS = [
  'tsx',
  'ts',
  'jsx',
  'js',
  'mjs',
  'cjs',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  'pcss',
  'postcss',
  'svelte',
  'vue',
  'astro',
  'mdx',
  'ejs',
  'hbs',
  'njk',
  'liquid',
  'erb',
  'php',
  'cshtml',
  'razor',
  'twig',
]

/** Directories that are never source: build output, packages, state. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.frontend-craft',
  '.impeccable',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

/** How much one scan may read, and how many files it may walk. */
export const MAX_FILES = 2000
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** One file the scanner would read. */
export function kindOf(extension) {
  if (HTML_EXTENSIONS.includes(extension)) return 'html'
  if (TEXT_EXTENSIONS.includes(extension)) return 'text'
  return null
}

/**
 * Resolve a scan target to a real file or directory under the policy above.
 *
 * @returns `{ real, scope, relative, isDirectory }`.
 */
export async function resolveTarget(ctx, request) {
  const value = typeof request.target === 'string' ? request.target.trim() : ''
  const wanted = value === '' ? '.' : value
  if (wanted.includes('\u0000')) throw new FrontendError('BAD_REQUEST', 'That path is not a path.')
  const normalized = wanted.replace(/\\/g, '/')
  let target
  let scope
  let rootReal = null
  if (isAbsolutePath(wanted)) {
    try {
      target = await fsp.realpath(path.resolve(wanted))
    } catch (err) {
      throw new FrontendError('NOT_FOUND', 'No such file or folder: ' + wanted)
    }
    scope = 'absolute'
  } else {
    const root = await sessionRoot(ctx, request.session)
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw new FrontendError('NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
    const candidate = path.resolve(rootReal, ...normalized.split('/').filter((segment) => segment !== '' && segment !== '.'))
    try {
      target = await fsp.realpath(candidate)
    } catch (err) {
      throw new FrontendError('NOT_FOUND', 'No such file or folder in this workspace: ' + wanted)
    }
    const inside = target === rootReal || target.startsWith(rootReal + path.sep)
    if (!inside) throw new FrontendError('OUTSIDE_WORKSPACE', 'That path points outside the conversation workspace: ' + wanted)
    scope = 'workspace'
  }
  let stats
  try {
    stats = await fsp.stat(target)
  } catch (err) {
    throw new FrontendError('NOT_FOUND', 'No such file or folder: ' + target)
  }
  const relative =
    scope === 'workspace' && rootReal !== null
      ? target === rootReal
        ? '.'
        : target.slice(rootReal.length + 1).replace(/\\/g, '/')
      : null
  return { real: target, scope, relative, isDirectory: stats.isDirectory() }
}

/** Whether a path is a regular file (no throw, for the tools). */
export function isFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch (err) {
    return false
  }
}

/**
 * Every scannable source under one target, deterministically ordered.
 *
 * Deterministic on purpose: the same tree scanned twice reports the same order,
 * which is what makes a finding list comparable between two runs and two people.
 *
 * @returns `{ files, truncated }` where each file is
 *   `{ file, relative, kind, bytes }`.
 */
export function collectSources(root) {
  const files = []
  let truncated = false
  const walk = (dir) => {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of sorted) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const extension = extensionOf(entry.name)
      const kind = kindOf(extension)
      if (kind === null) continue
      const full = path.join(dir, entry.name)
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch (err) {
        continue
      }
      if (bytes > MAX_FILE_BYTES) continue
      files.push({ file: full, relative: path.relative(root, full).replace(/\\/g, '/'), kind, bytes })
    }
  }
  if (isFile(root)) {
    const extension = extensionOf(root)
    const kind = kindOf(extension)
    if (kind !== null) {
      const bytes = statSync(root).size
      if (bytes <= MAX_FILE_BYTES) files.push({ file: root, relative: path.basename(root), kind, bytes })
    }
  } else {
    walk(root)
  }
  return { files, truncated }
}

/** Read one source as text, with the total-budget check done by the caller. */
export async function readSource(entry) {
  return fsp.readFile(entry.file, 'utf8')
}
