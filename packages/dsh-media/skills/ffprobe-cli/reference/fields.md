# ffprobe, in full

The skill summary carries the invocation that matters and the fields a reader
asks for most. This is the rest: every field family, the deeper sections, and the
diagnoses that only make sense with the numbers in front of you. Every command
and every quoted value here was produced against real fixtures.

## The sections, and what each one costs

| `-show_*` | What it reads | Cost |
|---|---|---|
| `-show_format` | the container: names, duration, bit rate, tags | free (header) |
| `-show_streams` | every stream's codec, shape, rate, tags, dispositions | free (header) |
| `-show_chapters` | chapter start/end and titles | free (header) |
| `-show_error` | a structured error object when there is one | free |
| `-show_programs` | the program/PID layout of a transport stream | free |
| `-show_packets` | one entry per packet | a full demux pass |
| `-show_frames` | one entry per frame, with picture type and colour | a decode pass |
| `-count_frames` | decodes to count | a decode pass, and slow |
| `-show_data` | a hexdump of the bytes behind a section - `stream=extradata` is the useful one | depends what it is attached to |
| `-show_stream_groups`, `-show_program_version` | container-specific extras | free |

`-of` writers worth knowing: `json` (`-print_format json` is the same option),
`default` with `nw=1`/`nk=1`, `csv=p=0`, `compact=p=0:nk=1`, `ini`,
`flat`. `-show_entries` restricts *fields*; the writer decides their shape. Both
`-show_entries stream=side_data_list` and an event section can produce more than
expected, so pair every `-show_entries` with `-select_streams` when the question
is about one stream.

## Every field family

### Container

| Field | Reading it |
|---|---|
| `format_name` | ffprobe's family list. `mov,mp4,m4a,3gp,3g2,mj2` is the ISO-BMFF family; `matroska,webm` is MKV **or** WebM, which ffprobe cannot tell apart - the **extension is the tie-break**, which is why `media_probe` uses it. `h264` alone means a raw elementary stream with no container at all |
| `format_long_name` | the human name (`QuickTime / MOV`, `Matroska / WebM`, `AVI (Audio Video Interleaved)`, `WAV / WAVE (Waveform Audio)`) |
| `duration` | seconds, decimal. `N/A` when the container carries none |
| `bit_rate` | overall bits per second, only if the container records it |
| `start_time` | the container's timeline origin - the number that explains a negative first-packet timestamp |
| `probe_score` | ffprobe's confidence, 0-100. A high score on the wrong format is how a misnamed file gets accepted |
| `nb_streams` | how many streams the container declares |
| `tags` | `encoder`, `major_brand`, `minor_version`, `compatible_brands`, `title`, `artist`, `comment` |

A measured AVI: `format_name=avi`, `format_long_name=AVI (Audio Video
Interleaved)`, `duration=3.048000`, `bit_rate=2576041`, `start_time=0.000000`,
`probe_score=100`.

### Video streams

