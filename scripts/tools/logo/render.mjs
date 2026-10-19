#!/usr/bin/env node
//  scripts/tools/logo/render.mjs - the vn-code mark, every file from one source.
//
//  assets/logo is a DISTRIBUTION: three SVGs, nine exact sizes in three families, the
//  contact sheet and MANIFEST.toml. All of it is written here, from the geometry in
//  marks.mjs and the palette beside it, so the set cannot drift from its own record.
//
//  Chrome is the rasteriser. That is a deliberate dependency on a program the machine
//  already has rather than on an npm package: this repository ships zero dependencies and
//  a PNG encoder is not worth one. Each PNG is rendered AT ITS EXACT PIXEL SIZE from the
//  SVG, never downscaled - resampling 1024 to 16 turns the 2.914-unit stroke into a grey
//  smear, which is why the small sizes exist as renders rather than as thumbnails.
//
//  Run:
//    node scripts/tools/logo/render.mjs               write assets/logo
//    node scripts/tools/logo/render.mjs --check       verify what is on disk, write nothing
//    node scripts/tools/logo/render.mjs --chrome <p>  use this browser binary
//    npm run logo                                     the first one, through package.json
//
//  --check proves three things, and says which: the SVGs on disk equal the geometry the
//  code holds, every PNG is the size its name claims with the transparency it claims, and
//  every digest in MANIFEST.toml is the file's own bytes. It does NOT re-render: a
//  browser's PNG encoder is not promised byte-identical across versions, so a fresh
//  render is checked by its size and its pixels, not by a hash.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { findBrowser, shoot } from './chrome.mjs'
import { appSvg, GEOMETRY, INK, JADE, lightSvg, MUTED, PAPER, SIZES, TILE, whiteSvg } from './marks.mjs'
import { SHEET, sheetHtml } from './sheet.mjs'
import { asRatio, contrast } from './color.mjs'
import { decodePng, pixelAt, readHeader } from './png.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const outDir = path.join(repo, 'assets', 'logo')
const stamp = '2026-10-19'

const BRAND = {
  ...JADE,
  name: 'vn-code',
  slug: 'vn-code',
  swatch: 'Jade',
  tagline: 'The crystal, in jade',
  markline: `MARK v1.0  \u00b7  ${stamp}  \u00b7  AGPL-3.0-only`,
  footer: 'AGPL-3.0-only  \u00b7  original vecnode work  \u00b7  assets/logo/BRAND.md',
  notes: {
    rule: 'Same crystal, one colour per app. vn-launcher leaves the inlay empty; vn-code fills it with jade.',
    never: 'The mark is never rotated, outlined, recoloured, given effects, or used as a pattern.',
    textPair: 'Ink on jade for small text; white on jade only at 24 px or larger. The colour is identity, not status.',
  },
}

// ---------------------------------------------------------------------------
// The page wrapper: one SVG at one exact size, nothing else on the page
// ---------------------------------------------------------------------------
const frame = (svg, size, background) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
   html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:${background}}
   svg{display:block;width:${size}px;height:${size}px}
   </style></head><body>${svg}</body></html>`

// ---------------------------------------------------------------------------
// The files this tool owns
// ---------------------------------------------------------------------------
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const VARIANTS = [
  { variant: 'light', suffix: '', svg: lightSvg, background: 'transparent', purpose: 'Raster for light surfaces; ink linework, jade inlay.' },
  { variant: 'white', suffix: '-white', svg: whiteSvg, background: 'transparent', purpose: 'Raster for dark surfaces; white linework, jade inlay.' },
  { variant: 'app', suffix: '-app', svg: appSvg, background: 'black tile', purpose: 'Raster application icon; ink tile, white linework, jade inlay.' },
]

const svgFiles = () => [
  { name: 'vn-code.svg', variant: 'light', body: () => lightSvg(JADE, 'vn-code') },
  { name: 'vn-code-white.svg', variant: 'white', body: () => whiteSvg(JADE, 'vn-code') },
  { name: 'vn-code-app.svg', variant: 'app', body: () => appSvg(JADE, 'vn-code') },
]

const pngFiles = () =>
  VARIANTS.flatMap((variant) =>
    SIZES.map((size) => ({
      name: `vn-code${variant.suffix}-${size}.png`,
      variant: variant.variant,
      size,
      background: variant.background,
      purpose: variant.purpose,
      render: () => variant.svg(JADE, 'vn-code'),
    })),
  )

// ---------------------------------------------------------------------------
// MANIFEST.toml
// ---------------------------------------------------------------------------
function manifest(written) {
  const entry = (file) => {
    const bytes = fs.readFileSync(path.join(outDir, file.name))
    return `[[file]]
