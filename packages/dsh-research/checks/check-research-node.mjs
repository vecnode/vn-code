// check-research-node.mjs - the dsh-research engine, driven with no harness.
//
// What this proves, and why each half is here:
//
//   - the RUN MODEL (a folder, its two JSON files, atomic writes) round-trips;
//   - the PATH POLICY refuses every shape of escape - a bad slug, a path that
//     leaves the run folder, and a SYMLINK inside the root pointing out of it,
//     which is the one a string comparison alone would let through;
//   - the GATES cannot be answered by a machine: `g2-intake` demands the user's
//     own words even for a plain "no", an override demands a reason, and a second
//     answer is refused rather than silently overwriting the ledger;
//   - the three TOOLS answer against their own declared `output.schema` (the same
//     subset the harness's registry enforces) and survive a lossless JSON round
//     trip, so the model is never handed a value the registry would reject;
//   - the four ROUTES register with GET/HEAD/POST on exact paths only, and the
//     gate route is the one that writes;
//   - and the row's SECURITY claim is checked rather than asserted: no file of
//     this package imports a socket-capable module or a child process, and the
//     only environment variables it reads are its own root and the home
//     directory it looks for a Desktop in.
//
// Run:  node packages/dsh-research/checks/check-research-node.mjs
//       npm run check          (from packages/dsh-research)
//
// A case this host cannot run says so LOUDLY and exits 0 for that case only -
// never silently, and never weakened to make a change pass.
export {}

const { promises: fsp } = await import('node:fs')
const { readFileSync, readdirSync } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const pkgDir = path.join(repo, 'packages', 'dsh-research')
let failures = 0
let skips = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(44) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

function skip(label, why) {
  skips += 1
  console.log('SKIP ' + label.padEnd(44) + ' ' + why)
}

/** One error's `code`, whatever was thrown. */
async function codeOf(fn) {
  try {
    await fn()
    return '(no error)'
  } catch (err) {
    return err && err.code ? String(err.code) : 'THREW:' + (err && err.message ? err.message : String(err))
  }
}

/**
 * The subset of JSON Schema the tool registry enforces, applied to a value.
 *
 * The tools below are driven through `execute()` - the same seam the agent loop
 * uses - so nothing else here would notice a value contradicting the schema the
 * model was handed. A key that is only sometimes meaningful must be ABSENT, and
 * this is what says so.
 */
function schemaErrors(schema, value, label = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matches = wanted.some((one) => {
      if (one === 'integer') return Number.isInteger(value)
      if (one === 'number') return typeof value === 'number'
      if (one === 'string') return typeof value === 'string'
      if (one === 'boolean') return typeof value === 'boolean'
      if (one === 'array') return Array.isArray(value)
      if (one === 'object') return actual === 'object'
      if (one === 'null') return value === null
      return true
    })
    if (!matches) problems.push(label + ' must be ' + wanted.join('|') + ' (got ' + actual + ')')
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(label + ' is not one of ' + schema.enum.join(','))
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaErrors(schema.items, item, label + '[' + index + ']')))
  }
  if (value !== null && actual === 'object' && schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value[key] === undefined) continue
      problems.push(...schemaErrors(schema.properties[key], value[key], label + '.' + key))
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(label + '.' + key + ' is required')
    }
  }
  return problems
}

/** The value must also survive a JSON round trip with every key intact. */
function losslessErrors(value, label = 'value') {
  if (value === null || typeof value !== 'object') return []
  const problems = []
  for (const key of Object.keys(value)) {
    const round = JSON.parse(JSON.stringify(value))
    if (!Object.hasOwn(round, key)) problems.push(label + '.' + key + ' is dropped by JSON.stringify (undefined)')
    else problems.push(...losslessErrors(value[key], label + '.' + key))
  }
  return problems
}

/** A stub cordis context that records the routes a row registers. */
async function harness(modulePath) {
  const routes = new Map()
  const tools = new Map()
  const warnings = []
  const log = { warn: (text) => warnings.push(String(text)), info() {}, debug() {} }
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    get: (service) =>
      service === 'connection'
        ? { fetch: { register: (route) => (routes.set(route.path, route), () => routes.delete(route.path)) } }
        : undefined,
    effect: (fn) => fn(),
    tools: { register: (tool) => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
  }
  const module = await import(pathToFileURL(modulePath).href)
  const dispose = module.registerRoutes({ ctx, log })
  return { module, ctx, routes, tools, warnings, dispose }
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-research-node-'))
// The root is the ONLY configuration this plugin reads, and pointing it at a temp
// folder is what keeps this check from writing anything a person would find.
const root = path.join(tmp, 'root')
const workspace = path.join(tmp, 'workspace')
await fsp.mkdir(workspace, { recursive: true })
// The plugin's own home (`$DSH_HOME/<package>/`) holds the library POINTER, so
// the check points it at a temp folder too: a check that wrote into the real
// ~/.dsh would be a check that changed the machine it ran on.
const dshHome = path.join(tmp, 'dsh-home')
const env = { ...process.env, DSH_HOME: dshHome, DSH_RESEARCH_ROOT: root }
// The ROUTES read `process.env` for real - a route has no session and no env of
// its own, which is exactly how the harness runs one - so the check sets the same
// variables in the process it is about to drive them in, and puts them back.
const envBefore = process.env.DSH_RESEARCH_ROOT
const homeBefore = process.env.DSH_HOME
process.env.DSH_RESEARCH_ROOT = root
process.env.DSH_HOME = dshHome

const runModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'run.js')).href)
const toolsModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'tools.js')).href)
const indexModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href)
const ledgerModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'ledger.js')).href)
const docModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'doc.js')).href)
const syntaxModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'syntax.js')).href)
const buildModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'build.js')).href)
const viewModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'view.js')).href)
const verifyModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'verify.js')).href)
const reviewModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'review.js')).href)
const docxModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'docx', 'index.js')).href)
const htmlModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'html.js')).href)
const texModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'tex.js')).href)
const refsModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'refs.js')).href)
const stylesModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'styles', 'index.js')).href)
const apiModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'api.js')).href)

const {
  GATES,
  PLUGIN_VERSION,
  ResearchError,
  answerGate,
  createRun,
  desktopRoot,
  gateViews,
  healthView,
  insideRoot,
  isSlug,
  parseSlug,
  pendingGates,
  projectView,
  readJson,
  readPassport,
  readRun,
  readRunText,
  resolveRoot,
  stageOf,
  stateView,
} = runModule
const { TOOL_NAMES, buildTools, workspaceOf, provenanceOf, nearMisses } = toolsModule
const { appendClaim, appendSource, claimsById, foldLatest, readClaims, readSources, sourcesByKey, statusCounts } = ledgerModule
const { assembleDocument, renderBody, renderReferences, scanDocument, sectionsOf, validateStructure, wordCount } = docModule
const { findCitations, findClaimSpans, normalizeLocator, nextClaimId, parseKey } = syntaxModule
const { FORMATS, FORMATS_READY, composeMarkdown, hashOf, readRunState, runBuild } = buildModule
const { ALL_GATES, libraryFile, readLibrary } = runModule
const { projectDetail } = viewModule
const { API_ROUTES } = apiModule

console.log('check-research-node: the run model, the ledgers, the document, the gates, the tools, the routes, the security claim')

// ---------------------------------------------------------------------------
// Where runs live, and the pointer that makes it the SAME place every session
// ---------------------------------------------------------------------------
{
  const home = path.join(tmp, 'home')
  await fsp.mkdir(path.join(home, 'Desktop'), { recursive: true })
  const desktop = await desktopRoot({ env: {}, home })
  check('desktop is found by existence', desktop, path.join(home, 'Desktop'))

  // A fresh $DSH_HOME is a machine that has never run this plugin.
  const fresh = (name) => ({ DSH_HOME: path.join(tmp, name) })

  const chosen = await resolveRoot({ env: fresh('h1'), home, workspace })
  check('no pointer yet -> the desktop ladder', chosen.source, 'desktop')
  check('the desktop root is <desktop>/vncode-research', chosen.root, path.join(home, 'Desktop', 'vncode-research'))
  check('and the choice is REMEMBERED', await fsp.stat(chosen.pointer).then(() => true).catch(() => false), true)

  // The claim the pointer exists for: a second session, from a DIFFERENT working
  // directory, on a machine with no Desktop visible, still lands in the same
  // library. Without the pointer this call would answer `<other>/research`.
  const otherWorkspace = path.join(tmp, 'elsewhere')
  const second = await resolveRoot({ env: fresh('h1'), home: path.join(tmp, 'no-such-home'), workspace: otherWorkspace })
  check('a later session finds the SAME library', second.root, chosen.root)
  check('and says it came from the pointer', second.remembered, true)
  check('and keeps the reason it was chosen', second.source, 'desktop')

  const fallback = await resolveRoot({ env: fresh('h2'), home: path.join(tmp, 'no-such-home'), workspace })
  check('no Desktop at all -> the workspace', fallback.source, 'workspace')
  check('the workspace root is <workspace>/research', fallback.root, path.join(workspace, 'research'))
  check('and that choice is remembered too', await fsp.stat(fallback.pointer).then(() => true).catch(() => false), true)

  const overridden = await resolveRoot({ env: { ...fresh('h3'), DSH_RESEARCH_ROOT: 'runs-here' }, home, workspace })
  check('an override wins over the Desktop', overridden.source, 'env')
  check('a relative override resolves against the workspace', overridden.root, path.join(workspace, 'runs-here'))
  check('and the override is remembered as the source', (await readLibrary({ DSH_HOME: path.join(tmp, 'h3') })).source, 'env')
  check('the pointer explains itself to a person', (await readLibrary({ DSH_HOME: path.join(tmp, 'h3') })).why.includes('ANY session'), true)
  check('deleting the pointer is how you make it choose again', await readLibrary(fresh('h9')), null)

  const view = await stateView({ env: fresh('h1'), home, workspace })
  check('the state view reports the pointer', view.root.pointer, path.join(tmp, 'h1', 'dsh-research', 'library.json'))
  check('and whether this session read it', view.root.remembered, true)
  check('and says so in its notes', view.notes.some((note) => note.includes('every session finds the same library')), true)
}

// ---------------------------------------------------------------------------
// Slugs and containment
// ---------------------------------------------------------------------------
{
  for (const value of ['', 'ab', 'A-b', 'a b', '../etc', 'a/b', '-abc', 'abc-', 'x'.repeat(65)]) {
    check('slug refused: ' + JSON.stringify(value.slice(0, 12)), await codeOf(() => parseSlug(value)), 'BAD_SLUG')
  }
  check('a good slug passes', parseSlug('ai-higher-ed-qa'), 'ai-higher-ed-qa')
  check('isSlug agrees', isSlug('a1b'), true)
}

