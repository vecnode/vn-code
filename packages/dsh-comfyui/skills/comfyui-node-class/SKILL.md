---
name: comfyui-node-class
description: Writing a ComfyUI node class - the custom_nodes pack layout, INPUT_TYPES and the classic class contract (RETURN_TYPES, FUNCTION, CATEGORY, OUTPUT_NODE, IS_CHANGED, VALIDATE_INPUTS, INPUT_IS_LIST), the V3 schema API (IO.ComfyNode.define_schema with IO.Image.Input and IO.NodeOutput), returning previews, the web extension hook, and how to verify a class actually loaded with /object_info.
whenToUse: Creating a custom node, a node pack, or a Python class that runs inside ComfyUI; changing an existing node's inputs or return types; debugging a node that does not appear, appears without widgets, or raises during validation.
---

# A node is a class with a contract

ComfyUI finds node classes by importing every folder in `custom_nodes/` and
reading two dictionaries. Everything else is the class's own agreement about
what it takes and what it returns.

## The pack layout

```
ComfyUI/custom_nodes/my-pack/
  __init__.py          # exports the mappings - REQUIRED
  nodes.py             # or any modules you like
  requirements.txt     # pip-installable deps, if any
  pyproject.toml       # only needed to publish to the Registry
  web/                 # optional JS extensions
```

```python
# custom_nodes/my-pack/__init__.py
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"   # optional; omit it if you have no JS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
```

The folder name is the pack's identity. A pack that raises on import is skipped
with a traceback in the console and **none of its nodes appear** — so the first
check after adding code is always: did ComfyUI still start?

## The classic class

```python
# custom_nodes/my-pack/nodes.py
import torch


class ImageSolidTint:
    """Multiply every pixel by a colour, in one pass."""

    CATEGORY = "image/color"
    DESCRIPTION = "Multiplies an image batch by a solid colour, preserving alpha."
    SEARCH_ALIASES = ["tint", "colorize", "multiply"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "color": ("INT", {"default": 0xFF8844, "min": 0, "max": 0xFFFFFF, "step": 1, "display": "color"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "mode": (["multiply", "screen", "overlay"],),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "apply"
    OUTPUT_NODE = False

    def apply(self, image, color, strength, mode, mask=None):
        red = ((color >> 16) & 0xFF) / 255.0
        green = ((color >> 8) & 0xFF) / 255.0
        blue = (color & 0xFF) / 255.0
        tint = torch.tensor([red, green, blue], dtype=image.dtype, device=image.device)

        if mode == "screen":
            out = 1.0 - (1.0 - image) * (1.0 - tint)
        elif mode == "overlay":
            out = torch.where(image < 0.5, 2.0 * image * tint, 1.0 - 2.0 * (1.0 - image) * (1.0 - tint))
        else:
            out = image * tint

        out = image + (out - image) * strength
        if mask is not None:
            out = image + (out - image) * mask.unsqueeze(-1)
        return (out,)


NODE_CLASS_MAPPINGS = {"ImageSolidTint": ImageSolidTint}
NODE_DISPLAY_NAME_MAPPINGS = {"ImageSolidTint": "Solid Tint"}
```

The contract, member by member:

| Member | Required | Meaning |
|---|---|---|
| `INPUT_TYPES()` | yes, `@classmethod` | `{"required": {...}, "optional": {...}, "hidden": {...}}` |
| `RETURN_TYPES` | yes | a tuple of type strings; `()` for an output node |
| `RETURN_NAMES` | no | display names for the outputs (defaults to the types) |
| `FUNCTION` | yes | the name of the method to call |
| `CATEGORY` | no | the right-click menu path; `/` nests |
| `OUTPUT_NODE` | no | `True` makes it a node the graph can run *to* |
| `INPUT_IS_LIST` | no | receive whole lists instead of the first item |
| `OUTPUT_IS_LIST` | no | one tuple element per output is a list |
| `IS_CHANGED` | no | force re-execution (return a value that changes, or `NaN`) |
| `VALIDATE_INPUTS` | no | your own pre-flight check |
| `DESCRIPTION` | no | the tooltip text in the app |
| `SEARCH_ALIASES` | no | extra words the node search matches |
| `DEPRECATED` / `EXPERIMENTAL` | no | flags the app and `/object_info` report |

### Input declarations

| Declaration | Widget | Notes |
|---|---|---|
| `("INT", {"default": 1, "min": 1, "max": 4096})` | integer field | `step` controls the arrows |
| `("FLOAT", {"default": 0.5, "min": 0, "max": 1, "step": 0.01})` | number field | `round` rounds the stored value |
| `("STRING", {"default": "", "multiline": True})` | text box | `dynamicPrompts` enables `{a|b}` |
| `("BOOLEAN", {"default": True})` | toggle | |
| `(["a", "b", "c"],)` | dropdown | a LIST in the type position is a combo |
| `("IMAGE",)` or `("LATENT",)` | a socket only | no widget |
| `("INT", {"forceInput": True})` | a socket only | a widget made link-only |
| `(["euler", "dpmpp_2m"], {"default": "euler"})` | dropdown with a default | |
| `("INT", {"default": 0, "control_after_generate": True})` | integer + the fixed/increment/decrement/randomize control | **adds one value to `widgets_values`** |

