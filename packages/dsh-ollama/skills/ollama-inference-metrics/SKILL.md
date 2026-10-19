---
name: ollama-inference-metrics
description: What every Ollama timing field means and the arithmetic that turns it into a claim - tokens per second, time-to-first-token, why total_duration is not latency, why a second run is faster, what changes with context length, quantization, GPU offload and parallel requests - plus the reporting rules that make a benchmark a measurement instead of an anecdote.
whenToUse: Use when reporting how fast a model is, when comparing two models or two settings, when a benchmark's numbers look surprising or unstable, when writing a bench script, or before quoting any tok/s figure to a person.
---

# Inference metrics

A tok/s number without its conditions is not a measurement; it is a sentence
about one moment. This skill is the arithmetic and the reporting contract.

## The fields, and what each one covers

Every field below comes from the daemon's final response object, in
NANOSECONDS. Nothing has to be inferred:

| field | unit | covers |
|---|---|---|
| `load_duration` | ns | loading the weights into memory. **0 when they were already resident.** |
| `prompt_eval_count` | tokens | the prompt, tokenized |
| `prompt_eval_duration` | ns | evaluating the prompt |
| `eval_count` | tokens | tokens generated |
| `eval_duration` | ns | generating them |
| `total_duration` | ns | the daemon's whole span for the request |

The two rates a reader cares about are divisions of those pairs:

    tok/s        = eval_count        / (eval_duration        / 1e9)
    prompt tok/s = prompt_eval_count / (prompt_eval_duration / 1e9)

and time-to-first-token is the wait before the first generated token:

    TTFT = load_duration + prompt_eval_duration

with one caveat that matters: that formula is the daemon's account. A client
that streams can measure the real first token, and the difference between the
two is the transport plus the queue - which is why `ollama_run` reports both.

```javascript
/** The arithmetic, in one place, with the nulls an absent field deserves. */
export function measure(final) {
  const ns = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const rate = (count, duration) => (ns(count) === null || ns(duration) === null || duration <= 0 ? null : count / (duration / 1e9))
  const loadMs = ns(final.load_duration) === null ? null : final.load_duration / 1e6
  const promptMs = ns(final.prompt_eval_duration) === null ? null : final.prompt_eval_duration / 1e6
  return {
    evalCount: ns(final.eval_count),
    evalTokensPerSecond: rate(final.eval_count, final.eval_duration),
    promptTokensPerSecond: rate(final.prompt_eval_count, final.prompt_eval_duration),
    evalMs: ns(final.eval_duration) === null ? null : final.eval_duration / 1e6,
    loadMs,
    promptEvalMs: promptMs,
    ttftMs: loadMs === null && promptMs === null ? null : (loadMs ?? 0) + (promptMs ?? 0),
    totalMs: ns(final.total_duration) === null ? null : final.total_duration / 1e6,
    cut: final.done_reason === 'length',
  }
}
```

A zero duration yields `null`, not `Infinity`: the daemon did not measure a
phase it reported as zero, and an infinite tok/s is not a fast model.

## A worked example

Given a final object:

```json
{"done":true,"done_reason":"stop","eval_count":100,"eval_duration":2000000000,"prompt_eval_count":20,"prompt_eval_duration":200000000,"load_duration":1000000000,"total_duration":3500000000}
```

- tok/s = 100 / 2.0 s = **50.0**
- prompt tok/s = 20 / 0.2 s = **100.0**
- load = **1.00 s**, prompt eval = **0.20 s**, eval = **2.00 s**
- TTFT = 1.00 + 0.20 = **1.20 s**
- `total_duration` = **3.50 s**, which is 1.00 + 0.20 + 2.00 plus 0.30 s of
  load/setup the four fields do not name.

Those numbers are exactly what the fake daemon in `packages/dsh-ollama/checks`
serves, so the plugin's own arithmetic is asserted against them.

## `total_duration` is not latency

Three different spans get called "the time":

1. **server span** = `total_duration` - what the daemon spent, including setup;
2. **model span** = `load_duration + prompt_eval_duration + eval_duration` -
   the sum of the named phases;
3. **wall clock** - what the caller waited, including connection, queueing,
   serialization and the transport.

`total_duration` is (1), and it is NEITHER of the other two. A benchmark that
quotients `eval_count` by `total_duration` reports a rate a third lower than the
real one, because it charges the load and the prompt to the generation. Report
(1) as "daemon total", (3) as "wall", and compute tok/s only from the eval pair.

## Cold and warm: what actually changes

The first call that names a model pays `load_duration`; later calls with the
weights resident pay ~0. What that changes:

| | cold (first call) | warm (resident) |
|---|---|---|
| `load_duration` | seconds | ~0 |
| TTFT | higher by the load | lower |
| wall clock | higher by the load | lower |
| **tok/s** | **the same** | **the same** |
| `eval_duration` | generation only | generation only |

This is the trap in "the second run was 2.4x faster": the run is faster to
START, not faster per token. `eval_duration` never includes the load, so a cold
run's tok/s is not penalised. If a report says tok/s improved 2.4x on a second
run, it is measuring something else (a different `num_ctx`, a different prompt,
a cache that was cold, or parallelism).

