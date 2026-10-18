/**
 * dsh-frontend-craft — the three artifacts the skill reads before it designs.
 *
 * The split is Impeccable's, and it is the part that keeps a run honest:
 *
 *   PRODUCT.md   durable product truth (who, what, why, constraints). No colours,
 *                no type, no layout: a visual direction living here is a bug.
 *   DESIGN.md    durable visual truth (tokens, type voices, materials).
 *   .frontend-craft/surfaces/<slug>.md
 *                one surface's strategy and its direction contract - the six
 *                blocks the finish review audits the render against.
 *
 * This module reads them, validates their SHAPE, and says what is missing. It
 * never invents a section and never rewrites one: a validator that filled gaps
 * would make `fe_context` a second author of product truth.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Where the durable files live, relative to the project root. */
export const PRODUCT_FILE = 'PRODUCT.md'
export const DESIGN_FILE = 'DESIGN.md'
export const STATE_DIR = '.frontend-craft'
export const SURFACES_DIR = STATE_DIR + '/surfaces'
export const CONFIG_FILE = STATE_DIR + '/config.json'

/** How much of one artifact a tool result carries. */
export const MAX_ARTIFACT_BYTES = 256 * 1024

/** The schema stamp PRODUCT.md carries, so drift is measurable. */
export const PRODUCT_SCHEMA = 1

/** The six blocks a direction contract must provide, and the FINISH line. */
export const CONTRACT_BLOCKS = ['THESIS:', 'OWN-WORLD:', 'STORY:', 'FIRST VIEWPORT:', 'FORM:', 'FINISH:']

/** Read a file as text, or `null` when it is not a readable regular file. */
export function readIfPresent(file, cap = MAX_ARTIFACT_BYTES) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null
    if (statSync(file).size > cap) return null
    return readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
}

/** The bare value of a `## Heading` section: its first non-empty line. */
export function sectionValue(text, heading) {
  const pattern = new RegExp('^##\\s+' + heading + '\\s*$', 'im')
  const match = pattern.exec(text)
  if (!match) return null
  const rest = text.slice(match.index + match[0].length)
  for (const line of rest.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) return null
    return trimmed
  }
  return null
}

/** Which delivery target PRODUCT.md records. Missing means web (upstream's default). */
export function platformOf(productText) {
  if (typeof productText !== 'string' || productText === '') return 'web'
  const value = sectionValue(productText, 'Platform')
  if (value === null) return 'web'
  const lowered = value.toLowerCase()
  if (lowered.startsWith('ios') && lowered.includes('android')) return 'adaptive'
  if (lowered.startsWith('ios')) return 'ios'
  if (lowered.startsWith('android')) return 'android'
  if (lowered.startsWith('adaptive')) return 'adaptive'
  if (lowered.startsWith('web')) return 'web'
  return 'web'
}

