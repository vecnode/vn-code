/**
 * dsh-comfyui — the shipped example library.
 *
 * An example is a SPEC, not a frozen graph, and it lives as a folder with a
 * `project.json` so the same file can be read by a person, edited in place, and
 * compiled by `comfy_test`. Nothing here decides what the examples mean: the
 * directory listing is the catalog, so a new example is one folder and a
 * manifest entry that cannot drift, because there is no separate index to
 * forget.
 *
 * The library is deliberately ordered from "no model needed" to "needs a
 * checkpoint", because the first question on a new machine is whether anything
 * runs at all - and a 2 GB download must never be what stands between a person
 * and their first green tick.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the example folders live, beside this module. */
export const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url))

/** Read one JSON file, or throw with the path in the sentence. */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * The example library, sorted the way it should be tried.
 *
 * @param dir - the examples folder (injectable for the check).
 * @returns `[{ slug, title, description, tags, requires, nodes, file }]`.
 */
export function listExamples(dir = EXAMPLES_DIR) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'project.json')
    if (!existsSync(file)) continue
    let spec
    try {
      spec = readJson(file)
    } catch (error) {
      found.push({ slug: entry.name, title: entry.name, description: '', tags: [], requires: {}, nodes: 0, file, error: error.message })
      continue
    }
    found.push({
      slug: entry.name,
      title: typeof spec.title === 'string' && spec.title !== '' ? spec.title : entry.name,
      description: typeof spec.description === 'string' ? spec.description : '',
      tags: Array.isArray(spec.tags) ? spec.tags.map(String) : [],
      requires: spec.requires !== null && typeof spec.requires === 'object' ? spec.requires : {},
      nodes: Array.isArray(spec.nodes) ? spec.nodes.length : 0,
      file,
    })
  }
  const weight = (entry) => (entry.tags.includes('no-models') ? 0 : entry.tags.includes('needs-input') ? 2 : 1)
  return found.sort((left, right) => weight(left) - weight(right) || left.slug.localeCompare(right.slug))
}

/** One example's spec, or null. */
export function readExample(slug, dir = EXAMPLES_DIR) {
  const file = path.join(dir, String(slug), 'project.json')
  if (!existsSync(file)) return null
  return readJson(file)
}

/** Whether a slug names a shipped example. */
export function hasExample(slug, dir = EXAMPLES_DIR) {
  return existsSync(path.join(dir, String(slug), 'project.json'))
}

/** What one example needs, as one line for a table. */
export function requirementLine(example) {
  const models = example.requires !== null && typeof example.requires === 'object' && example.requires.models !== null && typeof example.requires.models === 'object' ? example.requires.models : {}
  const files = Object.entries(models).flatMap(([folder, list]) => (Array.isArray(list) ? list.map((name) => folder + '/' + name) : []))
  const inputs = example.requires !== null && typeof example.requires === 'object' && Array.isArray(example.requires.inputFiles) ? example.requires.inputFiles : []
  const parts = []
  if (files.length === 0) parts.push('no model')
  else parts.push(files.join(', '))
  if (inputs.length > 0) parts.push('input: ' + inputs.join(', '))
  return parts.join(' · ')
}
