---
name: ollama-python
description: The `ollama` Python package used properly - chat and generate with streaming, embeddings, tool calling, structured outputs with a JSON Schema, the async client, keep_alive, timeouts and cancellation - and a project shape whose benchmark arithmetic is unit-tested against a fake transport while the live half skips loudly when no daemon answers.
whenToUse: Use when writing a Python program, script or service that talks to Ollama, when a Python benchmark has to be trustworthy, when tool calling or structured output is wanted from Python, or when deciding how to test code that needs a model.
---

# Ollama from Python

`pip install ollama` is the official client: a thin wrapper over the REST API in
this pack's `ollama-api` skill, with pydantic response models. It ships a sync
`Client`, an `AsyncClient`, and module-level helpers that use a default client.

Every example below is self-contained: it reads `OLLAMA_HOST` itself, so it can
be copied out of this page on its own.

## Connect without hardcoding a host

The daemon is on `127.0.0.1:11434` by default, but a person may have moved it.
Read the environment, do not bake the address into the code:

```python
import os

from ollama import Client

HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
client = Client(host=HOST)
print(client.list().models)
```

`OLLAMA_HOST` may arrive as `host:port` without a scheme, because the daemon
accepts that spelling for its BIND address. Normalise it before a client uses
it, or an error message will read `host:port` and look like a hostname:

```python
import os


def daemon_url() -> str:
    raw = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434").strip()
    if "://" not in raw:
        raw = "http://" + raw
    return raw.rstrip("/")
```

## One prompt, one conversation

```python
import os

from ollama import Client

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))

# generate: one string in, text and timings out
answer = client.generate(model="qwen2.5:7b", prompt="Why is the sky blue?", options={"num_predict": 128})
print(answer.response)
print(answer.eval_count, answer.eval_duration)  # tokens, NANOSECONDS

# chat: messages in, the same timings out
chat = client.chat(
    model="qwen2.5:7b",
    messages=[
        {"role": "system", "content": "Answer in one sentence."},
        {"role": "user", "content": "Why is the sky blue?"},
    ],
    options={"temperature": 0, "seed": 42},
)
print(chat.message.content)
```

Every response model carries the same metric fields as the API:
`eval_count`, `eval_duration`, `prompt_eval_count`, `prompt_eval_duration`,
`load_duration`, `total_duration` and `done_reason`. They are the daemon's
numbers, in nanoseconds; the arithmetic in the `ollama-inference-metrics` skill
applies unchanged.

## Streaming

With `stream=True` the call returns a generator of partial responses. Each part
has `.message.content` (chat) or `.response` (generate); only the FINAL part
carries the counts and durations:

```python
import os

from ollama import Client

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))

stream = client.chat(
    model="qwen2.5:7b",
    messages=[{"role": "user", "content": "Write one paragraph about the sea."}],
    stream=True,
)
text = ""
final = None
try:
    for part in stream:
        text += part.message.content
        if part.done:
            final = part
finally:
    stream.close()
print(text)
if final is None:
    raise RuntimeError("the stream ended without a done part")
print(final.eval_count / (final.eval_duration / 1e9), "tok/s")
```

Two habits worth keeping:

- **close the generator.** Breaking out of a `for` over `stream` leaves the HTTP
  response open until garbage collection; `stream.close()` in a `finally` is
  what tells the daemon to stop generating into a socket nobody reads;
- **a stream is not a retryable unit.** If the connection drops mid-stream you
  have partial text and no timings; treat that as a failed measurement, not as
  an answer.

## Embeddings

```python
import os

from ollama import Client

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
response = client.embed(model="nomic-embed-text", input=["the cat sat", "a cat was sitting"])
first, second = response.embeddings
print(len(first), "dimensions")

dot = sum(a * b for a, b in zip(first, second))
norm = (sum(a * a for a in first) ** 0.5) * (sum(b * b for b in second) ** 0.5)
print("cosine", dot / norm)
```

`client.embed` uses `/api/embed` (many inputs, one request). The older
`client.embeddings(model=..., prompt=...)` is the single-prompt form. Check the
model's capability first - a completion model refuses, and the client raises:

```python
import os

from ollama import Client, ResponseError

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
try:
    client.embed(model="qwen2.5:7b", input="hello")
except ResponseError as error:
    print(error.status_code, error.error)
    # -> the model is not an embedding model; pull nomic-embed-text
```

## Tool calling

