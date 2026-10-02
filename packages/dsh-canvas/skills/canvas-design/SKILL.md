---
name: canvas-design
description: "Design a canvas document the Canvas tab and the host both understand: the JSON language, the layout engine's sizing rules, the render report's codes, composition craft with numbers, copy budgets, and copy-paste recipes. A bundled reference carries every field and every validator code."
whenToUse: "Whenever Canvas is in play - a banner, a social preview, an OG card, a poster, a carousel page, a stat card, a terminal motif - and for every canvas_patch, canvas_render, canvas_export or canvas_assets call. Read reference/document.md before writing a field you are unsure of, and reference/recipes.md before composing a new design from scratch."
---

# Canvas design

You are the designer. There is **no image model anywhere in this loop**: every
pixel comes from the document you write - type, geometry, one of ten seeded
procedural `art` generators, `shape` nodes, an `image` you already have on disk,
or a scanned `svg` fragment. The craft is in the words, the hierarchy, the
spacing rhythm and the palette, and the render report is how you find out
whether any of it worked.

## The loop: write, patch, render, LOOK, export

| Step | Tool | What comes back |
|---|---|---|
| 1 | `canvas_new { preset, archetype }` | a complete starter document at the preset's real pixel size. `archetype` is optional - without it you get a minimal document at the preset size. |
| 2 | `canvas_write { document }` / `canvas_patch { ops }` | the canonical document. A write validates the whole thing; a patch validates the result. |
| 3 | `canvas_render { id }` | the browser lays out and paints, then hands back a **PNG path**, the `metrics`, the `warnings`, the `lints`, a verdict (`drawn` / `failed` / `stale` / `pending`) and a **25 %-scale feed thumbnail** path. |
| 4 | `read_image` on the PNG the report names | **you**, looking at what you made. |
| 5 | `canvas_patch` | fix what step 4 showed you. Then render and look again. |
| 6 | `canvas_export` | the file itself - PNG / JPG / SVG, `@2x` where the preset allows it, Desktop or workspace. |

**The rule that makes this work: a design is not finished until you have LOOKED
at the rendered PNG.** A document that validates is a syntactically correct
design, not a good one. `status: ok` means the validator accepted the JSON; it
says nothing about whether the headline is legible, whether the type collides,
or whether the composition has a focal point. Only the picture says that.

**Look at the feed thumbnail too.** The report returns it at 25 % - 320 px wide
for `github-social`, ~300 px for `linkedin-post` - because that is the size a
feed, a Slack unfurl or a README column actually shows. A headline that reads
beautifully in a 1280-px artboard can be an unreadable grey smear at 320 px. The
thumbnail is a separate PNG path, so `read_image` it directly rather than
squinting at the full render.

Iterate: `canvas_render` -> `read_image` -> `canvas_patch` -> `canvas_render`.
Two or three rounds is normal. Do not re-emit the whole document with
`canvas_write` to move one element - `canvas_patch` is one operation per change
and it validates the result identically.

## The ten tools

| Tool | Use it for |
|---|---|
| `canvas_new` | instantiate a starter document from `{ preset, archetype, style }` - or from `{ example }`, a gallery row that has already chosen all three - the first call of almost every design |
| `canvas_write` | write a whole document (a new design, or a rewrite you actually intend) |
| `canvas_patch` | the edit; 1-64 pointer operations on the stored document |
| `canvas_read` | re-read the canonical document and the last render verdict - after a compaction, or before building on a design you did not just write |
| `canvas_style` | apply a LOOK from the style library to an existing design: palette, type behaviour, shape language, surface and art. Never moves anything |
| `canvas_render` | make the browser paint it and report; the only way to see the design |
| `canvas_export` | write the final file (format, `@2x`, Desktop or workspace) |
| `canvas_assets` | register an image the document may name: a workspace path or a pasted asset |
| `canvas_publish` | copy a design into the shared **library** |
| `canvas_delete` | remove a design |

Everything is addressed by `id`. The id is a readable slug derived from the
title (`canvas_new` returns it), and every report, patch path and export names
it.

