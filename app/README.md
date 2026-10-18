# `app/` - the vncode front door

One small console program (~0.5 MB) with no window and no web view. It decides four things
- the root, the harness home, the key and the pack - and then it runs the script a person
would run: `scripts/run-web.bat` on Windows, `scripts/run-web.sh` everywhere else, in the
foreground, with a composed environment and `-DshHome` so both halves agree about which
home is in use.

It is **not** a desktop edition and not a second harness: `scripts/run-web.*` needs none of
this and works on its own. What the app adds is one command from nothing to a served page.

```sh
cargo build --release --locked   # in this folder; the binary is target/release/vncode
./target/release/vncode status   # the facts, and nothing started
./target/release/vncode          # install if needed, key if needed, then run-web
./target/release/vncode -Help    # the verbs and flags
```

`scripts\run-desktop.bat` / `./scripts/run-desktop.sh` build it when it is missing and then
run it. A build needs the **Rust toolchain** ([rustup.rs](https://rustup.rs)) and nothing
else: there is no system library to install, which is what the size cut bought.

## What it does

| verb | what happens |
|---|---|
| *(none)* / `start` | **one press to a working instance.** If the home in use does not list the pack's bundles, `scripts/setup/install.*` runs first - it re-links the profile, so it must not run under a live harness, and nothing is running yet. Then, if no DeepSeek key is found in any of the four layers, it is asked for at the terminal (a piped run never blocks: it says so and continues). Then `scripts/run-web.*` is started in the foreground and owns everything from there |
| `install` / `uninstall` | the matching `scripts/setup/*` entry point, in this console, with the same environment the launcher gets |
| `status` | the pin, the root, the home and why it was chosen, the pack, which key layer answered, where the launcher is, and `node`/`npx` - then exits without starting anything |
| `key` | asks for `DEEPSEEK_API_KEY` and writes it into `<home>/.env`. The value goes from the terminal into one file and nowhere else: it is not printed, not logged, and not read back. The sentence names the FILE |

Flags: `-Port <n>` (handed to the launcher), `-DshHome <dir>`, `-DshVersion <ver>`,
`-Help`, `-Version`. There is **no `-Mode`**: `panel`, `chrome`, `headless` and `embed`
described a window this build does not have, and `-Mode embed` now fails *by name* rather
than quietly selecting a browser - a flag that silently means something else is a flag
nobody can trust.

## The bridge

```
vncode ──spawn──▶ scripts/run-web.bat|.sh ──npx──▶ dsh web --no-open --port N
   │                        │
   │                        └─ watches the ready line, opens the tab (Chrome first)
   └─ composed env: DSH_HOME, npm cache, temp; VNCODE_* removed
```

The app never starts node, never binds a port, and never touches the launch token. The
`-NoTerminal` flag it passes on Windows is the one that matters: without it the console
layer may relaunch the run into a Windows Terminal window this process would not wait for,
and the app would report an instant, silent success.

## The crates

| crate | what it is |
|---|---|
| `crates/vn-shell-core` | the **pure** halves, each driven by `cargo test`: `home` (the two ladders), `appdata` (the root, the home inside it, the write probe, the npm cache), `userpath` (what a person typed, turned into a path a child may be given), `keystate` (the four key layers, presence only), `launch` (the pin and the tree's own root), `readyline` (the token, and its redaction), `options` (the verbs and flags), plus `ports`, `prefs`, `profile`, `log` |
| `crates/vn-shell-runtime` | the decided facts: `plan` (which home, which pin, which cache, which temp), `env` (the one composer every child's environment comes from) and `setup` (the runner behind `install`/`uninstall`) |
| `crates/vn-shell` | the binary (`vncode`): the verbs, the key prompt and the bridge |

The load-bearing modules were **moved** from the old Tauri launcher rather than rewritten,
comments and tests included: `readyline.rs`, `keystate.rs` and `appdata.rs` are each the
record of a bug that was measured on a real machine.

## The modules that are gone, and why they are not coming back

`wry` (and with it WebView2, WKWebView and WebKitGTK), `egui`/`eframe`/`wgpu`/`winit`, the
panel, the window record, the first-run cards, the browser table and the location map: 13
of this binary's former 15 MB, and every one of them existed to draw something that is not
this app's to draw. The interface is a web application served on loopback; the browser
already on the machine shows it.

The size is enforced rather than hoped for: CI fails a build over **6 MB**, and
`check-shell.mjs` fails over 12 MB. A dependency that draws a window or a web view is the
only way back over either line.

## The rules that must survive any edit

1. **The key is never printed.** A layer NAME, never a value; written to one file, `0600`
   on POSIX, atomically, and never read back.
2. **A child's environment is composed, not inherited.** A variable that is merely unset is
   still inherited - which is how `VNCODE_HOME` once reached the harness, and how a leaked
   `VNCODE_CONSOLE` once turned `-Help` into a full install.
3. **The launcher is the only thing that starts node**, and it is the same file a person
   runs. If the app needs a harness command, it asks `scripts/run-web.*`, never a copy.
4. **The token is not this app's business.** It is read in memory by the launcher, opened
   only on a loopback host, and handed to a browser as one argv element.

## Files

| Path | What it is |
|---|---|
| `Cargo.toml` | the workspace: three crates, two dependencies (`serde_json`, `rpassword`), and the release profile the shipped binary is built with (`lto`, `strip`, `panic = "abort"`, one codegen unit) |
| `crates/vn-shell/src/main.rs` | the verbs, the key prompt, the bridge |
| `crates/vn-shell-runtime/src/lib.rs` | `plan`: the home, the pin, the cache, the temp, and the notes |
| `crates/vn-shell-runtime/src/env.rs` | the ONE composer: what is set, what is removed, the working directory |
| `crates/vn-shell-runtime/src/setup.rs` | the runner behind `install` and `uninstall` |
| `crates/vn-shell-core/src/*.rs` | the pure rules, one module per question, each with its tests |
