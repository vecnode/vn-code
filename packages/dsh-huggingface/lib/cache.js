/**
 * dsh-huggingface — the cache on THIS disk, walked without the CLI.
 *
 * The CLI's own `hf cache ls --json` cannot answer the question this row exists
 * for, and the reason is measured rather than assumed: its JSON carries
 * `"size": "17.9G"` and `"last_accessed": "3 months ago"` - a human string and a
 * relative time. Byte-exact arithmetic, a revision comparison and "is the weight
 * file actually here" all need the directory tree.
 *
 * THE LAYOUT, and why sizes are computed the way they are:
 *
 *   <root>/models--<org>--<name>/
 *       blobs/        content-addressed bytes (a POSIX cache keeps them here)
 *       snapshots/<revision>/   links into blobs - or, where links are
 *                               unavailable or Xet wrote the files, REAL copies
 *       refs/<name>   branch/tag -> revision
 *
 * Summing both sides double-counts whenever snapshots are links, so exactly one
 * side is summed: `blobs` when it holds a non-empty file, `snapshots` otherwise.
 * MEASURED on the machine that wrote this: that cache has NO blobs at all and
 * real files under `snapshots/`, so the blobs-first rule alone would report 0
 * bytes for a 418 MB repo.
 *
 * AND THE FINDING THE ROW IS WORTH HAVING: a repository that is "cached" is very
 * often metadata only. On the same machine 40 of 50 entries were a config.json
 * and nothing else - a repo that looks present, cannot be loaded, and is
 * indistinguishable from a complete one in a directory listing. Every entry here
 * carries `weights` and `stub`, so "cached" and "complete" are different words.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** The directory prefix per repo type. */
export const REPO_PREFIXES = [
  { prefix: 'models--', type: 'model' },
  { prefix: 'datasets--', type: 'dataset' },
  { prefix: 'spaces--', type: 'space' },
]

/** A file that means "the weights are actually here". */
export const WEIGHT_PATTERN = /\.(safetensors|bin|gguf|pt|pth|onnx|h5|msgpack|ckpt|npz)$/i

/** A repo below this many bytes cannot hold weights, whatever it contains. */
export const STUB_BYTES = 1_048_576

/** The most files one repo is walked before the scan stops counting. */
export const MAX_FILES_PER_REPO = 20_000

/**
 * Split `models--org--name` into its type and id.
 *
 * @param directory - the directory name.
 * @returns `{ type, id }` or null when it is not a repo directory.
 */
export function splitRepoDir(directory) {
  for (const entry of REPO_PREFIXES) {
    if (directory.startsWith(entry.prefix) && directory.length > entry.prefix.length) {
      return { type: entry.type, id: directory.slice(entry.prefix.length).split('--').join('/') }
    }
  }
  return null
}

/** The directory name a repo id and type map to. */
export function repoDirName(type, id) {
  const entry = REPO_PREFIXES.find((candidate) => candidate.type === type)
  if (entry === undefined) return null
  return entry.prefix + id.split('/').join('--')
}

/**
 * Every file under `dir`, bounded, with its size and modification time.
 *
 * @returns `{ files: [{ path, bytes, mtimeMs }], truncated }`.
 */
export function walkFiles(dir, limit = MAX_FILES_PER_REPO) {
  const files = []
  let truncated = false
  const queue = [dir]
  while (queue.length > 0) {
    const current = queue.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (files.length >= limit) {
        truncated = true
        return { files, truncated }
      }
      try {
        // stat() follows a link to the blob it names, which is the byte count
        // that matters; lstat() is used only to know that it IS a link.
        const stat = statSync(full)
        const link = lstatSync(full)
        files.push({ path: full, bytes: stat.size, mtimeMs: stat.mtimeMs, link: link.isSymbolicLink() })
      } catch (error) {
        /* a file removed mid-walk is not a repo we can describe */
      }
    }
  }
  return { files, truncated }
}

/** The sum of a list of entries' bytes. */
function sumBytes(entries) {
  return entries.reduce((total, entry) => total + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)
}

/**
 * Describe one repo directory.
 *
 * @param root - the cache root.
 * @param directory - the repo's directory name.
 * @returns the repo's facts, or null when the directory cannot be read.
 */
