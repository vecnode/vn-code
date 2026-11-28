/**
 * dsh-comfyui — where ComfyUI is, and the HTTP calls this row makes.
 *
 * FOUR FACTS THAT FAIL INDEPENDENTLY, and the tools never merge them:
 *
 *   1. an INSTALL on disk - a Desktop base path, a portable folder, a git
 *      checkout. It answers "which models exist", "where is custom_nodes" and
 *      "which ComfyUI version is this" WITHOUT a server;
 *   2. a SERVER answering on loopback - `/system_stats` is the only thing that
 *      proves it, and ComfyUI Desktop does not use 8188: it picks 8000 upwards,
 *      so a probe that only tried 8188 would report "not running" on a machine
 *      where the app is open;
 *   3. a NODE CATALOG - `/object_info`, which is what makes a project
 *      compilable rather than merely well-shaped;
 *   4. a PYTHON that can import the install's packages - needed to run a node
 *      CLASS, and never needed to compile a graph.
 *
 * The loopback fence is the same rule as `dsh-ollama`'s: these tools talk to the
 * machine's own ComfyUI, and a URL naming another machine is REFUSED unless
 * `DSH_COMFYUI_ALLOW_REMOTE=1` says the person means it. Prompts are not
 * private, but the files they write and read are on somebody's disk.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { ComfyError } from './errors.js'

/** What ComfyUI's own server binds to by default. */
export const DEFAULT_PORT = 8188

/** The ports ComfyUI Desktop picks from, lowest first. */
export const DESKTOP_PORTS = [8000, 8001, 8002, 8003]

/** The one environment variable that allows a server on another machine. */
export const ALLOW_REMOTE_ENV = 'DSH_COMFYUI_ALLOW_REMOTE'

/** The one environment variable that pins the server this row talks to. */
export const URL_ENV = 'DSH_COMFYUI_URL'

/** The one environment variable that pins the install directory. */
export const DIR_ENV = 'DSH_COMFYUI_DIR'

/** A response body is capped here; a full `/object_info` is the largest real one. */
export const MAX_BODY_BYTES = 24 * 1024 * 1024

/** A probe gives up here: a server that is there answers in milliseconds. */
export const PROBE_TIMEOUT_MS = 2500

/** Reading the node catalog is the one slow call on a big install. */
export const SCHEMA_TIMEOUT_MS = 30000

/**
 * The conversation home, resolved exactly like the pack's other rows.
 *
 * `os.homedir()` is the last REAL home, and `os.tmpdir()` is the last resort
 * rather than `process.cwd()`. A cache written into whatever directory the
 * process happened to start in drops a `.dsh/` folder into somebody's project -
 * measured here: a harness with a stripped environment wrote
 * `packages/dsh-comfyui/.dsh/dsh-comfyui/schema/*.json` during a check run.
 * A catalog cache is never worth a file in the working tree.
 */
export function resolveHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  if (typeof home === 'string' && home.trim() !== '') return path.join(home.trim(), '.dsh')
  return path.join(tmpdir(), 'dsh-home')
}

/** Where this row keeps what it must remember: the node catalogs it has read. */
export function cacheRoot(env = process.env) {
  return path.join(resolveHome(env), 'dsh-comfyui', 'schema')
}

/** One origin as a file name. */
export function cacheFileFor(env, origin) {
  const safe = String(origin).replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return path.join(cacheRoot(env), safe + '.json')
}

/** The truthy spellings a person actually types for an opt-in. */
function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

/** Whether a hostname names this machine (the same rule `dsh-ollama` uses). */
export function isLoopbackHost(hostname) {
  const name = String(hostname).toLowerCase()
  if (name === 'localhost' || name === 'localhost.' || name === '0.0.0.0' || name === '::1' || name === '::') return true
  if (name.endsWith('.localhost')) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true
  return false
}

/**
 * Which origins this row will try, in order, and whether the person pinned one.
 *
 * It makes NO request: this is the fence, so a caller can ask "would this be
 * allowed" before a socket exists.
 *
 * @param env - the environment (injectable for the check).
 * @returns `{ explicit, origins, allowed, code, reason }`.
 */
