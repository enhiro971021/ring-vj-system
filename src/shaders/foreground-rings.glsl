// Fixed foreground: the existing Mist Trio audio geometry, in screen space.
// Radius and burst/ray extent use a shared compact scale.
// Contour motion and the five glow widths/weights remain unchanged. Background
// look, pigments, warp, history and camera never enter.
const float RINGS_RADIUS_SCALE=.35/.41;
const vec3 RINGS_WHITE=vec3(.98,.99,1.0);
const vec3 RINGS_COOL=vec3(.92,.95,1.0);
const vec3 RINGS_WARM=vec3(1.0,.96,.94);
const vec3 RINGS_RAY_BLUE_WHITE=RINGS_WHITE*vec3(.714,.788,.880);
float ringsTex(float x){return texture(u_raw,vec2(x,.5)).r;}

vec3 ringsAudio(vec2 center){
  float iTime=u_time;
  float dist=length(center),angle=atan(center.y,center.x);
  float radialDist=dist/RINGS_RADIUS_SCALE;
  // The original summed fixed stretches of its audio row and clamped them.
  // Here the three values are the low / mid / high meters themselves, so what
  // the operator reads on the meters is what moves the hole, the radius and
  // the glow. Soft-compressed, they rarely pin at 1, which leaves the glow
  // narrow enough for three separate lines to stay readable.
  float bass=u_bands.x,mid=u_bands.y,treble=u_bands.z;
  float intensity=(bass+mid+treble)/3.0;
  vec3 audioColor=vec3(0.0);

  // original: the open centre masks the burst; all other glow paths stay as authored.
  float coreRadius=.22+bass*.085;
  float distortion=sin(angle*6.0+iTime*2.0)*.02*bass;
  distortion+=cos(angle*4.0-iTime*1.5)*.015*mid;
  float centerMask=smoothstep(coreRadius*.85,coreRadius*1.35,dist+distortion);

  // reconstructed colour, factor and layer count; original threshold and falloff.
  if(intensity>.6){
    float burstIntensity=(intensity-.6)*2.5;
    for(int i=0;i<3;i++){
      float layerScale=1.0+float(i)*.25;
      float layerIntensity=exp(-radialDist*2.5/layerScale)*burstIntensity;
      audioColor+=RINGS_WHITE*layerIntensity*.08*centerMask;
    }
  }

  // original: one shared radius and one shared drive. The three voices differ
  // only in lobe count (4/5/6), phase travel and tint. The drive was eight
  // point samples of the row; it is now eight contiguous regions (20 Hz to
  // 9 kHz), so no pitch falls between samples. midFreq is the fourth region.
  float freqSum=u_voice.x,midFreq=u_voice.y;
  float ringRadius=.35+mid*.05;
  float glowStrength=max(mid,.3);
  for(int ringNum=0;ringNum<3;ringNum++){
    float rotationOffset=iTime*(ringNum==0?.5:(ringNum==1?-1.2:2.5));
    float distortedAngle=angle+rotationOffset;
    float waveCount=float(4+ringNum);
    float ringDistortion=sin(distortedAngle*waveCount+iTime*.8)*freqSum*8.0;
    ringDistortion+=sin(angle*8.0+rotationOffset*1.5-iTime)*midFreq*6.0;
    ringDistortion+=bass*3.0*sin(angle*2.0+iTime*.5);
    ringDistortion*=.018; // foreground warp is fixed at 1
    float ringDist=abs(dist-(ringRadius+ringDistortion));
    vec3 ringColor=ringNum==0?RINGS_WHITE:(ringNum==1?RINGS_COOL:RINGS_WARM);
    float innerGlow=exp(-ringDist*500.0)*glowStrength;
    float secondGlow=exp(-ringDist*200.0)*glowStrength;
    float midGlow=exp(-ringDist*80.0)*glowStrength;
    float outerGlow=exp(-ringDist*30.0)*glowStrength;
    float ambientRingGlow=exp(-ringDist*12.0)*glowStrength;
    audioColor+=ringColor*innerGlow*1.5;
    audioColor+=ringColor*secondGlow*.3;
    audioColor+=ringColor*midGlow*.2;
    audioColor+=ringColor*outerGlow*.15;
    audioColor+=ringColor*.9*ambientRingGlow*.1;
  }

  // original, kept as written: rayAngle omits the -PI that normalizedAngle
  // adds, so a ray shows only where its distortion approaches PI.
  const float numRays=32.0;
  if(radialDist>.15&&radialDist<.5){
    float normalizedAngle=(angle+3.14159)/(2.0*3.14159);
    float rayIndex=floor(normalizedAngle*numRays);
    float rayAngle=(rayIndex/numRays)*2.0*3.14159;
    float rayFreq=max(ringsTex(rayIndex/numRays)*20.0,.2);
    float rayDistortion=sin(radialDist*10.0-iTime*3.0)*.1*rayFreq;
    float angleDiff=abs(angle-(rayAngle+rayDistortion));
    angleDiff=min(angleDiff,2.0*3.14159-angleDiff);
    vec3 rayColor=mix(RINGS_RAY_BLUE_WHITE,RINGS_WHITE,(radialDist-.15)/.35);
    float rayCoreGlow=exp(-angleDiff*35.0)*exp(-(radialDist-.3)*4.0);
    float rayMidGlow=exp(-angleDiff*20.0)*exp(-(radialDist-.3)*3.0);
    float rayOuterGlow=exp(-angleDiff*10.0)*exp(-(radialDist-.3)*2.0);
    audioColor+=rayColor*rayCoreGlow*rayFreq*.15;
    audioColor+=rayColor*rayMidGlow*rayFreq*.1;
    audioColor+=rayColor*rayOuterGlow*rayFreq*.05;
  }
  return audioColor;
}
