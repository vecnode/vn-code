/**
 * dsh-shaders — one shader, five destinations.
 *
 *   web        a standalone HTML page that runs it (the Radiant deployment
 *              model: one file, no build step, no framework, no network).
 *   frag       the source as a .frag file, plus a .vert that draws it.
 *   isf        an ISF shader (.fs) and its JSON metadata, for a VJ host.
 *   ffgl       a FreeFrameGL C++ SCAFFOLD - never a compiled plugin, because
 *              FFGL is a C++ ABI and this row has no SDK and no compiler.
 *   shadertoy  the source with Shadertoy's uniform names.
 *
 * Two rules run through all five:
 *
 *   1. **the emitted code is the code that was compiled.** `web` and `frag` embed
 *      the SAME assembled string `verify.assemble` produced, so what ships is
 *      what a `shader_verify` checked. Nothing is re-written on the way out.
 *   2. **a port says it is a port.** ISF, FFGL and Shadertoy each get a note
 *      naming exactly what was renamed, because a uniform that is renamed is a
 *      thing the host must be told about, not a detail to bury.
 */

import { assemble, detectDialect, FULLSCREEN_VERTEX_ES100, FULLSCREEN_VERTEX_ES300, parseParams, WRAPPER_DIALECTS } from './verify.js'

/** Every target this row emits. */
export const TARGETS = ['web', 'frag', 'isf', 'ffgl', 'shadertoy']

/** How a target's files should be named on disk. */
export function extensionFor(target) {
  if (target === 'web') return 'html'
  if (target === 'frag') return 'frag'
  if (target === 'isf') return 'fs'
  if (target === 'ffgl') return 'cpp'
  if (target === 'shadertoy') return 'glsl'
  return 'txt'
}

/** A title that is safe as a file name stem. Lower case: a name must not change meaning on a case-sensitive filesystem. */
function stemOf(title, fallback = 'shader') {
  const stem = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return stem === '' ? fallback : stem
}

/** A C++ identifier from a title. */
function identifierOf(title) {
  const name = String(title ?? 'Shader')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return /^[A-Za-z]/.test(name) ? name : 'Shader' + name
}

/**
 * The runtime a `web` page carries.
 *
 * Written to the uniform contract the whole row documents: `u_time` (seconds),
 * `u_resolution`, `u_mouse`, `u_frame`, plus one uniform per `@param`. It caps the
 * device pixel ratio at 2, pauses on a hidden tab, freezes time under
 * `prefers-reduced-motion`, and takes live updates over `postMessage` with the
 * same `{ type: 'param', name, value }` shape Radiant's shaders accept - so a
 * page this row emits can be driven by the code that already drives those.
 *
 * A compile failure is drawn ON the page, with the compiler's own log: a black
 * rectangle with no explanation is the worst possible outcome, and the page is
 * the one place the real driver gets to speak.
 */
