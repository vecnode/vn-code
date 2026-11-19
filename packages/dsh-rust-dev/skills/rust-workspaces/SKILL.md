---
name: rust-workspaces
description: Cargo mechanics for a real workspace - [workspace] members and default-members, workspace inheritance (`workspace = true`), `-p` vs `--workspace`, the dev/release/test profiles and what opt-level / lto / codegen-units / debug actually trade, the target/ layout and --target-dir, --locked / --frozen / --offline, why build.rs and proc macros RUN during `cargo check` so a check is not a read-only inspection, feature unification and why two paths can enable different features of one crate, and Cargo.lock discipline (commit it for binaries, not for libraries).
whenToUse: Use before running any cargo command on a workspace, when a build picks a different profile or artefact than expected, when two crates disagree about one dependency's features, when a check fails with no network, when deciding what to commit of Cargo.lock, or before claiming that `cargo check` proved anything about a tree you did not write.
---

# Cargo workspaces

Cargo is three things in one binary: a resolver (what versions, what features), a
build driver (which profile, which target, which artefact) and the owner of the
directory everything lands in. Most confusing cargo answers come from the second
and third, not from rustc.

## The layout, and what each file owns

```text
repo/
  Cargo.toml            # [workspace] - members, resolver, the shared profile table
  Cargo.lock            # ONE lock, at the workspace root, shared by every member
  crates/
    core/  cli/  ui/    # each with its own Cargo.toml
  target/               # ONE target dir, workspace-wide
```

```toml
[workspace]
resolver = "2"
members = ["crates/*"]
default-members = ["crates/cli"]
exclude = ["examples/scratch"]
```

- **`members`** takes paths and globs. Everything it names is one `cargo build`
  away; every member shares the root `Cargo.lock` and the root `target/`.
- **`default-members`** is what a bare `cargo build` / `cargo test` at the root
  selects. Without it, the default is every member - which is why a workspace
  with a slow integration crate builds it every time. `-p` still reaches the
  others.
- **`resolver = "2"`** is required on a virtual workspace root (a root with no
  `[package]`) and is the default inside an edition-2021 package. It stops
  dev-dependencies, build-dependencies and normal dependencies from unifying
  their features, and stops a target-specific dependency from enabling a feature
  on a platform that is not being built. `resolver = "3"` is the edition-2024
  line and needs Rust 1.84 or newer.
- **`exclude`** keeps a directory out of the glob, which is what you want for a
  scratch crate that does not compile.

A member is one `Cargo.toml` with `[package]`, and it may be both a member and a
dependency of a sibling by path:

```toml
[package]
name = "app-cli"
version.workspace = true
edition.workspace = true

[dependencies]
app-core = { path = "../core" }
serde = { workspace = true }
```

## Inventory, then inheritance

Inheritance exists so one version, one edition and one `rust-version` are written
once. The workspace root holds the values; members opt in:

```toml
[workspace.package]
version = "0.4.0"
edition = "2021"
rust-version = "1.78"
license = "AGPL-3.0-only"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

```toml
[dependencies]
serde.workspace = true
tokio = { workspace = true, features = ["fs"] }
```

`workspace = true` inherits the version and the feature list and lets the member
ADD features - features are additive, so `features = ["fs"]` here and
`features = ["time"]` in another member means the final build of `tokio` has
both. There is no way to subtract a feature from a sibling's request; only
`default-features = false` on the declaration the workspace root writes can keep
a default set out of the graph.

A member cannot override an inherited key in the same table. `version = "0.4.0"`
and `version.workspace = true` in one `[package]` is an error, not a preference.

## `-p` versus `--workspace`

| invocation | selects |
|---|---|
| `cargo build` | `default-members`, or every member when that is unset |
| `cargo build -p app-core` | that package, plus whatever it depends on |
| `cargo build -p app-core -p app-cli` | both, and their shared dependencies ONCE |
| `cargo build --workspace` | every member |
| `cargo build --workspace --exclude app-ui` | every member but one (`--exclude` requires `--workspace`) |

`-p` takes the package NAME from its `Cargo.toml`, not the directory name -
`crates/core/` with `name = "app-core"` is `-p app-core`. `--all` is a deprecated
alias for `--workspace`; do not write new commands with it.

Building several members in one invocation is not just convenience: the
dependencies compile once and the lock is resolved once, so
`cargo check --workspace` is usually faster than three `-p` checks in a row.

```sh
cargo check --workspace --all-targets --offline
cargo check -p app-core --all-targets
cargo build --release --locked --offline
cargo tree -e features -i serde
cargo metadata --format-version 1 > metadata.json
```

## Profiles: what each key trades

Two profiles exist without any configuration - `dev` and `release` - and `test`
and `bench` inherit from them. The defaults that explain most surprises:

| key | `dev` | `release` | what it trades |
|---|---|---|---|
| `opt-level` | 0 | 3 | speed of the built code against compile time and debuggability |
| `debug` | `true` (full) | `false` | line tables and variable info; `false` makes a release backtrace nearly useless |
| `debug-assertions` | `true` | `false` | `debug_assert!` and some std internal checks |
| `overflow-checks` | `true` | `false` | **arithmetic on integers panics in dev and WRAPS in release** |
| `incremental` | `true` | `false` | rebuild speed against a small code-quality cost |
| `codegen-units` | 256 | 16 | parallelism of codegen against inlining; `1` is the slowest and best-optimised |
| `lto` | `false` | `false` | link-time inlining across crates; `"thin"` is the usual upgrade, `true`/`"fat"` the slow one |
| `panic` | `unwind` | `unwind` | `"abort"` shrinks the binary and removes `catch_unwind` |
| `strip` | `"none"` | `"none"` | symbol removal; `"symbols"` shrinks a release binary and erases a backtrace |

```toml
[profile.release]
lto = "thin"
codegen-units = 1
panic = "abort"
strip = "symbols"

