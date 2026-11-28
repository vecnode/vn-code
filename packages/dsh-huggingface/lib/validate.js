/**
 * dsh-huggingface — the caps, and the one place an argument becomes a plan.
 *
 * Every limit here is a refusal, never a clamp: a search limit of 500 is
 * refused with the cap named instead of being quietly turned into 50, and a
 * download over the ceiling is refused with its measured size beside the
 * ceiling. A clamped input is a claim about a setting nobody applied.
 */

import { HfError } from './errors.js'

/** Every bound this row enforces. */
export const CAPS = {
  statusTimeoutMs: 15_000,
  readTimeoutMs: 30_000,
  downloadTimeoutMs: 3_600_000,
  /** A download larger than this needs an explicit `maxBytes` that admits it. */
  maxDownloadBytes: 8 * 1024 ** 3,
  maxAllowedBytes: 1024 ** 4,
  defaultSearchLimit: 10,
  maxSearchLimit: 50,
  maxFilesListed: 25,
  maxDownloadFiles: 200,
  maxPatterns: 20,
  maxOutputBytes: 4_000_000,
}

/** The repo types the Hub has, and the CLI's subcommand for each. */
export const REPO_TYPES = {
  model: { group: 'models', label: 'model' },
  dataset: { group: 'datasets', label: 'dataset' },
  space: { group: 'spaces', label: 'space' },
}

/** `org/name`, the only shape a Hub id has. */
export const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

/** A revision is a branch, a tag or a commit: no spaces, no traversal. */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/** The sort keys `hf models list --sort` accepts. */
export const SORT_KEYS = ['created_at', 'downloads', 'last_modified', 'likes', 'trending_score']

/** True for a non-empty string after trimming. */
function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validate a repo id and type.
 *
 * @returns `{ repo, type, group }`.
 */
export function validateRepo(args) {
  const repo = text(args.repo) ? args.repo.trim() : ''
  if (repo === '') throw new HfError('BAD_INPUT', 'A repo id is required, as `org/name` (e.g. `sentence-transformers/all-mpnet-base-v2`).')
  if (!REPO_ID.test(repo)) {
    throw new HfError('BAD_INPUT', 'That is not a Hub repo id: expected `org/name`, got "' + repo + '". A local path is a file, not a repo - use a filesystem tool for it.')
  }
  const type = text(args.type) ? args.type.trim().toLowerCase() : 'model'
  const entry = REPO_TYPES[type]
  if (entry === undefined) throw new HfError('BAD_INPUT', 'A repo type is one of ' + Object.keys(REPO_TYPES).join(', ') + ' (got "' + type + '").')
  return { repo, type, group: entry.group }
}

/**
 * Validate a search.
 *
 * @returns `{ query, type, group, limit, sort, author, filters }`.
 */
export function validateSearch(args) {
  const type = text(args.type) ? args.type.trim().toLowerCase() : 'model'
  const entry = REPO_TYPES[type]
  if (entry === undefined) throw new HfError('BAD_INPUT', 'A repo type is one of ' + Object.keys(REPO_TYPES).join(', ') + ' (got "' + type + '").')
  let limit = CAPS.defaultSearchLimit
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > CAPS.maxSearchLimit) {
      throw new HfError('BAD_INPUT', '`limit` is a whole number from 1 to ' + CAPS.maxSearchLimit + ' (got ' + JSON.stringify(args.limit) + ').')
    }
    limit = args.limit
  }
  let sort = ''
  if (text(args.sort)) {
    sort = args.sort.trim()
    if (!SORT_KEYS.includes(sort)) throw new HfError('BAD_INPUT', '`sort` is one of ' + SORT_KEYS.join(', ') + ' (got "' + sort + '").')
  }
  const filters = Array.isArray(args.filters) ? args.filters.filter((value) => text(value)).map((value) => value.trim()) : []
  if (filters.length > 5) throw new HfError('BAD_INPUT', 'At most 5 `filters` (got ' + filters.length + ').')
  if (text(args.author) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(args.author.trim())) {
    throw new HfError('BAD_INPUT', '`author` is an org or user name, not a path (got "' + args.author + '").')
  }
  return {
    query: text(args.query) ? args.query.trim() : '',
    type,
    group: entry.group,
    limit,
    sort,
    author: text(args.author) ? args.author.trim() : '',
    filters,
  }
}

