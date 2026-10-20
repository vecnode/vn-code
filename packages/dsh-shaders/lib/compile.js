/**
 * dsh-shaders — the compile, for real, in a disposable headless browser.
 *
 * One browser per call, in a throwaway profile, argv-only, with every name
 * resolved to NOTFOUND but loopback. It compiles each fragment, links it against
 * a full-screen triangle, reads back the ACTIVE uniforms the linker kept, and -
 * when asked - draws one frame and reads the pixels.
 *
 * Three facts this file exists to keep true, all of them measured on this host:
 *
 *   - the log is the compiler's own. A shader with a type error comes back
 *     "ERROR: 0:2: '=' : dimension mismatch", not a regex's guess.
 *   - `gl.getExtension('OES_standard_derivatives')` must be called BEFORE the
 *     source is handed over, or a shader using `fwidth` fails with "extension is
 *     not supported" even though the extension is present.
 *   - the active-uniform list is the only honest answer to "is this uniform
 *     used": the linker deletes the ones it can, so a declared-but-unused
 *     uniform has no location and setting it is a silent no-op.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { connectCdp } from './cdp.js'
import { buildArgs, contextFor, parseDevToolsActivePort, resolveEngine } from './engine.js'
import { FULLSCREEN_VERTEX_ES100, FULLSCREEN_VERTEX_ES300, WRAPPER_DIALECTS } from './verify.js'

/** How long the browser may take to answer its DevTools port. */
export const STARTUP_TIMEOUT_MS = 20000
/** How long one batch may take to compile, link and draw. */
export const COMPILE_TIMEOUT_MS = 120000
/** The largest frame this row will draw, per side. */
export const MAX_FRAME_SIDE = 2048

/** Kill one pid tree, by pid only - never by name. */
export function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err2) {
      /* already gone */
    }
  }
}

async function waitForDevTools(profileDir, child, budgetMs = STARTUP_TIMEOUT_MS) {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      const parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      if (parsed !== null) return parsed
    } catch (err) {
      // not written yet
    }
    if (child.exitCode !== null) {
      throw new Error('the browser exited (code ' + String(child.exitCode) + ') before it wrote a DevTools port')
    }
    if (Date.now() > deadline) throw new Error('no DevTools port appeared within ' + String(budgetMs) + ' ms')
    await new Promise((done) => setTimeout(done, 60))
  }
}

/**
 * The in-page half. Serialised and evaluated with `Runtime.evaluate`, so it
 * closes over nothing: the payload carries every job.
 */
