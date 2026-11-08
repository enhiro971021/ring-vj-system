#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
uniform sampler2D u_history;
uniform vec2 u_resolution;
uniform float u_dt;
uniform float u_trail;

mat2 rotate(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }

void main() {
  vec3 source=texture(u_source,v_uv).rgb;
  float aspect=u_resolution.x/u_resolution.y;
  // Match the existing scene pass's drift and half-life, including its paused
  // redraw behaviour. The entire point field now receives one temporal weight.
  vec2 historyP=(v_uv-.5)*vec2(aspect,1.0);
  historyP=rotate(u_dt*.012)*historyP;
  historyP*=exp(-u_dt*.018);
  vec2 uv=historyP/vec2(aspect,1.0)+.5;
  float inBounds=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  float halfLife=.008+pow(u_trail,3.0)*.65;
  vec3 history=texture(u_history,clamp(uv,0.0,1.0)).rgb;
  float persistence=(u_dt<=0.0||u_trail<.001)?0.0:exp2(-u_dt/halfLife)*inBounds;
  outColor=vec4(mix(source,history,persistence),1.0);
}
