/**
 * dsh-ollama — the five tools, and the prose that is the product.
 *
 * Every answer is written for the reader that has to decide what to do next, so
 * each one carries its CONDITIONS with its numbers:
 *
 *   - `ollama_status` never starts the daemon; it says what it tried, whether
 *     the CLI exists, and the command that starts one;
 *   - `ollama_run` reports the daemon's own counts and durations AND a single
 *     run's limits - a lone tok/s is labelled a lone tok/s;
 *   - `ollama_bench` is the only tool that will call a number a MEASUREMENT: 3+
 *     runs, a median with a spread, the model digest, the context length, and
 *     a cold run reported as a cold run (its cost is TTFT and wall, never
 *     tok/s, because `eval_duration` excludes the load);
 *   - `ollama_models` shows sizes and confirms a pull or a delete by repeating
 *     the tag, because a model is gigabytes and a delete costs a download;
 *   - `ollama_embed` names the dimension and computes cosine similarity rather
 *     than returning a wall of floats.
 */

import { OllamaError, messageOf } from './errors.js'
import { CAPS, validateBench, validateEmbed, validateModels, validateRun } from './validate.js'
import { requestJson, resolveHost, streamJsonLines } from './client.js'
import {
  cosineSimilarity,
  formatBytes,
  formatExpiry,
  formatMilliseconds,
  formatRate,
  formatShare,
  measure,
  summarize,
  vectorNorm,
} from './metrics.js'

/** The output shape every tool returns: prose for the model, a view for the card. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** A card for the transcript. */
function present(title) {
  return {
    presentCall: () => ({ card: 'generic', title: title, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: title, content: result && result.text ? result.text : '' }),
  }
}

/** A refusal: a sentence, and a view a caller can branch on. */
function refusal(code, message, extra) {
  return { text: message, view: { ok: false, code: code, ...(extra ?? {}) } }
}

/** The same refusal for any thrown failure. */
function failureOf(error) {
  if (error instanceof OllamaError) return refusal(error.code, error.message)
  return refusal('FAILED', error && error.message ? String(error.message) : String(error))
}

/** Pad a column, clipping it to its width. */
function cell(value, width) {
  const text = String(value === undefined || value === null ? '' : value)
  const cut = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '\u2026' : text
  return cut.padEnd(width)
}

