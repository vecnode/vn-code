/**
 * dsh-proto-lab — the small, shared vocabulary the rest of the package builds on.
 *
 * Everything here is pure: a slug, a label, a seed from a name, and the template
 * substitution a runtime's files are written through. Nothing in this file
 * touches the disk, so a runtime's own check can drive the rules that decide what
 * a run looks like without creating one.
 */

import { createHash } from 'node:crypto'

/**
 * A name reduced to the characters a folder can carry on every platform.
 *
 * The canonical shape of a run's folder name. It is deliberately conservative:
 * lower case ASCII letters, digits, dashes and underscores, never a leading or
 * trailing dash and never a run of two. A name that reduces to nothing (emoji,
 * CJK, punctuation) is refused by the caller rather than silently becoming
 * `run`, because a run whose slug is not what the caller asked for is a run the
 * caller will not find again.
 *
 * @param value - what the caller called it.
 * @param maxLength - the character cap (a filesystem limit backstop, not a style rule).
 * @returns the slug, or '' when nothing usable survives.
 */
export function slugify(value, maxLength = 64) {
  const text = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const dashed = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (dashed === '') return ''
  const capped = dashed.slice(0, maxLength)
  return capped.replace(/-+$/g, '')
}

/**
 * Whether a string is already a canonical slug.
 *
 * The check a caller's `slug` argument passes before it is used as a path
 * segment. A value that is not canonical is refused rather than normalized, so
 * the folder the tool reports is the folder it made.
 *
 * @param value - the candidate.
 * @returns true when `slugify(value) === value`.
 */
export function isSlug(value) {
  return typeof value === 'string' && value !== '' && slugify(value) === value
}

/**
 * A stable 31-bit seed derived from a name.
 *
 * This is the one piece of the design that makes a run reproducible without the
 * caller having to remember anything: a run scaffolded with no seed gets the hash
 * of its own id, so the same name always draws the same first frame, on any
 * machine, forever. `randomSeed`/`noiseSeed` in p5.js and `ofSeedRandom` in
 * openFrameworks are both seeded from this number.
 *
 * It is a hash and not a random draw on purpose. A random default would make
 * "run it again and see" impossible to talk about, and every re-scaffold of the
 * same name would silently be a different picture.
 *
 * @param value - the run id, a concept, any stable string.
 * @returns a positive integer below 2^31.
 */
export function seedFromName(value) {
  const digest = createHash('sha256').update(String(value ?? ''), 'utf8').digest()
  return digest.readUInt32BE(0) % 2147483647
}

/** A human label for a slug, for a card title: `flow-field` -> `Flow field`. */
export function labelFromSlug(slug) {
  const text = String(slug ?? '').replace(/[-_]+/g, ' ').trim()
  if (text === '') return 'Untitled'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A number that is actually a number.
 *
 * p5's own `randomSeed` accepts a float, but the same seed must produce the same
 * picture in the browser and in the headless render check, so a seed is always an
 * integer here. A caller's float is truncated rather than refused.
 */
export function integerOf(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.trunc(number)
}

/**
 * Substitute `{{TOKEN}}` placeholders in one template file.
 *
 * Templates live on disk as real, readable source (`.html`, `.js`, `.cpp`), not
 * as strings built by concatenation inside a runtime module. That is what makes
 * a generated run editable by hand the day after it was made, and what lets this
 * package's checks read the very bytes a scaffold copies.
 *
 * The tokens are upper snake case and the substitution is a single pass: a value
 * that itself contains `{{` is never re-scanned, so a sketch that prints
 * `{{SEED}}` on the canvas keeps printing it.
 *
 * @param text - the template's contents.
 * @param values - `{ TOKEN: value }`. A token with no value is left as it is.
 * @returns the substituted text.
 */
export function substitute(text, values) {
  return String(text).replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (whole, token) =>
    Object.prototype.hasOwnProperty.call(values, token) ? String(values[token]) : whole,
  )
}

/**
 * A JSON literal safe to embed in a template that is itself code.
 *
 * A concept or a parameter name is caller-supplied text that lands inside a
 * `<script>` in the p5 shell. Escaping the four characters that can leave a JSON
 * string still leaves `</script>` as text inside a JS string literal, which the
 * HTML parser ends the element on - so `<` is escaped too, which is the standard
 * defence and costs nothing.
 *
 * @param value - anything JSON-serializable.
 * @returns the literal.
 */
export function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * A whole file's digests, for the catalog's record of what it wrote.
 *
 * @param content - the bytes.
 * @returns `{ bytes, sha256 }`.
 */
export function digest(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  return { bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') }
}
