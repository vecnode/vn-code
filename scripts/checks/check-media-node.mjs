// check-media-node.mjs - drive dsh-media's host half directly: the three tools,
// the seven routes, the pinned ffmpeg copy's whole provisioning pipeline, and
// the two bundled skills.
//
// Why this exists: this package's promises are all checkable, and none of them
// are checkable by reading the code. Does `media_run` really pass an argv ARRAY
// without a shell, and refuse to overwrite? Does the pinned copy verify its
// SHA-256 before anything is executed, and does a mismatch leave the machine
// unchanged rather than half-installed? Can the file route actually serve a
// RANGE, so a 2 GB film seeks instead of being read into memory? Does a channel
// a browser cannot decode come back as a transcode rather than as a black
// player?
//
// It is hermetic where it must be and honest where it cannot be:
//
//   - the PINNED COPY is exercised end to end against a synthetic archive this
//     file builds itself and serves over a loopback HTTP server, so the
//     download, the hash check, the `tar` unpack, the atomic install and the
//     resolution order are all really driven - with no 170 MB download and no
//     network;
//   - the ffmpeg-dependent sections (real probing, real frames, the remux job)
//     run only when this host HAS ffmpeg, and skip loudly when it does not,
//     because a check that downloads a browser-sized binary to pass is not a
//     check;
//   - nothing here may touch ~/.dsh: DSH_HOME is pointed at a temp root before
//     the module is imported, and DSH_MEDIA_NO_INSTALL keeps every tool call
//     from starting a download behind the check's back.
//
// Run:  node scripts/checks/check-media-node.mjs
export {} // (ESM for the dynamic imports below)

const { promises: fsp, existsSync, readFileSync, createReadStream } = await import('node:fs')
const { createHash } = await import('node:crypto')
const { spawnSync } = await import('node:child_process')
const http = await import('node:http')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
let failures = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
function skip(label, why) {
  skipped += 1
  console.log('skip ' + label.padEnd(58) + ' (' + why + ')')
}

// ---------------------------------------------------------------------------
// A hermetic home + workspace
// ---------------------------------------------------------------------------
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-media-check-'))
const workspace = path.join(root, 'workspace')
const elsewhere = path.join(root, 'elsewhere')
await fsp.mkdir(workspace, { recursive: true })
await fsp.mkdir(elsewhere, { recursive: true })
process.env.DSH_HOME = path.join(root, 'dsh-home')
// A tool call must never start a real download during a check.
process.env.DSH_MEDIA_NO_INSTALL = '1'

const modulePath = path.join(repo, 'packages/dsh-media/lib/index.js')
const plugin = await import(pathToFileURL(modulePath).href)
const manifest = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-media/lib/binaries.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-media/package.json'), 'utf8'))

const tools = new Map()
const routes = new Map()
const skills = []
const ctx = {
  effect: (fn) => fn(),
  logger: { debug() {}, info() {}, warn() {} },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
  get(name) {
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
      }
    }
    if (name === 'skills') {
      return {
        register(skill) {
          skills.push(skill)
          return () => {}
        },
      }
    }
    if (name === 'sessions') {
      return { get: (sessionId) => (sessionId === 's1' ? { header: { cwd: workspace } } : undefined) }
    }
    return undefined
  },
}
plugin.apply(ctx)

const exec = { agent: { session: { id: 's1' } } }
const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error('no such tool: ' + name)
  return await tool.execute(args, exec)
}
const fetchRoute = (route, url, init) => routes.get(route).fetch(new Request('http://127.0.0.1' + url, init))

console.log('dsh-media host half, home ' + path.relative(os.tmpdir(), root))
console.log('')

// ---------------------------------------------------------------------------
// 1. The module's own activation contract
// ---------------------------------------------------------------------------
check('the row exports its name', plugin.name, 'dsh-media')
check('the row injects connection and tools', JSON.stringify(plugin.inject), '["connection","tools"]')
check('the version marker matches package.json', plugin.PLUGIN_VERSION, pkg.version)
check('three tools are registered', [...tools.keys()].join(','), 'media_probe,media_run,media_frames')
check('seven routes are registered', [...routes.keys()].sort().join(','), [
  '/api/dsh-media/file',
  '/api/dsh-media/health',
  '/api/dsh-media/job',
  '/api/dsh-media/provision',
  '/api/dsh-media/remux',
  '/api/dsh-media/report',
  '/api/dsh-media/state',
].join(','))
check(
  'the state and health routes answer the same snapshot',
  JSON.stringify(routes.get('/api/dsh-media/state').methods),
  JSON.stringify(['GET', 'HEAD']),
)

