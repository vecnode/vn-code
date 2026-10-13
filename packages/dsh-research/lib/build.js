/**
 * dsh-research — the builders.
 *
 * One entry point (`runBuild`) turns the run's document and ledgers into files,
 * and one report (`build.json`) records exactly what was built, from which bytes,
 * and how far the run's claims had been checked at that moment.
 *
 * Two rules shape everything here:
 *
 *   1. **A build never quietly drops anything.** A citation whose key no source
 *      defines, a claim span with no ledger row, a section file the outline does
 *      not name - each is reported with its own code, and the report travels with
 *      the artifact. `draft=clean` additionally REFUSES to build while any of them
 *      is an error, because that is the mode whose output looks finished.
 *   2. **A draft says it is a draft.** `draft=watermark` puts a banner at the top
 *      and an endnote on every claim naming its status and its rung, so a
 *      half-checked document cannot be mistaken for a checked one. The two modes
 *      exist for exactly this difference and nothing else.
 *
 * The style registry and the import/export engine are loaded ON DEMAND. That is
 * deliberate: a build is the only thing that needs them, and a row that fails to
 * load because one module of it is missing would take the tools and the tab down
 * with it. A missing module is a refusal that names itself.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { PLUGIN_VERSION, ResearchError, answerOf, messageOf, openGate, readPassport, stamp, writeJsonAtomic } from './run.js'
import {
  assembleDocument,
  blockingClaims,
  renderBody,
  renderReferences,
  runsToMarkdown,
  scanDocument,
  validateStructure,
  wordCount,
} from './doc.js'
import { claimsById, readClaims, readSources, sourcesByKey, statusCounts } from './ledger.js'

/** The formats this plugin can build, and the phase each arrived in. */
export const FORMATS = ['md', 'ris', 'bib', 'enw', 'docx', 'html', 'tex']
/** The formats phase 1 implements. The rest refuse by name, with the phase. */
export const FORMATS_READY = ['md', 'ris', 'bib', 'enw']
/** Where a format's output goes, when the format writes one file. */
export const OUTPUT_NAMES = {
  md: 'paper.md',
  docx: 'paper.docx',
  html: 'paper.html',
  tex: 'paper.tex',
  ris: 'references.ris',
  bib: 'references.bib',
  enw: 'references.enw',
}

/** The citation-style registry, on demand. */
export async function loadStyles() {
  try {
    return await import('./styles/index.js')
  } catch (err) {
    throw new ResearchError('STYLES_UNAVAILABLE', 'the citation-style registry is not in this build: ' + messageOf(err))
  }
}

/** The RIS / BibTeX / MEDLINE / EndNote engine, on demand. */
export async function loadRefs() {
  try {
    return await import('./refs.js')
  } catch (err) {
    throw new ResearchError('REFS_UNAVAILABLE', 'the reference import/export engine is not in this build: ' + messageOf(err))
  }
}

