/**
 * dsh-docker — what may become an argv element.
 *
 * This file is the plugin's whole security boundary, so it is deliberately a
 * list of POSITIVE shapes rather than a blacklist: a value either matches the
 * grammar of a container id, a name, an image reference, a port mapping, a
 * volume, an environment key, a tail count or a duration, or it is refused with
 * the sentence saying why. Two classes of mistake are what the shapes exist for:
 *
 *   - **an argument that becomes an OPTION.** Docker's own flags are parsed from
 *     argv before the positional id, so `--all`, `-a` or `--privileged` in a
 *     field meant to carry an id would silently change the command. Every shape
 *     here starts with a letter, a digit or `.` - never `-` - and refuses a value
 *     that begins with one.
 *   - **an argument that becomes a SECOND command.** There is no shell, so this
 *     is already impossible; the shapes still refuse whitespace, NUL and the
 *     control characters that would make an answer unreadable.
 *
 * Every function returns `{ ok: true, value }` or `{ ok: false, reason }` - no
 * throws, so a tool can refuse with one sentence and never a stack trace.
 */

/** A container or image id: short, long, or the `sha256:` form. */
const ID = /^(?:sha256:)?[0-9a-f]{12,64}$/i
/** A container or network name. Docker allows this set and this length. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
/**
 * An image reference: `repo`, `repo:tag`, `registry:5000/repo:tag` and the
 * `@sha256:` digest form. No whitespace, no leading dash, no shell character.
 */
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,254}$/
/** A port mapping: `8080`, `8080:80`, `127.0.0.1:8080:80`, optionally `/tcp`. */
const PORT = /^(?:(?:\d{1,3}\.){3}\d{1,3}:)?\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/
/** An environment variable's name. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** A named volume or an absolute host path, a container path, and an optional mode. */
const VOLUME = /^(?:[A-Za-z]:[\\/][^:]*|\/[^:]*|[a-zA-Z0-9][a-zA-Z0-9_.-]*):(\/[^:]*)(?::(?:ro|rw))?$/
/** A log duration, as `docker logs --since` accepts it, or an RFC 3339 stamp. */
const SINCE = /^(\d{1,6}(?:s|m|h|ms|u|ns|us)|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))$/

/** How many of each a single run may carry. */
export const MAX_PORTS = 16
export const MAX_VOLUMES = 16
export const MAX_ENV_PAIRS = 32
export const MAX_TAIL = 2000
export const MAX_COMMAND_TOKENS = 32

/** Refuse a value whose first character would be read as an option. */
function noOptionShape(text, what, id) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'A ' + what + ' is required.' }
  if (text.startsWith('-')) return { ok: false, reason: 'A ' + what + ' cannot start with "-": that would become an option to docker, not a value (' + JSON.stringify(text) + ').' }
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'A ' + what + ' cannot contain a control character.' }
  return { ok: true, value: text.trim() }
}

/**
 * A container or image to act on.
 *
 * @param value - an id, a name, or (for an image) a reference.
 * @param options - `{ kind: 'container' | 'image' }`; an image also accepts a tag.
 */
export function targetRef(value, options = {}) {
  const shape = noOptionShape(value, options.kind === 'image' ? 'image' : 'container', 'target')
  if (!shape.ok) return shape
  const text = shape.value
  if (ID.test(text) || NAME.test(text)) return { ok: true, value: text }
  if (options.kind === 'image' && IMAGE.test(text)) return { ok: true, value: text }
  return {
    ok: false,
    reason:
      'Not a ' +
      (options.kind === 'image' ? 'image reference or an image id' : 'container id or name') +
      ': ' +
      JSON.stringify(text) +
      '. An id is 12-64 hex characters, a name is letters, digits, "_", "." or "-" (up to 128).',
  }
}

/** An image reference to pull or run. */
export function imageRef(value) {
  const shape = noOptionShape(value, 'image reference', 'image')
  if (!shape.ok) return shape
  if (!IMAGE.test(shape.value)) {
    return { ok: false, reason: 'Not an image reference: ' + JSON.stringify(shape.value) + '. Use `repo`, `repo:tag` or `registry:5000/repo:tag`.' }
  }
  return { ok: true, value: shape.value }
}

/** One `-p` value. */
export function portSpec(value) {
  const text = String(value).trim()
  if (!PORT.test(text)) return { ok: false, reason: 'Not a port mapping: ' + JSON.stringify(text) + '. Use `8080:80`, `8080:80/tcp` or `127.0.0.1:8080:80`.' }
  for (const part of text.split(':')) {
    const digits = /^(\d{1,5})(?:\/(?:tcp|udp))?$/.exec(part)
    if (digits !== null && (Number(digits[1]) < 1 || Number(digits[1]) > 65535)) {
      return { ok: false, reason: 'Port ' + digits[1] + ' is outside 1-65535.' }
    }
  }
  return { ok: true, value: text }
}

/** One `-v` value: named volume or absolute host path, container path, optional mode. */
export function volumeSpec(value) {
  const text = String(value).trim()
  if (!VOLUME.test(text)) {
    return {
      ok: false,
      reason:
        'Not a volume: ' +
        JSON.stringify(text) +
        '. Use `name:/container/path`, `C:\\\\host:/container/path` or `/host/path:/container/path`, optionally ending `:ro`.',
    }
  }
  return { ok: true, value: text }
}

/** One `-e` pair. */
export function envPair(key, value) {
  if (typeof key !== 'string' || !ENV_KEY.test(key)) {
    return { ok: false, reason: 'Not an environment variable name: ' + JSON.stringify(key) + '.' }
  }
  const text = value === undefined || value === null ? '' : String(value)
  if (/[\u0000]/.test(text)) return { ok: false, reason: 'The value of ' + key + ' contains a NUL byte.' }
  if (text.length > 4096) return { ok: false, reason: 'The value of ' + key + ' is longer than 4096 characters.' }
  return { ok: true, value: key + '=' + text }
}

/** A `--tail` count. */
export function tailCount(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 200 }
  const number = Number(value)
  if (!Number.isFinite(number) || Math.floor(number) !== number || number < 0 || number > MAX_TAIL) {
    return { ok: false, reason: '`tail` must be a whole number from 0 to ' + MAX_TAIL + '.' }
  }
  return { ok: true, value: number }
}

/** A `--since` value. */
export function sinceSpec(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' }
  const text = String(value).trim()
  if (!SINCE.test(text)) {
    return { ok: false, reason: '`since` must be a duration like `10m` or an RFC 3339 timestamp, not ' + JSON.stringify(text) + '.' }
  }
  return { ok: true, value: text }
}

/** A network name. */
export function networkName(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' }
  return noOptionShape(String(value), 'network name', 'network')
}

/** One token of the command a container runs (it comes AFTER the image, so flags are fine). */
export function commandToken(value) {
  const text = String(value)
  if (text === '') return { ok: false, reason: 'A command token cannot be empty.' }
  if (text.length > 1024) return { ok: false, reason: 'A command token is longer than 1024 characters.' }
  if (/[\u0000]/.test(text)) return { ok: false, reason: 'A command token contains a NUL byte.' }
  return { ok: true, value: text }
}

/** `confirm` must repeat the target exactly: the accident this exists to stop. */
export function confirmMatches(confirm, target) {
  return typeof confirm === 'string' && confirm.trim() === String(target).trim()
}
