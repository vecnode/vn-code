// check-docker-node.mjs - dsh-docker's own contract, driven directly.
//
// The tools in this row are a spawn, a set of parsers and a security boundary.
// The SPAWN is proved against a real process this check controls (`node -e`),
// so exit codes, stderr, the byte cap, the deadline and the tree kill are all
// exercised on any host. The ENGINE is proved with a SCRIPTED runner: every
// branch a container engine can present - no CLI, a daemon asleep, an engine up,
// a podman machine, a flat version payload - is a fixture here, so the suite
// runs on a machine with no docker at all.
//
// The LIVE half asks the machine's own docker for a read, and SKIPS LOUDLY when
// the daemon is not running (the normal state on Windows with Docker Desktop
// closed) instead of pretending it passed.
//
// Run:  node checks/check-docker-node.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { MAX_STREAM_BYTES, childEnv, clipText, firstLine, parseJson, parseJsonLines, runProcess } from '../lib/cli.js'
import { desktopAppPath, engineCandidates, engineInfo, parseVersionPayload, startEngine, startPlanFor } from '../lib/engine.js'
import {
  ACTIONS,
  actOn,
  buildRunArgv,
  containerIdOf,
  ensureEngine,
  inspectTarget,
  listContainers,
  listImages,
  logsOf,
  normalizeContainer,
  normalizeImage,
  pruneDangling,
  pullImage,
  runImage,
  stateView,
  summarizeInspect,
} from '../lib/docker.js'
import {
  commandToken,
  confirmMatches,
  envPair,
  imageRef,
  portSpec,
  sinceSpec,
  tailCount,
  targetRef,
  volumeSpec,
} from '../lib/validate.js'
import { buildTools } from '../lib/tools.js'
import { API_ROUTES, CAPABILITIES, PLUGIN_VERSION, __internals as row, createDeps, registerRoutes } from '../lib/index.js'

