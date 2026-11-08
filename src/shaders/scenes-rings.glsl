// MIST TRIO — adapted from the author's TouchDesigner pixel shader.
// Background only: fog with a faint vermilion tint. The fixed foreground lives in
// foreground-rings.glsl and is added once by the final display pass.
// Lines marked "original" keep that shader's expressions and constants.
// Lines marked "reconstructed" fill parts whose source text was not recovered
// (noise, fbm time terms and colour ramp positions).

// reconstructed: value noise and the six-octave fbm whose weights, in source
// order, were .5 / .03125 / .25 / .125 / .0625 / .015625.
float ringsRand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
float ringsNoise(vec2 p){
  vec2 ip=floor(p),u=fract(p);u=u*u*(3.0-2.0*u);
  float res=mix(mix(ringsRand(ip),ringsRand(ip+vec2(1.0,0.0)),u.x),
                mix(ringsRand(ip+vec2(0.0,1.0)),ringsRand(ip+vec2(1.0,1.0)),u.x),u.y);
  return res*res;
}
const mat2 RINGS_MTX=mat2(.80,.60,-.60,.80);
// reconstructed: how fast the large pattern drifts. The mist layers below
// keep their recovered rates.
const float RINGS_FOG_RATE=.30;
float ringsFbm(vec2 p){
  float time=u_time*RINGS_FOG_RATE,f=0.0;
  f+=.500000*ringsNoise(p+time);p=RINGS_MTX*p*2.02;
  f+=.031250*ringsNoise(p);p=RINGS_MTX*p*2.01;
  f+=.250000*ringsNoise(p);p=RINGS_MTX*p*2.03;
  f+=.125000*ringsNoise(p);p=RINGS_MTX*p*2.01;
  f+=.062500*ringsNoise(p);p=RINGS_MTX*p*2.04;
  f+=.015625*ringsNoise(p+sin(time));
  return f/.96875;
}
float ringsPattern(vec2 p){return ringsFbm(p+ringsFbm(p+ringsFbm(p)));}
float ringsMist(vec2 p){
  // original
  vec2 mistFlow=vec2(u_time*.08,u_time*.04);
  float mist=ringsFbm(p*.5+mistFlow);
  mist+=ringsFbm(p*.3-mistFlow*.5)*.5;
  return mist*.3;
}
// The original palette, written relative to the scene colours so that the
// default preset reproduces it exactly and other palettes stay coherent:
// u_color0 = (.20,.70,.45), u_color1 = (.95,.22,.08), u_color2 = (.98,.99,1).
vec3 ringsRamp(float t){
  vec3 c1=u_color0*vec3(.15,.10,.0889),c2=u_color0*vec3(.50,.40,.3556);
  vec3 c4=u_color0+(u_color2-u_color0)*vec3(.705,.966,.745);
  t=clamp(t,0.0,1.0)*4.0; // reconstructed: evenly spaced stops
  if(t<1.0)return mix(vec3(0.0),c1,t);
  if(t<2.0)return mix(c1,c2,t-1.0);
  if(t<3.0)return mix(c2,u_color0,t-2.0);
  return mix(u_color0,c4,t-3.0);
}
vec3 ringsScene(){
  float iTime=u_time;
  // original: fog lives in unit uv.
  vec2 uv=v_uv,scaledUV=uv*3.0;
  float mainPattern=pow(ringsPattern(scaledUV),1.3);
  float mist=ringsMist(scaledUV*2.0);
  vec3 fogColor=ringsRamp(mainPattern);
  fogColor+=(u_color0+(u_color2-u_color0)*vec3(.449,.862,.545))*mist*.70;
  float whiteMist=pow(clamp(mist,0.0,1.0),.65);
  fogColor+=u_color2*whiteMist*.25;
  float vermInFog=pow(clamp(mist,0.0,1.0),1.2)*.06+pow(clamp(mainPattern,0.0,1.0),2.2)*.03;
  vermInFog*=.85+.15*ringsNoise(scaledUV*1.2+iTime*.2);
  fogColor+=u_color1*vermInFog;

  if(u_part_colors){
    // Keep the fog's existing fields and four ramp intervals, but derive its
    // coverage without any of the three pigments.
    float rampPosition=clamp(mainPattern,0.0,1.0)*4.0;
    float fogDensity=rampPosition<1.0?mix(0.0,.10,rampPosition):
      (rampPosition<2.0?mix(.10,.40,rampPosition-1.0):
      (rampPosition<3.0?mix(.40,1.0,rampPosition-2.0):1.0));
    fogDensity=clamp(fogDensity+mist*.70+whiteMist*.25,0.0,.95);
    if(u_look==2)fogDensity*=.55;
    vec3 base=u_custom_background?u_background:(u_look==2?artPaper():vec3(0.0));
    vec3 c=mix(base,u_color0,fogDensity);
    // The former ring pigment now belongs only to the existing white mist.
    c=mix(c,u_color2,whiteMist*.25);
    c=mix(c,u_color1,clamp(vermInFog,0.0,.9));
    return c;
  }
  if(u_look==2){
    // Light look: the same structure as ink on paper instead of added light.
    vec3 c=mix(u_custom_background?u_background:artPaper(),u_color0*.55,clamp(dot(fogColor,vec3(.3333))*1.1,0.0,.55));
    c=mix(c,u_color1,clamp(vermInFog,0.0,.9));
    return c;
  }
  if(u_custom_background)return u_background+fogColor;
  return fogColor;
}
