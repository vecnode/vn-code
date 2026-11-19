---
name: app-tour
description: Capture a SET of screenshots rather than one - a tour of an app for a README, a release note or a design review. Covers planning the shots as a list before capturing, one slug family with deterministic names, desktop and phone rungs, light and dark halves, capturing a flow in the right order, and refreshing the whole set when the UI changes.
---

# A tour, not a screenshot

One screenshot answers "what does it look like". A tour answers "what does this
product do", and it is what a README, a release note or a portfolio actually
needs. The difference is planning: the set is decided **before** the first
capture, because the second-best picture of the wrong screen is worthless.

## Plan the set first

Write the list as slug, viewport, theme, and the sentence each picture has to
carry. Six is a generous tour; three is usually enough.

    hero       desktop  light+dark   The whole product, one screen
    settings   desktop  light        Where the thing is configured
    mobile     phone    light        The same product on a phone
    flow       desktop  light        The step that is not obvious

Then capture in that order. The plan is also the acceptance test: if the `hero`
shot does not make the product legible at 1000 px wide, no amount of post-hoc
cropping fixes it.

## One slug family, one naming scheme

Every picture in a tour shares the same `<slug>` and differs by viewport and
theme, so the file names line up:

    hero-desktop.png    hero-desktop-dark.png    hero-phone.png
    settings-desktop.png
    flow-desktop.png

That naming is what makes the set re-capturable. The same call that produced it
produces it again - which is the point: a tour you cannot refresh in one pass is
a tour that will be wrong in three months.

## The loop

1. **Start the app** - the dev server on loopback, or the desktop app open on the
   screen. A tour of a page that is not running is a tour of Chrome's error page.
2. **Capture each shot**, with `out` naming the file inside the workspace, and a
   name that matches the scheme:

       shot_url { url: "http://localhost:5173/settings", viewport: "desktop",
                  out: "docs/assets/screenshots/settings-desktop.png" }

3. **Capture the dark halves** with `dark: true` and the SAME viewport, into
   `-dark` files - only when the product actually has a dark theme. The pair is
   one `<picture>` when both halves are named for the same screen, so a dark
   phone shot next to a light desktop shot publishes as two separate pictures
   instead of a themed pair - a sign the set is inconsistent, not a failure.
4. **Place them in ONE call**, `dryRun: false` once the block reads right, so the
   manifest is written once and the markdown comes out in the order you listed.
5. **Look at every file** before committing. A tour is published, not archived.

For a desktop app the same loop uses `shot_window` with a handle and `shot_screen`
for anything that spans two windows - and native capture has NO permission
dialog, so a five-shot tour is five calls, not five pickers.

## States a tour needs, and states it does not

Capture the states that are **reproducible**: the empty state, the list with
data, the dialog you can open again, the error you can trigger. Those are the
ones a tour is for - an empty state is a screen people see and a README never
shows.

Skip the states that are gone in two seconds (a toast, a spinner, a hover
tooltip) unless that moment IS the subject. A picture you cannot reproduce is a
picture you cannot refresh, and a tour with one unrefreshable frame stops being
maintained.

## Refresh it as one act

When the UI moves:

1. Re-capture each shot **into the same paths** (`out` plus `overwrite: true`, or
   `shot_place` with `overwrite: true`).
2. Re-place the set in one call.
3. Read the diff: the manifest changes only where a picture changed, and a
   picture whose bytes did not change produces no diff at all.

That last property is why the names are deterministic and the captures are
`dpr`-consistent: a refresh that changed the padding by two pixels shows up as
ONE changed file, not as three new files and a broken README.

## What a tour is not

- Not a video. Motion belongs to a recording (ffmpeg and `dsh-media`), and a GIF
  of a screenshot set is a worse artifact than the set.
- Not a screenshot of every screen. A tour with twelve pictures is a manual
  nobody reads.
- Not a replacement for alt text. Each picture still needs the sentence that says
  what it shows - the caption explains the flow, the alt describes the frame.
