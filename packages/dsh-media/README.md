# dsh-media (alpha.1)

**Media the agent can actually work with — and the one copy of ffmpeg this pack
runs.**

The `read` tool refuses a binary file, so an image is invisible to the agent: a
PNG's dimensions, a video's codec, an audio file's sample rate and whether a
browser can play any of it are questions nothing else in the pack answers. This
package answers them, and gives the agent a real ffmpeg:

| | |
|---|---|
| `media_probe` | What a media file **is**: ffprobe's own reading of the header, translated, plus the verdict `playable` / `image` / `remux` / `transcode` and the exact command that would fix the last two. |
| `media_run` | A **real ffmpeg or ffprobe command**, as an argv array. No shell, a deadline, an output cap, and no overwrite unless you say so. |
| `media_frames` | Frames **out** of a video: at named timestamps, sampled evenly, or tiled into one contact sheet. |
| the pinned copy | The exact static build per platform, by URL **and SHA-256**, downloaded once into `$DSH_HOME/dsh-media/bin` when the machine has no ffmpeg of its own. |
| two skills | `ffmpeg-cli` and `ffprobe-cli`, registered at runtime and copied into `$DSH_HOME/skills` by both installers — each with its `reference/` files beside it, and every example in them checked by `scripts/checks/check-media-examples.mjs`. |
| seven routes | The bytes (with **HTTP Range**), the probe summary as JSON, and the background remux/transcode that `dsh-video`'s tab lives on. |

It is a **host-only** bundle: no `dsh.client`, no browser bundle, nothing in the
boot graph but itself. `dsh-video` is the surface; this is the engine, shared by
the agent and by that surface so the two cannot disagree about a file.

## The tools

### `media_probe` — what is this file?

One ffprobe run, one report: the container, its duration and bitrate, and every
stream — the codec and profile, exact pixel size and display aspect, frame rate
as **both** its rational and its decimal, pixel format and bit depth, rotation,
sample rate, channel layout, language and title tags, and every chapter with its
timestamps:

```
clip.mkv — 1.4 GB
container: Matroska / WebM [matroska] · 1:42:11.520 · 1.9 Mb/s · 3 streams (via ffprobe version 7.1)

  video   #0  h264 (High) · 1920x1080 (16:9) · 23.98 fps (exact 24000/1001) · yuv420p · default
  audio   #1  aac (LC) · 48000 Hz · 6 ch (5.1) · 384 kb/s · eng, Surround, default
  subtitle#2  subrip · eng, forced

browser: remux — the streams are browser-decodable, but the matroska container
is not one a browser opens - remuxing copies them without re-encoding
to make it play: ffmpeg -i "clip.mkv" -c copy "clip-playable.mp4"
read in 41 ms (header only: no frame was decoded)
```

Three things are load-bearing:

- **The frame rate is both numbers.** `23.98 fps` is what a reader wants and
  `24000/1001` is what the file actually says; a report that printed only the
  decimal would be wrong about 29.97, 23.976 and 59.94 files, which is most of
  them.
- **The verdict is an opinion, and it says whose.** It names the browser's own
  decoders (H.264, VP8, VP9, AV1, Theora, AAC, MP3, Opus, Vorbis, FLAC, PCM in
  MP4/WebM/Ogg/WAV), and it distinguishes **remux** (the streams are fine, the
  container is not: `-c copy`, instant and lossless) from **transcode** (a codec
  a browser does not decode, so it must be re-encoded). HEVC is called out as
  *hardware-dependent* rather than as unplayable, because that is what it is.
- **A still image is not a broken video.** ffprobe reports a PNG as one video
  stream at a nominal 25 fps with no duration, and calling that "a browser does
  not decode png" would be nonsense, so it comes back as `image` with its real
  pixel size.

`raw: true` appends ffprobe's own JSON, for a field the report does not print.

### `media_run` — a real command

`args` is an **array**, and it is never a command string:

```json
["-i", "in.mkv", "-map", "0:v?", "-map", "0:a?", "-c", "copy", "out.mp4"]
```

There is no shell anywhere in this package, so a path with a space, a filter
graph full of commas and a literal `&` all arrive at ffmpeg as themselves. What
the tool injects, at the **front** of the argv and only when you have not said
otherwise:

| injected | why |
|---|---|
| `-hide_banner` | The build banner is twenty lines and the diagnosis is at the end. |
| `-loglevel warning` | Unless you pass `-loglevel`/`-v` yourself: ffmpeg's default is chatty enough that the interesting line scrolls out of a capped answer. |
| `-nostdin` | ffmpeg must never sit on a prompt reading a terminal. |
| `-n` | **It will not overwrite an existing file.** `overwrite: true` is the only way to replace one, and it becomes `-y`. |

ffprobe gets none of the ffmpeg-only flags — it has no `-n` at all. The call runs
in the conversation workspace unless `cwd` says otherwise, is killed at its
deadline (120 s by default, 600 s at most), and its output is capped by keeping
the **head and the tail** and naming how much was dropped from the middle. The
answer reports the exit code, the elapsed time, and every file ffmpeg's own log
named as an output — stat'ed, so one that is not there says "not written".

