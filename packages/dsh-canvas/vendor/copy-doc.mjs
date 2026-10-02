// packages/dsh-canvas/vendor/copy-doc.mjs — generate the COPY LIBRARY the
// social-banners skill ships.
//
// The budgets in it are DERIVED, not invented: for every destination preset this lays
// out that preset's own starter document, reads the type size each role actually gets
// (display, body, caption), and divides the preset's usable width by that size. The
// advance used is 0.5em - the average this package's own checks measure with - so the
// numbers are right to about ten percent, which is exactly how they are described in
// the document. A render is the authority; this is the budget you write to before you
// have one.
//
// Usage:
//   node packages/dsh-canvas/vendor/copy-doc.mjs           # write the reference
//   node packages/dsh-canvas/vendor/copy-doc.mjs --check   # verify it is current
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESETS, presetById } from '../lib/presets.js'
import { documentFor } from '../lib/index.js'
import { fontTable } from '../lib/fonts.js'
import { layout, normalizeDocument } from '../lib/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'skills', 'social-banners', 'reference', 'copy.md')
const ADVANCE = 0.5

/** The type size each role gets in a preset's own starter, from a real layout. */
function roleSizes(presetId) {
  const built = documentFor({ preset: presetId })
  if (!built.document) return null
  const verdict = normalizeDocument(built.document, { presets: PRESETS, fonts: fontTable() })
  if (!verdict.document) return null
  const laid = layout(verdict.document, { measure: (text, font) => text.length * (font.size || 16) * ADVANCE, assets: {}, fonts: fontTable() })
  const sizes = {}
  for (const entry of laid.boxes) {
    if (entry.kind !== 'text') continue
    sizes[entry.path] = entry.font ? entry.font.size : null
  }
  const byRole = {}
  // The starter's text lives INSIDE a frame, so the walk is recursive - a role is
  // wherever the document puts it.
  const walk = (node, nodePath) => {
    if (node.kind === 'text' && node.style && typeof sizes[nodePath] === 'number') byRole[node.style] = sizes[nodePath]
    for (let index = 0; index < (node.children ?? []).length; index += 1) walk(node.children[index], nodePath + '.children.' + index)
  }
  for (let index = 0; index < verdict.document.layers.length; index += 1) walk(verdict.document.layers[index], 'layers.' + index)
  return { document: verdict.document, byRole, width: laid.width, height: laid.height }
}

/** Characters and words that fit a width at a size. */
function budget(usable, size) {
  if (!size) return null
  const chars = Math.floor(usable / (size * ADVANCE))
  return { chars, words: Math.floor(chars / 6), size }
}

