---
name: ffmpeg-cli
description: Drive ffmpeg through the media_run tool as an argv array - remux instead of re-encode, map streams explicitly, trim at keyframes, scale and crop, extract audio and frames, and build GIFs, contact sheets and concatenations. Covers the flags this pack injects, reading a failure from its exit code and last log lines, and the version-dependent spellings to hedge.
whenToUse: Use whenever a media file has to change - convert, remux for the browser, compress, trim, resize, crop to vertical, rip the audio, extract frames, make a GIF or an animated WebP, join clips, or re-encode something a browser refuses. Reach for media_probe first when you only need to know what the file is.
---

# Running ffmpeg

`media_run` runs one real ffmpeg (or ffprobe) command as an **argv array**. There
is no shell, so nothing is interpolated, expanded, split or quoted: a path with a
space, a filter graph and a `%` in a filename all arrive exactly as written.
Write `["-i","clip.mkv","-c","copy","out.mp4"]`, never `"ffmpeg -i clip.mkv …"`;
the program comes from `.binary` and is NOT the first element.

The tool injects `-n` (never overwrite), `-nostdin`, `-hide_banner` and
`-loglevel warning` (unless you pass a level) at the FRONT of the argv.
`overwrite: true` swaps `-n` for `-y` and is the only way to replace a file;
`binary: "ffprobe"` gets none of those ffmpeg-only flags. A call runs in the
conversation workspace unless `cwd` says otherwise, is killed after `timeoutMs`
(default 120 s, max 600 s), and its output is capped (head and tail kept, the
dropped count named).

The binaries come from the pack: PATH first, then a pinned verified copy under
`$DSH_HOME/dsh-media/bin/<platform>-<arch>/`, overridable with
`DSH_MEDIA_FFMPEG`/`DSH_MEDIA_FFPROBE`. **Never tell a user to install ffmpeg and
never assume a version.** Where a feature is version-dependent this file says so
and gives the widely available spelling.

## One argv, every OS

There is no shell between `media_run` and ffmpeg, so **one command shape is the
command on Windows, macOS and Linux.** Do not look for a per-OS spelling of a
command, and never hand anyone a shell string. The short list of what genuinely
differs per host is in `reference/platforms.md` - a path inside a *filter* value
(where a Windows drive colon needs two backslashes, and the one-backslash form
everyone quotes fails), concat list files, where the binary is resolved from,
hardware encoders, capture devices, and what "no shell" means for globs and
variables.

## Copy or re-encode?

| | `-c copy` | re-encode |
|---|---|---|
| cost | seconds, whatever the length | minutes; a 2-hour file at `medium` is not a 120 s call |
| quality | bit-identical to the source | always a generation loss |
| works when | the target container accepts the source codecs | always |
| fixes | the container | the codec, size, bitrate, frame rate |

Copying is the default to reach for, and it is the whole answer to "make this
play in a browser" whenever `media_probe` says **remux**:

```
["-i","clip.mkv","-c","copy","clip.mp4"]
```

It fails when the pair does not fit - H.264 into WebM exits 22 with `Only VP8 or
VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for
WebM` followed by `Could not write header (incorrect codec parameters ?)`. Move
the *container* to match the codec (H.264/AAC → MP4, VP9/Opus → WebM) or
re-encode the *codec* to match the container - read that pair and pick one. Never
"try copy, then transcode blindly".

## Containers a browser plays, and ones it never does

MP4 is the one container every browser demuxes; WebM plays in Chrome, Firefox and
Edge (VP9/Opus in Safari 14.1+), and Ogg, MP3, WAV and FLAC are the audio ones.
**MKV, AVI, WMV, FLV, MPEG-TS and a raw `.h264` never play**: ffprobe reads them,
no browser demuxes them.

A browser refusing a container says nothing about its codecs. An MKV full of
H.264/AAC is one remux from playing. An AVI full of MPEG-4 Part 2 (`mpeg4`, the
DivX-era codec) is not: no browser decodes `mpeg4`, nor `wmv3`, `msmpeg4`,
`flv1`, `dvvideo` or `prores`, and Chrome dropped `theora`. That case is a full
re-encode:

