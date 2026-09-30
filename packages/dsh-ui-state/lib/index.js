/**
 * dsh-ui-state - Node half.
 *
 * The pack remembers what a reload would otherwise forget. Everything that
 * survives a restart today does so because it already lives on the HOST:
 * `$DSH_HOME/sessions` holds the conversations (which is why a new chat opens
 * the last one), `$DSH_HOME/storages/workspace.json` holds the workspaces, and
 * the profile's own patch document holds the shipped preferences (the
 * light/dark/system theme, the content font size, the model and its reasoning
 * effort). Everything the interface forgets lives in the BROWSER instead - and
 * there it is per ORIGIN and per browser PROFILE, so a Chrome tab and the
 * desktop window's WebView2 have never been able to share it, and the desktop
 * shell picks port 3080 only when it is free, so even one host can lose it by
 * moving a port.
 *
 * This row makes the pack's own UI state HOST state, through the harness's own
 * preference medium. Since `@deepseek-ai/dsh` 0.2.0 the settings subsystem is a
 * form over the ACTIVE PROFILE'S ENTRIES: a plugin declares the fields it wants
 * kept by marking them `.volatile()` in its exported `Config`, the Host projects
 * that schema into a form keyed by the entry's own id, and an accepted write is
 * persisted into the profile's Cordis patch (`$DSH_HOME/profiles/web/
 * cordis.patch.yml`) as that entry's `config`:
 *
 *   - id: ui-state
 *     config:
 *       pageZoom: 125
 *       theme: nord
 *       dockHeight: 340
 *       sidebarWidth: 300
 *
 * The predecessor of that mechanism was a settings NAMESPACE a plugin registered
 * with a schemastery schema (`settings.register('vncode', schema)`, read back
 * through `settings.get('vncode')` and bound in the browser with
 * `ctx.get('settingsScope').bind({ namespace })`). 0.2.0 removed both halves -
 * `dsh-settings` publishes no `register`, the client tree publishes no
 * `settingsScope` service, and a `$DSH_HOME/settings.yaml` left by an earlier
 * release is imported ONCE into the entries of the same id and renamed to
 * `settings.yaml.imported` (a section whose id names no active entry, like the
 * old `vncode`, is logged and stays only in the renamed file). A form over this
 * row's own entry is the documented replacement, so the field NAMES and their
 * defaults are unchanged and only their address moved: the browser half now
 * binds `ctx.configForms.get('ui-state')`.
 *
 * WHY SCHEMASTERY IS RESOLVED AND NOT IMPORTED. This pack ships zero npm
 * dependencies and every other Node half imports only `node:*` builtins: the
 * web profile installs each bundle as a LIVE LINK into the repo, so a bare
 * `import '@deepseek-ai/schemastery'` resolves from the repo folder and fails
 * with ERR_MODULE_NOT_FOUND (measured). The module is therefore loaded at
 * runtime through the anchors `packages/dsh-terminal/lib/pty.js` established for
 * the harness's own node-pty: the running entry, then `$DSH_HOME/profiles` -
 * which `dsh-app-boot` keeps as a mirror of the installation's dependency
 * closure, so Node's ordinary parent walk finds the very same copy the harness
 * itself loaded. The CJS build is what makes `createRequire` work here
 * (schemastery is `type: module` but publishes `exports.require`), and duck
 * typing is what makes it safe: the form projection treats the schema as a
 * value and reads `schema.toJSON()`, so it never compares class identity across
 * the two module graphs. A host with no reachable copy declares no `Config` and
 * therefore remembers nothing, which is exactly what the browser half falls back
 * to - the row still loads.
 *
 * The second job is the page zoom. A zoom that arrives after the client boots is
 * a visible reflow of the whole shell, so - exactly like ui-theme's own theme
 * bootstrap - the remembered level is inlined into the page as a script row
 * before the shell mounts, read from the LIVE form value on every index render
 * so it tracks a settings write without a restart. That is what keeps "the zoom
 * I left it at" from costing a jump on every launch.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-ui-state'

/**
 * The profile entry id this row is inserted under (see `cordis.patch.yml`), and
 * with it the name of the settings form the browser half binds. Keep in sync
 * with the client's `ENTRY_ID` and with the row id in the bundle layer: the
 * projection is keyed by the ENTRY's id, so a mismatch is a form that reads as
 * "unavailable" and a pack that remembers nothing.
 */
const ENTRY_ID = 'ui-state'

