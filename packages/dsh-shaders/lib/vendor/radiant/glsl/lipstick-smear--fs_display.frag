precision highp float;
varying vec2 v_uv;
uniform sampler2D u_dye;
uniform vec2 u_res;
uniform float u_intensity;

float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }

void main(){
  vec4 dyeSamp = texture2D(u_dye, v_uv);
  vec3 col = dyeSamp.rgb * u_intensity;

  // Rose-gold metallic rim sheen on pigmented areas
  float pg = luma(col);
  vec2 vn = v_uv * 2.0 - 1.0;
  float rim = max(0.0, dot(normalize(vn + vec2(0.0)), normalize(vec2(0.5, 0.8))));
  rim = pow(rim, 5.0);
  col += vec3(1.0, 0.72, 0.78) * rim * pg * 0.7;

  // Bloom: two-pass cross — tight inner + wide outer for soft diffuse glow
  vec2 bx1 = 3.0 / u_res;
  vec3 b1 = (
    texture2D(u_dye, v_uv + vec2(bx1.x,0.0)).rgb +
    texture2D(u_dye, v_uv - vec2(bx1.x,0.0)).rgb +
    texture2D(u_dye, v_uv + vec2(0.0,bx1.y)).rgb +
    texture2D(u_dye, v_uv - vec2(0.0,bx1.y)).rgb
  ) * 0.25 * u_intensity;
  vec2 bx2 = 7.0 / u_res;
  vec3 b2 = (
    texture2D(u_dye, v_uv + vec2(bx2.x,0.0)).rgb +
    texture2D(u_dye, v_uv - vec2(bx2.x,0.0)).rgb +
    texture2D(u_dye, v_uv + vec2(0.0,bx2.y)).rgb +
    texture2D(u_dye, v_uv - vec2(0.0,bx2.y)).rgb
  ) * 0.25 * u_intensity;
  vec3 b = b1 * 0.6 + b2 * 0.4;
  col += b * max(0.0, luma(b) - 0.40) * 0.35;

  // Vignette
  float vig = pow(1.0 - dot(vn * vec2(0.6,0.75), vn * vec2(0.6,0.75)), 0.5);
  col *= clamp(vig, 0.0, 1.0);

  // Tone map: Reinhard keeps saturation at high values
  col = col / (col + vec3(0.75));

  // Gamma
  col = pow(max(col, vec3(0.0)), vec3(0.9));

  gl_FragColor = vec4(col, 1.0);
}
