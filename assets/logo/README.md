# The vn-code mark

![The vn-code brand sheet](contact-sheet.png)

A girdled crystal, shared with every application in the vecnode/vn suite. The lines are
vn-launcher's; the colour inside is vn-code's.

The suite keeps one mark and changes one thing per application: the **inlay**, the colour that
fills the facets. vn-launcher leaves it transparent. vn-ranger fills it with ember. vn-code
fills it with jade.

This file is the quick guide. [`BRAND.md`](BRAND.md) is the design record - construction,
clear space, minimum sizes, contrast and usage rules. [`MANIFEST.toml`](MANIFEST.toml) is the
machine-readable one: every palette value and the SHA-256 of every file here.

## Geometry

The mark lives on the same 24-unit grid as vn-launcher and vn-ranger, so the three cannot
drift apart:

- a hexagon with vertices at `(12,2.8) (20.8,7.4) (20.8,16.6) (12,21.2) (3.2,16.6) (3.2,7.4)`;
- a crown ridge `(3.2,7.4) → (12,12) → (20.8,7.4)`;
- a spine `(12,2.8) → (12,21.2)`;
- a girdle `(12,15.4) → (3.2,16.6)` and `(12,15.4) → (20.8,16.6)`;
- a stroke of `2.914` units, round caps and round joins.

Every endpoint sits on a hexagon vertex or on the spine, which is what keeps the facets
meeting cleanly instead of crossing. The inlay is a single hexagon fill under the linework, so
the ridges stay crisp and the facets read as one crystal rather than six coloured tiles.

## The jade

| Token | Value | Use |
|---|---|---|
| Jade highlight | `#74CAA3` | Top of the inlay gradient |
| Jade | `#1FA96B` | The application colour |
| Jade deep | `#198856` | Bottom of the inlay gradient |
| Ink | `#0B0D10` | Linework on light backgrounds; the application tile |
| Paper | `#FFFFFF` | Linework on dark backgrounds |

The gradient is vertical, `#74CAA3 → #1FA96B` at 55% `→ #198856`, so the crown catches the
light and the base sits deeper. The three stops are ember's tonal ladder solved for the same
relative luminance and hue-rotated to green, which is why the ratios below are vn-ranger's
numbers: the application icon's white ridges sit on that crown, and a brighter mint would
lose them.

Ink on jade is 6.44:1 and is the pair used for small text. White on jade is 3.02:1 and is only
for large text and icons. [`BRAND.md`](BRAND.md) has the full table.

## Which file to use

| Family | For |
|---|---|
| `vn-code.svg`, `vn-code-<size>.png` | Light backgrounds. Ink linework, jade inlay, transparent elsewhere. |
| `vn-code-white.svg`, `vn-code-white-<size>.png` | Dark backgrounds. White linework, jade inlay, transparent elsewhere. |
| `vn-code-app.svg`, `vn-code-app-<size>.png` | An application icon: the mark on the suite's black tile, with white ridges. |

## Sizes

16, 24, 32, 48, 64, 128, 256, 512 and 1024 pixels square.

**Prefer the SVG** wherever the target accepts it. It scales without resampling and is the
only file here that belongs in a print job or a store listing. The PNGs exist because most
places still want one.

Each PNG was rendered at its exact size from the SVG, not downscaled from a master. That
matters most at the bottom of the range, where resampling a 1024 down to 16 turns a 2.9-unit
stroke into a grey smear.

## Below about 32 pixels

The faceting costs legibility as the size drops. At 16 pixels the bare mark reads as a green
blob with dark notches - about as much as any six-line mark can say at that size. Where a
16-pixel icon has to be recognisable, use `vn-code-app-16.png`: the tile gives the eye a
solid silhouette to hold on to, and the jade gives it a colour to find.

## The application icon

The tile is 1024 × 1024 with a **308 px** corner radius; the crystal is scaled **22.73×** and
translated **239.25 px** so its visible bounds are about 468 × 486 px, centred. The tile is
the suite's black, not the jade. An icon has to hold its own against whatever is behind it: a
bare dark glyph disappears on a dark taskbar and a bare light one on a light taskbar, whereas
a black tile with a white crystal and a jade inlay reads on both.

## The suite rule

**Same crystal, one colour per application, no other variants.** The mark is a suite
identifier, not a per-project illustration. A new vecnode/vn application gets the same
geometry and a new inlay colour; it does not get a new shape, a rotation, an outline variant
or a gradient in a different direction.

## Regenerating

The geometry lives in `scripts/tools/logo/marks.mjs`, and everything here except this file
and `BRAND.md` is generated from it:

```sh
npm run logo              # the SVGs, the 27 PNGs, the sheet and MANIFEST.toml
npm run logo -- --check   # verify what is on disk; writes nothing
```

It rasterises with Chrome or Chromium and needs no npm package and no network. Do not edit a
file in this directory by hand: the next `npm run logo` would overwrite it, and `--check`
would fail first.

## Licence

AGPL-3.0-only, like the rest of the repository. The mark is original vecnode work and
contains no third-party asset.
