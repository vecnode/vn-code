/**
 * dsh-research — the DOCX writer.
 *
 * One Markdown string in, one `.docx` Buffer out, with **no dependency and no
 * child process**. That is the constraint the whole writer exists for: the package
 * promises it spawns nothing and finds no engine on PATH, so pandoc cannot be
 * wrapped and every byte of the container has to be written here.
 *
 * The contract of this module is that a caller cannot be surprised by it:
 *
 *   - `buildDocx(options)` returns the Buffer, and is exactly `buildDocxReport`
 *     with the report dropped - so there is one implementation and two views of it;
 *   - `buildDocxReport(options)` returns `{ buffer, report }`, and the report names
 *     every construct the writer does not render, with its LINE NUMBER, and every
 *     image or footnote reference it could not resolve. A construct that leaves
 *     the document silently is the failure this report exists to prevent;
 *   - `unzipDocx` and `documentText` read a package back, which is how a check
 *     proves the archive is a real ZIP and the document says what it should;
 *   - two builds of one input are BYTE IDENTICAL: every ZIP entry carries the fixed
 *     1980 stamp and a sorted name, no relationship id is random, and the core
 *     properties' dates come from `options.created` (defaulting to a fixed
 *     constant, `DEFAULT_CREATED`). A caller that needs a real date passes one, and
 *     then the bytes differ because the input did.
 *
 * A refusal here is a `ResearchError`, so a caller switches on a code:
 * `UNKNOWN_STYLE` and `DOC_EMPTY` are names from the package's own list, and
 * `BAD_IMAGE` names an image entry a document cannot be built from.
 */

import { ResearchError } from '../run.js'
import { paperStyleOf } from './styles.js'
import { parseMarkdown } from './markdown.js'
import { buildParts } from './ooxml.js'
import { packZip, partText, unpackZip } from './zip.js'

export { DEFAULT_CREATED } from './ooxml.js'
export { DOS_DATE, DOS_TIME, crc32, packZip, unpackZip, partNames, partText } from './zip.js'
export { PAPER_STYLES, paperStyleOf } from './styles.js'
export { parseInline, parseMarkdown, inlineText } from './markdown.js'
export { imagePlan } from './ooxml.js'

/**
 * Every style this writer can lay out: the six the run model records, plus
 * `plain` for a document that was never assigned a citation style.
 *
 * It is the same six ids `lib/styles/index.js` registers, because a DOCX of a run
 * is that run's style on a page - but the list is DECLARED here rather than derived
 * from the registry, so a package missing one module still knows what page sizes it
 * can write. `check-research-docx.mjs` asserts the two lists agree.
 */
export const DOCX_STYLES = ['apa7', 'chicago-notes', 'chicago-author-date', 'mla9', 'ieee', 'vancouver', 'plain']

/** The refusal codes this writer throws, so a caller can publish them. */
export const DOCX_REFUSAL_CODES = ['UNKNOWN_STYLE', 'DOC_EMPTY', 'BAD_IMAGE']

/** Points per inch, which is what a dpi is measured in when sizing a picture. */
const EMU_PER_INCH = 914400

/** The default resolution of an image whose entry does not state one. */
const DEFAULT_DPI = 96

/**
 * Build the document, and report what the writer could not render.
 *
 * @param options - `{ markdown, style, title?, authors?, affiliation?, subtitle?,
 *                    referencesHeading?, toc?, created?, images? }`.
 * @returns `{ buffer, report }`.
 */