export function describeRepoDir(root, directory) {
  const split = splitRepoDir(directory)
  if (split === null) return null
  const repoRoot = path.join(root, directory)
  let entries
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true })
  } catch (error) {
    return null
  }
  const has = (name) => entries.some((entry) => entry.isDirectory() && entry.name === name)

  // refs: branch/tag -> revision. Read as text, bounded: these are 40-hex ids.
  const refs = {}
  if (has('refs')) {
    for (const entry of readdirSync(path.join(repoRoot, 'refs'), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        refs[entry.name] = readFileSync(path.join(repoRoot, 'refs', entry.name), 'utf8').trim()
      } catch (error) {
        /* unreadable ref: reported as absent rather than guessed */
      }
    }
  }

  // snapshots: one directory per revision.
  const revisions = []
  if (has('snapshots')) {
    for (const entry of readdirSync(path.join(repoRoot, 'snapshots'), { withFileTypes: true })) {
      if (entry.isDirectory()) revisions.push(entry.name)
    }
  }

  const blobs = has('blobs') ? walkFiles(path.join(repoRoot, 'blobs')) : { files: [], truncated: false }
  const snapshots = has('snapshots') ? walkFiles(path.join(repoRoot, 'snapshots')) : { files: [], truncated: false }
  const blobBytes = sumBytes(blobs.files.filter((file) => file.bytes > 0))
  const layout = blobBytes > 0 ? 'blobs' : 'snapshots'

  // Only ONE side is summed: both sides hold the same bytes whenever snapshots
  // are links, and adding them would report a cache twice its size.
  //
  // The weight test is the opposite way round on purpose: a blob is named by its
  // HASH, so `blobs/9f3c...` carries no extension and an extension test against
  // it would call every canonical POSIX repo weightless. The NAMES that say what
  // a file is are the snapshot entries - which is also where a copy is real.
  const counted = layout === 'blobs' ? blobs.files : snapshots.files
  const truncated = layout === 'blobs' ? blobs.truncated : snapshots.truncated
  const weights = snapshots.files.filter((file) => WEIGHT_PATTERN.test(file.path) && file.bytes > 0)
  const bytes = sumBytes(counted)
  const newest = counted.reduce((latest, file) => (file.mtimeMs > latest ? file.mtimeMs : latest), 0)
  const revision = refs.main ?? revisions[0] ?? ''
  // A model is metadata-only when it has no weight file, whatever its size: a
  // small repo WITH weights is a small model, not a stub. A dataset or a space
  // has no weights by definition, so there the size is what separates a real
  // download from a few KB of cards and config.
  const stub = split.type === 'model' ? weights.length === 0 : bytes < STUB_BYTES

  return {
    type: split.type,
    id: split.id,
    directory,
    path: repoRoot,
    bytes,
    files: counted.length,
    layout,
    revisions,
    refs,
    revision,
    weights: weights.length > 0,
    weightFiles: weights.map((file) => path.basename(file.path)).slice(0, 8),
    stub,
    modifiedMs: newest,
    truncated,
  }
}

/**
 * Scan a cache root.
 *
 * @param root - the directory holding `models--*` / `datasets--*` / `spaces--*`.
 * @param options - `{ type, filter, limit }`.
 * @returns `{ root, exists, repos, counts }`.
 */
export function scanCache(root, options = {}) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return { root, exists: false, repos: [], counts: { repos: 0, bytes: 0, stubs: 0, complete: 0, byType: {} } }
  }
  const repos = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const described = describeRepoDir(root, entry.name)
    if (described === null) continue
    if (options.type !== undefined && described.type !== options.type) continue
    if (typeof options.filter === 'string' && options.filter !== '' && !described.id.toLowerCase().includes(options.filter.toLowerCase())) continue
    repos.push(described)
  }
  repos.sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id))
  const limited = Number.isFinite(options.limit) && options.limit > 0 ? repos.slice(0, options.limit) : repos
  const counts = { repos: repos.length, bytes: 0, stubs: 0, complete: 0, byType: {} }
  for (const repo of repos) {
    counts.bytes += repo.bytes
    if (repo.stub) counts.stubs += 1
    else counts.complete += 1
    counts.byType[repo.type] = (counts.byType[repo.type] ?? 0) + 1
  }
  return { root, exists: true, repos: limited, all: repos, counts, limited: limited.length !== repos.length }
}

/**
 * Find one repo in a scan, by id and type.
 *
 * @returns the entry, or null.
 */
export function findRepo(scan, type, id) {
  const wanted = String(id).toLowerCase()
  for (const repo of scan.all ?? scan.repos ?? []) {
    if (repo.type === type && repo.id.toLowerCase() === wanted) return repo
  }
  return null
}