/** A fixed-width table: the header line, then one line per row. */
function table(headers, rows) {
  if (rows.length === 0) return headers.join('  ')
  const widths = headers.map((header, index) => Math.min(44, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))))
  const line = (cells) => cells.map((value, index) => cell(value, widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** A digest as `ollama list` names it: the first 12 hex characters. */
function shortDigest(digest) {
  const text = String(digest ?? '').replace(/^sha256:/, '')
  return text === '' ? 'n/a' : text.slice(0, 12)
}

/** A number or 'n/a'. */
function numberOr(value, format) {
  return typeof value === 'number' && Number.isFinite(value) ? format(value) : 'n/a'
}

/** The model name of one `/api/tags` or `/api/ps` entry. */
function nameOf(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name
  if (typeof entry.model === 'string') return entry.model
  return ''
}

/** One `/api/tags` entry, flattened. */
function describeModel(entry) {
  const details = entry && typeof entry.details === 'object' && entry.details !== null ? entry.details : {}
  return {
    name: nameOf(entry),
    digest: typeof entry.digest === 'string' ? entry.digest : '',
    bytes: typeof entry.size === 'number' ? entry.size : null,
    modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : '',
    family: typeof details.family === 'string' ? details.family : '',
    families: Array.isArray(details.families) ? details.families : [],
    parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : '',
    quantization: typeof details.quantization_level === 'string' ? details.quantization_level : '',
    format: typeof details.format === 'string' ? details.format : '',
  }
}

/** The models on disk. Cached for two seconds so one answer is one request. */
async function tagsOf(deps, options = {}) {
  const cache = deps.cache ?? (deps.cache = { tags: null, tagsAt: 0, show: new Map() })
  const now = typeof deps.now === 'function' ? deps.now() : Date.now()
  if (options.fresh !== true && Array.isArray(cache.tags) && now - cache.tagsAt < 2000) return cache.tags
  const { data } = await requestJson(deps, '/api/tags', { timeoutMs: CAPS.readTimeoutMs })
  const models = Array.isArray(data.models) ? data.models : []
  cache.tags = models
  cache.tagsAt = now
  return models
}

/** The models loaded right now. */
async function psOf(deps) {
  const { data } = await requestJson(deps, '/api/ps', { timeoutMs: CAPS.readTimeoutMs })
  return Array.isArray(data.models) ? data.models : []
}

/** One model's metadata. Cached per boot: it does not change between two calls. */
async function showOf(deps, model) {
  const cache = deps.cache ?? (deps.cache = { tags: null, tagsAt: 0, show: new Map() })
  if (!cache.show) cache.show = new Map()
  if (cache.show.has(model)) return cache.show.get(model)
  const { data } = await requestJson(deps, '/api/show', { method: 'POST', body: { model }, timeoutMs: CAPS.readTimeoutMs, model })
  cache.show.set(model, data)
  return data
}

/**
 * The version `ollama --version` reports.
 *
 * The CLI writes its answer to stderr ("client version is 0.40.3"), so both
 * streams are read; no CLI at all is an empty string, not an error - the daemon
 * may be a container on the other end of a socket.
 */
async function cliVersion(deps) {
  if (typeof deps.runner !== 'function') return ''
  const result = await deps.runner(['ollama', '--version'], { timeoutMs: 4000 })
  if (result === null || result === undefined) return ''
  const text = String(result.stdout ?? '') + '\n' + String(result.stderr ?? '')
  const match = /client version is ([0-9][0-9A-Za-z.+-]*)/i.exec(text) ?? /ollama version (?:is )?([0-9][0-9A-Za-z.+-]*)/i.exec(text) ?? /([0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*)/.exec(text)
  return match ? match[1] : ''
}

/** The sentence a machine with no daemon gets. */
function downText(config, cli) {
  const lines = []
  lines.push('Ollama daemon: nothing answers at ' + config.origin + (config.raw !== '' && config.raw !== config.origin ? ' (from OLLAMA_HOST=' + config.raw + ')' : '') + '.')
  lines.push('CLI: ' + (cli === '' ? 'no `ollama` on PATH.' : 'ollama ' + cli + ' on PATH (the client works; the server is not running).'))
  if (config.remote) lines.push('Host: ' + config.host + ':' + config.port + ' is not this machine, and ' + 'DSH_OLLAMA_ALLOW_REMOTE=1' + ' allowed it.')
  lines.push('')
  lines.push('Nothing was started. Start the daemon yourself:')
  lines.push('  ollama serve           # a terminal; the daemon stays in the foreground')
  lines.push('  or open the Ollama desktop app, which runs it in the background')
  lines.push('')
  lines.push('Then call `ollama_status` again. Models already on disk stay there; `ollama_models` lists them once the daemon answers.')
  return lines.join('\n')
}

/** The sentence for a model that is not pulled, with the tags that are. */
async function noModelText(deps, model) {
  let models = []
  try {
    models = await tagsOf(deps, { fresh: true })
  } catch (error) {
    // A daemon that does not answer cannot say which tags exist. Saying "no
    // models are on disk" would blame the model store for a stopped service.
    return 'No model "' + model + '" was reachable, and the daemon did not answer when asked what is on disk (' + messageOf(error) + '). Start it with `ollama serve`, call `ollama_status`, then pull with `ollama pull ' + model + '` if the tag is still missing.'
  }
  if (models.length === 0) {
    return 'No model "' + model + '" on this daemon, and no models are on disk yet. Pull one first: `ollama pull ' + model + '` downloads gigabytes and is not something this row starts on its own.'
  }
  const names = models.map(nameOf).filter((name) => name !== '')
  const shown = names.slice(0, 20).join(', ')
  return (
    'No model "' +
    model +
    '" on this daemon. On disk: ' +
    shown +
    (names.length > 20 ? ', \u2026 (' + names.length + ' total)' : '') +
    '. Pull it with `ollama pull ' +
    model +
    '` (gigabytes), or use one of the names above. `ollama_models` shows their sizes before you decide.'
  )
}

/** The options this call actually sent, as one line of conditions. */
function conditionLine(spec, extra = {}) {
  const parts = []
  const options = spec.options ?? {}
  if (Object.keys(options).length === 0) parts.push('options: none sent (the daemon\'s own defaults)')
  else parts.push(Object.entries(options).map(([key, value]) => key + ' ' + (Array.isArray(value) ? JSON.stringify(value) : String(value))).join(' \u00b7 '))
  if (spec.keepAlive !== undefined) parts.push('keep_alive ' + String(spec.keepAlive))
  if (extra.context !== undefined && extra.context !== null) parts.push('num_ctx ' + extra.context)
  parts.push(extra.timeoutSeconds !== undefined ? 'timeout ' + extra.timeoutSeconds + ' s' : 'timeout ' + Math.round((spec.timeoutMs ?? 0) / 1000) + ' s')
  return parts.join(' \u00b7 ')
}

/** How one response object carries its text: chat and generate differ. */
function contentOf(item, chat) {
  if (item === null || typeof item !== 'object') return ''
  if (chat) {
    const message = item.message
    if (message !== null && typeof message === 'object' && typeof message.content === 'string') return message.content
    return ''
  }
  return typeof item.response === 'string' ? item.response : ''
}

/**
 * ONE bounded inference, streamed so the first token can be timed.
 *
 * @param deps - the row's dependencies.
 * @param spec - a `validateRun` result.
 * @param options - `{ signal }` from the agent.
 * @returns `{ text, measured, final, chunks }`.
 */
async function infer(deps, spec, options = {}) {
  const body = { model: spec.model, stream: true }
  if (spec.chat) body.messages = spec.messages
  else {
    body.prompt = spec.prompt
    if (spec.system !== '') body.system = spec.system
  }
  if (Object.keys(spec.options).length > 0) body.options = spec.options
  if (spec.keepAlive !== undefined) body.keep_alive = spec.keepAlive
  if (spec.format !== undefined) body.format = spec.format
  if (spec.think !== undefined) body.think = spec.think

  const started = deps.now()
  let text = ''
  let firstContentAt = null
  let final = null
  let chunks = 0
  const streamed = await streamJsonLines(deps, spec.chat ? '/api/chat' : '/api/generate', body, {
    timeoutMs: spec.timeoutMs,
    signal: options.signal,
    model: spec.model,
    route: spec.chat ? '/api/chat' : '/api/generate',
    onItem: (item) => {
      chunks += 1
      if (item !== null && typeof item === 'object' && typeof item.error === 'string' && item.error !== '') {
        throw new OllamaError('DAEMON_ERROR', 'The daemon interrupted the generation: ' + item.error, { model: spec.model })
      }
      const piece = contentOf(item, spec.chat)
      if (piece !== '') {
        if (firstContentAt === null) firstContentAt = deps.now()
        text += piece
      }
      if (item !== null && typeof item === 'object' && item.done === true) final = item
    },
  })
  const wallMs = deps.now() - started
  if (final === null) {
    if (text === '' && streamed.items.length === 0) {
      throw new OllamaError('BAD_STREAM', 'The daemon closed the stream without sending anything. Check `ollama_status`, then try the call again.', { model: spec.model })
    }
    final = streamed.items[streamed.items.length - 1] ?? {}
  }
  return { text, measured: measure(final, { wallMs, ttftMs: firstContentAt === null ? null : firstContentAt - started }), final, chunks }
}

/**
 * The answer `ollama_run` prints: the text, then the numbers, then the limits
 * of a single run.
 *
 * The digest is passed in rather than guessed: `/api/generate` echoes the model
 * TAG, not its digest, and a number without the digest is a number about "a
 * model with that name", which is not the same claim.
 */
function runAnswer(spec, result, digest, config) {
  const measured = result.measured
  const lines = []
  const headline = []
  headline.push('MODEL ' + spec.model + (digest === '' ? '' : ' \u00b7 digest ' + shortDigest(digest)))
  headline.push(numberOr(measured.evalCount, (value) => String(value)) + ' tokens generated in ' + numberOr(measured.evalMs, (value) => formatMilliseconds(value)) + ' \u00b7 ' + formatRate(measured.evalTokensPerSecond))
  headline.push('prompt ' + numberOr(measured.promptEvalCount, (value) => String(value)) + ' tokens \u00b7 ' + numberOr(measured.promptEvalMs, (value) => formatMilliseconds(value)) + ' \u00b7 ' + formatRate(measured.promptTokensPerSecond))
  headline.push(
    'load ' +
      numberOr(measured.loadMs, (value) => formatMilliseconds(value)) +
      ' \u00b7 first token ' +
      (measured.ttftMeasuredMs !== null ? formatMilliseconds(measured.ttftMeasuredMs) + ' (measured)' : 'not measured') +
      ' \u00b7 total ' +
      numberOr(measured.totalMs, (value) => formatMilliseconds(value)) +
      ' (daemon) \u00b7 ' +
      numberOr(measured.wallMs, (value) => formatMilliseconds(value)) +
      ' (wall)',
  )
  if (measured.doneReason !== '') headline.push('stop reason: ' + measured.doneReason)
  lines.push(headline.join('\n'))
  lines.push('')
  const body = result.text === '' ? '(the model generated no text)' : result.text
  const capped = body.length > 12_000 ? body.slice(0, 12_000) + '\n\u2026 (cut at 12 000 characters; the view carries the counts)' : body
  lines.push(capped)
  lines.push('')
  lines.push('Conditions: ' + conditionLine(spec) + '.')
  if (measured.doneReason === 'length') {
    const limit = spec.options.num_predict
    lines.push('')
    lines.push('The answer hit num_predict (' + limit + ') and was cut at the model\'s stop, not at its own end. Raise `options.num_predict` (ceiling ' + CAPS.maxNumPredict + ') for a longer answer.')
  }
  lines.push('A single run is a single run: `ollama_bench` makes 3 or more and reports a median with its spread.')
  if (config.remote) lines.push('Host: ' + config.origin + ' is not this machine (allowed by DSH_OLLAMA_ALLOW_REMOTE=1), so these timings include the network.')
  return lines.join('\n')
}

/** The view `ollama_run` hands the card, and the check asserts. */
function runView(spec, result, digest) {
  return {
    ok: true,
    model: spec.model,
    digest: digest,
    text: result.text,
    measured: result.measured,
    conditions: { options: spec.options, keepAlive: spec.keepAlive ?? null, timeoutSeconds: Math.round(spec.timeoutMs / 1000) },
  }
}

/**
 * Ollama's `options` map, declared once and used by BOTH generation tools.
 *
 * It is CLOSED (`additionalProperties: false`) for the reason the validator
 * enforces it: the daemon ignores an option it does not know, so `temprature`
 * would not fail - it would take the numbers at a setting nobody chose.
 */
const OPTIONS_SCHEMA = {
  type: 'object',
  description: 'Ollama\'s options map, closed to the names here. A typo would be silently ignored by the daemon and change what the numbers measured.',
  additionalProperties: false,
  properties: {
    num_predict: { type: 'number', description: 'Maximum tokens to generate: 1-8192. Default 512 for a run, 128 for a benchmark (Ollama\'s own default is unbounded).' },
    temperature: { type: 'number', description: '0-2. 0 for a reproducible measurement.' },
    seed: { type: 'number', description: 'Integer 0-2147483647; fixed with temperature 0 for a reproducible run.' },
    num_ctx: { type: 'number', description: 'Context window in tokens: 128-1048576. Changing it changes memory use and speed.' },
    top_k: { type: 'number', description: '0-1000.' },
    top_p: { type: 'number', description: '0-1.' },
    min_p: { type: 'number', description: '0-1.' },
    repeat_penalty: { type: 'number', description: '0-10.' },
    repeat_last_n: { type: 'number', description: '-1 to 8192.' },
    presence_penalty: { type: 'number', description: '-2 to 2.' },
    frequency_penalty: { type: 'number', description: '-2 to 2.' },
    stop: { type: 'array', items: { type: 'string' }, description: 'Up to 8 stop sequences.' },
    num_gpu: { type: 'number', description: 'Layers to offload: 0-999. 0 keeps it on the CPU.' },
    num_thread: { type: 'number', description: 'CPU threads: 1-256.' },
    use_mmap: { type: 'boolean', description: 'Memory-map the weights.' },
    use_mlock: { type: 'boolean', description: 'Lock the weights in RAM.' },
    mirostat: { type: 'number', description: '0 (off), 1, or 2.' },
  },
}

/** Build the tools. @param deps - `{ env, fetch, now, runner, cache, log }`. */
export function buildTools(deps) {
  /** `ollama_status`: what is here, whether it answers, and what it holds. */
  const status = {
    name: 'ollama_status',
    description: [
      'Report whether this machine\'s Ollama daemon is answering, which version it is, every model on disk (family, parameter size, quantization, bytes, digest), and which models are loaded right now (processor split, context length, when they expire) - plus the CLI version when `ollama` is on PATH.',
      'Call this FIRST, before any other ollama_* tool. It is the only tool that treats a daemon that is not running as an ANSWER rather than a failure: it names the address it tried and the command that starts one (`ollama serve`, or the desktop app).',
      'It never starts the daemon, pulls a model or changes anything. Read-only.',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    ...present('Ollama status'),
    async execute() {
      try {
        const config = resolveHost(deps.env)
        const cli = await cliVersion(deps)
        const base = { host: { origin: config.origin, host: config.host, port: config.port, remote: config.remote, optIn: config.optIn }, cli }
        if (!config.allowed) return { text: config.reason, view: { ok: false, code: config.code, ...base } }
        let version
        try {
          const answer = await requestJson(deps, '/api/version', { timeoutMs: CAPS.statusTimeoutMs })
          version = typeof answer.data.version === 'string' ? answer.data.version : ''
        } catch (error) {
          if (error instanceof OllamaError && (error.code === 'DAEMON_DOWN' || error.code === 'TIMEOUT')) {
            return { text: downText(config, cli), view: { ok: false, code: 'DAEMON_DOWN', ...base } }
          }
          throw error
        }
        const errors = {}
        let rawModels = []
        try {
          rawModels = await tagsOf(deps, { fresh: true })
        } catch (error) {
          errors.tags = messageOf(error)
        }
        let rawLoaded = []
        try {
          rawLoaded = await psOf(deps)
        } catch (error) {
          errors.ps = messageOf(error)
        }
        const models = rawModels.map(describeModel)
        const totalBytes = models.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)
        const loaded = rawLoaded.map((entry) => {
          const details = entry && typeof entry.details === 'object' && entry.details !== null ? entry.details : {}
          const size = typeof entry.size === 'number' ? entry.size : null
          const vram = typeof entry.size_vram === 'number' ? entry.size_vram : null
          return {
            name: nameOf(entry),
            digest: typeof entry.digest === 'string' ? entry.digest : '',
            size,
            sizeVram: vram,
            contextLength: typeof entry.context_length === 'number' ? entry.context_length : null,
            expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : '',
            family: typeof details.family === 'string' ? details.family : '',
            parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : '',
            quantization: typeof details.quantization_level === 'string' ? details.quantization_level : '',
            processor: vram === null || size === null || size === 0 ? '' : vram === 0 ? '100% CPU' : formatShare(vram, size) + ' GPU',
          }
        })

        const lines = []
        lines.push('Ollama ' + (version === '' ? '(version not reported)' : version) + (cli === '' ? ' \u00b7 CLI not on PATH' : ' \u00b7 CLI ' + cli) + ' at ' + config.origin + (config.remote ? ' (not this machine; allowed by DSH_OLLAMA_ALLOW_REMOTE=1)' : ''))
        lines.push('Models on disk: ' + models.length + (models.length > 0 ? ' (' + formatBytes(totalBytes) + ')' : ''))
        if (models.length > 0) {
          lines.push(table(['NAME', 'PARAM', 'QUANT', 'SIZE', 'DIGEST'], models.map((entry) => [entry.name, entry.parameterSize, entry.quantization, formatBytes(entry.bytes), shortDigest(entry.digest)])))
        } else {
          lines.push('')
          lines.push('No models yet. Pull one with `ollama pull <model>` (gigabytes): `ollama_models` action "pull" shows what it would fetch first.')
        }
        lines.push('')
        if (loaded.length === 0) {
          lines.push('Loaded now: none. The first call that names a model loads it (and pays the load time once).')
        } else {
          lines.push('Loaded now: ' + loaded.length)
          lines.push(table(['NAME', 'CONTEXT', 'SIZE', 'PROCESSOR', 'EXPIRES'], loaded.map((entry) => [entry.name, entry.contextLength === null ? 'n/a' : String(entry.contextLength), formatBytes(entry.size), entry.processor || 'n/a', formatExpiry(entry.expiresAt, Date.now())])))
        }
        for (const [what, message] of Object.entries(errors)) lines.push('', 'Could not read ' + what + ': ' + message)
        lines.push('')
        lines.push('Next: `ollama_run` for one inference with its numbers, `ollama_bench` for a measurement (3+ runs, median and spread), `ollama_models` to show or pull one, `ollama_embed` for vectors.')
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            host: base.host,
            daemon: { up: true, version },
            cli,
            counts: { models: models.length, bytes: totalBytes, loaded: loaded.length },
            models,
            loaded,
            errors,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `ollama_run`: ONE bounded inference, with the numbers. */
  const run = {
    name: 'ollama_run',
    description: [
      'Run ONE bounded inference against a model that is already pulled: either `prompt` (a single string, `/api/generate`) or `messages` (a chat array, `/api/chat`), plus `options`, `format`, `keep_alive` and a timeout.',
      'It returns the text AND the measurement: prompt and eval token counts, tokens/second from `eval_count / eval_duration`, the load time, time-to-first-token as actually observed while streaming, and both the daemon\'s total and the wall clock. `num_predict` is set for you (512) because Ollama\'s default would generate until the context filled; the ceiling is 8192.',
      'A refused call names the fix: a model that is not pulled lists the tags that ARE on disk and the exact `ollama pull`; a daemon that is not running names `ollama serve`; a non-loopback OLLAMA_HOST names the opt-in variable.',
      'ONE run is not a measurement. For a number worth quoting, use `ollama_bench`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model'],
      properties: {
        model: { type: 'string', description: 'A model tag already on disk, e.g. qwen2.5:7b (as `ollama_status` prints it).' },
        prompt: { type: 'string', description: 'One prompt, sent to /api/generate. Exactly one of prompt / messages.' },
        messages: {
          type: 'array',
          description: 'A chat array for /api/chat: [{ role: "system"|"user"|"assistant"|"tool", content, images?, tool_calls?, tool_name? }].',
          items: { type: 'object' },
        },
        system: { type: 'string', description: 'A system prompt for the `prompt` form. In a `messages` call, use a system message instead.' },
        options: OPTIONS_SCHEMA,
        format: { description: 'Structured output: the string "json", or a JSON Schema object the answer must satisfy.' },
        keep_alive: { description: 'How long the weights stay loaded after this call: a duration ("5m", "30s"), 0 (unload when done), or -1 (forever).' },
        think: { type: 'boolean', description: 'Ask a thinking-capable model to reason before answering (models that do not support it ignore the flag).' },
        timeoutSeconds: { type: 'number', description: 'Deadline for the whole call: 10-900 s. Default 300.' },
      },
    },
    output: OUTPUT,
    ...present('Ollama run'),
    async execute(args, exec) {
      try {
        const spec = validateRun(args)
        const result = await infer(deps, spec, { signal: exec?.signal })
        const config = resolveHost(deps.env)
        let digest = ''
        try {
          const models = await tagsOf(deps)
          digest = models.map(describeModel).find((entry) => entry.name === spec.model)?.digest ?? ''
        } catch (error) {
          /* the run succeeded; only the digest lookup failed */
        }
        return { text: runAnswer(spec, result, digest, config), view: runView(spec, result, digest) }
      } catch (error) {
        if (error instanceof OllamaError && error.code === 'NO_MODEL') return refusal('NO_MODEL', await noModelText(deps, String(args.model ?? '')), { model: args.model })
        return failureOf(error)
      }
    },
  }

  /** `ollama_bench`: the measurement, not the anecdote. */
  const bench = {
    name: 'ollama_bench',
    description: [
      'Measure ONE model (or A/B two or three) with N repetitions of the same call, and report per-run numbers plus a median, p95 and spread for tokens/second, time-to-first-token and wall clock.',
      'It is the only tool here that calls a number a MEASUREMENT: `runs` must be at least 3 (a single run is refused by name), temperature defaults to 0 with a fixed seed, `num_predict` defaults to 128, and every answer carries the model digest, the context length and the run count.',
      'By default the FIRST counted run is cold: the model is unloaded with `keep_alive: 0` before the runs begin, so run 1 pays the load. Its cost shows in TTFT and wall - NEVER in tok/s, because `eval_duration` covers generation only. `cold: false` measures a warm model only.',
      '`contexts` sweeps num_ctx (e.g. [2048, 8192]) - one variable at a time, which is the point. `warmup` makes unmeasured calls first.',
      'Bounded: 3-50 runs, 1-3 models, 0-6 contexts, at most 150 measured calls, and a timeout you must state.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        model: { type: 'string', description: 'One model tag. Send this OR `models`, not both.' },
        models: { type: 'array', items: { type: 'string' }, description: 'An A/B array of 1-3 distinct model tags.' },
        prompt: { type: 'string', description: 'The prompt every run sends. Keep it identical across runs: that is the experiment.' },
        runs: { type: 'number', description: 'Measured runs: 3-50. Default 5.' },
        warmup: { type: 'number', description: 'Unmeasured calls before the runs: 0-5. Default 0.' },
        cold: { type: 'boolean', description: 'Unload the model before the runs so run 1 is cold. Default true.' },
        contexts: { type: 'array', items: { type: 'number' }, description: 'A num_ctx sweep: up to 6 context lengths, e.g. [2048, 8192]. Default: the model\'s own.' },
        options: OPTIONS_SCHEMA,
        format: { description: 'Structured output for every run: "json" or a JSON Schema object.' },
        think: { type: 'boolean', description: 'Pass `think` to each run.' },
        timeoutSeconds: { type: 'number', description: 'Deadline PER CALL: 30-600 s. Default 300.' },
      },
    },
    output: OUTPUT,
    ...present('Ollama bench'),
    async execute(args, exec) {
      try {
        const plan = validateBench(args)
        const config = resolveHost(deps.env)
        const models = await tagsOf(deps, { fresh: true }).catch(() => [])
        const digestFor = (tag) => models.map(describeModel).find((entry) => entry.name === tag)?.digest ?? ''
        const groups = []
        for (const model of plan.models) {
          const contexts = plan.contexts.length > 0 ? plan.contexts : [null]
          for (const context of contexts) {
            const runs = []
            if (plan.warmup > 0) {
              for (let index = 0; index < plan.warmup; index += 1) {
                await infer(deps, { ...runSpec(plan, model, context), options: optionsWithContext(plan.options, context) }, { signal: exec?.signal })
              }
            }
            let unloaded = false
            if (plan.cold) {
              try {
                await requestJson(deps, '/api/generate', {
                  method: 'POST',
                  body: { model, keep_alive: 0, stream: false },
                  timeoutMs: CAPS.readTimeoutMs,
                  model,
                })
                unloaded = true
              } catch (error) {
                /* a model that was not loaded cannot be unloaded; run 1 is cold anyway */
              }
            }
            for (let index = 0; index < plan.runs; index += 1) {
              const spec = { ...runSpec(plan, model, context), options: optionsWithContext(plan.options, context) }
              const result = await infer(deps, spec, { signal: exec?.signal })
              runs.push({ index: index + 1, measured: result.measured })
            }
            groups.push({ model, digest: digestFor(model), context, runs, unloaded })
          }
        }
        return { text: benchText(plan, groups, config), view: benchView(plan, groups, config) }
      } catch (error) {
        if (error instanceof OllamaError && error.code === 'NO_MODEL') {
          const named = String(args.model ?? (Array.isArray(args.models) ? args.models[0] : '') ?? '')
          return refusal('NO_MODEL', await noModelText(deps, named), { model: named })
        }
        return failureOf(error)
      }
    },
  }

  /** `ollama_models`: show one, list, and the two writes behind a confirmation. */
  const models = {
    name: 'ollama_models',
    description: [
      'Inspect and manage the models on disk: `list` (every tag with its family, parameter size, quantization and bytes), `show` (one model\'s parameters, template, license, capabilities and architecture facts), `pull` (download one) and `delete` (remove one, freeing its bytes).',
      '`pull` and `delete` are WRITES, and both require `confirm` set to the exact tag. Without it the tool answers with what it WOULD do - the size on disk or the size to download, and the exact command - and changes nothing. Models are gigabytes: a delete costs a download to undo.',
      'Pulling a tag that is already on disk re-checks for a newer layer; it is not a no-op. Nothing here pulls a model implicitly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'pull', 'delete'], description: 'What to do. Default list.' },
        model: { type: 'string', description: 'The model tag: required for show, pull and delete.' },
        confirm: { type: 'string', description: 'Repeat the model tag to confirm a pull or a delete. Without it, the tool reports what it would do and does nothing.' },
        timeoutSeconds: { type: 'number', description: 'Deadline for a whole pull: 60-3600 s. Default 1800. Ignored by the other actions.' },
      },
    },
    output: OUTPUT,
    ...present('Ollama models'),
    async execute(args) {
      try {
        const spec = validateModels(args)
        if (spec.action === 'list') {
          const raw = await tagsOf(deps, { fresh: true })
          const models = raw.map(describeModel)
          if (models.length === 0) {
            return { text: 'No models on disk. `ollama_models` action "pull" with a tag shows what it would download; nothing is pulled without `confirm`.', view: { ok: true, models: [], count: 0, bytes: 0 } }
          }
          const bytes = models.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)
          const rows = models.map((entry) => [entry.name, entry.family, entry.parameterSize, entry.quantization, formatBytes(entry.bytes), shortDigest(entry.digest)])
          return {
            text: table(['NAME', 'FAMILY', 'PARAM', 'QUANT', 'SIZE', 'DIGEST'], rows) + '\n\n' + models.length + ' model(s), ' + formatBytes(bytes) + ' on disk.',
            view: { ok: true, models, count: models.length, bytes },
          }
        }
        if (spec.action === 'show') {
          const data = await showOf(deps, spec.model)
          return { text: showText(spec.model, data), view: { ok: true, model: spec.model, details: data.details ?? {}, capabilities: data.capabilities ?? [] } }
        }
        if (spec.action === 'pull') {
          if (spec.confirm !== spec.model) {
            let present = null
            let checked = true
            try {
              present = (await tagsOf(deps, { fresh: true })).map(describeModel).find((entry) => entry.name === spec.model) ?? null
            } catch (error) {
              // "not on disk yet" is a claim about the store; a silent failure
              // to read the store cannot support it.
              checked = false
            }
            const state = !checked ? ' (could not check: the daemon did not answer)' : present === null ? ' (not on disk yet)' : ' (already on disk, ' + formatBytes(present.bytes) + ')'
            const lines = ['PULL ' + spec.model + state]
            lines.push('')
            lines.push('Nothing was downloaded. A pull writes gigabytes to disk and this row does not start one without an explicit confirmation.')
            lines.push('To pull it: call `ollama_models` again with action "pull", model "' + spec.model + '", confirm "' + spec.model + '".')
            lines.push('In a terminal the same thing is: ollama pull ' + spec.model)
            return refusal('CONFIRM_REQUIRED', lines.join('\n'), { model: spec.model, present: present !== null, bytes: present === null ? null : present.bytes })
          }
          const started = deps.now()
          const streamed = await streamJsonLines(deps, '/api/pull', { model: spec.model, stream: true }, {
            timeoutMs: spec.timeoutSeconds * 1000,
            model: spec.model,
            route: '/api/pull',
          })
          const elapsedMs = deps.now() - started
          const summary = pullSummary(streamed.items)
          const lines = []
          lines.push('PULLED ' + spec.model + ' in ' + formatMilliseconds(elapsedMs, 1) + '.')
          if (summary.layers > 0) lines.push('Layers: ' + summary.layers + (summary.total > 0 ? ' \u00b7 ' + formatBytes(summary.completed) + ' of ' + formatBytes(summary.total) : '') + '.')
          lines.push('Final status: ' + (summary.status === '' ? '(none reported)' : summary.status))
          lines.push('')
          lines.push('Next: `ollama_run` with model "' + spec.model + '" sends one inference; `ollama_bench` measures it over 3+ runs.')
          return { text: lines.join('\n'), view: { ok: true, model: spec.model, elapsedMs, bytes: summary.total, layers: summary.layers, status: summary.status } }
        }
        // delete
        if (spec.confirm !== spec.model) {
          let present = null
          let checked = true
          try {
            present = (await tagsOf(deps, { fresh: true })).map(describeModel).find((entry) => entry.name === spec.model) ?? null
          } catch (error) {
            checked = false
          }
          const state = !checked ? ' (could not check: the daemon did not answer)' : present === null ? ' (not on disk)' : ' (' + formatBytes(present.bytes) + ' on disk)'
          const lines = ['DELETE ' + spec.model + state]
          lines.push('')
          lines.push('Nothing was removed. The bytes are freed immediately and the only way back is a pull.')
          lines.push('To delete it: call `ollama_models` again with action "delete", model "' + spec.model + '", confirm "' + spec.model + '".')
          lines.push('In a terminal the same thing is: ollama rm ' + spec.model)
          return refusal('CONFIRM_REQUIRED', lines.join('\n'), { model: spec.model, present: present !== null, bytes: present === null ? null : present.bytes })
        }
        await requestJson(deps, '/api/delete', { method: 'DELETE', body: { model: spec.model }, timeoutMs: CAPS.readTimeoutMs, model: spec.model })
        return {
          text: 'Deleted ' + spec.model + '. Its bytes are free; getting it back is `ollama pull ' + spec.model + '`.',
          view: { ok: true, model: spec.model, deleted: true },
        }
      } catch (error) {
        if (error instanceof OllamaError && error.code === 'NO_MODEL') return refusal('NO_MODEL', await noModelText(deps, String(args.model ?? '')), { model: args.model })
        return failureOf(error)
      }
    },
  }

  /** `ollama_embed`: vectors, their dimension, and comparability. */
  const embed = {
    name: 'ollama_embed',
    description: [
      'Turn one or more strings into embeddings with an embedding model (`/api/embed`), and report the dimension and the vectors\' norms. With exactly two inputs it also reports their cosine similarity (1.0 identical, 0 orthogonal, -1 opposite), which is the question a reader actually has.',
      'The model must be an EMBEDDING model: this tool checks the model\'s advertised capabilities and refuses a completion model by name, pointing at `nomic-embed-text`. An older daemon with no `/api/embed` is handled through `/api/embeddings` instead.',
      'Vectors are large: the answer previews the first few dimensions and reports the count and dimension; the view carries nothing you cannot recompute.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'input'],
      properties: {
        model: { type: 'string', description: 'An embedding model tag, e.g. nomic-embed-text.' },
        input: { description: 'One string, or an array of 1-64 strings to embed.' },
        similarity: { type: 'boolean', description: 'Compute cosine similarity between the first two inputs. Default true when there are exactly two.' },
        keep_alive: { description: 'How long the embeddings model stays loaded: a duration, 0, or -1.' },
        timeoutSeconds: { type: 'number', description: 'Deadline: 5-600 s. Default 60.' },
      },
    },
    output: OUTPUT,
    ...present('Ollama embed'),
    async execute(args) {
      try {
        const spec = validateEmbed(args)
        const show = await showOf(deps, spec.model)
        const capabilities = Array.isArray(show.capabilities) ? show.capabilities.map(String) : []
        if (capabilities.length > 0 && !capabilities.includes('embedding')) {
          return refusal(
            'NOT_EMBEDDING',
            '"' + spec.model + '" is not an embedding model: it advertises ' + capabilities.join(', ') + '. An embedding model is different weights - `ollama pull nomic-embed-text` (about 274 MB) is the usual one, then call this with that tag.',
            { model: spec.model, capabilities },
          )
        }
        const body = { model: spec.model, input: spec.inputs }
        if (spec.keepAlive !== undefined) body.keep_alive = spec.keepAlive
        let vectors
        let route = '/api/embed'
        try {
          const answer = await requestJson(deps, '/api/embed', { method: 'POST', body, timeoutMs: spec.timeoutMs, model: spec.model })
          const embeddings = Array.isArray(answer.data.embeddings) ? answer.data.embeddings : null
          if (embeddings === null) throw new OllamaError('BAD_RESPONSE', 'The daemon answered /api/embed without an `embeddings` array.', { model: spec.model })
          vectors = embeddings
        } catch (error) {
          if (!(error instanceof OllamaError) || error.code !== 'NOT_FOUND') throw error
          // An older daemon: one prompt per call, one vector per answer.
          route = '/api/embeddings'
          vectors = []
          for (const prompt of spec.inputs) {
            const answer = await requestJson(deps, '/api/embeddings', { method: 'POST', body: { model: spec.model, prompt }, timeoutMs: spec.timeoutMs, model: spec.model })
            if (!Array.isArray(answer.data.embedding)) throw new OllamaError('BAD_RESPONSE', 'The daemon answered /api/embeddings without an `embedding` array.', { model: spec.model })
            vectors.push(answer.data.embedding)
          }
        }
        if (!Array.isArray(vectors) || vectors.length !== spec.inputs.length) {
          throw new OllamaError('BAD_RESPONSE', 'The daemon returned ' + (Array.isArray(vectors) ? vectors.length : 'no') + ' vector(s) for ' + spec.inputs.length + ' input(s).', { model: spec.model })
        }
        const dimension = Array.isArray(vectors[0]) ? vectors[0].length : 0
        const similarity = spec.similarity && vectors.length >= 2 ? cosineSimilarity(vectors[0], vectors[1]) : null
        const digest = (await tagsOf(deps).catch(() => [])).map(describeModel).find((entry) => entry.name === spec.model)?.digest ?? ''
        const lines = []
        lines.push('EMBED ' + spec.model + (digest === '' ? '' : ' \u00b7 digest ' + shortDigest(digest)) + ' \u00b7 ' + vectors.length + ' input(s) \u00b7 dimension ' + dimension + (route === '/api/embeddings' ? ' \u00b7 via /api/embeddings (older daemon)' : ''))
        for (const [index, vector] of vectors.entries()) {
          const norm = vectorNorm(vector)
          const preview = vector.slice(0, 8).map((value) => (typeof value === 'number' ? value.toFixed(4) : String(value))).join(', ')
          const label = (index + 1) + '. "' + (spec.inputs[index].length > 60 ? spec.inputs[index].slice(0, 60) + '\u2026' : spec.inputs[index]) + '"'
          lines.push(label + ' \u00b7 norm ' + (norm === null ? 'n/a' : norm.toFixed(4)))
          lines.push('   [' + preview + (vector.length > 8 ? ', \u2026 (' + vector.length + ' of ' + dimension + ')' : '') + ']')
        }
        if (similarity !== null) {
          lines.push('')
          lines.push('cosine(1, 2) = ' + similarity.toFixed(4) + '   (1.0 identical direction, 0 orthogonal, -1 opposite)')
        }
        lines.push('')
        lines.push('Conditions: ' + (spec.inputs.length === 1 ? '1 input' : spec.inputs.length + ' inputs') + ' \u00b7 ' + (spec.keepAlive === undefined ? 'keep_alive: daemon default' : 'keep_alive ' + String(spec.keepAlive)) + ' \u00b7 timeout ' + Math.round(spec.timeoutMs / 1000) + ' s.')
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            model: spec.model,
            digest,
            dimension,
            count: vectors.length,
            similarity,
            route,
            norms: vectors.map((vector) => vectorNorm(vector)),
          },
        }
      } catch (error) {
        if (error instanceof OllamaError && error.code === 'NO_MODEL') return refusal('NO_MODEL', await noModelText(deps, String(args.model ?? '')), { model: args.model })
        return failureOf(error)
      }
    },
  }

  return [status, run, bench, models, embed]
}

