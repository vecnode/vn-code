# dsh-gittree (alpha.5)

**A read-only git history tab for the pack's right bar, labelled History.** The package, row and address keep the `gittree` name; the capsule and chip say History. It is a page tab type - no `patterns`, so it never competes for a file address, `priority: 'builtin'` - with one guide entry at `order: 30` after Files (10) and Editor (20). It lists the conversation folder's commits (short id, subject, author, date, newest first) beside a rail that draws the commit graph and keeps the branch and current commit in the file bar. **Read-only is the point**: its only git subcommands are `rev-parse`, `status`, `ls-files`, `log`, `show` and `diff-tree` - nothing that writes.

## What it adds

- **The rail (the graph).** One forward pass over `git log` in its own order (a child always precedes its parent) from the `%P` parents and `%D` refs the history route carries. One column per branch lane: a commit takes the lane waiting for it or a free one, its first parent inherits that lane, each further parent - a merge - starts or joins another, and a parent outside the page ends the lane. A merge wears a larger hollow node, HEAD's commit a halo, and a merge naming a pull request (a PR-naming subject, a squashed `… (#12)`, a `refs/pull/12/…` ref) wears a `#12` chip; branch, tag and remote chips are capped at two plus `+N`.
- **Nothing is measured.** A row is exactly the 28px `ROW_HEIGHT` its stylesheet declares, so every coordinate comes from the lane index and the rail stays straight through an expanded commit's detail; no `ResizeObserver` and no `getBoundingClientRect`.
- **The list and a picked commit.** `short sha`, chips, subject, author and date, newest first, up to 80 commits per load; a commit opens in place with its full id, author, date, message body and files carrying `M`/`A`/`D`/`R`/`C`/`T` badges. The file bar carries the branch (or `(detached)`), the short HEAD, `↑ahead`/`↓behind` and the changed count.
- **A file row in a commit** opens through the ordinary `openResource` action on a `dsh-resource://file/session/<sessionId>/<path>` address with **no options** - the identical call the Files tab makes - so the registry decides what claims it.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind / address | `dsh-gittree` / `gittree` / `sidebar://gittree` |
| seats / services | `sidebar.right.pane.tab` / `.title`; `slots` and the bar's `sidebarRightTabs` |

Three authenticated `connection.fetch` routes, all read-only:

| Route | Git behind it |
|---|---|
| `GET /api/dsh-gittree/state?session=<id>` | `rev-parse --show-toplevel`, `status --porcelain=v2 -z --untracked-files=all --branch`, `ls-files -z`, `rev-parse --short HEAD` |
| `GET /api/dsh-gittree/state?session=<id>&brief=1` | the same calls without `ls-files` or the tree merge (what the bar shows) |
| `GET /api/dsh-gittree/history?session=<id>&limit=N` | `log -n N --date=short --decorate=short --pretty=format:…%P…%D…`, scoped to the workspace when it is a subfolder |
| `GET /api/dsh-gittree/commit?session=<id>&sha=<id>` | `show -s --pretty=format:…` + `diff-tree --root --no-commit-id --name-status -r -z` |

History answers `{ commits: [{ sha, short, author, date, subject, parents, refs, merge }] }`, defaults to 50 (ceiling 200); the full state carries at most 20 000 tree entries.

## Rules and limits

- **The session id is the only input.** The workspace root is resolved host-side (live session header, then session persistence; `NO_WORKSPACE` otherwise) and the client never names a path on disk. A conversation folder inside a repository is scoped to that folder with every path reported workspace-relative, and both sides go through `realpath` because a session header can carry a Windows 8.3 or symlinked path.
- **No shell, no injection.** `git` is spawned with an argv array and no shell; every argument is a literal plus, at most, a commit id matching `/^[0-9a-fA-F]{4,40}$/` before it can reach argv, so any option is rejected as `BAD_REQUEST`. The environment is pinned (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `--no-pager`), calls are killed after **10 s**, output is capped at **8 MiB**, and failures are typed (`NOT_A_REPO`, `GIT_MISSING`, `TIMEOUT`, `TOO_LARGE`, `GIT_FAILED`).
- **Parsed, not string-matched.** `status --porcelain=v2 -z` is walked as NUL-separated tokens (a rename's source is the next token) and `diff-tree -z` yields `STATUS\0path\0` pairs; `--root` makes a root commit list its files.
- **Every request carries a `useRef` token**, never an effect cleanup, so a re-render cannot cancel an in-flight request and racing answers cannot overwrite each other. Responses are `no-store`, and nothing runs until the tab is shown. Nothing is forked and no core row is disabled. **git must be on `PATH`**; without it the tab says `GIT_MISSING`.

## Verify

```
node scripts/checks/check-node-routes.mjs
node scripts/checks/check-client-bundles.mjs
```

`check-node-routes.mjs` drives the routes against a real scratch repository and asserts the scope, the status codes, the brief form, the option-injection guard and the graph fields, skipping loudly without `git`; `check-client-bundles.mjs` checks the registration, the guide order, the CSS row box against the rail's constant, and that the bundle measures nothing.

## Install

The launcher (`scripts\install.bat` / `./scripts/install.sh`) auto-discovers it as a standard `dsh.bundle`; the first install after it appeared needs one plain launcher run (or `-Force`). Edits need a restart of `npx @deepseek-ai/dsh web` plus a hard refresh.