let checks = 0
let failures = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
const skip = (label, why) => {
  console.log('skip ' + label.padEnd(60) + why)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const clientSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
const API_ROOT = '/api/dsh-docker'

// ---------------------------------------------------------------------------
// The manifest and the surface
// ---------------------------------------------------------------------------
check('the package is a dsh bundle with a patch layer', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml')
check('the row declares its browser half', manifest.dsh.client && manifest.dsh.client.platform, 'web')
check('the row has no npm dependency', manifest.dependencies === undefined && manifest.peerDependencies === undefined, true)
check('the version constant is the package version', PLUGIN_VERSION, manifest.version)
check('nine tools are declared', CAPABILITIES.tools.length, 9)
check('eight routes are declared', API_ROUTES.length, 8)
check('the routes are exact paths under one root', API_ROUTES.every((route) => route.startsWith(API_ROOT + '/') && !route.includes('*')), true)
check('the capabilities name what is NOT built', CAPABILITIES.notBuilt.includes('exec') && CAPABILITIES.notBuilt.includes('system prune'), true)

// The client bundle is hand-written; these are the strings that make it a tab of
// this bar and of this host, and each would silently break the surface if it
// drifted.
check('the client is the docker tab type', clientSource.includes("const TYPE_ID = 'dsh-docker'") && clientSource.includes("const KIND = 'docker'"))
check('the client asks for the guide entry after History (40)', clientSource.includes('order: 40') && clientSource.includes("title: () => 'Docker'"))
check('the client registers the keyed seats', clientSource.includes('sidebar.right.pane.tab') && clientSource.includes('sidebar.right.pane.tab.title'))
check('the client API root is the host root', clientSource.includes("const API_ROOT = '/api/dsh-docker'"))
check(
  'every host route the tab calls has its client constant',
  API_ROUTES.filter((route) => route !== API_ROOT + '/health').every((route) => clientSource.includes("'" + route.slice(API_ROOT.length) + "'")),
  true,
)
check('the client renders no remote asset', /https?:\/\//.test(clientSource), false)
check('the client styles stay under its own prefix', clientSource.includes('.ddk-root{') && clientSource.includes('.ddk-toolbar') === false, true)

// ---------------------------------------------------------------------------
// Validation: the security boundary
// ---------------------------------------------------------------------------
check('a short container id passes', targetRef('a1b2c3d4e5f6').ok, true)
check('a full id passes', targetRef('a'.repeat(64)).ok, true)
check('a sha256 image id passes', targetRef('sha256:' + 'a'.repeat(64), { kind: 'image' }).ok, true)
check('a container name passes', targetRef('my-web_1').ok, true)
check('an id cannot begin with a dash', targetRef('--all').ok, false)
check('...and the refusal says why', /cannot start with "-"/.test(targetRef('-v').reason), true)
check('an id cannot carry whitespace', targetRef('web container').ok, false)
check('an image reference passes', imageRef('ghcr.io/org/app:1.2').ok, true)
check('an image reference with a digest passes', imageRef('alpine@sha256:' + 'b'.repeat(64)).ok, true)
check('an image cannot begin with a dash', imageRef('--rm').ok, false)
check('a port mapping passes', portSpec('8080:80').ok, true)
check('a loopback port passes', portSpec('127.0.0.1:8080:80/tcp').ok, true)
check('port 0 is refused', portSpec('8080:0').ok, false)
check('port 70000 is refused', portSpec('8080:70000').ok, false)
check('a named volume passes', volumeSpec('data:/var/lib/data').ok, true)
check('a windows host path passes', volumeSpec('C:\\work:/work:ro').ok, true)
check('a relative host path is refused', volumeSpec('./work:/work').ok, false)
check('an env pair is built once', envPair('POSTGRES_PASSWORD', 'dev').value, 'POSTGRES_PASSWORD=dev')
check('a bad env name is refused', envPair('bad name', 'x').ok, false)
check('a tail default is 200', tailCount(undefined).value, 200)
check('a tail past 2000 is refused', tailCount(2001).ok, false)
check('a duration is accepted', sinceSpec('15m').ok, true)
check('a nonsense duration is refused', sinceSpec('yesterday').ok, false)
check('a command token can be anything after the image', commandToken('--help').ok, true)
check('an empty command token is refused', commandToken('').ok, false)
check('confirm must repeat the target', confirmMatches('web', 'web') && confirmMatches('web2', 'web') === false && confirmMatches(undefined, 'web') === false, true)
check('the container verbs are the supported set', ACTIONS.container.join(','), 'start,stop,restart,pause,unpause,remove')
check('an image may only be removed', ACTIONS.image.join(','), 'remove')

// ---------------------------------------------------------------------------
// The runner, against a REAL process this check controls
// ---------------------------------------------------------------------------
{
  const okRun = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello")'])
  check('a real process runs and its stdout comes back', okRun.stdout, 'hello')
  check('...with exit code 0 and no error', okRun.code === 0 && okRun.error === '', true)

  const bad = await runProcess(process.execPath, ['-e', 'process.stderr.write("nope"); process.exit(3)'])
  check('a non-zero exit is code, not an error', bad.code, 3)
  check('...and its stderr is kept', bad.stderr.includes('nope'), true)

  const missing = await runProcess('definitely-not-a-binary-xyz', [])
  check('a missing program is an error, not a crash', /ENOENT|not found/i.test(missing.error), true)

  const capped = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBytes: 1000 })
  check('a stream is capped and says so', capped.stdout.length === 1000 && capped.truncated === true, true)

  const started = Date.now()
  const slow = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 400 })
  check('a call past its deadline is killed', slow.timedOut, true)
  check('...and does not hang the caller', Date.now() - started < 15000, true)
}

const child = childEnv({
  PATH: 'C:\\bin',
  DSH_HOME: 'secret',
  VNCODE_HOME: 'secret2',
  DOCKER_HOST: 'tcp://10.0.0.5:2375',
  DOCKER_CLI_HINTS: 'true',
})
check('the child env keeps PATH', child.PATH, 'C:\\bin')
check('...and the docker context variables', child.DOCKER_HOST, 'tcp://10.0.0.5:2375')
check('...and drops the harness markers', child.DSH_HOME === undefined && child.VNCODE_HOME === undefined, true)
check('...and forces the CLI hints off', child.DOCKER_CLI_HINTS, 'false')

