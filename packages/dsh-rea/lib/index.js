/**
 * dsh-rea - Node half.
 *
 * One row, five tools, no browser surface and no route: an investigation is JSON
 * on disk and prose for the model, so there is nothing for the right bar to draw
 * and nothing to serve over HTTP.
 *
 * WHY IT EXISTS: REA (morluto/rea, MIT) gives a coding agent the tools to inspect
 * a program it cannot read the source of - a native binary, an Electron app, a
 * .NET assembly, a website. It ships an MCP server and a CLI. This row takes the
 * CLI, because a tool call that can be argued about (which command, which target,
 * which slice of the report) is worth more in a conversation than forty MCP tools
 * the model has to choose from blind. REA is the user's program: nothing here
 * installs, venders or downloads it.
 *
 * WHAT IT IS NOT: not an installer (`rea_status` names the command and stops),
 * not a licence for the native providers a deep analysis needs (Hopper, Ghidra,
 * IDA, Kuna are the user's own), and not a way to analyse somebody else's
 * machine: a target is scoped to the session workspace or a root the caller
 * names, and a URL needs an explicit opt-in.
 */

import { resolveRea } from './rea.js'
import { buildTools } from './tools.js'

export const name = 'dsh-rea'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/**
 * The row's shared dependencies, one per boot.
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ platform, env }`, for the checks.
 */
export function createDeps(ctx, options = {}) {
  return {
    ctx,
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    log: {
      warn: (text) => ctx.logger?.warn?.('[dsh-rea] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-rea] ' + text),
    },
  }
}

/**
 * The one activation line. It says whether REA is on PATH and nothing more:
 * running `rea --version` at every harness start is a cost with no picture to
 * show for it, and `rea_status` is the tool that asks.
 */
export function activationLine(found) {
  if (!found || found.command === '') {
    return 'REA is not on PATH; the rea_* tools will name the install command until it is (npm install --global rea-agents).'
  }
  return 'REA: ' + found.command + ' (' + found.source + ').'
}

/** The one activation line. */
export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info(activationLine(resolveRea(deps.env, deps.platform)))
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-rea: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  activationLine,
}
