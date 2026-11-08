import type { PoseFrame } from './pose';
/** Angles use screen conventions: roll clockwise, yaw right, pitch up. */
export interface FaceMeasurement { x: number; y: number; roll: number; yaw: number; pitch: number; rotation: readonly number[] }
export interface FaceMotion { roll: number; shiftX: number; shiftY: number; yaw: number; pitch: number }
export interface FaceMotionOptions { mirrored?: boolean; sensitivity?: number; tilt?: boolean; shift?: boolean; turn?: boolean }
const rad = (value: number) => value * Math.PI / 180;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const deaden = (value: number, zone: number) => Math.sign(value) * Math.max(0, Math.abs(value) - zone);
const zero = (): FaceMotion => ({ roll: 0, shiftX: 0, shiftY: 0, yaw: 0, pitch: 0 });

function validRotation(r: readonly number[]): boolean {
  if (r.length !== 9 || !r.every(Number.isFinite)) return false;
  const columns = [[r[0], r[3], r[6]], [r[1], r[4], r[7]], [r[2], r[5], r[8]]];
  if (columns.some(c => Math.abs(Math.hypot(...c) - 1) > .03)) return false;
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(columns[a].reduce((sum, value, i) => sum + value * columns[b][i], 0)) > .03) return false;
  }
  const determinant = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  return Math.abs(determinant - 1) < .05;
}

function angles(r: readonly number[]): Pick<FaceMeasurement, 'roll' | 'yaw' | 'pitch'> {
  // R = Rz(-screenRoll) * Ry(screenYaw) * Rx(-screenPitch).
  // MediaPipe's metric coordinates are right handed, with Y up and camera -Z.
  return {
    roll: -Math.atan2(r[3], r[0]),
    yaw: Math.atan2(-r[6], Math.hypot(r[0], r[3])),
    pitch: -Math.atan2(r[7], r[8]),
  };
}

/** FaceLandmarker geometry is column-major; its translation is not screen UV. */
export function measureFace(frame: PoseFrame | null): FaceMeasurement | null {
  if (!frame || frame.mode !== 'face' || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) return null;
  const matrix = frame.matrix;
  if (!matrix || matrix.rows !== 4 || matrix.columns !== 4 || matrix.data.length !== 16 || !matrix.data.every(Number.isFinite)) return null;
  const m = matrix.data;
  if ([m[3], m[7], m[11], m[15] - 1].some(value => Math.abs(value) > .0001)) return null;
  const scale = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
  if (scale.some(value => value < 1e-6 || value > 1e6) || Math.max(...scale) / Math.min(...scale) > 1.03) return null;
  const rotation = [m[0] / scale[0], m[4] / scale[1], m[8] / scale[2], m[1] / scale[0], m[5] / scale[1], m[9] / scale[2], m[2] / scale[0], m[6] / scale[1], m[10] / scale[2]];
  if (!validRotation(rotation)) return null;
  const orientation = angles(rotation);
  // Near profile/back-facing solutions are too unstable for comfortable control.
  if (Math.abs(orientation.yaw) > rad(75) || Math.abs(orientation.pitch) > rad(75) || Math.abs(orientation.roll) > rad(75)) return null;
  const left = frame.landmarks[33]; const right = frame.landmarks[263];
  for (const point of [left, right]) {
    // Face points carry no usable per-point visibility score. The face task's
    // detection/presence/tracking thresholds gate the whole face instead.
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  }
  const eyeDistance = Math.hypot((right.x - left.x) * frame.width, (right.y - left.y) * frame.height);
  if (eyeDistance < 8) return null;
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, ...orientation, rotation };
}

function validMeasurement(value: FaceMeasurement | null): value is FaceMeasurement {
  return value !== null && [value.x, value.y, value.roll, value.yaw, value.pitch].every(Number.isFinite) &&
    value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1 && validRotation(value.rotation);
}

function relativeRotation(current: readonly number[], neutral: readonly number[]): number[] {
  // Rcurrent * transpose(Rneutral) measures motion in camera coordinates, so
  // an initially tilted head/camera does not mix yaw into roll at calibration.
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    return current[row * 3] * neutral[col * 3] + current[row * 3 + 1] * neutral[col * 3 + 1] + current[row * 3 + 2] * neutral[col * 3 + 2];
  });
}

export class FaceMotionController {
  private value = zero();
  private neutral: FaceMeasurement | null = null;
  get motion(): FaceMotion { return { ...this.value }; }

  update(measurement: FaceMeasurement | null, dt: number, options: FaceMotionOptions = {}): FaceMotion {
    if (!Number.isFinite(dt) || dt <= 0) return this.motion;
    const target = zero();
    const tracked = validMeasurement(measurement);
    if (tracked) {
      if (!this.neutral) this.calibrate(measurement);
      const neutral = this.neutral!;
      const relative = angles(relativeRotation(measurement.rotation, neutral.rotation));
      const gain = Number.isFinite(options.sensitivity) ? clamp(options.sensitivity!, 0, 3) : 1;
      const direction = options.mirrored === false ? 1 : -1;
      if (options.tilt !== false) target.roll = clamp(deaden(relative.roll, rad(1)) * gain * direction, -rad(18), rad(18));
      if (options.turn !== false) {
        target.yaw = clamp(deaden(relative.yaw, rad(1)) * gain * .5 * direction, -rad(15), rad(15));
        target.pitch = clamp(deaden(relative.pitch, rad(1)) * gain * .5, -rad(15), rad(15));
      }
      if (options.shift !== false) {
        target.shiftX = clamp(deaden(measurement.x - neutral.x, .005) * gain * .7 * direction, -.08, .08);
        target.shiftY = clamp(deaden(measurement.y - neutral.y, .005) * gain * .7, -.08, .08);
      }
    }
    const alpha = 1 - Math.exp(-Math.min(dt, .25) / (tracked ? .18 : .55));
    for (const key of ['roll', 'shiftX', 'shiftY', 'yaw', 'pitch'] as const) this.value[key] += (target[key] - this.value[key]) * alpha;
    return this.motion;
  }

  calibrate(measurement: FaceMeasurement | null): boolean {
    if (!validMeasurement(measurement)) return false;
    this.neutral = { ...measurement, rotation: [...measurement.rotation] };
    return true;
  }
  reset(): void { this.value = zero(); this.neutral = null; }
}

export function sampleFaceDemo(time: number): FaceMeasurement {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const roll = Math.sin(t * 1.1) * rad(16), yaw = Math.sin(t * .75) * rad(35), pitch = Math.sin(t * .9) * rad(28);
  const c = Math.cos(-roll), s = Math.sin(-roll), cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(-pitch), sp = Math.sin(-pitch);
  const rotation = [c * cy, c * sy * sp - s * cp, c * sy * cp + s * sp,
    s * cy, s * sy * sp + c * cp, s * sy * cp - c * sp,
    -sy, cy * sp, cy * cp];
  return { x: .5 + Math.sin(t * .8) * .16, y: .5 + Math.sin(t * .6) * .1, roll, yaw, pitch, rotation };
}
