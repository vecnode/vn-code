---
name: shader-web
description: Getting a shader onto a page - the WebGL bootstrap, uniform plumbing, device pixel ratio, resize, pause on hidden tab, reduced motion, the drop-in HTML file, parameter updates over postMessage, and embedding it without a framework. Read this when the shader has to run in a browser.
whenToUse: When deploying a shader to a web page, embedding it as a background, wiring up controls, or debugging a page where the canvas is black but the shader compiles.
---

# Shaders on the web

`shader_target target=web` writes one self-contained HTML file: no framework, no
build step, no request. That is the deployment model the Radiant corpus uses, and
it is the right default because a page that needs nothing cannot break because
something is missing.

## The bootstrap, in full

Everything a fragment shader page needs, and nothing else:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shader</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0a0a0a; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<script>
const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
if (!gl) throw new Error('no WebGL');

const VERTEX = 'attribute vec2 a_position; void main() { gl_Position = vec4(a_position, 0.0, 1.0); }';
const FRAGMENT = `precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  gl_FragColor = vec4(uv.x, uv.y, 0.5 + 0.5 * sin(u_time), 1.0);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'compile failed');
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program) || 'link failed');
}
gl.useProgram(program);

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const at = gl.getAttribLocation(program, 'a_position');
gl.enableVertexAttribArray(at);
gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);

const uTime = gl.getUniformLocation(program, 'u_time');
const uRes = gl.getUniformLocation(program, 'u_resolution');

function resize() {
  // Cap the pixel ratio: a 3x phone rendering a 4K shader is a battery fire.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

let running = true;
const start = performance.now();
function frame(now) {
  if (!running) return;
  gl.uniform1f(uTime, (now - start) / 1000);
  gl.uniform2f(uRes, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { running = false; }
  else if (!running) { running = true; requestAnimationFrame(frame); }
});
</script>
</body>
</html>
```

Every part of that is load-bearing:

- **`preserveDrawingBuffer`** is not set here. Leave it off for animation (it costs
  performance); turn it ON if you need `toDataURL()` or a screenshot.
- **DPR capped at 2.** `canvas.width = clientWidth * devicePixelRatio` uncapped
  renders four times the pixels on a 2x display for a difference nobody sees.
- **`visibilitychange`.** A background tab that keeps drawing wastes a battery and
  is the most common complaint about shader backgrounds.
- **`resize` sets `canvas.width`**, which resets the drawing buffer - so the
  viewport must be set again in the same handler, after the size.
- **The error is thrown with the log.** A black canvas with nothing in the console
  is the worst outcome, and it is always avoidable.

## Two contexts, two dialects

| dialect | context | extra |
|---|---|---|
| `es100` (gl_FragColor) | `getContext('webgl')` | call `getExtension('OES_standard_derivatives')` before compiling if you use `fwidth` |
| `es300` (`#version 300 es`) | `getContext('webgl2')` | none |
| `shadertoy` / `shader-skills` | `getContext('webgl2')` | the page must supply `iResolution`, `iTime`, `iMouse`, `iFrame` |

A WebGL 1 context rejects a `#version 300 es` shader with
`unsupported shader version 300` - which reads like a shader bug and is a context
bug. `shader_target target=web` picks the right one for you.

## Driving it from outside: the postMessage contract

A drop-in page has no API, so it takes parameter updates over `postMessage`. This
is Radiant's own shape, and pages this row emits accept exactly it:

```js
// on the parent page
const frame = document.querySelector('iframe');
frame.contentWindow.postMessage({ type: 'param', name: 'SPEED', value: 0.8 }, '*');
```

The page listens:

```js
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'param') return;
  if (data.name === 'SPEED') speed = data.value;
});
```

Match on the **parameter name** (`SPEED`, as declared in `// @param SPEED ...`),
not on the uniform name. The page owns the translation to `u_speed`.

## Embedding it as a background

```html
<iframe
  src="my-shader.html"
  title="Background"
  style="position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: -1;"
  aria-hidden="true"
  tabindex="-1"
></iframe>
```

Three habits: `aria-hidden="true"` (it is decoration, not content), `z-index: -1`
with the content above it, and **no pointer events** - an iframe over the page eats
every click. If it must sit behind text, put it in a container with
`pointer-events: none`.

Do not put a shader behind text without checking contrast: a moving background
behind body copy is a readability failure waiting to happen. Either keep it behind
a scrim (`background: rgba(0,0,0,.55)` over the canvas) or keep it in a hero band.

## Inline instead of an iframe

If the page already has a canvas, the bootstrap above drops in directly: keep the
program in a module, expose `setParam(name, value)` and `resize()`. The iframe is
only needed when the shader is a *file* - which is the case for a drop-in
background, and which is why the emitted artefact is a whole page.

## Reduced motion is not optional

```js
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const time = reduced ? 0 : (now - start) / 1000;
```

An animation that ignores this preference is an accessibility defect, not a
feature. The page this row emits freezes time at 0 when the preference is set, so
the shader still shows its picture, unmoving.

## What to check before you ship it

1. It renders **at the size it will be used at** - not at 800x600.
2. No console output. Warnings are still read as errors by people who look.
3. It stops when the tab is hidden (watch `requestAnimationFrame` in the profiler).
4. It survives a resize and a device rotation.
5. It costs what you think: on a 4K display a heavy raymarcher is 8.3M pixels per
   frame. `shader_render` at your intended size is the honest measurement.
6. Nothing reaches the network. A shader needs no font, no image, no CDN.

`shader_verify` proves the GLSL; the page is where the driver, the DPR and the
resize behaviour get their say. Test it in the browser you are shipping to.
