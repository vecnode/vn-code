# dsh-sql-server

SQL Server as a surface: **seven `sql_*` tools** over a container this row owns, or
the `sqlcmd` already on the machine's PATH. Host-only, zero npm dependencies, no
bundled engine, no route and no browser tab.

```
sql_status    the four facts, and the next move
sql_server    status | start | stop | restart | remove | logs
sql_driver    status | plan | install        (ODBC, machine-wide)
sql_query     one statement, parsed
sql_script    a .sql file, streamed and streamed-in
sql_database  list | create | tables | columns | count
sql_restore   a .bak, with its files MOVEed here
```

## Why it exists

This pack could already drive Docker (`dsh-docker`) and a page could already speak
to a database from JavaScript (`dsh-research`'s ledgers). Neither could answer the
question a person asks when they clone a repository that expects SQL Server:

> what do I run on **this** machine, and why does `pyodbc` still fail after the
> container is up?

The answer spans four things that fail independently, and every wasted afternoon
comes from collapsing them:

| fact | owner | when it is missing |
|---|---|---|
| a **server** | `sql_server` (a container) or a native service | nothing to connect to |
| a **client** | `sqlcmd` on PATH, or the one in the image | no statement can be sent |
| a **listening port** | the server, once it is really ready | "running" but not accepting logins |
| an **ODBC driver** | the HOST, machine-wide | the server works and the app cannot connect |

## The four decisions worth knowing

1. **A development server is a container.** `mcr.microsoft.com/mssql/server:2022-latest`
   is 1.7 GB, starts in ~40 s, keeps its databases in the named volume
   `dsh-sql-data` (so `remove` is not data loss), and is removed with one call. A
   native instance (`MSSQLSERVER`, `MSSQL$SQLEXPRESS`) is DETECTED and reported and
   deliberately **not** managed: this row will not stop a service somebody's other
   work depends on.
2. **Ready means it answered, not that it started.** SQL Server opens 1433 before it
   accepts a login. `start` polls a real `SELECT 1` through the image's own client
   and reports the attempts.
3. **A dump goes through `-i`, never stdin.** Measured on a real SSMS dump: piped
   through stdin it loaded **0 of 23** rows and exited 0; with `-i` it loaded **23 of
   23**. sqlcmd's stdin reader mangles the very long lines a dump is made of, and a
   silent partial load is the worst failure a database tool can have.
4. **The ODBC driver is the half a container cannot give you.** It is installed by an
   MSI that needs an administrator, so `sql_driver action=install` requires
   `confirm: "install"` and then runs the platform's own command (winget / brew /
   apt) and reports its exit code instead of assuming success.

## The legacy driver trap

Windows ships a driver registered as `SQL Server`. `pyodbc.drivers()` lists it, code
finds it, and the connection can fail with *"the client and server cannot communicate,
because they do not possess a common algorithm"* — it predates TLS 1.2. Measured
both ways: against a stock `mssql 2022` container that accepts an unencrypted
connection it **does** connect; against a server with forced encryption it does not.
So it sorts last and is called out, but it is not refused: a connection that works is
the answer to the question.

## What it will not do

- install, start, stop or remove a **native** SQL Server;
- take a **backup** (`sql_restore` restores; a backup is a file the server writes);
- author schema beyond `CREATE DATABASE`;
- remove a **volume** (the container, yes, and only with `confirm` equal to its name);
- hide a failure: every answer names the transport used, the elapsed time, and the
  server's own `Msg <n>, Level <l>` line.

## Environment

| variable | default | meaning |
|---|---|---|
| `DSH_SQL_HOST` | `127.0.0.1` | server host |
| `DSH_SQL_PORT` | `1433` | port |
| `DSH_SQL_USER` | `sa` | login |
| `DSH_SQL_SA_PASSWORD` | — | password (never echoed; `SQLCMDPASSWORD` to the host client) |
| `DSH_SQL_CONTAINER` | `dsh-sql-server` | container whose `sqlcmd` is borrowed |
| `DSH_SQL_CONTAINER_CLI` | `docker`, else `podman` | the container CLI |
| `DSH_SQL_IMAGE` | `mcr.microsoft.com/mssql/server:2022-latest` | the image a start pulls |
| `DSH_SQL_VOLUME` | `dsh-sql-data` | named volume for `/var/opt/mssql` |

## Skills

- **`sql-server-ops`** — the four facts, the lifecycle, the driver on each OS, the
  connection string an application needs, and how to read a state that looks wrong.
- **`sql-script-ingest`** — loading a dump: encoding from the BOM, `-i` vs stdin
  (with the measurement), dropping the dump's own `CREATE DATABASE` header, when one
  bad batch must not stop the load, verifying with row counts, and the tables a
  "complete" dump turns out not to contain.

## Checks

```
npm run check     # node checks/check-sqlserver-node.mjs - 69 assertions, no server
```

The package check drives every branch through scripted runners: the registration,
the refusal that happens before an install, the password policy before `docker run`,
a whole `start` end to end, the sanitiser, the grid parser, the three-part table name,
the `MOVE` clauses, and the BOM detection against real files.