A design belongs to the conversation that made it unless you say otherwise.
When it is worth citing later - a house banner, a wordmark lockup, a poster
template - `canvas_publish { id }` copies it into the shared **library**, whose
address names no conversation, so `canvas_read { id }` finds it from any chat.
Keep scratch work in the conversation.

## Styles: composition and look are separate decisions

The package ships a **style library** (`reference/styles.md` is the generated
catalogue, so it is always the library the host will actually apply). A style is a
palette, a type behaviour, a shape language, a surface and an art treatment - and
it is applied by one transform that **never moves, resizes or reorders anything**:

```
canvas_new { preset: "github-social", archetype: "editorial-split", style: "neon" }
canvas_style { id: "launch-banner", style: "brutalist" }      # same layout, another genre
```

Three things follow, and they are the reason to use it rather than hand-picking
colours:

- **A style is reversible.** The type scale factor is applied as a DELTA against
  the style the document already carries, so applying the same style twice is a
  no-op and switching back restores the original sizes exactly. The document
  records the style it wears in its own `style` field.
- **A style is a contract.** Each pack carries `rules.do`, `rules.dont` and
  `gates`, and the render report already enforces the measurable ones (contrast,
  safe areas, type size). When a style's intent and your composition disagree, the
  render is the referee - not the intent.
- **A style is not a composition.** If the design needs a different arrangement,
  that is an archetype or a patch; restyling will not fix a layout.

Practically: pick the style from the brief when the person names one ("make it
brutalist"), otherwise the one whose `bestFor` names your preset. Apply ONE, then
render. Two styles in one design is not a look, it is an accident.

## The house gallery: start from a proven answer

Twelve examples ship with the package (`canvas_read` lists them; the tab's "+ New"
shows them as rows). An example is a **preset + archetype + style that have already
been chosen well**, plus the copy that belongs in it and the sentence saying when to
reach for it:

```
canvas_new { example: "night-launch" }        # neon, github-social, editorial-split
canvas_new { example: "developer-card" }      # terminal, og, code-card
```

Reach for one when the brief is a KIND of design rather than a specific one - "a
launch card", "a README header", "a release note". Read the row's `intent`, take its
`copy` as the shape of what to write, then make it yours: replace the words, keep the
composition and the look unless the render says otherwise. Starting from a blank
canvas when a proven answer exists wastes the one thing you cannot get back, which is
a turn.

## Patching

```json
[
  { "op": "set",    "at": "layers.0.children.1.text",  "value": "Ship it today" },
  { "op": "set",    "at": "tokens.color.accent",       "value": "#7C5CFF" },
  { "op": "remove", "at": "layers.2" },
  { "op": "insert", "at": "layers.0.children",         "value": { "kind": "text", "text": "Now in beta", "style": "caption", "color": "muted" } }
]
```

`at` is a dot path of object keys and array indexes into the **canonical**
document - the one `canvas_read` hands back, with defaults filled in. Node paths
look like `layers.2`, `layers.0.children.1`, `layers.0.children.1.color`,
`tokens.scale.display`, `canvas.background`.

- `set` needs a `value` (else `NO_VALUE`); `insert` needs an array target and
  takes `-` or an index equal to the length to append (else `BAD_TARGET`).
- Nothing creates intermediate nodes: `layers.0.children.9.text` is `NO_TARGET`
  when there is no child 9. Insert the node, then set its fields.
- At most 64 operations per patch (`TOO_MANY_OPS`); one bad operation fails the
  whole batch and stores nothing.
- `BAD_PATH` is a malformed or forbidden path (`__proto__`, `constructor`,
  `prototype`, or an empty segment).
- A patch is validated exactly like a write: the result must still be a legal
  document, so a patch that pushes type past the canvas or deletes a required
  field comes back as the validator's own code, not a broken design.

## Layers: the person and the model edit the same nodes

The tab shows a **Layers** list beside the artboard: every node of the design in
paint order, nested by frame, named by its `id` (else a snippet of its text, else
its `src`, else its shape or art style). Clicking a row selects that node, and the
artboard draws its box with four handles. That list is a view of the SAME paths
`canvas_patch` addresses, which is the point - a person dragging on the canvas and
a model patching JSON are editing one document, through one validator.

- **Dragging** a selected layer writes two pointer operations, `set x` and
  `set y`, in design pixels:
  ```json
  [{ "op": "set", "at": "layers.2.x", "value": 96 },
   { "op": "set", "at": "layers.2.y", "value": 320 }]
  ```
- Dragging a node that lives in a frame's **flow** gives it the position it already
  occupies and so TAKES IT OUT OF THE FLOW (that is the layout rule, not a side
  effect). Prefer moving nodes that already carry `x`/`y`; if a drag has to move
  text, check the frame's `gap`/`justify` afterwards, because the remaining flow
  children close the gap it left.
- The arrows on a row are a **reorder** inside that node's own array: a `remove`
  followed by an `insert`, which is also how you bring a background forward or push
  a chip behind a panel. The last layer in `layers` paints on TOP, so z-order is
  array order.
- Refinement is a loop, exactly like the first draft: move or reorder ONE thing,
  render, look, then move the next. Ten small patches with a render between them
  beat one large patch nobody looked at.

## Sizing: the whole layout language

| Value | Meaning |
|---|---|
| a number | that many pixels |
| `"fill"` | the parent's content box on that axis; between several `fill` children the leftover space is split equally |
| `"hug"` | the node's own content size (a text node's wrapped height, a frame's children, an image's aspect) |
| absent | the kind's own default, below |

