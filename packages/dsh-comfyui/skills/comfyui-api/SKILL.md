---
name: comfyui-api
description: The ComfyUI HTTP API as this install actually has it - the port ComfyUI Desktop uses instead of 8188, /system_stats, /object_info, POST /prompt and the exact node_errors body that rejects a graph, /history and the status.messages events a failure hides in, /queue, /view, /upload/image, /models, /api/jobs and the WebSocket - with curl, Python and JavaScript examples and the twelve validation error types.
whenToUse: Talking to a ComfyUI server directly (curl, fetch, urllib, a script), reading a 400 from /prompt, polling for a finished render, listing the models or node classes a server has, or debugging why a request that "should" work is refused.
---

# The API, as a server answers it

Everything the app does, it does over HTTP to its own server. Two ports matter:

- **8188** — the default for `python main.py`.
- **8000 and up** — what **ComfyUI Desktop** picks. A probe that only tries 8188
  reports "not running" on a machine where the app is open. Try 8000, 8001,
  8002, 8003.

`comfy_status` probes both families and prints the origin that answered.

```bash
curl -s http://127.0.0.1:8188/system_stats
```

```json
{
  "system": {
    "os": "nt",
    "ram_total": 17179869184,
    "ram_free": 6442450944,
    "comfyui_version": "0.21.1",
    "python_version": "3.12.11 (main, ...)",
    "pytorch_version": "2.9.0+cu128",
    "argv": ["main.py", "--listen", "127.0.0.1"]
  },
  "devices": [
    { "name": "cuda:0 NVIDIA GeForce RTX 4060", "type": "cuda", "index": null,
      "vram_total": 8589934592, "vram_free": 6871947673,
      "torch_vram_total": 8589934592, "torch_vram_free": 6871947673 }
  ]
}
```

`/system_stats` is the only reliable "is it up" probe: it is answered by the
engine, and it carries the version, the device and the VRAM every later decision
needs.

## The endpoints

| Method | Path | Answers |
|---|---|---|
| GET | `/system_stats` | version, device, VRAM, RAM, argv |
| GET | `/object_info` | **every node class**: inputs, outputs, defaults, option lists |
| GET | `/object_info/{class}` | one class, same shape |
| POST | `/prompt` | queue a prompt; `{prompt_id, number, node_errors}` |
| GET | `/prompt` | the queue's own summary |
| GET | `/history` | finished prompts, most recent first |
| GET | `/history/{prompt_id}` | one finished prompt, or `{}` |
| GET | `/queue` | `{queue_running, queue_pending}` |
| POST | `/queue` | `{"clear": true}` or `{"delete": ["<id>"]}` |
| POST | `/interrupt` | stop the running prompt (optional `{"prompt_id": "..."}`) |
| POST | `/free` | `{"unload_models": true, "free_memory": true}` |
| GET | `/view?filename=&subfolder=&type=output` | the bytes of one artifact |
| POST | `/upload/image` | multipart upload into `input/` |
| GET | `/models` | every model folder name |
| GET | `/models/{folder}` | the filenames in one folder |
| GET | `/embeddings` | textual inversions |
| GET | `/features` | server feature flags |
| GET | `/api/jobs?status=&limit=&offset=` | the job view (see below) |
| GET | `/ws?clientId=` | the event stream the frontend uses |

## `/object_info` is the schema

This is the call that makes anything else possible: it is the only authority on
which inputs are **widgets** (values typed in) rather than **links** (wires), and
on what a combo's options are on THIS machine.

```bash
curl -s "http://127.0.0.1:8188/object_info/KSampler"
```

```json
{
  "KSampler": {
    "input": {
      "required": {
        "model": ["MODEL", { "tooltip": "The model used to denoise the input latent." }],
        "seed": ["INT", { "default": 0, "min": 0, "max": 18446744073709551615, "control_after_generate": true }],
        "steps": ["INT", { "default": 20, "min": 1, "max": 10000 }],
        "cfg": ["FLOAT", { "default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1 }],
        "sampler_name": [["euler", "euler_ancestral", "dpmpp_2m", "lcm"], {}],
        "scheduler": [["normal", "karras", "sgm_uniform"], {}],
        "positive": ["CONDITIONING", {}],
        "negative": ["CONDITIONING", {}],
        "latent_image": ["LATENT", {}],
        "denoise": ["FLOAT", { "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01 }]
      }
    },
    "input_order": { "required": ["model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative", "latent_image", "denoise"] },
    "output": ["LATENT"],
    "output_name": ["LATENT"],
    "output_node": false,
    "name": "KSampler",
    "display_name": "KSampler",
    "category": "sampling"
  }
}
```

