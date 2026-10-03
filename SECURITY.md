# Security Policy

A plugin pack for the DeepSeek Harness **web** profile: one human, one machine, one
browser session. Loopback only, nothing that weakens the harness's authentication,
zero npm dependencies, and no outbound request of its own except the pinned ffmpeg
download below.

## The short version

- **Loopback only.** The app binds `127.0.0.1`; the CLI refuses an all-interfaces
  bind. Never put it behind a proxy, tunnel, port forward or published container
  port — that turns an authenticated surface into network-exposed code execution.
- **The printed URL is a password** (it carries the launch token). Never paste it
  into a chat, an issue, a screenshot or a recording.
- **No secrets in this repository, enforced not promised**: credentials live in
  `$DSH_HOME/.credentials.yaml`, outside this tree, and
  `scripts/checks/check-no-secrets.mjs` fails on a credential-shaped file before it
  can be committed.
- **Nothing patches core**: every plugin is a standard dsh bundle, and every route
  it adds sits behind the harness's own session check.
- **Zero npm dependencies**, vendored engines pinned by hash, no telemetry, no
  auto-update, no HTTPS server. Writes go only under `$DSH_HOME`, the session
  workspaces you open, and the Desktop for the two features that save a picture
  there.
- **Personal tooling, one trust domain** — not multi-tenant. Security fixes land on
  `main` as alpha bumps; there are no maintenance branches.

## Supported versions

Supported: `main`, and the harness line pinned in `.dsh-version.json`
(**0.2.0-rc.2**); any other published line is **not** tested and not claimed.
`dsh-rightbar`, `dsh-rightbar-files` and `dsh-open-in-app` are forks of that line's
client bundles, so a line bump is deliberate: bump the pin, run
`scripts/sync-vendored.ps1`, re-verify. The pack targets the **web profile only**,
stays alpha until promoted, and its installer is idempotent — uninstall removes
only the bundle, its patch layer and the skill folders it wrote (each marked
`.vncode-<package>`).

## Reporting a vulnerability

