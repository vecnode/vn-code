# dsh-cmdbar (alpha.14)

**Command bar** is a **bottom dock** for the DeepSeek Harness web GUI: the commands
the agent ran in this conversation, in the app, under the conversation. A header
button — the same 28px round control the right bar's own toggle wears, the last
entry in the header's utilities list — opens a horizontal panel that starts at the
**right edge of the left bar**, runs to the **full width of the page**, and sits
**under** the middle and right columns. Those two columns make room for it and
**only those two**: the left bar keeps its full height, and nothing in it moves.

Inside the panel is one view and nothing else: every `bash` / `pwsh` / `run_code` /
`terminal_send` call this conversation recorded, grouped under the prompt that
asked for it, with the tool, the working folder, the duration, the exit status and
the output. It is a *transcript of the conversation you are already in*, served
from the host's own copy of the log.

## The name, and the click that used to kill the dock (alpha.14)

This package is **`dsh-cmdbar`** — the **command bar** — and it was
**`dsh-terminal`** through alpha.13. The old name described the emulator alpha.12
deleted (next section) and collided with the harness's own
`@deepseek-ai/dsh-terminal` PTY seam, while what is left is exactly what the new
name says. The package folder, the row (`cmdbar`), the one route
(`/api/dsh-cmdbar/activity`), the `data-dsh-cmdbar-*` attributes and the CSS prefix
(`dst-` → `dsc-`) all moved with it. The shared `dockHeight` field in
`dsh-ui-state` deliberately did **not**: that key is the pack's own, and renaming
it would have thrown away the height every reader had already chosen.

alpha.14 also repairs **two** instances of the same defect — a name used but never
declared, which a render-time `ReferenceError` turns into a vanished panel:

- **Expanding a row.** The row asked for `multiLine`
  (`expanded && multiLine ? … : null`), declared **nowhere** in the bundle. The
  first click on a command line threw `ReferenceError: multiLine is not defined`
  out of the row's render.
- **Copying.** The row's two actions called `writeClipboard(text)` *bare* — that
  is the name of a `@deepseek-ai/dsh-client-ui-primitives` export this bundle
  already requires for `Tooltip`, used unqualified. **Copy command** and
  **Copy output** therefore threw `ReferenceError: writeClipboard is not defined`.
  The write now goes through `primitives.writeClipboard`, guarded for an engine
  that lacks it, and **Copied** appears only for a write the host accepted (the
  primitive answers that).

Why that is so visible: the harness wraps every slot occupant in a
`SlotErrorBoundary`, and for a **root-scoped** entry like this package's
`shell.overlay` seat it reports the crash with `abdicate: true` — which
**retires the entry** for the life of the page. So the panel did not merely fail
to expand or to copy: it vanished, and the header button could not bring it back
until the page was reloaded. No static render could have caught either one (a row
starts collapsed, so the first short-circuited before the identifier was read, and
a click is what reaches the second), which is why both are now pinned: the command
body is a pure `commandBody(entry, expanded)` the check **drives** through all
three cases, the copy call is asserted qualified with the free identifier gone
outside prose, and the pack-wide primitive scan grades `writeClipboard` against
the real pinned package.

## The terminals were removed in alpha.12, and that is the point

Through alpha.11 this dock also held **its own terminals**: xterm.js instances,
one real PTY each behind an authenticated WebSocket, several slots per
conversation, a `+` to open another. All of it is gone — the PTY host, the
`/api/dsh-terminal/pty` upgrade, the vendored xterm bundle and its stylesheet, the
`/health` probe, and the **Run in Terminal** action that typed a recorded command
into one of those shells.

The reason is that the harness now ships the same thing in a better place: 0.2's
right Sidebar has **terminal tabs of its own**
(`@deepseek-ai/dsh-client-ui-sidebar-terminal`), which live in the column beside
the conversation, keep their pages mounted across tab switches, and are the
harness's own surface rather than a second emulator this pack maintains. Keeping
both meant maintaining a whole engine to duplicate a feature, so the dock became
what it was actually for.

