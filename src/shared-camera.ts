export type SharedCameraSelection = { deviceId: string; label: string };
export type SharedCameraState = 'idle' | 'starting' | 'running' | 'reconnecting' | 'error';
export type SharedCameraStatusListener = (state: SharedCameraState, message: string) => void;
export type SharedCameraFrame = {
  /** A shared mutable canvas: consume/copy it synchronously; deduplicate with sequence. */
  source: HTMLCanvasElement;
  width: number;
  height: number;
  sequence: number;
  /** Capture time on the performance.now() clock, in milliseconds. */
  timestamp: number;
};

function errorName(error: unknown): string { return error instanceof Error ? error.name : ''; }
function permissionError(error: unknown): boolean { return ['NotAllowedError', 'SecurityError'].includes(errorName(error)); }
function deviceMissing(error: unknown): boolean { return ['NotFoundError', 'OverconstrainedError'].includes(errorName(error)); }
function missingCamera(): DOMException { return new DOMException('Selected camera is unavailable', 'NotFoundError'); }

/** Owns one local video stream, independently of recognition, recording or network APIs. */
export class SharedCameraSource {
  private video: HTMLVideoElement;
  private currentState: SharedCameraState = 'idle';
  private message = 'カメラは停止しています。';
  private listeners = new Set<SharedCameraStatusListener>();
  private desired = false;
  private disposed = false;
  private revision = 0;
  private acquiring: number | null = null;
  private stream: MediaStream | null = null;
  private selection: SharedCameraSelection | undefined;
  private resolved: SharedCameraSelection | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private frameWatchdog: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private permissionBlocked = false;
  private permission: PermissionStatus | null = null;
  private mediaDevices: MediaDevices | undefined;
  private cancelPlayback: (() => void) | null = null;
  private trackListeners: Array<() => void> = [];
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private frameCallback: number | null = null;
  private decodedFrame: number | null = null;
  private capturedFrame: number | null = null;
  private latest: SharedCameraFrame | null = null;
  private sequence = 0;

  constructor(video: HTMLVideoElement, onStatus?: SharedCameraStatusListener) {
    this.video = video;
    if (onStatus) this.listeners.add(onStatus);
    this.mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    this.mediaDevices?.addEventListener('devicechange', this.onDeviceChange);
    void this.observePermission();
  }

  get state(): SharedCameraState { return this.currentState; }
  get active(): boolean {
    return this.state === 'running' && this.stream?.getVideoTracks().some(track => track.readyState === 'live') === true;
  }
  get resolvedSelection(): SharedCameraSelection | null { return this.resolved ? { ...this.resolved } : null; }

