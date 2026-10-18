#!/usr/bin/env node
/**
 * vendor/impeccable/build.mjs — the corpus, copied from ONE pinned commit.
 *
 * dsh-frontend-craft vendors Impeccable's craft corpus (the skill text and its
 * references) under the Apache-2.0 licence. This script is the only thing that
 * writes into the managed trees:
 *
 *   skills/frontend-craft/SKILL.md          assembled: our head + upstream from
 *                                           `## How to design` onward
 *   skills/frontend-craft/reference/**      upstream markdown, path-rewritten
 *   lib/vendor/impeccable/rules.json        the 61-rule registry
 *   lib/vendor/impeccable/LICENSE           Apache-2.0, upstream's own file
 *   lib/vendor/impeccable/NOTICE.md         upstream's third-party notices
 *   lib/vendor/impeccable/VERSION.json      the pin, the transform, every byte
 *
 * It writes nothing else, and `--check` re-hashes the tree offline so a hand
 * edit to a vendored file is a failing check rather than silent drift.
 *
 * Source of truth is the pinned commit's committed DSH payload
 * (`.dsh/skills/impeccable/`), not our own rendering of the source markdown:
 * that payload is what Impeccable publishes for this harness, so re-syncing is
 * a copy plus the transforms below, never a re-implementation of its build.
 *
 * Usage:
 *   node vendor/impeccable/build.mjs                  # fetch the pin, build
 *   node vendor/impeccable/build.mjs --source <dir>   # build from a checkout
 *   node vendor/impeccable/build.mjs --check          # verify, write nothing
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The one pin. Bumping it is: change these, run the build, read the diff. */
export const PIN = {
  repo: 'https://github.com/pbakaus/impeccable',
  commit: '2f46b7a8b059af00d20dd13b64dbe165e7c6a742',
  skillVersion: '4.6.0',
  engineVersion: '0.1.15',
}

/** Where the payload lives inside the pinned tree, and where it lands here. */
const UPSTREAM_SKILL = '.dsh/skills/impeccable'
const SKILL_DIR = 'skills/frontend-craft'
const VENDOR_DIR = 'lib/vendor/impeccable'

/** Our authored head: frontmatter, provenance, the tool-surface table, Setup. */
const HEAD_FILE = 'overrides/SKILL.head.md'

/**
 * The transforms, applied in order to every vendored text file.
 *
 * The rule is mechanical, and that is the point: upstream text stays upstream
 * text except for the strings that would send an agent to a program that is not
 * here. `impeccable <verb>` survives on purpose - SKILL.md's tool-surface table
 * translates it, which is one table to maintain instead of 318 rewritten calls.
 */
export const TRANSFORMS = [
  // The launcher's absolute path becomes the plain verb the table translates.
  [/\.dsh\/skills\/impeccable\/scripts\/impeccable/g, 'impeccable'],
  // Any other reference to the skill folder names the folder we actually ship.
  [/\.dsh\/skills\/impeccable/g, SKILL_DIR],
  // The artifacts root is ours, so a run cannot collide with a real Impeccable.
  [/\.impeccable\//g, '.frontend-craft/'],
  // The provenance stamp is our schema's name now.
  [/impeccable:product-schema/g, 'frontend-craft:product-schema'],
]

/** The placeholder tokens a rendered payload must not contain. */
const PLACEHOLDERS = ['{{model}}', '{{config_file}}', '{{ask_instruction}}', '{{command_prefix}}', '{{available_commands}}', '{{scripts_path}}', '{{reference_path}}']

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const cacheDir = path.join(here, '.cache')

function fail(message) {
  console.error('build: ' + message)
  process.exit(1)
}

/** Read text as UTF-8 with LF endings and no BOM, so hashes are platform-free. */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Every file under a directory, as POSIX paths relative to it. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full).map((inner) => entry.name + '/' + inner))
    else if (entry.isFile()) out.push(entry.name)
  }
  return out
}

/**
 * The pinned source tree: a checkout when one is named, the cached tarball
 * otherwise. The cache is an INPUT (`.cache/` is gitignored); the bytes it
 * produces are committed, so a fresh clone reads the tree without a toolchain.
 */
