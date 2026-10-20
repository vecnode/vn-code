precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_dripSpeed;
uniform float u_blobCount;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define MAX_BLOBS 12

// ── Hash for noise / grain ──
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── Value noise ──
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

// ── Smooth min for metaball blending (polynomial) ──
// k controls how smoothly the surfaces merge
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// ── Metaball field evaluation ──
// Returns the combined metaball field value at point p
// Uses inverse-distance "energy" formulation for classic metaball look
float metaballField(vec2 p, float t, float speed, float count) {
  float energy = 0.0;
  float numBlobs = 4.0 + count * 8.0; // 4 to 12 blobs

  // ── Emitter group 1: Rising blobs from bottom-left ──
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (float(i) >= numBlobs) break;
    float fi = float(i);
    float phase = fi * 1.618 + fi * fi * 0.13; // golden-ratio spacing

    // Base position: spread across bottom, rise upward
    float riseSpeed = (0.3 + 0.4 * fract(fi * 0.618)) * speed;
    float riseCycle = mod(t * riseSpeed + phase * 0.7, 3.5) - 1.0;

    // X position: oscillate laterally as they rise
    float xBase = sin(phase * 2.39996) * 0.45;
    float xWobble = sin(t * speed * 0.8 + phase * 3.1) * 0.12;
    float xDrift = sin(riseCycle * 2.0 + phase) * 0.08;
    float bx = xBase + xWobble + xDrift;

    // Y position: rise from bottom, wrap around
    float by = -0.7 + riseCycle * 0.9;

    // Size varies per blob and pulses gently
    float baseSize = 0.04 + 0.03 * fract(phase * 0.317);
    float pulse = 1.0 + 0.15 * sin(t * speed * 1.5 + phase * 4.7);
    float radius = baseSize * pulse;

    // Metaball contribution: r^2 / d^2 formulation
    float d = length(p - vec2(bx, by));
    energy += (radius * radius) / (d * d + 0.0001);
  }

  return energy;
}

// ── Tendril field: stretched vertical noise that creates trailing wisps ──
float tendrilField(vec2 p, float t, float speed) {
  // Vertically stretched noise for upward-dripping feel
  float n1 = vnoise(vec2(p.x * 6.0, p.y * 2.0 - t * speed * 0.6) + 10.0);
  float n2 = vnoise(vec2(p.x * 12.0 + 3.7, p.y * 4.0 - t * speed * 0.8) + 20.0);
  float n3 = vnoise(vec2(p.x * 3.0 + 7.1, p.y * 1.5 - t * speed * 0.4));

  // Combine: large tendril shapes + fine detail
  float tendrils = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;

  // Sharpen into tendril-like strands
  tendrils = smoothstep(0.35, 0.65, tendrils);

  // Fade tendrils toward top (they dissipate)
  tendrils *= smoothstep(0.6, -0.3, p.y);

  // Stronger at bottom where "drips" originate
  tendrils *= 0.6 + 0.4 * smoothstep(0.0, -0.5, p.y);

  return tendrils;
}

