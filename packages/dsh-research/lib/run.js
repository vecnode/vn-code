/**
 * dsh-research — the run model.
 *
 * A research run is a FOLDER, not conversational state: `RUN.json` says what it
 * is, `passport.json` says what the human decided and in whose words, and
 * everything else in the folder is the work. Nothing in this file knows about
 * cordis, the harness or a browser - it takes a root, an environment and a log
 * sink - so the same engine is driven by `checks/check-research-node.mjs` with no
 * harness at all. That split is the pack's, and it is what makes the checks able
 * to drive the shipped code path rather than a copy of it.
 *
 * Two rules this module exists to enforce, both of them about the quiet failure:
 *
 *   1. **A path never leaves the root.** A slug is matched against one strict
 *      pattern (so it cannot contain a separator), and every path this module
 *      hands out is additionally resolved and compared against the realpath of
 *      the root - so a SYMLINKED run folder inside the root cannot be followed
 *      out of it. A refused path is an error with a code, never a fallback.
 *   2. **A gate is answered by a person, in their own words, or it is not
 *      answered.** `g2-intake` (did YOU run the experiments this reports?) is
 *      fail-closed - it demands text even when the answer is "no" - and an option
 *      marked `overrides: true` demands a recorded reason. An agent that could
 *      answer either of those for the user would make the whole ledger worth
 *      nothing.
 *
 * Nothing here opens a socket, spawns a process, reads a credential or writes
 * outside the run folder. That is the row's contract, and it is why the plugin
 * can be installed without a trust conversation: see SECURITY.md.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** This build's marker. It must equal package.json's version. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/** The root override. Relative paths resolve against the workspace. */
export const ROOT_ENV = 'DSH_RESEARCH_ROOT'
/** The folder this plugin owns on a Desktop. */
export const DESKTOP_DIRNAME = 'vncode-research'
/** The folder it owns in the workspace when there is no Desktop. */
export const WORKSPACE_DIRNAME = 'research'

/** The two files that make a folder a run. */
export const RUN_FILE = 'RUN.json'
export const PASSPORT_FILE = 'passport.json'

/** A slug is the run's identity AND its folder name, so it is one strict shape. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
export const MAX_SLUG = 64
/** How long a title, an instruction or a gate answer may be. */
export const MAX_TITLE_CHARS = 300
export const MAX_TEXT_CHARS = 8000
/** How many runs a listing reads, and how many files one run reports. */
export const MAX_RUNS = 200
export const MAX_FILES = 200
export const MAX_FILE_DEPTH = 6
/** The receipts a passport keeps before the oldest are dropped. */
export const MAX_RECEIPTS = 500

/**
 * The kinds of run this plugin can hold. The list is closed on purpose: each one
 * is a different STRUCTURE the writing skill teaches, so a kind nothing can
 * teach is a kind that would produce a shapeless document.
 */
export const RUN_KINDS = ['paper', 'review', 'brief', 'report', 'lit-review', 'protocol']
/** The document structures a kind maps to today. `custom` is honest, not a gap. */
export const STRUCTURES = ['imrad', 'thematic-review', 'theoretical', 'case-study', 'policy-brief', 'conference', 'custom']
/**
 * The citation styles this plugin records. Six, and each one has a renderer
 * module in `lib/styles/` (phase 3): a style outside this list is REFUSED rather
 * than recorded, because a run that promises a bibliography nothing can build is
 * a run that fails at the last step instead of the first.
 */
export const STYLES = ['apa7', 'chicago-notes', 'chicago-author-date', 'mla9', 'ieee', 'vancouver']
/** How a kind picks its structure when the caller does not say. */
export const STRUCTURE_OF_KIND = {
  paper: 'imrad',
  review: 'thematic-review',
  brief: 'policy-brief',
  report: 'custom',
  'lit-review': 'thematic-review',
  protocol: 'custom',
}

/**
 * The gates. These are HOST-OWNED data, and the browser half renders whatever
 * this array says - so the question a person answers in the right bar and the
 * question the tools refuse on can never drift apart.
 *
 * `requiresText` is the fail-closed bit: `g2-intake` demands the user's own words
 * even when the answer is "no", because "did you run these experiments?" is
 * exactly the question an agent must not answer on a human's behalf.
 */
export const GATES = [
  {
    id: 'g1-rq',
    stage: 'frame',
    question: 'Is this the research question you actually want answered, and is it yours?',
    requiresText: false,
    options: [
      { value: 'confirm', label: 'Yes - this is the question, and it is mine' },
      { value: 'revise', label: 'Not yet - the question or the plan has to change', overrides: true },
      { value: 'stop', label: 'Stop this run here', overrides: true },
    ],
  },
  {
    id: 'g2-intake',
    stage: 'frame',
    question: 'Does this document report experiments or data analyses that YOU ran yourself?',
    requiresText: true,
    options: [
      { value: 'no_experiments_declared', label: 'No - this run reports no experiments of mine' },
      { value: 'experiments_declared', label: 'Yes - I ran experiments this document reports', overrides: true },
    ],
  },
]

