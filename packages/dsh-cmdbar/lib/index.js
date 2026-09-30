/**
 * dsh-cmdbar — Node half (the COMMAND BAR: `dsh-terminal` through alpha.13).
 *
 * ONE read-only route, and it is the panel's whole data source:
 *
 *   GET /api/dsh-cmdbar/activity?session=<id>  the tail of this conversation's
 *                                              command-relevant session events
 *                                              (the browser folds them)
 *
 * It goes through `connection.fetch.register` like dsh-editor's and
 * dsh-gittree's routes, so it inherits the connection's own authentication, and
 * `connection` is the only capability this row injects.
 *
 * WHAT THIS FILE USED TO OWN (removed in alpha.12): the terminals themselves - a
 * real PTY per dock slot behind an authenticated WebSocket upgrade on
 * `/api/dsh-cmdbar/pty`, the vendored xterm.js bundle and its stylesheet on
 * two `/vendor` routes, and a `/health` probe that reported whether a PTY was
 * available at all. Every one of them is gone, because 0.2's right Sidebar ships
 * terminal TABS of its own (`@deepseek-ai/dsh-client-ui-sidebar-terminal`): a
 * second emulator at the foot of the window was a second answer to a question
 * the harness now answers in the column beside it. This package therefore READS
 * and never RUNS - there is no shell of its own to spawn, no socket to gate and
 * no binary to resolve - so an unauthenticated request can only ever learn what
 * the conversation it names already contains, and every failure below is a typed
 * status rather than a dead socket.
 *
 * The read is READ-ONLY, bounded and filtered: only the two tool events and a
 * human prompt are sent, from the TAIL of the log, at most ACTIVITY_LIMIT events
 * and roughly ACTIVITY_BYTES. Nothing is derived here - the browser folds these
 * events with the SAME pure fold it uses everywhere else, so what the model is
 * told and what a person sees cannot drift.
 */
export const name = 'dsh-cmdbar'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constant. */
const API_ROOT = '/api/dsh-cmdbar'
const ACTIVITY_ROUTE = API_ROOT + '/activity'
/**
 * The session events the agent-activity view consumes: the two tool events and
 * a HUMAN message (the prompt a group is captioned with). Everything else in the
 * log - assistant messages with their embedded streams above all - is neither
 * sent nor needed, which is what keeps this route cheap enough to poll.
 */
const ACTIVITY_TYPES = { 'tool/call': true, 'tool/result': true, 'user/message': true }
/** Most events one answer carries (a long conversation is read from its tail). */
const ACTIVITY_LIMIT = 400
/** Rough ceiling on the JSON one answer carries; older events are dropped. */
const ACTIVITY_BYTES = 512 * 1024

/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The live session for one conversation, or null.
 *
 * The host's own `sessions` service is the authority; it holds the in-memory log
 * this route reads. `snapshotEvents` is the whole contiguous log (inherited seed
 * history included), which is what makes a resumed or forked conversation show
 * the commands its context already contains.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the conversation to read.
 * @returns the session, or null when it is not live on this host.
 */
function liveSession(ctx, sessionId) {
  const get = typeof ctx.get === 'function' ? (serviceName) => ctx.get(serviceName) : () => undefined
  try {
    const sessions = get('sessions')
    if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return null
    const session = sessions.get(sessionId)
    if (session === null || session === undefined) return null
    return typeof session.snapshotEvents === 'function' ? session : null
  } catch (err) {
    return null
  }
}

/** One event's rough JSON weight, so the byte budget is a real bound. */
function eventWeight(event) {
  try {
    return JSON.stringify(event).length + 1
  } catch (err) {
    return 1024
  }
}

/**
 * The tail of one conversation's log, filtered to what the panel draws.
 *
 * Walked BACKWARDS from the newest event and reversed at the end, so a
 * conversation longer than the budget answers with its most recent commands -
 * the ones a reader is looking for - plus `hasMore`, which the panel states
 * instead of silently truncating.
 *
 * @param session - the live session.
 * @returns `{ entries, hasMore }` in the wire shape the client folds.
 */
function activityEntries(session) {
  const all = session.snapshotEvents()
  const entries = []
  let hasMore = false
  let bytes = 0
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event === null || typeof event !== 'object' || ACTIVITY_TYPES[event.type] !== true) continue
    // Injected context is not a prompt: the panel groups commands under what a
    // person asked for, and every other `user/message` is producer text.
    if (event.type === 'user/message') {
      const source = event.data === null || typeof event.data !== 'object' ? null : event.data.source
      if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    }
    // The NEWEST event is always included, even alone and even oversized: a
    // single enormous command must not leave the panel with nothing to draw.
    // Past that first one, the count and the byte budget are what bound the
    // answer, and `hasMore` is what says so instead of truncating silently.
    const weight = eventWeight(event)
    if (entries.length > 0 && (entries.length >= ACTIVITY_LIMIT || bytes + weight > ACTIVITY_BYTES)) {
      hasMore = true
      break
    }
    bytes += weight
    entries.push({ type: 'event', event })
  }
  entries.reverse()
  return { entries, hasMore }
}

/** GET /api/dsh-cmdbar/activity?session=<id> — the commands one conversation ran. */
function handleActivity(request, ctx) {
  let sessionId = ''
  try {
    sessionId = new URL(request.url).searchParams.get('session') || ''
  } catch (err) {
    sessionId = ''
  }
  if (sessionId === '') {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'A session id is required.' } })
  }
  const session = liveSession(ctx, sessionId)
  if (session === null) {
    // A capability refusal, not a bad request: the conversation exists, it is
    // just not open on this host (a stored conversation reads from its log
    // through the session UI, and this panel is bound to what is live).
    return json(200, {
      ok: false,
      reason: 'NOT_LIVE',
      message: 'This conversation is not open on this host, so the commands it ran cannot be read here.',
    })
  }
  let tail = { entries: [], hasMore: false }
  try {
    tail = activityEntries(session)
  } catch (err) {
    return json(200, { ok: false, reason: 'UNREADABLE', message: 'The conversation log could not be read: ' + String((err && err.message) || err) })
  }
  return json(200, { ok: true, session: sessionId, entries: tail.entries, hasMore: tail.hasMore })
}

/**
 * Activate the row: register the one route this package owns.
 *
 * @param ctx - the host context (inject: connection).
 */
export function apply(ctx) {
  ctx.effect(() => {
    const connection = ctx.get ? ctx.get('connection') : undefined
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      ctx.logger?.warn?.('[dsh-cmdbar] connection service unavailable - the activity route was not registered')
      return () => {}
    }
    // `requestBody: 'buffered'` is required by the connection bridge (a route
    // that leaves it undefined takes the streaming branch, which throws for a
    // bodyless method before the handler runs).
    const dispose = connection.fetch.register({
      path: ACTIVITY_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleActivity(request, ctx),
    })
    ctx.logger?.debug?.('[dsh-cmdbar] activity route registered (' + ACTIVITY_ROUTE + ')')
    return () => {
      try {
        dispose()
      } catch (err) {}
      ctx.logger?.debug?.('[dsh-cmdbar] node half disposed')
    }
  }, 'dsh-cmdbar: activity route')
}
