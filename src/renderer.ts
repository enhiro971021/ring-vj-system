import vertexSource from './shaders/fullscreen.vert.glsl?raw';
import flowTemplate from './shaders/flow.frag.glsl?raw';
import atmosphereSource from './shaders/scenes-atmosphere.glsl?raw';
import cellularSource from './shaders/scenes-cellular.glsl?raw';
import ringsSource from './shaders/scenes-rings.glsl?raw';
import fieldsSource from './shaders/scenes-fields.glsl?raw';
import prismaticSource from './shaders/scenes-prismatic.glsl?raw';
import inkSource from './shaders/scenes-ink.glsl?raw';
import { RAW_SPECTRUM_SIZE, rawFromBands, rawRegions, rawVoiceSum, type AudioFeatures } from './audio';
const flowSource = flowTemplate.replace('// @SCENES@', [atmosphereSource, cellularSource, ringsSource, fieldsSource, prismaticSource, inkSource].join('\n'));
import blendSource from './shaders/blend.frag.glsl?raw';
import displayTemplate from './shaders/display.frag.glsl?raw';
import foregroundRingsSource from './shaders/foreground-rings.glsl?raw';
import foregroundHistoryTemplate from './shaders/foreground-history.frag.glsl?raw';
const foregroundHistorySource = foregroundHistoryTemplate.replace('// @FOREGROUND@', foregroundRingsSource);
import cameraCompositeSource from './shaders/camera-composite.glsl?raw';
const displaySource = displayTemplate.replace('// @FOREGROUND@', foregroundRingsSource).replace('// @CAMERA@', cameraCompositeSource);
import particleVertexSource from './shaders/particles.vert.glsl?raw';
import particleFragmentSource from './shaders/particles.frag.glsl?raw';
import particleHistorySource from './shaders/particles-history.frag.glsl?raw';
import lineVertexTemplate from './shaders/lines.vert.glsl?raw';
import spatialLinesSource from './shaders/lines-spatial.glsl?raw';
import lineFragmentSource from './shaders/lines.frag.glsl?raw';
const lineVertexSource = lineVertexTemplate.replace('// @SPATIAL@', spatialLinesSource);
import { PRESETS, hexToRgb, type ColorPalette, type ScenePreset, type VisualLook } from './presets';

import { MotionDirector } from './motion';
import { backgroundCameraTransform, type CameraTransformSettings } from './camera-transform';
import { BACKGROUND_TREATMENTS, DEFAULT_BACKGROUND_BRIGHTNESS } from './background-treatment';
import { CameraFilterRenderer, type CameraFilterFrame, type CameraFilterParams } from './camera-filter-renderer';

export type VisualSettings = CameraTransformSettings & {
  look?: VisualLook;
  warp: number;
  trail: number;
  /** Screen-fixed white line history, independent of the background trail. */
  foregroundTrail?: number;
  speed: number;
  brightness: number;
  /** Gain of the background after crossfade; never changes foreground light. */
  backgroundBrightness?: number;
  colors?: ColorPalette;
  /** Attach the three colors to individual scene parts rather than blend a palette. */
  partColors?: boolean;
  /** Optional six-digit HEX background; absent or invalid keeps the authored background. */
  backgroundColor?: string;
  cameraFrame?: CameraFilterFrame | null;
  performanceMode?: 'dj' | 'live';
  liveOpacity?: number;
  cameraMirror?: boolean;
};
export type RenderAudio = AudioFeatures;
// All background sources share a silent input; only their ambient clocks run.
// The real microphone bands and raw spectrum still feed the white foreground below.
const BACKGROUND_AUDIO: RenderAudio = { level: 0, low: 0, mid: 0, high: 0, pulse: 0 };
export type MediaLayerFrame = {
  source: TexImageSource;
  width: number;
  height: number;
  opacity: number;
  /** Scale relative to contained/covered frame. A contained square at .35 is 35% of frame height. */
  scale: number;
  rotation: number;
  blend: 'normal' | 'screen' | 'add' | 'remove-white' | 'remove-black';
  /** Output frame fractions; positive values move right/down, independent of rotation. */
  positionX?: number;
  positionY?: number;
  /** Distance from white/black to remove, with a narrow soft edge beyond it. */
  keyThreshold?: number;
  /** Soft transition width on the removed side of the key boundary. */
  keySoftness?: number;
  /** Source-space rotation/scale pivot, measured from its top left. */
  anchorX?: number;
  anchorY?: number;
  fit: 'contain' | 'cover';
};
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
type MediaTexture = { texture: WebGLTexture; source: TexImageSource | null; width: number; height: number; time: number };
type FlowUniform = 'u_time' | 'u_spectrum' | 'u_look' | 'u_motion' | 'u_history' | 'u_resolution' | 'u_dt' | 'u_audio' | 'u_warp' | 'u_trail' | 'u_pattern' | 'u_color0' | 'u_color1' | 'u_color2' | 'u_part_colors' | 'u_custom_background' | 'u_background';
type ParticleUniform = 'u_spectrum' | 'u_resolution' | 'u_motion' | 'u_audio' | 'u_color0' | 'u_color1' | 'u_color2' | 'u_pattern' | 'u_look' | 'u_warp' | 'u_opacity' | 'u_part_colors';
type ParticleHistoryUniform = 'u_source' | 'u_history' | 'u_resolution' | 'u_dt' | 'u_trail';
type ForegroundHistoryUniform = 'u_raw' | 'u_time' | 'u_bands' | 'u_voice' | 'u_history' | 'u_resolution' | 'u_dt' | 'u_trail';
type LineUniform = Exclude<ParticleUniform, 'u_opacity'>;
type DisplayUniform = 'u_raw' | 'u_time' | 'u_bands' | 'u_voice' | 'u_foreground_image' | 'u_foreground_active' | 'u_image' | 'u_resolution' | 'u_brightness' | 'u_camera_transform' | 'u_camera_active' | 'u_camera_image' | 'u_camera_opacity' | 'u_background_brightness' | 'u_media0' | 'u_media1' | 'u_layer0' | 'u_layer1' | 'u_mode0' | 'u_mode1' | 'u_position0' | 'u_position1' | 'u_key0' | 'u_key1' | 'u_anchor0' | 'u_anchor1' | 'u_softness0' | 'u_softness1';
type BlendUniform = 'u_current' | 'u_previous' | 'u_mix' | 'u_resolution' | 'u_look' | 'u_background_treatment';
type Uniforms<T extends string> = Record<T, WebGLUniformLocation>;
const clamp = (v: number, min: number, max: number) => Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
const PARTICLE_COUNT = 384 * 256;
const LINE_VERTEX_COUNT = 32768 * 6;

