# The style library

A **composition** (an archetype) is *which* design; a **style** is *how it looks*. The two are
independent on purpose: `canvas_new { preset, archetype, style }` starts a design in a look, and
`canvas_style { id, style }` applies another one to a design that already exists.

This file is GENERATED from `lib/styles/*.json` by `vendor/styles-doc.mjs`, and a tracked check
fails when it is stale - so what follows is exactly the library the host will apply.

## What applying a style changes, and what it never touches

- **Palette.** Every colour role is replaced, and every colour literal in the document that was
  one of the old role values is rewritten to the new value for that role. That is how a canonical
  document (which carries literals everywhere) gets re-coloured by role rather than by luck.
- **Type behaviour.** The family roles, the display weight and tracking, the line height, and a
  scale factor applied as a DELTA against the style the design already carried - so applying the
  same style twice is a no-op and switching back restores the original sizes exactly.
- **Shape and surface.** The radius scale, the border weight and colour, the shadow, the canvas
  background, and which art generator the design prefers.
- **The space a photo gets.** A pack says how an image is rounded, cropped, tinted and
  blended, so a photograph dropped into a theme belongs to it instead of looking borrowed.
  The treatment sets the radius, the `fit` (which is what decides how the picture is cropped
  into its box - a document never carries a crop rectangle, that is derived from the asset),
  the scrim (which side, which palette role, how strong) and the blend mode.
- **Never geometry.** No style moves, resizes or reorders a single node: that is what archetypes
  are for, and it is asserted for every (style x archetype) pair by `check-canvas-node.mjs`.
- **Never text.** A style cannot rewrite your words.

A style cannot express what the language does not have: there is no blur, so "glass" is
translucency, a hairline and a soft shadow rather than a real backdrop filter, and a style whose
intent says so is telling the truth.

## Choosing one

| style | character |
|---|---|
| `editorial` | Editorial: The authority of a printed magazine: one large, tightly tracked display line, a warm accent used once, generous margins and a great deal of quiet space around the words. |
| `brutalist` | Brutalist: Raw structure on show: paper-white or ink-black surfaces, thick rules instead of shadows, no rounding, and type set so large it becomes the layout rather than sitting in it. |
| `minimal` | Minimal: One idea, a great deal of air, and hairlines instead of boxes: the surface is almost empty, the type is one step smaller than you expect, and nothing decorative is allowed to compete with the words. |
| `neon` | Neon: Night-city signage: a near-black surface, one electric accent that glows, display type set tight and loud, and a procedural light source behind the composition rather than a photograph. |
| `gradient` | Gradient: A saturated two-stop wash as the whole background: the composition sits on colour rather than in a frame, with generous rounding and white type that holds against the darkest part of the wash. |
| `glass` | Glass: Layered translucent panels on a dark surface with thin light hairlines and soft shadows. |
| `bento` | Bento: A light page of rounded cards in a grid, each holding one idea with its own label: the composition reads as a set of tidy boxes, and the design's job is to decide which box is biggest. |
| `retro` | Retro: Printed ephemera: a warm cream stock, two inks, small hard offsets instead of shadows, and a texture that admits it was printed - the palette of a 1970s poster rather than a screen. |
| `terminal` | Terminal: A phosphor screen: black-green ground, one luminous accent, everything monospaced, and a faint grid that reads as scanlines without drawing any. |
| `corporate` | Corporate: The safe, competent look a serious announcement wants: white ground, a confident blue, a cool grey for the second voice, blueprint texture at the edge, and nothing that could date. |
| `vibrant` | Vibrant: Loud, playful and generous with colour: a deep plum ground, two saturated accents that can share the canvas, pill shapes everywhere, and a full-bleed ring pattern behind the words. |
| `paper` | Paper: A written page rather than a screen: warm off-white stock, near-black ink, one earthy accent, small radii and a texture that reads as fibre - the calmest style in the library. |

