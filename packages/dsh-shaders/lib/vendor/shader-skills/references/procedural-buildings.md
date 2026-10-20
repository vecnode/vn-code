# Procedural buildings and cities

Use this route for architectural massing, towers, streets, windows, roof details and stable per-parcel variation.
The complete starting point is `templates/procedural-city.glsl`. Library helpers are in `glsl/architecture.glsl`.
This shader renders implicit geometry; it does not export editable meshes or implement a full CGA rule engine.

## Contents

- [Construction order](#construction-order)
- [Stable parcels](#stable-parcels)
- [Filtered facade fields](#filtered-facade-fields)
- [Geometry and tracing](#geometry-and-tracing)
- [Materials, lighting and quality](#materials-lighting-and-quality)
- [Use cases and extensions](#use-cases-and-extensions)
- [Sources](#sources)

## Construction order

1. Establish a street grid and parcel IDs in world space.
2. Generate stable dimensions from the parcel ID; reserve roads and margins before adding detail.
3. Compose a podium, main mass, upper setback and roof. Different silhouettes matter more than random windows.
4. Shade the facade with floor/column coordinates; keep facade masks separate from structural distance.
5. Add material families, occupied windows, roof equipment, shadows, ambient occlusion and depth cues.
6. Filter windows and occupation randomness by the ray footprint. Check parcel IDs and march-cost views.

This is the massing hierarchy used in the template. It is inspired by grammar-based architecture, but it is a
fixed procedural recipe rather than an implementation of the full rule language in the cited research.

## Stable parcels

`buildingProfile` takes an integer ID and ordered ranges. It returns height, half-width, half-depth and a discrete
roof-style ID. Half-widths are not full facade widths. Keep the footprint plus podium margin below half the parcel
spacing; changing the seed inputs changes the city, while camera movement does not.

```glsl
vec4 architecturalParcelProfile(vec2 worldXZ) {
    vec2 parcel = domRepeatId(worldXZ, vec2(3.6));
    return buildingProfile(parcel, vec2(2.8, 13.0), vec2(0.75, 1.13));
}
```

For chunked worlds, derive the ID from global coordinates or a global integer chunk ID plus local cell ID. Do not
seed height from camera-relative coordinates. Keep random choices stable across LODs so roofs do not change shape
when the camera moves. The library test checks profile ranges and roof-style discreteness.

## Filtered facade fields

Choose coordinates on the dominant facade plane: X-facing walls use Z/Y, Z-facing walls use X/Y. Divide by window
spacing before calling the filter. `footprint` must also be expressed in these cell units. Supply an explicit
footprint in branches; do not call derivatives after a raymarch or inside material branches.

```glsl
float architecturalWindows(vec2 facadeMeters, vec2 footprintMeters) {
    vec2 spacing = vec2(0.30, 0.43);
    return facadeWindowMask(facadeMeters / spacing, vec2(0.62, 0.65), footprintMeters / spacing);
}
```

The filter integrates a periodic rectangular aperture. It tends toward opening area (`fill.x * fill.y`) when
windows are smaller than a pixel, rather than flickering. At grazing angles enlarge the footprint in the compressed
facade direction. The template uses an explicit ray-footprint estimate; a production renderer can propagate ray
differentials for a better anisotropic footprint.

Occupation randomness is separate from the geometric window mask. Near the camera, hash the building/floor/column
ID to choose lit rooms. In the distance, fade those binary choices toward average occupation. Adding unfiltered
random room brightness after filtering the window shape reintroduces flicker.

## Geometry and tracing

The scene uses tested `sdBox`, `sdRoundBox` and `sdCapsule` primitives. Podium and setbacks are actual surfaces;
windows are material fields. A dark rectangle is not a recessed window. For close architecture, model cavities,
frames, sills and balconies as geometry with appropriate distance bounds.

Per-cell dimensions can make the nearest surface belong to a neighboring cell. The template evaluates a 3×3 grid
around the query, then caps the march step by the horizontal distance to the boundary of the unvisited region.
That cap prevents skipping over a taller block outside the searched cells. It is a traversal bound, not visible
geometry. It stays positive at cell boundaries, so it cannot create a phantom hit there.

All modeled components fit their parcel. If balconies/bridges overhang farther, enlarge the searched neighborhood
and update its unvisited-region cap. For very large or sparse cities, a grid DDA/BVH and analytic ray-box tests are
usually more efficient than evaluating nine detailed buildings at every step.

## Materials, lighting and quality

| Layer | Template behavior | Upgrade for close/high-budget views |
|---|---|---|
| Building masses | Three stacked forms, three roof styles, a hero tower | More silhouette families and explicit grammar rules |
| Facades | Filtered material windows, stable occupied rooms | Frames, recesses, balconies, interiors/parallax volumes |
| Materials | Concrete/metal tint, dark glass approximation | Layered facade materials and reflected scene rays/probes |
| Lighting | PBR direct key, hemisphere fill, AO, soft shadows | Baked or dynamic GI, area lights and reflected emissive windows |
| Atmosphere | Analytic height fog | Physical sky/aerial perspective and volumetric shafts |
| Antialiasing | One sample by default | Set `AA = 4` for a still; tonemap each sample before averaging |

Warm windows are emissive color only. They do not illuminate neighboring buildings. Glass uses an artistic sky
term in its material, not traced interior transmission or full scene reflections. Keep these limits explicit when
using the template as a starting point for a product or architecture visualization.

`DEBUG_MODE` 2 shows normals, 3 parcel IDs, 4 step cost and 5 filtered window coverage. All are compiled/rendered
by the GPU harness, in addition to the beauty view. The numerical test checks periodicity and the filter's
large-footprint mean. Sweep the camera across a parcel boundary to inspect temporal stability.

## Use cases and extensions

- **Game skyline / background city:** keep masses simple, filter windows, fade distant detail and bake static
  lighting. Use instance meshes in an engine when geometry export, collisions or navigation are needed.
- **Hero skyscraper:** retain the mass/setback hierarchy, replace random repetition with intentional floor bands,
  model close recesses, and provide real reflected surroundings.
- **Residential district:** swap tower profiles for gabled roof primitives, smaller floor counts, larger setbacks
  and vegetation masks. Add a road/parcel generator if a non-grid layout is required.
- **Ancient/alien architecture:** combine `domPolar`, columns, arches and bounded decorative repetition. Keep the
  same separation between layout, structural distance, material masks and lighting.

## Sources

- [Müller et al., Procedural Modeling of Buildings, SIGGRAPH 2006](https://doi.org/10.1145/1141911.1141931):
  massing and hierarchical shape grammar concepts. The local shader is an original compact recipe, not their code.
- [Aliaga, Wonka et al., SIGGRAPH 2011 urban-modeling course](https://www.cs.purdue.edu/cgvlab/urban/sg_2011_course/contents.html):
  layout, building design, facades and the distinction between geometric generation and shading.
- [Quilez, filterable procedurals](https://iquilezles.org/articles/filterableprocedurals/): analytic footprint
  integration principle, reimplemented in `facadeWindowMask`.

The local implementation is MIT; no third-party shader source is copied.
