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
uniform float u_opacity;
out vec3 v_color;
out float v_alpha;
const float TAU=6.28318530718;
mat2 turn(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float rnd(float n){return fract(sin(n*127.1+311.7)*43758.5453);}
void main(){
  float column=float(gl_VertexID%384),row=float(gl_VertexID/384);
  float u=column/384.0,v=row/255.0;
  float drive=u_motion.x,flow=u_motion.y,detail=u_motion.z;
  float bass=u_audio.y,high=u_audio.w;
  float treble=u_spectrum[8+int(mod(floor(row/8.0),4.0))];
  float phase=.5+.5*sin(flow*.85);
  float opening=smoothstep(.18,.82,phase);
  vec3 position;float hue=0.0,edge=1.0,shade=1.0,accent=0.0;
  if(u_pattern==0){
    // A continuously advected sheet: every point follows the same folded surface.
    float x=mix(-4.2,4.2,fract(u+drive*.019));
    float across=(v-.5)*2.0;
    // Three coherent gestures: a long fold, a counter-current, and a twist.
    // Equal overall mid energy with different partials yields a different surface.
    float bend=(.65+.22*u_spectrum[4]+.07*u_spectrum[0])*sin(x*.81-flow*.66)
      +(.23+.18*u_spectrum[5]+.05*u_spectrum[1])*sin(x*1.8+flow*.24);
    vec2 section=vec2(across*(.75+opening*.38),
      (.52+.12*u_spectrum[6]+.05*u_spectrum[2])*sin(across*2.4+x*.92-flow*.26));
    float torsion=.80*sin(x*.67-flow*.36)+.18+(.8-opening)*.65
      +(.30*u_spectrum[7]+.07*u_spectrum[3])*sin(x*1.37+flow*.21);
    section=turn(torsion)*section;
    position=vec3(x,section.x+bend,section.y+.25*cos(x*.75+flow*.14));
    position.yz*=1.0+bass*.13;
    position.xy=turn(-.16)*position.xy;
    hue=smoothstep(.34,.72,v);
    shade=.40+.60*pow(.5+.5*cos(across*2.4+x*.92-flow*.26),.6);
    edge=smoothstep(0.0,.055,v)*(1.0-smoothstep(.945,1.0,v));
    accent=pow(.5+.5*cos(x*1.2-detail*.85+across*1.1),18.0);
  }else if(u_pattern==10){
    // Four delayed layers read as broad ribbons, with quiet gaps between them.
    float sheet=floor(row/64.0),height=mod(row,64.0)/63.0;
    float x=mix(-3.9,3.9,u);
    float direction=mod(sheet,2.0)<.5?1.0:-1.0;
    float tone=u_spectrum[4+int(sheet)];
    float answer=u_spectrum[4+int(mod(sheet+1.0,4.0))];
    float delayed=direction*flow*(.32+sheet*.045)-sheet*.62;
    // Each curtain owns a different mid-frequency slice and a returning wave.
    float crest=(.55+.18*tone)*sin(x*.91-delayed)
      +(.26+.13*answer)*sin(x*1.83+delayed*.5+sheet*.25);
    float gate=smoothstep(.14,.86,.5+.5*sin(delayed));
    float y=(height-.5)*(.60+gate*.38);
    position=vec3(x,y+crest+(sheet-1.5)*.40,
      (sheet-1.5)*.34+(.30+.14*tone)*sin(x*1.2+y*.75-delayed));
    position.y+=sheet*.02;
    position.y*=1.0+(.45*bass+.55*u_spectrum[int(sheet)])*.10;
    position.xy=turn(.11)*position.xy;
    hue=sheet/3.0;
    edge=sin(height*3.14159)*.6+.4;
    shade=.64+.36*(1.0-sheet/5.0);
    accent=pow(.5+.5*cos(x*1.5-detail*.66+sheet*.5),20.0);
  }else{
    // Eight open braids continue beyond the viewport; no common origin or knot.
    float bundle=floor(row/32.0),strand=mod(row,32.0)/31.0;
    float braid=mod(bundle,3.0);
    float tone=braid<.5?u_spectrum[4]:(braid<1.5?
      .5*(u_spectrum[5]+u_spectrum[6]):u_spectrum[7]);
    float pressure=braid<.5?.5*(u_spectrum[0]+u_spectrum[1]):
      (braid<1.5?u_spectrum[2]:u_spectrum[3]);
    float direction=mod(bundle,2.0)<.5?1.0:-1.0;
    float x=mix(-4.3,4.3,fract(u+drive*.012*direction));
    float phaseShift=bundle*.83;
    float wave=x*.86-direction*flow*.22+phaseShift;
    float weave=sin(x*1.65-direction*flow*.29+phaseShift);
    float width=(.24+.06*sin(x*.6+flow*.12+phaseShift))
      *(1.0+(.45*bass+.55*pressure)*.34);
    float twist=(strand-.5)*TAU+x*.45+direction*flow*.13
      +tone*.38*weave;
    // Low bands breathe across each bundle; mids bend and braid three families.
    float offset=(strand-.5)*width*2.0
      +sin(twist)*(.025+.045*tone);
    float bend=(.12+.10*tone)*sin(wave)+.055*tone*weave;
    position=vec3(x,(bundle-3.5)*.66+x*.26+bend+offset,
      .12*sin(wave*.7)+.065*cos(twist));
    hue=.18+.62*(.5+.5*sin(phaseShift+x*.16));
    shade=.72+.28*(.5+.5*cos(twist));
    edge=.80+.20*sin(strand*3.14159);
    accent=pow(.5+.5*cos(x*1.5-detail*.62+phaseShift),22.0);
  }
  // Small coherent displacement supplies warp without scattering the field.
  position.z+=sin(position.x*.74+position.y*.51-flow*.12)*u_warp*.12;
  float perspective=4.4/(5.1-position.z);
  float aspect=u_resolution.x/u_resolution.y;
  vec2 projected=position.xy*perspective*.73;
  gl_Position=vec4(projected.x/aspect,projected.y,clamp(-position.z*.15,-.95,.95),1.0);
  float front=clamp(.55+position.z*.20,.15,1.0);
  float size=u_pattern==11?(u_look==0?4.2:4.0):(u_look==0?3.0:u_look==1?2.8:2.5);
  gl_PointSize=clamp(size*u_resolution.y/900.0*perspective*(.8+front*.4),2.1,5.5);
  vec3 pigment=mix(u_color0,u_color1,hue);
  // An occasional third-colour travelling seam, not a full-spectrum gradient.
  pigment=mix(pigment,u_color2,accent*(.26+high*.14+treble*.42));
  vec3 paper=vec3(.96,.97,.95);
  if(u_part_colors){
    // Part colours keep their hue; material shading changes brightness only.
    if(u_look==1)v_color=pigment*(.6+shade*.4);
    else if(u_look==2)v_color=pigment*(.38+shade*.42);
    else v_color=pigment*(.82+shade*.18);
  }
  else if(u_look==1)v_color=mix(pigment,paper,.48+front*.25)*(.6+shade*.4);
  else if(u_look==2)v_color=pigment*(.38+shade*.42);
  else v_color=mix(pigment,paper,.25+shade*.18);
  float sparkle=.86+.14*pow(.5+.5*sin(detail*.7+row*.19+column*.013),4.0)*(high*.3+treble*.7);
  v_alpha=u_opacity*edge*(.72+.28*shade)*sparkle*(.92+.08*u_audio.x);
  // Light look uses fewer complete strands, preserving legibility on white.
  if(u_look==2 && mod(row,3.0)>.5)v_alpha=0.0;
  // At thumbnail sizes, keep evenly spaced entire strands instead of aliasing all rows.
  if(u_resolution.y<500.0 && (mod(row,2.0)>.5||mod(column,2.0)>.5))v_alpha=0.0;
}
