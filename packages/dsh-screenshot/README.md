# dsh-screenshot (alpha.1)

> **The tools half is shipped; the Screenshots tab is the next pass.** Four
> tools and three skills are here, and the two routes the tab will use are
> registered and driven by the package's own check. A profile gets one row, four
> tools, no client bundle.

**Screenshots that are worth publishing.** A capture is easy; the part every
screenshot tool leaves to you is that the picture has to arrive in the repository
at the right width, under a stable name, with the README markup and its alt text
already written. This row does both ends of that job, and it photographs the
things a browser cannot: a real application window, and the screen.

## What it adds

```
page ──engine.js──► throwaway Chrome/Edge (loopback only unless `remote: true`)
     ──here──────► a PNG whose true size is read from its own IHDR

window ─native.js─► PrintWindow (PW_RENDERFULLCONTENT), screen fallback, DPI scale
screen ─native.js─► BitBlt of the display

PNG ──place.js────► <slug>-<viewport>[-dark].png + manifest.json + README block
```

| Tool | Back comes |
|---|---|
| `shot_url` | a PNG at the viewport you asked for (dpr, dark, full page, or one element's box), the page's title and final address, and the file's real pixel size |
| `shot_window` | one application window on Windows, the method that produced the pixels (`print` / `screen`), and the window's own DPI as the scale |
| `shot_screen` | the display, or one rectangle of it |
| `shot_place` | the files placed, a merged manifest, and the `<img>` / `<picture>` markdown block with alt text required |

Call `shot_window` with no arguments to list what is capturable. Call `shot_place`
with no `dryRun: false` to see what it *would* write.

## The two policies

**A loopback address is the default; a public one has to be meant.** `shot_url`
launches the engine with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE
localhost, EXCLUDE 127.0.0.1`, so a dev server renders and a CDN font does not -
nothing leaves the machine. A public address needs `remote: true` on that exact
call, and then the engine has the real network; the answer says so, because the
two are not the same act. This is deliberately the opposite of `dsh-browser`'s
policy (https, 443, public destinations only, loopback never resolves), which is
right for reading a remote page and wrong for screenshotting the app you are
building. That row stays off.

**It never runs git.** `shot_place` writes files inside the conversation's
workspace and stops; committing and pushing are the person's own acts, with their
own credentials. A plugin that held a GitHub token would be a worse thing to
install than one that did not. That is also why there is no "ships to GitHub"
button anywhere in this row.

## What makes the picture correct

- **The size is the file's, not the request's.** Every answer reads the PNG's
  IHDR: a device-scale factor that failed to apply shows up as a smaller picture
  instead of a silent lie. `dpr: 2` is checked to produce exactly twice the
  pixels at the same CSS viewport.
- **A clipped shot is the element's own box**, measured with
  `getBoundingClientRect()` and captured with `captureBeyondViewport`, so an
  element below the fold still captures correctly.
- **The published width is `pixels / scale`, capped at 1000.** A 2880px retina
  capture at `width="2880"` is a README that scrolls sideways; the same file at
  `1000` is sharp and correct.
- **Alt text is required.** An image with no alt is invisible to a screen reader,
  and a README is documentation.
- **A light/dark pair is grouped by its file name**, so `hero-desktop.png` +
  `hero-desktop-dark.png` is one `<picture>`, while `hero-desktop.png` +
  `hero-phone.png` in the same call is a two-viewport tour of two `<img>` tags.
  Two shots that would resolve to the SAME name are refused by name instead of
  silently overwriting each other.

## Limits

- **`shot_window` / `shot_screen` are Windows.** They read a window through Win32
  and GDI+; off Windows they answer with one sentence and write nothing (`dsh-wsl`
  is the precedent for a host-only surface that is honest off its platform).
- **A GPU-composited window can refuse `PrintWindow`.** The pixel count catches a
  black rectangle, and the fallback is a copy of the screen at the window's
  rectangle - which is only valid while that window is unobscured. Both methods
  are reported by name; a picture captured this way should be looked at before it
  is published.
- **No motion.** A GIF or a screen recording is `dsh-media`'s job (it owns
  ffmpeg); this row produces stills.
- **A page that painted nothing is still a picture.** It comes back flagged
  (`EMPTY of text`) rather than refused, so the answer can be "the dev server is
  not running" with evidence.
- **Four CDP engines live in this pack** (`dsh-browser`,
  `dsh-frontend-craft`, `dsh-shaders`, and this row's `lib/cdp.js`), because a
  bundle may not import another bundle's files. This one is the smallest of them:
  connect, enable, emulate, capture.

## Verify

```sh
cd packages/dsh-screenshot && npm run check
```

82 assertions on this machine, including three real Chrome captures (a phone
viewport at 390x844, the same at dpr 2 reading 780x1688, and a 200x100 element
clip), a real window capture, and the two routes driven through a fake connection
registry. The engine half SKIPS loudly on a host with no browser; the native half
skips loudly off Windows.

Pack-wide: `node scripts/checks/check-node-routes.mjs`, `check-client-bundles.mjs`
(no client bundle, and the check says so), `check-no-secrets.mjs`.

## Layout

```
lib/cdp.js       a minimal DevTools client (WebSocket, no dependency)
lib/engine.js    resolve the browser, launch it, emulate, capture, read the IHDR
lib/native.js    the Win32 driver (C# compiled by the machine's own PowerShell)
lib/place.js     slug, name, display width, README block, manifest, containment
lib/index.js     config, four tools, two routes, three skills
checks/          the tracked check
skills/          screenshot-surfaces, readme-media, app-tour
```