export function resolveServers(env = process.env) {
  const raw = String(env[URL_ENV] ?? '').trim()
  const optIn = isTruthy(env[ALLOW_REMOTE_ENV])
  if (raw === '') {
    return {
      explicit: false,
      origins: ['http://127.0.0.1:' + DEFAULT_PORT, ...DESKTOP_PORTS.map((port) => 'http://127.0.0.1:' + port)],
      allowed: true,
      code: '',
      reason: '',
      remote: false,
      optIn,
    }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw
  let url
  try {
    url = new URL(withScheme)
  } catch (error) {
    return { explicit: true, origins: [], allowed: false, code: 'HOST_INVALID', reason: URL_ENV + ' is "' + raw + '", which is not an address. Use http://host:port.', remote: false, optIn }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { explicit: true, origins: [], allowed: false, code: 'HOST_INVALID', reason: URL_ENV + ' is "' + raw + '"; this row speaks http(s), so a "' + url.protocol + '" address is refused.', remote: false, optIn }
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const local = isLoopbackHost(host)
  const allowed = local || optIn
  const origin = url.origin + (url.pathname === '/' || url.pathname === '' ? '' : url.pathname.replace(/\/+$/, ''))
  return {
    explicit: true,
    origins: allowed ? [origin] : [],
    allowed,
    code: allowed ? '' : 'REMOTE_REFUSED',
    reason: allowed
      ? ''
      : URL_ENV +
        ' is ' +
        host +
        ', which is not this machine. These tools talk to the local ComfyUI only: set ' +
        ALLOW_REMOTE_ENV +
        '=1 for a server you run elsewhere, or unset ' +
        URL_ENV +
        ' to try 127.0.0.1:' +
        DEFAULT_PORT +
        ' and the Desktop ports.',
    remote: !local,
    optIn,
  }
}

/** The base path ComfyUI Desktop recorded, per platform. */
export function desktopConfigFile(env, platform) {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'ComfyUI', 'config.json') : path.join(home, 'AppData', 'Roaming', 'ComfyUI', 'config.json')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ComfyUI', 'config.json')
  return env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'ComfyUI', 'config.json') : path.join(home, '.config', 'ComfyUI', 'config.json')
}

/** The Desktop app's own folder, whose `resources/ComfyUI` is the source tree. */
export function desktopAppDirs(env, platform) {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(local, 'Programs', 'ComfyUI'), path.join(local, 'ComfyUI'), path.join(home, 'AppData', 'Local', 'Programs', 'ComfyUI')]
  }
  if (platform === 'darwin') return ['/Applications/ComfyUI.app/Contents', path.join(home, 'Applications', 'ComfyUI.app', 'Contents')]
  return ['/opt/ComfyUI', '/usr/local/ComfyUI', path.join(home, 'Applications', 'ComfyUI')]
}

/** Whether a folder looks like a ComfyUI base path (user data) rather than a source tree. */
function looksLikeBase(dir) {
  return existsSync(path.join(dir, 'models')) || existsSync(path.join(dir, 'custom_nodes')) || existsSync(path.join(dir, 'user'))
}

/** Whether a folder looks like the ComfyUI source tree. */
function looksLikeApp(dir) {
  return existsSync(path.join(dir, 'main.py')) || existsSync(path.join(dir, 'comfyui_version.py'))
}

/** The version in a `comfyui_version.py`, or ''. */
export function versionFromFile(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const match = /__version__\s*=\s*['"]([^'"]+)['"]/.exec(text)
    return match ? match[1] : ''
  } catch (error) {
    return ''
  }
}

/** The interpreter a base path's environment carries, or ''. */
export function pythonIn(base, platform) {
  const candidates =
    platform === 'win32'
      ? [path.join(base, '.venv', 'Scripts', 'python.exe'), path.join(base, 'python_embeded', 'python.exe'), path.join(base, 'venv', 'Scripts', 'python.exe')]
      : [path.join(base, '.venv', 'bin', 'python'), path.join(base, 'venv', 'bin', 'python'), path.join(base, 'python_embeded', 'bin', 'python')]
  return candidates.find((candidate) => existsSync(candidate)) ?? ''
}

/** The names of one model folder, without reading gigabytes of anything. */
export function modelFiles(base, folder) {
  const dir = path.join(base, 'models', folder)
  if (!existsSync(dir)) return []
  const found = []
  const walk = (current, prefix, depth) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        if (depth < 2 && folder !== 'diffusion_models') walk(path.join(current, entry.name), relative, depth + 1)
        else if (depth < 3 && folder === 'diffusion_models') walk(path.join(current, entry.name), relative, depth + 1)
        continue
      }
      if (/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i.test(entry.name)) found.push(relative)
    }
  }
  walk(dir, '', 0)
  return found.sort()
}

