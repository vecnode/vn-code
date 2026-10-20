---
name: glsl-fundamentals
description: The GLSL itself - which dialect a shader is in, what precision means, the types and functions that exist, and the exact compiler messages a mistake produces. Read this before writing GLSL for any target, and before believing an error message.
whenToUse: When you are about to write GLSL, when a shader fails to compile and you need to read the log, or when you must decide whether a source is GLSL ES or desktop GLSL.
---

# GLSL fundamentals

GLSL is not one language. It is a family, and the first thing to get right is
**which member of it you are writing**. A shader that is correct in one is a wall
of errors in another, and the errors never say "wrong dialect".

## The five dialects this row tells apart

| dialect | looks like | compiles here |
|---|---|---|
| `es100` | no `#version`, `gl_FragColor`, `precision` | yes - WebGL 1 |
| `es300` | `#version 300 es`, your own `out vec4` | yes - WebGL 2 |
| `shadertoy` | `void mainImage(out vec4, in vec2)`, no `#version` | yes - wrapped in ES 3.00 |
| `shader-skills` | same as Shadertoy, but `iFrame` is an **int** | yes - wrapped in ES 3.00 |
| `desktop` | `#version 330 core` and up, no `es` | **no** - static checks only |

`shader_verify` detects the dialect and says which one it found. Believe it, and
if it guessed wrong, pass `dialect` explicitly.

## Desktop GLSL is not WebGL GLSL

If a source starts with `#version 330 core` (or 110, 120, 150, 450), it is desktop
GLSL. ANGLE - the compiler behind every browser - does not accept it. The row
answers `v1-static` and names `glslangValidator` as the tool that would compile it.
Three constructs mark the boundary, and each is a compile error on the wrong side:

```glsl
#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }
```

That is a complete ES 3.00 fragment shader: it compiles as written. Its ES 1.00
twin is below - note `gl_FragColor` and the required precision statement.

```glsl
precision highp float;
uniform float u_time;
void main() {
  float d = length(gl_FragCoord.xy / 256.0 - 0.5);
  gl_FragColor = vec4(vec3(smoothstep(0.4, 0.35, d)), 1.0);
}
```

`gl_FragColor` does not exist in `#version 300 es`. `varying` became
`in`/`out`. `texture2D` became `texture`. `attribute` became `in`. Those four
renames are most of what a "port to WebGL2" actually is.

## Precision is not optional

A WebGL 1 fragment shader with no precision qualifier does not compile:
`ERROR: 0:1: '' : No precision specified for (float)`. Every `es100` fragment
starts with `precision highp float;` (or `mediump`). Vertex shaders have a default
precision, which is why skipping it there works.

`highp` is what you want for coordinates and time; `mediump` is fine for colour
and cheaper on mobile. Do not use `highp` inside a loop on hardware you have not
tested - it is the first thing to drop for performance.

## Types and the arithmetic traps

```glsl
precision highp float;
float asFloat(int value) {
  return float(value);        // explicit conversion: `float x = 1;` is an error in ES 3.00
}
vec3 swapChannels(vec3 col) {
  col.rg = col.gr;            // swizzles assign in both directions
  return col;
}
mat2 rotate(float angle) {
  // mat2 is COLUMN-major: these four numbers are columns (a,b) and (c,d)
  return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
}
void main() {
  vec2 p = rotate(0.5) * (gl_FragCoord.xy / 64.0 - 0.5);
  gl_FragColor = vec4(swapChannels(vec3(p, asFloat(1))), 1.0);
}
```

A statement may not sit at global scope in GLSL: only declarations and functions can,
and a global initialiser must be a constant expression. That is why the conversions
above live inside functions.

The two errors that most often cost an hour:

- `dimension mismatch` - a `vec3` assigned to a `float`, or `vec3(1.0)` passed to
  a `float` parameter. The message is precise; read the two types it names.
- `no matching overloaded function found` - the function exists but not for those
  argument types. `min(1.0, 2)` fails because there is no `min(float, int)`.