Ask for the look in the brief when the person names one ("make it brutalist", "keep it
corporate"), and otherwise pick the one whose `bestFor` names the preset you are working on. Do
not stack two styles in one design: apply one, render, look, and change it only if the render
disagrees with the intent.

## The packs

### `editorial` — Editorial

The authority of a printed magazine: one large, tightly tracked display line, a warm accent used once, generous margins and a great deal of quiet space around the words.

| | |
|---|---|
| swatch | `#0b0e14` `#141a24` `#f8fafc` `#9aa6b8` `#e3b25a` `#f2e3c6` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1, weight 700, tracking -1.5, line-height 1.08 |
| shape | radius card 4 / chip 4 / pill 999, border 0px, shadow none |
| image | radius card, crop cover, tint surface at 0.42 (bottom scrim, normal) |
| art | grain, grid at 0.28 opacity |
| best for | github-social, og, linkedin-post, poster-a3 |

**Do**

- Let the headline own the canvas: one display line, at most two, and nothing competing beside it.
- Use the warm accent exactly once - a rule, a single word, or an eyebrow - never as a background for a large block.
- Keep margins at least twice the preset's minimum; white space is the style's main material.
- Set body copy in a muted ink one step off the background, never pure white.

**Don’t**

- Do not stack more than three text sizes.
- Do not use the accent for body copy or for a large fill.
- Do not add rounded cards or heavy shadows; the shape language is square and flat.

**Gates** (the render report checks these):

- Headline is at least 3x the body size.
- Body contrast is at least 4.5:1 against the surface.
- The accent covers less than 10% of the canvas.

### `brutalist` — Brutalist

Raw structure on show: paper-white or ink-black surfaces, thick rules instead of shadows, no rounding, and type set so large it becomes the layout rather than sitting in it.

| | |
|---|---|
| swatch | `#f4f1ec` `#ffffff` `#0a0a0a` `#3d3d3d` `#d42a00` `#ffe9c7` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1.05, weight 700, tracking -2, line-height 1.05 |
| shape | radius card 0 / chip 0 / pill 0, border 4px, shadow hard |
| image | radius 0, crop cover, tint none |
| art | grid, blueprint at 0.18 opacity |
| best for | github-social, poster-a3, linkedin-square, x-post |

**Do**

- Give every panel a heavy rule: the border IS the decoration, so no panel floats without one.
- Set the headline at the largest size the safe area allows and let it break across lines at awkward, deliberate points.
- Keep the palette to ink, surface and ONE hot accent - any third colour weakens the shout.
- Use the hard offset shadow at one direction only, and never with a blur.

**Don’t**

- Do not round a single corner; radius 0 is the whole point.
- Do not use a gradient, a soft shadow or a translucent panel.
- Do not set body copy in the display family - the contrast between the two is load-bearing.

**Gates** (the render report checks these):

- Ink on surface is at least 12:1.
- The accent covers less than 15% of the canvas.
- No rounded corner, no blur, no gradient anywhere.

### `minimal` — Minimal

One idea, a great deal of air, and hairlines instead of boxes: the surface is almost empty, the type is one step smaller than you expect, and nothing decorative is allowed to compete with the words.

| | |
|---|---|
| swatch | `#ffffff` `#fafafa` `#111318` `#5b6270` `#f1f3f6` |
| display / text | Inter / Inter (mono: system) |
| type | factor 0.95, weight 600, tracking -1, line-height 1.2 |
| shape | radius card 8 / chip 6 / pill 999, border 1px, shadow soft |
| image | radius chip, crop cover, tint none |
| art | grain, grid at 0.1 opacity |
| best for | og, linkedin-post, github-readme, linkedin-carousel-page |

**Do**

- Leave at least a third of the canvas empty, and put the emptiness where the eye lands last.
- Separate with a hairline rather than a box: one 1px line does the work of a panel.
- Keep the type to two sizes plus one caption, and trust the size contrast to carry the hierarchy.
- Use the accent as ink - this style has one colour and it is black.

**Don’t**

- Do not fill a panel with colour to make something important; remove what is around it instead.
- Do not use more than one accent, and do not use it for decoration.
- Do not add a shadow that reads as a shadow - at most a hint of one.

**Gates** (the render report checks these):

- At least 30% of the canvas is empty surface.
- Ink on surface is at least 12:1.
- No element is decorated without doing a job.

### `neon` — Neon

Night-city signage: a near-black surface, one electric accent that glows, display type set tight and loud, and a procedural light source behind the composition rather than a photograph.

| | |
|---|---|
| swatch | `#05060a` `#0d1020` `#eaf2ff` `#9bb0d0` `#39ff88` `#ff2e88` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1.1, weight 700, tracking -1, line-height 1.05 |
| shape | radius card 14 / chip 10 / pill 999, border 1px, shadow glow |
| image | radius card, crop cover, tint accent at 0.22 (full scrim, screen) |
| art | glow, stars at 0.5 opacity |
| best for | github-social, x-post, linkedin-square, poster-a3 |

**Do**

- Put the glow BEHIND the composition - one light source, low opacity, never on top of the words.
- Use pure accents for small areas only: a rule, a chip, one word of the headline.
- Keep the muted ink blue-shifted so it reads as shadowed light rather than grey.
- Let the art layer be the photograph this design does not have, and keep it in the accent's hue.

**Don’t**

- Do not glow the body copy, and never outline type - legibility dies first.
- Do not use two accents at full strength in the same composition.
- Do not put a light glow on a light panel; this style is night.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 against the panel it sits on.
- The glow is behind every text node, never over one.
- No more than two accent hues on the canvas.

### `gradient` — Gradient

A saturated two-stop wash as the whole background: the composition sits on colour rather than in a frame, with generous rounding and white type that holds against the darkest part of the wash.

| | |
|---|---|
| swatch | `#1b0b3a` `#2a1257` `#ffffff` `#c9b8f0` `#ff6bd6` `#ffd166` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1.08, weight 700, tracking -1.5, line-height 1.1 |
| shape | radius card 22 / chip 14 / pill 999, border 0px, shadow soft |
| image | radius card, crop cover, tint surface at 0.5 (bottom scrim, multiply) |
| art | mesh, rings at 0.45 opacity |
| best for | github-social, linkedin-post, linkedin-carousel-page, og |

**Do**

- Keep the wash to two stops of ONE hue family; a rainbow is a different style.
- Place type over the darker end of the gradient, and check the render rather than trusting the numbers.
- Round panels generously - the softness is what separates this from a flat colour.
- Use the accent for one chip or rule, and let the gradient carry the colour budget.

**Don’t**

- Do not put the headline across the lightest band of the wash.
- Do not add a second gradient at another angle.
- Do not use a hard edge or a 0 radius anywhere - blunt shapes fight the wash.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 against the darkest area behind it.
- Both gradient stops are the same hue family.
- No text sits across a hard stop.

### `glass` — Glass

Layered translucent panels on a dark surface with thin light hairlines and soft shadows. This language has no blur, so the glass is honesty rather than a filter: translucency, a hairline and a shadow do the work, and nothing pretends to be frosted.

| | |
|---|---|
| swatch | `#0a1018` `#16202c` `#f2f7ff` `#a7b6c6` `#7ad7ff` `#c9a7ff` |
| display / text | Inter / Inter (mono: system) |
| type | factor 1, weight 600, tracking -0.5, line-height 1.2 |
| shape | radius card 18 / chip 12 / pill 999, border 1px, shadow soft |
| image | radius card, crop cover, tint surface at 0.35 (bottom scrim, normal) |
| art | waves, mesh at 0.3 opacity |
| best for | github-social, og, linkedin-post, linkedin-company-banner |

**Do**

- Give every panel the same hairline and the same radius; the family resemblance is the style.
- Keep panels one step of lightness off the surface, never a different hue.
- Use the soft shadow to lift a panel and nothing else - one shadow per design.
- Set the display size close to the body size and let the spacing carry the hierarchy.

**Don’t**

- Do not claim a blur: the language has none, and a style that pretends will not survive a render.
- Do not use more than two panel levels.
- Do not put the accent on a panel fill - it belongs on a hairline, an icon or one word.

**Gates** (the render report checks these):

- Every panel carries a hairline.
- Body contrast is at least 4.5:1 on the panel it sits on.
- At most one soft shadow in the composition.

### `bento` — Bento

A light page of rounded cards in a grid, each holding one idea with its own label: the composition reads as a set of tidy boxes, and the design's job is to decide which box is biggest.

| | |
|---|---|
| swatch | `#f6f7f9` `#ffffff` `#17191f` `#525a68` `#2f6bff` `#ffe8cc` |
| display / text | Inter / Inter (mono: system) |
| type | factor 1, weight 600, tracking -0.8, line-height 1.25 |
| shape | radius card 16 / chip 10 / pill 999, border 1px, shadow soft |
| image | radius card, crop cover, tint none |
| art | grid, mesh at 0.2 opacity |
| best for | github-readme, og, linkedin-square, linkedin-carousel-page |

**Do**

- Make one card clearly the biggest and give it the headline; equal boxes read as a table.
- Give every card the same radius, hairline and inner padding.
- Put the label inside the card it belongs to, never beside it.
- Keep the gaps even and the outer margin larger than the inner gaps.

**Don’t**

- Do not mix more than two card sizes.
- Do not centre the text inside a card; the grid wants a left edge.
- Do not use the accent as a card fill for more than one card.

**Gates** (the render report checks these):

- One card is at least twice the area of any other.
- Every card shares one radius and one hairline.
- The outer margin is larger than the gaps between cards.

### `retro` — Retro

Printed ephemera: a warm cream stock, two inks, small hard offsets instead of shadows, and a texture that admits it was printed - the palette of a 1970s poster rather than a screen.

| | |
|---|---|
| swatch | `#f5ecd9` `#fff8e8` `#221a10` `#5f5138` `#c2451e` `#e8a33d` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1.02, weight 700, tracking 0, line-height 1.15 |
| shape | radius card 2 / chip 2 / pill 999, border 2px, shadow hard |
| image | radius chip, crop cover, tint warm at 0.28 (full scrim, multiply) |
| art | grain, stripes at 0.3 opacity |
| best for | poster-a3, linkedin-square, github-social, x-post |

**Do**

- Keep to two inks plus the cream stock, and let the cream be the lightest thing on the page.
- Use the warm accent for one band, rule or chip - it is the second colour, not a third.
- Offset a panel by a few pixels with a hard shadow in ink to make it feel letterpressed.
- Let the texture sit at a low opacity so it reads as stock rather than noise.

**Don’t**

- Do not use a cool grey anywhere - it kills the warmth instantly.
- Do not round corners beyond 2px.
- Do not use a soft or coloured shadow; the offset is always ink.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 on the cream stock.
- The ink offset is visible at 100% and never blurred.
- No cool-toned colour is present.

### `terminal` — Terminal

A phosphor screen: black-green ground, one luminous accent, everything monospaced, and a faint grid that reads as scanlines without drawing any.

| | |
|---|---|
| swatch | `#0b0f0b` `#101710` `#c9ffd6` `#7fb68c` `#39ff88` `#ffb000` |
| display / text | system / Inter (mono: system) |
| type | factor 1, weight 700, tracking 0, line-height 1.3 |
| shape | radius card 0 / chip 0 / pill 2, border 1px, shadow none |
| image | radius 0, crop cover, tint accent at 0.18 (full scrim, screen) |
| art | grid, circuit at 0.25 opacity |
| best for | github-readme, og, github-social, linkedin-post |

**Do**

- Set the display type in the mono family - the fixed advance is the whole character.
- Use the luminous accent for prompts, carets, one rule and one word.
- Keep the ink green and dim; a bright white destroys the phosphor illusion.
- Let the grid show faintly behind the type and never in front of it.

**Don’t**

- Do not use a rounded card or a soft shadow.
- Do not use more than one accent hue; amber is a warning, not a second brand.
- Do not set long body copy in mono - it is for the headline and the labels.

**Gates** (the render report checks these):

- The display family is monospaced.
- Body contrast is at least 4.5:1 on the dark ground.
- No rounded corner above 2px and no soft shadow.

### `corporate` — Corporate

The safe, competent look a serious announcement wants: white ground, a confident blue, a cool grey for the second voice, blueprint texture at the edge, and nothing that could date.

| | |
|---|---|
| swatch | `#ffffff` `#f4f7fb` `#0f1b2d` `#4a5a73` `#1f5fd0` `#f2a93b` |
| display / text | Inter / Inter (mono: system) |
| type | factor 1, weight 600, tracking -0.5, line-height 1.22 |
| shape | radius card 10 / chip 8 / pill 999, border 1px, shadow soft |
| image | radius chip, crop cover, tint none |
| art | blueprint, grid at 0.22 opacity |
| best for | linkedin-company-banner, linkedin-post, og, github-readme |

**Do**

- Say one thing in the headline and let a supporting line name the audience or the date.
- Use the blue for structure - a rule, a chip, the CTA - and the warm tone at most once.
- Keep the second voice in the cool grey; it is the 'less important' colour by design.
- Align everything to one left edge and one baseline grid.

**Don’t**

- Do not use a saturated second hue beside the blue.
- Do not set the headline lower than 3x the body size.
- Do not decorate an empty area - the blueprint texture is the only ornament allowed.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 on white.
- The headline is at least 3x the body size.
- At most two colours plus the neutrals.

### `vibrant` — Vibrant

Loud, playful and generous with colour: a deep plum ground, two saturated accents that can share the canvas, pill shapes everywhere, and a full-bleed ring pattern behind the words.

| | |
|---|---|
| swatch | `#150b2e` `#241247` `#ffffff` `#c6b6e8` `#ff4d6d` `#ffc93c` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 1.12, weight 700, tracking -1, line-height 1.1 |
| shape | radius card 24 / chip 999 / pill 999, border 0px, shadow soft |
| image | radius card, crop cover, tint accent at 0.3 (bottom scrim, overlay) |
| art | rings, mesh at 0.5 opacity |
| best for | linkedin-square, github-social, x-post, linkedin-carousel-page |

**Do**

- Let one accent lead and the second one punctuate - a chip, a rule, a single glyph.
- Make every interactive-looking shape a pill; hard corners kill the energy.
- Set the headline large and slightly tight, and break it where the rhythm wants.
- Give the art layer real presence, then keep the accents off the type.

**Don’t**

- Do not use three accents; two is the ceiling.
- Do not set body copy in an accent colour - it belongs in the muted ink.
- Do not mix a pill and a square corner in the same composition.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 on the plum ground.
- At most two accent hues are present.
- Every chip and card corner is a pill or a large radius.

### `paper` — Paper

A written page rather than a screen: warm off-white stock, near-black ink, one earthy accent, small radii and a texture that reads as fibre - the calmest style in the library.

| | |
|---|---|
| swatch | `#faf7f0` `#ffffff` `#1b1917` `#5c564c` `#8a5a2b` `#c98b4b` |
| display / text | Space Grotesk / Inter (mono: system) |
| type | factor 0.98, weight 600, tracking 0, line-height 1.25 |
| shape | radius card 3 / chip 3 / pill 999, border 1px, shadow none |
| image | radius chip, crop cover, tint warm at 0.3 (bottom scrim, multiply) |
| art | grain, waves at 0.22 opacity |
| best for | poster-a3, og, linkedin-carousel-page, github-readme |

**Do**

- Keep the margins wide and the measure short; a page is read, not scanned.
- Use the earthy accent for a rule, a number or a single word - it is ink, not paint.
- Let the stock texture carry the warmth so no colour has to.
- Separate sections with a hairline and space rather than with panels.

**Don’t**

- Do not use pure white or pure black; the warmth is the style.
- Do not add a shadow - paper does not float.
- Do not use more than one accent, and never as a large fill.

**Gates** (the render report checks these):

- Body contrast is at least 4.5:1 on the stock.
- No pure #FFFFFF surface and no pure #000000 ink.
- The accent covers less than 10% of the canvas.
