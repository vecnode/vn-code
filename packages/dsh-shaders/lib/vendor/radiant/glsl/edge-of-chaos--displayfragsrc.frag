precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state;
uniform sampler2D u_bloom;
uniform float u_time;
uniform vec2 u_res;
uniform vec2 u_simTexel;
uniform float u_warmth;
uniform float u_bgBright;
uniform float u_useFloat;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float decodeV(vec4 s) {
  if (u_useFloat > 0.5) return s.g;
  return s.g + s.a / 255.0;
}

vec3 palette(float t) {
  // 10-stop stained glass ember palette
  // Low t = background between patterns, high t = deep inside patterns
  vec3 c0 = vec3(0.04, 0.025, 0.06);
  vec3 c1 = vec3(0.07, 0.035, 0.09);
  vec3 c2 = vec3(0.12, 0.04, 0.08);
  vec3 c3 = vec3(0.18, 0.03, 0.06);
  vec3 c4 = vec3(0.40, 0.06, 0.02);
  vec3 c5 = vec3(0.62, 0.18, 0.03);
  vec3 c6 = vec3(0.82, 0.38, 0.06);
  vec3 c7 = vec3(0.92, 0.58, 0.12);
  vec3 c8 = vec3(0.88, 0.52, 0.18);
  vec3 c9 = vec3(1.0, 0.88, 0.55);

  // Apply warmth shift
  float w = (u_warmth - 1.0) * 0.4;
  c5 += vec3(0.08, 0.03, 0.0) * w;
  c6 += vec3(0.1, 0.06, 0.0) * w;
  c7 += vec3(0.05, 0.08, 0.0) * w;

  vec3 col;
  if (t < 0.03) {
    col = mix(c0, c1, t / 0.03);
  } else if (t < 0.08) {
    col = mix(c1, c2, (t - 0.03) / 0.05);
  } else if (t < 0.15) {
    col = mix(c2, c3, (t - 0.08) / 0.07);
  } else if (t < 0.25) {
    col = mix(c3, c4, (t - 0.15) / 0.10);
  } else if (t < 0.38) {
    col = mix(c4, c5, (t - 0.25) / 0.13);
  } else if (t < 0.52) {
    col = mix(c5, c6, (t - 0.38) / 0.14);
  } else if (t < 0.66) {
    col = mix(c6, c7, (t - 0.52) / 0.14);
  } else if (t < 0.80) {
    col = mix(c7, c8, (t - 0.66) / 0.14);
  } else if (t < 0.92) {
    col = mix(c8, c9, (t - 0.80) / 0.12);
  } else {
    col = mix(c9, vec3(1.0, 0.95, 0.80), (t - 0.92) / 0.08);
  }
  return col;
}

void main() {
  // Sample v chemical
  vec4 state = texture2D(u_state, v_uv);
  float val = decodeV(state);

  // Shape the v value: pull down the mid/high range so filled areas are darker
  // This makes the pattern read as dark channels with glowing edges, not bright worms
  float t = val;
  t = pow(t, 2.5);
  t = clamp(t * 1.5, 0.0, 1.0);

  vec3 col = palette(t);

  // Sobel edge detection on v for rim lighting
  float sL  = decodeV(texture2D(u_state, v_uv - vec2(u_simTexel.x, 0.0)));
  float sR  = decodeV(texture2D(u_state, v_uv + vec2(u_simTexel.x, 0.0)));
  float sU  = decodeV(texture2D(u_state, v_uv + vec2(0.0, u_simTexel.y)));
  float sD  = decodeV(texture2D(u_state, v_uv - vec2(0.0, u_simTexel.y)));
  float sTL = decodeV(texture2D(u_state, v_uv + vec2(-u_simTexel.x, u_simTexel.y)));
  float sTR = decodeV(texture2D(u_state, v_uv + vec2( u_simTexel.x, u_simTexel.y)));
  float sBL = decodeV(texture2D(u_state, v_uv + vec2(-u_simTexel.x,-u_simTexel.y)));
  float sBR = decodeV(texture2D(u_state, v_uv + vec2( u_simTexel.x,-u_simTexel.y)));

  // Sobel operators
  float gx = -sTL - 2.0*sL - sBL + sTR + 2.0*sR + sBR;
  float gy = -sTL - 2.0*sU - sTR + sBL + 2.0*sD + sBR;
  float grad = length(vec2(gx, gy)) * 5.0;
  grad = clamp(grad, 0.0, 1.0);

  // Brighter, warmer gold rim lighting on edges
  // Strong edge glow — this is the primary visual element
  vec3 rimColor = vec3(1.0, 0.75, 0.22);
  col += rimColor * grad * 1.2 * u_warmth;
  // Secondary cooler rim for depth
  col += vec3(0.4, 0.25, 0.6) * grad * 0.15;

  // Background brightness: lift the entire image toward a bg color
  // At bgBright=0: original dark look. At bgBright=1: bg is white, patterns stay visible on top.
  vec3 bgCol = mix(vec3(0.02, 0.01, 0.03), vec3(1.0, 1.0, 1.0), u_bgBright);
  // Use additive-style blend: bg lifts the floor, pattern detail rides on top
  col = bgCol + col * (1.0 - u_bgBright * 0.3);

  // Add bloom
  vec3 bloom = texture2D(u_bloom, v_uv).rgb;
  vec3 bloomTinted = palette(clamp(bloom.r * 2.5, 0.0, 1.0));
  col += bloomTinted * 0.4 * u_warmth;

  // Film grain
  vec2 grainUV = v_uv * u_res;
  float grain = hash(grainUV + vec2(fract(u_time * 7.3), fract(u_time * 11.1)));
  grain = (grain - 0.5) * 0.03;
  col += grain;

  // Vignette
  vec2 vigUV = v_uv * 2.0 - 1.0;
  float vig = 1.0 - dot(vigUV * 0.5, vigUV * 0.5);
  vig = clamp(vig, 0.0, 1.0);
  vig = vig * vig;
  col *= 0.3 + vig * 0.7;

  // Tone mapping (Reinhard)
  col = col / (1.0 + col * 0.15);

  // Gamma
  col = pow(col, vec3(0.95));

  gl_FragColor = vec4(col, 1.0);
}
