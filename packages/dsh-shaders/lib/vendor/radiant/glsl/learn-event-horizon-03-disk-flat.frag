
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_isco;        // ISCO radius (in RS units)
uniform float u_inner;       // disk inner edge
uniform float u_outer;       // disk outer edge
uniform float u_turbulence;  // FBM strength
uniform float u_rings;       // ring modulation
uniform float u_speed;       // rotation speed multiplier

const float PI = 3.14159265359;
const float TAU = 6.28318530718;
const float RS = 1.0;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2(1, 0)), u.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x),
    u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.866, 0.5, -0.5, 0.866);
  for (int i = 0; i < 4; i++) {
    v += a * gNoise(p);
    p = rot * p * 2.03 + vec2(47.0, 13.0);
    a *= 0.49;
  }
  return v;
}

vec3 bbColor(float t) {
  t = clamp(t, 0.0, 2.5);
  vec3 lo = vec3(1.0, 0.18, 0.0);
  vec3 mi = vec3(1.0, 0.55, 0.12);
  vec3 hi = vec3(1.0, 0.93, 0.82);
  vec3 hot = vec3(0.65, 0.82, 1.0);
  vec3 c = mix(lo, mi, smoothstep(0.0, 0.3, t));
  c = mix(c, hi, smoothstep(0.3, 0.8, t));
  return mix(c, hot, smoothstep(0.8, 1.8, t));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.x * 24.0; // world coords, top-down
  float r = length(uv);
  if (r < u_inner * 0.5 || r > u_outer * 1.05) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Novikov-Thorne: T ∝ r^(-3/4) · (1 - sqrt(r_isco/r))^(1/4)
  float xr = u_isco / r;
  float tProfile = pow(u_isco / r, 0.75) * pow(max(0.001, 1.0 - sqrt(xr)), 0.25);

  // Gravitational redshift attenuation (observed temp lower near BH)
  float gRedshift = sqrt(max(0.01, 1.0 - RS / r));
  tProfile *= gRedshift;

  // Keplerian differential rotation
  float keplerOmega = sqrt(0.5 * RS / (r * r * r));
  float omega = max(keplerOmega, 0.04) * 10.0 * u_speed;
  float rotAngle = u_time * omega;
  float ca = cos(rotAngle), sa = sin(rotAngle);
  vec2 rotXZ = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca);

  float lr = log2(max(r, 0.1));
  float turb = fbm(rotXZ * 1.2 + vec2(lr * 3.0));
  turb = 0.25 + 0.75 * turb;
  float detail = gNoise(rotXZ * 3.5 + vec2(100.0));
  turb *= 0.7 + 0.3 * detail;
  turb = mix(1.0, turb, u_turbulence);

  // Concentric rings
  float ringPhase1 = sin(r * 10.0 + rotAngle * r * 0.3) * 0.5 + 0.5;
  float ringPhase2 = sin(r * 20.0 - rotAngle * r * 0.15) * 0.5 + 0.5;
  float rings = ringPhase1 * 0.55 + ringPhase2 * 0.45;
  rings = mix(1.0, 0.5 + 0.5 * rings, u_rings);
  turb *= rings;

  float I = tProfile * turb * 6.0;
  float innerFade = smoothstep(u_inner * 0.7, u_inner * 1.2, r);
  float iscoFade = 0.35 + 0.65 * smoothstep(u_isco * 0.85, u_isco * 1.2, r);
  float outerFade = 1.0 - smoothstep(u_outer * 0.55, u_outer, r);
  I *= innerFade * iscoFade * outerFade;

  vec3 col = bbColor(tProfile * 1.3) * I;

  // Filmic
  col *= 1.4;
  vec3 a = col * (col + 0.0245786) - 0.000090537;
  vec3 b = col * (0.983729 * col + 0.4329510) + 0.238081;
  col = a / b;
  col = pow(max(col, 0.0), vec3(0.92));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