[profile.dev]
# Keeps rebuilds incremental while making the hot dependency paths bearable.
opt-level = 1
```

Two facts that follow and that people hit weekly:

1. **`overflow-checks` is a behaviour difference, not a debugging aid.** A bug
   that only appears with `--release` is very often a wrap that panicked in dev.
   `[profile.release] overflow-checks = true` is how you find out.
2. **`debug = false` in release is why a release backtrace has addresses and no
   line numbers.** `[profile.release] debug = 1` gives line tables without the
   full variable payload.

`[profile.dev.package."*"]` applies a profile to DEPENDENCIES only, which is the
cheapest way to make a slow debug build usable without losing your own
breakpoints - the reason GUI builds need it is in `rust-ui-apps`.

## `target/`, and where the artefact actually lands

```text
target/
  CACHEDIR.TAG          # tells backup tools to skip this tree
  debug/                # dev profile, host triple
  release/              # release profile, host triple
  <triple>/debug/       # ONLY when --target was passed, even if it is the host triple
  <triple>/release/
  doc/                  # cargo doc
  package/              # cargo package
  tmp/                  # the scratch dir build scripts get as OUT_DIR's neighbour
```

`--target <triple>` moves the output under `target/<triple>/` **even when the
triple is the host's own**, which is the classic "my binary vanished" report: the
build succeeded and wrote somewhere else. The plugin's `cargo_build` reports the
path it actually used for this reason.

- `CARGO_TARGET_DIR` and `--target-dir <dir>` relocate the whole tree. One shared
  directory across checkouts saves gigabytes; it also means two toolchains write
  into the same fingerprints, so a `rust-toolchain.toml` bump invalidates it
  wholesale.
- Different feature sets share a directory without colliding, because features
  are part of the fingerprint. Do not assume "the same target dir" means "the
  same build".

## `--locked`, `--frozen`, `--offline`

| flag | lock file | network |
|---|---|---|
| `--locked` | must already be correct; cargo ERRORS instead of updating it | unchanged |
| `--offline` | may be updated, from what is already cached | refused; a missing crate is an error |
| `--frozen` | `--locked` | `--offline` |

`--frozen` is exactly `--locked` plus `--offline`, and it is the flag for a CI
job or a check that must be reproducible: it fails rather than silently resolving
a version nobody reviewed.

`CARGO_NET_OFFLINE=true` is the environment form of `--offline`, which is what
this plugin sets for every cargo call unless a tool is given `fetch: true`. That
is deliberate: a check that reaches the network is a check that fails on a plane,
on a locked-down runner, and on a machine whose registry credentials expired -
three failures that say nothing about the code.

The consequence to plan for: a crate that was never fetched cannot be checked
offline, and neither can a `build.rs` that downloads anything. The error names
the crate; the fix is a fetch, not a code change.

## `build.rs` and proc macros RUN during `cargo check`

This is the part that makes "just check it" unsafe on a tree you do not trust.

- A **build script** (`build.rs`) is compiled and EXECUTED before the crate is
  type-checked, because rustc needs its output: `cargo:rustc-link-lib`,
  `cargo:rustc-cfg`, generated source in `OUT_DIR`. It runs with your user's
  privileges, in your checkout, with the network available unless you refuse it.
- A **proc macro** is a separate crate compiled to a host library and LOADED INTO
  THE COMPILER PROCESS. `#[derive(Serialize)]` is arbitrary code running inside
  rustc, in the same process, on the same machine.

So `cargo check` on an unfamiliar dependency tree executes its build scripts and
its proc macros. It is a build with the backend skipped, not a read-only
inspection. The plugin never fetches or installs a crate, and every call is
offline for the same reason: the fewer new trees a check pulls in, the less of
this happens.

Two more consequences worth knowing:

- `cargo check` does **not link the final binary**. A missing system library
  (`-lssl`, a missing `.so`, a linker error) can pass `check` and fail `build`.
  "Check is green" means the types are right, not that the crate links.
- `cargo check --all-targets` additionally compiles tests, benches and examples
  of the members selected. Without it, a broken `#[cfg(test)]` module is
  invisible.

## Feature unification

