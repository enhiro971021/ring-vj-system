#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_current;
uniform sampler2D u_previous;
uniform float u_mix;
uniform vec2 u_resolution;
uniform int u_look;
// Exposure, contrast and display-RGB luma cap belong only to the current background.
uniform vec3 u_background_treatment;

vec3 currentBackground() {
  vec3 color=texture(u_current,v_uv).rgb;
  // Preserve neon's existing background bloom before dimming the background.
  if(u_look==1){
    vec2 texel=2.0/u_resolution;
    vec3 glow=texture(u_current,v_uv+vec2(texel.x,0)).rgb+texture(u_current,v_uv-vec2(texel.x,0)).rgb
             +texture(u_current,v_uv+vec2(0,texel.y)).rgb+texture(u_current,v_uv-vec2(0,texel.y)).rgb;
    color+=max(glow*.25-.65,0.0)*.10;
  }
  // Same display-encoded RGB luma as the output stage; scene math stays intact.
  float luma=dot(color,vec3(.2126,.7152,.0722));
  // Soft compression toward the ceiling instead of a hard clamp: tones keep
  // their order (white stays above pink, pink above magenta), so a bright
  // palette reads as colour rather than as one flat grey. The ceiling is an
  // asymptote; the user's background brightness is applied later.
  float lin=pow(max(luma,0.0),u_background_treatment.y)*u_background_treatment.x;
  float ceiling=max(u_background_treatment.z,.01);
  float adjusted=ceiling*(1.0-exp(-lin/ceiling));
  color*=adjusted/max(luma,.00001);
  // Keep ratios intact when fitting the 8-bit render target's RGB gamut.
  return color/max(1.0,max(color.r,max(color.g,color.b)));
}
void main() {
  float amount = smoothstep(0.0, 1.0, u_mix);
  // Previous is a snapshot of the already-treated visible background. Never
  // apply a newly selected background's normalization to that outgoing frame.
  outColor = vec4(mix(texture(u_previous, v_uv).rgb, currentBackground(), amount), 1.0);
}
