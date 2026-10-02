# dsh-canvas (alpha.1)

**The Canvas tab** — a design page the agent drives, in the chat panel's own view
ring, **to the right of Trajectory**. It exists for one job: produce a GitHub
social preview, a LinkedIn banner, a post image, an OG card or a poster, with a
**language model and skills** and **no image-generation model anywhere** — and
then hand the person a real file at the right pixel size.

Nine agent tools own the surface. The model authors a small JSON design language,
validates it on the host, asks the **browser** to paint it, **reads the PNG
straight back with `read_image`**, and fixes what it sees. That last step is not a
nicety: it is the whole reason a text-only model can design at all.

```
canvas_new   preset + archetype -> a starter composition
canvas_write the whole document, validated before it is stored
canvas_patch pointer ops (set/remove/insert) - never re-emit a design to move one element
canvas_read  the canonical document, the last verdict, the measurements, the lints
canvas_render  -> the BROWSER paints it -> PNG + metrics + lints -> read_image
canvas_export  PNG / JPG / SVG at 1x or 2x, to the Desktop or into the conversation
canvas_publish / canvas_delete / canvas_assets
```

## The tab, and where it sits (read out of the pinned line, not assumed)

| Fact | Where it comes from |
|---|---|
| The chat panel's header carries a **view ring**: a `conversation.view` slot, session-scoped, one entry per registered view | `dsh-client-ui-conversation` |
| A view registers with `{ name: 'conversation.view', id, order, label, inject }` | `dsh-client-ui-trajectory` (id `trajectory`, order 10), `dsh-client-ui-chat` (id `chat`, order 0) |
| So `order: 20` is literally to the **right of Trajectory** | the shell sorts `slots.entries('conversation.view')` |
| Trajectory is **gated** on developer tools; Canvas is not (it is a product surface) | the shipped `viewTabs()` |
| A view receives **no `sessionId` prop** — it learns its session from its own `inject(sessionId)` face | the shipped Trajectory view's shape |
| A view becomes full height with the composer floating over it by putting `data-conversation-composer-overlay` on its root | the conversation stylesheet |

With developer tools off the ring reads `Chat | Canvas`; with them on,
`Chat | Trajectory | Canvas`.

## Why the browser is the rasterizer

The host **cannot** paint a design, and pretending otherwise is how a design
surface drifts from its own export:

- a design is laid out with **real text metrics**, which only a browser has;
- the PNG must be produced by the **same** code path that draws the artboard, or
  "it looked right in the tab" becomes a bug class;
- the fonts must be **the loaded faces**, not a guess at their widths.

So the host owns the document and the browser owns the pixels, and the two are
joined by a **render queue**: `canvas_render` enqueues a request carrying the
document and its revision, the page long-polls `GET /render-queue?session=*`,
paints, encodes a PNG plus a 25 %-scale "feed" thumbnail, posts back the
measurements and the lints, and the tool resolves with a path the model reads
with `read_image`.

Two consequences worth stating plainly:

- the renderer is a **page-level service**, not a tab one: a render asked for in
  one conversation is answered while a different conversation (or a different
  tab) is on screen, because the poll asks for *any* session and the request
  itself names its own;
- a render needs the **app page open**, not the tab. If no page answers within
  20 s the call says so in one sentence and nothing is lost.

## The document language

One JSON object: `preset` (or an explicit `canvas`), `tokens`, and `layers`.

```jsonc
{
  "title": "Launch banner",
  "preset": "github-social",                       // fixes 1280x640 + its safe areas
  "tokens": {
    "color": { "ink": "#F8FAFC", "muted": "#94A3B8", "accent": "#4D6BFE", "surface": "#0B0E14" },
    "font":  { "display": "Space Grotesk", "text": "Inter", "mono": "system" },
    "scale": { "display": 72, "title": 40, "subtitle": 26, "body": 22, "caption": 15 },
    "space": 8,                                    // the rhythm unit
    "radius": { "card": 20, "chip": 8, "pill": 999 }
  },
  "layers": [
    { "kind": "art", "style": "mesh", "colors": ["accent", "surface"], "seed": 7, "opacity": 0.55 },
    { "kind": "frame", "x": 72, "y": 72, "w": 700, "direction": "column", "gap": 16, "padding": 24,
      "justify": "center", "align": "start", "border": { "width": 1, "color": "muted" },
      "children": [
        { "kind": "text", "text": "Eyebrow", "style": "caption", "color": "accent", "transform": "upper" },
        { "kind": "text", "w": "fill", "style": "display", "maxLines": 2,
          "runs": [ { "text": "One agent. " }, { "text": "One toolchain.", "color": "accent" } ] },
        { "kind": "text", "w": 500, "style": "body", "color": "muted", "text": "…" },
        { "kind": "shape", "shape": "rect", "w": 160, "h": 40, "radius": 999, "fill": "accent" }
      ] },
    { "kind": "image", "x": 900, "y": 120, "w": 240, "h": 160, "src": "shot.png",
      "fit": "cover", "radius": 12, "scrim": "bottom" },
    { "kind": "svg", "x": 60, "y": 520, "w": 120, "h": 40, "viewBox": [0, 0, 24, 8],
      "svg": "<path d=\"M0 4h24\" stroke=\"#fff\" stroke-width=\"1\"/>" }
  ]
}
```