Read it like this:

- an input is `[type, options]`; **a type that is an ARRAY is a combo** whose
  options are on this machine right now (`ckpt_name`, `lora_name`, `image`);
- the string `"COMBO"` is the newer spelling of the same thing, with the options
  under `options.options` (V3 nodes such as `RepeatImageBatch` answer this way);
- `input_order` is the order `widgets_values` uses;
- `control_after_generate: true` adds one extra value to `widgets_values` right
  after that input;
- `forceInput: true` makes a widget link-only;
- `"hidden"` inputs (`prompt`, `extra_pnginfo`, `unique_id`) are filled by the
  server and must never be sent.

The catalog is version-specific — install a node pack and it changes. Never ship
a snapshot as truth; read it, and cache it only for a server that has since
stopped.

## POST /prompt

```bash
curl -s -X POST http://127.0.0.1:8188/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": {"1": {"class_type": "EmptyImage", "inputs": {"width": 512, "height": 512, "batch_size": 1, "color": 0}}, "2": {"class_type": "SaveImage", "inputs": {"filename_prefix": "api/smoke", "images": ["1", 0]}}}, "client_id": "my-script"}'
```

Accepted:

```json
{ "prompt_id": "1f9c0c1e-8f3d-4a3f-a9a3-0c0a3f2b7d11", "number": 3, "node_errors": {} }
```

Rejected — HTTP **400**, and the body is the useful part:

```json
{
  "error": {
    "type": "prompt_outputs_failed_validation",
    "message": "Prompt outputs failed validation",
    "details": "",
    "extra_info": {}
  },
  "node_errors": {
    "1": {
      "errors": [
        {
          "type": "value_not_in_list",
          "message": "Value not in list",
          "details": "ckpt_name: 'sd15.safetensors' not in ['v1-5-pruned-emaonly-fp16.safetensors']",
          "extra_info": { "input_name": "ckpt_name", "received_value": "sd15.safetensors" }
        }
      ],
      "dependent_outputs": ["2"],
      "class_type": "CheckpointLoaderSimple"
    }
  }
}
```

The twelve `type` strings the validator produces, and what each means:

| `type` | Meaning |
|---|---|
| `prompt_no_outputs` | no OUTPUT node anywhere in the prompt |
| `missing_node_type` | a node has no `class_type`, or the class does not exist here |
| `required_input_missing` | a required input is not set |
| `bad_linked_input` | a wire is not a `[id, slot]` pair, or points at a node that is not in the prompt |
| `return_type_mismatch` | the source output's type does not match the input's |
| `invalid_input_type` | a value cannot be converted to the declared type |
| `value_smaller_than_min` | below the input's `min` |
| `value_bigger_than_max` | above the input's `max` |
| `value_not_in_list` | a combo value the server does not have |
| `dependency_cycle` | the graph waits on itself |
| `custom_validation_failed` | the node's own `VALIDATE_INPUTS` said no |
| `exception_during_validation` | validating the node raised |

`dependent_outputs` names the output nodes that would have used the broken node
— which is how you tell "this breaks the save" from "this breaks an optional
branch".

## GET /history/{prompt_id}

Polling this is how a script learns a render finished; the WebSocket is how the
app learns it first.

```json
{
  "prompt_id": {
    "prompt": [3, "prompt_id", { "1": { "class_type": "SaveImage", "inputs": {} } }, {}, ["2"]],
    "outputs": {
      "2": { "images": [ { "filename": "smoke_00001_.png", "subfolder": "dsh-comfyui", "type": "output" } ] }
    },
    "status": {
      "status_str": "success",
      "completed": true,
      "messages": [
        ["execution_start", { "prompt_id": "prompt_id", "timestamp": 1764290000000 }],
        ["execution_cached", { "nodes": ["1"], "prompt_id": "prompt_id", "timestamp": 1764290000001 }],
        ["execution_success", { "prompt_id": "prompt_id", "timestamp": 1764290002100 }]
      ]
    }
  }
}
```

- **`outputs` is keyed by node id**, and the inner key depends on the node:
  `images` for `SaveImage`, `audio` for `SaveAudio`, `video` (or `images`) for
  `SaveVideo`. Read it generically: any array of `{filename, subfolder, type}`
  is a saved artifact.
- **an empty object means "not finished yet"** — `/history/{id}` answers `{}`
  until the item reaches the front of the queue and completes.
