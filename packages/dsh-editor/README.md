# dsh-editor (alpha.13)

**A CodeMirror 6 tab type for the pack's right bar (`dsh-rightbar`) that opens text files editable.** It registers the id `dsh-editor` and the kind `editor` through the bar's own tab-type registry, with its body and chip title in the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats and a guide entry at `order: 20` for the "+" control. It is text-only (strict UTF-8, binary refused), starts blank documents, and writes through authenticated Node routes because `remote.workspaceFiles` exposes no mutation operation.

## What it adds

- **Text files open editable.** `patterns: ['dsh-resource://file/**']` in the `extension` band, which outranks every shipped viewer, with a `canOpen` that vetoes what a text editor has nothing to add to (`.html`, images, PDF, office/archive/media, binary) and paths outside the session workspace, including the session-less `absolute/…` form.
- **Markdown is claimed too** (`.md`, `.markdown`, `.mdown`). The toolbar's **Preview** button reads the shipped document preview's kind out of the tab registry (never hardcoded) and calls `ctx.get('sidebarRight').openResource(address, { kind, replaceTab })`, so Edit ⇄ Preview is one tab on the same file. It is refused while the document has unsaved edits, because the preview reads from disk.
- **"+" → Editor opens a blank document.** Save (or Ctrl/Cmd+S) asks for the file name **with its extension** through the shared `dsh-modal` `modals` service and **creates** it in the conversation's workspace folder; the parent folder must already exist and a taken name answers `409 EXISTS` inside the dialog.
- **Saving is optimistic and atomic.** The panel PUTs the whole document with the mtime/size it opened with, and a file that moved on disk offers **Reload** / **Save anyway** rather than a silent clobber. Unsaved work is lost on tab close or restart.
- **The language map.** Every extension is mapped in `languageExtensionFor` and every lookup goes through a guard, so an engine older than the bundle opens the document unhighlighted rather than killing the tab. Lezer factories (function shape) via `engineLanguage` cover javascript (js/mjs/cjs/jsx/ts/tsx), json (json/jsonc), markdown (md/markdown/mdown), python (py/pyw), html (html/htm/xhtml), css and yaml (yaml/yml). CM5-style **StreamParser objects** (found by their `token()`, via `engineStreamMode`) cover shell (sh/bash/zsh/ksh/dash), powerShell (ps1/psm1/psd1), batch (bat/cmd, from the pack's own `vendor/batch-mode.js`), rust (rs) and toml (toml) from the vendored `@codemirror/legacy-modes`. Each returns `null` plus one console warning naming the missing factory and the rebuild command, so `languageExtensionFor` has no direct `CM.<name>(...)` call.
- **The palette follows the app's theme**: **oneDark only while the app is dark**, a token-driven transparent light layer otherwise, switched live through a CodeMirror `Compartment` reconfigured off `ctx.get('theme')` / `theme/change`, with `body[data-ds-dark-theme]` as the fallback. Both theme services are resolved lazily.
- **The rendered Markdown body is shadowed.** The keyed `sidebar.right.tab.document` slot is registered at `priority: -10` (lowest renders), so only the page body is this package's while the shipped preview keeps its chrome; uninstalling brings the shipped body back. That body carries an **Edit** pill back to the editor and undoes what the preview's plain-text scrollport imposes (`white-space:pre` and the mono stack).

## How it plugs in

| Route | What it does |
|---|---|
| `GET /api/dsh-editor/file?session=<id>&path=<rel>` | read one text file (strict UTF-8, no NUL, ≤ 2 MiB; HEAD answers headers and no body) |
| `PUT /api/dsh-editor/file` | save `{session, path, text, expected?: {mtimeMs, size}}` - atomic temp+rename, `409` when the file moved on disk |
| `PUT /api/dsh-editor/file` with `{create: true}` | create a file: the parent must exist inside the workspace and is realpath-checked, the target must not exist - `409 EXISTS`, create-exclusive |
| `GET /api/dsh-editor/vendor?v=<bundle version>` | the vendored CodeMirror 6 classic bundle (`window.DSHEditorCM`), fetched lazily on first open |

The workspace root is resolved host-side (live session header first, session persistence second, typed `NO_WORKSPACE` otherwise) from the `session` id the tab's address already carries, `dsh-resource://file/session/<sessionId>/<path>`; the client never names a root. The engine request is version-qualified, and the route answers `cache-control: no-cache` over a content-hash ETag, re-`stat`ing the artifact per request, so a rebuild needs no restart.

## Limits

- Text only: strict UTF-8, no NUL, ≤ 2 MiB read and save.
- No folder browser and no binary editing; `canOpen` refuses any address outside a session workspace.
- Create-on-save, never overwrite: a create is create-exclusive.
- Unsaved work is lost on tab close or restart.

## Verify

```
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

`check-client-bundles.mjs` drives the browser half through a real React runtime: the registration and guide order, the seats, the shadowed document body, the language-map guard and the Preview hand-off. `check-node-routes.mjs` drives the routes against a scratch workspace.

## Install

The launcher (`scripts\install.bat` / `./scripts/install.sh`) auto-discovers the package as a standard `dsh.bundle`, and the uninstall twins do the same. It is a live link in the web profile, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard refresh.
