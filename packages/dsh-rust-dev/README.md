# dsh-rust-dev

Rust development as a surface: six tools over **the machine's own** `cargo`,
`rustc` and `rustup`, and four skills that teach the triage order.

Host-only — one row (`rust-dev`), no route, no browser half, **zero npm
dependencies**, nothing bundled, nothing downloaded. `cargo`, `rustc` and `rustup`
are your programs; this package ships the parsers, the argv, and the judgement.

## Why it earns a row

You can already run `cargo` in a terminal. What a terminal cannot do is hand a
reader the **shape** of the failure:

- **volume** — a failing workspace build is thousands of lines. `cargo_check`
  returns the 6 distinct errors behind 1,100 lines, with their codes and
  `file:line:column`, and collapses one mistake repeated at forty call sites into
  one item with `seen x40`;
- **assembly** — "why is this crate compiled twice", "which feature pulled it
  in", "what is this binary made of" are three `cargo` invocations and a graph
  walk each. `rust_deps` answers them in one call;
- **judgement** — panic vs `Result`, `#[expect]` vs `#[allow]`, MSRV, when a
  backtrace is useless because the panic was caught. That is skill text;
- **your apps** — egui/eframe/wgpu have their own failure modes (a debug build of
  eframe is dramatically slower, the artefact lands under `target/<triple>/`, the
  GPU driver is the runtime's business). `rust-ui-apps` covers them.

## The four facts that fail independently

"Rust is broken here" is almost never one thing, so `rust_status` reports four
separately — the same shape `dsh-sql-server` uses for server/client/port/driver:

| Fact | Fails when |
|---|---|
| **toolchain** | no `cargo`, or a `rustup` default you did not expect |
| **components** | `clippy` / `rustfmt` / `rust-analyzer` were never added |
| **targets** | a cross-compile to a triple nobody installed |
| **workspace** | no `Cargo.toml`, or a `rust-version` above the installed toolchain |

`rust_status` also names the notable crates the workspace declares (`eframe`,
`egui`, `wgpu`, `tokio`, `tracing`, `serde`, `clap`, `tauri`, `bevy`) because they
change the advice. It builds nothing: every fact comes from a version probe,
`rustup component list`, or `cargo metadata --no-deps`.

## Tools

| Tool | Answer |
|---|---|
| `rust_status` | the four facts, the workspace members, MSRV vs installed, lockfile, notable crates. Read-only |
| `cargo_check` | `cargo check` / `cargo clippy` with `--message-format=json`, **parsed**: counts, distinct items, rustc codes, `file:line:col`, duplicates collapsed |
| `cargo_test` | the summary, the failing test names, the first failure's captured output; `filter` reproduces one test |
| `cargo_build` | success, artefact **path** and real size, warnings, elapsed; `run: true` executes it with an argv array |
| `rust_deps` | duplicate crate versions with their dependents, the most-depended-on crates, and the feature chain (`-e features -i`) for one crate |
| `rust_backtrace` | demangled symbols, frames classed as **yours / dependency / runtime**, and which frame is the first in your code |

Every answer names the command line it ran, whether it was offline, and what it
could not see.

## Skills

| Skill | Teaches |
|---|---|
| `rust-workspaces` | members and inheritance, `-p` vs `--workspace`, profiles and what `lto`/`codegen-units` trade, `target/` layout, `--locked`/`--offline`, feature unification, Cargo.lock discipline |
| `rust-diagnostics` | how a diagnostic is structured, the codes you meet weekly (`E0308`, `E0499`, `E0502`, `E0382`, `E0597`, …), clippy's named lints, lint levels, MSRV |
| `rust-debugging` | panic vs `Result`, reading a backtrace, caught panics, `dbg!`/`tracing`/`RUST_LOG`, isolating one test, release-only failures |
| `rust-ui-apps` | egui/eframe/wgpu: `App::update`, immediate mode, `Renderer::Wgpu` vs Glow, the dev-profile slowness and its fix, where the binary lands, cross-compiling, per-OS runtime needs |

Every ```rust example in them compiles as a whole `src/lib.rs` in a crate with no
dependencies — `checks/check-rust-examples.mjs` proves it on every run. Examples
tagged ```rust,ignore are the ones that genuinely need egui/eframe/wgpu; they are
capped at six and only allowed in `rust-ui-apps`.

## The rules this row does not bend

- **`cargo` executes code.** `build.rs` and dependency proc macros run on your
  machine during `cargo check`, so no tool here presents a build as a read-only
  inspection. `rust_status` tells you whether a build script exists; the skills
  tell you what that means.
- **No network the plugin starts.** Every cargo call runs **`--offline`** unless
  the caller passes `fetch: true` for that one call, and the answer says which it
  used.
- **Nothing is installed.** No `rustup toolchain install`, no `cargo install`, no
  `cargo publish`. A missing component is a command printed for you to run.
- **argv only, never a shell**, with a deadline and a **tree kill** (`taskkill
  /T` on Windows), because `cargo build` spawns `rustc` children that would
  otherwise keep writing into `target/` after the parent died.
- **A byte ceiling, reported.** An answer that quietly dropped half the
  diagnostics would be worse than a timeout.

## What it is not

Not a toolchain installer. Not a registry client. Not a language server —
`rust_status` reports whether `rust-analyzer` is installed and never drives it;
the pack owns leaves, not containers. Not a replacement for your shell.

## Checking it

```sh
node checks/check-rust-node.mjs      # the row, the parsers, and the tools driven
node checks/check-rust-examples.mjs  # every ```rust example compiled
```

`check-rust-node.mjs` runs against **captured** cargo output in
`checks/fixtures/` — a crate that does not compile, one whose test fails, and one
that panics at run time — and the fixture crates are committed beside the
captures, so the input is reproducible rather than described. The driven section
needs `cargo` and **skips loudly** without it.
