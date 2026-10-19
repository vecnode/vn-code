# dsh-audio (alpha.5)

**Audio opens as a waveform — and the left column's Media panel lists every media file the conversation can reach.** The right bar's `audio` tab covers **WAV/RIFF, AIFF/AIFC and FLAC**, instead of the preview's bare `<audio>` element. The **Media** panel is a **Media** row in the left column's global-panel list (`sidebar.panellist`) at `order: -1`, above Plugins: its **Files** view scans the workspace for audio, image, video and GIF files and previews them in place, and its **Devices** view is this machine's audio console. Client-only: bytes come from the harness's `workspaceFiles` remote, so it ships no route and no host state; `lib/index.js` is one no-op row.

## What it adds

- **One row per channel**, the **min/max envelope filled** with the **RMS core inside**; the **48 px gutter** is that row's height (`L`/`R`, numbers, **no letter for mono**); one accent (`--dsw-alias-brand-primary` via `withAlpha`) paints envelope 55%, RMS solid, selection 16%, edge 50%. A bottom hairline resizes **every track at once**, 24-420 px.
- **Zoom by layout.** `pxPerSecond` **1 to 500000**, layout capped inside 16 M CSS px; `+`/`-`, **Fit**, **Ctrl/Cmd+wheel** at the pointer, **bare wheel scrolls sideways**, stems past ~3 px per sample. A 1-2-5 ruler runs 0.1 ms to 1 h; the scale is **linear or dBFS** (72 dB); **Shift+wheel** gains 0.25x to 16x.
- **Playback and selection.** WebAudio with the **playhead on the audio clock** (`currentTime - startedAt + from`), never a CSS animation; a selection plays **looped** and `Space` toggles it. A drag selects; the status line reports duration, peak and RMS **naming its source** (samples or N-sample buckets).
- **Refusals.** Unsupported codecs refused **by name** (`IMA ADPCM`, `MACE`, `GSM`, `ima4`); a `fmt ` chunk whose **block align is narrower than one frame** refused with its stride; a **zero-size chunk** stepped over, not ending the WAV/AIFF/FLAC walk; a truncated file draws what exists and says the tail is **UNKNOWN**.

## The Media panel

The left column's row is **Media**, not Audio, and it opens one dialog with two views.

- **Files** (the default) lists the media in this conversation's workspace: **images, GIFs, audio and video**, grouped in that order with a count per group. The walk is **bounded and says so** — depth 5, 120 directories, 120 files, `node_modules`/`.git`/`dist`/`vendor`/`__pycache__` and their kin skipped — and a cut list is labelled `(list cut)` in the header rather than passed off as complete. Every listing comes from the harness's own `workspaceFiles.list` under the session id, so the host decides what is readable; the panel never names a path it was not given.
- **The pick previews in place.** An image draws as an `<img>`, a GIF too, a video as a `<video controls>`, audio as an `<audio controls>`, all through the harness's authenticated `/api/file?path=` route against the file's **absolute path** (one `stat` per pick, never per row). **Open in a tab** then hands the `dsh-resource://file/session/<id>/<path>` address to the right bar's registry, so a WAV lands on this package's own waveform, a PNG on dsh-image's zoom, an MP4 on dsh-video's player, and a format this pack claims nowhere still reaches the shipped preview.
- **Devices** is the audio console described below, unchanged.

## The Audio console

`enumerateDevices` (re-run on `devicechange`) lists one card per device, the default **naming its target** via `groupId`. `AudioContext.setSinkId` moves the **one** AudioContext the player and the tone share; `HTMLMediaElement.setSinkId` moves every media element, and with neither the console names the system mixer. The tone is one frequency clamped to 20 Hz-20 kHz, one square-law level, `Both`/`Left`/`Right`, a **self-stop after 30 s**; the input meter's analyser is **never connected to the destination**. The pick lives in guarded `localStorage`, published as **`audioDevices`**; the row carries its `main` seat (`layout.selectPanel(<id>)` throws without one) and opens it in `dsh-modal`'s lazily resolved dialog, or **inline**.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind | `dsh-audio` / `audio` |
| `patterns` / `priority` | `['*.wav','*.wave','*.aif','*.aiff','*.aifc','*.flac']` / `extension` |
| seats | `sidebar.right.pane.tab` / `.title`; panel `sidebar.panellist` row + `main` seat (`media`, `order: -1`), whose dialog carries the Files and Devices views |
| services | `slots`, `sidebarRightTabs`, `remote.workspaceFiles` (lazily `modals`, `layout`); provides `audioDevices`; no guide entry, disabled row, route or dependency |

The audio suffixes at `extension` beat the shipped preview's `text` type at `fallback`, while every other file keeps its surface (MP3, M4A and Ogg included). **One address shape:** `dsh-resource://file/session/<sessionId>/<path>`; there is no package-owned absolute form, since `session` authorizes the read.

## How the bytes are read

- **2 MiB** windows: `readBytes(sessionId, path, { offset, length }, signal)`, each folded into the peak pyramid and dropped, so a 2 GiB WAV draws in bounded memory; the whole-file read is `readBytes(sessionId, path, {}, signal)`. No `readAll` exists on that namespace (`changes`, `list`, `read`, `readBytes`, `stat`), a truncated payload (`eof: false`) is refused, and `bytesOf` takes a `Uint8Array`, `ArrayBuffer`, byte array or base64.
- WAV/RIFF, RF64 and AIFF/AIFC are decoded here (`u8`-`f64`, `WAVE_FORMAT_EXTENSIBLE`, A-law, mu-law, `sowt`, `fl32`/`FL64`), while **FLAC goes to `decodeAudioData`** after its STREAMINFO is parsed here, so an undecodable FLAC still states its rate, channels, depth and length. The probe reads 64 KiB, then four times as much to an **8 MiB** ceiling, knowing whether it holds the whole file; pyramid level 0 is one bucket per 256 samples of `(min, max, rms)` per channel, each level grouping four, read at the level the pixels-per-second needs.
- **The zoom moves the layout, never a transform**; the canvas is **viewport-anchored** (`position: sticky; left: 0`) because it cannot be 300000 px wide; the wheel listener is **native and non-passive**.

## Limits

| | |
|---|---|
| zoom / playback | 1 to 500000 px/s (layout inside 16 M CSS px); playback under 32 MiB and under 24 M samples - a larger file still draws its waveform and disables the transport with the reason |
| FLAC | up to the single-read cap (32 MiB by default); past it the facts are shown and the waveform refused |
| not claimed, no editing | MP3, M4A/AAC, Ogg/Opus and unknown codec tags; no trim, normalize, convert, re-encode or save |
| Media panel | the scan stops at depth 5 / 120 directories / 120 files inside the workspace, skips build and package folders, and labels a cut list; the preview is one file at a time and the workspace is the only root (no absolute or outside paths) |

## Verify

```
node --check packages/dsh-audio/lib/client.js
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-audio-browser.mjs
```

`check-client-bundles.mjs` drives the bundle's **pure half** (`exports.__internals`) against RIFF/WAVE, IFF FORM and FLAC bytes it builds itself, and drives the Media panel's half too: the suffix→kind index, the session-scoped address a row opens, the `/api/file` URL an absolute path becomes, a scan over a scripted listing (one level down, `node_modules` skipped, groups in order, the cut flag reported), and the panel and seat renders (both views offered, a seat with no dialog still draws a working surface). `check-audio-browser.mjs` needs Chromium and skips loudly without it.

## Install

Both installers pick it up from `packages/`; as a new bundle the profile learns it once, then a restart of `npx @deepseek-ai/dsh web` and a hard refresh.