Features are **additive** and cargo **unions** them per build. One crate in the
graph gets the union of every feature any dependent asked for.

```rust
#![allow(dead_code)]

// A feature can only ADD. This is the shape a compile-time flag selects, written as a
// trait so it compiles in one file: `cfg(feature = "fast")` would pick one impl at
// compile time, and nothing a second dependent does can take that impl away.
pub trait Parser {
    fn parse(&self, input: &str) -> Vec<u32>;
}

pub struct Strict;
pub struct Lenient;

impl Parser for Strict {
    fn parse(&self, input: &str) -> Vec<u32> {
        input.split(',').map(|part| part.trim().parse().expect("not a number")).collect()
    }
}

impl Parser for Lenient {
    fn parse(&self, input: &str) -> Vec<u32> {
        input.split(',').filter_map(|part| part.trim().parse().ok()).collect()
    }
}

pub fn total(parser: &dyn Parser, input: &str) -> u32 {
    parser.parse(input).iter().sum()
}
```

A `cfg(feature = "fast")` in a real crate picks ONE of those impls at compile
time, and additivity is what that means for a build: if `app-cli` asks for `fast`
and `app-core` never mentions it, the single `parse` that exists in that build is
the fast one, for both. `unexpected_cfgs` (a warning since Rust 1.80) is what
reports a `cfg` on a feature the crate never declared, which is how a typo like
`cfg(feature = "Fast")` becomes visible instead of silently false.

Why two paths can enable different features of one crate:

- `app-cli` asks for `serde/derive`; `app-core` asks for `serde` with defaults.
  The final `serde` has `derive` **and** the defaults, for both.
- A feature enabled by a dev-dependency can leak into a normal build **under
  resolver v1**. Under v2 it does not.
- `default-features = false` at ONE call site does not remove the defaults if
  another call site asks for them. Only the declaring table can do that, and it
  must do it everywhere or not at all.

```toml
[dependencies]
# Name a feature after the dependency it pulls, so `features = ["serde"]` cannot
# be confused with a feature that merely happens to be spelled the same.
serde = { version = "1", optional = true }
config = { version = "0.14", default-features = false, features = ["toml"] }

[features]
default = []
serde = ["dep:serde"]
# The `?` is a WEAK dependency: `config/extra` is only enabled if something else
# already enabled `config`, so this feature cannot drag it in on its own.
extra = ["config?/extra"]
```

`cargo tree -e features -i serde` answers "who enabled this and through what",
which is the question the plugin's `rust_deps` answers for a whole workspace -
including duplicate VERSIONS of one crate, which no feature query will show.

## `Cargo.lock` discipline

| what you are building | commit `Cargo.lock` |
|---|---|
| a binary, an application, a CLI, a GUI | **yes** - the lock IS the release |
| a library published to a registry | no - the consumer resolves it |
| a workspace containing a binary | yes, for the whole workspace |

- A lock file is per workspace, not per crate, and it pins every transitive
  version. Committing it is what makes `--locked` meaningful.
- `cargo update -p serde --precise 1.0.203` moves ONE package; `cargo update` at
  the root moves everything the semver ranges allow.
- The lock format has versions. A lock written by a newer cargo (version 4, Rust
  1.78+) makes an older toolchain refuse the tree with a message about the lock
  version. A workspace that supports an MSRV should generate the lock with that
  MSRV's toolchain, or state the floor.
- `cargo metadata --format-version 1` is a read-only dump of the resolved graph -
  packages, versions, features, targets, manifest paths. It is the input the
  plugin's dependency tools parse, and it needs no build.

## What the six tools answer

| question | tool | what it does NOT tell you |
|---|---|---|
| is there a toolchain, the right components and targets? | `rust_status` | whether the code compiles |
| what are the errors, by code and by file:line? | `cargo_check` | whether it links, or whether a test passes |
| did the tests pass, and which failed? | `cargo_test` | whether the binary works outside the test harness |
| what was built, how big, how long? | `cargo_build` | whether the app behaves correctly once running |
| which crates, which versions, which features brought them? | `rust_deps` | whether those versions are the ones you meant |
| what does this mangled symbol mean? | `rust_backtrace` | why the panic happened |

`rust_status` is four independent facts - toolchain, components, installed
targets, the workspace - because they fail independently: a missing `rust-src`
does not mean the compiler is absent, and a `Cargo.toml` with a typo parses as
"no workspace here" rather than as an error.

## What not to do

- Do not read a `cargo check` pass as "it builds". It did not link.
- Do not run `cargo check` on an untrusted tree expecting a read-only act. Build
  scripts and proc macros execute.
- Do not add `--offline` and expect a first-time build of a new crate to work;
  the crate has to be in the cargo cache already.
- Do not move the lock file, edit it by hand, or delete it "to fix a conflict".
  Re-resolve with `cargo update -p`, and commit the result.
- Do not assume `--target <host triple>` writes to `target/release/`. It writes
  to `target/<triple>/release/`.
- Do not compare builds made at different `opt-level` or `debug` settings and
  call the difference a performance change in your code.
