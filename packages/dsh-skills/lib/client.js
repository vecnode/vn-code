/**
 * dsh-skills — browser half.
 *
 * ONE header control and ONE modal.
 *
 * The control registers into `conversation.session.header.utilities` at
 * `order: -50`. That list renders in ASCENDING order, and this pack's own
 * occupants are the page-zoom control at -40, capture at -30, themes at -20 and
 * the session-log download seat (the shipped Open In... id, priority -10), so
 * -50 puts this button immediately LEFT of the zoom control - which is where it
 * was asked to be, and the further-left seat is free because nothing else
 * registers below -40.
 *
 * The modal is the pack's shared dialog surface (`modals`, from dsh-modal),
 * opened in its RICH form: `content` is a render function that owns the whole
 * body, for a dialog that is a browser rather than a question. It is resolved
 * LAZILY through `ctx.get('modals')` and its absence is a sentence rather than a
 * crash, so a profile that installed this bundle without dsh-modal still loads -
 * the control simply says what is missing when it is clicked.
 *
 * WHAT THE MODAL SHOWS, and why it is faithful: the catalog comes from this
 * plugin's own `/api/dsh-skills/list`, which reads the HOST's skill registry -
 * the same `ctx.skills` the system prompt's catalog and the `skill` tool read.
 * One row per WINNING skill (a name shadowed by a higher-ranked copy is one
 * entry, and the entry names the copy that won), with its source bucket, the
 * provider that owns it, whether the model and the user may invoke it, and the
 * absolute file behind it.
 *
 * EDITING is inline: clicking a skill shows its markdown, frontmatter included,
 * and Edit swaps in a textarea whose Save goes back through the host route. The
 * client NEVER names a path - it names a skill, and the host writes the file the
 * registry itself resolved, with an mtime/size guard so a save cannot clobber a
 * concurrent edit by the agent. A skill registered at runtime WITHOUT a file is
 * shown from its loaded text and is honestly read-only: there is nothing to
 * write, and the modal says why instead of offering a button that cannot work.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, URL, URLSearchParams, navigator, console, requestAnimationFrame */
