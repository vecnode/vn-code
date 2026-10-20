/**
 * dsh-shaders — the source in, the compiler's words out, on the author's own line
 * numbers.
 *
 * A GLSL compiler reports `ERROR: 0:12: 'x' : message`. That `12` counts the
 * lines of the string it was HANDED. This module hands it a string this package
 * assembled - a `#version`, a precision statement, the Shadertoy uniforms, the
 * included modules, an entry point - and then has to answer a different
 * question: which line of the AUTHOR'S file was that? So assembly records a
 * segment table (`header`, `include:<name>`, `source`, `footer`) and every
 * diagnostic is traced back through it. An error inside an included module names
 * the module; an error inside the header is reported as this row's own bug, not
 * the author's.
 *
 * Dialects are kept apart on purpose, because they are not interchangeable and a
 * plugin that blurred them would be lying about what it proved:
 *
 *   es100      a complete WebGL1 fragment (`gl_FragColor`, no `#version`).
 *              Compiles as written.
 *   es300      a complete WebGL 2 fragment (`#version 300 es`, its own `out`).
 *              Compiles as written.
 *   shadertoy  `mainImage(out vec4, in vec2)` and no `#version`. Wrapped in an
 *              ES 3.00 entry point and the uniforms Shadertoy.com defines, where
 *              `iFrame` is a FLOAT.
 *   shader-skills
 *              the same `mainImage` shape, but for the harness the
 *              gokayfem/shader-skills corpus targets, where `iFrame` is an INT
 *              (`uniform1i`, and its own `ditherTPDF(vec2, int)` takes it as
 *              one). A shader written for one of these does not compile under
 *              the other, so they are two dialects and not one with a flag.
 *   module     a library with no entry point (a function collection). Wrapped in
 *              a header and an empty `main()` so its declarations are compiled.
 *   desktop    `#version 110..460` without `es`. NOT compiled here: ANGLE does
 *              not accept desktop GLSL. Reported as a static check only, with
 *              the tool named that would compile it.
 */

/** Every dialect this row can reason about, in the order a report lists them. */
export const DIALECTS = ['es100', 'es300', 'shadertoy', 'shader-skills', 'module', 'desktop']

/** The dialects whose source is wrapped in a generated entry point. */
export const WRAPPER_DIALECTS = ['shadertoy', 'shader-skills', 'module']

/** Shadertoy's own uniform names, with `iFrame` a float - as shadertoy.com has it. */
export const SHADERTOY_UNIFORMS = ['iResolution', 'iTime', 'iTimeDelta', 'iFrameRate', 'iFrame', 'iMouse', 'iChannel0']

/**
 * The shader-skills harness's uniform names, with `iFrame` an INT.
 *
 * Taken from that corpus's own `tests/harness_template.html` (which sets it with
 * `uniform1i`) and `scripts/glsl_tools.py` (`uniform int iFrame;`), not inferred:
 * its gallery shaders call `ditherTPDF(vec2, int)` with `iFrame`, and under a
 * float `iFrame` they fail with "no matching overloaded function found".
 */
export const SHADER_SKILLS_UNIFORMS = ['iResolution', 'iTime', 'iTimeDelta', 'iFrameRate', 'iFrame', 'iMouse', 'iChannel0']

/** Param types a `@param` line may declare, and how a slider should read them. */
export const PARAM_TYPES = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'color']

const VERSION_LINE = /^\s*#\s*version\s+(\d+)\s*(es)?\b/m

/**
 * Which GLSL dialect a source is written in, and the evidence for saying so.
 *
 * @returns `{ dialect, version, reason }` - `version` is the number in a
 *   `#version` directive, or `null`.
 */