/** Whether a path is a directory, without throwing. */
function isDir(candidate) {
  try {
    return statSync(candidate).isDirectory()
  } catch (error) {
    return false
  }
}

/**
 * Everything this machine can be asked about ComfyUI WITHOUT a server.
 *
 * The search is bounded and ordered: an explicit variable, ComfyUI Desktop's
 * own record of where it installed, what comfy-cli reports about the workspaces
 * it knows (its `env --json` names each Desktop install's `code_dir` and
 * `data_dir`), the portable folder a person unpacks, then the places a checkout
 * usually sits. It never scans a drive.
 *
 * @param options - `{ env, platform, cli }`; `cli` is a `cli.envFacts()` result.
 * @returns `{ found, bases, app, version, python, models, modelRoots, customNodes, sources, notes }`.
 */
export function discoverInstall(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cli = options.cli ?? null
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const notes = []
  const bases = []
  const seen = new Set()
  const addBase = (dir, source) => {
    if (typeof dir !== 'string' || dir.trim() === '') return
    const resolved = path.resolve(dir.trim())
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    if (!isDir(resolved)) return
    bases.push({ dir: resolved, source })
  }
  const appCandidatesExtra = []

  addBase(String(env[DIR_ENV] ?? ''), DIR_ENV)
  if (cli !== null && typeof cli === 'object') {
    // comfy-cli's own view: a Desktop install names where the code is and where
    // the models are, which is exactly the pair this function needs.
    for (const install of Array.isArray(cli.installs) ? cli.installs : []) {
      if (install === null || typeof install !== 'object') continue
      if (install.exists === false) continue
      addBase(install.dataDir, 'comfy-cli Desktop install' + (install.name === '' ? '' : ' "' + install.name + '"'))
      if (typeof install.codeDir === 'string' && install.codeDir !== '') appCandidatesExtra.push(install.codeDir)
    }
    if (cli.workspace !== '' && cli.workspaceExists === true) addBase(cli.workspace, 'comfy-cli workspace')
  }
  const configFile = desktopConfigFile(env, platform)
  let desktopBase = ''
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'))
      if (typeof config.basePath === 'string' && config.basePath !== '') {
        desktopBase = config.basePath
        if (isDir(config.basePath)) addBase(config.basePath, 'ComfyUI Desktop config')
        else notes.push('ComfyUI Desktop records the base path ' + config.basePath + ', and that folder is NOT there - the app cannot start until it is. Reinstall the desktop build (or point it at a base path) and this row will find the models again.')
      }
      if (typeof config.installState === 'string' && config.installState !== 'installed') {
        notes.push('ComfyUI Desktop records installState "' + config.installState + '" - the app may not be fully installed.')
      }
    } catch (error) {
      notes.push('ComfyUI Desktop config at ' + configFile + ' is not readable JSON, so its base path was not used.')
    }
  } else {
    notes.push('no ComfyUI Desktop config at ' + configFile)
  }
  for (const candidate of [path.join(home, 'ComfyUI'), path.join(home, 'comfyui'), path.join(home, 'ComfyUI_windows_portable', 'ComfyUI'), path.join(home, 'Desktop', 'ComfyUI'), path.join(home, 'Documents', 'ComfyUI'), '/opt/ComfyUI', 'C:\\ComfyUI']) {
    addBase(candidate, 'a standard location')
  }

  let app = ''
  const appCandidates = []
  for (const dir of desktopAppDirs(env, platform)) appCandidates.push(path.join(dir, 'resources', 'ComfyUI'), dir)
  for (const candidate of appCandidatesExtra) appCandidates.push(candidate)
  for (const base of bases) appCandidates.push(base.dir)
  for (const candidate of appCandidates) {
    if (!isDir(candidate)) continue
    if (looksLikeApp(candidate)) {
      app = candidate
      break
    }
  }

  const base = bases.find((entry) => looksLikeBase(entry.dir)) ?? null
  const version = app === '' ? '' : versionFromFile(path.join(app, 'comfyui_version.py'))
  const python = base === null ? '' : pythonIn(base.dir, platform)
  const customNodes = []
  for (const dir of [base === null ? null : path.join(base.dir, 'custom_nodes'), app === '' ? null : path.join(app, 'custom_nodes')]) {
    if (dir === null || !isDir(dir)) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__pycache__') customNodes.push(entry.name)
      }
    } catch (error) {
      notes.push('could not list ' + dir + ': ' + error.message)
    }
  }
  const models = {}
  if (base !== null) {
    const modelsDir = path.join(base.dir, 'models')
    if (isDir(modelsDir)) {
      try {
        for (const entry of readdirSync(modelsDir, { withFileTypes: true })) if (entry.isDirectory()) models[entry.name] = modelFiles(base.dir, entry.name).length
      } catch (error) {
        notes.push('could not list ' + modelsDir + ': ' + error.message)
      }
    }
  }
  // Model roots comfy-cli knows about (a Desktop install can keep models in a
  // shared folder beside the app): reported, and used as extra places to look.
  const modelRoots = []
  for (const root of [...(cli !== null && Array.isArray(cli.modelRoots) ? cli.modelRoots : []), ...(base === null ? [] : [path.join(base.dir, 'models')])]) {
    if (typeof root === 'string' && root !== '' && isDir(root) && !modelRoots.includes(root)) modelRoots.push(root)
  }
  if (app !== '' && base === null) notes.push('the source tree at ' + app + ' was found, but no base path with models/ and custom_nodes/ was; a model filename cannot be checked against the disk here - start ComfyUI and its own /object_info lists become the truth.')

  return {
    found: base !== null || app !== '',
    base: base === null ? '' : base.dir,
    baseSource: base === null ? '' : base.source,
    app,
    version,
    python,
    models,
    modelRoots,
    customNodes,
    desktopBase,
    configFile,
    notes,
  }
}

