/**
 * dsh-shaders — a minimal Chrome DevTools Protocol client.
 *
 * The same transport dsh-browser and dsh-frontend-craft use, copied rather than
 * shared because a bundle may not import another bundle's files: Node's GLOBAL
 * `WebSocket`, no dependency, no puppeteer, no page object. Send a command, wait
 * for an event, subscribe to a stream - every call bounded, because the thing on
 * the other end is a browser compiling source this package did not write.
 */

/** How long one command may wait before it is considered lost. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20000

function isEvent(message) {
  return typeof message.method === 'string' && message.id === undefined
}

/**
 * Connect to a `webSocketDebuggerUrl` and return a client.
 * @returns the client: `send`, `on`, `waitFor`, `close`.
 */
export async function connectCdp(url, options = {}) {
  const openTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const socket = new WebSocket(url)
  const pending = new Map()
  const listeners = new Map()
  let nextId = 1
  let closed = false
  let closeReason = ''

  const failEverything = (reason) => {
    closed = true
    closeReason = reason
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('DevTools connection closed: ' + reason))
    }
    pending.clear()
  }

  await new Promise((done, failed) => {
    const timer = setTimeout(() => failed(new Error('DevTools connection timed out after ' + String(openTimeoutMs) + ' ms')), openTimeoutMs)
    const settle = (error) => {
      clearTimeout(timer)
      if (error) failed(error)
      else done()
    }
    socket.addEventListener('open', () => settle(null), { once: true })
    socket.addEventListener('error', () => settle(new Error('DevTools connection failed')), { once: true })
  })

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch (err) {
      log('ignoring an unreadable DevTools message')
      return
    }
    if (isEvent(message)) {
      for (const handler of listeners.get(message.method) ?? []) {
        try {
          handler(message.params ?? {}, message.sessionId)
        } catch (err) {
          log('DevTools event handler failed: ' + String(err && err.message))
        }
      }
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      const error = new Error(String(message.error.message ?? 'DevTools error') + ' (' + String(message.error.code ?? '?') + ')')
      error.code = message.error.code
      entry.reject(error)
      return
    }
    entry.resolve(message.result ?? {})
  })

  socket.addEventListener('close', () => failEverything(closeReason === '' ? 'socket closed' : closeReason))
  socket.addEventListener('error', () => failEverything('socket error'))

  return {
    send(method, params = {}, sessionId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error('DevTools connection is closed: ' + closeReason))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('DevTools command ' + method + ' timed out after ' + String(timeoutMs) + ' ms'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        const frame = { id, method, params }
        if (sessionId !== undefined) frame.sessionId = sessionId
        try {
          socket.send(JSON.stringify(frame))
        } catch (err) {
          pending.delete(id)
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    on(method, handler) {
      const set = listeners.get(method) ?? new Set()
      set.add(handler)
      listeners.set(method, set)
      return () => set.delete(handler)
    },
    waitFor(method, { predicate = () => true, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, sessionId } = {}) {
      return new Promise((resolve, reject) => {
        const off = this.on(method, (params, eventSession) => {
          if (sessionId !== undefined && eventSession !== sessionId) return
          if (!predicate(params)) return
          clearTimeout(timer)
          off()
          resolve(params)
        })
        const timer = setTimeout(() => {
          off()
          reject(new Error('DevTools event ' + method + ' did not arrive within ' + String(timeoutMs) + ' ms'))
        }, timeoutMs)
      })
    },
    close(reason = 'closed by the client') {
      if (closed) return
      failEverything(reason)
      try {
        socket.close()
      } catch (err) {
        log('DevTools socket close failed: ' + String(err && err.message))
      }
    },
  }
}
