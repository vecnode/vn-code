/**
 * dsh-canvas — the STYLE LIBRARY loader.
 *
 * Every `*.json` beside this file is one style pack, read at import time and
 * validated by `styleProblems` from `./apply.js`. A pack that does not validate is
 * SKIPPED with a warning rather than offered: a style the transform cannot apply
 * would be a look the model could ask for and not get, which is worse than a style
 * that is simply missing.
 *
 * The folder is the library: adding a look is adding a file, and the tracked check
 * (`check-canvas-node.mjs`) validates every pack, applies it to an archetype, and
 * asserts that the result still validates, keeps its geometry, and stays inside the
 * contrast gates the style itself declares.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyStyle, colourPlan, styleProblems, styleSwatch } from './apply.js'

const DIR = fileURLToPath(new URL('./', import.meta.url))

/** Read and validate every pack, sorted by `rank` then id. */
function load() {
  const packs = []
  let entries = []
  try {
    entries = readdirSync(DIR)
  } catch (err) {
    return packs
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(path.join(DIR, entry), 'utf8'))
      const problems = styleProblems(parsed)
      if (problems.length > 0) {
        console.warn('[dsh-canvas] style pack ' + entry + ' was skipped: ' + problems.join('; '))
        continue
      }
      packs.push(parsed)
    } catch (err) {
      console.warn('[dsh-canvas] style pack ' + entry + ' could not be read: ' + (err && err.message ? err.message : err))
    }
  }
  packs.sort((left, right) => (left.rank ?? 100) - (right.rank ?? 100) || left.id.localeCompare(right.id))
  return packs
}

const PACKS = load()

/** Every style, keyed by id. The shape `normalizeDocument` validates against. */
export const STYLES = Object.fromEntries(PACKS.map((pack) => [pack.id, pack]))

/** Every style, in gallery order. */
export const STYLE_LIST = PACKS

/** The style ids, in gallery order. */
export function styleIds() {
  return PACKS.map((pack) => pack.id)
}

/** One style by id, or null. */
export function styleById(id) {
  return Object.prototype.hasOwnProperty.call(STYLES, String(id)) ? STYLES[String(id)] : null
}

/** The gallery rows the browser needs: id, name, intent, swatch, rules and gates. */
export function styleGallery() {
  return PACKS.map((pack) => ({
    id: pack.id,
    name: pack.name,
    intent: pack.intent,
    rank: pack.rank ?? 100,
    swatch: styleSwatch(pack),
    do: (pack.rules && pack.rules.do) || [],
    dont: (pack.rules && pack.rules.dont) || [],
    gates: pack.gates ?? [],
    bestFor: pack.bestFor ?? [],
  }))
}

/** The whole table as a plain object for `normalizeDocument`'s `styles` option. */
export function styleTable() {
  return STYLES
}

export { applyStyle, colourPlan, styleProblems, styleSwatch }
