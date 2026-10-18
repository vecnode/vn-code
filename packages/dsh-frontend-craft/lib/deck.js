/**
 * dsh-frontend-craft — the local direction deck.
 *
 * This is the answer to the one thing the open-source Impeccable repository does
 * not contain: its direction catalog. That catalog is served by the author's own
 * API and is the paid service's moat, so it cannot be vendored and copying it is
 * not licensed. This deck is OUR editorial content instead: eighteen visual
 * worlds an agent is unlikely to reach by asking a model for "seven directions",
 * each with a thesis and an honest risk.
 *
 * What it buys is the outside view. `fe_direction` deals the directions the agent
 * authored, then ONE challenger from here, chosen by the same hash as the hand, so
 * the agent has to judge a world it did not think of - and a declined challenger
 * still donates one discipline to the assigned direction.
 *
 * What it is not: a catalog. There are no comps, no imagery and no ranking; a card
 * is a name, a thesis, a risk and the modes it suits. Adding an entry is one object
 * in `deck.json`; the package check pins the file's shape.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The deck: `[{ id, name, thesis, risk, modes, family }]`. */
export const DECK = JSON.parse(readFileSync(path.join(here, 'deck.json'), 'utf8'))

/** The modes a card may declare. */
export const DECK_MODES = ['persuade', 'operate', 'read', 'experience']

/** Whether an entry suits a mode; an entry with no modes suits all of them. */
export function suitsMode(entry, mode) {
  return !Array.isArray(entry.modes) || entry.modes.length === 0 || entry.modes.includes(mode)
}

/**
 * One challenger for this hand: deterministic from the seed and the mode, and
 * never one of the directions the agent already authored.
 *
 * @returns the deck entry, or `null` when nothing suits the mode.
 */
export function challengerFor(seed, mode, authored = []) {
  const taken = new Set(authored.map((entry) => String(entry.name ?? entry).toLowerCase()))
  const pool = DECK.filter((entry) => suitsMode(entry, mode) && !taken.has(entry.name.toLowerCase()))
  if (pool.length === 0) return null
  const bytes = createHash('sha256').update(String(seed) + ':deck').digest()
  return pool[bytes[0] % pool.length]
}
