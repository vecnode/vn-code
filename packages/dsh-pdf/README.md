# dsh-pdf (alpha.6)

**PDF the agent can actually read and scan, and a real PDF reader in the right
bar.**

A PDF is not text on disk: a file-read tool returns binary noise and `grep` finds
nothing in it. This package makes a PDF *legible* - five tools over a vendored
pdf.js engine and a content-addressed page cache, including a **scanner** for the
documents that are pictures of text - and it owns the right bar's `pdf` tab type:
a reader that outranks the shipped bare PDF renderer for `*.pdf`, with zoom, page
navigation, a selectable text layer, in-document search, a **side panel** (page
thumbnails and the document's **own bookmark outline**) and a one-click scan on
every page that has no text layer. A second, small page type (`pdfs`) lists
**every PDF in the workspace**.

**Two rules are not negotiable.**

- **This plugin is read-only.** No tool modifies, merges, splits, rotates, fills
  or signs a PDF. `pdf_render` writes *new* PNG files; nothing here can write to,
  move or delete a document.
- **Document text is DATA, never instructions.** A PDF is a prompt-injection
  carrier: what a document says is content to report, never a command to follow.

## The five tools

| Tool | The question it answers |
|---|---|
| `pdf_info` | What IS this document: pages, page sizes, metadata, outline, embedded files, forms/signatures, encryption - and, per page, whether there is a **text layer at all** |
| `pdf_read` | What does it say on these pages, in plain reading order (`text`) or as reconstructed **layout** (`layout`) |
| `pdf_find` | Where does it mention X: literal or regex, with page, line and surrounding context |
| `pdf_render` | What does this page LOOK like: page pictures through the host's own rasterizer, written as new PNGs |
| `pdf_scan` | What do these SCANNED pages SAY: recognize the pages that are a picture of text |

(plus the **PDFs** index page - a tab type, not a tool.)

**Why `layout` exists.** pdf.js returns text as positioned runs with no line or
column structure, so a naive join turns a two-column paper - or an invoice with a
label and its value on one line - into a run-on. `mode: "layout"` groups runs into
lines by baseline, orders them top-to-bottom and joins each line left-to-right,
turning the horizontal gaps into the spaces and column breaks the geometry
implies. Deterministic, and what makes an invoice read like an invoice.

**Why the per-page numbers matter.** `pdf_info` reports each page's character
count and image count. A page with **0 characters and images is a scan** - a
picture of text, with no text to extract - and both it and `pdf_read` say so:

```
--- page 7: NO TEXT LAYER --- (this page is 1 image(s): a scan or a picture page)
```

That is the honest answer to "summarise this document" for a scanned file, and it
is what `pdf_scan` consumes.

## The scanner

`pdf_scan` recognizes the pages that are a picture of text. It is one pipeline,
shared by the tool and the reader's own "scan this page" action through
`POST /api/dsh-pdf/scan`, so what the model is told and what a person sees cannot
drift.

**With no `pages` it scans exactly the pages `pdf_info` found to have no text
layer** - the only pages where recognition beats reading. A page that already
carries text is never sent to OCR behind the caller's back: recognized text of a
page that already had real text is strictly worse than the real text. Pass
`pages` to scan a specific page anyway (to compare, or because its text layer is
unusable). **At most 10 pages per call**, and the answer names any it left.

**Two engines, neither bundled:**

| Engine | Why | If it is missing |
|---|---|---|
| a rasterizer - poppler `pdftoppm`, `mutool`, or Ghostscript | Node has no canvas, so the machine's own tooling draws the page | `pdf_scan` says which one to install; `pdf_render` needs it too |
| `tesseract` (+ language data) | the recognition itself | `pdf_scan` names it, and `pdf_info` reports it before you ever ask |

Both are probed from `PATH`, spawned with argv arrays only under a pinned
environment, and killed on a deadline. The engine set is **data**: each entry
declares its own `args({ image, lang, psm })` and its own `--list-langs` parser,
which is what lets a host without tesseract drive the whole pipeline in the
tracked check through a stub child process. The language list comes from the
engine's own `--list-langs`, so a language it lacks is refused *before* a page is
drawn.

**Every result is cached under every input that can change it.** The key is the
document's content hash plus page, language, raster resolution and
page-segmentation mode (`ocr/<n>.<lang>@<dpi>dpi.p<psm>.txt`), and the raster is
kept at `images/<n>@<dpi>dpi.png`. A second call is free; re-reading a page at
300 dpi for a table after 200 dpi for prose is a *new* recognition - which is what
`dpi` and `psm` are for.

**The answer is labelled a transcription, not extraction** - OCR misreads digits,
names, accents and punctuation and can drop a column, and the tool, the
conversation card and the reader's text panel all say so. In the reader a page
with no text layer says so under itself and offers **Scan this page**; the
recognized text appears beneath the page, headed with the engine, language and
resolution it came from.

## The reader

- **Continuous, lazy pages** - a canvas per page, drawn when the page nears the
  viewport (with a margin), sized by pdf.js so the scrollbar never lies.
- **An undrawn page reserves the document's OWN page box** (alpha.6) - page 1 at
  the current scale, never a viewport unit, because this reader is one pane of a
  dock. The box the fit divides by and the box a placeholder reserves are the
  same measurement, so the page column can never grow wider than the pane.
- **Zoom ladder** 50%-400% plus **fit width** / **fit page**. Zoom moves the
  LAYOUT, never a CSS transform, so a zoomed page stays scrollable to its edge.
  A fit is measured **synchronously** against the pane, so a resize lands in the
  frame the observer reports, and clicking the fit mode that is **already
  active** re-applies it instead of doing nothing (alpha.6).
- **Page navigation**: previous/next, a jump field, and the keyboard
  (`PageUp`/`PageDown`, `ArrowLeft`/`ArrowRight`, `Home`/`End`, `+`/`-`, `0`).
- **Rotate** 90 degrees; a rotation re-fits, because page and pane swap
  proportions.
- **Selectable text layer** - pdf.js's own `TextLayer`, positioned against
  `--total-scale-factor` with `--scale-round-x` / `--scale-round-y` (the
  variables pdf.js 6 reads, because its own math is
  `round(down, var(--total-scale-factor) * Wpx, var(--scale-round-x))`).
- **In-document search** with hit count and next/previous, highlighting by
  wrapping the matched substring in a `<mark>` inside the rendered spans - every
  span already has an absolute position and `white-space: pre`, so wrapping moves
  nothing.
- **Drag to pan** past fit, with a **grab** cursor measured from real overflow.
- **Honest failures**: a damaged file, a locked document (password prompt, held
  in memory for that tab only, never stored), an engine that will not start, a
  file the host refuses - each gets a sentence and a Retry.

The engine is **not** in the bundle - the harness reads every client bundle at
boot and pdf.js is 1.8 MB - so it and its worker are fetched from this plugin's
own authenticated routes on the first PDF and turned into blob URLs: a module
import for the engine, a worker URL for the render worker.

**Each open owns its own bytes** (alpha.5). pdf.js **transfers** the `data` buffer
to its worker, which **detaches** it, so the bytes of an open belong to pdf.js the
moment `getDocument` is called. The reader therefore caches no bytes at all: every
open reads `/file` again (`loadDocumentBytes`) and hands over exactly one buffer,
and the loading task - which owns the worker and the parsed document - is
**destroyed** when the tab unmounts, when the address changes, or when Retry
replaces it.

### The side panel

- **Pages** - a thumbnail rail. Each thumbnail is drawn when the rail scrolls it
  into view (`IntersectionObserver` rooted on the rail itself,
  `element.closest('.dpf-side')`), at 104 px wide, current page marked. Past
  **300 pages** the rail says so rather than drawing a thousand canvases; the
  page field and Find still reach the rest.
- **Bookmarks** - the document's own outline, resolved in the browser through
  `getOutline` / `getDestination` / `getPageIndex`, bounded to 200 entries and
  four levels. Clicking an entry jumps to its page; an unresolvable destination
  is shown disabled rather than dropped - a bookmark a reader can see but not
  follow is still information - and a document with no bookmarks says so.

## The workspace index

The tab strip's **+** / Start page lists **PDFs** (after Files, Editor, History
and Diagrams) - `sidebar://pdfs`, guide order 50. It shows every PDF in the
conversation's workspace with folder, size, modification date and, on request,
page count, and a row opens the document through the ordinary `openResource`
action.

