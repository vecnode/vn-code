# dsh-vn-master (alpha.3)

**The pack's master: browser-free, and the pack's final word per row.** One no-op host row plus the bundle layer. It exists so the pack has a base that is not the right bar: pack-wide patches and cross-cutting work belong here, while the bar stays the bar.

`dsh` applies a profile's bundle layers in order and **a later layer wins per row**. The installer collects `packages/*` sorted by directory name and `dsh plugin add` appends each new bundle, so `dsh-vn-master` — the only name here that sorts after everything else — is the profile's **final layer**: the slot that can restate any pack row, or any core row, without another package undoing it.

## What it adds

Nothing of its own beyond the no-op `master` row. The layer carries the pack's statements about shipped rows, in two kinds — a **row restatement** and a **pack-wide product decision**:

| Patch | What it does |
|---|---|
| `browser` → `disabled: true` | the whole Browser surface is out of the boot graph: no Browser tab, no `/api/dsh-browser/*` routes, no `browser_render` / `browser_query` / `browser_text`, and the client bundle is never loaded. [`dsh-browser`](../dsh-browser) keeps its place in the pack and its checks keep running, so re-enabling it is deleting these two lines. |
| `ui-message-feedback`, `message-feedback`, `command-feedback`, `session-telemetry-otel` → `disabled: true` | **Feedback is removed.** vncode is its own product and does not ask its users for feedback. |
| `insert: master` | the no-op row that marks the master as mounted and gives future work a row to restate instead of inventing one. |

**Do not add a `ui-sidebar-browser → disabled: false` restatement here.** `dsh-browser` owns that row and disables it, so a re-enable would mount TWO Browser tabs — one of them the iframe surface this pack replaced. A layer that restates a row must not fight the package that owns it.

## The feedback removal

- `ui-message-feedback` is the browser half: Like/Dislike in the assistant-message action strip, the Submit-feedback dialog in `conversation.input.overlay` and its acknowledgement toast, the `/feedback` composer decoration, and the `feedbackUi` service. The dialog's own copy says a submission "will include the current conversation log".
- `message-feedback` and `command-feedback` are the two host halves: the `messageFeedback` / `sessionFeedback` Remotes and the log-only `feedback/message-*` + `feedback/record` events they append.
- `session-telemetry-otel` is the only path in the harness that ships a Session log anywhere but the model API. It runs in `FEEDBACK_ONLY` mode: it captures a prefix and POSTs it to the vendor's collector (`https://dsh-otel-collector.deepseeksvc.com/v1/logs`, with `$DSH_HOME/.anonymous-user-id` as `user.id`) **only after an explicit feedback event**. With every producer disabled it has nothing to release — and disabling the row is the launcher's own privacy switch, the same `disabled: true` a non-empty `DSH_TELEMETRY_DISABLED` resolves to, so the exporter is never even constructed.

Nothing else consumes those services, and the shipped Session export guards its own entry as `ctx.get('feedbackUi')?.openSession(...)` behind an availability flag, so `/export` keeps working. The account menu's hardcoded **Feedback** item is not a row and is hidden by [`dsh-themes`](../dsh-themes) instead; a `config` override here was rejected on purpose, because a row with `volatile` fields has its whole `config` replaced by the next volatile write from a settings form.

## Limits

- **No `dsh.client`, ever, unless the work really is a browser surface.** The moment this package declares one it joins the boot graph and needs its own check — and it should then be a deliberately named plugin, not the browser-free master.
- **No published service, no `inject` edge, no code.** `lib/index.js` is the no-op row; every patch here is a row statement.
- **A disable that belongs to the package REPLACING a row stays with that package** — `dsh-rightbar` disables `ui-sidebar-right` / `ui-sidebar-files` — so a partial `-Plugin` install still mounts exactly one bar, or one Browser tab.
- **Never move a provider's services here.** `sidebarRightTabs` / `sidebarRight` come from the generated fork in `dsh-rightbar/lib/client.js`; a fork belongs in the package `scripts/sync-vendored.ps1` regenerates.
- Adding a pack-wide patch is a `cordis.patch.yml` change here plus one `scripts\install.bat` / `./scripts/install.sh` run (a changed layer needs the profile re-synced). The rows are composed at boot, so a running profile needs a **restart** and a hard browser refresh before the change is visible.

## Verify

```sh
node scripts/checks/check-node-routes.mjs
```

It asserts that `.dsh-version.json` agrees with every `package.json` and that this layer keeps the feedback rows disabled **and** names ids that exist in the pinned line's own layers (`dsh-web-app` / `dsh-base`) — a patch naming a row that is not there is skipped with a warning, which is exactly the quiet failure that would bring the surface back with the check still green.
