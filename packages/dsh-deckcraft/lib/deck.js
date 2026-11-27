/**
 * dsh-deckcraft - the engine.
 *
 * DeckCraft's contract, as its README states it: every action is a command with
 * a stable id, so people, scripts and agents use the same verbs. This row drives
 * that contract from the CLI rather than hardcoding 200 tool wrappers:
 *
 *   deckcraft-cli commands [prefix]        list the command ids
 *   deckcraft-cli run --cmd 'id={json}'    run one or more, in order
 *   deckcraft-cli run --save deck.deckcraft
 *   deckcraft-cli render <deck> --all --scale 1 <dir>
 *   deckcraft-cli mcp [--connect 7990]     stdio MCP, or drive the open app
 *
 * TWO RULES.
 * 1. ARGV, NEVER A SHELL: a title, a path or a JSON argument is one argv element.
 * 2. OUTPUTS ARE SCOPED: `--save` and the render directory must resolve inside
 *    the session workspace or a root the caller authorised for that call, so a
 *    command cannot write a deck over the user's documents.
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** One call's default deadline and its ceiling. */
export const DEFAULT_TIMEOUT_MS = 180_000
export const MAX_TIMEOUT_MS = 900_000
/** How much of one stream is kept for the answer. */
export const MAX_STREAM_BYTES = 2 * 1024 * 1024

/** A command id: `format.paragraph`, `slide.new`, `view.zoom` - dotted, lower case. */
const COMMAND_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/

/** Resolve the DeckCraft CLI: the caller's override, then `deckcraft-cli`. */
export function resolveDeckCli(env = process.env, platform = process.platform) {
  const override = env.DSH_DECKCRAFT_CLI
  if (override && override !== '') {
    return existsSync(override) ? { command: override, source: 'DSH_DECKCRAFT_CLI' } : { command: '', source: 'missing-override' }
  }
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== '')
  const exts = platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, 'deckcraft-cli' + ext)
      if (!existsSync(candidate)) continue
      try {
        if (statSync(candidate).isFile()) return { command: candidate, source: 'PATH' }
      } catch {
        // an unreadable PATH entry is not a candidate
      }
    }
  }
  return { command: '', source: 'missing' }
}

/** Whether a string is a DeckCraft command id. */
export function isCommandId(value) {
  return typeof value === 'string' && value.length <= 80 && COMMAND_ID.test(value)
}

/**
 * Parse `deckcraft-cli commands` output into `{ id, summary }` rows.
 *
 * The CLI prints one command per line, `id` then its summary - the column split
 * is whitespace, and a line that does not start with a command id is a header or
 * a note and is skipped rather than guessed at.
 */
export function parseCommandList(text) {
  const rows = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const match = /^([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\s*(.*)$/.exec(line)
    if (!match) continue
    rows.push({ id: match[1], summary: match[2].trim() })
  }
  return rows
}

/** Build the argv for a run: one `--cmd` per entry, then the save path. */
export function buildRunArgs({ commands, save, sample = false, open = false } = {}) {
  if (sample) return ['run', '--sample', ...(save ? ['--save', save] : [])]
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('no commands given')
  if (commands.length > 200) throw new Error('too many commands in one run (200)')
  const args = ['run']
  for (const entry of commands) {
    const [id, ...rest] = String(entry).split('=')
    if (!isCommandId(id)) throw new Error('not a DeckCraft command id: ' + JSON.stringify(id))
    const body = rest.join('=')
    if (body !== '') {
      try {
        JSON.parse(body)
      } catch {
        throw new Error('the argument of ' + id + ' is not JSON: ' + body.slice(0, 120))
      }
    }
    args.push('--cmd', body === '' ? id : id + '=' + body)
  }
  if (save) args.push('--save', save)
  if (open) args.push('--open')
  return args
}

/** Build the argv for a render. */
export function buildRenderArgs({ deck, out, all = true, scale }) {
  if (typeof deck !== 'string' || deck === '') throw new Error('no deck given')
  if (typeof out !== 'string' || out === '') throw new Error('no output directory given')
  const args = ['render', deck]
  if (all) args.push('--all')
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) args.push('--scale', String(scale))
  args.push(out)
  return args
}

/** Build the argv for a probe. */
export function buildProbeArgs(kind) {
  if (kind === 'version') return ['--version']
  if (kind === 'commands') return ['commands']
  if (kind === 'help') return ['--help']
  throw new Error('unknown probe: ' + String(kind))
}

/** True for an http(s) URL (a render target can be one in the web build). */
export function isUrl(value) {
  return /^https?:\/\//i.test(String(value))
}

/**
 * The output scope. A save path or a render directory must resolve inside the
 * workspace (or an allowed root). Symlinks are resolved first so a link inside
 * the workspace cannot point the write elsewhere.
 */
export function assertOutputAllowed({ target, workspace, allowRoot, platform = process.platform, realpath = true }) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('no output path given')
  if (!workspace) throw new Error('refused: no session workspace is known, so no output can be scoped')
  const fold = (value) => (platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value))
  const resolveOne = (value) => {
    const absolute = path.resolve(value)
    if (!realpath) return absolute
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
  const inside = (candidate, root) => {
    const a = fold(resolveOne(candidate))
    const b = fold(resolveOne(root))
    return a === b || a.startsWith(b + path.sep)
  }
  if (inside(target, workspace)) return resolveOne(target)
  if (allowRoot && allowRoot !== '' && inside(target, allowRoot)) return resolveOne(target)
  throw new Error(
    'refused: ' +
      path.resolve(target) +
      ' is outside the session workspace (' +
      path.resolve(workspace) +
      '). Write the deck or the render inside the workspace, or pass allowRoot for this call.',
  )
}

/** Run one argv array. Never a shell; never a command string. */
export function runDeck(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env = process.env, maxBytes = MAX_STREAM_BYTES } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    const collect = (chunk, which) => {
      const current = which === 'out' ? stdout : stderr
      if (current.length >= maxBytes) return
      const room = maxBytes - current.length
      const next = Buffer.concat([current, chunk.subarray(0, room)])
      if (which === 'out') stdout = next
      else stderr = next
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'out'))
    child.stderr.on('data', (chunk) => collect(chunk, 'err'))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, Math.min(Math.max(1_000, timeoutMs), MAX_TIMEOUT_MS))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String(error && error.message ? error.message : error), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut })
    })
  })
}

/** Where decks and renders belong when the caller names neither. */
export function defaultDeckPath(workspace, name = 'deck') {
  return path.join(workspace, 'decks', name + '.deckcraft')
}

/** The settings folder DeckCraft documents, for `deck_status` to point at. */
export function settingsDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'DeckCraft')
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'DeckCraft')
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'deckcraft')
}
