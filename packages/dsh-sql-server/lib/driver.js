/**
 * dsh-sql-server — the ODBC driver, which is the half a container cannot give you.
 *
 * This is the distinction that costs people an afternoon: an `mssql` container is
 * a SERVER, and `pyodbc` connects through a DRIVER that lives on the HOST. A
 * machine can have SQL Server running and answering, `sqlcmd` inside the image
 * working, every table loaded - and still fail the application with "Can't open
 * lib 'ODBC Driver 17 for SQL Server'".
 *
 * The driver is also the one thing here that needs administrator rights, so the
 * row does not pretend to install it silently: `sql_driver` reports what is
 * installed, names the exact command per platform, and runs it only when the
 * caller passes `confirm: "install"` - and then it reports the exit code instead
 * of assuming success.
 *
 * The legacy `SQL Server` entry is the trap: Windows ships it, `pyodbc.drivers()`
 * lists it, and it predates TLS 1.2, which SQL Server 2022 requires - so a
 * connection through it fails with "the client and server cannot communicate,
 * because they do not possess a common algorithm". That is why it sorts last.
 */

import { CAPS, DRIVERS } from './validate.js'
import { pickDriver, probe } from './discover.js'
import { firstLine } from './cli.js'

/** A typed failure for the driver surface. */
export class DriverError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DriverError'
    this.code = code
  }
}

/**
 * What this machine can hand an application.
 *
 * @returns `{ ok, drivers, picked, missing, next }` - `next` is a sentence, so a
 *   caller that only prints the answer still tells a person what to do.
 */
export async function driverState(deps) {
  const found = await deps.odbcDrivers()
  const picked = pickDriver(found.names)
  const ok = picked.name !== '' && picked.modern
  const next = ok
    ? 'pyodbc can connect with "' + picked.name + '".'
    : picked.name === ''
      ? 'No SQL Server ODBC driver is installed on this machine; an application (pyodbc, SSMS, Excel) cannot connect until one is. Call `sql_driver` action=install for the exact command.'
      : 'Only the legacy "' + picked.name + '" driver is installed. It predates TLS 1.2, which SQL Server 2022 REQUIRES for encrypted connections - so it works against a server that accepts an unencrypted connection and fails with "do not possess a common algorithm" against one that does not (force encryption, Azure SQL, most production instances). Measured: it DOES connect to a stock mssql 2022 container. Install ODBC Driver 18 before believing a connection failure is your code\'s fault.'
  return {
    ok: ok,
    drivers: found.names,
    source: found.source,
    picked: picked.name,
    missing: ok ? [] : DRIVERS.slice(0, 2),
    next: next,
  }
}

/**
 * The install command for this platform, as data.
 *
 * Nothing is run here: a plan is what a person reads before consenting to a
 * machine-wide install, and what `runInstall` runs when consent is given.
 *
 * @returns `{ platform, commands, note, needsElevation }` - `commands` is a list
 *   of `{ program, argv, why }`.
 */
export function installPlan(deps) {
  if (deps.platform === 'win32') {
    return {
      platform: 'windows',
      needsElevation: true,
      note: 'ODBC drivers are machine-wide, so this needs an elevated shell. `winget` will raise UAC; if nothing appears, run the command in an Administrator terminal.',
      commands: [
        {
          program: 'winget',
          argv: ['install', '--id', 'Microsoft.ODBCDriver18', '-e', '--accept-package-agreements', '--accept-source-agreements'],
          why: 'ODBC Driver 18 for SQL Server, the driver that speaks TLS 1.2 the way SQL Server 2022 requires.',
        },
      ],
    }
  }
  if (deps.platform === 'darwin') {
    return {
      platform: 'macos',
      needsElevation: true,
      note: 'The Microsoft tap carries msodbcsql18; the formula asks for the licence with MSODBCSQL18_ACCEPT_EULA=Y.',
      commands: [
        { program: 'brew', argv: ['tap', 'microsoft/mssql-release', 'https://github.com/Microsoft/homebrew-mssql-release'], why: 'the tap that has msodbcsql18' },
        { program: 'brew', argv: ['install', 'microsoft/mssql-release/msodbcsql18'], why: 'the driver itself' },
      ],
    }
  }
  return {
    platform: 'linux',
    needsElevation: true,
    note: 'The Microsoft package repository, not the distribution\'s: the distro package is renamed and pinned to an old version. The commands are for Debian/Ubuntu; adapt for rpm.',
    commands: [
      { program: 'curl', argv: ['-sSL', '-o', '/tmp/packages-microsoft-prod.deb', 'https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb'], why: 'the repository metadata' },
      { program: 'dpkg', argv: ['-i', '/tmp/packages-microsoft-prod.deb'], why: 'register the repository (needs root)' },
      { program: 'apt-get', argv: ['update'], why: 'refresh the package lists' },
      { program: 'apt-get', argv: ['install', '-y', 'msodbcsql18'], why: 'the driver; it asks for the licence on first install' },
    ],
  }
}

/**
 * Run the platform's install command, when the caller has said so explicitly.
 *
 * @param options - `{ confirm }`; the install runs only for `confirm: 'install'`.
 * @returns `{ ran, program, argv, code, stdout, stderr, elapsedMs, note }`.
 * @throws DriverError NO_CONSENT when `confirm` is anything else, and NOT_FOUND
 *   when the program is not on this machine.
 */
export async function runInstall(deps, options = {}) {
  if (options.confirm !== 'install') {
    throw new DriverError('NO_CONSENT', 'Installing an ODBC driver changes this machine for every application and needs administrator rights, so it runs only with confirm: "install". Nothing was changed.')
  }
  const plan = installPlan(deps)
  const level = options.driver === '17' ? '17' : '18'
  const command = plan.commands[plan.commands.length - 1]
  const argv = command.argv.map((part) => (level === '17' ? part.replace('18', '17') : part))
  const probed = await probe(deps, command.program, ['--version'], 15_000)
  if (!probed.found) {
    throw new DriverError(
      'NOT_FOUND',
      '`' + command.program + '` is not on this machine, so this row cannot run the install. The command to run by hand is: ' + command.program + ' ' + argv.join(' '),
    )
  }
  const timeoutMs = Math.max(CAPS.actionTimeoutMs, 10 * 60_000)
  const result = await deps.runner(command.program, argv, { env: deps.env, timeoutMs: timeoutMs })
  return {
    ran: true,
    program: command.program,
    argv: argv,
    code: result.code,
    stdout: firstLine(result.stdout, 400),
    stderr: firstLine(result.stderr || result.error, 400),
    elapsedMs: result.elapsedMs,
    note:
      result.code === 0
        ? 'The command reported success. Re-run `sql_driver` action=status to confirm the driver is listed - a silent MSI that failed on UAC can still exit 0 on some winget builds.'
        : 'The command did not succeed. On Windows this is almost always elevation (UAC): run the same command in an Administrator terminal.',
  }
}
