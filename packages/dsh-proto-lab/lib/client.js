/**
 * dsh-proto-lab — the browser half: ONE tab, the Lab.
 *
 * What it is for, and what it deliberately is not. The agent writes runs with
 * `lab_new`; a person needs to SEE one, change its seed, and look again. So this
 * tab is a frame with a run picker and four controls. It is not an editor (the
 * pack's editor opens `sketch.js` and `ofApp.cpp`), not a file browser (the Files
 * tab is one), and not a second gallery of examples (the Lab *is* the gallery:
 * a run on disk appears here the moment it exists).
 *
 * HOW A RUN GETS IN HERE
 *
 * Two ways, and both end at the same place:
 *
 *   - a click on a `.html` file that lives inside a run - `lab/<runtime>/<slug>/
 *     index.html` - opens that run. That is the Files tab's path into this tab,
 *     and it is why `canOpen` is narrowed to a lab address rather than claiming
 *     every `.html` in the workspace: the editor and the preview already have
 *     opinions about HTML, and this tab has an opinion about RUNS.
 *   - the picker, fed by `/api/dsh-proto-lab/state`, which lists what the lab
 *     holds right now.
 *
 * THE FRAME
 *
 * The page inside the frame is `/api/dsh-proto-lab/preview?run=…&seed=…`, and it
 * is SELF-CONTAINED: the host inlines the vendored p5.js and the run's sketch and
 * sends a CSP that permits no network at all. That is not decoration - the frame
 * is sandboxed with `allow-scripts` and NOT `allow-same-origin`, so it has an
 * opaque origin and could not fetch a sibling file even if it tried. A run that
 * needs `loadImage('data/x.png')` opens in a real browser tab; `lab_lint` says so
 * with `loads-a-file`.
 *
 * It is a CLASSIC SCRIPT registered through `window.__ModuleLoader__.load`, with
 * no build step, requiring only `react` and `dsh-rightbar`. The styles are
 * injected once, gated on `document`, from a `style[data-plugin-css]` tag.
 */