export function detectDialect(source) {
  const text = String(source)
  const version = VERSION_LINE.exec(text)
  if (version !== null) {
    const number = Number(version[1])
    const isEs = version[2] === 'es'
    // `#version 100` IS GLSL ES 1.00. There is no desktop GLSL 100: the desktop
    // line starts at 110. Treating `#version 100` as desktop - which this did -
    // refused every ES 1.00 shader that spelled its version out.
    if (isEs || number === 100) {
      return { dialect: number >= 300 ? 'es300' : 'es100', version: number, reason: '#version ' + String(number) + (isEs ? ' es' : ' (GLSL ES 1.00)') }
    }
    return { dialect: 'desktop', version: number, reason: '#version ' + String(number) + ' without es is desktop GLSL' }
  }
  if (/void\s+mainImage\s*\(/.test(text)) {
    return { dialect: 'shadertoy', version: null, reason: 'declares mainImage() and carries no #version' }
  }
  if (/void\s+main\s*\(/.test(text)) {
    return { dialect: 'es100', version: null, reason: 'declares main() and carries no #version' }
  }
  return { dialect: 'module', version: null, reason: 'declares no entry point, so it is a library' }
}

/**
 * The `@param` annotations a source declares.
 *
 * The grammar is one line, and it exists so the tab can build a slider and the
 * loader can set a uniform without a second file:
 *
 *   // @param SPEED float 0.1..2.0 default 0.5 "Rotation, radians per second"
 *
 * A token the parser does not recognise is ignored rather than guessed at, and
 * `lint` reports the line so a typo is visible.
 *
 * @returns `[{ name, type, min, max, default, description, line, uniform }]`,
 *   where `uniform` is the name a target should declare (`u_speed`).
 */
export function parseParams(source) {
  const params = []
  const lines = String(source).split('\n')
  const pattern =
    /@param\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9]*)\s*(?:(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?))?\s*(?:default\s+(\S+))?\s*(?:"([^"]*)")?/
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.includes('@param')) continue
    const match = pattern.exec(line)
    if (match === null) {
      params.push({ name: null, line: index + 1, malformed: line.trim() })
      continue
    }
    const type = match[2]
    params.push({
      name: match[1],
      type,
      min: match[3] === undefined ? null : Number(match[3]),
      max: match[4] === undefined ? null : Number(match[4]),
      default: match[5] === undefined ? null : coerceDefault(match[5], type),
      description: match[6] ?? '',
      line: index + 1,
      uniform: 'u_' + match[1].toLowerCase(),
    })
  }
  return params
}

/** Read a default the way its type demands, or `null` when it does not parse. */
function coerceDefault(raw, type) {
  if (type === 'bool') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return null
  }
  if (type === 'vec2' || type === 'vec3' || type === 'vec4' || type === 'color') {
    const parts = raw.replace(/^[(\[]|[)\]]$/g, '').split(',').map((part) => Number(part.trim()))
    if (parts.length === 0 || parts.some((value) => !Number.isFinite(value))) return null
    return parts
  }
  const number = Number(raw)
  return Number.isFinite(number) ? number : null
}

/** The header this row prepends for a wrapper dialect, as an array of lines. */
function wrapperHeader(dialect, params) {
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;']
  if (dialect === 'shadertoy') {
    // Shadertoy.com's own set. `iFrame` is a float there.
    lines.push(
      'uniform vec3 iResolution;',
      'uniform float iTime;',
      'uniform float iTimeDelta;',
      'uniform float iFrameRate;',
      'uniform float iFrame;',
      'uniform vec4 iMouse;',
      'uniform vec4 iDate;',
      'uniform sampler2D iChannel0;',
      'uniform sampler2D iChannel1;',
      'uniform sampler2D iChannel2;',
      'uniform sampler2D iChannel3;',
    )
  }
  if (dialect === 'shader-skills' || dialect === 'module') {
    // The gokayfem/shader-skills harness: `iFrame` is an INT here, and its
    // galleries pass it to `int` parameters. Everything else matches Shadertoy.
    // A `module` gets the same set because the corpus's modules are written to be
    // included INTO such a shader and some of them read `iFrame` directly
    // (`raymarch.glsl` does), so compiling one on its own must still define it.
    lines.push(
      'uniform vec3 iResolution;',
      'uniform float iTime;',
      'uniform float iTimeDelta;',
      'uniform float iFrameRate;',
      'uniform int iFrame;',
      'uniform vec4 iMouse;',
      'uniform sampler2D iChannel0;',
    )
  }
  lines.push('uniform float u_time;', 'uniform vec2 u_resolution;', 'uniform vec2 u_mouse;', 'uniform float u_frame;')
  for (const param of params) {
    if (param.name === null) continue
    const type =
      param.type === 'color' || param.type === 'vec3'
        ? 'vec3'
        : param.type === 'vec2'
          ? 'vec2'
          : param.type === 'vec4'
            ? 'vec4'
            : param.type === 'int'
              ? 'int'
              : param.type === 'bool'
                ? 'bool'
                : 'float'
    lines.push('uniform ' + type + ' ' + param.uniform + ';')
  }
  lines.push('out vec4 dshFragColor;')
  return lines
}

