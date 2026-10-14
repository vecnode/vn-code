# dsh-proto-lab (alpha.1)

**A prototyping lab the agent can fill: five tools that write real, runnable
prototypes — p5.js sketches a browser opens, openFrameworks projects that are
three C++ files and build into an app — plus a checked example library, a runtime
registry built so a third language is one module, and an honest answer about how
far anything here was actually verified.**

Most "generate a sketch" surfaces produce an artifact that lives in the chat and
dies there. This one writes a **folder** into the workspace, groups it by runtime,
records it in a catalog, and can prove it runs: the render check drives a real
browser and reads the canvas back.

## What it adds

- **Five tools, named by intent.** `lab_open` (where the lab is, what is in it),
  `lab_runtimes` (what can be written, what this machine can verify, what examples
  ship), `lab_new` (write a run), `lab_read` (show me one), `lab_lint` (is it
  still sound). The pack's rule: six near-synonyms for "make a sketch" would spend
  the model's attention on the choice instead of the sketch.
- **A run is a real folder**, on the DESKTOP by default - `~/Desktop/vncode-lab/runs/<runtime>/<slug>/`, with `prints/` and `apps/` beside it:
  - **p5.js** — `sketch.js` (the prototype), `index.html` (a generated shell:
    library, seed, controls from the sketch's own `params`), `p5.min.js` (vendored
    so the run is offline), `README.md`, `NOTES.md`.
  - **openFrameworks** — `src/main.cpp`, `src/ofApp.h`, `src/ofApp.cpp`, plus
    `addons.make`, `bin/data/`, a README with the exact build recipe and a
    `.gitignore` that keeps the app out of every commit.
- **Nothing is ever a dead artifact.** `lab_lint` judges a run against its own
  runtime: a p5 run must seed itself, define `setup()`/`draw()`, load its library
  and reach for no network; an openFrameworks run must derive from `ofBaseApp`,
  declare *and define* the virtuals, and start a real loop.
- **A committed example library.** `skills/*/examples/<slug>/` holds finished,
  check-driven runs (`flow-field`, `attractor-nodes`) that
  `lab_new action=example` instantiates into the lab, and that the package's own
  check renders in a browser. It is the part meant to grow.
- **A runtime registry, not a switch.** `lib/runtimes/<id>.js` is one module with
  `detect / scaffold / materialize / lint / examples`; adding "Processing in Rust"
  or "Cinder" is that module, a skill, and one line in `RUNTIMES`. The registry
  check drives every registered runtime, so a runtime that is registered is a
  runtime that is tested.

## How far a run can be verified — the important part

Two worlds are verified in completely different ways, and the failure worth
engineering against is the quiet one: a check reporting "sound" about something
nothing ever ran. So verification is an explicit, ordered ladder, and **every
answer names the tier that was actually reached**:

| tier | claim | needs | cost |
|---|---|---|---|
| `t0-structure` | the source is read and judged by its own runtime | nothing — always runs | ms |
| `t1-parse` | the language's own parser accepts it | a compiler or interpreter | ms |
| `t2-compile` | it builds against the framework's own library | the framework installed | s |
| `t3-render` | it actually draws a frame | a browser, or a window and a graphics stack | s |
| `t4-measure` | the drawing is measured: pixels read back, two seeds compared | a canvas whose pixels can be read | ~10s |

`lab_runtimes action=info` prints this ladder with the tiers this machine can
reach, and `deep: true` runs the deepest one — a real `g++ -fsyntax-only` compile
of a freshly scaffolded openFrameworks run when the framework is installed.

**A tier that did not run says so.** With no openFrameworks, an openFrameworks
lint reports `not-compiled` naming the path it searched and the variable to set —
never a pass. And a *refused* child is not a missing one: a confined process that
may not execute `g++` gets told "this process may not run it (EPERM)", because
reporting that as "your C++ does not compile" would be a wrong answer about the
user's code.

## Adaptable to the machine

`lib/capabilities.js` reads what this host actually is — cores, memory, whether a
compiler exists on PATH (by looking, not by running it), whether a browser is
installed — and the runtimes use it:

- **generated defaults are scaled to the host.** A 2-core / 2 GB container gets a
  smaller opening population than a 32 GB workstation, because a prototype whose
  first frame stutters is one nobody can read.
- **the lint knows the budget.** One frame at 60 Hz is 16.7 ms; a sketch that
  allocates in `draw()`, walks every pixel per frame, or opens past ~20 000
  particles is warned about by name.

## How it plugs in

| Piece | Value |
|---|---|
| row | `proto-lab` |
| routes | three exact paths, `GET`/`HEAD` only |
| tools | 5 |
| skills | 3 (`p5js-prototypes`, `openframeworks-prototypes`, `prototyping-lab`) |
| examples | 2 checked p5.js runs, committed beside their skill |
| touches | no core row disabled, no fork, no npm dependency, no bundled binary |

