// 光の屈折 — broad transmitted-light fields, with a little colour separation
// along their folds. No source point, tunnel, fine stripe lattice or white light.
// The three colours stay attached to the light, glass and refracted edge.
// Motion is autonomous: only the background clock and user settings affect it.
vec3 prismaticScene(vec2 p){
  float flow=u_time*.72;
  float neon=u_look==1?1.0:0.0;
  float bend=.55+clamp(u_warp,0.0,2.0)*.45;

  // Four slow components bend the surface with fixed, bounded amplitudes.
  vec2 q=p;
  q.x+=.30*sin(p.y*1.65+flow*.27)
       +.16*cos(p.x*.85-p.y*.60-flow*.19);
  q.y+=.28*sin(p.x*1.30-flow*.23)
       +.14*sin(p.y*1.15+p.x*.55+flow*.17);
  q=mix(p,q,bend);

  // Two oblique optical fields make a handful of very large curved facets.
  // Their different directions keep the light from reading as parallel ribbons.
  float a=sin(q.x*1.28+q.y*1.85+flow*.23)
         +.28*sin(q.x*2.15-q.y*.70-flow*.16+1.1);
  float b=sin(-q.x*1.05+q.y*1.68-flow*.19+1.8)
         +.23*sin(q.x*.72+q.y*2.25+flow*.14);
  float thickness=.54;
  float pool=smoothstep(-thickness,.78,a);
  float facet=smoothstep(-.65,.85,b);
  float depth=smoothstep(-1.1,1.1,a*.38+b*.62);

  vec3 ground=u_custom_background?u_background:u_color1*.16;
  vec3 c=mix(ground,u_color1*(.46+depth*.26),.86-neon*.10);
  // Broad soft colour within the surface, with calm dark channels between it.
  float transmitted=pool*(.66+.34*(1.0-facet));
  c=mix(c,u_color0*(.48+.38*pool),transmitted*(.87-neon*.08));
  c=mix(c,u_color1*(.58+facet*.28),facet*(1.0-pool)*.64);

  // A coloured fringe sits beside, rather than on top of, its companion fold.
  // The limited support avoids a uniform glowing network or all-screen flash.
  float width=.083-neon*.022;
  float distanceA=(a+.20)/width;
  float distanceB=(b-.10)/(width*1.2);
  float edgeA=exp(-distanceA*distanceA);
  float edgeB=exp(-distanceB*distanceB);
  float edgeGateA=smoothstep(-.75,.65,b);
  float edgeGateB=1.0-smoothstep(-.55,.60,a);
  float fringe=edgeA*edgeGateA+edgeB*edgeGateB*.65;
  float nearDistance=(a+.20+width*1.55)/(width*1.8);
  float nearFringe=exp(-nearDistance*nearDistance)*edgeGateA;
  c+=u_color2*fringe*(.34+neon*.10);
  c+=u_color0*nearFringe*.09;

  // A low-frequency grazing reflection gives the soft field an optical finish.
  float grazing=.5+.5*sin(q.x*.92-q.y*1.24+flow*.11+.7);
  c*=.86+.14*grazing;
  return c;
}