// ---------------------------------------------------------------------------
// Creating a run
// ---------------------------------------------------------------------------
const INSTRUCTION = 'I want to write a paper on AI and quality assurance in higher education.'
{
  const created = await createRun({
    root,
    slug: 'ai-higher-ed-qa',
    title: 'AI and quality assurance in higher education',
    kind: 'paper',
    instruction: INSTRUCTION,
  })
  check('a run is a folder with RUN.json', await readJson(path.join(created.dir, 'RUN.json')).then((one) => one.slug !== undefined), true)
  check('and a passport', await readJson(path.join(created.dir, 'passport.json')).then((one) => one.instructions.length), 1)
  check('the instruction is recorded VERBATIM', created.passport.instructions[0].verbatim, INSTRUCTION)
  check('the kind picks its structure', created.record.structure, 'imrad')
  check('the passport opens with NO gate answered', created.passport.gates.length, 0)
  for (const folder of ['plan', 'doc', 'ledger', 'sources', 'figures', 'reviews', 'build']) {
    check('folder exists: ' + folder, await fsp.stat(path.join(created.dir, folder)).then((stat) => stat.isDirectory()).catch(() => false))
  }
  check('the same slug twice is refused', await codeOf(() => createRun({ root, slug: 'ai-higher-ed-qa', title: 'again' })), 'RUN_EXISTS')
  check('an empty title is refused', await codeOf(() => createRun({ root, slug: 'no-title', title: '  ' })), 'BAD_TITLE')
  check('an unknown kind is refused', await codeOf(() => createRun({ root, slug: 'bad-kind', title: 'x', kind: 'novel' })), 'BAD_KIND')
  check('a style with no renderer is refused', await codeOf(() => createRun({ root, slug: 'bad-style', title: 'x', style: 'harvard' })), 'BAD_STYLE')
  check('an unknown structure is refused', await codeOf(() => createRun({ root, slug: 'bad-struct', title: 'x', structure: 'sonnet' })), 'BAD_STRUCTURE')
  check('a nonsense language is refused', await codeOf(() => createRun({ root, slug: 'bad-lang', title: 'x', language: 'english' })), 'BAD_LANGUAGE')
  check('nothing was created by a refusal', await fsp.stat(path.join(root, 'no-title')).then(() => true).catch(() => false), false)
  check('a missing run is UNKNOWN_RUN', await codeOf(() => readRun(root, 'never-made')), 'UNKNOWN_RUN')
}

// ---------------------------------------------------------------------------
// Containment: a symlink inside the root must not be followable out of it
// ---------------------------------------------------------------------------
{
  const outside = path.join(tmp, 'outside')
  await fsp.mkdir(outside, { recursive: true })
  const link = path.join(root, 'linked')
  let linked = true
  try {
    await fsp.symlink(outside, link, 'dir')
  } catch (err) {
    linked = false
    skip('a symlink inside the root is refused', 'this host will not create a symlink (' + (err.code ?? 'unknown') + ')')
  }
  if (linked) {
    check('a symlink out of the root is refused', await codeOf(() => readRun(root, 'linked')), 'PATH_ESCAPE')
    check('insideRoot says no', await insideRoot(root, path.join(link, 'RUN.json')), false)
    check('insideRoot says yes for a real child', await insideRoot(root, path.join(root, 'ai-higher-ed-qa')), true)
  }
  check('insideRoot refuses a `..` walk', await insideRoot(root, path.join(root, '..', 'outside')), false)
}

// ---------------------------------------------------------------------------
// The gates: a person answers these, or nobody does
// ---------------------------------------------------------------------------
{
  const { passport } = await readPassport(root, 'ai-higher-ed-qa')
  check('both frame gates open pending', pendingGates(passport).length, 2)
  check('a fresh run is stage `new`', stageOf(passport), 'new')

  check(
    'g2-intake demands words even for a plain "no"',
    await codeOf(() => answerGate({ root, slug: 'ai-higher-ed-qa', id: 'g2-intake', value: 'no_experiments_declared', text: '' })),
    'TEXT_REQUIRED',
  )
  check(
    'an unknown gate is refused',
    await codeOf(() => answerGate({ root, slug: 'ai-higher-ed-qa', id: 'g9-nope', value: 'x', text: 'x' })),
    'GATE_UNKNOWN',
  )
  check(
    'an option the gate does not offer is refused',
    await codeOf(() => answerGate({ root, slug: 'ai-higher-ed-qa', id: 'g2-intake', value: 'maybe', text: 'x' })),
    'VALUE_INVALID',
  )

  const answered = await answerGate({
    root,
    slug: 'ai-higher-ed-qa',
    id: 'g2-intake',
    value: 'no_experiments_declared',
    text: 'Literature only - I ran nothing, this is a review of other people’s studies.',
  })
  check('the answer is recorded verbatim', answered.entry.text.startsWith('Literature only'), true)
  check('it carries a timestamp', typeof answered.entry.at === 'string' && answered.entry.at.length >= 20, true)
  check('one gate left', pendingGates(answered.passport).length, 1)
  check('stage is `framing`', stageOf(answered.passport), 'framing')
  check(
    'answering the same gate twice is refused',
    await codeOf(() => answerGate({ root, slug: 'ai-higher-ed-qa', id: 'g2-intake', value: 'no_experiments_declared', text: 'again' })),
    'GATE_ALREADY_ANSWERED',
  )

  // A second run, because an override needs a gate that is still open.
  await createRun({ root, slug: 'override-check', title: 'Override check', kind: 'brief' })
  check(
    'an override without a reason is refused',
    await codeOf(() => answerGate({ root, slug: 'override-check', id: 'g1-rq', value: 'revise' })),
    'REASON_REQUIRED',
  )
  const overridden = await answerGate({
    root,
    slug: 'override-check',
    id: 'g1-rq',
    value: 'revise',
    reason: 'The question is still too broad - narrow it to one sector first.',
  })
  check('the reason is kept with the answer', overridden.entry.reason.startsWith('The question is still too broad'), true)

  const framed = await answerGate({ root, slug: 'ai-higher-ed-qa', id: 'g1-rq', value: 'confirm', text: '' })
  check('every gate answered -> `framed`', stageOf(framed.passport), 'framed')
  check('gateViews reports the answer shape the tab draws', Object.keys(gateViews(framed.passport)[0].answer).sort().join(','), 'at,reason,text,value')
  check('the gate question is host-owned data', GATES.length, 2)
}

// ---------------------------------------------------------------------------
// Reading files inside a run
// ---------------------------------------------------------------------------
{
  const dir = path.join(root, 'ai-higher-ed-qa')
  await fsp.mkdir(path.join(dir, 'doc'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'doc', 'paper.md'), '# A paper\n\nA claim with a marker.\n', 'utf8')
  await fsp.writeFile(path.join(dir, 'sources', 'binary.pdf'), Buffer.from([0x25, 0x50, 0x00, 0x44, 0x46]))

  const text = await readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: 'doc/paper.md' })
  check('a text file inside the run is read', text.text.includes('A claim with a marker'), true)
  check('and it reports the byte length', text.bytes > 0, true)
  check(
    'a path out of the run is refused',
    await codeOf(() => readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: '../RUN.json' })),
    'PATH_ESCAPE',
  )
  check(
    'an absolute path is refused',
    await codeOf(() => readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: path.join(tmp, 'outside', 'x') })),
    'PATH_ESCAPE',
  )
  check(
    'a NUL byte in a path is refused',
    await codeOf(() => readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: 'doc/\u0000paper.md' })),
    'BAD_PATH',
  )
  check(
    'a binary file is refused BY NAME rather than returned as mojibake',
    await codeOf(() => readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: 'sources/binary.pdf' })),
    'NOT_TEXT',
  )
  check(
    'a missing file is NO_SUCH_FILE',
    await codeOf(() => readRunText({ env, workspace, slug: 'ai-higher-ed-qa', file: 'doc/nope.md' })),
    'NO_SUCH_FILE',
  )
}

