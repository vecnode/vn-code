/**
 * dsh-proto-lab — the runtime registry, which is the whole point of the package.
 *
 * "Where do prototypes go" and "what language is this prototype in" are two
 * different questions, and keeping them apart is what makes this lab growable.
 * The lab owns the first (a folder, a catalog, a path policy). A RUNTIME owns
 * the second, and a runtime is one module exporting one object with five
 * functions: where its toolchain is, what a new run's files are, whether a run
 * it wrote is still right, which committed examples it ships, and where the
 * library bytes a run needs come from.
 *
 * Adding the third runtime is therefore mechanical, and it is the reason the
 * list below is a list and not a `switch`:
 *
 *   1. write `lib/runtimes/<id>.js` with the same exports this file documents
 *      (copy `_template.js`, which is the contract with the blanks filled in);
 *   2. import it here and add it to `RUNTIME_MODULES`, one line;
 *   3. point its `examples` at a folder beside the skill that teaches it, and
 *      give it a skill: `skills/<id>-prototypes/SKILL.md`;
 *   4. run `npm run check` in this package - the registry check drives every
 *      registered runtime's scaffold, lint and examples, so a runtime that is
 *      registered is a runtime that is tested.
 *
 * Nothing else in the package knows a language. That is what a "Processing in
 * Rust" or a "Cinder" runtime costs: one file, one skill, one line here.
 */

import { LabError } from '../lab.js'
import openframeworks from './openframeworks.js'
import p5js from './p5js.js'

/**
 * Every runtime this build knows, in the order a person should meet them.
 *
 * p5.js first on purpose: it is the one that needs nothing installed, so it is
 * the runtime that always works, and a run in it is visible in the preview tab
 * the moment it is written.
 */
const RUNTIME_MODULES = [p5js, openframeworks]

/** Every registered runtime, in order, validated once at first use. */
let cached = null

/**
 * The contract every runtime must satisfy.
 *
 * @returns `{ entries, problems }` - problems are reported rather than thrown,
 *   because a broken third-party runtime should cost its own row and not the
 *   whole row's tools.
 */
export function runtimes() {
  if (cached !== null) return cached
  const entries = []
  const problems = []
  for (const spec of RUNTIME_MODULES) {
    const missing = []
    if (typeof spec?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(spec.id)) missing.push('id')
    if (typeof spec?.label !== 'string' || spec.label === '') missing.push('label')
    if (spec?.kind !== 'web' && spec?.kind !== 'native') missing.push('kind ("web" or "native")')
    if (!Array.isArray(spec?.extensions) || spec.extensions.length === 0) missing.push('extensions')
    for (const method of ['detect', 'scaffold', 'lint', 'examples']) {
      if (typeof spec?.[method] !== 'function') missing.push(method + '()')
    }
    if (missing.length > 0) {
      problems.push('a runtime module is missing: ' + missing.join(', '))
      continue
    }
    entries.push(spec)
  }
  cached = { entries, problems }
  return cached
}

/**
 * One runtime by id.
 *
 * @param id - the runtime name (`p5js`).
 * @returns the runtime.
 * @throws LabError naming what IS available, because that is the useful half.
 */
export function runtimeOf(id) {
  const { entries } = runtimes()
  const found = entries.find((entry) => entry.id === id)
  if (found === undefined) {
    throw new LabError('there is no runtime called ' + JSON.stringify(id) + ' - available: ' + entries.map((entry) => entry.id).join(', '), 'NO_SUCH_RUNTIME')
  }
  return found
}

/** Every registered runtime's id, for the routing inside `lab_runtimes`. */
export function runtimeIds() {
  return runtimes().entries.map((entry) => entry.id)
}