That last row is the one that breaks saved workflows: adding
`control_after_generate` to an input shifts every later value in
`widgets_values`, so every graph saved before the change re-opens with wrong
values. Do not add it to an existing node; add a new node instead.

`"hidden"` inputs are supplied by the server and never appear in a prompt:

```python
INPUT_TYPES_HIDDEN = {"hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"}}
```

### Returning more than tensors

A node may return a `ui` payload — that is how `Save Image` makes its preview
appear in the app — together with its `result`:

```python
def save(self, images, filename_prefix="ComfyUI"):
    path = f"{filename_prefix}_00001_.png"
    return {"ui": {"images": [{"filename": path, "subfolder": "", "type": "output"}]}, "result": ()}
```

### The two hooks worth knowing

```python
@classmethod
def IS_CHANGED(cls, image, color):
    # Re-run whenever the input hash changes; return float("NaN") to always re-run.
    return f"{image.shape}-{color}"

@classmethod
def VALIDATE_INPUTS(cls, image, color, strength):
    if not 0.0 <= strength <= 1.0:
        return f"strength must be between 0 and 1, got {strength}"
    return True
```

`VALIDATE_INPUTS` returns `True` or a message string, which becomes
`custom_validation_failed` in the `/prompt` body. Its arguments must be a subset
of the node's declared inputs; a special `input_types` argument receives the
types of what is actually wired in.

## The V3 schema API

Newer core nodes declare the same contract as data instead of dictionaries. It
is the same engine — `/object_info` reports both in one shape.

```python
from comfy_api.latest import IO


class RepeatImageBatch(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RepeatImageBatch",
            display_name="Repeat Image Batch",
            category="image/batch",
            search_aliases=["duplicate image", "clone image"],
            inputs=[
                IO.Image.Input("image"),
                IO.Int.Input("amount", default=1, min=1, max=4096),
                IO.Combo.Input("mode", options=["repeat", "tile"], default="repeat"),
            ],
            outputs=[IO.Image.Output()],
        )

    @classmethod
    def execute(cls, image, amount, mode) -> IO.NodeOutput:
        return IO.NodeOutput(image.repeat((amount, 1, 1, 1)))


NODE_CLASS_MAPPINGS = {"RepeatImageBatch": RepeatImageBatch}
NODE_DISPLAY_NAME_MAPPINGS = {"RepeatImageBatch": "Repeat Image Batch"}
```

Useful pieces of `IO`: `Schema(..., is_output_node=True, hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo])`,
`IO.Image/Mask/Latent/Audio/Video/Conditioning/Model/Clip/Vae.Input(...)`,
`IO.Combo.Input(..., options=[...])`, `IO.MatchType` for "anything", and
`IO.NodeOutput(value)` or `IO.NodeOutput(ui=...)`.

## Verify the class actually loaded

The console saying nothing is not proof. Ask the server:

```bash
curl -s "http://127.0.0.1:8188/object_info/ImageSolidTint"
```

An empty `{}` means the class is not there: the pack failed to import, or the
server has not been restarted since you wrote it, or `NODE_CLASS_MAPPINGS` does
not contain that key.

Then check the three things a mapping can get wrong without an error:

1. **the widgets are there** — `input_order.required` names your inputs in the
   order the app shows them;
2. **the outputs line up** — `output` and `output_name` match `RETURN_TYPES` and
   `RETURN_NAMES`;
3. **a two-node graph runs** — your class feeding `Save Image`, queued once.

With this pack: `comfy_nodes` action=node node=ImageSolidTint prints exactly the
catalog entry the server reports, which is the same thing the app draws from.

## A node that fails, and why

| Symptom | Cause |
|---|---|
| the class never appears | the pack raised on import (check the console), or the server was not restarted |
| it appears with no widgets | `INPUT_TYPES` is not a `@classmethod`, or returns the wrong shape |
| `KeyError` on a widget | the app sent a value the function signature does not accept |
| `custom_validation_failed` | your `VALIDATE_INPUTS` returned a string — read it, it is the message |
| it re-runs every time | no `IS_CHANGED`, which is correct but slow; add one |
| it runs once and then returns the old value | `IS_CHANGED` returns the same value for different inputs |
| a tensor is on the wrong device | use `comfy.model_management.intermediate_device()` rather than `"cpu"` or `"cuda"` |
| a saved graph's values shifted | you added `control_after_generate` to an existing input |

Two habits that prevent most of them: **never mutate a default** (a `dict` or
`list` in `INPUT_TYPES` is shared by every execution) and **keep the input order
stable** once anyone has saved a workflow — the order IS the format.

## A web extension, in one paragraph

`WEB_DIRECTORY = "./web"` plus a `web/js/my-extension.js` that calls
`app.registerExtension({ name: "my-pack", async beforeRegisterNodeDef(nodeType, nodeData) { ... } })`
is how a node draws something custom on the canvas. It is optional, it is
frontend JavaScript rather than Python, and it cannot change what the server
executes — only how the node looks and what it offers. Ship it only if the node
needs it.
