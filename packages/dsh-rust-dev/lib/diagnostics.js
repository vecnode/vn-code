/**
 * dsh-rust-dev — `cargo --message-format=json`, parsed rather than grepped.
 *
 * The human output is prose for a person at a terminal: wrapped, coloured, and
 * re-flowed whenever rustc changes its renderer. The JSON stream is the stable
 * contract, and it carries the two things a reader actually needs - the
 * diagnostic CODE (`E0308`) and the primary SPAN as file/line/column - so this
 * module never regexes a rendered message.
 *
 * Deduplication matters as much as parsing: one type error in a widely used
 * function is reported once per call site, and a list of forty identical
 * `E0308`s hides the four distinct mistakes inside it. Items are keyed by
 * code + message + primary location, and a repeat is counted, not repeated.
 */

/** A one-line meaning for the codes a Rust developer meets weekly. */
export const CODE_HINTS = {
  E0308: 'mismatched types',
  E0277: 'a trait bound is not satisfied',
  E0382: 'use of a moved value',
  E0502: 'cannot borrow as mutable: also borrowed as immutable',
  E0499: 'two mutable borrows at once',
  E0505: 'cannot move out: borrowed',
  E0597: 'a borrowed value does not live long enough',
  E0515: 'returning a reference to a local',
  E0061: 'wrong number of arguments',
  E0432: 'unresolved import',
  E0433: 'failed to resolve: a path that does not exist',
  E0412: 'a type name is not in scope',
  E0658: 'an unstable feature was used',
  E0603: 'a private item was used',
  E0133: 'unsafe operation outside an unsafe block',
  E0004: 'non-exhaustive match',
  E0015: 'a non-const call in a const context',
  E0463: 'a crate is not available for this target',
  E0464: 'a crate resolved to conflicting candidates',
}

/**
 * Parse the stdout of a `--message-format=json` invocation.
 *
 * Cargo interleaves `compiler-artifact`, `compiler-message`, `build-script-executed`
 * and a final `build-finished`. Lines that are not JSON are counted and dropped -
 * a build script is allowed to print anything, and one stray line must not lose
 * the diagnostics.
 *
 * @param stdout - the child's stdout.
 * @returns `{ events, messages, artifacts, finished, noise }`.
 */
export function parseJsonStream(stdout) {
  const events = []
  const noise = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') {
      if (trimmed !== '') noise.push(trimmed)
      continue
    }
    try {
      events.push(JSON.parse(trimmed))
    } catch (error) {
      noise.push(trimmed)
    }
  }
  const messages = events.filter((event) => event && event.reason === 'compiler-message' && event.message)
  const artifacts = events.filter((event) => event && event.reason === 'compiler-artifact')
  const finished = events.find((event) => event && event.reason === 'build-finished') ?? null
  return { events, messages, artifacts, finished, noise }
}

/** The primary span of a diagnostic, falling back to its first span. */
export function primarySpan(message) {
  const spans = Array.isArray(message.spans) ? message.spans : []
  return spans.find((span) => span && span.is_primary) ?? spans[0] ?? null
}

/**
 * Turn compiler messages into a list a caller can act on.
 *
 * `level` follows rustc: `error`, `warning`, `note`, `help`. Only messages that
 * carry a span are listed as items; a spanless `error: could not compile` is a
 * summary, and it is counted separately so it does not pretend to be a location.
 *
 * @param messages - `compiler-message` events.
 * @param options - `{ limit }`, the number of items to return (counts are always total).
 */
export function summarizeDiagnostics(messages, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20
  const items = new Map()
  const counts = { error: 0, warning: 0, note: 0, help: 0, other: 0 }
  const spanless = []
  for (const event of messages) {
    const message = event.message
    const level = String(message.level ?? 'other')
    const text = String(message.message ?? '').split('\n')[0].trim()
    // Cargo's own summary lines are `error`-level and spanless: `aborting due to 3
    // previous errors` and `could not compile …`. Counting them as errors makes a
    // 3-error build report 4, which is exactly the kind of number a reader stops
    // trusting. They are kept as prose, never as counts.
    const isSummary = /^aborting due to\b/.test(text) || /^could not compile\b/.test(text)
    if (!isSummary) {
      if (Object.prototype.hasOwnProperty.call(counts, level)) counts[level] += 1
      else counts.other += 1
    }
    // `failure-note` and the summaries arrive spanless; keep the text.
    if (level !== 'error' && level !== 'warning') {
      if (level === 'failure-note' || level === 'error: internal compiler error') spanless.push(text)
      continue
    }
    if (isSummary) {
      spanless.push(text)
      continue
    }
    const code = message.code && typeof message.code.code === 'string' ? message.code.code : ''
    const span = primarySpan(message)
    if (span === null || !span.file_name) {
      spanless.push((code ? code + ': ' : '') + text)
      continue
    }
    const key = [level, code, text, span.file_name, span.line_start, span.column_start].join('\u0000')
    const existing = items.get(key)
    if (existing !== undefined) {
      existing.repeat += 1
      continue
    }
    items.set(key, {
      level,
      code,
      hint: CODE_HINTS[code] ?? '',
      message: text,
      file: String(span.file_name),
      line: Number(span.line_start ?? 0),
      column: Number(span.column_start ?? 0),
      repeat: 1,
    })
  }
  const ordered = [...items.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  const errorItems = ordered.filter((entry) => entry.level === 'error')
  const warningItems = ordered.filter((entry) => entry.level === 'warning')
  const byCode = {}
  for (const entry of ordered) {
    if (entry.code === '') continue
    byCode[entry.code] = (byCode[entry.code] ?? 0) + 1
  }
  return {
    counts,
    // `errors`/`warnings` are the MESSAGE counts; the arrays are deduplicated items.
    distinct: { errors: errorItems.length, warnings: warningItems.length },
    byCode,
    items: ordered.slice(0, limit),
    shownErrors: errorItems.slice(0, limit),
    shownWarnings: warningItems.slice(0, limit),
    hidden: Math.max(0, ordered.length - limit),
    spanless: spanless.slice(0, 5),
  }
}

/** The first `path:line:col` a diagnostic names, for one-line summaries. */
export function firstLocation(summary) {
  const item = summary.items[0]
  return item === undefined ? '' : item.file + ':' + item.line + ':' + item.column
}

/** A compact `file:line` for a frame or an item, with the workspace prefix trimmed. */
export function shortPath(file, root) {
  const normalized = String(file).replace(/\\/g, '/')
  if (!root) return normalized
  const base = String(root).replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return normalized.startsWith(base) ? normalized.slice(base.length) : normalized
}
