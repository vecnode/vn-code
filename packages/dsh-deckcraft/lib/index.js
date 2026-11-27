/**
 * dsh-deckcraft - Node half.
 *
 * One row, four tools, no browser surface and no route: a deck is a file in the
 * workspace and a render is a directory of images, so there is nothing for the
 * right bar to draw and nothing to serve over HTTP.
 *
 * WHY IT EXISTS: DeckCraft (storytold/deckcraft, MIT OR Apache-2.0, alpha) is a
 * Rust presentation app whose every button is a command with a stable id, and
 * whose CLI can run those commands headlessly. That is the whole integration:
 * discover the ids, run a batch, save a `.deckcraft`, render it to images the
 * conversation can look at. No 200 tool wrappers, no MCP bridge to keep in step
 * with a fast-moving alpha.
 *
 * WHAT IT IS NOT: not an installer, not a `.pptx` converter of its own (DeckCraft
 * does that), and not a way to write outside the workspace - a save path or a
 * render directory must resolve inside it, or inside a root the user authorised
 * for that call.
 */

import { resolveDeckCli } from './deck.js'
import { buildTools } from './tools.js'

export const name = 'dsh-deckcraft'
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
      warn: (text) => ctx.logger?.warn?.('[dsh-deckcraft] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-deckcraft] ' + text),
    },
  }
}

/** The one activation line: is the CLI on PATH, and nothing more. */
export function activationLine(found) {
  if (!found || found.command === '') {
    return 'The DeckCraft CLI is not on PATH; the deck_* tools will name the install source until it is (github.com/storytold/deckcraft releases).'
  }
  return 'DeckCraft CLI: ' + found.command + ' (' + found.source + ').'
}

/** The one activation line. */
export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info(activationLine(resolveDeckCli(deps.env, deps.platform)))
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-deckcraft: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  activationLine,
}
