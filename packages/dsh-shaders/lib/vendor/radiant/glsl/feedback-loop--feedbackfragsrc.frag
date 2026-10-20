precision highp float;
varying vec2 v_uv;
uniform sampler2D u_prev;
uniform float u_time;
uniform vec2 u_res;
uniform float u_zoomSpeed;
uniform float u_rotSpeed;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

// ── Hash ──
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── SDF primitives ──
float sdHexagon(vec2 p, float r) {
  vec2 q = abs(p);
  return max(q.x - r * 0.866, max(q.x * 0.5 + q.y * 0.866 - r * 0.866, q.y - r * 0.5));
}

float sdTriangle(vec2 p, float r) {
  float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

float sdStar(vec2 p, float r, int n, float m) {
  float an = PI / float(n);
  float en = PI / m;
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}

// ── 2D rotation ──
vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void main() {
  vec2 uv = v_uv;
  float aspect = u_res.x / u_res.y;
  float t = u_time;

  // ── Mouse offset for tunnel center ──
  vec2 mouseOffset = (u_mouse - 0.5) * 0.15;

  // ── Feedback sampling: zoom in + rotate from previous frame ──
  vec2 center = vec2(0.5) + mouseOffset;
  vec2 fromCenter = uv - center;

  // Correct for aspect ratio when rotating
  fromCenter.x *= aspect;

  // Zoom: scale UV toward center (2-3% per frame, modulated)
  float zoomAmt = 0.02 + 0.008 * sin(t * 0.3);
  zoomAmt *= u_zoomSpeed;
  float zoom = 1.0 - zoomAmt;
  fromCenter *= zoom;

  // Rotation: small rotation per frame
  float rotAmt = 0.008 + 0.004 * sin(t * 0.5);
  rotAmt *= u_rotSpeed;
  // Smoothly alternate rotation direction
  rotAmt *= sin(t * 0.07);
  fromCenter = rot2(fromCenter, rotAmt);

  // Undo aspect correction
  fromCenter.x /= aspect;

  vec2 feedbackUV = fromCenter + center;

  // Sample previous frame with slight color channel offset for chromatic drift
  float chromShift = 0.002;
  vec2 rUV = feedbackUV + vec2(chromShift, 0.0);
  vec2 gUV = feedbackUV;
  vec2 bUV = feedbackUV - vec2(chromShift, 0.0);

  vec3 feedback = vec3(
    texture2D(u_prev, rUV).r,
    texture2D(u_prev, gUV).g,
    texture2D(u_prev, bUV).b
  );

  // ── Color cycling: hue-shift the feedback so older rings drift through colors ──
  // Shift warm amber toward cyan → teal → back to amber over many frames
  float hueShift = 0.012;
  // Rotate RGB channels slightly: approximate hue rotation in RGB space
  // Using a simplified rotation matrix around the (1,1,1) axis
  float cs = cos(hueShift), sn = sin(hueShift);
  float oneThird = 1.0 / 3.0;
  float sqrtThird = 0.57735;
  mat3 hueMatrix = mat3(
    cs + oneThird * (1.0 - cs),          oneThird * (1.0 - cs) - sqrtThird * sn, oneThird * (1.0 - cs) + sqrtThird * sn,
    oneThird * (1.0 - cs) + sqrtThird * sn, cs + oneThird * (1.0 - cs),          oneThird * (1.0 - cs) - sqrtThird * sn,
    oneThird * (1.0 - cs) - sqrtThird * sn, oneThird * (1.0 - cs) + sqrtThird * sn, cs + oneThird * (1.0 - cs)
  );
  feedback = hueMatrix * feedback;

  // ── Decay: darken feedback slightly so it doesn't blow out ──
  feedback *= 0.96;

  // Clamp feedback from areas outside texture
  float inBounds = step(0.0, feedbackUV.x) * step(feedbackUV.x, 1.0) *
                   step(0.0, feedbackUV.y) * step(feedbackUV.y, 1.0);
  feedback *= inBounds;

  // ── Geometric seed shapes at center ──
  // These are composited on top of the feedback each frame
  vec2 seedCenter = vec2(0.5) + mouseOffset * 0.5;
  vec2 sp = uv - seedCenter;
  sp.x *= aspect;

  // Mouse affects seed shape size
  float mouseDist = length(u_mouse - 0.5);
  float seedScale = 0.06 + mouseDist * 0.04;

  // Cycle through shapes over time
  float shapeCycle = mod(t * 0.15, 4.0);
  float shapeBlend = fract(shapeCycle);
  float shapeSmooth = shapeBlend * shapeBlend * (3.0 - 2.0 * shapeBlend);
  int shapeA = int(mod(floor(shapeCycle), 4.0));

  // Rotate the seed shapes slowly
  float seedRot = t * 0.3 * u_rotSpeed;
  vec2 rsp = rot2(sp, seedRot);

  // Pulsing size
  float pulse = seedScale * (0.85 + 0.15 * sin(t * 2.0));

  // Calculate SDFs for different shapes
  float dHex = sdHexagon(rsp, pulse);
  float dTri = sdTriangle(rsp, pulse * 1.3);
  float dCirc = sdCircle(rsp, pulse * 0.7);
  float dStar = sdStar(rsp, pulse * 0.9, 5, 2.5);

  // Blend between current and next shape
  float d1, d2;
  if (shapeA == 0) { d1 = dHex; d2 = dTri; }
  else if (shapeA == 1) { d1 = dTri; d2 = dCirc; }
  else if (shapeA == 2) { d1 = dCirc; d2 = dStar; }
  else { d1 = dStar; d2 = dHex; }
  float d = mix(d1, d2, shapeSmooth);

  // Sharp shape edge with slight glow
  float shape = 1.0 - smoothstep(-0.003, 0.003, d);
  float shapeGlow = 1.0 - smoothstep(0.0, 0.025, d);

  // ── Secondary ring shapes at larger radius ──
  float ringRadius = pulse * 2.8 + 0.02 * sin(t * 1.5);
  float ringThickness = 0.004 + 0.002 * sin(t * 3.0);
  float ringDist = abs(length(rsp) - ringRadius);
  float ring = 1.0 - smoothstep(0.0, ringThickness, ringDist);

  // Second ring
  float ring2Radius = pulse * 4.5;
  float ring2Dist = abs(length(rsp) - ring2Radius);
  float ring2 = 1.0 - smoothstep(0.0, ringThickness * 0.5, ring2Dist);

  // ── Rotating dot pattern around center ──
  float dotAngle = atan(sp.y, sp.x) + t * 0.5;
  float dotRadius = length(sp);
  float numDots = 6.0;
  float dotPattern = step(0.95, cos(dotAngle * numDots) * 0.5 + 0.5) *
                     step(0.03, dotRadius) * step(dotRadius, 0.05);

  // ── Seed colors: warm amber/cyan holographic palette ──
  // Main shape: bright warm amber core
  vec3 seedColor = vec3(0.95, 0.65, 0.25) * shape;
  // Shape glow: softer amber halo
  seedColor += vec3(0.7, 0.45, 0.15) * shapeGlow * 0.5;
  // Ring: holographic cyan
  seedColor += vec3(0.15, 0.75, 0.85) * ring * 0.8;
  // Second ring: dimmer, shifted color
  seedColor += vec3(0.5, 0.35, 0.65) * ring2 * 0.4;
  // Dot accents
  seedColor += vec3(1.0, 0.85, 0.5) * dotPattern * 0.6;

  // ── Occasional bright flash/burst seed to inject energy ──
  float burstPhase = mod(t * 0.4, 1.0);
  float burst = smoothstep(0.0, 0.05, burstPhase) * smoothstep(0.15, 0.05, burstPhase);
  float burstShape = 1.0 - smoothstep(0.0, pulse * 1.5, length(sp));
  seedColor += vec3(1.0, 0.9, 0.6) * burst * burstShape * 0.5;

  // ── Composite: add seed shapes on top of feedback ──
  vec3 color = feedback + seedColor;

  gl_FragColor = vec4(color, 1.0);
}
