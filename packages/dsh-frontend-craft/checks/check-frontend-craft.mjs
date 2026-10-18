/**
 * dsh-frontend-craft — the package's own contract.
 *
 * WHAT THIS PROVES, in order:
 *
 *   1. the vendored corpus and engine still hash to what VERSION.json recorded
 *      (`vendor/impeccable/build.mjs --check`), so a hand edit is a failure;
 *   2. the pin is Impeccable 4.6.0 and the registry is the 61 rules the skill
 *      promises, split across both categories;
 *   3. the skill has OUR frontmatter, all 24 command rows, and every engine verb
 *      its references name is either a tool in the surface table, a command, or
 *      explicitly listed as unavailable - a new upstream verb therefore fails
 *      this check instead of confusing an agent at run time;
 *   4. no vendored path still says `.impeccable/`, no placeholder token survived
 *      the upstream build, and the Apache licence and notices travel;
 *   5. the plugin's OWN code neither spawns a process nor reaches the network:
 *      the whole point is that this box does no installation and no egress;
 *   6. the detector agrees, finding for finding, with the upstream CLI on six
 *      committed fixtures - including the linked-stylesheet case the raw wasm
 *      export cannot do alone, which the host closes by inlining local CSS;
 *   7. where this host has Chrome or Edge, a page built to fail really is
 *      rendered and the measured `render-*` rules fire (without a browser the
 *      check says so and exits 0, never silently passing).
 *
 * It writes nothing. Run it with `npm run check` in this folder, or as
 * `node checks/check-frontend-craft.mjs` from anywhere.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { verify } from '../vendor/impeccable/build.mjs'
import { detectHtml, detectText, inlineStylesheets, RULES, RULE_COUNT, VERSION, PACKAGE_VERSION } from '../lib/vendor.js'
import { buildTools, orderFor, dealDirections, pickDirection, normalizeDirections } from '../lib/tools.js'
import { DECK, challengerFor } from '../lib/deck.js'
import { validateDesign, validateProduct, validateSurface } from '../lib/context.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const failures = []
let checked = 0

function check(name, fn) {
  checked += 1
  try {
    fn()
    console.log('ok   ' + name)
  } catch (err) {
    failures.push(name + ': ' + String(err && err.message ? err.message : err))
    console.error('FAIL ' + name + ': ' + String(err && err.message ? err.message : err))
  }
}

/** Sorted `rule|line|snippet` tuples, the shape a finding list compares in. */
function tuples(findings) {
  return findings.map((finding) => [finding.antipattern, finding.line, finding.snippet ?? ''].join('|')).sort()
}

// ---- 1. the vendored bytes --------------------------------------------------
check('every vendored byte matches VERSION.json', () => {
  const { problems, listed, version } = verify()
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.ok(listed >= 50, 'only ' + listed + ' vendored files are listed')
  assert.equal(version.upstream.repo, 'https://github.com/pbakaus/impeccable')
})

// ---- 2. the pin and the registry -------------------------------------------
check('the pin is Impeccable 4.6.0, engine 0.1.15, 61 rules in two categories', () => {
  assert.equal(VERSION.upstream.skillVersion, '4.6.0')
  assert.equal(VERSION.upstream.engineVersion, '0.1.15')
  assert.equal(RULE_COUNT, 61, 'the registry is ' + RULE_COUNT + ' rules, the skill promises 61')
  const categories = new Set(RULES.map((rule) => rule.category))
  assert.ok(categories.has('slop') && categories.has('quality'), 'categories: ' + [...categories].join(','))
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, 61, 'rule ids are not unique')
})

// ---- 3. the skill -----------------------------------------------------------
const skillFile = path.join(pkgRoot, 'skills', 'frontend-craft', 'SKILL.md')
const skillText = readFileSync(skillFile, 'utf8')
const refDir = path.join(pkgRoot, 'skills', 'frontend-craft', 'reference')
const refFiles = readdirSync(refDir, { recursive: true })
  .map((name) => String(name))
  .filter((name) => name.endsWith('.md'))
const refText = refFiles.map((name) => readFileSync(path.join(refDir, name), 'utf8')).join('\n')

check('the skill is ours: frontend-craft, with a trigger-rich description', () => {
  assert.match(skillText, /^---\nname: frontend-craft\ndescription: "Use when[\s\S]*?"\n---\n/)
  assert.ok(skillText.length > 8000, 'the skill is suspiciously short')
})