// ── Vignette ──
float vignette(vec2 uv) {
  float d = length(uv * vec2(0.9, 1.0));
  return smoothstep(1.3, 0.4, d);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time;
  float speed = u_dripSpeed;
  float count = u_blobCount;

  // ── Background: deep dark with subtle warm radial gradient ──
  float bgDist = length(uv * vec2(0.8, 1.0));
  vec3 col = vec3(0.025, 0.018, 0.015) * (1.0 - bgDist * 0.3);
  col = max(col, vec3(0.0));

  // ── Mouse-driven drip source ──
  float mouseField = 0.0;
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / u_res.y;
    float mr = 0.06;
    float md = length(uv - mUV);
    mouseField = (mr * mr) / (md * md + 0.0001);
    // Add smaller orbiting blobs around mouse
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float angle = t * speed * 1.5 + fi * 2.094;
      vec2 offset = vec2(cos(angle), sin(angle)) * 0.08;
      float smr = 0.03;
      float smd = length(uv - mUV - offset);
      mouseField += (smr * smr) / (smd * smd + 0.0001);
    }
  }

  // ── Evaluate metaball field ──
  float field = metaballField(uv, t, speed, count) + mouseField;

  // ── Tendril contribution: adds to the field ──
  float tendrils = tendrilField(uv, t, speed);

  // Combine: metaballs are the main blobs, tendrils add trailing wisps
  // tendrils contribute a fraction of metaball energy
  float combinedField = field + tendrils * 0.6;

  // ── Isosurface thresholds for layered coloring ──
  // The metaball "surface" is where field crosses a threshold
  float threshold = 1.0;

  // Outer glow: neon halo around the blob surfaces
  float outerGlow = smoothstep(threshold * 0.15, threshold * 0.5, combinedField);

  // Surface: sharper blob boundary for neon look
  float surface = smoothstep(threshold * 0.4, threshold * 0.7, combinedField);

  // Inner: brighter core inside the blobs
  float inner = smoothstep(threshold * 0.8, threshold * 1.8, combinedField);

  // Hot core: brightest center
  float core = smoothstep(threshold * 2.0, threshold * 4.0, combinedField);

  // ── Color palette: vibrant neon amber (HDR values > 1.0 for bloom) ──
  // Deep amber glow (outermost)
  vec3 glowColor = vec3(1.2, 0.55, 0.10);

  // Bright neon surface
  vec3 surfaceColor = vec3(2.5, 1.3, 0.40);

  // Intense inner
  vec3 innerColor = vec3(3.5, 2.0, 0.70);

  // White-hot core
  vec3 coreColor = vec3(5.0, 4.0, 2.5);

  // ── Compose the blob color ──
  // Start with glow — push hard for neon effect
  vec3 blobCol = glowColor * outerGlow * 1.0;

  // Add surface color
  blobCol = mix(blobCol, surfaceColor, surface * 0.95);

  // Brighten inner areas
  blobCol = mix(blobCol, innerColor, inner * 0.95);

  // Hot core highlights
  blobCol = mix(blobCol, coreColor, core * 1.0);

  // ── Surface edge highlight: rim lighting effect ──
  // Brighter at the edge of the surface (where gradient is steep)
  float edgeBand = surface * (1.0 - inner);
  blobCol += vec3(1.8, 1.0, 0.3) * edgeBand * 0.8;

  // ── Tendril coloring: slightly different from main blobs ──
  float tendrilVis = tendrils * (1.0 - surface * 0.5);
  vec3 tendrilColor = vec3(1.4, 0.7, 0.20) * tendrilVis * 0.7;
  blobCol += tendrilColor;

  // ── Add blob color to scene ──
  col += blobCol;

  // ── Ambient upward-flowing noise: background movement ──
  float ambientFlow = vnoise(vec2(uv.x * 3.0, uv.y * 1.5 - t * speed * 0.2) + 50.0);
  ambientFlow = smoothstep(0.4, 0.6, ambientFlow) * 0.06;
  col += vec3(0.2, 0.12, 0.06) * ambientFlow;

  // ── Subtle secondary blobs: small, fast, for liveliness ──
  float microField = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float phase = fi * 2.39996 + 100.0;
    float mSpeed = (0.5 + 0.3 * fract(phase * 0.618)) * speed;
    float mCycle = mod(t * mSpeed + phase, 2.8) - 0.8;
    float mx = sin(phase * 1.7) * 0.5 + sin(t * speed + phase * 2.3) * 0.1;
    float my = -0.6 + mCycle * 0.8;
    float mr = 0.015 + 0.01 * sin(t * speed * 2.0 + phase);
    float md = length(uv - vec2(mx, my));
    microField += (mr * mr) / (md * md + 0.0001);
  }
  float microSurface = smoothstep(0.8, 1.5, microField);
  float microCore = smoothstep(1.5, 3.0, microField);
  col += vec3(1.8, 1.0, 0.30) * microSurface * 0.7;
  col += vec3(3.0, 2.2, 1.0) * microCore * 0.8;

  // ── Film grain ──
  float grain = (hash(gl_FragCoord.xy + fract(t * 43.758) * 1000.0) - 0.5) * 0.025;
  col += grain;

  // ── Vignette ──
  col *= vignette(uv);

  // ── Tone mapping: ACES filmic (preserves bright neon punch) ──
  col = max(col, vec3(0.0));
  col = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(col, vec3(0.90));

  // ── Warm shadow push ──
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, col * vec3(1.06, 0.97, 0.90), smoothstep(0.05, 0.0, lum) * 0.3);

  gl_FragColor = vec4(col, 1.0);
}
