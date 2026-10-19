/**
 * dsh-ollama — the argument grammar, one function per tool.
 *
 * A tool schema already tells the model what it may send; this module is the
 * second line, for the calls the registry's validator cannot make sense of:
 * a `num_predict` that would run for an hour, a `messages` array with a role
 * nobody implements, an option name that is a typo (`temprature` would be
 * silently ignored by the daemon and quietly change what the benchmark
 * measured), or a model tag with a space in it.
 *
 * Every refusal is a sentence naming the field, the value and the range - the
 * model cannot fix an argument it cannot see.
 */

import { OllamaError } from './errors.js'

/**
 * The ceilings this row enforces, in one place because the tool descriptions
 * and the README quote them.
 *
 * `maxNumPredict` is the one that makes "ONE bounded inference" true: Ollama's
 * own default is `-1` (generate until the stop token or the context fills), so
 * every call this row sends carries an explicit `num_predict`.
 */
export const CAPS = {
  maxNumPredict: 8192,
  defaultNumPredict: 512,
  benchNumPredict: 128,
  maxPromptChars: 200_000,
  maxMessages: 64,
  maxMessageImages: 4,
  maxImageChars: 8_000_000,
  maxToolCallChars: 64_000,
  maxFormatChars: 8192,
  maxStopSequences: 8,
  maxStopChars: 256,
  maxModelChars: 200,
  minRuns: 3,
  defaultRuns: 5,
  maxRuns: 50,
  maxWarmup: 5,
  maxModelsPerBench: 3,
  maxContexts: 6,
  maxBenchCalls: 150,
  maxBenchWarmupCalls: 60,
  maxEmbedInputs: 64,
  maxEmbedChars: 20_000,
  maxEmbedTotalChars: 100_000,
  defaultRunTimeoutSeconds: 300,
  minRunTimeoutSeconds: 10,
  maxRunTimeoutSeconds: 900,
  defaultBenchTimeoutSeconds: 300,
  minBenchTimeoutSeconds: 30,
  maxBenchTimeoutSeconds: 600,
  defaultEmbedTimeoutSeconds: 60,
  minEmbedTimeoutSeconds: 5,
  maxEmbedTimeoutSeconds: 600,
  defaultPullTimeoutSeconds: 1800,
  maxPullTimeoutSeconds: 3600,
  statusTimeoutMs: 4000,
  readTimeoutMs: 15_000,
}

/** A model name: lowercase name segments, an optional tag, an optional digest. */
const MODEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/

/** Ollama's `options` map: ranges in the units the daemon uses. */
const OPTION_SPECS = {
  num_keep: { kind: 'integer', min: 0, max: 512 },
  seed: { kind: 'integer', min: 0, max: 2_147_483_647 },
  num_predict: { kind: 'integer', min: 1, max: CAPS.maxNumPredict },
  top_k: { kind: 'integer', min: 0, max: 1000 },
  top_p: { kind: 'number', min: 0, max: 1 },
  min_p: { kind: 'number', min: 0, max: 1 },
  tfs_z: { kind: 'number', min: 0, max: 5 },
  typical_p: { kind: 'number', min: 0, max: 1 },
  repeat_last_n: { kind: 'integer', min: -1, max: 8192 },
  temperature: { kind: 'number', min: 0, max: 2 },
  repeat_penalty: { kind: 'number', min: 0, max: 10 },
  presence_penalty: { kind: 'number', min: -2, max: 2 },
  frequency_penalty: { kind: 'number', min: -2, max: 2 },
  mirostat: { kind: 'integer', min: 0, max: 2 },
  mirostat_tau: { kind: 'number', min: 0, max: 10 },
  mirostat_eta: { kind: 'number', min: 0, max: 1 },
  num_ctx: { kind: 'integer', min: 128, max: 1_048_576 },
  num_batch: { kind: 'integer', min: 1, max: 4096 },
  num_gpu: { kind: 'integer', min: 0, max: 999 },
  main_gpu: { kind: 'integer', min: 0, max: 99 },
  num_thread: { kind: 'integer', min: 1, max: 256 },
  penalize_newline: { kind: 'boolean' },
  numa: { kind: 'boolean' },
  low_vram: { kind: 'boolean' },
  f16_kv: { kind: 'boolean' },
  vocab_only: { kind: 'boolean' },
  use_mmap: { kind: 'boolean' },
  use_mlock: { kind: 'boolean' },
  truncate: { kind: 'boolean' },
  shift: { kind: 'boolean' },
  stop: { kind: 'stop' },
}

