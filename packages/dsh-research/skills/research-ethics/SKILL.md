---
name: research-ethics
description: Record the statements a journal requires and a reader checks — authors with their CRediT contributions, ethics approval that names the body and the reference number, how consent was taken, funding with grant numbers, conflicts of interest, data availability with an address or a reason, and the use of generative AI — as a validated record that the submission folder prints and the manuscript never carries. Use when a run is heading for submission, when an author asks who should be listed, when consent, approval or data sharing has to be stated, or when the venue's AI policy comes up.
whenToUse: Before a submission — when the authorship list, CRediT contributions, ethics approval, consent, funding, conflicts, data availability or AI use have to be declared; when a journal's required statements come up; when a person asks whether their study needed approval; or when DISCLOSURE_INCOMPLETE is refused.
---

# The statements a reader checks

Five minutes before a submission, somebody writes "Ethics approval was obtained"
and "The authors declare no conflicts of interest". Neither sentence can be checked
by anyone, and both are the kind a reader is right to be suspicious of. So they are
a **record** here: `plan/disclosure.json`, validated when it is written and again
by `r0`, printed as `disclosure.md` inside the submission folder.

**The rule this skill exists for, in one line: this package can check that a
statement is COMPLETE and it cannot check that it is true — and it will never
decide whether a study needed approval.** That is an institution's determination.
An agent that answers it is answering for somebody else, and the person who pays
for it is the researcher.

## The record

```text
rs_plan slug=completion-trial part=disclosure disclosure={
  "authors": [
    { "name": "A. Okonkwo", "credit": ["conceptualization", "methodology", "writing-original-draft"] },
    { "name": "R. Silva", "credit": ["formal-analysis", "visualization", "writing-review-editing"] }
  ],
  "ethics": { "approval": "approved", "body": "the University Research Ethics Committee",
              "reference": "UREC-2026-0142", "consent": "written" },
  "funding": [ { "funder": "the National Institute of Education", "grant": "NIE-2026-77",
                 "role": "The funder had no role in the design, analysis or the decision to submit." } ],
  "conflicts": "none",
  "data": { "availability": "on-request", "location": "the corresponding author, within the terms of the ethics approval" },
  "aiUse": { "used": true, "tools": ["a generative writing assistant"], "scope": "writing",
             "disclosure": "A generative writing assistant was used to edit the prose. All claims, analyses and references are the authors' own." }
}
```

```text
plan/disclosure.json written, and plan/disclosure.md regenerated from it
- path: C:\Users\ana\Desktop\vncode-research\completion-trial\plan\disclosure.json
- 2 author(s), ethics approved, 1 funder(s), no conflicts, data on-request, AI use declared

`format=package` writes these statements as `disclosure.md` beside the title page, and NEVER into the manuscript: a disclosure names people and funders, and a blinded review must not receive it. This package checks that a statement is COMPLETE and cannot check that it is true - whether a study needed approval is your institution's determination, not this tool's.
```

Six fields, and only `authors` is required. Each one answers a question a reader
actually asks.

| field | what it must say, or it is refused |
|---|---|
| `authors` | every author needs at least one CRediT role — an author with no declared contribution is a name on a list |
| `ethics` | `approval` is one of `approved`, `exempt-declared`, `not-required`, `not-applicable`, `pending`; an `approved` or `exempt-declared` needs the `body`, the `reference` **and** how `consent` was taken |
| `funding` | a list of `{ funder, grant }`. An **empty** list is a statement — "none to declare" — and is different from leaving the field out, which says nobody recorded it |
| `conflicts` | the string `none`, or a list of `{ author, what }` |
| `data` | `availability` is `open`, `on-request`, `restricted` or `none`; the first two need a `location`, the last two need a `reason` |
| `aiUse` | `used` true or false. If true, `tools` and `scope` are required; if false, naming a tool or a scope is refused as a contradiction |

## What is refused, and why the wording matters

```text
Refused (DISCLOSURE_INCOMPLETE): an ethics `approval` of approved needs `body`: "approved" with no approving body is a sentence nobody can check
```

- **`DISCLOSURE_INCOMPLETE`** — the statement is shaped correctly and says nothing
  a reader can check. An approval with no body, no reference or no consent; consent
  recorded as `waived` with no reason; data declared `open` with no address
  ("available on request" with nowhere to request is what a reader is entitled to
  read as "not available"); an author with no contribution.
- **`BAD_DISCLOSURE`** — the statement is malformed: an unknown field, a value
  outside its vocabulary, a role that is not CRediT, or an AI declaration that
  contradicts itself (`used: false` with a scope).

The difference matters when you explain it to a user: the first means *finish the
sentence*, and the second means *you have typed a field this package does not
read*.

## Anonymity is the one thing the manuscript must not carry

The disclosure names authors, an approving body and a funder, so it is written
beside the manuscript — as `disclosure.md` next to the title page — and never into
it. The submission folder is built with no title block for the same reason, and a
check asserts that not one author name from the record appears in the anonymized
manuscript. Say this to the user when you build a package: **the two files that
identify the authors are the title page and the disclosure, and both are uploaded
separately.**

## The question you must NOT answer

When a user asks *"do I need ethics approval for this?"*, the answer is not a
classification. It is:

> This package will not decide that, and neither should I. Whether your study needs
> approval, needs consent, or is exempt is your institution's determination — the
> categories are usually exempt, expedited and full review, and which applies turns
> on things I cannot see: your jurisdiction, your institution's rules, your funder's
> terms and who the participants are. What I can do is record what they told you,
> and make sure the record names the body and the reference number so a reader can
> check it.

Then help with what IS answerable: what to collect, what the statement has to
contain, what the venue asks for, and where a weak record would be visible.
`reference/ethics.md` carries the detail — consent and assent, vulnerable
populations, data protection, secondary use, animals, dual use, conflicts, ICMJE
authorship and CRediT, funding, data and code availability, AI disclosure, and the
integrity failures a statement exists to make visible.

## Authorship, and what CRediT is for

The fourteen CRediT roles are the vocabulary: conceptualization, methodology,
software, validation, formal analysis, investigation, resources, data curation,
writing (original draft), writing (review and editing), visualization, supervision,
project administration, funding acquisition.

- **Every author needs at least one**, and the matrix in `disclosure.md` shows who
  did what. A name with no role is the one entry a reader cannot interpret.
- **ICMJE's four criteria decide who is an author at all** (contribution,
  drafting or revising, final approval, accountability for the whole work) — a
  contributor who meets none of them is acknowledged, not listed, and one who meets
  all four cannot be dropped for convenience.
- **Order is a convention, not a fact.** It differs by field and by venue: say what
  the field does and check the venue's guidance rather than importing another
  field's rule.
- **An AI system cannot be an author.** It cannot take responsibility, cannot
  consent to be one, and every policy surveyed says so. Its use is disclosed, not
  credited.

## Before the run goes out

Run `rs_build slug=… format=package` and read `CHECKLIST.md`: it says which
statements the run HAS and which it does not, one line each, in those words. A line
that says "*Funding: not recorded*" tells the author exactly what is missing, which
is worth more than a line telling them to check something.

Then say the honest thing about what a submission is: **the builder can check that
the statements are there and complete, and it cannot check that any of them is
true.** That is what the author's signature means.
