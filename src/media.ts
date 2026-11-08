import type { MediaLayerFrame } from './renderer';
import { MAX_MEDIA_FILE_SIZE, mediaFileKind } from './media-folder-contract.ts';
import { findMediaContentCenter } from './media-placement.ts';

export type LayerKind = 'logo' | 'video';
export type LayerBlend = 'normal' | 'screen' | 'add' | 'remove-white' | 'remove-black';
export type LayerSettings = {
  visible: boolean;
  opacity: number;
  scale: number;
  /** Fractions of output width/height; positive values move right/down. */
  positionX: number;
  positionY: number;
  keyThreshold: number;
  keySoftness: number;
  /** Source-space pivot, measured from the top left; persists after auto-centering. */
  anchorX: number;
  anchorY: number;
  /** Revolutions per minute; a negative value reverses direction. */
  rotationSpeed: number;
  /** Video only; elapsed media time per wall-clock second. */
  playbackRate?: number;
  audioReact: boolean;
  blend: LayerBlend;
};

type ChangeListener = (kind: LayerKind, message: string, error?: boolean) => void;
type LoadedLayer = {
  source: HTMLCanvasElement | HTMLVideoElement;
  name: string;
  width: number;
  height: number;
  angle: number;
  objectUrl: string | null;
  playPending: boolean;
  playFailed: boolean;
  playRevision: number;
};

const LOAD_TIMEOUT = 20_000;
const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number, fallback = min): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function validateFile(kind: LayerKind, file: File): void {
  if (!file.size) throw new Error('空のファイルは読み込めません。別の素材を選んでください。');
  if (file.size > MAX_MEDIA_FILE_SIZE) throw new Error('素材は200MB以下にしてください。動画は短くするか、解像度を下げてください。');
  const typeMatches = !file.type || file.type.startsWith(kind === 'logo' ? 'image/' : 'video/');
  if (mediaFileKind(file.name) !== kind || !typeMatches) {
    throw new Error(kind === 'logo'
      ? 'PNG・JPEG・WebP・GIF・SVGの画像を選んでください。'
      : 'MP4・WebMの動画を選んでください。再生できる形式はブラウザによって異なります。');
  }
}

/** Install all listeners before assigning src, and always remove them on settlement. */
function waitForImage(image: HTMLImageElement, url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const loaded = () => image.naturalWidth > 0 && image.naturalHeight > 0
      ? finish() : finish(new Error('画像のサイズを読み取れません。別の画像を選んでください。'));
    const failed = () => finish(new Error('この画像を読み込めません。PNGやJPEGに変換して試してください。'));
    const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = window.setTimeout(() => finish(new Error('画像の読み込みがタイムアウトしました。小さい画像で試してください。')), LOAD_TIMEOUT);
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else image.src = url;
  });
}

function waitForVideo(video: HTMLVideoElement, url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const loaded = () => video.videoWidth > 0 && video.videoHeight > 0
      ? finish() : finish(new Error('動画の映像を読み取れません。映像トラックのある動画を選んでください。'));
    const failed = () => finish(new Error('この動画を再生できません。H.264のMP4かWebMへ変換して試してください。'));
    const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = window.setTimeout(() => finish(new Error('動画の読み込みがタイムアウトしました。短い動画や低い解像度で試してください。')), LOAD_TIMEOUT);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else { video.src = url; video.load(); }
  });
}

/** Local media only. Nothing is uploaded, recorded, or connected to an audio output. */
export class MediaLayers {
  readonly settings: Record<LayerKind, LayerSettings> = {
    logo: { visible: true, opacity: 1, scale: 0.35, positionX: 0, positionY: 0, keyThreshold: .2, keySoftness: .25, anchorX: .5, anchorY: .5, rotationSpeed: 2, audioReact: false, blend: 'normal' },
    video: { visible: true, opacity: 0.55, scale: 1, positionX: 0, positionY: 0, keyThreshold: .2, keySoftness: .25, anchorX: .5, anchorY: .5, rotationSpeed: 0, playbackRate: 1, audioReact: false, blend: 'screen' },
  };
  private readonly layers: Record<LayerKind, LoadedLayer | null> = { logo: null, video: null };
  private readonly pending: Record<LayerKind, AbortController | null> = { logo: null, video: null };
  private readonly revision: Record<LayerKind, number> = { logo: 0, video: 0 };
  private readonly onChange: ChangeListener;
  private disposed = false;
  private paused = false;

  constructor(onChange: ChangeListener = () => {}) { this.onChange = onChange; }

