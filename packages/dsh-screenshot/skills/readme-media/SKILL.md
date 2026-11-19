---
name: readme-media
description: Publish screenshots in a repository so a README renders them correctly on GitHub - relative paths, a display width computed from the capture's scale, a light/dark pair as a picture element, alt text that earns its place, size budgets, and how to refresh a picture without leaving the old one behind. Covers the markup shot_place returns and the reasons a picture looks wrong after it is committed.
---

# Pictures in a repository

A screenshot is not done when it is captured. It is done when a README renders
it at the right size, with text that describes it, and a name that will still be
there after the next redesign.

## Where a picture goes

`shot_place` writes into the folder you name - `docs/assets/screenshots` is the
convention that survives:
relative to the repository root, beside the docs it illustrates, and outside any
build folder so nothing prunes it.

The name is deterministic, from three things:

    <slug>-<viewport>[-dark].png

    hero-desktop.png        hero-phone.png        hero-desktop-dark.png

`<slug>` is what the thing is (`hero`, `settings`, `checkout`), folded to
lower-case ascii with single dashes. `<viewport>` is the rung the picture was
captured at. Re-capturing replaces the same file, so a repository never
accumulates `hero-2.png`, `hero-final.png`, `hero-final-v2.png` - the failure
mode where nobody can tell which picture is current.

## The width is arithmetic, not taste

A `dpr: 2` capture is twice as many pixels at the same layout. Publishing it at
its pixel width is a README that scrolls sideways; publishing it at half its
pixel width is sharp on a retina screen and correct everywhere else. That is what
`shot_place` computes:

    published width = round(file pixels / the scale it was captured at)   capped at 1000

So a 2880 px retina capture is published at 1000 (the cap), a 390 px phone
capture at 390, and a 2248 px window captured at 1.5x at 1000. Pass `dpr` on the
shot when it was not 1 - the tool that captured it reports the scale
(`shot_url`'s `dpr`, `shot_window`'s `scale`).

`width` as an attribute is not decoration: it reserves the space before the
image loads, which is what stops a README from jumping while a 2 MB PNG arrives.

## A light/dark pair is a picture element

GitHub renders `<picture>` with a `prefers-color-scheme` source, which is the only
way a screenshot follows the reader's theme. Put both halves in one `shot_place`
call with the SAME `slug` and the SAME `viewport` - one with `theme: "dark"`, one
without - and the block comes back as:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/hero-desktop-dark.png">
  <img src="docs/assets/screenshots/hero-desktop.png" width="1000" alt="The dashboard: three projects, each with its last build status">
</picture>
```

The two halves pair by their FILE NAME: `hero-desktop.png` and
`hero-desktop-dark.png` are one picture, because both are named for the same
screen. That is why they must share a `viewport` - a light phone shot and a dark
desktop shot are two different names, so they publish as two plain `<img>` tags
instead of one themed pair. If that is not what you wanted, the `viewport` on one
of the two shots is wrong.

Two shots that would resolve to the same name are refused by name rather than
silently overwriting each other - one slug, one viewport, one theme is one file.

One picture of one screen is an `<img>`. Do not wrap a single image in
`<picture>`: it adds markup and changes nothing. A tour (several viewports of one
slug) is several `<img>` tags and belongs in the same `shot_place` call as the
pairs - the tool groups by name, not by call.

## Alt text, which is the part people skip

Alt text is what a reader gets when the image does not load, when they use a
screen reader, and when they search. It is required by `shot_place` on purpose.

- Say **what the picture shows**, not what it is: "The dashboard: three projects,
  each with its last build status" - not "screenshot of dashboard".
- If the picture only decorates, an empty alt (`alt=""`) is the correct answer
  for a decorative image - but a screenshot in a README is not decoration, so
  write the sentence.
- Do not repeat the caption in the alt text; the alt is for someone who cannot
  see the picture, the paragraph is for everyone.

## Size

Aim under ~500 KB per picture. What moves it:

| Change | Effect |
|---|---|
| `dpr: 2` on a 1440x900 page | ~4x the bytes of dpr 1 - only for a hero shot |
| `fullPage: true` on a long page | can pass 2 MB; clip a section instead |
| A photo or a gradient-heavy UI | large; a flat UI panel compresses to tens of KB |
| An animated demo | not a screenshot - that is a video/GIF and it belongs in `dsh-media`, not here |

GitHub warns above 50 MB and blocks above 100 MB per file, which a screenshot
never reaches; the practical ceiling is a reader on a phone. If a picture has to
be enormous, put it in a release asset and link it.

## Placing, then shipping

`shot_place` is a **dry run by default**: it reports the files it would write and
the markdown block, and writes nothing until `dryRun: false`. An existing file is
kept unless `overwrite: true`, so re-placing a picture never silently replaces
one somebody reviewed.

It does not run git and holds no credential. Once the files are placed:

```sh
git add docs/assets/screenshots
git commit -m "docs: refresh the screenshots"
```

Re-capture and re-place with `overwrite: true` when the UI moves. The manifest
(`docs/assets/screenshots/manifest.json`) records what each file is, at what
size and scale, and where it came from - so a picture whose page no longer exists
can still be traced.

## What not to publish

- A picture of a page behind a login, unless the data in it is meant to be public
  (a screenshot leaks whatever the page showed, including names and tokens).
- A picture that depends on a live third-party site: it will rot. Render the page
  from the repository instead.
- A picture with a cursor, a tooltip, or a window chrome that is not the product.
- A picture whose state cannot be reproduced: a toast that lasts two seconds is
  worth capturing only if the toast IS the subject, and then say so in the caption.
