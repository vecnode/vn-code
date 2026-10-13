---
name: research-sources
description: Get literature into a research run when the plugin fetches nothing — fetch the source yourself with web_fetch / web_search or take a file the person already has, READ it with the pdf_* tools or ocr, then ingest record and text together with rs_cite, bind locators, and cite with [@key]. Use when a run needs sources, when a library export has to come in, when a citation key is unknown, or when a claim cannot be checked against a source.
whenToUse: When a research run needs a source ingested, a PDF or a Zotero/EndNote/PubMed export brought into the ledger, a citation key looked up, or a claim's quote located; when `rs_cite` is the tool at hand.
---

# Where literature comes from

`dsh-research` has **no client**. It resolves no DOI, searches no database and
downloads no PDF. That is a feature and not a gap: retrieval happens once, through
the harness's own `web_fetch` / `web_search` under a policy the person already
trusts, and what comes back is a file that **stays put** — hashed, stored in
`sources/`, and citable from any later session. The plugin's job is the record,
not the fetching.

So the chain is always: **you fetch → you read → `rs_cite` ingests**.

## Fetch it, or take the file the person has

- `web_search` to find it, `web_fetch` for a page or a DOI landing page. Provenance
  is `crossref` / `arxiv` / `publisher` when you took the record from a metadata
  page, and `agent` when you typed it.
- Or the person already has it: a download, a chat attachment, a Zotero/EndNote
  export, a PDF in `~/Downloads`. `rs_cite`'s `file` takes an absolute path, or one
  relative to the workspace — a relative path is resolved against the session's own
  working directory.

Either way it becomes a real file with a sha256, which is what makes a quote
checkable a month later.

## Read the document before you cite it — this is the habit that matters

`rs_cite` extracts nothing itself. Read the PDF with the `pdf_*` tools
(`pdf_analysis` is the skill), a scan with `ocr`, and hand what they return to
`rs_cite` as `text=`. Two reasons, and the second is the one that bites:

1. The text is stored under `sources/<sha256>.txt`, so a later check can search a
   quote without opening the PDF again.
2. **A source with no text cannot pass the rung that locates a quote.** The answer
   says so in as many words — the plugin prints *"no text stored: read the source
   with `pdf_read` (or `ocr`) and pass what it gives you as `text=`. This plugin
   extracts nothing itself"*. An agent that skips this step builds a run whose
   claims can **never be checked**, and nothing will say so until someone tries.

Read it before writing the claim, not after. The quote you need is in the text,
and you do not know it until you have read it.

## The ingest call, and why the answer counts fields

```text
pdf_read path="C:\Users\ana\Downloads\walker2020-sleep.pdf" pages="1-2"
```

```text
rs_cite slug=sleep-memory-review action=add source=publisher
  file="C:\Users\ana\Downloads\walker2020-sleep.pdf"
  record={ "kind": "journal-article", "title": "Cognitive consequences of sleep
    deprivation", "authors": [{ "family": "Walker", "given": "Matthew P." }],
    "year": "2020", "container": "Annual Review of Psychology", "volume": "71",
    "pages": "245-269", "doi": "10.1146/annurev-psych-010419-050838" }
  text="<the text pdf_read returned>"
```

```text
Source walker2020cognitive is in the ledger
- title: Cognitive consequences of sleep deprivation
- fields with a named origin: 8 (8 from a source you named, 0 supplied by hand)
- file: walker2020-sleep.pdf  412 KB  sha256 9f2c1a77b0e4…  (from C:\Users\ana\Downloads\walker2020-sleep.pdf)
- text: 61240 characters from publisher (coverage not reported)
- MISSING: container - a reference list cannot be complete without it

Next: cite it as `[@walker2020cognitive]` and bind it to a claim in `rs_write`.
```

