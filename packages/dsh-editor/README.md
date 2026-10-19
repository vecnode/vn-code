# dsh-editor (alpha.14)

**A CodeMirror 6 tab type for the pack's right bar (`dsh-rightbar`) that opens text files editable.** It registers the id `dsh-editor` and the kind `editor` through the bar's own tab-type registry, with its body and chip title in the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats and a guide entry at `order: 20` for the "+" control. It is text-only (strict UTF-8, binary refused), starts blank documents, and writes through authenticated Node routes because `remote.workspaceFiles` exposes no mutation operation.

## What it adds

- **Text files open editable.** `patterns: ['dsh-resource://file/**']` in the `extension` band, which outranks every shipped viewer, with a `canOpen` that vetoes what a text editor has nothing to add to (`.html`, images, PDF, office/archive/media, binary) and paths outside the session workspace, including the session-less `absolute/…` form.
- **Markdown is claimed too** (`.md`, `.markdown`, `.mdown`). The toolbar's **Preview** button reads the shipped document preview's kind out of the tab registry (never hardcoded) and calls `ctx.get('sidebarRight').openResource(address, { kind, replaceTab })`, so Edit ⇄ Preview is one tab on the same file. It is refused while the document has unsaved edits, because the preview reads from disk.
- **"+" → Editor opens a blank document.** Save (or Ctrl/Cmd+S) asks for the file name **with its extension** through the shared `dsh-modal` `modals` service and **creates** it in the conversation's workspace folder; the parent folder must already exist and a taken name answers `409 EXISTS` inside the dialog.
- **Saving is optimistic and atomic.** The panel PUTs the whole document with the mtime/size it opened with, and a file that moved on disk offers **Reload** / **Save anyway** rather than a silent clobber. Unsaved work is lost on tab close or restart.
- **The language map.** Every extension is mapped in `languageExtensionFor` and every lookup goes through a guard, so an engine older than the bundle opens the document unhighlighted rather than killing the tab. Lezer factories (function shape) via `engineLanguage` cover javascript (js/mjs/cjs/jsx/ts/tsx), json (json/jsonc), markdown (md/markdown/mdown), python (py/pyw), html (html/htm/xhtml), css and yaml (yaml/yml). CM5-style **StreamParser objects** (found by their `token()`, via `engineStreamMode`) cover shell (sh/bash/zsh/ksh/dash), powerShell (ps1/psm1/psd1), batch (bat/cmd, from the pack's own `vendor/batch-mode.js`), rust (rs) and toml (toml) from the vendored `@codemirror/legacy-modes`. Each returns `null` plus one console warning naming the missing factory and the rebuild command, so `languageExtensionFor` has no direct `CM.<name>(...)` call.
- **The palette follows the app's theme**: **oneDark only while the app is dark**, a token-driven transparent light layer otherwise, switched live through a CodeMirror `Compartment` reconfigured off `ctx.get('theme')` / `theme/change`, with `body[data-ds-dark-theme]` as the fallback. Both theme services are resolved lazily.
- **The rendered Markdown body is shadowed.** The keyed `sidebar.right.tab.document` slot is registered at `priority: -10` (lowest renders), so only the page body is this package's while the shipped preview keeps its chrome; uninstalling brings the shipped body back. That body carries an **Edit** pill back to the editor and undoes what the preview's plain-text scrollport imposes (`white-space:pre` and the mono stack).
- **Authored HTML is rendered, and images resolve (alpha.14).** The shipped Markdown primitive draws raw HTML as literal text and only resolves an image when it is handed a `pathImages` vocabulary, so a README with a centred badge row, a `<table>`, `<details>` or `![shot](docs/shot.png)` showed its own markup and broken pictures. The shadow body now parses **block-level HTML** itself and rebuilds it as **React elements over an allowlist** — nothing becomes an HTML string, so there is no `innerHTML` to poison and no attribute spelling that can smuggle an `onerror=` through: `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, form controls and SVG are dropped **with their contents**, every `on*` attribute is refused, a `javascript:` URL is refused, and an unknown structural tag loses the tag but keeps its children. **Images** resolve through the harness's authenticated `/api/file?path=` route, against the **document's own absolute path** (read off the resource, the same way the shipped body does), for a Markdown image and for an `<img src>` inside authored HTML alike; an absolute `http(s)` image is left exactly as written, and a source the route cannot vouch for degrades to its alt text. A fenced code block is never split, so an example's `<div>` still renders as code.

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
- The HTML allowlist draws **block-level** authored markup: a line that starts with an allowed tag opens an HTML run, so `<kbd>` in the middle of a prose sentence is still the shipped renderer's literal text. An unclosed block with no closing line anywhere below it stays Markdown rather than swallowing every section after it.
- A **container** holds Markdown and HTML alike: `<div align="center">` on its own line, a blank line, then `# Title` draws the title as an `h1` **inside** the div, which is what GitHub does (CommonMark ends an HTML block at the blank line, and the browser nests what follows in the element still open). Only one element left open, closed on a line of its own, becomes a container; anything else - several elements open at once, a dropped tag like `<svg>`, no closing line - keeps the conservative fallback and renders as literal Markdown.

## Verify

```
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

`check-client-bundles.mjs` drives the browser half through a real React runtime: the registration and guide order, the seats, the shadowed document body, the language-map guard, the Preview hand-off, the authored-HTML splitter (fenced examples excluded, an unclosed block left as Markdown, a div holding a heading drawn as a container), the allowlist (a `<script>` dropped with its contents, `onerror` and `javascript:` refused, no HTML string injected) and the image resolver (a relative destination rewritten to `/api/file?path=`, an `http` one left alone, an unresolvable one left as alt text). It also renders **this repository's own README header** and asserts that the title reaches the Markdown renderer as a heading inside the centred div, because that is the first thing a reader sees in the pane. `check-node-routes.mjs` drives the routes against a scratch workspace.

## Install

The launcher (`scripts\setup\install.bat` / `./scripts/setup/install.sh`) auto-discovers the package as a standard `dsh.bundle`, and the uninstall twins do the same. It is a live link in the web profile, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard refresh.
