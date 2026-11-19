---
name: rust-debugging
description: The triage order for a Rust program that misbehaves - panic versus Result versus unwrap, RUST_BACKTRACE=1 versus full, how to read a backtrace (std at the bottom, your frames near the top, __rust_begin_short_backtrace as the boundary), why a panic in a thread can vanish, dbg! versus println! versus tracing with RUST_LOG, isolating a failure into one #[test] with --nocapture, reproducing with --release when it only fails there (overflow checks, debug assertions, different optimizations), and when reading a macro expansion is the only way to see what is real.
whenToUse: Use when a Rust program panics, returns an error nobody explained, prints nothing where output was expected, only fails in a release build, only fails in a test, or when a backtrace needs to be turned into a file and a line before anything is changed.
---

# Debugging a Rust program

Rust fails loudly and in a small number of shapes. Knowing which shape you are in
is most of the work: a panic, a `Result` nobody checked, a test that was filtered
out, or an optimized build where the thing you were watching was compiled away.

## A panic is a report, not a crash

A panic unwinds by default: it walks back through the stack, runs destructors,
prints a message to **stderr**, and the main thread exits with status **101**. The
message is the whole diagnosis unless a backtrace was asked for.

| spelling | what it does | when to use |
|---|---|---|
| `x.unwrap()` | panics with the `Debug` of the error | a fixture, a test, an example - never a request |
| `x.expect("loading the config")` | panics with YOUR words plus the `Debug` of the error | a real invariant, where the message names what was being done |
| `?` | returns the error to the caller | anything a caller could handle |
| `panic!("...")` | unwinds on purpose | an impossible state, not an expected failure |
| `todo!()` / `unimplemented!()` | panics with a marker | a branch you have not written yet |

The difference between `unwrap` and `expect` is not style: a bare
`called `Result::unwrap()` on an `Err` value: ...` says nothing about which of
twelve unwraps fired, and the backtrace is what you will need to find out.

```sh
RUST_BACKTRACE=1 cargo run
```

`RUST_BACKTRACE=0` (or unset) prints the one-line panic plus a note. `1` prints a
resolved stack. `full` prints every frame including std's, with addresses - longer
and noisier, and sometimes the only version that shows a frame that `1` dropped.

In a release build the default has no debug info, so `1` prints frames **without
file and line**. `debug = 1` fixes that without the size of a full debug build:

```toml
[profile.release]
debug = 1     # line tables only: readable backtraces, a small binary
```

## Reading a backtrace

```text
thread 'main' panicked at src/parse.rs:9:37:
called `Result::unwrap()` on an `Err` value: ParseIntError { kind: PosOverflow }
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

```text
   0: rust_begin_unwind
             at /rustc/06e4d1a1c9ff.../library/std/src/panicking.rs:645:5
   1: core::panicking::panic_fmt
   2: core::result::unwrap_failed
   3: app_cli::parse_port
             at ./src/parse.rs:9:37
   4: app_cli::main
             at ./src/main.rs:4:5
   5: core::ops::function::FnOnce::call_once
   6: std::sys::backtrace::__rust_begin_short_backtrace
   7: std::rt::lang_start::{{closure}}
   8: main
   9: __libc_start_main
```

Read it bottom-up if you like, but the positions are the point:

1. **Frame 0 is innermost** - the panic itself. Frames are printed from the
   panic outward toward `main`.
2. **Your frames are the ones with `./src/...`**, and they sit just above the
   boundary. `app_cli::parse_port` and `app_cli::main` are the code to look at.
3. **`__rust_begin_short_backtrace` is the boundary.** Below it is std's runtime
   (`std::rt::lang_start`, the C `main`, `__libc_start_main`): machinery you never
   wrote and cannot fix. Above it, in a `full` backtrace,
   `__rust_end_short_backtrace` marks the other end, just under the panic
   plumbing. Everything between the two markers is the short backtrace - the part
   that is yours.
4. **The `at` line tells you whose code it is:**

| path in the frame | what it is |
|---|---|
| `./src/parse.rs` | your crate |
| `/rustc/<hash>/library/std/src/...` | the standard library, built with the toolchain |
| `~/.cargo/registry/src/.../<crate>-<version>/...` | a dependency |
| `~/.cargo/git/checkouts/...` | a git dependency |

A frame with no `at` line was inlined, or its crate was built without debug info.

`rust_backtrace` does this reading for you: it demangles the symbols (both the
legacy `_ZN...` mangling and the newer `_R...` v0), attaches `file:line` where the
toolchain recorded it, and separates **your workspace frames** from dependency
frames - which is the distinction that decides whether the bug is in your call or
in somebody else's library.

## A panic in a thread can vanish

`std::thread::spawn` returns a `JoinHandle`, and the panic inside the thread is
captured and delivered to whoever **joins**. If nobody joins, the process exits
with the main thread's status - which is `0` - and the only evidence is the panic
message printed on stderr by the panicking thread.

```rust
#![allow(dead_code)]

