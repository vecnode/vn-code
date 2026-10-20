//! post: antialiasing helpers, supersampling offsets, lens effects, grain and dithering, all single-pass.
//! Order of a finished frame: (per AA sample) exposure, vignette, grain -> tonemap -> average samples ->
//! linearToSrgb -> dither. See references/rendering-pipeline.md.

/// Antialiased fill of a 2D SDF: 1 inside, 0 outside, box-filtered across one pixel. Uses screen derivatives,
/// so call it outside non-uniform branches and loops. For a fixed pixel size use fillAA(d, px).
/// @use 2D shapes, icons, text-like strokes, UI, masks with crisp edges
float fillAA(float d) {
    float w = length(vec2(dFdx(d), dFdy(d)));
    return clamp(0.5 - d / max(w, 1e-6), 0.0, 1.0);
}

/// Antialiased fill with an explicit pixel size px (e.g. 2.0 / iResolution.y for the standard uv). Safe in loops and branches.
/// @use 2D shapes evaluated inside loops, layered compositions
float fillAA(float d, float px) { return clamp(0.5 - d / px, 0.0, 1.0); }

/// Antialiased stroke of half-width hw around the zero line of a 2D SDF.
/// @use outlines, line art, rings, wireframes, contour lines
float strokeAA(float d, float hw, float px) { return fillAA(abs(d) - hw, px); }

/// Subpixel offset in [-0.5, 0.5)^2 for sample i of a supersampling loop (R2 low-discrepancy sequence).
/// Better coverage than a regular grid for any sample count.
/// @use AA loops: for (int i = 0; i < N; i++) { vec2 o = aaOffset(i); ... mainColor(fragCoord + o) }
vec2 aaOffset(int i) {
    return fract(0.5 + float(i) * vec2(0.7548776662, 0.5698402910)) - 0.5;
}

/// Natural (cos^4) vignette for a pinhole camera: uv is the screen point, focal the camera focal length.
/// Wider lenses vignette more. Multiply HDR color before tonemapping.
/// @use photographic falloff, framing, cinematic looks
float vignette(vec2 uv, float focal) {
    float f2 = focal * focal;
    float k = f2 / (f2 + dot(uv, uv));
    return k * k;
}

/// Signal-dependent film grain: noise grows with sqrt(intensity), as photon noise does. n should be zero-mean
/// noise (e.g. hash13(vec3(fragCoord, iFrame)) * 2 - 1). Apply in linear HDR before tonemapping.
/// @use filmic texture, hiding banding, analog looks
vec3 filmGrain(vec3 col, float amount, float n) {
    return col + amount * sqrt(max(col, 0.0)) * n;
}

/// Triangular-PDF dither of +-1 LSB for 8-bit output. Add AFTER linearToSrgb, right before writing fragColor.
/// @use removing banding in skies, fog, vignettes and dark gradients
vec3 ditherTPDF(vec2 fragCoord, int frame) {
    vec2 r = hash22(vec2(floor(fragCoord) + 7919.0 * float(frame % 1024)));
    return vec3((r.x + r.y - 1.0) / 255.0);
}
