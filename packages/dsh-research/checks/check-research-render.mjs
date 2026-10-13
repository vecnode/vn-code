// check-research-render.mjs - the Research tab, rendered in a REAL browser against a
// fixture run, and MEASURED.
//
// This is the one item phase 2 carried from the beginning: "the panel's own layout
// would be verified rather than only its payload". Every other check in this package
// reads what the host half computes; `check-client-bundles.mjs` renders the tab's
// MARKUP through a server render, which runs no effect - so what it can reach is the
// panel's reading state, and its own comment says so: "the gate form, the timeline,
// the passport and the file list [would be] untested markup".
//
// So this check opens the bundle in a Chromium-family browser, against a fixture run
// served by the engine's OWN view code (`stateView` / `projectDetail`, the same two
// functions the row's routes call), and reads the geometry the browser actually
// laid out:
//
//   - the run list, with its `1 waiting` badge;
//   - the selected run's header, stage and root;
//   - the pending gate's FORM - a textarea and an enabled Submit, both with real
//     boxes, because a form a person cannot type into is the failure this item was
//     written for;
//   - the answered gate's timeline entry;
//   - the passport's provenance, quoted from the instruction in the user's words;
//   - the claims and sources sections;
//   - and that nothing overflows the page horizontally.
//
// What it does NOT prove: anything about taste. It proves the tab mounts, reads the
// host, lays out the controls a person has to use, and does not break the page.
//
// It needs a Chromium-family browser and React's UMD builds. With either missing it
// SKIPS LOUDLY and exits 0 - a check that downloads a browser or a framework to pass
// is not a check.
//
// Run:  node packages/dsh-research/checks/check-research-render.mjs [--keep]
//       npm run check:render      (from packages/dsh-research)
export {}

const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs')
const { promises: fsp } = await import('node:fs')
const { createServer } = await import('node:http')
const { spawn } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const pkgDir = path.join(repo, 'packages', 'dsh-research')
const keep = process.argv.includes('--keep')
let failures = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** A Chromium-family browser on this machine, or null. */
function findBrowser() {
  const configured = process.env.DSH_RESEARCH_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return null
}

/**
 * React's UMD builds, which are what a browser page can load.
 *
 * Resolved here rather than imported: a check may reach into the harness's install,
 * a package may not. React 19 dropped the UMD builds, so a host carrying only 19
 * skips loudly instead of failing - the tab itself does not care which React renders
 * it, and this check is about layout rather than about the runtime version.
 */
function findReactUmd() {
  const roots = []
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  roots.push(path.join(home, 'profiles', 'node_modules'), path.join(home, 'profiles', 'web', 'node_modules'))
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)) {
    const cache = path.join(base, 'npm-cache', '_npx')
    if (!existsSync(cache)) continue
    for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  const cache = path.join(os.homedir(), '.npm', '_npx')
  if (existsSync(cache)) for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  for (const root of roots) {
    const react = path.join(root, 'react', 'umd', 'react.development.js')
    const dom = path.join(root, 'react-dom', 'umd', 'react-dom.development.js')
    if (existsSync(react) && existsSync(dom)) return { react, dom, root }
  }
  return null
}

