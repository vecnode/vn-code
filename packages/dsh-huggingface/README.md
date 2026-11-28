# dsh-huggingface (alpha.1)

**The Hub as a surface the agent can interrogate before it downloads.** Five
`hf_*` tools over the machine's own `hf` CLI and the cache on this disk:
`hf_status`, `hf_search`, `hf_repo`, `hf_cache`, `hf_download`. Plus the two
skills that teach the CLI and the cache layout.

Why it earns a row: a Hub repo is a directory like any other, so a listing says
`models--lukey03--Qwen3.5-9B-abliterated` and stops. It does not say that the
entry is 16.7 GB, that **42 of the 49 entries on this machine are a `config.json`
and nothing else**, that a repo's licence is gated, or that the cached copy sits
three commits behind the Hub. Those are exactly the facts a person needs before
18 GB of bandwidth — and nothing in the pack read them. The CLI's own
`cache ls --json` answers in human strings (`"size": "17.9G"`,
`"last_accessed": "3 months ago"`), which is why the scan here walks the
directory tree.

Measured on the machine that wrote this: `hf` is **1.26.1**, the cache holds
**49 repos / 19.8 GB**, and **7 are complete** while **42 are metadata only**.

## What it adds

- **`hf_status`** — the CLI and its version, the cache root and **which variable
  chose it** (`HF_HUB_CACHE` > `HUGGINGFACE_HUB_CACHE` > `HF_HOME/hub` >
  default, with the deprecated `TRANSFORMERS_CACHE` flagged), every repo with
  byte-exact size, and the split between complete repos and the metadata-only
  stubs that look identical in a listing. Auth is a **presence** only — the token
  is never read, echoed or logged. One process (`hf --version`), no network.
- **`hf_search`** — models / datasets / spaces by query, author, tag and sort,
  parsed from `--json`. Refused with a code on a machine in offline mode, before
  any process starts.
- **`hf_repo`** — the decision, one repo at a time: licence, gated flag and the
  page that accepts it, architecture and parameter count, the repo weight **with
  the measure named**, which files each consumer would fetch (transformers,
  sentence-transformers, diffusers, GGUF quants, ONNX), and the local verdict —
  `complete`, `stub`, `stale` (cached revision vs the Hub's current `sha`) or
  `absent`.
- **`hf_cache`** — `list` (no CLI, no network), `verify`, `prune`, `rm`. An
  **unconfirmed removal is the CLI's own `--dry-run`**, so the answer is a real
  preview with the bytes it would cost; `rm` needs the repo id repeated back and
  `prune` needs the word `prune`.
- **`hf_download`** — the only bytes-moving call: the Hub's weight first, a
  ceiling it will not cross (8 GiB default), then `confirm: "<repo id>"`, then
  the fetch — answered with **the bytes the cache actually gained**, measured by
  rescanning the repo directory rather than trusting a transfer log.

## The three findings it is engineered around

**A blob is named by its hash.** In a canonical cache, `blobs/9f3c…` has no
extension, so a weight test by extension reports every repo weightless. The
names that say what a file IS live in `snapshots/<rev>/` — and that is where a
copy is real.

**Both sides of the layout hold the same bytes.** Summing `blobs` *and*
`snapshots` doubles a cache. Exactly one side is summed — and the side that
counts is `snapshots` on a machine where Xet or Windows wrote copies and `blobs/`
is empty, which is the layout measured here (a 418 MB repo with a 0-byte blobs
directory).

**This CLI line gives no per-file sizes.** `--expand siblings` carries
`rfilename` only, and there is no `--blobs` flag, so the repo weight comes from
`used_storage` and is labelled as such. A narrowed selection cannot be measured
at all: the plan says so instead of inventing a number, and the ceiling is
applied only to a measured size.

## How it plugs in

| Piece | Value |
|---|---|
| row / tools | `huggingface` / `hf_status`, `hf_search`, `hf_repo`, `hf_cache`, `hf_download` |
| host | one row, no route, no browser half (`package.json` declares no `dsh.client`) |
| engine | the user's own `hf` (huggingface_hub); `DSH_HF_CLI` pins a binary PATH does not carry |
| transport | argv-only child processes, a deadline per call, a byte cap per stream; **no socket in this package** |
| state | none on disk; only the resolved CLI is cached per boot |
| skills | `huggingface-hub`, `huggingface-cache` - registered at boot, copied into `$DSH_HOME/skills` by both installers |
| credentials | none read: `HF_TOKEN` / the stored token file are reported as *present*, never read back |

## Limits

| | |
|---|---|
| `hf` | must be installed for everything except `hf_status`'s cache scan, `hf_cache` action "list" and `hf_repo` in offline mode |
| sizes | per-file sizes are not available on this CLI line; the repo total is `used_storage` |
| downloads | `hf_download` never accepts a token and never runs `hf update`; a gated repo must be accepted in a browser first |
| network | only a call the caller asked for reaches it; `HF_HUB_OFFLINE=1` is honoured and refuses before a process starts |
| UI | none - a tool surface plus skills, not a second conversation |

## Verify

```sh
node checks/check-huggingface-node.mjs   # 217 checks, no network, no real cache touched
```

The cache is a fixture tree in a temp directory built to the real layout,
including the two cases that make a naive size rule wrong. The CLI is a fake
runner that **records the exact argv**, which is how the `-y` / `--dry-run`
decisions and the "no download over the ceiling" rule are asserted rather than
hoped for; a download in the check writes real bytes, so `addedBytes` is measured.

The pack-wide checks still own the row: `check-node-routes.mjs` (the row, the
manifest, the skill registration), `check-no-secrets.mjs`, and the root
README/ARCHITECTURE rows.

## Install

Both installers pick it up from `packages/`; as a new bundle the profile learns
it once, then a restart of `npx @deepseek-ai/dsh web` and a hard refresh.
