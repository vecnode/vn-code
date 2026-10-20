precision highp float;
varying vec2 v_uv;
uniform sampler2D u_vel;
uniform sampler2D u_qty;
uniform vec2 u_txl;
uniform float u_dt;
uniform float u_diss;
void main(){
  vec2 vel = texture2D(u_vel, v_uv).xy;
  // vel in grid/s → multiply by txl to get UV/s
  vec2 pos = clamp(v_uv - vel * u_txl * u_dt, vec2(0.0), vec2(1.0));
  gl_FragColor = u_diss * texture2D(u_qty, pos);
}