/** The abort signal for one request: our deadline, plus the caller's when given. */
function signalFor(timeoutMs, callerSignal) {
  const deadline = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)))
  if (callerSignal === undefined || callerSignal === null) return deadline
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([deadline, callerSignal])
  return deadline
}

/** The deepest `code` a fetch failure carries (ECONNREFUSED lives in `cause`). */
function causeCode(error) {
  let current = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === 'string' && current.code !== '') return current.code
    current = current.cause
  }
  return ''
}

/** Read a response body against a byte ceiling. */
async function readBounded(response, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ComfyError('BODY_TOO_LARGE', 'The server answered with ' + declared + ' bytes, over the ' + maxBytes + '-byte ceiling this row reads.')
  }
  if (response.body === null || typeof response.body?.getReader !== 'function') {
    const text = await response.text()
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new ComfyError('BODY_TOO_LARGE', 'The server answered with more than the ' + maxBytes + '-byte ceiling this row reads.')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }
  return text
}

/**
 * One JSON request to a ComfyUI server.
 *
 * A refusal keeps the server's own words in `extra.body`: `/prompt` answers a
 * rejected graph with `node_errors`, which is the most useful text in the whole
 * API, and replacing it with "HTTP 400" would throw it away.
 *
 * @param deps - `{ fetch }`.
 * @param origin - e.g. `http://127.0.0.1:8188`.
 * @param route - e.g. `/prompt`.
 * @param options - `{ method, body, timeoutMs, signal }`.
 * @returns `{ status, data, text }`.
 */
export async function requestJson(deps, origin, route, options = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000
  const init = { method: options.method ?? 'GET', headers: { accept: 'application/json', 'user-agent': 'dsh-comfyui' }, signal: signalFor(timeoutMs, options.signal) }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers['content-type'] = 'application/json'
  }
  let response
  try {
    response = await fetchImpl(origin + route, init)
  } catch (error) {
    const name = error && error.name ? String(error.name) : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ComfyError('TIMEOUT', 'No answer from ' + origin + route + ' within ' + Math.round(timeoutMs / 1000) + ' s. A big install takes a while to answer /object_info the first time; a run takes as long as its model.', { origin, route })
    }
    const detail = causeCode(error) || (error && error.message ? String(error.message) : 'fetch failed')
    throw new ComfyError('SERVER_DOWN', 'Nothing is answering at ' + origin + ' (' + detail + '). ComfyUI is not running there: start the app (or `python main.py`), then call `comfy_status` - it names the ports this row tries.', { origin })
  }
  const text = await readBounded(response)
  let data = {}
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text)
    } catch (error) {
      if (response.ok) throw new ComfyError('BAD_JSON', 'The server answered ' + route + ' with something that is not JSON: ' + text.trim().slice(0, 200), { origin, route })
      data = { error: text.trim().slice(0, 600) }
    }
  }
  if (!response.ok) {
    throw new ComfyError('HTTP_ERROR', 'The server answered HTTP ' + response.status + ' for ' + route + '.', { origin, route, status: response.status, body: data })
  }
  return { status: response.status, data, text }
}

