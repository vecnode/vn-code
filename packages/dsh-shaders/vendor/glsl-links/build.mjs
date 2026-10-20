// vendor/glsl-links/build.mjs - the curated GLSL reference index, vendored.
//
//   node vendor/glsl-links/build.mjs --from <upstream-tree>
//   node vendor/glsl-links/build.mjs --check
//
// WHY THIS EXISTS: this repository contains NO shader code - it is a curated list
// of links (7,217 bytes of markdown) - so it is vendored as what it is: an index.
// It is what `shader_kit action=links` answers with, so an agent that needs to
// know where the GLSL ES specification, the Book of Shaders or iq's articles live
// gets a URL that was curated by a person instead of one that was invented.
//
// The derived links.json is checked against the markdown on every --check, so the
// index cannot drift from the bytes it came from.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outRoot = path.join(packageRoot, 'lib', 'vendor', 'glsl-links')

export const SOURCE = {
  repo: 'vanrez-nez/awesome-glsl',
  commit: '287c2ea4983626be157b094eeba3e36313a3c2ab',
  url: 'https://github.com/vanrez-nez/awesome-glsl',
  license: 'MIT',
  copyright: 'Copyright (c) 2017 Iván Juárez Núñez',
  note: 'A curated LINK INDEX, not shader code: README.md (7,217 bytes) and LICENSE, vendored verbatim, plus links.json derived from the markdown.',
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * The links in the list, grouped by their `## heading`.
 *
 * The shape of every entry in that file is `* [Title](url) - description`, with
 * an em dash or a hyphen, and `## Books` may be empty - which is reported as an
 * empty category rather than dropped.
 *
 * @returns `[{ category, title, url, description }]`
 */
export function parseLinks(markdown) {
  const links = []
  let category = ''
  for (const line of String(markdown).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      category = heading[1].trim()
      continue
    }
    const item = /^\s*[*-]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[-–—]\s*(.*))?$/.exec(line)
    if (item === null) continue
    // The `## Contents` block is internal anchors (`#tutorials`), not resources.
    if (item[2].startsWith('#')) continue
    links.push({
      category,
      title: item[1].trim(),
      url: item[2].trim(),
      description: (item[3] ?? '').trim(),
    })
  }
  return links
}

function derive(tree) {
  const files = new Map()
  const readme = readFileSync(path.join(tree, 'README.md'), 'utf8')
  files.set('README.md', readme)
  const licensePath = path.join(tree, 'LICENSE')
  if (existsSync(licensePath)) files.set('LICENSE', readFileSync(licensePath, 'utf8'))
  const links = parseLinks(readme)
  const categories = [...new Set(links.map((entry) => entry.category))].filter((name) => name !== '')
  const catalog = {
    source: SOURCE,
    generatedBy: 'packages/dsh-shaders/vendor/glsl-links/build.mjs',
    counts: { links: links.length, categories: categories.length },
    readmeSha256: sha256(readme),
    categories,
    links,
  }
  files.set('links.json', JSON.stringify(catalog, null, 2) + '\n')
  files.set('SOURCE.json', JSON.stringify(SOURCE, null, 2) + '\n')
  return { files, catalog }
}

async function writeAll(entries) {
  await fsp.rm(outRoot, { recursive: true, force: true })
  await fsp.mkdir(outRoot, { recursive: true })
  for (const [relative, content] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    await fsp.writeFile(path.join(outRoot, relative), content)
  }
}

function check() {
  const linksPath = path.join(outRoot, 'links.json')
  if (!existsSync(linksPath)) {
    console.log('FAIL the vendored link index is missing its links.json')
    process.exit(1)
  }
  const catalog = JSON.parse(readFileSync(linksPath, 'utf8'))
  const readmePath = path.join(outRoot, 'README.md')
  if (!existsSync(readmePath)) {
    console.log('FAIL the vendored link index is missing its README.md')
    process.exit(1)
  }
  const readme = readFileSync(readmePath, 'utf8')
  const problems = []
  if (sha256(readme) !== catalog.readmeSha256) problems.push('README.md no longer matches the sha256 recorded in links.json')
  const derived = parseLinks(readme)
  if (derived.length !== catalog.links.length) problems.push('links.json has ' + String(catalog.links.length) + ' links, the markdown has ' + String(derived.length))
  for (const [index, link] of derived.entries()) {
    const recorded = catalog.links[index]
    if (recorded === undefined) {
      problems.push('links.json is missing entry ' + String(index))
      continue
    }
    if (recorded.url !== link.url) problems.push('entry ' + String(index) + ': url ' + recorded.url + ' vs ' + link.url)
    if (recorded.category !== link.category) problems.push('entry ' + String(index) + ': category ' + recorded.category + ' vs ' + link.category)
  }
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 20)) console.log('FAIL ' + problem)
    console.log('FAIL ' + String(problems.length) + ' problem(s) in the vendored link index')
    process.exit(1)
  }
  console.log('ok   glsl-links: ' + String(catalog.counts.links) + ' links in ' + String(catalog.counts.categories) + ' categories')
}

async function run() {
  const args = process.argv.slice(2)
  if (args.includes('--check')) {
    check()
    return
  }
  const fromIndex = args.indexOf('--from')
  if (fromIndex < 0) {
    console.log('usage: node vendor/glsl-links/build.mjs --from <upstream-tree> | --check')
    process.exit(2)
  }
  const tree = path.resolve(args[fromIndex + 1])
  if (!existsSync(path.join(tree, 'README.md'))) {
    console.log('FAIL ' + tree + ' has no README.md')
    process.exit(1)
  }
  const { files, catalog } = derive(tree)
  await writeAll([...files.entries()])
  console.log('wrote ' + String(catalog.counts.links) + ' links in ' + String(catalog.counts.categories) + ' categories: ' + catalog.categories.join(', '))
  check()
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  run().catch((err) => {
    console.log('FAIL ' + String((err && err.stack) || err))
    process.exit(1)
  })
}
