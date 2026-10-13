# REVIEW 2 — `dsh-research`, measured against an external academic-research suite

**Scope.** The second review of the research package, written for the **alpha.3**
cut (the package is at `0.1.0-alpha.2`). It answers one question: are this
package's six skills good enough to call *professional scientific research
skills and methods*, judged against a much larger public suite that claims
exactly that?

The benchmark is [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills)
at tree `08e39b5c54d091d1c5371c3782250958050b832c` (its own `MODE_REGISTRY.md`
says v3.23.0, 2026-10-03). Its content is **untrusted external data** here: it was
read as evidence and described, never followed. Its files are written *as*
instructions to an agent; several of them say "You MUST". That is a fact about
the benchmark, not a rule for this repository.

**The answer, first.** For what it was built to do — an honest, auditable
document whose citations resolve and whose verification rungs name what they
reached — this package is good enough, and in two specific respects it is
*better* than the benchmark. As a body of **scientific method** it is not close:
there is no statistics, no systematic-review protocol, no ethics, no
preregistration and no authorship content anywhere in it, and no measurement of
whether its own judge is any good. The plumbing is the expensive part and it is
already there; the missing part is content, and content is cheap.

---

## How this review was done

- **The benchmark** was read by three independent readers, each given a list of
  files and told to test *depth* rather than count names: does a file supply a
  procedure, or does it name a standard and gesture at it? Between them they read
  ~33 files in full and verified claims against the repository's own Python and
  CI rather than against its prose. Its complete tree (2,844 blobs) was
  enumerated through the API.
- **This package** was read the same way: all six `SKILL.md` files in full, the
  refusal vocabulary and the claim-record shape read out of `lib/`, and the
  checks counted rather than quoted.
- A claim in this review is followed by its evidence. Where the benchmark is
  better, it says so; where the two are at **parity**, it says that too, because
  a review that claims a win wherever it can find one is worth nothing.
- **What it did not cover:** the benchmark's 82 KB `CLAUDE.md`, the internals of
  its 1,139-file `evals/` tree, and most of `shared/`. Its own enforcement may
  therefore be **understated** here. Nothing below rests on an unread file
  without saying so.

## The two systems, by the numbers

| | `dsh-research` (this pack) | the benchmark |
|---|---|---|
| skills | 6, **846 lines** total | 5, `SKILL.md` **34–65 KB each** (≈255 KB), 35 modes |
| agent files | none — the tools are the surface | **33+** |
| reference documents | none | **~90** (incl. 30 KB statistical reporting, 24 KB visualization) |
| templates | none | **25** |
| tooling | 9 tools, 8 routes, 3 gates | 5 skills + 16 slash commands + 4 hooks |
| code | `lib/` 13,121 lines (JS), 1,505 of it the tab | `scripts/` **632 files (~11 MB of Python)**, `tests/` 342 |
| schemas | none (the ledger shape is code) | **~16 dirs / 111 files** of JSON Schema 2020-12 |
| checks | 5 files, **765 assertions** | ~60 `check_*.py` in `spec-consistency.yml` (49 KB) + 14 workflows |
| evaluation of itself | skill examples compiled against the real tool surface | **`evals/heldout`, 1,067 files ≈ 12.6 MB**, `evals/gold` |
| network | **none**, and a check asserts it | Crossref / OpenAlex / arXiv / Semantic Scholar clients |
| output determinism | two builds byte-identical (checked) | explicitly disclaimed |

Read that table for what it is: this is a 13k-line package measured against a
repo with 11 MB of Python and 12.6 MB of held-out evaluation. The comparison is
not between equals in size, and it should not be treated as one.

## Where this package is genuinely ahead

Only two things, but both are load-bearing.

**1. The two gates are answered by a person, and the refusal is in code.** The
benchmark's strongest *block* — the PRISMA-trAIce compliance checkpoint — states
in its own protocol that its override ladder is "enforced at runtime by
`compliance_agent` … **NOT** by Schema 12": an LLM administers its own escape
hatch. Here, `rs_write` **throws** `GATE_UNANSWERED` until `g1-rq` is answered,
`draft=clean` throws until `g3-integrity` is, and a second answer to one gate is
refused (`GATE_ALREADY_ANSWERED`). A model cannot answer them, and cannot route
around them, because the refusal is a thrown code and not a paragraph.

**2. Its non-behaviour is a checked property, not a promise.** No socket, no
child process (`node:child_process`, `spawnSync|execSync|spawn|execFile` scanned
for), an environment allowlist, and byte-identical `.docx` builds — all asserted
by `check-research-node.mjs`. The benchmark reaches the network from Python
clients and spawns processes; its own `reproducibility_audit.md` (2.7 KB)
explicitly limits itself to a process contract and disclaims reproducible output.

