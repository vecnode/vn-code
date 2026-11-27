/**
 * dsh-deckcraft - the four tools.
 *
 * DeckCraft's own contract is the API here: every button is a command with a
 * stable id, so the tools are discovery (`deck_commands`), execution
 * (`deck_run`), proof (`deck_export`) and readiness (`deck_status`). Nothing is
 * hardcoded: a command id that this build does not offer fails at the CLI with
 * its own message, and `deck_commands` is how the model finds one that does.
 */

import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  assertOutputAllowed,
  buildProbeArgs,
  buildRenderArgs,
  buildRunArgs,
  defaultDeckPath,
  parseCommandList,
  resolveDeckCli,
  runDeck,
  settingsDir,
} from './deck.js'

const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

const ANSWER_CHARS = 16_000

function clip(text, max = ANSWER_CHARS) {
  const value = String(text === undefined || text === null ? '' : text)
  if (value.length <= max) return value
  return value.slice(0, max) + '\n\u2026 [' + (value.length - max) + ' more characters; the answer is cut]'
}

function sessionOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  return session && typeof session.id === 'string' ? session.id : ''
}

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

function refuse(text, view = {}) {
  return { text, view: { ok: false, ...view } }
}

/** Build the tools. @param deps - `{ ctx, env, platform, log }` from the row. */
export function buildTools(deps) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform

  const status = {
    name: 'deck_status',
    description: [
      'Report whether the DeckCraft CLI is installed, its version, and where DeckCraft keeps its settings and logs.',
      'Call it before `deck_commands` or `deck_run` when a call fails: a missing CLI is the difference between "the command id is wrong" and "DeckCraft is not installed".',
      'It installs nothing. If the CLI is missing it names what to install (DeckCraft from storytold/deckcraft, or its `deckcraft-cli` release) and stops.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { type: 'boolean', description: 'Run `deckcraft-cli --version` (a few hundred ms).' },
      },
    },
    output: OUTPUT,
    presentCall: () => ({ card: 'generic', title: 'DeckCraft status', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'DeckCraft status', content: result && result.text ? result.text : '' }),
    async execute(args) {
      const found = resolveDeckCli(env, platform)
      const settings = settingsDir(env, platform)
      if (found.command === '') {
        return refuse(
          [
            'The DeckCraft CLI is not installed (no `deckcraft-cli` on PATH).',
            'Install DeckCraft from https://github.com/storytold/deckcraft/releases (the `deckcraft-cli` archive per OS), or point DSH_DECKCRAFT_CLI at a binary.',
            'This row installs nothing itself: DeckCraft is your app, not an engine this package ships.',
          ].join('\n'),
          { found: false },
        )
      }
      const lines = ['DeckCraft CLI: ' + found.command + ' (' + found.source + ')', 'settings: ' + settings + (existsSync(settings) ? '' : ' (not created yet)')]
      let version = ''
      if (args.probe === true) {
        const probe = await runDeck(found.command, buildProbeArgs('version'), { env, timeoutMs: 20_000 })
        version = (probe.stdout || probe.stderr).trim().split('\n')[0] ?? ''
        lines.push('version: ' + (version === '' ? '(no answer)' : version))
      }
      lines.push('', 'DeckCraft is alpha: command ids move between builds, so `deck_commands` is the source of truth for this one.')
      return { text: lines.join('\n'), view: { ok: true, found: true, command: found.command, version, settings } }
    },
  }

  const commands = {
    name: 'deck_commands',
    description: [
      'List the command ids this DeckCraft build offers (`deckcraft-cli commands [prefix]`), with each command\'s summary.',
      'Use a prefix to keep the list small (`slide.`, `format.`, `view.`). The ids are what `deck_run` takes; do not invent one - a command this build does not have fails at the CLI.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prefix: { type: 'string', description: 'Only ids starting with this prefix, e.g. "slide." or "format.paragraph".' },
        limit: { type: 'number', description: 'How many rows to return. Default 120, at most 400.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'DeckCraft commands', kind: 'other', summary: String(args && args.prefix ? args.prefix : '') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'DeckCraft commands', content: result && result.text ? result.text : '' }),
    async execute(args) {
      const found = resolveDeckCli(env, platform)
      if (found.command === '') return refuse('The DeckCraft CLI is not installed. Call `deck_status`.')
      const argv = ['commands']
      if (typeof args.prefix === 'string' && args.prefix !== '') {
        if (!/^[a-z][a-z0-9.-]{0,40}$/.test(args.prefix)) return refuse('A prefix is letters, digits and dots (e.g. "slide.").')
        argv.push(args.prefix)
      }
      const run = await runDeck(found.command, argv, { env, timeoutMs: 60_000 })
      if (run.code !== 0) return refuse('`deckcraft-cli commands` exited with code ' + run.code + '.\n' + clip(run.stderr || run.stdout, 4_000))
      const rows = parseCommandList(run.stdout)
      if (rows.length === 0) return { text: clip(run.stdout, 6_000), view: { ok: true, count: 0 } }
      const limit = Math.max(1, Math.min(400, typeof args.limit === 'number' ? args.limit : 120))
      const shown = rows.slice(0, limit)
      const lines = shown.map((row) => row.id + (row.summary ? '  ' + row.summary : ''))
      if (rows.length > limit) lines.push('... ' + (rows.length - limit) + ' more; use a prefix or raise limit (max 400)')
      return { text: lines.join('\n'), view: { ok: true, count: rows.length, shown: shown.length } }
    },
  }

  const run = {
    name: 'deck_run',
    description: [
      'Build or edit a deck by running DeckCraft commands and saving a `.deckcraft` file in the workspace.',
      '`commands` is a list like `["slide.new={\\"layout\\":\\"titleOnly\\",\\"title\\":\\"Hello\\"}", "slide.new={\\"layout\\":\\"titleOnly\\",\\"title\\":\\"World\\"}"]` - the id first, then its JSON argument after `=`. They run in order, in one document.',
      'The save path defaults to `decks/deck.deckcraft` in the workspace and must resolve inside it (or inside an `allowRoot` the user authorised). `sample:true` writes DeckCraft\'s built-in sample deck instead, which is the shortest way to prove the CLI works.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'Command ids, each optionally followed by =<JSON>.' },
        sample: { type: 'boolean', description: 'Write the built-in sample deck instead of running commands.' },
        save: { type: 'string', description: 'Workspace-relative .deckcraft path. Default decks/deck.deckcraft.' },
        allowRoot: { type: 'string', description: 'A folder authorised for THIS call when the save path is outside the workspace.' },
        timeoutMs: { type: 'number', description: 'Deadline. Default ' + DEFAULT_TIMEOUT_MS + ', at most ' + MAX_TIMEOUT_MS + '.' },
      },
    },
    output: OUTPUT,
    presentCall: () => ({ card: 'generic', title: 'Build a deck', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'DeckCraft', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const found = resolveDeckCli(env, platform)
      if (found.command === '') return refuse('The DeckCraft CLI is not installed. Call `deck_status`.')
      const sessionId = sessionOf(exec)
      const workspace = workspaceOf(deps.ctx, exec, sessionId)
      if (!workspace) return refuse('No session workspace is known, so the deck has nowhere allowed to go.')
      const wanted = typeof args.save === 'string' && args.save !== '' ? args.save : defaultDeckPath(workspace)
      let savePath
      try {
        savePath = assertOutputAllowed({ target: path.isAbsolute(wanted) ? wanted : path.resolve(workspace, wanted), workspace, allowRoot: args.allowRoot, platform })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      let argv
      try {
        argv = buildRunArgs({ commands: args.commands, sample: args.sample === true, save: savePath })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      mkdirSync(path.dirname(savePath), { recursive: true })
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS
      const result = await runDeck(found.command, argv, { env, cwd: workspace, timeoutMs })
      if (result.timedOut) return refuse('DeckCraft did not finish within ' + timeoutMs + ' ms and was killed. Narrow the command batch or raise timeoutMs.')
      if (result.code !== 0) return refuse('DeckCraft exited with code ' + result.code + '.\n' + clip(result.stderr || result.stdout, 6_000))
      const exists = existsSync(savePath)
      return {
        text: [
          'saved: ' + savePath + (exists ? '' : ' (the CLI did not create it - check the command ids with `deck_commands`)'),
          clip(result.stdout || result.stderr, 4_000),
        ].join('\n'),
        view: { ok: true, path: savePath, exists },
      }
    },
  }

  const exporter = {
    name: 'deck_export',
    description: [
      'Render a deck to PNG images in the workspace (`deckcraft-cli render <deck> --all --scale <n> <dir>`), which is how a deck becomes something a person can look at in the conversation.',
      'The deck must be inside the workspace; the output directory defaults to `renders/<deck name>/`. `scale:2` doubles the pixels for a retina screen.',
      'PDF export is a DeckCraft command (`deck_commands` with the "export." prefix) - use `deck_run` for it, and this tool for the slide images.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['deck'],
      properties: {
        deck: { type: 'string', description: 'A .deckcraft path inside the workspace (relative or absolute).' },
        out: { type: 'string', description: 'Output directory, workspace-relative. Default renders/<deck name>/.' },
        scale: { type: 'number', description: 'Pixel scale, e.g. 1 or 2.' },
        allowRoot: { type: 'string', description: 'A folder authorised for this call when the deck or the output is outside the workspace.' },
        timeoutMs: { type: 'number', description: 'Deadline. Default ' + DEFAULT_TIMEOUT_MS + ', at most ' + MAX_TIMEOUT_MS + '.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Render a deck', kind: 'other', summary: String(args && args.deck ? args.deck : '') }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Rendered slides', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const found = resolveDeckCli(env, platform)
      if (found.command === '') return refuse('The DeckCraft CLI is not installed. Call `deck_status`.')
      const sessionId = sessionOf(exec)
      const workspace = workspaceOf(deps.ctx, exec, sessionId)
      if (!workspace) return refuse('No session workspace is known, so no render can be written.')
      const deckWanted = String(args.deck ?? '')
      if (deckWanted === '') return refuse('`deck` is required.')
      let deckPath
      let outDir
      try {
        deckPath = assertOutputAllowed({ target: path.isAbsolute(deckWanted) ? deckWanted : path.resolve(workspace, deckWanted), workspace, allowRoot: args.allowRoot, platform })
        const name = path.basename(deckPath).replace(/\.deckcraft$/i, '')
        const outWanted = typeof args.out === 'string' && args.out !== '' ? args.out : path.join('renders', name)
        outDir = assertOutputAllowed({ target: path.resolve(workspace, outWanted), workspace, allowRoot: args.allowRoot, platform })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      if (!existsSync(deckPath)) return refuse('No such deck: ' + deckPath + '. `deck_run` writes one.')
      mkdirSync(outDir, { recursive: true })
      let argv
      try {
        argv = buildRenderArgs({ deck: deckPath, out: outDir, all: true, scale: args.scale })
      } catch (error) {
        return refuse(String(error && error.message ? error.message : error))
      }
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS
      const result = await runDeck(found.command, argv, { env, cwd: workspace, timeoutMs })
      if (result.timedOut) return refuse('The render did not finish within ' + timeoutMs + ' ms and was killed.')
      if (result.code !== 0) return refuse('DeckCraft exited with code ' + result.code + '.\n' + clip(result.stderr || result.stdout, 6_000))
      let files = []
      try {
        files = readdirSync(outDir).filter((name) => /\.(png|jpe?g)$/i.test(name)).sort().map((name) => path.join(outDir, name))
      } catch {
        // the directory may not exist if the CLI printed a different path
      }
      return {
        text: [
          'rendered ' + files.length + ' slide image(s) in ' + outDir,
          ...files.slice(0, 40),
          files.length === 0 ? clip(result.stdout || result.stderr, 3_000) : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
        view: { ok: true, dir: outDir, files: files.length },
      }
    },
  }

  return [status, commands, run, exporter]
}
