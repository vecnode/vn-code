# dsh-shaders

GLSL that **compiles for real**, on a machine with no GPU, and says how far it got.

Seven `shader_*` tools, a Shaders tab with a live WebGL preview, five skills, and a
vendored corpus of **106 Radiant pages (79 fragment sources)** plus
**shader-skills' 20 GLSL modules, 11 templates, 11 finished pieces and 14
references**, and a curated index of 48 links. Zero npm dependencies, no network at
install or run.

## Why it exists

A shader cannot be reviewed by reading it. `float x = vec3(1.0);` is obvious once a
compiler says `dimension mismatch` on line 3, and invisible otherwise - and a shader
that compiles can still draw a black rectangle, which no amount of reading catches.

So this row runs a real GLSL compiler. It starts the Chromium-family browser the
machine already has, argv-only, in a throwaway profile, with every name resolved to
NOTFOUND except loopback, over ANGLE's software rasterizer. `--disable-gpu` is
deliberately absent: measured, it is what makes `getContext('webgl')` return null.

## The ladder

Every answer names the rung it reached. It never implies one it did not.

| rung | what it means |
|---|---|
| `v0-stored` | stored, nothing has checked it |
| `v1-static` | the dialect rules and the lint ran; **no compiler was asked** |
| `v2-compiled` | a real compiler accepted it, on **your** line numbers |
| `v3-drawn` | it linked, a frame drew, pixels came back |
| `v4-measured` | two different times drew differently |

`v2` is the honest ceiling without a browser, and the answer says so by naming the
browser that would reach it.

## Five dialects, kept apart

`es100` · `es300` · `shadertoy` · `shader-skills` · `module`, plus `desktop`, which
is **refused** rather than faked: ANGLE compiles GLSL ES, and a `#version 330 core`
source gets `v1-static` and the name of the tool (`glslangValidator`) that would
compile it.

`shadertoy` and `shader-skills` are two dialects and not one, because `iFrame` is a
**float** on shadertoy.com and an **int** in the shader-skills harness (it calls
`uniform1i`). A shader written for one fails under the other with `no matching
overloaded function found` - measured, and asserted by the check.

## The tools

| tool | does |
|---|---|
| `shader_write` | store + verify at a revision; diagnostics on your lines, active uniforms, tab address |
| `shader_verify` | check without storing; the rung, the compiler's log, the lint |
| `shader_render` | draw one frame or a contact sheet, read the pixels, report black/flat/animated + a deterministic signature |
| `shader_read` | one shader or the conversation index, with the browser's own verdict |
| `shader_publish` | copy to the shared library (`dsh-resource://shader/library/<id>`) |
| `shader_target` | emit `web` (a standalone page) · `frag` · `isf` · `ffgl` (a scaffold) · `shadertoy` |
| `shader_kit` | the corpus: `catalog`, `example`, `search`, `links` |

Parameters are declared in the source and become sliders everywhere:

```glsl
// @param SPEED float 0.1..2.0 default 0.6 "Rotation speed"
```

## What it will not do

- **Build an FFGL plugin.** FFGL is a C++ ABI; the SDK is not vendored and no C++
  compiler is run. `target=ffgl` emits a scaffold with the shader embedded and a
  checklist in its header, and says `NOT A BUILDABLE PLUGIN` on line 4.
- **Compile desktop GLSL.** See above: refused, with the reason.
- **Claim SwiftShader is your GPU.** A driver can still reject what ANGLE accepted;
  the browser's own report is the second rung, and the tab posts it.
- **Reach the network.** No egress at install or run. Every vendored page is
  asserted offline-clean, and the routes serve it into a `sandbox`ed frame behind
  `default-src 'none'`.

## The corpus

Three pinned trees under `lib/vendor/`, each re-derivable **offline** from the bytes
that are committed - `node vendor/<name>/build.mjs --check`, which the package check
runs:

| tree | licence | contents |
|---|---|---|
| `pbakaus/radiant@59e9f48c` | MIT | 106 pages byte-identical, 79 fragment sources extracted (3 multi-pass pages carry several), 2.45 MB |
| `gokayfem/shader-skills@e09bc99` | MIT | 20 modules, 11 templates, 11 gallery pieces, 14 references, 648 KB |
| `vanrez-nez/awesome-glsl@287c2ea` | MIT | a 7 KB link index and its licence - **no shader code** |

What is **not** vendored: Radiant's 91 preview images (22.6 MB). The row renders its
own frames instead, which is also better evidence that the shader runs.

The extraction is measured, not guessed: 62 pages spell the fragment as an array of
string literals, 10 as a template literal, three carry several passes, and two have
no statically readable source at all - both named in `catalog.json` with the reason.

## The check is the contract

```sh
npm run check                                    # both, in this folder
node checks/check-shaders.mjs                    # 126 checks, no browser needed
node checks/check-shaders-render.mjs             # 31 checks, needs a browser
node ../../scripts/checks/check-shader-examples.mjs   # every GLSL in the skills
```

`check-shaders-render.mjs` compiles **every** fragment source in both corpora and
draws every gallery piece. A machine with no browser skips it loudly and says which
assertions went untested - it never reports a pass it did not earn.
