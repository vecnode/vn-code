/**
 * dsh-research — the document.
 *
 * The run's prose is either ONE file (`doc/paper.md`) or a set of section files
 * (`doc/sections/<slug>.md`) that the outline orders. Both are supported because
 * both are how people actually write: a paper that exists is usually one file, and
 * a paper being built is usually sections. `assembleDocument` is the one place
 * that decides, and every builder (Markdown, DOCX, LaTeX, HTML) renders what it
 * returns - so a section file and a whole document can never produce two different
 * papers.
 *
 * This module also owns the **r0-structure** rung: the check that a document and
 * its ledger agree. It is the cheapest rung and the one that catches the most:
 *
 *   - a claim span with no ledger row (the author thinks it is tracked; it is not)
 *   - a ledger row with no span (the claim was deleted; the row is now a ghost)
 *   - a citation whose key no source defines (the one that MUST block a build)
 *   - a claim marker that is malformed, reported with its line number
 *
 * Nothing here throws for a document problem. A structural problem is DATA - it is
 * reported, counted and rendered - because a rung that throws is a rung that stops
 * a person from reading their own draft.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { messageOf } from './run.js'
import { findBrokenClaimMarkers, findBrokenCitations, findCitations, findClaimSpans, locatorLabel, statisticLabel } from './syntax.js'
import { BLOCKING_STATUSES, claimStatusOf } from './ledger.js'
import { methodProblems } from './method.js'

/** How many sections a document may have before the outline is reported as runaway. */
export const MAX_SECTIONS = 200
/** The word-count rule: whitespace-separated runs, which is what a reader counts. */
export function wordCount(text) {
  const words = String(text ?? '').trim()
  if (words === '') return 0
  return words.split(/\s+/).length
}

/**
 * The outline, as a list of sections in reading order.
 *
 * A heading is `#`..`######` at the start of a line. Section ids are the heading
 * text slugged, so `## Method and data` is `method-and-data` - the id is what a
 * claim records as its `section`, and it must be derivable from the document
 * alone rather than from a table someone has to maintain.
 */
export function slugifyHeading(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Every heading, with the text range it owns. */
export function sectionsOf(text) {
  const source = String(text ?? '')
  const lines = source.split('\n')
  const headings = []
  let offset = 0
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match !== null) {
      headings.push({ level: match[1].length, title: match[2].trim(), slug: slugifyHeading(match[2]), start: offset, lineStart: line })
    }
    offset += line.length + 1
  }
  const sections = []
  for (let index = 0; index < headings.length && sections.length < MAX_SECTIONS; index += 1) {
    const heading = headings[index]
    const next = headings[index + 1]
    const end = next === undefined ? source.length : next.start
    const body = source.slice(heading.start, end)
    sections.push({
      slug: heading.slug,
      title: heading.title,
      level: heading.level,
      start: heading.start,
      end,
      words: wordCount(body),
      claims: findClaimSpans(body).map((span) => span.id),
    })
  }
  // Text before the first heading belongs to a section of its own, because a claim
  // in an unheaded preamble would otherwise have no section to be attributed to.
  if (headings.length === 0 || headings[0].start > 0) {
    const preamble = source.slice(0, headings.length === 0 ? source.length : headings[0].start)
    if (preamble.trim() !== '') {
      sections.unshift({
        slug: 'preamble',
        title: 'Preamble',
        level: 0,
        start: 0,
        end: headings.length === 0 ? source.length : headings[0].start,
        words: wordCount(preamble),
        claims: findClaimSpans(preamble).map((span) => span.id),
      })
    }
  }
  return sections
}

/**
 * The outline a run's sections are written in, when the author keeps one.
 *
 * `plan/outline.md` lines of the form `- <slug>: <title>` set the order; anything
 * else in the file is the author's prose and is ignored. An outline that names a
 * section no file provides is reported rather than invented, and a section file the
 * outline does not name is appended rather than dropped - a document that silently
 * loses a section is the worst failure this file could have.
 */
export function parseOutline(text) {
  const order = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*[-*+]\s+([a-z0-9][a-z0-9-]*)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    order.push({ slug: match[1], title: match[2] })
  }
  return order
}

/**
 * The run's document, assembled.
 *
 * @returns `{ text, parts, source, notes }` where `source` says which of the two
 * shapes was used, and `notes` says anything the author needs to know about the
 * assembly (a section file the outline does not mention, an empty section).
 */
