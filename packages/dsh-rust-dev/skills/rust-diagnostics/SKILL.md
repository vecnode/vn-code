---
name: rust-diagnostics
description: Reading what rustc and clippy actually say - how a diagnostic is structured (level, code like E0308, the primary span, help/note/suggestion), the fifteen error codes a Rust developer meets weekly and the first fix for each, why clippy lints have names instead of codes, lint levels and why `#[expect]` beats `#[allow]`, `-D warnings` in CI, MSRV (`rust-version`) and how a newer lint breaks an older toolchain, and why the FIRST error is the one to read.
whenToUse: Use when a build or check has errors and the next move is not obvious, when quoting a diagnostic to a person, when deciding whether to fix or suppress a warning, when a `-D warnings` CI run fails on a lint that looks harmless, or when a toolchain bump starts failing on code that did not change.
---

# Reading a Rust diagnostic

A diagnostic is a structured report, not a text blob: it has a level, usually a
code, spans with byte-precise locations, and often a machine-applicable
suggestion. Reading it in the right order is the difference between one fix and
a dozen guesses.

## The shape of one

```text
error[E0308]: mismatched types
 --> src/parse.rs:7:18
  |
7 |     let port: u16 = "8080";
  |               ---   ^^^^^^ expected `u16`, found `&str`
  |               |
  |               expected due to this
  |
help: parse it instead
  |
7 |     let port: u16 = "8080".parse().unwrap();
  |                     +++++++++++++++++++++++
```

| part | what it is |
|---|---|
| `error` | the level: `error`, `warning`, `note`, `help`. Only `error` fails a build |
| `[E0308]` | the code. Stable, documented, and searchable offline with `rustc --explain E0308` |
| `mismatched types` | the message. It names the two types in the spans, not here |
| `--> src/parse.rs:7:18` | file, line, column (1-based) of the PRIMARY span |
| `^^^^^^` | the primary span: where the error is |
| `---` | a secondary span: where the expectation comes from |
| `help:` / `note:` | the explanation and, when it carries a `+`/`-` diff, a suggestion `cargo fix` can apply |
| `warning: unused ...` | a level with no code. A lint name appears in the message instead: `unused_variables` |

Read it in this order: **code and message**, then the primary span, then any
`help`. The `--` / `^^` alignment is decoration; the `file:line:col` above it is
the fact, and it is what to quote.

## The fifteen codes you meet weekly

| code | the message | usual cause | first fix |
|---|---|---|---|
| `E0308` | mismatched types | `&str` where `String` is wanted, a missing `.parse()`, an integer of the wrong width | make the types agree, or convert once, explicitly |
| `E0277` | the trait bound is not satisfied | the type does not implement a needed trait (`Display`, `Clone`, `Send`, `Default`) | `#[derive]` it, implement it, or change the bound |
| `E0382` | use of moved value | a non-`Copy` value was moved, then used again | borrow it, clone it, or restructure so it is owned once |
| `E0499` | two mutable borrows at once | a `get_mut` in a loop, two `&mut` into one collection | `split_at_mut`, indices, or end the first borrow |
| `E0502` | mutable borrow while an immutable one is live | reading and mutating one collection in a single expression | compute the read first, then mutate |
| `E0505` | cannot move out because it is borrowed | moving a value a reference still points at | drop or end the borrow first, or clone |
| `E0507` | cannot move out of borrowed content | `*x` where `x: &T`, moving a field out of `&self` | `mem::take`, `mem::replace`, or borrow |
| `E0515` | cannot return a reference to a local | returning `&local` or a slice of a temporary | return the owned value |
| `E0597` | does not live long enough | a borrow outlives the value it points at | bind the value outside the borrow, or take ownership |
| `E0716` | temporary value dropped while borrowed | a temporary produced inside a chain dies at the end of the statement | bind the temporary to a `let` |
| `E0433` | failed to resolve: undeclared crate or module | a missing `use`, a feature not enabled, a dependency not declared | add the `use`, the feature, or the dependency |
| `E0425` | cannot find value in this scope | a typo, or an item behind `cfg` that is not on | check the name and the `cfg` |
| `E0061` | wrong number of arguments | the signature changed under you | the `help:` line prints the signature to copy |
| `E0596` | cannot borrow as mutable | the binding is not `mut`, or the value is behind `&` | `let mut` / `&mut`; interior mutability only if it is really needed |
| `E0658` | unstable feature | code written against nightly, compiled on stable | remove it, or pin nightly on purpose in `rust-toolchain.toml` |

