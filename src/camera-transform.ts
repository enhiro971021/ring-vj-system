export type CameraTransformSettings = {
  /** Radians, positive clockwise on screen, capped at ±18°. */
  cameraTilt?: number;
  /** Fractions of output width/height, positive right/down, each capped at ±.08. */
  cameraOffset?: [number, number];
  /** Radians, positive brings the right edge nearer, capped at ±15°. */
  cameraYaw?: number;
  /** Radians, positive brings the top edge nearer, capped at ±15°. */
  cameraPitch?: number;
};
/** Column-major inverse homography in centred, bottom-up frame-height units. */
export type BackgroundCameraTransform = { matrix: number[]; active: boolean };
const bounded = (value: number | undefined, limit: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0;

/** Tilt the existing image plane; this does not recalculate scene geometry. */
export function backgroundCameraTransform(settings: CameraTransformSettings, aspect: number): BackgroundCameraTransform {
  const roll = bounded(settings.cameraTilt, Math.PI / 10);
  const yaw = bounded(settings.cameraYaw, Math.PI / 12);
  const pitch = bounded(settings.cameraPitch, Math.PI / 12);
  const offsetX = bounded(settings.cameraOffset?.[0], .08);
  const offsetY = bounded(settings.cameraOffset?.[1], .08);
  if (roll === 0 && yaw === 0 && pitch === 0 && offsetX === 0 && offsetY === 0) {
    return { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], active: false };
  }
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // Rotate the flat source about Y, then X, then clockwise in screen space.
  // The viewer sits 2.5 frame heights from the plane. Positive depth is nearer.
  const r00 = cr * cy - sr * sp * sy, r01 = sr * cp;
  const r10 = -sr * cy - cr * sp * sy, r11 = cr * cp;
  const depthX = cp * sy, depthY = sp;
  const determinant = r00 * r11 - r01 * r10;
  const a = r11 / determinant, b = -r01 / determinant;
  const c = -r10 / determinant, d = r00 / determinant;
  const g = (depthX * a + depthY * c) / 2.5;
  const h = (depthX * b + depthY * d) / 2.5;
  const tx = offsetX * ratio, ty = -offsetY;

  // For an output corner q after translation, inverse projection gives
  // source = A*q / (cover + g*q.x + h*q.y). Solve the two source bounds
  // directly for cover; the largest of the four corner requirements is the
  // minimum uniform zoom that fills the output without a black corner.
  let cover = 1;
  for (const x of [-ratio / 2, ratio / 2]) for (const y of [-.5, .5]) {
    const qx = x - tx, qy = y - ty;
    const perspective = g * qx + h * qy;
    cover = Math.max(cover, Math.abs(a * qx + b * qy) * 2 / ratio - perspective,
      Math.abs(c * qx + d * qy) * 2 - perspective);
  }
  return {
    active: true,
    matrix: [a, c, g, b, d, h, -a * tx - b * ty, -c * tx - d * ty,
      cover - g * tx - h * ty].map(value => value / cover),
  };
}