/**
 * A gate that is opened ON DEMAND, by the operation it guards.
 *
 * `g3-integrity` is the person's statement that a run has been checked, and it is
 * asked at the one moment it means something: a `draft=clean` build. Showing it as
 * pending from the moment a run exists would be noise in the panel and would
 * suggest a run is blocked when it is not - so it appears only once something has
 * opened it, and `gateViews` is what decides that.
 */
export const LAZY_GATES = [
  {
    id: 'g3-integrity',
    stage: 'build',
    question: 'Has this run been checked as far as you need it checked, so the document can be built clean?',
    requiresText: false,
    options: [
      { value: 'checked', label: 'Yes - build it clean' },
      { value: 'override', label: 'No - build it clean anyway, and record why', overrides: true },
    ],
  },
]

/** Every gate this plugin knows, frame and lazy alike. */
export const ALL_GATES = [...GATES, ...LAZY_GATES]

/** One gate's definition, by id. */
export function gateById(id) {
  return ALL_GATES.find((gate) => gate.id === id) ?? null
}

/** Whether a gate is one of the two that frame a run. */
export function isFrameGate(id) {
  return GATES.some((gate) => gate.id === id)
}

/**
 * A refused operation. The `code` is what the checks assert on, because a
 * message is prose and prose changes: `GATE_UNANSWERED` staying
 * `GATE_UNANSWERED` is the contract.
 */
export class ResearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResearchError'
    this.code = code
  }
}

/** One error's message, whatever was thrown. */
export function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------
/**
 * The Desktop this machine actually has, or null.
 *
 * Existence is what decides. A machine can have several of these paths and only
 * one of them be real, and guessing from an environment variable alone is how a
 * plugin writes into a folder nobody can find.
 *
 * @param options - `{ env, home }`.
 * @returns the desktop path, or null.
 */
export async function desktopRoot(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? null
  const candidates = []
  if (typeof home === 'string' && home !== '') candidates.push(path.join(home, 'Desktop'))
  if (typeof home === 'string' && home !== '') {
    candidates.push(path.join(home, 'OneDrive', 'Desktop'))
    candidates.push(path.join(home, 'OneDrive - Personal', 'Desktop'))
  }
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') {
    candidates.push(path.join(env.USERPROFILE, 'Desktop'))
    candidates.push(path.join(env.USERPROFILE, 'OneDrive', 'Desktop'))
  }
  for (const candidate of candidates) {
    const present = await fsp
      .stat(candidate)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    if (present) return candidate
  }
  return null
}

/**
 * Where runs live on this machine, in the order that answers "where did my paper
 * go" - and the same answer in every session.
 *
 *   1. `DSH_RESEARCH_ROOT` (relative resolves against the workspace) - explicit
 *      wins, because a person who set it meant it.
 *   2. **The remembered root**: `$DSH_HOME/dsh-research/library.json` names the
 *      folder this machine's runs live in. This is the pack's own state rule
 *      (`$DSH_HOME/<package>/`) applied to the one thing that must not move
 *      between sessions: a paper is opened tomorrow, from another conversation,
 *      possibly with a different working directory, and it has to be the SAME
 *      folder. A root resolved from the current directory alone would give a
 *      second library the moment the cwd changed.
 *   3. The ladder: `<desktop>/vncode-research`, else `<workspace>/research` - and
 *      the winner is written into the pointer, so the next session does not have
 *      to guess again.
 *
 * @param options - `{ env, workspace, home }`.
 * @returns `{ root, source, workspace, override, pointer, remembered, exists }`.
 */
export async function resolveRoot(options = {}) {
  const env = options.env ?? process.env
  const workspace = options.workspace ?? process.cwd()
  const pointer = libraryFile(env)
  const override = typeof env[ROOT_ENV] === 'string' && env[ROOT_ENV].trim() !== '' ? env[ROOT_ENV].trim() : null
  if (override !== null) {
    const root = path.resolve(workspace, override)
    await rememberLibrary(env, root, 'env')
    return { root, source: 'env', workspace, override, pointer, remembered: false, exists: await present(root) }
  }
  const remembered = await readLibrary(env)
  if (remembered !== null && typeof remembered.root === 'string' && remembered.root.trim() !== '') {
    const root = path.resolve(remembered.root)
    return {
      root,
      // The remembered SOURCE is kept, so `rs_open action=roots` can still explain
      // WHY this folder was chosen the first time.
      source: typeof remembered.source === 'string' ? remembered.source : 'library',
      workspace,
      override: null,
      pointer,
      remembered: true,
      exists: await present(root),
    }
  }
  const desktop = await desktopRoot({ env, home: options.home })
  const root = desktop !== null ? path.join(desktop, DESKTOP_DIRNAME) : path.join(workspace, WORKSPACE_DIRNAME)
  const source = desktop !== null ? 'desktop' : 'workspace'
  await rememberLibrary(env, root, source)
  return { root, source, workspace, override: null, pointer, remembered: false, exists: await present(root) }
}