- **Text hugs and does NOT wrap without a width.** A text node with no `w` is
  one line, however long: it runs off the canvas and the report says
  `TEXT_UNWRAPPED`. Give it `w` - a number or `"fill"`.
- **A frame hugs its main axis and fills the cross one.** `direction: "column"`
  means height comes from the children plus padding and gaps, while the width is
  what the parent gives it.
- **A child of a frame that names `x` or `y` leaves the flow** and is placed
  absolutely inside the frame's **padding box**, not its border box. Everything
  else flows along the main axis, in document order, separated by `gap`.
- **A column frame stretches its children across the width**, and that is what
  makes text wrap: with `direction: "column"`, a text child with no `w` of its
  own is measured against the frame's inner width (`availW`). In a row frame the
  cross axis is the height instead, so a text node in a row still needs its own
  `w` to wrap.
- **A frame without a numeric `w` always ends up as wide as its parent gives
  it** - its box takes the parent's content width, not the width its children
  need. The same is true of `h` on the main axis. This is why the reliable
  pattern is **a frame with a numeric `w`, and `w: "fill"` on its text
  children**; a frame you leave to size itself will stretch and carry its
  children with it. Frames with neither `w` nor `h` are the ones to avoid.
- **A child of a row frame stretches to the frame's inner height** when it names
  no `h` of its own, so a caption in a row can come back as tall as the row.
  Give text in a row an explicit `h` (its line height) when it must not stretch
  - or, simpler, give the row's children a numeric `w` as well.
- **`fill` on the main axis distributes leftover space** after fixed children
  and gaps, equally between the `fill` children. `justify: "space-between"`
  distributes it as gaps instead, and only when no child is `fill`.
- Per-kind defaults when the axis is absent:

| Kind | Absent `w` | Absent `h` |
|---|---|---|
| `text` | the widest wrapped line (one line unless `w` is set) | lines x line height |
| `frame` | the parent's content width | the parent's content height on the main axis, else the children's extent |
| `image` | natural width from the asset table | natural height |
| `art` | the parent's width | half the width |
| `svg` | the parent's width | the same as its width |
| `shape` rect/polygon/path | the parent's width | `min(w, 120)` |
| `shape` ellipse | the parent's width | the same as `w` |
| `shape` line | the parent's width | `strokeWidth` |

A layer (a top-level entry in `layers`) is placed absolutely: `x`/`y` default to
0, and its available width is the whole canvas.

## Reading the render report

The report is the design review you cannot do in your head. `status` says
whether the browser *painted* it - `drawn` is the only verdict that means the
picture exists; `stale` means the newest report is about an older revision;
`pending` means nothing has rendered yet. Then come the codes:

| Code | What it means | What to do |
|---|---|---|
| `SAFE_AREA` | a node's box reaches into a preset **keep-out** region (the LinkedIn profile photo, a company logo square, X's centre crop) | move it out of that rectangle; the message names the rectangle |
| `MARGIN` | text sits closer to a canvas edge than the preset's `margin` | inset it; never place text by eye |
| `LOW_CONTRAST` | a text op is below 4.5:1 (or 3:1 at 28px and above) against the paint **sampled where its glyphs sit** | change the text colour, darken the panel behind it, or add a scrim |
| `TYPE_TOO_SMALL` | a text node's smallest run is under 14px | raise it; 14px is the floor at feed scale |
| `TEXT_TRUNCATED` | `maxLines` cut a paragraph and the last line got an ellipsis | shorten the copy or raise `maxLines` |
| `TEXT_OVERFLOW` | the wrapped lines need more height than the numeric `h` you gave the node | raise `h`, drop a size, or cut words |
| `TEXT_UNWRAPPED` | a line is wider than the canvas because the node has no `w` | give it `w: "fill"` or a number |
| `MANY_SIZES` / `MANY_FAMILIES` | more than 4 type sizes / 2 families are in play | collapse the scale; see the type rules below |
| `NO_TEXT` | the design has nodes and no text at all | add the words - a picture with no message is not a design |
| `MISSING_ASSET` | an `image.src` is not in the asset table | `canvas_assets` it first, or fix the path |
| `IMAGE_UNMEASURED` | the asset has no measured size, so a hug size assumed 4:3 | register the asset so the aspect is real |
| `SVG_FRAGMENT_UNPAINTED` | a raw `svg` fragment could not be rasterized for the canvas | the PNG leaves it out while the `.svg` export keeps it; simplify the fragment |

`LOW_CONTRAST` is a real measurement, not a guess: the engine walks the ops in
paint order, samples the paint at the text's own position, composites
translucent layers, and gives up (`unknown`, no warning) rather than inventing a
number. Two consequences worth knowing:

- A text node over a **frame with an opaque `background`** that paints beneath
  it measures the frame's own colour exactly. Use that: a solid panel behind
  body copy is how you make the measurement easy and the design readable.
- A text node straight over a **gradient `art`** layer, a photograph or an SVG
  fragment samples `unknown` and gets no contrast verdict at all - which is not
  a pass. If legibility matters over a picture, put a scrim or a panel there.

## Composition craft

**One focal point.** Exactly one element carries the most weight: the headline,
or the one image. Two competing elements means neither is the point. Decide
which it is before you style anything, and let everything else be quieter -
smaller, lower contrast, or physically further from the centre.

**Three levels of hierarchy, and a 2:1 ratio.** Level 1 is display type
(`tokens.scale.display`, 72px by default); level 2 is the next thing read
(`title` 40px, `subtitle` 26px, or `body` 22px); level 3 is furniture (a
`caption` at 15px, a label, a chip). The headline must be **at least twice** the
size of the level below it: 72 next to 40 is 1.8:1 and reads as a tie - use 72
next to 26, or raise the headline. If two sizes look like a mistake rather than
a relationship, the ratio is wrong.

**Margins come from the preset.** `github-social` is 48, `og` 64, `x-post` 80,
`linkedin-square` 96, `linkedin-carousel-page` 72, `poster-a3` 210. Start the
content frame at exactly that inset on all four sides and the `MARGIN` lint
never fires. Optical adjustments are allowed; invisible ones are not.

**Every gap is a multiple of `tokens.space`** (8 by default): 8, 16, 24, 32,
48, 64. A 13px gap is what a design looks like when nobody decided. Set the
rhythm once in `tokens.space` and make every `gap` and `padding` a multiple of
it - that is what makes two different designs in one carousel look like a set.

**Centre type optically, not mathematically.** A text box's lines sit inside
their line boxes (`lineHeight`, 1.25x by default), so a mathematically centred
text block reads low: the ascent is roughly 0.8 of the size and the descent 0.2,
which leaves more visual weight below the glyphs than above. When a headline
must be centred in a band, nudge it up by 4-8px, or centre it with a frame that
has asymmetric padding. Trust the PNG, not the arithmetic.

