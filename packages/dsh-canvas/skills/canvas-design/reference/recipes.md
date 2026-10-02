# Recipes

Copy-paste fragments for the shapes that come up again and again. Each one is a
**node** or a **token block**, valid as written: drop a node into `layers` or
into a frame's `children`, and patch a token block into an existing document
with `canvas_patch` (for example `{ "op": "set", "at": "tokens", "value": … }`).

Every field here exists in the engine - nothing in this file is invented. Where
a recipe names an asset, the `src` is a placeholder: `canvas_assets` the real
file first, or the report comes back `MISSING_ASSET`.

## Sizing rules these recipes follow

The layout engine has two behaviours worth knowing before you paste any of these
into a document, because both are easy to trip:

1. **A frame without a numeric `w` takes the width its parent gives it**, not
   the width its children need - and a frame without a numeric `h` takes the
   parent's content height on the main axis. So a frame you want sized to its
   content gets a number. These recipes therefore set `w`/`h` on every frame
   whose size matters, and use `w: "fill"` on the **text** children instead, so
   the copy wraps at the frame's own width.
2. **A direct child of a row frame stretches to the row's inner height** when it
   names no `h`. A caption in a row is given `h` (its line height, or a little
   more) and usually `align: "center"`, or it comes back as tall as the row.

Two more that decide whether the report is useful:

- **`LOW_CONTRAST` is sampled where the glyphs sit, and the sampler stops at an
  `art` layer, a photograph or a filled path** - it answers `unknown` and stays
  silent rather than inventing a ratio. Put body copy on a frame with an opaque
  `background` (or an opaque `shape`) and the reading is exact. Copy straight on
  a mesh gradient gets no contrast verdict, which is not a pass.
- **Absolute `x`/`y` on a child is inside the parent's padding box**, and the
  parent's padding is subtracted from what the child can use. The most
  predictable compositions place the content layers absolutely at the canvas
  level and keep one frame per group.

## 1. Mesh background + grain

Two full-bleed `art` layers: an organic base, then film texture so the gradient
does not read as a CSS default. Both fill the canvas, so neither trips a
keep-out check.

```json
[
  { "kind": "art", "id": "bg", "style": "mesh", "w": "fill", "h": "fill", "colors": ["accent", "surface", "ink"], "seed": 41, "opacity": 0.45 },
  { "kind": "art", "id": "grain", "style": "grain", "w": "fill", "h": "fill", "colors": ["ink", "surface"], "seed": 9, "opacity": 0.12, "density": 0.35 }
]
```

Keep the mesh under 0.5 opacity when type will sit on it, and keep `seed` fixed
once you like the arrangement - the picture must not move between renders.

## 2. Terminal / code card

The `system` mono role for the code, a panel with an opaque background so the
contrast sampler has a real colour to measure, and a two-run title line for the
coloured `$` prompt.

```json
{
  "kind": "frame",
  "id": "code",
  "w": 720,
  "direction": "column",
  "gap": 8,
  "padding": [24, 28, 24, 28],
  "background": "#0E1219",
  "border": { "width": 1, "color": "edge" },
  "radius": "card",
  "children": [
    {
      "kind": "text",
      "style": "body",
      "family": "mono",
      "size": 18,
      "lineHeight": 1.4,
      "color": "#CBD5E1",
      "w": "fill",
      "runs": [
        { "text": "$ ", "color": "accent" },
        { "text": "npx @deepseek-ai/dsh web" }
      ]
    },
    { "kind": "text", "style": "body", "family": "mono", "size": 18, "lineHeight": 1.4, "color": "muted", "w": "fill", "text": "dsh web: http://127.0.0.1:3080" },
    { "kind": "text", "style": "caption", "family": "mono", "color": "#16A34A", "text": "ready in 1.4s" }
  ]
}
```

A frame with a numeric `w` gives its children that inner width, which is what
wraps the long line instead of running it off the canvas.

## 3. Dot-grid fade

A `grid` layer under a radial wash of the surface colour: the dots are sharpest
at the edges and dissolve in the middle, so a headline can sit in the clear
centre without a scrim.

```json
[
  { "kind": "art", "id": "dots", "style": "grid", "w": "fill", "h": "fill", "colors": ["accent", "surface"], "seed": 3, "density": 0.5 },
  { "kind": "art", "id": "fade", "style": "glow", "w": "fill", "h": "fill", "colors": ["surface", "surface"], "seed": 1, "opacity": 0.85, "scale": 1.6 }
]
```

Raising `density` tightens the grid spacing; raising `scale` enlarges the dots
and the glow together.

## 4. Glass / dark panel

A translucent panel is a real material here - it composites over whatever is
behind it, and the sampler still resolves the text's background as long as the
panel's own paint is what is underneath.

