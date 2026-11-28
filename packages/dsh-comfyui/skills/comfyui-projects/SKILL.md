---
name: comfyui-projects
description: The dsh-comfyui project dialect - a folder whose project.json is a small readable spec (nodes by KEY, values by NAME, wires by `<key>.<OUTPUT>`, `@bindings` for anything that belongs to a machine) from which workflow.json and prompt.json are GENERATED, validated against the server's own node catalog, and run; the four rungs of the ladder and what each proves; the shipped example library; and how to bring an existing ComfyUI workflow in.
whenToUse: Creating, editing, validating or running a ComfyUI project with the comfy_* tools; adding an example to the shipped library; importing a workflow out of the app; deciding whether a graph is merely well-shaped or actually verified; or when a build or run refuses and the finding needs reading.
---

# A project is a folder with one file you edit

```
comfyui/text-to-image/
  project.json     ← the SOURCE. You edit this.
  workflow.json    ← GENERATED. Drag it onto the ComfyUI canvas.
  prompt.json      ← GENERATED. What /prompt accepts.
  README.md        ← GENERATED. What it is, what it needs, what was checked.
  build.json       ← GENERATED. The receipt: catalog, rung, findings.
```

The generated files say so at the top. Editing `workflow.json` by hand is a
counting exercise — its `widgets_values` is an unnamed positional array whose
meaning moves when a class declares `control_after_generate` — so the spec is the
only file worth writing.

## The spec

