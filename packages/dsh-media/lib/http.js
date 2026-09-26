/**
 * dsh-media — the route layer's small vocabulary.
 *
 * Every route answers with JSON, every failure is a typed body a client can
 * branch on (`{ ok: false, error: { code, message } }`) rather than an HTML
 * error page, and a thrown `httpError` is the only way a handler reports a
 * refusal. Duplicated from dsh-pdf on purpose: bundles here do not import each
 * other's files, and a shared package for forty lines would be a new dependency
 * for every one of them.
 */

/** A JSON response. */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A typed failure body. */
export function fail(status, code, message, extra) {
  return json(status, { ok: false, error: { code, message, ...(extra ?? {}) } })
}

/** One typed route error. */
export function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/** Map a thrown route error to its response. */
export function errorToResponse(err) {
  if (err && typeof err.status === 'number') return fail(err.status, err.code ?? 'ERROR', String(err.message ?? 'request failed'))
  if (err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code)) return fail(400, err.code, String(err.message ?? 'request failed'))
  return fail(500, 'INTERNAL', err && err.message ? String(err.message) : 'unexpected failure')
}

/**
 * Read a JSON request body with a hard cap. The bodies this plugin accepts name
 * a file and a couple of flags, never a document, so the cap is small.
 */
export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const text = await request.text()
  if (text.length > maxBytes) throw httpError(413, 'TOO_LARGE', 'The request body is too large.')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw httpError(400, 'BAD_JSON', 'The request body is not valid JSON.')
  }
}
