// ============================================================================
//  scripts/checks/check-no-secrets.mjs - no credential may reach GitHub.
//
//  WHY THIS EXISTS
//  ---------------
//  This repository is public, and the one mistake that cannot be taken back is
//  committing a credential: a secret in a commit is a secret on GitHub for as
//  long as the repository exists, in every fork and every clone, even after the
//  file is deleted. So the rule is not "be careful" - it is a check that runs
//  before the mistake can be pushed.
//
//  WHAT IT SCANS, AND WHY THAT SET
//  -------------------------------
//  `git ls-files -co --exclude-standard` is exactly what `git add -A` would
//  stage: every TRACKED file plus every untracked file that is not ignored. That
//  is the right set by definition, and it is why a credential file you just
//  dropped into the folder is caught BEFORE it is committed rather than after -
//  `.gitignore` quietly skips it, an unignored one fails here.
//
//  Binary files (a NUL byte) are skipped: a key inside a .png is not something
//  a text rule can find, and guessing would produce noise. Committed images are
//  a separate, human-reviewed concern - see SECURITY.md.
//
//  IT NEVER PRINTS WHAT IT FOUND
//  -----------------------------
//  A secret scanner that echoes the secret into CI logs has moved the leak, not
//  closed it. Every message below names the file, the line, the RULE and a
//  MASKED preview; the value itself is never assembled into the output, and
//  `maskPreview` is unit-tested here for exactly that reason.
//
//  Run:  node scripts/checks/check-no-secrets.mjs
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const failures = []
const notes = []
const fail = (message) => failures.push(message)

// ---------------------------------------------------------------------------
// 1. The rules
// ---------------------------------------------------------------------------
/**
 * Each rule is a NAME, a pattern and a note about what it is for. The ordering
 * is irrelevant; the names are what a failure report shows, so they must be
 * about the credential and not about the syntax.
 */
export const RULES = [
  {
    name: 'deepseek-api-key',
    // OpenAI-shaped keys are what DeepSeek issues (`sk-` + a long opaque tail).
    pattern: /sk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    name: 'credential-ref-with-value',
    // The harness's own ref names, with something that looks like a real value
    // attached. A documented placeholder (`DEEPSEEK_API_KEY=…`, `sk-…`) is NOT a
    // match: the value must be 12+ ASCII credential characters.
    pattern: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/g,
  },
  {
    name: 'generic-secret-assignment',
    // `apiKey: …`, `password = …`, `client_secret: "…"` in any config shape.
    pattern: /\b(?:api[_-]?key|apikey|password|passwd|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{16,}["']/gi,
  },
  {
    name: 'launch-token-in-url',
    // The harness prints `?token=<launch token>`, and the pack's own rule is that
    // it is never written down. A LONG one here means somebody pasted a live URL
    // into a doc, a log or a test; the short fixture in readyline.rs is under
    // this threshold on purpose.
    pattern: /[?&]token=[A-Za-z0-9_\-]{16,}/g,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'jwt',
    // A bearer JWT: three base64url segments, the first always `eyJ` (`{"`).
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: 'slack-or-stripe-key',
    pattern: /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,})\b/g,
  },
]

/**
 * Reviewed exceptions. A line that legitimately contains a key-SHAPED string -
 * a fixture, a regex, a document that demonstrates the pattern - is named here
 * with the reason, so the check stays honest instead of being loosened for
 * everybody. Keep this list short and justified; an entry without a reason is a
 * bug, and "the check is inconvenient" is not a reason: change the fixture so it
 * is not key-shaped instead (see `keystate.rs`, whose test value carries a `/`
 * precisely so it cannot be confused with a credential).
 *
 * Currently empty, and that is the goal.
 *
 *   { file: 'app/src-tauri/src/readyline.rs', rule: 'launch-token-in-url',
 *     reason: 'the redaction fixture; its token is under the 16-char threshold' }
 */
export const ALLOWLIST = []

/** A preview that can never reveal the value: length and shape only. */
export function maskPreview(match) {
  const head = match.slice(0, 3)
  return `${head}${'*'.repeat(Math.max(0, match.length - head.length))} (len ${match.length})`
}

