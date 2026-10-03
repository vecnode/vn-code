# dsh-image (alpha.2)

**Images open as pictures, not as a file whose bytes happen to be an image.** The shipped preview draws a PNG at its intrinsic size and stops there: a 4000 px screenshot in a 400 px pane is a scrollbar with a corner of a picture in it. This is the right bar's `image` tab type - PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG and TIFF - and it behaves the way an image viewer is expected to: fit on open, zoom, and drag to pan. Client-only: bytes come from the harness's own `remote.workspaceFiles` remote, so there is no route, no host state and no path policy of its own; `lib/index.js` is one no-op row.

## What it adds

- **Fit on open** - the whole picture is visible whatever the pane's size, followed live while Fit is on. Fit shrinks but never enlarges.
- **Zoom ladder** - 5, 10, 17, 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400, 600, 800 %; `+`/`-` walk it and the ends clamp. `0` fits, `1` shows actual size, and **double-click** toggles the two.
- **Ctrl/Cmd + wheel zooms at the pointer**, multiplying the zoom rather than stepping it, so a trackpad pinch feels continuous. A bare wheel scrolls.
- **Drag to pan** with a real grab cursor, offered only when the pane was **measured** to overflow.
- **Checkerboard** behind the picture, so a transparent PNG reads as transparent; past **300%** the image is drawn pixelated, so a zoomed pixel is a square.
- **Status line** - true dimensions, size on disk, format, and the **source pixel under the pointer with its colour** (`x,y · #rrggbb · 42%` for a partially transparent one), sampled by drawing a 1x1 source rectangle into a 1x1 canvas, so inspecting an 8000 px photograph never copies it into a second buffer.
- **Honest failure** - a codec this browser does not have (TIFF in Chrome) says so, names the format and offers to read the file again.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind | `dsh-image` / `image` |
| `patterns` / `priority` | `*.png *.apng *.jpg *.jpeg *.jpe *.jfif *.gif *.webp *.avif *.bmp *.ico *.svg *.tif *.tiff` / `extension` |
| seats / services | `sidebar.right.pane.tab` / `.title`; `slots`, the bar's `sidebarRightTabs`, `remote.workspaceFiles` |
| guide entry, disabled rows, routes, deps | none |

The registry ranks by band (`extension` 3, `builtin` 2, `fallback` 1) then by pattern length. The shipped preview claims `dsh-resource://file/**` with its `text` type at `fallback`, and this type registers the image suffixes at `extension`, so an image opens here **by ranking** while every other file keeps the surface it had; a `canOpen` refusing anything else keeps the ranking from leaking. The shipped preview stays mounted as the fallback; the editor is untouched, since it vetoes images outright.

**One address shape:** `dsh-resource://file/session/<sessionId>/<path>`. There is deliberately no package-owned `absolute` form: `session` authorizes a host read, and the absolute form carries none.

## Rules and limits

- **The zoom moves the layout, never a CSS transform.** The picture sits in a box sized `naturalPixels * zoom` inside a scrollable pane, so panning is the pane's own `scrollLeft`/`scrollTop` and browser scrolling keeps working; `transform: scale()` would draw into a clipped box with no scrollable area. `margin:auto` on the box is the centring that survives overflow.
- **A zoom keeps the point the reader was looking at**, remembered as a fraction of the scrollable area before the layout changes and restored on the next animation frame.
- **The wheel listener is native and non-passive** (`{ passive: false }`, the handler read from a ref): React's own wheel listener is passive, so a `preventDefault()` inside it does nothing and the browser's Ctrl+wheel page zoom would scale the whole app.
- **Bytes come from the harness:** `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)` - `readBytes` with **empty options**, the namespace's whole-file read. It already resolves the path inside the workspace, refuses a symlink out, requires a regular file, and enforces the host's 32 MiB cap. There is no `readAll` on that namespace (it declares `changes`, `list`, `read`, `readBytes` and `stat`). A truncated payload (`eof: false`) is refused rather than drawing part of a photograph; `bytesOf` accepts a `Uint8Array`, an `ArrayBuffer`, a byte array or base64 text; and the base64 decode is one indexed loop.
- **The blob URL is revoked**, and a superseded read's settlement is dropped rather than racing the new one.
- Not claimed: HEIC/HEIF, RAW, PSD and every other format no browser decodes - those keep the shipped preview. This tab reads: no crop, rotate, resize, convert or save. TIFF is claimed on purpose, so a browser that cannot decode it gets one sentence naming the format rather than a generic binary-file message.

## Verify

```
node --check packages/dsh-image/lib/client.js
node scripts/checks/check-client-bundles.mjs
```

The tracked check drives the bundle through a real React runtime: the type definition, the rendered body and title seat, the layout-sized zoom, the measured overflow, the non-passive wheel listener, the pointer anchor, the 1x1 sampler, and the absence of `fetch`/`/api/` in the bundle.

## Install

Both installers pick the package up from `packages/`; it is a new bundle, so the profile learns about it once:

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

Then restart `npx @deepseek-ai/dsh web` and hard-refresh; after that it is a live link and editing `lib/client.js` needs only a restart.
