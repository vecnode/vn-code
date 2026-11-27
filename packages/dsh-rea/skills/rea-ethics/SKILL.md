---
name: rea-ethics
description: The boundary around reverse engineering with an agent - analyse only software you own or are authorised to examine, keep commercial decompiler licences in their terms, do not bypass protections or share keys, keep findings about behaviour rather than copying assets, and say what you did not do. Also what to do when the request is for something on the wrong side of that line.
whenToUse: Use at the start of any investigation whose target is not clearly the user's own software, before quoting a decompiler's output in something that ships, before touching a licence check or an anti-tamper path, and when a user asks for a feature "exactly like" a commercial product.
---

# The line, and how to stay on it

REA itself is MIT. The thing you point it at is not covered by that licence, and
the decompiler is a commercial product with its own terms. Three separate
permissions are in play, and an investigation needs all three.

## The three permissions

1. **The target.** Software you own, or are authorised to examine. Interoperability,
   security research on your own systems, education, preservation and analysis of
   your own files are the ordinary cases. Somebody else's machine, a rented app
   you are not licensed to inspect, or a target the user cannot name as theirs is
   not.
2. **The tool.** Hopper, IDA, JEB and Hex-Rays are licensed per user; a trial has
   its own restrictions on automation and output sharing. Having REA installed
   does not grant a decompiler licence, and a cracked copy is not a shortcut -
   it is a different problem.
3. **The output.** A recovered rule is a fact about behaviour. The artwork,
   icons, fonts, strings and code you read are still somebody's copyrighted work.
   Rebuilding the RULE is the point; copying the ASSETS into a product is not.

## What this looks like in practice

- **Ask whose software it is** when the target is not obviously the user's. One
  sentence, before the first `rea_inspect`, not after.
- **Refuse the anti-tamper path.** A request to find and disable a licence check,
  a DRM, an integrity check or a telemetry block is not an investigation of
  behaviour; it is a request to break a protection. Say what you will not do and
  offer the legitimate alternative (a plugin API, an export, the vendor's own
  automation hook).
- **Do not exfiltrate.** REA analyses locally. Do not upload a target, a
  decompiler dump or a credential to anywhere, and do not paste a report that
  contains a key, a token or personal data into a commit.
- **Keep the provenance.** The report names the target, the build, the provider
  and the date. A finding that cannot say what it was derived from is also a
  finding nobody can retract.

## When the answer is no

State the line, then offer the nearest legitimate thing:

| Request | Answer |
|---|---|
| "make my app behave like <commercial app>" | analyse the behaviour the user can observe, rebuild the RULE, do not lift assets |
| "find the licence check and remove it" | no; offer the vendor's plugin/export/automation API instead |
| "inspect this app for me" (not theirs) | ask for authorisation; without it, no |
| "share the decompiler dump with the team" | share the report and the investigation id, not the vendor's output en masse |

## Saying what you did not do

The report's Limits section is part of the artefact, not a disclaimer to hide:
which provider, which build, which claims are readings rather than observations,
and anything you declined to do. A professional reverse-engineering note is
useful precisely because it is bounded.
