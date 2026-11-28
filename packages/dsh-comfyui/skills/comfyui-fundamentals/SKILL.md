---
name: comfyui-fundamentals
description: The ComfyUI mental model - a graph is a program, node = function, wire = typed data, models never touch pixels, a prompt is a vector, the seed is the only randomness, a LoRA is a patch - plus the latent arithmetic, the model folders, the sampler dials and how to read a ComfyUI error. Load this before building or debugging any ComfyUI graph, and before deciding which example to start from.
whenToUse: The user asks for a ComfyUI workflow, image, video or audio generation, asks why a graph is slow or gives a bad image, needs the numbers behind steps/cfg/sampler/resolution, or is new to ComfyUI and needs the model of how it works before touching a node.
---

# ComfyUI in one page, then the details

ComfyUI is a graph editor for a diffusion engine. Nothing about it is magic and
nothing about it is a menu: a workflow is a file, a render is a queue item, and
every failure is one of about six things. Learn the six and the app stops being
a box of buttons.

## The five ideas

1. **A graph is a program.** A node is a function with typed inputs and typed
   outputs; a wire is a value passed between them. The queue executes the graph
   every time you press Run, from the nodes that have no inputs towards the
   nodes marked as OUTPUT. Nothing is "applied" to a document - the document is
   the program.
2. **Models never touch pixels.** An image is decoded to a `LATENT` by a `VAE`,
   the sampler works in that latent space, and a second `VAE` pass decodes it
   back. Audio has latents too. That is why `Empty Latent Image` and
   `VAE Decode` exist at all.
3. **A prompt is a vector, not text.** `CLIP Text Encode` turns a string into
   `CONDITIONING` - a stack of vectors. The negative prompt is a *second*
   vector, and the sampler is told to move away from it. That is what
   classifier-free guidance (`cfg`) scales.
4. **The seed is the only randomness.** Same graph, same seed, same sampler,
   same model on the same machine gives the same image. Change the seed and
   everything else can stay identical.
5. **A LoRA is a patch, not a model.** 135 MB can turn a 25-step model into a
   4-step one because it plugs into the `MODEL` and `CLIP` wires and modifies
   them in place. Everything in ComfyUI is a cartridge plugged into a wire.

## The types on the wires

| Type | What travels | Made by | Consumed by |
|---|---|---|---|
| `MODEL` | the denoiser | `Load Checkpoint`, `UNETLoader` | `KSampler`, `LoraLoader` |
| `CLIP` | the text encoder | `Load Checkpoint`, `CLIPLoader` | `CLIP Text Encode` |
| `VAE` | the encoder/decoder | `Load Checkpoint`, `VAELoader` | `VAE Encode`, `VAE Decode` |
| `CONDITIONING` | prompt vectors | `CLIP Text Encode` | `KSampler` positive/negative |
| `LATENT` | the compressed image | `Empty Latent Image`, `VAE Encode` | `KSampler`, `VAE Decode` |
| `IMAGE` | pixels, a batch | `VAE Decode`, `Load Image`, `Empty Image` | `Save Image`, `VAE Encode` |
| `MASK` | one channel | `Load Image` alpha, `SolidMask` | inpainting nodes |
| `AUDIO` | waveform + rate | `VAE Decode Audio`, `Load Audio` | `Save Audio`, `Create Video` |
| `VIDEO` | frames + audio | `Create Video` | `Save Video` |
| `*` | anything | — | a node that accepts any type |

A wire can only carry what its type says. Connecting `IMAGE` into a `LATENT`
input is refused before anything runs - by the app when you drag, and by
`/prompt` with `return_type_mismatch` when a file does it.

## The eight-node text-to-image graph

This is the whole of image generation. Everything else is a variant.

```
Load Checkpoint ─ MODEL ─┐
                 CLIP  ──┼─→ CLIP Text Encode (positive) ─ CONDITIONING ─┐
                 VAE   ──┼─→ CLIP Text Encode (negative) ─ CONDITIONING ─┤
                         │                                              ├─→ KSampler ─ LATENT ─→ VAE Decode ─→ Save Image
Empty Latent Image ──────┴────────────────────────── LATENT ─────────────┘         ▲
                                                                                   VAE
```

| Node | Why it is there |
|---|---|
| `Load Checkpoint` | one `.safetensors` holding the model, the text encoder and the VAE |
| `CLIP Text Encode` ×2 | the prompt and the anti-prompt, as vectors |
| `Empty Latent Image` | the canvas in latent space: 512×512 becomes 64×64×4 |
| `KSampler` | the loop that turns noise into a picture in N steps |
| `VAE Decode` | latent back to pixels |
| `Save Image` | writes to `output/` and is an OUTPUT node - the graph runs to it |

`Save Image` is the node the queue executes *for*. A graph with no output node
is refused with `prompt_no_outputs`, no matter how many other nodes it has.

## The latent arithmetic

- The VAE compresses by **8** in each direction: 512×512 → 64×64, and the latent
  has **4** channels. 512×512×3 = 786,432 pixel values becomes 16,384 latent
  values. That ratio is why the sampler is fast and why the VAE passes are not
  free.
- Every model family has a native resolution. SD 1.5 is 512, SDXL is 1024, and
  Z-Image-Turbo is 1024. Rendering SD 1.5 at 1024 does not give you a sharper
  picture; it gives you a repeated subject, because the model has only ever seen
  512-pixel compositions.
- **Cost goes with the pixel count, not the side.** Doubling both sides is 4×
  the work. 768×768 is 2.25 × 512×512, and that is why "a bit bigger" is a
  different class of wait.
