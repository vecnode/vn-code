/**
 * dsh-frontend-craft — the three tools the agent calls.
 *
 * They are three on purpose. Everything the skill needs from a runtime is one of:
 * "what is true about this project" (`fe_context`), "what can 61 rules see in
 * these files" (`fe_detect`), and "record this artifact" (`fe_artifact`). The
 * design itself stays in the skill's references, where a person can read it.
 *
 * The detector's answer is shaped for a reader, not just a parser: a count by
 * category, the rules that fired, the findings with file:line, and the one
 * sentence that keeps a clean scan from being mistaken for a good page.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

import { DEFAULT_VIEWPORTS, MAX_VIEWPORTS, renderSummary, renderTarget, targetToUrl } from './render.js'
import { challengerFor } from './deck.js'

import { MAX_ARTIFACT_BYTES, directivesFor, readContext, validateDesign, validateProduct, validateSurface, PRODUCT_FILE, DESIGN_FILE, SURFACES_DIR } from './context.js'
import { FrontendError, MAX_TOTAL_BYTES, collectSources, readSource, resolveTarget, sessionRoot } from './paths.js'
import { PACKAGE_VERSION, RULE_COUNT, RULES, VERSION, applyIgnores, detectHtml, detectText, inlineStylesheets, ruleOf } from './vendor.js'

/** The session id one tool call belongs to; '' when the call has none. */
export function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session ? session.id : undefined
  return typeof id === 'string' ? id : ''
}

/** A cap the caller can lower, never raise past the scanner's own budget. */
function clampFindings(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 200
  return Math.min(400, Math.floor(number))
}

function formatMs(ms) {
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'
}

function plural(count, one, many) {
  return count === 1 ? one : many
}

/** The corpus sentence: pin, rule count, version. Every answer carries it. */
export function corpusLine() {
  const upstream = VERSION.upstream
  return 'frontend-craft ' + PACKAGE_VERSION + ' · Impeccable ' + upstream.skillVersion + ' @ ' + upstream.commit.slice(0, 7) + ' · ' + RULE_COUNT + ' rules'
}

/**
 * Scan one target: an HTML document through the static engine, every other
 * source through the text engine, both from the vendored wasm.
 *
 * @returns a scan report `{ ok, target, files, truncated, findings, counts, byRule, dropped, ms, errors }`.
 */
export async function scanTarget(deps, options) {
  const started = Date.now()
  const root = await sessionRoot(deps.ctx, options.session)
  const target = await resolveTarget(deps.ctx, { session: options.session, target: options.target })
  const context = readContext(root)
  const ignores = context.config.detector
  const collected = collectSources(target.real)
  // Findings name a path a reader can act on: workspace-relative when the scan
  // is inside the workspace, so a folder scan does not lose its own prefix.
  const prefix = target.scope === 'workspace' && target.relative !== null && target.relative !== '.' && target.relative !== '' ? target.relative.replace(/\/$/, '') + '/' : ''
  const findings = []
  const errors = []
  let total = 0
  let truncated = collected.truncated
  let htmlFiles = 0
  let textFiles = 0

  for (const entry of collected.files) {
    if (total >= MAX_TOTAL_BYTES) {
      truncated = true
      break
    }
    if (entry.bytes > 0) total += entry.bytes
    const reported = target.isDirectory ? prefix + entry.relative : entry.relative
    let text
    try {
      text = await readSource(entry)
    } catch (err) {
      errors.push(entry.relative + ': ' + String(err && err.message ? err.message : err))
      continue
    }
    const answer = entry.kind === 'html' ? detectHtml(inlineStylesheets(text, entry.file), reported, {}) : detectText(text, reported, {})
    if (answer.ok !== true) {
      errors.push(answer.message)
      continue
    }
    if (entry.kind === 'html') htmlFiles += 1
    else textFiles += 1
    for (const finding of answer.findings) findings.push(finding)
  }

  const ignored = applyIgnores(findings, ignores)
  const wantedRules = Array.isArray(options.rules) && options.rules.length > 0 ? new Set(options.rules.map(String)) : null
  let kept = ignored.kept.filter((finding) => wantedRules === null || wantedRules.has(finding.antipattern))
  if (options.includeAdvisory === false) kept = kept.filter((finding) => finding.advisory !== true)
  kept.sort((a, b) => {
    const fileOrder = String(a.file).localeCompare(String(b.file))
    if (fileOrder !== 0) return fileOrder
    return Number(a.line) - Number(b.line)
  })

  const counts = { total: kept.length, slop: 0, quality: 0, advisory: 0, error: 0, warning: 0 }
  for (const finding of kept) {
    if (finding.category === 'slop') counts.slop += 1
    else if (finding.category === 'quality') counts.quality += 1
    if (finding.advisory === true) counts.advisory += 1
    if (finding.severity === 'error') counts.error += 1
    else if (finding.severity === 'warning') counts.warning += 1
  }
  const ruleCounts = new Map()
  for (const finding of kept) ruleCounts.set(finding.antipattern, (ruleCounts.get(finding.antipattern) ?? 0) + 1)
  const byRule = [...ruleCounts.entries()]
    .map(([id, count]) => ({ id, count, rule: ruleOf(id) ?? null }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))

  return {
    ok: errors.length === 0 || kept.length > 0,
    target: { scope: target.scope, relative: target.relative, real: target.real, isDirectory: target.isDirectory },
    files: { total: htmlFiles + textFiles, html: htmlFiles, text: textFiles },
    truncated,
    findings: kept,
    ignored: ignored.dropped,
    counts,
    byRule,
    errors,
    ms: Date.now() - started,
    detector: { rules: RULE_COUNT, upstream: VERSION.upstream.skillVersion, commit: VERSION.upstream.commit },
  }
}

