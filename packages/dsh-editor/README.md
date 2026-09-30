# dsh-editor (alpha.13)

**Editor** is a **tab type for the pack's right bar** (`dsh-rightbar` — the
right-hand column of the DeepSeek Harness web GUI, beside the **Start** page and
the **Files** tab that `dsh-rightbar-files` provides). It opens **text files
only** (strict UTF-8, binary is refused) — **Markdown included** — edits them with
a vendored **CodeMirror 6**, starts **blank documents** from the tab strip's "+",
names and creates new files through the shared **`dsh-modal`** dialog, and saves
them back to disk. It is a **sub-plugin**: it holds no bar code, and its
host-side half owns the pack's own HTTP routes. Alpha.

## What it does

- **The editor is a tab type in the right bar.** It registers through the bar's
  own tab-type registry (`ctx.sidebarRightTabs.register`, provided by
  `dsh-rightbar`) with the id `dsh-editor` and the kind `editor`, and its body
  and chip title register under that same id in the keyed
  `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats. There is no
  private dock, no header capsule and no window bridge.

- **Text files open editable.** The type declares `dsh-resource://file/**` in
  the **`extension`** priority band, which outranks every viewer the product
  ships, and vetoes in `canOpen`:
  - what a text editor has nothing to add to (`.html`, images, PDF,
    office/archive/media and binary extensions) — those keep their own preview
    tab;
  - paths outside the session workspace (including the authorizing-less
    `absolute/…` addresses).
  So clicking a `.ts`, `.json`, `.py`, `.txt`, `.md` … in the Files tree opens it
  in the editor; clicking a `.png` or a `.pdf` opens the shipped preview as
  before.

- **Markdown is claimed too.** `.md` / `.markdown` / `.mdown` are text, so the
  editor opens them as highlighted documents — edit them, save them, and the file
  on disk is what changes. The toolbar's **Preview** button (shown while a
  Markdown file is open) names the shipped document-preview type
  (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, whose *kind* is read from
  the tab registry, never hardcoded) and asks the right bar's controller
  (`ctx.get('sidebarRight')`) to open the same address there, **replacing the
  editor tab** — so Edit ⇄ Preview is one tab that cannot drift from the file it
  names. Refused while the document has unsaved edits: the preview reads the file
  from disk, and showing the older text silently would be a lie.

- **"+" → Editor opens a BLANK document.** The package contributes a guide entry
  (`order: 20`), so the tab strip's "+" control offers **Editor**. Picking it
  creates an editor tab on an empty, unnamed document: nothing is read from disk
  and the tab holds no workspace browser. The file bar reads *Untitled* and
  **Save** is always offered.

- **Saving a blank document names it.** Save (or Ctrl+S) opens the pack's shared
  dialog (`dsh-modal`'s `modals` service) asking for the **file name with its
  extension** — a relative path such as `notes.md` or `src/app.ts`, created in
  **this conversation's workspace folder** (the same place the tab was opened
  from); the folder must already exist. The dialog validates the name (an
  extension is required, dotfiles excepted; no absolute or `..` paths) and shows
  the server's answer **inside the dialog** when the name is taken
  (`409 EXISTS`), keeping what was typed. On success:
  - an ordinary text/code file (`.txt`, `.ts`, `.json`, `.py`, `.md`, …) becomes
    its own tab (`replaceTab`), so the chip shows the file name and every later
    save is an ordinary in-place save — exactly as if the file had been clicked in
    the Files tree;
  - an extension a shipped preview owns (`.html`, an image, a PDF, …) **stays in
    the editor**: the chip takes the file's name through the tab title store, and
    later saves go in place. The tab is deliberately not handed to the preview,
    because the preview cannot edit the file and this tab is the only place that
    can.
  Without `dsh-modal` mounted the dialog falls back to the browser's own prompt.

- **The panel.** CodeMirror 6 with line numbers, history/undo, bracket matching,
  autocomplete and find-in-file, plus line-wrapping for prose-ish files (`.md`,
  `.txt`, `.log`, `.csv`, dotfiles and extensionless names). The toolbar is the
  tab's own top bar — the same **38px** `box-sizing:border-box` box the Files and
  preview headers use, ending on the one hairline at **y=76** that all three
  columns share — carrying a find-in-file input, **Preview** and **Save**. Save is
  offered for an unnamed document at all times and for an open file while it is
  modified; **Ctrl/Cmd+S** works inside the editor. The chip of a tab with
  unsaved work carries a dot.

- **Saving is optimistic and atomic.** The panel PUTs the whole document with the
  mtime/size it opened with; the server re-checks containment and writes a temp
  file renamed over the target. If the file changed on disk meanwhile the panel
  offers **Reload** / **Save anyway** instead of silently clobbering.

- **Unsaved edits are not persisted** across tab closes or app restarts — save
  before closing a tab.

### The language map

