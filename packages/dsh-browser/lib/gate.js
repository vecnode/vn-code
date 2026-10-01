/**
 * dsh-browser — the egress gate: the ONLY network path the render engine has.
 *
 * A loopback HTTP proxy that speaks `CONNECT` and nothing else. It exists
 * because a real browser engine resolves and connects for itself, so the policy
 * in `policy.js` cannot be applied to a page by inspecting a URL: it has to be
 * applied to every SOCKET the engine opens, including the ones a page's own
 * scripts open for its subresources. Pointing the engine at this gate
 * (`--proxy-server`) means:
 *
 *   - every destination is resolved HERE, once, and refused as a set when any
 *     answer is not public (see `checkAddresses`);
 *   - the connection is then made to the address that was validated, so a
 *     second lookup cannot rebind the name to something private between the
 *     check and the connect;
 *   - only `CONNECT`, only the configured ports (443 by default), only
 *     qualified public hostnames, never an IP literal - the same rules the
 *     address bar enforces, so the two cannot drift;
 *   - every tunnel is bounded (idle timeout, byte cap) and every decision is
 *     RECORDED, so the tab's policy panel and a tool result can state what the
 *     engine actually reached instead of asserting that it was safe.
 *
 * Answers, exactly as a proxy must:
 *
 *   `CONNECT host:port` → `200 Connection Established`, then a raw byte tunnel.
 *   Anything else        → `405`; a gate is not an HTTP server for pages.
 *
 * The gate demands `Proxy-Authorization` (a per-process nonce) because a
 * loopback port is reachable by any local process. That is defence in depth,
 * not the security boundary: the gate grants strictly LESS than a local process
 * already has (public https on 443, nothing else), so a process that found it
 * gains no reach it did not already have. What the nonce prevents is an
 * unrelated local program quietly relaying traffic through a browser-shaped
 * hole. The engine satisfies the challenge over CDP (`Fetch.authRequired`), so
 * the credential never travels in a URL and never reaches a page.
 *
 * Nothing here reads a file, writes one, or knows what a page is.
 */
import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'

import { REFUSAL, checkAddresses, isIpLiteral, normalizeHost, parseTargetUrl, refusalMessage } from './policy.js'

/** The largest request head this gate will read before answering 431. */
export const MAX_HEAD_BYTES = 16 * 1024
/** How many decisions one gate remembers (the newest are kept). */
export const MAX_TRACE = 128
/** Per-tunnel defaults: a page's own subresource load, not a download manager. */
export const DEFAULT_CAPS = {
  idleTimeoutMs: 20000,
  connectTimeoutMs: 10000,
  maxBytes: 64 * 1024 * 1024,
  maxTunnels: 64,
}

/** The resolver signature the gate accepts, so a check can drive it without DNS. */
export function defaultResolver(host) {
  return dns.lookup(host, { all: true, order: 'verbatim' })
}

/** One `HTTP/1.1` head, read one at a time so a 407 retry on the same socket works. */
function createHeadReader(socket) {
  let buffer = Buffer.alloc(0)
  let waiting = null
  let ended = false
  const onData = (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    pump()
  }
  const onEnd = () => {
    ended = true
    pump()
  }
  function pump() {
    if (waiting === null) return
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) {
      if (buffer.length > MAX_HEAD_BYTES) {
        const pending = waiting
        waiting = null
        pending.reject(new Error('request head exceeds ' + String(MAX_HEAD_BYTES) + ' bytes'))
      } else if (ended) {
        const pending = waiting
        waiting = null
        pending.resolve(null)
      }
      return
    }
    const head = buffer.subarray(0, end).toString('latin1')
    buffer = buffer.subarray(end + 4)
    const pending = waiting
    waiting = null
    pending.resolve({ head })
  }
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('error', onEnd)
  socket.on('close', onEnd)
  return {
    readHead() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject }
        pump()
      })
    },
    /** Everything already read past the current head, and stop parsing. */
    detach() {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onEnd)
      socket.off('close', onEnd)
      // Pause while nothing is listening: a tunnel is established asynchronously
      // (a resolve, then a connect), and a flowing socket with no data listener
      // DISCARDS what arrives in that window. The caller resumes once its own
      // forwarding listener is attached.
      socket.pause()
      const rest = buffer
      buffer = Buffer.alloc(0)
      return rest
    },
  }
}

/** The request line plus its headers, parsed the little that a proxy needs. */
export function parseHead(head) {
  const lines = String(head ?? '').split('\r\n')
  const [method, target, version] = (lines.shift() ?? '').split(' ')
  const headers = new Map()
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
  }
  return { method: (method ?? '').toUpperCase(), target: target ?? '', version: version ?? '', headers }
}

