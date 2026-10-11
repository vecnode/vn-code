---
name: diagram-design
description: Author an editorial HTML+SVG diagram with the Diagram Design kit - choose the visual type, read its reference, start from an example, and satisfy the safety and accessibility contract that diagram_write({kind:"html"}) enforces.
---

# Diagram Design

The `dsh-diagrams` plugin vendors the **Diagram Design kit**: 71 example keys,
204 self-contained HTML+SVG examples, and 62 reference documents, from
<https://github.com/cathrynlavery/diagram-design> (MIT, pinned by commit). This
skill is how to use it well. Everything it names is on disk inside the plugin and
is reachable through the `diagram_kit` tool - read it there rather than from
memory, because the kit is the authority on its own conventions.

## The one-sentence rule

**A diagram is a document: one HTML file, one inline SVG, no shadows, no
network, no script except the kit's motion controller.** If a picture needs a
library, a webfont URL or a shadow to work, it is not a diagram in this system.

## The workflow, in order

1. **Catalog first** — `diagram_kit({action:"catalog"})` lists the 71 keys. The
   44 marked with `*` have a written type reference; the rest are named
   variations of a documented family (`bubble` is `scatter`, `marimekko` is
   `treemap`) or importer demos.
2. **Read the shared rules once** — `diagram_kit({action:"reference",
   ref:"style-guide"})`. It carries the colour tokens, the type scale and the
   density budget that every type assumes. Then, when the meaning is about
   behaviour rather than shape, `ref:"semantic-patterns"` - it maps a trigger
   ("fan-in with finite capacity", "two policy traces that must show the first
   divergence") onto the type that carries it.
3. **Read the type's own notes** — `ref:"<type>"`, e.g. `ref:"sankey"` serves
   `references/type-sankey.md`.
4. **Look at a finished one** — `{action:"example", id:"sankey"}` (add
   `variant:"animated"` where the catalog lists it). Copying a working document
   and changing its content is the intended path, not cheating.
5. **Either insert it** — `{action:"insert", id:"sankey"}` turns the example into
   a real diagram in this conversation in one call - **or write your own** with
   `diagram_write({kind:"html", source})`, starting from
   `{action:"example", id:"template"}` (and `id:"template-motion"` when it moves).

`insert` is a fork: the vendored file is never modified, and the stored copy is
recorded as having come from the kit.

## What `diagram_write({kind:"html"})` will refuse

The check is a port of the kit's own `self_check.py`, run over every published
example. Its findings come in two tiers, and the difference matters:

**Refusals** (the write does not validate; the panel will not frame it):

- any remote reference: `<link>`, `<img src>`, `<use href>` to another host, a
  `srcset`, a CSS `@import`, a non-fragment `url()`, `image-set()`. The one
  exception is the kit's own Google Fonts `<link>`, recognised so the kit's
  examples pass - the plugin strips it when it serves the frame;
- `<base>`, `<embed>`, `<object>`, `<iframe>`, `applet`, `frame`, `srcdoc`;
- any `on*` attribute;
- **any script other than the kit's canonical motion controller**, byte for byte.
  One `<script data-diagram-controls>` whose body hashes to the recorded value;
  anything else is refused with both hashes in the message.

**Warnings** (the diagram is valid; these are judgement calls, fix the ones that
are right and say which you ignored):

- no `<svg>`, or an SVG that is not accessible: it needs `role="img"`, a
  first-child `<title>` and a `<desc>` with ids prefixed by the diagram's name,
  `aria-labelledby="<prefix>-title <prefix>-desc"`, and non-empty text in both;
- more than nine top-level marks — above that, the kit's own budget says it is
  probably two diagrams;
- no `--color-paper` / `--color-ink` / `--color-muted` / `--color-accent`
  declarations, so the panel cannot adapt it to the dark theme;
- no `--font-sans` / `--font-serif` / `--font-mono` in use, so it will not follow
  the reader's fonts;
- motion markup without the canonical controller, or a controlled animation with
  no `prefers-reduced-motion` or print fallback.

## Craft, from the kit's own philosophy

**The highest-quality move is usually deletion.** Every node is a distinct idea;
two that always travel together are one node. Every connection carries
information; if the layout already says it, the line is noise. Accent colour is
**editorial, not a flag** — one or two focal marks per diagram, never five.

Target density is about 4/10, and nine top-level marks is the budget. A diagram
is finished when nothing more can be removed, not when everything has been added.

## Templates

| id | what it is |
|---|---|
| `template` | the blank page: tokens, frame, heading, one accessible SVG |
| `template-full` | the page with the editorial cards and footer under the picture |
| `template-dark` | the dark palette |
| `template-terminal` | the terminal/sketchy register |
| `template-motion` | the motion page, and the source of the ONE script allowed |

Read one with `{action:"example", id:"template"}`; its bracketed placeholders
(`[diagram-slug]`, `[Diagram title]`) are what you replace first.

## Where the files are

Inside the plugin, not in this skill's folder: `lib/vendor/design/` — `assets/`
(the examples and templates), `references/` (the 62 documents), `catalog.json`,
and `SKILL.md` (the upstream selector table). `diagram_kit` is the supported way
to read them; `vendor/design/build.mjs --check` proves the tree still matches the
pinned upstream commit.
