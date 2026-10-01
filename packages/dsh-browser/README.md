# dsh-browser (alpha.1)

**The pack's own Browser tab** — and the replacement for the one the harness
ships. It renders a page **on the host**, in a throwaway engine behind an egress
gate, and shows you the picture, the rendered text and the page's own numbers.
It also gives the model three tools over the same pipeline, so what you are
looking at and what the agent was told cannot disagree.

## Why the shipped tab was replaced

The shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` renders a remote page in
an `<iframe src=...>`, and its host half is six lines (`function apply() {}`) — no
proxy, no route. So the site's own framing policy decides whether anything appears
at all. Measured from this machine:

| Site | Header | In a frame |
|---|---|---|
| `google.com` → `www.google.com` | `X-Frame-Options: SAMEORIGIN` | **"www.google.com refused to connect"** |
| `github.com` | `deny` + `frame-ancestors 'none'` | refused |
| `developer.mozilla.org` | `DENY` | refused |
| `news.ycombinator.com` | `DENY` + `frame-ancestors 'self'` | refused |
| `example.com`, `en.wikipedia.org` | neither | loads |

That is a browser security feature, not a bug — and nothing client-side can lift
it. The shipped package is declared **desktop-only** upstream for exactly this
reason: on the Electron desktop host it uses a real `<webview>`, which is a
top-level browsing context and is not subject to `X-Frame-Options`. This pack
targets the raw web profile, so it renders instead of framing.

## The pipeline

```
 url ──policy.js──► https, 443, a qualified public host, never an IP literal
      ──gate.js───► loopback CONNECT proxy: resolve once, refuse the whole answer
                     set unless every address is public, connect to the address it
                     validated, bound the tunnel, RECORD the decision
      ──engine.js─► throwaway Chrome/Edge profile, driven over CDP
      ──here──────► page.png + meta.json under $DSH_HOME/dsh-browser/artifacts/
```

One function (`runRender`) serves the tools and the routes.

## The security story, in the order that matters

1. **The page never runs in your browser.** No iframe, no proxied HTML in this
   origin: the tab draws a PNG and text the host produced. A page's own scripts
   run in a disposable engine process, not in your session.
2. **The engine has no direct network access.** It is launched with the gate as
   its proxy and `--proxy-bypass-list=<-loopback>` (removing Chrome's implicit
   loopback bypass), so every socket — the document, its scripts, its fonts, its
   XHRs — is a `CONNECT` the gate policed.
3. **The gate applies the policy to every destination, not just the address bar.**
   It resolves the name itself, refuses the *whole* answer set when any address is
   private/loopback/link-local/etc., and connects to the address it validated, so
   a second lookup cannot rebind the name under it.
4. **The profile is thrown away.** A fresh `--user-data-dir` per render, no
   cookies, no logins, no history, deleted afterwards (stale ones are swept).
5. **The engine is never disarmed.** No `--no-sandbox`, no
   `--disable-web-security`, no `--ignore-certificate-errors` — the tracked check
   fails if one appears.
6. **The credential is not in a URL.** The gate demands `Proxy-Authorization` and
   the host answers the challenge over CDP (`Fetch.authRequired`), so the nonce
   never reaches a page and never lands in the render history.
7. **Every run is bounded.** One deadline, a timeout on every CDP command, an idle
   timeout and a byte cap per tunnel, and the browser process (found through CDP,
   not the launcher Windows exits immediately) is killed at the end. **And so is
   the machine**: a render *is* a browser process, so at most
   `MAX_CONCURRENT_RENDERS` (2) may exist at once, a short queue (8) waits its
   turn, and beyond that a call is refused with a `BUSY` sentence instead of
   starting another browser (`DSH_BROWSER_MAX_RENDERS` moves the ceiling).
8. **Nothing is taken on trust.** The PNG's pixel size is read back from the
   file's own IHDR chunk; the gate's trace is reported per render; and the page's
   own destinations are listed apart from the gate's tunnels, because the engine's
   connectivity probe goes through the same gate — which is how you can see that
   the gate is the only way out.

Nothing here reads or writes a caller-supplied path: the package touches only its
own artifacts under `$DSH_HOME/dsh-browser/`, so it has **no path policy at all**
to get wrong.

## The tab

Four views from one render: **Visual** (the PNG on a zoom ladder that moves the
layout box, never a CSS transform, so a zoomed picture stays scrollable to its
edge), **Reader** (the post-script text, its links clickable through the same
policy), **Metrics** (viewport, content size, counts, timing) and **Policy** (the
engine, the gate's tunnels/challenges/refusals by name, and the parked live mode).
Plus viewport presets (390/834/1280/1440/1920), full-page and dark toggles, its own
back/forward over render history, and a permanent banner saying the picture is a
host render and not a live page.

The type keeps the **replaced package's id and kind**, so a profile with Browser
tabs already persisted resolves them here; its `cordis.patch.yml` disables the
shipped row (the disable stays with the package that replaces it), and the
pack's master layer no longer re-enables it — a layer installed last must not
fight the package that now owns the row.

## The tools

| Tool | Back comes |
|---|---|
| `browser_render` | a PNG whose true size is read from the file, the page's numbers, the gate's verdict, the page's own destinations |
| `browser_query` | per CSS selector: `count`, `box`, computed `style`, `text`, `attrs`, `html` — the design/dimension tool |
| `browser_text` | the post-script text and the link inventory |

Each labels page content as **data, never instructions**, and each draws a
conversation card with the screenshot. A bundled **`web-render`** skill covers
when to render instead of using `web_fetch`, how to read a measurement, and what
the policy refuses.

## The policy, and why a refusal is not a bug

https only · port 443 only · no credentials in a URL · no IP literals · a
qualified public hostname (so `localhost` and `intranet` never resolve) · public
unicast addresses only, **the whole answer set** · an optional allow/block list.
Every refusal carries a code and a sentence naming the rule. Pages behind a login
are out of scope by design: this browser carries no cookies or session.

## The parked live mode

An interactive mode (per-host allowlist, framing protection lifted, opaque-origin
sandbox) is **parked and refuses in a sentence** (`LIVE_PARKED`). It is the one
thing that would put a remote page back inside this origin, which is what this
package exists to avoid. Say the word if you want it built.

## Layout

```
lib/policy.js   the pure URL + address policy (the security core, table-tested)
lib/gate.js     the loopback CONNECT gate: resolve, refuse, pin, bound, record
lib/cdp.js      a minimal DevTools Protocol client over Node's global WebSocket
lib/engine.js   engine resolution, throwaway profile, navigate/capture/measure/kill
lib/index.js    config, the lazy gate, three tools, three routes, artifacts, skill
lib/client.js   the tab: Visual / Reader / Metrics / Policy, tool cards (no build)
skills/web-render/SKILL.md
```

## Check

```sh
node scripts/checks/check-browser-node.mjs
```

The pure halves and the gate always run (no network); the live half skips loudly
without an engine or the internet and otherwise renders `example.com` for real.
