---
name: research-methods
description: Choose the design and the numbers a research run can honestly claim — write the structured METHOD RECORD (databases, date of access, search string, criteria, screening counts) that r0 validates, pick the claim strength a design can actually carry, record a statistic as data rather than prose, route to the reporting guideline the design owes, and decide what to preregister. Use when a run's question, design, search or statistics have to be settled before the writing, or when a claim needs a strength or a number attached to it.
whenToUse: Before writing a document that reports data or a search — when the question has to be made falsifiable, when a claim's verb has to match what the design can support, when a search has to be recorded so a reader can repeat it, when a number has to be attached to a claim, or when METHOD_COUNTS, BAD_STATISTIC or a reporting guideline comes up.
---

# Method before sentence

A document is only as good as the design under it, and two failures are cheap to
prevent and expensive to discover:

- **a claim that says more than its design can support** — `causes` over a
  correlation, `proves` over one study, `significant` with no effect size;
- **a search nobody can repeat** — "we searched the literature" is not a method,
  and a review whose search cannot be repeated cannot be checked by anyone,
  including its author a year later.

This skill is the method layer. It does not read your statistics for you and it
does not infer a design from keywords. What it does is make both of those things
**data on the record**, where a check can reach them.

The dense content — the design catalogue, the validity threats, the statistics
reporting bar, the guideline routing table, the ethics and authorship ground —
is in `reference/method.md` beside this file. Read it when the question is *what
does this design let me say*, and read the worked example below when the question
is *what do I call right now*.

## The method record: a search as data

`plan/method.md` is prose. `plan/method.json` is the record, and it is the one r0
validates and the build prints back as the document's own search-and-screening
flow. Six fields, all required:

```text
rs_plan slug=sleep-memory-review part=method method={
  "databases": ["PubMed", "Web of Science Core Collection", "PsycINFO"],
  "accessed": "2026-10-13",
  "search": "(\"sleep deprivation\" OR \"sleep restriction\") AND (\"memory consolidation\" OR recall) AND (adult OR human)",
  "include": ["adult human samples", "a sleep-deprivation or sleep-restriction manipulation", "a memory measure reported with a statistic"],
  "exclude": ["animal-only studies", "pharmacological sleep aids", "no memory outcome"],
  "screening": { "identified": 412, "screened": 96, "included": 23 }
}
```

```text
plan/method.json written, and plan/method.md regenerated from it
- path: C:\Users\ana\Desktop\vncode-research\sleep-memory-review\plan\method.json
- 3 database(s), accessed 2026-10-13, 412 identified -> 96 screened -> 23 included

The record is what r0 validates and what the document's search-and-screening flow is printed from. Edit the RECORD, not plan/method.md: the next write replaces the view.
```

**The counts are checked, and that is the point of the record.** Records are
removed at each step, never added, so `identified >= screened >= included` must
hold. It is the one arithmetic a review can lie to itself with and not notice:

```text
Refused (METHOD_COUNTS): the screening counts cannot be true: identified=96, screened=412, included=23 - records are removed at each step, never added, so identified >= screened >= included. Fix the record (or the review) rather than the arithmetic.
```

Three more rules the record enforces rather than trusts:

- **`accessed` is a real calendar date.** `2026-02-31` matches the shape and
  cannot be true; a date a reader cannot trust is worse than none.
- **The fields are closed.** `databases`, `accessed`, `search`, `include`,
  `exclude`, `screening` — plus optional `registration`, `platforms`, `notes`. A
  field this package does not read is a field nothing validates.
- **An empty `exclude` is legitimate; a missing one is not.** "Nothing was
  excluded" and "nobody said" are different statements, and only one of them is a
  method.

`registration` is where a preregistration ID goes (PROSPERO, OSF, INPLASY,
ClinicalTrials.gov, AsPredicted), and a review that has none is making a choice
worth recording rather than a gap worth hiding — see the reference for what to
register and when.

A record is validated **on the way in** by `rs_plan` and again on the way out by
**`r0-structure`**, which reports what it finds on disk as a problem rather than
believing it:

| code | severity | what it means |
|---|---|---|
| `method-incomplete` | warning | a field a reader needs is missing or empty — a hand-edited record, or one another version wrote |
| `method-counts` | error | the counts contradict each other; a clean build refuses on it |
| `method-date` | warning | `accessed` is not a real `YYYY-MM-DD` date |

## What the design lets you say

`strength` is already on every claim (`rs_write`), and this is the table that
decides it. Pick the verb the design can carry, not the one that reads better —
a `causal` claim over a correlational source is a defect of the sentence, fixed
by rewriting the sentence, not by re-labelling it.

| the design | what it can support | honest strength |
|---|---|---|
| randomised experiment, allocation concealed | a difference caused by the manipulation | `causal` |
| quasi-experiment with a credible counterfactual (difference-in-differences, regression discontinuity, IV) | a causal effect **under stated assumptions** — name them | `causal`, with the assumptions written down |
| cohort / case-control / cross-sectional | an association, adjusted for what was measured | `associational` |
| single-group pre-post | change over time, not the cause of it | `associational` at most |
| qualitative (interviews, ethnography, case study) | meaning, mechanism, experience — not prevalence | `descriptive` or `theoretical` |
| a model, a derivation, an argument | what follows if the premises hold | `theoretical` |
| a recommendation | what ought to be done, which no datum settles | `normative` |

