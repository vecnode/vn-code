---
name: huggingface-cache
description: The Hugging Face cache as bytes on a disk - the models--org--name layout with blobs, snapshots and refs; why one repo's size must be summed on ONE side of that layout; the difference between a repo that is cached and one that is COMPLETE; how revisions multiply a repo's footprint; verify, prune and rm without losing what you meant to keep; moving the cache with HF_HOME and what breaks when you do; and the Windows link-versus-copy trap.
whenToUse: Use when a download "already exists" but loads nothing, when disk space is disappearing, before deleting anything from the cache, when moving it to another drive, when a model re-downloads after a revision bump, or when reporting how much a repo actually weighs.
---

# The Hub cache on disk

The cache is not one file per repo. It is a content-addressed store with a
directory layout per repo, and almost every surprise about it comes from reading
that layout as if it were a plain folder.

## The layout

```
$HF_HUB_CACHE/                       # ~/.cache/huggingface/hub by default
├── models--Qwen--Qwen2.5-3B-Instruct/
│   ├── blobs/
│   │   ├── 5a1b...            # the bytes, named by their hash
│   │   └── 9f3c...
│   ├── snapshots/
│   │   └── <commit-sha>/
│   │       ├── config.json -> ../../blobs/5a1b...
│   │       └── model.safetensors -> ../../blobs/9f3c...
│   ├── refs/
│   │   ├── main               # the text "4b1e..." - branch -> commit
│   │   └── v1.0
│   └── .no_exist/             # markers for files confirmed absent upstream
├── datasets--org--name/
└── spaces--org--name/
```

Three facts follow from this and each one breaks a naive script:

1. **A repo is `models--org--name`**: the `/` in the id becomes `--`, and the
   type lives in the prefix. `org/name` is ambiguous until the prefix says which
   kind of repo it is.
2. **The same bytes live on both sides** whenever `snapshots/` holds links:
   summing blobs **and** snapshots reports a cache twice its real size. Sum
   `blobs` when it has bytes, `snapshots` otherwise.
3. **On Windows, or with Xet, snapshots can be real copies** rather than links.
   Measured on a machine that does this: `blobs/` was empty and a 418 MB repo was
   entirely under `snapshots/<sha>/`. A blobs-only size rule reports **0 bytes**
   there.

## "Cached" is not "complete"

This is the finding worth carrying: a repo directory can exist, hold a
`config.json`, and contain **no weight file at all**. It looks identical in a
listing - and it cannot be loaded, because a load needs the weights and would go
to the network to get them.

The test is not "does the directory exist":

- does any file match `*.safetensors`, `*.bin`, `*.gguf`, `*.pt`, `*.onnx`,
  `*.msgpack`, `*.h5`; and
- is the repo's total more than a few KB of metadata.

Measured on one developer machine: **40 of 50 entries** were metadata-only
(3.5 KB, 7.3 KB, 0 bytes), while five held real weights (17.9 GB, 1.2 GB, 418 MB).
An agent that treats "present" as "usable" plans a pipeline that fails at load
time, after the import cost.

## Revisions multiply the footprint

`refs/main` is a pointer to a commit, and `snapshots/<commit>/` is the content
of one commit. Two commits of the same repo can share many blobs (deduplicated
by hash) and differ in a few - but a model pushed with a new hash for every
shard costs its full size a second time.

So "why is this repo 17 GB when the model is 9 GB?" has a real answer: two
revisions, or two quantizations in one repo. Check both before deleting
anything:

```bash
hf cache ls --revisions --format json
hf cache verify org/name --revision <commit>
```

## Space, and how to reclaim it safely

The order that does not lose work:

```bash
hf cache ls --sort size --limit 20
hf cache prune --dry-run
hf cache rm model/org-name --dry-run
```

- `prune` removes **detached revisions and incomplete downloads** - interrupted
  pulls, revisions nothing points at. It is the safe one.
- `rm` removes a whole repo or a single revision, and its target is
  `<type>/<repo>` (`model/org/name`), not a bare id.
- Both accept `--dry-run`, and both **prompt for confirmation without `-y`**.
  In a non-interactive process (stdin closed) a missing `-y` is not a "no", it
  is a hang or an abort - so the confirmation must belong to the caller, and
  `-y` is passed only after a person or an explicit tool argument has said yes.

Deleting the cache does not delete the Hub copy; a re-download costs the same
bandwidth it cost the first time. A `rm` of a 17 GB repo is a 17 GB decision.

## Moving the cache

```bash
HF_HOME=/mnt/big/hf-cache hf download org/name
export HF_HOME=/mnt/big/hf-cache
```

`HF_HOME` puts the cache at `$HF_HOME/hub`. Precedence, highest first:

```
HF_HUB_CACHE > HUGGINGFACE_HUB_CACHE > HF_HOME/hub > ~/.cache/huggingface/hub
```

Two traps when moving:

- A stale `TRANSFORMERS_CACHE` (deprecated, still honoured by some library
  versions) silently points at the old place, so `hf` finds one cache and
  transformers finds another.
- Moving the directory without the variables moves nothing for the libraries:
  they will recreate the old path and re-download. Move the bytes **and** set the
  variable in the shell that runs the job.

## Offline mode

```bash
HF_HUB_OFFLINE=1 hf cache ls
```

With `HF_HUB_OFFLINE=1` (or `TRANSFORMERS_OFFLINE=1`) the libraries refuse all
Hub traffic and read only the cache. That is the correct mode for a reproducible
job - and it is also why "it worked yesterday" and "it fails today" can both be
true: yesterday the cache had the revision, today the ref moved.
`from_pretrained(..., local_files_only=True)` is the per-call form.

## Windows: links vs copies

The POSIX cache uses symlinks, which costs nothing. Windows only creates them
with Developer Mode or an elevated process; without that, the library may copy
the file into `snapshots/` instead, doubling the footprint for the same repo and
making a blobs-only size rule report zero. `HF_HUB_DISABLE_SYMLINKS=1` forces
copies deliberately (for example on a network share) and the
`HF_HUB_DISABLE_SYMLINKS_WARNING=1` variable only silences the notice.

## What a correct size report says

A number is only honest with its method attached:

- **bytes**, not "17.9G" parsed from a screen;
- **which side of the layout** was summed (blobs or snapshots);
- **complete vs metadata-only**, because a 7 KB repo is not a small model;
- **which revision**, because two revisions of one repo are two downloads;
- and the **file count**, because a directory with a `.no_exist` marker and a
  single `config.json` is not a download that succeeded.

The `dsh-huggingface` row reports exactly those: `hf_status` and `hf_cache`
action "list" give per-repo `bytes`, `layout`, `weights`, `revision` and `stub`,
`hf_repo` compares a cached revision against the Hub's own `sha`, and
`hf_download` answers with the bytes the cache GAINED rather than the bytes the
CLI says it transferred.