The count is the point: **each field records where it came from**, and the answer
splits *named origin* from *supplied by hand* because the hand-supplied fields are
the ones that can be wrong. `provenance={"pages": "author"}` overrides one field
when it came from somewhere else. Omit `source` and everything counts as `agent`,
which is honest and is also a warning you should read. A field the ledger has no
origin for cannot be audited at all — so never hand-type a field you did not read
off the source.

## Locators: what a check can actually search for

A claim binds its sources as `{ key, locator }`, and two locator kinds carry all
the weight:

- `{ "kind": "quote", "quote": "the words, exactly as the source has them" }` —
  this is what a locate check searches for in the source's own text. It is the
  strongest thing you can write, and it must be **verbatim**; a paraphrase is a
  quote that will not be found.
- `{ "kind": "page", "page": 7 }` — where a reader (and a check) expects to find
  it. Pair it with a quote when you can.

`section`, `table`, `figure`, `paragraph` and `timestamp` are also kinds
(`LOCATOR_KINDS`), and they are exactly right for a book chapter, a data table, a
figure, or a talk recording. Recorded, a human can follow them; they are not
searchable, so a claim whose only locator is one of those cannot reach the locate
rung, and the answer says `(no locator)` rather than pretending.

## A library export is the fastest honest path

`rs_cite action=import file=…` adds **every** record in one call, reading RIS,
BibTeX, MEDLINE (`.nbib`) and EndNote (`.enw`). This is the move when the person
already has a reference manager: their library is already curated by a human, and
re-typing it is where invention starts.

```text
rs_cite slug=sleep-memory-review action=import file="C:\Users\ana\Desktop\library-export.ris"
```

```text
Imported 214 record(s) from C:\Users\ana\Desktop\library-export.ris
- new or changed: walker2020cognitive, rasch2007sleep, stickgold2005sleep, …
- already in the ledger unchanged: (none)

Next: cite them in the text as `[@key]` and bind them to claims in `rs_write`.
```

What each format cannot carry — the losses, so you know what to re-check:

| format | what it cannot bring |
|---|---|
| `.ris` | no tag for a preprint or a standard: those read back as `report` / `journal-article` |
| `.bib` | no entry for a `dataset` or a `standard` (they become `@misc`); title braces are dropped, so `{NASA}` reads back as `NASA` |
| `.nbib` | indexes journal articles only — every record it yields is a `journal-article` |
| `.enw` | carries no access date, so a web source's `accessed` is lost |

Import stores **records only** — no bytes, no text. An imported source still needs
its PDF read and attached (`rs_cite action=add ... file=… text=…`) before a quote
in it can be located. An empty import is a refusal (`REFS_EMPTY` naming the four
formats) rather than a silent zero.

## Keys are the address, and the ledger owns them

The key is what `[@key]` names, so it is lowercase letters, digits and dashes, and
`rs_cite` suggests one from author + year + title words
(`walker2020cognitive`) unless you pass `key=`. `import` re-normalises the keys
the exporter used (`Walker_2020:Cognitive!` becomes `walker2020cognitive`), so
**always read the answer and cite the keys it reports, not the ones you expected**.
`rs_cite action=list` shows every key with its kind, year, bytes and text;
`action=get key=…` shows one.

`rs_write` refuses a citation the ledger cannot resolve and offers the nearest keys
(`UNKNOWN_CITATION`), and refuses a citation-shaped bracket that does not parse
(`BROKEN_CITATION` — a citation must be the whole bracket: `[@key]`,
`[@key, p. 7]`, `[@a; @b]`, and `[-@key]` to suppress the author). Both refusals
are the ledger stopping a citation with nothing behind it from reaching the prose.

## Never invent a source

Not a DOI, not a page number, not a year, not a quotation. If it is not in
`sources.jsonl` it does not exist for this run, and the build will say so by name:
`unknown-source` is an error that blocks a clean build. A field you could not read
is a field left empty — the answer reports it under `MISSING:`, and that is a
finding, not a failure. Fixing a reference is one more `rs_cite action=add` with
the corrected field; the ledger appends a revision rather than editing history.
