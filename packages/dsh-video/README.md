# dsh-video (alpha.1)

**Video as a surface that actually plays — and tells you what is inside it.**

A `.mkv` opened in the shipped preview is a black rectangle with a player that
either plays, or silently does not. This package is the right bar's `video` tab
type: MP4, M4V, MOV, WebM, MKV, AVI, WMV, FLV, OGV, MPEG-TS and 3GP open in a
player that fits the pane, streams from the host and states what is in the file.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-video` |
| `kind` | `video` |
| `patterns` / `priority` | `['*.mp4','*.m4v','*.mov','*.webm','*.mkv','*.avi','*.wmv','*.flv','*.ogv','*.ts','*.m2ts','*.mpg','*.mpeg','*.3gp','*.mts']` / `extension` |
| seats | keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` |
| services | `slots` and the bar's `sidebarRightTabs` |
| guide entry | **none** — a blank video is not a document the "+" control should offer |
| core rows disabled | **none** |
| npm dependencies | **none** |
| host routes | **none** — `dsh-media` owns them |

Nothing is patched. The registry ranks by band (`extension` 3, `builtin` 2,
`fallback` 1) and then by the length of the pattern that matched: the shipped
preview claims `dsh-resource://file/**` at `fallback`, this type registers the
video suffixes at `extension`, so a video opens here **by ranking** and **every
other file type keeps exactly the surface it had**. `canOpen` refuses anything
that is not a video address, so the ranking can never leak, and the shipped
preview stays mounted as the fallback for a profile without this package — the
arrangement `dsh-image`, `dsh-audio` and `dsh-pdf` also make.

It is **client-only**: the bytes, the probe and the ffmpeg belong to
[`dsh-media`](../dsh-media/README.md), which owns `/api/dsh-media/*`. Its Node
half is one no-op row whose only job is to put the browser bundle in the boot
graph, because ffmpeg has a single owner in this pack.

## Why it is built this way

**The bytes never enter the tab.** The `<video>` element is handed a URL to
`dsh-media`'s Range-capable route — no `fetch` of the file, no `arrayBuffer`, no
blob and no `workspaceFiles` read. The route speaks HTTP Range, so the browser
streams *and* seeks; reading a 2 GB film into memory would turn it into an
impossible one and destroy scrubbing. The tracked check asserts the absence of
every one of those calls.

**The poll's effect depends on `[running, jobId]`, never on the job object**:
every poll replaces that object, and an effect depending on it would rebuild its
own interval on every tick — a polling loop feeding itself.

## The player

A real layout size (`max-width`/`max-height: 100%`), never a scale transform,
centred on a black letterboxed stage. A 38px top bar carries the name, the
duration, the pixel size, the size on disk, a **chapter picker**, `-5s` / `+5s`,
a **Facts** toggle and the conversion action when the file needs one; a chapter
click seeks **and plays**, because a chapter is a place you wanted to watch.

## The facts panel

`dsh-media`'s probe as a drawer: container, duration, bitrate, size, one block
per stream (codec, profile, pixel size, display aspect, the frame rate and its
exact rational, pixel format, bit depth, rotation, sample rate, channel layout,
bitrate, language, title, default/forced), every chapter as a **jump target**
that seeks and plays, the file's tags, and the browser verdict with the copyable
ffmpeg command.

## The conversion

A file the browser cannot decode gets the one action that fixes it — **Remux to
MP4** (instant, no re-encoding) or **Convert for the browser** (H.264/AAC): a
POST to `dsh-media`, polled every **700 ms** with ffmpeg's own percentage on a
thin bar, and the cached MP4 then plays through the same file route, so a second
visit is instant.

## Nothing is a dead end

`No ffmpeg on this machine yet` offers the pinned download and then re-probes.
`ffprobe could not read this file` and a host error are an **overlay on the live
player** with **Play it anyway** (the browser decodes plenty ffprobe cannot
describe) and **Read it again** — not a screen that replaced the player. A
profile without `dsh-media` gets one sentence naming the package that owns
`/api/dsh-media/*`.

## Audio formats are deliberately not claimed

WAV, AIFF and FLAC belong to `dsh-audio`'s waveform; MP3, M4A and Ogg are played
by the shipped preview's own `<audio>` element. Claiming them here would take a
surface away to add a worse one, so the extension list stops at video
containers. `dsh-media`'s file route enforces the same list, which the tracked
checks pin on both sides.

## Addresses

- `dsh-resource://file/session/<id>/<path>` — what a click in the Files tab
  produces;
- `dsh-resource://file/absolute/<path>` — a file outside any workspace, readable
  here because `dsh-media`'s route accepts an absolute path (a chat attachment
  under `$DSH_HOME/attachments/v1/files/...`, a file in Downloads).

The absolute form is **reassembled**, and that is the one part of this package
that could silently point at another file: the grammar drops a leading `/`, so a
POSIX path needs it back, a Windows path (`C:/…`) carries its own root, and a
UNC path (`//server/share/…`) keeps an **empty first segment** that must not be
collapsed. All three are pinned by the tracked check.

## Caps and what is not claimed

| | |
|---|---|
| claimed formats | mp4, m4v, mov, webm, mkv, avi, wmv, flv, ogv, ts, m2ts, mpg, mpeg, 3gp, mts |
| streaming | the whole file, seekable, through `dsh-media`'s Range route (no tab-side byte cap — the browser streams what it needs) |
| conversion | one job at a time per file (a second request joins the first), at most two at once, killed after 15 minutes |
| not claimed | audio formats (see above), images (`dsh-image`), and anything that is not a container a browser *or* ffmpeg recognises |
| no editing | this tab plays and inspects. There is no trim, cut, merge or export. |

## Verifying a change

```
node --check packages/dsh-video/lib/client.js
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-media-node.mjs
```

The client check loads the bundle the way the shell does and drives it with a
real React runtime: the type definition (bands, patterns, both `canOpen`
refusals, the chip title, no guide entry), the seats, the opening and
address-less markup, and the load-bearing rules by name — the URL hand-off with
the asserted **absence of every byte-reading call**, the aborted in-flight probe,
the POST-then-poll conversion and its `[running, jobId]` dependency, the "play it
anyway" overlay, and the sentence a profile without `dsh-media` is shown. The
address reassembly cases (POSIX, Windows drive, UNC, an unknown shape refused)
are pinned there too, and the `dsh-media` host check pins the other side: the
same extension list and the file route that serves the ranges this tab needs.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

Run the installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh
the browser (Ctrl+F5) so the profile learns the new bundle; after that it is a
live link, and editing `lib/client.js` needs only a restart. Install
[`dsh-media`](../dsh-media/README.md) alongside it — that is where the bytes and
the ffmpeg come from.
