/**
 * dsh-sql-server — what this machine already has.
 *
 * "Is there a SQL Server here" is four separate questions with four different
 * answers, and a plugin that collapses them into one is the reason people give up
 * on ODBC:
 *
 *   1. **a server** — a Docker container this row owns, a native Windows service
 *      (`MSSQLSERVER`, `MSSQL$SQLEXPRESS`), or nothing;
 *   2. **a client** — `sqlcmd` on the PATH, or the one INSIDE the container
 *      image. Without either, no statement can be sent at all, so this is not an
 *      optional nicety: it is the difference between "load your dump" and "here
 *      is the command to install a client";
 *   3. **an ODBC driver** — the only thing an application (pyodbc, SSMS, Excel)
 *      uses to connect, and the one piece a container CANNOT provide. A machine
 *      with the server running and no driver is a machine where the plugin works
 *      and the app cannot connect;
 *   4. **a listening port** — the fact that the server really is reachable on
 *      127.0.0.1, not merely started.
 *
 * All four are read-only probes. Nothing here installs, starts or stops anything.
 */

import net from 'node:net'

import { firstLine, isMissingProgram, parseJsonLines, runProcess } from './cli.js'
import { DRIVERS } from './validate.js'

/** The image this row starts when nobody says otherwise. */
export const DEFAULT_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest'
/** The container name this row owns and manages. */
export const DEFAULT_CONTAINER = 'dsh-sql-server'
/** The default instance port. */
export const DEFAULT_PORT = 1433
/** The named volume, so a container removal does not take the databases with it. */
export const DEFAULT_VOLUME = 'dsh-sql-data'
/** Where SQL Server's tools live inside the 2022 image, newest first. */
export const CONTAINER_SQLCMD_CANDIDATES = ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd']
/** The native service names worth asking about. */
export const NATIVE_SERVICES = ['MSSQLSERVER', 'MSSQL$SQLEXPRESS', 'MSSQL$SQL2019', 'MSSQL$SQL2022']

/**
 * Run one probe and report whether the program exists at all.
 *
 * @returns `{ found, result }` - `found` is false ONLY when the program is not
 *   on this machine (ENOENT / "not recognized"); a program that runs and exits
 *   non-zero is found, because `sqlcmd -?` does exactly that.
 */
export async function probe(deps, file, argv, timeoutMs = 10_000) {
  const result = await deps.runner(file, argv, { env: deps.env, timeoutMs: timeoutMs })
  if (result.error && isMissingProgram(result)) return { found: false, result: result }
  // Windows hands back 9009 from cmd, POSIX 127 - both mean "no such program".
  if (result.code === 127 || result.code === 9009) return { found: false, result: result }
  return { found: true, result: result }
}

/**
 * The `sqlcmd` on this machine's PATH.
 *
 * @returns `{ found, path, version, line }` - `line` is the client's own banner,
 *   which names the version and is what a reader compares against the server's.
 */
export async function findHostSqlcmd(deps) {
  const name = deps.env.DSH_SQLCMD || 'sqlcmd'
  const probed = await probe(deps, name, ['-?'], 12_000)
  if (!probed.found) return { found: false, path: name, version: '', line: '' }
  const text = (probed.result.stdout || '') + '\n' + (probed.result.stderr || '')
  const version = /\bVersion\s+([0-9][0-9.]*)/i.exec(text)
  const line = firstLine(text.replace(/\s*-\?\s*/g, ' '), 200)
  return { found: true, path: name, version: version === null ? '' : version[1], line: line }
}

/**
 * The container CLI (docker, else podman - Podman speaks the same dialect for
 * every verb this row uses).
 *
 * @returns `{ found, path, version, line }`.
 */
