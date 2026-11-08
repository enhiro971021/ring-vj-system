import { PALETTES, type ColorPalette, type ScenePreset, type VisualLook } from './presets.ts';
import { DEFAULT_BACKGROUND_BRIGHTNESS } from './background-treatment.ts';
import { cameraCycleCandidates } from './camera-preferences.ts';

export interface PaletteSet {
  id: string;
  name: string;
  colors: ColorPalette;
  backgroundColor?: string;
}
export interface CustomPalette extends PaletteSet { backgroundColor: string }

export interface BackgroundColorSettings {
  colors: ColorPalette;
  backgroundColor?: string;
  partColors: boolean;
}

export interface StudioPreferences {
  version: 2;
  background: string;
  backgroundColors: ColorPalette;
  backgroundColor?: string;
  backgroundColorOverrides: Record<string, BackgroundColorSettings>;
  colorLocked: boolean;
  partColors: boolean;
  paletteId?: string;
  backgroundBrightness: number;
  look: VisualLook;
  autoBackgrounds: string[];
  autoPalettes: string[];
  customPalettes: CustomPalette[];
}

export const PREFERENCES_KEY = 'vjsystem-studio-v2';
export const LEGACY_PREFERENCES_KEY = 'vjsystem-studio-v1';
// Resolves to the current background's saved colors instead of fixed palette colors.
export const BACKGROUND_PALETTE_ID = 'background-default';

function parseRecord(value: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function validColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function readBackgroundColorOverrides(value: unknown, presets: readonly ScenePreset[]): Record<string, BackgroundColorSettings> {
  const result: Record<string, BackgroundColorSettings> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const stored = value as Record<string, unknown>;
  for (const preset of presets) {
    const value = stored[preset.id];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!Array.isArray(entry.colors) || entry.colors.length !== 3 || !entry.colors.every(validColor)
      || typeof entry.partColors !== 'boolean'
      || (entry.backgroundColor !== undefined && !validColor(entry.backgroundColor))) continue;
    result[preset.id] = { colors: entry.colors.map(color => color.toLowerCase()) as ColorPalette,
      backgroundColor: typeof entry.backgroundColor === 'string' ? entry.backgroundColor.toLowerCase() : undefined,
      partColors: entry.partColors };
  }
  return result;
}

function paletteName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) : '';
}

function readCustomPalettes(value: unknown): CustomPalette[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(PALETTES.map(palette => palette.id));
  const result: CustomPalette[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string'
      || !/^custom-[a-z0-9-]{1,48}$/.test(entry.id) || ids.has(entry.id)
      || !Array.isArray(entry.colors) || entry.colors.length !== 3 || !entry.colors.every(validColor)
      || !validColor(entry.backgroundColor)) continue;
    ids.add(entry.id);
    result.push({ id: entry.id, name: paletteName(entry.name) || `カスタム ${result.length + 1}`,
      colors: entry.colors.map((color: string) => color.toLowerCase()) as ColorPalette,
      backgroundColor: entry.backgroundColor.toLowerCase() });
  }
  return result;
}

function selectedIDs(value: unknown, known: readonly string[], fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return known.filter(id => value.includes(id));
}

export function allPalettes(state: Pick<StudioPreferences, 'customPalettes'>): PaletteSet[] {
  return [...PALETTES, ...state.customPalettes];
}

export function paletteCycleIDs(state: Pick<StudioPreferences, 'customPalettes'>): string[] {
  return [BACKGROUND_PALETTE_ID, ...allPalettes(state).map(palette => palette.id)];
}