Two of those deserve a sentence each, because their names are misleading:

- **`E0597` is a lifetime error but not usually a lifetime problem.** It says a
  borrow outlives its value; the fix is almost always to give the value a home
  (`let owned = ...;` then use `&owned`), not to add a lifetime parameter.
- **`E0716` looks like a lifetime error too**, and it is the same fix: bind the
  temporary. `let name = format!(...); let slice = name.trim();` compiles where
  `let slice = format!(...).trim();` does not.

## Clippy is a different vocabulary

rustc reports language errors with codes. Clippy reports SUSPICIOUS BUT VALID
code with NAMED LINTS - there is no `E` number for a Clippy lint.

```text
warning: this loop could be written as an iterator chain
 --> src/lib.rs:12:5
  |
12 | /     for value in values {
13 | |         out.push(value * 2);
14 | |     }
  | |_____^ help: consider using an iterator: `...`
  |
  = note: `#[warn(clippy::manual_map)]` implied by `#[warn(clippy::all)]`
```

The note names the lint and the group that enabled it (`clippy::all` by
default). Lint groups are not severity levels: `correctness` and `suspicious`
are warn-by-default, `style`, `complexity` and `perf` are in `all`, and
`pedantic`, `nursery` and `restriction` are opt-in.

```sh
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --fix --all-targets --allow-dirty
```

`--fix` applies the machine-applicable suggestions only. A lint with `help:
consider ...` and no diff is a judgement call, not a rewrite, and Clippy will not
make it for you.

## Lint levels, and why `expect` beats `allow`

| attribute | effect |
|---|---|
| `#[allow(lint)]` | silence it here and in nested items |
| `#[warn(lint)]` | the default for most lints |
| `#[deny(lint)]` | make it an error here |
| `#[forbid(lint)]` | make it an error and refuse any inner `allow` for it |

Levels are set per item, per module or per crate (`#![allow(...)]` at the top of
a file), and the innermost one wins. `#[allow]` on an expression works for many
lints; on a statement it covers the whole statement.

**`#[expect(lint, reason = "...")]` is the better spelling when you mean "this
is deliberate and should stop being true someday"** (Rust 1.81+). It silences
the lint AND warns with `unfulfilled_lint_expectations` when the lint stops
firing - so the day the code is fixed, the suppression is reported instead of
rotting in place. `#[allow]` can never tell you that it became dead.

```rust
#![allow(dead_code)]

// A suppression a reader can audit: the lint is named, and the reason is beside it.
// (Rust 1.81's `#[expect(unused_variables, reason = "...")]` is the better spelling:
// it fails the build when the lint STOPS firing, so a dead suppression cannot survive.)
#[allow(unused_variables)]
pub fn on_event(kind: &str, payload: &[u8]) -> usize {
    payload.len()
}
```

Prefer suppressing at the smallest scope that works. A crate-wide `allow` hides
a real bug in the next function; an item-level one names its target.

## `-D warnings` in CI, and the `[lints]` table

A warning is not a failure unless you make it one. Three ways, in order of
preference:

```toml
[lints.rust]
unsafe_code = "forbid"

[lints.clippy]
pedantic = "warn"
needless_return = "allow"
```

That table (Rust 1.74+) is checked in, applies to every invocation, and needs no
shell. The environment form is `RUSTFLAGS="-D warnings"`, which applies to every
crate including dependencies - useful for your own tree, hostile to a dependency
that emits a warning on a newer compiler. `#![deny(warnings)]` in a source file
is the worst option: it makes your crate fail on a warning added by a future
compiler you have not tried yet.

## MSRV, and the lint that breaks an older toolchain

`rust-version = "1.78"` in `[package]` is a promise cargo enforces: a build with
an older toolchain stops immediately with a message naming the requirement,
instead of failing somewhere inside a dependency with a parse error.

The trap is that clippy GROWS. A lint added in 1.83 fires on code that was clean
at 1.78, so a `-D warnings` job on the newer toolchain fails while `cargo check`
on the MSRV still passes. Three honest answers:

1. run `cargo check` on the MSRV toolchain and clippy only on stable, and say so
   in the CI file;
2. suppress the new lint by name at the smallest scope, with a reason;
3. raise `rust-version`, and say why in the same commit.

```sh
rustup toolchain install 1.78
cargo +1.78 check --all-targets
cargo +1.78 test --lib
```

A toolchain file makes the intent explicit rather than conventional:

```toml
# rust-toolchain.toml at the workspace root
[toolchain]
channel = "1.78.0"
components = ["rustfmt", "clippy"]
```

## Read the first error first

rustc reports many errors per run, and most of them are consequences. One
unresolved import produces a dozen `E0308`s: a type that failed to resolve
becomes `{unknown}`, and every use of it mismatches. Fixing the first error
often deletes the rest.

The practical order:

1. the first `error` in **cargo's** order, which is the member order and then the
   source order - not alphabetical;
2. if the first error is `E0433`/`E0425` (a name that does not exist), fix that
   before reading any type error after it;
3. re-run. Do not queue up twelve fixes from one run.

`--message-format=short` compresses to one line per diagnostic, which is how to
count them; the plugin's `cargo_check` does that in JSON and returns counts by
level plus the codes, so a repeated code is visible without reading 400 lines.

```sh
cargo check --workspace --all-targets --message-format=short
cargo check --workspace 2>&1 | grep -c '^error'
```

## The fixed pattern, for the borrow errors

The four errors that cost the most time are all about borrowing, and each has a
small canonical fix.

```rust
#![allow(dead_code)]

// E0502 - mutable borrow while an immutable one is live. The immutable borrow ends
// at its last use, so computing the value first is the whole fix.
pub fn bump_first_even(items: &mut Vec<i64>) {
    let first = items.first().copied().unwrap_or_default();
    if first % 2 == 0 {
        items.push(first + 2);
    }
}
```

```rust
#![allow(dead_code)]

// E0499 - two `&mut` into one Vec. `split_at_mut` produces two DISJOINT mutable
// borrows from one, which is what the borrow checker can actually prove is safe.
pub fn swap_halves(values: &mut [i32]) {
    let mid = values.len() / 2;
    let (left, right) = values.split_at_mut(mid);
    for (a, b) in left.iter_mut().zip(right.iter_mut()) {
        std::mem::swap(a, b);
    }
}
```

```rust
#![allow(dead_code)]

// E0515 / E0597 - a reference cannot outlive its value. Return the value, and let
// the caller borrow it: an owned String has no lifetime to get wrong.
pub fn shout(text: &str) -> String {
    let mut owned = text.to_uppercase();
    owned.push('!');
    owned
}

pub fn first_word(text: &str) -> &str {
    text.split_whitespace().next().unwrap_or("")
}
```

```rust
#![allow(dead_code)]

// E0507 - cannot move out of a shared reference. `mem::take` leaves a default
// value behind and hands the old one away, which is the move the compiler wanted.
#[derive(Default)]
pub struct Config {
    pub name: String,
    pub retries: u8,
}

impl Config {
    pub fn take_name(&mut self) -> String {
        std::mem::take(&mut self.name)
    }
}

pub fn describe(config: &Config) -> String {
    format!("{} ({} retries)", config.name, config.retries)
}
```

```rust
#![allow(dead_code)]

// E0277 - the trait bound. `format!` needs Display; Debug is not enough. Either
// implement the trait the code asks for, or derive the one it needs.
#[derive(Debug)]
pub struct Port(u16);

impl std::fmt::Display for Port {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "tcp/{}", self.0)
    }
}

pub fn announce(port: Port) -> String {
    format!("listening on {port}")
}
```

## What the tools answer

- `cargo_check` returns counts by level, the diagnostic CODES, `file:line:col` and
  the top N diagnostics - so a run of twelve `E0308` after one `E0433` is visible
  as exactly that, without reading the whole log.
- `cargo_build` returns the warning count of a successful build, which is the
  number to drive to zero before turning on `-D warnings`.
- `rust_status` tells you whether the component a message assumes (clippy,
  rustfmt) is even installed, and which toolchain is in use - a diagnostic that
  quotes a lint you cannot reproduce is usually a different toolchain.

## What not to do

- Do not fix the last error in a run first. It is usually a consequence.
- Do not quote a diagnostic without its code and its `file:line:col`; that is
  what makes it searchable and reproducible.
- Do not reach for `#[allow]` before reading the `help:`. The compiler's
  suggestion is right more often than the first instinct to silence it.
- Do not add `#![deny(warnings)]` to a crate. Adding a lint in a later compiler
  is not a semver-compatible change to your code.
- Do not paste a `help:` diff into someone else's file by hand: `cargo fix` and
  `cargo clippy --fix` apply the machine-applicable ones, and refuse the ones
  that are judgements.
- Do not treat a `-D warnings` failure on a newer toolchain as a code bug before
  checking whether the lint is simply new.
