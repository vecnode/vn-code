# dsh-rightbar-files (alpha.1)

**The right bar's Files tab** — the session workspace tree (directories expand in place, one level at a time, over the `remote.workspaceFiles` namespace) as a tab type of the pack's own bar.

`lib/client.js` is a byte-for-byte copy of the shipped `@deepseek-ai/dsh-client-ui-sidebar-files` bundle with the module-table id rewritten to `dsh-rightbar-files`. The core row it forks is disabled by `dsh-rightbar`'s bundle layer, so this copy is the one that runs.

## What it adds

One tab type into `ctx.sidebarRightTabs`, plus its body and title under the same key:

| Piece | Value |
|---|---|
| `id` / slot key | `@deepseek-ai/dsh-client-ui-sidebar-files` — deliberately the **core** id: the sync script rewrites the module-table id (so the boot graph loads this file) and leaves `FILES_ID` alone, so the type keeps its identity across the fork and the shipped document preview keeps resolving the same key |
| `kind` | `files` |
| `priority` | `builtin` |
| `guide` | one entry, `order: 10` — "Files" on the Start page the "+" control opens |
| body | the tree; a file row opens `dsh-resource://file/session/<sessionId>/<path>` through `tabActions.openResource`, so the registry routes it to whichever type claims it |

## How it plugs in

`cordis.patch.yml` inserts the `rightbar-files` row and patches nothing else — the `ui-sidebar-files` row it replaces is disabled by `dsh-rightbar`. `package.json`'s `dsh.client.inject` names `dsh-rightbar` (not the core package), so the bar's module is ordered before this one, and the bar is already in the tree when the tab type registers into it.

## Limits

The tab's identity is the **core** id on purpose; changing `FILES_ID` would orphan persisted Files tabs and break the document preview's key resolution. `lib/client.js` is a fork: re-sync it, never hand-edit it.

## Verify

```sh
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'rightbar-files' row
lib/index.js       Node half: no-op row so the browser bundle ships
lib/client.js      GENERATED vendored Files tab (do not edit; re-sync instead)
```
