import type { LayerKind, LayerSettings } from './media';
import { isSafeMediaFilename, mediaFileKind } from './media-folder-contract.ts';

export const MEDIA_PREFERENCES_KEY = 'vjsystem.media.v1';
export type MediaPreferences = Partial<Record<LayerKind, { fileName: string; settings: LayerSettings }>>;

const defaults: Record<LayerKind, LayerSettings> = {
  logo: { visible: true, opacity: 1, scale: .35, positionX: 0, positionY: 0, keyThreshold: .2, keySoftness: .25, anchorX: .5, anchorY: .5, rotationSpeed: 2, audioReact: false, blend: 'normal' },
  video: { visible: true, opacity: .55, scale: 1, positionX: 0, positionY: 0, keyThreshold: .2, keySoftness: .25, anchorX: .5, anchorY: .5, rotationSpeed: 0, playbackRate: 1, audioReact: false, blend: 'screen' },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Store names and controls only; file contents and arbitrary paths never enter preferences. */
export function readMediaPreferences(serialized: string | null): MediaPreferences {
  const preferences: MediaPreferences = {};
  let saved: Record<string, unknown> | null;
  try { saved = record(JSON.parse(serialized ?? 'null')); }
  catch { return preferences; }
  if (!saved) return preferences;
  for (const kind of ['logo', 'video'] as const) {
    const entry = record(saved[kind]);
    if (!entry || typeof entry.fileName !== 'string' || !isSafeMediaFilename(entry.fileName) || mediaFileKind(entry.fileName) !== kind) continue;
    const settings = record(entry.settings) ?? {};
    const fallback = defaults[kind];
    preferences[kind] = {
      fileName: entry.fileName,
      settings: {
        visible: typeof settings.visible === 'boolean' ? settings.visible : fallback.visible,
        opacity: number(settings.opacity, fallback.opacity, 0, 1),
        scale: number(settings.scale, fallback.scale, .1, kind === 'logo' ? 1 : 2),
        positionX: number(settings.positionX, 0, -.5, .5),
        positionY: number(settings.positionY, 0, -.5, .5),
        keyThreshold: number(settings.keyThreshold, .2, 0, .5),
        keySoftness: number(settings.keySoftness, .25, 0, 1),
        anchorX: number(settings.anchorX, .5, 0, 1),
        anchorY: number(settings.anchorY, .5, 0, 1),
        rotationSpeed: number(settings.rotationSpeed, fallback.rotationSpeed, -12, 12),
        ...(kind === 'video' ? { playbackRate: number(settings.playbackRate, 1, .25, 4) } : {}),
        audioReact: typeof settings.audioReact === 'boolean' ? settings.audioReact : fallback.audioReact,
        blend: settings.blend === 'normal' || settings.blend === 'screen' || settings.blend === 'add'
          || settings.blend === 'remove-white' || settings.blend === 'remove-black' ? settings.blend : fallback.blend,
      },
    };
  }
  return preferences;
}

export function writeMediaPreferences(storage: Pick<Storage, 'setItem'>, preferences: MediaPreferences): boolean {
  try {
    storage.setItem(MEDIA_PREFERENCES_KEY, JSON.stringify(readMediaPreferences(JSON.stringify(preferences))));
    return true;
  } catch { return false; }
}

/** Each layer restores independently so one missing or unreadable file never blocks the other. */
export async function restoreMediaPreferences<T extends { name: string; kind: LayerKind }>(
  preferences: MediaPreferences,
  files: readonly T[],
  load: (kind: LayerKind, file: T, settings: LayerSettings) => Promise<unknown>,
  missing: (kind: LayerKind, message: string) => void,
): Promise<void> {
  await Promise.allSettled((['logo', 'video'] as const).map(async kind => {
    const entry = preferences[kind];
    if (!entry) return;
    const file = files.find(candidate => candidate.name === entry.fileName && candidate.kind === kind);
    if (!file) { missing(kind, `前回の素材 ${entry.fileName} が見つかりません`); return; }
    try { await load(kind, file, { ...entry.settings }); }
    catch { missing(kind, `前回の素材 ${entry.fileName} を読み込めませんでした`); }
  }));
}
