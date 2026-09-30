# dsh-rightbar (alpha.2)

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
applied on top — today that list is the dock's pane ceiling and nothing else (see
**Four panes, not two**). The bundle layer then **hard-disables the two core
rows** and inserts the pack's:

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
**nine** patches do two things, and both are needed:

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
check's `right bar cap lift and renderer are recorded patches` and
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
