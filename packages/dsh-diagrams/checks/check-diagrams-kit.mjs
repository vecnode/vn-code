// check-diagrams-kit.mjs — the Diagram Design kit, the `html` kind, and the port.
//
// This check travels WITH the package, so it is useful outside this repository.
// It answers the three questions the kit's presence raises, and it answers them
// without a running harness:
//
//   1. **Is the vendored tree the pinned one?** `vendor/design/build.mjs --check`
//      re-hashes every file offline against `lib/vendor/design/VERSION.json`, and
//      the catalog is compared against the files actually on disk (so a file the
//      catalog forgot, or an entry with no file, fails here rather than in the
//      panel).
//   2. **Does the ported contract still agree with the examples it ships?**
//      `lib/html-check.js` is a PORT of the kit's own `scripts/self_check.py`.
//      Every one of the 204 vendored examples must come back `ok`, and - where
//      this host has a `python3` - BOTH implementations are run over the whole
//      corpus and their verdicts must be identical. That second half is what
//      makes "a port" a claim someone can check instead of a promise; without
//      Python it skips loudly and the corpus half still runs.
//   3. **Do the safety rules actually fire?** A checker that passes everything is
//      decoration, so each rule is given a document that breaks only it.
//
// Run:  node checks/check-diagrams-kit.mjs      (or: npm run check)
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.dirname(here)
const designRoot = path.join(pkgRoot, 'lib', 'vendor', 'design')
const assets = path.join(designRoot, 'assets')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? ' ' + String(actual) : ' ' + JSON.stringify(actual)))
  return ok
}

// ---------------------------------------------------------------------------
// 1. The vendored tree
// ---------------------------------------------------------------------------
console.log('--- the vendored tree')
const build = spawnSync(process.execPath, [path.join(pkgRoot, 'vendor', 'design', 'build.mjs'), '--check'], { encoding: 'utf8' })
const buildOut = String(build.stdout ?? '').trim().split('\n').pop() ?? ''
check('vendor/design/build.mjs --check passes offline', build.status === 0 ? true : String(build.stderr ?? buildOut).slice(0, 240), true)

const manifest = JSON.parse(readFileSync(path.join(designRoot, 'VERSION.json'), 'utf8'))
const catalog = JSON.parse(readFileSync(path.join(designRoot, 'catalog.json'), 'utf8'))
const exampleFiles = readdirSync(assets).filter((name) => name.startsWith('example-') && name.endsWith('.html'))
const templateFiles = readdirSync(assets).filter((name) => /^template.*\.html$/.test(name))

check('the manifest names its upstream commit', /^[0-9a-f]{40}$/.test(manifest.upstream.commit), true)
check('the manifest carries the MIT licence', manifest.upstream.license, 'MIT')
check('the upstream licence travels with the bytes', existsSync(path.join(designRoot, 'LICENSE')), true)
check('the vendored self_check.py travels too', existsSync(path.join(designRoot, 'scripts/self_check.py')), true)
check('every example on disk is in the manifest', manifest.files.filter((entry) => entry.path.startsWith('assets/example-')).length, exampleFiles.length)
check('the catalog counts the examples on disk', catalog.counts.examples, exampleFiles.length)
check('the catalog lists one entry per example key', catalog.types.length, catalog.counts.types)
check('every catalog example resolves to a file', catalog.types.every((entry) => Object.values(entry.examples).every((one) => existsSync(path.join(designRoot, one.file)))), true)
check(
  'every example file is claimed by the catalog',
  new Set(catalog.types.flatMap((entry) => Object.values(entry.examples).map((one) => one.file))).size,
  exampleFiles.length,
)
check('the documented types are the ones with a reference', catalog.types.filter((entry) => entry.documented).length, catalog.counts.documented)
check('the kit ships the templates a diagram starts from', templateFiles.length >= 5, true)

// ---------------------------------------------------------------------------
// 2. The ported contract, over the whole corpus
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the contract, over the corpus')
const htmlCheck = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'html-check.js')).href)
const designKit = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'design-kit.js')).href)
const motionText = readFileSync(path.join(assets, 'template-motion.html'), 'utf8')
const motionBody = /<script data-diagram-controls>([\s\S]*?)<\/script>/.exec(motionText)
check('the motion controller is present in its template', Boolean(motionBody), true)
const motionHash = sha256(motionBody[1])
check('the recorded motion hash is the template\u2019s own', manifest.motion.sha256, motionHash)
check('design-kit reports the same hash', designKit.motionHash(), motionHash)