/** Reads only background preferences; input, media and foreground controls are never restored here. */
export function readPreferences(current: string | null, legacy: string | null, presets: readonly ScenePreset[]): StudioPreferences {
  const saved = parseRecord(current);
  const isCurrent = saved?.version === 2;
  const stored = (isCurrent ? saved : parseRecord(legacy)) ?? {};
  const id = isCurrent ? stored.background : stored.preset;
  const preset = presets.find(item => item.id === id) ?? presets.find(item => item.id === 'flow') ?? presets[0];
  const customPalettes = readCustomPalettes(stored.customPalettes);
  const backgroundIDs = presets.map(item => item.id);
  const autoBackgrounds = selectedIDs(stored.autoBackgrounds, backgroundIDs, backgroundIDs);
  const backgroundsCleared = Array.isArray(stored.autoBackgrounds) && stored.autoBackgrounds.length === 0;
  const paletteIDs = paletteCycleIDs({ customPalettes });
  const preferences: StudioPreferences = {
    version: 2, background: preset.id, backgroundColors: [...preset.colors],
    backgroundColorOverrides: readBackgroundColorOverrides(stored.backgroundColorOverrides, presets),
    colorLocked: false, partColors: false, customPalettes,
    autoBackgrounds: autoBackgrounds.length || backgroundsCleared ? autoBackgrounds : [preset.id],
    autoPalettes: selectedIDs(stored.autoPalettes, paletteIDs, paletteIDs),
    look: stored.look === 'neon' ? 'neon' : 'graphic',
    backgroundBrightness: typeof stored.backgroundBrightness === 'number' && Number.isFinite(stored.backgroundBrightness)
      && stored.backgroundBrightness >= 0 && stored.backgroundBrightness <= 3 ? stored.backgroundBrightness : DEFAULT_BACKGROUND_BRIGHTNESS,
  };
  const colors = isCurrent ? stored.backgroundColors : stored.colors;
  // v1 restored colors only while locked; v2 also preserved unlocked edits.
  if ((isCurrent || stored.colorLocked === true) && Array.isArray(colors) && colors.length === 3 && colors.every(validColor)) {
    preferences.backgroundColors = colors.map(color => color.toLowerCase()) as ColorPalette;
    preferences.colorLocked = stored.colorLocked === true;
    preferences.partColors = stored.partColors === true;
    if (validColor(stored.backgroundColor) && !(stored.look === 'airy' && stored.backgroundColor.toLowerCase() === '#f4f4f0')) {
      preferences.backgroundColor = stored.backgroundColor.toLowerCase();
    }
    const palette = allPalettes(preferences).find(item => item.id === stored.paletteId);
    if (preferences.partColors && palette?.colors.every((color, index) => color === preferences.backgroundColors[index])
      && (!palette.backgroundColor || palette.backgroundColor === preferences.backgroundColor)) {
      preferences.paletteId = palette.id;
    }
    // Migrate the old single edited background only once. Effective palette colors
    // must never be mistaken for a background edit, including after a reset.
    if (!Object.hasOwn(stored, 'backgroundColorOverrides') && !preferences.paletteId
      && stored.paletteId !== BACKGROUND_PALETTE_ID
      && (preferences.partColors || preferences.backgroundColor !== undefined
        || preferences.backgroundColors.some((color, index) => color !== preset.colors[index]))) {
      preferences.backgroundColorOverrides[preset.id] = {
        colors: [...preferences.backgroundColors], backgroundColor: preferences.backgroundColor,
        partColors: preferences.partColors,
      };
    }
  }
  return preferences.paletteId ? preferences : chooseBackgroundPalette(preferences, preset);
}


/** The same transitions drive both palette pickers and persisted state. */
export function choosePalette(state: StudioPreferences, palette: { id: string; colors: ColorPalette; backgroundColor?: string }, backgroundColor: string): StudioPreferences {
  return { ...state, backgroundColors: [...palette.colors], backgroundColor: palette.backgroundColor ?? backgroundColor,
    paletteId: palette.id, partColors: true, colorLocked: true };
}

export function getBackgroundColors(state: StudioPreferences, preset: ScenePreset): BackgroundColorSettings {
  const saved = state.backgroundColorOverrides[preset.id];
  return saved ? { ...saved, colors: [...saved.colors] }
    : { colors: [...preset.colors], backgroundColor: undefined, partColors: false };
}

export function editBackgroundColor(state: StudioPreferences, preset: ScenePreset, slot: number, color: string, defaultBackgroundColor: string): StudioPreferences {
  if (!Number.isInteger(slot) || slot < 0 || slot > 3 || !validColor(color)) return state;
  const saved = getBackgroundColors(state, preset);
  saved.backgroundColor ??= defaultBackgroundColor;
  saved.partColors = true;
  if (slot === 0) saved.backgroundColor = color.toLowerCase();
  else saved.colors[slot - 1] = color.toLowerCase();
  const edited = { ...state, backgroundColorOverrides: { ...state.backgroundColorOverrides, [preset.id]: saved } };
  return allPalettes(state).some(palette => palette.id === state.paletteId)
    ? edited : chooseBackgroundPalette(edited, preset);
}

