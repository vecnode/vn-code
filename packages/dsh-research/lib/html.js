/**
 * dsh-research — the HTML builder.
 *
 * A self-contained page from the SAME Markdown the `.md` and `.docx` builds use, and
 * through the SAME parser (`lib/docx/markdown.js`): one block model, three
 * artifacts, so a sentence, a citation or a footnote cannot be in one and missing
 * from another. It is the artifact a person reads in the panel, prints from a
 * browser, or hands to somebody who has no Word.
 *
 * Three rules shape it:
 *
 *   1. **Self-contained.** No stylesheet URL, no font, no script, no remote image:
 *      one file that opens on a machine with no network, which is the same promise
 *      the package makes about itself. Inline CSS only.
 *   2. **A draft says it is a draft.** The watermark banner `composeMarkdown` already
 *      wrote comes through as a styled quote, and the claim endnotes become real
 *      numbered notes at the end - so the page carries exactly the warning the
 *      Markdown does.
 *   3. **A construct the subset does not cover is REPORTED, not dropped** - the
 *      parser's own `unsupported` list is returned and travels into the build
 *      report, so an HTML artifact nobody has ever seen cannot be missing a
 *      paragraph quietly.
 */

import { ResearchError, messageOf } from './run.js'
import { parseMarkdown } from './docx/markdown.js'

/** The page's own style: no link to it, so the file works with no network. */
export const PAGE_STYLE = [
  ':root{color-scheme:light dark}',
  'body{margin:0 auto;max-width:46rem;padding:3rem 1.25rem 6rem;font:16px/1.65 Georgia,"Times New Roman",serif;color:#1a1a1a;background:#fff}',
  'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2.2em 0 .6em;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
  'h1{font-size:1.9rem}h2{font-size:1.45rem}h3{font-size:1.2rem}h4,h5,h6{font-size:1.05rem}',
  'p{margin:0 0 1em}',
  'a{color:#0b5cad}',
  'code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;background:#f3f3f3;padding:.1em .3em;border-radius:3px}',
  'pre{background:#f6f6f6;border:.5px solid #ddd;border-radius:6px;padding:.8em 1em;overflow:auto}',
  'pre code{background:none;padding:0}',
  'blockquote{margin:1.4em 0;padding:.6em 1em;border-left:3px solid #ccc;background:#fafafa;color:#333}',
  'table{border-collapse:collapse;margin:1.4em 0;width:100%}',
  'th,td{border:.5px solid #ccc;padding:.4em .6em;text-align:left;vertical-align:top}',
  'th{background:#f6f6f6}',
  'figure{margin:1.6em 0;text-align:center}',
  'figcaption{font-size:.9em;color:#555;margin-top:.4em}',
  'hr{border:0;border-top:.5px solid #ccc;margin:2.4em 0}',
  '.notes{margin-top:3rem;border-top:.5px solid #ccc;padding-top:1rem;font-size:.9em}',
  '.notes ol{padding-left:1.4rem}',
  '.refs p{padding-left:2rem;text-indent:-2rem;margin:0 0 .6em}',
  'sup a{text-decoration:none}',
  '@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#151515}a{color:#7cb3f0}code,pre,blockquote{background:#1e1e1e;color:#e6e6e6}th{background:#1e1e1e}th,td,hr,.notes{border-color:#3a3a3a}}',
  '@media print{body{max-width:none;padding:0}a{color:inherit}}',
].join('')

/** One string, escaped for HTML text or an attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A URL a page may carry in `href` or `src`.
 *
 * Only the schemes a document legitimately cites: a `javascript:` or `data:` URL
 * that arrived from a source record would be executable content in a file this
 * plugin produced, and the whole point of the artifact is that it is safe to open.
 * Anything else is dropped and the text is kept.
 */
export function safeUrl(value) {
  const url = String(value ?? '').trim()
  if (/^(https?:|mailto:|#|\.{0,2}\/)/i.test(url) && !/^javascript:/i.test(url)) return url
  return ''
}

/** Inline runs to HTML. */
export function inlineHtml(runs) {
  return (Array.isArray(runs) ? runs : [])
    .map((run) => {
      if (run === null || typeof run !== 'object') return ''
      if (run.type === 'code') return '<code>' + escapeHtml(run.text) + '</code>'
      if (run.type === 'link') {
        const href = safeUrl(run.href)
        const body = inlineHtml(run.runs)
        return href === '' ? body : '<a href="' + escapeHtml(href) + '" rel="noreferrer">' + body + '</a>'
      }
      if (run.type === 'note') return '<sup><a href="#fn' + Number(run.number) + '" id="fnref' + Number(run.number) + '">' + Number(run.number) + '</a></sup>'
      if (run.type === 'image') {
        const src = safeUrl(run.src)
        return src === '' ? escapeHtml(run.alt) : '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(run.alt) + '">'
      }
      if (run.type === 'break') return '<br>'
      const text = escapeHtml(run.text)
      if (run.bold === true && run.italic === true) return '<strong><em>' + text + '</em></strong>'
      if (run.bold === true) return '<strong>' + text + '</strong>'
      if (run.italic === true) return '<em>' + text + '</em>'
      return text
    })
    .join('')
}

/** One block to HTML. */
export function blockHtml(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.level) || 1))
    return '<h' + level + '>' + inlineHtml(block.runs) + '</h' + level + '>'
  }
  if (block.type === 'paragraph') return '<p>' + inlineHtml(block.runs) + '</p>'
  if (block.type === 'blockquote') return '<blockquote>' + inlineHtml(block.runs) + '</blockquote>'
  if (block.type === 'code') {
    const language = String(block.language ?? '')
    return '<pre><code' + (language === '' ? '' : ' class="language-' + escapeHtml(language) + '"') + '>' + escapeHtml(block.text) + '</code></pre>'
  }
  if (block.type === 'rule') return '<hr>'
  if (block.type === 'figure') {
    const src = safeUrl(block.src)
    const image = src === '' ? '' : '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(block.alt) + '">'
    return '<figure>' + image + '<figcaption>' + escapeHtml(block.alt) + '</figcaption></figure>'
  }
  if (block.type === 'table') return tableHtml(block)
  if (block.type === 'list') return listHtml(block)
  return ''
}