const corpus = [...exampleFiles, ...templateFiles].sort()
const portVerdicts = new Map()
const refused = []
for (const name of corpus) {
  const source = readFileSync(path.join(assets, name), 'utf8')
  const verdict = htmlCheck.checkHtml(source, { motionHash, sha256 })
  portVerdicts.set(name, verdict.ok === true)
  if (verdict.ok !== true) refused.push(name)
}
check('every vendored example and template passes the contract (' + corpus.length + ' files)', refused.join(', '), '')

// The differential half: the same corpus through the kit's OWN checker. It needs
// a python3, so with none on this host it skips LOUDLY and says what that means.
const python = ['python3', 'python', 'py'].find((name) => {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' })
  return probe.status === 0
})
if (!python) {
  skipped += 1
  console.log('skip the port-vs-Python differential            (no python3 on this host)')
  console.log('     the corpus half above still ran; the port is not COMPARED against its source here')
} else {
  const script = path.join(designRoot, 'scripts', 'self_check.py')
  const disagreements = []
  for (const name of corpus) {
    const result = spawnSync(python, [script, path.join(assets, name)], { encoding: 'utf8' })
    const pythonOk = result.status === 0
    if (pythonOk !== portVerdicts.get(name)) {
      disagreements.push(name + ' (python ' + (pythonOk ? 'ok' : 'refused') + ', port ' + (portVerdicts.get(name) ? 'ok' : 'refused') + ')')
    }
  }
  check('the port agrees with upstream self_check.py on all ' + corpus.length + ' files', disagreements.slice(0, 5).join(', '), '')
  console.log('     (checked with ' + python + ')')
}