path = "${file.name}"
variant = "${file.variant}"
format = "${file.name.endsWith('.svg') ? 'svg' : 'png'}"
size = "${file.name.endsWith('.svg') ? 'vector' : file.size}"
background = "${file.background}"
purpose = "${file.purpose}"
bytes = ${bytes.length}
sha256 = "${sha256(bytes)}"
`
  }
  const header = `# vn-code mark manifest
#
# Generated by scripts/tools/logo/render.mjs from scripts/tools/logo/marks.mjs.
# Regenerate with \`npm run logo\`; verify with \`npm run logo -- --check\`.
# Every digest is the file's own bytes.

[mark]
name = "vn-code"
version = "1.0"
date = "${stamp}"
grid = 24
stroke = ${GEOMETRY.stroke}
facets = 6
viewbox = "0 0 24 24"
geometry = "hexagon (12,2.8) (20.8,7.4) (20.8,16.6) (12,21.2) (3.2,16.6) (3.2,7.4); crown ridge (3.2,7.4)-(12,12)-(20.8,7.4); spine (12,2.8)-(12,21.2); girdle (12,15.4)-(3.2,16.6) and (12,15.4)-(20.8,16.6)"

[palette]
jade = "${JADE.core}"
jade_highlight = "${JADE.highlight}"
jade_deep = "${JADE.deep}"
ink = "${INK}"
paper = "${PAPER}"
muted = "${MUTED}"

[contrast]
jade_on_ink = "${asRatio(contrast(JADE.core, INK))}"
ink_on_jade = "${asRatio(contrast(INK, JADE.core))}"
white_on_jade = "${asRatio(contrast(PAPER, JADE.core))} (large text and icons only)"
jade_on_paper = "${asRatio(contrast(JADE.core, PAPER))} (large text and icons only)"
highlight_on_ink = "${asRatio(contrast(JADE.highlight, INK))}"
white_on_highlight = "${asRatio(contrast(PAPER, JADE.highlight))} (the application tile's ridges on the crown)"

[application_icon]
tile_px = ${TILE.px}
tile_radius_px = ${TILE.radius}
mark_scale = ${TILE.scale}
mark_translate_px = ${TILE.translate}
tile_fill = "${INK}"
ridge = "${PAPER}"

[suite]
rule = "same crystal, one colour per application"
vn-launcher = "no inlay"
vn-ranger = "ember inlay"
vn-code = "jade inlay"