Pass `tools` as JSON-Schema function definitions. The model answers with
`message.tool_calls` and no content; run the function and append a `tool`
message. This is a loop, and it must be bounded:

```python
import os

from ollama import Client

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))


def get_weather(city: str) -> str:
    return f"18 C and clear in {city}"


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]

messages = [{"role": "user", "content": "What is the weather in Lisbon?"}]
for _ in range(4):  # bound the loop: a model can call a tool forever
    response = client.chat(model="qwen2.5:7b", messages=messages, tools=TOOLS)
    messages.append(response.message)
    if not response.message.tool_calls:
        print(response.message.content)
        break
    for call in response.message.tool_calls:
        result = get_weather(**call.function.arguments)
        messages.append({"role": "tool", "content": result, "tool_name": call.function.name})
else:
    raise RuntimeError("the model kept calling tools; stop and inspect the conversation")
```

## Structured output

`format="json"` asks for JSON; a JSON Schema asks for a shape. With pydantic the
schema comes from the model itself:

```python
import os

from ollama import Client
from pydantic import BaseModel


class Person(BaseModel):
    name: str
    age: int


client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
response = client.chat(
    model="qwen2.5:7b",
    messages=[{"role": "user", "content": "Give me one fictional person."}],
    format=Person.model_json_schema(),
    options={"temperature": 0},
)
person = Person.model_validate_json(response.message.content)
print(person.name, person.age)
```

The schema is a strong request, not a guarantee: `model_validate_json` is what
turns "the model probably obeyed" into an exception you can handle.

## Async, timeouts and cancellation

```python
import asyncio
import os

from ollama import AsyncClient

HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")


async def ask(question: str) -> str:
    async with AsyncClient(host=HOST, timeout=120.0) as client:
        response = await client.chat(
            model="qwen2.5:7b",
            messages=[{"role": "user", "content": question}],
            options={"num_predict": 256},
        )
        return response.message.content


async def main() -> None:
    try:
        print(await asyncio.wait_for(ask("hi"), timeout=60))
    except asyncio.TimeoutError:
        print("cancelled; the daemon drops the request when the socket closes")


asyncio.run(main())
```

Three rules:

- **a timeout is a cancellation, not a kill.** The client closes the response;
  the daemon notices the closed socket and stops. That is not instant, and a
  long `num_predict` can keep a GPU busy for a moment after you left;
- **`timeout=` on the client** bounds connect AND read; pass a value larger than
  the slowest cold load you accept, or set it per call;
- **do not share one `AsyncClient` across an event-loop boundary.** Create it in
  the loop that uses it (`async with` is the simplest way to get that right).

## `keep_alive` and residency

`keep_alive` is a keyword argument on every generation call: a duration string,
`0` to unload when the call ends, or `-1` to keep the weights forever.

```python
import os

from ollama import Client

client = Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
client.generate(model="qwen2.5:7b", prompt="warm up", keep_alive="10m", options={"num_predict": 1})
# ... many calls reuse the resident weights ...
client.generate(model="qwen2.5:7b", keep_alive=0, options={"num_predict": 0})
```

The last call is the unload (`num_predict: 0` keeps it from generating, so the
warm-up and the unload each cost one prompt pass rather than an answer). Without
it, a "cold" measurement is not cold.

## A project shape that can be tested

A benchmark needs arithmetic you can test without a model, and a live half that
skips when no daemon answers. That is four small files:

```
pyproject.toml
src/ollama_lab/__init__.py
src/ollama_lab/client.py
src/ollama_lab/bench.py
tests/test_bench.py
tests/test_live.py
```

```toml
[project]
name = "ollama-lab"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["ollama>=0.4"]

[project.optional-dependencies]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
markers = ["live: needs a running Ollama daemon and a pulled model"]
```

`client.py` owns the transport seam, so the benchmark is testable:

```python
"""A small layer over the daemon: metrics, and a transport you can fake."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol


def daemon_url() -> str:
    raw = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434").strip()
    if "://" not in raw:
        raw = "http://" + raw
    return raw.rstrip("/")


class Transport(Protocol):
    def post(self, path: str, payload: dict[str, Any], *, timeout: float) -> dict[str, Any]: ...


class HttpTransport:
    def __init__(self, host: str | None = None, timeout: float = 120.0) -> None:
        self.host = (host or daemon_url()).rstrip("/")
        self.timeout = timeout

    def post(self, path: str, payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        request = urllib.request.Request(
            self.host + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {error.code} from {path}: {detail}") from error


@dataclass(frozen=True)
class Metrics:
    eval_count: int | None
    eval_duration_ns: int | None
    prompt_eval_count: int | None
    prompt_eval_duration_ns: int | None
    load_duration_ns: int | None
    total_duration_ns: int | None
    done_reason: str

    @classmethod
    def from_response(cls, body: dict[str, Any]) -> "Metrics":
        return cls(
            eval_count=body.get("eval_count"),
            eval_duration_ns=body.get("eval_duration"),
            prompt_eval_count=body.get("prompt_eval_count"),
            prompt_eval_duration_ns=body.get("prompt_eval_duration"),
            load_duration_ns=body.get("load_duration"),
            total_duration_ns=body.get("total_duration"),
            done_reason=str(body.get("done_reason", "")),
        )

    @property
    def tokens_per_second(self) -> float | None:
        if not self.eval_count or not self.eval_duration_ns:
            return None
        return self.eval_count / (self.eval_duration_ns / 1e9)

    @property
    def seconds_to_first_token(self) -> float | None:
        if self.load_duration_ns is None and self.prompt_eval_duration_ns is None:
            return None
        return ((self.load_duration_ns or 0) + (self.prompt_eval_duration_ns or 0)) / 1e9


class OllamaClient:
    """generate() over a Transport; stream=False keeps the measurement whole."""

    def __init__(self, transport: Transport | None = None) -> None:
        self.transport = transport or HttpTransport()

    def generate(self, model: str, prompt: str, **options: Any) -> tuple[str, Metrics]:
        body = self.transport.post(
            "/api/generate",
            {"model": model, "prompt": prompt, "stream": False, "options": options},
            timeout=300.0,
        )
        return str(body.get("response", "")), Metrics.from_response(body)
```

`bench.py` holds the statistics:

```python
"""Median, p95 and spread: the only summary a small sample can carry."""
from __future__ import annotations

import math
import statistics

from .client import Metrics, OllamaClient


def nearest_rank(values: list[float], pct: float) -> float | None:
    """The smallest value at or above the rank - p95 of 5 is one of the 5."""
    ordered = sorted(v for v in values if math.isfinite(v))
    if not ordered:
        return None
    rank = math.ceil((pct / 100) * len(ordered))
    return ordered[max(0, min(len(ordered) - 1, rank - 1))]


def summarize(values: list[float]) -> dict[str, float | int | None]:
    sample = [v for v in values if math.isfinite(v)]
    if not sample:
        return {"count": 0, "median": None, "p95": None, "spread": None}
    mean = statistics.fmean(sample)
    stdev = statistics.pstdev(sample) if len(sample) > 1 else 0.0
    return {
        "count": len(sample),
        "median": statistics.median(sample),
        "p95": nearest_rank(sample, 95),
        "spread": (stdev / mean) if mean else None,
    }


def bench(model: str, prompt: str, runs: int = 5, client: OllamaClient | None = None) -> dict:
    """runs measured calls after an unload, so run 1 is genuinely cold."""
    if runs < 3:
        raise ValueError("a benchmark needs at least 3 runs; one run is not a measurement")
    client = client or OllamaClient()
    client.transport.post("/api/generate", {"model": model, "keep_alive": 0}, timeout=30.0)
    measured: list[Metrics] = []
    for _ in range(runs):
        _text, metrics = client.generate(model, prompt, num_predict=128, temperature=0, seed=42)
        if metrics.done_reason == "length":
            raise RuntimeError("the answer was cut by num_predict; raise it for a benchmark")
        if metrics.tokens_per_second is None:
            raise RuntimeError("the daemon reported no eval_duration; the rate is unknown")
        measured.append(metrics)
    return {
        "model": model,
        "runs": runs,
        "tokens_per_second": summarize([m.tokens_per_second or 0.0 for m in measured]),
        "seconds_to_first_token": summarize([m.seconds_to_first_token or 0.0 for m in measured]),
        "cold_load_ns": measured[0].load_duration_ns,
    }
```

`tests/test_bench.py` proves the arithmetic without a model: a fake transport
returns canned bodies with fixed nanosecond durations, so 100 tokens in 2 s is
exactly 50 tok/s.

