# dsh-vn-master (alpha.2)

**The pack's master: browser-free, and the pack's final word per row.** One no-op
host row plus the bundle layer. It exists so the pack has a base that is *not* the
right bar: pack-wide patches and future cross-cutting work belong here, while the
bar stays the bar. Alpha.

## What it carries

Nothing of its OWN beyond the no-op `master` row — but the bundle layer is where
the pack states the things that are neither the bar's nor any one plugin's. So far
that is exactly one **row restatement**:

| Patch | What it does |
|---|---|
| `ui-sidebar-browser` → `disabled: false` (alpha.2) | 0.2 ships the right Sidebar's Browser tab **desktop-only** (`dsh-web-app`'s own layer declares `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`). This pack targets the raw **web** profile, so the pack's final layer performs the opt-in the package's README documents as a profile patch. Nothing else is restated: the row keeps the `name` and package the earlier layer gave it. |

No pack code draws the Browser entry on the Start page, and that is the point: the
browser package registers its tab **type** and its own **guide** entry into the
`sidebarRightTabs` registry — the shipped locales call it "Browser" / "Browse web
pages" — which is the same registry this pack's own tab types register into, so
the Start page lists it by itself. Because a later layer wins per row, the
`disabled: false` overrides the earlier `!!js` expression; a desktop profile is
unaffected, since that expression already resolved to `false` there.

## Why it stays inert

The master is the pack's base layer, so the parts that could disturb the tree must
stay empty. It ships:

| | |
|---|---|
| `dsh.bundle` | yes — `cordis.patch.yml`: the no-op `master` row, plus the pack's row restatements |
| `dsh.client` | **no** — no browser half, so no boot-graph node |
| client service | **no** — nothing is published with `ctx.reflect.provide` |
| `inject` edges | **no** — activation waits for nothing |
| core-row disables | **no** — the one restatement here *enables* a shipped row, and a disable still belongs with the package that replaces the row |

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
cordis.patch.yml   bundle layer: the no-op 'master' row, plus the pack's row restatements
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
  and it should then be a deliberately named plugin instead, not the browser-free
  master.
- **Never move a provider's services here.** `sidebarRightTabs` /
  `sidebarRight` come from generated fork code; a fork belongs in the package
  that `scripts/sync-vendored.ps1` regenerates.
