# dsh-comfyui

ComfyUI as a surface the agent can **build against**: a project spec becomes a
real `workflow.json` + `prompt.json`, is validated against the server's own node
catalog with ComfyUI's own error vocabulary, is queued, and reports what came
out. One row, seven tools, six skills, no browser half, zero npm dependencies, no
bundled engine.

## Why it exists

A ComfyUI workflow is a graph saved in **two dialects that are not
interchangeable**:

- the **canvas** the app saves — integer node ids, links as array positions, and
  `widgets_values`, an *unnamed* positional array;
- the **API prompt** `/prompt` accepts — ids as keys, wires as
  `["<id>", <slot>]`, values by name.

Nothing in the harness could turn one into the other, so nothing could tell a
reader *which* of the two things a broken workflow does: fail to open, or fail to
run. And the quietest defect in the whole format lives in that unnamed array —
measured on ComfyUI 0.21.1, `KSampler` declares `control_after_generate` on
`seed`, so its array is seven long:

```
[42, "fixed", 4, 1.5, "lcm", "sgm_uniform", 1.0]
  seed  │      steps cfg sampler scheduler  denoise
        └─ the value a converter forgets, shifting every later widget by one
```

A graph converted with that shift still opens, still runs, and produces the wrong
image with nothing reporting it. This row exists to make that impossible.

## The seven tools

| Tool | Answers |
|---|---|
| `comfy_status` | four facts that fail independently: an **install** on disk (Desktop base path, portable folder, checkout — version, python, model counts), a **server** answering on loopback (`/system_stats`, device, VRAM), the **catalog** in force (`/object_info`, a cache, or the built-in core table), and the **projects** in the workspace. It probes 8188 *and* the Desktop ports 8000-8003 — Desktop does not use 8188. Starts nothing. |
| `comfy_nodes` | the catalog: categories, one class's exact inputs and outputs (widget vs link, default/min/max, the option list), or a search. Every answer says which catalog it read. |
| `comfy_project` | `new` (from a shipped template or an inline spec, **rebinding** model filenames to what this machine has), `list`, `show`, `build`, `import` |
| `comfy_validate` | ComfyUI's own checks, offline, with `/prompt`'s `type` strings (`required_input_missing`, `return_type_mismatch`, `value_not_in_list`, `dependency_cycle`, `prompt_no_outputs`, …) plus the node KEY and input NAME. Never queues, never writes |
| `comfy_run` | the only tool that executes: builds, refuses a graph with errors, submits, waits for `/history`, reports files with `/view` URLs — or the node that raised |
| `comfy_test` | the ladder over the shipped library: compile always (writes nothing), run when a server answers |
| `comfy_cli` | comfy-cli as a **second witness**: `run` (which converts the canvas itself), `deps` (which node packs a graph needs), `launch`/`stop`, `status`. Never `install` |

## The ladder — every answer names the rung it reached

| Rung | Means |
|---|---|
| `v1-structural` | the spec compiles and the wires type-check, against the built-in core table (eighteen nodes) |
| `v2-schema` | the same against a **complete** server catalog: every class exists, every value is in the server's list |
| `v3-queued` | `/prompt` accepted it and returned a `prompt_id` |
| `v4-executed` | a `/history` entry finished and named files |

`v1` says one thing plainly: *no server catalog was in force*. "It compiles" is
never printed as "it runs".

## What it checks with no server at all

A server's `/object_info` is what turns a dropdown into a file list, so with the
app closed nothing used to check that a graph's checkpoint exists. This row reads
the **install** instead — the base path `comfy_status` found, `models/<folder>/`,
`input/`, plus any extra model root comfy-cli reports — and reports a missing
file with ComfyUI's own type:

```
ERROR value_not_in_list (node 2 · input lora_name): models/loras/lcm-lora-sdXL.safetensors
does not exist on this machine (1 file(s) there; nearest: lcm-lora-sd15.safetensors).
ComfyUI refuses a prompt naming a file it does not have with value_not_in_list, so
this graph cannot run yet.
```

It runs on the **compiled prompt**, where `@bindings` are already filenames, and
only for a file input whose option list the catalog did not know — when a server
did answer, its list is the truth and this stays quiet. A folder that does not
exist is a warning, not a missing file: nothing can be claimed about a path that
is not there.

