import type { PoseFrame, TrackingMode } from './pose';

export type CameraTrackerState = 'idle' | 'starting' | 'ready' | 'error';
type StatusListener = (state: CameraTrackerState, message: string) => void;

export interface TrackingCanvasFrame {
  source: HTMLCanvasElement;
  width: number;
  height: number;
  sequence: number;
  timestamp: number;
}

interface PendingFrame {
  timestamp: number;
  width: number;
  height: number;
  sent: boolean;
}

/** Recognizes a shared canvas locally; camera acquisition and ownership stay with its caller. */
export class CameraTracker {
  private currentState: CameraTrackerState = 'idle';
  private onStatus: StatusListener;
  private revision = 0;
  private disposed = false;
  private worker: Worker | null = null;
  private latest: PoseFrame | null = null;
  private pending: PendingFrame | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private cancelWait: (() => void) | null = null;
  private lastSequence: number | null = null;
  private lastTimestamp = -Infinity;
  private lastSubmission = -Infinity;

  constructor(onStatus: StatusListener = () => {}) { this.onStatus = onStatus; }
  get state(): CameraTrackerState { return this.currentState; }
  get active(): boolean { return this.state === 'ready' && this.worker !== null; }

  /** Initializes only recognition. Camera permission and playback are managed elsewhere. */
  async start(mode: TrackingMode): Promise<void> {
    if (this.disposed) return;
    const ticket = ++this.revision;
    this.release();
    if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
      this.emit('error', 'この環境では動きの追跡を利用できません。MacのChromeでlocalhostから開いてください。');
      return;
    }
    this.emit('starting', '動きの追跡を準備しています。');
    if (ticket !== this.revision) return;
    try {
      await this.startWorker(ticket, mode);
      if (ticket !== this.revision) return;
      this.emit('ready', mode === 'face' ? '顔の動きを追跡しています。' : '肩・上半身の動きを追跡しています。');
    } catch {
      if (ticket === this.revision) this.fail('動きの追跡を開始できませんでした。もう一度開始してください。');
    }
  }

  stop(): void {
    ++this.revision;
    this.release();
    this.emit('idle', '動きの追跡は停止しています。');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  sample(nowMs = performance.now()): PoseFrame | null {
    if (!this.active || !this.latest || !Number.isFinite(nowMs)) return null;
    const age = nowMs - this.latest.timestamp;
    return age >= 0 && age <= 500 ? this.latest : null;
  }

  /** Skips busy, duplicate or excess frames; never queues or mutates the shared source. */
  async submit(frame: TrackingCanvasFrame): Promise<void> {
    if (!this.active || this.pending || document.hidden ||
        !Number.isFinite(frame.width) || frame.width <= 0 || !Number.isFinite(frame.height) || frame.height <= 0 ||
        !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.sequence === this.lastSequence ||
        !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp <= this.lastTimestamp) return;
    const now = performance.now();
    if (!Number.isFinite(now) || now - this.lastSubmission < 1000 / 15) return;
    const ticket = this.revision;
    const worker = this.worker!;
    const scale = Math.min(1, 640 / Math.max(frame.width, frame.height));
    const request: PendingFrame = {
      timestamp: frame.timestamp,
      width: Math.max(1, Math.round(frame.width * scale)),
      height: Math.max(1, Math.round(frame.height * scale)),
      sent: false,
    };
    this.pending = request;
    this.lastSequence = frame.sequence;
    this.lastTimestamp = frame.timestamp;
    this.lastSubmission = now;
    // Bound snapshot creation as well as inference; a stuck snapshot must not block forever.
    this.watchdog = setTimeout(() => {
      if (ticket === this.revision && this.pending === request) this.fail('動きの追跡から応答がありません。もう一度開始してください。');
    }, 5000);
    try {
      const bitmap = await createImageBitmap(frame.source, { resizeWidth: request.width, resizeHeight: request.height });
      if (ticket !== this.revision || worker !== this.worker || this.pending !== request) { bitmap.close(); return; }
      request.sent = true;
      try { worker.postMessage({ type: 'frame', bitmap, timestamp: request.timestamp }, [bitmap]); }
      catch (error) { bitmap.close(); throw error; }
    } catch {
      if (ticket === this.revision) this.fail('動きの追跡用の映像を読み取れませんでした。もう一度開始してください。');
    }
  }

  private startWorker(ticket: number, mode: TrackingMode): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('camera-worker.js', document.baseURI));
      this.worker = worker;
      let ready = false;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Tracking initialization timeout')), 30000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelWait === cancel) this.cancelWait = null;
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error('Tracking initialization cancelled'));
      this.cancelWait = cancel;
      const failure = () => {
        if (ticket !== this.revision) return;
        if (!ready) finish(new Error('Tracking worker failed'));
        else this.fail('動きの追跡が停止しました。もう一度開始してください。');
      };
      worker.onerror = failure;
      worker.onmessageerror = failure;
      worker.onmessage = event => {
        if (ticket !== this.revision || worker !== this.worker || !event.data || typeof event.data !== 'object') return;
        const data = event.data as Partial<PoseFrame> & { type?: string };
        if (data.type === 'ready') {
          if (!settled) { ready = true; finish(); }
        } else if (data.type === 'error') failure();
        else if (data.type === 'result') {
          const request = this.pending;
          if (!ready || !request?.sent || data.timestamp !== request.timestamp || (data.mode !== undefined && data.mode !== mode)) return;
          this.clearPending();
          this.latest = Array.isArray(data.landmarks) && data.landmarks.length > 0 && data.width === request.width && data.height === request.height
            ? { landmarks: data.landmarks, width: request.width, height: request.height, timestamp: request.timestamp, mode, ...(mode === 'face' ? { matrix: data.matrix } : {}) }
            : null;
        }
      };
      try { worker.postMessage({ type: 'init', mode }); }
      catch { finish(new Error('Tracking initialization failed')); }
    });
  }

  private fail(message: string): void { ++this.revision; this.release(); this.emit('error', message); }
  private emit(state: CameraTrackerState, message: string): void { this.currentState = state; this.onStatus(state, message); }
  private clearPending(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.pending = null;
  }
  private release(): void {
    this.cancelWait?.(); this.cancelWait = null;
    this.clearPending();
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.latest = null;
    this.lastSequence = null;
    this.lastTimestamp = -Infinity;
    this.lastSubmission = -Infinity;
  }
}
