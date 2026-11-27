// check-rea.mjs - dsh-rea's own contract, driven directly.
//
// The row is an argv builder, a scope guard and a store; none of that needs REA
// installed, so the whole check runs on any machine. What it cannot prove is
// what REA prints - that is the live half, and it says so by driving the binary
// when one is present.
//
// Run:  node checks/check-rea.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_REPORT_BYTES,
  assertTargetAllowed,
  buildInspectArgs,
  buildProbeArgs,
  investigationDir,
  isCommandName,
  listInvestigations,
  newInvestigationId,
  parseReaJson,
  readInvestigation,
  resolveRea,
  sliceReport,
  storeInvestigation,
  summarize,
} from '../lib/rea.js'
import { buildTools } from '../lib/tools.js'
import { PLUGIN_VERSION, __internals } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

let checks = 0
let failures = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

console.log('# dsh-rea')

// --------------------------------------------------------------- the row
check('the package names the row', pkg.name, 'dsh-rea')
check('the marker matches package.json', PLUGIN_VERSION, pkg.version)
check('the bundle points at its patch', pkg.dsh.bundle.patch, './cordis.patch.yml')
check('no npm dependency is declared', Object.keys(pkg.dependencies ?? {}).length, 0)
check('the patch inserts one row', /id:\s*rea\b/.test(readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8')))

// --------------------------------------------------------------- the tools
const tools = buildTools({ ctx: {}, env: {}, platform: 'win32' })
check('five tools are registered', tools.length, 5)
check(
  'their names are the documented surface',
  tools.map((tool) => tool.name).join(','),
  'rea_status,rea_inspect,rea_read,rea_snapshot,rea_report',
)
for (const tool of tools) {
  check(tool.name + ': has a schema', Boolean(tool.parameters && tool.parameters.type === 'object'))
  check(tool.name + ': answers text and a view', Boolean(tool.output && tool.output.schema && tool.output.schema.required.join(',') === 'text,view'))
  check(tool.name + ': describes itself', typeof tool.description === 'string' && tool.description.length > 80)
  check(tool.name + ': is executed by a function', typeof tool.execute === 'function')
}

// --------------------------------------------------------------- the argv
check('the javascript command is the default shape', buildInspectArgs({ command: 'analyze-javascript-application', target: '/work/app' }).join(' '), 'analyze-javascript-application /work/app --json')
check('a provider is passed through', buildInspectArgs({ command: 'analyze-native-binary', target: '/work/x', provider: 'ghidra' }).join(' '), 'analyze-native-binary /work/x --json --provider ghidra')
check('a flag-shaped command is refused', (() => { try { buildInspectArgs({ command: '--help', target: '/work/x' }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('a flag-shaped provider is refused', (() => { try { buildInspectArgs({ command: 'analyze-native-binary', target: '/work/x', provider: '--out' }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('an empty target is refused', (() => { try { buildInspectArgs({ command: 'analyze-javascript-application', target: '' }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('a target with spaces stays ONE argument', buildInspectArgs({ command: 'analyze-javascript-application', target: '/work/my app' }).length, 3)
check('command names are shape-checked', isCommandName('analyze-javascript-application') && !isCommandName('rm -rf') && !isCommandName('a'), true)
check('probing is version or help only', buildProbeArgs('version').join(' ') + '|' + buildProbeArgs('help').join(' '), '--version|--help')

// --------------------------------------------------------------- the scope
const ws = path.resolve('/work/project')
check('a target inside the workspace is allowed', assertTargetAllowed({ target: path.join(ws, 'app', 'main.js'), workspace: ws, platform: 'linux', realpath: false }), path.join(ws, 'app', 'main.js'))
check('a target outside it is refused', (() => { try { assertTargetAllowed({ target: '/etc/passwd', workspace: ws, platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')
check('a named allowRoot is honoured', (() => { try { return assertTargetAllowed({ target: '/opt/target/bin', workspace: ws, allowRoot: '/opt/target', platform: 'linux', realpath: false }) } catch { return 'refused' } })(), path.resolve('/opt/target/bin'))
check('a URL needs the opt-in', (() => { try { assertTargetAllowed({ target: 'https://example.com', workspace: ws, platform: 'linux' }); return 'allowed' } catch { return 'refused' } })(), 'refused')
check('the URL opt-in allows it', assertTargetAllowed({ target: 'https://example.com', workspace: ws, allowUrl: true, platform: 'linux' }), 'https://example.com')
check('a sibling prefix is not "inside"', (() => { try { assertTargetAllowed({ target: '/work/project-evil/x', workspace: ws, platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')
check('no workspace refuses a local target', (() => { try { assertTargetAllowed({ target: '/work/project/x', workspace: '', platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')

// --------------------------------------------------------------- the JSON
check('a plain JSON object parses', parseReaJson('{"a":1}').ok, true)
check('a banner before the JSON does not stop it', parseReaJson('rea 4.1.0\nwarning: provider not set\n{"modules":[1,2]}').ok, true)
check('that answer keeps the object', JSON.stringify(parseReaJson('banner\n{"modules":[1,2]}').value), '{"modules":[1,2]}')
check('an empty answer is not JSON', parseReaJson('   ').ok, false)
check('garbage is not JSON', parseReaJson('no json here').ok, false)
check('an unterminated object is not JSON', parseReaJson('{"a":1').ok, false)
check('a top-level array parses', JSON.stringify(parseReaJson('ok\n[{"x":1}]').value), '[{"x":1}]')

// --------------------------------------------------------------- the store
const home = mkdtempSync(path.join(tmpdir(), 'dsh-rea-'))
try {
  const env = { DSH_HOME: home }
  const id = newInvestigationId('/work/project/app', new Date('2026-11-27T12:00:00Z'))
  check('an id is sortable and readable', id.startsWith('20261127-120000') && id.includes('-app-'), true)
  check('a traversal id is refused', (() => { try { investigationDir('../../x', env); return 'accepted' } catch { return 'refused' } })(), 'refused')
  const stored = storeInvestigation({ id, target: '/work/project/app', command: 'analyze-javascript-application', payload: { modules: [1, 2, 3] }, env })
  check('the report is written', existsSync(path.join(stored.dir, 'report.json')), true)
  check('the meta is written', existsSync(path.join(stored.dir, 'meta.json')), true)
  const read = readInvestigation(id, env)
  check('it reads back', read.meta.command, 'analyze-javascript-application')
  check('it is listed', listInvestigations(env).length, 1)
  const big = { blob: 'x'.repeat(MAX_REPORT_BYTES + 10) }
  check('an oversized report is refused', (() => { try { storeInvestigation({ id: id + '-big', target: '/x', command: 'c', payload: big, env }); return 'accepted' } catch { return 'refused' } })(), 'refused')

  const slice = sliceReport(read.raw, { offset: 2, limit: 2 })
  check('a slice names its range', slice.start + '-' + slice.end + '/' + slice.total, '2-3/' + read.raw.split('\n').length)
  check('a slice past the end is clamped', sliceReport('a\nb', { offset: 99 }).start, 2)
  const summary = summarize({ modules: [1], nested: { a: 1 }, name: 'x' })
  check('a summary counts arrays', summary[0].includes('modules: 1 item(s)'), true)
  check('a summary names nested keys', summary[1].includes('nested: {a}'), true)
} finally {
  rmSync(home, { recursive: true, force: true })
}

// --------------------------------------------------------------- activation
check('a missing binary is said in one line', Boolean(__internals.activationLine({ command: '', source: 'missing' }).includes('npm install --global rea-agents')), true)
const resolved = resolveRea({ PATH: '', DSH_REA_CLI: '' }, 'linux')
check('no PATH entry resolves to nothing', resolved.command, '')

// --------------------------------------------------------------- the skills
const skillsRoot = path.join(here, '..', 'skills')
const skills = ['rea-investigate', 'rea-native', 'rea-javascript', 'rea-rebuild', 'rea-ethics']
check('five skills ship', skills.every((name) => existsSync(path.join(skillsRoot, name, 'SKILL.md'))), true)
for (const name of skills) {
  const file = path.join(skillsRoot, name, 'SKILL.md')
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const front = /^---\nname: ([\w-]+)\ndescription: (.+)\nwhenToUse: (.+)\n---/m.exec(text)
  check(name + ': frontmatter is complete', Boolean(front))
  check(name + ': names itself', front ? front[1] : '', name)
}

// --------------------------------------------------------------- live half
const live = resolveRea(process.env, process.platform)
if (live.command === '') {
  console.log('skip the live REA probe (no `rea` on PATH; the pure half above is the contract)')
} else {
  const { runRea } = await import('../lib/rea.js')
  const version = await runRea(live.command, ['--version'], { timeoutMs: 20_000 })
  check('the live REA answers --version', version.code, 0)
}

console.log('')
if (failures > 0) {
  console.log(failures + ' check(s) FAILED of ' + checks)
  process.exit(1)
}
console.log('all ' + checks + ' checks passed')
