# Shader Workflow

Use this workflow when creating or revising procedural shaders.

## Contents

- [1. Visual Contract](#1-visual-contract)
- [2. First Visible Pass](#2-first-visible-pass)
- [3. Layering Order](#3-layering-order)
- [4. Debug Views](#4-debug-views)
- [5. Refinement Strategy](#5-refinement-strategy)
- [6. Review Checklist](#6-review-checklist)

## 1. Visual Contract

Before coding, define the image in operational terms:

- Subject: what the viewer should recognize first.
- Camera: orthographic, perspective, low angle, portrait, macro, wide heightfield, flythrough.
- Spatial model: 2D masks, heightfield, SDF scene, volumetric field, post effect.
- Materials: matte, waxy, stone, subsurface, glass, metal, mist, density-field, painted ink.
- Composition: silhouette, foreground/midground/background, focal contrast, empty space.
- Motion: camera drift, object motion, environmental motion, loop duration.

If the user only gives a vague style, choose a small concrete scene and state it.

## 2. First Visible Pass

Make the shader visible before making it clever:

1. Normalize coordinates with aspect preservation.
2. Draw a background gradient or sky.
3. Add one primitive, mask, SDF, or height profile.
4. Add a single color ramp or diffuse light.
5. Confirm orientation and scale with debug colors.

The first pass should answer: "Is this the right visual family?"

## 3. Layering Order

Build in layers that can be debugged independently:

1. Domain and camera.
2. Large forms.
3. Repetition or variation IDs.
4. Secondary forms and cuts.
5. Material assignment.
6. Lighting and shadows.
7. Atmosphere and depth cues.
8. Surface detail.
9. Color grade and antialiasing.

For 3D SDF scenes, keep geometry and material ID decisions close together. For 2D drawings, keep masks named by visual role rather than math trick.

## 4. Debug Views

Add cheap debug modes while developing:

- Raw SDF distance as grayscale.
- `abs(d)` contour bands for surface inspection.
- Normal direction as `0.5 + 0.5*n`.
- Material ID as flat colors.
- Raymarch step count heatmap.
- Height/noise octave contribution.
- Masks for foreground, midground, atmosphere, and highlights.

Gate them behind `#define DEBUG_MODE 0` using the pack's numbering (0 final, 1 distance, 2 normals, 3 ids,
4 steps, 5 masks, 6 lighting terms); see `composition-and-debugging.md`.

## 5. Refinement Strategy

Refine from global to local:

- Proportions before details.
- Silhouette before material texture.
- Value structure before hue variation.
- Lighting direction before shadow polish.
- One noise layer before many octaves.
- Performance after the visual target is clear.

Avoid adding noise to hide weak structure. Noise should express a material or natural process.

## 6. Review Checklist

Before finalizing:

- The code has a clear coordinate/camera section.
- Constants have visual names or comments where useful.
- Loops are bounded and have escape conditions.
- Main objects read in silhouette.
- Materials differ in value, roughness, or lighting response, not only hue.
- The shader has antialiasing for sharp masks or edges.
- Lighting happens in linear color; picked colors are decoded with `srgbToLinear`.
- The final color is exposed, tonemapped (per AA sample), then encoded once with `linearToSrgb` and dithered.
- No sine hashes, no `?:` on structs, no `#version`, no custom uniforms.
- The bundled shader passes `python3 scripts/glsl_tools.py check` (it compiles with glslangValidator when installed).
- The response explains the knobs a user can tune.
