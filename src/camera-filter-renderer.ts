import vertexSource from './shaders/fullscreen.vert.glsl?raw';
import fragmentSource from './shaders/camera-filter.frag.glsl?raw';
import { cameraCoverTransform } from './camera-filter-math';
import { hexToRgb, type ColorPalette } from './presets';

export type CameraFilterId = 'duotone' | 'halftone' | 'edge';
export type CameraCompositeMode = 'normal' | 'screen' | 'add';
/** A shared, downscaled capture. A mutable canvas needs a new sequence per frame. */
export type CameraFilterFrame = {
  source: TexImageSource;
  width: number;
  height: number;
  sequence: number;
};
export type CameraFilterParams = {
  width: number;
  height: number;
  filter: CameraFilterId;
  colors: ColorPalette;
  backgroundColor?: string;
  /** Default mirror matches a local camera preview. */
  mirror?: boolean;
  /** Caller-owned, pausable clock in seconds. */
  time?: number;
  /** Already smoothed 0..1 bands; the filter does not modify audio processing. */
  audio?: { low: number; mid: number; high: number };
};
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number };
type UniformName = 'u_input' | 'u_has_input' | 'u_filter' | 'u_resolution' | 'u_input_transform' |
  'u_color0' | 'u_color1' | 'u_color2' | 'u_background' | 'u_audio' | 'u_time';
const UNIFORM_NAMES: UniformName[] = ['u_input', 'u_has_input', 'u_filter', 'u_resolution', 'u_input_transform',
  'u_color0', 'u_color1', 'u_color2', 'u_background', 'u_audio', 'u_time'];