check('JSON lines skip a warning line', parseJsonLines('WARNING: x\n{"ID":"a"}\n{"ID":"b"}').length, 2)
check('one JSON document is parsed around noise', parseJson('advice\n{"a":1}').a, 1)
check('a first line is the first non-empty one', firstLine('\n\n  bad news  \n'), 'bad news')
check('a clipped text says it was cut', clipText('abcdef', 3).includes('3 more characters'), true)
check('the stream cap is 1 MiB', MAX_STREAM_BYTES, 1048576)

// ---------------------------------------------------------------------------
// The engine, from fixtures
// ---------------------------------------------------------------------------
const DOCKER_UP = '{"Client":{"Version":"25.0.3","ApiVersion":"1.44","Context":"default"},"Server":{"Version":"25.0.3","ApiVersion":"1.44"}}'
const DOCKER_DOWN = '{"Client":{"Version":"25.0.3","ApiVersion":"1.44","Context":"default"},"Server":null}'
const PS_ROWS = [
  JSON.stringify({ ID: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', Names: 'web', Image: 'nginx:1.27', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:8080->80/tcp', CreatedAt: '2026-01-01 10:00:00 +0000 UTC' }),
  JSON.stringify({ ID: 'b2c3d4e5f6a1', Names: 'db', Image: 'postgres:16', State: 'exited', Status: 'Exited (0) 2 days ago', Ports: '5432/tcp', CreatedAt: '2026-01-02 10:00:00 +0000 UTC' }),
].join('\n')
const IMAGE_ROWS = [
  JSON.stringify({ ID: 'sha256:' + 'c'.repeat(64), Repository: 'nginx', Tag: '1.27', Digest: '<none>', Size: '192MB', CreatedAt: '2026-01-01', CreatedSince: '2 weeks ago', Containers: '1' }),
  JSON.stringify({ ID: 'sha256:' + 'd'.repeat(64), Repository: '<none>', Tag: '<none>', Digest: '<none>', Size: '7MB', CreatedAt: '2026-01-02', CreatedSince: '2 weeks ago', Containers: '0' }),
].join('\n')

/**
 * A runner that answers the docker commands from a table and records every call.
 *
 * It is the whole reason this suite does not need a daemon: each fixture is a
 * real answer a CLI can give, including the non-zero exits.
 */
function scripted(answers) {
  const calls = []
  const runner = async (file, argv, opts = {}) => {
    calls.push({ file: file, argv: argv.slice(), opts: opts })
    const key = file + ' ' + argv.join(' ')
    for (const entry of answers) {
      const matched = typeof entry.match === 'function' ? entry.match(file, argv) : key.startsWith(entry.match)
      if (!matched) continue
      const value = (typeof entry.result === 'function' ? entry.result({ file: file, argv: argv, calls: calls }) : entry.result) ?? {}
      return { file: file, argv: argv.slice(), code: 0, signal: '', stdout: '', stderr: '', timedOut: false, truncated: false, error: '', elapsedMs: 1, ...value }
    }
    return { file: file, argv: argv.slice(), code: 0, signal: '', stdout: '', stderr: '', timedOut: false, truncated: false, error: '', elapsedMs: 1 }
  }
  return { runner: runner, calls: calls }
}

const depsFor = (fixture, overrides = {}) =>
  createDeps(
    { get: () => undefined, effect: (fn) => fn(), logger: { info() {}, warn() {} } },
    {
      env: { PATH: 'C:\\bin', ProgramFiles: 'C:\\Program Files', DSH_DOCKER_CLI: 'docker' },
      platform: 'win32',
      runner: fixture.runner,
      sleep: async () => {},
      spawnDetached: () => ({ ok: true, pid: 42 }),
      exists: () => false,
      ...overrides,
    },
  )

