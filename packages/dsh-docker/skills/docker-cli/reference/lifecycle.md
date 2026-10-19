# The engine, the dialects, and the safe removal

The `docker_*` tools are thin on purpose: the CLI is the API, so everything the
CLI's own configuration does (contexts, a remote `DOCKER_HOST`, a rootless
socket, a Podman machine) works here without this plugin knowing about it. This
page is the part a tool description cannot hold.

## Starting the engine, per platform

| where | `docker_start` does | when it cannot |
|---|---|---|
| Windows 11, Docker Desktop | launches `…\Docker\Docker\Docker Desktop.exe` (found under `%ProgramFiles%`, `%ProgramFiles(x86)%` or `%LOCALAPPDATA%`) and polls `docker version` | Desktop is not installed where the plugin looks: the answer says to install it or start the engine by hand |
| macOS, Docker Desktop | `open -a Docker`, then polls | `/Applications/Docker.app` is missing |
| Linux, Docker Desktop | launches `/opt/docker-desktop/bin/docker-desktop`, then polls | plain engine: the answer prints `sudo systemctl start docker` (or `systemctl --user start docker`) and stops - no sudo is ever requested |
| Podman, with a machine | `podman machine start`, waited on, then polls | no machine defined: the answer prints `podman machine init` then `start` |
| none | `NO_CLI` with the install sentence | `DSH_DOCKER_CLI` points the row at a binary PATH does not cover |

The GUI app is **launched, not waited on**. Docker Desktop is a long-running
tray application with its own updater; waiting for that process would wait for
the app to quit. The wait is for the daemon: `docker version --format '{{json .}}'`
succeeding and carrying a server object.

## What "down" looks like

Docker exits **1** and still prints its client JSON with `"Server": null` when
the daemon is asleep; the stderr line names the endpoint it could not reach
(`open //./pipe/docker_engine: The system cannot find the file specified` on
Windows). Podman exits **125** with `Cannot connect to Podman`. Both become
`ENGINE_DOWN`, and the reason kept is the engine's own first line - not a
rewritten one, because the endpoint is the useful part when the person has a
remote context configured.

A `version` answer is the daemon check because it is the cheapest call that
crosses the socket. `info` would work too and costs more.

## Podman is a dialect, not a port

Every verb this row builds is shared: `ps -a --format '{{json .}}'`, `images`,
`inspect`, `logs --tail`, `pull`, `run -d`, `start/stop/restart/pause/unpause/rm`,
`container prune -f`, `image prune -f`. Two differences that matter:

- **Starting it.** Docker uses a GUI app; Podman uses `podman machine start` on
  Windows/macOS, and on Linux a rootless user service (`systemctl --user start
  podman.socket`) that this plugin will not run for you.
- **The flat version payload.** On Linux, `podman version --format '{{json .}}'`
  can answer a flat object with no `Server` key. That is read as a live engine,
  not as "down" - the daemon is in the same process, so there is no server object
  to look for.

## Where a command's output goes

`docker logs` keeps the container's two streams apart: its stdout on stdout, its
stderr on stderr. The tools print stdout first and append stderr under a
`[stderr]` marker rather than interleaving them, because interleaving would
invent an order the engine never recorded. `--timestamps` is not added: the
container's own lines usually carry one, and a second one helps nobody.

Both streams are capped at 1 MiB per call and the answer says when it was cut.
`tail` is a line count from the end (default 200, at most 2000); `since` is a
duration (`10m`, `2h`) or an RFC 3339 timestamp.

## Image references

`repo`, `repo:tag`, `registry:5000/repo:tag`, and the `repo@sha256:<64 hex>`
digest form all pass. What does not: a leading `-` (it would become an option),
whitespace, and any shell character. A reference with no tag is `latest` - the
tools do not add it, so an answer that says `nginx` is an answer that means
`nginx:latest`, and it is worth writing out loud.

An image id is `sha256:` plus 64 hex characters; the lists print the short form
and every tool accepts either. A container is a 12-64 hex id or a name
(letters, digits, `_`, `.`, `-`, up to 128).

## Ports, volumes and the run schema

`docker_run` publishes what it is given and nothing else:

- **ports** - `8080:80` binds every interface; `127.0.0.1:8080:80` binds
  loopback only. A database on `5432:5432` is reachable from the network; if that
  is not what the person meant, `127.0.0.1:5432:5432` is the spelling.
- **volumes** - a named volume (`data:/var/lib/postgresql/data`) or an absolute
  host path (`C:\work:/work:ro`, `/srv/site:/usr/share/nginx/html:ro`). A
  relative path is refused: it would mean a different host folder depending on
  where the daemon runs.
- **env** - an object of NAME: value pairs; names are validated, values are
  capped at 4 KB.
- **command** - an array of tokens that come after the image, so they are the
  program's own flags, never docker's.

There is no `--privileged`, `--pid host`, `--device`, `--user` or
`--cap-add` in the schema. That is a decision, not an omission: a tool that can
grant a container the host is a tool that must be designed around approval, and
this row is not.

## A safe removal, in order

1. **Whose is it?** A container you did not start belongs to a person's setup.
   Ask before removing it; a stopped container costs nothing to keep.
2. **What holds its data?** `docker_inspect` lists mounts. A bind mount's data is
   on the host and survives `rm`; a named volume also survives unless it is
   removed separately (this row does not remove volumes). Only the container's
   writable layer is lost.
3. **Is it running?** `remove` on a running container fails without `force`.
   Prefer `stop`, then `remove` - that is a clean shutdown instead of a kill.
4. **Repeat the id.** `docker_action({ action: "remove", id: "<id>", confirm: "<id>" })`.
   The route refuses a missing or different `confirm`; that is the check that
   makes a removal deliberate.
5. **Prune, if the goal was disk.** `prune` with `kind: "container"` removes
   stopped containers; `kind: "image"` removes dangling (untagged, unused)
   images. Nothing else. `docker_state({ disk: true })` is the measurement that
   says whether pruning is even worth it.