- `Empty Latent Image` rounds to multiples of 8; a width of 500 becomes 496.

## The dials

| Dial | What it does | Practical range |
|---|---|---|
| `steps` | denoising iterations | 20-30 normal, **4** for LCM/turbo LoRAs, 6-8 for turbo checkpoints |
| `cfg` | how hard to follow the prompt | 6-8 normal, **1-2** for LCM/turbo (high cfg burns at 4 steps) |
| `sampler_name` | the integrator | `euler`, `dpmpp_2m`, `lcm`, `euler_ancestral` |
| `scheduler` | how the steps are spaced | `normal`, `karras`, `sgm_uniform` |
| `denoise` | how much of the input latent to destroy | 1.0 for text-to-image, 0.35-0.85 for image-to-image |
| `seed` | the only randomness | any integer; the same seed reproduces |

**Denoise is the image-to-image dial.** At 1.0 the input latent is ignored and
you get a new picture from the prompt; at 0.55 the composition survives and the
prompt repaints it; at 0.35 it is a filter. Below about 0.2, nothing changes.

## The model folders

A filename in a node's dropdown is a path relative to one folder in the ComfyUI
install. Putting a file in the wrong one is the most common `value_not_in_list`
there is.

| Folder | Holds | Loaded by |
|---|---|---|
| `models/checkpoints` | full checkpoints (model + CLIP + VAE) | `Load Checkpoint` |
| `models/loras` | LoRA patches | `Load LoRA` |
| `models/vae` | standalone VAEs | `VAE Loader` |
| `models/text_encoders` | CLIP/T5 encoders | `CLIP Loader` |
| `models/diffusion_models` | UNET-only files | `UNET Loader` |
| `models/controlnet` | ControlNet weights | `ControlNet Loader` |
| `models/upscale_models` | ESRGAN-style upscalers | `Upscale Model Loader` |
| `models/embeddings` | textual inversions | named inline in a prompt |

A subfolder shows up in the dropdown with a forward slash: a file at
`models/checkpoints/sd/v1-5.safetensors` is `sd/v1-5.safetensors`.

## The six failures, and what each actually means

| Message | What it means | The fix |
|---|---|---|
| `value_not_in_list` | a dropdown names a file that is not in that folder | move the file to the right `models/…` folder, or change the widget |
| `missing_node_type` | the graph names a class this server does not have | install the node pack (`comfy node install <registry-id>`), restart ComfyUI |
| `required_input_missing` | a node was saved before a field existed | open the graph in the app so it fills the field, then save |
| `return_type_mismatch` | a wire carries the wrong type | rewire; the types are on the sockets |
| `prompt_no_outputs` | no output node in the graph | add `Save Image` / `Save Video` / `Preview Image` |
| `OutOfMemoryError` | the GPU or RAM ran out | smaller image, smaller batch, `--cpu`, or close other apps |

Two more that look like failures and are not: `Device: cpu` in the console is
normal on a machine with no GPU (ComfyUI is using the CPU), and a prompt that
stays in the queue while another runs is the queue being serial - one model at a
time on one device.

## Run it on a CPU, in order

1. **512×512, batch 1.** Everything else is a measurement you have not made yet.
2. **Four steps with an LCM LoRA** (`lcm-lora-sd15`, 1.0 / 1.0, sampler `lcm`,
   scheduler `sgm_uniform`, cfg 1.5). Eight steps costs double, two is visibly
   worse.
3. **Plug in, best-performance power plan, close the browser** while it renders.
4. **Time the first image.** 10-25 s is normal for 512 px on a 2020 laptop. If
   it is 90 s, something thermal or a swap file is the cause, and you find it in
   the first minute rather than the last.

## The four builds

| Build | Graphs | Extra nodes over the eight |
|---|---|---|
| text → image | `smoke-image`, `text-to-image` | — |
| image → image | `image-to-image` | `Load Image`, `Upscale Image`, `VAE Encode`, denoise < 1 |
| text → audio | (audio checkpoint + `Empty Latent Audio`) | `VAE Decode Audio`, `Save Audio` |
| image + audio → clip | `smoke-video` | `Repeat Image Batch`, `Create Video`, `Save Video` |

`smoke-image` and `smoke-video` need **no model at all**: `Empty Image` makes a
coloured rectangle, and `Save Image` writes it. They are how you prove a machine
works before blaming a download.

## A minimal API prompt, to keep the shape in your head

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly-fp16.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "a lighthouse at dusk", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, text", "clip": ["1", 1] } },
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
  "5": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["1", 0], "seed": 42, "steps": 4, "cfg": 1.5,
      "sampler_name": "lcm", "scheduler": "sgm_uniform",
      "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0], "denoise": 1.0
    }
  },
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
  "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "dsh-comfyui/first" } }
}
```

`["1", 0]` means "node 1, output slot 0". The slots follow
`CheckpointLoaderSimple`'s `RETURN_TYPES = ("MODEL", "CLIP", "VAE")`, which is
why `["1", 1]` is the CLIP and `["1", 2]` is the VAE. `comfy_nodes` action=node
prints that order for any class; never guess it.

## What to read next

- The two file formats, and the trap in `widgets_values` →
  `comfyui-workflow-json`.
- The endpoints and the error body → `comfyui-api`.
- `comfy install`, `comfy launch`, `comfy run` → `comfyui-cli`.
- Writing a node of your own → `comfyui-node-class`.
- The project dialect this pack writes → `comfyui-projects`.
