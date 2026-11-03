---
name: sql-server-ops
description: Run a development SQL Server on this machine through the sql_* tools - read the four independent facts first (a server, a client, a listening port, and the machine-wide ODBC DRIVER the application connects with), start the container, install the driver, query it, and read the state honestly when the container is up but the application still cannot connect. Covers Windows, macOS and Linux, the legacy "SQL Server" driver trap, the sa password policy, and what these tools deliberately refuse to touch.
whenToUse: Use whenever the task involves a SQL Server on this machine - "do I have SQL Server", "start a database for this repo", "why does pyodbc say it cannot find ODBC Driver 17", "the container is running but the app cannot connect", "what databases are on this server", "connect to localhost:1433", "is my SQL Server up", or a project whose .env expects DB_SERVER and a ProductHub-style database.
---

# A SQL Server on this machine, honestly reported

Seven tools, one rule: **`sql_status` first, then the smallest verb that answers
the question.** The reason is that "is there a SQL Server here" is FOUR separate
questions, and every painful afternoon comes from collapsing them:

| fact | who owns it | what it means when missing |
|---|---|---|
| a **server** | `sql_server` (a container this row owns) or a native service | nothing to connect to |
| a **client** | `sqlcmd` on the PATH, or the one inside the image | you cannot send a statement |
| a **listening port** | the server, once it is really ready | "running" but not yet accepting logins |
| an **ODBC DRIVER** | the HOST, machine-wide | the SERVER works and YOUR APP still cannot connect |

That last row is the one that wastes the afternoon. A container has no bearing on
whether `pyodbc` can connect: ODBC drivers live on the host, are registered
machine-wide (Windows: `HKLM\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers`; unixODBC:
`odbcinst.ini`), and installing one needs administrator rights.

| question | tool |
|---|---|
| what does this machine have, all four facts | `sql_status` |
| start / stop / restart / remove / logs of the container | `sql_server` |
| which ODBC drivers are installed, install one | `sql_driver` |
| run one statement | `sql_query` |
| load a `.sql` file | `sql_script` (see the `sql-script-ingest` skill) |
| databases, tables, columns, row counts | `sql_database` |
| restore a `.bak` | `sql_restore` |

## The order to call them in

1. **`sql_status`.** It never fails for "nothing here": it reports the container
   (if any), the CLI and whether its daemon answers, the native Windows services,
   whether 127.0.0.1:1433 is listening, and the drivers. Its `next` sentence is
   the one to act on.
2. **`sql_server` action=start** when there is no server. It pulls
   `mcr.microsoft.com/mssql/server:2022-latest` once (1.7 GB), publishes 1433,
   mounts the named volume `dsh-sql-data` at `/var/opt/mssql`, and then WAITS until
   the server answers `SELECT 1` - not merely until the container says `running`.
   A new container needs a password for `sa`: set `DSH_SQL_SA_PASSWORD`, or pass
   `password`. At least 8 characters from three of: upper, lower, digit, symbol.
   The image refuses a weak one in its own log, which is a slow way to learn it.
3. **`sql_driver`** when `sql_status` says the driver is missing or legacy.
   `action=status` is the report, `action=plan` is the exact command for THIS
   platform, `action=install` needs `confirm: "install"` because it changes the
   machine for every application.
4. Then `sql_database` / `sql_query` / `sql_script`.

## The legacy driver trap

Windows ships a driver that registers itself as `SQL Server` (not "ODBC Driver
17/18"). `pyodbc.drivers()` lists it, code finds it, and then the connection can
fail with:

```
TCP Provider: The client and server cannot communicate, because they do not
possess a common algorithm.
```

That is TLS: the legacy driver predates TLS 1.2, and SQL Server 2022 requires TLS
1.2 **for encrypted connections**. So the failure depends on the server:

| server | legacy driver |
|---|---|
| a stock `mssql 2022` container, `TrustServerCertificate=yes`, no forced encryption | **connects** - measured on this pack's own probe |
| forced encryption, Azure SQL, most production instances | fails with the message above |

Two consequences. First, `sql_driver` sorts it last and calls the risk out, but it
does not refuse to use it: a connection that works is the answer to the question.
Second, when a connection fails on a machine with only the legacy driver, install
ODBC Driver 18 BEFORE believing the failure is your code's:

```powershell
winget install --id Microsoft.ODBCDriver18 -e   # Windows, elevated
```
```sh
brew tap microsoft/mssql-release https://github.com/Microsoft/homebrew-mssql-release
brew install microsoft/mssql-release/msodbcsql18      # macOS
```
```sh
# Debian/Ubuntu: Microsoft's repository, not the distribution's package
curl -sSL -o /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb
sudo dpkg -i /tmp/packages-microsoft-prod.deb && sudo apt-get update && sudo apt-get install -y msodbcsql18
```

The driver name is what an application puts in its connection string, and the
braces are part of it: `DRIVER={ODBC Driver 18 for SQL Server}`.

## Connecting an application

The environment these tools read is the same one a project's backend reads, so one
set of variables configures both:

| variable | default | what it is |
|---|---|---|
| `DSH_SQL_HOST` | `127.0.0.1` | the server |
| `DSH_SQL_PORT` | `1433` | the instance port |
| `DSH_SQL_USER` | `sa` | the login |
| `DSH_SQL_SA_PASSWORD` | — | the password (never echoed back, never in argv on the host) |
| `DSH_SQL_CONTAINER` | `dsh-sql-server` | the container whose own `sqlcmd` is used |
| `DSH_SQL_VOLUME` | `dsh-sql-data` | where the databases live |

For a Python application the same values become a pyodbc string:

```python
import pyodbc, os

conn = pyodbc.connect(
    "DRIVER={ODBC Driver 18 for SQL Server};"
    f"SERVER={os.environ.get('DB_SERVER', 'localhost,1433')};"
    f"DATABASE={os.environ['DB_DATABASE']};"
    f"UID={os.environ['DB_USERNAME']};PWD={os.environ['DB_PASSWORD']};"
    "TrustServerCertificate=yes;",   # the container's certificate is self-signed
    autocommit=True,
)
```

Two details that are not optional: `TrustServerCertificate=yes` (ODBC 18 encrypts
by default and every container's certificate is self-signed), and the port with a
COMMA after the host (`localhost,1433`), not a colon.

## What these tools will not do

- **Manage a native instance.** `MSSQLSERVER` / `MSSQL$SQLEXPRESS` are detected and
  reported, never started or stopped: that service may be somebody's other work.
- **Remove data.** `sql_server action=remove` needs `confirm` equal to the
  container name, and the databases are in the named volume, so the container goes
  and the data stays. Removing the volume is not something the schema can spell.
- **Back up.** `sql_restore` restores; there is no `backup` action, because a
  backup is a file the SERVER writes somewhere it can reach.
- **Hide a failure.** Every answer states the transport it used (`container` or
  `host`), the elapsed time, and the server's own `Msg <n>, Level <l>` line.

## Reading the state when it looks wrong

| symptom | what it really is |
|---|---|
| `sql_status` says running, `sql_query` says "Login failed" | the server is up and not ready yet: wait, or `sql_server` action=start again (it waits) |
| listening is `yes`, driver is empty | the server is fine; the APPLICATION has no door - `sql_driver` |
| "Invalid object name" for a table the dump created | wrong database: pass `database`, and check with `sql_database action=tables` |
| the container exists and will not start | `sql_server` action=logs; the image prints its own reason (weak password, 2 GB of memory, no EULA) |
| `docker ps` contradicts itself after a killed create | the engine has a stuck name; use another `container`, or restart Docker Desktop |