It is backed by `GET /api/dsh-pdf/list`, and the walk is deliberately **timid**:
depth 6, at most 200 files, a skip-list of `node_modules` / `.git` / `__pycache__`
/ `.venv` / …, symlinks not followed, `.pdf` only. Page counts are **opt-in and
capped at 12 documents**, because a count means parsing the document - worth 12
files on a click, never worth doing for a directory nobody asked about. The index
lists; it never becomes a way to browse the machine.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-pdf` |
| `kind` | `pdf` |
| `patterns` / `priority` | `['*.pdf']` / `extension` |
| seats | keyed `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`, one `tool.call.toolview` per tool |
| services | `slots` + the bar's `sidebarRightTabs` (nothing else) |
| core rows disabled | **none** |
| npm dependencies | **none** |

Nothing is patched: the shipped preview stays mounted and this type **outranks**
it for a PDF address. The registry ranks by band (`extension` 3, `builtin` 2,
`fallback` 1), the preview claims `dsh-resource://file/**` at `fallback`, and
`canOpen` refuses anything but a `.pdf` - so every other file type keeps its
surface, and the editor (which already vetoes `pdf`) is unaffected.

### Addresses

- `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file grammar,
  so a click in the Files tab lands in this reader;
- `dsh-resource://pdf/absolute/<whole-path-encoded>` - this package's own shape
  for a document outside any workspace (a chat attachment, a file in Downloads).
  The ordinary grammar cannot carry a POSIX absolute path: it drops the leading
  slash and would silently point elsewhere. The whole path rides as ONE encoded
  segment.