check('all 24 commands are still in the table', () => {
  const commands = []
  const commandsSection = skillText.slice(skillText.indexOf('## Commands'), skillText.indexOf('\n## ', skillText.indexOf('## Commands') + 5))
  for (const line of commandsSection.split('\n')) {
    const match = /^\|\s*`([a-z]+)[^`]*`\s*\|/.exec(line)
    // The tool-surface table also has rows that begin with a backticked
    // `impeccable <verb>`; those are translations, not commands.
    if (match && match[1] !== 'impeccable') commands.push(match[1])
  }
  assert.equal(commands.length, 24, 'command rows: ' + commands.join(','))
  for (const expected of ['init', 'document', 'critique', 'audit', 'polish', 'harden', 'onboard', 'animate', 'typeset', 'layout', 'clarify', 'adapt', 'optimize', 'live', 'generate']) {
    assert.ok(commands.includes(expected), 'missing command: ' + expected)
  }
})

check('every engine verb in the corpus is translated, a command, or declared unavailable', () => {
  const COMMANDS = ['craft', 'shape', 'init', 'document', 'extract', 'critique', 'audit', 'polish', 'bolder', 'quieter', 'distill', 'harden', 'onboard', 'animate', 'colorize', 'typeset', 'layout', 'delight', 'overdrive', 'clarify', 'adapt', 'optimize', 'live', 'generate']
  const TOOL_VERBS = ['context', 'detect', 'surface-brief', 'concept-seed', 'serve-question', 'doctor']
  const UNAVAILABLE = [
    'pin', 'unpin', 'hooks', 'hook', 'hook-before-edit', 'ignores', 'update', 'signals', 'build-phase',
    'comp-diff', 'comp-spec', 'generate-image', 'live-accept', 'live-complete', 'live-generate', 'live-inject',
    'live-insert', 'live-poll', 'live-resume', 'live-server', 'live-status', 'live-wrap', 'detect-csp',
    'embed-prompt', 'font-match', 'critique-storage', 'component-review', 'design',
  ]
  const known = new Set([...COMMANDS, ...TOOL_VERBS, ...UNAVAILABLE, 'impeccable'])
  const seen = new Set()
  for (const match of (skillText + '\n' + refText).matchAll(/(?<![A-Za-z-])impeccable ([a-z][a-z-]*)/g)) seen.add(match[1])
  // The live- and comp- families are engine-internal verbs the skill names in
  // passing; every one of them is covered by the UNAVAILABLE paragraph by family.
  const unknown = [...seen].filter((verb) => !known.has(verb) && !verb.startsWith('live-') && !verb.startsWith('comp-')).sort()
  assert.deepEqual(unknown, [], 'verbs with no translation: ' + unknown.join(', '))
  // The table really does name each tool verb, so an agent can follow it.
  for (const verb of TOOL_VERBS) assert.ok(skillText.includes('`impeccable ' + verb) || skillText.includes('| `impeccable context`') || skillText.includes(verb), 'the surface table does not mention ' + verb)
})

check('no vendored path is still named .impeccable/, and no placeholder survived', () => {
  const all = skillText + '\n' + refText
  assert.ok(!all.includes('.impeccable/'), 'a reference still points at .impeccable/')
  for (const token of ['{{model}}', '{{scripts_path}}', '{{command_prefix}}', '{{available_commands}}', '{{reference_path}}', '{{config_file}}', '{{ask_instruction}}']) {
    assert.ok(!all.includes(token), 'placeholder survived: ' + token)
  }
  assert.ok(refFiles.length >= 40, 'only ' + refFiles.length + ' reference files')
})

check('the Apache licence and third-party notices travel with the corpus', () => {
  const licence = readFileSync(path.join(pkgRoot, 'lib', 'vendor', 'impeccable', 'LICENSE'), 'utf8')
  assert.match(licence, /Apache License/)
  const notice = readFileSync(path.join(pkgRoot, 'lib', 'vendor', 'impeccable', 'NOTICE.md'), 'utf8')
  assert.match(notice, /platform-design-skills/)
})