const browser = findBrowser()
const reactUmd = browser === null ? null : findReactUmd()
if (browser === null || reactUmd === null) {
  const why = browser === null ? 'no Chromium-family browser on this host' : 'no React UMD build found (React 19 and later ship none)'
  console.log('skip every research render check                          (' + why + ')')
  console.log('     set DSH_RESEARCH_BROWSER to a chrome/edge/chromium binary to run it')
  process.exitCode = 0
} else {
  console.log('browser: ' + browser)
  console.log('react:   ' + reactUmd.react)
  console.log('')

  const runModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'run.js')).href)
  const viewModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'view.js')).href)
  const ledgerModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'ledger.js')).href)
  const { createRun, resolveRoot, answerGate } = runModule
  const { projectDetail } = viewModule
  const { appendClaim, appendSource } = ledgerModule
  const stateView = runModule.stateView

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-research-render-'))
  const root = path.join(sandbox, 'root')
  const workspace = path.join(sandbox, 'workspace')
  await fsp.mkdir(workspace, { recursive: true })
  const env = { ...process.env, DSH_HOME: path.join(sandbox, 'dsh-home'), DSH_RESEARCH_ROOT: root }
  const SLUG = 'rendered-run'
  // The instruction is what the passport quotes VERBATIM, so it is written the way a
  // person would say it, contractions and all.
  const INSTRUCTION = "Can you put together a literature review on sleep and memory? I'd like it in APA."

  // -------------------------------------------------------------------------
  // The fixture: a run with one gate answered and one still pending, so the panel
  // has the "waiting" badge, a form to fill and a timeline to show.
  // -------------------------------------------------------------------------
  await createRun({ root, slug: SLUG, title: 'Sleep and memory: a review', kind: 'lit-review', language: 'en', style: 'apa7', instruction: INSTRUCTION })
  await answerGate({ root, slug: SLUG, id: 'g1-rq', value: 'confirm', text: 'This is the question, and it is mine.' })
  const dir = path.join(root, SLUG)
  await appendSource(
    dir,
    {
      key: 'okonkwo2026',
      kind: 'journal-article',
      title: 'Sleep restriction and next-day recall',
      authors: [{ family: 'Okonkwo', given: 'A.' }],
      year: '2026',
      container: 'Journal of Sleep Research',
      pages: '45-67',
    },
    undefined,
  )
  await appendClaim(
    dir,
    {
      id: 'c0001',
      text: 'Sleep restriction was associated with lower next-day recall.',
      section: 'results',
      strength: 'associational',
      sources: [{ key: 'okonkwo2026', locator: { kind: 'quote', quote: 'recall was lower after restriction' } }],
    },
    undefined,
  )
  await fsp.writeFile(
    path.join(dir, 'doc', 'paper.md'),
    '# Sleep and memory\n\n## Results\n\n[Sleep restriction was associated with lower next-day recall.]{#c0001} See [@okonkwo2026, p. 7].\n',
    'utf8',
  )

  // -------------------------------------------------------------------------
  // The page: React, then the bundle through the loader the harness itself uses,
  // then the tab's own body component rendered into a real container.
  // -------------------------------------------------------------------------
  const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-research render check</title>
