/**
 * dsh-canvas — the ARCHETYPES: the craft made executable.
 *
 * `canvas_new { preset, archetype }` and the tab's "+ New" gallery both start
 * here. A model handed a blank page composes from nothing and the result is a
 * wide title in a corner; a model handed one of these starts from a composition
 * that already has hierarchy, a margin rhythm and a complete token block, and
 * spends its effort on the WORDS rather than on re-inventing the geometry. Each
 * document below is a real design for its first preset's exact pixel canvas -
 * not a skeleton, not a placeholder - so filling in the copy is the whole task.
 *
 * Every file is data, not code: one JSON document per archetype beside this
 * module, read eagerly at import (they are small, and a lazy read would turn a
 * missing file into a failure in the middle of a design turn). They are the same
 * documents a model writes, so they go through the SAME validator:
 * `scripts/checks/check-canvas-node.mjs` normalizes every one of them with
 * `normalizeDocument`, lays it out, and lints it against its first preset - a
 * composition here that warns is a bug in this folder, not a quirk of the check.
 *
 * An `image` node in these documents is a RESERVED SLOT: its `src` names the
 * asset the model is expected to import (the description says so), so an export
 * that never supplied it reports MISSING_ASSET rather than drawing nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The folder these documents live in. */
const DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every `*.json` beside this module, parsed and sorted by id. */
export const ARCHETYPES = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')))
  .filter((entry) => entry && typeof entry.id === 'string' && entry.document)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((entry) => ({
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : entry.id,
    description: typeof entry.description === 'string' ? entry.description : '',
    presets: Array.isArray(entry.presets) ? entry.presets.slice() : [],
    document: entry.document,
  }))

/** One archetype by id, or null. */
export function archetypeById(id) {
  return ARCHETYPES.find((entry) => entry.id === String(id)) ?? null
}

/** Every archetype id, in reading order. */
export function archetypeIds() {
  return ARCHETYPES.map((entry) => entry.id)
}
