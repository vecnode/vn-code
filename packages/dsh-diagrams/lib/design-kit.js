/**
 * dsh-diagrams — the Diagram Design kit.
 *
 * The kit is DATA this package vendors (see `vendor/design/NOTICE.md`): 204
 * worked examples as self-contained HTML+inline SVG, 62 reference documents, the
 * upstream selector table, and the templates a new diagram starts from. This
 * module is the only thing that reads it, and it does three jobs:
 *
 *   1. **The catalog** — one entry per example KEY (204 files fold into 71 keys,
 *      because `example-bar-dark.html` is the dark take on `bar`), with the
 *      variants it has, the page's own words for it, and whether the upstream
 *      documents that type (44 of the 71 are authorable, the rest are named
 *      variations of a documented family).
 *   2. **The composition** — {@link composeHtmlDocument}, which takes a vendored
 *      example OR a stored diagram's source and returns the bytes the panel's
 *      sandboxed frame is served. Three adaptations happen HERE, at request
 *      time, and never in a vendored file:
 *        - the Google Fonts `<link>` is removed (this plugin starts no network
 *          request: the pack's own rule), and the readers' fonts are used;
 *        - a theme block is added, so a light document can be viewed dark;
 *        - a viewer bootstrap is added, which is the ONLY script the frame runs
 *          besides the kit's own motion controller.
 *      The route that serves it also sets a CSP that forbids every fetch, so
 *      even a document this module mis-handles cannot reach the network.
 *   3. **The reads** — a reference document or an example's source, both capped
 *      and both honest about what was dropped.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The vendored tree, resolved from this module. */
export const KIT_ROOT = fileURLToPath(new URL('./vendor/design/', import.meta.url))
/** The catalog the build generated. */
const CATALOG_FILE = path.join(KIT_ROOT, 'catalog.json')
/** The manifest the build generated: file hashes and the motion controller's. */
const MANIFEST_FILE = path.join(KIT_ROOT, 'VERSION.json')
/** How much of a reference or an example one read may return. */
export const MAX_READ_CHARS = 40_000
/** The dark tokens, read from the kit's own `-dark` examples rather than invented. */
const DARK_TOKENS = {
  '--color-paper': '#2d3142',
  '--color-ink': '#f5f5f5',
  '--color-muted': '#bfc0c0',
  '--color-accent': '#f08a59',
}
/**
 * The one script the frame runs on top of the document: the viewer's channel.
 *
 * It does exactly two things - apply the theme the panel asks for, and tell the
 * panel what is inside the frame - and it is deliberately tiny, because a
 * vendored example's own motion controller is the only other script allowed.
 * The frame is served with `sandbox="allow-scripts"`, so it has an opaque origin
 * and `postMessage` is its only way to speak.
 */
const VIEWER_BOOTSTRAP = `<script data-dsh-diagram-viewer>
(function(){
  var root = document.documentElement;
  function theme(name){ root.setAttribute('data-dsh-theme', name); }
  function measure(){
    var svg = document.querySelector('svg');
    var box = svg ? svg.getBoundingClientRect() : root.getBoundingClientRect();
    parent.postMessage({ source: 'dsh-diagrams', type: 'measured', width: Math.round(box.width), height: Math.round(box.height),
      scrollHeight: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0) }, '*');
  }
  window.addEventListener('message', function(event){
    var data = event.data;
    if (!data || data.source !== 'dsh-diagrams') return;
    if (data.type === 'theme') { theme(data.theme === 'dark' ? 'dark' : 'light'); measure(); }
    if (data.type === 'measure') measure();
  });
  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    if (media.addEventListener) media.addEventListener('change', measure);
  }
  window.addEventListener('load', measure);
  measure();
})();
</script>`

/**
 * The last block of the served document: the kit's own tokens, then the theme
 * overlay, then the reader's fonts.
 *
 * The ORDER is load-bearing. `:root` first carries the dark replacement for the
 * document's four roles, which only applies when the panel asked for dark;
 * `--dsh-font-*` then lets the exact webfonts be opted into without touching a
 * single token the document declares for itself.
 */
