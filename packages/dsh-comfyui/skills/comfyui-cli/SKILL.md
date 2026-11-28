---
name: comfyui-cli
description: comfy-cli - the cross-platform command line for ComfyUI that installs it, launches it, runs a workflow, resolves a workflow's custom nodes and downloads models, with the same commands on Windows, macOS and Linux. Covers workspace selection (--workspace/--here/--recent, which, set-default), comfy run --workflow and its UI-JSON auto-conversion, jobs/download, node deps-in-workflow, the --json envelopes, COMFY_LOCAL_URL, and exactly which commands this pack's tools will and will not run for you.
whenToUse: Installing or updating ComfyUI, launching a server to test against, running a workflow from a terminal, finding out which custom nodes a workflow needs, downloading a model, or scripting any of it - and whenever a machine has no server running but does have (or can have) comfy-cli.
---

# comfy-cli: the terminal face of ComfyUI

One Python package installs, launches, runs and extends ComfyUI, and it behaves
the same on Windows, macOS and Linux. That matters when the alternative is a
`.bat` per platform.

```bash
pip install comfy-cli
comfy setup -y
```

`pip install comfy-cli` needs **Python 3.10+**. `comfy setup` is the interactive
wizard (local vs cloud, sign-in, agent skills); `-y` makes it non-interactive,
which is what a script wants. `comfy --install-completion` adds tab completion.

```bash
comfy --version
```

## Which ComfyUI is it talking to

Every command acts on a **workspace**. With no flag, the order is: the path from
`comfy set-default <path>`, then the most recently launched or installed one,
then a ComfyUI in the current directory.

```bash
comfy which
comfy --recent which
comfy --workspace=/home/me/ComfyUI which
comfy set-default /home/me/ComfyUI
```

| Flag | Points at |
|---|---|
| `comfy --workspace=<path>` | the ComfyUI installed under `<path>` |
| `comfy --here` | a ComfyUI in the current directory |
| `comfy --recent` | the last one launched or installed |

Without any of them, `comfy install` installs into `<HOME>/comfy/ComfyUI`.
`comfy env` prints the resolved workspace, the python it uses and whether a
server is running — that is the one command to run when you are not sure *which*
ComfyUI you are about to change.

```bash
comfy env
comfy --json env
```

## Install, update, launch, stop

```bash
comfy install
comfy install --fast-deps
comfy --workspace=~/comfy install
comfy update
comfy update all
```

`comfy install` downloads the latest ComfyUI **and ComfyUI-Manager**; run inside
an existing checkout it records that checkout instead. `--fast-deps` resolves
requirements with `uv` instead of pip.

```bash
comfy launch
comfy launch --background
comfy launch -- --cpu --listen 127.0.0.1 --port 8188
comfy stop
comfy system-stats
comfy free --free-memory
```

- `comfy launch` runs ComfyUI in the foreground; `comfy launch --background`
  runs an instance `comfy env` lists and `comfy stop` stops. **No background
  instance can be stopped by anything but `comfy stop`** — close the laptop and
  it is still there next boot.
- Everything after `--` is passed to ComfyUI itself: `--cpu`, `--listen`,
  `--port`, `--lowvram`, `--reserve-vram`.
- `comfy system-stats` reports VRAM and RAM through the server; `comfy free`
  unloads models (and with `--free-memory` also resets the executor cache). Both
  are the command-line twin of `/system_stats` and `POST /free`.

## Run a workflow

```bash
comfy run --workflow ./workflow.json --wait
comfy --json run --workflow ./workflow.json --wait
```

- **`--workflow` accepts the app's SAVE format** (the canvas). comfy-cli converts
  it to the API prompt itself. That is why it is a real second opinion on a
  canvas this pack generated: two independent converters, one result.
- `comfy run` submits and prints a `prompt_id`; **without `--wait` it returns
  immediately**. With `--wait` it blocks until the render finishes.
- `--prompt "<text>"` runs a bundled default text-to-image graph instead of a
  file. That graph loads `v1-5-pruned-emaonly.ckpt`, which comfy-cli does **not**
  download for you — either put that checkpoint in `models/checkpoints` or point
  the graph elsewhere with `--set checkpoint=<name>`.
