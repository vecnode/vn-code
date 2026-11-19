/**
 * dsh-rust-dev — the six tools, and the prose that is the product.
 *
 * The rule this file follows: an answer is written for the reader that has to
 * decide what to do NEXT, and it carries its conditions with its numbers. So
 * every answer names the command line it ran, whether it was offline, and what it
 * could not see.
 *
 *   - `rust_status` reports the four facts separately, because they fail
 *     separately (see probe.js), and never builds anything;
 *   - `cargo_check` deduplicates diagnostics (one mistake repeated at forty call
 *     sites is ONE mistake), names the code, and returns a bounded list;
 *   - `cargo_test` returns the summary, the failing names, and the first
 *     failure's captured output - the part everyone scrolls for;
 *   - `cargo_build` reports the artifact's real path and size, and only runs the
 *     binary when asked;
 *   - `rust_deps` answers duplicate versions and feature chains;
 *   - `rust_backtrace` says whose code the panic is in.
 */

import fs from 'node:fs'
import path from 'node:path'

import { runArgv } from './cli.js'
import { parseBacktrace, verdictOf, frameLabel } from './backtrace.js'
import { firstLocation, parseJsonStream, shortPath, summarizeDiagnostics } from './diagnostics.js'
import {
  declaredDependencies,
  duplicateVersions,
  featureChain,
  graphOf,
  graphSize,
  mostDependedOn,
} from './metadata.js'
import { COMPONENTS, msrvCheck, rustcFacts, rustupFacts, workspaceFacts } from './probe.js'

/** The output shape every tool returns. */
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
  return refusal('FAILED', error && error.message ? String(error.message) : String(error))
}

/** Defaults and ceilings, in one place, so every answer can state them. */
export const LIMITS = {
  statusTimeoutMs: 30_000,
  checkTimeoutMs: 300_000,
  maxCheckTimeoutMs: 900_000,
  testTimeoutMs: 300_000,
  buildTimeoutMs: 600_000,
  metadataTimeoutMs: 120_000,
  runTimeoutMs: 60_000,
  maxBytes: 4_000_000,
  diagnostics: 20,
}

/** Clamp a requested timeout into the row's ceiling. */
function timeoutOf(args, fallback, ceiling) {
  const asked = Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : fallback
  return Math.min(asked, ceiling)
}

/** The directory this call runs in. */
function cwdOf(deps, args) {
  const raw = typeof args?.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : deps.cwd
  return path.resolve(raw)
}

/** `--offline` unless the caller explicitly asked for the network. */
function offlineArgs(args) {
  return args?.fetch === true ? [] : ['--offline']
}

/** Human bytes. */
function bytesOf(count) {
  if (!Number.isFinite(count) || count < 0) return ''
  if (count < 1024) return count + ' B'
  if (count < 1024 * 1024) return (count / 1024).toFixed(1) + ' KB'
  return (count / (1024 * 1024)).toFixed(1) + ' MB'
}

/** A fixed-width table. */
function table(headers, rows) {
  if (rows.length === 0) return headers.join('  ')
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)))
  const line = (row) => headers.map((header, index) => String(row[index] ?? '').padEnd(widths[index])).join('  ').replace(/\s+$/, '')
  return [line(headers), ...rows.map(line)].join('\n')
}

