# dsh-docker (alpha.1)

**Docker — or Podman, which speaks the same dialect — as a surface the agent and a person can both use.** Nine `docker_*` tools over the machine's own CLI, and a **Docker** tab in the right bar listing this machine's containers and images with start/stop/restart/remove, pull and run, one container's facts and its logs. A **Docker Desktop that is closed** — the normal state on Windows 11 after a reboot — is an answer, not an error: `docker_start` launches the app and waits for its daemon.

The CLI is the API: no socket to `dockerd`, no HTTP client, no re-implementation of contexts. `DOCKER_HOST`, `docker context use` and a rootless socket therefore keep working the way the person configured them, and Podman is a dialect rather than a port.

## What it adds

- **The engine's state first.** `docker_state` reports whether there is a CLI, whether its daemon answers, the version and context, every container and image, and — on request — `docker system df`. It is the only tool that treats a sleeping engine as an answer, and it names the action that fixes it.
- **`docker_start`.** On Windows it launches `Docker Desktop.exe` (found under `%ProgramFiles%`, `%ProgramFiles(x86)%` or `%LOCALAPPDATA%`), on macOS `open -a Docker`, on Linux the installed Docker Desktop; for Podman it runs `podman machine start`. It then polls the **daemon**, not the app, for up to 90 s. Where it cannot start the engine (a Linux engine that needs sudo, no Desktop installed, no podman machine) the answer is the command a person runs — this plugin never asks for sudo.
- **The lists and one thing's facts.** `docker_ps`, `docker_images`, `docker_inspect` (bounded facts, not the 400 KB document) and `docker_logs` (`tail`, `since`, streams kept apart).
- **The writes, with a confirm.** `docker_pull`, `docker_run` (validated schema), `docker_action` (`start`, `stop`, `restart`, `pause`, `unpause`, `remove`, `prune`). A removal needs `confirm` set to the same id or name; a prune needs the word `prune`.
- **One skill.** `docker-cli` teaches the call order, the removal protocol and what the tools deliberately cannot do — registered from the package and copied into `$DSH_HOME/skills` by both installers.

## The tab

A page type, registered whether or not an engine exists (a missing tab cannot explain itself; a tab that says "no CLI on PATH" can). The header carries the engine's state, version, context and counts, with **Refresh**, **Disk** and — when the daemon is down and this machine can start it — **Start Docker Desktop**. Below it: the containers and the images, each row with its actions, a removal confirmed in the row, and a click that opens the facts and the last 200 log lines. The poll runs every 5 s only while the tab is mounted and the document visible, and every answer is applied under a token so a slow `ps` cannot overwrite a fresh start.

## What it will not do

| absent | why |
|---|---|
| `exec` | a container shell is a shell; the harness already has one under the session's approval policy |
| `system prune` | too broad for one confirmation: `prune` here means stopped containers or dangling images, one kind at a time |
| a free-form `run` | `docker_run` builds its argv from a schema, so `--privileged`, `--pid host`, `--device` and relative host paths have no spelling |
| volume/network removal, compose | data and files belong to the person and the repository; the tools that would remove a volume are not here |
| starting a system service | `sudo systemctl start docker` needs privileges this plugin will not request; the answer prints it instead |

## How it plugs in

| Piece | Value |
|---|---|
| `id` / row | `dsh-docker` / `docker` |
| seats | `sidebar.right.pane.tab` / `.title` (page type, no `patterns`), one guide entry at `order: 40` |
| tools | `docker_state`, `docker_ps`, `docker_images`, `docker_inspect`, `docker_logs`, `docker_pull`, `docker_run`, `docker_action`, `docker_start` |
| routes | `GET /api/dsh-docker/state` (`?disk=1`), `GET /logs`, `GET /inspect`, `POST /action`, `POST /pull`, `POST /run`, `POST /start`, `GET /health` |
| services | `connection`, `tools` (lazily `skills`); no vendored engine, no npm dependency, no socket |

## The safety model

1. **argv arrays only** — no shell string, so a quote or a `;` is a character in an argument.
2. **A fixed verb allowlist** — the verbs are literals; nothing a caller sends becomes a flag.
3. **Every value validated** (`lib/validate.js`): an id or name, an image reference, a port, a volume, an env name, a tail, a duration. A value beginning with `-` is refused so it cannot become an option.
4. **Removals confirmed** by repeating the target; `force` is separate and explicit.
5. **Deadlines and caps** — 15 s read, 60 s action, 15 min pull, tree kill on timeout, 1 MiB per stream, and the answer says when it was cut.
6. **A composed environment** — `PATH` and the Docker/Podman context variables only, `DOCKER_CLI_HINTS=false`, `NO_COLOR=1`; none of the harness's own markers.
7. **The harness's own routes** — exact paths behind the session cookie; the tab is the only writer.

`DSH_DOCKER_CLI` pins a binary the row should use (`podman`, or an absolute path); its basename decides the dialect.

## Verify

```
node --check packages/dsh-docker/lib/client.js
npm run check --prefix packages/dsh-docker
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

`packages/dsh-docker/checks/check-docker-node.mjs` drives the row with a **real process** for the runner (exit codes, stderr, the byte cap, the deadline) and a **scripted runner** for the engine (no CLI, a daemon asleep, an engine up, a podman machine, a flat version payload, the start poll), then every tool and all eight routes — including the removal that must be refused without `confirm`. When this machine's daemon is up it also does a live read; when Docker Desktop is closed it **skips loudly** with the engine's own reason. `check-client-bundles.mjs` renders the tab in every state it has.

## Install

Both installers pick it up from `packages/`; a new bundle is learned once, then a restart of `npx @deepseek-ai/dsh web` and a refresh.