/** The footer that gives a wrapper dialect its entry point. */
function wrapperFooter(dialect) {
  if (dialect === 'shadertoy' || dialect === 'shader-skills') {
    return ['void main() {', '  vec4 dshColor = vec4(0.0, 0.0, 0.0, 1.0);', '  mainImage(dshColor, gl_FragCoord.xy);', '  dshFragColor = dshColor;', '}']
  }
  return ['void main() {', '  dshFragColor = vec4(0.0, 0.0, 0.0, 1.0);', '}']
}

/**
 * Assemble the string the compiler is handed, and the table that maps its line
 * numbers back.
 *
 * @param options - `{ source, dialect, stage, includes, params }`.
 * @returns `{ ok, wrapped, segments, mapLine, error }`; `mapLine(n)` returns
 *   `{ where, name, line }` with `where` one of `header` / `include` / `source` /
 *   `footer` / `outside`.
 */
export function assemble(options) {
  const source = String(options.source ?? '')
  const dialect = options.dialect ?? detectDialect(source).dialect
  const includes = Array.isArray(options.includes) ? options.includes : []
  const params = Array.isArray(options.params) ? options.params : parseParams(source)
  const stage = options.stage === 'vertex' ? 'vertex' : 'fragment'

  if (dialect === 'desktop') {
    return {
      ok: false,
      error:
        'A desktop GLSL source (#version ' +
        String((VERSION_LINE.exec(source) ?? [])[1] ?? '?') +
        ') is not compiled here: ANGLE, the compiler behind the browser this row uses, accepts GLSL ES only. `shader_verify` reports the static checks instead, and names `glslangValidator` as the tool that would compile it.',
      dialect,
      wrapped: source,
      segments: [],
      mapLine: () => ({ where: 'outside', name: null, line: 0 }),
    }
  }

  if (dialect === 'es100' || dialect === 'es300') {
    const lines = source.split('\n')
    const segments = [{ where: 'source', name: null, startLine: 1, count: lines.length }]
    return { ok: true, wrapped: source, segments, dialect, stage, mapLine: mapperFor(segments), params }
  }

  // A wrapper dialect. `#version` must be the first directive a compiler sees, so
  // a source that already carries one cannot be wrapped - it is a complete
  // shader, and the author should say so.
  if (VERSION_LINE.test(source)) {
    return {
      ok: false,
      error: 'A ' + dialect + ' source carries its own #version directive, so it cannot be wrapped. Declare it es300 and give it its own out variable, or remove the #version line.',
      dialect,
      wrapped: source,
      segments: [],
      mapLine: () => ({ where: 'outside', name: null, line: 0 }),
    }
  }

  const header = wrapperHeader(dialect, params)
  const footer = wrapperFooter(dialect)
  const includeBlocks = includes.map((entry) => ({ name: entry.name, lines: String(entry.source).split('\n') }))
  const sourceLines = source.split('\n')

  const body = []
  const segments = []
  const push = (where, name, lines) => {
    if (lines.length === 0) return
    segments.push({ where, name, startLine: body.length + 1, count: lines.length })
    for (const line of lines) body.push(line)
  }
  push('header', null, header)
  for (const block of includeBlocks) push('include', block.name, block.lines)
  push('source', null, sourceLines)
  push('footer', null, footer)

  return { ok: true, wrapped: body.join('\n'), segments, dialect, stage, mapLine: mapperFor(segments), params }
}

/** Build the line mapper from a segment table. */
function mapperFor(segments) {
  return (line) => {
    const number = Number(line)
    if (!Number.isFinite(number)) return { where: 'outside', name: null, line: 0 }
    for (const segment of segments) {
      if (number >= segment.startLine && number < segment.startLine + segment.count) {
        return { where: segment.where, name: segment.name, line: number - segment.startLine + 1 }
      }
    }
    return { where: 'outside', name: null, line: number }
  }
}

