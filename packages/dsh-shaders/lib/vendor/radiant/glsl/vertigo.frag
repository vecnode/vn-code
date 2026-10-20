precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_tunnelSpeed;
uniform float u_spiralIntensity;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

// ── Hash for noise ──
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// ── Value noise ──
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;

  // Center UV, correct aspect
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float t = u_time;
  float scrollSpeed = u_tunnelSpeed;

  // ── Polar coordinates ──
  float r = length(p);
  float theta = atan(p.y, p.x);

  // ── Steady tunnel depth — NO dolly-zoom, fixed FOV ──
  float depth = 1.0 / (r + 0.04);

  // ── Rotation: auto drift + mouse drag offset ──
  float rotAngle = t * 0.02 + sin(t * 0.07) * 0.15 + u_mouse.x;
  float thetaRot = theta + rotAngle;

  // ── Tunnel texture coordinates ──
  // u = angle (wrapping), v = depth (scrolling forward steadily)
  float tu = thetaRot / TAU;
  float tv = depth - t * scrollSpeed;

  // ── Ring segments ──
  float ringFreq = 10.0;
  float ringCoord = tv * ringFreq / TAU;
  float ringPhase = fract(ringCoord);
  float ringId = floor(ringCoord);

  // Primary rings — clean sharp edges
  float ring = smoothstep(0.0, 0.06, ringPhase) * smoothstep(0.5, 0.44, ringPhase);

  // Secondary thinner accent rings between primaries
  float ringPhase2 = fract(ringCoord * 2.0);
  float ring2 = smoothstep(0.0, 0.03, ringPhase2) * smoothstep(0.5, 0.47, ringPhase2);

  // ── Angular segments (line divisions around the tunnel) ──
  float angSegments = 16.0;
  float angPhase = fract(tu * angSegments);
  float angLine = smoothstep(0.0, 0.025, angPhase) * smoothstep(1.0, 0.975, angPhase);

  // ── Combine into tunnel structure ──
  float structure = ring * angLine;
  // Add thin rings as subtle accent
  structure = max(structure, ring2 * 0.25 * angLine);

  // ── Wave-based ring illumination ──
  // Multiple slow waves propagating outward at different speeds
  // Wave 1: primary outward pulse
  float wave1 = sin(ringId * 0.5 - t * 0.8) * 0.5 + 0.5;
  wave1 = pow(wave1, 3.0);

  // Wave 2: slower, wider inward pulse (counter-direction)
  float wave2 = sin(ringId * 0.3 + t * 0.5) * 0.5 + 0.5;
  wave2 = pow(wave2, 4.0);

  // Wave 3: very slow breathing that lights groups of rings
  float wave3 = sin(ringId * 0.15 - t * 0.35) * 0.5 + 0.5;
  wave3 = pow(wave3, 2.0);

  // Compose ring brightness from overlapping waves
  float ringBrightness = 0.15 + wave1 * 0.5 + wave2 * 0.35 + wave3 * 0.25;
  ringBrightness = clamp(ringBrightness, 0.0, 1.5);

  // Occasional bright flash on specific rings (sparse)
  float flash = pow(max(0.0, sin(ringId * 7.3 - t * 1.2)), 12.0);
  ringBrightness += flash * 0.8;

  structure *= ringBrightness;

  // ── Depth fog: fade rings into void at distance ──
  float depthFade = exp(-r * 3.0);
  // Near the center (deep void), fade to black
  float voidFade = smoothstep(0.0, 0.12, r);
  structure *= depthFade * voidFade;

  // ── Neon edge highlights on ring edges ──
  float edgeHighlight = smoothstep(0.06, 0.02, abs(ringPhase - 0.01));
  edgeHighlight += smoothstep(0.06, 0.02, abs(ringPhase - 0.48));
  edgeHighlight *= angLine * depthFade * voidFade;

  // ── Color scheme — richer palette ──
  // Deep crimson base
  vec3 crimson = vec3(0.80, 0.067, 0.20);
  // Dark purple
  vec3 darkPurple = vec3(0.133, 0.0, 0.20);
  // Neon red accent
  vec3 neonRed = vec3(1.0, 0.133, 0.267);
  // Warm amber highlight
  vec3 amber = vec3(0.784, 0.584, 0.424);
  // Deep magenta for variety
  vec3 magenta = vec3(0.6, 0.05, 0.35);
  // Burnt orange for warm accents
  vec3 burntOrange = vec3(0.85, 0.35, 0.1);

  // ── Per-ring color variation ──
  // Each ring gets a slightly different hue based on its ID
  float colorSel = fract(ringId * 0.618033); // golden ratio spacing
  float colorShift = sin(ringId * 1.7 + t * 0.2) * 0.5 + 0.5;

  // Base tunnel color blends crimson and purple by radius
  float colorDepth = smoothstep(0.0, 0.5, r);
  vec3 tunnelColor = mix(darkPurple, crimson, colorDepth);

  // Vary individual ring colors
  tunnelColor = mix(tunnelColor, magenta, colorSel * 0.3);
  tunnelColor = mix(tunnelColor, crimson * 1.3, colorShift * 0.25);

  // Amber tint on wave-lit rings
  float amberAmount = wave1 * wave3;
  tunnelColor = mix(tunnelColor, amber * 0.8, amberAmount * 0.3);

  // Burnt orange on flash rings
  tunnelColor = mix(tunnelColor, burntOrange, flash * 0.5);

  // ── Edge highlight color varies too ──
  vec3 edgeColor = mix(neonRed, amber, wave2 * 0.4);
  edgeColor = mix(edgeColor, magenta * 1.5, flash * 0.3);

  // ── Composite ──
  vec3 col = vec3(0.0);

  // Base tunnel structure
  col += tunnelColor * structure;

  // Edge highlights with varied color
  col += edgeColor * edgeHighlight * 0.5;

  // Amber glow on bright pulsing rings
  col += amber * wave1 * structure * 0.3;

  // Flash rings get a bright white-amber spike
  col += mix(amber, vec3(1.0, 0.9, 0.7), 0.5) * flash * structure * 0.5;

  // ── Subtle ambient glow from the tunnel void ──
  float ambientGlow = exp(-r * 5.0) * (1.0 - smoothstep(0.0, 0.08, r));
  col += darkPurple * ambientGlow * 0.08;

  // ── Very faint atmospheric haze deeper in tunnel ──
  float haze = exp(-r * 6.0) * 0.02;
  col += mix(darkPurple, crimson * 0.5, 0.3) * haze;

  // ── Vignette ──
  float vig = 1.0 - smoothstep(0.3, 1.1, r);
  col *= 0.55 + 0.45 * vig;

  // ── Film grain ──
  float grain = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + fract(u_time * 0.1) * 100.0) * 43758.5453) - 0.5) * 0.02;
  col += grain;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
