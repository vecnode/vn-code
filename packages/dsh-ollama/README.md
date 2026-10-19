# dsh-ollama (alpha.1)

**Ollama as a measured surface.** Five tools over the machine's own daemon -
`ollama_status`, `ollama_run`, `ollama_bench`, `ollama_models`, `ollama_embed` -
that report what a model actually did here: how many tokens, how fast, after how
long a load, with which digest and at which context. Plus the three skills that
teach the REST API, the metric arithmetic and the Python client.

Why it earns a row: every other surface in this pack can **call** a model. None
can tell a reader that `qwen2.5:7b` did 41.2 tok/s on this machine at 8k
context with a 3.1 s cold load, and that the second run's *first token* arrived
sooner while its tok/s did not move at all. Ollama reports exactly those fields
in every response - `eval_count`, `eval_duration`, `load_duration`,
`prompt_eval_duration`, `total_duration` - and nothing in the pack read them.

Measured on the machine that wrote this: `ollama --version` is **0.40.3**, and
the daemon was **not running** - which is the normal state and the first thing
the plugin has to say honestly. `ollama_status` says so, names the address it
tried, and names the command that starts one; it never starts one itself.

## What it adds

- **`ollama_status`** - the daemon's version and reachability, every model on
  disk (family, parameter size, quantization, bytes, digest), and what is
  **loaded right now** (`/api/ps`: context length, `size_vram` as an offload
  share, `expires_at`). A daemon that is down is an *answer*: the address it
  tried, the CLI version if `ollama` is on PATH, and `ollama serve`. Read-only.
- **`ollama_run`** - ONE bounded inference, from `prompt` (`/api/generate`) or
  `messages` (`/api/chat`). It streams so the **first token is timed**, and it
  returns the text plus prompt/eval token counts, tok/s from
  `eval_count / eval_duration`, the load time, the daemon's total, the wall
  clock and the `done_reason`. `num_predict` is always sent (512 by default,
  ceiling 8192) because Ollama's own default would generate until the context
  filled. A `done_reason: "length"` answer says it was cut.
- **`ollama_bench`** - the only tool here that calls a number a **measurement**.
  3+ runs (2 is refused by name), temperature 0 and seed 42 unless you say
  otherwise, one model or an A/B of up to three, an optional `num_ctx` sweep,
  and a report of per-run values plus median, p95, min/max and relative spread
  for tok/s, TTFT and wall. `cold: true` (the default) unloads the model with
  `keep_alive: 0` first, so run 1 really pays the load - and the cold/warm
  sentence is stated at the **first token**, because `eval_duration` covers
  generation only and a cold load never lowers tok/s.
- **`ollama_models`** - `list` and `show` (parameters, template, license,
  capabilities, architecture facts by suffix, so `qwen2.context_length` and
  `nomic-bert.embedding_length` both resolve), and the two **writes** behind a
  confirmation that repeats the tag: `pull` and `delete`. Without `confirm` the
  answer is what it WOULD do - the size on disk or the size to download, and
  the exact command - and nothing is fetched or removed.
- **`ollama_embed`** - `/api/embed` with a multiple-input form, falling back to
  the older `/api/embeddings` on a daemon that lacks it. Reports the dimension,
  each vector's norm and a cosine similarity when two inputs make one
  meaningful. A completion model is refused **by capability**, not by failing
  later.

## The two rules it is engineering against

**A refusal is an answer.** No daemon → one sentence naming the address and
`ollama serve`. No model → the tag wanted, the tags that exist, and the exact
`ollama pull`. Model that cannot embed → its capabilities and the usual
alternative. A `num_predict` over the cap is refused, not clamped. An option
name that is a typo is refused, because Ollama **silently ignores** unknown
options and the numbers would then be a claim about a setting nobody applied.

**Loopback only, by default.** The tools talk to `127.0.0.1:11434`; an
`OLLAMA_HOST` naming another machine is refused before any request is made,
with the one variable that allows it: `DSH_OLLAMA_ALLOW_REMOTE=1`. A daemon on
another box is a real setup, but it is a decision a person makes once, not a
default an agent inherits. (`OLLAMA_HOST=0.0.0.0:11434` is accepted - it is a
local bind address, and it cannot reach another machine.)

## The three skills

Each ships as `skills/<name>/SKILL.md` and is registered at boot, with its
examples checked:

