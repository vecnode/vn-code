---
name: frontend-craft
description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface: websites, landing pages, dashboards, product UI, components, forms, settings, onboarding, empty states, and native iOS or Android screens. Handles UX review, hierarchy, layout, typography, color, motion, UX copy, accessibility, responsive behavior, edge cases, and capturing or documenting design systems (DESIGN.md, tokens). Also for making bland UI bolder, loud UI quieter, or ambitious visual effects. Not for backend-only or non-UI tasks."
---

This skill gives you the tools and permission to make design that earns the name out-of-distribution craft. Work as an award-winning design director would: production-grade code, a clear POV, a deep grasp of what the client and its users need, and exceptional craft.

Core principles:
- Finish the job. No hedging, no shortcuts: the deliverable is complete, except assets the user must provide.
- Scale ambition to the surface's mode (see Modes). Persuade and Experience get full commitment: bold, distinct work with a point of view. On Operate and Read, ambition shows as precision and restraint, and patterns the visitor already knows earn their place.
- Verify by looking at the rendered result at the sizes it ships at, and batch the checks: fix what one look shows before looking again, rather than screenshotting after every tweak.

## Where this skill comes from

The craft corpus below is [Impeccable](https://github.com/pbakaus/impeccable) 4.6.0 by
Paul Bakaus, vendored at a pinned commit under the Apache-2.0 licence. The rules it
references are the same release's detector, compiled to WebAssembly and shipped inside
the `dsh-frontend-craft` plugin. Nothing here installs anything, downloads anything, or
calls a network service: the corpus is on disk, the detector runs from the plugin, and a
capability this harness does not have is **named as unavailable** rather than emulated.

## Tool surface

The references were written for Impeccable's own engine binary. Wherever one says
`impeccable <verb>`, translate it through this table **before acting**. A verb marked
UNAVAILABLE is not attempted; follow the reference's design intent only as far as this
table allows, and say which part you could not run.

| The reference says | You call |
|---|---|
| `impeccable context` | `fe_context` |
| `impeccable detect <target>` | `fe_detect` (`target`, optional `rules`, `includeAdvisory`) |
| `impeccable surface-brief read <target>` | `fe_artifact` action `read`, kind `surface`, target |
| `impeccable surface-brief write <target> <body-file> [related...]` | `fe_artifact` action `write`, kind `surface`, target, body |
| `impeccable concept-seed <flags>` | `fe_direction` action `deal` (local: no catalog, see below) |
| `impeccable serve-question <flags>` | `fe_direction` action `ask` (the answer comes from the person) |
| `impeccable doctor` | `fe_context` - it reports the same drift, read-only |
| `impeccable <any other verb>` | **UNAVAILABLE** - say so in one line and continue with the reference's intent |

Two tools are this build's own and no reference names them:

- **`fe_render`** - render the page (an HTML file in the workspace, or a loopback
  dev-server URL) in a throwaway headless browser and measure it. Use it wherever a
  reference says to verify the rendered result, look at the sizes it ships at, or
  check contrast/tap targets/overflow; its findings are the `render-*` MEASURED
  rules, separate from the source rules `fe_detect` reports. It needs Chrome or
  Edge on the machine; with neither, say the render could not run and audit from
  the code.
- **`fe_direction`** - the local roll (the table above), and the only way a
  direction round happens here.

UNAVAILABLE here, and why:

- `live`, `live-*`, `generate-image`, `generate`, `comp-*`, `font-match`, `visualize`'s comp
  round, `build-phase`, `component-review`, `critique-storage`, `embed-prompt`,
  `detect-csp`: these run Impeccable's browser-automation and image pipeline. This harness
  has no image generation and this plugin drives no dev server, so a comp-led build cannot
  happen. **Every surface is code-led**: the ambition lives in the direction contract and
  the finish review, exactly as the references describe the code-led path.
- `hook`, `hook-before-edit`, `hooks`, `ignores`, `pin`, `unpin`, `update`, `signals`: the
  harness has no edit hook and no `/` command menu, and this plugin installs nothing, so
  there is nothing to hook, pin or update. Run `fe_detect` explicitly instead of relying on
  a hook.
- `doctor --fix`: `fe_context` is read-only. A `CONTEXT_STALE` directive is reported, never
  repaired as a side effect (the references' own rule).

**The difference that matters most: the roll has no catalog.** Impeccable's
`concept-seed` deals challenger worlds from a catalog served by its own API. That catalog
is not in the open-source repository and cannot travel with this plugin. `fe_direction`
therefore keeps the *procedure* and drops the *deck*: it deals from the directions you
authored in the step before, with a seed, so the assignment is deterministic, is not your
favourite, and is re-rollable. What you lose is the outside view - a challenger built from
a world you would not have thought of. What you keep is the discipline: seven grounded
directions, a dealt lead, an assigned direction you must build or argue with, and a
standing exit. Never describe the result as a catalog roll.

## Setup

1. Call `fe_context` once per session. Pass `target` when the request names a file or
   route. It returns product truth (`PRODUCT.md`), the design system (`DESIGN.md`), the
   matching surface brief, `config.json`, the platform and visitor mode, the rule count,
   and the directives a missing or stale artifact earns. Follow those directives; do not
   call it twice in one session unless the target changes.
2. Load the request's playbook: its Commands-table reference for an explicit or implied
   sub-command, or [reference/new-work.md](reference/new-work.md) for a new surface or
   replacement visual world. Inspect the target and the incumbent visual truth before
   editing. When the app cannot run, start with committed visual-regression goldens or
   screenshot fixtures; verify target and freshness against current tokens, CSS,
   components or assets, resolve conflicts, and compare theme/variant captures.
3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md)
   immediately before any UI edit, including small refinements. It carries the quality
   floor, the absolute bans, and the reflexes no detector catches. Do not load it for
   planning-only work.

**When `fe_context` fails:** send a separate message **before the next tool call**: "Context
loading did not run; I'll read the existing project context directly." Then read existing
`PRODUCT.md` and `DESIGN.md` without inventing missing context, follow steps 2-3, and
continue. A failed tool alone does not block planning or editing.

## Verifying what you built

Two things, in this order, and neither replaces the other:

1. **`fe_detect`** finds what 61 deterministic rules can see: the AI-slop tells, contrast
   pairs, type hierarchy, spacing, touch targets, and a long tail of layout mistakes. It is
   evidence, not proof: a clean run says nothing about whether the page is good, and it
   never sees the rendered experience. Run it on the files you touched before you call work
   finished.
2. **The rendered result, measured.** Call `fe_render` on the page at the sizes it
   ships at (a phone width and a desktop width is the floor). It returns the picture
   and the `render-*` findings: contrast pairs, touch targets under 24px, horizontal
   overflow, line length, body text under 12px, skipped headings, images with no alt.
   Look at the picture as well as the numbers: the numbers catch defects, the picture
   catches a page that is technically fine and still wrong. If the host has no
   browser, or the page only exists behind a build, say so plainly and audit from the
   source instead - never imply you looked at a render you did not make.

A finding is not automatically a defect: the brief is the reference. When a rule fires on
something the brief pinned on purpose, waive it inline with the marker the engine itself
reads - `<!-- impeccable-disable <rule>: <reason> -->`, or the comment syntax of the
language - rather than silently ignoring it. The marker keeps upstream's spelling because
that is the string compiled into the detector; it is not a path or a brand claim.
