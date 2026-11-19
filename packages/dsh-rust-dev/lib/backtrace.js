/**
 * dsh-rust-dev — a Rust backtrace, read properly.
 *
 * Two things make a raw backtrace useless to a reader:
 *
 *   1. **Mangled names.** `_ZN4core3ptr13drop_in_place17h3f2a…E` is a name only a
 *      linker loves. The legacy mangling is a length-prefixed path, so it can be
 *      decoded exactly - no external `rustfilt` needed. The v0 mangling (`_R…`)
 *      is a different grammar and is NOT decoded here; saying so is better than
 *      producing a plausible wrong name.
 *   2. **Depth.** A panic in `main` still emits sixty frames of `std`. What a
 *      reader needs is which frames are THEIR crate, which are a dependency, and
 *      which are the runtime - so frames are classified by path, and the answer
 *      names the first frame in the workspace.
 *
 * No network, no symbol server, no `addr2line`: the paths are already in the text
 * when debug info is present, and when it is not, the answer says that instead of
 * guessing.
 */

/** Decode the LEGACY Rust mangling (`_ZN…E`). Returns the input unchanged when it is not that. */
export function demangle(symbol) {
  let text = String(symbol ?? '').trim()
  if (text === '') return text
  // A trailing `.llvm.123456` is a thin-LTO suffix, not part of the name.
  const llvm = /\.llvm\.[0-9a-fA-F]+$/.exec(text)
  if (llvm !== null) text = text.slice(0, llvm.index)
  if (!text.startsWith('_ZN')) {
    // v0 mangling is a different grammar: refuse to invent a name for it.
    return text
  }
  if (!text.endsWith('E')) return text
  const body = text.slice(3, -1)
  const segments = []
  let index = 0
  while (index < body.length) {
    const digits = /^[0-9]+/.exec(body.slice(index))
    if (digits === null) return text
    const length = Number.parseInt(digits[0], 10)
    const start = index + digits[0].length
    const segment = body.slice(start, start + length)
    if (segment.length !== length) return text
    segments.push(segment)
    index = start + length
  }
  if (segments.length === 0) return text
  // The last segment is `h<16 hex>`: a disambiguating hash, never a path element.
  const last = segments[segments.length - 1]
  if (/^h[0-9a-f]{16}$/.test(last)) segments.pop()
  const cleaned = segments.map((segment) => segment.replace(/^_+/, '').replace(/^<(.+)>$/, '$1')).filter((segment) => segment !== '')
  return cleaned.length === 0 ? text : cleaned.join('::')
}

/** Is this `_R…` (the v0 mangling this module deliberately does not decode)? */
export function isV0(symbol) {
  return /^_R[A-Za-z0-9_]*$/.test(String(symbol ?? '').trim())
}

/**
 * Resolve a frame's path against the directory the process ran in.
 *
 * Cargo prints crate-relative frames (`.\src\main.rs`) when it can, so a frame is
 * only classifiable after it is made absolute. The `cwd` here is the workspace
 * root when the caller ran cargo there, which is the normal case.
 */
