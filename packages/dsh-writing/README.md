# dsh-writing (alpha.3)

**A page you write on and a workbook you edit, in the harness's own surfaces.**
The **Writing** tab sits in the chat panel's view ring to the right of Canvas;
the **Sheet**, **Headings** and **.docx** panes live in the right bar. Documents
are kept by this plugin, files are real files in the conversation folder, and
**nothing in this package renders Office** — "Proof" hands a written file to the
shipped preview, which is where the harness's own LibreOffice does the rendering
and the computing.

## It edits like a word processor

- **The page fills and the text continues on the next one.** A paragraph that
  reaches the bottom margin is broken at a LINE boundary and continues across the
  page: the fragments of one block tile it exactly, so the model never holds half
  a paragraph and an edit inside any fragment is spliced back at its own offset.
  Only a single LINE taller than a whole page is left overflowing, and it is
  marked when it is.
- **Selection is the browser's own** — drag across paragraphs and across pages,
  Shift+click, double-click for a word, triple-click for a paragraph, Shift+arrow
  to extend — and **Ctrl+A selects the whole document**, not one paragraph,
  because a page-broken paragraph is several elements and the browser's own Ctrl+A
  would stop at the first.
- **The keyboard walks the document.** Down leaves the last line of a paragraph for
  the next one, and the bottom of a page for the top of the next; Up does the
  reverse; Right leaves the end of a block for the start of the next; Home and End
  work per visual line inside a block. Enter splits, Shift+Enter is a soft break,
  Backspace at the start joins the block above (or removes the page break in front
  of it), Tab inserts a tab, Ctrl/Cmd+B/I/U are the marks, Ctrl/Cmd+S saves — and
  a mark applied to a selection that spans paragraphs or pages applies to every
  range it covers.
- **Paste lands as paragraphs.** The clipboard's text is cut into paragraphs and
  inserted as real blocks around the caret, instead of one paragraph with the
  source's markup inside it.
- **New is one dialog and one keystroke.** It is the leftmost control on the bar:
  it opens the tab's own dialog (never the browser's prompt), the suggested name is
  selected so typing replaces it, **Enter creates the file and the dialog is gone**,
  and Escape or a click outside closes it without creating anything. The menu it was
  chosen from closes with it.

## What it adds

- **A page, not a text box.** A4/Letter, portrait or landscape, four margins in
  millimetres, and a sheet number under every page.
- **A grid, not a table of text.** `writing-sheet` is a real spreadsheet pane:
  addressed cells (`A1`, `AB10`), a keyboard that walks the grid (Enter down, Tab
  right, arrows, Ctrl+S), sheet tabs with add/rename/remove, a `+20 rows` growth
  step, and up to 200 x 78 cells per sheet and 12 sheets per workbook.
- **Formulas are kept, never computed here.** A cell typed as `=SUM(B2:B3)` rides
  in the file as `<f>` with **no cached value**, beside
  `<calcPr fullCalcOnLoad="1"/>` — so LibreOffice and Excel compute it, which is
  what `check-writing-node.mjs` proves by handing a workbook it wrote to the
  harness's LibreOffice and getting a PDF back. A second formula engine would be a
  second answer to the same question.
- **Documents AND files, and the difference is stated.** **New** is the leftmost
  control on the bar: it writes a real `.docx` or `.xlsx` into the conversation
  folder, or starts a page kept in this conversation. Documents live in this
  plugin's own store (`$DSH_HOME/dsh-writing/sessions/*.json`, the `dsh-diagrams`
  shape, plus `library.json` for published ones); a file in the conversation folder
  is *linked* through `origin`, **Save** writes the store copy and then the file
  atomically, and a file that moved on disk answers **409 CHANGED_ON_DISK** with
  Reload / Keep-mine rather than being clobbered. Export takes a `-2`, `-3` name,
  so a copy never overwrites the original.
- **The `.docx` codec, both directions, no dependencies.** `lib/zip.js` (ZIP over
  `node:zlib`, CRC-32, typed refusals for ZIP64/encryption/corruption),
  `lib/xml.js` (an OOXML-shaped reader — no DTDs, no entity expansion),
  `lib/ooxml.js` (parts, styles, numbering, `w:sectPr`, fonts and sizes out and
  back). Reading a real Word file reports what the model cannot hold — tables,
  images, footnotes, endnotes, fields, equations, comments, tracked changes,
  content controls, links — as counted losses the tab shows BEFORE a save that
  would drop them.
- **Fonts: every family the machine has.** `lib/fonts.js` walks the platform's font
  directories and reads each file's `name` table in pieces (a 37 MB collection
  costs the same as a 300 KB face). The toolbar offers them in a `<datalist>` that
  filters as you type, a size box in points (half-point granularity, because that
  is what `w:sz` carries), and a **Document font / Document size** pair in the Page
  menu for what every run inherits. A run that says what the document already says
  carries neither, which is what makes "change the document font" one write instead
  of hundreds. On the machine this was built on: **234 families from 486 files,
  none unreadable**.
- **Headings, twice.** A **Headings** panel inside the Writing tab (indented by
  level, click to jump, the active one highlighted) and a **Headings** pane in the
  right bar showing the outline of whatever document the tab has open — for a
  workbook, its sheets.
