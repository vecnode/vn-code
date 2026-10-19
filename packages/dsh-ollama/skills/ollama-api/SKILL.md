---
name: ollama-api
description: The Ollama REST API as it is on this machine - /api/generate and /api/chat with streaming NDJSON, /api/embed vs the older /api/embeddings, /api/tags, /api/ps, /api/show, pull progress, create/copy/delete, the OpenAI-compatible /v1 endpoints, the options map, keep_alive, the error shapes, and the environment variables that change what the daemon does.
whenToUse: Use before writing any code that calls Ollama over HTTP, before debugging a request that returns 404 / 500 / an empty body, when a stream seems to end early, when structured output or tool calling is wanted, or when choosing between the native API and the OpenAI-compatible one.
---

# The Ollama REST API

The daemon is a plain HTTP server on the loopback interface. Everything below is
the shape this install answers with - not a client library's wrapper.

## The address

Ollama binds `127.0.0.1:11434` unless `OLLAMA_HOST` says otherwise. The value is
`host:port` (a scheme is accepted). Two different readers use it:

- the **daemon** reads `OLLAMA_HOST` as the address to BIND (`0.0.0.0:11434` to
  serve the whole network);
- a **client** reads it as the address to CONNECT to.

That asymmetry is the classic mistake: setting `OLLAMA_HOST=0.0.0.0:11434` for
the server and then pointing a client at `http://0.0.0.0:11434` works on Linux
and fails on Windows. Clients should default to `http://127.0.0.1:11434`.

The first request of any session should be the version, because every other
behaviour is version-dependent:

```bash
curl -s http://127.0.0.1:11434/api/version
```

```json
{"version":"0.40.3"}
```

`dsh-ollama`'s `ollama_status` answers this and the model inventory in one call;
when you are writing a program, this is the endpoint to probe.

## The three request shapes

### One prompt: `/api/generate`

```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"Why is the sky blue?","stream":false}'
```

