precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_sweep;
uniform float u_intensity;
uniform vec2 u_mouse;

#define PI 3.14159265359

// ── Hash & noise for fog ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// ── 3D value noise ──
float noise3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i);
  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

// ── FBM (4 octaves) ──
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  vec3 shift = vec3(100.0);
  for (int i = 0; i < 4; i++) {
    v += a * noise3d(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

// ── Color palette with hue rotation ──
vec3 coneColor(int idx, float hueShift) {
  vec3 col;
  if (idx == 0) col = vec3(1.0, 0.0, 0.5);
  else if (idx == 1) col = vec3(0.5, 0.05, 1.0);
  else if (idx == 2) col = vec3(0.1, 0.35, 1.0);
  else if (idx == 3) col = vec3(0.85, 0.0, 0.85);
  else if (idx == 4) col = vec3(0.15, 0.2, 1.0);
  else col = vec3(0.0, 0.8, 0.95);

  // Apply slow hue rotation
  float angle = hueShift;
  float cosA = cos(angle);
  float sinA = sin(angle);
  // Approximate hue rotation via luminance-preserving rotation
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 grey = vec3(lum);
  vec3 diff = col - grey;
  // Rotate in the plane perpendicular to the luminance axis
  vec3 axis1 = normalize(vec3(1.0, -1.0, 0.0));
  vec3 axis2 = normalize(vec3(0.5, 0.5, -1.0));
  float d1 = dot(diff, axis1);
  float d2 = dot(diff, axis2);
  vec3 rotated = grey + axis1 * (d1 * cosA - d2 * sinA) + axis2 * (d1 * sinA + d2 * cosA);
  return clamp(rotated, 0.0, 1.0);
}

void main() {
  // UV: 0..1 range, y=0 at bottom, y=1 at top
  vec2 fragUV = gl_FragCoord.xy / u_res;
  // Aspect-corrected UV centered at (0.5, 1.0) for top-origin cones
  float aspect = u_res.x / u_res.y;
  vec2 uv = fragUV;
  uv.x = (uv.x - 0.5) * aspect;  // centered horizontally, aspect corrected
  // uv.y goes 0 (bottom) to 1 (top)

  float t = u_time * u_sweep;
  float intensity = u_intensity;

  // ── Mouse attraction: bend beams toward cursor ──
  vec2 mouseUV = vec2(-1.0);
  if (u_mouse.x > 0.0) {
    mouseUV = u_mouse / u_res;
    mouseUV.x = (mouseUV.x - 0.5) * aspect;
  }

  // ── Fog base: 3D FBM noise drifting slowly ──
  vec3 fogCoord = vec3(fragUV * 3.0, t * 0.08);
  fogCoord.y -= t * 0.03;  // slow upward drift
  fogCoord.x += t * 0.015; // slight sideways drift
  float fogDensity = fbm(fogCoord);

  // Second fog layer for more detail
  vec3 fogCoord2 = vec3(fragUV * 6.0 + 50.0, t * 0.12);
  fogCoord2.y -= t * 0.05;
  float fogDetail = fbm(fogCoord2);
  float fog = fogDensity * 0.5 + fogDetail * 0.5;
  fog = fog * fog * 1.5;  // boost contrast for visible wisps

  // ── Accumulate light from all cones ──
  vec3 col = vec3(0.0);

  // Bounded hue oscillation (stays in cool/neon range)
  float hueShift = sin(t * 0.07) * 0.2;

  // Global beat pulse (~1.5 second period)
  float globalBeat = pow(abs(sin(t * PI / 1.5)), 8.0) * 0.2;

  // ── Far layer: 3 cones (indices 0-2) ──
  // These are dimmer, move slower, slightly blurred
  for (int i = 0; i < 3; i++) {
    float fi = float(i);

    // Origin spread along top edge
    float originX = (fi - 1.0) * 0.4 * aspect;  // spread across top
    originX += sin(t * 0.07 + fi * 2.5) * 0.1 * aspect;  // slight drift
    vec2 origin = vec2(originX, 1.05);  // just above top edge

    // Sweep angle: smooth sinusoidal, slower for far layer
    float baseAngle = PI * 0.5;  // pointing downward (toward y=0)
    float sweepAmp = 0.4 + fi * 0.1;
    float sweepFreq = 0.3 + fi * 0.11;
    float theta = sin(t * sweepFreq * 0.7 + fi * 1.9) * sweepAmp;

    // Direction of cone center (pointing downward from top)
    vec2 dir = vec2(sin(theta), -cos(theta));

    // Mouse attraction: smoothly bend beam toward cursor
    if (mouseUV.x > -0.5) {
      vec2 toMouse = mouseUV - origin;
      float mouseAngle = atan(toMouse.x, -toMouse.y);
      float attraction = 0.3 / (1.0 + length(toMouse) * 2.0);
      float angleDiff = mouseAngle - theta;
      // Normalize angle diff to [-PI, PI] to prevent wrapping jumps
      angleDiff = mod(angleDiff + PI, PI * 2.0) - PI;
      float blended = theta + angleDiff * attraction;
      dir = vec2(sin(blended), -cos(blended));
    }

    // Vector from origin to current pixel
    vec2 toPixel = uv - origin;

    // Project onto cone axis
    float along = dot(toPixel, dir);

    // Perpendicular distance from cone axis
    float perp = abs(toPixel.x * dir.y - toPixel.y * dir.x);

    // Wide cone for far layer
    float halfWidth = 0.13 + fi * 0.015;
    float coneWidth = halfWidth * max(along, 0.0) + 0.012;

    // Soft gaussian falloff from center
    float inCone = exp(-perp * perp / (coneWidth * coneWidth * 0.55));

    // Only illuminate in front of origin (along > 0)
    inCone *= smoothstep(0.0, 0.08, along);

    // Distance falloff (dimmer farther from source)
    inCone *= exp(-along * along * 0.15);

    // Fog modulation: light scattering through smoke
    float fogMod = 0.25 + fog * 0.75;
    float volumetric = inCone * fogMod;

    // Far layer: reduced brightness and slightly blurred (wider cone)
    float farOpacity = 0.35;

    vec3 coneCol = coneColor(i, hueShift + fi * 0.15);
    col += coneCol * volumetric * farOpacity * intensity * (1.0 + globalBeat);
  }

  // ── Near layer: 3 cones (indices 3-5) ──
  // Brighter, sharper, faster movement
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    int colorIdx = i + 3;

    // Origin spread along top edge, offset from far layer
    float originX = (fi - 1.0) * 0.5 * aspect + 0.15 * aspect;
    originX += sin(t * 0.1 + fi * 3.1 + 1.0) * 0.08 * aspect;
    vec2 origin = vec2(originX, 1.02);

    // Sweep angle: smooth sinusoidal + beat snaps
    float sweepAmp = 0.5 + fi * 0.08;
    float sweepFreq = 0.4 + fi * 0.13;
    float theta = sin(t * sweepFreq + fi * 2.3 + 0.7) * sweepAmp;

    // Beat snap: smooth rhythmic accent on 1-2 cones at a time
    float beatFreq = 1.8 + fi * 0.4;
    float snap = pow(abs(sin(t * beatFreq)), 6.0);
    // Smooth gate so snaps fade in/out rather than pop
    float snapGate = smoothstep(0.5, 0.85, sin(t * 0.7 + fi * 2.094));
    theta += snap * snapGate * 0.18 * sin(t * beatFreq * 0.5);

    vec2 dir = vec2(sin(theta), -cos(theta));

    // Mouse attraction: smoothly bend beam toward cursor
    if (mouseUV.x > -0.5) {
      vec2 toMouse = mouseUV - origin;
      float mouseAngle = atan(toMouse.x, -toMouse.y);
      float attraction = 0.4 / (1.0 + length(toMouse) * 2.0);
      float angleDiff = mouseAngle - theta;
      angleDiff = mod(angleDiff + PI, PI * 2.0) - PI;
      float blended = theta + angleDiff * attraction;
      dir = vec2(sin(blended), -cos(blended));
    }

    vec2 toPixel = uv - origin;
    float along = dot(toPixel, dir);
    float perp = abs(toPixel.x * dir.y - toPixel.y * dir.x);

    // Wider cone for cinematic spotlights
    float halfWidth = 0.11 + fi * 0.012;
    float coneWidth = halfWidth * max(along, 0.0) + 0.01;

    // Gaussian falloff with bright core
    float inCone = exp(-perp * perp / (coneWidth * coneWidth * 0.4));
    // Bright center line within cone
    float coreLine = exp(-perp * perp / (coneWidth * coneWidth * 0.04));
    inCone = inCone + coreLine * 0.4;
    inCone *= smoothstep(0.0, 0.06, along);
    inCone *= exp(-along * along * 0.1);

    // Fog modulation
    float fogMod = 0.2 + fog * 0.8;
    float volumetric = inCone * fogMod;

    // Near layer: bright
    float nearOpacity = 0.75;

    vec3 coneCol = coneColor(colorIdx, hueShift + fi * 0.15 + 0.5);
    col += coneCol * volumetric * nearOpacity * intensity * (1.0 + globalBeat);
  }

  // ── Intersection bloom: additive blending already handles this ──
  // Where cones overlap, color adds up. Boost those bright areas toward white.
  float brightness = dot(col, vec3(0.299, 0.587, 0.114));
  // Push overlapping areas toward white (desaturate at high brightness)
  float whiteBlend = smoothstep(0.4, 1.2, brightness);
  col = mix(col, vec3(brightness * 1.3), whiteBlend * 0.5);

  // ── Ground haze: fog pooling on the dance floor ──
  float groundHaze = smoothstep(0.2, 0.0, fragUV.y);
  float hazeFog = fbm(vec3(fragUV.x * 4.0, fragUV.y * 2.0, t * 0.05 + 10.0));
  col += col * groundHaze * 0.3;
  // Subtle ambient haze at floor level
  col += vec3(0.06, 0.03, 0.1) * groundHaze * hazeFog * intensity;

  // ── Exponential tone mapping ──
  float exposure = 2.0;
  col = 1.0 - exp(-col * exposure);

  // ── Film grain ──
  float grain = hash(gl_FragCoord.xy + fract(u_time) * 100.0) * 0.04 - 0.02;
  col += grain;

  // ── Vignette (corners only) ──
  vec2 vigUV = fragUV - 0.5;
  float vigDist = dot(vigUV, vigUV);
  float vig = 1.0 - vigDist * 0.8;
  vig = clamp(vig, 0.0, 1.0);
  col *= vig;

  // Clamp to valid range
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
