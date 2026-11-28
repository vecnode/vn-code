/**
 * dsh-comfyui — comfy-cli: one bounded child process, and the argv this row uses.
 *
 * WHY THE CLI AT ALL, when there is an HTTP API: comfy-cli is a SECOND
 * implementation of the same idea, and that is what makes it worth driving. It
 * resolves the workspace, converts a UI workflow to the API form, uploads what a
 * graph needs, submits, waits and downloads - all of which this package does
 * itself. When the server's `/prompt` accepts a prompt this row compiled AND
 * `comfy run --workflow` accepts the canvas the same row generated, the two
 * readings agree, and neither one is the only witness.
 *
 * MEASURED AGAINST comfy-cli 1.29.0 (not guessed - every shape below was read off
 * the real program):
 *
 *   - `--json` is a GLOBAL option that goes BEFORE the subcommand
 *     (`comfy --json env`, never `comfy env --json`, which is a usage error);
 *   - with stdout piped the CLI picks JSON on its own, but passing `--json`
 *     explicitly is what makes that a contract rather than a coincidence;
 *   - every JSON answer is an ENVELOPE:
 *     `{schema, type, ok, command, version, where, data, error}` - so a
 *     subcommand's payload lives under `data`, and the CLI's own version is a
 *     TOP-LEVEL field rather than something to scrape with a regex;
 *   - `comfy env` and `comfy which` report the workspace and whether it EXISTS,
 *     the Desktop installs comfy-cli knows about (`code_dir`, `data_dir`,
 *     `python`, `model_roots`), the running server and the hardware. That is a
 *     discovery source this row would otherwise have to guess at.
 *
 * RULES, all of them the same rule: argv ARRAY, no shell, a deadline, a byte
 * ceiling, `--json` wherever the CLI offers it, and `--workspace` naming a REAL
 * ComfyUI tree when this row found one (comfy-cli's default is
 * `<HOME>/comfy/ComfyUI`, which on a Desktop machine usually does not exist).
 * This module never runs `comfy install`, never installs a node, never downloads
 * a model and never deletes anything.
 */

import { spawn } from 'node:child_process'

/** The environment variable that pins a comfy binary PATH does not carry. */
export const CLI_ENV = 'DSH_COMFY_CLI'

/** The command name comfy-cli installs. */
export const CLI_NAME = 'comfy'

/** How long a read-only CLI call may take. */
export const READ_TIMEOUT_MS = 20000

/** How long `comfy run` may take: a CPU render of a 30-step graph is minutes. */
export const RUN_TIMEOUT_MS = 900000

/** The most output this row keeps from one child process. */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/** The global flag that turns every answer into one JSON envelope. */
export const JSON_FLAG = '--json'

/**
 * Run one argv array and collect its output.
 *
 * @param argv - the program and its arguments, one element each.
 * @param options - `{ timeoutMs, maxBytes, env, cwd }`.
 * @returns `{ status, stdout, stderr, timedOut, error }`; `status` is null when
 *   the program could not start at all.
 */
export function runProcess(argv, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_STDOUT_BYTES
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: options.env ?? process.env, cwd: options.cwd })
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', timedOut: false, error: error && error.message ? String(error.message) : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch (error) {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ status: null, stdout, stderr, timedOut, error: error && error.message ? String(error.message) : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ status: code, stdout, stderr, timedOut })
    })
  })
}

/** The binary this row will try: the pinned one, else the name on PATH. */
export function cliCommand(env = process.env) {
  const pinned = String(env[CLI_ENV] ?? '').trim()
  return pinned === '' ? CLI_NAME : pinned
}

/**
 * The argv for one `comfy` invocation.
 *
 * `--json` and `--workspace` are GLOBAL options, so they go before the
 * subcommand - `comfy env --json` is a usage error on 1.29.0, and putting it
 * after the verb is the mistake this helper exists to prevent.
 *
 * @param command - the binary.
 * @param args - the subcommand and its own arguments.
 * @param options - `{ workspace }`.
 */
export function argvFor(command, args, options = {}) {
  const argv = [command]
  if (typeof options.workspace === 'string' && options.workspace !== '') argv.push('--workspace=' + options.workspace)
  argv.push(JSON_FLAG, ...args)
  return argv
}

/**
 * `comfy --version`, and whether the CLI is usable at all.
 *
 * The envelope carries the version as a top-level string, which is read first;
 * the regex is only the fallback for an older CLI that printed prose.
 *
 * @returns `{ found, command, version, envelope, error }`.
 */
export async function cliVersion(runner, env = process.env, options = {}) {
  const command = cliCommand(env)
  const result = await runner([command, '--version'], { timeoutMs: options.timeoutMs ?? 8000, env })
  if (result === null || result === undefined) return { found: false, command, version: '', envelope: null, error: 'the runner returned nothing' }
  if (result.status === null) return { found: false, command, version: '', envelope: null, error: result.error ?? 'the command could not start' }
  const text = String(result.stdout ?? '') + '\n' + String(result.stderr ?? '')
  const parsed = parseEnvelope(String(result.stdout ?? ''))
  const envelope = parsed.data !== null && typeof parsed.data === 'object' && parsed.data.type === 'envelope' ? parsed.data : null
  const fromEnvelope = envelope !== null && typeof envelope.version === 'string' ? envelope.version : ''
  const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(text)
  const version = fromEnvelope !== '' ? fromEnvelope : match === null ? '' : match[1]
  if (version === '') return { found: false, command, version: '', envelope, error: (String(result.stderr ?? '').trim() || 'exit code ' + result.status).split('\n')[0] }
  return { found: true, command, version, envelope, error: '' }
}

