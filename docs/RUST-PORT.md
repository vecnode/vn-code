# RUST-PORT.md — vncode's core, ported from the harness line

**Status: plan. No crate ships, no row is wired, `app/` is untouched.**

vncode's core is Rust. The DeepSeek Harness is the *source* of that core, not a
dependency of it: the pinned line stays the behavioural reference, `port/` holds
the implementation, and what ships carries vncode's own name and brand. The
upstream license is MIT, so the derivation is allowed; its notice is preserved
and disclosed in `THIRD-PARTY-NOTICES.md`, and its marks are not ours to use.

Everything below is measured from the installed `0.2.0-rc.2` line unless it says
otherwise, and every number is the reason a rule exists.

## The question this document answers first

*Can a pure-Rust vncode load the same JavaScript plugins as the harness?*

**Not the same ones, and not the same way.** Not because Rust cannot host a
scripting engine, but because the harness is not a JavaScript application — it
is a **Node application that treats the Node platform as a capability**. Measured
from the installed tree:

| Node built-in | Who needs it | What "porting it" actually means |
|---|---|---|
| `node:vm` | `dsh-cordis-host-runner` (a dynamic package's host half evaluates in a fresh realm), `dsh-workflow-ptc` (the workflow guest) | embed a JS engine with realm isolation and code-from-string |
| `node:sqlite` | `dsh-session-query-sqlite` (full-text session search; import deferred, opt-in in the web profile) | a SQL engine |
| `node:zlib` zstd | `dsh-session-persistence-jsonl` (`createZstdCompress`, `zstdDecompressSync`) | zstd in Rust is easy; Node's *streaming* semantics are the contract |
| `node:worker_threads` | session persistence, `dsh-app-boot`, `libreoffice-kit` | threads, transferables, environment data |
| `node:module` `stripTypeScriptTypes` | `dsh-ptc-runtime-node` | a TypeScript type stripper at runtime |
| `node:child_process`, `node:net`, `node:readline`, `node:os`, `node:fs` | ~40 packages | the platform itself |

A Rust process that loads those packages must first *be* Node. Deno and Bun are
that project, they are person-decades old, and neither is a side quest. So the
goal is stated the only way it can be met.

## Three paths, one decision

The port is not one road with a fork further on. It is three different products,
and the choice happens now because it decides whether the packages in this
repository have a future.

| Path | Container owned by | What you get | What it costs | Verdict |
|---|---|---|---|---|
| **A. Hosted core** | Node + Cordis (upstream) | every upstream package and every package in this pack keeps working; Rust wins land underneath | still ships Node and its startup | **start here** (P1–P6) |
| **B. Native host** | vncode | one binary, vncode's own protocol, vncode's own UI, no Node | upstream packages do not load; this pack's *surfaces* are rebuilt | **the destination** (P7, after a gate) |
| **C. Compatible native host** | vncode, reproducing Cordis + Typert | upstream's 288 packages and this pack run unmodified on a Rust host | reimplement the plugin container, scopes, effects, HMR, realms, patch layering, and the descriptor codegen pipeline in Rust | **not a plan** |

Path C is the one people assume happens by itself ("port enough modules and one
day it's native"). It does not: A and B share the *crates*, not the *contract*.
C is a research bet, and it is the most expensive item in this document by an
order of magnitude.

Path B is what makes the port finishable. As a fork with its own brand and its
own UI, vncode does not owe anyone wire compatibility — it owes its users a fast,
safe core. That is the freedom that turns a years-long faithful port into a
scoped product.

## The boundary rule

**Rust owns leaves behind seams. Rust never owns the container.**

A thing may be ported when all three hold:

1. it is reachable through exactly one seam (Service Definition / Provider /
   Consumer, the shape `docs/architecture.md` describes upstream);
2. its inputs and outputs are JSON, bytes, files, or processes — no `Context`,
   no scope, no effect unwinding;
3. a fixture can pin its behaviour, so the TS implementation and the Rust one can
   be compared on the same input.

Anything failing (1) or (2) stays TypeScript until path B replaces it wholesale.

Never ported, under any path: the Cordis container (`plugins`, `services`,
`scopes`, `effects`, realm `isolate`, HMR), `plugin-manager` (pnpm orchestration),
the client bundles, the Typert *generator*, Electron, telemetry, translations.

## Why "the TS tree keeps moving underneath you" only works with fixtures

Porting behind a seam means upstream keeps shipping while you build. That is the
point, and it is also the failure mode: without a fixture suite you cannot tell a
win from a silent behaviour change, and the port starts lying.

So the rule: **no crate is accepted until its fixture suite is green against the
pinned line.** `port/contracts/` pins the seam contract (the `.d.ts` files and
the subsystem page), `port/fixtures/` pins behaviour, both by version and sha.
Upgrades to the pinned line are deliberate events that re-run every fixture, not
a background drift. This is the only discipline that makes a 60-seam port
tractable for one person.

## `port/` — the second workspace

`port/` is a **separate cargo workspace** from `app/`, and it stays separate:

- `app/Cargo.toml` is the front door: three crates, std + `serde_json` +
  `rpassword`, a **6 MB** CI size ceiling. Nothing from `port/` is linked into
  it, and `check-shell.mjs` keeps proving that.
- `port/` has its own lockfile, its own CI job (added at P3), and its own
  dependency policy. A ported crate may use crates.io; the app may not.
- `target/` is already ignored at the repository root, so `port/target/` costs no
  new `.gitignore` rule.

The tree, and what may exist at each phase:

```
port/
  README.md            now      the folder's own rules
  contracts/           P1       vendored .d.ts + seam notes, pinned by sha
  fixtures/            P1       input + expected output captured from the pinned line
  diff/                P1       the harness that runs TS vs Rust on one fixture set
  Cargo.toml           P2       the workspace (deliberately absent until then)
  crates/
    vn-session/        P2       JSONL v0/v1 codec, generations, zstd, migrations
    vn-proj/           P2       projection folds (turnBoundary, inbox, todo, stats)
    vn-native/         P3       the ONE N-API surface (napi-rs cdylib)
    vn-sandbox/        P4       landlock · appcontainer · seatbelt · policy resolution
    vn-exec/           P4       subprocess, pty, job objects, ConfinedArgv
    vn-fs/             P5       paths, realpath policy, atomic write, win32 semantics
    vn-search/         P5       glob, grep, diff, patch, hash
    vn-llm/            P6       transport, SSE, retry, token meter
    vn-host/           P7 only  the native binary — exists only if B is chosen
  tools are NOT here: maintainer scripts stay in `scripts/tools/`.
```

## Phases, with a gate and a kill criterion each

| # | Deliverable | Done when | Stop if |
|---|---|---|---|
| **P0** | instrumentation: boot-phase timings, session-load time on the longest real session, RSS, grep latency | the numbers exist as a page | no phase exceeds 10% of user-visible time → port for safety only, drop the performance claims |
| **P1** | `contracts/` + `fixtures/` + `diff/` | one seam's contract is pinned and the diff harness runs the TS implementation against itself | fixtures cannot be captured deterministically → fix that before writing Rust |
| **P2** | `vn-session` + `vn-proj`, **pure Rust, no binding** | every fixture green; load time measured against Node on the same files | the codec cannot express a generation/migration edge → the seam is wrong, re-read it |
| **P3** | `vn-native`: the first N-API surface, behind a row that is **disabled by default** | the four conditions below hold, and `run-web.*` on a machine without the addon is unchanged | a missing `.node` cannot fail open → do not wire it |
| **P4** | `vn-sandbox` + `vn-exec` | confinement is fail-closed and tested per platform; the C Landlock launcher's contract is met | Windows Job-object/AppContainer semantics cannot be made to fail closed → keep the TS path |
| **P5** | `vn-fs` + `vn-search` | path policy identical on NTFS (ADS, `\\?\`, junctions, case) as on POSIX | a path case cannot be pinned by fixture → do not ship that path form |
| **P6** | `vn-llm` transport (own the whole request) | streaming and cancellation measured, not asserted | per-chunk crossing erases the win → keep Node's HTTP |
| **P7** | `vn-host` — **a separate decision, not a scheduled phase** | path B is chosen, with its own UI and protocol | the answer to "who rebuilds every surface" is nobody → stay on A |

## P3 — the four conditions before anything is wired

Wiring Rust into the harness is the last step of a phase, never the first, and it
holds only while all four are true:

1. **Lazy and fail-open.** A missing or failing `.node` falls back to the JS path.
   A machine with no vncode must still run the web — this repository's rule 1,
   and `check-shell.mjs` drives it.
2. **ESM-safe.** The harness is `"type": "module"` throughout; a CommonJS native
   module is reached through `createRequire(import.meta.url)`.
3. **Coarse crossings.** Expose `readSession(dir) -> FoldedState`, never
   `parseEvent`. Per-event or per-token crossings erase every win the port bought.
4. **Per-platform packaging.** Stable N-API, prebuilt, `optionalDependencies` —
   the shape upstream already uses for its two C primitives
   (`native/system`: `flock.c`, `main.c`, no build at install time). Consumer
   installs must never compile.

## What the port is expected to buy, ranked

The order below is the port order, and each row names the measurement that keeps
it honest.

| # | Port | Win | Risk |
|---|---|---|---|
| 1 | session log + projections | session load on long sessions; the format becomes the interop point between vncode and the harness | low — pure data |
| 2 | sandbox + exec | the only real *safety* win: fail-closed confinement, Job objects, ConPTY | medium — per-platform semantics |
| 3 | fs | security and correctness of every path the agent touches | medium — NTFS traps |
| 4 | search / diff / patch / hash | throughput on big trees, coarse calls | low |
| 5 | llm transport | streaming, backpressure, cancellation | medium — only whole-request |
| — | JSON-schema validation of tool args | *none worth taking*: the error text is model-facing, so changing it changes model behaviour | — |

## What this does not buy

Not turn latency. A turn is dominated by model time and tool spawns, not by JS
execution. The honest claim is **startup, memory, long-session load, search, and
enforceable confinement** — not "the agent is faster". A port justified by "the
agent will be quicker" would be justified wrongly.

Not "safe because it is Rust". A rewrite adds new parsers and new path handling,
and those are where the bugs go. Confinement and path code are ported **first**
(P4, P5) precisely because they are the sensitive ones, and each lands with its
fixtures, not after them.

## Cost, stated plainly

Host-side TypeScript is **~11.7 MB ≈ 325k lines** (36 chars/line measured). A
faithful solo port at this repository's standard is years, and the pinned line
will break compatibility many times inside that window. That number is why the
plan is a ranked subset rather than a translation, and why path B — a smaller
product with its own scope — is the only version of "pure Rust" that finishes.

## Open decisions (not decidable by an agent)

1. **UI and protocol ownership.** Path B means vncode's own UI and its own wire.
   That is the choice that makes the port finishable, and it is the one that
   retires this pack's surfaces as they are.
2. **Windows-first or Linux-first** for P4. This repository's users are on
   Windows; the confinement primitives are better documented on Linux.
3. **`AGENTS.md`.** `port/` is not yet in the layout section. Adding it there is
   a rulebook change, so it waits for the owner's decision, not this document.

## Non-goals

- A Rust client UI. The browser keeps the UI, as this repository's rule 1 says.
- Wire compatibility with the upstream client. Optional, and it is what path C
  costs.
- Vendoring the harness. `port/` is a derivation with its own versions; upstream's
  source stays upstream's.
