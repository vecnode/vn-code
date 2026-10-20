precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_ditherScale;
uniform float u_bitDepth;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

// ══════════════════════════════════════════
// Hash / noise helpers
// ══════════════════════════════════════════
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = rot * p * 2.0 + vec2(100.0);
    a *= 0.5;
  }
  return v;
}

// ══════════════════════════════════════════
// Bayer 8x8 dithering matrix (float-based, WebGL 1.0 safe)
// ══════════════════════════════════════════
// Standard Bayer 2x2: [[0,2],[3,1]]
// Recursive: M_2N(x,y) = 4*M_N(x%N,y%N) + M_2(x/N,y/N)
float bayer8(vec2 p) {
  vec2 fp = floor(mod(p, 8.0));
  // Encode 8x8 Bayer via 3 recursive levels of 2x2
  // Each level: map (bx, by) -> Bayer2x2 value
  // Bayer2x2(0,0)=0, (1,0)=2, (0,1)=3, (1,1)=1
  float val = 0.0;

  // Level 1: coarsest (4x4 blocks)
  float bx = step(4.0, fp.x);
  float by = step(4.0, fp.y);
  // Bayer2x2 via formula: 2*bx + by - 2*bx*by + 2*by*(1-bx)
  // Simpler: just encode directly
  // (0,0)->0, (1,0)->2, (0,1)->3, (1,1)->1
  float b = bx * 2.0 * (1.0 - by) + (1.0 - bx) * 3.0 * by + bx * by * 1.0;
  val += b * 16.0;

  // Level 2: mid (2x2 blocks within each 4x4)
  float mx = mod(fp.x, 4.0);
  float my = mod(fp.y, 4.0);
  bx = step(2.0, mx);
  by = step(2.0, my);
  b = bx * 2.0 * (1.0 - by) + (1.0 - bx) * 3.0 * by + bx * by * 1.0;
  val += b * 4.0;

  // Level 3: finest (pixel pairs)
  float lx = mod(fp.x, 2.0);
  float ly = mod(fp.y, 2.0);
  bx = step(1.0, lx);
  by = step(1.0, ly);
  b = bx * 2.0 * (1.0 - by) + (1.0 - bx) * 3.0 * by + bx * by * 1.0;
  val += b;

  return val / 64.0;
}

// ══════════════════════════════════════════
// Halftone dot pattern
// ══════════════════════════════════════════
float halftone(vec2 p, float size) {
  vec2 cell = floor(p / size) * size + size * 0.5;
  float d = length(p - cell) / (size * 0.5);
  return clamp(d, 0.0, 1.0);
}

// ══════════════════════════════════════════
// Diagonal line dither pattern
// ══════════════════════════════════════════
float lineDither(vec2 p, float size) {
  float d = mod(p.x + p.y, size) / size;
  return d;
}

// ══════════════════════════════════════════
// Cross-hatch dither pattern
// ══════════════════════════════════════════
float crossHatch(vec2 p, float size) {
  float d1 = mod(p.x + p.y, size) / size;
  float d2 = mod(p.x - p.y, size) / size;
  return min(d1, d2);
}

// ══════════════════════════════════════════
// Dithered quantization
// ══════════════════════════════════════════
float ditherQuantize(float val, float levels, float threshold) {
  float stepped = floor(val * levels) / levels;
  float next = stepped + 1.0 / levels;
  float frac = fract(val * levels);
  return frac > threshold ? next : stepped;
}

