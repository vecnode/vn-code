// check-research-examples.mjs - every fenced example in this package's skills,
// against the REAL tool surface.
//
// A skill is prose that tells a model what to call, so the thing that rots is not
// the prose - it is the surface underneath it: a tool gets renamed, an `action=`
// value is dropped, a refusal code is reworded, and the skill keeps confidently
// teaching a call that now fails. Nothing in the pack caught that for this package:
// `check-skill-examples.mjs` walks the DIAGRAMS skills (Mermaid and TikZ blocks),
// and there is no fence kind for "a tool call".
//
// So this check reads the skills the way a model would, and holds what they SAY
// against what the code DOES:
//
//   - every `rs_*` name a skill uses must be a registered tool;
//   - every `action=`, `what=`, `part=`, `format=`, `draft=`, `tier=` and
//     `strength=` value must be one that tool actually accepts (read from the
//     tool's own `parameters` schema, not from a list copied here);
//   - every SCREAMING_SNAKE token that looks like a refusal code must be a code
//     this package can actually raise, and every lower-hyphen one must be a r0
//     problem code or an rung finding the code produces - both read out of the
//     modules' own source, so a renamed code is caught rather than tolerated;
//   - every `[sentence]{#cNNNN}` must parse as a claim span and every `[@key]` as a
//     citation, with the document dialect's own parser doing the parsing;
//   - and every skill's frontmatter must parse and name the folder it lives in,
//     because that `name` is what the registry registers.
//
// Anything it cannot classify is REPORTED, never ignored: a construct this check
// does not understand is a construct nobody is checking.
//
// Run:  node packages/dsh-research/checks/check-research-examples.mjs
export {}

const { promises: fsp } = await import('node:fs')
const { readdirSync, readFileSync } = await import('node:fs')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const pkgDir = path.join(repo, 'packages', 'dsh-research')
const skillsDir = path.join(pkgDir, 'skills')
let failures = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(48) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const toolsModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'tools.js')).href)
const indexModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href)
const syntaxModule = await import(pathToFileURL(path.join(pkgDir, 'lib', 'syntax.js')).href)

/** Every tool, by name, with the enum each `=`-parameter accepts. */
const tools = toolsModule.buildTools({ env: process.env, workspace: process.cwd(), log: { warn() {}, info() {}, debug() {} } })
const byName = new Map(tools.map((tool) => [tool.name, tool]))
const TOOLS = tools.map((tool) => tool.name)

/** The allowed values of one parameter, from the tool's own schema. */
function allowedValues(tool, parameter) {
  const schema = tool === undefined ? undefined : tool.parameters?.properties?.[parameter]
  if (schema === undefined) return null
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => String(value))
  return []
}

/**
 * Every refusal code and every lower-hyphen problem/finding code this package can
 * raise, read out of the source that raises them. A list copied into a check drifts
 * from the code the day someone renames a code; this cannot.
 */
function codesFromSource() {
  const upper = new Set(indexModule.REFUSAL_CODES)
  const lower = new Set()
  for (const name of ['doc.js', 'verify.js', 'ledger.js', 'syntax.js', 'method.js']) {
    const text = readFileSync(path.join(pkgDir, 'lib', name), 'utf8')
    for (const match of text.matchAll(/(?:problem|finding)\('([a-z][a-z-]+)'/g)) lower.add(match[1])
    for (const match of text.matchAll(/'(r[0-4]-[a-z]+)'/g)) lower.add(match[1])
  }
  return { upper, lower }
}

const CODES = codesFromSource()

/** The fenced blocks of a Markdown document: `{ info, body, line }`. */
function fencesOf(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line)
    if (fence === null) {
      if (open !== null) open.body.push(line)
      continue
    }
    if (open === null) open = { info: fence[2] ?? '', body: [], line: index + 1 }
    else {
      blocks.push({ info: open.info, text: open.body.join('\n'), line: open.line })
      open = null
    }
  }
  if (open !== null) blocks.push({ info: open.info, text: open.body.join('\n'), line: open.line })
  return blocks
}

/** The `key=value` pairs a line uses, with the tool they belong to. */
function assignments(line) {
  const found = []
  const tool = /\b(rs_[a-z_]+)\b/.exec(line)
  for (const match of line.matchAll(/\b(action|what|part|format|draft|tier|strength|mode|role|scope)=([A-Za-z0-9_-]+)/g)) {
    found.push({ tool: tool === null ? null : tool[1], parameter: match[1], value: match[2] })
  }
  // An assignment written as JSON inside a call: `"action": "record"`.
  for (const match of line.matchAll(/"(action|what|part|format|draft|tier|strength)"\s*:\s*"([A-Za-z0-9_-]+)"/g)) {
    found.push({ tool: tool === null ? null : tool[1], parameter: match[1], value: match[2] })
  }
  return found
}

const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

