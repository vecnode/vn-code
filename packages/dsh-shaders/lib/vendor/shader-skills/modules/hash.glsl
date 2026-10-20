//! hash: integer hashes and float wrappers for lattice ids.
//! Naming: hashNM returns N floats from M inputs (hash12 = 1 output, 2 inputs). Outputs are in [0,1).
//! The float wrappers hash INTEGER-VALUED inputs (cell ids, pixel coords, frame numbers). Fractional parts
//! are dropped. That is deliberate: negative float -> uint is undefined in GLSL, and round() can return -0.0,
//! which has different bits from 0.0. Converting through int avoids both. To hash a continuous value, scale it first.
//! Do not use fract(sin(dot(p, k)) * 43758.5453): its result changes across GPUs and degrades at large inputs.
//! Integer mixers are from Jarzynski and Olano, "Hash Functions for GPU Rendering" (JCGT 2020): pcg3d and pcg4d sit
//! on that study's quality/speed frontier, and 32-bit integer math is bit-exact on every GPU, unlike sin().

/// PCG-style 1D integer hash.
/// @use seeding, per-instance randomness, building other hashes
/// @see https://jcgt.org/published/0009/03/02/
uint pcgHash(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

/// 3D integer hash, three decorrelated outputs.
/// @use 3D cell ids, voxel jitter, (pixel, frame) noise
/// @see https://jcgt.org/published/0009/03/02/
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

/// 4D integer hash, four decorrelated outputs (0 BigCrush failures in the JCGT study).
/// @use (pixel.x, pixel.y, frame, sample) streams for stochastic sampling, 4D cell ids
/// @see https://jcgt.org/published/0009/03/02/
uvec4 pcg4d(uvec4 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    v ^= v >> 16u;
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    return v;
}

/// Map a uint to [0,1) using the top 24 bits, so the result can never round up to 1.0.
float uintToUnit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
vec2 uintToUnit(uvec2 h) { return vec2(h >> 8u) * (1.0 / 16777216.0); }
vec3 uintToUnit(uvec3 h) { return vec3(h >> 8u) * (1.0 / 16777216.0); }
vec4 uintToUnit(uvec4 h) { return vec4(h >> 8u) * (1.0 / 16777216.0); }

/// Random float in [0,1) for an integer-valued input.
/// @use per-cell randomness, stable random per instance id
/// @range [0,1)
float hash11(float p) { return uintToUnit(pcgHash(uint(int(floor(p))))); }

/// Random float in [0,1) for an integer-valued 2D input.
/// @use per-cell variation (color, height, rotation), sparse spots, star fields
/// @range [0,1)
float hash12(vec2 p) {
    uvec2 q = uvec2(ivec2(floor(p)));
    return uintToUnit(pcgHash(q.x + pcgHash(q.y)));
}

/// Random float in [0,1) for an integer-valued 3D input.
/// @use per-voxel randomness, per-pixel-per-frame noise via hash13(vec3(fragCoord, iFrame))
/// @range [0,1)
float hash13(vec3 p) {
    uvec3 q = uvec3(ivec3(floor(p)));
    return uintToUnit(pcgHash(q.x + pcgHash(q.y + pcgHash(q.z))));
}

/// Random vec2 in [0,1)^2 for an integer-valued 2D input.
/// @use Voronoi feature points, 2D jitter, random gradients
/// @range [0,1)^2
vec2 hash22(vec2 p) {
    ivec2 q = ivec2(floor(p));
    return uintToUnit(pcg3d(uvec3(q.x, q.y, 0x2545u))).xy;
}

/// Random vec3 in [0,1)^3 for an integer-valued 3D input.
/// @use 3D Voronoi points, random colors per cell, random directions
/// @range [0,1)^3
vec3 hash33(vec3 p) { return uintToUnit(pcg3d(uvec3(ivec3(floor(p))))); }

/// Random vec4 in [0,1)^4 for an integer-valued 4D input.
/// @use per-pixel, per-frame, per-sample random numbers: hash44(vec4(fragCoord, iFrame, sampleIndex))
/// @range [0,1)^4
vec4 hash44(vec4 p) { return uintToUnit(pcg4d(uvec4(ivec4(floor(p))))); }

/// Random vec3 in [0,1)^3 for an integer-valued 2D input.
/// @use per-tile random color, per-cell (offset, rotation, scale) triples
/// @range [0,1)^3
vec3 hash32(vec2 p) {
    ivec2 q = ivec2(floor(p));
    return uintToUnit(pcg3d(uvec3(q.x, q.y, 0x9E37u)));
}