### `media_frames` — frames out

`at: ["5", "00:01:30"]` for exact moments, `count: 9` to sample the whole thing
evenly, `sheet: true` for ONE tiled contact sheet, `format: "jpg"` for mjpeg
(quality set, because ffmpeg's default mjpeg quality is poor). Names are
create-exclusive — a second call writes `-2` rather than replacing the first —
and each file's **real pixel dimensions** are read back out of its own PNG/JPEG
header, so a frame that came out the wrong size says so.

A timestamp past the end of the file is the interesting case: ffmpeg exits **0**
having written nothing, and the answer says so.

## Where ffmpeg comes from

The repository ships **no binary**. A static ffmpeg is 130–170 MB per platform;
committing one per platform would be multiplied into every clone, every
distribution and every CI cache, and a committed Windows build helps nobody on
macOS. What this package ships instead is a **pin**: `lib/binaries.json` names,
per platform and architecture, the exact official static build URL and its
SHA-256.

Resolution order:

1. **`DSH_MEDIA_FFMPEG` / `DSH_MEDIA_FFPROBE`** — an explicit path wins, always.
2. **`ffmpeg` / `ffprobe` on `PATH`** — the machine's own install, used rather
   than downloading a second copy of the same program, which is why a machine
   with ffmpeg installed downloads nothing at all.
3. **The provisioned copy** at `$DSH_HOME/dsh-media/bin/<platform>-<arch>/`.
   `DSH_MEDIA_PREFER_BUNDLED=1` makes this win over `PATH` too, for a deployment
   that wants one known build everywhere.
4. **Nothing** — and the tool call answers **immediately** with a sentence that
   names all of the above, starting the pinned download in the **background**
   rather than blocking a turn on 170 MB. `DSH_MEDIA_NO_INSTALL=1` turns the
   background download off entirely.

The install itself:

- a **lock directory** keeps two processes off the same directory; a stale one is
  stolen after 30 minutes, so a killed process cannot wedge a later install;
- the download is streamed and hashed **as it arrives**, with a stall detector, a
  deadline and a byte cap;
- the hash is compared with the pin **before anything is executed**; a mismatch
  installs nothing, deletes the file, writes no stamp, and reports both hashes;
- the archive is unpacked with the host's own `tar` (bsdtar on Windows 10+ and
  macOS, GNU tar on Linux) — no npm archive dependency, which this pack has
  nowhere;
- each binary is copied in under a `.partial` name, `chmod 0o755` on POSIX, and
  **renamed**, so a binary that exists is always a complete binary;
- an `install.json` stamp records what was installed, from where, and when.

| platform | pinned build | license |
|---|---|---|
| win32 x64 / arm64, linux x64 / arm64 | BtbN FFmpeg-Builds `autobuild-2026-09-26-13-03` (static LGPL) | LGPL-2.1-or-later |
| darwin x64 | evermeet.cx 9.0.2 (ffmpeg + ffprobe) | GPL-3.0-or-later |
| **darwin arm64** | **deliberately not pinned** | — |

The Apple-Silicon gap is deliberate: no Apple-Silicon build publishes both a
versioned URL **and** a checksum, and pinning a URL that moves would break the
verification rather than strengthen it. On those machines `brew install ffmpeg`
(or the two environment variables) is the way, and the plugin says so in a
sentence instead of guessing at a download.

`tools/binaries.mjs` is the maintainer's half of the pin:

```
node packages/dsh-media/tools/binaries.mjs --check    # offline shape check (a tracked check runs it)
node packages/dsh-media/tools/binaries.mjs --update   # re-read the release digests and rewrite the manifest
node packages/dsh-media/tools/binaries.mjs --verify   # download every pinned archive and compare (~600 MB)
```

`--update` takes BtbN's own SHA-256 for each release asset from GitHub's API, and
hashes the macOS pair itself, because evermeet publishes a GPG signature rather
than a checksum. The pack's own `skipdir tools` rule keeps this tooling out of a
distribution.

## Routes (the video tab's side)

| route | what it does |
|---|---|
| `GET /api/dsh-media/state` | Which binary answered and from where, the provisioned copy's state and progress, the caps, the tools, the skills. |
| `GET /api/dsh-media/health` | The same snapshot, for the tracked checks. |
| `POST /api/dsh-media/provision` | Start (or join) the pinned download. Idempotent. |
| `GET /api/dsh-media/report` | The same summary `media_probe` prints, as JSON. With no ffprobe it answers `200 {ok:true, unavailable:true}` — a fact about the host, not a bad request. |
| `GET /api/dsh-media/file` | The bytes, **with real HTTP Range support**: 206 + `Content-Range`, `Accept-Ranges`, suffix ranges, 416 on an unsatisfiable one, HEAD without a body. This is what lets a `<video>` seek in a 2 GB file. `?cache=<32-hex>` serves one of this package's own conversions; a caller never names a cache path. |
| `POST /api/dsh-media/remux` | Start (or **join**) the background remux/transcode that makes a file browser-playable. |
| `GET /api/dsh-media/job` | That job's progress, straight from ffmpeg's own `-progress` output. |

