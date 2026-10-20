/**
 * dsh-shaders — the vendored corpora, queried.
 *
 * Three trees, one id space:
 *
 *   `radiant/<id>`        a page from pbakaus/radiant, plus the fragment source
 *                         extracted from it (69 sources across 79 pages ... the
 *                         numbers are in the catalogue, not here).
 *   `gallery/<id>`        a finished piece from gokayfem/shader-skills.
 *   `module/<id>`         one of its 20 reusable GLSL modules.
 *   `template/<id>`       one of its 11 compact templates, with the modules it
 *                         reads as needing (`requires`, best effort) and the
 *                         gallery piece that proves the same shader runs.
 *
 * Nothing here invents an example: a catalogue that is missing says so, and an id
 * that does not exist lists the ids that do.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.join(here, 'vendor')

/** The four sources, and where each keeps its catalogue. */
export const SOURCES = {
  radiant: { root: path.join(VENDOR, 'radiant'), catalog: 'catalog.json' },
  skills: { root: path.join(VENDOR, 'shader-skills'), catalog: 'catalog.json' },
  links: { root: path.join(VENDOR, 'glsl-links'), catalog: 'links.json' },
}

const cache = new Map()

/** One catalogue, parsed once per process. `null` when the tree is not installed. */
export function catalogOf(name, options = {}) {
  const root = options.root ?? SOURCES[name].root
  const key = name + ':' + root
  if (cache.has(key)) return cache.get(key)
  const file = path.join(root, SOURCES[name].catalog)
  let value = null
  if (existsSync(file)) {
    try {
      value = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      value = null
    }
  }
  cache.set(key, value)
  return value
}

/** Read one file inside a vendored tree, refusing anything that escapes it. */
export function vendoredFile(name, relative, options = {}) {
  const root = options.root ?? SOURCES[name].root
  const file = path.resolve(root, relative)
  const within = path.relative(root, file)
  if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('refusing to read outside the vendored tree: ' + relative)
  if (!existsSync(file)) throw new Error('no such vendored file: ' + relative)
  return readFileSync(file, 'utf8')
}

/** What this row knows, for `shader_kit` with no id and for the tab's index. */
export function summary() {
  const radiant = catalogOf('radiant')
  const skills = catalogOf('skills')
  const links = catalogOf('links')
  return {
    clear: radiant !== null || skills !== null,
    radiant:
      radiant === null
        ? null
        : {
            repo: radiant.source.repo,
            commit: radiant.source.commit,
            license: radiant.source.license,
            pages: radiant.counts.pages,
            pagesWithSource: radiant.counts.pagesWithSource,
            sources: radiant.counts.sources,
            byTechnique: radiant.counts.byTechnique,
          },
    skills:
      skills === null
        ? null
        : {
            repo: skills.source.repo,
            commit: skills.source.commit,
            license: skills.source.license,
            modules: skills.counts.modules,
            templates: skills.counts.templates,
            gallery: skills.counts.gallery,
            references: skills.counts.references,
            // The dialect distinction is a fact about the corpus, not a preference.
            dialect: 'shader-skills (iFrame is an int)',
          },
    links: links === null ? null : { repo: links.source.repo, links: links.counts.links, categories: links.categories },
  }
}

/** Every example this row can hand back, as an index. */
export function listExamples(options = {}) {
  const out = []
  const radiant = catalogOf('radiant')
  if (radiant !== null) {
    for (const entry of radiant.examples) {
      if (entry.sources.length === 0) continue
      out.push({
        id: 'radiant/' + entry.id,
        source: 'radiant',
        title: entry.title,
        technique: entry.technique,
        dialect: entry.dialect,
        params: entry.params,
        sources: entry.sources.length,
        hasPage: true,
      })
    }
  }
  const skills = catalogOf('skills')
  if (skills !== null) {
    for (const entry of skills.gallery) {
      out.push({ id: 'gallery/' + entry.id, source: 'skills', title: entry.title, technique: 'gallery', dialect: entry.dialect, params: [], sources: 1, hasPage: false })
    }
    for (const entry of skills.templates) {
      out.push({ id: 'template/' + entry.id, source: 'skills', title: entry.title, technique: 'template', dialect: 'shader-skills', params: [], sources: 1, hasPage: false, requires: entry.requires })
    }
    for (const entry of skills.modules) {
      out.push({ id: 'module/' + entry.id, source: 'skills', title: entry.summary === '' ? entry.id : entry.summary, technique: 'module', dialect: 'module', params: [], sources: 1, hasPage: false })
    }
  }
  return out
}

/**
 * Search the index.
 *
 * @param options - `{ query, technique, source, limit }`.
 */
export function search(options = {}) {
  const query = String(options.query ?? '').toLowerCase().trim()
  const technique = options.technique === undefined ? null : String(options.technique)
  const source = options.source === undefined ? null : String(options.source)
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(200, Number(options.limit))) : 40
  let entries = listExamples()
  if (source !== null) entries = entries.filter((entry) => entry.source === source)
  if (technique !== null) entries = entries.filter((entry) => entry.technique === technique || entry.dialect === technique)
  if (query !== '') {
    entries = entries.filter((entry) => (entry.id + ' ' + entry.title + ' ' + (entry.requires ?? []).join(' ')).toLowerCase().includes(query))
  }
  return { total: entries.length, entries: entries.slice(0, limit) }
}