/** The readable half of a scan: what fired, where, and what it means. */
export function scanText(report, maxFindings = 25) {
  if (report.ok !== true) return report.errors.join('\n')
  const lines = []
  const target = report.target.relative === null ? report.target.real : report.target.relative
  lines.push(corpusLine())
  lines.push(
    'scanned ' + report.files.total + ' ' + plural(report.files.total, 'file', 'files') + ' (' + report.files.html + ' HTML, ' + report.files.text + ' text) in ' + formatMs(report.ms) + ' · ' + target,
  )
  if (report.truncated) lines.push('the scan was CAPPED: some files were not read (2000-file / 8 MB budget). Scan a folder, not the repository root.')
  if (report.ignored > 0) lines.push(report.ignored + ' ' + plural(report.ignored, 'finding', 'findings') + ' waived by .frontend-craft/config.json')
  if (report.counts.total === 0) {
    lines.push('')
    lines.push('no findings. ' + (report.errors.length > 0 ? 'Some files could not be read: ' + report.errors.join('; ') : ''))
    lines.push('A clean run is evidence, not proof: these rules cannot see the rendered page, its copy, or whether the design is any good.')
    return lines.join('\n')
  }
  lines.push('')
  lines.push(
    report.counts.total +
      ' ' +
      plural(report.counts.total, 'finding', 'findings') +
      ' in ' +
      new Set(report.findings.map((finding) => finding.file)).size +
      ' ' +
      plural(new Set(report.findings.map((finding) => finding.file)).size, 'file', 'files') +
      ' — ' +
      report.counts.slop +
      ' slop, ' +
      report.counts.quality +
      ' quality' +
      (report.counts.advisory > 0 ? ', ' + report.counts.advisory + ' advisory' : ''),
  )
  lines.push('')
  lines.push('by rule:')
  for (const entry of report.byRule) {
    const rule = entry.rule
    lines.push('  ' + entry.id + ' ×' + entry.count + ' (' + (rule ? rule.category : 'unknown') + (rule && rule.description ? '' : '') + ')')
  }
  lines.push('')
  const shown = report.findings.slice(0, maxFindings)
  for (const finding of shown) {
    const rule = ruleOf(finding.antipattern)
    lines.push(finding.file + ':' + finding.line + '  ' + finding.antipattern + (finding.advisory ? ' (advisory)' : '') + ' — ' + (rule ? rule.name : finding.name ?? ''))
    if (finding.snippet) lines.push('  ' + String(finding.snippet).replace(/\s+/g, ' ').slice(0, 160))
    if (rule && rule.description) lines.push('  ' + rule.description)
  }
  if (report.findings.length > shown.length) {
    lines.push('')
    lines.push('… ' + (report.findings.length - shown.length) + ' more ' + plural(report.findings.length - shown.length, 'finding', 'findings') + ' in the tab and in the tool view.')
  }
  lines.push('')
  lines.push('This is evidence, not proof: the rules cannot see the rendered page, the copy, or whether the design is any good. A finding is not automatically a defect — the brief is the reference, and a rule waived on purpose is waived inline with the `impeccable-disable` marker.')
  return lines.join('\n')
}

