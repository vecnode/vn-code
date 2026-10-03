# dsh-diagrams (alpha.7)

**Mermaid and TikZ diagrams as a first-class surface: the model writes them as tools, the host validates every
write with a real parser or TeX engine, and each diagram gets its own right-bar tab.**

A diagram lives in the conversation that drew it, or in the shared **LIBRARY** — one store every conversation
reads, addressed without naming one (`dsh-resource://diagram/library/<id>`).

## What it adds

- **Six tools** — `diagram_write` (create or replace, validated), `diagram_patch` (`oldString`/`newString`;
  `NO_MATCH` / `AMBIGUOUS` refused), `diagram_read` (source, diagnostics, warnings, verdict), `diagram_verify`
  (re-validate; no revision bump, report kept), `diagram_publish` (copy into the LIBRARY), `diagram_delete` —
  each taking an optional `scope` (`conversation` | `library`), a bare id resolving **library-first**.
- **Every write is validated before storage**, so a broken diagram returns the parser's or compiler's
  line-accurate error. Mermaid is parsed in a **child process** (a DOM stub and the same vendored engine the
  browser uses); TikZ is compiled by the machine's engine (`pdflatex`, else `xelatex`, else `lualatex`). Status
  is the contract: `ok` | `error` | `unavailable` (stored but NOT verified).
- **Warnings are advisory and never change the status**: nodes with no edges, too many nodes, an unclosed
  label, a Mermaid first line naming another type, a TikZ document of several pages or none; empty Mermaid and
  a TikZ document with no drawing command are refused outright.
- **Parsing and drawing are separate verdicts.** The browser reports what it drew to
  `POST /api/dsh-diagrams/render-report`, read back as `drawn` / `failed` / `stale` / `pending` by one function
  shared by the tool result, the state route and the pill; a write clears it.
- **Two tab types.** `diagram` (`priority: 'extension'`, one tab per diagram, patterns for
  `dsh-resource://diagram/session/**` and `.../library/**`) draws the picture at 80% of the pane with a
  25%–400% zoom ladder, pan, and a source drawer whose Apply re-validates like a model write. `diagrams` (the
  index, `sidebar://diagrams`, `priority: 'builtin'`) lists the conversation's diagrams and the library, with
  the one guide entry at `order: 40` (after Files 10, Editor 20, History 30), and a `tool.call.toolview` card
  per tool draws it inline.
- **Export** saves mmd/md/tex/pdf/svg/png to the **Desktop of the machine running the harness**,
  create-exclusively; the client names a format, never a path (a browser download is the fallback).

## How it plugs in

`cordis.patch.yml` inserts the `diagrams` row and patches nothing else. The routes are exact `connection.fetch`
paths with **GET/HEAD/POST only** —
`/api/dsh-diagrams/{health,state,diagram,artifact,export,render-report,vendor/mermaid.js}` — which is why the
engine is one self-contained file on one route (ETag, ~3.4 MB) and why every write, delete included, is a POST.
Two skills are registered at runtime from the package folder **and** copied by both installers into
`$DSH_HOME/skills` with a `.vncode-<package>` marker, so a person's own skill is never overwritten.

## Limits

- **State**: `$DSH_HOME/dsh-diagrams/sessions/<session>.json`, one atomic write per change, capped at
  **64 diagrams**, **256 KiB per source**, a **4 MiB source budget per conversation** (charged once on replace,
  checked on write AND patch, `BUDGET` on refusal) and a **16 MiB file cap**.
  `$DSH_HOME/dsh-diagrams/library.json` is the same shape for the whole harness.
- **Cache**: `artifacts/<sha256[0:24]>/{doc.tex,doc.pdf,doc.svg,doc.png,meta.json}`, keyed by engine + renderer
  + normalized source, LRU-pruned at **200 MiB**, **8 MiB** per artifact; a cache hit re-reads the verdict it
  was cached with.
- **Safety**: engines and converters spawn with an **argv array**, never a shell. TeX runs with
  `-no-shell-escape`, `MIKTEX_AUTOINSTALL=0` (a missing package fails fast rather than reaching the internet),
  `openin_any=p` / `openout_any=p`, a private temp cwd removed afterwards; `tectonic` is refused (it downloads
  packages). Bounded: **20 s** compile kill, **15 s** validator kill, **512 KiB** log, **2** validator
  children with a bounded queue, one compile at a time. **No network.**
- **Mermaid's render path is parse-first**: `parse()` before `render()`, `suppressErrorRendering: true`, a
  container the plugin owns, and a `finally` sweep — so a broken source is text, never an error picture.
- **Never a session event**: `dsh-session-persistence` refuses a log with a type outside
  `KNOWN_SESSION_EVENT_TYPES` unless the envelope is `ignorable`, which `Session.append()` cannot set. **Never a
  projection**: a unit needs `zod`, and this pack ships no npm dependencies.
- **TeX is optional**: without an engine TikZ stores and exports as `.tex`, and the UI says so. A panel edit
  writes back where the diagram already is, so a library diagram is not forked.
- **Not implemented**: host-side Mermaid rasterization (no SVG geometry in the stub; `jsdom` would break the
  zero-dependency rule).

## Verify

```sh
node scripts/checks/check-client-bundles.mjs   # tab types, seats, cards, the render path, verdicts
node scripts/checks/check-node-routes.mjs      # routes, tools, store, compile, export, drift, budgets
node scripts/checks/check-skill-examples.mjs   # every fenced skill example, parsed or compiled
```

`node packages/dsh-diagrams/vendor/build.mjs` rebuilds it from the pinned version; `--check` fails on drift.