export function restoreBackgroundColors(state: StudioPreferences, preset: ScenePreset): StudioPreferences {
  const backgroundColorOverrides = { ...state.backgroundColorOverrides };
  delete backgroundColorOverrides[preset.id];
  return chooseBackgroundPalette({ ...state, backgroundColorOverrides }, preset);
}

export function chooseBackgroundPalette(state: StudioPreferences, preset: ScenePreset): StudioPreferences {
  const saved = getBackgroundColors(state, preset);
  return { ...state, backgroundColors: saved.colors, backgroundColor: saved.backgroundColor,
    partColors: saved.partColors, colorLocked: false, paletteId: BACKGROUND_PALETTE_ID };
}

export function chooseBackground(state: StudioPreferences, preset: ScenePreset): StudioPreferences {
  const hasPalette = allPalettes(state).some(palette => palette.id === state.paletteId);
  return { ...(hasPalette ? state : chooseBackgroundPalette(state, preset)), background: preset.id };
}


export function setCycleMembership(state: StudioPreferences, kind: 'background' | 'palette', id: string, included: boolean, presets: readonly ScenePreset[]): StudioPreferences {
  const key = kind === 'background' ? 'autoBackgrounds' : 'autoPalettes';
  const known = kind === 'background' ? presets.map(item => item.id) : paletteCycleIDs(state);
  if (!known.includes(id)) return state;
  const selected = new Set(state[key]);
  if (included) selected.add(id);
  else selected.delete(id);
  return { ...state, [key]: known.filter(item => selected.has(item)) };
}

export function setAllCycleMembership(state: StudioPreferences, kind: 'background' | 'palette', included: boolean, presets: readonly ScenePreset[]): StudioPreferences {
  const key = kind === 'background' ? 'autoBackgrounds' : 'autoPalettes';
  const selected = included ? (kind === 'background' ? presets.map(item => item.id) : paletteCycleIDs(state)) : [];
  return { ...state, [key]: selected };
}

export function nextCycleSelection(state: StudioPreferences, presets: readonly ScenePreset[], cameraActive = true): { backgroundId: string; paletteId?: string } {
  const eligible = cameraCycleCandidates(state.autoBackgrounds, cameraActive);
  const choices = presets.filter(preset => eligible.includes(preset.id));
  const index = choices.findIndex(preset => preset.id === state.background);
  const backgroundId = choices.length ? choices[(index + 1) % choices.length].id : state.background;
  const palettes = paletteCycleIDs(state).filter(id => state.autoPalettes.includes(id));
  const paletteIndex = palettes.findIndex(id => id === state.paletteId);
  return { backgroundId, paletteId: palettes.length > 1 ? palettes[(paletteIndex + 1) % palettes.length] : state.paletteId };
}

export function addCustomPalette(state: StudioPreferences, defaultBackgroundColor: string, preset: ScenePreset): StudioPreferences {
  const ids = new Set(allPalettes(state).map(palette => palette.id));
  let number = 1;
  while (ids.has(`custom-${number}`)) number++;
  const saved = getBackgroundColors(state, preset);
  const backgroundColor = saved.backgroundColor ?? defaultBackgroundColor;
  const palette: CustomPalette = { id: `custom-${number}`, name: `カスタム ${number}`,
    colors: saved.colors, backgroundColor };
  return choosePalette({ ...state, customPalettes: [...state.customPalettes, palette],
    autoPalettes: [...state.autoPalettes, palette.id] }, palette, backgroundColor);
}

export function renameCustomPalette(state: StudioPreferences, id: string, name: string): StudioPreferences {
  const normalized = paletteName(name);
  if (!normalized) return state;
  return { ...state, customPalettes: state.customPalettes.map(palette => palette.id === id ? { ...palette, name: normalized } : palette) };
}

export function deleteCustomPalette(state: StudioPreferences, id: string, preset: ScenePreset): StudioPreferences {
  if (!state.customPalettes.some(palette => palette.id === id)) return state;
  const updated = { ...state,
    customPalettes: state.customPalettes.filter(palette => palette.id !== id),
    autoPalettes: state.autoPalettes.filter(selected => selected !== id) };
  return state.paletteId === id ? chooseBackgroundPalette(updated, preset) : updated;
}
