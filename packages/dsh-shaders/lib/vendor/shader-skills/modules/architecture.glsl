//! architecture: stable building parameters and filtered facade fields. These are massing/material helpers,
//! not a mesh generator or a full shape-grammar engine. Keep the generated footprint inside its parcel.

/// Stable building profile: vec4(height, half-width, half-depth, roof style 0/1/2) from an integer parcel ID.
/// Height and half-width ranges are ordered, positive world-space values. The same ID always gives the same profile.
/// @use city blocks, towers, deterministic chunk generation, architectural massing
/// @see Mueller et al., "Procedural Modeling of Buildings", SIGGRAPH 2006 (hierarchical massing principle)
vec4 buildingProfile(vec2 parcel, vec2 heightRange, vec2 halfWidthRange) {
    vec3 h = hash32(parcel);
    return vec4(mix(heightRange.x,heightRange.y,h.x*h.x),
                mix(halfWidthRange.x,halfWidthRange.y,h.y),
                mix(halfWidthRange.x,halfWidthRange.y,h.z),
                floor(3.0*hash12(parcel+vec2(83.0,19.0))));
}

/// Box-filtered rectangular windows centered on integer facade coordinates. fill is the opening fraction per
/// cell in [0,1]; footprint is the pixel's width/height in cell units. At large footprints it converges to fill.x*fill.y.
/// @use distant city facades, office windows, floor bands, architectural grids without moire
/// @range [0,1]
/// @see https://iquilezles.org/articles/filterableprocedurals/ (integrate a periodic pattern over a footprint)
float facadeWindowMask(vec2 uv, vec2 fill, vec2 footprint) {
    fill = clamp(fill,0.0,1.0);
    vec2 w = max(footprint,vec2(0.0001));
    vec2 a = uv + 0.5*fill + 0.5*w;
    vec2 b = uv + 0.5*fill - 0.5*w;
    vec2 ia = floor(a)*fill + min(fract(a),fill);
    vec2 ib = floor(b)*fill + min(fract(b),fill);
    vec2 coverage = clamp((ia-ib)/w,0.0,1.0);
    return coverage.x*coverage.y;
}