Two rules that come from the table and are the ones an agent gets wrong:

- **`p < .05` on a cross-sectional study is not a causal claim.** The design
  cannot carry the verb, whatever the p-value says.
- **`descriptive` is not the weak option.** "412 records were identified" is a
  descriptive claim and it is exactly the right label for it. Reaching for
  `associational` because it sounds stronger is how a number becomes an
  overstatement.

## A number is data, not prose

A claim that rests on a statistic takes a `statistic` object, recorded on the
claim row:

```text
rs_write slug=sleep-memory-review section=memory
  text="Sleep restriction reduced next-day recall relative to the control condition [@walker2020cognitive]. [Recall was lower after restriction than after a full night of sleep]{#c0142} [@walker2020cognitive, p. 7]."
  claims=[{ "id": "c0142", "strength": "causal",
    "statistic": { "test": "Welch t-test", "statistic": "t = 2.41", "df": "38.2", "p": ".032", "effect": "d = 0.61", "ci": [0.12, 1.10], "n": 40 },
    "sources": [{ "key": "walker2020cognitive",
      "locator": { "kind": "quote", "quote": "sleep-dependent consolidation of declarative memory" } }] }]
```

```text
doc/sections/memory.md written (replace)
- path: C:\Users\ana\Desktop\vncode-research\sleep-memory-review\doc\sections\memory.md
- words: 34
- claims in this text: 1 (1 new)
- citations: walker2020cognitive
- statistics recorded: c0142 (Welch t-test, t = 2.41, df 38.2, p .032, effect size d = 0.61, 95% CI .12 to 1.1, n 40)
```

Seven fields, closed: `test`, `statistic`, `df`, `p`, `effect`, `ci`, `n`. What
they are for is that the **build prints them** — `format=md` (and `docx`, `html`,
`tex`, from the same Markdown) carries a Statistics table in a draft naming each
claim and its numbers, and in a clean build naming each sentence and its numbers,
because a finished document must not cite ids that appear nowhere in it.

Three refusals, each a reporting standard rather than a preference:

- **`p = .000` is refused.** No test produces a probability of exactly zero; it
  is what a program prints after rounding, and copying it into a paper reports a
  number that cannot exist. Write `p < .001`.
- **A field with no numeral is refused** (`"effect": "large"`): a label is not a
  measurement. Write `d = 0.61` and let a reader disagree with the threshold.
- **A field nothing reads is refused**, like everywhere else in this dialect: a
  number nothing checks is a number nothing checks.

**Changing a statistic clears the claim's verification**, exactly as changing
words does. A verdict says "this passage supports what this claim asserts", and
`p = .032` is part of what it asserts — a check made about the old number is a
check about a claim that no longer exists. `rs_write` names every claim it
cleared, and you say so to the user in the same turn.

## The guideline the design owes

Before a document leaves the run, name the reporting guideline its design owes
and say which items it cannot yet satisfy. Route by design, never by keyword:
"trial" in a title does not make a study an RCT.

| the study is | the guideline |
|---|---|
| a randomised trial | CONSORT |
| a trial protocol | SPIRIT |
| an observational study (cohort, case-control, cross-sectional) | STROBE |
| a systematic review | PRISMA 2020 |
| a review protocol | PRISMA-P |
| a diagnostic-accuracy study | STARD |
| a prediction model | TRIPOD |
| a qualitative study (interviews, focus groups) | COREQ, or SRQR |
| a case report | CARE |
| a quality-improvement study | SQUIRE 2.0 |
| an economic evaluation | CHEERS |
| an animal study | ARRIVE |
| a practice guideline | AGREE II |

The full table, what each one covers, and how to handle a study that straddles
two, is in the reference. The rule that matters here: **a guideline you cannot
satisfy is a sentence in Limitations, not a silence.** An unmet item reported is
a defect a reader can weigh; an unmet item omitted is a defect they cannot see.

## What this skill refuses to do

- **It does not infer a design from keywords**, and neither should you: a
  guideline chosen by a title's wording is a checklist applied to the wrong
  study.
- **It does not recompute statistics.** Nothing in this package calculates a
  p-value from a test statistic or checks that `d = 0.61` follows from the means
  it was given. The numbers are recorded, printed and checkable by a reader — and
  saying that plainly is worth more than a recomputation that pretends to be
  arithmetic truth.
- **It does not decide ethics for you.** Consent, approval and data-protection
  obligations are an institution's determination, not a plugin's: the reference
  says what to collect and who has to decide.
- **No record is not a failure.** A theoretical paper has no search. The build
  reports `no plan/method.json` as a note rather than refusing, because inventing
  a requirement is not the same as enforcing one.
