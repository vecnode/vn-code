precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform vec2 u_texelSize;

void main() {
  vec3 sum = vec3(0.0);
  sum += texture2D(u_tex, v_uv - 6.0 * u_dir * u_texelSize).rgb * 0.0044;
  sum += texture2D(u_tex, v_uv - 5.0 * u_dir * u_texelSize).rgb * 0.0115;
  sum += texture2D(u_tex, v_uv - 4.0 * u_dir * u_texelSize).rgb * 0.0257;
  sum += texture2D(u_tex, v_uv - 3.0 * u_dir * u_texelSize).rgb * 0.0488;
  sum += texture2D(u_tex, v_uv - 2.0 * u_dir * u_texelSize).rgb * 0.0799;
  sum += texture2D(u_tex, v_uv - 1.0 * u_dir * u_texelSize).rgb * 0.1133;
  sum += texture2D(u_tex, v_uv).rgb * 0.1340;
  sum += texture2D(u_tex, v_uv + 1.0 * u_dir * u_texelSize).rgb * 0.1133;
  sum += texture2D(u_tex, v_uv + 2.0 * u_dir * u_texelSize).rgb * 0.0799;
  sum += texture2D(u_tex, v_uv + 3.0 * u_dir * u_texelSize).rgb * 0.0488;
  sum += texture2D(u_tex, v_uv + 4.0 * u_dir * u_texelSize).rgb * 0.0257;
  sum += texture2D(u_tex, v_uv + 5.0 * u_dir * u_texelSize).rgb * 0.0115;
  sum += texture2D(u_tex, v_uv + 6.0 * u_dir * u_texelSize).rgb * 0.0044;
  gl_FragColor = vec4(sum, 1.0);
}
