# Vendored: Diagram Design

`lib/vendor/design/` is a **generated copy** of the Diagram Design kit. It is not
written here and it is not hand-editable; `vendor/design/build.mjs --check`
re-hashes every file against `lib/vendor/design/VERSION.json` and fails on the
smallest drift.

## Upstream

| | |
|---|---|
| project | Diagram Design — <https://github.com/cathrynlavery/diagram-design> |
| gallery | <https://cathrynlavery.github.io/diagram-design/> |
| author | Cathryn Lavery |
| licence | MIT (`lib/vendor/design/LICENSE`, plus `THIRD_PARTY_LICENSES.md`) |
| pinned commit | `7a2e22170ee838e859d8142ba825d83f8b6375e6` |
| declared skill version | 2.6 |
| commit date | 2026-10-10 |

## What was taken, and why

| from upstream | into this package | why |
|---|---|---|
| `skills/diagram-design/assets/example-*.html` | `assets/` | every worked example: 204 files, plain / `-full` / `-dark` / `-animated` |
| `assets/template*.html` | `assets/` | the five templates a new diagram starts from, including `template-motion.html` whose controller is the ONLY script `html-check.js` accepts |
| `assets/icons.html` | `assets/` | the icon library `references/primitive-icons.md` indexes |
| `assets/index.html` | `assets/` | upstream's own gallery page, for browsing the frame locally |
| `references/**` | `references/` | 62 documents: style guide, semantic patterns, primitives, animation, output spec, layout budget, profiles, and 44 `type-*.md` |
| `SKILL.md` | `SKILL.md` | the selector table (behavioural trigger → semantic pattern → visual type) |
| `LICENSE`, `THIRD_PARTY_LICENSES.md` | `.` | attribution, kept beside the bytes |
| `scripts/self_check.py` | `scripts/` | the contract `lib/html-check.js` PORTS. Kept as the original so the port can be diffed against its source; the pack never runs it (no Python is assumed on any host) |

277 files in all, 4.8 MB. Nothing else was taken. `scripts/*.py` other than
`self_check.py` (the importers and the exporter) were left upstream: they need
Python and third-party tooling that this pack's zero-dependency rule does not
allow.

## What was changed

**Line endings, and nothing else.** The upstream tree is mixed - most of it is
LF, but **7 of the 204 examples were committed with CRLF**. Since `--check`
compares BYTES, and a checkout's line endings are governed by `.gitattributes`,
those 7 would be rewritten on checkout and report drift against a commit that had
not changed. The pack's rule for every hashed tree is the same one `dsh-pdf`'s
vendored tree and the forked client bundles follow: **the stored form is LF, and
the checker agrees with the commit rather than with whoever checked it out**. The
build normalizes line endings and records `counts.normalizedToLf` in
`VERSION.json`; the kit's own `self_check.py` passes every one of the 209
normalized files just as it passes the originals, which is how "nothing else
changed" is checked rather than asserted.

Everything else is byte-identical to the pinned commit. The three adaptations the
panel needs - the system font stack, the dark-theme tokens, and the CSP that
forbids every fetch - are applied by `composeHtmlDocument` at REQUEST time
(`lib/design-kit.js`), never by editing a vendored file.

## Maintenance

```sh
node packages/dsh-diagrams/vendor/design/build.mjs --check   # offline, re-hashes the tree
node packages/dsh-diagrams/vendor/design/build.mjs           # re-vendor the pinned commit
node packages/dsh-diagrams/vendor/design/build.mjs --from <checkout>   # vendor a local checkout
node packages/dsh-diagrams/vendor/design/build.mjs --update-pin        # move the pin to the branch head
```

A pin bump is a deliberate act: move the pin, vendor, then run
`npm run check` in this package - which re-proves the port against the corpus and
recomputes the motion controller's hash.