/** A bench run's inference spec, from the plan. */
function runSpec(plan, model, context) {
  return {
    model,
    chat: false,
    prompt: plan.prompt,
    messages: [],
    system: '',
    options: plan.options,
    format: plan.format,
    keepAlive: undefined,
    think: plan.think,
    timeoutMs: plan.timeoutMs,
  }
}

/** The plan's options plus the sweep's context, without mutating the plan. */
function optionsWithContext(options, context) {
  return context === null ? { ...options } : { ...options, num_ctx: context }
}

/** What a pull's NDJSON progress lines add up to. */
export function pullSummary(items) {
  let status = ''
  let layers = 0
  let total = 0
  let completed = 0
  const seen = new Map()
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.status === 'string' && item.status !== '') status = item.status
    const digest = typeof item.digest === 'string' ? item.digest : ''
    if (digest === '') continue
    const layer = seen.get(digest) ?? { total: 0, completed: 0 }
    if (typeof item.total === 'number') layer.total = item.total
    if (typeof item.completed === 'number') layer.completed = item.completed
    seen.set(digest, layer)
  }
  for (const layer of seen.values()) {
    layers += 1
    total += layer.total
    completed += layer.completed
  }
  return { status, layers, total, completed }
}

/**
 * One `model_info` value by SUFFIX.
 *
 * Ollama prefixes those keys with the architecture (`qwen2.context_length`,
 * `nomic-bert.embedding_length`), and the prefix changes with the model - so
 * matching only `llama.*` would report "n/a" for every model that is not a
 * Llama. The suffix is the stable part.
 */
