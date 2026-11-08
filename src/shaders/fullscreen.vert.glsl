#version 300 es
precision highp float;
out vec2 v_uv;

void main() {
  // One oversized triangle covers the viewport without a seam or vertex buffer.
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
