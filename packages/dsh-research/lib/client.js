/**
 * dsh-research — the browser half: ONE tab, the research run.
 *
 * WHY THIS TAB EXISTS. A research run is a FOLDER on disk, written by the host
 * half's `rs_*` tools, and the agent works inside it: it frames the question,
 * gathers sources, drafts, and then - at every decision point - it STOPS and
 * asks the person. A folder cannot ask. The tools can read and write one, and a
 * conversation can show the agent's message, but nothing in the app shows what
 * the run holds RIGHT NOW nor lets a person answer the question blocking it.
 *
 * So this is one narrow column, and the order is the design: the ACTIONABLE
 * thing comes first. A pending gate - a question the agent is waiting on - sits
 * above the provenance and the file list whenever one exists, because a run that
 * is waiting is the only reason to open this tab at all. GATES FIRST IS THE
 * FEATURE; a future editor who sorts the column by document order (header,
 * gates, files, provenance) removes it.
 *
 * THE ANSWER IS THE PERSON'S OWN WORDS, AND THAT IS THE CONTRACT. The `<textarea>`
 * is not a note field: what it holds is recorded VERBATIM in the run's passport
 * and quoted back to the agent character for character, which is why the form
 * says so above the box, why the reason box only appears when the chosen option
 * asks for one, and why `gatePayload` never rewrites what was typed. A future
 * editor who "tidies up" the text before the POST breaks the one promise this
 * tab makes.
 *
 * WHAT IT TALKS TO: three routes on this plugin's own host half, and nothing
 * else - no vendored engine, no second origin, no socket.
 *
 *   - `GET  /api/dsh-research/state`            the root, every run, capabilities
 *   - `GET  /api/dsh-research/project?slug=…`   one run: gates, passport, files
 *   - `POST /api/dsh-research/gate`             one answer, verbatim
 *
 * A non-OK answer and a thrown fetch are BOTH turned into a visible string by
 * `problemText` / `errorMessageOf`: a panel that goes quietly empty on a failed
 * request is indistinguishable from a root with no runs.
 *
 * LIVE WITHOUT A REFRESH. A run changes while the agent works it, so the visible
 * tab re-reads `state` and the selected `project` every `POLL_MS`. The rules that
 * keep that honest: it stops the moment `document.visibilityState` is hidden (a
 * background tab has no watcher), it re-reads at once when the document becomes
 * visible again, and it never starts a second read while one - or a POST - is
 * still in flight, because two concurrent reads can land out of order and show
 * an older state over a newer one.
 *
 * A run is a page, not a file, so this type claims NO patterns and no `canOpen`:
 * it is reached from the bar's Start page, and it takes nothing away from any
 * file type the pack already opens.
 *
 * It is a CLASSIC SCRIPT registered through `window.__ModuleLoader__.load`, with
 * no build step, requiring only `react`. The stylesheet is injected once, gated
 * on `document`, from a `style[data-plugin-css]` tag.
 */

