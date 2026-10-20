// Putting noise together: warped broad hills + ridged mountains + cellular breakup,
// with a separate warped contour used as an artistic river mask. No erosion or hydrology simulation.
// A top-down relief map keeps the composition legible and the height/mask debug views directly comparable.
// @render time=2.0
#define DEBUG_MODE 0 // 0 shaded biome map | 1 height | 2 normals | 5 river mask
const int OCTAVES = 5;
const float WORLD_SCALE = 5.0;
const float RIVER_WIDTH = 0.10;

vec2 terrainMapFields(vec2 p) {
    float h = hybridTerrainHeight(p, OCTAVES);
    float bend = 0.9 * fbm(vec2(p.y * 0.36, 2.7), 4);
    float riverDistance = abs(p.x - bend);
    float river = 1.0 - smoothstep(RIVER_WIDTH, RIVER_WIDTH + 0.075, riverDistance);
    h = mix(h, 0.19, river);
    return vec2(h, river);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    vec2 p = uv * WORLD_SCALE;
    vec2 field = terrainMapFields(p);
    float e = 2.0 * WORLD_SCALE / iResolution.y;
    vec2 slope = vec2(terrainMapFields(p+vec2(e,0.0)).x-terrainMapFields(p-vec2(e,0.0)).x,
                      terrainMapFields(p+vec2(0.0,e)).x-terrainMapFields(p-vec2(0.0,e)).x) / (2.0*e);
    vec3 n = normalize(vec3(-slope.x,0.7,-slope.y));
    float hills = smoothstep(0.38,0.63,field.x);
    float rock = smoothstep(0.58,0.78,field.x) * smoothstep(0.2,0.75,length(slope));
    vec3 land = mix(srgbToLinear(vec3(0.32,0.42,0.20)),srgbToLinear(vec3(0.61,0.57,0.35)),hills);
    land = mix(land,srgbToLinear(vec3(0.57,0.56,0.50)),rock);
    float diffuse = max(dot(n,normalize(vec3(-0.5,0.9,0.3))),0.0);
    vec3 col = land * (0.3 + 1.2 * diffuse);
    float bank = 1.0 - smoothstep(0.02,0.11,abs(field.y-0.4));
    col = mix(col,srgbToLinear(vec3(0.64,0.58,0.37)),bank*0.65);
    vec3 water = mix(vec3(0.01,0.12,0.15),vec3(0.05,0.31,0.36),0.5+0.5*sin(p.y*7.0+p.x*3.0));
    col = mix(col,water,field.y);
#if DEBUG_MODE == 1
    col = vec3(field.x);
#elif DEBUG_MODE == 2
    col = n*0.5+0.5;
#elif DEBUG_MODE == 5
    col = vec3(field.y);
#else
    col = linearToSrgb(tonemapAgX(col*1.2));
#endif
    fragColor = vec4(col+ditherTPDF(fragCoord,iFrame),1.0);
}