This package now **reads and never runs**. It spawns no shell, resolves no
binary, vendors no engine, gates no socket, and injects `connection` alone. A
strictly smaller surface, with nothing lost that the harness does not already
have.

## How it plugs in

Nothing shipped is patched, no core row is disabled, and nothing is forked:
this package adds surface. It contributes two things and owns one row.

| Piece | Value |
|---|---|
| row | `cmdbar` (`cordis.patch.yml`, an `insert`) |
| header control | `conversation.session.header.utilities`, `order: 30` |
| dock | `shell.overlay` (the layout package's root-scoped **list**), `order: 50` |
| client `inject` | `slots` (code), `@deepseek-ai/dsh-client-ui-conversation` (package) |
| primitives used | `Tooltip` only — the glyph is drawn here |
| Node `inject` | `connection` only |
| Node routes | **one**: `GET /api/dsh-cmdbar/activity` (read-only) — it answers a filtered **tail** of the conversation's session events, folded in the browser by the same pure fold the check drives |

**Why the header list and not the corner.** `conversation.session.header.corner`
is a **single**-occupant slot that the right bar's toggle already owns, so
registering there would replace it. `...header.utilities` is a **list**: Open In
sits at `-10`, the pack's Themes at `-20`, and this control at `30` — the last
utility, directly left of the corner. Change that one number to move the button.

**Why `shell.overlay` and not a second React root.** The dock has to escape the
frame's `overflow:hidden` to sit at the very bottom of the window, and it has to
live in the app's tree to inherit its React context. Both hold at once: the
overlay layer is rendered *inside* the frame, and the dock is `position:fixed`,
which no ancestor's overflow can clip. The layer's own `z-index:20` also puts the
dock above the columns (10/11) and below a fullscreen right bar (40) for free.

## Geometry

The dock is not a grid child of the app frame (that would mean writing foreign
nodes into a React-managed container), so it positions itself:

- **Left edge** — the frame's columns are an inline
  `gridTemplateColumns: <sidebar>px minmax(0,1fr) <rightbar>px`, so the RESOLVED
  computed style carries the left bar's width in px. No hashed class names, and
  it follows the left bar opening, collapsing (`0`) and being dragged.
- **Room** — taken from the **middle and right columns only**, as their own
  `height: calc(100% - <dock>px)`; on close each gets back the inline height it
  had before this plugin ever ran. Both are found without hashed class names: the
  layout marks the right column itself (`data-rightbar-col`), the middle column is
  its immediately preceding sibling in the frame, and the frame's **first element
  child** — the left bar — is explicitly never one of them.
  - *Not the frame's height.* The frame has a single grid row, so shrinking the
    frame shortens the left column with it. The left bar's height and its
    contents stay exactly where they are.
  - *Not `padding-bottom` either.* The right column's panel is absolutely
    positioned inside it, and an absolute child is placed against its ancestor's
    **padding** box, so padding would leave that panel where it was and the dock
    would cover its bottom. A height shortens the column itself.
- **Live tracking** — a `MutationObserver` on the frame's `style` attribute (a
  drag rewrites it every frame), a `ResizeObserver` on the two columns the dock
  spans, a `transitionend` on the frame, and a `resize` listener. The
  `ResizeObserver` is what follows the **left bar being collapsed or expanded**:
  that is animated, so the grid tracks are rewritten *once* and then transitioned
  — the mutation reports the pre-transition value and never fires again — while
  the columns' **size** changes on every frame of the transition. `transitionend`
  is the final snap.
  - *Installed once, not per height.* Placement and tracking are two effects:
    placing the dock is a two-write effect, and the observers are installed while
    the dock is open and read `dock.height` at call time (module state, so there
    is no stale closure).
- **Intent is separate from geometry.** `data-open` is user intent;
  `data-suspended` is derived (a fullscreen right bar takes the viewport, and the
  dock yields *and* hands the columns their height back for the duration). The
  observer only ever writes the derived one.
