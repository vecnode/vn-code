# dsh-canvas (alpha.11)

**The Canvas tab: a design page the agent drives, in the chat panel's own view ring
to the right of Trajectory.**

The model authors a small JSON design language, the host validates and stores it,
and the **browser** paints it: the model reads the returned PNG with `read_image`
and fixes what it sees, which is the loop. There is no image-generation model here
(pictures come from the workspace, a paste or the seeded `art` generators), a
design is JSON rather than HTML/CSS, and a render needs the **app page** open - no
page answering within 20 s says so.

## What it adds

- **Eleven tools**: `canvas_new`, `canvas_write`, `canvas_patch` (pointer ops, at
  most 64 a call), `canvas_read`, `canvas_style`, `canvas_set` (one design derived to
  several destinations), `canvas_publish`, `canvas_delete`, `canvas_render`,
  `canvas_export`, `canvas_assets`.
- **The document language**: `preset` (or an explicit `canvas`), `tokens` and
  `layers`; six node kinds (`frame`, `text`, `image`, `shape`, `art`, `svg`); a
  CANONICAL form (tokens resolved, defaults filled) and every refusal a code.
- **Ten presets as data** with a `verifiedOn` date and sources - `github-social`
  (1280x640), `github-readme`, `og`, `linkedin-personal-banner` (1584x396),
  `linkedin-company-banner`, `linkedin-post`, `linkedin-square`,
  `linkedin-carousel-page`, `x-post`, `poster-a3` (3508x4961) - each with its
  formats, byte ceiling, safe/keep-out areas, margin and click path.
- **Eight archetypes, twelve styles, twelve house examples**: `canvas_new` and the
  tab's **+ New** start from the same files, and `canvas_style` applies a look
  (`lib/styles/<id>.json`) through one pure transform that re-colours and re-types
  a design and **never moves anything** - as a delta against the style it carries.
- **One layout, two painters**: `lib/engine.js` is one file with zero static
  imports (the browser imports it from a blob URL); the layout is pure with the
  text measurer **injected**, and one draw-op list feeds the canvas painter (which
  serves the artboard **and** the PNG export) and the SVG serializer.
- **The render queue**: `canvas_render` enqueues the document and its revision, the
  page paints and posts back the PNG, a 25%-scale feed thumbnail, the measurements
  and the lints; the verdict is `drawn` / `failed` / `stale` / `pending`.
- **Advisory lints**, each with a fix: `SAFE_AREA`, `MARGIN`, `LOW_CONTRAST`, `TYPE_TOO_SMALL`,
  `TEXT_TRUNCATED`, `TEXT_OVERFLOW`, `TEXT_UNWRAPPED`, `MANY_SIZES`, `MANY_FAMILIES`, `NO_TEXT`,
  `MISSING_ASSET`, `IMAGE_UNMEASURED`, `SVG_FRAGMENT_UNPAINTED`.
- **Exports**: PNG/JPG/SVG at 1x or 2x, to the Desktop (default) or the
  conversation folder, create-exclusive (`-2`, `-3`, ...); the preset decides the
  format and the ceiling, and one over the ceiling still writes and says so.
- **Assets**: a stored image content-addressed by SHA-256, or a workspace-relative
  path resolved on the host with `realpath` containment - a remote URL is not a
  thing a design can name.
- **Excalidraw, the second surface** (preview): a vendored 3.07 MiB artifact and 141 KiB
  stylesheet rendered **over** the design surface, so the design keeps its zoom, selection
  and exports; `lib/scene.js` validates its skeleton scenes on the host while the tools
  still speak the document language.

## How it plugs in

| Piece | Value |
|---|---|
| row | `canvas` (one inserted row; no core row disabled, no fork) |
| tab | `conversation.view` id `canvas` at `order: 20` - right of Trajectory (10), after Chat (0); unlike Trajectory it is not gated on developer tools |
| session | a view receives no `sessionId` prop; it learns its session through its own `inject(sessionId)` face |
| seats | one `tool.call.toolview` per tool name, plus the page-level renderer |
| addresses | `dsh-resource://canvas/session/<session>/<id>`, `dsh-resource://canvas/library/<id>` |
| skills | `canvas-design` and `social-banners`, registered at runtime **and** copied into `$DSH_HOME/skills` by both installers under a `.vncode-dsh-canvas` marker |

Routes are exact paths, `GET`/`HEAD`/`POST` only:

| Method | Paths |
|---|---|
| `GET` | `/api/dsh-canvas/state`, `/health`, `/render-queue?session=*`, `/workspace-asset`, `/vendor/engine.js`, `/vendor/excalidraw.js`, `/vendor/excalidraw.css` |
| `POST` | `/api/dsh-canvas/document`, `/delete`, `/publish`, `/render-report` |
| both | `/api/dsh-canvas/asset`; one immutable route per vendored face under `/vendor/fonts/<file>` and `/vendor/excalidraw/fonts/<Family>/<file>` |

## Limits

- canvas 8192 px a side, 512 top-level layers, 4096 nodes, 12 levels of nesting,
  256 KB a document, 4 MB of designs per conversation, 64 designs.
- 12 MB an asset, 256 assets / 256 MB in total; a report render is capped at
  2048 px on the long edge and an export at 48 MB.
- Fonts: Inter 400/600/700 and Space Grotesk 500/700 as Latin WOFF2 subsets (96 KB), served
  from this plugin's own routes and loaded **before** the first layout; `system` is the mono role.
- No host renderer for a tool call, no image generation, no HTML/CSS, one artboard
  per design, no npm dependencies.

## Verify

```
node scripts/checks/check-canvas-node.mjs
node scripts/checks/check-canvas-scene.mjs
node scripts/checks/check-canvas-excalidraw.mjs   # needs a Chromium-family browser
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-skill-examples.mjs
```
