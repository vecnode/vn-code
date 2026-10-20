---
name: shader-isf-ffgl
description: Shader formats for VJ and live-visual hosts - ISF (GLSL plus JSON metadata, which Resolume reads directly) and FFGL (FreeFrameGL, a C++ plugin ABI). What each one is, what the port renames, and exactly what this row can and cannot produce.
whenToUse: When a shader has to run in Resolume, VDMX, TouchDesigner or another live-visuals host; when asked for FFGL; or when deciding between ISF and an FFGL plugin.
---

# ISF and FFGL

Two formats, two very different things. Getting them mixed up wastes a day.

| | ISF | FFGL |
|---|---|---|
| what it is | a shader **file format**: GLSL + a JSON block | a **C++ plugin ABI**: a compiled `.dll`/`.so`/`.bundle` |
| what you write | one `.fs` file (or an `.fs` with the JSON prepended) | C++ against the FFGL SDK |
| what the host loads | the shader | the binary |
| can this row make one | **yes**, complete | **a scaffold only** - never a build |

## ISF: the shader format

ISF is "GLSL with inputs declared". The host parses a JSON block, builds the
controls, and calls `main()` with uniforms set. Two shapes exist: the JSON as a
leading comment block in the same file, or a separate `.json`. This row emits both
(`target=isf` gives `<name>.fs` and `<name>.json`).

The uniforms ISF itself provides:

| name | type | meaning |
|---|---|---|
| `RENDERSIZE` | vec2 | render target size in pixels |
| `TIME` | float | seconds |
| `TIMEDELTA` | float | seconds since the last frame |
| `FRAMEINDEX` | int | frame counter |
| `PASSINDEX` | int | index of this pass |
| `inputImage` | sampler2D | the incoming image |
| `isf_FragNormCoord` | vec2 | normalised coordinate, 0..1 |

And the entry point is `void main()` writing `gl_FragColor` - **not** `mainImage`.
That is the whole port from a Shadertoy-style source:

```glsl
/* ISF 2 shader */
#version 100
precision highp float;
uniform vec2 RENDERSIZE;
uniform float TIME;
uniform sampler2D inputImage;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / RENDERSIZE;
  fragColor = vec4(uv.x, uv.y, 0.5 + 0.5 * sin(TIME), 1.0);
}

void main() {
  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(color, gl_FragCoord.xy);
  gl_FragColor = color;
}
```

Notice what did **not** change: the maths, the functions, the precision statement.
A port is a rename of the entry point and the uniforms, and it is worth doing by
hand the first time so you know what the tool did.

The JSON metadata, smallest useful form:

```json
{
  "DESCRIPTION": "Colour ramp with a pulse",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "speed", "TYPE": "float", "MIN": 0.0, "MAX": 4.0, "DEFAULT": 1.0, "LABEL": "Speed" }
  ]
}
```

`TYPE` is `float`, `bool`, `long`, `color`, `point2D`, `image`, `audio` or
`event`. `MIN`/`MAX`/`DEFAULT` become the control's range; `LABEL` is what a person
sees. A `float` input becomes a `uniform float speed;` in the shader - the NAME and
the uniform name are the same, which is why ISF names are conventionally lower case
and have no `u_` prefix.

Hosts read `inputImage` as the input pass and composite the output. If your shader
ignores `inputImage` it is a generator rather than an effect: declare it anyway and
say so in the description, or omit it and accept that some hosts will not offer it
as an effect.

## What `shader_target target=isf` does to your source

- renames `iResolution` -> `RENDERSIZE`, `iTime` -> `TIME`, `iTimeDelta` ->
  `TIMEDELTA`, `iFrame` -> `FRAMEINDEX`, `iMouse` -> `MOUSE`
- adds `void main()` that calls `mainImage` and writes `gl_FragColor`
- declares the uniforms ISF provides, plus one per `@param`
- emits `MOUSE` only when the source used `iMouse` - and it is **not** an ISF
  standard input, so the note says to drop it or keep it in your JSON
- writes the `.json` with one `INPUT` per `@param`

`MOUSE` is the honest weak spot: ISF has no standard pointer input. Some hosts
expose one as `point2D`; if yours does not, delete the uniform and the code that
reads it rather than shipping a shader that samples an unset uniform.

## FFGL: the plugin ABI

FFGL (FreeFrameGL) is a **C++ plugin interface**: the host loads a shared library
and calls methods on a `CFFGLPlugin`. The shader is embedded in the C++ as a string,
compiled at `InitGL`, and drawn in `ProcessOpenGL`. There is no shader file to hand
anyone.

So `shader_target target=ffgl` emits a **scaffold**: the GLSL verbatim as a raw
string literal, one comment line per uniform, the entry points declared as TODOs,
and a checklist in the header. It is not buildable, and it says so in its first
line, because:

- the FFGL SDK is not vendored here (it is C++, and this package ships no C++);
- FFGL 1.x and 2.x have **different** method signatures, so any signature written
  for you would be wrong for somebody;
- compiling a plugin needs that machine's compiler, SDK and OpenGL headers - none
  of which a harness plugin can assume.

What the scaffold gives you is the part that is hard: the shader, its uniform map,
and the order of operations.

## Choosing

- **Resolume, VDMX, or any host that reads shader files** -> ISF. It is one file,
  no compiler, and it can be edited live in the host.
- **A plugin that ships inside someone's app, or needs C++ side effects** (audio
  input, MIDI, multiple passes it controls itself) -> FFGL, and budget for the SDK.
- **A website or an installation you control** -> neither: emit `target=web` and
  run it in a browser you already have.

## Checklist before handing a shader to a host

1. It compiles as `es100`. ISF and most FFGL hosts are ES 1.00-era: any
   `#version 300 es` construct has to be rewritten (`out` -> `gl_FragColor`,
   `in`/`out` varyings -> `varying`, `texture()` -> `texture2D()`).
2. `precision highp float;` is there.
3. Every input is declared in the JSON with a range that makes sense, and the
   shader's uniform name matches the JSON `NAME` exactly.
4. No `iChannel0`-style Shadertoy leftovers: an ISF host supplies `inputImage`, and
   an FFGL host supplies nothing unless you bind it.
5. It runs at the host's resolution. Test at 1920x1080 at least; a VJ host at 4K
   will find every step you did not count.
6. It runs on **that machine's GPU**. This row compiles with ANGLE/SwiftShader,
   which is a real GLSL compiler but not the user's driver: a margin-of-error
   shader can pass here and fail in the host.
