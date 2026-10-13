/**
 * dsh-research — the LaTeX builder.
 *
 * A `.tex` file from the SAME Markdown, through the SAME parser, as the `.md`,
 * `.docx` and `.html` artifacts - so the four cannot disagree about a sentence.
 *
 * **This writer needs no bibliography engine, and that is the interesting part.**
 * `composeMarkdown` has already replaced every `[@key]` with the style module's own
 * in-text form and appended the reference list it computed from the ledger, so the
 * `.tex` carries rendered citations and a finished bibliography. There is no
 * `\cite`, no `.bib`, no biber pass and therefore no way for a LaTeX build to
 * format a citation differently from the Markdown one - which is exactly the drift a
 * second citation engine would introduce.
 *
 * **It runs nothing.** This package spawns no process, so `rs_build format=tex`
 * writes the file and PRINTS the command that would compile it. The person runs it
 * on their own machine with their own toolchain, which is also the only way the
 * build is honest about whether a PDF exists.
 *
 * The one risk with LaTeX output is escaping: a title containing `&`, `%` or `_`
 * does not compile at all, and the failure appears as a line number in a log that
 * the agent may never see. Every character that means something to TeX is escaped on
 * the way out, and the check drives the pathological ones.
 */

import { ResearchError } from './run.js'
import { parseMarkdown } from './docx/markdown.js'

/** The page geometry and font size each paper style asks for. */
export const TEX_STYLE = {
  apa7: { size: '12pt', margin: '1in', spacing: 'doublespacing' },
  'chicago-notes': { size: '12pt', margin: '1in', spacing: 'singlespacing' },
  'chicago-author-date': { size: '12pt', margin: '1in', spacing: 'singlespacing' },
  mla9: { size: '12pt', margin: '1in', spacing: 'doublespacing' },
  ieee: { size: '10pt', margin: '0.75in', spacing: 'singlespacing' },
  vancouver: { size: '11pt', margin: '1in', spacing: 'singlespacing' },
  plain: { size: '11pt', margin: '1in', spacing: 'singlespacing' },
}

/**
 * Text as TeX reads it.
 *
 * ONE pass, with a map, and that is not a style choice: a two-pass version that
 * replaced the backslash first and the special characters second escaped the braces
 * of its own `\textbackslash{}` replacement, and a version that did the braces first
 * escaped the backslashes it had just inserted. Both produce output that does not
 * compile, and both look right in a code review. A single pass has no second pass to
 * corrupt it.
 */
const TEX_ESCAPES = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2013': '--',
  '\u2014': '---',
}

