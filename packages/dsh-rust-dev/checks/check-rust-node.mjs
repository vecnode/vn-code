#!/usr/bin/env node
//  packages/dsh-rust-dev/checks/check-rust-node.mjs - the row's own contract.
//
//  What this proves:
//
//   1. THE SURFACE. Six tools, four skills, one row, and the version in
//      `lib/index.js` still matches `package.json` (the manifest check reads both).
//   2. THE PARSERS, against output CAPTURED from a real cargo on this machine:
//      `cargo check --message-format=json` from a crate that does not compile,
//      `cargo test` from one whose test fails, and a real panic backtrace from one
//      that panics at run time. The fixture crates are committed beside the
//      captures, so the input is reproducible rather than described.
//   3. THE RULES THAT ARE EASY TO LOSE. A cargo summary line (`aborting due to 3
//      previous errors`) is NOT counted as a fourth error; a diagnostic repeated
//      at several call sites is collapsed to one item with a count; a relative
//      frame path from `cargo run` is still recognised as the caller's own code;
//      the v0 mangling is passed through rather than invented.
//   4. THE TOOLS, DRIVEN, on a host that has cargo: `rust_status`, `cargo_check`,
//      `cargo_test` and `rust_backtrace` run against the fixture crates. Without
//      cargo that section SKIPS LOUDLY and exits 0 - a check that cannot run on
//      this host says so, it does not pretend.
//
//  Run:  node packages/dsh-rust-dev/checks/check-rust-node.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..')
const lib = await import(pathToFileURL(path.join(pkg, 'lib/index.js')).href)
const toolsMod = await import(pathToFileURL(path.join(pkg, 'lib/tools.js')).href)
const diag = await import(pathToFileURL(path.join(pkg, 'lib/diagnostics.js')).href)
const meta = await import(pathToFileURL(path.join(pkg, 'lib/metadata.js')).href)
const bt = await import(pathToFileURL(path.join(pkg, 'lib/backtrace.js')).href)
const probe = await import(pathToFileURL(path.join(pkg, 'lib/probe.js')).href)

const failures = []
const notes = []
const fail = (message) => failures.push(message)
function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) fail(name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  return same
}
function ok(name, condition) {
  if (!condition) fail(name)
  return condition
}

const read = (relative) => fs.readFileSync(path.join(here, relative), 'utf8')
const captured = (name) => read(path.join('fixtures', 'captured', name))

// A target dir OUTSIDE the tree: a fixture crate must never grow a target/ inside
// the repository, and the check would otherwise be writing build output.
process.env.CARGO_TARGET_DIR = path.join(os.tmpdir(), 'dsh-rust-dev-check-target')

// ---------------------------------------------------------------------------
// 1. The surface
// ---------------------------------------------------------------------------
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
check('the version in lib/index.js matches package.json', lib.PLUGIN_VERSION, pkgJson.version)
check('the row is named for the package', lib.name, pkgJson.name)
check('six tools are declared', lib.CAPABILITIES.tools.length, 6)
check('four skills are declared', lib.CAPABILITIES.skills.length, 4)
for (const file of lib.SKILL_FILES) {
  const full = path.join(pkg, 'skills', path.basename(path.dirname(file.file)), 'SKILL.md')
  ok('skill file exists: ' + file.name, fs.existsSync(full))
}
const deps = lib.createDeps({ logger: { info() {}, warn() {} } }, { cwd: pkg })
const tools = toolsMod.buildTools(deps)
check('buildTools returns six', tools.length, 6)
const names = tools.map((tool) => tool.name)
check('the tool names are the declared ones', names, lib.CAPABILITIES.tools)
for (const tool of tools) {
  ok(tool.name + ' has a description of some length', typeof tool.description === 'string' && tool.description.length > 80)
  ok(tool.name + ' declares an object schema', tool.parameters && tool.parameters.type === 'object')
  ok(tool.name + ' is executable', typeof tool.execute === 'function')
  ok(tool.name + ' renders text', typeof tool.output?.render === 'function')
}
ok('the activation line points at rust_status rather than claiming a state', lib.activationLine().includes('rust_status'))