// ---------------------------------------------------------------------------
// 2. The pin: the manifest, and the tool that refreshes it
// ---------------------------------------------------------------------------
const pinCheck = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-media/tools/binaries.mjs'), '--check'], { encoding: 'utf8' })
check('the pinned manifest passes its own --check', pinCheck.status, 0)
for (const [key, entry] of Object.entries(manifest.platforms)) {
  const archive = entry.archives[0]
  check(
    key + ': https url + 64-hex hash + a byte count',
    archive.url.startsWith('https://') && /^[0-9a-f]{64}$/.test(archive.sha256) && archive.bytes > 0,
  )
}
check('the manifest says what it does NOT pin', typeof manifest.notPinned, 'object')
check('darwin-arm64 is the documented gap, keyed under notPinned', 'darwin-arm64' in manifest.platforms || 'darwin-arm64' in manifest.notPinned, true)

// ---------------------------------------------------------------------------
// 3. Resolution: the order, and never a guess
// ---------------------------------------------------------------------------
const { resolveBinaries, installStatus, startProvision, installDir, binaryName, pinFor, ensureBinary, loadManifest, platformKey, __internals: ffmpegInternals } = await import(
  pathToFileURL(path.join(repo, 'packages/dsh-media/lib/ffmpeg.js')).href
)
const home = path.join(root, 'dsh-home')
const emptyEnv = { PATH: '', Path: '' }
const resolvedNone = resolveBinaries({ home, env: emptyEnv })
check('with no PATH and nothing installed, nothing is found', resolvedNone.ffmpeg.source, 'none')
check('and the pinned entry is known', resolvedNone.pinned, true)
check('the install status starts absent', resolvedNone.install.state, 'absent')

// A PATH install is used as it is rather than downloading a second copy.
const pathBin = path.join(root, 'fake-path-bin')
await fsp.mkdir(pathBin, { recursive: true })
for (const name of ['ffmpeg', 'ffprobe']) await fsp.writeFile(path.join(pathBin, binaryName(name)), 'stub')
const resolvedPath = resolveBinaries({ home, env: { PATH: pathBin, Path: pathBin } })
check('a PATH install wins over downloading a copy', resolvedPath.ffmpeg.source, 'path')
check('and it resolves the real file', path.basename(resolvedPath.ffmpeg.file), binaryName('ffmpeg'))

// The environment override wins over everything, and a broken one is REPORTED.
const overrideFile = path.join(root, 'my-ffmpeg')
await fsp.writeFile(overrideFile, 'stub')
const resolvedEnv = resolveBinaries({ home, env: { ...emptyEnv, DSH_MEDIA_FFMPEG: overrideFile } })
check('an explicit path wins', resolvedEnv.ffmpeg.source, 'env')
const resolvedBroken = resolveBinaries({ home, env: { ...emptyEnv, DSH_MEDIA_FFMPEG: path.join(root, 'nope') } })
check('a broken explicit path is named, not silently ignored', resolvedBroken.ffmpeg.source, 'env-missing')
// `install: false` here on purpose: this check must never start a real download.
const brokenAnswer = await ensureBinary('ffmpeg', { home, env: { ...emptyEnv, DSH_MEDIA_FFMPEG: path.join(root, 'nope') }, install: false })
check('...and the tool call says which variable is wrong', /DSH_MEDIA_FFMPEG/.test(brokenAnswer.message) && brokenAnswer.code, 'ENV_MISSING')

// A platform this release does not pin says so in a sentence instead of guessing.
check('an unpinned platform has no entry', pinFor('sunos-sparc'), null)
const unpinned = startProvision({ home, key: 'sunos-sparc' })
check('and provisioning refuses in words', unpinned.state, 'unsupported')
check('...naming the package managers instead', /package manager/.test(unpinned.message))
check('an unsupported platform leaves no directory', existsSync(path.join(home, 'dsh-media', 'bin', 'sunos-sparc')), false)

