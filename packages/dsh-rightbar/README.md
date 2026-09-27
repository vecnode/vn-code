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

## Four panes, not two

The docking kit this bar is built on allows **four** docked panes
(`MAX_DOCK_PANES`, with its own `canSplit` meaning *fewer than four*) and offers
**five** drop bands per pane (centre, left, right, top, bottom). The fork's
**seven** patches lift the shipped bundle's **two**-pane cap in the five places
it is enforced — the split intent, the edge-drop intent (top and bottom
included), the surface's `canSplit` prop and the split command — and re-open the
top/bottom drop bands, so the ceiling is the kit's own `canSplit`: **four docked
panes**, with the disabled-hint label in both languages naming that ceiling:

- **Split** (the strip button) adds a column to the **right** of the pane it is
  pressed on — the kit's own `planSplitPane`, unchanged — up to four panes in a
  row.
- **Dragging a tab** into a pane's **top or bottom quarter** stacks a pane
  there, which is how a **2×2** is built; the labels for those bands
  ("Add top split" / "Add bottom split") and their glyphs are part of the core
  bundle's locales.
- **Floating panels do not count** against the four: a tab dragged out to float
  faces no pane ceiling of its own, so it remains the way to see more than four
  at once.

## Re-syncing the fork

When the pinned harness line moves:

```sh
pwsh -NoProfile -File scripts/sync-vendored.ps1
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

(On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts\sync-vendored.ps1` works just as well: the script is OS-neutral.)

The script finds the harness `node_modules` (profile first, then the npm caches
- the Windows npm cache, `~/.npm/_npx`, and the POSIX global module
directories), copies each forked bundle, rewrites the module-table id, applies
that fork's patch list, stamps the banner and prints hashes. `-Check` reports
drift without writing (exit 1 when out of sync). If the bar's slot/service
surface changed in the new line, review the diff before installing — a fork does
not silently track upstream.

## Layout

```
cordis.patch.yml   bundle layer: disables the core bar + Files rows, inserts 'rightbar'
lib/index.js       Node half: no-op row so the browser bundle ships
lib/client.js      GENERATED vendored bar (do not edit; re-sync instead)
```