| Field | Reading it |
|---|---|
| `codec_name` | the short name (`h264`, `hevc`, `vp9`, `mpeg4`, `png`) - the one to compare against what a browser decodes |
| `codec_long_name` | `H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10` |
| `profile`, `level` | `High` / `30` for H.264, `Main 10` for 10-bit HEVC, `Profile 0` for VP9. A `High 4:4:4` H.264 is not the same compatibility story as `High` |
| `width`, `height` | the **coded** pixels, which is what the decoder produces. A rotation flag does not change them |
| `coded_width`, `coded_height` | the padded size the codec works in - rarely different, and it is `width`/`height` a reader means |
| `sample_aspect_ratio` | pixel shape. `1:1` is square; `32:27` on 720x480 is anamorphic |
| `display_aspect_ratio` | the shape a player shows: `4:3` on 640x480, `16:9` on that 720x480 example. **The pixels do not change; the DAR does**, so a resize has to decide whether it means "look like the DAR" |
| `pix_fmt` | `yuv420p` (universal), `yuv420p10le` (10-bit), `yuv444p` (many browsers draw black), `rgb24` (a PNG), `gray` |
| `bits_per_raw_sample` | often absent for video; the depth is in `pix_fmt` |
| `r_frame_rate`, `avg_frame_rate` | exact rationals: `30000/1001` is 29.97, `30/1` is exactly 30. `r_frame_rate` is the rate the container says is "the" rate, `avg_frame_rate` is frames ÷ duration. They differ on variable-rate content, and `r_frame_rate` can be wrong on a raw elementary stream - a 30 fps H.264 dump read back as `60/1` on this host |
| `field_order` | `progressive`, or `tt`/`bb`/`tb`/`bt` for interlaced. **A stream field, not a frame field** |
| `color_range` | `tv` (limited, the video default) or `pc` (full) |
| `nb_frames` | often absent. `N/A` means "the header does not say", not "zero" |
| `duration`, `start_time` (per stream) | seconds. A stream can be longer or shorter than the container says, and **a stream's timestamps may not start at zero** - a transport stream or capture often starts at 1.4 s or at a negative DTS, and mixing streams with different `start_time` values is what produces an audio/video offset after a `-c copy` |
| `time_base` | the tick size the timestamps are counted in (`1/15360`, `1/90000`). `start_pts`/`duration_ts` are ticks; `start_time`/`duration` are seconds. A measured video stream: `time_base=1/15360`, `start_pts=0`, `duration_ts=46080`, `duration=3.000000` |
| `has_b_frames` | 1+ means B-frames are present, which is why a copy's DTS runs ahead of its PTS |

### Audio streams

| Field | Reading it |
|---|---|
| `codec_name` | `aac`, `mp3`, `opus`, `vorbis`, `flac`, `pcm_s16le` (16-bit PCM), `pcm_f32le` |
| `sample_rate` | `48000`. A string in some builds and a number in others - read it as text |
| `channels`, `channel_layout` | `2` / `stereo`, `1` / `mono`, `6` / `5.1`. The layout is what an encoder needs; `channels` alone is not enough |
| `sample_fmt` | `fltp` (planar float, what AAC decodes to), `s16`, `u8` |
| `bits_per_raw_sample` | often absent; for PCM the depth is in `codec_name` |
| `bit_rate` | per-stream, when the container records it (MP4 does, Matroska often does not) |

### Subtitle, attachment and data streams

`codec_name` for a subtitle is `subrip`, `ass`, `hdmv_pgs_subtitle`, `mov_text`
or `webvtt`. An **attachment** is `codec_type=attachment` with `codec_name=unknown`
and `tags.filename` / `tags.mimetype` naming the file - measured on an MKV with a
`text/plain` attachment appended. A **data** stream is `codec_type=data`
(timecode tracks).

### Dispositions, tags, rotation

- `disposition` is an object of 0/1 flags: `default`, `dub`, `original`,
  `comment`, `lyrics`, `karaoke`, `forced`, `hearing_impaired`,
  `visual_impaired`, `clean_effects`, `attached_pic`, `timed_thumbnails`,
  `captions`, `descriptions`, `metadata`, `dependent`, `still_image`.
  `default=1` is the track a player picks when nothing chooses; `forced=1` on a
  subtitle means "show these even with subtitles off"; `attached_pic=1` marks an
  embedded cover image that is technically a video stream.
- `tags.language` (`eng`, `spa`, `und` - ISO 639-2), `tags.title` (`Commentary`),
  `tags.handler_name` (`SoundHandler`, `VideoHandler`). A hand-made MKV often has
  no language at all, which is not an error: it is a file that does not say.