  name(kind: LayerKind): string { return this.layers[kind]?.name ?? ''; }
  has(kind: LayerKind): boolean { return this.layers[kind] !== null; }

  /** Stop an in-flight replacement while retaining the layer already on screen. */
  cancelPending(kind: LayerKind): void {
    ++this.revision[kind];
    this.pending[kind]?.abort();
    this.pending[kind] = null;
  }

  async load(kind: LayerKind, file: File): Promise<boolean> {
    if (this.disposed) return false;
    this.cancelPending(kind);
    const ticket = this.revision[kind];
    const controller = new AbortController();
    this.pending[kind] = controller;
    let url: string | null = null;
    let loaded: LoadedLayer | null = null;
    let source: HTMLImageElement | HTMLVideoElement | null = null;
    try {
      validateFile(kind, file);
      this.onChange(kind, '素材を読み込んでいます…');
      url = URL.createObjectURL(file);
      if (kind === 'logo') {
        const image = new Image();
        source = image;
        await waitForImage(image, url, controller.signal);
        const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('画像のメモリーを確保できません。小さい画像で試してください。');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.src = '';
        URL.revokeObjectURL(url);
        url = null;
        loaded = { source: canvas, name: file.name, width: canvas.width, height: canvas.height, angle: 0, objectUrl: null, playPending: false, playFailed: false, playRevision: 0 };
      } else {
        const video = document.createElement('video');
        source = video;
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.defaultPlaybackRate = video.playbackRate = clamp(this.settings.video.playbackRate ?? 1, .25, 4, 1);
        await waitForVideo(video, url, controller.signal);
        loaded = { source: video, name: file.name, width: video.videoWidth, height: video.videoHeight, angle: 0, objectUrl: url, playPending: false, playFailed: false, playRevision: 0 };
      }
      if (this.disposed || ticket !== this.revision[kind]) {
        this.release(loaded);
        loaded = null;
        return false;
      }
      this.release(this.layers[kind]);
      this.layers[kind] = loaded;
      this.settings[kind].visible = true;
      this.settings[kind].anchorX = this.settings[kind].anchorY = .5;
      this.onChange(kind, file.name);
      if (kind === 'video' && !this.paused) this.play(loaded);
      return true;
    } catch (error) {
      if (loaded) this.release(loaded);
      else {
        if (source instanceof HTMLVideoElement) { source.pause(); source.removeAttribute('src'); source.load(); }
        else if (source instanceof HTMLImageElement) source.src = '';
        if (url) URL.revokeObjectURL(url);
      }
      if (!this.disposed && ticket === this.revision[kind] && !controller.signal.aborted) {
        this.onChange(kind, error instanceof Error ? error.message : '素材を読み込めませんでした。別のファイルを選んでください。', true);
      }
      return false;
    } finally {
      if (this.pending[kind] === controller) this.pending[kind] = null;
    }
  }