// ---------------------------------------------------------------------------
// 2. Diagnostics, from a real failed build
// ---------------------------------------------------------------------------
const brokenRoot = path.join(here, 'fixtures', 'broken-crate')
const checkStream = diag.parseJsonStream(captured('cargo-check.jsonl'))
check('the captured build failed', checkStream.finished?.success, false)
const summary = diag.summarizeDiagnostics(checkStream.messages, { limit: 20 })
check('three type errors, not four (the cargo summary is not an error)', summary.counts.error, 3)
check('three distinct sites', summary.distinct.errors, 3)
check('the code is E0308 everywhere', Object.keys(summary.byCode), ['E0308'])
check('every item carries a location', summary.items.map((item) => item.file.replace(/\\/g, '/')), [
  'src/lib.rs',
  'src/lib.rs',
  'src/lib.rs',
])
check('and a line', summary.items.map((item) => item.line), [6, 12, 13])
ok('the code carries its one-line meaning', summary.items.every((item) => item.hint === 'mismatched types'))
ok('the cargo summary is kept as prose, not as an item', summary.spanless.some((line) => /aborting|For more information|E0308/.test(line)))

// A diagnostic reported twice at the SAME site collapses to one item with a count.
const doubled = [checkStream.messages[0], checkStream.messages[0]]
const deduped = diag.summarizeDiagnostics(doubled, { limit: 20 })
check('a repeated site is one item', deduped.distinct.errors, 1)
check('with a repeat count', deduped.items[0].repeat, 2)
check('and the message count still says two', deduped.counts.error, 2)

// `--message-format=json` interleaves build-script output; one stray line must not
// cost the diagnostics.
const withNoise = diag.parseJsonStream('warning: something a build script printed\n' + captured('cargo-check.jsonl'))
check('noise is counted, diagnostics survive', diag.summarizeDiagnostics(withNoise.messages).counts.error, 3)
check('the noise itself is reported', withNoise.noise.length, 1)

// ---------------------------------------------------------------------------
// 3. Tests, from a real failing run
// ---------------------------------------------------------------------------
const testSummary = toolsMod.parseTestOutput(captured('cargo-test.txt'))
check('one test passed', testSummary.passed, 1)
check('one failed', testSummary.failed, 1)
check('one was ignored', testSummary.ignored, 1)
check('the failing test is named', testSummary.failing, ['tests::fails'])
ok('the first failure output is the captured stdout', testSummary.firstFailure.includes('the fixture prints this line before failing'))
ok('and the assertion message', testSummary.firstFailure.includes('the fixture asserts the wrong sum on purpose'))

// ---------------------------------------------------------------------------
// 4. Backtraces, from a real panic
// ---------------------------------------------------------------------------
// The fixture ran FROM ITS OWN CRATE DIRECTORY, which is how `cargo run` presents
// frames: `.\src\main.rs`, relative. A parser that only understood absolute paths
// would classify the caller's own frame as unknown.
const panicRoot = path.join(here, 'fixtures', 'panic-crate')
const parsedBt = bt.parseBacktrace(captured('backtrace.txt'), { root: panicRoot, cwd: panicRoot })
ok('the panic line was found', parsedBt.panic.includes('panicked at'))
ok('it names the message', captured('backtrace.txt').includes('the fixture panics here on purpose'))
ok('frames were parsed', parsedBt.frames.length > 0)
const verdict = bt.verdictOf(parsedBt)
check('the panic is in the workspace', verdict.kind, 'workspace')
ok('the first own frame is the fixture', verdict.frame.file.replace(/\\/g, '/').endsWith('src/main.rs'))
ok('std frames are the runtime', parsedBt.frames.filter((frame) => frame.kind === 'std').length > 0)
// The same panic captured with RUST_BACKTRACE=full carries addresses and deeper frames.
const fullBt = bt.parseBacktrace(captured('backtrace-full.txt'), { root: panicRoot, cwd: panicRoot })
ok('the full capture parses too', fullBt.frames.length >= parsedBt.frames.length)
check('and still lands in the workspace', bt.verdictOf(fullBt).kind, 'workspace')

