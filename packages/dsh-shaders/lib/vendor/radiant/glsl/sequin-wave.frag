precision highp float;

uniform float u_time;
uniform vec2 u_res;
uniform float u_waveSpeed;
uniform float u_sparkle;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718
#define SQRT3 1.7320508

// ── Hash functions for per-sequin variation ──
float hash21(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  float n = hash21(p);
  return vec2(n, hash21(p + n * 47.0));
}

// ── Hexagonal tiling ──
// Returns: xy = local coords within hex cell, zw = cell ID
vec4 hexTile(vec2 p, float scale) {
  p *= scale;
  // Two candidate grids offset by half a cell
  vec2 s = vec2(1.0, SQRT3);
  vec2 halfS = s * 0.5;

  // Grid A
  vec2 aBase = floor(p / s);
  vec2 aLocal = mod(p, s) - halfS;

  // Grid B (offset)
  vec2 pOff = p - halfS;
  vec2 bBase = floor(pOff / s);
  vec2 bLocal = mod(pOff, s) - halfS;

  // Pick nearest center
  float dA = dot(aLocal, aLocal);
  float dB = dot(bLocal, bLocal);

  // Use step to avoid branching
  float pick = step(dA, dB);
  vec2 localCoord = mix(bLocal, aLocal, pick);
  vec2 cellId = mix(bBase + vec2(0.5), aBase, pick);

  return vec4(localCoord, cellId);
}

// ── Wave field: multiple interfering wave sources ──
float waveField(vec2 cellPos, float t) {
  float w = 0.0;

  // Wave 1: diagonal sweep
  w += sin(dot(cellPos, vec2(0.7, 0.5)) * 3.5 - t * 2.8) * 0.35;

  // Wave 2: horizontal ripple
  w += sin(cellPos.x * 4.2 + t * 1.9) * 0.25;

  // Wave 3: radial pulse from offset center
  float r1 = length(cellPos - vec2(-0.3, 0.2));
  w += sin(r1 * 6.0 - t * 3.2) * 0.2 * smoothstep(1.2, 0.0, r1);

  // Wave 4: slower diagonal from opposite direction
  w += sin(dot(cellPos, vec2(-0.4, 0.8)) * 2.8 - t * 1.5) * 0.2;

  // Wave 5: secondary radial from other side
  float r2 = length(cellPos - vec2(0.4, -0.3));
  w += sin(r2 * 5.0 - t * 2.4) * 0.15 * smoothstep(1.0, 0.0, r2);

  return w;
}

