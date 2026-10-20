/**
 * dsh-shaders — the seven tools.
 *
 * Every one of them answers with the same three things: what it did, what it
 * could PROVE (`rung`), and what the compiler actually said. The ladder is the
 * point, and it is always stated rather than implied:
 *
 *   v0-stored    accepted and stored; nothing has looked at it
 *   v1-static    the dialect rules and the structural lint ran (no compiler)
 *   v2-compiled  a real GLSL compiler in a headless browser compiled it, and the
 *                diagnostics are mapped back onto the author's line numbers
 *   v3-drawn     it linked AND a frame was drawn, with the pixels read back
 *   v4-measured  two frames at different times differ, and a signature is stable
 *                at the same time - so a still image cannot pass as an animation
 *
 * Nothing here upgrades a rung it did not reach. A machine with no browser
 * answers `v1-static` and names the browser that would get it to v2.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { jobFor, runJobs, writePngDataUrl } from './compile.js'
import { emit, TARGETS } from './emit.js'
import { getExample, listLinks, search, summary } from './kit.js'
import { MAX_SOURCE_BYTES, artifactDir, pruneArtifacts, verificationOf, writeArtifact } from './store.js'
import { assemble, detectDialect, lint, mapDiagnostics, parseParams, slugOf } from './verify.js'

/** The rungs, in order, for a report that names where it stopped. */
export const RUNGS = ['v0-stored', 'v1-static', 'v2-compiled', 'v3-drawn', 'v4-measured']

const FRAGMENT_SOURCE_SCHEMA = { type: 'string', description: 'GLSL source. The dialect is detected unless `dialect` says otherwise.' }

/** A short, stable summary of one verification, for a tool card. */
function rungText(rung) {
  if (rung === 'v4-measured') return 'v4-measured: it compiles, draws, and two frames differ as time advances'
  if (rung === 'v3-drawn') return 'v3-drawn: it compiles, links, and a frame was drawn with pixels read back'
  if (rung === 'v2-compiled') return 'v2-compiled: a real GLSL compiler accepted it (no frame was drawn)'
  if (rung === 'v1-static') return 'v1-static: only the static rules ran - no compiler was asked'
  return 'v0-stored: stored, nothing has checked it'
}

/** The human half of a diagnostic list. */
function diagnosticsText(diagnostics) {
  if (diagnostics.length === 0) return ''
  const lines = ['', 'diagnostics (line numbers are your source, not the assembled string):']
  for (const entry of diagnostics.slice(0, 12)) {
    const where = entry.where === 'include' ? ' [in ' + entry.include + ']' : ''
    lines.push('  line ' + String(entry.line) + where + ' — ' + entry.message)
  }
  if (diagnostics.length > 12) lines.push('  ... and ' + String(diagnostics.length - 12) + ' more')
  return lines.join('\n')
}

function warningsText(warnings) {
  if (warnings.length === 0) return ''
  const lines = ['', 'advisory (the compiler has the final word):']
  for (const entry of warnings.slice(0, 8)) lines.push('  line ' + String(entry.line) + ' — ' + entry.text)
  if (warnings.length > 8) lines.push('  ... and ' + String(warnings.length - 8) + ' more')
  return lines.join('\n')
}

function ownText(own) {
  if (own.length === 0) return ''
  return ['', 'this is a BUG IN THIS ROW, not in your shader (the diagnostic is inside the generated wrapper):', ...own.map((entry) => '  ' + entry.message)].join('\n')
}

/**
 * Run the ladder for one source.
 *
 * @param deps - the row's dependencies.
 * @param input - `{ source, dialect, stage, includes, params, render }`.
 * @returns the shared verification record every tool reports.
 */
