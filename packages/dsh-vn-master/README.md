# dsh-vn-master (alpha.1)

**The pack's master — deliberately blank.** One no-op host row and the bundle
layer, nothing else. It exists so the pack has a base that is *not* the right
bar: pack-wide patches and future cross-cutting work belong here, while the bar
stays the bar. Alpha.

## Why it is blank

The master is the pack's base layer, so it must be inert. It ships:

| | |
|---|---|
| `dsh.bundle` | yes — `cordis.patch.yml`, which inserts the no-op `master` row |
| `dsh.client` | **no** — no browser half, so no boot-graph node |
| client service | **no** — nothing is published with `ctx.reflect.provide` |
| `inject` edges | **no** — activation waits for nothing |
| core-row disables | **no** — they stay with the packages that replace those rows |

That is what keeps the chain intact. The right bar's `sidebarRightTabs` /
`sidebarRight` services are provided inside the **generated fork**
`dsh-rightbar/lib/client.js`; the tab types (`dsh-rightbar-files`, `dsh-editor`,
the shipped document preview) resolve them from there. A blank master adds a
layer to the profile stack and touches nothing else, so the chain is unchanged
by construction rather than by care.

The same reasoning keeps the `disabled: true` rows in `dsh-rightbar`: a disable
belongs next to the insertion that replaces the row, so
`install -Plugin dsh-rightbar` still mounts exactly one bar.

## Where it sits in the stack

`dsh` applies the profile's bundle layers in order and **the later layer wins per
row**. The installer collects `packages/*` sorted by directory name and `dsh
plugin add` appends each new bundle, so `dsh-vn-master` — the only name here that
sorts after everything else — is the profile's **final layer**. That is what makes
it a master rather than just another plugin: it is the slot that can restate any
pack row, or any core row, without another package undoing it.

```
base -> web-app -> dsh-editor -> dsh-rightbar -> dsh-rightbar-files
     -> dsh-modal -> dsh-open-in-app -> dsh-themes -> dsh-vn-master   (final word)
```

(The exact order of bundles installed earlier depends on when each was first
added; the master is last because it is added last.)

## Layout

```
cordis.patch.yml   bundle layer: inserts the no-op 'master' row
lib/index.js       Node half: no-op row (the master is browser-free)
```

## Growing the master

Adding a pack-wide patch is a `cordis.patch.yml` change here — restate a row, or
disable one — and one `scripts\install.bat` / `./scripts/install.sh` run (a new row or a changed
layer needs the profile re-synced), then a restart of `npx @deepseek-ai/dsh web`
and a hard browser refresh.

Two things to keep true when it grows:

- **No `dsh.client` unless the work really is a browser surface.** The moment
  this package declares one, it joins the boot graph and needs its own check —
  and it should then be a deliberately named plugin instead, not the blank
  master.
- **Never move a provider's services here.** `sidebarRightTabs` /
  `sidebarRight` come from generated fork code; a fork belongs in the package
  that `scripts/sync-vendored.ps1` regenerates.
