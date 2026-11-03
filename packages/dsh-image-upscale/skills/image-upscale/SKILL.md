---
name: image-upscale
description: Make a small image big without making it worse, using the machine's own Python and torch with Real-ESRGAN through the upscale_* tools - check the engine with upscale_info, enlarge one image with upscale_image (scale or target_width, and the answer names the model, device, ms and bytes), run a whole folder from a JSON manifest with upscale_batch (dry run first, existing outputs skipped), and fetch a model with upscale_fetch_weights only after confirming its name. Covers which model suits what, why a logo must not go through a model trained on photographs, and the srcset recipe for a site whose images are 1x.
whenToUse: Use when an image is too small for where it is drawn - a 300px product photograph in a card that a 2x screen stretches, a thumbnail that looks soft on a retina display, a marketing asset that needs to be twice its size - or when someone says "upscale this", "make this image bigger", "it looks blurry on my phone", "these images are low resolution", or asks to add 2x variants to a static site.
---

# Enlarging an image with a real model

Four tools over one engine. **Check first, enlarge second, and never replace the
original** — this row writes new files on purpose.

| question | tool |
|---|---|
| can this machine upscale at all, and which models are here? | `upscale_info` |
| make this one image bigger | `upscale_image` |
| do a whole folder from a list | `upscale_batch` |
| the model is not on disk yet | `upscale_fetch_weights` |

## The order to call them in

1. **`upscale_info`.** It answers in one paragraph: the Python, the torch, CUDA
   on which GPU, and every model that is `ready` (on disk) or `absent`. If it
   starts with "No usable Python with torch", nothing else will work and the
   answer already says what the engine needs. Never guess the device: a CUDA
   answer is a 300 ms job, a CPU answer is the same job in seconds.
2. **`upscale_fetch_weights` without `confirm`** when the model you need is
   `absent`. It tells you the size and the URL and downloads nothing. Then call
   it again with `confirm: "<model>"` — the exact name, or it refuses. That is
   the only network call in this row.
3. **`upscale_image`** for one file. Give `target_width` when you know the box
   the image is drawn in (that is the normal case on a website), or `scale` when
   you want a multiple of what exists.
4. **`upscale_batch`** for many. It is a **dry run by default**: it resolves every
   path and refuses the ones that would clobber an original, then you pass
   `dry_run: false`. Existing outputs are skipped, not replaced, so an interrupted
   batch is safe to re-run.

## Choosing the model

| model | size | use it for |
|---|---|---|
| `realesr-general-x4v3` | 4.7 MB | quick work on photographs, when speed matters more than the look |
| `realesr-animevideov3` | 2.4 MB | clean line art and illustration |
| `RealESRNet_x4plus` | 67 MB | **the one that does not look generated.** Same network, no adversarial term |
| `RealESRGAN_x4plus` | 67 MB | hard photography — noise, heavy compression, soft focus. Slower |
| `RealESRGAN_x2plus` | 67 MB | the same, when 2x is all that is needed |

**The "AI look" is the GAN, and the answer is a model without one.** The two
`RealESRGAN_*` models and the compact `x4v3` were trained with an adversarial term,
which is what produces the two artefacts people notice: flat areas that go waxy and
letterforms that are *invented* rather than enlarged. `RealESRNet_x4plus` is the
same architecture trained only on reconstruction, so it enlarges what is there and
leaves the grain alone — visibly more like a photograph, and a little softer, which
is exactly what `sharpen` is for:

```
upscale_image { path, output, target_width, model: "RealESRNet_x4plus", sharpen: 0.45 }
```

Use the GAN models when the source is so degraded that detail has to be guessed
(a 20-year-old product shot with heavy JPEG noise), and expect to trade honesty for
sharpness. Use `sharpen` on a GAN output only if the result still looks soft: too
much on clean flats is what makes a picture look processed.

**A logo, an icon or a flat mark is the one case to think about first.** These
networks were trained on photographs. On a fine-stroke mark they can smear; on an
opaque mark over a plain background they often come out with cleaner edges than the
original — that was measured on two real logos, where the 2x version was visibly
better. Do one, look at it, then do the rest. **A file with an alpha channel is a
different answer**: the runner flattens alpha onto white, so a transparent logo loses
its transparency — get the source at a larger size instead (the SVG, the brand page).

**An SVG is not an image to enlarge** — it has no pixels to add. Rasterise it at
the size you need instead.

## The numbers mean something

Every `upscale_image` answer carries: input size → output size, the model, the
device, the milliseconds, the bytes. Quote them. "Upscaled" on its own is a
claim; `300×301 → 600×602, realesr-general-x4v3 on cuda, 2736 ms, 29 KB` is a
measurement. The tool says nothing about whether the result *looks* right —
that is a person's judgement, and on a photograph of a product it usually shows
in one comparison, not in a paragraph.

A 600 px output can be **smaller in bytes** than the 300 px original: an upscaled
image is smoother, and JPEG pays for sharp edges. Do not assume the file will
grow, and measure it before promising anything about page weight.

## A site whose images are all 1x

The pattern this row was built for. A card says `width="300"` and the file is
300 px wide, so a 2× screen stretches it and it looks soft:

1. enlarge the files to the **2× width** (300 → 600), keeping the same visual
   content and the same file name with a `-2x` suffix;
2. leave the `width`/`height` attributes alone — they describe the CSS box, not
   the file, and that is what keeps the layout from moving;
3. add `srcset="x.jpg 1x, x-2x.jpg 2x"`. A 1× screen keeps downloading the small
   file; only a 2× screen pays for the big one.

That last point is the whole reason to keep both files instead of replacing the
small one: replacing it makes every visitor pay for the retina copy.

## What it will not do

- **Replace an original.** The output must be a different path; the input file is
  never touched. `overwrite: true` exists for replacing a *previous output*, not
  the source.
- **Create a folder.** The output's parent must already exist — a typo must be an
  error, not an empty directory.
- **Work outside the workspace** with a relative path. Use an absolute path for
  anything elsewhere on the machine.
- **Enlarge an SVG**, or read a raw camera format. BMP, JPEG, PNG, WebP, TIFF and
  AVIF are what the engine decodes.
