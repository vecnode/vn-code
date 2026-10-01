# dsh-rightbar (alpha.6)

**The pack's own right bar** — the right-hand column of the DeepSeek Harness
web GUI: the tab strip with its "+" add control, the docking panel with split /
float / fullscreen, the header expand button, the **Start** (guide) page, the
tab-type registry other plugins register into, and the keyed tab body/title
seats. Alpha.

## What "the pack owns it" means

The right bar is a **fork**: `lib/client.js` is a copy of the shipped
`@deepseek-ai/dsh-client-ui-sidebar-right` bundle (same harness line as
`.dsh-version.json`'s `dsh` pin), with a generated banner, the module-table id
rewritten to `dsh-rightbar`, and the patch list in `scripts/sync-vendored.ps1`
applied on top — today that list is the dock's pane ceiling, the renderer that can
draw it, and the three things that renderer's markup no longer carries (see **Four
panes, not two** and **The bar's seam, its surface and its layer**). The bundle
layer then **hard-disables the two core rows** and inserts the pack's:

```yaml
- id: ui-sidebar-right
  disabled: true
- id: ui-sidebar-files
  disabled: true
- insert:
    - id: rightbar
      name: 'dsh-rightbar'
```

So exactly one bar is mounted, and it is this package — the code can be changed
here without touching any DeepSeek core file. The shipped
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` row is deliberately left
alone: it only consumes the `sidebarRightTabs` service and the
`sidebar.right.pane.tab` seat, which this copy provides under the same names.

## The contract other plugins use

Unchanged from the shipped bar — the fork's patches move one limit, never the
contract:

- **Registry** (cordis service `sidebarRightTabs`):
  `register({ id, kind, patterns?, priority?, canOpen?, title(address), guide? })`
  — `id` is also the slot key of the plugin's body/title.
- **Controller** (cordis service `sidebarRight`): `openResource(address, opts)`,
  `openTab(kind, opts)`, `close`, `focus`, `split`, `float`, `dock`,
  `isExpanded`, `toggleExpanded`.
- **Seats**: `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`
  (keyed by the definition id), `sidebar.right.tab.guide` (chain),
  `sidebar.right.tab.menu.item` (list), plus the `rightbar` /
  `rightbar.session` panel seats and the `conversation.session.header.corner`
  expand button.
- **The "+" control** opens the Start page, which lists each registered type's
  `guide` entries; picking one calls `openTab(kind, { replaceTab: true })`.

The pack's own tab types resolve these services: `dsh-rightbar-files` (Files),
`dsh-editor` (editor), `dsh-gittree` (History), `dsh-image`, `dsh-audio`,
`dsh-video`, `dsh-pdf` and `dsh-diagrams`, as does the shipped document preview
for its Markdown / code / image / PDF renderers.

## Four panes, not two — and a renderer that can draw them (alpha.3)

The docking kit this bar is built on allows **four** docked panes
(`MAX_DOCK_PANES`, with its own `canSplit` meaning *fewer than four*) and offers
**five** drop bands per pane (centre, left, right, top, bottom). The fork's
**eleven** patches do four things, and all four are needed:

- **Lift the shipped two-pane cap** in the five places it is enforced — the split
  intent, the edge-drop intent (top and bottom included), the surface's `canSplit`
  prop and the split command — and **re-open the top/bottom drop bands**, so the
  ceiling is the kit's own `canSplit`: **four docked panes**, with the
  disabled-hint label in both languages naming that ceiling.
- **Render the tree those bands build.** The kit draws a docked layout with
  `DockLayout`, which renders ONE pane or TWO side by side and **throws** on
  anything else (*DockLayout requires one pane or two horizontally split panes*).
  A stacked pane therefore reached the shell's slot boundary as a crash, and an
  abdicated slot entry took the whole bar away until a page reload — so the
  top/bottom bands were unusable, and so was a third pane. The same kit exports
  `DockSurface`: the SAME drop-zone host with the **recursive** renderer
  (`splitRow` / `splitColumn`, a divider per child, one strip per pane), which
  draws exactly what the kit's own `planDropTab` / `planSplitPane` build. The fork
  renders that instead, through its one hand-written component
  (`vendor/dock-tree.js`, spliced in by the sync script).
- **Draw the bar's own LEFT SEAM, give it an OPAQUE surface, and put the
  fullscreen panel on the kit's own LAYER** — three things the flat renderer
  provided and the renderer swap above had taken away with the two-pane cap. See
  **The bar's seam, its surface and its layer** below.

What that wrapper keeps — because the flat renderer provided each for free, and
each was **measured in a real browser** rather than read off the code:

| Kept | Why it matters |
|---|---|
| `data-dockkit-host="dock"` on a real box | the bar's own stylesheet **hides and slides** the docked content through that selector: a collapsed bar measured `visibility:hidden` + `translateX(<bar width>)` |
| `pointer-events: auto` on the same box | that stylesheet turns the **panel's** pointer events *off*, and the flat renderer's per-tab hosts were what turned them back on: without this the whole bar is deaf to the mouse and every click passes straight through |
| the kit's `FloatLayer` | the flat renderer drew a floated tab as a grid cell while the surface renderer does not draw floats at all — without the layer a floated tab would be unreachable |
| the `active` / `expanded` gates | an off-screen session's panel, or a collapsed bar, must not mount its tabs |
| `keepMounted` | a retained tab (the shipped Browser tab type) stays mounted once it has been in front |

How the **2×2** is built, and what the verified run does:

- **Split** (the strip button) adds a column to the **right** of the pane it is
  pressed on — the kit's own `planSplitPane`, unchanged.
- **Dragging a tab** into a pane's **top or bottom quarter** stacks a pane there:
  right band → two panes side by side, then the top band on the left pane, then
  the bottom band on the right pane → **2 up, 2 down**. A drag that would leave a
  pane EMPTY lets the kit merge that pane away, so each drag takes a tab from a
  pane that holds more than one.
- **Floating panels do not count** against the four: a tab dragged out to float
  faces no pane ceiling of its own, so it remains the way to see more than four
  at once.

Measured in headless Edge against the real app (the pinned harness line, the real
profile, the pack's own bundles) with real pointer input: four tabs → three drags
→ **four panes of 304×428 in a 2×2** (two rows, two even columns, three dividers,
one strip per pane), **no slot error at any point**, the collapse round trip
hiding and restoring all four, and a tab dragged out floating and docking back.

## The bar's seam, its surface and its layer (alpha.4 – alpha.6)

Two things the flat renderer's tab host gave the docked surface, and the renderer
swap had taken both away with the two-pane cap. Both of the kit's rules hang off
markup that **only the flat renderer emits**:

```css
._tabHost_<hash>:not(._float_<hash>)   { background: var(--dsw-alias-bg-base) }
._tabCell_<hash>[data-dockkit-host=dock][data-dockkit-column="0"]>._tabHost_<hash>
  { border-left: .5px solid var(--dsw-alias-border-l4) }
```

`DockSurface` draws a bare `_pane_` section with **no background** and **neither**
attribute, so a surface-rendered bar is transparent and has no left boundary.

### The seam (alpha.4)

The bar and the centre column are both painted `--dsw-alias-bg-base`, so the only
thing that separates them is one hairline at the bar's left edge. With the
selector matching nothing, no seam was drawn anywhere and the two columns ran
together with nothing between them.

`DockTree`'s wrapper already re-emits `data-dockkit-host="dock"` on a real box —
the bar's own stylesheet slides and hides the docked content through that very
selector — so the seam goes there, and on the token the app's **own** column
separators use: `border-right: .5px solid var(--dsw-alias-border-l3)` on the left
sidebar column, and the same declaration on the centre column under
`[data-platform=darwin]`. The kit's cell rule asks for `-l4`, one step stronger;
this package pins `-l3` so the two sides of the frame wear the same hairline,
which is what a person compares.

### The opaque surface (alpha.5)

The missing **fill** is invisible in push mode — the bar's column and the centre
column are the same colour — and it only shows in **fullscreen**, because that is
the one state where the panel overlays something it is *not* the same colour as:
the conversation. Every pixel the active tab does not paint itself then shows the
chat through it, so **which tab is in front decides how bad it looks** — the
editor and the PDF viewer paint their own background, while the History tab (its
rail, its commit list, its diff detail) paints none, which is why it read as a tab
that "sometimes does not cover". It was never stale: nothing needed refreshing,
the bar simply had no surface of its own.

So the same wrapper carries the fill the flat renderer's tab host had. Putting it
on the **box the tab bodies are mounted in** is what makes it a fix rather than a
per-tab patch: a future tab that paints nothing can no longer punch a hole in the
bar. `--dsw-alias-bg-base` is the exact token upstream's rule used.

### Why both are safe

Three properties keep the pair honest:

- They live on `panelBody`'s **first child**, and the flat fallback renders no such
  box — so neither can double the kit's own declarations.
- That box is what the stylesheet gates on `[data-sidebar-right-open]`: a
  **collapsed** bar carries the fill and the seam off-screen with its content
  (`visibility:hidden` + `translateX(<bar width>)`) instead of painting a
  one-bar-wide rectangle over the conversation.
- They are **recorded patches** (`scripts/sync-vendored.ps1`), not hand edits, and
  the client check pins both halves: the declarations in the fork, and the patch
  label a re-sync rebuilds them from.

### The layer (alpha.6)

An opaque fill is not enough, because the panel had **no stacking position at
all**: `.P3OORG_panel` is `position:absolute` and leaves `z-index` at `auto`, so it
paints above the chat's *in-flow* content and **under every positioned element the
app gives a positive z-index**. The pinned line's persistent layers, read out of
its own bundles:

| layer | what |
|---|---|
| 5–6 | the trajectory rail, a code block's sticky banner |
| 7 / 9 | the **composer seat** — `position:sticky; bottom:0`, and its background is a gradient that fades to transparent over its top 36px, which is how chat text came through the input box |
| 8, 10 | the composer's width handle, the workspace row |
| 11, 15, 20 | the frame's column resize handles, its leading seat (the header's left controls), its overlay layer |
| 21 | **this pack's own command dock** (`dsh-cmdbar`), `position:fixed; bottom:0` |
| 30 | the sidebar's fixed controls under `[data-windows-titlebar]` |

…and every *transient* layer sits far above them: the kit's own tab menu 70,
tooltips and hovercards and the panel menus 100, submenus 101, the modal root and
its backdrops 1000, toasts and portals 1100.

The kit had already answered this for the **flat** renderer: the fullscreen panel
sets `--dsh-dockkit-dock-layer:40` (against `10` when pushed), and that is the
`z-index` of its tab **cells** — ordered in the root stacking context because the
panel does not create one. `DockSurface` draws no tab cell, so the surface path
lost that layer too, and a fullscreen bar sat under the composer, the header seats
and the sidebar. The layer now goes on the **panel**:

```css
.P3OORG_panel[data-sidebar-right-panel=fullscreen]{ --dsh-dockkit-dock-layer:40; z-index:40 }
```

- `40` is taken from the ladder above, not invented: **above everything persistent
  (a maximum of 30) and below every transient layer (a minimum of 70)**, so
  dropdowns, menus, dialogs and toasts still win — which "the bar is on top" must
  not break.
- Putting it on the panel rather than on the wrapper also keeps the **float layer**
  working: floats are children of the panel, so they stay inside its stacking
  context and keep the kit's own float-above-dock relation instead of being
  stranded underneath the bar's fill.
- It is a consequence worth stating: the pack's own **command dock (21) is covered
  by a fullscreen bar** too. That is what "on top of everything" means; if the dock
  should survive a fullscreen bar, it is `dsh-cmdbar`'s number to raise above 40.
- **Push mode is deliberately untouched.** Upstream's pushed dock layer is `10`,
  below the shell's own 11/15/20 chrome, and the two columns do not overlap there.
- The tracked check reads the pinned `dsh-client-ui-layout` and
  `dsh-client-ui-sidebar` bundles back and asserts the bar's layer is above the
  highest `z-index` they declare, so a harness bump that moves the ladder fails the
  check instead of shipping a bar under the input box.

## Re-syncing the fork

When the pinned harness line moves:

```sh
pwsh -NoProfile -File scripts/sync-vendored.ps1
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

(On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts\sync-vendored.ps1` works just as well: the script is OS-neutral.)

The script finds the harness `node_modules` — and it only accepts a root carrying
the **pinned line** (`.dsh-version.json`'s `vendoredFrom`, then `dsh`). That guard
is load-bearing on an ordinary machine: this one keeps `0.1.5-rc.1` in
`$DSH_HOME/profiles/node_modules` beside the pinned `0.2.0-rc.2` in the npm cache,
and the older line's sidebar-right is a different bundle altogether (140 KB against
331 KB, no `DockLayout` render at all), so a plain "first root that has the file"
walk would have regenerated every fork from the wrong generation. `-CoreModules`
is the one way to sync another line on purpose; a mismatch without it is an error
naming what was found.

The script then copies each forked bundle, rewrites the module-table id, applies
that fork's patch list (and splices in the right bar's one hand-written component,
`vendor/dock-tree.js`, verbatim), stamps the banner and prints hashes. `-Check`
reports drift without writing (exit 1 when out of sync) — and it is what the client
check's `right bar cap lift, renderer, seam and fill are recorded patches`,
`right bar fullscreen layer and wrapper fill are recorded patches` and
`the renderer in the fork is byte-for-byte the vendor fragment` pins turn red on.
If the bar's slot/service surface changed in the new line, review the diff before
installing — a fork does not silently track upstream.

## Layout

```
cordis.patch.yml      bundle layer: disables the core bar + Files rows, inserts 'rightbar'
lib/index.js          Node half: no-op row so the browser bundle ships
lib/client.js         GENERATED vendored bar (do not edit; re-sync instead)
vendor/dock-tree.js   the dock renderer the sync script splices into it (its own
                      header explains why the kit's DockLayout is not enough)
```