// ---------------------------------------------------------------------------
// 3. The rules fire
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the rules fire')
const probe =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>:root{--color-paper:#f5f5f5;--color-ink:#2d3142;--color-muted:#4f5d75;--color-accent:#bf4520;--font-sans:system-ui;--font-serif:Georgia;--font-mono:ui-monospace;}</style></head>' +
  '<body><svg viewBox="0 0 100 40" role="img" aria-labelledby="probe-title probe-desc"><title id="probe-title">Probe</title><desc id="probe-desc">One accessible mark.</desc></svg></body></html>'
const wrap = (extra) => probe.replace('<body>', '<body>' + extra)
const verdictOf = (source) => htmlCheck.checkHtml(source, { motionHash, sha256 })
check('the probe document is valid', verdictOf(probe).ok, true)

const safety = [
  ['a remote image', '<img src="https://example.invalid/a.gif">'],
  ['a remote stylesheet', '<link rel="stylesheet" href="https://example.invalid/a.css">'],
  ['a protocol-relative reference', '<img src="//example.invalid/a.gif">'],
  ['a remote css url', '<div style="background:url(https://example.invalid/a.png)"></div>'],
  ['a CSS @import', '<style>@import "https://example.invalid/a.css";</style>'],
  ['CSS image-set', '<style>div{background:image-set("a.png")}</style>'],
  ['an escaped CSS url', '<style>div{background:url(\\68 ttps://example.invalid/a.png)}</style>'],
  ['an executable attribute', '<rect onclick="alert(1)"></rect>'],
  ['an object element', '<object data="x"></object>'],
  ['an iframe', '<iframe src="about:blank"></iframe>'],
  ['a base element', '<base href="https://example.invalid/">'],
  ['a srcdoc attribute', '<div srcdoc="x"></div>'],
  ['a second script', '<script>1</script>'],
  ['a foreign script', '<script data-diagram-controls>alert(1)</script>'],
  ['an unrecognised script attribute', '<script data-diagram-controls src="x"></script>'],
]
const missed = []
for (const [label, extra] of safety) {
  if (verdictOf(wrap(extra)).ok) missed.push(label)
}
check('every safety rule refuses', missed.join(', '), '')

const approvedFonts = wrap('<link href="https://fonts.googleapis.com/css2?family=Geist&display=swap" rel="stylesheet">')
check('the kit\u2019s own Google Fonts link is recognised, not refused', verdictOf(approvedFonts).ok, true)
const wrongFonts = wrap('<link href="http://fonts.googleapis.com/css2?family=Geist" rel="stylesheet">')
check('the same host over http is refused', verdictOf(wrongFonts).ok, false)

// The craft findings are warnings: the status must not move for any of them.
// A document with NO SVG is not in this list on purpose - it has nothing to draw,
// which is a refusal and is asserted just below.
const craft = [
  ['no dark tokens', probe.replace(/<style>[\s\S]*?<\/style>/, '<style>svg{max-width:100%}</style>')],
  ['no font tokens', probe.replace(/--font-[a-z]+:[^;]+;/g, '')],
]
const wrongTier = craft.filter(([, source]) => verdictOf(source).ok !== true)
check('every craft finding only warns', wrongTier.map(([label]) => label).join(', '), '')
const emptyDrawing = verdictOf('<!doctype html><html><head></head><body><p>text only</p></body></html>')
check('a document with nothing to draw is refused', emptyDrawing.ok === false && /no <svg>/.test(emptyDrawing.refusals[0].text), true)

const emptyVerdict = verdictOf('   ')
check('an empty document is refused', emptyVerdict.ok === false && /empty/i.test(emptyVerdict.refusals[0].text), true)

// The a11y contract, one rule at a time.
const a11y = [
  ['no role', probe.replace(' role="img"', '')],
  ['no title', probe.replace(/<title[^>]*>[^<]*<\/title>/, '')],
  ['a bare title id', probe.replace(/id="probe-title"/g, 'id="title"').replace(/aria-labelledby="[^"]*"/, 'aria-labelledby="title probe-desc"')],
  ['an empty title', probe.replace('>Probe<', '><')],
  ['a wrong aria-labelledby', probe.replace('aria-labelledby="probe-title probe-desc"', 'aria-labelledby="probe-desc probe-title"')],
  ['a hidden svg', probe.replace('role="img"', 'role="img" aria-hidden="true"')],
]
const a11yMissed = []
for (const [label, source] of a11y) {
  if (verdictOf(source).ok) a11yMissed.push(label)
}
check('every accessibility rule refuses', a11yMissed.join(', '), '')

// ---------------------------------------------------------------------------
// 4. The composed frame
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the composed frame')
const exampleSource = readFileSync(path.join(assets, 'example-architecture.html'), 'utf8')
const composed = designKit.composeHtmlDocument(exampleSource, { theme: 'dark', fonts: 'system', viewer: true })
check('composition strips the fonts link', /fonts\.googleapis/.test(composed.html), false)
check('composition strips every fonts link it finds', composed.strippedFonts >= 1, true)
check('composition injects the overlay before </head>', composed.html.indexOf('data-dsh-diagram-overlay') < composed.html.indexOf('</head>'), true)
check('composition injects the viewer bridge', composed.html.includes('data-dsh-diagram-viewer'), true)
check('the dark overlay is present only when asked', composed.html.includes(':root[data-dsh-theme="dark"]'), true)
const light = designKit.composeHtmlDocument(exampleSource, { theme: 'light', viewer: false })
check('no viewer bridge on an export', light.html.includes('data-dsh-diagram-viewer'), false)
check('no dark overlay on a light document', light.html.includes(':root[data-dsh-theme="dark"]'), false)
const scaled = designKit.composeHtmlDocument(exampleSource, { scale: 0.5 })
check('the scale reaches the document', /html\{zoom:0\.5;\}/.test(scaled.html), true)
const policy = designKit.contentSecurityPolicy()
check('the policy denies everything by default', policy.startsWith("default-src 'none'"), true)
check('the policy allows no network source', /https?:/.test(policy), false)

// ---------------------------------------------------------------------------
// 5. The catalog reads
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the catalog reads')
check('the catalog answers with every key', designKit.listTypes().length, catalog.counts.types)
check('documented-only filters to the 44', designKit.listTypes({ documentedOnly: true }).length, catalog.counts.documented)
check('one key can be looked up', designKit.typeById('venn') ? designKit.typeById('venn').id : null, 'venn')
const example = designKit.exampleFile('venn')
check('an example resolves to its file', existsSync(example.path) && example.variant === 'plain', true)
const altered = designKit.exampleFile('architecture', 'dark')
check('a variant can be asked for', altered.variant, 'dark')
check('an unknown variant falls back to the default', designKit.exampleFile('venn', 'nonsense').variant, 'plain')
check('an unknown key resolves to nothing', designKit.exampleFile('no-such-key'), null)
check('a reference resolves by name', designKit.referenceFile('style-guide').rel, 'references/style-guide.md')
check('a reference resolves by type id', designKit.referenceFile('sankey').rel, 'references/type-sankey.md')
check('a traversal is not a reference', designKit.referenceFile('../../etc/passwd'), null)
check('every reference on disk is listed', designKit.listReferences().length >= 60, true)
const capped = designKit.readCapped(path.join(designRoot, 'references', 'style-guide.md'), { maxChars: 1000 })
check('a capped read says what it dropped', capped.truncated === true && capped.totalChars > 1000 && /characters/.test(capped.notice), true)
const whole = designKit.readCapped(path.join(designRoot, 'references', 'type-venn.md'))
check('a short document comes back whole', whole.truncated, false)

console.log('')
console.log(
  (failures === 0 ? 'all ' + checked + ' check(s) passed' : failures + ' check(s) FAILED') +
    (skipped > 0 ? ' (' + skipped + ' skipped)' : ''),
)
console.log('host: ' + process.platform + ', python: ' + (python ?? 'none') + ', corpus: ' + corpus.length + ' files')
process.exitCode = failures === 0 ? 0 : 1
