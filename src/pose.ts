export interface PoseLandmark { x: number; y: number; z?: number; visibility?: number }
export type TrackingMode = 'body' | 'face';
export interface FaceMatrix { rows: number; columns: number; data: number[] }
export interface PoseFrame {
  landmarks: PoseLandmark[];
  width: number;
  height: number;
  timestamp: number;
  /** Omitted only by legacy body callers. Face landmarks have a different topology. */
  mode?: TrackingMode;
  matrix?: FaceMatrix | null;
}
const radians = (degrees: number) => degrees * Math.PI / 180;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Clockwise in the unmirrored image; shoulder landmarks work above a DJ desk. */
export function shoulderTilt(frame: PoseFrame | null): number | null {
  if (!frame || frame.mode === 'face' || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) return null;
  const a = frame.landmarks[11]; const b = frame.landmarks[12];
  for (const point of [a, b]) {
    if (!point || !Number.isFinite(point.visibility) || point.visibility! < .65 ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  }
  const left = a.x < b.x ? a : b; const right = a.x < b.x ? b : a;
  const dx = (right.x - left.x) * frame.width;
  if (dx < Math.max(12, frame.width * .035)) return null;
  const angle = Math.atan2((right.y - left.y) * frame.height, dx);
  return Math.abs(angle) <= radians(60) ? angle : null;
}

export class TiltController {
  private value = 0;
  private neutral = 0;
  get angle(): number { return this.value; }

  update(raw: number | null, dt: number, options: { mirrored?: boolean; sensitivity?: number } = {}): number {
    if (!Number.isFinite(dt) || dt <= 0) return this.value;
    const tracked = raw !== null && Number.isFinite(raw) && Math.abs(raw) <= radians(60);
    let target = 0;
    if (tracked) {
      const offset = raw - this.neutral;
      const gain = Number.isFinite(options.sensitivity) ? clamp(options.sensitivity!, 0, 3) : 1;
      const deadened = Math.sign(offset) * Math.max(0, Math.abs(offset) - radians(1));
      target = clamp(deadened * gain * (options.mirrored === false ? 1 : -1), -radians(18), radians(18));
    }
    // Time-based damping is independent of the drawing frame rate.
    const alpha = 1 - Math.exp(-Math.min(dt, .25) / (tracked ? .18 : .55));
    this.value += (target - this.value) * alpha;
    return this.value;
  }

  calibrate(raw: number | null): boolean {
    if (raw === null || !Number.isFinite(raw) || Math.abs(raw) > radians(60)) return false;
    this.neutral = raw;
    return true;
  }

  reset(): void { this.value = 0; this.neutral = 0; }
}
