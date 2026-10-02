# The canvas document, in full

This is the field reference for the JSON design language: every key of every
node kind, the token block, the defaults, the layout arithmetic, the caps and
every code the validator can return. It exists so you never have to guess a
field name and pay for a round trip - the validator is complete, so a wrong key
is always a named refusal with a path, and the name is in the tables below.

Paths in this file are relative to `packages/dsh-canvas/lib/` in the plugin
package: `engine.js` is the language, the layout pass, the painters and the
lints, and `presets.js` is the destination table.

## The pipeline

```
document ──normalizeDocument──► canonical document
                                     │
                                layout(measure)            ← pure; the browser injects canvas.measureText
                                     │
                                draw-op list               ← the IR both painters consume
                                     ├── paintCanvas(...) → the artboard AND the exported PNG
                                     └── toSvg(...)       → the .svg export
```

`normalizeDocument(input, { presets, fonts })` returns
`{ document, problems, preset }`: `document` is the canonical form when
`problems` is empty, otherwise `null`. **Canonical** means defaults are filled
in, colour tokens are resolved to literals, numbers are rounded to three
decimals and key order is stable - which is why `canvas_read` hands back
something taller than what you wrote, and why a patch path addresses the
canonical form rather than the text you sent.

`layout` is pure and needs an injected `measure(text, font) -> number`; the
browser passes `canvas.measureText`, so the arithmetic that decides where every
word lands is the same arithmetic on every machine.

## The skeleton

```json
{
  "title": "Launch banner",
  "notes": "the words are the final copy",
  "preset": "github-social",
  "canvas": { "width": 1280, "height": 640, "background": { "type": "solid", "color": "#0B0E14" } },
  "tokens": {
    "color": { "ink": "#F8FAFC", "muted": "#94A3B8", "accent": "#4D6BFE", "surface": "#0B0E14" },
    "font": { "display": "Space Grotesk", "text": "Inter", "mono": "system" },
    "scale": { "display": 72, "title": 40, "subtitle": 26, "body": 22, "caption": 15 },
    "space": 8,
    "radius": { "card": 20, "pill": 999, "chip": 8 }
  },
  "layers": []
}
```

| Top-level key | Type | Default | Notes |
|---|---|---|---|
| `title` | string, ≤ 120 chars | absent | the design's name in the rail and the id's source |
| `notes` | string, ≤ 4000 chars | absent | your own note; never drawn |
| `preset` | a preset id | absent | fixes `canvas.width`/`height` when they are absent; see the table below |
| `canvas` | object | required without a preset | `width`, `height`, `background` |
| `canvas.width` / `canvas.height` | whole pixels | the preset's | 16-8192 each, integers (`BAD_CANVAS` otherwise) |
| `canvas.background` | colour token, literal colour, gradient or art fill | `#0B0E14` | required key may be absent; a **token name is not allowed here** (no `tokens` to resolve against yet) - use the literal |
| `tokens` | object | all defaults | see below |
| `layers` | array of nodes | required | at most 512 top-level layers |

**One of `preset` or both `canvas.width` and `canvas.height` is required**, or
`NO_CANVAS`. A document that names a preset **may not override the size** into
something the destination does not accept - the preset's number wins; free-form
work omits `preset` and declares its own canvas.

### Presets

| `preset` | Size | Margin | Formats | Ceiling | Keep-out regions (a node that reaches in is `SAFE_AREA`) |
|---|---|---|---|---|---|
| `github-social` | 1280x640 | 48 | png, jpg | 1 MB | lower-right card corner (1060,520 220x120) |
| `github-readme` | 1280x320 | 40 | png, jpg, svg | 5 MB | - |
| `og` | 1200x630 | 64 | png, jpg | 5 MB | - |
| `linkedin-personal-banner` | 1584x396 | 48 | png, jpg | 8 MB | profile photo and headline (0,236 620x160) |
| `linkedin-company-banner` | 1128x191 | 24 | png, jpg | 8 MB | company logo square (0,71 200x120) |
| `linkedin-post` | 1200x627 | 56 | png, jpg | 8 MB | - |
| `linkedin-square` | 1200x1200 | 96 | png, jpg | 8 MB | - |
| `linkedin-carousel-page` | 1080x1350 | 72 | png, jpg | 8 MB | page number (888,1230 144x72) |
| `x-post` | 1600x900 | 80 | png, jpg | 5 MB | centre 1.91:1 crop (0,208 1600x484) |
| `poster-a3` | 3508x4961 | 210 | png, svg | 40 MB | bleed (0,0 3508x100) |

