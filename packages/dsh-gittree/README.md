# dsh-gittree (alpha.5)

**History** is a **read-only git history tab** for the pack's right bar
(`dsh-rightbar` — the pack's right-hand column, beside the shipped **Start**
page, the **Files** tab and the pack's **Editor**). It is a **page tab type** —
no `patterns`, so it never competes for a file address, and
`priority: 'builtin'` — with one guide entry at `order: 30` after Files (10) and
Editor (20). It is labelled History in the capsule and the chip while the
package, the row and the address keep the `dsh-gittree` / `gittree` name. It
shows the **commit history** of the tab's own conversation folder — short id,
subject, author and date, newest first — beside a **rail** that draws the commit
**graph** on the left of the list. The branch and the current commit stay in the
file bar above it. Picking a commit opens its message and the files it touched; a
changed-file row opens through the ordinary `openResource` action with **no
options**, so the registry decides what claims it — and this package needs
neither the editor nor a preview and publishes no service. Alpha.

**It is read-only.** Nothing here can stage, commit, check out, fetch or write
config: the only git subcommands it reaches are `rev-parse`, `status`,
`ls-files`, `log`, `show` and `diff-tree`.

## The rail (the graph)

Every history row sits beside a rail: a **vertical rectangle** on the left of the
list carrying the commit graph, drawn from the same answer the list is drawn from.

- **One column per branch lane.** The layout is one forward pass over `git log`
  in its own order (a child always comes before its parent): a lane is a column
  holding the id of the commit it is waiting for, a commit takes the lane already
  waiting for it or a free one, and its first parent inherits that lane while
  every further parent — a merge — starts or joins another. A parent the page does
  not carry (the log's own limit, or a workspace-scoped log) ends the lane, which
  is the honest picture of a history that continues past what was read.
- **A node per commit**, on the lane's centre line, with the line running **up to
  the newer commit above it** and down to its first parent. A merge wears a
  **larger hollow ring** — the shape a branch joining in makes — and the commit
  `HEAD` points at wears a halo.
- **Curves where a branch moves**: an elbow where a merge's extra parent leaves
  the node, and one where that branch rejoins the line at the commit both parents
  descend from.
- **Pull requests**, named from the repository itself (there is no network here):
  GitHub's `Merge pull request #12 from …` subject, a squashed `… (#12)` subject,
  or a `refs/pull/12/…` ref a repository has fetched — each wears a `#12` chip.
- **Ref chips** for the branch `HEAD` points at, tags and remotes, capped at two
  with a `+N` for the rest.
- **Nothing is measured.** A row is exactly **28px** and every coordinate comes
  from the lane index, so the rail runs straight through an expanded commit's
  detail and there is no `ResizeObserver` and no layout read anywhere in the
  bundle.
- **A Node half that has not been restarted still draws a line.** `parents` and
  `refs` arrived with the rail, so a browser bundle newer than the running host
  answers without them; the client then reads the list's own order as the parent
  chain - one continuous line, correct for the linear log such a host implies -
  rather than a rail of disconnected stubs. Restart `dsh web` to get the real
  graph (branches, merges and chips).

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-gittree` |
| `kind` / address | `gittree` / `sidebar://gittree` |
| `priority` | `builtin` |
| guide entry | **History**, `order: 30` — after Files (10) and Editor (20) |
| seats | the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` |
| services | `slots` + the bar's `sidebarRightTabs` (nothing else) |

The tab strip's **"+"** opens the Start page; picking **History** creates (or
reveals) the page tab.

A **file row inside a commit** calls the tab record's own `openResource` action
with a `dsh-resource://file/session/<sessionId>/<path>` address and **no
options** — the identical call the Files tab makes — so the registry's ranking
decides what claims the file: the pack's editor for text, a shipped preview for
an image or a PDF. The History tab stays open beside it.

## What it shows

- The **file bar**: the branch (or `(detached)`), the short **HEAD** commit — the
  current commit — `↑ahead`/`↓behind` when there is an upstream, how many files
  git reports as changed, and the version marker (`dsh-gittree 0.1.0-alpha.5`)
  that makes a freshly loaded bundle easy to verify.
- The **toolbar**: the tab's own **top bar**, carrying the workspace scope and
  **Reload** in a **38px** `box-sizing:border-box` row (24px control inside). It
  is the same box the shipped Files tab and the document preview use, so the
  pane's first hairline lands on the **y=76** line the 38px docking strip, the
  conversation header (`min-height:76px`) and the left column's branding band all
  end on.
- The **commit list**: `short sha`, the pull-request chip and the ref chips, the
  subject, and the author and date, newest first, up to 80 commits per load — each
  beside its rail. The chip strip is capped (and the pull request sits first), so a
  narrow pane clips the least important ref rather than the subject. The toolbar's
  **Reload** refetches the bar and the list.
- **A picked commit** opens in place (no navigation, no new tab): its full id,
  author, date, message body, and the files it touched with `M`/`A`/`D`/`R`/`C`/`T`
  badges.
- An **empty** repository (no commits yet) and a workspace with no commit of its
  own are told apart from a failure: the panel says which.

There is no working-tree file listing and no viewer switcher here: the Files tab
browses the folder and the editor opens what a commit row points at.

## The read-only routes (Node half)

The browser cannot read a repository, so the row owns three authenticated
`connection.fetch` routes under `/api/dsh-gittree/*` — the same mechanism
`dsh-editor` uses:

| Route | Git behind it | Answers |
|---|---|---|
| `GET /api/dsh-gittree/state?session=<id>` | `rev-parse --show-toplevel`, `status --porcelain=v2 -z --untracked-files=all --branch`, `ls-files -z`, `rev-parse --short HEAD` | `{ root, repoRoot, scope, branch, head, detached, upstream, ahead, behind, entries, total, changed, truncated }` |
| `GET /api/dsh-gittree/state?session=<id>&brief=1` | the same branch/status/HEAD calls, **without** `ls-files` or the entry merge | `{ brief: true, root, repoRoot, scope, branch, head, detached, upstream, ahead, behind, changed }` — what the tab's bar shows, and nothing else |
| `GET /api/dsh-gittree/history?session=<id>&limit=N` | `log -n N --date=short --decorate=short --pretty=format:…%P…%D` (scoped to the workspace when it is a subfolder) | `{ commits: [{ sha, short, author, date, subject, parents, refs, merge }] }` — `parents` is `%P` and `refs` is `%D`, which is what the rail's graph and its chips are drawn from |
| `GET /api/dsh-gittree/commit?session=<id>&sha=<id>` | `show -s --pretty=format:…` + `diff-tree --root --no-commit-id --name-status -r -z` | `{ commit: { sha, short, author, email, date, subject, body }, files: [{ status, path, origPath? }] }` |

The tab itself uses **`brief=1`** (the bar never needs a file list), so a GUI that
is showing history never pays for `ls-files` or the entry merge; the full form
remains for anything that wants the tree, and the tracked check covers both.

Design points worth keeping:

- **The session id is the only input.** The workspace root is resolved host-side —
  live session header first, session persistence second, a typed `NO_WORKSPACE`
  otherwise — exactly like `dsh-editor`. The client never names a path on disk.
- **Scope.** When the conversation folder sits *inside* a repository (a monorepo
  package, a session opened on a subdirectory), the history is scoped to that
  folder and every path is reported workspace-relative, so a row click is handed
  straight to the file-address grammar. Both sides of that comparison go through
  `realpath`, because git reports the resolved path while a session header can
  carry a Windows 8.3 short path (`LUISAR~1`) or a symlinked path.
- **Parsed, not string-matched.** `status --porcelain=v2 -z` is walked as
  NUL-separated tokens (a rename's source path is the *next* token; paths may
  contain spaces), and `diff-tree -z` yields `STATUS\0path\0` pairs. `--root` is
  what makes a repository's first commit list its files at all.
- **No shell, no injection, no holes.** git is spawned with an argv array and no
  shell; every argument is a literal in `lib/index.js` plus, at most, a commit id
  that must match `/^[0-9a-fA-F]{4,40}$/` before it can reach argv, so `--all` or
  any other option is rejected as `BAD_REQUEST`. The environment is pinned
  (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `--no-pager`), the
  call is killed after 10 s and its output capped at 8 MiB, and a failure is
  typed (`NOT_A_REPO`, `GIT_MISSING`, `TIMEOUT`, `TOO_LARGE`, `GIT_FAILED`).
- **Every request carries a token, never an effect cleanup.** Each `useRef` token
  is bumped per request and an answer is applied only while it is still the
  newest one, so a re-render cannot cancel an in-flight request and two racing
  answers cannot overwrite each other.
- **Lazy.** Nothing runs until the tab is shown, and the route responses are
  `no-store`.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'gittree' row (nothing else patched)
lib/index.js       Node half: the read-only /api/dsh-gittree routes above
lib/client.js      Browser half: the page tab type + guide entry, the commit list
                   with its rail, and a commit's detail (module-table bundle, no
                   build step). Its pure half - `graphLayout`, `pullRequestOf`,
                   `refChips` - is exported as `__internals` for the tracked check.
```

Nothing is forked and no core row is disabled: this package **adds** surface, so
`scripts/sync-vendored.ps1` has nothing to keep in sync.

## Verification

`scripts/checks/check-node-routes.mjs` drives these routes against a **real
scratch repository** it creates (init → commit → modify → untracked → a workspace
that is a subfolder → a branch → a `--no-ff` merge → a tag), asserting the scope,
the status codes, the brief form, the root commit's file list, the option-injection
guard **and the graph fields** (a merge's two parents, the ref `HEAD` points at, a
tag ref, and a root commit with no parents) — and skips loudly without `git`.
`scripts/checks/check-client-bundles.mjs` loads the browser half through the module
table and a real React runtime and checks the registration, the guide order, the
38px top bar, the history-only body, the chip title — plus the rail: the lane
layout of a linear history and of a merge, the pull-request and ref chip readings,
that the CSS row box matches the constant the rail's geometry is derived from,
that the bundle measures nothing, and the rendered rail of a four-commit merge
(one rail per row, the hollow merge node, both curves, the node on the lane's
centre line, the `#12` chip).

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux, plus
the uninstall twins) auto-discovers this package — it is a standard
`dsh.bundle`. Adding a package changes the profile's bundle set, so the first
install after it appeared needs one plain launcher run (or `-Force`). The web
profile links it into this repo, so code edits only need a restart of
`npx @deepseek-ai/dsh web` plus a hard browser refresh. **git must be on `PATH`**
for the routes to answer; without it the tab says so (`GIT_MISSING`) instead of
failing silently.
