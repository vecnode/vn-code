---
name: research-review
description: Work the review of a research run with rs_review — read the manuscript and record the panel's concerns with the evidence that grounds each one, keep the author's reply and the re-review's finding in their separate columns, run the devil's advocate with the concession threshold the tool enforces, and write the panel report and traceability matrix a response-to-reviewers letter is built from. Use when a document is ready for review, when a concern has to be answered or re-reviewed, or when an attack or a concession is being recorded.
whenToUse: When a paper is to be reviewed — as a panel of reviewers, an author answering concerns, or a devil's advocate pressing an argument — when `action=panel`, `action=answer`, `action=rereview`, `action=attack` or `action=concede` is about to be called, or when a response-to-reviewers letter and its traceability matrix have to be produced.
---

# A review is a ledger of concerns

`rs_review` records a review; it does not perform one. Reading the manuscript and
deciding what is wrong with it is your work, in your own reading of the document
(`rs_read what=file` gives you the prose; `what=outline` names the sections). What
the tool gives you is that no concern can be lost, no concern can be closed by
wishing, and the two questions a revision round turns on stay separate.

## Record what you found, with where you found it

```text
rs_review slug=sleep-memory-review action=panel
  items=[{ "role": "methodology", "concern": "the inclusion criteria are stated but
      no search date is given, so the review cannot be reproduced",
    "severity": "major", "criterion": "reproducibility",
    "evidence": "method", "suggestion": "state the search date and the databases with
      their dates of access" },
   { "role": "domain", "concern": "the synthesis treats slow-wave sleep as one
      mechanism across paediatric and adult samples",
    "severity": "major", "criterion": "evidence", "evidence": "c0148",
    "suggestion": "separate the two samples or say why they are pooled" }]
```

```text
Recorded round 1 for sleep-memory-review: 2 concern(s)
  f0001  [major, methodology, reproducibility]
  f0002  [major, domain, evidence]

Next: answer each one with `rs_review action=answer id=… status=addressed reply="…"`,
then have a fresh reader check it with `rs_review action=rereview`.
```

**Always give `evidence`** — a section slug, or a claim id, so the two tools meet:
the reviewer names `c0148` and the author finds the sentence, its status and the
source it rests on with `rs_read what=claims`. A concern with no location is one
the author cannot find, and that is the commonest way a review wastes a revision
round.

Roles: `journal-fit`, `methodology`, `domain`, `devils-advocate`, `editor`,
`author`. Criteria: `fit`, `method`, `evidence`, `novelty`, `clarity`, `ethics`,
`reproducibility`, `significance`. Severities: `major`, `minor`, `note`. Criterion
is what groups the report, severity is what decides the round, and neither is
worth arguing about — pick the honest one.

## Reviewers read; they do not edit

A reviewer's output is findings, not a redraft. When you dispatch a reviewer
subagent, tell it to use read-only tools, to read the manuscript as it stands, and
to report concerns with their evidence — **not** to rewrite a sentence, not to edit
a claim, not to run `rs_write`. Say this in the subagent's own prompt, because
nothing here enforces it: the tool has no way to know whether the words it was
handed came from a reader or from an editor, so this discipline is yours. A
reviewer that silently repairs the document destroys the finding that would have
justified the repair.

## Two columns, and two different statements

`action=answer` records **the author's reply**: `{ id, status: addressed|rejected,
reply }`. `reply` is required — "addressed" with no sentence is not something a
reviewer can check.

`action=rereview` records **what a fresh reader found** after the revision:
`{ id, verified: true|false, reason, by }`. It is a separate column because "I
fixed it" and "it is fixed" are different statements, and a letter that merges them
is how a revision passes review without the change existing.

```text
rs_review slug=sleep-memory-review action=answer id=f0001 status=addressed
  reply="the search date, the four databases and the access dates are now in the
    first paragraph of Methods"
rs_review slug=sleep-memory-review action=rereview id=f0001
  verified=false by="a fresh reader subagent, given the revised method section only"
  reason="it names the databases and their access dates but still no search date"
```

```text
Finding f0001 is now addressed (your words, not a verification)
- your answer: the search date, the four databases and the access dates are now in
  the first paragraph of Methods

A re-review decides whether it is actually settled:
`rs_review action=rereview id=f0001 verified=true|false reason="…"`. Until then the
matrix says `not re-reviewed`.
```

`verified=false` is a **normal, useful answer**: the revision did not do what the
reply said it did. Record it, with a `reason` that says what did not settle, and
tell the user in plain words what is still outstanding. A re-review of a concern
that has no answer yet is refused: there is nothing to verify.

## The devil's advocate, and the protocol the tool enforces

`action=attack` raises one. `action=concede` records a concession and **requires
the rebuttal's `score`** — how directly and how evidential the reply was, not how
firmly it was made:

- **1** — it repeated itself.
- **3** — it answered a different question.
- **4** — it answered *this* attack with evidence.
- **5** — that, plus a demonstration.

Below 4 the concession is **refused**, the advocate holds position and restates the
attack; and **two concessions in a row are refused outright**, because a sequence
of concessions that looks like a debate and is actually agreement with extra steps
is the sycophancy pattern this protocol exists to slow. Treat a refusal as the
protocol working, not as an error to route around: score honestly, record the
score you actually mean, and if the reply really was answered, say what evidence
answered it. `action=attack` is where a held position goes when it is worth
keeping.

## The sycophancy warning is a signal, not a statistic

`action=read` prints the advocate's attack count, concession count and rate, and
when the rate is at or above half over enough exchanges the report says so in a
sentence. That warning is the only place the pattern is visible — every individual
concession looked reasonable. Raise it with the user when it appears, and re-read
the attacks the advocate held: conceding is not the same as being answered.

## Writing it up

`action=read` prints the traceability matrix: one row per concern, with the
author's answer and the re-review's finding in separate columns and `still open` in
the answer column where there is none. `action=write` puts
`reviews/panel-r<n>.md` (the round's concerns, grouped and counted) and
`reviews/traceability.md` on disk — that pair is what a response-to-reviewers
letter is written from, and the matrix is pasted into it.

**A response letter with an open concern in it concedes the point.** Before writing
one, check the open count `action=read` reports and either answer and re-review
what is open, or say plainly in the letter what remains unresolved and why. Writing
the letter early, while the matrix still says `still open`, is how a revision looks
finished while the concern stands.