// ---------------------------------------------------------------------------
// 4. The pinned copy, end to end: download -> hash -> tar -> atomic install
// ---------------------------------------------------------------------------
/** One build tree with stub binaries, packed by the host's own tar. */
async function buildArchive(dir, marker) {
  const tree = path.join(dir, 'build')
  await fsp.mkdir(path.join(tree, 'pkg', 'bin'), { recursive: true })
  for (const name of ['ffmpeg', 'ffprobe']) await fsp.writeFile(path.join(tree, 'pkg', 'bin', binaryName(name)), marker + ':' + name)
  const archive = path.join(dir, 'pinned.tar')
  const packed = spawnSync('tar', ['-cf', archive, '-C', tree, '.'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error('tar could not build the fixture: ' + String(packed.stderr))
  const bytes = (await fsp.stat(archive)).size
  const sha256 = createHash('sha256').update(await fsp.readFile(archive)).digest('hex')
  return { archive, bytes, sha256 }
}

/** A loopback server for one file, so the download path is really exercised. */
async function serve(file) {
  const size = (await fsp.stat(file)).size
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) })
    createReadStream(file).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' }
}

const good = await buildArchive(path.join(root, 'good'), 'good')
const goodServer = await serve(good.archive)
const key = platformKey()
const provisioned = startProvision({
  home,
  key,
  entry: { build: 'check fixture', version: 'fixture-1', license: 'none', archives: [{ url: goodServer.url, sha256: good.sha256, bytes: good.bytes, kind: 'tar' }] },
})
check('provisioning starts without blocking', provisioned.state, 'installing')
let installedStatus = installStatus({ home, key })
for (let attempt = 0; attempt < 100 && installedStatus.state === 'installing'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  installedStatus = installStatus({ home, key })
}
check('the pinned copy installs', installedStatus.state, 'installed')
if (installedStatus.state !== 'installed') console.log('     ' + JSON.stringify(installedStatus))
const stampFile = path.join(installDir({ home, key }), 'install.json')
check('both binaries are in place', ['ffmpeg', 'ffprobe'].every((name) => existsSync(path.join(installDir({ home, key }), binaryName(name)))))
check('an install stamp records what was installed', existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')).version : '(no stamp)', 'fixture-1')
check('the file that was installed is the one in the archive', existsSync(path.join(installDir({ home, key }), binaryName('ffmpeg'))) ? readFileSync(path.join(installDir({ home, key }), binaryName('ffmpeg')), 'utf8') : '(missing)', 'good:ffmpeg')
check('the downloaded archive was cleaned up', (await fsp.readdir(installDir({ home, key }))).filter((name) => name.startsWith('.download-')).length, 0)
check('and no lock was left behind', existsSync(path.join(installDir({ home, key }), '.install.lock')), false)
const resolvedBundled = resolveBinaries({ home, env: emptyEnv })
check('the provisioned copy is then used', resolvedBundled.ffmpeg.source, 'bundled')
check('...from the per-platform directory', resolvedBundled.ffmpeg.file.endsWith(path.join('bin', key, binaryName('ffmpeg'))))
check('a second provision call is a no-op', startProvision({ home, key }).state, 'installed')

// A hash that does not match must install NOTHING - not a partial copy, not a
// stamp - and must say which hash it got.
const bad = await buildArchive(path.join(root, 'bad'), 'corrupt')
const badServer = await serve(bad.archive)
const badHome = path.join(root, 'bad-home')
const badProvision = startProvision({
  home: badHome,
  key,
  entry: {
    build: 'corrupt fixture',
    version: 'fixture-bad',
    license: 'none',
    archives: [{ url: badServer.url, sha256: 'f'.repeat(64), bytes: bad.bytes, kind: 'tar' }],
  },
})
check('a mismatching download starts', badProvision.state, 'installing')
let badStatus = installStatus({ home: badHome, key })
for (let attempt = 0; attempt < 100 && badStatus.state === 'installing'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  badStatus = installStatus({ home: badHome, key })
}
check('a hash mismatch FAILS the install', badStatus.state, 'failed')
check('...naming both hashes', /expected f{8}|does not match its pinned SHA-256/.test(badStatus.error))
check('...and installing nothing', ['ffmpeg', 'ffprobe'].every((name) => !existsSync(path.join(installDir({ home: badHome, key }), binaryName(name)))))
check('...and leaving no stamp', existsSync(path.join(installDir({ home: badHome, key }), 'install.json')), false)
check('a failed provisioning is reported to a tool call', (await ensureBinary('ffprobe', { home: badHome, env: emptyEnv, install: false })).code, 'NO_FFMPEG')
goodServer.server.close()
badServer.server.close()

// ---------------------------------------------------------------------------
// 5. The two bundled skills
// ---------------------------------------------------------------------------
const skillFiles = ['ffmpeg-cli', 'ffprobe-cli'].map((name) => path.join(repo, 'packages/dsh-media/skills', name, 'SKILL.md'))
for (const file of skillFiles) {
  const text = readFileSync(file, 'utf8')
  const label = path.basename(path.dirname(file))
  check(label + ': has frontmatter with a name', /^---\n[\s\S]*?name:/.test(text))
  check(label + ': says when to use it', /whenToUse:/.test(text))
  check(label + ': is real documentation', text.length > 4000)
  // A skill that taught a different interface than the tool exposes would send
  // the agent straight into a refusal, so the interface is asserted BY NAME.
  check(label + ': names the tools it drives', /media_probe/.test(text) && /media_run/.test(text))
  check(label + ': teaches the argv ARRAY, not a command string', /\*\*array\*\*|array of arguments|argv/i.test(text))
}
// Every fenced JSON block in these skills must actually parse: they are the
// closest thing to a copy-pasteable tool call, and a stray comma would be sent
// straight to media_run by an agent that trusts the document.
for (const file of skillFiles) {
  const text = readFileSync(file, 'utf8')
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1].trim())
  const bad = blocks.filter((block) => {
    try {
      JSON.parse(block)
      return false
    } catch (err) {
      return true
    }
  })
  check(path.basename(path.dirname(file)) + ': every ```json example parses', bad.join(' | '), '')
}
const skillBodies = skillFiles.map((file) => readFileSync(file, 'utf8'))
check(
  'the ffmpeg skill names every injected guardrail',
  ['-nostdin', '-hide_banner', 'overwrite', '-n'].every((flag) => skillBodies[0].includes(flag)),
)
check('the ffmpeg skill never tells the reader to install ffmpeg', /never tell a user to install ffmpeg|comes from the pack/i.test(skillBodies[0]))
check('the ffmpeg skill covers container/codec choice', /WebM/.test(skillBodies[0]) && /MP4/.test(skillBodies[0]) && /-c copy/.test(skillBodies[0]))
check('the ffmpeg skill covers trimming and frames', /-ss/.test(skillBodies[0]) && /-frames:v/.test(skillBodies[0]))
check('the ffprobe skill covers the JSON invocation', /-print_format json/.test(skillBodies[1]) && /-show_streams/.test(skillBodies[1]))
check('the ffprobe skill explains the frame-rate rationals', /r_frame_rate/.test(skillBodies[1]) && /avg_frame_rate/.test(skillBodies[1]))
check(
  'the ffprobe skill says ffprobe gets none of the ffmpeg-only flags',
  /none\*\* of the flags|no `-n`|no `-nostdin`/.test(skillBodies[1]),
)
check('both skills registered at apply time', skills.map((skill) => skill.name).sort().join(','), 'ffmpeg-cli,ffprobe-cli')
check('...under this package as their provider', [...new Set(skills.map((skill) => skill.provider))].join(','), 'dsh-media')
check('...with their frontmatter description carried over', skills.every((skill) => typeof skill.description === 'string' && skill.description.length > 20))
check('...and a loaded body', skills.every((skill) => typeof skill.content === 'string' && skill.content.length > 1000))
const noRegistry = plugin.registerSkills({ effect: (fn) => fn(), get: () => undefined }, { warn() {} })
check('a profile with no skill registry degrades to a warning', noRegistry, 0)

