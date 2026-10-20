// vendor/shader-skills/build.mjs - the gokayfem/shader-skills corpus, vendored.
//
//   node vendor/shader-skills/build.mjs --from <upstream-tree>
//   node vendor/shader-skills/build.mjs --check
//
// WHY THIS EXISTS: Radiant supplies shaders that ARE the picture. This corpus
// supplies the other half - 20 reusable GLSL modules (`noise.glsl`,
// `sdf3d.glsl`, `tonemap.glsl`, ...), 11 compact TEMPLATES that start a shader,
// 11 finished gallery pieces and 14 written references. A template is not
// self-contained: it calls `warpedFbm`, `mixOklab`, `voronoiBorder` and expects
// the modules to be inlined. So the catalogue records each template's REQUIRED
// modules, computed from the sources: an identifier a template calls that a
// module defines is a dependency. That analysis is what lets `shader_kit` hand
// back a template together with the code it needs, and `shader_verify` compile
// it with `includes`.
//
// The `/gallery/*.png` previews are NOT vendored (7 MB): this row renders its own.
//
// LICENSING: the corpus is MIT (Copyright (c) 2026 gokayfem) and its CREDITS.md
// states that all GLSL is an original implementation, with techniques credited to
// their published sources. CREDITS.md and LICENSE both travel beside the bytes.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outRoot = path.join(packageRoot, 'lib', 'vendor', 'shader-skills')

