---
name: research-project
description: Run a research project as a folder on disk — open the run root first, record the user's own instruction verbatim, open the two frame gates and stop for the human to answer them, and keep the stage the ledger says it is. Use when the user asks to start, resume or check a research run, a paper, a review, a brief, a report, a literature review or a protocol.
whenToUse: When the user asks for research, a paper or document, a literature review, a protocol or a brief; when an `rs_*` tool is available or the Research tab is mentioned; when a run has to be started, resumed after a pause or compaction, or checked for what it is waiting on.
---

# Research runs

A run is a **folder you fill**, not text that lives in the chat. `RUN.json` says
what it is, `passport.json` says what the human decided in their own words, and
the rest of the folder is the work. Call `rs_open action=roots` before anything
else in any session where research is mentioned.

## Where runs live

`rs_open action=roots` prints the root, why it was chosen, and how many runs are
already there. The ladder is `$DSH_RESEARCH_ROOT` (an explicit choice, and a
relative value resolves against the workspace), else `<Desktop>/vncode-research`,
else `<workspace>/research` when the machine has no Desktop at all. The default
is deliberately a place the person can see: a document is something they keep and
hand to a journal, not something buried in a checkout. Quote the absolute root
back when you say where the work is.

## The folder is the deliverable

```
<root>/<slug>/
  RUN.json      what it is: title, kind, language, style, structure, timestamps
  passport.json the user's instruction VERBATIM, every gate answer, the receipts
  plan/         the research question and the plan
  doc/paper.md  the document's source of truth  (doc/sections/ for its parts)
  ledger/       claims.jsonl, sources.jsonl, reviews.jsonl — one record per line
  sources/      the files themselves: PDFs, notes, data
  figures/      generated pictures
  reviews/      critiques kept beside the work
  build/        outputs; never a source
```

Read `RUN.json` and `passport.json` to answer "what is this run", never a guess
from the folder name. Leave `build/` disposable: nothing a person needs should
exist only there.

## Start a run: `rs_new`

Pass the user's actual words in `instruction`. Not a summary, not a tidy-up, not
your restatement of what they want. The passport quotes that text back after
every pause, compaction and handoff — it is the only record of what was asked
for, and a paraphrase in it is a paraphrase of the requirement. Keep the user's
own phrasing even when it is informal, and tell them you recorded it as they
wrote it and where it is stored.

`slug` is the folder name and the run's identity: 3-64 characters of lowercase
letters, digits and dashes. `title` is the document's own name.
`rs_new slug=… title=… kind=… instruction=…` is the whole call; `kind` and
`style` are refused rather than recorded when they are not in the tool's enum.

## The two gates — a person answers them, never you

`rs_new` opens `g1-rq` (*is this the research question you actually want
answered, and is it yours?*) and `g2-intake` (*does this document report
experiments or data analyses that YOU ran yourself?*). Both are pending the
moment the run exists, and the agent must not answer either. `g2-intake` is
**fail-closed**: it demands the user's own text even when the answer is a plain
"no", because "did you run these experiments" is exactly the question a model
must never settle on a human's behalf. An answer you supply makes the ledger
worthless.

The correct behaviour after `rs_new` is one short message to the user and then
stop:

- say the run exists, give its path, and say the two questions are waiting in the
  Research tab in the right bar;
- name them, and say the second needs their own words even for a plain "no";
- do not write `doc/paper.md` past the frame, and do not draft the document
  "while you wait".

Rule on the agent: **writing past the frame before the gates are answered is the
failure this plugin exists to prevent.** Answering "revise" or "stop" on `g1-rq`,
or "yes" on `g2-intake`, additionally demands a recorded reason, and a second
answer to the same gate is refused (`GATE_ALREADY_ANSWERED`) because the ledger
records what was decided and is not edited in place.

### A worked first ten minutes

The user asks: *"Can you put together a literature review on sleep deprivation
and memory consolidation? I want it in APA, in English."*

```text
rs_open action=roots
```

```text
Research runs
- root: /Users/ana/Desktop/vncode-research
- chosen because: the DESKTOP (/Users/ana/Desktop) - a document is something a person keeps and hands to a journal, so by default it lands where they can see it
- runs on disk: 0
- workspace: /Users/ana/projects/thesis
- DSH_RESEARCH_ROOT overrides all of it (a relative value resolves against the workspace)
- this plugin opens no socket: a source is a file you or the agent already has, never something this plugin fetches

Next: `rs_open action=list` for what is here, or `rs_new` to start a run.
```