const INSPECT_DOC = JSON.stringify([
  {
    Id: 'a1b2c3d4e5f6',
    Name: '/web',
    Image: 'sha256:' + 'f'.repeat(64),
    Created: '2026-01-01T10:00:00Z',
    State: { Status: 'running', Running: true, Paused: false, ExitCode: 0, StartedAt: '2026-01-01T10:00:01Z', FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { Cmd: ['nginx', '-g', 'daemon off;'], Entrypoint: ['/docker-entrypoint.sh'], Env: ['A=1', 'B=2'] },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'bridge' },
    NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { bridge: {} } },
    Mounts: [{ Source: 'C:\\work', Destination: '/work', RW: true }],
  },
])
const up = scripted([
  { match: 'docker --version', result: { stdout: 'Docker version 25.0.3, build abcdef\n' } },
  { match: 'docker version --format {{json .}}', result: { stdout: DOCKER_UP } },
  { match: 'docker ps', result: { stdout: PS_ROWS } },
  { match: 'docker images', result: { stdout: IMAGE_ROWS } },
  { match: 'docker logs', result: { stdout: 'line one\nline two\n', stderr: 'a warning\n' } },
  { match: 'docker inspect', result: { stdout: INSPECT_DOC } },
])
const upDeps = depsFor(up)
{
  const candidates = engineCandidates(depsFor(up, { env: { PATH: 'C:\\bin' } }))
  check('with no pin the candidates are docker then podman', candidates.map((c) => c.name).join(','), 'docker,podman')
  const info = await engineInfo(upDeps, candidates[0])
  check('an engine with a server object is up', info.daemon, 'up')
  check('...and its server version is read', info.serverVersion, '25.0.3')
  check('...and its context is read', info.context, 'default')
  const state = await stateView(upDeps, {})
  check('the state lists containers and images', state.ok === true && state.containers.length === 2 && state.images.length === 2, true)
  check('...counts what is running', state.counts.running, 1)
  check('...normalizes a container row', state.containers[0].name + ' ' + state.containers[0].running, 'web true')
  check('...and an untagged image by its short id', state.images[1].ref.length, 12)
}

const down = scripted([
  { match: 'docker --version', result: { stdout: 'Docker version 25.0.3, build abcdef\n' } },
  {
    match: 'docker version --format {{json .}}',
    result: { code: 1, stdout: DOCKER_DOWN, stderr: 'error during connect: open //./pipe/docker_engine: The system cannot find the file specified.\n' },
  },
])
const downDeps = depsFor(down, { exists: (candidate) => candidate.endsWith('Docker Desktop.exe') })
{
  const state = await stateView(downDeps, {})
  check('a CLI with a sleeping daemon is DOWN, not absent', state.code, 'ENGINE_DOWN')
  check('...the reason is the engine\'s own first line', state.message.includes('docker_engine'), true)
  check('...and the state still names the CLI version', state.engine.cliVersion, '25.0.3')
  const plan = await startPlanFor(downDeps, { name: 'docker', file: 'docker' })
  check('on Windows with Desktop installed the plan is the app', plan.kind, 'app')
  check('...and the app path is the one that exists', typeof plan.file === 'string' && plan.file.endsWith('Docker Desktop.exe'), true)
  let refused = null
  try {
    await ensureEngine(downDeps)
  } catch (err) {
    refused = err
  }
  check('every other call refuses with ENGINE_DOWN', refused !== null && refused.code, 'ENGINE_DOWN')
  check('...and the refusal names docker_start', refused !== null && refused.message.includes('docker_start'), true)
}

const absent = scripted([{ match: 'docker --version', result: { error: 'spawn docker ENOENT' } }])
{
  const deps = depsFor(absent)
  const state = await stateView(deps, {})
  check('no CLI at all is an ABSENT state', state.code, 'NO_CLI')
  check('...whose sentence names the install', state.message.includes('Docker Desktop') && state.message.includes('Podman'), true)
}