// The invariant that matters is not "there are three skills" - it is that every
// skill ON DISK is one this row REGISTERS. A skill folder nothing registers is a
// skill the agent never loads, and the installers copy it into $DSH_HOME/skills
// anyway, so the two halves disagree and only one of them is what the model sees.
check('every skill on disk is registered at activation', skillNames.join(','), indexModule.__internals.SKILL_FILES.map((one) => one.name).sort().join(','))
// ...and the other direction: a REGISTERED skill whose file is missing is a warning
// at activation rather than a failure, which is how a rename leaves a row quietly
// teaching a skill it cannot load.
check(
  'every registered skill has a file on disk',
  indexModule.__internals.SKILL_FILES.filter((one) => !skillNames.includes(one.name)).map((one) => one.name).join(','),
  '',
)
check('and the package ships at least one skill', skillNames.length >= 1, true)
check('every skill on disk has a SKILL.md', skillNames.every((name) => readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8').length > 200), true)

/** Every assignment a skill makes, collected first so the report is one line each. */
const badTools = []
const badValues = []
const badUpper = []
const badLower = []
const badSpans = []
const badCitations = []
const badFences = []
const unclassified = []
const frontmatterProblems = []

let fenceCount = 0
/** How many Markdown files this check actually opened, for the guard at the end. */
let documentsRead = 0

/**
 * Every Markdown file a skill ships, not only its `SKILL.md`.
 *
 * A skill may carry a bundled reference (`reference/*.md`, the pattern
 * `dsh-diagrams` already uses), and a reference teaches the same tool calls, codes
 * and dialect a SKILL.md does. Scanning only the SKILL.md would leave the largest
 * file in the package as the one thing nothing checks - which is the failure this
 * whole check exists to name, so it walks the folder instead.
 */
function markdownOf(skill) {
  const root = path.join(skillsDir, skill)
  const skillFile = path.join(root, 'SKILL.md')
  const found = [{ file: skillFile, label: skill, isSkill: true }]
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.md') || full === skillFile) continue
      found.push({ file: full, label: skill + '/' + path.relative(root, full).replace(/\\/g, '/'), isSkill: false })
    }
  }
  walk(root)
  return found
}

for (const skill of skillNames) {
  for (const doc of markdownOf(skill)) {
    const text = readFileSync(doc.file, 'utf8')
    documentsRead += 1

    // ---- frontmatter: what the registry actually registers. Only the SKILL.md has
    // one; a reference is prose beside it and is held to the same code rules below.
    if (doc.isSkill) {
      const front = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, '\n'))
      if (front === null) frontmatterProblems.push(skill + ': no frontmatter')
      else {
        const meta = {}
        for (const line of front[1].split('\n')) {
          const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
          if (entry !== null) meta[entry[1]] = entry[2].trim()
        }
        if (meta.name !== skill) frontmatterProblems.push(skill + ': name is ' + JSON.stringify(meta.name ?? ''))
        for (const field of ['description', 'whenToUse']) {
          if (typeof meta[field] !== 'string' || meta[field].length < 40) frontmatterProblems.push(skill + ': ' + field + ' is missing or too short to load on')
        }
      }
    }

    for (const block of fencesOf(text)) {
      if (block.info === '') {
        // A fence with no language is not checked by anything else in the pack
        // either; saying so is better than pretending it was read.
        unclassified.push(doc.label + ':' + block.line + ' a fence with no info string')
        continue
      }
      fenceCount += 1
      if (block.info !== 'text' && block.info !== 'bash' && block.info !== 'json' && block.info !== 'markdown') {
        unclassified.push(doc.label + ':' + block.line + ' fence kind `' + block.info + '` (this check reads text/bash/json/markdown)')
      }
      for (const line of block.text.split('\n')) {
        for (const use of assignments(line)) {
          const tool = use.tool === null ? null : byName.get(use.tool)
          if (use.tool !== null && tool === undefined) {
            badTools.push(doc.label + ':' + block.line + ' `' + use.tool + '`')
            continue
          }
          if (use.tool === null) {
            // A parameter written in PROSE, with the tool established earlier in the
            // paragraph. That is normal writing, so the honest test is not "no tool on
            // this line" - it is whether ANY tool accepts the value. `action=rereview`
            // in a sentence is fine; `action=re-review` is a typo and fails here.
            const anywhere = tools.some((one) => (allowedValues(one, use.parameter) ?? []).includes(use.value))
            if (['action', 'what', 'part', 'tier'].includes(use.parameter) && !anywhere) {
              badValues.push(doc.label + ':' + block.line + ' `' + use.parameter + '=' + use.value + '` - no tool accepts that value')
            }
            continue
          }
          const allowed = allowedValues(tool, use.parameter)
          if (allowed === null) {
            badValues.push(doc.label + ':' + block.line + ' `' + use.tool + '` has no `' + use.parameter + '` parameter')
            continue
          }
          if (allowed.length > 0 && !allowed.includes(use.value)) {
            badValues.push(doc.label + ':' + block.line + ' `' + use.tool + ' ' + use.parameter + '=' + use.value + '` (allows ' + allowed.join('|') + ')')
          }
        }
        // ---- refusal codes
        for (const match of line.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
          // An ENVIRONMENT VARIABLE is not a refusal code, and the pack's own are all
          // prefixed (`DSH_`, `OF_`). Code names never carry a prefix like that, so
          // this is a rule rather than an allowlist: an allowlist would have to grow
          // every time a skill mentions one.
          if (/^(DSH|OF)_/.test(match[1])) continue
          if (!CODES.upper.has(match[1])) badUpper.push(doc.label + ':' + block.line + ' `' + match[1] + '`')
        }
        for (const match of line.matchAll(/`([a-z][a-z]+(?:-[a-z]+)+)`/g)) {
          const code = match[1]
          // Only the ones that ARE codes: prose in backticks is not a code, so this
          // flags a token only when it is shaped like one and is not known.
          if (/^(span|claim|broken|unknown|locate|bytes|title|field|origin|text|source)/.test(code) && !CODES.lower.has(code)) {
            badLower.push(doc.label + ':' + block.line + ' `' + code + '`')
          }
        }
        // ---- the document dialect, parsed by the dialect's own parser
        for (const match of line.matchAll(/\[[^[\]]+\]\{#(c[0-9]*)\}/g)) {
          const spans = syntaxModule.findClaimSpans(line)
          if (spans.length === 0 || syntaxModule.findBrokenClaimMarkers(line).length > 0) badSpans.push(doc.label + ':' + block.line + ' ' + JSON.stringify(match[0]))
        }
        if (line.includes('[@{') === false) {
          for (const match of line.matchAll(/\[-?@[^\]]*\]/g)) {
            // A citation is only a citation when the dialect's parser says so - and a
            // bracket that MENTIONS a key without parsing is the case a skill is most
            // likely to teach by accident.
            if (syntaxModule.findCitations(match[0]).length === 0) badCitations.push(doc.label + ':' + block.line + ' ' + JSON.stringify(match[0]))
          }
        }
        if (syntaxModule.findBrokenClaimMarkers(line).length > 0 && /\]\(#c[0-9]/.test(line)) {
          badSpans.push(doc.label + ':' + block.line + ' an anchor link taught as a claim')
        }
      }
    }
  }
}