export const SOURCE = {
  repo: 'gokayfem/shader-skills',
  commit: 'e09bc993bf04201f26c03c87c89210e9b472f526',
  url: 'https://github.com/gokayfem/shader-skills',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 gokayfem',
  note: 'GLSL stored byte-identical. Its dialect is the corpus harness, where iFrame is an int - see lib/verify.js.',
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * A GLSL source with its comments removed.
 *
 * The dependency and export scans run on THIS, not on the raw text. The corpus is
 * heavily documented and its comments name other modules' functions
 * ("see `saturate` in common", "after `hash12`"), so reading identifiers out of
 * comments invented ~9 false dependencies per template - enough to pull in the
 * whole library and, with two modules defining the same constant, to break the
 * include outright.
 */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/**
 * The names a file EXPORTS to another module: its functions, and its
 * `ALL_CAPS` constants.
 *
 * Lower-case constants are deliberately excluded. `sdf3d.glsl` declares
 * `const float k = ...`, and while `k` was treated as an export, every module
 * with a local variable called `k` appeared to depend on `sdf3d` - which closed
 * a cycle (`common` -> ... -> `sdf3d` -> ... -> `common`) and made the include
 * order unsolvable. A packaged shader library's cross-module surface is
 * functions and SHOUTED constants; a two-letter local is neither.
 */
export function exportsOf(source) {
  const functions = new Set()
  const constants = new Set()
  const text = stripComments(source)
  for (const match of text.matchAll(/^\s*(?:const\s+)?(?:float|int|uint|bool|void|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4|bvec2|bvec3|bvec4)\s+([A-Za-z_]\w*)\s*\(/gm)) {
    functions.add(match[1])
  }
  for (const match of text.matchAll(/^\s*(?:const\s+)?(?:float|int|uint|bool|vec2|vec3|vec4|mat2|mat3|mat4)\s+([A-Z][A-Z0-9_]*)\s*=/gm)) {
    constants.add(match[1])
  }
  for (const match of text.matchAll(/^\s*#define\s+([A-Za-z_]\w*)/gm)) {
    constants.add(match[1])
  }
  return [...functions, ...constants].sort()
}

/** Every identifier CALLED as a function in a file. */
export function callsOf(source) {
  const names = new Set()
  for (const match of stripComments(source).matchAll(/([A-Za-z_]\w*)\s*\(/g)) names.add(match[1])
  return [...names].sort()
}

/** Every identifier a file mentions, whatever it does with it. */
export function identifiersOf(source) {
  const names = new Set()
  for (const match of stripComments(source).matchAll(/\b([A-Za-z_]\w*)\b/g)) names.add(match[1])
  return names
}

/**
 * The module closure a source needs, dependencies FIRST.
 *
 * A module is an include fragment: `noise.glsl` calls `hash12` (from
 * `hash.glsl`), `atmosphere.glsl` calls `iSphere` (from `intersect.glsl`), and
 * most of them use `PI`, `TAU` and `saturate` from `common.glsl`. So the
 * dependency relation is TRANSITIVE and its ORDER is load-bearing - GLSL has no
 * forward declarations, so a module included before the one it calls fails with
 * "no matching overloaded function found", which is exactly what happened when
 * this was a flat, alphabetical list.
 *
 * A name a module mentions that another module exports is a dependency. That is
 * a heuristic, and the compile check is its judge: every template is compiled
 * with the closure this returns, so a wrong edge fails loudly rather than
 * quietly shipping a broken include list.
 *
 * @param source - the file whose dependencies are wanted.
 * @param modules - module entries that carry their `text`: `{ id, exports, text }`.
 * @param selfId - the module's own id, which is never its own dependency.
 * @returns `{ order, roots }` - `order` has dependencies before their dependents,
 *   and `roots` are the modules the source mentions directly.
 */
export function closureOf(source, modules, selfId = null) {
  const moduleById = new Map(modules.map((entry) => [entry.id, entry]))
  const exportsById = new Map(modules.map((entry) => [entry.id, new Set(entry.exports)]))
  const mentions = identifiersOf(source)
  const order = []
  const done = new Set()
  const visiting = new Set()
  const cycles = new Set()

  const visit = (id) => {
    // A module is never its own dependency: without this, `sdf3d` was pulled back
    // in through `sdf2d` (which uses `sdSphere`) and the catalogue listed it
    // inside its own `requires`.
    if (id === selfId) return
    if (done.has(id)) return
    if (visiting.has(id)) {
      cycles.add(id)
      return
    }
    visiting.add(id)
    const entry = moduleById.get(id)
    const own = identifiersOf(entry?.text ?? '')
    for (const other of modules) {
      if (other.id === id || other.id === selfId) continue
      let needed = false
      for (const name of exportsById.get(other.id)) {
        if (own.has(name)) {
          needed = true
          break
        }
      }
      if (needed) visit(other.id)
    }
    visiting.delete(id)
    done.add(id)
    order.push(id)
  }

  const roots = modules
    .filter((entry) => entry.id !== selfId)
    .filter((entry) => {
      for (const name of exportsById.get(entry.id)) if (mentions.has(name)) return true
      return false
    })
    .map((entry) => entry.id)
    .sort()

  for (const id of roots) visit(id)
  return { order, roots, cycles: [...cycles].sort() }
}

/** The `//!` summary line a module carries, which is what a catalogue shows. */
function summaryOf(source) {
  const match = /^\/\/!\s*(.*)$/m.exec(String(source))
  return match === null ? '' : match[1].trim()
}

/** The first `# heading` of a markdown reference. */
function headingOf(text) {
  const match = /^#\s+(.+)$/m.exec(String(text))
  return match === null ? '' : match[1].trim()
}

/** The title a gallery piece declares on its first comment line. */
function galleryTitle(source) {
  const match = /^\/\/\s*([^:\n]+?)\s*:/m.exec(String(source))
  if (match !== null) return match[1].trim()
  const first = /^\/\/\s*(.+)$/m.exec(String(source))
  return first === null ? '' : first[1].trim()
}

/** `// @render time=2.0` and `// @variant DEBUG_MODE=1`, the corpus's own annotations. */
function annotationsOf(source) {
  const text = String(source)
  const out = { renderTime: null, variants: [] }
  const time = /@render\s+time=([-\d.]+)/.exec(text)
  if (time !== null) out.renderTime = Number(time[1])
  for (const match of text.matchAll(/@variant\s+([A-Za-z_]\w*=\S+)/g)) out.variants.push(match[1])
  return out
}

function listGlsl(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.glsl')).sort()
}

function derive(tree) {
  const files = new Map()
  const skillsRoot = path.join(tree, 'skills', 'shader-art-coding')

  // ---- module library ----
  const modules = []
  const moduleTexts = new Map()
  for (const name of listGlsl(path.join(skillsRoot, 'glsl'))) {
    const id = path.basename(name, '.glsl')
    const source = readFileSync(path.join(skillsRoot, 'glsl', name), 'utf8')
    files.set('modules/' + id + '.glsl', source)
    moduleTexts.set(id, source)
    modules.push({ id, file: 'modules/' + id + '.glsl', bytes: Buffer.byteLength(source), sha256: sha256(source), summary: summaryOf(source), exports: exportsOf(source) })
  }
  // The closure walker needs each module's TEXT; the catalogue does not, so the
  // text rides on a copy and never reaches catalog.json.
  const withText = modules.map((entry) => ({ ...entry, text: moduleTexts.get(entry.id) ?? '' }))
  for (const entry of modules) {
    entry.requires = closureOf(moduleTexts.get(entry.id) ?? '', withText, entry.id).order
  }

  // ---- templates, with their required modules (transitive, dependencies first) ----
  //
  // A template is the COMPACT form: the same shader with the library left out,
  // meant to be assembled by the corpus's own `scripts/glsl_tools.py bundle`.
  // `requires` is this package's best-effort reading of what it needs, and it is
  // deliberately NOT claimed to be sufficient: measured, naive concatenation of
  // the closure fails for every template (module constants are expanded by the
  // generator, and `raymarch.glsl` expects the *caller* to define `map()`).
  // What IS verified is the gallery piece, which is the same shader with the
  // library already bundled - so each template records the counterpart that
  // proves its code runs.
  const gallerySources = new Map()
  for (const name of listGlsl(path.join(tree, 'gallery'))) {
    gallerySources.set(path.basename(name, '.glsl'), readFileSync(path.join(tree, 'gallery', name), 'utf8'))
  }

  const templates = []
  for (const name of listGlsl(path.join(skillsRoot, 'templates'))) {
    const id = path.basename(name, '.glsl')
    const source = readFileSync(path.join(skillsRoot, 'templates', name), 'utf8')
    files.set('templates/' + id + '.glsl', source)
    const closure = closureOf(source, withText)
    const gallerySource = gallerySources.get(id) ?? null
    // The template's own first body line, verbatim in the bundled page? That is
    // the structural proof that the two are the same shader.
    const firstBody =
      source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('//'))[0] ?? null
    templates.push({
      id,
      file: 'templates/' + id + '.glsl',
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
      title: galleryTitle(source),
      requires: closure.order,
      direct: closure.roots,
      requiresConfidence: 'best-effort: assembled by the corpus own glsl_tools.py bundle, not by this package',
      gallery: gallerySource === null ? null : 'gallery:' + id,
      bodyInGallery: firstBody !== null && gallerySource !== null ? gallerySource.includes(firstBody) : false,
      ...annotationsOf(source),
    })
  }

  // ---- gallery ----
  const gallery = []
  for (const name of listGlsl(path.join(tree, 'gallery'))) {
    const id = path.basename(name, '.glsl')
    const source = readFileSync(path.join(tree, 'gallery', name), 'utf8')
    files.set('gallery/' + id + '.glsl', source)
    gallery.push({
      id,
      file: 'gallery/' + id + '.glsl',
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
      title: galleryTitle(source),
      dialect: 'shader-skills',
      ...annotationsOf(source),
    })
  }

  // ---- written references ----
  const references = []
  const refDir = path.join(skillsRoot, 'references')
  if (existsSync(refDir)) {
    for (const name of readdirSync(refDir).filter((entry) => entry.endsWith('.md')).sort()) {
      const id = path.basename(name, '.md')
      const text = readFileSync(path.join(refDir, name), 'utf8')
      files.set('references/' + id + '.md', text)
      references.push({ id, file: 'references/' + id + '.md', bytes: Buffer.byteLength(text), sha256: sha256(text), title: headingOf(text) })
    }
  }

  // ---- the licence and its credits travel with the GLSL; nothing else does.
  //
  // The corpus's own `SKILL.md` is deliberately NOT vendored: it is a second,
  // unreachable copy of guidance this package already ships as five skills, and
  // shipping prose nothing can read is exactly the dead weight a catalogue should
  // not carry. `CREDITS.md` is not optional - it is where that corpus records that
  // every technique came from published work and that no Shadertoy source was
  // copied - and `LICENSE` is the grant.
  for (const [relative, upstream] of [
    ['CREDITS.md', path.join(tree, 'CREDITS.md')],
    ['LICENSE', path.join(tree, 'LICENSE')],
  ]) {
    if (existsSync(upstream)) files.set(relative, readFileSync(upstream, 'utf8'))
  }

  const catalog = {
    source: SOURCE,
    generatedBy: 'packages/dsh-shaders/vendor/shader-skills/build.mjs',
    counts: { modules: modules.length, templates: templates.length, gallery: gallery.length, references: references.length },
    modules,
    templates,
    gallery,
    references,
  }
  files.set('catalog.json', JSON.stringify(catalog, null, 2) + '\n')
  files.set('SOURCE.json', JSON.stringify(SOURCE, null, 2) + '\n')
  return { files, catalog }
}

async function writeAll(entries) {
  await fsp.rm(outRoot, { recursive: true, force: true })
  await fsp.mkdir(outRoot, { recursive: true })
  for (const [relative, content] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const target = path.join(outRoot, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content)
  }
}

function check() {
  const catalogPath = path.join(outRoot, 'catalog.json')
  if (!existsSync(catalogPath)) {
    console.log('FAIL the vendored shader-skills tree is missing its catalog.json')
    process.exit(1)
  }
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const problems = []
  for (const group of ['modules', 'templates', 'gallery', 'references']) {
    for (const entry of catalog[group]) {
      const file = path.join(outRoot, entry.file)
      if (!existsSync(file)) {
        problems.push('missing ' + entry.file)
        continue
      }
      const bytes = readFileSync(file)
      if (bytes.length !== entry.bytes) problems.push(entry.file + ': ' + bytes.length + ' bytes on disk, catalog says ' + entry.bytes)
      if (sha256(bytes) !== entry.sha256) problems.push(entry.file + ': sha256 does not match the catalog')
    }
  }
  // Re-derive the dependencies from the committed sources: a module or template
  // that gained or lost a call must not keep a stale `requires`, and the ORDER of
  // `requires` is part of the contract (GLSL has no forward declarations).
  const withText = catalog.modules.map((entry) => ({ ...entry, text: readFileSync(path.join(outRoot, entry.file), 'utf8') }))
  for (const module of catalog.modules) {
    const order = closureOf(withText.find((entry) => entry.id === module.id).text, withText, module.id).order
    if (order.join(',') !== module.requires.join(',')) problems.push(module.file + ': requires is ' + module.requires.join(',') + ' but the source needs ' + order.join(','))
  }
  const galleryById = new Map(catalog.gallery.map((entry) => [entry.id, readFileSync(path.join(outRoot, entry.file), 'utf8')]))
  for (const template of catalog.templates) {
    const source = readFileSync(path.join(outRoot, template.file), 'utf8')
    const order = closureOf(source, withText).order
    if (order.join(',') !== template.requires.join(',')) problems.push(template.file + ': requires is ' + template.requires.join(',') + ' but the source needs ' + order.join(','))
    // The structural link to the compiled counterpart is a recorded FACT, so a
    // template whose body drifts out of its gallery page must say so.
    const firstBody = source.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'))[0] ?? null
    const gallerySource = galleryById.get(template.id)
    const inGallery = firstBody !== null && gallerySource !== undefined ? gallerySource.includes(firstBody) : false
    if (inGallery !== template.bodyInGallery) problems.push(template.file + ': bodyInGallery is recorded as ' + String(template.bodyInGallery) + ' but is ' + String(inGallery))
  }
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 20)) console.log('FAIL ' + problem)
    console.log('FAIL ' + problems.length + ' problem(s) in the vendored shader-skills tree')
    process.exit(1)
  }
  console.log(
    'ok   shader-skills: ' +
      String(catalog.counts.modules) +
      ' modules, ' +
      String(catalog.counts.templates) +
      ' templates, ' +
      String(catalog.counts.gallery) +
      ' gallery, ' +
      String(catalog.counts.references) +
      ' references',
  )
}

