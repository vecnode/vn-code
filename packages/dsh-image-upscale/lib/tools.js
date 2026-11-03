/**
 * dsh-image-upscale â€” the four tools the agent calls.
 *
 * The pack's other host rows answer questions about files. This one MAKES a
 * file, and that changes what the tools have to say:
 *
 *   - `upscale_info` is the question you ask before the first image: is there a
 *     torch here, is CUDA there, which models are on disk. It never writes;
 *   - `upscale_image` produces ONE new file. It refuses to write over an
 *     existing one unless `overwrite: true` names that intention, because the
 *     reason this row exists is a second copy of an image, not a replaced one;
 *   - `upscale_batch` is the shape a repository actually needs: a manifest of
 *     input/output pairs, `dry_run` by DEFAULT, and a summary that names every
 *     file it wrote, every file it skipped and why;
 *   - `upscale_fetch_weights` is the only thing here that touches the network,
 *     it downloads from ONE pinned URL, and it does nothing without `confirm`
 *     set to the model's own name.
 *
 * The answer beside the numbers is the honest part: which model ran, on which
 * device, what it cost in milliseconds and bytes. A 300px product photograph
 * enlarged 4x and reduced to 600 is a real improvement; a LOGO enlarged the same
 * way is not, and the tool says so when a caller asks for one.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'

import { BATCH_TIMEOUT_MS, DEFAULT_MODEL, IMAGE_TIMEOUT_MS, MODELS, imageArgs, runRunner, weightsFile } from './python.js'
import { UpscaleError, resolveInput, resolveOutput } from './paths.js'

const MODELS_INFO = {
  'realesr-general-x4v3': {
    bytes: 4_700_000,
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth',
    good: 'photographs: product shots, scenes, objects on a plain background',
  },
  'realesr-animevideov3': {
    bytes: 2_400_000,
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth',
    good: 'clean line art and illustrations',
  },
  RealESRGAN_x4plus: {
    bytes: 67_000_000,
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
    good: 'difficult photography: noise, compression, soft focus (slower)',
  },
  RealESRGAN_x2plus: {
    bytes: 67_000_000,
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
    good: 'the same, when 2x is all that is needed',
  },
  RealESRNet_x4plus: {
    bytes: 67_000_000,
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth',
    good: 'the one that does NOT look generated: same network, no adversarial term, no invented ' +
      'texture. Softer, so pair it with `sharpen` (0.4-0.5)',
  },
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif']

const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    output: { type: 'string' },
    model: { type: 'string' },
    device: { type: 'string' },
    in_width: { type: 'number' },
    in_height: { type: 'number' },
    out_width: { type: 'number' },
    out_height: { type: 'number' },
    bytes: { type: 'number' },
    ms: { type: 'number' },
  },
  required: ['output'],
}

// A STATUS view, not a produced file. `upscale_info` answers "can this machine
// enlarge anything", and on a host with no torch the honest answer has no model,
// no device and no output path at all - so nothing here can be required. Reusing
// VIEW_SCHEMA for it is what made EVERY `upscale_info` answer fail the registry's
// own schema check with `missing required property "value.view.output"`, the
// refusal branch (`view: {}`) and the success branch ({ model, device }) alike.
// The row's own check now validates all four tools against their declared schema.
const INFO_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    python: { type: 'string' },
    device: { type: 'string' },
    model: { type: 'string' },
    models: { type: 'array', items: { type: 'string' } },
  },
}

const PATH_SCHEMA = {
  type: 'string',
  description:
    "The image to enlarge: a path inside this conversation's workspace (relative), or an absolute path anywhere on this machine.",
}

/** The session id one tool call belongs to; '' when the call has none. */
export function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session ? session.id : undefined
  return typeof id === 'string' ? id : ''
}

/** `1.2 MB`, for an answer a reader can weigh. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Whether a model name is one the runner knows (case-sensitive, on purpose). */
export function isModel(name) {
  return typeof name === 'string' && MODELS.includes(name)
}