/**
 * The namespace's field defaults, and the "nothing remembered yet" state. They
 * must stay in step with the client's `DEFAULTS`, because the form resolves
 * every field to its schema default and the browser half reads the resolved
 * section:
 *
 *   - `theme: ''` - no extension theme is remembered. Light/dark/system are NOT
 *     stored here: ui-theme already persists those durably in its own form, and
 *     duplicating the preference would give one setting two owners that could
 *     disagree.
 *   - `pageZoom: 100` - the resting level, at which no declaration is written.
 *   - `dockHeight: 280` - dsh-terminal's own contract height.
 *   - `sidebarWidth` / `rightbarWidth: -1` - NEGATIVE means "this host has never
 *     recorded a width", which is deliberately not the same as 0: for the
 *     sidebar 0 is a real state (collapsed), so a sentinel is the only way to
 *     say "leave the layout's own contract default alone" without lying about a
 *     width nobody ever chose.
 *
 * There is deliberately NO field for the terminal dock's OPEN state. The panel
 * is the window onto a PROCESS: after a reload the client holds no slots, so
 * reopening it would either show an empty panel or, once the server's five
 * minute PTY retention has lapsed, START a shell nobody asked for. A height is
 * a preference; "a shell was running" is not.
 */
const FIELD_DEFAULTS = {
  theme: '',
  pageZoom: 100,
  dockHeight: 280,
  sidebarWidth: -1,
  rightbarWidth: -1,
}

/** The ladder's ends, so a hand-edited document cannot ask for an unreadable page. */
const ZOOM_MIN = 50
const ZOOM_MAX = 200

/** The marker a live zoom writes on the document element; keep in sync with dsh-themes. */
const ZOOM_MARKER = 'data-dsh-page-zoomed'

/**
 * The harness config root: `$DSH_HOME`, else `~/.dsh` (the resolution the
 * installer, dsh-terminal, dsh-diagrams and `dsh-skill-filesystem` all use).
 * @param env - environment to read.
 * @returns {string} the absolute DSH home path.
 */
function resolveHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * Every place the harness's own schemastery can be reached from, in order. A
 * missing anchor is simply skipped, and - the whole point of the profiles
 * anchor - the file itself need not exist, because `createRequire` uses its
 * DIRECTORY for the parent walk.
 * @returns {string[]} candidate anchor files.
 */
function schemasteryAnchors() {
  const anchors = []
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') anchors.push(entry)
  anchors.push(path.join(resolveHome(), 'profiles', 'index.js'))
  anchors.push(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'))
  return anchors
}

/**
 * Whether a resolved copy of schemastery can declare what this row needs. The
 * pinned line ships schemastery 3.18.4, whose `.volatile()` is what puts a field
 * into the form the browser half binds; the 3.18.2 build an earlier line
 * installed has no such method, and a stale `$DSH_HOME/profiles/node_modules`
 * mirror is exactly what the parent walk finds when the running entry is not the
 * harness's own (measured: that mirror held 0.1.5-rc.1's schemastery on the
 * machine this was written on, while the running line's own copy sat in the npx
 * cache beside it). A copy that cannot declare a volatile field is not a copy
 * this row can use, so it is passed over instead of crashing the module at
 * import time - which is what `z.string().default('').volatile()` would do.
 * @param z - a candidate schema builder.
 * @returns {boolean} whether it carries `.volatile()`.
 */
function canDeclareVolatileFields(z) {
  try {
    return typeof z.string().default('').volatile === 'function'
  } catch (err) {
    return false
  }
}

/**
 * Load the harness's own schemastery through the anchors above.
 * @returns {object|null} the schema builder (`z`), or `null` when this host has
 *   no reachable copy - in which case the row declares no form at all and
 *   degrades to "nothing is remembered" instead of failing the boot.
 */
function loadSchemastery() {
  const seen = new Set()
  for (const anchor of schemasteryAnchors()) {
    if (seen.has(anchor)) continue
    seen.add(anchor)
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery')
      const z = loaded && typeof loaded.object === 'function' ? loaded : loaded && loaded.default
      if (z && typeof z.object === 'function' && canDeclareVolatileFields(z)) return z
    } catch (err) {
      /* try the next anchor */
    }
  }
  return null
}

const z = loadSchemastery()

/**
 * The row's Config: the pack's own remembered fields, every one of them
 * `.volatile()`. Volatility is what puts a field into the Host's form
 * projection - a plain field stays ordinary configuration, is not editable
 * through a form, and would never be written back to the profile patch - so
 * this is the one thing that has to be right for the state to persist at all.
 *
 * The whole schema is `undefined` when schemastery is unreachable: a row with no
 * Config is a row with no form, which is the honest degradation this pack
 * already had for a host without the settings transport.
 */
