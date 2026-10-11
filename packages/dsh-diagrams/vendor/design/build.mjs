/**
 * dsh-diagrams — the vendored Diagram Design kit.
 *
 * The kit is not an engine. It is the editorial design system behind
 * https://github.com/cathrynlavery/diagram-design (MIT): forty-four visual
 * types, their worked examples as self-contained HTML+inline SVG, the reference
 * documents that describe each type, and the templates the type is built from.
 * `dsh-diagrams` gives the model a third diagram kind (`html`) to author
 * documents like these, and a `diagram_kit` tool to read this kit - so the craft
 * travels with the plugin instead of living in a browser tab.
 *
 * WHY A VENDORED TREE AND NOT A FETCH
 * -----------------------------------
 * The pack starts no network egress of its own (AGENTS.md rule 7), the profile
 * installs bundles as live links (so a package dependency is not installed), and
 * the harness's fetch registry registers EXACT routes (so a hundred files cannot
 * be a hundred routes). Vendoring is therefore the only shape that works - and a
 * vendored tree is only honest if it is verifiable, which is what this script's
 * `--check` is for: every file's bytes and sha256 are recorded in
 * `lib/vendor/design/VERSION.json`, and `--check` re-hashes the tree OFFLINE and
 * fails on the smallest drift.
 *
 * WHAT IT TAKES
 * -------------
 *   assets/example-*.html      every worked example, byte-identical
 *   assets/template*.html      the five templates a new diagram starts from
 *   assets/icons.html          the icon library the primitive-icons reference indexes
 *   assets/index.html          upstream's own gallery page (local browsing of the frame)
 *   references/**              the 62 documents: style-guide, semantic-patterns, primitives,
 *                              animation, output-spec, layout-budget, profiles, 44 type-*.md
 *   SKILL.md                   upstream's selector table (which pattern, which type)
 *   LICENSE, THIRD_PARTY_LICENSES.md
 *   scripts/self_check.py      kept as the contract `lib/html-check.js` ports
 *
 * SOURCE OF RECORD
 * ----------------
 * `SOURCE.json` pins the repository and the COMMIT. The default build downloads
 * that commit's tarball from codeload (the one network touch this repository
 * ever makes for the kit); `--from <dir>` vendors a local checkout instead, so a
 * pin bump can be reviewed before it is downloaded. `--update-pin` moves the pin
 * to the branch head, deliberately and visibly.
 *
 * Usage:
 *   node build.mjs                     vendor the pinned commit into lib/vendor/design
 *   node build.mjs --from <dir>        vendor a local checkout instead of downloading
 *   node build.mjs --check             re-hash the tree offline; fail on drift
 *   node build.mjs --update-pin        set the pin to the branch head, then vendor
 *   node build.mjs --keep              keep the extracted tree (no temp cleanup)
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// here = packages/dsh-diagrams/vendor/design, so the package root is two up.
const pkgRoot = path.dirname(path.dirname(here))
const outDir = path.join(pkgRoot, 'lib', 'vendor', 'design')
const sourceFile = path.join(here, 'SOURCE.json')
const versionFile = path.join(outDir, 'VERSION.json')
const catalogFile = path.join(outDir, 'catalog.json')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const checkOnly = flag('--check')
const updatePin = flag('--update-pin')
const keep = flag('--keep')
const fromDir = value('--from')

/** The upstream tree this build reads, relative to the repository root. */
const UPSTREAM = 'skills/diagram-design'
/** What is copied, as [kind, relative path]. `file` is exact; `prefix`/`glob` are filtered. */
const TAKE = [
  { kind: 'prefix', path: UPSTREAM + '/assets/example-', ext: '.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/template.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/template-full.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/template-dark.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/template-terminal.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/template-motion.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/icons.html', into: 'assets' },
  { kind: 'exact', path: UPSTREAM + '/assets/index.html', into: 'assets' },
  { kind: 'dir', path: UPSTREAM + '/references', into: 'references', ext: '.md' },
  { kind: 'exact', path: UPSTREAM + '/SKILL.md', into: '.' },
  { kind: 'exact', path: UPSTREAM + '/scripts/self_check.py', into: 'scripts' },
  { kind: 'exact', path: 'LICENSE', into: '.' },
  { kind: 'exact', path: 'THIRD_PARTY_LICENSES.md', into: '.' },
]

