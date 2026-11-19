#!/usr/bin/env node
//  packages/dsh-rust-dev/checks/check-rust-examples.mjs - every fenced example
//  in the shipped skills, compiled.
//
//  The rule the four skills are written to: a ```rust fence is the ENTIRE
//  contents of a `src/lib.rs` in a crate with NO dependencies, compiled offline
//  with `cargo check`. So an example cannot drift into something that used to
//  compile - if it is tagged ```rust, it compiles here or this check fails.
//
//  A fence tagged ```rust,ignore is an illustration that genuinely needs egui,
//  eframe or wgpu, which are not vendored (this package ships no crates). Those
//  are counted, capped, and checked for shape - braces balanced, quotes balanced -
//  and the cap exists so "ignore" cannot quietly become the normal case. Only
//  `rust-ui-apps` may use it, because that is the only skill about APIs this
//  repository cannot compile without adding a dependency.
//
//  ```toml and ```sh fences are read, not run: a toml fragment is not a whole
//  manifest, and running a shell command out of a document is not a check.
//
//  Without cargo this can still count and shape-check every fence, and it SKIPS
//  LOUDLY on the compile half rather than passing silently.
//
//  Run:  node packages/dsh-rust-dev/checks/check-rust-examples.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..')
const failures = []
const notes = []
const fail = (message) => failures.push(message)

const SKILLS = ['rust-workspaces', 'rust-diagnostics', 'rust-debugging', 'rust-ui-apps']
const IGNORE_BUDGET = 6
const IGNORE_ALLOWED_IN = new Set(['rust-ui-apps'])

/**
 * Every fenced block in one document.
 *
 * @param text - the markdown.
 * @returns `[{ info, body, line }]` where `info` is the fence's info string.
 */