/**
 * Turn a manifest into the list of jobs, or the list of reasons it is not one.
 *
 * Pure, so the package's check can drive it without a GPU: `{ ok, items, errors }`.
 * An entry may override the model, quality, format and geometry; anything the
 * entry leaves out comes from the call's defaults.
 */
export function planBatch(entries, defaults = {}) {
  const errors = []
  const items = []
  if (!Array.isArray(entries)) {
    return { ok: false, items, errors: ['The manifest must be a JSON array of { "input", "output" } objects.'] }
  }
  entries.forEach((entry, index) => {
    const where = 'entry ' + (index + 1)
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(where + ': not an object.')
      return
    }
    const input = typeof entry.input === 'string' ? entry.input.trim() : ''
    const output = typeof entry.output === 'string' ? entry.output.trim() : ''
    if (input === '') errors.push(where + ': no "input".')
    if (output === '') errors.push(where + ': no "output".')
    if (input === '' || output === '') return
    if (input.replace(/\\/g, '/') === output.replace(/\\/g, '/')) {
      errors.push(where + ': the output is the input. This row never alters the original.')
      return
    }
    const model = entry.model ?? defaults.model ?? DEFAULT_MODEL
    if (!isModel(model)) {
      errors.push(where + ': unknown model "' + model + '". Use one of ' + MODELS.join(', ') + '.')
      return
    }
    const targetWidth = Number(entry.target_width ?? entry.targetWidth ?? 0)
    const scale = Number(entry.scale ?? defaults.scale ?? 2)
    // 0 means "no target width": the entry is asking for a scale instead.
    if (!Number.isFinite(targetWidth) || targetWidth < 0 || targetWidth > 16384) {
      errors.push(where + ': "target_width" must be between 1 and 16384, or absent.')
      return
    }
    if (!Number.isFinite(scale) || scale < 1 || scale > 8) {
      errors.push(where + ': "scale" must be between 1 and 8.')
      return
    }
    const quality = Number(entry.quality ?? defaults.quality ?? 86)
    if (!Number.isFinite(quality) || quality < 40 || quality > 100) {
      errors.push(where + ': "quality" must be between 40 and 100.')
      return
    }
    const format = String(entry.format ?? defaults.format ?? '').toLowerCase()
    if (format !== '' && !['jpg', 'jpeg', 'png', 'webp'].includes(format)) {
      errors.push(where + ': "format" must be jpg, png or webp.')
      return
    }
    items.push({ input, output, model, targetWidth, scale, quality, format: format || null,
                 sharpen: Number(entry.sharpen ?? defaults.sharpen ?? 0) })
  })
  return { ok: errors.length === 0, items, errors }
}

/** One sentence about what the engine can do here. */
export function engineLine(probe) {
  if (!probe) return 'no usable Python with torch was found'
  const device = probe.cuda ? 'CUDA on ' + probe.gpu : 'CPU only'
  const ready = MODELS.filter((name) => probe.models && probe.models[name])
  return (
    'python ' + probe.python + ', torch ' + probe.torch + ' (' + device + ')' +
    (probe.basicsr ? '' : ' â€” basicsr does NOT import, so no model will load') +
    '; models on disk: ' + (ready.length ? ready.join(', ') : 'none')
  )
}

/** Follow a redirect chain to a file on disk, reporting progress as bytes. */
function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('too many redirects'))
      return
    }
    https
      .get(url, { headers: { 'user-agent': 'dsh-image-upscale' } }, (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          const next = new URL(response.headers.location, url).toString()
          resolve(download(next, destination, redirects + 1))
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error('HTTP ' + status + ' from ' + url))
          return
        }
        const expected = Number(response.headers['content-length'] ?? 0)
        let seen = 0
        const stream = createWriteStream(destination)
        response.on('data', (chunk) => {
          seen += chunk.length
        })
        response.pipe(stream)
        stream.on('finish', () => {
          stream.close(() => resolve({ bytes: seen, expected }))
        })
        stream.on('error', reject)
        response.on('error', reject)
      })
      .on('error', reject)
  })
}