/** Every option name this row sends, in the order the tool schema lists them. */
export const OPTION_KEYS = Object.keys(OPTION_SPECS)

/** Refuse with a code and a sentence that names the field. */
function fail(code, message) {
  throw new OllamaError(code, message)
}

/** A required, non-empty string. */
function requireString(value, field, maxChars = CAPS.maxModelChars) {
  if (typeof value !== 'string') fail('BAD_ARGUMENT', '`' + field + '` must be a string (got ' + (value === null ? 'null' : typeof value) + ').')
  const text = value
  if (text.trim() === '') fail('BAD_ARGUMENT', '`' + field + '` is empty; give it a value.')
  if (text.length > maxChars) fail('BAD_ARGUMENT', '`' + field + '` is ' + text.length + ' characters, over the ' + maxChars + '-character ceiling this row accepts.')
  return text
}

/**
 * A model tag.
 *
 * The grammar is Ollama's own (`name[:tag]`, a `namespace/` prefix, an
 * optional `@sha256:` digest for a pull); it is closed here so a value cannot
 * carry a space, a flag-looking `-` or a path separator into a later request.
 *
 * @param value - the caller's value.
 * @param field - the argument name, for the refusal.
 * @param options - `{ digest }` allows the `@sha256:` form (pull only).
 */
export function validateModelTag(value, field = 'model', options = {}) {
  const text = requireString(value, field, CAPS.maxModelChars).trim()
  if (text.includes('@') && options.digest !== true) {
    fail('BAD_MODEL', '`' + field + '` is "' + text + '"; only a pull may name a digest (@sha256:...), and nothing else may contain "@".')
  }
  if (!MODEL_PATTERN.test(text)) {
    fail(
      'BAD_MODEL',
      '`' +
        field +
        '` is "' +
        text +
        '", which is not a model tag. Use the tag `ollama list` prints: lowercase name, optional ":tag" (e.g. qwen2.5:7b, llama3.2:1b, hf.co/user/model:Q4_K_M).',
    )
  }
  return text
}

/**
 * `keep_alive`: seconds (number or numeric string) or a duration string.
 *
 * `0` unloads the model when the request ends, `-1` keeps it loaded forever;
 * both are accepted because both are documented daemon behaviour.
 */
export function validateKeepAlive(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < -1) fail('BAD_KEEP_ALIVE', '`keep_alive` is ' + value + '; use -1 (forever), 0 (unload when this request ends), or a positive number of seconds.')
    return value
  }
  const text = requireString(value, 'keep_alive', 32).trim()
  if (/^-?\d+$/.test(text)) {
    const seconds = Number(text)
    if (seconds < -1) fail('BAD_KEEP_ALIVE', '`keep_alive` is ' + seconds + '; use -1, 0, or a positive number of seconds.')
    return seconds
  }
  if (!/^-?\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(text)) {
    fail('BAD_KEEP_ALIVE', '`keep_alive` is "' + text + '"; use a duration such as "5m", "30s", "1h", or 0 / -1.')
  }
  return text
}

/**
 * `format`: unset, the word "json", or a JSON Schema object.
 *
 * A schema is passed straight to the daemon, so it is size-capped and must be
 * a plain object - a string that merely looks like JSON would be sent as a
 * string and rejected by Ollama with a far worse message.
 */
export function validateFormat(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() !== 'json') fail('BAD_FORMAT', '`format` is "' + value + '"; use "json" or a JSON Schema object (structured outputs are a schema, not a mode name other than json).')
    return 'json'
  }
  if (typeof value !== 'object' || Array.isArray(value)) fail('BAD_FORMAT', '`format` must be "json" or a JSON Schema object.')
  const text = JSON.stringify(value)
  if (text.length > CAPS.maxFormatChars) fail('BAD_FORMAT', '`format` is ' + text.length + ' characters, over the ' + CAPS.maxFormatChars + '-character ceiling for a schema.')
  return value
}

