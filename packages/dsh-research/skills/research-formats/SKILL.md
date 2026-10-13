---
name: research-formats
description: Hand a research run over as a file — read `rs_open action=capabilities` for the formats this build writes, choose between `md`, `docx`, a self-contained `html`, the `ris`/`bib`/`enw` library exports and `tex`, pick `draft=watermark` while working or `draft=clean` to hand it over, and read `build/build.json` for what was built from which bytes. Use when a document is finished enough to leave the run, when a citation style or an export has to be chosen, or when a build refuses.
whenToUse: When a run's document has to become a file somebody else opens — a submission DOCX, a page for a reader who has no Word, a bibliography for Zotero, EndNote or pandoc — when the citation style must be overridden for one build, when `draft=clean` refuses, or when the question is "what exactly did I hand over?".
---

# The last mile: which file, and what it will look like

A build turns the run's document and its two ledgers into files. It is not a check of
the document: a build can succeed on a sentence nothing has read. This is the skill
that says which file leaves the run, and the one that must not let a clean build be
mistaken for a verified one.

## Ask what this build writes — never carry the list in your head

`rs_open action=capabilities` is the authority: it names the formats this build can
write and the six citation styles it renders. Formats and styles arrive over time, so
a list remembered from a previous session is the one thing guaranteed to go stale.

```text
rs_open action=capabilities
```

What each format is FOR, so the right file leaves the run:

- **`md`** — the reader-ready source. Citations resolved by the style, the reference
  list computed from the ledger, and in a draft the claim endnotes visible as
  footnotes. Read this one yourself, and hand it to anything that reads Markdown.
- **`docx`** — the submission. A real Office document built from the *same* Markdown
  by this package's own OOXML writer: no process is spawned, no engine is looked for
  on PATH, and two builds of one run are byte-identical. That determinism is what
  makes a diff of two DOCX builds mean something.
- **`html`** — one self-contained page: the CSS inline, so no stylesheet URL, no font,
  no script and no remote image. For a reader who has no Word, and for printing from a
  browser on a machine with no network.
- **`ris` / `bib` / `enw`** — the run's whole LIBRARY, not only the part this draft
  cites, in formats Zotero, EndNote and pandoc import. A complete export someone
  prunes is more useful than one they have to reconstruct — and `rs_cite
  action=import` reads those exports back, so a library can move both ways.
- **`tex`** — writes `paper.tex` and prints the command that compiles it. Nothing is
  run here: a `.tex` is for a machine with its own LaTeX toolchain, and the build
  answer says what to run.

`format=all` writes every format this build has, in one call, from one parse — so a
sentence, a citation or a footnote cannot be in the `.docx` and missing from the
`.html`. A format that is advertised but not implemented in your build refuses by name
(`FORMAT_NOT_YET`), which is the answer that names what it *can* write, and writes
nothing.

## Six styles, and a reference list you never type

The run's style is recorded at `rs_new` (`style=`) and overridden for a single build
with `rs_build style=` — that is how one run is submitted to two journals without
re-citing anything. What the style decides:

- **APA 7, Chicago author-date, Chicago notes, MLA 9** sort the list alphabetically;
  **IEEE and Vancouver** number it in citation order.
- **Chicago notes** is the one notes style: its citations are footnotes rather than
  parentheticals, so the sentence stays unbroken and the reference list still stands.
- The list is headed by the style's own **`referenceHeading`** — `Works Cited` is not a
  synonym for `Bibliography` — and the DOCX and HTML writers use that heading to find
  where the bibliography starts, so an entry after it keeps its hanging indent.

**The reference list is computed from the ledger, never typed.** There is nowhere to
put a citation by hand, and a hand-edited built file is overwritten by the next build.
So a missing field in a source record is a missing field in the bibliography: the fix
is `rs_cite` again with the field, not a sentence added to the artifact.

## Two drafts, and the difference is the whole point

`draft=watermark` (the default) **always builds**. It writes a banner at the top and an
endnote on every claim naming its status and the rung it reached, so a half-checked
document cannot be read as a finished one. Use it while you are still working, and to
show someone what the run currently says.

`draft=clean` is the mode whose output looks finished, so it is the one that refuses —
for exactly three reasons, each with its own code:

- the document and its ledger disagree (`BUILD_BLOCKED`, and the message names the
  structure code and the claim, e.g. `span-unrecorded`);
- a claim a check found `unsupported`, `contradicted` or `misattributed` is still in
  the text (`BLOCKING_CLAIMS`);
- a person has not answered gate `g3-integrity` (`GATE_UNANSWERED`) — this call opens
  that gate, and only the person answers it, in the Research tab.

**Say which of the three it was, and what would clear it — then stop.** Retrying the
same call changes nothing, and answering the gate yourself is the one thing this
plugin refuses to let a model do.

