# ffmpeg recipes

Working command shapes that do not fit in the skill summary: joining clips,
choosing a quality setting, and the slower operations whose cost has to be
planned for. Every command here is written as an `args` ARRAY for `media_run`,
and every one of them was run against real fixtures before it was written down.

## Joining clips

Two mechanisms, and they are not interchangeable:

| | `concat` demuxer | `concat` filter |
|---|---|---|
| works on | files with **identical** codecs, resolutions and stream layouts | anything, including parts of one file |
| cost | packet copy - near-instant | full decode and re-encode |
| quality | lossless | a generation loss |
| needs | a list file | `-filter_complex` and `-map` of the labelled outputs |
| failure mode | a truncated or broken join, silently | a filter error naming the unconnected input |

Demuxer, from a list file the agent writes with a file-write tool (`file 'a.mp4'`
on each line, one per part):

```
["-f","concat","-safe","0","-i","list.txt","-c","copy","joined.mp4"]
```

`-safe 0` is what allows absolute paths in the list. Without it, ffmpeg exits 1
with `[concat @ …] Unsafe file name 'C:\…'` and `Error opening input: Operation
not permitted` - the demuxer being careful, not a bug. A purely relative list
works under either setting, as long as the paths are relative to the list file.

Filter, which re-encodes:

```
["-i","a.mp4","-i","b.mp4","-filter_complex","[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]","-map","[v]","-map","[a]","-c:v","libx264","-crf","23","-preset","veryfast","-c:a","aac","joined.mp4"]
```

`n=2` is the part count and `v=1:a=1` says the output has one video and one audio
stream. The `[0:a]` reference **fails outright** when a part has no audio track -
that is the honest failure rather than a silent half-join. Supply silence, or
drop audio from every part:

```
["-i","a.mp4","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-map","0:v","-map","1:a","-shortest","-c:v","copy","-c:a","aac","with-silence.mp4"]
```

For differing resolutions, normalise in the filter graph rather than after it -
scale each input to one size, and pad rather than crop if the aspect ratios
differ, so nothing is lost:

```
["-i","a.mp4","-i","b.mp4","-filter_complex","[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]","-map","[v]","-map","[a]","-c:v","libx264","-crf","22","-preset","veryfast","-c:a","aac","joined.mp4"]
```

## Choosing the quality knob

The two delivery targets, spelled out as complete command shapes:

```
["-i","clip.mp4","-c:v","libx264","-pix_fmt","yuv420p","-crf","20","-preset","veryfast","-movflags","+faststart","-c:a","aac","-b:a","160k","-ac","2","out.mp4"]
["-i","clip.mp4","-c:v","libvpx-vp9","-crf","32","-b:v","0","-c:a","libopus","-b:a","96k","out.webm"]
["-i","clip.mp4","-c:v","libsvtav1","-crf","35","-preset","8","-c:a","aac","-b:a","160k","out.mp4"]
```

`-pix_fmt yuv420p` is not decoration in the first one: a source in `yuv444p` or
`yuvj420p` produces an H.264 some browsers draw as a black frame.
`libsvtav1`/`libaom-av1` are **build-dependent** - confirm with `-encoders`
first - and AV1 in MP4 is legal but less widely supported in older players than
AV1 in WebM.

| Knob | What it controls | When to use it |
|---|---|---|
| `-crf` | quality target, lower = better | the default for x264/x265/VP9/AV1 |
| `-b:v` | bitrate target | a hard size or bandwidth budget |
| `-preset` | encode time for size at one quality | `veryfast` inside a tool timeout |
| `-tune` | psychovisual weighting | `film`, `animation`, `stillimage` |

x264 `-crf` landmarks: 18 is visually lossless, 20 is normal delivery, 23 is
smaller and still good, 28 starts to look soft, 35 is visibly blocky. The file
size follows the content, not the number: on a 3-second 640x480 `testsrc2` clip
the video-only output was **411 kB at `-crf 20`** and **108 kB at `-crf 35`**
(`-preset veryfast`, same source) - a 4x range from one flag.

For VP9 and AV1, `-crf` outside a constrained mode is ignored unless you also set
`-b:v 0`, which is what puts the encoder in constant-quality mode. All three
targets below were measured on the same source:

```
["-i","clip.mp4","-c:v","libx264","-pix_fmt","yuv420p","-crf","20","-preset","veryfast","-movflags","+faststart","-c:a","aac","-b:a","160k","-ac","2","out.mp4"]
["-i","clip.mp4","-c:v","libvpx-vp9","-crf","32","-b:v","0","-c:a","libopus","-b:a","96k","out.webm"]
["-i","clip.mp4","-c:v","libsvtav1","-crf","35","-preset","8","-c:a","aac","-b:a","160k","out.mp4"]
```

