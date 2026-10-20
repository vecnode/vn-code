// Parcel -> mass -> setback -> roof -> facade. Original texture-free city at blue hour.
// 3x3 neighbor checks plus an unvisited-cell distance cap prevent taller remote blocks being skipped.
// Windows are filtered material fields; their emission is illustrative, not global illumination.
// @render time=4.0
// @variant DEBUG_MODE=2
// @variant DEBUG_MODE=3
// @variant DEBUG_MODE=4
// @variant DEBUG_MODE=5
#define DEBUG_MODE 0 // 0 beauty | 2 normals | 3 parcel IDs | 4 steps | 5 window mask
const float PARCEL = 3.6;
const vec3 CITY_SUN = normalize(vec3(-0.6,0.6,0.4));
const int AA = 1; // set 4 for stills

vec4 cityProfile(vec2 id) {
    vec4 b = buildingProfile(id,vec2(2.8,13.0),vec2(0.75,1.13));
    if (length(id)<0.5) b=vec4(18.0,1.15,1.15,2.0);
    return b;
}

vec2 map(vec3 p) {
    vec2 id=domRepeatId(p.xz,vec2(PARCEL));
    vec2 local=p.xz-id*PARCEL;
    vec2 res=vec2(p.y,0.0);
    for(int z=-1;z<=1;z++) for(int x=-1;x<=1;x++) {
        vec2 cell=id+vec2(float(x),float(z));
        vec4 b=cityProfile(cell);
        vec3 q=p-vec3(cell.x*PARCEL,0.0,cell.y*PARCEL);
        float body=sdRoundBox(q-vec3(0.0,b.x*0.38,0.0),vec3(b.y,b.x*0.38,b.z)-0.035,0.035);
        float upper=sdRoundBox(q-vec3(0.0,b.x*0.83,0.0),vec3(b.y*0.72,b.x*0.17,b.z*0.72)-0.025,0.025);
        float podium=sdBox(q-vec3(0.0,0.35,0.0),vec3(b.y+0.15,0.35,b.z+0.15));
        float d=min(podium,min(body,upper));
        if(b.w>0.5) d=min(d,sdBox(q-vec3(0.0,b.x+0.22,0.0),vec3(b.y*0.45,0.22,b.z*0.5)));
        if(b.w>1.5) d=min(d,sdCapsule(q,vec3(0.0,b.x,0.0),vec3(0.0,b.x+1.1,0.0),0.035));
        if(d<res.x)res=vec2(d,1.0);
    }
    float unvisited=min(1.5*PARCEL-abs(local.x),1.5*PARCEL-abs(local.y));
    res.x=min(res.x,unvisited);
    return res;
}

vec3 citySky(vec3 rd) {
    float h=smoothstep(-0.12,0.7,rd.y);
    vec3 c=mix(vec3(0.10,0.12,0.19),vec3(0.012,0.028,0.07),h);
    c+=vec3(0.12,0.055,0.025)*pow(max(dot(rd,CITY_SUN),0.0),12.0);
    return c;
}

vec3 renderCity(vec2 coord) {
    vec2 uv=(2.0*coord-iResolution.xy)/iResolution.y;
    float orbit=0.5+0.035*iTime;
    vec3 ro=vec3(32.0*sin(orbit),17.0,32.0*cos(orbit));
    vec3 rd=cameraRay(cameraMatrix(ro,vec3(0.0,6.0,0.0),0.0),uv,1.85);
    vec3 sky=citySky(rd);
    vec3 hit=raymarch(ro,rd,0.05,110.0,0.95);
#if DEBUG_MODE == 4
    return debugHeat(hit.z/256.0);
#endif
    if(hit.x<0.0)return sky;
    vec3 p=ro+rd*hit.x;
    vec3 n=calcNormal(p,max(0.001,hit.x*0.00015));
    vec2 id=domRepeatId(p.xz,vec2(PARCEL));
    vec4 b=cityProfile(id);
    float variation=hash12(id);
    float fp=2.0*hit.x/(iResolution.y*1.85);
    fp/=max(abs(dot(n,rd)),0.15);
    vec3 albedo=mix(vec3(0.16,0.19,0.21),vec3(0.32,0.29,0.25),variation);
    float windows=0.0;
    vec3 emission=vec3(0.0);
    if(hit.y>0.5 && n.y<0.6) {
        vec2 facade=vec2(abs(n.x)>abs(n.z)?p.z:p.x,p.y);
        vec2 grid=facade/vec2(0.30,0.43);
        windows=facadeWindowMask(grid,vec2(0.62,0.65),vec2(fp*3.8,fp*2.5));
        float occupied=step(0.42,hash13(vec3(floor(grid+0.5),variation*100.0)));
        float keep=1.0-smoothstep(0.3,1.2,fp/0.30);
        occupied=mix(0.58,occupied,keep);
        vec3 glass=vec3(0.018,0.035,0.055)+citySky(reflect(rd,n))*0.3;
        albedo=mix(albedo,glass,windows);
        emission=windows*occupied*mix(vec3(0.6,0.22,0.055),vec3(1.2,0.74,0.33),variation)*0.8;
    } else if(hit.y<0.5) {
        albedo=vec3(0.045,0.05,0.06);
        vec2 streets=abs(domRepeat(p.xz,vec2(PARCEL)));
        float marking=(1.0-smoothstep(0.025,0.025+fp,abs(streets.x-PARCEL*0.5)))
                     *filteredStripes(p.z*1.3,fp*1.3);
        albedo=mix(albedo,vec3(0.42,0.32,0.13),marking);
    }
    float ao=calcAO(p,n,0.18);
    float shadow=softShadow(p+n*0.015,CITY_SUN,0.02,20.0,10.0);
    vec3 col=shadePBR(n,-rd,CITY_SUN,albedo,0.4,0.15)*vec3(0.9,0.75,0.6)*shadow;
    col+=albedo*hemisphereLight(n,vec3(0.30,0.43,0.66),vec3(0.07,0.065,0.055))*ao;
    col+=emission;
#if DEBUG_MODE == 2
    return n*0.5+0.5;
#elif DEBUG_MODE == 3
    return hash33(vec3(id,0.0));
#elif DEBUG_MODE == 5
    return vec3(windows);
#endif
    float haze=heightFog(ro,rd,hit.x,0.006,0.055);
    return mix(col,citySky(normalize(vec3(rd.x,0.06,rd.z))),haze);
}

void mainImage(out vec4 fragColor,in vec2 fragCoord) {
    vec3 col=vec3(0.0);
    for(int i=0;i<AA;i++) {
        vec3 sampleColor=renderCity(fragCoord+(AA>1?aaOffset(i):vec2(0.0)));
#if DEBUG_MODE == 0
        sampleColor=tonemapAgX(sampleColor*1.05);
#endif
        col+=sampleColor/float(AA);
    }
#if DEBUG_MODE == 0
    col=linearToSrgb(col)+ditherTPDF(fragCoord,iFrame);
#endif
    fragColor=vec4(col,1.0);
}
