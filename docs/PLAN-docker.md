# The plan: `dsh-docker`, and a Docker tab in the right bar

**Status: built** — `packages/dsh-docker` is at alpha.1, and `packages/dsh-docker/README.md`
is the shipped behaviour. This page is the cut it was built from, and the record of what
was deliberately deferred (phase 3: compose, a strict `run`, `exec`).

**Premise.** The harness can already run `docker`: the CLI is a program on `PATH`, and
the agent's own shell tool reaches it. What it cannot do is *speak* Docker — ask a
question with a shape and get an answer with a shape — or show a person what is on the
machine without a terminal. This page is the plan for a bundle that does both.

## The four questions, answered first

| question | answer |
|---|---|
| Can vncode execute docker commands today? | **Yes, already.** `docker.exe` 25.0.3 is on `PATH` (`C:\Program Files\Docker\Docker\resources\bin\docker.exe`), and a `pwsh` call reaches it. The app itself never spawns it; the *agent* does, through the harness's shell tool, which is governed by the session's approval policy. |
| Is docker control already present? | **No.** The pinned line ships `dsh-shell`, `dsh-bash-local`, `dsh-terminal` and job control, and nothing docker-shaped — a name scan of the 288 installed `@deepseek-ai` packages finds no container plugin. |
| Is this a plugin extension? | **Yes**, a new bundle: host half (tools + routes) and client half (one tab type). No core row is patched, disabled or replaced. |
| Does it make sense? | **Yes, for two reasons and no third.** A tab is a surface no shell gives a person, and typed tools are safer than a shell string for a root-equivalent API. The third reason — "so the agent can run docker" — is already true and is not a reason to build anything. |

**The measurement that decided the design.** On this machine the CLI is installed and
the **daemon is not running** (`docker version` answers `Server: null`; `docker ps`
answers `error during connect: … open //./pipe/docker_engine: The system cannot find the
file specified`). That is not an edge case to handle later — it is the first state a
person sees, and a panel that says "0 containers" about a daemon that is not there is a
lie. The engine state is therefore the tab's first fact, and the same sentence is the
first answer every tool gives.

## The shape

```
dsh-docker (bundle, row `docker`)
├─ lib/cli.js      one spawn: argv array, no shell, deadline, tree kill, capped streams
├─ lib/tools.js    docker_state · docker_ps · docker_images · docker_inspect
│                  docker_logs · docker_action
├─ lib/routes.js   GET  /api/dsh-docker/state   (?disk=1 adds `system df`)
│                  GET  /api/dsh-docker/logs    ?id=…&tail=…
│                  POST /api/dsh-docker/action  { action, id, confirm }
│                  GET  /api/dsh-docker/health
└─ lib/client.js   the `docker` tab type + body/title seats + a guide entry (order 40)
```

No vendored engine, no npm dependency, no socket and no HTTP client to dockerd: **the
CLI is the API.** That is what makes contexts (`DOCKER_HOST`, `docker context use`, a
remote engine) work without this plugin re-implementing any of them.

**The tab** is deliberately small, in the pack's tab dress (38 px header, one accent):

- **Header** — the engine's state as one line (`running · 25.0.3 · context default`),
  four counts (containers up / all, images, volumes, networks), **Refresh**, and
  **Disk** which asks for `docker system df` on demand (it is slow; it must not ride
  the poll).
- **Containers** — one row per container: state dot, name, image, `ports`, uptime or
  exit code, and the row's actions. Clicking a row opens a drawer with the inspect
  facts (id, image digest, command, ports, mounts, network, restart policy) and a logs
  pane (`tail=200`, capped, copyable).
- **Images** — repo:tag, short id, size, created, and the containers using it.
- Honest failure, always a sentence: CLI not on `PATH`; daemon down **with this
  platform's way out** (start Docker Desktop on Windows/macOS, `systemctl start docker`
  on Linux, and the `docker` group when it is a permission refusal); a context pointing
  at an endpoint that does not answer.

The tab is registered whether or not a CLI exists. A missing tab cannot explain itself;
a tab that says "the `docker` CLI is not on `PATH`" can.

## The safety model (the part that decides whether this is responsible)

Docker access is root-equivalent: anything that can talk to the daemon can mount the
host. So the rule is that **this plugin is not a shell with a `docker` prefix**:

1. **argv arrays only.** No command string, so a quote, a `;` or a `$(…)` is a character
   in an argument and never something that runs.
2. **A fixed verb allowlist** — `version`, `context show`, `ps`, `images`, `inspect`,
   `logs`, `system df`, and the lifecycle verbs `start`/`stop`/`restart`/`pause`/
   `unpause`/`remove`. Nothing else is reachable, whatever a caller sends.
3. **Every argument validated.** A container or image id must match
   `/^[0-9a-f]{12,64}$/`; a name must match `/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/`; `tail`
   is an integer 0–2000; a log `since` is a duration or an RFC 3339 stamp. An id that
   starts with `-` is refused, so no argument can become an option.
4. **Destructive verbs need the target echoed back.** `docker_action` takes
   `confirm: "<the id>"` for `remove`, and `force: true` only with the same confirm. A
   model cannot remove a container by guessing; a person's click supplies the id.
   Lifecycle verbs (start/stop/restart) take `confirm` too — cheap, and it makes every
   write a deliberate call rather than a reflex.
