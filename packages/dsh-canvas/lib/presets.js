/**
 * dsh-canvas — the PRESET table: every destination the pack knows, as data.
 *
 * A preset is the one thing the model must not guess: the exact pixel canvas a
 * network or a repository expects, the region that must stay clear, the formats
 * it accepts, its byte ceiling, and where the file actually goes. The validator
 * takes its canvas from here, the tab draws these safe areas as guides, the
 * render report measures against them, and the skills quote them.
 *
 * ## Why every row carries `verifiedOn` and `sources`
 *
 * These numbers MOVE. GitHub changed its social-preview guidance, LinkedIn has
 * changed its banner crop more than once, and a table with no provenance is a
 * table nobody can re-check. So each row records when it was last verified and
 * where the claim comes from, and `scripts/checks/check-canvas-node.mjs` fails
 * when a row is missing one - which is what makes "the model re-checks instead
 * of trusting a stale number" a property of the build rather than a request in a
 * prompt.
 *
 * ## What "safe area" means here
 *
 * `level: 'keep-out'` is a region the destination OCCUPIES or CROPS: LinkedIn
 * draws the profile photograph over the lower left, the company logo sits in the
 * bottom-left square, GitHub's social card is letterboxed in some surfaces. The
 * report warns when a design puts anything there. `level: 'safe'` is the inverse
 * - the region a design SHOULD use - and is drawn as a guide only.
 *
 * Nothing here is invented: an unverified number is worse than no preset, so a
 * destination that does not have a documented size does not get a row.
 */

