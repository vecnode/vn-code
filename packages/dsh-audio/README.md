# dsh-audio (alpha.4)

**Audio opens as a waveform, not as a file whose bytes happen to be sound - and
the machine's own audio devices live one click away in the left column.**

The shipped preview gives an audio file a browser `<audio>` element and nothing
else: no waveform, no time ruler, no zoom - and for AIFF, in Chrome, not even
playback, because Chrome cannot decode it. This package is the right bar's
`audio` tab type for **WAV/RIFF, AIFF/AIFC and FLAC**, and it draws the thing a
recording is actually looked at through: **one track per channel, in rows, a time
ruler, a min/max envelope with the RMS band inside it, zoom down to individual
samples, drag-to-select, and playback with a playhead that follows the audio
clock.**

Alpha.3 adds the other half of "audio in this app": an **Audio** row in the left
column's global-panel list, immediately **above Plugins**, that opens a modal
listing **this machine's audio devices** - output and input, one card each, with
the one you picked marked, a tone to prove the pick by ear, and a live level
meter off the chosen microphone. See
[The Audio console](#the-audio-console-alpha3).

It is a **client-only** package: bytes come from the harness's own
`workspaceFiles` remote, so there is no route, no host-side state, and no path
policy of its own to get wrong.

**Alpha.4 fixes the two halves of reading those bytes**, and both were failures
against the real Remote rather than against this package's own logic:

- the **whole-file** read (the FLAC path) asked for `readAll`, which the
  namespace does not have - it declares `changes`, `list`, `read`, `readBytes`
  and `stat` - so no FLAC could be decoded; it is now `readBytes(sessionId,
  path, {}, signal)` (empty options), and a payload that arrives truncated
  (`eof: false`) is refused instead of handed to the browser's decoder;
- every **window** was decoded as base64 text (`atob(String(...))`) although the
  generated result codec declares `value.data` as a `Uint8Array` (the carrier
  decodes its binary frame into one, and the shipped preview hands it straight
  to `new Blob`), so a correctly delivered window threw `InvalidCharacterError`
  instead of drawing a waveform. Both paths now go through `bytesOf`, which
  accepts a `Uint8Array`, an `ArrayBuffer`, a byte array and base64 text, and
  the tracked check drives that decode in all four shapes instead of grepping
  for a call.

## What it adds

| | |
|---|---|
| **A real waveform** | **One TRACK per channel, in a row of its own** - a file with eight channels shows eight rows, never eight overlays - with the **min/max envelope filled** and the **RMS drawn inside it as a brighter core**: the envelope is the accent at 55%, the RMS core inside it is the same accent **solid**, and a professional view shows both - the envelope is what you see, the RMS is what you hear. **ONE accent paints all four surfaces the canvas has**: the app's own `--dsw-alias-brand-primary`, split by `withAlpha` into envelope 55%, RMS core solid, selection 16% and selection edge 50% - in the fallback path too, so a theme that cannot supply the token changes the **shade** and nothing else. The 48 px gutter beside each row is a cell of **exactly that row's height**, holding the track's name and its amplitude reading together. A stereo pair is `L`/`R`, more tracks are numbered, and a **mono file has no letter at all** (a lone "M" is a letter the reader has to decode, and one track has nothing to tell apart from). The toolbar's `N tracks` / `1 track` button collapses the view to a single row and back. |
| **Resizable tracks** | **Drag any track's bottom edge** (the hairline in the gutter; the cursor turns into `ns-resize`) and the height changes - **for every track at once**, from 24 px to 420 px, because a waveform is read across tracks and separately sized tracks would not line up. The envelope, the ruler and the gutter cells all follow. |
| **Adaptive time ruler** | "Nice" 1-2-5 steps from 0.1 ms to 1 h, chosen from the zoom, with a major/minor tick hierarchy and labels whose width is **measured**, so they never collide. |
| **Zoom by layout** | 1 px/s (an hour in a pane) to 500000 px/s. `+`/`-` walk the ladder, `Fit` fits the file, `Ctrl`/`Cmd` + wheel zooms **at the pointer**, and a bare wheel scrolls sideways - time is the axis here. Past ~3 px per sample the samples themselves are drawn as stems. |
| **dBFS or linear** | A toggle, because a linear scale hides everything a compressor did. The dBFS scale draws a 72 dB range, and the gutter says which reading the track is showing. |
| **Amplitude gain** | `Shift` + wheel scales the drawing 0.25x to 16x, because "-6 dBFS" and "a line at the top" are two readings of the same take - a gesture, with **no button** taking up toolbar space (the toolbar counts tracks instead). |
| **Playback** | Play/pause, click to seek, `Space` to toggle, `Home`/`End`, one screen-pixel per arrow press, and a **playhead driven by the AudioContext clock** rather than a CSS animation, so the line cannot drift from the sound. Drag a range and it plays that range **looped**. |
| **Selection** | Drag on the waveform to select; the status line reports the selection's duration, peak and RMS - and **names where the numbers came from** ("from the samples" or "from 4096-sample buckets"). |
| **Details panel** | Container, codec, sample rate, channels, bit depth, frame count, duration, size, which decoder drew it, the peak pyramid's levels, and any metadata the file carries: RIFF `LIST/INFO`, BWF `bext` (description, originator, date), AIFF `NAME`/`AUTH`/`ANNO`, FLAC's Vorbis comment. |
| **Honest failure** | A codec this viewer cannot decode is **named** (`IMA ADPCM`, `MACE 3:1`, `GSM 6.10`, `ima4`; A-law and mu-law are decoded); a `fmt ` chunk that declares a **block align narrower than one frame** is refused **by name**, with the frame size and the declared stride in the sentence, instead of believing a stride that would read each channel out of the next frame's bytes; a file that simply ends before its chunks do is answered by the **parser's own verdict**, not by the 8 MiB ceiling sentence a prefix earns; a truncated file draws what exists and says the rest is **UNKNOWN** rather than silence; a FLAC too big to hand the browser says how big it is and why. |

## The Audio console (alpha.3)

**A browser plays its audio wherever the OPERATING SYSTEM sends it** - and a
machine with a headset, a monitor with speakers and a USB interface has three
answers to that. Nothing in the harness answered the question before this, so the
left column's global-panel list (the one **Plugins** is in) now carries an
**Audio** row immediately **above** Plugins, and it opens this:

| | |
|---|---|
| **The devices, as cards** | One card per device the browser reports - outputs and inputs - with the browser's own label, the six characters of its id, and the **system default** card naming the device it actually points at (read off the shared `groupId` Chromium reports for the alias and its target, which is the only way to *show* it). A device the browser gives no name for is still a real device: it is drawn, named by its position (`Output 2`), and the section says that the names are hidden until this page is allowed to capture audio - with a **Show device names** control that asks for exactly that and nothing else. A headset plugged in **re-enumerates live** (`devicechange`). |
| **Output routing** | Pick an output and press the tone: `AudioContext.setSinkId` (Chromium 110+/Opera 96+) moves **the one AudioContext this package plays through**, which is the graph the waveform player's own playback uses too - so the choice is the app's choice, not the console's. `HTMLMediaElement.setSinkId` moves **every media element in the document**, including the shipped preview's own MP3 player, and one **capture** `play` listener catches every element the page starts *later* (`play` does not bubble). A context created after the choice was made is pointed at it at creation, so a reload does not silently fall back to the system default. |
| **Test tone** | A sine on that engine, with as little around it as possible: **one frequency** (typed, in Hz, clamped to 20 Hz - 20 kHz), **one level** on a square law (its middle is -12 dB, where a linear slider would spend nine tenths of its travel in the top 20 dB), **`Both`/`Left`/`Right`**, and Play/Stop. Both ends are faded over 5 ms, because a click is not a speaker test, and a steady tone **stops itself after 30 seconds** so a forgotten one cannot drone on. |
| **Input test** | **Listen to this input** opens the chosen microphone and draws a live level meter with a peak hold - and the browser's own account of the capture: sample rate, channels, latency, whether echo cancellation / noise suppression / auto gain are on, and the device's rate range. The analyser is a **sink and is never connected to the destination**, so the room cannot feed back through it. |
| **What it cannot do, said plainly** | Firefox and older Safari expose neither sink API, so there the cards are **disabled with the reason on them** and the console says the system mixer is where the choice has to be made. A browser that routes media elements but not the audio engine gets the tone as a **generated 16-bit WAV** in an `<audio>` element (the WAV encoder is the other direction of this package's own decoder) while its Web Audio keeps the default. |
| **Remembered** | The pick is stored per browser (`localStorage`, guarded - a blocked store throws), and published as the **`audioDevices`** service (`snapshot`, `subscribe`, `sinkId`, `applyTo`, `refresh`) for a plugin that owns its own audio graph. It is read-only: the output is a device the person is sitting next to, so choosing it happens in the console and nowhere else. |

The tone's controls **freeze while it plays**, because the generated-WAV path
bakes the settings into the sound and a control that works on one browser and not
another is worse than one that is honestly disabled.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-audio` |
| `kind` | `audio` |
| `patterns` / `priority` | `['*.wav','*.wave','*.aif','*.aiff','*.aifc','*.flac']` / `extension` |
| seats | keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`; the console's **`sidebar.panellist` row** (`id` and `label` `audio` / `Audio`, `order: -1`, above Plugins) and its **`main` seat** (same id) |
| services read | `slots`, the bar's `sidebarRightTabs`, `remote.workspaceFiles`, and - **lazily, never injected** - `modals` (dsh-modal) and `layout` |
| service provided | `audioDevices` (skipped, not fatal, on a context with no `reflect`) |
| guide entry | **none** - a blank audio file is not a document the "+" control should offer |
| core rows disabled | **none** |
| npm dependencies | **none** |
| host routes | **none** |
| vendored engines | **none** |

The row is registered **with** its seat because the shell's own panel button
calls `layout.selectPanel(<id>)` and that **throws** for an id with no `main`
panel behind it - so the button keeps the shell's own full-width hit area (no
hashed class name pinned, no click intercepted inside another plugin's button)
and the *seat* is what opens the modal. Without dsh-modal the seat draws the same
console **inline**, and its own **Open the console** control means a dismissed
dialog is never a dead end.

It replaces nothing by patching. The bar's tab registry ranks by band
(`extension` 3, `builtin` 2, `fallback` 1) and then by the length of the pattern
that matched; the shipped preview claims `dsh-resource://file/**` at `fallback`,
and this type registers the audio suffixes at `extension`, so an audio file opens
here while **every other file type keeps exactly the surface it had** - MP3 and
M4A included, which the shipped preview still plays and this package deliberately
does not claim. `canOpen` refuses anything that is not an audio address, so the
ranking can never leak, and the shipped preview stays mounted as the fallback for
a profile without this package.

## Addresses

One shape: `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file
grammar, so a click in the Files tab lands here.

There is deliberately no second, package-owned shape (the way `dsh-pdf` has one
for a document outside any workspace). A `session` address is what authorizes a
host read of the file; the ordinary grammar's `absolute` form carries no session
and cannot authorize one. A chat attachment or a file in Downloads is still
opened by whatever surface had it.

## How the bytes are read, and why

**The file is read in WINDOWS.** `workspaceFiles.readBytes` hands over one
2 MiB window per call (the host's own cap; a deployment may configure it lower,
and a refusal carries `details.limit`, so the window is halved and asked for
again). The decoder consumes one window at a time, folds the samples into the
peak pyramid and **drops them**, which is what lets a 2 GiB WAV draw a waveform
at a bounded memory cost - a cap that a single whole-file read (32 MiB by
default) would have imposed on every file.

**The whole-file read is `readBytes` with empty options.** The namespace has no
`readAll` (the generated Remote declares `changes`, `list`, `read`, `readBytes`
and `stat`), so the FLAC path - the one that hands the whole file to the
browser's decoder - asks for `readBytes(sessionId, path, {}, signal)` and
refuses a payload that arrived truncated (`eof: false`) instead of letting the
decoder report a fault the size caused. Every window and every whole-file
payload goes through `bytesOf`, which accepts the `Uint8Array` the generated
result codec declares as well as an `ArrayBuffer`, a byte array and base64 text:
feeding a window to `atob` is a waveform that cannot be drawn.

**WAV and AIFF are decoded here.** They are the two the browser cannot both do -
Chrome decodes WAV but not AIFF - and both are simple containers. What is
decoded: WAV/RIFF and RF64 (`u8`, `s16`, `s24`, `s32`, `f32`, `f64`,
`WAVE_FORMAT_EXTENSIBLE`, A-law, mu-law) and AIFF/AIFC (`s8`, `s16`, `s24`,
`s32`, `sowt`, `fl32`/`FL64`, `alaw`, `ulaw`).

**FLAC is decoded by the browser** (`decodeAudioData`), which is why its path
reads the whole file and is bounded by the harness's single-read cap. Its
STREAMINFO is parsed here first, so a FLAC that is too big to decode still shows
its exact sample rate, channels, bit depth and length - and says what the limit
is. The decoder is asked for a context at the **file's own** sample rate, so a
44.1 kHz FLAC is not silently resampled; if the browser refuses that rate the
panel says "resampled".

**The header probe reads what it needs and no more.** 64 KiB first, then four
times as much at a time up to an 8 MiB ceiling, stopping the moment a container
parses. It also knows whether the bytes it handed over are the **whole file** -
the host's own `eof`, or a known size it has already covered - and passes that
down, so a parser that ran out of bytes answers with **its own verdict**
(`it has no data chunk`) rather than asking for bytes that do not exist. Only a
genuine prefix earns "read more".

**The walk survives the files that are legal but empty.** A chunk with no body at
all - a zero-size `junk`, an empty `LIST` - is exactly 8 bytes of header, and the
WAV, AIFF and FLAC walks **step over it** instead of letting it end the walk, so
a file carrying one still reaches `data`.

**The peak pyramid is the drawing's data structure.** Level 0 is one bucket per
256 samples holding `(min, max, rms)` per channel, and every level above groups
exactly four buckets of the level below, so a decimated RMS is the root of the
mean of its children's squares - the pyramid's numbers are the samples' numbers
and not an approximation of them. The client picks the level from the current
pixels-per-second, which is why zooming out changes **which level is read** and
never how many samples are walked.

**The zoom moves the layout, never a transform.** The scrollable spacer is the
file's duration times the pixels-per-second, so panning is the pane's own
`scrollLeft` and a zoomed waveform stays scrollable to its edge. The canvas that
paints it is **viewport-anchored** (`position: sticky; left: 0`), because a
canvas cannot be 300000 px wide: the layout is the file, the canvas is the window
onto it, and it repaints on scroll. A zoom keeps the time under the pointer and
restores it on the next animation frame.

**The wheel listener is native and non-passive.** React's own wheel listener is
passive, so a `preventDefault()` inside it does nothing - the browser's own
Ctrl+wheel *page* zoom would fire on top of ours, and the whole app would scale.
`Ctrl`/`Cmd` + wheel zooms at the pointer, `Shift` + wheel gains, and a bare
wheel scrolls sideways because time is this pane's axis.

**The playhead is the audio clock.** `currentTime - startedAt + from` is what
the AudioContext is actually playing, so the line cannot drift from the sound the
way a CSS animation can.

## Caps and what is not claimed

| | |
|---|---|
| claimed formats | wav, wave, aif, aiff, aifc, flac |
| zoom | 1 to 500000 px/s, capped from the duration so the layout stays inside 16 M CSS px |
| playback | files the page can hold: under 32 MiB and under 24 M samples. A larger file still draws its waveform, from a streaming pass, and the transport says why it is disabled. |
| FLAC | decodes up to the harness's single-read cap (32 MiB by default); past it the facts are shown and the waveform is refused in a sentence |
| not claimed | MP3, M4A/AAC, Ogg/Opus (`<audio>` in the shipped preview already plays them), and any codec tag the decoder does not implement - ADPCM, MACE, GSM, `ima4` - which is refused **by name** |
| no editing | this tab reads. There is no trim, normalize, convert, re-encode or save. |

## Verifying a change

```
node --check packages/dsh-audio/lib/client.js
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-audio-browser.mjs
```

The second is the tracked check; the third needs a Chromium-family browser (and
skips loudly without one) and is the half no Node check can do: it loads this
bundle in a real headless Chromium, React stubbed, and asserts that
`setSinkId` really moves an `AudioContext` and a media element, that the browser's
own device list comes back through `normalizeDevices` with its labels revealed
once the page may capture, that a real analyser frame goes through the meter's
arithmetic, and that **this package's own WAV encoder produces a file the browser
really plays** at the duration its samples state.

The tracked check **builds its own audio** - a RIFF/WAVE, an IFF FORM, a FLAC,
byte by byte, in the check itself - and drives the bundle's pure half through
`exports.__internals`, so no ffmpeg, no sox, no browser and no fixture on disk is
needed. It asserts the decoded **numbers**: the sample rate, channel count, bit
depth and duration of each container; a half-scale sine's envelope; a DC half
followed by real silence; the 24-bit two's-complement edges; unclamped IEEE
float; `WAVE_FORMAT_EXTENSIBLE`'s sub-format; the G.711 laws' own zero and
full-scale codes; a truncated file as *unknown* rather than silent; an
unsupported codec refused by name; and the pyramid's bucket arithmetic - level 0,
the four-to-one decimation, and the load-bearing claim that **a windowed decode
builds the same pyramid as a whole-file one**. It also builds fixtures for the
awkward containers - a `fmt ` chunk whose block align is narrower than a frame, a
WAVE carrying a zero-size chunk, a truncated container and a FLAC block cut off
by the end of the file - and asserts what comes back: a refusal that names the
stride, a walk that steps over the empty chunk and still finds `data`, a verdict
instead of a "read more", and a genuine prefix that still asks for more. It pins
the tab type (band, patterns, `canOpen`'s refusals, the chip title, the absence
of a guide entry), the seats, the opening markup, the layout-sized zoom, the
sticky canvas, the non-passive wheel listener, the pinch-compounding zoom ref,
the audio-clock playhead, and the fact that there is no `fetch` and no `/api/`
path anywhere in the bundle - and it **renders the viewer and the details panel
as markup**, on facts and a pyramid it builds itself, so the toolbar, the spacer,
the canvas, the status line and the metadata rows are all exercised rather than
assumed. The palette's own arithmetic is checked through `withAlpha`, so the
envelope and the RMS core cannot be handed the same colour.

`exports.__internals` is the bundle's **pure half** - the container parsers, the
PCM decoder, the peak pyramid and the ruler math - and it exists **only for that
check**: nothing in the app reads it, and it is there so the decoder's arithmetic
cannot quietly drift.

Alpha.3's half of the check is the same bargain for the console. The device list
is driven with a hand-built `enumerateDevices` result (the two kinds split, the
default folded onto the empty id, a nameless device kept and reported, a camera
dropped, and the default card naming the device Chromium's `groupId` ties it to);
the **three browser shapes** are driven through `pickOutputStrategy` as
environment objects, including the refusal that has to name the system mixer; the
tone's numbers are asserted (the square-law level, the clamp, the three stereo
positions, the 30 s self-stop) and its **samples** are checked silent at both
ends, at the level asked for, equal across the channels for `Both` and *silent on
the side a single-channel tone is not playing*; the generated tone is
**encoded and read back**
through this package's own `parseWav`/`decodePcm` (a 16-bit round trip to within
one LSB, which is what the `element` path's sound is verified by); the meter is
driven with a synthetic analyser frame and a track double; `readChoice` /
`writeChoice` are driven against a storage double **and against a store that
throws**; the console's own SMALLNESS is **pinned by absence** (no frequency
ladder, no sweep, no sentence about the tone) so a button cannot grow back one at
a time; and the console is **rendered as markup** in four states - a routing
browser, an unrouteable one whose cards are disabled with the reason on them, a
playing tone whose controls are frozen, and a live and a refused meter - plus the
seat in both profiles (with the dialog service, and without it). The wiring a
render cannot see is pinned as source: the dialog resolved lazily and never
injected, the panel row's `order: -1` (against the **shipped** Plugins row's own
`order: 0`, read out of the harness bundle), the two `setSinkId` calls, the
capture-phase `play` listener, `applyChosenSink` at context creation, the
analyser that is never connected to the destination, and the fact that the bundle
still contains no `fetch` and no `/api/` path.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

This one is a **new bundle**, so the app's profile has to learn about it: run the
installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh the
browser (Ctrl+F5). After that it is a live link, and editing `lib/client.js`
needs only a restart.

The design is the one `dsh-image` uses: the same zoom-moves-the-layout rule, the
same pointer anchoring, the same honest-failure sentences, and the same
client-only stand on bytes.
