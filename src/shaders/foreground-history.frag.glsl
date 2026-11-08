#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform sampler2D u_raw;
uniform float u_time;
uniform vec3 u_bands;
uniform vec2 u_voice;
uniform sampler2D u_history;
uniform float u_dt;
uniform float u_trail;

// @FOREGROUND@

void main() {
  vec2 center=(v_uv-.5)*vec2(u_resolution.x/u_resolution.y,1.0);
  vec3 current=clamp(ringsAudio(center),0.0,1.0);
  float halfLife=.008+pow(u_trail,3.0)*.65;
  float persistence=u_trail>0.0?exp2(-u_dt/halfLife):0.0;
  // Screen-space history belongs only to the white foreground. Round decaying
  // RGBA8 history down so dim trails cannot stick forever at a rounding plateau.
  vec3 history=floor(texture(u_history,v_uv).rgb*persistence*255.0)/255.0;
  // Preserve the current sharp lines; overlapping trails never add brightness.
  outColor=vec4(max(current,history),1.0);
}