- **Rotation lives in `side_data_list[].rotation`, in degrees counter-clockwise**
  (an iPhone's `-90` is a clockwise 90° display rotation). `media_probe` reads it
  and prints `rotated 90°`; some containers carry a `rotate` tag instead. The
  rotation is **metadata, not pixels**: `-c copy` preserves it, so a transcoder
  that ignores it hands back a sideways frame.
- `side_data_list` also carries `displaymatrix` (the rotation, in matrix form),
  `mastering display metadata` and `content light level` - the HDR static
  metadata - and `stereo3d` on 3D content.

## Working invocations

One value, or a few, without the JSON:

```
["-v","error","-select_streams","v:0","-show_entries","stream=width,height,r_frame_rate","-of","default=nw=1","clip.mp4"]
["-v","error","-select_streams","v:0","-show_entries","stream=codec_name,profile","-of","default=nw=1:nk=1","clip.mp4"]
["-v","error","-show_entries","format=duration,bit_rate","-of","compact=p=0:nk=1","clip.mp4"]
["-v","error","-select_streams","a:0","-show_entries","stream=sample_rate,channels,channel_layout","-of","default=nw=1","clip.mp4"]
```

`default=nw=1:nk=1` gives bare values with no wrappers; `compact=p=0:nk=1` gives
one pipe-separated line. Rotation, as a stream's side data:

```
["-v","error","-select_streams","v:0","-show_entries","stream=width,height:side_data=rotation","-of","default=nw=1","rotated.mp4"]
```

HDR and interlacing:

```
["-v","error","-select_streams","v:0","-show_entries","stream=codec_name,pix_fmt,color_transfer,color_primaries,color_space","-of","default=nw=1","hdr.mp4"]
["-v","error","-show_entries","stream=field_order","-of","default=nw=1","interlaced.mp4"]
```

Counting, and reading a bounded window of packets or frames:

```
["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","default=nw=1","clip.mp4"]
["-v","error","-select_streams","v:0","-show_entries","packet=pts_time,flags,size","-read_intervals","%+#3","-of","default=nw=1","clip.mp4"]
["-v","error","-select_streams","v:0","-show_entries","frame=pict_type,key_frame,color_transfer","-read_intervals","%+#1","-of","default=nw=1","clip.mp4"]
```

Measured results: `nb_read_frames=90` on a 3-second 30 fps clip;
`pts_time=0.000000 / flags=K__ / size=9891` on its first packet;
`key_frame=1 / pict_type=I / color_transfer=unknown` on its first frame (a source
encoded without colour metadata reports `unknown`, which is why HDR detection
needs a file that actually declares it).

`-read_intervals` syntax: `%+#3` is "from the start, three items", `%+3` is a
three-second window, `1:00%+10` starts at 1:00, `%+#1` is the first item. It
bounds *packets*. `-skip_frame nokey` is the option that makes a `-show_frames`
walk decode keyframes only - it does not filter a packet listing, which still
prints everything in the window.

## Programs and PIDs: a transport stream is a different shape

`-show_streams` answers "what streams are in this file". A **transport stream**
also carries a *program* layer that says which streams belong together and which
PID carries them, and that layer is what `-show_programs` reads:

```
["-v","error","-show_programs","-of","json","clip.ts"]
```

Measured on a TS the tracked check builds from an MP4:

```text
"programs": [ { "program_id": 1, "program_num": 1, "nb_streams": 1,
                "pmt_pid": 4096, "pcr_pid": 256,
                "tags": { "service_name": "Service01", "service_provider": "FFmpeg" },
                "streams": [ ... ] } ]
```

Read it when a TS misbehaves: a `pcr_pid` naming a stream that is not there, a
program with fewer streams than `-show_streams` reported, or several programs in
one file (a multi-service capture) are all facts `-show_streams` alone cannot give
you. On an MP4 or MKV the section is empty, which is correct rather than an error
- those containers have no program layer.

## Measuring what the header does not say

Three measurements cover most of what a container omits.

**A bitrate the container did not record.** Matroska often omits `bit_rate`, and
`N/A` is not a failure. Sum the packets instead - `packet=size` is cheap and needs
no decode:

```
["-v","error","-select_streams","v:0","-show_entries","packet=size","-read_intervals","%+2","-of","csv=p=0","clip.mp4"]
```

One size per line (`2200`, `668`, `250`, ...). Bits per second is
`sum(sizes) * 8 / seconds`, and a bounded `-read_intervals` window is a *sample*
of the rate rather than the whole file - say which of the two you measured.

**A frame count, and the identity behind `avg_frame_rate`.** `nb_frames` is often
`N/A`; `-count_frames` decodes and counts for real:

```
["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","default=nw=1","vfr.mp4"]
["-v","error","-show_entries","format=duration","-of","default=nw=1","vfr.mp4"]
```

Measured on the check's own variable-rate fixture: `nb_read_frames=7` and
`duration=1.900000`, and `7 / 1.9 = 3.684` - which is exactly that file's
`avg_frame_rate=70/19`. **`avg_frame_rate` is frames ÷ duration**, not a rate
anyone measured, which is what makes it the honest number for a file whose rate
wanders.

**Whether a file is really variable-rate.** The cheap header check first:

```
["-v","error","-select_streams","v:0","-show_entries","stream=r_frame_rate,avg_frame_rate","-of","default=nw=1","vfr.mp4"]
```

`r_frame_rate=10/3` and `avg_frame_rate=70/19` on the same file: they differ, so it
is variable-rate. `r_frame_rate` is the rate the container *calls* "the" rate and
it can be nonsense - it is the number to distrust, not the one to quote. Confirm
with the count above when the answer matters, and remember that a **raw elementary
stream** has no container timing at all, so remux it into MP4 before believing any
frame rate it reports.

If you look at packet timestamps directly, mind the **order**:

```
["-v","error","-select_streams","v:0","-show_entries","packet=pts_time","-read_intervals","%+2","-of","csv=p=0","clip.mp4"]
```

Measured: `0.000000`, `0.900000`, `0.300000`, `0.600000`. Those are **decode**
order, so they are not sorted and consecutive differences are not frame intervals
- with B-frames present, `pts_time` runs backwards on purpose. Sort before
differencing, or read `-show_frames` with `best_effort_timestamp_time`, and never
call a file variable-rate because a raw diff of this output looked irregular.

## Reading raw bytes: `-show_data`

`-show_data` makes ffprobe hexdump the bytes behind a section, with the printable
characters beside them. `stream=extradata` is the one worth knowing:

```
["-v","error","-select_streams","v:0","-show_data","-show_entries","stream=extradata","-of","default=nw=1","clip.mp4"]
```

Measured, on H.264:

```text
extradata=
00000000: 0164 000a ffe1 0019 6764 000a acd9 4284  .d......gd....B.
00000010: 7e5c 0440 0000 0300 4000 0005 03c4 8965  ~\.@......@....e
00000020: 8001 0006 68eb e094 b22c fdf8 f800       ....h....,.....
```

That is the H.264 configuration record - the SPS/PPS a decoder needs before the
first frame, `67`/`68` being the NAL unit types inside it. Reach for it when a
stream "is" a codec it does not decode as, when `codec_name` looks right but
playback fails, or when you need the real profile of a raw stream. It can be a
great deal of output, so pair it with `-select_streams` and a `-show_entries` that
names only what you want.

## Diagnosis, in detail

| Symptom | What it means | Next move |
|---|---|---|
| `format_name=avi` but `codec_name=h264` and playback fails | a container that says one thing and holds another | remux (`-c copy` to MP4) and re-probe |
| a low `probe_score`, unreadable streams | the extension is a lie, or the file is truncated | `-show_error`, and compare against `media_probe`'s own message |
| ffprobe exits 1 with `No such file or directory` | the path, not the media | check it, or ask for it |
| `ffprobe exited with code 1 and said nothing` | no container was identified at all | the file is not media, is empty, or is truncated before its first header |
| a `wav` and a `png` both report one stream | both are single-stream files; only one has video | use `-select_streams v:0` and read whether it returns anything |

Two failures are worth reading literally. A **missing duration** is a fact about
the *container*, not a damaged file: an MP4 always carries one, a Matroska file
usually does, and a raw elementary stream cannot. And a **`nb_frames` of `N/A`**
means the header does not count frames - it does not mean zero, and
`-count_frames` is the way to replace the guess with a number at the cost of a
full decode.

## Where the browser verdict stops

`media_probe` ends with `playable` / `image` / `remux` / `transcode`, and that
verdict is an opinion about **Chrome/Firefox-class decoders** - which containers
they demux and which codecs they decode. It says nothing about:

- what this host's ffmpeg can **encode** (`ffmpeg -encoders` answers that), and
  nothing about whether a hardware encoder has a device behind it;
- whether a particular Safari or Edge build plays HEVC (the plugin prints
  `hevc` in its reason precisely because it is conditional);
- whether a file that is technically playable is *playable on the user's
  connection* - a 40 Mb/s MP4 is decodable and still unwatchable.

Read it as "this file needs a `-c copy` remux, or a re-encode, before a browser
will open it" and no further.