AV1 in MP4 is legal but less widely supported in older players; AV1 in WebM is
the safer pairing. `libsvtav1` and `libaom-av1` are build-dependent - confirm
with `-encoders` before relying on either.

## Two-pass and target-size encodes

When the requirement is "under 10 MB", a quality target will not hit it. Measure
the duration, compute the bitrate, and constrain:

```
["-i","clip.mp4","-c:v","libx264","-b:v","1200k","-maxrate","1400k","-bufsize","2400k","-preset","veryfast","-c:a","aac","-b:a","128k","out.mp4"]
```

`-maxrate` with `-bufsize` is what makes the stream playable on a constrained
connection: without them, a `-b:v` average can spike well past the target.
Two-pass encoding is for x264 with a size target and no time budget; inside a
120 s tool timeout it is usually the wrong tool, and `-crf` plus `-preset` gets
close enough for delivery.

## Cost, and how to plan for it

| Operation | Relative cost | Why |
|---|---|---|
| `-c copy` (remux) | seconds | no decoding at all |
| stream copy + `-movflags +faststart` | seconds, plus one rewrite of the file | the index is rebuilt at the end |
| `-ss` before `-i` + `-frames:v 1` | milliseconds | one seek, one frame decoded |
| `-vf scale` + encode | real time and up | every frame decoded and re-encoded |
| `loudnorm` | one decode pass minimum, whole file | it analyses the entire programme |
| `-count_frames` (ffprobe) | one decode pass, whole file | see the ffprobe skill |
| `-c:v libx264 -preset medium` | several times `veryfast` | a few percent smaller |

A tool call is killed at `timeoutMs` (120 s by default, 600 s maximum), and a
killed encode leaves **no output file** - ffmpeg writes the container header at
the start and finishes it at the end. So for anything long: pass a larger
`timeoutMs` deliberately, prefer `-preset veryfast`, and consider `-t` on a
first pass to prove the graph before running the whole file.

## Hardware encoders, honestly

They exist, they are much faster, and they are the least portable thing in
ffmpeg. `-encoders` lists what the build was compiled with, **not** what this
machine can run:

- `h264_nvenc` needs an NVIDIA GPU and a working driver.
- `h264_qsv` needs an Intel iGPU with a working Media SDK runtime; on a machine
  without one it exits 1 with `Error creating a MFX session: -9`.
- `h264_amf` needs the AMD runtime; without it, `DLL amfrt64.dll failed to open`.
- `h264_videotoolbox` exists only on macOS, so it is absent from `-encoders` on
  a Windows or Linux host entirely.

Their option names are not x264's. `-crf` is not the quality knob: nvenc uses
`-cq`, qsv uses `-global_quality`, and each has its own `-preset` vocabulary.
Copying an x264 command line and swapping the encoder is how a "faster" encode
turns into a much worse one. If a hardware encoder is tried, compare the output
size and quality against `libx264 -crf 20 -preset veryfast` before handing it
over, and be ready for a 1-exit initialisation failure - that is a missing
device, not a problem with the command.

## Measuring without writing

Any filter can be tried with the null muxer, which decodes everything and writes
nothing. This is the cheapest way to check a filter graph, a loudness reading, or
whether a decode works at all:

```
["-i","clip.mp4","-vn","-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=summary","-f","null","-"]
["-i","clip.mp4","-vf","scale=320:-2","-f","null","-"]
```

Use `-f null -` (a literal `-` as the output url), not a platform's null device
name: it is the same invocation on every host.

## Vertical crops, GIFs and animations

Cropping 16:9 to 9:16 for a phone, using the frame's own height so the graph needs
no source size:

```
["-i","clip.mp4","-vf","crop=ih*9/16:ih,scale=540:960","-c:v","libx264","-crf","20","-preset","veryfast","-c:a","aac","vertical.mp4"]
```

A GIF holds 256 colours and the default quantiser shows it, so derive a palette
from the actual footage and feed it back - two commands, one image between:

```
["-i","clip.mp4","-vf","fps=12,scale=320:-1:flags=lanczos,palettegen","pal.png"]
["-i","clip.mp4","-i","pal.png","-lavfi","fps=12,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse","clip.gif"]
```

One command with `split[a][b];[a]palettegen[p];[b][p]paletteuse` also works, but
the two-command form reads better and lets you keep the palette.
`fps=12` is deliberate: a 30 fps GIF is enormous for no visible gain, and the
file is the whole cost of the format. Animated WebP is smaller and has alpha -
`-c:v libwebp -loop 0 -q:v 70` (build-dependent) - and APNG is
`-plays 0 -f apng`.

