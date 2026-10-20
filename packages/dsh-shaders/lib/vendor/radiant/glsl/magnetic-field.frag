precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_waveSpeed;
uniform float u_lineCount;
uniform vec2 u_mouse;

#define S smoothstep
#define PI 3.14159265

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

// Rotate 2D
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Analytical dipole field line distance.
// Field lines satisfy: r = R_k * sin^2(theta) in polar coords.
// For a pixel at (r, theta), the field line passing through it has R = r / sin^2(theta).
// We quantize R into discrete lines and measure how far this pixel is from the nearest one.
float fieldLineGlow(vec2 lp, float numLines, float t) {
  float r = length(lp);
  if (r < 0.01) return 0.0;
  float theta = atan(abs(lp.y), lp.x);

  // Avoid singularity at theta=0 and theta=PI
  float sinT = sin(theta);
  if (sinT < 0.05) return 0.0;

  // The field line constant for this pixel
  float R = r / (sinT * sinT);

  // Quantize into discrete field lines
  float spacing = 0.8 / numLines;
  float lineIdx = R / spacing;
  float nearest = floor(lineIdx + 0.5) * spacing;

  // Distance in R-space, convert to approximate screen distance
  float dR = abs(R - nearest);
  // dr/dR at this theta: dr = sin^2(theta) * dR
  float screenDist = dR * sinT * sinT;

  // Silk-style glow: thin bright core with edge fade
  float lw = 0.06 * S(0.05, 0.5, r);
  float l = S(lw, 0.0, screenDist - 0.004);

  // Fade at extremities
  float fade = S(0.9, 0.2, r) * S(0.0, 0.05, sinT);

  // Energy pulse flowing along the field lines (theta = path parameter)
  float pulse = pow(sin(theta * 3.0 - t * 1.5) * 0.5 + 0.5, 3.0);
  float brightness = 0.4 + pulse * 0.6;

  return l * fade * brightness;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  float t = u_time * u_waveSpeed;

  // Poles — mouse rotates the dipole axis
  float poleAngle = 0.0;
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - 0.5 * u_res.xy) / u_res.y;
    poleAngle = atan(mUV.y, mUV.x);
  }
  vec2 pole1 = vec2(cos(poleAngle), sin(poleAngle)) * -0.3;
  vec2 pole2 = vec2(cos(poleAngle), sin(poleAngle)) * 0.3;
  vec2 center = vec2(0.0);
  vec2 axis = normalize(pole2 - pole1);

  // Transform uv into dipole-local coords (axis-aligned)
  vec2 lp = uv - center;
  lp = vec2(dot(lp, axis), dot(lp, vec2(-axis.y, axis.x)));

  // Noise perturbation
  float n = noise(vec2(lp.x * 3.0, t * 0.1)) * 0.01;
  lp += vec2(n, n * 0.5);

  float numLines = u_lineCount;

  // Compute glow for both halves of the dipole (y>0 and y<0)
  // Upper half
  float glow1 = fieldLineGlow(lp, numLines, t);
  // Lower half (mirror)
  float glow2 = fieldLineGlow(vec2(lp.x, -lp.y), numLines, t);
  float glow = max(glow1, glow2);


  // Color: warm amber gradient based on position
  float r = length(uv);
  float angle = atan(lp.y, lp.x) / PI;
  vec3 lineCol = vec3(
    0.35 + abs(angle) * 0.55,
    0.25 + abs(angle) * 0.3,
    0.3 + (1.0 - abs(angle)) * 0.1
  );

  vec3 col = glow * lineCol;

  // Subtle glow at poles
  float g1 = 0.006 / (length(uv - pole1) + 0.01);
  float g2 = 0.006 / (length(uv - pole2) + 0.01);
  col += vec3(0.9, 0.6, 0.3) * (g1 + g2) * 0.12;

  // ── Vignette ──
  float vig = 1.0 - dot(uv, uv) * 0.4;
  col *= max(vig, 0.0);

  gl_FragColor = vec4(col, 1.0);
}
