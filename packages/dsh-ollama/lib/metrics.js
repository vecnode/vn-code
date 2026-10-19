/**
 * dsh-ollama — the arithmetic behind every number this row reports.
 *
 * Ollama reports its own timings in **nanoseconds** (`load_duration`,
 * `prompt_eval_duration`, `eval_duration`, `total_duration`) and its own token
 * counts (`prompt_eval_count`, `eval_count`). Every rate this plugin prints is
 * ONE division of those two fields - never a stopwatch of ours substituted for
 * them - so a reader can recompute it from the same response.
 *
 * Two rules make those numbers honest, and both are enforced here rather than
 * in the prose of a tool:
 *
 *   - a duration of zero yields `null`, not `Infinity`: a daemon that reported
 *     no time did not measure one;
 *   - `eval_duration` covers the GENERATION phase only, so load time never
 *     lowers tok/s - it shows up in time-to-first-token and in wall clock. A
 *     benchmark that attributed a cold load to tok/s would be measuring the
 *     wrong thing.
 */

/** Ollama's duration fields are nanoseconds. */
export const NS_PER_SECOND = 1e9
export const NS_PER_MILLISECOND = 1e6

/** A finite number or `null` - never `NaN`, never `Infinity`. */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** An integer or `null`. */
function integerOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/**
 * Nanoseconds from the daemon, as milliseconds.
 * @param nanoseconds - `final.eval_duration` and friends.
 * @returns milliseconds, or `null` when the field is absent or not a number.
 */
export function millisecondsOf(nanoseconds) {
  const value = finiteOrNull(nanoseconds)
  return value === null ? null : value / NS_PER_MILLISECOND
}

/**
 * Tokens per second from a count and a nanosecond duration.
 * @param count - `eval_count` or `prompt_eval_count`.
 * @param durationNs - the matching `*_duration`.
 * @returns tokens/second, or `null` when either side is absent or zero.
 */
export function tokensPerSecond(count, durationNs) {
  const tokens = finiteOrNull(count)
  const duration = finiteOrNull(durationNs)
  if (tokens === null || duration === null || duration <= 0 || tokens < 0) return null
  return tokens / (duration / NS_PER_SECOND)
}

/**
 * Turn one final response object into the measured shape every tool reports.
 *
 * `ttftDerivedMs` is `load + prompt_eval`: the daemon's own account of when the
 * first generated token became possible. `ttftMeasuredMs` is what a streaming
 * reader actually observed, and the two are reported side by side on purpose -
 * when they disagree, the difference is the transport, not the model.
 *
 * @param final - the last NDJSON object of a generate/chat call.
 * @param extra - `{ wallMs, ttftMs, doneReason }`, measured by the caller.
 * @returns the numbers, with `null` where the daemon reported nothing.
 */
export function measure(final, extra = {}) {
  const response = final !== null && typeof final === 'object' ? final : {}
  const loadMs = millisecondsOf(response.load_duration)
  const promptEvalMs = millisecondsOf(response.prompt_eval_duration)
  const derived = loadMs === null && promptEvalMs === null ? null : (loadMs ?? 0) + (promptEvalMs ?? 0)
  return {
    evalCount: integerOrNull(response.eval_count),
    promptEvalCount: integerOrNull(response.prompt_eval_count),
    evalMs: millisecondsOf(response.eval_duration),
    promptEvalMs,
    loadMs,
    totalMs: millisecondsOf(response.total_duration),
    evalTokensPerSecond: tokensPerSecond(response.eval_count, response.eval_duration),
    promptTokensPerSecond: tokensPerSecond(response.prompt_eval_count, response.prompt_eval_duration),
    ttftMeasuredMs: finiteOrNull(extra.ttftMs),
    ttftDerivedMs: derived,
    wallMs: finiteOrNull(extra.wallMs),
    doneReason: typeof extra.doneReason === 'string' ? extra.doneReason : typeof response.done_reason === 'string' ? response.done_reason : '',
  }
}

