# dsh-vn-master (alpha.3)

**The pack's master: browser-free, and the pack's final word per row.** One no-op
host row plus the bundle layer. It exists so the pack has a base that is *not* the
right bar: pack-wide patches and future cross-cutting work belong here, while the
bar stays the bar. Alpha.

## What it carries

Nothing of its OWN beyond the no-op `master` row — but the bundle layer is where
the pack states the things that are neither the bar's nor any one plugin's, in two
kinds: a **row restatement**, and a **pack-wide product decision**.

| Patch | What it does |
|---|---|
| `ui-sidebar-browser` → `disabled: false` (alpha.2) | 0.2 ships the right Sidebar's Browser tab **desktop-only** (`dsh-web-app`'s own layer declares `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`). This pack targets the raw **web** profile, so the pack's final layer performs the opt-in the package's README documents as a profile patch. Nothing else is restated: the row keeps the `name` and package the earlier layer gave it. |
| `ui-message-feedback`, `message-feedback`, `command-feedback`, `session-telemetry-otel` → `disabled: true` (alpha.3) | **Feedback is removed.** vncode is its own product and does not ask its users for feedback; the shipped dialog says in its own words that a submission includes the current conversation log, and that submission is what releases an upload to a third party. See *The feedback removal* below. |

No pack code draws the Browser entry on the Start page, and that is the point: the
browser package registers its tab **type** and its own **guide** entry into the
`sidebarRightTabs` registry — the shipped locales call it "Browser" / "Browse web
pages" — which is the same registry this pack's own tab types register into, so
the Start page lists it by itself. Because a later layer wins per row, the
`disabled: false` overrides the earlier `!!js` expression; a desktop profile is
unaffected, since that expression already resolved to `false` there.

## The feedback removal (alpha.3)

**Why here.** Every other disable in this pack sits with the package that replaces
the row, so a partial `-Plugin` install still mounts one of everything. This one
replaces nothing: it is a statement about the product, and the master is the only
layer that can make it once, for every profile that installs the pack.

**What the feature was.** `@deepseek-ai/dsh-client-ui-message-feedback` puts
Like/Dislike in the assistant-message action strip and a dialog behind both of them
and behind `/feedback`; the dialog's own copy reads *"Add details to help us
improve. Your submission will include the current conversation log."* Two host
halves record it: `message-feedback` (the `messageFeedback` Remote and the
`feedback/message-*` events) and `command-feedback` (the `/feedback` command, the
`sessionFeedback` Remote and `feedback/record`).

**Why it also removes the telemetry row.** `session-telemetry-otel` is the only
thing in the harness that ships a Session log anywhere but the model API, and it
runs in `FEEDBACK_ONLY` mode: it captures a prefix and POSTs it to
`https://dsh-otel-collector.deepseeksvc.com/v1/logs` **only after an explicit
feedback event**, with `$DSH_HOME/.anonymous-user-id` as the OpenTelemetry
`user.id`. Disabling the three producers already leaves it nothing to release, and
disabling the row itself is the launcher's own privacy switch — the same
`disabled: true` a non-empty `DSH_TELEMETRY_DISABLED` resolves to (see
`dsh-app-boot`'s `resolveTelemetryPatch`) — so the exporter is never even
constructed.

**What it does not touch.** `remote.messageFeedback` / `remote.sessionFeedback`
appear only inside the feedback packages, and the shipped Session export guards its
own entry as `ctx.get('feedbackUi')?.openSession(...)` behind an availability flag,
so `/export` and its dialog keep working with the feedback affordance absent.

**The account menu's own Feedback item is not a row**, so it cannot be disabled
here: it is hardcoded in `@deepseek-ai/dsh-client-ui-settings-account`'s
`AccountMenu` and opens an external form in a new window carrying the uid, the
locale, the harness version and the device info. `dsh-themes` hides that one row
(its `account-menu` override). Doing it here as a `config` override of the row's
`contactFormUrl` was **rejected on purpose**: a row with `volatile` fields has its
whole `config` replaced by the next volatile write from a settings form (a later
layer wins per row, and `applyEntryPatches` replaces `config` rather than merging
it), so the override would silently evaporate — a guard that disappears is worse
than none.

**How to see it.** The rows are composed at boot, so a profile that already runs
`dsh web` needs a **restart** (and a hard browser refresh) before the surfaces are
gone.

## Why it stays inert

The master is the pack's base layer, so the parts that could disturb the tree must
stay empty. It ships:

| | |
|---|---|
| `dsh.bundle` | yes — `cordis.patch.yml`: the no-op `master` row, plus the pack's row restatements and pack-wide disables |
| `dsh.client` | **no** — no browser half, so no boot-graph node |
| client service | **no** — nothing is published with `ctx.reflect.provide` |
| `inject` edges | **no** — activation waits for nothing |
| code | **no** — `lib/index.js` is the no-op row; every patch here is a row statement |
| disables | only PACK-WIDE ones (alpha.3's feedback removal). A disable that belongs to the package REPLACING a row stays with that package — `dsh-rightbar` disables `ui-sidebar-right` / `ui-sidebar-files` — so a partial `-Plugin` install still mounts exactly one bar |

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