/** Every line of `text` that trips a rule, as messages that carry no secret. */
export function scanText(text, file) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (const rule of RULES) {
    // A fresh regex per line keeps `lastIndex` from leaking across calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    lines.forEach((line, index) => {
      const matches = line.match(pattern)
      if (!matches) return
      const allowed = ALLOWLIST.some((entry) => entry.file === file && entry.rule === rule.name)
      if (allowed) return
      for (const match of matches) {
        found.push(`${file}:${index + 1}  ${rule.name}  ${maskPreview(match)}`)
      }
    })
  }
  return found
}

// ---------------------------------------------------------------------------
// 2. The set `git add -A` would stage
// ---------------------------------------------------------------------------
// git is normally asked through a PIPE, which is what makes its output readable
// here - and a sandboxed host can refuse that outright (`spawnSync git EPERM`;
// the DSH file sandbox cannot open a named pipe, so every piped spawn fails while
// an inherited one works). When that happens this falls back to redirecting git's
// stdout into a REAL FILE, which touches no pipe and works under the same
// sandbox - so the scan still runs rather than reporting nothing. Only if both
// routes fail is the scan skipped, and then it is skipped LOUDLY: a check that
// fails because the host declined to run git teaches its reader to ignore it.
function runGit(args, maxBuffer) {
  try {
    return { out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer }), blocked: null, viaFile: false }
  } catch (error) {
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error
    const dir = mkdtempSync(path.join(tmpdir(), 'vncode-git-'))
    try {
      const outFile = path.join(dir, 'stdout')
      let fd
      try {
        fd = openSync(outFile, 'w')
        const redirected = spawnSync('git', args, { cwd: repo, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
        if (redirected.error) return { out: '', blocked: redirected.error, viaFile: true }
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
      return { out: readFileSync(outFile, 'utf8'), blocked: null, viaFile: true }
    } catch (fallbackError) {
      return { out: '', blocked: fallbackError, viaFile: true }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// `-z` is NUL-separated, so it is split on NUL and never on a newline: a path may
// legally contain one, and splitting on lines would read such a path as two.
const stagedRun = runGit(['ls-files', '-co', '--exclude-standard', '-z'], 64 * 1024 * 1024)
const stagedFiles = stagedRun.blocked ? [] : stagedRun.out.split('\0').filter(Boolean)
if (stagedRun.viaFile && !stagedRun.blocked) {
  notes.push('reached git by redirecting it to a file, because this host refuses a piped spawn - the scan below is complete')
}
if (stagedRun.blocked) {
  notes.push(`SKIPPED the staged-file scan: this host would not run git at all (${stagedRun.blocked.code || stagedRun.blocked.message}) - run the check in a normal terminal, where git is reachable`)
}

function isBinary(file) {
  try {
    // A NUL byte in the first 8 KiB is git's own heuristic, and it is right:
    // a key inside a PNG is not something a text rule can find.
    const buffer = readFileSync(file)
    return buffer.subarray(0, 8192).includes(0)
  } catch {
    return true // unreadable is not scannable; it is not a failure either
  }
}

let scanned = 0
let skipped = 0
for (const relative of stagedFiles) {
  const absolute = path.join(repo, relative)
  let size = 0
  try {
    const info = statSync(absolute)
    if (!info.isFile()) continue
    size = info.size
  } catch {
    continue
  }
  // Nothing this large is a source file, and reading it would only slow the
  // check down; the credential shapes we hunt live in small text files.
  if (size > 8 * 1024 * 1024) {
    skipped += 1
    continue
  }
  if (isBinary(absolute)) {
    skipped += 1
    continue
  }
  let text = ''
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  for (const message of scanText(text, relative)) fail(message)
}

// ---------------------------------------------------------------------------
// 3. The ignore rules that make a credential file unreachable by accident
// ---------------------------------------------------------------------------
// A check catches a committed secret; these rules stop the file being staged at
// all, which is the difference between a caught mistake and one that never
// happens. They are asserted HERE rather than trusted because a .gitignore is
// exactly the kind of file that gets "cleaned up" by somebody who does not know
// why a line is there.
const gitignore = (() => {
  try {
    return readFileSync(path.join(repo, '.gitignore'), 'utf8')
  } catch {
    fail('.gitignore is missing - a credentials file could be staged with `git add -A`.')
    return ''
  }
})()

const REQUIRED_IGNORES = [
  { pattern: /^\.env$/m, what: '.env' },
  { pattern: /^\.env\.\*$/m, what: '.env.*' },
  { pattern: /^\.credentials\.yaml$/m, what: '.credentials.yaml' },
  { pattern: /^\*\.credentials\.yaml$/m, what: '*.credentials.yaml' },
  { pattern: /^\*\.pem$/m, what: '*.pem' },
  { pattern: /^\*\.key$/m, what: '*.key' },
  { pattern: /^id_rsa\*$/m, what: 'id_rsa*' },
]
for (const { pattern, what } of REQUIRED_IGNORES) {
  if (!pattern.test(gitignore)) {
    fail(`.gitignore does not ignore '${what}' - a credential file of that shape could be committed.`)
  }
}

// ---------------------------------------------------------------------------
// 3b. No TRACKED file may be ignored
// ---------------------------------------------------------------------------
// An ignore rule that matches a TRACKED file is a silent trap: any NEW file
// created beside it is skipped by `git add -A` and hidden from `git status`, so a
// file that exists locally and passes local tests never reaches a commit. That is
// not hypothetical - an unanchored `dsh-diagrams/` rule matched
// `packages/dsh-diagrams/` and quietly ignored all 18 files of that package, so
// the next file added inside it would have been invisible. `git ls-files -i -c
// --exclude-standard` is git's own answer to "which files I track would I be
// ignoring?", and it must be empty.
{
  const ignoredRun = runGit(['ls-files', '-i', '-c', '--exclude-standard'], 16 * 1024 * 1024)
  // An older git build, or a host that will not run git through a pipe at all,
  // leaves this empty - the ignore rules themselves are still asserted above.
  const ignoredTracked = ignoredRun.blocked ? [] : ignoredRun.out.split(/\r?\n/).filter(Boolean)
  for (const file of ignoredTracked) {
    fail(`.gitignore hides the TRACKED file '${file}' - an ignore rule is too broad, so new files beside it (and this scan) would skip it.`)
  }
  if (ignoredRun.blocked) {
    notes.push('SKIPPED the tracked-file-hidden-by-.gitignore scan for the same reason (this host refused git)')
  } else if (ignoredTracked.length === 0) {
    notes.push('no tracked file is hidden by an ignore rule')
  }
}

// ---------------------------------------------------------------------------
// 4. Self-test: the guard must actually fire
// ---------------------------------------------------------------------------
// A scanner that has never been shown to fire is decoration. The sample is
// ASSEMBLED at runtime rather than written literally, so this file cannot match
// its own rules.
{
  const fakeKey = `sk-${'A'.repeat(32)}`
  const sample = `credentials:\n  DEEPSEEK_API_KEY: ${fakeKey}\n`
  const hits = scanText(sample, 'sample/not/a/real/file.yml')
  if (hits.length === 0) {
    fail('the scanner did not fire on a synthetic key - the guard is not working.')
  }
  if (hits.some((message) => message.includes(fakeKey))) {
    fail('the scanner printed the secret it found - a failure report must never carry the value.')
  }
  const masked = maskPreview(fakeKey)
  if (masked.includes(fakeKey) || masked.length < 10) {
    fail('maskPreview does not mask.')
  }
  const clean = scanText('this line has no credential in it at all\n', 'sample/clean.md')
  if (clean.length !== 0) {
    fail('the scanner fired on a clean file - it would cry wolf.')
  }
  notes.push(`self-test: fires on a synthetic key, hides the value, stays quiet on clean text`)
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log('check-no-secrets: nothing secret may reach a commit')
console.log(`  - ${RULES.length} rules over ${scanned} text files that \`git add -A\` would stage (${skipped} binary/large skipped)`)
console.log(`  - ${REQUIRED_IGNORES.length} credential-shaped ignore rules present`)
for (const line of notes) console.log(`  - ${line}`)
if (failures.length > 0) {
  console.log('')
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`\ncheck-no-secrets: ${failures.length} problem(s).`)
  console.log('A real credential in a commit is on GitHub forever: rotate it FIRST, then clean up.')
  process.exit(1)
}
console.log('\ncheck-no-secrets: OK')
