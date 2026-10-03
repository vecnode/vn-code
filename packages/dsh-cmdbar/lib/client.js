/**
 * dsh-cmdbar — browser half.
 *
 * A **bottom dock**, not a tab: one horizontal panel at the foot of the app,
 * showing the agent's own command activity. It starts at the right edge of the
 * left bar, runs to the full width of the page, and sits UNDERNEATH the middle
 * and right columns — which make room for it rather than being covered.
 *
 *   - It is opened by a **header button** registered into
 *     `conversation.session.header.utilities` at `order: 30`, i.e. immediately
 *     right of the shipped **Open In...** (-10) and left of the right bar's own
 *     toggle, which owns the single-occupant `...header.corner` seat beside it.
 *     The glyph is drawn here (primitives ships no terminal icon), and the only
 *     primitive this bundle uses is `Tooltip`.
 *   - The panel itself renders into `shell.overlay`, the root-scoped LIST slot
 *     the layout package renders inside the frame. Its element is `position:
 *     fixed`, which is what lets it escape the frame's `overflow:hidden` while
 *     still living in the app's React tree (no second root, no body-level
 *     append): a fixed box is not clipped by an ancestor's overflow, and the
 *     overlay layer's own `z-index:20` keeps the dock above the columns (10/11)
 *     and below a fullscreen right bar (40).
 *   - **Geometry** is the part the spike proved before any of this existed:
 *     the left edge is the frame's resolved `gridTemplateColumns` first track,
 *     so it follows the left bar opening, collapsing and being dragged with no
 *     hashed class name involved. The room comes from the **middle and right
 *     columns only**, as their own `height: calc(100% - <dock>px)` (see
 *     `columnsFor` / `applyInsets`): shrinking the FRAME instead shortens its
 *     single grid row, which shortens the left bar with it - that was alpha.1
 *     and its contents visibly slid up the moment the dock opened.
 *   - **Intent and geometry are separate.** The first spike run failed exactly
 *     here: setting the dock's open state from the observer that tracks the left
 *     bar meant the close which restored the columns' height re-triggered the
 *     observer and reopened the dock. `data-open` is user intent; `data-suspended`
 *     is derived from the frame. Geometry never touches intent.
 *
 * THE NAME (alpha.14): this package is `dsh-cmdbar` - the **command bar** - and
 * it was `dsh-terminal` through alpha.13. The old name described the EMULATOR the
 * package used to carry (alpha.12 deleted it) and collided with the harness's own
 * `@deepseek-ai/dsh-terminal` / `@deepseek-ai/dsh-terminal-bash`, while what is
 * left is exactly what the new name says: the agent's commands, in a bar at the
 * foot of the window. The row, the route, the data attributes and the `dsc-` CSS
 * prefix moved with it; the shared `dockHeight` field in `dsh-ui-state` did NOT,
 * because that key is the pack's own and a rename would have thrown away the
 * height every reader had already chosen.
 *
 * WHAT IS IN THE PANEL (alpha.12): the agent's own command use, read out of the
 * conversation the panel belongs to, and NOTHING ELSE. The dock used to carry
 * its own terminals — one **xterm.js instance per slot**, attached over one
 * authenticated WebSocket each to a real PTY in the Node half — and that whole
 * half is gone. 0.2's right Sidebar ships terminal TABS of its own
 * (`@deepseek-ai/dsh-client-ui-sidebar-terminal`), so a second emulator at the
 * foot of the window was a second answer to a question the harness now answers
 * in the column beside it. This package therefore READS and never RUNS: one
 * read-only route (`/api/dsh-cmdbar/activity`), no PTY, no xterm, no socket,
 * no "Run in Terminal", and nothing on the other end to focus or resize.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, location, MutationObserver, ResizeObserver, localStorage */
