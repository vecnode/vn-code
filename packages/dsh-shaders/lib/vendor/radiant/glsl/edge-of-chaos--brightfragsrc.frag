precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state;
uniform float u_useFloat;

float decodeV(vec4 s) {
  if (u_useFloat > 0.5) return s.g;
  return s.g + s.a / 255.0;
}

void main() {
  vec4 state = texture2D(u_state, v_uv);
  float v = decodeV(state);
  // Only pass through bright areas for bloom
  float bright = smoothstep(0.15, 0.5, v) * v;
  gl_FragColor = vec4(bright, bright, bright, 1.0);
}
