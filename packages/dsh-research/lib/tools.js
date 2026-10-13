/**
 * dsh-research — the tools the agent calls.
 *
 * The surface is organised by INTENT, which is this pack's rule and not a style
 * preference: a model choosing among `rs_status`, `rs_show`, `rs_info` and
 * `rs_list` spends its attention on the choice instead of on the research. Each
 * tool answers ONE question, and each has a different PERMISSION - which is why
 * there is one per verb rather than one per noun:
 *
 *   - `rs_open`  — where do runs live, what is in each, and where does THIS one
 *                  stand (including what the ledger says, quoted verbatim)
 *   - `rs_new`   — start a run, and open the two frame gates
 *   - `rs_plan`  — the question, the outline, the method: the agent's own work
 *   - `rs_read`  — show me one: its view, gates, passport, files, claims,
 *                  sources, outline, build, or one text file of it
 *   - `rs_write` — write prose AND declare the claims it makes, together
 *   - `rs_cite`  — ingest a source: hash the bytes, store the record and the text
 *   - `rs_build` — build it, as a watermarked draft or as a gated clean document
 *
 * Two deliberate absences, both of them this pack's judgement about attention:
 * there is no `rs_status` (it is `rs_open action=status`) and there is no
 * `rs_delete` (a run is a folder a person owns; no tool of this plugin deletes
 * anything).
 *
 * Two things every answer does, because the model reads the answer and not this
 * file: it names the ABSOLUTE path of what it touched (a relative path is useless
 * the moment the answer is quoted into another turn), and it says what to do next
 * in one line. And every answer that involves a gate says the gate is unanswered
 * - loudly, with the tool call or the panel that answers it - because a run whose
 * frame gates are pending must never read as ready to write.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  ALL_GATES,
  PASSPORT_FILE,
  ResearchError,
  ROOT_ENV,
  RUN_KINDS,
  STRUCTURES,
  STYLES,
  addReceipt,
  answerOf,
  canonicalRoot,
  createRun,
  gateViews,
  insideRoot,
  messageOf,
  pendingGates,
  projectView,
  readPassport,
  readRun,
  readRunText,
  resolveRoot,
  sizeOf,
  stateView,
  touchRun,
  writeJsonAtomic,
  writeTextAtomic,
} from './run.js'
import {
  appendClaim,
  appendSource,
  applyFindings,
  attachToSource,
  claimStatusOf,
  claimsById,
  readClaims,
  readSources,
  recordVerdict,
  sourcesByKey,
  sourceFilePath,
  sourceTextPath,
} from './ledger.js'
import { STRENGTHS, STATISTIC_FIELDS, findBrokenCitations, locatorLabel, nextClaimId, statisticLabel } from './syntax.js'
import { assembleDocument, parseOutline, scanDocument, validateStructure, wordCount } from './doc.js'
import { METHOD_FILE, METHOD_MD, METHOD_REQUIRED, methodSummary, normalizeMethod, readMethodRecord, renderMethodMd } from './method.js'
import { FORMATS, FORMATS_DOCUMENT, FORMATS_READY, combineReports, ensureIntegrityGate, hashOf, loadRefs, loadStyles, readRunState, runBuild, writeBuildReport } from './build.js'
import { API_ROUTES } from './api.js'
import { ladderReport, r1Sources, r2Claims } from './verify.js'
import {
  CONCESSION_MAX,
  CONCESSION_THRESHOLD,
  REVIEW_CRITERIA,
  REVIEW_ROLES,
  REVIEW_SEVERITIES,
  advocateHealth,
  answerFinding,
  concede,
  latestRound,
  matrix,
  raiseAttack,
  readReviewRows,
  recordFindings,
  renderMatrix,
  renderPanel,
  rereviewFinding,
} from './review.js'

/** Every tool this package registers, for the row's log line and the tracked checks. */
export const TOOL_NAMES = ['rs_open', 'rs_new', 'rs_plan', 'rs_read', 'rs_write', 'rs_cite', 'rs_verify', 'rs_review', 'rs_build']

/** The view schema every tool's `view` conforms to. The conversation card draws this. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    action: { type: 'string' },
    slug: { type: 'string' },
    root: { type: 'string' },
    stage: { type: 'string' },
    runs: { type: 'number' },
    pending: { type: 'number' },
    gates: { type: 'array', items: { type: 'string' } },
    files: { type: 'number' },
    chars: { type: 'number' },
    ms: { type: 'number' },
    code: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['ok'],
}

/** The workspace a call runs in: the session's own cwd, else the process's. */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.meta?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** How a run's stage reads in prose. The ledger decides the stage; this names it. */
const STAGE_TEXT = {
  new: 'new - nothing has been confirmed yet, and both frame gates are pending',
  framing: 'framing - one frame gate is answered and one is still pending',
  framed: 'framed - both frame gates are answered and recorded verbatim',
}