## Routes

Exact paths only, GET/HEAD/POST only (the registry's vocabulary), behind the
connection's authentication. **Ten** registrations:

| Route | What it answers |
|---|---|
| `GET /api/dsh-pdf/state` | capabilities (incl. the OCR language list), cache facts, vendored version, caps |
| `GET /api/dsh-pdf/health` | the same snapshot, for the tracked checks |
| `GET /api/dsh-pdf/file` | one PDF's bytes for the tab (`?session=&path=`), content hash in `x-dsh-pdf-sha256` |
| `GET /api/dsh-pdf/list` | the workspace's PDFs (`?pages=1` adds counts, capped at 12) |
| `POST /api/dsh-pdf/scan` | the reader's "scan this page", on the same pipeline `pdf_scan` drives; a capability refusal answers 200 with `{ok:false, reason, message}`, because a missing engine is a fact about this host and not a bad request |
| `GET /api/dsh-pdf/vendor/pdf.min.mjs` | the vendored engine |
| `GET /api/dsh-pdf/vendor/pdf.worker.min.mjs` | the render worker |
| `GET /api/dsh-pdf/vendor/cmaps.json` | the CJK cMap tree as one base64 map |
| `GET /api/dsh-pdf/vendor/standard-fonts.json` | the base-14 font tree as one base64 map |
| `GET /api/dsh-pdf/vendor/wasm.json` | the image decoders (JBIG2 / JPEG2000 / colour profiles) as one base64 map |

The asset maps exist because the registry matches **exact paths only** - no
wildcard - so pdf.js's 169 cMaps, 16 standard fonts and 13 wasm decoders file by
file would have meant 198 registrations. One map per kind, fetched only when
pdf.js asks for an asset of that kind and decoded per entry by a
`BinaryDataFactory` (pdf.js 6's asset seam: `new Factory({ cMapUrl,
standardFontDataUrl, wasmUrl })` plus `fetch({ kind, filename })`) - which is why
`pdf.min.mjs` must have **zero static imports**, since it is imported from a blob
URL.

**alpha.4 is the factory-url repair, and it is the reason nothing opened.**
pdf.js validates **all three** factory parameters with its own URL check *before*
it reads a page, and it runs that check even when a custom `BinaryDataFactory` is
supplied - which is how this bundle loads *every* asset. A bare route was
therefore refused outright, with

```
Invalid factory url: "/api/dsh-pdf/vendor/cmaps.json" must include trailing slash.
```

and no document opened at all, scanned or not: the reader showed "This PDF could
not be opened" for every file while every `pdf_*` tool kept working, because the
host half (which passes the same URLs as real directory `file://` URLs, slash
included) never had the bug. What pdf.js demands is a slash-**terminated** string
that it never actually fetches, so the three values handed to `getDocument` are
now the route plus a slash, while the routes themselves stay bare - the registry
matches exact paths, so `.../cmaps.json/` is not a route, and the fetch these
constants feed must stay bare. Both halves are pinned: the source shape in
`check-client-bundles.mjs`, and in `check-pdf-node.mjs` the vendored engine's own
rule - a bare URL is still refused, and a two-page document actually opens - driven
with the URLs rebuilt out of the shipped client source, so the two cannot drift
apart again.