/**
 * Build the four tools.
 *
 * @param deps - `{ ctx, engine(options), log, dshHome }`.
 * @returns the tool definitions to register.
 */
export function buildTools(deps) {
  const engine = deps.engine
  const log = deps.log ?? { warn: () => {}, info: () => {} }
  const weightsDir = deps.weightsDir()

  const fatal = (result) => {
    const code = result.json && result.json.code
    return code === 'NO_TORCH' || code === 'NO_WEIGHTS' || code === 'ENGINE' || code === 'BAD_MODEL'
  }

  /** Refuse a call when the engine cannot run, before touching any file. */
  const requireEngine = async () => {
    const state = await engine()
    if (!state.ok) {
      const tried = state.tried.map((entry) => '  - ' + entry.label + ': ' + entry.reason).join('\n')
      return {
        ok: false,
        text:
          'No Python on this machine can load torch, so nothing can be enlarged here.\n' + tried +
          '\n\nThis row installs nothing: it uses the Python and the torch the machine already has. ' +
          'Install torch (and basicsr) for a Python on PATH, or point `DSH_PYTHON` at the interpreter that has them.',
      }
    }
    return { ok: true, state }
  }

  const info = {
    name: 'upscale_info',
    description: [
      'What this machine can enlarge an image WITH: the Python that loads torch, whether CUDA is there, the GPU, and which Real-ESRGAN models are already on disk. Never writes a file and never touches the network.',
      'Call it first when an upscale fails or when you do not know whether weights need fetching. The answer names the interpreter (so a second Python on this machine is a candidate, not a mystery) and every model that is ready to run.',
      'The engine is the machine\'s own: this row bundles no binary, installs no wheel and starts no download on its own.',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: INFO_VIEW_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    async execute() {
      const state = await engine({ weightsDir })
      const lines = []
      if (!state.ok) {
        lines.push('No usable Python with torch was found. Tried:')
        for (const entry of state.tried) lines.push('  - ' + entry.label + ': ' + entry.reason)
        return { text: lines.join('\n'), view: { ok: false } }
      }
      const probe = state.probe
      lines.push('Engine: ' + engineLine(probe))
      lines.push('Python: ' + probe.executable)
      if (probe.pillow) lines.push('Pillow: ' + probe.pillow)
      lines.push('Weights folder: ' + probe.weights_dir)
      lines.push('')
      lines.push('Models:')
      for (const name of MODELS) {
        const ready = probe.models && probe.models[name]
        lines.push('  ' + (ready ? 'ready  ' : 'absent ') + name + ' â€” ' + MODELS_INFO[name].good)
      }
      const missing = MODELS.filter((name) => !(probe.models && probe.models[name]))
      if (missing.length > 0) {
        lines.push('')
        lines.push('`upscale_fetch_weights` downloads one of: ' + missing.join(', ') + '.')
      }
      return {
        text: lines.join('\n'),
        view: {
          ok: true,
          python: probe.executable,
          device: probe.cuda ? 'cuda' : 'cpu',
          model: DEFAULT_MODEL,
          models: MODELS.filter((name) => probe.models && probe.models[name]),
        },
      }
    },
  }

  const one = {
    name: 'upscale_image',
    description: [
      'Enlarge ONE image with a REAL super-resolution model (Real-ESRGAN) and write a NEW file. This is for a picture that is too small for where it is drawn â€” a 300px product photograph in a 300px card that a 2x screen has to stretch.',
      'The original is never touched: the output must be a different path, and an existing output is refused unless `overwrite: true`. Geometry is either `scale` (2-8) or `target_width` in pixels; the model runs at its own 4x and the result is reduced with LANCZOS, which is why a 300px source becomes a clean 600px file rather than a soft one.',
      '`model` matters: `realesr-general-x4v3` (default) is right for photographs, `realesr-animevideov3` for clean line art. **If the result must not look generated, use `RealESRNet_x4plus` with `sharpen: 0.45`**: same network without the adversarial term, so it invents no texture and leaves flat areas alone â€” slightly softer than a GAN, which the unsharp mask restores. A LOGO or a flat mark is the one case to think about first: these networks are trained on photographs, and a fine-stroke mark can smear while an opaque mark on white often gets only cleaner edges. Enlarge one, look at it, and only then do the rest. A file with an alpha channel is a different problem â€” this runner flattens alpha onto white, so a transparent logo loses its transparency. `quality` (40-100, default 86) is the JPEG/WebP encoder setting, not the model\'s.',
      'The answer names the model, the device (CUDA or CPU), the milliseconds and the bytes, so "it looks better" is a measurement and not a hope. A batch of images is `upscale_batch`, which takes a manifest and defaults to a dry run.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'output'],
      properties: {
        path: PATH_SCHEMA,
        output: {
          type: 'string',
          description:
            "Where the enlarged copy goes: a new path in the workspace, or an absolute path. Its folder must already exist. Refused if it equals the input.",
        },
        target_width: {
          type: 'number',
          description: 'Final width in pixels (1-16384). Wins over `scale` when both are given. A 300px card image drawn at 300 CSS px wants 600 here.',
        },
        scale: {
          type: 'number',
          description: 'Final scale factor, 1-8 (default 2 when no `target_width`). 2 is the retina case; 3 for a 3x phone.',
        },
        model: {
          type: 'string',
          enum: MODELS,
          description: 'The network to run. Default `realesr-general-x4v3` (photographs).',
        },
        quality: { type: 'number', description: 'Encoder quality for JPEG/WebP, 40-100. Default 86.' },
        format: {
          type: 'string',
          enum: ['jpg', 'png', 'webp'],
          description: 'Output format. Default: the output file\'s own extension, else jpg.',
        },
        tile: {
          type: 'number',
          description: 'Tile size in pixels; 0 (default) means automatic â€” tiled only when the input is larger than ~1.4 MP.',
        },
        sharpen: {
          type: 'number',
          description:
            'Unsharp mask applied after resizing, 0-1 (default 0). A non-adversarial model ' +
            '(`RealESRNet_x4plus`) comes out a little soft; 0.4-0.5 restores the micro-contrast of ' +
            'the original without the invented texture a GAN adds. On a GAN model leave it at 0.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing output. Off by default: this row writes new files.',
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Enlarge ' + (args && args.path ? String(args.path) : 'an image'), kind: 'other' }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: 'Enlarged ' + (result && result.meta && result.meta.output ? String(result.meta.output).split(/[\\/]/).pop() : ''),
      content: result && result.text ? result.text : '',
    }),
    async execute(args, exec) {
      const state = await requireEngine()
      if (!state.ok) return { text: state.text, view: { output: '' } }
      let source
      let target
      try {
        source = await resolveInput(deps.ctx, { session: sessionOf(exec), path: args.path })
      } catch (error) {
        return { text: refuse(error), view: { output: '' } }
      }
      try {
        target = await resolveOutput(deps.ctx, { session: sessionOf(exec), path: args.output, overwrite: args.overwrite === true })
      } catch (error) {
        return { text: refuse(error), view: { file: source.relative ?? source.file, output: '' } }
      }
      const plan = {
        input: source.file,
        output: target.file,
        model: isModel(args.model) ? args.model : DEFAULT_MODEL,
        targetWidth: Number.isFinite(args.target_width) ? Math.round(args.target_width) : 0,
        scale: Number.isFinite(args.scale) ? Math.round(args.scale) : 2,
        quality: Number.isFinite(args.quality) ? Math.round(args.quality) : 86,
        format: typeof args.format === 'string' ? args.format : null,
        tile: Number.isFinite(args.tile) ? Math.round(args.tile) : 0,
        sharpen: Number.isFinite(args.sharpen) ? Math.min(1, Math.max(0, args.sharpen)) : 0,
        overwrite: args.overwrite === true,
        weightsDir,
      }
      const started = Date.now()
      const result = await runRunner(state.state.command, imageArgs(plan), { timeout: IMAGE_TIMEOUT_MS })
      const view = { file: source.relative ?? source.file, output: target.relative ?? target.file, model: plan.model }
      const json = result.json
      if (!json || json.ok !== true) {
        log.warn('upscale_image failed: ' + (json ? json.code : 'no answer') + ' ' + (json ? json.message : result.stderr.slice(-400)))
        return { text: explain(result, plan), view }
      }
      view.device = json.device
      view.in_width = json.in_size?.[0]
      view.in_height = json.in_size?.[1]
      view.out_width = json.out_size?.[0]
      view.out_height = json.out_size?.[1]
      view.bytes = json.bytes
      view.ms = json.ms
      const lines = [
        'Enlarged ' + (source.relative ?? source.file) + ': ' + json.in_size[0] + 'Ã—' + json.in_size[1] +
          ' â†’ ' + json.out_size[0] + 'Ã—' + json.out_size[1] +
          ' with ' + json.model + ' on ' + json.device + ' (' + json.ms + ' ms, ' + formatBytes(json.bytes) + ').',
        'Wrote ' + (target.relative ?? target.file) + '. The original was not touched.',
      ]
      if (json.ms > 20000) lines.push('That was slow enough that a batch should run in the background.')
      if (Date.now() - started > IMAGE_TIMEOUT_MS) lines.push('The call took longer than the tool deadline; check the output file before trusting it.')
      return { text: lines.join('\n'), view }
    },
  }

  const batch = {
    name: 'upscale_batch',
    description: [
      'Enlarge MANY images from a JSON manifest. Each entry is `{ "input": â€¦, "output": â€¦, "target_width"?: â€¦, "scale"?: â€¦, "model"?: â€¦, "quality"?: â€¦, "format"?: â€¦ }`; anything an entry leaves out comes from the call defaults.',
      'A DRY RUN by default: it resolves every path, refuses the ones that would replace an original, and says what it would write, without writing. Pass `dry_run: false` to do the work. Existing outputs are SKIPPED, not replaced, unless `overwrite: true` â€” a batch that was interrupted can simply be run again.',
      'The summary is the point: how many were written, how many were skipped (and why), the bytes before and after, and the slowest file. That is what makes "upscaled the site\'s images" a claim with numbers behind it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['manifest'],
      properties: {
        manifest: {
          type: 'string',
          description: 'Path to a JSON file holding the array of entries â€” inside the workspace, or absolute.',
        },
        dry_run: { type: 'boolean', description: 'Report the plan without writing anything. Default true.' },
        model: { type: 'string', enum: MODELS, description: 'Default model for entries that name none.' },
        quality: { type: 'number', description: 'Default encoder quality, 40-100.' },
        overwrite: { type: 'boolean', description: 'Replace existing outputs instead of skipping them.' },
        limit: { type: 'number', description: 'Stop after this many entries; useful to try five before the five hundred.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    async execute(args, exec) {
      const session = sessionOf(exec)
      let manifestFile
      try {
        manifestFile = await resolveInput(deps.ctx, { session, path: args.manifest })
      } catch (error) {
        return { text: refuse(error), view: { output: args.manifest } }
      }
      let entries
      try {
        entries = JSON.parse(await readText(manifestFile.file))
      } catch (error) {
        return {
          text: 'The manifest is not readable JSON: ' + manifestFile.file + '\n' + String(error && error.message),
          view: { output: manifestFile.relative ?? manifestFile.file },
        }
      }
      const dryRun = args.dry_run !== false
      const plan = planBatch(entries, {
        model: isModel(args.model) ? args.model : DEFAULT_MODEL,
        quality: Number.isFinite(args.quality) ? Math.round(args.quality) : 86,
      })
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.round(args.limit) : plan.items.length
      const chosen = plan.items.slice(0, limit)
      const lines = []
      if (plan.errors.length > 0) {
        lines.push('The manifest has ' + plan.errors.length + ' problem(s); nothing was written:')
        for (const error of plan.errors.slice(0, 20)) lines.push('  - ' + error)
        if (plan.errors.length > 20) lines.push('  â€¦ and ' + (plan.errors.length - 20) + ' more.')
        return { text: lines.join('\n'), view: { output: manifestFile.relative ?? manifestFile.file } }
      }
      if (chosen.length === 0) {
        return { text: 'The manifest is an empty array: nothing to do.', view: { output: manifestFile.relative ?? manifestFile.file } }
      }
      if (dryRun) {
        lines.push('Dry run: ' + chosen.length + ' image(s) would be enlarged. Nothing was written.')
        lines.push('')
        for (const item of chosen) {
          lines.push('  ' + item.input + ' â†’ ' + item.output +
            ' (' + (item.targetWidth ? 'width ' + item.targetWidth + 'px' : 'Ã—' + item.scale) + ', ' + item.model + ')')
        }
        lines.push('')
        lines.push('Run again with `dry_run: false` to write them, or `limit: 5` to try five first.')
        return { text: lines.join('\n'), view: { output: manifestFile.relative ?? manifestFile.file, model: chosen[0].model } }
      }
      const state = await requireEngine()
      if (!state.ok) return { text: state.text, view: { output: manifestFile.relative ?? manifestFile.file } }

      const written = []
      const skipped = []
      const failed = []
      const started = Date.now()
      for (const item of chosen) {
        if (Date.now() - started > BATCH_TIMEOUT_MS) {
          failed.push({ input: item.input, reason: 'the batch deadline passed before this file' })
          continue
        }
        let source
        let target
        try {
          source = await resolveInput(deps.ctx, { session, path: item.input })
          target = await resolveOutput(deps.ctx, { session, path: item.output, overwrite: args.overwrite === true })
        } catch (error) {
          if (error instanceof UpscaleError && error.code === 'EXISTS') skipped.push({ input: item.input, reason: 'the output already exists' })
          else failed.push({ input: item.input, reason: error instanceof Error ? error.message : String(error) })
          continue
        }
        const result = await runRunner(state.state.command, imageArgs({ ...item, input: source.file, output: target.file, overwrite: args.overwrite === true, weightsDir }), { timeout: IMAGE_TIMEOUT_MS })
        const json = result.json
        if (!json || json.ok !== true) {
          failed.push({ input: item.input, reason: json ? json.code + ': ' + json.message : (result.stderr || '').trim().slice(-300) })
          if (json && fatal(result)) {
            lines.push('Stopped: ' + json.message)
            break
          }
          continue
        }
        written.push({ input: item.input, output: item.output, bytes: json.bytes, ms: json.ms, out: json.out_size })
      }
      const totalBytes = written.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
      const slowest = written.reduce((worst, item) => (item.ms > (worst?.ms ?? 0) ? item : worst), null)
      lines.push('Wrote ' + written.length + ' image(s)' + (skipped.length ? ', skipped ' + skipped.length : '') +
        (failed.length ? ', failed ' + failed.length : '') + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.')
      if (totalBytes > 0) lines.push('Total output: ' + formatBytes(totalBytes) + (slowest ? '; slowest ' + slowest.ms + ' ms (' + slowest.output + ')' : ''))
      if (skipped.length > 0) {
        lines.push('')
        lines.push('Skipped (nothing was replaced):')
        for (const item of skipped.slice(0, 15)) lines.push('  - ' + item.input + ': ' + item.reason)
      }
      if (failed.length > 0) {
        lines.push('')
        lines.push('Failed:')
        for (const item of failed.slice(0, 15)) lines.push('  - ' + item.input + ': ' + item.reason)
      }
      return {
        text: lines.join('\n'),
        view: {
          output: manifestFile.relative ?? manifestFile.file,
          model: chosen[0].model,
          bytes: totalBytes,
          ms: Date.now() - started,
        },
      }
    },
  }

  const fetchWeights = {
    name: 'upscale_fetch_weights',
    description: [
      'Download ONE Real-ESRGAN model into this plugin\'s own cache (`$DSH_HOME/dsh-image-upscale/weights/`), so `upscale_image` can run. This is the only call in this row that touches the network, it fetches from one pinned URL per model, and it changes nothing without `confirm` set to the model\'s exact name.',
      'Without `confirm` it answers with the size, the URL and what that model is good for â€” a person can then decide. The file is written to a temporary name and renamed into place, so an interrupted download never leaves a half model that a later run would load.',
      'Models: `realesr-general-x4v3` (4.7 MB) and `realesr-animevideov3` (2.4 MB) are small and fast; `RealESRGAN_x4plus` and `RealESRGAN_x2plus` (67 MB each) are the heavy weights for hard photography. Nothing here is bundled with the package, and no checksum is published upstream for these files: the answer states the URL, the bytes written and that no signature was verified.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model'],
      properties: {
        model: { type: 'string', enum: MODELS, description: 'Which model to fetch.' },
        confirm: {
          type: 'string',
          description: 'Repeat the model name to confirm the download. Without it, nothing is downloaded.',
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    async execute(args) {
      const model = args.model
      if (!isModel(model)) {
        return { text: 'Unknown model: ' + String(model) + '. Available: ' + MODELS.join(', ') + '.', view: { output: '' } }
      }
      const info = MODELS_INFO[model]
      const destination = weightsFile(model, weightsDir)
      if (args.confirm !== model) {
        return {
          text:
            model + ' is ' + formatBytes(info.bytes) + ' â€” good for ' + info.good + '.\n' +
            'It would be saved to ' + destination + '.\n' +
            'Source: ' + info.url + '\n\n' +
            'Nothing was downloaded. Call again with `confirm: "' + model + '"` to fetch it.',
          view: { output: destination, model },
        }
      }
      await mkdir(weightsDir, { recursive: true })
      const temporary = destination + '.part'
      try {
        const result = await download(info.url, temporary)
        await rename(temporary, destination)
        return {
          text:
            'Fetched ' + model + ': ' + formatBytes(result.bytes) + ' written to ' + destination + '.\n' +
            'No checksum is published upstream for this file, so its integrity is the transfer\'s, nothing more.',
          view: { output: destination, model, bytes: result.bytes },
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        return { text: 'The download failed: ' + String(error && error.message) + '\nNothing was installed.', view: { output: destination, model } }
      }
    },
  }

  return [info, one, batch, fetchWeights]
}

/** Read a text file with the encoding a JSON manifest is expected in. */
async function readText(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}

/** A refusal a reader can act on: the reason, then what to do about it. */
export function refuse(error) {
  if (error instanceof UpscaleError) {
    const hint = {
      NOT_FOUND: 'Check the path; a relative one is resolved inside this conversation\'s workspace.',
      OUTSIDE_WORKSPACE: 'Use a path inside the workspace, or an absolute path.',
      EXISTS: 'Name a different output, or pass `overwrite: true`.',
      NO_PARENT: 'Create the folder first; this row does not invent a directory tree.',
      NO_WORKSPACE: 'This call has no conversation workspace, so relative paths cannot be resolved.',
    }[error.code]
    return error.message + (hint ? '\n' + hint : '')
  }
  return String(error && error.message ? error.message : error)
}

/** Turn a failed runner answer into a sentence that says what to do next. */
export function explain(result, plan) {
  const json = result.json
  if (!json) {
    const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-6).join('\n')
    return 'The upscaler did not answer with JSON, so nothing can be trusted about ' + plan.output + '.\n' +
      (result.spawnError ? 'Spawn error: ' + result.spawnError + '\n' : '') +
      (tail ? 'It said:\n' + tail : 'It printed nothing.')
  }
  const hints = {
    NO_WEIGHTS: 'Run `upscale_fetch_weights` for ' + plan.model + ' first.',
    NO_TORCH: 'This row uses the machine\'s own Python: install torch for it, or point `DSH_PYTHON` at one that has it.',
    ENGINE: 'The model could not load. `upscale_info` says whether basicsr imports here.',
    EXISTS: 'Pass `overwrite: true` if replacing that file is really what you mean.',
    REFUSED: 'The output was the input; name a new file.',
  }
  const hint = hints[json.code]
  return json.code + ': ' + json.message + (hint ? '\n' + hint : '')
}

/** Exported for the package's check. */
export const __internals = { planBatch, formatBytes, engineLine, explain, refuse, download }

