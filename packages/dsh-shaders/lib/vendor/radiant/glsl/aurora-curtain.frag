precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_waveSpeed;
uniform float u_lineCount;
uniform float u_amplitude;
uniform float u_rotation;
uniform vec2 u_mouse;
uniform float u_dragAngle;

// ── Hash for noise ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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

#define S smoothstep

mat2 rot2(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }

// ── Single vertical curtain line ──
vec3 curtainLine(vec2 uv, float speed, float freq, vec3 c, float t) {
  // Sine displacement on x based on y position (vertical flow)
  uv.x += S(1.0, 0.0, abs(uv.y)) * sin(t * speed + uv.y * freq) * 0.2;
  float lw = 0.06 * S(0.2, 0.9, abs(uv.y));
  float l = S(lw, 0.0, abs(uv.x) - 0.004);
  // Edge fade top/bottom instead of left/right
  float fade = S(1.0, 0.3, abs(uv.y));
  return l * c * fade;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / u_res.y;
  uv = rot2(u_dragAngle + u_rotation) * uv;
  // Base from sliders, mouse modifies on top
  float mouseAmp = u_amplitude;
  float mouseFreq = 1.0;
  if (u_mouse.x > 0.0) {
    vec2 mUV = u_mouse / u_res;
    mouseAmp *= 0.3 + mUV.y * 1.4;
    mouseFreq = 0.5 + mUV.x * 1.0;
  }
  float t = u_time * u_waveSpeed;
  int lineCount = int(u_lineCount);

  vec3 col = vec3(0.0);

  for (int i = 0; i < 12; i++) {
    if (i >= lineCount) break;
    float fi = float(i);
    float frac = fi / max(u_lineCount - 1.0, 1.0);

    float speed = (0.6 + frac * 0.5) * mouseFreq;
    float freq = (4.0 + frac * 2.0) * mouseAmp;

    // Color: warm amber at base (bottom), cool teal at top
    vec3 warmAmber = vec3(0.85, 0.55, 0.25);
    vec3 coolTeal = vec3(0.2, 0.6, 0.65);
    // Blend per-line from amber to teal
    vec3 lineCol = mix(warmAmber, coolTeal, frac) * (0.5 + frac * 0.5);

    // Also blend per-pixel based on vertical position
    float yBlend = S(-0.4, 0.5, uv.y);
    vec3 pixelCol = mix(warmAmber, coolTeal, yBlend) * (0.4 + frac * 0.6);
    lineCol = mix(lineCol, pixelCol, 0.6);

    // Slow lateral drift
    float drift = sin(t * 0.15 + fi * 1.3) * 0.03;

    float nOff = noise(vec2(uv.y * 2.0 + fi * 3.7, t * 0.1 + fi)) * 0.015;

    col += curtainLine(uv + vec2(nOff + drift, 0.0), speed, freq, lineCol, t);
  }

  // ── Vignette ──
  float vig = 1.0 - dot(uv, uv) * 0.4;
  col *= max(vig, 0.0);

  gl_FragColor = vec4(col, 1.0);
}