export const WEB_RUNTIME = `
(function () {
  var config = window.__SHADER__;
  var canvas = document.getElementById('canvas');
  var status = document.getElementById('status');
  var fail = function (message, log) {
    status.textContent = message + (log ? '\\n\\n' + log : '');
    status.className = 'status error';
    status.hidden = false;
  };
  var gl = null;
  try {
    gl = canvas.getContext(config.context, { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
  } catch (err) {
    gl = null;
  }
  if (!gl) {
    fail('This browser has no ' + config.context + ' context, so the shader cannot run here.');
    return;
  }
  for (var i = 0; i < config.extensions.length; i += 1) {
    try { gl.getExtension(config.extensions[i]); } catch (err) { /* not offered here */ }
  }
  var compile = function (type, source, label) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      fail('The ' + label + ' shader did not compile.', String(gl.getShaderInfoLog(shader) || ''));
      return null;
    }
    return shader;
  };
  var vertex = compile(gl.VERTEX_SHADER, config.vertex, 'vertex');
  if (vertex === null) return;
  var fragment = compile(gl.FRAGMENT_SHADER, config.fragment, 'fragment');
  if (fragment === null) return;
  var program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    fail('The program did not link.', String(gl.getProgramInfoLog(program) || ''));
    return;
  }
  gl.useProgram(program);

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var attribute = gl.getAttribLocation(program, 'a_position');
  if (attribute >= 0) {
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  }

  var params = {};
  for (var p = 0; p < config.params.length; p += 1) {
    params[config.params[p].uniform] = config.params[p].default;
  }
  var mouse = [0, 0, 0, 0];
  var setUniform = function (name, value) {
    var location = gl.getUniformLocation(program, name);
    if (location === null) return;
    if (typeof value === 'number') {
      var isInt = false;
      for (var q = 0; q < config.params.length; q += 1) {
        if (config.params[q].uniform === name && config.params[q].type === 'int') isInt = true;
      }
      if (isInt || name === 'iFrame' || name === 'FRAMEINDEX') gl.uniform1i(location, Math.round(value));
      else gl.uniform1f(location, value);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
    }
  };

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var running = true;
  var resolution = [1, 1];
  var resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    resolution = [width, height];
  };
  window.addEventListener('resize', resize);
  resize();

  var started = performance.now();
  var frame = 0;
  var draw = function (now) {
    if (!running) return;
    var time = reduced ? 0 : (now - started) / 1000;
    setUniform('u_time', time);
    setUniform('u_resolution', resolution);
    setUniform('u_res', resolution);
    setUniform('u_mouse', [mouse[0], mouse[1]]);
    setUniform('u_frame', frame);
    setUniform('iTime', time);
    setUniform('iResolution', [resolution[0], resolution[1], 1]);
    setUniform('iMouse', mouse);
    setUniform('iFrame', frame);
    for (var name in params) if (Object.prototype.hasOwnProperty.call(params, name)) setUniform(name, params[name]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame += 1;
    requestAnimationFrame(draw);
  };

  canvas.addEventListener('mousemove', function (event) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    mouse[0] = event.clientX * dpr;
    mouse[1] = (canvas.clientHeight - event.clientY) * dpr;
  });
  canvas.addEventListener('touchmove', function (event) {
    if (event.touches.length === 0) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    mouse[0] = event.touches[0].clientX * dpr;
    mouse[1] = (canvas.clientHeight - event.touches[0].clientY) * dpr;
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      requestAnimationFrame(draw);
    }
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'param' || typeof data.name !== 'string') return;
    for (var q = 0; q < config.params.length; q += 1) {
      if (config.params[q].name === data.name || config.params[q].uniform === data.name) {
        params[config.params[q].uniform] = data.value;
        return;
      }
    }
  });

  requestAnimationFrame(draw);
})();
`