- If a graph needs an input image or an audio file, the file has to be in
  ComfyUI's `input/` folder (or uploaded) before the run: the CLI submits the
  graph, it does not invent the file.

Follow a job that is already in flight:

```bash
comfy jobs ls
comfy jobs status <prompt_id>
comfy jobs watch <prompt_id>
comfy download <prompt_id> -o ./outputs
```

`comfy download` also reads a `prompt_id` from stdin, so
`comfy run --workflow x.json | comfy download -o out` is a pipeline.

## Which custom nodes does this workflow need?

This is the question that decides whether a workflow will open at all, and
comfy-cli can answer it **without a server** — but not without a workspace and
ComfyUI-Manager:

```bash
comfy --workspace=/path/to/ComfyUI node deps-in-workflow --workflow=./workflow.json --output=./deps.json
comfy node install-deps --workflow=./workflow.json
```

`deps-in-workflow` writes a dependency file naming the node packs (and any model
URLs) the graph references; `install-deps` then installs them. `comfy_cli`
action=deps runs the first and reports the names, and never runs the second.

Two refusals come BEFORE it reads the graph, both measured on 1.29.0:

| Message | What it means |
|---|---|
| `'<path>' is not a valid ComfyUI workspace.` | comfy-cli's default is `<HOME>/comfy/ComfyUI`, which does not exist on a Desktop machine. Pass `--workspace=<a real tree>` (the tree must have `main.py`, `comfy/`, `nodes.py`, `comfy_extras/`, `comfy_api/`), or `comfy install`. |
| `ComfyUI-Manager not found. 'cm-cli' command is not available.` | the command resolves node packs through the **Manager**. A tree made by `comfy install` has one; a **Desktop install keeps its Manager inside the app**, so `deps-in-workflow` does not work against it. `comfy run --workflow` does not need the Manager. |

`comfy_cli` action=deps passes `--workspace` naming the tree `comfy_status`
found when comfy-cli's own default does not exist, so the first refusal is
avoided and the second is explained instead of dumped as raw stderr.

## Nodes

```bash
comfy node show installed
comfy node simple-show installed
comfy node install comfyui-impact-pack
comfy node registry-install comfyui-impact-pack
comfy node update all
comfy node save-snapshot
comfy node restore-snapshot <name>
comfy node bisect start
comfy extension list
```

- `node install <id>` goes through **ComfyUI-Manager**'s `cm-cli` and the
  Manager's channel database. The id is the **Comfy Registry id**, lower case
  (`comfyui-impact-pack`), not the GitHub repository name
  (`ComfyUI-Impact-Pack`) — the wrong casing fails to resolve.
- `node registry-install <id>` talks to the Registry directly, needs no Manager,
  and runs the node's own install script.
- `node update all` **can exit 0 even when a custom node failed to update**;
  `--exit-on-fail` is what makes a script see it.
- `node save-snapshot` / `restore-snapshot` is the way back from a pile of node
  changes; `node bisect` finds the pack that broke a graph.
- After installing a node pack, **restart ComfyUI**. The class only appears in
  `/object_info` after the server reloads — and a cached catalog from before the
  restart will not have it either.

## Models

```bash
comfy model list
comfy model download --url https://huggingface.co/.../model.safetensors --relative-path models/checkpoints
comfy model download --url https://civitai.com/models/12345 --relative-path models/loras
comfy model remove --model-names old.safetensors --relative-path models/checkpoints
```

The URL may be a CivitAI model page or a Hugging Face **file** URL;
`--relative-path` says which `models/…` folder it lands in, which is the thing
that decides whether a loader node's dropdown will show it. Tokens come from
`CIVITAI_API_TOKEN` / `HF_API_TOKEN`, or `--set-civitai-api-token` /
`--set-hf-api-token` once.

## Machine-readable output

`--json` is a **global option, before the subcommand** — `comfy --json env`, not
`comfy env --json` (which is a usage error: `No such option: --json`). With
stdout piped the CLI picks JSON on its own, but passing it explicitly is what
makes that a contract rather than a coincidence.

```bash
comfy --json env
comfy --json node show installed
```

Every answer is one **envelope**, so a script reads fields instead of prose:

```json
{
  "schema": "envelope/1",
  "type": "envelope",
  "ok": true,
  "command": "env",
  "version": "1.29.0",
  "where": null,
  "data": {
    "python": { "version": "3.12.11", "executable": "C:\\ComfyUI\\.venv\\Scripts\\python.exe" },
    "server": { "running": false, "url": null },
    "hardware": { "gpu": { "model": "NVIDIA GeForce RTX 3090", "vram_bytes": 25769803776 } },
    "workspace": {
      "path": "C:\\Users\\me\\Documents\\comfy\\ComfyUI",
      "type": "default",
      "exists": false,
      "desktop": {
        "installs": [
          { "name": "sdf", "code_dir": "C:\\Users\\me\\ComfyUI-Installs\\sdf\\ComfyUI", "data_dir": "C:\\Users\\me\\ComfyUI-Installs\\sdf\\ComfyUI", "exists": false }
        ],
        "model_roots": []
      }
    }
  },
  "error": null
}
```

- the payload is under **`data`**; the CLI's own version is a **top level**
  field (there is no need to scrape it);
- a refusal is still an envelope: `ok: false` with
  `error: { code, message, hint, details }` — e.g.
  `{"code": "server_not_running", "message": "ComfyUI not running on specified address (127.0.0.1:8188)", "hint": "run: comfy launch"}`.
  That is where the useful sentence lives, so read `error.code` before deciding
  something failed for an unknown reason;
- `data.workspace.desktop.installs[]` names every Desktop install with its
  `code_dir` and `data_dir` — the only place those paths are written down
  outside the app itself.

`--json-stream` emits one NDJSON event per line with the envelope last, and
`--help-json` prints machine-readable help for the whole CLI.

`COMFY_LOCAL_URL` points **every** local-targeting command at a server you
started outside comfy-cli:

```bash
export COMFY_LOCAL_URL=http://127.0.0.1:8189
comfy run --workflow ./workflow.json --wait
```

It accepts `http://host:port`, `host:port` or `http://host` (port defaults to
8188), with bracketed IPv6 literals. Precedence per command: `--host`/`--port`,
then `COMFY_LOCAL_URL`, then a comfy-cli background instance, then
`127.0.0.1:8188`.

Telemetry is **opt-in and off**; `DO_NOT_TRACK=1` or `COMFY_NO_TELEMETRY=1`
suppresses it regardless. `comfy tracking disable` turns it off permanently.

## What this pack runs, and what it will not

`comfy_cli` drives five things and refuses the rest:

| `comfy_cli` action | Runs | Why |
|---|---|---|
| `status` | `comfy --version`, `comfy --json env`, `comfy --json which` | read-only facts, and the Desktop install paths it names |
| `deps` | `comfy [--workspace=<tree>] --json node deps-in-workflow --workflow=… --output=…` | answers what a graph needs; needs a valid workspace AND ComfyUI-Manager |
| `run` | `comfy [--workspace=<tree>] --json run --workflow <file> --wait` (and optionally `comfy download`) | the independent test path; needs a RUNNING server |
| `launch` | `comfy --json launch --background` | gives you a server to test against |
| `stop` | `comfy --json stop` | so `launch` cannot leak |

**Never run by this pack** — each one changes somebody's machine, so the person
decides:

- `comfy install`, `comfy update`, `comfy --version` pins;
- `comfy node install` / `registry-install` / `update` / `restore-snapshot`;
- `comfy model download` / `remove`;
- `comfy cloud login`, `comfy generate` (both spend credits);
- `comfy manager`, `comfy extension` (they change what the app loads).

The skill names them so they are one copy-paste away. That is the division:
**the agent proposes the command, the person runs the ones that write.**

## When the CLI is the only thing that works

- **No server, no app open, and you need one:** `comfy launch --background`,
  then `comfy_status` finds the port it chose (Desktop ports and 8188 are both
  probed).
- **A canvas that the API tools cannot lower** (a subgraph export the app will
  not unpack): `comfy run --workflow` converts it itself and reports the failure
  from the server, which is a faster answer than reasoning about the JSON.
- **A machine you are setting up from nothing:** `pip install comfy-cli`,
  `comfy install`, `comfy model download`, then `comfy run` a smoke graph —
  no clicking, and the same lines on all three platforms.
