/**
 * dsh-sql-server — the server this row owns, and the state of the whole surface.
 *
 * THE DECISION THIS FILE MAKES: a development SQL Server is a CONTAINER, not an
 * install. `mcr.microsoft.com/mssql/server:2022-latest` is 1.7 GB, starts in about
 * forty seconds, keeps its databases in a named volume so a removal is not data
 * loss, and is removed with one call - which is what "reproduce this on a clean
 * machine" needs and what an MSI install is not. A native instance is DETECTED and
 * reported (`MSSQLSERVER`, `MSSQL$SQLEXPRESS`) and deliberately not managed: this
 * row will not stop a service somebody's other work depends on.
 *
 * The container is created with `MSSQL_SA_PASSWORD` in argv - there is no other
 * way to seed a container's password - so the password is validated before
 * anything is created, and the answer never repeats it back.
 *
 * Readiness is three separate facts and the state reports all three: the container
 * is `running`, the image has printed its ready line, and something is LISTENING
 * on 127.0.0.1:port. A container that is running but not yet listening is the state
 * every caller misreads as "the database is up", so `ready` is a field, not a guess.
 */

import { firstLine } from './cli.js'
import { SqlError, callOf, clientEnv, connectOptions, sqlcmdArgv, withTransport } from './sql.js'
import {
  DEFAULT_CONTAINER,
  DEFAULT_IMAGE,
  DEFAULT_PORT,
  DEFAULT_VOLUME,
  containerDaemonUp,
  findContainerCli,
  findContainerSqlcmd,
  inspectContainer,
  nativeServices,
  odbcDrivers,
  portOpen,
  readyLineSeen,
} from './discover.js'
import { CAPS, checkPassword } from './validate.js'

/** The state this row reports, which is also what `sql_status` prints. */
export async function serverState(deps, options = {}) {
  const name = String(options.container || deps.env.DSH_SQL_CONTAINER || DEFAULT_CONTAINER)
  const port = Number(options.port || deps.env.DSH_SQL_PORT || DEFAULT_PORT)
  const view = {
    ok: false,
    server: 'none',
    container: null,
    daemon: null,
    cli: null,
    listening: false,
    ready: false,
    native: { found: false, services: [] },
    drivers: { ok: false, drivers: [], picked: '', source: '', next: '' },
    next: '',
  }

  const cli = await findContainerCli(deps)
  view.cli = cli.found ? { path: cli.path, version: cli.version } : null
  if (cli.found) {
    const daemon = await containerDaemonUp(deps, cli)
    view.daemon = daemon
    if (daemon.up) {
      const state = await inspectContainer(deps, cli, name)
      if (state.found === true) {
        const running = state.state === 'running'
        const listening = running ? await portOpen('127.0.0.1', port) : false
        const seen = running ? await readyLineSeen(deps, cli, name) : false
        view.container = { name: state.name, id: state.id.slice(0, 12), state: state.state, status: state.status, image: state.image, ports: state.ports }
        view.server = running ? 'container' : 'container-stopped'
        view.listening = listening
        view.ready = running && listening
        view.readyLine = seen
        view.ok = view.ready
      }
    }
  }

  if (view.container === null) {
    const native = await nativeServices(deps)
    view.native = native
    if (native.found) {
      const running = native.services.filter((service) => service.state === 'RUNNING')
      if (running.length > 0) {
        view.server = 'native'
        view.ok = true
        view.listening = await portOpen('127.0.0.1', port)
      }
    }
  }

  const drivers = await deps.driverState()
  view.drivers = drivers
  view.next = nextStep(view, name, port)
  return view
}

/** The one sentence a caller reads next, whatever combination it found. */
export function nextStep(view, name, port) {
  const drivers = view.drivers || { ok: false, picked: '', next: '' }
  const driverLine = drivers.ok ? '' : ' The application driver is the other half: ' + drivers.next
  if (view.server === 'container' && view.ready) {
    return 'SQL Server answers in container ' + name + ' on 127.0.0.1:' + port + '.' + driverLine
  }
  if (view.server === 'container' && view.ready !== true) {
    return 'Container ' + name + ' is running but nothing is listening on ' + port + ' yet. The image takes up to a minute; `sql_server` action=status again, or read `sql_server` action=logs.' + driverLine
  }
  if (view.server === 'container-stopped') {
    return 'Container ' + name + ' exists and is stopped. `sql_server` action=start brings it up in place (the databases are in the volume, so they come back).' + driverLine
  }
  if (view.server === 'native') {
    return 'A native SQL Server is running on this machine. This row does not manage a native instance; it can still query it once `sqlcmd` and a driver are present.' + driverLine
  }
  if (view.cli === null) {
    return 'No container CLI on this PATH, so this row cannot start a server here. Install Docker Desktop (or Podman), or install SQL Server Express by hand and put `sqlcmd` on the PATH.' + driverLine
  }
  if (view.daemon !== null && view.daemon.up !== true) {
    return 'The container CLI is here but its engine is not answering (' + (view.daemon.reason || 'no server') + '). Start Docker Desktop, then `sql_server` action=start.'
  }
  return 'No SQL Server on this machine. `sql_server` action=start creates container ' + name + ' from ' + DEFAULT_IMAGE + ' on port ' + port + ' with a named volume, and waits until it answers.' + driverLine
}