Every extension is mapped in `languageExtensionFor`, and every lookup goes
through a guard.

| Extensions | Language | Engine shape |
|---|---|---|
| `js` `mjs` `cjs` (and `jsx`, `ts`, `tsx`, each with its own flags) | javascript | Lezer factory |
| `json` `jsonc` | json | Lezer factory |
| `md` `markdown` `mdown` | markdown | Lezer factory |
| `py` `pyw` | python | Lezer factory |
| `html` `htm` `xhtml` | html | Lezer factory |
| `css` | css | Lezer factory |
| `yaml` `yml` | yaml | Lezer factory |
| `sh` `bash` `zsh` `ksh` `dash` | `shell` | StreamParser object |
| `ps1` `psm1` `psd1` | `powerShell` | StreamParser object |
| `bat` `cmd` | `batch` | StreamParser object |
| `rs` | `rust` | StreamParser object |
| `toml` | `toml` | StreamParser object |

The Lezer half comes from the vendored CodeMirror build. The stream half has no
Lezer parser at all: `shell` and `powerShell` come from the vendored
`@codemirror/legacy-modes`, and `batch` comes from the pack's own hand-written
**`vendor/batch-mode.js`**, because neither CM5 nor CM6 ever shipped one. All
five are wrapped by the vendored `StreamLanguage`, and their CM5 token names are
the vocabulary StreamLanguage maps onto highlight tags, so
`defaultHighlightStyle` (light) and oneDark (dark) colour them from the same tags
they colour a `.js` with. A file with no mapping opens editable and unhighlighted.

### Two engine shapes, two guarded lookups

The vendored engine is ONE generated artifact on ONE route, and a client bundle
newer than the loaded engine can ask for a language the engine does not carry.
Both shapes of that are fatal without a guard — a Lezer factory that is not a
function at all (`CM.yaml is not a function`), and `StreamLanguage.define(undefined)`,
which dereferences what it was handed — so a document that opens unhighlighted
beats a tab that cannot open at all.

The engine answers in two SHAPES, so there are **two lookups**:

- **`engineLanguage(CM, name)`** wants a Lezer factory — a **function**
  (`CM.javascript(options)`) — and covers the seven Lezer languages in the map;
- **`engineStreamMode(CM, name)`** wants the **StreamParser OBJECT** a CM5-style
  legacy mode is, found by its `token()` method rather than a
  `typeof === 'function'` test, and covers `shell`, `powerShell`, `batch`, `rust`
  and `toml`.

Each returns `null` plus **one console warning** naming the missing factory when
the loaded engine lacks the name; `lezerLanguage` builds through the first and
`streamLanguage` wraps a stream mode through the second, so
`languageExtensionFor` contains **no direct `CM.<name>(...)` call at all**. An
older engine therefore degrades a document to no highlighting instead of killing
the tab.

### The engine and the bundle are kept in step

Because that guard is the last line of defence, the artifact itself is kept fresh
too:

- the request is **version-qualified** (`/api/dsh-editor/vendor?v=<bundle version>`),
  so a new bundle is a new request instead of a cache hit;
- the route answers **`cache-control: no-cache`** over a **content-hash ETag** —
  the artifact is generated at a stable URL, so revalidation is a 304, never a
  re-download;
- the route **re-`stat`s** the artifact per request and re-reads it when it
  changed, so a rebuild or a `git pull` needs no harness restart;
- **HEAD** answers the same headers with no body.

When a mode is missing anyway, the warning names the **rebuild** command
(`packages/dsh-editor/vendor`, the esbuild line below) and says a restart of
`dsh web` neither helps nor is needed.

### The palette follows the app's theme

CodeMirror needs a palette of its own: the surface configures **oneDark only
while the app is dark** and a transparent, token-driven light layer while it is
light — the light layer leaves the panel's `--dsw-*` tokens visible instead of
painting a white canvas of its own. The document text colour is
`--dsw-alias-label-primary` in both modes, which is what keeps a file with **no
syntax language** (`.gitignore`, `.txt`, `.log`, …) readable.

The switch is live, with no reopening of the file: a CodeMirror **`Compartment`**
is reconfigured off the shipped `theme` service (`ctx.get('theme')` and its
`theme/change` event), with **`body[data-ds-dark-theme]`** watched as the
fallback for a profile that never mounts ui-theme. Both are resolved lazily — the
editor never hard-depends on the theme package.

### The rendered Markdown page

This package registers the rendered Markdown **document body** itself — the keyed
**`sidebar.right.tab.document`** slot, keyed by the shipped preview's own
Markdown implementation id, at **`priority: -10`**. That is the slot system's
shadowing rule (*lowest renders*): only the page body is ours, and the shipped
preview keeps its metadata, paging, wrap and reload chrome. Uninstalling this
package brings the shipped body back with no residue.

- The body draws a sticky **Edit** button which hands the same file straight back
  to the editor, replacing the preview tab — Editor → **Preview** → **Edit** →
  Editor, one tab, same file.
