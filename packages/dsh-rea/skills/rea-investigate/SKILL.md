---
name: rea-investigate
description: Run one reverse-engineering investigation with the rea_* tools - scope the target, ask ONE question, let REA answer it, read the evidence as slices, then explain or rebuild. Covers the tool order (rea_status, rea_inspect, rea_read, rea_report), what a target may be, what an investigation id is for, and the difference between what REA returns (code, pseudocode, references) and what you may claim (behaviour you verified).
whenToUse: Use when the user asks how a program, app, game or website does something, when they want a feature from another product rebuilt, when a binary or an .asar has to be understood without its source, or when a previous investigation has to be reopened or handed to somebody else.
---

# Investigating something with REA

REA is a program on the user's machine that inspects other programs: native
binaries, JavaScript and Electron apps, .NET assemblies, websites, and recorded
runtime traffic. It returns code, pseudocode, references and the limits of what
it could see. This skill is the loop around it.

## The order, and why it is that order

1. **`rea_status` first, with `help:true`.** REA's command names are not
   stable across its releases. The listing `rea_status` returns is the only
   source of truth for the installation in front of you; `rea_inspect` refuses a
   command it has not seen. Do not guess `analyze-native-binary` - read it.
2. **One question, one target.** "Why does the dinosaur speed up?" is a target
   (the game's script) and a question (the speed rule). "Tell me about this app"
   is neither, and produces a report nobody can check.
3. **`rea_inspect`** with the narrowest target that can answer the question: one
   file, one module, one function's caller, not the whole install directory.
   The answer is a summary and an investigation id.
4. **`rea_read`** the stored investigation in slices. The report is often
   megabytes; `section:raw` with `offset`/`limit` is how you walk it. Read the
   part the question is about, not the whole document.
5. **`rea_report`** with the user's own question, so the finding leaves a
   Markdown file that names its evidence and its limits.

## Scope, before anything runs

A local target must be inside the session workspace. Anything else is refused by
name unless the user authorised a folder for that call: pass `allowRoot` with
the folder they named. A URL is refused unless `allowUrl:true` - this row starts
no network egress of its own, and a page is the user's target, not yours.

Never widen the scope to "make it work". If the target is outside the workspace,
ask for the folder and pass it.

## Evidence, not vibes

REA returns artefacts. When you write the answer:

- quote the recovered code or the decompiler's output, and say which
  investigation it came from (`rea_read`, id, line range);
- separate **what the tool showed** from **what you inferred**. "The handler
  compares the operator against 0x5c and 0x5b" is evidence. "So the % key means
  10% of the first number" is your reading of it - say so, and say what would
  falsify it;
- if you rebuilt the behaviour, run the rebuild against the original's
  observations (see `rea-rebuild`);
- state the provider: a native finding from Hopper, Ghidra, IDA or Kuna is not
  the same evidence as a static JavaScript pass.

## What to do when REA says no

| Answer | What it means |
|---|---|
| `rea_status` finds nothing | REA is not installed. Name the install command (`npm install --global rea-agents`) and stop; do not install it for the user. |
| a target is refused | it is outside the workspace (pass `allowRoot`) or a URL (pass `allowUrl` only if the user asked for that page) |
| REA exits non-zero | the command name or the target kind is wrong; re-read `rea_status` help, and the stderr names the reason |
| the JSON is empty or not JSON | the report is still stored; `rea_read` `section:raw` shows what it printed |
| the analysis times out | narrow the target or raise `timeoutMs` (the ceiling is 10 minutes) |

## Handing it over

`rea_report` writes the Markdown; `rea_snapshot` action:export writes one JSON
bundle. A report that cannot be re-run is an anecdote, so the report names the
command, the target, the provider and the investigation id.
