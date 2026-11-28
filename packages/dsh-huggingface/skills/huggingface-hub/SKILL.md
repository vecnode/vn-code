---
name: huggingface-hub
description: The Hugging Face Hub as this machine's own `hf` CLI presents it - the v1 command set and what the deprecated `huggingface-cli` name still does, repo ids and the three repo types, revisions vs branches vs commits, `hf://` paths, the `--format json` contract and where it speaks in human strings, gated and private repos, authentication that never passes a token through a transcript, the environment variables that move the cache and turn the network off, and the raw Hub API endpoints for anything the CLI does not cover.
whenToUse: Use before downloading, inspecting or citing a Hub repo; when choosing between `hf` verbs; when a repo is gated, private or 404; when the JSON from the CLI is not the shape you expected; or when a script needs the Hub API directly rather than a shell call.
---

# The Hugging Face Hub from the command line

The Hub is a git-backed file store with a JSON API in front of it. This install
has `hf` **1.26.1** (huggingface_hub), where `hf` is the command and
`huggingface-cli` is a deprecated alias for the same entry point.

## The CLI, in the order worth knowing

```bash
hf --version
hf env
```

`hf env` prints the resolved cache paths, tokens' *presence*, and the library
versions - the fastest way to answer "which cache is this machine actually
using". `--version` writes the version to **stdout** and an upgrade hint to
**stderr**; a parser that reads stderr first reports the version that is *not*
installed.

| Verb | What it is for |
|---|---|
| `hf download <repo> [files]` | fetch into the cache (or `--local-dir`) |
| `hf models list / info / card` | search, metadata, README |
| `hf datasets list / info / parquet / sql` | the same for datasets, plus DuckDB over parquet |
| `hf spaces list / info / logs / restart` | Spaces, including their runtime logs |
| `hf cache ls / verify / prune / rm` | the local cache as a first-class object |
| `hf auth whoami / login / logout` | who the token belongs to |
| `hf repos create / delete` | repo lifecycle |
| `hf upload` | push files |
| `hf jobs`, `hf sandbox`, `hf endpoints` | remote compute; not a local concern |

`hf <verb> --help` exits **non-zero** on this build (measured: -1). An exit code
is not a success signal for a help call, and no automation should infer anything
from it.

## Repo ids and the three types

An id is exactly `org/name` - one slash, no nesting, no local path:

```bash
hf models info sentence-transformers/all-mpnet-base-v2 --format json
hf datasets info HuggingFaceFW/fineweb --format json
hf spaces info gradio/hello-world --format json
```

The type is **not** in the id. `org/name` is a model, a dataset and a space all
at once depending on the verb you call, which is why every command that takes a
non-model repo also takes `--type` (or `--repo-type`):

```bash
hf download HuggingFaceFW/fineweb --type dataset --include "sample/*"
hf cache verify karpathy/fineweb-edu-100b-shuffle --repo-type dataset
```

A bare `org/name` with no `--type` means **model**. That default is the most
common wrong answer: a dataset downloaded as a model lands in
`models--HuggingFaceFW--fineweb` and no loader finds it.

## The JSON contract - and its two lies

Every verb takes `--format json` (or `--json`). Three things about it are
measured on this install and are easy to get wrong:

1. **Sizes are human strings, not bytes.** `hf cache ls --json` answers
   `"size": "17.9G"`, not a number. Anything that has to do arithmetic - a
   budget, a delta, a comparison - reads the directory tree instead.
2. **Times are relative.** `"last_accessed": "3 months ago"`. Fine to print,
   useless to sort on.
3. **`--expand` decides the fields.** `hf models info` returns a small default
   object; ask for what you need or parse a shape you do not have:

```bash
hf models info Qwen/Qwen2.5-3B-Instruct --expand gated,cardData,siblings,safetensors,sha,downloads --format json
```

`siblings` is the file list, and each entry carries at least `rfilename`. On this
CLI line (1.26.1) that is **all** it carries - there is no `--blobs` flag and no
per-file size, which is why `hf models info --expand usedStorage` exists: it
answers a single `used_storage` in bytes for the whole repo. The raw API is the
place that reports per-file sizes (`?blobs=true`, below).

```json
{
  "id": "sentence-transformers/all-mpnet-base-v2",
  "sha": "e8c3b32edf5434bc2275fc9bab85f82640a19130",
  "gated": false,
  "cardData": { "license": "apache-2.0" },
  "siblings": [
    { "rfilename": "config.json", "size": 571 },
    { "rfilename": "model.safetensors", "size": 437971872 }
  ]
}
```

## Revisions, branches and commits