- **Resizing** — the grip drags the height (120px … 70% of the viewport), and it is
  remembered in both `localStorage` and the pack's shared section. Two rules keep
  the drag itself honest:
  - the height comes from the **pointer's** Y and the values captured at
    `pointerdown`, never from the dock's rect — the grip moves as the dock moves,
    so a handler that measured it would chase itself. Moves are coalesced to one
    per animation frame, the pointer is captured for the duration, and the drag
    closes on `pointerup` **and** `pointercancel`. `body.dsc-dragging` carries the
    row-resize cursor and no text selection while the pointer is down;
  - the shared section is written **once, 400ms after the drag settles** (plus a
    flush at release), never per pointer move.
- **An accepted shared view moves the dock only when it is news** — never while
  the pointer is down, while a write of ours is on the wire, or for the value
  already in force. `adoptDecision` is exported in `__internals` and pinned
  behaviourally by the tracked check: the arithmetic is four numbers and two
  flags. (Through alpha.11 it also guarded the PTY size messages; those are gone
  and the guard is unchanged, because what it protects is the height.)

## What it does

- **One view: the agent's commands**, grouped under the prompt that asked for
  them. The dock is **bound to the conversation in front of you**: switching
  conversation **re-points it** — the panel keeps the open state, the height and
  the place you put it in, while everything it *draws* (the commands, the counts,
  the poll, the filters, the expanded rows and the follow-the-tail pill) belongs
  to the conversation now on screen (alpha.13). With no conversation at all — the
  new-conversation and Start screens — the body says **No conversation open**
  instead of showing anyone else's log.
- **The bar wears the log's own state** — a pulse while a command runs, the count
  of what **failed** as a red badge, a `⚠` and the warning tone when this
  conversation's log cannot be read here (with the host's own reason in the
  tooltip), **the counts alone**, and the version. (alpha.13 dropped the sentence
  those counts used to open with — *The agent's own commands in this
  conversation: …* — because the control and the panel are both already labelled
  **Agent**, and the prose only pushed the numbers away from the eye.) The header
  control carries the same running/failed dot while the panel is closed, so "the
  agent is doing something" is visible without opening it.
- **Every number is the COMMANDS'** (alpha.11). A tool call that is not an
  executing tool — a `read`, a `grep`, an `edit` — is a row under the *All tools*
  filter and never a number on the bar: before alpha.11 any failed tool
  incremented the failure count, so a conversation whose only tool call was a
  failed `read` wore a red `1` badge and a red header dot while its own tooltip
  said *0 commands, 1 failed, nothing run yet* in one breath. The other family's
  running and failed rows are counted separately, so *All tools* can still be
  described honestly.
- **Survives a reload** in the only sense left to it: the panel's height does.
  The panel's **open** state deliberately does not — see *Known limits*.

## The agent's own commands

Your shell and the agent's commands are **two different worlds**. The agent runs
`bash`/`pwsh` through the harness's own shell tool, in the harness's own process.
This panel reads the conversation, which is the only thing that knows what it ran.

**What it shows.** One row per executing tool call — `bash`, `pwsh` (foreground
*and* persistent), `run_code`, `terminal_send` — grouped under the human prompt
that preceded it, so the log reads *what you asked, then what it ran*. Each row
carries the tool, the command (or the sent text), the working folder when the
call named one, the duration, and a status pill: `running`, `exit N`,
`killed · SIG`, `error`, or `done`. Output is clamped to 12 lines with
**Show all N lines**; long output is never hidden outright. A row expands on
click (or on `Enter`/`Space` — the head is a `role="button"`), and carries two
actions: **Copy command** and **Copy output**.

**A row is readable at a glance, in any theme.** The row's status is drawn as a
**rail down each side** — left *and* right, so a long command line cannot leave
the mark behind, and the **exit-0 green counts**. The row's **head** — the
clickable line that drops the output down, i.e. the line a reader actually scans
— wears a **light wash of that same colour**, so the command lines separate from
their own output without the output losing contrast. One custom property
(`--dsc-accent`) holds the tone per status, so the rails, the wash and the pill
can never disagree: **green for exit 0**, amber while running, red on a failure,
a signal or an error. The wash is mixed with `transparent` rather than with a
surface colour, which lightens a light theme, darkens a dark theme, and leaves
the label's own themed colour alone.

