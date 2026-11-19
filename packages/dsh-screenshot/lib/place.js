/**
 * dsh-screenshot — putting the picture where a README can use it.
 *
 * A capture lands in this plugin's own artifact folder, which is a scratch space
 * that gets pruned. This file is the second half of the job, and the reason the
 * plugin exists at all: a screenshot is only worth taking if it arrives in the
 * repository at the RIGHT WIDTH, under a stable name, with the `<img>` or
 * `<picture>` block and its alt text already written.
 *
 * Three rules, because each one is a thing that goes wrong in real repositories:
 *
 *   - **One deterministic name per (surface, viewport, theme)** -
 *     `hero-desktop.png`, `hero-phone-dark.png`. Re-capturing a page replaces the
 *     picture instead of adding `hero-2.png`, so a README never accumulates
 *     screenshots of a UI that no longer exists.
 *   - **The display width comes from the file's own size divided by the scale it
 *     was captured at.** A 2880px-wide retina capture published as `width="2880"`
 *     is a README that scrolls sideways; the same file at `width="1440"` is
 *     sharp on a retina screen and correct everywhere else.
 *   - **Alt text is required, not defaulted.** An image with no alt is invisible
 *     to a screen reader, and a README is documentation.
 *
 * Nothing here touches git. Placing a file is a write inside the repository the
 * conversation is working in; committing and pushing are the person's own acts,
 * with their own credentials, and this package deliberately holds no token.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** The widest a README screenshot is published at, in CSS pixels. */
export const MAX_DISPLAY_WIDTH = 1000
/** The narrowest: below this the picture is a thumbnail and the name is wrong. */
export const MIN_DISPLAY_WIDTH = 120
/** Where placed shots go unless a call names another folder. */
export const DEFAULT_IMAGE_DIR = 'docs/assets/screenshots'

/** Read a png's real size from its own IHDR, never from the request. */
export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * A file-name-safe slug from anything a page or a window is called.
 *
 * Diacritics are folded rather than dropped, so "Capturas de Ecrã" becomes
 * `capturas-de-ecra` instead of `capturas-de-ecr`, and the result is lower-case
 * ascii with single dashes - what every filesystem and every URL agrees on.
 */
export function slugify(value, fallback = 'screenshot') {
  const folded = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug === '' ? fallback : slug
}

/** The name a viewport earns: the two rungs people actually publish. */
export function viewportLabel(width) {
  const pixels = Number(width)
  if (!Number.isFinite(pixels) || pixels <= 0) return 'custom'
  if (pixels >= 1200) return 'desktop'
  if (pixels >= 700) return 'tablet'
  return 'phone'
}

/**
 * `<slug>-<label>[-dark].png` - one name per surface, viewport and theme.
 *
 * The label is the CAPTURE's viewport when the caller states one, and the width's
 * own rung when it does not. A light/dark pair must share a label or the two
 * halves of one `<picture>` would be named for two different screens, so a
 * placement whose group disagrees is refused rather than written.
 */
export function fileNameFor({ slug, width, theme, viewport }) {
  const label = typeof viewport === 'string' && viewport.trim() !== '' ? slugify(viewport.trim(), '') || viewportLabel(width) : viewportLabel(width)
  return slugify(slug) + '-' + label + (theme === 'dark' ? '-dark' : '') + '.png'
}

/** The width to publish at: the file's own pixels, divided by the scale. */
export function displayWidthFor({ width, dpr = 1, cap = MAX_DISPLAY_WIDTH }) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const css = Number(width) / scale
  if (!Number.isFinite(css) || css <= 0) return 0
  return Math.max(MIN_DISPLAY_WIDTH, Math.min(cap, Math.round(css)))
}

