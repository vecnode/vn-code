/**
 * dsh-sql-server — sending T-SQL, and loading a dump.
 *
 * One client, two transports, because a clean Windows machine is exactly the
 * machine where neither half is guaranteed:
 *
 *   - **host** — `sqlcmd` on the PATH, talking to `host,port` with ODBC;
 *   - **container** — the `sqlcmd` inside the image, reached with `docker exec`,
 *     so a machine with no client tools at all can still create a database and
 *     load a 1 GB script.
 *
 * WHY A SCRIPT GOES THROUGH `-i` AND NOT THROUGH STDIN. Piping a dump into
 * `sqlcmd` looks tidier - no temp file, no copy - and it is WRONG: sqlcmd's stdin
 * reader mangles very long lines, and an SSMS dump is nothing but very long lines
 * (one `INSERT` per row, each several kilobytes of JSON). Measured on a real
 * 310 KB dump: stdin loaded 0 of 23 mockup rows and exited 0; `-i` loaded 23 of
 * 23. A silent partial load is the worst failure this row could have, so `-i` is
 * the only path, and the temp-file/copy cost is the price of correctness.
 *
 * A `.sql` dump is STREAMED when it is filtered: `readScript()` is an async
 * iterable of UTF-8 chunks, so the sanitised copy of a multi-gigabyte dump is
 * written with one buffer, not a heap the size of the file.
 *
 * The encoding is read from the BOM and handed to sqlcmd as its own code page
 * (`-f 1200` for UTF-16LE, `-f 65001` for UTF-8), which is why an SSMS export works
 * untouched. When the dump carries its own `CREATE DATABASE` / `ALTER DATABASE`
 * header - with the mdf/ldf paths of THE MACHINE THAT WROTE IT - `sanitise` writes
 * the filtered copy instead, in UTF-8.
 *
 * The password never rides in argv on the host: it goes to the child as
 * `SQLCMDPASSWORD`. On the container transport it is a `docker exec -e`, the only
 * place it can go, and `docker inspect` masks the value.
 */

import { closeSync, createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'

import { firstLine } from './cli.js'
import { CAPS, isAbsolutePath, isName } from './validate.js'
import { DEFAULT_PORT, findContainerCli, findContainerSqlcmd, findHostSqlcmd, inspectContainer } from './discover.js'

/** A typed failure: a code a caller can branch on and a sentence a person reads. */
export class SqlError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'SqlError'
    this.code = code
    this.extra = extra ?? {}
  }
}

/** The first non-empty of a list, as a string. */
export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text !== '') return text
  }
  return ''
}

/** The connection this machine should use, from the environment and the call. */
export function connectOptions(deps, overrides = {}) {
  const env = deps.env || {}
  return {
    host: firstNonEmpty(overrides.host, env.DSH_SQL_HOST, '127.0.0.1'),
    port: Number(firstNonEmpty(overrides.port, env.DSH_SQL_PORT, String(DEFAULT_PORT))),
    user: firstNonEmpty(overrides.user, env.DSH_SQL_USER, 'sa'),
    password: firstNonEmpty(overrides.password, env.DSH_SQL_SA_PASSWORD, env.DSH_SQL_PASSWORD, ''),
    database: firstNonEmpty(overrides.database, env.DSH_SQL_DATABASE, 'master'),
    container: firstNonEmpty(overrides.container, env.DSH_SQL_CONTAINER, ''),
  }
}

/**
 * Choose the transport: the container's own `sqlcmd` when there is a container,
 * else the host's.
 *
 * @returns `{ kind, container, cli, sqlcmd, argvPrefix, passwordViaEnv }`.
 * @throws SqlError NO_CLIENT when neither exists, naming what to install.
 */