const podman = scripted([
  { match: 'podman --version', result: { stdout: 'podman version 4.9.3\n' } },
  { match: 'podman version --format {{json .}}', result: { stdout: '{"Version":"4.9.3","ApiVersion":"4.9.3"}' } },
  { match: 'podman machine list', result: { stdout: '{"Name":"podman-machine-default"}\n' } },
])
{
  const deps = depsFor(podman, { env: { PATH: 'C:\\bin', DSH_DOCKER_CLI: 'podman' }, platform: 'win32' })
  check('an explicit podman CLI is what is probed', (await engineCandidates(deps))[0].name, 'podman')
  const info = await engineInfo(deps, { name: 'podman', file: 'podman', version: '4.9.3' })
  check('a flat version payload is a LIVE podman', info.daemon, 'up')
  const plan = await startPlanFor(deps, { name: 'podman', file: 'podman' })
  check('a podman machine is what starts it', plan.kind + ' ' + plan.argv.join(' '), 'run machine start')
}

{
  const explicit = engineCandidates({ env: { DSH_DOCKER_CLI: 'C:\\tools\\podman.exe' } })[0]
  check('DSH_DOCKER_CLI pins a binary and reads its dialect from the name', explicit.name + ' ' + explicit.file, 'podman C:\\tools\\podman.exe')
  check('an unknown binary name is not a candidate', engineCandidates({ env: { DSH_DOCKER_CLI: 'nerdctl' } }).length, 0)
  const desktop = desktopAppPath({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => p.endsWith('Docker Desktop.exe') })
  check('the Windows Desktop path is found under ProgramFiles', desktop.endsWith(path.join('Docker', 'Docker', 'Docker Desktop.exe')), true)
  check('a platform with no Desktop has no path', desktopAppPath({ platform: 'linux', env: {}, exists: () => false }), '')
}

// The start: launch, then poll the DAEMON (not the app).
{
  let polls = 0
  const startFixture = scripted([
    { match: 'docker --version', result: { stdout: 'Docker version 25.0.3, build abcdef\n' } },
    {
      match: 'docker version --format {{json .}}',
      result: () => {
        polls += 1
        return polls < 3 ? { code: 1, stdout: DOCKER_DOWN, stderr: 'engine starting' } : { stdout: DOCKER_UP }
      },
    },
  ])
  const deps = depsFor(startFixture, { exists: (candidate) => candidate.endsWith('Docker Desktop.exe') })
  const launched = []
  deps.spawnDetached = (file, argv) => {
    launched.push({ file: file, argv: argv })
    return { ok: true, pid: 7 }
  }
  const result = await startEngine(deps, { name: 'docker', file: 'docker', version: '25.0.3' }, { waitMs: 60_000 })
  check('a start launches Docker Desktop', launched.length, 1)
  check('...and waits for the daemon to answer', result.ok, true)
  check('...reporting how long it took', typeof result.waitedMs, 'number')
}
{
  const noPlanDeps = depsFor(scripted([]), { platform: 'linux', exists: () => false })
  const plan = await startPlanFor(noPlanDeps, { name: 'docker', file: 'docker' })
  check('a Linux engine this plugin cannot start is a HINT', plan.kind === '' && plan.hint.includes('systemctl start docker'), true)
}

check('docker\'s Client/Server payload is split', parseVersionPayload(DOCKER_DOWN).server, null)
check('a flat payload is read as both sides', parseVersionPayload('{"Version":"4.9.3"}').client.Version, '4.9.3')

// ---------------------------------------------------------------------------
// The command surface
// ---------------------------------------------------------------------------
{
  const cli = { name: 'docker', file: 'docker' }
  const containers = await listContainers(upDeps, cli, { all: true })
  check('containers parse from JSON lines', containers.containers.length, 2)
  check('...a name drops a leading slash', normalizeContainer({ Names: '/web', State: 'running' }).name, 'web')
  check('...and a podman-shaped row still reads', normalizeContainer({ Id: 'a1b2c3d4e5f6', Name: 'pod', Image: 'x', State: 'Running' }).running, true)
  const images = await listImages(upDeps, cli, {})
  check('images parse from JSON lines', images.images.length, 2)
  check('...the untagged one is named by its id', normalizeImage({ ID: 'sha256:' + 'e'.repeat(64), Repository: '<none>', Tag: '<none>' }).ref.length, 12)

  const logs = await logsOf(upDeps, cli, { id: 'web', tail: 100 })
  check('logs keep the two streams apart', logs.text.includes('line one') && logs.text.includes('[stderr]') && logs.text.includes('a warning'), true)

  let missingInspect = null
  try {
    const blind = depsFor(
      scripted([
        { match: 'docker --version', result: { stdout: 'Docker version 25.0.3\n' } },
        { match: 'docker version --format {{json .}}', result: { stdout: DOCKER_UP } },
      ]),
    )
    await inspectTarget(blind, cli, { id: 'web' })
  } catch (err) {
    missingInspect = err
  }
  check('an empty inspect answer is a refusal, not a crash', missingInspect !== null && missingInspect.code, 'FAILED')
}

