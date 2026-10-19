/**
 * dsh-ollama — the HTTP client: one daemon, the loopback fence, bounded bodies
 * and the NDJSON reader.
 *
 * Nothing here decides WHAT to ask; that is `tools.js`. This module owns the
 * four rules every request obeys, and they are all measurements rather than
 * preferences:
 *
 *   - **loopback only.** The tools talk to the machine's own service at
 *     `127.0.0.1:11434`. `OLLAMA_HOST` may move it, but a value naming another
 *     machine is REFUSED unless `DSH_OLLAMA_ALLOW_REMOTE=1` says the person
 *     means it - prompts and completions would otherwise leave the machine on
 *     a plugin whose whole premise is that they do not;
 *   - **a bounded request.** Every call carries a deadline (`AbortSignal`), and
 *     a response body is read against a byte ceiling rather than trusted;
 *   - **streaming is NDJSON**, one JSON object per line, `done: true` last -
 *     the shape `/api/generate`, `/api/chat` and `/api/pull` all answer with.
 *     Reading it line by line is what lets the first token be TIMED;
 *   - **an error is a sentence.** `DAEMON_DOWN`, `TIMEOUT`, `NO_MODEL`,
 *     `HTTP_ERROR` and `BAD_STREAM` are distinct because the fix differs.
 */

import { OllamaError } from './errors.js'

/** The daemon's default, and the address Ollama itself binds. */
export const DEFAULT_HOST = '127.0.0.1:11434'
export const DEFAULT_PORT = 11434

/** The one environment variable that allows a daemon on another machine. */
export const ALLOW_REMOTE_ENV = 'DSH_OLLAMA_ALLOW_REMOTE'

/** A JSON response body is capped here; `/api/show` is the largest real one. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** A streamed body is capped here; a 40 GB pull's progress text is far below it. */
export const MAX_STREAM_BYTES = 16 * 1024 * 1024

/** A stream may not carry more items than this, however small they are. */
export const MAX_STREAM_ITEMS = 500_000

/** How much of an error body is quoted back. */
const MAX_ERROR_CHARS = 600

/** The truthy spellings a person actually types for an opt-in. */
function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

/**
 * Whether a hostname names this machine.
 *
 * `0.0.0.0` is accepted because it is a BIND address a local daemon is often
 * configured with (`OLLAMA_HOST=0.0.0.0:11434`); as a destination it cannot
 * reach another box. Everything else must be loopback, `localhost`, or the
 * `*.localhost` namespace.
 *
 * @param hostname - a URL hostname with any IPv6 brackets already stripped.
 * @returns true when the name cannot leave the machine.
 */
export function isLoopbackHost(hostname) {
  const name = String(hostname).toLowerCase()
  if (name === 'localhost' || name === 'localhost.' || name === '0.0.0.0' || name === '::1' || name === '::') return true
  if (name.endsWith('.localhost')) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true
  return false
}

/**
 * Resolve `OLLAMA_HOST` (or the default) into the address this row will use.
 *
 * This function makes NO request: it is the fence, so both the tools and the
 * check can ask "would this be allowed" without touching a socket.
 *
 * @param env - the environment (injectable for the check).
 * @returns `{ raw, host, port, origin, base, local, remote, optIn, allowed, code, reason }`.
 */
export function resolveHost(env = process.env) {
  const raw = String(env.OLLAMA_HOST ?? '').trim()
  const text = raw === '' ? DEFAULT_HOST : raw
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text
  let url
  try {
    url = new URL(withScheme)
  } catch (err) {
    return {
      raw: text,
      host: '',
      port: DEFAULT_PORT,
      origin: '',
      base: '',
      local: false,
      remote: false,
      optIn: false,
      allowed: false,
      code: 'HOST_INVALID',
      reason: 'OLLAMA_HOST is "' + text + '", which is not an address. Use host:port, e.g. ' + DEFAULT_HOST + '.',
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      raw: text,
      host: url.hostname,
      port: DEFAULT_PORT,
      origin: '',
      base: '',
      local: false,
      remote: false,
      optIn: false,
      allowed: false,
      code: 'HOST_INVALID',
      reason: 'OLLAMA_HOST is "' + text + '"; this row speaks http(s) to the daemon, so a "' + url.protocol + '" address is refused.',
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      raw: text,
      host: url.hostname,
      port: DEFAULT_PORT,
      origin: '',
      base: '',
      local: false,
      remote: false,
      optIn: false,
      allowed: false,
      code: 'HOST_INVALID',
      reason: 'OLLAMA_HOST carries credentials ("' + text + '"). A daemon address is not a place for a password, and this row will not read one from a URL.',
    }
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const port = url.port === '' ? DEFAULT_PORT : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      raw: text,
      host,
      port,
      origin: '',
      base: '',
      local: false,
      remote: false,
      optIn: false,
      allowed: false,
      code: 'HOST_INVALID',
      reason: 'OLLAMA_HOST names port "' + url.port + '", which is not a port (1-65535).',
    }
  }
  const local = isLoopbackHost(host)
  const optIn = isTruthy(env[ALLOW_REMOTE_ENV])
  const base = url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
  const allowed = local || optIn
  return {
    raw: text,
    host,
    port,
    origin: url.origin,
    base,
    local,
    remote: !local,
    optIn,
    allowed,
    code: allowed ? '' : 'REMOTE_REFUSED',
    reason: allowed
      ? ''
      : 'OLLAMA_HOST is ' +
        host +
        ':' +
        port +
        ', which is not this machine. These tools talk to the local Ollama only: set ' +
        ALLOW_REMOTE_ENV +
        '=1 for a daemon you run elsewhere (prompts and completions then cross the network), or unset OLLAMA_HOST to use ' +
        DEFAULT_HOST +
        '.',
  }
}

