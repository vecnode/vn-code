#!/usr/bin/env node
//  scripts/tools/logo/banner.mjs - the README banner, 1280 x 320.
//
//  The banner was hand-made once and would have been re-made by hand every time a
//  plugin is added. It is generated instead, beside the mark, from the same
//  browser helper and the same jade: the number is a constant the renderer reads
//  from the package tree, and the glow, the rings and the type are one page.
//
//  The geometry is measured off the banner it replaced, so this is the same
//  picture - eyebrow at y 86, the headline band 123-177, the subhead 185-211, a
//  list row 220-239 - with jade instead of the old neon green, the real plugin
//  count, two list rows, and "Node application." where "No core patches." was.
//
//  Run:
//    node scripts/tools/logo/banner.mjs              write assets/vncode-banner3.png
//    node scripts/tools/logo/banner.mjs --check      verify the file on disk
//    node scripts/tools/logo/banner.mjs --chrome <p> use this browser binary
//    npm run banner                                  the first one

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findBrowser, shoot } from './chrome.mjs'
import { JADE, MUTED, PAPER } from './marks.mjs'
import { readHeader } from './png.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const out = path.join(repo, 'assets', 'vncode-banner3.png')

const INK = '#05060A'
const SIZE = { width: 1280, height: 320 }

// The plugin count is the number of bundles in the pack, not a number to remember.
const plugins = fs.readdirSync(path.join(repo, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length

const COPY = {
  eyebrow: 'VNCODE \u00b7 ADE',
  count: String(plugins),
  countTail: 'plugins.',
  subhead: 'Node application.',
  // Two rows of about one row's width, so the list reads as a list rather than a
  // paragraph. The first row is the one the hand-made banner already carried.
  rows: ['PDF, OCR, diagrams, media, lab, editor', 'docker, wsl, research, browser, skills, themes'],
}

const rgba = (hex, alpha) => {
  const channel = (at) => parseInt(hex.slice(at, at + 2), 16)
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`
}

export function bannerHtml(copy = COPY) {
  const jade = (alpha) => rgba(JADE.core, alpha)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 0 }
  html,body { margin:0; padding:0; width:${SIZE.width}px; height:${SIZE.height}px; overflow:hidden;
    background:${INK}; color:${PAPER};
    font-family:'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;
    -webkit-font-smoothing:antialiased; font-kerning:normal }
  .bg { position:absolute; inset:0;
    background:
      radial-gradient(760px 620px at 900px 150px, ${jade(0.52)} 0%, ${jade(0.20)} 38%, rgba(5,6,10,0) 72%),
      radial-gradient(1500px 900px at 1080px 160px, ${jade(0.10)} 0%, rgba(5,6,10,0) 70%);
  }
  .rings { position:absolute; inset:0;
    background: repeating-radial-gradient(circle at 900px 158px,
      rgba(0,0,0,0) 0 109px, ${jade(0.50)} 109px 110px);
    -webkit-mask-image: linear-gradient(90deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.55) 62%, #000 100%);
            mask-image: linear-gradient(90deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.55) 62%, #000 100%);
  }
  .text { position:absolute; left:64px; top:0; width:1000px }
  .eyebrow { position:absolute; left:0; top:81px; font-size:14px; font-weight:600;
    letter-spacing:0.14em; color:${MUTED} }
  .headline { position:absolute; left:0; top:112px; font-size:56px; font-weight:700;
    letter-spacing:-0.02em; line-height:1.05; white-space:nowrap }
  .headline .n { color:${JADE.highlight} }
  .subhead { position:absolute; left:0; top:176px; font-size:28px; font-weight:600; color:${PAPER} }
  .row { position:absolute; left:0; width:560px; font-size:20px; color:${MUTED} }
  .row1 { top:213px }
  .row2 { top:242px }
</style></head><body>
  <div class="bg"></div>
  <div class="rings"></div>
  <div class="text">
    <div class="eyebrow">${copy.eyebrow}</div>
    <div class="headline"><span class="n">${copy.count}</span> ${copy.countTail}</div>
    <div class="subhead">${copy.subhead}</div>
    ${copy.rows.map((row, index) => `<div class="row row${index + 1}">${row}</div>`).join('\n    ')}
  </div>
</body></html>
`
}

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const chromeAt = argv.indexOf('--chrome')
const explicit = chromeAt >= 0 ? argv[chromeAt + 1] : undefined

try {
  if (check) {
    if (!fs.existsSync(out)) throw new Error('assets/vncode-banner3.png is missing')
    const header = readHeader(fs.readFileSync(out))
    if (header.width !== SIZE.width || header.height !== SIZE.height) {
      throw new Error(`the banner is ${header.width}x${header.height}, not ${SIZE.width}x${SIZE.height}`)
    }
    console.log(`ok: the banner is ${header.width}x${header.height}, ${plugins} plugins`)
    process.exit(0)
  }
  const browser = findBrowser(explicit)
  console.log(`browser   ${browser}`)
  shoot({ browser, html: bannerHtml(), width: SIZE.width, height: SIZE.height, out })
  console.log(`banner    ${path.relative(repo, out)} - ${plugins} plugins, ${COPY.rows.length} list rows`)
} catch (error) {
  console.error('banner.mjs: ' + error.message)
  process.exit(1)
}