/** A table, with the alignment its separator row asked for. */
function tableHtml(block) {
  const align = Array.isArray(block.align) ? block.align : []
  const cell = (tag, runs, index) => {
    const style = align[index] === 'center' ? ' style="text-align:center"' : align[index] === 'right' ? ' style="text-align:right"' : ''
    return '<' + tag + style + '>' + inlineHtml(runs) + '</' + tag + '>'
  }
  const head = Array.isArray(block.head) ? block.head : []
  const rows = Array.isArray(block.rows) ? block.rows : []
  return (
    '<table>' +
    (head.length === 0 ? '' : '<thead><tr>' + head.map((runs, index) => cell('th', runs, index)).join('') + '</tr></thead>') +
    '<tbody>' +
    rows.map((row) => '<tr>' + (Array.isArray(row) ? row : []).map((runs, index) => cell('td', runs, index)).join('') + '</tr>').join('') +
    '</tbody></table>'
  )
}

/** A list, one level of nesting deep - the parser's own limit, not this module's. */
function listHtml(block) {
  const tag = block.ordered === true ? 'ol' : 'ul'
  const start = block.ordered === true && Number(block.start) > 1 ? ' start="' + Number(block.start) + '"' : ''
  const items = Array.isArray(block.items) ? block.items : []
  return (
    '<' + tag + start + '>' +
    items
      .map((item) => {
        const children = Array.isArray(item.children) && item.children.length > 0 ? listHtml({ ordered: block.ordered, start: 1, items: item.children }) : ''
        return '<li>' + inlineHtml(item.runs) + children + '</li>'
      })
      .join('') +
    '</' + tag + '>'
  )
}

/**
 * The whole page.
 *
 * @param options - `{ markdown, title, style?, referencesHeading?, lang? }`.
 * @returns `{ html, report }` where `report` carries the parser's unsupported list
 * and the counts a build report prints.
 */
export function buildHtmlReport(options) {
  const settings = options ?? {}
  if (typeof settings.markdown !== 'string' || settings.markdown.trim() === '') {
    throw new ResearchError('DOC_EMPTY', 'there is no document to build: the Markdown is empty, and a page with no body is not a document')
  }
  const parsed = parseMarkdown(settings.markdown)
  const heading = String(settings.referencesHeading ?? 'References')
  const title = String(settings.title ?? '').trim()

  // The reference list gets its own class from the same stated rule the DOCX writer
  // uses: every paragraph AFTER the heading whose text is the style's own. Two
  // builders applying the rule differently is how one artifact hangs its indents
  // and the other does not.
  const body = []
  let inReferences = false
  let listOpen = false
  let referenceCount = 0
  for (const block of parsed.blocks) {
    if (block.type === 'heading' && String(block.text ?? '').trim().toLowerCase() === heading.toLowerCase()) inReferences = true
    if (inReferences && !listOpen) {
      body.push('<div class="refs">')
      listOpen = true
    }
    if (!inReferences && listOpen) {
      body.push('</div>')
      listOpen = false
    }
    if (inReferences && block.type === 'paragraph') referenceCount += 1
    body.push(blockHtml(block))
  }
  if (listOpen) body.push('</div>')

  const notes = [...parsed.definitions.entries()].sort((left, right) => Number(left[0]) - Number(right[0]))
  const notesHtml =
    notes.length === 0
      ? ''
      : '<section class="notes"><ol>' + notes.map(([number, text]) => '<li id="fn' + Number(number) + '">' + escapeHtml(text) + ' <a href="#fnref' + Number(number) + '">↩</a></li>').join('') + '</ol></section>'

  const html =
    '<!doctype html>\n<html lang="' + escapeHtml(String(settings.lang ?? 'en')) + '">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + escapeHtml(title === '' ? 'Research document' : title) + '</title>\n' +
    '<style>' + PAGE_STYLE + '</style>\n</head>\n<body>\n' +
    (title === '' ? '' : '<h1>' + escapeHtml(title) + '</h1>\n') +
    body.join('\n') +
    (notesHtml === '' ? '' : '\n' + notesHtml) +
    '\n</body>\n</html>\n'

  return {
    html,
    report: {
      unsupported: parsed.unsupported,
      // The counts a build report prints, named the same way the DOCX report names
      // them so one report shape describes either artifact.
      headings: parsed.blocks.filter((block) => block.type === 'heading').length,
      paragraphs: parsed.blocks.filter((block) => block.type === 'paragraph').length,
      footnotes: notes.length,
      images: parsed.blocks.filter((block) => block.type === 'figure').length,
      tables: parsed.blocks.filter((block) => block.type === 'table').length,
      references: referenceCount,
      selfContained: !/src=["']https?:|href=["']https?:[^"']*\.css|<script/i.test(html),
    },
  }
}

/** The page, as a string. */
export function buildHtml(options) {
  return buildHtmlReport(options).html
}

export { messageOf }