function infoValue(info, suffix) {
  if (info === null || typeof info !== 'object') return null
  for (const [key, value] of Object.entries(info)) {
    if (typeof value === 'number' && (key === suffix || key.endsWith('.' + suffix))) return value
  }
  return null
}

/** One model's metadata as prose: what the template and the parameters say. */
function showText(model, data) {
  const details = data && typeof data.details === 'object' && data.details !== null ? data.details : {}
  const info = data && typeof data.model_info === 'object' && data.model_info !== null ? data.model_info : {}
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : []
  const lines = []
  lines.push('MODEL ' + model)
  lines.push('family        ' + (details.family ?? 'n/a') + (Array.isArray(details.families) && details.families.length > 1 ? ' (' + details.families.join(', ') + ')' : ''))
  lines.push('parameters    ' + (details.parameter_size ?? 'n/a') + ' \u00b7 quantization ' + (details.quantization_level ?? 'n/a') + ' \u00b7 format ' + (details.format ?? 'n/a'))
  lines.push('capabilities  ' + (capabilities.length === 0 ? '(not reported)' : capabilities.join(', ')))
  const contextLength = infoValue(info, 'context_length')
  const embeddingLength = infoValue(info, 'embedding_length')
  const blockCount = infoValue(info, 'block_count')
  const architecture = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : ''
  if (architecture !== '' || contextLength !== null || blockCount !== null) {
    lines.push('architecture  ' + (architecture || 'n/a') + (contextLength === null ? '' : ' \u00b7 context ' + contextLength + ' tokens') + (blockCount === null ? '' : ' \u00b7 ' + blockCount + ' blocks'))
  }
  if (embeddingLength !== null) {
    // `*.embedding_length` exists on every transformer - it is the hidden size.
    // Calling it "embedding" on a completion model would tell a reader the model
    // produces vectors, which is a different capability (and a different model).
    lines.push((capabilities.includes('embedding') ? 'embedding     ' : 'hidden size   ') + embeddingLength + ' dimensions')
  }
  const parameters = typeof data.parameters === 'string' ? data.parameters.trim() : ''
  if (parameters !== '') {
    lines.push('')
    lines.push('PARAMETERS (the model\'s own defaults)')
    lines.push(parameters.split('\n').slice(0, 40).join('\n'))
  }
  const template = typeof data.template === 'string' ? data.template.trim() : ''
  if (template !== '') {
    lines.push('')
    lines.push('TEMPLATE' + (template.length > 1200 ? ' (first 1200 characters)' : ''))
    lines.push(template.slice(0, 1200))
  }
  const license = typeof data.license === 'string' ? data.license.trim() : ''
  if (license !== '') {
    lines.push('')
    lines.push('LICENSE' + (license.length > 800 ? ' (first 800 characters)' : ''))
    lines.push(license.slice(0, 800))
  }
  lines.push('')
  lines.push('Next: `ollama_run` with this tag sends one inference, `ollama_bench` measures it, `ollama_models` action "delete" removes it.')
  return lines.join('\n')
}

