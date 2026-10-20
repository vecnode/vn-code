// check-shader-examples.mjs - every fenced GLSL example a bundled skill ships must
// COMPILE.
//
// Why this exists: the skills are not prose, they are load-bearing - an agent is
// told to reach for one before writing a shader, and a copy-pasteable example that
// does not compile sends it straight into a failure the skill was supposed to
// prevent. This drives the DOCUMENTATION through the same compiler the tools use,
// so a doc and its engine cannot drift apart.
//
// Every ```glsl block is compiled with the real compiler. A block that is
// deliberately incomplete is marked `no-check` in its info string (```glsl
// no-check) or on the line above it, and is then reported as skipped rather than
// checked. A vertex shader is recognised by `gl_Position` and compiled as one.
//
// The browser is optional: with none on this host the whole run is skipped LOUDLY,
// because the plugin degrades the same way and a silent pass would be a lie.
//
// Run:  node scripts/checks/check-shader-examples.mjs
export {} // (ESM for the dynamic imports below)

const { promises: fsp } = await import('node:fs')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const skillsRoot = path.join(repo, 'packages', 'dsh-shaders', 'skills')

let failures = 0
let checked = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const verify = await import(pathToFileURL(path.join(repo, 'packages', 'dsh-shaders', 'lib', 'verify.js')).href)
const compile = await import(pathToFileURL(path.join(repo, 'packages', 'dsh-shaders', 'lib', 'compile.js')).href)
const engineModule = await import(pathToFileURL(path.join(repo, 'packages', 'dsh-shaders', 'lib', 'engine.js')).href)

/** Every markdown file a bundled skill ships, relative to the package. */
async function skillDocs() {
  const found = []
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md')) found.push(full)
    }
  }
  await walk(skillsRoot)
  return found.sort()
}

/** The fenced blocks of one markdown file. */
function fences(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const fence = /^\s*```(\S*)\s*(.*)$/.exec(lines[index])
    if (fence !== null) {
      if (open === null) {
        open = { lang: fence[1].toLowerCase(), info: fence[2].trim(), line: index + 2, body: [], previous: index > 0 ? lines[index - 1] : '' }
      } else {
        blocks.push({ ...open, body: open.body.join('\n') })
        open = null
      }
      continue
    }
    if (open !== null) open.body.push(lines[index])
  }
  return blocks
}

const docs = await skillDocs()
check('skill documents found', docs.length >= 5, true)

const examples = []
for (const file of docs) {
  const text = await fsp.readFile(file, 'utf8')
  const relative = path.relative(repo, file).split(path.sep).join('/')
  for (const block of fences(text)) {
    if (block.lang !== 'glsl' && block.lang !== 'vert' && block.lang !== 'frag') continue
    const skip = /\bno-check\b/.test(block.info) || /\bno-check\b/.test(block.previous)
    const stage = block.lang === 'vert' || (/\bgl_Position\b/.test(block.body) && !/\bgl_FragColor\b|\bout\s+vec4\b/.test(block.body)) ? 'vertex' : 'fragment'
    examples.push({ relative, line: block.line, body: block.body, stage, skip, lang: block.lang })
  }
}
check('glsl examples found in the skills', examples.length >= 8, true)
console.log('     ' + String(examples.length) + ' example(s) in ' + String(docs.length) + ' document(s)')

const engine = engineModule.resolveEngine()
if (engine === null) {
  console.log('SKIP no Chromium-family browser on this host, so the ' + String(examples.filter((entry) => !entry.skip).length) + ' skill example(s) were NOT compiled.')
  console.log('     install Chrome/Edge or set DSH_SHADERS_ENGINE; this is a skip, not a pass.')
  process.exit(0)
}

const jobs = []
const runnable = []
for (const example of examples) {
  if (example.skip) {
    console.log('skip ' + example.relative + ':' + String(example.line) + ' (marked no-check)')
    continue
  }
  const assembled = verify.assemble({ source: example.body, stage: example.stage })
  if (!assembled.ok) {
    check(example.relative + ':' + String(example.line) + ' assembles', false, true)
    console.log('     ' + assembled.error)
    continue
  }
  const id = example.relative + ':' + String(example.line)
  jobs.push(compile.jobFor(assembled, { id }))
  runnable.push({ ...example, id, assembled })
}

const report = await compile.runJobs({ jobs })
if (!report.ok) {
  console.log('FAIL the compiler session failed: ' + report.message)
  process.exit(1)
}
const byId = new Map(report.results.map((entry) => [entry.id, entry]))
for (const example of runnable) {
  const result = byId.get(example.id)
  const mapped = verify.mapDiagnostics(result?.log ?? '', example.assembled.mapLine)
  const ok = result !== undefined && result.status === 'ok'
  check(example.relative + ':' + String(example.line) + ' (' + example.stage + ', ' + example.assembled.dialect + ')', ok, true)
  if (!ok) {
    for (const diagnostic of mapped.diagnostics.slice(0, 4)) console.log('     line ' + String(diagnostic.line) + ': ' + diagnostic.message)
    if (mapped.diagnostics.length === 0) console.log('     ' + String(result?.error ?? result?.log ?? 'no result').slice(0, 300))
  }
}

console.log('')
console.log(failures === 0 ? 'all ' + String(checked) + ' checks passed' : String(failures) + ' FAILURES of ' + String(checked))
process.exit(failures === 0 ? 0 : 1)
