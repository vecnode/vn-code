# Rendering Pipeline

The order of operations for a finished frame, and the library functions for each stage. Most "it looks off"
problems are pipeline problems: lighting in sRGB, tonemapping after gamma, averaging HDR samples, double encoding,
or fog that ignores the sky.

## Contents

- [Frame anatomy](#frame-anatomy)
- [Raymarching](#raymarching)
- [Lighting](#lighting)
- [Shadows, occlusion, thickness](#shadows-occlusion-thickness)
- [Color and materials](#color-and-materials)
- [Sky, fog and aerial perspective](#sky-fog-and-aerial-perspective)
- [Volumes](#volumes)
- [Exposure and tonemapping](#exposure-and-tonemapping)
- [Antialiasing and filtering](#antialiasing-and-filtering)
- [Performance checklist](#performance-checklist)

## Frame anatomy

```text
for each AA sample:
    camera ray -> march -> normal -> material -> lights (key, fill, bounce, specular) -> fog/atmosphere   [linear HDR]
    exposure, vignette, grain                                                                            [linear HDR]
    tonemap                                                                                               [linear 0..1]
average samples -> linearToSrgb (exactly once) -> ditherTPDF -> fragColor
```

```glsl
vec3 finishPixel(vec3 hdrSum, float samples, float exposure, vec2 fragCoord) {
    // hdrSum must already be tonemapped per sample; this averages, encodes once, then dithers.
    vec3 c = hdrSum / samples;
    return linearToSrgb(c) + ditherTPDF(fragCoord, iFrame);
}
```

Tonemap each sample before averaging: averaging raw HDR lets one sample that hits the sun dominate, so bright edges
stay aliased.

## Raymarching

- `raymarch(ro, rd, tmin, tmax, stepScale)` returns `vec3(t, materialId, steps)`, with `t = -1` on a miss.
- Clip `[tmin, tmax]` analytically before marching: `iBox` / `iSphere` around the scene, `iPlane` for the floor.
  Steps spent in empty space are the most common cost.
- The hit threshold grows with t (pixel footprint), so far geometry does not burn steps or shimmer.
- `stepScale` < 1 only when the field has Lipschitz > 1 (see `sdf-library-guide.md`).
- `calcNormal(p, eps)` with `eps = 0.0005 * t` filters normals in the distance and avoids sparkle.
- Over-relaxation (step `1.2 * d` and fall back when consecutive spheres don't overlap) saves 15-20% on exact fields
  but voids the safety guarantee for bounds; use it only after the scene is final.

## Lighting

Artist units: a light of color C lights a white Lambert surface facing it to C. `shadePBR` and `specularGGX`
already include `NoL`, and π is folded in, so lights multiply directly.

Outdoor rig (the default for landscapes and objects in daylight):

```glsl
vec3 outdoorLight(vec3 p, vec3 n, vec3 v, vec3 albedo, float rough, float metal,
                  vec3 sunDir, vec3 sunCol, float shadow, float ao) {
    vec3 key = shadePBR(n, v, sunDir, albedo, rough, metal) * sunCol * shadow;
    vec3 sky = albedo * (1.0 - metal) * hemisphereLight(n, vec3(0.30, 0.40, 0.55), vec3(0.15, 0.12, 0.10)) * ao;
    vec3 bounceDir = normalize(vec3(-sunDir.x, 0.0, -sunDir.z));
    vec3 bounce = albedo * (1.0 - metal) * sunCol * 0.08 * clamp(dot(n, bounceDir), 0.0, 1.0) * ao;
    vec3 f0 = mix(vec3(0.04), albedo, metal);
    vec3 refl = reflect(-v, n);
    vec3 spec = envBRDFApprox(f0, max(dot(n, v), 0.0), rough) * simpleSky(refl, sunDir) * ao
              * smoothstep(-0.1, 0.3, refl.y);
    return key + sky + bounce + spec;
}
```

Rules that keep it believable:

- AO darkens fill lights only, never the sun. The sun is handled by its shadow.
- Keep albedo around 0.05-0.7 (linear) and brighten the lights, not the albedo. Snow is about 0.85, charcoal 0.04.
- Warm key, cool fill: the sky term is blue, the bounce is the ground color.
- Organic materials: `wrapDiffuse` for soft terminators, `translucency` with `sdfThickness` for backlit leaves, ears
  and wax, `rimLight` for separation from the background.

## Shadows, occlusion, thickness

- `softShadow(p + n * 0.002, sunDir, 0.01, tmax, k)`: k is about 1 / (light angular size). 8 is soft, 32 is crisp.
  Offset the origin along the normal to avoid self-shadow acne.
- `calcAO(p, n, scale)`: scale is the sampling reach in scene units (about 0.1-0.2 of the object size).
- `sdfThickness(p, n, depth)`: an "inverse AO" sampled inside the surface; drive translucency with it.

## Color and materials

- Light in linear. Colors you pick (hex codes, `cosinePalette` presets) are sRGB-encoded: decode with
  `srgbToLinear` before using them as albedo or light color.
- Mix colors in Oklab (`mixOklab`) for gradients without muddy mid-tones; generate hue families with
  `oklchToLinearSrgb(vec3(L, C, h))`, keeping L and C fixed so the swatches have equal weight.
- `blackbody(kelvin)` gives physically plausible light colors: 1800 K candle, 3200 K tungsten, 5500 K sun, 6500 K
  overcast, 10000 K blue sky.
- Metals have no diffuse: `metal = 1` with `albedo` as the specular color (gold `vec3(1.0, 0.78, 0.34)`).

## Sky, fog and aerial perspective

- `simpleSky(rd, sunDir)` is a cheap gradient with sun glow. `atmosphereSky(rd, sunDir, heightKm, intensity)` is
  physically based (Rayleigh + Mie + ozone); work in kilometers.
- Fog must use the sky color, or distant objects turn grey against a blue sky:
  `col = mix(col, sky, distanceFog(t, density))`, or the analytic `heightFog` for valley mist.
- Aerial perspective with a physical sky: attenuate by `exp(-t * atmosphereExtinction(...))` and fill with the sky
  color in a horizon-clamped direction: `normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))`. Below the planet's horizon
  the sky integral jumps (the ray starts hitting the ground), which prints a hard horizontal seam across terrain.
- Sun: `sunDisk(rd, sunDir, angularRadius, pixelAngle)` times a bright color (10-50). It is antialiased and
  limb-darkened.

## Volumes

- Integrate with `volumeStep(radiance, transmittance, sigmaT, inScatter, ds)`. It is energy-conserving, so dense
  media stay stable with 30-60 steps. The naive `radiance += T * S * ds` over-brightens and leaks light.
- Phase in artist units: multiply `phaseHG` / `phaseDualHG` by 4π so isotropic scattering is 1 and the sun term is
  on the same scale as an ambient color. Without that, the ambient term dominates and clouds look flat.
- Clouds: density = coverage-remapped fBm times a height profile; light-march 4-6 samples toward the sun with a
  cheaper (fewer octave) density; `beerPowder` on the direct term; `phaseDualHG(mu, 0.75, -0.25, 0.75)` for silver
  linings.
- Jitter the march start per pixel (`interleavedGradientNoise(floor(fragCoord), iFrame)`) to trade slicing bands
  for fine noise; exit once transmittance drops below 0.01.

## Exposure and tonemapping

| Tonemapper | Use |
|---|---|
| `tonemapAgX` (default) | 3D scenes, glows, fire, skies, volumes: highlights roll off to white with no hue skew |
| `tonemapAgXPunchy` | stylized 3D with more contrast and saturation |
| `tonemapNeutral` | 2D art, product shots, palette-faithful work: [0, 0.76] passes through untouched |
| `tonemapACES` | the saturated filmic look; darker, so raise exposure about 1.6x |
| `tonemapReinhard` | quick previews |

Expose first (`col * exposure`), then tonemap, then encode. A purely LDR 2D piece can skip tonemapping. Never
tonemap or encode twice: a washed-out, low-contrast image usually means double encoding.

## Antialiasing and filtering

- Supersampling: loop `i < AA` with `aaOffset(i)` (R2 sequence), tonemap per sample, average, then encode.
- 2D shapes: `fillAA(d, px)` and `strokeAA(d, halfWidth, px)` with `px = 2.0 / iResolution.y` work everywhere.
  `fillAA(d)` uses derivatives and is only valid outside branches and loops.
- Patterns on surfaces: filter instead of supersampling. `filteredChecker`, `filteredGrid` and `filteredStripes`
  integrate over the pixel footprint. In a raymarcher the footprint is `t * 2.0 / (iResolution.y * focal)`, which
  needs no derivatives.
- Noise: fade octaves whose period approaches 2 pixels instead of letting them alias.

## Performance checklist

- Bound the march (analytic clip) and keep `RAYMARCH_MAX_STEPS` reasonable; check `DEBUG_MODE 4`.
- Put expensive sub-scenes behind a cheap bounding test: `float b = sdBox(p - c, size); if (b > res.x) return res;`.
- Evaluate detail noise only where the base field says it matters (clouds: skip when coverage is 0).
- Use fewer octaves for shadow, AO and light-march samples than for the primary hit.
- Prefer analytic derivatives (`gradientNoiseD`) over 4-6 extra noise evaluations for normals.
