# dsh-video (alpha.1)

**Video as a surface that actually plays, and says what is inside it.** A right-bar `video` tab type for MP4, M4V, MOV, WebM, MKV, AVI, WMV, FLV, OGV, MPEG-TS and 3GP. The shipped preview opens an `.mkv` as a black rectangle with a player that either plays or silently does not; here the film streams from the host, fits the pane, and states what is in the file. Client-only: the bytes, the probe and the ffmpeg belong to `dsh-media` (`/api/dsh-media/*`), so its Node half is one no-op row.

## What it adds

- **A player that fits the pane** - a real layout size (`max-width`/`max-height:100%`), never a scale transform, on a black letterboxed stage, under a **38px** top bar carrying the name, duration, pixel size, size on disk, a **chapter picker**, `-5s`/`+5s`, a **Facts** toggle and the conversion action when the file needs one. A chapter click seeks **and plays**.
- **The bytes never enter the tab.** The `<video>` element is handed a URL to `dsh-media`'s Range-capable route: no `fetch` of the file, no `arrayBuffer`, no blob, no `workspaceFiles` read. The route speaks HTTP Range, so the browser streams **and seeks**; reading a 2 GB film into memory would make it impossible and destroy scrubbing, and the tracked check asserts the absence of every one of those calls.
- **A facts panel** - `dsh-media`'s probe as a drawer: container, duration, bitrate, size, one block per stream (codec, profile, pixel size, aspect, frame rate and its rational, pixel format, bit depth, rotation, sample rate, channel layout, language, title, default/forced), every chapter as a **jump target** that seeks and plays, the tags, and the browser verdict with the copyable ffmpeg command.
- **One action fixes an undecodable file**: **Remux to MP4** (instant, no re-encoding) or **Convert for the browser** (H.264/AAC) - a POST to `dsh-media`, polled every **700 ms** with ffmpeg's own percentage on a thin bar; the cached MP4 then plays through the same route, so a second visit is instant. **The poll's effect depends on `[running, jobId]`, never on the job object**: every poll replaces that object, so an effect depending on it would rebuild its interval every tick.
- **Nothing is a dead end.** A missing ffmpeg offers the pinned download and re-probes; an unreadable probe and a host error are an **overlay on the live player** with **Play it anyway** and **Read it again**, not a screen that replaced the player. A profile without `dsh-media` gets one sentence naming the package that owns the routes.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind | `dsh-video` / `video` |
| `patterns` / `priority` | `['*.mp4','*.m4v','*.mov','*.webm','*.mkv','*.avi','*.wmv','*.flv','*.ogv','*.ts','*.m2ts','*.mpg','*.mpeg','*.3gp','*.mts']` / `extension` |
| seats / services | `sidebar.right.pane.tab` / `.title`; `slots` and the bar's `sidebarRightTabs` |
| guide entry, disabled rows, npm deps, host routes | none - `dsh-media` owns the routes |

Nothing is patched. The registry ranks by band (`extension` 3, `builtin` 2, `fallback` 1) then by pattern length: the shipped preview claims `dsh-resource://file/**` at `fallback` and this type registers the video suffixes at `extension`, so a video opens here **by ranking** while every other file keeps the surface it had, and a `canOpen` refusing anything else keeps the ranking from leaking. The shipped preview stays mounted as the fallback.

**Two address shapes**, both claimed: `dsh-resource://file/session/<id>/<path>` (a Files-tab click) and `dsh-resource://file/absolute/<path>` (a file outside any workspace, which `dsh-media`'s route reads by absolute path). The absolute form is **reassembled**, the one place this package could point at another file: the grammar drops a leading `/`, so a POSIX path needs it back, a Windows path (`C:/…`) carries its own root, and a UNC path (`//server/share/…`) keeps an **empty first segment** that must not be collapsed. All three are pinned by the tracked check.

Audio formats are deliberately **not** claimed: WAV, AIFF and FLAC are `dsh-audio`'s waveform, and MP3, M4A and Ogg are the shipped preview's own `<audio>` element. Claiming them would take a surface away to add a worse one; `dsh-media`'s file route enforces the same list.

## Limits

| | |
|---|---|
| streaming | the whole file, seekable, through `dsh-media`'s Range route; no tab-side byte cap |
| conversion | one job per file (a second request joins the first), at most two at once, killed after 15 minutes |
| not claimed | audio formats, images, and anything no browser or ffmpeg recognises |
| no editing | this tab plays and inspects: no trim, cut, merge or export |

## Verify

```
node --check packages/dsh-video/lib/client.js
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-media-node.mjs
```

The client check drives the bundle through a real React runtime and pins the type definition (bands, patterns, both refusals, no guide entry), the opening markup, the URL hand-off with the asserted **absence of every byte-reading call**, the POST-then-poll conversion and its `[running, jobId]` dependency, the "play it anyway" overlay, and the address reassembly cases (POSIX, Windows drive, UNC, unknown refused). `check-media-node.mjs` pins the other side: the same extension list and the Range route this tab needs.

## Install

Both installers pick the package up from `packages/`; install `dsh-media` alongside it, because the bytes and the ffmpeg come from there. Run the installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh (Ctrl+F5).