/**
 * One server's identity, or null when nothing answers there.
 *
 * `/system_stats` is the proof: it is answered by the ComfyUI server itself
 * (not by its frontend, not by a proxy that happens to hold the port) and it
 * carries the version, the device and the VRAM this row reports.
 *
 * @returns `{ origin, version, device, vramTotal, ramTotal, pythonVersion, pytorchVersion, os, argv }` or null.
 */
export async function probeServer(deps, origin, options = {}) {
  try {
    const { data } = await requestJson(deps, origin, '/system_stats', { timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS, signal: options.signal })
    const system = data !== null && typeof data.system === 'object' && data.system !== null ? data.system : {}
    const devices = Array.isArray(data.devices) ? data.devices : []
    const device = devices[0] !== null && typeof devices[0] === 'object' ? devices[0] : {}
    return {
      origin,
      version: typeof system.comfyui_version === 'string' ? system.comfyui_version : '',
      device: typeof device.name === 'string' ? device.name : '',
      deviceType: typeof device.type === 'string' ? device.type : '',
      vramTotal: typeof device.vram_total === 'number' ? device.vram_total : null,
      vramFree: typeof device.vram_free === 'number' ? device.vram_free : null,
      ramTotal: typeof system.ram_total === 'number' ? system.ram_total : null,
      pythonVersion: typeof system.python_version === 'string' ? system.python_version.split(' ')[0] : '',
      pytorchVersion: typeof system.pytorch_version === 'string' ? system.pytorch_version : '',
      os: typeof system.os === 'string' ? system.os : '',
      devices: devices.length,
    }
  } catch (error) {
    return null
  }
}

/**
 * The first origin that answers, with what every probe said.
 *
 * Sequential, not parallel, and for a reason: the Desktop ports are tried in
 * order and the first hit is the app, while a parallel fan-out would race the
 * same server twice and make the reported port depend on network jitter.
 *
 * @returns `{ server, probed }` - `server` is null when nothing answered.
 */
export async function findServer(deps, options = {}) {
  const resolved = options.servers ?? resolveServers(deps.env ?? process.env)
  if (!resolved.allowed) return { server: null, probed: [], servers: resolved }
  const probed = []
  for (const origin of resolved.origins) {
    const server = await probeServer(deps, origin, { timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS, signal: options.signal })
    probed.push({ origin, up: server !== null })
    if (server !== null) return { server, probed, servers: resolved }
  }
  return { server: null, probed, servers: resolved }
}

/** `/object_info`, parsed. The caller decides where to cache it. */
export async function fetchObjectInfo(deps, origin, options = {}) {
  const { data } = await requestJson(deps, origin, '/object_info', { timeoutMs: options.timeoutMs ?? SCHEMA_TIMEOUT_MS, signal: options.signal })
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ComfyError('BAD_OBJECT_INFO', 'The server answered /object_info with something that is not an object of node classes.', { origin })
  }
  return data
}

/** Write one catalog to the cache, and return the file it wrote. */
export function writeCache(env, origin, record) {
  const file = cacheFileFor(env, origin)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
  return file
}

/** The cached catalog for one origin, or null. */
export function readCache(env, origin) {
  const file = cacheFileFor(env, origin)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record === null || typeof record !== 'object' || record.objectInfo === null || typeof record.objectInfo !== 'object') return null
    return record
  } catch (error) {
    return null
  }
}

/** Every catalog this machine has read, newest first. */
export function listCache(env) {
  const root = cacheRoot(env)
  if (!existsSync(root)) return []
  const found = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(root, entry.name)
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'))
        found.push({
          file,
          origin: typeof record.origin === 'string' ? record.origin : '',
          version: typeof record.version === 'string' ? record.version : '',
          fetchedAt: typeof record.fetchedAt === 'string' ? record.fetchedAt : '',
          classes: record.objectInfo !== null && typeof record.objectInfo === 'object' ? Object.keys(record.objectInfo).length : 0,
        })
      } catch (error) {
        found.push({ file, origin: '', version: '', fetchedAt: '', classes: 0 })
      }
    }
  } catch (error) {
    return []
  }
  return found.sort((left, right) => String(right.fetchedAt).localeCompare(String(left.fetchedAt)))
}