window.__ModuleLoader__.load({
  id: 'dsh-proto-lab',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    exports.PLUGIN_VERSION = '0.1.0-alpha.1'

    const TYPE_ID = 'dsh-proto-lab'
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const API_ROOT = '/api/dsh-proto-lab'
    const STATE_ROUTE = API_ROOT + '/state'
    const PREVIEW_ROUTE = API_ROOT + '/preview'

    const CSS_TAG = 'dsh-proto-lab/lab.css'

    /** The stylesheet, injected once. Class names are prefixed `dpl-`. */
    const CSS = `
.dpl{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px}
.dpl-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dpl-run{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpl-tag{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:4px;padding:0 5px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dpl-spacer{flex:1 1 auto}
.dpl-btn{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);border-radius:5px;padding:1px 7px;cursor:pointer;font:inherit}
.dpl-btn:hover{color:var(--dsw-alias-label-primary,#e8e8e8)}
.dpl-btn:disabled{opacity:.5;cursor:default}
.dpl-body{flex:1 1 auto;display:flex;min-height:0}
.dpl-list{width:230px;flex:none;overflow:auto;border-right:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dpl-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c8c8c8);padding:5px 8px;cursor:pointer;font:inherit}
.dpl-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.dpl-item[aria-current="true"]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dpl-item small{display:block;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dpl-frame{flex:1 1 auto;min-width:0;position:relative;background:#0b0b0d}
.dpl-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dpl-empty{flex:1 1 auto;display:grid;place-content:center;gap:6px;text-align:center;color:var(--dsw-alias-label-tertiary,#8f8f8f);padding:24px}
.dpl-empty code{color:var(--dsw-alias-label-secondary,#c8c8c8)}
.dpl-note{flex:none;padding:3px 8px;border-top:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));color:var(--dsw-alias-label-tertiary,#8f8f8f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`

    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-proto-lab'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -----------------------------------------------------------------------
    // Reading the run out of an address
    // -----------------------------------------------------------------------
    /**
     * The run a lab address names, or null.
     *
     * The address is whatever the bar hands a tab type - a relative path in the
     * workspace, most often. Two shapes are accepted and nothing else: a path that
     * contains an explicit `lab/` segment, and a path that IS `<runtime>/<slug>/
     * index.html` (which is what a run looks like from inside the lab root). Both
     * end at the same `<runtime>/<slug>` id the API speaks.
     *
     * @param address - the address the bar resolved.
     * @returns `{ run, runtime, slug }` or null.
     */
    function runFromAddress(address) {
      const text = String(address || '').replace(/\\/g, '/').split('?')[0]
      if (!/\.html?$/i.test(text)) return null
      const segments = text.split('/').filter((part) => part !== '' && part !== '.')
      const mark = segments.lastIndexOf('lab')
      const tail = mark === -1 ? segments : segments.slice(mark + 1)
      // Either `<runtime>/<slug>/index.html` or `<runtime>/<slug>/<file>.html`: a
      // run is two levels and the file is inside it.
      if (tail.length < 3) return null
      const runtime = tail[tail.length - 3]
      const slug = tail[tail.length - 2]
      if (!/^[a-z][a-z0-9-]*$/.test(runtime) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null
      return { run: runtime + '/' + slug, runtime, slug }
    }

    /** One JSON GET, with the failure turned into a readable string. */
    async function api(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({ ok: false, error: 'the answer was not JSON' }))
      if (!response.ok || body.ok === false) throw new Error(String(body.error ?? response.status))
      return body
    }

    // -----------------------------------------------------------------------
    // The tab
    // -----------------------------------------------------------------------
    /**
     * The Lab pane.
     *
     * `props.address` is what a file click handed over; the picker works when
     * there is none. Every state change re-derives the preview URL, and the frame
     * is keyed on it so a seed change RELOADS the run - which is the contract the
     * shell documents (it reads the seed once, in `setup()`).
     */
    function Lab(props) {
      const address = props && props.address ? props.address : null
      const [state, setState] = React.useState(null)
      const [problem, setProblem] = React.useState(null)
      const [selected, setSelected] = React.useState(address === null ? null : runFromAddress(address))
      const [seed, setSeed] = React.useState(null)
      const [filter, setFilter] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const answer = await api(STATE_ROUTE)
          setState(answer)
          setProblem(null)
          return answer
        } catch (err) {
          setProblem(String(err && err.message ? err.message : err))
          return null
        }
      }, [])

      React.useEffect(() => {
        let live = true
        refresh().then((answer) => {
          if (!live || answer === null) return
          setSelected((current) => {
            if (current !== null && answer.runs.some((item) => item.id === current.run)) return current
            const fromAddress = address === null ? null : runFromAddress(address)
            if (fromAddress !== null && answer.runs.some((item) => item.id === fromAddress.run)) return fromAddress
            return answer.runs.length > 0 ? { run: answer.runs[0].id, runtime: answer.runs[0].runtime, slug: answer.runs[0].slug } : null
          })
        })
        return () => {
          live = false
        }
      }, [address, refresh])

      // The seed follows the selection: a run's own seed until someone rerolls.
      const run = state === null || selected === null ? null : state.runs.find((item) => item.id === selected.run) ?? null
      React.useEffect(() => {
        setSeed(run !== null && Number.isFinite(run.seed) ? run.seed : null)
      }, [run === null ? null : run.id])

      const previewUrl =
        selected === null
          ? null
          : PREVIEW_ROUTE + '?run=' + encodeURIComponent(selected.run) + (seed === null ? '' : '&seed=' + String(seed))

      const runs = state === null ? [] : state.runs.filter((item) => filter === '' || item.runtime === filter)
      const runtimes = state === null ? [] : state.runtimes

      const bar = React.createElement(
        'div',
        { className: 'dpl-bar' },
        React.createElement('span', { className: 'dpl-run' }, selected === null ? 'Lab' : selected.run),
        run !== null && run.seed !== null
          ? React.createElement('span', { className: 'dpl-tag' }, 'seed ' + String(run.seed))
          : null,
        React.createElement('span', { className: 'dpl-spacer' }),
        React.createElement(
          'button',
          {
            className: 'dpl-btn',
            title: 'reload this run with a new seed',
            disabled: selected === null,
            onClick: () => setSeed(Math.floor(Math.random() * 100000)),
          },
          'Reroll',
        ),
        React.createElement(
          'button',
          {
            className: 'dpl-btn',
            title: 'back to the run\'s own seed',
            disabled: selected === null || run === null || run.seed === null,
            onClick: () => setSeed(run === null ? null : run.seed),
          },
          'Reset',
        ),
        React.createElement(
          'button',
          { className: 'dpl-btn', title: 're-read the lab', onClick: () => refresh() },
          'Refresh',
        ),
        React.createElement(
          'button',
          { className: 'dpl-btn', title: 'open this run in a real browser tab', disabled: selected === null },
          React.createElement(
            'a',
            {
              href: previewUrl === null ? '#' : previewUrl,
              target: '_blank',
              rel: 'noreferrer',
              style: { color: 'inherit', textDecoration: 'none' },
            },
            'Open',
          ),
        ),
      )

      const list = React.createElement(
        'div',
        { className: 'dpl-list' },
        runtimes.length > 1
          ? React.createElement(
              'div',
              { style: { display: 'flex', gap: '4px', padding: '5px 8px', flexWrap: 'wrap' } },
              React.createElement(
                'button',
                { className: 'dpl-btn', onClick: () => setFilter(''), 'aria-current': filter === '' },
                'all',
              ),
              ...runtimes.map((entry) =>
                React.createElement(
                  'button',
                  { key: entry.id, className: 'dpl-btn', onClick: () => setFilter(entry.id), 'aria-current': filter === entry.id },
                  entry.id,
                ),
              ),
            )
          : null,
        ...runs.map((item) =>
          React.createElement(
            'button',
            {
              key: item.id,
              className: 'dpl-item',
              'aria-current': selected !== null && selected.run === item.id,
              onClick: () => setSelected({ run: item.id, runtime: item.runtime, slug: item.slug }),
            },
            item.id,
            React.createElement('small', null, item.concept === '' ? item.files.length + ' files' : item.concept.slice(0, 64)),
          ),
        ),
      )

      const body =
        selected === null
          ? React.createElement(
              'div',
              { className: 'dpl-empty' },
              React.createElement('div', null, problem === null ? 'The lab is empty.' : problem),
              React.createElement(
                'div',
                null,
                'Ask the agent for a run: ',
                React.createElement('code', null, 'lab_new runtime=p5js concept="…"'),
              ),
            )
          : React.createElement(
              'div',
              { className: 'dpl-frame' },
              React.createElement('iframe', {
                key: previewUrl,
                title: selected.run,
                src: previewUrl,
                // `allow-scripts` and NOT `allow-same-origin`: the page runs, and
                // it has an opaque origin - so a sketch cannot reach the app's own
                // origin even though the app served the document.
                sandbox: 'allow-scripts',
                referrerPolicy: 'no-referrer',
              }),
            )

      const note =
        state === null
          ? null
          : problem !== null
            ? problem
            : state.notes.length > 0
              ? state.notes.join(' · ')
              : 'root: ' + state.root + (state.repo ? ' (gitignored)' : '')

      return React.createElement(
        'div',
        { className: 'dpl' },
        bar,
        React.createElement('div', { className: 'dpl-body' }, list, body),
        note === null ? null : React.createElement('div', { className: 'dpl-note', title: note }, note),
      )
    }

    /** The tab's title strip. */
    function LabTitle(props) {
      const id = props && props.address ? runFromAddress(props.address) : null
      return React.createElement('span', { className: 'dpl-run' }, id === null ? 'Lab' : id.slug)
    }

    /**
     * The tab type for the pack's right bar.
     *
     * `patterns` is what the registry matches on, and `.html` is claimed here
     * because a run's entry point IS a page. `canOpen` does the narrowing that the
     * pattern cannot: only an address that resolves to a folder inside a run is
     * accepted, so every other `.html` in the workspace keeps whatever surface it
     * had. The guide capsule's contract is the bar's: `title` and `description`
     * are FUNCTIONS (a string throws inside the Start page's own render).
     */
    function definition() {
      return {
        id: TYPE_ID,
        kind: TYPE_ID,
        patterns: ['.html', '.htm'],
        priority: 'extension',
        canOpen: (address) => runFromAddress(address) !== null,
        title: () => 'Lab',
        guide: [
          {
            id: TYPE_ID + '/lab',
            order: 70,
            title: () => 'Lab',
            description: () => 'The prototyping lab: every run on disk, framed and re-seedable.',
          },
        ],
      }
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'dsh-proto-lab: tab type')
      } catch (err) {
        // A profile without the pack's right bar still gets the tools and the
        // skills; only the tab is missing, and saying so is the honest answer.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-proto-lab] no right bar in this profile - the Lab tab was not registered')
        }
        return
      }
      ctx.effect(
        () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, Lab)),
        'dsh-proto-lab: lab body',
      )
      ctx.effect(
        () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, LabTitle)),
        'dsh-proto-lab: lab title',
      )
    }

    exports.name = 'dsh-proto-lab'
    exports.inject = inject
    exports.apply = apply
    exports.__internals = { definition, runFromAddress, Lab, LabTitle, TYPE_ID, CSS_TAG, STATE_ROUTE, PREVIEW_ROUTE, API_ROOT }

    return module.exports
  },
})