export async function findContainerCli(deps) {
  const candidates = [deps.env.DSH_SQL_CONTAINER_CLI, 'docker', 'podman'].filter((value) => typeof value === 'string' && value !== '')
  for (const name of candidates) {
    const probed = await probe(deps, name, ['--version'], 15_000)
    if (!probed.found) continue
    const text = firstLine((probed.result.stdout || '') + ' ' + (probed.result.stderr || ''), 120)
    const version = /([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/.exec(text)
    return { found: true, path: name, version: version === null ? '' : version[1], line: text }
  }
  return { found: false, path: '', version: '', line: '' }
}

/** Whether the container engine's daemon answers (a CLI on PATH is not enough). */
export async function containerDaemonUp(deps, cli) {
  if (cli === null || cli === undefined || cli.found !== true) return { up: false, reason: 'no container CLI' }
  const result = await deps.runner(cli.path, ['info', '--format', '{{.ServerVersion}}'], { env: deps.env, timeoutMs: 20_000 })
  if (result.code !== 0) {
    return { up: false, reason: firstLine(result.stderr || result.error || 'the engine did not answer', 200) }
  }
  return { up: true, serverVersion: firstLine(result.stdout, 80) }
}

/**
 * One container by name, whatever state it is in.
 *
 * @returns `{ found, id, name, state, status, image, ports }`; `found` is false
 *   when the engine answers and simply has no container of that name.
 */
export async function inspectContainer(deps, cli, name) {
  const listed = await deps.runner(cli.path, ['ps', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{json .}}'], {
    env: deps.env,
    timeoutMs: 20_000,
  })
  if (listed.code !== 0) return { found: false, error: firstLine(listed.stderr || listed.error, 200) }
  const rows = parseJsonLines(listed.stdout).filter((row) => String(row.Names || '').trim().replace(/^\//, '') === name)
  if (rows.length === 0) return { found: false }
  const row = rows[0]
  return {
    found: true,
    id: String(row.ID || ''),
    name: name,
    state: String(row.State || '').toLowerCase(),
    status: String(row.Status || ''),
    image: String(row.Image || ''),
    ports: String(row.Ports || ''),
  }
}

/**
 * The `sqlcmd` INSIDE a container.
 *
 * The image ships its own client, so a machine with no `mssql-tools` on the PATH
 * can still load a dump: this is the path that makes the plugin useful on a
 * clean Windows box.
 *
 * @returns `{ found, path, version }`.
 */
export async function findContainerSqlcmd(deps, cli, container) {
  for (const candidate of CONTAINER_SQLCMD_CANDIDATES) {
    const result = await deps.runner(cli.path, ['exec', container, candidate, '-?'], { env: deps.env, timeoutMs: 25_000 })
    const text = (result.stdout || '') + (result.stderr || '') + (result.error || '')
    if (/executable file not found|no such file|not found|OCI runtime/i.test(text) && result.code !== 0) continue
    if (result.code === null) continue
    const version = /\bVersion\s+([0-9][0-9.]*)/i.exec(text)
    return { found: true, path: candidate, version: version === null ? '' : version[1] }
  }
  return { found: false, path: '', version: '' }
}

/**
 * The ODBC drivers this machine has installed.
 *
 * ODBC is the APPLICATION's door and it is machine-wide, not container-wide: an
 * `mssql` image tells you nothing about whether `pyodbc` can connect. Windows
 * keeps the list in the registry (machine and per-user), unixODBC in
 * `odbcinst.ini`.
 *
 * @returns `{ found, names, source, detail }`.
 */
export async function odbcDrivers(deps) {
  if (deps.platform === 'win32') {
    const names = []
    const detail = []
    for (const hive of ['HKLM', 'HKCU']) {
      const key = hive + '\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers'
      const result = await deps.runner('reg.exe', ['query', key], { env: deps.env, timeoutMs: 12_000 })
      if (result.code !== 0) continue
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const entry = /^\s{2,}(\S.*?)\s{2,}REG_SZ\s{2,}(\S.*)$/.exec(line)
        if (entry === null) continue
        if (/^Installed$/i.test(entry[2]) === false) continue
        if (!names.includes(entry[1])) names.push(entry[1])
      }
      detail.push(hive)
    }
    return { found: names.length > 0, names: names, source: 'registry (' + detail.join(', ') + ')', detail: detail.join(', ') }
  }
  const result = await deps.runner('odbcinst', ['-q', '-d'], { env: deps.env, timeoutMs: 12_000 })
  if (result.code !== 0) return { found: false, names: [], source: 'odbcinst', detail: firstLine(result.stderr || result.error, 160) }
  const names = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => /^\[(.+)\]$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1])
  return { found: names.length > 0, names: names, source: 'odbcinst.ini', detail: '' }
}

/**
 * The driver an application should use, by preference.
 *
 * ODBC Driver 18 is the one that speaks TLS 1.2 the way SQL Server 2022 requires;
 * the legacy `SQL Server` entry (the one Windows ships) is last for that reason.
 *
 * @returns `{ name, index, modern }` - `name` is '' when none of the known ones
 *   is installed, and `modern` says whether it is 17/18.
 */
export function pickDriver(names) {
  const list = Array.isArray(names) ? names : []
  for (let index = 0; index < DRIVERS.length; index += 1) {
    const wanted = DRIVERS[index]
    const found = list.find((name) => name.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) return { name: found, index: index, modern: index <= 1 }
  }
  return { name: '', index: -1, modern: false }
}

/**
 * Native SQL Server services (Windows only).
 *
 * @returns `{ found, services }` with `{ name, state }` each; on macOS/Linux this
 *   is always `{ found: false, services: [] }` because a native instance there is
 *   a container or a systemd unit this row does not claim to manage.
 */
export async function nativeServices(deps) {
  if (deps.platform !== 'win32') return { found: false, services: [] }
  const services = []
  for (const name of NATIVE_SERVICES) {
    const result = await deps.runner('sc.exe', ['query', name], { env: deps.env, timeoutMs: 10_000 })
    if (result.code !== 0) continue
    const text = String(result.stdout || '')
    const state = /STATE\s*:\s*\d+\s+(\w+)/i.exec(text)
    services.push({ name: name, state: state === null ? 'UNKNOWN' : state[1].toUpperCase() })
  }
  return { found: services.length > 0, services: services }
}

/**
 * Whether something is listening on host:port, right now.
 *
 * A started container is not a reachable server (the image takes tens of seconds
 * to open 1433), so this is the honest readiness question and the one the state
 * tool asks before it claims a database is available.
 */
export function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (open) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch (err) {
        /* already gone */
      }
      resolve(open)
    }
    const socket = net.connect({ host: host, port: port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * The image's own readiness line, read from the container's log.
 *
 * SQL Server prints "SQL Server is now ready for client connections" - polling
 * that is faster than waiting for the full poll interval, and it is the only
 * signal available before the port opens.
 */
export async function readyLineSeen(deps, cli, container) {
  const logs = await deps.runner(cli.path, ['logs', '--tail', '400', container], { env: deps.env, timeoutMs: 20_000 })
  const text = (logs.stdout || '') + '\n' + (logs.stderr || '')
  return /SQL Server is now ready for client connections/i.test(text)
}