/**
 * The p-th percentile by NEAREST RANK: the smallest value at or above the
 * rank, so `p95` of five runs is one of the five and never a number no run
 * produced. This is the convention a small sample can survive; an interpolated
 * percentile invents a run.
 *
 * @param values - numbers (unsorted is fine).
 * @param pct - 0..100.
 * @returns the value, or `null` for an empty sample.
 */
export function percentile(values, pct) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const clamped = Math.min(100, Math.max(0, pct))
  const rank = Math.ceil((clamped / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/** The median: the p50 of the sample. */
export function median(values) {
  return percentile(values, 50)
}

/**
 * A sample summarised the way the metrics skill tells a reader to report it:
 * a median with a spread, never a lone number.
 *
 * `spread` is the population standard deviation / mean (relative), which is
 * comparable across models with different absolute rates; `range` is max - min
 * because a reader can see both endpoints in the per-run table.
 *
 * @param values - the sample.
 * @returns `{ count, min, median, p95, max, mean, stdev, spread, range }`.
 */
export function summarize(values) {
  const sample = values.filter((value) => Number.isFinite(value))
  if (sample.length === 0) return { count: 0, min: null, median: null, p95: null, max: null, mean: null, stdev: null, spread: null, range: null }
  const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length
  const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length
  const min = Math.min(...sample)
  const max = Math.max(...sample)
  return {
    count: sample.length,
    min,
    median: median(sample),
    p95: percentile(sample, 95),
    max,
    mean,
    stdev: Math.sqrt(variance),
    spread: mean === 0 ? null : Math.sqrt(variance) / mean,
    range: max - min,
  }
}

/**
 * Cosine similarity between two vectors.
 *
 * A zero-length vector or a dimension mismatch returns `null`: the answer is
 * "these are not comparable", not a number a reader would trust.
 *
 * @param a - first vector.
 * @param b - second vector.
 * @returns -1..1, or `null`.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) return null
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return null
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** The L2 norm of a vector, or `null`. */
export function vectorNorm(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null
  let sum = 0
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    sum += value * value
  }
  return Math.sqrt(sum)
}

/**
 * A duration: milliseconds under a second, seconds above it.
 *
 * A 4 ms wall clock printed as "0.00 s" reads as "nothing happened"; the unit
 * changes at a second because that is where a reader stops counting in ms.
 *
 * @param milliseconds - the duration.
 * @param digits - decimals for the seconds form.
 */
export function formatMilliseconds(milliseconds, digits = 2) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return 'n/a'
  if (milliseconds < 0) return 'n/a'
  if (milliseconds < 1000) return Math.round(milliseconds) + ' ms'
  return (milliseconds / 1000).toFixed(digits) + ' s'
}

/** A rate, to one decimal: "50.0 tok/s". */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'n/a'
  return rate.toFixed(1) + ' tok/s'
}

/** Bytes the way `ollama list` prints them: 1024-based, one decimal. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'n/a'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (unit === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[unit]
}

/**
 * An expiry time as a sentence, from `/api/ps`'s `expires_at`.
 *
 * @param expiresAt - an ISO timestamp, or anything the daemon sent.
 * @param nowMs - the clock to compare against.
 * @returns "in 4 minutes", "expired", or '' when there is nothing to say.
 */
export function formatExpiry(expiresAt, nowMs = Date.now()) {
  if (typeof expiresAt !== 'string' || expiresAt === '') return ''
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return ''
  const delta = at - nowMs
  if (delta <= 0) return 'expired'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'in under a minute'
  if (minutes < 60) return 'in ' + minutes + (minutes === 1 ? ' minute' : ' minutes')
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return 'in ' + hours + (hours === 1 ? ' hour' : ' hours') + (rest === 0 ? '' : ' ' + rest + ' min')
  const days = Math.floor(hours / 24)
  return 'in ' + days + (days === 1 ? ' day' : ' days')
}

/** A percentage of a whole, or '' when the whole is unknown. */
export function formatShare(part, whole) {
  if (typeof part !== 'number' || typeof whole !== 'number' || !Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return ''
  return Math.round((part / whole) * 100) + '%'
}