export async function resolveClient(deps, options = {}) {
  const wanted = firstNonEmpty(options.container, deps.env.DSH_SQL_CONTAINER, '')
  const cli = await findContainerCli(deps)
  if (wanted !== '' && cli.found) {
    const state = await inspectContainer(deps, cli, wanted)
    if (state.found === true && state.state === 'running') {
      const found = await findContainerSqlcmd(deps, cli, wanted)
      if (found.found) {
        return { kind: 'container', container: wanted, cli: cli, sqlcmd: found, argvPrefix: ['exec', wanted], passwordViaEnv: false }
      }
      throw new SqlError(
        'NO_CLIENT',
        'The container ' + wanted + ' is running but its image has no `sqlcmd` at /opt/mssql-tools18/bin/sqlcmd or /opt/mssql-tools/bin/sqlcmd. Use an image that ships it (mcr.microsoft.com/mssql/server:2022-latest does).',
      )
    }
    if (state.found !== true) {
      throw new SqlError('NO_CONTAINER', 'There is no container named ' + wanted + ' on this engine. `sql_server` action=start creates it.')
    }
    throw new SqlError('CONTAINER_STOPPED', 'The container ' + wanted + ' exists but is ' + state.state + '. `sql_server` action=start brings it up.')
  }
  const host = await findHostSqlcmd(deps)
  if (host.found) {
    return { kind: 'host', container: '', cli: cli, sqlcmd: host, argvPrefix: [], passwordViaEnv: true }
  }
  throw new SqlError(
    'NO_CLIENT',
    'No `sqlcmd` on this machine\'s PATH and no running SQL Server container to borrow one from. Install the tools (`winget install Microsoft.Sqlcmd`, `brew install sqlcmd`, or the mssql-tools18 package), or let `sql_server` action=start run the server in Docker - the image ships its own client.',
  )
}

/**
 * The argv for one `sqlcmd` call.
 *
 * `-C` trusts the server's certificate (every container has a self-signed one),
 * `-W` trims trailing spaces, `-s "\t"` makes the answer parseable, and `-b` turns
 * a T-SQL error into an exit code - without `-b` sqlcmd prints the error and exits
 * 0, which is how a failed import looks successful.
 */
export function sqlcmdArgv(client, options = {}) {
  const argv = [...client.argvPrefix, client.sqlcmd.path]
  argv.push('-S', firstNonEmpty(options.server, 'localhost'))
  if (options.user) argv.push('-U', String(options.user))
  argv.push('-C', '-l', '30', '-b', '-I', '-f', String(options.codePage || '65001'))
  argv.push('-W', '-w', '65535', '-s', '\t')
  if (options.database) argv.push('-d', String(options.database))
  if (options.query) argv.push('-Q', String(options.query))
  if (options.input) argv.push('-i', String(options.input))
  return argv
}

/** The environment a `sqlcmd` call needs when the transport allows it. */
export function clientEnv(client, options = {}) {
  if (client.passwordViaEnv !== true) return {}
  return options.password ? { SQLCMDPASSWORD: String(options.password) } : {}
}

/** `docker exec -e SQLCMDPASSWORD=...`, inserted right after `exec`. */
export function withTransport(client, argv, options = {}) {
  if (client.kind !== 'container' || !options.password) return argv
  return [...argv.slice(0, 1), '-e', 'SQLCMDPASSWORD=' + options.password, ...argv.slice(1)]
}

/** The program the runner must spawn and the argv it gets, for either transport. */
export function callOf(client, argv) {
  if (client.kind === 'container') return { program: client.cli.path, args: argv }
  const copy = [...argv]
  const program = copy.length > 0 ? copy.shift() : 'sqlcmd'
  return { program: program, args: copy }
}

/**
 * Run one statement and parse the grid sqlcmd prints.
 *
 * @returns `{ columns, rows, rowCount, elapsedMs, truncated }`.
 * @throws SqlError QUERY_FAILED with the server's own message.
 */
