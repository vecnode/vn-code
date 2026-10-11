# dsh-diagrams (alpha.8)

**Mermaid, TikZ and the Diagram Design kit as one surface: the model writes them as tools, the host validates every
write with a real parser, TeX engine or contract, and each diagram gets its own right-bar tab.**

A diagram lives in the conversation that drew it, or in the shared **LIBRARY** — one store every conversation
reads, addressed without naming one (`dsh-resource://diagram/library/<id>`).

## What it adds

- **Seven tools** — `diagram_write` (create or replace, validated), `diagram_patch` (`oldString`/`newString`;
  `NO_MATCH` / `AMBIGUOUS` refused), `diagram_read` (source, diagnostics, warnings, verdict), `diagram_verify`
  (re-validate; no revision bump, report kept), `diagram_publish` (copy into the LIBRARY), `diagram_delete` and
  `diagram_kit` (the vendored design kit: `catalog`, `reference`, `example`, `insert`) — each taking an optional
  `scope` (`conversation` | `library`), a bare id resolving **library-first**.
- **Three kinds.** `mermaid` and `tikz` are languages; **`html`** is a complete self-contained HTML+SVG
  document — the shape of the design kit's own examples.
- **Every write is validated before storage**, so a broken diagram returns the parser's or compiler's
  line-accurate error. Mermaid is parsed in a **child process** (a DOM stub and the same vendored engine the
  browser uses); TikZ is compiled by the machine's engine (`pdflatex`, else `xelatex`, else `lualatex`); `html`
  is checked against the **safety and accessibility contract** below. Status is the contract: `ok` | `error` |
  `unavailable` (stored but NOT verified).
- **Warnings are advisory and never change the status**: nodes with no edges, too many nodes, an unclosed
  label, a Mermaid first line naming another type, a TikZ document of several pages or none; for `html`, a
  picture with nothing to draw it, no dark-theme tokens, no reduced-motion fallback; empty Mermaid and a TikZ
  document with no drawing command are refused outright.
- **Parsing and drawing are separate verdicts.** The browser reports what it drew to
  `POST /api/dsh-diagrams/render-report`, read back as `drawn` / `failed` / `stale` / `pending` by one function
  shared by the tool result, the state route and the pill; a write clears it.
- **Two tab types, three address shapes.** `diagram` (`priority: 'extension'`) draws one diagram per tab —
  from `dsh-resource://diagram/session/**`, `.../library/**`, or `.../example/**` for a vendored kit example —
  at 80% of the pane with a 25%–400% zoom ladder, pan, and a source drawer whose Apply re-validates like a model
  write. `diagrams` (the index, `sidebar://diagrams`, `priority: 'builtin'`) lists the library, this
  conversation and the **design kit**, with the one guide entry at `order: 40` (after Files 10, Editor 20,
  History 30), and a `tool.call.toolview` card per tool draws it inline.
- **Export** saves mmd/md/tex/html/pdf/svg/png to the **Desktop of the machine running the harness**,
  create-exclusively; the client names a format, never a path (a browser download is the fallback). An `html`
  diagram exports as `.html` (the composed document a person can open) and `.svg` (the picture inside it).

## The Diagram Design kit