// ---------------------------------------------------------------------------
// The two views the browser half is pinned to
// ---------------------------------------------------------------------------
{
  const state = await stateView({ env, workspace, tools: TOOL_NAMES, routes: API_ROUTES, formats: FORMATS_READY })
  check('the state payload names its root source', state.root.source, 'env')
  check('the state payload lists the runs', state.runs.length >= 2, true)
  check(
    'a run row carries EXACTLY the keys the client was pinned to',
    Object.keys(state.runs[0]).sort().join(','),
    'created,files,gates,kind,language,root,slug,stage,style,title,updated',
  )
  check('the gate count travels with the row', typeof state.runs[0].gates.pending === 'number' && state.runs[0].gates.total === 2, true)
  check('the version matches the package', state.version, PLUGIN_VERSION)
  check('the capabilities name every tool', state.capabilities.tools.join(','), TOOL_NAMES.join(','))
  // The row and the tools both report capabilities, and they must report the SAME
  // thing: a tool that offers a format the build cannot produce is a tool that
  // fails at the last step instead of the first.
  check('and the same formats the build has', state.capabilities.formats.join(','), FORMATS_READY.join(','))
  check('and every route the row registers', state.capabilities.routes.join(','), API_ROUTES.join(','))

  const project = await projectView({ env, workspace, slug: 'ai-higher-ed-qa' })
  check(
    'the project payload carries EXACTLY the top-level keys the client was pinned to',
    Object.keys(project).sort().join(','),
    'files,gates,ledger,notes,passport,run',
  )
  check(
    'the run block matches the pinned shape',
    Object.keys(project.run).sort().join(','),
    'created,kind,language,path,root,slug,stage,structure,style,title,updated',
  )
  check('the passport carries the instruction verbatim', project.passport.instructions[0].verbatim, INSTRUCTION)
  check('the ledger counts are NULL when there is no ledger', project.ledger.claims, null)
  check('the file list sees the document we wrote', project.files.some((file) => file.path === 'doc/paper.md'), true)
  check('the file list skips a `.partial` write', project.files.some((file) => file.path.endsWith('.partial')), false)
  check('a run with no answers is never reported further along', project.run.stage, 'framed')

  const health = await healthView({ env, workspace, tools: TOOL_NAMES, routes: API_ROUTES, formats: FORMATS_READY })
  // One run is fully framed and one still has g2-intake open, so the root's
  // pending count is 1: the snapshot counts GATES, not runs.
  check('the health snapshot counts the pending gates', health.pending, 1)
  check('and names every gate', health.gates.join(','), 'g1-rq,g2-intake,g3-integrity')
  check('and names its routes', health.routes.length, 8)
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------
{
  const log = { warn() {}, info() {}, debug() {} }
  const tools = buildTools({ env, workspace, log })
  check('three tools, and they are the intended three', tools.map((tool) => tool.name).join(','), TOOL_NAMES.join(','))
  check('every tool declares a parameters schema', tools.every((tool) => tool.parameters && tool.parameters.type === 'object'), true)
  check('every tool declares an output schema', tools.every((tool) => tool.output && tool.output.schema && typeof tool.output.render === 'function'), true)
  check('every tool has a prose description', tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 200), true)

  const call = async (name, args) => {
    const tool = tools.find((one) => one.name === name)
    const value = await tool.execute(args, { agent: { session: { meta: { cwd: workspace } } } })
    return { value, problems: [...schemaErrors(tool.output.schema, value, name), ...losslessErrors(value, name)] }
  }

  const fresh = await call('rs_new', {
    slug: 'tool-check',
    title: 'Tool check',
    kind: 'report',
    instruction: 'Record this exactly as I said it, please.',
  })
  check('rs_new answers against its own schema', fresh.problems.join(' | '), '')
  check('rs_new reports BOTH gates pending', fresh.value.view.pending, 2)
  check('rs_new says the human must answer them', fresh.value.text.includes('WAITING ON THE USER'), true)
  check('rs_new writes nothing when the slug exists', (await call('rs_new', { slug: 'tool-check', title: 'again' })).value.view.ok, false)
  check('and a refusal carries its code', (await call('rs_new', { slug: 'tool-check', title: 'again' })).value.view.code, 'RUN_EXISTS')

  for (const action of ['roots', 'list', 'status', 'handoff']) {
    const answer = await call('rs_open', action === 'status' || action === 'handoff' ? { action, slug: 'ai-higher-ed-qa' } : { action })
    check('rs_open action=' + action + ' conforms', answer.problems.join(' | '), '')
    check('rs_open action=' + action + ' answers', answer.value.view.ok, true)
  }
  const handoff = await call('rs_open', { action: 'handoff', slug: 'ai-higher-ed-qa' })
  check('handoff quotes the instruction verbatim', handoff.value.text.includes(INSTRUCTION), true)
  check('handoff quotes the gate answer verbatim', handoff.value.text.includes('Literature only'), true)
  check('handoff says NOT ANSWERED where nothing is recorded', (await call('rs_open', { action: 'handoff', slug: 'tool-check' })).value.text.includes('NOT ANSWERED'), true)

  for (const what of ['run', 'gates', 'passport', 'files']) {
    const answer = await call('rs_read', { slug: 'ai-higher-ed-qa', what })
    check('rs_read what=' + what + ' conforms', answer.problems.join(' | '), '')
  }
  const file = await call('rs_read', { slug: 'ai-higher-ed-qa', what: 'file', file: 'doc/paper.md' })
  check('rs_read what=file conforms', file.problems.join(' | '), '')
  check('rs_read what=file returns the text', file.value.text.includes('A claim with a marker'), true)
  check('a refused rs_read is an ANSWER, not a crash', (await call('rs_read', { slug: 'nope-not-here', what: 'run' })).value.view.ok, false)
  check('and it names the code', (await call('rs_read', { slug: 'nope-not-here', what: 'run' })).value.view.code, 'UNKNOWN_RUN')

  // The workspace resolution is the session's cwd, which is what the harness sets.
  check('the workspace comes from the session cwd', workspaceOf({ agent: { session: { meta: { cwd: '/tmp/x' } } } }), '/tmp/x')
  check('and falls back to the process cwd', workspaceOf(undefined), process.cwd())

  // -------------------------------------------------------------------------
  // The writing tools, end to end: plan -> cite -> write -> build
  // -------------------------------------------------------------------------
  const exec = { agent: { session: { meta: { cwd: workspace } } } }
  const writer = await call('rs_new', { slug: 'writer-check', title: 'A written run', kind: 'paper', instruction: 'Write it from my own words.' })
  check('rs_new conforms', writer.problems.join(' | '), '')

  // The frame gate is what a write is held behind, and the refusal names it.
  const blocked = await call('rs_write', { slug: 'writer-check', text: 'Prose.', claims: [] })
  check('a write before the frame is refused', blocked.value.view.ok, false)
  check('and the refusal is GATE_UNANSWERED', blocked.value.view.code, 'GATE_UNANSWERED')
  check('and it names the gate and where to answer it', blocked.value.text.includes('g1-rq') && blocked.value.text.includes('Research tab'), true)
  check('nothing was written', await fsp.stat(path.join(root, 'writer-check', 'doc', 'paper.md')).then(() => true).catch(() => false), false)

  await answerGate({ root, slug: 'writer-check', id: 'g1-rq', value: 'confirm' })
  await answerGate({ root, slug: 'writer-check', id: 'g2-intake', value: 'no_experiments_declared', text: 'Nothing was run.' })

  const planned = await call('rs_plan', { slug: 'writer-check', part: 'outline', text: '- intro: Introduction\n- results: Results\n' })
  check('rs_plan writes the outline', planned.problems.join(' | '), '')
  check('and says what it named', planned.value.text.includes('intro, results'), true)
  check('rs_plan reads back what it wrote', (await call('rs_plan', { slug: 'writer-check', part: 'outline', action: 'read' })).value.text.includes('Results'), true)

  const noted = await call('rs_cite', {
    slug: 'writer-check',
    action: 'add',
    key: 'smith2024',
    record: { kind: 'journal-article', title: 'The effect of X on Y', authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'Journal Name', volume: '12', issue: '3', pages: '45-67', doi: '10.1234/abcd' },
    source: 'crossref',
    text: 'The study found that completion rose by 25 points after the programme began.',
  })
  check('rs_cite conforms', noted.problems.join(' | '), '')
  check('and stores the text it was handed', noted.value.text.includes('characters from crossref'), true)
  check('and names where the fields came from', noted.value.text.includes('from a source you named'), true)

  const cited = await call('rs_cite', {
    slug: 'writer-check',
    action: 'add',
    key: 'typo2024',
    record: { kind: 'report', title: 'A report', year: '2024', container: 'An Agency' },
    source: 'author',
  })
  check('a second source can be recorded by hand', cited.value.view.ok, true)
  check('rs_cite list shows both', (await call('rs_cite', { slug: 'writer-check', action: 'list' })).value.text.includes('typo2024'), true)
  check('rs_cite get names the missing shape it can see', (await call('rs_cite', { slug: 'writer-check', action: 'get', key: 'nope' })).value.view.code, 'UNKNOWN_SOURCE')

  const bad = await call('rs_write', {
    slug: 'writer-check',
    section: 'intro',
    text: 'See [@smith-2024].',
    claims: [],
  })
  check('an unknown citation is refused', bad.value.view.code, 'UNKNOWN_CITATION')
  check('with the nearest key suggested', bad.value.text.includes('did you mean smith2024'), true)
  const broken = await call('rs_write', {
    slug: 'writer-check',
    section: 'intro',
    text: 'See [see @smith2024].',
    claims: [],
  })
  check('a citation that does not parse is refused, not ignored', broken.value.view.code, 'BROKEN_CITATION')

  const undeclared = await call('rs_write', {
    slug: 'writer-check',
    section: 'intro',
    text: 'See [@smith2024]. [A claim.]{#c0001}',
    claims: [],
  })
  check('an undeclared span is refused', undeclared.value.view.code, 'CLAIM_UNDECLARED')
  const spanless = await call('rs_write', {
    slug: 'writer-check',
    section: 'intro',
    text: 'See [@smith2024].',
    claims: [{ id: 'c0001' }],
  })
  check('a claim with no span is refused', spanless.value.view.code, 'CLAIM_SPAN_MISSING')
  check('a bad section slug is refused', (await call('rs_write', { slug: 'writer-check', section: 'Intro!', text: 'x', claims: [] })).value.view.code, 'BAD_SECTION')

  const written = await call('rs_write', {
    slug: 'writer-check',
    section: 'results',
    text: '## Results\n\n[The programme raised completion by 25 points.]{#c0001} See [@smith2024, p. 7].\n',
    claims: [{ id: 'c0001', strength: 'causal', sources: [{ key: 'smith2024', locator: { kind: 'quote', quote: 'completion rose by 25 points', page: 7 } }] }],
  })
  check('rs_write conforms', written.problems.join(' | '), '')
  check('and reports the claims it recorded', written.value.text.includes('claims in this text: 1'), true)
  check('and the citations it resolved', written.value.text.includes('smith2024'), true)

  const readClaims2 = await call('rs_read', { slug: 'writer-check', what: 'claims' })
  check('rs_read what=claims shows the binding', readClaims2.value.text.includes('smith2024') && readClaims2.value.text.includes('p. 7'), true)
  check('rs_read what=sources shows the ledger', (await call('rs_read', { slug: 'writer-check', what: 'sources' })).value.text.includes('NO BYTES'), true)
  check('rs_read what=outline assembles the document', (await call('rs_read', { slug: 'writer-check', what: 'outline' })).value.text.includes('[results]'), true)

  const built = await call('rs_build', { slug: 'writer-check', format: 'md' })
  check('rs_build conforms', built.problems.join(' | '), '')
  check('and writes the draft', built.value.text.includes('build/paper.md'), true)
  check('and records the artifact hash', built.value.text.includes('sha256'), true)

  const cleanRefused = await call('rs_build', { slug: 'writer-check', format: 'md', draft: 'clean' })
  check('a clean build is refused until a person answers g3', cleanRefused.value.view.code, 'GATE_UNANSWERED')
  const openGates = await call('rs_read', { slug: 'writer-check', what: 'gates' })
  check('and the gate is now VISIBLE as pending', openGates.value.text.includes('g3-integrity') && openGates.value.text.includes('PENDING'), true)
  check('its options are shown with the override flagged', openGates.value.text.includes('[needs a reason]'), true)

  const exportTool = await call('rs_build', { slug: 'writer-check', format: 'ris' })
  check('an export is built from the library', exportTool.value.text.includes('references.ris'), true)
  // Every format this build ADVERTISES is implemented, so there is no "not yet" left
  // to report - and a format added to the enum without a builder fails here rather
  // than being advertised by a schema that cannot honour it.
  check('every advertised format is implemented', FORMATS.filter((one) => !FORMATS_READY.includes(one)).join(','), '')
  check('and an unknown format is refused by name', await codeOf(() => runBuild({ runDir: path.join(root, 'writer-check'), format: 'pdf', draft: 'watermark', styleId: 'apa7', slug: 'writer-check' })), 'BAD_FORMAT')

  // ---- the DOCX: a real archive with the parts a reader needs
  const docxBuild = await call('rs_build', { slug: 'writer-check', format: 'docx' })
  check('the DOCX builds', docxBuild.value.view.ok && docxBuild.value.text.includes('build/paper.docx'), true)
  const docxBytes = await fsp.readFile(path.join(root, 'writer-check', 'build', 'paper.docx')).catch(() => null)
  check('and the file is on disk', docxBytes !== null && docxBytes.length > 2000, true)
  check('and it is a ZIP, by its own magic number', docxBytes !== null && docxBytes[0] === 0x50 && docxBytes[1] === 0x4b, true)
  const parts = docxModule.unzipDocx(docxBytes)
  check('with the parts a Word reader opens', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'docProps/core.xml'].every((name) => parts.has(name)), true)
  const docxText = docxModule.documentText(docxBytes)
  check('and the reference heading the style uses', docxText.includes('References'), true)
  check('and the claim sentences in the body', docxText.includes('raised completion by 25 points'), true)
  check('while the claim markers are gone from the prose', docxText.includes('{#c0001}'), false)
  // Determinism is a promise, so it is asserted: the same run built twice is the
  // same bytes, because the writer may not read the clock.
  const again = await call('rs_build', { slug: 'writer-check', format: 'docx' })
  const docxSecond = await fsp.readFile(path.join(root, 'writer-check', 'build', 'paper.docx'))
  check('and two DOCX builds of one run are byte-identical', hashOf(docxBytes) === hashOf(docxSecond), true)

  // ---- the HTML: one page, no network, from the same parse
  const htmlBuild = await call('rs_build', { slug: 'writer-check', format: 'html' })
  check('the HTML builds', htmlBuild.value.view.ok && htmlBuild.value.text.includes('build/paper.html'), true)
  const page = await fsp.readFile(path.join(root, 'writer-check', 'build', 'paper.html'), 'utf8').catch(() => null)
  check('and the page is on disk', page !== null && page.length > 500, true)
  check('as a complete document', page.startsWith('<!doctype html>') && page.trimEnd().endsWith('</html>'), true)
  check('with its style INLINE, so it opens with no network', page.includes('<style>') && /href=["']https?:[^"']*\.css/.test(page) === false, true)
  check('and nothing executable in it', /<script/i.test(page), false)
  check('carrying the run\'s title', page.includes('A written run'), true)
  check('and the document\'s own prose', page.includes('raised completion by 25 points'), true)
  check('with the claim markers gone', page.includes('{#c0001}'), false)
  check('and the style\'s own reference heading', page.includes('>References<'), true)
  check('and the reference list in its own block', page.includes('class="refs"'), true)
  // The safety rule: a URL that arrived from a source record must not become
  // executable content in a file this plugin produced.
  check('a javascript: URL is dropped rather than emitted', htmlModule.safeUrl('javascript:alert(1)'), '')
  check('while an https one survives', htmlModule.safeUrl('https://doi.org/10.1/x'), 'https://doi.org/10.1/x')
  check('and a title cannot inject markup', htmlModule.escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;')
  check('the builder reports that the page is self-contained', htmlModule.buildHtmlReport({ markdown: '# t\n\nx\n', title: 't' }).report.selfContained, true)

  // ---- the TeX: a file, and the command PRINTED rather than run
  const texBuild = await call('rs_build', { slug: 'writer-check', format: 'tex' })
  check('the TeX builds', texBuild.value.view.ok && texBuild.value.text.includes('build/paper.tex'), true)
  // The whole reason a `.tex` is a legitimate output for a package that spawns no
  // process: the compile step is the person's, and the command is handed over.
  check('and PRINTS the command instead of running it', texBuild.value.text.includes('pdflatex -output-directory=build build/paper.tex'), true)
  const tex = await fsp.readFile(path.join(root, 'writer-check', 'build', 'paper.tex'), 'utf8').catch(() => null)
  check('the file is on disk', tex !== null && tex.length > 300, true)
  check('with a preamble that needs no bibliography engine', tex.includes('\\documentclass') && tex.includes('\\begin{document}') && tex.includes('\\end{document}'), true)
  check('and none of the citation machinery a second engine would add', /\\cite\{|\\bibliography\{|addbibresource/.test(tex), false)
  check('carrying the run\'s title', tex.includes('A written run'), true)
  check('and the document\'s own prose', tex.includes('raised completion by 25 points'), true)
  check('with the claim markers gone', tex.includes('{#c0001}'), false)
  check('and the style\'s reference heading', tex.includes('\\section*{References}'), true)
  check('and the reference list in a hanging-indent group', tex.includes('\\begin{hangparas}'), true)
  // A title with TeX's own characters in it either compiles or does not, and the
  // failure would be a line number in a log the agent may never see.
  check('the ten characters that mean something to TeX are escaped', texModule.escapeTex('a & b % c $ d # e _ f { g } h ~ i ^ j \\ k'), 'a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k')
  check('and a backslash is escaped once, not twice', texModule.escapeTex('\\&'), '\\textbackslash{}\\&')
  check('an unknown style has no page setup and says so', await codeOf(() => texModule.buildTexReport({ markdown: '# t\n', style: 'harvard' })), 'UNKNOWN_STYLE')
  check('a URL that is not one is dropped from \\href', texModule.safeTexUrl('javascript:alert(1)'), '')

  // ---- `all` writes every ready format in one call
  const all = await call('rs_build', { slug: 'writer-check', format: 'all' })
  check('format=all writes every ready format', all.value.view.ok && FORMATS_READY.every((one) => all.value.text.includes('build/')), true)
  check('and names them all as ready', FORMATS_READY.length === FORMATS.length && FORMATS_READY.length === 7, true)
  const buildDir = await fsp.readdir(path.join(root, 'writer-check', 'build'))
  check('and each one is on disk with the report', ['paper.md', 'paper.docx', 'paper.html', 'paper.tex', 'references.ris', 'references.bib', 'references.enw', 'build.json'].every((name) => buildDir.includes(name)), true)

  const capabilities = await call('rs_open', { action: 'capabilities' })
  check('rs_open action=capabilities answers', capabilities.value.view.ok, true)
  check('and names the ready formats', capabilities.value.text.includes('md, ris, bib, enw'), true)
  check('and the document syntax', capabilities.value.text.includes('{#c0142}'), true)
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------
{
  const { routes, dispose } = await harness(path.join(pkgDir, 'lib', 'index.js'))
  check('eight routes are registered', [...routes.keys()].sort().join(','), [
    '/api/dsh-research/artifact',
    '/api/dsh-research/build',
    '/api/dsh-research/file',
    '/api/dsh-research/gate',
    '/api/dsh-research/health',
    '/api/dsh-research/project',
    '/api/dsh-research/source',
    '/api/dsh-research/state',
  ].join(','))
  check(
    'every route is an exact path',
    [...routes.keys()].every((one) => !one.includes('*') && !one.includes(':') && !one.includes('{')),
    true,
  )
  check(
    'no route offers a method outside GET/HEAD/POST',
    [...routes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))),
    true,
  )
  check('the gate route is POST only', routes.get('/api/dsh-research/gate').methods.join(','), 'POST')
  check('the routes buffer their body', [...routes.values()].every((route) => route.requestBody === 'buffered'), true)

  const get = (routePath, query = '') => routes.get(routePath).fetch(new Request('http://x' + routePath + query, { method: 'GET' }))
  const post = (body) =>
    routes.get('/api/dsh-research/gate').fetch(
      new Request('http://x/api/dsh-research/gate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )

  const state = await get('/api/dsh-research/state')
  check('GET state answers 200', state.status, 200)
  check('and refuses to be cached', state.headers.get('cache-control'), 'no-store')
  check('and is JSON', String(state.headers.get('content-type')).startsWith('application/json'), true)
  check('and carries the runs', (await state.json()).runs.length >= 2, true)

  const project = await get('/api/dsh-research/project', '?slug=ai-higher-ed-qa')
  check('GET project answers 200', project.status, 200)
  check('and carries the gates', (await project.json()).gates.length, 2)
  const missing = await get('/api/dsh-research/project', '?slug=nope-not-here')
  check('GET project on a missing run is 400', missing.status, 400)
  check('with a code a caller can switch on', (await missing.json()).code, 'UNKNOWN_RUN')

  const health = await get('/api/dsh-research/health')
  const healthBody = await health.json()
  check('GET health answers 200', health.status, 200)
  check('and publishes the refusal codes', healthBody.codes.length > 10, true)
  check('and the codes are the ones the code throws', healthBody.codes.includes('REASON_REQUIRED'), true)

  const answered = await post({
    slug: 'tool-check',
    id: 'g2-intake',
    value: 'no_experiments_declared',
    text: 'Nothing was run - this is a desk review.',
  })
  check('POST gate answers 200', answered.status, 200)
  check('and returns the stored answer', (await answered.json()).answer.text.startsWith('Nothing was run'), true)

  const badOption = await post({ slug: 'tool-check', id: 'g1-rq', value: 'nope' })
  check('POST gate on an option the gate does not offer is 400', badOption.status, 400)
  check('and says VALUE_INVALID', (await badOption.json()).code, 'VALUE_INVALID')

  const missingField = await post({ slug: 'tool-check', id: 'g1-rq' })
  check('POST gate with a missing field is 400', missingField.status, 400)
  check('and names the field', (await missingField.json()).message.includes('`value`'), true)

  const notJson = await post('not json at all')
  check('POST gate with a non-JSON body is 400', notJson.status, 400)
  check('and says BAD_BODY', (await notJson.json()).code, 'BAD_BODY')
  check('POST gate with a JSON array is 400', (await post([1, 2, 3])).status, 400)

  // A second answer for the same gate is what protects the ledger.
  const again = await post({ slug: 'tool-check', id: 'g2-intake', value: 'no_experiments_declared', text: 'again' })
  check('the route refuses a second answer', again.status, 400)
  check('with GATE_ALREADY_ANSWERED', (await again.json()).code, 'GATE_ALREADY_ANSWERED')

  // -------------------------------------------------------------------------
  // The file route: the person's own edit, and the verdict that comes with it
  // -------------------------------------------------------------------------
  const fileGet = (query) => get('/api/dsh-research/file', query)
  const filePost = (body) =>
    routes.get('/api/dsh-research/file').fetch(
      new Request('http://x/api/dsh-research/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    )
  const opened = await fileGet('?slug=writer-check&file=doc/sections/results.md')
  check('GET file reads a run\'s own text file', opened.status, 200)
  check('and hands back the text', (await opened.json()).text.includes('raised completion'), true)

  const saved = await filePost({ slug: 'writer-check', file: 'doc/sections/results.md', text: '## Results\n\n[A person typed this sentence.]{#c0001}\n' })
  const savedBody = await saved.json()
  check('POST file saves it', saved.status, 200)
  // The verdict is the point: a human edit is allowed and CHECKED, so the panel
  // shows what the edit did to the document's agreement with the ledger.
  check('and answers with the structure verdict', savedBody.structure !== undefined && typeof savedBody.structure.ok === 'boolean', true)
  check('which counts the claims that are still recorded', savedBody.structure.claims >= 1, true)
  const onDisk = await fsp.readFile(path.join(root, 'writer-check', 'doc', 'sections', 'results.md'), 'utf8')
  check('and the file on disk is what was typed', onDisk.includes('A person typed this sentence'), true)

  const escaped = await filePost({ slug: 'writer-check', file: '../RUN.json', text: 'x' })
  check('a path out of the run is refused', escaped.status, 400)
  check('with PATH_ESCAPE', (await escaped.json()).code, 'BAD_PATH')
  check('a ledger is not hand-editable', (await filePost({ slug: 'writer-check', file: 'ledger/claims.jsonl', text: 'x' })).status, 400)
  check('and nor is a non-text file', (await filePost({ slug: 'writer-check', file: 'build/paper.md', text: 'x' })).status, 400)
  check('a save with no text field is refused', (await filePost({ slug: 'writer-check', file: 'doc/paper.md' })).status, 400)
  check('GET file refuses a binary by name', (await fileGet('?slug=ai-higher-ed-qa&file=sources/binary.pdf')).status, 400)

  dispose()
  check('the disposer unregisters every route', routes.size, 0)
}

// ---------------------------------------------------------------------------
// Activation, including a profile with no connection service
// ---------------------------------------------------------------------------
{
  const { module } = await harness(path.join(pkgDir, 'lib', 'index.js'))
  check('the row is named', module.name, 'dsh-research')
  check('the row declares what it injects', module.inject.join(','), 'connection,tools')

  const registered = []
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    get: () => undefined,
    effect: (fn) => fn(),
    tools: { register: (tool) => (registered.push(tool.name), () => {}) },
  }
  module.apply(ctx)
  check('activation registers the three tools', registered.sort().join(','), [...TOOL_NAMES].sort().join(','))
  check('and does not throw without a connection service', true)
}

// ---------------------------------------------------------------------------
// The document dialect
// ---------------------------------------------------------------------------
{
  const spans = findClaimSpans('A sentence. [Completion rose by 12 points.]{#c0007} Another [one]{#c0008}.')
  check('spans are found in reading order', spans.map((span) => span.id).join(','), 'c0007,c0008')
  check('and the claim text comes from the span', spans[0].text, 'Completion rose by 12 points.')
  check('a nested bracket is not a span', findClaimSpans('[a [b] c]{#c0009}').length, 0)
  check('a short id is not a span', findClaimSpans('[x]{#c12}').length, 0)
  check('and a malformed marker is reported', syntaxModule.findBrokenClaimMarkers('[x]{#c12}').length, 1)

  const cites = findCitations('As shown [@smith2024, p. 7] and again [@jones2023; @smith2024] but not [this].')
  check('citations are found, prose brackets are not', cites.length, 2)
  check('the first carries its locator', cites[0].cites[0].key + '/' + cites[0].cites[0].locator, 'smith2024/p. 7')
  check('the second carries both keys', cites[1].cites.map((one) => one.key).join(','), 'jones2023,smith2024')
  check('a suppressed author is read', findCitations('[-@smith2024]')[0].cites[0].suppressAuthor, true)
  check('a bracket with no @ is not a citation', findCitations('[a note]').length, 0)
  check('a footnote is not a citation', findCitations('[^1]').length, 0)
  // The quiet failure this closes: `[see @key]` is Pandoc-legal and this dialect
  // is stricter, so it must NOT vanish - it is reported by name instead.
  check('a citation-shaped bracket that does not parse is REPORTED', syntaxModule.findBrokenCitations('[see @smith2024]').length, 1)
  check('and a real citation is not reported as broken', syntaxModule.findBrokenCitations('[@smith2024, p. 7]').length, 0)
  check('and neither is a plain bracket', syntaxModule.findBrokenCitations('[note]').length, 0)
  check('and neither is a footnote', syntaxModule.findBrokenCitations('[^1]').length, 0)

  check('a page locator needs a page', await codeOf(() => normalizeLocator({ kind: 'page' })), 'BAD_LOCATOR')
  check('a quote locator needs the words', await codeOf(() => normalizeLocator({ kind: 'quote' })), 'BAD_LOCATOR')
  check('an unknown locator kind is refused', await codeOf(() => normalizeLocator({ kind: 'vibes', page: 1 })), 'BAD_LOCATOR')
  check('a good locator survives', normalizeLocator({ kind: 'quote', quote: 'rose by 12 points', page: 7 }).page, 7)

  check('claim ids are allocated above the highest', nextClaimId([{ id: 'c0003' }, { id: 'c0011' }]), 'c0012')
  check('and a fresh run starts at c0001', nextClaimId([]), 'c0001')
  check('a key is refused when it is not one', await codeOf(() => parseKey('Smith 2024!')), 'BAD_KEY')
  check('and lowercased when it is', parseKey('Smith-2024'), 'smith-2024')
}

// ---------------------------------------------------------------------------
// The ledgers: append-only, one row per revision, and a wording change that
// invalidates the verification that belonged to the old wording
// ---------------------------------------------------------------------------
{
  const dir = path.join(root, 'ledger-check')
  await createRun({ root, slug: 'ledger-check', title: 'Ledger check', kind: 'paper' })

  const first = await appendSource(dir, { key: 'smith2024', kind: 'journal-article', title: 'The effect of X on Y', authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'Journal Name' }, undefined)
  check('a source is appended', first.changed, true)
  check('at revision 1', first.record.revision, 1)
  const again = await appendSource(dir, { key: 'smith2024', kind: 'journal-article', title: 'The effect of X on Y', authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'Journal Name' }, undefined)
  check('the same source twice is NOT appended twice', again.changed, false)
  const corrected = await appendSource(dir, { key: 'smith2024', kind: 'journal-article', title: 'The effect of X on Y', authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'Journal Name', pages: '45-67' }, undefined)
  check('a correction is a new revision', corrected.record.revision, 2)
  const { rows: sourceRows, current: sourceCurrent } = await readSources(dir)
  check('both source revisions are kept', sourceRows.length, 2)
  check('and the current one is the last', sourceCurrent[0].pages, '45-67')
  check('a source with no title is refused', await codeOf(() => appendSource(dir, { key: 'x', title: '  ' })), 'BAD_SOURCE')
  check('and an unknown kind is refused', await codeOf(() => appendSource(dir, { key: 'y', title: 't', kind: 'pamphlet' })), 'BAD_SOURCE')

  const claim = await appendClaim(dir, { id: 'c0001', text: 'Completion rose by 12 points.', section: 'results', strength: 'causal', sources: [{ key: 'smith2024', locator: { kind: 'page', page: 7 } }] }, undefined)
  check('a claim enters the ledger unverified', claim.row.status + '/' + claim.row.tier, 'unverified/null')
  const rewrite = await appendClaim(dir, { id: 'c0001', text: 'Completion rose by 12 points.', section: 'results', strength: 'causal', sources: [{ key: 'smith2024', locator: { kind: 'page', page: 7 } }] }, undefined)
  check('an unchanged claim is not appended twice', rewrite.added, false)
  const edited = await appendClaim(dir, { id: 'c0001', text: 'Completion rose by 25 points.', section: 'results', strength: 'causal', sources: [{ key: 'smith2024', locator: { kind: 'page', page: 7 } }] }, undefined)
  check('an edited claim IS appended, and says it invalidated the verdict', edited.added && edited.invalidated, true)
  check('the new wording is what the ledger now holds', edited.row.text, 'Completion rose by 25 points.')
  const moved = await appendClaim(dir, { id: 'c0002', text: 'A second sentence.', section: 'intro', strength: 'descriptive', sources: [] }, undefined)
  check('a claim with no source is still recorded', moved.row.sources.length, 0)
  check('and it is counted as unverified', statusCounts([moved.row]).unverified, 1)

  const folded = foldLatest([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'a', v: 2 }], 'id')
  check('folding keeps the last row per id', folded.map((row) => row.id + row.v).join(','), 'b1,a2')

  // A ledger that cannot be parsed is a REFUSAL naming the line, never a dropped
  // row: a claim that vanishes silently is a claim the document still cites.
  await fsp.writeFile(path.join(dir, 'ledger', 'broken.jsonl'), '{"ok":1}\nnot json\n', 'utf8')
  check('a malformed ledger line is refused by line number', await codeOf(() => ledgerModule.readJsonl(path.join(dir, 'ledger', 'broken.jsonl'))), 'MALFORMED_LEDGER')
}

// ---------------------------------------------------------------------------
// The document: assembly, structure, and the two draft modes
// ---------------------------------------------------------------------------
{
  const dir = path.join(root, 'ledger-check')
  const docDir = path.join(dir, 'doc')
  await fsp.mkdir(path.join(docDir, 'sections'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'plan', 'outline.md'), '- intro: Introduction\n- results: Results\n', 'utf8')
  await fsp.writeFile(path.join(docDir, 'sections', 'results.md'), '## Results\n\n[Completion rose by 25 points.]{#c0001}\n', 'utf8')
  await fsp.writeFile(path.join(docDir, 'sections', 'intro.md'), '## Introduction\n\nSee [@smith2024, p. 7] for the background.\n', 'utf8')
  await fsp.writeFile(path.join(docDir, 'sections', 'notes.md'), '## Notes\n\nNot in the outline.\n', 'utf8')

  const assembled = await assembleDocument(dir)
  check('sections are assembled in OUTLINE order', assembled.parts.map((one) => one.slug).join(','), 'intro,results,notes')
  check('a section the outline does not name is APPENDED, not dropped', assembled.notes.some((note) => note.includes('notes.md')), true)
  check('and the outline\'s title becomes the heading when the file has none', assembled.text.includes('## Introduction'), true)
  check('the outline is read as slugs and titles', docModule.parseOutline('- a: A\n- b: B\nprose\n').length, 2)

  const sections = sectionsOf(assembled.text)
  check('headings become sections', sections.map((one) => one.slug).join(','), 'introduction,results,notes')
  check('and a section counts its own claims', sections.find((one) => one.slug === 'results').claims.join(','), 'c0001')
  check('words are counted', wordCount('one two three') === 3, true)

  const { current: claims } = await readClaims(dir)
  const { current: sources } = await readSources(dir)
  const byKey = sourcesByKey(sources)
  const scan = scanDocument(assembled.text)
  const structure = validateStructure({ scan, claims, sourcesByKey: byKey })
  check('r0 passes when the document agrees with its ledger', structure.ok, true)

  const orphaned = validateStructure({ scan, claims: claims.filter((row) => row.id !== 'c0001'), sourcesByKey: byKey })
  check('a span with no ledger row is an ERROR', orphaned.errors.map((one) => one.code).join(','), 'span-unrecorded')
  const ghost = validateStructure({ scan, claims: [...claims, { id: 'c0099', text: 'gone', sources: [] }], sourcesByKey: byKey })
  check(
    'a ledger row with no span is a WARNING, not an error',
    ghost.ok && [...new Set(ghost.warnings.map((one) => one.code))].sort().join(','),
    'claim-orphan,claim-unsourced',
  )
  const unknown = validateStructure({ scan: scanDocument('See [@nope2020].'), claims: [], sourcesByKey: byKey })
  check('a citation with no source is an ERROR', unknown.errors.map((one) => one.code).join(','), 'unknown-source')
  const broken = validateStructure({ scan: scanDocument('A claim [x]{#c12}.'), claims: [], sourcesByKey: byKey })
  check('a malformed marker is an ERROR', broken.errors.some((one) => one.code === 'broken-marker'), true)

  const style = stylesModule.styleOf('apa7')
  const watermark = renderBody({ text: assembled.text, style, claimsById: claimsById(claims), sourcesByKey: byKey, draft: 'watermark', scan })
  check('a citation is replaced by the style\'s in-text form', watermark.body.includes('(Smith, 2024, p. 7)'), true)
  check('and the source is marked as used', watermark.usedKeys.join(','), 'smith2024')
  check('a watermarked claim keeps its endnote', watermark.body.includes('rose by 25 points.[^'), true)
  check('and the endnote names its status', watermark.footnotes.some((note) => note.includes('unverified')), true)
  const clean = renderBody({ text: assembled.text, style, claimsById: claimsById(claims), sourcesByKey: byKey, draft: 'clean', scan })
  check('a clean claim marker is stripped entirely', clean.body.includes('{#c0001}'), false)
  check('and leaves the sentence as prose', clean.body.includes('Completion rose by 25 points.'), true)
  check('with no endnote at all', clean.footnotes.length, 0)

  const references = renderReferences({ style, sourcesByKey: byKey, usedKeys: watermark.usedKeys, numbers: watermark.numbers })
  check('the reference list is headed by the style', references.heading, 'References')
  check('and holds the cited source', references.entries.map((one) => one.key).join(','), 'smith2024')
  check('formatted from the RECORD, not from the model', references.entries[0].plain.startsWith('Smith, J.'), true)
  check('with the journal in italic runs', references.entries[0].runs.some((run) => run.italic === true), true)

  const state = await readRunState(dir)
  const composed = composeMarkdown(state, style, 'watermark', [])
  check('a draft says it is a draft', composed.text.startsWith('> **DRAFT'), true)
  check('and carries the reference list', composed.text.includes('## References'), true)
  check('and the endnotes after it', /\[\^1\]: claim c0001/.test(composed.text), true)
  const cleanComposed = composeMarkdown(state, style, 'clean', [])
  check('a clean build has no banner', cleanComposed.text.startsWith('> **DRAFT'), false)
}

// ---------------------------------------------------------------------------
// The build, and the gate a clean one opens
// ---------------------------------------------------------------------------
{
  const dir = path.join(root, 'ledger-check')
  const draft = await runBuild({ runDir: dir, format: 'md', draft: 'watermark', styleId: 'apa7', slug: 'ledger-check', integrityAnswered: false })
  check('a watermarked build always builds', draft.outputs.map((one) => one.path).join(','), 'build/paper.md')
  check('and records the output hash', /^[0-9a-f]{64}$/.test(draft.outputs[0].sha256), true)
  check('the report carries the claim statuses', draft.report.claims.total, 2)
  check('and what the structure check found', draft.report.structure.ok, true)
  const written = await fsp.readFile(path.join(dir, 'build', 'paper.md'), 'utf8')
  check('the artifact is on disk', written.includes('## References'), true)
  const reportOnDisk = JSON.parse(await fsp.readFile(path.join(dir, 'build', 'build.json'), 'utf8'))
  check('and the report is stored beside it', reportOnDisk.outputs.length, 1)
  check('with the sha256 of the document it was built from', /^[0-9a-f]{64}$/.test(reportOnDisk.source.sha256), true)

  check(
    'a clean build is refused while the integrity gate is unanswered',
    await codeOf(() => runBuild({ runDir: dir, format: 'md', draft: 'clean', styleId: 'apa7', slug: 'ledger-check', integrityAnswered: false })),
    'GATE_UNANSWERED',
  )
  check('a format that is not one of ours is refused by name', await codeOf(() => runBuild({ runDir: dir, format: 'pdf', draft: 'watermark', styleId: 'apa7', slug: 'ledger-check' })), 'BAD_FORMAT')
  check('and an unknown style is refused', await codeOf(() => runBuild({ runDir: dir, format: 'md', draft: 'watermark', styleId: 'harvard', slug: 'ledger-check' })), 'UNKNOWN_STYLE')
  check('an empty document is refused rather than built empty', await codeOf(() => runBuild({ runDir: path.join(root, 'tool-check'), format: 'md', draft: 'watermark', styleId: 'apa7', slug: 'tool-check' })), 'DOC_EMPTY')

  // A claim a check found unsupported must block a CLEAN build while a draft
  // still builds - that asymmetry is the whole reason the two modes exist.
  await ledgerModule.recordVerdict(dir, { id: 'c0001', status: 'unsupported', tier: 'r3-support', reason: 'the source reports no such effect', judge: 'check-research-node' }, undefined)
  check('a verdict records who judged it', (await readClaims(dir)).current.find((row) => row.id === 'c0001').judge, 'check-research-node')
  check('and a verdict for a claim that does not exist is refused', await codeOf(() => ledgerModule.recordVerdict(dir, { id: 'c0404', status: 'supported', judge: 'x' })), 'UNKNOWN_CLAIM')
  check('and an invented status is refused', await codeOf(() => ledgerModule.recordVerdict(dir, { id: 'c0001', status: 'pretty-sure', judge: 'x' })), 'BAD_STATUS')
  check('and a verdict with no judge is refused', await codeOf(() => ledgerModule.recordVerdict(dir, { id: 'c0001', status: 'supported', judge: '  ' })), 'BAD_STATUS')
  check(
    'a clean build refuses to publish an unsupported claim',
    await codeOf(() => runBuild({ runDir: dir, format: 'md', draft: 'clean', styleId: 'apa7', slug: 'ledger-check', integrityAnswered: true })),
    'BLOCKING_CLAIMS',
  )
  check('while a draft still builds', (await runBuild({ runDir: dir, format: 'md', draft: 'watermark', styleId: 'apa7', slug: 'ledger-check' })).outputs.length, 1)

  const exports = await runBuild({ runDir: dir, format: 'bib', draft: 'watermark', styleId: 'apa7', slug: 'ledger-check' })
  check('a bibliography export is a real file', exports.outputs[0].path, 'build/references.bib')
  const bib = await fsp.readFile(path.join(dir, 'build', 'references.bib'), 'utf8')
  check('holding the source', bib.includes('smith2024'), true)
}

// ---------------------------------------------------------------------------
// The ladder: the two rungs a file can run, and the two a reader must
// ---------------------------------------------------------------------------
{
  check('a line break inside a word is removed before searching', verifyModule.normalizeForSearch('comple-\ntion rose'), 'completion rose')
  check('and curly quotes are straightened', verifyModule.normalizeForSearch('the \u201Ceffect\u201D'), 'the "effect"')
  check('and an en dash is a hyphen', verifyModule.normalizeForSearch('45\u201367'), '45-67')
  check('a quote is found wherever it sits', verifyModule.locateQuote('the text says completion rose by 12 points here', 'COMPLETION  rose by 12 points').found, true)
  check('and a miss is a miss', verifyModule.locateQuote('nothing like it', 'completion rose').found, false)
  check('a title is reduced to its significant words', verifyModule.titleWords('Effects of a programme on completion').join(','), 'programme,completion')
  check('a title of stopwords alone has none, and says so rather than matching anything', verifyModule.titleWords('The Effect of X on Y: A Study').length, 0)
  check('a title with no significant words says so', verifyModule.titleWords('the of a').length, 0)
  check('complete coverage is what makes a miss mean something', verifyModule.textIsComplete({ coverage: 1 }) && !verifyModule.textIsComplete({ coverage: null }) && !verifyModule.textIsComplete({ coverage: 0.4 }), true)
}

{
  const exec2 = { agent: { session: { meta: { cwd: workspace } } } }
  const log = { warn() {}, info() {}, debug() {} }
  const tools2 = buildTools({ env, workspace, log })
  const call2 = async (name, args) => {
    const tool = tools2.find((one) => one.name === name)
    const value = await tool.execute(args, exec2)
    return { value, problems: [...schemaErrors(tool.output.schema, value, name), ...losslessErrors(value, name)] }
  }

  await call2('rs_new', { slug: 'ladder-check', title: 'A checked run', kind: 'paper', instruction: 'Check this properly.' })
  await answerGate({ root, slug: 'ladder-check', id: 'g1-rq', value: 'confirm' })
  await answerGate({ root, slug: 'ladder-check', id: 'g2-intake', value: 'no_experiments_declared', text: 'Nothing was run.' })

  const SOURCE_TEXT = 'Effects of a programme on completion. The study found that completion rose by 25 points after the programme began, and that the effect persisted for two years.'
  const ingested = await call2('rs_cite', {
    slug: 'ladder-check',
    action: 'add',
    key: 'smith2024',
    record: { kind: 'journal-article', title: 'Effects of a programme on completion', authors: [{ family: 'Smith', given: 'J.' }], year: '2024', container: 'Journal Name', pages: '45-67' },
    source: 'crossref',
    text: SOURCE_TEXT,
    coverage: 1,
  })
  check('a source with text and full coverage is ingested', ingested.value.view.ok, true)
  const noText = await call2('rs_cite', { slug: 'ladder-check', action: 'add', key: 'bare2024', record: { kind: 'journal-article', title: 'A bare record', year: '2024', container: 'J' }, source: 'author' })
  check('and one with no text at all', noText.value.view.ok, true)
  const mismatched = await call2('rs_cite', {
    slug: 'ladder-check',
    action: 'add',
    key: 'wrong2024',
    record: { kind: 'journal-article', title: 'A completely different title about whales', year: '2024', container: 'J' },
    source: 'author',
    text: 'This paper is about completion rates and nothing else at all.',
    coverage: 1,
  })
  check('and one whose title is not in its own text', mismatched.value.view.ok, true)

  const written = await call2('rs_write', {
    slug: 'ladder-check',
    section: 'results',
    text: '## Results\n\n[Completion rose by 25 points.]{#c0001} [Completion rose by 99 points.]{#c0002} [It doubled.]{#c0003}\n',
    claims: [
      { id: 'c0001', strength: 'associational', sources: [{ key: 'smith2024', locator: { kind: 'quote', quote: 'completion rose by 25 points' } }] },
      { id: 'c0002', strength: 'causal', sources: [{ key: 'smith2024', locator: { kind: 'quote', quote: 'completion rose by 99 points' } }] },
      { id: 'c0003', strength: 'causal', sources: [{ key: 'bare2024', locator: { kind: 'quote', quote: 'it doubled' } }] },
    ],
  })
  check('three claims are written', written.value.view.ok, true)

  const recorded = await call2('rs_verify', { slug: 'ladder-check', action: 'record' })
  check('rs_verify conforms', recorded.problems.join(' | '), '')
  check('and finds the quote that IS there', recorded.value.text.includes('1 quote(s) found'), true)
  // The distinction the whole design turns on: a miss is only a miss when the text
  // is known to be complete.
  check('a miss in complete text is a locate-miss', recorded.value.text.includes('locate-miss'), true)
  check('and a source with no text is UNCHECKABLE, never a pass', recorded.value.text.includes('could not be checked'), true)
  check('and a title that is not in its own text is a title-mismatch', recorded.value.text.includes('title-mismatch'), true)

  const after = await readClaims(path.join(root, 'ladder-check'))
  const located = after.current.find((row) => row.id === 'c0001')
  check('the located claim moves to `located` at r2', located.status + '/' + located.tier, 'located/r2-locate')
  check('and carries the context it was found in', typeof located.locatedContext === 'string' && located.locatedContext.includes('completion rose by 25 points'), true)
  check('the missing quote leaves the claim unverified', after.current.find((row) => row.id === 'c0002').status, 'unverified')
  check('with the finding recorded on it', after.current.find((row) => row.id === 'c0002').findings.some((one) => one.code === 'locate-miss'), true)

  const report = await call2('rs_verify', { slug: 'ladder-check', action: 'report' })
  check('the report names all four rungs', ['r1-record', 'r2-locate', 'r3-support', 'r4-audit'].every((rung) => report.value.text.includes(rung)), true)
  check('and says r3 needs a reader rather than claiming it ran', report.value.text.includes('needs-a-reader') && report.value.text.includes('waiting on a reader'), true)
  check('and writes nothing', report.value.text.includes('changed nothing on disk'), true)

  // ---- the two rungs a file cannot do
  check('a verdict with no judge is refused', (await call2('rs_verify', { slug: 'ladder-check', action: 'support', verdicts: [{ id: 'c0001', verdict: 'supported', reason: 'x' }] })).value.view.code, 'BAD_JUDGE')
  check(
    'a verdict with no reason is refused',
    (await call2('rs_verify', { slug: 'ladder-check', action: 'support', judge: 'the session model', verdicts: [{ id: 'c0001', verdict: 'supported' }] })).value.view.code,
    'BAD_VERDICT',
  )
  check(
    'an invented verdict is refused',
    (await call2('rs_verify', { slug: 'ladder-check', action: 'support', judge: 'the session model', verdicts: [{ id: 'c0001', verdict: 'pretty-sure', reason: 'x' }] })).value.view.code,
    'BAD_VERDICT',
  )
  // A claim whose source carries no locator has no passage that was read.
  //
  // This text is written with an ANCHOR LINK rather than a claim span on purpose:
  // the probe that found the `textIsComplete` bug also found this one, and the run
  // must now report it as a broken marker rather than letting a person believe a
  // sentence is tracked when the ledger has never heard of it.
  const anchor = await call2('rs_write', {
    slug: 'ladder-check',
    section: 'notes',
    text: '## Notes\n\n[Nothing points anywhere.](#c0004)\n',
    claims: [{ id: 'c0004', strength: 'descriptive', sources: [{ key: 'smith2024' }] }],
  })
  check('a claim written as an anchor link is refused as span-less', anchor.value.view.code, 'CLAIM_SPAN_MISSING')
  check('and the text is reported as tracking nothing', syntaxModule.findBrokenClaimMarkers('[x](#c0004)').length, 1)
  check('with the reason naming the right syntax', syntaxModule.findBrokenClaimMarkers('[x](#c0004)')[0].why.includes('{#c0142}'), true)

  const noLocator = await call2('rs_write', {
    slug: 'ladder-check',
    section: 'notes',
    text: '## Notes\n\n[Nothing points anywhere.]{#c0004}\n',
    claims: [{ id: 'c0004', strength: 'descriptive', sources: [{ key: 'smith2024' }] }],
  })
  check('a claim with no locator can be written', noLocator.value.view.ok, true)
  check(
    'but it cannot be JUDGED - evidence first',
    (await call2('rs_verify', { slug: 'ladder-check', action: 'support', judge: 'the session model', verdicts: [{ id: 'c0004', verdict: 'supported', reason: 'x' }] })).value.view.code,
    'STATUS_REQUIRES_EVIDENCE',
  )
  check(
    'an audit before an r3 verdict is refused',
    (await call2('rs_verify', { slug: 'ladder-check', action: 'audit', judge: 'the devil', verdicts: [{ id: 'c0002', verdict: 'contradicted', reason: 'x' }] })).value.view.code,
    'RUNG_ORDER',
  )

  const supported = await call2('rs_verify', {
    slug: 'ladder-check',
    action: 'support',
    judge: 'the session model',
    verdicts: [{ id: 'c0001', verdict: 'supported', strengthVerdict: 'aligned', reason: 'the passage states the rise in those words', passage: 'completion rose by 25 points' }],
  })
  check('a well-formed verdict is recorded', supported.value.view.ok, true)
  check('and names its rung', supported.value.text.includes('r3-support'), true)
  check('and its judge', supported.value.text.includes('the session model'), true)
  const judged = (await readClaims(path.join(root, 'ladder-check'))).current.find((row) => row.id === 'c0001')
  check('the claim now carries the verdict, the strength and the passage', judged.status === 'supported' && judged.strengthVerdict === 'aligned' && judged.reason.includes('completion rose by 25 points'), true)
  const audited = await call2('rs_verify', {
    slug: 'ladder-check',
    action: 'audit',
    judge: 'a devil\'s advocate subagent',
    verdicts: [{ id: 'c0001', verdict: 'partially-supported', reason: 'the passage shows an association, and the sentence says nothing about cause' }],
  })
  check('an audit after an r3 verdict is recorded at r4', audited.value.view.ok && audited.value.text.includes('r4-audit'), true)

  // A wording change clears the verdict AND the findings: both were about a
  // sentence that no longer exists.
  const edited = await call2('rs_write', {
    slug: 'ladder-check',
    section: 'results',
    text: '## Results\n\n[Completion rose by 26 points.]{#c0001}\n',
    claims: [{ id: 'c0001', strength: 'associational', sources: [{ key: 'smith2024', locator: { kind: 'quote', quote: 'completion rose by 25 points' } }] }],
  })
  check('an edit that changes the sentence clears the verdict', edited.value.text.includes('RE-VERIFICATION NEEDED'), true)
  const cleared = (await readClaims(path.join(root, 'ladder-check'))).current.find((row) => row.id === 'c0001')
  check('the status is back to unverified', cleared.status, 'unverified')
  check('and the findings went with it', cleared.findings.length, 0)
}

// ---------------------------------------------------------------------------
// The review: the panel, the two columns, and the concession protocol
// ---------------------------------------------------------------------------
{
  const exec3 = { agent: { session: { meta: { cwd: workspace } } } }
  const log3 = { warn() {}, info() {}, debug() {} }
  const tools3 = buildTools({ env, workspace, log: log3 })
  const call3 = async (name, args) => {
    const tool = tools3.find((one) => one.name === name)
    const value = await tool.execute(args, exec3)
    return { value, problems: [...schemaErrors(tool.output.schema, value, name), ...losslessErrors(value, name)] }
  }

  check('reviewing a run with no document is refused', (await call3('rs_review', { slug: 'tool-check', action: 'panel', items: [{ role: 'methodology', concern: 'x' }] })).value.view.code, 'DOC_EMPTY')
  check('a panel with no items is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'panel' })).value.view.code, 'BAD_FINDING')

  const panel = await call3('rs_review', {
    slug: 'ladder-check',
    action: 'panel',
    items: [
      { role: 'methodology', concern: 'The claim about completion rests on one study.', severity: 'major', criterion: 'method', evidence: '§results', suggestion: 'Add the second study already in the ledger.' },
      { role: 'journal-fit', concern: 'The framing speaks to practitioners rather than to the journal.', severity: 'minor', criterion: 'fit', evidence: 'c0001' },
      { role: 'domain', concern: 'A key definition is missing.', severity: 'note', criterion: 'clarity' },
    ],
  })
  check('the panel records three findings', panel.value.view.ok && panel.value.text.includes('f0001') && panel.value.text.includes('f0003'), true)
  check('and numbers them in one round', panel.problems.join(' | '), '')
  check('an invented role is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'panel', items: [{ role: 'vibes', concern: 'x' }] })).value.view.code, 'BAD_ROLE')
  check('a finding with no concern is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'panel', items: [{ role: 'domain' }] })).value.view.code, 'BAD_FINDING')
  check('an invented severity is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'panel', items: [{ role: 'domain', concern: 'x', severity: 'fatal' }] })).value.view.code, 'BAD_SEVERITY')

  // ---- the author's answer, and the separate column it does NOT fill
  check('an answer to a finding that does not exist is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'answer', id: 'f9999', status: 'addressed', reply: 'x' })).value.view.code, 'UNKNOWN_FINDING')
  check('an answer with no reply is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'answer', id: 'f0001', status: 'addressed' })).value.view.code, 'BAD_REPLY')
  check('and "open" is not a status an answer may set', (await call3('rs_review', { slug: 'ladder-check', action: 'answer', id: 'f0001', status: 'open', reply: 'x' })).value.view.code, 'BAD_STATUS')
  const answered = await call3('rs_review', { slug: 'ladder-check', action: 'answer', id: 'f0001', status: 'addressed', reply: 'Added the second study to §results and cited it.' })
  check('a well-formed answer is recorded', answered.value.view.ok, true)
  check('and says it is not a verification', answered.value.text.includes('your words, not a verification'), true)

  // A re-review is a SEPARATE finding: verified=false is a normal answer.
  check('re-reviewing an unanswered concern is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'rereview', id: 'f0002', verified: true, reason: 'x' })).value.view.code, 'NOT_ANSWERED')
  check('a re-review with no reason is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'rereview', id: 'f0001', verified: true })).value.view.code, 'BAD_REPLY')
  const settled = await call3('rs_review', { slug: 'ladder-check', action: 'rereview', id: 'f0001', verified: false, reason: 'the second study was added to the prose but not cited, so the claim still rests on one source', by: 'a fresh reader' })
  check('a re-review that did NOT settle it is recorded as such', settled.value.view.ok && settled.value.text.includes('NOT settled'), true)
  check('and says why', settled.value.text.includes('not cited'), true)

  // ---- the concession protocol, which is the reason this tool exists
  check('an attack needs a concern', (await call3('rs_review', { slug: 'ladder-check', action: 'attack', severity: 'major' })).value.view.code, 'BAD_FINDING')
  const attack = await call3('rs_review', { slug: 'ladder-check', action: 'attack', concern: 'The causal wording is not supported by an observational study.', evidence: 'c0001' })
  check('an attack is recorded', attack.value.view.ok, true)
  check('a concession with no score is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'x', reply: 'y' })).value.view.code, 'BAD_SCORE')
  check('a score outside 1-5 is refused', (await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'x', reply: 'y', score: 9 })).value.view.code, 'BAD_SCORE')
  // The threshold: a rebuttal that did not answer the attack directly with
  // evidence does not change the advocate's position.
  const below = await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'The causal wording is not supported.', reply: 'We believe the study design is adequate.', score: 3 })
  check('a rebuttal below the threshold does NOT earn a concession', below.value.view.code, 'CONCESSION_BELOW_THRESHOLD')
  check('and the refusal tells the advocate to hold position', below.value.text.includes('HOLD POSITION'), true)
  const earned = await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'The causal wording is not supported.', reply: 'The sentence now says "associated with" and cites the second study, which the reader can check.', score: 5 })
  check('a scored rebuttal at or above the threshold is recorded', earned.value.view.ok && earned.value.text.includes('5/5'), true)
  check('and the refusal of a second concession follows', (await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'x', reply: 'y', score: 5 })).value.view.code, 'CONSECUTIVE_CONCESSION')
  check('while an attack in between reopens it', (await call3('rs_review', { slug: 'ladder-check', action: 'attack', concern: 'The sample is not described.', severity: 'minor' })).value.view.ok, true)
  check('so a further concession is allowed', (await call3('rs_review', { slug: 'ladder-check', action: 'concede', concern: 'The sample is not described.', reply: 'Section 3.1 now reports N, the sampling frame and the response rate.', score: 4 })).value.view.ok, true)

  // ---- the matrix, and the pattern warning
  const read = await call3('rs_review', { slug: 'ladder-check', action: 'read' })
  check('the matrix reports the author\'s answer and the re-review separately', read.value.text.includes('| verified |') && read.value.text.includes('NO'), true)
  check('and says a concern is not closed by an answer alone', read.value.text.includes('not closed by an answer alone'), true)
  check('and reports the advocate\'s rate', read.value.text.includes('rate 50%'), true)
  check('and says the sycophancy pattern out loud at that rate', read.value.text.includes('Conceding is not the same as being answered'), true)

  const written = await call3('rs_review', { slug: 'ladder-check', action: 'write' })
  check('the review writes a panel report and the matrix', written.value.view.ok && written.value.text.includes('traceability.md'), true)
  const panelFile = await fsp.readFile(path.join(root, 'ladder-check', 'reviews', 'panel-r1.md'), 'utf8').catch(() => null)
  check('the report is on disk with the round in its name', panelFile !== null && panelFile.includes('round 1'), true)
  const matrixFile = await fsp.readFile(path.join(root, 'ladder-check', 'reviews', 'traceability.md'), 'utf8').catch(() => null)
  check('and the matrix is on disk', matrixFile !== null && matrixFile.includes('f0002'), true)

  // ---- the pure pieces
  check('a concern with a pipe in it cannot break the matrix table', reviewModule.renderMatrix([{ id: 'f0001', round: 1, kind: 'finding', role: 'domain', severity: 'major', criterion: 'clarity', concern: 'a | b', status: 'open' }]).includes('a \\| b'), true)
  check('a finding defaults to major and evidence', reviewModule.normalizeFinding({ role: 'domain', concern: 'x' }, undefined).severity + '/' + reviewModule.normalizeFinding({ role: 'domain', concern: 'x' }, undefined).criterion, 'major/evidence')
  check('the matrix keeps the author\'s claim and the re-review apart', reviewModule.matrix([{ id: 'f0001', kind: 'finding', status: 'addressed', reply: 'done', verified: false }])[0].verified, 'NO')
  check('and an unverified concern says so rather than looking closed', reviewModule.matrix([{ id: 'f0001', kind: 'finding', status: 'addressed', reply: 'done' }])[0].verified, 'not re-reviewed')
  check('the threshold is the number the refusals use', reviewModule.CONCESSION_THRESHOLD, 4)
  check('every role, criterion and severity is an enum the tool publishes', reviewModule.REVIEW_ROLES.length + reviewModule.REVIEW_CRITERIA.length + reviewModule.REVIEW_SEVERITIES.length, 17)
}

// ---------------------------------------------------------------------------
// The panel's payload: bounded, one round trip, and the same run the tools see
// ---------------------------------------------------------------------------
{
  const detail = await projectDetail({ env, workspace, slug: 'ledger-check' })
  check(
    'the panel payload carries EXACTLY the keys the client was pinned to',
    Object.keys(detail).sort().join(','),
    'claims,document,files,gates,ledger,notes,outline,passport,run,sources,structure',
  )
  check('it carries the current claims, not the revisions', detail.claims.length, 2)
  check('and ledger keeps its null-means-absent meaning', typeof detail.ledger.claims === 'number' && detail.ledger.current.claims === detail.claims.length, true)
  check('a claim row carries its bindings as labels', Array.isArray(detail.claims[0].sources) && typeof detail.claims[0].status === 'string', true)
  check('a claim that nothing has checked says so', detail.claims.every((claim) => claim.tier === '' || typeof claim.tier === 'string'), true)
  check('a source row says whether it can be checked at all', detail.sources.some((source) => source.hasText === false), true)
  check('the outline counts the words and the citations', detail.outline.words > 0 && typeof detail.outline.citations === 'number', true)
  check('and lists its sections', detail.outline.sections.length >= 1, true)
  check('the structure chip is a verdict, not a promise', typeof detail.structure.ok === 'boolean' && Array.isArray(detail.structure.codes), true)

  // The cap is what keeps a 1500 ms poll cheap, and it must SAY it truncated
  // rather than quietly sending a short list.
  const many = { ...(await readClaims(path.join(root, 'ledger-check'))) }
  check('the panel caps each list', viewModule.MAX_PANEL_CLAIMS > 0 && viewModule.MAX_PANEL_SOURCES > 0, true)
  check('and a claim view truncates a long text with a marker', viewModule.claimView({ id: 'c0001', text: 'x'.repeat(900) }).text.length <= viewModule.CLAIM_TEXT_CHARS, true)
  check('a source view counts its bytes', viewModule.sourceView({ key: 'k', title: 't', files: [{ bytes: 10 }, { bytes: 5 }] }).bytes, 15)
  check('and survives a record with no authors at all', viewModule.sourceView({ key: 'k', title: 't' }).authors.length, 0)
  check('many claims fold to one row each', many.current.length, 2)
}

// ---------------------------------------------------------------------------
// The engine interfaces other modules depend on
// ---------------------------------------------------------------------------
{
  check('the styles registry lists the six run.js validates', stylesModule.STYLES.join(','), runModule.STYLES.join(','))
  check('and every style resolves', stylesModule.STYLES.every((id) => stylesModule.styleOf(id) !== null), true)
  check('an unknown style resolves to null rather than throwing', stylesModule.styleOf('nope'), null)
  // The importer and the ledger must agree on the vocabulary, or a record arrives
  // in a kind no style can format.
  check('every kind the importer produces is a ledger kind', refsModule.KINDS.filter((kind) => !syntaxModule.SOURCE_KINDS.includes(kind)).join(','), '')
  check('the six frame-or-lazy gates are named once', ALL_GATES.map((gate) => gate.id).join(','), 'g1-rq,g2-intake,g3-integrity')
  check('and only the first two frame a run', GATES.length, 2)
  check('a run is never staged past framed by a lazy gate', stageOf({ slug: 'x', created: '', instructions: [], receipts: [], gates: [{ id: 'g1-rq', at: '', value: 'confirm', text: '', reason: '' }, { id: 'g2-intake', at: '', value: 'no_experiments_declared', text: 'none', reason: '' }, { id: 'g3-integrity', openedAt: '' }] }), 'framed')
  check('a near miss is offered for a typo', nearMisses('smith2024', ['smith-2024', 'jones2023']).join(','), 'smith-2024')
  check('and a record\'s origins are per field', Object.keys(provenanceOf({ title: 't', year: '2024', authors: [] }, 'crossref')).join(','), 'title,year')
}

// ---------------------------------------------------------------------------
// The security claim: no socket, no child process, no stray environment read
// ---------------------------------------------------------------------------
{
  // EVERY host file, subdirectories included: the styles and the reference engine
  // are as much a part of "this package opens no socket" as the row is, and a scan
  // that only looked at the top level would be a claim with a hole in it.
  const walk = (dir, prefix = '') => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative))
      else if (entry.name.endsWith('.js')) out.push(relative)
    }
    return out
  }
  const files = walk(path.join(pkgDir, 'lib'))
  check('the host half is a handful of files', files.length >= 3, true)
  const sources = new Map(files.map((name) => [name, readFileSync(path.join(pkgDir, 'lib', ...name.split('/')), 'utf8')]))
  // The browser bundle is NOT part of this claim: it calls this plugin's own
  // routes from the page, which is a same-origin request the harness already
  // gates. "Opens no socket" is about the HOST, so the host is what is scanned.
  const host = [...sources.entries()].filter(([name]) => name !== 'client.js')
  check('the host half is several files', host.length >= 3, true)
  check('and the styles are part of it', host.some(([name]) => name.startsWith('styles/')), true)

  // A BEHAVIOURAL proof is not available for "this row never opens a socket",
  // because the claim is about code that is ABSENT: there is no call to observe.
  // So this is a source assertion, said out loud as one - it proves no host file
  // of this row can reach the network or start a process, which is the security
  // claim SECURITY.md makes on this package's behalf. The `fetch` pattern allows
  // the two shapes that are NOT a call: a route's own `async fetch(request)`
  // method and a `connection.fetch.register(...)` member access.
  const forbidden = [
    ['node:http', /from\s+['"]node:https?['"]/],
    ['node:net', /from\s+['"]node:(net|tls|dgram)['"]/],
    ['node:child_process', /from\s+['"]node:child_process['"]/],
    ['the global fetch()', /(?<![.\w])(?<!async )fetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['spawn/exec', /\b(spawnSync|execSync|spawn|execFile)\s*\(/],
  ]
  for (const [label, pattern] of forbidden) {
    const hit = host.filter(([, text]) => pattern.test(text)).map(([name]) => name)
    check('no ' + label + ' in the host half', hit.join(','), '')
  }

  // The browser half's own, weaker claim - and the one that matters for a tab: it
  // names no external host, so the only requests it can make are same-origin ones
  // to this plugin's own routes, which ride the harness's session cookie.
  const client = sources.get('client.js') ?? null
  if (client === null) skip('the browser half names no external host', 'lib/client.js is not written yet')
  else {
    check('the browser half names no external host', /['"]https?:\/\//.test(client), false)
    check('and sends the session cookie', client.includes("credentials: 'same-origin'"), true)
    // The route CONSTANTS are asserted by value in check-client-bundles.mjs, where
    // the bundle is actually loaded through the module table. What is pinned here
    // is only what a source scan can honestly say: the panel names no external
    // host, and it does know the file route it edits through.
    check('the panel knows the file route', client.includes("FILE_ROUTE = API_ROOT + '/file'"), true)
  }

  // The only environment variables this package may read: its own root and the
  // home directory it looks for a Desktop in. A credential-shaped name appearing
  // here would make the row's "reads no credential" claim false.
  const allowedEnv = new Set(['DSH_RESEARCH_ROOT', 'DSH_HOME', 'HOME', 'USERPROFILE'])
  const readEnv = new Set()
  for (const [, text] of sources) {
    for (const match of text.matchAll(/\benv(?:ironment)?\.([A-Z][A-Z0-9_]*)/g)) readEnv.add(match[1])
    for (const match of text.matchAll(/\benv(?:ironment)?\s*\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) readEnv.add(match[1])
  }
  const stray = [...readEnv].filter((name) => !allowedEnv.has(name))
  check('only its own root and the home directory are read from the env', stray.join(','), '')
  check('and the root variable IS the one declared', runModule.ROOT_ENV, 'DSH_RESEARCH_ROOT')

  // Every refusal code the health route publishes must be thrown somewhere, or it
  // is a code a caller can never see and a README claim nobody can test.
  const joined = [...sources.values()].join('\n')
  const unthrown = indexModule.REFUSAL_CODES.filter((code) => !joined.includes("'" + code + "'"))
  check('every published refusal code is thrown by the code', unthrown.join(','), '')
  check('a refusal is a ResearchError', new ResearchError('X', 'y') instanceof Error, true)
}

await fsp.rm(tmp, { recursive: true, force: true })
if (envBefore === undefined) delete process.env.DSH_RESEARCH_ROOT
else process.env.DSH_RESEARCH_ROOT = envBefore
if (homeBefore === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = homeBefore

console.log('')
if (skips > 0) console.log(skips + ' case(s) skipped - read the SKIP lines, they are not evidence')
console.log(failures === 0 ? 'all research-node checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
