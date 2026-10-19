/**
 * dsh-docker — the nine tools.
 *
 * The shape is the one this pack uses everywhere (`{ text, view }`), and the
 * PROSE is the product: a tool that returns a table nobody can act on is worse
 * than a shell, so each description says when to call it and what it cannot do,
 * and each answer ends with the next move.
 *
 * The one convention a caller must learn: **`docker_state` first**. It is the
 * only tool that treats a sleeping engine as an answer rather than a failure, so
 * it is where "start Docker Desktop" comes from. Every other tool refuses with
 * the same sentence when the engine is down, which is correct but less useful
 * than the state that says exactly what to do.
 *
 * `docker_action` and `docker_run` are the only writers. The first needs
 * `confirm` equal to the target for a removal, and the second has no spelling
 * for `--privileged`, `--pid host`, `--device` or a relative host path.
 */

import { DockerError, actOn, ensureEngine, inspectTarget, listContainers, listImages, logsOf, pruneDangling, pullImage, runImage, stateView } from './docker.js'
import { detectCli, engineInfo, startEngine, startPlanFor } from './engine.js'
import { clipText } from './cli.js'

/** The output shape every tool returns: prose for the model, a view for the card. */
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
  if (error instanceof DockerError) return refusal(error.code, error.message)
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
  const widths = headers.map((header, index) => Math.min(40, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))))
  const line = (cells) => cells.map((value, index) => cell(value, widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** One container row, as a line of the state answer. */
function containerLine(row) {
  return row.name + (row.running ? '' : ' (' + row.state + ')') + '  ' + row.image + (row.ports === '' ? '' : '  ' + row.ports)
}

/** The engine's one-line identity. */
function engineLine(info) {
  const version = info.serverVersion !== '' ? info.serverVersion : info.cliVersion
  return info.cli + (version === '' ? '' : ' ' + version) + (info.context === '' ? '' : ' \u00b7 context ' + info.context)
}

/** The state answer, as prose + a view. */
function stateText(state) {
  if (state.ok !== true) {
    const lines = [state.message]
    if (state.code === 'ENGINE_DOWN' && state.startable !== undefined && state.startable !== null) {
      if (state.startable.hint !== '') lines.push('', 'To start it: ' + state.startable.hint)
      else lines.push('', '`docker_start` can start ' + (state.startable.label === '' ? 'the engine' : state.startable.label) + ' on this machine.')
    }
    return lines.join('\n')
  }
  const lines = []
  lines.push('Engine: ' + engineLine(state.engine) + ' \u00b7 up')
  lines.push(
    'Containers: ' +
      state.counts.containers +
      ' (' +
      state.counts.running +
      ' running) \u00b7 Images: ' +
      state.counts.images,
  )
  lines.push('')
  if (state.containers.length === 0) {
    lines.push('No containers. `docker_run` starts one from an image, or `docker_pull` fetches an image first.')
  } else {
    lines.push('CONTAINERS')
    lines.push(table(['NAME', 'STATE', 'IMAGE', 'PORTS'], state.containers.slice(0, 40).map((row) => [row.name, row.state, row.image, row.ports])))
    if (state.containers.length > 40) lines.push('\u2026 and ' + (state.containers.length - 40) + ' more; `docker_ps` lists them all.')
  }
  if (state.images.length > 0) {
    lines.push('')
    lines.push('IMAGES')
    lines.push(table(['IMAGE', 'SIZE', 'CREATED'], state.images.slice(0, 20).map((row) => [row.ref, row.size, row.created])))
    if (state.images.length > 20) lines.push('\u2026 and ' + (state.images.length - 20) + ' more; `docker_images` lists them all.')
  }
  for (const [what, message] of Object.entries(state.errors ?? {})) lines.push('', 'Could not read ' + what + ': ' + message)
  if (Array.isArray(state.disk) && state.disk.length > 0) {
    lines.push('')
    lines.push('DISK')
    lines.push(table(['TYPE', 'TOTAL', 'ACTIVE', 'SIZE', 'RECLAIMABLE'], state.disk.map((row) => [row.type, row.total, row.active, row.size, row.reclaimable])))
  }
  lines.push('')
  lines.push('Next: `docker_ps` / `docker_images` for the lists, `docker_inspect` and `docker_logs` for one thing, `docker_run` to start an image, `docker_action` to start/stop/restart/remove, `docker_pull` to fetch.')
  return lines.join('\n')
}

/** Build the tools. @param deps - `{ runner, env, platform, sleep, spawnDetached, exists, log }`. */
export function buildTools(deps) {
  /** `docker_state`: what is here, whether it answers, and what it holds. */
  const state = {
    name: 'docker_state',
    description: [
      'Report whether this machine has a Docker (or Podman) engine, whether its daemon is answering, and - when it is - every container and image it holds, with the engine version and context.',
      'Call this FIRST, before any other docker_* tool. It is the only one that treats a sleeping engine as an answer instead of a failure: on Windows 11 with Docker Desktop closed, or a mac with Docker Desktop quit, this tool says so and names the action that fixes it (`docker_start`, or the system command when the plugin cannot start it).',
      '`disk: true` also asks for `docker system df` - the space containers, images, volumes and the build cache are using. It is slow (a second or two against a busy engine), so it is opt-in.',
      'Read-only. It never starts, stops or removes anything.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disk: { type: 'boolean', description: 'Also report `docker system df`. Default false: it is the slowest call here.' },
        all: { type: 'boolean', description: 'Include stopped containers. Default true - the state should show what is there, not only what runs.' },
      },
    },
    output: OUTPUT,
    ...present('Docker state'),
    async execute(args) {
      try {
        const view = await stateView(deps, { disk: args.disk === true, all: args.all !== false })
        return { text: stateText(view), view: view }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_ps`: the containers, filtered. */
  const ps = {
    name: 'docker_ps',
    description: [
      'List this machine\'s containers: name, state, image, ports and status, with the id each row answers to.',
      '`all: false` hides stopped containers. `filter` is a name or image fragment (letters, digits, ".", "_", "-") and is passed to the engine as `--filter name=...`.',
      'The values `docker_state` prints are the ones to pass to `docker_inspect`, `docker_logs` and `docker_action` (a name, a short id, or a full id - all three work).',
      'Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: 'Include stopped containers. Default true.' },
        filter: { type: 'string', description: 'Name or image fragment, e.g. "web" or "postgres".' },
      },
    },
    output: OUTPUT,
    ...present('Docker containers'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const listed = await listContainers(deps, cli, { all: args.all !== false, filter: args.filter })
        const rows = listed.containers
        if (rows.length === 0) {
          return { text: 'No containers' + (args.all === false ? ' are running' : ' exist') + '.', view: { ok: true, containers: [], count: 0 } }
        }
        const text =
          table(['ID', 'NAME', 'STATE', 'IMAGE', 'PORTS', 'STATUS'], rows.map((row) => [row.id.slice(0, 12), row.name, row.state, row.image, row.ports, row.status])) +
          (listed.truncated ? '\n(the engine\'s answer was cut)' : '')
        return { text: text, view: { ok: true, containers: rows, count: rows.length } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_images`: the local images. */
  const images = {
    name: 'docker_images',
    description: [
      'List the images this engine holds: reference (repository:tag), id, size, creation time and how many containers use each.',
      '`filter` is a reference fragment (e.g. "alpine", "ghcr.io/org") and is passed as `--filter reference=...`.',
      'An untagged image is shown by its id. `docker_run` takes any reference this prints; `docker_pull` fetches one that is not here.',
      'Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: { type: 'string', description: 'Reference fragment, e.g. "alpine".' },
      },
    },
    output: OUTPUT,
    ...present('Docker images'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const listed = await listImages(deps, cli, { filter: args.filter })
        const rows = listed.images
        if (rows.length === 0) return { text: 'No images. `docker_pull` fetches one.', view: { ok: true, images: [], count: 0 } }
        const text =
          table(['IMAGE', 'ID', 'SIZE', 'CREATED', 'USED BY'], rows.map((row) => [row.ref, row.id.replace(/^sha256:/, '').slice(0, 12), row.size, row.created, row.containers])) +
          (listed.truncated ? '\n(the engine\'s answer was cut)' : '')
        return { text: text, view: { ok: true, images: rows, count: rows.length } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_inspect`: one thing's facts, bounded. */
  const inspect = {
    name: 'docker_inspect',
    description: [
      'Show one container or image as a bounded set of facts - id, name/tags, image, status, exit code, command, restart policy, ports, mounts, networks, size - instead of the engine\'s whole inspect document.',
      '`id` is a name, a short id or a full id, as printed by `docker_state` / `docker_ps` / `docker_images`. An image reference (`alpine:3.20`) is accepted too. `kind` is optional: without it the answer says which it found.',
      'Read-only. Use `docker_logs` for what the container printed, `docker_action` to change it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container name/id, or an image reference.' },
        kind: { type: 'string', enum: ['container', 'image'], description: 'What the id names, when it is ambiguous.' },
      },
    },
    output: OUTPUT,
    ...present('Docker inspect'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const found = await inspectTarget(deps, cli, { id: args.id, kind: args.kind })
        const facts = found.facts
        const lines = []
        if (facts.kind === 'image') {
          lines.push('IMAGE ' + (facts.tags.length > 0 ? facts.tags.join(', ') : facts.id.replace(/^sha256:/, '').slice(0, 12)))
          lines.push('id            ' + facts.id)
          if (facts.digests.length > 0) lines.push('digest        ' + facts.digests[0])
          lines.push('created       ' + facts.created)
          lines.push('size          ' + (facts.size > 0 ? Math.round(facts.size / 1024 / 1024) + ' MB' : 'unknown'))
          lines.push('platform      ' + [facts.os, facts.architecture].filter((part) => part !== '').join('/'))
          lines.push('entrypoint    ' + (facts.entrypoint.length === 0 ? '(none)' : facts.entrypoint.join(' ')))
          lines.push('cmd           ' + (facts.cmd.length === 0 ? '(none)' : facts.cmd.join(' ')))
          lines.push('env vars      ' + facts.envCount + ' \u00b7 labels ' + facts.labels)
        } else {
          lines.push('CONTAINER ' + facts.name)
          lines.push('id            ' + facts.id)
          lines.push('image         ' + facts.image)
          lines.push('status        ' + facts.status + (facts.running ? '' : facts.exitCode !== null ? ' (exit ' + facts.exitCode + ')' : ''))
          lines.push('created       ' + facts.created)
          lines.push('started       ' + (facts.startedAt === '' ? '\u2014' : facts.startedAt) + ' \u00b7 finished ' + (facts.finishedAt === '' ? '\u2014' : facts.finishedAt))
          lines.push('command       ' + (facts.entrypoint.length === 0 ? '' : facts.entrypoint.join(' ')) + (facts.cmd.length === 0 ? '' : ' ' + facts.cmd.join(' ')))
          lines.push('restart       ' + (facts.restart === '' ? 'no' : facts.restart) + ' \u00b7 network ' + facts.networkMode)
          lines.push('ports         ' + (facts.ports.length === 0 ? '(none published)' : facts.ports.join(', ')))
          lines.push('mounts        ' + (facts.mounts.length === 0 ? '(none)' : facts.mounts.join(', ')))
          lines.push('networks      ' + (facts.networks.length === 0 ? '(default)' : facts.networks.join(', ')))
          lines.push('env vars      ' + facts.envCount)
        }
        return { text: lines.join('\n'), view: { ok: true, kind: facts.kind, facts: facts } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_logs`: the tail of one container's output. */
  const logs = {
    name: 'docker_logs',
    description: [
      'Show the last `tail` lines a container wrote (default 200, at most 2000), optionally since a duration (`10m`, `2h`) or an RFC 3339 timestamp.',
      'The answer is capped at 1 MiB and says when it was cut. Container stdout comes first and its stderr is appended under a `[stderr]` marker - the engine keeps the two streams apart, and interleaving them would invent an order that never existed.',
      'A stopped container still has its logs until it is removed. Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container name or id.' },
        tail: { type: 'number', description: 'How many lines from the end: 0-2000. Default 200.' },
        since: { type: 'string', description: 'A duration (`15m`) or an RFC 3339 timestamp.' },
      },
    },
    output: OUTPUT,
    ...present('Docker logs'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const found = await logsOf(deps, cli, { id: args.id, tail: args.tail, since: args.since })
        const text = found.text === '' ? '(the container has written nothing)' : clipText(found.text, 20_000)
        return {
          text: 'Logs of ' + found.id + ' (' + found.lines + ' lines' + (found.truncated ? ', cut by the 1 MiB cap' : '') + '):\n\n' + text,
          view: { ok: true, id: found.id, lines: found.lines, truncated: found.truncated },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_pull`: fetch an image. */
  const pull = {
    name: 'docker_pull',
    description: [
      'Pull an image from its registry (`docker pull <image>`), so `docker_run` can start it without a first-run download.',
      'A pull is a network operation and may take minutes; this tool waits up to 15 minutes and reports the engine\'s own progress text at the end. A digest that is already present is a no-op.',
      'This is a WRITE against the registry and the local image store (it adds an image), but it removes nothing. It does not start anything: use `docker_run` for that.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: { type: 'string', description: 'An image reference: `alpine:3.20`, `ghcr.io/org/app:tag`.' },
      },
    },
    output: OUTPUT,
    ...present('Docker pull'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const done = await pullImage(deps, cli, { image: args.image })
        return {
          text: 'Pulled ' + done.image + ' in ' + Math.round(done.elapsedMs / 1000) + ' s.\n\n' + (done.text === '' ? '(the engine printed nothing)' : done.text),
          view: { ok: true, image: done.image, elapsedMs: done.elapsedMs },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_run`: create and start one container from a validated spec. */
  const run = {
    name: 'docker_run',
    description: [
      'Create and start a container from an image, detached (`docker run -d`), from a validated spec: image, optional name, port mappings, environment, volumes, network, the command, and whether the container removes itself when it stops.',
      'The schema is the safety: there is no spelling for `--privileged`, `--pid host`, `--device`, a relative host path or an arbitrary flag. A volume\'s host side is an absolute path or a named volume; a named container must match the engine\'s own name grammar.',
      'This is a WRITE: it creates a container and may pull the image first (docker does that itself). Removing one needs `docker_action` with `action: "remove"` and `confirm` set to the same id.',
      'Before running an image a person did not name, say what it is and what its ports expose. Ports are published on all interfaces unless a host address is given (`127.0.0.1:8080:80`).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: { type: 'string', description: 'Image reference, e.g. `nginx:1.27`.' },
        name: { type: 'string', description: 'Container name, e.g. `web`. Letters, digits, "_", ".", "-".' },
        ports: { type: 'array', items: { type: 'string' }, description: 'Port mappings, e.g. ["8080:80", "127.0.0.1:5432:5432"].' },
        env: { type: 'object', description: 'Environment variables, e.g. {"POSTGRES_PASSWORD":"dev"}.' },
        volumes: { type: 'array', items: { type: 'string' }, description: 'Volumes, e.g. ["data:/var/lib/postgresql/data"] or ["C:\\\\work:/work:ro"].' },
        command: { type: 'array', items: { type: 'string' }, description: 'The command and arguments the container runs, after the image.' },
        network: { type: 'string', description: 'A network to attach the container to.' },
        remove: { type: 'boolean', description: 'Add `--rm`, so the container is removed when it exits. Default false.' },
      },
    },
    output: OUTPUT,
    ...present('Docker run'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const started = await runImage(deps, cli, {
          image: args.image,
          name: args.name,
          ports: args.ports,
          env: args.env,
          volumes: args.volumes,
          command: args.command,
          network: args.network,
          remove: args.remove === true,
        })
        return {
          text:
            started.text +
            '\n\n' +
            (started.id === '' ? '' : 'id ' + started.id + '\n') +
            'Next: `docker_logs` for its output, `docker_inspect` for its facts, `docker_action` to stop or remove it.',
          view: { ok: true, id: started.id, image: started.image, name: started.name },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_action`: the lifecycle, and the only destructive verb. */
  const action = {
    name: 'docker_action',
    description: [
      'Change one container or image: start, stop, restart, pause or unpause a container; remove a container or an image; or prune every stopped container / every dangling image.',
      'A REMOVAL needs `confirm` set to the same value as `id` - the plugin refuses without it, on purpose: a container\'s writable layer is lost, and an image may need a pull to come back. `force: true` also passes `-f` (kill a running container, remove an image a container uses).',
      '`action: "prune"` needs `confirm: "prune"` and a `kind` of container or image. It removes only stopped containers or DANGLING images; this row has no `system prune` on purpose.',
      'Use `docker_state` or `docker_ps` first to get the exact id or name: `confirm` must match it character for character.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'pause', 'unpause', 'remove', 'prune'], description: 'What to do.' },
        kind: { type: 'string', enum: ['container', 'image'], description: 'What the id names. Default container. `image` only allows remove and prune.' },
        id: { type: 'string', description: 'The container or image to act on (required unless action is prune).' },
        confirm: { type: 'string', description: 'Repeat `id` for a removal, or the word "prune" for a prune. Not needed for start/stop/restart/pause/unpause.' },
        force: { type: 'boolean', description: 'Also pass -f to a removal. Default false.' },
      },
    },
    output: OUTPUT,
    ...present('Docker action'),
    async execute(args) {
      try {
        const { cli } = await ensureEngine(deps)
        const verb = String(args.action === undefined ? '' : args.action).toLowerCase()
        if (verb === 'prune') {
          const done = await pruneDangling(deps, cli, { kind: args.kind, confirm: args.confirm })
          return { text: 'Pruned (' + done.kind + '):\n\n' + done.text, view: { ok: true, action: 'prune', kind: done.kind } }
        }
        const done = await actOn(deps, cli, { action: verb, kind: args.kind, id: args.id, confirm: args.confirm, force: args.force === true })
        return {
          text: done.text + '\n\n(`' + done.action + '` on ' + done.kind + ' ' + done.id + '.)',
          view: { ok: true, action: done.action, kind: done.kind, id: done.id },
        }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  /** `docker_start`: turn the engine on. */
  const start = {
    name: 'docker_start',
    description: [
      'Start this machine\'s container engine and wait for it to answer: Docker Desktop on Windows and macOS (the app is launched, not waited on - the DAEMON is what is polled), Docker Desktop on Linux where it is installed, or `podman machine start`.',
      'When the plugin cannot start it (a Linux engine that needs sudo, no Docker Desktop where it looks, no podman machine defined, or no CLI at all) the answer says what to run instead, in one sentence.',
      'It waits up to `waitSeconds` (default 90, at most 300) for the daemon. Docker Desktop can take longer on a cold start: if it times out, `docker_state` again in a minute rather than calling this twice.',
      'Use this only when `docker_state` says the engine is down. It does nothing when the engine is already up.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        waitSeconds: { type: 'number', description: 'How long to wait for the daemon: 1-300. Default 90.' },
      },
    },
    output: OUTPUT,
    ...present('Docker start'),
    async execute(args) {
      try {
        const cli = await detectCli(deps)
        if (cli === null) return refusal('NO_CLI', 'No `docker` or `podman` CLI on PATH, so there is no engine this plugin can start. Install Docker Desktop or Podman, then call `docker_state`.')
        const before = await engineInfo(deps, cli)
        if (before.daemon === 'up') return { text: 'The ' + before.cli + ' engine is already up (' + engineLine(before) + ').', view: { ok: true, started: false, engine: before } }
        const plan = await startPlanFor(deps, cli)
        if (plan.kind === '') {
          return refusal('ENGINE_DOWN', 'The engine is down and this plugin cannot start it here: ' + plan.hint, { startable: plan, engine: before })
        }
        const started = await startEngine(deps, cli, { waitMs: args.waitSeconds })
        const text = started.ok
          ? 'Started ' + started.plan.label + '; the engine answered after ' + Math.round((started.waitedMs ?? 0) / 1000) + ' s (' + engineLine(started.info) + '). Call `docker_state` to see what it holds.'
          : started.message
        return { text: text, view: { ok: started.ok === true, started: started.started === true, plan: { kind: started.plan.kind, label: started.plan.label, hint: started.plan.hint }, waitedMs: started.waitedMs ?? 0, engine: started.info ?? before } }
      } catch (err) {
        return failureOf(err)
      }
    },
  }

  return [state, ps, images, inspect, logs, pull, run, action, start]
}