**Filters.** `Commands` (the default) / `All tools` switches every other tool call
into the log as a one-line row with its own status and a summary taken from its
arguments (`file_path`, `pattern`, `query`, …); `Failures` narrows to what went
wrong. The filter is applied at RENDER time: changing it never re-reads the
conversation.

**Following is a scroll position, not a mode.** The view follows the tail while
you are at the bottom, stops the moment you scroll up (a **Follow ↓** pill appears
in its bar to come back), and shows the newest command otherwise.

**Where the data comes from** — the conversation's own durable session events,
served by this package's read-only Node route `GET /api/dsh-cmdbar/activity`
and folded **in the browser** by the same pure fold the tracked check drives:

| Event | What it contributes |
|---|---|
| `tool/call` | `{ turn, step, callId, name, arguments }` — `arguments` is the RAW JSON string, so the command appears the moment the call is dispatched |
| `tool/result` | `{ turn, step, message, error?, meta? }` — `message.content[0]` is the `ToolResultBlock`: its `content` is the output, its `isError` the failure flag |
| `user/message` | a prompt when `source.kind === 'user'` (every other kind is injected context, and does not open a group) |

The route is read-only, filtered and bounded: only those three event types are
sent (an assistant message with its embedded stream is neither sent nor needed),
injected context and non-human `user/message` events are dropped on the host, and
the answer is the **tail** — at most 400 events and roughly 512 KiB, newest first
— with `hasMore` stating that older ones were left out rather than truncating
silently. The newest event is always included even if it alone is oversized: a
single enormous command must not leave the panel with nothing to draw. A
conversation that is not live on this host answers `NOT_LIVE` with a **200**,
because that is a fact about the host and not a bad request.

The host is the log's owner, so the route answers from there and the panel fills
in on the first poll whatever the browser has or has not staged. The panel
re-reads that route every 6 seconds, and every 2 while a command is running. The
poll stops when nothing is subscribed (the header control of the conversation on
screen is the usual subscriber), pauses in a hidden tab and resumes on the next
visit, and publishes **nothing** when the fold's signature is unchanged — a
steady conversation costs an idle request and no re-render.

**Following the conversation you are looking at** is the whole contract of that
poll, so alpha.11 closes the two windows where it could lag. A log that has **not
answered yet** is retried briskly — 1.5 s, four attempts, then back to the steady
cadence, with the budget reset by an answer *and* by the conversation coming back
on screen — because the conversation on screen is attached by the host as the app
opens it, so the very first read can race that attach and answer `NOT_LIVE`: at
6 s, a restored conversation said so for up to six seconds after every reload. And
the panel belongs to the conversation on screen and to no other: a **closed** panel
**forgets the conversation it left**, because the dock is root-scoped and always
mounted, so keeping the old identity meant a hidden panel went on reading (and
holding numbers from) a conversation nobody was looking at.

**alpha.13 makes that contract hold for the panel the reader is actually looking
at.** Through alpha.12 a conversation change *closed* the panel, and an empty id
was ignored outright — so the two cases that matter most both left the previous
conversation on screen: a **new conversation**, which has no session id yet, and a
screen whose header has **gone away entirely** (nothing reports a conversation
that has no header). An open panel now **re-points** instead of closing: it keeps
its open state, its height and its place, and everything it draws — the commands,
the counts, the poll, and the view's own filters, expanded rows and follow pill —
belongs to the conversation now in front of the reader. With no conversation at
all the body says **No conversation open**, and the bar's facts line goes quiet
rather than claiming *0 commands*. The rule is one pure function,
`followDecision({ open, current, next })`, exported in `__internals` and pinned
behaviourally by the tracked check; the header control's **unmount** releases the
conversation it owned (the path nothing else reports), and the view is **keyed on
the conversation** so its own state cannot carry over either. The panel is closed
by the reader's own control and by nothing else.