```
["-i","clip.avi","-c:v","libx264","-crf","20","-preset","veryfast","-c:a","aac","-b:a","160k","clip.mp4"]
```

`reference/cookbook.md` has the full delivery flag sets for MP4 and WebM,
`-movflags +faststart` and the atom order it produces, and the `-encoders` check
for whether this host has `libsvtav1`, `libaom-av1`, `libopus` or a hardware
encoder at all.

## Mapping streams: the rule that prevents the wrong audio

Without `-map`, ffmpeg picks **one stream per type** by its own rule - on a file
with an English and a Spanish track that is a coin flip you did not ask for - and
it silently drops subtitles and attachments. Say what you want:

```
["-i","two.mkv","-map","0:v:0","-map","0:a:1","-c","copy","out.mp4"]
```

`0:v:0` is input 0, video, the first one; `0:a:1` is the second audio stream (`v`
video, `a` audio, `s` subtitle, `t` attachment, `d` data, `m` metadata).

The `?` suffix makes a mapping **optional**, which is how to strip what a target
cannot hold. Subtitles and attachments cannot go into MP4, so copying them fails
outright; these copy video and audio and drop the rest:

```
["-i","withsubs.mkv","-map","0:v?","-map","0:a?","-c","copy","out.mp4"]
["-i","attached.mkv","-map","0:v?","-map","0:a?","-c","copy","out.mp4"]
```

Without `?`, `-map 0:s:0` on a file with no subtitles is a hard failure, not an
empty mapping. Confirm what was used from the `Stream mapping:` block, printed at
`-loglevel info` (so pass that yourself):

```
Stream mapping:
  Stream #0:0 -> #0:0 (copy)
  Stream #0:2 -> #0:1 (copy)
```

`Stream #0:2 -> #0:1` proves input stream 2 became output stream 1 - the second
audio track really was the one carried over.

## Trimming

Where `-ss` sits relative to `-i` is the most consequential placement rule in
ffmpeg. Before `-i` it seeks in the container and then decodes - fast, and with
`-c copy` it starts at the **keyframe at or before** the requested time. After
`-i` it decodes and discards up to that point: slow, and exact. `-t N` stops
after N seconds of output; `-to N` stops at time N on the input timeline.

```
["-ss","30","-i","long.mp4","-c","copy","part.mp4"]            // fast, keyframe-snapped
["-i","long.mp4","-ss","30","-t","10","-c:v","libx264","-crf","20","-c:a","aac","part.mp4"]   // exact
["-ss","30","-i","long.mp4","-ss","2","-t","10","-c","copy","part.mp4"]                       // fast seek, then accurate trim
```

**`-c copy` trimming snaps to keyframes.** `-ss 1.0` on a 1-second-GOP source
gave a 1.167 s file, and `-to 2` produced a file whose report said `duration=2.0`
while the video packets still ran to pts 1.967 and *started at -1.0*: copying
moves packets without rewriting timestamps, so outputs can carry negative or
non-zero start times. Add `-avoid_negative_ts make_zero` (MP4/MKV) or re-encode
the trim when timestamps must be clean, and put `-ss` after `-i` when the start
frame must be exact. `-to` is an *output* option: before `-i` it is ignored and
the command quietly delivers the whole file.

## Frames, scaling, cropping, rotation

`media_frames` is the cheap path for stills: it writes create-exclusively,
reports the dimensions read back from each written file's own header, and can
tile a contact sheet. Use `media_run` for a different filter, a sequence, or a
shape `media_frames` does not offer.

```
["-ss","5","-i","clip.mp4","-frames:v","1","-vf","scale=640:-1","shot.png"]
["-i","clip.mp4","-vf","fps=1,scale=160:-2","seq-%03d.png"]
```