function runJobsInPage(payload) {
  const out = { contexts: {}, results: [], error: null }
  const contexts = new Map()

  const makeContext = (kind, extensions) => {
    if (contexts.has(kind)) return contexts.get(kind)
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const attributes = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false }
    let gl = null
    try {
      gl = canvas.getContext(kind, attributes)
    } catch (err) {
      gl = null
    }
    if (gl === null) {
      contexts.set(kind, null)
      out.contexts[kind] = { available: false }
      return null
    }
    const enabled = []
    const supported = gl.getSupportedExtensions() ?? []
    for (const name of extensions ?? []) {
      try {
        if (gl.getExtension(name) !== null) enabled.push(name)
      } catch (err) {
        /* an extension name this driver does not know */
      }
    }
    out.contexts[kind] = {
      available: true,
      version: String(gl.getParameter(gl.VERSION)),
      shading: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      vendor: String(gl.getParameter(gl.VENDOR)),
      renderer: String(gl.getParameter(gl.RENDERER)),
      extensions: enabled,
      supportedCount: supported.length,
    }
    contexts.set(kind, { gl, canvas })
    return contexts.get(kind)
  }

  const typeName = (gl, type) => {
    for (const key of Object.keys(gl)) {
      if (typeof gl[key] === 'number' && gl[key] === type && /^(FLOAT|INT|BOOL|SAMPLER|UNSIGNED)/.test(key)) return key
    }
    return 'TYPE_' + String(type)
  }

  const compileShader = (gl, stage, source) => {
    const shader = gl.createShader(stage)
    if (shader === null) return { ok: false, log: 'createShader returned null', shader: null }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    const log = String(gl.getShaderInfoLog(shader) ?? '').trim()
    return { ok, log, shader }
  }

  /** FNV-1a over the pixel bytes: a deterministic fingerprint of one frame. */
  const signature = (bytes) => {
    let hash = 0x811c9dc5
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index]
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }

  for (const job of payload.jobs) {
    const result = { id: job.id, status: 'error', stage: job.stage, phase: null }
    try {
      const spec = job.context
      const holder = makeContext(spec, job.extensions)
      if (holder === null) {
        result.phase = 'context'
        result.error = 'no ' + spec + ' context available in this browser'
        out.results.push(result)
        continue
      }
      const { gl, canvas } = holder

      const vertexSpec = job.vertex
      const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSpec.source)
      if (!vertex.ok) {
        result.phase = 'vertex'
        result.log = vertex.log
        out.results.push(result)
        continue
      }
      const fragment = compileShader(gl, gl.FRAGMENT_SHADER, job.fragment)
      if (!fragment.ok) {
        result.phase = 'fragment'
        result.log = fragment.log
        gl.deleteShader(vertex.shader)
        out.results.push(result)
        continue
      }
      // The FRAGMENT compiled. That is a fact about the shader, and it stays true
      // even if the pair cannot link - which is what a multi-pass page's `v_uv`
      // pass does against a generic full-screen vertex shader. Recording the two
      // separately is the difference between "your shader is broken" and "your
      // shader needs its own vertex stage".
      result.compiled = true

      const program = gl.createProgram()
      gl.attachShader(program, vertex.shader)
      gl.attachShader(program, fragment.shader)
      gl.linkProgram(program)
      const linked = Boolean(gl.getProgramParameter(program, gl.LINK_STATUS))
      const linkLog = String(gl.getProgramInfoLog(program) ?? '').trim()
      gl.deleteShader(vertex.shader)
      gl.deleteShader(fragment.shader)
      if (!linked) {
        result.status = 'ok'
        result.rung = 'compiled'
        result.linked = false
        result.linkError = linkLog
        result.phase = 'link'
        out.results.push(result)
        continue
      }
      result.linked = true

      const uniforms = []
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) ?? 0
      for (let index = 0; index < count; index += 1) {
        const info = gl.getActiveUniform(program, index)
        if (info === null) continue
        uniforms.push({ name: String(info.name).replace(/\[0\]$/, ''), type: typeName(gl, info.type), size: info.size })
      }
      result.activeUniforms = uniforms

      if (job.render === null || job.render === undefined) {
        gl.deleteProgram(program)
        result.status = 'ok'
        result.rung = 'compiled'
        out.results.push(result)
        continue
      }

      // ---- one frame ----
      const width = Math.max(1, Math.min(Number(job.render.width) || 256, 2048))
      const height = Math.max(1, Math.min(Number(job.render.height) || 256, 2048))
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
      gl.useProgram(program)

      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const attribute = gl.getAttribLocation(program, 'a_position')
      if (attribute >= 0) {
        gl.enableVertexAttribArray(attribute)
        gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
      }

      const set = (name, value) => {
        const location = gl.getUniformLocation(program, name)
        if (location === null) return false
        if (typeof value === 'number') {
          // An int uniform must be set with uniform1i; a float with uniform1f.
          // Setting an int with uniform1f is a silent no-op on some drivers.
          const known = uniforms.find((entry) => entry.name === name)
          if (known !== undefined && (known.type === 'INT' || known.type === 'BOOL' || known.type.startsWith('SAMPLER'))) gl.uniform1i(location, Math.round(value))
          else gl.uniform1f(location, value)
          return true
        }
        if (Array.isArray(value)) {
          if (value.length === 2) gl.uniform2f(location, value[0], value[1])
          else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2])
          else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3])
          else return false
          return true
        }
        return false
      }

      const time = Number(job.render.time ?? 0)
      const frame = Number(job.render.frame ?? 0)
      const mouse = Array.isArray(job.render.mouse) ? job.render.mouse : [0, 0, 0, 0]
      const setNames = []
      const trySet = (name, value) => {
        if (set(name, value)) setNames.push(name)
      }
      trySet('u_time', time)
      trySet('u_resolution', [width, height])
      trySet('u_res', [width, height])
      trySet('u_mouse', [mouse[0] ?? 0, mouse[1] ?? 0])
      trySet('u_frame', frame)
      trySet('iResolution', [width, height, 1])
      trySet('iTime', time)
      trySet('iMouse', [mouse[0] ?? 0, mouse[1] ?? 0, mouse[2] ?? 0, mouse[3] ?? 0])
      trySet('iFrame', frame)
      for (const [name, value] of Object.entries(job.render.uniforms ?? {})) trySet(name, value)
      result.setUniforms = setNames

      const errorBefore = gl.getError()
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const drawError = gl.getError()
      result.glError = drawError === gl.NO_ERROR ? null : String(drawError) + (errorBefore !== gl.NO_ERROR ? ' (before draw: ' + String(errorBefore) + ')' : '')

      const pixels = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

      // Statistics a reader can act on: a black frame and a flat frame both
      // "draw" successfully, and both are useless.
      let sum = [0, 0, 0]
      let min = 255
      let max = 0
      const histogram = new Array(16).fill(0)
      const seen = new Set()
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index]
        const g = pixels[index + 1]
        const b = pixels[index + 2]
        sum[0] += r
        sum[1] += g
        sum[2] += b
        const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        if (luma < min) min = luma
        if (luma > max) max = luma
        histogram[Math.min(15, luma >> 4)] += 1
        if (seen.size < 4096) seen.add((r << 16) | (g << 8) | b)
      }
      const total = width * height
      result.frame = {
        width,
        height,
        mean: [sum[0] / total, sum[1] / total, sum[2] / total].map((value) => Math.round(value * 100) / 100),
        lumaMin: min,
        lumaMax: max,
        distinctColors: seen.size,
        flat: max - min === 0,
        black: max === 0,
        histogram,
        signature: signature(pixels),
        png: canvas.toDataURL('image/png'),
      }
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      result.status = 'ok'
      result.rung = 'drawn'
      out.results.push(result)
    } catch (err) {
      result.error = String((err && err.message) || err)
      out.results.push(result)
    }
  }
  return out
}