/** The refusal a caller sees when the fence says no. */
export function assertHostAllowed(config) {
  if (config.allowed) return config
  throw new OllamaError(config.code, config.reason, { host: config.origin || config.raw })
}

/**
 * The abort signal for one request: our deadline, plus the caller's signal when
 * one was given (an agent's cancel must cut a generation, not wait it out).
 */
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

/**
 * Turn a rejected `fetch` into a refusal with a fix in it.
 *
 * @param error - what fetch threw.
 * @param config - the resolved host.
 * @param timeoutMs - the deadline that was in force, for the sentence.
 */
function networkError(error, config, timeoutMs) {
  const name = error && error.name ? String(error.name) : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new OllamaError(
      'TIMEOUT',
      'No answer from ' + config.origin + ' within ' + Math.round(timeoutMs / 1000) + ' s. A cold model load can take longer than a short deadline: raise timeoutSeconds, or check `ollama_status` first.',
      { host: config.origin },
    )
  }
  const code = causeCode(error)
  const detail = code === '' ? (error && error.message ? String(error.message) : 'fetch failed') : code
  return new OllamaError(
    'DAEMON_DOWN',
    'Nothing is answering at ' +
      config.origin +
      ' (' +
      detail +
      '). The Ollama daemon is not running: start it with `ollama serve` in a terminal, or open the Ollama desktop app, then call `ollama_status`.',
    { host: config.origin },
  )
}

/**
 * Read a response body against a byte ceiling.
 *
 * @param response - a fetch Response.
 * @param maxBytes - the ceiling.
 * @returns the text.
 */
export async function readBodyBounded(response, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OllamaError('BODY_TOO_LARGE', 'The daemon answered with ' + declared + ' bytes, over the ' + maxBytes + '-byte ceiling this row reads.')
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
      if (bytes > maxBytes) {
        throw new OllamaError('BODY_TOO_LARGE', 'The daemon answered with more than the ' + maxBytes + '-byte ceiling this row reads.')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }
  return text
}

/**
 * The refusal one non-2xx response becomes.
 *
 * Ollama answers a missing model with HTTP 404 and `{"error":"model \"x\" not
 * found, try pulling it first"}`, so the BODY decides between NO_MODEL and a
 * generic NOT_FOUND - the status alone cannot.
 */
async function httpErrorFrom(response, options) {
  let detail = ''
  let parsed = null
  try {
    const text = await readBodyBounded(response, MAX_ERROR_CHARS * 8)
    detail = text.trim().slice(0, MAX_ERROR_CHARS)
    parsed = text.trim() === '' ? null : JSON.parse(text)
  } catch (err) {
    detail = detail === '' ? String(err && err.message ? err.message : err) : detail
  }
  const message = parsed && typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : detail
  const model = options && typeof options.model === 'string' ? options.model : ''
  const reason = (message + ' ' + detail).toLowerCase()
  // Only a body that names the MODEL is a missing model. A 404 that says "404
  // page not found" is an OLDER DAEMON without this route, and reading it as
  // "pull the model" would send the caller after the wrong fix.
  const missingModel = reason.includes('try pulling') || (model !== '' && reason.includes('model') && reason.includes('not found'))
  if (response.status === 404 && missingModel) {
    return new OllamaError('NO_MODEL', 'No model "' + (model || 'requested') + '" on this daemon (' + (message || 'HTTP 404') + ').', {
      status: 404,
      detail: message,
      model,
    })
  }
  if (response.status === 404) {
    return new OllamaError('NOT_FOUND', 'The daemon has no route for ' + (options && options.route ? options.route : 'the request') + ' (' + (message || 'HTTP 404') + '). It may be an older daemon than this row expects.', { status: 404, detail: message })
  }
  return new OllamaError('HTTP_ERROR', 'The daemon answered HTTP ' + response.status + (message === '' ? '.' : ': ' + message), { status: response.status, detail: message })
}

