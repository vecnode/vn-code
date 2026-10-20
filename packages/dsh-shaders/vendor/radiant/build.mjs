// vendor/radiant/build.mjs - the Radiant corpus, vendored and re-derivable.
//
//   node vendor/radiant/build.mjs --from <upstream-tree>   # (re)generate + verify
//   node vendor/radiant/build.mjs --check                  # offline, no upstream tree
//
// WHY THIS EXISTS: the plugin's usefulness rests on 107 real, working shader
// pages and the 69 fragment sources inside them, and a corpus nobody can
// re-derive is a corpus nobody can trust. So the pages are stored BYTE
// IDENTICAL, the extracted sources are regenerated from them, and `--check`
// re-runs the whole derivation from the committed bytes and fails on any drift.
// It reaches no network: `--from` is a tree the maintainer already has.
//
// WHAT IS NOT VENDORED: the 91 gallery previews (22.6 MB of .webp). This row
// renders its own thumbnails from the shader, on demand, into a content-
// addressed cache - which is also better evidence that the shader runs.
//
// The extraction rules are measured, not invented: 62 pages spell their fragment
// source as an array of string literals joined by newlines and 10 as a template
// literal; `lipstick-smear` names its eight passes `FS_ADVECT`, `FS_DIV`, ...;
// and `shattered-plains` opens its array with a ternary, so it is honestly
// reported as unreadable instead of guessed at.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outRoot = path.join(packageRoot, 'lib', 'vendor', 'radiant')

