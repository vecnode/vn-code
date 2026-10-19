/**
 * dsh-docker — the engine's command surface.
 *
 * Every function here is one thing a person means by "look at / change my
 * containers", expressed as a fixed argv array. Nothing in this file is a shell,
 * and nothing takes a flag from a caller: the verbs are literals, and the only
 * values that reach argv came through `validate.js` first.
 *
 * The rule that decides what exists at all: **this is not a shell with a
 * `docker` prefix.** There is no `exec` (that is a remote shell, and the
 * harness's own shell tool is already governed by the session's approval
 * policy), no `system prune` (too broad to confirm meaningfully), and no free
 * `run` - `docker_run` builds its argv from a validated schema, so a caller
 * cannot smuggle `--privileged` or `--pid host` into a create.
 */

import { ACTION_TIMEOUT_MS, PULL_TIMEOUT_MS, READ_TIMEOUT_MS, clipText, firstLine, parseJson, parseJsonLines } from './cli.js'
import { daemonReason, detectCli, engineInfo, startPlanFor } from './engine.js'
import {
  MAX_ENV_PAIRS,
  MAX_PORTS,
  MAX_VOLUMES,
  commandToken,
  confirmMatches,
  envPair,
  imageRef,
  networkName,
  portSpec,
  sinceSpec,
  tailCount,
  targetRef,
  volumeSpec,
} from './validate.js'

/** A refusal with a code the route can turn into an HTTP status. */
export class DockerError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.status = code === 'NO_CLI' || code === 'ENGINE_DOWN' ? 503 : code === 'FAILED' || code === 'TIMEOUT' ? 502 : 400
  }
}

/** The sentence for a machine with no CLI at all. */
export function noCliSentence() {
  return (
    'This machine has no `docker` or `podman` CLI on PATH, so there is nothing to ask. ' +
    'Install Docker Desktop (which puts `docker` on PATH) or Podman, then call `docker_state` again. ' +
    'Set DSH_DOCKER_CLI to a specific binary if one is installed somewhere PATH does not cover.'
  )
}

/** The sentence for a CLI whose engine is not answering. */
export function engineDownSentence(info) {
  return (
    'The ' +
    info.cli +
    ' engine is not answering: ' +
    (info.reason === '' ? daemonReason(null) : info.reason) +
    ' Call `docker_start` to start it (Docker Desktop, or a podman machine), or start the engine yourself and retry.'
  )
}

/** The CLI and a confirmed-live engine, or the refusal that says why not. */
export async function ensureEngine(deps) {
  const cli = await detectCli(deps)
  if (cli === null) throw new DockerError('NO_CLI', noCliSentence())
  const info = await engineInfo(deps, cli)
  if (info.daemon !== 'up') throw new DockerError('ENGINE_DOWN', engineDownSentence(info))
  return { cli: cli, info: info }
}

/** Run one engine command and turn a failure into a refusal. */
async function engineRun(deps, cli, argv, options = {}) {
  const result = await deps.runner(cli.file, argv, {
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    maxBytes: options.maxBytes,
    env: deps.env,
  })
  if (result.error !== '' && result.error !== undefined) {
    throw new DockerError('NO_CLI', 'Could not run ' + cli.file + ': ' + result.error)
  }
  if (result.timedOut === true) {
    throw new DockerError('TIMEOUT', '`' + cli.name + ' ' + argv[0] + '` did not finish within ' + Math.round((options.timeoutMs ?? READ_TIMEOUT_MS) / 1000) + ' s and was stopped.')
  }
  if (result.code !== 0) {
    const said = firstLine(result.stderr) || firstLine(result.stdout) || 'exit code ' + result.code
    throw new DockerError('FAILED', '`' + cli.name + ' ' + argv[0] + '` refused: ' + said)
  }
  return result
}

