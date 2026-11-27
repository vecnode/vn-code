# Compatibility

The pack targets the harness line DeepSeek ships to the raw web install
(`npx @deepseek-ai/dsh web`), and one install target only: the **web profile**. There is no
desktop edition and no second edition to keep compatible - `scripts/run-web.*` runs that
same pinned `dsh web`, so the browser, the harness and the pack are the whole product. That
is also why there is no per-OS web-engine requirement to track: the page opens in the
person's own browser, which the launcher finds (Chrome first, the OS opener as the floor).

## Current pin

| | |
|---|---|
| `@deepseek-ai/dsh` | `0.2.2-rc.5` (`.dsh-version.json`'s `dsh`) |
| Forked from | the same `0.2.2-rc.5` line (`.dsh-version.json`'s `vendoredFrom`) |
| Install target | the web profile only (`$DSH_HOME/profiles/web`; `$DSH_HOME` defaults to `~/.dsh`) |
| Host platforms | Windows (PowerShell 5.1 or 7) and macOS / Linux (POSIX shell plus Node.js 24.9+ with npm/npx - never PowerShell) |
| Distribution | one artefact, `vncode-<version>.zip` - the repository at the tag. Nothing is compiled, so nothing is per-OS |
| Plugin code | plain JavaScript and OS-neutral; the only per-OS code is a launcher choosing the host command |

## What the pack ships, per bundle

| Bundle | Row | What it is |
|---|---|---|
| `dsh-vn-master` | `master` | the pack's final layer (installs last). Carries pack-wide row decisions; today it disables the `browser` row (the Browser tab is built and shipped but off, which also removes its routes and tools) and the four feedback rows `ui-message-feedback`, `message-feedback`, `command-feedback`, `session-telemetry-otel` |
| `dsh-rightbar` | `rightbar` | the right bar, a fork of the shipped bundle; disables `ui-sidebar-right` and `ui-sidebar-files` |
| `dsh-rightbar-files` | `rightbar-files` | the Files tab on that bar (fork) |
| `dsh-editor` | `editor` | CodeMirror tab type for text and code, Markdown included, blank documents from "+", Preview/Edit hand-off to the rendered view |
| `dsh-gittree` | `gittree` | **History**: read-only commit list with a branch-lane graph; needs `git` on `PATH` |
| `dsh-image` | `image` | image viewer (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG, TIFF) |
| `dsh-docker` | `docker` | Docker or Podman as tools and a tab; needs `docker`/`podman` on `PATH`, and `docker_start` needs Docker Desktop where it is installed |
| `dsh-audio` | `audio` | waveform viewer (WAV, AIFF, FLAC) plus the Media row in the left panel list (workspace media, previewed) |
| `dsh-media` | `media` | the host-only media engine and the only owner of ffmpeg (`media_probe`, `media_run`, `media_frames`) |
| `dsh-video` | `video` | video player tab, streamed from dsh-media's Range route |
| `dsh-browser` | `browser` | the pack's own Browser tab, rendering pages on the host; disables `ui-sidebar-browser` (currently disabled again by the master) |
| `dsh-diagrams` | `diagrams` | Mermaid and TikZ tools plus the vendored Diagram Design kit (`diagram_kit`), one tab per diagram, an index page with the kit browser, and a shared library |
| `dsh-pdf` | `pdf` | the five `pdf_*` tools plus the PDF reader and workspace index |
| `dsh-cmdbar` | `cmdbar` | the command bar: a read-only transcript of the agent's own commands |
| `dsh-themes` | `themes` | header controls (page zoom, Screenshot, Themes, session-log download) and the pack's appearance overrides |
| `dsh-skills` | `skills` | the Skills browser: list, read and edit the skills this conversation loads |
| `dsh-modal` | `modal` | the shared `modals` dialog surface |
| `dsh-ui-state` | `ui-state` | durable UI state on the host: page zoom, theme, dock height and the two column widths |
| `dsh-open-in-app` | `native-open-in-app` | the OS file browser; disables `ui-open-in-app` |

The shipped document preview row stays enabled: it consumes `sidebarRightTabs`
and the keyed seat, so its previews keep working inside the pack's bar.

## Upgrading the pack when DSH moves

1. Bump `dsh` **and** `vendoredFrom` in `.dsh-version.json` (the launcher reads the pin at
   run time, so `run-web.bat` itself needs no change).
2. Re-run `scripts/tools/sync-vendored.ps1` and review the diff: a patched fork fails
   loudly when the core code it patches has moved. Two measured facts about that diff:
   - The bundle names itself in two spellings - `id: "<core>"` up to 0.2.0-rc.2 and a
     template literal (`id:` + backtick) from the 0.2.1 line on; the script accepts both
     and keeps the source's spelling.
   - The client bundles are re-minified per line, so JS anchors move even when the logic
     does not. Measured on 0.2.0-rc.2 -> 0.2.2-rc.5: 12 of the right bar's 14 patches and
     both `dsh-open-in-app` patches needed re-anchoring; the two patches that match CSS
     text survived unchanged. Budget for re-anchoring, not for a version bump.
3. Re-run the installer with `-Force` to re-add the bundles under the new pin (on a
   machine whose profile is already installed this is a no-op re-registration).
4. If a core API moved (registry shape, seat names, route registration), adapt
   the affected package and bump its alpha version. 0.2.2-rc.5 added a THIRD apply-time
   service to the forked `dsh-open-in-app` (`ctx.contextMenus`, five menus) and declares
   Node.js >= 24.9.
5. Re-run the uninstaller first on machines that should drop the old version.

## Alpha policy

Every package under `packages/` ships with an `-alpha.<n>` suffix. Promotion to
stable happens only when the owner says so (edit the package `version` and
`.dsh-version.json`), then re-run the installer with `-Force`.