- **the failure is inside `status.messages`**, as an `execution_error` entry
  with `node_id`, `node_type`, `exception_message`, `exception_type` and a
  `traceback`. `status_str` is `"error"` and `completed` is `false`.
- `execution_interrupted` is a cancel, not a crash.

A prompt that leaves the queue without ever appearing in `/history` was dropped:
the server restarted, or the item was deleted.

## Artifacts: /view

```bash
curl -s -o out.png "http://127.0.0.1:8188/view?filename=smoke_00001_.png&subfolder=dsh-comfyui&type=output"
```

`type` is `output` for saved files, `temp` for previews and `input` for uploaded
ones. `subfolder` is the prefix folder a `filename_prefix` like
`dsh-comfyui/smoke` created.

## A polling loop, in the two languages you will actually use

```js
const base = 'http://127.0.0.1:8188'
const prompt = {
  '1': { class_type: 'EmptyImage', inputs: { width: 512, height: 512, batch_size: 1, color: 0 } },
  '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'api/smoke', images: ['1', 0] } },
}
const queued = await fetch(base + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'my-script' }),
}).then(async (response) => {
  const body = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(body.node_errors))
  return body
})
for (;;) {
  const history = await fetch(base + '/history/' + queued.prompt_id).then((response) => response.json())
  const entry = history[queued.prompt_id]
  if (entry !== undefined) {
    const status = entry.status
    const files = Object.values(entry.outputs ?? {}).flatMap((output) => Object.values(output).flat())
    console.log(status.status_str, status.completed, files.map((file) => file.filename))
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}
```

```python
import json, time, urllib.request

BASE = "http://127.0.0.1:8188"

def post(path, body):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read())
        raise SystemExit(f"refused: {detail.get('node_errors')}")

prompt = {
    "1": {"class_type": "EmptyImage", "inputs": {"width": 512, "height": 512, "batch_size": 1, "color": 0}},
    "2": {"class_type": "SaveImage", "inputs": {"filename_prefix": "api/smoke", "images": ["1", 0]}},
}
queued = post("/prompt", {"prompt": prompt, "client_id": "my-script"})
prompt_id = queued["prompt_id"]

while True:
    with urllib.request.urlopen(f"{BASE}/history/{prompt_id}") as response:
        history = json.loads(response.read())
    if prompt_id in history:
        status = history[prompt_id]["status"]
        for node_id, output in history[prompt_id]["outputs"].items():
            for key, files in output.items():
                for entry in files:
                    print(node_id, key, entry["filename"], entry.get("subfolder", ""))
        print(status["status_str"], status["completed"])
        break
    time.sleep(0.5)
```

Both loops do the same three things: submit, poll the id, read `outputs` and
`status`. A timeout is not a failure — the first run of a graph pays the model
load.

## `/api/jobs`, and why it is not `/history`

Newer servers keep a job view with filtering, sorting and pagination:

```bash
curl -s "http://127.0.0.1:8188/api/jobs?status=completed&limit=5"
```

It reports `pending`, `in_progress`, `completed` and `failed` across the queue
AND the history, which is what a dashboard wants. `/history` remains the thing
`comfy_run` waits on, because it is the endpoint every version has.

## The WebSocket

`/ws?clientId=…` streams `status`, `execution_start`, `execution_cached`,
`executing`, `progress`, `executed`, `execution_error`, `execution_interrupted`
and binary preview frames. It is the lowest-latency way to watch a render, and
it needs a socket and a message protocol. `dsh-comfyui` deliberately does not
open one: `/history/{id}` is enough for "did it finish, and what came out", and a
polling loop has no reconnection logic to get wrong. Use the socket when you need
live progress, not to find out whether something worked.

## Rules that save a debugging session

1. **Probe `/system_stats` first.** A 404 from anything else is usually the wrong
   port, not a wrong path.
2. **Never guess a slot index.** Read `output` from `/object_info` — the order of
   a class's `RETURN_TYPES` is arbitrary.
3. **A 400 is a diagnosis, not a failure.** Print `node_errors` — the message
   names the node, the input and the value.
4. **`/history` answers `{}` for a prompt that has not finished**, and for one
   that never existed. Verify the queue if the distinction matters.
5. **Respect the serial queue.** Submitting five prompts does not run them in
   parallel; it makes the fifth wait. One device, one model.
6. **Nothing here is authenticated.** Bind ComfyUI to loopback unless you mean to
   expose it: the API can write files to the host it runs on.