function overlayStyle({ theme, fonts, scale }) {
  const dark = theme === 'dark' ? Object.entries(DARK_TOKENS).map(([name, value]) => name + ':' + value + ';').join('') : ''
  const fontStack =
    fonts === 'system'
      ? '--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
        '--font-serif:Georgia,"Times New Roman",Times,serif;' +
        '--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;'
      : '--font-sans:"Geist",ui-sans-serif,system-ui,sans-serif;' +
        '--font-serif:"Instrument Serif",Georgia,serif;' +
        '--font-mono:"Geist Mono",ui-monospace,monospace;'
  return (
    '<style data-dsh-diagram-overlay>\n' +
    (dark ? ':root[data-dsh-theme="dark"]{' + dark + '}\n' : '') +
    // A document that declares no tokens of its own still has to be readable in
    // both themes, so the overlay carries the roles as a fallback for the frame.
    ':root{--dsh-paper:' + (theme === 'dark' ? DARK_TOKENS['--color-paper'] : '#f5f5f5') + ';' + fontStack + '}\n' +
    ':root[data-dsh-theme="light"]{--dsh-paper:#f5f5f5;}\n' +
    'html,body{background:var(--color-paper,var(--dsh-paper));}\n' +
    (scale && scale !== 1 ? 'html{zoom:' + scale + ';}\n' : '') +
    '@media (prefers-reduced-motion: reduce){*{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important;}}\n' +
    '</style>'
  )
}

/** True when an `href` is the one remote stylesheet a kit document may name. */
function isFontsHref(value) {
  try {
    const url = new URL(String(value ?? '').replace(/&amp;/g, '&'))
    return url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com' && (url.pathname === '/css' || url.pathname === '/css2')
  } catch (err) {
    return false
  }
}

/**
 * Remove every remote stylesheet `<link>` from a document.
 *
 * A hand-written scan rather than a regex over the whole tag: a `<link>` may
 * carry its attributes over several lines (`<link\n href="..."\n rel="..."\n/>`),
 * which three of the kit's own examples do, and a naive `/<link[^>]*>/` would
 * leave those behind to be fetched.
 *
 * @param html - the document.
 * @returns `{ html, stripped }` where `stripped` counts what was removed.
 */
export function stripFontLinks(html) {
  const text = String(html ?? '')
  let out = ''
  let index = 0
  let stripped = 0
  while (index < text.length) {
    const start = text.indexOf('<link', index)
    if (start === -1) {
      out += text.slice(index)
      break
    }
    const end = text.indexOf('>', start)
    if (end === -1) {
      out += text.slice(index)
      break
    }
    const tag = text.slice(start, end + 1)
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    const value = href ? href[2] ?? href[3] ?? '' : ''
    if (isFontsHref(value)) {
      stripped += 1
      out += text.slice(index, start)
    } else {
      out += text.slice(index, end + 1)
    }
    index = end + 1
  }
  return { html: out, stripped }
}

/**
 * Compose the document the sandboxed frame is served.
 *
 * @param source - a kit example's bytes, or a stored `html` diagram's source.
 * @param options - `{ theme, fonts, scale, viewer }`.
 *   `theme` is `light` | `dark`; `fonts` is `system` | `kit`; `scale` is a
 *   number (the frame's Fit control); `viewer` adds the theme/measure channel
 *   (never for a plain export).
 * @returns `{ html, strippedFonts, bytes }`.
 */
export function composeHtmlDocument(source, { theme = 'light', fonts = 'system', scale = 1, viewer = true, base = null } = {}) {
  const original = String(source ?? '')
  const stripped = stripFontLinks(original)
  let html = stripped.html
  // A `<base href>` would change what a relative reference means; the validator
  // refuses one outright, and this strips a stray one from a vendored file.
  html = html.replace(/<base\b[^>]*>/gi, '')

  const head = overlayStyle({ theme, fonts, scale }) + (viewer ? VIEWER_BOOTSTRAP : '')
  // Injected as the LAST thing in <head> (or at the top of the document when it
  // has no head), so every rule of the document's own stylesheet still comes
  // first and the overlay only overrides what it means to.
  const closeHead = html.toLowerCase().lastIndexOf('</head>')
  if (closeHead !== -1) {
    html = html.slice(0, closeHead) + head + html.slice(closeHead)
  } else {
    const openHtml = /<html[^>]*>/i.exec(html)
    html = openHtml ? html.slice(0, openHtml.index + openHtml[0].length) + head + html.slice(openHtml.index + openHtml[0].length) : head + html
  }
  return { html, strippedFonts: stripped.stripped, bytes: Buffer.byteLength(html, 'utf8'), base }
}