```json
{
  "name": "solid-tint",
  "title": "Solid Tint",
  "description": "Recolour an existing image with one multiply pass.",
  "tags": ["image"],
  "requires": {
    "nodes": ["LoadImage", "SaveImage"],
    "models": {},
    "inputFiles": ["photo.png"]
  },
  "bindings": {
    "inputImage": "photo.png",
    "color": 16745540,
    "strength": 0.6,
    "mode": "multiply"
  },
  "nodes": [
    {
      "key": "input",
      "class": "LoadImage",
      "title": "Load Image",
      "pos": [40, 120],
      "widgets": { "image": "@inputImage" }
    },
    {
      "key": "tint",
      "class": "ImageSolidTint",
      "title": "Solid Tint",
      "pos": [420, 120],
      "widgets": { "color": "@color", "strength": "@strength", "mode": "@mode" },
      "wires": { "image": "input.IMAGE" }
    },
    {
      "key": "save",
      "class": "SaveImage",
      "title": "Save Image",
      "pos": [800, 120],
      "widgets": { "filename_prefix": "dsh-comfyui/solid-tint" },
      "wires": { "images": "tint.IMAGE" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | the folder name; lower case, digits and dashes |
| `title`, `description` | what the generated README and the tool answers show |
| `requires.models` | `{ "<folder>": ["file", …] }` — what must exist under `models/` |
| `requires.inputFiles` | files that must exist under `input/` |
| `requires.nodes` | the classes the graph uses (documentation and a check) |
| `bindings` | the machine-specific values, addressed as `@name` |
| `nodes[].key` | the node's identity inside the project; wires refer to it |
| `nodes[].class` | the ComfyUI class, exactly as `/object_info` spells it |
| `nodes[].widgets` | input name → value (or `@binding`) |
| `nodes[].wires` | input name → `"<key>.<OUTPUT>"`, `"<key>.<slot>"` or `"<key>"` |
| `nodes[].controlAfterGenerate` | per-seed `"fixed"` / `"increment"` / `"decrement"` / `"randomize"` |
| `nodes[].pos`, `size` | optional; geometry is computed by dependency depth otherwise |
| `notes` | free text printed into the generated README |

### Why bindings

A graph that hardcodes `v1-5-pruned-emaonly-fp16.safetensors` is a graph that
fails on any machine that has a different checkpoint, with `value_not_in_list`
and no clue that a re-download is not the answer. A binding moves that decision
to build time:

- `comfy_project` action=new **rebinds** a file-ish binding to this machine's
  list when the declared file is not there — only on an exact case-insensitive
  match or when the server lists exactly one file, never by guessing between
  two;
- every rebinding is printed, so the report says `@checkpoint: "a" -> "b"`;
- a binding nobody can resolve is an **error** (`BINDING_UNRESOLVED`), never a
  silent default: a graph built against a model nobody chose is a graph whose
  first run fails one step from the cause.

### Why the wire names an OUTPUT

`"images": "decode.IMAGE"` is resolved through the class's `RETURN_TYPES` order
to a slot index. `decode.0` works too (and is what you need when the class is not
in the catalog). The compiler refuses an output name the class does not have and
lists the real ones — a wrong slot is the quietest way to break a graph.

## The four rungs, and exactly what each proves

| Rung | Reached when | What it means |
|---|---|---|
| `v1-structural` | the spec compiles, wires resolve, types line up — against the **built-in core table** | the graph is well-formed, and nothing confirms the classes exist on this machine |
| `v2-schema` | the same, against a complete server catalog (live or cached) | every class exists, every required input is set, every value is in the server's own list — the same checks `/prompt` runs |
| `v3-queued` | the server accepted the prompt (`/prompt` answered a `prompt_id`) | the graph is runnable |
| `v4-executed` | a `/history` entry finished and `outputs` named files | it ran and produced something you can look at |

Anything below `v2-schema` says one thing plainly: **no server catalog was in
force**. `comfy_status` tells you which catalog is in force and how to get a
better one.

## The worked sequence

```bash
comfy_status
```

Read three lines: is there a **server** (and on which port), is there an
**install** (and where its models are), and which **catalog** is in force.

```bash
comfy_nodes action=search query=checkpoint
comfy_nodes action=node node=LoadImage
```

The second one is not optional before wiring an unfamiliar class: it prints the
input order, which is what `widgets_values` means.

```bash
comfy_project action=new template=smoke-image name=first-run
```

No model needed. It writes the folder, builds both files, and reports the rung.

```bash
comfy_validate project=first-run
comfy_run project=first-run
```

`comfy_validate` never queues anything and never writes. `comfy_run` builds,
refuses a graph with validation errors, and otherwise submits and waits.

```bash
comfy_test action=compile
comfy_test action=run waitSeconds=120
```

`compile` is the check that works on a machine with no ComfyUI running, and is
what to run after changing anything. `run` is the same library through a live
server, one item at a time.

The other way in, when you already have a workflow from the app:

```bash
comfy_project action=import source=./my-workflow.json name=my-graph
comfy_project action=build project=my-graph
```

An imported canvas is stored as `workflow.json` and **never rewritten**; its
`prompt.json` is derived from it on every build. That derivation needs a complete
catalog (the `widgets_values` decode), and says so instead of guessing.

## The second witness: comfy-cli

`comfy_cli action=run project=first-run` runs
`comfy run --workflow workflow.json --wait`, which converts the canvas with
comfy-cli's own converter and submits it. Two implementations, one graph: if the
API accepts `prompt.json` and the CLI accepts `workflow.json`, the canvas and the
prompt agree about what the graph *is*.

`comfy_cli action=deps project=first-run` answers the question a project cannot
answer about itself — which custom node packs it needs — before the graph is even
opened.

## Adding an example to the shipped library

An example is a folder under `examples/` with a `project.json` and nothing else
required:

1. copy the closest example, change `name` and the nodes;
2. `comfy_test action=compile examples=["your-slug"]` — it must reach at least
   `v1-structural` (and `v2-schema` whenever a server is up);
3. prefer **no models**: an example that needs a 2 GB download is not the one a
   person tries first. `smoke-image` and `smoke-video` exist for exactly that;
4. declare everything it needs in `requires` — a check that cannot say what is
   missing is not a check.

The four shipped examples:

| Slug | Nodes | Needs |
|---|---|---|
| `smoke-image` | `EmptyImage` → `SaveImage` | nothing |
| `smoke-video` | `EmptyImage` → `RepeatImageBatch` → `CreateVideo` → `SaveVideo` | nothing |
| `text-to-image` | 8 nodes, SD 1.5 + LCM LoRA, 4 steps | a checkpoint and a LoRA |
| `image-to-image` | 10 nodes, denoise 0.55 | both of those plus an input image |

## `build.json`, the receipt

```json
{
  "schema": 1,
  "project": "first-run",
  "source": "spec",
  "builtAt": "2026-11-27T23:40:00.000Z",
  "specSha256": "…",
  "catalog": { "source": "server", "version": "0.21.1", "origin": "http://127.0.0.1:8188", "complete": true },
  "widgetOrder": "server",
  "rung": "v2-schema",
  "ok": true,
  "counts": { "nodes": 2, "links": 1, "errors": 0, "warnings": 0 },
  "findings": []
}
```

Which spec bytes, against which catalog, when, with which findings. A question
about a workflow somebody was handed is answerable from the folder. `widgetOrder`
is `server` / `cache` / `core-table` / `workflow-file` — the one field that says
what the widget layout was actually derived from.

## When it refuses

| Refusal | What it means | Fix |
|---|---|---|
| `BINDING_UNRESOLVED` | a `@name` has no value | add it to `bindings` (or pass `bindings` to `action=new`) |
| `unknown_widget` | the input is not a widget of that class | the message lists the real ones |
| `unknown_output` | the wire names an output the class does not have | the message lists `slot=NAME:TYPE` |
| `return_type_mismatch` | the wire carries the wrong type | rewire; check `comfy_nodes` for both ends |
| `value_not_in_list` | a combo value the server does not have — or, with no server, a file missing from `models/<folder>/` (the message names the folder, how many files are there, and the nearest name) | the message lists options / the nearest file |
| `model_folder_absent` (warning) | the graph needs a file from a folder that does not exist under the base path | nothing can be claimed about it until the folder is there |
| `required_input_missing` | a required input was never set | set it, or the class has no default |
| `prompt_no_outputs` | nothing to run the graph for | add `SaveImage` / `SaveVideo` |
| `class_unverified` (warning) | the core table does not cover the class | start ComfyUI for a real check |
| `SCHEMA_REQUIRED` | a canvas was given to a build with no server catalog | start ComfyUI, or validate the `prompt.json` instead |
| `SUBGRAPH_ONLY` | the file's graph is inside a subgraph | unpack it in the app, or `comfy run --workflow` |

None of these is a crash and none needs the app open to read: each names the
node key, the input and the value, which is what you are looking at.
