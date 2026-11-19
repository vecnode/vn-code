/**
 * dsh-rust-dev — the four facts that fail independently.
 *
 * "Rust is broken on this machine" is almost never one thing. It is one of:
 *
 *   - the TOOLCHAIN: no `cargo`, or a `rustup` default that is not the one you
 *     think (a project pinning a toolchain file silently switches it);
 *   - the COMPONENTS: `clippy` or `rustfmt` were never added, so the answer rests
 *     on a tool that is not there;
 *   - the TARGETS: a cross-compile to a triple nobody added fails at link time
 *     with an error that names the linker, not the missing target;
 *   - the WORKSPACE: no `Cargo.toml` here, or one whose `rust-version` is above
 *     the installed toolchain.
 *
 * They fail independently, so they are reported independently - the shape
 * `dsh-sql-server` uses for server/client/port/driver, for the same reason.
 *
 * Nothing here builds. Every fact comes from a version probe, `rustup component
 * list`, or `cargo metadata --no-deps`, which reads manifests only: no registry,
 * no network, no compilation.
 */

import fs from 'node:fs'
import path from 'node:path'

import { runArgv, versionLine } from './cli.js'

/** Crates worth naming when a workspace declares them, because they change the advice. */
export const NOTABLE = {
  eframe: 'an eframe app (egui desktop shell)',
  egui: 'egui immediate-mode UI',
  wgpu: 'wgpu: a GPU backend you own',
  winit: 'winit: the window/event loop under an egui app',
  tokio: 'tokio async runtime',
  tracing: 'tracing: structured spans rather than println!',
  serde: 'serde: derive-heavy, a big compile-time cost',
  clap: 'clap: a CLI',
  tauri: 'Tauri: a webview app, not egui',
  bevy: 'bevy: an ECS game/app engine',
  criterion: 'criterion benchmarks',
}

/** Walk up from `start` looking for a directory that holds a `Cargo.toml`. */
export function findManifest(start) {
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, 'Cargo.toml')
    if (fs.existsSync(candidate)) return { root: current, manifest: candidate }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Is a program on PATH? No shell, no `where`/`which` child: PATHEXT is the rule on Windows. */
export function whichSync(name, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? ''
  const segments = pathValue.split(path.delimiter).filter((entry) => entry !== '')
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((ext) => ext.toLowerCase()) : ['']
  for (const segment of segments) {
    for (const ext of exts) {
      const candidate = path.join(segment, name + ext)
      try {
        const stat = fs.statSync(candidate)
        if (stat.isFile()) return candidate
      } catch (error) {
        /* not here */
      }
    }
  }
  return ''
}

/** `rustc --version --verbose`, as `{ version, host, commit, raw }`. */
export async function rustcFacts(deps) {
  const result = await runArgv(['rustc', '--version', '--verbose'], { timeoutMs: 15_000, maxBytes: 64_000 })
  if (result.status === null) return { present: false, path: whichSync('rustc', deps.env) }
  const text = String(result.stdout ?? '')
  const pick = (name) => {
    const match = new RegExp('^' + name + ':\\s*(.+)$', 'm').exec(text)
    return match ? match[1].trim() : ''
  }
  return {
    present: true,
    path: whichSync('rustc', deps.env),
    version: pick('release'),
    host: pick('host'),
    commit: pick('commit-hash'),
    raw: text.trim(),
  }
}

/**
 * The installed components and targets, from rustup.
 *
 * `rustup` is asked rather than guessed from the filesystem: a component can be
 * installed for one toolchain and missing for another, and only rustup knows
 * which toolchain is the default.
 */
export async function rustupFacts(deps) {
  const components = await runArgv(['rustup', 'component', 'list', '--installed'], { timeoutMs: 20_000, maxBytes: 200_000 })
  const targets = await runArgv(['rustup', 'target', 'list', '--installed'], { timeoutMs: 20_000, maxBytes: 200_000 })
  const show = await runArgv(['rustup', 'show', 'active-toolchain'], { timeoutMs: 20_000, maxBytes: 64_000 })
  const lines = (result) =>
    String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('info:'))
  if (components.status === null) {
    return { present: whichSync('rustup', deps.env) !== '', components: [], targets: [], toolchain: '' }
  }
  return {
    present: true,
    components: lines(components),
    targets: lines(targets),
    toolchain: String(show.stdout ?? '').trim().split('\n')[0] ?? '',
  }
}