/** Make sure the image is local, pulling it when it is not. */
export async function ensureImage(deps, cli, image) {
  const present = await deps.runner(cli.path, ['image', 'inspect', image, '--format', '{{.Id}}'], { env: deps.env, timeoutMs: 30_000 })
  if (present.code === 0) return { pulled: false, elapsedMs: 0 }
  const startedAt = Date.now()
  const pulled = await deps.runner(cli.path, ['pull', image], { env: deps.env, timeoutMs: 20 * 60_000 })
  if (pulled.code !== 0) {
    throw new SqlError('PULL_FAILED', 'Could not pull ' + image + ': ' + firstLine(pulled.stderr || pulled.error, 300))
  }
  return { pulled: true, elapsedMs: Date.now() - startedAt }
}

/**
 * Start (or create) the container, then wait until it answers.
 *
 * @param options - `{ image, container, port, volume, password, memoryMb, waitMs }`.
 * @returns `{ started, created, pulled, elapsedMs, ready, state }`.
 * @throws SqlError NO_CLI / ENGINE_DOWN / BAD_PASSWORD / RUN_FAILED.
 */
export async function startServer(deps, options = {}) {
  const cli = await findContainerCli(deps)
  if (!cli.found) {
    throw new SqlError('NO_CLI', 'No `docker` or `podman` on this PATH. Install Docker Desktop, or point DSH_SQL_CONTAINER_CLI at the binary.')
  }
  const daemon = await containerDaemonUp(deps, cli)
  if (daemon.up !== true) {
    throw new SqlError('ENGINE_DOWN', 'The container engine is not answering: ' + (daemon.reason || 'no server') + '. Start Docker Desktop, then call again.')
  }
  const name = String(options.container || deps.env.DSH_SQL_CONTAINER || DEFAULT_CONTAINER)
  const image = String(options.image || deps.env.DSH_SQL_IMAGE || DEFAULT_IMAGE)
  const port = Number(options.port || deps.env.DSH_SQL_PORT || DEFAULT_PORT)
  const volume = String(options.volume || deps.env.DSH_SQL_VOLUME || DEFAULT_VOLUME)
  const password = String(options.password || deps.env.DSH_SQL_SA_PASSWORD || deps.env.DSH_SQL_PASSWORD || '')
  const startedAt = Date.now()

  const existing = await inspectContainer(deps, cli, name)
  if (existing.found === true && existing.state === 'running') {
    const ready = await waitReady(deps, cli, name, options)
    return { started: false, created: false, pulled: false, already: true, elapsedMs: Date.now() - startedAt, ready: ready, state: await serverState(deps, { container: name, port }) }
  }

  if (existing.found === true) {
    const started = await deps.runner(cli.path, ['start', name], { env: deps.env, timeoutMs: CAPS.actionTimeoutMs })
    if (started.code !== 0) throw new SqlError('START_FAILED', 'Could not start container ' + name + ': ' + firstLine(started.stderr || started.error, 300))
    const ready = await waitReady(deps, cli, name, options)
    return { started: true, created: false, pulled: false, elapsedMs: Date.now() - startedAt, ready: ready, state: await serverState(deps, { container: name, port }) }
  }

  // A new container is about to take a password; refuse a weak one BEFORE the
  // image refuses it in its own log, which is a slow and confusing way to learn
  // the policy.
  if (password === '') {
    throw new SqlError(
      'NO_PASSWORD',
      'Starting a new SQL Server needs a password for the `sa` login. Set DSH_SQL_SA_PASSWORD (or pass `password`), at least 8 characters from three of: upper, lower, digit, symbol. The value is used once, to seed the container, and is never echoed back.',
    )
  }
  const policy = checkPassword(password)
  if (!policy.ok) throw new SqlError('BAD_PASSWORD', 'That password would be refused: ' + policy.reason + '.')

  const pulled = await ensureImage(deps, cli, image)
  const argv = [
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'ACCEPT_EULA=Y',
    '-e',
    'MSSQL_SA_PASSWORD=' + password,
    '-e',
    'MSSQL_PID=Developer',
    '-p',
    port + ':1433',
    '-v',
    volume + ':/var/opt/mssql',
  ]
  if (Number.isFinite(options.memoryMb) && options.memoryMb > 0) argv.push('--memory', Math.round(options.memoryMb) + 'm')
  argv.push(image)
  const created = await deps.runner(cli.path, argv, { env: deps.env, timeoutMs: CAPS.actionTimeoutMs })
  if (created.code !== 0) {
    throw new SqlError('RUN_FAILED', 'Could not create the container: ' + firstLine(created.stderr || created.error, 400))
  }
  const ready = await waitReady(deps, cli, name, options)
  return {
    started: true,
    created: true,
    pulled: pulled.pulled,
    pullMs: pulled.elapsedMs,
    elapsedMs: Date.now() - startedAt,
    ready: ready,
    state: await serverState(deps, { container: name, port }),
  }
}

