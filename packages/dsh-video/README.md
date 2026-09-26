# dsh-video (alpha.1)

**Video as a surface that actually plays — and tells you what is inside it.**

A `.mkv` opened in the shipped preview is a black rectangle with a native player
that either plays, or silently does not. This package is the right bar's `video`
tab type, and it behaves the way a viewer is expected to:

| | |
|---|---|
| **Streams, and seeks** | The `<video>` element is handed a URL to `dsh-media`'s **Range-capable** route, so a 2 GB film starts playing at once and the scrubber works. Nothing is ever read into memory. |
| **Fits the pane** | A real layout size (`max-width`/`max-height: 100%`) on a black stage — never a scale transform, so a 4K film is visible whole in a narrow pane and a phone clip is not smeared across it. |
| **A facts panel** | Container, duration, bitrate, size, one block per stream (codec, profile, pixel size, display aspect, frame rate **and its exact rational**, pixel format, bit depth, sample rate, channel layout, bitrate, language, title, default/forced), the file's tags, and the browser verdict with the copyable ffmpeg command that would fix a remux or a transcode. |
| **Chapters as jump targets** | Every chapter ffprobe found is a button that seeks — in the panel, and in a picker in the toolbar. |
| **One-click repair** | A file the browser cannot decode gets **Remux to MP4** (instant, no re-encoding) or **Convert for the browser** (H.264/AAC), run by `dsh-media`'s ffmpeg with its own progress on a thin bar, and the finished copy is cached — a second visit is immediate. |
| **Never a dead end** | No ffmpeg on the machine? The tab offers the pinned download. ffprobe refused the file? **Play it anyway** keeps the player on screen, because the browser decodes plenty ffprobe cannot describe. |

It is a **client-only** package: the bytes, the probe and the ffmpeg all belong
to [`dsh-media`](../dsh-media/README.md), which owns `/api/dsh-media/*`. ffmpeg
has one owner in this pack, and a second implementation of the media path policy
would be a second thing to get wrong.

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

It replaces nothing by patching. The bar's tab registry ranks by band
(`extension` 3, `builtin` 2, `fallback` 1) and then by the length of the pattern
that matched; the shipped preview claims `dsh-resource://file/**` at `fallback`,
and this type registers the video suffixes at `extension`, so a video opens here
while **every other file type keeps exactly the surface it had**. `canOpen`
refuses anything that is not a video address, so the ranking can never leak, and
the shipped preview stays mounted as the fallback for a profile without this
package — the same arrangement `dsh-image` makes for images, `dsh-audio` for
waveforms and `dsh-pdf` for documents.

## Audio formats are deliberately not claimed

WAV, AIFF and FLAC belong to `dsh-audio`'s waveform; MP3, M4A and Ogg are played
by the shipped preview's own `<audio>` element. Claiming them here would take a
surface away to add a worse one, so the extension list stops at video
containers. `dsh-media`'s file route enforces the same list, which the tracked
checks pin on both sides.

## Addresses

Two shapes, both the ordinary file grammar:

- `dsh-resource://file/session/<sessionId>/<path>` — what a click in the Files
  tab produces;
- `dsh-resource://file/absolute/<path>` — a file outside any workspace, which is
  readable here because `dsh-media`'s route accepts an absolute path (a chat
  attachment under `$DSH_HOME/attachments/v1/files/...`, a file in Downloads).

The absolute form is **reassembled** rather than passed through, and that is the
one part of this package that could silently point at another file: the grammar
drops a leading `/`, so a POSIX path needs it back, a Windows path (`C:/…`)
carries its own root, and a UNC path (`//server/share/…`) keeps an **empty first
segment** that must not be collapsed. All three are pinned by the tracked check.

## Why it is built this way

**The bytes never enter the tab.** The player is given a URL, not a buffer: no
`fetch` of the file, no `arrayBuffer`, no blob, no `workspaceFiles` read. The
host route speaks HTTP Range, so the browser streams *and* seeks; reading a 2 GB
film into memory could do neither, and it is the one mistake this tab could not
recover from. The check asserts the absence of every one of those calls.

**One owner per surface.** The tab is a surface over `dsh-media`, exactly as
`dsh-image` is a surface over the harness's own `workspaceFiles` remote. That is
why this package ships no route and its Node half is one no-op row — and why a
profile that installs this bundle without `dsh-media` still loads and says which
package owns the routes it needs, instead of showing a player that cannot load.

**The conversion poll keys on the job's ID, not the job object.** Every poll
replaces that object, and an effect that depended on it would tear down and
rebuild its own interval on every tick — a self-inflicted polling loop. The
effect depends on `[running, jobId]`, which is exactly the two facts that decide
whether there is anything to poll.

**A failed probe is not a failed file.** ffprobe refusing a container says
nothing about whether the browser can play it, so `unreadable` and `error` are an
**overlay on the live player**, with "Play it anyway" and "Read it again" — not a
screen that replaced the player and left the file unreachable.

**Chapter jumps play, not just seek.** Clicking a chapter moves the playhead and
starts playback, because a chapter is a place you wanted to watch.

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
refusals, the chip title, the absence of a guide entry), the seats, the opening
and address-less markup, and the load-bearing rules by name — the URL hand-off
with no byte read anywhere in the bundle, the aborted in-flight probe, the
POST-then-poll conversion and its `[running, jobId]` dependency, the "play it
anyway" overlay, and the sentence a profile without `dsh-media` is shown. The
`dsh-media` host check pins the other side: the same extension list, and the
file route that serves the ranges this tab depends on.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
install.bat -Force        # Windows
./install.sh -Force       # macOS / Linux
```

This one is a **new bundle**, so the app's profile has to learn about it: run the
installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh the
browser (Ctrl+F5). After that it is a live link, and editing `lib/client.js`
needs only a restart. Install [`dsh-media`](../dsh-media/README.md) alongside it
— that is where the bytes and the ffmpeg come from.

## Alpha roadmap

- **alpha.1** (this release): the tab, the streaming player, the facts panel,
  chapter jumps, the remux/transcode action, and the honest states (no ffmpeg, an
  unreadable file, a host error, a profile without `dsh-media`).
- **Next, if the films you watch ask for it**: a thumbnail rail drawn from
  `media_frames`, audio-track and subtitle selection for files with more than
  one, a remembered position per file, in/out markers with an export, and
  `picture-in-picture`.