## Rotation, frames and contact sheets

**Rotation metadata is not rotation.** A phone video is often stored landscape
with a "rotate 90°" flag that `-c copy` preserves, so the pixels stay sideways and
only a player that honours the flag shows them upright - `media_probe` prints
`rotated 90°` for exactly that case. To produce pixels that are really rotated,
transpose: `-vf transpose=1` is 90° clockwise, `2` counter-clockwise, and `0`/`3`
transpose with a vertical flip. On a 640x480 source `transpose=1` yields 480x640.

`media_frames` covers the common cases (named timestamps, N even samples, one
tiled sheet, create-exclusive output, real dimensions read back). The raw filter
work it stands in for:

```
["-ss","5","-i","clip.mp4","-frames:v","1","-vf","scale=640:-1","shot.png"]
["-i","clip.mp4","-vf","fps=1,scale=160:-2","seq-%03d.png"]
["-i","clip.mp4","-vf","fps=1,scale=320:-1,tile=3x1","-frames:v","1","sheet.png"]
["-i","clip.mp4","-i","pal.png","-lavfi","fps=12,scale=320:-1[x];[x][1:v]paletteuse","out.gif"]
["-f","lavfi","-i","testsrc2=size=640x480:rate=30","-t","2","-c:v","libx264","-crf","30","-pix_fmt","yuv420p","-an","bars.mp4"]
```

One input feeds one chain in `-vf`. The moment there are **two inputs** or one
stream has to be used **twice**, it is `-filter_complex` (`-lavfi` is the same
option): `[0:v]`/`[1:v]` name inputs, `[x]` names a chain's output for `-map`.
`tile=3x1` lays three frames in a row and `-frames:v 1` writes the single tiled
result - the grid is yours to choose, which is the one thing `media_frames`' sheet
does not offer. `-f lavfi -i testsrc2=…` / `sine=…` synthesises a test clip with
no source file at all, which is how to prove a filter works before pointing it at
the user's video.

`-vf fps=N` is a frame rate change by dropping and duplicating frames - correct
for "make it smaller", wrong for retiming. Retiming is `setpts` (`setpts=0.5*PTS`
plays twice as fast), and speeding the audio to match is `atempo=2.0`.

## Reading a failure

`media_run` names the argv it ran, the exit code, the elapsed time, the files the
ffmpeg log named (each one stat'ed, so "not written" is stated rather than
assumed) and the combined output. On a non-zero exit the **last lines are the
diagnosis** - the tool says so in as many words. Every message below was
produced on this harness's own host, so the wording is what a reader will
actually see:

| Last lines say | Means | Do |
|---|---|---|
| `File 'out.mp4' already exists. Exiting.` | the injected `-n` did its job | pass `overwrite: true`, or write a new name |
| `Only VP8 or VP9 or AV1 video … supported for WebM` then `Could not write header (incorrect codec parameters ?): Invalid argument` | the container/codec pair does not fit | change the container or re-encode the codec |
| `Error parsing filterchain 'nosuchfilter=1' around:` followed by `Invalid argument` | a filter name the build does not have, or a graph it cannot parse | the `[Parsed_<name>_0]` prefix names the filter that took the blame; check the build with `-filters` |
| `[Parsed_scale_0] Invalid size 'abc'` then `Error initializing filters` | the filter parsed but rejected the value | read that filter's own option list |
| `Option vf (set video filters) cannot be applied to input url clip.mp4` | an output option written before `-i` | move it after the input |
| `Error opening input: No such file or directory` | the input path | check it with `media_probe`; never guess a path |
| `Error creating a MFX session: -9` / `DLL amfrt64.dll failed to open` | a hardware encoder with no device behind it | fall back to `libx264` |
| `[concat @ …] Unsafe file name 'C:\…'` then `Error opening input: Operation not permitted` | a `concat` list with absolute paths and no `-safe 0` | add `-safe 0` |

"File exists" is the one that most often looks like a media problem and is not:
`-n` is this pack being safe, and the fix is a different output name or an
explicit `overwrite: true`. **Killed after N ms** is a timeout rather than a
failure of the command: raise `timeoutMs` (up to 600000) or do less work with
`-preset veryfast` or `-t`.

A `Stream mapping:` block is worth reading on every copy that matters - it is
printed at `-loglevel info`, which means passing that level yourself, and it
shows each input stream becoming a numbered output stream. See the "Mapping
streams" section of the skill for what it proves.
