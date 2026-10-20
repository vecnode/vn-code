/**
 * dsh-shaders — browser half.
 *
 * ONE support tab, deliberately small: pick a shader from this conversation, see a
 * preview of it drawn by THIS browser, move its parameters, read the verdict. It is
 * not a corpus browser and not a second editor — the corpus is `shader_kit`'s job in
 * the conversation, and the source itself belongs to the editor tab. A bar tab that
 * grew a gallery, a search and a file tree would be a worse editor, not a better
 * plugin.
 *
 * The one thing it does that nothing else can: it draws the shader with the local
 * GPU and reports whether THAT browser produced a picture. That is rung three of the
 * ladder (`v3-drawn`), and only a browser in front of a person can answer it.
 *
 * Everything canvas-shaped lives inside `useEffect`, and the pane renders a sentence
 * where a canvas would be, so the client-bundle check can mount it with a server
 * renderer and no WebGL.
 */
/* global window, document, fetch, URL, devicePixelRatio, performance, WebGLRenderingContext */
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
    const VIEWER_ID = 'dsh-shaders-viewer'
    const VIEWER_KIND = 'shader'
    /** Address grammar, kept in step with lib/tools.js `addressOf`. */
    const SESSION_PREFIX = 'dsh-resource://shader/session/'
    const LIBRARY_PREFIX = 'dsh-resource://shader/library/'
    /** Keep in sync with lib/index.js. */
    const STATE_ROUTE = '/api/dsh-shaders/state'
    const SHADER_ROUTE = '/api/dsh-shaders/shader'
    const ARTIFACT_ROUTE = '/api/dsh-shaders/artifact'
    const REPORT_ROUTE = '/api/dsh-shaders/render-report'
    /** The tools whose results get an inline card. */
    const TOOL_NAMES = ['shader_write', 'shader_verify', 'shader_render', 'shader_kit']

    const VERTEX_ES100 = 'attribute vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }'
    const VERTEX_ES300 = '#version 300 es\nin vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }'

    /**
     * Wrap a stored source the way the host does.
     *
     * Both sides are written from the same contract so a pane that fails where
     * `shader_verify` passed is a bug in one of them, not a difference of opinion.
     */
    function assembleInPane(source, dialect) {
      const text = String(source ?? '')
      if (dialect === 'es100' || dialect === 'es300' || dialect === 'desktop') {
        return { text, context: dialect === 'es300' ? 'webgl2' : 'webgl', vertex: dialect === 'es300' ? VERTEX_ES300 : VERTEX_ES100 }
      }
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
.dss-bar { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-bottom: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); flex-wrap: wrap; }
.dss-bar button { font: inherit; font-size: 11px; padding: 2px 7px; border-radius: 4px; border: .5px solid var(--dsh-hairline, rgba(255,255,255,.18)); background: transparent; color: inherit; cursor: pointer; }
.dss-bar button:hover { background: rgba(255,255,255,.07); }
.dss-spacer { flex: 1; }
.dss-canvas { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #0a0a0a; overflow: hidden; }
.dss-canvas canvas { display: block; max-width: 100%; max-height: 100%; }
.dss-status { padding: 4px 9px; font-family: ui-monospace, monospace; font-size: 11px; border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); white-space: pre-wrap; max-height: 22%; overflow: auto; }
.dss-status[data-state=failed] { color: #ffb4a8; }
.dss-status[data-state=drawn] { color: #9ed6a8; }
.dss-status[data-state=pending] { color: var(--dsh-muted, #9a938c); }
.dss-sliders { display: flex; flex-direction: column; gap: 1px; padding: 4px 9px; border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); }
.dss-slider { display: grid; grid-template-columns: 84px 1fr 46px; gap: 6px; align-items: center; font-family: ui-monospace, monospace; font-size: 11px; }
.dss-slider input { width: 100%; }
.dss-list { overflow: auto; max-height: 40%; border-bottom: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); }
.dss-row { display: flex; gap: 6px; align-items: baseline; padding: 3px 9px; cursor: pointer; }
.dss-row:hover { background: rgba(255,255,255,.05); }
.dss-row[data-active=true] { background: rgba(255,255,255,.09); }
.dss-rowId { font-family: ui-monospace, monospace; font-size: 10px; opacity: .7; }
.dss-rowTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dss-pill { font-family: ui-monospace, monospace; font-size: 10px; padding: 1px 5px; border-radius: 999px; border: .5px solid currentColor; opacity: .85; }
.dss-pill[data-state=ok], .dss-pill[data-state=drawn] { color: #9ed6a8; }
.dss-pill[data-state=error], .dss-pill[data-state=failed] { color: #ffb4a8; }
.dss-pill[data-state=stale], .dss-pill[data-state=pending] { color: #d9c48a; }
.dss-empty { padding: 12px 10px; color: var(--dsh-muted, #9a938c); line-height: 1.6; }
.dss-card { border: .5px solid var(--dsh-hairline, rgba(255,255,255,.14)); border-radius: 8px; margin: 8px 0; overflow: hidden; }
.dss-cardTop { display: flex; gap: 8px; align-items: center; padding: 6px 9px; font-size: 12px; }
.dss-cardBody { border-top: .5px solid var(--dsh-hairline, rgba(255,255,255,.12)); padding: 7px 9px; }
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
    function addressOf(props) {
      if (props === null || props === undefined) return ''
      return String(props.address ?? props.tab?.address ?? props.tabAddress ?? '')
    }

    /** Where a shader lives, parsed. Never throws. */
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

    let pluginCtx = null
    function currentSessionId() {
      const sessions = pluginCtx?.get?.('sessions')
      const id = sessions?.current?.()?.id ?? sessions?.activeId
      return typeof id === 'string' ? id : ''
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
          body: JSON.stringify({ session: sessionId, id, ok, error: error ?? null }),
        })
      } catch (err) {
        /* a courtesy: the pane already shows the truth */
      }
    }

    /**
     * Draw one shader into a canvas for as long as the component is mounted.
     *
     * A compile failure is reported to the page AND to the host - the browser's own
     * verdict is a rung, and a pane that only complained locally would leave the
     * host believing the shader was never checked.
     */
    function ShaderPreview({ source, dialect, params, values, time, size, onVerdict }) {
      const canvasRef = useRef(null)
      const glRef = useRef(null)
      const [problem, setProblem] = useState(null)
      const [unsupported, setUnsupported] = useState(false)

      const paramValues = useMemo(() => {
        const out = {}
        for (const param of params ?? []) {
          if (param?.uniform === undefined) continue
          out[param.uniform] = values?.[param.uniform] ?? (param.default ?? 0)
        }
        return out
      }, [JSON.stringify(params ?? []), JSON.stringify(values ?? {})])

      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof window === 'undefined') return undefined
        const assembled = assembleInPane(source, dialect)
        let gl = null
        try {
          gl = canvas.getContext(assembled.context, { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })
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
            /* not offered on this driver */
          }
        }
        const fail = (message) => {
          setProblem(message)
          if (typeof onVerdict === 'function') onVerdict(false, message)
        }
        const compile = (type, text, label) => {
          const shader = gl.createShader(type)
          gl.shaderSource(shader, text)
          gl.compileShader(shader)
          if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
            fail(label + ': ' + String(gl.getShaderInfoLog(shader) ?? ''))
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
        glRef.current = { gl, program }
        setProblem(null)
        if (typeof onVerdict === 'function') onVerdict(true, null)
        return () => {
          gl.deleteProgram(program)
          gl.deleteShader(vertex)
          gl.deleteShader(fragment)
          gl.deleteBuffer(buffer)
          glRef.current = null
        }
      }, [source, dialect])

      useEffect(() => {
        const canvas = canvasRef.current
        const bound = glRef.current
        if (canvas === null || bound === null) return undefined
        const { gl, program } = bound
        gl.useProgram(program)
        const side = Math.max(1, Math.round(size))
        if (canvas.width !== side || canvas.height !== side) {
          canvas.width = side
          canvas.height = side
        }
        gl.viewport(0, 0, side, side)
        const set = (name, value) => {
          const location = gl.getUniformLocation(program, name)
          if (location === null) return
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
        set('u_resolution', [side, side])
        set('u_res', [side, side])
        set('u_mouse', [0, 0])
        set('u_frame', 0)
        set('iTime', time)
        set('iResolution', [side, side, 1])
        set('iMouse', [0, 0, 0, 0])
        set('iFrame', 0)
        for (const [name, value] of Object.entries(paramValues)) set(name, value)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        return undefined
      }, [time, size, JSON.stringify(paramValues), source, dialect])

      if (unsupported) return h('div', { className: 'dss-empty' }, 'This browser has no WebGL, so nothing can be drawn here. `shader_render` can still draw it on the host and hand back a PNG.')
      return h(
        'div',
        { className: 'dss-canvas' },
        h('canvas', { ref: canvasRef, width: size, height: size }),
        problem === null ? null : h('pre', { className: 'dss-status', 'data-state': 'failed' }, problem),
      )
    }

    // ---------------------------------------------------------------------
    // The tab
    // ---------------------------------------------------------------------
    function Slider({ param, value, onChange }) {
      const min = Number.isFinite(Number(param.min)) ? Number(param.min) : 0
      const max = Number.isFinite(Number(param.max)) ? Number(param.max) : 1
      return h(
        'label',
        { className: 'dss-slider', title: param.description ?? '' },
        h('span', null, param.name),
        h('input', { type: 'range', min: min, max: max, step: param.type === 'int' ? 1 : (max - min) / 200 || 0.01, value: value, onChange: (event) => onChange(Number(event.target.value)) }),
        h('span', null, String(value)),
      )
    }

    function ViewerBody(props) {
      const parsed = parseAddress(addressOf(props))
      const [sessionId, setSessionId] = useState(parsed.sessionId)
      const [selected, setSelected] = useState(parsed.shaderId)
      const [state, setState] = useState(null)
      const [shader, setShader] = useState(null)
      const [error, setError] = useState(null)
      const [running, setRunning] = useState(true)
      const [time, setTime] = useState(0)
      const [size, setSize] = useState(320)
      const [values, setValues] = useState({})
      const [verdict, setVerdict] = useState(null)
      const clock = useRef(0)

      const reload = useCallback(async () => {
        try {
          const next = await readState(sessionId)
          setState(next)
          const id = selected !== '' ? selected : next.shaders?.[0]?.id ?? ''
          if (id !== '' && id !== selected) setSelected(id)
          if (id !== '') setShader((await readShader(sessionId, id)).shader ?? null)
          setError(null)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }, [sessionId, selected])

      useEffect(() => {
        if (sessionId !== '') return undefined
        const active = currentSessionId()
        if (active !== '') setSessionId(active)
        return undefined
      }, [sessionId])

      useEffect(() => {
        if (sessionId === '') return undefined
        reload().catch(() => {})
        return undefined
      }, [reload])

      const params = (shader?.params ?? []).filter((param) => param?.uniform !== undefined)
      useEffect(() => {
        const next = {}
        for (const param of params) next[param.uniform] = param.default ?? 0
        setValues(next)
        setVerdict(null)
      }, [JSON.stringify(params.map((param) => param.uniform))])

      useEffect(() => {
        if (!running || typeof window === 'undefined') return undefined
        const started = performance.now() - clock.current * 1000
        const timer = window.setInterval(() => {
          clock.current = (performance.now() - started) / 1000
          setTime(clock.current)
        }, 33)
        return () => window.clearInterval(timer)
      }, [running, selected])

      const onVerdict = useCallback(
        (ok, message) => {
          setVerdict({ ok, message })
          if (sessionId !== '' && selected !== '') reportRender(sessionId, selected, ok, message)
        },
        [sessionId, selected],
      )

      if (sessionId === '') return h('div', { className: 'dss-empty' }, 'No conversation is open. Write a shader with `shader_write` and it appears here.')
      if (error !== null) return h('div', { className: 'dss-empty' }, 'Could not read this conversation\'s shaders: ' + error)
      if (state === null) return h('div', { className: 'dss-empty' }, 'Loading…')

      const shaders = state.shaders ?? []
      if (shaders.length === 0) {
        return h('div', { className: 'dss-empty' }, 'No shaders in this conversation yet. `shader_write` stores one and verifies it; `shader_kit action=example` starts from a known-good one.')
      }
      const list = h(
        'div',
        { className: 'dss-list' },
        shaders.map((entry) =>
          h(
            'div',
            {
              key: entry.id,
              className: 'dss-row',
              'data-active': entry.id === selected ? 'true' : 'false',
              onClick: () => {
                setSelected(entry.id)
                setRunning(true)
                clock.current = 0
                setTime(0)
              },
            },
            h('span', { className: 'dss-rowTitle' }, entry.title || entry.id),
            h('span', { className: 'dss-rowId' }, entry.dialect + ' · r' + String(entry.revision)),
            h('span', { className: 'dss-pill', 'data-state': entry.verification?.state ?? 'pending' }, entry.verification?.state ?? 'pending'),
          ),
        ),
      )

      if (shader === null) return h('div', { className: 'dss-root' }, list, h('div', { className: 'dss-empty' }, 'Reading the shader…'))

      const stateName = verdict === null ? shader.verification?.state ?? 'pending' : verdict.ok ? 'drawn' : 'failed'
      const statusText =
        stateName === 'drawn'
          ? 'drawn by this browser at ' + String(size) + '×' + String(size) + ', t=' + time.toFixed(2) + 's'
          : stateName === 'failed'
            ? 'this browser could not draw it' + (verdict?.message ? '\n' + verdict.message : '')
            : 'not reported by this browser yet — `shader_verify` is the host-side answer'

      return h(
        'div',
        { className: 'dss-root' },
        list,
        h(
          'div',
          { className: 'dss-bar' },
          h('button', { type: 'button', onClick: () => setRunning((value) => !value) }, running ? 'Pause' : 'Play'),
          h('button', { type: 'button', onClick: () => { clock.current = 0; setTime(0); setRunning(false) } }, 'Reset'),
          h('button', { type: 'button', onClick: () => setSize((value) => (value === 320 ? 256 : value === 256 ? 512 : 320)) }, String(size) + 'px'),
          h('span', { className: 'dss-spacer' }),
          h('span', { className: 'dss-pill', 'data-state': stateName }, shader.dialect),
        ),
        h(ShaderPreview, { source: shader.source, dialect: shader.dialect, params, values, time, size, onVerdict }),
        h('div', { className: 'dss-status', 'data-state': stateName }, statusText),
        params.length === 0 ? null : h('div', { className: 'dss-sliders' }, params.map((param) => h(Slider, { key: param.uniform, param, value: Number(values[param.uniform] ?? 0), onChange: (value) => setValues((current) => ({ ...current, [param.uniform]: value })) }))),
      )
    }

    function ViewerTitle(props) {
      const parsed = parseAddress(addressOf(props))
      return h('span', null, parsed.shaderId === '' ? 'Shader' : parsed.shaderId)
    }

    // ---------------------------------------------------------------------
    // Tool cards
    // ---------------------------------------------------------------------
    function ToolCard(props) {
      const view = props?.view ?? props?.result?.view ?? null
      const running = props?.running === true || props?.status === 'running'
      const openTab = useCallback(() => {
        const api = pluginCtx?.get?.('sidebarRight')
        if (view !== null && view !== undefined && typeof view.address === 'string' && view.address !== '' && typeof api?.open === 'function') api.open(view.address)
      }, [view])

      if (running) return h('div', { className: 'dss-card' }, h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-note' }, 'Working on the shader…')))
      if (view === null || view === undefined) return h('div', { className: 'dss-card' }, h('div', { className: 'dss-cardTop' }, h('span', { className: 'dss-note' }, 'No shader result yet.')))

      const diagnostics = view.diagnostics ?? []
      return h(
        'div',
        { className: 'dss-card' },
        h(
          'div',
          { className: 'dss-cardTop' },
          h('span', { className: 'dss-pill', 'data-state': view.status ?? 'unknown' }, view.rung ?? view.status ?? 'unknown'),
          h('span', { className: 'dss-rowTitle' }, view.title ?? view.id ?? 'shader'),
          view.dialect === undefined || view.dialect === null ? null : h('span', { className: 'dss-rowId' }, view.dialect),
          h('span', { className: 'dss-spacer' }),
          typeof view.address === 'string' && view.address !== '' ? h('button', { type: 'button', onClick: openTab }, 'Open tab') : null,
        ),
        h(
          'div',
          { className: 'dss-cardBody' },
          view.frame !== undefined && view.frame !== null ? h('div', { className: 'dss-note' }, String(view.frame.width) + '×' + String(view.frame.height) + ' · ' + String(view.frame.distinctColors) + ' colours · signature ' + String(view.frame.signature) + (view.animated ? ' · animated' : '')) : null,
          view.artifact !== undefined && view.artifact !== null && view.artifact !== '' ? h('img', { className: 'dss-thumb', src: ARTIFACT_ROUTE + '?name=' + encodeURIComponent(view.artifact), alt: 'Rendered frame' }) : null,
          diagnostics.length === 0 ? null : h('div', { className: 'dss-diag' }, diagnostics.slice(0, 6).map((entry, index) => h('div', { key: index }, 'line ' + String(entry.line) + (entry.include ? ' [' + entry.include + ']' : '') + ' — ' + entry.message))),
          Array.isArray(view.warnings) && view.warnings.length > 0 ? h('div', { className: 'dss-note' }, String(view.warnings.length) + ' advisory warning(s) — see the tool answer.') : null,
          view.action === 'catalog' && view.radiant !== undefined ? h('div', { className: 'dss-note' }, 'corpus: radiant ' + String(view.radiant?.pages ?? 0) + ' pages · sources ' + String(view.radiant?.sources ?? 0) + ' · modules ' + String(view.skills?.modules ?? 0) + ' · gallery ' + String(view.skills?.gallery ?? 0) + ' · links ' + String(view.links?.links ?? 0)) : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry
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

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      pluginCtx = ctx
      injectStyles()
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(viewerDefinition()), 'dsh-shaders: shader tab type')
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: VIEWER_ID, inject: () => ({}) }, ViewerBody)),
          'dsh-shaders: shader tab body',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: VIEWER_ID }, ViewerTitle)),
          'dsh-shaders: shader tab title',
        )
        for (const toolName of TOOL_NAMES) {
          ctx.effect(
            () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, ToolCard)),
            'dsh-shaders: ' + toolName + ' card',
          )
        }
      } catch (err) {
        // A profile without the right bar still gets the tool cards.
        if (typeof console !== 'undefined') console.warn('[dsh-shaders] a surface could not be registered: ' + String(err && err.message ? err.message : err))
      }
    }

    exports.name = 'dsh-shaders'
    exports.inject = inject
    exports.apply = apply
    /** The pure parts a check drives directly: no DOM is touched by any of them. */
    exports.__internals = { assembleInPane, parseAddress, viewerDefinition, TOOL_NAMES, VIEWER_ID, SESSION_PREFIX, LIBRARY_PREFIX }
    return module.exports
  },
})