/** One `stop` value: a string or up to eight strings. */
function validateStop(value) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) fail('BAD_OPTION', '`options.stop` is an empty array; give it at least one sequence or omit it.')
  if (list.length > CAPS.maxStopSequences) fail('BAD_OPTION', '`options.stop` carries ' + list.length + ' sequences, over the ' + CAPS.maxStopSequences + '-sequence ceiling.')
  for (const entry of list) {
    if (typeof entry !== 'string' || entry === '') fail('BAD_OPTION', '`options.stop` must be a string or an array of non-empty strings.')
    if (entry.length > CAPS.maxStopChars) fail('BAD_OPTION', '`options.stop` has a ' + entry.length + '-character sequence, over the ' + CAPS.maxStopChars + '-character ceiling.')
  }
  return list
}

/**
 * The `options` map, closed to names this row does not know.
 *
 * Refusing an unknown name is deliberate: a mistyped `temprature` is not an
 * error to the daemon - it is IGNORED - so the run would report numbers taken
 * at a temperature the caller never chose.
 */
export function validateOptions(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) fail('BAD_OPTION', '`options` must be an object: { "temperature": 0, "num_predict": 128 }.')
  const normalized = {}
  for (const [key, raw] of Object.entries(value)) {
    const spec = OPTION_SPECS[key]
    if (spec === undefined) {
      fail(
        'BAD_OPTION',
        '`options.' +
          key +
          '` is not an option this row sends. Known options: ' +
          OPTION_KEYS.join(', ') +
          '. (Ollama silently ignores an unknown option, so a typo would change what these numbers measured.)',
      )
    }
    if (raw === undefined || raw === null) continue
    if (spec.kind === 'boolean') {
      if (typeof raw !== 'boolean') fail('BAD_OPTION', '`options.' + key + '` must be true or false.')
      normalized[key] = raw
      continue
    }
    if (spec.kind === 'stop') {
      normalized[key] = validateStop(raw)
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) fail('BAD_OPTION', '`options.' + key + '` must be a number (got ' + (raw === null ? 'null' : typeof raw) + ').')
    if (spec.kind === 'integer' && !Number.isInteger(raw)) fail('BAD_OPTION', '`options.' + key + '` must be an integer (got ' + raw + ').')
    if (raw < spec.min || raw > spec.max) fail('BAD_OPTION', '`options.' + key + '` is ' + raw + ', outside ' + spec.min + '..' + spec.max + '.')
    normalized[key] = raw
  }
  return normalized
}

/** A prompt: non-empty, capped. Whitespace is kept - it can be the prompt. */
export function validatePrompt(value, field = 'prompt') {
  if (typeof value !== 'string') fail('BAD_ARGUMENT', '`' + field + '` must be a string.')
  if (value.trim() === '') fail('BAD_ARGUMENT', '`' + field + '` is empty; give it something to answer.')
  if (value.length > CAPS.maxPromptChars) fail('BAD_ARGUMENT', '`' + field + '` is ' + value.length + ' characters, over the ' + CAPS.maxPromptChars + '-character ceiling for one call.')
  return value
}

/**
 * `messages` for `/api/chat`: role, content, optional images and tool fields.
 *
 * Images are accepted because a vision model's API is the same endpoint; they
 * are capped per message and in total because base64 is carried through the
 * conversation as text and an unbounded one is a prompt of a different size
 * entirely.
 */
