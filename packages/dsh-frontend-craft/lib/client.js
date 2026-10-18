/**
 * dsh-frontend-craft — browser half.
 *
 * ONE tab, two views, and nothing that pretends to be a design tool:
 *
 *   Findings   what the 61 vendored rules can see in the workspace, by file and
 *              rule, with the rule's own sentence beside each hit. This is the
 *              surface a person checks after the agent says "polished".
 *   Artifacts  PRODUCT.md, DESIGN.md and the surface briefs, with the shape
 *              verdict `fe_artifact` enforces - so a brief missing its direction
 *              contract is visible, not buried in a tool result.
 *
 * It is a CLASSIC SCRIPT registered through `window.__ModuleLoader__.load`, with
 * no build step, requiring only the specifiers a client bundle is allowed:
 * `react` and `dsh-rightbar`. The detector itself is NOT loaded here: the host
 * runs it once and the tab asks over its own routes, so a 4.5 MB wasm module is
 * not paid for per tab.
 */
window.__ModuleLoader__.load({
  id: 'dsh-frontend-craft',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const TYPE_ID = 'dsh-frontend-craft'
    const KIND = 'frontend-craft'
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const API_ROOT = '/api/dsh-frontend-craft'
    const STATE_ROUTE = API_ROOT + '/state'
    const SCAN_ROUTE = API_ROOT + '/scan'
    const ARTIFACTS_ROUTE = API_ROOT + '/artifacts'
    const DIRECTION_ROUTE = API_ROOT + '/direction'
    const RENDER_IMAGE_ROUTE = API_ROOT + '/render-image'

    const css = `
.dfc-root{display:flex;flex-direction:column;height:100%;min-height:0;font:12px/18px var(--dsw-font-ui,ui-sans-serif,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dfc-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dfc-title{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8)}
.dfc-meta{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfc-spacer{flex:1 1 auto}
.dfc-btn{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);border-radius:5px;padding:1px 7px;cursor:pointer;font:inherit;white-space:nowrap}
.dfc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e8e8e8)}
.dfc-btn:disabled{opacity:.5;cursor:default}
.dfc-btn[data-active="true"]{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dfc-input{flex:1 1 auto;min-width:0;background:transparent;border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:5px;color:inherit;font:inherit;padding:2px 6px}
.dfc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dfc-tabs{display:flex;gap:2px;padding:4px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dfc-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 0}
.dfc-empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary,#8f8f8f);white-space:pre-wrap;line-height:19px}
.dfc-counts{display:flex;gap:6px;padding:2px 8px 6px;flex-wrap:wrap}
.dfc-chip{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:999px;padding:0 7px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8f8f8f);cursor:pointer;background:transparent;font:inherit}
.dfc-chip[data-active="true"]{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dfc-file{padding:6px 10px 2px;font-weight:600;color:var(--dsw-alias-label-primary,#d8d8d8);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px}
.dfc-find{padding:3px 10px 5px;border-left:2px solid transparent}
.dfc-find[data-cat="slop"]{border-left-color:#e0a54a}
.dfc-find[data-cat="quality"]{border-left-color:#5b8def}
.dfc-findHead{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.dfc-rule{color:var(--dsw-alias-label-primary,#d8d8d8);font-weight:600}
.dfc-sev{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:11px}
.dfc-desc{color:var(--dsw-alias-label-tertiary,#8f8f8f);line-height:17px}
.dfc-snip{margin-top:2px;padding:2px 6px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.10));border-radius:4px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#c8c8c8)}
.dfc-note{padding:8px 10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);line-height:18px}
.dfc-art{padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.20))}
.dfc-artHead{display:flex;align-items:baseline;gap:8px}
.dfc-artName{font-weight:600;color:var(--dsw-alias-label-primary,#d8d8d8)}
.dfc-ok{color:#5aa469}
.dfc-bad{color:#d46a5f}
.dfc-pre{margin:4px 0 0;padding:6px 8px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.10));border-radius:5px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}
.dfc-cards{display:flex;flex-direction:column;gap:6px;padding:6px 10px}
.dfc-card{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:7px;padding:7px 9px}
.dfc-card[data-assigned="true"]{border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dfc-card[data-chosen="true"]{background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.10))}
.dfc-cardHead{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.dfc-cardName{font-weight:600;color:var(--dsw-alias-label-primary,#d8d8d8)}
.dfc-kicker{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-brand-primary,#4f8cff)}
.dfc-line{margin-top:2px;color:var(--dsw-alias-label-tertiary,#8f8f8f);line-height:17px}
.dfc-actions{display:flex;gap:6px;padding:4px 10px 8px;flex-wrap:wrap}
.dfc-shotWrap{padding:8px 10px}
.dfc-shot{display:block;width:100%;height:auto;border-radius:6px;border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));background:#fff}
.dfc-facts{display:flex;gap:8px;flex-wrap:wrap;padding:2px 10px 6px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums}
`

    const CSS_TAG = 'dsh-frontend-craft/tab.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-frontend-craft'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /** One fetch against this plugin's own routes. */
    async function api(path, init) {
      const answer = await fetch(path, { credentials: 'same-origin', ...(init || {}) })
      const text = await answer.text()
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (err) {
        body = { ok: false, message: 'the route answered something that is not JSON' }
      }
      return { status: answer.status, ok: answer.ok, body }
    }

    function button(label, onClick, extra) {
      return h('button', { type: 'button', className: 'dfc-btn', onClick, ...(extra || {}) }, label)
    }

    function Counts(props) {
      const counts = props.counts || {}
      const chips = [
        ['all', 'total', counts.total ?? 0],
        ['slop', 'slop', counts.slop ?? 0],
        ['quality', 'quality', counts.quality ?? 0],
        ['advisory', 'advisory', counts.advisory ?? 0],
      ]
      return h(
        'div',
        { className: 'dfc-counts' },
        ...chips.map(([key, label, value]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'dfc-chip',
              'data-active': props.filter === key ? 'true' : undefined,
              onClick: () => props.onFilter(key),
            },
            label + ' ' + value,
          ),
        ),
      )
    }

    function Finding(props) {
      const finding = props.finding
      return h(
        'div',
        { className: 'dfc-find', 'data-cat': finding.category || 'quality' },
        h(
          'div',
          { className: 'dfc-findHead' },
          h('span', { className: 'dfc-rule' }, finding.antipattern),
          h('span', { className: 'dfc-sev' }, String(finding.file) + ':' + String(finding.line)),
          finding.advisory ? h('span', { className: 'dfc-sev' }, 'advisory') : null,
        ),
        finding.description ? h('div', { className: 'dfc-desc' }, finding.description) : null,
        finding.snippet ? h('div', { className: 'dfc-snip' }, String(finding.snippet)) : null,
      )
    }

    function Findings(props) {
      const report = props.report
      if (report === null) {
        return h(
          'div',
          { className: 'dfc-empty' },
          'Nothing scanned yet.\n\n' +
            'Scan the workspace (or a folder) and the 61 vendored Impeccable rules report what they can see: AI-slop tells, contrast pairs, type hierarchy, spacing, touch targets and layout mistakes.\n\n' +
            'A finding is evidence, not a verdict: the rules cannot see the rendered page, the copy, or whether the design is good. `fe_detect` gives the agent the same report.',
        )
      }
      if (report.ok === false) return h('div', { className: 'dfc-empty' }, String(report.error || report.message || 'the scan failed'))
      if (report.counts.total === 0) {
        return h(
          'div',
          { className: 'dfc-empty' },
          'No findings in ' + report.files.total + ' files.\n\n' + 'A clean run is evidence, not proof: look at the rendered page at the sizes it ships at before calling it finished.',
        )
      }
      const filtered = report.findings.filter((finding) => {
        if (props.filter === 'all') return true
        if (props.filter === 'advisory') return finding.advisory === true
        return finding.category === props.filter
      })
      const byFile = new Map()
      for (const finding of filtered) {
        if (!byFile.has(finding.file)) byFile.set(finding.file, [])
        byFile.get(finding.file).push(finding)
      }
      return h(
        'div',
        null,
        h(Counts, { counts: report.counts, filter: props.filter, onFilter: props.onFilter }),
        ...[...byFile.entries()].map(([file, findings]) =>
          h('div', { key: file }, h('div', { className: 'dfc-file' }, file + '  (' + findings.length + ')'), ...findings.map((finding, index) => h(Finding, { key: file + ':' + index, finding }))),
        ),
        report.findingsTotal > report.findings.length
          ? h('div', { className: 'dfc-note' }, 'Showing the first ' + report.findings.length + ' of ' + report.findingsTotal + ' findings. Narrow the scan with a folder or a rule list.')
          : null,
      )
    }

    function Artifacts(props) {
      const artifacts = props.artifacts
      if (artifacts === null) return h('div', { className: 'dfc-empty' }, 'The artifacts could not be read for this tab.')
      const sections = []
      if (artifacts.product) sections.push(['PRODUCT.md', artifacts.product, true])
      if (artifacts.design) sections.push(['DESIGN.md', artifacts.design, true])
      for (const brief of artifacts.briefs) sections.push(['.frontend-craft/surfaces/' + brief.slug + '.md', brief, false])
      if (sections.length === 0) {
        return h(
          'div',
          { className: 'dfc-empty' },
          'No artifacts yet.\n\n' +
            'PRODUCT.md is product truth. DESIGN.md is visual truth. A surface brief carries that surface’s strategy and its six-block direction contract. The agent writes them through `fe_artifact`, which validates the shape before it lands.',
        )
      }
      return h(
        'div',
        null,
        ...sections.map(([label, artifact, hasText]) =>
          h(
            'div',
            { className: 'dfc-art', key: label },
            h(
              'div',
              { className: 'dfc-artHead' },
              h('span', { className: 'dfc-artName' }, label),
              artifact.ok ? h('span', { className: 'dfc-ok' }, 'valid') : h('span', { className: 'dfc-bad' }, 'incomplete'),
            ),
            artifact.ok ? null : h('div', { className: 'dfc-desc' }, (artifact.problems || []).join('; ')),
            hasText && artifact.text ? h('pre', { className: 'dfc-pre' }, artifact.text) : null,
          ),
        ),
      )
    }

    /**
     * The direction round: the last hand `fe_direction` dealt, with the assigned
     * card marked and one action per card. The tab RECORDS the pick; it cannot
     * author a direction, because that is the agent's work and the point of the
     * roll. A `reroll` and the standing exit are always offered.
     */
    function Directions(props) {
      const deal = props.deal
      const pick = props.pick
      if (!deal) {
        return h(
          'div',
          { className: 'dfc-empty' },
          'No direction round yet.\n\n' +
            'The agent deals a hand with `fe_direction` action `deal`: the directions it authored, hashed through a seed, one ASSIGNED and three put to you. This panel then shows that hand, and records which one you choose.\n\n' +
            'There is no catalog behind this roll - the challengers are the directions the agent wrote, plus the standing exit.',
        )
      }
      return h(
        'div',
        null,
        h('div', { className: 'dfc-note' }, 'seed ' + deal.seed + ' · ' + deal.mode + ' · ' + deal.scope + (pick ? ' · picked: ' + pick : ' · not picked yet')),
        h(
          'div',
          { className: 'dfc-cards' },
          ...(deal.cards || []).map((card) =>
            h(
              'div',
              {
                key: String(card.position) + card.name,
                className: 'dfc-card',
                'data-assigned': card.name === deal.assigned ? 'true' : undefined,
                'data-chosen': pick === card.name ? 'true' : undefined,
              },
              h(
                'div',
                { className: 'dfc-cardHead' },
                h('span', { className: 'dfc-cardName' }, card.name),
                card.name === deal.assigned ? h('span', { className: 'dfc-kicker' }, 'the roll') : null,
                pick === card.name ? h('span', { className: 'dfc-kicker' }, 'chosen') : null,
              ),
              card.thesis ? h('div', { className: 'dfc-line' }, card.thesis) : null,
              card.risk ? h('div', { className: 'dfc-line' }, 'risk: ' + card.risk) : null,
              h(
                'div',
                { className: 'dfc-actions' },
                h('button', { type: 'button', className: 'dfc-btn', disabled: props.busy, onClick: () => props.onPick(card.name) }, card.name === deal.assigned ? 'Build this' : 'Choose this'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dfc-actions' },
          h('button', { type: 'button', className: 'dfc-btn', disabled: props.busy, onClick: () => props.onPick('canon') }, 'The category standard'),
          h('button', { type: 'button', className: 'dfc-btn', disabled: props.busy, onClick: () => props.onPick('reroll') }, 'Re-roll'),
        ),
      )
    }

    /**
     * The render: the picture the host actually produced, at one viewport, plus
     * the MEASURED findings (`render-*`). A render is a host artifact, so the
     * image comes from this plugin's own route, not from a data URL.
     */
    function Preview(props) {
      const render = props.render
      const [width, setWidth] = React.useState(null)
      if (!render || !Array.isArray(render.viewports) || render.viewports.length === 0) {
        return h(
          'div',
          { className: 'dfc-empty' },
          'No render yet.\n\n' +
            '`fe_render` renders an HTML file in the workspace, or a loopback dev-server URL, in a throwaway headless browser and measures what only pixels show: contrast, touch targets, overflow, line length, type size, heading order, missing alt.\n\n' +
            'It needs Chrome or Edge on this machine; the 61 source rules run without one.',
        )
      }
      const active = render.viewports.find((entry) => entry.width === width) ?? render.viewports[0]
      const findings = Array.isArray(active.findings) ? active.findings : []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dfc-facts' },
          h('span', {}, active.label + ' ' + active.width + '×' + active.height),
          h('span', {}, findings.length + ' measured'),
          active.size ? h('span', {}, active.size.width + '×' + active.size.height + ' px') : null,
          h('span', {}, String(render.url)),
        ),
        render.viewports.length > 1
          ? h(
              'div',
              { className: 'dfc-actions' },
              ...render.viewports.map((entry) =>
                h('button', { key: entry.width, type: 'button', className: 'dfc-btn', 'data-active': entry.width === active.width ? 'true' : undefined, onClick: () => setWidth(entry.width) }, entry.label + ' ' + entry.width),
              ),
            )
          : null,
        h('div', { className: 'dfc-shotWrap' }, h('img', { className: 'dfc-shot', alt: 'Rendered ' + String(render.url), src: RENDER_IMAGE_ROUTE + '?id=' + encodeURIComponent(render.id) + '&w=' + String(active.width) })),
        findings.length === 0
          ? h('div', { className: 'dfc-note' }, 'Nothing measured at this size. That is evidence, not proof: look at the picture.')
          : h('div', null, ...findings.map((finding, index) => h(Finding, { key: 'render-' + index, finding }))),
        render.errors && render.errors.length > 0 ? h('div', { className: 'dfc-note' }, 'Could not read: ' + render.errors.join('; ')) : null,
      )
    }

    /** The tab itself. */
    function FrontendCraft(props) {
      const sessionId = props && props.sessionId ? props.sessionId : ''
      const [state, setState] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [artifacts, setArtifacts] = React.useState(null)
      const [direction, setDirection] = React.useState(null)
      const [view, setView] = React.useState('findings')
      const [filter, setFilter] = React.useState('all')
      const [target, setTarget] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [pickBusy, setPickBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const loadDirection = React.useCallback(async () => {
        if (sessionId === '') {
          setDirection({ deal: null, pick: null })
          return
        }
        const answer = await api(DIRECTION_ROUTE + '?session=' + encodeURIComponent(sessionId))
        if (answer.ok && answer.body && answer.body.ok === true) setDirection({ deal: answer.body.deal ?? null, pick: answer.body.pick ?? null })
        else setDirection({ deal: null, pick: null })
      }, [sessionId])

      const pick = React.useCallback(
        async (choice) => {
          if (sessionId === '') {
            setError('This tab is not bound to a conversation, so it cannot record a choice.')
            return
          }
          setPickBusy(true)
          setError('')
          const answer = await api(DIRECTION_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, pick: choice }),
          })
          setPickBusy(false)
          if (!answer.ok || !answer.body || answer.body.ok !== true) {
            setError(String((answer.body && (answer.body.message || answer.body.code)) || 'the direction route refused that'))
            return
          }
          await loadDirection()
        },
        [sessionId, loadDirection],
      )

      const loadArtifacts = React.useCallback(async () => {
        if (sessionId === '') {
          setArtifacts({ product: null, design: null, briefs: [] })
          return
        }
        const answer = await api(ARTIFACTS_ROUTE + '?session=' + encodeURIComponent(sessionId))
        if (answer.ok && answer.body && answer.body.ok === true) setArtifacts(answer.body)
        else setArtifacts({ product: null, design: null, briefs: [] })
      }, [sessionId])

      const loadState = React.useCallback(async () => {
        const answer = await api(STATE_ROUTE + '?session=' + encodeURIComponent(sessionId))
        if (answer.ok && answer.body) setState(answer.body)
        else setError('the state route did not answer')
      }, [sessionId])

      React.useEffect(() => {
        let stopped = false
        const read = async () => {
          if (stopped) return
          await loadState()
        }
        read()
        loadArtifacts()
        loadDirection()
        return () => {
          stopped = true
        }
      }, [sessionId, loadState, loadArtifacts, loadDirection])

      const scan = React.useCallback(async () => {
        if (sessionId === '') {
          setError('This tab is not bound to a conversation, so it cannot read a workspace.')
          return
        }
        setBusy(true)
        setError('')
        const answer = await api(SCAN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, target: target.trim() }),
        })
        setBusy(false)
        if (!answer.ok || !answer.body) {
          setError('the scan route did not answer')
          return
        }
        if (answer.body.ok !== true || !answer.body.report) {
          setError(String((answer.body && (answer.body.message || answer.body.error)) || 'the scan failed'))
          return
        }
        setReport(answer.body.report)
        setView('findings')
      }, [sessionId, target])

      const detector = state && state.detector ? state.detector : null
      const corpus = state && state.corpus ? state.corpus : null
      const meta = []
      if (state) meta.push('v' + state.version)
      if (corpus) meta.push('Impeccable ' + corpus.skillVersion)
      if (state) meta.push(state.rules + ' rules')
      if (detector && detector.ok !== true) meta.push('detector unavailable')

      return h(
        'div',
        { className: 'dfc-root' },
        h(
          'div',
          { className: 'dfc-bar' },
          h('span', { className: 'dfc-title' }, 'Frontend'),
          h('span', { className: 'dfc-meta' }, meta.join(' · ')),
          h('span', { className: 'dfc-spacer' }),
          view === 'findings'
            ? h('input', {
                className: 'dfc-input',
                value: target,
                spellCheck: false,
                placeholder: 'folder or file (default: whole workspace)',
                onChange: (event) => setTarget(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') scan()
                },
                style: { maxWidth: '210px' },
              })
            : null,
          view === 'findings'
            ? button(busy ? 'Scanning…' : 'Scan', scan, { disabled: busy, 'data-toolbar': 'scan' })
            : view === 'artifacts'
              ? button('Reload', () => loadArtifacts(), { 'data-toolbar': 'reload' })
              : view === 'directions'
                ? button('Reload', () => loadDirection(), { 'data-toolbar': 'reload-direction' })
                : button('Reload', loadState, { 'data-toolbar': 'reload-render' }),
        ),
        h(
          'div',
          { className: 'dfc-tabs' },
          button('Findings', () => setView('findings'), { 'data-active': view === 'findings' ? 'true' : undefined, 'data-view': 'findings' }),
          button('Artifacts', () => setView('artifacts'), { 'data-active': view === 'artifacts' ? 'true' : undefined, 'data-view': 'artifacts' }),
          button('Directions', () => setView('directions'), { 'data-active': view === 'directions' ? 'true' : undefined, 'data-view': 'directions' }),
          button('Preview', () => setView('preview'), { 'data-active': view === 'preview' ? 'true' : undefined, 'data-view': 'preview' }),
        ),
        h(
          'div',
          { className: 'dfc-body' },
          error !== '' ? h('div', { className: 'dfc-empty' }, error) : null,
          detector && detector.ok !== true ? h('div', { className: 'dfc-empty' }, 'The vendored detector could not load: ' + detector.message) : null,
          view === 'findings'
            ? h(Findings, { report, filter, onFilter: setFilter })
            : view === 'artifacts'
              ? h(Artifacts, { artifacts, onReload: loadArtifacts })
              : view === 'directions'
                ? h(Directions, { deal: direction ? direction.deal : null, pick: direction ? direction.pick : null, busy: pickBusy, onPick: pick })
                : h(Preview, { render: state ? state.render : null }),
        ),
        h('div', { className: 'dfc-note' }, state && state.root ? 'workspace: ' + state.root : 'no workspace bound to this tab'),
      )
    }

    function FrontendTitle() {
      return h('span', { className: 'dfc-title' }, 'Frontend')
    }

    /**
     * The tab type. A `builtin`-band type with a guide capsule and no file
     * patterns: this tab is about the project, not about one file, so the Start
     * page's "+" is the way in and nothing else claims an address.
     */
    function definition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        priority: 'builtin',
        title: () => 'Frontend',
        guide: [
          {
            id: TYPE_ID + '/findings',
            order: 58,
            title: () => 'Frontend craft',
            description: () => 'The 61 design rules over this workspace, its PRODUCT / DESIGN artifacts, and the current direction round.',
          },
        ],
      }
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'dsh-frontend-craft: tab type')
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-frontend-craft] no right bar in this profile - the Frontend tab was not registered')
        return
      }
      ctx.effect(
        () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: (sessionId) => ({ sessionId }) }, FrontendCraft)),
        'dsh-frontend-craft: tab body',
      )
      ctx.effect(() => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, FrontendTitle)), 'dsh-frontend-craft: tab title')
    }

    exports.name = 'dsh-frontend-craft'
    exports.inject = inject
    exports.apply = apply
    exports.__internals = { definition, api, FrontendCraft, Directions, Preview, TYPE_ID, KIND, STATE_ROUTE, SCAN_ROUTE, ARTIFACTS_ROUTE, DIRECTION_ROUTE, RENDER_IMAGE_ROUTE }

    return module.exports
  },
})
