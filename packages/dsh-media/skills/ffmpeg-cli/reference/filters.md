# Filters, and the graphs that carry them

The skill summary carries the shapes you will use most. This is the rest:
geometry, two-input graphs, text, time, look, and how to watch a graph work
without writing a file. Every fenced command here is executed by
`scripts/checks/check-media-examples.mjs` against fixtures built for the purpose,
so none of them is a guess.

## `-vf` or `-filter_complex`?

One input feeding one chain is `-vf`. The moment there are **two inputs**, or one
stream has to be **used twice**, it is `-filter_complex` (`-lavfi` is the same
option), where `[0:v]`/`[1:v]` name inputs, `[label]` names a chain's output, and
`-map [label]` picks what the output carries.

```
["-i","clip.mp4","-vf","scale=320:-2,fps=10","-c:v","libx264","-crf","23","-preset","veryfast","-an","small.mp4"]
```

`-vf` is a chain: filters are separated by commas and each one's output feeds the
next. A filter's own options are separated by colons - `scale=320:-2` - and the
order in the chain *is* the order they run in, which is why `crop` then `scale`
sizes the cropped frame and `scale` then `crop` sizes the original one.

```json no-check
["-i","clip.mp4","-vf","drawtext=fontfile=<path to a .ttf>:text='Draft':fontcolor=white:fontsize=24:x=10:y=10","-c:v","libx264","-crf","20","-preset","veryfast","-an","stamped.mp4"]
```

That one is a template on purpose and the tracked check skips it: **there is no
portable path to a font file**, and on Windows `drawtext` dies outright without a
`fontfile` (measured - see `platforms.md`, which also has the doubled-backslash
rule the path needs). Fill in your host's font and it is the command above.

## Geometry: scale, crop, pad, rotate

```
["-i","clip.mp4","-vf","scale=320:-2,crop=320:180:0:0,pad=320:240:0:30:black","-c:v","libx264","-crf","23","-preset","veryfast","-an","shaped.mp4"]
["-i","clip.mp4","-vf","scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1","-c:v","libx264","-crf","23","-preset","veryfast","-an","letterboxed.mp4"]
["-i","clip.mp4","-vf","transpose=1","-frames:v","1","turned.png"]
```

- `scale=w:h`, with **`-1`** letting ffmpeg choose a dimension and **`-2`**
  choosing it *rounded to an even number* - which H.264 and most video codecs
  require. `scale=321:-1` on 640x480 gives 321x241 (odd, and it will not encode);
  `scale=321:-2` gives 321x240.
- `crop=w:h:x:y` cuts a rectangle from **every** frame, `x`/`y` from the top left.
- `pad=w:h:x:y:colour` grows the frame. Paired with
  `scale=...:force_original_aspect_ratio=decrease` it is the letterbox: fit
  inside, then pad the difference, then fix the sample aspect ratio.
  `(ow-iw)/2` is "half the leftover width" - the arithmetic sets the centring.
- `transpose=1` is a real 90° clockwise rotation of the **pixels**. A phone
  video's "rotate 90°" is a metadata flag that `-c copy` preserves and that
  `media_probe` prints as `rotated 90°`; that flag is not a rotation. `2` is
  counter-clockwise, `0`/`3` transpose with a vertical flip.
- `-pix_fmt yuv420p` (or the `format=yuv420p` filter) is not decoration: a source
  in `yuv444p` produces an H.264 some browsers draw as a black frame. For a
  delivery encode the output option is the simpler spelling.

## Two inputs: overlay, watermark, picture-in-picture

```
["-i","clip.mp4","-i","a.mp4","-filter_complex","[1:v]scale=160:-2[pip];[0:v][pip]overlay=W-w-10:H-h-10[v]","-map","[v]","-map","0:a","-c:v","libx264","-crf","23","-preset","veryfast","-c:a","copy","pip.mp4"]
["-i","clip.mp4","-i","pal.png","-filter_complex","[1:v]scale=120:-2[wm];[0:v][wm]overlay=10:10:enable='between(t,0,1)'[v]","-map","[v]","-c:v","libx264","-crf","23","-preset","veryfast","-an","watermark.mp4"]
```

`overlay=x:y` places the **second** input on the first. `W`/`H` are the main
video's width and height, `w`/`h` the overlay's, so `W-w-10:H-h-10` is "bottom
right, ten pixels in" and it needs no knowledge of either size. `enable='...'` is
the timing expression - `between(t,0,1)` shows it for the first second,
`gte(t,5)` from five seconds on - and `t` is the output timestamp.

When a filter has two inputs and one output, forgetting `-map "[v]"` gives a
"Filtergraph ... was specified for output stream ... but not used" failure. Map
every labelled output you want, and map the streams you are not filtering
explicitly (that is what `-map 0:a` is doing above).

## Text: subtitles burned in

```
["-i","clip.mp4","-vf","subtitles=subs.srt","-c:v","libx264","-crf","23","-preset","veryfast","-c:a","copy","burned.mp4"]
```

`subtitles=` burns a subtitle file into the pixels - **irreversible**, unlike
`-c:s mov_text`/`-c:s srt`, which carries the track beside the video. It needs
libass in the build (`-filters` answers whether it is there), and the path is a
filter option, so `platforms.md`'s escaping rules apply to anything absolute.
Prefer a **relative filename plus `cwd`**: that is the form above, and it is the
one that needs no escaping on any host. `ass=` is the same filter for a styled
`.ass` file.