/** The plugin's own home directory, resolved exactly like its siblings. */
export function resolveHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  const home = env.USERPROFILE ?? env.HOME ?? ''
  return path.join(home === '' ? process.cwd() : home, '.dsh')
}

/** The one file that names this machine's research library. */
export function libraryFile(env = process.env) {
  return path.join(resolveHome(env), 'dsh-research', 'library.json')
}

/** The remembered library, or null when this is the first run on this machine. */
export async function readLibrary(env) {
  const record = await readJson(libraryFile(env)).catch(() => null)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  return record
}

/**
 * Remember where the library is, once.
 *
 * Only written when it would CHANGE, so a session that reads the root a hundred
 * times writes the file no times - and a failure to write is not fatal: a
 * machine where `$DSH_HOME` is read-only still gets a working run folder, it just
 * has to resolve it the same way next time.
 */
export async function rememberLibrary(env, root, source, now) {
  const file = libraryFile(env)
  const existing = await readLibrary(env)
  if (existing !== null && typeof existing.root === 'string' && path.resolve(existing.root) === path.resolve(root)) return existing
  const record = {
    schema: 1,
    root: path.resolve(root),
    source: typeof source === 'string' && source !== '' ? source : 'desktop',
    rememberedAt: stamp(now),
    why: 'This file is what makes a research run findable from ANY session. Delete it to let the next session choose again, or set ' + ROOT_ENV + ' to point somewhere else.',
  }
  try {
    await writeJsonAtomic(file, record)
  } catch (err) {
    return null
  }
  return record
}

/** The real path of a root that may not exist yet, so containment can still be checked. */
export async function canonicalRoot(root) {
  const resolved = path.resolve(root)
  const real = await fsp.realpath(resolved).catch(() => null)
  if (real !== null) return real
  // Walk up to the nearest ancestor that does exist and re-attach the tail, so a
  // root that has not been created yet still compares against a real path.
  let head = resolved
  const tail = []
  for (;;) {
    const parent = path.dirname(head)
    if (parent === head) return resolved
    tail.unshift(path.basename(head))
    head = parent
    const realParent = await fsp.realpath(head).catch(() => null)
    if (realParent !== null) return path.join(realParent, ...tail)
  }
}

/** Whether a directory exists. */
export async function present(dir) {
  return fsp
    .stat(dir)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
/** Whether a value is a usable run slug. */
export function isSlug(value) {
  return typeof value === 'string' && value.length <= MAX_SLUG && SLUG_PATTERN.test(value)
}

/**
 * A slug, or a refusal.
 *
 * The pattern is the first line of defence (`..` and `/` cannot match it), and
 * the error names the rule rather than the value, so a caller learns the shape
 * instead of trying variations.
 */
export function parseSlug(value) {
  const slug = typeof value === 'string' ? value.trim() : ''
  if (!isSlug(slug)) {
    throw new ResearchError(
      'BAD_SLUG',
      'a slug is 3-64 characters of lowercase letters, digits and dashes, starting and ending with a letter or digit' +
        (slug === '' ? ' (none was given)' : ' (got ' + JSON.stringify(slug.slice(0, 80)) + ')'),
    )
  }
  return slug
}

/**
 * Whether a target really sits under a root.
 *
 * Two questions, and both have to be answered: the LEXICAL one (is the resolved
 * path under the resolved root) refuses `..` and an absolute path, and the REAL
 * one (does the target's realpath stay under the root's realpath) is what refuses
 * a symlink planted inside the root that points out of it. Without the second,
 * containment is a string check and a symlink walks straight through it.
 */
export async function insideRoot(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) return false
  const realTarget = await fsp.realpath(resolvedTarget).catch(() => null)
  if (realTarget === null) return true // nothing there yet: the lexical answer stands
  const realRoot = await canonicalRoot(resolvedRoot)
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
}

/** One run's folder, or a refusal. */
export async function runDir(root, slugValue) {
  if (typeof root !== 'string' || root.trim() === '') {
    // A caller that forgot to resolve the root gets told so by NAME. Without this
    // the failure surfaces as a `path.resolve(undefined)` TypeError three frames
    // down, which reads as a bug in this plugin rather than as a missing step.
    throw new ResearchError('BAD_ROOT', 'the research root was not resolved before this call (it must be a path string)')
  }
  const slug = parseSlug(slugValue)
  const dir = path.join(path.resolve(root), slug)
  if (!(await insideRoot(root, dir))) {
    throw new ResearchError('PATH_ESCAPE', 'the run folder resolves outside the research root: ' + dir)
  }
  return { slug, dir }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
/** Read a JSON file, or null when it is not there. A malformed one is a refusal. */
export async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8').catch((err) => {
    if (err && err.code === 'ENOENT') return null
    throw err
  })
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ResearchError('MALFORMED_JSON', path.basename(file) + ' is not valid JSON: ' + messageOf(err))
  }
}