export async function assembleDocument(runDir) {
  const notes = []
  const sectionsDir = path.join(runDir, 'doc', 'sections')
  const outlineFile = path.join(runDir, 'plan', 'outline.md')
  const outlineText = await fsp.readFile(outlineFile, 'utf8').catch(() => null)
  const order = outlineText === null ? [] : parseOutline(outlineText)

  const entries = await fsp
    .readdir(sectionsDir, { withFileTypes: true })
    .then((list) => list.filter((entry) => entry.isFile() && entry.name.endsWith('.md')))
    .catch(() => [])
  const bySlug = new Map(entries.map((entry) => [entry.name.replace(/\.md$/, ''), entry.name]))

  if (bySlug.size === 0) {
    const whole = await fsp.readFile(path.join(runDir, 'doc', 'paper.md'), 'utf8').catch(() => null)
    if (whole === null) return { text: '', parts: [], source: 'empty', notes: ['doc/paper.md does not exist yet, and there is no doc/sections/'] }
    return { text: whole, parts: [{ slug: 'paper', file: 'doc/paper.md', chars: whole.length }], source: 'whole', notes }
  }

  const parts = []
  const used = new Set()
  for (const entry of order) {
    const name = bySlug.get(entry.slug)
    if (name === undefined) {
      notes.push('the outline names `' + entry.slug + '`, which has no file in doc/sections/')
      continue
    }
    used.add(entry.slug)
    parts.push({ slug: entry.slug, file: 'doc/sections/' + name, title: entry.title })
  }
  const leftover = [...bySlug.keys()].filter((slug) => !used.has(slug)).sort()
  for (const slug of leftover) {
    used.add(slug)
    parts.push({ slug, file: 'doc/sections/' + bySlug.get(slug), title: slug })
    if (order.length > 0) notes.push('doc/sections/' + bySlug.get(slug) + ' is not named by plan/outline.md, so it was appended at the end')
  }

  const pieces = []
  const described = []
  for (const part of parts) {
    const text = await fsp.readFile(path.join(runDir, ...part.file.split('/')), 'utf8').catch(() => '')
    if (text.trim() === '') {
      notes.push(part.file + ' is empty')
      continue
    }
    // A section file that does not open with its own heading gets one, because the
    // outline's title is what the reader sees in the document and a builder must
    // not depend on the author having typed it twice.
    const hasHeading = /^#{1,6}\s+\S/m.test(text.trimStart())
    const body = hasHeading ? text.trimEnd() : '# ' + part.title + '\n\n' + text.trim()
    pieces.push(body)
    described.push({ slug: part.slug, file: part.file, chars: body.length, words: wordCount(body) })
  }
  return { text: pieces.join('\n\n') + '\n', parts: described, source: 'sections', notes }
}

/**
 * Everything a rung needs to know about a document's shape.
 *
 * `citations` is in FIRST-APPEARANCE order, which is the order numeric styles
 * number them in - so the builder and this scan cannot disagree about what `[1]`
 * refers to.
 */
export function scanDocument(text) {
  const source = String(text ?? '')
  const spans = findClaimSpans(source)
  const citations = findCitations(source)
  const order = []
  const seen = new Set()
  for (const citation of citations) {
    for (const cite of citation.cites) {
      if (seen.has(cite.key)) continue
      seen.add(cite.key)
      order.push(cite.key)
    }
  }
  return {
    spans,
    spansById: new Map(spans.map((span) => [span.id, span])),
    citations,
    citationKeys: order,
    brokenMarkers: findBrokenClaimMarkers(source),
    brokenCitations: findBrokenCitations(source),
    words: wordCount(source),
    sections: sectionsOf(source),
  }
}

/** One structural problem: a code, a severity, and where it is. */
function problem(code, severity, detail, extra = {}) {
  return { code, severity, detail, ...extra }
}

/**
 * The **r0-structure** rung: does the document agree with its ledgers?
 *
 * `error` blocks a clean build; `warning` does not. The split is deliberate. A
 * citation with no source is an ERROR - the reference list cannot contain it, and
 * a reader would find a hole where a claim's support should be. A ledger row with
 * no span is a WARNING - the author deleted the sentence, which is allowed, and
 * the row is simply no longer part of the document.
 */
