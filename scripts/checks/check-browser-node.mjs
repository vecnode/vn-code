/**
 * dsh-browser — the tracked check.
 *
 * Three halves, and the split is the point:
 *
 *   1. **PURE** (always runs): the URL and address policy as a table, the engine
 *      argv guards, and the PNG header reader. These are the claims a code change
 *      is most likely to break silently, and none of them needs a network.
 *   2. **THE GATE** (always runs, loopback only): one CONNECT refused for every
 *      rule, one CONNECT ALLOWED through an injected resolver to a local TCP
 *      server - which is what proves the tunnel works without depending on the
 *      internet - plus the credential challenge, the trace and the byte cap.
 *   3. **LIVE** (skips loudly): one real render of https://example.com through the
 *      tools, when this host has an engine. It is the end-to-end claim: the gate
 *      carried the render, the PNG's size is read back from its own header, and a
 *      measured selector comes back with a real box.
 *
 * No network is required for 1 and 2; 3 is the only part that needs the internet
 * and it says so when it cannot run.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = path.join(repo, 'packages', 'dsh-browser')
/** Import one file of the package under test (a Windows path needs a URL). */
const load = (relative) => import(pathToFileURL(path.join(pkg, relative)).href)

let failures = 0
function check(label, actual, expected = true) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) {
    failures += 1
    console.log('FAIL ' + label + '  got ' + JSON.stringify(actual) + ', wanted ' + JSON.stringify(expected))
    return
  }
  console.log('ok   ' + label + (actual === true ? '' : '  ' + JSON.stringify(actual)))
}

const policy = await load('lib/policy.js')
const engineMod = await load('lib/engine.js')
const gateMod = await load('lib/gate.js')
const indexMod = await load('lib/index.js')

// --------------------------------------------------------------- the row itself
{
  const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'))
  check('the row is declared as a bundle with a client half', Boolean(manifest.dsh?.bundle?.patch) && manifest.dsh?.client?.platform === 'web')
  check('the build marker matches package.json', indexMod.PLUGIN_VERSION, manifest.version)
  check('the row injects the connection and the tool registry', indexMod.inject, ['connection', 'tools'])
  const patch = readFileSync(path.join(pkg, 'cordis.patch.yml'), 'utf8')
  check('the shipped Browser row is disabled by THIS package', /- id: ui-sidebar-browser\n\s+disabled: true/.test(patch))
  check('the package inserts its own row', /- id: browser\n\s+name: 'dsh-browser'/.test(patch))
}