/**
 * Write a JSON file atomically.
 *
 * A run's ledger is the thing a person must be able to trust after a crash, so
 * every write goes to a sibling `.partial` and is renamed into place: a reader
 * either sees the whole previous file or the whole next one, never half of one.
 */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.partial'
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await fsp.rename(temp, file)
}

/**
 * Write a text file atomically, in the same shape as a JSON write.
 *
 * A run's prose is the one thing a person may be reading while an agent writes it,
 * so a write is a rename rather than a truncate-and-fill: a reader sees the whole
 * previous section or the whole next one.
 */
export async function writeTextAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.partial'
  await fsp.writeFile(temp, String(text), 'utf8')
  await fsp.rename(temp, file)
}

/** `1200 bytes` -> `1.2 KiB`, because a run's size is read, not computed. */
export function sizeOf(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}

/** An ISO stamp, from a clock the caller can replace so a check is deterministic. */
export function stamp(now) {
  return (now ?? new Date()).toISOString()
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
/** One run's `RUN.json`, validated enough that a hand-edited file cannot lie. */
export async function readRun(root, slugValue) {
  const { slug, dir } = await runDir(root, slugValue)
  const file = path.join(dir, RUN_FILE)
  const record = await readJson(file)
  if (record === null) {
    throw new ResearchError(
      'UNKNOWN_RUN',
      'no run named ' + slug + ' under ' + path.resolve(root) + ' (a run is a folder holding ' + RUN_FILE + ')',
    )
  }
  return { slug, dir, file, record }
}

/** One run's passport, or an empty one for a run created before this file existed. */
export async function readPassport(root, slugValue) {
  const { slug, dir } = await readRun(root, slugValue)
  const file = path.join(dir, PASSPORT_FILE)
  const stored = await readJson(file)
  const passport =
    stored === null
      ? { schema: 1, slug, created: stamp(), instructions: [], gates: [], receipts: [] }
      : {
          schema: 1,
          slug,
          created: typeof stored.created === 'string' ? stored.created : stamp(),
          instructions: Array.isArray(stored.instructions) ? stored.instructions : [],
          gates: Array.isArray(stored.gates) ? stored.gates : [],
          receipts: Array.isArray(stored.receipts) ? stored.receipts : [],
        }
  return { slug, dir, file, passport }
}

/**
 * Create a run.
 *
 * `mkdir` without `recursive` is the create-exclusive step: two agents racing on
 * one slug cannot both win, and the loser gets `RUN_EXISTS` rather than half of
 * somebody else's run. The passport opens with the user's own instruction and
 * BOTH frame gates pending, so a run can never look further along than it is.
 *
 * @returns the created run's record and its gate views.
 */
export async function createRun(options) {
  const root = path.resolve(options.root)
  const slug = parseSlug(options.slug)
  const { dir } = await runDir(root, slug)
  const now = stamp(options.now)
  const title = String(options.title ?? '').trim()
  if (title === '') throw new ResearchError('BAD_TITLE', 'a run needs a title: it is the document\'s own name')
  if (title.length > MAX_TITLE_CHARS) {
    throw new ResearchError('BAD_TITLE', 'a title is at most ' + MAX_TITLE_CHARS + ' characters (got ' + title.length + ')')
  }
  const kind = options.kind ?? 'paper'
  if (!RUN_KINDS.includes(kind)) {
    throw new ResearchError('BAD_KIND', 'kind must be one of ' + RUN_KINDS.join(', ') + ' (got ' + JSON.stringify(kind) + ')')
  }
  const style = options.style ?? 'apa7'
  if (!STYLES.includes(style)) {
    throw new ResearchError(
      'BAD_STYLE',
      'style must be one of ' + STYLES.join(', ') + ' - these are the six with a renderer; anything else is refused now rather than at the last build (got ' + JSON.stringify(style) + ')',
    )
  }
  const structure = options.structure ?? STRUCTURE_OF_KIND[kind] ?? 'custom'
  if (!STRUCTURES.includes(structure)) {
    throw new ResearchError('BAD_STRUCTURE', 'structure must be one of ' + STRUCTURES.join(', ') + ' (got ' + JSON.stringify(structure) + ')')
  }
  const language = String(options.language ?? 'en').trim().toLowerCase() || 'en'
  if (!/^[a-z]{2}(-[a-z0-9]{2,8})?$/.test(language)) {
    throw new ResearchError('BAD_LANGUAGE', 'language is a tag like `en` or `pt-br` (got ' + JSON.stringify(language) + ')')
  }

  await fsp.mkdir(root, { recursive: true })
  try {
    await fsp.mkdir(dir)
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new ResearchError('RUN_EXISTS', 'a run named ' + slug + ' already exists at ' + dir + ' - pick another slug or read the one that is there')
    }
    throw err
  }

  const record = {
    schema: 1,
    slug,
    title,
    kind,
    language,
    style,
    structure,
    created: now,
    updated: now,
    plugin: PLUGIN_VERSION,
  }
  const instruction = String(options.instruction ?? '').trim()
  const passport = {
    schema: 1,
    slug,
    created: now,
    instructions: instruction === '' ? [] : [{ at: now, verbatim: instruction.slice(0, MAX_TEXT_CHARS) }],
    gates: [],
    receipts: [{ at: now, tool: 'rs_new', summary: 'created ' + kind + ' run ' + slug + ' (' + style + ', ' + structure + ', ' + language + ')' }],
  }
  await writeJsonAtomic(path.join(dir, RUN_FILE), record)
  await writeJsonAtomic(path.join(dir, PASSPORT_FILE), passport)
  // The folders a run is expected to grow, so the tab shows a shape rather than
  // an empty box, and so a later phase has somewhere to write without inventing
  // a convention in a second place.
  for (const name of ['plan', 'doc', 'doc/sections', 'ledger', 'sources', 'figures', 'reviews', 'build']) {
    await fsp.mkdir(path.join(dir, ...name.split('/')), { recursive: true })
  }
  return { root, slug, dir, record, passport }
}