// ---------------------------------------------------------------------------
// Parsing what the engine prints
// ---------------------------------------------------------------------------
/** One container row, from the engine's own JSON. */
export function normalizeContainer(row) {
  const source = row === null || row === undefined ? {} : row
  const names = typeof source.Names === 'string' ? source.Names : typeof source.Name === 'string' ? source.Name : ''
  const state = String(source.State === undefined ? '' : source.State).toLowerCase()
  return {
    id: String(source.ID === undefined ? source.Id ?? '' : source.ID),
    name: names.split(',')[0].replace(/^\//, ''),
    image: String(source.Image === undefined ? '' : source.Image),
    state: state,
    status: String(source.Status === undefined ? '' : source.Status),
    ports: String(source.Ports === undefined ? '' : source.Ports),
    created: String(source.CreatedAt === undefined ? '' : source.CreatedAt),
    running: state === 'running',
    networks: String(source.Networks === undefined ? '' : source.Networks),
    mounts: String(source.Mounts === undefined ? '' : source.Mounts),
    size: String(source.Size === undefined ? '' : source.Size),
  }
}

/** One image row, from the engine's own JSON. */
export function normalizeImage(row) {
  const source = row === null || row === undefined ? {} : row
  const id = String(source.ID === undefined ? source.Id ?? '' : source.ID)
  const repository = String(source.Repository === undefined ? '' : source.Repository)
  const tag = String(source.Tag === undefined ? '' : source.Tag)
  const unnamed = repository === '' || repository === '<none>'
  const short = id.replace(/^sha256:/, '').slice(0, 12)
  return {
    id: id,
    repository: repository,
    tag: tag,
    ref: unnamed ? (short === '' ? '<untagged>' : short) : repository + (tag === '' || tag === '<none>' ? '' : ':' + tag),
    digest: String(source.Digest === undefined ? '' : source.Digest),
    size: String(source.Size === undefined ? '' : source.Size),
    created: String(source.CreatedAt === undefined ? source.CreatedAt ?? '' : source.CreatedAt),
    containers: String(source.Containers === undefined ? '' : source.Containers),
  }
}

/** `docker ps` as rows. */
export async function listContainers(deps, cli, options = {}) {
  const argv = ['ps', '--no-trunc', '--format', '{{json .}}']
  if (options.all !== false) argv.push('-a')
  const filter = options.filter === undefined || options.filter === null ? '' : String(options.filter).trim()
  if (filter !== '') {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(filter)) throw new DockerError('BAD_ARG', '`filter` is a name or image fragment (letters, digits, ".", "_", "-"), not ' + JSON.stringify(filter) + '.')
    argv.push('--filter', 'name=' + filter)
  }
  const result = await engineRun(deps, cli, argv)
  return { containers: parseJsonLines(result.stdout).map(normalizeContainer), truncated: result.truncated === true }
}

/** `docker images` as rows. */
export async function listImages(deps, cli, options = {}) {
  const argv = ['images', '--no-trunc', '--format', '{{json .}}']
  const filter = options.filter === undefined || options.filter === null ? '' : String(options.filter).trim()
  if (filter !== '') {
    if (!/^[A-Za-z0-9_.:/@-]{1,128}$/.test(filter)) throw new DockerError('BAD_ARG', '`filter` is an image reference fragment, not ' + JSON.stringify(filter) + '.')
    argv.push('--filter', 'reference=' + filter)
  }
  const result = await engineRun(deps, cli, argv)
  return { images: parseJsonLines(result.stdout).map(normalizeImage), truncated: result.truncated === true }
}

/** `docker system df`, which is slow and therefore only on request. */
export async function diskUsage(deps, cli) {
  const result = await engineRun(deps, cli, ['system', 'df', '--format', '{{json .}}'], { timeoutMs: 30_000 })
  return parseJsonLines(result.stdout).map((row) => ({
    type: String(row.Type === undefined ? '' : row.Type),
    total: String(row.TotalCount === undefined ? '' : row.TotalCount),
    active: String(row.Active === undefined ? '' : row.Active),
    size: String(row.Size === undefined ? '' : row.Size),
    reclaimable: String(row.Reclaimable === undefined ? '' : row.Reclaimable),
  }))
}

/**
 * One container or image, as facts instead of a 400 KB document.
 *
 * `inspect` is the same command for both, so the kind is READ OFF the answer:
 * an image carries `RepoTags`/`Architecture`, a container carries a `State`
 * with a `Status`.
 */
export async function inspectTarget(deps, cli, options = {}) {
  const kind = options.kind === 'image' ? 'image' : options.kind === 'container' ? 'container' : ''
  const target = targetRef(options.id, { kind: kind === '' ? 'container' : kind })
  if (!target.ok) {
    // A container-shaped check would reject `alpine:3.20`; when the caller did
    // not say which it is, an image reference is a legitimate second reading.
    const asImage = kind === '' ? targetRef(options.id, { kind: 'image' }) : target
    if (!asImage.ok) throw new DockerError('BAD_ARG', target.reason)
    return inspectTarget(deps, cli, { ...options, kind: 'image' })
  }
  const result = await engineRun(deps, cli, ['inspect', target.value])
  const parsed = parseJson(result.stdout)
  const item = Array.isArray(parsed) ? parsed[0] : parsed
  if (item === null || item === undefined) throw new DockerError('FAILED', 'The engine returned no inspect document for ' + target.value + '.')
  const summary = summarizeInspect(item)
  return { target: target.value, kind: summary.kind, facts: summary }
}