export function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) fail('BAD_MESSAGES', '`messages` must be a non-empty array of { role, content }.')
  if (value.length > CAPS.maxMessages) fail('BAD_MESSAGES', '`messages` carries ' + value.length + ' messages, over the ' + CAPS.maxMessages + '-message ceiling.')
  const allowed = ['role', 'content', 'images', 'tool_calls', 'tool_name']
  const roles = ['system', 'user', 'assistant', 'tool']
  let totalChars = 0
  const normalized = []
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('BAD_MESSAGES', '`messages[' + index + ']` must be an object { role, content }.')
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) {
        fail('BAD_MESSAGES', '`messages[' + index + '].' + key + '` is not a message field. Allowed: ' + allowed.join(', ') + '.')
      }
    }
    const role = String(entry.role ?? '')
    if (!roles.includes(role)) fail('BAD_MESSAGES', '`messages[' + index + '].role` is "' + role + '"; use one of ' + roles.join(', ') + '.')
    if (typeof entry.content !== 'string') fail('BAD_MESSAGES', '`messages[' + index + '].content` must be a string.')
    totalChars += entry.content.length
    const message = { role, content: entry.content }
    if (entry.images !== undefined) {
      if (!Array.isArray(entry.images) || entry.images.length === 0) fail('BAD_MESSAGES', '`messages[' + index + '].images` must be a non-empty array of base64 strings.')
      if (entry.images.length > CAPS.maxMessageImages) fail('BAD_MESSAGES', '`messages[' + index + '].images` carries ' + entry.images.length + ' images, over the ' + CAPS.maxMessageImages + '-image ceiling per message.')
      for (const image of entry.images) {
        if (typeof image !== 'string' || image === '') fail('BAD_MESSAGES', '`messages[' + index + '].images` must contain base64 strings.')
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(image)) fail('BAD_MESSAGES', '`messages[' + index + '].images` must be raw base64 (no data: URL prefix).')
        if (image.length > CAPS.maxImageChars) fail('BAD_MESSAGES', '`messages[' + index + ']` has an image of ' + image.length + ' base64 characters, over the ' + CAPS.maxImageChars + '-character ceiling.')
        totalChars += image.length
      }
      message.images = entry.images
    }
    if (entry.tool_name !== undefined) {
      if (typeof entry.tool_name !== 'string' || entry.tool_name === '') fail('BAD_MESSAGES', '`messages[' + index + '].tool_name` must be a non-empty string.')
      message.tool_name = entry.tool_name
    }
    if (entry.tool_calls !== undefined) {
      if (!Array.isArray(entry.tool_calls)) fail('BAD_MESSAGES', '`messages[' + index + '].tool_calls` must be an array.')
      const text = JSON.stringify(entry.tool_calls)
      if (text.length > CAPS.maxToolCallChars) fail('BAD_MESSAGES', '`messages[' + index + '].tool_calls` is ' + text.length + ' characters, over the ' + CAPS.maxToolCallChars + '-character ceiling.')
      message.tool_calls = entry.tool_calls
    }
    normalized.push(message)
  }
  if (totalChars > CAPS.maxPromptChars) fail('BAD_MESSAGES', 'The whole `messages` array is ' + totalChars + ' characters, over the ' + CAPS.maxPromptChars + '-character ceiling for one call.')
  return normalized
}

/** A timeout in seconds, clamped to the named range. */
export function validateSeconds(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('BAD_ARGUMENT', '`' + field + '` must be a number of seconds.')
  if (value < min || value > max) fail('BAD_ARGUMENT', '`' + field + '` is ' + value + ' s, outside ' + min + '..' + max + ' s. This row will not run a call it cannot bound.')
  return value
}

/**
 * One inference: `prompt` XOR `messages`, plus the options map.
 *
 * `num_predict` gets a value whether or not the caller sent one: Ollama's
 * default is unbounded generation, and this row's contract is ONE bounded
 * inference.
 */
export function validateRun(args = {}) {
  const model = validateModelTag(args.model, 'model')
  const hasPrompt = args.prompt !== undefined && args.prompt !== null
  const hasMessages = args.messages !== undefined && args.messages !== null
  if (hasPrompt === hasMessages) {
    fail('BAD_ARGUMENT', '`ollama_run` takes `prompt` (one string) OR `messages` (a chat array), exactly one. ' + (hasPrompt ? 'Both were sent.' : 'Neither was sent.'))
  }
  if (hasMessages && args.system !== undefined) {
    fail('BAD_ARGUMENT', '`system` belongs to `prompt`; in a `messages` call put it in its own message: { "role": "system", "content": "..." }.')
  }
  const options = validateOptions(args.options)
  if (options.num_predict === undefined) options.num_predict = CAPS.defaultNumPredict
  return {
    model,
    chat: hasMessages,
    prompt: hasPrompt ? validatePrompt(args.prompt) : '',
    messages: hasMessages ? validateMessages(args.messages) : [],
    system: args.system === undefined ? '' : requireString(args.system, 'system', CAPS.maxPromptChars),
    options,
    format: validateFormat(args.format),
    keepAlive: validateKeepAlive(args.keep_alive),
    think: args.think === undefined ? undefined : args.think === true,
    timeoutMs: validateSeconds(args.timeoutSeconds, 'timeoutSeconds', CAPS.defaultRunTimeoutSeconds, CAPS.minRunTimeoutSeconds, CAPS.maxRunTimeoutSeconds) * 1000,
  }
}

