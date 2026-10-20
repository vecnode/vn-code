# Third-party notices

vn-code is distributed under **AGPL-3.0-only** (see [LICENSE](LICENSE)). It also
**vendors** other people's work, because a bundle is installed as a live link and
an engine the plugin needs on both sides of the app has to be on disk. Those
components are **not relicensed** by vn-code: each one keeps its own license, and
that license's own file travels beside its bytes inside the package.

This file exists so a reader can see the whole picture in one place. It is a
notice, not a replacement for the files it names.

## What is vendored, and under what

| Component | Where | License | Terms this project relies on |
|---|---|---|---|
| **Mermaid** 11.17.2 | `packages/dsh-diagrams/lib/vendor/mermaid.min.js` | MIT | attribution kept in the generated file's own header and `VERSION.json` |
| **Diagram Design** @ `7a2e221` (204 examples, 71 example keys, 62 references) | `packages/dsh-diagrams/lib/vendor/design/` | MIT | upstream `LICENSE` and `NOTICE.md` beside the tree; the only change is LF normalization, recorded in `VERSION.json` |
| **pdf.js** 6.3.289 (`pdfjs-dist`) | `packages/dsh-pdf/lib/vendor/` | Apache-2.0 | `LICENSE` beside the bytes; no NOTICE file is required by upstream, and none was omitted: the tree is unmodified |
| **Impeccable** 4.6.0 @ `2f46b7a` (skill corpus, 61-rule registry, `detect_bg.wasm` + glue) | `packages/dsh-frontend-craft/lib/vendor/impeccable/` | Apache-2.0 | **`LICENSE` and `NOTICE.md` are both kept** beside the tree, as section 4(d) requires. The corpus is transformed in four recorded ways (path rewrite, name rewrite, `SKILL.md` assembly) and those changes are stated in that package's README and `VERSION.json` |
| **platform-design-skills** (upstream of part of the Impeccable corpus) | inside `packages/dsh-frontend-craft/lib/vendor/impeccable/NOTICE.md` | MIT | its notice travels in upstream's `NOTICE.md` |
| **p5.js** 1.11.13 | `packages/dsh-proto-lab/lib/vendor/p5.min.js` | **LGPL-2.1** | shipped **unmodified**, with upstream's `LICENSE` beside the bytes and its source pointer in `VERSION.json`. Under LGPL-2.1 §6 you may obtain the corresponding source from <https://github.com/processing/p5.js> at the tag recorded there, or from this repository's `vendor/` build, which copies the file byte for byte |
| **CodeMirror 6** and `@codemirror/legacy-modes` | `packages/dsh-editor/lib/vendor/cm6.min.js` | MIT | built here from the pinned packages with the MIT notices kept in the generated banner |
| **Forked harness client bundles** — `@deepseek-ai/dsh-client-ui-sidebar-right`, `…-sidebar-files`, `…-open-in-app` | `packages/dsh-rightbar`, `dsh-rightbar-files`, `dsh-open-in-app` | MIT (DeepSeek) | generated forks carry a banner naming the upstream package, the pinned harness line and every patch; `scripts/tools/sync-vendored.ps1 -Check` proves the copy |
| **Radiant** @ `59e9f48c` (106 pages, 79 extracted fragment sources) | `packages/dsh-shaders/lib/vendor/radiant/` | MIT | upstream `LICENSE` beside the tree; pages stored byte-identical, fragment sources extracted from them, and `catalog.json` records every file's bytes and sha256. `vendor/radiant/build.mjs --check` re-derives the catalogue from the committed pages **offline**. The 91 gallery previews (22.6 MB) are not vendored |
| **shader-skills** @ `e09bc99` (20 GLSL modules, 11 templates, 11 gallery pieces, 14 references) | `packages/dsh-shaders/lib/vendor/shader-skills/` | MIT | upstream `LICENSE` **and `CREDITS.md`** beside the tree, the latter stating that all GLSL is an original implementation with techniques credited to their published sources. `vendor/shader-skills/build.mjs --check` re-derives the dependency closure offline. The gallery `.png` previews are not vendored |
| **awesome-glsl** @ `287c2ea` (a curated link index) | `packages/dsh-shaders/lib/vendor/glsl-links/` | MIT | `README.md` and `LICENSE` verbatim, plus `links.json` derived from the markdown and checked against it. This tree contains **no shader code**: it is a list of links |

## Downloaded at run time, never committed

| Component | Where | License |
|---|---|---|
| **ffmpeg** (BtbN/FFmpeg-Builds and evermeet.cx builds, pinned by URL + SHA-256) | downloaded to `$DSH_HOME/dsh-media/bin` only on a machine with no ffmpeg of its own | the build's own license (typically **GPL-2.0-or-later** or **LGPL-2.1-or-later** depending on the configuration); the pin names the build and the archive is hashed before anything is executed. `DSH_MEDIA_NO_INSTALL=1` forbids the download |

## Installed on the machine, not shipped

`SuperCollider` (`dsh-supercollider`), a TeX engine (`dsh-diagrams`), a
Chromium-family browser (`dsh-frontend-craft`, `dsh-browser`, `dsh-shaders`, and the
lab's render tier), `git` (`dsh-gittree`), `tesseract` or the OCR engine Windows ships
(`dsh-ocr`), and poppler/mutool/Ghostscript (`dsh-pdf`). None of these is
redistributed here; the user installs them, and their licenses are their own.

## What a redistributor of vn-code owes

1. **The AGPL terms** for vn-code's own code: source under AGPL-3.0-only, including
   a modified version you offer over a network (section 13).
2. **The notices above** for the vendored trees: the license files stay where they
   are, the Apache NOTICE travels, and the LGPL p5.js keeps its source pointer.
3. **Nothing that suggests endorsement** by any of these authors, and no relicensing
   of their work under a different term.

If you believe something in this repository is here without its license, open an
issue and it will be corrected or removed.