<style>html,body{margin:0;background:#111;color:#eee;font:14px/1.5 system-ui,sans-serif}#panel{width:760px;height:640px;overflow:auto}</style>
</head><body>
<div id="panel"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  // The loader the harness registers each bundle through, and the console errors a
  // real render would raise - both collected, because a React error boundary that
  // swallowed a crash would otherwise look like a tidy empty panel.
  window.__errors = []
  window.onerror = (message) => { window.__errors.push(String(message)) }
  window.addEventListener('unhandledrejection', (event) => { window.__errors.push('unhandled rejection: ' + String(event.reason)) })
  const originalError = console.error
  console.error = (...args) => { window.__errors.push(args.map(String).join(' ')); originalError.apply(console, args) }
  window.__ModuleLoader__ = { load: (entry) => { window.__entry = entry } }
</script>
<script src="/bundle.js"></script>
<script>
(async () => {
  const post = (value) => fetch('/report', { method: 'POST', body: JSON.stringify(value) }).catch(() => {})
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const box = (node) => {
    if (node === null || node === undefined) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  }
  const visible = (node) => { const b = box(node); return b !== null && b.width > 0 && b.height > 0 }
  const report = { errors: [], steps: [] }
  try {
    const entry = window.__entry
    if (entry === undefined) throw new Error('the bundle did not register with the module loader')
    report.bundleId = entry.id
    const module = entry.factory((name) => {
      if (name === 'react') return window.React
      if (name === 'react/jsx-runtime') return { jsx: window.React.createElement, jsxs: window.React.createElement, Fragment: window.React.Fragment }
      if (name === 'react-dom') return window.ReactDOM
      if (name === 'react-dom/client') return window.ReactDOM
      return {}
    })
    const A = module === undefined || module.__internals === undefined ? undefined : module.__internals
    if (A === undefined) throw new Error('the bundle exposed no __internals')

    const container = document.getElementById('panel')
    window.ReactDOM.createRoot(container).render(window.React.createElement(A.ResearchBody))

    // Wait for the panel to have READ the host and selected the run: the effect that
    // fetches is exactly what a server render never runs.
    const deadline = Date.now() + 20000
    let detail = document.querySelector('[data-dsr-detail]')
    while (Date.now() < deadline) {
      detail = document.querySelector('[data-dsr-detail]')
      if (detail !== null && detail.getAttribute('data-dsr-detail') !== '' && document.querySelector('[data-dsr-gate]') !== null) break
      await wait(200)
    }
    report.steps.push('settled after ' + (20000 - (deadline - Date.now())) + 'ms')

    const rootNode = document.querySelector('[data-dsr-root]')
    const runRow = document.querySelector('[data-dsr-slug]')
    const badge = runRow === null ? null : runRow.querySelector('.dsr-badge')
    const pending = document.querySelector('[data-dsr-pending]')
    const gate = document.querySelector('[data-dsr-gate]')
    const area = document.querySelector('[data-dsr-field="text"]')
    const reason = document.querySelector('[data-dsr-field="reason"]')
    const submit = gate === null ? null : gate.querySelector('[data-dsr-submit]')
    const quote = document.querySelector('[data-dsr-instruction="0"]')
    const answered = document.querySelector('[data-dsr-answered]')
    const head = document.querySelector('[data-dsr-head]')
    const structure = document.querySelector('[data-dsr-structure]')
    const claim = document.querySelector('[data-dsr-claim]')
    const source = document.querySelector('[data-dsr-source]')

    report.mounted = visible(rootNode)
    report.rootBox = box(rootNode)
    report.runCount = document.querySelectorAll('[data-dsr-slug]').length
    report.runsAttribute = document.querySelector('[data-dsr-runs]') === null ? null : document.querySelector('[data-dsr-runs]').getAttribute('data-dsr-runs')
    report.runRowText = runRow === null ? null : runRow.textContent
    report.runRowBox = box(runRow)
    report.badgeText = badge === null ? null : badge.textContent
    report.badgeVisible = visible(badge)
    report.detailSlug = detail === null ? null : detail.getAttribute('data-dsr-detail')
    report.headSlug = head === null ? null : head.getAttribute('data-dsr-head')
    report.pendingCount = pending === null ? null : pending.getAttribute('data-dsr-pending')
    report.gateCount = document.querySelectorAll('[data-dsr-gate]').length
    report.gateId = gate === null ? null : gate.getAttribute('data-dsr-gate')
    report.gateText = gate === null ? null : gate.textContent.slice(0, 300)
    report.areaVisible = visible(area)
    report.areaBox = box(area)
    report.submitText = submit === null ? null : submit.textContent
    report.submitBox = box(submit)
    report.quoteText = quote === null ? null : quote.textContent
    report.quoteVisible = visible(quote)
    report.answeredCount = document.querySelectorAll('[data-dsr-answered]').length
    report.answeredId = answered === null ? null : answered.getAttribute('data-dsr-answered')
    report.structure = structure === null ? null : structure.getAttribute('data-dsr-structure')
    report.claimId = claim === null ? null : claim.getAttribute('data-dsr-claim')
    report.claimVisible = visible(claim)
    report.sourceKey = source === null ? null : source.getAttribute('data-dsr-source')
    report.sourceVisible = visible(source)

    // ---- the interaction the item was written for: answer the pending gate
    //
    // Nothing below can be reached by a server render, which runs no effect and
    // receives no click. The sequence is a person's: pick an option, see what the
    // form asks for, type, and only then is Submit live.
    const project = await (await fetch('/api/dsh-research/project?slug=' + encodeURIComponent(detail.getAttribute('data-dsr-detail')))).json()
    const gates = A.pendingGates(project)
    const target = gates.find((one) => String(one.id) === gate.getAttribute('data-dsr-gate'))
    const options = A.optionsOf(target)
    const overrideOption = options.find((option) => option.overrides === true)
    const plainOption = options.find((option) => option.overrides !== true)
    const radioFor = (value) => gate.querySelector('input[type="radio"][value="' + value + '"]')
    const disabled = () => gate.querySelector('[data-dsr-submit]').disabled === true

    report.optionsCount = options.length
    report.requiresText = target.requiresText === true
    report.wantsReasonForOverride = overrideOption === undefined ? null : A.wantsReason(target, overrideOption.value)
    report.submitDisabledAtStart = disabled()
    report.choosePromptVisible = gate.textContent.includes('Choose an option first.')
    report.reasonShownAtStart = gate.querySelector('[data-dsr-field="reason"]') !== null

    // 1. Pick the option that OVERRIDES the default: it must ask for a reason.
    if (overrideOption !== undefined) {
      radioFor(overrideOption.value).click()
      await wait(120)
      report.reasonShownAfterOverride = gate.querySelector('[data-dsr-field="reason"]') !== null
      report.reasonBox = box(gate.querySelector('[data-dsr-field="reason"]'))
      report.submitDisabledAfterOverride = disabled()
      report.needsWordsNoteVisible = gate.textContent.includes('needs an answer in your own words')
    }

    // 2. Pick the option that does NOT override: the reason box must go away again,
    //    which is what makes step 1 a conditional rather than a coincidence.
    if (plainOption !== undefined) {
      radioFor(plainOption.value).click()
      await wait(120)
      report.reasonShownAfterPlain = gate.querySelector('[data-dsr-field="reason"]') !== null
      report.submitDisabledAfterPlain = disabled()
    }

    // 3. Type into the answer box the way React reads a controlled input - through
    //    the native value setter - and Submit must come alive.
    if (plainOption !== undefined) {
      const node = gate.querySelector('[data-dsr-field="text"]')
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setValue.call(node, 'No experiments of mine; the data are secondary and public.')
      node.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(120)
      report.submitDisabledAfterTyping = disabled()
      report.typedText = node.value
    }

    // The layout property a server render cannot even ask about: the tab is a column,
    // and content that pushes the page wider than the window is a broken tab.
    report.overflow = { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, bodyScrollWidth: document.body.scrollWidth }
    report.errors = window.__errors.slice(0, 8)
    await post(report)
  } catch (err) {
    report.fatal = String(err && err.message ? err.message : err)
    report.errors = window.__errors.slice(0, 8)
    await post(report)
  }
})()
</script>
</body></html>`

  const bundleSource = readFileSync(path.join(pkgDir, 'lib', 'client.js'), 'utf8')
  let reported = null
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      response.end(body)
    }
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE)
    if (url.pathname === '/bundle.js') return send(200, 'text/javascript; charset=utf-8', bundleSource)
    if (url.pathname === '/react.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(reactUmd.react, 'utf8'))
    if (url.pathname === '/react-dom.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(reactUmd.dom, 'utf8'))
    // The two routes the tab actually calls, answered by the ENGINE's own view code -
    // not by a hand-written fixture JSON, so what the panel renders is what the row
    // would send it.
    if (url.pathname === '/api/dsh-research/state') {
      return stateView({ env, workspace })
        .then((state) => send(200, 'application/json', JSON.stringify({ ok: true, ...state })))
        .catch((err) => send(500, 'application/json', JSON.stringify({ ok: false, code: err.code ?? 'INTERNAL', message: String(err.message ?? err) })))
    }
    if (url.pathname === '/api/dsh-research/project') {
      const slug = url.searchParams.get('slug') ?? ''
      return projectDetail({ env, workspace, slug })
        .then((project) => send(200, 'application/json', JSON.stringify({ ok: true, ...project })))
        .catch((err) => send(500, 'application/json', JSON.stringify({ ok: false, code: err.code ?? 'INTERNAL', message: String(err.message ?? err) })))
    }
    if (url.pathname === '/report' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk.toString()
      })
      request.on('end', () => {
        try {
          reported = JSON.parse(body)
        } catch (err) {
          reported = { fatal: 'the report was not JSON: ' + String(err.message ?? err) }
        }
        send(200, 'application/json', '{"ok":true}')
      })
      return undefined
    }
    return send(404, 'text/plain', 'not here')
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const pageUrl = 'http://127.0.0.1:' + port + '/'

  console.log('fixture: ' + path.join(root, SLUG))
  console.log('serving: ' + pageUrl)
  console.log('')

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--user-data-dir=' + path.join(sandbox, 'profile'),
      '--window-size=900,760',
      pageUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let browserOutput = ''
  child.stdout.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })

  const deadline = Date.now() + 90_000
  while (reported === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    child.kill()
  } catch (err) {
    /* already gone */
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  server.close()

  // -------------------------------------------------------------------------
  // The assertions. Every one of them is a measurement the browser made.
  // -------------------------------------------------------------------------
  if (reported === null) {
    check('the browser reported a render', false, true)
    console.log('     the browser never posted a report. Its output tail:')
    for (const line of browserOutput.split('\n').slice(-8)) console.log('     ' + line)
  } else {
    if (reported.fatal !== undefined) console.log('     page error: ' + reported.fatal)
    check('the page rendered without an error', reported.errors.length, 0)
    if (reported.errors.length > 0) for (const one of reported.errors.slice(0, 3)) console.log('     ' + one)
    check('the tab mounted and has a real box', reported.mounted, true)
    check('and the box has a usable size', reported.rootBox !== null && reported.rootBox.width > 200 && reported.rootBox.height > 150, true)
    check('the run list holds the fixture run', reported.runCount + '/' + reported.runsAttribute, '1/1')
    check('the row names the run', typeof reported.runRowText === 'string' && reported.runRowText.includes('Sleep and memory'), true)
    check('and carries the waiting badge', reported.badgeText, '1 waiting')
    check('which is visible rather than clipped', reported.badgeVisible, true)
    check('the selected run is the fixture', reported.detailSlug + '/' + reported.headSlug, SLUG + '/' + SLUG)
    check('exactly one gate is waiting', reported.pendingCount + '/' + reported.gateCount, '1/1')
    check('and it is the frame gate nobody has answered', reported.gateId, 'g2-intake')
    check('the form offers a box for the person\'s own words', reported.areaVisible, true)
    check('with a box a person can actually type in', reported.areaBox !== null && reported.areaBox.width > 60 && reported.areaBox.height > 24, true)
    check('the Submit control says what it does', reported.submitText, 'Record this answer')
    check('with a box a person can click', reported.submitBox !== null && reported.submitBox.width > 40 && reported.submitBox.height > 16, true)
    check('the answered gate is on the timeline', reported.answeredCount + '/' + reported.answeredId, '1/g1-rq')
    check('the passport quotes the instruction VERBATIM', typeof reported.quoteText === 'string' && reported.quoteText.includes(INSTRUCTION), true)
    check('and the quote is visible', reported.quoteVisible, true)
    check('the claims section shows the claim', reported.claimId + '/' + reported.claimVisible, 'c0001/true')
    check('and the sources section shows the source', reported.sourceKey + '/' + reported.sourceVisible, 'okonkwo2026/true')
    check('the structure verdict is rendered', typeof reported.structure === 'string' && reported.structure.length > 0, true)

    // ---- the interaction: what a server render cannot reach, measured step by step
    check('the gate offers its options as radios', reported.optionsCount >= 2, true)
    check('Submit is dead until an option is picked', reported.submitDisabledAtStart, true)
    check('and the form says so', reported.choosePromptVisible, true)
    check('no reason is asked before a choice is made', reported.reasonShownAtStart, false)
    check('the overriding option asks for a reason', reported.wantsReasonForOverride, true)
    check('so picking it REVEALS the reason box', reported.reasonShownAfterOverride, true)
    check('with a real box', reported.reasonBox !== null && reported.reasonBox.height > 24 && reported.reasonBox.width > 60, true)
    check('and the words the gate demands are still missing', reported.submitDisabledAfterOverride, true)
    check('which the form says in as many words', reported.needsWordsNoteVisible, true)
    check('picking the plain option HIDES the reason box again', reported.reasonShownAfterPlain, false)
    check('and Submit is still waiting for the words', reported.submitDisabledAfterPlain, true)
    check('typing the person\'s own words ENABLES Submit', reported.submitDisabledAfterTyping, false)
    check('and the box holds what was typed', typeof reported.typedText === 'string' && reported.typedText.startsWith('No experiments of mine'), true)

    // The one property a server render cannot even ask about: the tab is a column,
    // and content that pushes the page wider than the window is a broken tab.
    check(
      'nothing overflows the page horizontally',
      reported.overflow === undefined ? false : reported.overflow.scrollWidth <= reported.overflow.innerWidth + 2,
      true,
    )
    if (reported.overflow !== undefined && reported.overflow.scrollWidth > reported.overflow.innerWidth + 2) {
      console.log('     scrollWidth ' + reported.overflow.scrollWidth + ' > innerWidth ' + reported.overflow.innerWidth)
    }
  }

  if (keep) console.log('\nsandbox kept: ' + sandbox)
  else await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {})

  console.log('')
  console.log(failures === 0 ? 'all research-render checks passed' : failures + ' check(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}