  subscribe(listener: SharedCameraStatusListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state, this.message);
    return () => { this.listeners.delete(listener); };
  }

  async devices(): Promise<MediaDeviceInfo[]> {
    try { return (await this.mediaDevices?.enumerateDevices() ?? []).filter(device => device.kind === 'videoinput'); }
    catch { return []; }
  }

  /** Call only for a user start/selection action. Errors are reported through status. */
  async start(selection?: SharedCameraSelection): Promise<void> {
    if (this.disposed) return;
    ++this.revision;
    this.release();
    this.desired = true;
    this.permissionBlocked = false;
    this.retryCount = 0;
    this.resolved = null;
    this.selection = selection && (selection.deviceId || selection.label) ? { ...selection } : undefined;
    await this.connect(false);
  }

  stop(): void {
    this.desired = false;
    ++this.revision;
    this.acquiring = null;
    this.release();
    this.emit('idle', 'カメラは停止しています。');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.permission?.removeEventListener('change', this.onPermissionChange);
    this.permission = null;
    this.listeners.clear();
    this.canvas = null;
    this.context = null;
  }

  /** Draw at most once for each decoded frame, at a maximum of 1280 × 720 (or portrait). */
  captureFrame(nowMs = performance.now()): SharedCameraFrame | null {
    if (!this.active || !Number.isFinite(nowMs) || this.video.readyState < 2) return null;
    const sourceWidth = this.video.videoWidth, sourceHeight = this.video.videoHeight;
    if (!(sourceWidth > 0 && sourceHeight > 0) || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null;
    let frame = this.decodedFrame;
    if (typeof this.video.requestVideoFrameCallback !== 'function') {
      const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames;
      frame = Number.isFinite(frames) ? frames! : this.video.currentTime;
    }
    if (frame === null || !Number.isFinite(frame)) return this.latest;
    if (frame === this.capturedFrame) return this.latest;
    const portrait = sourceHeight > sourceWidth;
    const scale = Math.min(1, (portrait ? 720 : 1280) / sourceWidth, (portrait ? 1280 : 720) / sourceHeight);
    const width = Math.max(1, Math.floor(sourceWidth * scale));
    const height = Math.max(1, Math.floor(sourceHeight * scale));
    this.canvas ??= document.createElement('canvas');
    this.context ??= this.canvas.getContext('2d', { alpha: false });
    if (!this.context) return null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    try { this.context.drawImage(this.video, 0, 0, width, height); }
    catch { return null; }
    this.capturedFrame = frame;
    this.latest = { source: this.canvas, width, height, sequence: ++this.sequence, timestamp: nowMs };
    return this.latest;
  }

  private current(ticket: number): boolean { return this.desired && !this.disposed && ticket === this.revision; }

  private async connect(reconnecting: boolean): Promise<void> {
    if (!this.desired || this.disposed || this.permissionBlocked) return;
    const ticket = ++this.revision;
    this.acquiring = ticket;
    this.clearRetry();
    if (!this.mediaDevices?.getUserMedia) {
      this.acquiring = null;
      this.emit('error', 'この環境ではカメラを利用できません。Chromeでlocalhostから開いてください。');
      return;
    }
    this.emit(reconnecting ? 'reconnecting' : 'starting', reconnecting ? '選んだカメラへの再接続を待っています。' : 'カメラの使用許可を待っています。');
    if (!this.current(ticket)) return;
    try {
      const stream = await this.acquire(ticket);
      if (!this.current(ticket)) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const tracks = stream.getVideoTracks();
      if (!tracks.some(track => track.readyState === 'live')) throw missingCamera();
      for (const track of tracks) {
        const ended = () => { if (this.current(ticket)) this.disconnected(); };
        const availability = () => { if (this.current(ticket)) this.watchForStall(ticket); };
        track.addEventListener('ended', ended);
        track.addEventListener('mute', availability);
        track.addEventListener('unmute', availability);
        this.trackListeners.push(() => {
          track.removeEventListener('ended', ended);
          track.removeEventListener('mute', availability);
          track.removeEventListener('unmute', availability);
        });
      }
      const track = tracks[0];
      const id = track.getSettings().deviceId || this.selection?.deviceId || '';
      const listed = (await this.devices()).find(device => device.deviceId === id);
      if (!this.current(ticket)) return;
      this.resolved = { deviceId: id, label: track.label || listed?.label || this.selection?.label || '' };
      // A default acquisition becomes a specific identity before any reconnect.
      this.selection = { ...this.resolved };
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      await this.waitForPlayback();
      if (!this.current(ticket)) return;
      this.retryCount = 0;
      this.watchFrames(ticket);
      this.emit('running', 'カメラ映像を共有しています。');
    } catch (error) {
      if (!this.current(ticket)) return;
      this.release();
      if (permissionError(error)) {
        this.permissionBlocked = true;
        this.emit('error', 'カメラの使用が許可されていません。ChromeとMacのカメラ権限を確認してください。');
      } else {
        this.emit('reconnecting', deviceMissing(error) ? '選んだカメラが見つかりません。再接続を待っています。' : 'カメラを使用できません。再接続を待っています。');
        this.scheduleReconnect();
      }
    } finally { if (this.acquiring === ticket) this.acquiring = null; }
  }

  private async acquire(ticket: number): Promise<MediaStream> {
    const selection = this.selection;
    if (!selection) return this.requestStream();
    if (selection.deviceId) {
      try { return await this.requestStream(selection.deviceId); }
      catch (error) { if (!deviceMissing(error) || !this.current(ticket)) throw error; }
    }
    // Names must match exactly and unambiguously; never fall through to the default camera.
    const matches = selection.label ? (await this.devices()).filter(device => device.label === selection.label && device.deviceId !== selection.deviceId) : [];
    if (!this.current(ticket) || matches.length !== 1 || !matches[0].deviceId) throw missingCamera();
    return this.requestStream(matches[0].deviceId);
  }

  private requestStream(deviceId?: string): Promise<MediaStream> {
    return this.mediaDevices!.getUserMedia({ audio: false, video: {
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    } });
  }

  private waitForPlayback(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelPlayback === cancel) this.cancelPlayback = null;
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error('Camera playback cancelled'));
      const timeout = setTimeout(() => finish(new Error('Camera playback timeout')), 15000);
      this.cancelPlayback = cancel;
      this.video.play().then(() => finish(), error => finish(error));
    });
  }

  private watchFrames(ticket: number): void {
    this.watchForStall(ticket);
    if (typeof this.video.requestVideoFrameCallback !== 'function') return;
    const next: VideoFrameRequestCallback = (_now, metadata) => {
      if (!this.current(ticket)) return;
      if (metadata.presentedFrames !== this.decodedFrame && !this.stream?.getVideoTracks().some(track => track.muted)) this.watchForStall(ticket);
      this.decodedFrame = metadata.presentedFrames;
      this.frameCallback = this.video.requestVideoFrameCallback(next);
    };
    this.frameCallback = this.video.requestVideoFrameCallback(next);
  }

  private watchForStall(ticket: number): void {
    if (this.frameWatchdog !== null) clearTimeout(this.frameWatchdog);
    const muted = this.stream?.getVideoTracks().some(track => track.muted);
    const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? this.video.currentTime;
    this.frameWatchdog = setTimeout(() => {
      this.frameWatchdog = null;
      if (!this.current(ticket)) return;
      // A background tab can delay callbacks while decoding continues. Check decoding
      // progress before treating that callback delay as a disconnected camera.
      const currentFrames = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? this.video.currentTime;
      if (!this.stream?.getVideoTracks().some(track => track.muted) &&
        Number.isFinite(currentFrames) && currentFrames !== frames) {
        this.watchForStall(ticket);
      } else {
        this.disconnected();
      }
    }, muted ? 1500 : 4000);
  }

  private disconnected(): void {
    if (!this.desired || this.disposed) return;
    ++this.revision;
    this.acquiring = null;
    this.release();
    this.emit('reconnecting', 'カメラとの接続が切れました。同じカメラへの再接続を待っています。');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.desired || this.disposed || this.permissionBlocked || this.retry !== null) return;
    const ticket = this.revision;
    const delay = Math.min(8000, 500 * 2 ** Math.min(this.retryCount++, 4));
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.current(ticket) && this.acquiring === null) void this.connect(true);
    }, delay);
  }

  private onDeviceChange = (): void => {
    if (!this.desired || this.disposed || this.permissionBlocked || this.acquiring !== null) return;
    if (!this.active) { void this.connect(true); return; }
    const ticket = this.revision;
    void this.devices().then(devices => {
      if (this.current(ticket) && this.resolved?.deviceId && !devices.some(device => device.deviceId === this.resolved!.deviceId)) this.disconnected();
    });
  };

  private async observePermission(): Promise<void> {
    try {
      if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
      const permission = await navigator.permissions.query({ name: 'camera' as PermissionName });
      if (this.disposed) return;
      this.permission = permission;
      permission.addEventListener('change', this.onPermissionChange);
    } catch { /* Browsers without camera permission observation still support explicit retries. */ }
  }

  private onPermissionChange = (): void => {
    if (!this.desired || this.disposed) return;
    if (this.permission?.state === 'denied') {
      ++this.revision;
      this.acquiring = null;
      this.permissionBlocked = true;
      this.release();
      this.emit('error', 'カメラの使用許可が取り消されました。ChromeとMacのカメラ権限を確認してください。');
    } else if (this.permission?.state === 'granted' && this.permissionBlocked) {
      this.permissionBlocked = false;
      this.retryCount = 0;
      void this.connect(true);
    }
  };

  private clearRetry(): void { if (this.retry !== null) clearTimeout(this.retry); this.retry = null; }
  private release(): void {
    this.clearRetry();
    if (this.frameWatchdog !== null) clearTimeout(this.frameWatchdog);
    this.frameWatchdog = null;
    this.cancelPlayback?.(); this.cancelPlayback = null;
    for (const remove of this.trackListeners) remove();
    this.trackListeners = [];
    if (this.frameCallback !== null) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.pause(); this.video.srcObject = null;
    this.latest = null; this.decodedFrame = null; this.capturedFrame = null;
  }
  private emit(state: SharedCameraState, message: string): void {
    this.currentState = state; this.message = message;
    for (const listener of this.listeners) listener(state, message);
  }
}
