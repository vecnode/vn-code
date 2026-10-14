# dsh-research (alpha.4)

**Research as a folder the agent fills and the right bar shows — and that you keep,
open in any session, and edit yourself.**

A run is `RUN.json` plus a `passport.json` that records your instructions and every
answer **in your own words**. Nine `rs_*` tools work over an append-only claim and
source ledger; a human answers the frame gates in the Research tab rather than the
model; every claim in the prose is a span the ledger tracks, so a citation that does
not exist cannot be built into a document without being reported by name — and a
claim that rests on a **number** carries that number as data, so the build prints
every statistic the document claims instead of leaving it buried in a sentence.

Most "write me a paper" surfaces produce text that lives in the chat and dies
there, and the one quiet catastrophe of research tooling is a citation — or a
claim — that nothing can check. This package starts from the other end: it builds
the **record** first.

## What it adds

- **Nine tools, named by intent.** `rs_open` (where runs live, what is in each,
  where this one stands — and `action=handoff`, which reprints the ledger so a
  model's summary is never mistaken for what you said), `rs_new` (start a run;
  opens the frame gates), `rs_plan` (the question, the outline, the method),
  `rs_read` (the one reader: view, gates, passport, files, claims, sources,
  outline, build, or one text file), `rs_write` (write prose AND declare the claims
  it makes, together), `rs_cite` (ingest a source: hash the bytes, store the record
  and the text), `rs_verify` (run the two rungs a file can run, record the two that
  need a reader), `rs_review` (the panel, the author's answers, the re-review, and
  the devil's advocate), `rs_build` (a watermarked draft, or a gated clean
  document).
- **A structured method record, and the counts that cannot be true.**
  `rs_plan part=method method={…}` writes `plan/method.json`: `databases`,
  `accessed`, `search`, `include`, `exclude` and `screening` (`identified`,
  `screened`, `included`), plus optional `registration`, `platforms` and `notes`.
  It is validated **on the way in** — a date that does not exist, a field this
  package does not read, and a required field left out are each refused — and again
  by **`r0`** on the way out, because a record a person edited by hand never passed
  the first check. The one arithmetic a review can lie to itself with is checked
  rather than trusted: records are removed at each step, never added, so
  `identified >= screened >= included`. A record that breaks it is refused
  (`METHOD_COUNTS`); an incomplete one is an `r0` warning, `method-incomplete`.
  `plan/method.md` is **generated** from the record, and the build prints the whole
  thing into the document as a **search-and-screening flow** — the same numbers,
  from the same bytes, in every artifact. A run with no record is not a failure: a
  theoretical paper has no search, and the build reports the absence as a note.
- **A statistic is data, not prose.** A claim that rests on a number takes
  `statistic: { test, statistic, df, p, effect, ci, n }`, validated like everything
  else in the dialect. Two of its rules are reporting standards rather than taste:
  **`p = .000` is refused** (no test produces a probability of exactly zero — it is
  what a program prints after rounding — and the refusal names `p < .001` as what to
  write instead), and **a field with no numeral is refused** (`"effect": "large"` is
  a label, not a measurement). The build prints a **Statistics table**: each claim
  and its numbers in a draft, each **sentence** and its numbers in a clean build,
  because a finished document must not cite ids that appear nowhere in it. And
  **changing a statistic clears the claim's verification**, exactly as changing its
  words does: a verdict says "this passage supports what this claim asserts", and
  `p = .032` is part of what it asserts.
- **The method layer is a skill, and the dense content is a reference.**
  `research-methods` is one of the **seven** bundled skills: ~10 KB carrying the
  design→what-it-can-support table wired to the `strength` enum, the reporting
  guideline each design owes, and the two refusals above. Beside it,
  `reference/method.md` holds what a run actually needs — question frameworks
  (FINER, PICO/PECO/SPIDER), a design catalogue with its validity threats, sampling
  and missing-data mechanisms, the statistics reporting bar, risk-of-bias
  instruments and GRADE, the PRISMA process, qualitative trustworthiness, and ethics
  and authorship. Every fenced example in **both** files is held against the real
  tool surface by the same check, so the reference cannot drift either.
