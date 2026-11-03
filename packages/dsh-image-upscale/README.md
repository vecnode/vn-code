# dsh-image-upscale (alpha.1)

**The agent can make a small image big without making it worse.** Core DSH has no
upscaler, and doing it by hand means a shell command that downloads a wheel, a
model and 2 GB of CUDA that the machine may already have. This is one host row
with four tools over **Real-ESRGAN**, run through the Python and the torch this
machine already has. Nothing is installed, no engine is bundled, and nothing is
replaced: every call produces a NEW file and says what it cost.

## What it adds

- **`upscale_info`** — is there a Python with torch here, is CUDA there, which
  GPU, which models are on disk. Never writes, never touches the network. Ask it
  first when an upscale fails.
- **`upscale_image`** — one image in, one new image out. Geometry is `scale`
  (2-8) or `target_width` in pixels; the model runs at its own 4x and the result
  is reduced with LANCZOS, which is why a 300 px product photograph becomes a
  clean 600 px file rather than a soft one. `RealESRNet_x4plus` with
  `sharpen: 0.45` is the route that does **not** look generated: same network
  without the adversarial term, so no invented texture, and an unsharp mask for the
  softness that buys. The answer names the model, the device, the milliseconds and
  the bytes.
- **`upscale_batch`** — a JSON manifest of `{ input, output }` pairs, a **dry run
  by default**, existing outputs **skipped rather than replaced** (so an
  interrupted batch is simply run again), and a summary that names every file
  written, skipped or failed and why.
- **`upscale_fetch_weights`** — the only call that touches the network. It
  answers with the size, the URL and what the model is good for, and downloads
  nothing until `confirm` repeats the model's exact name. The file lands in
  `$DSH_HOME/dsh-image-upscale/weights/` through a temporary name and a rename,
  so an interrupted download never leaves a half model behind.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind | `dsh-image-upscale` / `image-upscale` |
| rows | one: `image-upscale` (host-only — no `dsh.client`, no route, no tab) |
| injects | `tools` |
| engines | the machine's own `python3` / `python` / `py -3` with `torch` (+ `basicsr` for the architectures); `DSH_PYTHON` overrides the choice |
| models | `realesr-general-x4v3` (4.7 MB), `realesr-animevideov3` (2.4 MB), `RealESRNet_x4plus` / `RealESRGAN_x4plus` / `x2plus` (67 MB) |
| deps | **none** — zero npm dependencies, no vendored engine, no download without `confirm` |

The probe imports torch, which costs seconds, so it is resolved **once per boot**
and cached; ten images pay for it once. The path policy is the pack's own,
duplicated because a bundle may not reach into another bundle's files: a
**relative** path resolves inside the conversation workspace through `realpath`
(a symlink out is refused), an **absolute** path is read as given, and an
**output** further requires that its parent folder already exists and is inside
the workspace — a typo must be an error, not an empty directory.

## Rules and limits

- **The original is never altered.** The output must be a different path, and an
  existing output is refused unless `overwrite: true` says so in words. Writing
  over the input is refused twice: here and in the runner.
- **The runner carries a four-line shim, and that is load-bearing.** The installed
  `realesrgan` 0.3.0 dies against torchvision 0.17+
  (`ModuleNotFoundError: torchvision.transforms.functional_tensor`), and
  `basicsr` dies on the same import while loading the package. The architectures
  we need never call that function, so `lib/upscale.py` puts the module back in
  `sys.modules` before the import instead of pinning torchvision or asking for a
  `pip install`.
- **Not every image is a photograph, and a logo is the case to think about.** These
  networks are trained on photographs: on a fine-stroke mark they can smear, while an
  opaque mark over a plain background often gets cleaner edges — measured on two real
  logos, where the 2x version was visibly better than the original. Do one, look at it,
  then do the rest. A file with an **alpha channel** is a different answer: the runner
  flattens alpha onto white, so a transparent logo would lose its transparency — get the
  source at a larger size instead. An SVG is not an image to enlarge: it has no pixels
  to add.
- **A weight file is a pickle.** The runner loads it with `weights_only=True` and
  falls back only for an older checkpoint, from this plugin's own cache. No
  checksum is published upstream for these files, and the fetch answer says so
  rather than implying a signature was verified.
- **Tiling is automatic**, not a setting a caller has to know: above ~1.4 MP the
  image is processed in 512 px tiles with a 16 px margin, and a CUDA
  out-of-memory on a large image is retried tiled before it is reported.
- **Not claimed:** anything about *quality* beyond the numbers. "Upscaled" is a
  measurement (pixels, model, device, ms, bytes); whether the result looks right
  is a person's judgement, and the tools do not pretend otherwise.

## Verify

```
node --check packages/dsh-image-upscale/lib/index.js
node --check packages/dsh-image-upscale/lib/tools.js
node --check packages/dsh-image-upscale/lib/python.js
node --check packages/dsh-image-upscale/lib/paths.js
npm run check            # in packages/dsh-image-upscale
```

The check proves the pure decisions (a manifest turned into jobs or into
reasons, the argv one image costs, the sentence a failed run produces), the file
policy (never onto the input, never over an existing output without `overwrite`,
never outside the workspace), the tool surface, and — on a host with torch **and**
the weights — a real render of a 32×32 BMP written by the check itself, whose
output PNG's own IHDR is read back. A host without either SKIPS the render
assertions loudly and still exits 0.

## Install

```
scripts/setup/install-all.ps1 -Plugin image-upscale     # Windows
scripts/setup/install-all.sh --plugin image-upscale     # macOS / Linux
```

The installer discovers any `packages/*` whose `package.json` carries
`dsh.bundle`, and `dsh-vn-master` must stay the profile's last bundle.

## Using it on a website that predates responsive images

The pattern that made this row: a card declares `width="300"` and the file is
300 px wide, so a 2× screen stretches it. Enlarge to 600 px, keep the `width`
attribute at 300 (it is the CSS box, not the file), and add
`srcset="x.jpg 1x, x-2x.jpg 2x"` — a 1× screen still downloads the small file,
and only a 2× screen pays for the big one.
