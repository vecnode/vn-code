/**
 * dsh-sql-server — the seven tools.
 *
 * The shape is the one this pack uses everywhere (`{ text, view }`) and the PROSE
 * is the product: a database tool that answers with a table nobody can act on is
 * worse than a shell. Each description says when to call it and what it cannot do,
 * and each answer ends with the next move.
 *
 * The one convention a caller must learn: **`sql_status` first**. It is the only
 * tool that treats "there is no server here" as an answer rather than a failure,
 * and the only one that reports the FOUR independent facts a person needs -
 * a container, a client, a listening port, and the ODBC driver the application
 * will use. The driver is the fact that is missing on every clean Windows machine
 * and the one no amount of container work supplies.
 *
 * The three writers are `sql_server` (lifecycle), `sql_driver` (a machine-wide
 * install, refused without `confirm: "install"`) and `sql_database` action=create.
 * Removing a container needs `confirm` equal to its name.
 */

import { firstLine } from './cli.js'
import { CAPS, isName } from './validate.js'
import { SqlError, columnsSql, countRowsSql, createDatabaseSql, listDatabasesSql, listTablesSql, parseTable, resolveClient, runQuery, runScript } from './sql.js'
import { actOnServer, actOnServer as lifecycle, serverState, startServer } from './server.js'
import { DriverError, driverState, installPlan, runInstall } from './driver.js'
import { findContainerCli, inspectContainer } from './discover.js'

/** The output shape every tool returns. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** A card for the transcript. */
function present(title) {
  return {
    presentCall: () => ({ card: 'generic', title: title, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: title, content: result && result.text ? result.text : '' }),
  }
}

/** A refusal: a sentence, and a view a caller can branch on. */
function refusal(code, message, extra) {
  return { text: message, view: { ok: false, code: code, ...(extra ?? {}) } }
}

/** The same refusal for any thrown failure. */
function failureOf(error) {
  if (error instanceof SqlError || error instanceof DriverError) return refusal(error.code, error.message)
  return refusal('FAILED', error && error.message ? String(error.message) : String(error))
}

/** Pad a column, clipping it to its width. */
function cell(value, width) {
  const text = String(value === undefined || value === null ? '' : value)
  const cut = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '\u2026' : text
  return cut.padEnd(width)
}