// ══════════════════════════════════════════
// Base gradient field — slowly morphing multi-center gradients
// ══════════════════════════════════════════
vec3 baseGradient(vec2 uv, float t) {
  // Slowly rotating coordinate system
  float angle = t * 0.05;
  mat2 rot = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  vec2 ruv = rot * uv;

  // Multiple gradient centers drifting slowly
  vec2 c1 = vec2(0.35 * sin(t * 0.07), 0.25 * cos(t * 0.09));
  vec2 c2 = vec2(-0.3 * cos(t * 0.06 + 1.0), 0.3 * sin(t * 0.08 + 2.0));
  vec2 c3 = vec2(0.2 * sin(t * 0.11 + 3.0), -0.35 * cos(t * 0.05 + 1.5));

  // Radial distances from each center
  float d1 = length(ruv - c1);
  float d2 = length(ruv - c2);
  float d3 = length(ruv - c3);

  // Angular component for swirling
  float a1 = atan(ruv.y - c1.y, ruv.x - c1.x);
  float a2 = atan(ruv.y - c2.y, ruv.x - c2.x);

  // Combine into flowing gradient field
  float g1 = sin(d1 * 3.0 - t * 0.15 + a1 * 0.5) * 0.5 + 0.5;
  float g2 = cos(d2 * 2.5 + t * 0.12 - a2 * 0.3) * 0.5 + 0.5;
  float g3 = sin(d3 * 4.0 + t * 0.1 + d1 * 2.0) * 0.5 + 0.5;

  // FBM warp for organic feel
  float warp = fbm(ruv * 2.0 + t * 0.05) * 0.3;

  float f = g1 * 0.4 + g2 * 0.35 + g3 * 0.25 + warp;
  f = clamp(f, 0.0, 1.0);

  // Warm amber palette
  // Dark background -> deep amber -> warm gold -> bright cream
  vec3 col0 = vec3(0.04, 0.03, 0.02);  // near-black warm
  vec3 col1 = vec3(0.30, 0.15, 0.06);  // deep amber
  vec3 col2 = vec3(0.70, 0.40, 0.15);  // warm gold
  vec3 col3 = vec3(0.92, 0.75, 0.45);  // bright cream-gold

  vec3 col;
  if (f < 0.33) {
    col = mix(col0, col1, f / 0.33);
  } else if (f < 0.66) {
    col = mix(col1, col2, (f - 0.33) / 0.33);
  } else {
    col = mix(col2, col3, (f - 0.66) / 0.34);
  }

  return col;
}

