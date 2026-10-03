# dsh-cmdbar (alpha.17)

**A bottom dock for the vncode Web GUI: the commands this conversation's agent ran, in the app, under the conversation.**

A header button — the last entry in the Session header's `conversation.session.header.utilities` list,
`order: 30`, left of the right bar's toggle — opens a horizontal panel from the right edge of the left bar to
the page width, **under** the middle and right columns, which make room for it
(`height: calc(100% - <dock>px)`, restored on close); the left bar keeps its full height and layout. It
reads; it runs nothing.

## What it adds

- **One view**: every `bash` / `pwsh` (foreground and persistent) / `run_code` / `terminal_send` call the
  conversation recorded, grouped under the human prompt that asked for it, with the tool, the command, the
  working folder, the duration, a status pill (`running`, `exit N`, `killed · SIG`, `error`, `done`) and the
  output, clamped to 12 lines with **Show all N lines**. A rail down **both** sides of a row plus a light wash
  on the head carries one `--dsc-accent` per status — green for exit 0, amber while running, red on a failure,
  a signal or an error. A row expands on click, `Enter` or `Space` (the head is a `role="button"`) and carries
  **Copy command** / **Copy output** through `primitives.writeClipboard`, guarded, with **Copied** only for an
  accepted write. Pointing at a clipped head shows the **whole command** in the browser's own tooltip (the line's
  `title`), never the agent's description.
- **One 25px header row**: the glyph and **Agent**, the running pulse, the `⚠` for an unreadable log and the
  failed badge; the counts as one faint line (the one shrinkable item, with an ellipsis); then the **All
  tools** / **Failures** chips (`primitives.Pill`), a **Follow ↓** chip while scrolled off the tail, and the
  close button. Height is one knob, `--dsc-control-h: 20px` on `.dsc-dock`; the build string lives in the
  brand's tooltip and in `data-dsh-cmdbar-version`.
- **Filters and following**: the chips filter at render time — **All tools** adds every other tool call as a
  one-line row from its arguments, **Failures** narrows to what went wrong — and following is a scroll
  position that tracks the tail until you scroll up, offering **Follow ↓** to come back. Both chips and the
  expanded rows reset on a conversation change.
- **The grip** drags the height between **120px** and **70% of the viewport**, remembered in `localStorage`
  (`dsh-cmdbar.dockHeight`) and the shared section, written once 400 ms after the drag settles. The **open**
  state is deliberately not remembered.

## How it plugs in

| Piece | Value |
|---|---|
| row | `cmdbar` (`cordis.patch.yml`, an `insert`) |
| header control | `conversation.session.header.utilities`, `order: 30` |
| dock | `shell.overlay` (root-scoped **list**), `order: 50` |
| Node | injects `connection` only; one read-only route, `GET /api/dsh-cmdbar/activity` |

- The header slot is a **list**, so nothing is displaced; `corner` is single-occupant, owned by the right bar's
  toggle. `shell.overlay` is inside the frame and the dock is `position:fixed`, so it escapes
  `overflow:hidden` while keeping the app's React context.
- Geometry uses no hashed class names: the left edge is the frame's resolved `grid-template-columns`, the two
  columns it insets come from the layout's `data-rightbar-col` marker plus sibling order, and a
  `MutationObserver` on the frame's style, a `ResizeObserver` on those columns, `transitionend` and `resize`
  keep it in step; it never writes the frame's height.
- `data-open` is user intent, `data-suspended` derived: a fullscreen right bar takes the viewport and the dock
  yields, handing the columns their height back.

## Limits

- Only three event types are sent — `tool/call`, `tool/result` and a human `user/message`; injected context and
  assistant streams are dropped on the host. The answer is the **tail**: at most **400** events and roughly
  **512 KiB**, newest kept, with `hasMore`; the newest event is always included even if oversized.
- A conversation not live on this host answers `NOT_LIVE` with a **200** (a fact about the host, not a bad
  request); an unreadable log answers `UNREADABLE`; a missing session id is a **400**.
- Polling only: **6 s**, **2 s** while a command runs, **1.5 s** for the first four reads while it has no
  answer yet. It stops when nothing is subscribed, pauses in a hidden tab, and republishes nothing when the
  fold is unchanged.
- Exit status comes from the `\n[exit code: N]` / `\n[killed by signal: X]` markers
  `@deepseek-ai/dsh-shell/render` appends, read only for a **foreground** shell tool; a persistent shell claims
  none and settles as `done`. Output passes the same filter as the host's `TerminalSanitizer` (OSC, escapes and
  CSI removed).
- The panel belongs to the conversation on screen: it **re-points** on a change, keeping its open state, height
  and place, and says **No conversation open** with none. A result whose `tool/call` is outside the tail is
  still a row but names no tool and claims no exit status; sub-agent commands are the sub-agent's session.
- A render error here costs the whole panel, not a row: `shell.overlay` is root-scoped, so the boundary
  retires the entry until a reload.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs   # bundle id, both seats, order 30, markup, fold
node scripts/checks/check-node-routes.mjs      # the activity route: filtering, caps, NOT_LIVE, UNREADABLE
```
