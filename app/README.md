# `app/` - the vncode shell

A small native application that owns the instance: it opens on a **control panel**,
decides where the harness home is and creates it, installs this pack with one button,
starts the pinned `dsh web` harness when you press **Start**, shows it in the browser it
found on your machine, and ends the whole instance again on **Stop**. It draws the shipped
interface only when it is built to: the default build compiles no engine and shows the harness
in a browser it found, and `cargo build --release -p vn-shell --features pane` shows it inside
this window instead - one optional dependency on `wry`, nothing vendored. Either way the panel's
job is to say which surface is in use, and to make changing your mind one click.

It is a **launcher, not a desktop edition**: it starts the same pinned harness on a
free loopback port that `scripts\run-web.bat` / `./scripts/run-web.sh` start, and the
one thing it installs is this pack, into the `web` profile, through this pack's own
installer. `Start` is that same command; the app adds a window, a status line, a
location map, the buttons - and the root the harness home lives in.

**And it starts the SAME home `run-web` now starts.** A folder that is a **portable
installation** - it carries `.vncode/PORTABLE`, or `.vncode/home` already exists - keeps
the pack, the sessions, the key, the preferences, the npm cache and the window record
inside itself, and both launchers resolve `<tree>/.vncode/home` as `DSH_HOME`: the panel
through its root ladder, `run-web` through the same rule implemented in its worker (the
portable rung sits below an explicit `-DshHome` and an inherited `DSH_HOME`, and above
`~/.dsh`). Before this, the panel and `run-web` pointed at different homes, which was
measured on a real machine as the panel reporting 24 installed bundles while `run-web`
started a home that had none. Nothing in the user's profile is needed, which is what makes
a checkout - or a copy of one - portable across machines. The core harness is untouched:
`DSH_HOME` is still set explicitly for the child, and `~/.dsh` remains the harness's own
default for any folder that is not portable.

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
| **Install pack** | Runs `scripts/setup/install.bat` (Windows) or `scripts/setup/install.sh`, the same entry point a person clicks, with its output streaming into the panel's log. It is given `-DshHome <the chosen home>`, the same composed environment as the harness (see below), and **`-Resume`** - which undoes the `-Force` a double-click implies, so a second press adds only what the profile is missing instead of re-adding all 24 bundles |
| **Uninstall pack** | The matching pair, `scripts/setup/uninstall.*` |
| **Start** | **One press to a working interface**: if the chosen home's profile lists none of this pack's bundles, the installer runs FIRST and the harness starts when it succeeds (the installer re-links the profile, so it must not run under a live harness - and nothing is running yet). With no installer beside the app, Start **refuses** with a sentence instead of opening the bare interface. Then the port is chosen (`-Port`, else a free port of this app's own - never the shared `3080`), the child's environment is composed, the harness is spawned from the best rung available (see below), and the shell watches for the ready line for up to 180 s. Stop works during this wait, in 200 ms steps |
| **Running** | The URL the harness printed is handed to the **chosen browser** - Chrome first when it is installed, the OS opener always in the table - as ONE argv element, and every rung is then WATCHED for one settle window: a program that exits zero handed the URL to a browser that was already running, one that is still alive IS the browser, one that exits with a failure status did not open anything and the next rung is tried - where the second rung is the same browser with a profile inside this folder, and the floor's exit status is reported as unverifiable because `rundll32` always exits zero. **Every rung's sentence reaches the log**, so the transcript says which one took the page. `Open tab` opens another one on demand, with the launch token the panel never draws |
| **Stop** | The whole tree dies - `taskkill /T` on Windows, one signal to the child's own process *group* elsewhere - and the port is then **checked**, not assumed: free, and nothing answers on it. The panel says so, or names the port something still holds |
| **close** | Same as Stop, plus the window geometry is written once, synchronously, into the app's own root. A close request while a copy or an install is in flight is **refused once**, with a sentence: measured, the npm log stopped mid-resolution and the profile was left listing the bare harness. Closing again is honoured |

Stopping something that was never started is not an error: the shell returns to
the state it opened in.

### The first screen is the home question

The panel used to be fifteen rows and a `~/.dsh` that was chosen for you. It is now a
choice, then four rows - and the choice comes first:

```text
  Where should your sessions, skills and key live?
  Pick one. It is remembered, and Change on the next screen brings this back.

  ┌ ▸ Copy it here, and use the copy                                   ┐
  │ copies into <app root>\home                                         │
  │ ▸ details                          [ Copy it here and continue ]    │
  ├   Use the home in this folder                                      ┤
  │ <app root>\home · empty, and private to this app                    │
  │ ▸ details          [ Create the home here and continue ]            │
  └─────────────────────────────────────────────────────────────────────┘
  [ Copy it here and continue ] · the card marked ▸ above
```

Two cards when this machine already has a home to copy from, **one** when it does not (a
card that says "nothing found" teaches nothing). Each card draws **one line open** - the
path, and the fact that decides it - and folds everything else into its own `details`
disclosure, closed by default: measured on a real machine, with every fact open, three cards
filled the window and pushed each card's own reason and its button off the bottom of it. The
decision is `vn_shell_core::firstrun`, which is `cargo test` cases - and the facts come from
`profile.rs` and `adopt.rs`, the same readers the log's "this home has no pack" note uses, so
the card and the log cannot disagree.

**Every card ends inside this folder.** The card that used to come first - "use the DeepSeek
home already on this machine" - ran the harness against `~/.dsh`, and it is gone: a folder
that carries everything it needs must not reach into a person's profile to START. What that
rung was for is answered here instead - **Start** installs the pack into the home in use, and
the **key** row asks for the key - so the one thing left that reads `~/.dsh` is the COPY,
which only reads.

**The reason is never collapsed, and the arrow decides.** `×` marks a card that cannot be
taken here, and its sentence is drawn open under it: the answer to "why can I not press
this" is not something to hide behind a disclosure. `▸` marks the card the app suggests - the
copy while there is something to bring, the folder otherwise, and never both - and the
**button at the foot of the screen** takes exactly that card, so a screen that honestly
offers one answer is never a dead end.

Nothing the panel draws carries markup: these sentences reach the reader through a label that
renders no markdown, so `**Install pack**`, a backticked `Change` and a backticked `dsh web`
all arrived as literal punctuation - measured on this very screen. A test now refuses `**` or
a backtick in any card sentence or plan note.

| the card | when it is offered | what it does |
|---|---|---|
| **copy it here, and use the copy** | that home can be READ **and there is something left to bring** (a durable tree the target lacks, or a key it lacks - from the copy's own plan, not the source's inventory) | a ONE-WAY import: copies the durable things (skills, sessions, storages, attachments, and the key if ticked) into this app's own home, then **installs the pack into that copy** - the card's own second half, which nothing used to act on |
| **use the home in this folder** / **make a fresh home in this project** | always; the title says which of the two it is | this app's own root. Empty and private when nothing is there; when it already holds your sessions the card says so and says nothing is deleted - it never deletes anything. Start (or the install that follows a copy) puts the pack into it |

There is deliberately **no** card that runs the harness against a home outside this folder,
because nothing outside this folder is ever the home it runs against - see the ladder below.

The copy card is a promise about what the next click does, so it is offered exactly when
the next click would do something, and it advertises only what its own plan would really
bring - a card that could not be pressed used to promise a key and a pack while the red
sentence beside it said there was nothing to bring. A copy that fails says so at the top of
the screen: its own sentence used to live inside `Details`, which is how a press that did
nothing looked like a broken button.

A card that cannot be honoured says why in one sentence instead of offering a button that
would fail, and the app never writes the choice for you:
`prefs.json` is written by a click, `Change` on the panel brings the question back, and a
`-DshHome` or an inherited `DSH_HOME` skips the screen entirely because somebody else
already answered it.

### The panel, after that

```text
  vncode  ● running on 127.0.0.1:53412      [ Start ]  [ Stop ]  [ Open tab ]   up 2m
  ────────────────────────────────────────────────────────────────────────────────
  home     C:\Users\you\proj\.vncode\home · this app's own home (the default)   [Change]
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

**And it is searched in THIS folder's caches before the machine's own.** Measured on the
machine this was written on: an app whose root, home, pack, sessions and key were all inside a
portable folder still started its harness out of `%LOCALAPPDATA%\npm-cache\_npx\…` - the one
directory that made "everything is in this folder" untrue on every single Start. The order is
`<app root>/npm-cache` (where this app's own installs land, and the cache it hands every child
as `npm_config_cache`), then `runtime/npm-cache` inside the checkout, then the machine's shared
cache - which keeps a portable folder portable while still finding the harness a `run-web` on
the same machine already installed.

### The home: the app's root, and the harness home inside it

`$VNCODE_HOME` is the app's own root. It creates it, proves it by writing, and the
harness home is `<root>/home` inside it - so the keys, the sessions and the profiles
live in a directory this app controls rather than in `~/.dsh`, which belongs to
whichever harness used it first. `VNCODE_HOME` names another root; a **portable folder**
(marker, or a home already inside it) is next; the platform's own per-user data
directory is the default; `<tree>/.vncode` is the last resort (a workspace-scoped
confinement, which this repository's own checks run inside).
[`docs/PATHS.md`](../docs/PATHS.md) is the whole map.

**Everything the app owns lives under that ONE root** - the window record, `prefs.json`,
the npm cache and the home - and that is a rule rather than tidiness. The preferences used
to be written into the platform's data directory while the root the ladder had chosen was
beside the checkout, so on a machine whose ladder fell through to `<tree>/.vncode` the
home somebody chose was written where the next run could not read it and the first-run
question came back on every launch. `prefs.json` is now read from the ladder's root, with
the platform copy as a **read-only fallback** for exactly that migration, and saved into
the ladder's root.

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
| 4 | `<VNCODE_HOME>/home` | the default, created and proved by the app |

**Rungs 1 and 2 skip the first-run screen** - somebody already answered the question - and
rungs 3 and 4 are what the screen is FOR: the app would otherwise be guessing.

**Nothing outside this app's own root is ever the home it runs against.** The harness's own
default (`~/.dsh`) was once rung 4 here, a one-time courtesy used while this app's own home was
still empty, and it is gone: the two things it existed for - a home with no pack, a home with no
key - are answered by this app itself. **Start** installs the pack into the home in use, and the
**key** row asks for the key. What `~/.dsh` is still read for is the first-run COPY, which
brings a person's own sessions and key INTO the folder; `adopt::home_is_untouched_by_a_person`
is the measurement both that offer and the app's own home share - no `skills/`, no `sessions/`,
no credentials file with content. The harness's own first-boot furniture (a composed
`profiles/`, an empty `.credentials.yaml`, a `storages/`) does not count as a person's work.

### A portable folder: one installation, kept where it is

A folder that carries `<tree>/.vncode/PORTABLE`, **or that already holds a home**, is a
portable installation: its own `.vncode` is the root the next start uses, ahead of the
platform's data directory. Both halves matter. The marker is the explicit choice, written
by **`Keep everything in this folder`** on the `vncode root` row in `Details`; a home
already inside the folder is the same answer without anybody pressing anything, which is
what makes a confined run - whose only writable root was the folder - remember where it
put the person's sessions instead of starting a second installation beside them.

The running app cannot move its own root (the home, the geometry and the preferences all
live in it), so the button writes the marker and says **restart**, rather than pretending
the click took effect. On the next start the root ladder reports the change as "this
folder, because it is a portable installation", and everything - home, `prefs.json`,
`window.json`, `npm-cache` - is inside the folder. Set `VNCODE_HOME` to overrule it.

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

**And a fourth rule, which is the one that was missing: a spawned process is not a page.**
`spawn()` says a process was CREATED and nothing else, and the panel used to take it for a tab
that opened - so a browser that died on the way up was reported as `opened in Google Chrome (a
new tab)` over a window that never appeared, and the reader's report was "I press it and
nothing happens". Measured on the machine this was written on, and then on the owner's:

```text
[vncode] Google Chrome exited with status 0x80000003 before it could show the page, so no tab was opened
[vncode] handed the page to the default browser, which was already running   <- and no page appeared
[vncode] opened http://127.0.0.1:58511/ in the default browser               <- a claim nothing could back
```

Chrome's own words, from the same run: `CreateFile …\Google\Chrome\User Data\Crashpad\
settings.dat: Access is denied`. So every rung is watched for one **settle window**
(`browser::SETTLE`, 1.5 s), and the verdict is all the panel may say:

| the program | what it did | what the panel says |
|---|---|---|
| still running when the window closes | it IS the browser - the only verdict a browser of this app's own making can give | which browser took the page |
| exited **zero** | a browser that was already running took the URL and the relay left (measured at 60-90 ms) | the same |
| exited **zero**, and the rung is the platform's opener | **nothing: `rundll32` exits zero whether or not a window appears** | `asked … for the page; it reports success without saying whether a window appeared, so this app cannot tell` - never "opened" |
| exited with a failure status | it never showed the page | its status, in hex when it is an NTSTATUS, then the **next rung** |

The rungs are, in order: **the browser the person chose** → **the same browser with a profile
inside this app's own root** → **the platform's own opener**. The middle rung is the one that
answers the measured failure: a confinement that refuses a browser its own profile directory
cannot refuse one under the root this app has already proved it can write - the same rule that
hands a CHILD `<app root>/tmp` when the machine's temp is refused. It is the fallback, and it is
used FIRST when this app's own temp probe was refused, because that is what a session which
confines what this app starts looks like and a doomed launch is owed to nobody. A page there is
not a tab in the person's own browser: the row says
`a window of its own, with a profile in this folder`, and their Chrome is left completely alone.

**Every rung's own sentence goes into the transcript**, the `browser` row says `opening in …`
with a spinner while the walk is in flight, and the walk runs on its own thread - 1.5 s of a
blocked UI thread reads as a hang, and a walk already in flight is never restarted, so pressing
the button twice cannot open two tabs.

When nothing takes the page and this app has the measurement that names the reason - its own
probe of the machine's temp directory was refused, which is what a confined parent looks like -
the notice says so and names the step that exists: start vncode by double-clicking
`scripts\run-desktop.bat`, outside that session.

### The copy, and why it is the only thing that reads a home this app did not create

The copy is a ONE-WAY import into this app's own home: `skills/`, `sessions/`, `storages/`
and `attachments/`, with `.credentials.yaml` behind its own tick. It only ever READS the
source, which is what makes it the way through a confinement - a home that refuses
`%LOCALAPPDATA%` refuses `~/.dsh` with it, and a copy needs neither.

Two rules came out of a real run, and both were bugs before they were rules:

* **The copy only needs a home it can READ.** The offer used to be filtered by whether a
  child could WRITE in the source - which is what running against it needs, and nothing the
  copy does - so a person whose `~/.dsh` was unwritable got *no* way to reach their key.
* **A copy is offered while there is something left to bring, and nothing to overwrite.**
  The test used to be "the home has no `profiles/`", which was wrong twice over: the
  harness composes `profiles/<name>/` on its FIRST boot and writes an empty
  `.credentials.yaml` and a `storages/` beside it, so a home the app created stopped
  looking "untouched" after one run and the offer vanished. Measured: the panel said
  `DeepSeek key: not found` while the key sat in `~/.dsh`, with no button to press. A
  durable tree is now offered when the source has it and the target has nothing in it; the
  credential document when the source's has **content** and the target's is absent or empty
  - a file SIZE, never a read, so the presence-only rule stands.

A third came out of the same machine, and it was the click that did nothing: the card was
offered on *"the source can be read"* alone, so pressing it over a home **already copied
here** planned no items at all, the runner refused with one sentence - and that sentence was
drawn inside `Details`. The card is now unavailable in exactly that state, with the reason
on it, and both the copy's own line and the panel's notices stand at the top of the screen.

And the copy is only half of what the card promises. **The pack is installed into the copy
by the app itself** the moment the copy finishes, because the installer must not run under a
live harness and nothing is running yet: one press of the copy card reaches a home with the
sessions *and* the pack in it, and Start is then the ordinary Start.

The caches are never copied (512 MiB, 200 MiB and up to 8 GiB, all reproducible),
`profiles/` is never copied (the installer re-creates it, and the pack's links point into
this repository), nothing is ever written into the source home, a file that already exists
is never overwritten, and a link is skipped rather than followed.

The install half of that works under the same confinement, and it is measured rather than
hoped for: with `%LOCALAPPDATA%` deliberately unwritable and only the cache and temp handed
over (which the environment composer already does), the installer lands 24 bundles and 23
skills, exit 0. Without the cache it fails with `ENOTDIR` inside the blocked directory.

### The install is resumable, visible, and not killed by closing the window

Three measurements shaped this, all from one machine's own npm logs and from the profile left
behind. An install spent a whole `npm exec @deepseek-ai/dsh@<pin>` **per bundle** - npm
re-resolving the harness's entire dependency graph each time, ~1500 log lines before pnpm was
even reached, twenty-four of them in a row - so the installer now selects what is missing and
issues **one** `plugin add` with every folder: `dsh plugin` is a thin pnpm forwarder, so that
is one pnpm run. The entry point IMPLIES `-Force` for a double-click, which is right for a
person and wrong for a button pressed again over a half-finished install, so the panel passes
**`-Resume`**.

**And the silence is named, because that is what killed an install here.** The first phase is
`npm exec`, which resolves the harness and prints *nothing* while it does: measured on this
machine at about 50-60 s cold and a few seconds warm, with pnpm itself taking under a second
(`Done in 416ms`). An installer whose last line was `- adding dsh-vn-master ...` therefore
looked stuck on the last bundle, the window was killed 60 seconds in, and the profile still
listed only the base bundles - a run that "did not work" that had in fact not finished. So:

* the installer prints `selected …` per bundle (not `adding …` - nothing is being added yet),
  then `adding N bundle(s) in ONE pnpm run` and the sentence that the silence is normal;
* the `pack` row carries a spinner, the installer's own last line, **the elapsed time**, and -
  after 20 s with no new output - a line saying so and naming the phase;
* a close request while a copy or an install is in flight is refused once with a sentence.

The plugin's own `plugin add` semantics are the reason all three are needed: it is a pnpm
forwarder that reconciles `dsh.profile.bundles` against what is installed, so adding is
idempotent, so `-Resume` makes a second press cheap, and the only thing that was ever
expensive was how many times it was called.

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

It is the SAME first choice the harness rung searches first (`launch::harness_caches`), so
the cache the app writes into and the cache it reads a harness out of are one directory.

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
| `DeepSeek key` | which of `keystate`'s four layers supplied a key - a layer NAME, never a value - and, when there is none, **`Add key`**: a masked field in this window that writes `DEEPSEEK_API_KEY=<value>` into this home's `.env`. A key found in the managed store says to change it in the harness's own Settings > Models instead, because that store sits ABOVE the `.env` fallback and a field here would be ignored - a button that looks like it changes something and does not is worse than no button |
| `browser` | the chooser over what was actually detected, plus which browser the last launch used |

**The key is asked for, once, in this window.** A fresh portable home has no credentials
document and no key at all, and rather than telling somebody their key is missing the panel
opens the masked field itself: paste, Save, and `DEEPSEEK_API_KEY=<value>` is written into
`<home>/.env` - a layer the harness's **own** credential resolution reads
(`@deepseek-ai/dsh-credentials-local` resolves the managed store first, then the invoking
project's `.env`, then the home's). Nothing is read from the machine on the way, the value is
never parsed back, never drawn, never logged (the log line and the note name the FILE), the
write is atomic and `0600` on Unix, and every other line of an existing `.env` survives. That
is what makes a portable folder self-contained: the key travels with it. A key that is
ALREADY in the managed store is left alone - that store outranks `.env`, so the row points at
the harness's own Settings > Models instead of offering a field that would be ignored.

**`Open tab`** is the one control that carries the launch token: the panel draws the URL
*without* its query, because that URL is a credential, so this button is how a tab is opened
- or re-opened after it was closed. It reads `Opening…` with a spinner on the row below while
the settle walk is in flight, and **the walk's own lines land in the log**, so the transcript
answers "which rung took the page" and "why did nothing open" without anybody having to guess.
**`Details`** (closed by default, badged when a path was refused) holds everything else: the pin, the runtime, the app's root and its origin, the
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
| `crates/vn-shell-core` | the **pure** halves, each driven by `cargo test`: `readyline` (the ready line, its refusals and the token redaction), `windowstate` (the geometry record and its trust rules), `keystate` (the four key layers, presence only), `appdata` (the app's root, the home inside it, the write probe and the npm cache), `userpath` (what a person typed, turned into a path a child may be given), `browser` (the per-OS browser table, the argv rule, and the settle-window verdict that makes a spawned process not a page), `appprefs` (the browser id and the chosen home), `adopt` (what may be copied out of a home this app did not create), plus `options`, `home` (the two ladders), `ports`, `launch`, `log`, `prefs`, `status` and `urlpolicy` |
| `crates/vn-shell-runtime` | the supervisor: one thread owns one child, resolves the plan, spawns, drains both streams, watches the ready line, takes Stop, kills the tree and checks the port. Also `env` (the one composer every child's environment comes from), `console` (the one transcript), `setup` (the installer runner behind the panel's buttons) and `adopt` (the copy runner behind its own) |
| `crates/vn-shell-paths` | the location map as data, with the per-OS roots and a bounded size walk |
| `crates/vn-shell-pane` | the pane: the ONE crate that depends on a web engine (`wry`, optional, behind the `pane` feature) plus the page that draws it - tab strip, bar, rectangle, placeholder. It owns no policy: visibility, the DPI arithmetic and the loopback re-check are `vn_shell_core::pane` and `cargo test` cases |
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
**`-Mode chrome`**: the harness UI, in a browser the app found - or, in a build with the pane,
inside this window.

**`-Mode embed` is a mode only a build WITH the pane has.** Without it the flag is refused **by
name**, with the reason, rather than quietly opening a browser - a flag that silently means
something else is a flag nobody can trust. With `--features pane` it is real: it opens with the
harness page already in front. `scripts/checks/check-pane.mjs` is what proves the two builds
disagree, because "the pane exists" and "the pane is reachable" are different claims and only the
second one is worth anything.

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