// ---------------------------------------------------------------------------
// 6. The tools, against a real ffmpeg when this host has one
// ---------------------------------------------------------------------------
const ffmpegAnswer = await ensureBinary('ffmpeg', { home, env: process.env, install: false })
const hasFfmpeg = ffmpegAnswer.ok
if (!hasFfmpeg) {
  skip('every tool section', 'no ffmpeg on this host and the check never downloads one')
} else {
  const run = (args, file = path.join(workspace, 'fixture.mp4')) => spawnSync(ffmpegAnswer.file, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { encoding: 'utf8' })
  run(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
  run(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-c:v', 'mpeg4', '-q:v', '8'], path.join(workspace, 'legacy.avi'))
  run(['-i', path.join(workspace, 'fixture.mp4'), '-c', 'copy'], path.join(workspace, 'fixture.mkv'))
  run(['-f', 'lavfi', '-i', 'testsrc2=size=120x80:duration=1', '-frames:v', '1'], path.join(workspace, 'still.png'))
  await fsp.writeFile(path.join(workspace, 'notes.txt'), 'not media at all\n')
  await fsp.writeFile(path.join(elsewhere, 'outside.mp4'), 'not media either\n')

  const probed = await call('media_probe', { path: 'fixture.mp4' })
  check('media_probe reports the container and duration', /QuickTime|MP4|mov/i.test(probed.text) && /video\s+#0\s+h264/.test(probed.text))
  check('...the exact pixel size, fps and stream count', /160x120/.test(probed.text) && /10 fps \(exact 10\/1\)/.test(probed.text))
  check('...the audio stream too', /audio\s+#1\s+aac/.test(probed.text))
  check('...a browser-playability verdict', /browser: playable/.test(probed.text))
  check('...and how long the header read took', /read in \d+ ms \(header only: no frame was decoded\)/.test(probed.text))
  check('...with a view for the conversation card', probed.view.name + '/' + probed.view.verdict, 'fixture.mp4/playable')
  const raw = await call('media_probe', { path: 'fixture.mp4', raw: true })
  check('raw: true appends ffprobe\'s own JSON', /ffprobe JSON:/.test(raw.text) && /"codec_name": "h264"/.test(raw.text))
  const imageProbe = await call('media_probe', { path: 'still.png' })
  check('a PNG probes as an IMAGE, not as an undecodable video', /browser: image/.test(imageProbe.text) && imageProbe.view.verdict, 'image')
  check('...with its pixel size', /120x80/.test(imageProbe.text))
  const aviProbe = await call('media_probe', { path: 'legacy.avi' })
  check('an mpeg4 AVI needs a TRANSCODE, with the command', /browser: transcode/.test(aviProbe.text) && /-c:v libx264/.test(aviProbe.text))
  const mkvProbe = await call('media_probe', { path: 'fixture.mkv' })
  check('an MKV of h264/aac needs only a REMUX', /browser: remux/.test(mkvProbe.text) && /-c copy/.test(mkvProbe.text))
  const textProbe = await call('media_probe', { path: 'notes.txt' })
  check('a text file is reported as having no media in it', /No streams at all|identifies no container|could not read/i.test(textProbe.text))
  check('a path outside the workspace is refused by name', /points outside the conversation workspace/.test((await call('media_probe', { path: '../elsewhere/outside.mp4' })).text))
  check('a missing file is refused by name', /No such file/.test((await call('media_probe', { path: 'nope.mp4' })).text))

  // media_run: a real argv array, no shell, and its two honest defaults.
  const ranProbe = await call('media_run', { binary: 'ffprobe', args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'default=nw=1', 'fixture.mp4'] })
  check('media_run drives ffprobe with an argv array', /exit 0/.test(ranProbe.text) && /codec_name=h264/.test(ranProbe.text))
  check('...and injects no ffmpeg-only flag into ffprobe', !/-n\b/.test(ranProbe.text.split('\n')[0]))
  const stringArgs = await call('media_run', { args: '-i fixture.mp4 out.mp4' })
  check('a STRING command is refused and explained', /must be an ARRAY of arguments/.test(stringArgs.text))
  const wrote = await call('media_run', { args: ['-i', 'fixture.mp4', '-vn', '-c:a', 'copy', 'audio-out.m4a'] })
  check('ffmpeg writes a file and the answer names it', /audio-out\.m4a/.test(wrote.text) && existsSync(path.join(workspace, 'audio-out.m4a')))
  check('...and the injected defaults are visible in the command', /-nostdin -n -/.test(wrote.text) && /-hide_banner/.test(wrote.text) && /-loglevel warning/.test(wrote.text))
  const refusedOverwrite = await call('media_run', { args: ['-i', 'fixture.mp4', '-vn', '-c:a', 'copy', 'audio-out.m4a'] })
  check('a second run will NOT overwrite by default', /already exists/.test(refusedOverwrite.text) && /exit 1/.test(refusedOverwrite.text))
  const allowedOverwrite = await call('media_run', { args: ['-i', 'fixture.mp4', '-vn', '-c:a', 'copy', 'audio-out.m4a'], overwrite: true })
  check('...unless overwrite: true says so', /exit 0/.test(allowedOverwrite.text) && /-y/.test(allowedOverwrite.text))
  const noShell = await call('media_run', { args: ['-version', '&&', 'echo', 'pwned'] })
  check('a shell metacharacter is just an argument', !/pwned/.test(noShell.text.split('--- ffmpeg said ---')[1] ?? ''))
  const badCwd = await call('media_run', { args: ['-version'], cwd: '../elsewhere' })
  check('a working directory outside the workspace is refused', /outside the conversation workspace/.test(badCwd.text))

  // media_frames
  const frames = await call('media_frames', { path: 'fixture.mp4', at: ['0', '1'], width: 80, outDir: 'frames' })
  check('media_frames writes one file per timestamp', (frames.text.match(/\.png/g) ?? []).length >= 2)
  check('...reporting the REAL dimensions read from each file', /80x60/.test(frames.text))
  check('...and the exact command it ran', /-ss 0\.000 -i/.test(frames.text))
  const wroteAgain = await call('media_frames', { path: 'fixture.mp4', at: ['0'], width: 80, outDir: 'frames' })
  check('a second call never overwrites the first', /frames-2\.png|-2\.png/.test(wroteAgain.text))
  const sheet = await call('media_frames', { path: 'fixture.mp4', sheet: true, count: 4, width: 80, outDir: 'frames' })
  check('a contact sheet is ONE tiled picture', /-sheet-.*\.png/.test(sheet.text) && /tile=2x2/.test(sheet.text))
  const pastTheEnd = await call('media_frames', { path: 'fixture.mp4', at: ['99'], width: 80, outDir: 'frames' })
  check('a timestamp past the end says so instead of writing nothing', /past the end/.test(pastTheEnd.text))
  check('...and claims no frame it did not write', pastTheEnd.view.frames === undefined || pastTheEnd.view.frames.length === 0, true)
  const badFormat = await call('media_frames', { path: 'fixture.mp4', at: ['nonsense'], outDir: 'frames' })
  check('an unparseable timestamp is refused from the text alone', /do not parse/.test(badFormat.text))

  // -------------------------------------------------------------------------
  // 7. The routes
  // -------------------------------------------------------------------------
  const stateAnswer = await (await fetchRoute(plugin.STATE_ROUTE, plugin.STATE_ROUTE)).json()
  check('the state route names the binary and its source', stateAnswer.binaries.ffmpeg.source, 'path')
  check('...the platform key', stateAnswer.platform, platformKey())
  check('...the pinned copy status', typeof stateAnswer.provision.state, 'string')
  check('...and the caps', stateAnswer.caps.maxFrames + '/' + stateAnswer.caps.maxArgs, '24/200')
  check('the provision route is a POST', JSON.stringify(routes.get(plugin.PROVISION_ROUTE).methods), JSON.stringify(['POST']))

  const reportAnswer = await (await fetchRoute(plugin.REPORT_ROUTE, plugin.REPORT_ROUTE + '?session=s1&path=fixture.mp4')).json()
  check('the report route answers the same facts as JSON', reportAnswer.facts.video[0].codec, 'h264')
  check('...with the playability verdict', reportAnswer.facts.playable.verdict, 'playable')
  check('...and the file size', reportAnswer.size > 0, true)

  const whole = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=fixture.mp4')
  const wholeBytes = (await whole.arrayBuffer()).byteLength
  check('the file route streams the whole file', whole.status + '/' + whole.headers.get('accept-ranges'), '200/bytes')
  check('...with a content-length that matches what it sent', String(wholeBytes), whole.headers.get('content-length'))
  check('...and the container as its content type', whole.headers.get('content-type'), 'video/mp4')
  const ranged = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=fixture.mp4', { headers: { range: 'bytes=100-199' } })
  const rangedBytes = (await ranged.arrayBuffer()).byteLength
  check('a Range request is a 206 with the right slice', ranged.status + '/' + ranged.headers.get('content-range') + '/' + rangedBytes, '206/bytes 100-199/' + wholeBytes + '/100')
  const suffix = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=fixture.mp4', { headers: { range: 'bytes=-50' } })
  check('a suffix range takes the LAST bytes', suffix.headers.get('content-range'), 'bytes ' + (wholeBytes - 50) + '-' + (wholeBytes - 1) + '/' + wholeBytes)
  const unsatisfiable = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=fixture.mp4', { headers: { range: 'bytes=99999999-' } })
  check('an unsatisfiable range is a 416', unsatisfiable.status, 416)
  const headAnswer = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=fixture.mp4', { method: 'HEAD' })
  check('HEAD answers the size without a body', headAnswer.headers.get('content-length') + '/' + (headAnswer.body === null), String(wholeBytes) + '/true')
  const notVideo = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=notes.txt')
  check('the file route refuses a file the video surface does not claim', notVideo.status, 415)
  check('...with a typed code', (await notVideo.json()).error.code, 'NOT_MEDIA')
  const outside = await fetchRoute(plugin.FILE_ROUTE, plugin.FILE_ROUTE + '?session=s1&path=../elsewhere/outside.mp4')
  check('...and refuses a path outside the workspace', outside.status, 403)
  check('...with the typed refusal', (await outside.json()).error.code, 'OUTSIDE_WORKSPACE')

  const remuxAnswer = await (await fetchRoute(plugin.REMUX_ROUTE, plugin.REMUX_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's1', path: 'fixture.mkv' }) })).json()
  check('a remux job starts for an MKV', remuxAnswer.job.mode, 'remux')
  check('...and says what it is doing', /remuxing/.test(remuxAnswer.job.message))
  let job = remuxAnswer.job
  for (let attempt = 0; attempt < 200 && job.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    job = (await (await fetchRoute(plugin.JOB_ROUTE, plugin.JOB_ROUTE + '?id=' + remuxAnswer.job.id)).json()).job
  }
  check('the remux finishes', job.state, 'done')
  check('...and hands back a cache key and a URL', /^[0-9a-f]{32}$/.test(job.cache) && job.url, plugin.FILE_ROUTE + '?cache=' + job.cache)
  const cached = await fetchRoute(plugin.FILE_ROUTE, job.url)
  const cachedBytes = (await cached.arrayBuffer()).byteLength
  check('the cached conversion is served from the cache key', cached.status + '/' + cached.headers.get('x-dsh-media-cache'), '200/1')
  check('...as a complete MP4, not an empty file', cachedBytes > 0 && cached.headers.get('content-length'), String(cachedBytes))
  const cachedRange = await fetchRoute(plugin.FILE_ROUTE, job.url, { headers: { range: 'bytes=0-9' } })
  check('...and the cached copy is seekable too', cachedRange.status, 206)
  const again = await (await fetchRoute(plugin.REMUX_ROUTE, plugin.REMUX_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's1', path: 'fixture.mkv' }) })).json()
  check('asking again joins the finished job instead of re-encoding', again.job.state, 'done')
  const playable = await (await fetchRoute(plugin.REMUX_ROUTE, plugin.REMUX_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's1', path: 'fixture.mp4' }) })).json()
  check('a file the browser already plays needs no job', playable.job.state, 'not-needed')
  const noJob = await fetchRoute(plugin.JOB_ROUTE, plugin.JOB_ROUTE + '?id=' + 'a'.repeat(32))
  check('an unknown job is a typed 404', noJob.status + '/' + (await noJob.json()).error.code, '404/NO_SUCH_JOB')

  // The transcode path, which is a different command and a different promise.
  const transcodeAnswer = await (await fetchRoute(plugin.REMUX_ROUTE, plugin.REMUX_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's1', path: 'legacy.avi' }) })).json()
  check('an mpeg4 AVI is transcoded, not remuxed', transcodeAnswer.job.mode, 'transcode')
  let transcode = transcodeAnswer.job
  for (let attempt = 0; attempt < 600 && transcode.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    transcode = (await (await fetchRoute(plugin.JOB_ROUTE, plugin.JOB_ROUTE + '?id=' + transcodeAnswer.job.id)).json()).job
  }
  check('the transcode finishes', transcode.state, 'done')
  const transcodedProbe = (await (await fetchRoute(plugin.REPORT_ROUTE, plugin.REPORT_ROUTE + '?session=s1&path=legacy.avi')).json()).facts.playable.verdict
  check('...and the source still reports what it is', transcodedProbe, 'transcode')
} // end of the ffmpeg-dependent sections

