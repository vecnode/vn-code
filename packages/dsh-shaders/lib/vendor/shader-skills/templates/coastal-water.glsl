// Coastal water: analytic finite-depth waves, refracted seabed, reflected land, exact interface Fresnel,
// RGB Beer-Lambert attenuation, scattered-light approximation, shore/crest foam, GGX glints and filtered ripples.
// Single-pass visual study, not fluid simulation: caustics are artistic; reflected waves/multiple scattering are omitted.
// @render time=5.0
// @variant QUALITY=1
// @variant QUALITY=3
// @variant DEBUG_MODE=1
// @variant DEBUG_MODE=2
// @variant DEBUG_MODE=3
// @variant DEBUG_MODE=4
// @variant DEBUG_MODE=5
// @variant DEBUG_MODE=6
#define QUALITY 2 // 1 interactive: sky reflection | 2 high: land reflection | 3 still: 4x AA, more waves/steps
#define DEBUG_MODE 0 // 0 beauty | 1 optical path | 2 normals | 3 foam | 4 primary steps | 5 Fresnel | 6 transmission
const int WATER_AA=QUALITY==3?4:1;
const int WATER_WAVES=QUALITY==3?12:8;
const int WATER_STEPS=QUALITY==3?240:180;
const vec3 COAST_SUN=normalize(vec3(-0.35,0.62,-0.55));
const vec3 EXTINCTION=vec3(0.42,0.085,0.045); // illustrative clear turquoise water, 1/m
const float WATER_IOR=1.333;
const float WATER_FAR=95.0;

float coastBed(vec2 p) {
    vec2 a=p-vec2(-7.0,-8.0),b=p-vec2(7.0,-19.0),c=p-vec2(-5.0,-1.0);
    float islands=5.7*exp(-0.055*dot(a,a))+5.0*exp(-0.07*dot(b,b))+1.1*exp(-0.15*dot(c,c));
    return -2.4+islands*(1.0+0.18*gradientNoise(p*0.75))+0.12*sin(p.x*1.7)*sin(p.y*1.2);
}

vec3 coastBedNormal(vec2 p,float eps) {
    vec2 d=vec2(coastBed(p+vec2(eps,0.0))-coastBed(p-vec2(eps,0.0)),
                coastBed(p+vec2(0.0,eps))-coastBed(p-vec2(0.0,eps)))/(2.0*eps);
    return normalize(vec3(-d.x,1.0,-d.y));
}

vec4 coastWaves(vec2 p,float footprint) {
    vec4 sum=vec4(0.0);
    for(int i=0;i<WATER_WAVES;i++) {
        float fi=float(i);
        float angle=0.7+fi*2.39996;
        float wavelength=4.5*pow(0.69,fi);
        float amp=0.075*pow(0.58,fi);
        // Fixed reference depth in phase avoids spatially varying frequency drifting out of phase along the shore.
        sum+=waterWaveD(p+vec2(fi*1.37,fi*0.79),iTime,vec2(cos(angle),sin(angle)),wavelength,amp,3.0,footprint);
    }
    return sum;
}

vec2 traceCoast(vec3 ro,vec3 rd,bool includeWater,int maxSteps) {
    float t=0.01,previous=0.0;
    float closing=max(0.05,abs(rd.y)+4.0*length(rd.xz));
    for(int i=0;i<WATER_STEPS;i++) {
        if(i>=maxSteps)break;
        vec3 p=ro+rd*t;
        float h=coastBed(p.xz);
        if(includeWater) {
            float geometryFootprint=2.0*t/(iResolution.y*1.75*max(abs(rd.y),0.1));
            h=max(h,coastWaves(p.xz,geometryFootprint).x);
        }
        float gap=p.y-h;
        if(gap<0.0) {
            float lo=previous,hi=t;
            for(int j=0;j<10;j++) {
                float mid=0.5*(lo+hi);
                vec3 q=ro+rd*mid;
                float surface=coastBed(q.xz);
                if(includeWater) {
                    float fp=2.0*mid/(iResolution.y*1.75*max(abs(rd.y),0.1));
                    surface=max(surface,coastWaves(q.xz,fp).x);
                }
                if(q.y>surface)lo=mid;else hi=mid;
            }
            return vec2(0.5*(lo+hi),float(i));
        }
        previous=t;
        t+=max(gap/closing,0.012+0.008*t);
        if(t>WATER_FAR)break;
    }
    if(includeWater && rd.y < -0.0001) return vec2(max(0.01,-ro.y/rd.y),float(maxSteps));
    return vec2(-1.0,float(maxSteps));
}

vec3 coastSky(vec3 rd) {
    vec3 c=mix(vec3(0.22,0.40,0.60),vec3(0.025,0.13,0.36),sqrt(max(rd.y,0.0)));
    float clouds=smoothstep(0.1,0.55,fbm(rd.xz/max(rd.y+0.4,0.15)*1.3,4));
    c=mix(c,vec3(0.95,0.97,1.0),clouds*0.18*smoothstep(0.03,0.3,rd.y));
    return c+vec3(9.0,8.0,6.0)*sunDisk(rd,COAST_SUN,0.012,0.002);
}

