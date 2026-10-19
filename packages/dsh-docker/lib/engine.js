/**
 * dsh-docker — which engine this machine has, and whether its daemon is awake.
 *
 * The design decision that everything else rests on: **the CLI is the API**.
 * This plugin never opens a socket to `dockerd`, never speaks the Docker HTTP
 * API and never reads `//./pipe/docker_engine` itself. It runs the CLI a person
 * already has, which means contexts, a remote `DOCKER_HOST`, a rootless socket
 * and a Podman machine all work by the CLI's own configuration instead of this
 * plugin re-implementing them (and getting one of them wrong).
 *
 * The two states a person actually meets are why detection is a first-class
 * answer rather than an error:
 *
 *   - **CLI absent** - nothing to run. The answer names the install and stops.
 *   - **CLI present, daemon asleep** - the normal state on Windows 11 with
 *     Docker Desktop closed, and on macOS. `docker version` exits non-zero and
 *     prints a client object with `Server: null`; the plugin keeps that client
 *     (its version and context are useful) and reports the daemon down with the
 *     engine's own sentence, plus the one action that fixes it: starting
 *     Docker Desktop (or `podman machine start`).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { ENGINE_CANDIDATES, READ_TIMEOUT_MS, firstLine, messageOf, parseJson, parseJsonLines } from './cli.js'

/** How long `--version` may take: it never touches the daemon. */
export const CLI_PROBE_TIMEOUT_MS = 10_000
/** How long the daemon may take to answer `version`. */
export const DAEMON_TIMEOUT_MS = 25_000
/** After a start, the engine is polled at this interval. */
export const START_POLL_MS = 1500
/** How long a start waits, by default and at most. */
export const DEFAULT_START_WAIT_MS = 90_000
export const MAX_START_WAIT_MS = 300_000

/** Where Docker Desktop lives on each platform, when it does. */
export const DESKTOP_APP = {
  win32: path.join('Docker', 'Docker', 'Docker Desktop.exe'),
  darwin: '/Applications/Docker.app',
  linux: '/opt/docker-desktop/bin/docker-desktop',
}

/**
 * The CLIs to try, in order.
 *
 * `DSH_DOCKER_CLI` pins one: a bare name (`podman`), or an absolute path to a
 * specific build (its basename decides which dialect it speaks). That is the one
 * escape hatch, and it is also how the package's check points the row at a
 * scripted CLI.
 */
export function engineCandidates(deps = {}) {
  const env = deps.env === undefined || deps.env === null ? {} : deps.env
  const configured = typeof env.DSH_DOCKER_CLI === 'string' ? env.DSH_DOCKER_CLI.trim() : ''
  if (configured !== '') {
    const base = path.basename(configured).toLowerCase()
    const name = base.startsWith('podman') ? 'podman' : base.startsWith('docker') ? 'docker' : ''
    if (name === '') return []
    return [{ name: name, file: configured, explicit: true }]
  }
  return ENGINE_CANDIDATES.map((name) => ({ name: name, file: name, explicit: false }))
}

/** `25.0.3`, `4.9.3`, `v2.24.6-desktop.1` - the first version-shaped token. */
export function versionOf(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return ''
  for (const key of ['Version', 'version', 'GitCommit', 'ApiVersion']) {
    if (typeof entry[key] === 'string') {
      const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(entry[key])
      if (match !== null) return match[1]
    }
  }
  return ''
}

/**
 * The `version --format '{{json .}}'` payload, in the shape both engines use.
 *
 * Docker: `{ Client: {...}, Server: {...}|null }`. Podman: the same on a machine
 * backend, and on Linux often a flat object with no `Server` at all - which is
 * why a flat payload is read as BOTH sides rather than as "down".
 */
export function parseVersionPayload(text) {
  const parsed = parseJson(text)
  if (parsed === null || typeof parsed !== 'object') return null
  const client = parsed.Client !== undefined && parsed.Client !== null ? parsed.Client : typeof parsed.Version === 'string' ? parsed : null
  const server = parsed.Server !== undefined ? parsed.Server : typeof parsed.Version === 'string' ? parsed : null
  return { client: client, server: server, raw: parsed }
}

/** The first CLI that answers `--version`, or null. */
export async function detectCli(deps) {
  for (const candidate of engineCandidates(deps)) {
    const result = await deps.runner(candidate.file, ['--version'], { timeoutMs: CLI_PROBE_TIMEOUT_MS })
    if (result.error !== '' && result.error !== undefined) continue
    if (result.code !== 0 && String(result.stdout).trim() === '' && String(result.stderr).trim() === '') continue
    const text = String(result.stdout) + ' ' + String(result.stderr)
    const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text)
    return { name: candidate.name, file: candidate.file, version: match === null ? '' : match[1] }
  }
  return null
}

/** The engine's version, context and daemon state, as one answer. */
export async function engineInfo(deps, cli) {
  const result = await deps.runner(cli.file, ['version', '--format', '{{json .}}'], { timeoutMs: DAEMON_TIMEOUT_MS })
  const payload = parseVersionPayload(result.stdout)
  const client = payload === null ? null : payload.client
  const server = payload === null ? null : payload.server
  const clientVersion = versionOf(client) !== '' ? versionOf(client) : cli.version
  const serverVersion = versionOf(server)
  // A daemon is UP when the CLI answered `version` successfully AND produced a
  // version object. Docker exits 1 with a client object when the daemon is
  // asleep; podman exits 125 with "Cannot connect to Podman".
  const up = result.code === 0 && payload !== null
  const reason = up ? '' : daemonReason(result)
  return {
    cli: cli.name,
    file: cli.file,
    cliVersion: clientVersion,
    serverVersion: serverVersion,
    apiVersion: server !== null && typeof server.ApiVersion === 'string' ? server.ApiVersion : '',
    context: client !== null && typeof client.Context === 'string' ? client.Context : '',
    daemon: up ? 'up' : 'down',
    reason: reason,
  }
}

