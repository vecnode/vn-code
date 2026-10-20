precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_coronaSize;
uniform float u_rayIntensity;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

// ── Hash for star field and grain ──
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── Value noise ──
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// ── FBM for corona rays (3 octaves, cheap) ──
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = rot * p * 2.1 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// ── FBM 4 octaves for finer detail ──
float fbm4(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.866, 0.5, -0.5, 0.866);
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = rot * p * 2.05 + vec2(3.1, 7.4);
    a *= 0.48;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
  float t = u_time;
  float coronaSize = u_coronaSize;
  float rayIntensity = u_rayIntensity;

  // ── Polar coordinates ──
  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // ── Background: deep space ──
  vec3 col = vec3(0.005, 0.003, 0.008);

  // ── Star field — sparse hash-based points ──
  vec2 starGrid = floor(gl_FragCoord.xy / 3.0);
  float starHash = hash(starGrid * 0.73 + vec2(13.7, 29.3));
  float starBright = step(0.997, starHash);
  // Twinkle
  float twinkle = sin(t * 1.5 + starHash * 100.0) * 0.4 + 0.6;
  starBright *= twinkle * hash(starGrid * 1.31 + vec2(7.1, 3.9));
  // Fade stars near corona
  starBright *= smoothstep(0.15, 0.45, r);
  col += vec3(0.7, 0.75, 0.9) * starBright * 0.6;

  // ── Eclipse disc parameters ──
  float discRadius = 0.15;
  float chromoRadius = discRadius + 0.008;

  // ── Slow corona rotation ──
  float rotAngle = a + t * 0.05;

  // ── Corona ray noise — multiple octaves at different speeds ──
  // Octave 1: broad rays, slow
  float ray1 = fbm3(vec2(rotAngle * 3.0, r * 4.0 - t * 0.08));
  // Octave 2: medium detail, medium speed
  float ray2 = fbm3(vec2(rotAngle * 7.0 + 5.0, r * 6.0 - t * 0.12));
  // Octave 3: fine streaks, faster
  float ray3 = fbm4(vec2(rotAngle * 13.0 + 10.0, r * 8.0 - t * 0.18));

  // Combine rays with weighting
  float rays = ray1 * 0.5 + ray2 * 0.3 + ray3 * 0.2;

  // ── Angular asymmetry — corona streamers vary in length ──
  float asymmetry = 0.7 + 0.3 * sin(a * 2.0 + 0.5) * sin(a * 3.0 + t * 0.02);
  asymmetry += 0.15 * sin(a * 5.0 + 1.7);
  rays *= asymmetry;

  // ── Radial falloff for corona ──
  float coronaOuter = discRadius + 0.35 * coronaSize;
  float radialFalloff = smoothstep(coronaOuter, discRadius + 0.02, r);
  radialFalloff *= smoothstep(discRadius - 0.01, discRadius + 0.03, r);

  // ── Extended ray reach — rays extend further than base corona ──
  float rayReach = discRadius + 0.6 * coronaSize;
  float rayFalloff = smoothstep(rayReach, discRadius + 0.03, r);
  rayFalloff *= smoothstep(discRadius - 0.01, discRadius + 0.03, r);

  // ── Corona color gradient: warm amber inner to deep orange outer ──
  float colorMix = smoothstep(discRadius, coronaOuter, r);
  vec3 innerColor = vec3(1.0, 0.75, 0.30);
  vec3 outerColor = vec3(0.8, 0.35, 0.08);
  vec3 coronaColor = mix(innerColor, outerColor, colorMix);

  // ── Apply corona base glow ──
  float coronaGlow = radialFalloff * (0.4 + rays * 0.6);
  col += coronaColor * coronaGlow * 1.2 * rayIntensity;

  // ── Apply extended ray streaks ──
  float rayStreak = rayFalloff * pow(rays, 1.5) * 0.8;
  col += mix(coronaColor, outerColor, 0.5) * rayStreak * rayIntensity;

  // ── Bright inner corona ring (chromosphere) ──
  float chromoDist = abs(r - chromoRadius);
  float chromo = exp(-chromoDist * chromoDist / 0.00008);
  // Modulate with subtle noise for unevenness
  float chromoNoise = fbm3(vec2(rotAngle * 10.0, t * 0.2));
  chromo *= 0.7 + chromoNoise * 0.5;
  vec3 chromoColor = vec3(1.0, 0.85, 0.5);
  col += chromoColor * chromo * 2.5 * rayIntensity;

  // ── Hot inner edge — very tight bright ring ──
  float innerEdge = exp(-pow((r - discRadius) * 80.0, 2.0));
  innerEdge *= smoothstep(discRadius - 0.02, discRadius + 0.005, r);
  col += vec3(1.0, 0.95, 0.8) * innerEdge * 3.0;

  // ── Solar wind — fine radial streaks via cheap hash ──
  float windA = floor((a + t * 0.02) * 80.0);
  float windR2 = floor((r - t * 0.06) * 100.0);
  float wind = hash(vec2(windA, windR2));
  wind = smoothstep(0.95, 1.0, wind);
  float windFade = smoothstep(discRadius, discRadius + 0.05, r);
  windFade *= smoothstep(rayReach + 0.08, discRadius + 0.06, r);
  col += vec3(1.0, 0.85, 0.55) * wind * windFade * 0.06 * rayIntensity;

  // ── Bloom / lens flare ──
  // Soft wide glow around the corona
  float bloomDist = max(r - discRadius, 0.0);
  float bloom = exp(-bloomDist * 2.5);
  bloom *= smoothstep(discRadius - 0.05, discRadius + 0.01, r);
  col += vec3(0.4, 0.25, 0.1) * bloom * 0.25 * rayIntensity;

  // Very wide subtle bloom
  float wideBloom = exp(-r * 1.2) * 0.15;
  col += vec3(0.3, 0.18, 0.06) * wideBloom * rayIntensity;

  // Horizontal lens streak — soft and wide, not a sharp line
  float streak = exp(-uv.y * uv.y * 80.0) * exp(-abs(r - discRadius) * 5.0);
  streak *= smoothstep(discRadius - 0.02, discRadius + 0.05, r);
  col += vec3(0.6, 0.4, 0.2) * streak * 0.08 * rayIntensity;

  // ── Dark moon disc ──
  float disc = smoothstep(discRadius + 0.003, discRadius - 0.003, r);
  col *= 1.0 - disc;
  // Very faint lunar surface noise
  float lunarNoise = vnoise(uv * 40.0) * 0.008;
  col += vec3(lunarNoise * 0.5, lunarNoise * 0.4, lunarNoise * 0.3) * disc;

  // ── Diamond ring effect — follows cursor when active ──
  float diamondAngle = sin(t * 0.02) * PI;
  if (u_mouse.x > 0.0) {
    vec2 mUV = (u_mouse - u_res * 0.5) / min(u_res.x, u_res.y);
    diamondAngle = atan(mUV.y, mUV.x);
  }
  vec2 diamondDir = vec2(cos(diamondAngle), sin(diamondAngle));
  float diamondDot = dot(normalize(uv), diamondDir);
  float diamond = smoothstep(0.96, 1.0, diamondDot);
  float diamondR = smoothstep(discRadius + 0.025, discRadius, r);
  diamondR *= smoothstep(discRadius - 0.015, discRadius, r);
  float diamondGlow = diamond * diamondR;
  float diamondBoost = u_mouse.x > 0.0 ? 2.5 : 1.5;
  col += vec3(1.0, 0.95, 0.8) * diamondGlow * diamondBoost * rayIntensity;
  // Diamond bloom — soft radial spread
  float dBloomR = exp(-pow((r - discRadius) * 20.0, 2.0));
  float dBloomA = smoothstep(0.92, 1.0, diamondDot);
  col += vec3(0.5, 0.35, 0.15) * dBloomR * dBloomA * (diamondBoost * 0.4) * rayIntensity;

  // ── Mouse: corona brightens toward cursor direction ──
  if (u_mouse.x > 0.0) {
    float angleToCursor = dot(normalize(uv), diamondDir);
    float coronaPull = smoothstep(0.3, 1.0, angleToCursor);
    coronaPull *= smoothstep(discRadius, discRadius + 0.25, r);
    coronaPull *= smoothstep(0.6, discRadius + 0.05, r);
    col += vec3(0.8, 0.55, 0.25) * coronaPull * 0.15 * rayIntensity;
  }

  // ── Film grain ──
  float grain = (hash(gl_FragCoord.xy + fract(t * 43.0) * 1000.0) - 0.5) * 0.015;
  col += grain;

  // ── Vignette — darker sky away from corona ──
  float vig = 1.0 - smoothstep(0.3, 1.1, r);
  col *= 0.7 + 0.3 * vig;

  // ── Tone mapping — keep blacks deep ──
  col = max(col, vec3(0.0));
  // Soft highlight compression
  col = col / (1.0 + col * 0.3);
  // Slight warm push in shadows
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, col * vec3(1.06, 0.97, 0.90), smoothstep(0.05, 0.0, lum) * 0.2);

  gl_FragColor = vec4(col, 1.0);
}
