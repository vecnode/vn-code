precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_intensity;
uniform float u_crustAmount;
uniform vec2 u_mouse;

#define PI 3.14159265359

// ── Hash & noise primitives ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash1(float n) {
  return fract(sin(n) * 43758.5453123);
}

vec2 hash2(vec2 p) {
  return vec2(
    fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453),
    fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453)
  );
}

// Smooth value noise
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// FBM — fractal Brownian motion
float fbm(vec2 p, int octaves) {
  float val = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    val += amp * noise(p * freq);
    freq *= 2.03;
    amp *= 0.49;
    p += vec2(1.7, 9.2);
  }
  return val;
}

// Ridged noise — great for crack-like structures
float ridgedNoise(vec2 p) {
  return 1.0 - abs(noise(p) * 2.0 - 1.0);
}

// Ridged FBM for crack networks
float ridgedFBM(vec2 p, int octaves) {
  float val = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float prev = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    float n = ridgedNoise(p * freq);
    n = n * n;
    val += n * amp * prev;
    prev = n;
    freq *= 2.2;
    amp *= 0.5;
    p += vec2(1.3, 7.1);
  }
  return val;
}

// Voronoi for crust plate boundaries
float voronoi(vec2 p, out vec2 cellCenter) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minDist = 1.0;
  float secondDist = 1.0;
  cellCenter = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2(i + neighbor);
      vec2 diff = neighbor + point - f;
      float d = dot(diff, diff);
      if (d < minDist) {
        secondDist = minDist;
        minDist = d;
        cellCenter = i + neighbor + point;
      } else if (d < secondDist) {
        secondDist = d;
      }
    }
  }
  return sqrt(secondDist) - sqrt(minDist);
}

// ── Domain warping for fluid magma motion ──
vec2 warpDomain(vec2 p, float t) {
  // Two layers of warping create churning fluid motion
  vec2 q = vec2(
    fbm(p + vec2(0.0, 0.0) + t * vec2(0.12, -0.08), 5),
    fbm(p + vec2(5.2, 1.3) + t * vec2(-0.09, 0.14), 5)
  );
  vec2 r = vec2(
    fbm(p + 3.5 * q + vec2(1.7, 9.2) + t * vec2(0.06, 0.05), 5),
    fbm(p + 3.5 * q + vec2(8.3, 2.8) + t * vec2(-0.07, 0.08), 5)
  );
  return p + 2.5 * r;
}

