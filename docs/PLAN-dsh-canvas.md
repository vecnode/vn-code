# PLAN — `dsh-canvas`: a **Canvas** tab the agent controls, and the skills that teach it to design

Status: **plan only, nothing built.** This document is the design I would build
from. It answers one request: a new tab in the conversation panel, **to the right
of Trajectory**, called **Canvas**, that is a design page the agent drives — for
GitHub and LinkedIn banners and posters — **with a language model and skills, and
no image-generation model anywhere**.

The four decisions that were yours are **settled** in section 12 — the
conversation view ring at `order: 20`, the JSON document language, two bundled
OFL font families, and a per-conversation store plus a harness-wide library — and
the body below is written as the design they imply. The fifth (how wide v1 is) I
have decided, with the reasoning stated where it lands.

---

## 1. What was asked, read back against the pinned line

The chat panel's header carries a **view ring** — the tab strip that today reads
`Chat | Trajectory`. I checked the pinned bundles rather than assuming:

| Fact | Where it comes from |
|---|---|
| The ring is the `conversation.view` slot, a **session-scoped list** | `dsh-client-ui-conversation` — `SlotMap['conversation.view']` |
| A view registers as `ctx.slots.register({ name: 'conversation.view', id, order, label, locale?, children?, inject? }, Component)` | `dsh-client-ui-trajectory` (`id: 'trajectory'`, `order: 10`), `dsh-client-ui-chat` (`id: 'chat'`, `order: 0`) |
| Tabs are ordered by `order`, so **`order: 20` sits to the right of Trajectory** | `viewTabs()` walks `slots.entries('conversation.view')` |
| **Trajectory is gated**: it is skipped unless developer tools are enabled | `if (!…developerTools.enabled… && entry.options.id === 'trajectory') continue` |
| Only the **active** view is mounted — `renderSlot('conversation.view', props, { only: viewId })` | `DefaultConversationViews` |
| A view makes the shell **float the composer over a full-height page** by putting `data-conversation-composer-overlay` on its root | the conversation stylesheet: `:has([data-conversation-composer-overlay])` turns `.viewArea` into `flex:1 1 0; overflow:hidden` and the composer seat into `position:absolute` |
| Session identity arrives as `props.sessionId` | `PropsRuntime<'conversation.view'>` |

So the tab is `id: 'canvas'`, `order: 20`, one registration, no core row
disabled, nothing forked. Two consequences worth stating up front:

- With developer tools **off**, the ring reads `Chat | Canvas` — Canvas is not
  gated, because it is a product surface and not a debug view.
- Because only the active view is mounted, **the tab cannot be the only thing
  that can render a design** (section 5): the renderer is a plugin-level engine,
  and the tab is the window onto it.

## 2. The three questions the design has to answer

1. **A person** opens Canvas and sees a design page: artboards at real pixel
   sizes, zoom and pan, safe areas, an export menu, and an editable document.
2. **The agent** *controls* it: it authors, patches, renders, looks at the result
   and exports — without a human clicking anything.
3. **Only a language model** does the designing — no diffusion model, no stock
   art service, no canvas API to write JavaScript into.

(3) is the constraint that shapes everything else, so it is worth being blunt
about what it rules out and what it leaves:

| Ruled out | What replaces it |
|---|---|
| inventing a photograph | **photographs you already have**: workspace files, repo assets, a screenshot the agent takes, a page rendered from a PDF, an image the person pastes into the tab |
| a generative model's painterly texture | a **procedural art library** — deterministic SVG/canvas generators (mesh gradients, dot and line grids, glows, rings, grain, waves, blueprint and circuit motifs) drawn from the `seed` in the document |
| "make it look good" as one prompt | a **document language with archetypes and presets**, plus **skills** that carry composition, typography and per-network delivery rules (section 8) |
| the model guessing whether the result is any good | a **render report**: the browser rasterizes the design and hands the PNG back, and the model reads it with the harness's own `read_image` (section 5) |