/** A fixed-width table: the header line, then one line per row. */
function table(headers, rows) {
  if (rows.length === 0) return headers.join('  ')
  const widths = headers.map((header, index) => Math.min(48, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))))
  const line = (cells) => cells.map((value, index) => cell(value, widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** Rows from a `{ columns, rows }` answer, capped and reported when capped. */
function rowsOf(result, maxRows) {
  const limit = Math.min(Number.isFinite(maxRows) && maxRows > 0 ? maxRows : CAPS.maxRows, CAPS.maxRows)
  const kept = result.rows.slice(0, limit)
  return { kept: kept, total: result.rows.length, capped: result.rows.length > limit, limit: limit }
}

/** Seconds since a start, as a human phrase. */
function duration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return seconds + ' s'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return minutes + ' min'
  return Math.round(minutes / 60) + ' h'
}

/** Build the tools. @param deps - `{ runner, env, platform, sleep, odbcDrivers, driverState, log }`. */
export function buildTools(deps) {
  /** `sql_status`: the whole local surface, and what to do about it. */
  const status = {
    name: 'sql_status',
    description: [
      'Report the SQL Server surface on THIS machine as four independent facts, and the one next move: a server (a container this row owns, a native Windows service, or nothing), a client (`sqlcmd` on the PATH, or the one inside the image), a listening port on 127.0.0.1, and the ODBC DRIVER an application will actually use.',
      'Call this FIRST. It is the only tool that answers "there is nothing here" instead of failing, and the driver fact is the one every clean Windows machine is missing: a container can be up and answering while `pyodbc` still cannot connect, because the driver lives on the HOST.',
      'Read-only. Nothing is started, installed or changed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        container: { type: 'string', description: 'The container name to report on. Default: DSH_SQL_CONTAINER, else "dsh-sql-server".' },
        port: { type: 'number', description: 'The TCP port to probe. Default: DSH_SQL_PORT, else 1433.' },
      },
    },
    output: OUTPUT,
    ...present('SQL Server state'),
    async execute(args) {
      try {
        const view = await serverState(deps, { container: args.container, port: args.port })
        const lines = []
        lines.push('Server: ' + (view.server === 'none' ? 'none on this machine' : view.server === 'native' ? 'a native instance is running' : view.server === 'container-stopped' ? 'container stopped' : 'container running'))
        if (view.cli !== null) lines.push('Container CLI: ' + view.cli.path + (view.cli.version === '' ? '' : ' ' + view.cli.version) + (view.daemon !== null && view.daemon.up ? ' \u00b7 daemon up' : ' \u00b7 daemon NOT answering'))
        else lines.push('Container CLI: none on the PATH')
        if (view.container !== null) {
          lines.push('')
          lines.push('CONTAINER ' + view.container.name)
          lines.push('state       ' + view.container.state + (view.container.status === '' ? '' : ' \u00b7 ' + view.container.status))
          lines.push('image       ' + view.container.image)
          lines.push('ports       ' + (view.container.ports === '' ? '(none published)' : view.container.ports))
          lines.push('listening   127.0.0.1:' + (args.port || deps.env.DSH_SQL_PORT || 1433) + ' \u2014 ' + (view.listening ? 'yes' : 'no'))
        }
        if (view.native.found) {
          lines.push('')
          lines.push('NATIVE SERVICES')
          lines.push(table(['SERVICE', 'STATE'], view.native.services.map((service) => [service.name, service.state])))
        }
        lines.push('')
        lines.push('ODBC DRIVER (what an application connects with)')
        if (view.drivers.drivers.length === 0) lines.push('  none installed \u2014 ' + view.drivers.source)
        else lines.push(table(['DRIVER'], view.drivers.drivers.map((name) => [name])))
        lines.push('')
        lines.push('Next: ' + view.next)
        return { text: lines.join('\n'), view: view }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_server`: the container's lifecycle. */
  const server = {
    name: 'sql_server',
    description: [
      'Manage the SQL Server CONTAINER this row owns: status, start (creating it from `mcr.microsoft.com/mssql/server:2022-latest` when it is absent, pulling the image once), stop, restart, remove (needs confirm equal to the name), and logs.',
      '`start` waits until the server ANSWERS a `SELECT 1`, not merely until the container says running - SQL Server opens its port before it accepts a login, and that window is where a load fails with "Login failed". A new container needs a password for `sa`: set DSH_SQL_SA_PASSWORD (8+ characters from three of upper, lower, digit, symbol) or pass `password`. It is used once, to seed the container.',
      'The databases live in a NAMED VOLUME (DSH_SQL_VOLUME, default `dsh-sql-data`), so `remove` destroys the container and not the data; removing the volume is not something this tool can spell.',
      'A native SQL Server service is reported by `sql_status` and deliberately NOT managed here: this row will not stop a service somebody else\'s work depends on.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'remove', 'logs'], description: 'What to do. Default: status.' },
        container: { type: 'string', description: 'Container name. Default DSH_SQL_CONTAINER, else "dsh-sql-server".' },
        image: { type: 'string', description: 'Image for a NEW container. Default the 2022 image.' },
        port: { type: 'number', description: 'Host port to publish 1433 on. Default 1433.' },
        password: { type: 'string', description: 'The `sa` password for a NEW container. Default DSH_SQL_SA_PASSWORD.' },
        volume: { type: 'string', description: 'Named volume for /var/opt/mssql. Default DSH_SQL_VOLUME, else "dsh-sql-data".' },
        memoryMb: { type: 'number', description: 'Optional `--memory` limit. SQL Server needs at least 2000.' },
        waitSeconds: { type: 'number', description: 'How long `start` waits for the server to answer. Default 300, at most 300.' },
        confirm: { type: 'string', description: 'For remove: repeat the container name. Nothing is removed without it.' },
        tail: { type: 'number', description: 'For logs: lines to show. Default 80, at most 400.' },
      },
    },
    output: OUTPUT,
    ...present('SQL Server container'),
    async execute(args) {
      try {
        const action = String(args.action || 'status').toLowerCase()
        if (action === 'status') {
          const view = await serverState(deps, { container: args.container, port: args.port })
          const text = view.container === null ? 'No container named ' + (args.container || deps.env.DSH_SQL_CONTAINER || 'dsh-sql-server') + '. Next: ' + view.next : 'Container ' + view.container.name + ': ' + view.container.state + ' \u00b7 listening ' + (view.listening ? 'yes' : 'no') + '.\nNext: ' + view.next
          return { text: text, view: view }
        }
        if (action === 'logs') {
          const cli = await findContainerCli(deps)
          if (!cli.found) throw new SqlError('NO_CLI', 'No `docker` or `podman` on this PATH.')
          const name = String(args.container || deps.env.DSH_SQL_CONTAINER || 'dsh-sql-server')
          const tail = Math.min(Number.isFinite(args.tail) && args.tail > 0 ? args.tail : 80, 400)
          const result = await deps.runner(cli.path, ['logs', '--tail', String(tail), name], { env: deps.env, timeoutMs: 25_000 })
          const text = firstLine(result.stdout + result.stderr, 200)
          return { text: (result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : ''), view: { ok: result.code === 0, container: name, tail: tail, text: text } }
        }
        if (action === 'start') {
          const started = await startServer(deps, {
            container: args.container,
            image: args.image,
            port: args.port,
            password: args.password,
            volume: args.volume,
            memoryMb: args.memoryMb,
            waitMs: Number(args.waitSeconds) > 0 ? Number(args.waitSeconds) * 1000 : undefined,
          })
          const lines = []
          // The name and image come from the CALL, not from the state read: a
          // container that was just created can take a moment to appear in `docker
          // ps`, and an answer that crashes on its own success is worse than one
          // that says what it just did.
          const containerName = (started.state.container && started.state.container.name) || String(args.container || deps.env.DSH_SQL_CONTAINER || 'dsh-sql-server')
          const containerImage = (started.state.container && started.state.container.image) || String(args.image || deps.env.DSH_SQL_IMAGE || 'mcr.microsoft.com/mssql/server:2022-latest')
          lines.push(started.created ? 'Created container ' + containerName + ' from ' + containerImage + '.' : started.already ? 'Container ' + containerName + ' was already running.' : 'Started container ' + containerName + '.')
          if (started.pulled) lines.push('Pulled the image first (' + duration(started.pullMs || 0) + ').')
          lines.push('The server ' + (started.ready && started.ready.ok ? 'answers' : 'did NOT answer') + ' after ' + duration(started.elapsedMs) + (started.ready && started.ready.attempts ? ' (' + started.ready.attempts + ' attempts)' : '') + '.')
          if (started.ready && started.ready.ok !== true) lines.push('Last failure: ' + (started.ready.reason || 'unknown') + ' \u2014 read `sql_server` action=logs.')
          lines.push('')
          lines.push('Next: ' + started.state.next)
          if (started.state.drivers.ok !== true) lines.push('The application driver is still missing: ' + started.state.drivers.next)
          return { text: lines.join('\n'), view: { ok: started.ready && started.ready.ok === true, ...started } }
        }
        const done = await lifecycle(deps, { action: action, container: args.container, confirm: args.confirm })
        return {
          text: 'Container ' + done.action + ': ' + done.container + '. ' + (done.text === '' ? '' : done.text + ' ') + 'Next: ' + done.state.next,
          view: { ok: true, ...done },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_driver`: the ODBC driver, status and install. */
  const driver = {
    name: 'sql_driver',
    description: [
      'Report the SQL Server ODBC drivers installed on this machine, and install one when asked. This is the APPLICATION\'s door (pyodbc, SSMS, Excel, Power BI); a container cannot provide it, so "the server works" and "my app connects" are two different facts and this tool owns the second.',
      '`action: "status"` (default) lists what is registered and names the driver an application should use. `action: "install"` needs `confirm: "install"` - it changes the machine for every application and needs administrator rights - and then RUNS the platform\'s own command (winget on Windows, brew on macOS) and reports its exit code instead of assuming success.',
      'ODBC Driver 18 is the one that speaks TLS 1.2 the way SQL Server 2022 requires. The legacy "SQL Server" entry that Windows ships sorts last on purpose: a connection through it fails with "the client and server cannot communicate, because they do not possess a common algorithm".',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'plan'], description: 'status (default), plan (the exact commands, nothing run), or install.' },
        driver: { type: 'string', enum: ['18', '17'], description: 'Which driver to install. Default 18.' },
        confirm: { type: 'string', description: 'For install: the word "install". Nothing is installed without it.' },
      },
    },
    output: OUTPUT,
    ...present('ODBC driver'),
    async execute(args) {
      try {
        const action = String(args.action || 'status').toLowerCase()
        const state = await driverState(deps)
        if (action === 'plan') {
          const plan = installPlan(deps)
          const lines = ['PLAN for ' + plan.platform + (plan.needsElevation ? ' (needs administrator rights)' : ''), '']
          for (const command of plan.commands) lines.push('  ' + command.program + ' ' + command.argv.join(' ') + '\n      ' + command.why)
          lines.push('', plan.note)
          return { text: lines.join('\n'), view: { ok: true, plan: plan, state: state } }
        }
        if (action === 'install') {
          const done = await runInstall(deps, { confirm: args.confirm, driver: args.driver })
          const after = await driverState(deps)
          const lines = [
            'Ran: ' + done.program + ' ' + done.argv.join(' '),
            'Exit code: ' + done.code + ' \u00b7 ' + duration(done.elapsedMs),
            done.stderr === '' ? '' : 'stderr: ' + done.stderr,
            '',
            done.note,
            '',
            after.ok ? 'Driver now available: ' + after.picked : 'Still not usable: ' + after.next,
          ]
          return { text: lines.filter((line) => line !== undefined).join('\n'), view: { ok: after.ok, install: done, state: after } }
        }
        const lines = []
        lines.push('ODBC drivers on this machine (' + state.source + ')')
        if (state.drivers.length === 0) lines.push('  (none)')
        else for (const name of state.drivers) lines.push('  ' + (name === state.picked ? '* ' : '  ') + name)
        lines.push('')
        lines.push(state.ok ? 'An application should use: ' + state.picked : 'Not usable for an application yet: ' + state.next)
        if (!state.ok) lines.push('Next: `sql_driver` action=plan for the exact command, or action=install with confirm: "install".')
        return { text: lines.join('\n'), view: { ok: state.ok, ...state } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_query`: one statement, parsed. */
  const query = {
    name: 'sql_query',
    description: [
      'Run one T-SQL statement (or a short batch separated by semicolons) and return its rows as a table plus a `rows` array. `database` selects the database; the connection defaults come from DSH_SQL_HOST / DSH_SQL_PORT / DSH_SQL_USER / DSH_SQL_SA_PASSWORD, and any of them can be given per call.',
      'The answer is a GRID parsed from `sqlcmd`, so a value containing a TAB or a newline breaks its row, and a real `NULL` arrives as null while the four-letter string "NULL" is indistinguishable. For exact values in bulk, read them through the application or the API, not through this tool - it is a verification surface.',
      'A query that fails throws with the server\'s own `Msg <n>, Level <l>` line, which is the part worth reading. A statement that takes longer than `timeoutSeconds` (default 120) is killed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'The statement. `SET NOCOUNT ON` is prepended for you.' },
        database: { type: 'string', description: 'Database to run in. Default master.' },
        host: { type: 'string', description: 'Server host. Default DSH_SQL_HOST, else 127.0.0.1.' },
        port: { type: 'number', description: 'Server port. Default DSH_SQL_PORT, else 1433.' },
        user: { type: 'string', description: 'Login. Default sa.' },
        password: { type: 'string', description: 'Password. Default DSH_SQL_SA_PASSWORD. Never echoed back.' },
        container: { type: 'string', description: 'Reach the server through this container\'s own sqlcmd. Default DSH_SQL_CONTAINER when set.' },
        maxRows: { type: 'number', description: 'Rows to return. Default 2000, at most 2000.' },
        timeoutSeconds: { type: 'number', description: 'Deadline. Default 120.' },
      },
    },
    output: OUTPUT,
    ...present('SQL query'),
    async execute(args) {
      try {
        const client = await resolveClient(deps, { container: args.container })
        const result = await runQuery(deps, client, {
          sql: args.sql,
          database: args.database,
          host: args.host,
          port: args.port,
          user: args.user,
          password: args.password,
          timeoutMs: Number(args.timeoutSeconds) > 0 ? Number(args.timeoutSeconds) * 1000 : undefined,
        })
        const shown = rowsOf(result, args.maxRows)
        const lines = []
        if (result.rowCount === 0 && result.columns.length > 0) {
          lines.push('No rows. Columns: ' + result.columns.join(', '))
        } else if (result.columns.length === 0) {
          lines.push('The statement returned no result set (a write, or a batch with nothing to print).')
        } else {
          lines.push(table(result.columns, shown.kept.map((row) => result.columns.map((column) => (row[column] === null ? 'NULL' : row[column])))))
          if (shown.capped) lines.push('\u2026 ' + (shown.total - shown.kept.length) + ' more row(s); `maxRows` is ' + shown.limit + '.')
          else lines.push(shown.total + ' row(s).')
        }
        lines.push('')
        lines.push('Through ' + (client.kind === 'container' ? 'the container ' + client.container : 'the host client ' + client.sqlcmd.path) + ' in ' + duration(result.elapsedMs) + '.')
        return { text: lines.join('\n'), view: { ok: true, columns: result.columns, rows: shown.kept, rowCount: shown.total, elapsedMs: result.elapsedMs, transport: client.kind } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_script`: load a .sql file, streamed. */
  const script = {
    name: 'sql_script',
    description: [
      'Run a `.sql` file with `sqlcmd`, STREAMED into the client: a 1.2 GB dump costs one 256 KiB buffer, not a heap the size of the file. `GO` batches are honoured because sqlcmd honours them, `-b` makes a T-SQL error an exit code, and the deadline is 60 minutes by default (at most 6 hours).',
      '`sanitise: true` drops the dump\'s own database DDL as it streams: `USE [master]`, the `CREATE DATABASE ... ON ( FILENAME = N\'C:\\...\' )` block that names THE MACHINE THAT WROTE the dump, and the `ALTER DATABASE ... SET` lines after it. Run it when the dump was made by "Script Database" in SSMS and the databases already exist here; the answer reports how many blocks it dropped.',
      '`verify` is a list of tables (`schema.table` or just `table`) whose row counts are read AFTER a successful load - the difference between "the command exited 0" and "the data is there".',
      'The encoding is detected from the BOM (UTF-16LE/BE or UTF-8), because an SSMS export on Windows is UTF-16 often enough that feeding it to a UTF-8 client prints one syntax error per line.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: { type: 'string', description: 'Absolute path to the .sql file.' },
        database: { type: 'string', description: 'Database to run in. Omit to let the script\'s own `USE` decide.' },
        sanitise: { type: 'boolean', description: 'Drop the CREATE/ALTER DATABASE header while streaming. Default false.' },
        timeoutMinutes: { type: 'number', description: 'Deadline in minutes. Default 60, at most 360.' },
        abortOnError: { type: 'boolean', description: 'Default true (`-b`): a T-SQL error becomes a non-zero exit. Set false to push past bad batches, which the answer then says.' },
        verify: { type: 'array', items: { type: 'string' }, description: 'Tables to count after a successful load.' },
        host: { type: 'string', description: 'Server host. Default DSH_SQL_HOST, else 127.0.0.1.' },
        port: { type: 'number', description: 'Server port. Default 1433.' },
        user: { type: 'string', description: 'Login. Default sa.' },
        password: { type: 'string', description: 'Password. Default DSH_SQL_SA_PASSWORD.' },
        container: { type: 'string', description: 'Run through this container\'s own sqlcmd. Default DSH_SQL_CONTAINER when set.' },
      },
    },
    output: OUTPUT,
    ...present('SQL script'),
    async execute(args) {
      try {
        const client = await resolveClient(deps, { container: args.container })
        const minutes = Number(args.timeoutMinutes) > 0 ? Math.min(Number(args.timeoutMinutes), 360) : 60
        const run = await runScript(deps, client, {
          file: args.file,
          database: args.database,
          sanitise: args.sanitise === true,
          timeoutMs: minutes * 60_000,
          abortOnError: args.abortOnError !== false,
          host: args.host,
          port: args.port,
          user: args.user,
          password: args.password,
        })
        const lines = []
        const ok = run.code === 0 && run.timedOut !== true
        lines.push((ok ? 'Loaded' : 'FAILED') + ': ' + args.file)
        lines.push('  bytes read      ' + run.bytes + ' (' + run.encoding + ')')
        lines.push('  elapsed         ' + duration(run.elapsedMs))
        lines.push('  exit code       ' + run.code + (run.timedOut ? ' (timed out)' : ''))
        lines.push('  transport       ' + (client.kind === 'container' ? 'container ' + client.container : 'host ' + client.sqlcmd.path))
        if (run.sanitised) {
          lines.push('  sanitised       yes \u2014 dropped ' + run.dropped.createDatabase + ' CREATE DATABASE block(s), ' + run.dropped.alterDatabase + ' ALTER DATABASE line(s), ' + run.dropped.useMaster + ' USE [master] line(s)')
        }
        if (run.abortOnError !== true) lines.push('  errors          did NOT abort (`abortOnError: false`): a failed batch was skipped and the rest still ran')
        if (typeof run.stdinError === 'string' && run.stdinError !== '') lines.push('  stdin           ' + run.stdinError)
        if (run.truncated) lines.push('  output          cut at the cap; the answer holds the start')
        if (run.error !== '' && ok !== true) lines.push('  first error     ' + run.error)
        if (run.stderr !== '' && run.error === '') lines.push('  stderr          ' + firstLine(run.stderr, 400))
        const counts = []
        if (Array.isArray(args.verify) && args.verify.length > 0) {
          lines.push('')
          lines.push('VERIFY')
          const names = args.verify.filter((name) => typeof name === 'string' && name !== '')
          try {
            const result = await runQuery(deps, client, { sql: countRowsSql(names), database: args.database, host: args.host, port: args.port, user: args.user, password: args.password, timeoutMs: 300_000 })
            for (const row of result.rows) {
              counts.push(row)
              lines.push('  ' + String(row.table).padEnd(40) + String(row.rows))
            }
          } catch (err) {
            // A verification that fails must not throw away the load's own answer:
            // the load may have succeeded and only the check be wrong.
            lines.push('  could not count: ' + (err && err.message ? String(err.message) : String(err)))
          }
        }
        if (ok !== true) lines.push('', 'Read the first error above. `sql_server` action=logs shows the server\'s side.')
        return { text: lines.join('\n'), view: { ok: ok, ...run, verify: counts } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_database`: the catalogue and the one DDL. */
  const database = {
    name: 'sql_database',
    description: [
      'The databases on the server, their tables, and one table\'s columns: `action: "list"` (default), `"tables"`, `"columns"`, `"count"` (row counts for named tables) and `"create"`.',
      'This is the tool that answers "did the dump land, and what is in it": `tables` shows every user table with its row count and size, which is how a load is checked in one call instead of a dozen queries.',
      '`create` is the ONE DDL this row runs on purpose, because a dump often needs its database to exist already. Everything else is read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'tables', 'columns', 'count'], description: 'What to do. Default list.' },
        database: { type: 'string', description: 'The database. Needed by tables/columns/count/create.' },
        table: { type: 'string', description: 'For columns: the table name.' },
        schema: { type: 'string', description: 'For columns: the schema. Default dbo.' },
        tables: { type: 'array', items: { type: 'string' }, description: 'For count: schema.table or table names.' },
        host: { type: 'string', description: 'Server host. Default DSH_SQL_HOST.' },
        port: { type: 'number', description: 'Server port. Default 1433.' },
        user: { type: 'string', description: 'Login. Default sa.' },
        password: { type: 'string', description: 'Password. Default DSH_SQL_SA_PASSWORD.' },
        container: { type: 'string', description: 'Run through this container\'s own sqlcmd.' },
      },
    },
    output: OUTPUT,
    ...present('SQL database'),
    async execute(args) {
      try {
        const client = await resolveClient(deps, { container: args.container })
        const connection = { host: args.host, port: args.port, user: args.user, password: args.password }
        const action = String(args.action || 'list').toLowerCase()
        if (action === 'list') {
          const result = await runQuery(deps, client, { sql: listDatabasesSql(), database: 'master', ...connection })
          const lines = [table(['DATABASE', 'DATA MB', 'LOG MB', 'STATE'], result.rows.map((row) => [row.database, row.data_mb, row.log_mb, row.state]))]
          lines.push('', result.rowCount + ' database(s).')
          return { text: lines.join('\n'), view: { ok: true, databases: result.rows } }
        }
        if (action === 'create') {
          const name = String(args.database || '')
          if (!isName(name)) throw new SqlError('BAD_DATABASE', 'Pass `database` with a name: letters, digits, _ - . (got "' + name + '").')
          await runQuery(deps, client, { sql: createDatabaseSql(name), database: 'master', ...connection })
          return { text: 'Created database [' + name + ']. Next: load a script with `sql_script`, or list it with action=tables.', view: { ok: true, created: name } }
        }
        if (action === 'tables') {
          const name = String(args.database || '')
          if (!isName(name)) throw new SqlError('BAD_DATABASE', 'Pass `database`.')
          const result = await runQuery(deps, client, { sql: listTablesSql(), database: name, ...connection })
          if (result.rows.length === 0) {
            return { text: 'Database [' + name + '] has no user tables. That is the answer to "did the dump land": it did not, or it landed in another database.', view: { ok: true, database: name, tables: [] } }
          }
          const lines = [table(['SCHEMA', 'TABLE', 'ROWS', 'MB'], result.rows.map((row) => [row.schema, row.table, row.rows, row.total_mb]))]
          lines.push('', result.rowCount + ' table(s) in [' + name + '].')
          return { text: lines.join('\n'), view: { ok: true, database: name, tables: result.rows } }
        }
        if (action === 'columns') {
          const name = String(args.database || '')
          if (!isName(name)) throw new SqlError('BAD_DATABASE', 'Pass `database`.')
          if (!args.table) throw new SqlError('BAD_TABLE', 'Pass `table`.')
          const result = await runQuery(deps, client, { sql: columnsSql(args.schema, args.table), database: name, ...connection })
          if (result.rows.length === 0) return { text: 'No columns: [' + name + '].[' + (args.schema || 'dbo') + '].[' + args.table + '] does not exist.', view: { ok: false, code: 'NO_TABLE' }, }
          const lines = [table(['#', 'COLUMN', 'TYPE', 'LEN', 'NULL'], result.rows.map((row) => [row.pos, row.column, row.type, row.len, row.nullable]))]
          return { text: lines.join('\n'), view: { ok: true, columns: result.rows } }
        }
        if (action === 'count') {
          const name = String(args.database || '')
          if (!isName(name)) throw new SqlError('BAD_DATABASE', 'Pass `database`.')
          const names = Array.isArray(args.tables) ? args.tables.filter((entry) => typeof entry === 'string' && entry !== '') : []
          if (names.length === 0) throw new SqlError('BAD_TABLE', 'Pass `tables`: an array of names.')
          const result = await runQuery(deps, client, { sql: countRowsSql(names.slice(0, CAPS.maxIdentifiers)), database: name, ...connection })
          const lines = [table(['TABLE', 'ROWS'], result.rows.map((row) => [row.table, row.rows]))]
          return { text: lines.join('\n'), view: { ok: true, counts: result.rows } }
        }
        throw new SqlError('BAD_ACTION', 'Not an action: ' + action)
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `sql_restore`: a .bak, moved into this instance. */
  const restore = {
    name: 'sql_restore',
    description: [
      'Restore a `.bak` into a database on this server. A backup carries the physical file paths of the machine that took it, so every restore here is built with `MOVE` clauses: `listFiles: true` first (a `RESTORE FILELISTONLY`) and then the same call with the rows it printed, or pass `files` yourself.',
      'The path is the path the SERVER sees, not the host: for the container this row starts, a file on the host must be inside the container (or a mounted folder) before SQL Server can read it - `dataDir` is likewise the folder inside the server (`/var/opt/mssql/data`).',
      'There is no `backup` action on purpose: a backup writes a file somewhere the server can reach, and that is the same conversation as the restore, better had once. Nothing here deletes or overwrites a database without `REPLACE` being explicit in the statement the answer prints.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['backupPath', 'database'],
      properties: {
        backupPath: { type: 'string', description: 'Absolute path to the .bak AS THE SERVER SEES IT.' },
        database: { type: 'string', description: 'The database to restore into.' },
        listFiles: { type: 'boolean', description: 'Only run FILELISTONLY and print the logical names. Nothing is restored.' },
        files: {
          type: 'array',
          description: 'For the restore: the FILELISTONLY rows, as { logical, type } (D = data, L = log).',
          items: { type: 'object', properties: { logical: { type: 'string' }, type: { type: 'string' } }, required: ['logical'] },
        },
        dataDir: { type: 'string', description: 'Folder INSIDE the server for the data files. Default /var/opt/mssql/data for the container.' },
        host: { type: 'string' },
        port: { type: 'number' },
        user: { type: 'string' },
        password: { type: 'string' },
        container: { type: 'string' },
      },
    },
    output: OUTPUT,
    ...present('SQL restore'),
    async execute(args) {
      try {
        const { fileListSql, restoreSql, runQuery: run } = await import('./sql.js')
        const client = await resolveClient(deps, { container: args.container })
        const connection = { host: args.host, port: args.port, user: args.user, password: args.password }
        if (args.listFiles === true) {
          const result = await run(client, { sql: fileListSql(args.backupPath), database: 'master', ...connection, timeoutMs: 300_000 })
          const lines = [table(['LOGICAL NAME', 'TYPE', 'PHYSICAL NAME'], result.rows.map((row) => [row.LogicalName, row.Type, row.PhysicalName]))]
          lines.push('', 'Pass these as `files: [{ logical, type }]` with `dataDir` to restore.')
          return { text: lines.join('\n'), view: { ok: true, files: result.rows } }
        }
        const statement = restoreSql({
          database: args.database,
          backupPath: args.backupPath,
          dataDir: args.dataDir || '/var/opt/mssql/data',
          files: args.files,
        })
        const result = await run(deps, client, { sql: statement, database: 'master', ...connection, timeoutMs: 60 * 60_000 })
        return {
          text: 'Restored [' + args.database + ']. ' + (result.rowCount > 0 ? '' : '') + '\n\n' + statement + '\n\nNext: `sql_database` action=tables database=' + args.database,
          view: { ok: true, database: args.database, statement: statement },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  return [status, server, driver, query, script, database, restore]
}