/** Queue one prompt. A rejected graph comes back as a ComfyError with the body. */
export async function queuePrompt(deps, origin, prompt, options = {}) {
  const body = { prompt, client_id: options.clientId ?? 'dsh-comfyui' }
  if (options.number !== undefined) body.number = options.number
  const { data } = await requestJson(deps, origin, '/prompt', { method: 'POST', body, timeoutMs: options.timeoutMs ?? 30000, signal: options.signal })
  if (typeof data.prompt_id !== 'string' || data.prompt_id === '') {
    throw new ComfyError('PROMPT_REFUSED', 'The server accepted the request but did not return a prompt_id, so there is nothing to wait for.', { origin, body: data })
  }
  return data
}

/** One prompt's history entry, or null while it is still queued or running. */
export async function historyOf(deps, origin, promptId, options = {}) {
  const { data } = await requestJson(deps, origin, '/history/' + encodeURIComponent(promptId), { timeoutMs: options.timeoutMs ?? 15000, signal: options.signal })
  if (data === null || typeof data !== 'object') return null
  const entry = data[promptId]
  return entry !== undefined && entry !== null && typeof entry === 'object' ? entry : null
}

/** The queue, for telling "still waiting" from "dropped". */
export async function queueOf(deps, origin, options = {}) {
  const { data } = await requestJson(deps, origin, '/queue', { timeoutMs: options.timeoutMs ?? 15000, signal: options.signal })
  const running = Array.isArray(data.queue_running) ? data.queue_running : []
  const pending = Array.isArray(data.queue_pending) ? data.queue_pending : []
  return { running, pending }
}

/**
 * Wait for one prompt to finish.
 *
 * `/history/{id}` gaining an entry is the only completion signal the HTTP API
 * has - the WebSocket is how the frontend learns it first, and this row does
 * not open a socket. A prompt that leaves the queue without a history entry was
 * dropped (the server restarted, or the item was deleted), which is reported
 * rather than waited out.
 *
 * @returns `{ entry, waitedMs, timedOut, dropped }`.
 */
export async function waitForHistory(deps, origin, promptId, options = {}) {
  const started = typeof deps.now === 'function' ? deps.now() : Date.now()
  const timeoutMs = options.timeoutMs ?? 600000
  const intervalMs = options.intervalMs ?? 500
  for (;;) {
    const entry = await historyOf(deps, origin, promptId, { signal: options.signal })
    if (entry !== null) {
      const now = typeof deps.now === 'function' ? deps.now() : Date.now()
      return { entry, waitedMs: now - started, timedOut: false, dropped: false }
    }
    const now = typeof deps.now === 'function' ? deps.now() : Date.now()
    if (now - started >= timeoutMs) return { entry: null, waitedMs: now - started, timedOut: true, dropped: false }
    if (typeof options.onTick === 'function') await options.onTick({ waitedMs: now - started })
    // After the first minute, asking the queue every tick is a lot of requests
    // for an answer that cannot change quickly - and it is how a prompt that was
    // DROPPED (server restart, deleted item) is told from one still waiting.
    if (now - started > 60000) {
      const queue = await queueOf(deps, origin, { signal: options.signal }).catch(() => null)
      if (queue !== null) {
        const present = [...queue.running, ...queue.pending].some((item) => Array.isArray(item) && String(item[1]) === promptId)
        if (!present) {
          const late = await historyOf(deps, origin, promptId, { signal: options.signal })
          if (late === null) return { entry: null, waitedMs: now - started, timedOut: false, dropped: true }
        }
      }
    }
    await (deps.sleep ? deps.sleep(intervalMs) : new Promise((resolve) => setTimeout(resolve, intervalMs)))
  }
}

/** Bytes as a person reads them. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit]
}

/** Milliseconds as a person reads them. */
export function formatMilliseconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a'
  if (ms < 1000) return Math.round(ms) + ' ms'
  if (ms < 60000) return (ms / 1000).toFixed(2) + ' s'
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return minutes + ' min ' + seconds + ' s'
}