## Functions that are always there

`sin cos tan asin acos atan` `pow exp log exp2 log2 sqrt inversesqrt` `abs sign
floor ceil fract mod min max clamp mix step smoothstep` `length distance dot cross
normalize reflect refract faceforward` `vec2 vec3 vec4 mat2 mat3 mat4 float int
bool` `texture textureLod` (ES 3.00) / `texture2D` (ES 1.00).

`atan(y, x)` - two arguments - is how you get an angle without losing the
quadrant. `mod(x, 1.0)` repeats, but `fract(x)` is cheaper and identical for
positive input. `smoothstep(edge0, edge1, x)` needs `edge0 < edge1` or it is
undefined: to invert a ramp, use `1.0 - smoothstep(a, b, x)`.

## Loops and branches

In GLSL ES 1.00 the specification requires a **constant** loop bound:

```glsl
precision highp float;
void main() {
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {   // literal 8: always fine
    sum += 0.125;
  }
  gl_FragColor = vec4(vec3(sum), 1.0);
}
```

`for (int i = 0; i < u_steps; i++)` compiles on ANGLE and may fail on a mobile
driver. If the count must vary, write a constant bound and `break` on the uniform.
`shader_verify` warns about this (`loop-bound`), because the compiler here will not.

Branches are allowed but a branch that halves the work is often slower than
`mix()`: prefer arithmetic over divergence in a fragment shader.

## Derivatives need an extension in ES 1.00

`fwidth`, `dFdx` and `dFdy` are screen-space derivatives. In WebGL 1 they require
`gl.getExtension('OES_standard_derivatives')` **before the shader is compiled**,
otherwise the error is misleading:

```
WARNING: 0:1: 'GL_OES_standard_derivatives' : extension is not supported
ERROR: 0:108: 'fwidth' : no matching overloaded function found
```

It says the *extension* is unsupported when the real problem is that nobody asked
for it. This row enables it for its own compiles; a page that embeds the shader
must do the same. In ES 3.00 no extension is needed.

## The uniform contract this row uses

Every wrapper dialect (`shadertoy`, `shader-skills`, `module`) is given:

| uniform | type | meaning |
|---|---|---|
| `u_time` | float | seconds since start |
| `u_resolution` | vec2 | drawing buffer size in pixels |
| `u_mouse` | vec2 | pointer position in pixels |
| `u_frame` | float | frame counter |

Shadertoy names are provided too: `iResolution` (vec3), `iTime`, `iTimeDelta`,
`iFrameRate`, `iMouse` (vec4) and `iChannel0..3`. **`iFrame` is a float in
Shadertoy and an int in the shader-skills corpus** - which is why those are two
dialects here. A function taking `int` rejects a float `iFrame`, and the error is
`no matching overloaded function found` at the call site.

## Parameters

Declare a tunable value on its own comment line; the tab turns it into a slider and
every emitted page sets it:

```glsl
// @param SPEED float 0.1..2.0 default 0.6 "Rotation speed"
precision highp float;
uniform float u_time;
uniform float u_speed;
void main() {
  float d = length(gl_FragCoord.xy / 256.0 - 0.5);
  gl_FragColor = vec4(vec3(0.5 + 0.5 * sin(d * 30.0 - u_time * u_speed)), 1.0);
}
```

The uniform name is `u_` plus the lower-cased parameter name: `SPEED` -> `u_speed`.
The source must declare it, or `lint` warns `param-uniform`.

## Check yourself before you claim it works

`shader_verify` answers with a **rung**, and only these count:

- `v1-static` - the rules above ran. No compiler did. Say so.
- `v2-compiled` - a real compiler accepted it, on your line numbers.
- `v3-drawn` - a frame was actually drawn and the pixels came back.
- `v4-measured` - two different times drew differently.

A shader is not "working" at `v1`. If you are on a machine with no browser, say
that the compile did not happen instead of implying it did.