**Six node kinds**: `frame` (flow or absolute box: padding, gap, direction,
justify, align, background, radius, border, shadow, blend), `text` (one style or
`runs`; wrap, `maxLines`, ellipsis, align, line-height, letter-spacing,
transform), `image` (fit, zoom, focus, radius, scrim, blend), `shape` (rect,
ellipse, line, polygon, path), `art` (ten seeded generators), `svg` (a scanned
fragment: `<path>`, `<defs>`, `<g>`, gradients and text only — no script, no
`foreignObject`, no external `href`, no event attributes).

### The sizing rules, because a language the model cannot predict is unusable

| Value | Meaning |
|---|---|
| a number | that many pixels |
| `"fill"` | the parent's content box (on a frame's MAIN axis: the leftover space, shared between the `fill` children) |
| `"hug"` | the node's own content size |
| absent | the kind's default — a **text** node hugs and does **not** wrap (give it a `w` to wrap it, and the report warns when a long line leaves the canvas), a **frame** hugs its main axis and fills the cross one, an **image** hugs its aspect, `art`/`svg` fill |
| `x`/`y` on a frame's child | the child leaves the flow and is placed inside the frame's padding box |
| a column frame | **stretches** its children across the width — that is what makes its text wrap |

Colours may be a token name (resolved to a literal at write time) or any CSS
colour; fonts may be a bundled family or `system`; anything else is refused **by
name** (`BAD_FONT`), because a family the package does not ship would silently
fall back and re-wrap a headline.

### Presets: destinations, as data

Ten rows, each with a `verifiedOn` date and its sources, so a number that moves is
a number somebody can re-check (`check-canvas-node.mjs` fails a row that is
missing either):

| Preset | Canvas | Formats | Ceiling |
|---|---|---|---|
| `github-social` | 1280×640 | png, jpg | 1 MB |
| `github-readme` | 1280×320 | png, jpg, svg | 5 MB |
| `og` | 1200×630 | png, jpg | 5 MB |
| `linkedin-personal-banner` | 1584×396 | png, jpg | 8 MB |
| `linkedin-company-banner` | 1128×191 | png, jpg | 8 MB |
| `linkedin-post` | 1200×627 | png, jpg | 8 MB |
| `linkedin-square` | 1200×1200 | png, jpg | 8 MB |
| `linkedin-carousel-page` | 1080×1350 | png, jpg | 8 MB |
| `x-post` | 1600×900 | png, jpg | 5 MB |
| `poster-a3` | 3508×4961 (300 dpi) | png, svg | 40 MB |

A preset also carries its **safe areas** (`safe` guides and `keep-out` regions —
the LinkedIn profile photograph's corner, the company logo square, the X timeline's
1.91:1 crop), its margin, and the click path where the file goes. A document may
instead declare its own `canvas` — a poster no network defines is a real need —
and then only the generic lints apply and `canvas_export` says so.

### Archetypes: the craft, encoded

Eight complete starter documents (`editorial-split`, `statement-centered`,
`product-mesh`, `stat-grid`, `code-card`, `wordmark-dark`, `roadmap-strip`,
`docs-collage`), each a real composition with hierarchy, a margin rhythm and a
full token block, each naming the presets it is composed for. `canvas_new` and the
tab's **+ New** gallery start from the same files, so the model spends its effort
on the words and the palette instead of on inventing a layout — and a request for
an archetype at a preset it was not composed for is refused with the list of
presets it does fit.

### Styles: the look library

Composition and look are **separate decisions**, and the package keeps them apart:

