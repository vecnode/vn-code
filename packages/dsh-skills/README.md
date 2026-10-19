# dsh-skills (alpha.4)

**The Skills browser**: the left bar's **Skills** button (`dsh-themes`' band strip) opens a centered modal listing every skill the harness loads for this chat. Pick one to **read its rendered document**, press **Edit** to see and change the source, press **Save** to write it back. A click outside the modal closes it.

This package's own entry point is a **header seat** at `order: -50` in `conversation.session.header.utilities`. When the band is mounted it is that button the band clicks — the band queries `[data-dsh-skills="button"]` — and the header seat is hidden by CSS, because the app should not have two doors to one dialog. A profile without `dsh-themes` keeps the header seat as its only way in.

The catalog is the HOST's own `ctx.skills.snapshot({ cwd, scope })` for this conversation, with the session's own project folder and agent scope — the same registry the system prompt and the composer's `/` menu read — so the modal cannot disagree with what the model was given. Every other surface is model-facing or name-only; this is the one that says where a skill lives, which copy won when two are installed under one name, and what its document says.

## What it adds

- **One header button** at `order: -50` in `conversation.session.header.utilities`, one step left of the page-zoom control at `-40`, which `dsh-themes` owns. The band's Skills button clicks it; with the band mounted, the header seat is hidden so there is exactly one visible entry point.
- **One row per winning skill**, grouped by origin, each carrying its provider, whether the model and the user may invoke it, the absolute file behind it and its size:

| Group | Root |
|---|---|
| Project `.dsh/skills` | `<project>/.dsh/skills` |
| Project `.agents/skills` | `<project>/.agents/skills` |
| Custom root | a deployment-configured `customSkillDirs` entry |
| Your skills | `$DSH_HOME/skills` |
| Your skills `.agents` | `~/.agents/skills` |
| Bundled with a package | `DSH_BUNDLED_SKILL_DIR`, and skills a plugin registers |
| Registered at runtime | a plugin that registered content directly |

- **The rendered document, not the source**: the same `MarkdownText` primitive and the same `data-document-markdown` container the right bar's rendered Markdown view uses — the marker `dsh-themes` keys its Markdown paper on, so the document reads as a white page with dark letters in either app appearance. Frontmatter is part of what is drawn, because it is part of the file. **The source appears only when you ask for it**: Edit swaps the page for a textarea, Stop editing puts it back.
- **A search box** filtering on name, description, `whenToUse`, provider, source bucket and path.
- **A version marker** in the modal's top bar, so the bundle version actually being served is visible in plain sight, without devtools.

## How it plugs in

`cordis.patch.yml` inserts the `skills` row — plural on purpose, because the singular `skill` and `skill-filesystem` rows already exist and belong to the registry and its filesystem provider. The Node half registers three authenticated `connection.fetch` routes, the mechanism dsh-editor and dsh-pdf use:

| Route | Purpose |
|---|---|
| `GET /api/dsh-skills/list?session=<id>` | the effective catalog (metadata only, plus each file's size and mtime) |
| `GET /api/dsh-skills/body?session=&name=` | one skill's document, raw and frontmatter included |
| `POST /api/dsh-skills/save` | write a document back to the registry's own path |

The browser half opens the pack's shared dialog in its **rich** form — `modals.open({ size: 'lg', dismissOnMask: true, content })` — resolved lazily through `ctx.get`, so a profile without [`dsh-modal`](../dsh-modal) still loads and says so. `dismissOnMask` is the one opt-in rich dialogs have (see that package's README): the browser holds no draft of its own, so a click outside it closes it, while Escape and its Close button keep working.

## Limits

- **The client never names a path.** It names a skill and the new text; the host writes the file the registry itself just resolved for that name, so a request cannot name a file this plugin would not have offered.
- The write is **atomic** (a private temp file beside the target, then a rename) and the document must still carry the frontmatter the registry requires (`name:` and `description:`), checked BEFORE the disk is touched, so a save cannot quietly make a skill disappear from the catalog. A save is refused (`409`) when the file's `mtimeMs`/size moved since it was opened, so it cannot clobber a concurrent edit by the agent.
- The answer says whether the new text is **live** (the shipped `filesystem` provider watches its roots) or needs a **restart** (any other provider holds its text in memory).
- A skill whose winning definition names no file (registered at runtime) is shown from that loaded text and is honestly **read-only**; a pathless definition is still listed, with the listing reporting it in `unreadable`.
- A harness build whose primitives export no `MarkdownText` falls back to a plain monospace pane instead of breaking. The primitive is always handed its chrome labels (`Copy`/`Copied`, `Footnotes`).

## Verify

```sh
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
```

## Install

The repo launcher (`scripts\setup\install.bat` on Windows, `./scripts/setup/install.sh` on macOS/Linux) auto-discovers this package — it is a standard `dsh.bundle`, so a bundle the profile does not list yet is added by one plain launcher run (no `-Force`). The web profile links it into this repo, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard browser refresh.