export async function runQuery(deps, client, options = {}) {
  const connection = connectOptions(deps, options)
  const database = options.database ? String(options.database) : ''
  if (database !== '' && !isName(database)) throw new SqlError('BAD_DATABASE', 'Not a database name: ' + database)
  const sql = String(options.sql === undefined ? '' : options.sql)
  if (sql.trim() === '') throw new SqlError('BAD_SQL', 'The statement is empty.')
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CAPS.queryTimeoutMs
  const server = client.kind === 'container' ? 'localhost' : connection.host + ',' + connection.port
  const argv = withTransport(
    client,
    sqlcmdArgv(client, { server: server, user: connection.user, database: database, query: 'SET NOCOUNT ON;\n' + sql, codePage: options.codePage }),
    { password: connection.password },
  )
  const call = callOf(client, argv)
  const result = await deps.runner(call.program, call.args, {
    env: deps.env,
    timeoutMs: timeoutMs,
    extraEnv: clientEnv(client, { password: connection.password }),
  })
  if (result.timedOut) throw new SqlError('TIMEOUT', 'The statement did not finish within ' + Math.round(timeoutMs / 1000) + ' s.')
  if (result.error) throw new SqlError('NO_CLIENT', result.error)
  if (result.code !== 0) {
    throw new SqlError('QUERY_FAILED', firstSqlError(result.stderr || result.stdout) || firstLine(result.stderr || result.stdout || result.error, 400))
  }
  const table = parseTable(result.stdout)
  return { ...table, elapsedMs: result.elapsedMs, truncated: result.truncated }
}

/** The first `Msg <n>, Level <l>, State <s>` and the text after it, as one line. */
export function firstSqlError(text) {
  const value = String(text === undefined || text === null ? '' : text)
  const match = /Msg\s+(\d+),\s+Level\s+(\d+),\s+State\s+(\d+)([\s\S]{0,400})/.exec(value)
  if (match === null) return ''
  const body = match[4].replace(/\r?\n+/g, ' ').trim()
  return 'Msg ' + match[1] + ' (level ' + match[2] + '): ' + body
}

/**
 * Parse the tab-separated grid `sqlcmd -W -s "\t"` prints.
 *
 * The header is the first line; sqlcmd may follow it with a dashes rule, which is
 * dropped. `NULL` is the one value sqlcmd prints that cannot be told apart from the
 * four-letter string, so it is reported as null and the tools say so.
 */
export function parseTable(text) {
  const lines = String(text === undefined || text === null ? '' : text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  if (lines.length === 0) return { columns: [], rows: [], rowCount: 0 }
  const columns = lines[0].split('\t').map((name) => name.trim())
  let start = 1
  if (lines.length > 1 && lines[1].includes('-') && /^[-\s\t]+$/.test(lines[1])) start = 2
  const rows = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\(\d+ rows? affected\)$/i.test(line.trim())) continue
    const cells = line.split('\t')
    const row = {}
    for (let column = 0; column < columns.length; column += 1) {
      const raw = cells[column] === undefined ? '' : cells[column]
      row[columns[column]] = raw === 'NULL' ? null : raw
    }
    rows.push(row)
  }
  return { columns: columns, rows: rows, rowCount: rows.length }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------