/**
 * Validate a cache action.
 *
 * @returns `{ action, repo, type, group, revision, confirm, filter, limit }`.
 */
export function validateCache(args) {
  const action = text(args.action) ? args.action.trim().toLowerCase() : 'list'
  if (!['list', 'verify', 'prune', 'rm'].includes(action)) {
    throw new HfError('BAD_INPUT', '`action` is one of list, verify, prune, rm (got "' + action + '").')
  }
  const base = { action, confirm: text(args.confirm) ? args.confirm.trim() : '' }
  if (action === 'list') {
    const type = text(args.type) ? args.type.trim().toLowerCase() : ''
    if (type !== '' && REPO_TYPES[type] === undefined) throw new HfError('BAD_INPUT', '`type` is one of ' + Object.keys(REPO_TYPES).join(', ') + ' (got "' + type + '").')
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 100
    return { ...base, type, filter: text(args.filter) ? args.filter.trim() : '', limit }
  }
  if (action === 'prune') {
    // A prune is cache-wide: there is no repo to name, and demanding one would
    // make the action unreachable.
    return { ...base, type: '', repo: '', group: '', revision: '' }
  }
  const repo = validateRepo(args)
  for (const key of ['revision']) {
    if (text(args[key]) && !REVISION.test(args[key].trim())) throw new HfError('BAD_INPUT', '`' + key + '` is a branch, tag or commit (got "' + args[key] + '").')
  }
  return { ...base, ...repo, revision: text(args.revision) ? args.revision.trim() : '' }
}

/**
 * Validate a download, before anything is fetched.
 *
 * @returns the plan: repo, type, group, files, include, exclude, revision,
 *   maxBytes, confirm.
 */
export function validateDownload(args) {
  const repo = validateRepo(args)
  const files = Array.isArray(args.files) ? args.files : []
  if (files.length > CAPS.maxDownloadFiles) throw new HfError('BAD_INPUT', 'At most ' + CAPS.maxDownloadFiles + ' `files` per call (got ' + files.length + '); use `include` patterns for more.')
  const cleanFiles = files.map((value) => {
    if (!text(value)) throw new HfError('BAD_INPUT', 'A `files` entry is a repo-relative path, not an empty value.')
    const name = value.trim()
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new HfError('BAD_INPUT', 'A `files` entry is a path INSIDE the repo, never an absolute path or one with ".." (got "' + name + '").')
    }
    return name
  })
  const patterns = (value, key) => {
    const list = Array.isArray(value) ? value.filter((entry) => text(entry)).map((entry) => entry.trim()) : []
    if (list.length > CAPS.maxPatterns) throw new HfError('BAD_INPUT', 'At most ' + CAPS.maxPatterns + ' `' + key + '` patterns (got ' + list.length + ').')
    return list
  }
  let maxBytes = CAPS.maxDownloadBytes
  if (args.maxBytes !== undefined && args.maxBytes !== null) {
    if (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes) || args.maxBytes < 1_048_576 || args.maxBytes > CAPS.maxAllowedBytes) {
      throw new HfError('BAD_INPUT', '`maxBytes` is a byte count from 1 MiB to 1 TiB (got ' + JSON.stringify(args.maxBytes) + ').')
    }
    maxBytes = Math.floor(args.maxBytes)
  }
  if (text(args.revision) && !REVISION.test(args.revision.trim())) {
    throw new HfError('BAD_INPUT', '`revision` is a branch, tag or commit (got "' + args.revision + '").')
  }
  return {
    ...repo,
    files: cleanFiles,
    include: patterns(args.include, 'include'),
    exclude: patterns(args.exclude, 'exclude'),
    revision: text(args.revision) ? args.revision.trim() : '',
    maxBytes,
    confirm: text(args.confirm) ? args.confirm.trim() : '',
  }
}