/** The variant suffixes an example file name may carry, longest first. */
const VARIANTS = ['animated', 'dark', 'full']

function die(message) {
  console.error('[dsh-diagrams/design] ' + message)
  process.exit(1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readSource() {
  if (!existsSync(sourceFile)) die('vendor/design/SOURCE.json is missing')
  return JSON.parse(readFileSync(sourceFile, 'utf8'))
}

/**
 * Normalize a vendored text file's line endings to LF.
 *
 * WHY THIS IS NOT A NO-OP. The upstream tree is mixed: most of it is LF, but a
 * handful of examples were committed with CRLF. `--check` compares BYTES, and a
 * checkout's line endings are governed by `.gitattributes` - so a CRLF file
 * inside a tree with `eol=lf` would be rewritten on checkout and report drift
 * against a commit that has not changed. The pack's rule for every hashed tree
 * (`dsh-pdf`'s vendored tree and the forked client bundles, both in
 * `.gitattributes`) is the same: the stored form is LF, and the checker agrees
 * with the commit rather than with whoever checked it out.
 *
 * Only lone CR bytes are touched, so a file that is already LF keeps its exact
 * bytes - including the ones whose own content uses `\r` deliberately.
 */
function toLf(text) {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : text
}

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir, prefix = '') {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, rel))
    else found.push(rel)
  }
  return found
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------
const source = readSource()

/** Ask the forge for the branch head, so a pin bump is a fact and not a guess. */
function headCommit(repo, branch) {
  const url = 'https://api.github.com/repos/' + repo + '/commits/' + encodeURIComponent(branch)
  const result = spawnSync('curl', ['-fsSL', '-H', 'User-Agent: vncode-dsh-diagrams', url], { encoding: 'utf8' })
  if (result.status !== 0) die('could not ask GitHub for ' + repo + '@' + branch + ': ' + (result.stderr || result.error?.message || 'curl failed'))
  const parsed = JSON.parse(result.stdout)
  if (typeof parsed.sha !== 'string') die('GitHub answered without a sha for ' + repo + '@' + branch)
  return { sha: parsed.sha, date: parsed.commit?.committer?.date ?? null, message: String(parsed.commit?.message ?? '').split('\n')[0] }
}

if (updatePin) {
  if (fromDir) die('--update-pin and --from are mutually exclusive')
  const head = headCommit(source.repo, source.branch ?? 'main')
  const next = { ...source, commit: head.sha, commitDate: head.date, commitSubject: head.message, version: source.version ?? null }
  // The upstream's own declared skill version, read from the pinned SKILL.md.
  const skill = spawnSync('curl', ['-fsSL', '-H', 'User-Agent: vncode-dsh-diagrams', 'https://raw.githubusercontent.com/' + source.repo + '/' + head.sha + '/' + UPSTREAM + '/SKILL.md'], { encoding: 'utf8' })
  if (skill.status === 0) {
    const match = /version:\s*"([^"]+)"/.exec(skill.stdout)
    if (match) next.version = match[1]
  }
  writeFileSync(sourceFile, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log('[dsh-diagrams/design] pin moved to ' + head.sha + ' (' + (head.date ?? 'unknown date') + ') ' + head.message)
}

const pinned = readSource()
if (typeof pinned.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pinned.commit)) die('SOURCE.json pins no commit sha')