So `v1-structural` on a machine whose models happen to be present is now a
claim somebody made, and a missing model is named, with the nearest file beside
it, before anything is queued.

## A project is a folder

```
comfyui/<slug>/
  project.json   the SOURCE — nodes by key, values by name, wires by <key>.<OUTPUT>, @bindings for anything machine-specific
  workflow.json  GENERATED — drag it onto the canvas
  prompt.json    GENERATED — what /prompt accepts
  README.md      GENERATED — what it is, what it needs, what was checked
  build.json     GENERATED — the receipt: spec sha256, catalog, rung, findings
```

`comfy_project action=new template=text-to-image` on a machine with a different
checkpoint does not fail: it rebinds `@checkpoint` — only on an exact
case-insensitive match or when the server lists exactly one file, never by
guessing between two — and prints every rebinding it made. An unresolvable
binding is an ERROR, because a graph built against a model nobody chose fails one
step from the cause.

## The shipped examples

| Slug | Graph | Needs |
|---|---|---|
| `smoke-image` | `EmptyImage` → `SaveImage` | **nothing** |
| `smoke-video` | `EmptyImage` → `RepeatImageBatch` → `CreateVideo` → `SaveVideo` | **nothing** |
| `text-to-image` | the 8-node class build: checkpoint → LCM LoRA → 2× CLIP → latent → KSampler (4 steps, cfg 1.5) → VAE decode → save | a checkpoint + a LoRA |
| `image-to-image` | the same graph with `LoadImage` → `ImageScale` → `VAEEncode` and denoise 0.55 | both + an input image |

The two model-free ones exist so a person proves the server, the queue, the
output folder and this row's compiler work **before** a 2 GB download is blamed.
`comfy_test action=compile` checks all four with nothing running.

## The six skills

`comfyui-fundamentals` (the mental model: graph is a program, latent arithmetic,
the dials, the six failures) · `comfyui-workflow-json` (both dialects and the
positional trap) · `comfyui-api` (the endpoints, the `node_errors` body, the
twelve error types, polling) · `comfyui-cli` (comfy-cli across platforms —
install, launch, run, deps, nodes, models, `--json`) · `comfyui-node-class`
(writing a node: classic `INPUT_TYPES`, the V3 `IO.ComfyNode` schema, the
verification step) · `comfyui-projects` (this row's dialect and the rung ladder).

Every fenced example in them is checked by this package's own check: JSON must
parse, JavaScript must pass `node --check`, Python must pass `ast.parse`, and
every `curl` must name a documented route and every `comfy` line a real
subcommand.

## What it deliberately does not do

No UI of its own (the app is the UI), no installing ComfyUI / a node pack / a
model, no starting a server except through `comfy launch --background`, no
WebSocket (it polls `/history`), no remote servers unless
`DSH_COMFYUI_ALLOW_REMOTE=1`, and no lowering of a subgraph export — it names the
ungroup step instead, because a subgraph has virtual input/output nodes and a
guess would produce a prompt that runs and means something else.

## Where things live

| | |
|---|---|
| projects | `<workspace>/comfyui/` (`DSH_COMFYUI_ROOT` moves it) |
| catalog cache | `$DSH_HOME/dsh-comfyui/schema/<origin>.json` — one per server read |
| the server this row talks to | `DSH_COMFYUI_URL` (loopback only, unless opted in) |
| the install, if it is somewhere unusual | `DSH_COMFYUI_DIR` |
| the comfy-cli binary | `DSH_COMFY_CLI` |
| the port ComfyUI Desktop picked | discovered, not assumed — 8188 and 8000-8003 are probed |

## Checking it

```bash
node checks/check-comfyui-node.mjs
```

363 assertions with no server and no CLI: a fake ComfyUI answers the real routes
with real-shaped bodies, a fake runner answers `comfy --version`, the four
examples compile, the canvas round-trips back to the same prompt, every refusal
is produced by name, and the live half runs only when a real server answers
(`DSH_COMFYUI_CHECK_LIVE=0` skips it).

This is **additional** to `scripts/checks/` — it travels with the package, which
is what makes it useful outside this repository.
