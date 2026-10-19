/**
 * dsh-proto-lab — the five tools the agent calls.
 *
 * The surface is organised by INTENT, which is this pack's rule and not a style
 * preference: a model choosing among six near-synonyms (`lab_create`, `lab_make`,
 * `lab_scaffold`, `lab_pick_runtime`...) spends its attention on the choice
 * instead of on the prototype. So there are five, and each answers one question:
 *
 *   - `lab_open`      — where is the lab, and what is in it (and make it, once)
 *   - `lab_runtimes`  — what can I write here, is its toolchain on this machine,
 *                       what examples does it ship, and is a run of mine sound
 *   - `lab_new`       — write a run (from scratch, or from one of the examples)
 *   - `lab_read`      — show me a run, or one file of one
 *   - `lab_lint`      — is this run still a prototype in its own runtime
 *
 * `lab_new` and `lab_lint` are the pair that matters: the first writes files, the
 * second judges them, and both are driven by the same runtime module - so what a
 * runtime generates and what it accepts cannot drift apart.
 *
 * Two things every answer does, because the model reads the answer and not this
 * file: it names the ABSOLUTE path of what it made or read (a relative path is
 * useless the moment the answer is quoted into another turn), and it says what to
 * do next in one line.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  LabError,
  canonicalRoot,
  instantiateExample,
  lintRun,
  listRuns,
  normalizeParams,
  readCatalog,
  readRun,
  readRunFile,
  resolveLabRoot,
  scaffoldRun,
  slugify,
} from './lab.js'
import { BUDGETS, machine, TIERS, tierOf, throughTier } from './capabilities.js'
import { runtimeOf, runtimes } from './runtimes/index.js'
import { labelFromSlug, seedFromName } from './util.js'

/** The most characters one file read returns before it is truncated. */
export const READ_MAX_CHARS = 64_000
/** The most runs one listing prints before it is summarized. */
export const LIST_MAX = 60

/** The value every tool's `view` conforms to. The conversation card draws this. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    action: { type: 'string' },
    root: { type: 'string' },
    run: { type: 'string' },
    file: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    runtimes: { type: 'array', items: { type: 'string' } },
    runs: { type: 'number' },
    issues: { type: 'number' },
    bytes: { type: 'number' },
    ms: { type: 'number' },
    summary: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['ok'],
}

/** The workspace a call runs in: the session's own cwd, else the process's. */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.meta?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** `1200 bytes` -> `1.2 KiB`, because a run's size is read, not computed. */
function sizeOf(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}

/**
 * Build the five tools against one environment.
 *
 * @param deps - `{ env, log }`.
 * @returns the tool definitions to register.
 */
