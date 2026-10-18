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
2. **A look at the rendered result** at the sizes it ships at. If this harness has a render
   tool in the conversation (for example dsh-browser's `browser_render` when that row is
   enabled), use it; otherwise ask for a screenshot or read the layout from the code with
   the numbers spelled out. Say which one you did.

A finding is not automatically a defect: the brief is the reference. When a rule fires on
something the brief pinned on purpose, waive it inline with the marker the engine itself
reads - `<!-- impeccable-disable <rule>: <reason> -->`, or the comment syntax of the
language - rather than silently ignoring it. The marker keeps upstream's spelling because
that is the string compiled into the detector; it is not a path or a brand claim.

## How to design

- **The brief wins.** Honor pinned aesthetics, eras, materials, fonts, and palettes even when they conflict with a saturated-pattern warning. Redirecting a clear brief toward your taste is failure.
- **Refinement preserves; redesign replaces.** Refinement keeps the incumbent identity, behavior, copy, and everything outside scope. Ask before replacing factual copy or adding claims. Redesign keeps product truth, content, function, native affordances, and constraints, but treats the old look as evidence and anti-reference; choose a replacement world in new-work and replace DESIGN.md. Never split the difference into polish on the discarded look.
- **Loaded symbols stay out of the decoration.** A subject's world does not license emblems tied to militarism, supremacy, or hate movements as motifs, badges, or ornament, such as the Rising Sun flag's rays, the Confederate battle flag, or Nazi-era insignia and their stylised variants; reach for that world's neutral forms instead. Content that documents such a symbol as fact stays as it is.
- **Visual authority is evidence, not a filename.** Missing DESIGN.md alone does not make a project greenfield; new-work decides whether to preserve, expand, or replace the incumbent world.

## Modes

The mode names what the visitor's success looks like on this surface.

- **Persuade:** the visitor decides and acts; design is the product. Landing pages, marketing, campaigns, pricing. Earn attention and action. Ship real imagery when the brief needs it; follow the committed world, not category habit.
- **Operate:** the visitor completes a task. App UI, dashboards, editors, admin, settings, tools. Scanability, consistency, native expectations, and the real usage scene outrank expression. Brand lives in precise details.
- **Read:** the visitor understands something. Docs, articles, guides, help, changelogs. Structure for comprehension, then make the reading experience worth staying in.
- **Experience:** the visitor is inside the work itself. Portfolios, galleries, showcases. Let the artifact lead from the first viewport; the interface recedes.

Choose the mode from the requested surface, not the product, and persist it only in that surface brief. A tool's landing page is still Persuade; a fashion house's documentation is still Read; a docs index is Read, not Persuade. See [new-work.md](reference/new-work.md) for new surfaces and [operate.md](reference/operate.md) for deeper Operate/Read guidance.

## Commands

| Command | Category | Description | Reference |
|---|---|---|---|
| `craft [feature]` | Build | Deprecated alias for an ordinary new-work request | [reference/craft.md](reference/craft.md) |
| `shape [feature]` | Build | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |
| `init` | Build | Capture durable product context in PRODUCT.md | [reference/init.md](reference/init.md) |
| `document` | Build | Generate DESIGN.md from existing project code | [reference/document.md](reference/document.md) |
| `extract [target]` | Build | Pull reusable tokens and components into design system | [reference/extract.md](reference/extract.md) |
| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |
| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) · native: [reference/audit.native.md](reference/audit.native.md) |
| `polish [target]` | Refine | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |
| `bolder [target]` | Refine | Amplify safe or bland designs | [reference/bolder.md](reference/bolder.md) |
| `quieter [target]` | Refine | Tone down aggressive or overstimulating designs | [reference/quieter.md](reference/quieter.md) |
| `distill [target]` | Refine | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `harden [target]` | Refine | Production-ready: errors, i18n, edge cases | [reference/harden.md](reference/harden.md) |
| `onboard [target]` | Refine | Design first-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `animate [target]` | Enhance | Add purposeful animations and motion | [reference/animate.md](reference/animate.md) |
| `colorize [target]` | Enhance | Add strategic color to monochromatic UIs | [reference/colorize.md](reference/colorize.md) |
| `typeset [target]` | Enhance | Improve typography hierarchy and fonts | [reference/typeset.md](reference/typeset.md) |
| `layout [target]` | Enhance | Fix spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `delight [target]` | Enhance | Add personality and memorable touches | [reference/delight.md](reference/delight.md) |
| `overdrive [target]` | Enhance | Push past conventional limits | [reference/overdrive.md](reference/overdrive.md) |
| `clarify [target]` | Fix | Improve UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |
| `adapt [target]` | Fix | Adapt for different devices and screen sizes | [reference/adapt.md](reference/adapt.md) · native: [reference/adapt.native.md](reference/adapt.native.md) |
| `optimize [target]` | Fix | Diagnose and fix UI performance | [reference/optimize.md](reference/optimize.md) |
| `live` | Iterate | Visual variant mode: pick elements in the browser, iterate on alternatives | [reference/live.md](reference/live.md) |
| `generate [n] [action] [element]` | Iterate | Variants, versions, or alternatives of a named element to choose from in the live browser; no manual picking | [reference/generate.md](reference/generate.md) |

Routing:

- **No argument:** read [routing.md](reference/routing.md) and present its context-aware menu; never auto-run a command.
- **Explicit or clearly implied request to run a command:** load its reference (native variant on native platforms) and follow it. Ask once if two commands fit.
- **Workflow or command-selection question:** read [Workflow questions](reference/routing.md#workflow-questions).
- **Otherwise:** treat the request as general design work. Missing PRODUCT.md routes a new surface or replacement world through init, then new-work; a narrow refinement of existing code proceeds on the incumbent implementation as `impeccable context` directs, offering init afterward rather than blocking on it.
- `teach` aliases `init`. `craft` is a deprecated alias for ordinary new-work and adds nothing. `shape` owns task discovery, then enters new-work only for visual-world and surface-concept decisions.

After init writes PRODUCT.md, resume without rerunning `impeccable context`; init loads the native platform reference itself when the platform it recorded is `ios`, `android`, or `adaptive`.