/** The stamp's schema number, or null when there is no stamp. */
export function productSchemaOf(text) {
  const match = /<!--\s*frontend-craft:product-schema\s+(\d+)\s*-->/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Validate PRODUCT.md's SHAPE. Product truth is a human's to judge; this only
 * answers "is this the document the skill expects".
 */
export function validateProduct(text) {
  const problems = []
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, problems: ['PRODUCT.md is empty.'] }
  if (!/^#\s+\S/m.test(text)) problems.push('no `# Product` heading')
  const schema = productSchemaOf(text)
  // A missing stamp is CONTEXT_STALE, not an incomplete document: it is reported
  // once, at the context level, and never repaired as a side effect.
  if (schema !== null && schema !== PRODUCT_SCHEMA) problems.push('schema ' + schema + ' is not ' + PRODUCT_SCHEMA)
  for (const heading of ['Platform', 'Users', 'Product Purpose']) {
    if (!new RegExp('^##\\s+' + heading + '\\s*$', 'im').test(text)) problems.push('no `## ' + heading + '` section')
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Validate DESIGN.md's shape: YAML frontmatter plus at least one system section.
 * The token vocabulary itself follows the external design.md spec, which is why
 * the file is not stamped with our schema.
 */
export function validateDesign(text) {
  const problems = []
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, problems: ['DESIGN.md is empty.'] }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!frontmatter) problems.push('no YAML frontmatter')
  else {
    const keys = frontmatter[1]
      .split('\n')
      .map((line) => /^([A-Za-z][\w-]*)\s*:/.exec(line))
      .filter(Boolean)
      .map((match) => match[1].toLowerCase())
    const known = ['colors', 'typography', 'spacing', 'components', 'name', 'rounded', 'radius', 'shadows', 'motion']
    if (!keys.some((key) => known.includes(key))) problems.push('frontmatter names none of: ' + known.join(', '))
  }
  if (!/^#\s+\S/m.test(text)) problems.push('no H1')
  return { ok: problems.length === 0, problems }
}

/**
 * Validate a surface brief: the six contract blocks, and a seed line that says
 * whether the roll produced one (upstream records `seed: none (unavailable)`
 * rather than omitting the line, which is the shape checked here).
 */
export function validateSurface(text) {
  const problems = []
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, problems: ['The brief is empty.'] }
  if (!/^##\s+Direction contract\s*$/im.test(text)) problems.push('no `## Direction contract` section')
  for (const block of CONTRACT_BLOCKS) {
    if (!new RegExp('^' + block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\S', 'im').test(text)) problems.push('no `' + block + '` line')
  }
  if (!/^seed:\s*\S/im.test(text)) problems.push('no `seed:` line (write `seed: none (unavailable)` when no roll ran)')
  return { ok: problems.length === 0, problems }
}

/** The config's detector section, with defaults. */
export function detectorConfigOf(config) {
  const detector = config && typeof config === 'object' && config.detector && typeof config.detector === 'object' ? config.detector : {}
  return {
    ignoreRules: Array.isArray(detector.ignoreRules) ? detector.ignoreRules.map(String) : [],
    ignoreFiles: Array.isArray(detector.ignoreFiles) ? detector.ignoreFiles.map(String) : [],
    ignoreValues: Array.isArray(detector.ignoreValues) ? detector.ignoreValues.map(String) : [],
    designSystem: detector.designSystem && detector.designSystem.enabled === false ? false : true,
  }
}

/**
 * Read the project's context. Missing artifacts are `null`, never an error: a
 * greenfield project is a legitimate state, and the directives say what it means.
 *
 * @param root - the project root (an absolute directory).
 */
export function readContext(root) {
  const productPath = path.join(root, PRODUCT_FILE)
  const designPath = path.join(root, DESIGN_FILE)
  const configPath = path.join(root, CONFIG_FILE)
  const surfacesPath = path.join(root, SURFACES_DIR)

  const productText = readIfPresent(productPath)
  const designText = readIfPresent(designPath)
  const configText = readIfPresent(configPath)

  let config = null
  let configProblem = null
  if (configText !== null) {
    try {
      config = JSON.parse(configText)
    } catch (err) {
      configProblem = 'config.json is not valid JSON: ' + String(err && err.message ? err.message : err)
    }
  }

  const briefs = []
  if (existsSync(surfacesPath) && statSync(surfacesPath).isDirectory()) {
    for (const name of readdirSafe(surfacesPath)) {
      if (!name.endsWith('.md')) continue
      const file = path.join(surfacesPath, name)
      const text = readIfPresent(file)
      if (text === null) continue
      const validation = validateSurface(text)
      briefs.push({ slug: name.replace(/\.md$/, ''), path: file, bytes: text.length, ...validation })
    }
    briefs.sort((a, b) => (a.slug < b.slug ? -1 : 1))
  }

  const product = productText === null ? null : {
    path: productPath,
    text: productText,
    bytes: productText.length,
    schema: productSchemaOf(productText),
    platform: platformOf(productText),
    stack: sectionValue(productText, 'Stack'),
    ...validateProduct(productText),
  }
  const design = designText === null ? null : {
    path: designPath,
    text: designText,
    bytes: designText.length,
    ...validateDesign(designText),
  }

  return {
    root,
    product,
    design,
    config: { path: configPath, present: configText !== null, problem: configProblem, detector: detectorConfigOf(config) },
    briefs,
    platform: product === null ? 'web' : product.platform,
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch (err) {
    return []
  }
}

/**
 * What the boot says must happen next. Severity follows upstream's own words:
 * `route` names the command that owns the repair, `mention` is stated once,
 * `auto` is a repair the next write performs anyway.
 */
export function directivesFor(context) {
  const directives = []
  if (context.product === null) {
    directives.push({
      id: 'ROUTE_INIT',
      severity: 'route',
      message: 'No PRODUCT.md. Run the `init` command first: it interviews for product truth (users, purpose, positioning, constraints, platform, stack) and writes PRODUCT.md. Do not ask for colours, typography or visual direction during init.',
    })
  } else if (context.product.schema === null) {
    directives.push({
      id: 'CONTEXT_STALE',
      severity: 'mention',
      message: 'PRODUCT.md carries no `frontend-craft:product-schema` stamp (it may have been written by Impeccable itself). Report it and carry on; do not repair it as a side effect of a design task.',
    })
  } else if (!context.product.ok) {
    directives.push({
      id: 'PRODUCT_INCOMPLETE',
      severity: 'route',
      message: 'PRODUCT.md is missing required shape: ' + context.product.problems.join('; ') + '. Repair it before designing (init owns this file).',
    })
  }
  if (context.design === null) {
    directives.push({
      id: 'NO_DESIGN_MD',
      severity: 'route',
      message: 'No DESIGN.md. A missing DESIGN.md does NOT make the project greenfield: read the incumbent tokens, components and assets. If a coherent identity is already in code, `document` records it; if there is none, `new-work` creates one. Never invent a replacement before deciding which this is.',
    })
  } else if (!context.design.ok) {
    directives.push({
      id: 'DESIGN_INCOMPLETE',
      severity: 'route',
      message: 'DESIGN.md is missing required shape: ' + context.design.problems.join('; ') + '. Repair it with `document` rather than designing against a half-recorded system.',
    })
  }
  if (context.config.problem !== null) {
    directives.push({ id: 'CONFIG_INVALID', severity: 'mention', message: context.config.problem + ' Detector ignores are not applied until it parses.' })
  } else if (!context.config.present) {
    directives.push({ id: 'NO_CONFIG', severity: 'mention', message: 'No .frontend-craft/config.json; every detector rule is active and no ignore is in force.' })
  }
  for (const brief of context.briefs) {
    if (!brief.ok) {
      directives.push({
        id: 'BRIEF_INCOMPLETE',
        severity: 'route',
        message: 'The `' + brief.slug + '` brief is missing: ' + brief.problems.join('; ') + '. Rewrite it before building that surface.',
      })
    }
  }
  return directives
}
