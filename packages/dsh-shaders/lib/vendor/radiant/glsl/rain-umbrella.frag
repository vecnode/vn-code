precision mediump float;

uniform sampler2D u_waterMap;
uniform sampler2D u_textureShine;
uniform sampler2D u_textureFg;
uniform sampler2D u_textureBg;

uniform vec2 u_resolution;
uniform vec2 u_parallax;
uniform float u_parallaxFg;
uniform float u_parallaxBg;
uniform float u_textureRatio;
uniform bool u_renderShine;
uniform bool u_renderShadow;
uniform float u_minRefraction;
uniform float u_refractionDelta;
uniform float u_brightness;
uniform float u_alphaMultiply;
uniform float u_alphaSubtract;
uniform float u_time;

vec4 blend(vec4 bg, vec4 fg) {
  vec3 bgm = bg.rgb * bg.a;
  vec3 fgm = fg.rgb * fg.a;
  float ia = 1.0 - fg.a;
  float a = (fg.a + bg.a * ia);
  vec3 rgb;
  if (a != 0.0) {
    rgb = (fgm + bgm * ia) / a;
  } else {
    rgb = vec3(0.0, 0.0, 0.0);
  }
  return vec4(rgb, a);
}

vec2 pixel() {
  return vec2(1.0, 1.0) / u_resolution;
}

vec2 parallax(float v) {
  return u_parallax * pixel() * v;
}

vec2 texCoord() {
  return vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) / u_resolution;
}

vec2 scaledTexCoord() {
  float ratio = u_resolution.x / u_resolution.y;
  vec2 scale = vec2(1.0, 1.0);
  vec2 offset = vec2(0.0, 0.0);
  float ratioDelta = ratio - u_textureRatio;
  if (ratioDelta >= 0.0) {
    scale.y = (1.0 + ratioDelta);
    offset.y = ratioDelta / 2.0;
  } else {
    scale.x = (1.0 - ratioDelta);
    offset.x = -ratioDelta / 2.0;
  }
  return (texCoord() + offset) / scale;
}

vec4 fgColor(float x, float y) {
  float p2 = u_parallaxFg * 2.0;
  vec2 scale = vec2(
    (u_resolution.x + p2) / u_resolution.x,
    (u_resolution.y + p2) / u_resolution.y
  );
  vec2 scaledTC = texCoord() / scale;
  vec2 offset = vec2(
    (1.0 - (1.0 / scale.x)) / 2.0,
    (1.0 - (1.0 / scale.y)) / 2.0
  );
  return texture2D(u_waterMap,
    (scaledTC + offset) + (pixel() * vec2(x, y)) + parallax(u_parallaxFg)
  );
}

// ── Umbrella structure: ribs, panels, dome curvature ──
vec3 applyUmbrellaRibs(vec3 color, vec2 pos) {
  vec2 center = vec2(0.5, 0.5);
  vec2 dir = pos - center;
  float aspect = u_resolution.x / u_resolution.y;
  dir.x *= aspect;
  float dist = length(dir);
  float ang = atan(dir.y, dir.x);

  float PI = 3.14159265;
  float NUM_RIBS = 8.0;
  float SECTOR = PI * 2.0 / NUM_RIBS;

  // Angular distance to nearest rib
  float secAng = mod(ang + SECTOR * 0.5, SECTOR) - SECTOR * 0.5;

  // Organic wobble — ribs flex under fabric tension + per-rib variation
  float ribIdx = floor((ang + PI) / SECTOR);
  float wobble = sin(dist * 16.0 + ribIdx * 4.7) * 0.018 * dist;
  wobble += sin(dist * 37.0 - ribIdx * 2.3) * 0.008 * dist;
  wobble *= smoothstep(0.0, 0.1, dist);
  secAng += wobble;

  float angDist = abs(secAng);
  float screenDist = angDist * dist;

  // Rib width: thicker near hub, tapers toward tips
  float ribW = mix(0.006, 0.0008, smoothstep(0.0, 0.55, dist));
  float rib = 1.0 - smoothstep(ribW * 0.15, ribW, screenDist);

  // Rib fades out near the very edge (tips are thinner)
  rib *= 1.0 - smoothstep(0.55, 0.75, dist);

  // 3D depth: highlight on one side, shadow on the other
  float side = step(0.0, secAng) * 2.0 - 1.0;
  float highlight = rib * 0.06 * max(0.0, side);
  float shadow = rib * 0.14;

  // Panel billowing: fabric sags between ribs creating curved shadow
  float panelEdge = smoothstep(0.0, SECTOR * 0.35 * max(0.01, dist), screenDist);
  float panelShade = (1.0 - panelEdge * panelEdge) * 0.025 * smoothstep(0.03, 0.25, dist);

  // Alternating panel tint (slightly warmer / cooler)
  float panelIdx = floor((ang + PI) / SECTOR);
  float panelTint = mod(panelIdx, 2.0) * 0.012 - 0.006;

  // Center cap / hub
  float cap = (1.0 - smoothstep(0.008, 0.016, dist)) * 0.18;
  // Small ring around cap
  float ring = (1.0 - abs(dist - 0.02) / 0.004);
  ring = max(0.0, ring) * 0.06;

  // Dome vignette: edges darker from steeper viewing angle
  float vig = smoothstep(0.05, 0.7, dist);
  vig = vig * vig * 0.14;

  float darken = shadow + panelShade + cap + ring + vig;
  color = color * (1.0 - darken) + vec3(highlight + panelTint);

  return color;
}

void main() {
  vec2 walkOffset = vec2(u_time * 0.03, sin(u_time * 0.5) * 0.003);
  vec4 bg = texture2D(u_textureBg, scaledTexCoord() + walkOffset);

  vec4 cur = fgColor(0.0, 0.0);

  float d = cur.b;
  float x = cur.g;
  float y = cur.r;

  float a = clamp(cur.a * u_alphaMultiply - u_alphaSubtract, 0.0, 1.0);

  vec2 refraction = (vec2(x, y) - 0.5) * 2.0;
  vec2 refractionParallax = parallax(u_parallaxBg - u_parallaxFg);
  vec2 refractionPos = scaledTexCoord()
    + (pixel() * refraction * (u_minRefraction + (d * u_refractionDelta)))
    + refractionParallax;

  vec4 tex = texture2D(u_textureFg, refractionPos + walkOffset);

  if (u_renderShine) {
    float maxShine = 490.0;
    float minShine = maxShine * 0.18;
    vec2 shinePos = vec2(0.5, 0.5) + ((1.0 / 512.0) * refraction) * -(minShine + ((maxShine - minShine) * d));
    vec4 shine = texture2D(u_textureShine, shinePos);
    tex = blend(tex, shine);
  }

  vec4 fg = vec4(tex.rgb * u_brightness, a);

  if (u_renderShadow) {
    float borderAlpha = fgColor(0.0, 0.0 - (d * 6.0)).a;
    borderAlpha = borderAlpha * u_alphaMultiply - (u_alphaSubtract + 0.5);
    borderAlpha = clamp(borderAlpha, 0.0, 1.0);
    borderAlpha *= 0.2;
    vec4 border = vec4(0.0, 0.0, 0.0, borderAlpha);
    fg = blend(border, fg);
  }

  vec4 result = blend(bg, fg);
  result.rgb = applyUmbrellaRibs(result.rgb, texCoord());
  gl_FragColor = result;
}