/**
 * A benchmark plan: 3+ runs, one variable at a time, a bounded call count.
 *
 * `runs` is refused below three because one run is not a measurement; the
 * aggregate the tool prints is a median with a spread, and a median of one
 * number is a claim the sample cannot carry.
 */
export function validateBench(args = {}) {
  const single = args.model === undefined || args.model === null ? null : validateModelTag(args.model, 'model')
  const many = args.models === undefined || args.models === null ? null : args.models
  if (single === null && many === null) fail('BAD_ARGUMENT', '`ollama_bench` needs `model` (one tag) or `models` (an A/B array of 1-3 tags).')
  if (single !== null && many !== null) fail('BAD_ARGUMENT', 'Send `model` OR `models`, not both: `models` is the A/B form and `model` is the single-model shorthand.')
  let models
  if (many !== null) {
    if (!Array.isArray(many) || many.length === 0) fail('BAD_ARGUMENT', '`models` must be a non-empty array of model tags.')
    if (many.length > CAPS.maxModelsPerBench) fail('BAD_ARGUMENT', '`models` carries ' + many.length + ' tags, over the ' + CAPS.maxModelsPerBench + '-model ceiling for one A/B run.')
    models = many.map((entry, index) => validateModelTag(entry, 'models[' + index + ']'))
  } else {
    models = [single]
  }
  if (new Set(models).size !== models.length) fail('BAD_ARGUMENT', '`models` names the same tag twice; an A/B needs two different models.')
  const prompt = validatePrompt(args.prompt, 'prompt')
  const runs = args.runs === undefined ? CAPS.defaultRuns : args.runs
  if (typeof runs !== 'number' || !Number.isInteger(runs)) fail('BAD_ARGUMENT', '`runs` must be an integer.')
  if (runs < CAPS.minRuns) {
    fail(
      'BAD_RUNS',
      '`runs` is ' +
        runs +
        '; a benchmark needs at least ' +
        CAPS.minRuns +
        '. One run is a number, not a measurement - a single tok/s cannot say whether the next run will be faster or slower.',
    )
  }
  if (runs > CAPS.maxRuns) fail('BAD_ARGUMENT', '`runs` is ' + runs + ', over the ' + CAPS.maxRuns + '-run ceiling for one benchmark.')
  const warmup = args.warmup === undefined ? 0 : args.warmup
  if (typeof warmup !== 'number' || !Number.isInteger(warmup) || warmup < 0 || warmup > CAPS.maxWarmup) {
    fail('BAD_ARGUMENT', '`warmup` must be an integer 0..' + CAPS.maxWarmup + ' (calls made before the measured runs and not counted).')
  }
  const cold = args.cold !== false
  const contexts = args.contexts === undefined || args.contexts === null ? [] : args.contexts
  if (!Array.isArray(contexts)) fail('BAD_ARGUMENT', '`contexts` must be an array of context lengths, e.g. [2048, 8192].')
  if (contexts.length > CAPS.maxContexts) fail('BAD_ARGUMENT', '`contexts` carries ' + contexts.length + ' values, over the ' + CAPS.maxContexts + '-value ceiling for one sweep.')
  const seen = new Set()
  for (const entry of contexts) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 128 || entry > 1_048_576) fail('BAD_ARGUMENT', '`contexts` must be integers 128..1048576 (got ' + entry + ').')
    if (seen.has(entry)) fail('BAD_ARGUMENT', '`contexts` names ' + entry + ' twice; a sweep needs distinct values.')
    seen.add(entry)
  }
  const options = validateOptions(args.options)
  if (options.num_predict === undefined) options.num_predict = CAPS.benchNumPredict
  if (options.temperature === undefined) options.temperature = 0
  if (options.seed === undefined) options.seed = 42
  const timeoutSeconds = validateSeconds(args.timeoutSeconds, 'timeoutSeconds', CAPS.defaultBenchTimeoutSeconds, CAPS.minBenchTimeoutSeconds, CAPS.maxBenchTimeoutSeconds)
  const groups = models.length * Math.max(1, contexts.length)
  const measured = groups * runs
  const warmupCalls = groups * warmup
  if (measured > CAPS.maxBenchCalls) {
    fail('BAD_ARGUMENT', 'This plan is ' + measured + ' measured calls (' + models.length + ' model(s) x ' + Math.max(1, contexts.length) + ' context(s) x ' + runs + ' runs), over the ' + CAPS.maxBenchCalls + '-call ceiling. Lower `runs`, `contexts` or `models`.')
  }
  if (warmupCalls > CAPS.maxBenchWarmupCalls) {
    fail('BAD_ARGUMENT', 'This plan is ' + warmupCalls + ' warmup calls, over the ' + CAPS.maxBenchWarmupCalls + '-call ceiling. Lower `warmup` or the plan.')
  }
  return {
    models,
    prompt,
    runs,
    warmup,
    cold,
    contexts,
    options,
    format: validateFormat(args.format),
    think: args.think === undefined ? undefined : args.think === true,
    timeoutMs: timeoutSeconds * 1000,
    timeoutSeconds,
    measuredCalls: measured,
    warmupCalls,
  }
}

