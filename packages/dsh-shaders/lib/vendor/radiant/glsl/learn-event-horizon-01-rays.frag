
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_rotateSpeed;
uniform float u_tilt;
uniform float u_dragX;
uniform float u_dragY;
uniform float u_nebula;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

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
float fbmLite(vec2 p) {
  float v = 0.5 * gNoise(p);
  p = mat2(0.866, 0.5, -0.5, 0.866) * p * 2.03 + vec2(47.0, 13.0);
  v += 0.25 * gNoise(p);
  return v;
}

// ──── 3D noise — used for the nebula so it doesn't seam at the meridian ────
// Sampling a 2D UV (u = atan(rd.z, rd.x)) creates a hard discontinuity at
// u=0 ↔ u=1 because the FBM has no idea those coordinates are the same
// direction in 3D space. Driving the noise off the ray vector directly
// avoids the seam.
float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float gNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(
      mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), u.x),
      mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
    mix(
      mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
      mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y),
    u.z);
}
float fbm3(vec3 p) {
  float v = 0.5 * gNoise3(p);
  p = p * 2.07 + vec3(11.0, 31.0, 17.0); v += 0.25 * gNoise3(p);
  p = p * 2.03 + vec3(47.0, 13.0, 29.0); v += 0.125 * gNoise3(p);
  return v;
}

vec3 starField(vec3 rd) {
  float u = atan(rd.z, rd.x) / TAU + 0.5;
  float v = asin(clamp(rd.y, -0.999, 0.999)) / PI + 0.5;
  vec3 col = vec3(0.0);

  // ──── Nebula first (sits behind stars) — sampled in 3D, no seam ────
  if (u_nebula > 0.01) {
    float nA = fbm3(rd * 2.5);
    float nB = fbm3(rd * 4.0 + vec3(17.0));
    // Soft cloud field with a low-level ambient base so there are no
    // hard dark gaps between bright regions.
    float clouds = 0.25 + 0.75 * smoothstep(0.1, 0.9, nA * nB * 3.5);
    clouds *= 0.4 + 0.6 * smoothstep(0.2, 0.7, nA); // gentle large-scale modulation
    // Hue varies with sky latitude (rd.y): warm dust below, cool above
    vec3 warm = vec3(0.28, 0.10, 0.20);
    vec3 cool = vec3(0.08, 0.12, 0.28);
    vec3 nebCol = mix(warm, cool, smoothstep(-0.5, 0.7, rd.y + 0.25 * nA));
    col += nebCol * clouds * u_nebula * 0.55;
  }

  // Bright sparse stars
  {
    vec2 cell = floor(vec2(u, v) * 55.0);
    vec2 f = fract(vec2(u, v) * 55.0);
    vec2 r = vec2(hash(cell), hash(cell + 127.1));
    float d = length(f - r);
    float b = pow(r.x, 10.0) * exp(-d * d * 500.0);
    col += mix(vec3(1.0, 0.65, 0.35), vec3(0.55, 0.75, 1.0), r.y) * b * 4.0;
  }
  // Medium density
  {
    vec2 cell = floor(vec2(u, v) * 170.0);
    vec2 f = fract(vec2(u, v) * 170.0);
    vec2 r = vec2(hash(cell + 43.0), hash(cell + 91.0));
    float d = length(f - r);
    float b = pow(r.x, 18.0) * exp(-d * d * 1000.0);
    col += vec3(0.85, 0.88, 1.0) * b * 2.0;
  }
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.x;

  // Orbital camera at fixed distance — same framing as the final shader
  float orbit = u_time * 0.055 * u_rotateSpeed + u_dragX;
  float tilt = 0.25 + u_tilt + u_dragY;
  vec3 eye = vec3(28.0 * cos(orbit) * cos(tilt), 28.0 * sin(tilt), 28.0 * sin(orbit) * cos(tilt));

  vec3 fwd = normalize(-eye);
  vec3 rt  = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up  = cross(rt, fwd);

  // Ray direction for this pixel
  vec3 rd = normalize(fwd + uv.x * rt + uv.y * up);

  // STRAIGHT line: no bending, just sample the sky in that direction.
  vec3 col = starField(rd);

  // Filmic-ish output
  col = col / (col + 1.0);
  col = pow(col, vec3(0.85));
  gl_FragColor = vec4(col, 1.0);
}
