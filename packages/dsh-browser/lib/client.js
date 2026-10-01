/**
 * dsh-browser — browser half.
 *
 * The Browser tab, and the REPLACEMENT for the shipped one. What it is NOT is the
 * important part: **there is no remote `<iframe>` in this bundle at all**. The
 * shipped tab put the site's own document in a frame, so a site's clickjacking
 * policy decided whether anything appeared (google.com: `X-Frame-Options:
 * SAMEORIGIN` -> "www.google.com refused to connect"), and whatever did appear
 * executed inside the user's browser. This tab asks the HOST to render the page
 * in a disposable engine behind an egress gate, and then draws a picture, the
 * rendered text and the page's own numbers.
 *
 *   - the type registers through `ctx.sidebarRightTabs.register(...)` with the id
 *     `@deepseek-ai/dsh-client-ui-sidebar-browser` and the kind `browser` - the
 *     REPLACED package's own identity, so a profile that already has Browser tabs
 *     persisted resolves them here. It is a PAGE type (`sidebar://browser`), its
 *     body and chip title register in the keyed seats under that same id, and its
 *     guide entry keeps the Start page's Browser at `order: 30`;
 *   - four views, all drawn from ONE render result: **Visual** (the PNG at a zoom
 *     ladder, where a zoom moves the LAYOUT box rather than a CSS transform, the
 *     pack's own rule, so a zoomed picture stays scrollable to its edge and drags
 *     to pan), **Reader** (the post-script text, with its links clickable through
 *     the same policy), **Metrics** (the page's own numbers and where it went) and
 *     **Policy** (the engine, the gate's verdict, and every refusal by name);
 *   - viewport presets (390 / 834 / 1280 / 1440 / 1920), a full-page capture, a
 *     dark-scheme render and our own back/forward over render history;
 *   - every request carries a **token** (`useRef`), so a slow render that lands
 *     after the reader moved on is discarded instead of painting over the newer
 *     one - the dsh-gittree alpha.1 lesson;
 *   - per-tab state lives in ONE module-level map keyed by the tab's own id, so
 *     two Browser tabs at two URLs do not share an address bar;
 *   - a `tool.call.toolview` card per tool draws the screenshot the agent just
 *     took, with the egress summary and a button that opens this tab at that URL.
 *     The handover is a module-level "pending" value, because the card and the tab
 *     are the same bundle instance.
 *
 * The dress is the pack's own tab dress under a `dsb-` prefix, with the same
 * toolbar/file-bar geometry as the editor and Files, so it reads as one more tab
 * of the same bar.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, localStorage */