vec3 shadeCoastBed(vec3 p,vec3 n,bool submerged,float footprint) {
    float grain=0.5+0.5*fbm(p.xz*2.5,4)*(1.0-smoothstep(0.03,0.25,footprint));
    float rock=smoothstep(0.45,1.0,p.y)*(1.0-smoothstep(0.65,0.9,n.y));
    vec3 sand=mix(vec3(0.38,0.29,0.15),vec3(0.7,0.59,0.37),grain);
    vec3 albedo=mix(sand,vec3(0.17,0.15,0.12),rock);
    float vegetation=smoothstep(1.2,2.0,p.y)*smoothstep(0.5,0.82,n.y);
    albedo=mix(albedo,vec3(0.07,0.12,0.025),vegetation);
    vec3 direct=vec3(2.5,2.3,1.9)*max(dot(n,COAST_SUN),0.0);
    if(submerged) {
        direct*=beerTransmittance(EXTINCTION,max(-p.y,0.0)/COAST_SUN.y);
        float caustic=pow(max(0.0,sin(p.x*7.0+sin(p.z*4.0+iTime)*1.3)*sin(p.z*6.0+cos(p.x*4.0-iTime)*1.2)),9.0);
        float keep=1.0-smoothstep(0.02,0.12,footprint);
        direct*=1.0+caustic*keep*1.2; // projected artistic caustic pattern, not photon transport
    }
    return albedo*(direct+hemisphereLight(n,vec3(0.35,0.43,0.5),vec3(0.12,0.10,0.07)));
}

vec3 renderCoast(vec2 coord) {
    vec2 uv=(2.0*coord-iResolution.xy)/iResolution.y;
    vec3 ro=vec3(0.0,3.5,7.5);
    vec3 rd=cameraRay(cameraMatrix(ro,vec3(-0.8,-0.1,-6.0),0.0),uv,1.75);
    vec3 sky=coastSky(rd);
    vec2 hit=traceCoast(ro,rd,true,WATER_STEPS);
#if DEBUG_MODE == 4
    return debugHeat(hit.y/float(WATER_STEPS));
#endif
    if(hit.x<0.0)return sky;
    vec3 p=ro+rd*hit.x;
    float footprint=2.0*hit.x/(iResolution.y*1.75);
    float bed=coastBed(p.xz);
    vec3 col;
    if(bed>p.y-0.015) {
        vec3 n=coastBedNormal(p.xz,max(footprint,0.003));
        col=shadeCoastBed(p,n,false,footprint);
    } else {
        vec4 waves=coastWaves(p.xz,footprint/max(abs(rd.y),0.1));
        vec3 n=normalize(vec3(-waves.y,1.0,-waves.z));
        vec3 v=-rd;
        float F=fresnelDielectric(max(dot(n,v),0.0),1.0,WATER_IOR);
        vec3 refracted=refract(rd,n,1.0/WATER_IOR);
        vec2 bottomHit=traceCoast(p-n*0.006,refracted,false,WATER_STEPS);
        float path=bottomHit.x>0.0?bottomHit.x:30.0;
        vec3 bottomPoint=p-n*0.006+refracted*path;
        vec3 bottomColor=shadeCoastBed(bottomPoint,coastBedNormal(bottomPoint.xz,0.01),true,footprint);
        vec3 T=beerTransmittance(EXTINCTION,path);
        vec3 body=bottomColor*T+vec3(0.012,0.19,0.24)*(1.0-T); // approximate in-scattered body light
        vec3 reflected=reflect(rd,n);
        vec3 reflection=coastSky(normalize(vec3(reflected.x,max(reflected.y,0.01),reflected.z)));
#if QUALITY >= 2
        vec2 reflectedHit=traceCoast(p+n*0.015,reflected,false,WATER_STEPS);
        if(reflectedHit.x>0.0) {
            vec3 rp=p+n*0.015+reflected*reflectedHit.x;
            if(rp.y>0.02)reflection=shadeCoastBed(rp,coastBedNormal(rp.xz,0.015),false,footprint);
        }
#endif
        float unresolved=smoothstep(0.02,0.18,footprint);
        float rough=mix(0.075,0.20,unresolved);
        vec3 glint=specularGGX(n,v,COAST_SUN,rough,vec3(0.02037))*vec3(3.5,3.2,2.7);
        float shallow=1.0-smoothstep(0.08,0.5,max(p.y-bed,0.0));
        float shorePulse=0.5+0.5*sin((p.y-bed)*19.0-iTime*1.5+fbm(p.xz*2.0,3)*3.0);
        float foam=shallow*smoothstep(0.25,0.7,shorePulse)*0.8;
        foam+=0.12*smoothstep(0.18,0.6,-waves.w)*(1.0-unresolved);
        foam=clamp(foam,0.0,1.0);
        col=mix(body*(1.0-F)+reflection*F+glint,vec3(0.8,0.84,0.82),foam);
#if DEBUG_MODE == 1
        return vec3(path/12.0);
#elif DEBUG_MODE == 2
        return n*0.5+0.5;
#elif DEBUG_MODE == 3
        return vec3(foam);
#elif DEBUG_MODE == 5
        return vec3(F);
#elif DEBUG_MODE == 6
        return T;
#endif
    }
    return mix(col,coastSky(normalize(vec3(rd.x,0.025,rd.z))),1.0-exp(-hit.x*0.003));
}

void mainImage(out vec4 fragColor,in vec2 fragCoord) {
    vec3 col=vec3(0.0);
    for(int i=0;i<WATER_AA;i++) {
        vec3 c=renderCoast(fragCoord+(WATER_AA>1?aaOffset(i):vec2(0.0)));
#if DEBUG_MODE == 0
        c=tonemapAgX(c*1.05);
#endif
        col+=c/float(WATER_AA);
    }
#if DEBUG_MODE == 0
    col=linearToSrgb(col)+ditherTPDF(fragCoord,iFrame);
#endif
    fragColor=vec4(col,1.0);
}