/** Background history/fade, fixed audio foreground and media are independent. */
export class VisualRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly flow: WebGLProgram;
  private readonly particles: WebGLProgram;
  private readonly particleHistory: WebGLProgram;
  private readonly lines: WebGLProgram;
  private readonly blend: WebGLProgram;
  private readonly display: WebGLProgram;
  private foregroundHistoryProgram: WebGLProgram | null = null;
  private foregroundHistoryUniforms: Uniforms<ForegroundHistoryUniform> | null = null;
  private foregroundHistory: [Target, Target] | null = null;
  private foregroundReadIndex: 0 | 1 = 0;
  private foregroundHistoryReady = false;
  private readonly flowUniforms: Uniforms<FlowUniform>;
  private readonly particleUniforms: Uniforms<ParticleUniform>;
  private readonly particleHistoryUniforms: Uniforms<ParticleHistoryUniform>;
  private readonly lineUniforms: Uniforms<LineUniform>;
  private readonly blendUniforms: Uniforms<BlendUniform>;
  private readonly displayUniforms: Uniforms<DisplayUniform>;
  private readonly vao: WebGLVertexArrayObject;
  private targets: [Target, Target] | null = null;
  private composite: Target | null = null;
  private outgoing: Target | null = null;
  private media: MediaTexture[] = [];
  private readIndex: 0 | 1 = 0;
  private quality: 'auto' | 'high' | 'low' = 'auto';
  private readonly motion = new MotionDirector();
  private readonly rawTexture: WebGLTexture;
  private readonly rawFallback = new Float32Array(RAW_SPECTRUM_SIZE);
  private readonly rawRegionValues = new Float32Array(10);
  /** low, mid, high, outline drive, fourth region: held while a frame is frozen. */
  private readonly ringControls = [0, 0, 0, 0, 0];
  /** Background seconds follow the background speed and look. */
  private clock = 0;
  /** Real elapsed seconds: never reset by background, look, colour or camera. */
  private foregroundClock = 0;
  private motionReady = false;
  private historyReady = false;
  private lastLook: VisualLook | null = null;
  private preset: ScenePreset = PRESETS.find(p => p.id === 'flow')!;
  private transitionDuration = 0;
  private transitionElapsed = 0;
  private hasFrame = false;
  private disposed = false;
  private lastColors = '';
  private colorValues: [number, number, number][] = [];
  private backgroundValue: [number, number, number] = [0, 0, 0];
  private cameraTransform = backgroundCameraTransform({}, 1);
  private cameraFilter: CameraFilterRenderer | null = null;
  private cameraLiveHistory: [Target, Target] | null = null;
  private cameraLiveReadIndex: 0 | 1 = 0;
  private cameraLiveReady = false;
  private cameraStyleKey = '';
  private cameraDormantAdvanced = false;
  private compositeContainsCamera = false;
  private outgoingContainsCamera = false;
  /** Live opacity stays outside the background snapshot, so snapshot its weight too. */
  private lastLiveWeight = 0;
  private outgoingLiveWeight = 0;

  /** Includes an outgoing camera snapshot retained by an active or paused fade. */
  get hasCameraOutput(): boolean {
    return !this.disposed && this.hasFrame && (this.compositeContainsCamera || this.lastLiveWeight > 0);
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2を起動できません。Chromeのグラフィックアクセラレーションを確認してください。');
    this.gl = gl;
    const programs: WebGLProgram[] = [];
    let vao: WebGLVertexArrayObject | null = null;
    let rawTexture: WebGLTexture | null = null;
    try {
      this.flow = this.createProgram(vertexSource, flowSource, '模様'); programs.push(this.flow);
      this.particles = this.createProgram(particleVertexSource, particleFragmentSource, '点群'); programs.push(this.particles);
      this.particleHistory = this.createProgram(vertexSource, particleHistorySource, '点群残像'); programs.push(this.particleHistory);
      this.lines = this.createProgram(lineVertexSource, lineFragmentSource, '空間の線'); programs.push(this.lines);
      this.blend = this.createProgram(vertexSource, blendSource, '切替'); programs.push(this.blend);
      this.display = this.createProgram(vertexSource, displaySource, '出力'); programs.push(this.display);
      this.flowUniforms = this.getUniforms(this.flow, ['u_time','u_spectrum','u_look','u_motion','u_history','u_resolution','u_dt','u_audio','u_warp','u_trail','u_pattern','u_color0','u_color1','u_color2','u_part_colors','u_custom_background','u_background']);
      this.particleUniforms = this.getUniforms(this.particles, ['u_spectrum','u_resolution','u_motion','u_audio','u_color0','u_color1','u_color2','u_pattern','u_look','u_warp','u_opacity','u_part_colors']);
      this.particleHistoryUniforms = this.getUniforms(this.particleHistory, ['u_source','u_history','u_resolution','u_dt','u_trail']);
      this.lineUniforms = this.getUniforms(this.lines, ['u_spectrum','u_resolution','u_motion','u_audio','u_color0','u_color1','u_color2','u_pattern','u_look','u_warp','u_part_colors']);
      this.blendUniforms = this.getUniforms(this.blend, ['u_current','u_previous','u_mix','u_resolution','u_look','u_background_treatment']);
      this.displayUniforms = this.getUniforms(this.display, ['u_raw','u_time','u_bands','u_voice','u_foreground_image','u_foreground_active','u_image','u_resolution','u_brightness','u_camera_transform','u_camera_active','u_camera_image','u_camera_opacity','u_background_brightness','u_media0','u_media1','u_layer0','u_layer1','u_mode0','u_mode1','u_position0','u_position1','u_key0','u_key1','u_anchor0','u_anchor1','u_softness0','u_softness1']);
      vao = gl.createVertexArray();
      if (!vao) throw new Error('描画用のメモリーを確保できません。');
      this.vao = vao;
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.DITHER);
      for (let i = 0; i < 2; i++) {
        const texture = gl.createTexture();
        if (!texture) throw new Error('素材用のメモリーを確保できません。');
        this.media.push({ texture, source: null, width: 1, height: 1, time: -1 });
        gl.bindTexture(gl.TEXTURE_2D, texture);
        this.textureParameters();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
      }
      rawTexture = gl.createTexture();
      if (!rawTexture) throw new Error('音声用のメモリーを確保できません。');
      this.rawTexture = rawTexture;
      gl.bindTexture(gl.TEXTURE_2D, rawTexture);
      this.textureParameters();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, RAW_SPECTRUM_SIZE, 1, 0, gl.RED, gl.FLOAT, this.rawFallback);
      this.resize('auto');
    } catch (error) {
      if (rawTexture) gl.deleteTexture(rawTexture);
      this.deleteTargets();
      for (const program of programs) gl.deleteProgram(program);
      for (const entry of this.media) gl.deleteTexture(entry.texture);
      if (vao) gl.deleteVertexArray(vao);
      throw error;
    }
  }

  /** 16:9 is stable even while panels open. previewWidth is only for gallery thumbnails. */
  resize(quality: 'auto' | 'high' | 'low' = this.quality, previewWidth?: number): void {
    if (this.disposed || this.gl.isContextLost()) return;
    this.quality = quality;
    const width = previewWidth === undefined ? (quality === 'high' ? 1920 : quality === 'low' ? 1280 : 1600) : Math.round(clamp(previewWidth, 64, 1920));
    const height = Math.round(width * 9 / 16);
    if (this.targets && this.canvas.width === width && this.canvas.height === height) return;
    const allocated: Target[] = [];
    try { for (let i = 0; i < 4; i++) allocated.push(this.createTarget(width, height)); }
    catch (error) { for (const target of allocated) this.deleteTarget(target); throw error; }
    this.deleteTargets();
    this.targets = [allocated[0], allocated[1]];
    this.composite = allocated[2]; this.outgoing = allocated[3];
    this.canvas.width = width; this.canvas.height = height;
    this.clear();
  }

  setPreset(preset: ScenePreset, transitionSeconds: number): void {
    if (this.disposed || this.gl.isContextLost()) return;
    const gl = this.gl;
    const duration = clamp(transitionSeconds, 0, 10);
    if (this.hasFrame && this.composite && this.outgoing && duration > 0) {
      // Snapshot the last *visible background*, including an interrupted fade.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.composite.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.outgoing.framebuffer);
      gl.blitFramebuffer(0,0,this.canvas.width,this.canvas.height,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.transitionDuration = duration; this.transitionElapsed = 0;
      this.outgoingContainsCamera = this.compositeContainsCamera;
      this.outgoingLiveWeight = this.lastLiveWeight;
    } else {
      this.transitionDuration = 0; this.transitionElapsed = 0;
      this.outgoingContainsCamera = false; this.outgoingLiveWeight = 0;
    }
    this.preset = preset;
    this.clearHistory();
  }

  render(_timeSeconds: number, dtSeconds: number, audio: RenderAudio, settings: VisualSettings, layers: MediaLayerFrame[] = []): void {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost() || !this.targets || !this.composite || !this.outgoing) return;
    const dt = clamp(dtSeconds, 0, .1);
    // A colour or brightness redraw while paused must keep the entire view.
    if (dt > 0 || !this.hasFrame) this.cameraTransform = backgroundCameraTransform(settings, this.canvas.width / this.canvas.height);
    const look = settings.look ?? 'graphic';
    const lookIndex = look === 'neon' ? 1 : 0;
    if (look !== this.lastLook) { this.clearHistory(); this.lastLook = look; }
    if (!this.motionReady) { this.motion.reset(BACKGROUND_AUDIO); this.motionReady = true; }
    const rate = clamp(settings.speed, 0, 2);
    const directed = this.motion.update(BACKGROUND_AUDIO, dt, rate);
    // dt=0 freezes an in-progress transition; explicit paused selections pass duration=0.
    const elapsed = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
    this.transitionElapsed = Math.min(this.transitionDuration, this.transitionElapsed + elapsed);
    this.foregroundClock += elapsed;
    const colors = settings.colors ?? this.preset.colors;
    const partColors = settings.partColors === true;
    const backgroundColor = typeof settings.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(settings.backgroundColor)
      ? settings.backgroundColor.toLowerCase() : this.preset.id === 'plasma' ? '#020305' : null;
    const key = `${colors.join(',')}|${partColors}|${backgroundColor ?? ''}`;
    if (key !== this.lastColors) {
      if (this.lastColors) this.clearHistory();
      this.lastColors = key;
      this.colorValues = colors.map(hexToRgb);
      this.backgroundValue = backgroundColor ? hexToRgb(backgroundColor) : [0, 0, 0];
    }
    const cameraScene = this.preset.id === 'camera-duotone' || this.preset.id === 'camera-halftone';
    const liveOpacity = Number.isFinite(settings.liveOpacity) ? clamp(settings.liveOpacity!, 0, 1) : .25;
    const hadCameraFrame = this.cameraFilter?.hasFrame === true;
    if (settings.cameraFrame === null) {
      this.cameraFilter?.update(null);
      this.cameraLiveReady = false;
      if (hadCameraFrame && cameraScene) this.clearHistory();
      // A camera stop also removes any camera pixels stored in an outgoing fade.
      if (this.outgoingContainsCamera) {
        this.transitionDuration = 0; this.transitionElapsed = 0;
        this.outgoingContainsCamera = false;
      }
    }
    // Use the same smoothstep as the background blend. A camera scene replaces
    // the live layer gradually; interrupted fades inherit the last visible weight.
    const progress = this.transitionDuration > 0 ? this.transitionElapsed / this.transitionDuration : 1;
    const fade = progress * progress * (3 - 2 * progress);
    const incomingLiveWeight = cameraScene ? 0 : 1;
    const liveWeight = settings.performanceMode === 'live'
      ? this.outgoingLiveWeight + (incomingLiveWeight - this.outgoingLiveWeight) * fade : 0;
    const liveRequested = liveWeight > 0 && liveOpacity > 0;
    const cameraWanted = cameraScene || liveRequested;
    if (!cameraWanted && dt > 0) this.cameraDormantAdvanced = true;
    if (cameraWanted) {
      this.cameraFilter ??= new CameraFilterRenderer(gl);
      if (settings.cameraFrame && (dt > 0 || !this.cameraFilter.hasFrame || this.cameraDormantAdvanced)) {
        this.cameraFilter.update(settings.cameraFrame);
        this.cameraDormantAdvanced = false;
      }
      if (hadCameraFrame !== this.cameraFilter.hasFrame) {
        this.cameraLiveReady = false;
        if (cameraScene) this.clearHistory();
      }
    }
    const cameraKey = `${key}|${settings.cameraMirror !== false}|${cameraScene ? this.preset.id : 'live'}`;
    if (cameraKey !== this.cameraStyleKey) {
      this.cameraStyleKey = cameraKey;
      this.cameraLiveReady = false;
      if (cameraScene) this.clearHistory();
    }
    const read = this.targets[this.readIndex];
    const writeIndex: 0 | 1 = this.readIndex === 0 ? 1 : 0;
    const write = this.targets[writeIndex];
    const particleScene = this.preset.pattern === 0 || this.preset.pattern === 10 || this.preset.pattern === 11;
    const lineScene = [3, 13].includes(this.preset.pattern);
    const geometryScene = particleScene || lineScene;
    const temporalScene = geometryScene || cameraScene;
    const trail = this.historyReady ? clamp(settings.trail,0,1) : 0;
    const cameraParams: CameraFilterParams = {
      width: this.canvas.width, height: this.canvas.height,
      filter: this.preset.id === 'camera-halftone' ? 'halftone' : 'duotone', colors,
      backgroundColor: backgroundColor ?? '#020305', mirror: settings.cameraMirror !== false,
      time: this.foregroundClock, audio: directed.audio,
    };
    // The raw audio row remains independent of which background source is drawn.
    this.clock += dt * rate;
    this.bindTexture(1, this.rawTexture);
    if (dt > 0 || !this.hasFrame) {
      const raw = audio.raw?.length === RAW_SPECTRUM_SIZE ? audio.raw : rawFromBands(audio, this.rawFallback);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RAW_SPECTRUM_SIZE, 1, gl.RED, gl.FLOAT, raw);
      const regions = rawRegions(raw, this.rawRegionValues), c = this.ringControls;
      c[0] = clamp(audio.low, 0, 1); c[1] = clamp(audio.mid, 0, 1); c[2] = clamp(audio.high, 0, 1);
      c[3] = rawVoiceSum(regions); c[4] = regions[3];
    }
    gl.bindVertexArray(this.vao); gl.viewport(0,0,this.canvas.width,this.canvas.height);
    // Point scenes first build a complete fresh source in composite. setPreset
    // has already copied any outgoing frame, so this target is safe to reuse.
    if (cameraScene) {
      if (dt > 0 || !this.historyReady) this.cameraFilter!.renderTo(this.composite.framebuffer, cameraParams);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, geometryScene ? this.composite.framebuffer : write.framebuffer); gl.useProgram(this.flow);
      this.bindTexture(0, read.texture);
      const f = this.flowUniforms;
      gl.uniform1i(f.u_history, 0); gl.uniform2f(f.u_resolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(f.u_dt, dt);
      gl.uniform4f(f.u_audio,directed.audio.level,directed.audio.low,directed.audio.mid,directed.audio.high);
      gl.uniform1fv(f.u_spectrum,directed.spectrum);
      gl.uniform1f(f.u_time, this.clock);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform4f(f.u_motion,...directed.phases,directed.energy); gl.uniform1i(f.u_look,lookIndex);
      gl.uniform1f(f.u_warp,clamp(settings.warp,0,2)); gl.uniform1f(f.u_trail,geometryScene ? 0 : trail);
      gl.uniform1i(f.u_pattern,this.preset.pattern);
      gl.uniform1i(f.u_part_colors, Number(partColors));
      gl.uniform1i(f.u_custom_background, Number(backgroundColor !== null));
      gl.uniform3f(f.u_background, ...this.backgroundValue);
      for (let i = 0; i < 3; i++) gl.uniform3f(f[`u_color${i}` as 'u_color0'|'u_color1'|'u_color2'], ...this.colorValues[i]);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }

    if (particleScene) {
      // Draw into this frame's fresh source before temporal compositing. The
      // vertex shader derives the entire 98,304-point field from gl_VertexID.
      gl.useProgram(this.particles);
      const p = this.particleUniforms;
      gl.uniform2f(p.u_resolution,this.canvas.width,this.canvas.height);
      gl.uniform4f(p.u_motion,...directed.phases,directed.energy);
      gl.uniform4f(p.u_audio,directed.audio.level,directed.audio.low,directed.audio.mid,directed.audio.high);
    gl.uniform1fv(p.u_spectrum,directed.spectrum);
      gl.uniform1i(p.u_pattern,this.preset.pattern); gl.uniform1i(p.u_look,lookIndex);
      gl.uniform1i(p.u_part_colors, Number(partColors));
      gl.uniform1f(p.u_warp,clamp(settings.warp,0,2)); gl.uniform1f(p.u_opacity,1);
      for (let i = 0; i < 3; i++) gl.uniform3f(p[`u_color${i}` as 'u_color0'|'u_color1'|'u_color2'], ...this.colorValues[i]);
      // Source-over preserves authored colours without additive brightness growth.
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS,0,PARTICLE_COUNT);
      gl.disable(gl.BLEND);
    }

    if (lineScene) {
      gl.useProgram(this.lines);
      const l = this.lineUniforms;
      gl.uniform2f(l.u_resolution,this.canvas.width,this.canvas.height);
      gl.uniform4f(l.u_motion,...directed.phases,directed.energy);
      gl.uniform4f(l.u_audio,directed.audio.level,directed.audio.low,directed.audio.mid,directed.audio.high);
    gl.uniform1fv(l.u_spectrum,directed.spectrum);
      gl.uniform1i(l.u_pattern,this.preset.pattern); gl.uniform1i(l.u_look,lookIndex);
      gl.uniform1i(l.u_part_colors, Number(partColors));
      gl.uniform1f(l.u_warp,clamp(settings.warp,0,2));
      for (let i = 0; i < 3; i++) gl.uniform3f(l[`u_color${i}` as 'u_color0'|'u_color1'|'u_color2'], ...this.colorValues[i]);
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES,0,LINE_VERTEX_COUNT);
      gl.disable(gl.BLEND);
    }

    if (temporalScene) {
      // Apply time-normalised persistence once to the entire source, rather
      // than injecting a fixed particle opacity into history on every frame.
      gl.bindFramebuffer(gl.FRAMEBUFFER,write.framebuffer); gl.useProgram(this.particleHistory);
      this.bindTexture(0,cameraScene && dt === 0 && this.historyReady ? read.texture : this.composite.texture); this.bindTexture(1,read.texture);
      const h = this.particleHistoryUniforms;
      gl.uniform1i(h.u_source,0); gl.uniform1i(h.u_history,1);
      gl.uniform2f(h.u_resolution,this.canvas.width,this.canvas.height);
      gl.uniform1f(h.u_dt,dt); gl.uniform1f(h.u_trail,trail);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER,this.composite.framebuffer); gl.useProgram(this.blend);
    this.bindTexture(0,write.texture); this.bindTexture(1,this.outgoing.texture);
    gl.uniform1i(this.blendUniforms.u_current,0); gl.uniform1i(this.blendUniforms.u_previous,1);
    gl.uniform1f(this.blendUniforms.u_mix,this.transitionDuration > 0 ? this.transitionElapsed / this.transitionDuration : 1);
    gl.uniform2f(this.blendUniforms.u_resolution,this.canvas.width,this.canvas.height);
    gl.uniform1i(this.blendUniforms.u_look,lookIndex);
    gl.uniform3f(this.blendUniforms.u_background_treatment,...(BACKGROUND_TREATMENTS[this.preset.id] ?? BACKGROUND_TREATMENTS.flow));
    gl.drawArrays(gl.TRIANGLES,0,3);
    this.compositeContainsCamera = (cameraScene && this.cameraFilter?.hasFrame === true) ||
      (this.outgoingContainsCamera && this.transitionElapsed < this.transitionDuration);

    let cameraLiveTexture: WebGLTexture | null = null;
    if (liveRequested && this.cameraFilter?.hasFrame) {
      // The outgoing live tail remains duotone while an incoming camera
      // background may use halftone. Both filter passes reuse the one upload.
      cameraLiveTexture = this.renderLiveCamera({ ...cameraParams,filter: 'duotone' }, dt, clamp(settings.trail, 0, 1));
    } else if (dt > 0 || !this.cameraFilter?.hasFrame) { this.cameraLiveReady = false; }

    const foregroundTrail = clamp(settings.foregroundTrail ?? 0, 0, 1);
    let foregroundTexture: WebGLTexture | null = null;
    if (foregroundTrail > 0) foregroundTexture = this.renderForegroundHistory(elapsed, foregroundTrail);
    else this.foregroundHistoryReady = false;

    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.bindVertexArray(this.vao); gl.useProgram(this.display);
    this.bindTexture(0,this.composite.texture);
    const d=this.displayUniforms;
    gl.uniform1i(d.u_image,0); gl.uniform2f(d.u_resolution,this.canvas.width,this.canvas.height); gl.uniform1f(d.u_brightness,clamp(settings.brightness,0,2));
    gl.uniform1f(d.u_background_brightness,
      Number.isFinite(settings.backgroundBrightness) ? clamp(settings.backgroundBrightness!, 0, 3) : DEFAULT_BACKGROUND_BRIGHTNESS);
    // Texture units 1/2 belong to video/logo. Raw audio is reserved on unit 3.
    this.bindTexture(3,this.rawTexture); gl.uniform1i(d.u_raw,3);
    gl.uniform1f(d.u_time,this.foregroundClock);
    gl.uniform3f(d.u_bands,this.ringControls[0],this.ringControls[1],this.ringControls[2]);
    gl.uniform2f(d.u_voice,this.ringControls[3],this.ringControls[4]);
    this.bindTexture(5,foregroundTexture ?? this.composite.texture);
    gl.uniform1i(d.u_foreground_image,5); gl.uniform1i(d.u_foreground_active,Number(foregroundTexture !== null));
    gl.uniformMatrix3fv(d.u_camera_transform,false,this.cameraTransform.matrix);
    gl.uniform1i(d.u_camera_active,Number(this.cameraTransform.active));
    this.bindTexture(4,cameraLiveTexture ?? this.composite.texture);
    this.lastLiveWeight = cameraLiveTexture ? liveWeight : 0;
    gl.uniform1i(d.u_camera_image,4); gl.uniform1f(d.u_camera_opacity,this.lastLiveWeight * liveOpacity);
    for (let i = 0; i < 2; i++) {
      const layer=layers[i]; const entry=this.media[i];
      this.bindTexture(i+1,entry.texture);
      const layerUniform=i===0?d.u_layer0:d.u_layer1;
      const modeUniform=i===0?d.u_mode0:d.u_mode1;
      const positionUniform=i===0?d.u_position0:d.u_position1;
      const keyUniform=i===0?d.u_key0:d.u_key1;
      const softnessUniform=i===0?d.u_softness0:d.u_softness1;
      const anchorUniform=i===0?d.u_anchor0:d.u_anchor1;
      gl.uniform1i(i===0?d.u_media0:d.u_media1,i+1);
      if (layer && layer.width > 0 && layer.height > 0 && this.uploadMedia(entry,layer)) {
        gl.uniform4f(layerUniform,clamp(layer.opacity,0,1),clamp(layer.scale,.01,4),Number.isFinite(layer.rotation)?layer.rotation:0,layer.width/layer.height);
        gl.uniform2f(modeUniform,layer.blend==='screen'?1:layer.blend==='add'?2:layer.blend==='remove-white'?3:layer.blend==='remove-black'?4:0,layer.fit==='cover'?1:0);
        gl.uniform2f(positionUniform,Number.isFinite(layer.positionX)?clamp(layer.positionX!,-.5,.5):0,Number.isFinite(layer.positionY)?clamp(layer.positionY!,-.5,.5):0);
        gl.uniform1f(keyUniform,Number.isFinite(layer.keyThreshold)?clamp(layer.keyThreshold!,0,.5):.2);
        gl.uniform1f(softnessUniform,Number.isFinite(layer.keySoftness)?clamp(layer.keySoftness!,0,1):.25);
        gl.uniform2f(anchorUniform,Number.isFinite(layer.anchorX)?clamp(layer.anchorX!,0,1):.5,Number.isFinite(layer.anchorY)?clamp(layer.anchorY!,0,1):.5);
      } else { gl.uniform4f(layerUniform,0,1,0,1); gl.uniform2f(modeUniform,0,0); gl.uniform2f(positionUniform,0,0); gl.uniform1f(keyUniform,.2); gl.uniform1f(softnessUniform,.25); gl.uniform2f(anchorUniform,.5,.5); }
    }
    gl.drawArrays(gl.TRIANGLES,0,3);
    this.readIndex=writeIndex; this.hasFrame=true; this.historyReady=true;
  }

  clear(): void {
    if (this.disposed || this.gl.isContextLost()) return;
    this.clearHistory();
    const gl=this.gl; gl.clearColor(0,0,0,1);
    for(const target of [this.composite,this.outgoing]) if(target){gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);gl.clear(gl.COLOR_BUFFER_BIT);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clear(gl.COLOR_BUFFER_BIT);
    this.transitionDuration=0;this.transitionElapsed=0;this.hasFrame=false;
    this.cameraLiveReady=false;this.compositeContainsCamera=false;this.outgoingContainsCamera=false;
    this.foregroundHistoryReady=false;
    this.lastLiveWeight=0;this.outgoingLiveWeight=0;
  }

  dispose(): void {
    if(this.disposed)return;
    this.deleteTargets();
    this.cameraFilter?.dispose(); this.cameraFilter=null;
    for(const program of [this.flow,this.particles,this.particleHistory,this.lines,this.blend,this.display])this.gl.deleteProgram(program);
    if(this.foregroundHistoryProgram)this.gl.deleteProgram(this.foregroundHistoryProgram);
    for(const entry of this.media)this.gl.deleteTexture(entry.texture);
    this.gl.deleteTexture(this.rawTexture);
    this.media=[];this.gl.deleteVertexArray(this.vao);this.disposed=true;
  }

  private clearHistory(): void {
    this.historyReady = false;
    const gl=this.gl;gl.clearColor(0,0,0,1);
    if(this.targets)for(const target of this.targets){gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);gl.clear(gl.COLOR_BUFFER_BIT);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);this.readIndex=0;
  }
  private renderForegroundHistory(elapsed: number, trail: number): WebGLTexture {
    const gl = this.gl;
    if (!this.foregroundHistoryProgram) {
      this.foregroundHistoryProgram = this.createProgram(vertexSource, foregroundHistorySource, '線の残像');
      this.foregroundHistoryUniforms = this.getUniforms(this.foregroundHistoryProgram,
        ['u_raw','u_time','u_bands','u_voice','u_history','u_resolution','u_dt','u_trail']);
    }
    if (!this.foregroundHistory) {
      const allocated: Target[] = [];
      try { for (let i = 0; i < 2; i++) allocated.push(this.createTarget(this.canvas.width,this.canvas.height)); }
      catch (error) { for (const target of allocated) this.deleteTarget(target); throw error; }
      this.foregroundHistory = [allocated[0],allocated[1]];
      this.foregroundReadIndex = 0;
    }
    const read = this.foregroundHistory[this.foregroundReadIndex];
    // Paused colour, camera, brightness and trail adjustments hold the pixels.
    if (elapsed === 0 && this.foregroundHistoryReady) return read.texture;
    const writeIndex: 0 | 1 = this.foregroundReadIndex === 0 ? 1 : 0;
    const write = this.foregroundHistory[writeIndex], h = this.foregroundHistoryUniforms!;
    gl.bindFramebuffer(gl.FRAMEBUFFER,write.framebuffer); gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.bindVertexArray(this.vao); gl.useProgram(this.foregroundHistoryProgram);
    this.bindTexture(0,read.texture); this.bindTexture(1,this.rawTexture);
    gl.uniform1i(h.u_history,0); gl.uniform1i(h.u_raw,1);
    gl.uniform2f(h.u_resolution,this.canvas.width,this.canvas.height);
    gl.uniform1f(h.u_time,this.foregroundClock);
    gl.uniform3f(h.u_bands,this.ringControls[0],this.ringControls[1],this.ringControls[2]);
    gl.uniform2f(h.u_voice,this.ringControls[3],this.ringControls[4]);
    gl.uniform1f(h.u_dt,elapsed); gl.uniform1f(h.u_trail,this.foregroundHistoryReady ? trail : 0);
    gl.drawArrays(gl.TRIANGLES,0,3);
    this.foregroundReadIndex=writeIndex; this.foregroundHistoryReady=true;
    return write.texture;
  }
  private renderLiveCamera(params: CameraFilterParams, dt: number, trail: number): WebGLTexture {
    // The shared capture is already at most 720p. Keep the two live-only passes
    // at that budget, preserving output aspect, then linearly upsample at display.
    const scale = Math.min(1,1280 / this.canvas.width,720 / this.canvas.height);
    const width = Math.max(1,Math.round(this.canvas.width * scale));
    const height = Math.max(1,Math.round(this.canvas.height * scale));
    if (!this.cameraLiveHistory) {
      const allocated: Target[] = [];
      try { for (let i = 0; i < 2; i++) allocated.push(this.createTarget(width,height)); }
      catch (error) { for (const target of allocated) this.deleteTarget(target); throw error; }
      this.cameraLiveHistory = [allocated[0],allocated[1]];
      this.cameraLiveReadIndex = 0; this.cameraLiveReady = false;
    }
    const read = this.cameraLiveHistory[this.cameraLiveReadIndex];
    // A paused opacity/brightness redraw reuses the exact filtered trail pixels.
    if (dt === 0 && this.cameraLiveReady) return read.texture;
    const source = this.cameraFilter!.render({ ...params,width,height });
    const writeIndex: 0 | 1 = this.cameraLiveReadIndex === 0 ? 1 : 0;
    const write = this.cameraLiveHistory[writeIndex], gl = this.gl, h = this.particleHistoryUniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER,write.framebuffer); gl.bindVertexArray(this.vao); gl.useProgram(this.particleHistory);
    this.bindTexture(0,source); this.bindTexture(1,read.texture);
    gl.uniform1i(h.u_source,0); gl.uniform1i(h.u_history,1);
    gl.uniform2f(h.u_resolution,width,height);
    gl.uniform1f(h.u_dt,dt); gl.uniform1f(h.u_trail,this.cameraLiveReady ? trail : 0);
    gl.drawArrays(gl.TRIANGLES,0,3);
    this.cameraLiveReadIndex=writeIndex;this.cameraLiveReady=true;
    return write.texture;
  }
  private bindTexture(unit:number,texture:WebGLTexture):void {
    this.gl.activeTexture(this.gl.TEXTURE0+unit);this.gl.bindTexture(this.gl.TEXTURE_2D,texture);
  }
  private uploadMedia(entry:MediaTexture,layer:MediaLayerFrame):boolean {
    const gl=this.gl,source=layer.source;
    const isVideo=typeof HTMLVideoElement!=='undefined'&&source instanceof HTMLVideoElement;
    const hasFrame=entry.source===source&&entry.width===layer.width&&entry.height===layer.height;
    // Native looping briefly loses current data; retain only this source's texture.
    if(isVideo&&source.readyState<2)return hasFrame;
    // MediaLayers owns immutable raster canvases; new uploads always get a new source object.
    const isStatic=(typeof HTMLImageElement!=='undefined'&&source instanceof HTMLImageElement)||(typeof HTMLCanvasElement!=='undefined'&&source instanceof HTMLCanvasElement);
    const time=isVideo?source.currentTime:-1;
    if(hasFrame&&(isStatic||(isVideo&&entry.time===time)))return true;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    try {
      if(hasFrame)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
      else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      entry.source=source;entry.width=layer.width;entry.height=layer.height;entry.time=time;
      return true;
    } finally {gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);}
  }
  private textureParameters():void {
    const gl=this.gl;gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  private createTarget(width:number,height:number):Target {
    const gl=this.gl,texture=gl.createTexture(),framebuffer=gl.createFramebuffer();
    if(!texture||!framebuffer){if(texture)gl.deleteTexture(texture);if(framebuffer)gl.deleteFramebuffer(framebuffer);throw new Error('映像用メモリーを確保できません。画質を下げてください。');}
    gl.bindTexture(gl.TEXTURE_2D,texture);this.textureParameters();
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,null);
    if(!complete){gl.deleteTexture(texture);gl.deleteFramebuffer(framebuffer);throw new Error('映像の描画先を作成できません。画質を下げてください。');}
    return {texture,framebuffer};
  }
  private deleteTarget(target:Target):void {this.gl.deleteTexture(target.texture);this.gl.deleteFramebuffer(target.framebuffer);}
  private deleteTargets():void {
    if(this.targets)for(const target of this.targets)this.deleteTarget(target);
    if(this.composite)this.deleteTarget(this.composite);if(this.outgoing)this.deleteTarget(this.outgoing);
    this.targets=null;this.composite=null;this.outgoing=null;
    if(this.cameraLiveHistory)for(const target of this.cameraLiveHistory)this.deleteTarget(target);
    this.cameraLiveHistory=null;this.cameraLiveReady=false;
    if(this.foregroundHistory)for(const target of this.foregroundHistory)this.deleteTarget(target);
    this.foregroundHistory=null;this.foregroundHistoryReady=false;
  }
  private createProgram(vertex: string, fragment: string, label: string): WebGLProgram {
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error('描画プログラムを作成できません。');
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('シェーダーを作成できません。');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(`${label}シェーダーのコンパイルに失敗しました。\n${gl.getShaderInfoLog(shader) ?? ''}`);
        }
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`${label}シェーダーの接続に失敗しました。\n${gl.getProgramInfoLog(program) ?? ''}`);
      }
      return program;
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private getUniforms<T extends string>(program: WebGLProgram, names: T[]): Uniforms<T> {
    const result = {} as Uniforms<T>;
    for (const name of names) {
      const location = this.gl.getUniformLocation(program, name);
      if (location === null) throw new Error(`シェーダーの設定 ${name} が見つかりません。`);
      result[name] = location;
    }
    return result;
  }
}
