# dsh-browser (alpha.1)

> **SHIPPED, AND TURNED OFF.** [`dsh-vn-master`](../dsh-vn-master) — the pack's final layer — disables the `browser` row, so a profile loads **no Browser tab, no `/api/dsh-browser/*` routes, no `browser_render` / `browser_query` / `browser_text` and no client bundle**: a feature nobody uses is not worth its attack surface. The code, these docs and `scripts/checks/check-browser-node.mjs` stay in step, so re-enabling it is deleting two lines from that layer.

**The pack's own Browser tab**, and the replacement for the one the harness ships: it renders a page **on the host**, in a throwaway engine behind an egress gate, and shows the picture, the rendered text and the page's own numbers — with three tools over the same pipeline, so what you see and what the agent was told cannot disagree.

The shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` renders a remote page in an `<iframe src=...>` and its host half is `function apply() {}` — no proxy, no route — so the site's own framing policy decides whether anything appears: google.com answers `X-Frame-Options: SAMEORIGIN`. Nothing client-side can lift that, which is why the shipped package is desktop-only upstream; this pack targets the raw web profile, so it renders instead of framing.

## What it adds

```
 url ──policy.js──► https, 443, a qualified public host, never an IP literal
      ──gate.js───► loopback CONNECT proxy: resolve once, refuse the whole answer
                     set unless every address is public, connect to the address it
                     validated, bound the tunnel, RECORD the decision
      ──engine.js─► throwaway Chrome/Edge profile, driven over CDP
      ──here──────► page.png + meta.json under $DSH_HOME/dsh-browser/artifacts/
```

One function (`runRender`) serves both callers: `GET /api/dsh-browser/state`, `POST /api/dsh-browser/render`, `GET /api/dsh-browser/image`.

| Tool | Back comes |
|---|---|
| `browser_render` | a PNG whose true size is read from the file's own IHDR, the page's numbers, the gate's verdict, the page's destinations |
| `browser_query` | per CSS selector: `count`, `box`, computed `style`, `text`, `attrs`, `html` |
| `browser_text` | the post-script text and the link inventory |

Each labels page content as **data, never instructions**; a bundled **`web-render`** skill covers when to render instead of using `web_fetch`.

The tab draws four views: **Visual** (the PNG on a zoom ladder that moves the layout box, never a CSS transform), **Reader** (the text, links clickable through the same policy), **Metrics** (viewport, content size, counts, timing) and **Policy** (the engine, the gate's tunnels/challenges/refusals by name, the parked live mode). Plus viewport presets (390–1920), full-page and dark toggles, back/forward over render history, and a permanent banner saying the picture is a host render, not a live page.

## How it plugs in

`cordis.patch.yml` hard-disables the shipped `ui-sidebar-browser` row and inserts the `browser` row, keeping the replaced package's tab **id and kind** so a profile with Browser tabs already persisted resolves them here. The disable stays with the package that replaces the row, so a partial `-Plugin dsh-browser` install leaves exactly one Browser tab — the shipped one — rather than none.

## Limits

- **The page never runs in your browser, and the engine has no direct network access.** It is launched with the gate as its proxy and `--proxy-bypass-list=<-loopback>`, so every socket — document, scripts, fonts, XHRs — is a `CONNECT` the gate policed. The profile is a fresh `--user-data-dir` per render, deleted afterwards; the engine is never disarmed (no `--no-sandbox`, no `--disable-web-security`, no `--ignore-certificate-errors` — the tracked check fails if one appears). The gate's credential never reaches a page: it demands `Proxy-Authorization` and the host answers over CDP (`Fetch.authRequired`).
- **Every run is bounded**: one deadline, a timeout on every CDP command, an idle timeout and a byte cap per tunnel, and the browser process (found through CDP, not the launcher Windows exits immediately) is killed at the end. **And so is the machine** — at most `MAX_CONCURRENT_RENDERS` (2) run at once, a queue of 8 waits its turn, and beyond that a call is refused with `BUSY` (`DSH_BROWSER_MAX_RENDERS` moves the ceiling).
- **The policy**: https only, port 443 only, no credentials in a URL, no IP literals, a qualified public hostname (so `localhost` never resolves), public unicast addresses only **for the whole answer set**, and an optional allow/block list. Every refusal carries a code and a sentence naming the rule; pages behind a login are out of scope by design.
- **The parked live mode** refuses with `LIVE_PARKED` — it is the one thing that would put a remote page back inside this origin, which this package exists to avoid. Nothing here reads a caller-supplied path, only its own artifacts under `$DSH_HOME/dsh-browser/`, so it has **no path policy at all** to get wrong.

## Verify

```sh
node scripts/checks/check-browser-node.mjs
```

The pure halves and the gate always run (no network); the live half skips loudly without an engine or the internet.

## Layout

```
lib/policy.js lib/gate.js lib/cdp.js lib/engine.js   policy, gate, CDP, engine
lib/index.js        config, the lazy gate, three tools, three routes
lib/client.js       the tab: Visual / Reader / Metrics / Policy, tool cards (no build)
skills/web-render/SKILL.md
```
