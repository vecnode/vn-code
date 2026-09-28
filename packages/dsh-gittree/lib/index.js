/**
 * dsh-gittree — Node half.
 *
 * The GitTree tab is a browser plugin, but reading a repository needs the disk
 * and the `git` binary, neither of which the browser can reach. This row
 * therefore owns three authenticated `connection.fetch` routes under
 * /api/dsh-gittree/* — the same registration mechanism dsh-editor uses for its
 * file routes:
 *
 *   GET /api/dsh-gittree/state?session=<id>            working tree + status
 *   GET /api/dsh-gittree/history?session=<id>&limit=N  the commit log - with the
 *                                                      parents (`%P`) and the ref
 *                                                      decorations (`%D`) the
 *                                                      tab's rail draws its graph
 *                                                      from
 *   GET /api/dsh-gittree/commit?session=<id>&sha=<id>  one commit + its files
 *
 * **Read-only, on purpose.** The only git subcommands this file can reach are
 * `rev-parse`, `status`, `ls-files`, `log`, `show` and `diff-tree`. Nothing
 * stages, commits, checks out, fetches or writes a config value, so no request -
 * however malformed - can change a repository. (A write action would be a
 * separate, deliberate feature; it is not hidden here.)
 *
 * The session id is what the browser tab already carries; the workspace root is
 * resolved HERE (live session header first, session persistence second) exactly
 * like dsh-editor resolves it, and the repository is discovered from that folder
 * with `rev-parse --show-toplevel`. The client never names a path on disk, let
 * alone a git option: every argv element is a literal in this file, plus at most
 * a commit id that must match /^[0-9a-fA-F]{4,40}$/ before it can reach argv.
 *
 * **Scope.** When the conversation folder sits INSIDE a repository (a monorepo
 * package, or a session opened on a subdirectory), the tree and the history are
 * scoped to that folder - the same surface the Files tab shows - and every path
 * is reported workspace-relative, so a row click is handed straight to the
 * `dsh-resource://file/session/<id>/<path>` grammar the editor and the shipped
 * previews already claim.
 *
 * git runs as a child process with an argv array and **no shell**, under a
 * pinned environment (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
 * `LC_ALL=C`, `--no-pager`), with a 10 s timeout and an 8 MiB output cap: a
 * repository can never make this plugin prompt, lock, page or hang.
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-gittree'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-gittree'
const STATE_ROUTE = API_ROOT + '/state'
const HISTORY_ROUTE = API_ROOT + '/history'
const COMMIT_ROUTE = API_ROOT + '/commit'

/** Longest a single git call may take before it is killed. */
const GIT_TIMEOUT_MS = 10000
/** Most stdout one git call may produce. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Most tree rows one `state` answer carries (the rest is reported, not sent). */
const MAX_ENTRIES = 20000
/** History page size: default, and the ceiling a caller cannot raise. */
const DEFAULT_HISTORY = 50
const MAX_HISTORY = 200
/** A commit id that is safe to place in argv (never an option). */
const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/
/**
 * `git log` record/field separators. A subject cannot be mistaken for one of
 * them, and `--pretty=format:` output carries no other structure.
 */
const RECORD = '\u001e'
const FIELD = '\u001f'

/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Typed failure → HTTP response. */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  if (cause && typeof cause.stderrText === 'string') err.stderrText = cause.stderrText
  return err
}

function errorResponse(err) {
  const status = typeof err.status === 'number' ? err.status : 500
  const code = err.code || 'GIT_ERROR'
  const message = err.message || String(err)
  return json(status, { ok: false, error: { code, message } })
}

/**
 * The workspace root of one session: the live session header while the session
 * is running, otherwise the stored header from session persistence. This is the
 * same two-step lookup dsh-editor performs, and it degrades to a typed failure
 * (never a guess) when neither knows the session.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the session the tab belongs to.
 * @returns {Promise<string>} the session's cwd.
 */
async function sessionRoot(ctx, sessionId) {
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
    // fall through to persistence
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (err) {
    // fall through to the typed failure below
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** The environment every git call runs under: no prompts, no locks, C locale. */
function gitEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C',
    NO_COLOR: '1',
  }
}