/** Append a receipt to a passport and persist it. */
export async function addReceipt(passportFile, passport, tool, summary, now) {
  const at = stamp(now)
  const receipts = [...passport.receipts, { at, tool, summary: summary.slice(0, 300) }]
  const kept = receipts.length > MAX_RECEIPTS ? receipts.slice(receipts.length - MAX_RECEIPTS) : receipts
  const next = { ...passport, receipts: kept }
  await writeJsonAtomic(passportFile, next)
  return next
}

/** Touch a run's `updated`, so the tab's order follows the work. */
export async function touchRun(runFile, record, now) {
  const next = { ...record, updated: stamp(now) }
  await writeJsonAtomic(runFile, next)
  return next
}

/**
 * Write one text file inside a run - the person's own edit, from the panel.
 *
 * Deliberately narrower than `rs_write`, and deliberately NOT a tool:
 *
 *   - only `doc/` and `plan/` are writable, and only `.md` files, because those
 *     are the two places a person edits prose and the ledger's own files are not
 *     for hand-editing;
 *   - the path is matched against one strict shape AND containment-checked, so a
 *     crafted `file` cannot leave the run folder;
 *   - the write is atomic, so a reader sees the whole previous file or the whole
 *     next one;
 *   - and an agent has NO tool for this. An agent writes prose through `rs_write`,
 *     which refuses a claim nothing tracks. A human may create exactly that state
 *     by hand - and then `r0-structure` reports it, which is the honest trade:
 *     never refuse a person their own file, never let the disagreement go unseen.
 *
 * @returns `{ file, bytes }`.
 */
export async function writeRunFile(options) {
  const root = options.root
  const { slug, dir } = await readRun(root, options.slug)
  const relative = String(options.file ?? '').trim().replace(/\\/g, '/')
  if (relative === '') throw new ResearchError('BAD_PATH', 'say which file to write, relative to the run folder (e.g. `doc/paper.md`)')
  if (relative.includes('\0')) throw new ResearchError('BAD_PATH', 'a path cannot contain a NUL byte')
  if (!/^(doc|plan)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/.test(relative) || relative.includes('..')) {
    throw new ResearchError(
      'BAD_PATH',
      'the panel writes `.md` files under `doc/` and `plan/` only (got ' + JSON.stringify(relative) + ') - the ledgers and the build output are not hand-edited',
    )
  }
  const target = path.join(dir, ...relative.split('/'))
  if (!(await insideRoot(dir, target))) throw new ResearchError('PATH_ESCAPE', 'that path leaves the run folder: ' + relative)
  const text = String(options.text ?? '')
  if (text.length > MAX_EDIT_CHARS) {
    throw new ResearchError('TEXT_TOO_LONG', 'a panel edit is at most ' + MAX_EDIT_CHARS + ' characters (got ' + text.length + ')')
  }
  await writeTextAtomic(target, text)
  return { slug, file: relative, bytes: Buffer.byteLength(text, 'utf8'), path: target, dir }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
/**
 * The last row recorded for one gate id, or null.
 *
 * A row with no `value` is a gate something OPENED and nobody has answered - which
 * is a real state, and the reason this returns the row rather than only an answer.
 */
export function rowOf(passport, id) {
  let found = null
  for (const entry of passport.gates) {
    if (entry && entry.id === id) found = entry
  }
  return found
}

/** The last ANSWER recorded for one gate id, or null. An opened row is not an answer. */
export function answerOf(passport, id) {
  const row = rowOf(passport, id)
  return row !== null && typeof row.value === 'string' && row.value !== '' ? row : null
}

/**
 * Every gate the panel should show, with its answer (or null).
 *
 * This is the ONE place the gate list is turned into what both the tools and the
 * browser half read, so "is this gate answered" cannot mean two things. The two
 * frame gates are always shown; a lazy gate joins them the moment something opens
 * it (`openGate`), which is how `g3-integrity` appears exactly when a clean build
 * has been asked for.
 */
export function gateViews(passport) {
  const opened = new Set((passport.gates ?? []).filter((row) => row && typeof row.id === 'string').map((row) => row.id))
  const shown = ALL_GATES.filter((gate) => isFrameGate(gate.id) || opened.has(gate.id))
  return shown.map((gate) => {
    const answered = answerOf(passport, gate.id)
    return {
      id: gate.id,
      stage: gate.stage,
      question: gate.question,
      requiresText: gate.requiresText === true,
      options: gate.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.overrides === true ? { overrides: true } : {}),
      })),
      answer:
        answered === null
          ? null
          : {
              at: typeof answered.at === 'string' ? answered.at : '',
              value: typeof answered.value === 'string' ? answered.value : '',
              text: typeof answered.text === 'string' ? answered.text : '',
              reason: typeof answered.reason === 'string' ? answered.reason : '',
            },
    }
  })
}