/** A SHA-256 of a string or a buffer, hex. */
export function hashOf(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Read the run's document and both ledgers, in one place. */
export async function readRunState(runDir) {
  const document = await assembleDocument(runDir)
  const { current: claims } = await readClaims(runDir)
  const { current: sources } = await readSources(runDir)
  const map = sourcesByKey(sources)
  const scan = scanDocument(document.text)
  const structure = validateStructure({ scan, claims, sourcesByKey: map })
  return { document, claims, sources, sourcesByKey: map, scan, structure }
}

/**
 * The document as Markdown, ready for a reader.
 *
 * Footnotes are collected by `renderBody` and written at the end, which is where
 * pandoc and every Markdown reader expect them - and which is also why the
 * watermark's endnotes survive a round trip through another tool.
 */
export function composeMarkdown(state, style, draft, notes) {
  const claimsByIdMap = claimsById(state.claims)
  const rendered = renderBody({
    text: state.document.text,
    style,
    claimsById: claimsByIdMap,
    sourcesByKey: state.sourcesByKey,
    draft,
    scan: state.scan,
  })
  const references = renderReferences({ style, sourcesByKey: state.sourcesByKey, usedKeys: rendered.usedKeys, numbers: rendered.numbers })
  const counts = statusCounts(state.claims)
  const lines = []

  if (draft !== 'clean') {
    const bound = state.claims.filter((row) => Array.isArray(row.sources) && row.sources.length > 0).length
    lines.push(
      '> **DRAFT — not a verified document.** ' +
        state.claims.length +
        ' claim(s) marked in the text, ' +
        bound +
        ' bound to a source, ' +
        (counts.supported + counts['partially-supported']) +
        ' judged supported. Every claim carries an endnote below naming its status and the rung it reached; a claim that is `unverified` has been checked by nothing.',
    )
    lines.push('')
  }
  lines.push(rendered.body.trimEnd())
  lines.push('')
  lines.push('## ' + references.heading)
  lines.push('')
  if (references.entries.length === 0) {
    lines.push('_No source is cited yet._')
  } else {
    for (const entry of references.entries) lines.push(runsToMarkdown(entry.runs))
  }
  if (rendered.footnotes.length > 0) {
    lines.push('')
    for (let index = 0; index < rendered.footnotes.length; index += 1) {
      lines.push('[^' + (index + 1) + ']: ' + rendered.footnotes[index])
    }
  }
  for (const note of notes ?? []) lines.push('')
  if ((notes ?? []).length > 0) {
    lines.push('<!--')
    for (const note of notes) lines.push(note)
    lines.push('-->')
  }
  return {
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    usedKeys: rendered.usedKeys,
    references,
  }
}

/**
 * The build report: what the run looked like at the moment of the build.
 *
 * It is written INTO `build/build.json` and stored beside the artifacts, so a
 * question about a document that was handed to somebody ("which claims had been
 * checked when this was built?") is answerable from the folder rather than from
 * anyone's memory.
 */
export function buildReport(options) {
  const counts = statusCounts(options.claims)
  return {
    schema: 1,
    plugin: PLUGIN_VERSION,
    at: stamp(options.now),
    format: options.format,
    draft: options.draft,
    style: options.styleId,
    slug: options.slug,
    document: { source: options.document.source, words: wordCount(options.document.text), parts: options.document.parts },
    claims: { total: options.claims.length, byStatus: counts },
    sources: {
      total: options.sources.length,
      withBytes: options.sources.filter((one) => Array.isArray(one.files) && one.files.length > 0).length,
      withText: options.sources.filter((one) => one.text !== undefined && one.text !== null).length,
      cited: options.usedKeys.length,
    },
    structure: {
      ok: options.structure.ok,
      errors: options.structure.errors.map((one) => one.code),
      warnings: options.structure.warnings.map((one) => one.code),
      problems: options.structure.problems,
    },
    outputs: options.outputs,
    notes: options.notes ?? [],
  }
}

/** Why a format is not in this build yet, in one sentence both callers use. */
export function formatNotYetMessage(format) {
  const phase = format === 'docx' ? 'the DOCX writer (phase 3)' : format === 'html' ? 'the HTML builder (phase 3)' : 'the LaTeX builder (phase 6)'
  return 'format `' + format + '` is not in this build yet - it arrives with ' + phase + '. Ready now: ' + FORMATS_READY.join(', ') + '. Nothing was written.'
}

/**
 * Open the integrity gate, once, for a clean build.
 *
 * Both callers of a build - the `rs_build` tool and the panel's `POST /build`
 * route - go through here, so "what a clean build requires" cannot mean two
 * things. Opening the gate is what makes the question VISIBLE in the panel rather
 * than only present in a refusal message: the user sees what is being asked of
 * them, with the override box that records their reason.
 *
 * @returns `{ opened, answered }` - `answered` is what `runBuild` needs.
 */
export async function ensureIntegrityGate(options) {
  const draft = options.draft === 'clean' ? 'clean' : 'watermark'
  if (draft !== 'clean') return { opened: false, answered: false }
  const { passport } = await readPassport(options.root, options.slug)
  if (answerOf(passport, 'g3-integrity') !== null) return { opened: false, answered: true }
  const result = await openGate({ root: options.root, slug: options.slug, id: 'g3-integrity', now: options.now })
  return { opened: result.opened, answered: false }
}

/**
 * Build one format.
 *
 * @returns `{ outputs, report, body }` where `outputs` are paths RELATIVE to the
 * run folder, each with its own byte length and sha256.
 */
export async function runBuild(options) {
  const runDir = options.runDir
  const format = options.format ?? 'md'
  const draft = options.draft === 'clean' ? 'clean' : 'watermark'
  if (!FORMATS.includes(format)) {
    throw new ResearchError('BAD_FORMAT', 'format must be one of ' + FORMATS.join(', ') + ' (got ' + JSON.stringify(String(format)) + ')')
  }
  if (!FORMATS_READY.includes(format)) {
    // The phase is named, because "not yet" without "when" is a dead end - and a
    // caller can then say which step it is waiting for instead of guessing.
    throw new ResearchError('FORMAT_NOT_YET', formatNotYetMessage(format))
  }

  const state = await readRunState(runDir)
  if (state.document.text.trim() === '') {
    throw new ResearchError('DOC_EMPTY', 'there is no document to build: write one with rs_write (doc/paper.md or doc/sections/<slug>.md)')
  }
  const styles = await loadStyles()
  const styleId = options.styleId ?? 'apa7'
  const style = styles.styleOf(styleId)
  if (style === null) {
    throw new ResearchError('UNKNOWN_STYLE', 'no citation style named ' + JSON.stringify(String(styleId)) + ' - this build has ' + (styles.STYLES ?? []).join(', '))
  }

  const blocking = blockingClaims(state.claims)
  const notes = [...state.document.notes]
  // A DRAFT is always buildable: that is what it is for. A CLEAN build is the one
  // that claims to be finished, so it is the one that has to hold up.
  if (draft === 'clean') {
    if (state.structure.errors.length > 0) {
      throw new ResearchError(
        'BUILD_BLOCKED',
        'a clean build needs a document that agrees with its ledger, and these do not: ' +
          state.structure.errors.map((one) => one.code + ' (' + one.detail + ')').join('; ') +
          '. Build with draft=watermark to read the draft anyway.',
      )
    }
    if (blocking.length > 0) {
      throw new ResearchError(
        'BLOCKING_CLAIMS',
        'a clean build refuses to publish claims a check found unsupported: ' + blocking.map((one) => one.id + '=' + one.status).join(', ') + '. Fix them, or build a draft.',
      )
    }
    if (options.integrityAnswered !== true) {
      throw new ResearchError(
        'GATE_UNANSWERED',
        'a clean build is the point at which you say the run has been checked. That is gate `g3-integrity`, and only a person can answer it - it is waiting in the Research tab (or POST /api/dsh-research/gate).',
      )
    }
  }

  const outputs = []
  const buildDir = path.join(runDir, 'build')
  await fsp.mkdir(buildDir, { recursive: true })

  /** Write one output and record its hash. */
  const write = async (name, content) => {
    const file = path.join(buildDir, name)
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    await fsp.writeFile(file, buffer)
    outputs.push({ path: 'build/' + name, bytes: buffer.length, sha256: hashOf(buffer) })
  }

  let composed = null
  if (format === 'md') {
    composed = composeMarkdown(state, style, draft, notes)
    await write(OUTPUT_NAMES.md, composed.text)
  } else {
    const refs = await loadRefs()
    // An export is the run's LIBRARY, not only the part the current draft cites:
    // a bibliography handed to Zotero is more useful complete, and pruned by hand
    // is easier than reconstructed.
    const list = format === 'ris' ? refs.renderRis(state.sources) : format === 'enw' ? refs.renderEnw(state.sources) : refs.renderBib(state.sources)
    await write(OUTPUT_NAMES[format], list)
  }

  const report = buildReport({
    format,
    draft,
    styleId,
    slug: options.slug,
    document: state.document,
    claims: state.claims,
    sources: state.sources,
    usedKeys: composed === null ? state.sources.map((one) => one.key) : composed.usedKeys,
    structure: state.structure,
    outputs,
    notes,
    now: options.now,
  })
  report.source = { 'doc': state.document.source, sha256: hashOf(state.document.text) }
  await writeJsonAtomic(path.join(buildDir, 'build.json'), report)
  return { outputs, report, body: composed === null ? null : composed.text, state }
}
