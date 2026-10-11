---
name: prototyping-lab
description: Work the prototyping lab itself — where runs live, what a run is, how to promote a run into the checked example library, and how to add a new runtime (Processing in Rust, Cinder) in one module. Use when asked to add a language or framework to the lab, to turn a prototype into a reusable example, to find or tidy what is in the lab, or when the lab's folder or catalog needs explaining.
whenToUse: When the user asks to add a runtime/framework to the lab, promote a prototype to an example, understand where lab runs are stored or why they are not in git, extend the runtime contract, or fix the lab's catalog.
---

# The prototyping lab itself

This skill is about the **lab**, not about drawing in it. Read it when the task
is to extend or maintain the place rather than to write a sketch.

## Where the lab is, and why it is not in git

```
<workspace>/lab/<runtime>/<slug>/          one folder per run
<workspace>/lab/catalog.json               what the lab has made (seed, concept, files)
```

Resolution, in order:

1. `DSH_PROTO_LAB_ROOT` — an explicit root: an absolute path, or one relative to
   the workspace (a standalone clone, a different project);
2. otherwise `<workspace>/lab`, where the workspace is the session's own `cwd`
   (what the harness runs a conversation's tools with).

`lab/` is in the repository's `.gitignore`, deliberately: **the lab is a
workshop, not an exhibit.** Runs are generated on this machine, they are
throwaway by design, and a repository that accumulated every sketch anyone tried
would stop being a plugin pack. What ships is the generator, the conventions and
the example library; what you make with them stays local.

The consequence to hold on to: **a run can be deleted and regenerated, and that
is not a loss.** `lab_new` derives a run's seed from its name (unless you pass
one), so `lab_new runtime=p5js slug=flow-field` gives the same first frame today
and in a year. If a run is worth keeping beyond that, promote it (below).

`catalog.json` is a convenience, never the truth. The lab is what is on disk; the
catalog records the seed, the concept and the files of what was made. Deleting
the catalog costs you the seeds, not the runs.

## Promoting a run into the example library

The example library is the part meant to grow — it is the set of runs that are
**committed, checked, and instantiable**, and it is where a good prototype goes
when it stops being an experiment.

An example lives beside the skill that teaches its runtime:

```
packages/dsh-proto-lab/skills/<runtime>-prototypes/
  SKILL.md
  examples/<slug>/
    example.json      { slug, label, concept, seed, params }
    sketch.js         (p5js)   — or src/ofApp.h, src/ofApp.cpp (openframeworks)
```

To promote one:

1. copy the run's prototype file(s) from the lab into `examples/<slug>/` — the
   PROTOTYPE only, never the generated shell, the library or the README;
2. write `example.json`: the slug, a label, the one-sentence concept, the seed,
   and `params` as prose naming what each number does;
3. add a row to the table in that skill's `SKILL.md`;
4. run the package's checks (`npm run check` in `packages/dsh-proto-lab`). The
   examples check drives every example, so an example that does not lint or does
   not render fails there — which is the point of a library.

Generated files are never part of an example: the shell, `p5.min.js` and
`README.md` are written by the runtime at instantiation, so an example that
carried its own copy would be a second thing to keep in step. That is why
`lab_new action=example` regenerates them.

## Adding a runtime — one module, one line

A runtime is a language. The lab owns half of it already (the folder, the
catalog, the path policy, the size caps, the README and NOTES), and a runtime
owns the other half:

```
lib/runtimes/<id>.js       the module: detect, scaffold, materialize, lint, examples
lib/runtimes/templates/*.template   the source a new run starts from
lib/runtimes/index.js      add it to RUNTIME_MODULES - one line
skills/<id>-prototypes/SKILL.md     and a skill that teaches it
```

`lib/runtimes/_template.js` is the contract with the blanks filled in; copy it.
The five things it asks for:

| function | what it must answer |
|---|---|
| `detect({ env })` | is this runtime's toolchain here, where, and what to set if not — never throws, runs on every `lab_runtimes` |
| `scaffold(spec)` | the files a NEW run gets: `{ path, content }[]`, paths relative, `{{TOKEN}}` placeholders substituted for you |
| `materialize(example)` | the files an EXAMPLE turns into: its own bytes, plus the generated shell/library/documents |
| `lint(run)` | is a run still a prototype in this language: `{ severity, code, message, file }[]`, errors vs warnings |
| `examples({ kitDir })` | the committed examples beside the skill, read from `example.json` |

Rules that are not negotiable in a new runtime:

- **No network at run time.** Vendor what a run needs (p5's `p5.min.js` sits in
  `lib/vendor/`, built and hash-checked by `vendor/build.mjs`) or find the user's
  own install (openFrameworks). Never a CDN.
- **No binary is ever committed or shipped.** A `.gitignore` per run keeps build
  output out; a runtime that generates a project also says which command builds
  it.
- **`lint` must not claim more than it checked.** If the toolchain is missing,
  the answer says `not-compiled` rather than implying the source was verified.
- **`detect` is cheap.** It runs on every listing; a probe that compiles
  something is not a detection.

Two credible next runtimes, and what each one actually costs:

- **Processing (Rust)** — a `.pde`-like sketch in Rust: a `main.rs`, a
  `Cargo.toml` pinning `nannou` or `rust-skia`, and a `cargo run` recipe. The
  toolchain probe is `cargo --version`; the lint is `cargo check` when cargo
  exists.
- **Cinder** — C++ like openFrameworks, so it is closer to what is already here:
  three files, a CMake project, and `cmake --build` as the recipe.

Neither is registered today, and that is the honest state: a runtime whose
examples have never been compiled would be a language the lab offers and cannot
check. `lib/runtimes/_template.js` exists so the day it is worth doing is a small
day's work.

## Judging the lab

`lab_lint` with no arguments lints every run and reports only problems, which is
the check to run before saying the lab is in good shape. Errors are broken;
warnings are things that are not what this lab does — a stray file, a run missing
its `window.__LAB.drew`, a catalog entry whose file list has drifted from the
folder.

`lab_open` is the other end: it prints the absolute root, where the root came
from, every run on disk with its size, and whether the catalog agrees. Start
there when something is not where you expect it.