window.__ModuleLoader__.load({
  id: 'dsh-skills',
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
    /** Version marker, logged at activation; must equal package.json's version. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-skills'
    const LIST_ROUTE = API_ROOT + '/list'
    const BODY_ROUTE = API_ROOT + '/body'
    const SAVE_ROUTE = API_ROOT + '/save'
    /** The header utilities list, and this occupant's seat in it. */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    const HEADER_ID = 'dsh-skills'
    const HEADER_ORDER = -50
    /** The pack's shared dialog surface, resolved lazily and never injected. */
    const MODAL_SERVICE = 'modals'
    /**
     * The source buckets, in the order the panel reads them: the project's own
     * skills first (they are the ones a conversation can shadow), then the
     * person's, then whatever a package or a plugin contributed. The registry's
     * own bucket names are the keys; an unknown one is shown as itself.
     */
    const SOURCE_ORDER = ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled', 'runtime']
    const SOURCE_LABELS = {
      'project-dsh': 'Project \u00b7 .dsh/skills',
      'project-agents': 'Project \u00b7 .agents/skills',
      custom: 'Custom root',
      'user-dsh': 'Your skills',
      'user-agents': 'Your skills \u00b7 .agents',
      bundled: 'Bundled with a package',
      runtime: 'Registered at runtime',
    }
    /** What a `reload` verdict means, in a sentence, when a save reports one. */
    const RELOAD_NOTES = {
      restart: 'This skill is registered at runtime, so the harness reads the file again when it starts \u2014 restart to load the new text.',
      live: 'A file-backed skill: the catalog picks this up on its own, and the next listing is already the new text.',
    }

    // ---------------------------------------------------------------------
    // Styles (this package's own prefix, every colour a design token)
    // ---------------------------------------------------------------------
    const css = `
.dsk-button{width:28px;height:28px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.dsk-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsk-button:disabled{cursor:default;opacity:.5}
.dsk-button:focus-visible{outline:.5px solid var(--dsw-alias-state-accent,#4f8cff);outline-offset:1px}
.dsk-slot{display:inline-flex;align-items:center}
.dsk-root{flex:1;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#ececec);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5}
.dsk-bar{flex:none;height:46px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 12px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22))}
.dsk-barTitle{font-size:14px;font-weight:600;white-space:nowrap}
.dsk-count{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f);white-space:nowrap}
.dsk-search{flex:1;min-width:80px;max-width:320px;height:26px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-primary,#ececec);font:inherit;font-size:12.5px;outline:none}
.dsk-search:focus{border-color:var(--dsw-alias-state-accent,#4f8cff)}
.dsk-spacer{flex:1}
.dsk-btn{box-sizing:border-box;height:26px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#ececec);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsk-btn:disabled{opacity:.45;cursor:default}
.dsk-btn.dsk-primary{border-color:transparent;background:var(--dsw-alias-state-accent,#4f8cff);color:#fff;font-weight:500}
.dsk-btn.dsk-primary:hover:not(:disabled){filter:brightness(1.08)}
.dsk-body{flex:1;min-height:0;display:flex}
.dsk-list{flex:none;width:308px;min-width:0;overflow:auto;padding:6px 0 10px;border-right:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22))}
.dsk-group{position:sticky;top:0;z-index:1;padding:8px 14px 4px;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8f8f8f);background:var(--dsw-alias-bg-layer-2,#242424)}
.dsk-row{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;padding:7px 12px 7px 14px;border:0;border-left:2px solid transparent;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsk-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsk-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));border-left-color:var(--dsw-alias-state-accent,#4f8cff)}
.dsk-rowName{font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.dsk-rowDesc{font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary,#b8b8b8);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsk-rowMeta{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsk-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.dsk-pane{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.dsk-docBar{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22))}
.dsk-docTop{display:flex;align-items:center;gap:8px;min-width:0}
.dsk-docName{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsk-badge{flex:none;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));font-size:10.5px;color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap}
.dsk-badge[data-tone="user"]{color:var(--dsw-alias-state-warning-primary,#d9a441);border-color:currentColor}
.dsk-badge[data-tone="model"]{color:var(--dsw-alias-state-accent,#4f8cff);border-color:currentColor}
.dsk-path{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f8f8f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsk-status{flex:none;padding:0 16px}
.dsk-msg{margin:8px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}
.dsk-msg[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsk-msg[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#3fa46a)}
.dsk-doc{flex:1;min-height:0;overflow:auto;padding:12px 16px 18px}
.dsk-md{margin:0;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12.5px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#ececec)}
.dsk-editor{width:100%;height:100%;min-height:0;box-sizing:border-box;resize:none;padding:12px 16px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#ececec);font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12.5px;line-height:1.65;tab-size:2}
.dsk-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:12.5px;text-align:center}
.dsk-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0}
`
    const CSS_TAG = 'dsh-skills/skills.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-skills'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------
    let pluginCtx = null

    /** Resolve one client service, or undefined when it is not mounted. */
    function serviceNow(serviceName) {
      const ctx = pluginCtx
      if (ctx === null || typeof ctx.get !== 'function') return undefined
      try {
        return ctx.get(serviceName)
      } catch (err) {
        return undefined
      }
    }

    function messageOf(error) {
      if (error === null || error === undefined) return 'Something went wrong.'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    /** One JSON request against this plugin's own routes, with typed failures. */
    async function requestJson(route, options) {
      let response
      try {
        response = await fetch(route, { credentials: 'same-origin', ...options })
      } catch (err) {
        throw new Error('The harness could not be reached: ' + messageOf(err))
      }
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        const message = body !== null && body.error !== undefined && typeof body.error.message === 'string' ? body.error.message : 'HTTP ' + String(response.status)
        const failure = new Error(message)
        failure.status = response.status
        failure.body = body
        throw failure
      }
      return body
    }

    /** The label a source bucket wears; an unknown bucket is shown as itself. */
    function sourceLabel(source) {
      return SOURCE_LABELS[source] !== undefined ? SOURCE_LABELS[source] : String(source)
    }

    /** The grouping key of one entry: its bucket, with an unknown one kept apart. */
    function groupKeyOf(entry) {
      return SOURCE_ORDER.indexOf(entry.source) === -1 ? 'other' : entry.source
    }

    /** One row's subtitle: where it comes from and whether it is file-backed. */
    function metaOf(entry) {
      const parts = []
      if (entry.provider !== '') parts.push(entry.provider)
      if (entry.kind === 'bundle') parts.push('SKILL.md folder')
      else if (entry.kind === 'file') parts.push('single .md')
      else parts.push('no file')
      if (entry.bytes !== null && entry.bytes !== undefined) parts.push(formatBytes(entry.bytes))
      return parts.join(' \u00b7 ')
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return String(bytes) + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    // ---------------------------------------------------------------------
    // The header glyph: an open book (the shipped primitive set has no "skill"
    // icon, the same reason the zoom and terminal glyphs are drawn in place).
    // ---------------------------------------------------------------------
    function SkillsGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 15
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M8 3.6C6.9 2.7 5.4 2.3 3.2 2.3v9.4c2.2 0 3.7.4 4.8 1.3' }),
        h('path', { d: 'M8 3.6c1.1-.9 2.6-1.3 4.8-1.3v9.4c-2.2 0-3.7.4-4.8 1.3' }),
        h('path', { d: 'M8 3.6V13' }),
      )
    }

    // ---------------------------------------------------------------------
    // The modal body: the browser itself
    // ---------------------------------------------------------------------
    /**
     * The Skills browser.
     *
     * @param props - `{ sessionId, close }`. `sessionId` is the conversation the
     *   header belongs to (the host resolves its project folder from it) and
     *   `close` settles the dialog dsh-modal opened.
     */
    function SkillsBrowser(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const close = typeof props.close === 'function' ? props.close : () => {}
      const [catalog, setCatalog] = useState({ phase: 'loading', data: null, error: '' })
      const [selected, setSelected] = useState(null)
      const [doc, setDoc] = useState({ phase: 'idle', data: null, error: '' })
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [query, setQuery] = useState('')
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      // One token per selection: the answer of a load that has been superseded
      // must never replace the document the reader is looking at.
      const loadTokenRef = useRef(0)

      const loadCatalog = useCallback(
        async (fresh) => {
          setCatalog((previous) => ({ phase: previous.data === null ? 'loading' : 'ready', data: previous.data, error: '' }))
          const params = new URLSearchParams()
          if (sessionId !== '') params.set('session', sessionId)
          if (fresh === true) params.set('fresh', '1')
          try {
            const data = await requestJson(LIST_ROUTE + '?' + params.toString(), { method: 'GET' })
            setCatalog({ phase: 'ready', data, error: '' })
            return data
          } catch (err) {
            setCatalog({ phase: 'error', data: null, error: messageOf(err) })
            return null
          }
        },
        [sessionId],
      )

      useEffect(() => {
        loadCatalog(false)
      }, [loadCatalog])

      /**
       * Load ONE skill's document into the pane.
       *
       * Separate from `openSkill` because a SAVE has to reload the document
       * without wiping the "Saved" line it just set: the reader needs the new
       * mtime (a second save with the old one would be refused as a conflict)
       * and needs to keep the verdict on screen.
       */
      const loadBody = useCallback(
        async (name) => {
          loadTokenRef.current += 1
          const token = loadTokenRef.current
          setDoc({ phase: 'loading', data: null, error: '' })
          const params = new URLSearchParams()
          if (sessionId !== '') params.set('session', sessionId)
          params.set('name', name)
          try {
            const data = await requestJson(BODY_ROUTE + '?' + params.toString(), { method: 'GET' })
            if (loadTokenRef.current !== token) return
            setDoc({ phase: 'ready', data, error: '' })
          } catch (err) {
            if (loadTokenRef.current !== token) return
            setDoc({ phase: 'error', data: null, error: messageOf(err) })
          }
        },
        [sessionId],
      )

      const openSkill = useCallback(
        async (name) => {
          setSelected(name)
          setDraft(null)
          setStatus(null)
          setPending(null)
          await loadBody(name)
        },
        [loadBody],
      )

      /** Selecting another skill while editing asks first, inline. */
      const choose = useCallback(
        (name) => {
          if (draft !== null) {
            setPending(name)
            return
          }
          openSkill(name)
        },
        [draft, openSkill],
      )

      const save = useCallback(async () => {
        if (draft === null || doc.data === null) return
        setBusy(true)
        setStatus(null)
        try {
          const payload = {
            session: sessionId,
            name: doc.data.name,
            text: draft,
            expected: { mtimeMs: doc.data.mtimeMs, size: doc.data.size },
          }
          const answer = await requestJson(SAVE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          setBusy(false)
          setDraft(null)
          const warned = typeof answer.warning === 'string' && answer.warning !== ''
          const note = warned ? answer.warning : RELOAD_NOTES[answer.reload] !== undefined ? RELOAD_NOTES[answer.reload] : ''
          setStatus({ tone: warned ? 'error' : 'ok', message: 'Saved ' + String(answer.path) + '. ' + note })
          const name = typeof answer.name === 'string' && answer.name !== '' ? answer.name : doc.data.name
          // The catalog is re-read FRESH (the row's description, path and byte
          // count can all have changed) and the body reloaded under the name the
          // save reported, which differs from the one that was sent only when the
          // frontmatter renamed the skill.
          await loadCatalog(true)
          setSelected(name)
          await loadBody(name)
        } catch (err) {
          setBusy(false)
          const conflict = err.status === 409
          setStatus({
            tone: 'error',
            message: conflict ? messageOf(err) + ' Your text is still in the editor.' : 'The save failed: ' + messageOf(err),
          })
        }
      }, [draft, doc.data, sessionId, loadCatalog, loadBody])

      const copyPath = useCallback(async () => {
        const target = doc.data !== null && typeof doc.data.path === 'string' ? doc.data.path : ''
        if (target === '') return
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(target)
            setStatus({ tone: 'ok', message: 'Copied ' + target })
            return
          }
        } catch (err) {
          /* fall through to the sentence below */
        }
        setStatus({ tone: 'info', message: target })
      }, [doc.data])

      const entries = catalog.data !== null && Array.isArray(catalog.data.skills) ? catalog.data.skills : []
      const needle = query.trim().toLowerCase()
      const shown = needle === '' ? entries : entries.filter((entry) => {
        const haystack = [entry.name, entry.description, entry.whenToUse, entry.provider, entry.source, entry.path === null ? '' : entry.path].join('\n').toLowerCase()
        return haystack.indexOf(needle) !== -1
      })
      const groups = useMemo(() => {
        const byKey = new Map()
        for (const entry of shown) {
          const key = groupKeyOf(entry)
          if (!byKey.has(key)) byKey.set(key, [])
          byKey.get(key).push(entry)
        }
        return SOURCE_ORDER.concat(['other'])
          .filter((key) => byKey.has(key))
          .map((key) => ({ key, label: key === 'other' ? 'Other' : sourceLabel(key), rows: byKey.get(key) }))
      }, [shown])

      const dirty = draft !== null && doc.data !== null && draft !== doc.data.text

      return h(
        'div',
        { className: 'dsk-root' },
        h(
          'div',
          { className: 'dsk-bar' },
          h('span', { className: 'dsk-barTitle' }, 'Skills'),
          h(
            'span',
            { className: 'dsk-count' },
            entries.length === 0 ? '' : String(shown.length) + ' of ' + String(entries.length),
          ),
          h('input', {
            className: 'dsk-search',
            type: 'search',
            value: query,
            placeholder: 'Filter by name, provider or path\u2026',
            'aria-label': 'Filter skills',
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'dsk-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsk-btn',
              disabled: catalog.phase === 'loading',
              onClick: () => {
                setStatus(null)
                loadCatalog(true)
              },
            },
            'Reload',
          ),
          h('button', { type: 'button', className: 'dsk-btn', onClick: () => close(null) }, 'Close'),
        ),
        catalog.data !== null && typeof catalog.data.warning === 'string' && catalog.data.warning !== ''
          ? h('div', { className: 'dsk-status' }, h('p', { className: 'dsk-msg' }, catalog.data.warning))
          : null,
        h(
          'div',
          { className: 'dsk-body' },
          h(
            'div',
            { className: 'dsk-list', role: 'list' },
            catalog.phase === 'loading' && entries.length === 0 ? h('div', { className: 'dsk-empty' }, 'Reading the skill catalog\u2026') : null,
            catalog.phase === 'error' ? h('div', { className: 'dsk-empty' }, catalog.error) : null,
            catalog.phase === 'ready' && entries.length === 0 ? h('div', { className: 'dsk-empty' }, 'This conversation has no skills.') : null,
            shown.length === 0 && entries.length > 0 ? h('div', { className: 'dsk-empty' }, 'Nothing matches that filter.') : null,
            groups.map((group) =>
              h(
                'div',
                { key: group.key },
                h('div', { className: 'dsk-group' }, group.label + ' \u00b7 ' + String(group.rows.length)),
                group.rows.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.name,
                      type: 'button',
                      className: 'dsk-row',
                      role: 'listitem',
                      'data-skill': entry.name,
                      'data-active': selected === entry.name ? 'true' : undefined,
                      onClick: () => choose(entry.name),
                    },
                    h('span', { className: 'dsk-rowName' }, entry.name),
                    entry.description === '' ? null : h('span', { className: 'dsk-rowDesc' }, entry.description),
                    h(
                      'span',
                      { className: 'dsk-rowMeta' },
                      h('span', { className: 'dsk-dot', 'aria-hidden': 'true' }),
                      h('span', null, metaOf(entry)),
                    ),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsk-pane' },
            selected === null
              ? h(
                  'div',
                  { className: 'dsk-empty' },
                  'Pick a skill to read it. Skills are the documents the model is given at the start of a chat, and the ones it can load on demand \u2014 this list is the catalog for THIS conversation, in the order the registry resolved it.',
                )
              : null,
            selected !== null
              ? h(
                  'div',
                  { className: 'dsk-docBar' },
                  h(
                    'div',
                    { className: 'dsk-docTop' },
                    h('span', { className: 'dsk-docName' }, doc.data !== null ? doc.data.name : selected),
                    doc.data !== null ? h('span', { className: 'dsk-badge' }, sourceLabel(doc.data.source)) : null,
                    doc.data !== null && doc.data.runtime ? h('span', { className: 'dsk-badge' }, 'in memory') : null,
                    doc.data !== null && doc.data.modelInvocable === false
                      ? h('span', { className: 'dsk-badge', 'data-tone': 'user' }, 'user-only')
                      : null,
                    doc.data !== null && doc.data.editable === false ? h('span', { className: 'dsk-badge' }, 'read-only') : null,
                    dirty ? h('span', { className: 'dsk-badge', 'data-tone': 'model' }, 'unsaved') : null,
                    h('span', { className: 'dsk-spacer' }),
                    doc.data !== null && doc.data.editable
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsk-btn',
                            disabled: busy,
                            onClick: () => {
                              setStatus(null)
                              if (draft === null) setDraft(doc.data.text)
                              else setDraft(null)
                            },
                          },
                          draft === null ? 'Edit' : 'Stop editing',
                        )
                      : null,
                    doc.data !== null && doc.data.editable
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsk-btn dsk-primary',
                            disabled: busy || !dirty,
                            onClick: save,
                          },
                          busy ? 'Saving\u2026' : 'Save',
                        )
                      : null,
                    doc.data !== null && doc.data.editable && dirty
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsk-btn',
                            disabled: busy,
                            onClick: () => {
                              setDraft(doc.data.text)
                              setStatus(null)
                            },
                          },
                          'Revert',
                        )
                      : null,
                    doc.data !== null && typeof doc.data.path === 'string' && doc.data.path !== ''
                      ? h('button', { type: 'button', className: 'dsk-btn', onClick: copyPath }, 'Copy path')
                      : null,
                  ),
                  doc.data !== null
                    ? h(
                        'span',
                        { className: 'dsk-path', title: doc.data.path === null ? '' : String(doc.data.path) },
                        doc.data.path === null
                          ? 'registered at runtime by ' + String(doc.data.provider) + ' \u2014 no file to edit'
                          : String(doc.data.path) + (doc.data.size === null ? '' : ' \u00b7 ' + formatBytes(doc.data.size)),
                      )
                    : null,
                  pending !== null
                    ? h(
                        'div',
                        { className: 'dsk-ask' },
                        h('span', { className: 'dsk-msg' }, 'You have unsaved changes.'),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsk-btn',
                            onClick: () => {
                              const target = pending
                              setPending(null)
                              setDraft(null)
                              openSkill(target)
                            },
                          },
                          'Discard and open ' + pending,
                        ),
                        h('button', { type: 'button', className: 'dsk-btn', onClick: () => setPending(null) }, 'Keep editing'),
                      )
                    : null,
                )
              : null,
            doc.phase === 'loading' ? h('div', { className: 'dsk-status' }, h('p', { className: 'dsk-msg' }, 'Opening\u2026')) : null,
            doc.phase === 'error' ? h('div', { className: 'dsk-status' }, h('p', { className: 'dsk-msg', 'data-tone': 'error' }, doc.error)) : null,
            doc.data !== null && doc.data.notice !== undefined && doc.data.notice !== ''
              ? h('div', { className: 'dsk-status' }, h('p', { className: 'dsk-msg' }, String(doc.data.notice)))
              : null,
            status !== null
              ? h(
                  'div',
                  { className: 'dsk-status' },
                  h('p', { className: 'dsk-msg', 'data-tone': status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'ok' : undefined }, status.message),
                )
              : null,
            doc.data !== null && draft !== null
              ? h(
                  'div',
                  { className: 'dsk-doc' },
                  h('textarea', {
                    className: 'dsk-editor',
                    value: draft,
                    spellCheck: false,
                    autoComplete: 'off',
                    'aria-label': 'Skill markdown',
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      // Tab indents instead of leaving the editor: a Markdown
                      // document with a code block in it is the one place a
                      // person expects Tab to type.
                      if (event.key !== 'Tab') return
                      event.preventDefault()
                      const node = event.target
                      const start = node.selectionStart
                      const end = node.selectionEnd
                      const next = draft.slice(0, start) + '  ' + draft.slice(end)
                      setDraft(next)
                      requestAnimationFrame(() => {
                        try {
                          node.selectionStart = start + 2
                          node.selectionEnd = start + 2
                        } catch (err) {}
                      })
                    },
                  }),
                )
              : doc.data !== null
                ? h('div', { className: 'dsk-doc' }, h('pre', { className: 'dsk-md' }, doc.data.text))
                : h('div', { className: 'dsk-empty' }, ''),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The header control
    // ---------------------------------------------------------------------
    /**
     * The header button: one click opens the browser over the conversation.
     *
     * The dialog is opened through the pack's shared surface, so its mask,
     * Escape handling, focus restore and one-at-a-time queue are the same code
     * every other dialog in the app uses. A profile without dsh-modal gets a
     * sentence rather than an unhandled exception.
     */
    function SkillsAction(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const label = 'Skills'
      return h(
        'div',
        { className: 'dsk-slot' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsk-button',
            'data-dsh-skills': 'button',
            title: label,
            'aria-label': label,
            onClick: () => {
              const modals = serviceNow(MODAL_SERVICE)
              if (modals === undefined || modals === null || typeof modals.open !== 'function') {
                // eslint-disable-next-line no-console
                console.warn('[dsh-skills] the shared dialog surface (dsh-modal) is not mounted in this profile')
                return
              }
              modals.open({
                title: '',
                size: 'lg',
                content: (helpers) => h(SkillsBrowser, { sessionId, close: helpers.close }),
              })
            },
          },
          h(SkillsGlyph, { size: 15 }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services required: the slot registry the header control registers into. */
    const inject = ['slots']

    /**
     * Activate the browser half.
     * @param ctx - cordis context (inject: slots).
     */
    function apply(ctx) {
      pluginCtx = ctx
      try {
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: HEADER_ID,
                  order: HEADER_ORDER,
                  inject: () => ({}),
                },
                SkillsAction,
              ),
            ),
          'dsh-skills: header control',
        )
        ctx.logger?.debug?.('[dsh-skills] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-skills] activation failed', err)
        ctx.logger?.warn?.('[dsh-skills] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-skills'
    exports.inject = inject
    exports.apply = apply
    /** The pure half, so the tracked check can drive it without a browser. */
    exports.__internals = { sourceLabel, groupKeyOf, metaOf, formatBytes, SkillsBrowser, SOURCE_ORDER }
    return module.exports
  },
})
