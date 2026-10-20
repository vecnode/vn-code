---
name: shader-debugging
description: Reading a GLSL compiler's log, mapping its line numbers to your source, telling "compiles" from "draws", and the triage order for a black canvas. Read this when a shader fails in a way that does not make sense, or when it compiles and still shows nothing.
whenToUse: When a shader fails to compile, when the error line does not match the code, when the picture is black or flat, or when it runs here but not in another browser or host.
---

# Debugging a shader

Shader debugging is unusual: there is no breakpoint, no stack, and the compiler's
message is often three lines away from the cause. The order below is the fastest
path from "it does not work" to a specific fault.

## Step 1: read the rung, not the mood

Every answer from this row names how far it got:

```
shader my-shader — FAILED at v1-static (es100)
v1-static: only the static rules ran - no compiler was asked
```

`v1-static` on a machine that has a browser means the source was refused before a
compiler saw it (a `#version` in a wrapper dialect, or desktop GLSL). `v2-compiled`
means a real compiler accepted it - so a broken picture is not a syntax problem.
Never say "it does not compile" from a `v1` answer.

## Step 2: trust the line numbers, and know why

A compiler reports a line in the string it was HANDED. For an `es100` source that
is your file, so line numbers match. For a wrapper dialect (Shadertoy, modules) the
row prepends a header and appends `main()`, so the compiler's line 40 might be your
line 27. The mapping is done for you: a diagnostic says

```
line 27 — 'dot2' : no matching overloaded function found
```

and that is **your** line 27. If a diagnostic says `[in noise]`, the error is
inside an included module, not your file - fix the include or the call.

## Step 3: the four messages that cover most failures

```
ERROR: 0:12: '=' : dimension mismatch
```
A vector assigned to a scalar, or the reverse. Read the second line - ANGLE adds
`cannot convert from 'const 3-component vector of float' to 'highp float'` and names
both types.

```
ERROR: 0:8: '}' : syntax error
```
A missing semicolon or an unbalanced brace, reported at the next `}`. Look at the
line ABOVE the reported one.

```
ERROR: 0:5: 'x' : undeclared identifier
```
A typo, a variable declared in another scope, or a uniform you forgot to declare.
For `iTime` / `iResolution` this also means the dialect is wrong: those only exist in
a wrapper dialect, not in `es100`.

```
ERROR: 0:14: 'min' : no matching overloaded function found
```
The function exists but not for those types: `min(1.0, 2)` has no `min(float, int)`.
Also check the argument COUNT - this is what a two-argument call to a one-argument
function looks like.

## Step 4: `undefined` uniforms are silent

A uniform that is declared but never used is deleted by the linker. Setting it is a
no-op, and `getUniformLocation` returns null - which most code ignores. So a shader
can read a uniform, "get" nothing, and render a constant.

`shader_verify` reports the **active uniforms after link**: that is the linker's own
list of what survived. If your uniform is not in it, nothing you pass reaches the
shader.

```
active uniforms after link: u_time (FLOAT), u_speed (FLOAT)
```

Two causes: the uniform is genuinely unused (dead code from an edit), or it is used
only inside a branch the compiler eliminated (a `if (false)` left in).

## Step 5: it compiles, links, draws - and is black

`shader_render` answers three questions at once:

| report | means |
|---|---|
| `black: true` | every pixel is 0. The shader ran and wrote nothing visible. |
| `flat: true` | one colour everywhere. `uv` collapsed, or everything is clamped. |
| `distinctColors: 3` | it varies, but barely - usually one term dominating |

Triage order for a black frame, cheapest first:

1. **Is anything written?** Replace the body with `gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);`.
   If that is still black, the problem is not the shader - it is the program, the
   viewport, or the draw call.
2. **Is the colour in range?** A value like `1e6` becomes `inf`, and `inf` clamps to
   white or NaN to black unpredictably. Print by hard-coding: `vec4(vec3(x), 1.0)`.
3. **NaN.** `sqrt` of a negative, `log(0)`, `0.0/0.0`, `pow(negative, fractional)`
   all produce NaN, and **one NaN pixel is black**. Bisect by returning each term
   alone.
4. **The camera.** A raymarcher whose ray points away from the object draws the
   background, which is black by default. Draw the ray direction as colour
   (`gl_FragColor = vec4(rd * 0.5 + 0.5, 1.0)`) - if that is a flat colour, the ray
   is degenerate.
5. **Uniforms.** See step 4.
6. **The clock.** If it is black only at `time = 0`, a term like
   `sin(t) * something` is zero at the start. Render at `time: 2`.

## Step 6: it draws here, not there

The compile this row runs uses **ANGLE with a software rasterizer** (SwiftShader).
It is a real GLSL compiler, and it is not the user's driver:

- `mediump` precision differences: desktop GPUs honour `highp` everywhere, mobile
  ones may not. A shader that relies on `mediump` being 32-bit fails on a phone.
- `OES_standard_derivatives`: needed in ES 1.00, and a page must request it. The
  row requests it for its own compile, so `fwidth` passes here and fails on a page
  that did not.
- Non-constant loop bounds: allowed by ANGLE, rejected by some mobile drivers.
- Large integer hashes: `uint` maths is ES 3.00; in ES 1.00 the same code does not
  compile at all.

If a shader fails only on a page, get that page's `getShaderInfoLog` - the browser
in front of you is the authority for that browser.

## Step 7: the picture is right but wrong

- **Upside down**: `gl_FragCoord.y` runs from the bottom. Flip with
  `1.0 - uv.y`, or accept it.
- **Stretched**: uv divided by `u_resolution` without the aspect fix. Divide by
  `min(u_resolution.x, u_resolution.y)` and centre it.
- **Banded**: 8-bit output, no dither. Add `(hash(gl_FragCoord.xy) - 0.5) / 255.0`.
- **Crawling noise**: white-noise dither animates. Use an ordered dither for still
  images.
- **Different on every machine**: uninitialised behaviour - `smoothstep` with
  `edge0 >= edge1`, reading a `varying` that was never written, `mix` past its
  range.

## Using the tools in the right order

1. `shader_verify` - did a compiler accept it, and on which line did it not?
2. `shader_render` - did a frame draw, is it varied, does it move?
3. Look at the PNG. Compilation is not a picture.
4. `shader_target target=web`, open it, and read the on-page log for the driver
   that will actually run it.

The one habit that matters: **do not move to the next step until the current one is
green.** A "probably fine" compile that was never read is the most expensive kind of
wrong.