export function resolveFramePath(file, cwd) {
  const raw = String(file ?? '').replace(/\\/g, '/')
  if (raw === '') return ''
  const isAbsolute = /^[A-Za-z]:\//.test(raw) || raw.startsWith('/')
  if (isAbsolute) return raw
  const base = String(cwd ?? '').replace(/\\/g, '/').replace(/\/$/, '')
  if (base === '') return raw.replace(/^\.\//, '')
  return base + '/' + raw.replace(/^\.\//, '')
}

/**
 * Which part of the system a frame belongs to.
 *
 * The distinction that matters: `workspace` frames are the caller's code and the
 * only ones they can change; `dependency` frames are a crate they did not write;
 * `std` frames are the runtime's own unwind machinery.
 */
export function classifyFrame(file, root, cwd) {
  const normalized = resolveFramePath(file, cwd)
  if (normalized === '') return 'unknown'
  const base = root === null || root === undefined ? '' : String(root).replace(/\\/g, '/').replace(/\/$/, '') + '/'
  if (base !== '' && normalized.toLowerCase().startsWith(base.toLowerCase())) return 'workspace'
  if (/\/\.cargo\/registry\/src\//.test(normalized) || /\/registry\/src\//.test(normalized)) return 'dependency'
  if (/\/rustc\/[0-9a-f]+\//.test(normalized) || /\/rustlib\/src\/rust\/library\//.test(normalized) || /\/library\/(std|core|alloc)\//.test(normalized)) return 'std'
  return 'unknown'
}

/**
 * Parse a captured backtrace.
 *
 * A Rust backtrace is a list of `   12: symbol` lines, each optionally followed by
 * `             at path:line:col`. Anything before the first numbered frame is the
 * panic message; a `note: run with RUST_BACKTRACE=1` line means there are no
 * frames to read at all.
 *
 * @param text - the captured stderr (or a file's contents).
 * @param options - `{ root }`, the workspace root used to classify frames.
 * @returns `{ panic, note, frames, truncated, v0Count }`.
 */
export function parseBacktrace(text, options = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const frames = []
  let panic = ''
  let note = ''
  let v0Count = 0
  let current = null
  const framePattern = /^\s*(\d+):\s+(.+?)\s*$/
  // `path:line:col`, and also `path:line` - Rust prints the short form when it has
  // no column (a `cargo run` frame is exactly that: `at .\src\main.rs:5`).
  const atPattern = /^\s+at\s+(.+?)(?::(\d+))(?::(\d+))?\s*$/
  const bareAt = /^\s+at\s+(.+?)\s*$/
  for (const line of lines) {
    if (line.startsWith('thread ') && line.includes('panicked at')) {
      panic = line.trim()
      continue
    }
    if (note === '' && /^note: run with `RUST_BACKTRACE=/.test(line.trim())) {
      note = line.trim()
      continue
    }
    const frame = framePattern.exec(line)
    if (frame !== null) {
      const symbol = frame[2]
      if (isV0(symbol)) v0Count += 1
      current = { index: Number(frame[1]), symbol, name: demangle(symbol), file: '', line: 0, column: 0, kind: 'unknown' }
      frames.push(current)
      continue
    }
    if (current === null) continue
    const at = atPattern.exec(line)
    if (at !== null) {
      current.file = at[1]
      current.line = Number(at[2])
      current.column = at[3] === undefined ? 0 : Number(at[3])
      current.kind = classifyFrame(at[1], options.root, options.cwd ?? options.root)
      continue
    }
    const pathOnly = bareAt.exec(line)
    if (pathOnly !== null) {
      current.file = pathOnly[1]
      current.kind = classifyFrame(pathOnly[1], options.root, options.cwd ?? options.root)
    }
  }
  return { panic, note, frames, truncated: false, v0Count }
}

/**
 * The sentence a reader needs: where it broke, and whose code that is.
 *
 * @param parsed - the result of `parseBacktrace`.
 * @returns `{ kind, frame, text }` where `kind` is `workspace` | `dependency` |
 *   `runtime` | `no-frames`.
 */
export function verdictOf(parsed) {
  const first = parsed.frames.find((frame) => frame.kind === 'workspace')
  if (first !== undefined) {
    return { kind: 'workspace', frame: first, text: 'the first frame in YOUR code is ' + frameLabel(first) }
  }
  const dependency = parsed.frames.find((frame) => frame.kind === 'dependency')
  if (dependency !== undefined) {
    return { kind: 'dependency', frame: dependency, text: 'no frame in your workspace: the panic surfaces from ' + frameLabel(dependency) + ', which is a dependency' }
  }
  if (parsed.frames.length === 0) {
    const why = parsed.note !== '' ? ' the backtrace was not enabled for that run' : ' the binary carries no debug info, or the panic was caught before it printed'
    return { kind: 'no-frames', frame: null, text: 'no frames to read:' + why + '.' }
  }
  return { kind: 'runtime', frame: parsed.frames[0], text: 'every frame is the runtime or unknown: ' + frameLabel(parsed.frames[0]) }
}

/** `crate::module::fn (file:line)` - the label a reader can act on. */
export function frameLabel(frame) {
  if (frame === null || frame === undefined) return ''
  const where = frame.file === '' ? '' : ' (' + frame.file + (frame.line > 0 ? ':' + frame.line : '') + ')'
  return (frame.name || frame.symbol) + where
}