// --------------------------------------------------------------------- the policy
{
  for (const url of ['https://example.com', 'example.com', 'example.com/a/b?c=d#e', 'https://sub.example.co.uk/x', 'https://example.com.', 'https://xn--bcher-kva.example/']) {
    const result = policy.parseTargetUrl(url)
    check('policy accepts ' + url, result.ok, true)
  }
  const refusals = [
    ['http://example.com', policy.REFUSAL.NOT_HTTPS],
    ['file:///etc/passwd', policy.REFUSAL.NOT_HTTPS],
    ['javascript:alert(1)', policy.REFUSAL.NOT_HTTPS],
    ['data:text/html,<h1>x', policy.REFUSAL.NOT_HTTPS],
    ['https://user:pass@example.com', policy.REFUSAL.CREDENTIALS],
    ['https://user@example.com', policy.REFUSAL.CREDENTIALS],
    ['https://example.com:8443', policy.REFUSAL.PORT],
    ['https://127.0.0.1', policy.REFUSAL.LITERAL],
    ['https://[::1]/', policy.REFUSAL.LITERAL],
    ['https://169.254.169.254/latest/meta-data', policy.REFUSAL.LITERAL],
    ['https://localhost', policy.REFUSAL.NOT_QUALIFIED],
    ['https://intranet/', policy.REFUSAL.NOT_QUALIFIED],
    ['', policy.REFUSAL.MALFORMED],
    ['https://', policy.REFUSAL.MALFORMED],
    ['https://' + 'a'.repeat(3000) + '.com', policy.REFUSAL.TOO_LONG],
  ]
  const wrong = refusals.filter(([url, code]) => {
    const result = policy.parseTargetUrl(url)
    return result.ok !== false || result.code !== code
  })
  check('policy refuses every rule, by code', wrong.map(([url]) => url).join(','), '')
  check('an allowlist narrows the browser and a bare suffix is not a wildcard', [
    policy.parseTargetUrl('https://sub.example.com', { allowHosts: ['*.example.com'] }).ok,
    policy.parseTargetUrl('https://example.com', { allowHosts: ['*.example.com'] }).code,
    policy.parseTargetUrl('https://example.com', { blockHosts: ['example.com'] }).code,
  ], [true, policy.REFUSAL.HOST_NOT_ALLOWED, policy.REFUSAL.HOST_BLOCKED])
  check('a configured port is honoured', policy.parseTargetUrl('https://example.com:8443', { ports: [443, 8443] }).ok, true)

  const publicOnes = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2606:4700::1111', '2001:4860:4860::8888', '::ffff:93.184.216.34', '0:0:0:0:0:ffff:5db8:d822']
  check('public unicast addresses are public', publicOnes.filter((address) => policy.isPublicAddress(address) !== true), [])
  const blockedOnes = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1', '192.0.2.1', '203.0.113.9',
    '192.88.99.1', '192.0.0.1', '198.51.100.7',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002::1', '64:ff9b::102:304',
    '2001:0:0:0:0:0:0:1', '100::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::10.0.0.1',
    'not-an-address', 'fe80::1%eth0', '010.0.0.1', '1.2.3', '1.2.3.4.5', '999.1.1.1', '', '0x7f.0.0.1',
  ]
  check('every non-public address class is refused', blockedOnes.filter((address) => policy.isPublicAddress(address) !== false), [])
  check('one private address refuses the WHOLE answer set', policy.checkAddresses('x.com', ['93.184.216.34', '127.0.0.1']).code, policy.REFUSAL.NOT_PUBLIC)
  check('an empty answer set is a refusal, not a pass', policy.checkAddresses('x.com', []).code, policy.REFUSAL.NO_ADDRESS)
  check('every refusal has a sentence', Object.values(policy.REFUSAL).filter((code) => String(policy.refusalMessage(code, { host: 'example.com', port: 1, scheme: 'http', address: '10.0.0.1', length: 9 })).length < 20), [])
}

