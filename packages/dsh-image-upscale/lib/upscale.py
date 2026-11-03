"""Upscale one image with Real-ESRGAN, installing nothing.

Runs as a subprocess of the plugin (`lib/python.js`), always with an argv array
and never a shell. It reads one file, writes ANOTHER file (never the same one)
and prints a single JSON line.

Why this file exists instead of `import realesrgan`:

  - the installed `realesrgan` 0.3.0 is BROKEN against torchvision 0.17+
    (`ModuleNotFoundError: torchvision.transforms.functional_tensor`), and
    `basicsr` dies on the same import while loading the package;
  - the architectures we actually need (`basicsr.archs.*`) never call that
    function. The shim below puts the module back in `sys.modules` before the
    import: the smallest reversible remedy;
  - so the plugin uses the torch this machine already has, on CUDA when it is
    there, and asks nobody to run `pip install`.

Models (names as the official Real-ESRGAN release calls them):

  realesr-general-x4v3   4.7 MB  SRVGGNetCompact  the default: fast, good on photos
  realesr-animevideov3   2.4 MB  SRVGGNetCompact  video/anime, clean line art
  RealESRGAN_x4plus       64 MB  RRDBNet          hard photography, slower
  RealESRGAN_x2plus       64 MB  RRDBNet          when 2x is enough

Usage:
  python upscale.py --probe
  python upscale.py --input a.jpg --output b.jpg --scale 4 --target-width 600
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

MODELS = {
    'realesr-general-x4v3': {
        'family': 'srvgg', 'scale': 4, 'feat': 64, 'conv': 32, 'act': 'prelu',
        'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth',
        'bytes': 4_700_000,
    },
    'realesr-animevideov3': {
        'family': 'srvgg', 'scale': 4, 'feat': 64, 'conv': 16, 'act': 'prelu',
        'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth',
        'bytes': 2_400_000,
    },
    'RealESRGAN_x4plus': {
        'family': 'rrdb', 'scale': 4, 'blocks': 23,
        'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
        'bytes': 67_000_000,
    },
    'RealESRGAN_x2plus': {
        'family': 'rrdb', 'scale': 2, 'blocks': 23,
        'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
        'bytes': 67_000_000,
    },
    # ESRNet is the SAME network trained WITHOUT the adversarial term: no GAN, so
    # no invented texture and no waxy flats - the "AI look" people notice. Softer
    # than ESRGAN, which is why `--sharpen` exists beside it.
    'RealESRNet_x4plus': {
        'family': 'rrdb', 'scale': 4, 'blocks': 23,
        'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth',
        'bytes': 67_000_000,
    },
}

DEFAULT_MODEL = 'realesr-general-x4v3'
TILE = 512
TILE_MARGIN = 16
TILE_THRESHOLD = 1_400_000  # input pixels above which the image is tiled


def answer(**fields):
    """One JSON line on stdout, always â€” the caller reads nothing else."""
    print(json.dumps(fields, ensure_ascii=False))
    return 0 if fields.get('ok') else 2


def failure(code, message, **extra):
    return answer(ok=False, code=code, message=message, **extra)


def install_torchvision_shim():
    """Restore `torchvision.transforms.functional_tensor`, gone since 0.17."""
    import types
    if 'torchvision.transforms.functional_tensor' in sys.modules:
        return
    import torchvision.transforms.functional as functional
    shim = types.ModuleType('torchvision.transforms.functional_tensor')
    shim.rgb_to_grayscale = functional.rgb_to_grayscale
    sys.modules['torchvision.transforms.functional_tensor'] = shim


def weights_dir(given: str | None) -> Path:
    if given:
        return Path(given).expanduser()
    # The plugin always passes --weights-dir; this fallback is for a person
    # running the runner by hand, and it respects the same DSH_HOME the tools do.
    import os
    home = os.environ.get('DSH_HOME') or str(Path.home() / '.dsh')
    return Path(home) / 'dsh-image-upscale' / 'weights'


def weights_file(model: str, directory: Path) -> Path:
    return directory / (model + '.pth')


def load_model(name: str, weights: Path, device: str):
    import torch
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from basicsr.archs.srvgg_arch import SRVGGNetCompact

    if name not in MODELS:
        raise ValueError('unknown model: ' + name)
    spec = MODELS[name]
    if spec['family'] == 'srvgg':
        model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=spec['feat'],
                                num_conv=spec['conv'], upscale=spec['scale'],
                                act_type=spec['act'])
    else:
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                        num_block=spec['blocks'], num_grow_ch=32, scale=spec['scale'])
    try:
        state = torch.load(weights, map_location='cpu', weights_only=True)
    except Exception:
        # An older checkpoint may carry objects the strict mode refuses. The file
        # comes from this plugin's own cache, not from an arbitrary source.
        state = torch.load(weights, map_location='cpu')
    key = 'params_ema' if 'params_ema' in state else ('params' if 'params' in state else None)
    if key is None:
        raise ValueError('the weights file has neither "params" nor "params_ema": ' + str(weights))
    model.load_state_dict(state[key], strict=True)
    model.eval()
    return model.to(device)


def upscale_tensor(tensor, model, scale: int, tile: int):
    """Run the model, in tiles when the image is too large for the memory."""
    import torch

    height, width = tensor.shape[-2], tensor.shape[-1]
    with torch.no_grad():
        if tile <= 0 or (height <= tile and width <= tile):
            return model(tensor).clamp(0, 1)
        out = torch.zeros((1, 3, height * scale, width * scale),
                          dtype=tensor.dtype, device=tensor.device)
        for top in range(0, height, tile):
            for left in range(0, width, tile):
                y0 = max(0, top - TILE_MARGIN)
                x0 = max(0, left - TILE_MARGIN)
                y1 = min(height, top + tile + TILE_MARGIN)
                x1 = min(width, left + tile + TILE_MARGIN)
                piece = model(tensor[:, :, y0:y1, x0:x1]).clamp(0, 1)
                # The part of the piece that belongs in the output, in output
                # coordinates: the margin exists to avoid seams, not to be kept.
                sy0 = (top - y0) * scale
                sx0 = (left - x0) * scale
                end_y = min(out.shape[-2], top * scale + (min(height, top + tile) - top) * scale)
                end_x = min(out.shape[-1], left * scale + (min(width, left + tile) - left) * scale)
                out[:, :, top * scale:end_y, left * scale:end_x] = piece[
                    :, :, sy0:sy0 + (end_y - top * scale), sx0:sx0 + (end_x - left * scale)]
    return out


def probe(directory: Path):
    info = {'ok': True, 'python': sys.version.split()[0], 'executable': sys.executable}
    try:
        import torch
        info['torch'] = torch.__version__
        info['cuda'] = bool(torch.cuda.is_available())
        info['gpu'] = torch.cuda.get_device_name(0) if info['cuda'] else None
    except Exception as error:
        info['ok'] = False
        info['torch'] = None
        info['message'] = 'torch does not import: ' + str(error)
    try:
        import torchvision
        info['torchvision'] = torchvision.__version__
    except Exception:
        info['torchvision'] = None
    try:
        install_torchvision_shim()
        import basicsr  # noqa: F401
        info['basicsr'] = True
    except Exception as error:
        info['basicsr'] = False
        info['basicsr_error'] = str(error)
    try:
        import PIL
        info['pillow'] = PIL.__version__
    except Exception:
        info['pillow'] = None
    info['weights_dir'] = str(directory)
    info['models'] = {name: weights_file(name, directory).is_file() for name in MODELS}
    info['default_model'] = DEFAULT_MODEL
    return answer(**info)


def open_image(path: Path):
    """Open an image and return it as RGB, with any alpha flattened onto white.

    An alpha channel is not what these models were trained to enlarge, and a
    white background is what a product photograph on a website uses. Flattening
    happens HERE, where `Image` is in scope: a palette image with transparency
    used to reach a branch in `to_tensor` that no longer had the import.
    """
    from PIL import Image, ImageOps
    image = Image.open(path)
    image.load()
    try:
        image = ImageOps.exif_transpose(image)
    except Exception:
        pass
    if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
        background = Image.new('RGB', image.size, (255, 255, 255))
        rgba = image.convert('RGBA')
        background.paste(rgba, mask=rgba.split()[-1])
        return background
    if image.mode != 'RGB':
        return image.convert('RGB')
    return image


def to_tensor(image):
    """An RGB image -> a [1,3,H,W] tensor in [0,1]."""
    import numpy as np
    import torch
    array = np.array(image).astype('float32') / 255.0
    return torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)


def save(image, destination: Path, fmt: str, quality: int, icc):
    extra = {'icc_profile': icc} if icc else {}
    destination.parent.mkdir(parents=True, exist_ok=True)
    if fmt == 'png':
        image.save(destination, format='PNG', optimize=True, **extra)
    elif fmt == 'webp':
        image.save(destination, format='WEBP', quality=quality, method=5, **extra)
    else:
        image.save(destination, format='JPEG', quality=quality, optimize=True,
                   progressive=True, subsampling=0 if quality >= 88 else 2, **extra)


def format_of(destination: Path, requested: str | None):
    if requested:
        return {'jpg': 'jpg', 'jpeg': 'jpg', 'png': 'png', 'webp': 'webp'}.get(requested.lower(), 'jpg')
    suffix = destination.suffix.lower().lstrip('.')
    return {'jpeg': 'jpg', 'png': 'png', 'webp': 'webp'}.get(suffix, 'jpg')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Upscale one image with Real-ESRGAN.')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--scale', type=int, default=0, help='final scale: 2..8')
    parser.add_argument('--target-width', type=int, default=0, help='final width in px')
    parser.add_argument('--model', default=DEFAULT_MODEL)
    parser.add_argument('--quality', type=int, default=86)
    parser.add_argument('--tile', type=int, default=0, help='0 = automatic')
    parser.add_argument('--sharpen', type=float, default=0.0,
                        help='0-1: unsharp mask after resizing, for a natural-looking result '
                             'from a non-adversarial model (RealESRNet)')
    parser.add_argument('--format')
    parser.add_argument('--weights-dir')
    parser.add_argument('--overwrite', action='store_true', help='replace an existing output')
    parser.add_argument('--dry-run', action='store_true', help='say what it would do')
    args = parser.parse_args(argv)

    directory = weights_dir(args.weights_dir)
    if args.probe:
        return probe(directory)
    if not args.input or not args.output:
        return failure('BAD_REQUEST', 'Both --input and --output are required.')
    source, destination = Path(args.input), Path(args.output)
    if not source.is_file():
        return failure('NOT_FOUND', 'No such input file: ' + str(source))
    if source.resolve() == destination.resolve():
        return failure('REFUSED', 'The output cannot be the input file: the original is never altered.')
    if destination.exists() and not args.overwrite and not args.dry_run:
        return failure('EXISTS', 'The output already exists: ' + str(destination) + '. Nothing is replaced without --overwrite.')
    if args.model not in MODELS:
        return failure('BAD_MODEL', 'Unknown model: ' + args.model + '. Available: ' + ', '.join(MODELS))
    weights = weights_file(args.model, directory)
    if not weights.is_file() and not args.dry_run:
        return failure('NO_WEIGHTS', 'No weights for ' + args.model + ' at ' + str(weights) +
                       '. Fetch them with `upscale_fetch_weights` (URL: ' + MODELS[args.model]['url'] + ').')

    try:
        import torch
        from PIL import Image  # noqa: F401
    except Exception as error:
        return failure('NO_TORCH', 'This Python has no torch: ' + str(error))

    fmt = format_of(destination, args.format)
    started = time.perf_counter()
    image = open_image(source)
    in_width, in_height = image.size
    model_scale = MODELS[args.model]['scale']

    target = args.target_width if args.target_width > 0 else 0
    scale = args.scale if args.scale > 0 else (3 if target and target / in_width > 2.5 else 2)
    if scale < 1 or scale > 8:
        return failure('BAD_SCALE', 'The scale must be between 1 and 8.')
    if args.dry_run:
        out_width = target or round(in_width * scale)
        out_height = max(1, round(in_height * (out_width / in_width)))
        return answer(ok=True, dryRun=True, **{'input': str(source)}, output=str(destination),
                      in_size=[in_width, in_height], out_size=[out_width, out_height],
                      model=args.model, weights=str(weights), format=fmt)

    try:
        install_torchvision_shim()
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        model = load_model(args.model, weights, device)
    except Exception as error:
        return failure('ENGINE', 'The model could not be loaded: ' + str(error))

    icc = image.info.get('icc_profile')
    tensor = to_tensor(image).to(device)
    tile = args.tile if args.tile != 0 else (TILE if in_width * in_height > TILE_THRESHOLD else 0)

    try:
        with torch.no_grad():
            output = upscale_tensor(tensor, model, model_scale, tile)
    except Exception as error:
        if 'out of memory' in str(error).lower() and device == 'cuda':
            torch.cuda.empty_cache()
            try:
                with torch.no_grad():
                    output = upscale_tensor(tensor, model, model_scale, TILE)
            except Exception as second:
                return failure('CUDA_OOM', 'Out of GPU memory even when tiled: ' + str(second))
        else:
            return failure('ENGINE', 'The model failed: ' + str(error))

    # Final geometry: a LANCZOS reduction after the model lands on the exact size
    # asked for without the stair-stepping a naive resize would leave.
    from PIL import Image, ImageFilter
    array = (output.squeeze(0).permute(1, 2, 0).cpu().numpy() * 255.0).round().clip(0, 255).astype('uint8')
    enlarged = Image.fromarray(array)
    wanted = target if target > 0 else (round(in_width * scale) if args.scale > 0 else 0)
    if wanted > 0 and enlarged.width != wanted:
        out_height = max(1, round(enlarged.height * wanted / enlarged.width))
        enlarged = enlarged.resize((wanted, out_height), Image.LANCZOS)

    # Unsharp mask, on the FINAL size. A non-adversarial model (ESRNet) is honest
    # about what it knows and comes out a little soft; a light mask restores the
    # micro-contrast of the original without the invented texture of a GAN.
    if args.sharpen > 0:
        amount = max(0.0, min(1.0, args.sharpen))
        enlarged = enlarged.filter(ImageFilter.UnsharpMask(
            radius=1.1, percent=int(70 + 130 * amount), threshold=3))

    save(enlarged, destination, fmt, args.quality, icc)
    elapsed = int((time.perf_counter() - started) * 1000)
    return answer(ok=True, **{'input': str(source)}, output=str(destination),
                  in_size=[in_width, in_height], out_size=[enlarged.width, enlarged.height],
                  model=args.model, model_scale=model_scale, device=device, tile=tile,
                  bytes=destination.stat().st_size, ms=elapsed, format=fmt)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)

