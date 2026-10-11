/**
 * dsh-proto-lab — THE RUNTIME CONTRACT, with the blanks filled in.
 *
 * Copy this file to `lib/runtimes/<id>.js`, fill in the five functions, import it
 * in `lib/runtimes/index.js` and add it to `RUNTIME_MODULES`. That is the whole
 * procedure for adding a language to the lab; the lab's own rules (the folder, the
 * catalog, the path policy, the size caps, the README and the NOTES) are applied
 * by `lib/lab.js` and cannot be forgotten here.
 *
 * The file is deliberately not registered: a runtime that has never run is worse
 * than a runtime that is honestly absent, because the tools would offer a language
 * whose files nothing has ever parsed. It is kept as documentation that compiles
 * the day somebody uncomments it, and `checks/check-lab-node.mjs` asserts the
 * contract it documents is the contract the registered runtimes satisfy.
 *
 * THE TWO SHAPES YOU NEED
 *
 *   scaffold() returns an array of `{ path, content }`:
 *     - `path` is relative to the run folder, forward slashes, no `..`;
 *     - `content` is a string or a Buffer (a library's bytes, an image);
 *     - the placeholders `{{SLUG}} {{LABEL}} {{CONCEPT}} {{SEED}} {{PARAMS_JSON}}
 *       {{SEED_JSON}} {{RUNTIME}}` are substituted from the spec for you, so the
 *       files can be written as real source on disk under `templates/` and edited
 *       by hand - which is what makes a generated run editable the day after.
 *
 *   lint() returns an array of `{ severity, code, message, file }`:
 *     - `severity` is 'error' (this is not a prototype in this language) or
 *       'warn'  (it is, but something about it will not work as well);
 *     - `code` is stable and lowercase - a check asserts on it;
 *     - be specific: "sketch.js defines no `draw()`" is a fix, "invalid" is not.
 *
 * WHAT `examples()` POINTS AT
 *
 * The example library is the part meant to grow. Each example is a folder of the
 * same files `scaffold()` would write, kept beside the skill that teaches the
 * runtime - `skills/<id>-prototypes/examples/<slug>/` - with an `example.json`
 * carrying `{ slug, label, concept, seed }`. They are committed, checked and
 * instantiable through `lab_new action=example`, so a good run made in the lab
 * can be promoted into the library by hand and then be available forever.
 */

/** The id is the folder name under `lab/` and the runtime's name in every tool. */
export const id = 'CHANGEME'
/** The label a person reads in `lab_runtimes`. */
export const label = 'Change me'
/** 'web' (a browser draws it) or 'native' (a toolchain builds it). */
export const kind = 'web'
/** One line on what this runtime is for, shown by `lab_runtimes`. */
export const tagline = 'One line.'
/** The file extensions a run in this runtime is expected to contain. */
export const extensions = ['.txt']

/**
 * Where this runtime's toolchain is, or why there is nothing to find.
 *
 * Called on every `lab_runtimes info`, so it must be cheap and must never throw:
 * a runtime with no toolchain is the normal state on most machines, and the
 * answer is what the tool prints.
 *
 * @param options - `{ env }`.
 * @returns `{ available, summary, detail, commands }`.
 */
export async function detect(options = {}) {
  const env = options.env ?? process.env
  return {
    available: true,
    summary: 'nothing to find - this runtime needs no toolchain',
    detail: [],
    commands: [],
  }
}

/**
 * Every file of a new run.
 *
 * @param spec - `{ slug, id, concept, seed, params, env }`.
 * @returns `{ path, content }[]`.
 */
export async function scaffold(spec) {
  return [
    { path: 'README.md', content: '# ' + spec.slug + '\n' },
    { path: 'NOTES.md', content: '- seed: ' + spec.seed + '\n' },
  ]
}

/**
 * Whether a run is still a prototype in this runtime.
 *
 * @param run - `{ dir, files, bytes, env }`.
 * @returns `{ severity, code, message, file }[]`.
 */
export async function lint(run) {
  return []
}

/**
 * The committed examples this runtime ships, beside its skill.
 *
 * @param options - `{ kitDir }` - the `<id>-prototypes` skill's folder.
 * @returns `{ id, slug, label, concept, seed, dir, files }[]`.
 */
export async function examples(options = {}) {
  return []
}

/**
 * The library bytes a run needs, when the runtime needs any.
 *
 * p5.js and openFrameworks answer differently and both are correct: p5 copies
 * the vendored `p5.min.js` into the run (a run is self-contained on disk, and a
 * CDN would be network egress), while openFrameworks ships none - its library is
 * the user's own install and its `Makefile` links it.
 *
 * @returns `{ path, content }[]`.
 */
export async function library() {
  return []
}