// ── Specular calculation for a tilted sequin disc ──
// tiltAngle: how much the sequin is tilted by the wave
// tiltDir: direction of the tilt (2D angle)
// Returns specular intensity
float sequinSpecular(float tiltAngle, float tiltDir, vec2 uv) {
  // Sequin normal: starts as (0,0,1), tilted by wave
  float ct = cos(tiltAngle);
  float st = sin(tiltAngle);
  float cd = cos(tiltDir);
  float sd = sin(tiltDir);

  // Normal of tilted disc
  vec3 N = vec3(st * cd, st * sd, ct);

  // Light direction (from upper-right, slightly behind camera)
  vec3 L = normalize(vec3(0.4, 0.6, 0.9));

  // View direction (straight on)
  vec3 V = vec3(0.0, 0.0, 1.0);

  // Reflection of light off sequin surface
  vec3 R = reflect(-L, N);

  // Specular: how well reflection aligns with view
  float spec = max(dot(R, V), 0.0);

  // Very tight specular for mirror-like sequins
  spec = pow(spec, 48.0);

  // Secondary broader highlight for ambient sheen
  float sheen = pow(max(dot(R, V), 0.0), 8.0) * 0.15;

  return spec + sheen;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float t = u_time * u_waveSpeed;

  // ── Hexagonal grid of sequins ──
  float sequinScale = 38.0; // density of sequins
  vec4 hex = hexTile(uv, sequinScale);
  vec2 localPos = hex.xy;  // position within cell
  vec2 cellId = hex.zw;    // which cell

  // ── Per-sequin random variation ──
  vec2 rnd = hash22(cellId);
  float sizeVar = 0.85 + rnd.x * 0.3;       // size variation
  float baseTilt = (rnd.y - 0.5) * 0.15;     // resting tilt offset
  float reflVar = 0.7 + rnd.x * 0.3;         // reflectivity variation
  float phaseOff = rnd.y * TAU;               // phase offset for shimmer

  // ── Sequin disc shape ──
  float discRadius = 0.42 * sizeVar;
  float dist = length(localPos);
  float disc = smoothstep(discRadius, discRadius - 0.06, dist);

  // Subtle edge bevel highlight
  float bevel = smoothstep(discRadius, discRadius - 0.04, dist)
              - smoothstep(discRadius - 0.04, discRadius - 0.08, dist);

  // ── World position of this sequin (for wave sampling) ──
  vec2 worldPos = cellId / sequinScale;

  // ── Wave-driven tilt ──
  float wave = waveField(worldPos, t);

  // Add subtle individual shimmer
  float shimmer = sin(t * 3.0 + phaseOff) * 0.04;

  // Tilt angle from wave + individual variation
  float tiltAngle = wave * 0.85 + baseTilt + shimmer;

  // Tilt direction: follows the wave gradient
  // Approximate gradient with offset samples
  float waveH = waveField(worldPos + vec2(0.01, 0.0), t);
  float waveV = waveField(worldPos + vec2(0.0, 0.01), t);
  float tiltDir = atan(waveV - wave, waveH - wave);

  // ── Mouse light source: extra specular from cursor ──
  float mouseSpec = 0.0;
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    float mDist = length(worldPos - mUV);
    float mInfluence = exp(-mDist * mDist * 6.0);
    // Light from mouse position
    vec3 mLightDir = normalize(vec3(mUV.x - worldPos.x, mUV.y - worldPos.y, 0.5));
    float ct = cos(tiltAngle);
    float st2 = sin(tiltAngle);
    float cd = cos(tiltDir);
    float sd = sin(tiltDir);
    vec3 mN = vec3(st2 * cd, st2 * sd, ct);
    vec3 mR = reflect(-mLightDir, mN);
    float mS = pow(max(dot(mR, vec3(0.0, 0.0, 1.0)), 0.0), 32.0);
    mouseSpec = mS * mInfluence * 1.5;
  }

  // ── Specular flash ──
  float spec = sequinSpecular(tiltAngle, tiltDir, uv);
  spec *= reflVar * u_sparkle;
  spec += mouseSpec * reflVar;

  // ── Color composition ──
  // Dark base: sequin that is tilted away from light
  vec3 darkSequin = vec3(0.02, 0.015, 0.01);

  // Mid-tone: ambient copper reflection
  vec3 copperMid = vec3(0.78, 0.58, 0.42);

  // Bright flash: hot amber/gold when specular aligns
  vec3 amberFlash = vec3(1.0, 0.82, 0.55);

  // Hot white-gold for peak brightness
  vec3 hotGold = vec3(1.0, 0.92, 0.72);

  // Base sequin color depends on tilt (how much it faces camera)
  float facing = cos(tiltAngle) * 0.5 + 0.5;
  facing = clamp(facing, 0.0, 1.0);

  // Warm ambient: even dark sequins have a hint of warmth
  vec3 ambient = mix(darkSequin, vec3(0.05, 0.035, 0.02), facing * 0.6);

  // Build up the specular flash in layers
  vec3 sequinColor = ambient;

  // Broad warm sheen
  float sheenAmount = pow(max(facing, 0.0), 3.0) * 0.2 * reflVar;
  sequinColor += copperMid * sheenAmount;

  // Specular flash
  float flashLow = smoothstep(0.0, 0.3, spec);
  float flashHigh = smoothstep(0.3, 0.8, spec);
  float flashPeak = smoothstep(0.7, 1.0, spec);
  sequinColor += copperMid * flashLow * 0.5;
  sequinColor += amberFlash * flashHigh * 0.8;
  sequinColor += hotGold * flashPeak * 1.2;

  // Bevel edge catches light differently
  sequinColor += copperMid * bevel * facing * 0.3;

  // ── Background between sequins ──
  // Dark gap with very subtle warm tone
  vec3 bgColor = vec3(0.012, 0.008, 0.005);

  // ── Final mix: disc mask selects sequin vs gap ──
  vec3 col = mix(bgColor, sequinColor, disc);

  // ── Global lighting: subtle gradient from light direction ──
  vec2 uvSafe = uv + vec2(0.0001);
  float globalLight = 0.85 + 0.15 * dot(normalize(uvSafe), vec2(0.4, 0.6));
  col *= globalLight;

  // ── Vignette ──
  float vig = 1.0 - smoothstep(0.4, 1.3, length(uv));
  col *= 0.6 + 0.4 * vig;

  // ── Warm gamma correction ──
  col = pow(max(col, vec3(0.0)), vec3(0.93, 0.97, 1.04));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
