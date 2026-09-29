---
name: ffprobe-cli
description: Read a media file's real structure with ffprobe through media_run - the JSON invocation and how to read it, what every family of field means, how to count frames, sample without decoding everything, detect HDR and interlacing, and diagnose a missing duration, a stream with no frames or a container that lies. Covers when media_probe's own report is already enough.
whenToUse: Use when the question is about a media file's exact technical facts - a bitrate, a rotation angle, a colour transfer, a language tag, a per-frame picture type, or a field media_probe's translated report does not print - and whenever a media file misbehaves and its header has to be checked directly.
---

# Reading media with ffprobe

ffprobe answers questions about a file's **header and its packets** without
decoding it. That makes it cheap and safe on a damaged or huge file, and it makes
its answers statements about what the container *claims*: it will report a stream
with zero frames, a duration of `N/A`, and a frame rate the file does not actually
deliver, because those are the facts it has.

Run it through `media_run` with `binary: "ffprobe"`. `args` is an **array**, and
ffprobe gets **none** of the flags ffmpeg gets - no `-n`, no `-nostdin`, no
`-hide_banner`. The wrapper still applies the timeout (120 s default, 600 s
maximum), the output cap, and the `cwd` (the conversation workspace unless you
name one).

## The invocation worth memorising

```
{ "binary": "ffprobe",
  "args": ["-v","error","-print_format","json","-show_format","-show_streams","-show_chapters","-show_error","clip.mp4"] }
```

`-v error` keeps the answer JSON rather than JSON behind a warning;
`-print_format json` (`-of json` is the same option) gives one parseable object
instead of one `key=value` line per field; and each `-show_*` adds a section -
`format` the container, `streams` every stream, `chapters` the chapters, `error` a
structured error when there is one.

This is exactly what `media_probe` runs, which is the first thing to know: **if a
report is enough, do not run ffprobe at all.** Reach for a raw call for a field
the report does not print, or a section it does not read (packets, frames,
programs, `-count_frames`).

### Pulling one value out

```
{ "binary": "ffprobe", "args": ["-v","error","-select_streams","v:0",
  "-show_entries","stream=width,height,r_frame_rate","-of","default=nw=1","clip.mp4"] }
```
```
width=640
height=480
r_frame_rate=30/1
```

- `-select_streams v:0` reads only the first video stream; `a` = audio, `s` =
  subtitle, `0` = stream index 0.
- `-show_entries` takes `section=field,field` pairs: `stream=codec_name,profile`,
  `format=duration,bit_rate`, `stream_tags=language` to reach a nested object.
- `-of default=nw=1` sets the default writer with `noprint_wrappers` (no section
  header); `nokey=1` drops the `key=` half and leaves the value. They are
  independent, and `nokey` alone still prints `[STREAM]`/`[/STREAM]` wrappers -
  use `nw=1:nk=1` for bare values, `-of csv=p=0` for one per line, or
  `-of compact=p=0:nk=1` for one space-free `key=value` line per stream.
- Beware a section that prints events: asking for `side_data=rotation` with no
  `-select_streams` and no other restriction can bring back `packets_and_frames`
  too.

## What the fields mean

**Container.** `format_name` is ffprobe's family list: `mov,mp4,m4a,3gp,3g2,mj2`
is the ISO-BMFF family, `matroska,webm` is MKV **or** WebM - which ffprobe cannot
tell apart, so the **extension is the tie-break**, and that is why `media_probe`
uses it. `format_long_name` is the human name. `duration` and `bit_rate` are the
container's own claims, and `start_time` is its timeline origin - the number that
explains a negative first-packet timestamp. `probe_score` (0-100) is ffprobe's
confidence, and a high score on the wrong format is how a misnamed file gets
accepted.

**Video streams.** `codec_name` (`h264`, `hevc`, `vp9`, `mpeg4`, `png`) is what to
compare against a browser's decoders, with `profile`/`level` beside it. `width`
and `height` are the **coded** pixels a decoder produces, which a rotation flag
does not change. `sample_aspect_ratio` is the pixel shape (`1:1` square, `32:27`
anamorphic on 720x480) and `display_aspect_ratio` the shape a player shows (`4:3`
on 640x480, `16:9` on that anamorphic pair) - **the pixels do not change, the DAR
does**, so a resize has to decide whether it means "look like the DAR".
`pix_fmt` is `yuv420p` (universal), `yuv420p10le` (10-bit), `yuv444p` (many
browsers draw black) or `rgb24` (a PNG). `r_frame_rate` and `avg_frame_rate` are
exact rationals - `30000/1001` is 29.97, `30/1` is exactly 30 - and `r_frame_rate`
can be wrong on a raw elementary stream (a 30 fps H.264 dump read back as `60/1`
on this host). `field_order` is `progressive` or `tt`/`bb` when interlaced.
`nb_frames` is often absent, and `N/A` means "the header does not say", not
"zero".

**Audio streams.** `sample_rate` (`48000`; a string in some builds and a number in
others - read it as text), `channels` and `channel_layout` (`2` / `stereo`, `1` /
`mono`, `6` / `5.1` - the layout is what an encoder needs, `channels` alone is not
enough), `sample_fmt` (`fltp` for AAC, `s16` for PCM), `bits_per_raw_sample`
(often absent; for PCM the depth is in `codec_name`, such as `pcm_s16le`).

