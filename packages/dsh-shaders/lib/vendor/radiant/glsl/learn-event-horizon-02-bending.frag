
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_rotateSpeed;
uniform float u_tilt;
uniform float u_dragX;
uniform float u_dragY;
uniform float u_mass;     // Schwarzschild radius in scene units
uniform float u_steps;    // visualization of step count
uniform float u_showGrid; // 0/1: overlay a "background grid" instead of stars

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 starField(vec3 rd) {
  float u = atan(rd.z, rd.x) / TAU + 0.5;
  float v = asin(clamp(rd.y, -0.999, 0.999)) / PI + 0.5;
  vec3 col = vec3(0.0);
  {
    vec2 cell = floor(vec2(u, v) * 55.0);
    vec2 f = fract(vec2(u, v) * 55.0);
    vec2 r = vec2(hash(cell), hash(cell + 127.1));
    float d = length(f - r);
    float b = pow(r.x, 10.0) * exp(-d * d * 500.0);
    col += mix(vec3(1.0, 0.65, 0.35), vec3(0.55, 0.75, 1.0), r.y) * b * 4.0;
  }
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

// Lat/long grid as background — makes lensing geometry obvious
vec3 gridSky(vec3 rd) {
  float u = atan(rd.z, rd.x) / TAU + 0.5;
  float v = asin(clamp(rd.y, -0.999, 0.999)) / PI + 0.5;
  float lonLine = smoothstep(0.04, 0.0, abs(fract(u * 24.0) - 0.5));
  float latLine = smoothstep(0.04, 0.0, abs(fract(v * 12.0) - 0.5));
  float g = max(lonLine, latLine) * 0.4;
  // Tint by quadrant for orientation cues
  vec3 tint = mix(vec3(0.7, 0.55, 0.3), vec3(0.4, 0.55, 0.85), step(0.5, u));
  return tint * g + vec3(0.02, 0.02, 0.03);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.x;

  float orbit = u_time * 0.055 * u_rotateSpeed + u_dragX;
  float tilt = 0.25 + u_tilt + u_dragY;
  vec3 eye = vec3(28.0 * cos(orbit) * cos(tilt), 28.0 * sin(tilt), 28.0 * sin(orbit) * cos(tilt));
  vec3 fwd = normalize(-eye);
  vec3 rt  = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up  = cross(rt, fwd);
  vec3 rd  = normalize(fwd + uv.x * rt + uv.y * up);

  // ──── Geodesic integration ────
  // Schwarzschild equation:  d²x/dλ² = -1.5 · RS · L² / r⁵ · x
  // L = |x × v| is the angular momentum (conserved along the geodesic).
  float RS = u_mass; // Schwarzschild radius
  vec3 pos = eye;
  vec3 vel = rd;
  vec3 Lvec = cross(pos, vel);
  float L2 = dot(Lvec, Lvec);
  float gravCoeff = -1.5 * RS * L2;

  bool absorbed = false;
  int maxSteps = int(u_steps);
  for (int i = 0; i < 200; i++) {
    if (i >= maxSteps) break;
    float r = length(pos);
    float h = 0.16 * clamp(r - 0.4 * RS, 0.06, 3.5);

    float invR2 = 1.0 / (r * r);
    float invR5 = invR2 * invR2 / r;
    vec3 acc = (gravCoeff * invR5) * pos;

    // Velocity-Verlet (symplectic)
    vec3 p1 = pos + vel * h + 0.5 * acc * h * h;
    float r1 = length(p1);
    float invR12 = 1.0 / (r1 * r1);
    float invR15 = invR12 * invR12 / r1;
    vec3 acc1 = (gravCoeff * invR15) * p1;
    vec3 v1 = vel + 0.5 * (acc + acc1) * h;

    if (r1 < RS * 0.35) { absorbed = true; break; }
    if (r1 > 25.0 && r1 > r) break;
    if (r1 > 55.0) break;
    pos = p1; vel = v1;
  }

  vec3 col;
  if (absorbed) {
    col = vec3(0.0);
  } else {
    vec3 sky = (u_showGrid > 0.5) ? gridSky(normalize(vel)) : starField(normalize(vel));
    col = sky;
  }

  col = col / (col + 1.0);
  col = pow(col, vec3(0.85));
  gl_FragColor = vec4(col, 1.0);
}
