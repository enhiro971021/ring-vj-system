#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_history;
uniform vec2 u_resolution;
uniform float u_dt;
uniform vec4 u_audio;
uniform float u_spectrum[12];
// Background time follows only the background speed and look.
uniform float u_time;
uniform vec4 u_motion;
uniform int u_look;
uniform float u_warp;
uniform float u_trail;
uniform int u_pattern;
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_background;
uniform bool u_part_colors;
uniform bool u_custom_background;
const float PI = 3.14159265;
const float TAU = 6.28318530;

mat2 rotate(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }
float hash(vec2 p) {
  p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y);
}
float noise(vec2 p) {
  vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+1.0),u.x),u.y);
}
float fbm(vec2 p) {
  float v=0.0,a=0.5;
  for(int i=0;i<4;i++){v+=a*noise(p);p=rotate(.53)*p*2.03+7.1;a*=.5;}
  return v;
}
// Pigment-like interpolation keeps authored colours attached to surfaces.
// Avoid the extra hues created by traversing a full HSV spectrum.
vec3 colorBlend(vec3 a,vec3 b,float amount) { return mix(a,b,clamp(amount,0.0,1.0)); }
vec3 palette(float t) {
  float phase=fract(t)*3.0,part=fract(phase);
  float blend=smoothstep(.36,.68,part);
  if(phase<1.0)return mix(u_color0,u_color1,blend);
  if(phase<2.0)return mix(u_color1,u_color2,blend);
  return mix(u_color2,u_color0,blend);
}
vec3 artColor(float t) { return palette(t); }
vec3 artPaper() { return u_part_colors?vec3(.955,.958,.94):mix(vec3(.955,.958,.94),u_color2,.035); }
vec3 artInk() { return u_part_colors?vec3(.022,.026,.032):vec3(.022,.026,.032)+u_color0*.012; }
vec3 artBackground(vec2 p) {
  if(u_custom_background)return u_background;
  if(u_look==2)return artPaper();
  if(u_look==1)return artInk()*.23;
  if(u_part_colors)return artInk();
  return mix(artInk(),u_color0,.045);
}
vec3 artSurface(vec3 base,float diffuse,float specular) {
  float d=clamp(diffuse,0.0,1.0),s=clamp(specular,0.0,1.0);
  if(u_look==0)return base*(.68+.32*d)+artPaper()*s*.025;
  if(u_look==2)return base*(.76+.24*d)+artPaper()*s*.04;
  return base*(.30+.70*d)+mix(base,artPaper(),.65)*s*.20;
}
float stroke(float d,float w) {return 1.0-smoothstep(w,w+max(fwidth(d),.002),abs(d));}
float disc(vec2 p,float r){return 1.0-smoothstep(r,r+max(fwidth(length(p)),.002),length(p));}
float box(vec2 p,vec2 b){vec2 q=abs(p)-b;return length(max(q,0.0))+min(max(q.x,q.y),0.0);}

// @SCENES@

void main() {
  float t=u_motion.x;
  float aspect=u_resolution.x/u_resolution.y;
  vec2 p=(v_uv-.5)*vec2(aspect,1.0)*2.0;
  vec3 hdr;
  if(u_pattern==0 || u_pattern==10 || u_pattern==11)hdr=atmosphereScene(p,t,u_pattern);
  else if(u_pattern==3 || u_pattern==13){
    // Geometry is rendered into the same fresh source after this background.
    bool lightNetwork=u_pattern==13&&u_look!=1;
    hdr=(lightNetwork||u_look==2)?vec3(.964,.975,.969):vec3(.006,.012,.019);
    if(u_custom_background)hdr=u_background;
  }
  else if(u_pattern==14)hdr=cellularScene(p,t);
  else if(u_pattern==15)hdr=ringsScene();
  else if(u_pattern==16)hdr=currentScene(p);
  else if(u_pattern==18)hdr=dotWaveScene(p);
  else if(u_pattern==19)hdr=origamiScene(p);
  else if(u_pattern==20)hdr=ridgesScene(p);
  else if(u_pattern==21)hdr=prismaticScene(p);
  else if(u_pattern==22)hdr=inkScene(p);
  else hdr=artBackground(p);
  // Preserve saturated midtones; compress only bright highlights, in hue-preserving ratios.
  hdr=max(hdr,vec3(0));
  float peak=max(hdr.r,max(hdr.g,hdr.b));
  float shoulder=peak<=.8?peak:.8+.2*(1.0-exp(-(peak-.8)*5.0));
  vec3 source=clamp(hdr*(shoulder/max(peak,.00001)),0.0,1.0);
  // The mist background keeps its original light addition and clipping.
  if(u_pattern==15)source=clamp(hdr,0.0,1.0);
  // Sub-pixel static dither prevents broad colour fields from banding.
  source=clamp(source+(hash(gl_FragCoord.xy)-.5)/255.0,0.0,1.0);
  vec2 historyP=(v_uv-.5)*vec2(aspect,1.0);
  historyP=rotate(u_dt*.012)*historyP;
  historyP*=exp(-u_dt*.018);
  vec2 uv=historyP/vec2(aspect,1.0)+.5;
  float inBounds=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  float halfLife=.008+pow(u_trail,3.0)*.65;
  vec3 history=texture(u_history,clamp(uv,0.0,1.0)).rgb;
  // Alpha persistence avoids channel-wise max turning overlapping complementary colours white.
  float persistence=(u_dt<=0.0||u_trail<.001)?0.0:exp2(-u_dt/halfLife)*inBounds;
  outColor=vec4(mix(source,history,persistence),1.0);
}
