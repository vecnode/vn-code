# dsh-media (alpha.1)

**Media the agent can actually work with — and the one copy of ffmpeg this pack
runs.**

The `read` tool refuses a binary file, so an image is invisible to the agent
today: a PNG's dimensions, a video's codec, an audio file's sample rate and
whether a browser can play any of it are all questions nothing in the pack could
answer. This package answers them, and gives the agent a real ffmpeg:

| | |
|---|---|
| `media_probe` | What a media file **is**: ffprobe's own reading of the header, translated, plus the verdict `playable` / `image` / `remux` / `transcode` and the exact command that would fix the last two. |
| `media_run` | A **real ffmpeg or ffprobe command**, as an argv array. No shell, a deadline, an output cap, and no overwrite unless you say so. |
| `media_frames` | Frames **out** of a video: at named timestamps, sampled evenly, or tiled into one contact sheet. |
| the pinned copy | The exact static build per platform, by URL **and SHA-256**, downloaded once into `$DSH_HOME/dsh-media/bin` when the machine has no ffmpeg of its own. |
| two skills | `ffmpeg-cli` and `ffprobe-cli`, registered at runtime and copied into `$DSH_HOME/skills` by both installers. |
| seven routes | The bytes (with **HTTP Range**), the probe summary as JSON, and the background remux/transcode that `dsh-video`'s tab lives on. |

It is a **host-only** bundle: no `dsh.client`, no browser bundle, nothing in the
boot graph but itself. `dsh-video` is the surface; this is the engine, shared by
the agent and by that surface so the two cannot disagree about a file.

## The tools

### `media_probe` — what is this file?

One ffprobe run, one report:

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

Three things in that report are load-bearing:

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
the tool adds, and only when you have not said otherwise:

| added | why |
|---|---|
| `-hide_banner` | The build banner is twenty lines and the diagnosis is at the end. |
| `-loglevel warning` | Unless you pass `-loglevel`/`-v` yourself: ffmpeg's default is chatty enough that the interesting line scrolls out of a capped answer. |
| `-nostdin` | ffmpeg must never sit on a prompt reading a terminal. |
| `-n` | **It will not overwrite an existing file.** `overwrite: true` is the only way to replace one, and it becomes `-y`. |

ffprobe gets none of the ffmpeg-only flags (it has no `-n`, and a check
famously found that out). The call runs in the conversation workspace unless
`cwd` says otherwise, is killed at its deadline (120 s by default, 600 s at
most), and its output is capped by keeping the **head and the tail** and naming
how much was dropped. The answer reports the exit code, the elapsed time, and
every file ffmpeg's own log named as an output — stat'ed, so one that is not
there says "not written" rather than being assumed.

### `media_frames` — frames out

`at: ["5", "00:01:30"]` for exact moments, `count: 9` to sample the whole thing
evenly, `sheet: true` for ONE tiled contact sheet, `format: "jpg"` for mjpeg
(quality included, because ffmpeg's default mjpeg quality is poor enough to make
a contact sheet look worse than the video). Names are create-exclusive — a
second call writes `-2` rather than replacing the first — and each file's **real
pixel dimensions** are read back out of its own PNG/JPEG header, so a frame that
came out the wrong size says so.

A timestamp past the end of the file is the interesting failure: ffmpeg exits
**0** having written nothing, and the answer says exactly that instead of
claiming success.

## Where ffmpeg comes from

The repository ships **no binary**. A static ffmpeg is 130–170 MB per platform;
committing one per platform would be multiplied into every clone, every
distribution and every CI cache, and a committed Windows build helps nobody on
macOS. What this package ships instead is a **pin**: `lib/binaries.json` names,
per platform and architecture, the exact official static build and its SHA-256.

Resolution order, for every call:

1. **`DSH_MEDIA_FFMPEG` / `DSH_MEDIA_FFPROBE`** — an explicit path wins, always.
2. **`ffmpeg` / `ffprobe` on `PATH`** — the machine's own install is used rather
   than downloading a second copy of the same program — which is why a machine
   with ffmpeg installed downloads nothing at all.
3. **The provisioned copy** at `$DSH_HOME/dsh-media/bin/<platform>-<arch>/`.
   `DSH_MEDIA_PREFER_BUNDLED=1` makes this win over `PATH` too, for a
   deployment that wants one known build everywhere.
4. **Nothing** — and the tool call answers **immediately** with a sentence that
   names all of the above, starting the pinned download in the **background**
   rather than blocking a turn on 170 MB. The next call finds it installed.
   `DSH_MEDIA_NO_INSTALL=1` turns the background download off entirely.

The download itself is the part that had to be careful:

- the archive is hashed **as it arrives** and compared with the pin **before
  anything is executed**; a mismatch deletes it, installs nothing, leaves no
  stamp, and says which two hashes disagreed;
- it is unpacked with the host's own `tar` (bsdtar on Windows 10+ and macOS, GNU
  tar on Linux) — no npm archive dependency, which this pack has nowhere;
- each binary is copied in under a `.partial` name and **renamed**, so a binary
  that exists is always a complete binary;
- an `install.json` stamp records what was installed, from where, and when; a
  stale lock from a killed process is stolen after 30 minutes, and a live one
  makes a second process wait rather than fight over the directory.

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

Refreshing the pin is one command:

```
node packages/dsh-media/tools/binaries.mjs --check    # offline shape check (a tracked check runs it)
node packages/dsh-media/tools/binaries.mjs --update   # re-read the release digests and rewrite the manifest
node packages/dsh-media/tools/binaries.mjs --verify   # download every pinned archive and compare (~600 MB)
```

`--update` takes BtbN's own SHA-256 for each release asset from GitHub's API —
and that is not trust on faith: the Windows archive's hash in the shipped
manifest was confirmed by downloading all 173,535,440 bytes and hashing them
locally. The macOS pair is hashed by `--update` itself, because evermeet
publishes a GPG signature rather than a checksum.

## Routes (the video tab's side)

| route | what it does |
|---|---|
| `GET /api/dsh-media/state` | Which binary answered and from where, the provisioned copy's state and progress, the caps, the tools, the skills. |
| `GET /api/dsh-media/health` | The same snapshot, for the tracked checks. |
| `POST /api/dsh-media/provision` | Start (or join) the pinned download. Idempotent. |
| `GET /api/dsh-media/report` | The same summary `media_probe` prints, as JSON. With no ffprobe it answers `200 {ok:true, unavailable:true}` — a fact about the host, not a bad request. |
| `GET /api/dsh-media/file` | The bytes, **with HTTP Range**: 206 + `Content-Range`, suffix ranges, 416 on an unsatisfiable one, HEAD without a body. This is what lets a 2 GB film seek instead of being read into memory. `?cache=<key>` serves one of this package's own conversions; a caller never names a cache path. |
| `POST /api/dsh-media/remux` | Start (or **join**) the background remux/transcode that makes a file browser-playable. |
| `GET /api/dsh-media/job` | That job's progress, straight from ffmpeg's own `-progress` output. |

The job id **is** the content key: `sha256(realpath + size + mtime + mode)`. So
asking twice joins the first job, a finished conversion is answered from the
cache without re-encoding, and an edited file can never serve a stale copy. A
partial file left by a failed conversion is deleted and never served.

The cache (`$DSH_HOME/dsh-media/playable/`) is LRU-pruned at 8 GiB.

## What it claims, and what it deliberately does not

| | |
|---|---|
| claimed by `/file` | mp4, m4v, mov, webm, mkv, avi, wmv, flv, ogv, ts, m2ts, mpg, mpeg, 3gp, mts |
| not claimed | **every audio format** — WAV/AIFF/FLAC belong to `dsh-audio`'s waveform and MP3/M4A/Ogg to the shipped preview's own player, so claiming them here would take a surface away rather than add one |
| not claimed | images — `dsh-image` owns those; `media_probe` still describes them, and `media_frames` can cut one up |
| reads | any regular file the caller names, inside the conversation workspace or by absolute path (a chat attachment, a file in Downloads) |
| never | a shell, an implicit transcode, a `-y` without `overwrite: true`, a write outside the directory a command names, a route that accepts a path it has not re-validated |

## The two skills

`skills/ffmpeg-cli/SKILL.md` and `skills/ffprobe-cli/SKILL.md` are registered at
runtime from this package's own folder **and** copied into `$DSH_HOME/skills` by
both installers. They are written for the tool interface this package actually
exposes — argv arrays, the injected guardrails, `-n` by default — and they teach
the parts that are easy to get wrong: stream copy versus re-encode, which
containers a browser opens, `-ss` before `-i`, mapping streams, reading a failed
command's log, and, for ffprobe, what each field family means and how to
diagnose a file from its header alone.

A skill a person wrote is never overwritten: each copied folder carries a
`.vn-harness-dsh-media` marker, so uninstall removes only what the installer put
there.

## Verifying a change

```
node --check packages/dsh-media/lib/index.js
node scripts/checks/check-media-node.mjs
```

The tracked check drives the shipped code path — module import, `apply(context)`,
then real tool calls and real `Request`s against the captured route table. It is
split by what it can promise on any host: the **pin** is exercised end to end
against a synthetic archive this check builds itself and serves over a loopback
server (download, hash verification, `tar` unpack, the atomic install, the
stamp, the resolution order, and the hash-mismatch refusal — with no download and
no network), while the ffmpeg-dependent half (real probes, real frames, a real
remux and a real transcode) runs when the host has ffmpeg and **skips loudly**
when it does not. `DSH_MEDIA_NO_INSTALL=1` and a temp `DSH_HOME` are set before
import, so no check run can start a download or touch `~/.dsh`.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
install.bat -Force        # Windows
./install.sh -Force       # macOS / Linux
```

This is a **new bundle**, so the app's profile has to learn about it: run the
installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh the
browser (Ctrl+F5). After that it is a live link, and editing `lib/*.js` needs only
a restart. Nothing needs installing first — the installer `grep`s no ffmpeg, and
the plugin fetches its pinned copy only if the machine has none.

## Alpha roadmap

- **alpha.1** (this release): the three tools, the two skills, the pin and its
  provisioning, the seven routes, the Range-capable file stream and the
  remux/transcode jobs.
- **Next, if the media you work with asks for it**: subtitle extraction to text
  (the one thing ffmpeg can produce that an agent can read directly), a
  `media_frames` mode that returns a picture the conversation itself renders,
  audio-only waveform summaries for a long recording, and Hardware-encoder
  detection surfaced as a capability rather than left to `-encoders`.