export function escapeTex(value) {
  return String(value ?? '').replace(/[\\&%$#_{}~^\u2018\u2019\u201C\u201D\u2013\u2014]/g, (character) => TEX_ESCAPES[character] ?? character)
}

/** A URL for `\href`, or '' when it is not one a document may carry. */
export function safeTexUrl(value) {
  const url = String(value ?? '').trim()
  if (/^(https?:|mailto:)/i.test(url)) return url.replace(/([%#\\{}])/g, '\\$1')
  return ''
}

/** Inline runs to TeX. */
export function inlineTex(runs, definitions) {
  return (Array.isArray(runs) ? runs : [])
    .map((run) => {
      if (run === null || typeof run !== 'object') return ''
      if (run.type === 'code') return '\\texttt{' + escapeTex(run.text) + '}'
      if (run.type === 'link') {
        const href = safeTexUrl(run.href)
        const body = inlineTex(run.runs, definitions)
        return href === '' ? body : '\\href{' + href + '}{' + body + '}'
      }
      // LaTeX footnotes are INLINE, unlike DOCX's separate part: the definition has
      // to be written where the reference is, and a reference with no definition is
      // reported rather than turned into an empty note.
      if (run.type === 'note') {
        const text = definitions.get(Number(run.number))
        return text === undefined ? '\\textsuperscript{[' + Number(run.number) + ']}' : '\\footnote{' + escapeTex(text) + '}'
      }
      if (run.type === 'image') return escapeTex(run.alt)
      if (run.type === 'break') return '\\\\'
      const text = escapeTex(run.text)
      if (run.bold === true && run.italic === true) return '\\textbf{\\emph{' + text + '}}'
      if (run.bold === true) return '\\textbf{' + text + '}'
      if (run.italic === true) return '\\emph{' + text + '}'
      return text
    })
    .join('')
}

/** One block to TeX. */
export function blockTex(block, definitions, options) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'heading') {
    const level = Number(block.level) || 1
    const body = inlineTex(block.runs, definitions)
    if (level <= 1) return '\\section{' + body + '}'
    if (level === 2) return '\\subsection{' + body + '}'
    if (level === 3) return '\\subsubsection{' + body + '}'
    return '\\paragraph{' + body + '}'
  }
  if (block.type === 'paragraph') return inlineTex(block.runs, definitions) + '\n'
  if (block.type === 'blockquote') return '\\begin{quote}\n' + inlineTex(block.runs, definitions) + '\n\\end{quote}'
  if (block.type === 'code') return '\\begin{verbatim}\n' + String(block.text ?? '') + '\n\\end{verbatim}'
  if (block.type === 'rule') return '\\noindent\\rule{\\textwidth}{0.4pt}'
  if (block.type === 'figure') {
    const src = String(block.src ?? '')
    // The .tex lives in build/, so a run-relative figure path is rewritten to be
    // relative to the file that will include it.
    const target = src.startsWith('figures/') ? '../' + src : src
    return (
      '\\begin{figure}[htbp]\n\\centering\n' +
      (target === '' ? '' : '\\includegraphics[width=\\linewidth]{' + target.replace(/([%#\\{}])/g, '\\$1') + '}\n') +
      '\\caption{' + escapeTex(block.alt) + '}\n\\end{figure}'
    )
  }
  if (block.type === 'table') return tableTex(block, definitions)
  if (block.type === 'list') return listTex(block, definitions)
  return ''
}

/** A table, with the column alignment its separator row asked for. */
function tableTex(block, definitions) {
  const align = Array.isArray(block.align) ? block.align : []
  const column = (index) => (align[index] === 'center' ? 'c' : align[index] === 'right' ? 'r' : 'l')
  const head = Array.isArray(block.head) ? block.head : []
  const rows = Array.isArray(block.rows) ? block.rows : []
  const columns = Math.max(head.length, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)), 1)
  const spec = Array.from({ length: columns }, (_, index) => column(index)).join('')
  const line = (cells) => (Array.isArray(cells) ? cells : []).map((runs) => inlineTex(runs, definitions)).join(' & ') + ' \\\\'
  return (
    '\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{' + spec + '}\n\\hline\n' +
    (head.length === 0 ? '' : line(head) + '\n\\hline\n') +
    rows.map(line).join('\n') +
    '\n\\hline\n\\end{tabular}\n\\end{table}'
  )
}

/** A list, one level of nesting deep - the parser's limit, not this module's. */
function listTex(block, definitions) {
  const environment = block.ordered === true ? 'enumerate' : 'itemize'
  const items = Array.isArray(block.items) ? block.items : []
  return (
    '\\begin{' + environment + '}\n' +
    items
      .map((item) => {
        const children = Array.isArray(item.children) && item.children.length > 0 ? '\n' + listTex({ ordered: block.ordered, items: item.children }, definitions) : ''
        return '\\item ' + inlineTex(item.runs, definitions) + children
      })
      .join('\n') +
    '\n\\end{' + environment + '}'
  )
}

/**
 * The whole document.
 *
 * @param options - `{ markdown, style, title, referencesHeading?, lang? }`.
 * @returns `{ tex, report }`.
 */
export function buildTexReport(options) {
  const settings = options ?? {}
  if (typeof settings.markdown !== 'string' || settings.markdown.trim() === '') {
    throw new ResearchError('DOC_EMPTY', 'there is no document to build: the Markdown is empty, and a .tex with no body is not a document')
  }
  const styleId = String(settings.style ?? 'plain')
  const descriptor = TEX_STYLE[styleId]
  if (descriptor === undefined) {
    throw new ResearchError('UNKNOWN_STYLE', 'no page setup for style ' + JSON.stringify(styleId) + ' - this writer knows ' + Object.keys(TEX_STYLE).join(', '))
  }
  const parsed = parseMarkdown(settings.markdown)
  const heading = String(settings.referencesHeading ?? 'References')
  const title = String(settings.title ?? '').trim()

  const body = []
  const missingNotes = []
  let inReferences = false
  for (const block of parsed.blocks) {
    if (block.type === 'heading' && String(block.text ?? '').trim().toLowerCase() === heading.toLowerCase()) {
      inReferences = true
      body.push('\\section*{' + escapeTex(heading) + '}')
      body.push('\\begin{hangparas}{1em}{1}')
      continue
    }
    if (inReferences && block.type !== 'paragraph' && block.type !== 'heading') {
      body.push('\\end{hangparas}')
      inReferences = false
    }
    if (inReferences && block.type === 'heading') {
      body.push('\\end{hangparas}')
      inReferences = false
    }
    body.push(blockTex(block, parsed.definitions, settings))
  }
  if (inReferences) body.push('\\end{hangparas}')

  for (const reference of parsed.references) {
    if (!parsed.definitions.has(Number(reference.number))) missingNotes.push(reference)
  }

  const preamble = [
    '% Written by dsh-research. Nothing here was produced by a LaTeX engine:',
    '% this package spawns no process, so compiling it is yours to run.',
    '\\documentclass[' + descriptor.size + ']{article}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[' + descriptor.margin + ']{geometry}',
    '\\usepackage{graphicx}',
    '\\usepackage{hyperref}',
    '\\usepackage{setspace}',
    '\\usepackage{hangparas}',
    '\\usepackage{longtable}',
    '\\hypersetup{colorlinks=true,linkcolor=black,urlcolor=blue,citecolor=black}',
    descriptor.spacing === 'doublespacing' ? '\\doublespacing' : '\\singlespacing',
  ].join('\n')

  const header = title === '' ? '' : '\\begin{center}\n{\\Large\\bfseries ' + escapeTex(title) + '}\n\\end{center}\n\\vspace{1em}\n'

  const tex = preamble + '\n\n\\begin{document}\n\n' + header + body.join('\n\n') + '\n\n\\end{document}\n'

  return {
    tex,
    report: {
      unsupported: [
        ...parsed.unsupported,
        ...missingNotes.map((reference) => ({
          line: reference.line,
          text: '[^' + reference.number + ']',
          why: 'a footnote reference with no `[^' + reference.number + ']:` definition is reported, not invented',
        })),
      ],
      headings: parsed.blocks.filter((block) => block.type === 'heading').length,
      paragraphs: parsed.blocks.filter((block) => block.type === 'paragraph').length,
      footnotes: parsed.references.length,
      images: parsed.blocks.filter((block) => block.type === 'figure').length,
      tables: parsed.blocks.filter((block) => block.type === 'table').length,
      // The command to run, printed rather than executed - which is the whole
      // reason a `.tex` is a legitimate output for a package that spawns nothing.
      compileWith: 'pdflatex -output-directory=build build/paper.tex',
    },
  }
}

/** The document, as a string. */
export function buildTex(options) {
  return buildTexReport(options).tex
}
