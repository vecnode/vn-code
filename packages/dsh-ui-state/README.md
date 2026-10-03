# dsh-ui-state (alpha.2)

**UI state that outlives the process**, for the web GUI and the desktop window alike: one host-owned settings form holds the things a reload would otherwise forget, one browser half binds it, restores the two column widths, and publishes the **`uiState`** client service the pack's other halves write through.

Browser storage is per **origin** and per browser **profile**, so a Chrome tab and the desktop window's WebView never share it, even at the same port. The profile's own Cordis patch is one document both hosts read.

## What it adds

The `ui-state` row declares its own `.volatile()` `Config`. The Host projects every volatile field into a settings form keyed by that entry id and persists an accepted write into `$DSH_HOME/profiles/web/cordis.patch.yml` under the entry's `config:`. A fresh install writes no `config:` block at all: every field carries a schema default.

| Field | Default | Owner |
|---|---|---|
| `pageZoom` | `100` | [`dsh-themes`](../dsh-themes) — the header's Page-zoom control |
| `theme` | `''` | [`dsh-themes`](../dsh-themes) — an **extension** theme id (Nord / Monokai / Hacker) |
| `dockHeight` | `280` | [`dsh-cmdbar`](../dsh-cmdbar) — the bottom dock |
| `sidebarWidth` | `-1` | this package — the left column |
| `rightbarWidth` | `-1` | this package — the right bar |

Two conventions: **a negative width means "never recorded"**, deliberately not `0`, because for the sidebar `0` is a real state (collapsed) and is restored through ui-layout's toggle rather than its width setter; and **`theme` holds an extension theme only**, because `light`/`dark`/`system` are already durable in ui-theme's own form and duplicating a preference would give one setting two owners.

There is deliberately **no field for the terminal dock's open state**: the panel is the window onto a *process*, and reopening it after the server's five-minute PTY retention lapsed would start a shell nobody asked for. The desktop shell's window geometry lives separately, in `$DSH_HOME/vncode/window.json`, because the size must be known before the window is built.

## How it plugs in

`lib/index.js` declares the `Config` (every field `.volatile()`), answers `webserver/index-inject` with one inline script carrying the remembered page zoom immediately after the opening body tag so the level is in force for the first paint, and calls `settings.configure({ auto: false })` through `ctx.inject(['settings'], …)` so no settings page is generated from those fields. The script writes both the `zoom` declaration and the `data-dsh-page-zoomed` marker, which is the gate `dsh-themes`' right-bar seam fix keys on. With no schemastery new enough to carry `.volatile()`, the row **warns and degrades** — nothing is remembered — rather than failing the boot.

Schema is resolved at runtime with `createRequire`, never imported: the profile installs each bundle as a **live link**, so a bare `import '@deepseek-ai/schemastery'` fails with `ERR_MODULE_NOT_FOUND`. The anchors are `process.argv[1]`, then `$DSH_HOME/profiles`; every resolved copy is probed for `.volatile()` itself, because the 3.18.2 build an older line installed lacks it.

`lib/client.js` binds that form (`ctx.configForms.get('ui-state')`) **once** — three bundles binding it independently would each fence their writes on their own revision — and publishes **`uiState`** (`get` / `set` / `unset` / `subscribe` / `snapshot` / `status`), which `dsh-themes` and `dsh-cmdbar` reach **lazily** through `ctx.get`, never in their `inject`, so each still works in a profile without this package. `set` is safe before the transport is ready (replayed when the first section arrives) and with none at all; `unset` exists because clearing is not overwriting.

The two column widths are this package's job because `ctx.layout` exposes no width setter: the store is reached the way ui-layout's own `AppFrame` reaches it, through the **`root` slot registration**, which carries the store handle. That is the one core store this pack writes, so it is guarded twice — the handle must look like a layout store before anything is touched, and a shape it does not recognise means "remember nothing" rather than "run blind".

## Limits

- Widths go to the store's own setters **unclamped**: it clamps to its drag range and to 70% of the frame itself. A remembered `0` goes through `toggleSidebar()` because `setSidebar(0)` clamps to 264. Below ui-layout's 1024px auto-collapse width the sidebar is not restored at all.
- A plugin-owned session event is not an option (`dsh-session-persistence` refuses an unknown type unless the envelope carries `ignorable: true`, which `Session.append()` cannot set), and `ctx.storageDomain` needs a projection the browser cannot read.
- The row id (`ui-state`), the Node half's `ENTRY_ID` and the client's `ENTRY_ID` must stay equal. A mismatch is silent: the form answers `unavailable` and the pack remembers nothing.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

## Install

The repo launcher (`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux) auto-discovers this package — it is a standard `dsh.bundle`, so a bundle the profile does not list yet is added by one plain launcher run (no `-Force`). The web profile links it into this repo, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard browser refresh.