Report privately: on GitHub, **Security → Report a vulnerability** in
[`vecnode/vncode`](https://github.com/vecnode/vncode). Include the package and
version, the harness line you tested, the impact, and reproduction steps if they are
safe to share. Best-effort acknowledgement within **3 business days**; credit on
request.

Good-faith research on **your own** installation is welcome — no attacking other
people's instances, no data that is not yours, no destructive or denial-of-service
tests, no social engineering. Out of scope here (report upstream): bugs in
`@deepseek-ai/dsh-*` itself, model behaviour, the LLM provider, the harness's own
sandbox and file policy, and anything needing root/administrator, physical access, a
compromised OS or browser, or an already-unlocked session.

## Threat model

**The asset** is your machine behind one browser session: the files the model's
tools can reach, the workspace, conversation history, model API credentials, and the
harness's own shell surfaces. **The boundary** is plain HTTP over loopback,
authenticated by a session cookie minted from a per-process launch token —
everything the pack adds is mounted through the harness's own `connection` service
and inherits that gate instead of inventing one. Every surface follows one shape: an
exact-path route behind that fence, read-only where possible, argv-only spawns with
a deadline, realpath containment, and writes that are create-exclusive under
host-generated names (the package READMEs list the per-surface guards).

| Adversary | Defence |
|---|---|
| A page in the same browser calling `127.0.0.1` | `HttpOnly; SameSite=Strict` cookies, a Host/Origin fence that refuses `Sec-Fetch-Site: cross-site`, no CORS headers |
| DNS rebinding, or a stranger who finds the port | the Host header must be a loopback (or explicitly trusted) authority and the cookie's signed audience is bound to it; the index and every `/api` route answer `401` |
| Hostile model output or plugin input reaching a route | session roots resolved host-side, realpath containment, argv-only spawns, pattern-checked ids, create-exclusive writes |
| A leaked launch URL | it works only while that process runs and only from a loopback-reachable client; a leaked **cookie** is revoked by rotating the signing secret |

**Not defended against:** root/administrator, a compromised OS/browser/extension, a
person with your unlocked session, and — the important one — **deliberate
exposure**. Bind a LAN interface, forward the port or add a tunnel and the cookie is
all that stands between that network and your machine.

## How access control works

Five layers, all the pinned line's own code; the pack only registers routes behind
them. **The bind** is `127.0.0.1` (the CLI refuses `--host 0.0.0.0`). **The launch
token** is 32 random bytes per process, printed as the only authentication input;
`GET /?token=…` exchanges it (timing-safe) for a cookie and answers `303`. **The
session cookie** is `dsh-auth-<hash(authority)>` valued
`v1.<payload>.<HMAC-SHA256>`, `Path=/; HttpOnly; SameSite=Strict`, 30-day `Max-Age`
by default (`cookieMaxAgeDays` on the `connection` row). **The Host/Origin fence**
answers `403` for a foreign authority or a cross-site fetch and `401` for failed
authentication. **The index gate** serves `index.html` only to a session; the JS/CSS
bundles are public and contain no secrets. The signing secret lives in
`$DSH_HOME/.credentials.yaml`, written `0600`, and the harness refuses to boot if
that file is group/other-readable on POSIX.

## Lock it down

1. **Keep it on loopback**: the pack's launcher or
   `npx @deepseek-ai/dsh@0.2.0-rc.2 web`, no `--host`, no `--trusted-host`. Loopback
   traffic does not cross a firewall, so no firewall rule "fixes" an exposed bind.
2. **Treat the printed URL as a password**, and stop the app when you are not using
   it.
3. **Know what logs out**: stopping the app kills the launch token; deleting the
   site's cookies ends that browser's session; a **different port** invalidates
   cookies (name and audience derive from `host:port`); a plain restart does **not**
   log anyone out — the signing secret is durable.
4. **Rotate the secret** to revoke every cookie at once: stop the app, delete
   **only** the `client-connection/browser-session` entry from
   `$DSH_HOME/.credentials.yaml` (it also holds your model keys), save, restart. To
   shorten sessions instead, set `cookieMaxAgeDays` on the `connection` row in
   `$DSH_HOME/profiles/web/cordis.patch.yml` — a patch replaces the row's whole
   `config`, so restate what you rely on.
5. **Harden the machine** — loopback is only as private as the box: run as your own
   user (never root/administrator), patch the OS and browser, use disk encryption,
   lock the screen. "Locked" does not mean hidden from a local process or user, does
   not protect an unlocked screen, and does not sandbox the model's tools (that is
   the harness's own file policy).

## Verify your own instance

```sh
# 1. Loopback and nothing else. Expect 127.0.0.1, never 0.0.0.0.
ss -ltnp | grep 3080                     # Linux
lsof -nP -iTCP:3080 -sTCP:LISTEN         # macOS

# 2. Unauthenticated access is refused. Expect 401 and a one-line body.
curl -i http://127.0.0.1:3080/api/dsh-cmdbar/activity
curl -i http://127.0.0.1:3080/            # the index answers 401 too

# 3. The fence works. Expect 403 for a foreign authority and for a cross-site claim.
curl -i -H 'Host: evil.example' http://127.0.0.1:3080/api/dsh-cmdbar/activity
curl -i -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:3080/api/dsh-cmdbar/activity
```

Windows: `Get-NetTCPConnection -LocalPort 3080 -State Listen`. Then in DevTools →
Application → Cookies the `dsh-auth-…` entry must show `HttpOnly`,
`SameSite=Strict`, `Path=/` and an expiry about 30 days out. A `401` on step 2 and a
`403` on step 3 are the whole model working; the parts that are the pack's own are
pinned by `node scripts/checks/check-node-routes.mjs`.

## The launch token

`dsh web` prints one line once it is listening:
`dsh web: http://127.0.0.1:3080/?token=<launch token>`. The token is exchanged for
the session cookie, and everything after rides the cookie. The pack's launchers
(`scripts\run-web.bat` → `scripts/run-web.ps1`, `scripts/run-web.sh`) read it **in
memory** and never write it to a file (the POSIX half streams through an anonymous
FIFO for exactly that reason), never echo it, hand it to the browser as **one argv
element** (never a command string, so nothing in it reads as a shell metacharacter),
and open the URL **only** when it names a loopback address (`127.0.0.1`, `::1`,
`localhost`; on Windows only a literal `127.x.x.x`, so `127.evil.com` is refused).
`--no-open` is passed so the hand-off happens once. The token dies with the process
(restart to kill a leaked URL); the cookie is signed with a durable secret, so a
restart does not log a browser out — rotate the secret for that.

## Supply chain

- **Nothing to trust at install time**: no shipped package declares a runtime
  dependency, and the bundles are installed as live links.
- **Vendored engines are pinned and hashed**: CodeMirror 6, Mermaid and pdf.js are
  built from their `vendor/` folders and served by the packages
  themselves — no CDN, no runtime download. Each records a sha256 per file and a
  digest in `lib/vendor/…/VERSION.json`, re-hashed offline by `build.mjs --check`;
  forked bundles carry a GENERATED banner and are checked by
  `scripts/sync-vendored.ps1 -Check`.
- **One binary may be downloaded, and only when the machine has none**: ffmpeg. The
  repository ships a **pin** (`packages/dsh-media/lib/binaries.json`: official URL
  plus SHA-256 per platform-arch), never a 130–170 MB build. `PATH` wins; the
  archive is hashed as it arrives and compared with the pin **before anything is
  executed**; a mismatch installs nothing; unpacking uses the host's own `tar` and a
  `.partial` file is renamed into place; `DSH_MEDIA_NO_INSTALL=1` forbids the
  download entirely. `darwin-arm64` is deliberately unpinned (no Apple-Silicon
  build publishes both a URL and a checksum; a pin that moves is worse than an
  honest gap).
- Security-relevant behaviour is pinned by tracked checks: workspace containment,
  create-only writes, git option-injection refusal, screenshot refusals, diagram
  budgets, and the ffmpeg provisioning pipeline against a synthetic archive.

## Secrets never enter this repository

A secret in a commit is public for as long as the repository exists — in every fork,
clone and cache. `scripts/checks/check-no-secrets.mjs`, run by hand before anything
ships, scans exactly what `git add -A` would stage and fails on a key-shaped string,
a credential assignment (quoted name or not), a launch token in a URL, a
Google/Firebase api key, a GitHub/AWS/Slack/Stripe key, a private-key block or a
bearer JWT, plus a missing `.gitignore` credential rule. It never prints what it
found (file, line, rule and a masked preview only), its allowlist is empty by
design, and it self-tests that it fires.

**A vendored bundle carries its author's credentials.** The Canvas tab's vendored
Excalidraw (removed in alpha.13) shipped its OSS Firebase config — Google api key
included, and Firebase web api keys are public by design — so vendoring it put a
`google_api_key` in this public repository and GitHub's scanning opened a
`public leak` alert naming *Excalidraw's* key, which this repository can neither
rotate nor revoke. The fix is a **build patch**, never an allowlist entry: a patch
under the engine's own `vendor/<name>/patches/` blanks the `apiKey` value in every
file read from the pinned package's `dist/`, matched by key name so a rotated key
is redacted the same. Read what a third-party build ships before
committing it. **If a credential is ever committed:** rotate it first (assume it is
public), then remove it from history (`git filter-repo` or the BFG) and force-push —
deleting the file in a new commit does not remove it. Enable GitHub's secret
scanning and push protection as a second net.

## What the pack does not do

- No API keys are read: `$DSH_HOME/.credentials.yaml` is touched for **presence**
  only — a boolean, never a value.
- No way to weaken the harness's authentication, and no flag, setting or variable
  that turns the session check off.
- No WebSocket upgrade and **no shell of any kind** — the dock is a read-only
  transcript, and shells come from the harness's own terminal tabs.
