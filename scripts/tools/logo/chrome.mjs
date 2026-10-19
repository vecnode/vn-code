// One HTML page -> one PNG, at the exact size asked for, corners transparent.
//
// Chrome IS the rasteriser: this pack ships zero npm dependencies, and a PNG
// encoder or an SVG library is not worth an exception for four brand assets.
// Shared by the mark's renderer and the README banner so both find the browser
// the same way and both fail with the same sentence.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

/**
 * The browser to rasterise with. An explicit path is an INSTRUCTION, not a
 * hint: if it does not answer, say so rather than quietly using another one.
 */
export function findBrowser(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--chrome ${explicit} does not exist`)
    const probe = spawnSync(explicit, ['--version'], { encoding: 'utf8', timeout: 30000 })
    if (probe.status !== 0) throw new Error(`--chrome ${explicit} does not answer --version`)
    return explicit
  }
  for (const candidate of CANDIDATES.filter(Boolean)) {
    if (!fs.existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 30000 })
    if (probe.status === 0) return candidate
  }
  throw new Error(
    'no Chrome or Chromium found - pass --chrome <path>, set CHROME, or install one of: ' +
      CANDIDATES.filter(Boolean).join(', '),
  )
}

/**
 * Render one page to `out`.
 * @param {object} options
 * @param {string} options.browser - the binary from {@link findBrowser}.
 * @param {string} options.html - the whole page.
 * @param {number} options.width - viewport, and the PNG's width.
 * @param {number} options.height - viewport, and the PNG's height.
 * @param {string} options.out - written create-exclusively? No: replaced.
 */
export function shoot({ browser, html, width, height, out }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vncode-logo-'))
  const page = path.join(dir, 'page.html')
  fs.writeFileSync(page, html)
  const absolute = path.resolve(out)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.rmSync(absolute, { force: true })
  const run = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + path.join(dir, 'profile'),
      `--window-size=${width},${height}`,
      '--default-background-color=00000000',
      '--virtual-time-budget=3000',
      '--screenshot=' + absolute,
      pathToFileURL(page).href,
    ],
    { encoding: 'utf8', timeout: 120000 },
  )
  fs.rmSync(dir, { recursive: true, force: true })
  if (run.status !== 0 || !fs.existsSync(absolute)) {
    throw new Error(`chrome failed (${run.status}) rendering ${path.basename(out)}: ${run.stderr ?? ''}`)
  }
  return absolute
}
