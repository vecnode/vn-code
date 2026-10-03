# `app/` - the native window launcher

The vncode web profile in a native window instead of a browser tab. It is a
**launcher, not a desktop edition**: it installs nothing, writes no profile file and
starts the same pinned `dsh web` that `scripts\run-web.bat` / `./scripts/run-web.sh`
start, showing **that** URL in a WebView2 / WKWebView / WebKitGTK window.
`scripts\run-desktop.bat` builds the shell when needed and runs it; on macOS/Linux run
`cargo build --release` in `app/src-tauri` and start the binary. A source checkout needs
the **Rust toolchain** ([rustup.rs](https://rustup.rs)) and Node.js 22+, which is also
needed to BUILD the vendored runtime and by the npx fallback.

## How it starts the harness

`choose_launch()` in `src/main.rs` is the whole decision. With a complete vendored
runtime present - `runtime/<rid>/`, produced by `scripts/dsh/vendor.ps1` - it runs
`node <runtime>/harness/.../lib/bin.js web --no-open --port N` directly: no npm, no
npx, no registry, nothing written to an npm cache. With none it falls back to
`npx @deepseek-ai/dsh@<pin> web --no-open` and sets `npm_config_cache` to this
application's own directory on that branch alone. Flags mirror `scripts\run-web.bat`
(`-Port`, `-DshHome`, `-DshVersion`, `-Help`), plus `-NoBuild`, `-NoPause` and
`-NoTerminal` for this launcher.

1. Walks up from the executable for `.dsh-version.json` and reads the pinned dsh
   version from it - there is no built-in fallback pin, so every build lands on the
   same harness a `run-web` tab uses.
2. Chooses the port: `-Port` when given, else 3080 if binding `127.0.0.1` there
   succeeds, else `127.0.0.1:0`. The URL loaded is the one the harness prints, so a
   wrong guess costs the origin and nothing else.
3. Restores the window geometry (below) before building the window, then opens the
   splash (`ui/index.html`), which names the harness home and whether a DeepSeek key
   was found there; after 45 s it says the wait is long and points at the console.
4. Runs the pinned CLI, streams its stdout and stderr to this console, watches for
   `dsh web: http://127.0.0.1:<port>/?token=<token>` and navigates the window there.
5. Kills the harness and its `npx`/`node` children when the window closes, and closes
   the window if the harness exits first. On Windows a **Job Object** with
   `KILL_ON_JOB_CLOSE` takes the harness down even on a crash; macOS/Linux can leak it.

## The window remembers its own geometry
One record at `$DSH_HOME/vncode/window.json` - `{version, width, height, x, y,
maximized}`, size inner and point outer in logical pixels - is read before the window
is built and written atomically (a temp sibling, then a rename) on a coalesced resize
or move and once at exit. A record this build cannot vouch for is DISCARDED rather
than repaired, an oversized dimension is clamped, a position counts only when both `x`
and `y` are present and a monitor still holds the point, and a maximized recording
keeps the last size and flips only the flag.

## The harness home, and the key

The shell hands the child a `DSH_HOME` only when `-DshHome` gave one or `DSH_HOME` was
**inherited**; otherwise it passes nothing and lets the harness apply its own default
(`~/.dsh`). It never derives one from `USERPROFILE`/`HOME`: `DSH_HOME` names the
harness's folder *under* the home, not the home itself.

`keystate.rs` answers "will the harness find my key" by walking the harness's own four
layers, highest first: the inherited environment (`DEEPSEEK_API_KEY`),
`$DSH_HOME/.credentials.yaml` (the ref is nested under `refs:`, not at the margin),
`<cwd>/.env`, then `$DSH_HOME/.env`. The splash gets a boolean and the layer's name,
**never the value**; the page has no IPC channel and no command.

## The two rules that must survive any edit

The ready line carries the **launch token**, a live credential for the running
process; both rules are pinned by tests in `src-tauri/src/readyline.rs`.

1. **The token is read in memory** - never written to a file, never handed to a shell,
   never echoed: the app's own output prints `token=REDACTED`.
2. **Only a loopback URL is opened.** A ready line naming any other host is refused and
   reported; a link clicked inside the app goes the other way round, and anything but
   the harness's own origin opens in the system browser.

If the harness never becomes ready, the window is retitled `vncode - the harness server
did not start (see the console window)` and the reason is printed: `npx` missing, an
unreadable pin, no free port, or 90 s without a ready line.

## Files
| Path | What it is |
|---|---|
| `src-tauri/src/main.rs` | the supervisor: flags, the repo/pin lookup, port and home choices, spawning, the window, the geometry write-back, the exit hook |
| `src-tauri/src/readyline.rs`, `windowstate.rs`, `keystate.rs` | the pure halves - the ready line and its refusals, the geometry record and its trust rules, the four key layers - each driven by `cargo test` and each keeping the token or the key value inside |
| `src-tauri/tauri.conf.json`, `ui/index.html`, `src-tauri/icons/` | the config (`bundle.active: false`, no declared window), the splash (`scripts/checks/check-splash.mjs` renders it in both states) and the icons generated by `node scripts/make-desktop-icon.mjs` from `assets/vncode.svg` |
