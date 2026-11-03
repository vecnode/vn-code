/**
 * dsh-sql-server — the package's own check.
 *
 * Dependency-free, no server, no docker, no network: every branch that touches the
 * machine goes through `deps.runner`, and this check hands it scripted answers. What
 * it proves is the row's CONTRACT - seven tools with closed schemas, no route, two
 * skills whose frontmatter parses, the refusal that happens before an install, the
 * password policy, and the four pure functions a wrong answer would be silent in
 * (the sanitiser, the grid parser, the three-part table name, the MOVE clauses).
 *
 *   node checks/check-sqlserver-node.mjs      (npm run check)
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CAPABILITIES,
  PLUGIN_VERSION,
  SKILL_FILES,
  __internals,
  apply,
  activationLine,
  createDeps,
  parseSkillFile,
} from '../lib/index.js'
import {
  countRowsSql,
  detectEncoding,
  firstSqlError,
  parseTable,
  restoreSql,
  sanitiseLine,
  scriptCodePage,
  sqlcmdArgv,
  clientEnv,
  withTransport,
} from '../lib/sql.js'
import { checkPassword, isName, isPort } from '../lib/validate.js'
import { pickDriver } from '../lib/discover.js'
import { installPlan } from '../lib/driver.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : '\n       expected ' + JSON.stringify(expected) + '\n       actual   ' + JSON.stringify(actual)))
}

function ok(label, condition) {
  check(label, condition === true, true)
}

/** A runner that answers from a table of matchers and records what it was asked. */
function scriptedRunner(table) {
  const calls = []
  const runner = async (program, argv, options = {}) => {
    calls.push({ program: program, argv: argv, stdin: options.stdin !== undefined })
    for (const entry of table) {
      if (entry.program !== undefined && entry.program !== program) continue
      if (entry.match !== undefined && !argv.join(' ').includes(entry.match)) continue
      return {
        file: program,
        argv: argv,
        code: entry.code === undefined ? 0 : entry.code,
        signal: '',
        stdout: entry.stdout || '',
        stderr: entry.stderr || '',
        timedOut: false,
        truncated: false,
        error: entry.error || '',
        elapsedMs: 1,
        stdinBytes: 0,
        stdinError: '',
      }
    }
    return { file: program, argv: argv, code: 0, signal: '', stdout: '', stderr: '', timedOut: false, truncated: false, error: '', elapsedMs: 1, stdinBytes: 0, stdinError: '' }
  }
  runner.calls = calls
  return runner
}

const ctx = { logger: { info() {}, warn() {} }, get: () => undefined, effect: (fn) => fn(), tools: { register: () => () => {} } }

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------
{
  const seen = { tools: [], routes: 0 }
  const registrations = []
  apply({
    get: (name) => (name === 'connection' ? { fetch: { register: () => ((seen.routes += 1), () => {}) } } : undefined),
    tools: { register: (tool) => (registrations.push(tool.name), seen.tools.push(tool), () => {}) },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  })
  check('registers seven tools', seen.tools.length, 7)
  check('...named for the surface the README promises', registrations.join(','), 'sql_status,sql_server,sql_driver,sql_query,sql_script,sql_database,sql_restore')
  ok(
    '...each with a closed schema, an output contract and an execute',
    seen.tools.every(
      (tool) =>
        tool.parameters !== undefined &&
        tool.parameters.type === 'object' &&
        tool.parameters.additionalProperties === false &&
        typeof tool.execute === 'function' &&
        tool.output !== undefined &&
        tool.output.schema !== undefined &&
        typeof tool.presentCall === 'function' &&
        typeof tool.presentResult === 'function',
    ),
  )
  check('...and NO route, because the row is host-only', seen.routes, 0)
  check('CAPABILITIES.tools is the registration, in order', CAPABILITIES.tools.join(','), registrations.join(','))
  ok('the activation line names the tools and the driver fact', /seven sql_\* tools/.test(activationLine()) && /driver/.test(activationLine()))
}