- The body lives inside the preview's scrollport, which is built for the
  **plain-text** renderer: `[data-textpreview-body]` declares `white-space:pre`
  and a monospace font stack, and this package's wrapper **undoes both** —
  `white-space:normal`, so a source newline is a soft break again and blank lines
  collapse into paragraph spacing instead of rendering as full empty lines.
- The **Edit** pill wears the app's UI font (`--dsw-font-family`) instead of
  inheriting the mono face.

## How the write path works (no core patches)

The browser cannot write files on this dsh line: `remote.workspaceFiles` reads
files and lists folders but exposes **no mutation operation**. Mirroring the
shipped `dsh-session-log-export` plugin, the Node half registers
**authenticated routes** through the `connection` service:

| Route | What it does |
|---|---|
| `GET /api/dsh-editor/file?session=<id>&path=<rel>` | read one text file (the host resolves the session's workspace root and containment-checks the path against it; strict UTF-8, no NUL; ≤ 2 MiB; HEAD answers the headers and no body) |
| `PUT /api/dsh-editor/file` | save one text file `{session, path, text, expected?: {mtimeMs, size}}` (atomic temp+rename; 409 when the file moved on disk) |
| `PUT /api/dsh-editor/file` with `{create: true}` | **create** a new file at `path` (the PARENT folder must exist inside the workspace and is realpath-checked; the target must not exist — `409 EXISTS`; published create-exclusive, so a create never overwrites a file the user did not open) |
| `GET /api/dsh-editor/vendor?v=<bundle version>` | serve the vendored CodeMirror 6 classic bundle (lazy; `cache-control: no-cache` + a content-hash ETag; re-`stat`ed per request so a rebuilt artifact needs no restart; HEAD answers no body) |

The session id is what the tab's address already carries
(`dsh-resource://file/session/<sessionId>/<path>`); the workspace root is
resolved **host-side** — live session header first, session persistence second,
exactly like `@deepseek-ai/dsh-api-workspace-files` resolves its own reads. The
client never names a root, and a session whose root cannot be resolved gets a
typed `NO_WORKSPACE` failure instead of a guess.

The engine is **lazy**: the vendored classic bundle (a script assigning
`window.DSHEditorCM`) is fetched the first time a file opens, so an idle GUI
never pays for the editor.

## Layout

```
cordis.patch.yml      bundle layer: inserts the 'editor' row (nothing else patched)
lib/index.js          Node half: the /api/dsh-editor routes above (read, save, create, vendor)
lib/client.js         Browser half: tab type + guide entry, body (blank document or an
                      open file), the save-as dialog over the `modals` service, the
                      Preview hand-off to the rendered Markdown view, and the title
                      with the dirty dot (module-table bundle)
lib/vendor/cm6.min.js GENERATED - the vendored CodeMirror 6 classic bundle
                      (IIFE on window.DSHEditorCM); commit it, do not edit by hand
vendor/entry.js       the CM6 build entry (Lezer languages, legacy modes, batch-mode.js)
vendor/batch-mode.js  the hand-written CM5-style batch mode for bat/cmd
vendor/package.json   pinned CM6 build inputs
```

The save-as dialog lives in [`packages/dsh-modal`](../dsh-modal): the editor
resolves the `modals` service **lazily** (`ctx.get('modals')` at save time) and
falls back to `window.prompt` when it is absent, so the editor never depends on
that package being installed. `dsh-modal` is not listed in this package's
`dsh.client.inject` on purpose — the dependency is a service lookup, not a module
load order.

**Preview** resolves two more services lazily, and neither is a hard dependency:
the right bar's controller (`ctx.get('sidebarRight')`) does the actual open, and
the tab registry (`ctx.get('sidebarRightTabs')`) is consulted for the **kind** the
shipped document preview registered under — so a harness line that renames that
kind keeps working, and a deployment without the preview type gets a clear
"Preview unavailable" instead of a dead button. The editor calls the controller
directly rather than going through the tab record's own `openResource` action,
which drops `kind`.

### Regenerating the vendored CodeMirror bundle

Only needed when the CM6 version set changes (not for plugin code edits). The
build runs anywhere Node does; only the last line's output path differs per OS:

```sh
cd packages/dsh-editor/vendor
npm install
npx --yes esbuild entry.js --bundle --minify --format=iife --global-name=DSHEditorCM \
  --target=es2020 --outfile=../lib/vendor/cm6.min.js
```

(On Windows use `..\lib\vendor\cm6.min.js` in the last argument.)

`lib/client.js` itself stays hand-written — no build step for normal edits.

## Install / uninstall

The repo launcher (`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle` — and so does the
uninstaller; nothing else changes. After a version bump, a plain launcher run
re-adds it; the web profile gets it as a live link, so code edits just need a
restart of `npx @deepseek-ai/dsh web` plus a hard refresh.
