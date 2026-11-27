---
name: deckcraft-commands
description: The DeckCraft command contract - every button is a command with a stable id, `deck_commands` lists the ids this build offers, `deck_run` takes `id=<JSON>` entries and runs them in order in one document, and `deck_status` tells you whether the CLI is there at all. Covers discovering ids by prefix, the JSON argument shape, batching and undo, saving, and why a command id must never be invented.
whenToUse: Use before running any DeckCraft command, when a command fails with "unknown command" or a schema error, when the user asks for something the obvious id does not cover, or when a batch has to be split because one entry failed.
---

# The command contract

DeckCraft's README states it directly: every action is a command with a stable
id, so people, scripts and AI agents use the same verbs. That is the API this
row drives, and it is the reason the plugin does not wrap 200 tools.

## Discover, do not guess

`deck_commands` runs `deckcraft-cli commands [prefix]` and parses the list. Use a
prefix to keep it small:

- `slide.` - creating, deleting, reordering, duplicating slides
- `format.` - text and paragraph formatting
- `theme.` - applying a theme or a colour/font scheme
- `view.` - zoom, view mode, presenter view
- `export.` - PDF, PNG, the outline
- `file.` - open, save, recent

A command id that is not in that list does not exist in this build. Do not try a
plausible spelling: DeckCraft is alpha and ids move, and a failed command is a
wasted step in a conversation.

## The run shape

`deck_run` builds:

```text
deckcraft-cli run --cmd 'slide.new={"layout":"titleOnly","title":"Hello"}' --cmd 'slide.new={"layout":"titleOnly","title":"World"}' --save decks/hello.deckcraft
```

- The id comes first, then `=`, then the JSON argument. The argument is
  validated as JSON before it is passed, so a typo fails here rather than
  halfway through a deck.
- All entries run in ONE document, in order. That is also one undo unit.
- `--save` is the deck file; it must resolve inside the workspace.
- `sample:true` writes DeckCraft's built-in sample deck - the shortest proof
  that the CLI and the row are working before a real batch.

## When one entry fails

DeckCraft stops at the failing command and its stderr names it. Read that line,
then:

- re-check the id with `deck_commands <prefix>`;
- re-check the argument against the command's own schema (the failure usually
  says which field is missing or the wrong type);
- split the batch: run the first half, save, then the second - a long batch that
  fails at entry 30 leaves you guessing which deck state you have.

## What is not a command

Reading a deck back, measuring a slide, or deciding what "looks good" are not
commands. The file is the state: re-open it with `file.` commands, render it with
`deck_export`, and look at the images. A command batch that cannot be seen is a
guess about the result.