export function fencesOf(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const fences = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = /^```(.*)$/.exec(line)
    if (open === null) {
      if (fence !== null) open = { info: fence[1].trim(), line: index + 1, body: [] }
      continue
    }
    if (fence !== null && fence[1].trim() === '') {
      fences.push({ info: open.info, line: open.line, body: open.body.join('\n') })
      open = null
      continue
    }
    open.body.push(line)
  }
  if (open !== null) fences.push({ info: open.info, line: open.line, body: open.body.join('\n'), unclosed: true })
  return fences
}

/** A language from an info string: `rust,ignore` -> `{ lang: 'rust', ignore: true }`. */
function classify(info) {
  const parts = String(info ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  const lang = (parts[0] ?? '').toLowerCase()
  return { lang, ignore: parts.slice(1).some((part) => part === 'ignore' || part === 'no-run' || part === 'norun') }
}

/** Balanced braces, brackets and quotes: the only shape test an uncompiled example can have. */
function shapeOf(body) {
  const counts = { '{': 0, '}': 0, '[': 0, ']': 0, '(': 0, ')': 0 }
  let quotes = 0
  let inLineComment = false
  for (const line of body.split('\n')) {
    inLineComment = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (inLineComment) break
      if (char === '/' && line[index + 1] === '/') {
        inLineComment = true
        break
      }
      if (char === '"' && line[index - 1] !== '\\') quotes += 1
      if (Object.prototype.hasOwnProperty.call(counts, char)) counts[char] += 1
    }
  }
  const balanced = counts['{'] === counts['}'] && counts['['] === counts[']'] && counts['('] === counts[')'] && quotes % 2 === 0
  return { balanced, counts, quotes }
}

// ---------------------------------------------------------------------------
// Read and classify every fence
// ---------------------------------------------------------------------------
const all = []
for (const skill of SKILLS) {
  const file = path.join(pkg, 'skills', skill, 'SKILL.md')
  if (!fs.existsSync(file)) {
    fail('skill file is missing: ' + file)
    continue
  }
  for (const fence of fencesOf(fs.readFileSync(file, 'utf8'))) {
    const { lang, ignore } = classify(fence.info)
    all.push({ skill, lang, ignore, body: fence.body, line: fence.line, unclosed: fence.unclosed === true })
  }
}

for (const fence of all) {
  if (fence.unclosed) fail(fence.skill + ': unclosed code fence at line ' + fence.line)
  if (fence.body.trim() === '') fail(fence.skill + ': empty ' + (fence.lang || '(unlabelled)') + ' fence at line ' + fence.line)
  if (fence.lang === '') fail(fence.skill + ': a fence at line ' + fence.line + ' has no language')
}

const rust = all.filter((fence) => fence.lang === 'rust' && !fence.ignore)
const ignored = all.filter((fence) => fence.lang === 'rust' && fence.ignore)
const toml = all.filter((fence) => fence.lang === 'toml')
const shell = all.filter((fence) => fence.lang === 'sh' || fence.lang === 'bash')

// ---------------------------------------------------------------------------
// The ignore budget
// ---------------------------------------------------------------------------
if (ignored.length > IGNORE_BUDGET) {
  fail('rust,ignore fences: ' + ignored.length + ' is over the budget of ' + IGNORE_BUDGET + ' - an example that does not compile is the exception, not the rule')
}
for (const fence of ignored) {
  if (!IGNORE_ALLOWED_IN.has(fence.skill)) {
    fail(fence.skill + ': a rust,ignore fence at line ' + fence.line + ' - only rust-ui-apps may skip compilation')
  }
  const shape = shapeOf(fence.body)
  if (!shape.balanced) {
    fail(fence.skill + ': rust,ignore fence at line ' + fence.line + ' is not shape-balanced ' + JSON.stringify(shape.counts) + ' quotes=' + shape.quotes)
  }
  if (fence.body.trim().length < 80) {
    fail(fence.skill + ': rust,ignore fence at line ' + fence.line + ' is too small to be an illustration')
  }
}

// ---------------------------------------------------------------------------
// Compile every plain ```rust fence as a whole src/lib.rs
// ---------------------------------------------------------------------------
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
const hasCargo = cargo.status === 0
if (!hasCargo) {
  notes.push('no cargo on this host - ' + rust.length + ' ```rust example(s) were NOT compiled (counted and shape-checked only)')
} else if (rust.length > 0) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rust-dev-examples-'))
  fs.mkdirSync(path.join(work, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(work, 'Cargo.toml'),
    ['[package]', 'name = "dsh-rust-dev-example"', 'version = "0.0.0"', 'edition = "2021"', 'publish = false', '', '[workspace]', ''].join('\n'),
  )
  // One shared target dir: the crates are std-only, so the second compile is warm.
  const env = { ...process.env, CARGO_TARGET_DIR: path.join(work, 'target') }
  let compiled = 0
  for (const fence of rust) {
    fs.writeFileSync(path.join(work, 'src/lib.rs'), fence.body + '\n')
    const run = spawnSync('cargo', ['check', '--offline', '--quiet', '--message-format=short'], {
      cwd: work,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    })
    if (run.status === 0) {
      compiled += 1
      continue
    }
    const why = String(run.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('error') || line.includes('-->'))
      .slice(0, 4)
      .join(' | ')
    fail(fence.skill + ': ```rust at line ' + fence.line + ' does not compile as a src/lib.rs: ' + (why || 'exit ' + run.status))
  }
  notes.push(compiled + '/' + rust.length + ' ```rust example(s) compiled')
  fs.rmSync(work, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('check-rust-examples: the four skills, their fences and their examples')
console.log(
  '  fences: ' + all.length + ' total - ' + rust.length + ' rust, ' + ignored.length + ' rust,ignore, ' + toml.length + ' toml, ' + shell.length + ' shell',
)
for (const note of notes) console.log('  - ' + note)
if (failures.length) {
  console.log(`\ncheck-rust-examples: ${failures.length} problem(s).`)
  for (const message of failures) console.log('  - ' + message)
  process.exit(1)
}
console.log('\ncheck-rust-examples: OK')
