export type PerformanceMode = 'dj' | 'live';
export interface CameraPreferences {
  version: 1;
  deviceId: string;
  label: string;
  autoStart: boolean;
  mode: PerformanceMode;
  opacity: number;
  mirror: boolean;
}
export const CAMERA_PREFERENCES_KEY = 'vjsystem-camera-v1';

/** Kept separate from background preferences so palette updates cannot reset input consent. */
export function readCameraPreferences(raw: string | null): CameraPreferences {
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 1) saved = value as Record<string, unknown>;
  } catch { /* A corrupt preference must never grant camera consent. */ }
  return {
    version: 1,
    deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : '',
    label: typeof saved.label === 'string' ? saved.label : '',
    autoStart: saved.autoStart === true,
    mode: saved.mode === 'live' ? 'live' : 'dj',
    opacity: typeof saved.opacity === 'number' && Number.isFinite(saved.opacity) && saved.opacity >= 0 && saved.opacity <= 1 ? saved.opacity : .25,
    mirror: typeof saved.mirror === 'boolean' ? saved.mirror : true,
  };
}
export function writeCameraPreferences(value: CameraPreferences): string {
  return JSON.stringify(readCameraPreferences(JSON.stringify(value)));
}
export function isCameraBackground(id: string): boolean { return id.startsWith('camera-'); }
export function cameraCycleCandidates(ids: readonly string[], active: boolean): string[] {
  return ids.filter(id => active || !isCameraBackground(id));
}
export function cameraLayerPolicy(background: string, mode: PerformanceMode, active: boolean, opacity: number) {
  const cameraBackground = isCameraBackground(background);
  const overlayOpacity = mode === 'live' && active && !cameraBackground && Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0;
  return { cameraBackground, fallback: cameraBackground && !active, overlayOpacity, cameraVisible: active && (cameraBackground || overlayOpacity > 0) };
}
