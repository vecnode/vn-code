// check-wsl-node.mjs - dsh-wsl's own contract, driven directly.
//
// The tools this row registers are a spawn and a parser; the spawn is the part
// that cannot be tested on every host (no WSL on macOS/Linux), so the check
// splits in two: the PURE half - the UTF-16 decoder, the localized table parser,
// the path conversions, the argv contract and the launcher argv order - runs
// everywhere, and the LIVE half runs on Windows and says so loudly when it
// cannot.
//
// The UTF-16 case is not cosmetic: `wsl.exe` writes UTF-16LE to a pipe, and a
// decoder that assumed UTF-8 turns one listing into "N\0A\0M\0E\0". The fixture
// below is the real byte shape.
//
// Run:  node checks/check-wsl-node.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  buildWslArgs,
  childEnv,
  decodeWslOutput,
  launcherArgs,
  listDistros,
  parseDistroList,
  parseDistroNames,
  runInWsl,
  validateArgv,
  windowsToWslPath,
  wslToWindowsPath,
  MAX_ARGV,
} from '../lib/wsl.js'
import { buildTools } from '../lib/tools.js'
import { activationLine, __internals as row } from '../lib/index.js'

let checks = 0
let failures = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(48) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

// ---------------------------------------------------------------- the manifest
check('the package is a dsh bundle with a patch layer', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml')
check('the row owns no browser half', manifest.dsh.client === undefined, true)
check('the row has no npm dependency', manifest.dependencies === undefined && manifest.peerDependencies === undefined, true)
check('the version is the alpha this check knows', manifest.version, '0.1.0-alpha.1')

// -------------------------------------------------------------- the decoder
const table =
  '  NAME            STATE           VERSION\r\n' +
  '* docker-desktop-data  Stopped    2\r\n' +
  '  Ubuntu          Stopped         2\r\n' +
  '  Debian          Running         2\r\n'
const utf16 = Buffer.from(table, 'utf16le')
check('a UTF-16 pipe payload is decoded, not mojibake', decodeWslOutput(utf16).includes('docker-desktop-data'), true)
check('...and it reaches the parser as a real table', parseDistroList(decodeWslOutput(utf16)).distros.length, 3)
check('a plain UTF-8 payload still decodes', decodeWslOutput(Buffer.from('Ubuntu\n', 'utf8')), 'Ubuntu\n')
check('a BOM is dropped', decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu', 'utf16le')])), 'Ubuntu')
check('empty bytes are empty text', decodeWslOutput(Buffer.alloc(0)), '')

// ---------------------------------------------------------------- the parser
const parsed = parseDistroList(decodeWslOutput(utf16))
check('the default distribution is the starred one', parsed.default, 'docker-desktop-data')
check('the star does not become part of the name', parsed.distros[0].name, 'docker-desktop-data')
check('state and version are read', parsed.distros[1].state + ' ' + parsed.distros[1].version, 'Stopped 2')
// A localized header is the reason the header is not matched BY NAME.
const localized = '  NOMBRE          ESTADO          VERSI\u00d3N\n* Ubuntu          Detenido        2\n'
check('a localized header is skipped, not parsed', parseDistroList(localized).distros.length, 1)
check('...and its row is still read', parseDistroList(localized).distros[0].name, 'Ubuntu')
check('no distribution at all is an empty list, not a throw', parseDistroList('').distros.length, 0)
check('a name list is one name per line', parseDistroNames('Ubuntu\nDebian\n').join(','), 'Ubuntu,Debian')

// ---------------------------------------------------------------- the paths
check('a drive path becomes /mnt/<drive>', windowsToWslPath('C:\\Users\\me\\repo'), '/mnt/c/Users/me/repo')
check('the drive letter is lowercased', windowsToWslPath('D:/Work'), '/mnt/d/Work')
check('a drive root is just the mount', windowsToWslPath('C:\\'), '/mnt/c')
check('\\\\wsl$\\ is the distribution root', windowsToWslPath('\\\\wsl$\\Ubuntu\\home\\me'), '/home/me')
check('\\\\wsl.localhost is the same thing', windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me')
check('a POSIX path survives unchanged', windowsToWslPath('/mnt/c/x'), '/mnt/c/x')
check('/mnt/c goes back to C:\\', wslToWindowsPath('/mnt/c/Users/me'), 'C:\\Users\\me')
check('the mount root goes back to a drive root', wslToWindowsPath('/mnt/d'), 'D:\\')
check('/home needs a distribution name', wslToWindowsPath('/home/me'), null)
check('...and with one it is a \\\\wsl$ path', wslToWindowsPath('/home/me', 'Ubuntu'), '\\\\wsl$\\Ubuntu\\home\\me')
check('an already-Windows path is returned as it is', wslToWindowsPath('C:\\x'), 'C:\\x')

// ---------------------------------------------------------------- the argv
check('a command STRING is refused by name', validateArgv('sh -n x.sh').error.includes('ARRAY'), true)
check('...and the sentence shows the array form', validateArgv('sh -n x.sh').error.includes('["sh", "-n"'), true)
check('an empty array is refused', validateArgv([]).error.includes('empty'), true)
check('a non-string element is refused', validateArgv(['node', 1]).error.includes('string'), true)
check('a NUL byte is refused', validateArgv(['node', 'a\u0000b']).error.includes('NUL'), true)
check('too many elements are refused', validateArgv(new Array(MAX_ARGV + 1).fill('x')).error.includes('limit'), true)
check('a valid array survives as it was', validateArgv(['node', '--version']).argv.join(' '), 'node --version')
check(
  'the launcher argv is distribution, options, then --',
  buildWslArgs({ distro: 'Ubuntu', cwd: '/mnt/c/repo', argv: ['node', '-v'] }).join('|'),
  '-d|Ubuntu|--cd|/mnt/c/repo|--|node|-v',
)
check('no distribution and no cwd is still a valid argv', buildWslArgs({ argv: ['true'] }).join('|'), '--|true')
// The trap this package was built through: `wsl -- -l -v` is NOT "list distros",
// it is "run a program named -l". Listing therefore never goes through the
// program form.
check('the launcher flags never take a --', launcherArgs(['-l', '-v']).join('|'), '-l|-v')
check('...while a program always does', buildWslArgs({ argv: ['node'] }).includes('--'), true)
const env = childEnv({ PATH: 'p', SystemRoot: 's', USERPROFILE: 'u', DSH_HOME: 'x', AWS_SECRET_ACCESS_KEY: 'no', WSLENV: 'keep' })
check('the child environment carries no harness variable', env.DSH_HOME === undefined && env.AWS_SECRET_ACCESS_KEY === undefined, true)
check('...and keeps the profile variables the launcher needs', env.USERPROFILE, 'u')
check('...and the launcher\u2019s own WSLENV', env.WSLENV, 'keep')

// ---------------------------------------------------------------- the tools
const refused = (deps, name, args) =>
  buildTools(deps)
    .find((tool) => tool.name === name)
    .execute(args)

const tools = buildTools({ platform: 'linux', env: {} })
check('three tools are registered', tools.map((tool) => tool.name).join(','), 'wsl_status,wsl_run,wsl_path')
check('every tool takes a closed object of arguments', tools.every((tool) => tool.parameters.type === 'object' && tool.parameters.additionalProperties === false), true)
check('wsl_run requires an argv array', tools[1].parameters.required.join(','), 'argv')
check('wsl_run declares the argv as an array of strings', tools[1].parameters.properties.argv.type, 'array')
check(
  'wsl_run says a single string is refused, in its own description',
  tools[1].description.includes('never the string') && tools[1].description.includes('["sh", "-n", "scripts/run-web.sh"]'),
  true,
)
check('every tool returns prose plus a view', tools.every((tool) => typeof tool.output.render === 'function' && typeof tool.execute === 'function'), true)
check('wsl_path needs no spawn, so it answers on any host', (await refused({ platform: 'linux', env: {} }, 'wsl_path', { path: 'C:\\repo' })).view.to, '/mnt/c/repo')
const linuxAnswer = await refused({ platform: 'linux', env: {} }, 'wsl_status', {})
check('on a non-Windows host wsl_status refuses BY NAME', linuxAnswer.text.includes('WSL is a Windows feature'), true)
check('...and the refusal names the right tool instead', linuxAnswer.text.includes('bash'), true)
const linuxRun = await refused({ platform: 'linux', env: {} }, 'wsl_run', { argv: ['true'] })
check('on a non-Windows host wsl_run refuses too', linuxRun.text.includes('WSL is a Windows feature'), true)
const wrongArgv = await refused({ platform: 'win32', env: {} }, 'wsl_run', { argv: 'node -v' })
check('a string command is refused before any spawn', wrongArgv.text.includes('must be an ARRAY'), true)
check('the activation line says which side it is on', activationLine('linux').includes('inert on linux'), true)
check('...and on Windows it names the launcher', activationLine('win32').includes('wsl.exe'), true)
check('the row exports what a check can drive', typeof row.buildTools === 'function' && typeof row.createDeps === 'function', true)

// ---------------------------------------------------------------- the live half
// Listing distributions does not BOOT one, so it is safe to ask here; running a
// command boots the distribution, so that part is opt-in by environment.
if (process.platform !== 'win32') {
  console.log('skip the live WSL listing                              (not Windows)')
} else {
  const listed = await listDistros({ platform: process.platform })
  if (!listed.ok) {
    console.log('skip the live WSL listing                              (launcher said: ' + String(listed.error).split('\n')[0] + ')')
  } else {
    check('the live listing finds at least one distribution', listed.distros.length > 0, true)
    console.log('     live distros: ' + listed.distros.map((entry) => entry.name + (entry.default ? '*' : '')).join(', '))
    if (process.env.DSH_WSL_CHECK_LIVE === '1') {
      // NOT the default distribution on purpose: on a machine that runs Docker
      // Desktop the default is `docker-desktop-data`, which cannot run a program
      // at all - the exact trap the tools warn about, so the live check names a
      // real distribution instead of tripping over it.
      const runnable = listed.distros.find((entry) => !/^docker/i.test(entry.name)) || null
      if (runnable === null) {
        console.log('skip a live command in a distribution                    (only Docker distributions are installed)')
      } else {
        const ran = await runInWsl({ argv: ['sh', '-c', 'echo wsl-ok'], distro: runnable.name, timeoutMs: 180000, platform: process.platform })
        check('a live command in ' + runnable.name + ' exits 0', ran.code, 0)
        check('...and its stdout comes back as text', (ran.stdout || '').includes('wsl-ok'), true)
      }
    } else {
      console.log('skip a live command in a distribution                    (set DSH_WSL_CHECK_LIVE=1 to boot one)')
    }
  }
}

console.log('')
console.log(failures === 0 ? 'check-wsl-node: ' + checks + ' checks OK' : 'check-wsl-node: ' + failures + ' of ' + checks + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
