---
name: research-writing
description: Write the document of a research run — plan the question and the outline with rs_plan, write prose and declare its claims together with rs_write, choose the claim strength the evidence actually holds, follow the section structure the run's kind maps to, read the draft back, and build a watermarked draft before the gated clean build. Use when a run's document has to be written, a section drafted, a claim bound to a source, or a build attempted.
whenToUse: When a research run's plan or document has to be written or revised, when a claim needs a strength and sources, when the run's structure (IMRaD, thematic review, theoretical, case study, policy brief, conference) has to be followed, or when `rs_build` is about to be called.
---

# The document

Writing here is two acts in one call: the prose, and the ledger rows for every
claim the prose makes. `rs_write` will not let them come apart, and that is the
whole reason to use it rather than typing Markdown into a file.

## Plan first — `rs_plan`

Three parts, written to `plan/<part>.md`:

- `part=rq` — the research question, in one sentence you could falsify. This is
  what gate `g1-rq` shows the person to confirm.
- `part=outline` — the shape. This is the one part with a **machine meaning**:
  lines of `- <slug>: <title>` order the section files at build time, and a section
  file no line names is appended to the end rather than dropped.
- `part=method` — how the work was done: what was searched, what was included and
  excluded, how sources were read.

`rs_write slug=… section=memory` writes `doc/sections/memory.md`, so an outline
line `- memory: Sleep and memory consolidation` is what puts it in order. Read
`part=outline` back with `rs_plan action=read part=outline`.

**Pick one shape and keep it.** With any file in `doc/sections/`, the builder
assembles the document from the sections and ignores `doc/paper.md` entirely; with
no sections at all it uses `doc/paper.md`. Mixing the two is how a chapter goes
missing without anyone noticing.

## The dialect — prose and claims in one call

`[the sentence, as written]{#cNNNN}` is a claim. `[@key]` is a citation, and the
variants are Pandoc's: `[@key, p. 7]` and `[-@key]` (author suppressed) and
`[@a; @b]`. Claim ids are `c` and at least four digits; ids are never reused.

```text
rs_write slug=sleep-memory-review section=memory
  text="Sleep after learning is associated with better retention [@walker2020cognitive].
    [Slow-wave sleep duration predicted next-day recall in the sample studied]{#c0142}
    [@walker2020cognitive, p. 7]."
  claims=[{ "id": "c0142", "strength": "associational",
    "sources": [{ "key": "walker2020cognitive",
      "locator": { "kind": "quote", "quote": "sleep-dependent consolidation of declarative memory" } }] }]
```

```text
doc/sections/memory.md written (replace)
- path: C:\Users\ana\Desktop\vncode-research\sleep-memory-review\doc\sections\memory.md
- words: 31
- claims in this text: 1 (1 new)
- citations: walker2020cognitive

Next: `rs_build slug=sleep-memory-review format=md draft=watermark` to read it, or keep writing sections.
```

Three rules the tool enforces rather than trusting you with:

- **The claim's text comes from the SPAN.** Do not retype the sentence in `claims`
  — there is nowhere to put it. The row's `text` is read out of the prose, so the
  ledger and the document cannot disagree.
- **A span with no declaration, or a declaration with no span, is refused**
  (`CLAIM_UNDECLARED` / `CLAIM_SPAN_MISSING`). That is the tool stopping a claim
  nothing tracks from being stored.
- **Every `[@key]` must already be in the ledger** — `rs_cite` first, or the write
  is refused with the nearest keys (`UNKNOWN_CITATION`).

`section=` writes `doc/sections/<slug>.md`; omit it to write `doc/paper.md` whole,
and `file=doc/…md` names a path explicitly. `mode=append` adds to what is there
instead of replacing it.

## Strength is the sentence's own claim about itself

`causal` / `associational` / `descriptive` / `theoretical` / `normative` — pick the
one the evidence holds, not the one that reads better. A `causal` claim over a
source that only shows a correlation is a defect of the sentence, fixed by
rewriting the sentence, not by re-labelling it. Write the verb the evidence can
carry:

- *before* — `strength: "causal"`: `[Sleep deprivation causes memory loss]{#c0143}`
- *after* — `strength: "associational"`: `[Sleep deprivation is associated with
  poorer memory performance]{#c0143}`

Both sentences may rest on the same source; only the second is one the source can
support. Fixing this later costs a rewrite that **clears the claim's verification**
(the sentence changed, so the verdict about the old sentence is void) — so choose
the strength while you write, and use `descriptive` for what a source reports
(a number, a prevalence, a definition), `theoretical` for a claim from a model or
an argument, and `normative` for what ought to be done, which no datum settles.

## The structure the run's kind maps to

`rs_new` recorded the run's `structure`; write the document in that shape rather
than as a generic essay. What belongs where:

- **imrad** (`paper`) — *introduction*: the problem, the gap, the question, and the
  contribution. *methods*: what was done, in enough detail to repeat. *results*:
  what was found, reported without interpretation. *discussion*: what it means,
  against the literature, with limits and what would falsify it.
- **thematic-review** (`review`, `lit-review`) — *introduction*: the question and
  why the field needs it. One section per theme (the outline names them): what the
  sources agree on, where they conflict, and the evidence on each side.
  *synthesis*: what the body of work supports and what remains open. *limitations*:
  search and inclusion limits, and the bias they carry.
- **theoretical** — *framework*: the concepts and their definitions. *development*:
  the argument, step by step, each step resting on a stated source. *implications*:
  what follows if the argument holds. *scope*: what the argument does not claim.
- **case-study** — *context*: the case, its boundaries, why it is the case.
  *data and method*. *analysis*: the case against the framework or the theory.
  *discussion*: what generalises and what does not.
- **policy-brief** — *problem*: one paragraph a decision-maker can act on.
  *evidence*: what is known, with the strength stated. *options*: what could be
  done, with costs and who bears them. *recommendation*: one, and why.
- **conference** — *introduction*, *method*, *results*, *discussion*, in the page
  budget the venue sets; the short form of IMRaD, so a claim has to carry its
  source in fewer words, not in weaker ones.
- **custom** (`report`, `protocol`) — you choose the sections and name them in
  `plan/outline.md`; a protocol's sections are its steps, a report's are its
  findings.

Sections outside those names are fine — the outline orders whatever you write —
but a section that answers no part of the structure is usually an essay forming.

## Read your own draft before building

`rs_read what=outline` shows the assembled sections with word and claim counts;
`what=claims` shows every claim with its status, its strength as written and the
source each rests on; `what=run` shows the structure verdict and what is still
waiting on the person. Act on what they say rather than waiting for a build to
refuse:

- `span-unrecorded` / `unknown-source` / `broken-marker` / `broken-citation` are
  **errors** — a clean build refuses on them (`BUILD_BLOCKED`).
- `claim-unsourced` and `claim-orphan` are **warnings** — a claim bound to no
  source, or a ledger row whose sentence is gone. Nothing blocks, and the first
  one means the claim can never be checked.
- `rs_write` names unbound claims in its own answer (`NOT BOUND TO A SOURCE`), so
  bind them at write time.

## Two refusals you will meet

- **`GATE_UNANSWERED` on `rs_write`** — gate `g1-rq` is not answered, so nobody has
  confirmed the question the document answers. Stop and ask the person once, in one
  short message, and point them at the Research tab. Do not write around it, do not
  write "while you wait", and never answer the gate yourself.
- **`GATE_UNANSWERED` / `BUILD_BLOCKED` / `BLOCKING_CLAIMS` on `draft=clean`** — a
  clean build needs the document to agree with its ledger, no claim a check found
  unsupported (`unsupported`, `contradicted`, `misattributed`), and gate
  `g3-integrity` answered by the person. Build a draft instead.

## Building

```text
rs_build slug=sleep-memory-review format=md draft=watermark
```

`draft=watermark` **always builds**, and marks the document: a banner at the top
and an endnote on every claim naming its status and its rung. That is what stops a
half-checked document being mistaken for a finished one. `draft=clean` is the mode
whose output looks finished, so it is the one that is gated.

**Read `rs_open action=capabilities` for what this build can write and which
citation styles it has** — do not carry a list in your head. Formats and styles are
added over time, and the answer there is the authority; a remembered list goes
stale the day one arrives. (Today the run's own style is the default; `format=all`
writes every format this build has, and a format that is not in yet refuses by
name and says which phase brings it.)

Every build writes `build/build.json` beside the artifacts — the document's sha256,
the claim statuses at that moment, the structure verdict, and each output's hash —
and `rs_read what=build` shows it. A clean build removes the claim markers and the
banner; a draft keeps them. **The reference list is never typed by you**: it is
computed from the ledger in the run's citation style. So a missing field in a
source record is a missing field in the bibliography, and the fix is another
`rs_cite`, not a sentence added by hand.

## Rewriting clears verification — say so out loud

If a claim's sentence or its source bindings change, its status, rung, judge and
reason are **cleared**: a verdict belongs to a wording, not to an id. The answer
names every claim it cleared:

```text
RE-VERIFICATION NEEDED: c0142 changed wording or sources, so the verification it
had was cleared. A verdict belongs to a sentence, not to an id.
```

Tell the person that in the same turn, by id and in plain words — quietly editing a
checked sentence back to unchecked is the one way this system could lie to them.
The same answer also lists claims still waiting on a gate
(`STILL WAITING ON THE USER: g2-intake`), which is a thing to report, not to fix.
