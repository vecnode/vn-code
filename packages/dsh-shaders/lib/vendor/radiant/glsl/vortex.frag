precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_waveSpeed;
uniform float u_lineCount;
uniform vec2 u_mouse;

#define S smoothstep
#define PI 3.14159265
#define TAU 6.28318530

// ── Hash for noise ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

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

// Distance from point to nearest logarithmic spiral arm
// Spiral: r = a * exp(b * theta)
// Inverted: theta = ln(r/a) / b
// For a given r, the spiral passes at angles theta_n = (ln(r/a)/b) + n*TAU
// We find the closest arm by checking angular distance
float spiralDist(vec2 uv, float a, float b, float numArms, float t) {
  float r = length(uv);
  if (r < 0.001) return 1e6;
  float angle = atan(uv.y, uv.x);

  // Where does the spiral cross this radius?
  float baseTheta = log(r / a) / b;

  // Add time rotation
  baseTheta -= t * 0.3 + u_mouse.x;

  // Find nearest arm
  float armSpacing = TAU / numArms;
  float nearest = mod(angle - baseTheta, armSpacing);
  if (nearest > armSpacing * 0.5) nearest -= armSpacing;

  // Convert angular distance to approximate Euclidean distance
  // d ~ r * |delta_theta| for small angles
  float d = abs(nearest) * r;

  // Add sine undulation along the spiral
  float undulation = sin(baseTheta * 4.0 + t * 0.5) * 0.015;
  d += undulation;
  d = abs(d);

  return d;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  float t = u_time * u_waveSpeed;

  // Center drifts slowly
  vec2 center = vec2(sin(t * 0.07) * 0.05, cos(t * 0.09) * 0.04);
  vec2 p = uv - center;

  float r = length(p);
  int lineCount = int(u_lineCount);

  vec3 col = vec3(0.0);

  for (int i = 0; i < 10; i++) {
    if (i >= lineCount) break;
    float fi = float(i);
    float frac = fi / max(u_lineCount - 1.0, 1.0);

    // Each layer: different tightness and scale
    float a = 0.02 + frac * 0.03;
    float b = 0.15 + frac * 0.08;
    float numArms = 3.0 + fi;

    // Noise perturbation
    float nOff = noise(vec2(fi * 3.7, t * 0.1)) * 0.008;

    float dist = spiralDist(p + vec2(nOff), a, b, numArms, t + fi * 0.5);

    // Silk glow: thin bright core with edge fade
    float lw = 0.05 * S(0.1, 0.6, r);
    float l = S(lw, 0.0, dist - 0.004);

    // Brighten toward center, fade at edge
    float radialFade = S(0.9, 0.15, r) * S(0.0, 0.04, r);

    // Color: warm amber to gold
    vec3 lineCol = vec3(
      0.25 + frac * 0.65,
      0.2 + frac * 0.4,
      0.25 + (1.0 - frac) * 0.15
    );

    col += l * lineCol * radialFade;
  }

  // Central glow
  float centerGlow = 0.015 / (r + 0.02);
  col += vec3(0.9, 0.65, 0.35) * centerGlow * 0.15;

  // ── Vignette ──
  float vig = 1.0 - dot(uv, uv) * 0.4;
  col *= max(vig, 0.0);

  gl_FragColor = vec4(col, 1.0);
}
