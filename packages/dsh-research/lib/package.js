/**
 * dsh-research — submission packaging.
 *
 * A journal submission is not one file. It is a manuscript with the authors taken
 * off it, a title page with them on it, a cover letter that says what the paper
 * claims, and whatever figures belong beside it - and assembling that by hand is
 * where a blind review stops being blind, because the identifying paragraph was in
 * the manuscript all along.
 *
 * So this writes a FOLDER, from the same state every other builder reads:
 *
 *   submission/manuscript.docx   the document with NO title block: review-ready
 *   submission/title-page.md     the title, and the placeholder a person fills in
 *   submission/cover-letter.md   generated from the ledger, not from memory
 *   submission/CHECKLIST.md      what a submission needs, and what this run has
 *   submission/figures/          the run's own figures, copied beside it
 *
 * Two rules it exists to enforce:
 *
 *   1. **The manuscript carries nothing identifying.** It is built with no title
 *      block, and the checklist says so in as many words, because "I remembered to
 *      anonymize it" is exactly the kind of claim a person cannot verify later.
 *   2. **The cover letter is computed.** The claim counts, the verification state
 *      and the experiment-intake answer come from the ledger, so a letter cannot
 *      describe a paper that does not exist - and a run with twelve unverified
 *      claims says so in the letter rather than in a reviewer's report.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ResearchError, messageOf, stamp } from './run.js'
import { buildDocxReport } from './docx/index.js'
import { BLOCKING_STATUSES, claimStatusOf, readClaims, readSources } from './ledger.js'
import { assembleDocument, blockingClaims, renderBody, renderReferences, scanDocument, validateStructure } from './doc.js'

/** The directory a submission is assembled into, inside the run's build folder. */
export const SUBMISSION_DIRNAME = 'submission'