/** The gates still waiting on a person, frame gates and any opened lazy gate. */
export function pendingGates(passport) {
  return gateViews(passport).filter((gate) => gate.answer === null)
}

/** The FRAME gates still waiting on a person - what a run's stage is decided by. */
export function framePending(passport) {
  return pendingGates(passport).filter((gate) => isFrameGate(gate.id))
}

/**
 * How far along a run is, from what the ledger actually records.
 *
 * The stage is decided by the FRAME gates alone, and only by them: `g3-integrity`
 * is opened later by a clean build, and letting it drag a framed run back to
 * `framing` would be a stage change caused by asking a question. There is no way
 * to be further along than the answers say, and `framed` is as far as this plugin
 * claims until the rungs land.
 */
export function stageOf(passport) {
  const pending = framePending(passport)
  if (pending.length === GATES.length) return 'new'
  if (pending.length > 0) return 'framing'
  return 'framed'
}

/**
 * Open a gate, so it appears as pending in the panel.
 *
 * Idempotent: a gate that already has a row (opened or answered) is left exactly
 * as it is. This is what a `draft=clean` build calls before it refuses, so the
 * question it is asking the user is visibly waiting rather than only in a message.
 */
export async function openGate(options) {
  const { slug, file, passport } = await readPassport(options.root, options.slug)
  const gate = gateById(options.id)
  if (gate === null) {
    throw new ResearchError('GATE_UNKNOWN', 'no gate named ' + JSON.stringify(String(options.id ?? '')) + ' - this run has ' + ALL_GATES.map((one) => one.id).join(', '))
  }
  if (rowOf(passport, gate.id) !== null) {
    return { opened: false, slug, passport, gate: gateViews(passport).find((one) => one.id === gate.id) }
  }
  const next = { ...passport, gates: [...passport.gates, { id: gate.id, openedAt: stamp(options.now) }] }
  await writeJsonAtomic(file, next)
  return { opened: true, slug, passport: next, gate: gateViews(next).find((one) => one.id === gate.id) }
}

/**
 * Record one gate's answer.
 *
 * The refusals are the point of the function:
 *   - `GATE_UNKNOWN` for an id that is not a gate;
 *   - `GATE_ALREADY_ANSWERED` rather than a silent overwrite, because the ledger
 *     is a record of what a person decided, not a mutable preference;
 *   - `VALUE_INVALID` for an option that gate does not offer;
 *   - `TEXT_REQUIRED` when the gate is fail-closed (`g2-intake`);
 *   - `REASON_REQUIRED` when the chosen option is an override, which is how the
 *     pack's "every override carries the user's reasoning" rule is enforced
 *     mechanically instead of being asked for politely.
 */