/**
 * Run one git command in a repository and return its stdout.
 *
 * The argv array is passed to `spawn` directly (no shell), so no argument can be
 * interpreted by a shell, and the caller's arguments are always literals plus a
 * validated commit id.
 *
 * @param root - the repository root (the command's `-C` folder).
 * @param args - git arguments, after the global options.
 * @returns {Promise<string>} stdout, decoded as UTF-8.
 */
function runGit(root, args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', ['--no-pager', '-c', 'core.quotepath=false', '-C', root, ...args], {
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      reject(httpError(500, 'GIT_ERROR', 'Could not start git.', err))
      return
    }
    let out = Buffer.alloc(0)
    let errOut = Buffer.alloc(0)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch (e) {}
      reject(httpError(504, 'TIMEOUT', 'git did not finish in ' + Math.round(GIT_TIMEOUT_MS / 1000) + ' s.'))
    }, GIT_TIMEOUT_MS)
    child.on('error', (err) => {
      const missing = err && err.code === 'ENOENT'
      finish(reject, missing ? httpError(503, 'GIT_MISSING', 'git is not installed on this host.') : httpError(500, 'GIT_ERROR', 'Could not run git.', err))
    })
    child.stdout.on('data', (chunk) => {
      if (settled) return
      if (out.length + chunk.length > MAX_OUTPUT_BYTES) {
        settled = true
        clearTimeout(timer)
        try {
          child.kill()
        } catch (e) {}
        reject(httpError(413, 'TOO_LARGE', 'git produced more output than this route will read.'))
        return
      }
      out = Buffer.concat([out, chunk])
    })
    child.stderr.on('data', (chunk) => {
      // Enough to classify a failure; the rest is dropped.
      if (errOut.length < 64 * 1024) errOut = Buffer.concat([errOut, chunk])
    })
    child.on('close', (code) => {
      if (settled) return
      const stderrText = errOut.toString('utf8').trim()
      if (code === 0) {
        finish(resolve, out.toString('utf8'))
        return
      }
      const firstLine = stderrText.split('\n')[0] || 'git exited with code ' + code
      const err = httpError(422, 'GIT_FAILED', firstLine)
      err.stderrText = stderrText
      finish(reject, err)
    })
  })
}

/**
 * The repository behind one session's workspace, plus the scope prefix when the
 * workspace is a subfolder of it.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to resolve.
 * @returns {Promise<{cwd: string, root: string, scope: string, prefix: string}>}
 *   `scope` is the workspace path relative to the repository root ('' when they
 *   are the same folder) and `prefix` is that scope with a trailing slash, the
 *   form every entry path is matched against.
 */
