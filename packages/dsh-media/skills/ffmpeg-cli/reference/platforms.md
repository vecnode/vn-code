# One argv, every OS

`media_run` takes an **argv array**, and there is no shell between you and
ffmpeg. That is not a detail of this harness - it is the reason a single command
shape works on Windows, macOS and Linux, unchanged:

```
["-i","clip.mp4","-c:v","libx264","-crf","20","-preset","veryfast","-c:a","aac","out.mp4"]
```

That one array is the command on all three. **Do not write per-OS variants of the
same command.** A reader who is handed a Windows line, a macOS line and a Linux
line learns that the command depends on the host, which is false here, and the
first thing they will try is a shell string, which `media_run` refuses.

What genuinely differs per host is a short list, and it is all below. Everything
here was measured on this harness's own host (Windows, ffmpeg 6.x from
gyan.dev - a full build with `libass`, `libfreetype` and no fontconfig).

## There is no shell, so nothing is expanded

| you write in the argv | what ffmpeg receives | result |
|---|---|---|
| `"*.mp4"` | the five characters `*.mp4` | **exit 1** - `Error opening input: Invalid argument`. ffmpeg has no glob for `-i` |
| `"%TEMP%\\clip.mp4"` | those characters, literally | **exit 1** - `Error opening input: No such file or directory` |
| `"~/videos/clip.mp4"` | those characters, literally | **exit 1** - same. No home expansion either |
| `"$HOME/clip.mp4"` | those characters, literally | **exit 1** - same |

Consequences worth remembering:

- **A sequence is ffmpeg's own pattern**, not the shell's: `"seq-%03d.png"` as an
  *output*, or `-pattern_type glob -i "*.png"` when a glob really is what you
  want for image inputs.
- **`-f null -` is the null muxer on every OS.** Do not reach for `/dev/null`
  (absent on Windows) or `NUL` (absent elsewhere); the literal `-` is the output
  url that works everywhere.
- **Nothing needs quoting for a shell**, so a path with a space, a `&` or a `%`
  is just its own array element. This is the whole benefit of the argv interface.

## Paths inside a FILTER value: the one real trap

A path given to `-i` is an array element and needs no escaping at all - measured:
`["-i","C:\\videos\\clip.mp4","-c","copy","out.mp4"]` exits 0 with backslashes,
spaces and all.

A path given **inside a filter option** (`subtitles=`, `ass=`, `movie=`,
`drawtext=fontfile=`, `amovie=`) is parsed **twice** - once by the filtergraph
parser and once by the filter's own option parser - and on Windows the colon of
the drive letter is the separator of the second parser. Measured, passing the
argv element directly (no shell), on a file that exists:

| the element's value | result |
|---|---|
| `subtitles=C:/videos/subs.srt` | **exit 22** |
| `subtitles=C\:/videos/subs.srt` | **exit 22** - the widely quoted single-backslash form |
| `subtitles=C\\:/videos/subs.srt` | **exit 0** |
| `subtitles=C\\:\\videos\\subs.srt` | **exit 22** - escaped colon with backslash separators |
| `subtitles=subs.srt` (relative, with `cwd` set) | **exit 0** |

The single-backslash form fails with a message that names the wrong thing
entirely, which is why this is worth its own table:

```text
[Parsed_subtitles_0 @ ...] Unable to parse option value
"/videos/subs.srt" as image size
Error applying option 'original_size' to filter 'subtitles': Invalid argument
```

The parser ate one level of the escape, so the colon it was handed split the
options and the remainder of the path was read as a *different option's* value.
`original_size is not a subtitle file` is the shape of every symptom of this
class - the diagnosis is never the option named.

**Two consequences, and both are practical.**

1. **The portable form is a relative filename plus `cwd`.** `media_run`'s `cwd`
   defaults to the conversation workspace, so `"subtitles=subs.srt"` just works,
   on every OS, with no escaping to get wrong. Prefer it whenever the file is
   beside the media file.
2. **When an absolute path is unavoidable, write the drive colon as TWO
   backslashes, and use forward slashes for the separators.** In a JSON argv
   array - which is what you actually write - a literal backslash is itself
   escaped, so the element that reaches ffmpeg as `C\\:/videos/subs.srt` is
   written in the call as:

```json no-check
["-i","clip.mp4","-vf","subtitles=C\\\\:/videos/subs.srt","-c:v","libx264","-crf","20","burned.mp4"]
```

The tracked example check skips that block (it names a path that does not exist
on any given host, so there is nothing to run); substitute your own path and it
is the form above that works. Three layers, and it is worth counting them:
**one** backslash is what ffmpeg's option parser must see to treat the colon as
a literal, **two** is what the filtergraph parser must be handed for that to
survive, and **four** is what the JSON text must contain for the string `C\\:` to
arrive. Measured end to end
through `media_run`: exit 0, and the file is written. On macOS and Linux none of
this applies - `/videos/subs.srt` is the whole story.

`drawtext` is the same rule with a worse failure. Its font file is a filter
option, so:

| `drawtext` font file | result |
|---|---|
| `fontfile=C\:/Windows/Fonts/arial.ttf` | **the process dies** - a `Fontconfig error: Cannot load default config file` and an access violation, not an ffmpeg error message |
| `fontfile=C\\:/Windows/Fonts/arial.ttf` | **exit 0** |
| no `fontfile` at all | **the process dies the same way** - this Windows build carries libfreetype without fontconfig, so there is no default font to fall back to |