/** The bounded facts of one inspect document. */
export function summarizeInspect(item) {
  const state = item.State === undefined || item.State === null ? {} : item.State
  const config = item.Config === undefined || item.Config === null ? {} : item.Config
  const hostConfig = item.HostConfig === undefined || item.HostConfig === null ? {} : item.HostConfig
  const net = item.NetworkSettings === undefined || item.NetworkSettings === null ? {} : item.NetworkSettings
  const isImage = Array.isArray(item.RepoTags) || typeof item.Architecture === 'string'
  if (isImage) {
    return {
      kind: 'image',
      id: String(item.Id === undefined ? item.ID ?? '' : item.Id),
      tags: Array.isArray(item.RepoTags) ? item.RepoTags : [],
      digests: Array.isArray(item.RepoDigests) ? item.RepoDigests : [],
      created: String(item.Created === undefined ? '' : item.Created),
      size: Number(item.Size) || 0,
      architecture: String(item.Architecture === undefined ? '' : item.Architecture),
      os: String(item.Os === undefined ? '' : item.Os),
      cmd: Array.isArray(config.Cmd) ? config.Cmd : [],
      entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint : [],
      envCount: Array.isArray(config.Env) ? config.Env.length : 0,
      labels: config.Labels === undefined || config.Labels === null ? 0 : Object.keys(config.Labels).length,
    }
  }
  const ports = []
  const bindings = net.Ports === undefined || net.Ports === null ? {} : net.Ports
  for (const [containerPort, list] of Object.entries(bindings)) {
    if (!Array.isArray(list)) continue
    for (const binding of list) {
      const host = binding === null || binding === undefined ? '' : String(binding.HostPort === undefined ? '' : binding.HostPort)
      ports.push((host === '' ? '' : host + ' -> ') + containerPort)
    }
  }
  return {
    kind: 'container',
    id: String(item.Id === undefined ? item.ID ?? '' : item.Id),
    name: String(item.Name === undefined ? '' : item.Name).replace(/^\//, ''),
    image: String(item.Image === undefined ? '' : item.Image),
    created: String(item.Created === undefined ? '' : item.Created),
    status: String(state.Status === undefined ? '' : state.Status),
    running: state.Running === true,
    paused: state.Paused === true,
    exitCode: Number.isFinite(Number(state.ExitCode)) ? Number(state.ExitCode) : null,
    startedAt: String(state.StartedAt === undefined ? '' : state.StartedAt),
    finishedAt: String(state.FinishedAt === undefined ? '' : state.FinishedAt),
    cmd: Array.isArray(config.Cmd) ? config.Cmd : [],
    entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint : [],
    envCount: Array.isArray(config.Env) ? config.Env.length : 0,
    restart: String(hostConfig.RestartPolicy !== undefined && hostConfig.RestartPolicy !== null && hostConfig.RestartPolicy.Name !== undefined ? hostConfig.RestartPolicy.Name : ''),
    networkMode: String(hostConfig.NetworkMode === undefined ? '' : hostConfig.NetworkMode),
    networks: net.Networks === undefined || net.Networks === null ? [] : Object.keys(net.Networks),
    ports: ports,
    mounts: Array.isArray(item.Mounts)
      ? item.Mounts.map((mount) => String(mount.Source === undefined ? '' : mount.Source) + ':' + String(mount.Destination === undefined ? '' : mount.Destination) + (mount.RW === false ? ':ro' : ''))
      : [],
  }
}

/** `docker logs`, tail-bounded. */
export async function logsOf(deps, cli, options = {}) {
  const kind = options.kind === 'image' ? 'image' : 'container'
  const target = targetRef(options.id, { kind: kind })
  if (!target.ok) throw new DockerError('BAD_ARG', target.reason)
  const tail = tailCount(options.tail)
  if (!tail.ok) throw new DockerError('BAD_ARG', tail.reason)
  const since = sinceSpec(options.since)
  if (!since.ok) throw new DockerError('BAD_ARG', since.reason)
  const argv = ['logs', '--tail', String(tail.value)]
  if (since.value !== '') argv.push('--since', since.value)
  argv.push(target.value)
  const result = await engineRun(deps, cli, argv, { timeoutMs: 30_000 })
  const text = String(result.stdout) + (String(result.stderr) === '' ? '' : '\n[stderr]\n' + String(result.stderr))
  return {
    id: target.value,
    text: text,
    lines: text === '' ? 0 : text.split(/\r?\n/).length,
    truncated: result.truncated === true,
  }
}

/** `docker pull`. */
export async function pullImage(deps, cli, options = {}) {
  const image = imageRef(options.image)
  if (!image.ok) throw new DockerError('BAD_ARG', image.reason)
  const result = await engineRun(deps, cli, ['pull', image.value], { timeoutMs: PULL_TIMEOUT_MS })
  return {
    image: image.value,
    text: clipText((String(result.stderr) + String(result.stdout)).trim(), 8000),
    elapsedMs: result.elapsedMs,
  }
}

/**
 * The argv one `docker run` becomes.
 *
 * Built here rather than by a caller so the dangerous flags simply have no
 * spelling: there is no `--privileged`, no `--pid host`, no `--device`, and a
 * volume's host side must be an absolute path or a named volume.
 */
export function buildRunArgv(spec) {
  const image = imageRef(spec.image)
  if (!image.ok) throw new DockerError('BAD_ARG', image.reason)
  const argv = ['run', '-d']
  if (spec.name !== undefined && spec.name !== null && spec.name !== '') {
    const name = targetRef(spec.name, { kind: 'container' })
    if (!name.ok) throw new DockerError('BAD_ARG', name.reason)
    argv.push('--name', name.value)
  }
  const ports = Array.isArray(spec.ports) ? spec.ports : []
  if (ports.length > MAX_PORTS) throw new DockerError('BAD_ARG', 'At most ' + MAX_PORTS + ' port mappings per run.')
  for (const value of ports) {
    const port = portSpec(value)
    if (!port.ok) throw new DockerError('BAD_ARG', port.reason)
    argv.push('-p', port.value)
  }
  const env = spec.env === null || spec.env === undefined ? {} : spec.env
  if (typeof env !== 'object' || Array.isArray(env)) throw new DockerError('BAD_ARG', '`env` is an object of NAME: value pairs.')
  const pairs = Object.entries(env)
  if (pairs.length > MAX_ENV_PAIRS) throw new DockerError('BAD_ARG', 'At most ' + MAX_ENV_PAIRS + ' environment variables per run.')
  for (const [key, value] of pairs) {
    const pair = envPair(key, value)
    if (!pair.ok) throw new DockerError('BAD_ARG', pair.reason)
    argv.push('-e', pair.value)
  }
  const volumes = Array.isArray(spec.volumes) ? spec.volumes : []
  if (volumes.length > MAX_VOLUMES) throw new DockerError('BAD_ARG', 'At most ' + MAX_VOLUMES + ' volumes per run.')
  for (const value of volumes) {
    const volume = volumeSpec(value)
    if (!volume.ok) throw new DockerError('BAD_ARG', volume.reason)
    argv.push('-v', volume.value)
  }
  if (spec.network !== undefined && spec.network !== null && spec.network !== '') {
    const network = networkName(spec.network)
    if (!network.ok) throw new DockerError('BAD_ARG', network.reason)
    argv.push('--network', network.value)
  }
  if (spec.remove === true) argv.push('--rm')
  // Everything after the image is the container's own command, so flags there
  // are the program's, not docker's.
  argv.push(image.value)
  const command = Array.isArray(spec.command) ? spec.command : []
  for (const token of command) {
    const parsed = commandToken(token)
    if (!parsed.ok) throw new DockerError('BAD_ARG', parsed.reason)
    argv.push(parsed.value)
  }
  return { argv: argv, image: image.value, name: spec.name === undefined || spec.name === null ? '' : String(spec.name) }
}

/** `docker run`, detached, from a validated spec. */
export async function runImage(deps, cli, spec) {
  const built = buildRunArgv(spec === null || spec === undefined ? {} : spec)
  const result = await engineRun(deps, cli, built.argv, { timeoutMs: ACTION_TIMEOUT_MS })
  const id = containerIdOf(result.stdout)
  return {
    id: id,
    image: built.image,
    name: built.name,
    text: 'Started ' + built.image + (built.name === '' ? '' : ' as ' + built.name) + (id === '' ? '' : ' (' + id.slice(0, 12) + ')') + '.',
  }
}

/** The actions this row allows, per kind. */
export const ACTIONS = {
  container: ['start', 'stop', 'restart', 'pause', 'unpause', 'remove'],
  image: ['remove'],
}

/** Read a container id out of `docker run`'s output, or `''`. */
export function containerIdOf(text) {
  const lines = String(text === undefined || text === null ? '' : text)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  const last = lines.length === 0 ? '' : lines[lines.length - 1].trim()
  return /^[0-9a-f]{12,64}$/i.test(last) ? last : ''
}

/** One lifecycle action: start, stop, restart, pause, unpause, remove. */
export async function actOn(deps, cli, options = {}) {
  const kind = options.kind === 'image' ? 'image' : 'container'
  const action = String(options.action === undefined ? '' : options.action).toLowerCase()
  if (!(ACTIONS[kind] || []).includes(action)) {
    throw new DockerError('BAD_ARG', 'Unknown action ' + JSON.stringify(action) + ' for a ' + kind + '. Use one of: ' + (ACTIONS[kind] || []).join(', ') + '.')
  }
  const target = targetRef(options.id, { kind: kind })
  if (!target.ok) throw new DockerError('BAD_ARG', target.reason)
  if (action === 'remove') {
    if (!confirmMatches(options.confirm, target.value)) {
      throw new DockerError(
        'CONFIRM_REQUIRED',
        'Removing ' + target.value + ' needs `confirm` set to the same id or name. It is the one action here that loses something: a running container loses its writable layer, and an image may need a pull to come back.',
      )
    }
  }
  // `remove` is this row's word; the engine's own is `rm`.
  const argv = kind === 'image' ? ['rmi'] : [action === 'remove' ? 'rm' : action]
  if (action === 'remove' && options.force === true) argv.push('-f')
  argv.push(target.value)
  const result = await engineRun(deps, cli, argv, { timeoutMs: ACTION_TIMEOUT_MS })
  return {
    action: action,
    kind: kind,
    id: target.value,
    text: firstLine(String(result.stdout) + String(result.stderr)) || action + ' ' + target.value + ' finished.',
  }
}

/**
 * Remove what nothing uses: stopped containers, or dangling images.
 *
 * Deliberately narrow. `docker system prune` also removes networks, build cache
 * and (with `-a`) every unused image, and one `confirm` cannot honestly cover
 * that; a person who wants it has a terminal.
 */
export async function pruneDangling(deps, cli, options = {}) {
  const kind = options.kind === 'container' ? 'container' : 'image'
  if (options.confirm !== 'prune') {
    throw new DockerError('CONFIRM_REQUIRED', 'Pruning needs `confirm` set to the word `prune`. It removes every stopped container, or every dangling image, on this engine.')
  }
  const argv = kind === 'container' ? ['container', 'prune', '-f'] : ['image', 'prune', '-f']
  const result = await engineRun(deps, cli, argv, { timeoutMs: ACTION_TIMEOUT_MS })
  return { kind: kind, text: String(result.stdout).trim() || 'Nothing to remove.' }
}

/**
 * The whole read surface in one answer: the engine, its containers, its images,
 * and on request the disk it is using.
 */
export async function stateView(deps, options = {}) {
  const cli = await detectCli(deps)
  if (cli === null) {
    return { ok: false, code: 'NO_CLI', daemon: 'absent', engine: null, message: noCliSentence(), containers: [], images: [], counts: null }
  }
  const info = await engineInfo(deps, cli)
  if (info.daemon !== 'up') {
    const plan = await startPlanFor(deps, cli)
    return {
      ok: false,
      code: 'ENGINE_DOWN',
      daemon: 'down',
      engine: info,
      startable: plan,
      message: engineDownSentence(info),
      containers: [],
      images: [],
      counts: null,
    }
  }
  const errors = {}
  let containers = []
  let images = []
  try {
    containers = (await listContainers(deps, cli, { all: options.all !== false })).containers
  } catch (err) {
    errors.containers = err instanceof DockerError ? err.message : String(err && err.message ? err.message : err)
  }
  try {
    images = (await listImages(deps, cli, {})).images
  } catch (err) {
    errors.images = err instanceof DockerError ? err.message : String(err && err.message ? err.message : err)
  }
  let disk = null
  if (options.disk === true) {
    try {
      disk = await diskUsage(deps, cli)
    } catch (err) {
      errors.disk = err instanceof DockerError ? err.message : String(err && err.message ? err.message : err)
    }
  }
  const counts = {
    containers: containers.length,
    running: containers.filter((row) => row.running).length,
    images: images.length,
  }
  return {
    ok: true,
    code: 'OK',
    daemon: 'up',
    engine: info,
    containers: containers,
    images: images,
    counts: counts,
    disk: disk,
    errors: errors,
  }
}

// The plan lives in engine.js beside the rest of the engine logic; it is only
// reached from the state view when the daemon is down.