/** The encoding of a file, from its BOM (a 4-byte read, not a load). */
export function detectEncoding(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    const read = readSync(fd, head, 0, 4, 0)
    if (read >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
    if (read >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
    return 'utf-8'
  } finally {
    closeSync(fd)
  }
}

/** The `sqlcmd -f` code page that reads an encoding. */
export function scriptCodePage(encoding) {
  if (encoding === 'utf-16le') return '1200'
  if (encoding === 'utf-16be') return '1201'
  return '65001'
}

/**
 * Read a `.sql` file as UTF-8 chunks, optionally dropping the database-DDL header.
 *
 * @param file - an absolute path to the `.sql` file.
 * @param options - `{ sanitise, chunkBytes }`.
 * @returns `{ chunks, stats }` - `chunks` is an async iterable and `stats` fills in
 *   as it is consumed, so the answer can report what the filter did.
 */
export function readScript(file, options = {}) {
  const stats = { bytes: 0, encoding: 'utf-8', droppedCreateDatabase: 0, droppedAlterDatabase: 0, droppedUseMaster: 0, sanitised: false }
  const sanitise = options.sanitise === true || options.sanitise === 'strip-database-ddl'
  stats.sanitised = sanitise
  const chunkBytes = Number.isFinite(options.chunkBytes) && options.chunkBytes > 0 ? options.chunkBytes : 256 * 1024

  async function* iterate() {
    const stream = createReadStream(file, { highWaterMark: chunkBytes })
    let decoder = null
    let pending = ''
    let skipping = false
    for await (const raw of stream) {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      if (decoder === null) decoder = pickDecoder(buffer)
      stats.encoding = decoder.encoding
      stats.bytes += buffer.length
      const text = decoder.decode(buffer, { stream: true })
      if (text === '') continue
      if (!sanitise) {
        yield Buffer.from(text, 'utf8')
        continue
      }
      pending += text
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const state = sanitiseLine(line, stats, skipping)
        skipping = state.skipping
        if (state.keep) yield Buffer.from(line + '\n', 'utf8')
        newline = pending.indexOf('\n')
      }
    }
    const tail = decoder === null ? '' : decoder.decode()
    if (tail !== '') {
      if (sanitise) {
        pending += tail
        if (pending !== '') {
          const state = sanitiseLine(pending, stats, skipping)
          skipping = state.skipping
          if (state.keep) yield Buffer.from(pending + '\n', 'utf8')
        }
      } else {
        yield Buffer.from(tail, 'utf8')
      }
    }
  }

  return { chunks: iterate(), stats: stats }
}

/** The decoder for a stream, from its BOM (UTF-8 when there is none). */
function pickDecoder(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf-16le', decode: utf16For('utf-16le') }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf-16be', decode: utf16For('utf-16be') }
  const textDecoder = new TextDecoder('utf-8')
  return { encoding: 'utf-8', decode: (chunk, opts) => textDecoder.decode(chunk, opts) }
}

/** One TextDecoder per encoding, so a chunk boundary cannot split a character. */
const utf16Decoders = new Map()
function utf16For(encoding) {
  let decoder = utf16Decoders.get(encoding)
  if (decoder === undefined) {
    decoder = new TextDecoder(encoding)
    utf16Decoders.set(encoding, decoder)
  }
  return (chunk, opts) => decoder.decode(chunk, opts)
}

/**
 * One line through the sanitiser.
 *
 * It drops, as a stream, exactly what a dump carries that belongs to the machine
 * that wrote it: `USE [master]`, the `CREATE DATABASE ... ON ( ... FILENAME =
 * N'C:\...' )` block (which runs until its `GO`), and the `ALTER DATABASE ... SET`
 * lines after it. A dropped `ALTER DATABASE` leaves its `GO` behind, which sqlcmd
 * treats as an empty batch: no harm, and no second state machine to get wrong.
 *
 * @returns `{ keep, skipping }`.
 */
export function sanitiseLine(line, stats, skipping) {
  const trimmed = line.trim()
  if (skipping === true) {
    if (/^GO\s*(?:--.*)?$/i.test(trimmed)) return { keep: false, skipping: false }
    return { keep: false, skipping: true }
  }
  if (/^USE\s+\[?master\]?\s*;?\s*$/i.test(trimmed)) {
    stats.droppedUseMaster += 1
    return { keep: false, skipping: false }
  }
  if (/^CREATE\s+DATABASE\b/i.test(trimmed)) {
    stats.droppedCreateDatabase += 1
    return { keep: false, skipping: true }
  }
  if (/^ALTER\s+DATABASE\b/i.test(trimmed)) {
    stats.droppedAlterDatabase += 1
    return { keep: false, skipping: false }
  }
  return { keep: true, skipping: false }
}