// ---------------------------------------------------------------------------
// Reading the upstream tree
// ---------------------------------------------------------------------------
/** Extract the pinned tarball into a temp directory and return its root. */
function fetchPinned() {
  const cache = path.join(here, '.cache')
  mkdirSync(cache, { recursive: true })
  const tarball = path.join(cache, pinned.commit + '.tar.gz')
  if (!existsSync(tarball) || statSync(tarball).size === 0) {
    const url = 'https://codeload.github.com/' + pinned.repo + '/tar.gz/' + pinned.commit
    console.log('[dsh-diagrams/design] downloading ' + url)
    const result = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', tarball, url], { stdio: 'inherit' })
    if (result.status !== 0) die('download failed (curl exit ' + result.status + ')')
  } else {
    console.log('[dsh-diagrams/design] using the cached tarball for ' + pinned.commit.slice(0, 12))
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'dsh-design-'))
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' })
  if (untar.status !== 0) {
    rmSync(work, { recursive: true, force: true })
    die('could not extract the tarball: ' + (untar.stderr || untar.error?.message || 'tar exit ' + untar.status))
  }
  const root = readdirSync(work, { withFileTypes: true }).find((entry) => entry.isDirectory())
  if (!root) die('the tarball held no directory')
  return { root: path.join(work, root.name), cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

/** Read one upstream attempt: `{ root, cleanup, origin }`. */
function openUpstream() {
  if (fromDir) {
    const root = path.resolve(fromDir)
    if (!existsSync(path.join(root, UPSTREAM))) die('--from ' + root + ' does not look like a diagram-design checkout (no ' + UPSTREAM + ')')
    console.log('[dsh-diagrams/design] vendoring from the local checkout ' + root)
    return { root, cleanup: () => {}, origin: 'local checkout ' + root }
  }
  const fetched = fetchPinned()
  return { ...fetched, origin: pinned.repo + '@' + pinned.commit }
}

/** The files this build copies, as `{ from, to }` where `to` is inside lib/vendor/design. */
function collect(root) {
  const picked = []
  for (const rule of TAKE) {
    const sourcePath = path.join(root, rule.path)
    if (rule.kind === 'exact') {
      if (!existsSync(sourcePath)) die('the upstream tree has no ' + rule.path)
      picked.push({ from: sourcePath, to: path.posix.join(rule.into, path.basename(rule.path)) })
      continue
    }
    if (rule.kind === 'prefix') {
      const dir = path.dirname(sourcePath)
      if (!existsSync(dir)) die('the upstream tree has no ' + dir)
      const base = path.basename(rule.path)
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(base) || !name.endsWith(rule.ext)) continue
        picked.push({ from: path.join(dir, name), to: path.posix.join(rule.into, name) })
      }
      continue
    }
    if (rule.kind === 'dir') {
      if (!existsSync(sourcePath)) die('the upstream tree has no ' + rule.path)
      for (const rel of walk(sourcePath)) {
        if (rule.ext && !rel.endsWith(rule.ext)) continue
        // A nested reference keeps its folder, so type-x.md and a future
        // subfolder cannot collide in one flat namespace.
        picked.push({ from: path.join(sourcePath, rel), to: path.posix.join(rule.into, rel) })
      }
    }
  }
  picked.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
  return picked
}

// ---------------------------------------------------------------------------
// The catalog: 44 types, derived from the file names and the pages themselves
// ---------------------------------------------------------------------------
/**
 * The upstream page's own words for one example: its `data-*` free `<title>`,
 * the `.eyebrow`, and the `<h1>`. Read from the FILE rather than from a table
 * written here, so the catalog cannot disagree with what the frame will draw.
 */
function pageFacts(text) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(text)
  const eyebrow = /<p class="eyebrow">([\s\S]*?)<\/p>/i.exec(text)
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)
  const clean = (value) => String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return { title: clean(title?.[1]), eyebrow: clean(eyebrow?.[1]), heading: clean(heading?.[1]) }
}