export async function verifySource(deps, input) {
  const source = String(input.source ?? '')
  const detected = detectDialect(source)
  const dialect = input.dialect === undefined || input.dialect === null || input.dialect === '' ? detected.dialect : String(input.dialect)
  const stage = input.stage === 'vertex' ? 'vertex' : 'fragment'
  const includes = Array.isArray(input.includes) ? input.includes : []
  const params = Array.isArray(input.params) && input.params.length > 0 ? input.params : parseParams(source)

  const assembled = assemble({ source, dialect, stage, includes, params })
  const warnings = lint({ source, dialect, stage })

  if (!assembled.ok) {
    return {
      ok: false,
      rung: 'v1-static',
      dialect,
      detected: detected.dialect,
      stage,
      assembled: null,
      diagnostics: [],
      own: [],
      warnings,
      log: '',
      activeUniforms: [],
      message: assembled.error,
      params,
      includes,
    }
  }

  if (input.compile === false) {
    return { ok: true, rung: 'v1-static', dialect, detected: detected.dialect, stage, assembled, diagnostics: [], own: [], warnings, log: '', activeUniforms: [], params, includes }
  }

  const wantRender = input.render !== undefined && input.render !== null
  const report = await deps.compile({ jobs: [jobFor(assembled, { id: 'shader', render: input.render })] })
  if (!report.ok) {
    // No compiler is a rung, not a failure: the static answer still stands.
    return {
      ok: true,
      rung: 'v1-static',
      dialect,
      detected: detected.dialect,
      stage,
      assembled,
      diagnostics: [],
      own: [],
      warnings,
      log: '',
      activeUniforms: [],
      params,
      includes,
      message: report.message,
      noCompiler: report.code === 'NO_ENGINE',
    }
  }
  const result = report.results[0] ?? { status: 'error', error: 'the compiler returned no result' }
  const mapped = mapDiagnostics(result.log ?? '', assembled.mapLine)
  const ok = result.status === 'ok'
  let rung = ok ? (result.rung === 'drawn' ? 'v3-drawn' : 'v2-compiled') : 'v1-static'
  if (ok && result.rung === 'drawn' && input.render?.secondTime !== undefined) rung = 'v4-measured'
  return {
    ok,
    rung,
    dialect,
    detected: detected.dialect,
    stage,
    assembled,
    diagnostics: mapped.diagnostics,
    own: mapped.own,
    warnings,
    log: String(result.log ?? ''),
    phase: result.phase ?? null,
    activeUniforms: result.activeUniforms ?? [],
    frame: result.frame ?? null,
    setUniforms: result.setUniforms ?? [],
    glError: result.glError ?? null,
    linked: result.linked !== false,
    linkError: result.linkError ?? null,
    engine: report.engine ?? null,
    contexts: report.contexts ?? {},
    params,
    includes,
    message: ok ? null : result.error ?? null,
  }
}

/** The sentence a verification starts with. */
function verificationText(title, verification) {
  const lines = []
  lines.push(title + ' — ' + (verification.ok ? 'ok' : 'FAILED') + ' at ' + verification.rung + ' (' + verification.dialect + (verification.detected !== verification.dialect ? ', detected ' + verification.detected : '') + ')')
  lines.push(rungText(verification.rung))
  if (verification.engine !== null && verification.engine !== undefined) {
    const renderer = verification.contexts?.webgl2?.renderer ?? verification.contexts?.webgl?.renderer ?? 'unknown renderer'
    lines.push('compiler: ' + verification.engine.file + ' — ' + renderer)
  }
  if (verification.message !== null && verification.message !== undefined) lines.push(verification.message)
  if (verification.linkError !== null && verification.linkError !== undefined) {
    lines.push(
      '',
      'it COMPILED, but it does not LINK against the full-screen vertex shader: ' + verification.linkError,
      'that is a statement about the PAIR, not about your fragment: a shader that declares its own varying (a `v_uv` or similar) needs the vertex stage that writes it. Emit target=frag to get a matching .vert, or verify the pair yourself.',
    )
  }
  if ((verification.activeUniforms ?? []).length > 0) {
    lines.push('active uniforms after link: ' + verification.activeUniforms.map((entry) => entry.name + ' (' + entry.type + ')').join(', '))
  }
  return lines.join('\n') + diagnosticsText(verification.diagnostics ?? []) + ownText(verification.own ?? []) + warningsText(verification.warnings ?? [])
}

/** The address a shader's tab answers to. */
export function addressOf(sessionId, id, scope = 'session') {
  return 'dsh-resource://shader/' + (scope === 'library' ? 'library' : 'session/' + String(sessionId ?? '')) + '/' + id
}

/** The view every write/verify answer shares, so a card can render one shape. */
function verificationView(verification, extra = {}) {
  return {
    status: verification.ok ? 'ok' : 'error',
    rung: verification.rung,
    dialect: verification.dialect,
    detected: verification.detected,
    stage: verification.stage,
    diagnostics: (verification.diagnostics ?? []).map((entry) => ({ line: entry.line, where: entry.where, message: entry.message, ...(entry.include === undefined ? {} : { include: entry.include }) })),
    own: verification.own ?? [],
    warnings: verification.warnings ?? [],
    activeUniforms: verification.activeUniforms ?? [],
    params: (verification.params ?? []).filter((entry) => entry.name !== null && entry.name !== undefined).map((entry) => ({ name: entry.name, uniform: entry.uniform, type: entry.type, min: entry.min, max: entry.max, default: entry.default, description: entry.description })),
    ...extra,
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    view: { type: 'object' },
    text: { type: 'string' },
  },
  required: ['view', 'text'],
}

