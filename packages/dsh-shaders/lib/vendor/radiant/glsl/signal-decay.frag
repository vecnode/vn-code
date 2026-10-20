precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_signalSpeed;
uniform float u_decayIntensity;
uniform vec2 u_mouse;

#define PI 3.14159265
#define TAU 6.28318530
#define NUM_TRACKS 10
#define NUM_HARMONICS 6

// ── Hash ──
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
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ── FBM ──
float fbm(vec2 p) {
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    f += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return f;
}

// ── Soft clip (polynomial approximation of tanh) ──
float softClip(float x, float amt) {
  float k = mix(1.0, 5.0, amt);
  float kx = k * x;
  // rational approximation: tanh(x) ≈ x / (1 + |x| + 0.28 * x^2)
  float ax = abs(kx);
  return (kx / (1.0 + ax + 0.28 * kx * kx));
}

// ── Hard clip ──
float hardClip(float x, float amt) {
  float th = mix(1.0, 0.2, amt);
  return clamp(x, -th, th) / max(th, 0.001);
}

// ── Bit crush (quantize) ──
float bitCrush(float x, float amt) {
  float levels = mix(128.0, 3.0, amt * amt);
  return floor(x * levels + 0.5) / levels;
}

// ── Compute one degraded harmonic ──
// freq: base frequency multiplier
// ph: phase offset
// amp: amplitude
// decay: 0=clean, 1=destroyed
float degradedWave(float x, float t, float freq, float ph, float amp, float decay) {
  float speed = u_signalSpeed;
  float phase = x * freq * TAU + ph + t * speed * (1.5 + freq * 0.2);

  // Phase distortion (increases with decay)
  float pd = decay * decay * 2.0;
  phase += pd * sin(phase * 1.7 + t * 0.3) + pd * 0.4 * sin(phase * 3.1);

  // FM synthesis — modulator riding on carrier
  float fm = decay * 1.2;
  float w = sin(phase + fm * sin(phase * 2.13 + t * 0.5));

  // AM — beating patterns
  float am = 1.0 - decay * 0.35 * (0.5 + 0.5 * sin(x * 2.5 + t * speed * 1.3 + ph));
  w *= am;

  // Progressive degradation chain
  // Soft clip: onset 0.1-0.4
  float sc = smoothstep(0.08, 0.35, decay);
  w = mix(w, softClip(w, sc), sc);

  // Hard clip: onset 0.3-0.6
  float hc = smoothstep(0.25, 0.55, decay);
  w = mix(w, hardClip(w, hc), hc);

  // Bit crush: onset 0.5-0.8
  float bc = smoothstep(0.45, 0.8, decay);
  w = mix(w, bitCrush(w, bc), bc);

  // Noise injection: onset 0.4+
  float ni = smoothstep(0.35, 0.9, decay);
  float noise = (hash(vec2(x * 50.0 + ph, t * 7.0 + freq)) - 0.5) * 2.0;
  w = mix(w, w + noise * 0.4, ni);

  return w * amp;
}

// ── Full composite: 6 harmonics ──
float compositeWave(float x, float t, float decay) {
  float w = 0.0;
  // Harmonic 0: fundamental
  w += degradedWave(x, t, 1.0,   0.0,   0.32, decay);
  // Harmonic 1: golden ratio
  w += degradedWave(x, t, 1.618, 1.047, 0.26, decay);
  // Harmonic 2
  w += degradedWave(x, t, 2.414, 2.094, 0.20, decay);
  // Harmonic 3
  w += degradedWave(x, t, 3.302, 3.665, 0.16, decay);
  // Harmonic 4
  w += degradedWave(x, t, 4.236, 0.524, 0.12, decay);
  // Harmonic 5
  w += degradedWave(x, t, 5.879, 4.189, 0.09, decay);
  return w;
}