window.__ModuleLoader__.load({
  id: 'dsh-browser',
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
    /** The REPLACED package's identity: persisted Browser tabs resolve here. */
    const TYPE_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'
    /** The tab kind this package owns. */
    const KIND = 'browser'
    /** The address a page tab of this kind is recorded under. */
    const PAGE_ADDRESS = 'sidebar://' + KIND
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-browser'
    const RENDER_ROUTE = API_ROOT + '/render'
    const IMAGE_ROUTE = API_ROOT + '/image'
    const STATE_ROUTE = API_ROOT + '/state'
    /** The viewport presets the toolbar offers. */
    const VIEWPORTS = [
      { id: 'phone', label: 'Phone', width: 390, height: 844 },
      { id: 'tablet', label: 'Tablet', width: 834, height: 1112 },
      { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
      { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
      { id: 'wide', label: 'Wide', width: 1920, height: 1080 },
    ]
    const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const TOOLVIEW_SLOT = 'tool.call.toolview'
    const TOOL_NAMES = ['browser_render', 'browser_query', 'browser_text']
    /** Shown in the policy panel: the live mode is parked, not forgotten. */
    const LIVE_PARKED =
      'Interactive live framing is parked: this browser renders pages on the host instead of framing them, so a site\u2019s framing policy cannot decide anything and no remote code runs in your browser.'

    // ---------------------------------------------------------------------
    // Per-tab state
    // ---------------------------------------------------------------------
    /** One entry per tab id: the address bar, the view, the last render. */
    const tabs = new Map()
    /** A URL handed over by a tool card, adopted by the tab when it mounts. */
    let pending = null

    function stateFor(tabId) {
      if (!tabs.has(tabId)) {
        tabs.set(tabId, { url: '', view: 'visual', preset: 'desktop', fullPage: false, dark: false, zoom: null, report: null, busy: false, error: null, history: [], at: -1 })
      }
      return tabs.get(tabId)
    }

    /** One JSON request. `credentials: same-origin` is what the routes expect. */
    async function postRender(body) {
      const response = await fetch(RENDER_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json()
    }

    /** The picture's URL for one artifact id. */
    function imageUrl(id) {
      return IMAGE_ROUTE + '?id=' + encodeURIComponent(id)
    }

    /** A byte count a person reads. */
    function humanBytes(value) {
      const bytes = Number(value) || 0
      if (bytes < 1024) return String(bytes) + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** Read the render's request out of a state entry, so a re-render repeats it. */
    function requestFor(state, url) {
      const preset = VIEWPORTS.find((entry) => entry.id === state.preset) ?? VIEWPORTS[3]
      return { url: url ?? state.url, width: preset.width, height: preset.height, fullPage: state.fullPage, dark: state.dark, dpr: preset.id === 'phone' ? 2 : 1 }
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    function BrowserView(props) {
      const tabId = props.tabId || props.id || props.sessionId || 'browser'
      const [, bump] = useState(0)
      const state = stateFor(tabId)
      const token = useRef(0)
      const [address, setAddress] = useState(state.url)
      const [engine, setEngine] = useState(null)

      useEffect(() => {
        let live = true
        fetch(STATE_ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((value) => {
            if (live) setEngine(value)
          })
          .catch(() => {})
        return () => {
          live = false
        }
      }, [])

      // A tool card can hand this tab a URL; adopt it once.
      useEffect(() => {
        if (pending !== null) {
          const url = pending
          pending = null
          setAddress(url)
          void run(url)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const render = useCallback(
        async (url) => {
          const trimmed = String(url ?? '').trim()
          if (trimmed === '') return
          const mine = ++token.current
          state.url = trimmed
          state.busy = true
          state.error = null
          bump((value) => value + 1)
          try {
            const answer = await postRender(requestFor(state, trimmed))
            if (mine !== token.current) return
            if (answer && answer.ok === true) {
              state.report = answer
              state.history = state.history.slice(0, state.at + 1).concat([trimmed])
              state.at = state.history.length - 1
            } else {
              state.error = answer && answer.message ? answer.message : 'The render failed.'
              state.report = answer && answer.code ? answer : state.report
            }
          } catch (err) {
            if (mine === token.current) state.error = String((err && err.message) || err)
          } finally {
            if (mine === token.current) {
              state.busy = false
              bump((value) => value + 1)
            }
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tabId],
      )

      const run = render
      const report = state.report
      const ok = Boolean(report && report.ok === true)
      const view = state.view

      const go = (delta) => {
        const at = state.at + delta
        if (at < 0 || at >= state.history.length) return
        state.at = at
        setAddress(state.history[at])
        void run(state.history[at])
      }

      const setView = (next) => {
        state.view = next
        bump((value) => value + 1)
      }

      const setPreset = (id) => {
        state.preset = id
        bump((value) => value + 1)
        if (state.url !== '') void run(state.url)
      }

      const toggle = (key) => {
        state[key] = !state[key]
        bump((value) => value + 1)
        if (state.url !== '') void run(state.url)
      }

      return h(
        'div',
        { className: 'dsb-root', 'data-dsh-browser': 'tab' },
        h(
          'div',
          { className: 'dsb-toolbar' },
          h('button', { type: 'button', className: 'dsb-icon', title: 'Back', disabled: state.at <= 0, onClick: () => go(-1) }, '\u2039'),
          h('button', { type: 'button', className: 'dsb-icon', title: 'Forward', disabled: state.at >= state.history.length - 1, onClick: () => go(1) }, '\u203a'),
          h('input', {
            className: 'dsb-address',
            value: address,
            spellCheck: false,
            placeholder: 'https://example.com',
            'aria-label': 'Address',
            onChange: (event) => setAddress(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void run(address)
            },
          }),
          h('button', { type: 'button', className: 'dsb-go', disabled: state.busy, onClick: () => void run(address) }, state.busy ? 'Rendering\u2026' : 'Render'),
        ),
        h(
          'div',
          { className: 'dsb-fileBar' },
          h('select', {
            className: 'dsb-select',
            value: state.preset,
            'aria-label': 'Viewport',
            onChange: (event) => setPreset(event.target.value),
          }, VIEWPORTS.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.label + ' ' + String(preset.width) + '\u00d7' + String(preset.height)))),
          h('button', { type: 'button', className: 'dsb-chip' + (state.fullPage ? ' dsb-chipOn' : ''), onClick: () => toggle('fullPage'), title: 'Capture the whole scrollable page' }, 'Full page'),
          h('button', { type: 'button', className: 'dsb-chip' + (state.dark ? ' dsb-chipOn' : ''), onClick: () => toggle('dark'), title: 'Render with prefers-color-scheme: dark' }, 'Dark'),
          h('span', { className: 'dsb-spacer' }),
          ['visual', 'reader', 'metrics', 'policy'].map((id) =>
            h('button', { key: id, type: 'button', className: 'dsb-chip' + (view === id ? ' dsb-chipOn' : ''), onClick: () => setView(id) }, id.charAt(0).toUpperCase() + id.slice(1)),
          ),
        ),
        h(
          'div',
          { className: 'dsb-notice' },
          h('span', { className: 'dsb-noticeDot', 'aria-hidden': 'true' }, '\u25cf'),
          'Rendered by a disposable host engine' + (ok && report.engine ? ' (' + String(report.engine.kind) + ')' : '') + ' - this is not a live page, and the remote page never runs in your browser.',
        ),
        state.error !== null && state.error !== ''
          ? h('div', { className: 'dsb-error', 'data-dsh-browser-error': '1' }, state.error)
          : null,
        state.busy && !ok ? h('div', { className: 'dsb-empty' }, 'Rendering on the host\u2026') : null,
        !state.busy && !ok && !state.error && state.url === '' ? h(EmptyState, { engine }) : null,
        ok && view === 'visual' ? h(Visual, { report, state, bump }) : null,
        ok && view === 'reader' ? h(Reader, { report, onOpen: (url) => { setAddress(url); void run(url) } }) : null,
        ok && view === 'metrics' ? h(Metrics, { report }) : null,
        ok && view === 'policy' ? h(Policy, { report, engine }) : null,
        !ok && view === 'policy' && !state.busy ? h(Policy, { report, engine }) : null,
      )
    }

    /** The first-run state: what this tab is, and what it refuses. */
    function EmptyState(props) {
      const engine = props.engine
      return h(
        'div',
        { className: 'dsb-empty' },
        h('div', { className: 'dsb-emptyTitle' }, 'The browser that renders on the host'),
        h('div', { className: 'dsb-emptyText' }, 'Type an https address and Render. The page is fetched and drawn by a throwaway engine on this machine behind an egress gate: https only, port 443 only, public destinations only - so a site\u2019s X-Frame-Options cannot decide whether you see it, and no remote code runs in this tab.'),
        h('div', { className: 'dsb-emptyFacts' }, [
          h('div', { key: 'engine' }, 'Engine: ' + (engine && engine.engine ? String(engine.engine.file) + ' (' + String(engine.engine.source) + ')' : 'none found - install Chrome, Chromium or Edge')),
          engine && engine.policy
            ? h('div', { key: 'policy' }, 'Policy: ' + engine.policy.schemes.join(', ') + ' - ports ' + engine.policy.ports.join(', ') + ' - ' + engine.policy.destinations + ' - IP literals ' + engine.policy.ipLiterals)
            : null,
          h('div', { key: 'live' }, LIVE_PARKED),
        ]),
      )
    }

    /** The picture, with the pack's zoom rule: the LADDER moves the layout box. */
    function Visual(props) {
      const report = props.report
      const state = props.state
      const bump = props.bump
      const image = report.image
      const pane = useRef(null)
      const zoom = state.zoom === null ? null : state.zoom
      const scale = zoom === null ? 'fit' : zoom
      const shown = zoom === null ? null : { width: Math.round(image.width * zoom), height: Math.round(image.height * zoom) }
      const step = (direction) => {
        const current = zoom === null ? 1 : zoom
        const index = ZOOM_STEPS.findIndex((value) => value >= current - 0.001)
        const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? 3 : index) + direction))]
        state.zoom = next
        bump((value) => value + 1)
      }
      return h(
        'div',
        { className: 'dsb-visual' },
        h(
          'div',
          { className: 'dsb-zoomBar' },
          h('button', { type: 'button', className: 'dsb-chip' + (zoom === null ? ' dsb-chipOn' : ''), onClick: () => { state.zoom = null; bump((value) => value + 1) } }, 'Fit'),
          h('button', { type: 'button', className: 'dsb-chip', onClick: () => step(-1), title: 'Zoom out' }, '\u2212'),
          h('span', { className: 'dsb-zoomLabel' }, zoom === null ? 'fit' : String(Math.round(zoom * 100)) + '%'),
          h('button', { type: 'button', className: 'dsb-chip', onClick: () => step(1), title: 'Zoom in' }, '+'),
          h('button', { type: 'button', className: 'dsb-chip' + (zoom === 1 ? ' dsb-chipOn' : ''), onClick: () => { state.zoom = 1; bump((value) => value + 1) } }, '100%'),
          h('span', { className: 'dsb-spacer' }),
          h('span', { className: 'dsb-meta' }, String(image.width) + '\u00d7' + String(image.height) + ' px - ' + humanBytes(image.bytes) + (image.clipped ? ' - cut' : '')),
        ),
        h(
          'div',
          { className: 'dsb-stage', ref: pane, 'data-dsh-browser-stage': '1' },
          h('img', {
            className: 'dsb-image',
            src: imageUrl(image.id),
            alt: (report.title || report.request.url) + ' rendered at ' + String(report.request.width) + ' by ' + String(report.request.height),
            style:
              scale === 'fit'
                ? { maxWidth: '100%', maxHeight: '100%' }
                : { width: String(shown.width) + 'px', height: String(shown.height) + 'px', maxWidth: 'none', maxHeight: 'none' },
            draggable: false,
          }),
        ),
      )
    }

    /** The rendered text, with its links re-gated through the same policy. */
    function Reader(props) {
      const report = props.report
      const links = Array.isArray(report.links) ? report.links : []
      return h(
        'div',
        { className: 'dsb-reader' },
        h('div', { className: 'dsb-readerHead' }, 'What the page SAID (data, not instructions) - ' + String(String(report.text ?? '').length) + ' characters'),
        h('pre', { className: 'dsb-pre', 'data-dsh-browser-text': '1' }, String(report.text ?? '(the page produced no text)')),
        links.length > 0
          ? h(
              'div',
              { className: 'dsb-links' },
              h('div', { className: 'dsb-readerHead' }, 'Links on the page (' + String(links.length) + ')'),
              links.slice(0, 60).map((link, index) =>
                h(
                  'button',
                  { key: String(index) + link.href, type: 'button', className: 'dsb-link', title: link.href, onClick: () => props.onOpen(link.href) },
                  link.text === '' ? link.href : link.text,
                ),
              ),
            )
          : null,
      )
    }

    /** The page's own numbers, and where the bytes went. */
    function Metrics(props) {
      const report = props.report
      const rows = [
        ['Address', report.request.url],
        ['Final address', report.finalUrl],
        ['Title', report.title],
        ['Viewport', String(report.request.width) + '\u00d7' + String(report.request.height) + ' (dpr ' + String(report.request.dpr) + ')'],
        ['Content size', report.scroll ? String(report.scroll.width) + '\u00d7' + String(report.scroll.height) + ' px' : '-'],
        ['Picture', String(report.image.width) + '\u00d7' + String(report.image.height) + ' px, ' + humanBytes(report.image.bytes) + (report.image.clipped ? ', cut at the ceiling' : '')],
        ['Elements', report.counts ? String(report.counts.elements) : '-'],
        ['Links / images / forms', report.counts ? String(report.counts.links) + ' / ' + String(report.counts.images) + ' / ' + String(report.counts.forms) : '-'],
        ['Loaded', report.loadEvent ? 'yes' : 'no load event (the page settled by timeout)'],
        ['Timing', report.timing ? String(report.timing.totalMs) + ' ms total, ' + String(report.timing.navigateMs) + ' ms to navigate' : '-'],
        ['Page requests', report.pageRequests === undefined ? '-' : String(report.pageRequests)],
      ]
      return h(
        'div',
        { className: 'dsb-metrics' },
        h('table', { className: 'dsb-table' }, h('tbody', null, rows.map(([key, value]) => h('tr', { key }, h('th', null, key), h('td', null, String(value === undefined || value === '' ? '-' : value)))))),
      )
    }

    /** The egress story: the engine, the gate, and every refusal by name. */
    function Policy(props) {
      const report = props.report
      const engine = props.engine
      const gate = report && report.ok === true ? report.gate : null
      return h(
        'div',
        { className: 'dsb-policy', 'data-dsh-browser-policy': '1' },
        h('div', { className: 'dsb-readerHead' }, 'Policy in force'),
        h('table', { className: 'dsb-table' }, h('tbody', null, [
          h('tr', { key: 'scheme' }, h('th', null, 'Schemes'), h('td', null, engine && engine.policy ? engine.policy.schemes.join(', ') : 'https')),
          h('tr', { key: 'ports' }, h('th', null, 'Ports'), h('td', null, engine && engine.policy ? engine.policy.ports.join(', ') : '443')),
          h('tr', { key: 'dest' }, h('th', null, 'Destinations'), h('td', null, engine && engine.policy ? engine.policy.destinations : 'public unicast only')),
          h('tr', { key: 'allow' }, h('th', null, 'Allowlist'), h('td', null, engine && engine.policy && engine.policy.allowHosts.length > 0 ? engine.policy.allowHosts.join(', ') : '(empty: any public host)')),
          h('tr', { key: 'engine' }, h('th', null, 'Engine'), h('td', null, engine && engine.engine ? String(engine.engine.file) : 'none found')),
        ])),
        gate === null
          ? h('div', { className: 'dsb-readerHead' }, 'No render yet, so the gate has nothing to report.')
          : h('div', null, [
              h('div', { className: 'dsb-readerHead', key: 'head' }, 'The gate for this render (port ' + String(gate.port) + ')'),
              h('table', { className: 'dsb-table', key: 'table' }, h('tbody', null, [
                h('tr', { key: 't' }, h('th', null, 'Tunnels opened'), h('td', null, String(gate.tunnels))),
                h('tr', { key: 'c' }, h('th', null, 'Proxy challenges answered'), h('td', null, String(gate.challenges))),
                h('tr', { key: 'r' }, h('th', null, 'Destinations refused'), h('td', null, String(gate.refused))),
                h('tr', { key: 'b' }, h('th', null, 'Bytes through the gate'), h('td', null, humanBytes(gate.bytesDown))),
              ])),
              gate.allowed.length > 0
                ? h('div', { className: 'dsb-readerHead', key: 'a' }, 'Allowed: ' + gate.allowed.map((entry) => entry.host + ' \u2192 ' + entry.address).join(', '))
                : null,
              report && Array.isArray(report.pageHosts) && report.pageHosts.length > 0
                ? h('div', { className: 'dsb-meta', key: 'p' }, 'The page itself asked for: ' + report.pageHosts.join(', ') + '. A host the page did not ask for can still appear above: the engine\u2019s own connectivity probe goes through the same gate, which is how you know the gate is the only way out.')
                : null,
              gate.refusals.length > 0
                ? h('div', { className: 'dsb-refusals', key: 'ref' }, gate.refusals.map((entry, index) => h('div', { key: String(index) }, '\u2717 ' + (entry.host || '(no host)') + ' - ' + (entry.code || entry.reason))))
                : null,
            ]),
        h('div', { className: 'dsb-meta' }, LIVE_PARKED),
      )
    }

    /** The tab chip's title: the address, or the tab's own name before that. */
    function BrowserTitle(props) {
      const tabId = props.tabId || props.id || props.sessionId || 'browser'
      const state = stateFor(tabId)
      return h('span', { className: 'dsb-title' }, state.url === '' ? 'Browser' : state.url.replace(/^https:\/\//, ''))
    }

    /** One tool card: the screenshot the agent took, plus its egress story. */
    function ToolCard(props) {
      const view = (props && (props.result?.view || props.view)) || {}
      const open = () => {
        if (typeof view.url === 'string' && view.url !== '') pending = view.url
        const sidebar = typeof ctxRef.get === 'function' ? ctxRef.get('sidebarRight') : undefined
        if (sidebar && typeof sidebar.openTab === 'function') sidebar.openTab(KIND, {})
      }
      const head = view.ok === false ? 'Browser: refused' : 'Rendered ' + String(view.url ?? '')
      return h(
        'div',
        { className: 'dsb-card', 'data-dsh-browser-card': '1' },
        h('div', { className: 'dsb-cardHead' }, head),
        view.title ? h('div', { className: 'dsb-meta' }, String(view.title)) : null,
        view.imageId ? h('img', { className: 'dsb-cardImage', src: imageUrl(view.imageId), alt: 'Rendered page', draggable: false }) : null,
        view.ok === false && view.message ? h('div', { className: 'dsb-error' }, String(view.message)) : null,
        h(
          'div',
          { className: 'dsb-cardFacts' },
          view.width ? String(view.width) + '\u00d7' + String(view.height) + ' px' : null,
          view.tunnels !== undefined ? String(view.tunnels) + ' tunnel(s)' : null,
          view.refused ? String(view.refused) + ' refused' : null,
          view.viewport ? 'at ' + String(view.viewport.width) + '\u00d7' + String(view.viewport.height) : null,
        ),
        h('button', { type: 'button', className: 'dsb-chip', onClick: open }, 'Open the Browser tab'),
      )
    }

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress under this package's own prefix)
    // ---------------------------------------------------------------------
    const CSS = [
      '.dsb-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsb-toolbar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}',
      '.dsb-fileBar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);flex-wrap:wrap}',
      '.dsb-spacer{flex:1;min-width:0}',
      '.dsb-icon{flex:none;width:24px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:0 0;color:inherit;cursor:pointer;font-size:14px;line-height:1}',
      '.dsb-icon:disabled{opacity:.4;cursor:default}',
      '.dsb-address{flex:1;min-width:0;height:26px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12.5px;padding:0 9px}',
      '.dsb-go{flex:none;height:26px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12px;padding:0 10px;cursor:pointer}',
      '.dsb-go:disabled{opacity:.6;cursor:default}',
      '.dsb-select{height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:11.5px;padding:0 6px}',
      '.dsb-chip{flex:none;height:22px;box-sizing:border-box;border:.5px solid transparent;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:11.5px;padding:0 8px;cursor:pointer}',
      '.dsb-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.dsb-chipOn{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.dsb-zoomBar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.dsb-zoomLabel{min-width:38px;text-align:center;font-variant-numeric:tabular-nums}',
      '.dsb-meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}',
      '.dsb-notice{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.1))}',
      '.dsb-noticeDot{color:var(--dsw-alias-brand-primary,#4176e6);font-size:9px}',
      '.dsb-error{flex:none;margin:8px 10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#d3382c);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d3382c) 8%, transparent)}',
      '.dsb-empty{margin:auto;max-width:520px;padding:24px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary,#666);font-size:12.5px;line-height:19px}',
      '.dsb-emptyTitle{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.dsb-emptyFacts{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.dsb-visual{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dsb-stage{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));padding:10px}',
      '.dsb-image{margin:auto;display:block;background:#fff;box-shadow:var(--dsw-shadow-lv2,0 1px 4px rgba(0,0,0,.12))}',
      '.dsb-reader{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dsb-readerHead{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.dsb-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:12.5px;line-height:19px}',
      '.dsb-links{display:flex;flex-direction:column;gap:2px}',
      '.dsb-link{text-align:left;background:0 0;border:0;padding:2px 0;color:var(--dsw-alias-brand-primary,#4176e6);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsb-metrics,.dsb-policy{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dsb-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dsb-table th{text-align:left;font-weight:400;color:var(--dsw-alias-label-tertiary,#999);padding:3px 10px 3px 0;white-space:nowrap;vertical-align:top}',
      '.dsb-table td{padding:3px 0;word-break:break-word}',
      '.dsb-refusals{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d3382c)}',
      '.dsb-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsb-card{margin:6px 0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:6px}',
      '.dsb-cardHead{font-size:12.5px;font-weight:500}',
      '.dsb-cardImage{max-width:100%;max-height:320px;object-fit:contain;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));background:#fff}',
      '.dsb-cardFacts{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
    ].join('\n')

    /** The captured context, for the tool card's "open the tab" action. */
    let ctxRef = null

    function installStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-browser/tab.css'
      let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-browser'
        tag.dataset.pluginCss = id
        document.head.appendChild(tag)
      }
      if (tag.textContent !== CSS) tag.textContent = CSS
    }

    // ---------------------------------------------------------------------
    // Registry definition
    // ---------------------------------------------------------------------
    function browserDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        multiple: true,
        priority: 'builtin',
        title: () => 'Browser',
        guide: [
          {
            order: 30,
            title: () => 'Browser',
            description: () => 'Render a page on the host and read it',
          },
        ],
      }
    }

    /** Services the activation waits for: the slot registry and the bar's tabs. */
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctxRef = ctx
      try {
        installStyles()
        ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition()), 'dsh-browser: browser tab type')
        ctx.effect(
          () =>
            ctx.slots.inject(TAB_SLOT, () =>
              ctx.slots.register(
                {
                  name: TAB_SLOT,
                  key: TYPE_ID,
                  inject: (sessionId) => ({ sessionId }),
                },
                BrowserView,
              ),
            ),
          'dsh-browser: browser tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TITLE_SLOT, () =>
              ctx.slots.register(
                {
                  name: TITLE_SLOT,
                  key: TYPE_ID,
                },
                BrowserTitle,
              ),
            ),
          'dsh-browser: browser tab title',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TOOLVIEW_SLOT, () => TOOL_NAMES.map((toolName) => ctx.slots.register({ name: TOOLVIEW_SLOT, key: toolName }, ToolCard))),
          'dsh-browser: tool cards',
        )
        ctx.logger?.debug?.('[dsh-browser] browser tab type registered (' + '0.1.0-alpha.1' + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-browser] activation failed', err)
        ctx.logger?.warn?.('[dsh-browser] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-browser'
    exports.inject = inject
    exports.apply = apply
    /** The pure half, for the tracked check: no DOM, no fetch, no React. */
    exports.__internals = {
      TYPE_ID,
      KIND,
      PAGE_ADDRESS,
      VIEWPORTS,
      ZOOM_STEPS,
      TOOL_NAMES,
      LIVE_PARKED,
      CSS,
      browserDefinition,
      stateFor,
      imageUrl,
      humanBytes,
      requestFor,
      tabs,
      /** Set the URL a tool card hands to the tab (the check drives this). */
      handOver(url) {
        pending = url
      },
      takePending() {
        const value = pending
        pending = null
        return value
      },
    }
    // The factory MUST hand the exports back: the loader reads `apply`/`inject`
    // off what this returns, and a factory that returns undefined registers
    // nothing while looking perfectly healthy (caught by the load-and-render
    // check, which is the only thing that could have caught it).
    return module.exports
  },
})
