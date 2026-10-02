# The pre-export gate

Walk this list in order before you tell a user a banner is ready. Each item names
the evidence that proves it - most of them a code the render report emits. Do not
skip an item because the design "looks fine": the report is the check, and looking
is what produced the design in the first place.

Record the answers. A user who asks "is it right?" is asking for this list, not for
an adjective.

1. **The destination is named, and it is a preset.** The document carries
   `"preset"`, never a hand-written `canvas.width`/`canvas.height`. Evidence: the
   validator accepts the named preset; a free-form canvas answers `NO_PRESET` from
   `exportProblems` and means you are shipping a picture, not a delivery.
2. **The canvas is the preset's own pixels.** Compare the exported file's own
   dimensions against the table (`github-social` 1280×640, `linkedin-personal-banner`
   1584×396, `poster-a3` 3508×4961, and so on). Evidence: the render report's width
   and height, and the file's IHDR/header.
3. **No layer reaches a keep-out area.** Evidence: `SAFE_AREA`, which names the
   layer and the region (`profile photo and headline`, `company logo square`,
   `lower-right card corner`, `centre crop to 1.91:1`, `page number`, `bleed`).
   A full-bleed background layer is exempt by design; anything else is not. If a
   finding is a false positive because the visible glyphs are short, **narrow the
   text box** rather than arguing with the check - the box is where the layout puts
   the line.
4. **Nothing readable crosses the preset's margin.** Evidence: `MARGIN`, in pixels,
   naming the text layer. Decorative bleed is allowed; a word the reader must read
   is not.
5. **Every text op passes its own contrast threshold.** Evidence: `LOW_CONTRAST`,
   which samples the paint actually behind the text *at its own position* - 4.5:1
   for body text, 3:1 at 28 px and above. Type over a photograph, a scrim or a card
   is judged where it sits, so check the scrim as well as the type.
6. **No type is below 14 px.** Evidence: `TYPE_TOO_SMALL`. At a 25 % feed render
   14 px reads as 3.5 px, which is already too small - treat 14 px as the floor you
   would never argue about, and stay well above it.
7. **Nothing wrapped away or ran past the box.** Evidence: `TEXT_TRUNCATED` (a
   `maxLines` cut the copy and added an ellipsis), `TEXT_OVERFLOW` (the type needs
   more height than the box has), `TEXT_UNWRAPPED` (a long line with no `w`, wider
   than the canvas). Any of the three is a copy or width fix.
8. **Every image resolved.** Evidence: `MISSING_ASSET` (an `image` node naming a
   `src` the asset table does not have - an `error`, not a warning) and
   `IMAGE_UNMEASURED` (the asset was described, so a hug size was assumed). A
   design with a hole where the photograph should be is not shippable.
9. **No raw SVG fragment was left unpainted by the rasterizer.** Evidence:
   `SVG_FRAGMENT_UNPAINTED`, which means the PNG export dropped it while the `.svg`
   export kept it - so the two outputs show different pictures.
10. **One focal point.** Evidence: your own reading of the 25 % thumbnail. Nothing
    in the report can count focal points; the `MANY_SIZES` and `MANY_FAMILIES`
    findings are the closest proxy (more than four sizes or two families is a
    composition that has stopped deciding). If you cannot say which element the eye
    hits first, there is not one.
11. **The headline survives the feed.** Evidence: **the 25 %-scale thumbnail** in
    `canvas_render`'s report. Look at it and fail the design if the headline is not
    readable there. A 1280×640 card is 320×160 at this scale. Do not substitute a
    zoomed-in look at the artboard for this step.
12. **The format is chosen for the content.** PNG for type and flat colour; JPG
    only when the picture is photographic; SVG only where the preset lists it
    (`github-readme`, `poster-a3`). Evidence: `BAD_FORMAT` from `exportProblems` if
    the destination does not take it.
13. **The file is under the destination's ceiling.** `github-social` 1 MB,
    `github-readme` and `og` and `x-post` 5 MB, the LinkedIn rows 8 MB,
    `poster-a3` 40 MB. Evidence: `TOO_LARGE`, which reports the actual size in KB.
    Remember that a `@2x` export is roughly four times the pixels of its 1×
    counterpart.
14. **`@2x` was used only where the preset records `scale2x: true`**
    (`github-social`, `github-readme`, `linkedin-company-banner`), and the 2× file
    is the **same composition at twice the pixels** - not a re-composed version,
    not an upscale. Evidence: the two render reports' thumbnails show the same
    picture at the same proportions.
15. **The colour behind every word was checked at runtime, not assumed.** A design
    that passes on paper because the headline sits on the dark background can fail
    because the scrim is too light, or because the feed renders the card on a white
    page. Evidence: `LOW_CONTRAST` is empty.
16. **The delivery path is written down.** Name the destination and the click path
    from the table, in the user's own terms - repository **Settings → General →
    Social preview**, profile **pencil → Edit background**, Page admin
    **Edit page → Cover image**, a **document/PDF carousel** uploaded in order -
    and note any step that must happen in order (a carousel's pages, a PDF's page
    size matching the images).
17. **The `verifiedOn` date is stated when the user is relying on it.** If the
    number came from this table rather than from the destination's live
    documentation, say so, and say what to re-check if the upload is refused.

The last line of the gate is the summary, and it is the sentence that closes the
task: **the file exists, at the right size, under the ceiling, and the delivery
steps were stated.**

## When an item fails

Do not edit the design to satisfy the check until you know which is wrong. In order:

1. Read the finding's `path` - it is the node, e.g. `layers.2`.
2. If the finding is about geometry (safe area, margin), the fix is usually the
   **box**: give the text a narrower `w` so its layout box cannot enter the region.
3. If it is about the type (overflow, truncation, size), the fix is usually the
   **copy**: fewer words, or a bigger size with fewer words, not a smaller size.
4. If it is about contrast, fix the **paint** behind the text, then re-render -
   a scrim, a card, or a different background colour, not a lighter grey.
5. If a destination refuses a size the table states, re-check the network's own
   documentation and report the discrepancy (see `SKILL.md`, "Honesty about moving
   numbers"). Never silently substitute a number you invented.