## 3. The document: one JSON design language

The unit of work is a **design document** — declarative JSON, validated on the
host before it is stored, rendered identically wherever it is rendered. Not
HTML/CSS (nothing to sandbox, no stylesheet to inject, no external fetch), not
raw SVG (the model would hand-place every line of text), and not JavaScript (a
design page is not a program).

```jsonc
{
  "title": "Launch banner",
  "preset": "github-social",                       // fixes 1280x640 and its safe areas
  "tokens": {
    "color": { "ink": "#F8FAFC", "muted": "#94A3B8", "accent": "#4D6BFE", "surface": "#0B0E14" },
    "font":  { "display": "Space Grotesk", "text": "Inter", "mono": "system" },
    "scale": { "display": 72, "title": 40, "body": 22, "caption": 15 },
    "space": 8,                                     // the rhythm unit; gaps and paddings are multiples
    "radius": { "card": 20, "pill": 999 }
  },
  "layers": [
    { "kind": "art", "style": "mesh", "colors": ["accent", "surface"], "seed": 7, "opacity": 0.55 },
    { "kind": "frame", "x": 72, "y": 64, "w": 720, "h": 512,
      "direction": "column", "gap": 20, "justify": "center",
      "children": [
        { "kind": "text", "text": "DeepSeek Harness", "style": "title", "weight": 600 },
        { "kind": "text", "maxWidth": 700, "style": "display",
          "runs": [ { "text": "One agent. " }, { "text": "Your whole toolchain.", "color": "accent" } ] },
        { "kind": "text", "style": "body", "color": "muted", "maxWidth": 620, "maxLines": 2,
          "text": "Plugins, skills and surfaces for the dsh web app." },
        { "kind": "image", "src": "shots/app.png", "w": 640, "h": 280, "fit": "cover",
          "radius": 12, "scrim": "bottom", "zoom": 1.06 }
      ] }
  ]
}
```

**Node kinds (v1), deliberately six:** `frame` (flow or absolute box: padding,
gap, direction, justify, align, background — solid, linear, radial, or one of the
art fills — radius, border, shadow, blend), `text` (single style, or `runs` for
an accent word; `wrap` / `nowrap`, `maxLines`, `ellipsis`, `align`, `lineHeight`,
`letterSpacing`, `transform`), `image` (`fit: cover | contain | fill`, `zoom`,
`focus {x,y}`, `radius`, `opacity`, `blend`, `scrim`), `shape` (rect, ellipse,
line, polygon, path; fill/stroke/dash), `art` (the generators), `svg` (a raw
fragment: `<path>`, `<defs>`, `<g>` only — no script, no `foreignObject`, no
event attributes, no external `href`).

**Sizing** is numbers, `"fill"` or `"hug"`. **Positioning** is flow inside a
frame, or absolute `x`/`y` on a layer. **Fonts** are the two bundled families —
`Space Grotesk` for display, `Inter` for text — plus `system` for the OS mono
stack, which is deliberately *not* bundled: a code motif wants the machine's own
terminal face and metric drift in a decorative block is not worth two more files.
A document may name a bundled family or `system` for any role; a family the
package does not ship is a typed refusal, never a silent fallback. That is the
whole language: it is small enough to validate completely and to teach in one
skill file, and large enough to build a poster without escape hatches — with
`svg` for the one thing JSON cannot express (a logo, an icon, a wordmark).

### Presets: the canvas is not the model's choice

A preset fixes the pixel size, the safe area, the export formats and the warnings
that apply. v1:

| Preset | Size | Goes to | What the preset enforces |
|---|---|---|---|
| `github-social` | 1280×640 | repo → Settings → Social preview (PNG/JPG, ≤ 1 MB) | 48 px margin guide, ≤ 2 type sizes above 40 px, legible at 320 px wide |
| `github-readme` | 1280×320 (and 2560×640 @2x) | top of a README | dark-mode contrast check on both themes |
| `og` | 1200×630 | link unfurls | title ≥ 40 px, 64 px safe margin |
| `linkedin-personal-banner` | 1584×396 | profile background | the **middle band** is the only safe one (the circular photo and the headline sit over the lower-left/bottom) |
| `linkedin-company-banner` | 1128×191 | company page cover | logo square overlap, bottom-left |
| `linkedin-post` | 1200×627 | shared link preview | headline legible at 25 % scale |
| `linkedin-square` | 1200×1200 | feed image | centred composition, no copy inside 96 px |
| `linkedin-carousel-page` | 1080×1350 | document carousel page | page furniture (number chip), consistent margins |
| `x-post` | 1600×900 | in-stream image | centre crop to 16:9, contrast in both themes |
| `poster-a3` | 3508×4961 @ 300 dpi | print (**phase 4**) | bleed and print-safe margins, no blend-only text |

The numbers are **data, not prose**: `lib/presets.js` holds them with a
`verifiedOn` date and a source note, the tool validates the canvas against the
preset, and a build-time check re-reads the table. Network specs move; a spec
that cannot be re-verified should be visible as a spec.

### Archetypes: the craft, encoded

`lib/archetypes/*.json` — 8–12 complete starter documents at preset size, each a
proven composition rather than a blank page: *editorial split* (copy left, image
right), *centred statement*, *product shot on a mesh*, *stat grid*, *code/terminal
motif*, *dark wordmark*, *roadmap strip*, *quote card*, *docs collage*. Both
`canvas_new { preset, archetype }` and the tab's **+ New** gallery use the same
files. This is the "good knowledge of how to put things together" made
executable: the model starts from a composition that already has a hierarchy, a
margin rhythm and a token set, and spends its effort on the words, the palette
and the one bespoke element.

## 4. The engine: one layout, two painters, no WYSIWYG drift

```
document ──validate (host)──► store ──GET /state──► client engine
                                                     │
                                      layout (pure, measurer injected)
                                                     │
                                            draw-op list  ◄── the IR
                                              ├── canvas 2D painter  → PNG (preview, export, report)
                                              └── SVG serializer     → .svg export, vector view
```

**A pure layout pass** turns the document into a flat list of draw operations
(`rect`, `text-run`, `line`, `path`, `image`, `gradient`) with absolute
coordinates. It is pure and its text measurer is **injected** — the browser
passes `canvas.measureText`, and `scripts/checks/check-canvas-node.mjs` passes a
synthetic metrics table — so the arithmetic that decides where every word lands
is testable on a host with no browser at all, exactly the way `dsh-audio` exposes
its parsers through `exports.__internals`.

**Two painters consume the same op list.** The canvas painter is what the
artboard draws *and* what the PNG export rasterizes, so the exported file is not
a second interpretation of the design — it is the same pixels at export scale,
which retires the whole class of "it looked right in the tab" bugs. The SVG
serializer exists because a vector file is genuinely useful (a README header, a
further edit in Figma) and because text-as-path-free SVG is what a designer
wants; it is the *second* output, not the preview.

Three facts this buys, and three it does not:

| Buys | Because |
|---|---|
| identical preview and export | one op list, one painter |
| testable numbers without a browser | measurer injected, layout pure |
| no HTML/CSS sandbox, no external fetch | the document cannot name a URL |

| Cost | Handling |
|---|---|
| fonts must be measured **after they load**, or the first wrap uses the fallback | both families ship with the package and are fetched from a plugin route on first use, so the engine `await`s `document.fonts.load('700 64px Space Grotesk')` and `document.fonts.ready` **before** laying out, re-lays out when the promise settles, and reports the family it actually resolved. A route that failed degrades to the system stack **and says so** in the report — a silent re-wrap is the one outcome this must not have |
| an SVG loaded as an `<img>` may not fetch **any** external resource | the PNG path never serializes SVG (it paints), and the `.svg` export inlines every image as a data URL, with a hard byte cap and a named refusal |
| the SVG serializer can drift from the painter | both walk the same op list, and the tracked check asserts they consume *every* op kind |