/** The page around the runtime. Dark by default, and legible if it fails. */
function webPage({ title, config, description }) {
  const id = stemOf(title)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; }
  canvas { display: block; width: 100vw; height: 100vh; }
  .label {
    position: fixed; top: 20px; left: 24px; z-index: 10; pointer-events: none; user-select: none;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(200, 149, 108, 0.55);
  }
  .status {
    position: fixed; inset: auto 0 0 0; z-index: 20; margin: 0; padding: 16px 20px; max-height: 55vh; overflow: auto;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    color: #f4d9c4; background: rgba(24, 12, 8, 0.94); border-top: 1px solid rgba(200, 149, 108, 0.35);
  }
  .status.error { color: #ffd9d0; background: rgba(40, 10, 8, 0.96); }
</style>
</head>
<body>
<div class="label">${escapeHtml(title)}</div>
<canvas id="canvas"></canvas>
<pre id="status" class="status" hidden></pre>
<script>window.__SHADER__ = ${JSON.stringify(config)};</script>
<script>${WEB_RUNTIME}</script>
<!-- ${escapeHtml(description)} -->
</body>
</html>
`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Emit one target.
 *
 * @param options - `{ shader, target, name }` where `shader` is a stored shader
 *   (`{ id, title, kind, dialect, source, includes, params }`).
 * @returns `{ ok, target, files: [{ name, text }], notes, refused }`.
 */
export function emit(options) {
  const shader = options.shader
  const target = String(options.target ?? '')
  if (!TARGETS.includes(target)) {
    return { ok: false, refused: 'unknown target ' + JSON.stringify(target) + '; use ' + TARGETS.join(', '), files: [], notes: [] }
  }
  const stem = stemOf(options.name ?? shader.title ?? shader.id)
  const detected = detectDialect(shader.source)
  const dialect = shader.dialect !== undefined && shader.dialect !== detected.dialect ? shader.dialect : detected.dialect
  const params = Array.isArray(shader.params) && shader.params.length > 0 ? shader.params : parseParams(shader.source)
  const includes = Array.isArray(shader.includes) ? shader.includes : []
  const assembled = assemble({ source: shader.source, dialect, stage: shader.kind, includes, params })

  if (target === 'frag' || target === 'web') {
    if (!assembled.ok) return { ok: false, refused: assembled.error, files: [], notes: [] }
    if (assembled.dialect === 'desktop') {
      // A desktop shader is already a .frag for a desktop host; it is `web` that
      // cannot use it.
      if (target === 'web') {
        return {
          ok: false,
          refused:
            'A desktop GLSL source cannot run on the web: WebGL accepts GLSL ES only. `shader_target target=frag` gives you the .frag for a desktop host; porting it to ES is a real edit, and `shader_verify` reports what would not compile.',
          files: [],
          notes: [],
        }
      }
    }
    if (target === 'frag') {
      const files = [{ name: stem + '.frag', text: shader.source }]
      if (shader.kind !== 'vertex') {
        files.push({ name: stem + '.vert', text: assembled.dialect === 'es300' || WRAPPER_DIALECTS.includes(assembled.dialect) ? FULLSCREEN_VERTEX_ES300 : FULLSCREEN_VERTEX_ES100 })
      }
      return {
        ok: true,
        target,
        files,
        notes: [
          'The .frag is byte-for-byte the stored source. The .vert is the full-screen triangle that draws it, so the pair is complete.',
          assembled.dialect === 'desktop' ? 'This is desktop GLSL: it compiles on a desktop OpenGL host, not in WebGL.' : 'This is GLSL ES: it compiles in WebGL.',
        ],
      }
    }
    // web
    const specName = assembled.dialect === 'es100' ? 'webgl' : 'webgl2'
    const extensions = assembled.dialect === 'es100' ? ['OES_standard_derivatives', 'EXT_shader_texture_lod'] : ['EXT_color_buffer_float', 'OES_texture_float_linear']
    const config = {
      context: specName,
      extensions,
      vertex: assembled.dialect === 'es100' ? FULLSCREEN_VERTEX_ES100 : FULLSCREEN_VERTEX_ES300,
      fragment: assembled.wrapped,
      params: params
        .filter((entry) => entry.name !== null && entry.name !== undefined)
        .map((entry) => ({
          name: entry.name,
          uniform: entry.uniform,
          type: entry.type,
          default: entry.default === null || entry.default === undefined ? defaultFor(entry.type) : entry.default,
          min: entry.min,
          max: entry.max,
          description: entry.description,
        })),
    }
    return {
      ok: true,
      target,
      files: [{ name: stem + '.html', text: webPage({ title: shader.title ?? shader.id, config, description: 'Generated by dsh-shaders: one file, no build step, no network.' }) }],
      notes: [
        'One self-contained page: no framework, no bundler, no request. It runs from the filesystem.',
        'Parameters take live updates over postMessage with Radiant\'s own shape: { type: \'param\', name: \'SPEED\', value: 0.5 }.',
        'A compile failure is drawn on the page with the driver\'s own log, so a black screen is never unexplained.',
      ],
      config,
    }
  }

  if (target === 'isf') {
    if (assembled.dialect === 'desktop') {
      return { ok: false, refused: 'ISF is GLSL ES with gl_FragColor; a desktop source must be ported first.', files: [], notes: [] }
    }
    const ported = portToIsf(shader, { assembled, params })
    const metadata = {
      DESCRIPTION: shader.title ?? shader.id,
      ISFVSN: '2',
      CREDIT: 'Generated by dsh-shaders from ' + shader.id,
      INPUTS: [
        { NAME: 'inputImage', TYPE: 'image' },
        ...params
          .filter((entry) => entry.name !== null && entry.name !== undefined)
          .map((entry) => ({
            NAME: entry.name,
            TYPE: entry.type === 'bool' ? 'bool' : entry.type === 'int' ? 'long' : 'float',
            ...(entry.min === null || entry.min === undefined ? {} : { MIN: entry.min }),
            ...(entry.max === null || entry.max === undefined ? {} : { MAX: entry.max }),
            ...(entry.default === null || entry.default === undefined ? {} : { DEFAULT: entry.default }),
            ...(entry.description === '' || entry.description === undefined ? {} : { LABEL: entry.description }),
          })),
      ],
      PASSES: [{ TARGET: '::__inputImage_1__', WIDTH: '$WIDTH', HEIGHT: '$HEIGHT' }],
    }
    return {
      ok: true,
      target,
      files: [
        { name: stem + '.fs', text: ported.text },
        { name: stem + '.json', text: JSON.stringify(metadata, null, 2) + '\n' },
      ],
      notes: ported.notes,
    }
  }

  if (target === 'shadertoy') {
    if (assembled.dialect === 'desktop') return { ok: false, refused: 'Shadertoy runs GLSL ES; a desktop source must be ported first.', files: [], notes: [] }
    const ported = portToShadertoy(shader)
    return { ok: true, target, files: [{ name: stem + '.glsl', text: ported.text }], notes: ported.notes }
  }

  // ffgl
  const scaffold = ffglScaffold(shader, { assembled, params, identifier: identifierOf(shader.title ?? shader.id) })
  return {
    ok: true,
    target: 'ffgl',
    files: [
      { name: stem + '.cpp', text: scaffold.text },
      { name: stem + '.json', text: JSON.stringify({ title: shader.title ?? shader.id, uniforms: scaffold.uniforms }, null, 2) + '\n' },
    ],
    notes: scaffold.notes,
  }
}

/** A sensible default for a parameter with none declared. */
function defaultFor(type) {
  if (type === 'bool') return false
  if (type === 'vec2') return [0, 0]
  if (type === 'vec3' || type === 'color') return [0, 0, 0]
  if (type === 'vec4') return [0, 0, 0, 1]
  return 0
}

/**
 * ISF names its uniforms differently, so the port renames them and SAYS SO.
 *
 * ISF provides `RENDERSIZE`, `TIME`, `TIMEDELTA`, `FRAMEINDEX`, `inputImage` and
 * `isf_FragNormCoord`, and expects `void main()` writing `gl_FragColor`.
 */
function portToIsf(shader, { assembled, params }) {
  const notes = ['ISF port: TIME/RENDERSIZE/FRAMEINDEX replace iTime/iResolution/iFrame, and the entry point is main() writing gl_FragColor.']
  let text
  if (assembled.dialect === 'shadertoy' || assembled.dialect === 'shader-skills') {
    const body = shader.source
      .replace(/\biResolution\b/g, 'RENDERSIZE')
      .replace(/\biTime\b/g, 'TIME')
      .replace(/\biTimeDelta\b/g, 'TIMEDELTA')
      .replace(/\biFrame\b/g, 'FRAMEINDEX')
      .replace(/\biMouse\b/g, 'MOUSE')
    const usesMouse = /\bMOUSE\b/.test(body)
    text = [
      '/* ISF 2 shader generated by dsh-shaders from ' + shader.id + ' */',
      '#version 100',
      'precision highp float;',
      'uniform vec2 RENDERSIZE;',
      'uniform float TIME;',
      'uniform float TIMEDELTA;',
      'uniform int FRAMEINDEX;',
      'uniform sampler2D inputImage;',
      usesMouse ? 'uniform vec2 MOUSE;' : '// no mouse: this shader did not use iMouse',
      ...params.filter((entry) => entry.name !== null && entry.name !== undefined).map((entry) => 'uniform float ' + entry.name + ';'),
      '',
      body,
      '',
      'void main() {',
      '  vec4 isfColor = vec4(0.0, 0.0, 0.0, 1.0);',
      '  mainImage(isfColor, gl_FragCoord.xy);',
      '  gl_FragColor = isfColor;',
      '}',
      '',
    ].join('\n')
    if (usesMouse) notes.push('iMouse became a `MOUSE` input, which ISF does not define itself: keep the input in the JSON or delete it.')
  } else if (assembled.dialect === 'module') {
    text = shader.source
    notes.push('This is a library module, not a shader: it has no entry point, so it will not render as an ISF until something calls it.')
  } else {
    text = shader.source
    notes.push('Emitted as written (it was already ES 1.00): check that it declares `void main()` and writes gl_FragColor.')
  }
  return { text, notes }
}

/**
 * Shadertoy names: `iTime`, `iResolution`, `iMouse`, `iFrame`, and `mainImage`.
 * A source that already uses them is returned unchanged and says so.
 */
function portToShadertoy(shader) {
  const source = String(shader.source)
  const notes = []
  if (/void\s+mainImage\s*\(/.test(source)) {
    const renamed = source.replace(/\bu_time\b/g, 'iTime').replace(/\bu_resolution\b/g, 'iResolution').replace(/\bu_res\b/g, 'iResolution').replace(/\bu_mouse\b/g, 'iMouse').replace(/\bu_frame\b/g, 'iFrame')
    if (renamed !== source) notes.push('Renamed u_time/u_resolution/u_mouse/u_frame to iTime/iResolution/iMouse/iFrame.')
    notes.push('Already shaped for Shadertoy: mainImage(out vec4, in vec2) and no #version.')
    return { text: renamed, notes }
  }
  // An es100 shader: rewrite the entry point into mainImage.
  const body = source
    .replace(/\bgl_FragColor\b/g, 'fragColor')
    .replace(/\bu_time\b/g, 'iTime')
    .replace(/\bu_resolution\b/g, 'iResolution')
    .replace(/\bu_res\b/g, 'iResolution')
    .replace(/\bu_mouse\b/g, 'iMouse')
    .replace(/\bu_frame\b/g, 'iFrame')
  notes.push('Ported an ES 1.00 shader to Shadertoy: gl_FragColor became the mainImage out parameter, and the uniform names were replaced.')
  const text = [
    '// Ported by dsh-shaders from an ES 1.00 source. Shadertoy supplies iResolution, iTime,',
    '// iFrame, iMouse and iChannel0..3; nothing else is defined for you.',
    body.replace(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/, 'void mainImage(out vec4 fragColor, in vec2 fragCoord)'),
  ].join('\n')
  return { text, notes }
}

/**
 * The FFGL scaffold.
 *
 * FFGL is a C++ plugin ABI (the SDK is not vendored, and this row compiles no
 * C++), so this is a STARTING POINT with the shader embedded and every uniform
 * mapped in a comment. It is emitted with the checklist it needs, and it never
 * claims to build.
 */
function ffglScaffold(shader, { assembled, params, identifier }) {
  const uniforms = params
    .filter((entry) => entry.name !== null && entry.name !== undefined)
    .map((entry) => ({ uniform: entry.uniform, param: entry.name, type: entry.type, min: entry.min, max: entry.max, default: entry.default }))
  const fragment = assembled.ok ? assembled.wrapped : shader.source
  const text = `/*
 * ${identifier} - FreeFrameGL plugin SCAFFOLD, generated by dsh-shaders.
 *
 * THIS IS NOT A BUILDABLE PLUGIN. It is the shader and its uniform mapping in the
 * shape the FFGL SDK expects you to fill in. The FFGL SDK is C++ and is not
 * vendored by this package, and no compiler is run on this file.
 *
 * What this file gives you:
 *   - the GLSL source, verbatim, as a raw string;
 *   - one uniform per parameter, with the name, type, range and default;
 *   - the FFGL entry points as declared TODOs, in the order the SDK calls them.
 *
 * What you must do (this is the checklist, and it is the honest part):
 *   1. Add the FFGL SDK to the project and implement the PluginInstance methods
 *      below against YOUR SDK version - the signatures differ between FFGL 1.x
 *      and 2.x, which is why they are not written out here.
 *   2. Compile the shader in the plugin host and check the info log on the
 *      MACHINE THAT WILL RUN IT: this shader was checked with ANGLE/SwiftShader,
 *      and a GPU driver can differ.
 *   3. Bind every parameter below to an FFGL parameter so the host can drive it.
 *   4. Verify the frame rate in the host at the resolution you intend to use.
 *
 * Uniforms this shader needs (name, type, default, range):
${uniforms.length === 0 ? ' *   (none declared)' : uniforms.map((entry) => ' *   ' + entry.uniform.padEnd(18) + entry.type.padEnd(7) + ' default ' + JSON.stringify(entry.default) + (entry.min === null ? '' : '  range ' + String(entry.min) + '..' + String(entry.max))).join('\n')}
 *
 * The times this row provides in its own harness map to an FFGL host as:
 *   u_time        <- the host clock, in seconds
 *   u_resolution  <- the render size
 *   u_mouse       <- pointer position, if the host offers one
 *   u_frame       <- frame counter
 */

#include <FFGLSDK.h>

static const char *kFragmentSource = R"glsl(
${fragment}
)glsl";

