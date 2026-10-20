precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_crackSpeed;
uniform float u_lightBleed;
uniform vec2 u_mouse;

// Hash functions for procedural Voronoi
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Voronoi with distance to nearest edge
// Returns: x = dist to nearest center, y = dist to nearest edge, z = cell id
vec3 voronoi(vec2 p, float t) {
  vec2 n = floor(p);
  vec2 f = fract(p);

  // First pass: find nearest cell center
  float minDist = 8.0;
  vec2 nearestCell = vec2(0.0);
  vec2 nearestPoint = vec2(0.0);

  // 3x3 neighbor search — unrolled to avoid non-constant indexing
  vec2 g;
  vec2 o;
  vec2 diff;
  float d;

  g = vec2(-1.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(0.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(1.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }

  g = vec2(-1.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(0.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(1.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }

  g = vec2(-1.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(0.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }
  g = vec2(1.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearestCell = n + g; nearestPoint = diff; }

  // Second pass: find distance to nearest edge
  float minEdge = 8.0;

  g = vec2(-1.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(0.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(1.0, -1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }

  g = vec2(-1.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(0.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(1.0, 0.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }

  g = vec2(-1.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(0.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }
  g = vec2(1.0, 1.0); o = hash2(n + g) * 0.5 + 0.25; o = 0.5 + 0.4 * sin(t * 0.3 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearestPoint, diff - nearestPoint) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearestPoint + diff), normalize(diff - nearestPoint))); }

  float cellId = hash1(nearestCell);
  return vec3(sqrt(minDist), minEdge, cellId);
}

// Simpler Voronoi for micro fractures (just edge distance)
float voronoiEdge(vec2 p, float t) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float minDist = 8.0;
  vec2 nearPt = vec2(0.0);
  vec2 g; vec2 o; vec2 diff; float d;

  g = vec2(-1.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(0.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(1.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(-1.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(0.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(1.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(-1.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(0.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }
  g = vec2(1.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f; d = dot(diff, diff);
  if (d < minDist) { minDist = d; nearPt = diff; }

  float minEdge = 8.0;
  g = vec2(-1.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(0.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(1.0, -1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(-1.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(0.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(1.0, 0.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(-1.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(0.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }
  g = vec2(1.0, 1.0); o = hash2(n + g); o = 0.5 + 0.35 * sin(t * 0.5 + 6.2831 * o); diff = g + o - f;
  if (dot(diff - nearPt, diff - nearPt) > 0.001) { minEdge = min(minEdge, dot(0.5 * (nearPt + diff), normalize(diff - nearPt))); }

  return minEdge;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 mouseOffset = vec2(0.0);
  if (u_mouse.x > 0.0) {
    vec2 mUV = u_mouse / u_res;
    mouseOffset = -(mUV - 0.5) * 0.15;
  }
  vec2 p = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);

  float t = u_time * u_crackSpeed;

  // Subtle heat shimmer distortion
  vec2 shimmer = vec2(
    sin(p.y * 12.0 + t * 2.3) * 0.003,
    cos(p.x * 10.0 + t * 1.7) * 0.003
  );
  p += shimmer;

  // Macro Voronoi fractures — foreground layer, stronger parallax
  vec2 macroUV = (p + mouseOffset * 1.0) * 3.5 + 0.5;
  vec3 macro = voronoi(macroUV, t);
  float macroCenterDist = macro.x;
  float macroEdge = macro.y;
  float cellId = macro.z;

  // Micro fractures — background layer, subtler parallax (inverted for depth)
  float microEdge = voronoiEdge((p + mouseOffset * 2.5) * 9.0 + vec2(3.7, 1.2), t * 0.7);

  // Time-varying crack widths
  float crackPulse = 0.5 + 0.3 * sin(t * 1.5) + 0.2 * sin(t * 2.7 + 1.0);
  float macroCrackWidth = 0.04 * crackPulse;
  float microCrackWidth = 0.025 * crackPulse;

  // Crack intensity (how close to a crack edge)
  float macroCrack = 1.0 - smoothstep(0.0, macroCrackWidth, macroEdge);
  float microCrack = 1.0 - smoothstep(0.0, microCrackWidth, microEdge);

  // Combined crack pattern — macro dominates, micro adds detail
  float crack = macroCrack + microCrack * 0.4;
  crack = clamp(crack, 0.0, 1.0);

  // Fresnel-like glow at crack edges (wider glow around cracks)
  float macroGlow = 1.0 - smoothstep(0.0, macroCrackWidth * 4.0, macroEdge);
  float microGlow = 1.0 - smoothstep(0.0, microCrackWidth * 3.0, microEdge);
  float glow = macroGlow * 0.7 + microGlow * 0.3;

  // Per-cell glass color variation (thickness differences)
  float cellThickness = 0.6 + 0.4 * cellId;
  float cellHueShift = cellId * 0.3;

  // Base amber/caramel glass color
  vec3 amber = vec3(0.78, 0.585, 0.424);      // #c8956c
  vec3 caramel = vec3(0.831, 0.647, 0.455);    // #d4a574
  vec3 deepAmber = vec3(0.29, 0.125, 0.0);     // #4a2000

  // Glass surface — varies per cell
  vec3 glassColor = mix(amber, caramel, cellHueShift);
  glassColor = mix(deepAmber, glassColor, cellThickness);

  // Subtle center-to-edge gradient within each cell (thinner at edges)
  float cellGrad = smoothstep(0.0, 0.5, macroCenterDist);
  glassColor = mix(glassColor * 1.1, glassColor * 0.85, cellGrad);

  // Pink/rose gold refraction tint near cracks
  vec3 roseGold = vec3(0.9, 0.65, 0.6);
  float refractTint = glow * (0.3 + 0.2 * sin(cellId * 12.0 + t * 0.8));
  glassColor = mix(glassColor, roseGold, refractTint * 0.25);

  // Light bleeding through cracks
  vec3 crackLight = vec3(1.0, 0.91, 0.75);     // #ffe8c0
  vec3 crackBright = vec3(1.0, 0.96, 0.9);     // #fff5e6
  vec3 lightColor = mix(crackLight, crackBright, crack);

  // Apply crack lighting with light bleed control
  float lightIntensity = crack * u_lightBleed;
  float glowIntensity = glow * u_lightBleed * 0.5;

  // Combine glass surface with crack light
  vec3 col = glassColor;

  // Soft glow around cracks (the light bleed)
  col = mix(col, lightColor * 0.8, glowIntensity);

  // Bright crack lines themselves
  col = mix(col, lightColor, lightIntensity);

  // Add subtle inner glow / subsurface scattering feel
  float sss = 0.5 + 0.5 * sin(p.x * 3.0 + t * 0.5) * sin(p.y * 2.5 + t * 0.3);
  col += vec3(0.05, 0.03, 0.01) * sss * cellThickness;

  // Vignette
  float vig = 1.0 - dot(p * 0.8, p * 0.8);
  vig = smoothstep(0.0, 1.0, vig);
  col *= 0.6 + 0.4 * vig;

  // Tone mapping — keep it warm
  col = pow(col, vec3(0.95));

  gl_FragColor = vec4(col, 1.0);
}