/**
 * Write the filtered copy of a script: UTF-8, no BOM, no database-DDL header.
 *
 * @returns `{ path, stats }` - the caller owns the file and must remove it.
 */
export async function sanitiseToTempFile(file, stats) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sql-'))
  const target = path.join(dir, 'sanitised.sql')
  const out = createWriteStream(target)
  const script = readScript(file, { sanitise: true })
  for await (const chunk of script.chunks) {
    if (out.write(chunk) === false) await once(out, 'drain')
  }
  await new Promise((resolve, reject) => {
    out.once('error', reject)
    out.end(() => resolve())
  })
  Object.assign(stats, script.stats)
  return { path: target, dir: dir, stats: stats }
}

/**
 * Run a `.sql` file with `sqlcmd -i`, streaming any filtering into a temp file.
 *
 * @param options - `{ file, database, sanitise, timeoutMs, abortOnError, host, port, user, password }`.
 * @returns the exit code, elapsed time, what the filter dropped, and the first
 *   server error in one line.
 */
export async function runScript(deps, client, options = {}) {
  const file = String(options.file === undefined ? '' : options.file)
  if (!isAbsolutePath(file)) throw new SqlError('BAD_PATH', 'The script path must be absolute (got "' + file + '").')
  if (!existsSync(file)) throw new SqlError('NO_FILE', 'No such file: ' + file)
  const size = statSync(file).size
  const timeoutMs = Math.min(
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CAPS.scriptTimeoutMs,
    CAPS.maxScriptTimeoutMs,
  )
  const connection = connectOptions(deps, options)
  const database = options.database ? String(options.database) : ''
  if (database !== '' && !isName(database)) throw new SqlError('BAD_DATABASE', 'Not a database name: ' + database)

  const stats = { bytes: 0, encoding: 'utf-8', droppedCreateDatabase: 0, droppedAlterDatabase: 0, droppedUseMaster: 0, sanitised: false }
  let inputPath = file
  let tempDir = ''
  let codePage = scriptCodePage(detectEncoding(file))
  let bytes = 0
  const startedAt = Date.now()
  let containerPath = ''

  try {
    if (options.sanitise === true) {
      const filtered = await sanitiseToTempFile(file, stats)
      inputPath = filtered.path
      tempDir = filtered.dir
      codePage = '65001'
      bytes = stats.bytes
    } else {
      bytes = size
      stats.encoding = detectEncoding(file)
    }
    stats.sanitised = options.sanitise === true

    if (client.kind === 'container') {
      // The container's sqlcmd can only open a file INSIDE the container, and the
      // stdin path is not an option (see the header). So the file is copied in.
      containerPath = '/tmp/dsh-sql-' + randomBytes(6).toString('hex') + '.sql'
      const copied = await deps.runner(client.cli.path, ['cp', inputPath, client.container + ':' + containerPath], {
        env: deps.env,
        timeoutMs: CAPS.actionTimeoutMs,
      })
      if (copied.code !== 0) {
        throw new SqlError('COPY_FAILED', 'Could not copy the script into the container: ' + firstLine(copied.stderr || copied.error, 300))
      }
      inputPath = containerPath
    }

    const server = client.kind === 'container' ? 'localhost' : connection.host + ',' + connection.port
    const argv = sqlcmdArgv(client, { server: server, user: connection.user, database: database, codePage: codePage, input: inputPath })
    const aborts = options.abortOnError !== false
    if (!aborts) {
      const at = argv.indexOf('-b')
      if (at >= 0) argv.splice(at, 1)
    }
    const full = withTransport(client, argv, { password: connection.password })
    const call = callOf(client, full)
    const result = await deps.runner(call.program, call.args, {
      env: deps.env,
      timeoutMs: timeoutMs,
      extraEnv: clientEnv(client, { password: connection.password }),
      maxBytes: CAPS.maxStreamBytes,
    })
    return {
      code: result.code,
      elapsedMs: Date.now() - startedAt,
      bytes: bytes,
      encoding: stats.encoding,
      sanitised: stats.sanitised,
      dropped: {
        createDatabase: stats.droppedCreateDatabase,
        alterDatabase: stats.droppedAlterDatabase,
        useMaster: stats.droppedUseMaster,
      },
      abortOnError: aborts,
      timedOut: result.timedOut,
      truncated: result.truncated,
      fileSize: size,
      transport: client.kind === 'container' ? 'container ' + client.container : 'host ' + client.sqlcmd.path,
      stderr: result.stderr || '',
      stdout: result.stdout || '',
      error: firstSqlError(result.stderr || result.stdout) || firstLine(result.stderr || result.stdout || result.error, 400),
    }
  } finally {
    if (containerPath !== '' && client.kind === 'container') {
      await deps.runner(client.cli.path, ['exec', client.container, 'rm', '-f', containerPath], { env: deps.env, timeoutMs: 30_000 })
    }
    if (tempDir !== '') {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (err) {
        /* a leftover temp file is not worth failing a successful load for */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Statements this row builds
// ---------------------------------------------------------------------------
/** The databases on the instance, with their size and state. */
export function listDatabasesSql() {
  return [
    'SELECT d.name AS [database],',
    '       CAST(SUM(CASE WHEN mf.type = 0 THEN mf.size END) * 8.0 / 1024 AS DECIMAL(18,1)) AS data_mb,',
    '       CAST(SUM(CASE WHEN mf.type = 1 THEN mf.size END) * 8.0 / 1024 AS DECIMAL(18,1)) AS log_mb,',
    '       d.state_desc AS state',
    'FROM sys.databases d',
    'LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id',
    'GROUP BY d.name, d.state_desc',
    'ORDER BY d.name',
  ].join('\n')
}

/** `CREATE DATABASE [name]` — the one DDL this row runs on purpose. */
export function createDatabaseSql(name) {
  if (!isName(name)) throw new SqlError('BAD_DATABASE', 'Not a database name: ' + String(name))
  return 'CREATE DATABASE [' + name + ']'
}

/**
 * The user tables of one database, with rows and size.
 *
 * The two aggregates are SUBQUERIES on purpose: joining `sys.partitions` to
 * `sys.allocation_units` multiplies a partition by its allocation units (one for
 * in-row data, one for LOB), which made a 4-row table report 12.
 */
export function listTablesSql() {
  return [
    'SELECT s.name AS [schema], t.name AS [table],',
    '       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS [rows],',
    '       CAST((SELECT SUM(a.total_pages) * 8.0 / 1024 FROM sys.partitions p',
    '             JOIN sys.allocation_units a ON a.container_id = p.partition_id',
    '             WHERE p.object_id = t.object_id) AS DECIMAL(18,1)) AS total_mb',
    'FROM sys.tables t',
    'JOIN sys.schemas s ON s.schema_id = t.schema_id',
    'WHERE t.is_ms_shipped = 0',
    'ORDER BY total_mb DESC, t.name',
  ].join('\n')
}

/** The columns of one table. */
export function columnsSql(schema, table) {
  const safeSchema = isName(schema) ? String(schema) : 'dbo'
  if (!isName(table)) throw new SqlError('BAD_TABLE', 'Not a table name: ' + String(table))
  return [
    'SELECT c.ordinal_position AS pos, c.column_name AS [column], c.data_type AS type,',
    '       c.character_maximum_length AS len, c.is_nullable AS nullable',
    'FROM information_schema.columns c',
    "WHERE c.table_schema = '" + safeSchema + "' AND c.table_name = '" + String(table) + "'",
    'ORDER BY c.ordinal_position',
  ].join('\n')
}

/**
 * The row count of several tables in one result set.
 *
 * A name is `table`, `schema.table` or `database.schema.table` - the three-part
 * form is what a dump's own verify list uses, and reading it as two parts produces
 * `[db].[schema]`, which SQL Server reports as "Invalid object name".
 */
export function countRowsSql(names) {
  const parts = names.map((entry) => {
    const pieces = String(entry).split('.').map((piece) => piece.trim()).filter((piece) => piece !== '')
    const table = pieces.length > 0 ? pieces[pieces.length - 1] : ''
    const schema = pieces.length > 1 ? pieces[pieces.length - 2] : 'dbo'
    const database = pieces.length > 2 ? pieces[pieces.length - 3] : ''
    if (!isName(table) || !isName(schema) || (database !== '' && !isName(database))) {
      throw new SqlError('BAD_TABLE', 'Not a table name: ' + String(entry))
    }
    const target = (database === '' ? '' : '[' + database + '].') + '[' + schema + '].[' + table + ']'
    return "SELECT '" + String(entry) + "' AS [table], COUNT_BIG(*) AS [rows] FROM " + target
  })
  return parts.join('\nUNION ALL\n')
}

/** `RESTORE FILELISTONLY` — the logical file names a restore must move. */
export function fileListSql(backupPath) {
  if (!isAbsolutePath(backupPath)) throw new SqlError('BAD_PATH', 'The backup path must be absolute (got "' + String(backupPath) + '").')
  return "RESTORE FILELISTONLY FROM DISK = N'" + String(backupPath).replace(/'/g, "''") + "'"
}

/**
 * The `RESTORE` statement, with every file moved into this instance.
 *
 * A backup carries the physical paths of the machine that took it, so a restore
 * without `MOVE` fails or - worse - succeeds onto a path that does not exist here.
 * The caller passes the `FILELISTONLY` rows, which is the only way to know the
 * logical names.
 *
 * @returns the statement.
 */
export function restoreSql(options) {
  const database = String(options.database === undefined ? '' : options.database)
  if (!isName(database)) throw new SqlError('BAD_DATABASE', 'Not a database name: ' + database)
  const backupPath = String(options.backupPath === undefined ? '' : options.backupPath)
  if (!isAbsolutePath(backupPath)) throw new SqlError('BAD_PATH', 'The backup path must be absolute.')
  const dataDir = firstNonEmpty(options.dataDir).replace(/[\\/]+$/, '')
  if (dataDir === '') {
    throw new SqlError('BAD_DATA_DIR', 'A restore needs `dataDir`: the folder INSIDE the server where its data files live (in this row\'s container, /var/opt/mssql/data).')
  }
  const files = Array.isArray(options.files) ? options.files : []
  if (files.length === 0) {
    throw new SqlError('NO_FILELIST', 'A restore needs the FILELISTONLY rows (logical name and type) to build its MOVE clauses; call with `listFiles: true` first and copy them in.')
  }
  const rows = files.map((entry) => ({
    logical: String(entry.logical === undefined ? entry.LogicalName : entry.logical),
    type: String(entry.type === undefined ? entry.Type : entry.type).toUpperCase(),
  }))
  const dataFiles = rows.filter((row) => !row.type.startsWith('L'))
  const moves = rows.map((row) => {
    const isLog = row.type.startsWith('L')
    const extension = isLog ? '_log.ldf' : dataFiles.length > 1 ? '_' + row.logical.replace(/\W+/g, '_') + '.mdf' : '.mdf'
    const target = dataDir + '/' + database + extension
    return "MOVE N'" + row.logical.replace(/'/g, "''") + "' TO N'" + target.replace(/'/g, "''") + "'"
  })
  return "RESTORE DATABASE [" + database + "] FROM DISK = N'" + backupPath.replace(/'/g, "''") + "' WITH REPLACE, " + moves.join(', ') + ', RECOVERY, STATS = 10'
}
