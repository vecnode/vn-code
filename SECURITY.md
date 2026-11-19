# Security Policy

A plugin pack for the DeepSeek Harness **web** profile: one human, one machine, one
browser session. Loopback only, nothing that weakens the harness's authentication,
zero npm dependencies, and no outbound request of its own except the pinned ffmpeg
download below.

## The short version

- **Loopback only.** The harness binds `127.0.0.1`; the CLI refuses an all-interfaces
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
`scripts/tools/sync-vendored.ps1`, re-verify. The pack targets the **web profile only**,
stays alpha until promoted, and its installer is idempotent — uninstall removes
only the bundle, its patch layer and the skill folders it wrote (each marked
`.vncode-<package>`).

## Reporting a vulnerability

Report privately: on GitHub, **Security → Report a vulnerability** in
[`vecnode/vn-code`](https://github.com/vecnode/vn-code). Include the package and
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

One call, through those gates: the printed URL buys the cookie, the cookie and the
Host/Origin fence are checked on every request, and only then does a pack route
run.

![A sequence diagram of one authenticated call: the page exchanges the launch token for a session cookie, asks a pack route with that cookie, and the gates verify the cookie and the Host/Origin fence before dispatching anything; the alternate region shows the refusal - 401 without a session, 403 for a foreign authority or a cross-site fetch](./assets/security.svg)

## What the launcher touches, and the browser

`scripts/run-web.*` is a launcher, not a supervisor, and its whole list is short: read the
pin from `.dsh-version.json`, decide the harness home, run the pinned
`npx @deepseek-ai/dsh@<pin> web --no-open` in the **foreground**, read the ready line from
its stdout, and open one URL. It starts no second server, writes no file of its own and
holds no credential.

**The home ladder is four rungs**, in both workers, and the order is the reason: `-DshHome`
(the person named it for this run), an inherited `DSH_HOME` (a harness session that started
this shell), a portable `<tree>/.vncode/home` when the tree carries the `PORTABLE` marker or
already holds a home, and `~/.dsh` - the harness's own default. A portable installation
keeps the pack, the sessions and the key inside the folder, so nothing lands in the user's
profile; `check-scripts.mjs` reads both workers for the marker and the `home` folder so the
rule cannot drift out of one of them.

**The environment is inherited, not composed.** The launcher hands the harness the
environment it was started with, so an exported `DEEPSEEK_API_KEY` reaches it exactly as it
would from a terminal. Nothing is copied between homes: a home outside this tree is only
ever the harness's own default that the launcher falls back to, and no file is read to
borrow a key from one.

Three rules the launcher holds, each the fact a future editor must not break:

1. **The ready line is read, never guessed.** The harness prints one line, `dsh web: <url>`,
   and the launcher takes the FIRST URL out of a line that names `dsh web:`, with ANSI
   colour stripped first - so an unrelated URL in the output is never mistaken for the tab.
   The token is read in memory: it is never written to a file, never echoed, and never put
   in a child's environment.
2. **Only a loopback URL is opened.** The check runs immediately before the browser starts,
   on the parsed host - a rule that holds at one end of a pipe is not a rule - and a line
   naming any other authority is refused rather than opened. That is what keeps a launch
   token from being handed to a browser pointed at somebody else's machine.
3. **The URL is one argv element, never a shell.** Chrome is started with the URL as a
   single argument, and the default-browser fallback goes through the platform opener
   (`ShellExecute`, `open`, `xdg-open`) with that same single argument. No shell is
   involved, so nothing in a URL can be read as a metacharacter.

**The key is the harness's, not the launcher's.** No command of this pack asks for it: the
harness resolves `DEEPSEEK_API_KEY` from its own environment, then a `.env` beside the
launcher, then `<home>/.env`, and the launcher inherits whatever the person's shell has.
A key is added in the harness itself under **Settings > Models**, or by putting that line in
`<home>/.env` - a layer the harness's own resolution reads, which keeps the secret inside
the folder and out of this repository.

## There is no embedded engine

Nothing in this repository draws a page, and that is a security decision as much as a
packaging one. The harness is a **web application**; the pack adds bundles to it and a
launcher that opens it:

- the launch token reaches **one program**: the browser the person already runs, as one argv
  element, from the launcher - not an engine inside this process;
- there is no engine profile anywhere in this tree to keep a browsing record, because there
  is no engine. A browser keeps its own history, in its own profile, where the person can
  see and manage it;
- there is no IPC channel, no injected script, no download handler, no permission handler
  and no navigation handler to audit, because there is no page in this process to attach
  them to. The whole class of "the engine recorded the token" findings is gone rather than
  mitigated: **measured**, after a single load of the harness a web-view build had the full
  URL - token and all - in `History`, `Favicons` and `Top Sites` inside its own profile;
- the launcher's attack surface is the four things it does: read the pin, decide the home,
  run `npx @deepseek-ai/dsh@<pin> web`, and open one loopback URL.

The one rule that outlived every pane: only a **loopback** URL is ever opened, checked in
the launcher immediately before the browser starts.

## Code execution this pack adds on purpose

Three packages run code for the agent rather than merely reading files. Each is named
here because "the tool ran a command" is a security property of the INSTALL, not a bug
in a route — and because the loopback bind is the only thing between that power and a
network.

| Surface | What it can run | What fences it |
|---|---|---|
| `dsh-supercollider`: the `sc_exec` / `sc_check` / `sc_load` tools and **`POST /api/dsh-supercollider/eval`** | **arbitrary `sclang`**, in the one long-lived interpreter the session shares — file I/O, `unixCmd`, `Pipe`, anything SuperCollider can reach | the harness session check only: loopback bind + the `dsh-auth-…` cookie + the Host/Origin fence. No path policy, no allowlist, no sandbox — by design, because it is the point of the plugin |
| `dsh-supercollider`: `sc_exec` → `scsynth`, and `sc_capture` | a SuperCollider audio server, its `.schelp` tree, and a UDP/OSC socket on loopback | argv-only spawn (no shell), a deadline per call, loopback-only UDP |
| `dsh-wsl`: `wsl_run` | **any program in a WSL distribution**, as your user - it is a shell without the shell syntax, which is the point (testing this pack's `sh` half on Windows) | argv only (a string command is refused), a deadline, a tree kill, 1 MB per stream, and the distribution named in every answer. Nothing narrows WHAT may run: that is the harness's permission layer, not this row's |
| `dsh-diagrams` (a TeX engine), `dsh-proto-lab` (the user's `make` / projectGenerator), `dsh-frontend-craft` and `dsh-browser` (this machine's Chrome/Edge) | a compiler or a browser | argv-only, no shell, throwaway browser profile, `-no-shell-escape`, loopback-only page URLs, deadlines and output caps |

**The `eval` route is the sharp edge.** `POST /api/dsh-supercollider/eval` exists so the
plugin's own console page can run a snippet; it is authenticated exactly like every other
pack route (401 without a cookie, 403 for a foreign authority or a cross-site fetch) and
it is **not** narrowed beyond that. Anyone who can load the GUI, or who holds the cookie,
can therefore execute code as your user — which is already true of the harness's own
terminal and file tools, but this route is the pack's own version of that power and it
should be read as such:

1. **Never expose the port.** No `--host`, no proxy, no tunnel, no published container
   port, no reverse proxy — this route is what makes "LAN-exposed" mean "remote code
   execution as you", not "someone can read my conversation".
2. **Stop the harness when you are done**, and treat the printed URL as a password (a leaked
   URL buys a cookie, and a cookie buys `eval`).
3. **Uninstall the package if you do not use SuperCollider** — a row you never open is
   still a route that is mounted.
4. Do not treat the route as sandboxed: it inherits the harness's file policy for the
   files the tools name, but `sclang` itself is a general-purpose interpreter with the
   privileges of the process that started it.

## Lock it down

1. **Keep it on loopback**: the pack's launcher or
   `npx @deepseek-ai/dsh@0.2.0-rc.2 web`, no `--host`, no `--trusted-host`. Loopback
   traffic does not cross a firewall, so no firewall rule "fixes" an exposed bind.
2. **Treat the printed URL as a password**, and stop the harness when you are not using
   it.
3. **Know what logs out**: stopping the harness kills the launch token; deleting the
   site's cookies ends that browser's session; a **different port** invalidates
   cookies (name and audience derive from `host:port`); a plain restart does **not**
   log anyone out — the signing secret is durable.
4. **Rotate the secret** to revoke every cookie at once: stop the harness, delete
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
  `scripts/tools/sync-vendored.ps1 -Check`.
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

**A vendored bundle carries its author's credentials.** A vendored Excalidraw this
pack shipped once carried its OSS Firebase config — Google api key
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
  only — a boolean, never a value. The DeepSeek key is the harness's own business: it
  resolves `DEEPSEEK_API_KEY` from its own environment, then a `.env` beside the
  launcher, then `<home>/.env` (`@deepseek-ai/dsh-credentials-local`: the managed store
  first, then the invoking project's `.env`, then the home's), and no command in this
  repository prompts for one or writes one. The managed document is **never written by
  this pack** — it is a strict `CredentialRef`-to-string YAML the harness refuses to boot
  on when it is malformed or readable beyond its owner.
- No way to weaken the harness's authentication, and no flag, setting or variable
  that turns the session check off.
- No WebSocket upgrade and **no shell of its own** — the dock is a read-only
  transcript, and shells come from the harness's own terminal tabs. The code this pack
  runs on purpose (a SuperCollider interpreter, a TeX engine, a compiler, a browser) is
  listed with its fence under **Code execution this pack adds on purpose** above.