async function ensureSource(sourceArg) {
  if (sourceArg) {
    const resolved = path.resolve(sourceArg)
    if (!existsSync(path.join(resolved, UPSTREAM_SKILL))) fail('no ' + UPSTREAM_SKILL + ' in ' + resolved)
    return resolved
  }
  const extractDir = path.join(cacheDir, 'src-' + PIN.commit)
  if (existsSync(path.join(extractDir, UPSTREAM_SKILL))) return extractDir
  const tarball = path.join(cacheDir, PIN.commit + '.tar.gz')
  mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(tarball)) {
    const url = 'https://codeload.github.com/pbakaus/impeccable/tar.gz/' + PIN.commit
    console.log('build: fetching ' + url)
    const answer = await fetch(url)
    if (!answer.ok) fail('fetch failed: HTTP ' + answer.status + ' for ' + url)
    writeFileSync(tarball, Buffer.from(await answer.arrayBuffer()))
  }
  mkdirSync(extractDir, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir, '--strip-components', '1'], { stdio: 'inherit' })
  if (!existsSync(path.join(extractDir, UPSTREAM_SKILL))) fail('the pinned tarball has no ' + UPSTREAM_SKILL)
  return extractDir
}

/** The upstream command table, parsed so a rename cannot silently drop a row. */
function commandRows(tail) {
  const rows = []
  for (const line of tail.split('\n')) {
    const match = /^\|\s*`([a-z]+)[^`]*`\s*\|/.exec(line)
    if (match) rows.push(match[1])
  }
  return rows
}

export function build(sourceDir) {
  const payload = path.join(sourceDir, UPSTREAM_SKILL)
  const rewritten = (text) => {
    let out = text
    for (const [pattern, replacement] of TRANSFORMS) out = out.replace(pattern, replacement)
    for (const token of PLACEHOLDERS) {
      if (out.includes(token)) fail('the pinned payload still carries ' + token + ' (upstream build incomplete)')
    }
    return out
  }

  // ---- SKILL.md: our head, then upstream from `## How to design` on ----------
  const upstreamSkill = readText(path.join(payload, 'SKILL.md'))
  const join = upstreamSkill.indexOf('\n## How to design')
  if (join < 0) fail('upstream SKILL.md has no "## How to design" section to join at')
  let tail = upstreamSkill.slice(join + 1)
  // Pin/Unpin, Hooks and Doctor are the three engine-only maintenance paragraphs;
  // the tool-surface table owns that ground here.
  const maintenance = tail.indexOf('\n**Pin / Unpin:**')
  if (maintenance >= 0) tail = tail.slice(0, maintenance).trimEnd() + '\n'
  const head = readText(path.join(here, HEAD_FILE))
  const skillText = head.trimEnd() + '\n\n' + rewritten(tail)
  const rows = commandRows(tail)
  if (rows.length < 24) fail('the upstream command table lost rows: found ' + rows.length)
  write(path.join(packageRoot, SKILL_DIR, 'SKILL.md'), skillText)

  // ---- the references, copied whole -----------------------------------------
  const refRoot = path.join(payload, 'reference')
  const refFiles = walk(refRoot).filter((name) => name.endsWith('.md'))
  if (refFiles.length < 40) fail('expected at least 40 references, found ' + refFiles.length)
  for (const name of refFiles) {
    write(path.join(packageRoot, SKILL_DIR, 'reference', name), rewritten(readText(path.join(refRoot, name))))
  }

  // ---- registry, licence, notices -------------------------------------------
  const rulesSrc = path.join(sourceDir, 'crates', 'live', 'assets', 'antipatterns.json')
  const rules = JSON.parse(readText(rulesSrc))
  if (!Array.isArray(rules) || rules.length !== 61) fail('the registry is not 61 rules (found ' + (Array.isArray(rules) ? rules.length : 'not an array') + ')')
  write(path.join(packageRoot, VENDOR_DIR, 'rules.json'), JSON.stringify(rules, null, 2) + '\n')
  write(path.join(packageRoot, VENDOR_DIR, 'LICENSE'), readText(path.join(sourceDir, 'LICENSE')))
  write(path.join(packageRoot, VENDOR_DIR, 'NOTICE.md'), readText(path.join(sourceDir, 'NOTICE.md')))

  // ---- VERSION.json: the pin, the transform, every byte ----------------------
  const managed = []
  const skillRootAbs = path.join(packageRoot, SKILL_DIR)
  for (const name of walk(skillRootAbs)) managed.push(SKILL_DIR + '/' + name)
  for (const name of ['rules.json', 'LICENSE', 'NOTICE.md']) managed.push(VENDOR_DIR + '/' + name)
  managed.sort()
  const files = {}
  for (const rel of managed) {
    const buffer = readFileSync(path.join(packageRoot, rel))
    files[rel] = { bytes: buffer.length, sha256: sha256(buffer) }
  }
  // The engine artifacts are built by build-engine.mjs, not by this script; they
  // are recorded here so ONE file describes every vendored byte.
  const engineDir = path.join(packageRoot, VENDOR_DIR, 'detect')
  const engine = {}
  if (existsSync(engineDir)) {
    for (const name of readdirSync(engineDir).sort()) {
      const file = path.join(engineDir, name)
      if (!statSync(file).isFile()) continue
      const buffer = readFileSync(file)
      engine['detect/' + name] = { bytes: buffer.length, sha256: sha256(buffer) }
    }
  }
  const version = {
    upstream: { ...PIN, payload: UPSTREAM_SKILL },
    transform: {
      applied: TRANSFORMS.map(([pattern, replacement]) => pattern.source + ' -> ' + replacement),
      assembled: 'SKILL.md = ' + HEAD_FILE + ' + upstream from "## How to design" (the three engine-only maintenance paragraphs dropped)',
      commandRows: rows,
    },
    excluded: {
      'scripts/': 'the engine launcher, the in-page live JS and the font index: none is used here (the detector is the wasm build; live mode is unavailable)',
      'agents/': 'the provider sub-agent definitions: DSH has no such surface',
    },
    engine: { build: 'vendor/impeccable/build-engine.mjs', artifacts: engine },
    files,
  }
  write(path.join(packageRoot, VENDOR_DIR, 'VERSION.json'), JSON.stringify(version, null, 2) + '\n')

  let bytes = 0
  for (const entry of Object.values(files)) bytes += entry.bytes
  for (const entry of Object.values(engine)) bytes += entry.bytes
  console.log('build: ' + Object.keys(files).length + ' corpus files + ' + Object.keys(engine).length + ' engine artifacts, ' + (bytes / 1048576).toFixed(2) + ' MB, ' + rows.length + ' commands, ' + rules.length + ' rules')
}