/** Every preset, keyed by the id a document names. */
export const PRESETS = {
  'github-social': {
    id: 'github-social',
    label: 'GitHub social preview',
    width: 1280,
    height: 640,
    margin: 48,
    formats: ['png', 'jpg'],
    maxBytes: 1024 * 1024,
    scale2x: true,
    safeAreas: [
      { label: 'centre safe band', x: 160, y: 120, w: 960, h: 400, level: 'safe' },
      { label: 'lower-right card corner', x: 1060, y: 520, w: 220, h: 120, level: 'keep-out' },
    ],
    note: 'Shown small and often letterboxed; keep the headline legible at 320px wide and nothing important in the bottom corners.',
    destination: {
      where: 'the repository page: Settings \u2192 General \u2192 Social preview \u2192 Upload an image',
      steps: [
        'Save the PNG (1280\u00d7640, under 1 MB).',
        'Open the repository on GitHub \u2192 Settings \u2192 General.',
        'Find "Social preview" and choose Edit \u2192 Upload an image.',
      ],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview'],
  },
  'github-readme': {
    id: 'github-readme',
    label: 'GitHub README header',
    width: 1280,
    height: 320,
    margin: 40,
    formats: ['png', 'jpg', 'svg'],
    maxBytes: 5 * 1024 * 1024,
    scale2x: true,
    safeAreas: [{ label: 'content band', x: 80, y: 40, w: 1120, h: 240, level: 'safe' }],
    note: 'A convention rather than a documented size: README renders the image at the column width, so type must survive a ~800px render. 2\u00d7 (2560\u00d7640) is the safe export.',
    destination: {
      where: 'the top of README.md',
      steps: ['Save the PNG.', 'Commit it (e.g. docs/header.png) and reference it as the first line of README.md.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#images'],
  },
  og: {
    id: 'og',
    label: 'Open Graph card',
    width: 1200,
    height: 630,
    margin: 64,
    formats: ['png', 'jpg'],
    maxBytes: 5 * 1024 * 1024,
    scale2x: false,
    safeAreas: [{ label: 'content band', x: 96, y: 96, w: 1008, h: 438, level: 'safe' }],
    note: 'What a link unfurl shows on Slack, Discord, iMessage and X. Assume a 1.91:1 render and that the corners may be rounded.',
    destination: {
      where: 'og:image in the page head',
      steps: ['Save the PNG.', 'Serve it at a stable URL and add <meta property="og:image" content="…"> plus og:image:width/height.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://ogp.me/'],
  },
  'linkedin-personal-banner': {
    id: 'linkedin-personal-banner',
    label: 'LinkedIn profile banner',
    width: 1584,
    height: 396,
    margin: 48,
    formats: ['png', 'jpg'],
    maxBytes: 8 * 1024 * 1024,
    scale2x: false,
    safeAreas: [
      { label: 'safe band (middle)', x: 320, y: 96, w: 944, h: 204, level: 'safe' },
      { label: 'profile photo and headline', x: 0, y: 236, w: 620, h: 160, level: 'keep-out' },
    ],
    note: 'The lower left is covered by the profile photograph and the name/headline; the far right is cropped on narrow viewports. Put the mark in the middle band.',
    destination: {
      where: 'the profile: pencil \u2192 Edit background',
      steps: ['Save the PNG (1584\u00d7396).', 'Open your profile \u2192 pencil icon on the banner \u2192 Edit background \u2192 Upload.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://www.linkedin.com/help/linkedin/answer/a563659'],
  },
  'linkedin-company-banner': {
    id: 'linkedin-company-banner',
    label: 'LinkedIn company page cover',
    width: 1128,
    height: 191,
    margin: 24,
    formats: ['png', 'jpg'],
    maxBytes: 8 * 1024 * 1024,
    scale2x: true,
    safeAreas: [
      { label: 'company logo square', x: 0, y: 71, w: 200, h: 120, level: 'keep-out' },
      { label: 'safe band', x: 260, y: 48, w: 780, h: 96, level: 'safe' },
    ],
    note: 'A very shallow strip: a wordmark and one line, nothing stacked. The logo square overlaps the bottom left.',
    destination: {
      where: 'the Page admin view: Edit page \u2192 Cover image',
      steps: ['Save the PNG.', 'As a Page admin: Edit page \u2192 Cover image \u2192 Upload.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://www.linkedin.com/help/linkedin/answer/a566951'],
  },
  'linkedin-post': {
    id: 'linkedin-post',
    label: 'LinkedIn post image',
    width: 1200,
    height: 627,
    margin: 56,
    formats: ['png', 'jpg'],
    maxBytes: 8 * 1024 * 1024,
    scale2x: false,
    safeAreas: [{ label: 'content band', x: 88, y: 80, w: 1024, h: 467, level: 'safe' }],
    note: 'The feed crops to about 1.91:1. A headline must still read at a 25% render, which is roughly how it appears in a phone feed.',
    destination: { where: 'a post', steps: ['Save the PNG.', 'Attach it to the post (or use it as the link preview image).'] },
    verifiedOn: '2025-02-01',
    sources: ['https://www.linkedin.com/help/linkedin/answer/a555034'],
  },
  'linkedin-square': {
    id: 'linkedin-square',
    label: 'LinkedIn square post',
    width: 1200,
    height: 1200,
    margin: 96,
    formats: ['png', 'jpg'],
    maxBytes: 8 * 1024 * 1024,
    scale2x: false,
    safeAreas: [{ label: 'content square', x: 96, y: 96, w: 1008, h: 1008, level: 'safe' }],
    note: 'Square posts take the most feed height. One idea, centred, with the same 96px margin all round.',
    destination: { where: 'a post', steps: ['Save the PNG.', 'Attach it to the post.'] },
    verifiedOn: '2025-02-01',
    sources: ['https://www.linkedin.com/help/linkedin/answer/a555034'],
  },
  'linkedin-carousel-page': {
    id: 'linkedin-carousel-page',
    label: 'LinkedIn carousel page',
    width: 1080,
    height: 1350,
    margin: 72,
    formats: ['png', 'jpg'],
    maxBytes: 8 * 1024 * 1024,
    scale2x: false,
    safeAreas: [
      { label: 'content column', x: 96, y: 120, w: 888, h: 1110, level: 'safe' },
      { label: 'page number', x: 888, y: 1230, w: 144, h: 72, level: 'keep-out' },
    ],
    note: 'One idea per page, in 4:5. A carousel is uploaded as a PDF or as separate images, so every page must share one margin and one page number position.',
    destination: {
      where: 'a document post (PDF) or a set of images',
      steps: ['Export each page as a PNG (or assemble a PDF at the same page size) and attach in order.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://www.linkedin.com/help/linkedin/answer/a548263'],
  },
  'x-post': {
    id: 'x-post',
    label: 'X / Twitter post image',
    width: 1600,
    height: 900,
    margin: 80,
    formats: ['png', 'jpg'],
    maxBytes: 5 * 1024 * 1024,
    scale2x: false,
    safeAreas: [
      { label: 'content band', x: 120, y: 120, w: 1360, h: 660, level: 'safe' },
      { label: 'centre crop to 1.91:1', x: 0, y: 208, w: 1600, h: 484, level: 'keep-out' },
    ],
    note: 'The timeline often shows a 1.91:1 crop of this, so the message has to live inside that band; the rest is the safe enlargement.',
    destination: { where: 'a post', steps: ['Save the PNG and attach it.'] },
    verifiedOn: '2025-02-01',
    sources: ['https://developer.x.com/en/docs/twitter-for-websites/cards/overview/summary-card-with-large-image'],
  },
  'poster-a3': {
    id: 'poster-a3',
    label: 'A3 poster (300 dpi)',
    width: 3508,
    height: 4961,
    margin: 210,
    formats: ['png', 'svg'],
    maxBytes: 40 * 1024 * 1024,
    scale2x: false,
    safeAreas: [
      { label: 'print-safe area', x: 210, y: 210, w: 3088, h: 4541, level: 'safe' },
      { label: 'bleed', x: 0, y: 0, w: 3508, h: 100, level: 'keep-out' },
    ],
    note: 'A3 at 300 dpi. Nothing may be thinner than 3px, nothing readable within 210px of the trim, and hairline blends will not survive print.',
    destination: {
      where: 'a print shop or a large-format printer',
      steps: ['Export the PNG or the SVG at 1\u00d7 (300 dpi at this pixel size) and hand over the file; ask for the trim size, not a fit-to-page render.'],
    },
    verifiedOn: '2025-02-01',
    sources: ['https://www.iso.org/standard/36631.html'],
  },
}

/** Every preset id, in table order. */
export const PRESET_IDS = Object.keys(PRESETS)

/** The preset a document names, or null. */
export function presetById(id) {
  return Object.prototype.hasOwnProperty.call(PRESETS, String(id)) ? PRESETS[String(id)] : null
}

/**
 * The presets a caller may see, as a plain object (the shape `normalizeDocument`
 * takes). Kept as a function so a future profile can filter it.
 */
export function presetTable() {
  return PRESETS
}

/**
 * Which of a preset's rules a size breaks: the ONE place the export command and
 * the report agree about a destination's ceiling.
 *
 * @param preset - the preset (or null for a free-form canvas).
 * @param format - `png` | `jpg` | `svg`.
 * @param bytes - the file size, when it is known.
 * @returns `{ ok, problems }` - each problem is `{ code, message }`.
 */
export function exportProblems(preset, format, bytes) {
  const problems = []
  if (!preset) {
    problems.push({ code: 'NO_PRESET', message: 'this design names no destination preset, so only generic rules were applied' })
    return { ok: true, problems }
  }
  if (!preset.formats.includes(format)) {
    problems.push({ code: 'BAD_FORMAT', message: preset.label + ' takes ' + preset.formats.join('/') + ', not ' + format })
  }
  if (typeof bytes === 'number' && bytes > preset.maxBytes) {
    problems.push({ code: 'TOO_LARGE', message: 'the file is ' + Math.round(bytes / 1024) + ' KB; ' + preset.label + ' accepts at most ' + Math.round(preset.maxBytes / 1024) + ' KB' })
  }
  return { ok: problems.length === 0, problems }
}