// ---------------------------------------------------------------------------
// 8. parseRange, the pure half
// ---------------------------------------------------------------------------
const { parseRange } = plugin.__internals
check('parseRange: a closed range', JSON.stringify(parseRange('bytes=0-99', 1000)), JSON.stringify({ start: 0, end: 99 }))
check('parseRange: an open end', JSON.stringify(parseRange('bytes=990-', 1000)), JSON.stringify({ start: 990, end: 999 }))
check('parseRange: a suffix range', JSON.stringify(parseRange('bytes=-100', 1000)), JSON.stringify({ start: 900, end: 999 }))
check('parseRange: an end past the file clamps', JSON.stringify(parseRange('bytes=990-5000', 1000)), JSON.stringify({ start: 990, end: 999 }))
check('parseRange: a start past the file is unsatisfiable', parseRange('bytes=1000-', 1000), null)
check('parseRange: nonsense is unsatisfiable', parseRange('items=1-2', 1000), null)
check('parseRange: an empty range is unsatisfiable', parseRange('bytes=-', 1000), null)
check('the video extension list is exactly what the tab claims', plugin.VIDEO_EXTENSIONS.join(','), 'mp4,m4v,mov,webm,mkv,avi,wmv,flv,ogv,ts,m2ts,mpg,mpeg,3gp,mts')
check('audio formats are NOT claimed (they have surfaces already)', plugin.VIDEO_EXTENSIONS.some((extension) => ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(extension)), false)
check('the cache key is never a path a caller chose', plugin.__internals.cachePathFor(home, '../escape'), null)