// ══════════════════════════════════════════
// Main
// ══════════════════════════════════════════
void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = (fragCoord - u_res * 0.5) / min(u_res.x, u_res.y);
  float t = u_time;
  float ditherSc = u_ditherScale;
  float bitD = u_bitDepth;

  // ── Mouse interaction ──
  // Mouse reveals "analog truth" — smooth gradients in a radius
  float mouseReveal = 0.0;
  vec2 mouseUV = vec2(-10.0);
  if (u_mouse.x >= 0.0) {
    mouseUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    float mouseDist = length(uv - mouseUV);
    // Smooth reveal radius
    mouseReveal = 1.0 - smoothstep(0.06, 0.18, mouseDist);
  }

  // ── Layer 1: Base gradient field ──
  vec3 smoothColor = baseGradient(uv, t);

  // ── Pixel coordinates for dither patterns ──
  // Scale by ditherScale — larger = bigger dither cells
  vec2 ditherCoord = fragCoord / ditherSc;

  // ── Layer 2 & 3: Pattern transition regions ──
  // Different areas of canvas use different dither algorithms
  // Morphing between them based on FBM noise + time
  float regionNoise = fbm(uv * 1.5 + t * 0.04);
  float regionNoise2 = fbm(uv * 2.0 - t * 0.03 + vec2(50.0));

  // Four zones that drift and blend
  float zoneBayer = smoothstep(0.3, 0.6, regionNoise);
  float zoneHalftone = smoothstep(0.4, 0.7, regionNoise2);
  float zoneLine = smoothstep(0.35, 0.65, sin(regionNoise * TAU + t * 0.2) * 0.5 + 0.5);
  float zoneCross = 1.0 - zoneBayer;

  // Normalize zone weights
  float totalWeight = zoneBayer + zoneHalftone + zoneLine + zoneCross + 0.001;
  zoneBayer /= totalWeight;
  zoneHalftone /= totalWeight;
  zoneLine /= totalWeight;
  zoneCross /= totalWeight;

  // ── Layer 4: Bit-depth wave ──
  // A traveling wavefront that changes quantization levels
  // Creates visible "resolution bands" sweeping across canvas
  float waveAngle = t * 0.08;
  vec2 waveDir = vec2(cos(waveAngle), sin(waveAngle));
  float wavePos = dot(uv, waveDir);

  // Multiple overlapping waves at different speeds/angles
  float wave1 = sin(wavePos * 4.0 - t * 0.3) * 0.5 + 0.5;
  float wave2 = sin(dot(uv, vec2(sin(t * 0.05), cos(t * 0.07))) * 6.0 + t * 0.2) * 0.5 + 0.5;
  float waveMix = wave1 * 0.6 + wave2 * 0.4;

  // Map wave to quantization levels: low bits (2-4) to high bits (16-32)
  // bitD parameter scales the whole range
  float baseLevels = mix(2.0, 32.0, waveMix) * bitD;
  baseLevels = max(baseLevels, 2.0);

  // ── Layer 5: Chromatic dither separation ──
  // R, G, B channels use slightly offset dither matrices
  vec2 offsetR = vec2(0.0, 0.0);
  vec2 offsetG = vec2(2.7, 1.3);
  vec2 offsetB = vec2(-1.5, 3.1);

  float threshR = bayer8(ditherCoord + offsetR) * zoneBayer
                + halftone(ditherCoord + offsetR, 8.0) * zoneHalftone
                + lineDither(ditherCoord + offsetR, 6.0) * zoneLine
                + crossHatch(ditherCoord + offsetR, 6.0) * zoneCross;

  float threshG = bayer8(ditherCoord + offsetG) * zoneBayer
                + halftone(ditherCoord + offsetG, 8.0) * zoneHalftone
                + lineDither(ditherCoord + offsetG, 6.0) * zoneLine
                + crossHatch(ditherCoord + offsetG, 6.0) * zoneCross;

  float threshB = bayer8(ditherCoord + offsetB) * zoneBayer
                + halftone(ditherCoord + offsetB, 8.0) * zoneHalftone
                + lineDither(ditherCoord + offsetB, 6.0) * zoneLine
                + crossHatch(ditherCoord + offsetB, 6.0) * zoneCross;

  // ── Apply dithered quantization per channel ──
  // Slightly different quantization levels per channel for color fringing
  float levelsR = baseLevels;
  float levelsG = baseLevels * 1.15;
  float levelsB = baseLevels * 0.85;

  vec3 ditheredColor;
  ditheredColor.r = ditherQuantize(smoothColor.r, levelsR, threshR);
  ditheredColor.g = ditherQuantize(smoothColor.g, levelsG, threshG);
  ditheredColor.b = ditherQuantize(smoothColor.b, levelsB, threshB);

  // ── Near the mouse: halftone circles override other patterns ──
  // Creates a distinct visual zone around cursor
  if (u_mouse.x >= 0.0) {
    float mouseD = length(uv - mouseUV);
    float ringZone = smoothstep(0.18, 0.25, mouseD) * (1.0 - smoothstep(0.25, 0.38, mouseD));
    // In the ring zone, use pure halftone with higher bit depth
    float ringHalftone = halftone(ditherCoord, 6.0);
    vec3 ringDithered;
    float ringLevels = baseLevels * 2.0;
    ringDithered.r = ditherQuantize(smoothColor.r, ringLevels, ringHalftone);
    ringDithered.g = ditherQuantize(smoothColor.g, ringLevels, ringHalftone);
    ringDithered.b = ditherQuantize(smoothColor.b, ringLevels, ringHalftone);
    ditheredColor = mix(ditheredColor, ringDithered, ringZone);
  }

  // ── Blend between dithered and smooth based on mouse reveal ──
  vec3 finalColor = mix(ditheredColor, smoothColor, mouseReveal);

  // ── Subtle edge emphasis ──
  // Emphasize transitions between bit-depth bands
  float bandEdge = abs(fract(waveMix * 4.0) - 0.5) * 2.0;
  bandEdge = smoothstep(0.85, 1.0, bandEdge);
  finalColor += vec3(0.08, 0.05, 0.02) * bandEdge * (1.0 - mouseReveal);

  // ── Vignette ──
  float vig = 1.0 - dot(uv * 0.85, uv * 0.85);
  vig = clamp(vig, 0.0, 1.0);
  vig = pow(vig, 0.4);
  finalColor *= vig;

  // ── Film grain — very subtle ──
  float grain = (hash(fragCoord + fract(t * 41.0) * 1000.0) - 0.5) * 0.02;
  finalColor += grain;

  // ── Keep blacks deep ──
  finalColor = max(finalColor, vec3(0.0));

  gl_FragColor = vec4(finalColor, 1.0);
}