A repo has branches (`main`), tags (`v1.0`), and pull-request refs
(`refs/pr/1`). `sha` in the info answer is the commit the *default branch* points
at right now - the number to compare a local copy against.

```bash
hf download org/name --revision v1.0
hf cache verify org/name --revision refs/pr/1
```

A revision that moved is why "it is already downloaded" and "it still
downloads" are both true: the cache is keyed by commit, so a new commit is a new
set of files even when the filenames are identical.

## Gated and private

`gated` is `false`, `"auto"` or `"manual"`. It is **not** a token problem - a
person accepts the licence on the repo page first, and only then does a token
carry access. A 403 on a gated repo before that acceptance is expected, and
retrying with a different token does not help.

Private repos need a token with the right scope. Report the account, never the
secret:

```bash
hf auth whoami
```

**A token is a credential.** It belongs in `HF_TOKEN` or the CLI's own store
(`hf auth login`), never in a command line that a transcript records, never in a
workspace file, never in a URL. A gated URL with `?token=` in it is a leak.
`hf download` also accepts `--token`; treat that flag as unavailable in an agent
session.

## `hf://` paths

The CLI speaks a URI form for cross-repo copies, which is also how
`hf cp` addresses a file inside a repo:

```bash
hf cp hf://datasets/org/name/data/train.parquet .
```

Shape: `hf://<type-plural>/<org>/<name>/<path-in-repo>` where the plural is
`datasets` for a dataset and omitted for a model. This is the form `hf cache rm`
also accepts for a repo.

## Environment variables that change behaviour

| Variable | Effect |
|---|---|
| `HF_HUB_CACHE` | the cache root, highest precedence |
| `HUGGINGFACE_HUB_CACHE` | the same, older name |
| `HF_HOME` | the parent (`$HF_HOME/hub` is the cache) |
| `TRANSFORMERS_CACHE` | deprecated, still read by some library versions |
| `HF_TOKEN` | the credential |
| `HF_HUB_OFFLINE=1` | refuse all Hub traffic |
| `TRANSFORMERS_OFFLINE=1` | the transformers-side equivalent |
| `HF_HUB_DISABLE_TELEMETRY=1` | no usage ping |
| `HF_HUB_ENABLE_HF_TRANSFER=1` / Xet | a different transfer backend |

The precedence order matters when a person says "I moved my cache": the
highest-numbered variable that is set wins, and a stale `TRANSFORMERS_CACHE`
silently points the cache somewhere else.

## The raw API, when the CLI is not enough

The Hub is also plain HTTP, and for anything the CLI does not expose this is the
contract (no token needed for public repos):

```bash
curl -s "https://huggingface.co/api/models?search=qwen3&limit=5&sort=downloads"
curl -s "https://huggingface.co/api/models/Qwen/Qwen2.5-3B-Instruct?blobs=true"
curl -s "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/resolve/main/config.json"
```

- `/api/models/<id>?blobs=true` adds per-file `size` and `lfs` blocks.
- `/api/models/<id>/tree/main?recursive=true` is the directory listing.
- `/api/datasets/<id>` and `/api/spaces/<id>` mirror it for the other types.
- `/<id>/resolve/<revision>/<path>` is the content URL; `?download=true` adds
  `Content-Disposition`.

Rate limits are per IP: 429 means wait, and a token raises the ceiling.

## The tools that answer these questions

This pack's `dsh-huggingface` row is a typed layer over exactly this CLI, and it
is worth using instead of shelling out when the question is one of these:

| Tool | Answers |
|---|---|
| `hf_status` | is `hf` here, which version, where the cache is, what is in it (complete vs metadata-only) |
| `hf_search` | what exists, ranked, with licence and gated flags |
| `hf_repo` | what ONE repo weighs, what a consumer would fetch, whether this disk already has it, at which revision |
| `hf_cache` | list / verify / prune / rm, with an unconfirmed removal being a dry run |
| `hf_download` | fetch, after reporting the size and taking the repo id back as `confirm` |

## Failures, and what each one means

| Symptom | Cause | Fix |
|---|---|---|
| 401 / "Invalid credentials" | no token, or a bad one | `hf auth login` |
| 403 on a repo whose page opens | gated licence not accepted | accept it in a browser, then retry |
| 404 on a repo that exists in a browser | wrong `--type` (dataset read as model) | pass `--type dataset` |
| 404 on a *file* | the revision moved and the path changed | `hf models info --expand siblings` |
| 429 | IP rate limit | wait, or use a token |
| download "succeeds" but the file is 1 KB | the repo is metadata-only, or the include pattern matched nothing | check `siblings` before trusting a size |