The job id **is** the content key: `sha256(realpath + size + mtime + mode)`. So
asking twice joins the first job, a finished conversion is answered from the
cache without re-encoding, and an edited file can never serve a stale copy. The
percentage is driven by ffmpeg's own `-progress pipe:1` `out_time_us`, and a
partial file left by a failed conversion is deleted rather than served.

The cache (`$DSH_HOME/dsh-media/playable/`) is LRU-pruned at 8 GiB.

`/file` accepts only the video extensions the `dsh-video` tab claims — audio
belongs to `dsh-audio` and the shipped preview — and it re-validates every path
exactly as the tools do.

## What it claims, and what it deliberately does not

| | |
|---|---|
| claimed by `/file` | mp4, m4v, mov, webm, mkv, avi, wmv, flv, ogv, ts, m2ts, mpg, mpeg, 3gp, mts |
| not claimed | **every audio format** — WAV/AIFF/FLAC belong to `dsh-audio`'s waveform and MP3/M4A/Ogg to the shipped preview's own player, so claiming them here would take a surface away |
| not claimed | images — `dsh-image` owns those; `media_probe` still describes them, and `media_frames` can cut one up |
| reads | any regular file the caller names, inside the conversation workspace or by absolute path (a chat attachment, a file in Downloads) |
| never | a shell, an implicit transcode, a `-y` without `overwrite: true`, a write outside the directory a command names, a route that accepts a path it has not re-validated |

## The two skills

`skills/ffmpeg-cli/SKILL.md` and `skills/ffprobe-cli/SKILL.md` are registered at
runtime from this package's own folder **and** copied into `$DSH_HOME/skills` by
both installers. They teach the parts that are easy to get wrong: stream copy
versus re-encode, which containers a browser opens, `-ss` before `-i`, mapping
streams, reading a failed command's log, and, for ffprobe, what each field family
means and how to diagnose a file from its header alone.

Each skill is an ENTRY POINT plus the references its summary routes to, because
the entry is loaded every time and a reference is read only when its question
comes up:

| File | Answers |
|---|---|
| `ffmpeg-cli/reference/cookbook.md` | joining clips, the delivery flag sets, target-size encodes, GIF/WebP/APNG, and what each operation class costs |
| `ffmpeg-cli/reference/filters.md` | `-vf`/`-filter_complex`: geometry, overlay/watermark/PiP, subtitle burn-in, retiming, frame selection, colour and denoise, `-progress` |
| `ffmpeg-cli/reference/platforms.md` | the parts that genuinely differ per host — a path inside a **filter** value (where a Windows drive colon needs two backslashes, measured), concat lists, where the binary is resolved from, hardware encoders, capture devices, globs and variables |
| `ffmpeg-cli/reference/failures.md` | the message catalogue with the exact wording, and what each exit code can and cannot tell you |
| `ffprobe-cli/reference/fields.md` | every field family, the deeper sections, the three measurements a container does not give you (bitrate from packets, frame count, a real variable-rate proof), the transport-stream program/PID layer, and `-show_data` |

A skill a person wrote is never overwritten: each copied folder carries a
`.vncode-dsh-media` marker, so uninstall removes only what the installer put
there.

Every example in them is checked rather than trusted:
`scripts/checks/check-media-examples.mjs` parses each one as the tool call it is
meant to be - a `media_run` argv array or an ffprobe invocation - and then
**runs** the ones this host can provide for, building its fixtures with real
ffmpeg under the very names the documents read. An example that needs an encoder
or a filter this build lacks is skipped WITH its reason and never counted as a
pass; the two that are templates naming a path or a font no host could have are
marked `no-check` and reported as skipped. It is what found nine examples whose
inline prose made the array unusable.

## Verifying a change

```
node scripts/checks/check-media-node.mjs
node scripts/checks/check-media-examples.mjs
```

The tracked check drives the shipped code path — module import, `apply(context)`,
then real tool calls and real `Request`s against the captured route table. It is
split by what it can promise: the **pin** is exercised end to end against a
synthetic archive this check builds itself and serves over a loopback server
(download, hash verification, `tar` unpack, the atomic install, the stamp, the
resolution order, and the hash-mismatch refusal — with no download and no
network), while the ffmpeg-dependent half (real probes, real frames, a real
remux and a real transcode) runs when the host has ffmpeg and **skips loudly**
when it does not. `DSH_MEDIA_NO_INSTALL=1` and a temp `DSH_HOME` are set before
import, so no check run can start a download or touch `~/.dsh`.

The second check guards the DOCUMENTATION rather than the code: it shapes every
example in both skills (and in `reference/`, which the first check never read)
and executes the ones this host can run. See "The two skills" above for what it
does and does not claim.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

This is a **new bundle**, so the app's profile has to learn about it: run the
installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh the
browser (Ctrl+F5). After that it is a live link, and editing `lib/*.js` needs only
a restart. Nothing needs installing first — the plugin fetches its pinned copy
only if the machine has none.