export function buildDocxReport(options) {
  const settings = options ?? {}
  const descriptor = paperStyleOf(settings.style)
  if (descriptor === null) {
    throw new ResearchError(
      'UNKNOWN_STYLE',
      'no paper style named ' + JSON.stringify(String(settings.style)) + ' - this writer lays out ' + DOCX_STYLES.join(', '),
    )
  }
  if (typeof settings.markdown !== 'string' || settings.markdown.trim() === '') {
    throw new ResearchError('DOC_EMPTY', 'there is no document to build: the Markdown is empty, and a .docx with no body is not a document')
  }

  const parsed = parseMarkdown(settings.markdown)
  const unsupported = [...parsed.unsupported]

  // The footnote reference line numbers travel with the reference, because a
  // reference with no definition is reported by line rather than invented as an
  // empty note.
  const noteLines = new Map()
  for (const reference of parsed.references) {
    if (!noteLines.has(reference.number)) noteLines.set(reference.number, reference.line)
  }
  // A definition knows its own line too, and a definition is a better answer than
  // the reference when a caller is told "this note is written as prose".
  for (const [number, line] of parsed.definitionLines) noteLines.set(number, line)

  const images = resolveImages(settings.images, unsupported)
  const parts = buildParts({
    style: descriptor.id,
    blocks: parsed.blocks,
    definitions: parsed.definitions,
    noteLines,
    links: [],
    images,
    title: settings.title,
    subtitle: settings.subtitle,
    authors: settings.authors,
    affiliation: settings.affiliation,
    referencesHeading: settings.referencesHeading,
    toc: settings.toc === true,
    created: settings.created,
  })

  // The images themselves: one part per embedded picture, named as its relationship
  // target says. They are appended after the fixed parts, and the ZIP writer sorts.
  for (const image of parts.plan.images) parts.parts.push([image.storedAs, image.bytes])

  for (const missing of parts.report.missingImages) {
    unsupported.push({
      line: Number.isFinite(missing.line) ? missing.line : 0,
      text: String(missing.alt ?? missing.src ?? ''),
      why: 'image-not-embedded: no bytes were passed for ' + JSON.stringify(String(missing.src)) + ', so the alt text is written as a caption',
    })
  }
  for (const missing of parts.report.missingNotes) {
    unsupported.push({
      line: Number.isFinite(missing.line) ? missing.line : 0,
      text: '[^' + missing.number + ']',
      why: 'a footnote reference with no `[^' + missing.number + ']:` definition is reported, not invented',
    })
  }
  unsupported.sort((left, right) => left.line - right.line)

  const report = {
    unsupported,
    headings: parts.report.headings,
    paragraphs: parts.report.paragraphs.length,
    footnotes: parts.report.footnotes.length,
    images: parts.report.images,
    tables: parts.report.tables,
    styles: parts.report.paragraphs.map((one) => ({ style: one.style, text: one.text })),
  }
  return { buffer: packZip(parts.parts), report }
}

/** The Buffer alone, which is what a build writes to disk. */
export function buildDocx(options) {
  return buildDocxReport(options).buffer
}

/**
 * The parts of a `.docx`, by name.
 *
 * A package that cannot be read back is a document nobody can open, so a malformed
 * archive throws with the reason rather than answering an empty Map.
 */
export function unzipDocx(buffer) {
  return unpackZip(buffer)
}

/**
 * Every `<w:t>` run's text, joined in document order - the document's own words.
 *
 * `word/document.xml` is read out of the package and its text runs are taken in the
 * order they appear, which is the order a reader meets them. Any other part (the
 * footnotes, the styles) is deliberately not included: this answers "what does the
 * body say", and a caller that wants a note reads `word/footnotes.xml`.
 */
export function documentText(buffer) {
  const files = unpackZip(buffer)
  return textOfPart(partText(files, 'word/document.xml'))
}

/** The text runs of a document part, in order, as one string. */
export function textOfPart(xml) {
  const found = []
  for (const match of String(xml ?? '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) found.push(decodeEntities(match[1]))
  return found.join('')
}

/** The five entities `xmlEscape` writes, back as characters. */
function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * The image entries, normalised and measured.
 *
 * An entry a document cannot be built from is REPORTED and left out, because a
 * missing picture with a caption is readable while a drawing element with no bytes
 * is a file Word refuses.
 */
function resolveImages(images, unsupported) {
  const source = images !== null && typeof images === 'object' ? images : {}
  const resolved = []
  for (const src of Object.keys(source).sort()) {
    const entry = source[src]
    const widthPx = Number(entry?.widthPx)
    const heightPx = Number(entry?.heightPx)
    const dpi = Number.isFinite(Number(entry?.dpi)) && Number(entry.dpi) > 0 ? Number(entry.dpi) : DEFAULT_DPI
    if (!Buffer.isBuffer(entry?.data) || entry.data.length === 0) {
      unsupported.push({ line: 0, text: src, why: 'image-not-embedded: the entry for ' + JSON.stringify(String(src)) + ' carries no bytes' })
      continue
    }
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
      unsupported.push({ line: 0, text: src, why: 'BAD_IMAGE: the entry for ' + JSON.stringify(String(src)) + ' has no positive width and height' })
      continue
    }
    resolved.push({
      src,
      data: entry.data,
      extentEmu: { cx: Math.round((widthPx / dpi) * EMU_PER_INCH), cy: Math.round((heightPx / dpi) * EMU_PER_INCH) },
    })
  }
  return resolved
}