**The same release repairs the byte count.** pdf.js **transfers** the `data`
buffer to its worker, which **detaches** it, so `bytes.byteLength` read after
`getDocument` is 0 (`buffer.detached` is true - measured). The extraction child
took the length *after* the await, so every document was cached with
`"bytes": 0` and `pdf_info` printed `Size: 0 bytes` beside the correct size on
disk. The length is now taken while the array is still a view over real bytes,
and the size line falls through a stored zero to the size on disk
(`doc.bytes || doc.bytesOnDisk || target.size`), because the cache is
content-addressed and keyed only by SHA + engine version: entries written by an
older build survive the upgrade, and those are exactly the ones holding a zero.
`check-pdf-node.mjs` pins both halves - the printed size is the file's real
byte count, and an entry rewritten with `bytes: 0` still reads correctly.

**alpha.5 is the buffer-ownership repair, and it is why a document sometimes did
not open the SECOND time.** The `data` buffer pdf.js transfers is detached by the
transfer, and the reader used to remember the fetched bytes per address for the
life of the page - so the first open took the buffer and every later open of that
same document handed the worker a detached one:

```
Failed to execute 'postMessage' on 'Worker': An ArrayBuffer is detached and could not be cloned.
```

which is exactly what "This PDF could not be opened" was. It read as intermittent
because the *first* visit always worked and the second one never did: a **Retry**,
a password reopen, a tab closed and reopened, a remount, a second pane on the same
document, or the **Open tab** link on a document already open elsewhere. The
reader caches no bytes now, every open reads `/file` again and owns the one buffer
pdf.js is allowed to take, and the loading task is **destroyed** with the tab (it
owns the worker) - an open used to leak a worker thread and a parsed document for
the life of the page. A body that comes back **short** (the file changed while it
was being read) or **empty** gets its own sentence instead of pdf.js's "not a
readable PDF", which blamed the document for a race. Both halves are pinned:
`check-pdf-node.mjs` drives the vendored engine with ONE array twice (the second
hand-off fails - a `DataCloneError` in Node, the `postMessage` line above in a
browser) and with two fresh arrays, and `check-client-bundles.mjs` fails if a byte
cache or a missing teardown ever comes back.

**alpha.6 is the pane-sized page box, and it is why a page drifted right when the
panel was resized.** A page that has not been drawn yet - everything outside a
1200px band around the viewport, on any document long enough to have one - used to
reserve `minWidth: 45vw` / `minHeight: 60vh`. Those are units of the **window**,
and this reader is one pane of a dock: the right bar's width is a preference
(capped at 70% of the frame, 45% by default), so *half the window* says nothing
about the space a page has in it. `.dpf-pages` is `min-width: min-content` - the
rule that keeps a zoomed page scrollable to its edge - so a single placeholder
wider than the pane stretched the whole column past the pane, and
`align-items: center` then centred every page in a box wider than the pane: the
page slid right, its left margin became a visible gap, and its right edge left
the pane. Measured in Chrome against this file's own dress (a 700px pane, six
pages, one drawn), the old box and the new one:

| window | column (old) | gaps (old) | column (new) | gaps (new) |
|---|---|---|---|---|
| 1600px | 738px in a 685px pane | 44px left, right edge clipped | 685px | 17px / 17px, no overflow |
| 2500px | 1143px in a 685px pane | 246px left, 197px clipped | 685px | 17px / 17px, no overflow |

And since it was the window's width that moved the page, the symptom followed the
window and the panel width rather than the document - "only sometimes", and worse
the wider the window was. **The scale was never wrong**, which is why neither fit
button helped: they recomputed a page width that was already right, while the
column the page sat in was too wide. The box now comes from the document's OWN
page 1 at the current scale - one `unit` measurement that is BOTH the fit's
denominator and what an undrawn page reserves - so the column is the page plus
its padding and can never exceed the pane. The two small fallbacks (`140px` /
`180px`) apply only to the frame or two before page 1's box is known, and are
deliberately too small to widen the column.