window.__ModuleLoader__.load({
  id: 'dsh-cmdbar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /**
     * The app's own pill chip, resolved ONCE and guarded.
     *
     * alpha.15 dresses the dock's controls as the chips every other panel in this
     * app uses (`primitives.Pill`: a 24px rounded chip, interactive when it is
     * given an `onClick`, raised while `active`). The guard is not decoration: a
     * root-scoped slot ABDICATES the whole dock when its render throws, and
     * `h(undefined, ...)` throws, so an engine without the export would cost the
     * panel rather than one chip - the same reason the copy buttons guard
     * `writeClipboard` and the hover card guards `HoverCard`.
     */
    const Pill = typeof primitives.Pill === 'function' ? primitives.Pill : null

    /**
     * One chip: the shipped pill, or a plain button that still names its state.
     *
     * The wrapper is the only thing this package adds around the app's chip, and
     * it exists so the DOCK can size it (`.dsc-pillSeat>*`, see the stylesheet):
     * the app's own class names are hashed by its bundler, and a rule keyed on one
     * of those would break on the next harness release. The chip inside stays the
     * shipped component, so its `active` dress and its interaction are the app's.
     *
     * @param props - `active`, plus whatever the underlying control takes.
     * @param label - the chip's text.
     * @returns the chip element, wrapped.
     */
    function chip(props, label) {
      if (Pill !== null) return h('span', { className: 'dsc-pillSeat' }, h(Pill, props, label))
      const rest = Object.assign({}, props)
      const active = rest.active === true
      delete rest.active
      return h(
        'span',
        { className: 'dsc-pillSeat' },
        h('button', Object.assign({ type: 'button', className: 'dsc-btn', 'data-on': active ? '' : undefined }, rest), label),
      )
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /**
     * Printed in the dock's brand tooltip, so a freshly loaded bundle is easy to
     * verify.
     *
     * alpha.14 was the RENAME (`dsh-terminal` -> `dsh-cmdbar`) plus the repair of
     * the alpha.13 crash: clicking a command line to expand it threw a
     * `ReferenceError` out of a free identifier, and the shell's slot error
     * boundary ABDICATED the dock for the life of the page - the panel
     * disappeared and would not come back (see `commandBody`).
     *
     * alpha.15 is the BAR: one header row instead of the two this panel used to
     * stack (both of which restated the counts), the app's own chip for each
     * control, a facts line that ellipsises instead of running over its
     * neighbours, and the WHOLE command on hover (see `commandCard`).
     */
    const PLUGIN_VERSION = '0.1.0-alpha.15'
    /** The header list this control joins (Open In... is -10). */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** The root-scoped overlay list the layout package renders inside the frame. */
    const OVERLAY_SLOT = 'shell.overlay'
    /** Right of Open In (-10): the last utility, beside the right bar's toggle. */
    const HEADER_ORDER = 30
    /** After the layout's own overlay children. */
    const OVERLAY_ORDER = 50
    /**
     * The panel's ONLY route, and it is read-only: the host's filtered tail of
     * the conversation's log. Keep in sync with lib/index.js.
     */
    const ACTIVITY_ROUTE = '/api/dsh-cmdbar/activity'
    /**
     * How often the agent view re-reads the conversation's log.
     *
     * The log lives on the HOST (see `ACTIVITY_ROUTE`), which is what makes this
     * view work the moment the app opens instead of waiting for a browser to
     * stage the conversation: the host has the commands whether or not anyone has
     * looked at them. The price is a poll, so it is a cheap one - a filtered tail
     * of an in-memory array - it runs only while something is subscribed (the
     * header control of the conversation on screen), it pauses in a hidden tab,
     * and it speeds up only while a command is actually running.
     */
    const ACTIVITY_POLL_MS = 6000
    const ACTIVITY_POLL_BUSY_MS = 2000
    /**
     * How often a log that has NOT ANSWERED YET is asked again (alpha.11).
     *
     * The conversation on screen is the only subscriber, and the host attaches
     * it as the app opens it - so the first read can race that attach and answer
     * `NOT_LIVE`. Waiting the steady 6 s would leave a restored conversation
     * saying "not readable here" for up to six seconds after every startup,
     * which is exactly the window a reader sees when they reload. A few brisk
     * attempts close it; a log that is STILL unreadable settles back onto the
     * steady cadence rather than polling at this one for ever.
     */
    const ACTIVITY_RETRY_MS = 1500
    const ACTIVITY_RETRY_ATTEMPTS = 4
    /** The geometry bounds of the dock. */
    const MIN_HEIGHT = 120
    const DEFAULT_HEIGHT = 280
    const MAX_HEIGHT_RATIO = 0.7
    const STORAGE_KEY = 'dsh-cmdbar.dockHeight'
    /**
     * How long a settled height waits before it goes to the shared section.
     * A drag changes the height on every frame and the section is a WIRE write
     * (queued, one round trip each): coalescing is what makes a drag one request
     * instead of two hundred, and it is the same 400ms dsh-ui-state uses for its
     * own column-width drags - the pack solves one hazard the same way twice.
     */
    const SHARED_WRITE_DEBOUNCE_MS = 400
    /**
     * The tools that EXECUTE something, i.e. what the log shows by default.
     *
     * `bash` and `pwsh` are the foreground AND persistent shell tools - the
     * persistent ones are the same wire tool with no `description` (the shipped
     * card's own `shellCall` reads them exactly that way). `run_code` runs a
     * program and `terminal_send` types into a shell the harness itself owns;
     * both are the agent using a terminal. Everything else is a one-line row
     * under the "All tools" filter.
     */
    const EXEC_TOOLS = { bash: true, pwsh: true, run_code: true, terminal_send: true }
    /** Output shown before "Show all" - a command's output is unbounded. */
    const OUTPUT_CLAMP_LINES = 12
    /** A group caption is one line; the full prompt is one click away. */
    const PROMPT_CLAMP_CHARS = 160
    /** The keys a NON-command tool row summarizes itself with, in order. */
    const ARG_SUMMARY_KEYS = ['file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'command', 'text']

    // ---------------------------------------------------------------------
    // The pack's own durable state (alpha.5)
    //
    // The dock's height used to live in localStorage only, which is per ORIGIN
    // and per browser PROFILE: a Chrome tab and the desktop window's WebView
    // never shared it, and the desktop shell prefers port 3080 and falls back to
    // a free one, so even one host lost it by moving a port. It now goes through
    // the pack's `uiState` service (dsh-ui-state) - the `ui-state` entry's
    // volatile config in the profile's own Cordis patch document, which both
    // hosts read - with localStorage kept as the fallback, so the dock still
    // remembers its height in a profile that installed this bundle without that
    // one. Resolved lazily, never declared in `inject`, for that same reason.
    //
    // The dock's OPEN state is deliberately NOT remembered: the panel is the
    // window onto a PROCESS, and after a reload the client holds no slots, so
    // reopening it would either show an empty panel or - once the server's five
    // minute PTY retention has lapsed - start a shell nobody asked for. A height
    // is a preference; "a shell was running" is not.
    // ---------------------------------------------------------------------
    /** The `uiState` service once `apply` has found it, or `null`. */
    let sharedState = null
    /**
     * The height this client last handed to the shared section, or null while it
     * has never written one. The section is NOT optimistic - `get` answers from
     * the last view the HOST accepted - so a value equal to this one is this
     * client's own echo coming back, never news (see `adoptDecision`).
     */
    let sharedKnown = null
    /** The pending shared write, so a whole drag coalesces into one request. */
    let sharedTimer = null
    /**
     * How many of this client's own writes are still on the wire. The section
     * lags by exactly that much, so an announcement that arrives while it is not
     * zero is a view from BEFORE the write and must not be adopted.
     */
    let sharedPending = 0
    /** Set while a grip drag is in flight: the pointer owns the height. */
    let dragging = false

    /**
     * Resolve the pack's shared-state service.
     * @param ctx - the client context.
     * @returns the service, or `null` when this profile does not install it.
     */
    function uiStateService(ctx) {
      try {
        const service = ctx && typeof ctx.get === 'function' ? ctx.get('uiState') : undefined
        const usable = service && typeof service.get === 'function' && typeof service.set === 'function'
        return usable ? service : null
      } catch (err) {
        return null
      }
    }

    /**
     * Whether the shared state has accepted a section yet. Until it has, every
     * field reads as its schema default, so adopting one would fight the
     * localStorage value this dock has always used.
     * @returns {boolean} readiness.
     */
    function sharedReady() {
      if (sharedState === null || typeof sharedState.status !== 'function') return false
      try {
        return sharedState.status() === 'ready'
      } catch (err) {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // Styles — the pack's tab dress, under this package's own `dsc-` prefix.
    // ---------------------------------------------------------------------
    const css = `
.dsc-dock{position:fixed;left:0;right:0;bottom:0;z-index:21;box-sizing:border-box;display:none;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);border-top:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.34));box-shadow:0 -6px 18px rgba(0,0,0,.06);font-size:12.5px;line-height:1.5;--dsc-control-h:20px}
.dsc-dock[data-open]:not([data-suspended]){display:flex}
.dsc-grip{flex:none;height:6px;cursor:row-resize;touch-action:none;background:transparent}
.dsc-grip::after{content:'';display:block;width:44px;height:2px;margin:2px auto 0;border-radius:2px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.3))}
.dsc-grip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsc-grip:hover::after{background:var(--dsw-alias-label-tertiary,#999)}
/* While the edge is being dragged the whole page keeps the resize cursor and
   stops selecting text - the pointer regularly leaves a 6px strip, and a drag
   that started selecting the log's text reads as "it broke". */
body.dsc-dragging{cursor:row-resize;user-select:none}
/* ONE header row (alpha.15). The dock used to carry two - its own bar plus the
   view's toolbar underneath - and both of them restated the counts, so 62px of a
   280px panel was chrome and the two lines could describe the same log
   differently. Every other panel in this app puts its title at the left and its
   controls at the right of ONE row (the right bar's tab strip, the editor's file
   bar), and that is the shape this one now wears.
   THREE declarations are what keep it from breaking at a narrow width, and each
   one is a defect alpha.15 repaired:
     - flex-wrap:nowrap, so a crowded row never becomes a second line;
     - white-space:nowrap + flex:none on everything that must not shrink, so the
       title, the chips and the close button read as themselves;
     - flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis on the
       COUNT line ALONE, so the one item that can afford to give way is the one
       that does. It was flex:none with no overflow rule, so it kept its full
       width, ran over the version text beside it, and pushed the close button
       past the panel's edge. */
.dsc-bar{flex:none;display:flex;flex-wrap:nowrap;align-items:center;gap:8px;min-width:0;padding:2px 8px 2px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16))}
/* The bar's flexible gap: with no chip strip to fill the row, this is what keeps
   the counts and the controls at the right end and the brand at the left. */
.dsc-spacer{flex:1;min-width:8px}
.dsc-brand{flex:none;display:inline-flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dsc-glyph{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary,#999)}
/* The view's controls, in the bar: the app's own pills, on one row - at the
   app's own DENSE size rather than its panel size, because this is a log strip
   under a conversation and not a settings page. --dsc-control-h (20px, on
   .dsc-dock) is the single knob the whole row's height hangs on, and the two
   declarations below are the only place the app's chip is resized: the wrapper
   is OURS (dsc-pillSeat, no hashed class anywhere) and the chip inside it is
   STILL the shipped primitives.Pill, so the interaction, the active dress and
   the rounding are the app's - only the metric is this bar's. 20px is not
   invented either: it is primitives.Tag's own density (11px text on a 17px line
   plus 1px of padding), the app's own small-chip scale.
   The wrapper is NOT named after the chip, and that is deliberate: alpha.12
   pinned the ABSENCE of this package's terminal chip strip by SUBSTRING, so any
   dsc- class name containing "chip" fails the tracked check - and that pin is
   what keeps the emulator this package used to carry from coming back. Naming a
   seat after its occupant would either fail the check or get the check relaxed,
   which is a worse trade than one unusual class name. */
.dsc-filters{flex:none;display:inline-flex;align-items:center;gap:6px}
.dsc-pillSeat{flex:none;display:inline-flex;align-items:center;min-width:0}
.dsc-pillSeat>*{height:var(--dsc-control-h,22px);padding:0 8px;font-size:11px;line-height:17px}
.dsc-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:var(--dsc-control-h,22px);box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap;gap:5px}
.dsc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-btn:disabled{opacity:.45;cursor:default}
.dsc-btnIcon{width:var(--dsc-control-h,22px);padding:0}
.dsc-facts{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsc-body{flex:auto;min-height:0;position:relative;background:var(--dsw-alias-bg-base,#fff)}
.dsc-notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px}
.dsc-noticeTitle{color:var(--dsw-alias-label-secondary,#666);font-size:13px}
.dsc-noticeErr{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsc-noticeCode{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;opacity:.85;max-width:640px;white-space:pre-wrap}
/* ---- the agent's own command use: the panel's ONLY view (alpha.12) ---------
   There is no toggle left to dress. The bar says what the panel is - the agent's
   own command use in this conversation - and wears that log's own state: the
   pulse while a command runs, the count of what failed, and the warning tone
   when this conversation's log cannot be read. "Run in Terminal" went with the
   terminals: with no PTY of this package's own there is nothing to type into. */
.dsc-warn{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-state-warning-primary,#d29922)}
.dsc-pulse{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#d29922);animation:dsc-pulse 1.1s ease-in-out infinite}
.dsc-headDot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;box-sizing:border-box;border:1.5px solid var(--dsw-alias-bg-layer-1,#fff);background:var(--dsw-alias-state-warning-primary,#d29922)}
.dsc-headDot[data-state=running]{animation:dsc-pulse 1.1s ease-in-out infinite}
.dsc-headDot[data-state=failed]{background:var(--dsw-alias-state-error-primary,#d3382c)}
.dsc-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:8px;font-size:10.5px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-state-error-primary,#d3382c);color:#fff}
@keyframes dsc-pulse{0%,100%{opacity:1}50%{opacity:.35}}
/* The view fills the body: the panel IS the log, and there is nothing to switch
   to, so this box is the whole content area. */
.dsc-activity{position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff)}
/* Positioned so the shared .dsc-notice (absolute, inset 0) covers the BODY and
   not the whole view - an unreadable conversation must not hide the bar that
   says so. The view's own toolbar row is GONE (alpha.15): its two filters and
   the follow pill are chips in the dock's bar, because a second row that
   restated the counts is most of why the header read as too big. */
.dsc-actBody{position:relative;flex:auto;min-height:0;overflow:auto;font-family:ui-monospace,'Cascadia Code',Consolas,'SF Mono',Menlo,monospace;font-size:12px;line-height:1.45}
.dsc-actList{padding:6px 10px 14px}
.dsc-grp{margin:0 0 10px}
.dsc-grpHead{display:flex;align-items:baseline;gap:8px;margin:6px 0 4px;color:var(--dsw-alias-label-tertiary,#999);font-family:var(--dsw-font-family,inherit)}
.dsc-grpTime{flex:none;font-size:10.5px;font-variant-numeric:tabular-nums}
.dsc-grpTurn{flex:none;font-size:10.5px;opacity:.8}
.dsc-grpPrompt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666);font-size:11.5px}
/* alpha.9: EVERY row is readable at a glance, in any theme. Both side rails
   carry the status colour - the exit-0 GREEN included, not only a failure's red -
   and the row's own head (the line that drops the output down) wears a LIGHT
   wash of the same colour, so the command lines a reader scans stand out from
   their output without the output losing contrast. The tone is ONE custom
   property per status, so the rails, the wash and the pill can never disagree;
   the wash is mixed with transparent, so it lightens a light theme and darkens
   a dark one and the label keeps its own themed colour either way. */
.dsc-cmd{--dsc-accent:var(--dsw-alias-state-success-primary,#2f9e44);margin:0 0 6px;padding:1px 0 2px;border-left:2px solid var(--dsc-accent);border-right:2px solid var(--dsc-accent);border-radius:3px}
.dsc-cmd[data-status=running]{--dsc-accent:var(--dsw-alias-state-warning-primary,#d29922)}
.dsc-cmd[data-status=failed],.dsc-cmd[data-status=signal],.dsc-cmd[data-status=error]{--dsc-accent:var(--dsw-alias-state-error-primary,#d3382c)}
.dsc-cmdHead{display:flex;align-items:baseline;gap:6px;padding:2px 6px;border-radius:4px;cursor:pointer;background:color-mix(in srgb,var(--dsc-accent) 14%,transparent)}
.dsc-cmdHead:hover{background:color-mix(in srgb,var(--dsc-accent) 26%,transparent)}
.dsc-cmdHead:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dsc-cmdMark{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:10px;transition:transform .12s ease}
.dsc-cmd[data-expanded] .dsc-cmdMark{transform:rotate(90deg)}
.dsc-cmdName{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsc-cmdLine{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1f1f1f)}
/* THE WHOLE COMMAND, on hover (alpha.15). The head clips its command to one
   line, and the only way to read the rest was to expand the row - so the line a
   reader naturally points at now answers with the command itself, wrapped and
   scrollable, in the app's own HoverCard surface. The card is the SHIPPED
   primitive (primitives.HoverCard, variant preview), portaled to the body, sized
   from the log's own box through its widthAnchorRef, and it caps itself at 420px
   - so this box only has to fill it and let the LONG case scroll instead of
   growing past the screen. */
.dsc-hoverCmd{flex:auto;min-height:0;margin:0;padding:10px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,'Cascadia Code',Consolas,'SF Mono',Menlo,monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsc-cmdCwd{flex:none;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;direction:rtl;text-align:left}
.dsc-cmdDur{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:10.5px;font-variant-numeric:tabular-nums}
.dsc-pill{flex:none;padding:0 5px;border-radius:8px;font-size:10.5px;line-height:15px;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#666)}
.dsc-pill[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e44) 18%,transparent);color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dsc-pill[data-tone=failed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d3382c) 18%,transparent);color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsc-pill[data-tone=running]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 18%,transparent);color:var(--dsw-alias-state-warning-primary,#d29922)}
.dsc-out{margin:2px 0 4px 18px;padding:0;white-space:pre-wrap;word-break:break-word;font:inherit;color:var(--dsw-alias-label-secondary,#666)}
.dsc-outCmd{margin-top:4px;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsc-cmdWait{margin:2px 0 4px 18px;color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px}
.dsc-cmdActs{display:flex;align-items:center;gap:10px;margin:0 0 2px 18px;min-height:14px}
.dsc-link{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.dsc-link:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}
`
    const CSS_TAG = 'dsh-cmdbar/cmdbar.css'
    if (typeof document !== 'undefined' && document.head && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-cmdbar'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The dock store. A tiny module-level store rather than a published
    // service: nothing outside this package consumes it, and the pack provides
    // a service only when a consumer exists. The snapshot is a REVISION NUMBER
    // so `useSyncExternalStore` never sees a fresh object per call.
    // ---------------------------------------------------------------------
    const dock = {
      /** User intent: the panel is showing. */
      open: false,
      /** The conversation the panel belongs to (set by the button that opened it). */
      sessionId: null,
      /** Panel height in px. */
      height: readStoredHeight(),
      /** Bumped by every mutation; the only thing the store publishes. */
      rev: 0,
    }
    const subscribers = new Set()

    function readStoredHeight() {
      // alpha.5: the pack's shared state answers first. It is the one store both
      // hosts read, so the dock keeps its height when a Chrome tab and the
      // desktop window (different browser profiles, and possibly different
      // ports) are the two things being opened; localStorage stays underneath as
      // the fallback for a profile without dsh-ui-state.
      if (sharedReady()) {
        const shared = Number(sharedState.get('dockHeight'))
        if (Number.isFinite(shared)) return clampHeight(shared)
      }
      try {
        const raw = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null
        const value = Number.parseInt(raw === null ? '' : raw, 10)
        if (Number.isFinite(value)) return clampHeight(value)
      } catch (err) {
        /* a blocked localStorage simply means the default height */
      }
      return DEFAULT_HEIGHT
    }

    function maxHeight() {
      const viewport = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
      return Math.max(MIN_HEIGHT, Math.round(viewport * MAX_HEIGHT_RATIO))
    }

    function clampHeight(value) {
      return Math.min(Math.max(Math.round(value), MIN_HEIGHT), maxHeight())
    }

    /**
     * What an accepted shared section should do to the dock.
     *
     * PURE, and exported for the tracked check, because this is the whole of the
     * alpha.5 drag bug: the shared write is queued and NOT optimistic, the
     * section re-announces on every accepted view, and the accept handler
     * re-adopted whatever the LAST accepted view carried - which during a drag is
     * a height the pointer left behind a moment ago. The dock was dragged up,
     * snapped back to a stale echo, and dragged up again, and the queue of
     * one-write-per-pointer-move kept replaying old heights for seconds after the
     * release: "the size glitches and I have to hide it". Four ways a value is
     * not news, and all four are this function's answer:
     *
     *  - the pointer is down (`dragging`): the live drag is the truth;
     *  - a write of ours is still on the wire (`pending`): the section is LAGGING
     *    us, so what it announces is a view from before that write;
     *  - `shared` equals what this client last wrote (`known`): our own echo;
     *  - `shared` equals the height already in force (`current`): nothing to do.
     *
     * It is the same hazard dsh-ui-state guards for its own column widths with a
     * `restored` flag ("so a later snapshot cannot stomp a live drag").
     *
     * @param {object} input - `ready`, `dragging`, `pending`, `shared`, `known`,
     *   `current`.
     * @returns {number|null} the height to adopt, or null to leave the dock alone.
     */
    function adoptDecision(input) {
      if (!input.ready || input.dragging) return null
      // A write of ours still on the wire means the section is LAGGING this
      // client: whatever it announces now is a view from before that write, and
      // adopting it is how the dock snapped back to a height the pointer had
      // already left. `known` alone cannot see this (a second write can be in
      // flight by the time the first one is answered).
      if (Number(input.pending) > 0) return null
      // `Number(null)` is 0 and 0 is a finite height, so absence is rejected by
      // hand rather than left to the numeric test.
      if (input.shared === null || input.shared === undefined || input.shared === '') return null
      const shared = Number(input.shared)
      if (!Number.isFinite(shared)) return null
      if (input.known !== null && shared === input.known) return null
      if (shared === input.current) return null
      return shared
    }

    function bump() {
      dock.rev += 1
      for (const listener of [...subscribers]) {
        try {
          listener()
        } catch (err) {
          /* one throwing subscriber must not break the others */
        }
      }
    }

    function subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    }

    /** The revision is the whole subscription: components then read `dock`. */
    function useRevision() {
      return useSyncExternalStore(subscribe, () => dock.rev, () => dock.rev)
    }

    /**
     * Subscribe one component to a conversation's agent-activity feed.
     *
     * The feed's snapshot is a CACHED object that changes only when the command
     * log changes (see `activitySignature`), which is what makes it safe to hand
     * to `useSyncExternalStore` and keeps a streamed assistant token from
     * re-rendering this panel dozens of times a second.
     *
     * @param sessionId - the conversation to read.
     * @returns the current activity model (never null).
     */
    function useActivity(sessionId) {
      const feed = useMemo(
        () => (typeof sessionId === 'string' && sessionId !== '' ? activityFeed(sessionId) : null),
        [sessionId],
      )
      const attach = useCallback((listener) => (feed === null ? () => {} : feed.subscribe(listener)), [feed])
      const read = useCallback(() => (feed === null ? EMPTY_ACTIVITY : feed.getSnapshot()), [feed])
      return useSyncExternalStore(attach, read, read)
    }

    /** Open the dock for a conversation, or close it when it is already there. */
    function toggleDock(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (dock.open && dock.sessionId === sessionId) {
        dock.open = false
        bump()
        return
      }
      dock.sessionId = sessionId
      dock.open = true
      bump()
    }

    function closeDock() {
      if (!dock.open) return
      dock.open = false
      bump()
    }

    /**
     * What a conversation change does to the dock's identity.
     *
     * PURE, and exported through `__internals`, because this one rule is the
     * whole of "the panel follows the conversation in front of you", and the way
     * it can go wrong - an identity that outlives the conversation it named - is
     * not visible in a source shape.
     *
     * alpha.13 is the repair. Through alpha.12 a change CLOSED the panel, and an
     * empty id was ignored outright, so both of the paths that matter most left
     * the old conversation on screen: opening a NEW conversation (no session id
     * yet) or landing on a screen whose header has gone away reported nothing at
     * all, and the always-mounted panel kept drawing the commands, the counts and
     * the poll of the conversation it was last opened in. What the reader asked
     * for is a panel that stays where they put it and always describes what is in
     * front of them.
     *
     * So: the SAME conversation moves nothing; a DIFFERENT one re-points an OPEN
     * panel - it keeps its open state, its height and its place - while a closed
     * panel simply forgets (alpha.11's rule: no feed, no poll and no collected
     * count for a conversation nobody is looking at); and an ABSENT identity is a
     * change like any other, resolving to `null` so the panel can say "no
     * conversation open" instead of wearing another conversation's numbers.
     *
     * @param state - `{ open, current, next }`: the dock's open flag, the
     *   conversation it points at, and the one on screen (empty or absent when
     *   there is none).
     * @returns the identity the dock should hold.
     */
    function followDecision(state) {
      const known = state !== null && state !== undefined
      const open = known && state.open === true
      const current = known && typeof state.current === 'string' && state.current !== '' ? state.current : null
      const next = known && typeof state.next === 'string' && state.next !== '' ? state.next : null
      if (current === next) return current
      return open ? next : null
    }

    /**
     * A header button reports its conversation: the dock only belongs to one.
     *
     * alpha.11: the dock FORGETS a conversation it no longer belongs to, so a
     * closed panel keeps no subscription - and no poll - on a conversation that
     * is no longer on screen.
     *
     * alpha.13: it no longer closes itself, and it no longer ignores an absent
     * id. An OPEN panel re-points at whatever is on screen (see
     * `followDecision`) and stays exactly where the reader put it - the panel is
     * closed by the reader's own control and by nothing else.
     */
    function adoptSession(sessionId) {
      const next = followDecision({ open: dock.open, current: dock.sessionId, next: sessionId })
      if (next === dock.sessionId) return
      dock.sessionId = next
      bump()
    }

    /**
     * The header control for a conversation has gone away (alpha.13).
     *
     * `adoptSession` runs while a conversation's own header exists; the
     * new-conversation and Start screens have no header at all, so nothing calls
     * it there and the panel would keep the identity it had. The control's unmount
     * is the one signal for that path, and it clears only the identity it owned:
     * another conversation's control may already have re-pointed the panel by the
     * time this cleanup runs.
     *
     * @param sessionId - the conversation the unmounting control owned.
     */
    function releaseSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '' || dock.sessionId !== sessionId) return
      dock.sessionId = null
      bump()
    }

    /** Send the settled height to the shared section, once. */
    function flushSharedHeight() {
      if (sharedTimer !== null) {
        clearTimeout(sharedTimer)
        sharedTimer = null
      }
      if (sharedState === null || sharedKnown === null) return
      const value = sharedKnown
      // `set` settles when the wire call does, and the scope announces on the way
      // through - which is exactly why the writes outstanding here are the window
      // in which an announcement says nothing about the present.
      const settle = () => {
        sharedPending = Math.max(0, sharedPending - 1)
      }
      sharedPending += 1
      try {
        const write = sharedState.set('dockHeight', value)
        if (write && typeof write.then === 'function') write.then(settle, settle)
        else settle()
      } catch (err) {
        /* not persisting is not a failure */
        settle()
      }
    }

    /**
     * Remember a height for the shared section WITHOUT sending it yet.
     *
     * The section is a queued wire write, so one request per pointer move both
     * floods the queue and (because each answer re-announces an older view) fed
     * the very echo loop this debounce exists to starve. `sharedKnown` is
     * recorded at once, though: it is what `adoptDecision` compares an incoming
     * view against, and it must be current while the write is still in flight.
     *
     * @param value - the height just applied.
     */
    function queueSharedHeight(value) {
      if (sharedState === null) return
      sharedKnown = value
      if (sharedTimer !== null) clearTimeout(sharedTimer)
      sharedTimer = setTimeout(() => {
        sharedTimer = null
        flushSharedHeight()
      }, SHARED_WRITE_DEBOUNCE_MS)
    }

    /**
     * @param value - the wanted height in px (clamped here).
     * @param options - `{ persist: false }` when the value CAME from the shared
     *   section: writing it straight back is what made a drag fight its own echo.
     */
    function setHeight(value, options) {
      const next = clampHeight(value)
      if (next === dock.height) return
      dock.height = next
      // Both stores, on purpose: the shared section is what the two hosts agree
      // on, and the localStorage copy keeps the dock remembering its height if
      // dsh-ui-state is uninstalled while this bundle stays. localStorage is
      // synchronous and local - it can follow every frame of a drag; the shared
      // section cannot, and waits for the drag to settle.
      const persist = !(options && options.persist === false)
      if (persist) queueSharedHeight(next)
      else sharedKnown = next
      try {
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, String(next))
      } catch (err) {
        /* not persisting is not a failure */
      }
      bump()
    }

    // ---------------------------------------------------------------------
    // The agent's own terminal use (alpha.7)
    //
    // The dock's PTY and the agent's commands are two different worlds: the
    // agent runs `bash`/`pwsh` through the harness's own shell tool, in its own
    // process, and never touches the shell in this panel. So this view is not a
    // second terminal - it is a TRANSCRIPT of what the conversation recorded,
    // drawn in the dock because that is where you are already looking.
    //
    // The events come from the HOST - this package's own read-only
    // `ACTIVITY_ROUTE`, which answers a filtered tail of the conversation's log -
    // and are folded HERE. The host is the only place that always has that log: a
    // browser-side read of the client's own session window has to wait for the
    // conversation to be staged, which is what left this panel on "Reading the
    // conversation..." until a new message moved the session along (alpha.8).
    // Keeping the FOLD here means one implementation of "what a command is",
    // shared by the panel and the tracked check.
    //
    // Every event it reads is part of the session log's published vocabulary:
    //
    //   tool/call    { turn, step, callId, name, arguments }   arguments is the
    //                RAW JSON string the model produced
    //   tool/result  { turn, step, message, error?, meta? }    message.content[0]
    //                is the ToolResultBlock: its `content` is the output text and
    //                its `isError` the infrastructure-failure flag
    //   user/message { id, role, content, source }             source.kind 'user'
    //                is a real prompt; every other kind is injected context
    //
    // Two things are deliberately NOT here. The fold does not reimplement the
    // conversation's assembly - it reads the raw events, so it cannot disagree
    // with the transcript only because a *view* stopped rendering a node. And it
    // does not pretend to stream: the harness has exactly two tool events and no
    // live output channel, so a command appears the moment it is dispatched (the
    // `tool/call` event carries the full arguments) and its output lands in one
    // shot at settle. That is stated in the README rather than papered over.
    //
    // Everything below is PURE except the feed at the end, and the pure half is
    // exported for the tracked check to drive with hand-built events.
    // ---------------------------------------------------------------------
    /** The model every view renders, shared by the feed and its empty states. */
    const EMPTY_COUNTS = { shell: 0, other: 0, running: 0, failed: 0, otherRunning: 0, otherFailed: 0 }
    const EMPTY_ACTIVITY = { groups: [], counts: EMPTY_COUNTS, hasMore: false, available: false, reason: null, revision: 0 }

    /** One-line text: whitespace collapsed and cut at `max` characters. */
    function clampText(value, max) {
      if (typeof value !== 'string') return ''
      const flat = value.replace(/\s+/g, ' ').trim()
      if (flat.length <= max) return flat
      return flat.slice(0, Math.max(0, max - 1)) + '\u2026'
    }

    /** The text blocks of a content list, joined - what a message or result says. */
    function textOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      let out = ''
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        out += (out === '' ? '' : '\n') + block.text
      }
      return out
    }

    /**
     * Terminal control sequences are not text a React box can draw.
     *
     * The harness sanitizes its OWN terminal capture on the host
     * (`dsh-terminal-bash`'s `TerminalSanitizer`), but a shell tool's rendered
     * result is the raw stdout/stderr of an arbitrary program, so a `tput` or a
     * colored test runner can put escapes in it. OSC first (its payload may
     * contain anything, brackets included), then the two-character escapes, then
     * CSI; CRLF and a bare CR become a plain newline and BEL is dropped, because
     * all three are things a terminal would have acted on and a text box would
     * otherwise show.
     */
    function stripAnsi(text) {
      if (typeof text !== 'string' || text === '') return ''
      return text
        .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
        .replace(/\u001B[@-Z\\-_]/g, '')
        .replace(/[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u0007/g, '')
    }

    /**
     * Split a rendered shell-tool result into its body and its exit status.
     *
     * The `\n[exit code: N]` / `\n[killed by signal: X]` markers are owned by
     * `@deepseek-ai/dsh-shell/render`; the shipped terminal card MIRRORS that
     * parse rather than importing Host code, and so does this. The consumed
     * marker leaves the body because the status is drawn as its own pill.
     * Requiring a leading newline and the end of the string keeps ordinary
     * output that merely ends with marker-like text from matching.
     *
     * @param text - the result body.
     * @returns `{ body, exitCode }` or `{ body, signal }`.
     */
    function parseExitMarker(text) {
      const value = typeof text === 'string' ? text : ''
      const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(value)
      if (signal !== null) return { body: value.slice(0, signal.index), signal: signal[1] }
      const exit = /\n\[exit code: (\d+)\]$/.exec(value)
      if (exit !== null) return { body: value.slice(0, exit.index), exitCode: Number(exit[1]) }
      return { body: value, exitCode: 0 }
    }

    /** Read a JSON object argument string, or null (a malformed call is not a crash). */
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw.trim() === '') return null
      try {
        const value = JSON.parse(argsRaw)
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
      } catch (err) {
        return null
      }
    }

    /** The one-line summary a NON-command tool row shows instead of a command. */
    function summarizeArgs(argsRaw) {
      const args = parseArgs(argsRaw)
      if (args === null) return ''
      for (const key of ARG_SUMMARY_KEYS) {
        const value = args[key]
        if (typeof value === 'string' && value.trim() !== '') return clampText(value, 110)
      }
      return ''
    }

    /**
     * Read one tool call out of its raw arguments.
     *
     * PURE, and the mirror of the shipped card's own `shellCall`: `bash` and
     * `pwsh` carry `{command, description?, timeoutMs?, workdir?,
     * run_in_background?}` and a MISSING `description` marks the persistent
     * shell tool (its result has no single process exit status). `run_code`
     * carries a program, and `terminal_send` carries text typed into a shell the
     * harness owns.
     *
     * @param name - the wire tool name.
     * @param argsRaw - the raw argument JSON string.
     * @returns the call, or null when it is not an executing tool (or malformed).
     */
    function parseExecCall(name, argsRaw) {
      if (typeof name !== 'string' || EXEC_TOOLS[name] !== true) return null
      const args = parseArgs(argsRaw)
      if (args === null) return null
      if (name === 'terminal_send') {
        if (typeof args.text !== 'string' || args.text === '') return null
        return { tool: name, family: 'terminal', command: args.text, description: '', workdir: '', background: args.run_in_background === true, persistent: false }
      }
      if (typeof args.command !== 'string' || args.command.trim() === '') return null
      const description = typeof args.description === 'string' ? args.description : ''
      return {
        tool: name,
        family: 'shell',
        command: args.command,
        description,
        workdir: typeof args.workdir === 'string' ? args.workdir : '',
        background: args.run_in_background === true,
        persistent: args.description === undefined,
      }
    }

    /** Start one entry's model from its `tool/call` event. */
    function callEntry(event, data) {
      const parsed = parseExecCall(data.name, data.arguments)
      const isExec = parsed !== null
      return {
        key: 'c' + String(event.seq),
        callId: String(data.callId),
        tool: typeof data.name === 'string' ? data.name : 'tool',
        family: isExec ? parsed.family : 'other',
        command: isExec ? parsed.command : '',
        description: isExec ? parsed.description : '',
        workdir: isExec ? parsed.workdir : '',
        background: isExec ? parsed.background : false,
        persistent: isExec ? parsed.persistent : false,
        summary: isExec ? '' : summarizeArgs(data.arguments),
        turn: data.turn,
        step: data.step,
        startedAt: event.time,
        endedAt: null,
        durationMs: null,
        status: 'running',
        exitCode: null,
        signal: null,
        isError: false,
        errorName: '',
        errorCode: '',
        output: '',
      }
    }

    /**
     * Apply one `tool/result` event to its entry.
     *
     * The result's own `content[0]` is the `ToolResultBlock`; its `content` is
     * the output and its `isError` the failure flag, exactly as the shipped
     * assembler reads them (`event.data.message.content[0]`).
     *
     * The exit marker is read ONLY for a foreground shell tool. A PERSISTENT
     * shell (the same wire tool with no `description`) can report resets and
     * partial output without any single process exit status, so claiming "exit
     * 0" there would be inventing a fact - it settles as `ok` with no pill.
     */
    function settleEntry(entry, event, data) {
      const message = data.message
      const block = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content[0] : null
      const raw = block !== null && typeof block === 'object' ? textOf(block.content) : ''
      const isError = block !== null && typeof block === 'object' && block.isError === true
      entry.endedAt = event.time
      entry.durationMs = typeof entry.startedAt === 'number' && event.time >= entry.startedAt ? event.time - entry.startedAt : null
      entry.isError = isError
      if (data.error !== null && typeof data.error === 'object') {
        entry.errorName = typeof data.error.name === 'string' ? data.error.name : ''
        entry.errorCode = typeof data.error.code === 'string' ? data.error.code : ''
      }
      if (isError) {
        entry.status = 'error'
        entry.output = stripAnsi(raw)
        return entry
      }
      if (entry.family === 'shell' && entry.persistent !== true) {
        const marker = parseExitMarker(stripAnsi(raw))
        entry.output = marker.body
        if (marker.signal !== undefined) {
          entry.signal = marker.signal
          entry.status = 'signal'
          return entry
        }
        entry.exitCode = marker.exitCode
        entry.status = marker.exitCode === 0 ? 'ok' : 'failed'
        return entry
      }
      entry.output = stripAnsi(raw)
      entry.status = 'ok'
      return entry
    }

    /**
     * Fold one contiguous session event window into the activity model.
     *
     * PURE, and driven directly by the tracked check.
     *
     * Groups follow the PROMPTS, not the turns: a human `user/message` opens the
     * next group, so the log reads as "what you asked, then what it ran", which
     * is the only grouping that stays honest when a turn is steered mid-flight or
     * a synthetic context injection sits between two commands. Commands that
     * arrive before any prompt land in a captionless group. Empty groups are
     * dropped: a prompt with no commands is not a row in a command log.
     *
     * A result whose call is NOT in the window (its `tool/call` was paged out)
     * still becomes an entry, with an honest empty command - dropping it would
     * hide output the reader can otherwise see.
     *
     * @param entries - `SessionEventWindow.entries` (transients are ignored).
     * @returns `{ groups, counts }`.
     */
    function buildActivityFromEvents(entries) {
      const groups = []
      const byCall = new Map()
      const counts = { shell: 0, other: 0, running: 0, failed: 0, otherRunning: 0, otherFailed: 0 }
      let group = null

      const openGroup = (prompt, turn) => {
        group = { key: 'g' + String(groups.length), prompt: prompt === null ? '' : prompt.text, promptTime: prompt === null ? null : prompt.time, turn: turn === undefined ? null : turn, commands: [] }
        groups.push(group)
        return group
      }
      /**
       * The group the next command belongs to, opening a captionless one if the
       * window starts mid-conversation. The turn is filled in from the first
       * command when the group was opened by a prompt (a `user/message` carries
       * no turn of its own - its position in the log is what places it).
       */
      const currentGroup = (turn) => {
        if (group === null) return openGroup(null, turn)
        if (group.turn === null && typeof turn === 'number') group.turn = turn
        return group
      }

      for (const record of Array.isArray(entries) ? entries : []) {
        if (record === null || typeof record !== 'object' || record.type !== 'event') continue
        const event = record.event
        if (event === null || typeof event !== 'object') continue
        const data = event.data
        if (data === null || typeof data !== 'object') continue
        if (event.type === 'user/message') {
          if (data.source !== null && typeof data.source === 'object' && data.source.kind === 'user') {
            openGroup({ text: clampText(textOf(data.content), PROMPT_CLAMP_CHARS), time: event.time }, undefined)
          }
          continue
        }
        if (event.type === 'tool/call') {
          const entry = callEntry(event, data)
          if (data.callId !== undefined) byCall.set(String(data.callId), entry)
          currentGroup(entry.turn).commands.push(entry)
          continue
        }
        if (event.type !== 'tool/result') continue
        const message = data.message
        const callId = message && message.source && message.source.callId !== undefined ? String(message.source.callId) : ''
        let entry = callId === '' ? undefined : byCall.get(callId)
        if (entry === undefined) {
          // The call is outside the loaded window: keep the output, name nothing.
          entry = {
            key: 'r' + String(event.seq),
            callId,
            tool: '',
            family: 'other',
            command: '',
            description: '',
            workdir: '',
            background: false,
            persistent: false,
            summary: '',
            turn: data.turn,
            step: data.step,
            startedAt: event.time,
            endedAt: null,
            durationMs: null,
            status: 'running',
            exitCode: null,
            signal: null,
            isError: false,
            errorName: '',
            errorCode: '',
            output: '',
          }
          currentGroup(entry.turn).commands.push(entry)
        }
        settleEntry(entry, event, data)
      }

      // THE COUNTS ARE THE COMMANDS' (alpha.11). `running` and `failed` are what
      // the Agent control's pulse, its red count and the header control's dot are
      // MADE of, so a non-command row must never reach them: a conversation whose
      // only tool call was a failed `read` used to wear a red "1 failed" badge and
      // a red header dot while its own tooltip said "0 commands, 1 failed, nothing
      // run yet" in one breath. The other family's own running and failed rows are
      // counted separately, so the "All tools" filter can still be described
      // honestly without ever reaching the notification.
      for (const entry of allCommands(groups)) {
        const command = entry.family === 'shell' || entry.family === 'terminal'
        if (command) counts.shell += 1
        else counts.other += 1
        if (entry.status === 'running') {
          if (command) counts.running += 1
          else counts.otherRunning += 1
          continue
        }
        if (entry.status !== 'failed' && entry.status !== 'signal' && entry.status !== 'error') continue
        if (command) counts.failed += 1
        else counts.otherFailed += 1
      }
      return { groups: groups.filter((item) => item.commands.length > 0), counts }
    }

    /** Every entry of every group, in log order. */
    function allCommands(groups) {
      const out = []
      for (const group of groups) for (const entry of group.commands) out.push(entry)
      return out
    }

    /**
     * The cheap "did anything I DRAW actually change?" test.
     *
     * The session window republishes on every streamed assistant token, and
     * re-folding a few hundred entries per token to redraw the same log is the
     * kind of waste that shows as jank in a dock that is open all day. The log is
     * append-only and nothing here reads an assistant event, so a signature built
     * from the seq of every event this view consumes is exact: a new call, a new
     * result or a new prompt changes it, and a streamed token cannot.
     *
     * @param entries - the window's entries.
     * @returns a comparable string.
     */
    function activitySignature(entries) {
      let out = ''
      for (const record of Array.isArray(entries) ? entries : []) {
        if (record === null || typeof record !== 'object' || record.type !== 'event') continue
        const event = record.event
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          out += event.type + ':' + String(event.seq) + ';'
          continue
        }
        if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
          out += 'user:' + String(event.seq) + ';'
        }
      }
      return out
    }

    // ---------------------------------------------------------------------
    // The feed: one conversation's activity.
    //
    // The commands come from the HOST's own copy of the conversation log, over
    // this package's read-only `ACTIVITY_ROUTE`, and they are folded HERE by the
    // same pure fold the tracked check drives. That division is the whole design:
    //
    //   - the host is the only place that ALWAYS has the log. A browser-side read
    //     has to wait for that conversation to be staged first, which is exactly
    //     what made this panel open on "Reading the conversation..." and stay
    //     there until something else moved the session along;
    //   - the fold stays in ONE place (the browser), so what the panel draws and
    //     what the check asserts cannot drift about what a command is;
    //   - the route answers a filtered tail, so the poll is small.
    //
    // The feed is created on the first subscriber (the header control of the
    // conversation on screen) and lives until the plugin unloads.
    // ---------------------------------------------------------------------
    /** sessionId -> feed. */
    const feeds = new Map()

    /** The feed for one conversation, created on demand. */
    function activityFeed(sessionId) {
      let feed = feeds.get(sessionId)
      if (feed === undefined) {
        feed = createActivityFeed(sessionId)
        feeds.set(sessionId, feed)
      }
      return feed
    }

    /** Detach every feed; called from the plugin's own effect cleanup. */
    function disposeFeeds() {
      for (const feed of feeds.values()) feed.dispose()
      feeds.clear()
    }

    function createActivityFeed(sessionId) {
      const listeners = new Set()
      let model = EMPTY_ACTIVITY
      let signature = null
      let timer = null
      let inflight = false
      let disposed = false
      /** Consecutive reads with no answer yet (alpha.11): see `cadence`. */
      let retries = 0

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (err) {
            /* one throwing subscriber must not break the others */
          }
        }
      }

      /** Publish a new model. A fresh object is the change signal React reads. */
      const publish = (next) => {
        if (disposed) return
        model = next
        notify()
      }

      /**
       * Unavailable, with a reason - or with `null` while the first read is
       * still in flight. The signature is cleared so the next successful read
       * publishes even when it carries exactly what a previous one did.
       */
      const unavailable = (reason) => {
        retries += 1
        if (model.available === false && model.reason === reason) return
        signature = null
        publish({ groups: [], counts: EMPTY_COUNTS, hasMore: false, available: false, reason, revision: model.revision + 1 })
      }

      /** A hidden tab has nobody to draw for: the visibility handler resumes us. */
      const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

      /**
       * How long the next read waits (alpha.11).
       *
       * A log with NO answer yet is retried briskly for a few attempts - the
       * conversation on screen is attached by the host as the app opens it, so
       * the first read can race that attach and answer `NOT_LIVE`. Past those
       * attempts it falls back to the steady cadence, so a conversation that
       * really cannot be read here costs one idle request every 6 s instead of
       * a metronome.
       */
      const cadence = () => {
        if (model.available !== true && retries < ACTIVITY_RETRY_ATTEMPTS) return ACTIVITY_RETRY_MS
        return model.counts.running > 0 ? ACTIVITY_POLL_BUSY_MS : ACTIVITY_POLL_MS
      }

      /** One read, whenever the last one has settled. */
      const schedule = () => {
        if (disposed || listeners.size === 0 || hidden()) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void load()
        }, cadence())
      }

      /**
       * Fold one answer and publish ONLY when what we draw actually changed.
       *
       * The poll runs every few seconds and the log is append-only, so the usual
       * answer is byte-identical to the last one: `activitySignature` is what
       * turns that into no work and no re-render at all.
       */
      const absorb = (body) => {
        const entries = Array.isArray(body.entries) ? body.entries : []
        const next = activitySignature(entries)
        if (next === signature) return
        signature = next
        const folded = buildActivityFromEvents(entries)
        publish({
          groups: folded.groups,
          counts: folded.counts,
          hasMore: body.hasMore === true,
          available: true,
          reason: null,
          revision: model.revision + 1,
        })
      }

      const REACH = 'The activity route is not reachable, so the agent\u2019s commands cannot be read here.'

      /** Read the conversation's own log from the host. */
      async function load() {
        if (disposed || inflight || hidden()) return
        inflight = true
        try {
          const response = await fetch(ACTIVITY_ROUTE + '?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
          const body = response.ok ? await response.json() : null
          if (disposed) return
          if (body !== null && body.ok === true) {
            // A conversation that ANSWERS is no longer retrying: the next read
            // is on the steady cadence again.
            retries = 0
            absorb(body)
          } else if (body !== null && typeof body.message === 'string' && body.message !== '') unavailable(body.message)
          else unavailable(REACH)
        } catch (err) {
          if (!disposed) unavailable(REACH)
        } finally {
          inflight = false
          schedule()
        }
      }

      const onVisible = () => {
        if (!disposed && !hidden() && listeners.size > 0) void load()
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisible)
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          // A fresh look is a fresh start (alpha.11): the conversation has just
          // come on screen, so its first reads get the brisk cadence again
          // rather than the budget an earlier visit spent.
          if (listeners.size === 1) {
            retries = 0
            void load()
          }
          return () => {
            listeners.delete(listener)
            // Nothing is watching: stop the clock rather than poll for a panel
            // that nobody has open.
            if (listeners.size === 0 && timer !== null) {
              clearTimeout(timer)
              timer = null
            }
          }
        },
        getSnapshot() {
          return model
        },
        dispose() {
          disposed = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisible)
          }
          listeners.clear()
        },
      }
    }

    // ---------------------------------------------------------------------
    // Dock geometry (the spike, shipped). Intent and geometry stay separate:
    // `applyGeometry` never writes `data-open`.
    // ---------------------------------------------------------------------
    /** The frame element: found from OUR OWN node inside its overlay layer. */
    function frameFrom(node) {
      try {
        if (node && typeof node.closest === 'function') {
          const overlay = node.closest('[data-shell-overlay]')
          if (overlay && overlay.parentElement) return overlay.parentElement
        }
        const column = document.querySelector('[data-rightbar-col]')
        if (column && column.parentElement) return column.parentElement
      } catch (err) {
        /* the frame is not mounted yet */
      }
      return null
    }

    /**
     * The left bar's live width: the frame's columns are an inline
     * `gridTemplateColumns: <sidebar>px minmax(0,1fr) <rightbar>px`, so the
     * RESOLVED computed style carries the sidebar track in px.
     */
    function sidebarWidth(frame) {
      try {
        const tracks = getComputedStyle(frame).gridTemplateColumns.split(' ')
        const first = Number.parseFloat(tracks[0])
        return Number.isFinite(first) ? first : 0
      } catch (err) {
        return 0
      }
    }

    /** Place the dock; never touches intent. */
    function applyGeometry(node, frame) {
      if (node === null) return
      if (frame === null) {
        node.style.left = '0px'
        node.style.height = dock.height + 'px'
        node.dataset.suspended = '1'
        return
      }
      if (frame.hasAttribute('data-rightbar-fullscreen')) node.dataset.suspended = '1'
      else delete node.dataset.suspended
      node.style.left = sidebarWidth(frame) + 'px'
      node.style.height = dock.height + 'px'
    }

    /**
     * The two columns that make room for the dock: the MIDDLE and the RIGHT one.
     *
     * The left bar is deliberately not one of them. Shrinking the frame itself
     * (the first alpha's approach) makes room for the dock by shortening the
     * frame's only grid row, which shortens the LEFT column too - its content
     * visibly slid up the moment the dock opened. The dock starts at the left
     * bar's right edge, so the left bar must keep its full height and the room
     * has to come from the two columns the dock actually spans.
     *
     * Both are found without hashed class names: the layout marks the right
     * column itself (`data-rightbar-col`), the middle column is its immediately
     * preceding sibling in the frame, and the left column is the frame's first
     * element child (`DocumentTitle` renders no DOM, so it is not one), which is
     * the guard that keeps this from ever insetting the left bar.
     *
     * @param frame - the app frame element.
     * @returns the column elements to inset.
     */
    function columnsFor(frame) {
      const columns = []
      try {
        const right = frame.querySelector('[data-rightbar-col]')
        if (right === null) return columns
        const middle = right.previousElementSibling
        if (middle !== null && middle.nodeType === 1 && middle !== frame.children[0]) columns.push(middle)
        columns.push(right)
      } catch (err) {
        /* a frame without the layout's column marker keeps the dock unhoused */
      }
      return columns
    }

    /**
     * The room the dock takes, applied as those columns' own height.
     *
     * A height, not `padding-bottom`: the right column's panel is absolutely
     * positioned inside it (`top:0; bottom:0`), and an absolute child's
     * containing block is its ancestor's PADDING box - padding would leave the
     * panel exactly where it was and the dock would cover the bottom of it.
     * A height shortens the column itself, so the panel ends at the dock's top
     * edge like everything else.
     *
     * While the dock is closed - or suspended by a fullscreen right bar - each
     * column gets back the inline height it had before this plugin ever ran.
     *
     * @param frame - the app frame element (or null when it is not mounted).
     */
    const insets = new Map()

    function applyInsets(frame) {
      if (frame !== null) {
        for (const column of columnsFor(frame)) {
          if (!insets.has(column)) insets.set(column, column.style.height)
        }
      }
      const bare = frame === null || !dock.open || frame.hasAttribute('data-rightbar-fullscreen')
      const wanted = bare ? null : 'calc(100% - ' + String(dock.height) + 'px)'
      for (const [column, saved] of insets) {
        if (!document.contains(column)) {
          insets.delete(column)
          continue
        }
        column.style.height = wanted === null ? saved : wanted
      }
    }

    // ---------------------------------------------------------------------
    // Glyphs (primitives ships no terminal icon; the rightbar draws its own too)
    // ---------------------------------------------------------------------
    function svg(path, size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        path.map((d, index) =>
          typeof d === 'string' ? h('path', { key: index, d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }) : d,
        ),
      )
    }

    function CloseGlyph({ size = 11 }) {
      return svg(['M3.6 3.6l8.8 8.8', 'M12.4 3.6l-8.8 8.8'], size)
    }

    /**
     * The activity mark: a terminal with a prompt line already run.
     */
    function ActivityGlyph({ size = 13 }) {
      return svg(
        [
          'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
          'M4.6 7.2 6.4 9l-1.8 1.8',
          h('path', { key: 'p', d: 'M8.4 10.9h3.1', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }),
        ],
        size,
      )
    }

    /**
     * The Agent button's tooltip and the dock's facts line: the counts alone.
     *
     * alpha.13 dropped the sentence this used to open with ("The agent's own
     * commands in this conversation: "). The control it belongs to is already
     * labelled - the button is `aria-label="The agent's commands"` and the panel
     * it opens is branded **Agent** - so the prose only pushed the numbers a
     * reader actually wants further from the eye. What is left is the counts,
     * which is the whole of what the line is for.
     *
     * @param activity - the feed's model.
     * @returns the counts, comma separated, or the empty string for no model.
     */
    function activityFactsTitle(activity) {
      if (activity === null || typeof activity !== 'object' || activity.counts === null || typeof activity.counts !== 'object') return ''
      const parts = [String(activity.counts.shell) + (activity.counts.shell === 1 ? ' command' : ' commands')]
      if (activity.counts.running > 0) parts.push(String(activity.counts.running) + ' running')
      if (activity.counts.failed > 0) parts.push(String(activity.counts.failed) + ' failed')
      if (activity.counts.shell === 0) parts.push('nothing run yet')
      return parts.join(', ')
    }

    // ---------------------------------------------------------------------
    // The activity view: what the agent ran, drawn in the dock.
    // ---------------------------------------------------------------------
    /**
     * Apply the view's filters to the model's groups.
     *
     * PURE, and separate from the fold on purpose: filtering is a VIEW choice,
     * and a filter change must never re-read the conversation. `shellOnly` is
     * the default because a command log that also lists every file read is no
     * longer a command log; `failuresOnly` is the "what went wrong" switch.
     *
     * @param groups - the model's groups.
     * @param options - `{ allTools, failuresOnly }`.
     * @returns the groups that still have something to draw.
     */
    function filterActivity(groups, options) {
      const allTools = options !== null && options !== undefined && options.allTools === true
      const failuresOnly = options !== null && options !== undefined && options.failuresOnly === true
      const out = []
      for (const group of Array.isArray(groups) ? groups : []) {
        if (group === null || typeof group !== 'object' || !Array.isArray(group.commands)) continue
        const commands = group.commands.filter((entry) => {
          if (entry === null || typeof entry !== 'object') return false
          if (!allTools && entry.family === 'other') return false
          if (failuresOnly && !(entry.status === 'failed' || entry.status === 'signal' || entry.status === 'error')) return false
          return true
        })
        if (commands.length > 0) out.push({ key: group.key, prompt: group.prompt, promptTime: group.promptTime, turn: group.turn, commands })
      }
      return out
    }

    /** The pill one entry wears: its tone and its word. */
    function statusInfo(entry) {
      if (entry.status === 'running') return { tone: 'running', label: entry.background === true ? 'in background' : 'running' }
      if (entry.status === 'error') return { tone: 'failed', label: entry.errorCode === '' ? 'error' : 'error \u00b7 ' + entry.errorCode }
      if (entry.status === 'signal') return { tone: 'failed', label: 'killed \u00b7 ' + String(entry.signal) }
      if (entry.status === 'failed') return { tone: 'failed', label: 'exit ' + String(entry.exitCode === null ? '?' : entry.exitCode) }
      if (entry.exitCode !== null && entry.exitCode !== undefined) return { tone: 'ok', label: 'exit ' + String(entry.exitCode) }
      return { tone: 'ok', label: 'done' }
    }

    /**
     * The FULL command an expanded row shows above its output, or null.
     *
     * The head draws `entry.command.split('\n')[0]`, so a command that is more
     * than one line long is otherwise only ever visible one line deep; expanding
     * the row is what shows the rest of it. PURE, and exported for the tracked
     * check, because this is where alpha.13 shipped a **free identifier**: the
     * row asked for `multiLine`, which was never declared anywhere in this
     * bundle, so the `ReferenceError` it threw the FIRST time a reader clicked a
     * command line reached the shell's own slot error boundary - and for the
     * root-scoped `shell.overlay` list that boundary reports with
     * `{ abdicate: true }`, which RETIRES the entry for the life of the page.
     * The dock did not merely fail to expand: it disappeared and would not come
     * back. A static render could never catch it, because a row starts collapsed
     * and `expanded && multiLine` short-circuits before the identifier is read -
     * which is exactly why the decision lives in a pure function the check can
     * DRIVE, rather than in a condition only a click reaches.
     *
     * @param entry - one folded command entry.
     * @param expanded - whether the reader has the row open.
     * @returns the full command text, or null when there is nothing extra to draw.
     */
    function commandBody(entry, expanded) {
      if (expanded !== true) return null
      const command = entry !== null && typeof entry === 'object' && typeof entry.command === 'string' ? entry.command : ''
      return command.indexOf('\n') === -1 ? null : command
    }

    /**
     * The hover card a command LINE wears: the whole command, wrapped.
     *
     * alpha.15. The head's own line is clipped to the command's FIRST line and
     * ellipsised at whatever the panel's width allows, so before this the rest of
     * a command was readable only by expanding the row - and the native `title`
     * that used to sit there showed the agent's DESCRIPTION, not the command at
     * all, which is not what a reader pointing at a command line is asking for.
     *
     * It is built on the SHIPPED card (`primitives.HoverCard`, `variant:
     * 'preview'`), which is the same surface the transcript uses for previews: it
     * waits for a real dwell before opening, portals itself to the body so the
     * dock's own box cannot clip it, sizes itself from the log's box through
     * `widthAnchorRef`, dismisses on a click (so expanding a row does not fight
     * it), and lets the pointer rest on the card so a long command can be read and
     * selected. The card caps its own height at 420px, and `.dsc-hoverCmd` fills
     * that box and scrolls, so a 200-line command cannot push itself off screen.
     *
     * PURE - and it answers the ANCHOR UNCHANGED when there is no command to show
     * (a non-command tool row) or when this engine has no `HoverCard` export. The
     * guard is the same one the copy buttons carry and for the same reason: this
     * row is rendered inside a ROOT-SCOPED slot, whose error boundary ABDICATES
     * the whole dock on a crash - `h(undefined, ...)` here would not cost one row,
     * it would take the panel away for the life of the page.
     *
     * @param entry - one folded command entry.
     * @param head - the rendered command line, used as the card's anchor.
     * @param widthAnchorRef - the log box the card takes its width from.
     * @returns the anchor, wrapped in a card when there is a command to show.
     */
    function commandCard(entry, head, widthAnchorRef) {
      if (entry === null || typeof entry !== 'object') return head
      if (typeof entry.command !== 'string' || entry.command === '') return head
      if (typeof primitives.HoverCard !== 'function') return head
      return h(
        primitives.HoverCard,
        {
          anchor: head,
          content: h('pre', { className: 'dsc-hoverCmd' }, entry.command),
          variant: 'preview',
          widthAnchorRef,
        },
      )
    }

    /**
     * A duration short enough for a pill: 950ms and under is milliseconds, under
     * a minute is one decimal below ten seconds, and past that it is m/s. Pure.
     */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      if (ms < 950) return String(Math.max(1, Math.round(ms))) + 'ms'
      if (ms < 10000) return (ms / 1000).toFixed(1) + 's'
      if (ms < 60000) return String(Math.round(ms / 1000)) + 's'
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      return String(minutes) + 'm' + String(seconds).padStart(2, '0') + 's'
    }

    /**
     * The agent's command log.
     *
     * Read-only by construction: it shows what the conversation recorded and
     * offers exactly two actions per row - copy the command, copy the output.
     * (alpha.12 removed the third: "Run in Terminal" typed a command into THIS
     * package's own PTY, and there is no such PTY any more - the harness's own
     * terminal tabs are where a command gets run by hand now.)
     *
     * Following is a SCROLL POSITION, not a mode: the view follows the tail while
     * the reader is at the bottom, stops the moment they scroll up, and the pill
     * in the bar is the way back.
     *
     * @param props - `sessionId`, `model`, and the three view choices the DOCK's
     *   bar now owns: `allTools`, `failuresOnly` and `follow` (+ `onFollowChange`).
     *   They moved up in alpha.15 with the controls that set them, because the
     *   toolbar row they used to live in was the second row of chrome above the
     *   log. Each has a default, so the view still renders on its own - with the
     *   filters off and following on - which is what the tracked check does.
     */
    function ActivityView({ sessionId, model, allTools, failuresOnly, follow, onFollowChange }) {
      const [open, setOpen] = useState({})
      const [copied, setCopied] = useState('')
      const bodyRef = useRef(null)
      const all = allTools === true
      const failures = failuresOnly === true
      const following = follow !== false
      const setFollow = typeof onFollowChange === 'function' ? onFollowChange : () => {}
      const groups = useMemo(() => filterActivity(model.groups, { allTools: all, failuresOnly: failures }), [model, all, failures])

      // The newest command is the point of a live log, so the box lands on it -
      // but only while the reader is already at the bottom. A fixed auto-scroll
      // would drag the view away from the output someone is reading.
      useEffect(() => {
        if (!following) return
        const box = bodyRef.current
        if (box === null) return
        box.scrollTop = box.scrollHeight
      }, [model.revision, following, groups.length])

      // React bails out of a state write that carries the value already in force,
      // so reporting the position on every scroll frame costs one comparison and
      // never a render.
      const onScroll = useCallback(() => {
        const box = bodyRef.current
        if (box === null) return
        setFollow(box.scrollHeight - box.scrollTop - box.clientHeight <= 12)
      }, [setFollow])

      const toggle = useCallback((key) => {
        setOpen((prev) => {
          const next = { ...prev }
          if (next[key] === true) delete next[key]
          else next[key] = true
          return next
        })
      }, [])

      /**
       * Copy one row's command or its output.
       *
       * The write goes through the shipped **`writeClipboard` primitive** - the
       * one this bundle already requires for `Tooltip` - which tries
       * `navigator.clipboard.writeText`, falls back to a hidden textarea plus
       * `document.execCommand('copy')` (a plain-http origin has no
       * `navigator.clipboard` at all, and the primitive is what the shell's own
       * copy buttons use), and answers whether the host ACCEPTED the write - so
       * "Copied" appears only when the text really got there.
       *
       * Through alpha.13 this was a bare `writeClipboard(text)`: the primitive's
       * own name, unqualified, declared NOWHERE in this bundle - so every click on
       * **Copy command** or **Copy output** threw
       * `ReferenceError: writeClipboard is not defined`, and since a crashed
       * root-scoped slot entry is ABDICATED (see `commandBody`), the dock
       * disappeared for the life of the page. The second button family with this
       * defect in one release, found by auditing the bundle for identifiers it
       * never declares.
       */
      const copy = useCallback((text, key) => {
        // An older engine may not carry the helper: a copy that cannot happen is
        // a no-op, never a crash.
        if (typeof primitives.writeClipboard !== 'function') return
        const write = primitives.writeClipboard(text)
        if (write === null || write === undefined || typeof write.then !== 'function') return
        void write.then(
          (accepted) => {
            if (accepted !== true) return
            setCopied(key)
            window.setTimeout(() => setCopied((prev) => (prev === key ? '' : prev)), 1200)
          },
          () => {
            /* a refused write is not a failure of the panel */
          },
        )
      }, [])

      const clock = (time) => {
        if (typeof time !== 'number' || !Number.isFinite(time)) return ''
        try {
          return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        } catch (err) {
          return ''
        }
      }

      const hint = (title, text, code) =>
        h(
          'div',
          { className: 'dsc-notice' },
          h('div', { className: 'dsc-noticeTitle' }, title),
          text === '' ? null : h('div', null, text),
          code === '' ? null : h('div', { className: 'dsc-noticeCode' }, code),
        )

      const row = (entry) => {
        const expanded = open[entry.key] === true
        const lines = entry.output === '' ? [] : entry.output.split('\n')
        const shown = expanded ? lines : lines.slice(0, OUTPUT_CLAMP_LINES)
        const hidden = lines.length - shown.length
        const info = statusInfo(entry)
        const duration = formatDuration(entry.durationMs)
        // The command the head CLIPS, shown in full above the output once the row
        // is open (see `commandBody`: a multi-line command is the only case with
        // anything left to show).
        const fullCommand = commandBody(entry, expanded)
        // The line a reader points at. It CLIPS its command to one line, so the
        // command itself is what the hover card carries - see `commandCard`.
        const head = h(
          'div',
          {
            className: 'dsc-cmdHead',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded ? 'true' : 'false',
            onClick: () => toggle(entry.key),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggle(entry.key)
              }
            },
          },
          h('span', { className: 'dsc-cmdMark' }, '\u276f'),
          entry.tool === ''
            ? h('span', { className: 'dsc-cmdName' }, 'unknown tool')
            : h('span', { className: 'dsc-cmdName' }, entry.tool),
          entry.family === 'other'
            ? h('span', { className: 'dsc-cmdLine', title: entry.summary }, entry.summary === '' ? '(no summary)' : entry.summary)
            : h('span', { className: 'dsc-cmdLine' }, entry.command.split('\n')[0]),
          entry.workdir === '' ? null : h('span', { className: 'dsc-cmdCwd', title: entry.workdir }, entry.workdir),
          duration === '' ? null : h('span', { className: 'dsc-cmdDur' }, duration),
          h('span', { className: 'dsc-pill', 'data-tone': info.tone }, info.label),
        )
        return h(
          'div',
          {
            key: entry.key,
            className: 'dsc-cmd',
            'data-status': entry.status,
            'data-family': entry.family,
            'data-expanded': expanded ? '' : undefined,
            'data-dsh-cmdbar-cmd': entry.callId,
          },
          commandCard(entry, head, bodyRef),
          fullCommand === null ? null : h('pre', { className: 'dsc-out dsc-outCmd' }, fullCommand),
          shown.length > 0
            ? h('pre', { className: 'dsc-out' }, shown.join('\n'))
            : entry.status === 'running'
              ? h('div', { className: 'dsc-cmdWait' }, entry.background === true ? 'Running in the background\u2026' : 'Running\u2026')
              : null,
          hidden > 0 ? h('button', { type: 'button', className: 'dsc-link', onClick: () => toggle(entry.key) }, 'Show all ' + String(lines.length) + ' lines') : null,
          expanded && hidden === 0 && lines.length > OUTPUT_CLAMP_LINES
            ? h('button', { type: 'button', className: 'dsc-link', onClick: () => toggle(entry.key) }, 'Collapse')
            : null,
          h(
            'div',
            { className: 'dsc-cmdActs' },
            entry.command === ''
              ? null
              : h('button', { type: 'button', className: 'dsc-link', onClick: () => copy(entry.command, entry.key + ':cmd') }, copied === entry.key + ':cmd' ? 'Copied' : 'Copy command'),
            entry.output === ''
              ? null
              : h('button', { type: 'button', className: 'dsc-link', onClick: () => copy(entry.output, entry.key + ':out') }, copied === entry.key + ':out' ? 'Copied' : 'Copy output'),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsc-activity', 'data-dsh-cmdbar-activity-view': '', 'data-available': model.available ? '' : undefined },
        // alpha.15: NO TOOLBAR ROW. The two filters and the follow pill are chips
        // in the dock's bar (see `Dock`), and the line that used to sit here was
        // the second row of chrome the bar was being blamed for.
        h(
          'div',
          { className: 'dsc-actBody', ref: bodyRef, onScroll },
          sessionId === null
            ? // alpha.13: the panel is open with no conversation in front of it
              // (the new-conversation and Start screens). Without this the view
              // would sit on "Reading the conversation..." for ever, which is the
              // one thing that is certainly not happening.
              hint('No conversation open', 'The panel follows the conversation in front of you: open one and the commands the agent runs there appear here.', '')
            : !model.available && model.reason !== null
              ? hint('Agent activity is not readable here', model.reason, 'dsh-cmdbar ' + PLUGIN_VERSION)
              : !model.available
                ? hint('Reading the conversation\u2026', 'The commands appear as soon as this conversation\u2019s log answers.', '')
                : groups.length === 0
                  ? hint(
                      'No commands yet',
                      failures || !all
                        ? 'Nothing here matches the filter.'
                        : 'When the agent runs something in this conversation, it appears here.',
                      '',
                    )
                  : h(
                      'div',
                      { className: 'dsc-actList' },
                      groups.map((group) =>
                        h(
                          'div',
                          { className: 'dsc-grp', key: group.key },
                          group.prompt === '' && group.promptTime === null
                            ? null
                            : h(
                                'div',
                                { className: 'dsc-grpHead' },
                                h('span', { className: 'dsc-grpTime' }, clock(group.promptTime)),
                                typeof group.turn === 'number' ? h('span', { className: 'dsc-grpTurn' }, 'turn ' + String(group.turn)) : null,
                                h('span', { className: 'dsc-grpPrompt', title: group.prompt }, group.prompt === '' ? '(no prompt)' : group.prompt),
                              ),
                          group.commands.map(row),
                        ),
                      ),
                    ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The header control: toggles the dock for its own conversation.
    // ---------------------------------------------------------------------
    function CmdbarButton({ sessionId }) {
      const rev = useRevision()
      const active = dock.open && dock.sessionId === sessionId
      // The header control is the one part of this package that is on screen
      // while the dock is CLOSED, so it is where the agent's own command use has
      // to be visible: a pulsing dot while a COMMAND runs, and a quiet red one
      // while any COMMAND in this conversation's log failed. Both read the
      // COMMAND counts the fold produces (alpha.11), so a failed `read` can never
      // light this control up - and without them "the agent is doing something"
      // is only discoverable by opening the panel to look.
      const activity = useActivity(sessionId)
      const busy = activity.counts.running > 0
      const failed = !busy && activity.counts.failed > 0
      // The conversation this button belongs to is the one in front of the
      // reader, so this is where the panel FOLLOWS it (alpha.13): an open panel
      // re-points at the new conversation and stays open where the reader put it.
      // The cleanup is the other half - a conversation whose header leaves the
      // screen entirely (the new-conversation and Start screens have no header at
      // all) is one nothing else reports, so letting go on unmount is what stops
      // the panel drawing a conversation that is no longer anywhere.
      useEffect(() => {
        adoptSession(sessionId)
        return () => {
          releaseSession(sessionId)
        }
      }, [sessionId])
      // `rev` keeps this honest when the dock is opened, closed or re-pointed
      // elsewhere: re-reporting the conversation already in force is a no-op.
      useEffect(() => {
        adoptSession(sessionId)
      }, [sessionId, rev])
      const label = active ? 'Hide the agent\u2019s commands' : 'The agent\u2019s commands'
      const onClick = useCallback(() => {
        toggleDock(sessionId)
      }, [sessionId])
      return h(
        primitives.Tooltip,
        { label, side: 'bottom', delayMs: 500 },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-btn dsc-btnIcon',
            'aria-label': 'The agent\u2019s commands',
            'aria-pressed': active ? 'true' : 'false',
            'data-dsh-cmdbar-toggle': '',
            'data-agent-state': busy ? 'running' : failed ? 'failed' : undefined,
            style: { width: '28px', height: '28px', borderRadius: '28px', position: 'relative' },
            onClick,
          },
          h('span', { className: 'dsc-glyph' }, h(ActivityGlyph, { size: 15 })),
          busy || failed ? h('span', { className: 'dsc-headDot', 'data-state': busy ? 'running' : 'failed' }) : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The dock
    // ---------------------------------------------------------------------
    // ONE view (alpha.12). The panel used to hold the pack's own terminals - a
    // chip strip over one xterm and one PTY socket each - and alpha.12 removed
    // that half outright, because 0.2's right Sidebar ships terminal TABS of its
    // own. What is left is what the panel was really for: the commands the agent
    // ran in this conversation, at the foot of the window where a reader can
    // watch them without leaving the conversation.
    function Dock() {
      const rev = useRevision()
      const open = dock.open
      const sessionId = dock.sessionId
      const height = dock.height
      const rootRef = useRef(null)
      // The agent's own command use, live. Subscribed even while the dock is
      // closed: the header control's dot is the whole point of "follow it without
      // opening the panel", and the feed publishes at most once per new event
      // this view actually draws.
      const activity = useActivity(sessionId)
      const activityBusy = activity.counts.running > 0
      const activityFailed = !activityBusy && activity.counts.failed > 0
      // `available: false` with NO reason is the first read still in flight; with
      // a reason it is this host saying the conversation's log cannot be read.
      // That is the one condition worth saying before the panel is even looked at,
      // so the bar wears it as well as the body.
      const activityUnreadable = activity.available !== true && activity.reason !== null
      const activityTone = activityBusy ? 'running' : activityUnreadable ? 'warning' : activityFailed ? 'failed' : 'idle'

      // ---------------------------------------------------------------------
      // The view's three choices live HERE (alpha.15), because the chips that set
      // them are in the bar this component draws. They used to be `ActivityView`'s
      // own state, set from its toolbar row - the second row of chrome.
      // ---------------------------------------------------------------------
      const [allTools, setAllTools] = useState(false)
      const [failuresOnly, setFailuresOnly] = useState(false)
      const [follow, setFollow] = useState(true)

      // ... and they belong to the CONVERSATION they were set in (alpha.13), so a
      // change resets them exactly as the view's own key resets its expanded rows.
      useEffect(() => {
        setAllTools(false)
        setFailuresOnly(false)
        setFollow(true)
      }, [sessionId])

      // The line the bar carries, and the line its tooltip carries. The counts are
      // the COMMANDS' (alpha.11), and the other family's own running and failed
      // rows are added back only while "All tools" can actually DRAW them - so the
      // line describes what is on screen instead of counting rows the filter is
      // hiding. This is the arithmetic the view's toolbar used to do, moved up
      // with the chips; `activityFactsTitle` above stays the one-word-per-number
      // spelling the header control's tooltip uses.
      const facts = []
      if (sessionId !== null) {
        facts.push(String(activity.counts.shell) + (activity.counts.shell === 1 ? ' command' : ' commands'))
        if (allTools && activity.counts.other > 0) facts.push(String(activity.counts.other) + ' other')
        const running = activity.counts.running + (allTools ? activity.counts.otherRunning || 0 : 0)
        const failed = activity.counts.failed + (allTools ? activity.counts.otherFailed || 0 : 0)
        if (running > 0) facts.push(String(running) + ' running')
        if (failed > 0) facts.push(String(failed) + ' failed')
        if (activity.hasMore) facts.push('older ones are outside this view')
      }
      const factsTitle =
        sessionId === null
          ? ''
          : activityFactsTitle(activity) + (activity.hasMore ? '. Older commands are outside this view' : '') + (activityUnreadable ? '. Not readable here: ' + String(activity.reason) : '')

      // Geometry, part one: PLACE the dock and take its room from the middle and
      // right columns ONLY - never from the frame, whose single grid row is
      // shared with the left bar (see `columnsFor`).
      //
      // This is the effect a drag drives, and it is deliberately nothing but two
      // imperative writes: a drag changes the height on every frame, and the
      // observer setup below used to live in the same effect - so every frame of
      // a drag disconnected and rebuilt a MutationObserver AND a ResizeObserver,
      // then let their pending notifications land on the fresh observers. Two
      // observers per frame is most of why a resized dock stuttered.
      useEffect(() => {
        const node = rootRef.current
        if (node === null) return undefined
        const frame = frameFrom(node)
        applyGeometry(node, frame)
        applyInsets(frame)
        return undefined
      }, [open, height])

      // Geometry, part two: FOLLOW the app frame. Installed once while the dock
      // is open, and every callback reads `dock.height` at call time (module
      // state, so no stale closure) which is why a height change needs no new
      // observer. Deliberately NOT keyed on the revision either: every status
      // bump would churn the columns.
      useEffect(() => {
        const node = rootRef.current
        if (node === null || !open) return undefined
        const frame = frameFrom(node)
        if (frame === null) return undefined
        let observer = null
        let columnObserver = null
        const refit = () => {
          applyGeometry(node, frame)
          applyInsets(frame)
        }
        if (typeof MutationObserver === 'function') {
          // The frame's inline `style` changes when a column is dragged or the
          // right bar opens/closes: one mutation, settled immediately.
          observer = new MutationObserver(refit)
          observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-rightbar-fullscreen'] })
        }
        if (typeof ResizeObserver === 'function') {
          // The LEFT BAR is ANIMATED, which is what the observer above cannot see:
          // collapsing or expanding it rewrites the grid tracks ONCE and then
          // transitions them, so the mutation fires before the width has actually
          // changed - and never again, leaving the dock at the old left edge. The
          // two columns the dock spans change SIZE on every frame of that
          // transition, which is exactly what a ResizeObserver reports.
          columnObserver = new ResizeObserver(() => applyGeometry(node, frame))
          for (const column of columnsFor(frame)) columnObserver.observe(column)
        }
        const onTransitionEnd = (event) => {
          if (event.target === frame) applyGeometry(node, frame)
        }
        frame.addEventListener('transitionend', onTransitionEnd)
        const onResize = () => {
          refit()
        }
        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('resize', onResize)
          frame.removeEventListener('transitionend', onTransitionEnd)
          if (observer !== null) observer.disconnect()
          if (columnObserver !== null) columnObserver.disconnect()
        }
      }, [open, height])

      // The dock's own element must leave the columns as it found them when the
      // plugin goes away (a restart of the app is not the only way to unload it).
      useEffect(
        () => () => {
          for (const [column, saved] of insets) column.style.height = saved
          insets.clear()
        },
        [],
      )

      /**
       * Drag the dock's top edge.
       *
       * The height comes from the POINTER's own Y and the two values captured at
       * pointerdown, never from the dock's rect: the grip moves as the dock moves,
       * so a handler that measured it would chase itself. Moves are coalesced to
       * one per animation frame - a pointer stream is not a frame rate - and the
       * drag is closed on `pointerup` AND `pointercancel`, since a cancelled drag
       * used to leave its listeners attached and the dock still following the
       * mouse.
       */
      const onGripDown = useCallback((event) => {
        if (typeof event.button === 'number' && event.button !== 0) return
        const grip = event.currentTarget
        const startY = event.clientY
        const startHeight = dock.height
        let frame = 0
        let pending = null
        dragging = true
        if (document.body) document.body.classList.add('dsc-dragging')
        try {
          if (grip && typeof grip.setPointerCapture === 'function') grip.setPointerCapture(event.pointerId)
        } catch (err) {
          /* capture is a nicety: the window listeners cover this either way */
        }
        const apply = () => {
          frame = 0
          if (pending === null) return
          const value = pending
          pending = null
          setHeight(value)
        }
        const move = (moveEvent) => {
          pending = startHeight + (startY - moveEvent.clientY)
          if (frame === 0) frame = requestAnimationFrame(apply)
        }
        const finish = () => {
          if (frame !== 0) {
            cancelAnimationFrame(frame)
            frame = 0
          }
          if (pending !== null) {
            const value = pending
            pending = null
            setHeight(value)
          }
          dragging = false
          if (document.body) document.body.classList.remove('dsc-dragging')
          try {
            if (
              grip &&
              typeof grip.releasePointerCapture === 'function' &&
              typeof grip.hasPointerCapture === 'function' &&
              grip.hasPointerCapture(event.pointerId)
            ) {
              grip.releasePointerCapture(event.pointerId)
            }
          } catch (err) {
            /* an already-released capture is not a failure */
          }
          // The drag's last word reaches both stores NOW, not after the debounce:
          // someone who drags and immediately closes the tab should still find
          // their height.
          flushSharedHeight()
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        event.preventDefault()
      }, [])

      // ONE header row (alpha.15), dressed the way every other panel in this app
      // dresses its own: the title at the left, the controls as the app's own
      // chips at the right, and one faint line of facts between them. The version
      // moved into the brand's `title` - a 24-character build string was a third
      // of the row's right-hand half, and it is still one hover away (and still in
      // the markup the tracked check reads) - and it is ALSO on the dock root as
      // `data-dsh-cmdbar-version`, because a build string a reader has to hover for
      // is no way to answer the question this release made urgent: WHICH bundle is
      // the running host actually serving?
      //
      // That is not a hypothetical. The host SNAPSHOTS each `client.js` at boot and
      // republishes it only through its HMR hook (`dsh-client-modules`: "bundle
      // content changes reach the graph only through rebuilt()"), so editing this
      // file does NOT change what a running `dsh web` serves - a page refresh
      // cannot, and only a host restart (or the dev watcher) can. The attribute
      // makes the served revision answerable from the page instead of guessed at:
      //   document.querySelector('[data-dsh-cmdbar-dock]').dataset.dshCmdbarVersion
      //
      // alpha.13: with NO conversation on screen there are no commands to count,
      // and "0 commands, nothing run yet" would be a claim about a conversation
      // that does not exist. The line goes quiet and the body says why.
      return h(
        'div',
        {
          ref: rootRef,
          className: 'dsc-dock',
          'data-dsh-cmdbar-dock': '',
          'data-dsh-cmdbar-version': PLUGIN_VERSION,
          'data-open': open ? '' : undefined,
          'data-state': activityTone,
          role: 'region',
          'aria-label': 'The agent\u2019s commands',
        },
        h('div', { className: 'dsc-grip', role: 'separator', 'aria-orientation': 'horizontal', onPointerDown: onGripDown, title: 'Resize' }),
        h(
          'div',
          { className: 'dsc-bar' },
          h(
            'span',
            { className: 'dsc-brand', 'data-state': activityTone, title: 'dsh-cmdbar ' + PLUGIN_VERSION },
            h('span', { className: 'dsc-glyph' }, h(ActivityGlyph, { size: 14 })),
            'Agent',
          ),
          activityBusy ? h('span', { className: 'dsc-pulse', 'data-state': 'running' }) : null,
          activityUnreadable ? h('span', { className: 'dsc-warn', title: String(activity.reason) }, '\u26a0') : null,
          activityFailed
            ? h('span', { className: 'dsc-badge', 'data-tone': 'failed', title: String(activity.counts.failed) + ' failed' }, String(activity.counts.failed))
            : null,
          h('span', { className: 'dsc-spacer' }),
          h('span', { className: 'dsc-facts', title: factsTitle }, facts.join(' \u00b7 ')),
          h(
            'span',
            { className: 'dsc-filters', role: 'group', 'aria-label': 'Filters' },
            chip(
              {
                active: allTools,
                title: 'Show every tool call, not only the ones that run something',
                'aria-pressed': allTools ? 'true' : 'false',
                onClick: () => setAllTools((prev) => !prev),
              },
              'All tools',
            ),
            chip(
              {
                active: failuresOnly,
                title: 'Only show what failed',
                'aria-pressed': failuresOnly ? 'true' : 'false',
                onClick: () => setFailuresOnly((prev) => !prev),
              },
              'Failures',
            ),
          ),
          // Following is a scroll POSITION, not a mode: the chip is the way back
          // to the tail and it is only there when the reader has left it.
          follow ? null : chip({ active: true, title: 'Follow the newest command', onClick: () => setFollow(true) }, 'Follow \u2193'),
          h(
            'button',
            { type: 'button', className: 'dsc-btn dsc-btnIcon', title: 'Hide the panel', 'aria-label': 'Hide the panel', onClick: closeDock },
            h(CloseGlyph, { size: 11 }),
          ),
        ),
        // keyed on the conversation (alpha.13): following a change must reset the
        // view's own state too - the filters, the expanded rows and the follow pill
        // belong to the conversation they were set in, and carrying them into a new
        // one is exactly the "continues from the previous conversation" alpha.13
        // removes. The three the bar sets are reset by the effect above it; the
        // expanded rows are this key's.
        h(
          'div',
          { className: 'dsc-body' },
          h(ActivityView, { key: sessionId === null ? 'none' : sessionId, sessionId, model: activity, allTools, failuresOnly, follow, onFollowChange: setFollow }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------
    const inject = ['slots']

    /**
     * Register the header control and the dock. Both ride `slots.inject`, so
     * neither is lost to a registration order: the seat exists whenever the
     * conversation header or the app frame exists.
     *
     * @param ctx - the client context (inject: slots).
     */
    function apply(ctx) {
      try {
        // alpha.5: the pack's durable section, when this profile installs it.
        // `readStoredHeight` already ran at module load (this dock keeps its
        // geometry in a module-level store), so the shared value is adopted
        // here, once it lands: the section is a wire read, and until it answers
        // the localStorage copy is the only height there has ever been.
        //
        // It must NOT adopt on every announcement, which is what alpha.5 did.
        // The scope notifies on each accepted view - including the answers to
        // this client's OWN writes - so re-reading the section per notification
        // handed the dock a stale echo on every frame of a drag. `adoptDecision`
        // filters the three not-news cases (the pointer is down, our own echo,
        // the value already in force) and an adopted height is written with
        // `persist: false`, so adopting cannot itself become a write.
        sharedState = uiStateService(ctx)
        if (sharedState !== null && typeof sharedState.subscribe === 'function') {
          const adoptShared = () => {
            const next = adoptDecision({
              ready: sharedReady(),
              dragging,
              pending: sharedPending,
              shared: sharedState.get('dockHeight'),
              known: sharedKnown,
              current: dock.height,
            })
            if (next === null) return
            setHeight(next, { persist: false })
          }
          adoptShared()
          sharedState.subscribe(adoptShared)
        }
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: 'dsh-cmdbar',
                  order: HEADER_ORDER,
                },
                CmdbarButton,
              ),
            ),
          'dsh-cmdbar: header control',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register({ name: OVERLAY_SLOT, id: 'dsh-cmdbar', order: OVERLAY_ORDER }, Dock),
            ),
          'dsh-cmdbar: dock',
        )
        // A feed polls while something is subscribed (a timer, a fetch and a
        // visibilitychange listener); unloading this bundle has to stop all of
        // that explicitly.
        ctx.effect(() => () => disposeFeeds(), 'dsh-cmdbar: activity feeds')
        ctx.logger?.debug?.('[dsh-cmdbar] dock control registered (' + PLUGIN_VERSION + ', order ' + String(HEADER_ORDER) + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-cmdbar] activation failed', err)
        ctx.logger?.warn?.('[dsh-cmdbar] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.apply = apply
    exports.inject = inject
    // The bundle's PURE half, for the tracked check: the shared-section adopt
    // decision, which a static render cannot exercise - it is the whole of the
    // alpha.5 drag bug, four numbers and two flags, so it is pinned behaviourally
    // rather than by the source shape that let it ship.
    //
    // alpha.7 adds the activity half for the same reason: every claim this
    // feature makes about the agent's commands - which tools count as commands,
    // what a missing `description` means, where the exit status comes from, what
    // a result's output is, how prompts group them, and when the log has actually
    // changed - is arithmetic over an event log, and a static render would see
    // none of it.
    exports.__internals = {
      adoptDecision,
      parseExecCall,
      parseExitMarker,
      stripAnsi,
      buildActivityFromEvents,
      activitySignature,
      filterActivity,
      formatDuration,
      // alpha.14: the expanded row's own command body, and the ONE place a
      // render could throw on a click. Driven below with a multi-line command, a
      // single-line one and a collapsed row, because the crash it replaces was
      // invisible to every static render this check can make.
      commandBody,
      // alpha.15: the hover card a command LINE wears. Pure, and driven by the
      // tracked check, because the three cases that matter - a real command (the
      // card, carrying the WHOLE command), a non-command row (no card) and an
      // engine without the primitive (the bare anchor, never a crash) - are all
      // decisions, and the crash it guards against is the abdicating one.
      commandCard,
      // alpha.11: the counts the Agent control and the dock's bar wear as WORDS.
      // It is the one place those numbers reach a reader, and the bug that release
      // fixed was visible there first ("0 commands, 1 failed, nothing run yet" in
      // one breath), so it is pinned as text rather than as a source shape.
      // alpha.13 dropped the sentence it used to open with.
      activityFactsTitle,
      // alpha.13: the rule that keeps the panel on the conversation in front of
      // the reader. Four fields and one comparison, and every way it can go wrong
      // - an open panel closing itself, an absent id being ignored, a closed panel
      // polling a conversation nobody sees - is a behaviour, not a shape.
      followDecision,
      // The view itself, so the tracked check can RENDER a hand-built log: the
      // switch is off by default, so a static render of the dock can never reach
      // a row, and "the panel draws a command" would otherwise be unchecked.
      ActivityView,
    }
    return module.exports
  },
})
