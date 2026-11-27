---
name: rea-rebuild
description: Turn a recovered rule into working code - the second half of an investigation. Covers writing the reference behaviour down as a testable rule, choosing an implementation shape that keeps the recovered constants visible, checking the rebuild against the original's own observations, and saying exactly how far the reproduction was verified.
whenToUse: Use after rea-investigate or rea-native has produced a rule, when the user asked for a feature "like that app", when a recovered calculation has to be proved correct rather than plausible, or when a reproduction is about to be called finished.
---

# Rebuilding what was recovered

A rule you can quote is not yet a rule you can ship. The gap is closed by:

1. **writing the rule down as a function with the recovered constants named**,
2. **finding observations to check it against**, and
3. **stating the level of agreement** - exact, within a tolerance, or unverified.

## The rule, with its numbers visible

Keep the recovered constants as named values. A rebuild that folds `0x5c` into
`if (op === 'multiply')` is friendlier, but it hides the evidence that ties the
implementation to the finding. Name them, comment the address or the module they
came from, and keep the mapping one-to-one:

```text
// recovered: 0x5c == IDC_MUL, 0x64 == 100
rule.percentAfterPlus = (previous, current) => (current * previous) / 100
rule.percentAfterMultiply = (current) => current / 100
```

## Observations to check against

In order of strength:

1. **the original's own outputs** for a set of inputs (the strongest: it is the
   behaviour itself);
2. **a vendor reference implementation** (the calculator's public source), which
   is evidence about intent, not about the build;
3. **a model of the original** derived from the same instructions (weakest - it
   can repeat your misreading).

If you have only (3), say so. A reproduction checked against its own reading is
a hypothesis with a test, not a verified port.

## Write the test before the port is declared done

A test that only covers the happy input proves nothing about the branch you
recovered. Cover: the branch you found, the branch beside it, and the boundary
value (the constant itself, one below, one above).

## What "done" sounds like

- "the rebuild matches the original on 3,205 recorded cases" - a measurement;
- "the rebuild matches the published reference for + and ×" - a weaker claim,
  and it names its reference;
- "the rebuild implements the rule as recovered" - honest, and says it is
  unverified against the running original.

Never upgrade the third to the first in the summary. The user can run the
original; you cannot, and the difference is the whole value of saying which one
you have.

## Where the rewrite stops being a rewrite

If the recovered rule depends on data you do not have (a table, a font, an
asset), the rebuild is the rule plus a note about what is missing. Do not
fabricate the missing data to make the demo work: a reproduction that silently
invents its inputs is worse than one that names the gap.
