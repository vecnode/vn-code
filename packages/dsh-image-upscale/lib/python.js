/**
 * dsh-image-upscale — find this machine's Python, and run the upscaler with it.
 *
 * The engine is NOT bundled and NOT installed. It is the Python that is already
 * on this machine, with the torch that is already in it: that is the same rule
 * dsh-ocr applies to tesseract and dsh-media to ffmpeg, and it is what keeps a
 * 4,7 MB weight file from turning into a 2 GB wheel set the agent installs
 * without being asked.
 *
 * Three things this module owns:
 *
 *   - **resolution**, in a stated order, because "python" is not always on PATH
 *     and on Windows `py -3` is the launcher that exists when `python` does not;
 *   - **the probe**, run once per boot and cached: a probe imports torch, which
 *     costs seconds, and a conversation that upscales ten images must not pay
 *     that ten times. A probe that FAILS is cached too — a machine does not grow
 *     a GPU by being asked again;
 *   - **argument arrays, never a shell string**: a path with a space, an accent
 *     or a `&` arrives as one argument, exactly as written.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RUNNER = path.join(HERE, 'upscale.py')

/** How long one image may take, and how long a whole batch may. */
export const IMAGE_TIMEOUT_MS = 300000
export const BATCH_TIMEOUT_MS = 3600000

/** The candidates, in order. `DSH_PYTHON` wins because a person may know better. */
export function pythonCandidates(env = process.env, platform = process.platform) {
  const list = []
  if (env.DSH_PYTHON) list.push({ file: env.DSH_PYTHON, args: [], label: env.DSH_PYTHON })
  if (platform === 'win32') {
    list.push({ file: 'python', args: [], label: 'python' })
    list.push({ file: 'py', args: ['-3'], label: 'py -3' })
    list.push({ file: 'python3', args: [], label: 'python3' })
  } else {
    list.push({ file: 'python3', args: [], label: 'python3' })
    list.push({ file: 'python', args: [], label: 'python' })
  }
  return list
}

/** Run the runner and resolve to `{ code, stdout, stderr, json, ms }`. */
export function runRunner(command, args, options = {}) {
  const timeout = options.timeout ?? IMAGE_TIMEOUT_MS
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(command.file, [...command.args, RUNNER, ...args], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message), json: null, ms: 0, spawnError: String(error && error.message) })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch (error) {
        /* already gone */
      }
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout after ' + timeout + ' ms]', json: parseJson(stdout), ms: Date.now() - started, timedOut: true })
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const message = error && error.code === 'ENOENT'
        ? 'não existe nenhum interpretador "' + command.label + '"'
        : String(error && error.message)
      resolve({ code: -1, stdout, stderr, json: parseJson(stdout), ms: Date.now() - started, spawnError: message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, json: parseJson(stdout), ms: Date.now() - started })
    })
  })
}

/** The LAST JSON object printed on stdout — a warning above it changes nothing. */
export function parseJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch (error) {
      /* keep looking upward */
    }
  }
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    return null
  }
}

/**
 * The interpreter that can actually load torch, with the probe it answered.
 *
 * @returns `{ ok, command, probe, tried, message }` — never throws.
 */
export async function detectEngine(options = {}) {
  const candidates = options.candidates ?? pythonCandidates(options.env, options.platform)
  const tried = []
  for (const candidate of candidates) {
    const result = await runRunner(candidate, ['--probe', ...(options.weightsDir ? ['--weights-dir', options.weightsDir] : [])], { timeout: 120000 })
    if (result.json && result.json.ok) {
      return { ok: true, command: candidate, probe: result.json, tried }
    }
    tried.push({
      label: candidate.label,
      reason: result.spawnError
        ? result.spawnError
        : result.json && result.json.message
          ? String(result.json.message)
          : (result.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ') || 'sem resposta utilizável',
    })
  }
  return { ok: false, command: null, probe: null, tried }
}

/** One engine probe per process; a second call answers the first cache. */
let cached = null
export function engine(options = {}) {
  if (cached === null) cached = detectEngine(options)
  return cached
}

export function resetEngineCache() {
  cached = null
}

/** The model names the runner knows; kept in step with `upscale.py` by a check. */
export const MODELS = ['realesr-general-x4v3', 'realesr-animevideov3', 'RealESRGAN_x4plus', 'RealESRGAN_x2plus', 'RealESRNet_x4plus']
export const DEFAULT_MODEL = 'realesr-general-x4v3'

/**
 * The model that does NOT look generated: ESRNet is the same network trained
 * without the adversarial term, so it invents no texture — at the cost of being
 * softer, which `sharpen` compensates. This is the right default for a photo that
 * a person will compare against the original.
 */
export const NATURAL_MODEL = 'RealESRNet_x4plus'
export const NATURAL_SHARPEN = 0.45

/** The weights folder the runner uses when nobody names one. */
export function defaultWeightsDir(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return path.join(home, 'dsh-image-upscale', 'weights')
}

/** `realesr-general-x4v3` at `C:\…\realesr-general-x4v3.pth`. */
export function weightsFile(model, dir) {
  return path.join(dir, model + '.pth')
}

/**
 * The argv one image costs. Pure, so the check can drive it.
 *
 * `scale` and `target_width` are mutually exclusive in intent but not in effect:
 * the runner uses whichever names the final geometry, and a scale with no target
 * means "the model's own scale, reduced to this".
 */
export function imageArgs(plan) {
  const args = ['--input', plan.input, '--output', plan.output, '--model', plan.model]
  if (plan.targetWidth) args.push('--target-width', String(plan.targetWidth))
  else args.push('--scale', String(plan.scale ?? 2))
  args.push('--quality', String(plan.quality ?? 86))
  if (plan.format) args.push('--format', plan.format)
  if (plan.tile) args.push('--tile', String(plan.tile))
  if (plan.sharpen) args.push('--sharpen', String(plan.sharpen))
  if (plan.overwrite) args.push('--overwrite')
  if (plan.dryRun) args.push('--dry-run')
  if (plan.weightsDir) args.push('--weights-dir', plan.weightsDir)
  return args
}