```text
rs_new slug=sleep-memory-review title="Sleep Deprivation and Memory Consolidation: A Literature Review" kind=lit-review language=en style=apa7 instruction="Can you put together a literature review on sleep deprivation and memory consolidation? I want it in APA, in English."
```

```text
Created run sleep-memory-review - Sleep Deprivation and Memory Consolidation: A Literature Review
- path: /Users/ana/Desktop/vncode-research/sleep-memory-review
- kind: lit-review  structure: thematic-review  style: apa7  language: en
- folders: plan/ doc/ ledger/ sources/ figures/ reviews/ build/

TWO GATES ARE NOW WAITING ON THE USER. Do not answer them, and do not write the document past the frame until they are answered:
  g1-rq: Is this the research question you actually want answered, and is it yours?
      - confirm: Yes - this is the question, and it is mine
      - revise: Not yet - the question or the plan has to change
      - stop: Stop this run here
  g2-intake: Does this document report experiments or data analyses that YOU ran yourself?
      - no_experiments_declared: No - this run reports no experiments of mine
      - experiments_declared: Yes - I ran experiments this document reports

Tell the user this, then stop: Look at it in the right bar: the Research tab (`sleep-memory-review`). Gates are answered there, not here.
```

The reply to the user, and then nothing else:

> I've started the run at
> `/Users/ana/Desktop/vncode-research/sleep-memory-review` — your request is
> recorded in it exactly as you wrote it. Two questions are waiting for you in
> the Research tab in the right bar: whether this is the research question you
> actually want answered and whether it's yours, and whether this document
> reports experiments you ran yourself. The second needs your own words even if
> the answer is just "no". I'll pick the work up once they're answered.

### Reading a pending gate, and knowing it is answered

`rs_open action=status slug=sleep-memory-review` while both are open:

```text
WAITING ON YOU - 2 gate(s). The agent must not answer these:
  g1-rq: Is this the research question you actually want answered, and is it yours?
  g2-intake: Does this document report experiments or data analyses that YOU ran yourself?
      (this one needs YOUR words in the answer box, even for a plain yes or no)

Look at it in the right bar: the Research tab (`sleep-memory-review`). Gates are answered there, not here.
```

The user answers `g1-rq` with `confirm` in the tab. The same call now reports the
full ledger and one gate left, and the stage is `framing`:

```text
- stage: framing - one frame gate is answered and one is still pending
- gates: 1 answered, 1 pending
```

A gate is answered when its answer is on disk and `rs_read what=gates` or
`rs_open action=handoff` shows it with a value and a timestamp — never because
the user said so in chat, and never because you inferred it. Once both are
recorded the stage is `framed`, and only then do you write the research question
and the plan into `plan/` and begin the document.

## Stage is decided by the ledger

`new` means both gates are pending, `framing` means one is, `framed` means both
are answered. Nothing is further along than the answers say, and there is no
later stage to claim yet. Report the stage the ledger gives you and never
announce a step as done because you did it in this turn.

## Handoff: the anti-drift call

Run `rs_open action=handoff slug=…` after any pause, compaction, session resume,
subagent round-trip, or before you act on a summary of the run — including your
own. It reprints the original instruction and every gate answer **in the user's
exact words**, with timestamps and the recent receipts. Quote that text rather
than your recollection of it, and when it contradicts what you were told or what
you assumed, the ledger wins and you say so to the user.

## Read inside a run with `rs_read what=file`

`rs_read slug=… what=file file=doc/paper.md` is the way to read anything in a
run. It stays inside the run folder, caps how much it returns, and refuses a
binary by name instead of returning mojibake. A raw filesystem read skips that
containment and is the wrong move. `what=files` lists what is there,
`what=passport` shows the instructions and receipts, `what=run` is the view. A
PDF kept in `sources/` is read with the `pdf_*` tools and the text passed onward;
`rs_read` is not a PDF reader and will say so.

## What this plugin refuses, and why that is a feature

It opens no socket, so a source is a file the person or the agent already has —
literature comes from the `web_fetch` / `web_search` tools and lands in
`sources/`. It spawns no process and reads no credential. It writes only inside a
run folder, it revision-controls nothing, and it deletes nothing: the folder is
the user's. And it cannot answer the two questions that belong to the human. When
a call is refused it names the rule it hit — a bad slug, a path that leaves the
run, a slug that already exists, a gate already answered, an option that gate
does not offer, an answer that needs the user's words or an override's reason.
Report the refusal as the answer it is, and fix the call rather than working
around it.
