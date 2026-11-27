# dsh-deckcraft

Slides from the chat, over the user's own [DeckCraft](https://github.com/storytold/deckcraft)
CLI (MIT OR Apache-2.0, alpha). Four tools, three skills, no engine bundled.

## Why the CLI and not an MCP bridge

DeckCraft ships an MCP server too, and a harness can mount it. But DeckCraft is
alpha and its surface is 200+ commands that move between builds. This row takes
the CLI, whose contract is the one thing the app promises not to break: **every
button is a command with a stable id**. Discovery, execution, proof — three
verbs — is a smaller and sturdier integration than a bridge whose tool set has to
be re-verified at every release.

## The tools

| Tool | What it answers |
|---|---|
| `deck_status` | Is the CLI installed, which version, where DeckCraft keeps its settings and logs. Names the install source; installs nothing. |
| `deck_commands` | The command ids this build offers (`deckcraft-cli commands [prefix]`), with summaries. Prefixes keep the list small: `slide.`, `format.`, `theme.`, `export.`. |
| `deck_run` | One command or a batch (`id=<JSON>` each, in order, in one document), saved as a `.deckcraft` in the workspace. `sample:true` writes DeckCraft's sample deck. |
| `deck_export` | `deckcraft-cli render <deck> --all --scale <n> <dir>` → PNG images in the workspace, so the slides can be looked at. |

## The rules this row keeps

- **Argv, never a shell**: a title with a quote or a path with a space is one
  argument.
- **Outputs are scoped**: the save path and the render directory must resolve
  inside the session workspace, or inside a folder the user authorised for that
  call (`allowRoot`). A command cannot write a deck over the user's documents.
- **Nothing is hardcoded**: an id this build does not offer fails at the CLI with
  its own message, and `deck_commands` is how the model finds one that works.
- **Nothing is installed**: DeckCraft is the user's app; `deck_status` names the
  source and stops.

## Skills

`deckcraft-deck` (layouts, placeholders, themes — why content goes into a layout
and not into a text box), `deckcraft-commands` (the command contract, batching,
what to do when one entry fails), `deckcraft-export` (render/PDF/PPTX, and the
checks that make a deck "done").

## Requirements

- DeckCraft, with its CLI: the per-OS `deckcraft-cli` archive from the
  [releases](https://github.com/storytold/deckcraft/releases). `DSH_DECKCRAFT_CLI`
  pins a binary PATH does not carry.
- No other dependency. The row is Node-only and declared dependency-free.

## Check

```sh
npm run check      # node checks/check-deck.mjs — 54 assertions, no DeckCraft needed
```

The live probe runs `deckcraft-cli --version` when a binary is present and says
loudly when it is not.