5. **No `run`, no `exec`, no `prune` in v1.** `exec` is a remote shell, and the harness
   already has a shell that the approval policy governs; a second one behind a tool
   would be a way *around* that policy. `run` and `prune` are phase 3 and only with a
   stated approval story.
6. **Deadlines and caps** — 10 s for a read, 60 s for an action, 120 s for a pull; the
   child tree is killed on timeout (the `dsh-wsl` discipline), each stream is capped at
   1 MB, and the answer says when it was cut.
7. **A minimal environment** — `DOCKER_CLI_HINTS=false`, `NO_COLOR=1`, and none of the
   app's own `DSH_*` / `VNCODE_*` markers. Output is read as `--format '{{json .}}'`,
   one JSON object per line, so no human table is ever parsed.
8. **The routes are the harness's own** — `connection.fetch.register` under
   `/api/dsh-docker/*`, exact paths, `GET`/`HEAD`/`POST`, behind the session cookie.
   They are the tab's only door, and the tab is the only writer.

## The tools

| tool | answers |
|---|---|
| `docker_state` | Is the engine there and reachable? Version, API, context, counts, and (with `disk`) the space it is using. |
| `docker_ps` | Containers, optionally `all`, filtered by name or image; one line each with state, ports and uptime. |
| `docker_images` | Images with repository, tag, digest, size and creation time. |
| `docker_inspect` | One container or image, as a bounded set of facts rather than a 400 KB JSON document. |
| `docker_logs` | The last *n* lines of one container, with `since`, capped and marked when cut. |
| `docker_action` | `start`, `stop`, `restart`, `pause`, `unpause`, `remove` — each with `confirm`, and a sentence saying what happened. |

Every tool returns the pack's usual `{ text, view }` shape, so the answer is prose for
the model and a small card for the transcript.

## Phases, and the check that proves each

| phase | what ships | proven by |
|---|---|---|
| **1. Read-only** | `cli.js`, `docker_state`/`ps`/`images`/`inspect`/`logs`, `/state` + `/logs` + `/health`, the tab with both lists, the drawer and the engine-down sentences | `packages/dsh-docker/checks/check-docker-node.mjs` with a **fake `docker` on `PATH`**: ENOENT (no CLI), the daemon-down stderr, `ps`/`images`/`inspect` JSON parsed from fixtures the check writes, an id of `--all` or `-v` refused, a timeout that kills the tree, a 1 MB stream cut. Plus a `check-node-routes.mjs` block for the routes. |
| **2. Actions** | `/action`, `docker_action`, the tab's buttons with the two-step confirm, refresh after a write | the same check: `remove` without `confirm` refused, with the wrong confirm refused, with the right one run against the fake CLI; the route answers the typed failure shape. |
| **3. Decided later** | `docker compose ls` as a row group; a strict `docker run`; `exec` | not built until the approval question is answered — see below. |
| **4. Pack paperwork** | `.dsh-version.json` entry, `ARCHITECTURE.md` row, README, install (already automatic: `scripts/setup/install-all.*` discovers `packages/`) | `check-node-routes.mjs` (manifest ⇄ `package.json`), `check-client-bundles.mjs` (the client bundle loads, registers one type, renders its lists, and carries no remote asset). |

## What this plan does NOT do, and why

- **No `exec`, no `run`, no `prune`.** Each is either a shell or an unbounded write. The
  shell tool already covers "run this command", under the policy the person chose; this
  plugin must not become the way around it.
- **No Docker Desktop launcher.** Starting a multi-hundred-megabyte GUI app from a
  plugin is a side effect nobody asked for; the tab says what to start and lets the
  person start it. (`docker desktop start` does not exist in this Desktop build —
  `docker desktop version` answers "not a docker command" — so a button would also be
  wrong on this machine.)
- **No metrics or graphs.** CPU/memory history is a daemon-side feature (cAdvisor,
  Prometheus); a tab that polls `docker stats` would cost a process per second to draw
  a wobbly line.
- **No compose editor.** Compose files are files: the Files tab and the editor already
  own them.
- **No WSL bridge.** `dsh-wsl` owns that half, and a Docker Desktop engine is reached
  through the CLI's own context, not through a distribution.

## The questions this plan leaves to a person

1. **Read-only first, or actions in the first cut?** The plan ships actions in phase 2
   with `confirm`; if the answer is "look, don't touch", phase 2 waits.
2. **Should `docker run` ever be a tool?** Default: no. If yes, it needs a strict schema
   (image, argv, ports, mounts), and the mount list is the dangerous part.
3. **Is a dead daemon a red state or a quiet sentence?** The plan says quiet sentence
   with the way out; a red banner every time Docker Desktop is closed would be noise.
4. **Should the Docker tab be in the guide (the "+" Start page) even with no engine?**
   Default: yes — a Start page entry is how a person finds a tab they have not opened.

## What it costs

One package, roughly 600 lines of host code (`cli.js` + `tools.js` + `routes.js`), 900
lines of client bundle, one check file, one README, one manifest entry. No new
dependency, no download, no engine, no socket. The size budget is a file count, not a
megabyte count — which is the reason this is worth doing as a plugin rather than as a
mode bolted onto dsh-media or dsh-wsl.