/** `host:port` from a CONNECT target, brackets and all. */
export function parseAuthority(target) {
  const text = String(target ?? '')
  const close = text.lastIndexOf(']')
  if (text.startsWith('[')) {
    if (close === -1) return null
    const host = text.slice(1, close)
    const port = text.slice(close + 1).replace(/^:/, '')
    return { host: host.toLowerCase(), port: port === '' ? 443 : Number(port) }
  }
  const at = text.lastIndexOf(':')
  if (at === -1) return { host: text.toLowerCase(), port: 443 }
  const port = text.slice(at + 1)
  return { host: text.slice(0, at).toLowerCase(), port: port === '' ? 443 : Number(port) }
}

/**
 * Start one gate on an ephemeral loopback port.
 *
 * @param options - `policy` (the port/allow/block lists), `resolve` (an injected
 *   resolver, for tests), `caps`, `nonce`, `function logger`.
 * @returns the gate: `port`, `pacUrl`, `trace`, `snapshot()`, `close()`.
 */
export async function createGate(options = {}) {
  const policyOptions = options.policy ?? {}
  const caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) }
  const resolve = typeof options.resolve === 'function' ? options.resolve : defaultResolver
  const nonce = typeof options.nonce === 'string' && options.nonce !== '' ? options.nonce : randomBytes(16).toString('hex')
  const credential = 'Basic ' + Buffer.from(nonce + ':x', 'utf8').toString('base64')
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const trace = []
  const sockets = new Set()
  const stats = { tunnels: 0, refused: 0, authFailures: 0, bytesDown: 0, bytesUp: 0 }

  const record = (entry) => {
    trace.push({ at: Date.now(), ...entry })
    while (trace.length > MAX_TRACE) trace.shift()
  }

  const answer = (socket, status, text, extra = {}) => {
    const body = Buffer.from(text ?? '', 'utf8')
    const lines = [
      'HTTP/1.1 ' + status,
      'content-type: text/plain; charset=utf-8',
      'content-length: ' + String(body.length),
      ...Object.entries(extra).map(([key, value]) => key + ': ' + value),
      '',
      '',
    ]
    socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), body]))
  }

  /** One request head on one socket; returns true when the socket became a tunnel. */
  async function handleHead(socket, reader, head) {
    const request = parseHead(head)
    if (request.method !== 'CONNECT') {
      answer(socket, '405 Method Not Allowed', 'dsh-browser gate: CONNECT only.\n')
      socket.end()
      record({ decision: 'refuse', reason: 'method ' + request.method, peer: socket.remoteAddress ?? '' })
      return false
    }
    const authorization = request.headers.get('proxy-authorization')
    if (authorization !== credential) {
      stats.authFailures += 1
      record({ decision: 'refuse', reason: 'proxy credentials missing', peer: socket.remoteAddress ?? '' })
      // A 407 that leaves the socket open: a client that HAS credentials may
      // retry on this same connection, and one that opens a new connection is
      // answered there instead.
      answer(socket, '407 Proxy Authentication Required', 'dsh-browser gate: proxy credentials required.\n', {
        'proxy-authenticate': 'Basic realm="dsh-browser"',
      })
      return false
    }
    const authority = parseAuthority(request.target)
    if (authority === null || !Number.isFinite(authority.port)) {
      answer(socket, '400 Bad Request', 'dsh-browser gate: malformed CONNECT target.\n')
      socket.end()
      return false
    }
    const host = normalizeHost(authority.host)
    const url = 'https://' + host + (authority.port === 443 ? '' : ':' + String(authority.port)) + '/'
    // The gate runs the SAME policy as the address bar, by asking it the same
    // question: a tunnel target is a URL with no path.
    const target = parseTargetUrl(url, policyOptions)
    if (!target.ok) {
      stats.refused += 1
      record({ decision: 'refuse', code: target.code, host, port: authority.port })
      answer(socket, '403 Forbidden', 'dsh-browser gate refused ' + host + ': ' + target.message + '\n')
      socket.end()
      return false
    }
    if (isIpLiteral(host)) {
      stats.refused += 1
      record({ decision: 'refuse', code: REFUSAL.LITERAL, host, port: authority.port })
      answer(socket, '403 Forbidden', refusalMessage(REFUSAL.LITERAL, { host }) + '\n')
      socket.end()
      return false
    }
    if (stats.tunnels >= caps.maxTunnels) {
      stats.refused += 1
      record({ decision: 'refuse', reason: 'tunnel ceiling', host, port: authority.port })
      answer(socket, '503 Service Unavailable', 'dsh-browser gate: too many open tunnels for one render.\n')
      socket.end()
      return false
    }
    let answers
    try {
      answers = await resolve(host)
    } catch (err) {
      stats.refused += 1
      record({ decision: 'refuse', code: REFUSAL.NO_ADDRESS, host, port: authority.port, error: String(err && err.message) })
      answer(socket, '502 Bad Gateway', refusalMessage(REFUSAL.NO_ADDRESS, { host }) + '\n')
      socket.end()
      return false
    }
    const checked = checkAddresses(host, answers)
    if (!checked.ok) {
      stats.refused += 1
      record({ decision: 'refuse', code: checked.code, host, port: authority.port, address: checked.details && checked.details.address })
      answer(socket, '403 Forbidden', checked.message + '\n')
      socket.end()
      return false
    }
    const pinned = checked.addresses[0]
    const upstream = net.connect({ host: pinned, port: authority.port, family: net.isIPv6(pinned) ? 6 : 4 })
    const rest = reader.detach()
    const tunnelBytes = { down: 0, up: 0 }
    const cut = (reason) => {
      record({ decision: 'tunnel', host, port: authority.port, address: pinned, cut: reason })
      upstream.destroy()
      socket.destroy()
    }
    let connected = false
    let settle = () => {}
    upstream.on('error', (err) => {
      if (connected) {
        socket.destroy()
        return
      }
      record({ decision: 'refuse', code: 'CONNECT_FAILED', host, port: authority.port, address: pinned, error: String(err && err.message) })
      answer(socket, '502 Bad Gateway', 'dsh-browser gate could not connect to ' + host + '.\n')
      socket.end()
      settle(false)
    })
    const established = await new Promise((done) => {
      settle = done
      upstream.setTimeout(caps.connectTimeoutMs, () => {
        record({ decision: 'refuse', code: 'CONNECT_TIMEOUT', host, port: authority.port, address: pinned })
        answer(socket, '504 Gateway Timeout', 'dsh-browser gate: ' + host + ' did not accept a connection in time.\n')
        socket.end()
        upstream.destroy()
        done(false)
      })
      upstream.once('connect', () => {
        connected = true
        upstream.setTimeout(0)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        // The tunnel proper: byte caps and backpressure in both directions, an
        // idle timeout, and a teardown that follows either end down.
        socket.on('data', (chunk) => {
          tunnelBytes.up += chunk.length
          stats.bytesUp += chunk.length
          if (tunnelBytes.down + tunnelBytes.up > caps.maxBytes) return cut('byte cap')
          if (!upstream.write(chunk)) socket.pause()
        })
        upstream.on('data', (chunk) => {
          tunnelBytes.down += chunk.length
          stats.bytesDown += chunk.length
          if (tunnelBytes.down + tunnelBytes.up > caps.maxBytes) return cut('byte cap')
          if (!socket.write(chunk)) upstream.pause()
        })
        socket.on('drain', () => upstream.resume())
        upstream.on('drain', () => socket.resume())
        upstream.on('close', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        socket.setTimeout(caps.idleTimeoutMs, () => cut('idle'))
        if (rest.length > 0) {
          tunnelBytes.up += rest.length
          stats.bytesUp += rest.length
          upstream.write(rest)
        }
        // Anything the client sent while the tunnel was being established was
        // held in this paused socket; the listeners above are now attached.
        socket.resume()
        done(true)
      })
    })
    if (established === false) return false
    stats.tunnels += 1
    record({ decision: 'allow', host, port: authority.port, address: pinned, addresses: checked.addresses.length })
    log('tunnel ' + host + ':' + String(authority.port) + ' -> ' + pinned)
    return true
  }

  async function onConnection(socket) {
    sockets.add(socket)
    // Every accepted socket is recorded: "the engine never reached the gate" and
    // "the engine reached it and was refused" are different failures, and the
    // policy panel has to be able to tell a person which one happened.
    record({ decision: 'connect', peer: (socket.remoteAddress ?? '') + ':' + String(socket.remotePort ?? '') })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const reader = createHeadReader(socket)
    try {
      for (;;) {
        const next = await reader.readHead()
        if (next === null) return
        const tunnelled = await handleHead(socket, reader, next.head)
        if (tunnelled) return
      }
    } catch (err) {
      record({ decision: 'refuse', reason: String(err && err.message), peer: socket.remoteAddress ?? '' })
      socket.destroy()
    }
  }

  const server = net.createServer((socket) => {
    void onConnection(socket)
  })
  let port = 0
  // NOTE: the promise callbacks are deliberately NOT named `resolve`/`reject`:
  // `resolve` in this scope is the injected resolver, and shadowing it made the
  // listening callback call dns.lookup(undefined) instead of settling.
  await new Promise((listening, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = address && typeof address === 'object' ? address.port : 0
      listening()
    })
  })

  return {
    port,
    nonce,
    /** What the engine is launched with: `--proxy-server=<this>`. */
    proxyServer: '127.0.0.1:' + String(port),
    /** The credentials the engine answers the proxy challenge with, over CDP. */
    credential: { username: nonce, password: 'x' },
    trace,
    snapshot() {
      return {
        port,
        policy: { ports: policyOptions.ports ?? [443], allowHosts: policyOptions.allowHosts ?? [], blockHosts: policyOptions.blockHosts ?? [] },
        caps,
        stats: { ...stats, open: sockets.size },
        trace: trace.slice(-24),
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolved) => server.close(() => resolved()))
    },
  }
}