**The same release makes a fit re-appliable.** `applyFit` awaited
`doc.getPage(1)` *inside* the `ResizeObserver` callback, and dragging a bar fires
dozens of those: the scale that stayed on screen was whichever promise resolved
**last**, not the one measured last, so a resized pane could keep a fit computed
for a wider one. It is synchronous now - the pane's width is a live measurement
and the unit is already in hand - and a fit mode clicked while it is ALREADY
active (`Fit width` on a reader already fitting the width) re-applies through
`chooseFit` instead of being a `setState` with the same value, which React bails
out of: the button that looked like the way out of a wrong fit was a no-op
exactly when it was needed. Both halves are pinned in `check-client-bundles.mjs`:
the placeholder is sized from the unit (and no `'45vw'` / `'60vh'` literal may
come back), the unit is measured once and handed to every page, and no `await`
may return to the fit callback.

## Vendored engine

`lib/vendor` is **generated** by `vendor/build.mjs` from `pdfjs-dist`, pinned to
**6.3.289 - the same build and version the harness's own preview ships**, so two
renderers in one page can never disagree about a document:

```
node packages/dsh-pdf/vendor/build.mjs           # rebuild (needs npm; installs into vendor/)
node packages/dsh-pdf/vendor/build.mjs --check   # drift check, part of the tracked checks
```

