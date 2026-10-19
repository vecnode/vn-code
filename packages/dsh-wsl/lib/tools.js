/**
 * dsh-wsl - the three tools.
 *
 * The surface is deliberately small, because each tool is a question a person
 * asks once and then stops asking:
 *
 *   - `wsl_status` - what distributions are here, which one is the default, and
 *     (on request) whether a distribution can actually run this repo's checks;
 *   - `wsl_run`    - run one argv array in a distribution and bring the answer
 *     back with its exit code;
 *   - `wsl_path`   - the one conversion that is wrong in every hand-written
 *     script, `C:\...` <-> `/mnt/c/...`.
 *
 * They exist so the POSIX half of this pack can be TESTED on the machine that
 * writes it: `scripts/run-web.sh`, `scripts/setup/install.sh` and the checks that
 * honour them are sh, and a Windows-only development loop never runs them.
 */

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  hasLauncher,
  listDistros,
  refusal,
  runInWsl,
  windowsToWslPath,
  wslToWindowsPath,
} from './wsl.js'

/** The output shape every tool here returns: prose for the model, a view for the card. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** One path argument. */
const PATH_SCHEMA = {
  type: 'string',
  description: 'A path, Windows or POSIX. `C:\\Users\\me\\repo` becomes `/mnt/c/Users/me/repo`.',
}

/** How much of one stream is echoed into the answer. */
const ANSWER_CHARS = 24000

/** Cut a stream for the answer, saying that it was cut. */
function clip(text) {
  const value = String(text === undefined || text === null ? '' : text)
  if (value.length <= ANSWER_CHARS) return value
  return value.slice(0, ANSWER_CHARS) + '\n\u2026 [' + (value.length - ANSWER_CHARS) + ' more characters; the answer is cut]'
}

/** The sentence that says where WSL is not. */
function notWindows() {
  return refusal(
    'WSL is a Windows feature, and this host is not Windows. On macOS or Linux the distribution you would ask for is the machine you are already on: use the harness\'s own `bash` tool (or `pwsh` on Windows) instead of `wsl_run`.',
  )
}