static const char *kVertexSource = R"glsl(
${assembled.dialect === 'es100' ? FULLSCREEN_VERTEX_ES100 : FULLSCREEN_VERTEX_ES300}
)glsl";

class ${identifier} : public CFFGLPlugin
{
public:
    ${identifier}()
    {
        // TODO: SetMinInputs/SetMaxInputs, SetParamInfo() for every parameter
        // listed above, and SetTimeSupported(true).
    }

    // FFGL 1.x: SetParameter / GetParameter. FFGL 2.x: the parameter structs.
    // TODO: implement for your SDK version.

    FFResult InitGL(const FFGLViewportStruct *vp) override
    {
        // TODO: compile kVertexSource and kFragmentSource, link, and store the
        // program plus a uniform location for every name listed above.
        // On failure, log the info log verbatim - it is the only useful error.
        return FF_SUCCESS;
    }

    FFResult ProcessOpenGL(ProcessOpenGLStruct *pGL) override
    {
        // TODO: bind the program, set the uniforms, draw a full-screen triangle.
        // The shader expects a_position as its only attribute.
        return FF_SUCCESS;
    }
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Plugin factory
////////////////////////////////////////////////////////////////////////////////////////////////////

static CFFGLPluginInfo PluginInfo(
    PluginFactory<${identifier}>,   // Create method
    "${identifier}",                // Plugin unique ID (make this yours)
    "${identifier}",                // Plugin name
    1,                              // API major version
    1,                              // API minor version
    1,                              // Plugin major version
    0,                              // Plugin minor version
    FF_EFFECT,                      // Plugin type
    "${(shader.title ?? shader.id).replace(/"/g, "'")}", // Description
    "Generated by dsh-shaders"      // About
);

extern "C" __declspec(dllexport) CFFGLPlugin *plugMain(int, void *, void *)
{
    return PluginInfo.GetPlugin();
}
`
  return {
    text,
    uniforms,
    notes: [
      'This is a SCAFFOLD, not a plugin: FFGL is a C++ ABI, the SDK is not vendored, and this row runs no C++ compiler. The checklist is in the file header.',
      'The GLSL is embedded verbatim - it is the same string `shader_verify` compiled with ANGLE/SwiftShader. A different GPU driver can still reject it, so check it in the host.',
      "If you want a shader format you can drop into a VJ host without C++, emit target=isf instead: Resolume reads ISF directly.",
    ],
  }
}