/** The components the advice depends on, and the command that adds each. */
export const COMPONENTS = [
  { name: 'clippy', add: 'rustup component add clippy', why: 'cargo_check want:"clippy"' },
  { name: 'rustfmt', add: 'rustup component add rustfmt', why: 'formatting, and `cargo fmt --check` in CI' },
  { name: 'rust-analyzer', add: 'rustup component add rust-analyzer', why: 'the editor/agent language server (this row does not drive it)' },
]

/**
 * The workspace, from `cargo metadata --no-deps`.
 *
 * `--no-deps` is the point: it reads the manifests and stops. A resolve would
 * want the registry, and a workspace on a machine with no network would then
 * report "no workspace" for a workspace that is right there.
 */
export async function workspaceFacts(cwd, deps) {
  const found = findManifest(cwd)
  if (found === null) {
    return { found: false, cwd }
  }
  const lock = path.join(found.root, 'Cargo.lock')
  const base = {
    found: true,
    root: found.root,
    manifest: found.manifest,
    lockfile: fs.existsSync(lock),
    fromCwd: path.resolve(cwd) !== found.root,
  }
  const result = await runArgv(['cargo', 'metadata', '--no-deps', '--format-version', '1', '--offline'], {
    cwd: found.root,
    timeoutMs: 60_000,
    maxBytes: 8_000_000,
  })
  if (result.status === null) {
    return { ...base, error: 'cargo is not on PATH, so the manifests were not read' }
  }
  if (result.status !== 0) {
    const why = String(result.stderr ?? '').trim().split('\n').slice(0, 3).join(' ')
    return { ...base, error: 'cargo metadata failed: ' + (why || 'exit ' + result.status) }
  }
  let data
  try {
    data = JSON.parse(String(result.stdout ?? ''))
  } catch (error) {
    return { ...base, error: 'cargo metadata printed something that is not JSON' }
  }
  const members = new Set(data.workspace_members ?? [])
  const packages = Array.isArray(data.packages) ? data.packages.filter((entry) => members.has(entry.id)) : []
  const declared = new Map()
  for (const entry of packages) {
    for (const dep of entry.dependencies ?? []) {
      const name = String(dep.name ?? '')
      if (name === '') continue
      if (declared.has(name)) continue
      declared.set(name, { name, req: String(dep.req ?? ''), kind: dep.kind ?? null })
    }
  }
  const notable = Object.keys(NOTABLE)
    .filter((name) => declared.has(name))
    .map((name) => ({ name, req: declared.get(name).req, what: NOTABLE[name] }))
  const editions = [...new Set(packages.map((entry) => entry.edition ?? '').filter(Boolean))]
  const rustVersions = [...new Set(packages.map((entry) => entry.rust_version ?? '').filter(Boolean))]
  return {
    ...base,
    error: null,
    memberCount: packages.length,
    members: packages.map((entry) => ({ name: entry.name, version: entry.version, kind: entry.targets?.[0]?.kind?.[0] ?? '' })),
    editions,
    rustVersions,
    targetDirectory: String(data.target_directory ?? ''),
    notable,
    isWorkspace: packages.length > 1,
  }
}

/**
 * Compare a declared `rust-version` with the installed `rustc`.
 *
 * @returns `{ declared, installed, satisfied }`, with `satisfied` null when it
 *   cannot be decided (no declared floor, or an unparseable version).
 */
export function msrvCheck(workspace, rustc) {
  const declared = workspace.rustVersions?.[0] ?? ''
  const installed = rustc.version ?? ''
  if (declared === '' || installed === '') return { declared, installed, satisfied: null }
  const parse = (value) => String(value).split(/[.\-+ ]/).slice(0, 3).map((part) => Number.parseInt(part, 10))
  const [major, minor] = parse(declared)
  const [haveMajor, haveMinor] = parse(installed)
  if (!Number.isFinite(major) || !Number.isFinite(haveMajor)) return { declared, installed, satisfied: null }
  const satisfied = haveMajor > major || (haveMajor === major && (haveMinor ?? 0) >= (minor ?? 0))
  return { declared, installed, satisfied }
}
