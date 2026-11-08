#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_motion;
uniform vec4 u_audio;
uniform float u_spectrum[12];
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform bool u_part_colors;
uniform int u_pattern;
uniform int u_look;
uniform float u_warp;
out vec3 v_color;
out float v_alpha;
out float v_side;
const float TAU=6.28318530718;
mat2 lineTurn(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float lineHash(float n){return fract(sin(n*127.1+311.7)*43758.5453);}
struct LineSample {vec3 position;float ink;float weight;};

// @SPATIAL@

vec3 networkAnchor(float index){
  float flow=u_motion.y;
  const vec2 anchors[8]=vec2[8](vec2(-2.4,-1.2),vec2(-2.8,1.5),
    vec2(.15,1.1),vec2(1.45,.15),vec2(2.9,-.85),vec2(-.65,-.5),
    vec2(4.8,1.8),vec2(-4.8,.2));
  vec2 q=anchors[int(index)];
  q+=vec2(sin(flow*.21+index*2.3),cos(flow*.17+index*1.7))*.20;
  q*=1.0+.035*u_spectrum[int(mod(index,4.0))];
  return vec3(q,.25*sin(index*2.4+flow*.16));
}
LineSample networkSample(float segment,float endpoint){
  float curve=floor(segment/64.0),u=(mod(segment,64.0)+endpoint)/64.0;
  float idA=floor(curve/64.0),idB=mod(idA+1.0+floor(lineHash(curve+70.0)*7.0),8.0);
  float seed=lineHash(curve*2.7),flow=u_motion.y;
  float family=mod(curve,3.0);
  float tone=family<.5?u_spectrum[4]:(family<1.5?
    .5*(u_spectrum[5]+u_spectrum[6]):u_spectrum[7]);
  float direction=family<.5?1.0:(family<1.5?-1.0:1.0);
  vec3 a=networkAnchor(idA),b=networkAnchor(idB);
  vec2 chord=b.xy-a.xy;
  vec2 normal=normalize(vec2(-chord.y,chord.x));
  float handed=seed>.5?1.0:-1.0;
  float radius=.13+lineHash(curve+3.4)*.30;
  float spin=seed*TAU+direction*flow*(.10+family*.025);
  a.xy+=vec2(cos(spin),sin(spin))*radius;
  b.xy+=vec2(cos(spin+1.8),sin(spin+1.8))*radius;
  vec3 c=a+(b-a)*.25,d=a+(b-a)*.75;
  float bend=(.3+lineHash(curve+19.0)*1.6)*handed*(.65+u_warp*.48);
  // Three families share their anchors but disagree about curvature and phase.
  // Endpoint positions remain stable while the paths between them open and close.
  float response=tone*.48*sin(flow*.23*direction+seed*TAU);
  c.xy+=normal*(bend+response);
  d.xy-=normal*(bend*.72-response*.65);
  float v=1.0-u;
  vec3 p=v*v*v*a+3.0*v*v*u*c+3.0*v*u*u*d+u*u*u*b;
  float envelope=sin(u*3.14159265);
  p.xy+=normal*envelope*((.16+tone*.16)*sin(u*TAU*(2.0+family*.5)
    +direction*flow*.32+seed*9.0)+.045*sin(u*TAU*5.0-flow*.24+seed*16.0));
  p.z+=envelope*(.38+tone*.16)*sin(u*TAU+seed*9.0+direction*flow*.18);
  p.xy*=1.0+u_audio.y*.07;
  float knot=1.0-smoothstep(.04,.20,min(u,1.0-u));
  float signal=pow(.5+.5*cos(u*TAU-flow*.48+seed*TAU),12.0);
  return LineSample(p,knot*.85+signal*.15,.28+seed*.22+knot*.12);
}
LineSample lineSample(float segment,float endpoint){
  if(u_pattern==13)return networkSample(segment,endpoint);
  return spatialSample(segment,endpoint,u_pattern);
}
vec2 lineProject(vec3 p){
  float perspective=4.8/max(5.2-p.z,1.0);
  return p.xy*perspective*.72/vec2(u_resolution.x/u_resolution.y,1.0);
}
void main(){
  float segment=float(gl_VertexID/6);
  int corner=gl_VertexID%6;
  float endpoint=(corner==2||corner==4||corner==5)?1.0:0.0;
  float side=(corner==0||corner==3||corner==5)?-1.0:1.0;
  LineSample a=lineSample(segment,0.0),b=lineSample(segment,1.0);
  LineSample samplePoint=a;
  if(endpoint>.5)samplePoint=b;
  vec2 start=lineProject(a.position),finish=lineProject(b.position);
  vec2 direction=(finish-start)*u_resolution;
  float lengthSquared=dot(direction,direction);
  vec2 normal=vec2(-direction.y,direction.x)*inversesqrt(max(lengthSquared,.00001));
  float width=u_pattern==13?1.0:1.05;
  // Screen-space triangle ribbons retain a pixel footprint even where native
  // WebGL lines would be restricted to one device pixel.
  float halfWidth=max(.9,width*u_resolution.y/900.0);
  vec2 screen=mix(start,finish,endpoint)+normal*side*halfWidth*2.0/u_resolution;
  gl_Position=vec4(screen,0,1);
  v_side=side;
  float ink=clamp(samplePoint.ink,0.0,1.0);
  vec3 pigment=mix(u_color0,u_color1,smoothstep(.12,.90,ink));
  // The grid's two sheets are its wall and floor; give each a direct colour.
  if(u_part_colors&&u_pattern==3) pigment=segment<16384.0?u_color0:u_color1;
  float treble=u_spectrum[8+int(mod(floor(segment/64.0),4.0))];
  float signal=pow(.5+.5*sin(u_motion.z*.8+segment*.0067),22.0)
    *(u_audio.w*.25+treble*.75);
  pigment=mix(pigment,u_color2,signal*.55);
  if(!u_part_colors&&u_look==1) pigment=mix(pigment,vec3(.94,.98,1),u_pattern==13?.06:.36);
  if(u_look==2&&u_pattern!=13)pigment*=.56;
  float depth=clamp(.75+samplePoint.position.z*.12,.40,1.0);
  v_color=pigment;
  float visibility=u_pattern==3?1.65:1.0;
  v_alpha=clamp((samplePoint.weight*depth*(.88+u_audio.x*.12)+signal*samplePoint.weight*.22)*visibility,0.0,.94);
  if(lengthSquared<.00001||a.weight<=0.0||b.weight<=0.0)v_alpha=0.0;
}