  async loadSampleLogo(): Promise<void> {
    if (this.disposed) return;
    this.cancelPending('logo');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d');
    if (!context) { this.onChange('logo', 'サンプルロゴを作成できませんでした。', true); return; }
    context.strokeStyle = '#ffffff';
    context.lineWidth = 20;
    context.beginPath(); context.arc(512, 512, 404, 0, TAU); context.stroke();
    context.lineWidth = 5;
    context.beginPath(); context.arc(512, 512, 440, 0, TAU); context.stroke();
    context.fillStyle = '#ffffff';
    context.font = 'bold 330px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('VJ', 512, 525);
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * TAU;
      context.beginPath();
      context.arc(512 + Math.cos(angle) * 355, 512 + Math.sin(angle) * 355, 8, 0, TAU);
      context.fill();
    }
    this.release(this.layers.logo);
    this.layers.logo = { source: canvas, name: 'サンプルロゴ', width: 1024, height: 1024, angle: 0, objectUrl: null, playPending: false, playFailed: false, playRevision: 0 };
    this.settings.logo.visible = true;
    this.settings.logo.anchorX = this.settings.logo.anchorY = .5;
    if (this.settings.logo.blend.startsWith('remove-')) this.settings.logo.blend = 'normal';
    this.onChange('logo', 'サンプルロゴ');
  }

  remove(kind: LayerKind): void {
    this.cancelPending(kind);
    this.release(this.layers[kind]);
    this.layers[kind] = null;
    if (!this.disposed) this.onChange(kind, kind === 'logo' ? 'ロゴ・画像は未設定です。' : '動画は未設定です。');
  }

  /** Align the visible content in the current frame; never scan on the render loop. */
  alignCenter(kind: LayerKind): boolean {
    const layer = this.layers[kind];
    if (!layer) return false;
    const canvas = document.createElement('canvas');
    const factor = Math.min(1, 256 / Math.max(layer.width, layer.height));
    canvas.width = Math.max(1, Math.round(layer.width * factor));
    canvas.height = Math.max(1, Math.round(layer.height * factor));
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(layer.source, 0, 0, canvas.width, canvas.height);
      const setting = this.settings[kind];
      const center = findMediaContentCenter(context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width, canvas.height, setting.blend, setting.keyThreshold, setting.keySoftness);
      if (!center) return false;
      Object.assign(setting, { anchorX: center.x, anchorY: center.y, positionX: 0, positionY: 0 });
      return true;
    } catch { return false; }
    finally { canvas.width = canvas.height = 1; }
  }

  frames(dtSeconds: number, audioLevel: number, paused: boolean): MediaLayerFrame[] {
    if (this.disposed) return [];
    this.paused = paused;
    // Rotation is specified in rpm, so slow frames must still advance real elapsed time.
    const dt = paused || !Number.isFinite(dtSeconds) ? 0 : Math.max(0, dtSeconds);
    const frames: MediaLayerFrame[] = [];
    for (const kind of ['video', 'logo'] as const) {
      const layer = this.layers[kind];
      if (!layer) continue;
      const setting = this.settings[kind];
      if (layer.source instanceof HTMLVideoElement) {
        const rate = clamp(setting.playbackRate ?? 1, .25, 4, 1);
        if (layer.source.playbackRate !== rate) layer.source.playbackRate = rate;
        if (paused || !setting.visible) {
          if (!layer.source.paused || layer.playPending) {
            ++layer.playRevision;
            layer.source.pause();
            layer.playPending = false;
          }
          // A later intentional resume can retry a policy-blocked play request.
          layer.playFailed = false;
        } else if (layer.source.paused && !layer.playPending && !layer.playFailed) this.play(layer);
        // Keep the layer in its slot while a loop seek waits for decoded data.
        // The renderer can retain this video's last uploaded frame.
      }
      if (!setting.visible) continue;
      layer.angle = (layer.angle + dt * clamp(setting.rotationSpeed, -30, 30, 0) * TAU / 60) % TAU;
      const pulse = setting.audioReact ? 1 + clamp(audioLevel, 0, 1) * 0.18 : 1;
      frames.push({
        source: layer.source,
        width: layer.width,
        height: layer.height,
        opacity: clamp(setting.opacity, 0, 1),
        scale: clamp(setting.scale, 0.05, 3, kind === 'logo' ? 0.35 : 1) * pulse,
        positionX: clamp(setting.positionX, -.5, .5, 0),
        positionY: clamp(setting.positionY, -.5, .5, 0),
        keyThreshold: clamp(setting.keyThreshold, 0, .5, .2),
        keySoftness: clamp(setting.keySoftness, 0, 1, .25),
        anchorX: clamp(setting.anchorX, 0, 1, .5),
        anchorY: clamp(setting.anchorY, 0, 1, .5),
        rotation: layer.angle,
        blend: ['normal', 'screen', 'add', 'remove-white', 'remove-black'].includes(setting.blend) ? setting.blend : 'normal',
        fit: kind === 'video' ? 'cover' : 'contain',
      });
    }
    return frames;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remove('video');
    this.remove('logo');
  }

  private play(layer: LoadedLayer): void {
    if (!(layer.source instanceof HTMLVideoElement) || layer.playPending) return;
    layer.playPending = true;
    const ticket = ++layer.playRevision;
    void layer.source.play().catch((error: unknown) => {
      if (this.layers.video !== layer || this.disposed || ticket !== layer.playRevision) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // A user pause can interrupt an in-flight play without being a playback failure.
      if (this.paused || !this.settings.video.visible) return;
      layer.playFailed = true;
      this.onChange('video', '動画を再生できませんでした。一時停止して再開するか、別の動画を選んでください。', true);
    }).finally(() => { if (ticket === layer.playRevision) layer.playPending = false; });
  }

  private release(layer: LoadedLayer | null): void {
    if (!layer) return;
    ++layer.playRevision;
    layer.playPending = false;
    if (layer.source instanceof HTMLVideoElement) {
      layer.source.pause();
      layer.source.removeAttribute('src');
      layer.source.load();
    } else {
      layer.source.width = layer.source.height = 1;
    }
    if (layer.objectUrl) URL.revokeObjectURL(layer.objectUrl);
  }
}
