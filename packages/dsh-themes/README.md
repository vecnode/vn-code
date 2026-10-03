# dsh-themes (alpha.23)

**The vncode Web GUI's conversation-header package: four controls on that header, plus the pack's appearance overrides.**

All four are occupants of the Session header's `conversation.session.header.utilities` list, which renders in ascending `order` — lower is
further left. The package is control and dress only: it forks nothing and disables no core row.

| Occupant | Order | Position |
|---|---|---|
| Page zoom | `-40` | leftmost |
| Screenshot | `-30` | left of Themes |
| Themes | `-20` | left of Open In… |
| Session-log download | `0` | the shipped `session-log-download` seat |

Open In… (`dsh-open-in-app`) is `-10` and dsh-cmdbar's button `30`; no shipped order is changed.

## What it adds

- **Themes** (`-20`) — a menu of Light / Dark / System plus every theme in the shipped registry. The package
  registers **Nord**, **Monokai** and **Hacker** through `ctx.theme.register`, as alias-token overrides on the
  dark base. `THEME_EXTENSIONS` order is menu order: Light, Dark, Nord, Monokai, Hacker, System. The preference and its persistence stay
  ui-theme's: this control reads the published snapshot and calls `setTheme(id)`; an extension id, which the durable schema cannot
  hold, lives in `ui-state`'s volatile config and is cleared by a built-in pick.
- **The Session-log download seat** (`0`) — the shipped three-dot *More actions* menu replaced by one download
  button, by the registry's own shadowing rule: the same occupant `id` (`session-log-download`) at
  `priority: -10`, so the shipped registration stays mounted (it owns the export) and stops rendering. The
  control resolves `sessionLogDownload` lazily, draws the same preparing / success / error dialog, and is
  disabled when that row is absent.
- **Screenshot** (`-30`) — `getDisplayMedia` on the current tab, one frame into a canvas, POSTed to this
  package's host route. The open tooltip bubble is kept out of the frame by `html[data-dsh-screenshot] [role=tooltip]`.
- **Page zoom** (`-40`) — Chrome's own ladder, cut at both ends: `50, 67, 75, 80, 90, 100, 110, 125, 150, 175,
  200`. It writes one inline `zoom` on the document element and removes it at 100%. It exists because the
  native window `scripts\run-desktop.bat` opens has no Ctrl+ / Ctrl- gesture; the button sits inside the page
  it zooms, hence the 200% top rung. The level is kept in `ui-state`'s volatile `pageZoom`, with a
  `localStorage` copy under `dsh-themes.page-zoom`.
- **Appearance overrides**, plain CSS: the **Markdown paper** (ui-theme's own light declarations re-read at
  boot and re-declared on `body [data-document-markdown]`, plus white — all-or-nothing, re-installed on
  `theme/change`); the **Markdown chrome** (the viewer menu hidden on the shipped Markdown renderer alone);
  the **left column's top bar**, whose branding band takes the other columns' hairline at **y=76**, with the
  **VN branding** (`assets/vncode.svg` inlined as a data URI, a 24px mark, the name `vncode`); the **header
  ring** on `[data-conversation-header-corner] button`; the account menu's **Feedback row**, hidden on the
  paper-plane `path` artwork; the **right bar's resize seam**, placed from a CSS anchor under `html[data-dsh-page-zoomed]`; the left
  column's **panel order** (`regionArea` 1, `panelList` 2, `footArea` 3); and the fullscreen right panel's `width:100%` while a zoom is in
  force. Hooks are stable app markers (`data-conversation-header-corner`, `data-rightbar-col`, `role="menuitem"`) or hashed class names.

## How it plugs in

- `cordis.patch.yml` inserts the `themes` row and patches nothing else.
- `lib/index.js` registers one authenticated route, `POST /api/dsh-themes/screenshot`, whose body is the PNG.
- `lib/client.js` draws the four header occupants, the theme entries and the stylesheets. It injects `slots`
  plus `@deepseek-ai/dsh-client-ui-theme` and `@deepseek-ai/dsh-client-ui-conversation`; `theme`, `uiState`
  and `sessionLogDownload` use `ctx.get`, never `inject`, so a profile without them still gets a header.

## Limits

- The screenshot route accepts `image/png` only, requires the real PNG signature and a body under **64 MiB**,
  and writes **create-exclusively** as `vncode-<timestamp>.png` to the Desktop resolved **per request** —
  Windows or OneDrive-redirected, `XDG_DESKTOP_DIR`, home folder last. Failures are typed (`415` / `400` /
  `413` / `500`), the client never names a path, and without the host row the browser download is the fallback.
- A hashed-class pin stops matching after a harness rename: a no-op, not a broken layout, and the Feedback row
  would simply return.
- Under a page zoom, `vh` and pointer coordinates stay unscaled while `getBoundingClientRect()` does not, so a
  drag that compares pointer deltas against a rect moves by the zoom factor.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs   # seats, orders, the ladder, the paper, the seam
node scripts/checks/check-node-routes.mjs      # the screenshot route: type, signature, cap, Desktop write
```

## Install

`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux: the launcher auto-discovers this package as a standard `dsh.bundle`,
and a bundle the profile does not list yet is added by one plain run. The web profile live-links it from this repo, so a code edit needs a
restart of `npx @deepseek-ai/dsh web` plus a hard refresh; `scripts\run-web.bat` / `./scripts/run-web.sh` starts it and opens the printed URL.
