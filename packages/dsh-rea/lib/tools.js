/**
 * dsh-rea - the five tools.
 *
 * The surface is small on purpose. REA itself has dozens of MCP tools; what a
 * conversation needs is the shape of a proper investigation:
 *
 *   rea_status   what is installed, which commands THIS REA offers, what a
 *                native provider needs (and never installs anything);
 *   rea_inspect  one target -> one stored investigation (REA's --json);
 *   rea_read     a bounded slice of a stored investigation (the report can be
 *                megabytes, so the model walks it instead of swallowing it);
 *   rea_snapshot list / export / import an investigation, so a finding is
 *                reproducible on another machine;
 *   rea_report   a Markdown evidence report in the workspace - the artefact a
 *                person keeps after the conversation ends.
 *
 * Every failure is a sentence, not a stack: a missing binary, a target outside
 * the scope, a JSON answer REA did not print.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  assertTargetAllowed,
  buildInspectArgs,
  investigationDir,
  listInvestigations,
  newInvestigationId,
  parseReaJson,
  readInvestigation,
  resolveRea,
  runRea,
  sliceReport,
  storeInvestigation,
  summarize,
} from './rea.js'

/** The output shape every tool here returns. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** How much of a help text or an error is echoed. */
const ANSWER_CHARS = 16_000

/** Cut a string for the answer, saying that it was cut. */
function clip(text, max = ANSWER_CHARS) {
  const value = String(text === undefined || value === null ? '' : text)
  if (value.length <= max) return value
  return value.slice(0, max) + '\n\u2026 [' + (value.length - max) + ' more characters; the answer is cut]'
}

/** The session id one call belongs to. */
function sessionOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  return session && typeof session.id === 'string' ? session.id : ''
}

/** The workspace folder for a session, or '' when the host cannot name one. */
function workspaceOf(ctx, exec, sessionId) {
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
  if (header && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const live = sessions && typeof sessions.get === 'function' && sessionId !== '' ? sessions.get(sessionId) : undefined
    const cwd = live && live.header ? live.header.cwd : undefined
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    // fall through
  }
  return ''
}

/** A refusal in the shape every tool returns. */
function refuse(text, view = {}) {
  return { text, view: { ok: false, ...view } }
}