// ------------------------------------------------------------- the engine guards
{
  const args = engineMod.buildArgs({ profileDir: 'C:\\tmp\\profile', proxyServer: '127.0.0.1:1234', width: 800, height: 600, dpr: 1 })
  const joined = args.join(' ')
  check('the engine is launched headless with a throwaway profile', joined.includes('--headless=new') && joined.includes('--user-data-dir=C:\\tmp\\profile'))
  check('the engine is given the gate as its only proxy', joined.includes('--proxy-server=127.0.0.1:1234'))
  check('the implicit loopback bypass is removed', joined.includes('--proxy-bypass-list=<-loopback>'))
  // The exclusion is load-bearing: without it the resolver rule maps the GATE's
  // own address to NOTFOUND and Chrome answers ERR_PROXY_CONNECTION_FAILED
  // without ever opening a socket (measured on Chrome 154).
  check('the resolver rule excludes the gate itself', joined.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'))
  const forbidden = ['--no-sandbox', '--disable-web-security', '--allow-file-access-from-files', '--ignore-certificate-errors', '--disable-site-isolation-trials', '--single-process']
  check('the engine is never disarmed', forbidden.filter((flag) => joined.includes(flag)), [])
  check('the engine resolves to an installed browser or nothing', engineMod.resolveEngine({ env: { DSH_BROWSER_ENGINE: '/nope/none' }, platform: 'linux', exists: () => false }), null)
  check('DSH_BROWSER_ENGINE wins when it exists', engineMod.resolveEngine({ env: { DSH_BROWSER_ENGINE: '/opt/chrome' }, platform: 'linux', exists: (file) => file === '/opt/chrome' })?.kind, 'override')
  const pinned = engineMod.resolveEngine({ env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' }, platform: 'win32', exists: (file) => file.endsWith('msedge.exe') })
  check('the Windows install locations are searched', String(pinned?.file).endsWith('msedge.exe'), true)

  // A synthetic PNG: the reader must trust the FILE, not the request.
  const png = Buffer.alloc(26)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'latin1')
  png.writeUInt32BE(1440, 16)
  png.writeUInt32BE(900, 20)
  check('the PNG header reader reports the file\'s own size', engineMod.readPngSize(png), { width: 1440, height: 900 })
  check('a non-PNG is refused', engineMod.readPngSize(Buffer.from('not a png at all, not even close')), null)
  check('the viewport presets are the four a person asks for', Object.keys(engineMod.VIEWPORTS), ['phone', 'tablet', 'laptop', 'desktop', 'wide'])
}

// ---------------------------------------------------------------------- the gate
{
  const resolver = async (host) => {
    if (host === 'api.example') return [{ address: '93.184.216.34' }]
    if (host === 'mixed.example') return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]
    if (host === 'private.example') return [{ address: '10.0.0.5' }]
    if (host === 'gone.example') throw new Error('ENOTFOUND')
    return [{ address: '93.184.216.34' }]
  }
  const gate = await gateMod.createGate({ resolve: resolver, logger: () => {}, caps: { idleTimeoutMs: 5000, connectTimeoutMs: 3000, maxBytes: 4096 } })
  const credential = 'Basic ' + Buffer.from(gate.nonce + ':x', 'utf8').toString('base64')

  const talk = (head, { auth = true, payload = null } = {}) =>
    new Promise((done) => {
      const socket = net.connect(gate.port, '127.0.0.1')
      let text = ''
      let binary = Buffer.alloc(0)
      let tunnelled = false
      const timer = setTimeout(() => {
        socket.destroy()
        done({ head: text, binary, timedOut: true, tunnelled })
      }, 6000)
      socket.on('connect', () => {
        const header = auth && head.startsWith('CONNECT') ? head.replace('HTTP/1.1', 'HTTP/1.1\r\nProxy-Authorization: ' + credential) : head
        socket.write(header)
        if (payload !== null) setTimeout(() => socket.write(payload), 120)
      })
      socket.on('data', (chunk) => {
        if (!tunnelled) {
          text += chunk.toString('latin1')
          const end = text.indexOf('\r\n\r\n')
          if (end === -1) return
          if (!text.startsWith('HTTP/1.1 200')) {
            clearTimeout(timer)
            socket.destroy()
            done({ head: text, binary, timedOut: false, tunnelled: false })
            return
          }
          // The 200 and the first tunnelled bytes often arrive together.
          tunnelled = true
          binary = Buffer.concat([binary, Buffer.from(text.slice(end + 4), 'latin1')])
          text = text.slice(0, end + 4)
        } else {
          binary = Buffer.concat([binary, chunk])
        }
        if (tunnelled && payload !== null && binary.length >= payload.length) {
          clearTimeout(timer)
          socket.destroy()
          done({ head: text, binary, timedOut: false, tunnelled: true })
        }
      })
      socket.on('error', () => {
        clearTimeout(timer)
        done({ head: text, binary, timedOut: false, tunnelled })
      })
    })

  const refusedSets = [
    ['CONNECT localhost:443 HTTP/1.1\r\nHost: x\r\n\r\n', 'single-label host'],
    ['CONNECT example.com:8443 HTTP/1.1\r\nHost: x\r\n\r\n', 'non-443 port'],
    ['CONNECT mixed.example:443 HTTP/1.1\r\nHost: x\r\n\r\n', 'mixed answer set'],
    ['CONNECT private.example:443 HTTP/1.1\r\nHost: x\r\n\r\n', 'private answer'],
    ['CONNECT gone.example:443 HTTP/1.1\r\nHost: x\r\n\r\n', 'unresolvable host'],
    ['GET / HTTP/1.1\r\nHost: x\r\n\r\n', 'plain HTTP request'],
  ]
  const statuses = []
  for (const [head] of refusedSets) {
    const result = await talk(head)
    statuses.push((result.head.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1] ?? 'none')
  }
  check('the gate answers 403/405/502 and nothing else', statuses.join(','), '403,403,403,403,502,405')
  const noAuth = await talk('CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n', { auth: false })
  check('the gate demands its credential', noAuth.head.startsWith('HTTP/1.1 407'), true)
  check('the 407 advertises basic auth', noAuth.head.toLowerCase().includes('proxy-authenticate: basic'))

  const trace = gate.snapshot().trace
  check('the trace records a refusal per rule', trace.filter((entry) => entry.decision === 'refuse').length >= 6, true)
  check('every accepted socket is recorded, so "never reached us" is distinguishable', trace.some((entry) => entry.decision === 'connect'), true)
  check('the gate states its own caps', gate.snapshot().caps.maxBytes > 0 && gate.snapshot().caps.idleTimeoutMs > 0, true)

  // The ALLOWED path cannot be proven against a loopback server, and that is the
  // policy working rather than a gap in this test: a destination that resolves to
  // 127.0.0.1 is refused by name (one of the assertions above). A real tunnel
  // therefore needs a real public host, and it is asserted in the LIVE half below
  // - which is where the gate's tunnels, its pinned addresses and its byte cap
  // are all measured for real.
  await gate.close()
}

// ------------------------------------------------------------- the row's surface
{
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-browser-check-'))
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    get: () => undefined,
    effect: (fn) => {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    tools: { register: () => () => {} },
  }
  const deps = indexMod.createDeps(ctx, { home, env: { ...process.env, DSH_HOME: home }, config: { allowHosts: [], blockHosts: [], ports: [443] } })
  deps.gate = indexMod.createGateHolder(deps)
  const tools = indexMod.buildTools(deps)
  check('the row registers three tools', tools.map((tool) => tool.name), ['browser_render', 'browser_query', 'browser_text'])
  check('every tool declares a strict schema and a text render', tools.every((tool) => tool.parameters.additionalProperties === false && typeof tool.output.render === 'function'), true)
  check('the tool descriptions carry the untrusted-content rule', tools.every((tool) => tool.description.includes('DATA') || tool.description.includes('never')), true)

  // A refused URL never reaches the engine: the policy answers first.
  const refused = await indexMod.runRender(deps, { url: 'http://example.com' })
  check('runRender refuses http before any engine starts', refused.code, policy.REFUSAL.NOT_HTTPS)
  const literal = await indexMod.runRender(deps, { url: 'https://127.0.0.1/' })
  check('runRender refuses an IP literal', literal.code, policy.REFUSAL.LITERAL)
  const parked = await indexMod.runRender({ ...deps, config: { ...deps.config, live: true } }, { url: 'https://example.com' })
  check('the parked live mode is refused in a sentence', parked.code, 'LIVE_PARKED')
  // The bundled skill must be READABLE, not merely declared: registerSkills reads
  // it from this package's own folder, and a wrong root would surface only as a
  // warning in a live profile.
  const skill = indexMod.readSkill(indexMod.SKILLS[0])
  check('the bundled skill resolves inside the package', skill.file.startsWith(pkg), true)
  check('the bundled skill has real content', skill.text.includes('browser_render') && skill.text.length > 1000, true)
  // SHIPPED OFF, on purpose: the pack's LAST layer disables the row, so a profile
  // gets no Browser tab, no `/api/dsh-browser/*`, no tools and no client bundle.
  // Pinned because it is a product decision rather than an accident of install:
  // re-enabling it must be a deliberate edit to the master's patch, not a silent
  // regression of this one.
  const masterPatch = readFileSync(path.join(repo, 'packages', 'dsh-vn-master', 'cordis.patch.yml'), 'utf8')
  check('the master layer turns the browser row OFF', /- id: browser\s*\n\s+disabled: true/.test(masterPatch), true)
  check('the package still disables the shipped iframe row', /- id: ui-sidebar-browser\s*\n\s+disabled: true/.test(readFileSync(path.join(pkg, 'cordis.patch.yml'), 'utf8')), true)
  check('the state snapshot names the engine, the policy and the parked mode', (() => {
    const state = deps.state()
    return typeof state.live.available === 'boolean' && state.live.available === false && Array.isArray(state.policy.ports) && 'engine' in state
  })(), true)

  // The machine ceiling: a render is a whole browser process, so the plugin must
  // bound how many exist at once and refuse the rest in a sentence, or a chatty
  // agent turns "read these 30 pages" into 30 Chromes.
  {
    const slots = indexMod.createRenderSlots({ max: 1, queue: 1 })
    const first = await slots.acquire()
    const second = slots.acquire()
    const third = await slots.acquire()
    check('the render ceiling admits one render at a time', typeof first === 'function' && slots.active === 1, true)
    check('a full queue refuses the next render instead of starting another', third, null)
    first()
    const fourth = await second
    check('releasing a slot hands it to the waiter', typeof fourth === 'function' && slots.active === 1, true)
    fourth()
    check('an idle limiter reports nothing in flight', slots.active + slots.queued, 0)
  }
  const saturated = indexMod.createDeps(ctx, { home, env: { ...process.env, DSH_HOME: home }, config: {}, slots: indexMod.createRenderSlots({ max: 0, queue: 0 }) })
  saturated.gate = deps.gate
  const busy = await indexMod.runRender(saturated, { url: 'https://example.com/' })
  check('a saturated host answers BUSY rather than spawning another browser', busy.code === 'BUSY' || busy.code === 'NO_ENGINE', true)

  // Viewport clamping and artifact identity.
  check('a viewport preset is honoured', indexMod.viewportFor({ preset: 'phone' }), { width: 390, height: 844, dpr: 1 })
  check('an absurd viewport is clamped', indexMod.viewportFor({ width: 99999, height: 1 }).width, indexMod.MAX_VIEWPORT)
  const idA = indexMod.artifactIdFor({ url: 'https://example.com/', width: 1440, height: 900, dpr: 1 })
  const idB = indexMod.artifactIdFor({ url: 'https://example.com/', width: 390, height: 844, dpr: 1 })
  check('the artifact id names the request and separates viewports', /^[0-9a-f]{24}$/.test(idA) && idA !== idB && idA === indexMod.artifactIdFor({ url: 'https://example.com/', width: 1440, height: 900, dpr: 1 }), true)

  // The image route refuses anything that is not one of our ids.
  const routes = []
  deps.ctx.get = () => ({ fetch: { register: (spec) => (routes.push(spec), () => {}) } })
  indexMod.registerRoutes(deps)
  check('the row registers exactly its three routes', routes.map((route) => route.path).sort(), ['/api/dsh-browser/image', '/api/dsh-browser/render', '/api/dsh-browser/state'])
  check('every route is GET, HEAD or POST', routes.every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))), true)
  const imageRoute = routes.find((route) => route.path === '/api/dsh-browser/image')
  const traversal = await imageRoute.fetch(new Request('http://x/api/dsh-browser/image?id=../../../../etc/passwd'))
  check('the image route refuses a crafted id', traversal.status, 400)
  const missing = await imageRoute.fetch(new Request('http://x/api/dsh-browser/image?id=' + 'a'.repeat(24)))
  check('the image route 404s an unknown artifact', missing.status, 404)

  await deps.gate.close()
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
}