{
  const fixture = scripted([
    { match: 'docker --version', result: { stdout: 'Docker version 25.0.3\n' } },
    { match: 'docker version --format {{json .}}', result: { stdout: DOCKER_UP } },
    { match: 'docker inspect', result: { stdout: INSPECT_DOC } },
  ])
  const deps = depsFor(fixture)
  const found = await inspectTarget(deps, { name: 'docker', file: 'docker' }, { id: 'web' })
  check('inspect summarizes a container', found.kind, 'container')
  check('...its ports are the published ones', found.facts.ports[0], '8080 -> 80/tcp')
  check('...its restart policy is read', found.facts.restart, 'unless-stopped')
  check('...and its mounts are one string each', found.facts.mounts[0], 'C:\\work:/work')
  const imageDoc = JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), RepoTags: ['nginx:1.27'], RepoDigests: ['nginx@sha256:' + 'a'.repeat(64)], Architecture: 'amd64', Os: 'linux', Size: 192_000_000, Created: '2026-01-01', Config: { Cmd: ['nginx'], Env: [] } }])
  check('an image inspect is told apart by its tags', summarizeInspect(JSON.parse(imageDoc)[0]).kind, 'image')
}

{
  const fixture = scripted([
    { match: 'docker --version', result: { stdout: 'Docker version 25.0.3\n' } },
    { match: 'docker version --format {{json .}}', result: { stdout: DOCKER_UP } },
    { match: 'docker pull', result: { stdout: '', stderr: 'Status: Downloaded newer image for alpine:3.20\n', elapsedMs: 2400 } },
    { match: 'docker run', result: { stdout: 'a1b2c3d4e5f6\n' } },
    { match: 'docker stop', result: { stdout: 'web\n' } },
    { match: 'docker rm', result: { stdout: 'web\n' } },
    { match: 'docker rmi', result: { stdout: 'Untagged: nginx:1.27\n' } },
    { match: 'docker container prune', result: { stdout: 'Total reclaimed space: 12MB\n' } },
  ])
  const deps = depsFor(fixture)
  const cli = { name: 'docker', file: 'docker' }
  const pulled = await pullImage(deps, cli, { image: 'alpine:3.20' })
  check('a pull reports the engine text', pulled.text.includes('Downloaded newer image'), true)
  const started = await runImage(deps, cli, { image: 'nginx:1.27', name: 'web', ports: ['8080:80'], env: { A: '1' }, volumes: ['data:/data'], remove: true })
  check('a run reports the new id', started.id, 'a1b2c3d4e5f6')
  check('...and the id is read off the last line', containerIdOf('noise\na1b2c3d4e5f6\n'), 'a1b2c3d4e5f6')
  let refused = null
  try {
    await actOn(deps, cli, { action: 'remove', kind: 'container', id: 'web' })
  } catch (err) {
    refused = err
  }
  check('a removal without confirm is refused', refused !== null && refused.code, 'CONFIRM_REQUIRED')
  let wrong = null
  try {
    await actOn(deps, cli, { action: 'remove', kind: 'container', id: 'web', confirm: 'other' })
  } catch (err) {
    wrong = err
  }
  check('a removal with the wrong confirm is refused', wrong !== null && wrong.code, 'CONFIRM_REQUIRED')
  const before = fixture.calls.length
  const removed = await actOn(deps, cli, { action: 'remove', kind: 'container', id: 'web', confirm: 'web' })
  check('a removal with the right confirm runs', removed.action, 'remove')
  check('...as `rm`, which is the engine\'s own verb', fixture.calls[before].argv.join(' '), 'rm web')
  const stopped = await actOn(deps, cli, { action: 'stop', id: 'web' })
  check('a stop runs the stop verb', stopped.text.includes('web'), true)
  const pruned = await pruneDangling(deps, cli, { kind: 'container', confirm: 'prune' })
  check('a prune needs the word prune', pruned.kind, 'container')
  let noPrune = null
  try {
    await pruneDangling(deps, cli, { kind: 'container', confirm: 'yes' })
  } catch (err) {
    noPrune = err
  }
  check('...and refuses anything else', noPrune !== null && noPrune.code, 'CONFIRM_REQUIRED')
}