export function validateStructure(options) {
  const scan = options.scan ?? scanDocument(options.text)
  const claims = options.claims ?? []
  const sourcesByKey = options.sourcesByKey ?? new Map()
  const problems = []

  const byId = new Map(claims.filter((row) => row !== null && typeof row.id === 'string').map((row) => [row.id, row]))

  for (const span of scan.spans) {
    if (!byId.has(span.id)) {
      problems.push(problem('span-unrecorded', 'error', 'claim ' + span.id + ' is marked in the document but has no ledger row - it is tracked by nothing', { id: span.id }))
    }
  }
  for (const row of claims) {
    if (row === null || typeof row.id !== 'string') continue
    if (!scan.spansById.has(row.id)) {
      problems.push(problem('claim-orphan', 'warning', 'claim ' + row.id + ' is in the ledger but no longer in the document', { id: row.id }))
    }
  }
  for (const marker of scan.brokenMarkers) {
    problems.push(problem('broken-marker', 'error', 'a claim reference tracks nothing: ' + JSON.stringify(marker.marker) + (marker.why === undefined ? '' : ' - ' + marker.why), { marker: marker.marker }))
  }
  for (const broken of scan.brokenCitations) {
    problems.push(problem('broken-citation', 'error', JSON.stringify(broken.raw) + ' mentions a key but is not a citation this build can resolve: ' + broken.why, { raw: broken.raw }))
  }
  for (const key of scan.citationKeys) {
    if (!sourcesByKey.has(key)) {
      problems.push(problem('unknown-source', 'error', 'the document cites ' + key + ' but no source defines it - ingest it with rs_cite, or the reference list cannot contain it', { key }))
    }
  }
  for (const row of claims) {
    if (row === null || typeof row.id !== 'string') continue
    const bindings = Array.isArray(row.sources) ? row.sources : []
    if (bindings.length === 0) {
      problems.push(problem('claim-unsourced', 'warning', 'claim ' + row.id + ' is bound to no source - it can never pass r1', { id: row.id }))
      continue
    }
    for (const binding of bindings) {
      if (!sourcesByKey.has(binding.key)) {
        problems.push(problem('unknown-source', 'error', 'claim ' + row.id + ' is bound to ' + binding.key + ', which no source defines', { id: row.id, key: binding.key }))
      }
    }
  }
  // The method record is the run's other ledger: not what the document says, but
  // what the search WAS. It is validated here rather than only on the way in, so a
  // record a person edited by hand - or one another version wrote - is reported
  // rather than believed. An unparsable file is pushed as-is, because "this is not
  // JSON" is a fact the reader needs and `methodProblems` cannot see it.
  if (options.methodProblem !== null && options.methodProblem !== undefined) {
    problems.push(problem(options.methodProblem.code, options.methodProblem.severity, options.methodProblem.detail))
  }
  for (const one of methodProblems(options.method ?? null)) {
    problems.push(problem(one.code, one.severity, one.detail, one.fields === undefined ? {} : { fields: one.fields }))
  }
  const errors = problems.filter((one) => one.severity === 'error')
  const warnings = problems.filter((one) => one.severity === 'warning')
  return { ok: errors.length === 0, problems, errors, warnings, scan }
}

/**
 * The run's statistics, as the rows of one table.
 *
 * Only the claims that CARRY a statistic appear, and they appear in claim-id order
 * so the table is stable between builds. A claim with no statistic is not a defect
 * - most sentences have no number in them - so nothing is reported for it.
 *
 * The sentence is trimmed rather than quoted whole: this is an index a reader
 * checks the document against, not a second copy of the prose, and a table whose
 * cells are paragraphs is a table nobody reads.
 */
export function statisticsEntries(claims) {
  const rows = (claims ?? [])
    .filter((row) => row !== null && typeof row.id === 'string' && row.statistic !== null && row.statistic !== undefined)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  return rows.map((row) => {
    const text = String(row.text ?? '').replace(/\s+/g, ' ').trim()
    return {
      id: row.id,
      status: claimStatusOf(row),
      strength: typeof row.strength === 'string' ? row.strength : '',
      sentence: text.length > 90 ? text.slice(0, 89) + '…' : text,
      statistic: row.statistic,
      label: statisticLabel(row.statistic),
    }
  })
}

/** Runs to Markdown: italics are the one emphasis a reference entry needs. */
export function runsToMarkdown(runs) {
  return (Array.isArray(runs) ? runs : [])
    .map((run) => {
      const text = String(run && run.text !== undefined ? run.text : '')
      if (run && run.italic === true) return text.includes('*') ? '_' + text + '_' : '*' + text + '*'
      if (run && run.bold === true) return '**' + text + '**'
      return text
    })
    .join('')
}

/** Runs to plain text, which is what a report and a sort key use. */
export function runsToPlain(runs) {
  return (Array.isArray(runs) ? runs : []).map((run) => String(run && run.text !== undefined ? run.text : '')).join('')
}

/** The numeric marker a citation-order style puts in front of an entry. */
export function numericPrefix(style, number) {
  if (style === null || style === undefined) return ''
  const id = String(style.id ?? '')
  if (id === 'ieee') return '[' + number + '] '
  if (id === 'vancouver') return number + '. '
  return ''
}

/**
 * Render the document body: citations resolved, claim markers handled, footnotes
 * collected.
 *
 * `draft: 'clean'` removes a claim marker entirely - the prose reads as prose, and
 * the ledger has already been checked by the gate that allowed a clean build.
 * `draft: 'watermark'` leaves a visible footnote per claim naming its status and
 * its rung, so a draft can never be mistaken for a finished document. That is the
 * whole reason the two modes exist.
 *
 * @returns `{ body, footnotes, usedKeys, numbers }`.
 */
