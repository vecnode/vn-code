/**
 * dsh-docker — browser half.
 *
 * ONE PAGE TAB for the pack's right bar (dsh-rightbar): the shipping containers
 * and images on this machine, with the few things a person actually does to them
 * - start, stop, restart, remove, pull, run, and read a container's logs - and
 * the one thing no shell gives them: an engine that is DOWN says so, and offers
 * the button that starts Docker Desktop.
 *
 * It is a PAGE type: no `patterns`, so it never claims a file address; it
 * registers in the keyed seats `sidebar.right.pane.tab` / `.title` and adds a
 * guide entry, so the tab strip's "+" control (the Start page) offers **Docker**
 * after Files (10), Editor (20) and History (30).
 *
 * WHY THERE IS NO WEBSOCKET AND NO STREAM. The host's `/state` route is one
 * JSON answer built from the CLI, and the tab polls it every 5 s while it is the
 * visible tab - a container engine's state changes on a human timescale, and a
 * push channel would be a second protocol for the same facts. The poll stops
 * when the document is hidden or this tab is gone, which is the difference
 * between a panel and a runaway.
 *
 * THE SURFACE IS SPLIT FROM THE POLL ON PURPOSE: `DockerSurface` renders from a
 * model it is handed, so the tracked check can render every state - absent,
 * down, up, selected, confirming - without a browser, a route or a docker.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch */
window.__ModuleLoader__.load({
  id: 'dsh-docker',
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
    /** This implementation's identity in the tab system, and its slot key. */
    const TYPE_ID = 'dsh-docker'
    /** The tab kind this package owns. */
    const KIND = 'docker'
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-docker'
    const STATE_ROUTE = API_ROOT + '/state'
    const LOGS_ROUTE = API_ROOT + '/logs'
    const INSPECT_ROUTE = API_ROOT + '/inspect'
    const ACTION_ROUTE = API_ROOT + '/action'
    const PULL_ROUTE = API_ROOT + '/pull'
    const START_ROUTE = API_ROOT + '/start'
    const RUN_ROUTE = API_ROOT + '/run'
    /** Version marker on the tab, so a freshly loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** The keyed seats every tab type occupies. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** How often the visible tab asks the host for the engine's state. */
    const POLL_MS = 5000
    /** How many log lines the drawer asks for. */
    const LOG_TAIL = 200

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.ddk-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar: every column's top band ends in the same
   hairline at y=76, so this is the pack's 38px border-box header. */
.ddk-tools{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.ddk-title{flex:none;display:inline-flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap}
.ddk-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a8a)}
.ddk-dot[data-state="up"]{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.ddk-dot[data-state="down"]{background:var(--dsw-alias-state-warning-primary,#d29922)}
.ddk-dot[data-state="absent"]{background:var(--dsw-alias-label-tertiary,#8a8a8a)}
.ddk-meta{flex:0 1 auto;display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden}
.ddk-meta b{font-weight:500;color:var(--dsw-alias-label-secondary,#666)}
.ddk-spacer{flex:1;min-width:0}
.ddk-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap;gap:4px}
.ddk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ddk-btn:disabled{opacity:.45;cursor:default}
.ddk-btn.ddk-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4f8cff);color:#fff;font-weight:500}
.ddk-btn.ddk-primary:hover:not(:disabled){filter:brightness(1.08)}
.ddk-btn.ddk-danger{color:var(--dsw-alias-state-error-primary,#d3382c);border-color:var(--dsw-alias-state-error-primary,#d3382c)}
.ddk-btn.ddk-icon{padding:0;width:24px}
.ddk-body{flex:1;min-height:0;overflow:auto;box-sizing:border-box;padding:10px 12px 16px}
.ddk-section{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.ddk-sectionHead{display:flex;align-items:center;gap:8px;min-width:0}
.ddk-sectionTitle{flex:none;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#666)}
.ddk-count{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.ddk-filter{flex:0 1 180px;height:24px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;min-width:0}
.ddk-rows{display:flex;flex-direction:column;gap:1px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:8px;overflow:hidden}
.ddk-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.ddk-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.ddk-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.ddk-row + .ddk-row{border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12))}
.ddk-name{flex:0 1 auto;min-width:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ddk-image{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);font-family:ui-monospace,'Cascadia Code',Consolas,monospace}
.ddk-where{flex:none;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.ddk-state{flex:none;font-size:11px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.ddk-state[data-running="true"]{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.ddk-rowActions{flex:none;display:inline-flex;align-items:center;gap:4px;margin-left:auto}
.ddk-mini{flex:none;height:20px;min-width:20px;padding:0 5px;font-size:11px}
.ddk-drawer{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:8px 10px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));margin:2px 0 4px}
.ddk-facts{display:flex;flex-direction:column;gap:1px;min-width:0}
.ddk-factRow{display:flex;gap:10px;min-width:0;font-size:11.5px;line-height:17px}
.ddk-factKey{flex:none;width:88px;color:var(--dsw-alias-label-tertiary,#999)}
.ddk-factVal{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#666);word-break:break-word;font-variant-numeric:tabular-nums}
.ddk-logText{margin:0;max-height:220px;overflow:auto;box-sizing:border-box;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#b8b8b8);font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.ddk-form{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}
.ddk-field{display:flex;align-items:center;gap:8px;min-width:0}
.ddk-fieldLabel{flex:none;width:88px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999)}
.ddk-input{flex:1;min-width:0;height:24px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px}
.ddk-formRow{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.ddk-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px 20px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;text-align:center}
.ddk-stateBox{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}
.ddk-stateTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f1f1f)}
.ddk-stateNote{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666);word-break:break-word;max-width:720px}
.ddk-warn{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-state-error-secondary,rgba(211,56,44,.1));color:var(--dsw-alias-state-error-primary,#d3382c);font-size:11.5px;word-break:break-word}
.ddk-notice{padding:6px 8px;border-radius:6px;background:var(--dsw-alias-state-success-secondary,rgba(47,158,68,.1));color:var(--dsw-alias-state-success-primary,#2f9e44);font-size:11.5px;word-break:break-word}
.ddk-note{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);overflow-wrap:anywhere}
.ddk-ver{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);opacity:.8}
`
    const CSS_TAG = 'dsh-docker/docker.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-docker'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Words (pure)
    // ---------------------------------------------------------------------
    /** The engine's identity in one line. */
    function engineSummary(engine) {
      if (engine === null || engine === undefined) return ''
      const version = typeof engine.serverVersion === 'string' && engine.serverVersion !== '' ? engine.serverVersion : engine.cliVersion
      let head = engine.cli === '' ? 'engine' : String(engine.cli)
      if (typeof version === 'string' && version !== '') head += ' ' + version
      const parts = [head]
      if (typeof engine.context === 'string' && engine.context !== '') parts.push('context ' + engine.context)
      return parts.join(' \u00b7 ')
    }

    /** A container's state, in the words a person uses. */
    function stateWord(row) {
      if (row === null || row === undefined) return ''
      if (row.running === true) return 'running'
      const state = typeof row.state === 'string' ? row.state : ''
      return state === '' ? 'stopped' : state
    }

    /** The actions one row offers, in the order they are drawn. */
    function rowActions(kind, row) {
      if (kind === 'image') return ['run', 'remove']
      return [row !== null && row !== undefined && row.running === true ? 'stop' : 'start', 'restart', 'remove']
    }

    /** Whether the engine can be started from here, and what to call it. */
    function startableOf(model) {
      if (model === null || model === undefined) return null
      if (model.view !== 'down') return null
      const plan = model.state !== null && model.state !== undefined ? model.state.startable : null
      if (plan === null || plan === undefined || plan.kind === '') return { canStart: false, hint: plan !== null && plan !== undefined && typeof plan.hint === 'string' ? plan.hint : '' }
      return { canStart: true, label: typeof plan.label === 'string' && plan.label !== '' ? plan.label : 'the engine', hint: '' }
    }

    /** The port string from a row, clipped for a narrow column. */
    function portsLabel(row) {
      if (row === null || row === undefined || typeof row.ports !== 'string' || row.ports === '') return '\u2014'
      return row.ports
    }

    /** The image row's human name: the reference, or its id when untagged. */
    function imageLabel(row) {
      if (row === null || row === undefined) return ''
      return typeof row.ref === 'string' && row.ref !== '' ? row.ref : String(row.id === undefined ? '' : row.id).replace(/^sha256:/, '').slice(0, 12)
    }

    /** A form's port field, split into the array the route wants. */
    function splitPorts(text) {
      return String(text === undefined || text === null ? '' : text)
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
    }

    // ---------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------
    async function fetchJson(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...(options ?? {}) })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (body === null || typeof body !== 'object') {
        return { ok: false, error: { code: 'BAD_ANSWER', message: 'The host answered ' + response.status + ' with something that is not JSON.' } }
      }
      return body
    }

    async function postJson(url, payload) {
      return fetchJson(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
    }

    // ---------------------------------------------------------------------
    // Glyphs
    // ---------------------------------------------------------------------
    /** The Docker mark: stacked containers on a hull. Drawn, not fetched. */
    function DockerGlyph(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        h('path', { d: 'M1.4 7.4h8.2c.6 0 .9.4.9 1v2.2H1.4z' }),
        h('path', { d: 'M3 7.4V5.6h2v1.8M5.7 7.4V5.6h2v1.8M8.3 7.4V5.6h2v1.8' }),
        h('path', { d: 'M1.4 10.6c1.6 1.6 4.2 2.6 7.6 2.6 2.2 0 4.2-.7 5.6-2.1' }),
        h('path', { d: 'M12.6 6.5c.7-.4 1.3-.4 2 .1' }),
      )
    }

    /** One small icon per action; a text label is always beside it. */
    function ActionGlyph(props) {
      const name = props !== null && props !== undefined ? props.name : ''
      const paths = {
        refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.8', 'M13.4 2.6v2.6h-2.6'],
        start: ['M5 3.2l7 4.8-7 4.8z'],
        stop: ['M4.6 4.6h6.8v6.8H4.6z'],
        restart: ['M2.9 8a5.1 5.1 0 1 0 1.5-3.6', 'M2.6 2.6v2.6h2.6'],
        remove: ['M3.2 4.6h9.6', 'M5.2 4.6V3.2h5.6v1.4', 'M4.4 4.6l.6 8h6l.6-8'],
        logs: ['M3.4 3.6h9.2', 'M3.4 8h9.2', 'M3.4 12.4h5.6'],
        disk: ['M2.6 5.2h10.8v5.6H2.6z', 'M5 8h6'],
        run: ['M3.4 3.2h9.2v9.6H3.4z', 'M6.4 6l3.4 2-3.4 2z'],
        pull: ['M8 2.8v7.4', 'M4.9 7.1L8 10.2l3.1-3.1', 'M3.4 13h9.2'],
        close: ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6'],
      }
      const list = paths[name] ?? []
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        list.map((d, index) => h('path', { key: 'p' + index, d: d })),
      )
    }

    function IconButton(props) {
      const title = props.title
      return h(
        'button',
        {
          type: 'button',
          className: 'ddk-btn ddk-icon' + (props.danger === true ? ' ddk-danger' : ''),
          title: title,
          'aria-label': title,
          'data-docker-action': props.action,
          'data-docker-target': props.target,
          disabled: props.disabled === true,
          onClick: (event) => {
            event.stopPropagation()
            props.onClick()
          },
        },
        h(ActionGlyph, { name: props.action }),
      )
    }

    // ---------------------------------------------------------------------
    // The surface (pure: it renders what it is handed)
    // ---------------------------------------------------------------------
    function FactRow(props) {
      return h('div', { className: 'ddk-factRow' }, h('span', { className: 'ddk-factKey' }, props.label), h('span', { className: 'ddk-factVal' }, props.value === '' ? '\u2014' : props.value))
    }

    /** The facts of one container or image, as rows. */
    function factsOf(drawer) {
      if (drawer === null || drawer === undefined || drawer.facts === null || drawer.facts === undefined) return []
      const facts = drawer.facts
      if (facts.kind === 'image') {
        return [
          ['tags', facts.tags.length === 0 ? '' : facts.tags.join(', ')],
          ['id', facts.id],
          ['digest', facts.digests.length === 0 ? '' : facts.digests[0]],
          ['platform', [facts.os, facts.architecture].filter((part) => part !== '').join('/')],
          ['size', facts.size > 0 ? Math.round(facts.size / 1024 / 1024) + ' MB' : ''],
          ['created', facts.created],
          ['cmd', facts.cmd.join(' ')],
          ['env vars', String(facts.envCount)],
        ]
      }
      return [
        ['name', facts.name],
        ['id', facts.id],
        ['image', facts.image],
        ['status', facts.status + (facts.running ? '' : facts.exitCode === null ? '' : ' (exit ' + facts.exitCode + ')')],
        ['started', facts.startedAt],
        ['finished', facts.finishedAt],
        ['restart', facts.restart === '' ? 'no' : facts.restart],
        ['network', facts.networkMode],
        ['ports', facts.ports.join(', ')],
        ['mounts', facts.mounts.join(', ')],
        ['networks', facts.networks.join(', ')],
        ['env vars', String(facts.envCount)],
      ]
    }

    /** The drawer: one container's or image's facts and, for a container, its logs. */
    function Drawer(props) {
      const drawer = props.drawer
      if (drawer === null || drawer === undefined) return null
      return h(
        'div',
        { className: 'ddk-drawer', 'data-docker-drawer': drawer.kind },
        h(
          'div',
          { className: 'ddk-sectionHead' },
          h('span', { className: 'ddk-sectionTitle' }, drawer.kind === 'image' ? 'Image' : 'Container'),
          h('span', { className: 'ddk-count' }, drawer.id === null || drawer.id === undefined ? '' : drawer.id.slice(0, 12)),
          h('span', { className: 'ddk-spacer' }),
          drawer.kind === 'container'
            ? h(
                'button',
                { type: 'button', className: 'ddk-btn ddk-mini', 'data-docker-action': 'reload-logs', title: 'Read the logs again', onClick: props.onReloadLogs },
                h(ActionGlyph, { name: 'logs' }),
                'Logs',
              )
            : null,
          h('button', { type: 'button', className: 'ddk-btn ddk-icon', title: 'Close the details', 'data-docker-action': 'close-drawer', onClick: props.onClose }, h(ActionGlyph, { name: 'close' })),
        ),
        drawer.phase === 'loading' ? h('div', { className: 'ddk-stateNote' }, 'Asking the engine\u2026') : null,
        drawer.phase === 'failed' ? h('div', { className: 'ddk-warn' }, drawer.error) : null,
        drawer.phase === 'ready'
          ? h('div', { className: 'ddk-facts' }, factsOf(drawer).map((pair) => h(FactRow, { key: 'f-' + pair[0], label: pair[0], value: pair[1] })))
          : null,
        drawer.kind === 'container' && drawer.phase === 'ready'
          ? h('pre', { className: 'ddk-logText', 'data-docker-logs': 'true' }, drawer.logs === '' ? '(the container has written nothing)' : drawer.logs)
          : null,
      )
    }

    /** One container row, plus its actions. */
    function ContainerRow(props) {
      const row = props.row
      const busy = props.busy
      const confirming = props.confirm !== null && props.confirm !== undefined && props.confirm.kind === 'container' && props.confirm.id === row.id
      const actions = rowActions('container', row)
      return h(
        'div',
        { className: 'ddk-row', 'data-docker-row': 'container', 'data-docker-id': row.id, 'data-active': props.open ? 'true' : 'false', role: 'button', tabIndex: 0, onClick: props.onOpen, onKeyDown: (event) => (event.key === 'Enter' || event.key === ' ' ? props.onOpen() : null) },
        h('span', { className: 'ddk-dot', 'data-state': row.running ? 'up' : 'down' }),
        h('span', { className: 'ddk-name', title: row.name }, row.name === '' ? row.id.slice(0, 12) : row.name),
        h('span', { className: 'ddk-image', title: row.image }, row.image),
        h('span', { className: 'ddk-where', title: row.ports }, portsLabel(row)),
        h('span', { className: 'ddk-state', 'data-running': row.running ? 'true' : 'false' }, stateWord(row)),
        h(
          'span',
          { className: 'ddk-rowActions' },
          confirming
            ? [
                h('button', { key: 'yes', type: 'button', className: 'ddk-btn ddk-mini ddk-danger', 'data-docker-action': 'confirm-remove', disabled: busy, onClick: (event) => { event.stopPropagation(); props.onAction('remove', 'container', row.id, row.id) } }, 'Remove it'),
                h('button', { key: 'no', type: 'button', className: 'ddk-btn ddk-mini', 'data-docker-action': 'cancel-remove', onClick: (event) => { event.stopPropagation(); props.onCancel() } }, 'Keep'),
              ]
            : actions.map((action) =>
                h(IconButton, {
                  key: action,
                  action: action,
                  target: row.id,
                  danger: action === 'remove',
                  disabled: busy,
                  title: action === 'remove' ? 'Remove ' + (row.name === '' ? row.id.slice(0, 12) : row.name) : action + ' ' + (row.name === '' ? row.id.slice(0, 12) : row.name),
                  onClick: () => (action === 'remove' ? props.onAskRemove(row.id) : props.onAction(action, 'container', row.id)),
                }),
              ),
        ),
      )
    }

    /** One image row, plus its actions. */
    function ImageRow(props) {
      const row = props.row
      const confirming = props.confirm !== null && props.confirm !== undefined && props.confirm.kind === 'image' && props.confirm.id === row.id
      const actions = rowActions('image', row)
      return h(
        'div',
        { className: 'ddk-row', 'data-docker-row': 'image', 'data-docker-id': row.id, 'data-active': props.open ? 'true' : 'false', role: 'button', tabIndex: 0, onClick: props.onOpen, onKeyDown: (event) => (event.key === 'Enter' || event.key === ' ' ? props.onOpen() : null) },
        h('span', { className: 'ddk-name', title: imageLabel(row) }, imageLabel(row)),
        h('span', { className: 'ddk-where', title: 'used by ' + row.containers + ' container(s)' }, row.size),
        h('span', { className: 'ddk-state' }, row.created),
        h(
          'span',
          { className: 'ddk-rowActions' },
          confirming
            ? [
                h('button', { key: 'yes', type: 'button', className: 'ddk-btn ddk-mini ddk-danger', 'data-docker-action': 'confirm-remove', disabled: props.busy, onClick: (event) => { event.stopPropagation(); props.onAction('remove', 'image', row.id, row.id) } }, 'Remove it'),
                h('button', { key: 'no', type: 'button', className: 'ddk-btn ddk-mini', 'data-docker-action': 'cancel-remove', onClick: (event) => { event.stopPropagation(); props.onCancel() } }, 'Keep'),
              ]
            : actions.map((action) =>
                h(IconButton, {
                  key: action,
                  action: action,
                  target: row.id,
                  danger: action === 'remove',
                  disabled: props.busy,
                  title: action === 'run' ? 'Start a container from ' + imageLabel(row) : 'Remove image ' + imageLabel(row),
                  onClick: () => (action === 'remove' ? props.onAskRemove(row.id) : props.onRun(row)),
                }),
              ),
        ),
      )
    }

    /** The two forms: pull an image, and start one. */
    function PullForm(props) {
      const [image, setImage] = useState('')
      return h(
        'form',
        {
          className: 'ddk-form',
          'data-docker-form': 'pull',
          onSubmit: (event) => {
            event.preventDefault()
            if (image.trim() !== '') props.onSubmit(image.trim())
          },
        },
        h(
          'label',
          { className: 'ddk-field' },
          h('span', { className: 'ddk-fieldLabel' }, 'Image'),
          h('input', { className: 'ddk-input', value: image, placeholder: 'alpine:3.20', onChange: (event) => setImage(event.target.value), autoFocus: true }),
        ),
        h(
          'div',
          { className: 'ddk-formRow' },
          h('button', { type: 'button', className: 'ddk-btn', onClick: props.onCancel }, 'Cancel'),
          h('button', { type: 'submit', className: 'ddk-btn ddk-primary', disabled: props.busy === true || image.trim() === '', 'data-docker-action': 'pull' }, props.busy === true ? 'Pulling\u2026' : 'Pull'),
        ),
      )
    }

    function RunForm(props) {
      const [image, setImage] = useState(props.image === undefined || props.image === null ? '' : props.image)
      const [name, setName] = useState('')
      const [ports, setPorts] = useState('')
      return h(
        'form',
        {
          className: 'ddk-form',
          'data-docker-form': 'run',
          onSubmit: (event) => {
            event.preventDefault()
            if (image.trim() === '') return
            props.onSubmit({ image: image.trim(), name: name.trim(), ports: splitPorts(ports) })
          },
        },
        h('label', { className: 'ddk-field' }, h('span', { className: 'ddk-fieldLabel' }, 'Image'), h('input', { className: 'ddk-input', value: image, onChange: (event) => setImage(event.target.value), autoFocus: true })),
        h('label', { className: 'ddk-field' }, h('span', { className: 'ddk-fieldLabel' }, 'Name'), h('input', { className: 'ddk-input', value: name, placeholder: 'optional', onChange: (event) => setName(event.target.value) })),
        h('label', { className: 'ddk-field' }, h('span', { className: 'ddk-fieldLabel' }, 'Ports'), h('input', { className: 'ddk-input', value: ports, placeholder: '8080:80, 127.0.0.1:5432:5432', onChange: (event) => setPorts(event.target.value) })),
        h('div', { className: 'ddk-note' }, 'The image\u2019s own CMD runs. A command, environment, volumes and a network need `docker_run` from the agent, which validates them.'),
        h(
          'div',
          { className: 'ddk-formRow' },
          h('button', { type: 'button', className: 'ddk-btn', onClick: props.onCancel }, 'Cancel'),
          h('button', { type: 'submit', className: 'ddk-btn ddk-primary', disabled: props.busy === true || image.trim() === '', 'data-docker-action': 'run' }, props.busy === true ? 'Starting\u2026' : 'Start'),
        ),
      )
    }

    /**
     * THE TAB, DRAWN.
     *
     * `model` is the whole state (`view`, `state`, `containers`, `images`,
     * `selected`, `drawer`, `confirm`, `busy`, `notice`, `error`, `filter`,
     * `showAll`, `form`), `actions` is the callbacks. Splitting them is what lets
     * the tracked check render every state without a host or a docker.
     */
    function DockerSurface(props) {
      const model = props.model
      const actions = props.actions
      const engine = model.state !== null && model.state !== undefined ? model.state.engine : null
      const counts = model.state !== null && model.state !== undefined ? model.state.counts : null
      const startable = startableOf(model)
      const filteredContainers = useMemo(() => filterRows(model.containers, model.filter), [model.containers, model.filter])
      const filteredImages = useMemo(() => filterImages(model.images, model.filter), [model.images, model.filter])
      const selected = model.selected
      const selectedRow =
        selected === null
          ? null
          : selected.kind === 'container'
            ? model.containers.find((row) => row.id === selected.id) ?? null
            : model.images.find((row) => row.id === selected.id) ?? null

      const toolbar = h(
        'div',
        { className: 'ddk-tools' },
        h('span', { className: 'ddk-title' }, h(DockerGlyph, { size: 15 }), 'Docker'),
        h('span', { className: 'ddk-dot', 'data-state': model.view === 'ready' ? 'up' : model.view === 'down' ? 'down' : 'absent' }),
        h('span', { className: 'ddk-meta', 'data-docker-engine': model.view }, engine === null ? '' : engineSummary(engine)),
        counts !== null && counts !== undefined ? h('span', { className: 'ddk-meta', 'data-docker-counts': 'true' }, String(counts.running) + '/' + String(counts.containers) + ' up \u00b7 ' + String(counts.images) + ' images') : null,
        h('span', { className: 'ddk-spacer' }),
        startable !== null && startable.canStart === true
          ? h('button', { type: 'button', className: 'ddk-btn ddk-primary', 'data-docker-action': 'start-engine', disabled: model.busy === true, onClick: actions.onStart }, model.busy === true ? 'Starting\u2026' : 'Start ' + startable.label)
          : null,
        h('button', { type: 'button', className: 'ddk-btn', 'data-docker-action': 'disk', title: 'Ask for `docker system df`', onClick: actions.onDisk, disabled: model.busy === true }, h(ActionGlyph, { name: 'disk' })),
        h('button', { type: 'button', className: 'ddk-btn', 'data-docker-action': 'refresh', title: 'Ask the engine again', onClick: actions.onRefresh, disabled: model.busy === true }, h(ActionGlyph, { name: 'refresh' })),
        h('span', { className: 'ddk-ver' }, PLUGIN_VERSION),
      )

      let body = null
      if (model.view === 'loading') {
        body = h('div', { className: 'ddk-empty' }, 'Asking the engine\u2026')
      } else if (model.view === 'absent' || model.view === 'down') {
        const state = model.state
        body = h(
          'div',
          { className: 'ddk-stateBox', 'data-docker-state': model.view },
          h('div', { className: 'ddk-stateTitle' }, model.view === 'absent' ? 'No docker or podman CLI on this machine' : (engine === null || engine === undefined ? 'The engine' : engine.cli) + ' is installed, but its daemon is not answering'),
          h('div', { className: 'ddk-stateNote' }, state !== null && state !== undefined && typeof state.message === 'string' ? state.message : ''),
          startable !== null && startable.canStart === true
            ? h('button', { type: 'button', className: 'ddk-btn ddk-primary', 'data-docker-action': 'start-engine', disabled: model.busy === true, onClick: actions.onStart }, model.busy === true ? 'Starting\u2026' : 'Start ' + startable.label)
            : startable !== null && startable.hint !== ''
              ? h('div', { className: 'ddk-stateNote' }, startable.hint)
              : null,
          h('button', { type: 'button', className: 'ddk-btn', 'data-docker-action': 'refresh', onClick: actions.onRefresh, disabled: model.busy === true }, 'Check again'),
        )
      } else if (model.view === 'ready') {
        body = h(
          React.Fragment,
          null,
          model.filter !== '' || filteredContainers.length !== model.containers.length
            ? h('div', { className: 'ddk-note' }, 'Showing ' + String(filteredContainers.length) + ' of ' + String(model.containers.length) + ' containers.')
            : null,
          h(
            'section',
            { className: 'ddk-section', 'data-docker-section': 'containers' },
            h(
              'div',
              { className: 'ddk-sectionHead' },
              h('span', { className: 'ddk-sectionTitle' }, 'Containers'),
              h('span', { className: 'ddk-count', 'data-docker-count': 'containers' }, String(model.containers.length)),
              h('span', { className: 'ddk-spacer' }),
              h('input', { className: 'ddk-filter', value: model.filter, placeholder: 'Filter containers and images', 'aria-label': 'Filter containers and images', onChange: (event) => actions.onFilter(event.target.value) }),
            ),
            model.containers.length === 0
              ? h('div', { className: 'ddk-empty' }, 'No containers. Pull an image, then start one \u2014 or ask the agent to `docker_run` one with a command, environment and volumes.')
              : h(
                  'div',
                  { className: 'ddk-rows' },
                  filteredContainers.map((row) =>
                    h(React.Fragment, { key: 'c-' + row.id }, [
                      h(ContainerRow, {
                        key: 'row',
                        row: row,
                        open: selected !== null && selected.kind === 'container' && selected.id === row.id,
                        busy: model.busy,
                        confirm: model.confirm,
                        onOpen: () => actions.onSelect('container', row.id),
                        onAction: actions.onAction,
                        onAskRemove: (id) => actions.onAskRemove('container', id),
                        onCancel: actions.onCancelRemove,
                      }),
                      selected !== null && selected.kind === 'container' && selected.id === row.id
                        ? h(Drawer, { key: 'drawer', drawer: model.drawer, onClose: actions.onCloseDrawer, onReloadLogs: () => actions.onSelect('container', row.id, true) })
                        : null,
                    ]),
                  ),
                ),
          ),
          h(
            'section',
            { className: 'ddk-section', 'data-docker-section': 'images' },
            h(
              'div',
              { className: 'ddk-sectionHead' },
              h('span', { className: 'ddk-sectionTitle' }, 'Images'),
              h('span', { className: 'ddk-count', 'data-docker-count': 'images' }, String(model.images.length)),
              h('span', { className: 'ddk-spacer' }),
              h('button', { type: 'button', className: 'ddk-btn', 'data-docker-action': 'pull-form', onClick: actions.onPullForm, disabled: model.busy === true || model.form !== null }, h(ActionGlyph, { name: 'pull' }), 'Pull'),
              h('button', { type: 'button', className: 'ddk-btn', 'data-docker-action': 'run-form', onClick: () => actions.onRunForm(''), disabled: model.busy === true || model.form !== null }, h(ActionGlyph, { name: 'run' }), 'Start'),
            ),
            model.form === 'pull' ? h(PullForm, { busy: model.busy, onCancel: actions.onCloseForm, onSubmit: actions.onPull }) : null,
            model.form === 'run' ? h(RunForm, { image: model.formImage, busy: model.busy, onCancel: actions.onCloseForm, onSubmit: actions.onRun }) : null,
            model.images.length === 0
              ? h('div', { className: 'ddk-empty' }, 'No images. Pull one with the button above, or ask the agent to `docker_pull`.')
              : h(
                  'div',
                  { className: 'ddk-rows' },
                  filteredImages.map((row) =>
                    h(React.Fragment, { key: 'i-' + row.id }, [
                      h(ImageRow, {
                        key: 'row',
                        row: row,
                        open: selected !== null && selected.kind === 'image' && selected.id === row.id,
                        busy: model.busy,
                        confirm: model.confirm,
                        onOpen: () => actions.onSelect('image', row.id),
                        onAction: actions.onAction,
                        onAskRemove: (id) => actions.onAskRemove('image', id),
                        onCancel: actions.onCancelRemove,
                        onRun: (imageRow) => actions.onRunForm(imageLabel(imageRow)),
                      }),
                      selected !== null && selected.kind === 'image' && selected.id === row.id
                        ? h(Drawer, { key: 'drawer', drawer: model.drawer, onClose: actions.onCloseDrawer, onReloadLogs: () => {} })
                        : null,
                    ]),
                  ),
                ),
          ),
          Array.isArray(model.state.disk) && model.state.disk.length > 0
            ? h(
                'section',
                { className: 'ddk-section', 'data-docker-section': 'disk' },
                h('div', { className: 'ddk-sectionHead' }, h('span', { className: 'ddk-sectionTitle' }, 'Disk'), h('span', { className: 'ddk-spacer' })),
                h('div', { className: 'ddk-facts' }, model.state.disk.map((row) => h(FactRow, { key: 'd-' + row.type, label: row.type, value: row.total + ' total \u00b7 ' + row.size + ' \u00b7 ' + row.reclaimable + ' reclaimable' }))),
              )
            : null,
        )
      } else {
        body = h('div', { className: 'ddk-stateBox ddk-warn', 'data-docker-state': 'error' }, model.error === '' ? 'The host did not answer.' : model.error)
      }

      return h(
        'div',
        { className: 'ddk-root', 'data-docker-tab': 'docker', 'data-docker-phase': model.view },
        toolbar,
        model.error !== '' && model.view !== 'error' ? h('div', { className: 'ddk-warn', 'data-docker-error': 'true' }, model.error) : null,
        model.notice !== '' ? h('div', { className: 'ddk-notice', 'data-docker-notice': 'true' }, model.notice) : null,
        h('div', { className: 'ddk-body' }, body),
      )
    }

    /** The container filter: name, image and state, case-insensitive. */
    function filterRows(rows, text) {
      const needle = String(text === undefined || text === null ? '' : text).trim().toLowerCase()
      if (needle === '') return Array.isArray(rows) ? rows : []
      return (Array.isArray(rows) ? rows : []).filter(
        (row) =>
          String(row.name === undefined ? '' : row.name).toLowerCase().includes(needle) ||
          String(row.image === undefined ? '' : row.image).toLowerCase().includes(needle) ||
          String(row.state === undefined ? '' : row.state).toLowerCase().includes(needle),
      )
    }

    /** The image filter: the reference. */
    function filterImages(rows, text) {
      const needle = String(text === undefined || text === null ? '' : text).trim().toLowerCase()
      if (needle === '') return Array.isArray(rows) ? rows : []
      return (Array.isArray(rows) ? rows : []).filter((row) => imageLabel(row).toLowerCase().includes(needle))
    }

    // ---------------------------------------------------------------------
    // The tab body: state, the poll, and the calls
    // ---------------------------------------------------------------------
    /**
     * The live tab.
     *
     * Every request carries a TOKEN (`useRef`), not an effect cleanup: an answer
     * is applied only while it is still the newest one, which is what keeps a
     * slow `ps` from overwriting a fresh start. The poll runs only while this tab
     * is mounted and the document is visible - a hidden tab must not spawn a
     * docker process every five seconds.
     */
    function DockerView() {
      const [state, setState] = useState(null)
      const [view, setView] = useState('loading')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [filter, setFilter] = useState('')
      const [selected, setSelected] = useState(null)
      const [drawer, setDrawer] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [form, setForm] = useState(null)
      const [formImage, setFormImage] = useState('')
      const token = useRef(0)
      const visible = useRef(true)
      // A `system df` the person asked for stays in every later answer: the poll
      // must not silently drop the section five seconds after it appeared.
      const diskWanted = useRef(false)

      const apply = useCallback((answer) => {
        if (answer === null || answer === undefined) {
          setView('error')
          setError('The host answered nothing.')
          return
        }
        if (answer.ok === true) {
          setState(answer)
          setView('ready')
          setError('')
          return
        }
        const code = answer.code === undefined ? 'FAILED' : String(answer.code)
        setState(answer)
        setError(typeof answer.message === 'string' ? answer.message : '')
        setView(code === 'NO_CLI' ? 'absent' : 'down')
      }, [])

      const load = useCallback(
        async (disk) => {
          token.current += 1
          const mine = token.current
          try {
            const answer = await fetchJson(STATE_ROUTE + (disk === true ? '?disk=1' : ''))
            if (mine === token.current) apply(answer)
          } catch (err) {
            if (mine === token.current) {
              setView('error')
              setError(err && err.message ? String(err.message) : 'The request failed.')
            }
          }
        },
        [apply],
      )

      /** Every reload asks for what the person last asked for, and nothing more. */
      const reload = useCallback(async () => load(diskWanted.current), [load])

      const refresh = useCallback(async () => {
        setBusy(true)
        setNotice('')
        await reload()
        setBusy(false)
      }, [reload])

      const askDisk = useCallback(async () => {
        diskWanted.current = true
        setBusy(true)
        setNotice('')
        await load(true)
        setBusy(false)
      }, [load])

      const start = useCallback(async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const answer = await postJson(START_ROUTE, { waitSeconds: 90 })
          if (answer.ok === true) {
            setNotice(answer.already === true ? 'The engine was already up.' : 'The engine answered. Reloading what it holds\u2026')
            await reload()
          } else {
            setError(typeof answer.message === 'string' && answer.message !== '' ? answer.message : 'The engine could not be started.')
          }
        } catch (err) {
          setError(err && err.message ? String(err.message) : 'The start request failed.')
        }
        setBusy(false)
      }, [reload])

      const openDrawer = useCallback(async (kind, id) => {
        setSelected({ kind: kind, id: id })
        setDrawer({ kind: kind, id: id, phase: 'loading', facts: null, logs: '', error: '' })
        const mine = ++token.current
        try {
          const factsAnswer = await fetchJson(INSPECT_ROUTE + '?id=' + encodeURIComponent(id) + '&kind=' + encodeURIComponent(kind))
          if (mine !== token.current) return
          if (factsAnswer.ok !== true) {
            setDrawer({ kind: kind, id: id, phase: 'failed', facts: null, logs: '', error: factsAnswer.error ? factsAnswer.error.message : 'The engine did not describe it.' })
            return
          }
          let logs = ''
          if (kind === 'container') {
            const logsAnswer = await fetchJson(LOGS_ROUTE + '?id=' + encodeURIComponent(id) + '&tail=' + String(LOG_TAIL))
            if (mine !== token.current) return
            logs = logsAnswer.ok === true && typeof logsAnswer.text === 'string' ? logsAnswer.text : logsAnswer.error ? '[' + logsAnswer.error.message + ']' : ''
          }
          setDrawer({ kind: kind, id: id, phase: 'ready', facts: factsAnswer.facts, logs: logs, error: '' })
        } catch (err) {
          if (mine === token.current) setDrawer({ kind: kind, id: id, phase: 'failed', facts: null, logs: '', error: err && err.message ? String(err.message) : 'The request failed.' })
        }
      }, [])

      const select = useCallback(
        (kind, id, force) => {
          if (force !== true && selected !== null && selected.kind === kind && selected.id === id) {
            setSelected(null)
            setDrawer(null)
            return
          }
          openDrawer(kind, id)
        },
        [openDrawer, selected],
      )

      const closeDrawer = useCallback(() => {
        setSelected(null)
        setDrawer(null)
      }, [])

      const askRemove = useCallback((kind, id) => setConfirm({ kind: kind, id: id }), [])
      const cancelRemove = useCallback(() => setConfirm(null), [])

      const act = useCallback(
        async (action, kind, id, confirmId) => {
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const answer = await postJson(ACTION_ROUTE, { action: action, kind: kind, id: id, confirm: confirmId })
            if (answer.ok === true) {
              setNotice(String(answer.action) + ' ' + String(answer.kind) + ' \u00b7 ' + (typeof answer.text === 'string' && answer.text !== '' ? answer.text : 'done'))
              setConfirm(null)
              await reload()
            } else {
              setError(answer.error ? answer.error.message : 'The engine refused.')
            }
          } catch (err) {
            setError(err && err.message ? String(err.message) : 'The request failed.')
          }
          setBusy(false)
        },
        [reload],
      )

      const pull = useCallback(
        async (image) => {
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const answer = await postJson(PULL_ROUTE, { image: image })
            if (answer.ok === true) {
              setNotice('Pulled ' + answer.image + '.')
              setForm(null)
              await reload()
            } else {
              setError(answer.error ? answer.error.message : 'The pull failed.')
            }
          } catch (err) {
            setError(err && err.message ? String(err.message) : 'The pull request failed.')
          }
          setBusy(false)
        },
        [reload],
      )

      const run = useCallback(
        async (spec) => {
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const answer = await postJson(RUN_ROUTE, spec)
            if (answer.ok === true) {
              setNotice(typeof answer.text === 'string' ? answer.text : 'Started.')
              setForm(null)
              await reload()
            } else {
              setError(answer.error ? answer.error.message : 'The container was not started.')
            }
          } catch (err) {
            setError(err && err.message ? String(err.message) : 'The run request failed.')
          }
          setBusy(false)
        },
        [reload],
      )

      useEffect(() => {
        load(false)
      }, [load])

      useEffect(() => {
        const onVisibility = () => {
          visible.current = document.visibilityState !== 'hidden'
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

      useEffect(() => {
        if (view !== 'ready') return undefined
        const timer = setInterval(() => {
          if (visible.current === false || busy === true) return
          load(diskWanted.current)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [view, busy, load])

      const model = {
        view: view,
        state: state,
        containers: state !== null && Array.isArray(state.containers) ? state.containers : [],
        images: state !== null && Array.isArray(state.images) ? state.images : [],
        selected: selected,
        drawer: drawer,
        confirm: confirm,
        busy: busy,
        notice: notice,
        error: error,
        filter: filter,
        form: form,
        formImage: formImage,
      }
      const actions = {
        onRefresh: refresh,
        onDisk: askDisk,
        onStart: start,
        onFilter: setFilter,
        onSelect: select,
        onCloseDrawer: closeDrawer,
        onAskRemove: askRemove,
        onCancelRemove: cancelRemove,
        onAction: act,
        onPullForm: () => setForm('pull'),
        onRunForm: (image) => {
          setFormImage(image === undefined ? '' : image)
          setForm('run')
        },
        onCloseForm: () => setForm(null),
        onPull: pull,
        onRun: run,
      }
      return h(DockerSurface, { model: model, actions: actions })
    }

    /** The tab strip's label for this kind (the guide entry names the same word). */
    function DockerTitle() {
      return h('span', null, 'Docker')
    }

    // ---------------------------------------------------------------------
    // Registry definition
    // ---------------------------------------------------------------------
    function dockerDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        // A PAGE type: no `patterns`, so it never claims a file address.
        priority: 'builtin',
        title: () => 'Docker',
        guide: [
          {
            order: 40,
            title: () => 'Docker',
            description: () => 'This machine\u2019s containers and images: start, stop, logs, pull',
            icon: DockerGlyph,
          },
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services the activation waits for: the slot registry and the bar's tab registry. */
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(dockerDefinition()), 'dsh-docker: docker tab type')
        ctx.effect(
          () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID }, DockerView)),
          'dsh-docker: docker tab body',
        )
        ctx.effect(
          () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, DockerTitle)),
          'dsh-docker: docker tab title',
        )
        ctx.logger?.debug?.('[dsh-docker] docker tab type registered (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-docker] activation failed', err)
        ctx.logger?.warn?.('[dsh-docker] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-docker'
    exports.inject = inject
    exports.apply = apply
    /**
     * The pure half, for the tracked check: the words, the filters, the row's
     * action list and the presentational surface, so every state - absent, down,
     * up, selected, confirming - can be rendered without a browser, a route or a
     * docker on the machine.
     */
    exports.__internals = {
      TYPE_ID: TYPE_ID,
      KIND: KIND,
      PLUGIN_VERSION: PLUGIN_VERSION,
      API_ROOT: API_ROOT,
      STATE_ROUTE: STATE_ROUTE,
      POLL_MS: POLL_MS,
      engineSummary: engineSummary,
      stateWord: stateWord,
      rowActions: rowActions,
      startableOf: startableOf,
      portsLabel: portsLabel,
      imageLabel: imageLabel,
      splitPorts: splitPorts,
      filterRows: filterRows,
      filterImages: filterImages,
      factsOf: factsOf,
      DockerSurface: DockerSurface,
      DockerView: DockerView,
      DockerTitle: DockerTitle,
      dockerDefinition: dockerDefinition,
    }
    return module.exports
  },
})