/** Parse the JSON envelope one `--json` command emits, keeping the raw text. */
export function parseEnvelope(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { data: null, text: trimmed }
  try {
    return { data: JSON.parse(trimmed), text: trimmed }
  } catch (error) {
    // Some commands print a log line before the envelope. Take the last object
    // that parses, which is the envelope by construction.
    const lines = trimmed.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines.slice(index).join('\n').trim()
      if (!candidate.startsWith('{')) continue
      try {
        return { data: JSON.parse(candidate), text: trimmed }
      } catch (err) {
        continue
      }
    }
    return { data: null, text: trimmed }
  }
}

/**
 * One `--json` call, as `{ ok, data, envelope, error, stdout, stderr, status }`.
 *
 * A refusal is NOT an exception: comfy-cli answers a failure with `ok: false`
 * and an `error.message` that is the sentence a person needs (`'<path>' is not a
 * valid ComfyUI workspace`, `ComfyUI-Manager not found`), so it is returned and
 * reported rather than thrown.
 */
export async function cliJson(runner, args, options = {}) {
  const command = options.command ?? cliCommand(options.env ?? process.env)
  const argv = argvFor(command, args, { workspace: options.workspace })
  const result = await runner(argv, { timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS, env: options.env ?? process.env })
  if (result === null || result === undefined) return { ok: false, argv, envelope: null, data: null, error: 'the runner returned nothing', stdout: '', stderr: '', status: null }
  if (result.status === null) return { ok: false, argv, envelope: null, data: null, error: result.error ?? 'the command could not start', stdout: '', stderr: '', status: null }
  const parsed = parseEnvelope(String(result.stdout ?? ''))
  const envelope = parsed.data !== null && typeof parsed.data === 'object' && parsed.data.type === 'envelope' ? parsed.data : null
  const message = envelope !== null && envelope.error !== null && typeof envelope.error === 'object' && typeof envelope.error.message === 'string' ? envelope.error.message : ''
  const stderrText = String(result.stderr ?? '').trim()
  return {
    ok: result.status === 0 && (envelope === null || envelope.ok !== false),
    argv,
    envelope,
    data: envelope !== null && envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : null,
    error: message !== '' ? message : stderrText.split('\n')[0] ?? '',
    stderr: stderrText,
    stdout: String(result.stdout ?? '').trim(),
    status: result.status,
  }
}

/**
 * `comfy env` as the SIX things a reader needs.
 *
 * Read straight from the measured envelope (1.29.0):
 * `data.workspace.{path,exists,type,manager_mode,desktop.{installs[],model_roots}}`,
 * `data.server.{running,url}`, `data.python.{version,executable}`,
 * `data.hardware.{os,ram_bytes,gpu.{model,vram_bytes}}`, `data.warnings[]`.
 * Nothing is guessed by key-name heuristics any more: a walker that looked for
 * "something with a slash in it" would happily report the config path as the
 * workspace.
 */
export function envFacts(data) {
  const facts = { workspace: '', workspaceExists: null, workspaceType: '', python: '', pythonVersion: '', comfyuiVersion: '', serverRunning: null, serverUrl: '', managerMode: '', gpu: '', vramBytes: null, ramBytes: null, os: '', warnings: [], installs: [], modelRoots: [] }
  if (data === null || typeof data !== 'object') return facts
  const workspace = data.workspace !== null && typeof data.workspace === 'object' ? data.workspace : {}
  if (typeof workspace.path === 'string') facts.workspace = workspace.path
  if (typeof workspace.exists === 'boolean') facts.workspaceExists = workspace.exists
  if (typeof workspace.type === 'string') facts.workspaceType = workspace.type
  if (typeof workspace.manager_mode === 'string') facts.managerMode = workspace.manager_mode
  const desktop = workspace.desktop !== null && typeof workspace.desktop === 'object' ? workspace.desktop : {}
  if (typeof desktop.comfyui_version === 'string') facts.comfyuiVersion = desktop.comfyui_version
  if (Array.isArray(desktop.installs)) {
    facts.installs = desktop.installs
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        codeDir: typeof entry.code_dir === 'string' ? entry.code_dir : '',
        dataDir: typeof entry.data_dir === 'string' ? entry.data_dir : '',
        version: typeof entry.comfyui_version === 'string' ? entry.comfyui_version : '',
        exists: entry.exists === true,
        selected: entry.selected === true,
      }))
  }
  if (Array.isArray(desktop.model_roots)) facts.modelRoots = desktop.model_roots.filter((entry) => typeof entry === 'string')
  const server = data.server !== null && typeof data.server === 'object' ? data.server : {}
  if (typeof server.running === 'boolean') facts.serverRunning = server.running
  if (typeof server.url === 'string') facts.serverUrl = server.url
  const python = data.python !== null && typeof data.python === 'object' ? data.python : {}
  if (typeof python.executable === 'string') facts.python = python.executable
  if (typeof python.version === 'string') facts.pythonVersion = python.version
  const hardware = data.hardware !== null && typeof data.hardware === 'object' ? data.hardware : {}
  if (typeof hardware.os === 'string') facts.os = hardware.os
  if (typeof hardware.ram_bytes === 'number') facts.ramBytes = hardware.ram_bytes
  const gpu = hardware.gpu !== null && typeof hardware.gpu === 'object' ? hardware.gpu : {}
  if (typeof gpu.model === 'string') facts.gpu = gpu.model
  if (typeof gpu.vram_bytes === 'number') facts.vramBytes = gpu.vram_bytes
  if (Array.isArray(data.warnings)) {
    facts.warnings = data.warnings
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.message === 'string')
      .map((entry) => ({ code: typeof entry.code === 'string' ? entry.code : '', message: entry.message }))
  }
  return facts
}