// The legacy mangling is a length-prefixed path; decode it exactly.
check('legacy mangling decodes', bt.demangle('_ZN4core3fmt5write17h1234567890abcdefE'), 'core::fmt::write')
check('a nested path decodes', bt.demangle('_ZN12dsh_rust_dev4tool8run_sync17habcdef0123456789E'), 'dsh_rust_dev::tool::run_sync')
check('an unmangled name is left alone', bt.demangle('std::panicking::panic_handler'), 'std::panicking::panic_handler')
check('the v0 mangling is NOT invented', bt.demangle('_RNvNtNtCs1234_4core3fmt5write'), '_RNvNtNtCs1234_4core3fmt5write')
check('a `.llvm.` suffix is stripped before decoding', bt.demangle('_ZN4core3fmt5write17h1234567890abcdefE.llvm.9F2A1B'), 'core::fmt::write')
check('a truncated symbol is refused rather than half-decoded', bt.demangle('_ZN4core3fmt5write17h1234567890abcde'), '_ZN4core3fmt5write17h1234567890abcde')

// ---------------------------------------------------------------------------
// 5. The dependency graph
// ---------------------------------------------------------------------------
const metadata = JSON.parse(captured('cargo-metadata-nodeps.json'))
const graph = meta.graphOf(metadata)
check('the fixture crate is the whole graph', meta.graphSize(graph).packages, 1)
check('no duplicate versions in a one-crate graph', meta.duplicateVersions(graph), [])

// The duplicate logic is a pure function over the metadata SHAPE, so it is tested
// with a shape rather than a captured graph: two versions of one crate, each with
// a known dependent. (A real duplicate needs two registry versions on disk.)
const shape = {
  workspace_members: ['app 0.1.0 (path+file:///w/app)'],
  packages: [
    { id: 'app', name: 'app', version: '0.1.0', source: null, manifest_path: '/w/app/Cargo.toml' },
    { id: 'old', name: 'serde_json', version: '0.9.0', source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: '/r/old/Cargo.toml' },
    { id: 'new', name: 'serde_json', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: '/r/new/Cargo.toml' },
    { id: 't1', name: 'old_dep', version: '0.1.0', source: 'registry+x', manifest_path: '/r/t1/Cargo.toml' },
  ],
  resolve: {
    nodes: [
      { id: 'app', deps: [{ name: 'serde_json', pkg: 'new' }, { name: 'old_dep', pkg: 't1' }] },
      { id: 'old', deps: [] },
      { id: 'new', deps: [] },
      { id: 't1', deps: [{ name: 'serde_json', pkg: 'old' }] },
    ],
  },
}
const shapeGraph = meta.graphOf(shape)
const duplicates = meta.duplicateVersions(shapeGraph)
check('two versions of one crate are found', duplicates.length, 1)
check('the crate is named', duplicates[0].name, 'serde_json')
check('both versions are listed, oldest first', duplicates[0].versions.map((entry) => entry.version), ['0.9.0', '1.0.0'])
check('each version names who uses it', duplicates[0].versions.map((entry) => entry.usedBy), [['old_dep'], ['app']])
const heaviest = meta.mostDependedOn(shapeGraph, 5)
ok('the most-depended-on crate is reported', heaviest.some((entry) => entry.name === 'serde_json'))
check('semver ordering is numeric, not lexical', ['1.0.0', '0.9.0'].sort(meta.compareVersions), ['0.9.0', '1.0.0'])

// Feature chains are cargo tree text: the lines ARE the answer, and the features
// are derived from them.
const chain = meta.featureChain(['serde_json v1.0.0', '├── serde feature "std"', '│   └── serde feature "alloc"', '└── serde_json feature "default"'].join('\n'))
check('features are deduplicated and sorted', chain.features, ['alloc', 'default', 'std'])
check('the lines are kept', chain.lines.length, 4)