window.__ModuleLoader__.load({
  id: 'dsh-research',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /**
     * The element factory, and NOT the automatic runtime's `jsx`: `h(tag, props,
     * child, child)` takes VARIADIC children where `jsx`'s third argument is a
     * key, so a bundle bound to `jsx` renders with every child silently dropped.
     */
    const h = React.createElement

    // -----------------------------------------------------------------------
    // Identity, seats and routes
    // -----------------------------------------------------------------------
    /** This implementation's id in the tab registry, and the slot key of its seats. */
    const TYPE_ID = 'dsh-research'
    /** The keyed seats every tab type occupies in the right bar. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** The host half's routes. These three are the ONLY network this bundle makes. */
    const API_ROOT = '/api/dsh-research'
    const STATE_ROUTE = API_ROOT + '/state'
    const PROJECT_ROUTE = API_ROOT + '/project'
    const GATE_ROUTE = API_ROOT + '/gate'
    /** A run's own text files: GET reads one, POST saves one. */
    const FILE_ROUTE = API_ROOT + '/file'
    /** Build a format: the same code path `rs_build` drives. */
    const BUILD_ROUTE = API_ROOT + '/build'
    /** The style tag's identity, so the injection happens exactly once. */
    const CSS_TAG = 'dsh-research/research.css'
    /**
     * How often the visible tab re-reads. 1500 ms is fast enough that a gate the
     * agent just opened appears while the person is still looking at the column,
     * and slow enough that two reads of one folder never overlap.
     */
    const POLL_MS = 1500
    /** How much of an ANSWERED gate's question the timeline shows (full text stays in `title`). */
    const QUESTION_CUT = 120
    /**
     * The one sentence the gate form must keep saying, written WITHOUT an
     * apostrophe: React escapes `'` in rendered text as `&#x27;`, so a sentence
     * carrying one cannot be asserted against the markup it produces.
     */
    const VERBATIM_NOTE = 'Your words are recorded verbatim in the run passport and quoted back to the agent exactly as you write them - nothing is summarised or reworded.'
    /** The exact call that starts a run, named in the empty state (and exported to be asserted). */
    const NEW_RUN_HINT = 'rs_new slug=… title="…" kind=paper'

    // -----------------------------------------------------------------------
    // Styles
    //
    // Every class is prefixed `dsr-`, which is this package's namespace: two
    // bundles that define the same class do not merely collide, the later one
    // silently redresses the earlier one's UI. Colour comes only from the app's
    // theme tokens, so dark and light both work without a second stylesheet.
    // -----------------------------------------------------------------------
    const css = `
.dsr{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsr-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-banner{flex:none;display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));color:var(--dsw-alias-state-error-primary,#c0392b);font-size:11.5px}
.dsr-bannerText{flex:1 1 auto;min-width:0;word-break:break-word}
.dsr-btn{flex:none;box-sizing:border-box;height:22px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:11.5px;padding:0 8px;cursor:pointer}
.dsr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsr-btn:disabled{opacity:.45;cursor:default}
.dsr-runs{flex:none;max-height:30%;overflow:auto;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dsr-run{display:block;width:100%;box-sizing:border-box;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);padding:5px 8px;cursor:pointer;font:inherit}
.dsr-run:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.dsr-run[aria-current="true"]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsr-runTitle{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-runMeta{display:flex;align-items:center;gap:6px;min-width:0;margin-top:1px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsr-runSlug{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace)}
.dsr-badge{flex:none;border-radius:5px;padding:0 5px;background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f)}
.dsr-detail{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 12px}
.dsr-head{display:flex;flex-direction:column;gap:3px;padding-bottom:8px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsr-headTitle{font-size:13px;font-weight:600;word-break:break-word}
.dsr-headMeta{display:flex;flex-wrap:wrap;gap:5px}
.dsr-chip{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:5px;padding:0 5px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:11px}
.dsr-stage{color:var(--dsw-alias-label-secondary,#666);font-size:11.5px}
.dsr-root{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsr-section{margin-top:10px}
.dsr-sectionTitle{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin-bottom:5px}
.dsr-sub{margin:6px 0 3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsr-note{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:11.5px}
.dsr-gate{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:8px;padding:8px;margin-bottom:8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04))}
.dsr-q{font-weight:500;word-break:break-word;margin-bottom:6px}
.dsr-opts{display:flex;flex-direction:column;gap:2px}
.dsr-opt{display:flex;align-items:flex-start;gap:6px;cursor:pointer}
.dsr-optLabel{min-width:0;word-break:break-word}
.dsr-field{display:block;margin-top:6px}
.dsr-lab{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:2px}
.dsr-area{display:block;width:100%;box-sizing:border-box;min-height:52px;resize:vertical;background:transparent;border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:6px;color:inherit;font:inherit;padding:4px 6px}
.dsr-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dsr-hint{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsr-actions{display:flex;align-items:center;gap:8px;margin-top:7px}
.dsr-err{color:var(--dsw-alias-state-error-primary,#c0392b);font-size:11.5px;word-break:break-word}
.dsr-quote{margin:5px 0;padding:5px 8px;border-left:2px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border-radius:0 6px 6px 0}
.dsr-quoteText{white-space:pre-wrap;word-break:break-word}
.dsr-when{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums}
.dsr-timeline{margin:0;padding:0;list-style:none}
.dsr-tlItem{padding:5px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dsr-tlQ{color:var(--dsw-alias-label-secondary,#666);font-size:11.5px}
.dsr-tlValue{font-weight:500}
.dsr-receipts{margin:0;padding:0;list-style:none}
.dsr-receipt{display:flex;gap:6px;align-items:baseline;padding:2px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12))}
.dsr-tool{flex:none;font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);color:var(--dsw-alias-label-secondary,#666)}
.dsr-receiptText{flex:1 1 auto;min-width:0;word-break:break-word}
.dsr-files{margin:0;padding:0;list-style:none}
.dsr-file{display:flex;gap:8px;align-items:baseline;padding:2px 0}
.dsr-filePath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace)}
.dsr-fileSize{flex:none;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums}
.dsr-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsr-emptyTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#666)}
.dsr-cmd{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));padding:4px 8px;border-radius:6px;word-break:break-all}
.dsr-foot{flex:none;padding:3px 8px;border-top:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:11px}
.dsr-footLine{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsr-fileBtn{display:flex;gap:8px;align-items:baseline;width:100%;box-sizing:border-box;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:2px 0;cursor:pointer;border-radius:4px}
.dsr-fileBtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}
.dsr-fileBtn[aria-current="true"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18))}
.dsr-fileEdit{flex:none;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:10.5px}
.dsr-editor{margin-top:6px}
.dsr-editorHead{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.dsr-editorPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.dsr-code{display:block;width:100%;box-sizing:border-box;min-height:220px;resize:vertical;white-space:pre;overflow:auto;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:6px;color:inherit;font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);font-size:11.5px;line-height:1.45;padding:6px 8px;tab-size:2}
.dsr-code:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dsr-verdict{margin-top:6px;padding:6px 8px;border-radius:6px;font-size:11.5px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24))}
.dsr-verdict[data-dsr-verdict="ok"]{background:var(--dsw-alias-state-success-bg,rgba(46,160,67,.14));color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dsr-verdict[data-dsr-verdict="problems"]{background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f)}
.dsr-verdictLine{margin-top:2px;word-break:break-word}
.dsr-claim{padding:5px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dsr-claimHead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.dsr-claimId{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:10.5px}
.dsr-st{flex:none;border-radius:5px;padding:0 5px;font-size:10.5px;border:.5px solid transparent}
.dsr-st[data-status="unverified"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#666)}
.dsr-st[data-status="located"]{background:var(--dsw-alias-state-info-bg,rgba(56,132,255,.16));color:var(--dsw-alias-state-info-primary,#2f6fdb)}
.dsr-st[data-status="supported"]{background:var(--dsw-alias-state-success-bg,rgba(46,160,67,.16));color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dsr-st[data-status="partially-supported"]{background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f)}
.dsr-st[data-status="unsupported"],.dsr-st[data-status="contradicted"],.dsr-st[data-status="misattributed"]{background:var(--dsw-alias-state-error-bg,rgba(192,57,43,.16));color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsr-claimText{word-break:break-word;margin-top:2px}
.dsr-claimMeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsr-bind{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace)}
.dsr-src{padding:4px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dsr-srcKey{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);color:var(--dsw-alias-label-secondary,#666)}
.dsr-srcTitle{word-break:break-word;margin-top:1px}
.dsr-outlineRow{display:flex;gap:8px;align-items:baseline;padding:2px 0}
.dsr-outlineTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-outlineNum{flex:none;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums;font-size:10.5px}
.dsr-buildRow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.dsr-buildOut{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.dsr-buildOut code{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace)}
.dsr-statusbar{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 4px}
.dsr-stat{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:5px;padding:0 6px;font-size:10.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dsr-stat[data-tone="ok"]{background:var(--dsw-alias-state-success-bg,rgba(46,160,67,.14));color:var(--dsw-alias-state-success-primary,#1a7f37);border-color:transparent}
.dsr-stat[data-tone="warn"]{background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f);border-color:transparent}
.dsr-stat[data-tone="bad"]{background:var(--dsw-alias-state-error-bg,rgba(192,57,43,.16));color:var(--dsw-alias-state-error-primary,#c0392b);border-color:transparent}
.dsr-group{margin-top:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.03));overflow:hidden}
.dsr-groupHead{display:flex;align-items:baseline;gap:6px;padding:5px 8px;cursor:pointer;list-style:none;font-size:11.5px;-webkit-user-select:none;user-select:none}
.dsr-groupHead::-webkit-details-marker{display:none}
.dsr-groupHead::before{content:'▸';flex:none;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:9px;line-height:1}
.dsr-group[data-open="true"]>.dsr-groupHead::before{content:'▾'}
.dsr-groupTitle{flex:none;font-weight:600;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsr-groupMeta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:10.5px}
.dsr-groupTone{flex:none;border-radius:5px;padding:0 5px;font-size:10.5px}
.dsr-groupTone[data-tone="warn"]{background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f)}
.dsr-groupTone[data-tone="ok"]{background:var(--dsw-alias-state-success-bg,rgba(46,160,67,.14));color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dsr-groupBody{padding:0 8px 8px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dsr-groupBody>.dsr-section:first-child{margin-top:8px}
.dsr-rq{font-size:11.5px}
`
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-research'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -----------------------------------------------------------------------
    // Reading the payloads
    //
    // The host half is written to exactly one shape, and every reader below is
    // TOTAL: a missing key, a null ledger, a gate with no options or a receipt
    // with no summary has to render as an honest blank, never as a thrown
    // TypeError inside the slot core (which ABDICATES the seat and takes the
    // whole panel with it).
    // -----------------------------------------------------------------------
    /** An array, or an empty one - never `null`. */
    function listOf(value) {
      return Array.isArray(value) ? value : []
    }

    /** Every run `state` reports, in the order the host listed them. */
    function runsOf(payload) {
      return payload === null || payload === undefined ? [] : listOf(payload.runs)
    }

    /** Every gate a project reports, pending and answered together. */
    function gatesOf(project) {
      return project === null || project === undefined ? [] : listOf(project.gates)
    }

    /** The choices one gate offers. */
    function optionsOf(gate) {
      return gate === null || gate === undefined ? [] : listOf(gate.options)
    }

    /** How many gates a run is waiting on, from the run row's own counters. */
    function pendingCount(run) {
      const gates = run === null || run === undefined ? null : run.gates
      const pending = gates === null || gates === undefined ? null : gates.pending
      return Number.isFinite(pending) ? pending : 0
    }

    /**
     * Whether a gate has been answered. `answer` is `null` until the person
     * answers, and an answered gate is what the timeline renders and the form
     * does not - so this is the one predicate the whole column turns on.
     */
    function isAnswered(gate) {
      return gate !== null && gate !== undefined && gate.answer !== null && gate.answer !== undefined
    }

    /** The gates the agent is still waiting on, in host order. */
    function pendingGates(project) {
      return gatesOf(project).filter((gate) => !isAnswered(gate))
    }

    /** The gates already answered, in host order. */
    function answeredGates(project) {
      return gatesOf(project).filter((gate) => isAnswered(gate))
    }

    /** The chosen option's own label, falling back to the raw value. */
    function answerLabel(gate) {
      if (!isAnswered(gate)) return ''
      const answer = gate.answer
      const value = answer.value === null || answer.value === undefined ? '' : String(answer.value)
      for (const option of optionsOf(gate)) {
        if (String(option.value) === value && typeof option.label === 'string') return option.label
      }
      return value
    }

    /** The person's own words on an answered gate - the part that is quoted back. */
    function answerText(gate) {
      if (!isAnswered(gate)) return ''
      return typeof gate.answer.text === 'string' ? gate.answer.text : ''
    }

    /** A run's reader-facing name: its title, else its slug, else an honest blank. */
    function runLabel(run) {
      if (run === null || run === undefined) return ''
      const title = typeof run.title === 'string' ? run.title.trim() : ''
      if (title !== '') return title
      const slug = typeof run.slug === 'string' ? run.slug.trim() : ''
      return slug !== '' ? slug : '(untitled run)'
    }

    /** The claims the host sent, in host order. */
    function claimsOf(project) {
      return listOf(project === null || project === undefined ? null : project.claims)
    }

    /** The sources the host sent, in host order. */
    function sourcesOf(project) {
      return listOf(project === null || project === undefined ? null : project.sources)
    }

    /** The outline block, or a shape that renders as "nothing written yet". */
    function outlineOf(project) {
      const outline = project === null || project === undefined ? null : project.outline
      if (outline === null || outline === undefined || typeof outline !== 'object') {
        return { source: '', words: 0, parts: [], sections: [], citations: 0 }
      }
      return {
        source: String(outline.source ?? ''),
        words: Number(outline.words) || 0,
        parts: listOf(outline.parts),
        sections: listOf(outline.sections),
        citations: Number(outline.citations) || 0,
      }
    }

    /** The structure chip: whether the document and the ledgers agree right now. */
    function structureOf(project) {
      const structure = project === null || project === undefined ? null : project.structure
      if (structure === null || structure === undefined || typeof structure !== 'object') {
        return { ok: true, errors: 0, warnings: 0, codes: [] }
      }
      return {
        ok: structure.ok === true,
        errors: Number(structure.errors) || 0,
        warnings: Number(structure.warnings) || 0,
        codes: listOf(structure.codes).map((code) => String(code)),
      }
    }

    /** How many claims carry each status, for the section title. */
    function statusRoll(claims) {
      const counts = {}
      for (const claim of listOf(claims)) {
        const status = String(claim.status ?? 'unverified')
        counts[status] = (counts[status] ?? 0) + 1
      }
      return counts
    }

    /**
     * The build buttons: every format this build can write, then the ones it
     * refuses by name - DISABLED and labelled with the phase, because a button
     * that silently does nothing is worse than one that says why it cannot.
     */
    /**
     * The formats to offer, which are the formats the HOST says it can write.
     *
     * There used to be a hardcoded list of "coming soon" ids appended here, so the
     * panel could show a disabled button with the phase that would bring it. Every
     * format this plugin advertises is implemented now, and a list kept in the client
     * is the wrong authority anyway: it cannot know a builder landed, and it silently
     * omits one the host grew. The host's `capabilities.formats` is the only thing
     * that knows, and its own check asserts that everything it advertises is
     * implemented - so what it reports is what can be clicked.
     */
    function buildFormats(ready) {
      const can = listOf(ready).map((id) => String(id)).filter((id) => id !== 'all')
      return can.map((id) => ({ id, ready: true }))
    }

    /**
     * A stage as a person reads it.
     *
     * A known stage gets its sentence; an UNKNOWN one is shown as itself with its
     * separators opened up, because a run vocabulary the host grows later must
     * still appear in the column rather than as `undefined` or an empty line.
     * This is deliberately not a whitelist that could hide a stage.
     */
    const STAGE_LABELS = {
      frame: 'Framing', framing: 'Framing',
      gather: 'Gathering sources', gathering: 'Gathering sources', sources: 'Gathering sources',
      reading: 'Reading', draft: 'Drafting', drafting: 'Drafting', analysis: 'Analysis',
      review: 'Reviewing', reviewing: 'Reviewing', revision: 'Revising', revising: 'Revising',
      final: 'Final', done: 'Done', complete: 'Done',
    }

    /** @see STAGE_LABELS */
    function stageLabel(stage) {
      const text = typeof stage === 'string' ? stage.trim() : ''
      if (text === '') return ''
      const known = STAGE_LABELS[text.toLowerCase()]
      if (known !== undefined) return known
      const words = text.replace(/[-_]+/g, ' ')
      return words.charAt(0).toUpperCase() + words.slice(1)
    }

    /**
     * One ISO stamp as the short text a reader sees.
     *
     * UTC and NOT the browser's local zone: the payload's stamps are the record
     * of when an instruction was given, two people reading the same receipt must
     * not disagree about it, and a check that drove this helper would otherwise
     * pass or fail by the machine's timezone. The full ISO stamp stays available
     * in the element's `title`, which is where an exact moment belongs. A stamp
     * that will not parse is returned AS ITSELF rather than blanked.
     */
    function formatStamp(value) {
      const text = typeof value === 'string' ? value : ''
      if (text === '') return ''
      const when = new Date(text)
      if (Number.isNaN(when.getTime())) return text
      return when.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
    }

    /** Bytes as a reader reads them; non-finite input renders as nothing. */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return value + ' B'
      // BINARY units, because the divisor above is 1024: "2 kB" means 2000 bytes,
      // so labelling 2048 bytes that way would report a different number than the
      // host half's own `sizeOf` reports for the same file.
      const units = ['KiB', 'MiB', 'GiB', 'TiB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return (size >= 10 ? Math.round(size) : Math.round(size * 10) / 10) + ' ' + units[unit]
    }

    /**
     * Text cut to a budget, ALWAYS marked as cut.
     *
     * A shortened question that looks whole is worse than a long one: the reader
     * cannot tell that something was dropped. Every truncated string therefore
     * ends in `…`, and the caller keeps the full text in the element's `title`.
     */
    function truncate(text, max) {
      const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 160
      if (value.length <= limit) return value
      return value.slice(0, Math.max(1, limit - 1)).replace(/\s+$/, '') + '…'
    }

    /**
     * The reason box belongs to the OPTION that was picked, not to the gate.
     *
     * A gate whose options declare `overrides` asks why only for the options that
     * override something; a gate that declares nothing on its options falls back
     * to a plain rule - a choice that is not the first one needs explaining - so
     * the box appears for both shapes of host data and never for a plain confirm.
     */
    function wantsReason(gate, value) {
      const options = optionsOf(gate)
      if (options.length === 0 || value === '' || value === null || value === undefined) return false
      let picked = null
      for (const option of options) {
        if (String(option.value) === String(value)) picked = option
      }
      if (picked === null) return false
      if (options.some((option) => option.overrides === true)) return picked.overrides === true
      return String(picked.value) !== String(options[0].value)
    }

    /**
     * The POST body for one answer.
     *
     * `text` is sent whenever the gate asks for it (even empty, so an answered
     * gate always carries the field) or whenever the person typed something, and
     * it is sent EXACTLY as typed - no trim, no normalisation, no re-wrapping -
     * for the same reason the label says "verbatim". `reason` rides along only
     * when there is one.
     */
    function gatePayload(slug, gate, draft) {
      const answer = draft === null || draft === undefined ? {} : draft
      const body = {
        slug: String(slug === null || slug === undefined ? '' : slug),
        id: String(gate && gate.id !== undefined && gate.id !== null ? gate.id : ''),
        value: String(answer.value === undefined || answer.value === null ? '' : answer.value),
      }
      const text = typeof answer.text === 'string' ? answer.text : ''
      const reason = typeof answer.reason === 'string' ? answer.reason : ''
      if (text !== '' || (gate && gate.requiresText === true)) body.text = text
      if (reason !== '') body.reason = reason
      return body
    }

    /** The project route for one run, with the slug encoded. */
    function projectQuery(slug) {
      return PROJECT_ROUTE + '?slug=' + encodeURIComponent(String(slug === null || slug === undefined ? '' : slug))
    }

    // -----------------------------------------------------------------------
    // The network: three routes, and every failure is a string
    // -----------------------------------------------------------------------
    /**
     * What a failed route's own body said, or the bare status.
     *
     * The host answers a refusal with a `message` (and older layers with an
     * `error`, string or object); the person needs THAT sentence, because it says
     * which gate or which slug was rejected, where "HTTP 400" says nothing.
     */
    function errorMessageOf(body, status) {
      if (body !== null && typeof body === 'object') {
        if (typeof body.message === 'string' && body.message !== '') return body.message
        if (typeof body.error === 'string' && body.error !== '') return body.error
        if (body.error !== null && typeof body.error === 'object' && typeof body.error.message === 'string' && body.error.message !== '') return body.error.message
      }
      return 'HTTP ' + String(status)
    }

    /** Any throw, as the sentence the column shows. Never blank, never `[object Object]`. */
    function problemText(err) {
      if (err !== null && err !== undefined && typeof err.message === 'string' && err.message !== '') return err.message
      const text = String(err)
      return text === '' ? 'the request failed' : text
    }

    /**
     * One request against this plugin's own origin.
     *
     * `credentials: 'same-origin'` because the routes are the app's own and a
     * profile that fronts them with a session cookie must still be served; the
     * answer is parsed defensively, and a non-OK response becomes an Error whose
     * message is the route's own, so a caller only ever has to show one string.
     */
    async function fetchJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', ...(init ?? {}) })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        // The route's CODE travels with the throw as well as its sentence: a caller
        // that has to show WHICH refusal it was (the build's `GATE_UNANSWERED`
        // against its `FORMAT_NOT_YET`) must not have to make a second request to
        // find out, and matching on the prose would break the first time a message
        // was reworded.
        const error = new Error(errorMessageOf(body, response.status))
        if (body !== null && typeof body === 'object' && typeof body.code === 'string' && body.code !== '') error.code = body.code
        throw error
      }
      return body
    }

    // -----------------------------------------------------------------------
    // The pieces of the column
    // -----------------------------------------------------------------------
    /** One labelled section of the detail column. */
    function Section(props) {
      return h('div', { className: 'dsr-section', 'data-dsr-section': props.name }, h('div', { className: 'dsr-sectionTitle' }, props.title), props.children)
    }

    /**
     * One FAMILY of the column: a collapsible group with a title, a one-line
     * summary and its own body.
     *
     * The column used to be one flat stack, so "what is waiting on me", "what the
     * document says" and "what it rests on" carried the same visual weight and the
     * only way to find anything was to scroll. A family is the unit a person
     * navigates by, and its header answers the question they opened the tab with:
     * how many decisions are waiting, how many words, how many sources, whether the
     * build is sound. `open` is a real state rather than an attribute, so a group a
     * person closed stays closed through the 1500 ms poll that replaces the project
     * object under it.
     */
    function Group(props) {
      const [open, setOpen] = React.useState(props.defaultOpen === true)
      return h(
        'details',
        {
          className: 'dsr-group',
          'data-dsr-group': props.name,
          'data-open': open ? 'true' : 'false',
          open,
          onToggle: (event) => setOpen(event.currentTarget.open === true),
        },
        h(
          'summary',
          { className: 'dsr-groupHead' },
          h('span', { className: 'dsr-groupTitle' }, props.title),
          props.meta === '' || props.meta === null || props.meta === undefined ? null : h('span', { className: 'dsr-groupMeta' }, props.meta),
          props.tone === null || props.tone === undefined ? null : h('span', { className: 'dsr-groupTone', 'data-tone': props.tone }, props.toneLabel ?? props.tone),
        ),
        h('div', { className: 'dsr-groupBody' }, props.children),
      )
    }

    /** One `label` chip in the status strip under the run header. */
    function Stat(props) {
      return h('span', { className: 'dsr-stat', 'data-tone': props.tone === undefined ? 'plain' : props.tone, title: props.title === undefined ? '' : props.title }, props.label)
    }

    /**
     * The question and the plan behind it.
     *
     * The research question is the one sentence the whole run is about, and it is
     * drawn FIRST in its family because a person checking a gate has to be able to
     * read it. The method record and the disclosure follow it as one line each:
     * enough to see whether the search and the ethics statement exist, without a
     * second screen.
     */
    function PlanSection(props) {
      const plan = props.plan
      if (plan === null || plan === undefined) return null
      const method = plan.method
      const disclosure = plan.disclosure
      return h(
        Section,
        { name: 'plan', title: 'Question and plan' },
        plan.rq === '' ? h('div', { className: 'dsr-note' }, 'No research question written yet. `rs_plan part=rq` writes one.') : h('blockquote', { className: 'dsr-quote dsr-rq', 'data-dsr-rq': '1' }, h('div', { className: 'dsr-quoteText' }, plan.rq)),
        method === null
          ? h('div', { className: 'dsr-note', 'data-dsr-method': 'none' }, 'No method record: the search behind this evidence is not written down.')
          : h(
              'div',
              { className: 'dsr-note', 'data-dsr-method': 'record' },
              method.databases + ' database(s), accessed ' + (method.accessed === '' ? 'not recorded' : method.accessed) + ' · ' + method.identified + ' identified, ' + method.screened + ' screened, ' + method.included + ' included',
            ),
        disclosure !== undefined && disclosure.exists
          ? h('div', { className: 'dsr-note', 'data-dsr-disclosure': 'recorded' }, 'Disclosure recorded for ' + disclosure.authors + ' author(s): ethics, funding, conflicts, data, AI use.')
          : h('div', { className: 'dsr-note', 'data-dsr-disclosure': 'none' }, 'No disclosure record: authorship, ethics, funding, conflicts, data availability and AI use are unwritten.'),
      )
    }

    /** One `label · value` chip in a header line. */
    function Chip(props) {
      return h('span', { className: 'dsr-chip' }, props.label)
    }

    /**
     * One run in the picker.
     *
     * A pending gate is the reason to look at a run, so the badge that counts it
     * is on the ROW: a person scanning the list sees which run is waiting without
     * clicking through them, and `aria-current` is what tells them which one the
     * detail column below is showing.
     */
    function RunRow(props) {
      const run = props.run
      const waiting = pendingCount(run)
      const kind = typeof run.kind === 'string' && run.kind !== '' ? run.kind : 'run'
      return h(
        'button',
        { type: 'button', className: 'dsr-run', 'data-dsr-slug': String(run.slug), 'aria-current': props.selected ? 'true' : undefined, onClick: () => props.onSelect(String(run.slug)) },
        h('span', { className: 'dsr-runTitle', title: runLabel(run) }, runLabel(run)),
        h(
          'span',
          { className: 'dsr-runMeta' },
          h('span', { className: 'dsr-runSlug' }, String(run.slug)),
          h('span', null, kind),
          waiting > 0 ? h('span', { className: 'dsr-badge' }, waiting + ' waiting') : null,
        ),
      )
    }

    /** The selected run's header: what it is, and where it lives. */
    function RunHeader(props) {
      const run = props.run
      if (run === null || run === undefined) return null
      const bits = []
      if (run.kind) bits.push(String(run.kind))
      if (run.language) bits.push(String(run.language))
      if (run.style) bits.push(String(run.style))
      if (run.structure) bits.push(String(run.structure))
      const root = typeof run.root === 'string' ? run.root : ''
      return h(
        'div',
        { className: 'dsr-head', 'data-dsr-head': String(run.slug) },
        h('div', { className: 'dsr-headTitle' }, runLabel(run)),
        h('div', { className: 'dsr-headMeta' }, ...bits.map((bit, index) => h(Chip, { key: 'bit-' + index, label: bit }))),
        // Truncated by CSS, never by the string: `title` carries the whole path,
        // because a path whose tail is gone is not a path anybody can check.
        root === '' ? null : h('div', { className: 'dsr-root', title: root }, root),
      )
    }

    /**
     * One pending gate: the question, the choices, the person's words, Submit.
     *
     * The draft lives HERE, keyed by nothing but its position in the list, so the
     * 1500 ms poll - which replaces the whole project object under this form -
     * cannot wipe what is being typed. `onSubmit` answers `null` when the host
     * accepted the answer and the route's own message when it did not; only a
     * `null` clears the box, so a rejected answer is never lost from the screen.
     */
    function GateForm(props) {
      const gate = props.gate
      const options = optionsOf(gate)
      const [draft, setDraft] = React.useState({ value: '', text: '', reason: '' })
      const [sending, setSending] = React.useState(false)
      const [failed, setFailed] = React.useState(null)
      const value = draft.value
      const reasonWanted = wantsReason(gate, value)
      const needsWords = gate.requiresText === true && draft.text.trim() === ''
      const canSend = value !== '' && !needsWords && !sending

      const pick = (next) => setDraft((current) => ({ ...current, value: next }))
      const writeText = (text) => setDraft((current) => ({ ...current, text }))
      const writeReason = (reason) => setDraft((current) => ({ ...current, reason }))
      const send = () => {
        if (!canSend || typeof props.onSubmit !== 'function') return
        setSending(true)
        setFailed(null)
        Promise.resolve(props.onSubmit(gate, draft)).then(
          (message) => {
            setSending(false)
            if (message === null || message === undefined) setDraft({ value: '', text: '', reason: '' })
            else setFailed(problemText(message))
          },
          (err) => {
            setSending(false)
            setFailed(problemText(err))
          },
        )
      }

      return h(
        'div',
        { className: 'dsr-gate', 'data-dsr-gate': String(gate.id), 'data-dsr-stage': String(gate.stage ?? '') },
        h('div', { className: 'dsr-q' }, String(gate.question ?? gate.id)),
        h(
          'div',
          { className: 'dsr-opts', role: 'radiogroup', 'aria-label': String(gate.question ?? gate.id) },
          ...options.map((option) =>
            h(
              'label',
              { key: 'option-' + String(option.value), className: 'dsr-opt' },
              h('input', { type: 'radio', name: 'dsr-gate-' + String(gate.id), value: String(option.value), checked: value === String(option.value), onChange: () => pick(String(option.value)) }),
              h('span', { className: 'dsr-optLabel' }, String(option.label ?? option.value)),
            ),
          ),
        ),
        // Each box is wrapped in its own label, so the `<textarea>` is labelled
        // without an id the poll could duplicate; `data-dsr-field` is what tells
        // the answer box apart from the reason box.
        h(
          'label',
          { className: 'dsr-field' },
          h('span', { className: 'dsr-lab' }, gate.requiresText === true ? 'Your answer, in your own words (recorded verbatim)' : 'Anything to add, in your own words (optional, recorded verbatim)'),
          h('textarea', {
            className: 'dsr-area', value: draft.text, 'data-dsr-field': 'text', onChange: (event) => writeText(event.target.value),
            placeholder: gate.requiresText === true ? 'What you want, as you would say it' : 'Leave empty to answer with the option alone',
          }),
        ),
        reasonWanted
          ? h(
              'label',
              { className: 'dsr-field' },
              h('span', { className: 'dsr-lab' }, 'Why (recorded verbatim with the answer)'),
              h('textarea', {
                className: 'dsr-area', value: draft.reason, 'data-dsr-field': 'reason', onChange: (event) => writeReason(event.target.value),
                placeholder: 'The reason this choice overrides the default',
              }),
            )
          : null,
        h('div', { className: 'dsr-hint' }, VERBATIM_NOTE),
        h(
          'div',
          { className: 'dsr-actions' },
          h('button', { type: 'button', className: 'dsr-btn', disabled: !canSend, 'data-dsr-submit': String(gate.id), onClick: send }, sending ? 'Recording…' : 'Record this answer'),
          value === '' ? h('span', { className: 'dsr-note' }, 'Choose an option first.') : null,
          value !== '' && needsWords ? h('span', { className: 'dsr-note' }, 'This gate needs an answer in your own words.') : null,
        ),
        failed === null ? null : h('div', { className: 'dsr-err', 'data-dsr-gate-error': String(gate.id) }, failed),
      )
    }

    /** The answered gates, in host order: what was asked, what was chosen, in whose words. */
    function AnsweredTimeline(props) {
      const gates = listOf(props.gates)
      if (gates.length === 0) return null
      const items = gates.map((gate) =>
        h(
          'li',
          { key: 'answered-' + String(gate.id), className: 'dsr-tlItem', 'data-dsr-answered': String(gate.id) },
          h('div', { className: 'dsr-tlQ', title: String(gate.question ?? '') }, truncate(gate.question, QUESTION_CUT)),
          h('div', { className: 'dsr-tlValue' }, answerLabel(gate)),
          answerText(gate) === '' ? null : h('blockquote', { className: 'dsr-quote' }, h('div', { className: 'dsr-quoteText' }, answerText(gate))),
          h('div', { className: 'dsr-when', title: String(gate.answer && gate.answer.at ? gate.answer.at : '') }, formatStamp(gate.answer ? gate.answer.at : '')),
        ),
      )
      return h(Section, { name: 'answered', title: 'Answered (' + gates.length + ')' }, h('ol', { className: 'dsr-timeline' }, ...items))
    }

    /**
     * The passport: the person's instructions and the agent's receipts.
     *
     * An instruction is the person's OWN WORDS and is therefore NEVER truncated,
     * clipped or collapsed - it is the run's authority, and a quote that has been
     * shortened is not a quote. `white-space: pre-wrap` keeps the shape it was
     * typed in.
     */
    function PassportBlock(props) {
      const passport = props.passport
      if (passport === null || passport === undefined) {
        return h(Section, { name: 'passport', title: 'Provenance' }, h('div', { className: 'dsr-note' }, 'Reading the run…'))
      }
      const instructions = listOf(passport.instructions)
      const receipts = listOf(passport.receipts)
      const quotes = instructions.map((entry, index) =>
        h(
          'blockquote',
          { key: 'instruction-' + index, className: 'dsr-quote', 'data-dsr-instruction': String(index) },
          h('div', { className: 'dsr-quoteText' }, typeof entry.verbatim === 'string' ? entry.verbatim : ''),
          h('div', { className: 'dsr-when', title: String(entry.at ?? '') }, formatStamp(entry.at)),
        ),
      )
      const rows = receipts.map((entry, index) =>
        h(
          'li',
          { key: 'receipt-' + index, className: 'dsr-receipt' },
          h('span', { className: 'dsr-tool' }, String(entry.tool ?? '')),
          h('span', { className: 'dsr-receiptText' }, String(entry.summary ?? '')),
          h('span', { className: 'dsr-when', title: String(entry.at ?? '') }, formatStamp(entry.at)),
        ),
      )
      return h(
        Section,
        { name: 'passport', title: 'Provenance' },
        h('div', { className: 'dsr-sub' }, 'Your instructions, verbatim'),
        instructions.length === 0 ? h('div', { className: 'dsr-note' }, 'No instruction has been recorded for this run yet.') : null,
        ...quotes,
        h('div', { className: 'dsr-sub' }, 'What the agent did'),
        receipts.length === 0 ? h('div', { className: 'dsr-note' }, 'No tool call has been receipted yet.') : null,
        h('ul', { className: 'dsr-receipts' }, ...rows),
      )
    }

    /**
     * The claims ledger, as a reader needs it: what was asserted, how far it has
     * been checked, and what it rests on.
     *
     * The status is a CHIP and not a sentence, because the whole column is a
     * status board: a person scanning it must see which claims are unverified
     * without reading. The tier and the judge are shown beside it because "who
     * decided this, and at which rung" is the question a reader asks of every
     * verdict - and a claim with no binding says so on its own line, since a claim
     * that can never pass r1 is the one most worth seeing.
     */
    function ClaimsSection(props) {
      const claims = listOf(props.claims)
      const roll = statusRoll(claims)
      const summary = Object.keys(roll).length === 0 ? '' : Object.entries(roll).map(([status, count]) => count + ' ' + status).join(', ')
      return h(
        Section,
        { name: 'claims', title: 'Claims (' + claims.length + (summary === '' ? '' : ': ' + summary) + ')' },
        claims.length === 0 ? h('div', { className: 'dsr-note' }, 'No claim yet. A claim is a `[sentence]{#c0142}` span in the text, declared with the sources it rests on.') : null,
        ...claims.map((claim) =>
          h(
            'div',
            { key: 'claim-' + String(claim.id), className: 'dsr-claim', 'data-dsr-claim': String(claim.id) },
            h(
              'div',
              { className: 'dsr-claimHead' },
              h('span', { className: 'dsr-claimId' }, String(claim.id)),
              h('span', { className: 'dsr-st', 'data-status': String(claim.status) }, String(claim.status)),
              claim.tier === '' ? null : h('span', { className: 'dsr-claimId' }, String(claim.tier)),
              claim.strengthVerdict === '' ? null : h('span', { className: 'dsr-claimId' }, 'written as ' + String(claim.strength) + ', ' + String(claim.strengthVerdict)),
              claim.section === '' ? null : h('span', { className: 'dsr-claimId' }, '§' + String(claim.section)),
            ),
            h('div', { className: 'dsr-claimText' }, String(claim.text)),
            h(
              'div',
              { className: 'dsr-claimMeta' },
              listOf(claim.sources).length === 0
                ? h('span', null, 'no source bound: this claim cannot pass r1')
                : h(
                    'span',
                    { className: 'dsr-bind' },
                    listOf(claim.sources)
                      .map((binding) => String(binding.key) + (binding.locator === '' ? '' : ' · ' + String(binding.locator)))
                      .join('; '),
                  ),
              claim.judge === '' ? null : h('span', null, 'judged by ' + String(claim.judge)),
            ),
            claim.reason === '' ? null : h('div', { className: 'dsr-note' }, String(claim.reason)),
          ),
        ),
      )
    }

    /**
     * The sources ledger: what is in it, and - the part that decides what can be
     * checked - whether it carries bytes and text at all.
     *
     * "no text" is not decoration: with no text, `r2-locate` has nothing to search,
     * so a quote can never be confirmed against that source. Saying so where the
     * source is listed is what stops a run looking fully cited when it is not.
     */
    function SourcesSection(props) {
      const sources = listOf(props.sources)
      return h(
        Section,
        { name: 'sources', title: 'Sources (' + sources.length + ')' },
        sources.length === 0 ? h('div', { className: 'dsr-note' }, 'No source yet. The agent ingests one with `rs_cite` - this plugin fetches nothing itself.') : null,
        ...sources.map((source) =>
          h(
            'div',
            { key: 'src-' + String(source.key), className: 'dsr-src', 'data-dsr-source': String(source.key) },
            h(
              'div',
              { className: 'dsr-claimHead' },
              h('span', { className: 'dsr-srcKey' }, String(source.key)),
              h('span', { className: 'dsr-claimId' }, String(source.kind) + (source.year === '' ? '' : ' · ' + String(source.year))),
              h('span', { className: 'dsr-claimId', 'data-dsr-bytes': source.files === 0 ? 'none' : 'some' }, source.files === 0 ? 'no bytes' : source.files + ' file(s)'),
              h('span', { className: 'dsr-claimId', 'data-dsr-text': source.hasText ? 'yes' : 'none' }, source.hasText ? 'text from ' + String(source.textSource) : 'no text'),
            ),
            h('div', { className: 'dsr-srcTitle' }, String(source.title)),
          ),
        ),
      )
    }

    /** The document as it stands: the outline, with the words and claims in each part. */
    function OutlineSection(props) {
      const outline = outlineOf(props.project)
      return h(
        Section,
        { name: 'outline', title: 'Outline' },
        outline.sections.length === 0
          ? h('div', { className: 'dsr-note' }, 'Nothing written yet. `rs_write` writes a section; the panel can edit it afterwards.')
          : h(
              'div',
              { 'data-dsr-outline': String(outline.sections.length) },
              h('div', { className: 'dsr-note' }, outline.words + ' words, ' + outline.citations + ' source(s) cited' + (outline.parts.length > 0 ? ', assembled from ' + outline.parts.map((part) => String(part.file)).join(', ') : '')),
              ...outline.sections.map((section) =>
                h(
                  'div',
                  { key: 'section-' + String(section.slug), className: 'dsr-outlineRow' },
                  h('span', { className: 'dsr-outlineTitle', title: String(section.title), style: { paddingLeft: Math.max(0, Number(section.level) - 1) * 8 } }, String(section.title)),
                  h('span', { className: 'dsr-outlineNum' }, String(section.words) + 'w · ' + String(section.claims) + 'c'),
                ),
              ),
            ),
      )
    }

    /**
     * Build, from the panel.
     *
     * `draft=watermark` always builds - it is the mode that says out loud what has
     * not been checked - and `clean` is the one that has to hold up, so the refusal
     * it can answer with is shown where the button is rather than in a banner.
     */
    function BuildSection(props) {
      const formats = buildFormats(props.ready)
      const [draft, setDraft] = React.useState('watermark')
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [failed, setFailed] = React.useState(null)

      const run = async (id) => {
        setBusy(id)
        setFailed(null)
        setResult(null)
        const answer = await props.onBuild(id, draft)
        setBusy('')
        if (answer === null || answer === undefined) return
        if (answer.ok === true) setResult(answer)
        else setFailed(answer)
      }

      return h(
        Section,
        { name: 'build', title: 'Build' },
        h(
          'div',
          { className: 'dsr-buildRow' },
          ...formats.map((format) =>
            h(
              'button',
              {
                key: format.id,
                type: 'button',
                className: 'dsr-btn',
                disabled: busy !== '',
                title: 'write build/' + (format.id === 'md' ? 'paper.md' : format.id === 'package' ? 'submission/' : format.id === 'html' ? 'paper.html' : format.id === 'tex' ? 'paper.tex' : 'references.' + format.id),
                'data-dsr-build': format.id,
                'data-dsr-ready': 'yes',
                onClick: () => run(format.id),
              },
              busy === format.id ? 'Building…' : format.id,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsr-buildRow' },
          ...['watermark', 'clean'].map((mode) =>
            h(
              'button',
              {
                key: mode,
                type: 'button',
                className: 'dsr-btn',
                'aria-current': draft === mode ? 'true' : undefined,
                'data-dsr-draft': mode,
                onClick: () => setDraft(mode),
              },
              mode === 'watermark' ? 'draft (watermarked)' : 'clean (gated)',
            ),
          ),
        ),
        h('div', { className: 'dsr-hint' }, draft === 'clean' ? 'A clean build refuses while the document and its ledger disagree, while a claim is unsupported, or until gate `g3-integrity` is answered.' : 'A draft always builds, and marks every claim that nothing has checked.'),
        failed === null ? null : h('div', { className: 'dsr-err', 'data-dsr-build-error': String(failed.code ?? 'error') }, String(failed.message ?? 'the build was refused')),
        result === null
          ? null
          : h(
              'div',
              { className: 'dsr-buildOut', 'data-dsr-built': String(listOf(result.outputs).length) },
              ...listOf(result.outputs).map((output) =>
                h('div', { key: 'out-' + String(output.path) }, h('code', null, String(output.path)), '  ' + formatBytes(output.bytes) + '  sha256 ' + String(output.sha256).slice(0, 12) + '…'),
              ),
              h('div', null, 'the report is in build/build.json'),
            ),
      )
    }

    /**
     * The run's files, with the size a reader can weigh.
     *
     * A `.md` file under `doc/` or `plan/` is a BUTTON: those are the two places a
     * person edits prose, and the whole point of this panel is that the research is
     * yours to change. Everything else - the ledgers, the stored sources, the build
     * output - is listed and not editable, because hand-editing a ledger is how a
     * record stops being a record.
     */
    function FileList(props) {
      const files = listOf(props.files)
      const edit = typeof props.onEdit === 'function' ? props.onEdit : null
      const rows = files.map((file, index) => {
        const path = String(file.path ?? '')
        const editable = edit !== null && /^(doc|plan)\/.+\.md$/.test(path)
        const inner = [
          h('span', { key: 'p', className: 'dsr-filePath', title: path }, path),
          h('span', { key: 's', className: 'dsr-fileSize' }, formatBytes(file.bytes)),
          editable ? h('span', { key: 'e', className: 'dsr-fileEdit' }, 'edit') : null,
        ]
        return h(
          'li',
          { key: 'file-' + index, className: 'dsr-file' },
          editable
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsr-fileBtn',
                  'data-dsr-file': path,
                  'aria-current': props.openPath === path ? 'true' : undefined,
                  onClick: () => edit(path),
                },
                ...inner,
              )
            : h('div', { className: 'dsr-fileBtn' }, ...inner),
        )
      })
      return h(
        Section,
        { name: 'files', title: 'Files (' + files.length + ')' },
        files.length === 0 ? h('div', { className: 'dsr-note' }, 'This run holds no file yet.') : null,
        h('ul', { className: 'dsr-files' }, ...rows),
      )
    }

    /**
     * One text file of a run, edited in place.
     *
     * This is the panel's answer to "I want to edit my own research". It is
     * deliberately NOT the agent's write path: `rs_write` REFUSES prose whose
     * claims are not declared, because an agent must not be able to invent a claim
     * nothing tracks. A person may do exactly that - you are allowed to type a
     * sentence - so the save is not refused. It is CHECKED instead, and the route
     * answers with the structure verdict that this component renders immediately:
     * delete a claim's marker and the panel says `span-unrecorded` on the spot,
     * rather than at the next build.
     *
     * The draft survives a poll while it is being typed. The tab re-reads the run
     * every 1500 ms, so a save that silently replaced the textarea with the agent's
     * newer version would lose work: the props re-seed the box only while the
     * person has not touched it.
     */
    function FileEditor(props) {
      const file = String(props.file ?? '')
      const [text, setText] = React.useState(String(props.text ?? ''))
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(null)
      const touched = React.useRef(false)
      const verdict = props.verdict === undefined ? null : props.verdict

      React.useEffect(() => {
        touched.current = false
        setText(String(props.text ?? ''))
        setFailed(null)
      }, [file])
      React.useEffect(() => {
        if (!touched.current) setText(String(props.text ?? ''))
      }, [props.text])

      const save = async () => {
        setSaving(true)
        setFailed(null)
        const message = await props.onSave(file, text)
        setSaving(false)
        if (message !== null && message !== undefined) setFailed(String(message))
        else touched.current = false
      }

      const verdictBlock =
        verdict === null
          ? null
          : h(
              'div',
              { className: 'dsr-verdict', 'data-dsr-verdict': verdict.ok === true ? 'ok' : 'problems' },
              h(
                'div',
                null,
                verdict.ok === true
                  ? 'Saved. The document still agrees with its ledger.'
                  : 'Saved, and the document no longer agrees with its ledger:',
              ),
              verdict.ok === true ? null : h('div', { className: 'dsr-verdictLine' }, 'words ' + String(verdict.words) + ', claims ' + String(verdict.claims)),
              ...listOf(verdict.errors).map((one, index) =>
                h('div', { key: 'err-' + index, className: 'dsr-verdictLine' }, '· ' + String(one.code) + ': ' + String(one.detail)),
              ),
              ...listOf(verdict.warnings).map((one, index) =>
                h('div', { key: 'warn-' + index, className: 'dsr-verdictLine' }, '· ' + String(one.code) + ': ' + String(one.detail)),
              ),
            )

      return h(
        Section,
        { name: 'editor', title: 'Editing' },
        h(
          'div',
          { className: 'dsr-editor' },
          h(
            'div',
            { className: 'dsr-editorHead' },
            h('span', { className: 'dsr-editorPath', title: file }, file),
            h('button', { type: 'button', className: 'dsr-btn', disabled: saving, 'data-dsr-save': file, onClick: save }, saving ? 'Saving…' : 'Save'),
            h('button', { type: 'button', className: 'dsr-btn', onClick: () => props.onClose() }, 'Close'),
          ),
          h('textarea', {
            className: 'dsr-code',
            'data-dsr-field': 'document',
            'aria-label': 'the text of ' + file,
            spellCheck: false,
            value: text,
            onChange: (event) => {
              touched.current = true
              setText(event.target.value)
            },
          }),
          h('div', { className: 'dsr-hint' }, 'Saved to the run folder on disk, so it is there in every session and in any editor. `[sentence]{#c0142}` marks a claim; `[@key]` cites a source.'),
          failed === null ? null : h('div', { className: 'dsr-err', 'data-dsr-edit-error': 'save' }, failed),
          verdictBlock,
        ),
      )
    }

    /**
     * What a person sees when the root holds no run.
     *
     * The exact tool call is named, with the shape of each argument, because the
     * alternative - "no runs yet" - leaves someone who has never used this plugin
     * with nowhere to go.
     */
    function EmptyState() {
      return h(
        'div',
        { className: 'dsr-empty', 'data-dsr-state': 'empty' },
        h('div', { className: 'dsr-emptyTitle' }, 'No research run yet'),
        h('div', null, 'This root holds no run. Ask the agent to start one:'),
        h('code', { className: 'dsr-cmd' }, NEW_RUN_HINT),
      )
    }

    // -----------------------------------------------------------------------
    // The tab body
    // -----------------------------------------------------------------------
    /**
     * The Research column: the run picker, the selected run, and its gates first.
     *
     * The poll is one interval for BOTH reads - `state` and the selected
     * `project` - because they are only useful together: a run list from a newer
     * moment beside a project from an older one would show a pending count that
     * its own detail column denies. The refs keep it honest: `busy` refuses a
     * second read while one (or a POST) is in flight, `mounted` drops an answer
     * that arrives after unmount, and `reread` restarts the read a click asked
     * for when that read was refused because another one was running.
     */
    function ResearchBody() {
      const [payload, setPayload] = React.useState(null)
      const [project, setProject] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [problem, setProblem] = React.useState(null)
      const [projectProblem, setProjectProblem] = React.useState(null)
      const [actionProblem, setActionProblem] = React.useState(null)
      // The panel's own edit state: which file is open, its text, and the
      // structure verdict the last save came back with.
      const [editing, setEditing] = React.useState(null)
      const [editingText, setEditingText] = React.useState(null)
      const [verdict, setVerdict] = React.useState(null)

      const mounted = React.useRef(true)
      const busy = React.useRef(false)
      const selectedRef = React.useRef(null)
      const readRef = React.useRef(null)
      const reread = React.useRef(false)

      /** One read of state plus the selected run's project. Refuses to overlap. */
      const read = React.useCallback(async () => {
        if (busy.current) return
        busy.current = true
        try {
          const answer = await fetchJson(STATE_ROUTE)
          if (!mounted.current) return
          setPayload(answer)
          setProblem(null)
          const runs = runsOf(answer)
          // The selection survives a poll only while its run still exists: a
          // deleted run must not leave the column showing a project nobody lists.
          let next = selectedRef.current
          if (next === null || !runs.some((run) => String(run.slug) === next)) next = runs.length > 0 ? String(runs[0].slug) : null
          if (next !== selectedRef.current) {
            selectedRef.current = next
            setSelected(next)
          }
          if (next === null) {
            setProject(null)
            setProjectProblem(null)
            return
          }
          try {
            const detail = await fetchJson(projectQuery(next))
            if (!mounted.current) return
            // The person can pick another run while this read is in flight.
            // Applying the older run's project then would put one run's gates
            // under another run's highlighted row, so the answer is dropped and
            // the retry in `finally` reads the run that is selected NOW.
            if (next !== selectedRef.current) return
            setProject(detail)
            setProjectProblem(null)
          } catch (err) {
            if (!mounted.current || next !== selectedRef.current) return
            setProjectProblem(problemText(err))
          }
        } catch (err) {
          // The last good payload stays on screen: a stale column beside the real
          // reason beats a blank one, and the banner names the failure.
          if (!mounted.current) return
          setProblem(problemText(err))
        } finally {
          busy.current = false
          if (reread.current && mounted.current) {
            reread.current = false
            readRef.current()
          }
        }
      }, [])
      readRef.current = read

      /** Pick a run, and load its project at once rather than at the next tick. */
      const select = React.useCallback(
        (slug) => {
          selectedRef.current = slug
          setSelected(slug)
          setActionProblem(null)
          setProject(null)
          setProjectProblem(null)
          reread.current = true
          read()
        },
        [read],
      )

      /**
       * Record one answer, then re-read.
       *
       * The POST holds `busy` for its whole life, which is what stops a poll from
       * racing it, and it is released BEFORE the re-read so the re-read is not
       * refused by the very guard the POST just set. The answer resolves to `null`
       * on success and to the route's own message on failure, so the form can
       * show the refusal where the person is looking.
       */
      const submitGate = React.useCallback(
        async (gate, draft) => {
          if (selectedRef.current === null) return 'No run is selected.'
          busy.current = true
          setActionProblem(null)
          try {
            await fetchJson(GATE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(gatePayload(selectedRef.current, gate, draft)),
            })
          } catch (err) {
            const message = problemText(err)
            setActionProblem(message)
            return message
          } finally {
            busy.current = false
          }
          await read()
          return null
        },
        [read],
      )

      /**
       * Open one text file for editing: read it, then show the box.
       *
       * The read is a ROUTE rather than a tool call, because the panel is not the
       * agent: `rs_read what=file` is the agent's reader, and a person clicking a
       * file in their own run should not need a tool round trip.
       */
      const openFile = React.useCallback(async (path) => {
        if (selectedRef.current === null) return
        setEditing(path)
        setEditingText(null)
        setVerdict(null)
        setActionProblem(null)
        try {
          const answer = await fetchJson(FILE_ROUTE + '?slug=' + encodeURIComponent(selectedRef.current) + '&file=' + encodeURIComponent(path))
          if (!mounted.current) return
          setEditingText(typeof answer.text === 'string' ? answer.text : '')
        } catch (err) {
          if (!mounted.current) return
          setEditing(null)
          setActionProblem(problemText(err))
        }
      }, [])

      const closeFile = React.useCallback(() => {
        setEditing(null)
        setEditingText(null)
        setVerdict(null)
      }, [])

      /**
       * Save one edited file, and keep the route's verdict.
       *
       * The POST holds `busy` so a poll cannot overwrite the panel mid-save, and
       * the project is re-read afterwards so the file list's sizes and the ledger
       * counts are the ones on disk.
       */
      const saveFile = React.useCallback(
        async (path, text) => {
          if (selectedRef.current === null) return 'No run is selected.'
          busy.current = true
          try {
            const answer = await fetchJson(FILE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ slug: selectedRef.current, file: path, text }),
            })
            if (mounted.current && answer !== null && answer.structure !== undefined) setVerdict(answer.structure)
          } catch (err) {
            return problemText(err)
          } finally {
            busy.current = false
          }
          await read()
          return null
        },
        [read],
      )

      /**
       * Build one format, and hand the answer back to the section that asked.
       *
       * The refusal is RETURNED rather than thrown into the banner, because a
       * refusal is the expected answer here: `draft=clean` refuses until the gate is
       * answered, and a format this build does not have refuses by name. Either
       * belongs beside the button that caused it, where the person can read why and
       * what to do, not in a strip at the top of the column.
       */
      const buildNow = React.useCallback(
        async (format, draft) => {
          if (selectedRef.current === null) return { ok: false, code: 'NO_RUN', message: 'No run is selected.' }
          busy.current = true
          let answer = null
          try {
            answer = await fetchJson(BUILD_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ slug: selectedRef.current, format, draft }),
            })
          } catch (err) {
            busy.current = false
            return { ok: false, code: err !== null && err !== undefined && typeof err.code === 'string' ? err.code : 'ERROR', message: problemText(err) }
          }
          busy.current = false
          // The build wrote files, so the run's file list and ledger counts are
          // stale the moment it returns.
          await read()
          return answer
        },
        [read],
      )

      // The poll. Started once, stopped while the document is hidden, and fired
      // immediately when it comes back - a tab nobody is looking at must not read
      // a disk every 1500 ms, and a tab that just became visible must not show
      // the moment it was hidden.
      React.useEffect(() => {
        let timer = null
        const stop = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const start = () => {
          if (timer === null) {
            timer = setInterval(() => {
              if (!hidden()) read()
            }, POLL_MS)
          }
        }
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const onVisibility = () => {
          if (hidden()) stop()
          else {
            read()
            start()
          }
        }
        mounted.current = true
        read()
        if (!hidden()) start()
        if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility)
        return () => {
          mounted.current = false
          stop()
          if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [read])

      const runs = runsOf(payload)
      const pending = pendingGates(project)
      const answered = answeredGates(project)
      const row = selected === null ? null : runs.find((item) => String(item.slug) === selected) ?? null
      const head = project !== null && project.run !== null && project.run !== undefined ? project.run : row
      const root = payload === null || payload.root === null || payload.root === undefined ? null : payload.root
      const stateNotes = payload === null ? [] : listOf(payload.notes)
      const projectNotes = project === null ? [] : listOf(project.notes)

      // One banner for every failure the column can report, with the retry beside
      // it. It is never conditional on the payload having arrived: the worst case
      // is a stale column AND the sentence that says why.
      const message = problem !== null ? problem : actionProblem
      const banner =
        message === null
          ? null
          : h(
              'div',
              { className: 'dsr-banner', 'data-dsr-problem': problem === null ? 'action' : 'state' },
              h('span', { className: 'dsr-bannerText' }, message),
              h('button', { type: 'button', className: 'dsr-btn', onClick: () => read() }, 'Read again'),
            )

      const picker =
        payload === null
          ? null
          : h(
              'div',
              { className: 'dsr-runs', 'data-dsr-runs': String(runs.length) },
              ...runs.map((item) => h(RunRow, { key: String(item.slug), run: item, selected: String(item.slug) === selected, onSelect: select })),
            )

      let panel = null
      if (payload === null) {
        panel =
          problem === null
            ? h('div', { className: 'dsr-empty', 'data-dsr-state': 'reading' }, h('div', { className: 'dsr-emptyTitle' }, 'Reading the research root…'))
            : h(
                'div',
                { className: 'dsr-empty', 'data-dsr-state': 'unreadable' },
                h('div', { className: 'dsr-emptyTitle' }, 'The research root could not be read'),
                h('div', { className: 'dsr-err' }, problem),
              )
      } else if (runs.length === 0) {
        panel = h(EmptyState, null)
      } else if (project === null) {
        panel = h('div', { className: 'dsr-detail', 'data-dsr-detail': selected === null ? '' : selected }, h(RunHeader, { run: head }), h('div', { className: 'dsr-note' }, 'Reading the run…'))
      } else {
        const structure = structureOf(project)
        const readyFormats = payload === null || payload.capabilities === undefined || payload.capabilities === null ? [] : listOf(payload.capabilities.formats)
        // The strip's own numbers, computed once: the families below group the
        // same data, and a second count would be a second truth.
        const claimRows = claimsOf(project)
        const sourceRows = sourcesOf(project)
        const roll = statusRoll(claimRows)
        const supported = Number(roll['supported'] ?? 0)
        const waitingCount = pending.length
        const stageText = stageLabel(head === null || head === undefined ? '' : head.stage)
        const statusStrip = h(
          'div',
          { className: 'dsr-statusbar', 'data-dsr-statusbar': '1' },
          h(Stat, { label: 'stage: ' + (stageText === '' ? 'framed' : stageText) }),
          h(Stat, { label: waitingCount === 0 ? 'no decision waiting' : waitingCount + ' waiting on you', tone: waitingCount === 0 ? 'ok' : 'warn' }),
          h(Stat, { label: supported + '/' + claimRows.length + ' supported', tone: claimRows.length > 0 && supported === claimRows.length ? 'ok' : undefined }),
          h(Stat, { label: sourceRows.length + ' source(s)' }),
          h(Stat, { label: structure.ok ? 'document agrees' : structure.errors + ' structure error(s)', tone: structure.ok ? 'ok' : 'bad' }),
        )
        panel = h(
          'div',
          { className: 'dsr-detail', 'data-dsr-detail': selected === null ? '' : selected },
          h(RunHeader, { run: head }),
          statusStrip,
          projectNotes.length === 0 ? null : h('div', { className: 'dsr-notes' }, ...projectNotes.map((line, index) => h('div', { key: 'note-' + index, className: 'dsr-note' }, String(line)))),
          projectProblem === null ? null : h('div', { className: 'dsr-err', 'data-dsr-problem': 'project' }, projectProblem),
          // Six families, in the order a run is actually worked on: the frame a
          // person answered, the plan they agreed to, the document as it stands, the
          // evidence under it, the build, and the record of how it all came to be.
          // Only the frame opens by itself, and only while it is waiting on somebody.
          h(
            Group,
            {
              name: 'frame',
              title: '1 · Frame',
              meta: waitingCount > 0 ? waitingCount + ' waiting · ' + answered.length + ' answered' : answered.length + ' answered',
              tone: waitingCount > 0 ? 'warn' : 'ok',
              toneLabel: waitingCount > 0 ? 'needs you' : 'settled',
              defaultOpen: waitingCount > 0,
            },
            h(
              Section,
              { name: 'gates', title: waitingCount > 0 ? 'Waiting on you (' + waitingCount + ')' : 'Gates' },
              waitingCount === 0
                ? h('div', { className: 'dsr-note' }, answered.length > 0 ? 'Nothing is waiting on you.' : 'This run has no gate yet.')
                : h('div', { 'data-dsr-pending': String(waitingCount) }, ...pending.map((gate) => h(GateForm, { key: String(gate.id), gate, onSubmit: submitGate }))),
            ),
            h(AnsweredTimeline, { gates: answered }),
          ),
          h(
            Group,
            {
              name: 'plan',
              title: '2 · Plan',
              meta: (project.outline === null || project.outline === undefined ? 0 : project.outline.sections.length) + ' section(s)',
              defaultOpen: false,
            },
            h(PlanSection, { plan: project.plan }),
            h(OutlineSection, { project }),
          ),
          h(
            Group,
            {
              name: 'document',
              title: '3 · Document',
              meta: (project.document === null || project.document === undefined ? 0 : project.document.words) + ' words',
              tone: structure.ok ? 'ok' : 'bad',
              toneLabel: structure.ok ? 'agrees' : 'conflict',
              defaultOpen: true,
            },
            h(
              'div',
              { className: 'dsr-note', 'data-dsr-structure': structure.ok ? 'ok' : 'problems' },
              structure.ok
                ? 'The document agrees with its ledger' + (structure.warnings > 0 ? ' (' + structure.warnings + ' warning(s): ' + structure.codes.join(', ') + ')' : '')
                : structure.errors + ' structure error(s): ' + structure.codes.join(', ') + ' - a draft still builds; a clean one will not',
            ),
            h(FileList, { files: project.files, onEdit: openFile, openPath: editing }),
            editing === null
              ? null
              : editingText === null
                ? h('div', { className: 'dsr-note', 'data-dsr-editor': 'reading' }, 'Reading ' + editing + '…')
                : h(FileEditor, { key: editing, file: editing, text: editingText, verdict, onSave: saveFile, onClose: closeFile }),
          ),
          h(
            Group,
            {
              name: 'evidence',
              title: '4 · Evidence',
              meta: claimRows.length + ' claim(s) · ' + sourceRows.length + ' source(s)',
              defaultOpen: false,
            },
            h(ClaimsSection, { claims: claimRows }),
            h(SourcesSection, { sources: sourceRows }),
          ),
          h(Group, { name: 'build', title: '5 · Build', meta: readyFormats.length + ' format(s) ready', defaultOpen: false }, h(BuildSection, { ready: readyFormats, onBuild: buildNow })),
          h(Group, { name: 'provenance', title: '6 · Provenance', meta: 'instructions and receipts', defaultOpen: false }, h(PassportBlock, { passport: project.passport })),
        )
      }

      const foot =
        root === null
          ? null
          : h(
              'div',
              { className: 'dsr-foot' },
              h('div', { className: 'dsr-footLine', title: String(root.path ?? '') }, 'root: ' + String(root.path ?? '') + ' (' + String(root.source ?? 'unknown') + (root.exists === false ? ', missing' : '') + ')'),
              stateNotes.length === 0 ? null : h('div', { className: 'dsr-footLine', title: stateNotes.join(' · ') }, stateNotes.join(' · ')),
            )

      return h('div', { className: 'dsr', 'data-dsr-root': 'research' }, banner, picker, panel, foot)
    }

    /**
     * The tab's title strip.
     *
     * A page type has no address to read, and this seat renders before (and
     * independently of) the body's own state, so it is a fixed word: anything
     * drawn from the payload here would need shared state the bar does not hand
     * a title seat.
     */
    function ResearchTitle() {
      return h('span', { className: 'dsr-title' }, 'Research')
    }

    // -----------------------------------------------------------------------
    // The tab type
    // -----------------------------------------------------------------------
    /**
     * The `research` page type.
     *
     * `id` and `kind` are the same string, and there are deliberately NO
     * `patterns` and no `canOpen`: a run is a page a person opens from the Start
     * page, not a file extension, so claiming one would take a surface away from
     * a file type the pack already opens.
     *
     * The guide capsule's contract is the BAR's, not this package's: the Start
     * page calls `entry.title()` and `entry.description()` while it builds the
     * capsule, so BOTH are functions - a string in either field throws inside the
     * Start page's own render, and the slot core abdicates the entry it crashed
     * in, which is the whole Start body rather than the one capsule. `order` 80
     * places the capsule behind the Lab (70), the console (60) and PDFs (50): this
     * column is a place to answer, and the working surfaces come first.
     */
    function definition() {
      return {
        id: TYPE_ID,
        kind: TYPE_ID,
        title: () => 'Research',
        guide: [
          {
            id: TYPE_ID + '/runs',
            order: 80,
            title: () => 'Research',
            description: () => 'Every research run on disk: answer the questions the agent is waiting on, in your own words.',
          },
        ],
      }
    }

    /** Activation waits for the tab registry and the two keyed seats it occupies. */
    const inject = ['slots', 'sidebarRightTabs']

    /**
     * Activate the browser half.
     * @param ctx - cordis context (inject: slots, sidebarRightTabs).
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'dsh-research: tab type')
      } catch (err) {
        // A profile without the pack's right bar still gets the host tools and
        // the skills; only the tab is missing, and saying so is the honest answer.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-research] no right bar in this profile - the Research tab was not registered')
        }
        return
      }
      ctx.effect(
        () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, ResearchBody)),
        'dsh-research: run body',
      )
      ctx.effect(
        () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, ResearchTitle)),
        'dsh-research: run title',
      )
    }

    exports.name = 'dsh-research'
    exports.inject = inject
    exports.apply = apply
    /**
     * The pure half, so the tracked check can drive it without a browser, plus
     * the render pieces that take plain props: a server render runs no effect, so
     * the body a check can reach is always its reading state - which would leave
     * the gate form, the timeline, the passport and the file list untested markup.
     */
    exports.__internals = {
      definition, ResearchBody, ResearchTitle,
      RunRow, RunHeader, GateForm, AnsweredTimeline, PassportBlock, FileList, FileEditor, EmptyState,
      ClaimsSection, SourcesSection, OutlineSection, BuildSection,
      // payload readers and labels
      listOf, runsOf, gatesOf, optionsOf, pendingCount, isAnswered, pendingGates, answeredGates,
      answerLabel, answerText, runLabel, stageLabel, STAGE_LABELS,
      claimsOf, sourcesOf, outlineOf, structureOf, statusRoll, buildFormats,
      // formatting
      formatStamp, formatBytes, truncate,
      // what the POST is allowed to carry
      wantsReason, gatePayload, projectQuery,
      // the network, and every failure as a string
      fetchJson, errorMessageOf, problemText,
      // identity, addresses and the one sentence the form promises
      TYPE_ID, TAB_SLOT, TITLE_SLOT, API_ROOT, STATE_ROUTE, PROJECT_ROUTE, GATE_ROUTE, FILE_ROUTE, BUILD_ROUTE,
      CSS_TAG, POLL_MS, QUESTION_CUT, VERBATIM_NOTE, NEW_RUN_HINT,
    }

    return module.exports
  },
})
