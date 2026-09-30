# Compatibility

The pack targets the harness line DeepSeek ships to the raw web install
(`npx @deepseek-ai/dsh web`). DSH Desktop is not supported by this pack.

## Current pin

| | |
|---|---|
| `@deepseek-ai/dsh` | `0.2.0-rc.2` |
| Forked from | the same `0.2.0-rc.2` line (`.dsh-version.json`'s `vendoredFrom`) |
| Install target | the web profile only (`$DSH_HOME/profiles/web`) |
| Host platforms | Windows (PowerShell 5.1 or 7) and macOS / Linux (POSIX shell + Node.js and npm/npx - no PowerShell); the plugins themselves are plain JS and the only OS-specific code is a launcher choosing the host command: the file-browser launcher (`explorer.exe` / `open` / `xdg-open`) and the run launchers' browser hand-off (Chrome, else the platform default) |
| Master | **`dsh-vn-master`** - the bundle layer plus one no-op `master` row; no client half, no service, no inject edge and no core-row disables. Carries the pack's row restatements, and alpha.2 enables the shipped **Browser** tab on the web profile (`ui-sidebar-browser`) |
| Right bar | **owned by the pack** - `dsh-rightbar` / `dsh-rightbar-files` are forks of `@deepseek-ai/dsh-client-ui-sidebar-right` / `-sidebar-files`, and the core rows `ui-sidebar-right` / `ui-sidebar-files` are disabled |
| Open In file managers | **owned by the pack** - `dsh-open-in-app` forks `@deepseek-ai/dsh-client-ui-open-in-app` (row `ui-open-in-app` disabled) and launches the OS file browser directly |
| Session log download | **the seat is the pack's** - `dsh-themes` alpha.9 shadows the shipped header seat (same occupant id, `priority: -10`), so a plain download icon replaces the three-dot button; the shipped `session-log-download` row stays **mounted** for `/api/session.export`, the `/export` command and the `sessionLogDownload` controller the button drives (no row disabled, nothing forked, no new package) |
| Header icon rings | the header's icon buttons all wear the same `.5px` round outline: the pack's own controls draw it themselves and `dsh-themes` adds one rule for the right bar's toggle in the header corner (keyed on the stable `data-conversation-header-corner` marker) |
| Media on each host | `dsh-media` resolves ffmpeg from `PATH` first, so a machine that already has it needs nothing - and nothing is downloaded there. Where it does not, one pinned static build per platform-arch is provisioned into `$DSH_HOME/dsh-media/bin`: **win32 x64/arm64** and **linux x64/arm64** from BtbN/FFmpeg-Builds (LGPL static), **darwin x64** from evermeet.cx (GPL). Unpacking uses the host's own `tar` (bsdtar on Windows 10+ and macOS, GNU tar on Linux), which is the one external tool that must exist. **darwin-arm64 is deliberately unpinned** - no Apple-Silicon build publishes both a versioned URL and a checksum - so there it is `brew install ffmpeg` or `DSH_MEDIA_FFMPEG`/`DSH_MEDIA_FFPROBE`, and the plugin says so in a sentence instead of guessing at a download |
| Window screenshot | **the pack's** - `dsh-themes` alpha.10 adds a Screenshot control (order `-30`, left of Themes): the browser captures the current tab (`getDisplayMedia`, real pixels, so the terminal's xterm canvas and open dialogs are included) and the pack's own host route `POST /api/dsh-themes/screenshot` writes the PNG to the host's Desktop as `vncode-<timestamp>.png` (browser download as the fallback); no shipped row is touched |

## Running the app

The pack ships its own launcher next to the installers - one entry point per
platform, `scripts\run-web.bat` (Windows, double-click it) and `scripts/run-web.sh` (macOS/Linux), both
in `scripts/` with the workers and the console layer - so starting the GUI is one command instead of remembering the
command line. On Windows the entry point is a batch wrapper and the work is in
`scripts/run-web.ps1`, because cmd cannot watch a running child's output (its
`for /f` reads only up to EOF); `scripts/run-web.sh` does the whole job itself. Both run the
same pinned invocation the docs use -
`npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]` - and then:

- stream the app's own output to the terminal (nothing is filtered), watching for
  the ready line `dsh web: http://127.0.0.1:<port>/?token=<launch token>`;
- open **that** URL, token included, in **Google Chrome** - found on `PATH`, in
  the standard install folders or through Windows' `App Paths` registry entry,
  `/Applications/Google Chrome.app` on macOS, `google-chrome`/`chromium` on Linux
  - and fall back to the platform's **default browser** when Chrome is absent;
- refuse to open anything that is not a loopback address (`127.0.0.1`, `::1`,
  `localhost`), because the query carries the process's launch token;