// ---------------------------------------------------------------------------
// 2. The package's own metadata
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  check('version matches package.json', PLUGIN_VERSION, pkg.version)
  ok('package.json declares the bundle patch', pkg.dsh !== undefined && pkg.dsh.bundle !== undefined && pkg.dsh.bundle.patch === './cordis.patch.yml')
  ok('zero runtime dependencies', pkg.dependencies === undefined)
  check('two skills are declared', SKILL_FILES.length, 2)
  for (const entry of SKILL_FILES) {
    const text = readFileSync(path.resolve(packageDir, 'lib', entry.file), 'utf8')
    const parsed = parseSkillFile(text)
    check('skill ' + entry.name + ' declares that name in its frontmatter', parsed.meta.name, entry.name)
    ok('skill ' + entry.name + ' has a description and a body', typeof parsed.meta.description === 'string' && parsed.meta.description.length > 80 && parsed.content.length > 500)
  }
}

// ---------------------------------------------------------------------------
// 3. The driver, including the refusal that must happen before anything runs
// ---------------------------------------------------------------------------
{
  check('ODBC Driver 18 wins', pickDriver(['SQL Server', 'ODBC Driver 17 for SQL Server', 'ODBC Driver 18 for SQL Server']).name, 'ODBC Driver 18 for SQL Server')
  check('the legacy driver sorts last', pickDriver(['SQL Server', 'ODBC Driver 13 for SQL Server']).name, 'ODBC Driver 13 for SQL Server')
  check('no known driver is an empty answer, not a crash', pickDriver(['Some Other Driver']).name, '')
  check('a modern driver is flagged modern', pickDriver(['ODBC Driver 18 for SQL Server']).modern, true)
  check('the legacy driver is not', pickDriver(['SQL Server']).modern, false)

  const winPlan = installPlan({ platform: 'win32' })
  ok('the Windows plan is winget + Microsoft.ODBCDriver18', winPlan.commands[0].program === 'winget' && winPlan.commands[0].argv.includes('Microsoft.ODBCDriver18'))
  ok('...and says it needs elevation', winPlan.needsElevation === true)
  check('the macOS plan uses the Microsoft tap', installPlan({ platform: 'darwin' }).commands[1].argv.slice(0, 2).join(' '), 'install microsoft/mssql-release/msodbcsql18')
  check('the Linux plan installs msodbcsql18', installPlan({ platform: 'linux' }).commands[3].argv.slice(-1)[0], 'msodbcsql18')

  let spawns = 0
  const deps = createDeps(ctx, {
    env: {},
    platform: 'win32',
    runner: async () => {
      spawns += 1
      return { code: 0, stdout: '', stderr: '', error: '', timedOut: false, truncated: false, elapsedMs: 1, argv: [] }
    },
    odbcDrivers: async () => ({ found: true, names: ['SQL Server'], source: 'registry', detail: '' }),
  })
  const driverTool = __internals.buildTools(deps).find((tool) => tool.name === 'sql_driver')
  const refused = await driverTool.execute({ action: 'install' }, {})
  check('an install without consent is refused', refused.view.code, 'NO_CONSENT')
  check('...and nothing was spawned', spawns, 0)
  const status = await driverTool.execute({ action: 'status' }, {})
  check('the legacy driver alone is not "ok"', status.view.ok, false)
  ok('...and the sentence names TLS', /TLS 1\.2/.test(status.view.next))
}

// ---------------------------------------------------------------------------
// 4. The password policy, before a container is created
// ---------------------------------------------------------------------------
{
  ok('a strong password passes', checkPassword('Dsh!Dev2026Sql').ok === true)
  ok('eight characters is the floor', checkPassword('Ab1!efgh').ok === true)
  check('seven characters is refused', checkPassword('Ab1!efg').ok, false)
  check('one character class is refused', checkPassword('aaaaaaaaa').ok, false)
  check('two classes are refused', checkPassword('aaaaaaaa1').ok, false)
  const deps = createDeps(ctx, {
    env: {},
    runner: scriptedRunner([
      { match: '--version', stdout: 'Docker version 25.0.3' },
      { match: 'info', stdout: '25.0.3' },
      { match: 'ps -a', stdout: '' },
    ]),
  })
  const serverTool = __internals.buildTools(deps).find((tool) => tool.name === 'sql_server')
  const noPassword = await serverTool.execute({ action: 'start' }, {})
  check('starting with no password is refused by name', noPassword.view.code, 'NO_PASSWORD')
  const weak = await serverTool.execute({ action: 'start', password: 'weak' }, {})
  check('starting with a weak password is refused before docker run', weak.view.code, 'BAD_PASSWORD')
}