`
  return header + written.sort((a, b) => a.name.localeCompare(b.name)).map(entry).join('\n')
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------
function verify({ quiet = false } = {}) {
  const problems = []
  const say = (line) => {
    if (!quiet) console.log(line)
  }

  // 1. The SVGs on disk are the geometry this code holds.
  for (const file of svgFiles()) {
    const disk = path.join(outDir, file.name)
    if (!fs.existsSync(disk)) {
      problems.push(`${file.name} is missing`)
      continue
    }
    if (fs.readFileSync(disk, 'utf8') !== file.body()) problems.push(`${file.name} does not match the geometry in marks.mjs`)
  }
  say(`svgs      ${svgFiles().length} compared with the geometry in marks.mjs`)

  // 2. Every PNG is the size its name claims, with the transparency it claims.
  let pngs = 0
  for (const file of pngFiles()) {
    const disk = path.join(outDir, file.name)
    if (!fs.existsSync(disk)) {
      problems.push(`${file.name} is missing`)
      continue
    }
    const png = decodePng(fs.readFileSync(disk))
    pngs += 1
    if (png.width !== file.size || png.height !== file.size) {
      problems.push(`${file.name} is ${png.width}x${png.height}, not ${file.size}x${file.size}`)
      continue
    }
    // Corners transparent in every family; the centre drawn in every family.
    for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) {
      if (pixelAt(png, x, y)[3] !== 0) problems.push(`${file.name} corner ${x},${y} is not transparent`)
    }
    if (pixelAt(png, png.width >> 1, png.height >> 1)[3] !== 255) problems.push(`${file.name} centre is transparent`)
  }
  say(`pngs      ${pngs} decoded at their exact size, corners transparent, centre drawn`)

  // 3. The sheet is the size the design is laid out for.
  const sheetPath = path.join(outDir, 'contact-sheet.png')
  if (!fs.existsSync(sheetPath)) problems.push('contact-sheet.png is missing')
  else {
    const header = readHeader(fs.readFileSync(sheetPath))
    if (header.width !== SHEET.width || header.height !== SHEET.height) {
      problems.push(`contact-sheet.png is ${header.width}x${header.height}, not ${SHEET.width}x${SHEET.height}`)
    }
    say(`sheet     ${header.width}x${header.height}`)
  }

  // 4. Every digest in MANIFEST.toml is the file's own.
  const manifestPath = path.join(outDir, 'MANIFEST.toml')
  if (!fs.existsSync(manifestPath)) problems.push('MANIFEST.toml is missing')
  else {
    const text = fs.readFileSync(manifestPath, 'utf8')
    const blocks = text.split('[[file]]').slice(1)
    for (const block of blocks) {
      const name = /path = "([^"]+)"/.exec(block)?.[1]
      const digest = /sha256 = "([^"]+)"/.exec(block)?.[1]
      const bytes = Number(/bytes = (\d+)/.exec(block)?.[1])
      if (!name || !digest) continue
      const file = path.join(outDir, name)
      if (!fs.existsSync(file)) {
        problems.push(`MANIFEST lists ${name}, which is not on disk`)
        continue
      }
      const data = fs.readFileSync(file)
      if (sha256(data) !== digest) problems.push(`MANIFEST digest for ${name} is not the file's`)
      else if (data.length !== bytes) problems.push(`MANIFEST byte count for ${name} is not the file's`)
    }
    say(`manifest  ${blocks.length} digests re-computed`)
  }

  return problems
}

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------
function regenerate(browser) {
  fs.mkdirSync(outDir, { recursive: true })

  const written = []
  for (const file of svgFiles()) {
    fs.writeFileSync(path.join(outDir, file.name), file.body())
    written.push({ name: file.name, variant: file.variant, background: 'transparent', purpose: `${file.variant} source; the master every size is rendered from.` })
  }
  console.log(`svgs      ${svgFiles().length} written`)

  for (const file of pngFiles()) {
    shoot({
      browser: browser,
      html: frame(file.render(), file.size, 'transparent'),
      width: file.size,
      height: file.size,
      out: path.join(outDir, file.name),
    })
    written.push(file)
  }
  console.log(`pngs      ${pngFiles().length} rendered at their exact size`)

  shoot({
    browser: browser,
    html: sheetHtml(BRAND),
    width: SHEET.width,
    height: SHEET.height,
    out: path.join(outDir, 'contact-sheet.png'),
  })
  written.unshift({
    name: 'contact-sheet.png',
    variant: 'sheet',
    size: `${SHEET.width}x${SHEET.height}`,
    background: 'ink',
    purpose: 'Design reference sheet: variants, sizes, palette and contrast.',
  })
  console.log(`sheet     ${SHEET.width}x${SHEET.height}`)

  fs.writeFileSync(path.join(outDir, 'MANIFEST.toml'), manifest(written))
  console.log(`manifest  ${written.length} files hashed`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const check = argv.includes('--check')
const chromeAt = argv.indexOf('--chrome')
const explicit = chromeAt >= 0 ? argv[chromeAt + 1] : undefined

try {
  if (check) {
    const problems = verify()
    const header = `${problems.length ? 'FAILED' : 'ok'}: assets/logo`
    console.log(header)
    for (const problem of problems) console.log('  - ' + problem)
    process.exit(problems.length ? 1 : 0)
  }

  const browser = findBrowser(explicit)
  console.log(`browser   ${browser}`)
  regenerate(browser)

  const problems = verify({ quiet: true })
  if (problems.length) {
    console.log('rendered, but verification failed:')
    for (const problem of problems) console.log('  - ' + problem)
    process.exit(1)
  }
  console.log('ok: assets/logo is written and verified')
  console.log(`   jade ${JADE.core}, crown ${JADE.highlight}, base ${JADE.deep}`)
  for (const [pair, a, b] of [
    ['jade on ink', JADE.core, INK],
    ['white on jade', PAPER, JADE.core],
    ['white on crown', PAPER, JADE.highlight],
    ['crown on ink', JADE.highlight, INK],
  ]) {
    console.log(`   ${pair.padEnd(16)} ${asRatio(contrast(a, b))}`)
  }
} catch (error) {
  console.error('render.mjs: ' + error.message)
  process.exit(1)
}