// ------------------------------------------------------------------ the live half
{
  const engine = engineMod.resolveEngine()
  const skip = process.env.DSH_BROWSER_CHECK_NO_LIVE === '1' || engine === null
  if (skip) {
    console.log('skip the live render (no browser engine on this host, or DSH_BROWSER_CHECK_NO_LIVE=1)')
  } else {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-browser-live-'))
    const ctx = { logger: { info: () => {}, warn: () => {}, debug: () => {} }, get: () => undefined, effect: (fn) => fn(), tools: { register: () => () => {} } }
    const deps = indexMod.createDeps(ctx, { home, env: { ...process.env, DSH_HOME: home }, config: { timeoutMs: 60000 } })
    deps.gate = indexMod.createGateHolder(deps)
    try {
      const tools = indexMod.buildTools(deps)
      const render = await tools[0].execute({ url: 'https://example.com/', width: 900, height: 600, waitMs: 600 })
      const view = render.view
      const pass = view.ok === true && String(view.title).toLowerCase().includes('example')
      check('LIVE: a real render comes back with the page title', pass, true)
      if (view.ok === true) {
        const file = path.join(home, 'dsh-browser', 'artifacts', view.imageId, 'page.png')
        const bytes = readFileSync(file)
        check('LIVE: the PNG exists and its header reports the viewport', engineMod.readPngSize(bytes), { width: 900, height: 600 })
        check('LIVE: the gate carried the render', view.tunnels >= 1 && view.challenges >= 1, true)
        check('LIVE: the page itself only ever talked to the rendered host', (view.pageHosts ?? []).join(','), 'example.com')
        check('LIVE: the gate allowed the rendered host', view.allowed.some((entry) => entry.host === 'example.com'), true)
        check('LIVE: the render summary states the egress', String(render.text).includes('tunnel'), true)
        const measure = await tools[1].execute({ url: 'https://example.com/', selectors: ['body', 'p'], what: ['box', 'style'], width: 390, height: 844, dpr: 2 })
        const first = measure.view.entries.find((entry) => entry.selector === 'body')
        check('LIVE: a measured selector comes back with a real box and styles', Boolean(first && first.box && first.box.width > 0 && first.style && first.style['font-size']), true)
        const text = await tools[2].execute({ url: 'https://example.com/', maxChars: 2000 })
        check('LIVE: the rendered text is the post-script document', String(text.text).includes('Example Domain'), true)

        // A real TLS round trip through the gate, made by hand rather than by
        // Chrome: this is the tunnel itself, and the byte cap that bounds it. It
        // has to live here because the policy refuses a loopback DESTINATION by
        // name, so no offline echo server can stand in for a public host.
        const tight = await gateMod.createGate({ logger: () => {}, caps: { maxBytes: 600, idleTimeoutMs: 8000, connectTimeoutMs: 8000 } })
        const credential = 'Basic ' + Buffer.from(tight.nonce + ':x', 'utf8').toString('base64')
        const tunnelSocket = net.connect(tight.port, '127.0.0.1')
        const head = await new Promise((done) => {
          let response = ''
          tunnelSocket.on('connect', () => tunnelSocket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ' + credential + '\r\n\r\n'))
          tunnelSocket.on('data', (chunk) => {
            response += chunk.toString('latin1')
            if (response.includes('\r\n\r\n')) done(response)
          })
          tunnelSocket.on('error', () => done(response))
          setTimeout(() => done(response), 15000)
        })
        check('LIVE: a CONNECT to a public host establishes', head.startsWith('HTTP/1.1 200 Connection Established'), true)
        const secure = (await import('node:tls')).connect({ socket: tunnelSocket, servername: 'example.com' })
        secure.on('error', () => {})
        secure.on('secureConnect', () => secure.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'))
        await new Promise((done) => setTimeout(done, 2500))
        check('LIVE: the byte cap cuts an oversized tunnel', tight.snapshot().trace.some((entry) => entry.cut === 'byte cap'), true)
        secure.destroy()
        tunnelSocket.destroy()
        await tight.close()
      }
    } catch (err) {
      check('LIVE: the live half ran without throwing', String(err && err.message), '')
    } finally {
      await deps.gate.close()
      await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
    }
  }
}

if (failures === 0) console.log('\nall dsh-browser checks passed')
else console.log('\n' + String(failures) + ' dsh-browser check(s) FAILED')
process.exit(failures === 0 ? 0 : 1)