/** The one sentence that explains a daemon that did not answer. */
export function daemonReason(result) {
  const said = firstLine(result === null || result === undefined ? '' : result.stderr)
  if (said !== '') return said
  if (result !== null && result !== undefined && result.timedOut === true) return 'The engine did not answer within ' + Math.round(DAEMON_TIMEOUT_MS / 1000) + ' s.'
  return 'The engine is not running (the CLI answered with no server object).'
}

/** Where Docker Desktop is on this platform, or `''`. */
export function desktopAppPath(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    for (const root of roots) {
      if (typeof root !== 'string' || root === '') continue
      const candidate = path.join(root, DESKTOP_APP.win32)
      if (exists(candidate)) return candidate
    }
    return ''
  }
  if (platform === 'darwin') return exists(DESKTOP_APP.darwin) ? DESKTOP_APP.darwin : ''
  if (platform === 'linux') return exists(DESKTOP_APP.linux) ? DESKTOP_APP.linux : ''
  return ''
}

/**
 * How this machine can be told to start its engine, as a value.
 *
 * `kind: 'app'` is a GUI app spawned and left alone (Docker Desktop); `kind:
 * 'open'` is macOS' own `open -a Docker`; `kind: 'run'` is a command waited on
 * (`podman machine start`). Anything else is a `hint`: a sentence with the
 * command a person runs themselves, because starting a system service needs
 * privileges this plugin does not have and will not ask for.
 */
export async function startPlanFor(deps, cli) {
  const platform = deps.platform ?? process.platform
  if (cli.name === 'docker') {
    const app = desktopAppPath({ platform: platform, env: deps.env, exists: deps.exists })
    if (app !== '') {
      if (platform === 'darwin') return { kind: 'open', file: 'open', argv: ['-a', 'Docker'], label: 'Docker Desktop', hint: '' }
      return { kind: 'app', file: app, argv: [], label: 'Docker Desktop', hint: '' }
    }
    if (platform === 'linux') {
      return { kind: '', label: '', hint: 'Start the engine yourself: `sudo systemctl start docker`, or `systemctl --user start docker` for a rootless engine. This plugin will not ask for sudo.' }
    }
    return {
      kind: '',
      label: '',
      hint: 'Docker Desktop is not installed where this plugin looks for it. Install it, or start your engine by hand and call `docker_state` again.',
    }
  }
  // podman: a machine on Windows/macOS, a user socket on Linux.
  const machines = await deps.runner(cli.file, ['machine', 'list', '--format', '{{json .}}'], { timeoutMs: READ_TIMEOUT_MS })
  const rows = parseJsonLines(machines.stdout)
  if (rows.length > 0) {
    return { kind: 'run', file: cli.file, argv: ['machine', 'start'], label: 'the podman machine', hint: '' }
  }
  if (platform === 'linux') {
    return {
      kind: '',
      label: '',
      hint: 'No podman machine is defined on this host. A rootless Podman on Linux needs its user service: `systemctl --user start podman.socket`, then `docker_state` again. This plugin will not run a system service for you.',
    }
  }
  return { kind: '', label: '', hint: 'No podman machine exists yet: run `podman machine init`, then `podman machine start`, then call `docker_state` again.' }
}

/**
 * Start the engine, then wait for its daemon.
 *
 * The GUI path is fire-and-forget ON PURPOSE: Docker Desktop is its own program
 * with its own updater and its own tray icon, and waiting on that process would
 * wait for the app to quit, not for the engine to answer. The wait is for the
 * daemon - `version` succeeding - which is the fact that matters.
 */
export async function startEngine(deps, cli, options = {}) {
  const requested = Number(options.waitMs)
  const waitMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_START_WAIT_MS) : DEFAULT_START_WAIT_MS
  const plan = await startPlanFor(deps, cli)
  if (plan.kind === '') return { ok: false, started: false, plan: plan, message: plan.hint }
  if (plan.kind === 'run') {
    const result = await deps.runner(plan.file, plan.argv, { timeoutMs: 120_000 })
    if (result.error !== '' && result.error !== undefined) return { ok: false, started: false, plan: plan, message: 'Could not run it: ' + result.error }
    if (result.code !== 0) return { ok: false, started: false, plan: plan, message: firstLine(result.stderr) || 'The start command exited ' + result.code + '.' }
  } else {
    const launched = deps.spawnDetached(plan.file, plan.argv)
    if (launched !== null && launched !== undefined && launched.ok === false) {
      return { ok: false, started: false, plan: plan, message: 'Could not launch it: ' + (launched.message ?? 'unknown error') }
    }
  }
  const began = Date.now()
  for (;;) {
    await deps.sleep(START_POLL_MS)
    const info = await engineInfo(deps, cli)
    if (info.daemon === 'up') return { ok: true, started: true, plan: plan, waitedMs: Date.now() - began, info: info }
    if (Date.now() - began >= waitMs) {
      return {
        ok: false,
        started: true,
        plan: plan,
        waitedMs: Date.now() - began,
        info: info,
        message:
          'Started ' +
          plan.label +
          ', but the engine has not answered within ' +
          Math.round(waitMs / 1000) +
          ' s. It may still be starting: call `docker_state` again in a minute. ' +
          (info.reason === '' ? '' : 'Last answer: ' + info.reason),
      }
    }
  }
}

/** Start one GUI program and stop caring about it. */
export function spawnDetached(file, argv) {
  try {
    const child = spawn(file, Array.isArray(argv) ? argv : [], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { ok: true, pid: child.pid === undefined ? null : child.pid }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  }
}