- **A disclosure record, and a determination this package refuses to make.**
  `rs_plan part=disclosure disclosure={…}` writes `plan/disclosure.json`: **authors**
  with their CRediT roles, **ethics** approval, **funding**, **conflicts**, **data**
  availability and the use of **generative AI**. It is validated on the way in and
  again by `r0`, and every rule is about a statement being *complete* rather than
  true — an approval of `approved` or `exempt-declared` must name the approving
  `body`, its `reference` **and** how `consent` was taken, because "approved" with no
  body is a sentence nobody can check; data said to be `open` or `on-request` must
  say **where**; data said to be `restricted` or `none` must say **why**; every
  author needs at least one CRediT role, because an author with no declared
  contribution is a name on a list; and an AI declaration that says a tool was not
  used while naming a scope is refused as the contradiction it is. The vocabulary has
  no `exempt` for a plugin to choose — only `exempt-declared`, which is an author
  recording what a body decided. `format=package` prints it as `disclosure.md`
  **beside** the title page and never into the manuscript, `CHECKLIST.md` says which
  statements are recorded and which are not, and a check asserts that not one author
  name from the record reaches the anonymized manuscript.
- **The reader is measured, not only recorded.** `rs_verify action=calibrate` hands
  out a set of items whose correct verdict is not in doubt — claim, passage, and
  **no labels** — scores the answers against them, and reports the two errors that
  matter: **FNR** (defects accepted: the expensive one, the error that lets an
  overstated claim through) and **FPR** (good claims rejected), each against a stated
  bar, with the strength-verdict agreement and every disagreement shown beside the
  judge's own reason. The labels are ours, every one carries the reason for it, and
  the thresholds are constants in the source rather than folklore. **A pass means
  very little** — that a judge agreed with 25 unambiguous items, not that it can spot
  a subtle overstatement in a real manuscript — and nothing is gated on the result.
  The arithmetic is itself checked: a perfect judge, a sycophant, a skeptic, and a
  judge sitting exactly on each bar.
- **A review is a ledger of concerns, with two columns that stay apart.**
  `rs_review action=panel` records a round of findings — each with the role that
  raised it, its severity, its criterion, and the **evidence in the manuscript**
  that grounds it, because a concern the author cannot find is a revision round
  wasted. `action=answer` records **your** reply (`addressed` / `rejected`);
  `action=rereview` records what a **fresh reader** found (`verified: true|false`
  plus a reason). "I fixed it" and "it is fixed" are different statements, so the
  traceability matrix keeps them in separate columns — and `verified: false` is a
  normal, useful answer rather than a failure. `action=write` puts
  `reviews/panel-r<n>.md` and `reviews/traceability.md` on disk, which is what a
  response-to-reviewers letter is written from.
- **The devil's advocate's protocol is enforced, not requested.** `action=attack`
  raises one, `action=concede` records a concession — and it needs the rebuttal's
  **score** (1–5, how directly and how evidential the reply was). Below 4 the
  concession is **refused** (`CONCESSION_BELOW_THRESHOLD`): the advocate holds
  position and restates the attack. **Two concessions in a row are refused
  outright** (`CONSECUTIVE_CONCESSION`) — the sycophancy pattern the protocol exists
  to slow, where every individual concession looks reasonable and the sequence is
  agreement with extra steps. The report also prints the concession rate and says
  the pattern out loud when it crosses half.
- **A ladder, and every rung names what it reached.**
  - `r0-structure` — the document and its ledgers agree (`span-unrecorded`,
    `claim-orphan`, `broken-marker`, `broken-citation`, `unknown-source`). Runs in
    `doc.js`, on every entry the panel saves.
  - `r1-record` — the stored bytes still hash to the names they are filed under
    (`bytes-tampered`), the record has the fields a reference needs, every field
    names its origin, and the title it claims actually appears in the text that was
    ingested (`title-mismatch`). This is PROVENANCE, not existence: it never says a
    DOI is real.
  - `r2-locate` — every claim's quoted passage really is in its source's stored
    text. **A miss and an inconclusive are different answers**: a quote that is not
    found is `locate-miss` only when the extraction reports complete coverage, and
    `locate-inconclusive` otherwise — because telling an author their quote is not
    in the paper when the *extractor* was partial is the worst answer this plugin
    could give.
  - `r3-support` / `r4-audit` — a reader's judgement, recorded by the agent with
    `rs_verify action=support` / `audit`, with the judge named and the passage
    quoted. A claim with no locator **cannot be judged** (`STATUS_REQUIRES_EVIDENCE`):
    there is no passage that was read. An audit before an `r3` verdict is refused
    (`RUNG_ORDER`). A verdict with no reason is refused — a score with no evidence
    is the one thing this ledger must not hold.
  - **A rung that could not run says so.** A source with no stored text is
    `uncheckable`, listed by name, never a pass — the quiet failure being a run that
    looks fully checked because every check that could not run was skipped.
