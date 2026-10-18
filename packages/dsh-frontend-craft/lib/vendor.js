/**
 * dsh-frontend-craft — the vendored detector, loaded once.
 *
 * The rules are Impeccable's own: 61 deterministic checks over text sources and
 * static HTML, compiled from `crates/core` + `crates/foundation` to one
 * WebAssembly module. This file is the ONLY place that module is touched, so the
 * rest of the plugin never names a wasm export and a broken artifact degrades to
 * a typed refusal instead of a row that fails to load.
 *
 * What the module cannot do, and this file therefore does in JavaScript:
 *
 *   - **read a linked stylesheet.** `detect_html_source_json` takes HTML source,
 *     while the CLI's static engine resolves `<link rel="stylesheet" href="...">`
 *     against the file system. Two of the 186 upstream fixtures are exactly that
 *     case. `inlineStylesheets` folds each LOCAL stylesheet into a `<style>` at
 *     its `<link>`'s position, which is what makes the two agree; a remote URL is
 *     left alone (and the reference to it simply does not contribute rules).
 *   - **apply project config.** The CLI merges `.frontend-craft/config.json`'s
 *     `detector.ignoreRules` / `ignoreFiles` / `ignoreValues`; the export takes
 *     only inline ignores (`inlineIgnores`) and the DESIGN.md inputs. The ignores
 *     are applied to the finding list here.
 *
 * Both are recorded in checks/check-frontend-craft.mjs against the upstream
 * fixtures, so a divergence is a failing check rather than a surprise.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The vendored tree, resolved from this file (never from cwd). */
export const VENDOR_ROOT = path.join(here, 'vendor', 'impeccable')

/** The registry: `[{ id, name, category, description }]`, 61 rows. */
export const RULES = JSON.parse(readFileSync(path.join(VENDOR_ROOT, 'rules.json'), 'utf8'))

/** The pin, the transform and every vendored byte's hash. */
export const VERSION = JSON.parse(readFileSync(path.join(VENDOR_ROOT, 'VERSION.json'), 'utf8'))

/** This package's own version, read from its manifest (one place to bump). */
export const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version

/** How many rules the detector ships, for a sentence a reader can trust. */
export const RULE_COUNT = RULES.length

/** The rule row for an id, or undefined (a finding names it). */
export function ruleOf(id) {
  return RULES.find((rule) => rule.id === id)
}

let loaded = null

/**
 * The wasm module, or a typed failure. Cached after the first call: a
 * `createRequire` of a 4.5 MB module is not something to repeat per scan.
 *
 * @returns `{ ok: true, wasm }` or `{ ok: false, message }`.
 */
export function detector() {
  if (loaded !== null) return loaded
  const file = path.join(VENDOR_ROOT, 'detect', 'detect.cjs')
  if (!existsSync(file)) {
    loaded = { ok: false, message: 'The vendored detector is missing (' + file + '). Run `node vendor/impeccable/build-engine.mjs`.' }
    return loaded
  }
  try {
    const require = createRequire(import.meta.url)
    const wasm = require(file)
    if (typeof wasm.detect_text_json !== 'function' || typeof wasm.detect_html_source_json !== 'function') {
      loaded = { ok: false, message: 'The vendored detector loaded but exports no detect functions.' }
      return loaded
    }
    loaded = { ok: true, wasm }
  } catch (err) {
    loaded = { ok: false, message: 'The vendored detector could not be loaded: ' + String(err && err.message ? err.message : err) }
  }
  return loaded
}

/** The options object both exports accept; `{}` is the CLI's own default. */
function optionsJson(options = {}) {
  const payload = {}
  if (options.inlineIgnores === false) payload.inlineIgnores = false
  if (options.designSystem) payload.designSystem = options.designSystem
  return JSON.stringify(payload)
}

/** One text source. `file` is the path a finding reports. */
export function detectText(text, file, options) {
  const handle = detector()
  if (handle.ok !== true) return { ok: false, message: handle.message, findings: [] }
  try {
    return { ok: true, findings: JSON.parse(handle.wasm.detect_text_json(String(text), String(file), optionsJson(options))) }
  } catch (err) {
    return { ok: false, message: 'the detector failed on ' + file + ': ' + String(err && err.message ? err.message : err), findings: [] }
  }
}