/**
 * Re-hash the managed trees against VERSION.json.
 *
 * @returns `{ problems, listed, version }` - `problems` is empty when every
 *   vendored byte still matches, and names each file that does not.
 */
export function verify() {
  const versionFile = path.join(packageRoot, VENDOR_DIR, 'VERSION.json')
  if (!existsSync(versionFile)) return { problems: ['VERSION.json is missing - run the build'], listed: 0, version: null }
  const version = JSON.parse(readText(versionFile))
  const problems = []
  const listed = new Set()
  const verifyOne = (rel, entry) => {
    const file = path.join(packageRoot, rel)
    if (!existsSync(file)) {
      problems.push('missing: ' + rel)
      return
    }
    const buffer = readFileSync(file)
    if (buffer.length !== entry.bytes) problems.push('size changed: ' + rel + ' (' + buffer.length + ' != ' + entry.bytes + ')')
    else if (sha256(buffer) !== entry.sha256) problems.push('bytes changed: ' + rel)
    listed.add(rel)
  }
  for (const [rel, entry] of Object.entries(version.files)) verifyOne(rel, entry)
  for (const [rel, entry] of Object.entries(version.engine.artifacts)) verifyOne(VENDOR_DIR + '/' + rel, entry)

  // Anything in a managed tree that VERSION.json does not name is drift too.
  const managed = []
  for (const name of walk(path.join(packageRoot, SKILL_DIR))) managed.push(SKILL_DIR + '/' + name)
  for (const name of readdirSync(path.join(packageRoot, VENDOR_DIR))) {
    const rel = VENDOR_DIR + '/' + name
    if (statSync(path.join(packageRoot, rel)).isFile() && name !== 'VERSION.json' && !name.endsWith('.mjs')) managed.push(rel)
  }
  for (const rel of managed) if (!listed.has(rel)) problems.push('not in VERSION.json: ' + rel)
  return { problems, listed: listed.size, version }
}

function check() {
  const { problems, listed, version } = verify()
  if (problems.length > 0) {
    for (const problem of problems) console.error('check: ' + problem)
    process.exit(1)
  }
  console.log('check: ' + listed + ' vendored files match ' + version.upstream.repo + '@' + version.upstream.commit.slice(0, 7))
}

// Only act when run as a program: the package check imports `verify()` above.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const args = process.argv.slice(2)
  if (args.includes('--check')) {
    check()
  } else {
    const sourceAt = args.indexOf('--source')
    build(await ensureSource(sourceAt >= 0 ? args[sourceAt + 1] : undefined))
  }
}
