#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_brightness;
uniform float u_background_brightness;
// Foreground receives the existing raw row and meter/region controls directly.
uniform sampler2D u_raw;
uniform float u_time;
uniform vec3 u_bands;
uniform vec2 u_voice;
uniform sampler2D u_foreground_image;
uniform int u_foreground_active;
// Inverse plane perspective, including translation and the required cover zoom.
uniform mat3 u_camera_transform;
uniform int u_camera_active;
// Camera-only live history; opacity is applied once, outside both histories.
uniform sampler2D u_camera_image;
uniform float u_camera_opacity;
uniform sampler2D u_media0;
uniform sampler2D u_media1;
// opacity, scale relative to frame height, angle, source aspect ratio
uniform vec4 u_layer0;
uniform vec4 u_layer1;
// blend (0 normal, 1 screen, 2 add, 3 remove white, 4 remove black), fit
uniform vec2 u_mode0;
uniform vec2 u_mode1;
// Position is in output-frame fractions, positive right/down, before rotation.
uniform vec2 u_position0;
uniform vec2 u_position1;
uniform float u_key0;
uniform float u_key1;
uniform float u_softness0;
uniform float u_softness1;
// The detected content center remains the pivot during rotation and audio scale.
uniform vec2 u_anchor0;
uniform vec2 u_anchor1;

// @FOREGROUND@
// @CAMERA@

vec2 backgroundUV(vec2 uv) {
  // Preserve the old sampling coordinates exactly when camera motion is off.
  if(u_camera_active==0)return uv;
  float aspect=u_resolution.x/u_resolution.y;
  vec2 p=(uv-.5)*vec2(aspect,1.0);
  vec3 source=u_camera_transform*vec3(p,1.0);
  p=source.xy/source.z;
  return p/vec2(aspect,1.0)+.5;
}

// Keep original shading. Dividing colors by a tiny keyed alpha crushed pale
// gray details to black and amplified compression noise at the silhouette.
vec4 keyedSample(sampler2D media,vec2 uv,bool white,float threshold,float softness) {
  float bounds=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  vec4 sampleColor=texture(media,clamp(uv,0.0,1.0));
  float distance=white?1.0-min(sampleColor.r,min(sampleColor.g,sampleColor.b)):max(sampleColor.r,max(sampleColor.g,sampleColor.b));
  float feather=max(.001,softness*.1);
  // The removal boundary stays fixed when softness changes, so increasing
  // feather never brings the flat backing back. Calibrate existing 20% saves
  // to the gentler 17.5% edge; the default feather ends at 20%.
  float cutoff=max(0.0,threshold-.025);
  float coverage=smoothstep(cutoff,cutoff+feather,distance);
  float alpha=sampleColor.a*coverage*bounds;
  return vec4(sampleColor.rgb*alpha,alpha);
}

vec3 composite(vec3 base,sampler2D media,vec4 layer,vec2 mode,vec2 position,float threshold,float softness,vec2 anchor) {
  if(layer.x<=0.0)return base;
  float aspect=u_resolution.x/u_resolution.y;
  vec2 p=(v_uv-.5-vec2(position.x,-position.y))*vec2(aspect,1.0);
  float a=layer.z,c=cos(a),s=sin(a);
  p=mat2(c,s,-s,c)*p;
  float h=mode.y>.5?max(1.0,aspect/layer.w):min(1.0,aspect/layer.w);
  h*=max(layer.y,.001);
  vec2 uv=p/vec2(h*layer.w,h)+vec2(anchor.x,1.0-anchor.y);
  if(mode.x>2.5) {
    // Resolve four subpixels after keying. Premultiplied averaging softens
    // diagonal/rotating edges without pulling the matte back into the logo.
    vec2 dx=dFdx(uv)*.25,dy=dFdy(uv)*.25;
    bool white=mode.x<3.5;
    vec4 keyed=(keyedSample(media,uv-dx-dy,white,threshold,softness)
      +keyedSample(media,uv+dx-dy,white,threshold,softness)
      +keyedSample(media,uv-dx+dy,white,threshold,softness)
      +keyedSample(media,uv+dx+dy,white,threshold,softness))*.25;
    return base*(1.0-keyed.a*layer.x)+keyed.rgb*layer.x;
  }
  float bounds=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  vec4 sampleColor=texture(media,clamp(uv,0.0,1.0));
  float alpha=sampleColor.a*layer.x*bounds;
  vec3 color=sampleColor.rgb;
  if(mode.x>.5&&mode.x<1.5)color=1.0-(1.0-base)*(1.0-color);
  else if(mode.x>1.5&&mode.x<2.5)color=min(base+color,1.0);
  return mix(base,color,alpha);
}
void main() {
  vec2 sourceUV=backgroundUV(v_uv);
  vec3 color=texture(u_image,sourceUV).rgb;
  color=cameraComposite(color,u_camera_image,sourceUV,u_camera_opacity,0);
  // Apply live background gain outside stored fade snapshots, so interrupted
  // transitions cannot accumulate it. Keep highlights below the white core.
  color*=u_background_brightness;
  // Existing shaders use display-encoded sRGB values. This weighted luma
  // is an artistic brightness control, not linear-light relative luminance.
  float backgroundLuma=dot(color,vec3(.2126,.7152,.0722));
  color*=min(1.0,.48/max(backgroundLuma,.00001));
  // Gamut fit only: scale all channels together instead of clipping bright
  // red/blue independently. There is no sub-white maximum-channel cap.
  color/=max(1.0,max(color.r,max(color.g,color.b)));
  // Screen-fixed and added exactly once, after background fade/camera and
  // before media. Foreground history is independent of every background pass.
  vec2 center=(v_uv-.5)*vec2(u_resolution.x/u_resolution.y,1.0);
  vec3 foreground=u_foreground_active==1?texture(u_foreground_image,v_uv).rgb:ringsAudio(center);
  color=clamp(color+foreground,0.0,1.0);
  color=composite(color,u_media0,u_layer0,u_mode0,u_position0,u_key0,u_softness0,u_anchor0);
  color=composite(color,u_media1,u_layer1,u_mode1,u_position1,u_key1,u_softness1,u_anchor1);
  // Master brightness affects the whole output, including media and logos.
  outColor=vec4(clamp(color*u_brightness,0.0,1.0),1.0);
}
