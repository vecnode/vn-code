# dsh-frontend-craft (alpha.1)

**Front-end design with a floor under it.** Impeccable's craft corpus and its
61-rule detector, shipped whole inside this plugin: no `npx impeccable`, no engine
download, no network call, no child process.

Impeccable is a design skill for AI coding agents by Paul Bakaus, Apache-2.0,
<https://github.com/pbakaus/impeccable>. This package vendors it at a pinned
commit and replaces the parts that cannot travel: the downloaded engine binary
becomes a WebAssembly module built from the same crates, the localhost decision
page becomes the Frontend tab, and the private world catalog is dropped (and said
so, below).

## What it adds

| | |
|---|---|
| **skill** | `frontend-craft`: 24 commands (`init`, `document`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`, `clarify`, `adapt`, `optimize`, `shape`, `extract`, `craft`, `live`, `generate`), the craft floor, the four visitor modes, and the iOS/Android platform references - 41 reference files copied from the pin |
| **tools** | `fe_context` (product truth, design system, surface briefs, config, directives), `fe_detect` (the 61 rules over a file or folder), `fe_direction` (deal a direction hand from the directions the agent authored, deterministically; record the pick), `fe_artifact` (read/write + shape-validate `PRODUCT.md`, `DESIGN.md`, a surface brief) |
| **tab** | **Frontend**: the findings by file and rule with the rule's own sentence, filters by category, a re-scan, and the three artifacts with their validation verdict |
| **routes** | `GET /api/dsh-frontend-craft/state`, `POST .../scan`, `GET .../artifacts`, `GET .../rules` |

The 61 rules split 31 `slop` / 30 `quality`: side-tab borders, gradient text,
purple-blue palettes, cream palettes, nested cards, uniform spacing, bounce
easing, pulsing dots, blinking cursors, overused fonts, flat type hierarchy,
line length, cramped padding, small touch targets, skipped headings and more.

## Provenance, and what "vendored" means here

```
lib/vendor/impeccable/
  rules.json             the 61-rule registry
  LICENSE                Apache-2.0, upstream's own file
  NOTICE.md              upstream's third-party notices (platform-design-skills, MIT)
  detect/detect.cjs      the wasm-bindgen glue (CommonJS: this package is ESM)
  detect/detect_bg.wasm  the rule engine, 4,558,054 bytes, built HERE
  VERSION.json           the commit, the transform, every file's bytes + sha256
```

The engine is built from the pin with the user's own toolchain, not downloaded:

```sh
rustup target add wasm32-unknown-unknown
node vendor/impeccable/build-engine.mjs --source <checkout> --wasm-bindgen <wasm-bindgen 0.2.127>
```

Measured 2026-10-18: 54 s cold from a clean workspace; the native binary is
18.8 MB, the wasm 4.56 MB, the glue 64.9 KB. `node vendor/impeccable/build.mjs
--check` re-hashes every vendored byte offline, and the package's own check runs
it.

The corpus is copied by `vendor/impeccable/build.mjs` from the pinned commit's
committed DSH payload, with exactly four transforms, all recorded in
`VERSION.json`:

- `.dsh/skills/impeccable/scripts/impeccable` to `impeccable` (the tool-surface
  table in `SKILL.md` translates each verb: `context` becomes `fe_context`,
  `detect` becomes `fe_detect`, `surface-brief` becomes `fe_artifact`,
  `concept-seed` becomes `fe_direction`, and so on);
- `.dsh/skills/impeccable` to `skills/frontend-craft`;
- `.impeccable/` to `.frontend-craft/`, so a run cannot collide with a real
  Impeccable install in the same project;
- `impeccable:product-schema` to `frontend-craft:product-schema`, our stamp.

`SKILL.md` is assembled: our frontmatter, provenance, tool-surface table and
Setup sections, then upstream's text from `## How to design` onward, with the
three engine-only maintenance paragraphs (Pin/Unpin, Hooks, Doctor) dropped.
Everything else is upstream's words.

## What this adaptation does NOT have, in plain words

- **The roll has no catalog.** Impeccable's `concept-seed` deals challenger
  worlds from a catalog served by its own API, which is not in the open-source
  repository. `fe_direction` keeps the procedure and drops the deck: it takes the
  directions the agent authored (3-12), hashes a seed into a deterministic order,
  assigns the lead and deals three, then records the person's pick. That is a real
  assignment discipline - the roll is not the agent's favourite, and it re-runs to
  the same hand - but the outside view a catalog gives is gone, and the skill says
  so: never call it a catalog roll.

- **No comp-led builds.** They need image generation; the harness has none, so
  every surface is code-led, which is the path upstream documents for exactly
  this case. The direction contract and the finish review carry the ambition.

- **No live mode.** `live`, `generate`, `build-phase` and the comp verbs need a
  browser-driving dev-server harness. `fe_detect` is the explicit check instead
  of an edit hook (the harness has no hook surface).

- **No telemetry, by construction.** There is no code path that could send any:
  the detector is local, and the tab talks only to this plugin's own routes.

## Install and verify

The installer copies `skills/frontend-craft/` into `$DSH_HOME/skills` (and the row
also registers the skill at run time, so a profile without the copy still sees
it). Zero npm dependencies; Node 22+.

```sh
node checks/check-frontend-craft.mjs   # 13 checks, no network, no browser
```

The check proves: the vendored bytes match `VERSION.json`; the pin is 4.6.0 and
the registry 61 rules; the skill has our frontmatter and all 24 commands; every
engine verb the references name is translated or declared unavailable; no
`.impeccable/` path or placeholder survived; the Apache licence and notices
travel; the plugin's own code spawns no process and opens no socket; the tools it
registers are exactly the ones the skill names; a dealt hand is reproducible from
its seed; and the detector agrees finding-for-finding with the upstream CLI on
six committed fixtures - including the linked-stylesheet case, which the raw wasm
export cannot do alone.

From the repository root, `node scripts/checks/check-node-routes.mjs` and
`check-client-bundles.mjs` also cover this package's row, tools, routes and tab.

## Layout

```
lib/index.js      the row: four tools, four routes, the bundled skill
lib/tools.js      fe_context / fe_detect / fe_direction / fe_artifact
lib/vendor.js     the wasm loader, local-stylesheet inlining, config ignores
lib/context.js    PRODUCT.md / DESIGN.md / brief reading, validation, directives
lib/paths.js      the workspace policy and the deterministic source walk
lib/client.js     the Frontend tab (classic script, no build step)
lib/vendor/impeccable/  the pinned corpus + the built detector
skills/frontend-craft/  SKILL.md + 41 references
vendor/impeccable/      build.mjs (corpus), build-engine.mjs (wasm), overrides/
checks/                 the package contract + the parity fixtures
```
