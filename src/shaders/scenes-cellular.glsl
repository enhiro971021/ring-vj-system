// CELLULAR FIELD — three sizes of weighted sites compete in one continuous
// power diagram. Small sites fill the spaces released by larger neighbours;
// they are not a second texture laid over otherwise equally sized cells.
// 27 local sites plus 26 edge tests, independent of output resolution.

float cellularRoundMin(float a,float b,float radius) {
  float h=max(radius-abs(a-b),0.0)/radius;
  return min(a,b)-h*h*radius*.25;
}

vec4 cellularSite(vec2 tile,int tier,float flow) {
  float tierKey=float(tier)*41.37;
  vec2 key=tile+vec2(tierKey,19.71-tierKey);
  vec2 jitter=vec2(hash(key),hash(key+vec2(31.53,7.19)));
  float identity=hash(key+vec2(7.13,53.79));
  float spacing=tier==0?.73:(tier==1?.255:.094);
  // Bound the finest jitter more tightly so the 3 x 3 support remains valid
  // even when its smallest site competes with a large neighbouring fine site.
  float scatter=tier==2?.60:.76;
  vec2 center=(tile+.5+(jitter-.5)*scatter)*spacing;

  // The slow field passes through entire neighbourhoods, opening large cells
  // and releasing dense families of small ones. Radii remain bounded so a
  // 3 x 3 search at each size contains every site able to win this pixel.
  float region=.5+.31*sin(center.x*.82+center.y*1.17+
    .65*sin(center.y*.68-flow*.12))
    +.17*sin(center.x*1.31-center.y*.47+flow*.09);
  // Distinct mid partials redistribute pressure between the three scales.
  // They alter bounded density fields, never the maximum site radius, keeping
  // the existing 3 x 3 neighbourhood support and continuous membranes intact.
  float tone=tier==0?u_spectrum[4]:(tier==1?
    .5*(u_spectrum[5]+u_spectrum[6]):u_spectrum[7]);
  float direction=tier==1?-1.0:1.0;
  float breathing=sin(center.x*(1.1+float(tier)*.7)
    +center.y*(.8-float(tier)*.35)-direction*flow*.20);
  region+=tone*.16*breathing;
  float pressure=u_spectrum[int(floor(identity*4.0))];
  float open=smoothstep(.18,.79,region);
  float radius;
  if(tier==0) {
    radius=mix(.025,.465,open)*mix(.78,1.0,identity);
    radius*=1.0+.035*sin(flow*.23+identity*TAU)+(.45*u_audio.y+.55*pressure)*.027;
  } else if(tier==1) {
    float family=.5+.5*sin(center.x*2.17-center.y*1.89+flow*.16
      +tone*.75*breathing);
    radius=mix(.032,.165,smoothstep(.12,.84,.40*open+.60*family));
    radius*=mix(.69,1.0,identity)*(1.0+(.45*u_audio.y+.55*pressure)*.016);
  } else {
    radius=mix(.018,.037,mix(identity,.5+.5*breathing,tone*.55));
  }
  return vec4(center,radius*radius,identity);
}