**Dispositions, tags, rotation.** `disposition` is an object of 0/1 flags:
`default` (what a player picks when nothing chooses), `forced` (show this
subtitle even with subtitles off), `comment`, `hearing_impaired`, `attached_pic`
(an embedded cover image, which is technically a video stream) and more.
`tags.language` (`eng`, `spa`, `und`), `tags.title`, `tags.handler_name`. A
hand-made MKV often has no language at all, which is not an error - it is a file
that does not say. **Rotation lives in `side_data_list[].rotation`, in degrees
counter-clockwise** (an iPhone's `-90` is a clockwise 90° display rotation), and it
is **metadata, not pixels**, so `-c copy` preserves it. Read it with
`-select_streams v:0 -show_entries "stream=width,height:side_data=rotation"`,
which answers `width=640`, `height=480`, `rotation=90`.

## Reading deeper when it matters

**`-count_frames` decodes every frame**, so on a two-hour file it is minutes of
work - and the call has a timeout. On the 3-second fixture it returned
`nb_read_frames=90`. `-show_packets` and `-show_frames` without a `-read_intervals`
window print the *whole file's* packets, which is the one way to turn a small
probing call enormous - always bound it:

```
["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","default=nw=1","clip.mp4"]
```

`%+#3` is "from the start, three items", `%+3` a three-second window, `1:00%+10` a
window starting at 1:00. `flags=K__` on a packet means a keyframe. `-read_intervals`
bounds *packets*; `-skip_frame nokey` is the option that makes a `-show_frames`
walk decode keyframes only, and it does not filter a packet listing. **HDR** is
`color_transfer=smpte2084` (PQ, HDR10) or `arib-std-b67` (HLG), with
`color_primaries=bt2020` and `color_space=bt2020nc` beside it; **interlacing** is
anything but `field_order=progressive`; **variable frame rate** is
`avg_frame_rate` differing from `r_frame_rate`. None of those colour fields appear
in `media_probe`'s report, which gives `hevc (Main 10) · yuv420p10le (10-bit)` and
a `transcode` verdict instead.

`reference/fields.md` beside this file has the whole catalogue: every `-show_*`
section with what it reads and what it costs, the container/codec/audio/subtitle/
attachment/side-data families in full, the working invocations with their measured
output, and the long-form diagnosis. It also carries the three measurements a
container does not give you - a bitrate from the packets, a frame count, and the
proof that a file is really variable-rate - the transport-stream **program/PID**
layer (`-show_programs`, which an MP4 simply does not have), and `-show_data`,
which hexdumps the bytes behind a section so a stream's real configuration record
can be read instead of assumed.

## Diagnosing from the output alone

The five diagnoses worth knowing by heart:

- **`duration=N/A` with streams present** means the container carries no duration
  - a raw `.h264`, a growing capture, a pipe - and `media_probe` says `unknown` on
  the same facts. Measure with `-count_frames` or `-show_packets`.
- **A stream with no frames at all** is an empty track: a remux that dropped its
  packets, or a header written before the data. There is nothing to decode.
- **`format_name=h264` with a nonsense `r_frame_rate`** is a raw elementary
  stream: no container, no timestamps, no duration. Remux into MP4 before
  believing any timing.
- **An image reported as a one-frame video** is a PNG/GIF/WebP - a video stream
  with no duration, which is exactly why `media_probe` gives it the `image`
  verdict instead of calling a PNG undecodable.
- **Only an audio stream, no video** is an audio file: `-select_streams v:0`
  returns nothing rather than an error, and the same is true in reverse.

`reference/fields.md` carries the rest of the table - a container that says one
thing and holds another, a low `probe_score`, unreadable streams, and what an
exit code of 1 with no output means.

## `media_probe` first, ffprobe second

`media_probe` runs exactly the invocation at the top of this file and then
**translates** the JSON: container, duration, bitrate, one line per stream with the
dimensions, the exact rational frame rate *and* its decimal reading (`30 fps
(exact 30/1)`), sample rate, channel layout, bit depth, rotation, language, title,
disposition flags, and the chapters with their timestamps. It adds the one thing
ffprobe cannot: a verdict on whether a Chrome/Firefox-class browser can play the
file as it is - `playable`, `image`, `remux` or `transcode` - **with the exact
ffmpeg command that would fix a `remux`/`transcode`**.

Use it first, always: it is cheap, it reads the header only, and it cannot fail on
a damaged tail. Then:

- If a field you need is missing from the report, call `media_probe` with
  `raw: true` - it appends ffprobe's own JSON under the report, one call instead
  of two.
- Use a `media_run` ffprobe call for **packets, frames, `-count_frames`,
  `-read_intervals`, `-show_programs`, and the colour/interlace fields**, because
  those are not sections the report reads.
- The report's **browser verdict is an opinion about browser decoders**. It says
  `transcode` for HEVC and nothing whatever about whether this host's ffmpeg can
  encode or decode HEVC - it very likely can. Do not read a browser verdict as a
  statement about ffmpeg, and do not read ffprobe's ability to *read* a codec as
  evidence a browser can *play* it. Nor does it know whether a technically
  playable file is watchable on the user's connection: a 40 Mb/s MP4 is decodable
  and still unwatchable.
- A file `media_probe` cannot identify is a file ffprobe found no container in. Do
  not retry it with a longer timeout: re-check the path, and consider that a
  truncated download or a text file with a `.mp4` name looks exactly like this.
- **When the question changes from reading to changing, this is the wrong skill.**
  ffprobe never writes a byte: the moment the answer is a different container, a
  smaller file or a frame on disk, the work belongs to the `ffmpeg-cli` skill -
  whose own `reference/failures.md` (in that skill's folder, not this one) is also
  where to look when an action taken on a probe's answer fails.
