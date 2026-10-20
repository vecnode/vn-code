precision highp float;
varying vec2 v_uv;
uniform sampler2D u_scene;
uniform float u_time;
uniform vec2 u_res;

#define PI 3.14159265359

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = v_uv;
  float t = u_time;

  vec3 col = texture2D(u_scene, uv).rgb;

  // ── Bloom: 13-tap cross sampling for glow effect ──
  vec2 texel = 1.0 / u_res;
  vec3 bloom = col * 0.2;
  // Horizontal samples
  bloom += texture2D(u_scene, uv + vec2(texel.x * 2.0, 0.0)).rgb * 0.15;
  bloom += texture2D(u_scene, uv - vec2(texel.x * 2.0, 0.0)).rgb * 0.15;
  bloom += texture2D(u_scene, uv + vec2(texel.x * 5.0, 0.0)).rgb * 0.1;
  bloom += texture2D(u_scene, uv - vec2(texel.x * 5.0, 0.0)).rgb * 0.1;
  // Vertical samples
  bloom += texture2D(u_scene, uv + vec2(0.0, texel.y * 2.0)).rgb * 0.15;
  bloom += texture2D(u_scene, uv - vec2(0.0, texel.y * 2.0)).rgb * 0.15;
  bloom += texture2D(u_scene, uv + vec2(0.0, texel.y * 5.0)).rgb * 0.1;
  bloom += texture2D(u_scene, uv - vec2(0.0, texel.y * 5.0)).rgb * 0.1;
  // Diagonal samples for rounder glow
  bloom += texture2D(u_scene, uv + texel * 3.5).rgb * 0.08;
  bloom += texture2D(u_scene, uv - texel * 3.5).rgb * 0.08;
  bloom += texture2D(u_scene, uv + vec2(texel.x, -texel.y) * 3.5).rgb * 0.08;
  bloom += texture2D(u_scene, uv + vec2(-texel.x, texel.y) * 3.5).rgb * 0.08;
  bloom /= 1.52;

  // Add bloom (only the bright excess)
  vec3 bloomExcess = max(bloom - 0.25, 0.0);
  col += bloomExcess * 0.5;

  // ── Scanlines: horizontal lines scrolling at different rate ──
  float scanY = gl_FragCoord.y;

  // Fine scanlines — subtle CRT effect
  float fineScan = sin(scanY * PI * 0.5) * 0.5 + 0.5;
  fineScan = pow(fineScan, 2.0);
  float scanDarken = mix(0.75, 1.0, fineScan);

  // Scrolling broad scan band
  float scrollScan = sin((scanY * 0.02 + t * 15.0) * 0.5) * 0.5 + 0.5;
  scrollScan = smoothstep(0.3, 0.7, scrollScan);
  scanDarken *= mix(0.85, 1.0, scrollScan);

  // Bright sweep line
  float sweepPos = mod(t * 50.0, u_res.y * 1.5) - u_res.y * 0.25;
  float sweep = exp(-abs(scanY - sweepPos) * 0.06) * 0.25;

  col *= scanDarken;
  col += vec3(0.4, 0.65, 0.75) * sweep;

  // ── Vignette: dark edges, bright center ──
  vec2 vigUV = uv * 2.0 - 1.0;
  float vig = 1.0 - dot(vigUV * 0.55, vigUV * 0.55);
  vig = clamp(vig, 0.0, 1.0);
  vig = vig * vig;
  col *= 0.2 + vig * 0.8;

  // ── Center glow: bright where seed shapes appear ──
  float centerDist = length(vigUV);
  float centerGlow = exp(-centerDist * centerDist * 2.0) * 0.08;
  col += vec3(0.8, 0.55, 0.25) * centerGlow;

  // ── Film grain ──
  float grain = (hash(gl_FragCoord.xy + fract(t * 43.0) * 1000.0) - 0.5) * 0.04;
  col += grain;

  // ── Tone mapping (Reinhard) ──
  col = col / (1.0 + col * 0.2);

  // ── Gamma ──
  col = pow(max(col, vec3(0.0)), vec3(0.95));

  gl_FragColor = vec4(col, 1.0);
}
