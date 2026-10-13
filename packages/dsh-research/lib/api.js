/**
 * dsh-research — the route vocabulary.
 *
 * ONE list, because two places need it and they must agree: the row registers
 * these paths, and `stateView` reports them as what this build offers. A path
 * spelled in one place and reported from another is how a panel ends up calling a
 * route that does not exist.
 *
 * Routes are EXACT paths (the pack's rule): no wildcards, no patterns, `GET`/
 * `HEAD`/`POST` only, and every one of them sits behind the harness's own session
 * check because the `connection` service is what mounts them.
 */

/** Every route this plugin owns. */
export const API_ROOT = '/api/dsh-research'
/** The run list the tab opens with. */
export const STATE_ROUTE = API_ROOT + '/state'
/** One run in one round trip, because the panel polls it while the agent works. */
export const PROJECT_ROUTE = API_ROOT + '/project'
/** The one route that writes: answering a gate. */
export const GATE_ROUTE = API_ROOT + '/gate'
/** One source: its record, and its stored text. */
export const SOURCE_ROUTE = API_ROOT + '/source'
/** A built artifact's bytes, for a download or a look. */
export const ARTIFACT_ROUTE = API_ROOT + '/artifact'
/** Build a format - the same code path the `rs_build` tool drives. */
export const BUILD_ROUTE = API_ROOT + '/build'
/**
 * Save ONE text file inside a run, from the panel.
 *
 * This route exists because a person editing their own paper is not the same act
 * as an agent writing one: `rs_write` REFUSES prose whose claims are undeclared,
 * and it is the agent's gate. A human edit is not refused - it is CHECKED, and the
 * route answers with the structure verdict so the panel can show what the edit
 * changed about the ledger's agreement with the document. Refusing to let someone
 * fix a typo in their own file would be the wrong kind of strict.
 */
export const FILE_ROUTE = API_ROOT + '/file'
/** The snapshot the tracked checks read. */
export const HEALTH_ROUTE = API_ROOT + '/health'

/** All of them, in the order the design lists them. */
export const API_ROUTES = [STATE_ROUTE, PROJECT_ROUTE, GATE_ROUTE, SOURCE_ROUTE, ARTIFACT_ROUTE, FILE_ROUTE, BUILD_ROUTE, HEALTH_ROUTE]