/** The readable half of a context read. */
export function contextText(snapshot, directives) {
  const lines = []
  lines.push(corpusLine())
  lines.push('root: ' + snapshot.root)
  lines.push('platform: ' + snapshot.platform + (snapshot.product && snapshot.product.stack ? ' · stack: ' + snapshot.product.stack : ''))
  const product = snapshot.product === null ? 'absent' : 'present' + (snapshot.product.schema === null ? ' (no schema stamp)' : ' · schema ' + snapshot.product.schema) + (snapshot.product.ok ? '' : ' · INCOMPLETE: ' + snapshot.product.problems.join('; '))
  lines.push('PRODUCT.md: ' + product)
  const design = snapshot.design === null ? 'absent' : 'present' + (snapshot.design.ok ? ' · valid' : ' · INCOMPLETE: ' + snapshot.design.problems.join('; '))
  lines.push('DESIGN.md: ' + design)
  lines.push('surface briefs: ' + (snapshot.briefs.length === 0 ? 'none' : snapshot.briefs.map((brief) => brief.slug + (brief.ok ? '' : ' (incomplete)')).join(', ')))
  lines.push('config: ' + (snapshot.config.present ? '.frontend-craft/config.json' : 'absent (defaults in force)'))
  if (directives.length === 0) {
    lines.push('')
    lines.push('directives: none — the context is complete enough to design. Load the request’s playbook next.')
  } else {
    lines.push('')
    lines.push('directives (' + directives.length + '):')
    for (const directive of directives) lines.push('- ' + directive.id + ' (' + directive.severity + '): ' + directive.message)
  }
  lines.push('')
  lines.push('Do not call this tool twice in one session unless the target changes.')
  return lines.join('\n')
}

/** The four visitor modes upstream names, and the order they are listed in. */
export const MODES = ['persuade', 'operate', 'read', 'experience']

/**
 * A deterministic order for a seed, so the same roll re-runs to the same hand.
 * A hash and a Fisher-Yates: no dependency, no randomness at deal time.
 */
export function orderFor(seed, items) {
  const bytes = createHash('sha256').update(String(seed)).digest()
  const out = items.slice()
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = bytes[index % bytes.length] % (index + 1)
    const swap = out[index]
    out[index] = out[pick]
    out[pick] = swap
  }
  return out
}

/** The directions an author actually wrote, normalised and capped. */
export function normalizeDirections(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim() !== '')
    .slice(0, 12)
    .map((entry) => ({
      name: entry.name.trim(),
      thesis: typeof entry.thesis === 'string' ? entry.thesis.trim() : '',
      risk: typeof entry.risk === 'string' ? entry.risk.trim() : '',
    }))
}

/**
 * Deal one hand from the authored directions.
 *
 * The seed is the whole mechanism: a hash of it decides the order, so the same
 * roll re-runs to the same hand, a re-roll is a new seed rather than a new mood,
 * and the assignment cannot be the agent quietly picking its favourite. Shared by
 * the tool and the tab's route, so both tell the same story.
 *
 * @returns `{ ok: true, deal }` or `{ ok: false, message }`.
 */
export function dealDirections(input = {}) {
  const directions = normalizeDirections(input.directions)
  if (directions.length < 3) {
    return {
      ok: false,
      message:
        'A roll needs at least 3 authored directions (upstream asks for 7); got ' + directions.length + '. Author them first — concrete worlds, artifacts, places or graphic traditions the audience knows by heart, each with a one-line thesis and an honest risk. Do not name colours or adjectives.',
    }
  }
  const seed = typeof input.seed === 'string' && input.seed.trim() !== '' ? input.seed.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32) : randomBytes(8).toString('hex')
  if (seed === '') return { ok: false, message: '`seed` must contain letters or digits.' }
  const order = orderFor(seed, directions)
  const cards = order.slice(0, Math.min(3, order.length)).map((card, index) => ({ ...card, position: index + 1, source: 'authored' }))
  const mode = typeof input.mode === 'string' && MODES.includes(input.mode) ? input.mode : 'persuade'
  // The one thing the agent did not write: a world from the local deck, chosen by
  // the same hash, so the hand always contains an outside view it has to judge.
  const challenger = input.includeDeck === false ? null : challengerFor(seed, mode, directions)
  if (challenger !== null) {
    cards.push({
      position: cards.length + 1,
      name: challenger.name,
      thesis: challenger.thesis,
      risk: challenger.risk,
      source: 'deck',
      family: challenger.family ?? null,
    })
  }
  const deal = {
    seed,
    mode,
    scope: input.scope === 'surface' ? 'surface' : 'direction',
    assigned: order[0].name,
    cards,
    challenger: challenger === null ? null : challenger.name,
    at: Date.now(),
  }
  return { ok: true, deal }
}

/** Validate a pick against its hand. `reroll` and `canon` are always legal. */
export function pickDirection(deal, raw) {
  if (deal === null || typeof deal !== 'object') return { ok: false, message: 'Deal a hand first (`action: "deal"`).' }
  const choice = typeof raw === 'string' ? raw.trim() : ''
  if (choice === '') return { ok: false, message: 'A pick needs the chosen name, or "reroll" / "canon".' }
  const known = (deal.cards ?? []).some((card) => card.name === choice) || choice === 'reroll' || choice === 'canon'
  if (!known) return { ok: false, message: 'That is not one of this hand’s cards: ' + (deal.cards ?? []).map((card) => card.name).join(', ') + ' (or reroll / canon).' }
  return { ok: true, choice }
}