The exit status is recovered from the `\n[exit code: N]` / `\n[killed by
signal: X]` markers that `@deepseek-ai/dsh-shell/render` appends — the same
mirror-not-import the shipped terminal card does. It is read **only for a
foreground shell tool**: a persistent shell can report resets and partial output
without any single process exit status, so it claims none and settles as `done`.
A result whose `tool/call` is outside the tail still becomes a row (its
output is worth seeing) but names no tool and claims no exit status. Output
passes through the same kind of filter the host's own `TerminalSanitizer` is:
OSC, two-character escapes and CSI are removed before anything is drawn.

**Why the event log and not the Chat assembly.** `uiConversation`'s assembled
snapshot would hand over paired nodes for free, but it is a *view* registry —
a node can be hidden by a presentation choice that has nothing to do with what
happened, and reaching it means depending on another package's render layer.
The event log is the durable truth underneath it, and folding it in the browser
means this panel and the transcript can only disagree about *presentation* —
and the fold lives in one place, so the panel and the tracked check cannot
disagree about what a command is.

**What it deliberately does not do.** It does not stream. The harness has exactly
two tool events and no live output channel, so a command shows as `running` from
the moment it is dispatched and its output lands in one shot at settle — a real
"live stdout" feed would need a host-side tap on the shell executor (and a new
socket), which is a much larger change than a view. Long-running commands are
usually backgrounded anyway, and then the agent's own `job_output` calls appear
here as rows, which is where their output is read.

**And it does not run anything.** There is no shell behind this panel to type
into: alpha.12 deleted the one it had, so a command is something you read (and
copy) here and run yourself in the harness's own terminal tabs.

## Files

```
package.json          one dsh bundle: the row, plus the client half
cordis.patch.yml      bundle layer: inserts the 'cmdbar' row (nothing else)
lib/index.js          Node half: the ONE read-only activity route
lib/client.js         browser half (module-table bundle, no build step): the dock
                      and the agent-activity view + its feed
```

There is no `lib/pty.js`, no `lib/shell.js`, no `lib/vendor/` and no `vendor/`
build folder any more — alpha.12 deleted them along with the terminals.

## Checks

```sh
node scripts/checks/check-client-bundles.mjs   # bundle id, both seats, order 30, markup, geometry invariants, the activity arithmetic
node scripts/checks/check-node-routes.mjs     # the activity route: filtering, ordering, the caps, NOT_LIVE and UNREADABLE
```

The client check cannot run effects, so the geometry promises are pinned at the
source level: this bundle must never write the frame's height, it must inset the
two columns it spans, and it must track the left bar through *both* the mutation
observer and the column `ResizeObserver` (plus the `transitionend` snap).

