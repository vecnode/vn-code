precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_pt;
uniform vec3 u_val;
uniform float u_rad;
uniform float u_asp;
void main(){
  vec2 d = v_uv - u_pt;
  d.x *= u_asp;
  float g = exp(-dot(d,d) / (u_rad * u_rad));
  vec4 base = texture2D(u_src, v_uv);
  gl_FragColor = vec4(base.xyz + g * u_val, 1.0);
}
