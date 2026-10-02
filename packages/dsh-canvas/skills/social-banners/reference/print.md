# Print: the `poster-a3` preset

Every other preset in this skill is read on a screen, at some fraction of its own
pixels. `poster-a3` is read on paper, at 100 % of its own pixels, from about an
arm's length. That changes the arithmetic, the minimum feature size and the whole
idea of what "the same composition" means. Read this file before designing anything
destined for a printer.

## The preset

| Field | Value |
|---|---|
| Canvas | 3508×4961 px |
| That is | A3 (297×420 mm) at **300 dpi** |
| Margin | 210 px print-safe |
| Formats | `png`, `svg` |
| Ceiling | 40 MB |
| `scale2x` | no - the file is already at print resolution |
| Safe area | `x 210 y 210 3088×4541`, "print-safe area" |
| Keep-out | `x 0 y 0 3508×100`, "bleed" |
| `verifiedOn` | 2025-02-01, ISO A-series (ISO 216 / the 300 dpi arithmetic) |

The size is not a style choice: 3508 px divided by 300 dpi is 11.69 in, which is
297 mm, which is A3. Ask for a "poster, 300 dpi" and this is the canvas; ask for A2
or A1 and the honest move is to say the pack has no verified preset for it rather
than to improvise a pixel count.

## The three rules that are not about taste

**1. Nothing thinner than 3 px.** A hairline - a 1 px rule, a 0.5 px divider, a
`border: {width: 1}` - is below what a 300 dpi press reproduces as a clean line. At
300 dpi one device pixel is 1/300 in, and a press, a laser printer and an inkjet all
handle very thin features differently: some drop them entirely, some render them
ragged, some fill them in. A rule that exists to separate two blocks of text must be
at least 3 px, and a rule thinner than that is decoration you cannot rely on. If a
1 px line is the design, the design is wrong for paper.

**2. A hairline blend fails.** A gradient between two near-identical colours, a
shadow whose darkest stop is 2 % from the background, a hairline stroke used to
soften an edge - all of it is a **continuous-tone** effect, and print does not
reproduce continuous tone the way a screen does. Screens dither nothing and show a
smooth ramp; a press lays down dots of ink, and a ramp that subtle either bands or
disappears. Same for a soft shadow: it may vanish, or print as a visible hard edge.
The safe form of every one of those is **a flat area of colour, or a step of at
least a few percent** between adjacent areas. If you want a blend, make it a real
one - a wide ramp between clearly different colours - not a hairline whisper.

**3. Nothing readable within 210 px of the trim.** The preset's margin is 210 px,
which is about 17.8 mm at 300 dpi. This is the **print-safe** area: the region a
printer is expected to be able to put ink on without the guillotine or the paper
edge taking it away. Type, a logo, a QR code or a call to action inside that band
may be trimmed off or run off the sheet. Decoration may bleed; words may not.
Evidence in the report: `MARGIN` names the text layer that crossed it.

## Bleed and trim, in this pack's vocabulary

Print vocabulary is worth getting right, because a print shop will use these words
and a design that ignores them gets a phone call.

- **Trim** is the finished size - A3, 297×420 mm - the line the guillotine cuts on.
  The 3508×4961 canvas **is** the trim box.
- **Bleed** is artwork that extends past the trim line so that a small misalignment
  in cutting cannot leave a white sliver at the edge. On a press it runs all the way
  round the sheet; this preset records **one** strip of it as data - the top 100 px,
  `x 0 y 0 3508×100` - and the report emits `SAFE_AREA` for any layer that reaches
  into it. A full-bleed background layer is exempt, which is exactly right: a
  background is supposed to reach the edge. Never place anything you need inside that
  strip, and treat the other three edges as if they carried the same 100 px: the
  table names one, the press applies four.
- **Safe area** is the region that survives trimming, and this preset's is
  `x 210 y 210 3088×4541`. Everything a reader must see lives here.
- **Fit-to-page** is what you must refuse. A print shop that "fits the file to A3"
  scales it to whatever its own margins are, which silently changes your type sizes
  and can push content into the trim. The preset's own instruction is to hand over
  the file and **ask for the trim size**, not a fit-to-page render.

## Arm's length versus thumbnail: the same composition cannot serve both

A social banner is judged at 25 % of its pixels, in a scrolling feed, in well under
a second: its rules are big type, few words, high contrast, one focal point, and a
safe area that keeps the message out from under a profile photograph. A poster is
judged standing in front of it, for as long as the reader likes: its rules are a
reading order across a large surface, a type scale that works at 300 dpi, and
detail that rewards a second look.

The consequences are concrete:

| | A banner | The poster |
|---|---|---|
| Read at | ~25 % scale, a phone feed | 100 % scale, arm's length |
| Headline size | the smallest that survives the thumbnail | comfortable at 300 dpi; often 150-300 px |
| Word count | a headline, maybe a subhead | a headline, a subhead, body, captions |
| Detail | one idea | a hierarchy you can walk |
| Colour | flat, high contrast | flat areas; blends only when wide |
| Margins | the preset's, for the destination's UI | the print-safe area, for the trim |

So a design cannot be "exported at A3 as well" by changing the preset: the type
scale that reads at thumbnail size is a whisper at arm's length, and a poster's
reading order collapses to a grey smear at 25 %. If both are wanted, they are two
designs with one shared idea - and the shared idea is the words and the palette, not
the layout.

## Colour: what this pack does, and what it does not

**This pack produces RGB PNG and SVG and does not do CMYK conversion.** State it
plainly to anyone taking a file to a print shop:

- Every colour in a Canvas document is an sRGB hex literal or a token resolving to
  one. `paintCanvas` paints in RGB; the SVG serializer writes the same hex values.
- There is no ICC profile, no rendering intent, no black-point compensation, no
  rich-black generation, and no gamut check. Bright saturated greens, oranges and
  blues can look noticeably different when a press converts them to CMYK - often
  duller - and no check in this pack will warn you, because the pack never converts.
- The practical handover is: export the **PNG** at 1× (or the **SVG** when the
  design is pure vector - the bundled faces are embedded, so the type stays type and
  a print shop can scale it), tell the shop it is **sRGB** and that it needs the CMYK
  conversion done on their side, and ask them to confirm the trim size.
- If exact colour is critical - a brand colour on a large run - the conversion
  belongs in a tool that owns colour management. Say so rather than promising a
  colour match this pack cannot make.

## The poster's own checklist

Same gate as `reference/checklist.md`, with four items changed for paper:

1. The document names `preset: "poster-a3"` - no hand-written canvas.
2. `SAFE_AREA` is empty for every layer except a full-bleed background: nothing
   readable is inside the bleed keep-out (`x 0 y 0 3508×100`) or the 210 px band.
3. `MARGIN` is empty: no text layer crosses 210 px from any edge.
4. No feature is thinner than **3 px**, and no important contrast depends on a
   hairline blend.
5. `TYPE_TOO_SMALL` is empty and the *smallest* type on the sheet is still
   comfortable at arm's length - 14 px is the engine's floor for a feed, not a
   target for a poster.
6. Format is `png` (or `svg` for vector work); the file is under 40 MB.
7. The handover states: **sRGB**, needs the shop's CMYK conversion, ask for **trim
   size** not fit-to-page, and the finished size is A3.