/** The pin. Changing any of these means the catalogue must be regenerated. */
export const SOURCE = {
  repo: 'pbakaus/radiant',
  commit: '59e9f48c0ad9a3db2fbeb8898b4390d5a1eabb40',
  url: 'https://github.com/pbakaus/radiant',
  license: 'MIT',
  copyright: 'Copyright (c) 2025 Paul Bakaus',
  note: 'Pages are stored byte-identical. Fragment sources are extracted from them, and the derivation is re-run by --check.',
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', 0: '\0', $: '$' }

function readLiteral(text, start) {
  const quote = text[start]
  let out = ''
  let index = start + 1
  while (index < text.length) {
    const ch = text[index]
    if (ch === '\\') {
      const next = text[index + 1]
      if (next === undefined) return null
      out += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : next
      index += 2
      continue
    }
    if (ch === quote) return { value: out, end: index + 1 }
    if (quote === '`' && ch === '$' && text[index + 1] === '{') return null
    if (quote !== '`' && (ch === '\n' || ch === '\r')) return null
    out += ch
    index += 1
  }
  return null
}

/**
 * Read a `[ 'a', 'b' ]` array of literals, starting at its `[`.
 *
 * STRICT on purpose: whitespace, commas and string literals only. Anything else -
 * an identifier, a spread, a ternary, a nested array - means the array is not a
 * list of lines, and the page is reported unreadable rather than extracted with a
 * hole in it. Measured: a tolerant scanner let `outsideDrops` in, and the resulting
 * `.frag` had ` outside drops` on its own line, which is a fragment that compiles
 * nowhere and looks like the author's mistake.
 *
 * @returns `{ values, end }`, or `null` when an element is not a literal.
 */
function readArrayLiteral(text, start) {
  const values = []
  let index = start + 1
  while (index < text.length) {
    const ch = text[index]
    if (ch === "'" || ch === '"' || ch === '`') {
      const literal = readLiteral(text, index)
      if (literal === null) return null
      values.push(literal.value)
      index = literal.end
      continue
    }
    if (ch === ']') return { values, end: index + 1 }
    // A JS comment between elements is part of the source, not of the shader:
    // measured, `'…',  // sharpen the twinkle` rejected 12 pages that are perfectly
    // ordinary arrays.
    if (ch === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      if (close < 0) return null
      index = close + 2
      continue
    }
    if (ch === ',' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      index += 1
      continue
    }
    return null
  }
  return null
}

/**
 * Every fragment source in one page. Never evaluates any part of the page: a
 * template that interpolates is reported, not run.
 * @returns `{ sources: [{ name, shape, source }], unreadable }`
 */
export function extractFragments(html) {
  const text = String(html)
  const assignment = /(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*/g
  const sources = []
  const seen = new Set()
  let unreadable = false
  let match
  while ((match = assignment.exec(text)) !== null) {
    const name = match[1]
    if (!/frag/i.test(name) && !/^fs([_A-Z0-9]|$)/i.test(name)) continue
    const start = match.index + match[0].length
    const first = text[start]
    let source = null
    let shape = null
    if (first === '`') {
      const literal = readLiteral(text, start)
      if (literal === null) {
        unreadable = true
        continue
      }
      source = literal.value
      shape = 'template'
    } else if (first === '[') {
      const read = readArrayLiteral(text, start)
      if (read === null || read.values.length === 0) {
        unreadable = true
        continue
      }
      source = read.values.join('\n')
      shape = 'array'
    } else {
      continue
    }
    if (source.trim() === '') continue
    const key = name + '\u0000' + source
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({ name, shape, source })
  }
  return { sources, unreadable }
}

/** Which of a page's sources makes the picture on screen. */
export function primarySource(sources) {
  if (sources.length === 0) return null
  const exact = sources.find((entry) => /^(fragSrc|mainFragSrc|fragmentShaderSource|fragmentShader|fs)$/i.test(entry.name))
  if (exact !== undefined) return exact
  const display = sources.find((entry) => /display/i.test(entry.name))
  if (display !== undefined) return display
  return sources[sources.length - 1]
}

/** The rendering technique a page uses, from the context it asks for. */
export function techniqueOf(html) {
  const webgl2 = /getContext\(\s*['"]webgl2/.test(html)
  const webgl1 = /getContext\(\s*['"]webgl['"]/.test(html)
  const canvas2d = /getContext\(\s*['"]2d['"]/.test(html)
  if (webgl2) return 'webgl2'
  if (webgl1 && canvas2d) return 'hybrid'
  if (webgl1) return 'webgl1'
  if (canvas2d) return 'canvas2d'
  return 'unknown'
}

/** The title a page declares, or a title-cased id. */
function titleOf(html, id) {
  const match = /<title>([^<]*)<\/title>/i.exec(html)
  if (match !== null && match[1].trim() !== '') return match[1].trim()
  return id.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/** The `postMessage` parameter names a page accepts. */
function paramsOf(html) {
  const names = new Set()
  for (const match of html.matchAll(/case\s+['"]([A-Z][A-Z0-9_]*)['"]\s*:/g)) names.add(match[1])
  return [...names].sort()
}

/**
 * Anything in a page that could reach off this machine.
 *
 * The rule is about EGRESS, not about text: a URL inside a comment is harmless
 * and is not reported, while a script, style, image or network call that would
 * fetch one is.
 * @returns `[{ kind, detail }]`
 */
export function offlineIssues(html) {
  const issues = []
  const text = String(html)
  const external = (value) => value !== '' && !/^(data:|#|\.\/|\.\.\/)/i.test(value) && (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//'))
  for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi)) {
    if (external(match[1])) issues.push({ kind: 'script-src', detail: match[1] })
  }
  for (const match of text.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)) {
    if (external(match[1])) issues.push({ kind: 'link-href', detail: match[1] })
  }
  for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi)) {
    if (external(match[1])) issues.push({ kind: 'img-src', detail: match[1] })
  }
  for (const match of text.matchAll(/\burl\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    if (external(match[1].trim())) issues.push({ kind: 'css-url', detail: match[1].trim() })
  }
  for (const match of text.matchAll(/\b(fetch|XMLHttpRequest|importScripts|WebSocket|EventSource)\s*[(`]/g)) {
    issues.push({ kind: 'network-api', detail: match[1] })
  }
  for (const match of text.matchAll(/\bnew\s+(Worker|SharedWorker)\s*\(/g)) {
    issues.push({ kind: 'worker', detail: match[1] })
  }
  for (const match of text.matchAll(/\bimport\s*\(/g)) {
    issues.push({ kind: 'dynamic-import', detail: 'import(' })
  }
  return issues
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * Every page under `static/`, sorted by id.
 *
 * `static/learn/<topic>/NN-name.html` holds 18 step-by-step teaching pages (the
 * same shader built up in five stages), so the walk is recursive and the id
 * carries the topic: `learn-event-horizon-01-rays`. Flattening the basenames
 * instead would collide the `05-*` pages of different topics into one id.
 */
function readPages(tree) {
  const pages = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, prefix + entry.name + '-')
        continue
      }
      if (!entry.name.endsWith('.html')) continue
      pages.push({ id: prefix + path.basename(entry.name, '.html'), file: entry.name, full })
    }
  }
  walk(path.join(tree, 'static'), '')
  return pages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Build the whole vendored tree in memory: `{ files: Map<relative, bytes>, catalog }`. */
function derive(tree) {
  const files = new Map()
  const examples = []
  for (const page of readPages(tree)) {
    const html = readFileSync(page.full, 'utf8')
    const relative = 'examples/' + page.id + '.html'
    files.set(relative, html)
    const { sources, unreadable } = extractFragments(html)
    const primary = primarySource(sources)
    const entry = {
      id: page.id,
      title: titleOf(html, page.id),
      page: relative,
      pageBytes: Buffer.byteLength(html),
      pageSha256: sha256(html),
      technique: techniqueOf(html),
      params: paramsOf(html),
      sources: [],
      dialect: null,
      primary: primary === null ? null : primary.name,
      compile: 'none',
    }
    for (const source of sources) {
      const fileName = 'glsl/' + page.id + (sources.length > 1 ? '--' + source.name.toLowerCase() : '') + '.frag'
      const bytes = source.source.endsWith('\n') ? source.source : source.source + '\n'
      files.set(fileName, bytes)
      entry.sources.push({ name: source.name, shape: source.shape, file: fileName, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) })
      if (primary !== null && source.name === primary.name) {
        entry.dialect = /void\s+mainImage\s*\(/.test(source.source) ? 'shadertoy' : /^\s*#\s*version\s+\d+\s+es/m.test(source.source) ? 'es300' : /void\s+main\s*\(/.test(source.source) ? 'es100' : 'module'
      }
    }
    if (primary !== null) entry.compile = 'expected'
    else if (unreadable) entry.compile = 'unreadable'
    if (unreadable && primary !== null) entry.compile = 'partial'
    if (techniqueOf(html).startsWith('webgl') || techniqueOf(html) === 'hybrid') {
      if (entry.compile === 'none' && unreadable) entry.unreadableReason = 'a fragment assignment exists but is not a static literal (a ternary or an interpolation)'
      if (entry.compile === 'none' && !unreadable) entry.unreadableReason = 'the fragment source is composed at run time, so no static literal exists to extract'
    }
    examples.push(entry)
  }
  const counts = {
    pages: examples.length,
    pagesWithSource: examples.filter((entry) => entry.sources.length > 0).length,
    sources: examples.reduce((sum, entry) => sum + entry.sources.length, 0),
    byTechnique: examples.reduce((acc, entry) => ({ ...acc, [entry.technique]: (acc[entry.technique] ?? 0) + 1 }), {}),
  }
  const catalog = {
    source: SOURCE,
    generatedBy: 'packages/dsh-shaders/vendor/radiant/build.mjs',
    counts,
    examples,
  }
  files.set('catalog.json', JSON.stringify(catalog, null, 2) + '\n')
  files.set('SOURCE.json', JSON.stringify(SOURCE, null, 2) + '\n')
  return { files, catalog }
}

/** Every file the vendored tree should contain, relative to outRoot. */
function vendoredFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(outRoot, full).split(path.sep).join('/'))
    }
  }
  if (existsSync(outRoot)) walk(outRoot)
  return out.sort()
}

/** Write `[relative, bytes]` pairs under outRoot, in sorted order, replacing the tree. */
async function writeAll(entries) {
  await fsp.rm(outRoot, { recursive: true, force: true })
  await fsp.mkdir(outRoot, { recursive: true })
  for (const [relative, content] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const target = path.join(outRoot, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content)
  }
}

async function run() {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')
  const fromIndex = args.indexOf('--from')
  const from = fromIndex >= 0 ? args[fromIndex + 1] : null

  if (checkMode) {
    if (!existsSync(path.join(outRoot, 'catalog.json'))) {
      console.log('FAIL the vendored Radiant tree is missing its catalog.json')
      process.exit(1)
    }
    // Re-derive the catalogue from the COMMITTED pages: no upstream tree, no network.
    const committedPages = readdirSync(path.join(outRoot, 'examples')).filter((name) => name.endsWith('.html')).sort()
    const examples = []
    const problems = []
    for (const name of committedPages) {
      const id = path.basename(name, '.html')
      const html = readFileSync(path.join(outRoot, 'examples', name), 'utf8')
      const issues = offlineIssues(html)
      if (issues.length > 0) problems.push('egress in ' + name + ': ' + JSON.stringify(issues.slice(0, 3)))
      const { sources, unreadable } = extractFragments(html)
      const primary = primarySource(sources)
      examples.push({ id, technique: techniqueOf(html), sources: sources.length, unreadable, primary: primary === null ? null : primary.name })
    }
    const catalog = JSON.parse(readFileSync(path.join(outRoot, 'catalog.json'), 'utf8'))
    const recorded = new Map(catalog.examples.map((entry) => [entry.id, entry]))
    for (const entry of examples) {
      const known = recorded.get(entry.id)
      if (known === undefined) {
        problems.push('catalog is missing ' + entry.id)
        continue
      }
      if (known.sources.length !== entry.sources) problems.push(entry.id + ': catalog says ' + known.sources.length + ' sources, the page has ' + entry.sources + '')
      if ((known.primary === null) !== (entry.primary === null)) problems.push(entry.id + ': catalog primary disagrees')
    }
    for (const entry of catalog.examples) {
      if (!existsSync(path.join(outRoot, entry.page))) problems.push('catalog names a missing page: ' + entry.page)
      for (const source of entry.sources) {
        const file = path.join(outRoot, source.file)
        if (!existsSync(file)) {
          problems.push('catalog names a missing source: ' + source.file)
          continue
        }
        const bytes = readFileSync(file)
        if (bytes.length !== source.bytes) problems.push(source.file + ': ' + bytes.length + ' bytes on disk, catalog says ' + source.bytes)
        if (sha256(bytes) !== source.sha256) problems.push(source.file + ': sha256 does not match the catalog')
      }
      if (!existsSync(path.join(outRoot, entry.page))) continue
      const pageSha = sha256(readFileSync(path.join(outRoot, entry.page)))
      if (pageSha !== entry.pageSha256) problems.push(entry.page + ': sha256 does not match the catalog')
    }
    if (problems.length > 0) {
      for (const problem of problems.slice(0, 20)) console.log('FAIL ' + problem)
      console.log('FAIL ' + problems.length + ' problem(s) in the vendored Radiant tree')
      process.exit(1)
    }
    console.log(
      'ok   radiant: ' +
        String(catalog.counts.pages) +
        ' pages, ' +
        String(catalog.counts.pagesWithSource) +
        ' with an extractable source, ' +
        String(catalog.counts.sources) +
        ' sources, 0 egress',
    )
    return
  }

  if (from === null) {
    console.log('usage: node vendor/radiant/build.mjs --from <upstream-tree> | --check')
    process.exit(2)
  }
  const tree = path.resolve(from)
  if (!existsSync(path.join(tree, 'static'))) {
    console.log('FAIL ' + tree + ' has no static/ directory')
    process.exit(1)
  }
  const { files, catalog } = derive(tree)
  // The licence travels beside the bytes, as every vendored tree in this pack does.
  const license = path.join(tree, 'LICENSE')
  if (existsSync(license)) files.set('LICENSE', readFileSync(license, 'utf8'))
  else console.log('warn the upstream tree has no LICENSE file')
  await writeAll([...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  let egress = 0
  for (const entry of catalog.examples) {
    const issues = offlineIssues(readFileSync(path.join(outRoot, entry.page), 'utf8'))
    if (issues.length > 0) {
      egress += 1
      console.log('FAIL egress in ' + entry.page + ': ' + JSON.stringify(issues.slice(0, 3)))
    }
  }
  console.log(
    'wrote ' +
      String(catalog.counts.pages) +
      ' pages, ' +
      String(catalog.counts.sources) +
      ' fragment sources in ' +
      String(catalog.counts.pagesWithSource) +
      ' pages (' +
      (egress === 0 ? 'no egress' : String(egress) + ' pages with egress') +
      ')',
  )
  console.log('techniques: ' + JSON.stringify(catalog.counts.byTechnique))
  const unreadable = catalog.examples.filter((entry) => entry.sources.length === 0)
  console.log('pages with no extractable source: ' + (unreadable.map((entry) => entry.id).join(', ') || 'none'))
  if (egress > 0) process.exit(1)
}

run().catch((err) => {
  console.log('FAIL ' + String((err && err.stack) || err))
  process.exit(1)
})