// ── Glowing line SDF ──
float glowLine(float d, float w, float g) {
  float core = smoothstep(w, 0.0, abs(d));
  float bloom = exp(-abs(d) / max(g, 0.0001)) * 0.45;
  return core + bloom;
}

// ── Glitch horizontal offset ──
float glitch(float y, float t, float decay) {
  float amt = smoothstep(0.3, 0.7, decay);
  float g1 = step(0.96, hash(vec2(floor(y * 60.0), floor(t * 4.0))));
  float g2 = step(0.93, hash(vec2(floor(y * 30.0), floor(t * 6.0 + 77.0))));
  float offset = g1 * (hash(vec2(y * 11.0, t * 3.0)) - 0.5) * 0.1;
  offset += g2 * (hash(vec2(y * 23.0, t * 5.0 + 50.0)) - 0.5) * 0.05;
  return offset * amt;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float ar = u_res.x / u_res.y;
  float t = u_time;


  // yNorm: 0 at top of screen, 1 at bottom
  // Mouse Y shifts the decay boundary — cursor high = all corrupted, low = all clean
  float yNorm = 1.0 - uv.y;
  float decayShift = 0.0;
  if (u_mouse.x > 0.0) {
    float mouseY = 1.0 - u_mouse.y / u_res.y;
    decayShift = (mouseY - 0.5) * 1.6;
  }
  float decay = clamp(pow(max(yNorm + decayShift, 0.0), 0.75) * u_decayIntensity, 0.0, 1.0);

  // Glitch offset for this scanline
  float gOff = glitch(yNorm, t, decay);

  // ── Accumulate waveform lines ──
  vec3 col = vec3(0.0);

  // Color palette
  vec3 colClean    = vec3(0.78, 0.58, 0.42);  // warm amber
  vec3 colDistort  = vec3(1.0,  0.76, 0.45);  // bright orange
  vec3 colHot      = vec3(1.0,  0.92, 0.72);  // near-white gold
  vec3 colNoise    = vec3(0.62, 0.45, 0.30);  // sepia

  // Each track is a horizontal band with a waveform line
  float trackH = 1.0 / float(NUM_TRACKS);

  for (int i = 0; i < NUM_TRACKS; i++) {
    float fi = float(i);
    float trackCenter = (fi + 0.5) * trackH;

    // This track s decay based on its vertical position
    float tYNorm = 1.0 - trackCenter;
    float tDecay = clamp(pow(tYNorm, 0.75) * u_decayIntensity, 0.0, 1.0);

    // Frequency/phase offset per track (variety)
    float tOff = fi * 0.391;

    // Horizontal position with glitch and mouse shift
    float x = (uv.x + gOff) * ar + tOff;

    // Compute degraded composite waveform for this track
    float wave = compositeWave(x, t + fi * 0.17, tDecay);

    // Map waveform to vertical position
    float ampScale = trackH * 0.38 * (1.0 + tDecay * 0.6);
    float waveY = trackCenter + wave * ampScale;

    // SDF distance from pixel to waveform line
    float dist = uv.y - waveY;

    // Line width: thin when clean, thicker when degraded
    float lw = mix(0.0006, 0.0025, tDecay);
    // Glow spread: tight when clean, diffuse when degraded
    float gw = mix(0.003, 0.014, tDecay * tDecay);

    // ── Dash/fragment mask (chaos zone) ──
    float fragAmt = smoothstep(0.5, 0.85, tDecay);
    float dashMask = 1.0;
    float dashFreq = mix(25.0, 90.0, fragAmt);
    float dashSeed = hash(vec2(floor(x * dashFreq), fi + floor(t * 2.5)));
    dashMask = mix(1.0, step(0.28, dashSeed), fragAmt);

    // Line intensity
    float line = glowLine(dist, lw, gw) * dashMask;

    // ── Color for this track ──
    vec3 tCol = mix(colClean, colDistort, smoothstep(0.15, 0.5, tDecay));
    tCol = mix(tCol, colHot, smoothstep(0.45, 0.75, tDecay));

    // ── Warm chromatic aberration (chaos zone) ──
    // Instead of full RGB split, shift between warm-red and warm-gold
    float chromaStr = smoothstep(0.45, 0.85, tDecay) * 0.008;
    vec3 lineCol = tCol * line;

    if (chromaStr > 0.0001) {
      float xA = x + chromaStr * ar * 8.0;
      float xB = x - chromaStr * ar * 8.0;
      float waveA = compositeWave(xA, t + fi * 0.17, tDecay);
      float waveB = compositeWave(xB, t + fi * 0.17, tDecay);
      float waveYA = trackCenter + waveA * ampScale;
      float waveYB = trackCenter + waveB * ampScale;
      float lineA = glowLine(uv.y - waveYA, lw, gw) * dashMask;
      float lineBv = glowLine(uv.y - waveYB, lw, gw) * dashMask;
      // Warm-red channel and warm-gold channel
      vec3 warmA = vec3(1.0, 0.55, 0.25);  // copper-red
      vec3 warmB = vec3(1.0, 0.85, 0.4);   // warm gold
      float chromaMix = smoothstep(0.45, 0.85, tDecay);
      vec3 monoLine = tCol * line;
      vec3 chromaLine = warmA * lineA * 0.5 + warmB * lineBv * 0.35 + tCol * line * 0.3;
      lineCol = mix(monoLine, chromaLine, chromaMix);
    }

    col += lineCol;
  }

  // ── Noise floor (bottom 25%) ──
  float nfAmt = smoothstep(0.65, 1.0, yNorm) * u_decayIntensity;
  if (nfAmt > 0.001) {
    float n1 = fbm(gl_FragCoord.xy * 0.012 + vec2(t * 0.4, 0.0));
    float n2 = vnoise(gl_FragCoord.xy * vec2(0.25, 0.008) + vec2(t * 2.5, 0.0));
    // Horizontal scan-line banding
    float band = vnoise(vec2(t * 3.5, gl_FragCoord.y * 0.08)) * 0.5 + 0.5;
    float nf = n1 * 0.55 + n2 * 0.3 + band * 0.15;

    // Ghost lines — faint echoes of the clean signal
    float ghostX = uv.x * ar;
    for (int gi = 0; gi < 3; gi++) {
      float gfi = float(gi);
      float gWave = compositeWave(ghostX + gfi * 0.5, t + gfi * 0.3, 0.0);
      float gCenter = 0.05 + gfi * 0.04;  // near the bottom
      float gLine = exp(-abs((1.0 - uv.y) - (0.88 + gfi * 0.03) - gWave * 0.015) * 250.0);
      nf += gLine * 0.12;
    }

    // Warm noise with slight color variation
    vec3 nfCol = colNoise + vec3(0.08, -0.02, -0.05) * vnoise(gl_FragCoord.xy * 0.05 + t);
    col += nfCol * nf * nfAmt * 0.7;
  }

  // ── Warm ambient glow increasing with decay ──
  col += vec3(0.42, 0.28, 0.16) * decay * 0.018;

  // ── Background: very subtle gradient (slightly warmer at bottom) ──
  vec3 bg = mix(vec3(0.035, 0.035, 0.038), vec3(0.05, 0.04, 0.035), yNorm);
  col += bg;

  // ── Vignette ──
  vec2 vc = uv - 0.5;
  float vig = 1.0 - dot(vc * vec2(0.9, 0.55), vc * vec2(0.9, 0.55)) * 1.4;
  col *= clamp(0.45 + 0.55 * vig, 0.0, 1.0);

  // ── Film grain ──
  float grain = (hash(gl_FragCoord.xy + fract(t * 0.07) * 137.0) - 0.5) * 0.022;
  col += grain;

  // ── Tone map: gentle S-curve ──
  col = clamp(col, 0.0, 1.0);
  col = col * col * (3.0 - 2.0 * col);

  gl_FragColor = vec4(col, 1.0);
}