/** `example-bar-dumbbell-dark` -> `{ type: 'bar-dumbbell', variant: 'dark' }`. */
function splitExample(fileName) {
  const stem = fileName.replace(/^example-/, '').replace(/\.html$/, '')
  for (const variant of VARIANTS) {
    if (stem.endsWith('-' + variant)) return { type: stem.slice(0, -(variant.length + 1)), variant }
  }
  return { type: stem, variant: 'plain' }
}

/** A human title for a type id: `db-schema` -> `DB schema` is handled by the page; this is the fallback. */
function titleFromId(id) {
  return id.replace(/-/g, ' ').replace(/^./, (first) => first.toUpperCase())
}

/** Build `catalog.json` from the copied files (`{ path, bytes, sha256, text }`). */
function buildCatalog(files) {
  const types = new Map()
  for (const file of files) {
    const name = path.posix.basename(file.path)
    if (!name.startsWith('example-')) continue
    const { type, variant } = splitExample(name)
    if (!types.has(type)) types.set(type, { id: type, examples: {}, refs: [], facts: null })
    const entry = types.get(type)
    entry.examples[variant] = { file: 'assets/' + name, bytes: file.bytes, sha256: file.sha256 }
    if (variant === 'plain') entry.facts = pageFacts(file.text)
  }
  for (const file of files) {
    const match = /^references\/type-(.+)\.md$/.exec(file.path)
    if (!match) continue
    const type = match[1]
    if (types.has(type)) types.get(type).refs.push('references/type-' + type + '.md')
  }
  const list = [...types.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.facts?.eyebrow || entry.facts?.heading || entry.facts?.title || titleFromId(entry.id),
      subject: entry.facts?.heading || entry.facts?.title || '',
      variants: Object.keys(entry.examples).sort((a, b) => {
        const order = ['plain', 'full', 'dark', 'animated']
        return order.indexOf(a) - order.indexOf(b)
      }),
      defaultVariant: entry.examples.plain ? 'plain' : Object.keys(entry.examples).sort()[0],
      examples: entry.examples,
      references: entry.refs.sort(),
      // A type reference is what makes a type AUTHORABLE rather than only
      // copyable: the upstream documents 44 of them, and the rest of the keys
      // here are named variants of a documented family (bubble is scatter,
      // marimekko is treemap) or importer demos. Saying which is which is the
      // difference between "pick a look" and "write this kind of diagram".
      documented: entry.refs.length > 0,
      bytes: Object.values(entry.examples).reduce((total, one) => total + one.bytes, 0),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    generated: 'by vendor/design/build.mjs - never hand-edit',
    upstream: { repo: pinned.repo, commit: pinned.commit, version: pinned.version ?? null, license: 'MIT' },
    types: list,
    counts: {
      types: list.length,
      documented: list.filter((entry) => entry.documented).length,
      examples: files.filter((file) => path.posix.basename(file.path).startsWith('example-')).length,
    },
  }
}

// ---------------------------------------------------------------------------
// --check: re-hash the tree offline
// ---------------------------------------------------------------------------
function recordedManifest() {
  if (!existsSync(versionFile)) die('no vendored kit - run: node packages/dsh-diagrams/vendor/design/build.mjs')
  return JSON.parse(readFileSync(versionFile, 'utf8'))
}