## 5. The loop that makes this work: the agent looks at its own design

The model is the designer, so it must be able to **see** what it made. The
harness already hands the model pictures — `read_image` — so the design is:

```
canvas_write / canvas_patch        host: validate → store → bump revision
canvas_new  { preset, archetype }  host: instantiate a starter document
canvas_render { id, scale? }       host: enqueue a render request
        │
        └── client engine (plugin-level, NOT the tab) long-polls
            GET /api/dsh-canvas/render-queue?session=…&wait=20000
            lays out, paints to canvas at the preset size, encodes PNG,
            POST /api/dsh-canvas/render-report  { revision, png, metrics, warnings }
        │
canvas_render returns  { path: '…/renders/<session>/<id>-r<rev>.png', metrics, warnings }
        │
        └── the model calls read_image on that path, critiques, patches, renders again
```

- **The renderer is a plugin-level singleton, not the view.** The tab being
  unmounted is not a failure mode: `apply(ctx)` builds the engine once the client
  bundle is in the boot graph, and it answers requests for whichever session is
  asking. Only the *page* has to be open, which it is by definition.
- **The report is the verdict**, using the vocabulary this pack already proved in
  `dsh-diagrams`: `drawn` / `failed` / `stale` / `pending`, stored per revision,
  carried by the tool result, the design rail's pill and the artboard's footer.
  A second look costs nothing: `canvas_read` re-reads the verdict the revision
  was rendered with.
- **The report carries measurements, not just a picture**: per text node the line
  count, whether it overflowed or was ellipsized, the resolved font family and
  size, the smallest on-canvas type size, contrast ratios against the paint
  behind it, margin/bleed violations, and a **25 %-scale thumbnail** — the size a
  feed actually shows. A model that can read "headline wrapped to 4 lines at
  feed scale" and see the 320 px-wide thumbnail designs differently from one
  handed a pretty 1280 px render.
- **`canvas_render` blocks** (≤ 15 s) rather than only reporting later, because
  the loop is *write → look → fix*; the timeout is not a lost render — the report
  still lands and `canvas_read` shows it.

## 6. The tab

Full height, on the composer-overlay path (`data-conversation-composer-overlay`),
dark stage behind the artboard, and a layout that answers "what is it and what
happens next" before any control:

- **Left rail** — every design in this conversation: name, preset chip, revision
  and the render pill. A **+ New** gallery lists the presets and the archetypes.
- **Stage** — the artboard at the preset's real pixel size, on a zoom ladder
  (fit / 25 / 50 / 100 / 200 %) that moves the **layout box** — this pack's own
  rule from the image, audio, video, PDF and diagram surfaces, never a CSS
  transform — with drag-to-pan measured from real overflow, and a checkerboard
  behind a transparent canvas.
- **Overlays** (each a toggle, default off): safe areas from the preset, node
  boxes with kind labels, baseline grid from `tokens.space`, the feed-size
  thumbnail, and the contrast/lint markers the report produced.