`stream: false` answers ONE JSON object carrying the whole completion and every
timing field. `stream: true` (the daemon's default) answers NDJSON - see below.

### A conversation: `/api/chat`

```bash
curl -s http://127.0.0.1:11434/api/chat -d '{"model":"qwen2.5:7b","messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"Why is the sky blue?"}],"stream":false}'
```

Roles are `system`, `user`, `assistant` and `tool`. The same model, template and
options apply; the difference is that the daemon applies the chat template to
the whole array instead of wrapping one prompt.

### Vectors: `/api/embed`

```bash
curl -s http://127.0.0.1:11434/api/embed -d '{"model":"nomic-embed-text","input":["the cat sat","a cat was sitting"]}'
```

`input` is a string or an array. The answer is `{"embeddings": [[...], [...]],
"model": "...", ...}` - one vector per input, in order. Older daemons only have
the single-prompt form:

```bash
curl -s http://127.0.0.1:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"the cat sat"}'
```

That answers `{"embedding": [...]}`. Prefer `/api/embed`: one request, many
inputs, and a dimension you can rely on. If `/api/embed` returns 404, fall back.

## Streaming is NDJSON

A streaming answer is one JSON object per line, each line terminated by `\n`,
with `done: false` on every partial object and `done: true` on the last one. The
partial objects carry `response` (generate) or `message.content` (chat); the
FINAL object carries the token counts and the durations. Nothing before the last
line has a measurement in it.

```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"Say hello"}'
```

Three properties follow from that shape, and each one is a bug waiting to
happen:

1. **A line is not a document.** Parse per line; do not buffer the whole body
   and `JSON.parse` it.
2. **The last line is the measurement.** If your reader stops at the first
   `done: true` it has the numbers; if it stops at end-of-stream it may have
   them too, but the `done` object is the contract.
3. **A stream can be cut.** A cancelled request, a killed daemon or a timeout
   ends the stream with no `done` object at all. Treat "no done object" as a
   failed measurement, not as an empty answer.

A reader that keeps the text and the final object:

```javascript
const response = await fetch('http://127.0.0.1:11434/api/generate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'qwen2.5:7b', prompt: 'Say hello', stream: true }),
})
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let text = ''
let final = null
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (line === '') continue
    const item = JSON.parse(line)
    if (item.response) text += item.response
    if (item.done === true) final = item
  }
}
if (final === null) throw new Error('the stream ended without a done object')
console.log(text, final.eval_count, final.eval_duration)
```

(The arithmetic that turns those two numbers into tok/s is the
`ollama-inference-metrics` skill's subject.)

## The final object

`/api/generate` with `stream: false` and the last line of a streaming call have
the same fields:

| field | unit | what it covers |
|---|---|---|
| `response` | string | the generated text (chat: `message.content`) |
| `done` | bool | `true` on the final object |
| `done_reason` | string | `stop` (the model stopped) or `length` (it hit `num_predict`/context) |
| `context` | int[] | the token ids of prompt+answer - pass it back as `context` to continue |
| `total_duration` | ns | the whole daemon-side request |
| `load_duration` | ns | loading the weights (0 when they were resident) |
| `prompt_eval_count` | int | prompt tokens evaluated |
| `prompt_eval_duration` | ns | evaluating the prompt |
| `eval_count` | int | tokens generated |
| `eval_duration` | ns | generating them |

`done_reason: "length"` is the one field a reader must not ignore: the answer
was CUT by your `num_predict` or the context window, not finished by the model.

## Options and `keep_alive`

`options` is the sampling/runtime map. The ones that change the measurement:

| option | range | effect |
|---|---|---|
| `num_predict` | -1..N | max tokens to generate; `-1` (the default) means "until the model stops or the context fills" |
| `temperature` | 0..2 | 0 = greedy; the only defensible setting for a reproducible benchmark |
| `seed` | int | fixes sampling when temperature > 0; set it anyway so a rerun is comparable |
| `num_ctx` | 128.. | context window in tokens; the single biggest memory/speed knob |
| `top_k`, `top_p`, `min_p` | | sampling cutoffs |
| `repeat_penalty`, `repeat_last_n` | | repetition control |
| `stop` | string[] | stop sequences |
| `num_gpu` | int | layers offloaded to the GPU (0 = CPU only) |
| `num_thread` | int | CPU threads |
| `use_mmap`, `use_mlock` | bool | weight paging |

Anything the daemon does not recognise in `options` is **silently ignored** -
which is why a typo is worse than an error: the run reports numbers taken at a
setting nobody chose. `dsh-ollama` closes the map for exactly that reason.

`keep_alive` is a TOP-LEVEL sibling of `options`, not an option:

- `"5m"`, `"30s"`, `"1h"` - keep the weights loaded that long after the request;
- `0` - unload as soon as this request finishes;
- `-1` - never unload.

```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"hi","keep_alive":"10m"}'
```

Unloading is the documented use of an empty request:

```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","keep_alive":0}'
```

That is the call that makes a "cold" benchmark honest: without it, run 1 is
as warm as run 2 and the load time you meant to measure never appears.

## Models: list, inspect, pull, delete

```bash
curl -s http://127.0.0.1:11434/api/tags
```

`/api/tags` is the inventory: `name`, `size` (bytes), `digest` (`sha256:...`),
`modified_at`, and `details` (`family`, `families`, `parameter_size`,
`quantization_level`, `format`).

```bash
curl -s http://127.0.0.1:11434/api/ps
```

`/api/ps` is what is LOADED right now: `size`, `size_vram`, `context_length`,
`expires_at`, and the same `details`. `size_vram` is 0 for a CPU-resident model;
`size_vram / size` is the offload share.

```bash
curl -s http://127.0.0.1:11434/api/show -d '{"model":"qwen2.5:7b"}'
```

`/api/show` is the model's own metadata: `details`, `parameters` (the Modelfile
defaults - read them before assuming `temperature`), `template`, `license`,
`model_info` (`general.architecture`, `*.context_length`, `*.embedding_length`,
`*.block_count`) and `capabilities` (`completion`, `tools`, `embedding`,
`vision`, `thinking` depending on the model). `capabilities` is what tells you
whether a tag can embed at all.

```bash
curl -s http://127.0.0.1:11434/api/pull -d '{"model":"qwen2.5:7b","stream":true}'
```

A pull is NDJSON progress, not a completion: `{"status":"pulling manifest"}`,
then one line per layer with `digest`, `total` and `completed`, then
`{"status":"verifying sha256 digest"}`, then `{"status":"success"}`. It is
measured in gigabytes and minutes; there is no partial-success state - a cut
pull leaves layers cached and the next pull resumes them.

```bash
curl -s -X DELETE http://127.0.0.1:11434/api/delete -d '{"model":"llama3.2:1b"}'
```

Delete answers `200` with an empty body. It frees the bytes immediately; the
model comes back only by pulling it again. `dsh-ollama` requires the tag
repeated as `confirm` for this reason.

The other model verbs, for completeness:

```bash
curl -s http://127.0.0.1:11434/api/copy -d '{"source":"qwen2.5:7b","destination":"qwen2.5:7b-mine"}'
curl -s http://127.0.0.1:11434/api/create -d '{"model":"my-model","from":"qwen2.5:7b","system":"You answer in one sentence."}'
```

`copy` and `create` are not tools in this pack - they mutate the model store in
ways an agent should not do implicitly - but they are part of the surface and
worth knowing when a user asks why a tag exists.

## Errors, and what they mean

Ollama reports a problem as a non-2xx status with a JSON body `{"error": "..."}`.

| status | body | meaning | the fix |
|---|---|---|---|
| 404 | `model "x" not found, try pulling it first` | the tag is not on disk | `ollama pull x` |
| 404 | `404 page not found` | the route does not exist on this daemon (an older build, or a typo) | check `/api/version`, use the older shape |
| 400 | `invalid options` / `json: cannot unmarshal ...` | the body's shape is wrong | compare with this page |
| 500 | `...` | the model failed while loading or running | read the message; often memory (`num_ctx` too large) |
| (none) | `fetch failed` / `ECONNREFUSED` | the DAEMON is not running | `ollama serve`, or the desktop app |

A 500 whose message mentions memory is not a bug in your code: `num_ctx` sizes
the KV cache, and a context the machine cannot hold fails at load. Try a smaller
`num_ctx` or a smaller quantization.

## Structured output

`format` is a top-level field. `"json"` asks for any valid JSON; a JSON Schema
asks for that shape and is the reliable form:

```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"Give me one user: name and age.","format":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"}},"required":["name","age"]},"stream":false}'
```

The answer's text is a JSON document (not a Markdown fence). Parse it and fail
loudly when it does not parse - a schema is a strong request, not a guarantee.

## Tool calling

`/api/chat` accepts `tools` (a JSON-Schema function list) in the same shape as
the OpenAI tools array. The model answers with
`message.tool_calls: [{ function: { name, arguments } }]` and no content; you run
the function, append a `{role: "tool", content: "...", tool_name: "..."}`
message, and call again.

```bash
curl -s http://127.0.0.1:11434/api/chat -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"What is the weather in Lisbon?"}],"tools":[{"type":"function","function":{"name":"weather","description":"Current weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"stream":false}'
```

Not every model supports tools: check `capabilities` from `/api/show` first, or
you will get a plain-text answer that looks like a refusal.

## The OpenAI-compatible endpoints

Ollama also serves `/v1`: the same daemon, the OpenAI wire format. Use it when a
client library or SDK already speaks OpenAI and you cannot change it.

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"hi"}]}'
curl -s http://127.0.0.1:11434/v1/completions -d '{"model":"qwen2.5:7b","prompt":"hi"}'
curl -s http://127.0.0.1:11434/v1/embeddings -d '{"model":"nomic-embed-text","input":"hi"}'
curl -s http://127.0.0.1:11434/v1/models
```

Two cost-saving facts about this surface:

- the **timings are not in the OpenAI body**; the `usage` object carries token
  counts only. If you need the durations, use the native `/api` route;
- `stream: true` here is Server-Sent Events (`data: {...}` lines ending
  `data: [DONE]`), not NDJSON. A reader written for `/api` will not parse it.

## The CLI, for the same operations

| task | API | CLI |
|---|---|---|
| list models | `GET /api/tags` | `ollama list` |
| loaded models | `GET /api/ps` | `ollama ps` |
| inspect | `POST /api/show` | `ollama show qwen2.5:7b` |
| pull | `POST /api/pull` | `ollama pull qwen2.5:7b` |
| delete | `DELETE /api/delete` | `ollama rm qwen2.5:7b` |
| one prompt | `POST /api/generate` | `ollama run qwen2.5:7b "hi"` |
| daemon | - | `ollama serve` |

`ollama run` starts an interactive session when given no prompt; it is not a
drop-in for a scripted call, and it prints the finished text without the timing
fields.

## Environment variables that change the daemon

These are read by the SERVER at start, not per request:

| variable | default | what it does |
|---|---|---|
| `OLLAMA_HOST` | `127.0.0.1:11434` | the bind address |
| `OLLAMA_MODELS` | `~/.ollama/models` | where the weights live |
| `OLLAMA_KEEP_ALIVE` | `5m` | default residency for a loaded model |
| `OLLAMA_NUM_PARALLEL` | 1 (auto) | concurrent requests one model serves; each gets its own KV cache slot |
| `OLLAMA_MAX_LOADED_MODELS` | 3 x GPUs (auto) | how many models may be resident at once |
| `OLLAMA_MAX_QUEUE` | 512 | queued requests before the daemon answers 503 |
| `OLLAMA_FLASH_ATTENTION` | off | a speed/memory trade at long context |
| `OLLAMA_KV_CACHE_TYPE` | `f16` | `q8_0` / `q4_0` shrink the KV cache |
| `OLLAMA_ORIGINS` | localhost only | CORS origins the daemon accepts from a browser |
| `OLLAMA_DEBUG` | off | verbose server logging |

Two settings interact in a way that ruins benchmarks: with
`OLLAMA_NUM_PARALLEL=2`, one model serves two requests at once, so two
"sequential" runs can overlap and both report a lower tok/s. Measure with
parallelism at its default, or state it in the result.

## What not to do

- Do not assume the daemon is running. Probe `/api/version` and say the address
  you tried.
- Do not buffer a streaming response and parse it as one JSON document.
- Do not invent an `options` key: an unknown one is ignored, and the numbers
  become a claim about a setting the daemon never applied.
- Do not quote `total_duration` as latency: it is the daemon's own span, and it
  excludes the transport.
- Do not treat a 404 for a model as "the daemon is broken": the fix is
  `ollama pull`, and the error body says so.