To measure a cold run honestly, unload first:

    POST /api/generate  {"model": "<tag>", "keep_alive": 0}

then run. Without that unload, "run 1" is warm and the load number is a lie.

## What changes the numbers, and by roughly how much

- **Context length (`num_ctx`)** - the KV cache grows linearly with it. A larger
  context costs memory and, at long prompts, attention time. It is the single
  biggest knob after the model itself, and it is why a number without a stated
  context is not comparable to another number.
- **Prompt length** - prompt eval is quadratic-ish in tokens for attention, so a
  16k-token prompt has a much higher `prompt_eval_duration` than a 200-token
  one, and TTFT scales with it.
- **Quantization** - Q4_K_M is smaller and faster than Q8_0 or F16, at some
  quality cost. Comparing a Q4 to an F16 is a comparison of two artifacts, so
  the digest (which encodes the layers) must accompany the number.
- **GPU offload (`num_gpu`, `size_vram / size`)** - a partial offload moves the
  slowest layers to the CPU and the tok/s drops non-linearly. Report the
  offload share from `/api/ps`, not just "GPU".
- **Parallel requests (`OLLAMA_NUM_PARALLEL`)** - one model serving N requests
  splits its capacity; each reports a lower tok/s while total throughput may
  rise. A benchmark run with parallelism enabled is not a single-stream number.
- **Model size and architecture** - the obvious one; the reason A/B needs the
  same prompt, context and options.
- **Thermal state and background load** - real, and why a spread is reported
  rather than a single figure.

## The reporting rules

A number is honest when a reader could reproduce it. That means all of:

1. **At least 5 runs** for a number you will quote. 3 is the floor for a quick
   look; 5 is a sample; 1 is an anecdote. State the count.
2. **A median, not a mean**, and the spread beside it (relative standard
   deviation, or min-max). A mean is dominated by one slow run.
3. **p95 with the sample size** - with 5 runs p95 IS the max, and saying so is
   more honest than implying a tail you did not measure.
4. **One variable at a time.** Two models at the same prompt/context/options,
   or one model at two contexts - never both at once.
5. **Temperature 0 and a fixed seed** when the comparison is about speed; a
   sampled answer changes `eval_count` and pollutes the rate.
6. **The model digest**, not just the tag: `qwen2.5:7b` can be re-pulled as a
   different set of layers.
7. **The context length** (`num_ctx`) and whether the model was resident
   (`load_duration` ~ 0 or not).
8. **The hardware and the offload share** - the same model on a CPU and on a
   GPU are different numbers, and both are true.
9. **The prompt**, or at least its token count: `prompt_eval_count` is in the
   answer, so quote it.
10. **What was measured**: single-stream, no concurrent requests, unless stated.

A headline that obeys the rules looks like this:

> `qwen2.5:7b` (digest a3de86cd1c13), 5 runs, 8k context, Q4_K_M, temperature 0,
> seed 42, 100% GPU: **41.2 tok/s median** (spread 6%), TTFT 0.41 s median,
> cold load 3.1 s. Single stream, no parallel requests.

A headline that breaks them looks like this:

> Ollama is fast - 40 tok/s.

It is missing the model, the digest, the context, the run count, the spread,
the hardware and the definition of "fast"; and 40 could be any of the numbers
above.

## Reading a `dsh-ollama` bench

`ollama_bench` prints one section per model (and per context, in a sweep):

    RUN   TOK/S   TTFT      LOAD      EVAL      TOKENS   WALL
    1     50.0    1.20 s    1.00 s    2.00 s    100      3.61 s
    2     40.0    0.20 s    0.00 s    2.50 s    100      2.71 s
    ...
    tok/s   median 50.0 · p95 100.0 · min 33.3 · max 100.0 · spread 41%
    TTFT    median 0.20 s · p95 1.20 s
    wall    median 2.71 s · p95 3.61 s
    first run 3.61 s wall · 1.20 s TTFT; warm runs 2-5 median 2.71 s wall · 1.33x the warm median
    note: tok/s is eval_count / eval_duration - the generation phase only - so a
          cold load raises TTFT and wall, never tok/s.

Read it in this order: the digest and context (is this the artifact I meant?),
the run count (is this a sample?), the median and spread (is it stable?), then
the per-run table (was one run an outlier, and does `load_duration` explain
it?). The cold/warm line is in wall and TTFT on purpose.

## Claims a single run cannot support

| claim | why one run cannot carry it |
|---|---|
| "this model is faster than that one" | no second sample, no spread, possibly a different prompt |
| "it is 2x faster on the second run" | that is the load, not the rate |
| "it does 40 tok/s" | at what context, on what hardware, at which quantization? |
| "it fits in 8 GB" | memory is a property of the loaded artifact + context, read `/api/ps` |
| "this is the model's speed" | it is one prompt's speed, on one machine, at one moment |

The correction is always the same: more runs, one variable, and the conditions
beside the number.
