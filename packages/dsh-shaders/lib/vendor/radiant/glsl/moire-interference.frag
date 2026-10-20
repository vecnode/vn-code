precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_ringDensity;
uniform float u_driftSpeed;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

// ── Hash for grain texture ──
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── Concentric ring pattern from a center point ──
// Returns a value in [-1, 1] based on sine of distance
float rings(vec2 uv, vec2 center, float freq) {
  float d = length(uv - center);
  return sin(d * freq);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float t = u_time;
  float drift = u_driftSpeed;
  float density = u_ringDensity;

  // ── Ring frequency — controls how tight the concentric circles are ──
  float baseFreq = 60.0 * density;

  // ── Subtle breathing — ring spacing pulses slowly ──
  float breathe = 1.0 + 0.04 * sin(t * 0.3) + 0.02 * sin(t * 0.17 + 1.0);
  float freq = baseFreq * breathe;

  // ── Center points — 4 sources orbiting at different speeds and radii ──
  // Each center drifts in a unique elliptical/Lissajous path
  float d = drift;

  vec2 c0 = vec2(
    0.22 * cos(t * d * 0.31 + 0.0),
    0.18 * sin(t * d * 0.43 + 0.0)
  );

  vec2 c1 = vec2(
    0.25 * cos(t * d * 0.23 + 2.1),
    0.20 * sin(t * d * 0.37 + 1.4)
  );

  vec2 c2 = vec2(
    0.19 * sin(t * d * 0.41 + 4.2),
    0.24 * cos(t * d * 0.29 + 3.1)
  );

  vec2 c3 = vec2(
    0.21 * cos(t * d * 0.19 + 5.7),
    0.17 * sin(t * d * 0.47 + 0.8)
  );

  // ── Mouse-driven 5th center — shifts one pattern layer ──
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    c3 = mUV;
  }

  // ── Each center generates rings at a slightly different frequency ──
  // The frequency differences are what create the moiré beats
  float f0 = freq;
  float f1 = freq * 1.07;
  float f2 = freq * 0.93;
  float f3 = freq * 1.13;

  // ── Compute ring patterns ──
  float r0 = rings(uv, c0, f0);
  float r1 = rings(uv, c1, f1);
  float r2 = rings(uv, c2, f2);
  float r3 = rings(uv, c3, f3);

  // ── Combine ring patterns through multiplication ──
  // Multiplying sine patterns produces sum and difference frequencies,
  // which is exactly the moiré interference effect
  float moire = r0 * r1 * r2 * r3;

  // ── Also compute additive blend for a secondary interference layer ──
  float additive = (r0 + r1 + r2 + r3) * 0.25;

  // ── Blend multiplicative and additive for richer pattern ──
  float pattern = moire * 0.7 + additive * 0.3;

  // ── Normalize pattern to [0, 1] range ──
  // Multiplicative moiré ranges roughly [-1, 1], additive too
  float intensity = pattern * 0.5 + 0.5;
  intensity = clamp(intensity, 0.0, 1.0);

  // ── Color mapping ──
  // Map interference intensity through a cool blue-violet-teal palette

  // Dark zones: deep warm-black
  vec3 darkColor = vec3(0.05, 0.035, 0.025);

  // Mid zones: deep amber-brown
  vec3 midColor = vec3(0.35, 0.22, 0.12);

  // Bright interference zones: warm amber
  vec3 brightColor = vec3(0.65, 0.42, 0.22);

  // Peak interference: bright gold-white
  vec3 peakColor = vec3(0.9, 0.78, 0.55);

  // ── Three-stop gradient through the palette ──
  vec3 col;
  if (intensity < 0.35) {
    col = mix(darkColor, midColor, intensity / 0.35);
  } else if (intensity < 0.65) {
    col = mix(midColor, brightColor, (intensity - 0.35) / 0.3);
  } else {
    col = mix(brightColor, peakColor, (intensity - 0.65) / 0.35);
  }

  // ── Add subtle luminance boost at interference peaks ──
  // Where the multiplicative pattern hits strong peaks, push toward warm white
  float peakMask = smoothstep(0.7, 1.0, intensity);
  col += peakColor * peakMask * 0.15;

  // ── Secondary interference shimmer ──
  // Use pairwise products for additional subtle patterns
  float shimmer = r0 * r2 * 0.5 + 0.5;
  shimmer = smoothstep(0.4, 0.8, shimmer);
  col += vec3(0.12, 0.08, 0.04) * shimmer * 0.2;

  // ── Vignette — darken edges to focus attention on center ──
  float vig = 1.0 - dot(uv * 0.9, uv * 0.9);
  vig = clamp(vig, 0.0, 1.0);
  vig = pow(vig, 0.5);
  col *= vig;

  // ── Fine grain — subtle noise overlay for tactile quality ──
  float grain = (hash(gl_FragCoord.xy + fract(t * 37.0) * 1000.0) - 0.5) * 0.03;
  col += grain;

  // ── Tone mapping — keep blacks deep ──
  col = max(col, vec3(0.0));
  col = col / (1.0 + col * 0.2);

  gl_FragColor = vec4(col, 1.0);
}
