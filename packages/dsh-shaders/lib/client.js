/**
 * dsh-shaders — browser half.
 *
 * Three surfaces, and one rule that shapes all of them: **the renderer is a live
 * WebGL context in the pane, not an iframe**. A shader you are editing has to show
 * the picture the browser in front of you produces, with sliders wired to its own
 * uniforms, because that is the half a compile cannot answer.
 *
 *   1. the `shader` tab - canvas, transport (play/pause/step), resolution, one
 *      slider per `@param`, a status line naming the rung, and the source;
 *   2. the `shaders` tab - this conversation's shaders and the vendored corpus,
 *      with a search over techniques;
 *   3. one `tool.call.toolview` card per rendering tool, so a shader and its
 *      diagnostics appear inline in the conversation.
 *
 * Everything canvas-shaped lives inside `useEffect`, and every component renders
 * without a DOM: the client-bundle check mounts all of it with a server renderer,
 * and a tab that touches `document` at import time would fail there rather than
 * here. The pane also renders a plain sentence when `getContext` returns null,
 * because a module tab in a browser with WebGL disabled must say so.
 */
/* global window, document, fetch, URL, devicePixelRatio, requestAnimationFrame, cancelAnimationFrame, matchMedia, performance, WebGLRenderingContext */
window.__ModuleLoader__.load({
  id: 'dsh-shaders',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system. */
    const VIEWER_ID = 'dsh-shaders-viewer'
    const VIEWER_KIND = 'shader'
    const INDEX_ID = 'dsh-shaders-index'
    const INDEX_KIND = 'shaders'
    /** Address grammar, kept in step with lib/tools.js `addressOf`. */
    const SESSION_PREFIX = 'dsh-resource://shader/session/'
    const LIBRARY_PREFIX = 'dsh-resource://shader/library/'
    /** Keep in sync with lib/index.js. */
    const STATE_ROUTE = '/api/dsh-shaders/state'
    const SHADER_ROUTE = '/api/dsh-shaders/shader'
    const ARTIFACT_ROUTE = '/api/dsh-shaders/artifact'
    const REPORT_ROUTE = '/api/dsh-shaders/render-report'
    /** The tools whose results get a card. */
    const TOOL_NAMES = ['shader_write', 'shader_verify', 'shader_render', 'shader_kit']

    /** The full-screen triangle every fragment here is drawn with. */
    const VERTEX_ES100 = 'attribute vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }'
    const VERTEX_ES300 = '#version 300 es\nin vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }'

    /**
     * Wrap a stored source the way the host does.
     *
     * The pane needs the same assembly the compiler uses, in the browser, without
     * the host: a Shadertoy source gets its uniforms and `main()`, an ES 1.00
     * source is drawn as written. Any drift between this and `lib/verify.js` shows
     * up as a pane that fails where `shader_verify` passed, which is why both are
     * written from the same contract rather than the same code.
     */
    function assembleInPane(source, dialect) {
      const text = String(source ?? '')
      if (dialect === 'es100' || dialect === 'es300' || dialect === 'desktop') return { text, context: dialect === 'es300' ? 'webgl2' : 'webgl', vertex: dialect === 'es300' ? VERTEX_ES300 : VERTEX_ES100 }
      const header = [
        '#version 300 es',
        'precision highp float;',
        'precision highp int;',
        'uniform vec3 iResolution;',
        'uniform float iTime;',
        'uniform int iFrame;',
        'uniform vec4 iMouse;',
        'uniform vec2 u_resolution;',
        'uniform float u_time;',
        'uniform vec2 u_mouse;',
        'uniform float u_frame;',
        'out vec4 dshFragColor;',
      ]
      const footer = ['void main() {', '  vec4 dshColor = vec4(0.0, 0.0, 0.0, 1.0);', '  mainImage(dshColor, gl_FragCoord.xy);', '  dshFragColor = dshColor;', '}']
      return { text: header.concat(text.split('\n'), footer).join('\n'), context: 'webgl2', vertex: VERTEX_ES300, dialect }
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    let stylesInjected = false
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined' || document === null) return
      // Every DOM touch is guarded: a host that hands this bundle a minimal document
      // (the client-bundle check does exactly that) must still get a working tab,
      // and a stylesheet that cannot be added is a cosmetic loss, not a failure.
      try {
        if (typeof document.getElementById === 'function' && document.getElementById('dsh-shaders-styles') !== null) {
          stylesInjected = true
          return
        }
        if (typeof document.createElement !== 'function' || document.head === undefined || typeof document.head.appendChild !== 'function') return
        const style = document.createElement('style')
        style.id = 'dsh-shaders-styles'
        style.textContent = `
.dss-root { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; color: var(--dsh-text, #e7e3dd); }
.dss-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); flex-wrap: wrap; }
.dss-bar button { font: inherit; padding: 2px 8px; border-radius: 4px; border: .5px solid var(--dsh-hairline, rgba(255,255,255,.18)); background: transparent; color: inherit; cursor: pointer; }
.dss-bar button:hover { background: rgba(255,255,255,.07); }
.dss-bar button[disabled] { opacity: .45; cursor: default; }
.dss-bar input[type=range] { width: 84px; }
.dss-spacer { flex: 1; }
.dss-canvasWrap { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #0a0a0a; overflow: hidden; }
.dss-canvasWrap canvas { display: block; max-width: 100%; max-height: 100%; }
.dss-status { padding: 4px 10px; font-family: ui-monospace, monospace; font-size: 11px; border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); white-space: pre-wrap; max-height: 24%; overflow: auto; }
.dss-status[data-state=failed] { color: #ffb4a8; }
.dss-status[data-state=drawn] { color: #9ed6a8; }
.dss-status[data-state=pending] { color: var(--dsh-muted, #9a938c); }
.dss-sliders { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); }
.dss-slider { display: grid; grid-template-columns: 92px 1fr 52px; gap: 8px; align-items: center; font-family: ui-monospace, monospace; font-size: 11px; }
.dss-source { margin: 0; padding: 8px 10px; overflow: auto; max-height: 34%; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre; }
.dss-list { overflow: auto; flex: 1; min-height: 0; }
.dss-row { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-bottom: .5px solid rgba(255,255,255,.07); cursor: pointer; }
.dss-row:hover { background: rgba(255,255,255,.05); }
.dss-rowId { font-family: ui-monospace, monospace; font-size: 11px; opacity: .75; }
.dss-rowTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dss-pill { font-family: ui-monospace, monospace; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: .5px solid currentColor; opacity: .85; }
.dss-pill[data-state=ok], .dss-pill[data-state=drawn] { color: #9ed6a8; }
.dss-pill[data-state=error], .dss-pill[data-state=failed] { color: #ffb4a8; }
.dss-pill[data-state=stale], .dss-pill[data-state=pending] { color: #d9c48a; }
.dss-empty { padding: 14px 12px; color: var(--dsh-muted, #9a938c); line-height: 1.6; }
.dss-card { border: .5px solid var(--dsh-hairline, rgba(255,255,255,.14)); border-radius: 8px; margin: 8px 0; overflow: hidden; }
.dss-cardTop { display: flex; gap: 8px; align-items: center; padding: 7px 10px; font-size: 12px; }
.dss-cardBody { border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); padding: 8px 10px; }
.dss-diag { font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; color: #ffb4a8; }
.dss-thumb { max-width: 100%; border-radius: 4px; }
.dss-note { font-size: 11px; color: var(--dsh-muted, #9a938c); line-height: 1.55; }
`
      document.head.appendChild(style)
        stylesInjected = true
      } catch (err) {
        /* a document without a head: the tab still works, unstyled */
      }
    }

    // ---------------------------------------------------------------------
    // Session and data
    // ---------------------------------------------------------------------
    /** The tab's address, from whatever the framework hands a body. */
    function addressOf(props) {
      if (props === null || props === undefined) return ''
      return String(props.address ?? props.tab?.address ?? props.tabAddress ?? '')
    }

    /** Where a shader lives, parsed. Never throws: an unparseable address is `session` and empty. */
    function parseAddress(address) {
      const value = String(address ?? '')
      if (value.startsWith(LIBRARY_PREFIX)) return { scope: 'library', sessionId: '', shaderId: value.slice(LIBRARY_PREFIX.length) }
      if (value.startsWith(SESSION_PREFIX)) {
        const rest = value.slice(SESSION_PREFIX.length)
        const slash = rest.indexOf('/')
        if (slash > 0) return { scope: 'session', sessionId: rest.slice(0, slash), shaderId: rest.slice(slash + 1) }
      }
      return { scope: 'session', sessionId: '', shaderId: '' }
    }

    /** The session this pane belongs to: the plugin context carries it. */
    let pluginCtx = null
    function currentSessionId() {
      const session = pluginCtx?.get?.('sessions')
      const id = session?.current?.()?.id ?? session?.activeId
      if (typeof id === 'string' && id !== '') return id
      return ''
    }

    async function readState(sessionId) {
      const response = await fetch(STATE_ROUTE + '?session=' + encodeURIComponent(sessionId))
      if (!response.ok) throw new Error('state ' + String(response.status))
      return response.json()
    }

    async function readShader(sessionId, id) {
      const response = await fetch(SHADER_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(id))
      if (!response.ok) throw new Error('shader ' + String(response.status))
      return response.json()
    }

    /** Tell the host whether THIS browser drew it. */
    async function reportRender(sessionId, id, ok, error) {
      try {
        await fetch(REPORT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, id, ok, error: error ?? null, phase: ok ? 'render' : 'render' }),
        })
      } catch (err) {
        /* the report is a courtesy; the pane already shows the truth */
      }
    }

    /** A hook that loads a shader and its conversation state. */
    function useShader(sessionId, shaderId) {
      const [state, setState] = useState(null)
      const [shader, setShader] = useState(null)
      const [error, setError] = useState(null)
      const reload = useCallback(async () => {
        if (sessionId === '') return
        try {
          const next = await readState(sessionId)
          setState(next)
          if (shaderId !== '') {
            const one = await readShader(sessionId, shaderId)
            setShader(one.shader ?? null)
          }
          setError(null)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }, [sessionId, shaderId])
      useEffect(() => {
        let live = true
        reload().catch(() => {})
        return () => {
          live = false
        }
      }, [reload])
      return { state, shader, error, reload }
    }

    // ---------------------------------------------------------------------
    // The renderer
    // ---------------------------------------------------------------------
    /**
     * Draw one shader into a canvas, for as long as the component is mounted.
     *
     * It stops on a hidden document and on unmount, caps the pixel ratio at 2, and
     * reports a compile failure to the page AND to the host - the browser's own
     * verdict is the second rung of the ladder, and a pane that only showed the
     * error locally would leave the host believing the shader was never checked.
     */
    function ShaderCanvas({ source, dialect, params, time, running, width, height, onVerdict, onFrame }) {
      const canvasRef = useRef(null)
      const glRef = useRef(null)
      const programRef = useRef(null)
      const uniformsRef = useRef({})
      const paramRef = useRef({})
      const [localError, setLocalError] = useState(null)
      const [unsupported, setUnsupported] = useState(false)

      paramRef.current = useMemo(() => {
        const out = {}
        for (const param of params ?? []) {
          if (param?.uniform === undefined) continue
          out[param.uniform] = param.default === null || param.default === undefined ? 0 : param.default
        }
        return out
      }, [JSON.stringify(params ?? [])])

      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof window === 'undefined') return undefined
        const assembled = assembleInPane(source, dialect)
        const context = assembled.context
        let gl = null
        try {
          gl = canvas.getContext(context, { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })
        } catch (err) {
          gl = null
        }
        if (gl === null) {
          setUnsupported(true)
          return undefined
        }
        setUnsupported(false)
        for (const name of ['OES_standard_derivatives', 'EXT_shader_texture_lod']) {
          try {
            gl.getExtension(name)
          } catch (err) {
            /* not offered */
          }
        }
        const fail = (message) => {
          setLocalError(message)
          if (typeof onVerdict === 'function') onVerdict(false, message)
        }
        const compile = (type, text, label) => {
          const shader = gl.createShader(type)
          gl.shaderSource(shader, text)
          gl.compileShader(shader)
          if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
            const log = String(gl.getShaderInfoLog(shader) ?? '')
            fail(label + ' shader: ' + log)
            return null
          }
          return shader
        }
        const vertex = compile(gl.VERTEX_SHADER, assembled.vertex, 'vertex')
        if (vertex === null) return undefined
        const fragment = compile(gl.FRAGMENT_SHADER, assembled.text, 'fragment')
        if (fragment === null) return undefined
        const program = gl.createProgram()
        gl.attachShader(program, vertex)
        gl.attachShader(program, fragment)
        gl.linkProgram(program)
        if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
          fail('link: ' + String(gl.getProgramInfoLog(program) ?? ''))
          return undefined
        }
        gl.useProgram(program)
        const buffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        const attribute = gl.getAttribLocation(program, 'a_position')
        if (attribute >= 0) {
          gl.enableVertexAttribArray(attribute)
          gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
        }
        const locations = {}
        for (const name of ['u_time', 'u_resolution', 'u_res', 'u_mouse', 'u_frame', 'iTime', 'iResolution', 'iMouse', 'iFrame', ...Object.keys(paramRef.current)]) {
          locations[name] = gl.getUniformLocation(program, name)
        }
        glRef.current = gl
        programRef.current = program
        uniformsRef.current = locations
        setLocalError(null)
        if (typeof onVerdict === 'function') onVerdict(true, null)
        return () => {
          gl.deleteProgram(program)
          gl.deleteShader(vertex)
          gl.deleteShader(fragment)
          gl.deleteBuffer(buffer)
          glRef.current = null
          programRef.current = null
        }
      }, [source, dialect])

      // The draw loop, and it is the ONLY place the clock advances.
      useEffect(() => {
        const canvas = canvasRef.current
        const gl = glRef.current
        const program = programRef.current
        if (canvas === null || gl === null || program === null) return undefined
        const drawWidth = Math.max(1, Math.round(width))
        const drawHeight = Math.max(1, Math.round(height))
        if (canvas.width !== drawWidth || canvas.height !== drawHeight) {
          canvas.width = drawWidth
          canvas.height = drawHeight
        }
        gl.viewport(0, 0, drawWidth, drawHeight)
        const set = (name, value) => {
          const location = uniformsRef.current[name]
          if (location === null || location === undefined) return
          if (Array.isArray(value)) {
            if (value.length === 2) gl.uniform2f(location, value[0], value[1])
            else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2])
            else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3])
            return
          }
          if (name === 'iFrame' || name === 'u_frame') gl.uniform1i(location, Math.round(value))
          else gl.uniform1f(location, value)
        }
        set('u_time', time)
        set('u_resolution', [drawWidth, drawHeight])
        set('u_res', [drawWidth, drawHeight])
        set('u_mouse', [0, 0])
        set('u_frame', 0)
        set('iTime', time)
        set('iResolution', [drawWidth, drawHeight, 1])
        set('iMouse', [0, 0, 0, 0])
        set('iFrame', 0)
        for (const [name, value] of Object.entries(paramRef.current)) set(name, value)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (typeof onFrame === 'function') onFrame({ width: drawWidth, height: drawHeight, running })
        return undefined
      }, [time, running, width, height, source, dialect])

      if (unsupported) {
        return h('div', { className: 'dss-empty' }, 'This browser has no WebGL context, so the shader cannot be drawn here. `shader_render` can still draw it on the host and hand back a PNG.')
      }
      return h(
        'div',
        { className: 'dss-canvasWrap' },
        h('canvas', { ref: canvasRef, width: width, height: height }),
        localError === null ? null : h('pre', { className: 'dss-status', 'data-state': 'failed' }, localError),
      )
    }

    // ---------------------------------------------------------------------
    // The viewer tab
    // ---------------------------------------------------------------------
    function Slider({ param, value, onChange }) {
      const min = Number.isFinite(Number(param.min)) ? Number(param.min) : 0
      const max = Number.isFinite(Number(param.max)) ? Number(param.max) : 1
      const step = param.type === 'int' ? 1 : (max - min) / 200 || 0.01
      return h(
        'label',
        { className: 'dss-slider' },
        h('span', { title: param.description ?? '' }, param.name),
        h('input', { type: 'range', min: min, max: max, step: step, value: value, onChange: (event) => onChange(Number(event.target.value)) }),
        h('span', null, String(value)),
      )
    }

    function ViewerBody(props) {
      const parsed = parseAddress(addressOf(props))
      const sessionId = parsed.sessionId !== '' ? parsed.sessionId : currentSessionId()
      const { state, shader, error } = useShader(sessionId, parsed.scope === 'session' ? parsed.shaderId : '')
      const [running, setRunning] = useState(true)
      const [time, setTime] = useState(0)
      const [size, setSize] = useState(512)
      const [verdict, setVerdict] = useState(null)
      const clock = useRef(0)

      const params = (shader?.params ?? []).filter((param) => param?.uniform !== undefined)
      const [values, setValues] = useState({})
      useEffect(() => {
        const next = {}
        for (const param of params) next[param.uniform] = param.default ?? 0
        setValues(next)
      }, [JSON.stringify(params.map((param) => param.uniform))])

      // The clock: one interval, so a paused pane really is paused.
      useEffect(() => {
        if (!running || typeof window === 'undefined') return undefined
        const started = performance.now() - clock.current * 1000
        const timer = window.setInterval(() => {
          clock.current = (performance.now() - started) / 1000
          setTime(clock.current)
        }, 33)
        return () => window.clearInterval(timer)
      }, [running])

      const onVerdict = useCallback(
        (ok, message) => {
          setVerdict({ ok, message })
          if (sessionId !== '' && parsed.shaderId !== '') reportRender(sessionId, parsed.shaderId, ok, message)
        },
        [sessionId, parsed.shaderId],
      )

      if (sessionId === '') {
        return h('div', { className: 'dss-empty' }, 'No conversation is open, so there is no shader to show. Open a chat and write one with `shader_write`.')
      }
      if (error !== null) return h('div', { className: 'dss-empty' }, 'Could not read this conversation\'s shaders: ' + error)
      if (shader === null) return h('div', { className: 'dss-empty' }, 'Loading the shader…')

      const verification = shader.verification ?? { state: 'pending' }
      const stateName = verdict === null ? verification.state : verdict.ok ? 'drawn' : 'failed'
      const statusText =
        stateName === 'drawn'
          ? 'drawn in this browser — ' + String(size) + '×' + String(size) + ' at t=' + time.toFixed(2) + 's'
          : stateName === 'failed'
            ? 'this browser could not draw it' + (verdict?.message ? '\n' + verdict.message : '')
            : 'not reported by this browser yet'

      return h(
        'div',
        { className: 'dss-root' },
        h(
          'div',
          { className: 'dss-bar' },
          h('button', { type: 'button', onClick: () => setRunning((value) => !value) }, running ? 'Pause' : 'Play'),
          h('button', { type: 'button', onClick: () => { clock.current = 0; setTime(0); setRunning(false) } }, 'Reset'),
          h('button', { type: 'button', onClick: () => setSize((value) => (value === 512 ? 256 : value === 256 ? 1024 : 512)) }, String(size) + 'px'),
          h('span', { className: 'dss-spacer' }),
          h('span', { className: 'dss-pill', 'data-state': stateName }, shader.dialect),
        ),
        h(ShaderCanvas, {
          source: shader.source,
          dialect: shader.dialect,
          params,
          time,
          running,
          width: size,
          height: size,
          onVerdict,
        }),
        h('div', { className: 'dss-status', 'data-state': stateName }, statusText),
        params.length === 0
          ? null
          : h(
              'div',
              { className: 'dss-sliders' },
              params.map((param) =>
                h(Slider, {
                  key: param.uniform,
                  param,
                  value: Number(values[param.uniform] ?? 0),
                  onChange: (value) => setValues((current) => ({ ...current, [param.uniform]: value })),
                }),
              ),
            ),
        h('pre', { className: 'dss-source' }, shader.source),
      )
    }

    function ViewerTitle(props) {
      const parsed = parseAddress(addressOf(props))
      return h('span', null, parsed.shaderId === '' ? 'Shader' : parsed.shaderId)
    }

    // ---------------------------------------------------------------------
    // The index tab
    // ---------------------------------------------------------------------
    function IndexBody(props) {
      const sessionId = parsedSessionId(props)
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [tab, setTab] = useState('mine')
      useEffect(() => {
        if (sessionId === '') return
        readState(sessionId)
          .then((next) => setState(next))
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [sessionId])

      if (sessionId === '') return h('div', { className: 'dss-empty' }, 'Open a conversation to see its shaders.')
      if (error !== null) return h('div', { className: 'dss-empty' }, 'Could not read the shaders: ' + error)
      if (state === null) return h('div', { className: 'dss-empty' }, 'Loading…')

      const kit = state.capabilities?.kit ?? {}
      const shaders = (state.shaders ?? []).filter((entry) => query === '' || (entry.id + ' ' + entry.title).toLowerCase().includes(query.toLowerCase()))

      return h(
        'div',
        { className: 'dss-root' },
        h(
          'div',
          { className: 'dss-bar' },
          h('button', { type: 'button', onClick: () => setTab('mine') }, 'This conversation'),
          h('button', { type: 'button', onClick: () => setTab('corpus') }, 'Corpus'),
          h('span', { className: 'dss-spacer' }),
          h('input', { type: 'search', value: query, placeholder: 'filter…', onChange: (event) => setQuery(event.target.value), style: { width: '120px', font: 'inherit' } }),
        ),
        tab === 'mine'
          ? shaders.length === 0
            ? h('div', { className: 'dss-empty' }, 'No shaders in this conversation yet. Ask for one, or call `shader_kit action=example` to start from a known-good one.')
            : h(
                'div',
                { className: 'dss-list' },
                shaders.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.id,
                      className: 'dss-row',
                      onClick: () => {
                        const api = pluginCtx?.get?.('sidebarRight')
                        if (api !== undefined && typeof api.open === 'function') api.open(SESSION_PREFIX + sessionId + '/' + entry.id)
                      },
                    },
                    h('span', { className: 'dss-rowTitle' }, entry.title || entry.id),
                    h('span', { className: 'dss-rowId' }, entry.id),
                    h('span', { className: 'dss-pill', 'data-state': entry.verification?.state ?? 'pending' }, entry.dialect),
                  ),
                ),
              )
          : h(CorpusBody, { kit, query }),
      )
    }

    function parsedSessionId(props) {
      const parsed = parseAddress(addressOf(props))
      return parsed.sessionId !== '' ? parsed.sessionId : currentSessionId()
    }

    function CorpusBody({ kit, query }) {
      const radiant = kit?.radiant ?? null
      const skills = kit?.skills ?? null
      const links = kit?.links ?? null
      if (radiant === null && skills === null) return h('div', { className: 'dss-empty' }, 'The vendored corpus is not installed in this build.')
      return h(
        'div',
        { className: 'dss-list' },
        radiant === null
          ? null
          : h(
              'div',
              { className: 'dss-card' },
              h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-pill' }, 'radiant'), h('span', { className: 'dss-rowTitle' }, String(radiant.pages) + ' pages · ' + String(radiant.sources) + ' fragment sources'), h('span', { className: 'dss-rowId' }, String(radiant.commit).slice(0, 8))),
              h('div', { className: 'dss-cardBody dss-note' }, 'Ask for one with `shader_kit action=example id=radiant/<page>`. Techniques: ' + Object.entries(radiant.byTechnique ?? {}).map(([name, count]) => name + ' ' + String(count)).join(', ')),
            ),
        skills === null
          ? null
          : h(
              'div',
              { className: 'dss-card' },
              h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-pill' }, 'shader-skills'), h('span', { className: 'dss-rowTitle' }, String(skills.modules) + ' modules · ' + String(skills.templates) + ' templates · ' + String(skills.gallery) + ' pieces'), h('span', { className: 'dss-rowId' }, String(skills.commit).slice(0, 8))),
              h('div', { className: 'dss-cardBody dss-note' }, 'Reusable GLSL: `shader_kit action=example id=module/noise`, `… id=template/terrain` (which names its own dependencies), `… id=gallery/ocean` (a finished piece the check compiles and draws).'),
            ),
        links === null
          ? null
          : h(
              'div',
              { className: 'dss-card' },
              h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-pill' }, 'links'), h('span', { className: 'dss-rowTitle' }, String(links.links) + ' curated links in ' + String((links.categories ?? []).length) + ' categories')),
              h('div', { className: 'dss-cardBody dss-note' }, 'Where to learn more, curated rather than invented: `shader_kit action=links query=raymarching`.'),
            ),
        query === '' ? null : h('div', { className: 'dss-note', style: { padding: '8px 10px' } }, 'Filtering the corpus needs `shader_kit action=search` from the conversation — this pane only shows the counts.'),
      )
    }

    function IndexTitle() {
      return h('span', null, 'Shaders')
    }

    // ---------------------------------------------------------------------
    // Tool cards
    // ---------------------------------------------------------------------
    function StatusPill({ status }) {
      return h('span', { className: 'dss-pill', 'data-state': status }, status)
    }

    function Diagnostics({ list }) {
      if (!Array.isArray(list) || list.length === 0) return null
      return h(
        'div',
        { className: 'dss-diag' },
        list.slice(0, 8).map((entry, index) => h('div', { key: index }, 'line ' + String(entry.line) + (entry.include ? ' [' + entry.include + ']' : '') + ' — ' + entry.message)),
      )
    }

    /** The card every shader_* tool renders into the conversation. */
    function ToolCard(props) {
      const view = props?.view ?? props?.result?.view ?? null
      const running = props?.running === true || props?.status === 'running'
      const openTab = useCallback(() => {
        if (view === null || view === undefined) return
        const api = pluginCtx?.get?.('sidebarRight')
        if (api === undefined || typeof api.open !== 'function') return
        if (typeof view.address === 'string' && view.address !== '') api.open(view.address)
      }, [view])

      if (running) return h('div', { className: 'dss-card' }, h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-note' }, 'Working on the shader…')))
      if (view === null || view === undefined) return h('div', { className: 'dss-card' }, h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-note' }, 'No shader result yet.')))

      const diagnostics = view.diagnostics ?? []
      const warnings = view.warnings ?? []
      const rung = view.rung ?? null
      const status = view.status ?? 'unknown'
      return h(
        'div',
        { className: 'dss-card' },
        h(
          'div',
          { className: 'dss-cardTop' },
          h(StatusPill, { status }),
          h('span', { className: 'dss-rowTitle' }, view.title ?? view.id ?? 'shader'),
          rung === null ? null : h('span', { className: 'dss-rowId' }, rung),
          view.dialect === undefined ? null : h('span', { className: 'dss-pill' }, view.dialect),
          h('span', { className: 'dss-spacer' }),
          typeof view.address === 'string' && view.address !== '' ? h('button', { type: 'button', onClick: openTab }, 'Open tab') : null,
        ),
        h(
          'div',
          { className: 'dss-cardBody' },
          view.frame !== undefined && view.frame !== null
            ? h('div', { className: 'dss-note' }, String(view.frame.width) + '×' + String(view.frame.height) + ' · ' + String(view.frame.distinctColors) + ' colours · signature ' + String(view.frame.signature) + (view.animated ? ' · animated' : ''))
            : null,
          view.artifact !== undefined && view.artifact !== null && view.artifact !== ''
            ? h('img', { className: 'dss-thumb', src: ARTIFACT_ROUTE + '?name=' + encodeURIComponent(view.artifact), alt: 'Rendered frame' })
            : null,
          h(Diagnostics, { list: diagnostics }),
          warnings.length === 0 ? null : h('div', { className: 'dss-note' }, String(warnings.length) + ' advisory warning(s) — see the tool answer.'),
          view.action === 'catalog' && view.radiant !== undefined ? h('div', { className: 'dss-note' }, 'corpus: ' + JSON.stringify({ radiant: view.radiant?.pages, sources: view.radiant?.sources, modules: view.skills?.modules, gallery: view.skills?.gallery, links: view.links?.links })) : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Tab-type definitions
    // ---------------------------------------------------------------------
    function viewerDefinition() {
      return {
        id: VIEWER_ID,
        kind: VIEWER_KIND,
        patterns: [SESSION_PREFIX + '**', LIBRARY_PREFIX + '**'],
        priority: 'extension',
        title: (address) => {
          const parsed = parseAddress(address)
          return parsed.shaderId === '' ? 'Shader' : parsed.shaderId
        },
      }
    }

    function indexDefinition() {
      return {
        id: INDEX_ID,
        kind: INDEX_KIND,
        priority: 'builtin',
        title: () => 'Shaders',
        guide: [
          {
            order: 41,
            title: () => 'Shaders',
            description: () => 'GLSL compiled for real: fragments, sources and the vendored corpus',
            icon: null,
          },
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      pluginCtx = ctx
      injectStyles()
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(viewerDefinition()), 'dsh-shaders: shader tab type')
        ctx.effect(() => ctx.sidebarRightTabs.register(indexDefinition()), 'dsh-shaders: shaders page type')
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: VIEWER_ID, inject: () => ({}) }, ViewerBody)),
          'dsh-shaders: shader tab body',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: VIEWER_ID }, ViewerTitle)),
          'dsh-shaders: shader tab title',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: INDEX_ID, inject: () => ({}) }, IndexBody)),
          'dsh-shaders: index tab body',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: INDEX_ID }, IndexTitle)),
          'dsh-shaders: index tab title',
        )
        for (const toolName of TOOL_NAMES) {
          ctx.effect(
            () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, ToolCard)),
            'dsh-shaders: ' + toolName + ' card',
          )
        }
      } catch (err) {
        // A profile without the right bar still gets the tool cards: the surfaces
        // that need the bar fail one at a time, and the rest of the row stands.
        if (typeof console !== 'undefined') console.warn('[dsh-shaders] a surface could not be registered: ' + String(err && err.message ? err.message : err))
      }
    }

    exports.name = 'dsh-shaders'
    exports.inject = inject
    exports.apply = apply
    /** The pure parts a check drives directly: no DOM is touched by any of them. */
    exports.__internals = { assembleInPane, parseAddress, viewerDefinition, indexDefinition, TOOL_NAMES, VIEWER_ID, INDEX_ID, SESSION_PREFIX, LIBRARY_PREFIX }
    return module.exports
  },
})
