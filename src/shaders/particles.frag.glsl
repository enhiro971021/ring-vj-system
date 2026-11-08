#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main(){
  float r=length(gl_PointCoord-.5)*2.0;
  float coverage=1.0-smoothstep(.55,1.0,r);
  outColor=vec4(v_color,v_alpha*coverage);
}