```json
{
  "kind": "frame",
  "id": "glass",
  "w": 640,
  "direction": "column",
  "justify": "center",
  "gap": 16,
  "padding": [40, 48, 40, 48],
  "background": "rgba(15, 20, 32, 0.72)",
  "border": { "width": 1, "color": "rgba(248, 250, 252, 0.16)" },
  "radius": "card",
  "shadow": { "x": 0, "y": 24, "blur": 64, "color": "rgba(0, 0, 0, 0.55)" },
  "children": [
    { "kind": "text", "text": "Everything in one panel", "style": "title", "family": "display", "weight": 700, "w": "fill" },
    { "kind": "text", "text": "Opaque enough to read, transparent enough to show the art behind it.", "style": "body", "color": "muted", "w": "fill", "maxLines": 2 }
  ]
}
```

Below about 0.6 alpha the panel stops doing its job; above 0.85 it is just a
dark rectangle - 0.72 to 0.8 is the band that reads as glass.

## 5. Logo lockup

A mark on the left, a wordmark and a descriptor stacked on the right, both
vertically centred in a row frame - the descriptor is what makes a lockup read
as a brand rather than as a caption.

```json
{
  "kind": "frame",
  "id": "lockup",
  "direction": "row",
  "align": "center",
  "gap": 20,
  "children": [
    { "kind": "shape", "shape": "ellipse", "w": 56, "h": 56, "fill": { "type": "linear", "angle": 140, "stops": [ { "at": 0, "color": "accent" }, { "at": 1, "color": "#7C5CFF" } ] } },
    {
      "kind": "frame",
      "direction": "column",
      "gap": 4,
      "children": [
        { "kind": "text", "text": "DeepSeek Harness", "style": "title", "family": "display", "weight": 700, "size": 30, "letterSpacing": -0.5 },
        { "kind": "text", "text": "plugins, skills and surfaces", "style": "caption", "color": "muted", "transform": "upper", "letterSpacing": 1.8 }
      ]
    }
  ]
}
```

An ellipse with equal `w` and `h` is a circle; give the mark a `radius` instead
if it is a rounded square.

## 6. Stat row

Three numbers across a row, each with its own caption. The row has a numeric
width and each cell three equal `fill` columns of it, so the three stay even
whatever the numbers say.

```json
{
  "kind": "frame",
  "id": "stats",
  "w": 960,
  "h": 120,
  "direction": "row",
  "gap": 24,
  "children": [
    {
      "kind": "frame", "w": "fill", "h": 120, "direction": "column", "gap": 4, "align": "center",
      "children": [
        { "kind": "text", "text": "9", "style": "display", "family": "display", "weight": 700, "size": 56, "h": 70 },
        { "kind": "text", "text": "tools", "style": "caption", "color": "muted", "transform": "upper", "letterSpacing": 2, "h": 19 }
      ]
    },
    {
      "kind": "frame", "w": "fill", "h": 120, "direction": "column", "gap": 4, "align": "center",
      "children": [
        { "kind": "text", "text": "2", "style": "display", "family": "display", "weight": 700, "size": 56, "h": 70 },
        { "kind": "text", "text": "painters", "style": "caption", "color": "muted", "transform": "upper", "letterSpacing": 2, "h": 19 }
      ]
    },
    {
      "kind": "frame", "w": "fill", "h": 120, "direction": "column", "gap": 4, "align": "center",
      "children": [
        { "kind": "text", "text": "0", "style": "display", "family": "display", "weight": 700, "size": 56, "h": 70 },
        { "kind": "text", "text": "image models", "style": "caption", "color": "muted", "transform": "upper", "letterSpacing": 2, "h": 19 }
      ]
    }
  ]
}
```

## 7. Eyebrow + headline + subhead + CTA stack

The default composition at any preset: four levels of furniture over a display
headline, with the CTA in an accent pill. Optical centring puts the pill's label
on the pill's centre line, and the auto height keeps it snug.

```json
[
  { "kind": "text", "id": "eyebrow", "text": "dsh canvas", "style": "caption", "family": "mono", "color": "accent", "transform": "upper", "letterSpacing": 2.5 },
  { "kind": "text", "id": "headline", "text": "Design once, ship everywhere", "style": "display", "family": "display", "weight": 700, "lineHeight": 1.05, "letterSpacing": -1.5, "w": "fill" },
  { "kind": "text", "id": "subhead", "text": "Banners and posters from one JSON document.", "style": "body", "color": "muted", "w": "fill", "maxLines": 2 },
  {
    "kind": "frame", "id": "cta", "justify": "center", "padding": [14, 28, 14, 28],
    "background": "accent", "radius": "pill",
    "children": [
      { "kind": "text", "id": "cta-label", "text": "Try it", "style": "caption", "weight": 600, "color": "#0B0E14" }
    ]
  }
]
```

Version two is in recipe 10; everything else here is a variation on it.

## 8. Stat card with an accent edge

A card whose left edge carries the accent - one `shape` inside a padded frame,
placed in the flow ahead of the copy in a row.

