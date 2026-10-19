/**
 * dsh-ollama — the one error type this row throws.
 *
 * A tool's answer is prose, but the CODE is what the caller (and the package's
 * check) branches on, so every refusal names itself: `REMOTE_REFUSED` is a
 * policy decision, `DAEMON_DOWN` is a machine state, `NO_MODEL` is a missing
 * artifact and `BAD_*` is the caller's argument. Collapsing them into one
 * "failed" would make "start the daemon" and "pull the model" look alike.
 */
export class OllamaError extends Error {
  /**
   * @param code - the stable refusal code (`DAEMON_DOWN`, `NO_MODEL`, ...).
   * @param message - one sentence a reader can act on.
   * @param extra - fields the caller may want (`status`, `host`, `detail`).
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'OllamaError'
    this.code = code
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) this[key] = value
    }
  }
}

/** The one message of anything thrown. */
export function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}