```python
"""The arithmetic, against a fake transport - no daemon, no model, no GPU."""
from __future__ import annotations

import pytest

from ollama_lab.bench import bench, nearest_rank, summarize
from ollama_lab.client import Metrics, OllamaClient


class FakeTransport:
    def __init__(self, responses: list[dict]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    def post(self, path: str, payload: dict, *, timeout: float) -> dict:
        self.calls.append((path, payload))
        return self.responses.pop(0)


def body(eval_duration: int, load_duration: int = 0) -> dict:
    return {
        "response": "ok",
        "done": True,
        "done_reason": "stop",
        "eval_count": 100,
        "eval_duration": eval_duration,
        "prompt_eval_count": 20,
        "prompt_eval_duration": 200_000_000,
        "load_duration": load_duration,
        "total_duration": eval_duration + 200_000_000 + load_duration,
    }


def test_rate_is_the_eval_pair() -> None:
    metrics = Metrics.from_response(body(2_000_000_000))
    assert metrics.tokens_per_second == 50
    assert metrics.seconds_to_first_token == pytest.approx(0.2)


def test_a_zero_duration_is_unknown_not_infinite() -> None:
    metrics = Metrics.from_response({**body(0), "eval_count": 0})
    assert metrics.tokens_per_second is None


def test_p95_is_a_real_run() -> None:
    assert nearest_rank([50, 40, 66.7, 33.3, 100], 95) == 100
    assert nearest_rank([], 95) is None
    assert summarize([7])["spread"] == 0


def test_bench_unloads_then_measures() -> None:
    transport = FakeTransport([{"done": True}] + [body(2_000_000_000 + index) for index in range(3)])
    result = bench("test:1b", "bench", runs=3, client=OllamaClient(transport))
    assert transport.calls[0][1]["keep_alive"] == 0
    assert result["runs"] == 3
    assert result["tokens_per_second"]["median"] == pytest.approx(50)


def test_a_short_sample_is_refused() -> None:
    with pytest.raises(ValueError):
        bench("test:1b", "bench", runs=2)
```

`tests/test_live.py` is the half that needs a machine: it skips unless a daemon
answers AND a completion model is pulled, and says which condition failed.

```python
"""The live half: skipped loudly when there is no daemon or no model."""
from __future__ import annotations

import json
import urllib.request

import pytest

from ollama_lab.client import daemon_url


def daemon_version() -> str | None:
    try:
        with urllib.request.urlopen(daemon_url() + "/api/version", timeout=1.5) as response:
            return json.loads(response.read().decode("utf-8")).get("version")
    except Exception:
        return None


def smallest_model() -> str | None:
    try:
        with urllib.request.urlopen(daemon_url() + "/api/tags", timeout=2.0) as response:
            models = json.loads(response.read().decode("utf-8")).get("models", [])
    except Exception:
        return None
    candidates = [m for m in models if "embed" not in str(m.get("name", ""))]
    if not candidates:
        return None
    return sorted(candidates, key=lambda m: m.get("size", 0))[0]["name"]


VERSION = daemon_version()
MODEL = smallest_model() if VERSION is not None else None

pytestmark = pytest.mark.skipif(
    VERSION is None or MODEL is None,
    reason=f"no live Ollama (version={VERSION}, model={MODEL}); start one with `ollama serve` and pull a model",
)


def test_one_tiny_generation() -> None:
    from ollama_lab.client import OllamaClient

    text, metrics = OllamaClient().generate(MODEL, "Reply with the single word: ok", num_predict=8, temperature=0)
    assert text.strip() != ""
    assert metrics.eval_count is not None and metrics.eval_count >= 0
```

Run `pytest -m "not live"` in CI and `pytest -m live` on a machine with the
daemon. The rule the fake transport encodes is the important one: **the half
that needs a model is never the half that proves your arithmetic.**

## Pitfalls, in the order they bite

1. **Quoting `eval_duration` as milliseconds.** It is nanoseconds; 2e9 is 2 s.
2. **Treating `client.chat(stream=True)` as a string.** It is a generator of
   parts, and only the last part has the timings.
3. **Assuming `OLLAMA_HOST` is a connect address.** The daemon may bind
   `0.0.0.0`; a client should use `127.0.0.1`.
4. **Benchmarking without an unload.** Run 1 is then warm, and `load_duration`
   is 0 for every run - the cold number you meant to report does not exist.
5. **Comparing two models with `temperature` at its default.** Sampling changes
   `eval_count`; fix `temperature=0` and `seed`.
6. **Trusting a `format=` schema blindly.** Validate the JSON; a model can still
   return a shape that parses but does not match.
7. **Letting a tool loop run unbounded.** Cap the iterations and inspect the
   conversation when the cap is hit.
