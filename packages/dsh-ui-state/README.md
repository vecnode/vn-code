# dsh-ui-state (alpha.1)

**UI state that outlives the process**, for the web GUI and the desktop window
alike. One host-owned settings section holds the things a reload would otherwise
forget, and one browser half binds it, restores the two column widths, and
publishes the **`uiState`** client service the pack's other halves write through:

```js
const uiState = ctx.get('uiState')
uiState.set('dockHeight', 340)     // durable, host-side, shared by both hosts
uiState.get('pageZoom')            // -> 125
uiState.subscribe(rerender)        // fires when an accepted section arrives
```

Alpha.

## Why this exists

Everything that survives a restart survives because it already lives on the
**host**: `$DSH_HOME/sessions` holds the conversations (which is why a new chat
opens the last one), `$DSH_HOME/storages/workspace.json` holds the workspaces,
and `$DSH_HOME/settings.yaml` holds the shipped preferences. What the interface
keeps in the **browser** is per **origin** and per browser **profile**: a Chrome
tab and the desktop window's WebView2 are two different stores, so they never
share it — even at the same port — and the desktop shell prefers port 3080 and
falls back to a free one, so even one host loses it by moving a port. A settings
section is one document both hosts read. That is the whole idea.

## What is remembered

| Field | Default | Owner |
|---|---|---|
| `pageZoom` | `100` | [`dsh-themes`](../dsh-themes) — the header's Page-zoom control |
| `theme` | `''` | [`dsh-themes`](../dsh-themes) — an **extension** theme id (Nord / Monokai / Hacker) |
| `dockHeight` | `280` | [`dsh-terminal`](../dsh-terminal) — the bottom dock |
| `sidebarWidth` | `-1` | this package — the left column |
| `rightbarWidth` | `-1` | this package — the right bar |

The file is `$DSH_HOME/settings.yaml`, and a fresh install writes **no**
`vncode` section at all: every field carries a schema default, so only values
that actually differ from the contract are written.

There is deliberately **no field for the terminal dock's open state**. The panel
is the window onto a *process*: after a reload the client holds no slots, so
reopening it would either show an empty panel or — once the server's five-minute
PTY retention has lapsed — **start a shell nobody asked for**. A height is a
preference; "a shell was running" is not.

Two conventions matter when reading it by hand. **A negative width means "never
recorded"**, which is deliberately not `0`, because for the sidebar `0` is a real
state (collapsed) and a remembered `0` is restored through ui-layout's toggle
rather than its width setter. And **`theme` holds an extension theme only**:
`light` / `dark` / `system` are already durable in ui-theme's own namespace, and
duplicating a preference would give one setting two owners that could disagree.

## Why a settings namespace

A plugin-owned session event is not an option: `dsh-session-persistence` refuses
an unknown event type unless the envelope carries `ignorable: true`, which
`Session.append()` cannot set, so the conversation would become unreadable.
`ctx.storageDomain` cannot be used either — it needs a projection the browser
cannot read. A namespace is the documented third-party seam for a preference.

## The Node half

`lib/index.js` registers the `vncode` namespace and answers
`webserver/index-inject` with one inline script carrying the remembered page
zoom, placed immediately after the opening body tag so the level is in force for
the first paint. The script writes **both** the `zoom` declaration and the
`data-dsh-page-zoomed` marker, because that marker is the gate `dsh-themes`'
right-bar seam fix keys on. Should no copy of schemastery be reachable, the row
**warns and degrades** — nothing is remembered, and the client falls back to its
own defaults — rather than failing the boot.

## Why schema is resolved at runtime and never imported

This pack ships zero npm dependencies: the profile installs each bundle as a
**live link** into this repo, so a bare `import '@deepseek-ai/schemastery'`
resolves from the repo folder and fails with `ERR_MODULE_NOT_FOUND` (measured).
`settings.register` wants a schemastery schema, so the module is loaded at
runtime instead with `createRequire`, through the anchors
`packages/dsh-terminal/lib/pty.js` established for the harness's own `node-pty` —
`process.argv[1]`, then `$DSH_HOME/profiles`, which `dsh-app-boot` keeps as a
mirror of the installation's dependency closure. Duck typing is what makes that
safe: `dsh-settings` treats a schema as a function and reads `schema.toJSON()`,
so class identity never matters across the two module graphs.

## The browser half

`lib/client.js` binds that namespace **once** — three bundles binding it
independently would each fence their writes on their own revision, and the
contract's recovery for a stale revision is a reload that silently drops the
write — and publishes the client service **`uiState`**
(`get`/`set`/`unset`/`subscribe`/`snapshot`/`status`), which `dsh-themes` and
`dsh-terminal` reach **lazily** via `ctx.get`, never in their `inject`, so each
still works — and still writes its own `localStorage` copy — in a profile without
this package. `snapshot()` answers `{ status, value, defaults }` and `status()`
answers `loading` / `ready` / `unavailable` / `absent` (no transport); `set` is
safe before the transport is ready — the write is replayed when the first section
arrives — and safe with none at all, where it resolves without writing. `unset`
exists because clearing is not overwriting: picking a built-in theme after Nord
must **remove** the field so it reads as inherited again.

## Why the column widths are this package's job

ui-layout keeps them in a **transient** store — its own words — so a reload
returns the sidebar to its 280px contract default and the right bar to 45% of the
frame, and closing the sidebar forgets its drag width by design. `ctx.layout`
exposes no width setter, so the store is reached the way ui-layout's own
`AppFrame` reaches it: through the **`root` slot registration**, which carries the
store handle, and `store.create()` answers the same shared instance the frame
renders from. That is the one core store this pack writes, so it is guarded twice
— the handle must look like a layout store before anything is touched, and a
shape it does not recognise means "remember nothing" rather than "run blind".
Both widths go to the store's own setters **unclamped**: it clamps to its drag
range and to 70% of the frame itself, and a remembered `0` goes through
`toggleSidebar()` because `setSidebar(0)` clamps to 264. Below ui-layout's 1024px
auto-collapse width the sidebar is not restored at all: the rail is the layout's
decision, not a preference.

## Desktop window geometry

The desktop shell remembers its own window geometry separately, in
`$DSH_HOME/vncode/window.json` — written and read by the Rust shell itself
(`app/src-tauri/src/windowstate.rs`, whose pure half is covered by `cargo test`)
— because the size must be known *before* the window is built, and a Chrome tab
has no window geometry to share. A maximized recording keeps the previously known
size and position and flips only the flag.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'ui-state' row (nothing else patched)
lib/index.js       Node half: registers the `vncode` namespace, inlines the remembered zoom
lib/client.js      Browser half: binds the namespace, restores the column widths, provides `uiState`
```

No route, no fork, no core row disabled, no npm dependency.

## Install / uninstall

The repo launcher (`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle`, so a bundle the
profile does not list yet is added by one plain launcher run (no `-Force`
needed). The web profile links it into this repo, so code edits only need a
restart of `npx @deepseek-ai/dsh web` plus a hard browser refresh.