async function repoInfo(ctx, sessionId) {
  // Both spellings matter: git reports the resolved (long) path while a session
  // header can carry a short 8.3 form on Windows or a symlinked path on macOS,
  // and a relative path computed across the two is meaningless. Resolving both
  // through realpath is what keeps the scope prefix honest.
  // The workspace lookup keeps its own typed failures (BAD_REQUEST, NO_WORKSPACE);
  // only a folder that cannot be resolved on disk becomes NO_FOLDER.
  const workspace = await sessionRoot(ctx, sessionId)
  let cwd
  try {
    cwd = await fsp.realpath(path.resolve(workspace))
  } catch (err) {
    throw httpError(400, 'NO_FOLDER', 'The workspace folder does not exist on disk.', err)
  }
  let top = ''
  try {
    top = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch (err) {
    if (err && (err.code === 'GIT_MISSING' || err.code === 'TIMEOUT')) throw err
    throw httpError(409, 'NOT_A_REPO', 'This conversation folder is not inside a git repository.', err)
  }
  if (top === '') {
    throw httpError(409, 'NOT_A_REPO', 'This conversation folder is not inside a git repository.')
  }
  let root = path.resolve(top)
  try {
    root = await fsp.realpath(root)
  } catch (err) {
    // Keep the absolute form git handed us; the commands below still work.
  }
  const relative = path.relative(root, cwd).replace(/\\/g, '/')
  const scope = relative === '' || relative === '.' ? '' : relative.replace(/\/+$/, '')
  if (scope.startsWith('..')) {
    throw httpError(409, 'NOT_A_REPO', 'This conversation folder is outside the repository git reported.')
  }
  return { cwd, root, scope, prefix: scope === '' ? '' : scope + '/' }
}

/**
 * Rewrite a repository-relative path as a workspace-relative one.
 * @returns the scoped path, or `null` when the path is outside the workspace.
 */
function scopePath(value, prefix) {
  const normalized = String(value).replace(/\\/g, '/')
  if (prefix === '') return normalized
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null
}

/**
 * Parse `git status --porcelain=v2 -z --branch` into the branch facts and the
 * changed entries. Rename records carry their source path as the NEXT
 * NUL-terminated token, which is why this walks tokens instead of lines.
 *
 * @param text - the raw stdout, NUL-separated.
 * @returns `{ info, entries }` with `entries` as `{ path, status, origPath? }`.
 */
function parseStatus(text) {
  const tokens = text.split('\u0000')
  const info = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false }
  const entries = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') continue
    if (token.startsWith('#')) {
      if (token.startsWith('# branch.head ')) {
        const value = token.slice('# branch.head '.length)
        info.detached = value === '(detached)'
        info.branch = info.detached ? '' : value
      } else if (token.startsWith('# branch.upstream ')) {
        info.upstream = token.slice('# branch.upstream '.length)
      } else if (token.startsWith('# branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(token)
        if (match) {
          info.ahead = Number(match[1])
          info.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '1') {
      const fields = token.split(' ')
      entries.push({ path: fields.slice(8).join(' '), status: fields[1] || '  ' })
    } else if (kind === '2') {
      const fields = token.split(' ')
      const origPath = tokens[i + 1] || ''
      i += 1
      entries.push({ path: fields.slice(9).join(' '), status: fields[1] || '  ', origPath })
    } else if (kind === 'u') {
      const fields = token.split(' ')
      entries.push({ path: fields.slice(10).join(' '), status: fields[1] || 'UU', unmerged: true })
    } else if (kind === '?') {
      entries.push({ path: token.slice(2), status: '??' })
    }
    // '!' (ignored) is never requested; anything else is not a record type.
  }
  return { info, entries }
}

/**
 * Merge the tracked file list with the changed entries into one workspace-scoped
 * list: every tracked file appears (clean ones with an empty status) and every
 * untracked or changed path carries its `XY` code.
 *
 * @param trackedText - stdout of `git ls-files -z`.
 * @param statusEntries - entries from {@link parseStatus}.
 * @param prefix - the workspace scope prefix ('' for the repository root).
 * @returns the entries, sorted by path.
 */
function mergeEntries(trackedText, statusEntries, prefix) {
  const map = new Map()
  for (const raw of trackedText.split('\u0000')) {
    if (raw === '') continue
    const rel = scopePath(raw, prefix)
    if (rel === null) continue
    map.set(rel, { path: rel, status: '' })
  }
  for (const entry of statusEntries) {
    const rel = scopePath(entry.path, prefix)
    if (rel === null) continue
    const origPath = entry.origPath ? scopePath(entry.origPath, prefix) : null
    const existing = map.get(rel)
    if (existing) {
      existing.status = entry.status
      if (origPath) existing.origPath = origPath
      if (entry.unmerged) existing.unmerged = true
      continue
    }
    const next = { path: rel, status: entry.status }
    if (origPath) next.origPath = origPath
    if (entry.unmerged) next.unmerged = true
    map.set(rel, next)
  }
  return [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** GET /api/dsh-gittree/state — the workspace's git facts (and, fully, its tree). */
async function handleState(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    // `brief=1` is the form the tab uses: the branch, the current commit and how
    // many files changed - nothing else. The file list is not built at all (no
    // `ls-files`, no merge), because the History-only surface never shows it.
    const brief = url.searchParams.get('brief') === '1'
    const repo = await repoInfo(ctx, sessionId)
    const statusText = await runGit(repo.root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--branch'])
    const parsed = parseStatus(statusText)
    let head = ''
    try {
      head = (await runGit(repo.root, ['rev-parse', '--short', 'HEAD'])).trim()
    } catch (err) {
      // An unborn branch has no commit to name.
      head = ''
    }
    if (brief) {
      const scoped = parsed.entries.filter((entry) => scopePath(entry.path, repo.prefix) !== null)
      return json(200, {
        ok: true,
        brief: true,
        root: repo.cwd,
        repoRoot: repo.root,
        scope: repo.scope,
        branch: parsed.info.branch,
        head,
        detached: parsed.info.detached,
        upstream: parsed.info.upstream,
        ahead: parsed.info.ahead,
        behind: parsed.info.behind,
        changed: scoped.length,
      })
    }
    let trackedText = ''
    try {
      trackedText = await runGit(repo.root, ['ls-files', '-z'])
    } catch (err) {
      // A repository with no index (or an unreadable one) still answers with its
      // status entries; the tree then simply has no clean files to show.
      if (err && (err.code === 'GIT_MISSING' || err.code === 'TIMEOUT' || err.code === 'TOO_LARGE')) throw err
    }
    const all = mergeEntries(trackedText, parsed.entries, repo.prefix)
    const truncated = all.length > MAX_ENTRIES
    const entries = truncated ? all.slice(0, MAX_ENTRIES) : all
    return json(200, {
      ok: true,
      root: repo.cwd,
      repoRoot: repo.root,
      scope: repo.scope,
      branch: parsed.info.branch,
      head,
      detached: parsed.info.detached,
      upstream: parsed.info.upstream,
      ahead: parsed.info.ahead,
      behind: parsed.info.behind,
      entries,
      total: all.length,
      changed: entries.filter((entry) => entry.status !== '').length,
      truncated,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * The `%x1f`-joined field lists: one per log row, one for a commit header.
 *
 * The log carries `%P` (the parents, which is what the tab's rail draws the
 * graph from) and `%D` (the ref decorations: the branch HEAD points at, tags,
 * remote branches, and `refs/pull/<n>/head` when a repository has fetched a pull
 * request). Both are EMPTY for a root commit and for a commit no ref names, so
 * the two trailing separators are always there and the field count never varies.
 */
const LOG_FIELDS = '%H' + FIELD + '%h' + FIELD + '%an' + FIELD + '%ad' + FIELD + '%s' + FIELD + '%P' + FIELD + '%D'
const COMMIT_FIELDS = '%H' + FIELD + '%h' + FIELD + '%an' + FIELD + '%ae' + FIELD + '%ad' + FIELD + '%s' + FIELD + '%b'

/**
 * Parse one `git log` row's `%P` field: the parent ids, space separated (empty
 * for a root commit).
 * @returns {string[]} the parent ids, in git's own order (first parent first).
 */
function parseParents(value) {
  const text = String(value || '').trim()
  return text === '' ? [] : text.split(/\s+/)
}

/**
 * Parse one `git log` row's `%D` field: the ref decorations, comma separated.
 *
 * `%d` prints `HEAD -> main, origin/main, tag: v1.0`, and a pull-request ref is
 * not shortened (`refs/pull/12/head`), which is exactly what lets the tab show a
 * pull request as its own chip. The separator is git's own, so a ref whose NAME
 * contains a comma - legal, and vanishingly rare - comes back as two refs: one
 * cosmetic chip rather than a wrong commit.
 *
 * @returns {string[]} the ref names, in git's own order.
 */
function parseRefs(value) {
  const text = String(value || '').trim()
  if (text === '') return []
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** GET /api/dsh-gittree/history — the commit log, newest first. */
async function handleHistory(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    const requested = Number.parseInt(url.searchParams.get('limit') || '', 10)
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_HISTORY) : DEFAULT_HISTORY
    const repo = await repoInfo(ctx, sessionId)
    const args = ['log', '-n', String(limit), '--date=short', '--decorate=short', '--pretty=format:' + LOG_FIELDS + RECORD]
    if (repo.scope !== '') args.push('--', repo.scope)
    let text = ''
    try {
      text = await runGit(repo.root, args)
    } catch (err) {
      const stderr = typeof err.stderrText === 'string' ? err.stderrText : ''
      const unborn = /does not have any commits|unknown revision|bad default revision|your current branch/i.test(stderr)
      if (err && err.code === 'GIT_FAILED' && unborn) {
        return json(200, { ok: true, commits: [], empty: true })
      }
      throw err
    }
    const commits = []
    for (const record of text.split(RECORD)) {
      const trimmed = record.replace(/^\n+/, '')
      if (trimmed === '') continue
      const fields = trimmed.split(FIELD)
      if (fields.length < 5) continue
      const parents = parseParents(fields[5])
      commits.push({
        sha: fields[0],
        short: fields[1],
        author: fields[2],
        date: fields[3],
        subject: fields[4],
        parents,
        refs: parseRefs(fields[6]),
        merge: parents.length > 1,
      })
    }
    return json(200, { ok: true, commits })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * Parse `git diff-tree --name-status -z` output into `{ status, path, origPath }`
 * rows. With `-z` the status and each path are separate NUL tokens; a rename or
 * copy adds the source path after the destination.
 */
function parseNameStatus(text) {
  const tokens = text.split('\u0000').filter((token) => token !== '')
  const files = []
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!/^[A-Z][0-9]*$/.test(code)) continue
    const first = tokens[i + 1] || ''
    if (first === '') continue
    if (code[0] === 'R' || code[0] === 'C') {
      const second = tokens[i + 2] || ''
      i += 2
      files.push({ status: code[0], origPath: first, path: second === '' ? first : second })
      continue
    }
    i += 1
    files.push({ status: code[0], path: first })
  }
  return files
}

/** GET /api/dsh-gittree/commit — one commit's header and its changed files. */
async function handleCommit(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    const sha = (url.searchParams.get('sha') || '').trim()
    if (!SHA_PATTERN.test(sha)) return fail(400, 'BAD_REQUEST', 'A commit id is required.')
    const repo = await repoInfo(ctx, sessionId)
    const headerText = await runGit(repo.root, ['show', '-s', '--date=short', '--pretty=format:' + COMMIT_FIELDS, sha, '--'])
    const fields = headerText.split(FIELD)
    if (fields.length < 5) return fail(502, 'BAD_ANSWER', 'git did not describe that commit.')
    // `--root` is what makes the repository's FIRST commit list its files at all:
    // without it `diff-tree` prints nothing for a root commit.
    const namesText = await runGit(repo.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', sha, '--'])
    const files = []
    for (const file of parseNameStatus(namesText)) {
      const rel = scopePath(file.path, repo.prefix)
      if (rel === null) continue
      const row = { status: file.status, path: rel }
      if (file.origPath !== undefined) {
        const from = scopePath(file.origPath, repo.prefix)
        if (from !== null) row.origPath = from
      }
      files.push(row)
    }
    return json(200, {
      ok: true,
      commit: {
        sha: fields[0],
        short: fields[1],
        author: fields[2],
        email: fields[3],
        date: fields[4],
        subject: fields[5] || '',
        body: (fields[6] || '').trim(),
      },
      files,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * Activate the plugin row: register the read-only routes.
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  const connection = ctx.get ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-gittree] connection service unavailable - git routes not registered')
    return
  }
  ctx.effect(() => {
    ctx.logger?.debug?.('[dsh-gittree] node half active (alpha)')
    // `requestBody: 'buffered'` is REQUIRED: Connection's HTTP bridge picks the
    // streaming branch for a route that leaves it undefined, and building a
    // streaming Request for a bodyless method (GET) throws before the handler
    // ever runs (the web server then answers a bare 400).
    const routes = [
      { path: STATE_ROUTE, fetch: (request) => handleState(ctx, request) },
      { path: HISTORY_ROUTE, fetch: (request) => handleHistory(ctx, request) },
      { path: COMMIT_ROUTE, fetch: (request) => handleCommit(ctx, request) },
    ]
    const offs = routes.map((route) =>
      connection.fetch.register({
        path: route.path,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: route.fetch,
      }),
    )
    return () => {
      for (const off of offs) {
        try {
          off()
        } catch (e) {}
      }
      ctx.logger?.debug?.('[dsh-gittree] node half disposed')
    }
  }, 'dsh-gittree: git routes')
}
