---
name: comfyui-workflow-json
description: The two ComfyUI workflow formats - the CANVAS the app saves (nodes, links, widgets_values) and the API PROMPT /prompt accepts - how they map onto each other, and the positional trap in widgets_values where a class that declares control_after_generate shifts every later value by one. Covers Reroute, PrimitiveNode, muted and bypassed nodes, subgraphs, where workflows live on disk, and how to export each format.
whenToUse: Reading, writing, diffing or generating a ComfyUI workflow file; turning a workflow into an API prompt or the reverse; debugging a graph that opens but produces wrong values, or a workflow that runs when exported as API and fails when saved as a canvas.
---

# The two files

ComfyUI has two JSON dialects for one graph and they are not interchangeable.

| | CANVAS (`workflow.json`) | PROMPT (`prompt.json`) |
|---|---|---|
| written by | the app's **Save** / **Export** | **Export (API)**, and what `/prompt` takes |
| node ids | integers on the canvas | **strings**, as object keys |
| wire | a `links` row pointing at array positions | `[ "<source id>", <slot> ]` |
| values | `widgets_values`, an UNNAMED positional array | named keys in `inputs` |
| geometry | `pos`, `size`, groups, colours | none |
| opens in the app | yes, that is its purpose | only as an API prompt |
| runs via `/prompt` | after the frontend converts it | directly |

A project that has to be both readable and runnable needs both. `dsh-comfyui`
keeps the spec as the source and generates the pair.

## The canvas

```json
{
  "last_node_id": 7,
  "last_link_id": 6,
  "nodes": [
    {
      "id": 1,
      "type": "CheckpointLoaderSimple",
      "pos": [40, 60],
      "size": [320, 100],
      "flags": {},
      "order": 0,
      "mode": 0,
      "inputs": [],
      "outputs": [
        { "name": "MODEL", "type": "MODEL", "links": [1], "slot_index": 0 },
        { "name": "CLIP", "type": "CLIP", "links": [2, 3], "slot_index": 1 },
        { "name": "VAE", "type": "VAE", "links": [4], "slot_index": 2 }
      ],
      "properties": { "Node name for S&R": "CheckpointLoaderSimple" },
      "widgets_values": ["v1-5-pruned-emaonly-fp16.safetensors"]
    }
  ],
  "links": [
    { "id": 1, "origin_id": 1, "origin_slot": 0, "target_id": 5, "target_slot": 0, "type": "MODEL" }
  ],
  "groups": [],
  "config": {},
  "extra": { "ds": { "scale": 1, "offset": [0, 0] } },
  "version": 0.4
}
```

Three things to know:

- **`links` has two spellings.** The 0.4 canvas stores objects
  (`{id, origin_id, origin_slot, target_id, target_slot, type}`); every older
  install stored arrays (`[id, origin, slot, target, slot, type]`). Read both;
  write the object form, which is what the current frontend saves.
- **A widget input appears in `inputs` only when a wire feeds it**, and then it
  carries `"widget": { "name": "seed" }` to say "this is still a widget, it is
  just driven by the wire". A widget nobody wired is not in `inputs` at all.
- **`order` is the execution index**, `mode` is 0 always / 2 muted / 4 bypassed,
  and `properties["Node name for S&R"]` is how the app re-creates the node from
  a saved workflow.

### `widgets_values` is positional, and one class shifts it

The array holds one value per widget input, in the class's own input order —
and **an input that declares `control_after_generate` adds a SECOND value right
after itself**, one of `"fixed"`, `"increment"`, `"decrement"`, `"randomize"`.

`KSampler` declares it on `seed`, so its array is seven long:

| index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| value | `42` | `"fixed"` | `4` | `1.5` | `"lcm"` | `"sgm_uniform"` | `1.0` |
| means | seed | control_after_generate | steps | cfg | sampler | scheduler | denoise |

A converter that forgets index 1 does not fail. It writes `steps = "fixed"`,
`cfg = 4`, `sampler = 1.5` — and the app opens a graph whose values are all
shifted, with nothing reporting it. `comfy_nodes` action=node prints the order
and marks the shift for any class.

In the API prompt the control value disappears entirely: it is a UI behaviour,
not graph state.

```json
{ "seed": 42, "steps": 4, "cfg": 1.5, "sampler_name": "lcm", "scheduler": "sgm_uniform", "denoise": 1.0 }
```

