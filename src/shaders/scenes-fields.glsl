// FIELD BACKGROUNDS — four full-screen patterns with no object and no centre.
// Every pixel belongs to the same moving fabric, so the white rings in front
// are the only subject. All are flat or softly shaded, read the same
// uniforms as the other backgrounds, and keep their peak well below the rings.
// Colour roles: u_color0 the field, u_color1 the counter-tone, u_color2 the
// highlight. Nothing travels around a hue wheel.

// The dark ground carries a trace of the field colour, so a palette never
// sits on pure black and the whole frame keeps one tone.
vec3 fieldBase(){
  if(u_custom_background)return u_background;
  vec3 ink=mix(artInk(),u_color0*.22,.55);
  return u_look==1?ink*.6:ink;
}

// 潮流 — broad diagonal bands of current, bent by a slow warp. Four strata
// across the screen each carry one mid partial as fine bright threads, so the
// same loudness with a different timbre lights a different part of the flow.
vec3 currentScene(vec2 p){
  float flow=u_motion.y;
  float low=u_audio.y,mid=u_audio.z,high=u_audio.w;
  vec2 q=rotate(-.62)*p;
  q.x+=flow*.16;
  q.y+=u_time*.012;
  vec2 w=vec2(fbm(q*1.1+vec2(0.0,u_time*.045)),fbm(q*1.1+vec2(3.7,-u_time*.038)))-.5;
  float bend=.30+u_warp*.30+mid*.22;
  vec2 r=q+w*bend;
  float pos=fract(r.y*.45)*4.0;
  int k=int(floor(pos));
  float partial=mix(u_spectrum[4+k],u_spectrum[4+min(k+1,3)],smoothstep(.3,.7,fract(pos)));
  float bands=.5+.5*sin(r.y*6.5+w.x*2.0);
  float width=.32+low*.22;
  float band=smoothstep(width-.28,width+.28,bands);
  float fine=.5+.5*sin(r.y*26.0-flow*.5+w.y*5.0+partial*1.2);
  float thread=pow(fine,8.0)*(.15+partial*.55+high*.3);
  float grain=fbm(r*2.2+vec2(flow*.08,0.0));
  float density=band*(.45+.55*grain);
  vec3 c=fieldBase();
  c+=u_color0*density*.6;
  c+=u_color1*(1.0-band)*(.3+.7*grain)*.22;
  c+=u_color2*thread*band*.4;
  return c;
}

// ドットの波 — a flat cartoon lattice of discs. A size wave travels across
// the lattice as a plane, rows take their extra size from mid partials, a few
// cells flash the highlight colour on treble, and small counter-dots fill the
// gaps. The lattice marches sideways and turns very slowly.
vec3 dotWaveScene(vec2 p){
  float flow=u_motion.y;
  float mid=u_audio.z,high=u_audio.w;
  vec2 q=rotate(u_time*.02)*p;
  float cell=.16;
  vec2 g=q/cell;
  g.x+=flow*.25;
  vec2 g0=g;
  if(mod(floor(g.y),2.0)>.5)g.x+=.5;
  vec2 id=floor(g),f=fract(g)-.5;
  float turn=.7+sin(u_time*.04)*.3;
  vec2 dir=vec2(cos(turn),sin(turn));
  float wavePhase=dot(id,dir)*.55-u_time*1.4;
  float partial=u_spectrum[4+int(mod(id.y,4.0))];
  float r=min(.18+.22*(.5+.5*sin(wavePhase))+partial*.12,.46);
  float d=length(f)-r;
  float disc=1.0-smoothstep(0.0,fwidth(d)*1.5,d);
  float seed=hash(id+vec2(7.3,1.9));
  float accent=step(.93,seed)*smoothstep(.25,.6,high+u_spectrum[8+int(mod(id.x,4.0))]*.6);
  // Counter-dots sit on the unshifted lattice corners, so the row offset never cuts them.
  vec2 f2=fract(g0+.5)-.5;
  float d2=length(f2)-(.05+.05*(.5+.5*sin(wavePhase+1.57))+mid*.04);
  float dot2=1.0-smoothstep(0.0,fwidth(d2)*1.5,d2);
  vec3 c=fieldBase();
  c=mix(c,u_color0*.88,disc);
  c=mix(c,u_color2*.9,disc*accent);
  c=mix(c,u_color1*.7,dot2*(1.0-disc));
  return c;
}