```json
{
  "kind": "frame",
  "id": "card",
  "w": 560,
  "direction": "row",
  "gap": 20,
  "padding": [24, 28, 24, 24],
  "background": "#111726",
  "radius": "card",
  "border": { "width": 1, "color": "edge" },
  "children": [
    { "kind": "shape", "shape": "rect", "w": 4, "h": "fill", "radius": 2, "fill": "accent" },
    {
      "kind": "frame",
      "w": "fill",
      "direction": "column",
      "gap": 8,
      "children": [
        { "kind": "text", "text": "One layout pass", "style": "subtitle", "family": "display", "weight": 700, "w": "fill" },
        { "kind": "text", "text": "A pure layout pass turns the document into draw ops, so the preview and the exported PNG cannot disagree.", "style": "body", "color": "muted", "w": "fill", "maxLines": 3 }
      ]
    }
  ]
}
```

`h: "fill"` on the accent bar makes it match the card's inner height whatever
the copy does.

## 9. Numbered carousel footer

Every page of a carousel needs the same furniture in the same place: a rule, a
page counter and a wordmark, one `space-between` row at the bottom of the
`linkedin-carousel-page` preset (1080x1350, 72px margin, page-number keep-out at
888,1230).

```json
{
  "kind": "frame",
  "id": "page-foot",
  "x": 72,
  "y": 1206,
  "w": 936,
  "direction": "row",
  "justify": "space-between",
  "align": "center",
  "gap": 16,
  "children": [
    { "kind": "text", "text": "deepseek harness", "style": "caption", "family": "mono", "color": "muted", "transform": "upper", "letterSpacing": 2 },
    { "kind": "shape", "shape": "rect", "w": "fill", "h": 1, "fill": "edge" },
    { "kind": "text", "text": "01 / 06", "style": "caption", "family": "mono", "color": "muted" }
  ]
}
```

A footer placed with `x`/`y` is absolute inside its frame's padding box, so it
stays put whatever the content above it does - which is the point of furniture.

## 10. Poster-style giant type

Display type at poster scale, tight leading, negative tracking, and the accent
on the second line only. The `poster-a3` preset is 3508x4961 with a 210px
margin; this frame sits inside it.

```json
{
  "kind": "frame",
  "id": "poster",
  "x": 210,
  "y": 210,
  "w": 3088,
  "h": 4541,
  "direction": "column",
  "justify": "end",
  "gap": 48,
  "padding": 80,
  "children": [
    {
      "kind": "text",
      "style": "display",
      "family": "display",
      "weight": 700,
      "size": 320,
      "lineHeight": 0.95,
      "letterSpacing": -6,
      "w": "fill",
      "runs": [
        { "text": "PRINT IS\n" },
        { "text": "STILL HERE", "color": "accent" }
      ]
    },
    { "kind": "shape", "shape": "rect", "w": 480, "h": 12, "fill": "accent" },
    { "kind": "text", "text": "An A3 poster is read at arm's length, so the type is the composition.", "style": "subtitle", "color": "muted", "w": "fill", "maxLines": 2 }
  ]
}
```

A `\n` inside `runs` is a hard line break the wrapper respects; a 320px display
headline at 0.95 leading is roughly three lines of a poster.

## 11. Product shot with a bottom scrim

The only way to put copy over a photograph: `cover` for the crop, `focus` to
choose what survives it, and a bottom scrim so the words land on the darkest
part of the gradient.

```json
{
  "kind": "frame",
  "id": "shot",
  "w": 1120,
  "h": 560,
  "radius": "card",
  "direction": "column",
  "justify": "end",
  "padding": [48, 56, 48, 56],
  "children": [
    { "kind": "image", "id": "photo", "src": "shots/app.png", "x": 0, "y": 0, "w": "fill", "h": "fill", "fit": "cover", "focus": { "x": 0.5, "y": 0.25 }, "zoom": 1.08, "scrim": "bottom", "scrimStrength": 0.78 },
    { "kind": "text", "id": "shot-title", "text": "The whole toolchain in one window", "style": "title", "family": "display", "weight": 700, "w": "fill" },
    { "kind": "text", "id": "shot-sub", "text": "No build step, no dependencies.", "style": "body", "color": "muted", "w": "fill" }
  ]
}
```

The image is absolute (`x`/`y`) so it is the frame's backdrop and does not take
part in the flow; the copy flows in the space the padding leaves. `scrimStrength`
below 0.5 is decoration, not a scrim - and the frame's `radius` is what rounds
the photograph, because a radius clips a frame's children.

## 12. The words, as a token block

The copy is part of the design, so patch it in first and style it second. This
is a full token block at the `github-social` rhythm: 8px space, three type
sizes in play, two families plus the mono role.

```json
{
  "color": { "ink": "#F8FAFC", "muted": "#94A3B8", "accent": "#4D6BFE", "surface": "#0B0E14", "edge": "#1E2636" },
  "font": { "display": "Space Grotesk", "text": "Inter", "mono": "system" },
  "scale": { "display": 72, "title": 40, "subtitle": 26, "body": 22, "caption": 15 },
  "space": 8,
  "radius": { "card": 20, "pill": 999, "chip": 8 }
}
```

`space: 8` is the rhythm every `gap` and `padding` in the design must be a
multiple of; changing it to 12 with gaps of 24 and 48 keeps the same design and
a different feel.
