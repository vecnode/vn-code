/**
 * dsh-wsl - Node half.
 *
 * One row, three tools, no browser surface and no route: "run this in Linux" is
 * a host question and the answer is an exit code and some text, so there is
 * nothing for the right bar to draw and nothing to serve over HTTP.
 *
 * WHY IT EXISTS: this pack ships a POSIX half - `scripts/run-web.sh`,
 * `scripts/setup/install.sh`, the `sh` branches of the checks - and a person
 * developing it on Windows runs none of it. WSL is already on the machine that
 * has this problem, so the fix is three tools that ask the launcher what exists
 * and then run one argv array in a distribution.
 *
 * WHAT IT IS NOT: not a shell (argv only, no command string), not a bridged
 * port, not a file bridge (the distribution sees `C:` as `/mnt/c`, which is the
 * bridge), and not a way to install a distribution - `wsl --install` wants an
 * elevated terminal, and this row will say so rather than try.
 *
 * OS-NEUTRAL BY CONSTRUCTION: the code runs everywhere, imports no Windows API,
 * and answers "WSL is a Windows feature" on macOS and Linux instead of failing
 * to load. The spawn is `wsl.exe` with an argv array and a deadline.
 */

import { buildTools } from './tools.js'
import { WSL_EXE } from './wsl.js'

export const name = 'dsh-wsl'
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
      warn: (text) => ctx.logger?.warn?.('[dsh-wsl] ' + text),
      info: (text) => ctx.logger?.info?.('[dsh-wsl] ' + text),
    },
  }
}

/**
 * The one activation line.
 *
 * It says which side of the fence this machine is on and nothing more: listing
 * the distributions would boot the WSL service at every harness start, which is
 * a cost with no picture to show for it. `wsl_status` is the tool that asks.
 */
export function activationLine(platform) {
  if (platform !== 'win32') {
    return 'WSL is a Windows feature; this row is inert on ' + platform + ' (the shell it would reach for is already here).'
  }
  return 'active: tools run one argv array in a WSL distribution through ' + WSL_EXE + ' (ask `wsl_status` for the list)'
}

export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info(activationLine(deps.platform))
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-wsl: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  activationLine,
}