export const Config =
  z === null
    ? undefined
    : z.object({
        theme: z.string().default(FIELD_DEFAULTS.theme).volatile(),
        pageZoom: z.number().step(1).min(ZOOM_MIN).max(ZOOM_MAX).default(FIELD_DEFAULTS.pageZoom).volatile(),
        dockHeight: z.number().step(1).min(120).max(4000).default(FIELD_DEFAULTS.dockHeight).volatile(),
        sidebarWidth: z.number().step(1).min(-1).max(4096).default(FIELD_DEFAULTS.sidebarWidth).volatile(),
        rightbarWidth: z.number().step(1).min(-1).max(4096).default(FIELD_DEFAULTS.rightbarWidth).volatile(),
      })

/**
 * The page-zoom level as the HOST currently resolves it, for the boot row. The
 * live form value already carries the schema default, so an unreadable or absent
 * config simply means the resting level, exactly like ui-theme's own
 * `config.preference.get()`.
 * @param config - the validated live Config (a value accessor per field).
 * @returns {number} the level to inline.
 */
function readZoom(config) {
  try {
    const live = config ? config.pageZoom : undefined
    const raw = live && typeof live.get === 'function' ? live.get() : undefined
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : FIELD_DEFAULTS.pageZoom
    return Math.min(Math.max(Math.round(value), ZOOM_MIN), ZOOM_MAX)
  } catch (err) {
    return FIELD_DEFAULTS.pageZoom
  }
}

/**
 * The inline script that applies the remembered zoom before the shell mounts.
 *
 * It writes the SAME two things the client's own `applyZoom` writes - the `zoom`
 * declaration and the `data-dsh-page-zoomed` marker beside it - because the
 * marker is a contract, not a decoration: dsh-themes' alpha.16 right-bar seam
 * fix is gated on it, and a boot script that set the zoom without it would put
 * the seam 288px off the right column's edge (at 80% on a 1440px frame) for the
 * whole interval before the client applies the same level again.
 *
 * @param level - the validated level, already inside the ladder.
 * @returns {string} the script body.
 */
function bootZoomScript(level) {
  return `(() => {
  const level = ${JSON.stringify(level)}
  const root = document.documentElement
  if (level === 100) {
    root.style.removeProperty('zoom')
    root.removeAttribute(${JSON.stringify(ZOOM_MARKER)})
    return
  }
  root.style.zoom = String(level) + '%'
  root.setAttribute(${JSON.stringify(ZOOM_MARKER)}, String(level))
})()`
}

/**
 * Activate the plugin row: own the row's form policy, and answer every index
 * injection collection with the remembered page zoom.
 *
 * The policy is registered inside `ctx.inject(['settings'], ...)` rather than
 * declared in the row's own `inject` array so a composition without a settings
 * provider still loads this row - the fields are ordinary Config either way, and
 * only the OPT-OUT below needs the service.
 *
 * `auto: false` says this row ships no settings page of its own, so the Host
 * must not generate one from the schema: these fields are the interface's own
 * memory (a zoom, two widths, a dock height), not preferences a person is meant
 * to browse, and the values stay hand-editable in the profile patch exactly as
 * the old `settings.yaml` section was. No shipped client builds pages from
 * `autoGenerate` yet, so this is a statement about intent rather than a visible
 * change - which is precisely why it belongs here, before one does.
 *
 * @param ctx - cordis context.
 * @param config - the validated live Config, when this host could declare one.
 */
export function apply(ctx, config) {
  if (Config === undefined) {
    ctx.logger?.warn?.(
      '[dsh-ui-state] no reachable @deepseek-ai/schemastery that carries `.volatile()` (the pinned line ships ' +
        '3.18.4; a stale $DSH_HOME/profiles/node_modules mirror can hold an older build); the ' +
        ENTRY_ID +
        ' settings form is not declared and the pack remembers nothing',
    )
  }

  ctx.inject(['settings'], (child) => {
    const settings = child ? child.settings : undefined
    if (!settings || typeof settings.configure !== 'function') return
    child.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })

  // The zoom bootstrap: one inline script immediately after the opening body
  // tag, before the shell mount, so the level is in force for the first paint.
  ctx.on('webserver/index-inject', (table) => {
    const level = readZoom(config)
    if (level === FIELD_DEFAULTS.pageZoom) return
    table.push({ kind: 'script', placement: 'body', text: bootZoomScript(level) })
  })
}

/** The entry id the browser half binds; exported so a check can pin the pair. */
export { ENTRY_ID, FIELD_DEFAULTS, ZOOM_MIN, ZOOM_MAX }
