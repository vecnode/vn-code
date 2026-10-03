/**
 * dsh-canvas — the HOUSE GALLERY loader.
 *
 * Every `*.json` beside this file is one EXAMPLE: a proven combination of a
 * destination preset, an archetype's composition and a style's look, with the copy
 * that belongs in it and a sentence saying when to reach for it. The files are
 * GENERATED from the library by `vendor/examples.mjs` (and a tracked check fails when
 * they are stale), so an example can never point at an archetype or a style that has
 * moved on.
 *
 * Which of the three things an example is NOT matters: it is not a new language
 * feature, not a preset and not a style. It is the CHOICE - the one part of a design
 * a library cannot make for you - written down, so that "make me a launch card" can
 * start from a proven answer instead of a blank canvas.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('./', import.meta.url))

/** Read every example, sorted by id. */
function load() {
  const rows = []
  let entries = []
  try {
    entries = readdirSync(DIR)
  } catch (err) {
    return rows
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(path.join(DIR, entry), 'utf8'))
      if (typeof parsed.id !== 'string' || !parsed.document) {
        console.warn('[dsh-canvas] example ' + entry + ' was skipped: it names no id or carries no document')
        continue
      }
      rows.push(parsed)
    } catch (err) {
      console.warn('[dsh-canvas] example ' + entry + ' could not be read: ' + (err && err.message ? err.message : err))
    }
  }
  return rows
}

const EXAMPLES = load()

/** Every example, in gallery order. */
export const EXAMPLE_LIST = EXAMPLES

/** One example by id, or null. */
export function exampleById(id) {
  const wanted = String(id ?? '')
  return EXAMPLES.find((entry) => entry.id === wanted) ?? null
}

/** The example ids. */
export function exampleIds() {
  return EXAMPLES.map((entry) => entry.id)
}

/**
 * The gallery rows the browser and the model read: what it is, when to use it, which
 * preset/archetype/style it was built from, and the copy to write into it.
 *
 * THE DOCUMENT TRAVELS TOO (alpha.10), and it is what lets the tab's own New
 * gallery OPEN an example without a round trip: the browser cannot lay an example
 * out from a title and a preset, and asking the host for eight documents one at a
 * time would be eight round trips for data this file already has in memory. The
 * cost is stated: the payload grows by the examples' own JSON (tens of KB), and
 * `exampleLines()` - what the MODEL reads - still carries no document, so a tool
 * answer stays prose.
 */
export function exampleGallery() {
  return EXAMPLES.map((entry) => ({
    id: entry.id,
    title: entry.title,
    intent: entry.intent,
    preset: entry.preset,
    archetype: entry.archetype,
    style: entry.style,
    copy: entry.copy ?? null,
    nodes: Array.isArray(entry.document.layers) ? entry.document.layers.length : 0,
    document: entry.document,
  }))
}

/** The gallery as text, for a tool answer. */
export function exampleLines() {
  return exampleGallery()
    .map((entry) => '  - ' + entry.id + '  ' + entry.title + '  (' + entry.preset + ' + ' + entry.archetype + ' + ' + entry.style + ')  ' + entry.intent)
    .join('\n')
}