function render() {
  const lines = []
  lines.push('# Copy, per destination')
  lines.push('')
  lines.push('A design fails on its words far more often than on its colours. This file is GENERATED')
  lines.push('from `lib/presets.js` by `vendor/copy-doc.mjs`: for every destination it lays out that')
  lines.push('preset\u2019s own starter, reads the type size each role actually gets, and divides the usable')
  lines.push('width by it, so the budgets below are the destination\u2019s own numbers rather than a guess.')
  lines.push('')
  lines.push('The advance is 0.5em - the average the package\u2019s checks measure with - so treat a budget as')
  lines.push('**right to about ten percent**, and let the render be the authority. A line that fits the')
  lines.push('budget and still overflows is a render\u2019s job to catch, which is why the loop is')
  lines.push('write \u2192 render \u2192 LOOK.')
  lines.push('')
  lines.push('## The formulas')
  lines.push('')
  lines.push('**The headline states a fact, not a mood.** It is the one line a person reads at feed')
  lines.push('scale, so it has to survive being 25% of its size:')
  lines.push('')
  lines.push('- *What changed*: "Nineteen plugins, one row each." / "Version 2 is out."')
  lines.push('- *What it costs*: "One command, no config." / "Free for one machine."')
  lines.push('- *What it refuses*: "No core patches." / "No account required."')
  lines.push('- *Who it is for*: "For teams that read PDFs." / "For people who ship on Friday."')
  lines.push('')
  lines.push('**The subhead carries the detail the headline dropped** - the audience, the constraint, the')
  lines.push('date - and never restates the headline in smaller words.')
  lines.push('')
  lines.push('**The eyebrow is a category, not a sentence**: a product name, a section, a date. Two or')
  lines.push('three words, upper case, letter-spaced, in the muted ink.')
  lines.push('')
  lines.push('**The CTA is a promise or an address, never both.** "Read the notes" or')
  lines.push('"github.com/you/repo" - and if it is an address it is the shortest one that resolves.')
  lines.push('')
  lines.push('## The rules that come from the lints')
  lines.push('')
  lines.push('- One idea per text layer. Two sentences in one node is a composition that will wrap')
  lines.push('  unpredictably; the `SIBLING_EDGE` rule wants them aligned, not merged.')
  lines.push('- A headline is 3\u00d7 the body size or it is a subtitle (`LOW_CONTRAST` and the gates in every')
  lines.push('  style pack both lean on that ratio).')
  lines.push('- Write the words BEFORE you style them: a style changes the palette and the metrics, and')
  lines.push('  a line that only just fitted will not fit afterwards.')
  lines.push('- Never write text whose contrast you have not checked: the muted ink is for the second')
  lines.push('  voice, the accent is for one word, and `canvas_render` will name the ratio if you are wrong.')
  lines.push('')
  lines.push('## The budgets, per destination')
  lines.push('')
  for (const preset of Object.values(PRESETS)) {
    const info = roleSizes(preset.id)
    const usable = preset.width - 2 * (typeof preset.margin === 'number' ? preset.margin : 48)
    lines.push('### ' + preset.id + ' \u2014 ' + preset.label + ' (' + preset.width + '\u00d7' + preset.height + ')')
    lines.push('')
    lines.push('- usable width: **' + usable + 'px** (margin ' + (preset.margin ?? 48) + 'px each side)')
    if (info) {
      const order = ['display', 'title', 'subtitle', 'body', 'caption']
      const cells = []
      for (const role of order) {
        const size = info.byRole[role]
        const fits = budget(usable, size)
        if (!fits) continue
        cells.push('| ' + role + ' | ' + fits.size + 'px | ~' + fits.chars + ' characters | ~' + fits.words + ' words |')
      }
      if (cells.length > 0) {
        lines.push('- what fits the full width:')
        lines.push('')
        lines.push('| role | size | one line | roughly |')
        lines.push('|---|---|---|---|')
        for (const cell of cells) lines.push(cell)
      }
      const display = info.byRole.display ? budget(usable, info.byRole.display) : null
      const body = info.byRole.body ? budget(usable, info.byRole.body) : null
      if (display) lines.push('- headline: **' + Math.floor(display.chars * 0.62) + '\u2013' + display.chars + ' characters** (' + Math.floor(display.words * 0.6) + '\u2013' + display.words + ' words) for a single line; two lines doubles it.')
      if (body) lines.push('- subhead: **' + Math.floor(body.chars * 0.6) + '\u2013' + body.chars + ' characters** and never more than two lines.')
    }
    lines.push('- where it goes: ' + preset.destination.where)
    lines.push('')
  }
  lines.push('## Reading this before you write')
  lines.push('')
  lines.push('Put the destination first: the canvas decides the budget, the budget decides the words,')
  lines.push('and the words decide whether the composition can hold them. If a headline cannot be said')
  lines.push('inside the budget, it is two designs - a banner and a README header - not one long line.')
  lines.push('')
  return lines.join('\n')
}

const rendered = render()
if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch (err) {
    current = null
  }
  if (current === rendered) console.log('ok   ' + path.relative(process.cwd(), target) + ' matches the presets')
  else {
    console.error('FAIL ' + path.relative(process.cwd(), target) + ' is stale - run: node packages/dsh-canvas/vendor/copy-doc.mjs')
    process.exitCode = 1
  }
} else {
  writeFileSync(target, rendered)
  console.log('wrote ' + path.relative(process.cwd(), target) + ' from ' + Object.keys(PRESETS).length + ' preset(s)')
}
void presetById
