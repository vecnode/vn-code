// packages/dsh-canvas/vendor/styles-doc.mjs — generate the style reference the
// skill ships, FROM the packs themselves.
//
// Why generate it: the style library is data a person can extend, and a hand-kept
// reference drifts the moment a pack changes. This writes
// `skills/canvas-design/reference/styles.md` out of `lib/styles/*.json`, and
// `--check` (a tracked check) fails when the committed file is not what the packs
// would produce - so the document the model reads is always the library it can
// actually apply.
//
// Usage:
//   node packages/dsh-canvas/vendor/styles-doc.mjs           # write the reference
//   node packages/dsh-canvas/vendor/styles-doc.mjs --check   # verify it is current
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { STYLE_LIST, styleSwatch } from '../lib/styles/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'skills', 'canvas-design', 'reference', 'styles.md')

/** Five hex squares as a Markdown swatch row. */
function swatchLine(style) {
  const swatch = styleSwatch(style)
  return swatch.colours.map((colour) => '`' + colour + '`').join(' ')
}

/** One style's section. */
function sectionFor(style) {
  const swatch = styleSwatch(style)
  const lines = []
  lines.push('### `' + style.id + '` — ' + style.name)
  lines.push('')
  lines.push(style.intent)
  lines.push('')
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push('| swatch | ' + swatchLine(style) + ' |')
  lines.push('| display / text | ' + style.font.display + ' / ' + style.font.text + ' (mono: ' + style.font.mono + ') |')
  lines.push(
    '| type | factor ' + style.scale.factor + ', weight ' + style.scale.displayWeight + ', tracking ' + style.scale.displayTracking + ', line-height ' + style.scale.lineHeight + ' |',
  )
  lines.push('| shape | radius card ' + style.radius.card + ' / chip ' + style.radius.chip + ' / pill ' + style.radius.pill + ', border ' + (style.border ? style.border.weight : 0) + 'px, shadow ' + (style.shadow ? style.shadow.kind : 'none') + ' |')
  if (style.image) {
    const tint = style.image.scrim && style.image.scrim !== 'none'
      ? (style.image.scrimColor ?? 'surface') + ' at ' + (style.image.scrimStrength ?? 0.4) + ' (' + style.image.scrim + ' scrim, ' + (style.image.blend ?? 'normal') + ')'
      : 'none'
    lines.push('| image | radius ' + (style.image.radius ?? style.radius.card) + ', crop ' + (style.image.fit ?? 'cover') + ', tint ' + tint + ' |')
  }
  if (style.art && style.art.preferred && style.art.preferred.length > 0) lines.push('| art | ' + style.art.preferred.join(', ') + ' at ' + (style.art.opacity ?? 0.5) + ' opacity |')
  if (style.bestFor && style.bestFor.length > 0) lines.push('| best for | ' + style.bestFor.join(', ') + ' |')
  lines.push('')
  lines.push('**Do**')
  lines.push('')
  for (const rule of style.rules.do) lines.push('- ' + rule)
  lines.push('')
  lines.push('**Don\u2019t**')
  lines.push('')
  for (const rule of style.rules.dont) lines.push('- ' + rule)
  lines.push('')
  lines.push('**Gates** (the render report checks these):')
  lines.push('')
  for (const gate of style.gates) lines.push('- ' + gate)
  lines.push('')
  return lines.join('\n')
}

/** The whole reference. */
function render() {
  const lines = []
  lines.push('# The style library')
  lines.push('')
  lines.push('A **composition** (an archetype) is *which* design; a **style** is *how it looks*. The two are')
  lines.push('independent on purpose: `canvas_new { preset, archetype, style }` starts a design in a look, and')
  lines.push('`canvas_style { id, style }` applies another one to a design that already exists.')
  lines.push('')
  lines.push('This file is GENERATED from `lib/styles/*.json` by `vendor/styles-doc.mjs`, and a tracked check')
  lines.push('fails when it is stale - so what follows is exactly the library the host will apply.')
  lines.push('')
  lines.push('## What applying a style changes, and what it never touches')
  lines.push('')
  lines.push('- **Palette.** Every colour role is replaced, and every colour literal in the document that was')
  lines.push('  one of the old role values is rewritten to the new value for that role. That is how a canonical')
  lines.push('  document (which carries literals everywhere) gets re-coloured by role rather than by luck.')
  lines.push('- **Type behaviour.** The family roles, the display weight and tracking, the line height, and a')
  lines.push('  scale factor applied as a DELTA against the style the design already carried - so applying the')
  lines.push('  same style twice is a no-op and switching back restores the original sizes exactly.')
  lines.push('- **Shape and surface.** The radius scale, the border weight and colour, the shadow, the canvas')
  lines.push('  background, and which art generator the design prefers.')
  lines.push('- **The space a photo gets.** A pack says how an image is rounded, cropped, tinted and')
  lines.push('  blended, so a photograph dropped into a theme belongs to it instead of looking borrowed.')
  lines.push('  The treatment sets the radius, the `fit` (which is what decides how the picture is cropped')
  lines.push('  into its box - a document never carries a crop rectangle, that is derived from the asset),')
  lines.push('  the scrim (which side, which palette role, how strong) and the blend mode.')
  lines.push('- **Never geometry.** No style moves, resizes or reorders a single node: that is what archetypes')
  lines.push('  are for, and it is asserted for every (style x archetype) pair by `check-canvas-node.mjs`.')
  lines.push('- **Never text.** A style cannot rewrite your words.')
  lines.push('')
  lines.push('A style cannot express what the language does not have: there is no blur, so "glass" is')
  lines.push('translucency, a hairline and a soft shadow rather than a real backdrop filter, and a style whose')
  lines.push('intent says so is telling the truth.')
  lines.push('')
  lines.push('## Choosing one')
  lines.push('')
  lines.push('| style | character |')
  lines.push('|---|---|')
  for (const style of STYLE_LIST) {
    lines.push('| `' + style.id + '` | ' + style.name + ': ' + style.intent.split('.')[0] + '. |')
  }
  lines.push('')
  lines.push('Ask for the look in the brief when the person names one ("make it brutalist", "keep it')
  lines.push('corporate"), and otherwise pick the one whose `bestFor` names the preset you are working on. Do')
  lines.push('not stack two styles in one design: apply one, render, look, and change it only if the render')
  lines.push('disagrees with the intent.')
  lines.push('')
  lines.push('## The packs')
  lines.push('')
  for (const style of STYLE_LIST) lines.push(sectionFor(style))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

const rendered = render()
if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch (err) {
    current = null
  }
  if (current === rendered) {
    console.log('ok   ' + path.relative(process.cwd(), target) + ' matches the ' + STYLE_LIST.length + ' style pack(s)')
  } else {
    console.error('FAIL ' + path.relative(process.cwd(), target) + ' is stale - run: node packages/dsh-canvas/vendor/styles-doc.mjs')
    process.exitCode = 1
  }
} else {
  writeFileSync(target, rendered)
  console.log('wrote ' + path.relative(process.cwd(), target) + ' from ' + STYLE_LIST.length + ' style pack(s)')
}
