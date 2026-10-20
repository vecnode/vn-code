precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_heatIntensity;
uniform float u_colorVibrancy;
uniform vec2 u_mouse;

// ── Hash / noise primitives ──
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289v2(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// ── Fractal Brownian motion ──
float fbm(vec2 p, float t) {
  float val = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 6; i++) {
    val += amp * snoise(p * freq + t * 0.25);
    freq *= 2.05;
    amp *= 0.5;
    p += vec2(1.7, 9.2);
  }
  return val;
}

// ── Domain-warped fbm for organic heat flow ──
float warpedFbm(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, 0.0), t),
               fbm(p + vec2(5.2, 1.3), t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2), t * 1.15),
               fbm(p + 3.0 * q + vec2(8.3, 2.8), t * 1.15));
  return fbm(p + 2.5 * r, t * 0.9);
}

// ── Heat shimmer distortion field ──
vec2 heatDistortion(vec2 uv, float t, float intensity) {
  // Multiple octaves of rising heat waves
  // Heat rises: dominant vertical motion, slower horizontal drift
  float n1 = snoise(vec2(uv.x * 3.0, uv.y * 6.0 - t * 1.8)) * 0.5;
  float n2 = snoise(vec2(uv.x * 5.0 + 1.3, uv.y * 10.0 - t * 2.5 + 3.7)) * 0.3;
  float n3 = snoise(vec2(uv.x * 8.0 - 2.1, uv.y * 4.0 - t * 1.2 + 7.1)) * 0.2;

  // Horizontal shimmer (less intense, more wavy)
  float h1 = snoise(vec2(uv.x * 4.0 + t * 0.8, uv.y * 7.0 - t * 1.5)) * 0.4;
  float h2 = snoise(vec2(uv.x * 7.0 - t * 0.5, uv.y * 3.0 + 2.3)) * 0.25;

  vec2 distort;
  distort.x = (h1 + h2) * intensity * 0.025;
  distort.y = (n1 + n2 + n3) * intensity * 0.018;

  return distort;
}

// ── Tropical color palette ──
vec3 tropicalColor(float t, float vibrancy) {
  // Warm base: deep magenta, hot orange, electric amber, warm teal
  vec3 a = vec3(0.55, 0.3, 0.25);
  vec3 b = vec3(0.45, 0.35, 0.3);
  vec3 c = vec3(1.0, 0.8, 0.7);
  vec3 d = vec3(0.0, 0.15, 0.35);
  vec3 col = a + b * cos(6.28318 * (c * t + d));
  // Boost saturation with vibrancy
  float luminance = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luminance), col, 1.0 + vibrancy * 0.6);
  return col;
}

