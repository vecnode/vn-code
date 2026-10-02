---
name: social-banners
description: "The per-destination delivery facts for a Canvas design: the exact pixel canvas, format and @2x rule, byte ceiling, safe areas and where the file is actually uploaded for every preset. Turn here before exporting anything that has to survive a feed, a repository page or a print shop."
whenToUse: "Whenever a Canvas design is destined for a named surface - a GitHub social preview or README header, an Open Graph card, a LinkedIn profile banner, company page cover, post or carousel page, an X post image, or an A3 poster - and whenever a destination rejects a size, crop or format. The bundled reference/checklist.md is the pre-export gate; reference/print.md covers the one preset that is read on paper rather than in a feed."
---

# Social banners and delivery specs

A Canvas design is not finished when it looks right: it is finished when a file
exists at the destination's exact size, under its byte ceiling, in a format it
accepts, with nothing important inside the region the destination paints over -
and with the upload steps stated in your answer. This file is the table and the
rules; `reference/checklist.md` is the gate you walk before saying "exported".

Three rules govern everything below.

1. **The preset fixes the canvas.** Never hand-write a width and height for a
   named destination: name the preset, and let the canvas come from
   `lib/presets.js`, the same table the validator, the safe-area guides, the
   render report and this skill quote.
2. **The numbers move.** Every row carries a `verifiedOn` date and a source. When
   a destination rejects a size, re-check the network's own documentation and
   report the discrepancy - never guess a second time.
3. **The feed is the real test, not the artboard.** A 1584 px banner is read at
   thumbnail size. `canvas_render` returns the metrics, the lints and a
   **25 %-scale thumbnail**, and that thumbnail is the file the world sees.

## The preset table