async function run() {
  const args = process.argv.slice(2)
  if (args.includes('--check')) {
    check()
    return
  }
  const fromIndex = args.indexOf('--from')
  if (fromIndex < 0) {
    console.log('usage: node vendor/shader-skills/build.mjs --from <upstream-tree> | --check')
    process.exit(2)
  }
  const tree = path.resolve(args[fromIndex + 1])
  if (!existsSync(path.join(tree, 'gallery'))) {
    console.log('FAIL ' + tree + ' has no gallery/ directory')
    process.exit(1)
  }
  const { files, catalog } = derive(tree)
  await writeAll([...files.entries()])
  console.log(
    'wrote ' + String(catalog.counts.modules) + ' modules, ' + String(catalog.counts.templates) + ' templates, ' + String(catalog.counts.gallery) + ' gallery, ' + String(catalog.counts.references) + ' references',
  )
  const needs = catalog.templates.filter((entry) => entry.requires.length > 0)
  console.log('templates needing modules: ' + String(needs.length) + ' of ' + String(catalog.templates.length))
  for (const template of needs.slice(0, 4)) console.log('  ' + template.id + ' requires ' + template.requires.join(', '))
  check()
}

// Only run when executed, so the analysis above can be imported by a probe or a
// check without building anything.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  run().catch((err) => {
    console.log('FAIL ' + String((err && err.stack) || err))
    process.exit(1)
  })
}
