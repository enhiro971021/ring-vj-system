#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_input;
uniform int u_has_input;
uniform int u_filter;
uniform vec2 u_resolution;
// Signed scale xy, offset xy; the x sign provides mirror without a second pass.
uniform vec4 u_input_transform;
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_background;
uniform vec3 u_audio;
uniform float u_time;

float cameraHash(vec2 p) {
  vec3 p3=fract(vec3(p.xyx)*.1031);
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
vec2 cameraUV(vec2 uv) {
  return clamp(uv*u_input_transform.xy+u_input_transform.zw,0.0,1.0);
}
float cameraLuma(vec2 uv) {
  return dot(texture(u_input,clamp(uv,0.0,1.0)).rgb,vec3(.2126,.7152,.0722));
}
float cameraTone(float value) {
  // Low audio adds a small amount of density; mid audio moves tonal boundaries.
  return clamp((value-.5)*(1.14+u_audio.x*.22)+.5-u_audio.y*.035,0.0,1.0);
}
vec3 cameraInk(float tone) {
  vec3 ink=mix(u_color0,u_color1,smoothstep(.28,.64,tone));
  return mix(ink,u_color2,smoothstep(.79,.94,tone)*.66);
}
vec3 cameraFallback() {
  vec2 p=(v_uv-.5)*vec2(u_resolution.x/u_resolution.y,1.0);
  float wash=exp(-dot(p-vec2(-.28,.16),p-vec2(-.28,.16))*2.0);
  float accent=exp(-dot(p-vec2(.46,-.26),p-vec2(.46,-.26))*4.0);
  return mix(u_background,u_color0,.065*wash)+u_color1*.025*accent;
}
void main() {
  if(u_has_input==0) {
    outColor=vec4(clamp(cameraFallback(),0.0,1.0),1.0);
    return;
  }
  vec3 color;
  float signal;
  float grain=(cameraHash(floor(gl_FragCoord.xy/1.5)+floor(u_time*8.0))-.5)*(.012+u_audio.x*.012);
  if(u_filter==1) {
    // One source sample per dot. The grid follows output pixels and therefore
    // stays round even with a portrait input or a different output aspect.
    float pitch=max(4.0,u_resolution.y/112.0);
    vec2 cell=floor(gl_FragCoord.xy/pitch);
    vec2 centre=(cell+.5)*pitch/u_resolution;
    float tone=cameraTone(cameraLuma(cameraUV(centre)));
    float radius=mix(.07,.455,sqrt(tone));
    float distanceFromCentre=length(fract(gl_FragCoord.xy/pitch)-.5);
    float aa=max(fwidth(distanceFromCentre),.035);
    float dots=1.0-smoothstep(radius-aa,radius+aa,distanceFromCentre);
    vec3 paper=mix(u_background,u_color0,.075);
    color=mix(paper,cameraInk(tone)*(.43+.36*tone),dots);
    signal=dots*smoothstep(.55,.92,tone);
  } else if(u_filter==2) {
    // 3x3 Sobel: nine source samples, with a ~1 output-pixel sampling radius.
    // It reveals contours, not RGB copies or a thick full-screen glow.
    vec2 uv=cameraUV(v_uv);
    vec2 d=abs(u_input_transform.xy)/u_resolution*1.15;
    float tl=cameraLuma(uv+vec2(-d.x,d.y));
    float tc=cameraLuma(uv+vec2(0.0,d.y));
    float tr=cameraLuma(uv+d);
    float ml=cameraLuma(uv-vec2(d.x,0.0));
    float mc=cameraLuma(uv);
    float mr=cameraLuma(uv+vec2(d.x,0.0));
    float bl=cameraLuma(uv-d);
    float bc=cameraLuma(uv-vec2(0.0,d.y));
    float br=cameraLuma(uv+vec2(d.x,-d.y));
    vec2 gradient=vec2(tr+2.0*mr+br-tl-2.0*ml-bl,tl+2.0*tc+tr-bl-2.0*bc-br)*.25;
    float magnitude=length(gradient)*(1.0+u_audio.x*.18);
    float threshold=.046-u_audio.y*.012;
    float edge=smoothstep(threshold,threshold+.10,magnitude);
    float tone=cameraTone(mc);
    vec3 ink=mix(u_color0,u_color1,smoothstep(.26,.72,tone));
    ink=mix(ink,u_color2,smoothstep(.16,.40,magnitude)*.58);
    color=mix(u_background,u_color0,.025*tone)+ink*edge*.80;
    signal=edge;
  } else {
    // Two main tonal inks, with the third selected colour reserved for the
    // smallest bright regions. The real camera's colours never leak through.
    float tone=cameraTone(cameraLuma(cameraUV(v_uv)));
    vec3 dark=mix(u_background,u_color0,.46);
    vec3 light=mix(u_color1,u_color2,smoothstep(.78,.94,tone)*.46);
    float separation=smoothstep(.33,.64,tone+grain);
    color=mix(dark,light*.82,separation);
    color=mix(u_background,color,smoothstep(.025,.18,tone));
    signal=smoothstep(.68,.94,tone);
  }
  // Sparse, low-amplitude coloured glints. No white flashes or global pulse.
  vec2 glintCell=floor(gl_FragCoord.xy/max(3.0,u_resolution.y/180.0));
  float sparse=smoothstep(.982,1.0,cameraHash(glintCell));
  float shimmer=.5+.5*sin(u_time*3.0+cameraHash(glintCell+21.7)*6.2831853);
  color+=u_color2*(sparse*shimmer*signal*u_audio.z*.075);
  color*=1.0+grain;
  // Raw, normalized palette colour. The display pass applies background gain,
  // the 0.48 luma limit, gamut fit and fixed white foreground afterwards.
  outColor=vec4(clamp(color,0.0,1.0),1.0);
}