/** The command line, as it would be pasted. */
export function commandLine(argv) {
  return argv.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

// ---------------------------------------------------------------------------
// The four facts
// ---------------------------------------------------------------------------
/**
 * Gather the four facts plus the workspace, without building.
 *
 * @returns `{ rustc, rustup, workspace, msrv, missing }`.
 */
export async function gatherFacts(deps, cwd) {
  const [rustc, rustup] = await Promise.all([rustcFacts(deps), rustupFacts(deps)])
  const workspace = await workspaceFacts(cwd, deps)
  const msrv = workspace.found && workspace.error === null ? msrvCheck(workspace, rustc) : { declared: '', installed: '', satisfied: null }
  const missing = COMPONENTS.filter((entry) => rustup.present && !rustup.components.some((line) => line === entry.name || line.startsWith(entry.name + ' ')))
  return { rustc, rustup, workspace, msrv, missing }
}

/** The four facts as prose. */
export function factsText(facts, cwd) {
  const lines = []
  const rustc = facts.rustc
  lines.push('TOOLCHAIN')
  if (!rustc.present) {
    lines.push('  rustc: not on PATH - there is no Rust toolchain here.')
    lines.push('  Nothing was built and nothing was installed. Install one with rustup: https://rustup.rs')
    lines.push('  (`rustup toolchain install stable`)')
    return lines.join('\n')
  }
  lines.push('  rustc  ' + (rustc.version || 'version unknown') + (rustc.host ? '  host ' + rustc.host : ''))
  lines.push('  path   ' + (rustc.path || 'not resolved'))
  if (facts.rustup.present) {
    lines.push('  rustup ' + (facts.rustup.toolchain || 'active toolchain not reported'))
  } else {
    lines.push('  rustup not found: components and targets cannot be reported (a distro-installed rustc is fine for building, and has no `rustup component add`)')
  }
  lines.push('')
  lines.push('COMPONENTS')
  if (!facts.rustup.present) {
    lines.push('  unknown (no rustup) - clippy and rustfmt may still be installed by the distribution')
  } else {
    lines.push('  installed: ' + (facts.rustup.components.length === 0 ? '(none reported)' : facts.rustup.components.join(', ')))
    for (const entry of facts.missing) {
      lines.push('  MISSING  ' + entry.name + '  ->  ' + entry.add + '   (' + entry.why + ')')
    }
  }
  lines.push('')
  lines.push('TARGETS')
  if (!facts.rustup.present) lines.push('  unknown (no rustup)')
  else lines.push('  installed: ' + (facts.rustup.targets.length === 0 ? '(none reported)' : facts.rustup.targets.join(', ')))
  lines.push('')
  lines.push('WORKSPACE')
  if (!facts.workspace.found) {
    lines.push('  no Cargo.toml at or above ' + cwd + ' - this is not a cargo project.')
  } else if (facts.workspace.error !== null) {
    lines.push('  ' + facts.workspace.error)
    lines.push('  root: ' + facts.workspace.root)
  } else {
    const workspace = facts.workspace
    lines.push('  root    ' + workspace.root + (workspace.fromCwd ? '   (found above ' + cwd + ')' : ''))
    lines.push('  members ' + workspace.memberCount + (workspace.isWorkspace ? '   (a workspace)' : '   (a single package)') + '   editions ' + (workspace.editions.join(', ') || 'unknown'))
    lines.push('  lock    ' + (workspace.lockfile ? 'Cargo.lock present' : 'no Cargo.lock (a library does not need one)'))
    if (facts.msrv.declared !== '') {
      const verdict = facts.msrv.satisfied === null ? 'cannot compare' : facts.msrv.satisfied ? 'satisfied' : 'NOT satisfied - the toolchain is older than the floor'
      lines.push('  msrv    rust-version ' + facts.msrv.declared + ' vs installed ' + facts.msrv.installed + '  ->  ' + verdict)
    }
    const notable = workspace.notable ?? []
    if (notable.length > 0) {
      lines.push('  notable ' + notable.map((entry) => entry.name + ' ' + entry.req).join('  ·  '))
      for (const entry of notable) {
        if (entry.what) lines.push('          ' + entry.name + ': ' + entry.what)
      }
    }
    if (workspace.members.length > 1) {
      const names = workspace.members.slice(0, 12).map((entry) => entry.name)
      lines.push('  crates  ' + names.join(', ') + (workspace.members.length > 12 ? ', … (' + workspace.members.length + ' total)' : ''))
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build the tools
// ---------------------------------------------------------------------------
/** Build the tools. @param deps - `{ cwd, runner, env, log }`. */
export function buildTools(deps) {
  /** `rust_status`: the four facts, read-only. */
  const status = {
    name: 'rust_status',
    description: [
      'Report the four facts that fail independently on a Rust machine: the TOOLCHAIN (rustc/cargo versions, rup default, host triple), the COMPONENTS (clippy, rustfmt, rust-analyzer - with the exact `rustup component add` for any that are missing), the installed TARGETS, and the WORKSPACE at `cwd` (members, editions, MSRV against the installed toolchain, lockfile, and which notable crates it declares: eframe, egui, wgpu, tokio, tracing, serde, clap, tauri, bevy).',
      'Call this FIRST on a Rust question. It builds nothing, fetches nothing and reads manifests only (`cargo metadata --no-deps --offline`), so it is cheap and safe. A machine with no toolchain is an ANSWER here, not a failure - it names rustup and stops.',
      'Read-only.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { cwd: { type: 'string', description: 'Directory to inspect (default: the workspace root this session runs in).' } },
    },
    output: OUTPUT,
    ...present('Rust status'),
    async execute(args) {
      try {
        const cwd = cwdOf(deps, args)
        const facts = await gatherFacts(deps, cwd)
        const view = {
          ok: facts.rustc.present,
          code: facts.rustc.present ? null : 'NO_TOOLCHAIN',
          toolchain: { version: facts.rustc.version, host: facts.rustc.host, path: facts.rustc.path, rustup: facts.rustup.toolchain },
          components: facts.rustup.components,
          missingComponents: facts.missing.map((entry) => ({ name: entry.name, add: entry.add })),
          targets: facts.rustup.targets,
          workspace: facts.workspace.found
            ? {
                root: facts.workspace.root,
                members: facts.workspace.memberCount,
                editions: facts.workspace.editions,
                lockfile: facts.workspace.lockfile,
                notable: facts.workspace.notable,
                error: facts.workspace.error,
              }
            : { root: null, error: 'no Cargo.toml' },
          msrv: facts.msrv,
        }
        return { text: factsText(facts, cwd), view }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `cargo_check`: diagnostics, parsed and deduplicated. */
  const check = {
    name: 'cargo_check',
    description: [
      'Run `cargo check` (or `cargo clippy`) with `--message-format=json` and return the diagnostics as DATA: counts of errors and warnings, the distinct items with their rustc CODE (E0308 …), their file:line:column, a one-line meaning for the common codes, and how many times each one repeats. The JSON stream is parsed - never the rendered text, which is prose that changes.',
      'Duplicates are collapsed: one type error repeated at forty call sites is listed ONCE with `seen x40`, because a list of forty identical errors hides the four distinct mistakes inside it.',
      'Runs `--offline` by default. Pass `fetch: true` only when a dependency genuinely has to be downloaded - this row does not start network egress on its own. NOTE: `cargo check` RUNS `build.rs` and dependency proc macros on this machine, so it is not a read-only inspection of untrusted code.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Directory to run in (default: the workspace root this session runs in).' },
        want: { type: 'string', enum: ['check', 'clippy'], description: 'check (rustc diagnostics) or clippy (lints, which have names rather than codes). Default check.' },
        package: { type: 'string', description: 'Limit to one workspace member (-p).' },
        features: { type: 'array', items: { type: 'string' }, description: 'Features to enable (--features).' },
        allTargets: { type: 'boolean', description: 'Check tests, benches and examples too (--all-targets).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many distinct items to return (default 20; counts are always total).' },
        fetch: { type: 'boolean', description: 'Allow the network (drops --offline). Default false.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, description: 'Deadline in ms (default 300000, ceiling 900000).' },
      },
    },
    output: OUTPUT,
    ...present('cargo check'),
    async execute(args) {
      try {
        const cwd = cwdOf(deps, args)
        const workspace = await workspaceFacts(cwd, deps)
        if (!workspace.found) return refusal('NO_WORKSPACE', 'No Cargo.toml at or above ' + cwd + '. Point `cwd` at a cargo project (or a member of one).')
        if (workspace.error !== null) return refusal('NO_WORKSPACE', workspace.error)
        const want = args?.want === 'clippy' ? 'clippy' : 'check'
        const argv = ['cargo', want, '--message-format=json', ...offlineArgs(args)]
        if (args?.allTargets === true) argv.push('--all-targets')
        if (typeof args?.package === 'string' && args.package !== '') argv.push('-p', args.package)
        if (Array.isArray(args?.features) && args.features.length > 0) argv.push('--features', args.features.join(','))
        const timeoutMs = timeoutOf(args, LIMITS.checkTimeoutMs, LIMITS.maxCheckTimeoutMs)
        const result = await runArgv(argv, { cwd: workspace.root, timeoutMs, maxBytes: LIMITS.maxBytes })
        const command = commandLine(argv)
        if (result.status === null) {
          return refusal('NO_CARGO', 'Could not start `cargo` (' + (result.error || 'not on PATH') + '). `rust_status` says whether a toolchain exists here.', { command })
        }
        if (result.timedOut) {
          return refusal('TIMEOUT', '`' + command + '` was still running after ' + Math.round(timeoutMs / 1000) + ' s and was killed (the process tree too). A cold build of a large graph is the usual cause: run it once outside, or raise `timeoutMs`.', { command, timeoutMs })
        }
        const parsed = parseJsonStream(result.stdout)
        const summary = summarizeDiagnostics(parsed.messages, { limit: Number.isFinite(args?.limit) ? args.limit : LIMITS.diagnostics })
        const success = parsed.finished !== null ? parsed.finished.success === true : result.status === 0
        // A cargo-level failure (bad flag, missing clippy, unresolvable manifest) has no
        // compiler diagnostics at all; the stderr head is then the whole answer.
        const stderrHead = String(result.stderr ?? '').trim().split('\n').slice(0, 4).join('\n')
        const noCompilerOutput = summary.counts.error === 0 && summary.items.length === 0
        const lines = []
        lines.push('$ ' + command)
        lines.push('in ' + workspace.root + (args?.fetch === true ? '   (network allowed by fetch: true)' : '   (offline)'))
        lines.push('')
        if (noCompilerOutput && !success) {
          lines.push('cargo failed before the compiler produced diagnostics' + (result.truncated ? ' (output truncated)' : '') + ':')
          lines.push('')
          lines.push(stderrHead || '(no stderr)')
          if (want === 'clippy' && /no such command|not installed|component/i.test(stderrHead)) {
            lines.push('')
            lines.push('clippy is probably not installed: `rustup component add clippy`')
          }
          return { text: lines.join('\n'), view: { ok: false, code: 'CARGO_FAILED', command, exit: result.status, stderr: stderrHead } }
        }
        lines.push(
          success
            ? 'RESULT  clean' + (summary.counts.warning > 0 ? ' (with ' + summary.counts.warning + ' warning' + (summary.counts.warning === 1 ? '' : 's') + ')' : '')
            : 'RESULT  ' + summary.counts.error + ' error' + (summary.counts.error === 1 ? '' : 's') + ', ' + summary.counts.warning + ' warning' + (summary.counts.warning === 1 ? '' : 's'),
        )
        lines.push('        ' + summary.distinct.errors + ' distinct error site' + (summary.distinct.errors === 1 ? '' : 's') + ', ' + summary.distinct.warnings + ' distinct warning site' + (summary.distinct.warnings === 1 ? '' : 's') + ' (duplicates collapsed)')
        if (result.truncated) lines.push('        OUTPUT WAS TRUNCATED at ' + bytesOf(LIMITS.maxBytes) + '; later diagnostics are missing - re-run with `package` to narrow it')
        const codes = Object.entries(summary.byCode).sort((a, b) => b[1] - a[1])
        if (codes.length > 0) lines.push('        codes: ' + codes.map(([code, count]) => code + ' x' + count).join(', '))
        if (summary.items.length > 0) {
          lines.push('')
          for (const item of summary.items) {
            const where = shortPath(item.file, workspace.root) + ':' + item.line + ':' + item.column
            const repeat = item.repeat > 1 ? '   (seen x' + item.repeat + ')' : ''
            lines.push('  ' + item.level + (item.code ? '[' + item.code + ']' : '') + ' ' + where + repeat)
            lines.push('    ' + item.message + (item.hint ? '   — ' + item.hint : ''))
          }
          if (summary.hidden > 0) lines.push('  … ' + summary.hidden + ' more distinct site(s) not shown')
        }
        if (summary.spanless.length > 0) {
          lines.push('')
          lines.push('cargo said: ' + summary.spanless.join(' | '))
        }
        lines.push('')
        lines.push('elapsed ' + (result.elapsedMs / 1000).toFixed(1) + ' s, exit ' + result.status)
        return {
          text: lines.join('\n'),
          view: {
            ok: success,
            code: success ? null : 'CHECK_FAILED',
            command,
            offline: args?.fetch !== true,
            errors: summary.counts.error,
            warnings: summary.counts.warning,
            distinct: summary.distinct,
            byCode: summary.byCode,
            items: summary.items,
            hidden: summary.hidden,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
            firstLocation: firstLocation(summary),
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `cargo_test`: the summary, the failing names, the first failure's output. */
  const test = {
    name: 'cargo_test',
    description: [
      'Run `cargo test` and return what a reader scrolls for: the summary (passed/failed/ignored), the NAMES of the failing tests, and the captured stdout of the FIRST failure (`--nocapture` on request shows all of it).',
      'The libtest text is parsed here because cargo does not emit tests as JSON on stable; the numbers are read from the `test result:` lines, which are stable.',
      '`filter` narrows to tests whose name contains it (`cargo test name`), which is the fastest way to reproduce ONE failure. Runs `--offline` by default, and compiling still runs `build.rs` and proc macros.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Directory to run in (default: the workspace root this session runs in).' },
        filter: { type: 'string', description: 'Only tests whose name contains this (passed to cargo test as the filter).' },
        package: { type: 'string', description: 'Limit to one workspace member (-p).' },
        release: { type: 'boolean', description: 'Test the release profile (--release). Use when a failure only happens there.' },
        nocapture: { type: 'boolean', description: 'Do not capture test output (-- --nocapture).' },
        fetch: { type: 'boolean', description: 'Allow the network (drops --offline). Default false.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, description: 'Deadline in ms (default 300000, ceiling 900000).' },
      },
    },
    output: OUTPUT,
    ...present('cargo test'),
    async execute(args) {
      try {
        const cwd = cwdOf(deps, args)
        const workspace = await workspaceFacts(cwd, deps)
        if (!workspace.found) return refusal('NO_WORKSPACE', 'No Cargo.toml at or above ' + cwd + '.')
        if (workspace.error !== null) return refusal('NO_WORKSPACE', workspace.error)
        const argv = ['cargo', 'test', ...offlineArgs(args)]
        if (args?.release === true) argv.push('--release')
        if (typeof args?.package === 'string' && args.package !== '') argv.push('-p', args.package)
        const filter = typeof args?.filter === 'string' ? args.filter : ''
        if (filter !== '') argv.push(filter)
        if (args?.nocapture === true) argv.push('--', '--nocapture')
        const timeoutMs = timeoutOf(args, LIMITS.testTimeoutMs, LIMITS.maxCheckTimeoutMs)
        const result = await runArgv(argv, { cwd: workspace.root, timeoutMs, maxBytes: LIMITS.maxBytes })
        const command = commandLine(argv)
        if (result.status === null) return refusal('NO_CARGO', 'Could not start `cargo` (' + (result.error || 'not on PATH') + ').', { command })
        if (result.timedOut) return refusal('TIMEOUT', '`' + command + '` was killed after ' + Math.round(timeoutMs / 1000) + ' s; a test that hangs (or a cold build) is the usual cause.', { command })
        const summary = parseTestOutput(String(result.stdout ?? '') + '\n' + String(result.stderr ?? ''))
        const ok = result.status === 0
        const lines = []
        lines.push('$ ' + command)
        lines.push('in ' + workspace.root + (args?.fetch === true ? '   (network allowed)' : '   (offline)'))
        lines.push('')
        lines.push(ok ? 'RESULT  all tests passed' : 'RESULT  ' + summary.failed + ' failed, ' + summary.passed + ' passed, ' + summary.ignored + ' ignored')
        if (summary.suites.length > 0) {
          lines.push('')
          for (const suite of summary.suites) {
            lines.push('  ' + (suite.name || 'tests') + ': ' + suite.passed + ' passed, ' + suite.failed + ' failed, ' + suite.ignored + ' ignored')
          }
        }
        if (summary.failing.length > 0) {
          lines.push('')
          lines.push('FAILED')
          for (const name of summary.failing) lines.push('  ' + name)
        }
        if (summary.firstFailure !== '') {
          lines.push('')
          lines.push('FIRST FAILURE OUTPUT')
          lines.push(summary.firstFailure)
        }
        if (!ok && summary.failing.length === 0 && summary.suites.length === 0) {
          const head = String(result.stderr ?? '').trim().split('\n').slice(0, 6).join('\n')
          lines.push('')
          lines.push('cargo failed before any test ran:')
          lines.push(head || '(no output)')
        }
        lines.push('')
        lines.push('elapsed ' + (result.elapsedMs / 1000).toFixed(1) + ' s, exit ' + result.status)
        return {
          text: lines.join('\n'),
          view: {
            ok,
            code: ok ? null : 'TESTS_FAILED',
            command,
            offline: args?.fetch !== true,
            passed: summary.passed,
            failed: summary.failed,
            ignored: summary.ignored,
            failing: summary.failing,
            elapsedMs: result.elapsedMs,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `cargo_build`: the artifact, its real size, and optionally a run. */
  const build = {
    name: 'cargo_build',
    description: [
      'Run `cargo build` (dev or `--release`) and report what came out: success, the artifact PATH, its real size on disk, the warning count, and how long it took. The executable is read from cargo\'s own `compiler-artifact` events (`executable`), not guessed from a path convention.',
      'With `run: true` it then executes that binary with `args` as an ARGV ARRAY, under its own deadline, and returns stdout, stderr and the exit code. That is the ONE call in this row that runs the caller\'s code, and the answer says so.',
      'Runs `--offline` by default. A build runs `build.rs` and dependency proc macros on this machine.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Directory to run in (default: the workspace root this session runs in).' },
        release: { type: 'boolean', description: 'Build the release profile (--release).' },
        package: { type: 'string', description: 'Limit to one workspace member (-p).' },
        bin: { type: 'string', description: 'Which binary to report/run when the package makes several.' },
        run: { type: 'boolean', description: 'Execute the built binary afterwards. Default false.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the binary when run: true (argv, never a shell string).' },
        fetch: { type: 'boolean', description: 'Allow the network (drops --offline). Default false.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, description: 'Build deadline in ms (default 600000, ceiling 900000).' },
      },
    },
    output: OUTPUT,
    ...present('cargo build'),
    async execute(args) {
      try {
        const cwd = cwdOf(deps, args)
        const workspace = await workspaceFacts(cwd, deps)
        if (!workspace.found) return refusal('NO_WORKSPACE', 'No Cargo.toml at or above ' + cwd + '.')
        if (workspace.error !== null) return refusal('NO_WORKSPACE', workspace.error)
        const argv = ['cargo', 'build', '--message-format=json', ...offlineArgs(args)]
        if (args?.release === true) argv.push('--release')
        if (typeof args?.package === 'string' && args.package !== '') argv.push('-p', args.package)
        if (typeof args?.bin === 'string' && args.bin !== '') argv.push('--bin', args.bin)
        const timeoutMs = timeoutOf(args, LIMITS.buildTimeoutMs, LIMITS.maxCheckTimeoutMs)
        const result = await runArgv(argv, { cwd: workspace.root, timeoutMs, maxBytes: LIMITS.maxBytes })
        const command = commandLine(argv)
        if (result.status === null) return refusal('NO_CARGO', 'Could not start `cargo` (' + (result.error || 'not on PATH') + ').', { command })
        if (result.timedOut) return refusal('TIMEOUT', '`' + command + '` was killed after ' + Math.round(timeoutMs / 1000) + ' s (process tree included).', { command })
        const parsed = parseJsonStream(result.stdout)
        const summary = summarizeDiagnostics(parsed.messages, { limit: LIMITS.diagnostics })
        const executables = []
        for (const artifact of parsed.artifacts) {
          if (typeof artifact.executable !== 'string' || artifact.executable === '') continue
          if (executables.includes(artifact.executable)) continue
          executables.push(artifact.executable)
        }
        let size = 0
        for (const file of executables) {
          try {
            size += fs.statSync(file).size
          } catch (error) {
            /* reported below as unknown */
          }
        }
        const ok = parsed.finished !== null ? parsed.finished.success === true : result.status === 0
        const lines = []
        lines.push('$ ' + command)
        lines.push('in ' + workspace.root + (args?.fetch === true ? '   (network allowed)' : '   (offline)'))
        lines.push('')
        if (!ok) {
          lines.push('RESULT  build FAILED' + (summary.counts.error > 0 ? ' - ' + summary.counts.error + ' error(s)' : ''))
          const head = String(result.stderr ?? '').trim().split('\n').slice(0, 6).join('\n')
          if (head !== '') {
            lines.push('')
            lines.push(head)
          }
          if (summary.items.length > 0) {
            lines.push('')
            for (const item of summary.items.slice(0, 8)) {
              lines.push('  ' + item.level + (item.code ? '[' + item.code + ']' : '') + ' ' + shortPath(item.file, workspace.root) + ':' + item.line + ':' + item.column + '  ' + item.message)
            }
          }
          return { text: lines.join('\n'), view: { ok: false, code: 'BUILD_FAILED', command, errors: summary.counts.error, warnings: summary.counts.warning } }
        }
        lines.push('RESULT  built' + (args?.release === true ? ' (release)' : ' (dev)') + ' - ' + summary.counts.warning + ' warning' + (summary.counts.warning === 1 ? '' : 's') + ', ' + (result.elapsedMs / 1000).toFixed(1) + ' s')
        if (executables.length === 0) {
          lines.push('')
          lines.push('No executable was produced: this looks like a library crate. Use `cargo_test`, or build a `--bin`.')
        } else {
          lines.push('')
          for (const file of executables) {
            let bytes = 0
            try {
              bytes = fs.statSync(file).size
            } catch (error) {
              /* unknown */
            }
            lines.push('  ' + file + '  (' + (bytes > 0 ? bytesOf(bytes) : 'size unknown') + ')')
          }
          if (executables.length > 1) lines.push('  (' + executables.length + ' binaries; pass `bin` to choose one for `run`)')
        }
        let runResult = null
        if (args?.run === true) {
          if (executables.length === 0) {
            lines.push('')
            lines.push('`run: true` was asked for, but there is no executable to run.')
          } else if (executables.length > 1 && (typeof args?.bin !== 'string' || args.bin === '')) {
            lines.push('')
            lines.push('`run: true` was asked for, but this build produced ' + executables.length + ' binaries. Pass `bin` to name the one to run; nothing was executed.')
          } else {
            const target = executables[0]
            const runArgvArray = [target, ...(Array.isArray(args?.args) ? args.args.map(String) : [])]
            const ran = await runArgv(runArgvArray, { cwd: workspace.root, timeoutMs: LIMITS.runTimeoutMs, maxBytes: 400_000 })
            runResult = {
              command: commandLine(runArgvArray),
              exit: ran.status,
              stdout: String(ran.stdout ?? ''),
              stderr: String(ran.stderr ?? ''),
              timedOut: ran.timedOut,
              elapsedMs: ran.elapsedMs,
            }
            lines.push('')
            lines.push('RAN  ' + runResult.command + '   (this executes your code)')
            if (ran.timedOut) lines.push('  killed after ' + Math.round(LIMITS.runTimeoutMs / 1000) + ' s')
            lines.push('  exit ' + ran.status + ', ' + (ran.elapsedMs / 1000).toFixed(2) + ' s')
            const out = runResult.stdout.trim()
            const err = runResult.stderr.trim()
            if (out !== '') {
              lines.push('')
              lines.push('stdout:')
              lines.push(out.split('\n').slice(0, 60).join('\n'))
            }
            if (err !== '') {
              lines.push('')
              lines.push('stderr:')
              lines.push(err.split('\n').slice(0, 60).join('\n'))
              if (/panicked at/.test(err)) lines.push('')
              if (/panicked at/.test(err)) lines.push('A panic was printed: `rust_backtrace` reads it properly (whose code the frames are in).')
            }
            if (out === '' && err === '') lines.push('  (no output)')
          }
        }
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            code: null,
            command,
            release: args?.release === true,
            warnings: summary.counts.warning,
            executables,
            bytes: size,
            elapsedMs: result.elapsedMs,
            run: runResult,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `rust_deps`: duplicates, weight, features. */
  const depsTool = {
    name: 'rust_deps',
    description: [
      'Answer the three dependency questions a cargo workspace hides: WHICH CRATE IS COMPILED AT MORE THAN ONE VERSION (with who depends on each copy), WHAT THE WEIGHT IS (the crates the most other crates depend on), and - for one crate with `crate` - WHICH FEATURE CHAIN ENABLED IT (`cargo tree -e features -i`), because features unify across the whole graph and a crate you never named can arrive with defaults on.',
      'Reads `cargo metadata` (the resolved graph) and `cargo tree`; it does not load a crate, and it builds nothing.',
      'Runs `--offline` by default: a resolve needs the registry, so when the lockfile and the local cache cannot answer, the refusal says to pass `fetch: true` rather than downloading quietly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Directory to run in (default: the workspace root this session runs in).' },
        crate: { type: 'string', description: 'Show the feature chain for this crate (cargo tree -e features -i).' },
        duplicatesOnly: { type: 'boolean', description: 'Only the duplicate-version section.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many entries per section (default 10).' },
        fetch: { type: 'boolean', description: 'Allow the network (drops --offline). Default false.' },
      },
    },
    output: OUTPUT,
    ...present('Cargo dependencies'),
    async execute(args) {
      try {
        const cwd = cwdOf(deps, args)
        const workspace = await workspaceFacts(cwd, deps)
        if (!workspace.found) return refusal('NO_WORKSPACE', 'No Cargo.toml at or above ' + cwd + '.')
        if (workspace.error !== null) return refusal('NO_WORKSPACE', workspace.error)
        const argv = ['cargo', 'metadata', '--format-version', '1', ...offlineArgs(args)]
        const result = await runArgv(argv, { cwd: workspace.root, timeoutMs: LIMITS.metadataTimeoutMs, maxBytes: LIMITS.maxBytes })
        const command = commandLine(argv)
        if (result.status !== 0) {
          const stderr = String(result.stderr ?? '').trim()
          const offlineFailure = /offline|network|registry|failed to (load|download|fetch)/i.test(stderr)
          return refusal(
            'NO_RESOLVE',
            '`' + command + '` failed' + (offlineFailure ? ' because the resolve needs the registry and this call was offline' : '') + ':\n' + stderr.split('\n').slice(0, 6).join('\n') + (offlineFailure ? '\n\nPass `fetch: true` to allow the download for this call - this row does not start network egress on its own.' : ''),
            { command },
          )
        }
        let metadata
        try {
          metadata = JSON.parse(String(result.stdout ?? ''))
        } catch (error) {
          return refusal('BAD_METADATA', '`cargo metadata` printed something that is not JSON.')
        }
        const graph = graphOf(metadata)
        const size = graphSize(graph)
        const duplicates = duplicateVersions(graph)
        const heaviest = mostDependedOn(graph, Number.isFinite(args?.limit) ? args.limit : 10)
        const declared = declaredDependencies(metadata)
        const lines = []
        lines.push('$ ' + command)
        lines.push('in ' + workspace.root + '   (' + (args?.fetch === true ? 'network allowed' : 'offline') + ')')
        lines.push('')
        lines.push('GRAPH  ' + size.packages + ' packages, ' + size.edges + ' edges, ' + size.members + ' workspace member(s)')
        lines.push('       ' + declared.size + ' direct dependencies declared by the members')
        if (args?.duplicatesOnly !== true) {
          lines.push('')
          lines.push('MOST DEPENDED ON')
          if (heaviest.length === 0) lines.push('  (nothing beyond the workspace members)')
          for (const entry of heaviest) {
            lines.push('  ' + entry.name + ' ' + entry.version + '  <- ' + entry.dependents + ' dependent(s)' + (entry.sample.length > 0 ? '  e.g. ' + entry.sample.join(', ') : ''))
          }
        }
        lines.push('')
        lines.push('DUPLICATE VERSIONS')
        if (duplicates.length === 0) {
          lines.push('  none: every crate appears at exactly one version')
        } else {
          for (const entry of duplicates) {
            lines.push('  ' + entry.name + '  ' + entry.versions.map((version) => version.version).join(' + '))
            for (const version of entry.versions) {
              lines.push('    ' + version.version + '  used by: ' + (version.usedBy.length === 0 ? '(nothing - unreachable?)' : version.usedBy.join(', ')))
            }
          }
          lines.push('')
          lines.push('  Two versions of one crate are legal and costly: both are compiled, and a type from one is not the type from the other.')
        }
        let features = null
        if (typeof args?.crate === 'string' && args.crate !== '') {
          const treeArgv = ['cargo', 'tree', '-e', 'features', '-i', args.crate, ...offlineArgs(args)]
          const tree = await runArgv(treeArgv, { cwd: workspace.root, timeoutMs: 60_000, maxBytes: 500_000 })
          lines.push('')
          lines.push('FEATURES for ' + args.crate + '   ($ ' + commandLine(treeArgv) + ')')
          if (tree.status !== 0) {
            const why = String(tree.stderr ?? '').trim().split('\n').slice(0, 3).join('\n')
            lines.push('  could not read the feature chain: ' + (why || 'exit ' + tree.status))
            lines.push('  (a crate name that is not in the graph, or an offline resolve that needs the registry)')
          } else {
            features = featureChain(String(tree.stdout ?? ''), 40)
            if (features.features.length > 0) lines.push('  features in play: ' + features.features.join(', '))
            lines.push('')
            for (const line of features.lines) lines.push('  ' + line)
            if (features.truncatedLines > 0) lines.push('  … ' + features.truncatedLines + ' more line(s)')
          }
        }
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            code: null,
            command,
            offline: args?.fetch !== true,
            graph: size,
            duplicates,
            heaviest,
            features: features === null ? null : features.features,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `rust_backtrace`: whose code the panic is in. */
  const backtrace = {
    name: 'rust_backtrace',
    description: [
      'Read a Rust panic or backtrace and say WHOSE CODE it is in. Symbols are demangled (the legacy `_ZN…E` mangling, decoded exactly - no external rustfilt), frames are classified by path into YOUR workspace, a DEPENDENCY (from the registry) or the RUNTIME, and the answer names the first frame in your code, or says plainly that the panic surfaces from a dependency.',
      'Takes the capture as `text`, or reads it from `file`. Enable it with RUST_BACKTRACE=1 (or `full` for every frame) - if the capture has no frames, the answer says so and names that variable rather than inventing a location.',
      'The v0 mangling (`_R…`) is a different grammar and is NOT decoded: those symbols are reported as-is with a count, because a plausible wrong name is worse than an honest one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The captured stderr / panic text.' },
        file: { type: 'string', description: 'Read the capture from this file instead.' },
        root: { type: 'string', description: 'Workspace root used to tell YOUR frames from dependencies (default: the workspace found from cwd).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many frames to show (default 40).' },
        cwd: { type: 'string', description: 'Directory the workspace is found from.' },
      },
    },
    output: OUTPUT,
    ...present('Rust backtrace'),
    async execute(args) {
      try {
        let text = typeof args?.text === 'string' ? args.text : ''
        if (text === '' && typeof args?.file === 'string' && args.file !== '') {
          const file = path.resolve(args.file)
          const stat = fs.statSync(file)
          if (stat.size > 4_000_000) return refusal('TOO_LARGE', file + ' is ' + bytesOf(stat.size) + '; read a slice of it and pass `text`.')
          text = fs.readFileSync(file, 'utf8')
        }
        if (text.trim() === '') return refusal('NO_INPUT', 'Nothing to read: pass `text` (the captured panic) or `file`.')
        let root = typeof args?.root === 'string' && args.root !== '' ? path.resolve(args.root) : ''
        if (root === '') {
          const workspace = await workspaceFacts(cwdOf(deps, args), deps)
          root = workspace.found ? workspace.root : ''
        }
        const parsed = parseBacktrace(text, { root, cwd: root })
        const verdict = verdictOf(parsed)
        const limit = Number.isFinite(args?.limit) ? args.limit : 40
        const byKind = { workspace: [], dependency: [], std: [], unknown: [] }
        for (const frame of parsed.frames) (byKind[frame.kind] ?? byKind.unknown).push(frame)
        const lines = []
        if (parsed.panic !== '') {
          lines.push('PANIC')
          lines.push('  ' + parsed.panic)
          lines.push('')
        }
        lines.push('VERDICT')
        lines.push('  ' + verdict.text)
        if (root !== '') lines.push('  (workspace root used for classification: ' + root + ')')
        lines.push('')
        lines.push('FRAMES  ' + parsed.frames.length + ' total - ' + byKind.workspace.length + ' yours, ' + byKind.dependency.length + ' dependency, ' + byKind.std.length + ' runtime, ' + byKind.unknown.length + ' unknown')
        const show = (title, frames) => {
          if (frames.length === 0) return
          lines.push('')
          lines.push(title)
          for (const frame of frames.slice(0, limit)) {
            lines.push('  ' + String(frame.index).padStart(3, ' ') + '  ' + frameLabel(frame) + (frame.symbol !== frame.name ? '   [' + frame.symbol + ']' : ''))
          }
          if (frames.length > limit) lines.push('  … ' + (frames.length - limit) + ' more')
        }
        show('YOUR CODE', byKind.workspace)
        show('DEPENDENCIES', byKind.dependency)
        if (byKind.workspace.length === 0 && byKind.dependency.length === 0 && byKind.unknown.length > 0) show('UNCLASSIFIED', byKind.unknown)
        if (parsed.note !== '') {
          lines.push('')
          lines.push('NOTE  ' + parsed.note)
        }
        if (parsed.v0Count > 0) {
          lines.push('')
          lines.push('NOTE  ' + parsed.v0Count + ' symbol(s) use the v0 mangling (`_R…`), which this row does not decode; they are shown raw. `cargo install rustfilt` + `rustfilt <name>` decodes them.')
        }
        if (parsed.frames.length === 0) {
          lines.push('')
          lines.push('No frames were present. A backtrace needs RUST_BACKTRACE=1 (or `full`) in the environment of the process that panicked, and debug info (`debug = true` or the default dev profile) in the binary.')
        }
        return {
          text: lines.join('\n'),
          view: {
            ok: parsed.frames.length > 0,
            code: parsed.frames.length === 0 ? 'NO_FRAMES' : null,
            verdict: verdict.kind,
            panic: parsed.panic,
            frames: { total: parsed.frames.length, workspace: byKind.workspace.length, dependency: byKind.dependency.length, std: byKind.std.length },
            firstOwnFrame: verdict.kind === 'workspace' ? { name: verdict.frame.name, file: verdict.frame.file, line: verdict.frame.line } : null,
            v0Symbols: parsed.v0Count,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  return [status, check, test, build, depsTool, backtrace]
}

/**
 * Parse libtest's human output.
 *
 * cargo does not emit test results as JSON on stable, so the text is read - but
 * only its STABLE lines: `test result: <state>. N passed; N failed; N ignored`,
 * `test <name> ... FAILED`, and the `---- <name> stdout ----` blocks.
 *
 * @param text - stdout and stderr together.
 * @returns `{ passed, failed, ignored, suites, failing, firstFailure }`.
 */
export function parseTestOutput(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let passed = 0
  let failed = 0
  let ignored = 0
  const suites = []
  const failing = []
  let currentSuite = ''
  const blocks = new Map()
  let collecting = null
  for (const line of lines) {
    const running = /^\s*Running\s+(.+?)(?:\s+\(|$)/.exec(line)
    if (running !== null) {
      currentSuite = running[1].trim()
      continue
    }
    const result = /^test result:\s*(\w+)\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/.exec(line)
    if (result !== null) {
      const p = Number(result[2])
      const f = Number(result[3])
      const i = Number(result[4])
      passed += p
      failed += f
      ignored += i
      suites.push({ name: currentSuite, passed: p, failed: f, ignored: i })
      collecting = null
      continue
    }
    const failedName = /^test (.+?) \.\.\. FAILED$/.exec(line)
    if (failedName !== null) {
      failing.push(failedName[1])
      continue
    }
    const header = /^---- (.+?) stdout ----$/.exec(line)
    if (header !== null) {
      collecting = header[1]
      blocks.set(collecting, [])
      continue
    }
    if (collecting !== null) {
      if (/^failures:$/.test(line) || /^test result:/.test(line)) {
        collecting = null
        continue
      }
      blocks.get(collecting).push(line)
    }
  }
  let firstFailure = ''
  if (failing.length > 0 && blocks.has(failing[0])) {
    firstFailure = blocks
      .get(failing[0])
      .join('\n')
      .trim()
      .split('\n')
      .slice(0, 40)
      .join('\n')
  }
  return { passed, failed, ignored, suites, failing, firstFailure }
}
