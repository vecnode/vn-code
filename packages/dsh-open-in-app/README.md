# dsh-open-in-app (alpha.1)

**Open In: file managers.** The Session header's shipped **"Open In…"** split button opens the workspace directory in an installed editor, Git GUI, terminal or file manager. On a host where the shipped **File Explorer** / **Finder** / **Files** entry does nothing — the shipped launcher hands the directory to the OS shell's *open verb* (`Invoke-Item` through `powershell.exe` on Windows), which reports success as soon as the helper exits, even when nothing reached the desktop — this package takes the file managers over and opens the OS's own file browser **directly**.

## What it adds

| | |
|---|---|
| **Left to the shipped plugin** | the whole UI (the split button, the remembered choice, the menu, the icons) and the application **catalog** — VS Code, Cursor, JetBrains IDEs, Git GUIs, Windows Terminal, Git Bash still resolve and launch through the shipped host row, which stays mounted and untouched |
| **Taken over** | the three **file-manager** catalog ids (`explorer`, `finder`, `filemanager`): the forked browser bundle posts them to this package's own route |
| **The difference** | how that one launch happens: an argv spawn of the OS's file browser instead of the shell's open verb |

| Platform | Command |
|---|---|
| Windows | `%SystemRoot%\explorer.exe <dir>` (absolute, so a hijacked PATH cannot shadow it; Explorer's delegated `exit 1` counts as handed over) |
| macOS | `open <dir>` |
| Linux | `xdg-open <dir>` |
| WSL | `wslpath -w <dir>` then the Windows `explorer.exe` |

The child is spawned **detached** with no stdio, and a short watch window classifies the attempt: an early spawn error or a nonzero exit is reported as a failure (HTTP 502, which the button paints as its red error state) instead of a silent success; a child still running when the window closes counts as launched and keeps running.

| Route | What it does |
|---|---|
| `POST /api/dsh-open-in-app/open` | `{app, path}` → opens `path` in this platform's file browser |

It registers through the composition's `connection` service like every other pack route, so the browser authentication and the Host/Origin fence are the same ones. On top of that the body is validated at the wire: a JSON object, one of the three file-manager ids, and an **absolute path naming an existing directory**. The launcher only ever spawns an argv array, never a command string.

## How it plugs in

`cordis.patch.yml` hard-disables the shipped client row `ui-open-in-app` and inserts the pack's `native-open-in-app` row, which owns both halves: the forked browser bundle and a dependency-free Node route. The shipped **host** row (`open-in-app`) is deliberately left alone. Removing this package with the uninstaller also removes its patch layer, which brings the shipped client row back on the next restart.

`lib/client.js` is a **generated fork** of the shipped `@deepseek-ai/dsh-client-ui-open-in-app` bundle, never hand-edited: `scripts/sync-vendored.ps1` holds its patch list — the pack route constant, the file-manager id set, and the one line of `launch()` that chooses between the two routes — and fails loudly when a harness bump moves the code it patches.

## Limits

- Only the three file managers are re-routed. Everything else in the "Open In…" menu behaves exactly as shipped.
- A launch that cannot be classified as started within the watch window is reported as a failure rather than assumed successful; the same window is why a launcher that legitimately keeps running counts as handed over.
- The route accepts no relative path and no path that is not a directory.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

`check-node-routes.mjs` drives the launcher's wire validation and the status a real launch answers; the actual window is behind `DSH_CHECK_LAUNCH=1`.

## Install

The repo launcher (`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux) auto-discovers this package — it is a standard `dsh.bundle`, so a bundle the profile does not list yet is added by one plain launcher run (no `-Force`). The web profile links it into this repo, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard browser refresh.

## Layout

```
cordis.patch.yml   bundle layer: disables the shipped 'ui-open-in-app' row and
                   inserts the pack's 'native-open-in-app' row
lib/index.js       Node half: the launcher route above (node builtins only)
lib/client.js      Browser half: GENERATED fork (do not edit; re-sync instead)
```
