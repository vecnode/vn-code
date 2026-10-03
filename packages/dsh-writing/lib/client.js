/**
 * dsh-writing — browser half.
 *
 * One thing lives here: **the Writing tab**, a `conversation.view` entry with the
 * id `writing` at `order: 30`, which puts it to the right of Canvas (20),
 * Trajectory (10) and Chat (0) - the chat panel's own view ring.
 *
 * WHAT IT IS. A page you write on, with the pages visible. The document model is
 * the host's (`lib/model.js`): a title, a page setup in millimetres, and blocks
 * of runs carrying the six inline marks a `.docx` holds without a style table.
 * The tab renders that model as paper, edits it, and saves it into the plugin's
 * own persistent store - many documents per conversation, the shape
 * `dsh-diagrams` gives a diagram - so nothing here overwrites a file somebody
 * wrote by hand.
 *
 * WHAT IT IS NOT, and this is the design's centre: **it renders nothing with
 * LibreOffice and it wants to.** "Proof" exports the document as a real `.docx`
 * into the conversation folder and hands that address to the SHIPPED office
 * preview, which converts it with the LibreOffice the harness already ships
 * (`@deepseek-ai/libreoffice-kit`, behind `@deepseek-ai/dsh-office-to-pdf`) and
 * paints the PDF. So the page you edit is this tab's, and the page LibreOffice
 * makes of it is core's own - which is exactly the split that keeps this package
 * from becoming a second office renderer.
 *
 * HOW THE EDITING WORKS, and why not a contenteditable library. The pack ships no
 * dependencies, and a rich-text engine would be a second model to keep in step
 * with the one the host validates. Instead the editor is small and explicit:
 * **one `contenteditable` per block**, whose DOM is read back into runs on every
 * input, and whose structure is only re-rendered when the block structure
 * changes (`epoch`) - so typing never has React rewrite the node the caret is in.
 * Formatting is applied to the MODEL (`applyMarkToRuns`, over a character range
 * computed from the selection) and the caret is then restored by character
 * offset - which means the whole formatting path is a pure function the checks
 * drive with no browser at all.
 *
 * THE PAGE BREAKER is `lib/page.js`, fetched from this plugin's own route and
 * imported from a blob URL (the shape `dsh-canvas` uses for its engine), so the
 * splitter that runs in the tab is the same file the checks drive on the host. If
 * that import fails the tab still works and says so: every block lands on one
 * page.
 */
