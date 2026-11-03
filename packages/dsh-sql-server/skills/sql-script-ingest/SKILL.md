---
name: sql-script-ingest
description: Load a .sql dump into SQL Server with sql_script and prove it landed - read the encoding from the BOM (SSMS writes UTF-16), prefer -i over stdin because stdin silently drops long lines, drop the dump's own CREATE/ALTER DATABASE header that names ANOTHER machine's file paths, decide whether one bad batch should abort the load, and verify with row counts instead of trusting an exit code. Covers GO batches, IDENTITY_INSERT, a 1.2 GB file, and the tables a "complete" dump turns out not to contain.
whenToUse: Use when a dump has to become a working database - "load this .sql into SQL Server", "import ProductHub", "the script ran but the tables are empty", "it says Invalid object name after loading", "the file is 1 GB, will sqlcmd take it", "why did my import exit 0 with no data", or when a repository ships .sql files instead of a .bak.
---

# From a .sql file to a database you can query

`sql_script` runs `sqlcmd -i` and reports what happened. The five things that go
wrong are all *silent*, which is why they are listed here first.

## 1. Don't pipe a dump into sqlcmd

The tidy-looking version - stream the file into `sqlcmd`'s stdin - is wrong.
sqlcmd's stdin reader mangles very long lines, and an SSMS dump is nothing but very
long lines: one `INSERT` per row, each several kilobytes of JSON.

Measured on a real 310 KB dump (`script-studio-complete-data.sql`, 23 mockup rows):

| mechanism | rows loaded | exit code |
|---|---|---|
| stdin (`docker exec -i ... sqlcmd` with the file on stdin) | **0 of 23** | 0 |
| `-i file` | **23 of 23** | 0 |

A silent partial load that exits 0 is the worst outcome available, so `sql_script`
uses `-i` and nothing else. For a container that means the file is copied in first
(`docker cp`) and removed afterwards; the tool says which path it used.

## 2. The encoding is UTF-16 more often than you think

Management Studio's "Script Database" writes **UTF-16LE with a BOM** (`FF FE`).
Feed that to a UTF-8 client and every line becomes one syntax error, because every
character is followed by a NUL byte.

`sql_script` reads the first two bytes and passes sqlcmd the matching code page:

| BOM | encoding | sqlcmd |
|---|---|---|
| `FF FE` | UTF-16LE | `-f 1200` |
| `FE FF` | UTF-16BE | `-f 1201` |
| none | UTF-8 | `-f 65001` |

A `sanitise` run writes a UTF-8 copy instead, so the code page becomes 65001.

## 3. A dump's header belongs to the machine that wrote it

SSMS emits, before any table:

```sql
USE [master]
GO
CREATE DATABASE [STUDIO]
 ON  PRIMARY
( NAME = N'STUDIO', FILENAME = N'C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\DATA\STUDIO.mdf' , ... )
GO
ALTER DATABASE [STUDIO] SET COMPATIBILITY_LEVEL = 160
GO
```

Those file paths are the author's. On this machine - and definitely inside a Linux
container - that `CREATE DATABASE` fails, and with `-b` the whole load stops on
line 5.

`sanitise: true` drops `USE [master]`, the whole `CREATE DATABASE` block (until its
`GO`) and the `ALTER DATABASE` lines, while streaming. Create the databases first,
then load with `sanitise: true`. The answer reports how many blocks it dropped, so
"0 dropped" tells you the dump never had one.

```
sql_database action=create database=ProductHub
sql_database action=create database=STUDIO
sql_script   file=C:\...\script-studio-complete-data.sql sanitise=true
```

## 4. One failed batch should not take the load down

With `-b` (the default) the first T-SQL error ends the script. That is right for a
migration and wrong for a **vendor dump**, which is a snapshot of somebody else's
schema: a view may reference a table the dump did not include.

Real example: the STUDIO dump's views read `[ProductHub].[dbo].[ENCOMENDAS]` and
`ORCAMENTOS`, which are PHC tables that dump does not contain. With `-b` the load
stops at the first view and creates no tables at all; with
`abortOnError: false` the views fail, the tables and their rows load, and the
answer names the first error so the missing schema is visible instead of silent.

`abortOnError: false` is opt-in on purpose, and the answer says when it was used.

## 5. Exit code 0 is not "the data is there"

Always pass `verify`, which counts rows AFTER the load:

```
sql_script file=... sanitise=true verify=["STUDIO.dbo.studio_mockups","STUDIO.dbo.studio_projects"]
```

A name is `table`, `schema.table` or `database.schema.table`. Then read the shape:

```
sql_database action=tables database=STUDIO
```

`tables` shows every user table with its row count and size, which is the one call
that answers "did it land, and what is in it".

## A dump is not a database

The single most useful thing to check before promising an application will work:
**which tables does the code query, and which does the dump create?**

Worked example from this pack's own probe. A repository shipped two dumps:

| dump | tables it creates |
|---|---|
| `script-studio-complete-data.sql` | `studio_mockups`, `studio_projects`, `studio_states`, media tables, and two PHC views |
| `script-print-data.sql` (1.2 GB) | `print_prices_data`, `print_product_data` — nothing else |

The application also queries `products`, `prices_phc_data`, `stocks_data`, `tags`
and `mba_categories`. None of those exist in either dump, so the catalog is empty
and the product loader 404s even though both loads "succeeded". Compare the two
lists BEFORE loading:

```sql
-- what the dump creates (grep the file, or after loading:)
SELECT s.name, t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id

-- what the code asks for (grep the repository)
--   FROM products / JOIN stocks_data / ...
```

When they disagree, the missing pieces are a `.bak`, a second export, or a DDL
script - not something to invent.

## Loading something big

A 1.2 GB dump is fine; it is a copy and an insert stream, not a parse:

- `timeoutMinutes` defaults to 60 and may go to 360; raise it before starting, not
  after it is killed.
- the sanitised copy is written to a temp directory and removed afterwards, so the
  disk needs room for one extra copy when `sanitise: true`;
- inside a container the file is copied in (`docker cp`) and removed after, so the
  engine's disk needs room too;
- `GO` is honoured because sqlcmd honours it: it is a client-side batch separator,
  not a T-SQL statement.

Check progress without disturbing it: `sql_database action=tables` reports the
committed rows so far, because each batch commits as it completes.