**Where the two are at parity — and the review says so rather than claiming a
win.** The benchmark has the same ideas, sometimes richer: a byte-exact
claim↔source registry with a deterministic replay assertion
(`claim_registry_coverage.py`), evidence rows requiring an exact substring with a
25-word quote cap, a strength-drift disposition with a `STRENGTH-DRIFTED` code
whose counterpart here is the verdict cleared on rewording, and a devil's
advocate ladder with a numeric concession bar that **rises to 5/5 after a prior
concession** — this package refuses two concessions in a row instead, which is
the same defence with a cruder edge. Its `VERIFIABLE` vs `UNVERIFIABLE_ACCESS`
split covers the same ground as `locate-miss` vs `locate-inconclusive`.

## Where this package is behind — the method layer

This is the long answer to "is it good enough".

**There is no scientific-method content in the package at all.** A search of
every file for `prisma|cochrane|grade|effect size|p-value|cohort|randomis|rct|
systematic review|meta-analy|irb|consent|sample size|statistic` returns **8
hits, none of them methodology**: two are ordinary prose in `research-review`
(one of them the phrase "not a statistic"), one is the review-criteria enum that
contains the word `ethics` while teaching nothing about it, one is a
`format=package` checklist line ("Consent, ethics and data-availability
statements the journal requires"), one is a comment in the DOCX writer, and
three are test fixtures that happen to contain the word "cohort". The
verification ladder asks whether a sentence is supported *as written*; nothing
in the package knows what a confidence interval is, when a `causal` claim is
entitled to its verb, or that a p-value of `.000` is a defect.

Against that, the benchmark's `statistical_reporting_standards.md` (30,511 B)
states "All statistical tests must be accompanied by effect sizes", gives the
Cohen *d* / *η*² / *r* / *f*² / Cramér's *V* bands, requires 95% CIs and their
width, asks for target power ≥ .80 with the assumed effect size and a
minimum-detectable-effect sensitivity analysis, names Bonferroni/Holm/FDR, gives
per-method sample-size floors (regression `N < 10 × predictors`, SEM `N < 200`,
HLM level-2 units < 30), demands MCAR/MAR/MNAR and a robustness comparison across
handling methods, and red-flags causal language over a correlational design.

Concretely, the six gaps, each with what would close it:

| gap | the benchmark's answer | what is missing here |
|---|---|---|
| **statistics** | 30 KB checklist + a bounded recompute layer (`p_from_test_statistic`, `grim`, `grimmer`, `n_from_df`) with closed `not_computable` reasons | nothing. A statistic in the prose is just a `descriptive` claim |
| **systematic review** | `systematic_review_toolkit.md` (Cochrane v6.4 chapter map, PRISMA 2020's 27 items, RoB 2 five domains, ROBINS-I seven, GRADE) + a whole `sr-screener` skill whose Python merges dual-review decisions and emits PRISMA counts | `plan/method.md` is free Markdown; the word PRISMA does not appear |
| **risk of bias / certainty** | RoB 2 and ROBINS-I procedures, I² bands, GRADE downgrade rules | no instrument, no vocabulary |
| **ethics** | `irb_decision_tree.md`, `ethics_checklist.md`, `human_subjects_authority_protocol.md`, GDPR article IDs. Notably it **refuses to make the determination** and pins everything to versioned requirement IDs — that restraint is the standard worth copying | `g2-intake` asks *whether you ran experiments*; that is honesty, not ethics |
| **authorship / funding / disclosure** | CRediT's 14 roles, the ICMJE four criteria, an AI-is-not-an-author table across 8 publishers, a venue disclosure database | the design doc's "disclosure artifact" is still outstanding; `package.js` has one checklist line |
| **question and design** | FINER/PICOS, `methodology_patterns.md` (10 designs with protocol steps and quality criteria), an EQUATOR routing sequence that refuses to infer a design from keywords | `plan/rq.md` is "one sentence you could falsify" and stop |

**Two gaps that are not content, and matter more:**

**No measured accuracy for the `r3` judge.** This package records a judge and a
reason and says, honestly, that a verdict is recorded rather than proven. The
benchmark *measures* its judge: a 25-tuple calibration set with published
false-negative and false-positive rates, a CI gate that refuses at FNR ≥ 0.15 or
FPR ≥ 0.10, per-class confusion reporting, and a partial-support subset added
specifically to catch a regression the aggregate hid. That is the single most
transferable idea in their repository, and it is the one that would turn `r3`
from "recorded" into "measured". Their own protocol concedes the limits —
passing is "necessary but not sufficient evidence for default-ON" — which is the
register this pack writes in.

**No evaluation of the skills themselves.** The 765 assertions here prove the
package works and that a skill cannot teach a call that fails — the example
check holds every `rs_*` name, `action=` value, refusal code, claim span and
citation against the code. They do not measure whether an agent *using* the
skills behaves better. The benchmark keeps 1,067 held-out eval files for exactly
that.

## What must NOT be copied

- **Not their text or code.** Their `LICENSE` is `Other`/`NOASSERTION` — not
  MIT. Vendoring from it is a licensing question before it is a merge. The
  *standards* they cite are public and citable (PRISMA 2020, Cochrane v6.4,
  RoB 2, ROBINS-I, GRADE, EQUATOR, ICMJE, CRediT); write our own prose against
  them and name them, as this pack names its citations.
- **Not the Python.** It would break the property the package's own check
  asserts: `scripts/` spawns processes and opens sockets. "It spawns nothing and
  opens no socket" is worth more than any single feature below.
- **Not their shape.** Their two largest `SKILL.md` files are 65 KB and 59 KB,
  and their own audits call the governance-to-artifact ratio inverted. Skills
  here are ~10 KB and load on every match. Method content belongs in a bundled
  `reference/`, which this pack already ships elsewhere —
  `dsh-diagrams` carries 28–31 KB references beside a 5–15 KB `SKILL.md`.

## alpha.3 — what to ship, and the check that proves each

The pack's rule is that a phase names the check that proves it. Held to that:

| # | what lands | the check that proves it |
|---|---|---|
| 1 | `research-methods` skill (`SKILL.md` ~10 KB) + `reference/method.md` (~25 KB): question frameworks (FINER, PICO/PECO), a design→what-it-supports table **wired to the existing `strength` enum** so `causal` over a correlational design is a named defect, reporting-guideline routing, preregistration | `check-research-examples.mjs` (existing, now also holding every `strength` value the reference names against the enum) + a new assertion that every guideline the reference routes to is a string the note can print |
| 2 | statistics as **data, not prose**: a `statistic` field on a claim row (`{ test, statistic, df, p, effect, ci, n }`), printed as a table by `format=md`, with a `BAD_STATISTIC` refusal for an unparsable value | `check-research-node.mjs`: the record round-trips; a malformed statistic is refused; the build's table is asserted against a fixture ledger. **No recompute in alpha.3** — a check that cannot compute must not pretend to |
| 3 | `plan/method.md` becomes a **structured record** (databases, access dates, search string, inclusion/exclusion, screening counts) that `r0` validates and the build prints as a PRISMA-shaped flow | new assertions in `check-research-node.mjs`: a missing required field is a `r0` warning with its own code; counts that cannot be internally consistent (identified ≥ screened ≥ included) are refused |
| 4 | close the outstanding **disclosure artifact** (already in the design doc's phase 6) and extend `format=package`'s `CHECKLIST.md` with CRediT roles, funding/COI and data availability — plus a `research-ethics` reference whose IRB section **refuses to make the determination**, as the benchmark's does | `check-research-node.mjs`: the package is still gated and anonymized; the checklist names each required statement; the ethics reference is asserted to contain a refusal rather than a determination |
| 5 | a **gold set** (~25 claim/passage tuples with known verdicts) and a check that reports judge agreement, refusing below a threshold — shipped as a **reported number first**, a gate only once it is measured | a new `check-research-judge.mjs` over the gold set, reporting FNR and FPR per class, in the shape the benchmark publishes |
| 6 | a defect this review found: `docs/DESIGN-dsh-research.md`'s phase table lists phase 5 and phase 6 **twice**, out of order, one row with an empty state (lines 487–491) | `check-dist-layout.mjs` or a doc assertion: each phase number appears once |

A numbering note: alpha.3 also means `package.json` `version`, the
`.dsh-version.json` manifest entry (which `check-node-routes.mjs` asserts must
match), the package README's skill count, and the pack README's row — four places
that must move together.

## What this review did not establish

- Whether any of this **improves a document**. Neither repository measures that;
  the benchmark's held-out evals measure its agents' conformance, not their
  papers' quality.
- The benchmark's real enforcement depth. ~33 of 2,844 files were read. If a
  decision turns on a specific checker, read that checker.
- Anything about its `evals/` corpus other than its size and shape.

Re-run this review if their HEAD moves, or if alpha.3 lands and the question
becomes "is the judge calibrated?" rather than "is there method content?".