// ---------------------------------------------------------------------------
// 6. Skills on disk
// ---------------------------------------------------------------------------
for (const entry of lib.SKILL_FILES) {
  const file = path.join(pkg, 'skills', path.basename(path.dirname(entry.file)), 'SKILL.md')
  const text = fs.readFileSync(file, 'utf8')
  const { meta: front, content } = lib.parseSkillFile(text)
  ok(entry.name + ': has a name in frontmatter', typeof front.name === 'string' && front.name.length > 0)
  ok(entry.name + ': has a description', typeof front.description === 'string' && front.description.length > 40)
  ok(entry.name + ': has a body', content.length > 400)
  ok(entry.name + ': is small enough to load', content.length < 40_000)
}

// ---------------------------------------------------------------------------
// 7. The tools, driven (skipped loudly without cargo)
// ---------------------------------------------------------------------------
const hasCargo = probe.whichSync('cargo', process.env) !== ''
if (!hasCargo) {
  notes.push('no cargo on this host - the driven section (rust_status, cargo_check, cargo_test, rust_backtrace) was SKIPPED')
} else {
  const record = { log: { info() {}, warn() {} } }
  const live = toolsMod.buildTools(lib.createDeps(record, { cwd: brokenRoot }))

  const statusAnswer = await live[0].execute({ cwd: brokenRoot })
  ok('rust_status finds the fixture workspace', statusAnswer.view.workspace.root !== null)
  check('rust_status sees one member', statusAnswer.view.workspace.members, 1)
  ok('rust_status reports the toolchain when there is one', statusAnswer.view.toolchain.version !== '')
  ok('rust_status says where it looked', statusAnswer.text.includes('WORKSPACE'))

  const checkAnswer = await live[1].execute({ cwd: brokenRoot })
  check('cargo_check reports the three errors', checkAnswer.view.errors, 3)
  check('cargo_check is not ok', checkAnswer.view.ok, false)
  ok('cargo_check names the code', Object.keys(checkAnswer.view.byCode).includes('E0308'))
  ok('cargo_check ran offline by default', checkAnswer.view.offline === true)
  ok('cargo_check names the command it ran', checkAnswer.text.includes('cargo check --message-format=json --offline'))
  ok('cargo_check says where', checkAnswer.text.includes('src/lib.rs:6:21'))

  const testAnswer = await live[2].execute({ cwd: path.join(here, 'fixtures', 'failing-test-crate') })
  check('cargo_test reports the failure', testAnswer.view.failed, 1)
  check('cargo_test names the failing test', testAnswer.view.failing, ['tests::fails'])
  ok('cargo_test shows the captured output', testAnswer.text.includes('the fixture prints this line before failing'))

  const btAnswer = await live[5].execute({ text: captured('backtrace.txt'), root: panicRoot })
  check('rust_backtrace lands in the workspace', btAnswer.view.verdict, 'workspace')
  ok('rust_backtrace names the first own frame', btAnswer.text.includes('YOUR CODE'))

  // A backtrace with no frames must say so rather than inventing a location.
  const emptyBt = await live[5].execute({ text: 'thread \'main\' panicked at src/main.rs:1:1:\nboom\n', root: panicRoot })
  check('no frames is an answer, not a crash', emptyBt.view.code, 'NO_FRAMES')
  ok('and it names the variable that enables one', emptyBt.text.includes('RUST_BACKTRACE'))

  // A non-workspace path is a refusal, not a wrong answer.
  const nowhere = await live[0].execute({ cwd: os.tmpdir() })
  ok('rust_status on a non-cargo directory says so', nowhere.view.workspace.root === null || nowhere.view.workspace.error !== undefined)
}

// ---------------------------------------------------------------------------
console.log('check-rust-node: the row, its parsers (captured from real cargo) and its tools')
for (const note of notes) console.log('  - ' + note)
if (failures.length) {
  console.log(`\ncheck-rust-node: ${failures.length} problem(s).`)
  for (const message of failures) console.log('  - ' + message)
  process.exit(1)
}
console.log('\ncheck-rust-node: OK')
