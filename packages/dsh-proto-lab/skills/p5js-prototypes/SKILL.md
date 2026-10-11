---
name: p5js-prototypes
description: Write p5.js prototypes into the lab — sketches that actually run in a browser, seed-reproducible, with controls generated from the sketch's own parameters. Use for generative art, flow fields, particle systems, noise, animation, anything sketched visually in the browser.
whenToUse: When the user asks for a p5.js sketch, a generative or algorithmic artwork, a visual prototype, a browser canvas experiment, a variation explorer, or asks to change or rerun one of the lab's p5.js runs.
---

# p5.js prototypes

A p5.js run in this lab is a **folder of source that a browser opens**, not a
chat artifact that scrolls away. `lab_new` writes it, `lab_lint` judges it, the
tab shows it, and it stays on disk where you can change it and look again.

## The shape of a run

```
lab/p5js/<slug>/
  sketch.js     the prototype: setup(), draw(), and the algorithm's state
  index.html    the shell: the library, the seed, the controls. GENERATED.
  p5.min.js     p5.js, vendored so the run is offline. GENERATED.
  README.md     what it is and how to run it. GENERATED.
  NOTES.md      the seed, what to look at, what to try. GENERATED.
```

Edit `sketch.js`. Add a parameter by adding an entry to the `params` array in
`index.html` AND reading it in `sketch.js` — the control is generated from that
array, so there is no second place to keep in step.

## The contract: one object

The shell puts everything the sketch needs on `window.__dshProtoLab__`:

```js
window.__dshProtoLab__.seed          // an integer; the same seed draws the same picture
window.__dshProtoLab__.params        // [{ name, min, max, value, step }, ...]
window.__dshProtoLab__.param('name') // the ONLY way a sketch should read a tunable
window.__dshProtoLab__.drew = true   // set at the end of the first draw() - see below
```

Seed yourself **before anything is drawn** — this snippet is executed by the
package's own check against a stub p5, so it is a shape that runs:

```js lab-run
// The shell creates both holders before this factory runs.
const spec = window.__dshProtoLab__;

window.__dshProtoLabLifecycle__.setup = function () {
  randomSeed(spec.seed);
  noiseSeed(spec.seed);
  createCanvas(windowWidth, windowHeight).parent('lab-stage');
  background(0);
};

let first = true;
window.__dshProtoLabLifecycle__.draw = function () {
  // ... the algorithm ...
  if (first) { spec.drew = true; first = false; }
};
```

**Why the lifecycle goes into a holder instead of onto `window`.** p5's own
auto-start watches `window.setup` and `window.draw` and constructs its OWN
instance the moment either appears — so a sketch that installs them on `window`
races the framework for its own lifecycle, and p5's instance wins. The shell hands
the two functions to its own `new p5({ setup, draw })` instead, and the sketch
never touches those two names. `lab_new` writes this shape for you.

Three things follow from that contract, and all three are checked:

- **`randomSeed` and `noiseSeed` are not optional.** Without them the run is not
  reproducible, `lab_lint` reports `unseeded`, and "same seed, same picture"
  stops being true — which is the only reason a seed exists.
- **`window.__dshProtoLab__.drew = true` at the end of the first `draw()`** is how the
  shell and the headless render check tell a drawn frame from a canvas that
  stayed black because `setup()` threw.
- **Read tunables through `window.__dshProtoLab__.param(name)`**, never by copying a number
  into a second variable at load time: the slider has to change the algorithm.

## Derive the algorithm; do not pick a pattern

The order that produces something worth keeping:

1. **The concept** — one sentence, and it is about the *process*, not the image:
   "seeds drift along a noisy vector field and die of old age, so density
   accumulates where the field slows them". `lab_new concept="..."`.
2. **The derivation** — what quantities does that sentence name? particles, a
   field, a lifetime, a respawn rule. Those become state and parameters.
3. **The seed's job** — say what varies with it (initial population, respawn
   positions, the noise offset), because that is what makes a seed worth
   scrubbing rather than a randomisation button.
4. **The code** — and only then choose the p5 calls that express the derivation.

What separates a prototype from a doodle is not the number of features. It is
that **the picture is a consequence of a rule you can state**, and that changing
one number shows you the rule working. If you cannot say which parameter would
change the picture and how, the algorithm is not finished.

## The rules that matter in a browser

- **The frame is a budget.** 60 fps is ~16 ms for everything in `draw()`. A few
  thousand particles with one `line()` each is fine; a nested loop over every
  pixel is not. When something is expensive, say so in `NOTES.md` and give it a
  parameter that turns it down.
- **Recompute per frame, store per particle.** The field is a function of
  position (`noise(x * scale, y * scale, t)`); never cache it into a grid unless
  you also make rebuilding it cheap.
- **A veil beats a clear for anything that moves.** `fill(0, 8); rect(0, 0, w, h)`
  in `draw()` accumulates paths into density; `background(0)` throws the history
  away.
- **`windowResized()`** — the canvas is the window, so resize and rebuild, rather
  than letting the browser stretch the canvas.
- **Offline means offline.** No CDN `<script>`, no remote image, no font URL. The
  library is already beside the run; if you need another file, put it in the
  folder. `lab_lint` reports `remote-asset` as an error.
- **The preview is one composed page.** It inlines the library and `sketch.js`
  and permits no network at all, so a `loadImage('data/x.png')` will work when
  `index.html` is opened in a browser and will NOT work in the Lab tab
  (`lab_lint` warns `loads-a-file`). Do not design around the preview — design
  the run, and open the file when you need assets.

## Workflow

```
lab_new   runtime=p5js concept="..." params=[{name:"particles",min:200,max:6000,value:1800,step:50}]
lab_read  run=p5js/<slug> file=sketch.js
          ... edit sketch.js ...
lab_lint  run=p5js/<slug>
```

Then look at it: the Lab tab in the right bar, or the run's own `index.html` in a
browser. `?seed=42` (and any parameter, `?seed=42&particles=900`) explores the
space without touching the file.

Aim your effort where it shows: get one gesture right — the field, the palette,
the respawn rule — rather than four half-tuned ones. Then write down in
`NOTES.md` what you saw and what you would try next, because that is the file the
next person (or the next you) reads first.

## Examples that ship with this skill

Two complete, seed-reproducible runs sit in `examples/` beside this file; read
them as reference, and instantiate one to work on it:

```
lab_new action=example runtime=p5js example=flow-field
lab_new action=example runtime=p5js example=attractor-nodes
```

| example | concept | seed |
|---|---|---|
| `flow-field` | particles carried by layered noise, fading trails accumulating where the field slows | 20260401 |
| `attractor-nodes` | a population pulled toward moving attractors, its traces mapping the basins between them | 20260402 |

Both are checked: every example is rendered headlessly by this package's own
check, and a different seed must produce a different picture.