/* global window, document, fetch, Blob, URL, console */
window.__ModuleLoader__.load({
  id: 'dsh-writing',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** The version marker shown in the status bar, so a fresh bundle is easy to spot. */
    const PLUGIN_VERSION = '0.1.0-alpha.3'
    /** The conversation view this package adds to the chat panel's ring. */
    const VIEW_ID = 'writing'
    /** Base URL of this plugin's own authenticated routes. */
    const API_ROOT = '/api/dsh-writing'
    const STATE_ROUTE = API_ROOT + '/state'
    const DOCUMENT_ROUTE = API_ROOT + '/document'
    const DELETE_ROUTE = API_ROOT + '/delete'
    const PUBLISH_ROUTE = API_ROOT + '/publish'
    const IMPORT_ROUTE = API_ROOT + '/import'
    const EXPORT_ROUTE = API_ROOT + '/export'
    const CREATE_FILE_ROUTE = API_ROOT + '/create-file'
    const SAVE_FILE_ROUTE = API_ROOT + '/save-file'
    const OPEN_FILE_ROUTE = API_ROOT + '/open-file'
    const OUTLINE_ROUTE = API_ROOT + '/outline'
    const FONTS_ROUTE = API_ROOT + '/fonts'
    /** The pane type this package registers in the right bar: a `.docx`, edited. */
    const DOC_TYPE_ID = 'dsh-writing'
    const DOC_KIND = 'writing-doc'
    /** The address the "+" guide opens a blank page under. */
    const PAGE_ADDRESS = 'sidebar://' + DOC_KIND
    /** The second pane type: this document's headings, as a navigator. */
    const OUTLINE_TYPE_ID = 'dsh-writing-outline'
    const OUTLINE_KIND = 'writing-outline'
    const OUTLINE_ADDRESS = 'sidebar://' + OUTLINE_KIND
    /** The third pane type: a workbook, edited as a grid. */
    const SHEET_TYPE_ID = 'dsh-writing-sheet'
    const SHEET_KIND = 'writing-sheet'
    /** How much of the grid is drawn before anybody asks for more, and the caps. */
    const SHEET_VIEW_ROWS = 30
    const SHEET_VIEW_COLUMNS = 26
    const SHEET_MAX_ROWS = 200
    const SHEET_MAX_COLUMNS = 78
    const SHEET_MAX_SHEETS = 12
    /** The extensions this tab edits as PAGES: what its own codec reads. */
    const PAGE_EXTENSIONS = new Set(['docx', 'md', 'markdown', 'txt'])
    /**
     * The document each conversation currently has open, by session id.
     *
     * It exists for the OUTLINE pane, which is a different surface from the
     * editor and has no other way to know which document to show. It is in-memory
     * and per page on purpose: it is a convenience between two tabs, not state
     * anything depends on.
     */
    const ACTIVE_DOCUMENTS = new Map()
    /** The mounted editors that an outline pane may ask to scroll to a heading. */
    const FOCUS_LISTENERS = new Set()
    /** The client service dsh-modal provides; resolved lazily, never required. */
    // (The New-file dialog is this tab's OWN, so no modal service is needed for
    // it: a dialog the page cannot style and cannot close on its own terms is not
    // what a document tab should hand a person.)
    const PAGE_ROUTE = API_ROOT + '/page.js'
    /** The right bar's navigation controller (dsh-rightbar), resolved lazily. */
    const SIDEBAR_SERVICE = 'sidebarRight'
    /** The tab-type registry (dsh-rightbar), whose entries name every registered kind. */
    const TAB_TYPES_SERVICE = 'sidebarRightTabs'
    /** The shipped document preview's registry id; its KIND is read from the registry. */
    const PREVIEW_TYPE_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
    /** The preview's kind on the pinned line, used only when the registry has no such type. */
    const PREVIEW_FALLBACK_KIND = 'text'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'
    /** CSS pixels per millimetre at 100% page scale (96 dpi). */
    const PX_PER_MM = 96 / 25.4
    /** Millimetres per CSS pixel: the same number, the other way. */
    const MM_PER_PX = 25.4 / 96
    /**
     * How many characters one line measurement walks before it gives up and
     * estimates the rest. A measurement happens on every keystroke for the block
     * being typed in, so its cost must not grow with the worst paragraph in the
     * document: past this many characters the remaining text becomes ONE estimated
     * line (see `measureLinesFor`), which keeps every character and loses only
     * precision about where the last page break falls.
     */
    const MAX_LINE_SCAN = 2400
    /** The zoom ladder. The page is laid out in millimetres; this only magnifies. */
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2]
    /** How long typing rests before the document saves itself. */
    const AUTOSAVE_MS = 4000
    /** The inline marks, in toolbar order. */
    const MARK_BUTTONS = [
      ['b', 'B', 'Bold'],
      ['i', 'I', 'Italic'],
      ['u', 'U', 'Underline'],
      ['s', 'S', 'Strikethrough'],
      ['code', '\u2039\u203a', 'Code'],
    ]
    /** The block types the toolbar offers, with the label each option shows. */
    const BLOCK_CHOICES = [
      ['paragraph', null, 'Body text'],
      ['heading', 1, 'Heading 1'],
      ['heading', 2, 'Heading 2'],
      ['heading', 3, 'Heading 3'],
      ['quote', null, 'Quote'],
      ['code', null, 'Code block'],
    ]
    /** A page break, as a block (the writer emits `<w:br w:type="page"/>`). */
    const PAGE_BREAK_BLOCK = { type: 'pageBreak', runs: [{ text: '', marks: [] }] }

    // -----------------------------------------------------------------------
    // The pure half: runs, marks and HTML. No DOM, no React, no state - which is
    // what lets check-client-bundles drive all of it with hand-built trees.
    // -----------------------------------------------------------------------

    /** Escape one text node for an HTML string. */
    function escapeHtml(text) {
      return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
    }

    /** The marks an element name adds, if any. */
    function markForTag(tag) {
      switch (String(tag ?? '').toUpperCase()) {
        case 'B':
        case 'STRONG':
          return 'b'
        case 'I':
        case 'EM':
          return 'i'
        case 'U':
          return 'u'
        case 'S':
        case 'STRIKE':
        case 'DEL':
          return 's'
        case 'CODE':
          return 'code'
        default:
          return null
      }
    }

    /** Strip the quotes a browser puts around a family name. */
    function unquoteFamily(value) {
      return String(value ?? '')
        .split(',')[0]
        .trim()
        .replace(/^["']|["']$/g, '')
    }

    /**
     * A CSS font-size as POINTS. A browser reports back the inline value it was
     * given (`14pt`), but a px value is converted rather than dropped: 96 px to
     * the inch and 72 points to the inch, so px * 0.75 is points.
     *
     * @param value - the CSS value.
     * @returns the size in points, or null when it says nothing usable.
     */
    function parseFontSize(value) {
      const match = /^([\d.]+)\s*(pt|px|em|rem|%)?$/i.exec(String(value ?? '').trim())
      if (!match) return null
      const number = Number(match[1])
      if (!Number.isFinite(number) || number <= 0) return null
      const unit = (match[2] ?? 'pt').toLowerCase()
      if (unit === 'px') return Math.round(number * 0.75 * 2) / 2
      if (unit === 'pt') return Math.round(number * 2) / 2
      // An em/rem/% size needs the element's computed style to resolve, and
      // guessing one is worse than saying nothing.
      return null
    }

    /** The inline style one run's family and size produce (`''` when it has none). */
    function runStyle(run) {
      const parts = []
      if (typeof run.font === 'string' && run.font.length > 0) parts.push("font-family:'" + String(run.font).replaceAll("'", '') + "'")
      if (Number.isFinite(run.size)) parts.push('font-size:' + run.size + 'pt')
      return parts.join(';')
    }

    /** Whether two runs carry the same properties, so their text may merge. */
    function sameRun(left, right) {
      return (
        (left.marks ?? []).join(',') === (right.marks ?? []).join(',') &&
        (left.font ?? '') === (right.font ?? '') &&
        (left.size ?? null) === (right.size ?? null)
      )
    }

    /** Append a run, merging it with the previous one when EVERY property agrees. */
    function pushRun(out, text, marks, font = '', size = null) {
      if (typeof text !== 'string' || text.length === 0) return
      const normalized = MARK_BUTTONS.map((entry) => entry[0]).filter((mark) => marks.includes(mark))
      const family = typeof font === 'string' ? font : ''
      const points = Number.isFinite(size) ? Number(size) : null
      const last = out[out.length - 1]
      if (last && sameRun(last, { marks: normalized, font: family, size: points })) {
        last.text += text
        return
      }
      const run = { text, marks: normalized }
      if (family.length > 0) run.font = family
      if (points !== null) run.size = points
      out.push(run)
    }

    /**
     * Runs from a DOM-shaped tree: `'text'` or `{ tag, children, font, size }`.
     *
     * The browser hands this the real DOM (through `nodesFromDom`), and a check
     * hands it the same shape by hand - so the ONE piece of logic that decides
     * what a person's typing means is driven in both places.
     *
     * @param nodes - the children, in order.
     * @param inherited - `{ marks, font, size }` the enclosing elements carry.
     * @returns the runs (never fewer than one, possibly empty).
     */
    function runsFromNodes(nodes, inherited = null) {
      const outer = inherited ?? { marks: [], font: '', size: null }
      const out = []
      const walk = (list, properties) => {
        for (const node of Array.isArray(list) ? list : []) {
          if (typeof node === 'string') {
            pushRun(out, node, properties.marks, properties.font, properties.size)
            continue
          }
          if (!node || typeof node !== 'object') continue
          const tag = String(node.tag ?? '').toUpperCase()
          if (tag === 'BR') {
            pushRun(out, '\n', properties.marks, properties.font, properties.size)
            continue
          }
          const mark = markForTag(tag)
          // Marks ACCUMULATE down the tree (bold inside italic is both); a family
          // or a size REPLACES what it inherits, because that is what an inline
          // style means.
          walk(node.children, {
            marks: mark === null ? properties.marks : properties.marks.concat(mark),
            font: typeof node.font === 'string' && node.font.length > 0 ? node.font : properties.font,
            size: Number.isFinite(node.size) ? node.size : properties.size,
          })
        }
      }
      walk(nodes, outer)
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /** A block's total character count: what a caret offset is measured in. */
    function runsLength(runs) {
      return (Array.isArray(runs) ? runs : []).reduce((total, run) => total + String(run.text ?? '').length, 0)
    }

    /**
     * The marks in force at one character offset - what the toolbar highlights.
     * A caret between two runs reads the run it is at the START of, because that
     * is the run the next character will join.
     *
     * @param runs - the block's runs.
     * @param offset - the caret offset.
     * @returns the marks (an array).
     */
    function marksAt(runs, offset) {
      const list = Array.isArray(runs) ? runs : []
      let cursor = 0
      for (const run of list) {
        const next = cursor + String(run.text ?? '').length
        if (offset >= cursor && offset <= next) return Array.isArray(run.marks) ? [...run.marks] : []
        cursor = next
      }
      const last = list[list.length - 1]
      return last && Array.isArray(last.marks) ? [...last.marks] : []
    }

    /**
     * Add or remove one mark over one character range, as a pure function of the
     * runs.
     *
     * The rule is a TOGGLE over the whole range: if every character in the range
     * already carries the mark it is removed, otherwise it is added to all of
     * them. That is what makes Ctrl+B on a half-bold selection bold the whole
     * thing rather than flipping each half independently.
     *
     * @param runs - the block's runs.
     * @param start - the range's first character.
     * @param end - the range's end (exclusive).
     * @param mark - the mark to toggle.
     * @returns the new runs.
     */
    function applyMarkToRuns(runs, start, end, mark) {
      const out = []
      const from = Math.max(0, Math.min(start, end))
      const to = Math.max(start, end)
      const list = Array.isArray(runs) ? runs : []
      if (to <= from) return list.map((run) => ({ text: run.text, marks: [...(run.marks ?? [])] }))
      let cursor = 0
      let any = false
      let allMarked = true
      for (const run of list) {
        const runStart = cursor
        const runEnd = cursor + String(run.text ?? '').length
        cursor = runEnd
        if (Math.min(to, runEnd) <= Math.max(from, runStart)) continue
        any = true
        if (!(run.marks ?? []).includes(mark)) allMarked = false
      }
      if (!any) return list.map((run) => ({ text: run.text, marks: [...(run.marks ?? [])] }))
      const add = !allMarked
      cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const marks = run.marks ?? []
        const runStart = cursor
        const runEnd = cursor + text.length
        cursor = runEnd
        const overlapStart = Math.max(from, runStart)
        const overlapEnd = Math.min(to, runEnd)
        if (overlapEnd <= overlapStart) {
          pushRun(out, text, marks)
          continue
        }
        pushRun(out, text.slice(0, overlapStart - runStart), marks)
        pushRun(out, text.slice(overlapStart - runStart, overlapEnd - runStart), add ? marks.concat(mark) : marks.filter((entry) => entry !== mark))
        pushRun(out, text.slice(overlapEnd - runStart), marks)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * Everything the toolbar needs to know about the caret's position: the marks
     * in force and the family and size the next character would take.
     *
     * @param runs - the block's runs.
     * @param offset - the caret offset.
     * @returns `{ marks, font, size }`.
     */
    function propertiesAt(runs, offset) {
      const list = Array.isArray(runs) ? runs : []
      let cursor = 0
      for (const run of list) {
        const next = cursor + String(run.text ?? '').length
        if (offset >= cursor && offset <= next) {
          return { marks: [...(run.marks ?? [])], font: run.font ?? '', size: Number.isFinite(run.size) ? run.size : null }
        }
        cursor = next
      }
      const last = list[list.length - 1] ?? {}
      return { marks: [...(last.marks ?? [])], font: last.font ?? '', size: Number.isFinite(last.size) ? last.size : null }
    }

    /**
     * Set one run property (the font family or the size) over one character range.
     *
     * SET, not toggle - unlike a mark, a family and a size have a value, and
     * "apply the same value again" is idempotent. `null` (or an empty family)
     * CLEARS the property back to the document's default, which is why the two
     * are handled by one function: the difference is only what the caller passes.
     *
     * @param runs - the block's runs.
     * @param start - the range's first character.
     * @param end - the range's end (exclusive).
     * @param key - `'font'` or `'size'`.
     * @param value - the family name, the size in points, or null to clear.
     * @returns the new runs.
     */
    function applyAttributeToRuns(runs, start, end, key, value) {
      const out = []
      const from = Math.max(0, Math.min(start, end))
      const to = Math.max(start, end)
      const list = Array.isArray(runs) ? runs : []
      if (to <= from && list.length === 0) return list
      const wanted = key === 'size' ? (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null) : String(value ?? '').trim()
      let cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const runStart = cursor
        const runEnd = cursor + text.length
        cursor = runEnd
        const overlapStart = Math.max(from, runStart)
        const overlapEnd = Math.min(to, runEnd)
        const set = (part, marks, font, size) => pushRun(out, part, marks, font, size)
        if (overlapEnd <= overlapStart) {
          set(text, run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
          continue
        }
        const font = key === 'font' ? (wanted.length > 0 ? wanted : '') : run.font ?? ''
        const size = key === 'size' ? wanted : Number.isFinite(run.size) ? run.size : null
        set(text.slice(0, overlapStart - runStart), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
        set(text.slice(overlapStart - runStart, overlapEnd - runStart), run.marks ?? [], font, size)
        set(text.slice(overlapEnd - runStart), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * One block's runs split at a character offset - Enter in the middle of a
     * paragraph.
     * @returns `[left, right]`, each at least an empty run.
     */
    function splitRunsAt(runs, offset) {
      const left = []
      const right = []
      let cursor = 0
      for (const run of Array.isArray(runs) ? runs : []) {
        const text = String(run.text ?? '')
        const end = cursor + text.length
        if (offset >= end) pushRun(left, text, run.marks ?? [])
        else if (offset <= cursor) pushRun(right, text, run.marks ?? [])
        else {
          pushRun(left, text.slice(0, offset - cursor), run.marks ?? [])
          pushRun(right, text.slice(offset - cursor), run.marks ?? [])
        }
        cursor = end
      }
      return [left.length > 0 ? left : [{ text: '', marks: [] }], right.length > 0 ? right : [{ text: '', marks: [] }]]
    }

    /** Two blocks' runs joined - Backspace at the start of a block. */
    function mergeRuns(first, second) {
      const out = []
      for (const run of (Array.isArray(first) ? first : []).concat(Array.isArray(second) ? second : [])) {
        pushRun(out, String(run.text ?? ''), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * The runs between two character offsets - what ONE PAGE of a block shows.
     *
     * This is why a paragraph can be broken across a page boundary without the
     * model ever holding half a paragraph: the page renders
     * `sliceRuns(block.runs, from, to)`, and an edit inside that fragment is put
     * back with {@link replaceRange} at the same offsets.
     *
     * @param runs - the block's runs.
     * @param from - the first character to keep.
     * @param to - the end (exclusive); `null` means the block's own end.
     * @returns the sliced runs.
     */
    function sliceRuns(runs, from, to) {
      const list = Array.isArray(runs) ? runs : []
      const total = runsLength(list)
      const start = Math.max(0, Math.min(Number(from) || 0, total))
      const end = to === null || to === undefined ? total : Math.max(start, Math.min(Number(to) || 0, total))
      const out = []
      let cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const runEnd = cursor + text.length
        const a = Math.max(start, cursor)
        const b = Math.min(end, runEnd)
        if (b > a) pushRun(out, text.slice(a - cursor, b - cursor), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
        cursor = runEnd
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * One range of a block's runs replaced by new ones - an edit inside a page
     * fragment, put back where it belongs.
     *
     * @param runs - the block's runs.
     * @param from - the range's first character.
     * @param to - the range's end; `null` means the block's own end.
     * @param replacement - the runs that stand in its place.
     * @returns the new runs.
     */
    function replaceRange(runs, from, to, replacement) {
      const total = runsLength(runs)
      const start = Math.max(0, Math.min(Number(from) || 0, total))
      const end = to === null || to === undefined ? total : Math.max(start, Math.min(Number(to) || 0, total))
      return mergeRuns(mergeRuns(sliceRuns(runs, 0, start), replacement), sliceRuns(runs, end, total))
    }

    /** Runs as HTML, with the one break an empty editable needs to take a caret. */
    function runsHtml(runs) {
      const html = (Array.isArray(runs) ? runs : []).map(runHtml).join('')
      return html.length > 0 ? html : '<br>'
    }

    /** Plain text as one unmarked run (what a paste of one line becomes). */
    function runsFromPlainText(text) {
      const value = String(text ?? '')
      return value.length > 0 ? [{ text: value, marks: [] }] : [{ text: '', marks: [] }]
    }

    /** One run as HTML. */
    function runHtml(run) {
      let html = escapeHtml(run.text).replaceAll('\n', '<br>')
      if (html.length === 0) return ''
      const marks = Array.isArray(run.marks) ? run.marks : []
      if (marks.includes('code')) html = '<code>' + html + '</code>'
      if (marks.includes('b')) html = '<strong>' + html + '</strong>'
      if (marks.includes('i')) html = '<em>' + html + '</em>'
      if (marks.includes('u')) html = '<u>' + html + '</u>'
      if (marks.includes('s')) html = '<s>' + html + '</s>'
      // The family and the size are an inline STYLE around the marks, which is
      // also the shape `nodesFromDom` reads back: a span with a style is exactly
      // what the browser leaves behind after the toolbar set one.
      const style = runStyle(run)
      return style.length > 0 ? '<span style="' + escapeHtml(style) + '">' + html + '</span>' : html
    }

    /**
     * One block's inner HTML, for the page AND for the measurer (which renders
     * exactly this string at the page's content width and reads the height).
     */
    function blockHtmlString(block) {
      const inner = (Array.isArray(block && block.runs) ? block.runs : []).map(runHtml).join('')
      // An empty contenteditable collapses to nothing and cannot be clicked
      // into, so an empty block renders one break - which reads back as a soft
      // break, and a block of nothing but breaks is normalized to empty.
      return inner.length > 0 ? inner : '<br>'
    }

    /** The class and data attributes one block's element wears. */
    function blockAttributes(block, extra) {
      const attributes = {
        'data-type': block.type,
        className: 'dsw-block' + (block.type === 'listItem' ? ' dsw-list' : ''),
      }
      if (block.type === 'heading') attributes['data-level'] = String(block.level ?? 1)
      if (block.type === 'listItem') {
        attributes['data-ordered'] = block.ordered === true ? 'true' : 'false'
        attributes['data-level'] = String(block.level ?? 0)
      }
      if (block.align) attributes['data-align'] = block.align
      return Object.assign(attributes, extra ?? {})
    }

    /** The toolbar's label for one block's type. */
    function describeBlock(block) {
      if (!block) return 'Body text'
      if (block.type === 'heading') return 'Heading ' + (block.level ?? 1)
      const choice = BLOCK_CHOICES.find((entry) => entry[0] === block.type)
      return choice ? choice[2] : 'Body text'
    }

    /**
     * One block retyped, keeping its text and its alignment. This is the one
     * place a toolbar's block choice becomes a block, so the rule that `level`
     * and `ordered` belong to the types that use them is stated once.
     *
     * @param block - the block to retype.
     * @param type - the new type.
     * @param level - a heading level, or a list level.
     * @param ordered - a list kind.
     * @returns the new block.
     */
    function retypeBlock(block, type, level = null, ordered = null) {
      const next = { type: type === 'pageBreak' ? 'paragraph' : type, runs: block && Array.isArray(block.runs) ? block.runs : [{ text: '', marks: [] }] }
      if (block && block.align) next.align = block.align
      if (next.type === 'heading') next.level = Math.min(6, Math.max(1, Number(level) || (block && block.level) || 1))
      if (next.type === 'listItem') {
        next.ordered = ordered === null ? block && block.ordered === true : ordered === true
        next.level = Math.min(4, Math.max(0, Number(level) || (block && block.level) || 0))
      }
      return next
    }

    /**
     * The degradation when `lib/page.js` cannot be imported: everything on one
     * page, and the tab says so. A wrong page break is a page break somebody
     * moves by hand; a blank surface is a tab that does not work at all.
     */
    function fallbackPaginate({ blocks }) {
      const list = Array.isArray(blocks) ? blocks : []
      let top = 0
      const placed = []
      list.forEach((block, index) => {
        if (block && block.type === 'pageBreak') return
        placed.push({ index, topMm: top, heightMm: 0, overflow: false })
        top += 1
      })
      return { pages: [{ index: 0, blocks: placed }], overflow: 0, content: { widthMm: 0, heightMm: 0, marginsMm: {} }, degraded: true }
    }

    // -----------------------------------------------------------------------
    // The DOM adapters: the only browser-shaped code in the pure half.
    // -----------------------------------------------------------------------

    /** A DOM subtree in the `{ tag, children, font, size }` shape `runsFromNodes` reads. */
    function nodesFromDom(element) {
      const nodes = []
      const children = element && element.childNodes ? Array.from(element.childNodes) : []
      for (const child of children) {
        if (child.nodeType === 3) {
          nodes.push(child.nodeValue ?? '')
          continue
        }
        if (child.nodeType !== 1) continue
        const style = child.style ?? {}
        const node = { tag: child.tagName || child.nodeName || '', children: nodesFromDom(child) }
        // A family or a size the toolbar set arrives here as the inline style the
        // browser kept, which is why this reads the element's OWN style and not
        // its computed one: inheriting from an ancestor is the model's job.
        const family = unquoteFamily(style.fontFamily ?? '')
        if (family.length > 0) node.font = family
        const size = parseFontSize(style.fontSize ?? '')
        if (size !== null) node.size = size
        nodes.push(node)
      }
      return nodes
    }

    /** How many characters one DOM node is worth, with `<br>` counting as one. */
    function charCount(node) {
      if (!node) return 0
      if (node.nodeType === 3) return (node.nodeValue ?? '').length
      if (String(node.tagName || '').toUpperCase() === 'BR') return 1
      let total = 0
      for (const child of node.childNodes ? Array.from(node.childNodes) : []) total += charCount(child)
      return total
    }

    /** A text node's element parent and its index inside it (`<br>` positions). */
    function childIndex(node) {
      const parent = node.parentNode
      if (!parent || !parent.childNodes) return null
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) }
    }

    /**
     * The selection's character offsets inside one block element, or null when
     * the selection is elsewhere. `<br>` counts as one character because the
     * model says a soft break is `\n`, and a caret that disagreed with the model
     * would format the wrong words.
     */
    function caretOffsets(root) {
      try {
        const selection = window.getSelection ? window.getSelection() : null
        if (!selection || selection.rangeCount === 0 || !root) return null
        const range = selection.getRangeAt(0)
        if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
        const start = offsetWithin(root, range.startContainer, range.startOffset)
        const end = offsetWithin(root, range.endContainer, range.endOffset)
        if (start === null || end === null) return null
        return { start, end }
      } catch (err) {
        return null
      }
    }

    /** The character offset of one (container, offset) position inside `root`. */
    function offsetWithin(root, container, offset) {
      let total = 0
      let found = false
      const walk = (node) => {
        for (const child of node.childNodes ? Array.from(node.childNodes) : []) {
          if (found) return
          if (child === container) {
            if (child.nodeType === 3) {
              total += Math.min(Number(offset) || 0, (child.nodeValue ?? '').length)
            } else {
              const kids = child.childNodes ? Array.from(child.childNodes) : []
              for (let index = 0; index < Math.min(Number(offset) || 0, kids.length); index += 1) total += charCount(kids[index])
            }
            found = true
            return
          }
          if (child.nodeType === 3 || String(child.tagName || '').toUpperCase() === 'BR') total += charCount(child)
          else walk(child)
        }
      }
      walk(root)
      return found ? total : null
    }

    /** Put the caret back at a character offset inside one block element. */
    function setCaretOffsets(root, start, end) {
      try {
        if (!root || !window.getSelection || !document.createRange) return
        const selection = window.getSelection()
        const range = document.createRange()
        const first = locateOffset(root, start)
        const last = end === undefined || end === null ? first : locateOffset(root, end)
        if (!first || !last) return
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (err) {
        /* a caret we could not restore is a caret the next click fixes */
      }
    }

    /** The (node, offset) a Range should start at for one character offset. */
    function locateOffset(root, target) {
      const wanted = Math.max(0, Number(target) || 0)
      let total = 0
      let result = null
      const walk = (node) => {
        for (const child of node.childNodes ? Array.from(node.childNodes) : []) {
          if (result) return
          if (child.nodeType === 3) {
            const length = (child.nodeValue ?? '').length
            if (wanted <= total + length) {
              result = { node: child, offset: Math.max(0, wanted - total) }
              return
            }
            total += length
            continue
          }
          if (String(child.tagName || '').toUpperCase() === 'BR') {
            if (wanted <= total) {
              result = childIndex(child)
              return
            }
            total += 1
            continue
          }
          walk(child)
        }
      }
      walk(root)
      return result ?? { node: root, offset: root && root.childNodes ? root.childNodes.length : 0 }
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------
    const CSS = `
.dsw-root{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--dsw-font-family,inherit)}
.dsw-bar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-height:38px;flex-wrap:wrap;row-gap:4px}
.dsw-group{display:flex;align-items:center;gap:3px;flex:none}
.dsw-sep{width:1px;height:18px;background:var(--dsw-alias-border-l3);margin:0 2px;flex:none}
.dsw-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;box-sizing:border-box;padding:0 6px;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsw-btn[data-active=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3)}
.dsw-btn:disabled{opacity:.4;cursor:default}
.dsw-btn[data-emphasis=primary]{background:var(--dsw-alias-state-accent,#4f8cff);color:#fff;padding:0 10px;font-weight:500}
.dsw-bold{font-weight:700}
.dsw-italic{font-style:italic}
.dsw-under{text-decoration:underline}
.dsw-strike{text-decoration:line-through}
.dsw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsw-select{height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;outline:none;max-width:132px}
.dsw-title{flex:1 1 150px;min-width:120px;height:24px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;padding:0 6px;outline:none}
.dsw-title:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-title:focus{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}
.dsw-alignGlyph{display:inline-flex;flex-direction:column;justify-content:center;gap:2px;width:13px;height:13px}
.dsw-alignGlyph i{display:block;height:1.5px;background:currentColor;border-radius:1px}
.dsw-alignGlyph[data-mode=left] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=left] i:nth-child(2){width:66%}
.dsw-alignGlyph[data-mode=left] i:nth-child(3){width:86%}
.dsw-alignGlyph[data-mode=center] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=center] i:nth-child(2){width:64%;margin:0 auto}
.dsw-alignGlyph[data-mode=center] i:nth-child(3){width:86%;margin:0 auto}
.dsw-alignGlyph[data-mode=right] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=right] i:nth-child(2){width:66%;margin-left:auto}
.dsw-alignGlyph[data-mode=right] i:nth-child(3){width:86%;margin-left:auto}
.dsw-alignGlyph[data-mode=justify] i{width:100%}
.dsw-menu{position:relative;flex:none}
.dsw-menu>summary{list-style:none;cursor:pointer;user-select:none;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);font-size:12px}
.dsw-menu>summary::-webkit-details-marker{display:none}
.dsw-menu[open]>summary{background:var(--dsw-alias-interactive-bg-active)}
.dsw-menuPanel{position:absolute;left:0;top:calc(100% + 6px);z-index:1000;min-width:230px;display:flex;flex-direction:column;gap:4px;padding:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.dsw-menuPanel[data-side=right]{left:auto;right:0}
.dsw-menuRow{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.dsw-menuItem{display:block;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dsw-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsw-menuItem:disabled{opacity:.5;cursor:default}
.dsw-num{width:52px;height:22px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;outline:none}
.dsw-body{flex:1;min-height:0;display:flex}
.dsw-rail{flex:none;width:218px;min-width:218px;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3);overflow:hidden}
.dsw-railHead{flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-railList{flex:1;min-height:0;overflow:auto;padding:4px}
.dsw-railSection{padding:8px 8px 2px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsw-railItem{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:6px 7px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsw-railItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-railItem[data-active=true]{background:var(--dsw-alias-interactive-bg-active)}
.dsw-railTitle{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-railMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsw-railFoot{flex:none;display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsw-importRow{display:flex;gap:4px}
.dsw-input{flex:1;min-width:0;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:0 6px;outline:none}
.dsw-scroll{flex:1;min-width:0;overflow:auto;padding:16px 0 140px;background:var(--dsw-alias-bg-layer-1)}
.dsw-pages{display:flex;flex-direction:column;align-items:center;gap:16px}
.dsw-page{position:relative;box-sizing:border-box;background:#fff;color:#111;box-shadow:0 1px 3px rgba(0,0,0,.24),0 8px 24px rgba(0,0,0,.14)}
.dsw-pageNo{position:absolute;left:0;right:0;bottom:7px;text-align:center;font-size:10.5px;color:#8a8a8a;pointer-events:none}
.dsw-pageFlow{box-sizing:border-box}
.dsw-block{outline:none;min-height:1.5em;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal}
.dsw-block+.dsw-block{margin-top:0}
.dsw-block[data-type=paragraph]{margin:0 0 .42em}
/* Heading sizes are relative (em) to the DOCUMENT's own size, so changing the
   document font size scales the headings with it instead of leaving a 12pt page
   with 23px headings. */
.dsw-block[data-type=heading]{margin:0 0 .5em;font-weight:600;line-height:1.25}
.dsw-block[data-level="1"]{font-size:1.9em}
.dsw-block[data-level="2"]{font-size:1.55em}
.dsw-block[data-level="3"]{font-size:1.3em}
.dsw-block[data-level="4"]{font-size:1.12em}
.dsw-block[data-type=heading][data-level="1"]{font-size:1.9em}
.dsw-block[data-type=heading][data-level="2"]{font-size:1.55em}
.dsw-block[data-type=heading][data-level="3"]{font-size:1.3em}
.dsw-block[data-type=heading][data-level="4"]{font-size:1.12em}
.dsw-block[data-type=heading][data-level="5"]{font-size:1em}
.dsw-block[data-type=heading][data-level="6"]{font-size:1em;font-style:italic}
.dsw-block[data-type=listItem]{margin:0 0 .2em}
.dsw-block[data-type=listItem][data-level="0"]{padding-left:1.6em;text-indent:-1.1em}
.dsw-block[data-type=listItem][data-level="1"]{padding-left:3.2em;text-indent:-1.1em}
.dsw-block[data-type=listItem][data-level="2"]{padding-left:4.8em;text-indent:-1.1em}
.dsw-block[data-type=listItem][data-level="3"]{padding-left:6.4em;text-indent:-1.1em}
.dsw-block[data-type=listItem][data-ordered=false][data-level="0"]:before{content:"\\2022\\00a0\\00a0"}
.dsw-block[data-type=listItem][data-ordered=false][data-level="1"]:before{content:"\\25e6\\00a0\\00a0"}
.dsw-block[data-type=listItem][data-ordered=false][data-level="2"]:before{content:"\\25aa\\00a0\\00a0"}
.dsw-block[data-type=listItem][data-ordered=false][data-level="3"]:before{content:"\\2022\\00a0\\00a0"}
.dsw-block[data-type=listItem][data-ordered=true][data-level="0"]{counter-increment:dsw-list0}
.dsw-block[data-type=listItem][data-ordered=true][data-level="0"]:before{content:counter(dsw-list0) ".\\00a0\\00a0"}
.dsw-block[data-type=listItem][data-ordered=true][data-level="1"]{counter-increment:dsw-list1}
.dsw-block[data-type=listItem][data-ordered=true][data-level="1"]:before{content:counter(dsw-list1) ".\\00a0\\00a0"}
.dsw-pageFlow{counter-reset:dsw-list0 dsw-list1}
.dsw-block[data-type=quote]{margin:0 1.4em .42em;padding-left:.7em;border-left:2px solid #d8d8d8;color:#4a4a4a;font-style:italic}
.dsw-block[data-type=code]{margin:0 0 .42em;padding:.35em .5em;background:#f5f5f5;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap}
.dsw-block[data-align=center]{text-align:center}
.dsw-block[data-align=right]{text-align:right}
.dsw-block[data-align=justify]{text-align:justify}
.dsw-page[data-proof=true] .dsw-block{background:transparent}
.dsw-break{position:relative;height:0;border-top:1px dashed rgba(211,56,44,.55);margin:.6em 0 .8em}
.dsw-break:after{content:"page break";position:absolute;right:0;top:-14px;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:rgba(211,56,44,.9)}
.dsw-measure{position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none;z-index:-1}
.dsw-loss{flex:none;display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-state-warning-bg,rgba(210,153,34,.14));font-size:12px}
.dsw-lossText{flex:1;min-width:0}
.dsw-status{flex:none;display:flex;align-items:center;gap:10px;padding:4px 10px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsw-status[data-kind=err]{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsw-status[data-kind=warn]{color:var(--dsw-alias-state-warning-primary,#d29922)}
.dsw-spacer{flex:1;min-width:0}
.dsw-empty{padding:24px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dsw-emptyPage{min-height:1.5em;cursor:text;color:transparent}
/* A fragment is part of a block the page boundary runs through: it must not carry
   the block's bottom margin, or the page break would add space nobody asked for. */
.dsw-block[data-split=true]{margin-bottom:0}
.dsw-block[data-split=true]:after{content:"";display:block}
/* THE NEW-FILE DIALOG: a real dialog, centred over the tab, closed by Escape, a
   click outside, or the moment the file exists. */
.dsw-dialogMask{position:absolute;inset:0;z-index:1100;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.32)}
.dsw-dialog{width:min(420px,86%);display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.34)}
.dsw-dialogTitle{font-size:13px;font-weight:600}
.dsw-dialogRow{display:flex;align-items:center;gap:6px}
.dsw-dialogInput{flex:1;min-width:0;height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-state-accent,#4f8cff);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px;outline:none}
.dsw-dialogExt{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsw-dialogActions{display:flex;justify-content:flex-end;gap:6px}
/* The font control is wide because a family name is; the datalist does the
   filtering, so this only has to hold what has been typed. */
.dsw-font{width:132px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 5px;outline:none}
.dsw-font:disabled{opacity:.5}
/* THE HEADINGS NAVIGATOR. A column of its own on the right of the page, the way
   a word processor's navigator sits: indented by level, quiet until hovered. */
.dsw-outline{flex:none;width:216px;min-width:216px;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);overflow:hidden}
.dsw-outlineHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineList{flex:1;min-height:0;overflow:auto;padding:4px}
.dsw-outlineItem{display:block;width:100%;text-align:left;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-outlineItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-outlineItem[data-heading-active=true]{background:var(--dsw-alias-interactive-bg-active)}
.dsw-outlineItem[data-heading-level="1"]{font-weight:600}
.dsw-outlineItem[data-heading-level="2"]{padding-left:1.1em}
.dsw-outlineItem[data-heading-level="3"]{padding-left:2.2em;color:var(--dsw-alias-label-secondary)}
.dsw-outlineItem[data-heading-level="4"]{padding-left:3.3em;color:var(--dsw-alias-label-secondary)}
.dsw-outlineItem[data-heading-level="5"]{padding-left:4.4em;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineItem[data-heading-level="6"]{padding-left:5.5em;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineText{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The right-bar pane shell: the same surface, one column. */
.dsw-pane{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--dsw-font-family,inherit)}
.dsw-paneBar{flex:none;display:flex;align-items:center;gap:6px;height:38px;box-sizing:border-box;padding:0 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-paneTitle{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* THE GRID. A table, because a spreadsheet IS a table: the headers are the row
   and column names the addresses are built from, and the first column and row
   stay put while the rest scrolls. */
.dsw-gridWrap{flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
.dsw-grid{border-collapse:separate;border-spacing:0;table-layout:fixed;font:12px/1.4 var(--dsw-font-family,inherit)}
.dsw-gridHead{position:sticky;top:0;z-index:2;min-width:76px;width:76px;height:22px;box-sizing:border-box;padding:0 4px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:center;font-size:11px}
.dsw-grid tbody .dsw-gridHead{position:sticky;left:0;z-index:1}
.dsw-gridCorner{position:sticky;left:0;top:0;z-index:3;width:44px;min-width:44px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-gridHead[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dsw-cell{min-width:76px;width:76px;height:22px;box-sizing:border-box;border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3);padding:0;vertical-align:top}
.dsw-cell[data-active=true]{outline:1.5px solid var(--dsw-alias-state-accent,#4f8cff);outline-offset:-1.5px}
.dsw-cellInput{min-height:21px;padding:1px 4px;outline:none;white-space:pre;overflow:hidden;text-overflow:ellipsis;cursor:cell}
.dsw-sheetTabs{flex:none;display:flex;align-items:center;gap:4px;padding:4px 8px;border-top:.5px solid var(--dsw-alias-border-l3);overflow-x:auto}
.dsw-sheetTab{flex:none;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dsw-sheetTab[data-active=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-state-accent,#4f8cff)}
.dsw-sheetName{flex:none;width:120px;height:22px}
`
    /** The id of the style tag, so a reload replaces it rather than stacking. */
    const CSS_TAG = 'dsh-writing/writing.css'

    /** Install the stylesheet once, replacing the old tag if there is one. */
    function installStyles(tagId, css) {
      if (!document || !document.head || typeof document.createElement !== 'function') return
      for (const child of document.head.children ? Array.from(document.head.children) : []) {
        if (child && child.dataset && child.dataset.pluginCss === tagId) child.remove()
      }
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -----------------------------------------------------------------------
    // Routes
    // -----------------------------------------------------------------------
    /** POST one JSON body and hand back the Response (a 409 is an answer, not a throw). */
    async function postJson(route, body) {
      return await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /** GET one JSON route. */
    async function getJson(route) {
      return await fetch(route, { headers: { accept: 'application/json' } })
    }

    /** A short human message from an error or a failed response body. */
    function messageOf(err) {
      if (!err) return 'unknown failure'
      if (typeof err === 'string') return err
      return err.message ? err.message : String(err)
    }

    /**
     * WHY a response failed, in the host's own words.
     *
     * Every route answers `{ ok: false, error: { code, message } }`, and a client
     * that reports only "500" makes the operator open devtools to learn what the
     * host already said. This reads that body, so the status bar carries the
     * sentence the host wrote - which is how a real failure gets reported
     * accurately instead of approximately.
     *
     * @param response - the failed response.
     * @param fallback - what to say when the body is not one of ours.
     * @returns the message.
     */
    async function failureOf(response, fallback) {
      try {
        const payload = await response.clone().json()
        if (payload && payload.error && typeof payload.error.message === 'string' && payload.error.message.length > 0) {
          return fallback + ': ' + payload.error.message
        }
      } catch (err) {
        /* not a JSON body of ours: the fallback stands */
      }
      return fallback + ' (' + response.status + ')'
    }

    // -----------------------------------------------------------------------
    // Glyphs, drawn rather than imported: the toolbar is this package's own
    // surface and the pack's rule is that artwork outlives a class rename.
    // -----------------------------------------------------------------------
    function AlignGlyph(props) {
      return h('span', { className: 'dsw-alignGlyph', 'data-mode': props.mode, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
    }

    /** Shut the `details` menu a clicked item lives in - a menu that stays open
     * after its item was chosen reads as a menu that did not work. */
    function closeMenus(element) {
      try {
        if (!element || typeof element.closest !== 'function') return
        const menu = element.closest('details')
        if (menu) menu.open = false
      } catch (err) {
        /* a menu that stays open is a nuisance, not a failure */
      }
    }

    function ToolButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsw-btn' + (props.className ? ' ' + props.className : ''),
          title: props.title,
          'data-action': props.action,
          'data-active': props.active === true ? 'true' : 'false',
          'data-emphasis': props.emphasis,
          disabled: props.disabled === true,
          onMouseDown: props.onMouseDown,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /**
     * The column name of one 0-based index: A..Z, AA..AZ, … The same arithmetic
     * a spreadsheet uses for `A1`, and the reason a cell's address is printable
     * without a lookup table.
     *
     * @param index - the 0-based column.
     * @returns the letters.
     */
    function columnName(index) {
      let value = Math.max(0, Math.floor(Number(index) || 0))
      let name = ''
      do {
        name = String.fromCharCode(65 + (value % 26)) + name
        value = Math.floor(value / 26) - 1
      } while (value >= 0)
      return name
    }

    /** `A1` for one cell. */
    function cellAddress(row, column) {
      return columnName(column) + String(row + 1)
    }

    /**
     * What a person typed into a cell, as the model holds it.
     *
     * The rules are the ones a spreadsheet has always had: a leading `=` is a
     * FORMULA (kept without the `=`, because that is what the file carries), a
     * number is a number (so a `.xlsx` has a number and not the text "42"), the
     * two boolean spellings are booleans, and anything else is text. An empty
     * cell is `null` and never `''` - one meaning for empty is what lets a round
     * trip be stable.
     *
     * @param text - what was typed.
     * @returns the cell.
     */
    function parseCellInput(text) {
      const raw = String(text ?? '')
      if (raw.length === 0) return null
      if (raw.startsWith('=')) {
        const formula = raw.slice(1).trim()
        return formula.length === 0 ? null : { value: '', formula }
      }
      const trimmed = raw.trim()
      if (trimmed.length > 0 && Number.isFinite(Number(trimmed)) && !/^0\d/.test(trimmed)) return Number(trimmed)
      if (/^true$/i.test(trimmed)) return true
      if (/^false$/i.test(trimmed)) return false
      return raw
    }

    /** One cell as the text a cell shows (a formula shows its `=`). */
    function cellDisplay(cell) {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'object') return cell.formula ? '=' + cell.formula : String(cell.value ?? '')
      if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
      return String(cell)
    }

    /** A workbook as the grid's own shape: rectangular, padded, at least 1x1. */
    function sheetGrid(sheet) {
      const rows = []
      const source = sheet && Array.isArray(sheet.rows) ? sheet.rows : []
      const width = source.reduce((widest, row) => Math.max(widest, Array.isArray(row) ? row.length : 0), 0)
      for (const row of source) {
        const cells = Array.isArray(row) ? row.slice() : []
        while (cells.length < width) cells.push(null)
        rows.push(cells)
      }
      if (rows.length === 0) rows.push([])
      return rows
    }

    // -----------------------------------------------------------------------
    // The page surface, as ELEMENTS
    //
    // Built here rather than inside the component, and taking its handlers as an
    // argument, for one reason: the surface a person writes on is the part of
    // this tab that most needs proving, and a pure element builder can be
    // rendered by a check (`renderToStaticMarkup`) with a document and a page
    // list it made itself, with no browser and no hooks involved. The component
    // below is then only wiring: state in, handlers out.
    // -----------------------------------------------------------------------

    /**
     * One FRAGMENT of a block (or one page break) as an editable element.
     *
     * A block that fits is one fragment covering it whole (`data-from` 0,
     * `data-to` empty). A block broken by a page boundary is several, one per
     * page, each carrying the character range it shows - and it is those two
     * attributes that let an edit be put back into the block at the right offset.
     */
    function blockElement(options) {
      const { block, placed, html, handlers, pageIndex } = options
      const index = placed.index
      const from = Number.isFinite(placed.from) ? placed.from : 0
      const to = placed.to === null || placed.to === undefined ? null : placed.to
      if (!block || block.type === 'pageBreak') {
        return h('div', { key: 'break-' + pageIndex + '-' + index, className: 'dsw-break', 'data-page-break': true })
      }
      const attributes = blockAttributes(block, {
        key: 'block-' + index + '-' + from,
        'data-block': String(index),
        'data-from': String(from),
        'data-to': to === null ? '' : String(to),
        contentEditable: true,
        suppressContentEditableWarning: true,
        spellCheck: true,
        dangerouslySetInnerHTML: { __html: html ?? '' },
        onInput: handlers.onInput,
        onKeyDown: handlers.onKeyDown,
        onPaste: handlers.onPaste,
        onFocus: handlers.onFocus,
      })
      if (placed.overflow) attributes['data-overflow'] = 'true'
      // A fragment is flagged when a page boundary runs through its block, so the
      // stylesheet can keep the paper's own top and bottom edges quiet.
      if (placed.split) attributes['data-split'] = 'true'
      return h('div', attributes)
    }

    /**
     * The pages: one element per page, sized in PIXELS from the millimetres the
     * model carries (`PX_PER_MM`), with the margins as the page's own padding so
     * the text sits exactly inside them. The page is white paper whatever the app
     * theme is - a sheet of paper is white in a dark room too.
     *
     * @param options - `{ doc, pages, geometry, handlers }`.
     * @returns the page elements, in order.
     */
    function pagesElement(options) {
      const { doc, pages, geometry, handlers } = options
      // Millimetres are the model's; pixels are the screen's. Rounded to two
      // decimals, because a page box at 793.7007874015748px is a number nobody
      // can read in a stylesheet and nothing gains from the extra digits.
      const px = (millimetres) => Math.round(Number(millimetres) * PX_PER_MM * 100) / 100 + 'px'
      const contentWidthPx = px(geometry.contentWidthMm)
      const pageWidthPx = px(geometry.widthMm)
      const pageHeightPx = px(geometry.heightMm)
      const margins = geometry.margins
      return (Array.isArray(pages) ? pages : []).map((page, pageIndex) =>
        h(
          'div',
          {
            key: 'page-' + pageIndex,
            className: 'dsw-page',
            'data-writing-page': pageIndex,
            style: {
              width: pageWidthPx,
              height: pageHeightPx,
              padding: px(margins.top) + ' ' + px(margins.right) + ' ' + px(margins.bottom) + ' ' + px(margins.left),
            },
          },
          h(
            'div',
            { className: 'dsw-pageFlow', style: flowStyle(doc, contentWidthPx) },
            page.blocks.map((placed) =>
              blockElement({
                block: doc.blocks[placed.index],
                placed,
                html: runsHtml(sliceRuns(doc.blocks[placed.index] ? doc.blocks[placed.index].runs : null, placed.from, placed.to)),
                handlers,
                pageIndex,
              }),
            ),
            // A page with nothing on it still needs a target: that is what an
            // empty page after a page break IS.
            page.blocks.length === 0
              ? h('div', { className: 'dsw-block dsw-emptyPage', 'data-writing-empty-page': pageIndex, onClick: handlers.onEmptyPage }, '\u00a0')
              : null,
          ),
          h('div', { className: 'dsw-pageNo' }, String(pageIndex + 1)),
        ),
      )
    }

    /**
     * The text column's own box: its width in pixels, and the document's default
     * family and size - which is what every run that names neither inherits, both
     * on screen and in the `.docx` (`docDefaults`).
     *
     * @param doc - the document.
     * @param contentWidthPx - the measured text width.
     * @returns the style object.
     */
    function flowStyle(doc, contentWidthPx) {
      const style = { width: contentWidthPx }
      if (doc && typeof doc.font === 'string' && doc.font.length > 0) style.fontFamily = "'" + doc.font.replaceAll("'", '') + "'"
      // A size is always written: it is what the heading sizes are em-relative to,
      // so leaving it off would make the document's own size invisible.
      style.fontSize = (doc && Number.isFinite(doc.fontSize) ? doc.fontSize : 12) + 'pt'
      return style
    }

    // -----------------------------------------------------------------------
    // The tab
    // -----------------------------------------------------------------------
    /**
     * The Writing view.
     *
     * A conversation view receives no `sessionId` prop: the registration's own
     * `inject` hands it in as `writingSession`.
     */
    function WritingView(props) {
      // A conversation view is handed its session by the registration's `inject`;
      // a right-bar panes tab is handed the FILE its address names. Both mount
      // this one component, because they are the same editor.
      const fileProp = props.file && typeof props.file === 'object' ? props.file : null
      const session =
        fileProp && typeof fileProp.sessionId === 'string' && fileProp.sessionId.length > 0
          ? fileProp.sessionId
          : typeof props.writingSession === 'string' && props.writingSession.length > 0
            ? props.writingSession
            : null
      const filePath = fileProp && typeof fileProp.path === 'string' && fileProp.path.length > 0 ? fileProp.path : null
      const ctxRef = useRef(props.ctx ?? null)
      /** The open document (the host's model, plus its id and revision). */
      const [doc, setDoc] = useState(null)
      const docRef = useRef(null)
      const [summaries, setSummaries] = useState([])
      const [library, setLibrary] = useState([])
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const [status, setStatus] = useState({ kind: 'info', text: '' })
      const [phase, setPhase] = useState('loading')
      const [epoch, setEpoch] = useState(0)
      const [zoom, setZoom] = useState(1)
      const [showRail, setShowRail] = useState(true)
      const [showOutline, setShowOutline] = useState(false)
      const [loss, setLoss] = useState([])
      const [conflict, setConflict] = useState(null)
      const [importPath, setImportPath] = useState('')
      const [activeIndex, setActiveIndex] = useState(null)
      const [activeMarks, setActiveMarks] = useState([])
      const [activeProperties, setActiveProperties] = useState({ font: '', size: null })
      const [exported, setExported] = useState(null)
      /** Every font family this machine has, from the host (`GET /fonts`). */
      const [fonts, setFonts] = useState([])
      const [fontsNote, setFontsNote] = useState('')
      /** The name dialog: a real dialog, not the browser's prompt. */
      const [namePrompt, setNamePrompt] = useState(null)
      /** The caret to restore after the next render, as two (block, offset) ends. */
      const pendingCaret = useRef(null)
      const measureRef = useRef(null)
      const pagesRef = useRef(null)
      /** The line-height cache, so only the block being typed in is re-measured. */
      const lineCacheRef = useRef(new Map())
      /** The active block index, readable from a listener that closes over nothing stale. */
      const activeIndexRef = useRef(null)
      /** The page breaker module: the real one from the route, or the fallback. */
      const paginatorRef = useRef(null)
      const [paginatorReady, setPaginatorReady] = useState(false)

      useEffect(() => {
        activeIndexRef.current = activeIndex
      }, [activeIndex])

      /** Every document change goes through here, so the ref and the state cannot drift. */
      const applyDoc = useCallback((next) => {
        docRef.current = next
        setDoc(next)
      }, [])

      const openDocument = useCallback((document) => {
        applyDoc(document)
        setDirty(false)
        dirtyRef.current = false
        setConflict(false)
        setLoss([])
        setActiveIndex(null)
        setActiveMarks([])
        setEpoch((value) => value + 1)
      }, [applyDoc])

      /** Read the conversation's documents (and the library) from the host. */
      const refresh = useCallback(async () => {
        if (!session) return null
        const response = await getJson(STATE_ROUTE + '?session=' + encodeURIComponent(session))
        if (!response.ok) throw new Error(await failureOf(response, 'the document list could not be read'))
        const payload = await response.json()
        setSummaries(Array.isArray(payload.documents) ? payload.documents : [])
        setLibrary(Array.isArray(payload.library) ? payload.library : [])
        return payload
      }, [session])

      /** Load one document by id. */
      const load = useCallback(
        async (id) => {
          if (!session || !id) return
          setPhase('loading')
          try {
            const response = await getJson(DOCUMENT_ROUTE + '?session=' + encodeURIComponent(session) + '&id=' + encodeURIComponent(id))
            if (!response.ok) throw new Error(await failureOf(response, 'the document could not be read'))
            const payload = await response.json()
            openDocument(payload.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: '' })
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, session],
      )

      /** Create a blank document and open it. */
      const create = useCallback(
        async (title) => {
          if (!session) return null
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              title: title && title.length > 0 ? title : 'Untitled',
              blocks: [{ type: 'paragraph', runs: [{ text: '', marks: [] }] }],
              by: 'user',
              note: 'created',
            })
            if (!response.ok) throw new Error(await failureOf(response, 'a new document could not be created'))
            const payload = await response.json()
            openDocument(payload.document)
            setPhase('ready')
            await refresh()
            return payload.document
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
            return null
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Open the FILE a right-bar pane was asked for.
       *
       * The host decides whether that means an existing linked document or a
       * fresh import, so this side never has to know - and a `.docx` opened from
       * Files behaves exactly like one created by "New" from here on.
       */
      const openFile = useCallback(
        async (relativePath, options = {}) => {
          if (!session || !relativePath) return
          setPhase('loading')
          try {
            const response = await postJson(OPEN_FILE_ROUTE, { session, path: relativePath, reload: options.reload === true, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not open the file (' + response.status + ')')
            openDocument(payload.document)
            setLoss(Array.isArray(payload.loss) ? payload.loss : [])
            setPhase('ready')
            setStatus({ kind: 'info', text: (payload.reused ? 'Opened ' : 'Imported ') + relativePath })
            await refresh()
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Save the open document. `force` skips the revision check, which is what
       * "Keep mine" means when the host answered 409.
       */
      const save = useCallback(
        async (options = {}) => {
          const current = docRef.current
          if (!session || !current) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Saving\u2026' })
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              id: current.id,
              title: current.title,
              page: current.page,
              font: current.font,
              fontSize: current.fontSize,
              blocks: current.blocks,
              by: 'user',
              note: options.note ?? 'edited',
              expectedRevision: options.force === true ? undefined : current.revision,
            })
            if (response.status === 409) {
              setConflict('document')
              setStatus({ kind: 'warn', text: 'This document changed elsewhere \u2014 reload it or keep this version.' })
              return false
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'save failed (' + response.status + ')')
            }
            const payload = await response.json()
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(null)
            setStatus({ kind: 'info', text: 'Saved ' + new Date().toLocaleTimeString() })
            await refresh()
            // A document linked to a file is written to that file too: the store
            // is where the tab keeps its copy, and the file is what the person
            // will open in Word or LibreOffice. Saving one without the other
            // would be a silent divergence.
            if (current.origin && typeof current.origin.path === 'string' && current.origin.path.length > 0) {
              return await saveToFile({ force: options.force === true, silent: options.silent === true })
            }
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Save failed: ' + messageOf(err) })
            return false
          }
        },
        // `saveToFile` is defined below and closes over the same refs, so it is
        // deliberately not a dependency here (it would be recreated every render).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [applyDoc, refresh, session],
      )

      /**
       * Write the open document back to the FILE it came from.
       *
       * The file is what somebody opens in Word or LibreOffice, so this is the
       * write that must not lose work: the host writes atomically and answers 409
       * with the file's current stat when it moved underneath the tab.
       */
      const saveToFile = useCallback(
        async (options = {}) => {
          const current = docRef.current
          const origin = current && current.origin ? current.origin : null
          if (!session || !current || !origin || typeof origin.path !== 'string' || origin.path.length === 0) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Writing ' + origin.path + '\u2026' })
          try {
            const response = await postJson(SAVE_FILE_ROUTE, {
              session,
              id: current.id,
              expected: { mtimeMs: origin.mtimeMs, size: origin.size },
              force: options.force === true,
            })
            if (response.status === 409) {
              const payload = await response.json().catch(() => null)
              if (payload && payload.error && payload.error.code === 'CHANGED_ON_DISK') {
                setConflict('file')
                setStatus({ kind: 'warn', text: 'The file changed on disk since it was opened \u2014 reload it or keep this version.' })
                return false
              }
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'write failed (' + response.status + ')')
            }
            const payload = await response.json()
            setDirty(false)
            dirtyRef.current = false
            setConflict(null)
            setStatus({ kind: 'info', text: 'Wrote ' + payload.name + ' (' + payload.bytes + ' bytes)' })
            await load(current.id)
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Could not write the file: ' + messageOf(err) })
            return false
          }
        },
        [load, session],
      )

      /**
       * Create a REAL file in the conversation folder.
       *
       * The name is asked in the tab's OWN dialog (`namePrompt`), not with
       * `window.prompt`: the browser's prompt is a modal the page cannot style,
       * cannot keep a keyboard contract for, and cannot close when the file is
       * made. The dialog confirms ONCE and the file starts - which is the whole
       * of what "New" should be.
       *
       * @param format - `'docx'`, `'xlsx'`, `'md'` or `'txt'`.
       * @param name - the name to create (already confirmed by the dialog).
       * @returns the created file's payload, or null.
       */
      const createFile = useCallback(
        async (format, name) => {
          if (!session) return null
          try {
            setStatus({ kind: 'info', text: 'Creating ' + name + '\u2026' })
            const response = await postJson(CREATE_FILE_ROUTE, { session, format, name, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not create the file (' + response.status + ')')
            // The dialog is gone the moment the file exists: one action, one result.
            setNamePrompt(null)
            if (format === 'xlsx') {
              // A workbook is edited in the RIGHT BAR's grid pane, not on a page:
              // creating one hands the new address there, and if the bar is not
              // mounted the file is still real and the status bar says where it
              // is rather than pretending a grid opened.
              const controller = (() => {
                const ctx = ctxRef.current
                try {
                  return ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
                } catch (err) {
                  return undefined
                }
              })()
              if (controller && typeof controller.openResource === 'function') {
                controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + payload.path, { kind: SHEET_KIND })
                setStatus({ kind: 'info', text: 'Created ' + payload.name + ' \u2014 opened in the right bar' })
              } else {
                setStatus({ kind: 'warn', text: 'Created ' + payload.name + ' in the conversation folder (the right bar is not mounted)' })
              }
              await refresh()
              return payload
            }
            openDocument(payload.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Created ' + payload.name })
            await refresh()
            return payload
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
            return null
          }
        },
        [openDocument, refresh, session],
      )

      /** Open the tab's own New-file dialog, with the name it should suggest. */
      const askForFile = useCallback(
        (format) => {
          const extension = format === 'xlsx' ? '.xlsx' : format === 'docx' ? '.docx' : format === 'md' ? '.md' : '.txt'
          const base = format === 'xlsx' ? 'Spreadsheet' : 'Document'
          setNamePrompt({ format, value: base + extension, extension, title: 'New ' + (format === 'xlsx' ? 'spreadsheet' : 'document') })
        },
        [],
      )

      /** Delete the open document. */
      const remove = useCallback(
        async (id) => {
          if (!session || !id) return
          try {
            const response = await postJson(DELETE_ROUTE, { session, id })
            if (!response.ok) throw new Error(await failureOf(response, 'the document could not be deleted'))
            if (docRef.current && docRef.current.id === id) {
              applyDoc(null)
              setDirty(false)
              dirtyRef.current = false
            }
            setStatus({ kind: 'info', text: 'Deleted' })
            const payload = await refresh()
            if (!docRef.current && payload && payload.documents.length > 0) await load(payload.documents[0].id)
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [applyDoc, load, refresh, session],
      )

      /** Copy the open document into the shared library. */
      const publish = useCallback(async () => {
        const current = docRef.current
        if (!session || !current) return
        try {
          const saved = dirtyRef.current ? await save({ silent: true }) : true
          if (!saved) return
          const response = await postJson(PUBLISH_ROUTE, { session, id: current.id, by: 'user' })
          if (!response.ok) throw new Error(await failureOf(response, 'the document could not be published'))
          setStatus({ kind: 'info', text: 'Published to the library' })
          await refresh()
        } catch (err) {
          setStatus({ kind: 'err', text: messageOf(err) })
        }
      }, [refresh, save, session])

      /** Import a workspace file into the conversation's documents. */
      const runImport = useCallback(
        async (relativePath) => {
          const value = String(relativePath ?? '').trim()
          if (!session || value.length === 0) return
          setStatus({ kind: 'info', text: 'Reading ' + value + '\u2026' })
          try {
            const response = await postJson(IMPORT_ROUTE, { session, path: value, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'import failed (' + response.status + ')')
            openDocument(payload.document)
            setLoss(Array.isArray(payload.loss) ? payload.loss : [])
            setImportPath('')
            setPhase('ready')
            setStatus({
              kind: Array.isArray(payload.loss) && payload.loss.length > 0 ? 'warn' : 'info',
              text: Array.isArray(payload.loss) && payload.loss.length > 0 ? 'Imported with ' + payload.loss.length + ' kind(s) of content this tab cannot hold' : 'Imported ' + value,
            })
            await refresh()
          } catch (err) {
            setStatus({ kind: 'err', text: 'Import failed: ' + messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /** Copy one library document into this conversation. */
      const copyHere = useCallback(
        async (id) => {
          if (!session) return
          try {
            const response = await getJson(DOCUMENT_ROUTE + '?scope=library&id=' + encodeURIComponent(id))
            if (!response.ok) throw new Error(await failureOf(response, 'the library document could not be read'))
            const payload = await response.json()
            const created = await postJson(DOCUMENT_ROUTE, {
              session,
              title: payload.document.title,
              page: payload.document.page,
              blocks: payload.document.blocks,
              by: 'user',
              note: 'copied from the library',
            })
            if (!created.ok) throw new Error('the copy could not be saved (' + created.status + ')')
            const body = await created.json()
            openDocument(body.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Copied into this conversation' })
            await refresh()
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Export the open document as a file, and hand a `.docx` to the SHIPPED
       * office preview.
       *
       * This is the whole LibreOffice story in one function: the tab writes a
       * real `.docx` into the conversation folder, and core's own preview - whose
       * `docx` body converts with the harness's bundled LibreOffice - renders it
       * in the right bar. The preview's KIND is read out of the tab-type registry
       * rather than hardcoded, so a harness line that renames it cannot turn this
       * button into a dead one.
       */
      const exportDocument = useCallback(
        async (format, options = {}) => {
          const current = docRef.current
          if (!session || !current) return null
          setStatus({ kind: 'info', text: 'Exporting\u2026' })
          try {
            if (dirtyRef.current) await save({ silent: true })
            const response = await postJson(EXPORT_ROUTE, {
              session,
              id: current.id,
              format,
              target: options.target === 'desktop' ? 'desktop' : 'workspace',
              name: options.name,
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'export failed (' + response.status + ')')
            setExported(payload)
            if (options.proof === true) {
              const opened = openInPreview(payload.path)
              setStatus({
                kind: opened ? 'info' : 'warn',
                text: opened ? 'Exported ' + payload.name + ' \u2014 LibreOffice is rendering it in the right bar' : 'Exported ' + payload.name + ' to the conversation folder (the right bar is not mounted)',
              })
            } else {
              setStatus({ kind: 'info', text: 'Exported ' + payload.name })
            }
            return payload
          } catch (err) {
            setStatus({ kind: 'err', text: 'Export failed: ' + messageOf(err) })
            return null
          }
        },
        [save, session],
      )

      /** The kind the shipped document preview registered under, read from the registry. */
      const previewKind = useCallback(() => {
        const ctx = ctxRef.current
        try {
          const registry = ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
          const entries = registry && typeof registry.entries === 'function' ? registry.entries() : null
          for (const definition of Array.isArray(entries) ? entries : []) {
            if (definition && definition.id === PREVIEW_TYPE_ID && typeof definition.kind === 'string') return definition.kind
          }
        } catch (err) {
          /* fall through to the pinned line's kind */
        }
        return PREVIEW_FALLBACK_KIND
      }, [])

      /** Open one exported workspace file in the shipped preview. */
      const openInPreview = useCallback(
        (relativePath) => {
          const ctx = ctxRef.current
          const controller = ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
          if (!controller || typeof controller.openResource !== 'function') return false
          try {
            controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + relativePath, { kind: previewKind() })
            return true
          } catch (err) {
            return false
          }
        },
        [previewKind, session],
      )

      // ---------------------------------------------------------------------
      // The page breaker module (fetched once, imported from a blob URL)
      // ---------------------------------------------------------------------
      useEffect(() => {
        let cancelled = false
        const load = async () => {
          if (paginatorRef.current) return
          paginatorRef.current = { paginate: fallbackPaginate, degraded: true }
          try {
            if (typeof fetch !== 'function' || !URL || typeof URL.createObjectURL !== 'function' || typeof Blob !== 'function') {
              setPaginatorReady(true)
              return
            }
            const response = await fetch(PAGE_ROUTE, { headers: { accept: 'text/javascript' } })
            if (!response.ok) throw new Error('status ' + response.status)
            const source = await response.text()
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            try {
              const module = await import(/* webpackIgnore: true */ url)
              if (typeof module.paginate === 'function') paginatorRef.current = module
            } finally {
              URL.revokeObjectURL(url)
            }
          } catch (err) {
            // The fallback is already installed and the status bar says so.
          }
          if (!cancelled) setPaginatorReady(true)
        }
        void load()
        return () => {
          cancelled = true
        }
      }, [])

      // ---------------------------------------------------------------------
      // Load on mount: the FILE this pane was opened for, or the conversation's
      // own documents (creating the first one so the tab is never a blank box).
      // ---------------------------------------------------------------------
      useEffect(() => {
        if (!session) {
          setPhase('error')
          setStatus({ kind: 'err', text: 'This tab needs a conversation.' })
          return undefined
        }
        let cancelled = false
        const start = async () => {
          setPhase('loading')
          try {
            if (filePath !== null) {
              await openFile(filePath)
              return
            }
            const payload = await refresh()
            if (cancelled || !payload) return
            if (payload.documents.length > 0) await load(payload.documents[0].id)
            else await create('Untitled')
          } catch (err) {
            if (!cancelled) {
              setPhase('error')
              setStatus({ kind: 'err', text: messageOf(err) })
            }
          }
        }
        void start()
        return () => {
          cancelled = true
        }
      }, [create, filePath, load, openFile, refresh, session])

      // ---------------------------------------------------------------------
      // This machine's fonts, and the outline's link to the mounted editor
      // ---------------------------------------------------------------------
      useEffect(() => {
        let cancelled = false
        const read = async () => {
          try {
            const response = await getJson(FONTS_ROUTE)
            if (!response.ok) throw new Error(await failureOf(response, 'the font list could not be read'))
            const payload = await response.json()
            if (cancelled) return
            setFonts(Array.isArray(payload.families) ? payload.families : [])
            setFontsNote(payload.count + ' families on this machine' + (payload.failed > 0 ? ', ' + payload.failed + ' unreadable file(s)' : ''))
          } catch (err) {
            if (!cancelled) {
              setFonts([])
              setFontsNote('the font list is unavailable: ' + messageOf(err))
            }
          }
        }
        void read()
        return () => {
          cancelled = true
        }
      }, [])

      /**
       * An outline pane asking this editor to show a heading. The pane and the
       * editor are different tabs, so this is the one channel between them: the
       * editor registers, the pane calls, and a jump that cannot be made (the
       * editor is not mounted) is simply not made.
       */
      useEffect(() => {
        const listener = (askedSession, index) => {
          if (askedSession !== session) return
          jumpToRef.current(index)
        }
        FOCUS_LISTENERS.add(listener)
        return () => {
          FOCUS_LISTENERS.delete(listener)
        }
      }, [session])

      /**
       * The document this conversation has open, for the outline pane to read.
       * It is published on every load and removed when the editor goes away.
       */
      useEffect(() => {
        if (!session) return undefined
        if (doc && doc.id) ACTIVE_DOCUMENTS.set(session, { id: doc.id, title: doc.title, origin: doc.origin ?? null })
        return () => {
          if (session && docRef.current === null) ACTIVE_DOCUMENTS.delete(session)
        }
      }, [doc, session])

      // ---------------------------------------------------------------------
      // Autosave, and one last save when the tab goes away
      // ---------------------------------------------------------------------
      useEffect(() => {
        if (!dirty || !doc) return undefined
        const timer = setTimeout(() => {
          void save({ silent: true })
        }, AUTOSAVE_MS)
        return () => clearTimeout(timer)
      }, [dirty, doc, save])

      useEffect(
        () => () => {
          // A tab closing is a component unmount: the last unsaved keystrokes get
          // one attempt. (A whole page reload cannot be caught, which is what the
          // autosave window is for.)
          if (dirtyRef.current && docRef.current) void save({ silent: true, note: 'autosave on close' })
        },
        [save],
      )

      // ---------------------------------------------------------------------
      // The page surface as the editor sees it: fragments, carets and selection
      //
      // A block may be rendered as SEVERAL fragments (one per page), so every
      // position is a pair `{ source, offset }` - a block index and a character
      // offset INTO that block - and the DOM is only ever a view of it. This is
      // the layer that keeps that promise: read a fragment, splice it back, find
      // the fragment a position lives in, and put a caret or a selection there.
      // ---------------------------------------------------------------------

      /** Every fragment element on screen, in document order (page by page). */
      const allFragments = useCallback(() => {
        const root = pagesRef.current
        if (!root || typeof root.querySelectorAll !== 'function') return []
        return Array.from(root.querySelectorAll('[data-block]'))
      }, [])

      /** One fragment's own facts, read out of the attributes it was rendered with. */
      const fragmentInfo = useCallback((element) => {
        if (!element || typeof element.getAttribute !== 'function') return null
        const raw = element.getAttribute('data-block')
        if (raw === null) return null
        const to = element.getAttribute('data-to')
        return {
          source: Number(raw),
          from: Number(element.getAttribute('data-from') || 0),
          to: to === null || to === '' ? null : Number(to),
          length: charCount(element),
        }
      }, [])

      /** Is this fragment the WHOLE of its block (the common case)? */
      const isWholeFragment = useCallback(
        (info) => {
          if (!info) return false
          const block = docRef.current ? docRef.current.blocks[info.source] : null
          if (!block) return false
          const length = runsLength(block.runs)
          return info.from === 0 && (info.to === null || info.to >= length)
        },
        [],
      )

      /** The fragment element one (block, offset) position lives in. */
      const fragmentForOffset = useCallback(
        (source, offset) => {
          const fragments = allFragments()
          let last = null
          for (const element of fragments) {
            const info = fragmentInfo(element)
            if (!info || info.source !== source) continue
            const end = info.to === null ? info.from + info.length : info.to
            if (offset >= info.from && offset <= end) return { element, local: offset - info.from, info }
            last = { element, local: info.length, info }
          }
          return last
        },
        [allFragments, fragmentInfo],
      )

      /** Put the caret (or a selection) at one or two model positions. */
      const placeCaret = useCallback(
        (from, to) => {
          const start = fragmentForOffset(from.source, from.offset)
          if (!start) return
          const end = to ? fragmentForOffset(to.source, to.offset) : start
          try {
            if (typeof start.element.focus === 'function') start.element.focus()
            if (end && end.element !== start.element && typeof window !== 'undefined' && window.getSelection && document.createRange) {
              // A selection that spans fragments (or pages) is a RANGE over the
              // document, not over one editable: that is what lets a person
              // select a paragraph that a page boundary runs through.
              const range = document.createRange()
              const first = locateOffset(start.element, start.local) || { node: start.element, offset: 0 }
              const last = locateOffset(end.element, end.local) || { node: end.element, offset: end.element.childNodes.length }
              range.setStart(first.node, first.offset)
              range.setEnd(last.node, last.offset)
              const selection = window.getSelection()
              selection.removeAllRanges()
              selection.addRange(range)
              return
            }
            setCaretOffsets(start.element, start.local, start.local)
          } catch (err) {
            /* a caret we could not restore is a caret the next click fixes */
          }
        },
        [fragmentForOffset],
      )

      /** The model positions of the current selection, clipped to each fragment. */
      const selectedTargets = useCallback(() => {
        try {
          if (typeof window === 'undefined' || !window.getSelection) return null
          const selection = window.getSelection()
          if (!selection || selection.rangeCount === 0) return null
          const range = selection.getRangeAt(0)
          const out = []
          for (const element of allFragments()) {
            const info = fragmentInfo(element)
            if (!info) continue
            const intersects =
              typeof range.intersectsNode === 'function'
                ? range.intersectsNode(element)
                : element.contains(range.startContainer) || element.contains(range.endContainer)
            if (!intersects) continue
            const startLocal = element.contains(range.startContainer) ? offsetWithin(element, range.startContainer, range.startOffset) : 0
            const endLocal = element.contains(range.endContainer) ? offsetWithin(element, range.endContainer, range.endOffset) : info.length
            out.push({ source: info.source, start: info.from + (startLocal ?? 0), end: info.from + (endLocal ?? info.length) })
          }
          return out.length > 0 ? out : null
        } catch (err) {
          return null
        }
      }, [allFragments, fragmentInfo])

      /** Select the WHOLE document, across every page - what Ctrl+A means here. */
      const selectAll = useCallback(() => {
        try {
          const fragments = allFragments()
          if (fragments.length === 0 || typeof document.createRange !== 'function' || !window.getSelection) return
          const first = fragments[0]
          const last = fragments[fragments.length - 1]
          const range = document.createRange()
          range.setStart(first, 0)
          range.setEnd(last, last.childNodes ? last.childNodes.length : 0)
          const selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          refreshToolbarState()
        } catch (err) {
          /* a browser that will not take the range leaves the browser's own Ctrl+A */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [allFragments])

      /** The whole surface re-read into blocks: a multi-block edit landed somewhere. */
      const blocksFromDom = useCallback(() => {
        const current = docRef.current
        if (!current) return null
        const fragments = []
        for (const element of allFragments()) {
          const info = fragmentInfo(element)
          if (info) fragments.push({ ...info, runs: runsFromNodes(nodesFromDom(element)) })
        }
        if (fragments.length === 0) return current.blocks
        const bySource = new Map()
        for (const fragment of fragments) {
          const list = bySource.get(fragment.source)
          if (list) list.push(fragment)
          else bySource.set(fragment.source, [fragment])
        }
        return current.blocks.map((block, index) => {
          const list = bySource.get(index)
          if (!list) return block
          if (list.length === 1 && list[0].from === 0 && (list[0].to === null || list[0].to >= blockLength(block.runs))) {
            return { ...block, runs: list[0].runs }
          }
          let runs = block.runs
          for (const fragment of list) runs = replaceRange(runs, fragment.from, fragment.to, fragment.runs)
          return { ...block, runs }
        })
      }, [allFragments, fragmentInfo])

      /** The caret's own position as a model pair, or null when it is elsewhere. */
      const currentPosition = useCallback(() => {
        try {
          if (typeof window === 'undefined' || !window.getSelection) return null
          const selection = window.getSelection()
          if (!selection || selection.rangeCount === 0) return null
          const range = selection.getRangeAt(0)
          for (const element of allFragments()) {
            if (!element.contains(range.startContainer)) continue
            const info = fragmentInfo(element)
            const local = offsetWithin(element, range.startContainer, range.startOffset)
            if (!info || local === null) return null
            return { source: info.source, offset: info.from + local, info }
          }
          return null
        } catch (err) {
          return null
        }
      }, [allFragments, fragmentInfo])

      /** What the toolbar should highlight, from wherever the caret is. */
      const refreshToolbarState = useCallback(() => {
        const position = currentPosition()
        if (!position) return
        const block = docRef.current ? docRef.current.blocks[position.source] : null
        if (!block) return
        setActiveIndex(position.source)
        setActiveMarks(marksAt(block.runs, position.offset))
        const properties = propertiesAt(block.runs, position.offset)
        setActiveProperties({ font: properties.font, size: properties.size })
      }, [currentPosition])

      // ---------------------------------------------------------------------
      // The caret, restored after a structural re-render
      // ---------------------------------------------------------------------
      useEffect(() => {
        const pending = pendingCaret.current
        if (!pending) return
        pendingCaret.current = null
        placeCaret(pending.from, pending.to)
      })

      // ---------------------------------------------------------------------
      // Which marks the toolbar shows as active
      // ---------------------------------------------------------------------
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onSelectionChange = () => refreshToolbarState()
        document.addEventListener('selectionchange', onSelectionChange)
        return () => {
          if (typeof document.removeEventListener === 'function') document.removeEventListener('selectionchange', onSelectionChange)
        }
      }, [refreshToolbarState])

      /** The active block index, readable from a listener that closes over nothing. */
      // ---------------------------------------------------------------------
      // The model edits
      // ---------------------------------------------------------------------
      /** Replace the block list, re-render the structure and put the caret back. */
      const commitBlocks = useCallback(
        (blocks, caret) => {
          const current = docRef.current
          if (!current) return
          applyDoc({ ...current, blocks })
          setDirty(true)
          dirtyRef.current = true
          if (caret) {
            pendingCaret.current = {
              from: { source: caret.index, offset: caret.start ?? 0 },
              to: { source: caret.index, offset: caret.end ?? caret.start ?? 0 },
            }
          }
          setEpoch((value) => value + 1)
        },
        [applyDoc],
      )

      /**
       * Typing: the DOM is the truth for the fragment that changed, and the model
       * follows it.
       *
       * Two paths, and the difference is a page boundary: an edit inside a whole
       * block touches exactly one block (`sliceRuns` puts it back where it was),
       * while an edit that crossed a fragment - a multi-block delete, a paste, a
       * selection spanning a page break - is put back by reading the whole
       * surface, because the model is the only thing that knows how the fragments
       * of one block fit together.
       */
      const onBlockInput = useCallback(
        (event) => {
          const current = docRef.current
          const element = event && event.currentTarget ? event.currentTarget : null
          if (!current || !element) return
          const info = fragmentInfo(element)
          if (!info) return
          const block = current.blocks[info.source]
          if (!block) return
          const offsets = caretOffsets(element)
          const collapsedInside = offsets !== null
          if (collapsedInside && isWholeFragment(info)) {
            const runs = runsFromNodes(nodesFromDom(element))
            const blocks = current.blocks.slice()
            blocks[info.source] = { ...block, runs }
            // NO epoch bump: the structure did not change, so React must not
            // touch the node the caret is in.
            applyDoc({ ...current, blocks })
          } else {
            const position = currentPosition()
            const blocks = blocksFromDom()
            if (!blocks) return
            applyDoc({ ...current, blocks })
            if (position) {
              pendingCaret.current = {
                from: { source: position.source, offset: position.offset },
                to: { source: position.source, offset: position.offset },
              }
            }
            setEpoch((value) => value + 1)
          }
          setDirty(true)
          dirtyRef.current = true
          refreshToolbarState()
        },
        [applyDoc, blocksFromDom, currentPosition, fragmentInfo, isWholeFragment, refreshToolbarState],
      )

      /** Toggle one inline mark over the selection (or the block, when collapsed). */
      const toggleMark = useCallback(
        (mark) => {
          const current = docRef.current
          const index = activeIndexRef.current
          if (!current || index === null) return
          const block = current.blocks[index]
          if (!block) return
          const targets = selectedTargets()
          // A selection that spans blocks or pages marks EVERY range it covers,
          // which is what a person expects from Ctrl+B over three paragraphs.
          const ranges =
            targets && targets.length > 1
              ? targets
              : [
                  {
                    source: index,
                    start: targets && targets.length === 1 ? targets[0].start : 0,
                    end: targets && targets.length === 1 ? targets[0].end : runsLength(block.runs),
                  },
                ]
          const whole = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end >= runsLength(block.runs)
          if (whole) setStatus({ kind: 'info', text: 'No selection: the mark applies to the whole block.' })
          const blocks = current.blocks.slice()
          for (const range of ranges) {
            const target = blocks[range.source]
            if (!target) continue
            blocks[range.source] = { ...target, runs: applyMarkToRuns(target.runs, range.start, range.end, mark) }
          }
          const first = ranges[0]
          const last = ranges[ranges.length - 1]
          commitBlocks(blocks, { index: first.source, start: first.start, end: last.end })
        },
        [commitBlocks, selectedTargets],
      )

      /**
       * Set the family or the size over the selection (or the whole block when
       * there is none) - the same rule the marks use, so there is one thing to
       * learn: a toolbar control with nothing selected acts on the block.
       */
      const applyAttribute = useCallback(
        (key, value) => {
          const current = docRef.current
          const index = activeIndexRef.current
          if (!current || index === null) return
          const block = current.blocks[index]
          if (!block) return
          const targets = selectedTargets()
          const ranges =
            targets && targets.length > 1
              ? targets
              : [
                  {
                    source: index,
                    start: targets && targets.length === 1 ? targets[0].start : 0,
                    end: targets && targets.length === 1 ? targets[0].end : runsLength(block.runs),
                  },
                ]
          const whole = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end >= runsLength(block.runs)
          if (whole) setStatus({ kind: 'info', text: 'No selection: ' + (key === 'font' ? 'the font' : 'the size') + ' applies to the whole block.' })
          const blocks = current.blocks.slice()
          for (const range of ranges) {
            const target = blocks[range.source]
            if (!target) continue
            blocks[range.source] = { ...target, runs: applyAttributeToRuns(target.runs, range.start, range.end, key, value) }
          }
          const first = ranges[0]
          const last = ranges[ranges.length - 1]
          commitBlocks(blocks, { index: first.source, start: first.start, end: last.end })
        },
        [commitBlocks, selectedTargets],
      )

      /**
       * The document's own default family and size - what a run with no font of
       * its own inherits. One write, and the whole page changes, which is what
       * "pick a font for this document" has to mean.
       */
      const setDocumentTypography = useCallback(
        (patch) => {
          const current = docRef.current
          if (!current) return
          applyDoc({
            ...current,
            font: patch.font !== undefined ? patch.font : current.font,
            fontSize: patch.fontSize !== undefined ? patch.fontSize : current.fontSize,
          })
          setDirty(true)
          dirtyRef.current = true
          setEpoch((value) => value + 1)
        },
        [applyDoc],
      )

      /** This document's headings, for the navigator. */
      const headings = useMemo(() => {
        if (!doc) return []
        return doc.blocks
          .map((block, index) =>
            block.type === 'heading' ? { index, level: block.level ?? 1, text: block.runs.map((run) => run.text).join('') || '(untitled heading)' } : null,
          )
          .filter(Boolean)
      }, [doc, epoch])

      /** Show one heading: scroll to its block and put the caret in it. */
      const jumpTo = useCallback(
        (index) => {
          const found = fragmentForOffset(index, 0)
          if (!found) return
          if (typeof found.element.scrollIntoView === 'function') found.element.scrollIntoView({ block: 'center' })
          placeCaret({ source: index, offset: 0 }, null)
        },
        [fragmentForOffset, placeCaret],
      )
      // The outline pane reaches the editor through FOCUS_LISTENERS, which is
      // registered once - so it calls the LATEST jump through a ref instead of
      // holding a stale one.
      const jumpToRef = useRef(jumpTo)
      jumpToRef.current = jumpTo

      /** Give the active block a type, a list kind or an alignment. */
      const retype = useCallback(
        (type, level, ordered) => {
          const current = docRef.current
          const index = activeIndexRef.current
          if (!current || index === null) return
          const position = currentPosition()
          const blocks = current.blocks.slice()
          blocks[index] = retypeBlock(blocks[index], type, level, ordered)
          commitBlocks(blocks, position ? { index, start: position.offset, end: position.offset } : null)
        },
        [commitBlocks, currentPosition],
      )

      /** Set the alignment of the active block. */
      const setAlign = useCallback(
        (align) => {
          const current = docRef.current
          const index = activeIndexRef.current
          if (!current || index === null) return
          const position = currentPosition()
          const blocks = current.blocks.slice()
          const block = { ...blocks[index] }
          if (align === null) delete block.align
          else block.align = align
          blocks[index] = block
          commitBlocks(blocks, position ? { index, start: position.offset, end: position.offset } : null)
        },
        [commitBlocks, currentPosition],
      )

      /** Insert a page break after the active block. */
      const insertPageBreak = useCallback(() => {
        const current = docRef.current
        if (!current) return
        const index = activeIndexRef.current === null ? current.blocks.length - 1 : activeIndexRef.current
        const blocks = current.blocks.slice()
        blocks.splice(index + 1, 0, { ...PAGE_BREAK_BLOCK, runs: [{ text: '', marks: [] }] })
        blocks.splice(index + 2, 0, { type: 'paragraph', runs: [{ text: '', marks: [] }] })
        commitBlocks(blocks, { index: index + 2, start: 0, end: 0 })
      }, [commitBlocks])

      /** Insert a literal string at the caret (Tab), then re-read the fragment. */
      const insertTextAtCaret = useCallback((text) => {
        try {
          const selection = window.getSelection ? window.getSelection() : null
          if (!selection || selection.rangeCount === 0) return
          const range = selection.getRangeAt(0)
          range.deleteContents()
          const node = document.createTextNode(text)
          range.insertNode(node)
          range.setStartAfter(node)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
          const parent = node.parentNode
          const fragment = parent && typeof parent.closest === 'function' ? parent.closest('[data-block]') : null
          if (fragment && typeof fragment.dispatchEvent === 'function') {
            fragment.dispatchEvent(new Event('input', { bubbles: true }))
          }
        } catch (err) {
          /* a Tab that did nothing is better than a Tab that threw */
        }
      }, [])

      /** Is the caret on the LAST visual line of this fragment (so Down leaves it)? */
      const caretOnEdgeLine = useCallback((element, edge) => {
        try {
          if (typeof window === 'undefined' || !window.getSelection || !window.getComputedStyle) return true
          const selection = window.getSelection()
          if (!selection || selection.rangeCount === 0) return true
          const range = selection.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          const box = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          const line = parseFloat(style.lineHeight)
          const fallback = (parseFloat(style.fontSize) || 16) * 1.45
          const height = Number.isFinite(line) && line > 0 ? line : fallback
          // A zero-height rect (a collapsed caret at the very end) still carries a
          // top, which is the line it is on - and that is all this needs.
          const top = rect.height > 0 ? rect.top : rect.top || box.top
          if (edge === 'last') return top + height >= box.bottom - 1
          return top <= box.top + 1
        } catch (err) {
          return true
        }
      }, [])

      /** Move the caret to the neighbouring fragment - across a page if need be. */
      const moveToNeighbour = useCallback(
        (element, forward) => {
          const fragments = allFragments()
          const at = fragments.indexOf(element)
          if (at === -1) return false
          const next = fragments[forward ? at + 1 : at - 1]
          if (!next) return false
          const info = fragmentInfo(next)
          if (!info) return false
          const offset = forward ? info.from : info.from + info.length
          placeCaret({ source: info.source, offset }, null)
          return true
        },
        [allFragments, fragmentInfo, placeCaret],
      )

      /**
       * The keyboard: Enter, Backspace, Tab, the mark shortcuts, Ctrl+A, and the
       * two movements a browser stops at a paragraph boundary - Down off the last
       * line and Right off the last character, which is where a word processor
       * walks on to the next paragraph (or the next PAGE).
       */
      const onBlockKeyDown = useCallback(
        (event) => {
          const current = docRef.current
          const element = event && event.currentTarget ? event.currentTarget : null
          if (!current || !element) return
          const info = fragmentInfo(element)
          if (!info) return
          const index = info.source
          const key = String(event.key ?? '')
          const accel = event.ctrlKey === true || event.metaKey === true
          if (accel && (key === 'a' || key === 'A')) {
            event.preventDefault()
            selectAll()
            return
          }
          if (accel && (key === 's' || key === 'S')) {
            event.preventDefault()
            void save({ note: 'saved' })
            return
          }
          if (accel && (key === 'b' || key === 'B')) {
            event.preventDefault()
            toggleMark('b')
            return
          }
          if (accel && (key === 'i' || key === 'I')) {
            event.preventDefault()
            toggleMark('i')
            return
          }
          if (accel && (key === 'u' || key === 'U')) {
            event.preventDefault()
            toggleMark('u')
            return
          }
          if (key === 'Tab') {
            event.preventDefault()
            insertTextAtCaret('\t')
            return
          }
          // Movement ACROSS blocks and pages. The browser owns every movement
          // inside one fragment; these are the four ends where it stops.
          if (!accel && !event.shiftKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
            const offsets = caretOffsets(element)
            if (offsets && offsets.start === offsets.end && caretOnEdgeLine(element, key === 'ArrowDown' ? 'last' : 'first')) {
              const atEnd = key === 'ArrowDown' ? offsets.start >= runsLength(current.blocks[index] ? current.blocks[index].runs : []) : false
              // Down from the last line goes to the next block (or page); Up from
              // the first line goes back to the previous one.
              if (key === 'ArrowUp' || atEnd || offsets.start > 0) {
                if (moveToNeighbour(element, key === 'ArrowDown')) {
                  event.preventDefault()
                  return
                }
              }
            }
          }
          if (!accel && !event.shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft')) {
            const offsets = caretOffsets(element)
            const length = runsLength(current.blocks[index] ? current.blocks[index].runs : [])
            if (offsets && offsets.start === offsets.end && ((key === 'ArrowRight' && offsets.end >= length) || (key === 'ArrowLeft' && offsets.start === 0))) {
              if (moveToNeighbour(element, key === 'ArrowRight')) {
                event.preventDefault()
                return
              }
            }
          }
          if (key === 'Enter' && event.shiftKey !== true) {
            event.preventDefault()
            const offsets = caretOffsets(element)
            if (!offsets) return
            const at = info.from + offsets.start
            const block = current.blocks[index]
            // The split is of the BLOCK, at the caret's offset in the MODEL: a
            // fragment boundary in the middle of a paragraph must not matter.
            const [left, right] = splitRunsAt(block.runs, at)
            const blocks = current.blocks.slice()
            blocks[index] = { ...block, runs: left }
            const fresh = { type: block.type === 'heading' || block.type === 'code' || block.type === 'quote' ? 'paragraph' : block.type, runs: right }
            if (fresh.type === 'listItem') {
              fresh.ordered = block.ordered === true
              fresh.level = block.level ?? 0
            }
            blocks.splice(index + 1, 0, fresh)
            commitBlocks(blocks, { index: index + 1, start: 0, end: 0 })
            return
          }
          if (key === 'Backspace') {
            const offsets = caretOffsets(element)
            if (!offsets || offsets.start !== 0 || offsets.end !== 0 || info.from + offsets.start !== 0 || index === 0) return
            const previous = current.blocks[index - 1]
            if (!previous) return
            event.preventDefault()
            // A page break in front of this block is what Backspace at the top of
            // a page removes - there is no text to merge with, and without this
            // the only way to take a break out would be to delete the block.
            if (previous.type === 'pageBreak') {
              const blocks = current.blocks.slice()
              blocks.splice(index - 1, 1)
              commitBlocks(blocks, { index: index - 1, start: 0, end: 0 })
              return
            }
            const block = current.blocks[index]
            const joinAt = runsLength(previous.runs)
            const blocks = current.blocks.slice()
            blocks[index - 1] = { ...previous, runs: mergeRuns(previous.runs, block.runs) }
            blocks.splice(index, 1)
            commitBlocks(blocks, { index: index - 1, start: joinAt, end: joinAt })
          }
        },
        [allFragments, caretOnEdgeLine, commitBlocks, fragmentInfo, insertTextAtCaret, moveToNeighbour, save, selectAll, toggleMark],
      )

      /**
       * Paste, as BLOCKS.
       *
       * The default paste would drop the clipboard's own markup into one
       * paragraph - nested divs, styles this model cannot hold, and no paragraph
       * breaks. This reads the clipboard's text, cuts it into paragraphs, and
       * inserts them as real blocks around the caret, so pasting a paragraph from
       * Word lands as paragraphs (with the marks that survived the trip).
       */
      const onBlockPaste = useCallback(
        (event) => {
          const current = docRef.current
          const element = event && event.currentTarget ? event.currentTarget : null
          if (!current || !element) return
          const clipboard = event.clipboardData
          if (!clipboard || typeof clipboard.getData !== 'function') return
          const text = clipboard.getData('text/plain') ?? ''
          if (text.length === 0) return
          event.preventDefault()
          const info = fragmentInfo(element)
          if (!info) return
          const offsets = caretOffsets(element)
          const local = offsets ? offsets.start : 0
          const at = info.from + local
          const block = current.blocks[info.source]
          if (!block) return
          const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
          const inserted = lines.map((line) => ({ type: 'paragraph', runs: runsFromPlainText(line) }))
          const [left, right] = splitRunsAt(block.runs, at)
          const blocks = current.blocks.slice()
          blocks[info.source] = { ...block, runs: mergeRuns(left, inserted[0] ? inserted[0].runs : []) }
          const rest = inserted.slice(1)
          blocks.splice(info.source + 1, 0, ...rest)
          blocks.splice(info.source + 1 + rest.length, 0, { ...block, runs: right })
          const caretIndex = info.source + rest.length + 1
          commitBlocks(blocks, { index: caretIndex, start: 0, end: 0 })
          setStatus({ kind: 'info', text: 'Pasted ' + (rest.length + 1) + ' paragraph(s)' })
        },
        [commitBlocks, fragmentInfo],
      )


      /** The document's title, as it is typed. */
      const setTitle = useCallback(
        (value) => {
          const current = docRef.current
          if (!current) return
          applyDoc({ ...current, title: value })
          setDirty(true)
          dirtyRef.current = true
        },
        [applyDoc],
      )

      /** One page-setup change (size, orientation or a margin). */
      const setPage = useCallback(
        (patch) => {
          const current = docRef.current
          if (!current) return
          const page = { ...current.page, ...patch, margins: { ...current.page.margins, ...(patch.margins ?? {}) } }
          applyDoc({ ...current, page })
          setDirty(true)
          dirtyRef.current = true
          setEpoch((value) => value + 1)
        },
        [applyDoc],
      )

      // ---------------------------------------------------------------------
      // Layout: measure each block at the page's content width, then break pages
      // ---------------------------------------------------------------------
      const geometry = useMemo(() => {
        const page = doc && doc.page ? doc.page : { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } }
        const SIZES = { a4: { width: 210, height: 297 }, letter: { width: 215.9, height: 279.4 } }
        const size = SIZES[page.size] ?? SIZES.a4
        const landscape = page.orientation === 'landscape'
        const widthMm = landscape ? size.height : size.width
        const heightMm = landscape ? size.width : size.height
        const margins = page.margins ?? { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 }
        return {
          widthMm,
          heightMm,
          margins,
          contentWidthMm: Math.max(10, widthMm - margins.left - margins.right),
          footerMm: 10,
        }
      }, [doc])

      /**
       * Put a block into the measuring box at the page's own width and
       * typography, and hand back the element to measure.
       *
       * Every measurement this tab takes goes through here, which is what keeps
       * the height of a block, the height of its lines and what the page actually
       * paints from disagreeing: one box, one font, one width.
       */
      const prepareMeasure = useCallback(
        (block) => {
          const box = measureRef.current
          if (!box || !box.firstChild) return null
          try {
            const target = box.firstChild
            const attributes = blockAttributes(block, {})
            target.className = attributes.className
            for (const key of ['data-type', 'data-level', 'data-ordered', 'data-align']) {
              if (attributes[key] === undefined) target.removeAttribute(key)
              else target.setAttribute(key, attributes[key])
            }
            target.innerHTML = blockHtmlString(block)
            box.style.width = geometry.contentWidthMm * PX_PER_MM + 'px'
            const current = docRef.current
            box.style.fontFamily = current && current.font ? "'" + String(current.font).replaceAll("'", '') + "'" : ''
            box.style.fontSize = (current && Number.isFinite(current.fontSize) ? current.fontSize : 12) + 'pt'
            return target
          } catch (err) {
            return null
          }
        },
        [geometry],
      )

      /**
       * The height of each RENDERED LINE of one block, in millimetres, with the
       * character offset at the end of each line.
       *
       * This is what makes a paragraph continue on the next page instead of
       * overflowing the one it is on, and it can only be taken in a browser: the
       * text is laid out for real and each character is asked which line it is on.
       * The scan therefore has a ceiling of {@link MAX_LINE_SCAN} characters - a
       * paragraph longer than that keeps the lines it measured and its remainder
       * becomes one estimated line, so the cost of a keystroke cannot grow with
       * the length of a document's worst paragraph.
       *
       * @param block - the block to measure.
       * @returns `{ heights, ends }` in millimetres and character offsets, or null.
       */
      const measureLinesFor = useCallback(
        (block) => {
          const target = prepareMeasure(block)
          if (!target || typeof document.createRange !== 'function' || typeof document.createTreeWalker !== 'function') return null
          try {
            const total = blockLength(block.runs)
            const heights = []
            const ends = []
            let lineTop = null
            let lineHeight = 0
            let offset = 0
            const pushLine = (end, height) => {
              heights.push(height)
              ends.push(end)
            }
            const walker = document.createTreeWalker(target, 0x4 /* NodeFilter.SHOW_TEXT */)
            let node = walker.nextNode()
            while (node && offset < MAX_LINE_SCAN) {
              const text = node.nodeValue ?? ''
              for (let at = 0; at < text.length && offset < MAX_LINE_SCAN; at += 1) {
                const range = document.createRange()
                range.setStart(node, at)
                range.setEnd(node, at + 1)
                const rect = range.getBoundingClientRect()
                const charTop = rect.top
                const charHeight = rect.height || 0
                if (lineTop === null) {
                  lineTop = charTop
                } else if (Math.abs(charTop - lineTop) > 1) {
                  // A new line: the previous one's height is the distance between
                  // their tops, which is the line ADVANCE and not the glyph box.
                  pushLine(offset, Math.max(0.5, charTop - lineTop))
                  lineTop = charTop
                  lineHeight = 0
                }
                lineHeight = Math.max(lineHeight, charHeight)
                offset += 1
              }
              node = walker.nextNode()
            }
            // A soft break is a line of its own, and the walk above cannot see it
            // (a `<br>` holds no text): count the breaks before the scan stopped as
            // boundaries by looking at the block's own text.
            const text = block.runs.map((run) => run.text).join('')
            const scanned = Math.min(offset, MAX_LINE_SCAN)
            const lineCount = Math.max(1, heights.length + 1)
            const boxHeight = (target.getBoundingClientRect().height || 0) * MM_PER_PX
            if (scanned >= total) {
              // The whole block was walked: the last line ends at the block's end.
              const lastHeight = Math.max(0.5, boxHeight - heights.reduce((sum, value) => sum + value, 0))
              pushLine(total, lastHeight)
            } else {
              // Too long to walk: the remainder becomes ONE estimated line whose
              // height is the average of the lines measured, scaled by how much
              // text is left. The page break is then approximate - and the text is
              // never lost, which is the part that matters.
              const rest = total - scanned
              const average = heights.length > 0 ? heights.reduce((sum, value) => sum + value, 0) / heights.length : Math.max(0.5, boxHeight / lineCount)
              const linesLeft = Math.max(1, Math.ceil(rest / Math.max(1, scanned / lineCount)))
              pushLine(total, average * linesLeft)
              if (text.length === 0) return null
            }
            if (heights.length === 0 || heights.some((value) => !Number.isFinite(value) || value <= 0)) return null
            return { heights, ends }
          } catch (err) {
            return null
          }
        },
        [prepareMeasure],
      )

      const pageInfo = useMemo(() => {
        const paginator = paginatorRef.current ?? { paginate: fallbackPaginate }
        const blocks = doc ? doc.blocks : []
        const current = docRef.current
        const cacheKeyBase =
          geometry.contentWidthMm + '|' + (current && current.font ? current.font : '') + '|' + (current && Number.isFinite(current.fontSize) ? current.fontSize : 12)
        const cache = lineCacheRef.current
        if (cache.size > 0 && cache.get('__base') !== cacheKeyBase) cache.clear()
        cache.set('__base', cacheKeyBase)
        const signatureOf = (block) => {
          const text = (block.runs ?? []).map((run) => run.text).join('')
          return block.type + '|' + (block.level ?? '') + '|' + (block.align ?? '') + '|' + text.length + '|' + text.slice(0, 24) + '|' + text.slice(-24)
        }
        const measure = (block) => {
          const target = prepareMeasure(block)
          if (!target) return 0
          try {
            const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null
            const height = rect && rect.height ? rect.height : target.offsetHeight || 0
            return (Number(height) || 0) * MM_PER_PX
          } catch (err) {
            return 0
          }
        }
        // Only the block that does not fit is asked for its lines, and only once
        // per (block content, width, font): typing in one paragraph re-measures
        // that paragraph, never the document.
        const measureLines = (block, index) => {
          const key = index + '|' + signatureOf(block)
          const cached = cache.get(key)
          if (cached !== undefined) return cached
          const fresh = measureLinesFor(block)
          cache.set(key, fresh)
          return fresh
        }
        return paginator.paginate({ blocks, page: doc ? doc.page : null, measure, measureLines, footerMm: geometry.footerMm })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc, epoch, geometry, paginatorReady, prepareMeasure, measureLinesFor])

      /**
       * Type on a page that has no block of its own yet.
       *
       * A page break at the end of a document leaves an empty page behind it, and
       * an empty page has nothing to put a caret in - so the page itself is the
       * click target and appends the paragraph (which is where the caret would
       * have gone anyway).
       */
      const appendParagraph = useCallback(() => {
        const current = docRef.current
        if (!current) return
        const blocks = current.blocks.slice()
        blocks.push({ type: 'paragraph', runs: [{ text: '', marks: [] }] })
        commitBlocks(blocks, { index: blocks.length - 1, start: 0, end: 0 })
      }, [commitBlocks])

      /** The handlers `pagesElement` calls: every DOM event becomes a model edit. */
      const pageHandlers = {
        onInput: onBlockInput,
        onKeyDown: onBlockKeyDown,
        onPaste: onBlockPaste,
        onFocus: () => refreshToolbarState(),
        onEmptyPage: appendParagraph,
      }

      /** Every document open/close/structural change invalidates the line cache. */
      useEffect(() => {
        lineCacheRef.current.clear()
      }, [epoch, doc ? doc.id : null, geometry.contentWidthMm])

      // ---------------------------------------------------------------------
      // Render
      // ---------------------------------------------------------------------
      const pages = pageInfo.pages ?? [{ index: 0, blocks: [] }]

      const railItems = summaries.map((item) =>
        h(
          'button',
          {
            type: 'button',
            key: 'doc-' + item.id,
            className: 'dsw-railItem',
            'data-doc': item.id,
            'data-active': doc && doc.id === item.id ? 'true' : 'false',
            onClick: () => {
              if (dirtyRef.current && docRef.current && docRef.current.id !== item.id) void save({ silent: true })
              void load(item.id)
            },
          },
          h('span', { className: 'dsw-railTitle' }, item.title || item.id),
          h('span', { className: 'dsw-railMeta' }, item.words + ' words \u00b7 ' + item.blocks + ' blocks \u00b7 ' + shortTime(item.updatedAt)),
        ),
      )

      const bar = h(
        'div',
        { className: 'dsw-bar', 'data-writing-bar': true },
        // NEW IS THE LEFTMOST CONTROL, where a document tab is expected to keep
        // it: the first thing on the bar, left of the title and every formatting
        // control (it began life in the middle of the bar, which is where nobody
        // looks for it).
        h(
          'details',
          { className: 'dsw-menu', 'data-writing-new': true },
          h('summary', null, 'New'),
          h(
            'div',
            { className: 'dsw-menuPanel', 'data-side': 'left' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsw-menuItem',
                'data-new': 'docx',
                disabled: !session,
                onClick: (event) => {
                  closeMenus(event.currentTarget)
                  askForFile('docx')
                },
              },
              'Word document (.docx) \u2014 a real file in the conversation folder',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsw-menuItem',
                'data-new': 'xlsx',
                disabled: !session,
                onClick: (event) => {
                  closeMenus(event.currentTarget)
                  askForFile('xlsx')
                },
              },
              'Spreadsheet (.xlsx) \u2014 a real file in the conversation folder',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsw-menuItem',
                'data-new': 'page',
                disabled: !session,
                onClick: (event) => {
                  closeMenus(event.currentTarget)
                  void create('Untitled')
                },
              },
              'Page kept in this conversation',
            ),
          ),
        ),
        h(
          ToolButton,
          {
            title: showRail ? 'Hide the document list' : 'Show the document list',
            action: 'rail',
            active: showRail,
            onClick: () => setShowRail((value) => !value),
          },
          '\u2630',
        ),
        h('input', {
          className: 'dsw-title',
          'data-writing-title': true,
          value: doc ? doc.title : '',
          placeholder: 'Untitled',
          disabled: !doc,
          onChange: (event) => setTitle(event.target.value),
        }),
        h('span', { className: 'dsw-sep' }),
        // THE FONTS THIS MACHINE HAS. The list is a `<datalist>`, so it filters
        // as the name is typed: a Windows box with 234 families is a list nobody
        // scrolls through, and a typed prefix is how you find one.
        h('input', {
          className: 'dsw-font',
          'data-writing-font': true,
          list: 'dsw-fontFamilies',
          placeholder: 'Font',
          title: fontsNote || 'The fonts installed on this machine',
          value: activeProperties.font || '',
          disabled: !doc,
          onChange: (event) => applyAttribute('font', event.target.value),
        }),
        h(
          'datalist',
          { id: 'dsw-fontFamilies' },
          fonts.map((entry) => h('option', { key: 'font-' + entry.family, value: entry.family }, entry.family)),
        ),
        h('input', {
          className: 'dsw-num',
          'data-writing-fontsize': true,
          type: 'number',
          min: '4',
          max: '400',
          step: '0.5',
          title: 'Size in points (applies to the selection, or to the whole block)',
          value: activeProperties.size === null ? '' : String(activeProperties.size),
          placeholder: String(doc ? doc.fontSize : 12),
          disabled: !doc,
          onChange: (event) => applyAttribute('size', Number(event.target.value)),
        }),
        h('span', { className: 'dsw-sep' }),
        h(
          'div',
          { className: 'dsw-group', 'data-writing-marks': true },
          MARK_BUTTONS.map(([mark, glyph, title]) =>
            h(
              ToolButton,
              {
                key: 'mark-' + mark,
                title: title,
                action: 'mark-' + mark,
                active: activeMarks.includes(mark),
                disabled: !doc,
                className: mark === 'b' ? 'dsw-bold' : mark === 'i' ? 'dsw-italic' : mark === 'u' ? 'dsw-under' : mark === 's' ? 'dsw-strike' : 'dsw-mono',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => toggleMark(mark),
              },
              glyph,
            ),
          ),
        ),
        h('select', {
          className: 'dsw-select',
          'data-writing-blocktype': true,
          title: doc && activeIndex !== null && doc.blocks[activeIndex] ? 'Block type: ' + describeBlock(doc.blocks[activeIndex]) : 'Block type',
          value: doc && activeIndex !== null && doc.blocks[activeIndex] ? doc.blocks[activeIndex].type + ':' + (doc.blocks[activeIndex].level ?? '') : 'paragraph:',
          disabled: !doc || activeIndex === null,
          onChange: (event) => {
            const [type, level] = String(event.target.value).split(':')
            retype(type, level === '' ? null : Number(level), null)
          },
        }, BLOCK_CHOICES.map(([type, level, label]) => h('option', { key: type + level, value: type + ':' + (level ?? '') }, label))),
        h(
          'div',
          { className: 'dsw-group', 'data-writing-lists': true },
          h(ToolButton, { title: 'Bulleted list', action: 'list-bullet', disabled: !doc, onMouseDown: (e) => e.preventDefault(), onClick: () => retype('listItem', 0, false) }, '\u2022'),
          h(ToolButton, { title: 'Numbered list', action: 'list-number', disabled: !doc, onMouseDown: (e) => e.preventDefault(), onClick: () => retype('listItem', 0, true) }, '1.'),
          h(ToolButton, { title: 'Remove the list', action: 'list-none', disabled: !doc, onMouseDown: (e) => e.preventDefault(), onClick: () => retype('paragraph', null, null) }, '\u21a9'),
        ),
        h(
          'div',
          { className: 'dsw-group', 'data-writing-align': true },
          [
            ['left', 'Align left'],
            ['center', 'Align centre'],
            ['right', 'Align right'],
            ['justify', 'Justify'],
          ].map(([mode, title]) =>
            h(
              ToolButton,
              {
                key: 'align-' + mode,
                title,
                action: 'align-' + mode,
                active: Boolean(doc && activeIndex !== null && doc.blocks[activeIndex] && doc.blocks[activeIndex].align === mode),
                disabled: !doc,
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => setAlign(mode),
              },
              h(AlignGlyph, { mode }),
            ),
          ),
        ),
        h(ToolButton, { title: 'Insert a page break', action: 'page-break', disabled: !doc, onMouseDown: (e) => e.preventDefault(), onClick: insertPageBreak }, '\u21b5\u2502'),
        h(
          ToolButton,
          {
            title: 'Show the headings of this document',
            action: 'headings',
            active: showOutline,
            disabled: !doc,
            onClick: () => setShowOutline((value) => !value),
          },
          'Headings',
        ),
        h(
          'details',
          { className: 'dsw-menu', 'data-writing-pagemenu': true },
          h('summary', null, 'Page'),
          h(
            'div',
            { className: 'dsw-menuPanel', 'data-side': 'left' },
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Size'),
              h(
                'select',
                {
                  className: 'dsw-select',
                  'data-writing-pagesize': true,
                  value: doc ? doc.page.size : 'a4',
                  disabled: !doc,
                  onChange: (event) => setPage({ size: event.target.value }),
                },
                h('option', { value: 'a4' }, 'A4 (210 \u00d7 297 mm)'),
                h('option', { value: 'letter' }, 'Letter (8.5 \u00d7 11 in)'),
              ),
            ),
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Orientation'),
              h(
                'select',
                {
                  className: 'dsw-select',
                  'data-writing-orientation': true,
                  value: doc ? doc.page.orientation : 'portrait',
                  disabled: !doc,
                  onChange: (event) => setPage({ orientation: event.target.value }),
                },
                h('option', { value: 'portrait' }, 'Portrait'),
                h('option', { value: 'landscape' }, 'Landscape'),
              ),
            ),
            ['top', 'right', 'bottom', 'left'].map((side) =>
              h(
                'div',
                { className: 'dsw-menuRow', key: 'margin-' + side },
                h('span', null, side[0].toUpperCase() + side.slice(1) + ' margin (mm)'),
                h('input', {
                  className: 'dsw-num',
                  'data-writing-margin': side,
                  type: 'number',
                  min: '0',
                  max: '100',
                  step: '1',
                  value: doc ? doc.page.margins[side] : 25.4,
                  disabled: !doc,
                  onChange: (event) => setPage({ margins: { [side]: Number(event.target.value) } }),
                }),
              ),
            ),
            // The document's OWN typography: what every run inherits when it
            // names no font of its own. Changing it here is one write, not one
            // per run - which is the difference between "this document is set in
            // Georgia" and "these four hundred runs are".
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Document font'),
              h('input', {
                className: 'dsw-font',
                'data-writing-docfont': true,
                list: 'dsw-fontFamilies',
                value: doc ? doc.font ?? '' : '',
                placeholder: 'Application default',
                disabled: !doc,
                onChange: (event) => setDocumentTypography({ font: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Document size (pt)'),
              h('input', {
                className: 'dsw-num',
                'data-writing-docsize': true,
                type: 'number',
                min: '4',
                max: '400',
                step: '0.5',
                value: doc ? doc.fontSize : 12,
                disabled: !doc,
                onChange: (event) => setDocumentTypography({ fontSize: Number(event.target.value) }),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsw-group' },
          h(
            'select',
            {
              className: 'dsw-select',
              'data-writing-zoom': true,
              value: String(zoom),
              onChange: (event) => setZoom(Number(event.target.value)),
            },
            ZOOM_STEPS.map((step) => h('option', { key: 'zoom-' + step, value: String(step) }, Math.round(step * 100) + '%')),
          ),
        ),
        h('span', { className: 'dsw-spacer' }),
        h(
          'div',
          { className: 'dsw-group' },
          conflict
            ? [
                h(
                  ToolButton,
                  {
                    key: 'reload',
                    title: conflict === 'file' ? 'Read the file from disk again' : 'Load the stored version again',
                    action: 'reload',
                    onClick: () => {
                      const current = docRef.current
                      if (!current) return
                      if (conflict === 'file') void openFile(current.origin ? current.origin.path : '', { reload: true })
                      else void load(current.id)
                    },
                  },
                  'Reload',
                ),
                h(
                  ToolButton,
                  {
                    key: 'keep',
                    title: 'Overwrite it with this version',
                    action: 'keep',
                    onClick: () => (conflict === 'file' ? saveToFile({ force: true, silent: false }) : save({ force: true, note: 'overwrote a newer revision' })),
                  },
                  'Keep mine',
                ),
              ]
            : null,
          h(ToolButton, { title: 'Save (Ctrl+S)', action: 'save', emphasis: 'primary', disabled: !doc, onClick: () => save({ note: 'saved' }) }, 'Save'),
          h(ToolButton, { title: 'Export as .docx and render it with LibreOffice', action: 'proof', disabled: !doc, onClick: () => exportDocument('docx', { proof: true }) }, 'Proof'),
          h(
            'details',
            { className: 'dsw-menu', 'data-writing-export': true },
            h('summary', null, 'Export'),
            h(
              'div',
              { className: 'dsw-menuPanel', 'data-side': 'right' },
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'docx', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('docx') } }, 'Word document (.docx) \u2014 into the conversation folder'),
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'docx-desktop', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('docx', { target: 'desktop' }) } }, 'Word document (.docx) \u2014 to the Desktop'),
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'md', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('md') } }, 'Markdown (.md)'),
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'txt', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('txt') } }, 'Plain text (.txt)'),
              exported
                ? h('div', { className: 'dsw-menuRow', 'data-writing-exported': true }, h('span', null, 'Last: ' + exported.name))
                : null,
            ),
          ),
        ),
      )

      const rail = showRail
        ? h(
            'div',
            { className: 'dsw-rail', 'data-writing-rail': true },
            h(
              'div',
              { className: 'dsw-railHead' },
              h(ToolButton, { title: 'New document', action: 'new', onClick: () => create('Untitled') }, '+ New'),
              h(ToolButton, { title: 'Save now', action: 'save-rail', disabled: !doc || !dirty, onClick: () => save({ note: 'saved' }) }, 'Save'),
            ),
            h(
              'div',
              { className: 'dsw-railList' },
              h('div', { className: 'dsw-railSection' }, 'This conversation'),
              railItems.length > 0 ? railItems : h('div', { className: 'dsw-empty' }, 'No documents yet.'),
              library.length > 0 ? h('div', { className: 'dsw-railSection' }, 'Library') : null,
              library.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: 'lib-' + item.id,
                    className: 'dsw-railItem',
                    'data-library': item.id,
                    title: 'Copy this document into the conversation',
                    onClick: () => copyHere(item.id),
                  },
                  h('span', { className: 'dsw-railTitle' }, item.title || item.id),
                  h('span', { className: 'dsw-railMeta' }, 'shared \u00b7 ' + item.words + ' words'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsw-railFoot' },
              h(
                'div',
                { className: 'dsw-importRow' },
                h('input', {
                  className: 'dsw-input',
                  'data-writing-import': true,
                  placeholder: 'notes.docx',
                  value: importPath,
                  onChange: (event) => setImportPath(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void runImport(importPath)
                  },
                }),
                h(ToolButton, { title: 'Import a .docx, .md or .txt from the conversation folder', action: 'import', onClick: () => runImport(importPath) }, 'Import'),
              ),
              h(
                'div',
                { className: 'dsw-importRow' },
                h(ToolButton, { title: 'Publish this document to the library', action: 'publish', disabled: !doc, onClick: publish }, 'Publish'),
                h(ToolButton, { title: 'Delete this document', action: 'delete', disabled: !doc, onClick: () => doc && remove(doc.id) }, 'Delete'),
              ),
            ),
          )
        : null

      /**
       * The headings of this document, as a navigator: the levels are indented,
       * clicking one puts the caret in it, and a document with no headings says
       * so rather than showing an empty box.
       */
      const outline = showOutline
        ? h(
            'div',
            { className: 'dsw-outline', 'data-writing-outline': true },
            h(
              'div',
              { className: 'dsw-outlineHead' },
              h('span', null, 'Headings'),
              h(ToolButton, { title: 'Hide the headings', action: 'headings-hide', onClick: () => setShowOutline(false) }, '\u2715'),
            ),
            h(
              'div',
              { className: 'dsw-outlineList' },
              headings.length === 0
                ? h('div', { className: 'dsw-empty' }, 'No headings yet. Give a line the "Heading 1" block type and it appears here.')
                : headings.map((heading) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'heading-' + heading.index,
                        className: 'dsw-outlineItem',
                        'data-heading-level': heading.level,
                        'data-heading-index': heading.index,
                        'data-heading-active': activeIndex === heading.index ? 'true' : 'false',
                        title: heading.text,
                        onClick: () => jumpTo(heading.index),
                      },
                      h('span', { className: 'dsw-outlineText' }, heading.text),
                    ),
                  ),
            ),
          )
        : null

      const body = h(
        'div',
        { className: 'dsw-body' },
        rail,
        h(
          'div',
          { className: 'dsw-scroll', 'data-writing-scroll': true },
          doc
            ? h(
                'div',
                { className: 'dsw-pages', ref: pagesRef, 'data-writing-pages': String(pages.length), style: { zoom: String(zoom) } },
                pagesElement({ doc, pages, geometry, handlers: pageHandlers }),
              )
            : h('div', { className: 'dsw-empty' }, phase === 'loading' ? 'Opening\u2026' : 'No document is open.'),
          h(
            'div',
            { className: 'dsw-measure', ref: measureRef, 'aria-hidden': 'true' },
            h('div', { className: 'dsw-block', 'data-type': 'paragraph' }),
          ),
        ),
        outline,
      )

      const lossBanner =        loss.length > 0
          ? h(
              'div',
              { className: 'dsw-loss', 'data-writing-loss': true },
              h(
                'span',
                { className: 'dsw-lossText' },
                'This document uses content this tab cannot represent, and saving it as .docx would drop it: ' +
                  loss.map((entry) => entry.count + ' \u00d7 ' + entry.kind).join(', ') +
                  '. Keep the original file, or edit these parts in LibreOffice.',
              ),
              h(ToolButton, { title: 'Dismiss', action: 'loss-dismiss', onClick: () => setLoss([]) }, '\u2715'),
            )
          : null

      const footer = h(
        'div',
        { className: 'dsw-status', 'data-writing-status': status.kind, 'data-writing-version': PLUGIN_VERSION },
        h('span', { 'data-writing-words': true }, doc ? wordCountOf(doc) + ' words' : '0 words'),
        h('span', null, '\u00b7'),
        h('span', { 'data-writing-pages': true }, pages.length + (pages.length === 1 ? ' page' : ' pages')),
        h('span', null, '\u00b7'),
        h('span', null, doc ? doc.blocks.length + ' blocks' : '0 blocks'),
        pageInfo.overflow > 0 ? h('span', { 'data-writing-overflow': true }, '\u00b7 ' + pageInfo.overflow + ' block(s) taller than the page') : null,
        h('span', { className: 'dsw-spacer' }),
        // A document linked to a file says which file: it is the thing the person
        // will open in Word or LibreOffice, and it is what Save writes.
        doc && doc.origin && doc.origin.path ? h('span', { 'data-writing-file': true, title: 'Linked to this file in the conversation folder' }, '\u25cf ' + doc.origin.path) : null,
        // The document's own typography, so what the page is set in is visible
        // without opening a menu; and how many families this machine offers.
        doc ? h('span', { 'data-writing-font-note': true }, (doc.font ? doc.font + ' ' : '') + doc.fontSize + 'pt') : null,
        fonts.length > 0 ? h('span', { 'data-writing-fonts-note': true, title: fontsNote }, fonts.length + ' fonts') : null,
        status.text ? h('span', { 'data-writing-message': true }, status.text) : null,
        dirty ? h('span', { 'data-writing-dirty': true }, 'unsaved') : null,
      )

      /**
       * THE NEW-FILE DIALOG.
       *
       * A real dialog in the tab's own surface, not `window.prompt`: it can be
       * styled, it keeps a keyboard contract a person can learn (the name is
       * selected, Enter creates, Escape closes), and it can close itself the
       * moment the file exists. The extension is shown beside the field and kept
       * out of what is typed, so nobody has to remember to type ".docx".
       */
      const nameDialog = namePrompt
        ? h(
            'div',
            { className: 'dsw-dialogMask', 'data-writing-dialog': namePrompt.format, onClick: () => setNamePrompt(null) },
            h(
              'div',
              {
                className: 'dsw-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                onClick: (event) => event.stopPropagation(),
              },
              h('div', { className: 'dsw-dialogTitle' }, namePrompt.title),
              h(
                'div',
                { className: 'dsw-dialogRow' },
                h('input', {
                  className: 'dsw-dialogInput',
                  'data-writing-dialogInput': true,
                  autoFocus: true,
                  value: namePrompt.value,
                  onFocus: (event) => {
                    // The suggested name is SELECTED, so typing replaces it and
                    // Enter accepts it: one keystroke either way.
                    try {
                      event.target.select()
                    } catch (err) {
                      /* a browser that will not select still gets the caret */
                    }
                  },
                  onChange: (event) => setNamePrompt({ ...namePrompt, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const value = String(namePrompt.value ?? '').trim()
                      if (value.length === 0) return
                      void createFile(namePrompt.format, value)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setNamePrompt(null)
                    }
                  },
                }),
                h('span', { className: 'dsw-dialogExt' }, namePrompt.extension),
              ),
              h(
                'div',
                { className: 'dsw-dialogActions' },
                h(
                  ToolButton,
                  {
                    title: 'Create the file and open it',
                    action: 'dialog-create',
                    emphasis: 'primary',
                    disabled: String(namePrompt.value ?? '').trim().length === 0,
                    onClick: () => void createFile(namePrompt.format, String(namePrompt.value ?? '').trim()),
                  },
                  'Create',
                ),
                h(ToolButton, { title: 'Close without creating anything', action: 'dialog-cancel', onClick: () => setNamePrompt(null) }, 'Cancel'),
              ),
            ),
          )
        : null

      ctxRef.current = props.ctx ?? ctxRef.current
      return h(
        'div',
        { className: 'dsw-root', 'data-dsh-writing-view': true, 'data-writing-phase': phase },
        bar,
        lossBanner,
        body,
        footer,
        nameDialog,
      )
    }

    /** The word count shown in the status bar, from the model's own text. */
    function wordCountOf(doc) {
      const text = (doc.blocks ?? [])
        .filter((block) => block.type !== 'pageBreak')
        .map((block) => (block.runs ?? []).map((run) => run.text).join(''))
        .join('\n')
        .trim()
      return text.length === 0 ? 0 : text.split(/\s+/).length
    }

    /** A short relative time for the rail, without a date library. */
    function shortTime(iso) {
      const then = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return 'just now'
      if (seconds < 3600) return Math.round(seconds / 60) + 'm ago'
      if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago'
      return Math.round(seconds / 86400) + 'd ago'
    }

    /**
     * The OUTLINE pane: the headings of whatever document this conversation has
     * open in the Writing tab.
     *
     * It is a second surface rather than a second editor, and that is deliberate:
     * a navigator you can park in the right bar next to the page is the point of
     * having one. It reads the outline from the host (so it works for a document
     * the editor is not even showing) and asks the mounted editor to scroll
     * through {@link FOCUS_LISTENERS} - a jump that cannot be made is simply not
     * made, which is honest for a pane that may be open beside a different tab.
     */
    function OutlinePane(props) {
      const session = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : typeof props.writingSession === 'string' ? props.writingSession : null
      // A pane with no conversation says so on its FIRST paint rather than
      // pretending to load: the state it is in is known before any effect runs.
      const [state, setState] = useState(() => ({ phase: session ? 'loading' : 'empty', title: '', headings: [], words: 0, blocks: 0 }))
      const [activeIndex, setActiveIndex] = useState(null)
      /** The document to show: whatever the Writing tab has open, re-read on a tick. */
      const [target, setTarget] = useState(null)

      useEffect(() => {
        if (!session) return undefined
        const read = () => {
          const active = ACTIVE_DOCUMENTS.get(session) ?? null
          setTarget(active)
        }
        read()
        // The editor publishes its document as it loads; a navigator has no other
        // way to hear about it, and a one-second poll is cheaper than a channel
        // between two panes that are not otherwise connected.
        const timer = setInterval(read, 1000)
        return () => clearInterval(timer)
      }, [session])

      useEffect(() => {
        if (!session || !target || !target.id) {
          setState((previous) => (previous.phase === 'loading' && !target ? previous : { phase: 'empty', title: '', headings: [], words: 0, blocks: 0 }))
          return undefined
        }
        let cancelled = false
        const read = async () => {
          try {
            const response = await fetch(OUTLINE_ROUTE + '?session=' + encodeURIComponent(session) + '&id=' + encodeURIComponent(target.id))
            if (!response.ok) throw new Error('status ' + response.status)
            const payload = await response.json()
            if (!cancelled) setState({ phase: 'ready', title: payload.title, headings: payload.headings ?? [], words: payload.words ?? 0, blocks: payload.blocks ?? 0 })
          } catch (err) {
            if (!cancelled) setState({ phase: 'error', title: '', headings: [], words: 0, blocks: 0 })
          }
        }
        void read()
        const timer = setInterval(read, 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [session, target])

      const jump = (index) => {
        setActiveIndex(index)
        for (const listener of [...FOCUS_LISTENERS]) {
          try {
            listener(session, index)
          } catch (err) {
            /* a listener that threw is a jump that did not happen */
          }
        }
      }

      return h(
        'div',
        { className: 'dsw-pane', 'data-writing-outline-pane': true, 'data-writing-pane-phase': state.phase },
        h('div', { className: 'dsw-paneBar' }, h('span', { className: 'dsw-paneTitle', 'data-writing-pane-title': true }, state.title || 'Headings')),
        state.phase === 'empty'
          ? h('div', { className: 'dsw-empty' }, 'Open a document in the Writing tab and its headings appear here.')
          : state.phase === 'error'
            ? h('div', { className: 'dsw-empty' }, 'The headings could not be read.')
            : state.headings.length === 0
              ? h('div', { className: 'dsw-empty' }, 'This document has no headings yet.')
              : h(
                  'div',
                  { className: 'dsw-outlineList' },
                  state.headings.map((heading) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'pane-heading-' + heading.index,
                        className: 'dsw-outlineItem',
                        'data-heading-level': heading.level,
                        'data-heading-index': heading.index,
                        'data-heading-active': activeIndex === heading.index ? 'true' : 'false',
                        title: heading.text,
                        onClick: () => jump(heading.index),
                      },
                      h('span', { className: 'dsw-outlineText' }, heading.text),
                    ),
                  ),
                ),
        h('div', { className: 'dsw-status' }, h('span', null, state.words + ' words'), h('span', { className: 'dsw-spacer' }), h('span', null, state.headings.length + ' headings')),
      )
    }

    /**
     * The SHEET pane: a workbook, edited as a grid.
     *
     * It is a separate surface from the page editor on purpose. A spreadsheet is
     * not a page of text: its cell is addressed, its keyboard walks a grid, and
     * its number is a number. What it SHARES with the page editor is the whole
     * host half - the same store, the same `origin` link to a real file on disk,
     * the same "Save writes the file" rule - so the only thing here is the grid.
     *
     * NOTHING HERE COMPUTES A FORMULA, and that is the design, not a gap: a
     * formula is kept as the text the file carries (`<f>` with no cached value)
     * and LibreOffice - the engine the harness already ships - is what evaluates
     * it, both in the Proof hand-off and in whatever the person opens next. A
     * second formula engine would be a second answer to the same question.
     */
    function SheetView(props) {
      const fileProp = props.file && typeof props.file === 'object' ? props.file : null
      const session =
        fileProp && typeof fileProp.sessionId === 'string' && fileProp.sessionId.length > 0
          ? fileProp.sessionId
          : typeof props.sessionId === 'string' && props.sessionId.length > 0
            ? props.sessionId
            : typeof props.writingSession === 'string'
              ? props.writingSession
              : null
      const filePath = fileProp && typeof fileProp.path === 'string' && fileProp.path.length > 0 ? fileProp.path : null
      const ctxRef = useRef(props.ctx ?? null)
      const [doc, setDoc] = useState(null)
      const docRef = useRef(null)
      // A pane with no file to open says so on its FIRST paint rather than
      // pretending to load: the state it is in is known before any effect runs.
      const [phase, setPhase] = useState(() => (filePath !== null ? 'loading' : 'empty'))
      const [status, setStatus] = useState({ kind: 'info', text: '' })
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const [activeSheet, setActiveSheet] = useState(0)
      const [activeCell, setActiveCell] = useState({ row: 0, column: 0 })
      const [viewRows, setViewRows] = useState(SHEET_VIEW_ROWS)
      const [conflict, setConflict] = useState(false)
      const cellRefs = useRef({})

      const applyDoc = useCallback((next) => {
        docRef.current = next
        setDoc(next)
      }, [])

      /** Read the file this pane was opened for. */
      const open = useCallback(
        async (options = {}) => {
          if (!session || !filePath) {
            setPhase('empty')
            return
          }
          setPhase('loading')
          try {
            const response = await postJson(OPEN_FILE_ROUTE, { session, path: filePath, reload: options.reload === true, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not open the file (' + response.status + ')')
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(false)
            setActiveSheet(0)
            setViewRows(Math.max(SHEET_VIEW_ROWS, Math.min(SHEET_MAX_ROWS, (payload.document.sheets[0] ? payload.document.sheets[0].rows.length : 0) + 5)))
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Opened ' + filePath })
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [applyDoc, filePath, session],
      )

      useEffect(() => {
        void open()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [filePath, session])

      /** Write the workbook to the store AND back to its file. */
      const save = useCallback(
        async (options = {}) => {
          const current = docRef.current
          if (!session || !current) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Saving\u2026' })
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              id: current.id,
              kind: 'sheet',
              title: current.title,
              sheets: current.sheets,
              by: 'user',
              note: options.note ?? 'edited',
              expectedRevision: options.force === true ? undefined : current.revision,
            })
            if (!response.status || response.status === 409) {
              const payload = await response.json().catch(() => null)
              if (payload && payload.error && payload.error.code === 'CONFLICT') {
                setConflict(true)
                setStatus({ kind: 'warn', text: 'This workbook changed elsewhere \u2014 save anyway?' })
                return false
              }
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'save failed (' + response.status + ')')
            }
            const payload = await response.json()
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(false)
            const written = await postJson(SAVE_FILE_ROUTE, {
              session,
              id: payload.document.id,
              expected: current.origin ? { mtimeMs: current.origin.mtimeMs, size: current.origin.size } : undefined,
              force: options.force === true,
            })
            const writtenBody = await written.json().catch(() => null)
            if (written.status === 409) {
              setConflict(true)
              setStatus({ kind: 'warn', text: 'The file changed on disk \u2014 reload it, or save anyway to keep this version.' })
              return false
            }
            if (!written.ok) throw new Error((writtenBody && writtenBody.error && writtenBody.error.message) || 'could not write the file (' + written.status + ')')
            setStatus({ kind: 'info', text: 'Wrote ' + writtenBody.name + ' (' + writtenBody.bytes + ' bytes)' })
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Save failed: ' + messageOf(err) })
            return false
          }
        },
        [applyDoc, session],
      )

      useEffect(() => {
        if (!dirty || !doc) return undefined
        const timer = setTimeout(() => {
          void save({ silent: true })
        }, AUTOSAVE_MS)
        return () => clearTimeout(timer)
      }, [dirty, doc, save])

      /** One cell's text changed. */
      const setCell = useCallback(
        (row, column, text) => {
          const current = docRef.current
          if (!current) return
          const sheets = current.sheets.map((sheet, index) => {
            if (index !== activeSheet) return sheet
            const rows = sheet.rows.map((entry) => entry.slice())
            while (rows.length <= row) rows.push([])
            while (rows[row].length <= column) rows[row].push(null)
            rows[row][column] = parseCellInput(text)
            const width = rows.reduce((widest, entry) => Math.max(widest, entry.length), 0)
            for (const entry of rows) {
              while (entry.length < width) entry.push(null)
            }
            return { ...sheet, rows }
          })
          applyDoc({ ...current, sheets })
          setDirty(true)
          dirtyRef.current = true
        },
        [activeSheet, applyDoc],
      )

      /** Add one sheet, up to the cap the store enforces. */
      const addSheet = useCallback(() => {
        const current = docRef.current
        if (!current) return
        if (current.sheets.length >= SHEET_MAX_SHEETS) {
          setStatus({ kind: 'warn', text: 'A workbook holds at most ' + SHEET_MAX_SHEETS + ' sheets.' })
          return
        }
        const sheets = current.sheets.concat([{ name: 'Sheet' + (current.sheets.length + 1), rows: [[null]] }])
        applyDoc({ ...current, sheets })
        setActiveSheet(sheets.length - 1)
        setDirty(true)
        dirtyRef.current = true
      }, [applyDoc])

      /** Remove the active sheet (a workbook keeps at least one). */
      const removeSheet = useCallback(() => {
        const current = docRef.current
        if (!current || current.sheets.length <= 1) return
        const sheets = current.sheets.filter((sheet, index) => index !== activeSheet)
        applyDoc({ ...current, sheets })
        setActiveSheet(Math.max(0, activeSheet - 1))
        setDirty(true)
        dirtyRef.current = true
      }, [activeSheet, applyDoc])

      /** Rename the active sheet. */
      const renameSheet = useCallback(
        (name) => {
          const current = docRef.current
          if (!current) return
          const sheets = current.sheets.map((sheet, index) => (index === activeSheet ? { ...sheet, name } : sheet))
          applyDoc({ ...current, sheets })
          setDirty(true)
          dirtyRef.current = true
        },
        [activeSheet, applyDoc],
      )

      /** Export a COPY (the file itself is written by Save). */
      const exportCopy = useCallback(
        async (format) => {
          const current = docRef.current
          if (!session || !current) return
          try {
            const response = await postJson(EXPORT_ROUTE, { session, id: current.id, format, target: 'workspace' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'export failed (' + response.status + ')')
            setStatus({ kind: 'info', text: 'Exported ' + payload.name })
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [session],
      )

      /** The kind the shipped preview registered: where Proof renders this file. */
      const previewKind = useCallback(() => {
        const ctx = ctxRef.current
        try {
          const registry = ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
          const entries = registry && typeof registry.entries === 'function' ? registry.entries() : null
          for (const definition of Array.isArray(entries) ? entries : []) {
            if (definition && definition.id === PREVIEW_TYPE_ID && typeof definition.kind === 'string') return definition.kind
          }
        } catch (err) {
          /* fall through */
        }
        return PREVIEW_FALLBACK_KIND
      }, [])

      /** Write the file, then let core's own preview render it with LibreOffice. */
      const proof = useCallback(async () => {
        const current = docRef.current
        const origin = current && current.origin ? current.origin : null
        if (!origin || typeof origin.path !== 'string') return
        const ok = await save({ note: 'wrote before Proof' })
        if (!ok) return
        const ctx = ctxRef.current
        const controller = ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
        if (!controller || typeof controller.openResource !== 'function') {
          setStatus({ kind: 'warn', text: 'Wrote ' + origin.path + ' (the right bar is not mounted)' })
          return
        }
        try {
          controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + origin.path, { kind: previewKind() })
          setStatus({ kind: 'info', text: 'Wrote ' + origin.path + ' \u2014 LibreOffice is rendering it' })
        } catch (err) {
          setStatus({ kind: 'warn', text: 'Wrote ' + origin.path })
        }
      }, [previewKind, save, session])

      /** The grid's keyboard: Enter walks down, Tab walks right, Escape blurs. */
      const onCellKeyDown = useCallback(
        (row, column, event) => {
          const key = String(event.key ?? '')
          const accel = event.ctrlKey === true || event.metaKey === true
          if (accel && (key === 's' || key === 'S')) {
            event.preventDefault()
            void save({ note: 'saved' })
            return
          }
          if (key === 'Enter' || key === 'ArrowDown') {
            event.preventDefault()
            focusCell(row + 1, column)
            return
          }
          if (key === 'ArrowUp') {
            event.preventDefault()
            focusCell(row - 1, column)
            return
          }
          if (key === 'Tab') {
            event.preventDefault()
            focusCell(row, column + (event.shiftKey === true ? -1 : 1))
            return
          }
          if (key === 'ArrowRight' || key === 'ArrowLeft') {
            // Only at the END of the text: inside a cell the arrows are the
            // caret's, which is what every spreadsheet does.
            const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
            const atEdge = selection && selection.isCollapsed
            if (atEdge) {
              event.preventDefault()
              focusCell(row, column + (key === 'ArrowRight' ? 1 : -1))
            }
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [save],
      )

      /** Put the caret in one cell, growing the grid if the walk reached past it. */
      const focusCell = useCallback((row, column) => {
        const nextRow = Math.max(0, Math.min(SHEET_MAX_ROWS - 1, row))
        const nextColumn = Math.max(0, Math.min(SHEET_MAX_COLUMNS - 1, column))
        if (nextRow >= viewRows) setViewRows(Math.min(SHEET_MAX_ROWS, nextRow + 5))
        setActiveCell({ row: nextRow, column: nextColumn })
        const element = cellRefs.current[cellAddress(nextRow, nextColumn)]
        if (element && typeof element.focus === 'function') element.focus()
      }, [viewRows])

      const sheet = doc && doc.sheets[activeSheet] ? doc.sheets[activeSheet] : { name: 'Sheet1', rows: [[]] }
      const grid = useMemo(() => sheetGrid(sheet), [sheet])
      const columnCount = Math.min(SHEET_MAX_COLUMNS, Math.max(SHEET_VIEW_COLUMNS, grid.reduce((widest, row) => Math.max(widest, row.length), 0)))
      const rowCount = Math.min(SHEET_MAX_ROWS, Math.max(viewRows, grid.length))
      const filled = grid.reduce((total, row) => total + row.filter((cell) => cell !== null).length, 0)

      const bar = h(
        'div',
        { className: 'dsw-paneBar' },
        h('span', { className: 'dsw-paneTitle', 'data-sheet-title': true }, doc ? doc.title : 'Workbook'),
        h(ToolButton, { title: 'Save (Ctrl+S)', action: 'sheet-save', emphasis: 'primary', disabled: !doc, onClick: () => save({ note: 'saved' }) }, 'Save'),
        h(ToolButton, { title: 'Write the file and render it with LibreOffice', action: 'sheet-proof', disabled: !doc, onClick: proof }, 'Proof'),
        h(
          'details',
          { className: 'dsw-menu', 'data-sheet-export': true },
          h('summary', null, 'Export'),
          h(
            'div',
            { className: 'dsw-menuPanel', 'data-side': 'right' },
            h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'xlsx', disabled: !doc, onClick: () => exportCopy('xlsx') }, 'Workbook (.xlsx) \u2014 a copy beside the original'),
            h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'txt', disabled: !doc, onClick: () => exportCopy('txt') }, 'Tab-separated text (.txt)'),
          ),
        ),
      )

      const tabs = h(
        'div',
        { className: 'dsw-sheetTabs', 'data-sheet-tabs': true },
        (doc ? doc.sheets : []).map((entry, index) =>
          h(
            'button',
            {
              type: 'button',
              key: 'sheet-tab-' + index,
              className: 'dsw-sheetTab',
              'data-sheet-tab': index,
              'data-active': index === activeSheet ? 'true' : 'false',
              onClick: () => {
                setActiveSheet(index)
                setActiveCell({ row: 0, column: 0 })
              },
            },
            entry.name,
          ),
        ),
        h(ToolButton, { title: 'Add a sheet', action: 'sheet-add', disabled: !doc, onClick: addSheet }, '+'),
        h(ToolButton, { title: 'Remove this sheet', action: 'sheet-remove', disabled: !doc || (doc && doc.sheets.length <= 1), onClick: removeSheet }, '\u2212'),
        h('input', {
          className: 'dsw-input dsw-sheetName',
          'data-sheet-name': true,
          value: sheet.name,
          disabled: !doc,
          title: 'Rename this sheet',
          onChange: (event) => renameSheet(event.target.value),
        }),
        h('span', { className: 'dsw-spacer' }),
        h('span', { 'data-sheet-cell': true }, cellAddress(activeCell.row, activeCell.column)),
      )

      const gridElement = h(
        'div',
        { className: 'dsw-gridWrap', 'data-sheet-grid': true },
        h(
          'table',
          { className: 'dsw-grid' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { className: 'dsw-gridCorner' }, ''),
              Array.from({ length: columnCount }, (_, column) =>
                h(
                  'th',
                  { key: 'col-' + column, className: 'dsw-gridHead', 'data-column': column, 'data-active': column === activeCell.column ? 'true' : 'false' },
                  columnName(column),
                ),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            Array.from({ length: rowCount }, (_, row) =>
              h(
                'tr',
                { key: 'row-' + row },
                h('th', { className: 'dsw-gridHead', 'data-row': row, 'data-active': row === activeCell.row ? 'true' : 'false' }, String(row + 1)),
                Array.from({ length: columnCount }, (_, column) => {
                  const cell = grid[row] ? grid[row][column] ?? null : null
                  const address = cellAddress(row, column)
                  return h(
                    'td',
                    {
                      key: address,
                      className: 'dsw-cell',
                      'data-cell': address,
                      'data-active': row === activeCell.row && column === activeCell.column ? 'true' : 'false',
                    },
                    h('div', {
                      className: 'dsw-cellInput',
                      contentEditable: true,
                      suppressContentEditableWarning: true,
                      spellCheck: false,
                      ref: (element) => {
                        cellRefs.current[address] = element
                      },
                      onInput: (event) => setCell(row, column, event.currentTarget.textContent ?? ''),
                      onKeyDown: (event) => onCellKeyDown(row, column, event),
                      onFocus: () => setActiveCell({ row, column }),
                      dangerouslySetInnerHTML: { __html: escapeHtml(cellDisplay(cell)) || '<br>' },
                    }),
                  )
                }),
              ),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'dsw-pane', 'data-dsh-sheet-view': true, 'data-sheet-phase': phase },
        bar,
        conflict
          ? h(
              'div',
              { className: 'dsw-loss' },
              h('span', { className: 'dsw-lossText' }, 'The file changed on disk since it was opened.'),
              h(ToolButton, { title: 'Read it again', action: 'sheet-reload', onClick: () => open({ reload: true }) }, 'Reload'),
              h(ToolButton, { title: 'Write this version over it', action: 'sheet-keep', onClick: () => save({ force: true }) }, 'Keep mine'),
            )
          : null,
        phase === 'ready' && doc
          ? gridElement
          : h('div', { className: 'dsw-empty' }, phase === 'loading' ? 'Opening\u2026' : phase === 'error' ? 'The workbook could not be read.' : 'No file to open.'),
        tabs,
        h(
          'div',
          { className: 'dsw-status', 'data-sheet-status': status.kind },
          h('span', null, filled + ' filled cell(s)'),
          h('span', null, '\u00b7'),
          h('span', null, (doc ? doc.sheets.length : 0) + ' sheet(s)'),
          h('span', null, '\u00b7'),
          h('span', null, columnCount + '\u00d7' + rowCount + ' shown'),
          h(ToolButton, { title: 'Show more rows', action: 'sheet-more-rows', disabled: !doc, onClick: () => setViewRows((value) => Math.min(SHEET_MAX_ROWS, value + 20)) }, '+20 rows'),
          h('span', { className: 'dsw-spacer' }),
          dirty ? h('span', null, 'unsaved') : null,
          doc && doc.origin && doc.origin.path ? h('span', { 'data-sheet-file': true }, '\u25cf ' + doc.origin.path) : null,
          status.text ? h('span', { 'data-sheet-message': true }, status.text) : null,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------
    /** Services the activation waits for: the slot registry the view ring lives in. */
    const inject = ['slots']

    /** The right bar's tab registry, when it is mounted. */
    function tabsNow(ctx) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
      } catch (err) {
        return undefined
      }
    }

    /** The `.docx` this package claims in the right bar (and nothing else). */
    function canOpenDocumentAddress(address) {
      const path = filePathOf(address)
      if (path === null) return false
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
      return extension === 'docx'
    }

    /** The `.xlsx` this package claims for the GRID pane. */
    function canOpenSheetAddress(address) {
      const path = filePathOf(address)
      if (path === null) return false
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
      return extension === 'xlsx'
    }

    /** The workspace-relative path of a session file address, or null. */
    function filePathOf(address) {
      const text = String(address ?? '')
      const prefix = 'dsh-resource://file/'
      if (!text.startsWith(prefix)) return null
      const rest = text.slice(prefix.length)
      if (!rest.startsWith('session/')) return null
      const parts = rest.slice('session/'.length).split('/')
      const session = parts.shift()
      if (!session || parts.length === 0) return null
      return parts.join('/')
    }

    function apply(ctx) {
      try {
        installStyles(CSS_TAG, CSS)
        // The tab: the conversation view ring's fourth entry, to the right of
        // Canvas (20) - Chat 0, Trajectory 10, Canvas 20, Writing 30. A view
        // receives no `sessionId` prop: the `inject` face is how it learns one.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: VIEW_ID,
                  order: 30,
                  label: () => 'Writing',
                  inject: (sessionId) => ({ writingSession: sessionId, ctx }),
                },
                WritingView,
              ),
            ),
          'dsh-writing: writing view',
        )

        // THE RIGHT BAR. Two pane types, registered the way every other tab type
        // in this pack is: a `.docx` opens EDITABLE here (the shipped office
        // preview keeps every other file), and a Headings pane navigates the
        // document the Writing tab has open.
        ctx.effect(() => {
          const registry = tabsNow(ctx)
          if (!registry || typeof registry.register !== 'function') {
            ctx.logger?.debug?.('[dsh-writing] the right bar is not mounted; the pane types are not registered')
            return () => {}
          }
          const offDocument = registry.register({
            id: DOC_TYPE_ID,
            kind: DOC_KIND,
            patterns: ['dsh-resource://file/**'],
            // The `extension` band, like `dsh-editor`, with a `canOpen` that keeps
            // every file this tab cannot actually read: the editor's own veto
            // hands a `.docx` back, and this one takes it.
            priority: 'extension',
            canOpen: canOpenDocumentAddress,
            title: (address) => {
              const path = filePathOf(address)
              return path === null ? 'Writing' : path.slice(path.lastIndexOf('/') + 1)
            },
            guide: [
              {
                order: 30,
                title: () => 'Writing',
                description: () => 'A page you write on, saved as a .docx',
                icon: () => null,
              },
            ],
          })
          const offOutline = registry.register({
            id: OUTLINE_TYPE_ID,
            kind: OUTLINE_KIND,
            patterns: [],
            priority: 'extension',
            canOpen: () => false,
            title: () => 'Headings',
            guide: [
              {
                order: 31,
                title: () => 'Headings',
                description: () => 'The headings of the document the Writing tab has open',
                icon: () => null,
              },
            ],
          })
          const offSheet = registry.register({
            id: SHEET_TYPE_ID,
            kind: SHEET_KIND,
            patterns: ['dsh-resource://file/**'],
            priority: 'extension',
            canOpen: canOpenSheetAddress,
            title: (address) => {
              const path = filePathOf(address)
              return path === null ? 'Sheet' : path.slice(path.lastIndexOf('/') + 1)
            },
            guide: [
              {
                order: 32,
                title: () => 'Sheet',
                description: () => 'A workbook you edit as a grid, saved as a .xlsx',
                icon: () => null,
              },
            ],
          })
          return () => {
            try {
              offDocument()
            } catch (err) {
              /* the bar is going away either way */
            }
            try {
              offOutline()
            } catch (err) {
              /* the bar is going away either way */
            }
            try {
              offSheet()
            } catch (err) {
              /* the bar is going away either way */
            }
          }
        }, 'dsh-writing: right-bar pane types')

        // The pane BODIES, in the keyed seats their definitions name. A pane
        // receives the FILE its address carried (`{ sessionId, path }`), which is
        // what the editor needs to open it.
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: DOC_TYPE_ID,
                  inject: () => ({ ctx }),
                },
                WritingView,
              ),
            ),
          'dsh-writing: document pane body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: OUTLINE_TYPE_ID, inject: () => ({ ctx }) }, OutlinePane),
            ),
          'dsh-writing: outline pane body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SHEET_TYPE_ID, inject: () => ({ ctx }) }, SheetView),
            ),
          'dsh-writing: sheet pane body',
        )
        ctx.logger?.debug?.('[dsh-writing] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-writing] activation failed', err)
        ctx.logger?.warn?.('[dsh-writing] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-writing'
    exports.inject = inject
    exports.apply = apply
    // The pure-ish half a check can reach: the run model, the mark algebra and
    // the block rules whose behaviour is otherwise only visible in a browser.
    exports.__internals = {
      VIEW_ID,
      PLUGIN_VERSION,
      DOC_TYPE_ID,
      DOC_KIND,
      OUTLINE_TYPE_ID,
      OUTLINE_KIND,
      SHEET_TYPE_ID,
      SHEET_KIND,
      SHEET_MAX_ROWS,
      SHEET_MAX_COLUMNS,
      SHEET_MAX_SHEETS,
      PAGE_ADDRESS,
      OUTLINE_ADDRESS,
      PAGE_EXTENSIONS,
      ROUTES: { STATE_ROUTE, DOCUMENT_ROUTE, DELETE_ROUTE, PUBLISH_ROUTE, IMPORT_ROUTE, EXPORT_ROUTE, CREATE_FILE_ROUTE, SAVE_FILE_ROUTE, OPEN_FILE_ROUTE, OUTLINE_ROUTE, FONTS_ROUTE, PAGE_ROUTE },
      MARK_BUTTONS,
      BLOCK_CHOICES,
      PAGE_BREAK_BLOCK,
      fallbackPaginate,
      escapeHtml,
      pushRun,
      sameRun,
      runsFromNodes,
      runsFromPlainText,
      runsLength,
      sliceRuns,
      replaceRange,
      runsHtml,
      marksAt,
      propertiesAt,
      applyMarkToRuns,
      applyAttributeToRuns,
      splitRunsAt,
      mergeRuns,
      runHtml,
      runStyle,
      parseFontSize,
      unquoteFamily,
      blockHtmlString,
      blockAttributes,
      flowStyle,
      describeBlock,
      retypeBlock,
      blockElement,
      pagesElement,
      closeMenus,
      filePathOf,
      canOpenDocumentAddress,
      canOpenSheetAddress,
      columnName,
      cellAddress,
      parseCellInput,
      cellDisplay,
      sheetGrid,
      OutlinePane,
      SheetView,
      wordCountOf: wordCountOf,
    }
    return module.exports
  },
})