/**
 * The benchmark's answer.
 *
 * The per-run table is the evidence; the aggregate below it is the claim; the
 * conditions line is what makes the claim checkable. The cold/warm comparison
 * is deliberately stated in WALL and TTFT, not tok/s.
 */
export function benchText(plan, groups, config) {
  const lines = []
  const models = [...new Set(groups.map((group) => group.model))]
  lines.push('BENCH ' + models.join(' vs ') + ' \u00b7 ' + plan.runs + ' measured run(s) per group')
  for (const group of groups) {
    const digest = group.digest === '' ? '' : ' \u00b7 digest ' + shortDigest(group.digest)
    const context = group.context === null ? 'model default' : String(group.context)
    lines.push('')
    lines.push('MODEL ' + group.model + digest + ' \u00b7 context ' + context)
    lines.push(table(
      ['RUN', 'TOK/S', 'TTFT', 'LOAD', 'EVAL', 'TOKENS', 'WALL'],
      group.runs.map((entry) => [
        String(entry.index),
        numberOr(entry.measured.evalTokensPerSecond, (value) => value.toFixed(1)),
        numberOr(entry.measured.ttftMeasuredMs ?? entry.measured.ttftDerivedMs, (value) => formatMilliseconds(value)),
        numberOr(entry.measured.loadMs, (value) => formatMilliseconds(value)),
        numberOr(entry.measured.evalMs, (value) => formatMilliseconds(value)),
        numberOr(entry.measured.evalCount, (value) => String(value)),
        numberOr(entry.measured.wallMs, (value) => formatMilliseconds(value)),
      ]),
    ))
    const rates = group.runs.map((entry) => entry.measured.evalTokensPerSecond)
    const ttfts = group.runs.map((entry) => entry.measured.ttftMeasuredMs ?? entry.measured.ttftDerivedMs)
    const walls = group.runs.map((entry) => entry.measured.wallMs)
    const rateSummary = summarize(rates)
    const ttftSummary = summarize(ttfts)
    const wallSummary = summarize(walls)
    const spread = rateSummary.spread === null ? 'n/a' : Math.round(rateSummary.spread * 100) + '%'
    lines.push(
      '  tok/s   median ' +
        numberOr(rateSummary.median, (value) => value.toFixed(1)) +
        ' \u00b7 p95 ' +
        numberOr(rateSummary.p95, (value) => value.toFixed(1)) +
        ' \u00b7 min ' +
        numberOr(rateSummary.min, (value) => value.toFixed(1)) +
        ' \u00b7 max ' +
        numberOr(rateSummary.max, (value) => value.toFixed(1)) +
        ' \u00b7 spread ' +
        spread,
    )
    lines.push('  TTFT    median ' + numberOr(ttftSummary.median, (value) => formatMilliseconds(value)) + ' \u00b7 p95 ' + numberOr(ttftSummary.p95, (value) => formatMilliseconds(value)))
    lines.push('  wall    median ' + numberOr(wallSummary.median, (value) => formatMilliseconds(value)) + ' \u00b7 p95 ' + numberOr(wallSummary.p95, (value) => formatMilliseconds(value)))
    const first = group.runs[0]
    const warmWalls = walls.slice(1).filter((value) => typeof value === 'number' && Number.isFinite(value))
    const warmWall = summarize(warmWalls)
    const firstTtft = first === undefined ? null : first.measured.ttftMeasuredMs ?? first.measured.ttftDerivedMs
    const warmTtft = summarize(ttfts.slice(1)).median
    if (group.runs.length > 1 && typeof firstTtft === 'number' && typeof warmTtft === 'number' && warmTtft > 0) {
      // The claim is about the FIRST TOKEN, because that is the phase the load
      // delays. A wall-clock ratio would compare two numbers a fast local daemon
      // can render as single-digit milliseconds - true, but not about the model.
      let sentence =
        '  first run first token at ' +
        formatMilliseconds(firstTtft) +
        ' (load ' +
        numberOr(first.measured.loadMs, formatMilliseconds) +
        ') \u00b7 warm runs ' +
        windowsPhrase(group.runs.length - 1) +
        ' at ' +
        formatMilliseconds(warmTtft) +
        ' median'
      const ratio = firstTtft / warmTtft
      if (ratio >= 1.05) sentence += ' \u00b7 ' + ratio.toFixed(2) + 'x later'
      if (typeof first.measured.wallMs === 'number' && typeof warmWall.median === 'number' && first.measured.wallMs >= 50 && warmWall.median >= 10) {
        sentence += ' \u00b7 wall ' + formatMilliseconds(first.measured.wallMs) + ' vs ' + formatMilliseconds(warmWall.median) + ' median'
      }
      lines.push(sentence)
    }
    lines.push('  note: tok/s is eval_count / eval_duration - the generation phase only - so a cold load raises TTFT and wall, never tok/s.' + (group.unloaded ? ' The model was unloaded with keep_alive 0 before run 1, so that run paid the load.' : ''))
  }
  lines.push('')
  lines.push('Conditions: ' + conditionLine({ options: plan.options, keepAlive: undefined, timeoutMs: plan.timeoutMs }, { timeoutSeconds: plan.timeoutSeconds }) + '.')
  lines.push('Runs: ' + plan.measuredCalls + ' measured call(s)' + (plan.warmupCalls > 0 ? ' plus ' + plan.warmupCalls + ' warmup' : '') + (plan.cold ? ', model unloaded before each group' : ', no unload (warm model)') + '.')
  lines.push('Reading it: a median with a spread, at a stated context and a stated digest, is a measurement. The same model on another machine - or at another num_ctx - is a different number.')
  if (config.remote) lines.push('Host: ' + config.origin + ' is not this machine (allowed by DSH_OLLAMA_ALLOW_REMOTE=1); every ms above includes the network.')
  return lines.join('\n')
}

/** "2-5" or "2", for the cold/warm sentence. */
function windowsPhrase(count) {
  if (count <= 0) return 'none'
  if (count === 1) return 'run 2'
  return '2-' + (count + 1)
}

/** The bench's view: the per-run numbers, without the prose. */
export function benchView(plan, groups, config) {
  return {
    ok: true,
    runs: plan.runs,
    measuredCalls: plan.measuredCalls,
    cold: plan.cold,
    options: plan.options,
    host: { origin: config.origin, remote: config.remote },
    groups: groups.map((group) => ({
      model: group.model,
      digest: group.digest,
      context: group.context,
      unloaded: group.unloaded === true,
      runs: group.runs,
      rates: summarize(group.runs.map((entry) => entry.measured.evalTokensPerSecond)),
      ttft: summarize(group.runs.map((entry) => entry.measured.ttftMeasuredMs ?? entry.measured.ttftDerivedMs)),
      wall: summarize(group.runs.map((entry) => entry.measured.wallMs)),
    })),
  }
}