if (checkOnly) {
  const recorded = recordedManifest()
  const problems = []
  let bytes = 0
  for (const entry of recorded.files) {
    const full = path.join(outDir, entry.path)
    if (!existsSync(full)) {
      problems.push('missing: ' + entry.path)
      continue
    }
    const current = readFileSync(full)
    bytes += current.byteLength
    if (current.byteLength !== entry.bytes) problems.push('size: ' + entry.path + ' (' + current.byteLength + ' recorded ' + entry.bytes + ')')
    const digest = sha256(current)
    if (digest !== entry.sha256) problems.push('sha256: ' + entry.path)
  }
  const onDisk = walk(outDir).filter((rel) => rel !== 'VERSION.json' && rel !== 'catalog.json')
  const declared = new Set(recorded.files.map((entry) => entry.path))
  for (const rel of onDisk) if (!declared.has(rel)) problems.push('undeclared file: ' + rel)
  if (problems.length > 0) {
    console.error('[dsh-diagrams/design] DRIFT in lib/vendor/design (' + problems.length + ' problem(s)):')
    for (const problem of problems.slice(0, 20)) console.error('  - ' + problem)
    console.error('[dsh-diagrams/design] rebuild with: node packages/dsh-diagrams/vendor/design/build.mjs')
    process.exit(1)
  }
  console.log(
    '[dsh-diagrams/design] up to date: ' +
      recorded.counts.types +
      ' types, ' +
      recorded.counts.examples +
      ' examples, ' +
      recorded.files.length +
      ' files, ' +
      Math.round(bytes / 1024) +
      ' KiB (upstream ' +
      recorded.upstream.repo +
      '@' +
      String(recorded.upstream.commit).slice(0, 12) +
      ')',
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const upstream = openUpstream()
try {
  const picked = collect(upstream.root)
  if (picked.length < 100) die('only ' + picked.length + ' files matched - the upstream layout moved')
  console.log('[dsh-diagrams/design] vendoring ' + picked.length + ' file(s) from ' + upstream.origin)

  // A clean target, so a file this kit no longer takes cannot survive as an
  // orphan that `--check` would then call undeclared.
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const files = []
  let normalized = 0
  for (const file of picked) {
    const raw = readFileSync(file.from)
    const original = raw.toString('utf8')
    const text = toLf(original)
    if (text !== original) normalized += 1
    const bytes = Buffer.from(text, 'utf8')
    const target = path.join(outDir, file.to)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    files.push({ path: file.to, bytes: bytes.byteLength, sha256: sha256(bytes), text })
  }
  if (normalized > 0) console.log('[dsh-diagrams/design] normalized ' + normalized + ' file(s) from CRLF to LF (see NOTICE.md)')

  const catalog = buildCatalog(files)
  writeFileSync(catalogFile, JSON.stringify(catalog, null, 2) + '\n', 'utf8')

  // The motion controller is compared BYTE-FOR-BYTE against a document the model
  // writes, so its hash is recorded beside the tree it came from.
  const motion = files.find((file) => file.path === 'assets/template-motion.html')
  const script = motion ? /<script data-diagram-controls>([\s\S]*?)<\/script>/.exec(motion.text) : null

  const manifest = {
    upstream: {
      repo: pinned.repo,
      branch: pinned.branch ?? 'main',
      commit: pinned.commit,
      commitDate: pinned.commitDate ?? null,
      commitSubject: pinned.commitSubject ?? null,
      version: pinned.version ?? null,
      license: 'MIT',
      url: 'https://github.com/' + pinned.repo,
    },
    directory: 'lib/vendor/design',
    entry: 'catalog.json',
    counts: { ...catalog.counts, files: files.length, normalizedToLf: normalized },
    types: catalog.types.length,
    motion: script ? { script: 'assets/template-motion.html', sha256: sha256(Buffer.from(script[1], 'utf8')), bytes: Buffer.byteLength(script[1], 'utf8') } : null,
    files: files.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest })),
    note: 'GENERATED by vendor/design/build.mjs - never hand-edit lib/vendor/design/. Run build.mjs --check to re-hash offline. Line endings are LF: see NOTICE.md.',
  }
  writeFileSync(versionFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(
    '[dsh-diagrams/design] wrote ' + manifest.files.length + ' files, ' + Math.round(total / 1024) + ' KiB: ' +
      catalog.counts.types + ' example keys (' + catalog.counts.documented + ' with a type reference), ' +
      catalog.counts.examples + ' examples',
  )
  console.log('[dsh-diagrams/design] motion controller sha256 ' + (manifest.motion ? manifest.motion.sha256.slice(0, 16) : 'ABSENT') + ' ...')
} finally {
  if (!keep) upstream.cleanup()
}
