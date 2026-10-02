// packages/dsh-canvas/vendor/examples.mjs — generate the HOUSE GALLERY.
//
// An example is a PROVEN COMBINATION: a destination preset, an archetype's
// composition, and a style's look, plus the copy that belongs in it and the sentence
// that says when to reach for it. It is generated from the library rather than
// hand-written, so it cannot drift from the archetypes and styles it names, and
// `--check` (a tracked check) fails when the committed files are not what the table
// below would produce.
//
// Why data and not pictures: the tab paints an example live from its document, the
// model copies the document, and twelve PNGs in the repository would be 6 MB of
// pixels that go stale the moment a style changes. The examples are content; the
// pixels come from the renderer.
//
// Usage:
//   node packages/dsh-canvas/vendor/examples.mjs           # write lib/examples/
//   node packages/dsh-canvas/vendor/examples.mjs --check   # verify they are current
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ARCHETYPES, archetypeById } from '../lib/archetypes/index.js'
import { PRESETS, presetById } from '../lib/presets.js'
import { applyStyle, styleById, styleTable } from '../lib/styles/index.js'
import { normalizeDocument } from '../lib/engine.js'
import { fontTable } from '../lib/fonts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TARGET_DIR = path.join(here, '..', 'lib', 'examples')

/**
 * The gallery. One example per style, each on a preset the archetype is composed for
 * and a composition that suits the look, with the copy to write and the reason to
 * choose it.
 *
 * A NOTE FOR WHOEVER EDITS THIS TABLE, because the check will tell you the same thing
 * the hard way: the three pairings tried and rejected here were `brutalist x code-card`,
 * `retro x docs-collage` and `bento x stat-grid`, all of which leave a child of a PANEL
 * under the contrast floor. That is a real limitation rather than a bad pairing: the
 * style transform re-tints a colour that is not a role value against the CANVAS
 * surface, and a light style therefore puts light ink on a panel that was designed
 * dark. The fix is to re-tint against the surface a node actually sits on (panel-aware
 * re-tinting), and until that exists the gallery avoids the combination - which is
 * honest, since an example is supposed to be a proven answer.
 */
const TABLE = [
  {
    id: 'night-launch',
    title: 'Night launch',
    style: 'neon',
    archetype: 'editorial-split',
    preset: 'github-social',
    intent: 'A launch card that has to glow in a feed: dark ground, one electric accent, a procedural light behind the composition.',
    copy: { eyebrow: 'YOUR PRODUCT', headline: 'Ship it tonight.', subhead: 'What it is, in six words.', cta: 'github.com/you/repo' },
  },
  {
    id: 'announcement',
    title: 'Announcement',
    style: 'editorial',
    archetype: 'statement-centered',
    preset: 'og',
    intent: 'An announcement with nothing to show yet: one large centred sentence, generous margins, a single warm accent.',
    copy: { eyebrow: 'NEW RELEASE', headline: 'Version 2 is out.', subhead: 'One line on what changed.', cta: 'Read the notes' },
  },
  {
    id: 'command-proof',
    title: 'Command proof',
    style: 'brutalist',
    archetype: 'editorial-split',
    preset: 'github-social',
    intent: 'A developer announcement where the command IS the argument: heavy rules, no rounding, a terminal panel on the right.',
    copy: { eyebrow: 'CLI', headline: 'One command.', subhead: 'Nothing else to install.', cta: 'npx your-tool init' },
  },
  {
    id: 'quiet-statement',
    title: 'Quiet statement',
    style: 'minimal',
    archetype: 'statement-centered',
    preset: 'og',
    intent: 'The calmest cover in the library: white ground, hairlines instead of boxes, one idea and a great deal of air.',
    copy: { eyebrow: 'NOTES', headline: 'Less, but better.', subhead: 'A sentence worth the space.', cta: 'Read it' },
  },
  {
    id: 'campaign-wash',
    title: 'Campaign wash',
    style: 'gradient',
    archetype: 'editorial-split',
    preset: 'linkedin-post',
    intent: 'A campaign card that carries colour as its subject: a two-stop wash behind the copy, generous rounding, white type.',
    copy: { eyebrow: 'CAMPAIGN', headline: 'Colour, on purpose.', subhead: 'What the launch is about.', cta: 'you.example/campaign' },
  },
  {
    id: 'docs-cover',
    title: 'Docs cover',
    style: 'glass',
    archetype: 'docs-collage',
    preset: 'og',
    intent: 'A documentation or changelog cover: overlapping translucent panels with hairlines, soft shadow, restrained accent.',
    copy: { eyebrow: 'DOCUMENTATION', headline: 'Everything, written down.', subhead: 'Guides, reference, recipes.', cta: 'Read the docs' },
  },
  {
    id: 'release-numbers',
    title: 'Release numbers',
    style: 'bento',
    archetype: 'editorial-split',
    preset: 'linkedin-post',
    intent: 'A release note where the numbers are the argument: light rounded cards on a common baseline, one card leading.',
    copy: { eyebrow: 'THIS RELEASE', headline: 'What shipped.', subhead: 'Four numbers that matter.', cta: 'See the changelog' },
  },
  {
    id: 'printed-announcement',
    title: 'Printed announcement',
    style: 'retro',
    archetype: 'statement-centered',
    preset: 'linkedin-post',
    intent: 'An announcement that wants to feel printed: warm stock, two inks, hard little offsets instead of shadows.',
    copy: { eyebrow: 'EST. 2026', headline: 'Now in print.', subhead: 'The story behind the release.', cta: 'you.example/story' },
  },
  {
    id: 'developer-card',
    title: 'Developer card',
    style: 'terminal',
    archetype: 'code-card',
    preset: 'og',
    intent: 'A README header for a tool: phosphor ground, monospaced display, one luminous accent and a faint scanline grid.',
    copy: { eyebrow: 'TOOL', headline: 'your-tool --help', subhead: 'What it does, in one line.', cta: 'npm i your-tool' },
  },
  {
    id: 'the-plan',
    title: 'The plan',
    style: 'corporate',
    archetype: 'roadmap-strip',
    preset: 'linkedin-post',
    intent: 'A plan or migration path: four numbered steps joined by a hairline, white ground, one confident blue.',
    copy: { eyebrow: 'ROADMAP', headline: 'Four steps to done.', subhead: 'Where this is going, and when.', cta: 'See the plan' },
  },
  {
    id: 'product-launch',
    title: 'Product launch',
    style: 'vibrant',
    archetype: 'product-mesh',
    preset: 'github-social',
    intent: 'A playful product launch with room for a screenshot: plum ground, saturated accents, pills, a full-bleed ring figure.',
    copy: { eyebrow: 'LAUNCH', headline: 'Meet the new thing.', subhead: 'What it does, for whom.', cta: 'you.example/product' },
  },
  {
    id: 'wordmark-page',
    title: 'Wordmark page',
    style: 'paper',
    archetype: 'wordmark-dark',
    preset: 'og',
    intent: 'The name is the whole design: one huge wordmark on warm stock, a thin accent rule, a single caption line.',
    copy: { eyebrow: 'YOUR NAME', headline: 'yourname', subhead: 'What you do, in one line.', cta: 'you.example' },
  },
]

