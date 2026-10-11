---
name: openframeworks-prototypes
description: Write openFrameworks prototypes into the lab — real C++ (ofApp.h, ofApp.cpp, main.cpp) that builds into an app with the projectGenerator and make. Use for native/desktop sketches, performance-sensitive work, OpenGL, audio input, sensors, anything that has to be an application rather than a page.
whenToUse: When the user asks for an openFrameworks or C++ sketch, a native/desktop app prototype, an OpenGL or shader experiment, a piece that needs a real window, audio device access or high frame rates, or asks to change or rerun one of the lab's openFrameworks runs.
---

# openFrameworks prototypes

An openFrameworks run in this lab is **three C++ files that become an app**. It is
the slow, heavy, real one: it opens a window, it can hold a GL context and read
the machine's audio and sensors, and it builds with a toolchain rather than
loading in a browser.

## The shape of a run

```
lab/openframeworks/<slug>/
  src/ofApp.h      the declaration: state, params, the virtuals
  src/ofApp.cpp    THE PROTOTYPE. setup(), update(), draw(). Edit this.
  src/main.cpp     the window, the loop, and the headless switches
  addons.make      one addon per line (empty by default)
  bin/data/        a prototype's assets live here (tracked)
  .gitignore       obj/, bin/<slug> — the APP IS NEVER COMMITTED
  README.md        GENERATED: what it is, and the exact build command
  NOTES.md         GENERATED: the seed, what to look at, what to try
```

**No build files ship and no binary is ever committed.** `config.make` and the
platform project are the projectGenerator's output for *one* openFrameworks
version on *one* platform, so a checked-in copy is wrong the moment either
changes. `lab_new` writes the three files that are the prototype; the README's
recipe fills in the rest:

```
$OF_ROOT/projectGenerator/projectGenerator -o"$(pwd)" -p$(uname -s | tr '[:upper:]' '[:lower:]') .
make && make RunRelease
```

## Time belongs in `update()`, never in `draw()`

This is the one rule that separates an openFrameworks prototype from a stutter:

```cpp
void ofApp::update() {
    // everything that moves, at the frame's own dt - so 30 fps and 120 fps
    // behave the same
    const float dt = ofClamp(static_cast<float>(ofGetLastFrameTime()), 0.0f, 0.1f);
    time += dt;
    for (auto& particle : particles) { /* advance */ }
}

void ofApp::draw() {
    // draw the state update() reached. Nothing here changes the system.
}
```

`ofClamp` on `dt` is not decoration: the first frame after a window move or a
breakpoint can hand you a second of elapsed time, and a simulation that trusts it
teleports.

## Reproducibility is two calls, and both are needed

```cpp
void ofApp::setup() {
    ofSeedRandom(static_cast<std::uint32_t>(options.seed));   // ofRandom becomes a function of the seed
    seedOffset = static_cast<float>(options.seed % 4096) * 0.37f;  // ofNoise does NOT see the seed
    // ...
}
```

`ofNoise` is a pure function of its coordinates — it has no internal state to
seed. So the seed has to enter the noise field as an **offset** applied to the
coordinates, or every seed draws the same field while the particles move
differently. That is the single most common way an openFrameworks sketch stops
being reproducible, and it looks like it works.

`ofRandom` is not `std::rand`: use `ofRandom(min, max)` and `ofRandom(max)`, and
seed once in `setup()`.

## What the shape of the files is for

- **`ofApp.h`** — the class, the `Params` struct, the state, and the virtuals you
  override. Keep numbers that a person would tune in `Params`, and derive
  everything else.
- **`ofApp.cpp`** — the algorithm. Private helpers (`angleAt`, `respawn`,
  `populate`) read far better than one long `draw()`.
- **`main.cpp`** — the window and the loop. It already takes `--seed`,
  `--frames`, `--headless` and `--png`, so a prototype can prove it drew
  something without a person watching:

  ```
  ./bin/<slug> --headless --frames 120 --png frame.png
  ```

## The C++ that actually costs you

- **Fixed populations, not growing vectors.** Rebirth a particle instead of
  erasing it from a `std::vector`, or the frame time drifts as the vector
  reallocates.
- **`params.particles` is a cost, not a look.** 2 600 particles with one
  `ofDrawLine` each is comfortable; 200 000 is not, and the number that is
  comfortable is machine-specific — say which one you measured in `NOTES.md`.
- **`ofSetColor`/`ofSetLineWidth` per particle is the honest version** when every
  particle's look differs; if you find yourself doing it for thousands of
  identical particles, that is the signal to move to a mesh or a shader.
- **`ofEnableAlphaBlending()` once in `setup()`**, not per frame.
- **A veil, not a clear.** `ofSetColor(8, 8, 10, veil); ofDrawRectangle(...)`
  accumulates paths into density; `ofBackground(...)` throws the history away.
- **`windowResized()`** rebuilds anything derived from the window size, because
  the field is the window.

## Build, run, and what "checked" means

```
lab_new  runtime=openframeworks concept="..." slug=drifting-field
lab_read run=openframeworks/drifting-field file=src/ofApp.cpp
         ... edit src/ofApp.cpp ...
lab_lint run=openframeworks/drifting-field
```

`lab_lint` checks the three files structurally everywhere — the class derives
from `ofBaseApp`, `setup`/`update`/`draw` are declared and defined, `main.cpp`
really starts the loop, and the run's `.gitignore` still keeps the app out of the
repository. When openFrameworks is installed (found through `DSH_OF_ROOT` or
`OF_ROOT`), it also **compiles** the run with `g++ -fsyntax-only` against that
install's headers, which is the only answer that proves the C++ is C++. Without
an install the answer says `not-compiled` — a warning, not a pass.

If `openFrameworks was not found`, `lab_runtimes action=info runtime=openframeworks`
prints every path that was searched and how to set `DSH_OF_ROOT`. You can still
write and edit a run without it; you cannot check the C++ without it.

## Where the numbers are

`src/ofApp.h` holds `Params` and `kSeed`; `src/ofApp.cpp` holds the algorithm.
Keys already wired in the generated prototype: `r` reseeds and rebuilds, `n`
changes the noise scale, `f` changes the flow, `c` clears, space saves a PNG.
Keep that habit — one key for one visible change is the fastest way to find out
what an algorithm is actually doing.