check('the skills carry fenced examples at all', fenceCount >= 6, true)
check('every tool a skill names is a registered tool', badTools.join(' | '), '')
check('every parameter value a skill uses is one the tool accepts', badValues.join(' | '), '')
check('every refusal code a skill names is one the code can raise', badUpper.join(' | '), '')
check('every problem or rung code a skill names exists', badLower.join(' | '), '')
check('every claim span a skill teaches parses as one', badSpans.join(' | '), '')
check('every citation a skill teaches parses as one', badCitations.join(' | '), '')
check('every skill\'s frontmatter names its own folder and loads on something', frontmatterProblems.join(' | '), '')
// Not a failure: a construct this check cannot classify is REPORTED, because a
// check that silently ignores what it does not understand is the failure mode the
// pack's own rules are written against.
if (unclassified.length > 0) {
  console.log('note ' + unclassified.length + ' fence(s) this check does not read:')
  for (const one of unclassified.slice(0, 10)) console.log('     ' + one)
}

// A guard on the check itself: if the tool surface grew and this check did not
// notice, the two lists would silently disagree.
check('the check read the whole tool surface', TOOLS.length, toolsModule.TOOL_NAMES.length)
// The guard on the WALK, not on the tool surface: if `markdownOf` ever stopped
// descending into a skill folder, every bundled reference would fall out of this
// check silently and the largest prose in the package would be the one thing nobody
// reads. A reference file is what makes the count exceed the number of skills.
check('and it read a bundled reference, not only the SKILL.md files', documentsRead > skillNames.length, true)
check('and the surface is the nine tools the package documents', TOOLS.join(','), 'rs_open,rs_new,rs_plan,rs_read,rs_write,rs_cite,rs_verify,rs_review,rs_build')
check('the code sets it reads are not empty', CODES.upper.size > 30 && CODES.lower.size > 6, true)
// The classifier can only police a code it can SEE. These three are read out of
// verify.js, so if a rename ever moves them out of the pattern's reach the check
// would stop policing them silently - which is the failure mode this assertion is
// here to prevent.
check('and it can see the rung findings, not just the r0 problems', ['bytes-missing', 'title-mismatch', 'locate-miss', 'locate-inconclusive'].every((code) => CODES.lower.has(code)), true)

console.log('')
console.log(failures === 0 ? 'all research-example checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