const clamp = (value: number | undefined, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : min;
const dimension = (value: number) => Math.round(clamp(value, 1, 4096));
const validSize = (value: number) => Number.isInteger(value) && value > 0;
const color = (value: string | undefined, fallback: string) => hexToRgb(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback);

/** One camera upload and one filter pass, sharing the caller's WebGL2 context.
 * It owns its input texture, program, VAO and optional output target. It does not
 * request camera access, own the shared capture, or retain background history.
 *
 * Calls change the current program, VAO, framebuffer, viewport, texture unit 0,
 * and disable blending/depth/scissor. The caller must bind its next pass as usual.
 * Call update only when the shared capture advances (or to clear it); changing
 * palette, filter or audio can render again without another camera upload.
 */
export class CameraFilterRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly input: WebGLTexture;
  private target: Target | null = null;
  private source: TexImageSource | null = null;
  private inputWidth = 1;
  private inputHeight = 1;
  private sequence: number | null = null;
  private inputReady = false;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = this.createProgram();
    let vao: WebGLVertexArrayObject | null = null;
    let input: WebGLTexture | null = null;
    try {
      this.uniforms = {} as Record<UniformName, WebGLUniformLocation>;
      for (const name of UNIFORM_NAMES) {
        const location = gl.getUniformLocation(this.program, name);
        if (location === null) throw new Error(`カメラフィルターの設定 ${name} が見つかりません。`);
        this.uniforms[name] = location;
      }
      vao = gl.createVertexArray();
      input = gl.createTexture();
      if (!vao || !input) throw new Error('カメラフィルター用のメモリーを確保できません。');
      this.vao = vao;
      this.input = input;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      this.textureParameters();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    } catch (error) {
      if (vao) gl.deleteVertexArray(vao);
      if (input) gl.deleteTexture(input);
      gl.deleteProgram(this.program);
      throw error;
    }
  }

  get hasFrame(): boolean { return this.inputReady; }

  /** Returns false for missing/invalid input; stale camera pixels are not used.
   * Same source + sequence + dimensions is reused, including mutable canvases.
   * A restarted capture may reset its sequence because null also resets the key.
   */
  update(frame: CameraFilterFrame | null): boolean {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) return false;
    if (!frame || !validSize(frame.width) || !validSize(frame.height) || !Number.isFinite(frame.sequence)) {
      this.clearInput();
      return false;
    }
    if (this.inputReady && frame.source === this.source && frame.sequence === this.sequence &&
        frame.width === this.inputWidth && frame.height === this.inputHeight) return true;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.input);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    const premultiplied = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      if (this.inputReady && frame.width === this.inputWidth && frame.height === this.inputHeight) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
      }
      this.source = frame.source;
      this.sequence = frame.sequence;
      this.inputWidth = frame.width;
      this.inputHeight = frame.height;
      this.inputReady = true;
      return true;
    } catch {
      this.clearInput();
      return false;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplied);
    }
  }

  /** Output is opaque display-RGB in 0..1, with no gain or final luma cap.
   * Its texture stays valid until the next size change or dispose().
   */
  render(params: CameraFilterParams): WebGLTexture {
    this.assertAvailable();
    const width = dimension(params.width), height = dimension(params.height);
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      const target = this.createTarget(width, height);
      if (this.target) this.deleteTarget(this.target);
      this.target = target;
    }
    this.draw(this.target.framebuffer, params, width, height);
    return this.target.texture;
  }

  /** Direct background-source path: caller can apply its history/fade afterwards.
   * The target must not attach this renderer's input texture or filtered output
   * while another pass samples it. null draws to the context's default buffer.
   */
  renderTo(framebuffer: WebGLFramebuffer | null, params: CameraFilterParams): void {
    this.assertAvailable();
    this.draw(framebuffer, params, dimension(params.width), dimension(params.height));
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.target) this.deleteTarget(this.target);
    this.gl.deleteTexture(this.input);
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.target = null;
    this.source = null;
    this.inputReady = false;
    this.disposed = true;
  }

  private draw(framebuffer: WebGLFramebuffer | null, params: CameraFilterParams, width: number, height: number): void {
    const gl = this.gl, u = this.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.program);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.input);
    gl.uniform1i(u.u_input, 0);
    gl.uniform1i(u.u_has_input, Number(this.inputReady));
    gl.uniform1i(u.u_filter, params.filter === 'halftone' ? 1 : params.filter === 'edge' ? 2 : 0);
    gl.uniform2f(u.u_resolution, width, height);
    gl.uniform4f(u.u_input_transform, ...cameraCoverTransform(this.inputWidth, this.inputHeight, width, height, params.mirror !== false));
    gl.uniform3f(u.u_color0, ...color(params.colors[0], '#00b6db'));
    gl.uniform3f(u.u_color1, ...color(params.colors[1], '#f02aa4'));
    gl.uniform3f(u.u_color2, ...color(params.colors[2], '#f3c44e'));
    gl.uniform3f(u.u_background, ...color(params.backgroundColor, '#020305'));
    gl.uniform3f(u.u_audio, clamp(params.audio?.low, 0, 1), clamp(params.audio?.mid, 0, 1), clamp(params.audio?.high, 0, 1));
    gl.uniform1f(u.u_time, Number.isFinite(params.time) ? params.time! : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private clearInput(): void {
    const gl = this.gl;
    if (this.inputReady || this.source) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.input);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    }
    this.source = null;
    this.sequence = null;
    this.inputWidth = 1;
    this.inputHeight = 1;
    this.inputReady = false;
  }

  private assertAvailable(): void {
    if (this.disposed || this.gl.isContextLost()) throw new Error('カメラフィルターの描画環境は終了しています。');
  }

  private textureParameters(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private createTarget(width: number, height: number): Target {
    const gl = this.gl, texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      throw new Error('カメラフィルターの描画先を確保できません。');
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.textureParameters();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer);
      throw new Error('カメラフィルターの描画先を作成できません。');
    }
    return { texture, framebuffer, width, height };
  }

  private deleteTarget(target: Target): void {
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.framebuffer);
  }

  private createProgram(): WebGLProgram {
    const gl = this.gl, shaders: WebGLShader[] = [], program = gl.createProgram();
    if (!program) throw new Error('カメラフィルターの描画プログラムを作成できません。');
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('カメラフィルターのシェーダーを作成できません。');
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`カメラフィルターのコンパイルに失敗しました。\n${gl.getShaderInfoLog(shader) ?? ''}`);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`カメラフィルターの接続に失敗しました。\n${gl.getProgramInfoLog(program) ?? ''}`);
      return program;
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }
}