/**
 * One JSON request to the daemon.
 *
 * @param deps - `{ fetch, env }`.
 * @param route - an `/api/...` path.
 * @param options - `{ method, body, timeoutMs, signal, model, route }`.
 * @returns `{ data, config, status }`; `data` is `{}` for an empty 200.
 */
export async function requestJson(deps, route, options = {}) {
  const config = resolveHost(deps.env)
  assertHostAllowed(config)
  const url = config.base + route
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000
  const init = {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', 'user-agent': 'dsh-ollama' },
    signal: signalFor(timeoutMs, options.signal),
  }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers['content-type'] = 'application/json'
  }
  let response
  try {
    response = await deps.fetch(url, init)
  } catch (error) {
    throw networkError(error, config, timeoutMs)
  }
  if (!response.ok) throw await httpErrorFrom(response, { ...options, route })
  const text = await readBodyBounded(response)
  if (text.trim() === '') return { data: {}, config, status: response.status }
  try {
    return { data: JSON.parse(text), config, status: response.status }
  } catch (error) {
    throw new OllamaError('BAD_JSON', 'The daemon answered ' + route + ' with something that is not JSON: ' + text.trim().slice(0, 200), { route })
  }
}

/**
 * One NDJSON request: read every line, hand each parsed object to `onItem`, and
 * return them all.
 *
 * `onItem` is how the caller times the FIRST token: it runs as each line
 * arrives, not after the stream ends.
 *
 * @param deps - `{ fetch, env }`.
 * @param route - an `/api/...` path that streams.
 * @param body - the JSON request body.
 * @param options - `{ timeoutMs, signal, onItem, model, maxItems }`.
 * @returns `{ items, config, bytes }`.
 */
export async function streamJsonLines(deps, route, body, options = {}) {
  const config = resolveHost(deps.env)
  assertHostAllowed(config)
  const url = config.base + route
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 300_000
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems > 0 ? options.maxItems : MAX_STREAM_ITEMS
  let response
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', 'user-agent': 'dsh-ollama' },
      body: JSON.stringify(body),
      signal: signalFor(timeoutMs, options.signal),
    })
  } catch (error) {
    throw networkError(error, config, timeoutMs)
  }
  if (!response.ok) throw await httpErrorFrom(response, { ...options, route })
  const items = []
  const reader = response.body?.getReader?.()
  if (reader === undefined) {
    // A daemon behind a proxy that buffered the whole answer: still NDJSON.
    const text = await response.text()
    return { items: parseLines(text, options, items, maxItems), config, bytes: text.length }
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  let emitted = 0
  const emit = (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new OllamaError('BAD_STREAM', 'The daemon sent a line that is not JSON: ' + trimmed.slice(0, 200), { route })
    }
    if (emitted >= maxItems) {
      throw new OllamaError('STREAM_TOO_LONG', 'The daemon sent more than ' + maxItems + ' stream objects; this row stops reading there.', { route })
    }
    emitted += 1
    items.push(parsed)
    if (typeof options.onItem === 'function') options.onItem(parsed)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_STREAM_BYTES) {
        throw new OllamaError('STREAM_TOO_LONG', 'The daemon streamed more than the ' + MAX_STREAM_BYTES + '-byte ceiling this row reads.', { route })
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        emit(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    emit(buffer)
  } catch (error) {
    if (error instanceof OllamaError) throw error
    throw networkError(error, config, timeoutMs)
  } finally {
    reader.cancel().catch(() => {})
  }
  return { items, config, bytes }
}

/** The buffered-proxy path of `streamJsonLines`: parse a whole body as NDJSON. */
function parseLines(text, options, items, maxItems) {
  let emitted = 0
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new OllamaError('BAD_STREAM', 'The daemon sent a line that is not JSON: ' + trimmed.slice(0, 200), { route: options.route })
    }
    if (emitted >= maxItems) throw new OllamaError('STREAM_TOO_LONG', 'The daemon sent more than ' + maxItems + ' stream objects.', { route: options.route })
    emitted += 1
    items.push(parsed)
    if (typeof options.onItem === 'function') options.onItem(parsed)
  }
  return items
}