// A panic in a worker thread does NOT fail the process. `join` is what turns it into
// a value you can report; without a join, the exit status is main's, and the message
// on stderr may be the only trace of the failure.
pub fn double_first(items: Vec<u32>) -> Result<u32, String> {
    let handle = std::thread::spawn(move || {
        let first = items.first().copied().expect("the list is empty");
        first * 2
    });
    handle.join().map_err(panic_message)
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}
```

The payload is `Box<dyn Any + Send>` and it is **either** a `&'static str` (a
`panic!("literal")`) **or** a `String` (a `panic!("formatted {}", x)`), which is
why a downcast has to try both.

`catch_unwind` is the same boundary for code that cannot afford to die:

```rust
#![allow(dead_code)]

use std::panic::{catch_unwind, AssertUnwindSafe};

// The other boundary: an unwind becomes a `Result`, so one bad input does not take
// the process with it. `AssertUnwindSafe` is a promise that a half-updated value is
// acceptable after the unwind - a promise, not a check.
pub fn guarded(input: &str) -> Result<u32, String> {
    catch_unwind(AssertUnwindSafe(|| {
        input.parse::<u32>().expect("not a number")
    }))
    .map_err(|payload| {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned()))
            .unwrap_or_else(|| "non-string panic payload".to_owned())
    })
}
```

Both mechanisms are gone under `panic = "abort"`: there is no unwind to catch, and
a panicking thread aborts the process. If a build has `panic = "abort"`, a
vanishing thread cannot be recovered, only logged.

## `dbg!` versus `println!` versus `tracing`

| tool | goes to | prints | returns | use it for |
|---|---|---|---|---|
| `println!` | stdout | what you formatted | `()` | a program's actual output |
| `eprintln!` | stderr | what you formatted | `()` | a diagnostic that must not corrupt stdout |
| `dbg!` | stderr | `file:line:col`, the expression, the value | **the value** | a temporary look inside an expression |
| `tracing` / `log` | whatever the subscriber chose | a level, a target, structured fields, spans | `()` | anything you want to keep |

```rust
#![allow(dead_code)]

// `dbg!` writes to stderr, prints `file:line:col` and the expression, and RETURNS
// the value - so it fits inside an expression instead of beside it.
pub fn scale(values: &[i32]) -> Vec<i32> {
    let factor = dbg!(values.len().max(1) as i32);
    values.iter().map(|value| dbg!(value * factor)).collect()
}
```

`dbg!` is the right tool for ten minutes and the wrong one for a codebase: it
cannot be turned off, it has no level, and it serializes every value it touches.
Remove it before finishing - `grep -rn 'dbg!' src/` is the whole check.

`tracing` is the one that survives into production. The important difference from
`println!` is not the levels: it is that a `tracing` event can carry typed FIELDS
and live inside a SPAN, so a log line says which request it came from.

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

```sh
RUST_LOG=debug cargo run
RUST_LOG=info,my_crate=trace,h2=off cargo run
```

`RUST_LOG` is read by the `EnvFilter` the program installs, not by `tracing`
itself - a binary that never calls `tracing_subscriber::fmt().with_env_filter(..)`
ignores the variable entirely, and `println!` ignores it always.

## Isolate the failure into one test

A failing test is the cheapest reproduction there is: no UI, no arguments, no
services. Three flags do most of the work.

```sh
cargo test parse_port -- --nocapture
cargo test parse_port -- --exact --nocapture
cargo test --lib -- --test-threads=1
```

- the filter is a substring of the test PATH, so `cargo test parse` runs every
  test whose module or name contains `parse`;
- `--nocapture` keeps the test's stdout/stderr instead of hiding it under the
  harness - without it a `println!` inside a passing region never appears;
- `--test-threads=1` is for a test that shares a resource (a port, a file, an env
  var) and fails only when run beside its siblings.

```rust
#![allow(dead_code)]

pub fn parse_port(text: &str) -> Result<u16, String> {
    text.trim()
        .parse::<u16>()
        .map_err(|err| format!("{text:?} is not a port: {err}"))
}

#[cfg(test)]
mod tests {
    use super::parse_port;

    #[test]
    fn rejects_a_value_too_large_for_u16() {
        assert!(parse_port("70000").is_err());
    }

    #[test]
    fn accepts_a_normal_port() {
        let port = parse_port("8080").expect("8080 is a port");
        assert_eq!(port, 8080);
    }
}
```

