precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_flareSpread;
uniform float u_driftSpeed;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define NUM_LIGHTS 6

// ── Hash functions ──
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash1(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

// ── Smooth value noise ──
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// ── FBM noise for ambient haze ──
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(1.7, 3.2);
    a *= 0.5;
  }
  return v;
}

// ── Per-light color tint ──
// 0: cobalt, 1: amber, 2: teal, 3: warm white, 4: rose, 5: cool white
vec3 lightTint(int idx) {
  if (idx == 0) return vec3(0.30, 0.45, 1.00);
  if (idx == 1) return vec3(1.00, 0.65, 0.20);
  if (idx == 2) return vec3(0.20, 0.85, 0.75);
  if (idx == 3) return vec3(1.00, 0.92, 0.80);
  if (idx == 4) return vec3(0.95, 0.40, 0.55);
  return vec3(0.75, 0.85, 1.00);
}

// ── Light source positions with slow cinematic drift ──
vec2 lightPos(int idx, float t) {
  float fi = float(idx);
  float seed = fi * 47.3;
  // Slow Lissajous-like orbits, each light on its own path
  float ax = 0.30 + hash1(seed) * 0.20;
  float ay = 0.35 + hash1(seed + 1.0) * 0.20;
  float fx = 0.07 + hash1(seed + 2.0) * 0.05;
  float fy = 0.05 + hash1(seed + 3.0) * 0.04;
  float px = hash1(seed + 4.0) * PI * 2.0;
  float py = hash1(seed + 5.0) * PI * 2.0;
  // Noise perturbation for organic feel
  float nx = noise(vec2(t * 0.03 + fi * 10.0, 0.0)) * 0.08 - 0.04;
  float ny = noise(vec2(0.0, t * 0.025 + fi * 10.0)) * 0.06 - 0.03;
  return vec2(
    sin(t * fx + px) * ax + nx,
    sin(t * fy + py) * ay + ny
  );
}

// ── Light brightness (pulsing subtly, dimmer per light for 6 sources) ──
float lightBrightness(int idx, float t) {
  float fi = float(idx);
  float base = 0.45 + hash1(fi * 13.7 + 100.0) * 0.25;
  float pulse = sin(t * (0.15 + hash1(fi * 23.1) * 0.1) + fi * 2.0) * 0.12;
  return base + pulse;
}