- **`ollama-api`** - the REST surface as it is here: `/api/generate`, `/api/chat`
  (streaming NDJSON, `done: true` last), `/api/embed` vs `/api/embeddings`,
  `/api/tags`, `/api/ps`, `/api/show`, pull progress, create/copy/delete, the
  OpenAI-compatible `/v1` endpoints (and the two ways they differ: no timings,
  SSE not NDJSON), the `options` map, `keep_alive`, error shapes, the CLI
  equivalents, and `OLLAMA_HOST` / `OLLAMA_NUM_PARALLEL` /
  `OLLAMA_MAX_LOADED_MODELS` / `OLLAMA_KEEP_ALIVE`.
- **`ollama-inference-metrics`** - what each duration covers, the tok/s and
  TTFT arithmetic, why `total_duration` is neither the model span nor the
  latency, why a second run is faster to START, what changes with context,
  quantization, offload and parallelism, and the reporting rules (5+ runs, a
  median with a spread, one variable at a time, a fixed seed, the digest and
  the context in the answer).
- **`ollama-python`** - the `ollama` package: `chat()`, `generate()`,
  streaming and closing a generator, `embed`, tool calling with a bounded loop,
  structured output from a pydantic schema, the async client, `keep_alive`,
  timeouts and cancellation - and a project shape whose benchmark arithmetic is
  unit-tested against a **fake transport** while the live half skips loudly
  when no daemon answers.

## How it plugs in

| Piece | Value |
|---|---|
| row / tools | `ollama` / `ollama_status`, `ollama_run`, `ollama_bench`, `ollama_models`, `ollama_embed` |
| host | one row, no route, no browser half (`package.json` declares no `dsh.client`) |
| transport | `globalThis.fetch` to `http://127.0.0.1:11434`, per-request `AbortSignal` deadline, response bodies capped (2 MiB JSON, 16 MiB stream, 500k stream items) |
| process | exactly one: `ollama --version` for the CLI line, argv-only, 4 s, no shell |
| state | none on disk; a 2-second in-memory model-list cache so one answer is one request |
| skills | three, registered at boot and copied into `$DSH_HOME/skills` by both installers |
| credentials | none: no key, no token, no URL with a password (a credentialed `OLLAMA_HOST` is refused) |

## Limits

| | |
|---|---|
| daemon | it must already be running; this row starts nothing and says how |
| models | `pull` downloads gigabytes and needs `confirm`; `create`, `copy` and `push` are documented in the API skill but are not tools |
| remote | refused unless `DSH_OLLAMA_ALLOW_REMOTE=1`, and then every timing includes the network |
| measurement | one process, one machine: no VRAM probing beyond `/api/ps`, no GPU driver reading, no thermal control |
| UI | none - this is a tool surface plus skills, not a second conversation |
| `num_predict` | never `-1`: one inference is bounded by the schema and by a timeout |

## Verify

```sh
node checks/check-ollama-node.mjs                           # the whole contract against a fake daemon, plus the skill examples
DSH_OLLAMA_CHECK_LIVE=0 node checks/check-ollama-node.mjs   # the pure half only
```

The fake daemon (`node:http` on `127.0.0.1:0`) answers the real routes with
canned bodies and **fixed nanosecond durations**, so the arithmetic is
assertions rather than observations: 100 tokens in 2 s is exactly 50.0 tok/s,
and TTFT derived is exactly 1.20 s. It also pins every refusal (a 404 that
names a model vs a 404 that names a route, an over-cap `num_predict`, an
unconfirmed pull, a delete, both prompt and messages, a typo'd option), and the
loopback fence by counting fetches - an off-machine host must make **zero**
requests.

The skill examples are checked, not just written: every fenced `curl` line is
tokenized into a request (loopback URL, a real endpoint, a JSON body that
parses), every Python block is parsed by python's own `ast` when a Python is on
PATH, every JavaScript block is checked by `node --check`, and every JSON block
is parsed. The check also asserts that every endpoint the row calls appears in
the skills, so a feature cannot ship undocumented.

The live half runs one tiny generation - and with a model present a 3-run bench
- only when a daemon answers here, and otherwise **skips with the reason**.

The pack-wide checks still own the row: `check-node-routes.mjs` (the row, the
manifest, the skill registration), `check-no-secrets.mjs`, and the root
README/ARCHITECTURE rows.

## Install

Both installers pick it up from `packages/`; as a new bundle the profile learns
it once, then a restart of `npx @deepseek-ai/dsh web` and a hard refresh.