/** Build the tools. @param deps - `{ ctx, env, platform, log }` from the row. */
export function buildTools(deps) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform

  /** `rea_status`: what exists here, and what it can do. */
  const status = {
    name: 'rea_status',
    description: [
      'Report whether REA is installed on this machine, which version, and - with `help` - the command names THIS installation actually offers.',
      'Call this BEFORE `rea_inspect`: REA\'s command set is the source of truth (the javascript command is `analyze-javascript-application`, native analysis has its own names, and they have changed between lines). `rea_inspect` refuses a command it has not seen here.',
      'It never installs anything. If REA is missing it names the install command (`npm install --global rea-agents`, or `npx rea-agents@latest setup` for an agent MCP setup) and stops.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { type: 'boolean', description: 'Run `rea --version` (a few hundred ms) instead of only resolving the binary.' },
        help: { type: 'boolean', description: 'Also run `rea --help` and return its clipped text - the command list.' },
      },
    },
    output: OUTPUT,
    presentCall: () => ({ card: 'generic', title: 'REA status', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'REA status', content: result && result.text ? result.text : '' }),
    async execute(args) {
      const found = resolveRea(env, platform)
      if (found.command === '') {
        return refuse(
          [
            'REA is not installed (no `rea` on PATH' + (env.DSH_REA_CLI ? ', and DSH_REA_CLI does not point at a file' : '') + ').',
            'Install it with `npm install --global rea-agents`, or run `npx rea-agents@latest setup` to register it with an agent, then restart the harness.',
            'This row installs nothing itself: REA is your program, not an engine this package ships.',
          ].join('\n'),
          { found: false },
        )
      }
      const lines = ['REA: ' + found.command + ' (' + found.source + ')']
      let version = ''
      if (args.probe === true || args.help === true) {
        const probe = await runRea(found.command, ['--version'], { env, timeoutMs: 20_000 })
        version = (probe.stdout || probe.stderr).trim().split('\n')[0] ?? ''
        lines.push('version: ' + (version === '' ? '(no answer)' : version))
      }
      if (args.help === true) {
        const help = await runRea(found.command, ['--help'], { env, timeoutMs: 30_000 })
        lines.push('', '--- rea --help ---', clip(help.stdout || help.stderr, 8_000))
      }
      lines.push(
        '',
        'Native analysis needs a provider you already own (Hopper, Ghidra, IDA or Kuna); static JavaScript and .NET inspection need none.',
        'The target scope is the session workspace or an `allowRoot` given per call; a URL needs allowUrl:true.',
      )
      return { text: lines.join('\n'), view: { ok: true, found: true, command: found.command, source: found.source, version } }
    },
  }

  /** `rea_inspect`: one target, one stored investigation. */
  const inspect = {
    name: 'rea_inspect',
    description: [
      'Run ONE REA analysis command against ONE target and store the result as an investigation.',
      'The target must be inside the session workspace, or inside a folder the user allowed for this call (`allowRoot`). A URL needs `allowUrl:true` - this row starts no network egress on its own.',
      '`command` defaults to `analyze-javascript-application`; for anything else, call `rea_status` with help:true first and use a name that listing printed. The answer is a summary plus an investigation id; `rea_read` walks the rest.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'An absolute path (or a workspace-relative one) to an app folder, an .asar, a binary, or an http(s) URL with allowUrl:true.' },
        command: { type: 'string', description: 'A REA command name, e.g. analyze-javascript-application. Defaults to that one.' },
        provider: { type: 'string', description: 'A native-analysis provider name for REA (`--provider`), when the command takes one.' },
        json: { type: 'boolean', description: 'Ask REA for --json (default true). Without it the raw text is stored as a .txt-like report and summarised as text.' },
        allowRoot: { type: 'string', description: 'A folder the user authorised for THIS call, used when the target is outside the session workspace.' },
        allowUrl: { type: 'boolean', description: 'Allow an http(s) target. Default false: the row does not reach the network unasked.' },
        timeoutMs: { type: 'number', description: 'Deadline for the analysis. Default ' + DEFAULT_TIMEOUT_MS + ', at most ' + MAX_TIMEOUT_MS + '.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Inspect with REA', kind: 'other', summary: String(args && args.target ? args.target : '') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'REA investigation', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const found = resolveRea(env, platform)
      if (found.command === '') return refuse('REA is not installed. Call `rea_status` for the install command.')
      const command = typeof args.command === 'string' && args.command !== '' ? args.command : 'analyze-javascript-application'
      const json = args.json !== false
      const sessionId = sessionOf(exec)
      const workspace = workspaceOf(deps.ctx, exec, sessionId)
      let target
      try {
        target = assertTargetAllowed({
          target: args.target,
          workspace,
          allowRoot: args.allowRoot,
          allowUrl: args.allowUrl === true,
          platform,
        })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      let argv
      try {
        argv = buildInspectArgs({ command, target, json, provider: args.provider })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS
      const run = await runRea(found.command, argv, { env, cwd: workspace || undefined, timeoutMs })
      if (run.timedOut) {
        return refuse('REA did not finish within ' + timeoutMs + ' ms and was killed. Narrow the target or raise timeoutMs (max ' + MAX_TIMEOUT_MS + ').')
      }
      if (run.code !== 0) {
        return refuse(
          [
            'REA exited with code ' + run.code + '.',
            clip(run.stderr || run.stdout, 4_000),
            'If the command name is wrong, `rea_status` with help:true prints the names this installation knows.',
          ].join('\n'),
          { exitCode: run.code },
        )
      }
      const parsed = json ? parseReaJson(run.stdout) : { ok: false, error: 'text mode' }
      const id = newInvestigationId(target)
      let stored
      try {
        stored = storeInvestigation({
          id,
          target,
          command,
          provider: args.provider,
          payload: parsed.ok ? parsed.value : undefined,
          text: parsed.ok ? undefined : run.stdout,
          code: run.code,
          env,
        })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      const lines = [
        'investigation ' + id,
        'target: ' + target,
        'command: ' + command + (args.provider ? ' (provider ' + args.provider + ')' : ''),
        'stored: ' + stored.dir + ' (' + stored.bytes + ' bytes)',
        '',
      ]
      if (parsed.ok) {
        lines.push('top-level shape:')
        lines.push(...summarize(parsed.value))
      } else {
        lines.push('REA did not print a JSON object (' + parsed.error + '); the raw output is stored and summarised below:')
        lines.push('', clip(run.stdout, 6_000))
      }
      lines.push('', 'Use `rea_read` with this id to walk the report, and `rea_report` to write the evidence into the workspace.')
      return {
        text: lines.join('\n'),
        view: { ok: true, id, target, command, bytes: stored.bytes, json: parsed.ok },
      }
    },
  }

  /** `rea_read`: a bounded slice of a stored investigation. */
  const read = {
    name: 'rea_read',
    description: [
      'Read a stored investigation: `summary` lists what it is and its top-level shape; `raw` returns a 1-based line range of the stored report.',
      'Use `raw` with offset/limit to walk a large report without loading it whole. The byte ceiling and the total line count are reported with every slice.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'An investigation id, as `rea_inspect` returned it.' },
        section: { type: 'string', enum: ['summary', 'raw'], description: 'summary (default) or raw.' },
        offset: { type: 'number', description: 'For raw: the first line, 1-based. Default 1.' },
        limit: { type: 'number', description: 'For raw: how many lines. Default 120, at most 2000.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Read an investigation', kind: 'other', summary: String(args && args.id ? args.id : '') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Investigation', content: result && result.text ? result.text : '' }),
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id : ''
      if (id === '') return refuse('`id` is required; `rea_snapshot` with action:list prints the ids that exist.')
      let stored
      try {
        stored = readInvestigation(id, env)
      } catch {
        return refuse('No stored investigation "' + id + '". `rea_snapshot` with action:list prints the ids that exist.')
      }
      const section = args.section === 'raw' ? 'raw' : 'summary'
      if (section === 'summary') {
        const lines = [
          'investigation ' + stored.meta.id,
          'target: ' + stored.meta.target,
          'command: ' + stored.meta.command,
          'created: ' + stored.meta.created,
          'bytes: ' + stored.meta.bytes,
          '',
        ]
        const parsed = parseReaJson(stored.raw)
        if (parsed.ok) lines.push('top-level shape:', ...summarize(parsed.value))
        else lines.push('the report is not JSON; read it with section:raw.')
        return { text: lines.join('\n'), view: { ok: true, id, section } }
      }
      const slice = sliceReport(stored.raw, { offset: args.offset, limit: args.limit })
      return {
        text: 'investigation ' + id + ' lines ' + slice.start + '-' + slice.end + ' of ' + slice.total + '\n\n' + slice.text,
        view: { ok: true, id, section, start: slice.start, end: slice.end, total: slice.total },
      }
    },
  }

  /** `rea_snapshot`: list, export, import. */
  const snapshot = {
    name: 'rea_snapshot',
    description: [
      'Make an investigation portable: `list` (ids, targets, dates), `export` (write one investigation as a single JSON bundle into the workspace) or `import` (store a bundle from the workspace under a new id).',
      'Use it when a finding has to survive another machine, or when the same target is inspected twice and the two reports are compared.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'export', 'import'] },
        id: { type: 'string', description: 'For export: the investigation id. For import: the id to store it under (default: from the bundle).' },
        path: { type: 'string', description: 'For export: the bundle path (workspace-relative, default rea/<id>.json). For import: the bundle to read.' },
        allowRoot: { type: 'string', description: 'For import: a folder authorised for this call when the bundle is outside the workspace.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'REA snapshots', kind: 'other', summary: String(args && args.action ? args.action : 'list') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Investigations', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const action = args.action
      if (action === 'list') {
        const rows = listInvestigations(env)
        if (rows.length === 0) return { text: 'No investigations stored yet. `rea_inspect` creates one.', view: { ok: true, count: 0 } }
        const lines = rows.map((row) => row.id + '  ' + row.created + '  ' + row.command + '  ' + row.target)
        return { text: lines.join('\n'), view: { ok: true, count: rows.length } }
      }
      const sessionId = sessionOf(exec)
      const workspace = workspaceOf(deps.ctx, exec, sessionId)
      if (action === 'export') {
        const id = typeof args.id === 'string' ? args.id : ''
        if (id === '') return refuse('`id` is required for export.')
        let stored
        try {
          stored = readInvestigation(id, env)
        } catch {
          return refuse('No stored investigation "' + id + '".')
        }
        if (!workspace) return refuse('No session workspace is known, so there is nowhere allowed to write the bundle.')
        const wanted = typeof args.path === 'string' && args.path !== '' ? args.path : path.join('rea', id + '.json')
        let out
        try {
          out = assertTargetAllowed({ target: path.resolve(workspace, wanted), workspace, platform })
        } catch (error) {
          return refuse(String(error && error.message ? error.message : error))
        }
        const bundle = { format: 'dsh-rea/snapshot@1', meta: stored.meta, report: parseReaJson(stored.raw) }
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify(bundle, null, 2), 'utf8')
        return { text: 'exported ' + id + ' -> ' + out, view: { ok: true, id, path: out } }
      }
      if (action === 'import') {
        const value = typeof args.path === 'string' ? args.path : ''
        if (value === '') return refuse('`path` is required for import.')
        if (!workspace) return refuse('No session workspace is known, so no bundle can be scoped.')
        let file
        try {
          file = assertTargetAllowed({ target: path.resolve(workspace, value), workspace, allowRoot: args.allowRoot, platform })
        } catch (error) {
          return refuse(String(error && error.message ? error.message : error))
        }
        if (!existsSync(file)) return refuse('No such bundle: ' + file)
        let bundle
        try {
          bundle = JSON.parse(readFileSync(file, 'utf8'))
        } catch (error) {
          return refuse('That file is not a JSON bundle: ' + String(error && error.message ? error.message : error))
        }
        if (!bundle || bundle.format !== 'dsh-rea/snapshot@1' || !bundle.report) {
          return refuse('Not a dsh-rea snapshot bundle (format ' + JSON.stringify(bundle && bundle.format) + ').')
        }
        const id = typeof args.id === 'string' && args.id !== '' ? args.id : bundle.meta && bundle.meta.id ? bundle.meta.id : newInvestigationId(file)
        try {
          const stored = storeInvestigation({
            id,
            target: bundle.meta ? bundle.meta.target : '',
            command: bundle.meta ? bundle.meta.command : '',
            payload: bundle.report.ok ? bundle.report.value : undefined,
            text: bundle.report.ok ? undefined : String(bundle.report),
            env,
          })
          return { text: 'imported ' + id + ' (' + stored.bytes + ' bytes) from ' + file, view: { ok: true, id, path: file } }
        } catch (error) {
          return refuse(String(error && error.message ? error.message : error))
        }
      }
      return refuse('Unknown action ' + JSON.stringify(action) + '; use list, export or import.')
    },
  }

  /** `rea_report`: the artefact a person keeps. */
  const report = {
    name: 'rea_report',
    description: [
      'Write a Markdown evidence report for one stored investigation into the workspace (default `rea/<id>.md`).',
      'The report holds the question, the target, what REA reported at the top level, the investigation id it came from, and the limits of the finding - so a reader can re-run the investigation instead of trusting the prose.',
      'Pass `question` with the user\'s own words: the report is much less useful without the question it answers.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The investigation id.' },
        question: { type: 'string', description: 'The question this investigation answers, in the user\'s words.' },
        path: { type: 'string', description: 'Workspace-relative report path. Default rea/<id>.md.' },
        allowRoot: { type: 'string', description: 'A folder authorised for this call when the report belongs outside the workspace.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'REA report', kind: 'other', summary: String(args && args.id ? args.id : '') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Evidence report', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const id = typeof args.id === 'string' ? args.id : ''
      if (id === '') return refuse('`id` is required.')
      let stored
      try {
        stored = readInvestigation(id, env)
      } catch {
        return refuse('No stored investigation "' + id + '".')
      }
      const sessionId = sessionOf(exec)
      const workspace = workspaceOf(deps.ctx, exec, sessionId)
      if (!workspace) return refuse('No session workspace is known, so the report has nowhere allowed to go.')
      const wanted = typeof args.path === 'string' && args.path !== '' ? args.path : path.join('rea', id + '.md')
      let out
      try {
        out = assertTargetAllowed({ target: path.resolve(workspace, wanted), workspace, allowRoot: args.allowRoot, platform })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      const parsed = parseReaJson(stored.raw)
      const lines = [
        '# Reverse-engineering report',
        '',
        'Question: ' + (typeof args.question === 'string' && args.question !== '' ? args.question : '(not recorded)'),
        '',
        'Target: `' + stored.meta.target + '`',
        'Investigation: `' + id + '` \\u00b7 command `' + stored.meta.command + '`',
        'Created: ' + stored.meta.created,
        '',
        '## What the tool reported (top level)',
        '',
        '```text',
        ...(parsed.ok ? summarize(parsed.value) : ['(the stored report is not JSON; read it with rea_read, section:raw)']),
        '```',
        '',
        '## Evidence',
        '',
        '- The report is stored verbatim at the investigation directory above; `rea_read` with section:raw returns it line by line.',
        '- `rea_snapshot` action:export writes it as one JSON bundle, so this finding can be re-opened elsewhere.',
        '- Nothing in this report is a claim about the target beyond what REA returned: a decompiler prints pseudocode, and a static pass sees code, not behaviour.',
        '',
        '## Limits',
        '',
        '- Authorised targets only: software you own or are allowed to examine.',
        '- A native finding depends on the provider that produced it (Hopper, Ghidra, IDA, Kuna); name it when the finding leaves this machine.',
      ]
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, lines.join('\n') + '\n', 'utf8')
      return { text: 'wrote ' + out + '\n\n' + clip(lines.join('\n'), 3_000), view: { ok: true, id, path: out } }
    },
  }

  return [status, inspect, read, snapshot, report]
}