**At most two families and three or four sizes.** Use `Space Grotesk` for
display and `Inter` for text; `system` is the machine's mono stack for code and
terminal motifs. More than four distinct sizes trips `MANY_SIZES` and, more to
the point, reads as noise.

**Contrast: 4.5:1 for body, 3:1 for display.** That is the exact line the
report enforces (28px and above is "display"). Light ink (`#F8FAFC`) on a dark
surface (`#0B0E14`) is about 17:1 - comfortable. `muted` (`#94A3B8`) on
`surface` is about 7:1 - fine for body. `accent` (`#4D6BFE`) on `surface` is
4.46:1 - just under the body threshold, so a caption in it is flagged while the
same colour at display size is safe. Keep a second, lighter token for accent
**text** (the example uses `accent-text` `#7C93FF`) and reserve `accent` for
fills, rules and display type. The same arithmetic applies to a filled button:
a small label on an accent pill needs a very dark colour (pure black is only
4.85:1 on this accent), so either use black, or set the label at display size
where 3:1 applies.

**Negative space is a material.** An empty half of the canvas is not wasted, it
is what tells the eye where to look. The commonest failure in a first draft is
filling every region: resist it. If the composition works at 60 % coverage,
stop.

### Using `art` instead of a photograph

`art` is deterministic - the same `seed` is the same picture on every machine -
so it is a background material, not a randomiser. Ten styles:

| Style | What it draws | Reach for it when |
|---|---|---|
| `mesh` | a linear base plus 4-8 soft radial blobs | an organic, expensive-looking gradient background |
| `glow` | one accent radial bloom on a dark base | a single focal light (a launch, a spotlight) |
| `grid` | a dot grid that fades toward the middle | a technical, measured backdrop |
| `stripes` | diagonal bands | energy, motion, a diagonal rhythm |
| `rings` | concentric circles from a point | depth, a target, an orbital feel |
| `grain` | 120-500 tiny specks | film texture, to stop a flat gradient looking like a CSS default |
| `waves` | 4-9 sine strokes across the box | sound, data, flow |
| `blueprint` | a technical line grid plus boxes | engineering, a spec sheet |
| `circuit` | right-angled traces with nodes | hardware, infrastructure |
| `stars` | 60-220 points on a deep gradient | a night sky, a wide-open field |

