# dsh-frontend-craft (alpha.1)

**Front-end design with a floor under it.** Impeccable's craft corpus and its
61-rule detector, shipped whole inside this plugin: no `npx impeccable`, no engine
download, no network call. The only process it starts is the Chrome or Edge the
machine already has, and only when `fe_render` measures a page.

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
| **tools** | `fe_context` (product truth, design system, surface briefs, config, directives), `fe_detect` (the 61 source rules over a file or folder), `fe_direction` (a deterministic hand from the directions the agent authored, plus one challenger from the local deck), `fe_render` (the page rendered in a throwaway headless browser, measured), `fe_artifact` (read/write + shape-validate `PRODUCT.md`, `DESIGN.md`, a surface brief) |
| **tab** | **Frontend**: Findings (by file and rule, filters, re-scan), Artifacts (`PRODUCT.md`, `DESIGN.md`, the briefs, with their shape verdict), Directions (the dealt hand, the pick) and Preview (the rendered picture at each viewport, with the measured findings) |
| **routes** | `GET /api/dsh-frontend-craft/state`, `POST .../scan`, `GET .../artifacts`, `GET .../rules`, `GET`/`POST .../direction`, `GET .../render-image` |

The 61 rules split 31 `slop` / 30 `quality`: side-tab borders, gradient text,
purple-blue palettes, cream palettes, nested cards, uniform spacing, bounce
easing, pulsing dots, blinking cursors, overused fonts, flat type hierarchy,
line length, cramped padding, small touch targets, skipped headings and more.

## The measured rules (`fe_render`)

Those 61 rules read SOURCE. `fe_render` renders the page - a workspace HTML file,
or a loopback dev-server URL - in the machine's own headless Chrome or Edge, and
measures what only pixels show. One launch serves every viewport; the profile is
fresh and deleted afterwards; the page cannot reach the network (every name
resolves to NOTFOUND except loopback), so a remote font fails and the answer says
so.

| rule | what it measures |
|---|---|
| `render-contrast` | each text leaf's WCAG ratio against its effective background (4.5:1, or 3:1 at 24px / bold 18.66px) |
| `render-tap-target` | interactive elements under 24×24 CSS px (WCAG 2.2 minimum) |
| `render-overflow` | the document wider than the viewport, and the elements past the edge |
| `render-line-length` | paragraphs and list items past ~95 characters per line |
| `render-small-type` | body text under 12px |
| `render-heading-skip` | a heading level jumped (h1 then h3) |
| `render-missing-alt` | an `<img>` with no alt attribute |

They are named `render-*` and carry `measured: true`, so nobody mistakes them for
the source engine's findings. Chrome/Edge is required for this half; without it the
tool says so and the 61 source rules still run.

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

- **The roll has no catalog, but it has a deck.** Impeccable's `concept-seed` deals
  challenger worlds from a catalog served by its own API, which is not in the
  open-source repository. `fe_direction` keeps the procedure: it takes the
  directions the agent authored (3-12), hashes a seed into a deterministic order,
  assigns the lead and deals three - and adds **one challenger from this package's
  own deck** of eighteen visual worlds (`lib/deck.json`), a world the agent did not
  write. It is judged on audience identification and product clarity, and a
  declined challenger still donates one discipline to the assigned direction.
  That is the outside view, restored from our own editorial content; there are
  still no comps, no imagery and no catalog.

- **No comp-led builds.** They need image generation; the harness has none, so
  every surface is code-led, which is the path upstream documents for exactly
  this case. The direction contract and the finish review carry the ambition.

- **No live mode.** `live`, `generate`, `build-phase` and the comp verbs need a
  browser-driving variant/accept pipeline, which is a second product. What
  `fe_render` does is narrower and still measurable: it renders one page and reads
  its geometry and colours. It does not write changes back into a dev server.

- **No telemetry, by construction.** There is no code path that could send any:
  the detector is local, and the tab talks only to this plugin's own routes.

## Install and verify

The installer copies `skills/frontend-craft/` into `$DSH_HOME/skills` (and the row
also registers the skill at run time, so a profile without the copy still sees
it). Zero npm dependencies; Node 22+.

```sh
node checks/check-frontend-craft.mjs   # 17 checks, including a render smoke where a browser exists
```

The check proves: the vendored bytes match `VERSION.json`; the pin is 4.6.0 and
the registry 61 rules; the skill has our frontmatter and all 24 commands; every
engine verb the references name is translated or declared unavailable; no
`.impeccable/` path or placeholder survived; the Apache licence and notices
travel; the scan path spawns no process and no host file names a non-loopback URL;
the one browser launch is argv-only, headless and offline; the tools it
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