- an **archetype** is *which* design — where the words, panels and art sit;
- a **style pack** (`lib/styles/<id>.json`) is *how it looks* — palette, type
  behaviour, shape language, surface and art treatment, plus the rules and quality
  gates a designer follows with it.

`canvas_new { preset, archetype, style }` starts a design in a look and
`canvas_style { id, style }` applies another to a design that exists; the tab has a
style picker beside the preset and a card in the side panel showing the current
style's intent, its do/don't and its gates.

**Applying a style never moves anything.** One pure transform
(`lib/styles/apply.js`) replaces the colour roles and rewrites every colour
*literal* in the document that was one of the old role values (the only way to
re-colour a canonical document, which carries literals everywhere), sets the type
behaviour, and applies the radius/border/shadow/surface/art language — geometry is
untouched, which is why it is safe on a finished design. The scale factor is a
**delta** against the style the design already carries, so applying the same style
twice is a no-op and switching back restores the original sizes exactly.

`vendor/styles-doc.mjs` generates `skills/canvas-design/reference/styles.md` from
the packs, and the tracked check fails when that document is stale — so the
catalogue the model reads is always the library the host will apply.

### The house gallery

Twelve examples ship with the package - one per style - each a **preset + archetype +
style that has already been chosen well**, plus the copy that belongs in it and a
sentence saying when to reach for it. `canvas_new { example: "night-launch" }` starts
from one; the tab's "+ New" lists them; `canvas_read` prints the gallery; an unknown id
is refused by name.

They are **data, not pictures**: the tab paints a row live and the model copies the
document, where twelve PNGs in the repository would be megabytes of pixels that go
stale the moment a style changes. `vendor/examples.mjs` generates them from the
library and `--check`s them, and every example is held to the same bar as the
archetypes and the styles: it validates, it sits on its grid, and it is legible.

### Sets: one design, several destinations

`canvas_set { id, set: "launch", export: true }` derives a design to the sizes a launch
needs (repository card, square post, link preview) - every number in the document
multiplied by the width ratio, full-bleed layers widened to the new canvas, the
composition centred in a taller one - stores each as a design of its own
(`<id>-<destination>`) and writes every file in one call through the host renderer, so
no app page is needed.

It deliberately does **not** re-compose: a derived design is the same design with more
room. Each destination judges it by its own rules, and the lints that come back name
what that destination wants adjusted - which is the family's business, not one card's.

## One layout, two painters (and why the export cannot disagree)

```
document ──normalize (host)──► canonical document ──store──► state route ──► client
                                                                                │
                                                                     layout(measure)   ← pure, measurer injected
                                                                                │
                                                                          draw-op list  ← the IR
                                                                       ├── canvas painter  → artboard AND PNG export
                                                                       └── SVG serializer  → .svg export
```

- **The layout is pure** and its text measurer is **injected**: the browser passes
  `canvas.measureText` (with `fontBoundingBoxAscent/Descent` for the baseline),
  and `check-canvas-node.mjs` passes a synthetic metrics table. Every number that
  decides where a word lands is therefore arithmetic a host with no fonts can
  verify — and the browser later runs the very same code.
- **The canvas painter serves both the artboard and the PNG export.** The exported
  file is not a second interpretation of the design; it is the same op list at
  export scale. That retires the whole "it looked right in the tab" class of bugs.
- **The SVG serializer walks the same op list** for people who want vectors. An
  SVG rendered as an `<img>` may not fetch anything, so images travel as data URLs
  (nested `<svg>` with the crop as its `viewBox`) and the bundled faces are
  embedded — and an image that could not be inlined is **named in a comment**
  rather than left as a broken reference.
- **Raw SVG fragments are rasterized once** by the client and drawn as pictures,
  so a logo or an icon reaches the PNG as well as the SVG.

## The report: what the model is told about its own picture

`canvas_render` returns a path, a feed thumbnail, the measurements and the lints:

| | |
|---|---|
| the PNG | the full design at up to 2048px on the long edge, written under `$DSH_HOME/dsh-canvas/renders/<session>/` |
| the feed thumbnail | the same design at 25 % — roughly a phone feed, which is how a banner is actually seen |
| measurements | draw ops, nodes, text nodes, lines, smallest type size, the families that **actually resolved**, and the layout time |
| lints | `SAFE_AREA`, `MARGIN`, `LOW_CONTRAST` (sampled **at the text's own position**, and it gives up honestly over a photograph or a filled path rather than guessing), `TYPE_TOO_SMALL`, `TEXT_TRUNCATED`, `TEXT_OVERFLOW`, `TEXT_UNWRAPPED`, `MANY_SIZES`, `MANY_FAMILIES`, `NO_TEXT`, `MISSING_ASSET`, `IMAGE_UNMEASURED`, `SVG_FRAGMENT_UNPAINTED` |
| the verdict | `drawn` / `failed` / `stale` / `pending`, per revision, the same vocabulary `dsh-diagrams` uses — a document that validates is not a picture, and only a renderer reports one |

A failed render is a **verdict**, not a silence: the error is stored, it shows on
the tab's pill, and `canvas_read` repeats it.

## Exports, assets and where files land

- `canvas_export { format: png|jpg|svg, scale: 1|2, target: desktop|workspace }`.
  A preset decides the format and the ceiling: exporting a GitHub social preview
  as SVG is refused by name instead of quietly producing a file the destination
  rejects. The **Desktop** is the default (a banner is something a person keeps),
  the **conversation folder** is the alternative (a README header belongs in the
  repository), and a name that exists gets `-2`, `-3`, … — nothing is overwritten.
  An export over the ceiling still writes and **says it is over**.
- **Assets** are the only images a design may use: a stored one (a name like
  `a1b2c3d4e5f6a7b8.png`, content-addressed by SHA-256, so importing the same
  picture twice costs one copy) or a **workspace-relative path**, resolved on the
  host with `realpath` containment (`OUTSIDE_WORKSPACE` rather than a read). A
  **remote URL is not a thing a design can name**: it cannot be inlined into an
  SVG, it would leak a fetch from someone's browser, and it would make the design
  irreproducible.
- The host writes: `$DSH_HOME/dsh-canvas/sessions/<session>.json` (this chat's
  designs), `library.json` (the harness-wide ones `canvas_publish` fills),
  `assets/`, `renders/<session>/`, and the exports themselves.

**Caps**: canvas ≤ 8192 px a side, 512 top-level layers, 4096 nodes, 12 levels of
nesting, 300 KB a document, 4 MB of designs per conversation, 64 designs, 12 MB
an asset, 256 assets / 256 MB of them, 2048 px for a report render, 48 MB for an
export. Every refusal is a code and a sentence.

## The fonts

`Inter` (400/600/700) and `Space Grotesk` (500/700) — **vendored** as Latin WOFF2
subsets (96 KB in total) with their upstream URLs, a SHA-256 per file and their
OFL licence texts, pinned by `vendor/build.mjs` (`--check` runs offline and is
part of the tracked check). They are served from the plugin's own routes, loaded
**before** the first layout (a face that has not loaded would re-wrap a headline
with the fallback's metrics), reported as the families that actually resolved, and
embedded as data URLs in an `.svg` export. `system` is always available and is the
deliberate choice for the mono role.

## Two skills carry the craft

- **`canvas-design`** — the default skill: the tool loop (write → patch → render →
  `read_image` → repeat → export, with the rule that a design is not finished
  until the model has looked at the render, and at the feed thumbnail for
  legibility), the full document reference with every validator, patch and lint
  code and its fix, the composition craft with numbers (one focal point, three
  levels, ≥ 2:1 headline ratio, preset margins, gaps as multiples of
  `tokens.space`, 4.5:1 body / 3:1 display contrast), the copy budgets, the ten
  art generators, and twelve copy-paste recipes.
- **`social-banners`** — the delivery skill: the per-destination table with sizes,
  safe areas **and why each exists**, what each network crops afterwards, `@2x`
  arithmetic, the feed-reality test, where the file is uploaded, and the honest
  note that these numbers move — each row carries a `verifiedOn` date and a
  source, and the model is told to re-check the network's own docs rather than
  guess again. Plus `reference/print.md` for the A3 poster (and the honest
  caveat: this pack emits RGB PNG/SVG and does no CMYK conversion).

Both are registered at runtime through `ctx.skills.register` **and** copied into
`$DSH_HOME/skills` by both installers (the generic per-package copy step, with a
`.vncode-dsh-canvas` marker), so a person can read and edit them.

## What this is NOT

- **No image generation.** There is no model that invents a photograph here:
  images come from the workspace, from a paste, or from the procedural `art`
  generators, and the composition carries the design.
- **No HTML/CSS.** A design is JSON, not a document — nothing to sandbox, no
  external fetch, and an export story that does not need a headless browser.
- **Direct manipulation is LAYER-level, not freeform.** The tab lists every node of
  the design and lets a person drag it on the artboard - writing the same
  `set x`/`set y` pointer ops a model patch writes, through the same validator -
  and reorder it inside its own array; resize handles, multi-select, snapping and
  undo are not there yet.
- **No unattended host renderer.** A render needs the app page (the tab does not
  have to be in front).
- **One artboard per design.** A "set" (banner + square + OG exported together)
  is a later alpha.
- **A starter library, not a design-system library.** Eight archetypes and ten
  destination presets ship as data; the wider registry of design *systems* - style
  packs with their own token sets, the shape the `awesome-design-skills` registry
  publishes - is the next thing to add.

## Layout

```
package.json            dsh.bundle + dsh.client (conversation, session, tool)
cordis.patch.yml        one inserted row ('canvas'); no core row disabled, no fork
lib/engine.js           the language, the pure layout, the IR, both painters, the lints,
                        the art generators, patches - ONE file with zero static imports,
                        because the browser imports it from a blob URL (dsh-pdf's shape)
lib/presets.js          the ten destinations, as data, with verifiedOn + sources
lib/fonts.js            the vendored family table (route names, weights, licences)
lib/vendor/fonts/       the five WOFF2 subsets + OFL texts + VERSION.json (hashes)
lib/store.js            the per-conversation store, the library, the asset store
lib/export.js           the Desktop, the create-exclusive writer, the workspace containment
lib/archetypes/*.json   eight starter compositions + their loader
lib/index.js            nine tools, fifteen route registrations, the render queue, the skills
lib/client.js           the tab (rail, artboard, overlays, lints, drawer, export menu),
                        the page-level renderer, and one card per tool - no build step
skills/canvas-design/   SKILL.md + reference/document.md + reference/recipes.md
skills/social-banners/  SKILL.md + reference/checklist.md + reference/print.md
vendor/build.mjs        the font vendorer/pinner (maintainer tooling, not shipped)
```

## The Excalidraw surface (alpha.10, preview)

Excalidraw is vendored as this tab's **second surface**. It is reached from the bar
(`Excalidraw preview`) and it renders **over** the design surface rather than
replacing the tab: the design keeps its zoom, its selection and its exports while
the editor is up, and switching back is a state change, not a reload. The note
under the editor says what it is, because what it is *today* is a preview.

**What it proves.** That the artifact loads from this package's own route the way
the client loader loads it, mounts in the real pane, that its stylesheet is what
makes it usable, and that the imperative API an agent tool will drive answers:
`skeleton → convertToExcalidrawElements → updateScene → getSceneElements →
serializeAsJSON` (an `.excalidraw` document) and `exportToSvg`/`exportToBlob`.

**What it does not do yet, stated rather than discovered later:**

| | |
|---|---|
| the agent tools | still speak this package's document language; nothing is re-pointed yet |
| the document | a design is not a scene; there is no `canvas_write → scene` bridge yet |
| presets, styles, lints, sets | unchanged, and still the design surface's |
| runtime assets | fonts (234 files, 12.5 MB) and the 55 locales have **no route**; Excalidraw falls back to the faces its bundle carries, which the check measures rather than assumes |

**The vendor tree** (`lib/vendor/excalidraw/`, committed, and the only place the
bytes live):

| file | size | what it is |
|---|---|---|
| `excalidraw.min.js` | 3.07 MiB | one classic script, iife, `globalThis.DSHExcalidraw`; React 18.3.1 inlined |
| `excalidraw.css` | 141 KiB | Excalidraw's own stylesheet — not optional: `--color-primary` and every layout rule live here |
| `fonts/<Family>/*.woff2` | 429 KiB, 25 files | the **eight Latin faces**, one immutable route per file |
| `LICENSE-*.txt` | 1–2 KiB | Excalidraw's (fetched from the pinned tag, hash-pinned in the build) and React's |
| `VERSION.json` | — | the pins, the trims, the patches, a sha256 per file **and per face**, and what is skipped |

**The faces, and why they are a subset.** Excalidraw fetches its faces at runtime
and builds each URL as `new URL('fonts/<Family>/<file>', EXCALIDRAW_ASSET_PATH)` — so
the client points that base at the **editor's own namespace**
(`/api/dsh-canvas/vendor/excalidraw/`, trailing slash included) and this package
serves one exact route per file there. What ships is every **Latin** family: eight
families, 25 files, 429 KiB. What does not is the CJK face — Xiaolai, **209 of the
234 published files and 12.1 MiB** — and it is *declared* skipped in
`VERSION.json.unshipped.cjkFonts` rather than quietly absent, because a missing face
is a 404 the editor swallows as a fallback: the text draws as boxes and nothing says
why. The check enforces exactly that distinction — every face the bundle can name is
either vendored or in a declared-skipped family, and one missing outside a
declaration fails the check.

**Three route families**, because the connection's registry matches exact paths:
`GET /api/dsh-canvas/vendor/excalidraw.js` and `…/excalidraw.css` — both
`cache-control: no-cache` with the recorded sha256 as their ETag (a 3 MiB artifact
must never be served stale), both answering `304` and `HEAD`, and a missing artifact
is a `503` that names the rebuild command — plus one **immutable** route per face
under `…/vendor/excalidraw/fonts/<Family>/<file>`.

**Rebuilding it** (a build root the distribution skips, like the CodeMirror,
pdf.js and mermaid trees):

```sh
cd packages/dsh-canvas/vendor/excalidraw
npm install
node build.mjs           # build + rewrite lib/vendor/excalidraw/VERSION.json
node build.mjs --check   # re-hash the committed artifact OFFLINE
```

`build.mjs` does three things to upstream, and `VERSION.json` names all three:
it **stubs the 55 locale modules** (dynamic imports, which esbuild's iife format
would otherwise inline: measured at 1.59 MiB), it **stubs the Mermaid-to-Excalidraw
dialog** (`@excalidraw/mermaid-to-excalidraw` drags mermaid in behind it: measured
at 3.37 MiB), and it applies any **patches** in `patches/index.mjs` — esbuild
plugins, because the artifact IS the build and a text diff against a minified
3 MiB file would rot on the next version bump. The two trims are why this ships at
3.07 MiB instead of 8.02 MiB. **No submodule**: the pack's rule is a pinned build
root plus a committed artifact, and the install flow is "clone, run the installer".

## Check

```sh
node scripts/checks/check-canvas-node.mjs       # the host half, hermetically
node scripts/checks/check-canvas-excalidraw.mjs # the vendored surface, in a real browser
node scripts/checks/check-client-bundles.mjs    # the browser half, with real React
node scripts/checks/check-skill-examples.mjs    # every ```canvas block in the skills
```

`check-canvas-node.mjs` is the one to read first: it drives the engine, the two
painters (through a recorder), the store, the asset store, the tools, the routes,
and the **whole render round trip** — the tool enqueues, the long-poll hands the
request out, a synthetic browser posts a real PNG back, and the tool resolves with
a path whose own IHDR is then read. Everything it writes goes into one temp tree
(`DSH_HOME`, `USERPROFILE`, `HOME`), so no run can touch the real profile.

`check-canvas-excalidraw.mjs` needs a Chromium-family browser (it skips loudly
without one) and is the only check that can see a third-party editor: it serves the
**committed** artifact over loopback the way the client loader does, mounts it,
and asserts the shell, Excalidraw's own canvases and UI, that its **stylesheet
applied** (`--color-primary` resolves), that the imperative API answers, that a
skeleton scene becomes four elements with the kinds asked for, that it serializes
as an `.excalidraw` document, and that the SVG export answers. It also runs
`vendor/excalidraw/build.mjs --check`, so the artifact can never drift from its
record.

## Alpha

- **alpha.1** — the tab at `order: 20`, the document language and
  validator, the store + library + assets, the engine with both painters, the
  vendored fonts, the nine tools, the routes, the tab (rail, artboard with a zoom
  ladder and panning, safe-area and node-box overlays, live lints, the source
  drawer, the export menu), the **render-verify loop** with the feed thumbnail and
  `read_image`, the presets and archetypes, and the two skills.
- **alpha.9** — the panel: direct manipulation on the artboard (rulers, eight
  handles on a box and two side handles on a text layer, the gesture decided once
  on pointer down), the inspect pane (nudge pad, typed size, rotate, opacity,
  colours per layer kind), the layers pane, and the one-row bar.
- **alpha.10 (this branch)** — the vendored **Excalidraw surface**: the build root,
  the pinned + trimmed + hashed artifact, its two routes, the client loader, the
  preview toggle, and the browser check above. Nothing is re-pointed yet.
- Next: the asset routes (fonts/locales), then the agent tools on the scene
  (`canvas_write` → skeletons, `canvas_read` → the scene JSON), then the question
  this preview exists to answer — whether the design surface, its presets, styles
  and lints move onto Excalidraw or stay beside it.