- keep the harness in the foreground: Ctrl+C stops it, and the terminal reports
  the app's own exit status.

Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion <ver>`, `-NoBrowser`
(start the server only) and `-DefaultBrowser` (skip Chrome). On Windows the
launcher is `scripts\run-web.bat [flags]` (double-click friendly, no execution-policy
question, because the entry point is batch). The launch token is
never written to a file: the POSIX half pipes the app's output through an
anonymous FIFO and both halves keep the token in memory. It reaches the browser as
a single argv element - `Start-Process -ArgumentList` on Windows, an argument of
`open`/`xdg-open` on macOS/Linux - never through a command string; SECURITY.md has
the details.

## What this means for the plugin

- **dsh-vn-master** is the pack's browser-free master: one no-op `master` row plus
  the bundle layer, no `dsh.client`, no service, no `inject` edge and no core-row
  disables. It is installed last (its name sorts last and `dsh plugin add`
  appends), so it is the profile's final layer - the slot for pack-wide patches,
  and the slot a RESTATEMENT of a shipped row belongs in. Because it publishes and
  consumes nothing, it cannot enter or disturb the right bar's tab-type chain.
  alpha.2 uses that slot once: the shipped **Browser** tab is desktop-only in 0.2
  (`dsh-web-app` declares `ui-sidebar-browser` with
  `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`) while this
  pack targets the raw web profile, so the master's `cordis.patch.yml` restates
  that one row as `disabled: false`. A later layer wins per row, and the browser
  package then registers its tab type AND its own Start-page guide entry into
  `sidebarRightTabs` - the same registry the pack's own types use - so the tab is
  listed on **Start** without any pack code drawing that entry.
- **dsh-rightbar** provides the right bar (chrome, docking panel, expand button,
  Start page) and the `sidebarRightTabs` / `sidebarRight` services its tab types
  use; **dsh-rightbar-files** provides the Files tab on top of it.
- **dsh-editor** registers a **tab type** into that bar:
  - `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, title, guide })`
    (stage one: what the type is),
  - the keyed body/title seats `sidebar.right.pane.tab` and
    `sidebar.right.pane.tab.title`, registered with `key` = the definition's id
    (stage two: what a tab draws),
  - the `extension` priority band, so text files open editable rather than in
    the shipped read-only viewer; `canOpen` vetoes every extension the shipped
    previews own (html/images/pdf/office/archive/media/binary) and every path
    outside the session workspace - **Markdown is not one of them** (it is text
    and the editor claims it, with the rendered view one click away),
  - a `guide` entry, which is what the tab strip's "+" control lists.
- The workspace tree it opens files from is the pack's Files tab over
  `remote.workspaceFiles` (a shipped host service, not a UI dependency). That
  Remote is read-only, so saving (and creating a new file from a blank editor
  tab) goes through the plugin's own authenticated route; the session's
  workspace root is resolved host-side from the live session header or session
  persistence.
- **dsh-gittree** adds the **History** page tab (its label; the package, row and address keep the `gittree` name): the workspace’s **commit history**
  (short id, subject, author, date), with the branch and the current commit kept in
  its file bar, read through the package’s own **read-only**
  `/api/dsh-gittree/*` routes (the tab uses their `brief=1` form, so it never builds
  a file list). Every row sits beside a **rail** drawing the commit **graph** - one
  column per branch lane, a node per commit, the line running up to the newer commit
  above it, and the curves where a branch leaves a merge or rejoins it - laid out from
  the `%P` parents and `%D` ref decorations the `history` route carries, with a `#N`
  pull-request chip when a merge names one. Picking a commit shows its message and the
  files it touched, and a
  file row opens the file through the ordinary `dsh-resource://file/...` address,
  which the editor or a shipped preview then claims. It replaces nothing and
  publishes no service, so it cannot disturb the bar’s tab-type chain.
  **git must be on `PATH`** for its routes to answer.
- **dsh-cmdbar** (the **command bar**; `dsh-terminal` through alpha.13) puts the
  **agent's own commands in a bottom dock**: a header
  control at `order: 30` in the same `conversation.session.header.utilities` list
  (the last utility, right of Open In at `-10`) toggles a horizontal panel that
  starts at the left bar's right edge, spans the page and sits **under** the middle
  and right columns. Those two make room for it - and only those two: the left bar
  keeps its full height and its contents do not move. Inside is a read-only
  **transcript of every `bash` / `pwsh` / `run_code` / `terminal_send` call** the
  conversation recorded, grouped under the prompt that asked for it, with the tool,
  the working folder, the duration, the exit status and the output, filters, a
  per-row **Copy command** / **Copy output**, and a bar that wears the log's own
  state (the running pulse, the count of what failed, the warning when this
  conversation's log cannot be read here). It replaces nothing and publishes no
  service (it does not use the header corner, which the right bar's toggle owns),
  forks nothing and disables no core row.
  - **The terminals were removed in alpha.12**, and that is the shape of this
    package now. Through alpha.11 the dock also held its own xterm.js emulators -
    one real PTY each from the harness installation's own `node-pty`, over an
    authenticated WebSocket, with a chip strip and a **Run in Terminal** action -
    and every one of them is deleted, because 0.2's right Sidebar ships **terminal
    tabs of its own** (`@deepseek-ai/dsh-client-ui-sidebar-terminal`). A second
    emulator at the foot of the window was a second answer to a question the
    harness now answers in the column beside it. The package therefore **reads and
    never runs**: no shell is spawned, no binary resolved, no engine vendored, no
    socket gated, and it injects `connection` alone.
  - **One read-only route**, and it is the panel's whole data source:
    `GET /api/dsh-cmdbar/activity?session=<id>` answers a filtered **tail** of
    the conversation's own session events - only `tool/call`, `tool/result` and a
    HUMAN `user/message`, at most 400 events and roughly 512 KiB, newest kept, with
    `hasMore` stating what was left out, and `NOT_LIVE` with a **200** for a
    conversation no process has open. The browser folds it with the same pure fold
    the tracked check drives, so what the model is told and what a person sees
    cannot drift.
  - `lib/pty.js` and `lib/shell.js` went with the shells, which also makes every
    plugin in this pack **OS-neutral**: the only per-OS code left is a launcher
    choosing the host command.
  - **New package**, so the first install after this change needs a plain
    `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.
- **dsh-diagrams** adds **Mermaid and TikZ diagrams** as a surface of their own:
  six tools (`diagram_write` / `diagram_patch` / `diagram_read` / `diagram_verify`
  / `diagram_publish` / `diagram_delete`) whose every write is validated before it
  is stored, two bundled skills, one tab per diagram plus an index page, and a
  conversation card per tool call. A diagram belongs to the conversation that drew
  it, or to a shared **library** (`$DSH_HOME/dsh-diagrams/library.json`) that every
  conversation reads and cites by id.
  - **Mermaid is validated headlessly** by a child process that loads the same
    vendored engine the browser renders with behind a DOM stub; **TikZ is
    compiled** by the machine's own TeX engine (argv only, `-no-shell-escape`,
    `MIKTEX_AUTOINSTALL=0`, `openin_any`/`openout_any` paranoid, a private temp
    cwd, a 20 s kill), so a broken diagram returns the parser's or compiler's own
    line-accurate error and the model fixes it in the same turn.
  - **TeX is optional**: with no `pdflatex`/`xelatex`/`lualatex` on the server's
    PATH, TikZ diagrams are still stored, listed and exported as `.tex`, and
    every surface says the diagram was not validated. Mermaid needs no engine.
  - **State is one file per conversation** under `$DSH_HOME/dsh-diagrams`
    (never a session event: `dsh-session-persistence` refuses a log containing a
    type outside `KNOWN_SESSION_EVENT_TYPES` without the `ignorable` marker,
    which `Session.append()` cannot set) plus a content-addressed artifact cache.
  - The **vendored Mermaid engine** (`lib/vendor/mermaid.min.js`, ~3.4 MB) is a
    GENERATED file rebuilt by `vendor/build.mjs`, hashed into
    `lib/vendor/VERSION.json` and re-checked by the tracked route check. The
    harness' Connection fetch registry takes **exact** routes with
    `GET | HEAD | POST` only, which is why the engine is one self-contained file
    on one route and every write is a POST.
  - No npm dependency, no network, no core patch, no forked bundle. The two
    skills are copied into `$DSH_HOME/skills` by both installers (each copied
    folder carries a marker, so a person's own skill is never overwritten and
    uninstall removes only what it wrote).
  - **New package**, so the first install after this change needs a plain
    `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.
- **dsh-modal** provides the shared `modals` client service the editor's save-as
  dialog uses. It owns no slot and no ordering edge, and the editor resolves it
  lazily (falling back to the browser's own prompt), so neither plugin requires
  the other to be installed.
- **dsh-themes** adds the conversation header's Themes button. It contributes
  one occupant to the shipped `conversation.session.header.utilities` list at
  `order: -20` (left of Open In at `-10`) and drives the shipped
  `@deepseek-ai/dsh-client-ui-theme` service (`getTheme` / `setTheme` / the
  `theme/change` event, resolved lazily) - so the button and
  Settings → General → Appearance are the same preference. The editor reads the
  same service for its own light/dark CodeMirror palette. It also injects the
  pack's appearance overrides: the **Markdown paper**, one rule that re-declares
  ui-theme's own light declarations on the shipped preview's
  `[data-document-markdown]` root, so the rendered Markdown view stays white in
  the dark theme, the **Markdown chrome**, one static rule that hides the
  preview header's viewer menu on Markdown tabs (the page has exactly one
  renderer; the editor's **Edit** button is the way back), and - since alpha.9 -
  the **header ring**, one rule that gives the right bar's own collapse/expand
  toggle in the header corner the same `.5px` round outline every other icon
  button on that bar wears (that button belongs to a GENERATED forked bundle, so
  it cannot draw the ring where it lives; the rule keys on the header's stable
  `data-conversation-header-corner` marker, never a hashed class). Since alpha.9
  the same package also owns the header's **Session-log download seat**: the
  shipped `@deepseek-ai/dsh-session-log-export` browser half put a three-dot "more
  actions" button there whose menu held exactly one item ("Download session log"),
  and the pack registers the **same occupant id** (`session-log-download`) at
  `priority: -10` in that list slot - a list slot renders the **lowest priority**
  registration for an id, the slot system's own shadowing rule - so the ellipsis
  stops rendering and a plain download icon button takes the seat, with no CSS
  hiding and no DOM poking. The seat keeps its `order: 0` (it does not move), and
  its preparing/success/error dialog is drawn from the same store, so `/export`
  keeps its feedback. The **export is not reimplemented**: the shipped row stays
  mounted because its host half owns `/api/session.export` and the `/export`
  command, and this control drives the controller its browser half publishes
  (`sessionLogDownload`, resolved lazily with `ctx.get`). Nothing is forked, no
  core row is disabled and no new package was added; a profile without that
  service shows a disabled button instead of a broken one. On the pack's
  own **left top bar** it also replaces the branding: the shipped mark and wordmark
  (they are `single`-slot occupants filled by the harness's `brand-official` row,
  with the layout's own fish as fallback) are hidden and redrawn as the **app
  icon** (`assets/vncode.svg`, a 24px black disc with a 1px transparent
  margin) and the text **vncode**, in the wide row and in the collapsed rail.
- **dsh-ui-state** keeps the UI state that a reload used to forget, **on the
  host**, so the web profile and the desktop window share one picture: the row's
  own `.volatile()` Config - the page zoom, an extension theme, the dock height
  and the two column widths - which the Host projects into a settings form keyed
  by the profile entry id `ui-state`, so an accepted write lands in the profile's
  own Cordis patch document (`$DSH_HOME/profiles/web/cordis.patch.yml`) as that
  entry's `config:`. It opts out of a generated settings page with
  `settings.configure({ auto: false })` and inlines the remembered zoom into the
  page **before the shell mounts**, so a level never costs a reflow; its browser
  half binds `ctx.configForms.get('ui-state')` once and publishes the `uiState`
  service the pack's other halves write through. `localStorage` is kept
  underneath as the fallback, so a profile that installed `dsh-themes` or
  `dsh-cmdbar` without this package behaves exactly as before.
  - **Why not `localStorage`**: it is per origin and per browser profile, so a
    Chrome tab and the desktop WebView2 are two stores that can never agree, and
    the desktop shell prefers port 3080 and falls back to a free one.
  - **Why not a session event or a projection**: `dsh-session-persistence`
    refuses an unknown event type unless the envelope carries `ignorable: true`
    (which `Session.append()` cannot set), so a plugin-owned event would make the
    conversation unreadable; a projection unit needs `zod` schemas, and this pack
    ships zero npm dependencies.
  - It owns **no route** and adds no file format: the profile's own patch document
    is already user-editable, atomic, schema-validated and hot-reloaded.
    Schemastery (which declaring a `.volatile()` field needs) is resolved at
    runtime through the same `$DSH_HOME/profiles` package anchor this pack uses
    for the harness's own out-of-tree resolution, never imported, and a resolved
    copy too old to carry `.volatile()` is passed over — a bare import resolves
    from the repo folder and fails there.
  - It **does not** remember the command bar being open: see the notes under
    `dsh-cmdbar` and in the changelog below.
  - **New package**, so the first install after this change needs a plain
    `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.
- The shipped `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` row stays
  enabled: it only consumes `sidebarRightTabs` and the keyed seat, so the
  code/image/PDF/HTML previews keep working inside the pack's bar, and the editor
  names its kind (`text`, read from the registry) for **Preview**. The pack's
  **first-generation Files panel is retired**: `dsh-files` (row `files`)
  and its pre-alpha.10 name `dsh-focus` are pruned from the profile.

## Upgrading the pack when DSH moves

1. Bump `dsh` in `.dsh-version.json` (and each package's tested note).
2. Re-run `scripts/sync-vendored.ps1` (then review the diff: a patched fork's
   patch list fails loudly when the core code it patches moved).
3. Re-run the installer with `-Force` to re-add bundles under the new CLI pin.
4. If a core API moved (registry shape, seat names, framework props, route
   registration), adapt the affected package and bump its alpha version.
5. Re-run the uninstaller on machines that should drop the old version first.

## Renames, retirements and forks within the pack

- **alpha.9 → alpha.10**: `dsh-focus` (row `focus`) was renamed to `dsh-files`
  (row `files`).
- **editor alpha.1 → alpha.2**: `dsh-files` was retired outright - the harness
  now ships a right Sidebar with a Files tab, and the editor became a tab type
  registering into that bar instead of a panel inside the pack's own dock.
- **installer alpha.2**: the DSH Desktop target was removed; the pack installs
  into the web profile only.
- **rightbar alpha.1**: the pack now **owns the bar**. `dsh-rightbar` and
  `dsh-rightbar-files` are byte-for-byte forks of the shipped
  `@deepseek-ai/dsh-client-ui-sidebar-right` / `-sidebar-files` bundles, and the
  bar's bundle layer hard-disables the two core rows so only the pack's
  copies run. Re-sync the fork with `scripts/sync-vendored.ps1` after a
  harness-line bump (see `ARCHITECTURE.md` §4).
- **editor alpha.4 / modal alpha.1 / open-in-app alpha.1**: the editor starts
  blank documents and names new files through the new shared `modals` dialog;
  the Open In file-manager entries moved to the pack's own cross-platform
  launcher, so `ui-open-in-app` is disabled and `native-open-in-app` runs
  instead.
- **os-neutral alpha**: no version bumps - the launchers gained macOS/Linux
  twins (`scripts/install.sh` / `scripts/uninstall.sh`, `scripts/*.sh`) and the PowerShell
  scripts stopped assuming Windows; installed profiles are unaffected.
- **editor alpha.5 / themes alpha.1**: the editor's CodeMirror palette follows
  the app's light/dark appearance (oneDark only while the app is dark) and
  re-themes live, and the new **dsh-themes** bundle adds the header button that
  switches Light / Dark / System. New package, so the first install after this
  change needs a plain `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.
- **editor alpha.6 / themes alpha.2**: **Markdown opens editable** in the editor
  (it is text) with a toolbar **Preview** button that hands the file to the
  rendered view by naming the shipped preview's registry kind; and
  **dsh-themes** carries the **Markdown paper**, which keeps that rendered view
  white in the dark theme by re-declaring ui-theme's own light declarations on
  it. No new packages, no core rows touched.
- **editor alpha.7 / shell-installer alpha**: the rendered Markdown page now
  carries an **Edit** button (the editor's own document body, shadowing the
  shipped one at a lower slot priority), so **Preview is a toggle**: Editor →
  Preview → Edit → Editor on the same tab and file. Separately, `scripts/install.sh` /
  `scripts/uninstall.sh` and `scripts/install-all.sh` / `uninstall-all.sh` are **real
  POSIX shell implementations** now - Node.js + npm/npx only - instead of
  wrappers around PowerShell, so macOS/Linux hosts no longer need PowerShell at
  all; the `.ps1` half stays the Windows path (`scripts\install.bat`), and
  `scripts/sync-vendored.ps1` remains PowerShell-only maintainer tooling.

- **master alpha.1 (new package)**: the pack gained a master bundle of its own,
  **`dsh-vn-master`**, and it shipped deliberately **blank** - the bundle layer plus
  one no-op `master` host row, with no `dsh.client`, no published service, no
  `inject` edge and no core-row disables. The right bar therefore stops being the
  pack's base and keeps only bar responsibilities; pack-wide patches now belong
  to the master, whose layer is installed last (its name sorts last and
  `dsh plugin add` appends) and is consequently the profile's final word per row.
  Nothing about the bar's tab-type chain changes: `sidebarRightTabs` /
  `sidebarRight` stay in the generated fork, and the `ui-sidebar-right` /
  `ui-sidebar-files` disables stay in `dsh-rightbar`, next to the rows they
  replace. New package, so the first install after this change needs a plain
  `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.
- **editor alpha.8 / themes alpha.3**: two fixes on the rendered Markdown page.
  The editor's shadow body (alpha.7) replaced the shipped wrapper that undid the
  preview scrollport's plain-text styling, so the page inherited `white-space:pre`
  (a source newline became a hard break and every blank line a full empty line -
  the double-spaced look) and the **Edit** pill inherited the monospace stack;
  the pack's own wrapper now resets both. And because a Markdown page has exactly
  one viewer, `dsh-themes` hides the preview header's viewer menu on Markdown
  tabs, so "Plain text" is no longer offered beside "Markdown" - the editor's
  **Edit** button is the way back to the text. No new packages.

- **gittree alpha.1 (new package)**: the pack gained **`dsh-gittree`**, a
  **read-only** git tab: a page tab type on the right bar with one guide entry
  (`order: 30`, after Files and Editor), showing the workspace's git tree with
  status badges plus a History view whose commits open to their changed files.
  Its Node half owns three read-only routes (`state` / `history` / `commit`) that
  spawn `git` with argv arrays, a pinned environment, a 10 s timeout and an 8 MiB
  cap; the only subcommands reachable are `rev-parse`, `status`, `ls-files`,
  `log`, `show` and `diff-tree`, so it cannot change a repository. Nothing is
  forked and no core row is disabled. A file row opens the file through the
  ordinary file address, so the editor or a shipped preview claims it - the tab
  needs neither. **git must be on `PATH`.** New package, so the first install
  after this change needs a plain `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.

- **gittree alpha.2**: the tab is **history-only** - the working-tree listing, its path
  filter, its changed-only switch and the viewer switch are gone; what remains is the
  commit list plus the branch and the current commit in the file bar, and a commit’s
  message and changed files when one is picked. The state route gained a `brief=1`
  form for exactly those bar facts, so the tab never builds a file list. It also fixes
  a real hang: alpha.1 returned an effect cleanup that ran on the very next render -
  the one its own `setState` caused - and cancelled the request the effect had just
  started, so the panel sat on "Reading the history…" forever. Every request
  now carries a `useRef` token and applies its answer only while it is the newest one.

- **gittree alpha.3**: the tab is **renamed to History** in the capsule and the chip,
  because it shows commits rather than a file tree. The label is all that changed: the
  package, the row, the kind and the address keep the `dsh-gittree` / `gittree` name, so
  an installed profile needs no re-add - only a restart and a hard refresh.

- **terminal alpha.1 (new package)**: the pack gained **`dsh-terminal`**, a real
  shell in a **bottom dock**. A header button (order 30 in the header utilities
  list, right of Open In...) opens a panel that starts at the left bar's right
  edge, spans the page and sits under the middle and right columns, which make
  room for it: the frame's inline height becomes `calc(100% - <dock>px)` while it
  is open and is restored exactly on close, and the left edge comes from the
  frame's resolved grid tracks, so it follows the left bar opening, collapsing
  and being dragged. **xterm.js 5.5.0** (+ `@xterm/addon-fit` 0.10.0) is vendored
  into `lib/vendor/` from `vendor/` the same way the editor vendors CodeMirror,
  and the Node half owns `/api/dsh-terminal/health`, `/api/dsh-terminal/vendor/*`
  and one authenticated WebSocket upgrade, `/api/dsh-terminal/pty`. The PTY is
  the **harness's own `node-pty`** - resolved, never installed - with
  ConPTY PowerShell on Windows and the login shell on macOS/Linux; one shell per
  (conversation, slot), up to eight, kept five minutes after its last socket so a
  reload reattaches with a scrollback replay. Nothing is forked and no core row
  is disabled. A terminal is, by nature, an **unsandboxed shell**: the gate is the
  connection's own authentication, checked before the socket reaches a PTY. New
  package, so the first install after this change needs a plain
  `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.

- **terminal alpha.2**: two things the first run got wrong.
  1. Resizing the dock left the emulator at its old size, so the visible line
     count was wrong and the newest output could sit out of view. Every size
     change (grip drag or viewport) now re-fits - rows and columns recomputed from
     the new box - sends the new size to the PTY, and scrolls back to the end of
     the output.
  2. Opening the dock shortened the **left bar**, so its items visibly slid up: the
     room came from the app frame's inline height, and the frame has a single grid
     row that the left bar shares. It now comes from the **middle and right columns
     only**, as their own `height: calc(100% - <dock>px)`, handed back exactly on
     close - the left bar is never touched. (Not `padding-bottom` either: the right
     column's panel is absolutely positioned against its ancestor's *padding* box,
     so padding would leave that panel where it was and the dock would cover its
     bottom.)

  Both are pinned by the tracked client check (`terminal never resizes the frame`,
  `terminal refits on resize and follows the end`) and were verified in a real
  browser engine: the left bar's height and contents are exactly where they were
  before the dock opened, the middle and right columns end at the dock's top edge,
  and growing then shrinking the dock takes the visible rows 13 -> 16 -> 6 with the
  newest output on screen throughout.

- **terminal alpha.3**: collapsing or expanding the **left bar** left the dock
  standing at its old left edge. The left bar is animated - one grid rewrite,
  then a CSS transition - so the `MutationObserver` on that rewrite reports the
  **pre-transition** track (`260px` while the track animates `260 → 171 → 62 →
  60`, measured in the engine) and is never called again. A `ResizeObserver` on
  the two columns the dock spans - whose *size* changes on every frame of the
  transition - now follows it, with a `transitionend` snap as the backstop. No
  new packages, no changed placement: a restart plus a hard refresh is enough.

- **themes alpha.6**: the left bar's **branding is now the pack's**. The mark and
  the product name are `sidebar.brand.mark` / `sidebar.brand.name`, both
  **`single`** slots that the shipped `@deepseek-ai/dsh-client-ui-brand-official`
  row already occupies (and which fall back to the layout's own fish), so this is
  an **override** on the band alpha.4 already owns rather than a fight for a
  one-occupant seat: the slots' children are hidden (`display:none!important`,
  which beats the `display:contents` wrapper the app puts around each occupant)
  and a **24px black disc** plus the text **vncode** are drawn in their place
  - in the wide row and in the collapsed rail. Verified in the running app: the
  shipped art computes to `display:none` and the disc to `24px × 24px`,
  `border-radius:50%`, `rgb(0,0,0)`. Pinned to the sidebar's hashed class names
  like the band itself, so a harness bump that renames them needs that one rule
  updated (and the tracked check fails loudly).

- **themes alpha.7**: the branding text wears the **chat title's type**. The
  shipped brand name is `18px/600` while the conversation's own title (the current
  crumb in the header strip the band is levelled with) is `14px/20px/500`, so the
  two read as different sizes a few pixels apart; **vncode** now takes the
  title's size, weight and line height. The check pins the declaration, and the
  served `ui-conversation` bundle was compared with the served `dsh-themes` bundle
  to confirm both declare `14px/20px/500`.

- **themes alpha.8**: the branding mark is now the **app icon** —
  `assets/vncode.svg` at the pack root, a black circle centred on (12,12) with
  a **1px transparent margin** inside its box. That margin is the fix for alpha.7's
  "cut" disc: it was drawn edge-to-edge inside boxes the app paints with
  `overflow:hidden` (the sidebar's brand button is exactly 24px tall), where the
  circle lost a fraction of a pixel on each side. The same icon replaces the whale
  in the empty conversation's hero ("Into the Unknown", the
  `conversation.hero.brand.mark` slot) at 26px, so the new-session screen wears the
  same mark as the sidebar. The icon is **inlined as a data URI** — no route, no
  request, no Node half — with the asset as the source of truth and a tracked check
  comparing the inlined geometry against it. Verified in the running app (sidebar,
  rail and hero) and at the pixel level: at 24px and 26px the opaque box is exactly
  square with a 1px margin on all four sides, every row and column mirrors, the
  corners are transparent and nothing touches the edge.

  Installers prune both retired bundle names; upgrade by re-running
  `scripts\install.bat` / `./scripts/install.sh`, then restart the app and hard-refresh the
  browser.

- **themes alpha.9**: the middle panel's top bar loses the shipped three-dot
  "more actions" button (whose only menu item was "Download session log") and
  gains a **download icon button** in the same seat that starts the export on the
  first click. `dsh-themes` registers the SHIPPED seat id (`session-log-download`)
  at `priority: -10`, so the list slot's own shadowing rule (lowest renders) makes
  its component the one that draws - no CSS hiding, no DOM poking, no disabled
  core row and no new package: the shipped `session-log-download` row stays
  mounted because it owns `/api/session.export`, the `/export` command and the
  `sessionLogDownload` controller this button drives (the seat's dialog included,
  so `/export` keeps its feedback). The same alpha gives every icon button on that
  bar the SAME round `.5px` hairline ring: the Themes button and the new download
  button draw it themselves (the terminal control already had it), and one
  override rule gives it to the right bar's own toggle in the header corner,
  keyed on the header's stable `data-conversation-header-corner` marker (that
  button lives in a GENERATED forked bundle and could not draw it where it lives).
  No new packages: an install run with `-Force` (or a plain one, since the version
  changed) plus a restart and a hard refresh is enough.

- **themes alpha.10**: the header gains a **Screenshot control**, one order step
  left of the Themes button (`order: -30`), which captures the whole window and
  saves the PNG to the **Desktop of the machine running the app**. The capture is
  the browser's own - `getDisplayMedia({ preferCurrentTab: true,
  selfBrowserSurface: 'include' })`, one frame drawn into a canvas and encoded as
  `image/png` - because the Web GUI is a fixed-viewport shell (its 100% width and
  100% height are exactly the tab's box) and only the page can photograph its own
  pixels: a DOM-to-canvas library would have to stand in for the engine, and a
  headless browser at the same URL would photograph a fresh load without this
  client's open tab, editor buffer or terminal dock. The file does not go through
  the browser's downloads: `lib/index.js` stops being a no-op row and registers
  `POST /api/dsh-themes/screenshot`, which resolves the host's Desktop per request
  (Windows plain or OneDrive-redirected, `~/Desktop`, XDG `XDG_DESKTOP_DIR`, home
  last), validates the body (`image/png`, the PNG signature, a 64 MiB cap) and
  writes it create-exclusively (`vncode-<timestamp>.png`, `-2` on a
  collision), answering the path the toast then shows. A profile without that row
  falls back to an ordinary browser download. Restart `npx @deepseek-ai/dsh web`
  and hard-refresh; the version changed, so a plain install run (or `-Force`)
  re-adds the bundle.

- **diagrams alpha.4 / alpha.6**: `dsh-diagrams` gains a second **scope**. A
  diagram used to belong to the conversation that drew it and to nothing else;
  there is now a shared **library** - one file for the whole harness
  (`$DSH_HOME/dsh-diagrams/library.json`, written by the same store class) - that
  `diagram_write { scope: 'library' }` writes into and `diagram_publish { id }`
  copies a conversation diagram into, addressed as
  `dsh-resource://diagram/library/<id>`. A bare id resolves library-first, the
  index shows both halves, and a panel edit writes back where the diagram already
  is. Alpha.4 is the usability pass around it: the diagram tab lays a picture out
  at 80% of the pane with a **zoom ladder** (25%-400%, remembered per diagram) and
  drag-to-pan that moves the layout box (never a CSS transform), and **every
  export saves to the Desktop** of the machine running the harness
  (`POST /api/dsh-diagrams/export`, create-exclusively, absolute path reported)
  instead of the conversation folder, with the browser download left as the
  fallback. Restart and hard-refresh; the version changed, so a plain install run
  (or `-Force`) re-adds the bundle.

- **themes alpha.12 / alpha.13 / alpha.19**: the Themes menu is the **shipped
  registry's own list** now. `dsh-themes` registers its own palettes through
  `ctx.theme.register` - ui-theme's documented third-party surface - starting with
  **Nord** (alpha.12), adding **Monokai** (alpha.13) and then **Hacker** (alpha.19)
  in the same 93-token alias shape on the dark base. Hacker is the phosphor
  terminal - a near-black green-cast page, phosphor-green text, one amber and one
  cyan accent - so the menu reads Light / Dark / Nord / Monokai / Hacker / System.
  The header button wears one static appearance mark
  instead of the active preference's sun/moon, and the choice is in-process: the
  durable preference schema accepts `light` / `dark` / `system` only, so a reload
  returns to the durable built-in. Adding another theme is one entry in
  `THEME_EXTENSIONS` plus its copy in both dictionaries. Restart and hard-refresh.

- **themes alpha.14**: the pack's own product text on the left top bar reads
  **vncode** - the repository's own spelling - instead of the title-case
  **VN Harness** it used through alpha.13. Nothing else about the branding moved:
  same slot override, same 24px disc, same chat-title type, same inlined icon.
  The draw string is what the tracked check pins, so a bundle still saying
  `VN Harness` fails the check loudly. Restart and hard-refresh; the version
  changed, so a plain install run (or `-Force`) re-adds the bundle.

- **gittree alpha.5**: the History tab draws the **graph**. Every row now sits
  beside a **rail** - a vertical rectangle on the left of the list carrying one
  column per branch lane, a node per commit, the line running up to the newer
  commit above it, and the curves where a branch leaves a merge or rejoins the
  line. The layout comes from two fields the `history` route now carries per
  commit - `%P` (the parents) and `%D` (the ref decorations) - laid out in ONE
  forward pass over the log's own order, which is enough because git always lists
  a child before its parent; a parent outside the page (the `limit`, or a
  workspace-scoped log) ends its lane instead of inventing a commit for it. A
  merge wears a larger hollow node, and a **pull request is named from the
  repository itself** - GitHub's `Merge pull request #12 from …` subject, a
  squashed `… (#12)` subject, or a `refs/pull/12/…` ref a repository has fetched -
  as a `#12` chip; the branch `HEAD` points at, tags and remotes wear ref chips
  (two at most, then `+N`). Nothing is measured: a row is exactly 28px, so the
  node sits on the row's centre line and the rail runs straight through an
  expanded commit's detail. The route answers more per commit, so **restart the
  harness and hard-refresh** to pick up both halves; the version changed, so a
  plain install run (or `-Force`) re-adds the bundle. A hard refresh against a
  host that has NOT been restarted is tolerated on purpose: without the new
  fields the client reads the list's own order as the parent chain, drawing one
  continuous line (right for the linear log such a host implies) instead of a
  rail of disconnected stubs, and gains the real graph on the next restart.

- **layout parity (rightbar alpha.2, editor alpha.9, gittree alpha.4)**: three
  changes that are about the same 38px box. The pack's bar lifts the shipped
  bundle's **two-pane dock cap** to the docking kit's own four (with the top/bottom
  drop bands re-opened, so a 2x2 is built by dragging a tab into a pane's upper or
  lower quarter), and the editor's and History's toolbar became the tab's own
  **top bar**: `38px`, `box-sizing:border-box`, the same box the shipped Files tab
  and the document preview use, so every column's first hairline lands on the
  **y=76** line the 38px docking strip, the 76px conversation header and the left
  column's branding band all end on (the toolbar had been `8 + 26 + 8 = 42.5px`,
  i.e. ~4.5px low).

- **run launcher (new)**: `scripts\run-web.bat` / `scripts/run-web.sh` - one file per platform at the repo
  root - start the pinned `dsh web` and open the URL it prints in Chrome, falling
  back to the default browser; see **Running the app** above. The POSIX half holds
  all the work in one POSIX sh file; on Windows the double-clickable root
  `scripts\run-web.bat` is batch only (which is what makes a double-click work with no
  execution-policy question) and the work is in `scripts/run-web.ps1`, because cmd
  cannot watch a running child's output. Nothing in the profile changes and no
  bundle was added: the launcher is repo tooling, and an installed profile needs
  nothing to use it.

- **ui-state alpha.1 (new package)**: the pack gained **`dsh-ui-state`** — the
  state a reload used to forget. The interface's own state was remembered in the
  wrong place: everything that survived lived on the HOST (`$DSH_HOME/sessions`,
  `storages/workspace.json`, the profile's own patch document) while the page
  zoom and the dock height sat in `localStorage`, which is per **origin** and per
  browser **profile** — so a Chrome tab and the desktop window's WebView never
  shared it, and the desktop shell lost it whenever port 3080 was taken. This
  package makes that state host state: the row declares its own `.volatile()`
  `Config` holding
  `pageZoom`, `theme`, `dockHeight`, `sidebarWidth` and `rightbarWidth`, and the
  Host projects those fields into a settings form keyed by the profile entry id
  `ui-state`, whose accepted writes land in the profile's Cordis patch document
  as that entry's `config:`. Its Node half declares that Config, opts out of a
  generated settings page, and inlines the remembered zoom into the page before
  the shell mounts; its browser half binds `ctx.configForms.get('ui-state')`
  **once** (three independent bindings would fence each other's writes on a stale
  revision, and the recovery for that drops the write), restores the two COLUMN
  WIDTHS through ui-layout's own root-slot store handle (its `ctx.layout` exposes
  no width setter), and publishes the **`uiState`** client service the other two
  halves write through. Every field carries a schema default, so a fresh install
  grows **no** `config:` block at all. New package, so the first install after
  this change needs a plain
  `scripts\install.bat` / `./scripts/install.sh` run or `-Force`.

- **ui-state is shared by both hosts, and that is the point**: `localStorage`
  cannot do this job. Even at the same port, a Chrome tab and the desktop
  window's WebView2 are two different browser profiles with two different stores,
  and the desktop shell prefers 3080 and falls back to a free port, so one host
  could lose its own state by moving a port. A settings form writes into one
  document both launchers read. Anything a profile wants remembered across both
  should go there, not into storage.

- **themes alpha.18 - the extension themes were broken, and this fixes them**: in
  the field, clicking **Nord** or **Monokai** appeared to do nothing while Light
  and Dark worked. The cause was **not** the persistence. ui-theme's
  `ThemeRuntime.adopt()` assigns its `preference` from its **durable** section
  whenever its durable form notifies, and that form notifies whenever the
  settings **document** changes - which any write to any entry's config causes,
  including this pack's own zoom, dock and width writes. An extension theme is
  never written to that durable section (ui-theme's schema accepts
  `light`/`dark`/`system` only), so choosing Nord applied it and the very next
  settings write snapped the app back to the durable built-in. It predated
  alpha.17: **any** Settings change reverted an extension theme, and the new
  persistence simply made the revert immediate and visible.
  Fixed by treating an extension theme as a **desired state the control keeps
  applied** rather than a one-shot choice, with ui-theme's own form
  **revision** as the tie-break: revision unmoved means nobody chose anything (a
  re-adopt, so the theme goes straight back on), revision moved means a surface
  that writes durably chose a built-in - the shipped **Settings > Appearance**
  row - and that decision wins. Picking the built-in that was *already* durable is
  the one case the revision cannot see, so the extension is re-applied; that means
  setting the durable built-in to the extension's own base scheme (`dark` for
  Nord) is the one shape of "leave Nord" that has to be done from this control's
  menu instead. Version changed: a plain install run (or `-Force`) re-adds the
  bundle, then restart and hard-refresh.
  The new tracked check runs the **real** ui-theme bundle (not a stub, which is
  what let this ship) and skips loudly on a host with no copy of it.
- **themes alpha.17**: the page zoom and an **extension theme** become durable.
  `light` / `dark` / `system` always persisted (ui-theme owns them); **Nord** and
  **Monokai** did not — ui-theme's durable schema accepts the built-in three
  only, so they were an in-process choice a reload threw away. They now ride the
  `ui-state` entry's volatile config, with the per-origin `localStorage` copy kept
  UNDERNEATH as
  the fallback, so the control still remembers its level in a profile that
  installed this bundle without `dsh-ui-state`. Picking a built-in theme **clears**
  the field rather than overwriting it, so the document keeps no stale theme id.
  Version changed: a plain install run (or `-Force`) re-adds the bundle, then
  restart and hard-refresh.

- **terminal alpha.5**: the dock's **height** rides the same section, on the same
  terms (localStorage kept underneath). Its **open** state is deliberately NOT
  remembered: the panel is the window onto a conversation, and after a reload the
  client holds none, so reopening it would show a panel nobody asked for. A height
  is a preference; "I was looking at the agent's commands" is a moment. (Through
  alpha.11 the rule had a second, stronger reason — the panel held PTYs, so
  reopening it could have started a shell nobody asked for — and the reason
  outlived the shells.)
  Version changed: a plain install run (or `-Force`) re-adds the bundle.

- **desktop window geometry (app/)**: the Tauri shell now remembers its own
  window size and position in `$DSH_HOME/vncode/window.json`, read before the
  window is built (a browser round trip could not answer in time) and written on
  a coalesced resize/move plus once at exit, with a monitor check that centres the
  window when the remembered point is on no screen. It is desktop-only state by
  nature — a Chrome tab has no window geometry to share. `app/` is not a plugin
  and no installer touches it: `scripts\run-desktop.bat` rebuilds it on the next launch
  (close any running vncode window first, or the release binary is locked).

- **master alpha.2 - the Browser tab comes back, on the web profile**: 0.2 ships
  the right Sidebar's Browser tab **desktop-only**. `dsh-web-app`'s own layer
  declares the row as
  `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`, and the
  package's README documents the way in as a patch on the row, so on a web profile
  the tab simply is not there. This pack installs into the raw **web** profile, and
  its master layer is the last one applied - a later layer wins per row - so the
  master performs that opt-in for every install:

  ```yaml
  - id: ui-sidebar-browser
    disabled: false
  ```

  That one restatement is the whole change, and it is enough for the tab to appear
  on the **Start** page: the browser package registers its tab type AND its own
  guide entry ("Browser" / "Browse web pages") into the `sidebarRightTabs`
  registry - the same service `dsh-rightbar`'s generated fork provides and this
  pack's own tab types register into - so the Start page lists it by itself. No
  pack code draws that entry, no pack row is involved, and the master stays
  browser-free: it still ships no `dsh.client`, no service, no `inject` edge and no
  core-row disables, and the row keeps the name and package the earlier layer gave
  it. A desktop profile is unaffected, because the expression being overridden
  already resolved to `false` there. This is also the first thing the master has
  ever carried, which is why "the master is blank" now reads as "the master is
  browser-free but is where the pack's row restatements live".

- **master alpha.3 / themes alpha.21 - feedback is removed**: the pack's first
  **pack-wide product decision**, and the one place a shipped row is disabled
  without a pack bundle replacing it. vncode is its own product and does not ask its
  users for feedback — and the shipped feature is not merely a rating: its dialog
  says in its own words that *"Your submission will include the current conversation
  log"*, and that submission is what releases an upload to a third party. **Four
  rows** are hard-disabled in the master's layer rather than hidden:

  - `ui-message-feedback` — the browser half: Like/Dislike in the
    assistant-message action strip, the dialog in `conversation.input.overlay`, its
    acknowledgement toast, the `/feedback` composer decoration and the `feedbackUi`
    service.
  - `message-feedback` and `command-feedback` — the host halves: the
    `messageFeedback` / `sessionFeedback` Remotes, the log-only
    `feedback/message-*` events and the `feedback/record` the `/feedback` command
    appends.
  - `session-telemetry-otel` — the export path those events **release**. It runs in
    `FEEDBACK_ONLY` mode, so it captures a Session-log prefix and POSTs it to the
    vendor's collector (`https://dsh-otel-collector.deepseeksvc.com/v1/logs`, with
    `$DSH_HOME/.anonymous-user-id` as the OTel `user.id`) **only** after an explicit
    feedback event; with the producers gone it has nothing to release, and
    disabling the row is the launcher's own privacy switch — the same
    `disabled: true` a non-empty `DSH_TELEMETRY_DISABLED` resolves to
    (`dsh-app-boot`'s `resolveTelemetryPatch`) — so the exporter is never even
    constructed and the endpoint is never contacted.

  Nothing else consumes those services (`remote.messageFeedback` /
  `remote.sessionFeedback` appear only inside the feedback packages), and the
  shipped Session export guards its own entry as
  `ctx.get('feedbackUi')?.openSession(...)` behind an availability flag, so
  `/export` keeps working with the feedback affordance simply absent. The rows are
  composed at **boot**, so a profile that is already running needs a restart before
  the surfaces are gone. A disable that belongs to a package REPLACING a row still
  stays with that package (`dsh-rightbar`'s `ui-sidebar-right` /
  `ui-sidebar-files`), so a partial install still mounts one bar.

  **The account menu's own Feedback item is not a row**, and that is why the change
  spans two packages. It is hardcoded in
  `@deepseek-ai/dsh-client-ui-settings-account`'s `AccountMenu`, registered into the
  `settings.launcher` slot as a whole, and opens an EXTERNAL form in a new window
  (`contactUrl()` builds it from the row's `contactFormUrl`, a Feishu questionnaire
  by default, with the uid, the source, the harness version, the locale, the screen
  size and the device info appended). The only two options were a fork of the whole
  account bundle (4.5k lines: sign-in, sign-out, quota notices, billing pages,
  onboarding) or one rule, so **dsh-themes alpha.21** hides the row:

  ```css
  [role="menu"]>div:has(>button[role="menuitem"] svg path[d^="M4.74024 9.11029"]){display:none}
  [role="menu"] button[role="menuitem"]:has(svg path[d^="M4.74024 9.11029"]){display:none}
  ```

  The selector is pinned on the row's **icon artwork** rather than a class name: the
  Menu primitive renders rows with no id or data attribute in the DOM, while the
  paper-plane `path` data comes from the design asset and outlives the hashed class
  names a rebuild renames. It hides the row's wrapper **and** its button, it is
  scoped to `[role="menu"]` so the same artwork drawn by the chat's turn-trigger
  notice and by the Session-export header button is untouched, and hiding is enough
  because a `display:none` row can never take focus while the Menu's keyboard walk
  still advances past it — Settings and Sign out stay reachable with `ArrowDown`.
  Setting the row's `contactFormUrl` from the master instead was **rejected on
  purpose**: a row with `volatile` fields has its whole `config` replaced by the next
  volatile write from a settings form, so the override would silently evaporate.
  The accepted failure mode is the one every pin in `dsh-themes` carries — a harness
  bump that redraws the artwork makes the rule match nothing and the row returns —
  and `check-client-bundles.mjs` pins the rule, both of its shapes, its
  `[role="menu"]` scoping and the absence of any hashed class in it.

- **terminal alpha.12 - the dock stops being a terminal**: the bottom dock lost its
  own emulators, and the package is now the **agent's command transcript** and
  nothing else. What went, all of it: `lib/pty.js` (node-pty resolution, the
  session registry, the reaper), `lib/shell.js` (the pack's only per-OS file),
  the vendored **xterm.js 5.5.0** + `@xterm/addon-fit` bundle and stylesheet under
  `lib/vendor/` with its `vendor/` build folder, the two `/vendor` routes, the
  `GET /api/dsh-terminal/health` probe, the authenticated WebSocket upgrade
  `/api/dsh-terminal/pty`, the chip strip with its `+` and per-chip `×`, the
  per-slot runtime with its reattach/replay and backpressure, **Run in Terminal**,
  and the `Agent` toggle - because with one view there is nothing to toggle to.
  The Node half is now **ONE route** (`GET /api/dsh-terminal/activity`) and injects
  **`connection` alone**; `lib/client.js` reads and never runs. What stays is
  everything that was about the panel rather than the shells: the dock's geometry
  and its animated-left-bar tracking, the height's two-store persistence with
  `adoptDecision`, the read-only tail route and the browser's pure fold over it,
  the poll's cadence and bounded retry, the bar's command counts, and the alpha.9
  command-row dress.

  **Why**: 0.2's right Sidebar ships **terminal tabs of its own**
  (`@deepseek-ai/dsh-client-ui-sidebar-terminal`), so a second emulator at the foot
  of the window was a second answer to a question the harness now answers in the
  column beside it - and the pack was maintaining a whole engine to duplicate a
  feature. A side benefit worth stating: an authenticated WebSocket that could
  spawn a shell is gone from this pack's surface, and every plugin here is now
  OS-neutral (the only per-OS code left is a launcher choosing the host command).

- **terminal alpha.13 - the panel follows the conversation, and says less**: two
  changes, both about the dock describing the wrong thing.
  *The facts line* (the dock's own bar **and** the Agent control's tooltip) used to
  open with *The agent's own commands in this conversation: * before the counts.
  Both surfaces are already labelled **Agent**, so the sentence only pushed the
  numbers away from the eye; `activityFactsTitle` now returns the counts alone
  (*2 commands, 1 running, 1 failed*), still pinned as **text** by the tracked
  check.
  *Following the reader* is the repair that matters. alpha.11 made a conversation
  change **close** the dock and forget the conversation it left - but
  `adoptSession` returned early on an **empty** session id, and the header control
  only exists while a session header is on screen. Two ordinary paths therefore
  reported nothing at all: a **new conversation** (no session id yet) and a screen
  whose header has **gone away** (the Start page). The always-mounted dock kept
  drawing the previous conversation's commands, counts and poll. An open dock now
  **re-points** at the conversation in front of the reader instead of closing - the
  panel keeps its open state, its height and its place, while everything it draws
  (commands, counts, poll, filters, expanded rows, follow pill) belongs to the new
  one, and with no conversation at all it says **No conversation open** rather
  than "Reading the conversation..." for ever. The rule is one pure
  `followDecision({ open, current, next })` in `__internals`, pinned
  behaviourally: the same conversation moves nothing, a different one re-points an
  open panel, an absent id is a **change** and not a no-op, and a closed panel
  still only forgets (alpha.11). The header control's **unmount** releases the
  identity it owned, and `ActivityView` is **keyed** on the conversation so the
  view's own state cannot carry over either. Nothing else about the package moved:
  still one read-only route, still `connection` alone, still closed by the
  reader's own control and by nothing else.

  **What a person loses**: a shell in the dock. Use the right bar's own terminal
  tabs for that; the dock keeps watching what the *agent* ran, which is what it was
  for. **What a person keeps**: everything about that transcript, unchanged.

  The tracked checks moved with it, in both directions: `check-node-routes.mjs`
  now drives the one route *and* asserts the deleted half stays deleted (exactly
  one route registered, **no** upgrade registered even with a `webServer` service
  offered, and no `/health` or `/vendor` path answering), and
  `check-client-bundles.mjs` asserts the absence of the socket, the vendored
  engine, the emulator registry, the view sentinel, the chip strip and the
  run-in-terminal action, alongside the unchanged geometry and activity
  assertions. Version changed: a plain install run (or `-Force`) re-adds the
  bundle.

- **cmdbar alpha.14 - the rename, and the click that killed the dock**: two changes
  to the bottom dock, one cosmetic and one a real defect.
  *(The entries ABOVE this one are history and keep the old name, its routes and
  its `dst-` prefix where that is what those releases shipped; everything a person
  reads as the current state uses `dsh-cmdbar`.)*
  *The rename*: the package is **`dsh-cmdbar`** (the **command bar**) and was
  **`dsh-terminal`** through alpha.13. The old name described the emulator alpha.12
  deleted and collided with the harness's own `@deepseek-ai/dsh-terminal` PTY seam;
  what is left is exactly what the new name says. The package folder, the row
  (`terminal` -> `cmdbar`), the **ONE route** (`/api/dsh-terminal/activity` ->
  `/api/dsh-cmdbar/activity`), the `data-dsh-terminal-*` attributes ->
  `data-dsh-cmdbar-*` and the CSS prefix (`dst-` -> `dsc-`, which also ends the
  accident that dsh-themes' own `.dst-button` shared a namespace with this
  package's `.dst-btn`) all moved together. The shared `dockHeight` field in
  **dsh-ui-state** deliberately did **not** move: that key is the pack's own, and
  renaming it would have thrown away the height every reader had already chosen.
  The harness packages this bundle only MENTIONS (`dsh-terminal-bash`,
  `@deepseek-ai/dsh-client-ui-sidebar-terminal`) and the one harness tool it names
  (`terminal_send`) are untouched.
  *The defects*, which are why this release is not only a rename: **clicking a
  command line made the whole panel disappear**, and so did either of the row's
  copy buttons, and the header button could not bring it back. Both are the same
  mistake — a name used but never declared. Expanding a row evaluated
  `expanded && multiLine ? … : null`, and `multiLine` was declared **nowhere** in
  the bundle; the copy actions called `writeClipboard(text)` **bare**, which is the
  name of a `@deepseek-ai/dsh-client-ui-primitives` export the bundle already
  requires for `Tooltip`. Each threw a `ReferenceError` out of a render/click —
  and a slot occupant is wrapped in the shell's `SlotErrorBoundary`, which for a
  root-scoped entry such as this dock's `shell.overlay` seat reports the crash with
  `abdicate: true`: the entry is **retired** and every later render skips it while
  the boundary draws its own `data-slot-error` box in the panel's place. No static
  render and no check could have caught either one (a row starts collapsed, so the
  first condition short-circuited before the identifier was read, and a click is
  what reaches the second). The full command an expanded row shows is now decided
  by a pure `commandBody(entry, expanded)` (exported through `__internals`), the row
  draws its body from it, the write goes through the qualified
  `primitives.writeClipboard` (guarded, and **Copied** only for a write the host
  accepted), the tracked check **drives** the three command-body cases and asserts
  both free identifiers are gone outside prose, and the pack-wide primitive scan
  grades `writeClipboard` against the real pinned package. The second one was found
  by auditing the bundle for identifiers it references and never declares.
  **What an installed profile needs**: one install run (`scripts\install.bat` /
  `./scripts/install.sh`, or `-Force`) and a restart, because the bundle's NAME
  changed - the profile's bundle list and its live links still name `dsh-terminal`
  until then - followed by a hard refresh (Ctrl+F5). The dock's bar prints
  `dsh-cmdbar 0.1.0-alpha.14`.

## Alpha policy

Every package under `packages/` ships with an `-alpha.<n>` suffix. "Stable"
promotion happens only when the owner says so (edit the package `version`,
`.dsh-version.json`, and this table), then re-run the installer with `-Force`.