/** What a recorded pick commits the run to, in one sentence. */
export function pickConsequence(choice) {
  if (choice === 'reroll') return 'Deal a fresh hand with a new seed. Do not re-deal the same one.'
  if (choice === 'canon') return 'The standing exit is the commitment: execute the category standard at full fidelity, no irony, no smuggled quirk.'
  return 'Build this one. Record it in the brief’s FORM line with the deal’s seed, and write the direction contract before touching code.'
}

/** The cards one deal produced, as a payload the agent can put in front of a person. */
function dealText(deal) {
  const lines = []
  lines.push('DIRECTION ROLL — local, no catalog')
  lines.push('seed: ' + deal.seed + '   (record this as the brief’s `seed:` line)')
  lines.push('mode: ' + deal.mode + ' · scope: ' + deal.scope)
  lines.push('')
  lines.push('assigned (build this, or argue with it on named product truth — never on taste): ' + deal.assigned)
  lines.push('')
  lines.push('dealt, in presentation order:')
  for (const card of deal.cards) {
    lines.push('  ' + card.position + '. ' + card.name + (card.source === 'deck' ? '   (challenger, local deck)' : '') + (card.name === deal.assigned ? '   ← ASSIGNED (lead)' : ''))
    if (card.thesis) lines.push('     thesis: ' + card.thesis)
    if (card.risk) lines.push('     risk: ' + card.risk)
  }
  if (deal.challenger) {
    lines.push('')
    lines.push('THE CHALLENGER IS THE OUTSIDE VIEW: `' + deal.challenger + '` is from the local deck, not from your list.')
    lines.push('- Judge it on exactly two axes, before any borrowing: audience identification and product clarity. Verdict: wins (beats the assigned on both), competitive (holds one), or declined (loses both).')
    lines.push('- Declined is not spent: name the ONE discipline of its world the assigned direction lacks, and raise the assigned direction to match before presenting it. Its clothes are not a raise.')
  }
  lines.push('')
  lines.push('PRESENTATION')
  lines.push('- Put all ' + deal.cards.length + ' dealt cards in front of the person at equal salience, the assigned one under the kicker THE ROLL. Do not describe this as a catalog roll: there is no catalog in this build, so the challengers are the directions you authored (plus the standing exit: the category standard, played straight).')
  lines.push('- Use the harness’s own question tool for the pick; call `fe_direction` action `pick` with the answer so the record and the brief agree.')
  lines.push('- Re-roll with `fe_direction` action `deal` and a fresh seed; keep the register the person asked for in mind (safer / bolder) when you author the next hand.')
  lines.push('- The person may take the standing exit. When they do, convention becomes the commitment and the canon is executed at full fidelity.')
  return lines.join('\n')
}

/** The viewports a call asked for: `'1440x900'` strings or `{ width, height }`. */
export function parseViewports(input) {
  const raw = Array.isArray(input) && input.length > 0 ? input : DEFAULT_VIEWPORTS
  const out = []
  for (const entry of raw.slice(0, MAX_VIEWPORTS)) {
    if (typeof entry === 'string') {
      const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(entry.trim())
      if (!match) continue
      const width = Number(match[1])
      const height = Number(match[2])
      if (width < 200 || height < 200) continue
      out.push({ width, height, label: width < 600 ? 'phone' : width < 1000 ? 'tablet' : 'desktop' })
      continue
    }
    if (entry && Number.isFinite(entry.width) && Number.isFinite(entry.height) && entry.width >= 200 && entry.height >= 200) {
      out.push({ width: Math.floor(entry.width), height: Math.floor(entry.height), label: typeof entry.label === 'string' ? entry.label : Math.floor(entry.width) + 'px' })
    }
  }
  return out.length > 0 ? out : DEFAULT_VIEWPORTS
}

/** Persist one render under `$DSH_HOME/dsh-frontend-craft/renders/<id>/`. */
export function saveRender(deps, report) {
  const id = randomBytes(8).toString('hex')
  const dir = path.join(deps.root, 'renders', id)
  mkdirSync(dir, { recursive: true })
  for (const entry of report.viewports) {
    writeFileSync(path.join(dir, 'page-' + String(entry.viewport.width) + '.png'), entry.png)
  }
  const summary = {
    id,
    at: Date.now(),
    url: report.target.url,
    engine: report.engine,
    timingMs: report.timingMs,
    errors: report.errors,
    viewports: report.viewports.map((entry) => ({
      width: entry.viewport.width,
      height: entry.viewport.height,
      label: entry.viewport.label,
      bytes: entry.png.length,
      size: entry.size,
      findings: entry.findings,
      numbers: entry.measurements
        ? {
            viewport: entry.measurements.viewport,
            document: entry.measurements.document,
            targets: entry.measurements.targets.length,
            smallTargets: entry.measurements.targets.filter((target) => target.w < 24 || target.h < 24).length,
            contrastPairs: entry.measurements.colors.length,
            headings: entry.measurements.headings.length,
          }
        : null,
    })),
  }
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(summary, null, 2), 'utf8')
  return summary
}