So on Windows `drawtext` needs its font spelled with the doubled backslash, and
it needs `fontfile` named. Where a font lives is per-OS, which is the reason the
`drawtext` example in `reference/filters.md` is a template rather than a
runnable command: there is no portable path to a `.ttf`.

## Concat list files

The `concat` demuxer reads a list file, and the list is a *file* rather than an
argv element, so its rules are its own. Measured on this host:

| the list contains | `-safe 0`? | result |
|---|---|---|
| `file 'a.mp4'` (relative) | either way | exit 0 |
| `file 'C:\videos\a.mp4'` | yes | exit 0 |
| `file 'C:/videos/a.mp4'` | yes | exit 0 |
| `file 'C:\videos\a.mp4'` | **no** | **exit 1** - `Error opening input: Operation not permitted` |

Both separators work *inside* the list, and an absolute path needs `-safe 0` -
the demuxer is being careful, not broken. Write the file through a file-write
tool with:

- one `file '<path>'` per line, **LF endings**, UTF-8 **without a BOM**;
- forward slashes for preference, since they need no thought on any host;
- a `'` inside a filename spelled `'\''`;
- relative paths resolved against **the list file's own directory**, not `cwd` -
  which is the form to prefer, because it makes `-safe 0` unnecessary.

## Where ffmpeg comes from, and how to point it at yours

The pack resolves, in order: `DSH_MEDIA_FFMPEG` / `DSH_MEDIA_FFPROBE`, then
`PATH` (the machine's own install), then the pinned verified copy under
`$DSH_HOME/dsh-media/bin/<platform>-<arch>/`, then **nothing** - answered
immediately, with the pinned download started in the background.

**Never tell a user to install ffmpeg**, and never assume a version. When a call
answers that there is no ffmpeg, that sentence is the instruction: they can set
the variable for the harness process and restart it, spelled per shell -

| shell | command |
|---|---|
| PowerShell | `$env:DSH_MEDIA_FFMPEG = 'C:\ffmpeg\bin\ffmpeg.exe'` |
| cmd | `set DSH_MEDIA_FFMPEG=C:\ffmpeg\bin\ffmpeg.exe` |
| sh / zsh / bash | `export DSH_MEDIA_FFMPEG=/usr/local/bin/ffmpeg` |

- and note that this is a change to the **harness process**, not something a tool
  call can do for them: it takes a restart. `DSH_MEDIA_PREFER_BUNDLED=1` makes the
  provisioned copy win over `PATH` instead. darwin-arm64 is deliberately
  unpinned (no Apple-Silicon build publishes both a stable URL and a checksum),
  so on that platform the answer is `brew install ffmpeg`.

## Hardware encoders: which OS has which

They are much faster and the least portable thing in ffmpeg. `-encoders` lists
what the **build** was compiled with, never what the **machine** can run.

| encoder | where it exists | needs | not `-crf` |
|---|---|---|---|
| `h264_videotoolbox` | macOS only - absent from `-encoders` on a Windows or Linux host entirely | nothing beyond the OS | `-q:v` / `-b:v` |
| `h264_nvenc` | Windows and Linux | an NVIDIA GPU and a working driver | `-cq`, own `-preset` names |
| `h264_qsv` | Windows and Linux | an Intel iGPU with a Media SDK/oneVPL runtime | `-global_quality` |
| `h264_amf` | Windows | the AMD runtime (`amfrt64.dll`) | own `-quality` / `-qp_*` |

A missing runtime is a **1-exit initialisation failure** - `Error creating a MFX
session: -9`, `DLL amfrt64.dll failed to open` - which is a missing device rather
than a bad command. Before relying on any of them, read that encoder's own
options (`ffmpeg -h encoder=h264_nvenc` via `media_run`) instead of copying an
x264 command line across, and compare the output against
`libx264 -crf 20 -preset veryfast` before handing it over.

## Capture devices: the one family that is genuinely per-OS

A command line cannot be the same across hosts here, because the *input format*
is the platform's:

| OS | input | example |
|---|---|---|
| Windows | `dshow` | `["-f","dshow","-i","video=Integrated Camera","-t","10","cap.mp4"]` |
| macOS | `avfoundation` | `["-f","avfoundation","-i","0","-t","10","cap.mp4"]` |
| Linux | `v4l2` / `x11grab` | `["-f","v4l2","-i","/dev/video0","-t","10","cap.mp4"]` |

Treat these as descriptions rather than recipes: a harness usually runs as a
service with no camera, no microphone and no display attached, so the attempt
fails with a device error. When capture is genuinely wanted, confirm the device
list first - `["-f","dshow","-list_devices","true","-i","dummy"]` on Windows,
`["-f","avfoundation","-list_devices","true","-i",""]` on macOS - and report
what is there instead of guessing a name.

## What is the same everywhere

Worth stating once, because it is most of the surface:

- `-f lavfi -i testsrc2=...` / `sine=...` - synthetic inputs, no file, every OS,
  and the cheapest way to prove a filter graph before pointing it at real media.
- `-f null -` - decode everything, write nothing.
- `%03d` image-sequence patterns on the output side.
- `-progress pipe:1` - machine-readable progress on stdout, which is what this
  pack's own remux job reads (`out_time_us`).
- `-nostdin`, which the tool injects, so a command can never block on input.
- Relative paths resolved against `cwd`, which the tool defaults to the
  conversation workspace.
