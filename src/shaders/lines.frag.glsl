#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in float v_side;
out vec4 outColor;
void main(){
  float coverage=1.0-smoothstep(.40,1.0,abs(v_side));
  outColor=vec4(v_color,v_alpha*coverage);
}