/** A counter of the run's claims by status, for the letter and the checklist. */
function statusRoll(claims) {
  const counts = {}
  for (const row of claims ?? []) {
    const status = claimStatusOf(row)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/**
 * The cover letter, computed from the ledger.
 *
 * A generated letter is honest about one thing a hand-written one usually is not:
 * how much of the paper has actually been checked. It names the counts, the
 * experiments the author declared (or declared they did not run), and the
 * categories of finding a check raised - so the letter cannot promise more than the
 * run holds.
 */
export function coverLetter(options) {
  const statuses = statusRoll(options.claims)
  const spoken = Object.entries(statuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => count + ' ' + status)
    .join(', ')
  const checked = (statuses.supported ?? 0) + (statuses['partially-supported'] ?? 0)
  const lines = [
    '# Cover letter',
    '',
    'Dear Editor,',
    '',
    'Please consider the enclosed manuscript, *' + String(options.title ?? 'Untitled') + '*, for publication.',
    '',
    '**What the manuscript claims.** It makes ' + options.claims.length + ' marked claim(s) across ' + options.citations + ' cited source(s).' +
      (options.claims.length === 0 ? '' : ' ' + spoken + '.'),
    '',
    '**How it was checked.** ' + (options.claims.length === 0
      ? 'No claim is marked yet.'
      : checked + ' of ' + options.claims.length + ' claim(s) have been judged against a located passage; the rest are marked in the manuscript itself, because a draft says what nothing has checked.') +
      (options.blocking.length === 0 ? '' : ' ' + options.blocking.length + ' claim(s) were found unsupported, contradicted or misattributed.'),
    '',
    '**On the experiments.** ' + options.intake,
    '',
    '**Figures.** ' + (options.figures.length === 0 ? 'None.' : options.figures.length + ' figure file(s) accompany the submission.'),
    '',
    'Yours sincerely,',
    '',
    '<!-- Your name and affiliation. This letter is GENERATED from the run\'s ledger:',
    '     the counts above are the ones the run holds, so if you change the paper,',
    '     build the letter again rather than editing it. -->',
  ]
  return lines.join('\n') + '\n'
}

/** The checklist: what a submission needs, and what this run has. */
export function checklist(options) {
  const tick = (ok) => (ok ? '[x]' : '[ ]')
  const lines = [
    '# Submission checklist',
    '',
    'Assembled ' + options.at + ' by dsh-research.',
    '',
    '## The files',
    '- ' + tick(true) + ' `manuscript.docx` — the document **with no title block**, so it carries nothing identifying.',
    '- ' + tick(true) + ' `title-page.md` — the title page, uploaded separately. Fill in the authors, affiliations and funding here.',
    '- ' + tick(true) + ' `cover-letter.md` — generated from the ledger; rebuild it if the paper changes.',
    '- ' + tick(options.figures.length > 0) + ' `figures/` — ' + (options.figures.length === 0 ? 'this run holds no figure files' : options.figures.length + ' file(s) copied') + '.',
    '',
    '## What no builder can check for you',
    '- [ ] The journal\'s own word limit, reference style and figure requirements — this run was built for **' + options.style + '**.',
    '- [ ] That every author has seen and approved this version.',
    '- [ ] Consent, ethics and data-availability statements the journal requires.',
    '- [ ] Whether the manuscript is still anonymous: **read it once with fresh eyes.** The builder removed the title block, and it cannot know what your prose reveals.',
    '',
    '## What this run says about its own evidence',
    '- ' + tick(options.structure.ok) + ' the document and its ledger ' + (options.structure.ok ? 'agree' : 'DO NOT agree: ' + options.structure.codes.join(', ')) + '.',
    '- ' + tick(options.blocking.length === 0) + ' claims a check found unsupported: ' + (options.blocking.length === 0 ? 'none' : options.blocking.map((one) => one.id + ' (' + one.status + ')').join(', ')) + '.',
    '- ' + tick(options.unverified === 0) + ' claims nothing has checked: ' + options.unverified + '.',
    '- ' + tick(options.sourcesWithText === options.sources) + ' sources carrying the text a quote can be located in: ' + options.sourcesWithText + ' of ' + options.sources + '.',
    '',
    '> A clean build is not a check of correctness. It says the document agrees with',
    '> its ledger and that no claim was found unsupported — nothing more.',
  ]
  return lines.join('\n') + '\n'
}

/**
 * Assemble the submission folder.
 *
 * @returns `{ folder, outputs }` where each output is `{ path, bytes, sha256 }`.
 */
export async function buildSubmission(options) {
  const dir = options.dir
  const folder = path.join(dir, 'build', SUBMISSION_DIRNAME)
  await fsp.mkdir(folder, { recursive: true })

  const document = await assembleDocument(dir)
  if (document.text.trim() === '') {
    throw new ResearchError('DOC_EMPTY', 'there is no document to package: write one with rs_write first')
  }
  const { current: claims } = await readClaims(dir)
  const { current: sources } = await readSources(dir)
  const byKey = new Map(sources.map((record) => [record.key, record]))
  const scan = scanDocument(document.text)
  const structure = validateStructure({ scan, claims, sourcesByKey: byKey })

  // The manuscript is built with NO title block. The writer's title block is the
  // only place this pipeline puts the document's own name at the top, so leaving it
  // out is what makes the artifact anonymous - and the checklist says to read it
  // anyway, because a builder cannot know what the prose reveals.
  const manuscript = buildDocxReport({
    markdown: options.markdown,
    style: options.style,
    referencesHeading: options.referencesHeading,
    title: undefined,
    created: options.created,
    toc: false,
  })

  const figuresDir = path.join(dir, 'figures')
  const figures = await fsp
    .readdir(figuresDir, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
    .catch(() => [])

  const intakes = (options.passportGates ?? []).filter((gate) => gate.id === 'g2-intake' && gate.answer !== null)
  const intake = intakes.length === 0
    ? 'The intake question (`g2-intake`) is **not answered yet**, so nothing is declared about who ran what.'
    : 'The author declared: ' + intakes[0].answer.value.replace(/_/g, ' ') + (intakes[0].answer.text === '' ? '' : ' — "' + intakes[0].answer.text + '"') + '.'

  const outputs = []
  const keep = async (relative, content) => {
    const file = path.join(folder, ...relative.split('/'))
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    await fsp.writeFile(file, buffer)
    outputs.push({ path: 'build/' + SUBMISSION_DIRNAME + '/' + relative, bytes: buffer.length, sha256: options.hashOf(buffer) })
  }

  await keep('manuscript.docx', manuscript.buffer)
  await keep(
    'title-page.md',
    [
      '# ' + String(options.title ?? 'Untitled'),
      '',
      '<!-- Upload this page SEPARATELY from the manuscript, so the review stays blind. -->',
      '',
      '## Authors',
      '',
      '<!-- Name, affiliation, ORCID, in the order the journal wants them. -->',
      '',
      '## Corresponding author',
      '',
      '<!-- Name, postal address, email. -->',
      '',
      '## Funding, conflicts and data',
      '',
      '<!-- Whatever this journal requires. A builder cannot invent it, and must not. -->',
    ].join('\n') + '\n',
  )
  await keep(
    'cover-letter.md',
    coverLetter({
      title: options.title,
      claims,
      citations: scan.citationKeys.length,
      blocking: blockingClaims(claims),
      intake,
      figures,
    }),
  )
  await keep(
    'CHECKLIST.md',
    checklist({
      at: stamp(options.now),
      style: options.style,
      figures,
      structure: { ok: structure.ok, codes: [...new Set(structure.problems.map((one) => one.code))] },
      blocking: blockingClaims(claims),
      unverified: claims.filter((row) => claimStatusOf(row) === 'unverified').length,
      sources: sources.length,
      sourcesWithText: sources.filter((record) => record.text !== undefined && record.text !== null).length,
    }),
  )
  for (const name of figures) {
    const bytes = await fsp.readFile(path.join(figuresDir, name)).catch(() => null)
    if (bytes === null) continue
    await keep('figures/' + name, bytes)
  }

  return { folder, outputs, figures, structure }
}

export { messageOf, BLOCKING_STATUSES, renderBody, renderReferences }