/**
 * The Content-Security-Policy every framed diagram is served under.
 *
 * This is the backstop the validator is not: `default-src 'none'` means the
 * document cannot fetch, frame, connect to or embed ANYTHING, whatever the
 * check missed. `unsafe-inline` is required for the style and for the kit's own
 * motion controller - a document this plugin stores can contain nothing else,
 * and it is served into a frame with an opaque origin.
 *
 * @param options - `{ fonts }`: when the exact webfonts were vendored, their
 *   route is the one addition, and it is same-origin.
 * @returns the header value.
 */
export function contentSecurityPolicy({ fontsRoute = null } = {}) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:' + (fontsRoute ? ' ' + fontsRoute : ''),
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** One loaded catalog, read once per process. */
let catalogCache = null
/** One loaded manifest, read once per process. */
let manifestCache = null

/** The catalog, or null when the kit was not vendored. */
export function catalog() {
  if (catalogCache) return catalogCache
  if (!existsSync(CATALOG_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
    catalogCache = parsed && Array.isArray(parsed.types) ? parsed : null
  } catch (err) {
    catalogCache = null
  }
  return catalogCache
}

/** The manifest: `{ upstream, counts, motion, files }`, or null. */
export function manifest() {
  if (manifestCache) return manifestCache
  if (!existsSync(MANIFEST_FILE)) return null
  try {
    manifestCache = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  } catch (err) {
    manifestCache = null
  }
  return manifestCache
}

/** The canonical motion controller's body hash, or null when unknown. */
export function motionHash() {
  const found = manifest()
  return found && found.motion && typeof found.motion.sha256 === 'string' ? found.motion.sha256 : null
}

/** The sha256 of a string, as `html-check` wants it. */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** One catalog entry by id (case-insensitive), or undefined. */
export function typeById(id) {
  const found = catalog()
  if (!found) return undefined
  const wanted = String(id ?? '').trim().toLowerCase()
  return found.types.find((entry) => entry.id === wanted)
}

/**
 * The catalog, filtered and shaped for one caller.
 *
 * @param options - `{ type, documentedOnly }`.
 * @returns the entries, each with its variants and its reference list.
 */
export function listTypes({ type = null, documentedOnly = false } = {}) {
  const found = catalog()
  if (!found) return []
  let entries = found.types
  if (type) {
    const one = typeById(type)
    entries = one ? [one] : []
  }
  if (documentedOnly) entries = entries.filter((entry) => entry.documented)
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    subject: entry.subject,
    variants: entry.variants,
    defaultVariant: entry.defaultVariant,
    documented: entry.documented,
    references: entry.references,
    bytes: entry.bytes,
  }))
}

/**
 * The absolute path of one example's file, or null when there is no such
 * example. The caller has already validated `id` and `variant` against the
 * catalog, so this cannot escape the vendored tree: both are looked up, never
 * joined from raw input.
 */
export function exampleFile(id, variant = null) {
  const entry = typeById(id)
  if (!entry) return null
  const wanted = variant && entry.examples[variant] ? variant : entry.defaultVariant
  const file = entry.examples[wanted]
  if (!file) return null
  const full = path.join(KIT_ROOT, file.file)
  if (!full.startsWith(KIT_ROOT)) return null
  return { path: full, variant: wanted, bytes: file.bytes, type: entry }
}

/**
 * The absolute path of one reference document, or null.
 *
 * `ref` is a name (`style-guide`, `semantic-patterns`, `animation`, …) or a type
 * id (`architecture` → `references/type-architecture.md`). Both are looked up in
 * a fixed list read from the tree, so a traversal cannot be spelled.
 */