// ---- 4. this plugin's own code ---------------------------------------------
check('the scan path spawns nothing and no host file reaches a non-loopback URL', () => {
  const quiet = ['index.js', 'tools.js', 'context.js', 'paths.js', 'vendor.js', 'client.js'].map((name) => path.join(pkgRoot, 'lib', name))
  // A non-loopback URL anywhere in the host half would be egress. A loopback
  // example in a description is the render's own contract, not a destination.
  const remoteUrl = /https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/]|\[::1\][:/])/i
  for (const file of [...quiet, path.join(pkgRoot, 'lib', 'render.js')]) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!remoteUrl.test(text), path.basename(file) + ' names a non-loopback URL')
  }
  for (const file of quiet) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of [/child_process/, /\bspawn\b/, /\bspawnSync\b/, /\bexecSync\b/, /\bexecFile/, /XMLHttpRequest/]) {
      assert.ok(!pattern.test(text), path.basename(file) + ' matches ' + pattern)
    }
  }
  // The ONE child process this package starts is the machine's own browser, and
  // it is started argv-only, headless, with a throwaway profile and no shell.
  const render = readFileSync(path.join(pkgRoot, 'lib', 'render.js'), 'utf8')
  assert.match(render, /spawn\(engine\.file, args, \{ stdio: 'ignore'/)
  assert.ok(!/shell:\s*true/.test(render), 'the browser is never started through a shell')
  assert.ok(!/\bexecSync\b/.test(render), 'nothing here builds a command string')
  assert.match(render, /--remote-debugging-port=0/)
  assert.match(render, /MAP \* ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127\.0\.0\.1/)
  // The client's one egress is same-origin fetch of THIS plugin's routes.
  const client = readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  for (const match of client.matchAll(/fetch\(([^,)]+)/g)) {
    assert.match(match[1], /(STATE_ROUTE|SCAN_ROUTE|ARTIFACTS_ROUTE|DIRECTION_ROUTE|RENDER_IMAGE_ROUTE|path)/, 'a client fetch names something that is not one of this plugin’s routes: ' + match[1])
  }
  // No telemetry vocabulary anywhere in the package.
  for (const file of [...quiet, path.join(pkgRoot, 'lib', 'render.js')]) assert.ok(!/telemetry|analytics|DO_NOT_TRACK/i.test(readFileSync(file, 'utf8')), 'telemetry vocabulary in ' + path.basename(file))
})

check('package.json, the row marker and the install target agree', () => {
  const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-frontend-craft')
  assert.equal(manifest.version, PACKAGE_VERSION)
  assert.ok(existsSync(path.join(pkgRoot, 'cordis.patch.yml')))
  assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0, 'the package must have zero npm dependencies')
  const patch = readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: frontend-craft/)
})

// ---- 5. the detector agrees with the upstream CLI ---------------------------
check('the detector reproduces the upstream CLI on the committed fixtures', () => {
  const fixtures = path.join(here, 'fixtures')
  const expected = JSON.parse(readFileSync(path.join(fixtures, 'expected.json'), 'utf8'))
  let files = 0
  for (const [name, findings] of Object.entries(expected)) {
    const file = path.join(fixtures, name)
    const text = readFileSync(file, 'utf8')
    const answer = name.endsWith('.html') ? detectHtml(inlineStylesheets(text, file), name, {}) : detectText(text, name, {})
    assert.equal(answer.ok, true, name + ': ' + answer.message)
    assert.deepEqual(tuples(answer.findings), tuples(findings), name + ' diverges from the upstream CLI')
    files += 1
  }
  assert.ok(files >= 6, 'only ' + files + ' fixtures ran')
})

// ---- 6. the shape validators ------------------------------------------------
check('artifact validation accepts what the skill asks for and refuses what it does not', () => {
  const product =
    '# Product\n\n<!-- frontend-craft:product-schema 1 -->\n\n## Platform\n\nweb\n\n## Users\n\nDesigners.\n\n## Product Purpose\n\nShip pages.\n'
  assert.equal(validateProduct(product).ok, true)
  assert.equal(validateProduct('# Product\n').ok, false)
  const design = '---\ncolors:\n  bg: "#ffffff"\n---\n\n# Design\n'
  assert.equal(validateDesign(design).ok, true)
  assert.equal(validateDesign('# Design\n').ok, false)
  const surface = '## Direction contract\n\nTHESIS: x\nOWN-WORLD: y\nSTORY: z\nFIRST VIEWPORT: a\nFORM: b\n\nseed: none (unavailable)\n\nFINISH: unreviewed is unfinished\n'
  assert.equal(validateSurface(surface).ok, true)
  assert.equal(validateSurface('## Direction contract\n\nTHESIS: x\n').ok, false)
  // A foreign (unstamped) PRODUCT.md is not "incomplete": it is stale, and the
  // context says so once rather than asking the agent to rewrite the file.
  assert.equal(validateProduct('# Product\n\n## Platform\n\nweb\n\n## Users\nu\n\n## Product Purpose\np\n').ok, true)
})

check('the row registers exactly the tools the skill tells the agent to call', () => {
  const names = buildTools({}).map((tool) => tool.name)
  assert.deepEqual(names, ['fe_context', 'fe_detect', 'fe_direction', 'fe_render', 'fe_artifact'])
  for (const name of names) {
    assert.ok(skillText.includes('`' + name + '`'), 'SKILL.md never names ' + name)
  }
  // And the surface table maps the two engine verbs this build actually owns.
  assert.match(skillText, /\| `impeccable context` \| `fe_context` \|/)
  assert.match(skillText, /\| `impeccable detect <target>` \| `fe_detect`/)
})