export function renderBody(options) {
  const text = String(options.text ?? '')
  const style = options.style
  const claimsById = options.claimsById ?? new Map()
  const sourcesByKey = options.sourcesByKey ?? new Map()
  const draft = options.draft === 'clean' ? 'clean' : 'watermark'
  const scan = options.scan ?? scanDocument(text)

  // Citation numbers are assigned in first-appearance order, once, before any
  // replacement - so a numeric style's `[2]` cannot mean two different sources.
  const numbers = new Map()
  let counter = 0
  for (const key of scan.citationKeys) {
    counter += 1
    numbers.set(key, counter)
  }

  const footnotes = []
  const usedKeys = []

  /** One bracket of citations, rendered by the style. */
  const renderCitations = (citation) => {
    const items = citation.cites.map((cite) => {
      const source = sourcesByKey.get(cite.key) ?? { key: cite.key, title: cite.key, authors: [], year: '' }
      if (!usedKeys.includes(cite.key)) usedKeys.push(cite.key)
      return { source, locator: cite.locator, suppressAuthor: cite.suppressAuthor }
    })
    if (style === null || style === undefined) {
      // No style is a refusal the caller has already made; a plain rendering here
      // keeps a report readable rather than throwing inside a text transform.
      return '(' + items.map((item) => item.source.key).join('; ') + ')'
    }
    if (typeof style.note === 'function') {
      const note = style.note(items, { numbers })
      if (typeof note === 'string' && note !== '') {
        footnotes.push(note)
        return '[^' + footnotes.length + ']'
      }
    }
    return style.group(items, { numbers })
  }

  // Replace from the END so every earlier index stays valid while we work.
  let body = text
  for (let index = scan.citations.length - 1; index >= 0; index -= 1) {
    const citation = scan.citations[index]
    body = body.slice(0, citation.start) + renderCitations(citation) + body.slice(citation.end)
  }

  // Claim spans: strip the id, and in watermark mode leave a footnote behind.
  const spans = findClaimSpans(body)
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    const row = claimsById.get(span.id) ?? null
    if (draft === 'clean') {
      body = body.slice(0, span.start) + span.text + body.slice(span.end)
      continue
    }
    const status = row === null ? 'unrecorded' : claimStatusOf(row)
    const bindings = row !== null && Array.isArray(row.sources) ? row.sources : []
    const where = bindings.map((binding) => binding.key + (binding.locator === null || binding.locator === undefined ? '' : ' ' + locatorLabel(binding.locator))).join('; ')
    footnotes.push(
      'claim ' + span.id + ' — ' + status + (row !== null && typeof row.tier === 'string' && row.tier !== '' ? ' (' + row.tier + ')' : '') +
        (row !== null && typeof row.strength === 'string' ? ', written as ' + row.strength : '') +
        (row !== null && row.statistic !== null && row.statistic !== undefined ? ', statistic ' + statisticLabel(row.statistic) : '') +
        (where === '' ? ', bound to no source' : ', bound to ' + where),
    )
    body = body.slice(0, span.start) + span.text + '[^' + footnotes.length + ']' + body.slice(span.end)
  }

  return { body, footnotes, usedKeys, numbers }
}

/**
 * The reference list, ordered and rendered by the style.
 *
 * @returns `{ heading, entries: [{ key, runs, plain, number }] }`.
 */
export function renderReferences(options) {
  const style = options.style
  const sourcesByKey = options.sourcesByKey ?? new Map()
  const usedKeys = options.usedKeys ?? []
  const numbers = options.numbers ?? new Map()
  const heading = style !== null && style !== undefined && typeof style.referenceHeading === 'string' ? style.referenceHeading : 'References'
  const entries = []
  for (const key of usedKeys) {
    const source = sourcesByKey.get(key)
    if (source === undefined) continue
    const number = numbers.get(key) ?? entries.length + 1
    const runs = style !== null && style !== undefined && typeof style.reference === 'function' ? style.reference(source, { number }) : [{ text: source.title }]
    const plain = runsToPlain(runs)
    const prefix = numericPrefix(style, number)
    const prefixed = prefix !== '' && !plain.startsWith(prefix.trim()) ? [{ text: prefix }, ...runs] : runs
    entries.push({ key, runs: prefixed, plain: runsToPlain(prefixed), number })
  }
  const order = style !== null && style !== undefined ? style.order : 'alphabetical'
  if (order !== 'citation') {
    entries.sort((left, right) => left.plain.toLowerCase().localeCompare(right.plain.toLowerCase()))
  }
  return { heading, entries, order }
}

/** The claim statuses a clean build refuses, as a list of ids. */
export function blockingClaims(claims) {
  return (claims ?? [])
    .filter((row) => row !== null && typeof row.id === 'string' && BLOCKING_STATUSES.includes(claimStatusOf(row)))
    .map((row) => ({ id: row.id, status: claimStatusOf(row) }))
}

export { messageOf }