The agent view is pinned on both sides. The **Node** check drives the route
itself: that only the three event types the panel draws are sent, injected
context and assistant streams are dropped, the answer is in log order, a
conversation that is not open answers `NOT_LIVE` (with a 200, because that is a
fact about the host and not a bad request), an unreadable log answers
`UNREADABLE`, a missing session id is a 400, a conversation past the budget
answers with its **tail** (newest kept, `hasMore` set) and one oversized newest
command is still sent. It also pins that the terminal half is really gone: the row
registers **exactly one** route and **no** upgrade, and there is no `/health` or
`/vendor` path left to answer. The **client** check pins that the bundle reads the
activity route, that the poll stops when nothing is subscribed and pauses in a
hidden tab, that the bar carries the counts and the warning while there is **no
toggle and no chip strip** to carry them, and that the stylesheet carries the
view's rules — a rail on **both** sides, the tone in one custom property per
`data-status`, and the head's light wash. Then the bundle's pure half is
**driven** with hand-built events — `parseExecCall` (including that a missing
`description` marks the persistent shell and that `read` is not a command),
`parseExitMarker` (the marker consumed, a signal not an exit code, marker-like
text mid-output left alone), `stripAnsi` (CSI, OSC, a bare CR),
`formatDuration`, `filterActivity` (commands-only is the default, `All tools`
adds the rest, empty groups drop) and `buildActivityFromEvents` (grouping by
prompt, injected context NOT opening a group, a failure read off its marker, a
call with no result still running, a persistent shell claiming no exit status, a
result outside the tail kept but unnamed) — plus `activitySignature`, which is
what keeps a poll that returns the same log from re-folding it. alpha.11 pins the
counts as well, on both sides of the same claim: a log whose only tool call was a
failed `read` folds to *zero failed* (the row is still a failure, and its own
`otherFailed` counter still sees it) and the tooltip `activityFactsTitle` is
asserted as the exact text a reader gets. alpha.11 also pins the bounded retry
(1.5 s, four attempts, reset by an answer). alpha.13 pins the two things a
conversation change now means: `followDecision` is driven through all of its
cases (an open panel re-pointing, an absent id being a change rather than a
no-op, a closed panel only forgetting, and the same conversation moving
nothing), the facts line is asserted as the counts **alone**, and the source
pins that the panel is closed by the reader's own control and by nothing else.
alpha.14 pins the RENAME on both sides of the name — the bundle id and both seat
ids (`dsh-cmdbar`), the one route (`/api/dsh-cmdbar/activity`), the storage key,
the CSS tag, every `data-dsh-cmdbar-*` attribute, the version the bar prints, that
the old `dst-` prefix is gone from the bundle and the new `dsc-` one is in the
stylesheet — and, next to it, that the two harness packages this bundle only
MENTIONS (`dsh-terminal-bash` and `@deepseek-ai/dsh-client-ui-sidebar-terminal`)
and the one harness tool it names (`terminal_send`) were deliberately left alone.
And it pins the CLICK bugs: `commandBody` is driven through all three cases and the
row is asserted to draw its body from it, with the free `multiLine` identifier
asserted gone from the source outside prose — the one thing no static render could
see, because a row starts collapsed; and the row's copy path is asserted to call
`primitives.writeClipboard` **qualified** (guarded, and showing **Copied** only for
an accepted write) with no bare `writeClipboard` left outside prose, while the
pack-wide primitive scan grades that name against the real pinned package.

## Known limits

- The dock is positioned from the frame's resolved grid tracks, and the two
  columns it insets are found from the layout's own `data-rightbar-col` marker
  plus sibling order: a harness line that stops using `grid-template-columns` for
  the columns, or that puts something else between the middle and right columns,
  needs `columnsFor` updated (there is no layout service API for a bottom region).
- A fullscreen right bar suspends the dock while it is up.
- The panel reads the conversation only while it is **live on this host** (a
  stored conversation that no process has open answers `NOT_LIVE`), it is
  refreshed by polling rather than pushed — 6 s, or 2 s while a command is
  running, or 1.5 s for the first four reads while it has no answer yet — and it
  shows the **tail** of the log: at most 400 relevant events and roughly 512 KiB,
  newest kept. A conversation past that says so (`older ones are outside this
  view`) rather than offering to page them. It names commands by tool: a call
  whose `tool/call` event is outside the tail is shown as an unnamed result with
  its raw output, and sub-agent commands belong to the sub-agent's own session
  (the root `subagent` call is what appears here).
- The dock's **open** state is deliberately not remembered: the panel is a window
  onto a conversation, and after a reload the client holds none, so reopening it
  would show a panel nobody asked for. Its **height** is remembered (both
  stores). The activity *view* preference that used to be remembered per origin
  is gone with the toggle: with one view there is nothing to remember.
- **A render error in this panel costs the whole panel, not one row** (the shape
  alpha.14 was repaired in, **twice**). A slot occupant is wrapped in the shell's
  `SlotErrorBoundary`, and for a root-scoped entry such as this dock's
  `shell.overlay` seat the crash is reported with `abdicate: true`: the entry is
  retired and every later render skips it, while the boundary draws its own
  `data-slot-error="shell.overlay"` box in the panel's place. That is why
  alpha.13's two free identifiers — the expand click's `multiLine` and the copy
  buttons' unqualified `writeClipboard` — read as "the bar closes and disappears"
  rather than as one row failing to expand or one button doing nothing. It is also
  why `commandBody` is a pure function the tracked check drives, and why the copy
  call is pinned as a qualified primitive call.