- **The right bar, three pane types.** `dsh-writing` claims `.docx` (editable,
  where the shipped preview keeps every other file), `dsh-writing-sheet` claims
  `.xlsx`, and `dsh-writing-outline` is the navigator. Each carries a guide entry
  for the "+" page. Claiming `.xlsx` means an `.xlsx` opened from Files lands in
  the GRID rather than in the shipped preview's spreadsheet view — deliberately,
  because the point is to edit it, and **Proof** renders it with that same preview
  in one click.
- **Proof is core's LibreOffice.** The button writes the file and hands its address
  to the shipped document preview (whose kind is read out of the tab registry,
  never hardcoded), and that preview converts and paints it. The tab composes the
  file; core shows what LibreOffice makes of it.
- **Import** `.docx`, `.xlsx`, `.md`, `.txt`; **export** `.docx`/`.xlsx`, `.md`,
  `.txt`. `.doc`, `.odt`, `.rtf`, `.xls` and `.ods` are refused WITH the way out
  ("open it in LibreOffice or Word and save it as .docx"), because that is a real
  answer and "unsupported" is not.
- **Keyboard**: Enter splits a block, Shift+Enter is a soft break, Backspace at the
  start joins the previous block (or removes the page break in front of it), Tab
  inserts a tab, Ctrl/Cmd+B/I/U are the marks, Ctrl/Cmd+S saves. A mark with NO
  selection applies to the whole block and the status bar says so.
- **Autosave** after 4 s of quiet, plus one last attempt when a tab closes.

## How it plugs in

| Piece | Value |
|---|---|
| row | `writing` (one inserted row; no core row disabled, no fork, no vendored engine) |
| tab | `conversation.view` id `writing` at `order: 30` — right of Canvas (20), Trajectory (10), Chat (0) |
| panes | `sidebar.right.pane.tab` keys `dsh-writing` (.docx), `dsh-writing-sheet` (.xlsx), `dsh-writing-outline` (headings) |
| state | `$DSH_HOME/dsh-writing/sessions/<session>.json`, `$DSH_HOME/dsh-writing/library.json` |
| client services | `slots`; `sidebarRight` and `sidebarRightTabs` are resolved LAZILY, so the tab works with the right bar unmounted |
| checks | `check-writing-node.mjs`, and the `dsh-writing` section of `check-client-bundles.mjs` |

Routes are exact paths, `GET`/`HEAD`/`POST` only, all behind the harness's session
auth:

| Method | Path |
|---|---|
| `GET`/`HEAD` | `/state`, `/document`, `/outline`, `/fonts`, `/page.js` (the page breaker, imported from a blob URL) |
| `POST` | `/document`, `/delete`, `/publish`, `/import`, `/export`, `/create-file`, `/save-file`, `/open-file` |

The workspace root is resolved on the host from the live session header, else from
session persistence — the lookup `@deepseek-ai/dsh-api-workspace-files` does — and
every path is realpath-checked inside it. The client names a session and a relative
path, never a root.

## Limits

- **No undo stack of its own.** Ctrl+Z is the browser's, per element, and a
  structural re-render (Enter, a mark, a page setup change) clears it. That is the
  honest state of it, and the next thing worth building.
- Every page break falls where a LINE actually ends, because the lines are
  measured in the browser — and for a paragraph longer than 2400 characters the
  remainder of that paragraph is placed by estimate, so the break in it can be a
  line out. Headers, footers and section breaks beyond the first are not
  represented.
- The spreadsheet has no cell formatting, number formats, borders, merged cells,
  column widths, sorting or charts; reading a file that HAS them reports them as
  counted losses rather than silently dropping them. Formulas are never evaluated
  in the tab.
- The page reader does not read `.doc`, `.odt` or `.rtf`; the workbook reader does
  not read `.xls` or `.ods`.
- Budgets: 64 documents a conversation, 512 KiB a document, 4 MiB a conversation,
  4000 blocks, and a workbook's 12 sheets of 200 x 78 cells.
- The page is white paper in both app themes on purpose: a sheet of paper is white
  in a dark room too.

## Verify

```
node scripts/checks/check-writing-node.mjs
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

`check-writing-node.mjs` ends with the claim that matters: it writes a `.docx` and
a `.xlsx` with this package, hands both to the pinned
`@deepseek-ai/libreoffice-kit` and asserts LibreOffice opens them — with the
document's page break producing exactly one more page than the same document
without it, and the workbook's formula cell surviving to a PDF. Without the kit on
the host that section skips loudly. It also reads a **synthetic TrueType font**
built in the check itself, so the font reader is proven without depending on what
this machine happens to have installed, and it drives the page breaker with
**synthetic line data** — splitting a sixty-line paragraph across pages and
asserting that the fragments tile it with no gap, no overlap and nothing lost.

There is **no Chromium check yet**, and it matters more now than it did: the
page-surface layer (`pagesElement`, `blockElement`, `sliceRuns`/`replaceRange`,
`SheetView`, the grid's cell arithmetic, the dialog and the menu rule) is driven
through pure functions plus static renders, but **the line measurement itself is
browser-only code** — it walks the laid-out text asking which line each character
is on. It is written to fail soft (no line data means the older block-level rule,
and nothing is ever lost), and it is the one part of this package a real browser
has to prove. That gap is stated here rather than hidden.

## Install

The launcher (`scripts\install.bat` / `./scripts/install.sh`) auto-discovers the
package as a standard `dsh.bundle`, and the uninstall twins do the same. It is a
live link in the web profile, so a bundle edit needs a hard refresh; a change to a
row (or a new package) needs a restart of `npx @deepseek-ai/dsh web`.
