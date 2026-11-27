---
name: rea-native
description: Native-binary analysis through REA - which provider (Hopper, Ghidra, IDA, Kuna) can open which format, what a decompiler's pseudocode is and is not, how to choose the function to look at, how to read a call graph against its callers, and how to state a finding so the provider and its limits travel with it.
whenToUse: Use when the target is an executable, a shared library, a .NET assembly, a firmware image or an Android package, when a previous native finding has to be checked or reproduced, or when a native provider is missing and the user needs to know which one would answer the question.
---

# Native analysis with REA

A native target is a file the user owns and is authorised to examine: `.exe`,
`.dll`, `.so`, `.dylib`, an app bundle's Mach-O, a firmware image, an APK's
`.dex`. REA drives a decompiler the user already has installed, so the answer
depends on which provider is available.

## Providers, and what each is for

| Provider | Opens | The cost that is not in the tool |
|---|---|---|
| Hopper | Mach-O, PE, some ELF | a commercial licence; REA can install a trial with approval |
| Ghidra | almost everything, via a headless project | free, slower, needs a JRE |
| IDA / Hex-Rays | PE, ELF, Mach-O | a commercial licence and a decompiler add-on |
| Kuna | its own formats | the user's own |

Never install a provider for the user. `rea_status` reports what REA can reach;
if nothing can open the format, say which provider would and stop.

## The unit of work is ONE function

"Do what this program does" is not an analysis, it is a rewrite. Start from a
behaviour the user can see - a menu item, a hotkey, a value on screen - and find
the function behind it:

1. the strings near the behaviour (a label, a format string, an error message);
2. the references to those strings;
3. the function that owns the reference;
4. its callers, to see which input reaches it.

Then read that function's pseudocode and its disassembly side by side. The
pseudocode is a rendering of the instructions, not the original source: it
invents variable names, it flattens inlined code, and it can be wrong about
types. When the two disagree, the instructions win.

## What to quote

- the address range you read (`0x180124945`-`0x180124a34`), so the reader can
  find it again in the same provider and version;
- the instructions that carry the decision (the `CMP`/`JZ` pair, the constants);
- the provider and its version. A Hopper pseudocode and an IDA pseudocode of the
  same function are different artefacts, and a finding is only reproducible with
  the one that produced it.

## Behaviour is a separate claim

Static analysis shows what the code CAN do. A rule that "gives 220 for 200+10%"
is a claim about behaviour, and it needs one of: the original run observed, a
test that calls the recovered function, or the reference implementation the
vendor publishes. Say which one you have. If you have none, the claim is a
reading of the code, and it is written as one.

## Portability

Record the file's hash (`rea_inspect`'s target plus the report's metadata) before
quoting addresses: an updated build moves every address, and a finding without
the build it came from is unverifiable next month.
