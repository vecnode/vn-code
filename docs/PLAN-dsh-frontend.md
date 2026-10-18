# The plan: `dsh-frontend-craft`, front-end design with a floor under it

**Premise.** `dsh-diagrams` proved the shape: a vendored corpus a person can
read, a skill that says how to use it, and a tool that validates the result
before it is stored. Front-end design needs the same three things, and it needs
the third one to *measure*, because the failure mode is not an invalid diagram -
it is a page that renders and still looks like every other page an AI built.

The corpus and the skill exist, Apache-2.0, in
[pbakaus/impeccable](https://github.com/pbakaus/impeccable). The plan is to
**copy the corpus, build the engine ourselves, and add the half a skill cannot
have on its own: measurement of what was actually built.** This page is the plan
of record for the branch; `packages/dsh-frontend-craft/README.md` is the package.

## The questions this plan had to answer

### Can we copy the code? Yes - and reverse engineering would be the worse choice

Impeccable is Apache-2.0. That licence grants exactly what this plugin does:
copy, modify, redistribute, and ship a derivative, provided the licence travels,
the notices are kept, and the changes are stated. There is nothing to reverse
engineer: the Rust rule engine is in the open, and the corpus is markdown. The
distinction that matters is **provenance**, not technique - so the package keeps
upstream's `LICENSE` and `NOTICE.md` beside the bytes, records the commit and
every file's hash in `VERSION.json`, and states its four transforms in the README
and in the skill itself. A clean-room rewrite would take weeks, drift on every
upstream rule change, and buy nothing but a worse product with murkier provenance.

The one thing that is *not* in the open-source repository is the direction
catalog and its API (it is served by `impeccable.style`). That is copied from
nothing: `fe_direction` deals from the directions the agent authored, and says so.

### Does it have to be an "impeccable install"? No - that is what we removed

Upstream's runtime is one downloaded binary resolved by a launcher, plus a
localhost decision page and an npm shim. This plugin has **none of that**: the
detector is a WebAssembly module built from the same Rust crates and committed in
the package, the corpus is committed markdown, and a capability the harness does
not have is named as unavailable. "Installing Impeccable" is not a step.

### The whole engine, or the part that fits? The part that fits, measured

The Rust workspace also contains live-mode servers, a comp/image pipeline and a
CDP-driven browser. None of that ships here: what ships is `crates/core` +
`crates/foundation` compiled by `crates/wasm`'s `detect` feature - the text and
static-HTML rule engines. Measured on this machine:

| what | number |
|---|---|
| `cargo build --release -p impeccable-wasm --target wasm32-unknown-unknown --features detect` | 54 s cold |
| `detect_bg.wasm` | 4,558,054 bytes |
| wasm-bindgen glue (`detect.cjs`) | 64,902 bytes |
| the corpus (SKILL.md assembled + 41 references + registry + licence/notices) | 0.46 MB, 49 files |
| findings vs the upstream CLI over its 186 fixtures | 184/186 identical, and the host closes the last two (linked stylesheets) |

For scale: the `pdf.js` tree this pack already vendors is 5.1 MB. The run cost is
in line, and the load path is one `createRequire` per process.

## What alpha.1 ships

| | |
|---|---|
| **skill** | `frontend-craft` - the 24 commands, the craft floor, the four modes, the native references. `SKILL.md` is our head (frontmatter, provenance, a tool-surface table, Setup, verification) + upstream from `## How to design`; the 3 engine-only maintenance paragraphs are dropped and the references are copied whole with four mechanical transforms |
| **tools** | `fe_context`, `fe_detect`, `fe_direction`, `fe_artifact` - the runtime the corpus calls, each answering with a sentence a reader can act on |
| **tab** | **Frontend**: Findings (by file and rule, category filters, re-scan) and Artifacts (PRODUCT.md, DESIGN.md, briefs, with their shape verdict) |
| **routes** | `state`, `scan`, `artifacts`, `rules` |
| **checks** | the package's 13 (`npm run check`), plus the pack-wide `check-node-routes.mjs` (tools, routes, a real scan) and `check-client-bundles.mjs` (the bundle, its capsule, its first paint) |

The design decisions worth keeping:

1. **Path and stamp are ours.** `.impeccable/` becomes `.frontend-craft/`, so a
   run cannot collide with a real Impeccable install; the PRODUCT stamp becomes
   `frontend-craft:product-schema`. A foreign, unstamped PRODUCT.md is reported as
   `CONTEXT_STALE` and never rewritten as a side effect.
2. **`fe_artifact` refuses what it would have to invent.** A write is validated
   for shape (stamp, sections, the six contract blocks, a `seed:` line) and an
   existing file is refused without `overwrite`, because PRODUCT.md is durable
   truth and a silent replace is the one failure a design tool cannot survive.
3. **The roll is local and honest.** `fe_direction` hashes a seed into a
   deterministic order over the authored directions, assigns the lead, deals
   three, and records the pick. No catalog, no comps - the skill says so in the
   first paragraph and forbids calling it a catalog roll.
4. **Detection closes what the raw engine cannot.** `inlineStylesheets` folds
   local `<link rel=stylesheet>` into the document before the static engine runs,
   which is what turns 184/186 into 186/186; project ignores are applied in JS
   from `.frontend-craft/config.json` with upstream's own key names.

## What remains before this is "whole" and merges to main

| # | item | state |
|---|---|---|
| A | **Directions view in the tab** | **shipped**: `GET`/`POST .../direction`, cards with the assigned lead, the standing exit and the re-roll, and the pick is what `fe_direction status` reports |
| B | **`fe_render`** | **shipped**: the machine's own headless Chrome/Edge, argv-only, throwaway profile, every name NOTFOUND but loopback; one launch per call; seven measured rules (`render-contrast`, `render-tap-target`, `render-overflow`, `render-line-length`, `render-small-type`, `render-heading-skip`, `render-missing-alt`); the PNG and its report under `$DSH_HOME/dsh-frontend-craft/renders/<id>/`, drawn in the tab's Preview. Measured: 489 ms and 10 findings on a deliberately bad page at 800×600 |
| C | **Live mode** (`live`, `generate`) | not built, and a separate product: variants written back through a dev server. `fe_render` measures one render; it never edits. |
| D | **Upstream re-sync policy** | one review per quarter: bump `PIN` in `vendor/impeccable/build.mjs`, run the corpus and engine builds, read the diff, run the two checks |
| E | **Direction deck** | **shipped**: eighteen visual worlds in `lib/deck.json` (print, transport, science, civic, archive), mode-filtered and dealt deterministically as the hand's ONE challenger - the outside view the private catalog used to provide, built from our own editorial content |

What is left is C, and it is a decision rather than a gap: the plugin as it
stands measures, detects, records and deals. The line this branch will not cross
is the one that makes the plugin stop being a plugin: no install, no download, no
socket, no command string, and no second product smuggled in under "live".

## The rules the plan would not trade

1. **No network, no install, no child process.** The detector is local, the
   corpus is local, and the tab talks only to this plugin's own routes. A check
   fails on `child_process`, `fetch` in the host half, or any `http(s)://` in the
   plugin's own code.
2. **Vendored bytes are hashed.** `VERSION.json` names every file and its sha256;
   `build.mjs --check` re-hashes offline, and the package check runs it.
3. **The corpus is upstream's words.** Only four transforms, all mechanical and
   all recorded; a hand edit to a reference is a failing check.
4. **A validator never invents.** `fe_artifact` refuses rather than fills; a
   missing DESIGN.md is `NO_DESIGN_MD`, not a generated one.
5. **The branch, not main.** Work lands on `dsh-frontend-craft` and merges when
   the plugin is whole; `main` stays releasable.

## The one-line version

Vendor Impeccable's corpus, build its rule engine into the package as WebAssembly,
put the direction round and the findings in the right bar, drop the network, and
let the checks hold every byte and every finding to the upstream engine - so
front-end design gets the same floor under it that the design kit gives a diagram.