## Time: rate, retiming, and picking frames

```
["-i","clip.mp4","-vf","fps=10","-c:v","libx264","-crf","23","-preset","veryfast","-an","fps10.mp4"]
["-i","clip.mp4","-filter_complex","[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]","-map","[v]","-map","[a]","-c:v","libx264","-crf","23","-preset","veryfast","faster.mp4"]
["-i","clip.mp4","-vf","thumbnail=30,scale=320:-2","-frames:v","1","thumb.png"]
["-i","clip.mp4","-vf","select='eq(pict_type,I)',scale=160:-2,tile=3x1","-frames:v","1","keys.png"]
```

- `-vf fps=N` **changes the frame rate by dropping and duplicating frames**. It is
  correct for "make it smaller" and wrong for retiming: it does not make anything
  happen faster.
- Retiming is `setpts`: `setpts=0.5*PTS` plays at twice the speed, `2*PTS` at
  half. Audio has its own filter and its own limits - `atempo` takes 0.5-100 per
  instance (chain `atempo=2.0,atempo=2.0` for 4x) - and a video-only `setpts`
  leaves the sound at its original length, so do both or neither.
- `thumbnail=N` picks one representative frame per N, which is why it is the cheap
  poster-frame filter; `select='eq(pict_type,I)'` keeps only keyframes, and
  `tile=3x1` lays a run of frames into one picture. The comma inside the quoted
  expression is part of the expression, not a chain separator.
- `-frames:v 1` limits the run to one frame. Writing ONE picture wants a name with
  no `%` pattern; ffmpeg's image2 muxer refuses a bare name in some paths with
  *"The specified filename does not contain an image sequence pattern"*, and the
  fix there is `-update 1`, not a different extension.

## Look: contrast, colour, sharpness, noise

```
["-i","clip.mp4","-vf","eq=contrast=1.1:saturation=1.2,unsharp=5:5:0.8","-c:v","libx264","-crf","23","-preset","veryfast","-an","graded.mp4"]
["-i","clip.mp4","-vf","hqdn3d=4:3:6:4.5","-c:v","libx264","-crf","23","-preset","veryfast","-an","denoised.mp4"]
```

`eq` is one filter with several independent knobs (`contrast`, `brightness`,
`saturation`, `gamma`); `hue=h=90` rotates hue, `hue=s=0` desaturates to grey.
`unsharp` and `hqdn3d` are the ordinary sharpen and denoise pair, and both have
four numbers - luma/spatial first, chroma/temporal after - so a `5:5:0.8`
sharpening never touches colour. Every one of these is a real generation loss:
they decode and re-encode, so ask whether the user wants the pixels changed.

## One input, several uses

```
["-i","clip.mp4","-filter_complex","[0:v]split=2[a][b];[a]scale=320:-2[x];[b]scale=160:-2[y]","-map","[x]","-map","[y]","-c:v","libx264","-crf","23","-preset","veryfast","-an","two-sizes.mp4"]
```

`split=2[a][b]` is what makes one stream available twice; a graph that mentions
`[0:v]` twice without splitting is the "unconnected output" failure. **Every label
a graph produces must be consumed exactly once** - `[x]` and `[y]` above are both
mapped, into one file carrying two video streams - or the command fails with
`Filter scale:default has an unconnected output`, naming the *filter* rather than
the label you forgot to map. Chains are separated by **semicolons**.

## Audio inside a graph

```
["-i","two.mkv","-filter_complex","[0:a:0][0:a:1]amix=inputs=2:duration=shortest[a]","-map","[a]","-c:a","aac","-b:a","160k","mixed.m4a"]
["-i","clip.mp4","-vn","-af","volume=0.5","-c:a","aac","quieter.m4a"]
```

`amix` sums inputs (`duration=shortest` stops at the first to end, or every output
is as long as the longest); `volume=0.5` is -6 dB and `volume=6dB` is the other
direction. For a measured, target-driven level there is `loudnorm`, which is a
*measurement plus a rewrite* and is covered in the skill summary, including the
two-pass form that actually guarantees a true-peak target.

## Watching a graph work

```
["-i","clip.mp4","-vf","scale=320:-2","-f","null","-"]
["-i","clip.mkv","-c","copy","-progress","pipe:1","progress-out.mp4"]
```

`-f null -` decodes everything and writes nothing, so a graph, a filter name, a
loudness reading or a decode can all be proved for the cost of the decode and no
disk. `-progress pipe:1` prints machine-readable `key=value` lines on stdout -
`out_time_us` is the one this pack's own remux job reads for its percentage - and
it is how to watch a long job without parsing ffmpeg's human output.

## When a filter fails

The diagnosis is in the `[Parsed_<name>_0]` prefix, which names the filter that
took the blame, and in the option it names - not always the option you got wrong.
The full table is in `failures.md`; the four you will meet most are there too:

- `No such filter: 'x'` - this **build** does not have it (`-filters` answers
  definitively, and a build's filter list is host-dependent).
- `Error parsing filterchain` - a graph the parser cannot read: an unclosed
  bracket, a label used twice, a comma inside an expression that should have been
  quoted.
- `[Parsed_scale_0] Invalid size 'abc'` - the filter parsed but rejected the
  value.
- `Unable to parse option value "..." as image size` / `Error applying option
  'original_size'` - a Windows drive colon inside a filter value that lost its
  escaping. The option named in the error has nothing to do with the mistake; see
  `platforms.md`.
