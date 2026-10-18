# The plan: one small controller, and the web half on its own

**Premise.** The interface is a web application served on loopback. `scripts\run-web.*`
already starts it, watches the ready line and opens the tab. What was missing was a way to
get from "a checkout on disk" to "a served page" in one command - and that was answered by a
native window with a web engine in it, which is 15 MB of program to avoid typing two
filenames.

This page is the plan that replaced it. It is not shipped behaviour: `app/README.md` is the
app, `docs/DEPLOY.md` is what a distribution promises.

## The measurements it was decided on

| what | before | after |
|---|---|---|
| `vncode.exe`, release | 15.51 MB | **0.50 MB** |
| of which the web engine (`wry` + WebView2/WKWebView/WebKitGTK) | 0.3 MB | 0 |
| of which the GUI stack (`egui`, `eframe`, `wgpu`, `naga`, `winit`, `accesskit`) | ~13 MB | 0 |
| crates | 5 | 3 |
| dependencies | 10 | 2 (`serde_json`, `rpassword`) |
| the self-contained release folder | 336.7 MB | none |

The first row is the one that decided the plan: **removing the web view alone saved 0.3 MB**.
The web view was never the weight - the window was. So "remove the webview" and "get small"
are two changes, and only the second one is worth anything.

## The shape

```
vncode ──spawn──▶ scripts/run-web.bat|.sh ──npx──▶ dsh web --no-open --port N
   │                        │
   │                        └─ ready line, loopback check, the tab
   └─ composed env: DSH_HOME, npm cache, temp; VNCODE_* removed
```

- **The app is a front door.** `start` (the default), `install`, `uninstall`, `status`, `key`.
  It decides the root and the home, takes the key, installs the pack with the same entry
  point a person clicks, and then runs the launcher in the foreground.
- **The launcher is unchanged and is not the app's.** `scripts/run-web.*` keeps the harness,
  the ready line, the token and the browser hand-off. Launching only the web must keep
  working with no `vncode` on the machine - that is the test that keeps the bridge honest.
- **Two release artefacts.** One `vncode` per OS (the only per-OS thing in the project) and
  one `vncode-web` for the node/JS half, which is the same bytes everywhere.

## What was NOT built, and why

- **A Rust installer.** The first draft reimplemented `install-all.ps1`'s profile reconcile,
  pnpm bootstrap and master-last ordering in Rust. It was dropped: those scripts are the
  contract, they are already cross-platform, and a second implementation of profile
  semantics is a second thing to be wrong. The app *runs* them.
- **A vendored runtime.** `vendor.ps1` and `release.ps1` materialised 554 MB of Node and
  harness so a folder could run with nothing installed. A controller that calls
  `scripts/run-web.*` needs none of it, and the folder it produced is what "very very big"
  meant. Both scripts were deleted.
- **Fetching the pack through npm.** That existed only because the app was going to be the
  installer. It is not: the web half ships as its own archive and the app runs it where it
  already is.

## What the cut removed

`crates/vn-shell-pane` (the engine), `crates/vn-shell-egui` (the panel),
`crates/vn-shell-paths` (the location map), `core::{pane, windowstate, firstrun, adopt,
appprefs, browser, status, urlpolicy}` and `runtime::{view, adopt}` - with the panel's
first-run cards, its four rows, its `Details` inspector, its log ring and its browser table.
`scripts/tools/{release,vendor}.ps1` and `scripts/checks/check-pane.mjs` followed.

What survived and why it is load-bearing: `home` (the two ladders), `appdata` (the root, the
write probe, the npm cache), `keystate` (four key layers, presence only), `launch` (the pin
and the tree's own root), `readyline` (the token and its redaction), `userpath`, `ports`,
`profile` and `env` (the one composer). Each is the record of a bug measured on a real
machine, and none of them needs a window to be useful.

## The rules the plan would not trade

1. **A child's environment is composed, not inherited.** A variable that is merely unset is
   still inherited; the app removes `VNCODE_HOME` and the console markers from every child.
   `check-shell.mjs` reads the child's own answer back.
2. **The key is asked for once, hidden, and never read back.** `rpassword`, one file, `0600`.
3. **The token is not the app's business.** It never appears in `app/`.
4. **`-Mode embed` fails by name.** Deleting a surface must not turn a flag into a silent
   default; it is a test, not a comment.
5. **The size is a budget.** CI fails over 6 MB, `check-shell.mjs` over 12 MB. A dependency
   that draws a window or a web view is the only way back over either line.

## What is still open

- `vncode open` - a second tab for an instance that is already running - would need the
  URL the launcher holds, which is the one thing this app deliberately does not read.
- A `vncode portable` verb, so the `.vncode/PORTABLE` marker does not have to be written by
  hand now that nothing draws the button that wrote it.
- macOS double-click (`.command`) and signing/notarization of the binaries; both are listed
  in `docs/DEPLOY.md`.
