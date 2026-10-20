//! operators: combine distances (booleans, smooth blends, chamfers, stairs) and reshape them (round, onion,
//! extrude, revolve, elongate). Arguments a, b are distances already evaluated at the same point.
//! Exactness: union (min) is exact outside but too deep inside; intersection and subtraction (max) are exact
//! inside but underestimate outside. Smooth and decorative combinations are bounds. All stay Lipschitz <= 1,
//! so raymarching is safe. When interior distances matter (inner-penumbra shadows, thickness, onion of a union),
//! prefer an exact concave primitive (sdDeathStar, sdCutHollowSphere, 2D sdMoon/sdArc + extrude/revolve).
//! Smooth unions are not associative: blend in a fixed order (torso, then limbs, then details).
//! Smooth blend semantics in this library: k is the blend width in distance units. Shapes start blending
//! when |a - b| < k.

/// Union of two shapes.
/// @bound
/// @use combining parts
float opUnion(float a, float b) { return min(a, b); }

/// Shape a with shape b cut out of it.
/// @bound
/// @use holes, windows, carving, bites
float opSubtract(float a, float b) { return max(a, -b); }

/// Region inside both shapes.
/// @bound
/// @use clipping, lens shapes, trimming with half-spaces
float opIntersect(float a, float b) { return max(a, b); }

/// Smooth union (polynomial, C1). Blends where |a - b| < k, with a max bulge of k/4.
/// @bound
/// @use organic joins (neck to head, limbs to torso), melting shapes, blobby forms
/// @see https://iquilezles.org/articles/smin/
float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

/// Smooth intersection, the mirror of smin.
/// @bound
/// @use soft clipping, rounded intersections, pillowy cuts
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

/// Smooth subtraction: a with b carved out, with filleted edges.
/// @bound
/// @use eye sockets, nostrils, soft grooves, scooped bowls, worn edges
float smoothSubtract(float a, float b, float k) { return smax(a, -b, k); }

/// Smooth union with a C2 (cubic) transition, so specular highlights and normals have no visible seam.
/// Blends where |a - b| < k, with a max bulge of k/6.
/// @bound
/// @use close-up organic surfaces, glossy blends, fluids
/// @see https://iquilezles.org/articles/smin/
float sminCubic(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

/// Smooth union that also returns the blend weight. Returns vec2(distance, weight), where weight is 1 when
/// the result is fully a and 0 when fully b. Use the weight to mix material colors across the blend.
/// @bound
/// @use skin-to-cloth transitions, color bleeding across blended parts, gradient-colored blobs
vec2 sminBlend(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return vec2(mix(b, a, h) - k * h * (1.0 - h), h);
}

/// Union with a 45-degree chamfer of size r at the seam.
/// @bound
/// @use machined parts, architecture, sci-fi panels, bevelled joins
/// @see https://mercury.sexy/hg_sdf/
float opChamferUnion(float a, float b, float r) {
    return min(min(a, b), (a + b - r) * 0.70710678);
}

/// Union with n stair steps of total size r at the seam.
/// @bound
/// @use terraces, stepped pyramids, ziggurats, layered rock, rice paddies
/// @see https://mercury.sexy/hg_sdf/
float opStairsUnion(float a, float b, float r, float n) {
    float s = r / n;
    float u = b - r;
    return min(min(a, b), 0.5 * (u + a + abs(mod(u - a + s, 2.0 * s) - s)));
}

/// Engrave a groove of depth r into a, following the zero set of b.
/// @bound
/// @use panel lines, carved text paths, seams, grout lines on a surface
/// @see https://mercury.sexy/hg_sdf/
float opEngrave(float a, float b, float r) {
    return max(a, (a + r - abs(b)) * 0.70710678);
}

/// Round a shape by r. Grows it outward; shrink the inner shape by r first to keep its size.
/// @exact
/// @use softening any primitive, pebbles from boxes, inflated look
float opRound(float d, float r) { return d - r; }

/// Hollow shell of thickness 2t around the surface. Apply repeatedly for concentric layers.
/// @exact
/// @use shells, pipes, rings, onion layers, outlines in 2D
float opOnion(float d, float t) { return abs(d) - t; }

/// Extrude a 2D distance d2 (evaluated at p.xy) along Z by half-length h.
/// @exact
/// @use 3D text and logos, cookie cutters, coins from 2D shapes, extruded profiles
float opExtrude(vec3 p, float d2, float h) {
    vec2 w = vec2(d2, abs(p.z) - h);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}

/// Revolve around Y. Returns the 2D point to evaluate a profile at. Offset o moves the profile away from the axis.
/// @exact
/// @use vases, bottles, chess pieces, lathe-turned objects, tori with custom profiles
vec2 opRevolve(vec3 p, float o) { return vec2(length(p.xz) - o, p.y); }

/// Elongate: stretch a shape by inserting a straight section of half-size h, keeping exact distances inside too.
/// Returns vec4(q, w). Evaluate the original shape at q.xyz and add w:  sdSphere(e.xyz, r) + e.w  is a capsule.
/// @exact
/// @use pills from spheres, long rounded boxes, stretched characters, stadium shapes
vec4 opElongate(vec3 p, vec3 h) {
    vec3 q = abs(p) - h;
    return vec4(max(q, 0.0), min(max(q.x, max(q.y, q.z)), 0.0));
}