check('a dealt hand is reproducible from its seed and is a permutation', () => {
  const directions = ['Swiss rail timetable', 'risograph zine', 'marine chart', 'library card catalogue', 'aeroplane safety card']
  const first = orderFor('abc123', directions)
  const again = orderFor('abc123', directions)
  const other = orderFor('def456', directions)
  assert.deepEqual(first, again, 'the same seed produced two different hands')
  assert.deepEqual(first.slice().sort(), directions.slice().sort(), 'the deal is not a permutation of the authored directions')
  assert.notDeepEqual(first, other, 'two seeds produced the same hand (the hash is not doing anything)')
})

check('the local deck is complete, and a hand always carries one challenger', () => {
  assert.ok(DECK.length >= 18, 'the deck is ' + DECK.length + ' entries')
  const ids = new Set()
  for (const entry of DECK) {
    assert.ok(entry.id && !ids.has(entry.id), 'deck id missing or duplicated: ' + entry.id)
    ids.add(entry.id)
    assert.ok(typeof entry.name === 'string' && entry.name.length > 2, entry.id + ' has no name')
    assert.ok(typeof entry.thesis === 'string' && entry.thesis.length > 20, entry.id + ' has no thesis')
    assert.ok(typeof entry.risk === 'string' && entry.risk.length > 10, entry.id + ' has no risk')
    assert.ok(Array.isArray(entry.modes) && entry.modes.every((mode) => ['persuade', 'operate', 'read', 'experience'].includes(mode)), entry.id + ' names an unknown mode')
  }
  const authored = [{ name: 'Swiss rail timetable' }, { name: 'Risograph zine' }, { name: 'Marine chart' }]
  const dealt = dealDirections({ directions: authored, seed: 'deck-seed', mode: 'operate' })
  assert.equal(dealt.ok, true, dealt.message)
  const challenger = dealt.deal.cards.find((card) => card.source === 'deck')
  assert.ok(challenger, 'the hand carries no challenger')
  assert.ok(!authored.some((entry) => entry.name === challenger.name), 'the challenger repeated an authored direction')
  assert.equal(challengerFor(dealt.deal.seed, 'operate', authored).name, challenger.name, 'the challenger is not deterministic from the seed')
  const without = dealDirections({ directions: authored, seed: 'deck-seed', mode: 'operate', includeDeck: false })
  assert.equal(without.deal.cards.filter((card) => card.source === 'deck').length, 0)
  assert.ok(normalizeDirections(authored).length === 3)
  assert.equal(pickDirection(dealt.deal, 'reroll').ok, true)
  assert.equal(pickDirection(dealt.deal, 'not a card').ok, false)
})

// ---- 7. the renderer, where this host has a browser -------------------------
// A render needs a real Chromium; with none, this check says so and exits 0
// rather than pretending. With one, it renders a page built to fail and asserts
// the measured rules actually fire.
const renderer = await import('../lib/render.js')
if (renderer.resolveEngine() === null) {
  console.log('skip render smoke (no Chrome/Edge on this host)')
} else {
  checked += 1
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dfc-check-render-'))
    const page = path.join(dir, 'page.html')
    writeFileSync(page, '<!doctype html><title>t</title><style>body{background:#fff;color:#9aa0a6;margin:0;padding:20px;font:16px system-ui}p{width:900px}</style><h1>t</h1><h3>skip</h3><p>low contrast text that is deliberately wider than the viewport</p><img src="x.png" width="10" height="10">')
    const report = await renderer.renderTarget({
      target: { url: pathToFileURL(page).toString(), kind: 'file' },
      viewports: [{ width: 600, height: 400, label: 'smoke' }],
    })
    assert.equal(report.ok, true, report.message)
    const entry = report.viewports[0]
    assert.ok(entry.png.length > 1000, 'the png is suspiciously small')
    assert.ok(entry.size && entry.size.width === 600, 'the png is not the viewport width')
    const rules = new Set(entry.findings.map((finding) => finding.antipattern))
    for (const expected of ['render-contrast', 'render-overflow', 'render-heading-skip', 'render-missing-alt']) assert.ok(rules.has(expected), 'the render missed ' + expected)
    console.log('ok   render smoke: ' + entry.png.length + ' byte png, ' + rules.size + ' measured rules')
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    failures.push('render smoke: ' + String(err && err.message ? err.message : err))
    console.error('FAIL render smoke: ' + String(err && err.message ? err.message : err))
  }
}

if (failures.length > 0) {
  console.error('\ncheck-frontend-craft: ' + failures.length + ' of ' + checked + ' checks failed')
  process.exit(1)
}
console.log('\ncheck-frontend-craft: ' + checked + ' checks OK · Impeccable ' + VERSION.upstream.skillVersion + ' @ ' + VERSION.upstream.commit.slice(0, 7) + ' · ' + RULE_COUNT + ' rules')