/** An HTML attribute value: the five characters that would end it early. */
export function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Whether `file` is inside `root`, after resolving both. Never a prefix guess. */
export function isInside(root, file) {
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch (err) {
    return false
  }
  // A destination that does not exist yet has no realpath: the deepest ancestor
  // that DOES exist is what decides, and that is also what catches a symlinked
  // folder pointing out of the tree.
  let current = path.resolve(file)
  let realFile = null
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      realFile = realpathSync(current)
      break
    } catch (err) {
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
  if (realFile === null) return false
  const relative = path.relative(realRoot, realFile)
  // `relative === ''` means the deepest existing ancestor IS the root, which is
  // exactly the case of a file about to be created under it.
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** One entry's markdown: a plain `<img>`, or a `<picture>` for a light/dark pair. */
function imgTag(entry) {
  const width = entry.displayWidth > 0 ? ' width="' + String(entry.displayWidth) + '"' : ''
  return '<img src="' + escapeAttribute(entry.relative) + '"' + width + ' alt="' + escapeAttribute(entry.alt) + '">'
}

/**
 * The README block for a set of placed shots.
 *
 * A light and a dark shot of the SAME NAME STEM (`hero-desktop` and
 * `hero-desktop-dark`) become a `<picture>`, because that is the only markup
 * GitHub renders with a dark-mode variant - and a screenshot of a dark UI on a
 * white README looks broken rather than deliberate. Grouping by the stem rather
 * than by the slug is what lets one call place a tour: `hero-desktop` and
 * `hero-phone` are two pictures, and `hero-desktop` plus `hero-desktop-dark` is
 * one.
 */
export function readmeBlock(entries) {
  const shots = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.relative === 'string') : []
  if (shots.length === 0) return ''
  const byStem = new Map()
  for (const entry of shots) {
    const stem = String(entry.relative)
      .replace(/^.*\//, '')
      .replace(/\.png$/i, '')
      .replace(/-dark$/, '')
    const group = byStem.get(stem) ?? []
    group.push(entry)
    byStem.set(stem, group)
  }
  const blocks = []
  for (const [, group] of byStem) {
    const dark = group.find((entry) => entry.theme === 'dark')
    const light = group.find((entry) => entry.theme !== 'dark')
    if (dark !== undefined && light !== undefined && group.length === 2) {
      blocks.push(
        ['<picture>', '  <source media="(prefers-color-scheme: dark)" srcset="' + escapeAttribute(dark.relative) + '">', '  ' + imgTag(light), '</picture>'].join('\n'),
      )
      continue
    }
    for (const entry of group) blocks.push(imgTag(entry))
  }
  return blocks.join('\n\n')
}

/** Merge new shots into a manifest by relative path. Never drops an old entry. */
export function mergeManifest(existing, entries, now = new Date().toISOString()) {
  const base = existing !== null && typeof existing === 'object' && Array.isArray(existing.shots) ? existing : { version: 1, shots: [] }
  const byRelative = new Map()
  for (const shot of base.shots) {
    if (shot && typeof shot.relative === 'string') byRelative.set(shot.relative, shot)
  }
  for (const entry of entries) {
    if (!entry || typeof entry.relative !== 'string') continue
    byRelative.set(entry.relative, { ...entry, placedAt: now })
  }
  const shots = [...byRelative.values()].sort((a, b) => String(a.relative).localeCompare(String(b.relative)))
  return { version: 1, generatedBy: 'dsh-screenshot', shots }
}

/** Read a manifest, or `null` when there is none (which is not an error). */
export function readManifest(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

/**
 * One picture, measured: its true size, its bytes, and the scale it claims.
 *
 * The scale is the caller's word (a `dpr: 2` capture, a 1.5x display), so it is
 * recorded alongside the file rather than baked into it - and `displayWidthFor`
 * is the only place that arithmetic happens.
 */
export function describeFile(file, { dpr = 1, theme, slug, alt, kind, source } = {}) {
  const buffer = readFileSync(file)
  const size = readPngSize(buffer)
  if (size === null) return { ok: false, code: 'NOT_A_PNG', message: 'Not a PNG: ' + file }
  const stats = statSync(file)
  return {
    ok: true,
    shot: {
      file,
      width: size.width,
      height: size.height,
      bytes: stats.size,
      dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
      theme: theme === 'dark' ? 'dark' : 'light',
      slug: slugify(slug ?? path.basename(file, path.extname(file))),
      alt: String(alt ?? ''),
      kind: kind ?? 'image',
      source: source ?? null,
      displayWidth: displayWidthFor({ width: size.width, dpr }),
    },
  }
}

/** Copy one picture into the repository, create-exclusively unless asked. */
export async function placeFile(source, destination, { overwrite = false } = {}) {
  const existed = existsSync(destination)
  if (existed && !overwrite) return { ok: true, written: false, existed: true, destination }
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const bytes = await fsp.readFile(source)
  await fsp.writeFile(destination, bytes)
  return { ok: true, written: true, existed, destination, bytes: bytes.length }
}
