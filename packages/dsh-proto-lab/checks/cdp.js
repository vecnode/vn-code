/**
 * dsh-browser — a minimal Chrome DevTools Protocol client.
 *
 * The whole transport is Node's GLOBAL `WebSocket` (the undici implementation
 * Node 22 ships): the pack adds no dependency for it, and the tracked check
 * asserts the global is there rather than quietly importing one.
 *
 * What this is NOT: not a puppeteer, not a page object, not a retry engine. It
 * is the twenty per cent of CDP this package needs - send a command, wait for an
 * event, subscribe to a stream - with every call bounded, because the thing on
 * the other end is a browser rendering a page neither of us wrote.
 *
 * Flattened sessions (`Target.attachToTarget {flatten: true}`) are used rather
 * than a per-target socket: one connection covers the browser and every target
 * it creates, and a `sessionId` is what scopes a command, so teardown is one
 * `close()`.
 */

/** How long one command may wait before it is considered lost. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20000

/** The CDP methods that are events, used to keep the trace readable. */
function isEvent(message) {
  return typeof message.method === 'string' && message.id === undefined
}

/**
 * Connect to a `webSocketDebuggerUrl` and return a client.
 *
 * @param url - the DevTools WebSocket URL.
 * @param options - `timeoutMs` for the open handshake, `logger`.
 * @returns the client: `send`, `on`, `waitFor`, `close`, `commands`, `events`.
 */
export async function connectCdp(url, options = {}) {
  const openTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const socket = new WebSocket(url)
  const pending = new Map()
  const listeners = new Map()
  const names = { commands: [], events: [] }
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
      if (names.events.length < 2000) names.events.push(message.method)
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
      error.data = message.error.data
      entry.reject(error)
      return
    }
    entry.resolve(message.result ?? {})
  })

  socket.addEventListener('close', () => failEverything(closeReason === '' ? 'socket closed' : closeReason))
  socket.addEventListener('error', () => failEverything('socket error'))

  return {
    /** Every command sent, in order - the render report shows what was asked. */
    commands: names.commands,
    /** Every event method seen, in order. */
    events: names.events,
    /**
     * Send one command, bounded.
     * @param method - the CDP method, e.g. `Page.navigate`.
     * @param params - its parameters.
     * @param sessionId - the flattened session, when the command is target-scoped.
     * @param timeoutMs - how long to wait.
     * @returns the command's own result.
     */
    send(method, params = {}, sessionId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error('DevTools connection is closed: ' + closeReason))
      const id = nextId++
      if (names.commands.length < 2000) names.commands.push(method)
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
    /**
     * Subscribe to one event method.
     * @returns an unsubscribe function.
     */
    on(method, handler) {
      const set = listeners.get(method) ?? new Set()
      set.add(handler)
      listeners.set(method, set)
      return () => set.delete(handler)
    },
    /**
     * Wait for one event, optionally matching a predicate. Register this BEFORE
     * the action that triggers the event: a load that is already finished never
     * fires again, and a waiter registered afterwards waits for nothing.
     * @returns the matching parameters.
     */
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
    /** Close the socket; every pending command is rejected. */
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
