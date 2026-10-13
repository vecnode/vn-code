---
name: research-verification
description: Work the verification ladder of a research run with rs_verify — read the ladder report before claiming anything is checked, run the two file rungs (r1-record, r2-locate) that need no reader, record the r3-support verdicts and strength verdicts that only a reader can make, tell a miss from an inconclusive, and know what a clean build will still refuse. Use when a document is written and about to be called checked, when a claim's quote does not match its source, or when a gate or build answers with an integrity refusal.
whenToUse: When a run's evidence has to be checked — before telling a user a document is verified, when `rs_verify` is about to be called, when a finding names a source or a quote, when a claim has no locator to judge, or when `draft=clean` refuses on structure, on a blocking claim, or on gate `g3-integrity`.
---

# Verification is a ladder, not a verdict

Five rungs, and each one can say exactly one thing. Knowing which rung said
something is the whole skill; an agent that reports "checked" without naming the
rung has told the user nothing.

| rung | what it can say | who runs it |
|---|---|---|
| `r0-structure` | the document and its ledger agree | it runs by itself — the panel shows it and a build refuses on its errors |
| `r1-record` | the stored bytes still hash to what was ingested; the record has the fields a reference needs; every field names its origin; the title it claims is in the text that was ingested | `rs_verify action=record` — a FILE check, no reader |
| `r2-locate` | every claim's quoted passage really is in its source's stored text | `rs_verify action=record` — a FILE check, no reader |
| `r3-support` | a located passage supports the sentence **at the strength it is written** | a READER — you — and this tool only records what you decided |
| `r4-audit` | the same passages argued the other way | a READER, after an `r3-support` verdict exists |

`action=support` and `action=audit` will not judge anything for you, and they are
right not to: nothing in this package reads a paper and decides what it means.

## Read the report before you say anything

`action=report` first, every time. It writes nothing, and it is the only place
that lists each rung's state, what it checked, what it found, and **what it could
not check** — those last lines begin `? could not check`. A rung that could not
run is never a pass, and the report says so in those words: a source with no
stored text has not passed `r1`, it is uncheckable. Believing that line and acting
on it is worth more than every other rule here, because the quiet failure this
package exists to prevent is a run that looks fully checked because everything
that could not run was silently skipped.

```text
rs_verify slug=sleep-memory-review action=report
```

```text
The ladder for sleep-memory-review as it stands (3 source(s), 8 claim(s))

r1-record  [findings]
  checked: 1
  · origin-missing: walker2020: `year` has no recorded origin, so a reader cannot
    tell whether a service supplied it or a person typed it
  ? could not check diaz2019: no text is stored for this source, so its title
    cannot be matched against it and a quote in it cannot be located

r2-locate  [findings]
  quotes located: 6
  · locate-miss: claim c0142's quote is NOT in the stored text of walker2020 (the
    extractor reported complete coverage), so either the quote is wrong or the
    source does not say it
  · claim-unsourced: claim c0151 rests on no source, so no quote of it can be located
  ? could not check c0148/orozco2021: the locator is a `page`, which is a pointer
    a reader follows rather than a string this rung can search

r3-support  [needs-a-reader]
  waiting on a reader: 7
r4-audit  [needs-a-reader]
  waiting on a reader: 0

Statuses: 6 located, 2 unverified
This report changed nothing on disk.
A rung that could not run is listed as `could not check`, never as a pass.
```

## A miss is not an inconclusive

Two answers a search can give when it does not find a quote, and they mean
opposite things:

- **a miss** — the quote is not in the stored text *and the extraction reports
  complete coverage*. The source does not contain that sentence. This is a real
  finding against the claim.
- **an inconclusive** — the quote was not found and the text is not known to be
  complete, so nothing follows. The passage may be on a page the extractor
  dropped.

Reporting the second as the first is slandering a source. When a finding says the
extraction reported no coverage, the repair is to improve the text: read more of
the source (`pdf_read`, or `ocr` for a scan) and ingest what it returns as `text=`
with the `coverage` it reports. Do not touch the sentence.

`text-missing` is the same shape of problem at the source level: a source with no
stored text is **uncheckable**, so neither its title nor a quote in it can be
checked at all. The fix is to read it and ingest the text — never to re-word the
claim, which would hide an unread source behind a sentence that no longer needs
one. And a claim with no source at all (`claim-unsourced`) fails `r2` by
construction: bind it to a key and a locator.

## Being the reader for `r3-support`

The judgement is per claim and per passage: does the passage you located support
the sentence **as that sentence is written**? Record four things — the verdict,
the strength verdict, the `reason`, and the `passage` you judged, quoted.

- verdict: `supported`, `partially-supported`, `unsupported`, `contradicted`,
  `misattributed`.
- strength verdict: `aligned`, `overstated`, `understated` — a passage can support
  a sentence that still claims more than the passage holds.
- `judge` names who read it (this session, or a subagent and what it was asked).
  A verdict with no reason is refused, and so is one with no judge: a score with
  no evidence is the one thing this ledger must not hold.
- **Evidence first.** A claim with no locator on any source cannot be judged at
  all. The refusal is the workflow: bind the claim to a quote (or a page) with
  `rs_write`, then judge it. Judging a claim you have not located is judging a
  sentence against nothing.

```text
rs_verify slug=sleep-memory-review action=support
  judge="session model, after reading walker2020 pp. 6-8"
  verdicts=[{ "id": "c0142", "verdict": "supported", "strengthVerdict": "aligned",
      "reason": "the passage reports the association in the same direction, with the
        same population and no causal verb",
      "passage": "slow-wave sleep duration predicted next-day recall" }]
```

```text
r3-support recorded for 1 claim(s) in sleep-memory-review
- judge: session model, after reading walker2020 pp. 6-8
  c0142 -> supported

A verdict is recorded, not proven: the judge, the reason and the passage are all
in the ledger so a reader can disagree with a specific one.
```

`r4-audit` takes the same shape against the claims that already have an
`r3-support` verdict. Asking for it first is refused — an adversarial pass over a
claim nobody has read once is not an audit.

## What the ladder does not establish

Say this to the user in one sentence before anyone publishes. The ladder never
says a source is **real** (r1 is provenance — whose bytes, whose record, which
field from where — and it never says a DOI resolves); it never says a claim is
**true** (r2 and r3 only ask whether the stored words are there and whether they
support the sentence as written); and it never proves that an experiment was
**run**. A run whose ladder is entirely green can still be a document about work
that never happened, and no rung here would notice.

## A wording change clears the verdict

A verdict belongs to a sentence, not to an id. Change a claim's words, its
strength or its source bindings and its status, rung, judge and reason are
cleared, along with the findings a file rung left on it — a finding about a
sentence that no longer exists is not a finding. `rs_write` names every claim it
cleared (`RE-VERIFICATION NEEDED: …`). Say it out loud in the same turn, by id:
quietly editing a checked sentence back to unchecked is the one way this system
could lie to a user. Re-running the file rungs afterwards does not restore the
judgement — `r3-support` is a new read of the new sentence.

## The clean build is the end of the ladder, not the start

`draft=clean` is the mode whose output looks finished, so it is the one that
refuses: on structure errors, on a claim a check found `unsupported`,
`contradicted` or `misattributed`, and until a person has answered gate
`g3-integrity` — which the build opens and only a human may answer in the Research
tab. Until then `draft=watermark` always builds and marks the document. Do not try
to reach a clean build by deleting a bad finding, by re-labelling a verdict, or by
answering the gate yourself; the first two put a false claim in the file and the
third is the thing the gate exists to stop.
