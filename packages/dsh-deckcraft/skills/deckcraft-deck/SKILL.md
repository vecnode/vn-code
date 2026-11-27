---
name: deckcraft-deck
description: Build a deck in DeckCraft from the chat - the document model (slides, masters, the eleven layouts, placeholders that inherit position and formatting), the eight themes and their colour and font schemes, sections and notes, and how to choose a layout per slide instead of drawing a rectangle where a title belongs. Covers the shape of a command batch that produces a real deck rather than a pile of text boxes.
whenToUse: Use when the user asks for a presentation, a slide deck, a pitch, a talk, a report as slides, or an edit to an existing deck; when a deck has to match a theme or a template; or when a deck looks wrong because content was placed as shapes instead of into a layout's placeholders.
---

# Building a deck that behaves like a deck

DeckCraft is a presentation app, not a canvas with slides on it. The difference
is the LAYOUT: a slide chooses one of eleven layouts, and each layout carries
placeholders - title, subtitle, body, picture, chart - whose position and
formatting come from the master and the theme. Text put into a placeholder
stays right when the theme changes, when the slide size changes, and when a
person edits it later. A text box dropped at x=120,y=80 does not.

## The order that produces a real deck

1. **A theme first.** `deck_run` a command that applies one (`commands` with a
   `theme.` prefix lists them). A deck built before a theme is applied looks
   like a default and then reflows when the theme arrives.
2. **A slide per idea, with its layout named.** `slide.new` takes the layout
   (`titleOnly`, `titleAndContent`, `sectionHeader`, `twoContent`, ...). Pick
   the layout that has the placeholders the content needs; do not pick
   `titleOnly` and add shapes.
3. **Content into placeholders**, not shapes. The commands that set a title, a
   subtitle or a body address the placeholder, so the master keeps controlling
   the look.
4. **Sections when the deck has parts.** A section header slide per part is
   cheaper to navigate than 20 slides in a row.
5. **Notes on the slides that need a script.** The note is where the talk goes;
   the slide is for the audience.
6. **Save once, at the end of the batch**, into the workspace.

## What a good batch looks like

- one command per slide (`slide.new` with its layout and title), not a `run`
  per slide - the batch is one undo unit and one save;
- JSON arguments are small and literal: a title, a layout id, a level;
- an id you have not seen in `deck_commands` is not run "to see what happens" -
  look it up, then run it;
- the save path is inside the workspace (`decks/<name>.deckcraft` by default).

## When the user wants it to look like something

Ask which deck/theme is the reference, then apply that theme and those layouts.
Do not imitate a deck by hand-placing rectangles: the reference's look comes from
its master and theme, and a hand-placed copy breaks on the first edit.

## The deck is a file

A `.deckcraft` file is the deliverable. After building it, offer the render
(`deck_export`) so the user can see the slides, and name the file path - a
conversation that describes a deck without a file has not made one.