vec3 magentaOrange(float t, float vibrancy) {
  vec3 a = vec3(0.6, 0.2, 0.35);
  vec3 b = vec3(0.4, 0.3, 0.25);
  vec3 c = vec3(1.2, 1.0, 0.6);
  vec3 d = vec3(0.1, 0.25, 0.45);
  vec3 col = a + b * cos(6.28318 * (c * t + d));
  float luminance = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luminance), col, 1.0 + vibrancy * 0.5);
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 heatCenter = vec2(0.5);
  if (u_mouse.x > 0.0) {
    vec2 mUV = u_mouse / u_res;
    heatCenter = mix(vec2(0.5), mUV, 0.3);
  }
  vec2 p = (gl_FragCoord.xy - u_res * heatCenter) / min(u_res.x, u_res.y);
  float t = u_time;

  // ── Heat distortion ──
  vec2 distort = heatDistortion(uv, t, u_heatIntensity);

  // ── Chromatic aberration: offset RGB channels differently ──
  float aberration = u_heatIntensity * 0.012;
  // Each channel gets a different distortion direction
  vec2 uvR = uv + distort * 1.3 + vec2(aberration, aberration * 0.5);
  vec2 uvG = uv + distort * 1.0;
  vec2 uvB = uv + distort * 0.7 - vec2(aberration * 0.8, aberration * 0.3);

  // Convert back to centered coords for noise sampling
  vec2 pR = (uvR * u_res - u_res * 0.5) / min(u_res.x, u_res.y);
  vec2 pG = (uvG * u_res - u_res * 0.5) / min(u_res.x, u_res.y);
  vec2 pB = (uvB * u_res - u_res * 0.5) / min(u_res.x, u_res.y);

  // ── Base pattern: domain-warped noise in tropical colors ──
  float warpR = warpedFbm(pR * 1.5, t * 0.3);
  float warpG = warpedFbm(pG * 1.5, t * 0.3 + 0.7);
  float warpB = warpedFbm(pB * 1.5, t * 0.3 + 1.4);

  // ── Layer 1: Deep flowing heat base ──
  vec3 baseColor;
  baseColor.r = tropicalColor(warpR * 0.8 + t * 0.05, u_colorVibrancy).r;
  baseColor.g = tropicalColor(warpG * 0.8 + t * 0.05 + 0.33, u_colorVibrancy).g;
  baseColor.b = magentaOrange(warpB * 0.8 + t * 0.05 + 0.66, u_colorVibrancy).b;

  // ── Layer 2: Hot magenta/orange undercurrent ──
  float flow1 = snoise(p * 2.5 + vec2(t * 0.4, -t * 0.3));
  float flow2 = snoise(p * 3.8 + vec2(-t * 0.35, t * 0.25));
  float flowMask = smoothstep(-0.2, 0.6, flow1 * flow2);

  vec3 hotLayer = magentaOrange(flow1 * 0.5 + t * 0.08, u_colorVibrancy);
  hotLayer *= vec3(1.1, 0.7, 0.9); // push toward hot orange-magenta
  baseColor = mix(baseColor, hotLayer, flowMask * 0.4 * u_colorVibrancy);

  // ── Layer 3: Warm teal accents (subtle, deep) ──
  float tealNoise = snoise(p * 4.0 + vec2(t * 0.2, t * 0.15 + 5.0));
  float tealMask = smoothstep(0.3, 0.8, tealNoise) * 0.15 * u_colorVibrancy;
  baseColor = mix(baseColor, vec3(0.1, 0.45, 0.4), tealMask);

  // ── Color blooms: periodic bursts of vivid color ──
  // Bloom 1: slow, large
  float bloomTime1 = sin(t * 0.4) * 0.5 + 0.5;
  bloomTime1 = pow(bloomTime1, 6.0); // sharp peak
  vec2 bloomCenter1 = vec2(
    snoise(vec2(t * 0.13, 0.0)) * 0.4,
    snoise(vec2(0.0, t * 0.11 + 3.0)) * 0.4
  );
  float bloomDist1 = length(p - bloomCenter1);
  float bloom1 = bloomTime1 * smoothstep(0.5, 0.0, bloomDist1);
  vec3 bloomColor1 = vec3(0.95, 0.4, 0.2); // hot orange burst

  // Bloom 2: faster, smaller, magenta
  float bloomTime2 = sin(t * 0.7 + 2.1) * 0.5 + 0.5;
  bloomTime2 = pow(bloomTime2, 8.0);
  vec2 bloomCenter2 = vec2(
    snoise(vec2(t * 0.17 + 7.0, 2.0)) * 0.35,
    snoise(vec2(3.0, t * 0.14 + 5.0)) * 0.35
  );
  float bloomDist2 = length(p - bloomCenter2);
  float bloom2 = bloomTime2 * smoothstep(0.35, 0.0, bloomDist2);
  vec3 bloomColor2 = vec3(0.85, 0.15, 0.5); // deep magenta burst

  // Bloom 3: amber intensity spike
  float bloomTime3 = sin(t * 0.55 + 4.3) * 0.5 + 0.5;
  bloomTime3 = pow(bloomTime3, 7.0);
  vec2 bloomCenter3 = vec2(
    snoise(vec2(t * 0.1 + 12.0, 8.0)) * 0.3,
    snoise(vec2(6.0, t * 0.09 + 10.0)) * 0.3
  );
  float bloomDist3 = length(p - bloomCenter3);
  float bloom3 = bloomTime3 * smoothstep(0.45, 0.0, bloomDist3);
  vec3 bloomColor3 = vec3(1.0, 0.65, 0.1); // electric amber burst

  // Apply blooms additively
  baseColor += bloomColor1 * bloom1 * 0.7 * u_colorVibrancy;
  baseColor += bloomColor2 * bloom2 * 0.6 * u_colorVibrancy;
  baseColor += bloomColor3 * bloom3 * 0.5 * u_colorVibrancy;

  // ── Intensity spikes: occasional wave of extra heat ──
  float spike = pow(sin(t * 0.25) * 0.5 + 0.5, 12.0);
  float spikeWave = snoise(p * 1.5 - vec2(0.0, t * 0.8)) * 0.5 + 0.5;
  baseColor += vec3(0.2, 0.08, 0.03) * spike * spikeWave * u_heatIntensity;

  // ── Heat haze highlight: bright shimmering lines ──
  float haze = snoise(vec2(p.x * 6.0, p.y * 12.0 - t * 2.0));
  float hazeLines = pow(smoothstep(0.4, 0.9, haze), 3.0);
  baseColor += vec3(0.15, 0.08, 0.04) * hazeLines * u_heatIntensity * 0.5;

  // ── Grounding: dark base with warm amber DNA ──
  // Ensure darks are truly dark, anchor to the project palette
  float luminance = dot(baseColor, vec3(0.299, 0.587, 0.114));
  vec3 amberTint = vec3(0.78, 0.58, 0.42) * luminance;
  baseColor = mix(baseColor, amberTint, 0.12);

  // ── Vignette: hot center fading to dark edges ──
  float vig = 1.0 - dot(p, p) * 0.5;
  vig = clamp(vig, 0.0, 1.0);
  vig = pow(vig, 0.7);
  baseColor *= vig;

  // ── Tone mapping: prevent blowout ──
  baseColor = baseColor / (1.0 + baseColor * 0.25);

  // ── Final contrast and warmth ──
  baseColor = pow(baseColor, vec3(0.95));
  baseColor *= vec3(1.05, 0.97, 0.88); // warm final push

  gl_FragColor = vec4(baseColor, 1.0);
}