// ---------------------------------------------------------------------------
// 5. Starting a server, driven end to end with a scripted engine
// ---------------------------------------------------------------------------
{
  const runner = scriptedRunner([
    { match: 'ps -a', stdout: '' },
    { match: 'image inspect', code: 0, stdout: 'sha256:abc' },
    { match: 'run -d', code: 0, stdout: 'container-id' },
    { match: 'sqlcmd -?', code: 0, stdout: 'Microsoft (R) SQL Server Command Line Tool\nVersion 18.2.0001.1' },
    { match: 'SELECT 1', code: 0, stdout: '1\n' },
  ])
  const deps = createDeps(ctx, {
    env: { DSH_SQL_SA_PASSWORD: 'Dsh!Dev2026Sql' },
    runner: runner,
    sleep: async () => {},
    odbcDrivers: async () => ({ found: true, names: ['ODBC Driver 18 for SQL Server'], source: 'registry', detail: '' }),
  })
  const serverTool = __internals.buildTools(deps).find((tool) => tool.name === 'sql_server')
  const started = await serverTool.execute({ action: 'start' }, {})
  ok('a scripted start creates the container and reports ready', started.view.created === true && started.view.ready.ok === true)
  const runCall = runner.calls.find((call) => call.argv.join(' ').includes('run -d'))
  ok('...docker run published the port and mounted the volume', runCall.argv.includes('1433:1433') && runCall.argv.join(' ').includes('dsh-sql-data:/var/opt/mssql'))
  ok('...the password went in as MSSQL_SA_PASSWORD', runCall.argv.join(' ').includes('MSSQL_SA_PASSWORD=Dsh!Dev2026Sql'))
  ok('...and readiness was asked with a real statement, not the port', runner.calls.some((call) => call.argv.join(' ').includes('SELECT 1')))
}

