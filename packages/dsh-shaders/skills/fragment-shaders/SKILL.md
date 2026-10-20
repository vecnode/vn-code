---
name: fragment-shaders
description: Writing a fragment shader that looks like something - the full-screen triangle, uv space, signed distance fields, noise and fbm, domain warping, raymarching budgets, tone mapping and banding. Every example compiles. Read this when the task is "make it look good", not "make it compile".
whenToUse: When writing or improving a fragment shader's visual technique - patterns, SDFs, raymarched scenes, noise, colour - or when a shader compiles but the picture is flat, noisy, or banded.
---

# Fragment shaders that look like something

A fragment shader runs once per pixel and returns one colour. Everything below is
about making that colour depend on the pixel's position and the clock in a way a
person wants to look at.

## The frame: one triangle, no vertices to speak of

You do not need geometry. A single triangle covering the viewport, drawn with
`gl.drawArrays(TRIANGLES, 0, 3)`, covers every pixel. The vertex shader is:

```glsl
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
```

and the buffer is three vertices: `(-1,-1) (3,-1) (-1,3)`. The corners are outside
the viewport on purpose - the visible part is the full square. `shader_target
target=frag` writes both files for you.

## uv space, and the aspect ratio trap

```glsl
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
void main() {
  // centred uv: x and y both run -0.5..0.5 on the SHORT axis
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float d = length(uv);
  float ring = 0.5 + 0.5 * sin(d * 30.0 - u_time * 2.0);
  gl_FragColor = vec4(vec3(ring), 1.0);
}
```

Dividing by `u_resolution` alone makes circles into ellipses on any non-square
canvas. Dividing by `min(x, y)` keeps them round at any aspect. If you would rather
work in 0..1, divide by `u_resolution` and fix the aspect afterwards - but choose
one convention and keep it.

`gl_FragCoord` is in **pixels**, with y up from the bottom-left. That is not what
`<canvas>` CSS or an image editor shows, which is the single most common source of
"my shader is upside down".

## Signed distance fields

An SDF returns how far a point is from a shape: negative inside, positive outside.
That one number gives you the shape, its outline, and its antialiasing.

```glsl
precision highp float;
uniform vec2 u_resolution;
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float d = min(sdCircle(p, 0.28), sdBox(p - vec2(0.35, 0.0), vec2(0.16)));
  // antialias with the pixel footprint, not with a magic constant
  float px = 2.0 / min(u_resolution.x, u_resolution.y);
  float shape = smoothstep(px, -px, d);
  vec3 col = mix(vec3(0.06, 0.07, 0.09), vec3(0.95, 0.72, 0.45), shape);
  gl_FragColor = vec4(col, 1.0);
}
```

`min()` unions, `max(a, -b)` subtracts, `smoothstep` on the distance antialiases.
The pixel size `px` comes from the resolution - a hard-coded `0.01` produces a
different edge thickness on every screen.

For soft blends, `smin(a, b, k)` (a smooth minimum) is the standard trick and is
in the `module/sdf*` and `module/operators` files of the vendored corpus.

## Noise, and why one octave is never enough

```glsl
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);           // smoothstep interpolation
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
void main() {
  vec2 p = gl_FragCoord.xy / u_resolution * 4.0;
  float f = fbm(p + vec2(u_time * 0.1, 0.0));
  gl_FragColor = vec4(vec3(f), 1.0);
}
```

Rules that matter: the octave multiplier is `~2.0` (2.02 breaks grid alignment),
amplitude halves per octave, and 4-6 octaves is the useful range. `sin`-based hashes
are cheap but band on large coordinates; the integer hashes in `module/hash` do not.

Domain warping turns noise into marble and smoke: sample noise, use it to offset the
coordinates, sample again.

```glsl
precision highp float;
uniform vec2 u_resolution;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 p = gl_FragCoord.xy / u_resolution * 3.0;
  vec2 q = vec2(noise(p), noise(p + vec2(5.2, 1.3)));
  float marble = sin((p.x + q.x * 4.0) * 6.0) * 0.5 + 0.5;
  gl_FragColor = vec4(vec3(marble), 1.0);
}
```

## Raymarching, and the budget you have

Raymarching steps a ray through a distance field. It is the technique that gets you
3D-looking scenes with no geometry, and the one that most often runs at 12 fps
because nobody counted the steps.

```glsl
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
float sdSphere(vec3 p, float r) { return length(p) - r; }
float map(vec3 p) {
  vec3 q = p;
  q.xz = mat2(cos(u_time * 0.4), sin(u_time * 0.4), -sin(u_time * 0.4), cos(u_time * 0.4)) * q.xz;
  return sdSphere(q - vec3(0.0, 0.0, 0.0), 0.9) * 0.9;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx)));
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(uv, -1.4));
  float t = 0.0;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < 0.001) break;
    t += d * 0.9;
    if (t > 12.0) break;
  }
  vec3 col = vec3(0.06, 0.07, 0.1);
  vec3 p = ro + rd * t;
  if (t < 12.0) {
    vec3 n = normalAt(p);
    float light = max(dot(n, normalize(vec3(0.6, 0.8, 0.4))), 0.0);
    col = vec3(0.9, 0.6, 0.35) * (0.15 + 0.85 * light);
  }
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
```

Three numbers to choose deliberately: the step count (96 is already heavy at 4K),
`d * 0.9` (slightly under-stepping avoids surface bands), and the far clip
(`t > 12.0`). A loop that only ends on `d < eps` is the classic hang.

## Colour: work linear, show sRGB

Luminance is not `(r+g+b)/3`. Gamma is not optional. Two habits cover most of it:
mix in linear space and tone-map at the end.

```glsl
precision highp float;
uniform vec2 u_resolution;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec3 a = toLinear(vec3(0.95, 0.55, 0.25));
  vec3 b = toLinear(vec3(0.15, 0.35, 0.75));
  vec3 col = mix(a, b, smoothstep(0.2, 0.8, uv.x));
  col = col / (1.0 + col);                 // Reinhard: keeps highlights in range
  gl_FragColor = vec4(toSrgb(col), 1.0);
}
```

`mix()` between two colours in sRGB space goes through grey and looks muddy;
in linear space it does not. The `module/color` and `module/tonemap` files in the
corpus have Oklab, AgX and PBR-Neutral versions if you need them.

## Banding, and the one-line fix

An 8-bit target has 256 levels. A smooth gradient across 1000 pixels shows stripes.
Add a sub-LSB dither before output:

```glsl
precision highp float;
uniform vec2 u_resolution;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec3 col = vec3(0.2 + 0.6 * uv.x);       // a wide, very shallow gradient
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
```

For static images use an ordered or interleaved-gradient dither instead of white
noise, so it does not crawl. `module/post` has `ditherTPDF`.

## Check the picture, not the log

A shader can compile, link, draw, and produce a black rectangle. `shader_render`
reads the pixels back and says whether the frame is black, flat, or has many
colours - and whether two different times differ. Use it before you say a shader
looks good:

1. `shader_write` - it compiles?
2. `shader_render frames=3` - does it draw, is it varied, does it move?
3. look at the PNG. That is the only step that judges the picture.

The vendored corpus is there to be read, not reinvented: `shader_kit
action=search technique=webgl1` for finished pieces, `action=example
id=module/noise` for a module you can include.
