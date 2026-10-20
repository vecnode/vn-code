precision highp float;
varying vec2 v_uv;
uniform sampler2D u_pres;
uniform sampler2D u_div;
uniform vec2 u_txl;
void main(){
  float L = texture2D(u_pres, v_uv - vec2(u_txl.x, 0.0)).x;
  float R = texture2D(u_pres, v_uv + vec2(u_txl.x, 0.0)).x;
  float B = texture2D(u_pres, v_uv - vec2(0.0, u_txl.y)).x;
  float T = texture2D(u_pres, v_uv + vec2(0.0, u_txl.y)).x;
  float d = texture2D(u_div, v_uv).x;
  gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}
