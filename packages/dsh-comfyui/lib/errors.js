/**
 * dsh-comfyui — the error vocabulary.
 *
 * Every refusal names the thing that would go WRONG and the next move, because
 * the caller is an agent that reads one sentence and acts: a project that does
 * not build, a graph that would be rejected by `/prompt`, or a server that is
 * not there are different problems with different fixes, and a single generic
 * "failed" collapses them into a guess.
 *
 * The codes are the branch points the package check drives, and the ones a
 * tool view exposes as `code` so a caller can decide without reading prose.
 */

/** One typed refusal. `extra` travels to the view untouched. */
export class ComfyError extends Error {
  /**
   * @param code - a stable code, e.g. 'SERVER_DOWN', 'PROJECT_INVALID'.
   * @param message - the sentence the caller acts on.
   * @param extra - facts the view carries (path, node, field, ...).
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ComfyError'
    this.code = code
    this.extra = extra
  }
}

/** The sentence of any thrown value, without inventing one. */
export function messageOf(error) {
  if (error === null || error === undefined) return 'unknown failure'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** The code of any thrown value, or 'FAILED'. */
export function codeOf(error) {
  return error && typeof error.code === 'string' && error.code !== '' ? error.code : 'FAILED'
}

/**
 * A validation finding, in the shape ComfyUI's own validator uses.
 *
 * `type` is deliberately the SAME string `/prompt` returns (`required_input_missing`,
 * `return_type_mismatch`, `value_not_in_list`, `dependency_cycle`, ...): a
 * project that fails here would fail there, and a reader should not have to
 * translate between two vocabularies for the same defect. `where` is the extra
 * this row adds - the node KEY the spec uses and the input name - because
 * "node 7" is not searchable in the file the person is editing.
 */
export function finding(severity, type, message, where = {}) {
  return { severity, type, message, ...where }
}

/** All the errors of a finding list, for a one-line summary. */
export function countBy(findings, severity) {
  return findings.filter((entry) => entry.severity === severity).length
}