`scale2x` is the only column that is a permission rather than a description:
`yes` means there is a documented 2× interpretation of the canvas (see `@2x`
arithmetic below), `no` means export at 1×. Ceilings are the destination's own
byte limit; the margin is the distance from the canvas edge that **text** may not
cross (the report's `MARGIN` check).

| Preset | Canvas (px) | Formats | 2× | Ceiling | Margin | What it is |
|---|---|---|---|---|---|---|
| `github-social` | 1280×640 | png, jpg | yes | 1 MB | 48 | A repository's social preview card |
| `github-readme` | 1280×320 | png, jpg, svg | yes | 5 MB | 40 | The header band at the top of a README |
| `og` | 1200×630 | png, jpg | no | 5 MB | 64 | An Open Graph link unfurl |
| `linkedin-personal-banner` | 1584×396 | png, jpg | no | 8 MB | 48 | A profile's background photograph |
| `linkedin-company-banner` | 1128×191 | png, jpg | yes | 8 MB | 24 | A company page's cover strip |
| `linkedin-post` | 1200×627 | png, jpg | no | 8 MB | 56 | An image attached to a post |
| `linkedin-square` | 1200×1200 | png, jpg | no | 8 MB | 96 | A square feed image |
| `linkedin-carousel-page` | 1080×1350 | png, jpg | no | 8 MB | 72 | One page of a document carousel |
| `x-post` | 1600×900 | png, jpg | no | 5 MB | 80 | An image in an X post |
| `poster-a3` | 3508×4961 | png, svg | no | 40 MB | 210 | A3 at 300 dpi, for paper |

`github-readme` is a convention rather than a documented size: GitHub renders a
README image at the column width, so the design has to survive a render near
800 px wide, and 2560×640 is the safe `@2x` export. `poster-a3` is the only row
whose reader is not a screen - `reference/print.md` is its page.

A format you did not ask for, a canvas that does not match the preset and a file
over the ceiling are refusals, not warnings: `exportProblems` names them
`BAD_FORMAT`, `TOO_LARGE` and `NO_PRESET`.

## What the destination does to the file afterwards

Every one of these crops, letterboxes or paints over the picture after upload. This
column is the reason the safe areas exist - design against what the surface does,
not against the file you handed it.

| Preset | Afterwards | Where the file goes (the click path) |
|---|---|---|
| `github-social` | Shown as a card, usually **letterboxed** and often rendered near 320 px wide | Repository → **Settings → General → Social preview → Edit → Upload an image** |
| `github-readme` | Rendered at the README column width; the reader scrolls past it | Commit the file (e.g. `docs/header.png`) and reference it as the first line of `README.md` |
| `og` | Re-rendered at about 1.91:1 by Slack, Discord, iMessage, X; corners may be rounded | Serve it at a stable URL and add `<meta property="og:image">` with `og:image:width`/`height` |
| `linkedin-personal-banner` | The **profile photograph and the name/headline are painted over the lower left**; the far right is cropped on narrow viewports | Profile → **pencil icon on the banner → Edit background → Upload** |
| `linkedin-company-banner` | The **company logo square sits over the bottom left** of the shallow strip | As a Page admin: **Edit page → Cover image → Upload** |
| `linkedin-post` | The feed crops toward about 1.91:1 and scales it down | Attach to the post, or use it as the link-preview image |
| `linkedin-square` | Takes the most feed height; scaled down hard in the timeline | Attach to the post |
| `linkedin-carousel-page` | Uploaded as a **PDF** or as separate images, in order, one 4:5 page each | Document post (PDF) or a set of images, attached in order |
| `x-post` | The timeline shows a **1.91:1 centre crop of the 16:9 image** | Attach to the post |
| `poster-a3` | Trimmed to size by a print shop, not fitted to a page | Hand the file to a print shop or large-format printer and ask for the trim size |

Two consequences worth stating plainly. The GitHub card is the one surface that is
*certain* to be seen small, so `github-social` at 1280×640 is a design read at
**a quarter of its width** in most places it appears. The X card is the one surface
that *crops without asking*, so a design that puts a headline in the outer sixth of
the canvas keeps it only on the post page and loses it in the timeline.

## The safe areas, and why each one exists

A keep-out area is a region the destination occupies or crops. The report emits
`SAFE_AREA` for any layer that reaches into one - a full-canvas background layer
is exempt, because a background is supposed to cover everything. A `safe` area is
the inverse: the region the design *should* use, drawn as a guide, never a
warning.

| Preset | Region | Why it exists |
|---|---|---|
| `linkedin-personal-banner` | `x 0 y 236 620×160`, "profile photo and headline" | The circular photograph and the name/headline card are painted over the lower left. A mark, a wordmark or a call to action there is simply gone. The usable band is the middle: `x 320 y 96 944×204` |
| `linkedin-company-banner` | `x 0 y 71 200×120`, "company logo square" | The page's logo square overlaps the bottom-left of a strip only 191 px tall - a third of the height. The safe band is `x 260 y 48 780×96`: one wordmark, one line, nothing stacked |
| `github-social` | `x 1060 y 520 220×120`, "lower-right card corner" | The card is rendered small and letterboxed in several surfaces, so its corners are where a UI badge or a "copy link" control can land. Keep the message in the centre band `x 160 y 120 960×400` |
| `x-post` | `x 0 y 208 1600×484`, "centre crop to 1.91:1" | The timeline shows a 1.91:1 crop of this 16:9 image - the top 208 px and the bottom 208 px are visible only on the post page. The message must live inside that band; treat the rest as enlargement, not as room |
| `linkedin-carousel-page` | `x 888 y 1230 144×72`, "page number" | Reserved for the page-number furniture. Because the design owns that position, every page must use the **same** place for it, and the same 72 px margin, or the sequence jumps as a reader swipes. Nothing else belongs there |
| `poster-a3` | `x 0 y 0 3508×100`, "bleed" | The strip the trim cuts into. See `reference/print.md` |

The other five presets carry only a `safe` band - `og` `96,96 1008×438`,
`linkedin-post` `88,80 1024×467`, `linkedin-square` `96,96 1008×1008`,
`github-readme` `80,40 1120×240` - which is a composition hint, not a constraint.

## The feed reality test

Run this after every export, in this order. It is the procedure, not a slogan.

1. **Export the PNG** through `canvas_export` at the preset's own canvas size.
2. **Look at the 25 %-scale thumbnail** the render report returns
   (`canvas_render` hands it back with the metrics and the lints). A 1280×640
   card becomes a 320×160 picture; a 1584×396 banner becomes 396×99. That is
   roughly what a phone feed shows, and it is the picture to judge.
3. **Fail the design if the headline is not readable there.** Not "legible when I
   lean in" - readable at a glance, in the thumbnail, without zooming. If it is
   not, the fix is fewer words and a larger size, never a bolder weight alone.
4. **Check contrast at the text's own position, never against the canvas
   background.** The report's `LOW_CONTRAST` samples the paint actually behind
   each text op - so type on a card, over a photograph, or under a scrim is
   judged where it sits. The thresholds the engine applies are WCAG's:
   **4.5:1 for body text, 3:1 for display text at 28 px and above**.
5. **Confirm nothing important sits inside the preset's margin.** `MARGIN` names
   the text layer that crossed it, in pixels. Decorative bleed is fine; a word the
   reader is meant to read is not.
6. **Count the focal points.** One. A design with two things competing to be read
   first has neither - the feed does not give a reader time to decide.
7. **Choose the format for what is in the picture.** PNG for type and flat colour;
   JPG only for photographs. PNG keeps type crisp - it is lossless, so an edge
   stays an edge - and it is exactly right for the flat fills these banners are
   mostly made of. It is also the heavy choice for a photograph: a 1200×1200
   photographic PNG can be several megabytes while the same picture as a JPG is a
   fraction of the size, well under the 8 MB ceiling, with no visible loss. Invert
   the reasoning for a photographic banner and you ship a file that is both larger
   *and* worse - a JPG of flat colour and small type rings around every letter.
   `github-readme` also accepts SVG, which is the right export when the design is
   vector: the bundled faces are embedded as data URLs, so the type is still type
   - and a README on a phone renders an SVG in an `<img>` without fetching
   anything.
8. **Size-check before upload.** `exportProblems` compares the file's bytes with
   the ceiling and names the number in KB when it refuses.

## `@2x` arithmetic

Only three presets record `scale2x: true`, and their doubled canvases are:

| Preset | 1× | `@2x` |
|---|---|---|
| `github-social` | 1280×640 | 2560×1280 |
| `github-readme` | 1280×320 | 2560×640 |
| `linkedin-company-banner` | 1128×191 | 2256×382 |

These three are the ones whose surface is a wide, high-density display or whose
card is rendered at a size that rewards real pixels: a repository's social card, a
README header read on a Retina laptop, and a company strip that is only 191 px
tall in a 1128 px column. Every other row is `scale2x: false`; export at 1×, and do
not invent a doubled variant for a preset that does not record one.

The rule that makes `@2x` safe:

- **A 2× export is the same COMPOSITION rendered at twice the pixels.** Every
  length in the document doubles - the canvas, the margins, the type sizes, the
  gaps - because the layout is the same layout. It is never a different design,
  never a re-composed version, never "the same file upscaled": the report's
  thumbnail is a quarter of each, and the two thumbnails must show the same
  picture at the same proportions.
- **If anything but the pixel count differs, they are two designs.** A different
  headline, a different type size, a missing subhead - then the surface showing
  the 1× variant and the surface showing the 2× variant are showing two different
  cards, and one of them is wrong.
- **The ceiling still applies.** `github-social` accepts 1 MB whether the file is
  1280×640 or 2560×1280; a doubled PNG is roughly four times the pixels and often
  four times the bytes, so a 2× export is exactly where the ceiling is reached.
  Check it, and prefer JPG at 2× only when the picture is photographic.

## Honesty about moving numbers

**These specifications change without notice.** LinkedIn has re-cropped its profile
banner more than once; GitHub has changed its social-preview guidance; a network
that documents a size today can stop documenting it tomorrow. The `verifiedOn`
date on each row is 2025-02-01 and the source beside it is the network's own
documentation - a table with no provenance is a table nobody can re-check, which
is why the host's check fails when a row is missing one.

So when a destination rejects a size, a format or a crop:

1. **Say what happened**, with the destination's own words wherever you have them
   ("LinkedIn rejected the 1584×396 upload", not "the upload failed").
2. **Re-check the network's own documentation** - the source on the row, or its
   current replacement - rather than a blog post, a listicle or a memory of what
   worked once.
3. **Report the discrepancy plainly** to the user: which row is stale, what the
   table says, what the documentation now says, and which number you are exporting
   at. A one-sentence correction is worth more than a silent guess.
4. **Never fabricate a new pixel size.** If the documentation gives no size for the
   surface, say that there is no verified size and offer the nearest preset, with
   its own caveat - an unverified number is worse than an honest "the network does
   not publish one".
5. **Say when the numbers in this file were last verified** if the user is relying
   on them for something that cannot be redone cheaply.

The same honesty applies to the report: a lint you deliberately ignored is worth
one line in your answer ("no content in the carousel page-number region, so the
`SAFE_AREA` note does not apply"), because a model that silently overrides its own
checks is indistinguishable from one that never ran them.

## What a document looks like

A complete document names the preset and nothing else about the canvas; the
engine fills in the size. This is `linkedin-personal-banner`, sized so the report
returns **no** safe-area or margin finding - every layer is placed, not flowed,
because a banner is a fixed composition:

```canvas
{
  "title": "Banner - middle band only",
  "preset": "linkedin-personal-banner",
  "canvas": { "background": "#0B1220" },
  "tokens": {
    "color": { "ink": "#F8FAFC", "muted": "#C7D2E4" },
    "font": { "display": "Space Grotesk", "text": "Inter" },
    "scale": { "title": 40, "body": 28, "caption": 24 },
    "radius": { "card": 20 }
  },
  "layers": [
    {
      "kind": "text",
      "id": "eyebrow",
      "x": 320, "y": 96, "w": 288, "h": "hug",
      "text": "DSH PLUGIN PACK",
      "style": "caption",
      "family": "text",
      "weight": 600,
      "color": "muted",
      "letterSpacing": 2
    },
    {
      "kind": "text",
      "id": "headline-1",
      "x": 320, "y": 132, "w": 288, "h": "hug",
      "text": "One plugin",
      "style": "title",
      "family": "display",
      "weight": 700,
      "color": "ink",
      "lineHeight": 1.15
    },
    {
      "kind": "text",
      "id": "headline-2",
      "x": 320, "y": 178, "w": 288, "h": "hug",
      "text": "pack, every",
      "style": "title",
      "family": "display",
      "weight": 700,
      "color": "ink",
      "lineHeight": 1.15
    }
  ]
}
```

**No layer in it reaches a keep-out or crosses the margin** - the report comes back
with nothing to fix, and that is the target, not a lucky draw. The **width is doing
the work**: the keep-out is `x 0 y 236 620×160`, so a text box that stops at or
above `y 236` may be wide, while a box that runs lower must stop left of `x 620`.
This takes the strict version of both - a copy column **288 px wide** starting at
`x 320` and stopping at `x 608`, ending `y 224`, twelve pixels clear of the
keep-out. Copy that fits the column is the fix; moving the box is not.

The report checks **boxes, not glyphs**, and that has a consequence worth knowing
before you write one: a 540 px-wide text node holding a two-word line still trips
`SAFE_AREA`, because the box is where the layout says the line lives. It is also why
this headline is **split into two placed nodes**: one wrapping node would put "One
plugin" and "pack, every" where the measurer decided, and its box - not its glyphs -
is what the checks read. Placing the two lines yourself means the `y` values are
yours, the spacing is the `lineHeight` you set (46 px, at 1.15 of 40 px), and the
report has nothing to say about where the lines landed. Give the same copy as one
node inside a box too short for it and the report answers `TEXT_OVERFLOW`, then
`TEXT_TRUNCATED` once `maxLines` bites.

Two type sizes are in play, 24 and 40 - the lowest, not the highest, count the
engine is happy with. The `lineHeight` of 1.15 makes each 40 px line box 46 px tall,
which is why `y 132` and `y 178` sit them 46 px apart with no overlap. The colours
are literals here so the example stands alone; in a real design define them once
under `tokens.color` and reference the names. And the honest limit of that column: a
288 px band at 40 px carries a wordmark, not a sentence. If the message needs one,
move the whole block into the middle safe band (`x 320 y 96 944×204`) - wide, but
only 204 px tall.

To place it, state the steps from the table:

```json
{
  "preset": "linkedin-personal-banner",
  "file": "dsh-pipeline-1584x396.png",
  "format": "png",
  "scale": 1,
  "where": "Profile -> pencil icon on the banner -> Edit background -> Upload"
}
```

## Related

- `reference/checklist.md` - the pre-export gate, with the report code that proves
  each item. Walk it before you tell the user the file is ready.
- `reference/print.md` - `poster-a3`: 300 dpi, bleed and trim, why a 3 px rule and
  a hairline blend fail on paper, and the one thing this pack cannot do for print.
