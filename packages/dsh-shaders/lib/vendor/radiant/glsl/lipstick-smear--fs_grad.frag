precision highp float;
varying vec2 v_uv;
uniform sampler2D u_pres;
uniform sampler2D u_vel;
uniform vec2 u_txl;
void main(){
  float L = texture2D(u_pres, v_uv - vec2(u_txl.x, 0.0)).x;
  float R = texture2D(u_pres, v_uv + vec2(u_txl.x, 0.0)).x;
  float B = texture2D(u_pres, v_uv - vec2(0.0, u_txl.y)).x;
  float T = texture2D(u_pres, v_uv + vec2(0.0, u_txl.y)).x;
  vec2 v = texture2D(u_vel, v_uv).xy;
  gl_FragColor = vec4(v - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}
