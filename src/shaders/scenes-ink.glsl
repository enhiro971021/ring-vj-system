// にじむインク — broad pigment islands carried by a gently curling liquid.
// The first two colours fill the islands; the third inhabits their mixing
// channels. Fine texture is restricted to those channels, not drawn as marble.
float inkPigmentField(vec2 p,float phase){
  return noise(p+vec2(phase*.075,-phase*.044))*.64
    +noise(p*1.83+vec2(7.4,-3.6)+vec2(-phase*.033,phase*.052))*.28
    +noise(p*3.55+vec2(-2.8,9.7)+vec2(phase*.021,phase*.028))*.08;
}

vec3 inkScene(vec2 p){
  float flow=u_time*.72;
  float warp=clamp(u_warp,0.0,2.0);
  // Only the background clock moves the pigment. Its pace is independent
  // of the microphone and follows the existing speed/pause controls.
  vec2 q=rotate(-.28)*p*1.16;
  q+=vec2(flow*.055,-flow*.024);
  vec2 curl=vec2(
    sin(q.y*1.65+flow*.18)+.45*sin(q.x*1.25+q.y*.8-flow*.11),
    cos(q.x*1.42-flow*.15)+.40*sin(q.y*1.7-q.x*.75+flow*.09)
  );
  vec2 swell=vec2(
    sin(q.y*1.4+1.2+flow*.13)*.22+cos(q.x*1.8-q.y*.5-flow*.08)*.17,
    cos(q.x*1.2-.7-flow*.11)*.21+sin(q.y*1.9+q.x*.4+flow*.07)*.18
  );
  q+=curl*(.32+warp*.25)+swell*.25;
  // A second, slow shear folds large patches into one another without
  // creating a centre, a repeating ring or a uniform zoom.
  q+=vec2(
    noise(q*.75+vec2(3.7,flow*.065))-.5,
    noise(q*.75+vec2(-flow*.052,9.2))-.5
  )*(.36+warp*.28);

  float field=inkPigmentField(q,flow);
  float pressure=.022*sin(q.x*1.5-q.y*.8+flow*.12)
    +.014*cos(q.y*1.8+q.x*.55-flow*.10);
  float d=field-.485+pressure;
  // Pigment migrates unevenly along the boundary. The mixing band stays
  // much narrower than the islands and varies locally instead of becoming
  // a regular purple outline around every patch.
  float detail=noise(q*7.5+vec2(u_time*.08625,-u_time*.05175));
  float edgeZone=1.0-smoothstep(.035,.11,abs(d));
  d+=(detail-.5)*.017*edgeZone;
  float wetWidth=noise(q*2.6+vec2(5.1,-flow*.07));
  float mixing=(.018+warp*.004)*(.65+wetWidth*.95);
  float seam=1.0-smoothstep(mixing*.45,mixing*1.5,abs(d));
  float redSide=smoothstep(-mixing*.45,mixing*.45,d);
  vec3 pigment=mix(u_color1,u_color0,redSide);
  pigment=mix(pigment,u_color2,seam*.86);

  // Sparse secondary deposits make small tongues of pigment on one side
  // of the wet edge. There is no stack of parallel contour lines.
  float depositDistance=abs(d+mixing*(1.7+wetWidth*1.8));
  float deposit=(1.0-smoothstep(mixing*.30,mixing*.85,depositDistance))
    *smoothstep(.43,.72,noise(q*4.2+vec2(8.4,1.7)));
  pigment=mix(pigment,u_color2,deposit*.34);

  // Uneven wet edges carry slowly drifting granulation, with no global
  // flashing or high-frequency line pattern.
  float wet=seam*(.68+.32*detail);
  // Low-frequency density gives each red/blue island darker pools and
  // translucent areas; it also keeps the 175% background gain from
  // flattening the pigment into clipped, uniformly bright colour.
  float density=noise(q*.95+vec2(-flow*.035,3.8))*.72
    +noise(q*3.1+curl*.6+vec2(2.1,flow*.05))*.28;
  float body=.46+.34*density+.10*smoothstep(.025,.20,abs(d));
  pigment*=body;
  pigment+=u_color2*wet*.042;

  float recess=seam*(1.0-smoothstep(.25,.72,noise(q*1.1+vec2(13.2,4.8))));
  vec3 ground=u_custom_background?u_background:mix(u_color1,u_color2,.55)*.16;
  float depth=u_look==1?.48:.27;
  pigment=mix(pigment,ground,recess*depth);
  if(u_look==1){
    pigment*=.88;
    pigment+=u_color2*wet*.10;
  }
  return pigment;
}