/** One example's document: the archetype's composition with the style applied. */
function documentFor(row) {
  const archetype = archetypeById(row.archetype)
  const style = styleById(row.style)
  const preset = presetById(row.preset)
  if (!archetype || !style || !preset) throw new Error('example ' + row.id + ' names something the library does not carry')
  if (!archetype.presets.includes(preset.id)) throw new Error('example ' + row.id + ': ' + row.archetype + ' is not composed for ' + row.preset)
  const base = JSON.parse(JSON.stringify(archetype.document))
  base.preset = preset.id
  base.title = row.title
  const applied = applyStyle(base, style, { styles: styleTable() })
  return applied.document
}

/** The example file, in the shape the host serves and `canvas_new` accepts. */
function render(row) {
  const document = documentFor(row)
  const verdict = normalizeDocument(document, { presets: PRESETS, fonts: fontTable(), styles: styleTable() })
  if (!verdict.document) throw new Error('example ' + row.id + ' produced a document that does not validate: ' + verdict.problems[0].code)
  return {
    id: row.id,
    title: row.title,
    intent: row.intent,
    preset: row.preset,
    archetype: row.archetype,
    style: row.style,
    copy: row.copy,
    document: verdict.document,
  }
}

const rendered = TABLE.map((row) => ({ row, file: render(row), text: JSON.stringify(render(row), null, 2) + '\n' }))

if (process.argv.includes('--check')) {
  let stale = 0
  let missing = 0
  const expected = new Set(rendered.map((entry) => entry.row.id + '.json'))
  for (const entry of rendered) {
    const target = path.join(TARGET_DIR, entry.row.id + '.json')
    let current = null
    try {
      current = readFileSync(target, 'utf8')
    } catch (err) {
      missing += 1
      console.error('FAIL ' + entry.row.id + '.json is missing')
      continue
    }
    if (current !== entry.text) {
      stale += 1
      console.error('FAIL ' + entry.row.id + '.json is stale')
    }
  }
  try {
    for (const name of readdirSync(TARGET_DIR)) {
      if (name.endsWith('.json') && !expected.has(name)) {
        stale += 1
        console.error('FAIL ' + name + ' is not in the gallery table any more')
      }
    }
  } catch (err) {
    missing += 1
  }
  if (stale === 0 && missing === 0) console.log('ok   the house gallery matches the table (' + rendered.length + ' example(s))')
  else process.exitCode = 1
} else {
  mkdirSync(TARGET_DIR, { recursive: true })
  for (const entry of rendered) writeFileSync(path.join(TARGET_DIR, entry.row.id + '.json'), entry.text)
  console.log('wrote ' + rendered.length + ' example(s) to ' + path.relative(process.cwd(), TARGET_DIR))
  console.log('archetypes used: ' + [...new Set(TABLE.map((row) => row.archetype))].length + ', styles used: ' + [...new Set(TABLE.map((row) => row.style))].length)
  void ARCHETYPES
}