A preset's `safe` regions are guides drawn by the tab, never warnings. A node
whose box **covers the whole canvas** (a full-bleed art or background layer) is
exempt from keep-out checks. `exportProblems(preset, format, bytes)` is the one
place the export command and the report agree about the ceiling; a format the
preset does not take is `BAD_FORMAT`, a file over the ceiling is `TOO_LARGE`,
and a document with no preset gets `NO_PRESET` ("only generic rules were
applied").

## The token block

| Key | Shape | Default | Validation |
|---|---|---|---|
| `tokens.color` | `{ name: colour }` | `ink #F8FAFC`, `muted #94A3B8`, `accent #4D6BFE`, `surface #0B0E14` | a name must match `^[a-z][a-z0-9-]{0,23}$` (`BAD_TOKEN_NAME`); a value must be a **literal** colour (`BAD_COLOR` - tokens cannot reference other tokens) |
| `tokens.font` | `{ display\|text\|mono: family }` | all `system` | the role must be one of `display`, `text`, `mono` (`BAD_FONT_ROLE`); the family must be one the package ships or `system` (`BAD_FONT`) |
| `tokens.scale` | `{ name: px }` | `display 72`, `title 40`, `subtitle 26`, `body 22`, `caption 15` | name grammar as above (`BAD_TOKEN_NAME`); each value 6-400 (`BAD_SCALE`) |
| `tokens.space` | number | 8 | 2-64 px (`BAD_SPACE`) |
| `tokens.radius` | `{ name: px }` | `card 20`, `pill 999`, `chip 8` | name grammar; value 0-999 (`BAD_RADIUS`) |

`tokens.color`, `tokens.font`, `tokens.scale` must be objects (`BAD_TOKENS`)
and `tokens.radius` must be an object of numbers.

**Colours.** A colour value anywhere in a document is either a token name
defined in `tokens.color` or a literal: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
`rgb()`/`rgba()`, `hsl()`/`hsla()`, or `transparent`/`none`. A colour is
resolved to its literal in the canonical document, so the painters, the SVG
serializer and the contrast sampler never see a token.

**Families.** `Space Grotesk` (weights 500 and 700) and `Inter` (weights 400,
600 and 700) are vendored as Latin WOFF2 subsets; `system` is the machine's own
stack and is deliberately the mono role - a code motif wants the host's terminal
face. A weight with no vendored file still resolves (the browser picks the
nearest face), so use 400/600/700 for Inter and 500/700 for Space Grotesk and
the file you get is the file you asked for.

**Text nodes name a family by ROLE, not by family name.** `family` is
`"display"`, `"text"` or `"mono"`; which actual family that is comes from
`tokens.font`. Change the palette in one place and every node follows.

## Nodes: the shared fields

Every node has `kind` plus these optional fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | absent | `^[a-z0-9][a-z0-9-]{0,31}$` (`BAD_ID`); used by reports and overlays |
| `x` / `y` | number | absent | naming **either** takes the node out of its parent's flow and places it inside the parent's **padding box**. Range -8192..8192 (`BAD_GEOMETRY`) |
| `w` / `h` | number, `"fill"`, `"hug"` | the kind's default | a number is 1-8192 (`BAD_GEOMETRY`) |
| `opacity` | 0-1 | 1 | `BAD_OPACITY` |
| `rotate` | -360..360 degrees | 0 | about the node's centre (`BAD_ROTATE`) |
| `blend` | `normal`, `multiply`, `screen`, `overlay`, `soft-light`, `hard-light`, `darken`, `lighten` | `normal` | `BAD_BLEND`; the intersection of canvas and CSS |
| `shadow` | `{x, y, blur, color}` | absent | x/y -200..200, blur 0..200 (`BAD_SHADOW`); color defaults to 45 % black |
| `background` | colour, gradient or art fill | absent | `BAD_PAINT`, `BAD_COLOR`, `BAD_ART` |
| `radius` | number 0-999 or a `tokens.radius` name | 0 | a radius token that does not exist is `BAD_RADIUS` |
| `border` | `{width, color, dash?}` | absent | width 0-80 (`BAD_BORDER`), color defaults to `muted`, `dash` is up to 8 non-negative numbers. **Setting a radius clips the node's children** unless `clip: false` |

`background` and `fill` are a **paint**, which is one of these four forms:

```json
[
  { "type": "solid",  "color": "accent" },
  { "type": "linear", "angle": 160, "stops": [ { "at": 0, "color": "surface" }, { "at": 1, "color": "#131A2A" } ] },
  { "type": "radial", "cx": 0.5, "cy": 0.3, "r": 0.7, "stops": [ { "at": 0, "color": "accent" }, { "at": 1, "color": "#00000000" } ] },
  { "type": "art",    "style": "mesh", "colors": ["accent", "surface"], "seed": 7, "density": 0.5, "scale": 1, "opacity": 0.5 }
]
```

A gradient needs 2-8 stops, each `{at: 0..1, color}` (`BAD_PAINT`); `angle` is
-360..360 and is measured clockwise from the +x axis (140 and 160 read as a
diagonal, 180 as bottom-to-top); `cx`/`cy` are -1..2, `r` is 0.01..3.
`BAD_PAINT` also covers a `type` that is not `linear`, `radial` or `art`.

## `frame`

The only node that holds children, and the only one that lays anything out.

| Field | Type | Default | Notes |
|---|---|---|---|
| `direction` | `column` \| `row` | `column` | `BAD_FRAME` otherwise |
| `gap` | number 0-400 | 0 | the space between in-flow children (a multiple of `tokens.space`, by convention) |
| `padding` | number, `[top, right, bottom, left]`, or `{top,right,bottom,left}` | 0 | each 0-600 (`BAD_PADDING`) |
| `justify` | `start` \| `center` \| `end` \| `space-between` | `start` | main-axis placement of the children |
| `align` | `start` \| `center` \| `end` \| `stretch` | `start` | cross-axis placement |
| `children` | array of nodes | `[]` | at most 64 per frame (`TOO_MANY_CHILDREN`), nesting at most 12 deep (`TOO_DEEP`) |
| `clip` | boolean | implied by `radius` | `true` clips children to the box; `false` disables the radius clip |

Frame sizing is the one place the language has a rule instead of a default: **a
frame hugs its main axis and fills the cross one**. A column frame with no `w`
takes the width its parent gives it and the height its children need; give it a
numeric `w` and its own inner width becomes what its children measure against,
which is how a panel wraps body copy at the panel's width.

`align: "stretch"` on a column frame makes every child without a cross-axis size
take the full inner width. `justify: "space-between"` pushes the first child to
the start and the last to the end, splitting the free space between the gaps -
and it has no effect when a child is `"fill"`.

## `text`

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | string, ≤ 4096 chars | - | required unless `runs` is given (`BAD_TEXT`, `TEXT_TOO_LARGE`) |
| `runs` | array, ≤ 24 | - | `[{text, color?, weight?, size?}]`; at most 4096 chars across all runs (`BAD_RUN`, `TOO_MANY_RUNS`) |
| `style` | a `tokens.scale` name | `body` | a name not in the scale is `BAD_STYLE` |
| `size` | number 6-400 | the style's size | given, it overrides the style (`BAD_SIZE`) |
| `family` | `display` \| `text` \| `mono` | `display` for `display`/`title` styles, else `text` | `BAD_FONT_ROLE` |
| `weight` | 100-900 | 700 for `display`/`title`, else 400 | snapped to the nearest 100 (`BAD_WEIGHT`) |
| `color` | colour token or literal | the `ink` token | `BAD_COLOR` |
| `lineHeight` | 0.7-3 (a multiple of the size) | 1.25 | `BAD_LINEHEIGHT` |
| `letterSpacing` | -20..80 px | 0 | `BAD_TRACKING`; 1.5-3 on an uppercase eyebrow |
| `align` | `start` \| `center` \| `end` | `start` | within the node's own box only (`BAD_ALIGN`) |
| `wrap` | boolean | `true` | `false` never wraps |
| `maxLines` | integer 1-12 | unlimited | `BAD_MAXLINES`; over the limit the last line is ellipsized and the report says `TEXT_TRUNCATED` |
| `ellipsis` | boolean | `true` | `false` cuts without the `…` |
| `transform` | `none` \| `upper` \| `lower` \| `title` | `none` | `BAD_TRANSFORM`; applied before wrapping |

**A text node wraps only when it is given a width.** `w` as a number, `w:
"fill"`, or a column parent that stretches it across the width. With no width
it hugs a single line and the report warns `TEXT_UNWRAPPED` when that line runs
past the canvas. Line height is `size * lineHeight`, so a two-line 22px body at
1.25 needs 55px of height and a 1.05 display headline at 72px needs 75.6px.

## `image`

| Field | Type | Default | Notes |
|---|---|---|---|
| `src` | string, ≤ 512 chars | - | a workspace-relative path or a registered asset name (`BAD_SRC`); **a remote URL is refused** - import the bytes |
| `fit` | `cover` \| `contain` \| `fill` | `cover` | `BAD_FIT` |
| `zoom` | 1-8 | 1 | magnifies around `focus` (`BAD_ZOOM`) |
| `focus` | `{x, y}` in 0..1 | `{0.5, 0.5}` | which part of the picture survives the crop (`BAD_FOCUS`) |
| `scrim` | `none` \| `bottom` \| `top` \| `left` \| `right` \| `full` \| `circle` | `none` | `BAD_SCRIM` |
| `scrimColor` | colour token or literal | `#000000` | `BAD_COLOR` |
| `scrimStrength` | 0-1 | 0.65 | the opaque end of the gradient (`BAD_SCRIM`) |

Without one of `w`/`h` the natural size is used and the other axis follows the
asset's aspect ratio. If the asset table does not describe the `src`, the layout
assumes 4:3 and warns `IMAGE_UNMEASURED`; if it is not registered at all the
lint is `MISSING_ASSET` (an **error**, not a warning). A directional scrim is a
linear gradient from `scrimColor` at `scrimStrength` to fully transparent at
62 % of the box; `full` is a flat wash at that strength and `circle` is a radial
vignette. A scrim is what makes type over a photograph legal.

## `shape`

| Field | Type | Default | Notes |
|---|---|---|---|
| `shape` | `rect` \| `ellipse` \| `line` \| `polygon` \| `path` | `rect` | `BAD_SHAPE` |
| `fill` | colour, gradient or art fill | none | `BAD_PAINT` |
| `stroke` | colour | none | `BAD_COLOR` |
| `strokeWidth` | 0-80 | 1 when `stroke` is set | `BAD_STROKE` |
| `dash` | up to 8 non-negative numbers | solid | `BAD_DASH` |
| `points` | 3-64 `{x, y}` in 0..1 of the node box | - | required by a polygon (`BAD_POINTS`) |
| `d` | path string, ≤ 8000 chars | - | required by a path; only path commands and numbers (`BAD_PATH`) |

A `line` runs from the box's top-left to its bottom-right, so an accent rule is
a `rect` with a small `h` and a `radius`, and a diagonal is a `line` with a `w`
and an `h`. An `ellipse` is drawn inside its box (rx = w/2). `points` are
normalised to the node's box, so moving the box moves the shape.

## `art`

| Field | Type | Default | Notes |
|---|---|---|---|
| `style` | one of the ten below | - | required (`BAD_ART`) |
| `colors` | up to 4 colours | `[accent, surface, ink]` | resolved to literals (`BAD_ART`, `BAD_COLOR`) |
| `seed` | integer 0-999999 | 1 | makes the picture deterministic; the same seed is the same picture everywhere |
| `density` | 0-1 | 0.5 | how many elements the generator draws |
| `scale` | 0.05-8 | 1 | element size multiplier |
| `opacity` | 0-1 | 1 | the whole layer's strength |

Styles: `mesh`, `grid`, `stripes`, `rings`, `glow`, `grain`, `waves`,
`blueprint`, `circuit`, `stars`. Every generator is bounded by
`LIMITS.maxArtOps` (600 draw ops), starts from the same seeded PRNG, and reads
no clock, no file and no random source - so a design is byte-identical on every
machine. `mesh` and `stars` use a linear base built from `colors[1]` toward
`colors[0]`; every other style lays a solid `colors[1]` base first. A layer
renders under `opacity` and `blend` like any other node.

## `svg`

| Field | Type | Default | Notes |
|---|---|---|---|
| `svg` | raw fragment string, ≤ 100000 chars | - | scanned, not parsed (`SVG_TOO_LARGE`) |
| `viewBox` | `[x, y, width, height]` | absent | `BAD_VIEWBOX`; absent means the fragment is stretched to the box |
| `preserveAspectRatio` | `meet` \| `none` | `meet` | `BAD_VIEWBOX` |
| `fill` | colour token or literal | absent | applied as the inherited fill (`BAD_COLOR`) |

The scanner's allow-list is the contract; the tables are in
`svgFragmentProblems`. Allowed tags: `g`, `path`, `rect`, `circle`, `ellipse`,
`line`, `polyline`, `polygon`, `text`, `tspan`, `defs`, `linearGradient`,
`radialGradient`, `stop`, `clipPath`, `mask`, `title`, `desc`, `use`, `symbol`.
Allowed attributes: `d`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`,
`rx`, `ry`, `width`, `height`, `points`, `fill`, `fill-opacity`, `fill-rule`,
`stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`,
`stroke-dasharray`, `opacity`, `transform`, `viewBox`, `preserveAspectRatio`,
`offset`, `stop-color`, `stop-opacity`, `gradientUnits`, `gradientTransform`,
`id`, `class`, `font-family`, `font-size`, `font-weight`, `text-anchor`,
`dominant-baseline`, `letter-spacing`, `clip-path`, `mask`, `href`,
`xlink:href`, `xmlns`, `xmlns:xlink`, `version`, and any `data-*` / `aria-*`.
Anything else is refused by name, an `href` must be a same-document `#id`, and
event attributes are refused outright - an SVG export must render as an `<img>`,
which may not fetch and may not run.

A complete document that uses `art`, `shape`, `svg` and `text`, with no preset
and therefore no destination checks:

```canvas
{
  "title": "Fragment demo",
  "canvas": { "width": 900, "height": 500, "background": "surface" },
  "tokens": {
    "color": { "ink": "#F8FAFC", "muted": "#94A3B8", "accent": "#4D6BFE", "surface": "#0B0E14" },
    "font": { "display": "Space Grotesk", "text": "Inter", "mono": "system" },
    "scale": { "display": 64, "title": 36, "subtitle": 26, "body": 20, "caption": 15 },
    "space": 8
  },
  "layers": [
    { "kind": "art", "style": "rings", "w": "fill", "h": "fill", "colors": ["accent", "surface"], "seed": 12, "opacity": 0.5 },
    {
      "kind": "frame",
      "x": 48,
      "y": 48,
      "w": 804,
      "h": 404,
      "direction": "row",
      "align": "center",
      "gap": 32,
      "padding": 32,
      "background": "surface",
      "radius": "card",
      "children": [
        {
          "kind": "svg",
          "id": "mark",
          "w": 140,
          "h": 140,
          "viewBox": [0, 0, 100, 100],
          "svg": "<g fill=\"none\" stroke=\"#4D6BFE\" stroke-width=\"6\" stroke-linecap=\"round\"><circle cx=\"50\" cy=\"50\" r=\"38\"/><path d=\"M32 62 L50 30 L68 62\"/></g>"
        },
        {
          "kind": "frame",
          "id": "copy",
          "w": "fill",
          "direction": "column",
          "gap": 16,
          "children": [
            { "kind": "text", "text": "One file, every surface", "style": "display", "family": "display", "weight": 700, "w": "fill", "lineHeight": 1.1 },
            { "kind": "shape", "shape": "rect", "w": 64, "h": 4, "radius": 2, "fill": "accent" },
            { "kind": "text", "text": "The document is the design; the painters cannot disagree.", "style": "body", "family": "text", "color": "muted", "w": "fill", "maxLines": 2 }
          ]
        }
      ]
    }
  ]
}
```

In a browser this fragment paints normally. A host-side layout with no
rasterizer reports `SVG_FRAGMENT_UNPAINTED` for it, which is that check's own
limit rather than a fault in the fragment: the canvas painter needs a
pre-rasterized image for a raw fragment (`svg:<path>` in the `layout` options),
and the `.svg` export carries the fragment either way.

## Layout arithmetic

Two passes: **measure** (a node's intrinsic size) then **place** (its final box
and its ops). Every number below is what the engine does, in the order it does
it.

**Text.** The wrap width is the node's numeric `w`, or `"fill"`, or - only when
the parent frame is a column and the child has no cross size - the frame's inner
width. Words are appended until the line would exceed the width, a single word
wider than the box is broken at the character that fits, and `maxLines` +
`ellipsis` cut the tail. Line height is `size * lineHeight`; the box height is
`lines * lineHeight` unless `h` is numeric, and a content height greater than
`h` is `TEXT_OVERFLOW`. The baseline inside a line box is
`(lineHeight - size) / 2 + ascent`, where the ascent comes from the measurer
(0.8 of the size as a fallback).

**Frame.** The hug size is the children's extent plus padding plus gaps; a
column frame's hug width is its widest child plus horizontal padding, and its
height is the sum. Numeric `w`/`h` win; `"fill"` on the main axis shares the
leftover space between the `fill` children after fixed sizes and gaps; `"fill"`
on the cross axis takes the inner size. `justify` moves the whole run
(`center`/`end`) or expands the gaps (`space-between`); `align` moves each child
on the cross axis, and `stretch` grows the ones that named no cross size.

Two consequences of that arithmetic decide most of a layout's behaviour, and
both are easy to trip over:

- **A frame with no numeric `w` ends up as wide as its parent's content box**,
  and a frame with no numeric `h` ends up as tall as the parent's content box on
  the main axis. The hug size is what its *children* measured, not what its box
  becomes. So a frame that must be the size of its content needs the number, and
  the copy inside it is given `w: "fill"` instead of relying on the frame.
- **A direct child of a row frame that names no `h` is stretched to the row's
  inner height.** A caption in a row is therefore given an `h` (its line
  height) or it comes back as tall as the row; `align: "center"` then places it
  on the row's centre line.

**Absolute placement.** A node with `x` or `y` is placed at
`parent.paddingBox + (x, y)`, measured against the parent's inner width, and is
excluded from the main-axis sum - so an absolutely placed badge does not push
its siblings. A top-level layer is placed in the canvas at `(x, y)`.

**Rounding.** Every coordinate in the IR is rounded to three decimals, because
the op list is hashed to make a revision.

## Limits

| Constant | Value | What it caps |
|---|---|---|
| `maxCanvasSide` / `minCanvasSide` | 8192 / 16 | a canvas side |
| `maxExportPixels` | 40,000,000 | an export's total pixels |
| `maxLayers` | 512 | top-level layers |
| `maxTotalNodes` | 4096 | every node in the document |
| `maxChildren` | 64 | children in one frame |
| `maxDepth` | 12 | frame nesting |
| `maxTextChars` | 4096 | a `text` node, or all runs together |
| `maxRuns` / `maxTitleChars` / `maxNotesChars` | 24 / 120 / 4000 | runs per node, `title`, `notes` |
| `maxSvgChars` | 100,000 | a raw SVG fragment |
| `maxArtOps` | 600 | draw ops one art node may generate |
| `maxFontSize` / `minFontSize` | 400 / 6 | a size, or a `tokens.scale` entry |
| `maxGap` / `maxPadding` / `maxRadius` / `maxStroke` | 400 / 600 / 999 / 80 | `gap`, `padding`, `radius`, `strokeWidth` |

## Validator codes

Every entry is `{ path, code, message }`; a document with any problem stores
nothing and returns `document: null`.

| Code | Raised when | Fix |
|---|---|---|
| `BAD_DOCUMENT` | the input is not an object | send a JSON object |
| `UNKNOWN_PRESET` | `preset` is not in the preset table | use one of the ids above, or omit it and declare `canvas` |
| `NO_CANVAS` | no known preset and not both `canvas.width` and `canvas.height` | add the other dimension |
| `BAD_CANVAS` | a canvas side is not a whole number of pixels | round it |
| `CANVAS_TOO_LARGE` | a side is outside 16-8192 | resize; a 300 dpi poster is already 3508x4961 |
| `BAD_LAYERS` | `layers` is not an array (an empty array is fine) | send `[]` at minimum |
| `TOO_MANY_LAYERS` | more than 512 top-level layers | split the design, or nest inside frames |
| `BAD_NODE` | a layer or child is not an object | send a node |
| `TOO_MANY_NODES` | more than 4096 nodes in total | flatten and reuse |
| `TOO_DEEP` | frames nest more than 12 deep | lift a level out |
| `BAD_KIND` | `kind` is missing or not one of the six | `frame`, `text`, `image`, `shape`, `art`, `svg` |
| `BAD_ID` | `id` fails `^[a-z0-9][a-z0-9-]{0,31}$` | lowercase, no spaces |
| `BAD_GEOMETRY` | `x`/`y` outside -8192..8192, or `w`/`h` outside 1..8192 (or not a number, or not `fill`/`hug`) | fix the number |
| `BAD_OPACITY` / `BAD_ROTATE` / `BAD_BLEND` | outside 0..1 / -360..360 / not a blend mode | see the shared-field table |
| `BAD_SHADOW` / `BAD_BORDER` | not the documented object | `{x,y,blur,color}` / `{width,color,dash?}` |
| `BAD_PAINT` / `BAD_ART` | a paint is not solid/linear/radial/art, stops are not 2-8, or an art style is unknown | check `type`, `stops`, `style` |
| `BAD_COLOR` | a value is neither a colour token in `tokens.color` nor a parseable colour | the message lists the tokens that exist |
| `BAD_TOKENS` / `BAD_TOKEN_NAME` | a token block is not an object / a name fails the grammar | names are `^[a-z][a-z0-9-]{0,23}$` |
| `BAD_FONT` / `BAD_FONT_ROLE` | a family is not shipped / a role is not display/text/mono | the message lists the shipped families |
| `BAD_SCALE` / `BAD_RADIUS` / `BAD_SPACE` | a scale entry outside 6-400 / radius outside 0-999 / space outside 2-64 | fix the token |
| `BAD_FRAME` | `direction` is not column/row, `justify`/`align` is not allowed, or `gap` is outside 0-400 | see the frame table |
| `BAD_CHILDREN` / `TOO_MANY_CHILDREN` | `children` is not an array / holds more than 64 | split the frame |
| `BAD_PADDING` | not a number, `[t,r,b,l]`, or `{top,right,bottom,left}` | use one of the three shapes |
| `BAD_TEXT` / `TEXT_TOO_LARGE` | a text node has neither `text` nor `runs` / the text is over 4096 chars | add the words, or cut them |
| `BAD_RUN` / `TOO_MANY_RUNS` | a run is not `{text, ...}` / more than 24 runs | split into two text nodes |
| `BAD_STYLE` | `style` is not a `tokens.scale` name | the message lists the scale |
| `BAD_SIZE` / `BAD_WEIGHT` | size outside 6-400 / weight outside 100-900 | round the weight to a hundred |
| `BAD_LINEHEIGHT` / `BAD_TRACKING` | line height outside 0.7-3 / tracking outside -20..80 | fix it |
| `BAD_ALIGN` / `BAD_TRANSFORM` | `align` is not start/center/end / `transform` is not none/upper/lower/title | see the text table |
| `BAD_MAXLINES` | `maxLines` is not a whole number 1-12 | pick 1-12 |
| `BAD_SRC` | `image.src` is missing, not a string, or over 512 chars | register the asset and name it |
| `BAD_FIT` / `BAD_ZOOM` / `BAD_FOCUS` / `BAD_SCRIM` | not a documented `fit` / zoom outside 1-8 / `focus` is not `{x,y}` in 0..1 / not a documented scrim | see the image table |
| `BAD_SHAPE` | `shape` is not rect/ellipse/line/polygon/path | use one of the five |
| `BAD_STROKE` / `BAD_DASH` | `strokeWidth` outside 0-80 / `dash` is not up to 8 non-negative numbers | fix it |
| `BAD_POINTS` | a polygon has no `points`, or they are not 3-64 `{x,y}` in 0..1 | normalise them to the box |
| `BAD_PATH` | a path shape has no `d`, `d` is over 8000 chars, or it carries anything but commands and numbers | simplify the path |
| `BAD_VIEWBOX` | `viewBox` is not 4 numbers, or `preserveAspectRatio` is not meet/none | fix it |
| `BAD_TITLE` / `BAD_NOTES` | not a string, or over 120 / 4000 chars | shorten it |
| `SVG_TOO_LARGE` | the fragment is over 100,000 chars | draw less, or export the shape as an asset |
| `SVG_FORBIDDEN` | `<script>`, `<foreignObject>`, `<iframe>`, `<image>`, `<animate>`, `<set>`, `<style>`, `<link>`, `<meta>`, `<object>`, `<embed>`, `<audio>`, `<video>`, `<switch>` | remove it; there is no scripting surface |
| `SVG_EXTERNAL` | an `href`/`xlink:href` that is not `#id` | reference a `defs` id in the same fragment |
| `SVG_EVENT` | an `on*=` attribute | events are refused, not sanitised |
| `SVG_TAG` / `SVG_ATTR` | a tag or attribute outside the allow-list | see the fragment tables above |

### Patch codes

`applyPatches(document, ops)` returns `{document, problems}` and applies at most
64 operations, in order, to a clone.

| Code | Raised when | Fix |
|---|---|---|
| `NO_OPS` / `TOO_MANY_OPS` | no operations / more than 64 | split the batch |
| `BAD_OP` | an operation is not an object, or `op` is not set/remove/insert | use the documented shape |
| `BAD_PATH` | `at` is empty, has an empty segment, or names `__proto__`/`constructor`/`prototype` | write a plain dot path |
| `NO_TARGET` | an intermediate segment does not exist, an array index is out of range, or `remove` names a missing key | insert the parent first |
| `NO_VALUE` | `set` without a `value` | add the value |
| `BAD_TARGET` | `insert` into something that is not an array, or an index outside 0..length | insert into `layers` or a frame's `children` |

### Layout and lint codes

These are not refusals: they come back in the render report's `lints` (or the
layout's `warnings`) and mean the design stores but reads badly. `level` is
`warn` except for `MISSING_ASSET`, which is an `error`.

| Code | Raised when | Fix |
|---|---|---|
| `SAFE_AREA` | a node that does not cover the whole canvas intersects a preset's `keep-out` region | move it out of that rectangle |
| `MARGIN` | a text box comes within `preset.margin - 1` of the canvas edge | inset it |
| `LOW_CONTRAST` | a text op is under 4.5:1 (3:1 at 28px and above) against the paint sampled at its own position | recolor, add an opaque panel, or add a scrim |
| `TYPE_TOO_SMALL` | a text node's smallest run is under 14px | raise it |
| `TEXT_TRUNCATED` | `maxLines` cut the paragraph and ellipsized | shorten the copy |
| `TEXT_OVERFLOW` | the wrapped content is taller than a numeric `h` | raise `h`, drop a size, or cut words |
| `TEXT_UNWRAPPED` | a single line wider than the canvas, because no `w` was given | give it `w` |
| `MANY_SIZES` / `MANY_FAMILIES` | more than 4 distinct sizes / more than 2 families | collapse the scale |
| `NO_TEXT` | the document has nodes and no text at all | add the words |
| `MISSING_ASSET` | an `image.src` is not in the asset table | `canvas_assets` it |
| `IMAGE_UNMEASURED` | the asset table has no dimensions for the `src`, so 4:3 was assumed | register the real asset |
| `SVG_FRAGMENT_UNPAINTED` | the rasterizer could not prepare the fragment for the canvas painter | simplify the fragment; the SVG export still carries it |

`LOW_CONTRAST` is sampled, not assumed: the sampler walks the ops in paint
order, evaluates the paint at the text's own position, composites translucent
layers over the canvas background, and returns `unknown` (and stays silent)
rather than guessing when the point falls inside a photograph, a raw SVG
fragment or a filled path. Silence over an image is **not** a pass.