- **A run is a real folder you keep.** `~/Desktop/vncode-research/<slug>/` by
  default, with `plan/`, `doc/`, `ledger/`, `sources/`, `figures/`, `reviews/`,
  `build/`. `DSH_RESEARCH_ROOT` overrides it; a machine with no Desktop falls back
  to `<workspace>/research`.
- **A library pointer, so every session agrees.** `$DSH_HOME/dsh-research/library.json`
  names the folder your runs live in, and the first session that resolves a root
  writes it. Open a paper tomorrow, from another conversation, with a different
  working directory: it is the same folder. Delete the file to let the next session
  choose again. `rs_open action=roots` prints it.
- **A passport, not a preference file.** The initial instruction verbatim, every
  gate question with its answer and timestamp, every override's reason, and a
  receipt per tool call. A second answer to the same gate is **refused**: a ledger
  that can be edited in place is not a ledger.
- **Two frame gates, and one that a clean build opens.**
  - `g1-rq` — *is this the research question you actually want answered, and is it
    yours?* `rs_write` **refuses** until this is answered: writing the document
    before the question is confirmed is the failure this plugin exists to prevent.
  - `g2-intake` — *does this document report experiments that **you** ran?*
    Fail-closed: it wants your words even when the answer is a plain "no", and it
    does not block a write, because it is about what the document reports rather
    than whether it may be written.
  - `g3-integrity` — opened by `rs_build draft=clean`, the mode whose output looks
    finished. A clean build also refuses while the document and its ledger
    disagree, or while a claim a check found unsupported is still in the text.
- **A document dialect with exactly one addition to Pandoc Markdown.**
  `[the sentence, as written]{#c0142}` is a claim; `[@key]`, `[@key, p. 7]` and
  `[-@key]` are citations. `rs_write` refuses a span with no ledger row, a row with
  no span, a citation whose key no source defines (offering the nearest keys), and
  a citation-shaped bracket that does not parse — because each of those is a claim
  or a citation with nothing behind it.
- **The ledger is append-only, one row per revision.** Changing a claim's wording
  **clears its verification**, and the answer says so: a verdict belongs to a
  sentence, not to an id. A row that would change nothing is not appended, so a
  ledger's length means "how many times something actually changed".
- **Six citation styles, as data.** APA 7, Chicago notes, Chicago author-date,
  MLA 9, IEEE, Vancouver — one module each behind a registry, with the reference
  list computed from the ledger rather than typed by the model. Every one of them
  prints the source's address, because a citation a reader cannot follow is a
  citation that does not work.
- **It builds the document, and the DOCX is written rather than wrapped.**
  `rs_build format=md` writes the reader-ready Markdown — citations resolved by the
  style, the reference list computed from the ledger, claim endnotes in a draft.
  `format=docx` writes a real Office document from **the same Markdown**, through
  seven modules of hand-written OOXML (`lib/docx/`: a ZIP writer with fixed
  timestamps, the part model, styles, numbering, footnotes, tables, images) — which
  is the only way to keep the promise that this plugin spawns no process, since
  calling pandoc would be one. Two builds of one run are **byte-identical**: the
  writer never reads the clock, and a check holds it to that. `format=html` writes
  one **self-contained** page — no stylesheet URL, no font, no script, no remote
  image — and only the URL schemes a document may legitimately cite survive into it
  (`javascript:` is dropped rather than emitted). `format=tex` writes a `.tex` that
  needs **no bibliography engine**, because the citations are already resolved and
  the reference list already computed; it **prints the pdflatex command rather than
  running it**, which is what a package that spawns no process can honestly do.
  `ris` / `bib` / `enw` export the run's whole library for Zotero, EndNote or pandoc.
  The DOCX was verified by an independent tag-balance check, a CRC read of its own
  ZIP central directory, and **pandoc reading the file back** — including the
  metadata, the aligned table, the nested list and both footnotes.