/** Enumerations this row accepts for the writer tools. */
export const MODEL_ACTIONS = ['list', 'show', 'pull', 'delete']

/** `ollama_models`: the action, the tag it names, and the confirmation. */
export function validateModels(args = {}) {
  const action = args.action === undefined || args.action === null ? 'list' : String(args.action).toLowerCase()
  if (!MODEL_ACTIONS.includes(action)) fail('BAD_ARGUMENT', '`action` is "' + action + '"; use one of ' + MODEL_ACTIONS.join(', ') + '.')
  if (action === 'list') return { action, model: '', confirm: '', timeoutSeconds: 0 }
  const model = validateModelTag(args.model, 'model', { digest: action === 'pull' })
  const confirm = args.confirm === undefined || args.confirm === null ? '' : String(args.confirm)
  // A pull downloads gigabytes, so its deadline is the one a person may need to
  // raise - and the TIMEOUT refusal names this argument.
  const timeoutSeconds = action === 'pull' ? validateSeconds(args.timeoutSeconds, 'timeoutSeconds', CAPS.defaultPullTimeoutSeconds, 60, CAPS.maxPullTimeoutSeconds) : 0
  return { action, model, confirm, timeoutSeconds }
}

/** `ollama_embed`: one or more strings, and the comparability question. */
export function validateEmbed(args = {}) {
  const model = validateModelTag(args.model, 'model')
  const raw = args.input
  const list = Array.isArray(raw) ? raw : [raw]
  if (raw === undefined || raw === null) fail('BAD_ARGUMENT', '`input` is required: one string, or an array of strings.')
  if (list.length === 0) fail('BAD_ARGUMENT', '`input` is an empty array; give it at least one string.')
  if (list.length > CAPS.maxEmbedInputs) fail('BAD_ARGUMENT', '`input` carries ' + list.length + ' strings, over the ' + CAPS.maxEmbedInputs + '-input ceiling for one call.')
  let total = 0
  const inputs = list.map((entry, index) => {
    if (typeof entry !== 'string') fail('BAD_ARGUMENT', '`input[' + index + ']` must be a string.')
    if (entry === '') fail('BAD_ARGUMENT', '`input[' + index + ']` is empty; an embedding of nothing is not an embedding.')
    if (entry.length > CAPS.maxEmbedChars) fail('BAD_ARGUMENT', '`input[' + index + ']` is ' + entry.length + ' characters, over the ' + CAPS.maxEmbedChars + '-character ceiling.')
    total += entry.length
    return entry
  })
  if (total > CAPS.maxEmbedTotalChars) fail('BAD_ARGUMENT', 'The whole `input` is ' + total + ' characters, over the ' + CAPS.maxEmbedTotalChars + '-character ceiling for one call.')
  return {
    model,
    inputs,
    similarity: args.similarity === undefined ? inputs.length === 2 : args.similarity === true,
    timeoutMs: validateSeconds(args.timeoutSeconds, 'timeoutSeconds', CAPS.defaultEmbedTimeoutSeconds, CAPS.minEmbedTimeoutSeconds, CAPS.maxEmbedTimeoutSeconds) * 1000,
    keepAlive: validateKeepAlive(args.keep_alive),
  }
}