export async function answerGate(options) {
  const { slug, dir, file, passport } = await readPassport(options.root, options.slug)
  const gate = gateById(options.id)
  if (gate === null) {
    throw new ResearchError(
      'GATE_UNKNOWN',
      'no gate named ' + JSON.stringify(String(options.id ?? '')) + ' - this run has ' + ALL_GATES.map((one) => one.id).join(', '),
    )
  }
  if (answerOf(passport, gate.id) !== null) {
    throw new ResearchError(
      'GATE_ALREADY_ANSWERED',
      gate.id + ' was already answered for ' + slug + '; the ledger records what was decided and is not edited in place',
    )
  }
  const option = gate.options.find((one) => one.value === options.value)
  if (option === undefined) {
    throw new ResearchError(
      'VALUE_INVALID',
      gate.id + ' offers ' + gate.options.map((one) => one.value).join(', ') + ' (got ' + JSON.stringify(String(options.value ?? '')) + ')',
    )
  }
  const text = String(options.text ?? '').trim()
  const reason = String(options.reason ?? '').trim()
  if (gate.requiresText === true && text === '') {
    throw new ResearchError(
      'TEXT_REQUIRED',
      gate.id + ' needs your own words in the answer box even when the answer is a plain yes or no - this is the one gate an agent must not answer for you',
    )
  }
  if (option.overrides === true && reason === '') {
    throw new ResearchError('REASON_REQUIRED', 'choosing "' + option.label + '" is an override, so it needs a reason recorded with it')
  }
  if (text.length > MAX_TEXT_CHARS || reason.length > MAX_TEXT_CHARS) {
    throw new ResearchError('TEXT_TOO_LONG', 'an answer or a reason is at most ' + MAX_TEXT_CHARS + ' characters')
  }
  const at = stamp(options.now)
  const entry = { id: gate.id, at, value: option.value, text, reason }
  const next = { ...passport, gates: [...passport.gates, entry] }
  await writeJsonAtomic(file, next)
  return { slug, dir, file, passport: next, entry, gate: gateViews(next).find((one) => one.id === gate.id) }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
/** One run's folder, walked for the files it holds. Capped, and it says so. */
export async function listRunFiles(dir) {
  const files = []
  const notes = []
  const walk = async (current, depth) => {
    if (depth > MAX_FILE_DEPTH || files.length >= MAX_FILES) return
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (err) {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.endsWith('.partial')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = await fsp
        .stat(full)
        .then((stat) => stat.size)
        .catch(() => 0)
      files.push({ path: path.relative(dir, full).split(path.sep).join('/'), bytes })
    }
  }
  await walk(dir, 0)
  if (files.length >= MAX_FILES) notes.push('the file list stops at ' + MAX_FILES + ' entries')
  return { files, notes }
}

/** The most characters one file read returns before it is truncated. */
export const MAX_READ_CHARS = 200_000
/** The most characters the panel may save in one edit. */
export const MAX_EDIT_CHARS = 512 * 1024

/** How many records a JSONL ledger holds, or null when the file is not there yet. */
async function countLines(file) {
  const text = await fsp.readFile(file, 'utf8').catch((err) => {
    if (err && err.code === 'ENOENT') return null
    throw err
  })
  if (text === null) return null
  return text.split('\n').filter((line) => line.trim() !== '').length
}

/** The three ledgers, as counts. `null` means "no such ledger yet", not zero. */
export async function ledgerCounts(dir) {
  return {
    claims: await countLines(path.join(dir, 'ledger', 'claims.jsonl')),
    sources: await countLines(path.join(dir, 'ledger', 'sources.jsonl')),
    reviews: await countLines(path.join(dir, 'ledger', 'reviews.jsonl')),
  }
}

/** Every run under a root, newest work first. A folder without RUN.json is skipped. */
export async function listRuns(root) {
  const notes = []
  const runs = []
  if (!(await present(root))) return { runs, notes }
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    return { runs, notes: ['the research root could not be read: ' + messageOf(err)] }
  }
  for (const entry of entries) {
    if (runs.length >= MAX_RUNS) {
      notes.push('the run list stops at ' + MAX_RUNS + ' runs')
      break
    }
    if (!entry.isDirectory()) continue
    if (!isSlug(entry.name)) continue
    const dir = path.join(root, entry.name)
    let record = null
    try {
      record = await readJson(path.join(dir, RUN_FILE))
    } catch (err) {
      notes.push(entry.name + ': ' + messageOf(err))
      continue
    }
    if (record === null) continue
    const passport = await readPassport(root, entry.name).then((read) => read.passport).catch(() => null)
    const gates =
      passport === null
        ? { pending: GATES.length, total: GATES.length }
        : { pending: pendingGates(passport).length, total: gateViews(passport).length }
    const { files } = await listRunFiles(dir)
    runs.push({
      slug: entry.name,
      title: typeof record.title === 'string' && record.title !== '' ? record.title : entry.name,
      kind: typeof record.kind === 'string' ? record.kind : 'paper',
      language: typeof record.language === 'string' ? record.language : 'en',
      style: typeof record.style === 'string' ? record.style : 'apa7',
      stage: passport === null ? 'new' : stageOf(passport),
      created: typeof record.created === 'string' ? record.created : '',
      updated: typeof record.updated === 'string' ? record.updated : '',
      gates,
      files: files.length,
      root: path.resolve(root),
    })
  }
  runs.sort((left, right) => (right.updated || right.created).localeCompare(left.updated || left.created))
  return { runs, notes }
}

