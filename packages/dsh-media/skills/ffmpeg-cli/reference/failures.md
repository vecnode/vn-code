# Reading a failure

`media_run` answers with the argv it ran, the exit code, the elapsed time, the
files ffmpeg's own `Output #0, ... to '...'` lines named (each one **stat'ed**, so
"not written" is stated rather than assumed) and the combined output with head and
tail kept and the dropped count named.

Two rules make the output readable, and the second is the one people get wrong:

1. **The last lines are the summary.** They name what failed, in ffmpeg's words.
2. **The cause is usually the FIRST error line above them**, because a run that
   dies in a filter graph still finishes with a generic `Conversion failed!`.
   Scan up for the first `[Parsed_<name>_0]`, `[<muxer> @ ...]` or `Error ...` line
   and read that one.

**A non-zero exit is not the only failure, and exit 0 is not proof of a file.**
Read the files line: a `-ss` past the end of a file exits **0** having written
nothing (`media_frames` says so in as many words), and a command whose output
never materialised is a failed call however green the exit code is.

## The three that are not ffmpeg's fault

| Last lines say | What it really is | Do |
|---|---|---|
| `File 'out.mp4' already exists. Exiting.` | this pack's injected `-n` doing its job | pass `overwrite: true`, or write a new name |
| `Killed after N ms` | the tool's own deadline | raise `timeoutMs` (up to 600000), or do less: `-preset veryfast`, `-t` |
| `... N chars dropped (head and tail kept)` | the output cap, not an error | pass `-loglevel error`, or narrow the command |

`File 'out.mp4' already exists.` is the message that most often looks like a media
problem. It is a safety feature: the user's original is never the output, and
replacing a file takes an explicit `overwrite: true`.

## The catalogue

| Last lines say | Means | Do |
|---|---|---|
| `Only VP8 or VP9 or AV1 video ... supported for WebM` then `Could not write header (incorrect codec parameters ?): Invalid argument` | the container/codec pair does not fit | change the container to match the codec, or re-encode the codec to match the container - never "try copy, then transcode blindly" |
| `Error parsing filterchain 'nosuchfilter=1' around:` then `Invalid argument` | a filter name this build does not have, or a graph it cannot parse | the `[Parsed_<name>_0]` prefix names the filter that took the blame; `-filters` answers definitively |
| `[Parsed_scale_0] Invalid size 'abc'` then `Error initializing filters` | the filter parsed but rejected the value | read that filter's own option list |
| `Filter scale:default has an unconnected output` | a labelled output of the graph is never mapped | `-map` every label; the error names the filter, not the label you forgot |
| `Output file #0 does not contain any stream` | nothing was mapped into the output | check `-map`, and that a filter's output was actually mapped |
| `Option vf (set video filters) cannot be applied to input url clip.mp4` | an output option written **before** `-i` | move it after the input |
| `Unable to parse option value "..." as image size` then `Error applying option 'original_size' to filter 'subtitles': Invalid argument` | a Windows drive colon inside a FILTER value, one escape level short | see `platforms.md` - the option named in the error has nothing to do with the mistake |
| `Fontconfig error: Cannot load default config file` and then the process dies (exit `-1073741819` / `3221225477`, no ffmpeg error at all) | `drawtext` with no usable `fontfile` on a build without fontconfig | name `fontfile`, with the doubled-backslash drive colon from `platforms.md` |
| `Error creating a MFX session: -9` / `DLL amfrt64.dll failed to open` | a hardware encoder with no device behind it | fall back to `libx264`; that is a missing GPU, not a bad command |
| `[concat @ ...] Unsafe file name 'C:\...'` then `Error opening input: Operation not permitted` | a concat list with an absolute path and no `-safe 0` | add `-safe 0`, or use paths relative to the list file |
| `Error opening input: No such file or directory` | the input path | `media_probe` it, or ask - and remember nothing expands: `%TEMP%`, `$HOME` and `~` arrive literally |
| `Error opening input: Invalid argument` with a `*` in the path | the shell-free interface: ffmpeg received the literal `*.mp4` | name the file, use ffmpeg's own `%03d` pattern, or `-pattern_type glob` |
| `moov atom not found` | a truncated or partially downloaded MP4 | the file is incomplete; re-fetch it rather than retrying ffmpeg |
| `Invalid data found when processing input` | not media at all, or a header that is truncated | check the extension is not a lie; a text file named `.mp4` looks exactly like this |
| `Conversion failed!` **alone** | ffmpeg's generic tail | the cause is the first error line above it - read that one |
| ffprobe exits 1 and says nothing | no container was identified | the file is not media, is empty, or is truncated before its first header |

## What an exit code can and cannot tell you

| Exit | What it means |
|---|---|
| `0` | the command ran to the end. Not that the output is what you wanted: check the files line, the duration and `media_probe` on the result |
| `1` | ffmpeg said no, and said why in the log. Read the first error line |
| `22` (`Invalid argument`) | almost always an option or a value ffmpeg could not parse - a filter argument, a container/codec pair, a path inside a filter |
| `-1073741819` / `3221225477` | the process died rather than failed (an access violation on Windows). A filter is reading something it cannot, and the usual cause is a missing font or a fontconfig-less build - see the `drawtext` row above |

## After a failure

- **Do not retry the same command with a longer timeout.** A parse failure, a
  codec/container mismatch and a bad path are all instant and all permanent.
- **Do not guess the path.** `media_probe` the input, or ask for it.
- **Fix one thing and re-run the same command**, so the difference in the answer is
  the difference you made.
- **Report what you changed** when you hand a file back, and quote the error
  sentence rather than paraphrasing it.
