# Plan — `dsh-ollama`

A plugin that makes this pack able to **run, measure and build on** the
machine's own Ollama: one row of `ollama_*` tools over the local daemon's HTTP
API, a benchmark that reports numbers a reader can check, and the skills that
teach the API and the Python integration. Host-only: one row, no browser half,
no route, no vendored engine. It drives the daemon the user already installed,
the way `dsh-docker` drives their Docker CLI.

Measured on this machine before the plan: `ollama --version` is **0.40.3**, and
the daemon is **not running** — which is the normal state and the first thing
the plugin has to say honestly.

## Why it makes sense

- **Inference analysis is the product.** Every other agent surface here can
  *call* a model. None can tell you that `qwen2.5:7b` did 41.2 tok/s on this
  machine at 8k context, with a 3.1 s cold load, and that a second run is 2.4×
  faster because the weights stayed resident. Ollama reports exactly those
  numbers in every response (`eval_count`, `eval_duration`, `load_duration`,
  `prompt_eval_duration`, `total_duration`) and nothing in the pack reads them.
- **It is loopback, not egress.** The tools talk to `127.0.0.1:11434` — the
  machine's own service — so the pack's "no network a plugin starts" rule holds
  the same way it does for Docker. A non-loopback `OLLAMA_HOST` is refused by
  default (one explicit opt-in variable for a daemon the user really runs on
  another box).
- **"Develop Ollama in new apps" is a skills problem, not a scaffold problem.**
  The pack already has a prototyping lab for writing projects; what is missing
  is the knowledge: the REST surface, the streaming shape, `keep_alive`, the
  OpenAI-compatible endpoints, and a Python client pattern that tests itself.
  That is three skills, not a fourth generator.

## The tool surface (one row: `ollama`)

| tool | what it does | what it refuses |
|---|---|---|
| `ollama_status` | daemon reachability (`/api/version`), the models on disk (`/api/tags`: family, parameter size, quantization, bytes, digest), what is loaded right now (`/api/ps`: processor split, context, `expires_at`), the host it used, and the CLI version | never starts the daemon; says how (`ollama serve`, or the desktop app) |
| `ollama_run` | ONE bounded inference: model, prompt or messages, `options` (`num_predict`, `temperature`, `seed`, `num_ctx`, `stop`, `format`), `keep_alive`; returns the text **and** the numbers: prompt/eval token counts, tok/s from `eval_count / eval_duration`, time-to-first-token, load time, wall clock | a model that is not pulled; a `num_predict` over the cap; a non-loopback host unless opted in |
| `ollama_bench` | N repetitions of one call: cold vs warm, per-run and aggregate (median, p95) tok/s and TTFT, optional A/B over several models, optional context sweep | fewer than 3 runs (a single number is not a measurement); a timeout it cannot bound |
| `ollama_models` | `show` one model (parameters, template, license, family), list with sizes; `pull` and `rm` only with an explicit confirm and a size on screen | an unconfirmed pull (models are gigabytes) or delete |
| `ollama_embed` | embeddings for one or more strings (`/api/embed`), the dimension, cosine similarity between two texts | a model that does not embed |

Three routes exist only if a UI follows later; **alpha.1 is host-only**, like
`dsh-wsl` and `dsh-ocr`. A results tab (a bench table with a chart) is the
obvious alpha.2.

## The skills (three, each with examples a check compiles or runs)

1. **`ollama-api`** — the REST surface as it is on this install: `/api/generate`
   and `/api/chat` (streaming NDJSON, one JSON object per line, `done: true`
   last), `/api/embed` vs the older `/api/embeddings`, `/api/tags`, `/api/ps`,
   `/api/show`, `/api/pull` progress, `/api/create`, `/api/copy`, `/api/delete`,
   the OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings`, the
   `options` map, `keep_alive`, and error shapes (404 for a missing model, 500
   with a message body). Plus the CLI equivalents and `OLLAMA_HOST` /
   `OLLAMA_NUM_PARALLEL` / `OLLAMA_MAX_LOADED_MODELS` / `OLLAMA_KEEP_ALIVE`.
2. **`ollama-inference-metrics`** — what each duration field means and the
   arithmetic: tok/s, TTFT = load + prompt-eval, why `total_duration` is not a
   latency, why a second run is faster (weights resident), what changes with
   `num_ctx`, quantization, GPU offload, and parallel requests; and the reporting
   rules: ≥5 runs, median with spread, one variable at a time, temperature 0 with
   a fixed seed, and the model **digest** in the answer.
3. **`ollama-python`** — the `ollama` Python package: `chat()`, `generate()`,
   streaming, `embed`, tool calling, structured outputs (`format="json"` and a
   JSON Schema), the async client, `keep_alive`, timeouts and cancellation; a
   project shape (pyproject, a `client.py`, a `bench.py`, a pytest that runs
   against a **fake transport** and skips the live half loudly), and how to point
   it at the daemon without hardcoding a host.

The skills carry the code. Nothing scaffolds a project in alpha.1 — the lab owns
"write a project", and duplicating it here would be a second generator with a
second set of bugs.

## Honesty rules (the part worth engineering against)

- **A refusal is an answer.** No daemon → one sentence naming the host it tried
  and the command that starts one. No model → the tag it wanted, the tags that
  exist, and the exact `ollama pull`.
- **Numbers carry their conditions.** Every tok/s names the model digest, the
  context length, the run count and the spread. A single run is labelled a
  single run.
- **No download a tool starts on its own.** `pull` needs a confirm and shows the
  size; nothing pulls a model implicitly.
- **Loopback only, by default.** `OLLAMA_HOST` pointing off-machine is refused
  with the reason and the one environment variable that allows it.

## Checks

The package ships its own, and `npm run check` is offline and fast:

- a **fake daemon** (`node:http`) serving canned `/api/version`, `/api/tags`,
  `/api/ps` and `/api/generate` responses with fixed nanosecond durations, so the
  arithmetic, the caps, the confirmations and every refusal are asserted
  deterministically;
- the **loopback fence**: a `OLLAMA_HOST` off-machine is refused, and no request
  is made anywhere but 127.0.0.1;
- the **skill examples**: every fenced `curl` shape parsed and every Python block
  compiled when a Python is on PATH (skipped loudly otherwise), the same rule the
  SuperCollider skills' examples follow;
- a **live half** that runs one tiny generation and one bench against the real
  daemon **only when it answers**, and skips with the reason when it does not.

The pack-wide checks still own the row: `check-node-routes.mjs` for the manifest
and route absence, `check-no-secrets.mjs`, and the root README/ARCHITECTURE rows.

## What it does not do

- No model download, no model conversion, no GGUF handling — the daemon's job.
- No GPU driver, no VRAM probing beyond what `/api/ps` reports.
- No chat UI: this is a tool surface plus skills, not a second conversation.
- No remote inference: the OpenAI-compatible *endpoint* is documented for the
  user's own code; this plugin still talks to the local daemon.

## Order of work

1. `lib/ollama.js` — the client: loopback fence, bounded `fetch` with a timeout,
   NDJSON streaming reader, the duration arithmetic, error mapping.
2. `lib/tools.js` — `status`, `run`, `bench`, `models`, `embed`, with the caps.
3. `checks/` — the fake daemon and the live half.
4. `skills/` — the three skills, then wire their examples into the check.
5. Row, manifest, installer rows, README/ARCHITECTURE, and a root README row.