// The argv the run schema produces: every dangerous flag has no spelling.
{
  const argv = buildRunArgv({ image: 'postgres:16', name: 'db', ports: ['127.0.0.1:5432:5432'], env: { POSTGRES_PASSWORD: 'dev' }, volumes: ['db-data:/var/lib/postgresql/data'], command: ['postgres', '-c', 'max_connections=200'] }).argv
  check('a run argv starts with run -d', argv.slice(0, 2).join(' '), 'run -d')
  check('...carries name, port, env and volume', argv.includes('--name') && argv.includes('127.0.0.1:5432:5432') && argv.includes('POSTGRES_PASSWORD=dev') && argv.includes('db-data:/var/lib/postgresql/data'), true)
  check('...puts the command after the image', argv.indexOf('postgres:16') < argv.indexOf('-c'), true)
  check('...and has no privileged or host-pid spelling', argv.includes('--privileged') || argv.includes('--pid'), false)
  let badVolume = null
  try {
    buildRunArgv({ image: 'alpine', volumes: ['./here:/there'] })
  } catch (err) {
    badVolume = err
  }
  check('a relative host path is refused by the run schema', badVolume !== null && badVolume.code, 'BAD_ARG')
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------
{
  const tools = buildTools(upDeps)
  check('nine tools are built', tools.length, 9)
  check('...and they are the declared ones', tools.map((tool) => tool.name).join(','), CAPABILITIES.tools.join(','))
  check('...each with the register shape', tools.every((tool) => typeof tool.name === 'string' && typeof tool.execute === 'function' && tool.parameters !== undefined), true)
  const byName = (name) => tools.find((tool) => tool.name === name)
  const state = await byName('docker_state').execute({})
  check('docker_state answers with the engine line', state.text.includes('Engine: docker 25.0.3'), true)
  check('...and a view a caller can branch on', state.view.ok, true)
  const ps = await byName('docker_ps').execute({})
  check('docker_ps answers with a table', ps.text.includes('NAME') && ps.text.includes('web'), true)
  const logs = await byName('docker_logs').execute({ id: 'web' })
  check('docker_logs says how many lines it read', logs.text.includes('lines'), true)
}

{
  const tools = buildTools(downDeps)
  const byName = (name) => tools.find((tool) => tool.name === name)
  const ps = await byName('docker_ps').execute({})
  check('a tool on a sleeping engine refuses in one sentence', ps.view.ok === false && ps.view.code, 'ENGINE_DOWN')
  const noCli = buildTools(depsFor(absent)).find((tool) => tool.name === 'docker_start')
  const started = await noCli.execute({})
  check('docker_start with no CLI names the install', started.view.code, 'NO_CLI')
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------
{
  const registered = new Map()
  const ctx = {
    get: (name) => (name === 'connection' ? { fetch: { register: (route) => (registered.set(route.path, route), () => registered.delete(route.path)) } } : undefined),
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  }
  const deps = createDeps(ctx, { env: { DSH_DOCKER_CLI: 'docker' }, platform: 'win32', runner: up.runner, exists: () => false, sleep: async () => {} })
  const dispose = registerRoutes(deps)
  check('every route is registered', [...registered.keys()].sort().join(','), API_ROUTES.slice().sort().join(','))
  const call = async (route, init) => {
    const pathOnly = route.split('?')[0]
    const handler = registered.get(pathOnly)
    if (handler === undefined) throw new Error('route not registered: ' + pathOnly)
    const response = await handler.fetch(new Request('http://x' + route, init))
    return { status: response.status, body: await response.json() }
  }
  const state = await call('/api/dsh-docker/state')
  check('GET /state answers 200 with the containers', state.status === 200 && state.body.containers.length, 2)
  const logs = await call('/api/dsh-docker/logs?id=web&tail=10')
  check('GET /logs answers with the text', logs.status === 200 && logs.body.text.includes('line one'), true)
  const inspect = await call('/api/dsh-docker/inspect?id=web')
  check('GET /inspect answers with facts', inspect.status, 200)
  const health = await call('/api/dsh-docker/health')
  check('GET /health names the plugin and its caps', health.body.plugin === 'dsh-docker' && health.body.tools.length, 9)
  const action = await call('/api/dsh-docker/action', { method: 'POST', body: JSON.stringify({ action: 'stop', id: 'web' }) })
  check('POST /action runs a lifecycle verb', action.status === 200 && action.body.action, 'stop')
  const removeWithout = await call('/api/dsh-docker/action', { method: 'POST', body: JSON.stringify({ action: 'remove', id: 'web' }) })
  check('POST /action refuses a removal with no confirm', removeWithout.status === 400 && removeWithout.body.error.code, 'CONFIRM_REQUIRED')
  const pull = await call('/api/dsh-docker/pull', { method: 'POST', body: JSON.stringify({ image: 'alpine:3.20' }) })
  check('POST /pull answers the image', pull.status, 200)
  const run = await call('/api/dsh-docker/run', { method: 'POST', body: JSON.stringify({ image: 'alpine:3.20' }) })
  check('POST /run answers the new id', run.status, 200)
  const bad = await call('/api/dsh-docker/action', { method: 'POST', body: 'not json' })
  check('a bad body is a typed 400', bad.status === 400 && bad.body.error.code, 'BAD_JSON')
  dispose()
  check('the disposer unregisters everything', registered.size, 0)
}

{
  const registered = new Map()
  const ctx = {
    get: (name) => (name === 'connection' ? { fetch: { register: (route) => (registered.set(route.path, route), () => {}) } } : undefined),
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  }
  const deps = createDeps(ctx, { env: { DSH_DOCKER_CLI: 'docker' }, platform: 'win32', runner: absent.runner, exists: () => false })
  registerRoutes(deps)
  const response = await registered.get('/api/dsh-docker/state').fetch(new Request('http://x/api/dsh-docker/state'))
  const body = await response.json()
  check('a route on a machine with no CLI answers ok:false, not 500', response.status === 200 && body.ok === false && body.code, 'NO_CLI')
}

// ---------------------------------------------------------------------------
// The live machine: read-only, and honest when the daemon is asleep
// ---------------------------------------------------------------------------
{
  const liveDeps = createDeps(
    { get: () => undefined, effect: (fn) => fn(), logger: { info() {}, warn() {} } },
    { env: process.env, platform: process.platform, runner: runProcess, exists: () => false },
  )
  const cli = await row.detectCli(liveDeps)
  if (cli === null) {
    skip('the live read', '(no docker or podman on this machine - the fixtures above are the whole contract here)')
  } else {
    const info = await row.engineInfo(liveDeps, cli)
    if (info.daemon !== 'up') {
      skip('the live read', '(' + cli.name + ' is installed but its daemon is not answering: ' + (info.reason || 'no reason given') + ')')
    } else {
      const state = await stateView(liveDeps, {})
      check('the live engine answers a state read', state.ok, true)
      check('...with an array of containers', Array.isArray(state.containers), true)
      check('...and an array of images', Array.isArray(state.images), true)
      const target = state.containers[0]
      if (target === undefined) {
        skip('the live logs read', '(this engine holds no container to read)')
      } else {
        const logs = await logsOf(liveDeps, cli, { id: target.id, tail: 20 })
        check('...and one container\'s logs are readable', typeof logs.text === 'string' && logs.lines >= 0, true)
      }
    }
  }
}

console.log('')
console.log(failures === 0 ? 'all ' + checks + ' docker checks passed' : failures + ' of ' + checks + ' docker checks FAILED')
process.exitCode = failures === 0 ? 0 : 1