- `scale=w:-1` keeps the aspect and lets ffmpeg choose the height; **`-2`
  instead of `-1` rounds to an *even* number**, which H.264 and most video
  codecs require. Measured: `scale=321:-1` on 640x480 gave 321x241 (odd, and it
  will not encode), `scale=321:-2` gave 321x240.
- `crop=w:h:x:y` cuts a rectangle from every frame, `x`/`y` from the top left:
  `crop=320:240:160:120`. Cropping runs before any later scale, which sizes the
  *cropped* frame.
- **Rotation metadata is not rotation.** A phone video is often stored landscape
  with a "rotate 90°" flag that `-c copy` preserves, so the pixels stay sideways;
  `media_probe` prints `rotated 90°` for exactly that case. Real rotation is
  `-vf transpose=1` (90° clockwise, and `2` counter-clockwise);
  `reference/filters.md` has the rest of the geometry - scale, crop, pad, the
  letterbox recipe and the even-dimension rule.
- `-frames:v 1` limits a run to one frame. Writing ONE picture also needs a name
  with no `%` pattern; ffmpeg's image2 muxer refuses a bare name in some paths
  with *"The specified filename does not contain an image sequence pattern"* -
  the fix is `-update 1`, not a different extension.

## Audio

```
["-i","clip.mp4","-vn","-c:a","copy","audio.m4a"]                    // extract, lossless, instant
["-i","clip.mp4","-vn","-c:a","pcm_s16le","-ar","48000","-ac","2","audio.wav"]   // uncompressed
["-i","clip.mp4","-vn","-c:a","aac","-b:a","160k","audio.m4a"]      // re-encode for compatibility
["-i","clip.mp4","-vn","-ac","1","-ar","16000","-c:a","aac","-b:a","64k","mono.m4a"]
```

- `-vn` drops video, `-an` drops audio. Without one, the output carries the
  streams it can and you get a bigger file than you asked for. `-ar` resamples
  (48 000 → 16 000 for speech) and `-ac` remixes channels - both are real DSP.
- **A wav muxer will hold an AAC track without complaint.** Measured:
  `-vn -c:a copy audio.wav` from an AAC source exited 0 and probed as
  `format_name=wav` with `codec_name=aac` - a file many players refuse. Naming
  the encoder (`pcm_s16le`) is what "extract the audio as WAV" means.
- **Loudness normalisation is a measurement plus a rewrite.** `loudnorm`
  analyses the file and applies a gain curve. Measured on a 3-second 440 Hz sine,
  `-af loudnorm=I=-16:TP=-1.5:LRA=11` reported `Input Integrated: -21.8 LUFS` and
  produced `Output Integrated: -16.0 LUFS` at **-15.0 dBTP** - above the
  -1.5 dBTP target, because the default single dynamic pass cannot guarantee the
  peak. For a guaranteed target, measure first and feed the values back as
  `measured_I`/`measured_TP`/`measured_LRA`/`measured_thresh` with `linear=true`.
  It decodes the whole file, so budget the timeout - and measure without writing
  a file by sending the output nowhere:

```
["-i","clip.mp4","-vn","-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=summary","-f","null","-"]
```

## Vertical crops, GIFs and animations

Crop 16:9 to 9:16 for a phone - the filter uses the frame's own height, so it
needs no source size:

```
["-i","clip.mp4","-vf","crop=ih*9/16:ih,scale=540:960","-c:v","libx264","-crf","20","-preset","veryfast","-c:a","aac","vertical.mp4"]
```

A GIF holds 256 colours and the default quantiser shows it, so build a palette
from the actual footage and feed it back - **two commands, one image between**:

```
["-i","clip.mp4","-vf","fps=12,scale=320:-1:flags=lanczos,palettegen","pal.png"]
["-i","clip.mp4","-i","pal.png","-lavfi","fps=12,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse","clip.gif"]
```

`fps=12` is deliberate: a 30 fps GIF is enormous for no visible gain, and the
file is the whole cost of the format.

## `-vf` and `-filter_complex`

