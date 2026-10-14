# `app/` - the vncode shell

A small native application that owns the instance: it opens on a **control panel**,
decides where the harness home is and creates it, installs this pack with one button,
starts the pinned `dsh web` harness when you press **Start**, shows it in the browser it
found on your machine, and ends the whole instance again on **Stop**. It draws no part of
the shipped interface - there is no embedded web view, on purpose - so the browser is the
only renderer in the picture, and the panel's job is to say which one, and to make changing
your mind one click.

It is a **launcher, not a desktop edition**: it starts the same pinned harness on a
free loopback port that `scripts\run-web.bat` / `./scripts/run-web.sh` start, and the
one thing it installs is this pack, into the `web` profile, through this pack's own
installer. `Start` is that same command; the app adds a window, a status line, a
location map, the buttons - and the root the harness home lives in.

```sh
cargo build --release          # in this folder; the binary is target/release/vncode
./target/release/vncode        # the control panel
./target/release/vncode -Help  # the flags, without starting anything
```

`scripts\run-desktop.bat` / `./scripts/run-desktop.sh` build and run it. A source
checkout needs the **Rust toolchain** ([rustup.rs](https://rustup.rs)) and Node.js
22+, which the npx fallback needs; a folder that carries a vendored `runtime/<rid>/`
needs neither.

## The lifetime it implements

| | what happens |
|---|---|
| **open** | One native window. **No child process, no port bound, no web view.** Nothing is decided before the first screen: if nobody has named a home (`-DshHome`, an inherited `DSH_HOME`, or a choice remembered from last time), the window **is** the home question - see below. After that, the panel resolves the app root and the home (by writing, not by assuming), reads the pin, the key layers, the location map and whether the pack is installed - all of them files on disk - and detects the browsers on this machine |
| **Install pack** | Runs `scripts/setup/install.bat` (Windows) or `scripts/setup/install.sh`, the same entry point a person clicks, with its output streaming into the panel's log. It is given `-DshHome <the chosen home>` and the same composed environment as the harness (see below). Disabled while a harness is running, and off in a folder with no `scripts/setup/` |
| **Uninstall pack** | The matching pair, `scripts/setup/uninstall.*` |
| **Start** | **One press to a working interface**: if the chosen home's profile lists none of this pack's bundles, the installer runs FIRST and the harness starts when it succeeds (the installer re-links the profile, so it must not run under a live harness - and nothing is running yet). Then the port is chosen (`-Port`, else a free port of this app's own - never the shared `3080`), the child's environment is composed, the harness is spawned from the best rung available (see below), and the shell watches for the ready line for up to 180 s. Stop works during this wait, in 200 ms steps |
| **Running** | The URL the harness printed is handed to the **chosen browser** - Chrome first when it is installed, the OS opener always in the table - as ONE argv element, and the panel names which browser took it. `Open tab` opens another one on demand, with the launch token the panel never draws |
| **Stop** | The whole tree dies - `taskkill /T` on Windows, one signal to the child's own process *group* elsewhere - and the port is then **checked**, not assumed: free, and nothing answers on it. The panel says so, or names the port something still holds |
| **close** | Same as Stop, plus the window geometry is written once, synchronously, into the app's own root |

Stopping something that was never started is not an error: the shell returns to
the state it opened in.

### The first screen is the home question

The panel used to be fifteen rows and a `~/.dsh` that was chosen for you. It is now a
choice, then four rows - and the choice comes first:

```text
  Where should your sessions, skills and key live?
  ┌ Use the DeepSeek home already on this machine        · recommended ┐
  │ C:\Users\you\.dsh · the pack is installed · 12 sessions · a key    │
  │ shared with `dsh web` and run-web.bat, not copied     [Use this home] │
  ├ Copy it here, and use the copy                                     ┤
  │ copies into <app root>\home · your key, if you tick it  [Copy it here] │
  ├ Make a fresh home in this project                                  ┤
  │ <app root>\home · the pack is installed into it next  [Create it here] │
  └────────────────────────────────────────────────────────────────────┘
```

Three cards when this machine already has an installation, **one** when it does not (a
card that says "nothing found" teaches nothing). The decision is
`vn_shell_core::firstrun`, which is `cargo test` cases - and the facts on each card come
from `profile.rs`, the same reader the log's "this home has no pack" note uses, so the
card and the log cannot disagree.

| the card | when it is offered | what it does |
|---|---|---|
| **use the home already on this machine** | it has the shape of a harness home AND a child can WRITE in it | runs the harness against that home itself - the same home `scripts\run-web` uses |
| **copy it here, and use the copy** | that home can be READ. **This is the way through a confinement** - a home that refuses `%LOCALAPPDATA%` refuses `~/.dsh` with it, and a copy only has to read the source | copies the durable things (skills, sessions, storages, attachments, and the key if ticked) into this app's own home, then Start installs the pack into the copy |
| **make a fresh home in this project** | always | an empty `<app root>/home`; Start installs the pack into it |

A card that cannot be honoured says why in one sentence instead of offering a button that
would fail, and the app never writes the choice for you: `prefs.json` is written by a
click, `Change` on the panel brings the question back, and a `-DshHome` or an inherited
`DSH_HOME` skips the screen entirely because somebody else already answered it.

### The panel, after that

```text
  vncode  ● running on 127.0.0.1:53412      [ Start ]  [ Stop ]  [ Open tab ]   up 2m
  ────────────────────────────────────────────────────────────────────────────────
  home     C:\Users\you\.dsh · the installation already on this machine   [Change]
  pack     installed · 24 bundles
  DeepSeek key  found in the credentials file
  browser  [ Google Chrome ▾ ] · opened in Google Chrome (a new tab)

  ▸ Details · 1 refused path(s)
```

Four rows, and every row is either a fact or an action. **`Details`** holds everything
that did not earn a place there - the pin, the runtime, the root and its origin, the
composed environment, the profile, the pid, the last setup and stop, the location map with
its sizes and its `reveal` buttons, the provider row, the refusals and the plan's notes -
because an inspector is not a control panel. A refusal shows as a badge on the disclosure,
so it can never be the thing that is hidden.

### The one trap the composer clears

`scripts/console/adapt.cmd` marks a run it has set up with `VNCODE_CONSOLE=1`, and an
entry point that sees the marker does **not** take its arguments from `%*` (and
`adapt.cmd` returns immediately), so any flags a caller passed are dropped. That is
correct for the paths it was designed for and a trap here: this app is started *by*
that layer, so it inherits the marker. It is removed from every child's environment by
`vn-shell-runtime`'s one composer (`env.rs`), for the installer **and** the harness.
Measured, not assumed: the first version of the Install button ran
`install.bat -NoTerminal -NoPause -Help` and started a full install. And a second
leak of the same family was measured while this was written: `VNCODE_HOME`, set for
the app, was still in the child - because an environment is inherited unless a
variable is REMOVED, which is why the composer removes rather than merely omits.

### Where the harness comes from

Four rungs, best first, and the second one is why Start does not need npm:

| rung | what it runs | needs |
|---|---|---|
| the vendored runtime | `runtime/<rid>/node/node …/harness/…/lib/bin.js web --no-open --port N` | the three pieces; no npm, no cache, no network |
| **the installation this machine already has** | `node <npm cache>/_npx/…/@deepseek-ai/dsh/lib/bin.js web …` | the Node on PATH. It is the harness a browser tab is already running, resolved through the profile's own link first |
| `npx` | `npx --yes @deepseek-ai/dsh@<pin> web --no-open --port N` | a writable npm cache, and the network on a first run |
| the test seam | whatever `VNCODE_STUB_CLI` names | nothing; a check only |

The second rung is skipped unless its `package.json` names the pin, because a machine
can have several harness installations cached (yours has four) and this shell must not
quietly run a different harness than `scripts\run-web.bat` does.

### The home: the app's root, and the harness home inside it

`$VNCODE_HOME` is the app's own root. It creates it, proves it by writing, and the
harness home is `<root>/home` inside it - so the keys, the sessions and the profiles
live in a directory this app controls rather than in `~/.dsh`, which belongs to
whichever harness used it first. `VNCODE_HOME` names another root; the platform's own
per-user data directory is the default; `<tree>/.vncode` is the last resort (a
workspace-scoped confinement, which this repository's own checks run inside).
[`docs/PATHS.md`](../docs/PATHS.md) is the whole map.

The home itself is chosen by a ladder over paths that have already been CLEANED
(`userpath.rs`): a leading `~` is expanded the way the harness expands it, a relative path is
resolved against the directory the app was started in, `.` and `..` are folded lexically, a
NUL or an empty value is refused by name, and what is exported is the REAL path (with the
Windows `\\?\` form stripped). **The first candidate that passes a real write probe wins**:

| # | candidate | when |
|---|---|---|
| 1 | `-DshHome <dir>` | the person named it. A refusal here **ends the run**, naming the flag - an explicit instruction is never silently ignored |
| 2 | the home chosen on the first-run screen | the click outranks an environment variable; `Change` in the panel brings the question back |
| 3 | an inherited `DSH_HOME` | it is writable: the app JOINS the home of the session that started it, sharing that session's sessions and key |
| 4 | **the installation already on this machine** | `~/.dsh` has the shape of a harness home, a child can **write** in it, and this app's own home still holds nothing of yours |
| 5 | `<VNCODE_HOME>/home` | the default, created and proved by the app |

**The first two rungs skip the first-run screen** - somebody already answered the question -
and rungs 3 to 5 are what the screen is FOR: the app would otherwise be guessing. Rung 4 is a
measured correction rather than a default. Without it the app came up on a fresh, bare harness -
no pack, no model key - beside a complete installation at `~/.dsh`, and the word for that was
"still does not run normally". It is deliberately narrow: **a one-time courtesy, not a policy**.
The moment that home holds something of yours the app stops looking, and the screen's
**"Make a fresh home in this project"** card makes this app's own root an explicit choice.
"Nothing of yours" is `adopt::home_is_untouched_by_a_person`: no `skills/`, no `sessions/`, no
credentials file with content - the harness's own first-boot furniture (a composed `profiles/`,
an empty `.credentials.yaml`, a `storages/`) does not count, which is the same measurement that
decides the copy offer.

A directory the app CREATED is hardened to `0700` on Unix, because it holds
`.credentials.yaml` and an npm cache; a directory the app merely JOINED is never touched,
which is why the probe reports whether it created it. The app never writes a note, a log or
anything else into a home it refused - the one write it makes outside its own root is the
probe file, created and deleted at the root of a home it is considering, because "can a child
write here" is not knowable any other way.

A home this account cannot write in used to be a **refusal** - one sentence asking the
person to start the app differently, which cannot fix a parent process that confines
what its children may write (an agent session, an IDE runner, a CI sandbox; this
repository's own checks run inside one). It is now a **rung that was refused**: the
reason is a line in the log and a row in the panel, and the run continues in a home the
app created. Measured on the machine this was written on: `%USERPROFILE%\.dsh` is
owned by the signed-in account and takes a write; the same directory refuses a child
whose parent confines it.

### Every child's environment is composed, never inherited

The harness, the installer, and the browser hand-off all get an environment built from
the plan, because a variable that is merely *not set* is still inherited:

| variable | value |
|---|---|
| `DSH_HOME` | the chosen home, always - the harness is TOLD, never asked |
| `npm_config_cache` | the cache chosen by write probe; **removed** when none was usable, so npm's own default stands rather than an inherited value |
| `PATH` | the vendored runtime's `node` directory first, when one is used |
| `TMP`, `TEMP`, `TMPDIR` | `<app root>/tmp` - but **only** when the machine's temp is not writable by a child. Measured, from a real run: `dsh-spill-local: EPERM … mkdtemp 'C:\Users\…\AppData\Local\Temp\dsh-spill-XXXXXX'`, and the row that owned it did not activate. The machine's temp is left alone whenever it works |
| the working directory | the workspace the panel names, captured once - `keystate` reads `<cwd>/.env` because the harness inherits it, so one value serves both |
| `VNCODE_HOME` and the seven `VNCODE_*` console markers | **removed** - the app's own word for its root, and the launcher's own markers, are none of a child's business |

What is *not* removed is everything the machine owns (`PATH`, `HOME`, `TEMP`,
`SystemRoot`, proxies). The rule is precise: every variable this app owns is set or
removed deliberately - and `check-shell.mjs` reads the child's own answer back, which
is how an inherited `VNCODE_HOME` was caught.

### The surface: the browser, and only the browser

This app draws no part of the shipped interface. `browser.rs` is a table, Chrome first, and
the last rung is the platform's own opener - so *every* browser works, including one the
table has never heard of:

| family | entries | how it is started |
|---|---|---|
| Chromium | Google Chrome, Microsoft Edge, Brave, Chromium, Vivaldi, Opera | the program, with the URL as exactly ONE argv element |
| Firefox | Mozilla Firefox | the same |
| the floor | `rundll32.exe url.dll,FileProtocolHandler` (Windows), `open` (macOS), `xdg-open` (Linux) | the same - a program, never a command string |

The Windows floor is `rundll32`, not `explorer.exe`: the latter is unreliable from a
non-interactive child, and it was measured doing **nothing at all** when the panel's button
spawned it. `rundll32 url.dll,FileProtocolHandler <url>` is the documented way a program (not
a shell) asks the shell for the default browser.

The choice is remembered in `<app root>/prefs.json` as an **id**, never a program path, so a
hand-edited preferences file cannot name something to run; a remembered browser that has been
uninstalled falls through to the first one found rather than refusing to show the page; and
the panel's `surface` row is a chooser over what was actually detected, plus which browser the
last launch used. Detection is a pure function of the facts, so the table AND its order are
`cargo test` cases on every platform, including the OS guards that stop a Windows install path
being probed on Linux. Three rules travel with every launch: the URL is one argv element, only
a **loopback** URL is accepted (checked again here, at the last function before a process
starts), and no shell is ever in the middle.

### Adopt, and the copy that makes a read-only home usable

Rung 4 of the home ladder uses an installation in place, which needs it to be WRITABLE -
and a confinement that refuses `%LOCALAPPDATA%` refuses `~/.dsh` with it. The copy card is
the way through: it only has to READ the source, and it brings across `skills/`,
`sessions/`, `storages/` and `attachments/`, with `.credentials.yaml` behind its own tick.

Two rules came out of a real run, and both were bugs before they were rules:

* **`Use it` needs a home a child can WRITE in; the copy only needs one it can READ.**
  Passing the writable-filtered path to both meant a person whose `~/.dsh` was unwritable
  got *neither* - the worst of both, and no way to reach their key.
* **A copy is offered while there is something left to bring, and nothing to overwrite.**
  The test used to be "the home has no `profiles/`", which was wrong twice over: the
  harness composes `profiles/<name>/` on its FIRST boot and writes an empty
  `.credentials.yaml` and a `storages/` beside it, so a home the app created stopped
  looking "untouched" after one run and the offer vanished. Measured: the panel said
  `DeepSeek key: not found` while the key sat in `~/.dsh`, with no button to press. A
  durable tree is now offered when the source has it and the target has nothing in it; the
  credential document when the source's has **content** and the target's is absent or empty
  - a file SIZE, never a read, so the presence-only rule stands.

The caches are never copied (512 MiB, 200 MiB and up to 8 GiB, all reproducible),
`profiles/` is never copied (the installer re-creates it, and the pack's links point into
this repository), nothing is ever written into the source home, a file that already exists
is never overwritten, and a link is skipped rather than followed.

The install half of that works under the same confinement, and it is measured rather than
hoped for: with `%LOCALAPPDATA%` deliberately unwritable and only the cache and temp handed
over (which the environment composer already does), the installer lands 24 bundles and 23
skills, exit 0. Without the cache it fails with `ENOTDIR` inside the blocked directory.

### The port: a port of this app's own, never the shared one

`3080` is what every `dsh web` on the machine reaches for, and the app **no longer asks for it**.
Measured on the machine this was written on: an app instance bound `127.0.0.1:3080` while another
harness answered on it, so the tab the app opened was served by the wrong process, whose launch
token the app did not have - and the button that should have opened a tab looked broken. A free
port costs nothing here, because the app opens the tab itself with the token in it: nobody types
an address and nothing has to be remembered per origin. `-Port 3080` is still the way to ask for
the shared origin on purpose, and Stop asserts BOTH that the port is free and that nothing
answers on it any more.

### Where npm's cache goes, and why it is chosen rather than assumed

The `npx` fallback needs a cache npm can write in, and a cache it cannot write in
fails the whole launch with `EPERM` and then advises running as Administrator - which
is the advice that *created* the unwritable directory. So the cache is picked:

1. `$VNCODE_HOME/npm-cache` - `%LOCALAPPDATA%\vncode\npm-cache` by default;
2. the harness home, `$DSH_HOME/vncode/npm-cache`;
3. `runtime/npm-cache` inside the checkout.

The child's **temp directory** is chosen the same way, and for the same kind of reason:
the machine's `TMP`/`TEMP`/`TMPDIR` is used when a child can write in it, and
`$VNCODE_HOME/tmp` when it cannot — the case a real log showed, where the harness's own
`dsh-spill-local` row died on `mkdtemp` and did not activate.

Each candidate is probed **where npm actually writes** (`<cache>/_cacache/tmp`, not
the cache root - a cache whose root is writable while its `_cacache` tree belongs to
an elevated run fails in exactly the reported way), the first usable one wins, and a
refused candidate prints a line saying so. A vendored runtime reads no cache at all,
which is why `scripts/tools/vendor.ps1` removes this problem rather than working
around it.

## The first page

A control panel, not a splash screen - and after the home is chosen it is **four rows and
three buttons** (the layout is drawn above; the long version is in
[`docs/PLAN-egui-shell.md`](../docs/PLAN-egui-shell.md)):

| row | what it is |
|---|---|
| `home` | the path in use, its origin, whether this app created it, and **`Change`** - which puts the first-run question back in front of you |
| `pack` | whether this pack is in the profile the harness will load, and `Install pack here` (or `Stop and install`) when it is not |
| `DeepSeek key` | which of `keystate`'s four layers supplied a key - a layer NAME, never a value - with the one hint worth having when it is missing: the other home has one and `Change` can copy it |
| `browser` | the chooser over what was actually detected, plus which browser the last launch used |

**`Open tab`** is the one control that carries the launch token: the panel draws the URL
*without* its query, because that URL is a credential, so this button is how a tab is opened
- or re-opened after it was closed. **`Details`** (closed by default, badged when a path was
refused) holds everything else: the pin, the runtime, the app's root and its origin, the
composed environment, the profile, the pid, the last setup and stop, the **location map**
(`docs/PATHS.md` as rows, each with a size and a `reveal` button), the model provider - a
chooser with one entry (`DeepSeek (official)`), read-only while a harness is live because the
route is read at boot - the refusals, and the plan's notes. The Install/Uninstall pair lives
there too: uninstall is not a twice-a-day action, and the install the panel offers is on the
pack row.

The chrome takes its palette from the profile's own `cordis.patch.yml`
(`ui-state`'s theme, `ui-theme`'s preference), so the native frame and the page it
frames are not two different applications.

## The crates

| crate | what it is |
|---|---|
| `crates/vn-shell-core` | the **pure** halves, each driven by `cargo test`: `readyline` (the ready line, its refusals and the token redaction), `windowstate` (the geometry record and its trust rules), `keystate` (the four key layers, presence only), `appdata` (the app's root, the home inside it, the write probe and the npm cache), `userpath` (what a person typed, turned into a path a child may be given), `browser` (the per-OS browser table and the argv rule), `appprefs` (the browser id and the chosen home), `adopt` (what may be copied out of a home this app did not create), plus `options`, `home` (the two ladders), `ports`, `launch`, `log`, `prefs`, `status` and `urlpolicy` |
| `crates/vn-shell-runtime` | the supervisor: one thread owns one child, resolves the plan, spawns, drains both streams, watches the ready line, takes Stop, kills the tree and checks the port. Also `env` (the one composer every child's environment comes from), `console` (the one transcript), `setup` (the installer runner behind the panel's buttons) and `adopt` (the copy runner behind its own) |
| `crates/vn-shell-paths` | the location map as data, with the per-OS roots and a bounded size walk |
| `crates/vn-shell-egui` | the panel, the palette, the pages and the status grid |
| `crates/vn-shell` | the binary (`vncode`): flags, wiring, and the mode that opens no window |

The four load-bearing modules were **moved** from the old Tauri launcher rather
than rewritten, comments and tests included: `readyline.rs`, `windowstate.rs`,
`keystate.rs` and `appdata.rs` are each the record of a bug that was measured on a
real machine.

## Modes

`-Mode panel` opens idle and starts nothing; `-Mode headless` opens **no window** and takes
`stop`, `quit`, `install [args]` and `uninstall [args]` on stdin - it is the mode a server
wants, and the one `scripts/checks/check-shell.mjs` drives against a stub. The default is
**`-Mode chrome`**, which is the only surface this build has: the harness UI in a browser the
app found.

**There is no `embed`.** This app draws no web view and does not plan to: the interface is a
web application, the process that draws it is a browser, and `browser.rs` is the table that
finds one. `-Mode embed` is refused **by name**, with that reason, rather than quietly opening
a browser - a flag that silently means something else is a flag nobody can trust.

`-Mode headless` with `-DshVersion` set is a complete supervisor for a machine
with no display:

```sh
./target/release/vncode -Mode headless -Port 3080 < /dev/null
printf 'install\nquit\n' | ./target/release/vncode -Mode headless
```

## The two rules that must survive any edit

The ready line carries the **launch token**, a live credential for the running
process. Both rules are pinned by tests in
`crates/vn-shell-core/src/readyline.rs` and by `vn-shell-core`'s `status` module:

1. **The token is read in memory** - never written to a file, never handed to a
   shell, never echoed: the shell prints `token=REDACTED`, the log redacts on the
   way IN so a line cannot reach the panel redaction-free, and `Status`'s `Debug`
   is written by hand precisely so a panic cannot print it. The one reader of the
   full URL is `Status::navigate_url`, which the browser launch uses.
2. **Only a loopback URL is loaded.** A ready line naming any other host is
   refused and reported, and `browser::command` checks the same rule again before a
   process is started with that URL in its argv; a link clicked inside the page goes
   to the browser as an ordinary navigation.

`scripts/checks/check-shell.mjs` drives both: it starts the shell against a stub
CLI that prints a ready line carrying a recognisable token and one naming a
foreign host, and asserts that the token appears in no stream and no file the run
created - in **both** roots the run writes, the app's own and the harness home.

## Files

| Path | What it is |
|---|---|
| `Cargo.toml` | the workspace, one pin per dependency, and the release profile the shipped binary is built with |
| `crates/vn-shell/src/main.rs` | the wiring: flags, the panel, and headless mode |
| `crates/vn-shell-core/src/{readyline,windowstate,keystate,appdata}.rs` | the moved pure halves, with the tests that pin them (`payload`, the single-file container reader, left with the distributer that produced such files) |
| `crates/vn-shell-core/src/{userpath,browser,appprefs,home,adopt}.rs` | where a typed path becomes a usable one; the per-OS browser table and the argv rule; the app's own small preferences; the two ladders; and what may be copied out of a home this app did not create |
| `crates/vn-shell-egui/src/lib.rs` | the panel: the header, the buttons, the status grid, the paths table, the provider row, the log |
| `crates/vn-shell-runtime/src/lib.rs` | the supervisor, and the console both it and the installer write to |
| `crates/vn-shell-runtime/src/env.rs` | the ONE composer every child's environment comes from: what is set, what is removed, and the working directory |
| `crates/vn-shell-runtime/src/setup.rs` | the installer runner behind the panel's two buttons, given the same environment and `-DshHome` |
| `crates/vn-shell-runtime/src/adopt.rs` | the copy runner behind the Adopt button: a bounded recursive copy, no overwrites, links skipped |
| `assets/icons/` | the window and exe icons, generated by `node scripts/tools/make-desktop-icon.mjs` from `assets/vncode.svg` |