- **Header actions**: preset picker, zoom, **Export** (format × scale → Desktop,
  or "into the workspace" — section 7), Copy PNG, and a **Source** drawer holding
  the document JSON with an **Apply** that re-validates exactly like a model
  write (the diagram tab's drawer, same contract).
- **Empty state** is a guide, not a blank page: one sentence on what Canvas is,
  the preset gallery, and "ask the agent for a banner" examples.
- **Later (phase 5): direct manipulation.** Select a node, nudge it, retype a
  string, pick a token colour; the edit posts back into the same store, where the
  document already lives. This is a convenience for the person, never the only
  way to change a design — the agent's tools and the drawer both work without it.

## 7. Storage, limits, assets, and where files land

Mirroring the shapes this pack already ships, in `$DSH_HOME/dsh-canvas/`:

| Path | What |
|---|---|
| `sessions/<sessionId>.json` | this conversation's designs (atomic temp+rename; ≤ 64 designs, ≤ 256 KiB per document, 4 MiB per conversation) |
| `library.json` | the harness-wide library (same store class, fixed file name) — *if you want it* (decision 4) |
| `assets/<sha256[0:16]>.<ext>` + `assets/index.json` | images the design may reference, content-addressed, ≤ 12 MiB each, ≤ 256 MiB total (LRU) |
| `renders/<sessionId>/<id>-r<rev>[@2x].png` | what the browser reported and what an export wrote, `stat`-ed and named in the answer |
| `exports/` | optional fallback home for an export when the Desktop is not writable |

- **Assets** enter from three places: a **workspace file** (named by session
  relative path, `realpath`-checked inside the workspace on the host — the policy
  `dsh-image`/`dsh-audio` already use and `dsh-editor` already implements for
  writes), a **paste or drop into the tab** (POSTed to `/api/dsh-canvas/asset`,
  stored content-addressed), or an **import** the agent triggers from something it
  already produced (a `dsh-diagrams` export, a `dsh-pdf` page render, a
  `dsh-browser` screenshot — phase 4).
- **Remote URLs are refused.** A design that names `https://…` is not
  reproducible, leaks a request from someone's browser, and cannot be inlined into
  an SVG. The refusal names the fix: import the bytes as an asset.
- **Exports land on the Desktop by default** (the `dsh-diagrams` precedent: a
  design is something a person keeps and the Desktop is where they are looking),
  with the **workspace** as the explicit alternative, and both written
  create-exclusively under a name the host generates. The answer names the absolute
  path and the destination's own rules (`≤ 1 MB` for GitHub, `PNG` vs `JPG`).
- **Caps are stated and typed**: canvas ≤ 4096×4096, ≤ 4096 layers, ≤ 64 KiB per
  text node, inlined asset bytes ≤ 24 MiB per export, PNG ≤ 40 MB, and every
  refusal is a code with a sentence rather than a silent truncation.

## 8. The skills — this is where the design knowledge lives

Three skill folders in the package (`packages/dsh-canvas/skills/…`), registered at
runtime through `ctx.skills.register` **and** copied into `$DSH_HOME/skills` by
both installers under a `.vncode-dsh-canvas` marker, exactly as `dsh-diagrams`,
`dsh-media`, `dsh-pdf` and `dsh-browser` do. No installer edit is needed — the
copy step is per-package and already generic.

### `canvas-design` — the language, the loop, and the craft

The default skill, loaded whenever Canvas is in play. It teaches:

- **the tool flow** — `canvas_new` → `canvas_patch` → `canvas_render` →
  `read_image` → repeat → `canvas_export`, with the rule that a design is not
  finished until the model has *looked at the rendered PNG at feed scale*;
- **the document**, in full, in `reference/document.md` (every node kind, every
  token, every limit, with the validator's error codes and what each one means);
- **composition rules that survive contact with a feed**: one focal point; a
  hierarchy of exactly three levels; margins from the preset, not by eye; ≥ 2:1
  size ratio between headline and the level below it; optical over mathematical
  centring for a text block; every gap a multiple of `tokens.space`; at most two
  families and three sizes; contrast ≥ 4.5:1 for body and ≥ 3:1 for display text,
  measured against the paint behind it rather than assumed;
- **copy rules** — a headline is ≤ 7 words and ≤ 42 characters at display size,
  the subhead earns the headline rather than repeating it, one call to action,
  and a word-count budget per preset (`github-social` ~14 words total) so a
  design is *written* before it is styled;
- **the hardware you have** — how to reach for an `image` (and with what scrim),
  when a procedural `art` fill beats a photograph, and what to do when there is
  no picture at all (type, geometry, one accent, negative space);
- **`reference/recipes.md`** — copy-paste recipes: mesh gradient + grain, terminal
  card, dot-grid fade, glass panel, logo lockup, stat row, page furniture,
  numbered carousel pages, at both aspect ratios the presets use.

### `social-banners` — the delivery specs, verified and dated

The per-destination facts a model should never guess, as a table it can trust:
exact pixel sizes, safe areas and *why* each exists (the LinkedIn profile photo's
circular crop bottom-left; the company logo square; GitHub's 20 %-wide left inset
in some surfaces), accepted formats and file-size ceilings, what each network
re-crops, `@2x` rules, dark-feed vs light-feed legibility, and **where the file
goes** (repo → Settings → General → Social preview; LinkedIn → Edit background,
PDF upload for a carousel). Every row carries a `verifiedOn` date and a source,
and the skill says plainly that these numbers move — so the model re-checks when
a size fails rather than trusting a stale table. `reference/checklist.md` is the
pre-export gate: safe area, feed-scale legibility, one focal point, contrast,
file size, right format, right canvas, nothing outside the canvas.

### `poster-and-print` — a different problem (phase 4, or fold into `social-banners`)

Larger canvases, 300 dpi arithmetic, bleed and print-safe margins, why a poster is
read at arm's length and a banner at thumbnail size, and why a blend-only or
hairline-thin element is a print failure. Small on purpose: if you would rather
keep the catalog at two skills, this becomes `social-banners/reference/print.md`.

Each skill also earns its keep at the **tool boundary**: `canvas_export` refuses
a size that is not a preset without an explicit override, and the render report
surfaces the same lint the skill teaches, so a model that skipped the skill still
cannot ship a 900×300 "GitHub social preview".

## 9. Package layout and repo wiring

```
packages/dsh-canvas/
  package.json            dsh.bundle + dsh.client (inject: ui-conversation, ui-slots, ui-tool), files: lib, skills
  cordis.patch.yml        one inserted row: { id: canvas, name: dsh-canvas } — no disabled row, nothing forked
  lib/index.js            host: store, validator, archetypes, presets, tools, routes, skill registration, exports
  lib/store.js            per-conversation + library store (the dsh-diagrams store class)
  lib/document.js         the schema, the normalizer and every typed refusal
  lib/layout.js           PURE layout → draw-op list, measurer injected, exportable for checks
  lib/presets.js          the preset table (size, safe areas, formats, limits, verifiedOn)
  lib/archetypes/*.json   the starter compositions
  lib/fonts.js            the bundled-family table: route names, weights, the system fallback, the licence
  lib/vendor/fonts/*.woff2  GENERATED vendored Latin subsets + OFL.txt + VERSION.json (upstream URL and
                          SHA-256 per file, `vendor/build.mjs --check`) - the dsh-pdf / dsh-media pin
                          discipline: the files are committed, the hashes recorded, and nothing is
                          downloaded at install or at boot
  lib/export.js           Desktop/workspace writers, create-exclusive naming, byte caps
  lib/client.js           NO build step: engine (layout + canvas painter + SVG serializer + render queue),
                          the view registration (id canvas, order 20), the design rail, artboard, overlays,
                          source drawer, export menu, and a conversation card per tool
  skills/canvas-design/   SKILL.md + reference/document.md + reference/recipes.md
  skills/social-banners/  SKILL.md + reference/checklist.md
  README.md
```

**Repo wiring** (all existing, all mechanical):

- `scripts/checks/check-canvas-node.mjs` — **new**, no browser, no network: the
  pure layout with an injected metrics table (wrapping, `maxLines` + ellipsis,
  auto-height, alignment, absolute vs flow), the validator's refusals by code, the
  store's caps and atomic write, the preset/archetype tables, the routes, the
  asset path policy, the create-exclusive export naming, the font table against
  the vendored hashes (`vendor/build.mjs --check`), and the skill files'
  front matter. This is the check that makes the layout arithmetic trustworthy.
- `scripts/checks/check-client-bundles.mjs` — **extended**: one bundle, no build,
  the registration (`name: 'conversation.view'`, `id: 'canvas'`, `order: 20`),
  no `eval`/`new Function`, no remote `fetch` of a design resource, the painter
  and the serializer consuming the *same* op kinds, XML escaping of text, the
  composer-overlay marker on the view root.
- `scripts/checks/check-node-routes.mjs` — **extended** with the exact route list,
  the font route included.
- `scripts/checks/check-skill-examples.mjs` — already parses skill front matter;
  the new skills and any example documents in them are added to it.
- `README.md` (root package table), `AGENTS.md` (the `packages/` bullet),
  this plan, and the closing summary in `scripts/install-all.ps1` — cosmetic but
  part of shipping here.
- **Nothing for `scripts/sync-vendored.ps1`**: no fork of any core bundle and no
  core row disabled. The vendored font subsets are not a fork — they come from
  their own upstream under their own licence and are pinned by this package's
  `vendor/build.mjs`, the way `dsh-pdf`'s pdf.js tree and `dsh-media`'s binaries
  are. The installer already discovers `packages/*` with `dsh.bundle` and copies
  each package's `skills/` with its marker, so no install script needs to change.

## 10. Phases

Each phase is a shippable alpha in this repo's sense: docs, checks and behaviour
in step.

| Phase | Delivers | Proves |
|---|---|---|
| **alpha.1 — the page and the language** | package + row + view (`canvas`, order 20), the document language and validator, store, `canvas_new` / `canvas_write` / `canvas_patch` / `canvas_read` / `canvas_delete`, the two bundled families (route + loaded before layout), the pure layout + canvas painter + SVG serializer, the tab (rail, artboard, zoom/pan, source drawer, empty state), the `canvas-design` skill, `check-canvas-node.mjs` | a person can open Canvas and see the agent's design; the model can write and patch one |
| **alpha.2 — the loop closes** | render queue + report + `canvas_render`, verdicts (`drawn`/`failed`/`stale`/`pending`), metrics and lints, the 25 % feed thumbnail, the metrics/safe-area overlays, `read_image` in the flow | **the model can look at what it made and fix it** — the phase that decides whether this works |
| **alpha.3 — ship it** | presets wired into validation + guides, `canvas_export` (PNG/SVG/JPG, `@2x`, Desktop or workspace), fonts embedded into the `.svg` export, the `social-banners` skill with its verified spec table and checklist, export cards in the conversation | a banner exists as a file, at the right size, with the placement instructions attached |
| **alpha.4 — art direction** | the procedural art library, image fit/zoom/scrim/blend, asset intake (paste/drop/workspace), `canvas_assets`, the archetype gallery in **+ New** | designs stop looking like text on a rectangle |
| **alpha.5 — polish and reach** | direct manipulation, multiple artboards per design (a *set*: banner + square + OG exported together), imports from diagrams/PDF/browser renders, unattended host rasterization through the machine's own Chromium when the page is closed | the surface stops needing the browser tab open, and the composition becomes a system |

## 11. Risks and honest limits

- **The loop is the product.** Without alpha.2 this is a nice artboard with a
  clever JSON format that the model cannot evaluate. If only one phase can be
  done well, it is alpha.1 + alpha.2 and a *thin* alpha.3.
- **A wrong preset number is a shipped mistake.** Hence `verifiedOn`, data-not-
  prose, and a check that re-reads the table.
- **Fonts are settled and bundled** (12.3), so a document renders and exports the
  same everywhere. The residual risk is weight and licensing: five WOFF2 subsets
  plus the OFL text in the repository, hashed and re-verified by the check, and a
  font route that must answer **before the first layout** — a failure degrades to
  the system stack and says so in the report rather than silently re-wrapping
  someone's headline.
- **The model writes JSON, not art.** The archetypes and recipes are what make
  the output good; a plan that ships the format and the tools without them will
  produce correct, dull banners.
- **No image model means no new photography.** Everything visual is either
  something the machine already has, or geometry. That is a real ceiling — and it
  is the one the request accepted.
- **Rasterization happens in the page.** It needs the app open; it does not need
  the tab open. Phase 5's host renderer removes even that, at the cost of owning a
  local Chromium path (the CDP shape `dsh-browser` already has, but for `file://`
  content and with the egress gate's policy deliberately *not* reused).

## 12. Decisions (settled)

All four came back as recommended; the fifth is decided here, with the reasoning.

1. **Placement — the conversation view ring.** `ctx.slots.register({ name:
   'conversation.view', id: 'canvas', order: 20, … })`: to the right of
   Trajectory in the chat panel's tab strip, and the second tab in the ring while
   developer tools are off. Not a right-bar tab, not both — one surface, one
   address space.
2. **Authoring format — the JSON document language.** Section 3's six node kinds
   and tokens, with the layout engine wrapping the model's text for it, presets
   fixing the canvas, archetypes starting it from a real composition, and one
   validated `svg` escape hatch. *Raw SVG* is rejected because the model would
   hand-place and hand-break every line of text — the failure mode this whole
   design exists to remove. *An HTML/CSS subset* is rejected because nothing can
   rasterize it offline: the export story would become a headless browser on the
   host, and the preview would stop being the exported artifact.
3. **Fonts — two bundled OFL families.** `Space Grotesk` (display) and `Inter`
   (text: 400/600/700), Latin subsets as WOFF2, vendored with their upstream URL,
   a SHA-256 each and the OFL text, served from a plugin route, loaded before the
   first layout, and embedded as data URLs in an `.svg` export. Mono stays the OS
   stack on purpose (section 3).
4. **Store — per-conversation plus a harness-wide library.**
   `sessions/<sessionId>.json` for the chat's own designs, `library.json` for the
   shared one, `canvas_publish` and `scope: 'library'` exactly as `dsh-diagrams`
   does it — the same store class, the same library-first id resolution, and the
   address `dsh-resource://canvas/library/<id>` that names no conversation.
5. **v1 breadth — presets are the front door, free-form is the side door.**
   `canvas_new` and the tab's gallery offer the preset table only, and every lint,
   safe-area guide and export default comes from the chosen preset, because the
   point of a preset is that the model cannot get the delivery wrong. A document
   *may* declare its own `canvas` with explicit width and height (≤ 4096²) — a
   poster no network defines is a real need — but then only the generic lints
   apply, the report says plainly that no destination preset applied, and
   `canvas_export` warns that the result is a picture rather than a delivery.

## 13. What I would verify before calling it done

1. `node scripts/checks/check-canvas-node.mjs` — layout arithmetic, validator
   refusals, store caps, routes, exports, font hashes, skills.
2. Headless Edge against the real app (the method the right bar was verified
   with): the ring reads `Chat | Trajectory | Canvas`, the Canvas tab sits to the
   right of Trajectory, the view is full height with the composer floating over
   it, an archetype renders at 1280×640, **no slot error and no console error**.
3. The agent path, end to end, as the agent: `canvas_new` → `canvas_patch` →
   `canvas_render` → `read_image` on the returned PNG (the picture must come back
   and match the document) → `canvas_export` → **read the PNG's own IHDR** to prove
   the file is exactly 1280×640 (or 2560×1280 at `@2x`) and under the destination's
   byte ceiling — and that the report names `Space Grotesk` / `Inter` as the
   families actually resolved, with the `.svg` export carrying both as embedded
   data URLs, so the same document wraps identically on a host that has neither
   installed.
4. A deliberately bad document: a font family the package does not ship, a 6-line
   headline at display size, a `100000`-wide canvas, an SVG with a `<script>`, an
   image outside the workspace, an asset past the cap — each must come back as its
   own typed refusal, never a blank artboard.
5. A reload mid-design: the store survives, the verdict for the last revision is
   `stale` (never a false `drawn`), and the tab re-renders on mount.
