import type { PoseFrame, TrackingMode } from './pose';
import { SharedCameraSource, type SharedCameraFrame, type SharedCameraSelection, type SharedCameraState, type SharedCameraStatusListener } from './shared-camera.ts';
import { CameraTracker, type CameraTrackerState } from './camera-tracker.ts';
export type { TrackingMode } from './pose';
export type CameraState = SharedCameraState;

/** Coordinates the single input and recognition without coupling their failure or lifetime. */
export class CameraInput {
  private readonly source: SharedCameraSource;
  private readonly tracker: CameraTracker;
  private mode: TrackingMode = 'body';
  private trackingStart: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(video: HTMLVideoElement, onStatus: SharedCameraStatusListener = () => {},
    onTrackingStatus: (state: CameraTrackerState, message: string) => void = () => {}) {
    this.tracker = new CameraTracker(onTrackingStatus);
    this.source = new SharedCameraSource(video, (state, message) => {
      if (state === 'running') this.trackingStart = this.tracker.start(this.mode);
      else this.tracker.stop();
      onStatus(state, message);
    });
  }
  get state(): CameraState { return this.source.state; }
  get active(): boolean { return this.source.active; }
  get trackingState(): CameraTrackerState { return this.tracker.state; }
  get resolvedSelection(): SharedCameraSelection | null { return this.source.resolvedSelection; }
  devices(): Promise<MediaDeviceInfo[]> { return this.source.devices(); }

  async start(selection?: string | SharedCameraSelection, mode: TrackingMode = 'body'): Promise<void> {
    if (this.disposed) return;
    this.mode = mode;
    await this.source.start(typeof selection === 'string' ? { deviceId: selection, label: '' } : selection);
    await this.trackingStart;
  }
  async setTrackingMode(mode: TrackingMode): Promise<void> {
    if (this.disposed) return;
    this.mode = mode;
    if (this.active) { this.trackingStart = this.tracker.start(mode); await this.trackingStart; }
  }
  captureFrame(nowMs = performance.now()): SharedCameraFrame | null { return this.source.captureFrame(nowMs); }
  submit(frame: SharedCameraFrame): void { void this.tracker.submit(frame); }
  sample(nowMs = performance.now()): PoseFrame | null { return this.tracker.sample(nowMs); }
  stop(): void { this.source.stop(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.dispose();
    this.tracker.dispose();
  }
}
