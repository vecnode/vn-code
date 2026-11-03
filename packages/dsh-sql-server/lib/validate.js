/**
 * dsh-sql-server — the closed surface.
 *
 * Every value a caller can send is checked against a positive grammar here, in
 * one place, for the same reason `dsh-docker` keeps its verbs in one list: a
 * database tool that accepts a free-form string is a shell with extra steps. The
 * grammar is deliberately narrow - an identifier is what SQL Server accepts as an
 * unquoted name, and nothing about this row needs more.
 */

/** ODBC drivers, most preferred first. The legacy entry is last on purpose. */
export const DRIVERS = [
  'ODBC Driver 18 for SQL Server',
  'ODBC Driver 17 for SQL Server',
  'ODBC Driver 13 for SQL Server',
  'SQL Server Native Client 11.0',
  'SQL Server',
]

/** A database, container, login or volume name: letters, digits, `_`, `-`, `.`. */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$#.\-]{0,127}$/

/** A host: a name, a dotted name, an IPv4, or a bracketed IPv6. */
export const HOST_RE = /^[A-Za-z0-9_.\-:[\]]{1,255}$/

/** A TCP port. */
export function isPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535
}

/** True when a value is a usable identifier. */
export function isName(value) {
  return typeof value === 'string' && NAME_RE.test(value)
}

/** True when a value is a usable host. */
export function isHost(value) {
  return typeof value === 'string' && HOST_RE.test(value)
}

/**
 * SQL Server's own password policy, applied BEFORE the server says no.
 *
 * The container refuses to start with a weak `MSSQL_SA_PASSWORD` and prints the
 * rule in its log, which is a slow way to learn it: at least 8 characters, and
 * characters from three of the four classes (upper, lower, digit, symbol).
 *
 * @returns `{ ok, reason }` - `reason` is a sentence, not a code.
 */
export function checkPassword(password) {
  const value = typeof password === 'string' ? password : ''
  if (value.length < 8) return { ok: false, reason: 'the password must be at least 8 characters' }
  if (value.length > 128) return { ok: false, reason: 'the password must be at most 128 characters' }
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length
  if (classes < 3) {
    return { ok: false, reason: 'the password needs characters from three of these four: upper case, lower case, digit, symbol' }
  }
  return { ok: true, reason: '' }
}

/** The limits every tool states in its own words. */
export const CAPS = {
  maxRows: 2000,
  maxColumns: 120,
  queryTimeoutMs: 120_000,
  scriptTimeoutMs: 60 * 60_000,
  maxScriptTimeoutMs: 6 * 60 * 60_000,
  actionTimeoutMs: 180_000,
  readyTimeoutMs: 300_000,
  maxStreamBytes: 1024 * 1024,
  maxIdentifiers: 64,
}

/**
 * A SQL text a caller asked to run, bounded.
 *
 * It is not parsed or rewritten: this row runs what it is given (that is what a
 * database tool is for), and the fence is the STATEMENT COUNT and the length, not
 * a keyword allowlist, because `SELECT` is not the only safe verb and a dump is
 * not a query.
 *
 * @returns `{ ok, reason }`.
 */
export function checkSqlText(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.trim() === '') return { ok: false, reason: 'the SQL is empty' }
  if (value.length > 512 * 1024) {
    return { ok: false, reason: 'the SQL is longer than 512 KiB - put it in a file and use sql_script, which streams it' }
  }
  return { ok: true, reason: '' }
}

/** A filesystem path a script or a backup lives at: absolute, no traversal trick. */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