/** `comfy which` as the one fact it carries: the workspace path, and whether it exists. */
export function whichFacts(data) {
  if (data === null || typeof data !== 'object') return { workspace: '', exists: null }
  return {
    workspace: typeof data.workspace_path === 'string' ? data.workspace_path : '',
    exists: typeof data.exists === 'boolean' ? data.exists : null,
  }
}

/** `comfy node deps-in-workflow` - the custom nodes one workflow needs. */
export function depsArgv(command, workflowFile, outputFile, options = {}) {
  return argvFor(command, ['node', 'deps-in-workflow', '--workflow=' + workflowFile, '--output=' + outputFile], options)
}

/** `comfy run --workflow <file> --wait` - the CLI's own test path. */
export function runArgv(command, workflowFile, options = {}) {
  return argvFor(command, ['run', '--workflow', workflowFile, '--wait'], options)
}

/** `comfy launch --background`. */
export function launchArgv(command, options = {}) {
  return argvFor(command, ['launch', '--background'], options)
}

/** `comfy stop`. */
export function stopArgv(command, options = {}) {
  return argvFor(command, ['stop'], options)
}

/** `comfy which`. */
export function whichArgv(command, options = {}) {
  return argvFor(command, ['which'], options)
}

/** `comfy env`. */
export function envArgv(command, options = {}) {
  return argvFor(command, ['env'], options)
}

/**
 * The two refusals comfy-cli gives before it can look at a graph, as sentences a
 * reader can act on rather than raw stderr.
 *
 * Both were MEASURED on 1.29.0: the first when the default workspace
 * (`<HOME>/comfy/ComfyUI`) does not exist, the second when it does but has no
 * ComfyUI-Manager - which is the state of a Desktop install, because Desktop
 * ships its own Manager inside the app rather than in the tree.
 */
export function explainCliFailure(text) {
  const value = String(text ?? '')
  if (/server_not_running|ComfyUI not running on specified address/i.test(value)) {
    return 'the CLI reached a real workspace but no server was listening. Start one: open the ComfyUI app, `comfy launch --background` (this row drives it as `comfy_cli` action=launch), or point the CLI at a server you started yourself with COMFY_LOCAL_URL=http://127.0.0.1:8188. `comfy_run` does the same job over HTTP and needs no CLI.'
  }
  if (/is not a valid ComfyUI workspace/i.test(value)) {
    return 'comfy-cli could not resolve a ComfyUI workspace. Its default is <HOME>/comfy/ComfyUI, which does not exist on a Desktop machine. Point it at a real tree with `--workspace` (this row passes the install `comfy_status` found), or create one with `comfy install`.'
  }
  if (/ComfyUI-Manager not found/i.test(value)) {
    return 'the workspace has no ComfyUI-Manager, and `comfy node deps-in-workflow` resolves node packs through the Manager\'s `cm-cli`. A tree made by `comfy install` has one; a Desktop install keeps its Manager inside the app, so `deps` does not work against it. `comfy run --workflow` does not need it.'
  }
  if (/No such option: --json/i.test(value)) {
    return 'this comfy-cli is older than the global `--json` flag; an answer without an envelope is still read, but the version should be checked.'
  }
  return ''
}

/** A prompt_id out of `comfy run`'s output, whichever way it prints it. */
export function promptIdFromRunText(text) {
  const value = String(text ?? '')
  const json = parseEnvelope(value)
  if (json.data !== null && typeof json.data === 'object') {
    const found = findPromptId(json.data)
    if (found !== '') return found
  }
  const match = /(?:prompt[ _]?id["'\s:=]+)([0-9a-fA-F-]{16,})/i.exec(value)
  return match ? match[1] : ''
}

/** The first `prompt_id`-looking value inside an object tree. */
function findPromptId(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return ''
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /prompt_?id/i.test(key) && entry.length >= 8) return entry
    if (entry !== null && typeof entry === 'object') {
      const nested = findPromptId(entry, depth + 1)
      if (nested !== '') return nested
    }
  }
  return ''
}
