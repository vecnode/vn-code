# port/ — vncode's core in Rust

The Rust side of vncode, ported from the pinned harness line. The plan, the
boundary rule and the phase gates live in [`docs/RUST-PORT.md`](../docs/RUST-PORT.md);
this page is only what is true about the folder.

**Nothing here ships yet.** There is no `Cargo.toml` on purpose: `cargo` at this
directory does not become a second workspace until P2, and until then the folder
holds the plan's artifacts only.

## Rules that hold here

- **A separate workspace from `app/`.** `app/` is the front door — three crates,
  std plus `serde_json` and `rpassword`, a 6 MB CI size ceiling. Nothing from
  `port/` is linked into it, and a ported crate may use crates.io while the app
  may not.
- **Contracts before code.** A crate is accepted only when `contracts/` pins the
  seam it implements (the `.d.ts` and the subsystem page, by version and sha) and
  `fixtures/` pins its behaviour.
- **Fixtures before faith.** `diff/` runs the TypeScript implementation and the
  Rust one over the same inputs and diffs the output. A port without a green
  fixture suite is a guess, and this folder does not keep guesses.
- **Leaves, never the container.** Rust implements providers behind seams. The
  Cordis container, the plugin manager, the client bundles and the descriptor
  generator are never ported here.
- **`target/` needs no ignore rule.** The repository root already ignores it.
- **No maintainer scripts.** Those stay in `scripts/tools/`; this folder holds
  port artifacts and crates.

## What exists

| Path | State |
|---|---|
| `README.md` | this page |
| `contracts/` | P1 — not created yet |
| `fixtures/` | P1 — not created yet |
| `diff/` | P1 — not created yet |
| `Cargo.toml` | P2 — deliberately absent |

The crate map, the ranked port order and the four conditions for ever wiring a
`.node` into the harness are all in [`docs/RUST-PORT.md`](../docs/RUST-PORT.md).