/**
 * Poll until the server answers a trivial statement, not merely until the
 * container says `running`.
 *
 * Two signals, cheapest first: the image's own ready line in the log, then a real
 * `SELECT 1` through the image's `sqlcmd`. The port check is deliberately not the
 * signal - SQL Server opens 1433 before it accepts a login, which is exactly the
 * window in which a load fails with "Login failed".
 */
export async function waitReady(deps, cli, name, options = {}) {
  const deadline = Date.now() + Math.min(Number(options.waitMs) > 0 ? Number(options.waitMs) : CAPS.readyTimeoutMs, CAPS.readyTimeoutMs)
  const found = await findContainerSqlcmd(deps, cli, name)
  const client = { kind: 'container', container: name, cli: cli, sqlcmd: found, argvPrefix: ['exec', '-i', name], passwordViaEnv: false }
  if (!found.found) {
    // No client in the image: fall back to the log line plus the port.
    for (;;) {
      if (await readyLineSeen(deps, cli, name)) return { ok: true, via: 'log', elapsedMs: 0 }
      if (Date.now() > deadline) return { ok: false, via: '', reason: 'the image printed no ready line and has no sqlcmd to ask' }
      await deps.sleep(2000)
    }
  }
  const password = String(options.password || deps.env.DSH_SQL_SA_PASSWORD || deps.env.DSH_SQL_PASSWORD || '')
  const connection = connectOptions(deps, { password: password })
  const argv = withTransport(
    client,
    sqlcmdArgv(client, { server: 'localhost', user: connection.user, query: 'SELECT 1 AS ok', database: 'master' }),
    { password: password },
  )
  const call = callOf(client, argv)
  let attempts = 0
  for (;;) {
    attempts += 1
    const result = await deps.runner(call.program, call.args, {
      env: deps.env,
      timeoutMs: 30_000,
      extraEnv: clientEnv(client, { password: password }),
    })
    if (result.code === 0) {
      // A zero exit means the statement RAN (it is `-b`, so a T-SQL error would be
      // a non-zero code). The grid is not parsed here: the question is readiness,
      // not data.
      return { ok: true, via: 'sqlcmd', attempts: attempts, elapsedMs: 0 }
    }
    if (Date.now() > deadline) {
      return { ok: false, via: 'sqlcmd', attempts: attempts, reason: firstLine(result.stderr || result.error, 300) }
    }
    await deps.sleep(3000)
  }
}

const LIFECYCLE = new Set(['start', 'stop', 'restart', 'remove'])

/**
 * One lifecycle verb on the container this row owns.
 *
 * Only `start` creates and only `remove` destroys; a removal needs `confirm`
 * equal to the container name, because the writable layer goes with it (the named
 * volume does not - that is the point of the volume).
 */
export async function actOnServer(deps, options = {}) {
  const action = String(options.action || '').toLowerCase()
  const name = String(options.container || deps.env.DSH_SQL_CONTAINER || DEFAULT_CONTAINER)
  if (!LIFECYCLE.has(action)) throw new SqlError('BAD_ACTION', 'Not a lifecycle action: ' + action)
  const cli = await findContainerCli(deps)
  if (!cli.found) throw new SqlError('NO_CLI', 'No `docker` or `podman` on this PATH.')
  if (action === 'remove' && String(options.confirm || '') !== name) {
    throw new SqlError(
      'NEEDS_CONFIRM',
      'Removing container ' + name + ' destroys its writable layer; the databases live in the named volume and survive. Pass confirm: "' + name + '" to do it. Nothing was changed.',
    )
  }
  const result = await deps.runner(cli.path, [action, name], { env: deps.env, timeoutMs: CAPS.actionTimeoutMs })
  if (result.code !== 0) {
    throw new SqlError(
      action.toUpperCase() + '_FAILED',
      'Could not ' + action + ' ' + name + ': ' + firstLine(result.stderr || result.error, 300),
    )
  }
  return {
    action: action,
    container: name,
    text: firstLine(result.stdout, 200),
    state: await serverState(deps, { container: name }),
  }
}