- **Submission packaging, which is a folder and not a file.** `format=package`
  assembles what a journal actually asks for: `manuscript.docx` built with **no
  title block**, so it carries nothing identifying; `title-page.md` (uploaded
  separately, with the placeholders a person fills in); `cover-letter.md`
  **computed from the ledger** rather than written from memory — the claim counts,
  the verification state and the experiment-intake answer come from the run, so a
  letter cannot describe a paper that does not exist; `CHECKLIST.md`, which says
  what the run says about its own evidence *and* what no builder can check for you
  ("read it once with fresh eyes: the builder removed the title block, and it cannot
  know what your prose reveals"); and the run's `figures/` copied beside them.
  It is **gated like a clean build whatever `draft` says**, because a submission is
  the artifact that must not carry a claim nothing has checked.
- **The Research tab, and it is editable.** The run list with a "waiting" badge;
  the pending gates as a form (question, options, a box for your words, a reason
  box for an override, Submit); answered gates as a timeline; the passport's
  provenance quoted untruncated; the files. **A `.md` file under `doc/` or `plan/`
  opens in an editor in the panel**: the save goes to disk — so it is there in
  every session and in any editor — and the route answers with the structure
  verdict the panel shows immediately, naming `span-unrecorded` or `unknown-source`
  on the spot rather than at the next build. The tab re-reads the run every 1.5 s
  while it is visible, and stops the moment it is hidden.

## How it plugs in

| Piece | Value |
|---|---|
| row | `research` |
| routes | eight exact paths, `GET`/`HEAD`/`POST`, all behind the harness's session check |
| tools | 9 (`rs_open`, `rs_new`, `rs_plan`, `rs_read`, `rs_write`, `rs_cite`, `rs_verify`, `rs_review`, `rs_build`) — `rs_plan` also writes the method record, `rs_write` also takes a `statistic` per claim |
| gates | 3 (two frame, one opened by a clean build — and by `format=package`) |
| builds | `md`, `docx`, `html`, `tex`, `ris`, `bib`, `enw`, plus `package` (the gated submission folder) — every format it advertises is implemented, and a check asserts that |
| tab types | 1 (`research`, a page type with no file patterns) |
| skills | 8 (`research-project`, `research-methods`, `research-ethics`, `research-sources`, `research-writing`, `research-verification`, `research-review`, `research-formats`), registered at activation *and* copied into `$DSH_HOME/skills`; `research-methods` and `research-ethics` each ship a bundled reference |
| touches | **no** core row disabled, **no** fork, **no** npm dependency, **no** vendored engine, **no** bundled binary |

| Route | What it answers |
|---|---|
| `GET /api/dsh-research/state` | the root, its provenance and the library pointer, every run with its stage |
| `GET /api/dsh-research/project?slug=` | ONE run, in one round trip |
| `POST /api/dsh-research/gate` | answer a gate: `{ slug, id, value, text?, reason? }` |
| `GET /api/dsh-research/source?slug=&key=` | one source's record and its stored text |
| `GET /api/dsh-research/artifact?slug=&name=` | a built file's bytes (basename only, inside `build/`) |
| `GET /api/dsh-research/file?slug=&file=` | one text file of a run, for the panel's editor |
| `POST /api/dsh-research/file` | save that file, and answer with the structure verdict |
| `POST /api/dsh-research/build` | build a format — the same code path `rs_build` drives |
| `GET /api/dsh-research/health` | the snapshot the tracked checks read, with every refusal code |

## What it deliberately does not do

- **It opens no socket.** Not on activation, not on a timer, not on a tool call.
  Literature arrives as a file you or the agent already has: `rs_cite` hashes and
  stores it, and the harness's own `web_fetch` / `web_search` are the agent's way
  to the network. There is no resolver, no DOI lookup, no telemetry. The package's
  own check asserts the absence against every host file rather than promising it in
  prose.
- **It spawns nothing.** No child process — so no `pdftotext`, no pandoc, no engine
  found on PATH. It also extracts no PDF text itself: the agent reads a document
  with the `pdf_*` tools (or `ocr`) and hands `rs_cite` the text. That is why the
  DOCX writer is being written rather than wrapped.
- **It reads no credential.** The only environment variables it reads are its own
  root, `$DSH_HOME`, and the home directory it looks for a Desktop in — and the
  check enforces that allowlist.
- **It writes only inside a run folder**, plus the one library pointer under
  `$DSH_HOME/dsh-research/`, through realpath containment. It never deletes
  anything, and it cannot verify that a DOI exists: `r1` records **provenance**, not
  existence, and this README says so.
- **It claims no stage it cannot back.** A run is `new`, `framing` or `framed`,
  decided by the ledger.

## Limits — what is not here yet

**The design is complete.** Every format this plugin advertises is implemented —
`md`, `docx`, `html`, `tex`, `ris`, `bib`, `enw`, and the gated `package` folder —
the eight skills are written, and the last item the design carried, the **headless
render check** for the Research tab, now runs: `check-research-render.mjs` opens the
tab in a real Chromium-family browser against a fixture run served by the engine's
own view code, and **measures the layout** rather than only the payload — the run
list and its `1 waiting` badge, the selected run's header, the passport's verbatim
quote, the claims and sources, and the gate form driven the way a person drives it
(pick the option that overrides the default, watch the reason box appear, pick the
plain one, watch it go, type, and Submit comes alive). It skips **loudly** on a host
with no browser or no React UMD build, because a check that downloads one to pass is
not a check. The pack keeps no alpha-by-alpha design or review document: this
README, the package's own checks and the eight skills are the record of what the
engine does and what proves it.

**It records statistics; it does not recompute them.** Nothing here calculates a
p-value from a test statistic, checks that `d = 0.61` follows from the means it was
given, or judges whether a design was analysed correctly. A `statistic` is
validated, stored, printed and checkable by a reader — and saying that plainly is
worth more than a recomputation that would look like arithmetic truth and not be
it. The same holds for the method record: it checks that a search is *recorded* and
that its counts are *internally consistent*, not that the search was any good.

**It records ethics, it does not decide ethics.** No part of this package says
whether a study needed approval, whether consent was required, or which review
category applies — the vocabulary has no value for a determination, only for a body
declaring one, and the reference that ships beside the skill says so at length. What
it checks is that a statement is *complete*: that an approval names the body and the
reference, that a waiver names its basis, that "available on request" has an address.
Whether any of it is true is the author's signature, not a builder's.

**And the judge measurement is a floor, not a certificate.** `action=calibrate`
scores a judge against 25 items whose labels are not in doubt. Agreeing with them
means the judge is not grossly miscalibrated; it does not mean the judge can catch a
subtle overstatement in a real manuscript, which is the failure the ladder exists to
limit and which no fixed set can measure. The report says exactly that, and nothing
in the package is gated on the result.

Three DOCX limits, stated rather than discovered: **IEEE is single column** (the
two-column layout is not emitted), page setup is Letter with 1-inch margins for
every style (APA 7 pins exactly that; the others pin none, so it is a deliberate
uniform choice rather than a source), and a construct outside the Markdown subset
— nested emphasis inside emphasis, list nesting past one level, indented code,
setext headings, raw HTML — is **reported with its line number rather than
dropped**.

A run created today is not a dead end: the folder, the ledgers and the dialect are
the structures the later phases fill.

## Verify

Inside the package, so it travels with it:

```sh
npm run check            # the engine: run model, ledgers, dialect, statistics, the method record, gates, tools, routes, the security claim
npm run check:docx       # the written OOXML, read back by pandoc
npm run check:refs       # RIS / BibTeX / MEDLINE / EndNote import and export, round-tripped
npm run check:styles     # every citation style against pinned strings
npm run check:examples   # every tool call, code and span the skills AND their references teach, against the real surface
npm run check:judge      # the calibration set, the scorer, and the bars - a perfect judge, a sycophant, a skeptic, and one exactly on each threshold
npm run check:render     # the Research tab in a REAL browser against a fixture run: the layout measured and the gate form driven (skips loudly with no browser)
npm run check:all        # all seven
```

Then the pack-wide checks that own the area:

```sh
node scripts/checks/check-client-bundles.mjs    # the tab and its editor, rendered for real
node scripts/checks/check-node-routes.mjs       # the manifest and every bundled-skill registration
node scripts/checks/check-scripts.mjs          # the scripts tree, the console contract
node scripts/checks/check-no-secrets.mjs
```

A case a host cannot run — a symlink without the privilege to create one — skips
**loudly** and is not evidence.

## Install

With the vncode pack: `scripts\setup\install.bat` (Windows) or `./scripts/setup/install.sh`
(macOS / Linux) in **that** repository, which discovers this package under
`packages/`. Nothing has to be installed first, and nothing is downloaded. Then
restart the harness and open the Research tab, or ask the agent for
`rs_open action=list`.