/** One static HTML document. `file` is the path a finding reports. */
export function detectHtml(html, file, options) {
  const handle = detector()
  if (handle.ok !== true) return { ok: false, message: handle.message, findings: [] }
  try {
    return { ok: true, findings: JSON.parse(handle.wasm.detect_html_source_json(String(html), String(file), optionsJson(options))) }
  } catch (err) {
    return { ok: false, message: 'the detector failed on ' + file + ': ' + String(err && err.message ? err.message : err), findings: [] }
  }
}

/** Every local stylesheet a document links, as `<style>` blocks in place. */
export const MAX_INLINE_CSS = 512 * 1024

/**
 * Fold `<link rel="stylesheet" href="...">` into `<style>` for local files.
 *
 * A missing file, a remote URL, an oversized sheet or a data: href is left
 * exactly as it was: the document still scans, and the part that could not be
 * read contributes no rules - the same outcome as the CLI's own "cannot access"
 * path, minus the failure.
 *
 * @param html - the document's text.
 * @param file - the document's absolute path (relative hrefs resolve beside it).
 * @returns the rewritten document.
 */
export function inlineStylesheets(html, file) {
  const base = path.dirname(file)
  const linkPattern = /<link\b[^>]*>/gi
  return String(html).replace(linkPattern, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : ''
    if (href === '' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return tag
    let target
    try {
      target = path.resolve(base, decodeURIComponent(href.split('?')[0].split('#')[0]))
    } catch (err) {
      return tag
    }
    try {
      if (!existsSync(target) || !statSync(target).isFile()) return tag
      const stats = statSync(target)
      if (stats.size > MAX_INLINE_CSS) return tag
      const css = readFileSync(target, 'utf8').replace(/<\/style/gi, '<\\/style')
      return '<style data-from="' + href.replace(/"/g, '&quot;') + '">\n' + css + '\n</style>'
    } catch (err) {
      return tag
    }
  })
}

/**
 * Apply a project's detector ignores to a finding list.
 *
 * The shapes are upstream's own config keys, so an existing `.impeccable/`
 * config keeps meaning what it meant:
 *   - `ignoreRules`: rule ids, exactly;
 *   - `ignoreFiles`: path globs (`*` and `**`), matched against the relative path;
 *   - `ignoreValues`: a substring of a finding's snippet, with an optional
 *     `overused-font`-style rule id suffix (`value|rule-id`).
 *
 * @returns `{ kept, dropped }`.
 */
export function applyIgnores(findings, ignores = {}) {
  const ruleIds = new Set(Array.isArray(ignores.ignoreRules) ? ignores.ignoreRules : [])
  const fileGlobs = (Array.isArray(ignores.ignoreFiles) ? ignores.ignoreFiles : []).map(globToRegExp)
  const values = (Array.isArray(ignores.ignoreValues) ? ignores.ignoreValues : []).map((entry) => {
    const [value, rule] = String(entry).split('|')
    return { value, rule: rule || null }
  })
  const kept = []
  let dropped = 0
  for (const finding of findings) {
    const file = String(finding.file ?? '').replace(/\\/g, '/')
    if (ruleIds.has(finding.antipattern)) {
      dropped += 1
      continue
    }
    if (fileGlobs.some((pattern) => pattern.test(file))) {
      dropped += 1
      continue
    }
    if (values.length > 0) {
      const snippet = String(finding.snippet ?? '')
      const hit = values.some((entry) => snippet.includes(entry.value) && (entry.rule === null || entry.rule === finding.antipattern))
      if (hit) {
        dropped += 1
        continue
      }
    }
    kept.push(finding)
  }
  return { kept, dropped }
}

/** One path glob to a RegExp: `**` spans separators, `*` does not. */
export function globToRegExp(glob) {
  let out = ''
  const text = String(glob).replace(/\\/g, '/')
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') {
        out += '.*'
        index += 1
        if (text[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + out + '$')
}