## One run, built twice

`format=all` as a draft, then the clean build for hand-over:

```text
rs_build slug=sleep-memory-review format=all draft=watermark
```

```text
Built sleep-memory-review (watermark, apa7)
- document: sections, 27 words
- claims: 1 (1 unverified)
- sources: 2 in the ledger, 1 cited, 1 with text
- structure: agrees with the ledger
- note: the outline names `synthesis`, which has no file in doc/sections/

Files:
  build/paper.md  860 B  sha256 d491860e3045…
  build/references.ris  430 B  sha256 244f8c30a0dd…
  build/references.bib  496 B  sha256 ed9f0fe42ae3…
  build/references.enw  370 B  sha256 34cfdc38f1d3…
  build/paper.docx  4.9 KiB  sha256 9895a1c4b2ed…
  build/paper.html  2.8 KiB  sha256 ebe6dbfcc104…
  build/paper.tex  1.4 KiB  sha256 6f977c7915a5…
  build/build.json  (the report above, stored)

This is a DRAFT: the banner and the endnotes are what say so. `draft=clean` needs the
document and its ledger to agree, no unsupported claim, and gate `g3-integrity`
answered - it is waiting in the Research tab.
```

A `- note:` line is not a failure: that one is the outline warning about a section with
no file. Errors are separate, and they are what block a clean build.

```text
rs_build slug=sleep-memory-review format=docx draft=clean
```

```text
Built sleep-memory-review (clean, apa7)
- document: sections, 27 words
- claims: 1 (1 unverified)
- sources: 2 in the ledger, 1 cited, 1 with text
- structure: agrees with the ledger
- note: the outline names `synthesis`, which has no file in doc/sections/
- note: docx line 9: a raw HTML comment is not Markdown this writer renders

Files:
  build/paper.docx  4.6 KiB  sha256 bbef034114c4…
  build/build.json  (the report above, stored)
```

The second build is smaller than the first **on purpose**: `clean` removes the banner,
the claim markers and the endnotes. Note also that a clean build still says
`1 unverified` — it is not a claim that the content was checked, only that nothing in
the document contradicts the ledger.

And the refusal, which is the reason to read the ledger before asking for `clean`:

```text
Refused (BUILD_BLOCKED): a clean build needs a document that agrees with its ledger,
and these do not: span-unrecorded (claim c0999 is marked in the document but has no
ledger row - it is tracked by nothing). Build with draft=watermark to read the draft
anyway.
```

## `build/build.json` — what was handed over, on disk

Beside every artifact, and readable with `rs_read what=build`, it records the format,
the draft mode, the style, the document's source and word count, the **sha256 of the
assembled document**, the claim counts by status at that moment, the source counts,
the structure verdict, and every output's path, bytes and sha256. That is what makes
"which claims had been checked when this file went to the reviewer?" a question about
the folder rather than about anyone's memory.

Two honest limits: it is written fresh by each build, so it describes the *most
recent* one — and after `format=all` it holds the last format's report. The `Files:`
list in the build answer is the complete record of an `all` build; the report beside
the artifacts is not.

## When this build's output is not what is wanted

Both escape hatches keep the ledger as the source of truth:

- **A house citation style this package does not implement** is not a rewrite. Every
  style's list is available as `references.bib`, which Zotero, EndNote and pandoc all
  read: run pandoc with the journal's own CSL file over the exported `.bib` and the
  `.md`, and the bibliography is in their style. Nothing in the run has to change.
- **A LaTeX submission** gets `paper.tex` plus the command to compile it, on a machine
  that has the toolchain. This plugin runs no engine and looks for none.

## The DOCX limits, stated rather than discovered

Say these before promising a DOCX meets a submission rule:

- **IEEE is single column.** The two-column layout is not emitted; a two-column page
  built without the rest of that template's rules would be worse than an honest
  single-column one.
- **Page setup is Letter with 1-inch margins for every style** (APA 7 pins exactly
  that; the other styles pin none, so it is a deliberate uniform choice).
- **A construct outside the Markdown subset is REPORTED with its line number, not
  dropped** — nested emphasis inside emphasis, list nesting past one level, indented
  code, setext headings, raw HTML. So when the build report names a line, the artifact
  is missing something: **fix that sentence in the document and build again**. Accepting
  the file is accepting a document nobody has seen.

## Before you say the file is ready

Run `rs_verify action=report`, and say which rungs reached what. A clean build is not a
check of correctness: it means the document agrees with its ledger, that no claim a
check found unsupported is still in the text, and that a person said the run had been
checked as far as they need it. It says nothing about whether a source exists or a
sentence is true — `r1-record` is provenance, and `r2`/`r3` only ask whether the stored
words are there and whether they support the sentence as written.
