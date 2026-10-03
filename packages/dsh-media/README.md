# dsh-media (alpha.3)

**Media the agent can actually work with, and the one copy of ffmpeg this pack runs.**

The `read` tool refuses a binary file, so a PNG's dimensions, a video's codec, an audio
file's sample rate and whether a browser can play any of it are questions nothing else
here answers. This package answers them and gives the agent a real ffmpeg; it is
**host-only** (no `dsh.client`, no browser bundle) - `dsh-video` is the surface, this is
the engine it and the agent share.

## What it adds

- `media_probe` - one ffprobe run as a report: container, duration, bitrate; per stream the
  codec and profile, exact pixel size and display aspect, frame rate as BOTH its rational
  (`30000/1001`) and its decimal, pixel format, bit depth, rotation, sample rate, channel
  layout, language/title tags and every chapter - ending in the verdict `playable` / `image` /
  `remux` / `transcode` plus the exact ffmpeg command that would fix the last two. `image` is
  its own verdict, because ffprobe reports a PNG as one video stream at 25 fps. `raw: true`
  adds ffprobe's own JSON.
- `media_run` - a REAL ffmpeg or ffprobe command as an **argv array**, never a shell string,
  so a path with a space, a filter graph and a literal `&` arrive as themselves. It injects
  `-hide_banner`, `-loglevel warning` (unless the caller sets a level), `-nostdin` and `-n`
  (never overwrite) unless `overwrite: true`, which becomes `-y`; ffprobe gets none of those.
  It runs in the conversation workspace by default, kills at a deadline (120 s, 600 s max),
  caps the output keeping head and tail and naming the drop, and reports the exit code, the
  elapsed time and the files ffmpeg named as outputs.
- `media_frames` - frames at named timestamps, `count: N` sampled evenly, or ONE contact
  sheet, written create-exclusively, each file's REAL dimensions read back out of its own
  PNG/JPEG header. A `-ss` past the end exits 0 having written nothing, and says so.
- **The pin, not a binary**: `lib/binaries.json` records per platform-arch the exact official
  static build URL and its SHA-256. Resolution order: `DSH_MEDIA_FFMPEG` / `DSH_MEDIA_FFPROBE`,
  then `PATH`, then `$DSH_HOME/dsh-media/bin/<platform>-<arch>/`, then **nothing** - answered
  immediately with the pinned download started in the BACKGROUND (`DSH_MEDIA_NO_INSTALL=1`
  disables it; `DSH_MEDIA_PREFER_BUNDLED=1` makes the provisioned copy win over `PATH`).
- **Provisioning**: a lock directory stolen after 30 minutes, a streamed download hashed as it
  arrives with a stall detector, a deadline and a byte cap, the hash compared with the pin
  BEFORE anything is executed (a mismatch deletes it and installs nothing), unpacking through
  the host's own `tar`, each binary copied in under a `.partial` name and RENAMED, `chmod
  0o755` on POSIX, and an `install.json` stamp.
- **Two skills** (`skills/ffmpeg-cli/SKILL.md`, `skills/ffprobe-cli/SKILL.md`) registered at
  runtime from the package folder **and** copied into `$DSH_HOME/skills` by both installers
  under a `.vncode-dsh-media` marker; every example in them is parsed and the runnable ones
  really run by `check-media-examples.mjs`.

## How it plugs in

| Piece | Value |
|---|---|
| row | `media`, host-only (no `dsh.client`, no browser bundle) |
| routes | seven exact paths, `GET`/`HEAD`/`POST` only |
| touches | no core row disabled, no fork, no npm dependencies, no vendored engine |

| Route | What it answers |
|---|---|
| `GET /api/dsh-media/state`, `/health` | which binary answered and from where, the provisioned copy's state, the caps and tools; `POST /provision` joins the download |
| `GET /api/dsh-media/report` | the `media_probe` summary as JSON; `200 {ok:true,unavailable:true}` with no ffprobe |
| `GET /api/dsh-media/file` | the bytes with real HTTP Range support (206 + `Content-Range`, suffix ranges, 416, HEAD without a body); `?cache=<32-hex>` serves a cached conversion by key |
| `POST /api/dsh-media/remux`, `GET /job` | start or JOIN the background remux/transcode; progress from ffmpeg's own `-progress pipe:1` `out_time_us` |

The job id **is** the content key (`sha256(realpath + size + mtime + mode)`): asking twice
joins the first, a finished copy comes from the cache, and an edited file never serves a
stale one.

## Limits

- claims 15 video extensions - mp4, m4v, mov, webm, mkv, avi, wmv, flv, ogv, ts, m2ts, mpg, mpeg,
  3gp, mts - and **no audio format** (WAV/AIFF/FLAC belong to `dsh-audio`, MP3/M4A/Ogg to the
  shipped preview, so claiming them would take a surface away) and no image (`dsh-image` owns those).
- the playable cache under `$DSH_HOME/dsh-media/playable/` is LRU-pruned at 8 GiB; a partial
  file from a failed conversion is deleted, not served.
- darwin-arm64 is deliberately unpinned - no Apple-Silicon build publishes both a versioned URL
  and a checksum - so that platform is told to use `brew install ffmpeg` or the two variables.
- never a shell, an implicit transcode, a `-y` without `overwrite: true`, or an unvalidated path.

## Verify

```
node scripts/checks/check-media-node.mjs        # the pin, offline; ffmpeg half skips loudly
node scripts/checks/check-media-examples.mjs    # every skill example, parsed and run
```

## Install

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

Run the installer once, then restart the app and hard-refresh the browser; nothing has to be
installed first, since the pinned copy is fetched only if the machine has none.