Write the failing case FIRST, at the smallest input that still fails, and run it
until it fails for the reason you think it does. A test that fails for a different
reason is not a reproduction.

## It only fails in `--release`

Three real differences, and one fake one:

| difference | dev | release |
|---|---|---|
| `overflow-checks` | on - `u8 + 1` at 255 **panics** | off - it **wraps** silently |
| `debug-assertions` | on - `debug_assert!` runs | off - compiled out entirely |
| optimization | none | inlining and reordering, which can expose UB or change its symptoms |
| `debug = false` | full debug info | frames without `file:line` unless `debug = 1` |

```rust
#![allow(dead_code)]

// The same expression, two profiles: `+` panics on overflow in dev and wraps in
// release, because `overflow-checks` follows the profile. `wrapping_add` says which
// one you meant.
pub fn add_one(value: u8) -> u8 {
    value.wrapping_add(1)
}

// `debug_assert!` is compiled OUT of a release build, so a check that only exists
// there cannot catch a release bug.
pub fn checked_percent(part: u32, whole: u32) -> u32 {
    debug_assert!(whole > 0, "whole must be non-zero");
    if whole == 0 {
        return 0;
    }
    part.saturating_mul(100) / whole
}

pub fn profile_is_debug() -> bool {
    cfg!(debug_assertions)
}
```

To decide which of the three it is: rebuild with the checks turned back ON in
release. If the bug becomes a panic with a line number, it was checked arithmetic
or a debug assertion; if it stays a wrong answer, you are looking at
optimization-exposed undefined behaviour (`unsafe`, a stale `static mut`, a
transmute, an out-of-bounds raw pointer) - and then the tool is not a print
statement but `cargo miri` on nightly, which is a different investigation.

```sh
cargo run --release
cargo test --release
CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=true cargo run --release
```

## When only the expansion shows what is real

A macro error points at the invocation AND at the macro's own body, but never at
the code you would have written. `#[derive(Serialize)]` generating a failing impl
is the classic: the error names a type in a function you never wrote.

```rust
#![allow(dead_code)]

// A `macro_rules!` error points at the CALL SITE and then at the macro's own body,
// which is why an error inside a big macro is hard to read: the tokens that failed
// were never written on that line.
macro_rules! sum_of {
    ($($value:expr),+ $(,)?) => {{
        let mut total = 0_i64;
        $( total += $value as i64; )+
        total
    }};
}

pub fn totals() -> (i64, i64) {
    (sum_of!(1, 2, 3), sum_of!(4, 5,))
}
```

Four ways to see the generated code, cheapest first:

1. **`dbg!` inside the macro** (or a `compile_error!` in the arm you think fired) -
   no tooling, one rebuild.
2. **`cargo expand`** - the readable one. It is a separate binary the plugin does
   NOT install, so this is a command to hand the person: `cargo install
   cargo-expand`, then `cargo expand --lib path::to::module`.
3. **`-Zunpretty=expanded`** on a nightly toolchain:
   `cargo +nightly rustc --lib -- -Zunpretty=expanded`.
4. **The `--pretty=expanded`-style diff** is what a `cargo expand` section in a
   pull request is for: paste the expansion when the fix is "the macro did
   something surprising", because the next reader needs to see the tokens too.

## What the tools answer

- `cargo_test` returns the libtest summary, the failing test NAMES and the first
  failure's captured output - which is the `--nocapture` text you would otherwise
  have to re-run to see.
- `rust_backtrace` takes the panic output and returns demangled frames with
  `file:line`, workspace frames separated from dependency frames. Paste the raw
  backtrace; do not trim it, because the boundary frame is near the bottom.
- `cargo_build` with `run: true` executes the built binary and reports its exit
  code and output - the only one of the six that can observe a panic in a real
  run. On a host with no display, a GUI binary started this way fails with a
  windowing error rather than running.

## What not to do

- Do not add `println!` to a library that a test or a server uses; use `dbg!`
  during the investigation and remove it, or `tracing` for anything that stays.
- Do not read a backtrace from the top and stop at the first frame. The first
  frames are the panic machinery; the code is the first frame that names your
  crate.
- Do not call `.unwrap()` to "see the error" in code that will ship. It converts a
  recoverable failure into a process exit, and it discards the context that
  `.expect("what I was doing")` would have written.
- Do not debug a release-only bug in a debug build. Reproduce it where it happens
  first.
- Do not spawn a thread and drop its `JoinHandle` if its failure matters. That is
  how a failure becomes a missing log line.
- Do not chase a macro error by reading the macro. Expand it.
