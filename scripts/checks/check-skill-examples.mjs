// check-skill-examples.mjs - every fenced example a bundled skill ships must RUN.
//
// Why this exists: the skills are not prose, they are load-bearing - the agent is
// told to read them before writing a complex diagram or a poster, and a
// copy-pasteable example that does not parse, or a TeX fragment that does not
// compile, or a ```canvas document the validator refuses, sends it straight into
// a failure the skill was supposed to prevent. The checks beside this one drive
// the plugins' code; this one drives their DOCUMENTATION through exactly the same
// engines the plugins use, so a doc and its engine cannot drift apart.
//
// Every ```mermaid block is parsed by the vendored engine (the same child
// validator `diagram_write` shells out to) and must come back `ok: true`. Every
// ```tex / ```latex block is compiled by the host's TeX engine through the same
// normalize + compile path a TikZ diagram takes, and must come back with no
// diagnostics. Every ```canvas block under `packages/dsh-canvas/skills/` is run
// through the REAL validator with the real preset and font tables - so a skill
// can never teach a document the plugin would refuse - and every ```json block in
// those skills must at least be well-formed JSON (they are the fragments the
// recipes are made of).
//
// A block that is deliberately broken is marked by putting `no-check` in its info
// string (```mermaid no-check) or on the line above it; it is then reported as
// skipped rather than checked, so an example that exists to show a parse error
// stays honest without failing the run.
//
// TeX is optional: with no engine on PATH the TikZ blocks are skipped with a
// notice (the plugin degrades the same way).
//
// Run:  node scripts/checks/check-skill-examples.mjs
export {} // (ESM for the dynamic imports below)

const { promises: fsp, existsSync, readFileSync } = await import('node:fs')
const { spawnSync } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const skillsRoot = path.join(repo, 'packages/dsh-diagrams/skills')
const canvasSkillsRoot = path.join(repo, 'packages/dsh-canvas/skills')
const checker = path.join(repo, 'packages/dsh-diagrams/lib/mermaid-check.mjs')

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** Every markdown file a bundled skill ships, relative to the repo. */
async function skillDocs() {
  const found = []
  for (const skill of await fsp.readdir(skillsRoot, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.md')) found.push(full)
      }
    }
    await walk(path.join(skillsRoot, skill.name))
  }
  return found.sort()
}

