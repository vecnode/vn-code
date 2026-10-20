precision highp float;
varying vec2 v_uv;
uniform sampler2D u_vel;
uniform sampler2D u_vort;
uniform vec2 u_txl;
uniform float u_curl;
uniform float u_dt;
void main(){
  float L = abs(texture2D(u_vort, v_uv - vec2(u_txl.x, 0.0)).x);
  float R = abs(texture2D(u_vort, v_uv + vec2(u_txl.x, 0.0)).x);
  float B = abs(texture2D(u_vort, v_uv - vec2(0.0, u_txl.y)).x);
  float T = abs(texture2D(u_vort, v_uv + vec2(0.0, u_txl.y)).x);
  float c = texture2D(u_vort, v_uv).x;
  vec2 eta = normalize(vec2(T - B, R - L) + vec2(1e-5));
  vec2 f = u_curl * vec2(eta.y, -eta.x) * c;
  vec2 v = texture2D(u_vel, v_uv).xy;
  gl_FragColor = vec4(v + f * u_dt, 0.0, 1.0);
}
