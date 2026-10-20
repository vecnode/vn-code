precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_driftSpeed;
uniform float u_grain;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define NUM_PRIMARY 5
#define NUM_SECONDARY 7

// ── Hash for noise ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash1(float n) {
  return fract(sin(n) * 43758.5453123);
}

// ── Smooth value noise ──
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

// ── Gaussian orb: exponential distance falloff ──
vec3 orb(vec2 uv, vec2 center, vec3 color, float radius, float intensity) {
  float d = length(uv - center);
  float k = 1.0 / (radius * radius);
  float glow = exp(-d * d * k) * intensity;
  return color * glow;
}

// ── Film grain ──
float filmGrain(vec2 uv, float t) {
  vec2 seed = uv * vec2(1973.0, 9277.0) + vec2(t * 311.7, t * 127.1);
  return fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float aspect = u_res.x / u_res.y;
  float t = u_time * u_driftSpeed;


  // ── Layer 1: Pure black background ──
  vec3 col = vec3(0.0);

  // ── Layer 2: Primary color orbs (5 large, soft) ──

  // Orb colors — VIVID, near-max saturation
  vec3 cobalt    = vec3(0.03, 0.10, 1.00);
  vec3 orange    = vec3(1.00, 0.42, 0.03);
  vec3 whiteBlue = vec3(0.85, 0.93, 1.00);
  vec3 amber     = vec3(1.00, 0.70, 0.08);
  vec3 teal      = vec3(0.03, 0.65, 0.65);

  // Noise perturbation for organic drift
  float n1 = noise(vec2(t * 0.37, 1.0)) * 2.0 - 1.0;
  float n2 = noise(vec2(t * 0.41, 2.3)) * 2.0 - 1.0;
  float n3 = noise(vec2(t * 0.33, 3.7)) * 2.0 - 1.0;
  float n4 = noise(vec2(t * 0.29, 5.1)) * 2.0 - 1.0;
  float n5 = noise(vec2(t * 0.43, 6.9)) * 2.0 - 1.0;
  float n6 = noise(vec2(t * 0.31, 8.2)) * 2.0 - 1.0;
  float n7 = noise(vec2(t * 0.39, 9.5)) * 2.0 - 1.0;
  float n8 = noise(vec2(t * 0.27, 10.8)) * 2.0 - 1.0;
  float n9 = noise(vec2(t * 0.35, 12.1)) * 2.0 - 1.0;
  float n10 = noise(vec2(t * 0.45, 13.4)) * 2.0 - 1.0;

  // Primary orb 1: Deep cobalt blue - wide elliptical orbit
  vec2 p1 = vec2(
    cos(t * 0.23 + 0.0) * 0.55 + n1 * 0.08,
    sin(t * 0.17 + 0.0) * 0.35 + n2 * 0.06
  );
  col += orb(uv, p1, cobalt, 0.30, 1.6);

  // Primary orb 2: Warm burnt orange - opposing orbit
  vec2 p2 = vec2(
    cos(t * 0.19 + 2.1) * 0.50 + n3 * 0.09,
    sin(t * 0.25 + 1.4) * 0.38 + n4 * 0.07
  );
  col += orb(uv, p2, orange, 0.28, 1.5);

  // Primary orb 3: Cool white-blue - slow vertical drift
  vec2 p3 = vec2(
    cos(t * 0.15 + 4.2) * 0.42 + n5 * 0.07,
    sin(t * 0.21 + 3.0) * 0.45 + n6 * 0.06
  );
  col += orb(uv, p3, whiteBlue, 0.26, 1.2);

  // Primary orb 4: Amber gold - figure-eight drift
  vec2 p4 = vec2(
    sin(t * 0.17 + 1.0) * cos(t * 0.11 + 0.5) * 0.55 + n7 * 0.08,
    sin(t * 0.13 + 2.5) * 0.35 + n8 * 0.06
  );
  col += orb(uv, p4, amber, 0.27, 1.3);

  // Primary orb 5: Subtle teal - slow large ellipse
  vec2 p5 = vec2(
    cos(t * 0.13 + 5.5) * 0.48 + n9 * 0.07,
    sin(t * 0.19 + 4.8) * 0.30 + n10 * 0.08
  );
  col += orb(uv, p5, teal, 0.32, 1.2);

  // ── Layer 3: Secondary smaller dimmer orbs for depth ──

  // Secondary orb colors: muted versions and blends
  vec3 dimCobalt = vec3(0.08, 0.15, 0.50);
  vec3 dimOrange = vec3(0.60, 0.28, 0.08);
  vec3 dimWhite  = vec3(0.50, 0.55, 0.70);
  vec3 dimAmber  = vec3(0.65, 0.42, 0.15);
  vec3 dimTeal   = vec3(0.08, 0.35, 0.35);
  vec3 dimViolet = vec3(0.25, 0.15, 0.50);
  vec3 dimRose   = vec3(0.55, 0.25, 0.30);

  float sn1 = noise(vec2(t * 0.51, 20.0)) * 2.0 - 1.0;
  float sn2 = noise(vec2(t * 0.47, 21.3)) * 2.0 - 1.0;
  float sn3 = noise(vec2(t * 0.53, 22.7)) * 2.0 - 1.0;
  float sn4 = noise(vec2(t * 0.43, 24.1)) * 2.0 - 1.0;
  float sn5 = noise(vec2(t * 0.49, 25.5)) * 2.0 - 1.0;
  float sn6 = noise(vec2(t * 0.55, 26.9)) * 2.0 - 1.0;
  float sn7 = noise(vec2(t * 0.41, 28.3)) * 2.0 - 1.0;
  float sn8 = noise(vec2(t * 0.57, 29.7)) * 2.0 - 1.0;
  float sn9 = noise(vec2(t * 0.39, 31.1)) * 2.0 - 1.0;
  float sn10 = noise(vec2(t * 0.61, 32.5)) * 2.0 - 1.0;
  float sn11 = noise(vec2(t * 0.37, 33.9)) * 2.0 - 1.0;
  float sn12 = noise(vec2(t * 0.59, 35.3)) * 2.0 - 1.0;
  float sn13 = noise(vec2(t * 0.45, 36.7)) * 2.0 - 1.0;
  float sn14 = noise(vec2(t * 0.63, 38.1)) * 2.0 - 1.0;

  vec2 s1 = vec2(
    cos(t * 0.31 + 0.7) * 0.45 + sn1 * 0.08,
    sin(t * 0.27 + 1.2) * 0.35 + sn2 * 0.07
  );
  col += orb(uv, s1, dimCobalt, 0.18, 0.20);

  vec2 s2 = vec2(
    cos(t * 0.25 + 3.1) * 0.60 + sn3 * 0.09,
    sin(t * 0.33 + 2.5) * 0.42 + sn4 * 0.06
  );
  col += orb(uv, s2, dimOrange, 0.16, 0.18);

  vec2 s3 = vec2(
    cos(t * 0.29 + 5.3) * 0.55 + sn5 * 0.07,
    sin(t * 0.23 + 4.1) * 0.45 + sn6 * 0.08
  );
  col += orb(uv, s3, dimWhite, 0.14, 0.15);

  vec2 s4 = vec2(
    sin(t * 0.21 + 1.8) * 0.58 + sn7 * 0.06,
    cos(t * 0.29 + 0.3) * 0.40 + sn8 * 0.07
  );
  col += orb(uv, s4, dimAmber, 0.17, 0.18);

  vec2 s5 = vec2(
    cos(t * 0.35 + 2.9) * 0.52 + sn9 * 0.08,
    sin(t * 0.19 + 5.7) * 0.48 + sn10 * 0.06
  );
  col += orb(uv, s5, dimTeal, 0.15, 0.15);

  vec2 s6 = vec2(
    cos(t * 0.17 + 4.5) * 0.62 + sn11 * 0.07,
    sin(t * 0.31 + 3.3) * 0.38 + sn12 * 0.09
  );
  col += orb(uv, s6, dimViolet, 0.16, 0.15);

  vec2 s7 = vec2(
    sin(t * 0.27 + 6.1) * cos(t * 0.15 + 0.8) * 0.50 + sn13 * 0.06,
    cos(t * 0.23 + 5.0) * 0.42 + sn14 * 0.08
  );
  col += orb(uv, s7, dimRose, 0.14, 0.12);



  // ── Layer 5: Vignette ──
  float vd = length(uv * vec2(1.1, 1.0));
  float vignette = 1.0 - smoothstep(0.5, 1.1, vd);
  col *= vignette;

  // Clamp to avoid artifacts
  col = max(col, vec3(0.0));

  // Minimal tone mapping — just a soft knee to avoid hard clipping
  // where overlap creates values > 1, gently compress; otherwise pass through
  col = mix(col, sqrt(col), smoothstep(0.6, 1.5, col));

  // Mouse: brighten blooms near cursor + add warm glow
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    float mDist = length(uv - mUV);
    float attract = exp(-mDist * mDist * 4.0);
    col *= 1.0 + attract * 1.5;
    col += vec3(0.8, 0.6, 0.9) * attract * 0.08;
  }
  // ── Film grain (applied in display space, after tone mapping) ──
  float grain = fract(sin(dot(gl_FragCoord.xy + fract(u_time) * 100.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * 0.3 * u_grain;
  gl_FragColor = vec4(col, 1.0);
}
