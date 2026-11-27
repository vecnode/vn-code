// check-deck.mjs - dsh-deckcraft's own contract, driven directly.
//
// The row is an argv builder, a command-id parser and an output scope; none of
// that needs DeckCraft installed, so the whole check runs anywhere. The live half
// drives `deckcraft-cli --version` when a binary is present and says so when not.
//
// Run:  node checks/check-deck.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertOutputAllowed,
  buildProbeArgs,
  buildRenderArgs,
  buildRunArgs,
  isCommandId,
  parseCommandList,
  resolveDeckCli,
  runDeck,
  settingsDir,
} from '../lib/deck.js'
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

console.log('# dsh-deckcraft')

// --------------------------------------------------------------- the row
check('the package names the row', pkg.name, 'dsh-deckcraft')
check('the marker matches package.json', PLUGIN_VERSION, pkg.version)
check('the bundle points at its patch', pkg.dsh.bundle.patch, './cordis.patch.yml')
check('no npm dependency is declared', Object.keys(pkg.dependencies ?? {}).length, 0)
check('the patch inserts one row', /id:\s*deckcraft\b/.test(readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8')))

// --------------------------------------------------------------- the tools
const tools = buildTools({ ctx: {}, env: {}, platform: 'win32' })
check('four tools are registered', tools.length, 4)
check(
  'their names are the documented surface',
  tools.map((tool) => tool.name).join(','),
  'deck_status,deck_commands,deck_run,deck_export',
)
for (const tool of tools) {
  check(tool.name + ': has a schema', Boolean(tool.parameters && tool.parameters.type === 'object'))
  check(tool.name + ': answers text and a view', Boolean(tool.output && tool.output.schema && tool.output.schema.required.join(',') === 'text,view'))
  check(tool.name + ': describes itself', typeof tool.description === 'string' && tool.description.length > 80)
  check(tool.name + ': is executed by a function', typeof tool.execute === 'function')
}

// --------------------------------------------------------------- the ids
check('a dotted id is a command', isCommandId('slide.new') && isCommandId('format.paragraph'), true)
check('a bare word is not a command', isCommandId('new'), false)
check('a flag-shaped id is not a command', isCommandId('--save'), false)
check('an id with a space is not a command', isCommandId('slide. new'), false)

const listed = parseCommandList('slide.new        Create a slide\nformat.paragraph Set paragraph format\n\n2 commands\n')
check('the list parser keeps the ids', listed.map((row) => row.id).join(','), 'slide.new,format.paragraph')
check('the list parser keeps the summary', listed[0].summary, 'Create a slide')
check('a header line is skipped', parseCommandList('Commands:\nslide.new  x').length, 1)

// --------------------------------------------------------------- the argv
check(
  'a run names each command and saves',
  buildRunArgs({ commands: ['slide.new={"layout":"titleOnly"}', 'slide.duplicate'], save: 'decks/a.deckcraft' }).join(' '),
  'run --cmd slide.new={"layout":"titleOnly"} --cmd slide.duplicate --save decks/a.deckcraft',
)
check('a sample run is its own shape', buildRunArgs({ sample: true, save: 'decks/a.deckcraft' }).join(' '), 'run --sample --save decks/a.deckcraft')
check('a bad id is refused before the CLI runs', (() => { try { buildRunArgs({ commands: ['--save=1'] }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('a bad JSON argument is refused', (() => { try { buildRunArgs({ commands: ['slide.new={nope}'] }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('an empty batch is refused', (() => { try { buildRunArgs({ commands: [] }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check('an oversized batch is refused', (() => { try { buildRunArgs({ commands: Array.from({ length: 201 }, () => 'slide.new') }); return 'accepted' } catch { return 'refused' } })(), 'refused')
check(
  'a render names the deck, --all, the scale and the directory',
  buildRenderArgs({ deck: 'decks/a.deckcraft', out: 'renders/a', scale: 2 }).join(' '),
  'render decks/a.deckcraft --all --scale 2 renders/a',
)
check('a render without a scale omits it', buildRenderArgs({ deck: 'a.deckcraft', out: 'r' }).join(' '), 'render a.deckcraft --all r')
check('probes are version/commands/help', [buildProbeArgs('version'), buildProbeArgs('commands'), buildProbeArgs('help')].map((a) => a.join(' ')).join('|'), '--version|commands|--help')

// --------------------------------------------------------------- the scope
const ws = path.resolve('/work/project')
check('a save inside the workspace is allowed', assertOutputAllowed({ target: path.join(ws, 'decks', 'a.deckcraft'), workspace: ws, platform: 'linux', realpath: false }), path.join(ws, 'decks', 'a.deckcraft'))
check('a save outside it is refused', (() => { try { assertOutputAllowed({ target: '/home/me/Documents/a.deckcraft', workspace: ws, platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')
check('a named allowRoot is honoured', (() => { try { return assertOutputAllowed({ target: '/opt/decks/a.deckcraft', workspace: ws, allowRoot: '/opt/decks', platform: 'linux', realpath: false }) } catch { return 'refused' } })(), path.resolve('/opt/decks/a.deckcraft'))
check('a sibling prefix is not "inside"', (() => { try { assertOutputAllowed({ target: '/work/project-evil/x', workspace: ws, platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')
check('no workspace refuses everything', (() => { try { assertOutputAllowed({ target: path.join(ws, 'a'), workspace: '', platform: 'linux', realpath: false }); return 'allowed' } catch { return 'refused' } })(), 'refused')

// --------------------------------------------------------------- discovery
check('no PATH entry resolves to nothing', resolveDeckCli({ PATH: '', DSH_DECKCRAFT_CLI: '' }, 'linux').command, '')
check('a missing binary is said in one line', Boolean(__internals.activationLine({ command: '', source: 'missing' }).includes('storytold/deckcraft')), true)
const settings = settingsDir({ XDG_CONFIG_HOME: '/tmp/cfg' }, 'linux')
check('the settings folder is DeckCraft\'s documented one', settings, path.join('/tmp/cfg', 'deckcraft'))

// --------------------------------------------------------------- the skills
const skillsRoot = path.join(here, '..', 'skills')
const skills = ['deckcraft-deck', 'deckcraft-commands', 'deckcraft-export']
check('three skills ship', skills.every((name) => existsSync(path.join(skillsRoot, name, 'SKILL.md'))), true)
for (const name of skills) {
  const text = readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8')
  const front = /^---\nname: ([\w-]+)\ndescription: (.+)\nwhenToUse: (.+)\n---/m.exec(text)
  check(name + ': frontmatter is complete', Boolean(front))
  check(name + ': names itself', front ? front[1] : '', name)
}

// --------------------------------------------------------------- live half
const live = resolveDeckCli(process.env, process.platform)
if (live.command === '') {
  console.log('skip the live DeckCraft probe (no `deckcraft-cli` on PATH; the pure half above is the contract)')
} else {
  const version = await runDeck(live.command, buildProbeArgs('version'), { timeoutMs: 20_000 })
  check('the live CLI answers --version', version.code, 0)
}

console.log('')
if (failures > 0) {
  console.log(failures + ' check(s) FAILED of ' + checks)
  process.exit(1)
}
console.log('all ' + checks + ' checks passed')
