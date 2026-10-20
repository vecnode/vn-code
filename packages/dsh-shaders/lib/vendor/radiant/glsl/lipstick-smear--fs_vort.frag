precision highp float;
varying vec2 v_uv;
uniform sampler2D u_vel;
uniform vec2 u_txl;
void main(){
  float L = texture2D(u_vel, v_uv - vec2(u_txl.x, 0.0)).y;
  float R = texture2D(u_vel, v_uv + vec2(u_txl.x, 0.0)).y;
  float B = texture2D(u_vel, v_uv - vec2(0.0, u_txl.y)).x;
  float T = texture2D(u_vel, v_uv + vec2(0.0, u_txl.y)).x;
  gl_FragColor = vec4(0.5 * (R - L - (T - B)), 0.0, 0.0, 1.0);
}