/** The tools: context, detect, direction, render, artifact. */
export function buildTools(deps) {  const contextTool = {
    name: 'fe_context',
    description: [
      'Load this project’s front-end context once per session: PRODUCT.md (product truth), DESIGN.md (visual truth), the matching surface brief under .frontend-craft/surfaces/, config.json, the platform and visitor mode, and the DIRECTIVES a missing or stale artifact earns.',
      'This is the dsh-frontend-craft adaptation of Impeccable’s `impeccable context`. Follow its directives before designing; do not call it twice in one session unless the target changes. It reads only: it never writes PRODUCT.md or DESIGN.md. `fe_artifact` writes those, with shape validation.',
      'The corpus is Impeccable 4.6.0 (Apache-2.0), vendored at a pinned commit; nothing here installs, downloads or calls a network service.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Optional file or folder this request is about, relative to the workspace (or absolute). Names the surface. Omit for the project root.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: { type: 'object', additionalProperties: true } }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Front-end context' + (args && args.target ? ': ' + String(args.target) : ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Front-end context', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const session = sessionOf(exec)
      try {
        const root = await sessionRoot(deps.ctx, session)
        const target = args && typeof args.target === 'string' && args.target.trim() !== '' ? await resolveTarget(deps.ctx, { session, target: args.target }) : null
        const snapshot = readContext(target !== null && !target.isDirectory ? path.dirname(target.real) : target !== null ? target.real : root)
        // A named folder that is not the workspace root is a sub-project: read it
        // there, but still report the workspace for the record.
        const directives = directivesFor(snapshot)
        const text = contextText(snapshot, directives)
        return {
          text,
          view: {
            kind: 'frontend-context',
            root: snapshot.root,
            target: target === null ? null : { scope: target.scope, relative: target.relative },
            platform: snapshot.platform,
            product: snapshot.product === null ? null : { path: snapshot.product.path, schema: snapshot.product.schema, ok: snapshot.product.ok, problems: snapshot.product.problems },
            design: snapshot.design === null ? null : { path: snapshot.design.path, ok: snapshot.design.ok, problems: snapshot.design.problems },
            briefs: snapshot.briefs.map((brief) => ({ slug: brief.slug, ok: brief.ok, problems: brief.problems })),
            config: { present: snapshot.config.present, detector: snapshot.config.detector },
            directives,
            rules: RULE_COUNT,
            corpus: VERSION.upstream,
          },
        }
      } catch (err) {
        const message = err instanceof FrontendError || (err && err.message) ? String(err.message) : String(err)
        return { text: message, view: { kind: 'frontend-context', ok: false, error: message } }
      }
    },
  }

  const detectTool = {
    name: 'fe_detect',
    description: [
      'Scan front-end source for the 61 deterministic design rules Impeccable ships: AI-slop tells (side-tab borders, purple gradients, cream palettes, bounce easing, dark glows, overused fonts) and general quality (contrast pairs, type hierarchy, spacing, touch targets, line length, skipped headings).',
      'Runs entirely on this host through a vendored WebAssembly build of Impeccable’s rule engine: no network, no install, no child process. HTML documents go through the static-document engine (linked local stylesheets are inlined first); every other UI source (.tsx, .jsx, .vue, .svelte, .astro, .css, .scss, …) goes through the text engine.',
      'The answer is evidence, not proof: it cannot see the rendered page, the copy, or whether the design is good. A finding is not automatically a defect — the brief is the reference. `rules` narrows the scan; `includeAdvisory` (default true) keeps advisory findings. Project ignores in .frontend-craft/config.json are applied exactly as the CLI applies them.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'A file or folder to scan, relative to the workspace (or absolute). Default: the whole workspace. A folder is walked recursively, skipping node_modules, .git, dist, build, .next and similar.' },
        rules: { type: 'array', items: { type: 'string' }, description: 'Only report these rule ids (e.g. ["side-tab","overused-font"]). Omit for all 61.' },
        includeAdvisory: { type: 'boolean', description: 'Keep advisory findings such as em-dash overuse (default true). They never change a failure count.' },
        maxFindings: { type: 'number', description: 'Cap the findings returned in the tool view (default 200, max 400). The counts always describe the whole scan.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          view: {
            type: 'object',
            additionalProperties: true,
            properties: { kind: { type: 'string' }, counts: { type: 'object', additionalProperties: true }, findings: { type: 'array', items: { type: 'object', additionalProperties: true } } },
          },
        },
        required: ['text', 'view'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Design scan' + (args && args.target ? ': ' + String(args.target) : ''), kind: 'other' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result && result.view && result.view.counts ? 'Design scan — ' + result.view.counts.total + ' ' + plural(result.view.counts.total, 'finding', 'findings') : 'Design scan',
      content: result && result.text ? result.text : '',
    }),
    async execute(args, exec) {
      const session = sessionOf(exec)
      try {
        const report = await scanTarget(deps, {
          session,
          target: args && typeof args.target === 'string' ? args.target : '',
          rules: args && Array.isArray(args.rules) ? args.rules : [],
          includeAdvisory: args ? args.includeAdvisory !== false : true,
        })
        const cap = clampFindings(args ? args.maxFindings : undefined)
        deps.remember(session, report)
        return {
          text: scanText(report),
          view: {
            kind: 'frontend-scan',
            ok: report.ok,
            target: report.target,
            files: report.files,
            truncated: report.truncated,
            ignored: report.ignored,
            counts: report.counts,
            byRule: report.byRule.map((entry) => ({ id: entry.id, count: entry.count, name: entry.rule ? entry.rule.name : null, category: entry.rule ? entry.rule.category : null })),
            findings: report.findings.slice(0, cap),
            findingsTotal: report.findings.length,
            ms: report.ms,
            errors: report.errors,
            detector: report.detector,
          },
        }
      } catch (err) {
        const message = err instanceof FrontendError || (err && err.message) ? String(err.message) : String(err)
        return { text: message, view: { kind: 'frontend-scan', ok: false, error: message } }
      }
    },
  }

  const directionTool = {
    name: 'fe_direction',
    description: [
      'The direction round, without a catalog: deal the directions YOU authored, deterministically, and record the person’s pick. This is the adaptation of `impeccable concept-seed` and `serve-question`.',
      '`action: "deal"` takes `directions` (3 to 12 authored directions, each with a name and optionally a thesis and an honest risk), a `seed`, a `mode` and a `scope`, and prints a PRESENTATION block: which direction is ASSIGNED to build, and which three to put in front of the person. The order is a hash of the seed, so the same roll re-runs to the same hand and the assignment is not your favourite. `action: "ask"` returns the last hand as an option list for the harness question tool; `action: "pick"` records the answer; `action: "status"` reports the last roll.',
      'There is no catalog and no comp image pipeline in this build: the challengers are the directions you authored, plus ONE from this package’s local deck of eighteen visual worlds (the outside view you did not write), plus the standing exit. Say so; never present this as a catalog roll.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['deal', 'ask', 'pick', 'status'], description: '`deal` a hand, `ask` for the option list, `pick` to record the choice, `status` to read the last roll.' },
        directions: {
          type: 'array',
          description: 'For `deal`: the directions you authored, ordered by your own ranking. 3-12. The assignment ignores your order.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'A concrete world or artifact, not an adjective (e.g. "Swiss rail timetable", "risograph zine").' },
              thesis: { type: 'string', description: 'One line: why this world carries the product’s mechanism.' },
              risk: { type: 'string', description: 'One honest line: when this direction would feel wrong.' },
            },
          },
        },
        mode: { type: 'string', enum: MODES, description: 'The surface mode (persuade, operate, read, experience). Default persuade.' },
        scope: { type: 'string', enum: ['direction', 'surface'], description: '`direction` for a new or replacement visual world, `surface` for a whole surface inside an established world. Default direction.' },
        seed: { type: 'string', description: 'Optional seed: keep it to re-deal the same hand or to continue a round. Omit for a fresh 16-hex seed, which the answer prints.' },
        pick: { type: 'string', description: 'For `pick`: the chosen name, or "reroll" / "canon".' },
        includeDeck: { type: 'boolean', description: 'Deal one challenger from the local direction deck (default true). The deck is this package’s own eighteen visual worlds; there is still no catalog and no comp.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: { type: 'object', additionalProperties: true } }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: () => ({ card: 'generic', title: 'Direction round', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Direction round', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const session = sessionOf(exec)
      const action = args && args.action
      if (action === 'status') {
        const deal = deps.dealOf(session)
        if (deal === null) return { text: 'No direction round has been dealt in this session.', view: { kind: 'frontend-direction', ok: false } }
        const pick = deps.pickOf(session)
        const tail = pick === null ? '\n\nno pick recorded yet' : '\n\npick recorded: ' + pick + '\n' + pickConsequence(pick)
        return { text: dealText(deal) + tail, view: { kind: 'frontend-direction', ok: true, deal, pick } }
      }
      if (action === 'ask') {
        const deal = deps.dealOf(session)
        if (deal === null) return { text: 'Deal a hand first (`action: "deal"`).', view: { kind: 'frontend-direction', ok: false } }
        const options = deal.cards.map((card) => ({ label: card.name + (card.name === deal.assigned ? ' (the roll)' : ''), description: [card.thesis, card.risk ? 'risk: ' + card.risk : ''].filter(Boolean).join(' · ') }))
        options.push({ label: 'The category standard', description: 'The standing exit: the familiar, effective version of this category, played straight. Convention becomes the commitment.' })
        options.push({ label: 'Re-roll', description: 'A fresh hand, optionally with a steer (safer or bolder).' })
        return {
          text:
            'Ask the person which direction to build. Options (lead first):\n' +
            options.map((option, index) => '  ' + (index + 1) + '. ' + option.label + ' — ' + option.description).join('\n') +
            '\n\nWhen they answer, call `fe_direction` action `pick` with their choice.',
          view: { kind: 'frontend-direction', ok: true, options, deal },
        }
      }
      if (action === 'pick') {
        const deal = deps.dealOf(session)
        const verdict = pickDirection(deal, args && args.pick)
        if (!verdict.ok) return { text: verdict.message, view: { kind: 'frontend-direction', ok: false } }
        deps.rememberPick(session, verdict.choice)
        return { text: 'recorded: ' + verdict.choice + '\n' + pickConsequence(verdict.choice), view: { kind: 'frontend-direction', ok: true, picked: verdict.choice, deal } }
      }
      if (action !== 'deal') return { text: '`action` is deal, ask, pick or status.', view: { kind: 'frontend-direction', ok: false } }
      const dealt = dealDirections(args ?? {})
      if (!dealt.ok) return { text: dealt.message, view: { kind: 'frontend-direction', ok: false } }
      deps.rememberDeal(session, dealt.deal)
      return { text: dealText(dealt.deal), view: { kind: 'frontend-direction', ok: true, deal: dealt.deal } }
    },
  }

  const renderTool = {
    name: 'fe_render',
    description: [
      'Render the page the workspace actually produces and MEASURE it, because the 61 source rules cannot see a rendered page: a local HTML file or a loopback dev-server URL is rendered in a throwaway headless Chrome/Edge at the sizes you ask for, and comes back with a PNG plus findings for the things only pixels show - WCAG contrast pairs, touch targets under 24px, horizontal overflow, line length, body text under 12px, a skipped heading level, an image with no alt.',
      'The page cannot reach the network: every name resolves to NOTFOUND except loopback, so a remote font or CDN script fails and the answer says what could not be read. One browser launch serves every viewport; the profile is throwaway and the process is killed at the end.',
      'The findings are the MEASURED rules (ids starting `render-`), separate from the vendored source rules `fe_detect` reports. Neither judges the design: look at the picture, at the sizes the thing ships at, and read the craft floor.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'An HTML file inside the workspace (relative or absolute), or a LOOPBACK url such as http://127.0.0.1:5173/ for a dev server. Public URLs are refused.' },
        viewports: { type: 'array', items: { type: 'string' }, description: "Sizes to render at, e.g. [\"390x844\",\"1440x900\"]. Default: 1440x900 and 390x844. At most 4." },
        fullPage: { type: 'boolean', description: 'Capture the whole document instead of the first viewport (default false: the first viewport is what a visitor judges).' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: { type: 'object', additionalProperties: true } }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Render ' + String((args && args.target) ?? ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Rendered and measured', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const session = sessionOf(exec)
      try {
        const root = await sessionRoot(deps.ctx, session)
        const resolved = targetToUrl(args && args.target, root)
        if (resolved.ok !== true) return { text: resolved.message, view: { kind: 'frontend-render', ok: false, code: 'BAD_TARGET', message: resolved.message } }
        const report = await renderTarget({ target: resolved, viewports: parseViewports(args.viewports), fullPage: args.fullPage === true })
        if (report.ok !== true) {
          return {
            text: report.code === 'NO_ENGINE' ? report.message : renderSummary(report),
            view: { kind: 'frontend-render', ok: false, code: report.code ?? 'RENDER_FAILED', message: report.message, engine: report.engine ?? null, errors: report.errors ?? [] },
          }
        }
        const summary = saveRender(deps, report)
        deps.rememberRender(session, summary)
        return { text: renderSummary(report), view: { kind: 'frontend-render', ok: true, ...summary } }
      } catch (err) {
        const message = err instanceof FrontendError || (err && err.message) ? String(err.message) : String(err)
        return { text: message, view: { kind: 'frontend-render', ok: false, code: 'RENDER_FAILED', message } }
      }
    },
  }

  const artifactTool = {
    name: 'fe_artifact',
    description: [
      'Read or write one of the three durable artifacts: `product` (PRODUCT.md — product truth, never visual direction), `design` (DESIGN.md — tokens, type voices, materials), or `surface` (a brief under .frontend-craft/surfaces/<slug>.md that carries the surface strategy and its six-block direction contract).',
      'A write is VALIDATED before it lands, and an existing file is refused unless `overwrite` is true, so a run cannot silently replace confirmed product truth. Validation is shape only: it checks the schema stamp and required sections, never whether the prose is true.',
      'This is the adaptation of `impeccable surface-brief read|write`; PRODUCT.md and DESIGN.md are the same documents Impeccable reads, with the stamp renamed to `frontend-craft:product-schema`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'kind'],
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: '`read` returns the file and its validation; `write` validates then lands it.' },
        kind: { type: 'string', enum: ['product', 'design', 'surface'], description: 'Which artifact.' },
        target: { type: 'string', description: 'For `surface`: the slug (e.g. "landing", "settings"). Default "index". For `product`/`design`: ignored — they live at the project root by definition.' },
        body: { type: 'string', description: 'For `write`: the complete markdown. Required.' },
        overwrite: { type: 'boolean', description: 'For `write`: replace an existing file (default false). Ask the person before setting this on PRODUCT.md.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: { type: 'object', additionalProperties: true } }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: String((args && args.action) ?? 'read') + ' ' + String((args && args.kind) ?? 'artifact'), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Front-end artifact', content: result && result.text ? result.text : '' }),
    async execute(args, exec) {
      const session = sessionOf(exec)
      try {
        const root = await sessionRoot(deps.ctx, session)
        const kind = args && args.kind
        const action = args && args.action
        if (kind !== 'product' && kind !== 'design' && kind !== 'surface') return { text: '`kind` is product, design or surface.', view: { kind: 'frontend-artifact', ok: false } }
        const slug = typeof args.target === 'string' && args.target.trim() !== '' ? args.target.trim().replace(/[^a-z0-9-]+/gi, '-').toLowerCase() : 'index'
        const file = kind === 'product' ? path.join(root, PRODUCT_FILE) : kind === 'design' ? path.join(root, DESIGN_FILE) : path.join(root, SURFACES_DIR, slug + '.md')
        if (action === 'read') {
          if (!existsSync(file)) return { text: 'No ' + kind + ' artifact at ' + file + '.', view: { kind: 'frontend-artifact', ok: false, action, artifact: kind, path: file } }
          const text = readBounded(file)
          const validation = kind === 'product' ? validateProduct(text) : kind === 'design' ? validateDesign(text) : validateSurface(text)
          return {
            text: 'validation: ' + (validation.ok ? 'ok' : 'INCOMPLETE — ' + validation.problems.join('; ')) + '\n\n' + text,
            view: { kind: 'frontend-artifact', ok: validation.ok, action, artifact: kind, slug: kind === 'surface' ? slug : null, path: file, validation },
          }
        }
        if (action !== 'write') return { text: '`action` is read or write.', view: { kind: 'frontend-artifact', ok: false } }
        const body = typeof args.body === 'string' ? args.body : ''
        if (body.trim() === '') return { text: 'A write needs `body`: the complete markdown.', view: { kind: 'frontend-artifact', ok: false, action, artifact: kind } }
        const validation = kind === 'product' ? validateProduct(body) : kind === 'design' ? validateDesign(body) : validateSurface(body)
        if (!validation.ok) {
          return {
            text:
              'Refused: the ' + kind + ' artifact would not have the shape the skill expects — ' + validation.problems.join('; ') + '. Fix these and write it again; nothing was written.',
            view: { kind: 'frontend-artifact', ok: false, action, artifact: kind, path: file, validation },
          }
        }
        if (existsSync(file) && args.overwrite !== true) {
          return {
            text:
              'Refused: ' + file + ' already exists and `overwrite` was not set. Read it first (`action: "read"`); replace it only with the person’s confirmation, because this file is durable product or visual truth.',
            view: { kind: 'frontend-artifact', ok: false, action, artifact: kind, path: file, validation, exists: true },
          }
        }
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, body.endsWith('\n') ? body : body + '\n', 'utf8')
        return {
          text: 'wrote ' + file + '\nvalidation: ok',
          view: { kind: 'frontend-artifact', ok: true, action, artifact: kind, slug: kind === 'surface' ? slug : null, path: file, validation },
        }
      } catch (err) {
        const message = err instanceof FrontendError || (err && err.message) ? String(err.message) : String(err)
        return { text: message, view: { kind: 'frontend-artifact', ok: false, error: message } }
      }
    },
  }

  return [contextTool, detectTool, directionTool, renderTool, artifactTool]
}

function readBounded(file) {
  const stats = statSync(file)
  const text = readFileSync(file, 'utf8')
  if (stats.size <= MAX_ARTIFACT_BYTES) return text
  return text.slice(0, MAX_ARTIFACT_BYTES) + '\n\n… truncated at ' + MAX_ARTIFACT_BYTES + ' characters; open the file for the rest.'
}

/** Exported for the checks: the rules a scan can fire, and the corpus pin. */
export const __internals = { scanTarget, scanText, contextText, corpusLine, RULE_COUNT, RULES }
