# dsh-wsl (alpha.1)

**The POSIX half of this pack, testable on Windows.** Three tools over the
machine's own Windows Subsystem for Linux: `wsl_status` (what distributions exist,
which is the default, whether one can run a check), `wsl_run` (one argv array in a
distribution, with its exit code) and `wsl_path` (`C:\…` ⇄ `/mnt/c/…`).

Why it earns a row: `scripts/run-web.sh`, `scripts/setup/install.sh` and the `sh`
branches of the checks are shipped and never run on the machine that writes them.
WSL is already on that machine, so the fix is a bridge rather than a second
machine — name the distribution, run the command, read the exit code.

## What it adds

- **`wsl_status`** — the launcher's own table, decoded and parsed: name, state,
  version, and which distribution the launcher defaults to. `probe: true` also
  runs `node --version`, `git --version` and `echo ok` **in that distribution**, so
  "can this machine run the Linux half of my checks" is an answer rather than a
  guess. Listing does not boot a distribution; a probe does.
- **`wsl_run`** — `{ argv, distro?, cwd?, timeoutMs? }`, run through
  `wsl.exe -d <distro> --cd <dir> -- <argv…>`. `argv` is an **array**, one element
  per argument: there is no shell, so a quote, a `;` or a `$(…)` in an argument is
  a character in an argument. A single-string command is **refused by name**, with
  the array form spelled out. The answer carries the exit code, stdout, stderr, the
  duration and whether the deadline was hit; output is capped at 1 MB per stream and
  says when it was cut.
- **`wsl_path`** — the conversion every hand-written script gets wrong, in both
  directions: a drive letter becomes `/mnt/<drive>/…`, `\\wsl$\<distro>\…` and
  `\\wsl.localhost\<distro>\…` become the distribution's own paths, and a POSIX
  path comes back as a drive path or a `\\wsl$` one (which needs the distribution's
  name). No disk access at all.

## The two traps this package exists to absorb

1. **The default distribution is not the one you mean.** On a machine with Docker
   Desktop, `wsl.exe`'s default is `docker-desktop-data`, which cannot run a
   program. `wsl_run` therefore names its distribution when you give one, and its
   answer names the one it used; `wsl_status` prints the default with an asterisk
   so the mismatch is visible before it becomes a confusing failure.
2. **`wsl -- -l -v` is not "list distributions".** After `--` the next word is a
   **program**, so the launcher tries to start a program named `-l` and answers
   `CreateProcessParseCommon: Failed to translate <cwd>` — a message that reads
   like a broken install. The launcher's own flags never take `--`, and that split
   (`runLauncher` vs `runInWsl`) is pinned by the package's check.

## How it plugs in

| Piece | Value |
|---|---|
| row / tools | `wsl` / `wsl_status`, `wsl_run`, `wsl_path` |
| host | one row, no route, no browser half (`package.json` declares no `dsh.client`) |
| spawn | `wsl.exe` with an **argv array**, a deadline (120 s default, 600 s max) and a **tree kill** on timeout (`taskkill /T /F`), so a killed build does not keep a core |
| environment | composed, not inherited: Windows' own program variables plus `WSL*`, and nothing of the harness's (`DSH_HOME`, credentials, keys) |
| output | UTF-16LE decoded (the launcher writes UTF-16 to a pipe; assuming UTF-8 turns the table into `N\0A\0M\0E\0`) |

OS-neutral by construction: the code loads everywhere, imports no Windows API, and
on macOS/Linux the tools answer *"WSL is a Windows feature and this host is <os>"*
and point at the harness's own `bash` — the shell that is already there.

## Limits

| | |
|---|---|
| platform | Windows only in effect; inert elsewhere by design, and the row logs which side it is on |
| launcher | needs a `wsl.exe` that understands `--cd` (WSL 0.58+, 2022 or later) for `cwd`; the answer says so if the launcher is older |
| what it will not do | start a distribution (no `wsl --install` — that wants an elevated terminal), bridge a port, or write inside a distribution; the distribution already sees `C:` as `/mnt/c`, which is the only file bridge this needs |
| a timeout | kills the Windows-side tree; a process the distribution detached itself (a daemon that forked away) is the distribution's business, not this tool's |
| output | 1 MB per stream, 24 000 characters of it echoed into the answer |

## Verify

```sh
node checks/check-wsl-node.mjs                      # pure: 56 checks, plus a live listing on Windows
DSH_WSL_CHECK_LIVE=1 node checks/check-wsl-node.mjs # also boots a distribution and runs one command
```

The pure half is the contract: the UTF-16 decoder, the parser against a **localized**
header (the real one is Spanish on some machines, so the header is never matched by
name), both path directions, the argv refusal, the launcher-argv order, the composed
environment, and the tools' shapes. The live half runs on Windows only and says so
loudly when it cannot: it lists distributions (which boots nothing) and, only with
`DSH_WSL_CHECK_LIVE=1`, runs `sh -c 'echo wsl-ok'` in the first non-Docker
distribution.

## Install

Both installers pick it up from `packages/`; as a new bundle the profile learns it
once, then a restart of `npx @deepseek-ai/dsh web` and a hard refresh.