/** Every markdown file under one skills root (the canvas skills). */
async function docsUnder(root) {
  const found = []
  if (!existsSync(root)) return found
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md')) found.push(full)
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * The fenced blocks of one markdown file.
 *
 * A block is skipped when `no-check` appears in its info string or on the line
 * above the opening fence - the convention for an example that exists to show a
 * failure.
 *
 * @param text - the file's contents.
 * @returns `{ lang, body, line, skip }[]`.
 */
function fences(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*```([A-Za-z0-9_+-]*)\s*(.*)$/.exec(lines[index])
    if (!match) {
      if (open) open.body.push(lines[index])
      continue
    }
    if (open === null) {
      open = {
        lang: match[1].toLowerCase(),
        info: match[2],
        line: index + 1,
        body: [],
        skip: /no-check/i.test(match[2]) || /no-check/i.test(lines[index - 1] ?? ''),
      }
    } else {
      blocks.push(open)
      open = null
    }
  }
  return blocks
}

/** One verdict from the child validator. */
function mermaidVerdict(source) {
  const child = spawnSync(process.execPath, [checker, '-'], { input: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const line = String(child.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
  if (!line) return { ok: false, error: 'the validator produced no verdict' }
  try {
    return JSON.parse(line)
  } catch (err) {
    return { ok: false, error: 'unreadable validator output' }
  }
}

const docs = await skillDocs()
console.log('checking ' + docs.length + ' skill document(s) under ' + path.relative(repo, skillsRoot))
console.log('')

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------
const mermaidBlocks = []
for (const doc of docs) {
  for (const block of fences(await fsp.readFile(doc, 'utf8'))) {
    if (block.lang === 'mermaid') mermaidBlocks.push({ doc, block })
  }
}
console.log('--- mermaid: ' + mermaidBlocks.length + ' block(s)')
for (const { doc, block } of mermaidBlocks) {
  const where = path.relative(repo, doc) + ':' + block.line
  if (block.skip) {
    skipped += 1
    console.log('skip ' + where.padEnd(52) + ' (marked no-check)')
    continue
  }
  const verdict = mermaidVerdict(block.body.join('\n'))
  check(where, verdict.ok === true && verdict.reason === undefined ? true : false)
  if (verdict.ok !== true) {
    console.log('     ' + String(verdict.error ?? 'unknown').split('\n').slice(0, 4).join('\n     '))
  }
  const warnings = Array.isArray(verdict.warnings) ? verdict.warnings : []
  if (warnings.length > 0) {
    // Advisory only: the host would still store the diagram. Reported so a doc
    // that ships a picture the linter calls unreadable is visible.
    console.log('     note: the lint flags it - ' + warnings.map((entry) => entry.kind).join(', '))
  }
}

// ---------------------------------------------------------------------------
// TikZ
// ---------------------------------------------------------------------------
const texBlocks = []
for (const doc of docs) {
  for (const block of fences(await fsp.readFile(doc, 'utf8'))) {
    if (block.lang === 'tex' || block.lang === 'latex') texBlocks.push({ doc, block })
  }
}
console.log('')
console.log('--- tikz: ' + texBlocks.length + ' block(s)')
const latexModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-diagrams/lib/latex.js')).href)
const engines = latexModule.probeEngines()
if (texBlocks.length > 0 && !engines.available) {
  console.log('skip every tikz example                        (no TeX engine on this host)')
  skipped += texBlocks.length
} else {
  for (const { doc, block } of texBlocks) {
    const where = path.relative(repo, doc) + ':' + block.line
    if (block.skip) {
      skipped += 1
      console.log('skip ' + where.padEnd(52) + ' (marked no-check)')
      continue
    }
    const normalized = latexModule.normalizeTikzSource(block.body.join('\n'))
    const result = await latexModule.compileTikz({ document: normalized.document, engines, dpi: 100 })
    const diagnostics = result.diagnostics ?? []
    check(where, diagnostics.length === 0 && result.unavailable !== true)
    for (const diagnostic of diagnostics.slice(0, 3)) console.log('     ' + diagnostic.text)
  }
}

// ---------------------------------------------------------------------------
// Canvas design documents (packages/dsh-canvas/skills/**)
// ---------------------------------------------------------------------------
const canvasDocs = await docsUnder(canvasSkillsRoot)
const canvasBlocks = []
const canvasJson = []
for (const doc of canvasDocs) {
  for (const block of fences(await fsp.readFile(doc, 'utf8'))) {
    if (block.lang === 'canvas') canvasBlocks.push({ doc, block })
    if (block.lang === 'json') canvasJson.push({ doc, block })
  }
}
console.log('')
console.log('--- canvas: ' + canvasBlocks.length + ' document(s), ' + canvasJson.length + ' fragment(s)')
const canvasEngine = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/engine.js')).href)
const canvasPresets = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/presets.js')).href)
const canvasFonts = (await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/fonts.js')).href)).fontTable()
/** The synthetic measurer the canvas check uses: half the font size per character. */
const syntheticMeasure = (text, font) => text.length * (font.size ?? 16) * 0.5
for (const { doc, block } of canvasBlocks) {
  const where = path.relative(repo, doc) + ':' + block.line
  if (block.skip) {
    skipped += 1
    console.log('skip ' + where.padEnd(52) + ' (marked no-check)')
    continue
  }
  let parsed = null
  try {
    parsed = JSON.parse(block.body.join('\n'))
  } catch (err) {
    check(where + ' is JSON', false)
    console.log('     ' + err.message)
    continue
  }
  const verdict = canvasEngine.normalizeDocument(parsed, { presets: canvasPresets.PRESETS, fonts: canvasFonts })
  check(where + ' validates', verdict.problems.length === 0)
  for (const problem of verdict.problems.slice(0, 5)) console.log('     ' + (problem.path ? problem.path + ': ' : '') + problem.message)
  if (!verdict.document) continue
  // A document that validates can still be a BROKEN EXAMPLE: text that overflows,
  // is truncated, or runs off the canvas teaches exactly the wrong habit.
  const laid = canvasEngine.layout(verdict.document, { measure: syntheticMeasure, assets: {}, fonts: canvasFonts })
  const bad = laid.warnings.filter((entry) => ['TEXT_OVERFLOW', 'TEXT_TRUNCATED', 'TEXT_UNWRAPPED'].includes(entry.code))
  check(where + ' lays out cleanly', bad.length === 0)
  for (const warning of bad.slice(0, 3)) console.log('     ' + warning.message)
}
for (const { doc, block } of canvasJson) {
  const where = path.relative(repo, doc) + ':' + block.line
  try {
    JSON.parse(block.body.join('\n'))
    checked += 1
    console.log('ok   ' + where.padEnd(52) + ' json fragment parses')
  } catch (err) {
    failures += 1
    console.log('FAIL ' + where.padEnd(52) + ' not JSON: ' + err.message)
  }
}

console.log('')
console.log(
  (failures === 0 ? 'all ' + checked + ' skill example(s) passed' : failures + ' example(s) FAILED') +
    (skipped > 0 ? ' (' + skipped + ' skipped)' : ''),
)
console.log('host: ' + os.platform() + ', engine: ' + (engines.available ? engines.engine : 'none'))
process.exitCode = failures === 0 ? 0 : 1