export function buildTools(deps = {}) {
  const env = deps.env ?? process.env
  const log = deps.log ?? { warn() {}, info() {} }

  /** The common output declaration: prose plus a card. */
  const output = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, view: VIEW_SCHEMA },
      required: ['text', 'view'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
    presentationMeta: (_args, value) => value.view,
  }

  /** Wrap one tool body, so a throw becomes an answer rather than a failure. */
  const run = async (name, args, exec, body) => {
    const started = Date.now()
    try {
      const answer = await body(args, exec)
      return {
        text: answer.text,
        view: { ok: answer.ok !== false, tool: name, ms: answer.ms ?? Date.now() - started, ...(answer.view ?? {}) },
      }
    } catch (err) {
      const message = messageOf(err)
      if (!(err instanceof LabError)) log.warn(name + ' failed: ' + message)
      return {
        text:
          (err instanceof LabError ? 'Refused: ' : name + ' failed: ') +
          message +
          (err instanceof LabError ? '' : ''),
        view: { ok: false, tool: name, ms: Date.now() - started, summary: message },
      }
    }
  }

  /** The lab root for this call, canonicalized once. */
  const rootFor = async (exec) => {
    const resolved = await resolveLabRoot({ env, workspace: workspaceOf(exec) })
    return { ...resolved, root: await canonicalRoot(resolved.root) }
  }

  /** Whether a directory exists and holds anything. */
  const present = async (dir) => {
    try {
      const stat = await fsp.stat(dir)
      return stat.isDirectory()
    } catch (err) {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // lab_open
  // -------------------------------------------------------------------------
  const open = {
    name: 'lab_open',
    description: [
      'Where the prototyping lab is, what is in it, and (with action "create") make it exist.',
      'The lab is a folder prototypes are written into, grouped by runtime as `<root>/<runtime>/<slug>/`. It is NOT part of the plugin and NOT part of the repository - it is generated on this machine and .gitignore keeps it out of every commit.',
      'The default root is the DESKTOP (`~/Desktop/vncode-lab/runs/`), because a prototype is something a person opens; a machine with no Desktop falls back to `<workspace>/lab` - so never assume the path, read it from this call.',
      'Call this first in a session: it answers the absolute path, which runtime folders exist, how many runs there are and whether the catalog agrees with the disk.',
      'Set DSH_PROTO_LAB_ROOT to put the lab somewhere else entirely (relative paths resolve against the workspace).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['info', 'create'], description: '`info` (default) reports; `create` makes the folder if it is missing.' },
      },
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Prototyping lab', kind: 'other' }),
    async execute(args, exec) {
      return run('lab_open', args, exec, async () => {
        const resolved = await rootFor(exec)
        const exists = await present(resolved.root)
        let created = false
        if (args.action === 'create') {
          // All three, because action=create is the one call that makes the lab.
          for (const dir of [resolved.root, resolved.prints, resolved.apps]) {
            const present = await fsp
              .stat(dir)
              .then((stat) => stat.isDirectory())
              .catch(() => false)
            if (present) continue
            await fsp.mkdir(dir, { recursive: true })
            if (dir === resolved.root) created = true
          }
        }
        const directory = created || exists
        const { runs, notes } = directory ? await listRuns(resolved.root) : { runs: [], notes: [] }
        const { catalog, note: catalogNote } = directory ? await readCatalog(resolved.root) : { catalog: { runs: {} }, note: null }

        const lines = []
        lines.push('Prototyping lab')
        lines.push('- root: ' + resolved.root + (created ? '  (created just now)' : exists ? '' : '  (does not exist yet - action=create makes it)'))
        lines.push(
          '- root comes from: ' +
            (resolved.source === 'DSH_PROTO_LAB_ROOT'
              ? 'DSH_PROTO_LAB_ROOT'
              : resolved.source === 'desktop'
                ? 'the DESKTOP (' + path.dirname(resolved.root) + ') - prototypes are things a person opens, so they arrive on the desktop, not in the checkout'
                : 'the workspace (' + resolved.workspace + ') - no Desktop on this machine'),
        )
        lines.push('- prints go to: ' + resolved.prints + (resolved.source === 'desktop' ? ' (a browser Save PNG lands in Downloads; the filename carries the run)' : ''))
        lines.push('- compiled apps go to: ' + resolved.apps)
        lines.push('- workspace looks like the vncode repository: ' + (resolved.repo ? 'yes - and nothing this lab writes is in it (.gitignore carries /lab/)' : 'no'))
        lines.push('- runs on disk: ' + runs.length + (catalogNote === null ? '' : '  (' + catalogNote + ')'))
        if (runs.length > 0) {
          lines.push('')
          const shown = runs.slice(0, LIST_MAX)
          for (const item of shown) {
            const recorded = catalog.runs[item.id]
            lines.push('  ' + item.id + '  ' + item.files.length + ' file(s), ' + sizeOf(item.bytes) + (recorded === undefined ? '  [not in the catalog]' : ''))
          }
          if (runs.length > shown.length) lines.push('  ... and ' + (runs.length - shown.length) + ' more')
        }
        for (const note of notes) lines.push('- note: ' + note)
        lines.push('')
        lines.push('Next: `lab_runtimes action=list` to see what can be written here, or `lab_new` to write a run.')

        return {
          ok: true,
          text: lines.join('\n'),
          view: {
            action: args.action ?? 'info',
            root: resolved.root,
            runs: runs.length,
            runtimes: [...new Set(runs.map((item) => item.runtime))],
            summary: runs.length + ' run(s) under ' + resolved.root,
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // lab_runtimes
  // -------------------------------------------------------------------------
  const runtimeTool = {
    name: 'lab_runtimes',
    description: [
      'What this lab can write. A runtime is a language: each one knows how to scaffold a run, whether a run is still sound, which examples it ships, and where its toolchain is on this machine.',
      'action "list" (default) prints every runtime with its kind and whether it is ready here.',
      'action "info" goes deep on ONE runtime: its toolchain (found or not, and what to set so it is), the exact files a run gets, the exact build command, the examples it ships, and - when you pass `run` - a full lint of one of your runs.',
      'action "examples" lists the committed examples by runtime: they are the checked, known-good runs, and `lab_new action=example` instantiates one into the lab.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'examples'], description: 'What to report (default `list`).' },
        runtime: { type: 'string', description: 'The runtime id, e.g. `p5js` or `openframeworks` (required by `info`).' },
        run: { type: 'string', description: 'A run to lint as part of `info`, as `<runtime>/<slug>`.' },
        deep: { type: 'boolean', description: 'With `info`: also run the deepest verification this host supports (a real compile for openFrameworks when the framework is installed). Slower; off by default.' },
      },
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Lab runtimes', kind: 'other' }),
    async execute(args, exec) {
      return run('lab_runtimes', args, exec, async () => {
        const { entries, problems } = runtimes()
        const action = args.action ?? 'list'
        if (problems.length > 0) log.warn('runtime registry: ' + problems.join('; '))
        const lines = []

        if (action === 'list') {
          const host = await machine({ env })
          lines.push('Lab runtimes (' + entries.length + ')')
          for (const entry of entries) {
            const detected = await entry.detect({ env })
            lines.push('')
            lines.push('- ' + entry.id + '  — ' + entry.label + '  [' + entry.kind + ']' + (detected.available ? '' : '  [NOT READY]'))
            lines.push('    ' + entry.tagline)
            lines.push('    ' + detected.summary)
          }
          lines.push('')
          lines.push(
            'This machine: ' + host.cores + ' cores, ' + host.memoryGiB + ' GiB memory, ' +
              (host.compilers.length > 0 ? host.compilers[0].name : 'no C++ compiler') + ', ' +
              (host.browser === null ? 'no browser' : 'a browser') + ' -> verification up to ' + host.tier + (host.blocked.length > 0 ? ' (capped by this confinement: ' + host.blocked.join(', ') + ')' : ''),
          )
          lines.push('  generated defaults are scaled to ' + Math.round(host.scale * 100) + '% of the full population, so a small machine is not handed a stuttering prototype')
          for (const note of host.notes) lines.push('  note: ' + note)
          lines.push('')
          lines.push('`lab_runtimes action=info runtime=<id>` for the toolchain, the verification ladder, the files and the build command.')
          lines.push('`lab_new runtime=<id> slug=<slug> concept="..."` writes one.')
          return { ok: true, text: lines.join('\n'), view: { action, runtimes: entries.map((entry) => entry.id), summary: entries.length + ' runtime(s)' } }
        }

        if (action === 'examples') {
          const wanted = typeof args.runtime === 'string' && args.runtime !== '' ? [runtimeOf(args.runtime)] : entries
          let count = 0
          lines.push('Committed examples — the checked, known-good runs')
          for (const entry of wanted) {
            const found = await entry.examples()
            count += found.length
            lines.push('')
            lines.push('- ' + entry.id + ' (' + found.length + ')')
            for (const example of found) {
              lines.push('    ' + example.slug + '  seed ' + example.seed + '  ' + (example.concept === '' ? example.label : example.concept))
            }
            if (found.length === 0) lines.push('    (none yet - `lab_new` still writes a run from the runtime\'s template)')
          }
          if (count > 0) {
            lines.push('')
            lines.push('Instantiate one: `lab_new action=example runtime=<id> example=<slug>`. Copy it and make it yours.')
          }
          return { ok: true, text: lines.join('\n'), view: { action, runtimes: wanted.map((entry) => entry.id), summary: count + ' example(s)' } }
        }

        const entry = runtimeOf(typeof args.runtime === 'string' ? args.runtime : '')
        const detected = await entry.detect({ env, detailed: true })
        const found = await entry.examples()
        const host = await machine({ env })
        lines.push('Runtime: ' + entry.id + ' — ' + entry.label + '  [' + entry.kind + ']')
        lines.push(entry.tagline)
        lines.push('')
        lines.push('Toolchain on this machine' + (detected.available ? '' : '  (NOT READY)'))
        for (const line of detected.detail) lines.push('- ' + line)
        if (detected.commands.length > 0) {
          lines.push('')
          lines.push('How it is run or built')
          for (const command of detected.commands) lines.push('- ' + command)
        }

        // The verification ladder, stated rather than implied. A tier is claimed
        // only when its precondition was FOUND here - which is the difference
        // between "this compiles" and "this is C++ that nobody has parsed".
        lines.push('')
        lines.push('How far a run can be VERIFIED on this machine (deepest = ' + host.tier + ')')
        for (const tier of TIERS) {
          const reached = throughTier(host.tier).some((item) => item.id === tier.id)
          lines.push('  [' + (reached ? 'x' : ' ') + '] ' + tier.id.padEnd(14) + tier.claim + (reached ? '' : '   -> needs ' + tier.needs.join(' and ')))
        }
        lines.push('  t3/t4 cost ' + tierOf('t4-measure').cost + '; t0/t1 are milliseconds. `deep: true` runs the deepest tier this host has.')

        lines.push('')
        lines.push('Files a new run gets')
        const sample = await entry.scaffold({ slug: 'example-slug', id: entry.id + '/example-slug', label: 'Example slug', concept: '(what it is)', seed: 1, params: [], env })
        for (const file of sample) lines.push('- ' + file.path)
        lines.push('')
        lines.push('Examples it ships (' + found.length + ')')
        for (const example of found) lines.push('- ' + example.slug + '  seed ' + example.seed + '  ' + example.concept)
        if (found.length === 0) lines.push('- (none)')

        // `deep` is the adaptability half: the same question, answered as far as
        // this host can answer it, including a real compile when there is a
        // framework to compile against.
        if (args.deep === true && typeof entry.checkScaffold === 'function') {
          lines.push('')
          lines.push('Deep check: compiling a freshly scaffolded run')
          const deep = await entry.checkScaffold({ env, machine: host })
          lines.push('- ' + deep.summary)
          for (const line of deep.detail ?? []) lines.push('  ' + line)
        }

        let lint = null
        if (typeof args.run === 'string' && args.run !== '') {
          const resolved = await rootFor(exec)
          const { catalog } = await readCatalog(resolved.root)
          lint = await lintRun({ root: resolved.root, runtime: entry, run: args.run, catalog, env, machine: host })
          lines.push('')
          lines.push('Lint of ' + lint.id + ': ' + (lint.ok ? 'ok' : 'PROBLEMS'))
          for (const item of lint.issues) lines.push('  [' + item.severity + '] ' + item.code + (item.file === null ? '' : ' (' + item.file + ')') + ': ' + item.message)
          if (lint.issues.length === 0) lines.push('  nothing to report')
        }

        return {
          ok: true,
          text: lines.join('\n'),
          view: {
            action: 'info',
            runtimes: [entry.id],
            run: lint === null ? undefined : lint.id,
            issues: lint === null ? undefined : lint.issues.length,
            summary: entry.id + ': ' + (detected.available ? 'ready' : 'not ready') + (lint === null ? '' : ', lint ' + (lint.ok ? 'clean' : 'failed')),
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // lab_new
  // -------------------------------------------------------------------------
  const create = {
    name: 'lab_new',
    description: [
      'Write a prototype into the lab. That is a real folder of real source: `<root>/<runtime>/<slug>/`, with the shell and the library a run needs to open, a README with the exact command that runs it, and a NOTES with the seed. `<root>` is the lab root `lab_open` reports (the Desktop by default), never a path guessed from here.',
      'action "create" (default) scaffolds a new run from the runtime\'s template. Give it a `concept`: one sentence saying what the algorithm IS, not what it looks like. Give `seed` to make the picture reproducible - with none, the seed is derived from the run id, so the same name always draws the same first frame.',
      'action "example" instantiates one of the runtime\'s committed examples (`lab_runtimes action=examples`) - a checked, known-good run - and then it is yours to change.',
      '`params` are the run\'s tunables: `[{ name: "particles", min: 200, max: 6000, value: 1800, step: 50 }]`. A p5 run turns each one into a live slider; an openFrameworks run records them for you to read in its Params struct.',
      'Nothing is ever deleted: an existing run is refused unless `overwrite: true`, and the workspace folder is created on demand. The lab is generated on this machine and is not committed - the plugin ships the generator, not your runs.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['runtime'],
      properties: {
        action: { type: 'string', enum: ['create', 'example'], description: '`create` (default) scaffolds from the template; `example` instantiates a shipped example.' },
        runtime: { type: 'string', description: 'The runtime id: `p5js` or `openframeworks` (`lab_runtimes action=list`).' },
        example: { type: 'string', description: 'For action=example: the example slug (`lab_runtimes action=examples`). Omit to take the first.' },
        slug: { type: 'string', description: 'The run\'s folder name: lower case letters, digits and single dashes. Defaults to a slug of `concept`.' },
        concept: { type: 'string', description: 'One sentence: what the algorithm is and what varies with the seed. Required to create a run.' },
        seed: { type: 'number', description: 'The integer the run seeds itself from. Defaults to a hash of the run id.' },
        params: {
          type: 'array',
          description: 'The tunables: { name, min, max, value, step }.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string' },
              min: { type: 'number' },
              max: { type: 'number' },
              value: { type: 'number' },
              step: { type: 'number' },
            },
          },
        },
        label: { type: 'string', description: 'A human title for the run. Defaults to the slug, title-cased.' },
        overwrite: { type: 'boolean', description: 'Replace an existing run folder. Off by default; the old files are overwritten, not merged.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'New prototype: ' + String(args.slug ?? args.example ?? args.concept ?? ''), kind: 'other' }),
    async execute(args, exec) {
      return run('lab_new', args, exec, async () => {
        const resolved = await rootFor(exec)
        const entry = runtimeOf(args.runtime)
        const action = args.action ?? 'create'
        const host = await machine({ env })

        // Everything either path needs, before anything is written.
        const concept = typeof args.concept === 'string' ? args.concept.trim() : ''
        let slug = typeof args.slug === 'string' && args.slug !== '' ? slugify(args.slug) : ''
        if (action === 'create' && concept === '' && slug === '') {
          throw new LabError('a run needs a `concept` (one sentence) or a `slug` to name it', 'NO_NAME')
        }
        if (action === 'create' && concept !== '' && slug === '') slug = slugify(concept, 48)
        if (slug === '') throw new LabError('that name reduces to no usable slug - use lower case letters and digits', 'NO_SLUG')

        // The three folders this lab owns, made together: runs, prints and apps are
        // one destination in a person's head even though they are three paths.
        await fsp.mkdir(resolved.root, { recursive: true })
        await fsp.mkdir(resolved.prints, { recursive: true })
        await fsp.mkdir(resolved.apps, { recursive: true })

        if (action === 'example') {
          const found = await entry.examples()
          if (found.length === 0) throw new LabError('the ' + entry.id + ' runtime ships no examples yet', 'NO_EXAMPLES')
          const wanted = typeof args.example === 'string' && args.example !== '' ? slugify(args.example) : null
          const chosen = wanted === null ? found[0] : found.find((item) => item.slug === wanted)
          if (chosen === undefined) {
            throw new LabError('no such example in ' + entry.id + ': ' + String(args.example) + ' - available: ' + found.map((item) => item.slug).join(', '), 'NO_EXAMPLE')
          }
          const useSlug = typeof args.slug === 'string' && args.slug !== '' ? slug : chosen.slug
          const result = await instantiateExample({ root: resolved.root, runtime: entry, example: chosen, slug: useSlug, overwrite: args.overwrite === true })
          const lines = []
          lines.push('Instantiated ' + entry.label + ' example "' + chosen.slug + '" as ' + result.run.id)
          lines.push('- folder: ' + result.run.dir)
          lines.push('- seed: ' + result.run.seed + '   concept: ' + result.run.concept)
          lines.push('- files: ' + result.run.files.join(', '))
          lines.push('- ' + sizeOf(result.run.bytes) + ' written')
          lines.push('')
          lines.push('Next: read it (`lab_read run=' + result.run.id + '`), make it yours, then `lab_lint run=' + result.run.id + '`.')
          return {
            ok: true,
            text: lines.join('\n'),
            view: {
              action,
              root: resolved.root,
              run: result.run.id,
              file: result.run.files.find((name) => name.endsWith('.js') || name.endsWith('.cpp')) ?? result.run.files[0],
              files: result.run.files,
              bytes: result.run.bytes,
              summary: 'instantiated ' + result.run.id,
            },
          }
        }

        const seed = Number.isInteger(args.seed) ? args.seed : seedFromName(entry.id + '/' + slug)
        const normalized = normalizeParams(args.params)
        // The runtime's own defaults, adapted to THIS host (a small machine gets a
        // smaller first population). A caller's params always win.
        const defaults = typeof entry.defaultParams === 'function' ? entry.defaultParams(host) : entry.defaultParams ?? []
        const params = normalized.params.length > 0 ? normalized.params : defaults
        const label = typeof args.label === 'string' && args.label !== '' ? args.label : labelFromSlug(slug)
        const result = await scaffoldRun({
          root: resolved.root,
          runtime: entry,
          slug,
          concept: concept === '' ? label : concept,
          label,
          seed,
          params,
          overwrite: args.overwrite === true,
          env,
        })

        const lines = []
        lines.push('Created ' + entry.label + ' run ' + result.run.id)
        lines.push('- folder: ' + result.run.dir)
        lines.push('- seed: ' + seed + (Number.isInteger(args.seed) ? ' (given)' : ' (derived from the run name, so this name always draws this picture)'))
        lines.push('- concept: ' + result.run.concept)
        lines.push('- files: ' + result.run.files.join(', '))
        lines.push('- ' + sizeOf(result.run.bytes) + ' written')
        if (normalized.dropped > 0) {
          lines.push('- ' + normalized.dropped + ' parameter(s) were dropped: a parameter needs a usable `name` and no duplicates')
        }
        lines.push('')
        lines.push('Next: `lab_read run=' + result.run.id + ' file=' + (result.run.files.includes('sketch.js') ? 'sketch.js' : 'src/ofApp.cpp') + '` to see the algorithm, edit it, then `lab_lint run=' + result.run.id + '`.')

        return {
          ok: true,
          text: lines.join('\n'),
          view: {
            action,
            root: resolved.root,
            run: result.run.id,
            file: result.run.files.includes('sketch.js') ? 'sketch.js' : result.run.files.find((name) => name.endsWith('.cpp')) ?? result.run.files[0],
            files: result.run.files,
            bytes: result.run.bytes,
            summary: 'created ' + result.run.id,
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // lab_read
  // -------------------------------------------------------------------------
  const read = {
    name: 'lab_read',
    description: [
      'Read a run: the listing and its catalog entry, or one file\'s text.',
      'With `file`: the file\'s contents (capped, and the answer says when it was truncated), its absolute path, its size and its sha256.',
      'Without `file`: every file in the run, what the catalog remembers about it, and the first few lines of its README so you know what you are looking at.',
      'A run is named `<runtime>/<slug>`, exactly as the lab\'s folder is.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: {
        run: { type: 'string', description: 'The run: `<runtime>/<slug>`, as returned by lab_new or printed by lab_open.' },
        file: { type: 'string', description: 'One file inside the run, relative to its folder (e.g. `sketch.js` or `src/ofApp.cpp`).' },
        maxChars: { type: 'number', description: 'Cap on the characters returned for one file (default 64000).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'Lab run ' + String(args.run ?? ''), kind: 'other' }),
    async execute(args, exec) {
      return run('lab_read', args, exec, async () => {
        const resolved = await rootFor(exec)
        const { catalog } = await readCatalog(resolved.root)
        if (typeof args.file === 'string' && args.file !== '') {
          const file = await readRunFile({
            root: resolved.root,
            run: args.run,
            file: args.file,
            maxBytes: Number.isFinite(Number(args.maxChars)) ? Math.max(1, Number(args.maxChars)) : READ_MAX_CHARS,
          })
          const lines = []
          lines.push('# ' + file.run + ' / ' + file.path)
          lines.push('- path: ' + file.absolute)
          lines.push('- ' + sizeOf(file.bytes) + '  sha256 ' + file.sha256.slice(0, 16) + '…' + (file.truncated ? '  (TRUNCATED in this answer)' : ''))
          lines.push('')
          lines.push('```')
          lines.push(file.text.replace(/\s+$/, ''))
          lines.push('```')
          return {
            ok: true,
            text: lines.join('\n'),
            view: { root: resolved.root, run: file.run, file: file.path, bytes: file.bytes, summary: file.path + ', ' + sizeOf(file.bytes) },
          }
        }

        const listing = await readRun(resolved.root, args.run, catalog)
        const lines = []
        lines.push('# ' + listing.id)
        lines.push('- folder: ' + listing.dir)
        if (!listing.exists) {
          lines.push('- this run is not on disk (the catalog' + (listing.entry === null ? ' has no entry for it either' : ' still remembers it') + ')')
          lines.push('')
          lines.push('Write it with `lab_new`, or list what exists with `lab_open`.')
          return { ok: true, text: lines.join('\n'), view: { root: resolved.root, run: listing.id, runs: 0, summary: 'not on disk' } }
        }
        lines.push('- ' + listing.files.length + ' file(s), ' + sizeOf(listing.bytes))
        if (listing.entry !== null) {
          const entry = listing.entry
          lines.push('- catalog: seed ' + String(entry.seed) + ', made ' + String(entry.created) + (entry.example === null || entry.example === undefined ? '' : ', from example "' + String(entry.example) + '"'))
          if (typeof entry.concept === 'string' && entry.concept !== '') lines.push('- concept: ' + entry.concept)
        } else {
          lines.push('- catalog: no entry for this run (it was made by hand, or the catalog was reset)')
        }
        lines.push('')
        lines.push('Files')
        for (const file of listing.files) lines.push('- ' + file)
        const readme = listing.files.find((name) => name === 'README.md')
        if (readme !== undefined) {
          const text = await fsp.readFile(path.join(listing.dir, readme), 'utf8')
          lines.push('')
          lines.push('README, first lines')
          lines.push('')
          lines.push('```')
          lines.push(text.split('\n').slice(0, 18).join('\n'))
          lines.push('```')
        }
        lines.push('')
        lines.push('Read one file with `lab_read run=' + listing.id + ' file=' + (listing.files.includes('sketch.js') ? 'sketch.js' : listing.files.find((name) => name.endsWith('.cpp')) ?? listing.files[0]) + '`.')
        return {
          ok: true,
          text: lines.join('\n'),
          view: { root: resolved.root, run: listing.id, files: listing.files, bytes: listing.bytes, summary: listing.files.length + ' file(s)' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // lab_lint
  // -------------------------------------------------------------------------
  const lint = {
    name: 'lab_lint',
    description: [
      'Judge a run against its own runtime, and against the lab\'s rules. Run it after editing anything - it is the difference between "the file is written" and "the prototype still works".',
      'Without `run`: lint EVERY run in the lab and report only the ones with problems. That is the check to run before saying a lab is in good shape.',
      'A p5 run is judged on its shell, its library, its `setup()`/`draw()`, whether it seeds itself, and whether it reaches for anything on the network. An openFrameworks run is judged on the three C++ files - and COMPILED (`g++ -fsyntax-only`) when openFrameworks is installed; without an install the answer says so instead of pretending the C++ was checked.',
      'Errors are things that are broken. Warnings are things that are not what this lab does - a stray file, a missing `window.__LAB.drew`, a run whose catalog entry has drifted.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run: { type: 'string', description: 'One run (`<runtime>/<slug>`). Omit to lint every run in the lab.' },
        runtime: { type: 'string', description: 'With no `run`: lint only this runtime\'s runs.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: args.run === undefined ? 'Lint the lab' : 'Lint ' + String(args.run), kind: 'other' }),
    async execute(args, exec) {
      return run('lab_lint', args, exec, async () => {
        const resolved = await rootFor(exec)
        const { catalog } = await readCatalog(resolved.root)
        const { runs } = await listRuns(resolved.root)
        if (runs.length === 0) {
          return {
            ok: true,
            text: 'The lab has no runs yet (' + resolved.root + ').\n\nNext: `lab_new runtime=p5js concept="..."` writes one.',
            view: { root: resolved.root, runs: 0, issues: 0, summary: 'nothing to lint' },
          }
        }

        const targets =
          typeof args.run === 'string' && args.run !== ''
            ? runs.filter((item) => item.id === args.run)
            : typeof args.runtime === 'string' && args.runtime !== ''
              ? runs.filter((item) => item.runtime === args.runtime)
              : runs
        if (targets.length === 0) {
          throw new LabError('no such run in this lab: ' + String(args.run ?? args.runtime) + ' - `lab_open` lists what is here', 'NO_SUCH_RUN')
        }

        const reports = []
        const host = await machine({ env })
        for (const target of targets) {
          const entry = runtimeOf(target.runtime)
          reports.push(await lintRun({ root: resolved.root, runtime: entry, run: target.id, catalog, env, machine: host }))
        }
        const failed = reports.filter((report) => !report.ok)
        const withWarnings = reports.filter((report) => report.ok && report.issues.length > 0)
        const lines = []
        lines.push('Lab lint — ' + reports.length + ' run(s) under ' + resolved.root)
        lines.push('')
        for (const report of reports) {
          const errors = report.issues.filter((item) => item.severity === 'error').length
          const warnings = report.issues.length - errors
          lines.push('- ' + report.id + ': ' + (errors === 0 ? (warnings === 0 ? 'clean' : 'ok, ' + warnings + ' warning(s)') : errors + ' error(s)' + (warnings === 0 ? '' : ', ' + warnings + ' warning(s)')))
          for (const item of report.issues) {
            lines.push('    [' + item.severity + '] ' + item.code + (item.file === null ? '' : ' (' + item.file + ')') + ': ' + item.message)
          }
        }
        lines.push('')
        lines.push(
          failed.length === 0
            ? 'Every run is sound.' + (withWarnings.length === 0 ? '' : ' ' + withWarnings.length + ' have warnings: they work, but they are not what this lab does.')
            : failed.length + ' run(s) have errors. Fix them in place, then run `lab_lint` again.',
        )
        return {
          ok: true,
          text: lines.join('\n'),
          view: {
            root: resolved.root,
            run: typeof args.run === 'string' ? args.run : undefined,
            runs: reports.length,
            issues: reports.reduce((total, report) => total + report.issues.length, 0),
            summary: failed.length === 0 ? 'clean' : failed.length + ' failing',
          },
        }
      })
    },
  }

  return [open, runtimeTool, create, read, lint]
}

/** Exported for the tracked checks: the names are the package's contract. */
export const TOOL_NAMES = ['lab_open', 'lab_runtimes', 'lab_new', 'lab_read', 'lab_lint']

/** Re-exported so a check can name the tiers without a second import. */
export { TIERS, throughTier, BUDGETS }