/** Build the tools. @param deps - `{ platform, env, cwd }` from the row. */
export function buildTools(deps) {
  const platform = deps.platform || process.platform

  /** `wsl_status`: what is installed, and what can run. */
  const status = {
    name: 'wsl_status',
    description: [
      'Check whether Windows Subsystem for Linux is installed on this machine, which distributions it has, which one is the default, and - with `probe` - whether a distribution can actually run a command.',
      'Use this BEFORE `wsl_run` when you do not know the distribution names: `wsl_run` defaults to the launcher\'s default distribution, and on a machine that runs Docker Desktop that default is `docker-desktop-data`, NOT the Ubuntu a person installed. Naming the distribution is the fix.',
      '`probe` runs `node --version` in the chosen distribution (one boot, a few seconds), which is what tells you whether a check written for Linux can run there at all.',
      'This tool never changes anything: it lists and it asks questions.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        distro: { type: 'string', description: 'Probe this distribution instead of the default one.' },
        probe: { type: 'boolean', description: 'Also run `node --version` (and `sh -c`-free `git --version`) in the chosen distribution. Default: false - a probe boots the distribution.' },
      },
    },
    output: OUTPUT,
    presentCall: () => ({ card: 'generic', title: 'Check WSL', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'WSL status', content: result && result.text ? result.text : '' }),
    async execute(args) {
      if (platform !== 'win32') return notWindows()
      const installed = await hasLauncher({ platform: platform, env: deps.env })
      if (!installed) {
        return refusal(
          'Windows Subsystem for Linux is not available on this machine (no working `wsl.exe`). Install it from an elevated terminal with `wsl --install`, reboot, and try again - a distribution installed this way comes with WSL 2 already enabled.',
        )
      }
      const listed = await listDistros({ platform: platform, env: deps.env })
      if (!listed.ok) return refusal(listed.error)
      const chosen = typeof args.distro === 'string' && args.distro !== '' ? args.distro : listed.default
      const lines = ['WSL is installed. Default distribution: ' + (listed.default === '' ? 'not marked' : listed.default) + '.']
      lines.push('')
      lines.push('NAME                 STATE       VERSION')
      for (const entry of listed.distros) {
        lines.push(
          (entry.default ? '* ' : '  ') +
            entry.name.padEnd(20) +
            ' ' +
            String(entry.state).padEnd(11) +
            ' ' +
            (entry.version > 0 ? String(entry.version) : '?'),
        )
      }
      if (chosen !== '' && !listed.distros.some((entry) => entry.name === chosen)) {
        lines.push('')
        lines.push('There is no distribution named "' + chosen + '" here. Pass one of the names above as `distro`.')
      }
      if (args.probe === true) {
        if (chosen === '') {
          lines.push('')
          lines.push('No default distribution is marked, so there is nothing to probe. Name one with `distro`.')
        } else {
          lines.push('')
          lines.push('Probe of ' + chosen + ':')
          for (const argv of [['node', '--version'], ['git', '--version'], ['sh', '-c', 'echo ok']]) {
            const result = await runInWsl({ argv: argv, distro: chosen, timeoutMs: 30000, env: deps.env, platform: platform })
            if (result.error !== undefined) {
              lines.push('  ' + argv.join(' ') + ' -> not run: ' + result.error)
              continue
            }
            const said = (result.stdout || '').trim().split(/\r?\n/)[0] || (result.stderr || '').trim().split(/\r?\n/)[0] || '(no output)'
            lines.push('  ' + argv.join(' ') + ' -> exit ' + result.code + ': ' + said)
          }
          lines.push('')
          lines.push('A distribution is booted on its first command; expect the first probe to take a few seconds.')
        }
      } else {
        lines.push('')
        lines.push('Pass `probe: true` to run `node --version` in the chosen distribution. Pass this distribution name as `distro` to `wsl_run` - the launcher\'s default is not always the one a person means.')
      }
      return {
        text: lines.join('\n'),
        view: { ok: true, default: listed.default, distros: listed.distros, probe: args.probe === true },
      }
    },
  }

  /** `wsl_run`: one argv array, one exit code. */
  const run = {
    name: 'wsl_run',
    description: [
      'Run a program inside a Windows Subsystem for Linux distribution and return its exit code, stdout and stderr. This is how the POSIX half of a repository is tested on a Windows machine: `scripts/run-web.sh`, `scripts/setup/install.sh`, and any check that is sh.',
      '`argv` is an ARRAY, one element per argument - `["sh", "-n", "scripts/run-web.sh"]`, never the string `"sh -n scripts/run-web.sh"`. The elements go to the launcher as arguments and no shell is involved, so a quote, a `;` or a `$(...)` in them is a character in an argument rather than something that runs.',
      '`cwd` accepts either spelling and is converted for you: `C:\\Users\\me\\repo` is sent as `/mnt/c/Users/me/repo`. Point it at the repository you are working in, because that is what makes the checks run against the same files you are editing - on a dual-boot machine the distribution sees them under `/mnt/<drive>/...`.',
      '`distro` defaults to the launcher\'s own default, which on a machine with Docker Desktop is `docker-desktop-data` rather than the Ubuntu a person installed. When the answer looks like the wrong filesystem, ask `wsl_status` and name the distribution.',
      'A command that outlives `timeoutMs` (default 120 s, at most 600 s) is killed - the child process tree with it on Windows, so a timed-out build does not keep a core. Output is capped at ' + MAX_OUTPUT_BYTES + ' bytes per stream and the answer says when it was cut.',
      'What this does NOT do: it does not start a shell for you (`$VAR`, pipes and redirection do not exist here), it does not read or write inside the distribution for you, and it does not bridge a port. If you need shell syntax, run the shell as the program: `["bash", "-lc", "…"]` is then an explicit choice you made with your eyes open.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['argv'],
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'The program and its arguments, one array element each. Example: ["node", "scripts/checks/check-node-routes.mjs"].',
        },
        distro: { type: 'string', description: 'The distribution to run in. Default: the launcher\'s default (see `wsl_status`).' },
        cwd: PATH_SCHEMA,
        timeoutMs: { type: 'number', description: 'Deadline in milliseconds. Default ' + DEFAULT_TIMEOUT_MS + ', maximum ' + MAX_TIMEOUT_MS + '.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({
      card: 'generic',
      title: 'WSL: ' + (args && Array.isArray(args.argv) ? args.argv.slice(0, 4).join(' ') : 'run'),
      kind: 'other',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'WSL result',
      content: result && result.text ? result.text : '',
    }),
    async execute(args) {
      if (platform !== 'win32') return notWindows()
      const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? windowsToWslPath(args.cwd) : undefined
      const result = await runInWsl({
        argv: args.argv,
        distro: typeof args.distro === 'string' && args.distro !== '' ? args.distro : undefined,
        cwd: cwd,
        timeoutMs: args.timeoutMs,
        env: deps.env,
        platform: platform,
      })
      if (result.error !== undefined) return refusal(result.error)
      const lines = []
      const where = (typeof args.distro === 'string' && args.distro !== '' ? args.distro : 'the default distribution') + (cwd === undefined ? '' : ' at ' + cwd)
      lines.push('$ ' + (Array.isArray(args.argv) ? args.argv.join(' ') : '') + '   (' + where + ')')
      lines.push('exit ' + result.code + ' \u00b7 ' + (result.durationMs / 1000).toFixed(1) + ' s' + (result.timedOut ? ' \u00b7 KILLED at the deadline' : ''))
      const out = clip(result.stdout)
      const errText = clip(result.stderr)
      if (out.trim() !== '') {
        lines.push('')
        lines.push('stdout:')
        lines.push(out.replace(/\s+$/, ''))
      }
      if (errText.trim() !== '') {
        lines.push('')
        lines.push('stderr:')
        lines.push(errText.replace(/\s+$/, ''))
      }
      if (out.trim() === '' && errText.trim() === '') lines.push('(no output)')
      if (result.cut) lines.push('\n[output exceeded the byte cap and was cut]')
      if (result.timedOut) {
        lines.push('')
        lines.push('The command did not finish inside the deadline and was killed. A build that needs longer can be given more with `timeoutMs` (maximum ' + MAX_TIMEOUT_MS + ' ms).')
      }
      return {
        text: lines.join('\n'),
        view: {
          ok: result.code === 0,
          code: result.code,
          timedOut: result.timedOut === true,
          cut: result.cut === true,
          durationMs: result.durationMs,
          cwd: cwd === undefined ? '' : cwd,
          distro: typeof args.distro === 'string' ? args.distro : '',
        },
      }
    },
  }

  /** `wsl_path`: the conversion every hand-written script gets wrong. */
  const pathTool = {
    name: 'wsl_path',
    description: [
      'Convert a path between Windows and the distribution\'s view of it. `C:\\Users\\me\\repo` is `/mnt/c/Users/me/repo` inside WSL; `\\\\wsl$\\Ubuntu\\home\\me` is `/home/me`.',
      'Use this when you are about to write a path into a command run by `wsl_run`, or when an answer from the distribution names a path you want to open with a Windows tool. `wsl_run` already converts its own `cwd`, so this is for everything else.',
      'Nothing is touched on disk: it is one string in, one string out.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        to: { type: 'string', enum: ['wsl', 'windows'], description: 'The direction. Default: inferred - a drive letter or a UNC path means "to wsl", a POSIX path means "to windows".' },
        distro: { type: 'string', description: 'Needed only for "to windows" on a path that is not under /mnt/<drive>: the distribution\'s name is part of the UNC path.' },
      },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Convert a path', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Path', content: result && result.text ? result.text : '' }),
    async execute(args) {
      const value = typeof args.path === 'string' ? args.path : ''
      if (value === '') return refusal('`path` is required.')
      const direction = args.to === 'wsl' || args.to === 'windows' ? args.to : /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? 'wsl' : 'windows'
      if (direction === 'wsl') {
        const converted = windowsToWslPath(value)
        return { text: value + '\n  -> ' + converted, view: { ok: true, from: value, to: converted, direction } }
      }
      const converted = wslToWindowsPath(value, typeof args.distro === 'string' ? args.distro : undefined)
      if (converted === null) {
        return refusal(
          '"' +
            value +
            '" is inside the distribution\'s own filesystem, so its Windows path needs the distribution\'s name: pass `distro` (for example `distro: "Ubuntu"`), and the answer is a \\\\wsl$\\ path a Windows program can open only while that distribution is running.',
        )
      }
      return { text: value + '\n  -> ' + converted, view: { ok: true, from: value, to: converted, direction } }
    },
  }

  return [status, run, pathTool]
}