/** Everything the browser half needs for one root, in one answer. */
export async function stateView(options = {}) {
  const resolved = await resolveRoot(options)
  const root = await canonicalRoot(resolved.root)
  const { runs, notes } = await listRuns(root)
  const exists = await present(root)
  const view = {
    version: PLUGIN_VERSION,
    root: {
      path: root,
      source: resolved.source,
      exists,
      // The pointer is part of the answer because it is part of the user's
      // question: "will my research still be here tomorrow, in another session?"
      // is answered by this file, and `pointer` is where they can look at it.
      pointer: resolved.pointer,
      remembered: resolved.remembered === true,
    },
    runs,
    capabilities: {
      // Supplied by the caller that owns the registries (the row, and the tools),
      // so this list cannot go stale the moment a tool is added: it IS the list.
      tools: Array.isArray(options.tools) ? options.tools : [],
      routes: Array.isArray(options.routes) ? options.routes : [],
      formats: Array.isArray(options.formats) ? options.formats : [],
    },
    notes: [...notes],
  }
  if (resolved.override !== null) view.notes.push(ROOT_ENV + ' is set, so this root was chosen explicitly')
  else if (resolved.remembered) view.notes.push('this root came from ' + resolved.pointer + ', so every session finds the same library')
  else view.notes.push('this root was remembered in ' + resolved.pointer + ' for every later session')
  if (!exists) view.notes.push('the root does not exist yet - `rs_new` makes it, or point ' + ROOT_ENV + ' somewhere else')
  return view
}

/**
 * One run, as the workbench reads it.
 *
 * One round trip on purpose: the panel redraws on every poll while the agent is
 * working, and six requests per redraw in a 300px column is a cost with no
 * benefit. The payload is bounded (a capped file list, ledger COUNTS rather than
 * ledger bodies), so polling it stays cheap.
 */
export async function projectView(options) {
  const resolved = await resolveRoot(options)
  const root = await canonicalRoot(resolved.root)
  const { slug, dir, record } = await readRun(root, options.slug)
  const { passport } = await readPassport(root, slug)
  const { files, notes } = await listRunFiles(dir)
  return {
    run: {
      slug,
      title: typeof record.title === 'string' ? record.title : slug,
      kind: typeof record.kind === 'string' ? record.kind : 'paper',
      language: typeof record.language === 'string' ? record.language : 'en',
      style: typeof record.style === 'string' ? record.style : 'apa7',
      structure: typeof record.structure === 'string' ? record.structure : 'custom',
      stage: stageOf(passport),
      created: typeof record.created === 'string' ? record.created : '',
      updated: typeof record.updated === 'string' ? record.updated : '',
      root,
      path: dir,
    },
    gates: gateViews(passport),
    passport: {
      instructions: passport.instructions.map((entry) => ({
        at: typeof entry.at === 'string' ? entry.at : '',
        verbatim: typeof entry.verbatim === 'string' ? entry.verbatim : '',
      })),
      receipts: passport.receipts.map((entry) => ({
        at: typeof entry.at === 'string' ? entry.at : '',
        tool: typeof entry.tool === 'string' ? entry.tool : '',
        summary: typeof entry.summary === 'string' ? entry.summary : '',
      })),
    },
    files,
    ledger: await ledgerCounts(dir),
    notes: [...notes],
  }
}

/** The snapshot the tracked checks and the state route both read. */
export async function healthView(options = {}) {
  const state = await stateView(options)
  return {
    ok: true,
    version: PLUGIN_VERSION,
    root: state.root,
    runs: state.runs.length,
    pending: state.runs.reduce((total, run) => total + run.gates.pending, 0),
    gates: ALL_GATES.map((gate) => gate.id),
    tools: state.capabilities.tools,
    routes: state.capabilities.routes,
    notes: state.notes,
  }
}

/**
 * Read one text file inside a run.
 *
 * Containment first, then a cap, then a refusal for anything that is not text:
 * a run holds PDFs and PNGs, and a reader that returns mojibake for a PDF would
 * be worse than one that says "that is not a text file, use pdf_read".
 */
export async function readRunText(options) {
  const resolved = await resolveRoot(options)
  const root = await canonicalRoot(resolved.root)
  const { slug, dir } = await readRun(root, options.slug)
  const relative = String(options.file ?? '').trim()
  if (relative === '') throw new ResearchError('BAD_PATH', 'say which file to read, relative to the run folder')
  if (relative.includes('\0')) throw new ResearchError('BAD_PATH', 'a path cannot contain a NUL byte')
  const target = path.resolve(dir, relative)
  if (!(await insideRoot(dir, target))) {
    throw new ResearchError('PATH_ESCAPE', 'that path leaves the run folder: ' + relative)
  }
  const stat = await fsp.stat(target).catch(() => null)
  if (stat === null || !stat.isFile()) throw new ResearchError('NO_SUCH_FILE', 'no file at ' + relative + ' inside run ' + slug)
  const maxChars = Math.min(Number.isFinite(options.maxChars) ? Number(options.maxChars) : 40_000, 200_000)
  const raw = await fsp.readFile(target)
  if (raw.includes(0)) {
    throw new ResearchError('NOT_TEXT', relative + ' is not a text file (' + sizeOf(raw.length) + ') - a PDF is read with the pdf_* tools')
  }
  const text = raw.toString('utf8')
  return {
    slug,
    file: relative,
    bytes: raw.length,
    chars: text.length,
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  }
}
