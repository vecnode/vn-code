/**
 * dsh-canvas — the bundled FONT table.
 *
 * The fonts are vendored, hashed and licensed (see `vendor/build.mjs`); this
 * module is how the rest of the package sees them:
 *
 *   - the VALIDATOR (through `engine.normalizeDocument`) refuses a family the
 *     package does not ship, by name, listing what it does ship - so a design can
 *     never ask for a font that will silently fall back and re-wrap a headline;
 *   - the BROWSER loads the faces from the plugin's own route before it measures
 *     anything (`/api/dsh-canvas/vendor/fonts/<file>`), and the state payload
 *     carries the URL per family and weight;
 *   - the `.svg` EXPORT embeds the same files as data URLs, because an SVG loaded
 *     as an image may not fetch anything.
 *
 * The record is read from `lib/vendor/fonts/VERSION.json` on first use and cached
 * for the process, so a missing or hand-edited tree degrades in a sentence
 * instead of throwing at import time.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the vendored subsets live. */
export const FONT_DIR = fileURLToPath(new URL('./vendor/fonts/', import.meta.url))

/** The record the vendorer wrote. */
const VERSION_FILE = path.join(FONT_DIR, 'VERSION.json')

/** The fallback stack a bundled family sits in front of (and the whole stack for `system`). */
export const SYSTEM_STACK = ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']

/** The route shape the browser fetches one face from. Keep in sync with lib/index.js. */
export const FONT_ROUTE_PREFIX = '/api/dsh-canvas/vendor/fonts/'

/** The record, read once. */
let cached = null

/**
 * The vendored font record, or null when it is missing/unreadable.
 * @returns `{ families, digest }` or null.
 */
export function fontRecord() {
  if (cached !== null) return cached
  try {
    const parsed = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    cached = parsed && typeof parsed === 'object' && parsed.families ? parsed : null
  } catch (err) {
    cached = null
  }
  return cached
}

/**
 * The table the engine validates against: `{ 'Inter': { family, stack, weights } }`.
 * Only families whose files are actually present are listed - a family in the
 * record with no bytes on disk is NOT offered, because offering it would mean the
 * browser silently falls back.
 *
 * @returns the family table (possibly empty, on a tree with no vendored fonts).
 */
export function fontTable() {
  const record = fontRecord()
  if (!record) return {}
  const table = {}
  for (const [family, entry] of Object.entries(record.families)) {
    const weights = {}
    for (const [weight, meta] of Object.entries(entry.files ?? {})) {
      if (!existsSync(path.join(FONT_DIR, meta.file))) continue
      weights[weight] = { file: meta.file, url: FONT_ROUTE_PREFIX + meta.file, bytes: meta.bytes, sha256: meta.sha256 }
    }
    if (Object.keys(weights).length === 0) continue
    table[family] = {
      family,
      stack: [family, ...SYSTEM_STACK],
      weights,
      licence: entry.licence ?? null,
      designer: entry.designer ?? null,
      homepage: entry.homepage ?? null,
    }
  }
  return table
}

/** The vendored files, as a flat list (for a check or a status line). */
export function fontFiles() {
  const out = []
  for (const [family, entry] of Object.entries(fontTable())) {
    for (const [weight, meta] of Object.entries(entry.weights)) {
      out.push({ family, weight, file: meta.file, bytes: meta.bytes, sha256: meta.sha256 })
    }
  }
  return out
}

/**
 * Whether one file name may be served from the font directory: it must be one of
 * the recorded files, so the route can never be turned into a directory reader.
 *
 * @param name - the requested file name.
 * @returns the absolute path, or null.
 */
export function fontFileFor(name) {
  const wanted = String(name ?? '')
  if (!/^[a-z0-9-]+\.woff2$/.test(wanted)) return null
  for (const entry of Object.entries(fontTable())) {
    for (const meta of Object.values(entry[1].weights)) {
      if (meta.file === wanted) {
        const file = path.join(FONT_DIR, wanted)
        return existsSync(file) ? file : null
      }
    }
  }
  return null
}

/** The licence text for a family, when it was vendored. */
export function fontLicence(family) {
  const record = fontRecord()
  const entry = record && record.families ? record.families[family] : null
  if (!entry || !entry.licence) return null
  const file = path.join(FONT_DIR, entry.licence)
  if (!existsSync(file)) return null
  return { name: entry.licence, url: entry.licenceUrl ?? null, text: readFileSync(file, 'utf8') }
}

/**
 * The `@font-face` CSS for one family, with every weight embedded as a data URL -
 * what the `.svg` export carries so an SVG rendered as an image still has its
 * type. The caller supplies the base64 (the host reads the file; the browser has
 * the bytes from its own fetch).
 *
 * @param family - the family name.
 * @param base64For - `(file) => string | null` answering the file's base64.
 * @returns the CSS text, or null when nothing could be embedded.
 */
export function fontFaceCss(family, base64For) {
  const entry = fontTable()[family]
  if (!entry) return null
  const blocks = []
  for (const [weight, meta] of Object.entries(entry.weights)) {
    const base64 = base64For(meta.file)
    if (!base64) continue
    blocks.push(
      '    @font-face{font-family:"' +
        family +
        '";font-style:normal;font-weight:' +
        weight +
        ';src:url(data:font/woff2;base64,' +
        base64 +
        ') format("woff2")}',
    )
  }
  return blocks.length > 0 ? blocks.join('\n') : null
}

/**
 * One status line for the tools and the tab: which families are live and what
 * they weigh. A host with no vendored fonts says so rather than claiming type it
 * cannot draw.
 */
export function fontStatus() {
  const files = fontFiles()
  const families = Object.keys(fontTable())
  return {
    available: families.length > 0,
    families,
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    licences: families.map((family) => ({ family, licence: fontTable()[family].licence })).filter((entry) => entry.licence),
    note:
      families.length > 0
        ? 'Bundled OFL subsets: ' + families.join(', ') + '. `system` is always available for the machine\u2019s own stack.'
        : 'No vendored fonts on this host: designs must use the `system` family, and exports will differ between machines. Run `node packages/dsh-canvas/vendor/build.mjs`.',
  }
}