/**
 * Build the three tools against one environment.
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

  /**
   * Wrap one tool body.
   *
   * A refusal (`ResearchError`) is an ANSWER, not a crash: it comes back with its
   * own code in the card, so a model that asked for something this plugin will not
   * do learns which rule it hit instead of reading a stack trace. Anything else is
   * logged and reported as a failure, because an unexpected throw is a bug in this
   * plugin and should look like one.
   */
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
      const refusal = err instanceof ResearchError
      if (!refusal) log.warn(name + ' failed: ' + message)
      return {
        text: (refusal ? 'Refused (' + err.code + '): ' : name + ' failed: ') + message,
        view: { ok: false, tool: name, ms: Date.now() - started, ...(refusal ? { code: err.code } : {}), summary: message },
      }
    }
  }

  /** The root for this call, canonicalized once. */
  const rootFor = async (exec) => {
    const resolved = await resolveRoot({ env, workspace: workspaceOf(exec) })
    return { ...resolved, root: await canonicalRoot(resolved.root) }
  }

  /** The one line that says where a person looks at this run. */
  const lookLine = (slug) => 'Look at it in the right bar: the Research tab (`' + slug + '`). Gates are answered there, not here.'

  /** What this build offers, reported by every `rs_open` answer that lists it. */
  const capabilities = { tools: TOOL_NAMES, routes: API_ROUTES, formats: FORMATS_READY }

  // -------------------------------------------------------------------------
  // rs_open
  // -------------------------------------------------------------------------
  const open = {
    name: 'rs_open',
    description: [
      'Where research runs live on this machine, what is in each one, and where a named run stands.',
      'A run is a FOLDER: `<root>/<slug>/` with `RUN.json` (what it is) and `passport.json` (what the human decided, in their own words). The root is `$DSH_RESEARCH_ROOT`, else `<Desktop>/vncode-research`, else `<workspace>/research`.',
      'Call this first in a session, and again after any pause or compaction: with `action=handoff` it prints the ledger BACK - the original instructions and every gate answer in the user\'s exact words - so a summary written by a model is never mistaken for what the user actually said.',
      'This plugin opens no socket and starts no process: it reads and writes files inside the run folder and nothing else.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'roots', 'list', 'handoff', 'capabilities'],
          description:
            '`status` (default, needs `slug`) is one run and its gates; `list` is every run with its stage; `roots` is where runs live and why; `handoff` reprints the ledger verbatim; `capabilities` is what this build offers.',
        },
        slug: { type: 'string', description: 'The run to report on. Required for `status` and `handoff`.' },
      },
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_open', args, exec, async () => {
        const action = args.action ?? 'status'
        const resolved = await rootFor(exec)
        const state = await stateView({ env, workspace: workspaceOf(exec), ...capabilities })

        if (action === 'capabilities') {
          const styles = (await loadStyles()).STYLES
          const lines = [
            'What this build of dsh-research offers',
            '- tools: ' + capabilities.tools.join(', '),
            '- routes: ' + capabilities.routes.join(', '),
            '- build formats ready now: ' + capabilities.formats.join(', ') + ' (every format this plugin advertises is implemented; `tex` writes the file and PRINTS the pdflatex command rather than running it)',
            '- citation styles: ' + styles.join(', '),
            '- gates: ' + GATE_IDS.join(', ') + ' (the first two frame a run; `g3-integrity` is opened by a clean build)',
            '- document syntax: `[sentence]{#c0142}` for a claim, `[@key]` / `[@key, p. 7]` / `[-@key]` for a citation',
            '- claim strengths: ' + STRENGTHS.join(', ') + ' (the design has to be able to carry the one you pick)',
            '- claim statistics: { ' + STATISTIC_FIELDS.join(', ') + ' } - recorded as data, printed as the document\'s Statistics table, and `p = .000` is refused',
            '- method record: ' + METHOD_FILE + ' holds { ' + METHOD_REQUIRED.join(', ') + ' }, validated on the way in and by r0, and printed as the document\'s search-and-screening flow',
            '- it opens no socket and spawns no process: sources arrive as files you already have',
          ]
          return {
            text: lines.join('\n'),
            view: { action, root: resolved.root, runs: state.runs.length, gates: GATE_IDS, summary: capabilities.tools.length + ' tools, ' + capabilities.formats.length + ' formats' },
          }
        }

        if (action === 'roots') {
          const why =
            resolved.source === 'env'
              ? ROOT_ENV + ' is set, so this root was chosen explicitly'
              : resolved.source === 'desktop'
                ? 'the DESKTOP (' + path.dirname(resolved.root) + ') - a document is something a person keeps and hands to a journal, so by default it lands where they can see it'
                : 'the workspace (' + resolved.workspace + ') - there is no Desktop on this machine'
          const lines = [
            'Research runs',
            '- root: ' + resolved.root + (state.root.exists ? '' : '  (does not exist yet - `rs_new` makes it)'),
            '- chosen because: ' + why,
            '- runs on disk: ' + state.runs.length,
            '- workspace: ' + resolved.workspace,
            // The library pointer is the answer to "will this still be here in
            // another session, from another folder?" - so it is stated, with the
            // file a person can look at and the two ways to change it.
            '- library pointer: ' + resolved.pointer + (resolved.remembered ? '  (this session read the root from it)' : '  (written just now, so every later session agrees)'),
            '- runs are opened by name from ANY session: the pointer names the folder, and a run is a folder inside it',
            '- ' + ROOT_ENV + ' overrides all of it (a relative value resolves against the workspace)',
            '- this plugin opens no socket: a source is a file you or the agent already has, never something this plugin fetches',
          ]
          if (resolved.override !== null) lines.splice(4, 0, '- the override was remembered too, so a session without it still finds the same folder')
          for (const note of state.notes) lines.push('- note: ' + note)
          lines.push('')
          lines.push('Next: `rs_open action=list` for what is here, or `rs_new` to start a run.')
          return {
            text: lines.join('\n'),
            view: { action, root: resolved.root, runs: state.runs.length, summary: state.runs.length + ' run(s) under ' + resolved.root },
          }
        }

        if (action === 'list') {
          const lines = ['Research runs under ' + resolved.root]
          if (state.runs.length === 0) {
            lines.push('  (none yet)')
            lines.push('')
            lines.push('Next: `rs_new slug=<slug> title="<title>" kind=paper instruction="<the user\'s own words>"`.')
          } else {
            for (const item of state.runs) {
              lines.push(
                '  ' + item.slug + '  [' + item.kind + ', ' + item.style + ', ' + item.language + ']  ' +
                  item.stage +
                  (item.gates.pending > 0 ? '  ' + item.gates.pending + ' gate(s) WAITING ON YOU' : '') +
                  '  ' + item.files + ' file(s)',
              )
              lines.push('      ' + item.title)
            }
            lines.push('')
            lines.push('Next: `rs_open action=status slug=<slug>`, or open the Research tab in the right bar.')
          }
          for (const note of state.notes) lines.push('- note: ' + note)
          return {
            text: lines.join('\n'),
            view: {
              action,
              root: resolved.root,
              runs: state.runs.length,
              pending: state.runs.reduce((total, item) => total + item.gates.pending, 0),
              summary: state.runs.length + ' run(s), ' + state.runs.filter((item) => item.gates.pending > 0).length + ' with a gate waiting',
            },
          }
        }

        const slug = String(args.slug ?? '').trim()
        if (slug === '') {
          throw new ResearchError('BAD_SLUG', 'action=' + action + ' needs a `slug`; use `action=list` to see them')
        }
        const { dir, record } = await readRun(resolved.root, slug)
        const { passport } = await readPassport(resolved.root, slug)

        if (action === 'handoff') {
          const lines = [
            'The ledger for ' + slug + ', in the user\'s own words - read this before relying on any summary of it.',
            '',
            'Instructions as recorded (' + passport.instructions.length + '):',
          ]
          if (passport.instructions.length === 0) lines.push('  (none recorded - the run was created without the instruction text)')
          for (const entry of passport.instructions) lines.push('  [' + entry.at + '] ' + entry.verbatim)
          lines.push('')
          lines.push('Gate answers as recorded:')
          for (const gate of gateViews(passport)) {
            if (gate.answer === null) {
              lines.push('  ' + gate.id + ': NOT ANSWERED - ' + gate.question)
              continue
            }
            lines.push('  ' + gate.id + ' [' + gate.answer.at + '] -> ' + gate.answer.value)
            if (gate.answer.text !== '') lines.push('      in their words: ' + gate.answer.text)
            if (gate.answer.reason !== '') lines.push('      reason: ' + gate.answer.reason)
          }
          lines.push('')
          lines.push('Receipts (' + passport.receipts.length + '):')
          for (const entry of passport.receipts.slice(-20)) lines.push('  [' + entry.at + '] ' + entry.tool + ': ' + entry.summary)
          if (passport.receipts.length > 20) lines.push('  ... and ' + (passport.receipts.length - 20) + ' earlier')
          return {
            text: lines.join('\n'),
            view: {
              action,
              slug,
              root: resolved.root,
              gates: gateViews(passport).map((gate) => gate.id + '=' + (gate.answer === null ? 'pending' : gate.answer.value)),
              summary: passport.instructions.length + ' instruction(s), ' + passport.gates.length + ' gate answer(s) recorded',
            },
          }
        }

        const project = await projectView({ env, workspace: workspaceOf(exec), slug })
        const pending = pendingGates(passport)
        const lines = [
          'Run ' + slug + ' - ' + project.run.title,
          '- path: ' + dir,
          '- kind: ' + project.run.kind + '  structure: ' + project.run.structure + '  style: ' + project.run.style + '  language: ' + project.run.language,
          '- created: ' + project.run.created + '  updated: ' + project.run.updated,
          '- stage: ' + STAGE_TEXT[project.run.stage],
          '- files: ' + project.files.length,
          '- ledger: ' +
            (project.ledger.claims === null ? 'no claim ledger yet' : project.ledger.claims + ' claim(s)') +
            ', ' +
            (project.ledger.sources === null ? 'no source ledger yet' : project.ledger.sources + ' source(s)'),
        ]
        if (pending.length > 0) {
          lines.push('')
          lines.push('WAITING ON YOU - ' + pending.length + ' gate(s). The agent must not answer these:')
          for (const gate of pending) {
            lines.push('  ' + gate.id + ': ' + gate.question)
            for (const option of gate.options) lines.push('      - ' + option.value + ': ' + option.label)
            if (gate.requiresText) lines.push('      (this one needs YOUR words in the answer box, even for a plain yes or no)')
          }
          lines.push('')
          lines.push(lookLine(slug))
        }
        for (const note of project.notes) lines.push('- note: ' + note)
        return {
          text: lines.join('\n'),
          view: {
            action,
            slug,
            root: resolved.root,
            stage: project.run.stage,
            pending: pending.length,
            gates: pending.map((gate) => gate.id),
            files: project.files.length,
            summary: project.run.title,
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_new
  // -------------------------------------------------------------------------
  const create = {
    name: 'rs_new',
    description: [
      'Start a research run: a folder holding the plan, the document and the ledgers, with two frame gates opened for the HUMAN to answer.',
      '`instruction` is the user\'s own request, recorded verbatim in the passport - put their words there, not a paraphrase of them, because that text is what gets quoted back after every pause and compaction.',
      'The two gates are opened, never answered, by this tool: `g1-rq` (is this the question, and is it yours?) and `g2-intake` (does this document report experiments YOU ran?). They are answered by the person, in the right bar\'s Research tab or over `POST /api/dsh-research/gate` - an agent answering `g2-intake` on a human\'s behalf would make the whole ledger worthless, so the tool refuses to.',
      'Nothing is fetched and nothing is installed: this writes a folder and stops.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Identity and folder name: 3-64 chars of lowercase letters, digits and dashes.' },
        title: { type: 'string', description: 'The document\'s own name, as it should appear on the first page.' },
        kind: {
          type: 'string',
          enum: RUN_KINDS,
          description: 'What kind of document this is (default `paper`). Each kind maps to a structure the writing skill teaches.',
        },
        language: { type: 'string', description: 'Language tag like `en` or `pt-br` (default `en`).' },
        style: { type: 'string', enum: STYLES, description: 'Citation style (default `apa7`). Six are supported; anything else is refused now rather than at the last build.' },
        structure: { type: 'string', enum: STRUCTURES, description: 'Document structure. Defaults to the one this kind implies.' },
        instruction: { type: 'string', description: 'The user\'s own words asking for this run. Recorded verbatim as the ledger\'s first entry.' },
      },
      required: ['slug', 'title'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research run', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_new', args, exec, async () => {
        const resolved = await rootFor(exec)
        const created = await createRun({
          root: resolved.root,
          slug: args.slug,
          title: args.title,
          kind: args.kind,
          language: args.language,
          style: args.style,
          structure: args.structure,
          instruction: args.instruction,
        })
        const gates = gateViews(created.passport)
        const lines = [
          'Created run ' + created.slug + ' - ' + created.record.title,
          '- path: ' + created.dir,
          '- kind: ' + created.record.kind + '  structure: ' + created.record.structure + '  style: ' + created.record.style + '  language: ' + created.record.language,
          '- folders: plan/ doc/ ledger/ sources/ figures/ reviews/ build/',
          '',
          'TWO GATES ARE NOW WAITING ON THE USER. Do not answer them, and do not write the document past the frame until they are answered:',
        ]
        for (const gate of gates) {
          lines.push('  ' + gate.id + ': ' + gate.question)
          for (const option of gate.options) lines.push('      - ' + option.value + ': ' + option.label)
        }
        lines.push('')
        lines.push('Tell the user this, then stop: ' + lookLine(created.slug))
        return {
          text: lines.join('\n'),
          view: {
            action: 'new',
            slug: created.slug,
            root: created.root,
            stage: 'new',
            pending: gates.length,
            gates: gates.map((gate) => gate.id),
            files: 2,
            summary: created.record.title,
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_read
  // -------------------------------------------------------------------------
  const read = {
    name: 'rs_read',
    description: [
      'Show one research run: the whole view, its gate ledger, the passport\'s provenance, the file list, or one text file inside it.',
      'This is the ONLY reader. `rs_open` reports where things are and where a run stands; this shows the contents, so a model never has to guess a path or reach for a filesystem read that would skip the run\'s containment.',
      'A binary file is refused by name rather than returned as mojibake - a PDF stored as a source is read with the `pdf_*` tools, and `ocr` covers a scan.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run to read.' },
        what: {
          type: 'string',
          enum: ['run', 'gates', 'passport', 'files', 'claims', 'sources', 'outline', 'build', 'file'],
          description: '`run` (default) is the whole view; `claims`, `sources`, `outline` and `build` are the ledgers and the last build; `file` needs `file`.',
        },
        file: { type: 'string', description: 'For `what=file`: a path RELATIVE to the run folder, e.g. `doc/paper.md`.' },
        maxChars: { type: 'number', description: 'For `what=file`: how many characters to return (default 40000, max 200000).' },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research run', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_read', args, exec, async () => {
        const what = args.what ?? 'run'
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()

        if (what === 'file') {
          const answer = await readRunText({ env, workspace: workspaceOf(exec), slug, file: args.file, maxChars: args.maxChars })
          const text = [
            answer.file + '  (' + sizeOf(answer.bytes) + (answer.truncated ? ', showing the first ' + answer.chars + ' characters' : '') + ')',
            '',
            answer.text,
          ].join('\n')
          return {
            text,
            view: { action: 'file', slug: answer.slug, root: resolved.root, chars: answer.chars, summary: answer.file },
          }
        }

        const project = await projectView({ env, workspace: workspaceOf(exec), slug })
        const lines = ['Run ' + project.run.slug + ' - ' + project.run.title, '- path: ' + project.run.path]

        if (what === 'files') {
          lines.push('- ' + project.files.length + ' file(s):')
          for (const file of project.files) lines.push('    ' + file.path + '  (' + sizeOf(file.bytes) + ')')
        } else if (what === 'gates') {
          lines.push('')
          for (const gate of project.gates) {
            lines.push(gate.id + (gate.answer === null ? '  PENDING' : '  answered ' + gate.answer.at))
            lines.push('  q: ' + gate.question)
            for (const option of gate.options) lines.push('    - ' + option.value + ': ' + option.label + (option.overrides === true ? '  [needs a reason]' : ''))
            if (gate.answer !== null) {
              lines.push('  A: ' + gate.answer.value)
              if (gate.answer.text !== '') lines.push('     in their words: ' + gate.answer.text)
              if (gate.answer.reason !== '') lines.push('     reason: ' + gate.answer.reason)
            }
          }
        } else if (what === 'passport') {
          lines.push('- stage: ' + project.run.stage)
          lines.push('')
          lines.push('Instructions as recorded, verbatim:')
          for (const entry of project.passport.instructions) lines.push('  [' + entry.at + '] ' + entry.verbatim)
          if (project.passport.instructions.length === 0) lines.push('  (none recorded)')
          lines.push('')
          lines.push('Receipts:')
          for (const entry of project.passport.receipts) lines.push('  [' + entry.at + '] ' + entry.tool + ': ' + entry.summary)
        } else if (what === 'claims') {
          const { current: claims } = await readClaims(path.join(resolved.root, project.run.slug))
          lines.push('- ' + claims.length + ' claim(s) currently in the ledger')
          if (claims.length === 0) lines.push('  (none yet - a claim is a `[sentence]{#cNNNN}` span declared with `rs_write`)')
          for (const row of claims) {
            const bindings = Array.isArray(row.sources) ? row.sources : []
            lines.push(
              '  ' + row.id + '  [' + claimStatusOf(row) + (row.tier === null || row.tier === undefined ? '' : ' at ' + row.tier) + ']  ' +
                (row.section === '' ? '(no section)' : row.section) + '  written as ' + String(row.strength ?? 'descriptive'),
            )
            lines.push('      ' + String(row.text ?? '').slice(0, 300))
            for (const binding of bindings) {
              lines.push('      ← ' + binding.key + (binding.locator === null || binding.locator === undefined ? ' (no locator)' : '  ' + locatorLabel(binding.locator)))
            }
            if (row.reason !== undefined && row.reason !== null && row.reason !== '') lines.push('      judge: ' + String(row.reason).slice(0, 300))
          }
        } else if (what === 'sources') {
          const { current: sources } = await readSources(path.join(resolved.root, project.run.slug))
          lines.push('- ' + sources.length + ' source(s) currently in the ledger')
          if (sources.length === 0) lines.push('  (none yet - ingest one with `rs_cite action=add`)')
          for (const one of sources) {
            const files = Array.isArray(one.files) ? one.files.length : 0
            lines.push(
              '  ' + one.key + '  [' + one.kind + ']  ' + (one.year === '' ? 'n.d.' : one.year) + '  ' +
                (files === 0 ? 'NO BYTES' : files + ' file(s)') + (one.text === undefined ? ', NO TEXT' : ', text from ' + String(one.text.source ?? 'unknown')),
            )
            lines.push('      ' + one.title)
          }
        } else if (what === 'outline') {
          const document = await assembleDocument(path.join(resolved.root, project.run.slug))
          const scan = scanDocument(document.text)
          lines.push('- assembled from: ' + document.source + (document.parts.length > 0 ? ' (' + document.parts.map((one) => one.file).join(', ') + ')' : ''))
          lines.push('- words: ' + scan.words + '   claims: ' + scan.spans.length + '   citations: ' + scan.citationKeys.length)
          lines.push('')
          for (const section of scan.sections) {
            lines.push('  ' + (section.level === 0 ? '(preamble)' : '#'.repeat(section.level) + ' ' + section.title) + '  [' + section.slug + ']  ' + section.words + ' words, ' + section.claims.length + ' claim(s)')
          }
          if (scan.sections.length === 0) lines.push('  (nothing written yet)')
        } else if (what === 'build') {
          const report = await fsp
            .readFile(path.join(resolved.root, project.run.slug, 'build', 'build.json'), 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => null)
          if (report === null) {
            lines.push('- no build yet for this run')
          } else {
            lines.push('- last build: ' + report.at + '  (' + report.draft + ', ' + report.format + ', ' + report.style + ')')
            lines.push('- document: ' + report.document.source + ', ' + report.document.words + ' words, sha256 ' + String(report.source && report.source.sha256).slice(0, 12) + '…')
            lines.push('- claims: ' + report.claims.total + '  ' + Object.entries(report.claims.byStatus).filter(([, count]) => count > 0).map(([status, count]) => count + ' ' + status).join(', '))
            lines.push('- structure: ' + (report.structure.ok ? 'agreed with the ledger' : report.structure.errors.join(', ')))
            for (const output of report.outputs) lines.push('  ' + output.path + '  ' + sizeOf(output.bytes) + '  sha256 ' + String(output.sha256).slice(0, 12) + '…')
          }
        } else {
          const pending = project.gates.filter((gate) => gate.answer === null)
          lines.push('- kind: ' + project.run.kind + '  style: ' + project.run.style + '  language: ' + project.run.language)
          lines.push('- stage: ' + STAGE_TEXT[project.run.stage])
          lines.push('- gates: ' + (project.gates.length - pending.length) + ' answered, ' + pending.length + ' pending')
          lines.push('- files: ' + project.files.length + '   ledger: ' +
            (project.ledger.claims === null ? 'no claims yet' : project.ledger.claims + ' claims') + ', ' +
            (project.ledger.sources === null ? 'no sources yet' : project.ledger.sources + ' sources'))
          const document = await assembleDocument(path.join(resolved.root, project.run.slug))
          if (document.text.trim() !== '') {
            const structure = validateStructure({
              text: document.text,
              claims: (await readClaims(path.join(resolved.root, project.run.slug))).current,
              sourcesByKey: sourcesByKey((await readSources(path.join(resolved.root, project.run.slug))).current),
            })
            lines.push('- document: ' + wordCount(document.text) + ' words, ' + (structure.ok ? 'agrees with the ledger' : structure.errors.length + ' structure error(s): ' + structure.errors.map((one) => one.code).join(', ')))
          }
          if (pending.length > 0) lines.push('- WAITING ON YOU: ' + pending.map((gate) => gate.id).join(', ') + ' - ' + lookLine(project.run.slug))
        }
        for (const note of project.notes) lines.push('- note: ' + note)
        return {
          text: lines.join('\n'),
          view: {
            action: what,
            slug: project.run.slug,
            root: resolved.root,
            stage: project.run.stage,
            pending: project.gates.filter((gate) => gate.answer === null).length,
            files: project.files.length,
            summary: project.run.title,
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_plan
  // -------------------------------------------------------------------------
  const plan = {
    name: 'rs_plan',
    description: [
      'The run\'s plan: the research question (`part=rq`), the section outline (`part=outline`), the method (`part=method`).',
      'Written to `plan/<part>.md` inside the run. The outline is the one part with a machine meaning: lines of the form `- <slug>: <title>` order the section files at build time, and a section file no line names is appended to the end rather than dropped.',
      '`part=method` ALSO takes a `method` OBJECT - the record of the search itself: `{ databases, accessed, search, include, exclude, screening: { identified, screened, included } }`. Give it and the record is written to `plan/method.json` and `plan/method.md` is regenerated from it; the counts are checked (records are removed at each step, never added) and the date has to be a real one. A record is what makes a search reproducible and what the document\'s own search-and-screening flow is printed from, so a `part=method` written as prose alone is a sentence nobody can check.',
      'A plan is the agent\'s own work, so this tool has NO gate: nothing in it is a claim and nothing in it is published. The frame gates block the DOCUMENT, and `rs_write` is where that shows.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        action: { type: 'string', enum: ['write', 'read'], description: '`write` (default) stores text; `read` returns what is there.' },
        part: { type: 'string', enum: ['rq', 'outline', 'method'], description: 'Which part of the plan.' },
        text: { type: 'string', description: 'For `write`: the Markdown. For `part=method`, a `method` object is the record and this is prose on top of it.' },
        method: { type: 'object', description: 'For `part=method`: the search record - databases (list), accessed (YYYY-MM-DD), search (the query as run), include (list), exclude (list), screening ({ identified, screened, included }), plus optional registration, platforms, notes.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '`replace` (default) or `append`.' },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research plan', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_plan', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const part = args.part ?? 'rq'
        if (!['rq', 'outline', 'method'].includes(part)) {
          throw new ResearchError('BAD_PART', 'part must be rq, outline or method (got ' + JSON.stringify(String(part)) + ')')
        }
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const target = path.join(dir, 'plan', part + '.md')
        const relative = 'plan/' + part + '.md'
        const action = args.action ?? 'write'

        if (action === 'read') {
          const existing = await fsp.readFile(target, 'utf8').catch(() => null)
          // `part=method` has TWO files: the record r0 validates and the prose view
          // generated from it. Reporting only the Markdown would hide the one that
          // actually carries the search, so the record is reported first.
          const methodState = part === 'method' ? await readMethodRecord(dir) : null
          const recordLine =
            methodState === null
              ? null
              : methodState.record === null || methodState.record === undefined
                ? METHOD_FILE + ': not recorded yet - `rs_plan slug=' + slug + ' part=method method={…}` writes it'
                : METHOD_FILE + ': ' + methodSummary(methodState.record) + (methodState.problem === null ? '' : ' (UNREADABLE: ' + methodState.problem.detail + ')')
          const head = recordLine === null ? '' : recordLine + '\n\n'
          if (existing === null) {
            return {
              text: head + relative + ' does not exist yet for ' + slug + '. Write it with `rs_plan part=' + part + ' text="…"`.',
              view: { action, slug, root: resolved.root, summary: 'no ' + part + ' yet' },
            }
          }
          return {
            text: head + relative + ' (' + sizeOf(Buffer.byteLength(existing)) + ', ' + wordCount(existing) + ' words)\n\n' + existing.slice(0, 40_000),
            view: { action, slug, root: resolved.root, chars: existing.length, summary: relative },
          }
        }

        // ---- the method RECORD, when one was given
        if (part === 'method' && args.method !== null && args.method !== undefined) {
          // NOT named `record`: that name is the RUN's record in this scope, and
          // shadowing it here wrote the method over RUN.json - which cost the run its
          // title, its kind and its style, and was caught only because a check reads
          // the title back out of an artifact. A local name is not worth that.
          const methodRecord = normalizeMethod(args.method)
          const recordFile = path.join(dir, ...METHOD_FILE.split('/'))
          const viewFile = path.join(dir, ...METHOD_MD.split('/'))
          await writeJsonAtomic(recordFile, methodRecord)
          await writeTextAtomic(viewFile, renderMethodMd(methodRecord))
          const { passport } = await readPassport(resolved.root, slug)
          await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_plan', 'method record: ' + methodSummary(methodRecord), args.now)
          await touchRun(runFile, record, args.now)
          const lines = [
            METHOD_FILE + ' written, and ' + METHOD_MD + ' regenerated from it',
            '- path: ' + recordFile,
            '- ' + methodSummary(methodRecord),
            '',
            'The record is what r0 validates and what the document\'s search-and-screening flow is printed from. Edit the RECORD, not ' + METHOD_MD + ': the next write replaces the view.',
          ]
          return {
            text: lines.join('\n'),
            view: { action: 'write', slug, root: resolved.root, summary: methodSummary(methodRecord) },
          }
        }

        const text = String(args.text ?? '')
        if (text.trim() === '') throw new ResearchError('BAD_TEXT', 'nothing to write: pass `text`')
        const mode = args.mode === 'append' ? 'append' : 'replace'
        const existing = mode === 'append' ? await fsp.readFile(target, 'utf8').catch(() => '') : ''
        const next = mode === 'append' && existing.trim() !== '' ? existing.trimEnd() + '\n\n' + text.trim() + '\n' : text.trimEnd() + '\n'
        await writeTextAtomic(target, next)
        const { passport } = await readPassport(resolved.root, slug)
        await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_plan', mode + ' ' + relative + ' (' + wordCount(next) + ' words)', args.now)
        await touchRun(runFile, record, args.now)
        const lines = [relative + ' written (' + mode + ')', '- path: ' + target, '- words in this part: ' + wordCount(next)]
        if (part === 'outline') {
          const named = parseOutline(next)
          lines.push('- the outline names ' + named.length + ' section(s): ' + (named.map((one) => one.slug).join(', ') || '(none)'))
        }
        if (part === 'method') {
          const methodState = await readMethodRecord(dir)
          if (methodState.exists) {
            lines.push('- note: ' + METHOD_FILE + ' exists and is what r0 validates and what the flow is printed from; the Markdown you just wrote does not change it')
          } else {
            lines.push('- note: no record yet - a search a reader cannot reproduce is not a method. Write one with `rs_plan part=method method={ databases: [...], accessed: "YYYY-MM-DD", search: "…", include: [...], exclude: [...], screening: { identified: 0, screened: 0, included: 0 } }`')
          }
        }
        lines.push('')
        lines.push('Next: `rs_write slug=' + slug + ' section=<slug> text="…" claims=[…]` for each section, then `rs_build slug=' + slug + ' format=md`.')
        return { text: lines.join('\n'), view: { action: 'write', slug, root: resolved.root, chars: next.length, summary: relative + ' (' + wordCount(next) + ' words)' } }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_write
  // -------------------------------------------------------------------------
  const write = {
    name: 'rs_write',
    description: [
      'Write part of the document, and declare the claims it makes. This is the tool that keeps the prose and the ledger from drifting apart.',
      'A claim in the text is a bracketed span with an id: `[the sentence, as written]{#c0142}`. Every span in `text` MUST be declared in `claims`, and every declared claim MUST have a span - a mismatch is refused (`CLAIM_UNDECLARED` / `CLAIM_SPAN_MISSING`) rather than stored, because a claim nothing tracks is exactly what this plugin exists to prevent.',
      'The claim\'s TEXT comes from the span, not from you: do not retype the sentence. Declare `strength` (causal / associational / descriptive / theoretical / normative) and the `sources` it rests on, each `{ key, locator }` where the locator is `{ kind: "page", page: 7 }` or `{ kind: "quote", quote: "the words, exactly as the source has them" }`.',
      'A claim that rests on a NUMBER also takes a `statistic`: `{ test, statistic, df, p, effect, ci, n }`. It is recorded as data rather than left in the sentence, so the build can print every number the document claims and a reader can check one of them by name.',
      'Every citation `[@key]` must already be in the ledger; an unknown one is refused with the nearest keys. Omit `section` to write `doc/paper.md` whole; give one to write `doc/sections/<slug>.md`, and name it in `plan/outline.md` so the build puts it in order.',
      'REWRITING A CLAIM\'S WORDS INVALIDATES ITS VERIFICATION. If the sentence, its strength, its statistic or its sources change, the status, the rung, the judge and the reason are cleared and the answer says so - a verdict belongs to a wording, not to an id.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        text: { type: 'string', description: 'The Markdown: prose, `[@key]` citations, and `[sentence]{#cNNNN}` claim spans.' },
        section: { type: 'string', description: 'A section slug (`method`, `results`). Writes `doc/sections/<slug>.md`. Omit to write `doc/paper.md`.' },
        file: { type: 'string', description: 'An explicit path inside `doc/`, e.g. `doc/paper.md`. Wins over `section`.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '`replace` (default) or `append`.' },
        claims: {
          type: 'array',
          description: 'One entry per claim span in `text`.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'The claim id, as it appears in the span: `c0142`.' },
              strength: { type: 'string', enum: STRENGTHS, description: 'How strong the sentence is (default `descriptive`).' },
              statistic: {
                type: 'object',
                description:
                  'The numbers the sentence rests on, as data rather than prose: { test, statistic, df, p, effect, ci, n }. `p` is refused at exactly 0 (`p = .000` is a rounding artefact - write `< .001`), a field nothing reads is refused, and a changed statistic CLEARS the claim\'s verification like a wording change does.',
              },
              sources: {
                type: 'array',
                description: 'What the claim rests on.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key'],
                  properties: {
                    key: { type: 'string', description: 'A citation key already in the ledger.' },
                    locator: { type: 'object', description: 'Where in that source: { kind, page?, quote?, section?, table?, figure?, paragraph?, timestamp? }.' },
                  },
                },
              },
            },
          },
        },
      },
      required: ['slug', 'text'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research document', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_write', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const text = String(args.text ?? '')
        if (text.trim() === '') throw new ResearchError('BAD_TEXT', 'nothing to write: pass `text`')

        // `g1-rq` is the frame, and the frame comes first: writing the document
        // before the person has confirmed WHICH question it answers is the failure
        // this plugin exists to prevent, so the refusal is here and not in a
        // sentence the model is asked to remember. `g2-intake` deliberately does
        // NOT block a write - it is about what the document reports, not about
        // whether it may be written - and every answer reminds the agent it is open.
        const gatePassport = (await readPassport(resolved.root, slug)).passport
        if (answerOf(gatePassport, 'g1-rq') === null) {
          throw new ResearchError(
            'GATE_UNANSWERED',
            '`g1-rq` is not answered: nobody has confirmed that this is the question the document answers. Open the run\'s Research tab and answer it, then write. ' + lookLine(slug),
          )
        }

        // ---- where it goes
        let relative
        if (typeof args.file === 'string' && args.file.trim() !== '') {
          const candidate = args.file.trim().replace(/\\/g, '/')
          if (!/^doc\/[A-Za-z0-9._/-]+\.md$/.test(candidate) || candidate.includes('..')) {
            throw new ResearchError('BAD_PATH', 'file must be a `.md` path inside doc/, e.g. `doc/paper.md` (got ' + JSON.stringify(args.file) + ')')
          }
          relative = candidate
        } else if (typeof args.section === 'string' && args.section.trim() !== '') {
          const wanted = args.section.trim().toLowerCase()
          if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(wanted)) {
            throw new ResearchError('BAD_SECTION', 'a section slug is lowercase letters, digits and dashes (got ' + JSON.stringify(args.section) + ')')
          }
          relative = 'doc/sections/' + wanted + '.md'
        } else {
          relative = 'doc/paper.md'
        }
        const target = path.join(dir, ...relative.split('/'))
        if (!(await insideRoot(dir, target))) throw new ResearchError('PATH_ESCAPE', 'that path leaves the run folder: ' + relative)
        const section = relative.startsWith('doc/sections/') ? relative.slice('doc/sections/'.length, -3) : ''

        // ---- every citation must name a source the ledger has
        const { current: sources } = await readSources(dir)
        const byKey = sourcesByKey(sources)
        const scan = scanDocument(text)
        // A citation-shaped bracket that does not PARSE is refused here, at the
        // earliest moment: it would otherwise stay in the prose while contributing
        // nothing to the reference list, which is a citation with nothing behind it.
        const brokenCitations = findBrokenCitations(text)
        if (brokenCitations.length > 0) {
          throw new ResearchError(
            'BROKEN_CITATION',
            brokenCitations.map((one) => JSON.stringify(one.raw) + ': ' + one.why).join('; '),
          )
        }
        const missingKeys = scan.citationKeys.filter((key) => !byKey.has(key))
        if (missingKeys.length > 0) {
          const advice = missingKeys
            .map((key) => {
              const suggestions = nearMisses(key, [...byKey.keys()])
              return key + (suggestions.length > 0 ? ' (did you mean ' + suggestions.join(', ') + '?)' : '')
            })
            .join('; ')
          throw new ResearchError(
            'UNKNOWN_CITATION',
            'the text cites ' + advice + ' - no source in this run defines ' + (missingKeys.length === 1 ? 'it' : 'them') + '. Ingest the source first with `rs_cite`, or fix the key.',
          )
        }

        // ---- the spans and the declarations must be the same set
        const declared = new Map()
        for (const entry of Array.isArray(args.claims) ? args.claims : []) {
          if (entry === null || typeof entry !== 'object') continue
          const id = String(entry.id ?? '').trim()
          if (id === '') throw new ResearchError('BAD_CLAIM_ID', 'every claims entry needs an `id`')
          if (declared.has(id)) throw new ResearchError('BAD_CLAIM_ID', 'claim ' + id + ' is declared twice')
          declared.set(id, entry)
        }
        const spanIds = new Set(scan.spans.map((span) => span.id))
        const undeclared = [...spanIds].filter((id) => !declared.has(id))
        const spanless = [...declared.keys()].filter((id) => !spanIds.has(id))
        if (undeclared.length > 0) {
          throw new ResearchError(
            'CLAIM_UNDECLARED',
            'the text marks ' + undeclared.join(', ') + ' as claims but they are not in `claims` - declare each with its strength and its sources, or drop the marker',
          )
        }
        if (spanless.length > 0) {
          throw new ResearchError(
            'CLAIM_SPAN_MISSING',
            'claims ' + spanless.join(', ') + ' were declared but no span in the text carries them - every claim is a `[sentence]{#cNNNN}` in the prose',
          )
        }

        const added = []
        const invalidated = []
        for (const span of scan.spans) {
          const entry = declared.get(span.id)
          const result = await appendClaim(
            dir,
            {
              id: span.id,
              text: span.text,
              section,
              strength: entry.strength,
              statistic: entry.statistic,
              sources: Array.isArray(entry.sources) ? entry.sources : [],
            },
            args.now,
          )
          if (result.added) added.push(span.id)
          if (result.invalidated) invalidated.push(span.id)
        }

        // ---- and then the file, so a refused write never touched the prose
        const mode = args.mode === 'append' ? 'append' : 'replace'
        const existing = mode === 'append' ? await fsp.readFile(target, 'utf8').catch(() => '') : ''
        const next = mode === 'append' && existing.trim() !== '' ? existing.trimEnd() + '\n\n' + text.trim() + '\n' : text.trimEnd() + '\n'
        await writeTextAtomic(target, next)

        const { passport } = await readPassport(resolved.root, slug)
        await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_write', mode + ' ' + relative + ' (' + wordCount(next) + ' words, ' + scan.spans.length + ' claim(s))', args.now)
        await touchRun(runFile, record, args.now)

        const { current: claims } = await readClaims(dir)
        const claimMap = claimsById(claims)
        const unbound = scan.spans
          .filter((span) => {
            const row = claimMap.get(span.id)
            return row === undefined || !Array.isArray(row.sources) || row.sources.length === 0
          })
          .map((span) => span.id)
        const answered = pendingGates((await readPassport(resolved.root, slug)).passport)
        const lines = [
          relative + ' written (' + mode + ')',
          '- path: ' + target,
          '- words: ' + wordCount(next),
          '- claims in this text: ' + scan.spans.length + (added.length > 0 ? ' (' + added.length + ' new)' : ''),
          '- citations: ' + (scan.citationKeys.join(', ') || '(none)'),
        ]
        if (unbound.length > 0) lines.push('- NOT BOUND TO A SOURCE: ' + unbound.join(', ') + ' - these cannot pass r1 until a source is attached')
        // The numbers are echoed back in the words a reader will meet them in, so a
        // mis-typed p-value is caught in the answer rather than in the artifact.
        const withStatistics = scan.spans
          .map((span) => claimMap.get(span.id))
          .filter((row) => row !== undefined && row !== null && row.statistic !== null && row.statistic !== undefined)
        if (withStatistics.length > 0) {
          lines.push('- statistics recorded: ' + withStatistics.map((row) => row.id + ' (' + statisticLabel(row.statistic) + ')').join('; '))
        }
        if (invalidated.length > 0) {
          lines.push('')
          lines.push('RE-VERIFICATION NEEDED: ' + invalidated.join(', ') + ' changed wording, strength, statistic or sources, so the verification they had was cleared. A verdict belongs to a sentence, not to an id.')
        }
        for (const marker of scan.brokenMarkers) lines.push('- ' + (marker.why === undefined ? 'a claim reference tracks nothing: ' + JSON.stringify(marker.marker) : JSON.stringify(marker.marker) + ': ' + marker.why))
        if (answered.length > 0) {
          lines.push('')
          lines.push('STILL WAITING ON THE USER: ' + answered.map((gate) => gate.id).join(', ') + ' - a draft can be built, but not a clean one.')
        }
        lines.push('')
        lines.push('Next: `rs_build slug=' + slug + ' format=md draft=watermark` to read it, or keep writing sections.')
        return {
          text: lines.join('\n'),
          view: {
            action: 'write',
            slug,
            root: resolved.root,
            chars: next.length,
            pending: answered.length,
            summary: relative + ' (' + wordCount(next) + ' words, ' + scan.spans.length + ' claims)',
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_cite
  // -------------------------------------------------------------------------
  const cite = {
    name: 'rs_cite',
    description: [
      'Put a source into the run\'s ledger. This plugin FETCHES NOTHING and EXTRACTS NOTHING: you bring it the record and the text, and it hashes, stores, and remembers where every field came from.',
      'Four actions. `add` stores one source: `record` (the bibliographic fields), `source` (where those fields came from: crossref / arxiv / ris / bib / nbib / enw / publisher / pdf / author / agent), and optionally `file` (a path to the PDF or text you already have) and `text` (the extracted text, e.g. what `pdf_read` returned). `import` reads a `.ris` / `.bib` / `.nbib` / `.enw` export from your own library and adds every record. `list` and `get` show what is there.',
      'A source with no bytes and no text can still be cited, but it cannot pass a rung that has to READ it - and the answer says exactly that, in those words.',
      'This is the one tool that reads a file from outside the run, by the rule `dsh-pdf` already uses: an absolute path is read directly, a relative one resolves inside the workspace, and the ORIGINAL path is recorded beside the copy so a reader can see where it came from.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        action: { type: 'string', enum: ['add', 'import', 'list', 'get'], description: '`add` (default) is one source; `import` is a library export.' },
        key: { type: 'string', description: 'The citation key. Omitted, one is suggested from the author, year and title.' },
        record: { type: 'object', description: 'The bibliographic fields: kind, title, authors, year, container, volume, issue, pages, publisher, place, doi, url, isbn, accessed, note.' },
        source: { type: 'string', description: 'Where the RECORD came from: crossref, arxiv, ris, bib, nbib, enw, publisher, pdf, author, agent.' },
        provenance: { type: 'object', description: 'Per-field origins when they differ: { "title": "crossref", "pages": "author" }.' },
        file: { type: 'string', description: 'A file to store as this source\'s bytes (a PDF, or a text file): absolute, or relative to the workspace. For `import`, the export to read.' },
        text: { type: 'string', description: 'The source\'s text, e.g. what `pdf_read` returned. Stored so a quote can be located later without reading the PDF again.' },
        role: { type: 'string', enum: ['full-text', 'record', 'notes'], description: 'What the file IS (default `full-text`).' },
        coverage: { type: 'number', description: 'With `text`: how much of the source it covers, 0-1, when the extractor reports it.' },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research source', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_cite', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const action = args.action ?? 'add'
        const { current: sources } = await readSources(dir)

        if (action === 'list' || action === 'get') {
          const rows = action === 'get' ? sources.filter((one) => one.key === String(args.key ?? '').trim()) : sources
          if (action === 'get' && rows.length === 0) {
            throw new ResearchError('UNKNOWN_SOURCE', 'no source named ' + JSON.stringify(String(args.key ?? '')) + ' in ' + slug + ' - `rs_cite action=list` shows what is there')
          }
          const lines = ['Sources in ' + slug + ' (' + rows.length + ' of ' + sources.length + ')']
          for (const one of rows) {
            const files = Array.isArray(one.files) ? one.files.length : 0
            lines.push(
              '  ' + one.key + '  [' + one.kind + ']  ' + (one.year === '' ? 'n.d.' : one.year) + '  ' + (files === 0 ? 'no bytes' : files + ' file(s)') + (one.text === undefined ? ', no text' : ', text from ' + String(one.text.source ?? 'unknown')),
            )
            lines.push('      ' + one.title)
          }
          if (action === 'list' && sources.length === 0) lines.push('  (none yet - ingest one with `rs_cite action=add record={…} text="…"`)')
          return { text: lines.join('\n'), view: { action, slug, root: resolved.root, files: rows.length, summary: rows.length + ' source(s)' } }
        }

        if (action === 'import') {
          const refs = await loadRefs()
          const requested = String(args.file ?? '').trim()
          if (requested === '') throw new ResearchError('BAD_PATH', 'import needs `file`: the .ris, .bib, .nbib or .enw export to read')
          const { buffer, originalPath } = await readOutsideFile(resolved, requested)
          const records = refs.importCitations(buffer.toString('utf8'))
          if (records.length === 0) {
            throw new ResearchError('REFS_EMPTY', 'nothing in ' + originalPath + ' looked like a bibliographic record - this import reads RIS, BibTeX, MEDLINE (.nbib) and EndNote (.enw)')
          }
          const added = []
          const unchanged = []
          for (const one of records) {
            const key = refs.keyFrom(one.key ?? '') || refs.suggestKey(one)
            const result = await appendSource(dir, { ...one, key, provenance: provenanceOf(one, args.source ?? 'import') }, args.now)
            if (result.changed) added.push(key)
            else unchanged.push(key)
          }
          const { passport } = await readPassport(resolved.root, slug)
          await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_cite', 'imported ' + records.length + ' record(s) from ' + path.basename(originalPath), args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Imported ' + records.length + ' record(s) from ' + originalPath,
              '- new or changed: ' + (added.length === 0 ? '(none)' : added.join(', ')),
              '- already in the ledger unchanged: ' + (unchanged.length === 0 ? '(none)' : unchanged.join(', ')),
              '',
              'Next: cite them in the text as `[@key]` and bind them to claims in `rs_write`.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, files: records.length, summary: records.length + ' imported' },
          }
        }

        // ---- action=add: one source, its bytes, its text
        const refs = await loadRefs()
        const given = args.record !== null && typeof args.record === 'object' && !Array.isArray(args.record) ? { ...args.record } : {}
        const text = typeof args.text === 'string' ? args.text : ''
        let key = typeof args.key === 'string' && args.key.trim() !== '' ? refs.keyFrom(args.key) : ''
        if (key === '' && given.title !== undefined) key = refs.suggestKey(given)
        if (key === '') throw new ResearchError('BAD_KEY', 'a source needs a `key`, or a `record` with a title from which one is suggested')
        if (given.title === undefined && typeof args.file === 'string' && args.file.trim() !== '') {
          // A file before its metadata is a real state, and the ledger says so
          // plainly rather than inventing a title nobody can check.
          given.title = path.basename(args.file.trim()).replace(/\.[a-z0-9]+$/i, '')
          given.kind = given.kind ?? 'report'
        }
        const provenance = { ...provenanceOf(given, typeof args.source === 'string' ? args.source : 'agent'), ...(args.provenance ?? {}) }
        const created = await appendSource(dir, { ...given, key, provenance }, args.now)

        const patch = {}
        if (typeof args.file === 'string' && args.file.trim() !== '') {
          const { buffer, originalPath } = await readOutsideFile(resolved, args.file.trim())
          const sha256 = hashOf(buffer)
          const extension = (path.extname(originalPath).toLowerCase() || '.bin').slice(0, 9)
          const stored = sourceFilePath(dir, sha256, extension)
          const exists = await fsp
            .stat(stored)
            .then(() => true)
            .catch(() => false)
          if (!exists) await fsp.writeFile(stored, buffer)
          patch.files = [{ sha256, name: path.basename(originalPath), bytes: buffer.length, role: args.role ?? 'full-text', originalPath }]
          // A text file IS its own text: storing it twice under two names would be
          // two answers to "what does this source say".
          if (text === '' && /^\.(txt|md|markdown|csv)$/i.test(extension)) {
            const textHash = hashOf(buffer.toString('utf8'))
            await fsp.writeFile(sourceTextPath(dir, textHash), buffer.toString('utf8'))
            patch.text = { sha256: textHash, file: 'sources/' + textHash + '.txt', source: 'agent-file', chars: buffer.length, coverage: null }
          }
        }
        if (text !== '') {
          const textHash = hashOf(text)
          await fsp.writeFile(sourceTextPath(dir, textHash), text)
          patch.text = {
            sha256: textHash,
            file: 'sources/' + textHash + '.txt',
            source: typeof args.source === 'string' && args.source !== '' ? args.source : 'agent',
            chars: text.length,
            coverage: Number.isFinite(args.coverage) ? Number(args.coverage) : null,
          }
        }
        const finalRecord = Object.keys(patch).length > 0 ? await attachToSource(dir, key, patch, args.now) : created.record
        const { passport } = await readPassport(resolved.root, slug)
        await addReceipt(
          path.join(dir, PASSPORT_FILE),
          passport,
          'rs_cite',
          'ingested ' + key + ' (' + (Array.isArray(finalRecord.files) ? finalRecord.files.length : 0) + ' file(s)' + (finalRecord.text === undefined ? ', no text' : ', text from ' + finalRecord.text.source) + ')',
          args.now,
        )
        await touchRun(runFile, record, args.now)

        const origins = Object.values(provenance)
        const fromElsewhere = origins.filter((one) => one !== 'author' && one !== 'agent').length
        const byHand = origins.filter((one) => one === 'author' || one === 'agent').length
        const missing = ['title', 'year', 'container'].filter((field) => String(finalRecord[field] ?? '') === '')
        const lines = [
          'Source ' + key + ' is in the ledger',
          '- title: ' + finalRecord.title,
          '- fields with a named origin: ' + origins.length + ' (' + fromElsewhere + ' from a source you named, ' + byHand + ' supplied by hand)',
        ]
        if (Array.isArray(finalRecord.files) && finalRecord.files.length > 0) {
          for (const one of finalRecord.files) lines.push('- file: ' + one.name + '  ' + sizeOf(one.bytes) + '  sha256 ' + String(one.sha256).slice(0, 12) + '…  (from ' + one.originalPath + ')')
        } else {
          lines.push('- no bytes stored: nothing can check a quote against this source yet')
        }
        if (finalRecord.text === undefined) {
          lines.push('- no text stored: read the source with `pdf_read` (or `ocr`) and pass what it gives you as `text=`. This plugin extracts nothing itself')
        } else {
          lines.push('- text: ' + finalRecord.text.chars + ' characters from ' + finalRecord.text.source + (finalRecord.text.coverage === null || finalRecord.text.coverage === undefined ? ' (coverage not reported)' : ' (coverage ' + finalRecord.text.coverage + ')'))
        }
        if (missing.length > 0) lines.push('- MISSING: ' + missing.join(', ') + ' - a reference list cannot be complete without ' + (missing.length === 1 ? 'it' : 'them'))
        lines.push('')
        lines.push('Next: cite it as `[@' + key + ']` and bind it to a claim in `rs_write`.')
        return {
          text: lines.join('\n'),
          view: { action: 'add', slug, root: resolved.root, files: Array.isArray(finalRecord.files) ? finalRecord.files.length : 0, chars: text.length, summary: key + ' ingested' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_build
  // -------------------------------------------------------------------------
  const build = {
    name: 'rs_build',
    description: [
      'Build the document. `format=md` is the reader-ready Markdown: citations resolved by the style, the reference list computed from the ledger (never typed by the model), and claim endnotes in a draft. `format=docx` writes a real Office document from the SAME Markdown through this package\'s own OOXML writer - no process is spawned, and two builds of one run are byte-identical. `format=html` writes one self-contained page, no network needed. `format=tex` writes a .tex that needs no bibliography engine, and PRINTS the compile command rather than running it. `ris` / `bib` / `enw` export the run\'s LIBRARY for Zotero, EndNote or pandoc.',
      '`format=package` is not a document format: it assembles the FOLDER a journal wants - an ANONYMIZED manuscript (built with no title block), a title page to fill in, a cover letter computed from the ledger, a checklist, and the run\'s figures copied beside them. It is GATED like a clean build whatever `draft` says, because a submission is the artifact that must not carry a claim nothing has checked.',
      'TWO DRAFTS, and the difference is the whole point. `draft=watermark` (the default) always builds: it puts a banner at the top and an endnote on every claim naming its status and its rung, so a half-checked document cannot be mistaken for a finished one. `draft=clean` is the mode whose output looks finished, so it REFUSES while the document and its ledger disagree, while a claim a check found unsupported is still in the text, or until a person has answered gate `g3-integrity` - which this call opens, and which is answered in the Research tab.',
      'Every build writes `build/build.json` beside the artifacts: what was built, from the sha256 of which document, and the claim statuses as they were at that moment. A question about a document that was handed to somebody is answerable from the folder.',
      'Nothing leaves this machine and no engine is run: this plugin spawns no process, so a format that needs a LaTeX engine names the command for you to run instead of running it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        // The enum ADVERTISES the three formats this build refuses, on purpose: a
        // model that asks for `docx` gets a refusal naming the phase that brings it,
        // which is a more useful answer than a schema violation that only says the
        // value is not allowed. The authority on what can actually be written is
        // `rs_open action=capabilities`, and the skills point there rather than
        // listing formats that would go stale.
        format: { type: 'string', enum: [...FORMATS, 'all'], description: '`md` (default), `docx`, `html`, `tex`, `ris`, `bib`, `enw`, `package` (the gated submission folder), or `all` for every DOCUMENT format. `tex` PRINTS the pdflatex command: this plugin runs no engine.' },
        draft: { type: 'string', enum: ['watermark', 'clean'], description: '`watermark` (default) always builds; `clean` is gated.' },
        style: { type: 'string', description: 'Citation style id. Defaults to the run\'s own.' },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research build', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_build', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const styleId = typeof args.style === 'string' && args.style !== '' ? args.style : record.style
        const draft = args.draft === 'clean' ? 'clean' : 'watermark'
        const wanted = args.format ?? 'md'

        // A clean build is the one mode with a gate, and the gate is OPENED here so
        // the question is visibly waiting in the panel rather than only in a message.
        // The route that builds goes through the same helper, so the two callers
        // cannot disagree about what a clean build requires.
        //
        // `package` requires it too, whatever `draft` says: a submission is a clean
        // build. Asking for the gate on `draft` alone made the tool OPEN a gate the
        // builder was about to REQUIRE, so `format=package` refused with
        // GATE_UNANSWERED while telling nobody there was a question to answer - the
        // two halves of one decision, made from different inputs.
        const needsIntegrity = draft === 'clean' || wanted === 'package'
        const integrity = await ensureIntegrityGate({ root: resolved.root, slug, draft: needsIntegrity ? 'clean' : draft, now: args.now })
        const { passport } = await readPassport(resolved.root, slug)
        const integrityAnswered = integrity.answered

        const formats = wanted === 'all' ? FORMATS_DOCUMENT : [wanted]
        const outputs = []
        const reports = []
        for (const format of formats) {
          const result = await runBuild({
            runDir: dir,
            format,
            draft,
            styleId,
            slug,
            integrityAnswered,
            // The title block and the core properties come from the run's own
            // RUN.json: `created` is what makes two builds of one run byte-identical,
            // because the writer may not read the clock.
            title: record.title,
            created: record.created,
            // The packager's cover letter states what the author declared about the
            // experiments, so the gate answers travel with the build.
            passportGates: gateViews(passport),
            now: args.now,
          })
          outputs.push(...result.outputs)
          reports.push(result.report)
        }

        const report = reports[0]
        // ONE report for the whole build, written by the caller that knows how many
        // formats it asked for - `runBuild` cannot, and writing per format left a
        // seven-format build described by its last one.
        await writeBuildReport(dir, combineReports(reports, outputs))
        await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_build', draft + ' build of ' + formats.join('+') + ' -> ' + outputs.map((one) => one.path).join(', '), args.now)
        await touchRun(runFile, record, args.now)

        const statuses = report.claims.byStatus
        const spoken = Object.entries(statuses)
          .filter(([, count]) => count > 0)
          .map(([status, count]) => count + ' ' + status)
          .join(', ')
        const lines = [
          'Built ' + slug + ' (' + (reports[0] === undefined ? draft : reports[0].draft) + ', ' + styleId + ')' + (formats.includes('package') ? ' - a SUBMISSION folder, gated like a clean build' : ''),
          '- document: ' + report.document.source + ', ' + report.document.words + ' words',
          '- claims: ' + report.claims.total + ' (' + (spoken === '' ? 'none' : spoken) + ')',
          '- sources: ' + report.sources.total + ' in the ledger, ' + report.sources.cited + ' cited, ' + report.sources.withText + ' with text',
          '- statistics: ' + report.statistics.claims + ' claim(s) carry a number, printed as the Statistics table',
          '- method record: ' + (report.method.recorded ? report.method.summary : 'NOT RECORDED - no search is reproducible from this run'),
          '- structure: ' + (report.structure.ok ? 'agrees with the ledger' : report.structure.errors.length + ' error(s): ' + report.structure.errors.join(', ')) + (report.structure.warnings.length > 0 ? ', ' + report.structure.warnings.length + ' warning(s): ' + report.structure.warnings.join(', ') : ''),
        ]
        for (const note of report.notes) lines.push('- note: ' + note)
        lines.push('')
        lines.push('Files:')
        for (const one of outputs) lines.push('  ' + one.path + '  ' + sizeOf(one.bytes) + '  sha256 ' + String(one.sha256).slice(0, 12) + '…')
        lines.push('  build/build.json  (the report above, stored)')
        lines.push('')
        if (draft !== 'clean') {
          lines.push('This is a DRAFT: the banner and the endnotes are what say so. `draft=clean` needs the document and its ledger to agree, no unsupported claim, and gate `g3-integrity` answered - it is waiting in the Research tab.')
        }
        return {
          text: lines.join('\n'),
          view: {
            action: 'build',
            slug,
            root: resolved.root,
            pending: pendingGates(passport).length,
            gates: ['g3-integrity=' + (integrityAnswered ? 'answered' : 'pending')],
            files: outputs.length + 1,
            summary: draft + ' ' + formats.join('+') + ' → ' + outputs.map((one) => path.basename(one.path)).join(', '),
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_verify
  // -------------------------------------------------------------------------
  const verify = {
    name: 'rs_verify',
    description: [
      'Check the run, and record what was found. Four actions, and the ladder is the shape of all of them.',
      '`record` runs the two rungs that need NO reader - `r1-record` (are the stored bytes still the bytes that were ingested, does the record have the fields a reference needs, does every field name its origin, and does the title it claims appear in the text that was ingested) and `r2-locate` (is every claim\'s quoted passage really in its source\'s stored text). Pass `tier=r1` or `tier=r2` to narrow it; both run by default.',
      '`report` is the ladder as it stands - each rung\'s state, what it checked, what it found and what it COULD NOT check - and it writes nothing. Read it before you tell anyone a run has been checked.',
      '`support` records the rungs a file cannot do: for each claim you name, the verdict (`supported`, `partially-supported`, `unsupported`, `contradicted`, `misattributed`), whether the claim is written at the strength the passage holds (`aligned`, `overstated`, `understated`), and the reason. YOU are the reader for that - this tool records your judgement, it does not make it - so a claim with no locator cannot be judged (`STATUS_REQUIRES_EVIDENCE`), and every verdict names its judge.',
      '`audit` is the adversarial pass: the same claims argued the other way, recorded at `r4-audit` after an `r3-support` verdict exists. A concession below the stated threshold is REFUSED rather than stored, which is what keeps the devil\'s advocate from agreeing its way out of an argument.',
      'Nothing here is a claim about the truth of a source. `r1` records PROVENANCE - whose bytes, whose record, which field from where - and never says a DOI exists.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        action: { type: 'string', enum: ['record', 'report', 'support', 'audit'], description: '`record` (default) runs the file rungs; `report` writes nothing; `support`/`audit` record YOUR verdicts.' },
        tier: { type: 'string', enum: ['r1', 'r2', 'all'], description: 'For `record`: which file rung (default `all`).' },
        judge: { type: 'string', description: 'Who judged, for `support`/`audit` - e.g. the session model, or a subagent and what it was asked. Required.' },
        verdicts: {
          type: 'array',
          description: 'For `support`/`audit`: one entry per claim judged.',
          items: {
            type: 'object',
            additionalProperties: false,
            // `reason` is REQUIRED in the schema, not only in the refusal: this
            // subset of JSON Schema cannot say "required for some actions", so the
            // requirements a caller can be told before the call are stated here and
            // the rest stay runtime refusals. `judge` is the other way round - the
            // tool-level `required` is `['slug']`, because `record` and `report` need
            // no judge at all, and asking for one there would refuse a valid call.
            required: ['id', 'verdict', 'reason'],
            properties: {
              id: { type: 'string', description: 'The claim id, e.g. `c0142`.' },
              verdict: { type: 'string', enum: ['supported', 'partially-supported', 'unsupported', 'contradicted', 'misattributed'], description: 'What the passage does for the claim.' },
              strengthVerdict: { type: 'string', enum: ['aligned', 'overstated', 'understated'], description: 'Whether the sentence is written at the strength the passage holds.' },
              reason: { type: 'string', description: 'Why - the sentence a reader will weigh. Required: a verdict with no reason is a score with no evidence.' },
              passage: { type: 'string', description: 'The words you judged, quoted from the source, so the next reader can find them.' },
            },
          },
        },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research check', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_verify', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const action = args.action ?? 'record'

        if (action === 'report') {
          const report = await ladderReport({ dir, now: args.now })
          const lines = ['The ladder for ' + slug + ' as it stands (' + report.sources + ' source(s), ' + report.claims + ' claim(s))']
          for (const rung of report.rungs) {
            lines.push('')
            lines.push(rung.rung + '  [' + rung.state + ']')
            if (rung.why !== undefined) lines.push('  ' + rung.why)
            if (rung.checked !== undefined) lines.push('  checked: ' + rung.checked)
            if (rung.located !== undefined) lines.push('  quotes located: ' + rung.located)
            if (rung.waiting !== undefined) lines.push('  waiting on a reader: ' + rung.waiting)
            for (const one of (rung.findings ?? []).slice(0, 12)) lines.push('  · ' + one.code + ': ' + one.detail)
            if ((rung.findings ?? []).length > 12) lines.push('  · … and ' + ((rung.findings ?? []).length - 12) + ' more')
            for (const one of (rung.uncheckable ?? []).slice(0, 6)) lines.push('  ? could not check ' + (one.key ?? one.id) + ': ' + one.why)
            if ((rung.uncheckable ?? []).length > 6) lines.push('  ? … and ' + ((rung.uncheckable ?? []).length - 6) + ' more could not be checked')
          }
          lines.push('')
          lines.push('Statuses: ' + Object.entries(report.statuses).filter(([, count]) => count > 0).map(([status, count]) => count + ' ' + status).join(', '))
          lines.push('This report changed nothing on disk: `action=record` writes findings, `action=support` writes verdicts, and this writes neither.')
          lines.push('A rung that could not run is listed as `could not check`, never as a pass.')
          return {
            text: lines.join('\n'),
            view: { action, slug, root: resolved.root, runs: 0, summary: 'r1/r2 report written to nothing' },
          }
        }

        if (action === 'support' || action === 'audit') {
          const judge = String(args.judge ?? '').trim()
          if (judge === '') {
            throw new ResearchError('BAD_JUDGE', 'a verdict names its judge: pass `judge="…"` naming who read the passage (the session model, or a subagent and what it was asked)')
          }
          const verdicts = Array.isArray(args.verdicts) ? args.verdicts : []
          if (verdicts.length === 0) throw new ResearchError('BAD_VERDICT', 'pass at least one entry in `verdicts`')
          const { current: claims } = await readClaims(dir)
          const byId = claimsById(claims)
          const tier = action === 'audit' ? 'r4-audit' : 'r3-support'
          const VERDICTS = ['supported', 'partially-supported', 'unsupported', 'contradicted', 'misattributed']
          const moved = []
          for (const entry of verdicts) {
            const id = String(entry.id ?? '').trim()
            const row = byId.get(id)
            if (row === undefined) throw new ResearchError('UNKNOWN_CLAIM', 'no claim named ' + JSON.stringify(id) + ' in ' + slug + ' - a verdict records what was judged')
            if (!VERDICTS.includes(entry.verdict)) {
              throw new ResearchError('BAD_VERDICT', 'claim ' + id + ': verdict must be one of ' + VERDICTS.join(', ') + ' (got ' + JSON.stringify(String(entry.verdict)) + ')')
            }
            const reason = String(entry.reason ?? '').trim()
            if (reason === '') {
              throw new ResearchError('BAD_VERDICT', 'claim ' + id + ': a verdict needs a `reason`. A verdict with no reason is a score with no evidence, which is the one thing this ledger must not hold')
            }
            // EVIDENCE FIRST. A verdict about support is a verdict about a PASSAGE,
            // so a claim that carries no locator cannot be judged at all - there is
            // nothing that was read.
            const bindings = Array.isArray(row.sources) ? row.sources : []
            const located = bindings.filter((binding) => binding.locator !== null && binding.locator !== undefined)
            if (located.length === 0) {
              throw new ResearchError(
                'STATUS_REQUIRES_EVIDENCE',
                'claim ' + id + ' has no locator on any of its sources, so there is no passage to judge. Bind it to a quote (or a page) with `rs_write`, then judge it.',
              )
            }
            if (action === 'audit') {
              const previous = claimStatusOf(row)
              if (previous === 'unverified' || previous === 'located') {
                throw new ResearchError('RUNG_ORDER', 'claim ' + id + ' has not been through `r3-support` yet (it is `' + previous + '`), and an adversarial pass over a claim nobody has read once is not an audit')
              }
            }
            const next = await recordVerdict(
              dir,
              {
                id,
                status: entry.verdict,
                tier,
                strengthVerdict: entry.strengthVerdict,
                reason: entry.passage === undefined ? reason : reason + ' [passage: “' + String(entry.passage).slice(0, 200) + '”]',
                judge,
              },
              args.now,
            )
            moved.push({ id, verdict: entry.verdict, tier })
            if (next === null) throw new ResearchError('BAD_VERDICT', 'claim ' + id + ' could not be recorded')
          }
          const { passport } = await readPassport(resolved.root, slug)
          await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_verify', tier + ' recorded for ' + moved.length + ' claim(s) by ' + judge, args.now)
          await touchRun(runFile, record, args.now)
          const lines = [tier + ' recorded for ' + moved.length + ' claim(s) in ' + slug, '- judge: ' + judge]
          for (const one of moved) lines.push('  ' + one.id + ' -> ' + one.verdict)
          lines.push('')
          lines.push('A verdict is recorded, not proven: the judge, the reason and the passage are all in the ledger so a reader can disagree with a specific one.')
          if (moved.some((one) => one.verdict === 'unsupported' || one.verdict === 'contradicted' || one.verdict === 'misattributed')) {
            lines.push('A clean build now REFUSES while these stand: ' + moved.filter((one) => one.verdict !== 'supported' && one.verdict !== 'partially-supported').map((one) => one.id + '=' + one.verdict).join(', '))
          }
          return {
            text: lines.join('\n'),
            view: { action, slug, root: resolved.root, gates: [tier], summary: moved.length + ' verdict(s) at ' + tier },
          }
        }

        // ---- action=record: the two rungs that need no reader
        const tier = args.tier ?? 'all'
        const { current: sources } = await readSources(dir)
        const { current: claims } = await readClaims(dir)
        const byKey = sourcesByKey(sources)
        const lines = ['Checked ' + slug + ' (' + sources.length + ' source(s), ' + claims.length + ' claim(s))']
        const counts = {}
        const tally = (findings) => {
          for (const one of findings) counts[one.code] = (counts[one.code] ?? 0) + 1
        }

        if (tier === 'r1' || tier === 'all') {
          const r1 = await r1Sources({ dir, sources })
          for (const recordEntry of sources) {
            const own = r1.findings.filter((one) => one.detail.startsWith(recordEntry.key + ':') || one.detail.includes(recordEntry.key))
            if (own.length > 0) await applyFindings(dir, { target: 'source', id: recordEntry.key, rung: 'r1-record', findings: own }, args.now)
          }
          tally(r1.findings)
          lines.push('- r1-record: ' + r1.checked + ' source(s) matched their own text, ' + r1.findings.length + ' finding(s), ' + r1.uncheckable.length + ' could not be checked')
          for (const one of r1.uncheckable.slice(0, 6)) lines.push('    ? ' + one.key + ': ' + one.why)
        }

        if (tier === 'r2' || tier === 'all') {
          const r2 = await r2Claims({ dir, claims, sourcesByKey: byKey })
          for (const claimRow of claims) {
            const own = r2.findings.filter((one) => one.id === claimRow.id)
            const hit = r2.located.find((one) => one.id === claimRow.id)
            if (own.length === 0 && hit === undefined) continue
            await applyFindings(
              dir,
              {
                target: 'claim',
                id: claimRow.id,
                rung: 'r2-locate',
                findings: own,
                ...(hit === undefined ? {} : { status: 'located', tier: 'r2-locate', context: hit.context }),
              },
              args.now,
            )
          }
          tally(r2.findings)
          lines.push('- r2-locate: ' + r2.located.length + ' quote(s) found in their source, ' + r2.findings.length + ' finding(s), ' + r2.uncheckable.length + ' could not be checked')
          for (const one of r2.findings.slice(0, 8)) lines.push('    · ' + one.code + ': ' + one.detail)
          for (const one of r2.uncheckable.slice(0, 6)) lines.push('    ? ' + one.id + '/' + one.key + ': ' + one.why)
        }

        const spoken = Object.entries(counts).map(([code, count]) => count + ' ' + code).join(', ')
        if (spoken !== '') lines.push('- findings: ' + spoken)
        const { passport } = await readPassport(resolved.root, slug)
        await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_verify', tier + ' over ' + sources.length + ' source(s) and ' + claims.length + ' claim(s)', args.now)
        await touchRun(runFile, record, args.now)
        lines.push('')
        lines.push('Next: `rs_verify action=report` for the ladder, and `rs_verify action=support` once you have READ the passages - the two rungs above never judge whether a source supports a claim, only whether the words are there.')
        return {
          text: lines.join('\n'),
          view: { action: 'record', slug, root: resolved.root, gates: [tier], pending: pendingGates(passport).length, summary: tier + ' recorded, ' + Object.keys(counts).length + ' kind(s) of finding' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // rs_review
  // -------------------------------------------------------------------------
  const review = {
    name: 'rs_review',
    description: [
      'The review: the concerns raised about the document, what the author did about each, and whether a re-review confirmed it. This tool RECORDS a review - it does not perform one, because reading a paper and judging it is the reader\'s work.',
      '`panel` records one round of findings: `items=[{ role, concern, severity, criterion, evidence, suggestion }]`. Roles: journal-fit, methodology, domain, devils-advocate, editor, author. A concern should name the `evidence` in the manuscript that grounds it (a section, a claim id), because a concern the author cannot find is a revision round wasted.',
      '`answer` records YOUR reply to one concern: `{ id, status: addressed|rejected, reply }`. `rereview` records what a fresh reader found: `{ id, verified: true|false, reason }` - and that is a SEPARATE column from the author\'s own answer, because "I fixed it" and "it is fixed" are different statements.',
      '`attack` and `concede` are the devil\'s advocate, and the concession threshold is ENFORCED rather than requested: a concession needs the rebuttal\'s score (1-5) and is REFUSED below 4 (`CONCESSION_BELOW_THRESHOLD`) - at that score the advocate holds position - and a second concession in a row is refused outright (`CONSECUTIVE_CONCESSION`), which is the sycophancy pattern this protocol exists to slow.',
      '`read` prints the matrix and the round\'s report; `write` puts the panel report and the response-to-reviewers letter in `reviews/`. The matrix keeps the author\'s claim and the re-review\'s finding in separate columns, on purpose.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'The run.' },
        action: { type: 'string', enum: ['panel', 'answer', 'rereview', 'attack', 'concede', 'read', 'write'], description: 'What to record, or `read`/`write` for the report and the letter.' },
        round: { type: 'number', description: 'The review round (default: the next one).' },
        items: {
          type: 'array',
          description: 'For `action=panel`: the findings.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'concern'],
            properties: {
              role: { type: 'string', enum: REVIEW_ROLES, description: 'Which reviewer is speaking.' },
              concern: { type: 'string', description: 'The concern, in the reviewer\'s words.' },
              severity: { type: 'string', enum: REVIEW_SEVERITIES, description: 'major (default), minor or note.' },
              criterion: { type: 'string', enum: REVIEW_CRITERIA, description: 'What it is about (default evidence).' },
              evidence: { type: 'string', description: 'Where in the manuscript - a section slug, a claim id, a page. A concern with no location is one the author cannot find.' },
              suggestion: { type: 'string', description: 'What would resolve it, if the reviewer has one.' },
            },
          },
        },
        id: { type: 'string', description: 'For answer/rereview: the finding id, e.g. `f0001`.' },
        status: { type: 'string', enum: ['addressed', 'rejected'], description: 'For `answer`. Neither is a verification.' },
        reply: { type: 'string', description: 'For `answer`/`concede`: the sentence being answered with.' },
        verified: { type: 'boolean', description: 'For `rereview`: did the revised document actually settle it?' },
        reason: { type: 'string', description: 'For `rereview`/`attack`: what grounds the verdict.' },
        concern: { type: 'string', description: 'For `attack`/`concede`: the concern.' },
        score: { type: 'number', description: 'For `concede`: 1-5, how directly and how evidential the rebuttal was. 4 or more earns the concession.' },
        by: { type: 'string', description: 'For `rereview`: who re-read it.' },
      },
      required: ['slug'],
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'Research review', kind: 'other' }),
    async execute(args, exec) {
      return run('rs_review', args, exec, async () => {
        const resolved = await rootFor(exec)
        const slug = String(args.slug ?? '').trim()
        const { dir, file: runFile, record } = await readRun(resolved.root, slug)
        const action = args.action ?? 'read'
        const { rows } = await readReviewRows(dir)
        const round = Number.isFinite(Number(args.round)) && Number(args.round) > 0 ? Number(args.round) : undefined

        if (action === 'read' || action === 'write') {
          // A report is ABOUT a round, so with none named it reports the latest one
          // that exists - which is also what names the file it writes.
          const activeRound = round ?? latestRound(rows)
          const report = renderPanel(rows, { round: activeRound, title: record.title })
          const matrixText = renderMatrix(rows)
          const open = matrix(rows).filter((entry) => entry.status === 'open')
          const unanswered = open.length
          if (action === 'read') {
            if (rows.length === 0) {
              return {
                text: 'No review yet for ' + slug + '. Record a panel with `rs_review action=panel items=[{ role, concern, … }]`.',
                view: { action, slug, root: resolved.root, summary: 'no review yet' },
              }
            }
            const lines = [
              'Review of ' + slug + ' — ' + matrix(rows).length + ' concern(s)',
              '- open: ' + unanswered + '   major: ' + matrix(rows).filter((entry) => entry.severity === 'major').length,
              '- the author\'s answers and the re-review\'s findings are separate columns; a concern is not closed by an answer alone',
              '',
              'The traceability matrix:',
              '',
              matrixText,
            ]
            const advocate = advocateHealth(rows)
            if (advocate.attacks + advocate.concessions > 0) {
              lines.push('', 'The devil\'s advocate: ' + advocate.attacks + ' attack(s), ' + advocate.concessions + ' concession(s), rate ' + Math.round(advocate.rate * 100) + '%')
              if (advocate.warning !== '') lines.push('', advocate.warning)
            }
            return { text: lines.join('\n'), view: { action, slug, root: resolved.root, files: matrix(rows).length, summary: matrix(rows).length + ' concern(s), ' + unanswered + ' open' } }
          }
          if (rows.length === 0) throw new ResearchError('NO_REVIEW', 'there is no review to write up yet - record the panel first')
          await fsp.mkdir(path.join(dir, 'reviews'), { recursive: true })
          const reportFile = path.join(dir, 'reviews', 'panel-r' + activeRound + '.md')
          await writeTextAtomic(reportFile, report + '\n')
          const matrixFile = path.join(dir, 'reviews', 'traceability.md')
          await writeTextAtomic(matrixFile, '# Response to reviewers — traceability\n\n' + matrixText + '\n')
          const { passport } = await readPassport(resolved.root, slug)
          await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_review', 'wrote the panel report and the traceability matrix (' + matrix(rows).length + ' concerns)', args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Wrote the review for ' + slug,
              '- reviews/' + path.basename(reportFile) + ': the round\'s concerns, grouped and counted',
              '- reviews/traceability.md: the matrix, with the author\'s answer and the re-review\'s finding in separate columns',
              '',
              unanswered > 0 ? 'NOTE: ' + unanswered + ' concern(s) are still open - a response letter with an open concern in it is a letter that concedes the point.' : 'Every concern has an answer.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, files: 2, summary: 'panel + matrix written' },
          }
        }

        if (action === 'panel') {
          if (!Array.isArray(args.items) || args.items.length === 0) throw new ResearchError('BAD_FINDING', 'pass `items=[{ role, concern, … }]`')
          const state = await readRunState(dir)
          if (state.document.text.trim() === '') {
            throw new ResearchError('DOC_EMPTY', 'there is nothing to review yet - a concern about a document that does not exist cannot be answered')
          }
          const result = await recordFindings(dir, { round, items: args.items }, args.now)
          const { passport } = await readPassport(resolved.root, slug)
          await addReceipt(path.join(dir, PASSPORT_FILE), passport, 'rs_review', 'recorded ' + result.added.length + ' finding(s) in round ' + result.round, args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Recorded round ' + result.round + ' for ' + slug + ': ' + result.added.length + ' concern(s)',
              ...result.added.map((one) => '  ' + one.id + '  [' + one.severity + ', ' + one.role + ', ' + one.criterion + ']'),
              '',
              'Next: answer each one with `rs_review action=answer id=… status=addressed reply="…"`, then have a fresh reader check it with `action=rereview`.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, files: result.added.length, summary: result.added.length + ' concern(s) in round ' + result.round },
          }
        }

        if (action === 'answer') {
          const row = await answerFinding(dir, { id: args.id, status: args.status, reply: args.reply }, args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Finding ' + row.id + ' is now ' + row.status + ' (your words, not a verification)',
              '- your answer: ' + row.reply,
              '',
              'A re-review decides whether it is actually settled: `rs_review action=rereview id=' + row.id + ' verified=true|false reason="…"`. Until then the matrix says `not re-reviewed`.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, summary: row.id + ' ' + row.status },
          }
        }

        if (action === 'rereview') {
          const row = await rereviewFinding(dir, { id: args.id, verified: args.verified, reason: args.reason, by: args.by }, args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Re-review of ' + row.id + ': ' + (row.verified ? 'VERIFIED' : 'NOT settled') + ' by ' + row.verifiedBy,
              '- ' + row.verifyReason,
              '',
              row.verified
                ? 'The concern is closed in the matrix (the revision did what the answer said).'
                : 'The matrix now says NO, which is a normal and useful answer: the revision did not do what the answer said it did, and the reason above is what to change.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, summary: row.id + (row.verified ? ' verified' : ' not settled') },
          }
        }

        if (action === 'attack') {
          const row = await raiseAttack(dir, { round, concern: args.concern, severity: args.severity, criterion: args.criterion, evidence: args.evidence, suggestion: args.suggestion, reply: args.reply }, args.now)
          await touchRun(runFile, record, args.now)
          return {
            text: [
              'Attack ' + row.id + ' recorded (round ' + row.round + ')',
              '- ' + row.concern,
              '',
              'When a rebuttal comes back, score it with `action=concede score=1-5 reply="…"`. Below ' + CONCESSION_THRESHOLD + ' the advocate holds position, and the tool will refuse the concession rather than store a quiet surrender.',
            ].join('\n'),
            view: { action, slug, root: resolved.root, summary: row.id + ' attack' },
          }
        }

        // ---- concede, and the two rules that can refuse it
        const result = await concede(dir, { round, concern: args.concern, reply: args.reply, score: args.score }, args.now)
        await touchRun(runFile, record, args.now)
        return {
          text: [
            'Concession recorded for round ' + result.row.round + ' (rebuttal scored ' + result.row.concessionScore + '/' + CONCESSION_MAX + ')',
            '- conceded to: ' + result.row.reply,
            '- the advocate now stands at ' + result.attacks + ' attack(s), ' + result.concessions + ' concession(s), rate ' + Math.round(result.rate * 100) + '%',
            '',
            'Two concessions in a row are refused, so the next entry has to be an attack or a note saying what is left to attack.',
          ].join('\n'),
          view: { action, slug, root: resolved.root, summary: 'conceded at ' + result.row.concessionScore + '/' + CONCESSION_MAX },
        }
      })
    },
  }

  return [open, create, plan, read, write, cite, verify, review, build]
}

// ---------------------------------------------------------------------------
// Shared machinery for the writing tools
// ---------------------------------------------------------------------------
/** The record fields a reference needs, and which the ledger can name an origin for. */
const PROVENANCE_FIELDS = ['kind', 'title', 'authors', 'year', 'container', 'volume', 'issue', 'pages', 'edition', 'publisher', 'place', 'doi', 'url', 'isbn', 'issn', 'accessed', 'note']

/**
 * Where each field of a record came from.
 *
 * The one thing that makes a reference list auditable: a field a resolver
 * supplied is a field nobody typed, and a field the author typed is exactly the
 * field that can be wrong. The answer says both counts, so a reader knows which
 * half to look at.
 */
export function provenanceOf(record, source) {
  const origin = typeof source === 'string' && source !== '' ? source : 'agent'
  const map = {}
  for (const field of PROVENANCE_FIELDS) {
    const value = record === null || record === undefined ? undefined : record[field]
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue
    map[field] = origin
  }
  return map
}

/**
 * The keys closest to a misspelling, so a refusal can suggest rather than scold.
 *
 * A model that writes `@smith2024` against a ledger holding `smith-2024` needs to
 * see the near miss; a bare "unknown key" costs it a round trip to work out which
 * one it meant. Punctuation is IGNORED in the comparison, because the commonest
 * miss is exactly that (`smith-2024` vs `smith2024`), and a small edit distance
 * catches the second commonest (a dropped or doubled letter).
 */
export function nearMisses(key, keys) {
  const strip = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const distance = (left, right) => {
    if (Math.abs(left.length - right.length) > 3) return 4
    const rows = Array.from({ length: left.length + 1 }, (_, index) => [index])
    for (let column = 1; column <= right.length; column += 1) rows[0][column] = column
    for (let row = 1; row <= left.length; row += 1) {
      for (let column = 1; column <= right.length; column += 1) {
        const cost = left[row - 1] === right[column - 1] ? 0 : 1
        rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost)
      }
    }
    return rows[left.length][right.length]
  }
  const wanted = String(key ?? '').toLowerCase()
  const flat = strip(wanted)
  const scored = []
  for (const candidate of keys) {
    const other = String(candidate).toLowerCase()
    const theirs = strip(other)
    let score = 0
    if (other === wanted) score = 100
    else if (theirs === flat && flat !== '') score = 95
    else if (flat !== '' && theirs !== '' && (theirs.startsWith(flat.slice(0, Math.min(6, flat.length))) || flat.startsWith(theirs.slice(0, Math.min(6, theirs.length))))) score = 60
    else {
      const gap = distance(flat.slice(0, 24), theirs.slice(0, 24))
      if (gap <= 2) score = 40 - gap * 5
      else {
        const shared = [...new Set(wanted.split(/[^a-z0-9]+/))].filter((word) => word.length > 2 && other.includes(word))
        score = shared.length * 10
      }
    }
    if (score > 0) scored.push({ candidate, score })
  }
  return scored
    .sort((left, right) => (right.score === left.score ? left.candidate.localeCompare(right.candidate) : right.score - left.score))
    .slice(0, 3)
    .map((entry) => entry.candidate)
}

/** How large an ingested file may be. A run holds sources, not a media library. */
export const MAX_INGEST_BYTES = 64 * 1024 * 1024
/** What `rs_cite` will read from outside the run. Closed, like every other list here. */
export const INGEST_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.ris', '.bib', '.nbib', '.enw', '.csv', '.xml']

/**
 * Read a file the caller names, by the policy `dsh-pdf` already uses.
 *
 * An absolute path is read directly - that is what makes a download or a chat
 * attachment usable - and a relative one resolves inside the workspace, which is
 * the session's own working directory. The ORIGINAL path is handed back with the
 * bytes, because it is recorded in the ledger: a reader must be able to see where
 * a source came from, not only that it has one.
 */
export async function readOutsideFile(resolved, requested) {
  const raw = String(requested ?? '').trim()
  if (raw === '') throw new ResearchError('BAD_PATH', 'give a path to read')
  if (raw.includes('\0')) throw new ResearchError('BAD_PATH', 'a path cannot contain a NUL byte')
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(resolved.workspace, raw)
  const stat = await fsp.stat(target).catch(() => null)
  if (stat === null) throw new ResearchError('NO_SUCH_FILE', 'no file at ' + target)
  if (stat.isDirectory()) {
    throw new ResearchError('NOT_A_FILE', target + ' is a directory - name the file you want, e.g. the PDF inside it')
  }
  if (!stat.isFile()) throw new ResearchError('NOT_A_FILE', target + ' is not a regular file')
  const extension = path.extname(target).toLowerCase()
  if (!INGEST_EXTENSIONS.includes(extension)) {
    throw new ResearchError(
      'BAD_EXTENSION',
      'this plugin ingests ' + INGEST_EXTENSIONS.join(', ') + ' (got ' + JSON.stringify(extension) + '). It extracts no text itself: read the document with the pdf_* tools and pass what they give you as `text=`.',
    )
  }
  if (stat.size > MAX_INGEST_BYTES) {
    throw new ResearchError('TOO_LARGE', target + ' is ' + sizeOf(stat.size) + ', over the ' + sizeOf(MAX_INGEST_BYTES) + ' ingestion cap')
  }
  return { buffer: await fsp.readFile(target), originalPath: target, bytes: stat.size }
}

/** The gate questions, for the row's start-up log line. */
export const GATE_IDS = ALL_GATES.map((gate) => gate.id)
