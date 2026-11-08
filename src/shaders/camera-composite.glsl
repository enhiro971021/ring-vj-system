// Include in the display fragment after its declarations. The filtered texture
// belongs to the same GL context and already has cover, orientation and mirror.
// Call BEFORE background gain/luma limiting and BEFORE fixed white rings.
// mode: 0 normal, 1 screen, 2 add. Uses straight alpha, like existing media.
vec3 cameraComposite(vec3 base,sampler2D filtered,vec2 uv,float opacity,int mode) {
  if(opacity<=0.0)return base;
  vec4 frame=texture(filtered,clamp(uv,0.0,1.0));
  vec3 color=frame.rgb;
  if(mode==1)color=1.0-(1.0-base)*(1.0-color);
  else if(mode==2)color=min(base+color,1.0);
  return mix(base,color,clamp(opacity*frame.a,0.0,1.0));
}
