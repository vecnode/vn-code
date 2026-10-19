---
name: docker-cli
description: Control this machine's Docker or Podman engine through the docker_* tools - read the engine's state first, list containers and images, inspect one, tail its logs, pull an image and start it, then stop, restart or remove what you started. Covers the engine that is asleep behind Docker Desktop and the exact call for each verb, the confirm rule removals obey, and the flags the tools deliberately do not have.
whenToUse: Use whenever the task involves a container engine on this machine - "is Docker running", "what is running", "start Postgres in Docker", "pull nginx and put it on 8080", "why did that container exit", "restart it", "remove that container", "how much disk are images using", or a project whose README says `docker compose up` and you need to see what is already there first.
---

# Talking to this machine's container engine

Nine tools, one engine, one rule: **state first, then the smallest verb that
answers the question.** The tools speak the `docker` CLI, or `podman` when
`docker` is not on PATH; every verb below works the same on both.

| question | tool |
|---|---|
| is there an engine, and is it awake? what does it hold? | `docker_state` |
| what is running / what exists? | `docker_ps` |
| which images are on disk? | `docker_images` |
| what exactly is this container or image? | `docker_inspect` |
| what did it print? | `docker_logs` |
| fetch an image | `docker_pull` |
| start a container from an image | `docker_run` |
| start / stop / restart / pause / unpause / remove / prune | `docker_action` |
| turn Docker Desktop or a podman machine on | `docker_start` |

## The order to call them in

1. **`docker_state`.** It is the only tool that treats a sleeping engine as an
   ANSWER instead of a failure. On Windows 11 the engine is Docker Desktop, and
   Desktop being closed is the normal state after a reboot: `docker_state` says
   so, in the engine's own words, and tells you whether `docker_start` can fix it
   or whether the machine needs `sudo systemctl start docker` (which this plugin
   will not run for you).
2. **`docker_start`** when the state says the engine is down and startable. It
   launches Docker Desktop (or runs `podman machine start`) and then polls the
   daemon - not the app - for up to 90 s. A cold Desktop start can be slow: if it
   times out, call `docker_state` again in a minute rather than `docker_start`
   twice.
3. **`docker_ps` / `docker_images`** for the lists. Get the exact name or id from
   here; every other tool takes it verbatim.
4. **`docker_inspect`** when you need the facts (ports, mounts, exit code,
   restart policy) and **`docker_logs`** when you need the words. `tail` defaults
   to 200; `since: "10m"` narrows it.
5. **`docker_pull`** before `docker_run` when the image is not there yet - or let
   `docker_run` pull it, which docker does itself. Pulling first is what makes a
   slow download and a failed start two separate, readable events.
6. **`docker_run`** to start one, **`docker_action`** to change one.

## The calls, with the shape that works

```
docker_state({ disk: true })                      # the full picture, with disk use
docker_ps({ all: false, filter: "postgres" })     # what is running, narrowed
docker_images({ filter: "nginx" })
docker_inspect({ id: "web" })                     # kind is inferred; pass it to be explicit
docker_logs({ id: "web", tail: 200, since: "10m" })
docker_pull({ image: "postgres:16" })
docker_run({ image: "postgres:16", name: "db", ports: ["127.0.0.1:5432:5432"],
             env: { POSTGRES_PASSWORD: "dev" }, volumes: ["db-data:/var/lib/postgresql/data"] })
docker_action({ action: "restart", id: "web" })
docker_action({ action: "remove", id: "web", confirm: "web" })   # confirm REPEATS the id
docker_action({ action: "prune", kind: "image", confirm: "prune" })
```

## What the tools will not do, and why

- **No `exec`.** A container shell is a shell; the harness already has one, under
  the session's approval policy. If a person asks you to run something inside a
  container, say what the command is and run it through the shell tool - do not
  look for a `docker_exec`.
- **No `system prune`.** `prune` here means stopped containers or DANGLING
  images, one kind at a time. `docker system prune -a` also takes networks,
  build cache and every unused image, and one confirmation cannot honestly cover
  that.
- **No free-form `run`.** `docker_run` builds its argv from a schema; there is no
  spelling for `--privileged`, `--pid host`, `--device` or a relative host path.
  If a container genuinely needs one of those, say so to the person instead of
  working around the tool.
- **No `latest` by accident.** An image reference without a tag is `latest`; if
  the person did not name a tag, name one you know exists or write `latest` out
  loud so the choice is visible.
- **Nothing outside the engine.** No compose, no network create, no volume
  remove. Compose files belong to the repository and the shell.

## Removing things without regret

`remove` needs `confirm` set to the SAME id or name. That is not red tape: the
container's writable layer disappears, and an image may need a pull to come back.
So before a removal:

1. `docker_ps` and read the row - is it running? did you start it?
2. `docker_inspect` for its mounts; a bind mount holds data the container does
   not, and a named volume survives the container anyway.
3. Ask, when the container is not yours: "remove `web`?" is one sentence, and a
   person's "yes" is what `confirm` is standing in for.
4. `docker_action({ action: "remove", kind: "container", id: "<name>", confirm: "<name>" })`.

`force: true` is for a running container that must go now. It is the difference
between a clean stop and a pull of the plug; do not pass it by default.

## When the engine says no

| answer | what it means | what to do |
|---|---|---|
| `NO_CLI` | no `docker` and no `podman` on PATH | say so; offer the install; `DSH_DOCKER_CLI` pins a binary outside PATH |
| `ENGINE_DOWN` | the CLI is there, its daemon is not | `docker_start`, or the system command `docker_state` printed |
| `CONFIRM_REQUIRED` | a removal without `confirm` | pass `confirm` — and only after the person agreed |
| `BAD_ARG` | a value the grammar refused (an id starting with `-`, a bad port) | re-read the row's id; do not "fix" it by guessing |
| `FAILED` | the engine ran the command and refused | the message is the engine's own sentence; read it before retrying |
| `TIMEOUT` | the call outlived its deadline and was killed | check the daemon; a pull can legitimately need a longer wait |

More detail - platform start paths, Podman's differences, stream separation,
image references and a safe-removal checklist - is in
[reference/lifecycle.md](reference/lifecycle.md).