Rules that keep it from looking cheap: give `colors` explicitly (defaults are
`accent`, `surface`, `ink`); keep `opacity` between 0.35 and 0.8 so type can sit
on it; use `seed` to pick the arrangement you like and then **never change it**
(the design must not move between renders); `density` and `scale` tune the
count and the size. **Two art layers maximum** - one base, and at most a
`grain` layer at low opacity. A text node directly over a gradient art layer
gets an **approximate** contrast reading (the sampler evaluates the art's paint
at the text's position), and one over a photograph or a filled path gets none at
all - so if legibility matters, put the words on a frame with an opaque
`background` or on a `shape` and the number is exact.

### Using an `image` well

An image is a file you already have: a workspace screenshot, a repo asset, a
rendered PDF page, something the person pasted. `canvas_assets` registers it
first so the engine knows its real aspect ratio.

- `fit: "cover"` (the default) fills the box and crops; `"contain"` letterboxes;
  `"fill"` distorts - do not use it on a photograph.
- `focus` is `{x, y}` in 0..1 and chooses **which part** of the picture survives
  the crop. `{ "x": 0.5, "y": 0.2 }` keeps the top - a face, a headline in a
  screenshot, a product at the top of the frame.
- `zoom` (1-8) magnifies around the focus; 1.05-1.15 is a subtle tightening.
- `radius` matches the panel it sits in; a screenshot with the app's own corners
  reads as a window rather than a floating rectangle.
- **A scrim is how text survives a photograph.** `scrim: "bottom"` lays a
  gradient of `scrimColor` (black by default) from the bottom edge up to 62 % of
  the box, at `scrimStrength` (0.65 default). Put the copy in that lower band and
  the contrast is real at the darkest end. Use `"top"`, `"left"`, `"right"` to
  match where the words are, `"full"` for a flat wash (then keep the strength
  near 0.4 or the picture disappears), and `"circle"` to vignette around a
  centred subject. Anything less than 0.35 is decoration, not a scrim.
- Without a picture at all: **type, geometry, one accent and negative space** -
  a display headline on a mesh, an accent rule, a great deal of empty canvas.
  That is a finished design, not a fallback.

## Copy: write the words before you style them

A layout cannot rescue a sentence. Decide the words first, at these budgets:

- **A headline is at most ~7 words and ~42 characters** at display size. That is
  what fits one or two lines across a banner without shrinking the type.
  If the honest headline is longer, it is two pieces of copy: a headline and a
  subhead.
- **The subhead earns the headline; it does not repeat it.** If the headline
  says "Design once, ship everywhere", the subhead says *how* or *for whom* -
  not the same idea in other words.
- **One call to action.** One verb, in one place. Two buttons means neither is
  the action.
- **Respect the total word budget per destination.** `github-social` is roughly
  **14 words in total** - eyebrow, headline, subhead and CTA together. Feed
  posts tolerate 10-20. A poster can carry 25. Anything past that is a paragraph
  pretending to be a banner.
- An eyebrow is 1-3 words, uppercase through `transform: "upper"`, tracked
  (`letterSpacing` 1.5-3), at `caption` size. It is furniture, not content.
- Numbers beat adjectives ("4 tools, 1 file" over "powerful tooling") and
  concrete nouns beat abstractions ("`canvas_patch`" over "the engine").

## The escape hatch: `svg`

One node kind exists for the thing JSON cannot express - a wordmark, a glyph, a
geometric logo. A fragment is **scanned, not trusted**:

- **Allowed tags:** `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
  `polygon`, `text`, `tspan`, `defs`, `linearGradient`, `radialGradient`, `stop`,
  `clipPath`, `mask`, `title`, `desc`, `use`, `symbol`.
- **Allowed attributes:** `d`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`,
  `r`, `rx`, `ry`, `width`, `height`, `points`, `fill`, `fill-opacity`,
  `fill-rule`, `stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`,
  `stroke-linejoin`, `stroke-dasharray`, `opacity`, `transform`, `viewBox`,
  `preserveAspectRatio`, `offset`, `stop-color`, `stop-opacity`,
  `gradientUnits`, `gradientTransform`, `id`, `class`, `font-family`,
  `font-size`, `font-weight`, `text-anchor`, `dominant-baseline`,
  `letter-spacing`, `clip-path`, `mask`, `href`, `xlink:href`, `xmlns`,
  `xmlns:xlink`, `version`; plus any `data-*` or `aria-*`.
- **Forbidden, by name:** `<script>`, `<foreignObject>`, `<iframe>`, `<image>`,
  `<animate>`, `<set>`, `<style>`, `<link>`, `<meta>`, `<object>`, `<embed>`,
  `<audio>`, `<video>`, `<switch>`, and any `on*=` event attribute.
- **An `href` may only be a same-document `#id`.** Nothing external is allowed
  and it is not a nicety: an SVG export has to render as an `<img>`, and an
  image document may not fetch anything - a fragment that reaches for a URL
  would produce a file that silently draws nothing. Import the bytes as an
  asset instead, or draw the shape in fragments.

A refused fragment comes back as `SVG_TAG`, `SVG_ATTR`, `SVG_FORBIDDEN`,
`SVG_EXTERNAL`, `SVG_EVENT` or `SVG_TOO_LARGE` (100,000 characters), each with
the offending token named. `viewBox` is `[x, y, width, height]`;
`preserveAspectRatio` is `"meet"` (default) or `"none"`.

## Where the long answers live

| Read | When |
|---|---|
| `reference/document.md` | every key of every node kind, the token block, the defaults, `LIMITS`, and every validator code with its fix |
| `reference/recipes.md` | a copy-paste JSON fragment for a mesh background, a terminal card, a dot-grid fade, a glass panel, a logo lockup, a stat row, a copy stack, a carousel footer, a giant-type poster, or a product shot with a scrim |
| `reference/styles.md` | **the style library, generated from the packs themselves**: every style's palette, families, type behaviour, shape language, art treatment, its do/don't and its gates, plus what applying a style does and does not change |

Read the reference before writing a field you are unsure of rather than guessing
and paying for a round trip: the validator is complete, so a wrong key is always
a named refusal with a path, and the reference has the same list.

## A complete starting document

A valid `github-social` design: the preset canvas, a full token block, two
full-bleed procedural art layers, three levels of hierarchy with a 2:1 size
step, one mixed-colour headline, an accent rule, and a footer row with a URL and
a call-to-action pill. It comes back from `canvas_render` with **no lints at
all**, which is the bar: every node here has an explicit size, the accent is
used as a fill rather than as small text, and nothing reaches into the preset's
lower-right keep-out corner (the pill's right edge lands on x = 1048, inside the
1060 boundary).

```canvas
{
  "title": "Harness social preview",
  "preset": "github-social",
  "tokens": {
    "color": {
      "ink": "#F8FAFC",
      "muted": "#94A3B8",
      "accent": "#4D6BFE",
      "accent-text": "#7C93FF",
      "surface": "#0B0E14",
      "edge": "#1E2636"
    },
    "font": { "display": "Space Grotesk", "text": "Inter", "mono": "Space Grotesk" },
    "scale": { "display": 72, "title": 40, "subtitle": 26, "body": 22, "caption": 15 },
    "space": 8,
    "radius": { "card": 20, "pill": 999, "chip": 8 }
  },
  "canvas": {
    "background": { "type": "linear", "angle": 160, "stops": [ { "at": 0, "color": "surface" }, { "at": 1, "color": "#131A2A" } ] }
  },
  "layers": [
    { "kind": "art", "id": "bg", "style": "mesh", "w": "fill", "h": "fill", "colors": ["accent", "surface", "ink"], "seed": 41, "opacity": 0.42 },
    { "kind": "art", "id": "grain", "style": "grain", "w": "fill", "h": "fill", "colors": ["ink", "surface"], "seed": 9, "opacity": 0.14, "density": 0.35 },
    { "kind": "text", "id": "eyebrow", "x": 104, "y": 104, "text": "dsh canvas", "style": "caption", "color": "accent-text", "transform": "upper", "letterSpacing": 2.5 },
    {
      "kind": "frame",
      "id": "head",
      "x": 104,
      "y": 144,
      "w": 1072,
      "direction": "column",
      "gap": 16,
      "children": [
        {
          "kind": "text",
          "id": "headline",
          "style": "display",
          "family": "display",
          "weight": 700,
          "lineHeight": 1.05,
          "letterSpacing": -1.5,
          "w": "fill",
          "runs": [
            { "text": "Design once, " },
            { "text": "ship everywhere", "color": "accent" }
          ]
        },
        { "kind": "shape", "id": "rule", "shape": "rect", "w": 96, "h": 6, "radius": 3, "fill": "accent" },
        { "kind": "text", "id": "subhead", "text": "A design page the agent drives - banners and posters, no image model.", "style": "body", "color": "muted", "w": "fill", "maxLines": 2 }
      ]
    },
    {
      "kind": "frame",
      "id": "foot",
      "x": 104,
      "y": 489,
      "w": 944,
      "h": 47,
      "direction": "row",
      "justify": "space-between",
      "align": "center",
      "children": [
        { "kind": "text", "id": "url", "text": "github.com/deepseek-ai/dsh", "style": "caption", "family": "mono", "color": "muted", "h": 19 },
        {
          "kind": "frame",
          "id": "cta",
          "w": 104,
          "padding": [14, 28, 14, 28],
          "background": "accent",
          "radius": "pill",
          "justify": "center",
          "children": [
            { "kind": "text", "id": "cta-label", "text": "Try it", "style": "caption", "weight": 600, "color": "#000000", "w": "fill", "h": 19, "align": "center" }
          ]
        }
      ]
    }
  ]
}
```

Three details in it are decisions rather than decoration, and all three come
from the numbers above: the headline is 72 against a 22px subhead (3.3:1); the
eyebrow uses the lighter `accent-text` token because `accent` on this surface is
4.5:1 and would be flagged as small text; and the CTA label is `#000000` rather
than a dark slate, because a 15px label needs 4.5:1 and the accent's own
luminance only just allows pure black (4.85:1).

