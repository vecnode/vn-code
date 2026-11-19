---
name: screenshot-surfaces
description: Choose the right capture surface - a web page in a throwaway headless browser, an application window through Win32, or the whole screen - and read the answer honestly. Covers the loopback default versus `remote: true`, viewport and dpr choices, element clips, blank and clipped pictures, and why a window capture sometimes has to fall back to the screen.
---

# Choosing the surface

There are three ways to get a picture, and picking the wrong one is the usual
reason a screenshot needs retaking.

| What you want a picture of | Tool | What it costs |
|---|---|---|
| A page: a dev server on `localhost:5173`, an `.html` file, a deployed site | `shot_url` | ~1.5 s, one browser process, no window opened |
| One application: Notepad, VS Code, Explorer, a game, a dialog | `shot_window` | ~1 s, one PowerShell + GDI+ call |
| The display: two windows side by side, a dialog over a window | `shot_screen` | ~1 s, copies whatever is on screen |

**A web page is never a `shot_window`.** A browser window captured as a window
brings its tab strip, its address bar and its own scrollbar with it - the
picture then shows Chrome rather than the product. `shot_url` renders the page
at exactly the viewport asked for and nothing else.

**A desktop app is never a `shot_url`.** There is no address for it. This is the
one case where the Win32 capture is the only way.

## `shot_url`: the three targets

- **Loopback** (`http://127.0.0.1:5173/`, `http://localhost:3000/`) - the default
  and the common case. The engine is launched with a resolver that maps every
  name to NOTFOUND except loopback, so the page renders and **nothing leaves the
  machine**: a remote font or a CDN script fails, and the picture shows the
  fallback font. That is a property, not a bug - if the fallback font is
  unacceptable, the page's own font is what has to change, or serve it locally.
- **A file in the workspace** (`index.html`, or `src/storybook/preview.html`) -
  relative to the conversation workspace, resolved through `realpath`, refused if
  it escapes. No server needed.
- **A public address** - requires `remote: true` on that exact call. Then the
  engine has the real network, the page's CDN and fonts load, and the picture is
  of somebody else's server. The answer says "PUBLIC" and states that the engine
  had real network access, so the difference is never silent.

A capture of a public page is the one that can also be *wrong* in a way local
ones cannot: it depends on a site you do not control. For anything a README
depends on, a local render of the page in the repository is the stable choice.

## Sizing it

| Want | Ask for |
|---|---|
| A README hero shot | `viewport: "desktop"`, `dpr: 2` (1440x900 CSS, 2880x1800 px) |
| A phone shot | `viewport: "phone"` (390x844) |
| An Open Graph / social card | `viewport: "og"` (1200x630) |
| A square grid tile | `viewport: "square"` (1080x1080) |
| A component, not a page | `clip: ".card"` or `clip: "#settings-panel"` |
| The whole scroll | `fullPage: true` (capped at 12000 CSS px tall) |
| The dark theme | `dark: true` - emulates `prefers-color-scheme: dark` |
| A page that fills itself in late | `settleMs: 1500` |

`dpr: 2` doubles the PIXELS, not the layout: the CSS viewport stays 1440x900, so
nothing reflows. Publish the file at half its pixel width (see `readme-media`)
and it stays sharp on a retina screen without being twice as big on the page.

`clip` measures the element with `getBoundingClientRect()` and captures that box.
It refuses with a reason when nothing matches, when the selector is invalid, or
when the element has no box (a `display: none` panel) - and it does not scroll
the element into view first, so a clipped element below the fold still captures
correctly (`captureBeyondViewport`).

## Reading the answer

The answer reports the **file's own** size, read out of the PNG header - not the
size that was requested. If a device-scale factor failed to apply, the numbers
say so instead of lying.

- `EMPTY of text` means the page painted nothing readable. The usual causes: the
  dev server is not running (the navigation failed and the picture is Chrome's
  own error page), a client-side router showed nothing at that URL, or the page
  is behind a login. Look at the picture before publishing it.
- `the load event never fired` means the page was still loading at the deadline.
  The picture is the page as it stood - raise `settleMs`, or fix what hangs.
- `the page is taller than the 12000 px capture ceiling` means the bottom is cut.
  Narrow the viewport, or clip to a section.
- `TOO_MANY_PIXELS` refuses a capture above 40 megapixels rather than exhausting
  memory: drop `dpr`, or clip.

## `shot_window`: the two methods, and why it matters

The answer says which method produced the pixels.

- `print` - `PrintWindow` with `PW_RENDERFULLCONTENT`: the window drew itself into
  a memory bitmap. It works even when the window is **behind another one**, and it
  is the good case.
- `screen` - `PrintWindow` came back a flat colour (some GPU-composited windows do:
  hardware-accelerated Chrome, video players), so the fallback copied the screen
  at the window's rectangle. **That is only valid if nothing covered the window**,
  so check the picture before publishing one captured this way.

Call it with no arguments to list the capturable windows (handle, pid, title,
size, scale). Then call it with the title, the pid or the handle. A title that
matches more than one window is refused with the candidates - pass the handle.

`scale` is the window's own DPI scale (`GetDpiForWindow`, e.g. 1.5 on a 150%
display), which is what lets a README publish a 2248 px capture at 1499 CSS
pixels instead of at 2248.

A minimized window has no pixels; the answer says so instead of writing a black
rectangle. Off Windows both native tools answer with one sentence and write
nothing.

## Cost, and what is bounded

A `shot_url` is a whole browser process: at most 2 run at once and 6 may wait,
then the answer is `BUSY` in a sentence. That ceiling exists because a loop of
captures would otherwise mean one Chrome per call. Reading a page's text is
cheaper with `web_fetch`; measuring a layout is cheaper with the `browser_*`
tools if that row is enabled. Reach for a screenshot when the PICTURE is the
thing being asked for.
