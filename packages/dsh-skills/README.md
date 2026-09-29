---
description: "The Skills browser: one header button, one modal, every skill this conversation loads - read the markdown, edit it inline."
kind: "package-reference"
---

# dsh-skills

One button in the conversation header - immediately **left of the page-zoom
control** - opens a centered modal listing every skill the harness loads for this
chat. Pick one to read its markdown, press **Edit** to change it, press **Save**
to write it back.

## Why it exists

Skills are the documents that teach the model how to do something: they are
advertised in the system prompt, loaded on demand by the `skill` tool, and
invocable by name from the composer's `/` menu. Every one of those surfaces is
either model-facing or name-only:

- the **system prompt** lists them for the model,
- the **`/` menu** offers user-invocable ones as `name` + `description` (the
  shipped `skills/list` Remote carries no path, no source, no provider and no
  body - it exists to feed that menu),
- nothing in the interface says **where a skill lives**, **which copy won** when
  two are installed under one name, or **what its document says**.

This plugin is that missing surface, and it is read from the same place the model
reads: the HOST's own `ctx.skills` registry.

## What the modal shows

One row per **winning** skill - a name shadowed by a higher-ranked copy is one
entry, and the entry names the copy that won - grouped by where it came from:

| Group | Root |
|---|---|
| Project `.dsh/skills` | `<project>/.dsh/skills` |
| Project `.agents/skills` | `<project>/.agents/skills` |
| Custom root | a deployment-configured `customSkillDirs` entry |
| Your skills | `$DSH_HOME/skills` |
| Your skills `.agents` | `~/.agents/skills` |
| Bundled with a package | `DSH_BUNDLED_SKILL_DIR`, and skills a plugin registers |
| Registered at runtime | a plugin that registered content directly |

Each row carries its provider (which package owns it), whether the model and the
user may invoke it, the absolute file behind it, and its size. The detail pane
shows the raw document, **frontmatter included** - that is what you edit - plus a
`Copy path` action.

The catalog is the host's own `ctx.skills.snapshot({ cwd, scope })` for **this
conversation**, with the session's own project folder and agent scope, so the
modal cannot disagree with what the model was given.

## Editing

- **Edit** swaps the document for a textarea; **Save** writes it; **Revert**
  drops your changes; **Stop editing** returns to the rendered text.
- **The client never names a path.** It names a skill and the new text; the host
  writes the file the registry itself just resolved for that name, so a request
  cannot name a file this plugin would not have offered.
- The write is **atomic** (a private temp file beside the target, then a rename).
- The document must still carry the frontmatter the registry requires (`name:`
  and `description:`) - checked BEFORE the disk is touched, so a save cannot
  quietly make a skill disappear from the catalog.
- A save is refused (`409`) when the file's `mtimeMs`/size moved since you opened
  it, so it cannot clobber a concurrent edit by the agent.
- The answer says whether the new text is **live** (the shipped `filesystem`
  provider watches its roots, so the next listing - and the next turn - sees it)
  or needs a **restart** (any other provider holds its text in memory, so the
  file is read again when the harness starts).

A skill whose winning definition names **no file** (a plugin that registered
content directly) is shown from that loaded text and is honestly **read-only** -
the modal says why instead of offering a button that cannot work.

## Routes

Authenticated `connection.fetch` routes, the same mechanism dsh-editor and
dsh-pdf use:

| Route | Purpose |
|---|---|
| `GET /api/dsh-skills/list?session=<id>` | the effective catalog (metadata only, plus each file's size and mtime) |
| `GET /api/dsh-skills/body?session=&name=` | one skill's document, raw |
| `POST /api/dsh-skills/save` | write a document back to the registry's own path |

A pathless definition is still listed: "advertised but unreadable" is a fact
worth showing, and the listing reports it in `unreadable`.

## The search box

The list filters on name, description, `whenToUse`, provider, source bucket and
path - so `SKILL.md` finds the folder bundles and `$DSH_HOME` finds the copies the
installers wrote.

## Composition

- **dsh-modal** (the pack's shared dialog surface) is used in its **rich** form:
  `modals.open({ size: 'lg', content })`, where `content` owns the body. The
  dialog's mask click deliberately does not close a rich dialog - it can hold
  unsaved work - while Escape and the Close button do.
- **dsh-themes** owns the neighbouring header controls; this button sits at
  `order: -50`, one step left of the page-zoom control at `-40`.
- Nothing is patched, no core row is disabled, and there is no npm dependency.
