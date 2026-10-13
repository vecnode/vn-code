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
/**
 * The formats this build implements.
 *
 * `docx` is here because the writer is WRITTEN rather than wrapped: seven modules
 * under `lib/docx/` produce the OOXML themselves, which is the only way to keep the
 * package's promise that it spawns no process - calling pandoc would be one.
 */
export const FORMATS_READY = ['md', 'ris', 'bib', 'enw', 'docx', 'html', 'tex']
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

/**
 * The DOCX writer, on demand.
 *
 * Seven modules and no dependency between them and the rest of the engine: the
 * writer takes a Markdown string and returns a Buffer, so a build is the only thing
 * that needs it and a missing one refuses by name rather than taking the row down.
 */
export async function loadDocx() {
  try {
    return await import('./docx/index.js')
  } catch (err) {
    throw new ResearchError('DOCX_UNAVAILABLE', 'the DOCX writer is not in this build: ' + messageOf(err))
  }
}

/** The HTML builder, on demand, for the same reason. */
export async function loadHtml() {
  try {
    return await import('./html.js')
  } catch (err) {
    throw new ResearchError('HTML_UNAVAILABLE', 'the HTML builder is not in this build: ' + messageOf(err))
  }
}

/**
 * The LaTeX builder, on demand.
 *
 * It produces a FILE and runs nothing: compiling is the person's step, on their own
 * machine with their own toolchain, and the build report carries the exact command.
 * A package that spawns no process cannot tell you a PDF exists, so it does not.
 */
export async function loadTex() {
  try {
    return await import('./tex.js')
  } catch (err) {
    throw new ResearchError('TEX_UNAVAILABLE', 'the LaTeX builder is not in this build: ' + messageOf(err))
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
    // One BLANK LINE between entries, not one newline. Adjacent lines in Markdown
    // are ONE paragraph, so a reference list written that way is a single
    // run-together block in every renderer - and the DOCX writer, which parses this
    // same Markdown, would give the whole bibliography one hanging indent instead of
    // one per entry. A reference list is a list of paragraphs; this is what makes it
    // one.
    for (const entry of references.entries) {
      lines.push(runsToMarkdown(entry.runs))
      lines.push('')
    }
    lines.pop()
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

/** Why a format is not in this build, for a caller the tool schema cannot reach. */
export function unknownFormatMessage(format) {
  return 'format ' + JSON.stringify(String(format)) + ' is not one this build writes: ' + FORMATS_READY.join(', ') + '. Nothing was written.'
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
    // Unreachable through the tool's own enum, and here for a direct caller: every
    // format this package advertises is IMPLEMENTED, so there is no "not yet" left
    // to report. The check asserts that too, so a format added to FORMATS without a
    // builder fails rather than being advertised.
    throw new ResearchError('BAD_FORMAT', unknownFormatMessage(format))
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
  } else if (format === 'docx') {
    // The SAME Markdown the .md build writes, so the two artifacts of one run cannot
    // disagree about a sentence, a citation or a footnote.
    composed = composeMarkdown(state, style, draft, notes)
    const docx = await loadDocx()
    const built = docx.buildDocxReport({
      markdown: composed.text,
      style: styleId,
      // The title block is the document's own name, and the style's OWN reference
      // heading - the writer applies the bibliography style to the paragraphs after
      // it, so handing it the wrong string would give the whole list the body style.
      title: options.title,
      authors: options.authors,
      referencesHeading: typeof style.referenceHeading === 'string' ? style.referenceHeading : 'References',
      created: options.created,
      toc: options.toc === true,
      images: options.images,
    })
    await write(OUTPUT_NAMES.docx, built.buffer)
    // What the writer could not render travels into the report: a construct it
    // skipped is a fact about the artifact, and a build report that omitted it would
    // describe a document nobody has.
    for (const one of built.report.unsupported) {
      notes.push('docx line ' + one.line + ': ' + one.why)
    }
  } else if (format === 'html') {
    // The same Markdown again: three artifacts, one parse, so a sentence, a
    // citation or a footnote cannot be in one and missing from another.
    composed = composeMarkdown(state, style, draft, notes)
    const page = await loadHtml()
    const built = page.buildHtmlReport({
      markdown: composed.text,
      title: options.title,
      referencesHeading: typeof style.referenceHeading === 'string' ? style.referenceHeading : 'References',
      lang: options.lang,
    })
    await write(OUTPUT_NAMES.html, built.html)
    for (const one of built.report.unsupported) notes.push('html line ' + one.line + ': ' + one.why)
  } else if (format === 'tex') {
    composed = composeMarkdown(state, style, draft, notes)
    const latex = await loadTex()
    const built = latex.buildTexReport({
      markdown: composed.text,
      style: styleId,
      title: options.title,
      referencesHeading: typeof style.referenceHeading === 'string' ? style.referenceHeading : 'References',
      lang: options.lang,
    })
    await write(OUTPUT_NAMES.tex, built.tex)
    for (const one of built.report.unsupported) notes.push('tex line ' + one.line + ': ' + one.why)
    // The command is PRINTED, never run: this package spawns no process, so it
    // cannot know whether a PDF exists and will not imply that it does.
    if (typeof built.report.compileWith === 'string') notes.push('to compile it yourself: ' + built.report.compileWith)
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
