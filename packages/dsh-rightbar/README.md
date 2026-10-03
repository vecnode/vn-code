# dsh-rightbar (alpha.6)

**The pack's own right bar** — the web GUI's right-hand column: the tab strip with its "+" control, the docking panel (split / float / fullscreen), the header expand button, the Start guide page, the tab-type registry other plugins register into, and the keyed tab body/title seats.

`lib/client.js` is a GENERATED fork of the shipped `@deepseek-ai/dsh-client-ui-sidebar-right` bundle (the line pinned in `.dsh-version.json`), carrying the patch list in `scripts/sync-vendored.ps1`. `cordis.patch.yml` hard-disables the two core rows and inserts this package's, so exactly one bar is mounted and it is this one:

```yaml
- id: ui-sidebar-right
  disabled: true
- id: ui-sidebar-files
  disabled: true
- insert:
    - id: rightbar
      name: 'dsh-rightbar'
```

The shipped `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` row is left alone on purpose: it only consumes the `sidebarRightTabs` service and the `sidebar.right.pane.tab` seat, which this copy provides under the same names.

## What it adds

- **Four docked panes, not two.** The fork's eleven patches lift the shipped two-pane cap in all five places it is enforced, re-open the top/bottom drop bands, and let the kit's own `canSplit` be the ceiling.
- **A renderer that can draw the tree those bands build.** The kit's `DockLayout` renders one pane or two side by side and THROWS on anything else, so a stacked pane reached the shell's slot boundary as a crash. The fork renders the kit's recursive `DockSurface` instead, through its one hand-written component `vendor/dock-tree.js` (spliced in verbatim by the sync script), with `DockLayout` only as the fallback for a kit line without `DockSurface`.
- **The three things the flat renderer's tab host provided**, all on the `data-dockkit-host="dock"` wrapper `DockTree` emits: the bar's LEFT SEAM (`border-right: .5px solid var(--dsw-alias-border-l3)`, the token the app's own column separators use), an OPAQUE `--dsw-alias-bg-base` fill on the box the tab bodies are MOUNTED IN (without it a fullscreen bar shows the conversation through every pixel the active tab does not paint itself), and the fullscreen layer.

The wrapper must also keep `pointer-events: auto` (the bar's own stylesheet turns the PANEL's pointer events off, so without it the whole bar is deaf to the mouse), the kit's `FloatLayer` (a floated tab is otherwise unreachable) and the `active` / `expanded` / `keepMounted` gates.

The fullscreen layer goes on the PANEL, not the wrapper:

```css
.P3OORG_panel[data-sidebar-right-panel=fullscreen]{ --dsh-dockkit-dock-layer:40; z-index:40 }
```

40 is the app's own ladder: above every persistent layer (composer seat 7/9, frame handles and seats 11/15/20, this pack's command dock 21, the sidebar's fixed controls 30) and below every transient one (the kit's tab menu 70, tooltips and menus 100/101, the modal root 1000, toasts and portals 1100). Push mode is untouched.

## How it plugs in

- **`sidebarRightTabs`** (registry): `register({ id, kind, patterns?, priority?, canOpen?, title(address), guide? })`; `id` is also the slot key of the type's body and title.
- **`sidebarRight`** (controller): `openResource(address, opts)`, `openTab(kind, opts)`, `close`, `focus`, `split`, `float`, `dock`, `isExpanded`, `toggleExpanded`.
- **Seats**: `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` (keyed by definition id), `sidebar.right.tab.guide` (chain, with `sidebar.right.tab.guide.entry`), `sidebar.right.tab.menu.item` (list), the `rightbar` / `rightbar.session` panel seats, and the `conversation.session.header.corner` expand button.
- **The "+" control** opens the Start page, which lists each registered type's `guide` entries; picking one calls `openTab(kind, { replaceTab: true })`.

The pack's own tab types resolve these services — `dsh-rightbar-files` (Files), `dsh-editor`, `dsh-gittree`, `dsh-image`, `dsh-audio`, `dsh-video`, `dsh-pdf`, `dsh-diagrams` — as does the shipped document preview.

## Limits

- Four docked panes; floats do not count against the ceiling, so they remain the way to see more at once.
- **`lib/client.js` is generated — never hand-edit it.** Re-sync instead; the sync script verifies the component inside it is byte-for-byte `vendor/dock-tree.js`.
- A re-sync accepts only the PINNED harness line (an older line's sidebar-right is a different bundle entirely); `-CoreModules` is the one deliberate override.
- A fullscreen bar covers the pack's own command dock (21). If the dock should survive one, that number belongs to `dsh-cmdbar`.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

The client check pins the cap lift, the renderer, the seam, the fill and the fullscreen layer as recorded patches, and fails when a harness bump moves the app's z-index ladder under the bar.

## Layout

```
cordis.patch.yml      bundle layer: disables the core bar + Files rows, inserts 'rightbar'
lib/index.js          Node half: no-op row so the browser bundle ships
lib/client.js         GENERATED vendored bar (do not edit; re-sync instead)
vendor/dock-tree.js   the dock renderer the sync script splices into it
```