One input feeds one chain in `-vf`. The moment there are **two inputs** or a
stream has to be used **twice**, it is `-filter_complex` (`-lavfi` is the same
option), where `[0:v]`/`[1:v]` name inputs and `[x]` names a chain's output for
`-map`. A contact sheet is one chain and no second input:

```
["-i","clip.mp4","-vf","fps=1,scale=320:-1,tile=3x1","-frames:v","1","sheet.png"]
```

`reference/filters.md` carries the whole subject: two-input graphs (overlay,
watermark, picture-in-picture, and the `enable=` timing expression), text and
subtitle burn-in, `setpts`/`atempo` retiming, `select`/`thumbnail`, the colour and
denoise filters, and the rule that **every label a graph produces must be mapped
exactly once** or the run fails with "unconnected output".

## Quality, and where the rest lives

`-crf` targets a quality and is constant quality with **variable** bitrate - size
follows the content. x264 landmarks: 18 visually lossless, 20 delivery, 23
smaller, 28+ visibly soft. `-preset` trades encode time for size at one quality;
`veryfast` is the right default inside a 120 s timeout, `medium` is several times
slower for a few percent. Any filter can be tried against `-f null -`, which
decodes everything and writes nothing - the cheapest way to check a graph, a
loudness reading, or whether a decode works at all.

Four reference files sit beside this one, and each answers a different question:

| Read it | When |
|---|---|
| `reference/cookbook.md` | joining clips (the `concat` demuxer versus the `concat` filter, and the `-safe 0` and layout rules that decide whether a join breaks), the full delivery flag sets, target-size encodes, GIF/WebP/APNG, and the measured cost of each operation class for planning a timeout |
| `reference/filters.md` | any `-vf`/`-filter_complex` work: geometry, overlay/watermark/PiP, subtitle burn-in, retiming, picking frames, colour and denoise, `-progress`, and the rule that every label a graph produces must be mapped |
| `reference/platforms.md` | anything OS-shaped: filter-value paths, concat lists, where the binary comes from, hardware encoders, capture devices, globs and variables |
| `reference/failures.md` | a command failed: the message catalogue with the exact wording, and what each exit code means |

## Reading a failure

The answer names the argv it ran, the exit code, the elapsed time, the files the
log named (stat'ed, so "not written" is stated rather than assumed) and the
combined output. **The last lines are the summary; the cause is the first error
line above them**, because a run that dies in a filter graph still ends with a
generic `Conversion failed!`.

Three failures are this pack rather than ffmpeg, and they are the ones most often
misread:

- **`File 'out.mp4' already exists. Exiting.`** is the injected `-n` working.
  Pass `overwrite: true`, or write a new name. It looks like a media problem and
  is not.
- **`Killed after N ms`** is a timeout, not a broken command - raise `timeoutMs`
  (up to 600000) or do less work with `-preset veryfast` or `-t`.
- **Exit 0 is not proof of a file.** Read the files line: a `-ss` past the end of
  a file exits 0 having written nothing.

`reference/failures.md` carries the rest: the container/codec pair, the filter
parse and unconnected-output errors, the Windows filter-path trap and the
`drawtext` crash that produces no ffmpeg error at all, the hardware-encoder
initialisation failures, the truncated-container messages, and what each exit
code can and cannot tell you.

## Safety rules

- **Create-exclusive by default.** `-n` is injected and only `overwrite: true`
  replaces a file. The user's original is the input, never the output.
- **argv arrays, always.** No shell exists to quote for.
- **Never guess a path.** `media_probe` it first, or ask. A typo becomes "No such
  file or directory", and a guessed *output* path may write where the user did
  not expect.
- **`media_probe` before `media_run`.** One report costs no decode and gives the
  container, codecs, pixel size, frame rate and a `playable`/`image`/`remux`/
  `transcode` verdict with the exact fixing command. That verdict is about
  **Chrome/Firefox-class decoders**, not this host's ffmpeg: ffmpeg will happily
  encode `prores`, which is not a reason to hand a user a `.mov`.
