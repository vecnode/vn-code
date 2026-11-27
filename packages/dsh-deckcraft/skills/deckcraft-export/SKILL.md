---
name: deckcraft-export
description: Get a deck out of DeckCraft - render slides to PNG with `deck_export` (scale, output directory, what a render actually proves), the PDF/PNG/outline export commands, opening and saving .pptx and .ppt, and the fidelity limits of an alpha presentation app. Covers the check that a deck looks right before it is called done.
whenToUse: Use after building or editing a deck, when the user asks to see the slides, when a deck has to be delivered as PDF or PowerPoint, when a render comes out empty or at the wrong size, or before saying a deck is finished.
---

# Getting the deck out

A `.deckcraft` file is the source; a render is the proof. Neither replaces the
other: the file is what the user keeps editing, the images are what you and the
user look at.

## The render

`deck_export` runs:

```text
deckcraft-cli render <deck> --all --scale <n> <dir>
```

- `--all` renders every slide; the output directory defaults to
  `renders/<deck name>/` inside the workspace.
- `scale:2` doubles the pixels - use it when the images will be looked at
  closely, and 1 for a quick check.
- A render with zero images means the command failed or the deck is empty. The
  tool returns the CLI's own output in that case; read it instead of assuming.

Then LOOK at the images. A deck that compiles is not a deck that reads: a title
that overflows its placeholder, a two-column slide with one column empty, a
chart with no data - all of those render fine and look wrong. Describe what you
see, and fix the deck rather than the screenshot.

## The document formats

DeckCraft exports PDF (slides, notes pages, handouts with selectable text),
PNG/JPEG, an animated GIF and an outline. Those are commands - `deck_commands`
with the `export.` prefix lists the ids for this build, and `deck_run` runs them
with an output path inside the workspace. `.pptx` is the exchange format: open
and save a presentation, and import PowerPoint 97-2003 `.ppt/.pot/.pps`
(import only).

## The fidelity caveats to state, not hide

DeckCraft is alpha. When a deck leaves it:

- say which build produced the file (`deck_status --probe`), because command ids
  and export behaviour move between builds;
- a `.pptx` round-trip through another app can reflow text: the layouts and
  masters are DeckCraft's own, and the receiving app has its own;
- a PDF is the safest deliverable for "it must look like this", a `.pptx` for
  "they must be able to edit it";
- fonts: DeckCraft embeds its presentation fonts, but a PDF opened on a machine
  without them still renders - the embedded file is the one to send.

## Done means

- the file exists in the workspace and the path is named in the answer;
- the render was looked at, and the slides that were wrong were fixed;
- the export format matches what the user will do with it (present, edit,
  print);
- the build/version is recorded when the deck leaves the machine.