### The traps that are not nodes

| Thing | Stored as | What to do with it |
|---|---|---|
| `Reroute` | a node with one input and one output | follow it through; it is a bend in a wire |
| `PrimitiveNode` | a node whose `widgets_values[0]` is a literal | inline the literal into the widget it feeds |
| `Note`, `MarkdownNote` | a node with no sockets | drop it |
| muted node | `mode: 2` | drop it (it is not executed) |
| bypassed node | `mode: 4` | refuse rather than drop - bypass REWIRES through the node, so dropping it runs a different graph |
| subgraph | `definitions.subgraphs[]` | a frontend construct with virtual input/output nodes (`-10`, `-20`); unpack it in the app before lowering it |
| `GroupNode` | a node standing in for a group | unpack it |

A workflow exported from a template often has **no top-level nodes at all** —
its graph is inside a subgraph definition. That file is not broken, it is a
different shape, and `/prompt` cannot receive it.

## The API prompt

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors" }, "_meta": { "title": "Load Checkpoint" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "a lighthouse", "clip": ["1", 1] }, "_meta": { "title": "Positive" } },
  "5": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["1", 0], "seed": 42, "steps": 4, "cfg": 1.5,
      "sampler_name": "lcm", "scheduler": "sgm_uniform",
      "positive": ["2", 0], "negative": ["3", 0],
      "latent_image": ["4", 0], "denoise": 1.0
    },
    "_meta": { "title": "KSampler" }
  }
}
```

- **ids are strings**, and a wire is a 2-element array: `[source id as a string,
  output slot index]`. An integer id is a `bad_linked_input` waiting to happen.
- **only real inputs.** Hidden inputs (`prompt`, `extra_pnginfo`, `unique_id`)
  are supplied by the server and must not appear; `Save Image` therefore has no
  `prompt` key in a valid prompt.
- **`_meta.title` is cosmetic** — the app shows it in the queue — and safe to
  omit, but it is what makes a history entry readable.
- **the graph runs to its OUTPUT nodes.** A node that feeds nothing is dropped
  from the execution set (ComfyUI warns `prompt_no_outputs` only when the set is
  empty).

## Converting, in both directions

Canvas → prompt, per node:

1. skip `Reroute` (follow), `PrimitiveNode` (inline its value), notes and
   groups, and muted nodes;
2. decode `widgets_values` against the class's widget inputs **in order**, with
   the `control_after_generate` shift;
3. for each link into the node, look up the target input's NAME at
   `target_slot`, and write `inputs[name] = [String(origin_id), origin_slot]`;
4. skip hidden inputs.

That decode needs `/object_info`. The array has no names in it, so without the
catalog the numbers cannot be attributed — which is why every tool that reads a
canvas refuses without a complete catalog and says so.

Prompt → canvas: the reverse, and it also needs geometry the prompt does not
have. Generate it (columns by dependency depth is enough) rather than leaving
every node on `[0, 0]`, or the person opens a graph they cannot see.

## Where workflows live

| What | Where |
|---|---|
| the app's own saves | `user/default/workflows/` in the ComfyUI base path |
| templates | shipped with the frontend, listed under **Templates** in the sidebar |
| blueprints (this app version) | `blueprints/*.json` in the ComfyUI source tree |
| API exports | wherever you saved them; nothing in ComfyUI reads them back |

The base path is what `comfy_status` reports as `base`; on ComfyUI Desktop it is
NOT the app folder — the app is under `Programs/ComfyUI/resources/ComfyUI` and
the models, `input/`, `output/` and `user/` are in the base path.

## Verifying a file you did not write

1. `comfy_validate file=<path>` — it identifies a canvas by its `nodes` array and
   a prompt by its `{class_type, inputs}` values, and runs the right checks.
2. Look at the RUNG: `v2-schema` means a complete server catalog confirmed every
   class and every value; `v1-structural` means only the shapes were checked.
3. Only then `comfy_run file=<path>` — a validated graph is not a finished
   render.

Two rules that catch most bad files: a `links` row whose `target_slot` does not
match the target's `inputs` order, and a `widgets_values` array whose length is
one short for a class that declares `control_after_generate`. Both are silent in
the app until a value is wrong.
