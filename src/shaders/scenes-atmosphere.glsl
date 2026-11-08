// The visible structures are drawn by the GPU point pass. This pass owns the
// deep field, sparse framing, and temporal history, not a plastic surface.
vec3 atmosphereScene(vec2 p,float t,int pattern){
  vec3 c=artBackground(p);
  if(u_custom_background||u_part_colors)return c;
  if(u_look==2)return artPaper();
  // Keep LED blacks black. A very broad wash separates layers without blooming them.
  float halo=exp(-dot(p-vec2(-.3,.15),p-vec2(-.3,.15))*.65);
  c+=u_color0*halo*(1.0+u_warp*.08)*(u_look==1?.018:.035);
  return c;
}