/**
 * Write one PNG (a data URL) to a path, refusing to create anything outside the
 * directory it is given.
 * @returns the byte count written.
 */
export async function writePngDataUrl(dataUrl, directory, name) {
  const base64 = String(dataUrl ?? '').replace(/^data:image\/png;base64,/, '')
  if (base64 === '') throw new Error('no PNG data in the frame')
  const bytes = Buffer.from(base64, 'base64')
  await fsp.mkdir(directory, { recursive: true })
  const file = path.join(directory, name)
  const relative = path.relative(directory, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('refusing to write outside the artifact directory: ' + name)
  await fsp.writeFile(file, bytes)
  return bytes.length
}

/**
 * Run a batch of jobs in one browser.
 *
 * @param options - `{ jobs, engine, env, timeoutMs }`, where each job is
 *   `{ id, fragment, vertex, context, extensions, render }` with the sources
 *   ALREADY assembled by `verify.assemble`.
 * @returns `{ ok, engine, contexts, results, timingMs, error? }`.
 */
export async function runJobs(options) {
  const jobs = Array.isArray(options.jobs) ? options.jobs : []
  if (jobs.length === 0) return { ok: false, code: 'NO_JOBS', message: 'nothing to compile', results: [] }
  const engine = options.engine ?? resolveEngine({ env: options.env })
  if (engine === null) {
    return {
      ok: false,
      code: 'NO_ENGINE',
      message:
        'No Chromium-family browser on this host, so GLSL cannot be compiled. Install Google Chrome, Chromium or Microsoft Edge (any platform), or point DSH_SHADERS_ENGINE at the executable. `shader_verify` still runs its static checks without one.',
      results: [],
    }
  }
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-shaders-'))
  const child = spawn(engine.file, buildArgs({ profileDir }), { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
  const started = Date.now()
  let client = null
  try {
    const { port, wsPath } = await waitForDevTools(profileDir, child)
    client = await connectCdp('ws://127.0.0.1:' + String(port) + wsPath, { timeoutMs: 10000 })
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Runtime.enable', {}, sessionId)
    const payload = { jobs }
    const evaluated = await client.send(
      'Runtime.evaluate',
      { expression: '(' + runJobsInPage.toString() + ')(' + JSON.stringify(payload) + ')', returnByValue: true, timeout: options.timeoutMs ?? COMPILE_TIMEOUT_MS },
      sessionId,
      options.timeoutMs ?? COMPILE_TIMEOUT_MS,
    )
    if (evaluated.exceptionDetails !== undefined) {
      const description = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text
      throw new Error('the in-page compile threw: ' + String(description).slice(0, 400))
    }
    const value = evaluated.result?.value
    if (value === null || value === undefined) throw new Error('the in-page compile returned nothing')
    return {
      ok: true,
      engine: { file: engine.file, kind: engine.kind, source: engine.source },
      contexts: value.contexts ?? {},
      results: value.results ?? [],
      timingMs: Date.now() - started,
    }
  } catch (err) {
    return { ok: false, code: 'COMPILE_FAILED', message: 'the compiler session failed: ' + String((err && err.message) || err), engine: { file: engine.file, kind: engine.kind, source: engine.source }, results: [], timingMs: Date.now() - started }
  } finally {
    // Ask the browser to exit over CDP first: on Windows the process spawned here
    // re-executes into the real browser and exits, so killing OUR pid misses it.
    if (client !== null) {
      try {
        await client.send('Browser.close', {}, undefined, 3000)
      } catch (err) {
        /* already gone */
      }
      client.close()
    }
    killTree(child.pid)
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The job a `verify` or `write` call needs for one assembled source.
 *
 * @param assembled - what `verify.assemble` returned.
 * @param stage - `fragment` or `vertex`.
 * @returns the job `runJobs` takes.
 */
export function jobFor(assembled, options = {}) {
  const dialect = assembled.dialect
  const spec = contextFor(dialect)
  const vertex = WRAPPER_DIALECTS.includes(dialect) ? FULLSCREEN_VERTEX_ES300 : dialect === 'es300' ? FULLSCREEN_VERTEX_ES300 : FULLSCREEN_VERTEX_ES100
  // The stage comes from the ASSEMBLED source unless the caller overrides it: a
  // vertex shader compiled as a fragment reports "'attribute' : supported in vertex
  // shaders only" and "No precision specified for (float)", which describes the
  // wrong stage rather than the shader. That is exactly the bug this line fixes.
  const stage = options.stage === 'vertex' || (options.stage === undefined && assembled.stage === 'vertex') ? 'vertex' : 'fragment'
  const job = {
    id: options.id ?? 'job',
    stage,
    context: spec.name,
    extensions: spec.extensions,
    vertex: { source: vertex },
    fragment: assembled.wrapped,
  }
  if (stage === 'vertex') {
    // A vertex shader is linked against a trivial fragment shader that writes one
    // colour, so the LINK is exercised too rather than only the compile.
    job.vertex = { source: assembled.wrapped }
    job.fragment = dialect === 'es300' ? '#version 300 es\nprecision highp float;\nout vec4 dshC;\nvoid main(){ dshC = vec4(1.0); }' : 'precision highp float;\nvoid main(){ gl_FragColor = vec4(1.0); }'
  }
  if (options.render !== undefined && options.render !== null) job.render = options.render
  return job
}