// 折り紙 — shape animation: a field of flat square tiles flipping about
// their vertical axis as a diagonal wave sweeps through. Front and back show
// the two field colours; bass drives the pace through the integrated clock,
// mid partials offset columns, treble lights the tile edges.
vec3 origamiScene(vec2 p){
  float flow=u_motion.y;
  float high=u_audio.w;
  vec2 q=rotate(.12)*p;
  float cell=.19;
  vec2 g=q/cell;
  g.y+=flow*.12;
  vec2 id=floor(g),f=fract(g)-.5;
  vec2 dir=normalize(vec2(1.0,.6));
  float partial=u_spectrum[4+int(mod(id.x,4.0))];
  float phase=dot(id,dir)*.5-u_motion.x*1.1+partial*.9+hash(id+vec2(2.1,5.7))*.4;
  float c0=cos(phase);
  float d=box(f,vec2(.44*abs(c0),.44))-.03;
  float aa=fwidth(d);
  float tile=1.0-smoothstep(0.0,aa*1.5,d);
  float front=step(0.0,c0);
  vec3 face=mix(u_color1*.62,u_color0*.82,front)*(.62+.38*abs(c0));
  float edge=(1.0-smoothstep(0.0,aa*2.0,abs(d+.02)))*(.1+high*.5);
  vec3 c=fieldBase();
  c=mix(c,face,tile);
  c+=u_color2*edge*tile*.5;
  return c;
}

// 山並み — a pale sky over many layers of soft red
// ridges, like cut paper. Far ridges fade into the sky; near ridges deepen.
// The motion is broad and legible: each layer slides sideways at its own
// pace (parallax), the hills themselves swell and sink as a slow large wave
// travels across, bass heaves the near ridges, four mid partials bump four
// of the layers, treble lights a thin rim on the ridge edges. No object.
// Colour roles: u_color0 hills (the subject), u_color1 sky, u_color2 rim highlight.
float ridgeHeight(float x,float layer,float flow){
  float f=1.0+layer*.18;
  // Near layers travel faster and alternate direction, so the stack visibly shears.
  float drift=flow*(.07+layer*.05)*(mod(layer,2.0)<.5?1.0:-.85);
  // The noise field itself is sampled along a moving line, so peaks rise and fall.
  float n=fbm(vec2(x*f*.55+drift+layer*7.3,layer*3.1+u_time*.09));
  n+=.45*fbm(vec2(x*f*1.7-drift*1.3+layer*2.2,layer*5.7-u_time*.05));
  return (n/1.45-.5)*2.4;
}
vec3 ridgesScene(vec2 p){
  float flow=u_motion.y;
  float low=u_audio.y,high=u_audio.w;
  vec2 uv=v_uv;
  float aspect=u_resolution.x/u_resolution.y;
  float x=uv.x*aspect;
  // Sky: colour0 at the top, warming a little toward the horizon.
  vec3 sky=mix(u_color1,mix(u_color1,u_color0,.38),smoothstep(.98,.45,uv.y))*.92;
  vec3 c=sky;
  if(u_custom_background)c=mix(u_background,sky,.85);
  // One broad swell crosses the whole range; near layers feel it most.
  float swell=sin(x*1.1-u_time*.55)*.5+.5*sin(x*.6+u_time*.23);
  const float LAYERS=6.0;
  for(float i=0.0;i<LAYERS;i+=1.0){
    float depth=i/(LAYERS-1.0);               // 0 far, 1 near
    float base=.60-depth*.50;                 // far ridges sit high, near ones low
    float amp=.13+depth*.16;
    int k=int(mod(i,4.0));
    float partial=u_spectrum[4+k];
    float bump=sin(x*(2.2+i*.6)+flow*(.5+i*.08)+i)*partial*.09;
    float heave=low*(.05+.07*depth);
    float h=base+ridgeHeight(x,i,flow)*amp*(1.0+low*.6*depth)
      +swell*(.03+.06*depth)+bump+heave;
    float d=uv.y-h;
    float aa=fwidth(d)*1.2;
    float inside=1.0-smoothstep(0.0,aa,d);
    // Far layers are hazy and pale; near layers saturate, the nearest darken.
    vec3 hill=mix(mix(u_color0,sky,.52),u_color0,smoothstep(0.0,.7,depth));
    hill=mix(hill,u_color0*.48,smoothstep(.6,1.0,depth));
    float rim=(1.0-smoothstep(0.0,aa*3.0+.003,abs(d)))*(.04+high*.35)*(1.0-depth*.5);
    c=mix(c,hill,inside);
    c+=u_color2*rim;
  }
  return c;
}