Forty-four documented visual types and 204 worked examples, vendored whole from
[`cathrynlavery/diagram-design`](https://github.com/cathrynlavery/diagram-design) (MIT) at a **pinned commit**:
self-contained HTML+SVG, the 62 reference documents behind them, the five templates, and the upstream selector
table. The kit is *data*, not an engine — it gives the model a third kind to write and a tool to browse it with.

| | |
|---|---|
| example keys | **71** (204 examples: `plain` / `full` / `dark` / `animated`) |
| documented types | **44** — the ones with their own written type reference |
| references | **62** documents (style guide, semantic patterns, primitives, animation, output spec, per-type) |
| vendored tree | `lib/vendor/design/`, **277 files, 4.8 MB**, the pinned commit with LF line endings and nothing else changed |

- `diagram_kit` — `catalog` (what exists, and what is authorable), `reference` (how a type is built; the style
  guide carries the tokens every diagram shares), `example` (a worked example's source, capped with the
  truncation stated), and **`insert`** — turn any example into a real diagram in this conversation. An inserted
  example is a **fork**: the vendored original is never touched, and the copy is recorded as `by: 'kit'` with the
  upstream example named in its history.
- **The kit browser** is a section of the index page: filter the 71 keys, open one in a `diagram` tab, and press
  **Use this** to fork it. A machine without the vendored tree simply never draws the section.
- **Authoring an `html` diagram** — start from the template (`diagram_kit({action:"example", id:"template"})`)
  and honour the contract:

  **Refused** (`status: 'error'`, and the panel does not frame it): a remote asset of any kind (`<link>`,
  `<img src>`, `url()` in CSS, `image-set()`, `@import`, a protocol-relative reference), `<base>` / `<embed>` /
  `<object>` / `<iframe>` / `srcdoc`, any `on*` attribute, and **any script that is not the kit's canonical
  motion controller** (compared byte-for-byte against the recorded hash).

  **Warned** (`status` stays `ok`): no accessible `<svg>` (`role="img"`, a first-child `<title>` and `<desc>`
  with prefixed ids and non-empty text), more than nine top-level marks, no `--color-*` tokens so the picture
  cannot follow the theme, no `--font-*` tokens, motion markup without the controller, an animation with no
  print or reduced-motion fallback.

- **Rendering** is a sandboxed frame: `/api/dsh-diagrams/{example,document}` serves the composed document into
  an `<iframe sandbox="allow-scripts">` (opaque origin — never `allow-same-origin`) under a
  `default-src 'none'` **CSP**, so the document cannot fetch anything whatever it contains. The kit's Google
  Fonts `<link>` is stripped at request time (this plugin starts no network request) and the reader's fonts are
  used; animated examples keep their own Play/Pause controls, and the tab adds Fit/Actual plus a theme toggle so
  motion is never re-implemented here.

## How it plugs in

`cordis.patch.yml` inserts the `diagrams` row and patches nothing else. The routes are exact `connection.fetch`
paths with **GET/HEAD/POST only** —
`/api/dsh-diagrams/{health,state,diagram,document,example,artifact,export,render-report,vendor/mermaid.js}` —
which is why the engine is one self-contained file on one route (ETag, ~3.4 MB) and why every write, delete
included, is a POST. Three skills are registered at runtime from the package folder **and** copied by both
installers into `$DSH_HOME/skills` with a `.vncode-<package>` marker, so a person's own skill is never
overwritten.

## Limits

- **State**: `$DSH_HOME/dsh-diagrams/sessions/<session>.json`, one atomic write per change, capped at
  **64 diagrams**, **256 KiB per source** (Mermaid and TikZ) or **512 KiB** for `html` — a document is a whole
  page — inside a **4 MiB source budget per conversation** (charged once on replace, checked on write AND patch,
  `BUDGET` on refusal) and a **16 MiB file cap**.
  `$DSH_HOME/dsh-diagrams/library.json` is the same shape for the whole harness.
- **Cache**: `artifacts/<sha256[0:24]>/{doc.tex,doc.pdf,doc.svg,doc.png,meta.json}`, keyed by engine + renderer
  + normalized source, LRU-pruned at **200 MiB**, **8 MiB** per artifact; a cache hit re-reads the verdict it
  was cached with. An `html` diagram produces no artifact: there is nothing to compile and the frame is the
  renderer.
- **Safety**: engines and converters spawn with an **argv array**, never a shell. TeX runs with
  `-no-shell-escape`, `MIKTEX_AUTOINSTALL=0` (a missing package fails fast rather than reaching the internet),
  `openin_any=p` / `openout_any=p`, a private temp cwd removed afterwards; `tectonic` is refused (it downloads
  packages). Bounded: **20 s** compile kill, **15 s** validator kill, **512 KiB** log, **2** validator
  children with a bounded queue, one compile at a time. **No network**, in either half: the framed document's
  CSP denies every fetch, and the kit's own Google Fonts link is removed before it is served.
- **Mermaid's render path is parse-first**: `parse()` before `render()`, `suppressErrorRendering: true`, a
  container the plugin owns, and a `finally` sweep — so a broken source is text, never an error picture.
- **Never a session event**: `dsh-session-persistence` refuses a log with a type outside
  `KNOWN_SESSION_EVENT_TYPES` unless the envelope is `ignorable`, which `Session.append()` cannot set. **Never a
  projection**: a unit needs `zod`, and this pack ships no npm dependencies.
- **TeX is optional**: without an engine TikZ stores and exports as `.tex`, and the UI says so. A panel edit
  writes back where the diagram already is, so a library diagram is not forked.
- **The kit is optional too**, and degrades the same way: with no vendored tree the tool says how to rebuild it,
  the index draws no kit section, and `mermaid`/`tikz` are unaffected.
- **Not implemented**: host-side Mermaid rasterization (no SVG geometry in the stub; `jsdom` would break the
  zero-dependency rule) and **PNG export for `html`** (rasterizing a document needs a headless browser this pack
  does not ship — the export menu does not offer what the host cannot make).

## Verify

```sh
node scripts/checks/check-client-bundles.mjs   # tab types, seats, cards, the frame, verdicts
node scripts/checks/check-node-routes.mjs      # routes, tools, store, kit, compile, export, drift, budgets
node scripts/checks/check-skill-examples.mjs   # every fenced skill example, parsed or compiled
node packages/dsh-diagrams/checks/check-diagrams-kit.mjs   # the kit, the corpus, the port
```

`check-diagrams-kit.mjs` travels with this package. It runs the vendored tree's own `--check`, walks all **209**
vendored documents through the ported contract, and — where the host has a `python3` — runs the kit's **original
`self_check.py`** over the same corpus and requires the two implementations to agree file for file. Without
Python it skips that half loudly; the corpus half still runs.

```sh
node packages/dsh-diagrams/vendor/build.mjs         # re-vendor the pinned Mermaid version
node packages/dsh-diagrams/vendor/build.mjs --check # fail on drift (offline)
node packages/dsh-diagrams/vendor/design/build.mjs --check  # re-hash the kit (offline)
```