| Vendored | Why |
|---|---|
| `legacy/build/pdf.min.mjs` | the engine, used by BOTH halves - the legacy variant is the build pdf.js documents for Node, and the minified file serves the browser unchanged |
| `legacy/build/pdf.worker.min.mjs` | the browser's render worker |
| `cmaps/` (169 files) | CID-keyed CJK documents, which extract as replacement characters without them |
| `standard_fonts/` (16 files) | documents relying on the base-14 fonts without embedding them |
| `wasm/` (13 files) | **JBIG2** (what faxes and many scanners produce), **OpenJPEG** (JPEG2000) and **qcms** (ISO colour profiles). Without them an exotic scanned page draws blank or partial - the worst failure for a reader, because it looks like the document. `quickjs-eval.wasm` rides along unused, since `isEvalSupported: false` is set on both halves |
| `LICENSE` (+ the decoders' own) | pdf.js is Apache-2.0 and the bundled decoders carry theirs; the licenses travel with the bytes |

`lib/vendor/VERSION.json` records every file's bytes and sha256 plus a digest per
tree, and `--check` recomputes all of it. The tree's TEXT files are pinned to LF
in `.gitattributes`, because `--check` hashes those bytes and a Windows checkout
would otherwise report phantom drift (the license files live *inside* the hashed
trees, so converting them would change a tree digest too).

## How a document is read

1. **Identity is content.** The SHA-256 of the bytes (streamed in the parent,
   memoized per `path + size + mtime`) names the cache entry, so an edited file
   can never serve a stale answer and one document read from two conversations
   costs one parse.
2. **One child process per extraction** (`lib/extract.mjs`), argv only, a 25 s
   deadline, a 512 MB heap ceiling, an 8 MiB output cap. A PDF is untrusted input
   handed to a large parser, and the worst case must be a reported failure - never
   a host that stops answering.
3. **The cache answers first.** `$DSH_HOME/dsh-pdf/artifacts/<sha256>/` holds
   `index.json` (document facts), `stats.json` (per-page numbers, merged as pages
   arrive), `pages/<n>.json` (one page's text in both modes), the rasters and the
   OCR results. `pdf_read` after `pdf_find` is free; it is disposable and
   LRU-pruned at 512 MiB.

Hardening inside the child: `isEvalSupported: false` (embedded JavaScript is
never evaluated), `useWorkerFetch: false` and no URL fetching anywhere (a PDF
cannot make it reach the network), `enableXfa: false`, `useSystemFonts: false`,
`disableFontFace: true`, cMaps and fonts as `file://` URLs.

## Path policy, stated

- A **session-relative** path is resolved inside the conversation's workspace with
  `realpath` on both sides, so a symlink pointing out is refused, not followed.
- An **absolute** path is read directly - the door a chat attachment
  (`<DSH_HOME>/attachments/v1/files/<xx>/<sha>/<name>.pdf`) and a file in
  Downloads come through.
- Either way the target must be a regular `.pdf` inside the size ceiling (512 MiB
  for the tools, 256 MiB for the tab). This never becomes a general "read any file
  on this machine" route, and every request is authenticated.
- `pdf_render` writes create-exclusively under a name **this plugin generates**
  (`<name>-page<N>-<dpi>dpi.png`, `-2`, `-3` on collision) into a directory the
  caller names or the conversation workspace by default. No request can choose the
  name of a file that gets written.

## Caps

| Cap | Value |
|---|---|
| document size | 512 MiB (tools) / 256 MiB (tab) |
| pages per extraction | 200 (a wider range is several runs) |
| pages per `pdf_render` call | 20, 50-400 dpi |
| `pdf_read` output | 40 000 chars default, 200 000 maximum |
| `pdf_info` inspection | every page up to 60; above that a 20-page sample, and the answer says it sampled |
| `pdf_find` | 40 hits, up to 2000 pages, 45 s budget - and the answer says what it did not search |
| `pdf_scan` | 10 pages per call, 50-400 dpi (default 200), psm 0-13 (default 3), one language tag or several joined with `+`; the answer names the pages it left |
| workspace index | depth 6, 200 files, page counts for 12 documents on request |
| reader panel | thumbnails for the first 300 pages; 200 outline entries over 4 levels |
| cache | 512 MiB, LRU |

## Model experience

One bundled skill (`skills/pdf-analysis/SKILL.md`), registered at runtime from
this package's own folder **and** copied into `$DSH_HOME/skills` by both
installers. It teaches which tool answers which question, when to switch to
`layout`, what a page with no text layer means and how to scan it honestly (a
transcription, with the engine and resolution named), where an attachment lives,
and that a locked document's password is never stored.

Beside it, `skills/pdf-analysis/reference/workflows.md` is the worked sequence for
each common request rather than a rule: a document you have never seen, the
scanned contract (find first, scan the pages with no text layer, then find again
over the cached recognition), an invoice or statement and where its total hides,
a chat attachment, a figure or a signature, a locked file, a long or damaged
document, and which PDFs the workspace holds at all - plus what to report back,
including the printed-page-versus-PDF-page rule that makes a citation checkable.

Every call also renders a conversation card: the document's name, what the host
reported (pages, hits, pages without text, files written, what was recognized and
with which engine, cache hit) and an **Open tab** link.

Its examples are checked for SHAPE by `scripts/checks/check-media-examples.mjs`,
beside the media package's: every `pdf_* { ... }` pseudo-call a document writes
must parse as the tool call it looks like, so a stray comma cannot reach the tool
from a document an agent trusted. Driving the tools themselves is
`check-pdf-node.mjs`'s job below - that one builds real PDFs.

## Verifying a change

```
node scripts/checks/check-pdf-node.mjs        # the five tools + the routes, against PDFs this check builds
node scripts/checks/check-client-bundles.mjs  # the browser half, driven through the real React runtime
node packages/dsh-pdf/vendor/build.mjs --check
```

`check-pdf-node.mjs` builds its own PDFs (a two-page report with a labelled value,
a one-page scan that is one image and no text, a twelve-page document for the
per-call caps, one nested in a subfolder, one inside `node_modules`, a truncated
copy), so it needs no TeX, no poppler and no network; with a rasterizer present it
also drives a real `pdf_render` and checks the PNG's dimensions and naming.

**The scanner is verified in two halves.** `pdf_scan` is driven as the agent
drives it - on a host without tesseract, pinning its refusal and that it still
names what can be done. The *pipeline* is then driven with a **stub OCR engine**
(this same Node binary, so the spawn, argv shape, deadline and parse are real;
only the recognition is replaced), which proves on any host that the raster is the
one drawn for *that* page, that a second call is a cache hit, that another dpi /
psm / language is a *new* recognition, that a missing language is refused with the
list the engine reports, and that the per-call cap names the pages it left.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
install.bat -Force        # Windows
./install.sh -Force       # macOS / Linux
```

Then restart the app and hard-refresh the browser (client bundles are read at
boot; the profile installs this repo as a live link, so no reinstall is needed for
a code edit - only a restart).