| Route | What it answers |
|---|---|
| `GET /api/dsh-proto-lab/state` | the lab root and its provenance, every run, the runtimes, the notes |
| `GET /api/dsh-proto-lab/preview?run=&seed=` | ONE self-contained page for a run: the library and the sketch inlined, with a CSP that permits no network at all |
| `GET /api/dsh-proto-lab/vendor/p5.js` | the pinned p5.js, for anything that wants the same bytes a run carries |

**The lab lives on the Desktop, and never in git.** A prototype is a thing you
open and a print is a thing you look at, so both arrive where a person can see
them: `~/Desktop/vncode-lab/` holds `runs/` (the prototypes), `prints/` (saved
PNGs) and `apps/` (compiled binaries). `DSH_PROTO_LAB_ROOT` overrides all of it,
and a machine with no Desktop — a container, CI — falls back to `<workspace>/lab`.
`.gitignore` carries `/lab/` so even that fallback stays out of the repository: the
bundle ships the generator, the conventions and the checked examples, never the
runs. A run is reproducible from its name — `lab_new` derives the seed from the run
id, so `slug=flow-field` gives the same first frame in a year — and a run worth
keeping is *promoted* into the example library (the `prototyping-lab` skill has the
recipe).

A **print** is the one thing a browser insists on placing itself: `Save PNG` writes
to the browser's Downloads folder, and the file is named
`vncode-lab-<slug>-seed-<n>.png` so the run and the seed are on the filename and it
can be moved into `prints/` without guesswork.

## Requirements

- **Nothing** to write a run: p5.js is vendored in this package, and an
  openFrameworks run is plain source.
- **A Chromium-family browser** (Chrome, Chromium, Edge) for tiers 3–4, i.e. for
  `check-lab-render.mjs`. Override the search with `DSH_PROTO_LAB_BROWSER`.
- **The machine's own openFrameworks** to compile a native run, found through
  `DSH_OF_ROOT` / `OF_ROOT` or the standard `of_v*` locations. ~500 MB, never
  downloaded by this package.
- **Node 22+** (the harness's own requirement).

## Limits

- **No binary is shipped and no build file is generated.** `config.make` and the
  platform project are the projectGenerator's output for one openFrameworks
  version on one platform, so a checked-in copy is wrong the moment either
  changes; the run carries the three files that *are* the prototype and a README
  with the command that fills in the rest.
- **The preview cannot load a file beside the run.** The framed page is
  sandboxed with `allow-scripts` and no same-origin, so every fetch — even to this
  plugin's own routes — is cross-origin; the document is therefore composed with
  the library and the sketch inlined and a CSP that permits nothing. A sketch that
  `loadImage('data/x.png')` works when `index.html` is opened directly and not in
  the tab; `lab_lint` warns `loads-a-file`.
- **`p5.sound` is out.** It needs cross-origin isolation, which is the one thing
  a sandboxed preview cannot have.
- **p5.js 1.x.** 2.x is ESM-first and has no self-contained classic-script browser
  build, which a run opened off the filesystem needs. 1.11.13 is the last 1.x, and
  the line the ecosystem's sketches target.
- **One runtime is unverified deeper than t0.** openFrameworks compiles only where
  it is installed. This package's own check skips that half loudly; it does not
  pretend otherwise.

## Verify

The checks live **inside this package**, so they travel with it:

```
npm run check              # the default: offline, seconds, no browser
npm run check:vendor       # the vendored p5.js against its recorded hashes, offline
npm run check:node         # the engine: registry, path policy, both runtimes, the tools
npm run check:examples     # every skill example and every fenced snippet, executed
npm run check:render       # a REAL browser draws the runs and the pixels are measured
npm run check:all          # the default PLUS the browser render
```

**`npm run check` deliberately does NOT open a browser.** The render check spawns a
headless Chrome and loads several pages in it; that is the right cost for a release
and the wrong cost for every edit, so it is its own script and `check:all` is the
one that runs everything.

`check-lab-render.mjs` skips **loudly** (exit 0, with the reason) when there is no
browser — and also when the environment refuses to launch one, which is a fact
about the sandbox and not about the plugin. `check-lab-node.mjs` skips the
openFrameworks compile the same way. No check is ever weakened to make a change
pass.

## Install

With the vncode pack: `scripts\setup\install.bat` (Windows) or `./scripts/setup/install.sh`
(macOS / Linux) in **that** repository, which discovers this package under
`packages/`. Both installers also copy the three skills into `$DSH_HOME/skills`.
Then restart the harness. Nothing has to be installed first.