vec3 cellularScene(vec2 p,float t) {
  float warp=clamp(u_warp,0.0,2.0);
  float flow=u_motion.y,detail=u_motion.z;
  float low=u_audio.y,mid=u_audio.z,highs=u_audio.w;

  // Bounded spatial advection: mid changes the bend, bass applies only a small
  // pressure change. Continuous clocks retain position when audio changes.
  vec2 q=rotate(.07*sin(flow*.09))*p/(1.0+low*.027);
  q+=vec2(.14*sin(t*.047),.10*cos(t*.039));
  vec2 bend=vec2(sin(q.y*1.62-flow*.19),sin(q.x*1.31+flow*.16));
  q+=(.075+warp*.085+mid*.065)*bend;
  q+=vec2(sin(q.x*1.18+q.y*.91+flow*.14),
          sin(q.y*1.37-q.x*.72-flow*.11))*(.025+warp*.026);
  // Two partials bend in opposing directions rather than uniformly zooming.
  q+=vec2(.045*u_spectrum[5]*sin(q.y*2.3+flow*.18),
          .045*u_spectrum[7]*sin(q.x*2.1-flow*.15));

  vec4 sites[27];
  float bestScore=1e10;
  int bestIndex=0;
  vec4 winner=vec4(0.0);
  for(int tier=0;tier<3;tier++) {
    float spacing=tier==0?.73:(tier==1?.255:.094);
    vec2 tile=floor(q/spacing);
    for(int y=-1;y<=1;y++) {
      for(int x=-1;x<=1;x++) {
        int index=tier*9+(y+1)*3+x+1;
        vec4 site=cellularSite(tile+vec2(float(x),float(y)),tier,flow);
        sites[index]=site;
        vec2 delta=q-site.xy;
        float score=dot(delta,delta)-site.z;
        if(score<bestScore) {
          bestScore=score;
          bestIndex=index;
          winner=site;
        }
      }
    }
  }

  // Distance to the actual weighted bisectors gives a consistent membrane
  // width across all three sizes. Smooth intersections round polygon corners;
  // no radial shading, sphere normals or circular blob masks are involved.
  float radius=sqrt(winner.z);
  float rounding=clamp(radius*.17,.012,.056);
  float edge=1e5;
  for(int i=0;i<27;i++) {
    if(i==bestIndex)continue;
    vec4 other=sites[i];
    vec2 delta=q-other.xy;
    float score=dot(delta,delta)-other.z;
    float bisector=(score-bestScore)/(2.0*max(length(other.xy-winner.xy),.001));
    edge=cellularRoundMin(edge,bisector,rounding);
  }

  float pixel=max(length(dFdx(q)),length(dFdy(q)));
  pixel=max(pixel,1.0/max(u_resolution.y,1.0));
  float aa=max(fwidth(edge)*.65,pixel*.5);
  float membrane=pixel*(1.15+warp*.12);
  float face=smoothstep(membrane-aa,membrane+aa,edge);
  float rim=exp(-max(edge-membrane,0.0)/(pixel*1.55))*face;

  float identity=winner.w;
  float small=1.0-smoothstep(.035,.26,radius);
  vec3 pigment=identity<.34?u_color0:(identity<.70?u_color1:u_color2);
  // A restrained secondary mixture keeps the user colours on individual
  // planes; it never travels around a synthetic rainbow palette.
  float blendAmount=smoothstep(.78,.98,hash(winner.xy+21.7))*.17;
  vec3 nextPigment=identity<.34?u_color1:(identity<.70?u_color2:u_color0);
  if(!u_part_colors)pigment=mix(pigment,nextPigment,blendAmount);

  float variation=.91+.09*hash(winner.xy+72.9);
  vec3 background,plane;
  if(u_look==2) {
    background=artPaper();
    plane=mix(pigment,artPaper(),.12+small*.08)*variation;
    // A fine, quiet ink lip leaves pale user colours readable on paper.
    plane=mix(plane,artInk(),rim*.11);
  } else if(u_look==1) {
    background=vec3(.006,.009,.015);
    plane=pigment*(.70+.23*identity+.07*small);
    plane+=pigment*rim*.16;
  } else {
    background=vec3(.125,.132,.15);
    float tone=.25+identity*.25+small*.24;
    vec3 neutral=vec3(tone*.97,tone,tone*1.075);
    float accent=smoothstep(.79,.88,hash(winner.xy+vec2(18.7,39.1)));
    plane=mix(neutral,pigment*.91,accent*.82)*variation;
  }
  // Each group keeps its own pigment in part mode; only its lightness varies.
  if(u_part_colors){
    float shade=u_look==1?(.70+.23*identity+.07*small):variation;
    plane=pigment*shade*(1.0+rim*(u_look==1?.16:.06));
  }
  if(u_custom_background)background=u_background;

  // Treble visits a few short membrane segments at a time. The body keeps its
  // colour and shape; neither level nor treble can flash the full screen.
  float visit=smoothstep(.82,.995,sin(dot(winner.xy,vec2(.83,1.21))
    -detail*.78+identity*4.0));
  float segment=smoothstep(.15,.80,sin(q.x*8.2+q.y*5.7-detail*.38));
  float treble=u_spectrum[8+int(floor(identity*4.0))];
  float glint=rim*visit*segment*(highs*.25+treble*.75);
  vec3 c=mix(background,plane,face);
  if(u_part_colors)c+=pigment*glint*(u_look==1?.46:.15);
  else if(u_look==1)c+=mix(pigment,artPaper(),.18)*glint*.46;
  else c=mix(c,u_look==2?pigment:artPaper(),glint*.15);
  return max(c,vec3(0.0));
}
