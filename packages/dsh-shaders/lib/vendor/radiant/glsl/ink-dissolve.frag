precision highp float;

uniform float u_time;
uniform vec2 u_res;
uniform float u_spread;
uniform float u_detail;
uniform vec2 u_mouse;

//--------------------------------------------------------------
// Simplex 2D noise (Ashima Arts)
//--------------------------------------------------------------
vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
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
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

//--------------------------------------------------------------
// FBM with rotation between octaves (unrolled, no dynamic loops)
//--------------------------------------------------------------
float fbm4(vec2 p, float dm) {
  float v = 0.0;
  float a = 0.55;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  v += a * snoise(p); a *= 0.45; p = rot * p * 2.02;
  v += a * snoise(p); a *= 0.45; p = rot * p * 2.03;
  v += a * snoise(p) * dm; a *= 0.4; p = rot * p * 2.01;
  v += a * snoise(p) * dm * 0.6;
  return v;
}

float fbm3(vec2 p) {
  float v = 0.0;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  v += 0.5 * snoise(p); p = rot * p * 2.02;
  v += 0.25 * snoise(p); p = rot * p * 2.03;
  v += 0.125 * snoise(p);
  return v;
}

//--------------------------------------------------------------
// Double domain-warped ink field
// Creates organic reaction-diffusion-like branching tendrils
//--------------------------------------------------------------
float inkField(vec2 p, float t, float dm) {
  // First warp: large-scale organic flow
  vec2 q = vec2(
    fbm4(p + vec2(0.0, 0.0) + t * 0.04, dm),
    fbm4(p + vec2(5.2, 1.3) + t * 0.03, dm)
  );
  // Second warp: gentler, for tendril branching without noise
  vec2 r = vec2(
    fbm4(p + 2.5 * q + vec2(1.7, 9.2) + t * 0.022, dm),
    fbm4(p + 2.5 * q + vec2(8.3, 2.8) + t * 0.032, dm)
  );
  return fbm4(p + 2.2 * r + t * 0.015, dm);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float t = u_time * u_spread;
  float dm = u_detail;

  // ── Primary ink field (broad tendrils via domain warping) ──
  float field = inkField(uv * 0.8, t, dm);

  // ── Ink source envelope: slow drifting origins ──
  float envelope = 0.0;
  float a1 = t * 0.05;
  envelope += smoothstep(0.95, 0.0, length(uv - vec2(cos(a1)*0.15, sin(a1*0.7)*0.12)));
  float a2 = t * 0.04 + 2.2;
  envelope += smoothstep(0.85, 0.0, length(uv - vec2(cos(a2)*0.25, sin(a2*0.6)*0.2)));
  float a3 = t * 0.048 + 4.7;
  envelope += smoothstep(0.75, 0.0, length(uv - vec2(cos(a3*0.8)*0.2, sin(a3)*0.16)));
  envelope += smoothstep(0.65, 0.0, length(uv)) * 0.6;

  // Mouse adds a local ink source at cursor position
  if (u_mouse.x >= 0.0) {
    vec2 mPos = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    envelope += smoothstep(0.6, 0.0, length(uv - mPos)) * 0.8;
  }
  envelope = clamp(envelope, 0.0, 1.0);

  // ── Shape into ink: wider smoothstep for soft organic edges ──
  float inkRaw = smoothstep(-0.2, 0.1, field);
  float ink = inkRaw * envelope;

  // ── Secondary fine tendrils (adds branching detail at edges) ──
  float fineField = fbm3(uv * 2.5 + vec2(t * 0.02, -t * 0.015));
  float fineTendril = smoothstep(-0.1, 0.12, fineField) * envelope;
  float combinedInk = max(ink, fineTendril * 0.35);

  // ── Edge glow: analytical from the ink transition zone ──
  float edgeRaw = combinedInk * (1.0 - combinedInk) * 4.0;
  float edgeSoft = smoothstep(0.05, 0.5, edgeRaw);
  float edgeMid = smoothstep(0.25, 0.8, edgeRaw);
  float edgeHot = smoothstep(0.6, 1.0, edgeRaw);

  // ── Fine edge from secondary tendrils ──
  float fineEdge = fineTendril * (1.0 - fineTendril) * 4.0;
  fineEdge = smoothstep(0.3, 0.9, fineEdge) * 0.4;

  // ── Color palette (warm amber only) ──
  vec3 inkDark  = vec3(0.02, 0.015, 0.01);
  vec3 amberDim = vec3(0.06, 0.035, 0.014);
  vec3 amberDeep = vec3(0.18, 0.10, 0.035);
  vec3 amberWarm = vec3(0.42, 0.28, 0.14);
  vec3 amberGold = vec3(0.78, 0.58, 0.42);
  vec3 amberBright = vec3(1.0, 0.82, 0.52);
  vec3 amberHot  = vec3(1.0, 0.92, 0.72);

  // ── Liquid background (subdued amber with subtle variation) ──
  float liqVar = 0.5 + 0.5 * fbm3(uv * 2.0 + t * 0.03);
  vec3 liquid = mix(amberDim, amberDeep, liqVar * 0.7);

  // Subtle caustic shimmer in liquid
  float c1 = 0.5 + 0.5 * snoise(uv * 6.0 + vec2(t * 0.05, -t * 0.035));
  float c2 = 0.5 + 0.5 * snoise(uv * 10.0 + vec2(-t * 0.03, t * 0.04));
  liquid += amberWarm * c1 * c2 * 0.05 * (1.0 - combinedInk);

  // ── Compose: dark ink over amber liquid ──
  vec3 col = mix(liquid, inkDark, combinedInk);

  // ── Multi-layer edge glow (luminous amber at ink boundaries) ──
  // Soft broad halo
  col += amberDeep * edgeSoft * 0.7;
  // Mid glow
  col += amberGold * edgeMid * 0.4;
  // Bright edge
  col += amberBright * edgeHot * 0.45;
  // Hot core
  col += amberHot * edgeHot * edgeHot * 0.25;

  // Fine tendril glow
  col += amberWarm * fineEdge * 0.3;
  col += amberGold * fineEdge * fineEdge * 0.15;

  // ── Subtle depth in ink regions ──
  float inkTex = 0.5 + 0.5 * snoise(uv * 3.5 + t * 0.01);
  col += vec3(0.015, 0.01, 0.005) * inkTex * combinedInk;

  // ── Subsurface glow: amber bleeding through thin ink at edges ──
  float thinInk = smoothstep(0.5, 0.1, combinedInk);
  col += amberDim * thinInk * edgeSoft * 0.3;

  // ── Ambient warm light from below ──
  float vertGlow = smoothstep(0.6, -0.3, uv.y);
  col += vec3(0.025, 0.012, 0.004) * vertGlow * (1.0 - combinedInk * 0.6);

  // ── Vignette ──
  float vig = 1.0 - smoothstep(0.35, 1.2, length(uv));
  col *= 0.5 + 0.5 * vig;

  // ── Warm gamma ──
  col = pow(max(col, 0.0), vec3(0.93, 0.97, 1.04));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