// ---------------------------------------------------------------------------
// 6. The pure functions a wrong answer would be silent in
// ---------------------------------------------------------------------------
{
  check('a database name is not a free-form string', isName('ProductHub'), true)
  check('...and injection is not a name', isName('x]; DROP DATABASE master; --'), false)
  check('a port has a range', isPort(0), false)
  check('...and 1433 is a port', isPort(1433), true)

  const stats = { droppedCreateDatabase: 0, droppedAlterDatabase: 0, droppedUseMaster: 0 }
  check('USE [master] is dropped', sanitiseLine('USE [master]', stats, false).keep, false)
  const create = sanitiseLine("CREATE DATABASE [STUDIO] ON PRIMARY ( NAME = N'STUDIO', FILENAME = N'C:\\x.mdf' )", stats, false)
  ok('CREATE DATABASE starts a skip that runs to its GO', create.keep === false && create.skipping === true)
  check('...the block body is dropped', sanitiseLine("( NAME = N'STUDIO' )", stats, true).keep, false)
  check('...and the GO closes it', sanitiseLine('GO', stats, true).skipping, false)
  check('an ALTER DATABASE line is dropped', sanitiseLine('ALTER DATABASE [STUDIO] SET ANSI_NULLS OFF', stats, false).keep, false)
  check('a plain INSERT is kept', sanitiseLine("INSERT [dbo].[t] ([a]) VALUES (1)", stats, false).keep, true)
  check('three database blocks were counted', stats.droppedCreateDatabase + stats.droppedUseMaster + stats.droppedAlterDatabase, 3)

  const grid = parseTable('id\tname\n1\tAlice\n2\tNULL\n\n(2 rows affected)\n')
  check('the grid header is the column list', grid.columns.join(','), 'id,name')
  check('...NULL is null, not the string', grid.rows[1].name, null)
  check('...and the affected-rows line is not a row', grid.rowCount, 2)
  check('a dashes rule is skipped', parseTable('a\tb\n----\t----\n1\t2\n').rows.length, 1)

  check('a server error is one readable line', firstSqlError('Msg 208, Level 16, State 1, Server x, Line 2\nInvalid object name').startsWith('Msg 208 (level 16):'), true)
  check('no error is an empty string', firstSqlError('all good'), '')

  check('a three-part table name is not read as two', countRowsSql(['STUDIO.dbo.studio_mockups']).includes('[STUDIO].[dbo].[studio_mockups]'), true)
  check('...and a bare name gets dbo', countRowsSql(['t']).includes('[dbo].[t]'), true)

  const restore = restoreSql({
    database: 'ProductHub',
    backupPath: '/var/opt/mssql/backup/ph.bak',
    dataDir: '/var/opt/mssql/data/',
    files: [
      { logical: 'ProductHub', type: 'D' },
      { logical: 'ProductHub_log', type: 'L' },
    ],
  })
  ok('a restore moves BOTH files', /MOVE N'ProductHub' TO N'\/var\/opt\/mssql\/data\/ProductHub\.mdf'/.test(restore) && /MOVE N'ProductHub_log' TO N'\/var\/opt\/mssql\/data\/ProductHub_log\.ldf'/.test(restore))
  ok('...and asks for no interactive answer', restore.includes('RECOVERY'))

  const argv = sqlcmdArgv({ kind: 'container', container: 'c', cli: { path: 'docker' }, sqlcmd: { path: '/opt/mssql-tools18/bin/sqlcmd' }, argvPrefix: ['exec', 'c'], passwordViaEnv: false }, { input: '/tmp/x.sql', database: 'db', user: 'sa' })
  ok('an -i call carries the trust flag, the abort flag and the file', argv.includes('-C') && argv.includes('-b') && argv[argv.indexOf('-i') + 1] === '/tmp/x.sql')
  check('the container transport is prefixed with docker exec', argv.slice(0, 3).join(' '), 'exec c /opt/mssql-tools18/bin/sqlcmd')
  const hostArgv = withTransport({ kind: 'host' }, ['sqlcmd', '-S', 'h'], { password: 'p' })
  check('the host transport never puts the password in argv', hostArgv.join(' ').includes('p'), false)
  check('...it goes in the environment instead', clientEnv({ passwordViaEnv: true }, { password: 'p' }).SQLCMDPASSWORD, 'p')
  const containerArgv = withTransport({ kind: 'container' }, ['exec', 'c', '/opt/sqlcmd'], { password: 'p' })
  ok('the container transport passes it with -e and no shell', containerArgv[1] === '-e' && containerArgv[2] === 'SQLCMDPASSWORD=p')

  check('UTF-16LE is sqlcmd code page 1200', scriptCodePage('utf-16le'), '1200')
  check('UTF-8 is 65001', scriptCodePage('utf-8'), '65001')

  // The BOM detection is a 4-byte read, so it is driven against real files.
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sql-check-'))
  try {
    const utf16 = path.join(dir, 'a.sql')
    writeFileSync(utf16, Buffer.from('\ufeffSELECT 1', 'utf16le'))
    check('a UTF-16LE BOM is detected', detectEncoding(utf16), 'utf-16le')
    const utf8 = path.join(dir, 'b.sql')
    writeFileSync(utf8, Buffer.from('SELECT 1', 'utf8'))
    check('no BOM is UTF-8', detectEncoding(utf8), 'utf-8')
    const utf16be = path.join(dir, 'c.sql')
    writeFileSync(utf16be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('SELECT 1', 'utf16le')]))
    check('a UTF-16BE BOM is detected', detectEncoding(utf16be), 'utf-16be')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n' + (failures === 0 ? 'ok: ' + checks + ' checks' : 'FAILED: ' + failures + ' of ' + checks + ' checks'))
process.exit(failures === 0 ? 0 : 1)