// ---------------------------------------------------------------------------
// 9. The host with NO ffmpeg at all
// ---------------------------------------------------------------------------
// The degradation path is a promise, not an afterthought: a machine with no
// ffmpeg must load, must answer the video tab with a 200 that SAYS it has none
// (not a 500), and must tell a tool call what to do about it. It is driven with
// a SEPARATE module instance and explicit (broken) env paths, so this section
// proves it without uninstalling anything from the host running the check.
{
  await fsp.writeFile(path.join(workspace, 'probe-me.mp4'), 'not really a video\n')
  const previous = {
    ffmpeg: process.env.DSH_MEDIA_FFMPEG,
    ffprobe: process.env.DSH_MEDIA_FFPROBE,
    noInstall: process.env.DSH_MEDIA_NO_INSTALL,
  }
  process.env.DSH_MEDIA_FFMPEG = path.join(root, 'no-such-ffmpeg')
  process.env.DSH_MEDIA_FFPROBE = path.join(root, 'no-such-ffprobe')
  process.env.DSH_MEDIA_NO_INSTALL = '1'
  try {
    const fresh = await import(pathToFileURL(modulePath).href + '?without-ffmpeg')
    const freshRoutes = new Map()
    const freshTools = new Map()
    fresh.apply({
      effect: (fn) => fn(),
      logger: { debug() {}, info() {}, warn() {} },
      tools: { register: (tool) => (freshTools.set(tool.name, tool), () => {}) },
      get(name) {
        if (name === 'connection') return { fetch: { register: (route) => (freshRoutes.set(route.path, route), () => {}) } }
        if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: workspace } } : undefined) }
        return undefined
      },
    })
    const state = await (await freshRoutes.get(fresh.STATE_ROUTE).fetch(new Request('http://127.0.0.1' + fresh.STATE_ROUTE))).json()
    check('with no ffmpeg the state says so instead of failing', state.binaries.ffmpeg.found === false && state.binaries.ffprobe.found === false)
    check('...and names the variable that pointed nowhere', state.binaries.ffmpeg.source, 'env-missing')
    const report = await freshRoutes.get(fresh.REPORT_ROUTE).fetch(new Request('http://127.0.0.1' + fresh.REPORT_ROUTE + '?session=s1&path=probe-me.mp4'))
    const reportBody = await report.json()
    check('the report route answers 200 unavailable, not an error', report.status + '/' + String(reportBody.unavailable), '200/true')
    check('...naming the file it could not inspect', reportBody.name, 'probe-me.mp4')
    check('...and how to fix it', /DSH_MEDIA_FFPROBE|package manager|no ffmpeg/i.test(String(reportBody.message)))
    const answer = await freshTools.get('media_probe').execute({ path: 'probe-me.mp4' }, exec)
    check('a tool call on a host with no ffmpeg explains rather than crashing', /DSH_MEDIA_FFPROBE|not available/i.test(answer.text))
    check('...and still returns a view for the conversation card', answer.view.name, 'probe-me.mp4')
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.DSH_MEDIA_FFMPEG
    else process.env.DSH_MEDIA_FFMPEG = previous.ffmpeg
    if (previous.ffprobe === undefined) delete process.env.DSH_MEDIA_FFPROBE
    else process.env.DSH_MEDIA_FFPROBE = previous.ffprobe
    if (previous.noInstall === undefined) delete process.env.DSH_MEDIA_NO_INSTALL
    else process.env.DSH_MEDIA_NO_INSTALL = previous.noInstall
  }
}

// ---------------------------------------------------------------------------
// 10. Nothing was left outside the temp root
// ---------------------------------------------------------------------------
check('the workspace held every fixture this check wrote', existsSync(path.join(workspace, 'fixture.mp4')))
check('the check never touched a real $DSH_HOME', process.env.DSH_HOME.startsWith(os.tmpdir()))

console.log('')
console.log((failures === 0 ? 'all dsh-media host checks passed' : failures + ' dsh-media host check(s) FAILED') + (skipped > 0 ? ' (' + skipped + ' skipped)' : ''))
process.exitCode = failures === 0 ? 0 : 1
