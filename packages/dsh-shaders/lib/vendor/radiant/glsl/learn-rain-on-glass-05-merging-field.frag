
precision mediump float;
uniform sampler2D u_waterMap;
uniform sampler2D u_background;
uniform vec2 u_res;
uniform float u_refraction;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 waterUV = vec2(uv.x, 1.0 - uv.y);
  vec4 water = texture2D(u_waterMap, waterUV);
  vec2 offset = (vec2(water.g, water.r) - 0.5) * 2.0;
  float depth = water.b;
  vec2 refractedUV = uv + offset * (256.0 + depth * 256.0) / u_res.x * u_refraction;
  vec4 bg = texture2D(u_background, refractedUV);
  gl_FragColor = mix(texture2D(u_background, uv), bg, clamp(water.a * 4.0 - 1.0, 0.0, 1.0));
}