// ── Anamorphic flare for a single light source ──
// tint is the per-light color identity
vec3 anamorphicFlare(vec2 uv, vec2 lp, float brightness, float spread, vec3 tint) {
  vec2 delta = uv - lp;

  // Horizontal stretch factor for the characteristic anamorphic look
  float stretch = 7.0 * spread;

  // ── Soft Gaussian point light (the core) ──
  float coreD = length(delta);
  float core = exp(-coreD * coreD * 160.0) * brightness * 0.45;
  vec3 coreCol = mix(vec3(1.0, 0.97, 0.90), tint, 0.3) * core;

  // ── Anamorphic horizontal streak ──
  float streakDx = delta.x / stretch;
  float streakDy = delta.y;

  // Main streak envelope: very wide in x, tight in y
  float streakD = streakDx * streakDx * 12.0 + streakDy * streakDy * 600.0;
  float streak = exp(-streakD) * brightness * 0.35;

  // Chromatic aberration: warm orange left, cool blue right
  float chromaOffset = 0.015 * spread;
  float streakR_dx = (delta.x - chromaOffset) / stretch;
  float streakB_dx = (delta.x + chromaOffset) / stretch;
  float streakR_d = streakR_dx * streakR_dx * 12.0 + streakDy * streakDy * 600.0;
  float streakB_d = streakB_dx * streakB_dx * 12.0 + streakDy * streakDy * 600.0;
  float streakR = exp(-streakR_d) * brightness * 0.35;
  float streakB = exp(-streakB_d) * brightness * 0.35;

  // Chromatic fringing: warm orange on one side, cool blue on the other
  float edgeness = smoothstep(0.0, 0.35 * spread, abs(delta.x));

  // Warm fringe color (orange) and cool fringe color (blue)
  vec3 warmFringe = vec3(1.00, 0.55, 0.15);
  vec3 coolFringe = vec3(0.15, 0.35, 1.00);

  // Blend from the light tint at center to directional fringe at edges
  vec3 leftColor = mix(tint, warmFringe, edgeness);
  vec3 rightColor = mix(tint, coolFringe, edgeness);
  vec3 streakTint = mix(leftColor, rightColor, smoothstep(-0.1, 0.1, delta.x));

  // Build streak color with chromatic separation
  vec3 streakCol = vec3(0.0);
  streakCol.r = streakR * streakTint.r;
  streakCol.g = streak * streakTint.g;
  streakCol.b = streakB * streakTint.b;

  // ── Secondary wider, dimmer streak for extra softness ──
  float wideStretch = stretch * 1.6;
  float wideDx = delta.x / wideStretch;
  float wideD = wideDx * wideDx * 8.0 + streakDy * streakDy * 700.0;
  float wideStreak = exp(-wideD) * brightness * 0.15;
  vec3 wideCol = mix(tint * 0.6, mix(warmFringe, coolFringe, smoothstep(-0.2, 0.2, delta.x)) * 0.4, edgeness) * wideStreak;

  // ── Bokeh halo around the brightest point ──
  float haloR = 0.05 + brightness * 0.015;
  float haloDist = abs(coreD - haloR);
  float halo = exp(-haloDist * haloDist * 3500.0) * brightness * 0.10;
  float haloR2 = haloR * 1.8;
  float haloDist2 = abs(coreD - haloR2);
  float halo2 = exp(-haloDist2 * haloDist2 * 5000.0) * brightness * 0.04;
  vec3 haloCol = tint * 0.8 * halo + vec3(0.50, 0.60, 0.80) * halo2;

  return coreCol + streakCol + wideCol + haloCol;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float aspect = u_res.x / u_res.y;
  float t = u_time * u_driftSpeed;


  // ── Layer 1: Pure black background ──
  vec3 col = vec3(0.0);

  // ── Ambient warm haze field (subtle noise-based glow) ──
  vec2 hazeUV = uv * 1.5 + vec2(t * 0.01, t * 0.007);
  float hazeNoise = fbm(hazeUV);
  float hazeNoise2 = fbm(hazeUV * 0.7 + vec2(5.3, 2.1));
  vec3 hazeColor = mix(vec3(0.35, 0.22, 0.10), vec3(0.12, 0.15, 0.30), hazeNoise2);
  col += hazeColor * hazeNoise * 0.03;

  // ── Light sources with anamorphic flares and bokeh ──
  for (int i = 0; i < NUM_LIGHTS; i++) {
    vec2 lp = lightPos(i, t);
    float bright = lightBrightness(i, t);
    vec3 tint = lightTint(i);
    col += anamorphicFlare(uv, lp, bright, u_flareSpread, tint);
  }

  // ── Mouse: cursor becomes an additional light source ──
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    col += anamorphicFlare(uv, mUV, 0.8, u_flareSpread, vec3(0.9, 0.8, 0.6));
  }

  // ── Lens dust / sparkle noise ──
  vec2 dustUV = gl_FragCoord.xy * 0.8;
  float dustNoise = hash(dustUV + fract(u_time * 0.7) * 200.0);
  float dust = smoothstep(0.985, 1.0, dustNoise);
  float dustLight = 0.0;
  for (int i = 0; i < NUM_LIGHTS; i++) {
    vec2 lp = lightPos(i, t);
    float d = length(uv - lp);
    dustLight += exp(-d * d * 8.0) * lightBrightness(i, t);
  }
  dustLight = min(dustLight, 1.2);
  col += vec3(0.9, 0.85, 0.7) * dust * dustLight * 0.4;

  // ── Subtle warm ambient haze near lights ──
  float haze = 0.0;
  for (int i = 0; i < NUM_LIGHTS; i++) {
    vec2 lp = lightPos(i, t);
    float d = length(uv - lp);
    haze += exp(-d * d * 3.0) * lightBrightness(i, t) * 0.012;
  }
  col += vec3(0.40, 0.25, 0.12) * haze;

  // ── Film grain ──
  vec2 grainSeed = gl_FragCoord.xy + fract(u_time * 60.0) * vec2(1973.0, 9277.0);
  float grain = (hash(grainSeed) - 0.5) * 0.03;
  col += grain;

  // ── Vignette ──
  float vd = length(uv * vec2(1.2, 1.0));
  float vignette = 1.0 - smoothstep(0.3, 0.95, vd);
  vignette = vignette * vignette;
  col *= vignette;

  // ── Tone mapping ──
  col = max(col, vec3(0.0));
  col = col / (col + vec3(0.6)) * 1.5;

  gl_FragColor = vec4(col, 1.0);
}