/**
 * Parse a compiler's information log into entries.
 *
 * The shape ANGLE emits (and `glslangValidator` copies) is
 * `ERROR: <string>:<line>: <message>`, with a message that may continue on the
 * next line without the prefix. A driver that uses the `0(12) : error C1234:`
 * spelling is handled too, because a desktop compile only ever runs through a
 * user's own validator.
 *
 * @returns `[{ severity, line, message }]` with the compiler's own line numbers.
 */
export function parseInfoLog(logText) {
  const entries = []
  const lines = String(logText ?? '').split('\n')
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const angle = /^(ERROR|WARNING|INFO)\s*:\s*\d+\s*:\s*(\d+)\s*:\s*(.*)$/.exec(line)
    if (angle !== null) {
      entries.push({ severity: angle[1].toLowerCase(), line: Number(angle[2]), message: angle[3].trim() })
      continue
    }
    const vendor = /^\d+\s*\(\s*(\d+)\s*\)\s*:\s*(error|warning)\s*(?:[A-Z]+\d+\s*)?:\s*(.*)$/i.exec(line)
    if (vendor !== null) {
      entries.push({ severity: vendor[2].toLowerCase(), line: Number(vendor[1]), message: vendor[3].trim() })
      continue
    }
    if (entries.length > 0) {
      const last = entries[entries.length - 1]
      last.message += ' ' + line.trim()
      continue
    }
    entries.push({ severity: 'info', line: 0, message: line.trim() })
  }
  return entries
}

/**
 * Map a compiler log onto the author's coordinates.
 *
 * @returns `{ diagnostics, own }` - `diagnostics` are about the author's source
 *   or an included module; `own` are about this row's own header, which is a bug
 *   here and must never be shown as the author's mistake.
 */
export function mapDiagnostics(logText, mapLine) {
  const diagnostics = []
  const own = []
  for (const entry of parseInfoLog(logText)) {
    const origin = mapLine(entry.line)
    const record = { severity: entry.severity, line: origin.line, where: origin.where, message: entry.message }
    if (origin.name !== null) record.include = origin.name
    if (origin.where === 'header' || origin.where === 'footer' || origin.where === 'outside') own.push(record)
    else diagnostics.push(record)
  }
  return { diagnostics, own }
}

/**
 * Advisory checks that hold whatever the compiler says.
 *
 * These never change a verdict: the compiler decides whether a shader compiles.
 * They exist because the compiler's message for some of these is a wall of
 * type errors three lines away from the cause, and because a couple of them
 * (an unused uniform, a non-constant loop bound in ES 1.00) compile cleanly on
 * one driver and fail on another.
 *
 * @returns `[{ kind, line, text }]`.
 */