/**
 * One example, with its source.
 *
 * A template comes back with its `requires` modules resolved into `includes`,
 * because a template on its own does not compile - but `includesTrusted` is
 * false, because this package did not assemble them and does not claim they are
 * sufficient: the corpus's own `glsl_tools.py bundle` is what does that.
 *
 * @returns `{ found: true, ... }` or `{ found: false, message, ids }`.
 */
export function getExample(id, options = {}) {
  const value = String(id ?? '').trim()
  const [kind, name] = value.includes('/') ? [value.slice(0, value.indexOf('/')), value.slice(value.indexOf('/') + 1)] : [value, '']
  if (kind === 'radiant') {
    const catalog = catalogOf('radiant')
    if (catalog === null) return { found: false, message: 'the Radiant corpus is not installed in this package' }
    const entry = catalog.examples.find((candidate) => candidate.id === name)
    if (entry === undefined) return notFound(value, catalog.examples.filter((candidate) => candidate.sources.length > 0).map((candidate) => 'radiant/' + candidate.id))
    const primary = entry.sources.find((candidate) => candidate.name === entry.primary) ?? entry.sources[0] ?? null
    return {
      found: true,
      id: value,
      source: 'radiant',
      title: entry.title,
      technique: entry.technique,
      dialect: entry.dialect ?? 'es100',
      params: entry.params,
      page: entry.page,
      sourceText: primary === null ? null : vendoredFile('radiant', primary.file),
      file: primary === null ? null : primary.file,
      allSources: entry.sources,
      compile: entry.compile,
      license: catalog.source,
      note: primary === null ? entry.unreadableReason ?? 'this page has no extractable fragment source' : null,
    }
  }
  if (kind === 'gallery' || kind === 'module' || kind === 'template') {
    const catalog = catalogOf('skills')
    if (catalog === null) return { found: false, message: 'the shader-skills corpus is not installed in this package' }
    const list = kind === 'gallery' ? catalog.gallery : kind === 'module' ? catalog.modules : catalog.templates
    const entry = list.find((candidate) => candidate.id === name)
    if (entry === undefined) return notFound(value, list.map((candidate) => kind + '/' + candidate.id))
    const sourceText = vendoredFile('skills', entry.file)
    const result = {
      found: true,
      id: value,
      source: 'skills',
      kind,
      title: entry.title ?? entry.summary ?? entry.id,
      dialect: kind === 'module' ? 'module' : 'shader-skills',
      sourceText,
      file: entry.file,
      license: catalog.source,
    }
    if (kind === 'template') {
      result.requires = entry.requires
      result.direct = entry.direct
      result.includesTrusted = false
      result.requiresNote = entry.requiresConfidence
      result.includes = (entry.requires ?? []).map((moduleId) => {
        const module = catalog.modules.find((candidate) => candidate.id === moduleId)
        return { name: moduleId, source: module === undefined ? '' : vendoredFile('skills', module.file) }
      })
      result.provenBy = entry.gallery
      result.bodyInGallery = entry.bodyInGallery
      result.note =
        'This is the compact form: assembling it is the corpus own job (scripts/glsl_tools.py bundle), and these `includes` are this package reading of what it needs - not a guarantee. The same shader with the library bundled is `' +
        String(entry.gallery) +
        '`, and that one is compiled by the check.'
    }
    if (kind === 'module') {
      result.exports = entry.exports
      result.summary = entry.summary
      result.requires = entry.requires
    }
    return result
  }
  return notFound(value, ['radiant/<id>', 'gallery/<id>', 'module/<id>', 'template/<id>'])
}

function notFound(id, ids) {
  return { found: false, message: 'no example called ' + JSON.stringify(id) + '. Ids look like radiant/event-horizon, gallery/ocean, module/noise, template/terrain.', ids: ids.slice(0, 40) }
}

/** The curated reference links, optionally filtered. */
export function listLinks(options = {}) {
  const catalog = catalogOf('links')
  if (catalog === null) return { available: false, message: 'the link index is not installed in this package', links: [] }
  const query = String(options.query ?? '').toLowerCase().trim()
  const category = options.category === undefined ? null : String(options.category)
  let links = catalog.links
  if (category !== null) links = links.filter((entry) => entry.category.toLowerCase() === category.toLowerCase())
  if (query !== '') links = links.filter((entry) => (entry.title + ' ' + entry.description + ' ' + entry.url + ' ' + entry.category).toLowerCase().includes(query))
  return { available: true, total: links.length, categories: catalog.categories, links: links.slice(0, 60), source: catalog.source }
}

/** One page's original HTML, for the sandboxed frame route. */
export function pageOf(id, options = {}) {
  const catalog = catalogOf('radiant', options)
  if (catalog === null) return null
  const entry = catalog.examples.find((candidate) => candidate.id === String(id))
  if (entry === undefined) return null
  return { entry, html: vendoredFile('radiant', entry.page, options) }
}