export function referenceFile(ref) {
  const wanted = String(ref ?? '').trim().toLowerCase().replace(/\.md$/, '')
  if (wanted.length === 0) return null
  const candidates = [`references/${wanted}.md`, `references/type-${wanted}.md`]
  for (const candidate of candidates) {
    const full = path.join(KIT_ROOT, candidate)
    if (!full.startsWith(KIT_ROOT)) continue
    if (existsSync(full)) return { path: full, rel: candidate }
  }
  return null
}

/** Every reference document the kit carries, as `{ name, rel, bytes, type? }`. */
export function listReferences() {
  const dir = path.join(KIT_ROOT, 'references')
  if (!existsSync(dir)) return []
  const listed = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    const full = path.join(dir, name)
    const type = /^type-(.+)\.md$/.exec(name)
    listed.push({
      name: name.replace(/\.md$/, ''),
      rel: 'references/' + name,
      bytes: statSync(full).size,
      ...(type ? { type: type[1] } : {}),
    })
  }
  const skill = path.join(KIT_ROOT, 'SKILL.md')
  if (existsSync(skill)) listed.unshift({ name: 'SKILL', rel: 'SKILL.md', bytes: statSync(skill).size })
  return listed
}

/**
 * The reference documents worth reading FIRST, in the order the kit's own
 * instructions name them. The catalog is 62 files; a model that reads all of
 * them has spent its context on prose, so `diagram_kit` names these and stops.
 */
export const STARTER_REFERENCES = ['style-guide', 'semantic-patterns', 'output-spec', 'layout-budget', 'animation']

/**
 * Read one file from the kit with a cap, saying what was dropped.
 *
 * A reference document is up to 105 KB; handing all of it to the model would
 * spend a context on one read. The cap is a CHARACTER count and the answer says
 * so out loud, because a silently truncated document is worse than a refused
 * one: the model would quote a rule it never saw the end of.
 *
 * @param file - an absolute path inside the kit.
 * @param options - `{ maxChars }`.
 * @returns `{ text, truncated, bytes, totalChars }`.
 */
export function readCapped(file, { maxChars = MAX_READ_CHARS } = {}) {
  const raw = readFileSync(file, 'utf8')
  const cap = Math.max(1000, Number(maxChars) || MAX_READ_CHARS)
  if (raw.length <= cap) return { text: raw, truncated: false, bytes: Buffer.byteLength(raw, 'utf8'), totalChars: raw.length }
  return {
    text: raw.slice(0, cap),
    truncated: true,
    bytes: Buffer.byteLength(raw, 'utf8'),
    totalChars: raw.length,
    notice:
      'This document is ' +
      raw.length +
      ' characters and only the first ' +
      cap +
      ' were returned. Ask again with a larger `maxChars`, or read a narrower reference (the per-type documents are short).',
  }
}

/**
 * A one-line summary of the kit, for `health` and for every `state` answer.
 *
 * `types` is the TRIMMED catalog - id, name, subject, variants, the documented
 * flag and the size - and it rides every state answer on purpose: the pane's kit
 * browser and an example tab's title both draw from it, so neither needs a
 * request of its own, and a machine with no vendored tree reports
 * `available: false` rather than 404ing a frame. The example file names and
 * their hashes stay in the vendored `catalog.json`, which only the host reads.
 */
export function kitSnapshot() {
  const found = catalog()
  const recorded = manifest()
  if (!found || !recorded) return { available: false }
  const types = listTypes()
  return {
    available: true,
    /** The trimmed catalog the pane draws from: one entry per example key. */
    types,
    typesCount: types.length,
    starters: STARTER_REFERENCES,
    documented: found.counts.documented,
    examples: found.counts.examples,
    files: Array.isArray(recorded.files) ? recorded.files.length : 0,
    upstream: { repo: found.upstream.repo, commit: found.upstream.commit, version: found.upstream.version, license: found.upstream.license },
    motion: recorded.motion ? recorded.motion.sha256 : null,
  }
}