export function lint(options) {
  const source = String(options.source ?? '')
  const dialect = options.dialect ?? detectDialect(source).dialect
  const stage = options.stage === 'vertex' ? 'vertex' : 'fragment'
  const lines = source.split('\n')
  const warnings = []
  const warn = (kind, line, text) => warnings.push({ kind, line, text })

  if (dialect === 'es100' && stage === 'fragment' && !/precision\s+(highp|mediump|lowp)\s+float/.test(source)) {
    warn('precision', 1, 'No float precision qualifier. WebGL1 requires `precision highp float;` (or mediump) in a fragment shader; without it the compiler fails with "No precision specified".')
  }
  if (dialect === 'es300') {
    if (/\bgl_FragColor\b/.test(source)) warn('removed', lineOf(lines, /gl_FragColor/), 'gl_FragColor does not exist in GLSL ES 3.00. Declare `out vec4 <name>;` and write to it.')
    if (/\bvarying\b/.test(source)) warn('removed', lineOf(lines, /\bvarying\b/), '`varying` was replaced by `in`/`out` in GLSL ES 3.00.')
    if (/\btexture2D\s*\(/.test(source)) warn('removed', lineOf(lines, /\btexture2D\s*\(/), '`texture2D` was replaced by `texture` in GLSL ES 3.00.')
    if (/\battribute\s+/.test(source)) warn('removed', lineOf(lines, /\battribute\s+/), '`attribute` was replaced by `in` in GLSL ES 3.00.')
  }
  if (dialect === 'es100' && stage === 'vertex' && /\bin\s+vec/.test(source)) {
    warn('removed', lineOf(lines, /\bin\s+vec/), 'GLSL ES 1.00 vertex shaders use `attribute`, not `in`.')
  }
  // `fwidth`/`dFdx` need OES_standard_derivatives in ES 1.00. This row enables it
  // on the context before compiling, so the warning says what a page must do.
  if (dialect === 'es100' && /\b(fwidth|dFdx|dFdy)\s*\(/.test(source)) {
    warn('derivatives', lineOf(lines, /\b(fwidth|dFdx|dFdy)\s*\(/), 'Uses screen-space derivatives. WebGL1 needs `gl.getExtension("OES_standard_derivatives")` before the shader is compiled; this row enables it for its own compile, and a page that embeds the shader must do the same.')
  }
  if (/#\s*include\b/.test(source)) {
    warn('include', lineOf(lines, /#\s*include\b/), 'GLSL has no preprocessor #include. Pass the modules with `includes` (shader_verify) or inline them.')
  }
  // A loop bound that is not a constant is legal on many drivers and illegal in
  // GLSL ES 1.00's specification; ANGLE allows it, a mobile driver may not.
  if (dialect === 'es100') {
    for (let index = 0; index < lines.length; index += 1) {
      const bound = /for\s*\([^;]*;\s*[^;]*[<>]=?\s*([A-Za-z_]\w*)/.exec(lines[index])
      if (bound !== null && !/^\s*(const|#)/.test(lines[index])) {
        warn('loop-bound', index + 1, 'Loop bound `' + bound[1] + '` is not a literal. GLSL ES 1.00 requires a constant loop bound; this compiles on ANGLE and may fail on a mobile driver.')
        break
      }
    }
  }
  // Declared-and-unused uniforms: the compiler deletes them, so `shader_verify`'s
  // active-uniform list is the authority; this is the syntactic early warning.
  for (let index = 0; index < lines.length; index += 1) {
    const declared = /^\s*uniform\s+(?:highp|mediump|lowp\s+)?\w+\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/.exec(lines[index])
    if (declared === null) continue
    const name = declared[1]
    const uses = lines.filter((line, other) => other !== index && new RegExp('\\b' + name + '\\b').test(line)).length
    if (uses === 0) warn('unused-uniform', index + 1, 'Uniform `' + name + '` is declared but never used, so the compiler will not keep it. A page that sets it will read a null location.')
  }
  for (const param of parseParams(source)) {
    if (param.name === null) warn('param', param.line, 'A `@param` line did not parse: ' + param.malformed)
    if (!PARAM_TYPES.includes(param.type)) warn('param', param.line, 'Unknown @param type `' + param.type + '`; use one of ' + PARAM_TYPES.join(', ') + '.')
  }
  for (const uniform of parseParams(source)) {
    if (uniform.name === null) continue
    const declared = new RegExp('uniform\\s+\\w+\\s+' + uniform.uniform + '\\s*;').test(source)
    if (!declared) {
      warn('param-uniform', uniform.line, '@param `' + uniform.name + '` expects a uniform `' + uniform.uniform + ';`, which this source does not declare. The wrapper declares it for a wrapper dialect; an es100/es300 source must declare it itself.')
    }
  }
  return warnings
}

/** The 1-based line of the first match, or 1. */
function lineOf(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1
  }
  return 1
}

/**
 * A stable id from a title, the same way the pack's diagrams name theirs:
 * lower case, dashes, no runs, bounded length.
 */
export function slugOf(title, fallback = 'shader') {
  const slug = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug === '' ? fallback : slug
}

/**
 * The vertex source this row links a fragment against: one full-screen triangle,
 * which is what every fragment shader here expects to be drawn with.
 */
export const FULLSCREEN_VERTEX_ES100 = ['attribute vec2 a_position;', 'void main() {', '  gl_Position = vec4(a_position, 0.0, 1.0);', '}'].join('\n')

export const FULLSCREEN_VERTEX_ES300 = ['#version 300 es', 'in vec2 a_position;', 'void main() {', '  gl_Position = vec4(a_position, 0.0, 1.0);', '}'].join('\n')