/** Wrap a result the registry will accept: a view, and the text for the model. */
function answer(view, text) {
  return { view, text }
}

/**
 * Build the seven tools.
 *
 * @param deps - `{ storeFor, library, compile, env, now, artifactDir, kit }`, all
 *   injectable so the package check can drive every branch without a browser.
 */
export function buildTools(deps) {
  const storeFor = deps.storeFor
  const tools = []

  // ------------------------------------------------------------- shader_write
  tools.push({
    name: 'shader_write',
    description:
      'Create or replace a shader in this conversation and VERIFY it immediately. Detects the GLSL dialect (es100, es300, shadertoy, shader-skills, module, desktop), compiles it for real when a browser is available, and reports diagnostics on your own line numbers. Returns the rung it reached, the active uniforms the linker kept, the parameters it found, and a tab address.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id (lower-case, dashes). Defaults to one made from the title.' },
        title: { type: 'string', description: 'A human title for the tab.' },
        kind: { type: 'string', enum: ['fragment', 'vertex'], description: 'Shader stage. Default fragment.' },
        dialect: { type: 'string', enum: ['es100', 'es300', 'shadertoy', 'shader-skills', 'module', 'desktop'], description: 'Force a dialect instead of detecting it.' },
        source: FRAGMENT_SOURCE_SCHEMA,
        includes: {
          type: 'array',
          description: 'Modules to prepend, in dependency order (a module library such as shader_kit id=module/noise).',
          items: { type: 'object', properties: { name: { type: 'string' }, source: { type: 'string' } }, required: ['name', 'source'] },
        },
        verify: { type: 'boolean', description: 'Compile before storing. Default true.' },
        remove: { type: 'boolean', description: 'Delete this id instead of writing it.' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => (view.status === 'ok' ? 'shader ' + view.id + ' · ' + view.rung : 'shader ' + view.id + ' · ' + view.status + ' · ' + view.diagnostics.length + ' diagnostic(s)') },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      if (args.remove === true) {
        const id = String(args.id ?? '')
        if (id === '') throw Object.assign(new Error('shader_write { remove: true } needs an id'), { code: 'BAD_REQUEST' })
        const result = storeFor('session').remove(sessionId, id)
        const view = { status: result.removed ? 'removed' : 'missing', id }
        return answer(view, result.removed ? 'removed shader ' + id : 'no shader called ' + id + ' in this conversation')
      }
      const source = String(args.source ?? '')
      if (source.trim() === '') throw Object.assign(new Error('shader_write needs a source'), { code: 'BAD_REQUEST' })
      const title = String(args.title ?? args.id ?? 'Shader')
      const id = String(args.id ?? slugOf(title))
      const includes = Array.isArray(args.includes) ? args.includes : []
      const verification = await verifySource(deps, {
        source,
        dialect: args.dialect,
        stage: args.kind,
        includes,
        compile: args.verify !== false,
      })
      // A shader that does not compile is still stored: the author asked to keep
      // it, and `shader_read` reports the failure beside it. Refusing to store
      // would throw away the source the model is trying to fix.
      const entry = storeFor('session').write(sessionId, {
        id,
        title,
        kind: args.kind === 'vertex' ? 'vertex' : 'fragment',
        dialect: verification.dialect,
        source,
        includes,
        params: verification.params,
        by: 'model',
      })
      const address = addressOf(sessionId, entry.id)
      const view = verificationView(verification, {
        id: entry.id,
        title: entry.title,
        revision: entry.revision,
        address,
        bytes: entry.bytes,
        verification: verificationOf(entry),
      })
      return answer(view, verificationText('shader ' + entry.id + ' (revision ' + String(entry.revision) + ')', verification) + '\n\ntab: ' + address)
    },
  })

  // ------------------------------------------------------------ shader_verify
  tools.push({
    name: 'shader_verify',
    description:
      'Check a shader WITHOUT storing it (or re-check a stored one by id). Returns the rung reached, the compiler\'s own log, diagnostics mapped to your line numbers, the active uniforms the linker kept, and advisory lint. A machine with no browser reports v1-static and names the browser that would reach v2.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A stored shader id to re-check.' },
        source: FRAGMENT_SOURCE_SCHEMA,
        dialect: { type: 'string', enum: ['es100', 'es300', 'shadertoy', 'shader-skills', 'module', 'desktop'] },
        stage: { type: 'string', enum: ['fragment', 'vertex'] },
        includes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, source: { type: 'string' } }, required: ['name', 'source'] } },
        compile: { type: 'boolean', description: 'Default true. false gives the static answer only, without starting a browser.' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'verify · ' + view.rung + ' · ' + (view.status === 'ok' ? 'ok' : view.diagnostics.length + ' diagnostic(s)') },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      let source = String(args.source ?? '')
      let dialect = args.dialect
      let includes = Array.isArray(args.includes) ? args.includes : []
      let title = 'source'
      if (source.trim() === '') {
        const id = String(args.id ?? '')
        if (id === '') throw Object.assign(new Error('shader_verify needs a source or an id'), { code: 'BAD_REQUEST' })
        const entry = storeFor('session').get(sessionId, id)
        if (entry === null) throw Object.assign(new Error('no shader called ' + id + ' in this conversation'), { code: 'NOT_FOUND' })
        source = entry.source
        dialect = dialect ?? entry.dialect
        includes = includes.length > 0 ? includes : entry.includes ?? []
        title = 'shader ' + entry.id
      }
      const verification = await verifySource(deps, { source, dialect, stage: args.stage, includes, compile: args.compile !== false })
      const view = verificationView(verification, { log: verification.log })
      return answer(view, verificationText(title, verification))
    },
  })

  // ------------------------------------------------------------ shader_render
  tools.push({
    name: 'shader_render',
    description:
      'Draw one frame (or a contact sheet of several times) and read the pixels back. Reports the PNG size, brightness/colour statistics, whether the frame is flat or black, and a deterministic signature - so "it compiles" is never confused with "it draws something". Two different times that draw identically are reported too.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A stored shader id.' },
        source: FRAGMENT_SOURCE_SCHEMA,
        dialect: { type: 'string', enum: ['es100', 'es300', 'shadertoy', 'shader-skills', 'module', 'desktop'] },
        includes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, source: { type: 'string' } }, required: ['name', 'source'] } },
        time: { type: 'number', description: 'Seconds. Default 0.' },
        width: { type: 'number', description: 'Pixels. Default 256, at most 2048.' },
        height: { type: 'number', description: 'Pixels. Default 256, at most 2048.' },
        uniforms: { type: 'object', description: 'Extra uniforms by name, e.g. { "u_speed": 0.8 }.' },
        frames: { type: 'number', description: 'Draw this many frames evenly across 0..8s and report each signature.' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'render · ' + (view.status === 'ok' ? view.frame.width + '×' + view.frame.height + ' · ' + view.frame.distinctColors + ' colours' : 'failed') },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      let source = String(args.source ?? '')
      let dialect = args.dialect
      let includes = Array.isArray(args.includes) ? args.includes : []
      let title = 'source'
      if (source.trim() === '') {
        const id = String(args.id ?? '')
        if (id === '') throw Object.assign(new Error('shader_render needs a source or an id'), { code: 'BAD_REQUEST' })
        const entry = storeFor('session').get(sessionId, id)
        if (entry === null) throw Object.assign(new Error('no shader called ' + id + ' in this conversation'), { code: 'NOT_FOUND' })
        source = entry.source
        dialect = dialect ?? entry.dialect
        includes = includes.length > 0 ? includes : entry.includes ?? []
        title = 'shader ' + entry.id
      }
      if (detectDialect(source).dialect === 'desktop' && (dialect === undefined || dialect === null)) {
        throw Object.assign(
          new Error('a desktop GLSL source cannot be drawn here: ANGLE compiles GLSL ES only. Use shader_target target=frag for a desktop host.'),
          { code: 'NOT_SUPPORTED' },
        )
      }
      const width = Math.max(1, Math.min(2048, Number(args.width) || 256))
      const height = Math.max(1, Math.min(2048, Number(args.height) || 256))
      const frames = Number.isFinite(Number(args.frames)) ? Math.max(1, Math.min(8, Math.round(Number(args.frames)))) : 1
      const times = frames === 1 ? [Number(args.time) || 0] : Array.from({ length: frames }, (_, index) => (index / frames) * 8)

      // A `@param` default has to be SET, not declared: measured, a shader whose
      // animation is driven by `u_speed` renders identical frames at every time
      // when the uniform is left at zero, and the report used to call that
      // "static" - blaming the shader for this row's omission.
      const uniforms = {}
      for (const param of parseParams(source)) {
        if (param.name === null || param.default === null || param.default === undefined) continue
        uniforms[param.uniform] = param.default
      }
      for (const [name_, value] of Object.entries(args.uniforms ?? {})) uniforms[name_] = value

      const rendered = []
      for (const time of times) {
        const verification = await verifySource(deps, {
          source,
          dialect,
          includes,
          render: { time, width, height, uniforms },
        })
        rendered.push({ time, verification })
        if (!verification.ok) break
      }
      const first = rendered[0]
      if (first === undefined || !first.verification.ok || first.verification.frame === null) {
        const failed = first?.verification ?? { diagnostics: [], warnings: [], rung: 'v1-static', dialect: 'unknown', detected: 'unknown', stage: 'fragment', activeUniforms: [], params: [], includes: [] }
        const view = verificationView(failed, { status: 'error', title })
        return answer(view, verificationText(title, failed))
      }

      const signatures = rendered.map((entry) => ({ time: entry.time, signature: entry.verification.frame.signature }))
      const distinct = new Set(signatures.map((entry) => entry.signature))
      const framesOut = []
      const pruned = []
      for (const entry of rendered) {
        const bytes = Buffer.from(String(entry.verification.frame.png ?? '').replace(/^data:image\/png;base64,/, ''), 'base64')
        if (bytes.length === 0) continue
        const written = await writeArtifact(deps.artifactDir, bytes)
        framesOut.push({ time: entry.time, name: written.name, signature: entry.verification.frame.signature, width: entry.verification.frame.width, height: entry.verification.frame.height })
      }
      pruned.push(pruneArtifacts(deps.artifactDir))
      const frame = first.verification.frame
      const view = verificationView(first.verification, {
        id: args.id ?? null,
        title,
        status: 'ok',
        rung: distinct.size > 1 ? 'v4-measured' : 'v3-drawn',
        frame: {
          width: frame.width,
          height: frame.height,
          mean: frame.mean,
          lumaMin: frame.lumaMin,
          lumaMax: frame.lumaMax,
          distinctColors: frame.distinctColors,
          flat: frame.flat,
          black: frame.black,
          signature: frame.signature,
        },
        frames: framesOut,
        signatures,
        animated: distinct.size > 1,
        artifact: framesOut[0]?.name ?? null,
      })
      const lines = [verificationText(title, first.verification)]
      lines.push('')
      lines.push('frame: ' + String(frame.width) + '×' + String(frame.height) + ' · mean rgb ' + frame.mean.join('/') + ' · luma ' + String(frame.lumaMin) + '..' + String(frame.lumaMax) + ' · ' + String(frame.distinctColors) + ' distinct colour(s) · signature ' + frame.signature)
      if (frame.black) lines.push('THIS FRAME IS BLACK. It compiled and drew, and produced nothing. Check that the shader writes a colour, that its uniforms are actually read, and that the camera is not looking away from the surface.')
      else if (frame.flat) lines.push('THIS FRAME IS A SINGLE COLOUR. It drew, but nothing varies across it - which is what a broken uv or a clamp-to-zero looks like.')
      if (signatures.length > 1) {
        lines.push(distinct.size > 1 ? 'animation: ' + String(distinct.size) + ' distinct frame(s) of ' + String(signatures.length) + ' - it moves.' : 'animation: all ' + String(signatures.length) + ' frames are IDENTICAL. Either it is static, or it ignores u_time / iTime.')
      }
      lines.push('this proves a frame was drawn; it does not prove the picture is good. Look at the artifact.')
      return answer(view, lines.join('\n'))
    },
  })

  // -------------------------------------------------------------- shader_read
  tools.push({
    name: 'shader_read',
    description: 'Read one stored shader (with its verification state and the browser\'s own verdict) or list this conversation\'s shaders.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Omit to list.' },
        includeSource: { type: 'boolean', description: 'Include the source text. Default true when an id is given.' },
        scope: { type: 'string', enum: ['session', 'library'], description: 'Read this conversation (default) or the shared library.' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'read · ' + (view.shaders?.length ?? 1) + ' shader(s)' },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      const scope = args.scope === 'library' ? 'library' : 'session'
      const store = storeFor(scope)
      const key = scope === 'library' ? 'library' : sessionId
      if (args.id === undefined || args.id === null || String(args.id) === '') {
        const list = store.list(key)
        const view = {
          scope,
          total: list.length,
          shaders: list.map((entry) => ({
            id: entry.id,
            title: entry.title,
            dialect: entry.dialect,
            revision: entry.revision,
            bytes: entry.bytes,
            verification: verificationOf(entry),
            address: addressOf(sessionId, entry.id, scope),
          })),
        }
        const lines = [String(list.length) + ' shader(s) in ' + (scope === 'library' ? 'the shared library' : 'this conversation') + '.']
        for (const entry of view.shaders) lines.push('  ' + entry.id + ' — ' + entry.title + ' · ' + entry.dialect + ' · r' + String(entry.revision) + ' · ' + entry.verification.state)
        return answer(view, lines.join('\n'))
      }
      const entry = store.get(key, String(args.id))
      if (entry === null) throw Object.assign(new Error('no shader called ' + String(args.id) + ' in ' + scope), { code: 'NOT_FOUND' })
      const includeSource = args.includeSource !== false
      const verification = verificationOf(entry)
      const view = {
        id: entry.id,
        title: entry.title,
        dialect: entry.dialect,
        kind: entry.kind,
        revision: entry.revision,
        bytes: entry.bytes,
        params: entry.params,
        verification,
        address: addressOf(sessionId, entry.id, scope),
        ...(includeSource ? { source: entry.source } : {}),
        includes: (entry.includes ?? []).map((include) => ({ name: include.name, bytes: Buffer.byteLength(include.source) })),
      }
      const lines = [entry.title + ' (' + entry.id + ') — ' + entry.dialect + ' ' + entry.kind + ' · revision ' + String(entry.revision) + ' · ' + String(entry.bytes) + ' bytes']
      lines.push('Browser: ' + verification.state + (verification.state === 'stale' ? ' (the newest report is about revision ' + String(verification.reported) + ')' : ''))
      if (includeSource) {
        lines.push('', entry.source)
      }
      return answer(view, lines.join('\n'))
    },
  })

  // ----------------------------------------------------------- shader_publish
  tools.push({
    name: 'shader_publish',
    description: 'Copy a stored shader into the shared library, where every conversation can read it by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'publish · ' + view.id },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      const id = String(args.id ?? '')
      const entry = storeFor('session').get(sessionId, id)
      if (entry === null) throw Object.assign(new Error('no shader called ' + id + ' in this conversation'), { code: 'NOT_FOUND' })
      const published = storeFor('library').write('library', {
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        dialect: entry.dialect,
        source: entry.source,
        includes: entry.includes ?? [],
        params: entry.params ?? [],
        by: entry.by,
      })
      const address = addressOf(sessionId, published.id, 'library')
      return answer({ status: 'published', id: published.id, revision: published.revision, address, note: args.note ?? null }, 'published ' + published.id + ' to the shared library as ' + address)
    },
  })

  // ------------------------------------------------------------ shader_target
  tools.push({
    name: 'shader_target',
    description:
      'Emit a stored (or given) shader for a destination: a standalone web page, a .frag (+.vert), an ISF shader with its JSON, a FreeFrameGL C++ scaffold, or Shadertoy names. Writes into the workspace when `out` is given, and never overwrites a file unless `overwrite` is true.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A stored shader id.' },
        source: FRAGMENT_SOURCE_SCHEMA,
        dialect: { type: 'string', enum: ['es100', 'es300', 'shadertoy', 'shader-skills', 'module', 'desktop'] },
        target: { type: 'string', enum: TARGETS, description: 'Where it is going.' },
        name: { type: 'string', description: 'File name stem. Defaults to the shader title.' },
        out: { type: 'string', description: 'Folder inside the session workspace to write into. Omit to get the text back without writing.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing file. Default false.' },
      },
      required: ['target'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'target · ' + view.target + ' · ' + view.files.length + ' file(s)' },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? 'anonymous'
      let shader
      if (args.id !== undefined && args.id !== null && String(args.id) !== '') {
        const entry = storeFor('session').get(sessionId, String(args.id))
        if (entry === null) throw Object.assign(new Error('no shader called ' + String(args.id) + ' in this conversation'), { code: 'NOT_FOUND' })
        shader = { ...entry, dialect: args.dialect ?? entry.dialect }
      } else {
        const source = String(args.source ?? '')
        if (source.trim() === '') throw Object.assign(new Error('shader_target needs a source or an id'), { code: 'BAD_REQUEST' })
        shader = { id: 'source', title: args.name ?? 'Shader', kind: 'fragment', dialect: args.dialect, source, includes: [], params: parseParams(source) }
      }
      const result = emit({ shader, target: args.target, name: args.name })
      if (result.ok !== true) {
        return answer({ status: 'refused', target: args.target, refused: result.refused, files: [], notes: result.notes ?? [] }, 'refused: ' + result.refused)
      }
      const written = []
      if (args.out !== undefined && args.out !== null && String(args.out) !== '') {
        const workspace = deps.workspaceOf?.(sessionId) ?? null
        if (workspace === null) throw Object.assign(new Error('this conversation has no workspace to write into'), { code: 'NO_WORKSPACE' })
        const folder = String(args.out)
        if (folder.startsWith('/') || /^[A-Za-z]:/.test(folder) || folder.split(/[\\/]/).includes('..')) {
          throw Object.assign(new Error('`out` must be a relative folder inside the workspace, without "..": ' + folder), { code: 'BAD_REQUEST' })
        }
        const target = path.resolve(workspace, folder)
        const within = path.relative(workspace, target)
        if (within.startsWith('..') || path.isAbsolute(within)) throw Object.assign(new Error('that path is outside the workspace'), { code: 'BAD_REQUEST' })
        await fsp.mkdir(target, { recursive: true })
        const realTarget = await fsp.realpath(target)
        for (const file of result.files) {
          // Containment is checked on the REAL folder, and the path reported back is
          // the LOGICAL one: on Windows a temp folder's realpath can carry a different
          // 8.3 spelling, and `path.relative(workspace, realpath)` then reports
          // `../../..` for a file that is inside the workspace.
          const resolved = path.resolve(realTarget, file.name)
          if (path.relative(realTarget, resolved).startsWith('..')) throw Object.assign(new Error('refusing to write outside the folder: ' + file.name), { code: 'BAD_REQUEST' })
          // Create-exclusive, as SECURITY.md requires: `wx` fails on an existing
          // file atomically, where `existsSync` + write is a race two callers lose.
          try {
            await fsp.writeFile(resolved, file.text, { encoding: 'utf8', flag: args.overwrite === true ? 'w' : 'wx' })
          } catch (err) {
            if (err && err.code === 'EEXIST') {
              throw Object.assign(new Error(file.name + ' already exists; pass overwrite: true to replace it'), { code: 'EXISTS' })
            }
            throw err
          }
          written.push(path.relative(workspace, path.join(target, file.name)).split(path.sep).join('/'))
        }
      }
      const view = {
        status: 'ok',
        target: result.target,
        files: result.files.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.text), text: written.length === 0 ? file.text : undefined })).map((file) => (file.text === undefined ? { name: file.name, bytes: file.bytes } : file)),
        written,
        notes: result.notes,
      }
      const lines = ['emitted ' + result.target + ': ' + result.files.map((file) => file.name).join(', ')]
      if (written.length > 0) lines.push('written into the workspace: ' + written.join(', '))
      for (const note of result.notes) lines.push('  · ' + note)
      if (written.length === 0) {
        lines.push('')
        for (const file of result.files) {
          lines.push('--- ' + file.name + ' ---')
          lines.push(file.text)
        }
      }
      return answer(view, lines.join('\n'))
    },
  })

  // --------------------------------------------------------------- shader_kit
  tools.push({
    name: 'shader_kit',
    description:
      'Browse the vendored shader corpus: 106 Radiant pages with their extracted fragments, 11 finished shader-skills pieces, 20 reusable GLSL modules, 11 templates and 14 written references, plus a curated index of 48 GLSL links. Use it to start from a known-good technique instead of inventing one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['catalog', 'example', 'search', 'links'], description: 'Default catalog.' },
        id: { type: 'string', description: 'For action=example: radiant/<id>, gallery/<id>, module/<id>, template/<id>.' },
        query: { type: 'string', description: 'For search/links: words to match.' },
        technique: { type: 'string', description: 'For search: webgl1, webgl2, hybrid, canvas2d, gallery, template, module.' },
        category: { type: 'string', description: 'For links: Tutorials, Sites, Editors, Articles, Tools, People, Related Lists.' },
        limit: { type: 'number' },
        includeSource: { type: 'boolean', description: 'For example: include the source text. Default true.' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: (view) => 'kit · ' + (view.action ?? 'catalog') },
    async execute(args) {
      const action = args.action ?? 'catalog'
      if (action === 'catalog') {
        const view = { action, ...deps.kit.summary() }
        const lines = []
        if (view.radiant !== null) {
          lines.push('radiant (' + view.radiant.repo + '@' + String(view.radiant.commit).slice(0, 8) + ', ' + view.radiant.license + '): ' + String(view.radiant.pages) + ' pages, ' + String(view.radiant.pagesWithSource) + ' with an extractable fragment (' + String(view.radiant.sources) + ' sources)')
          lines.push('  techniques: ' + Object.entries(view.radiant.byTechnique).map(([name, count]) => name + ' ' + String(count)).join(', '))
        }
        if (view.skills !== null) {
          lines.push('shader-skills (' + view.skills.repo + '@' + String(view.skills.commit).slice(0, 8) + ', ' + view.skills.license + '): ' + String(view.skills.modules) + ' modules, ' + String(view.skills.templates) + ' templates, ' + String(view.skills.gallery) + ' gallery pieces, ' + String(view.skills.references) + ' references')
          lines.push('  dialect: ' + view.skills.dialect)
        }
        if (view.links !== null) lines.push('glsl-links (' + view.links.repo + ', ' + view.links.license + '): ' + String(view.links.links) + ' links in ' + String(view.links.categories.length) + ' categories')
        lines.push('', 'actions: catalog | example id=<kind>/<id> | search query=... | links [category=...]')
        return answer(view, lines.join('\n'))
      }
      if (action === 'search') {
        const result = search({ query: args.query, technique: args.technique, limit: args.limit })
        const view = { action, ...result }
        return answer(view, String(result.total) + ' match(es)' + (result.entries.length < result.total ? ', showing ' + String(result.entries.length) : '') + '\n' + result.entries.map((entry) => '  ' + entry.id + ' — ' + entry.title + ' · ' + entry.technique).join('\n'))
      }
      if (action === 'links') {
        const result = listLinks({ query: args.query, category: args.category })
        const view = { action, ...result }
        if (result.available !== true) return answer(view, result.message)
        return answer(view, String(result.total) + ' link(s) in ' + result.categories.join(', ') + '\n' + result.links.map((entry) => '  [' + entry.category + '] ' + entry.title + ' — ' + entry.url + (entry.description === '' ? '' : '\n      ' + entry.description)).join('\n'))
      }
      if (action === 'example') {
        const result = getExample(args.id)
        if (result.found !== true) return answer({ action, status: 'missing', ...result }, result.message + '\n' + (result.ids ?? []).slice(0, 20).join(', '))
        const includeSource = args.includeSource !== false
        if (result.kind === 'reference') {
          const view = { action, status: 'ok', kind: 'reference', id: result.id, title: result.title, source: result.source, bytes: result.bytes, ...(includeSource ? { text: result.sourceText } : {}) }
          const lines = [result.id + ' — ' + result.title, 'a written reference from the shader-skills corpus (' + String(result.bytes) + ' bytes). Read it for technique; it is prose, not a shader, so it has no dialect and nothing to compile.']
          if (includeSource) lines.push('', result.sourceText)
          return answer(view, lines.join('\n'))
        }
        const view = {
          action,
          status: 'ok',
          id: result.id,
          title: result.title,
          source: result.source,
          kind: result.kind ?? null,
          dialect: result.dialect,
          technique: result.technique ?? null,
          page: result.page ?? null,
          requires: result.requires ?? [],
          provenBy: result.provenBy ?? null,
          params: result.params ?? [],
          bytes: result.sourceText === null ? 0 : Buffer.byteLength(result.sourceText),
          ...(includeSource && result.sourceText !== null ? { text: result.sourceText } : {}),
        }
        const lines = [result.id + ' — ' + result.title, 'dialect ' + result.dialect + (result.technique === null || result.technique === undefined ? '' : ' · ' + result.technique) + (result.page === null || result.page === undefined ? '' : ' · page ' + result.page)]
        if (result.note !== null && result.note !== undefined) lines.push(result.note)
        if ((result.requires ?? []).length > 0) lines.push('reads as needing: ' + result.requires.join(', '))
        if (result.provenBy !== null && result.provenBy !== undefined) lines.push('proven by: ' + result.provenBy + (result.bodyInGallery === false ? ' (its body is NOT byte-identical in that piece, so treat this template as a variant)' : ''))
        if (includeSource && result.sourceText !== null) lines.push('', result.sourceText)
        return answer(view, lines.join('\n'))
      }
      throw Object.assign(new Error('unknown shader_kit action ' + JSON.stringify(action) + '; use catalog, example, search or links'), { code: 'BAD_REQUEST' })
    },
  })

  return tools
}

/** The digest this row records for a source, so a stored shader can be compared. */
export function sourceDigest(source) {
  return createHash('sha256').update(String(source)).digest('hex')
}

/** `MAX_SOURCE_BYTES` is re-exported for the tool schema's help text. */
export const SOURCE_CEILING = MAX_SOURCE_BYTES