// ── Thermal color mapping ──
// Maps temperature 0..1 to magma colors:
// black -> deep red -> orange -> yellow -> white-hot
vec3 magmaColor(float temp) {
  // Use smooth curves for natural-looking thermal gradient
  vec3 c;
  if (temp < 0.15) {
    // Nearly cooled — very dark red/black
    float t = temp / 0.15;
    c = mix(vec3(0.02, 0.005, 0.0), vec3(0.15, 0.02, 0.005), t);
  } else if (temp < 0.35) {
    // Dark red glow
    float t = (temp - 0.15) / 0.2;
    c = mix(vec3(0.15, 0.02, 0.005), vec3(0.55, 0.08, 0.01), t * t);
  } else if (temp < 0.55) {
    // Red to orange
    float t = (temp - 0.35) / 0.2;
    c = mix(vec3(0.55, 0.08, 0.01), vec3(0.9, 0.3, 0.02), t);
  } else if (temp < 0.72) {
    // Orange to bright yellow-orange
    float t = (temp - 0.55) / 0.17;
    c = mix(vec3(0.9, 0.3, 0.02), vec3(1.0, 0.65, 0.08), t);
  } else if (temp < 0.88) {
    // Bright yellow
    float t = (temp - 0.72) / 0.16;
    c = mix(vec3(1.0, 0.65, 0.08), vec3(1.0, 0.9, 0.4), t);
  } else {
    // White-hot
    float t = (temp - 0.88) / 0.12;
    c = mix(vec3(1.0, 0.9, 0.4), vec3(1.0, 1.0, 0.85), t);
  }
  return c;
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / u_res;
  // Aspect-corrected coordinates centered at origin
  float aspect = u_res.x / u_res.y;
  vec2 p = (fragCoord - u_res * 0.5) / min(u_res.x, u_res.y);

  float t = u_time;

  // Mouse: compute heat eruption at cursor
  float mouseHeat = 0.0;
  if (u_mouse.x > 0.0) {
    vec2 mPos = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    float mDist = length(p - mPos);
    mouseHeat = exp(-mDist * mDist * 6.0);
  }

  // ────────────────────────────────────────────
  // UNIFIED MAGMA MATERIAL
  // Everything is computed from the same base field
  // ────────────────────────────────────────────

  // Scale for the magma surface — controls how zoomed in we are
  vec2 magmaUV = p * 3.0;

  // ── 1. Base convection flow ──
  // Domain-warped noise creates the churning fluid motion
  vec2 warped = warpDomain(magmaUV, t * 0.4);
  float baseFlow = fbm(warped, 7);

  // Second warp layer for extra turbulence at different scale
  vec2 warped2 = warpDomain(magmaUV * 1.3 + vec2(50.0), t * 0.35);
  float flow2 = fbm(warped2, 6);

  // Combine flows — this is the main convection pattern
  float convection = baseFlow * 0.6 + flow2 * 0.4;

  // ── 2. Crust formation from Voronoi cells ──
  // The crust forms naturally where the convection cools
  // Moving the voronoi field slowly creates drifting plates
  vec2 crustUV = magmaUV * 0.8 + t * vec2(0.03, -0.02);
  // Warp the crust coordinates by the convection flow itself
  // so the crust moves WITH the magma — unified motion
  crustUV += vec2(baseFlow, flow2) * 0.6;

  vec2 cellCenter;
  float crustEdge = voronoi(crustUV, cellCenter);

  // Second voronoi at different scale for subcracks
  vec2 cellCenter2;
  float subCracks = voronoi(crustUV * 2.5 + vec2(30.0), cellCenter2);

  // ── 3. Temperature field ──
  // This is the master field that controls everything
  // High temp = glowing magma, low temp = dark crust

  // Start with convection as base temperature
  float temp = convection;

  // The cracks (voronoi edges) are WHERE the hot magma shows through
  // Thin edges = bright cracks, wide cells = cooled crust
  float crackGlow = smoothstep(0.12 * u_crustAmount, 0.0, crustEdge);
  float subCrackGlow = smoothstep(0.08 * u_crustAmount, 0.0, subCracks) * 0.4;

  // Crust cools the surface
  float crustMask = smoothstep(0.0, 0.15 * u_crustAmount, crustEdge);
  // Each cell has a slightly different cooling rate
  float cellCool = hash(floor(cellCenter * 100.0)) * 0.3 + 0.5;
  float crustCooling = crustMask * cellCool * u_crustAmount;

  // Apply cooling — crust darkens the temperature
  temp = temp - crustCooling * 0.6;

  // But cracks reveal hot magma beneath
  temp = max(temp, crackGlow * 0.85);
  temp = max(temp, subCrackGlow * 0.5 + temp * 0.5);

  // ── 4. Hot spots — convection upwellings ──
  // These pulse and drift with the flow
  float hotSpotNoise = fbm(magmaUV * 0.5 + t * vec2(0.08, -0.06), 4);
  float hotSpots = smoothstep(0.55, 0.85, hotSpotNoise);
  // Hot spots push temperature up and eat through crust
  temp += hotSpots * 0.35 * u_intensity;

  // Slow, large pulsation — breathing of the lava lake
  float breathe = sin(t * 0.6) * 0.5 + 0.5;
  float breathe2 = sin(t * 0.37 + 2.0) * 0.5 + 0.5;
  temp += breathe * 0.08 + breathe2 * 0.05;

  // ── 5. Ridged detail for a natural look ──
  // Fine ridged noise adds those thin bright veins that lava has
  float veins = ridgedFBM(warped * 1.5 + t * 0.1, 5);
  // Veins are most visible in medium-temperature regions
  float veinMask = smoothstep(0.2, 0.4, temp) * smoothstep(0.8, 0.5, temp);
  temp += veins * veinMask * 0.15;

  // ── 6. Localized brightening events ──
  // Occasional bright flare-ups where crust breaks apart
  float flareNoise = noise(magmaUV * 1.2 + t * vec2(0.3, -0.2));
  float flare = pow(max(flareNoise - 0.65, 0.0) / 0.35, 3.0);
  temp += flare * 0.25 * u_intensity;

  // ── Mouse eruption: boost temperature at cursor ──
  temp += mouseHeat * 0.7;

  // ── Clamp temperature ──
  temp = clamp(temp * u_intensity, 0.0, 1.0);

  // ── 7. Convert temperature to color ──
  vec3 col = magmaColor(temp);

  // ── 8. Emissive glow for very hot areas ──
  // Hot regions cast light that brightens nearby pixels
  // (simulated by a soft bloom on high-temp areas)
  float glow = smoothstep(0.6, 1.0, temp);
  col += vec3(0.3, 0.08, 0.01) * glow * glow * 0.5;

  // ── 9. Crust surface texture ──
  // Cooled crust has subtle surface bumpiness
  float crustDetail = fbm(magmaUV * 8.0 + vec2(cellCool * 20.0), 4);
  float crustShade = crustMask * (0.8 + crustDetail * 0.4);
  // Darken the crust slightly with texture
  col *= mix(1.0, 0.7 + crustDetail * 0.3, crustMask * u_crustAmount * 0.5);

  // ── 10. Heat haze / atmospheric distortion ──
  // Subtle color shift simulating heat shimmer above surface
  float haze = fbm(p * 2.0 + t * vec2(0.15, 0.4), 3);
  float hazeStrength = smoothstep(0.5, 1.0, temp) * 0.08;
  col += vec3(0.15, 0.04, 0.0) * haze * hazeStrength;

  // ── 11. Very subtle cool ambient at edges ──
  // The edge of the "view" into the lava lake darkens slightly
  float edgeDist = length(p * vec2(1.0, 1.3));
  float edgeFade = smoothstep(0.7, 1.4, edgeDist);
  // Edges cool more — thicker crust at the rim
  float edgeCool = edgeFade * 0.3;
  col = mix(col, col * vec3(0.3, 0.1, 0.08), edgeCool);

  // ── 12. Vignette ──
  float vignette = 1.0 - smoothstep(0.5, 1.5, edgeDist);
  col *= 0.65 + vignette * 0.35;

  // ── 13. Tone mapping — prevent harsh clipping ──
  col = col / (1.0 + col * 0.15);

  // ── 14. Final color grading ──
  // Slight push toward warm amber in the midtones
  col = pow(col, vec3(0.95, 1.0, 1.1));

  gl_FragColor = vec4(col, 1.0);
}
