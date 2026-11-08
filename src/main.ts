import './style.css';
import { AudioInput, DEFAULT_BAND_GAINS, BAND_GAIN_MAX, type AudioBandGains } from './audio';
import { VisualRenderer, type VisualSettings } from './renderer';
import { PRESETS, LOOKS, type ColorPalette, type ScenePreset } from './presets';
import { MediaLayers, type LayerKind, type LayerBlend } from './media';
import { MediaFolder } from './media-folder';
import { createLogoMakerControls } from './logo-maker-controls';
import { normalizeLogoDesign, renderLogoDesign, type LogoDesign } from './logo-design';
import { LOGO_PREFERENCES_KEY, readLogoPreferences, writeLogoPreferences } from './logo-preferences';
import { OutputWindow } from './output';
import { CameraControls } from './camera-controls';
import { ColorControls, defaultBackground } from './color-controls';
import { readPreferences, choosePalette, chooseBackground, chooseBackgroundPalette, getBackgroundColors, editBackgroundColor, restoreBackgroundColors, BACKGROUND_PALETTE_ID, allPalettes, paletteCycleIDs, setCycleMembership, setAllCycleMembership, nextCycleSelection, renameCustomPalette, deleteCustomPalette, PREFERENCES_KEY, LEGACY_PREFERENCES_KEY, type StudioPreferences, type CustomPalette } from './preferences';
import { DEFAULT_BACKGROUND_BRIGHTNESS } from './background-treatment';
import { cameraCycleCandidates, cameraLayerPolicy } from './camera-preferences';
import { horizontalList } from './horizontal-list';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
const canvas = element<HTMLCanvasElement>('visual');
const micButton = element<HTMLButtonElement>('microphone');
const device = element<HTMLSelectElement>('device');
const quality = element<HTMLSelectElement>('quality');
const renderError = element('render-error');
const meters = ['low', 'mid', 'high'].map(id => element<HTMLMeterElement>(id));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const backgroundList = horizontalList(element('presets'), element<HTMLButtonElement>('presets-previous'), element<HTMLButtonElement>('presets-next'));
const paletteList = horizontalList(element('background-palettes'), element<HTMLButtonElement>('palettes-previous'), element<HTMLButtonElement>('palettes-next'));
let current = PRESETS.find(preset => preset.id === 'flow')!;
let colorLocked = false;
let paletteId: string | undefined = BACKGROUND_PALETTE_ID;
let backgroundColorOverrides: StudioPreferences['backgroundColorOverrides'] = {};
const BACKGROUND_PALETTE_NAME = '背景ごとの配色';
let autoBackgrounds = PRESETS.map(preset => preset.id);
let autoPalettes = paletteCycleIDs({ customPalettes: [] });
let customPalettes: CustomPalette[] = [];
let paused = reducedMotion;
let hidden = false;
let blackedOut = false;
let microphoneState = 'idle';
let sensitivity = 1;
const bandGains: AudioBandGains = { ...DEFAULT_BAND_GAINS };
let auto = false;
let autoElapsed = 0;
let renderer: VisualRenderer | null = null;
let frameId = 0;
let needsDraw = true;
let time = 0;
let previous = performance.now();
let lastMeterUpdate = 0;
let fpsStarted = previous;
let frames = 0;
let deviceRefresh = 0;
let cameraIsActive = false;
const settings: VisualSettings & { colors: ColorPalette; backgroundBrightness: number; foregroundTrail: number } = { ...current.settings, foregroundTrail: 0, brightness: 1, backgroundBrightness: DEFAULT_BACKGROUND_BRIGHTNESS, look: 'graphic', colors: [...current.colors] };
let logoMakerControls: ReturnType<typeof createLogoMakerControls> | undefined;
let logoPreferences = readLogoPreferences(null);
try { logoPreferences = readLogoPreferences(localStorage.getItem(LOGO_PREFERENCES_KEY)); } catch { /* Local use still works without storage. */ }
function saveLogoPreferences(): void {
  try { localStorage.setItem(LOGO_PREFERENCES_KEY, writeLogoPreferences(logoPreferences)); }
  catch { notify('ロゴの設定を保存できませんでした。透過PNGを保存しておくと、あとで使えます。', true); }
}

function notify(message: string, error = false): void {
  element('notice').textContent = message;
  element('notice').dataset.error = String(error);
}
function currentPreferences(): StudioPreferences {
  return {
    version: 2, background: current.id, backgroundColors: [...settings.colors],
    backgroundColor: settings.backgroundColor, colorLocked, paletteId, backgroundColorOverrides,
    backgroundBrightness: settings.backgroundBrightness,
    look: settings.look ?? 'graphic', partColors: settings.partColors === true,
    autoBackgrounds: [...autoBackgrounds], autoPalettes: [...autoPalettes], customPalettes,
  };
}
function applyColors(stored: StudioPreferences): void {
  settings.colors = [...stored.backgroundColors];
  settings.partColors = stored.partColors;
  settings.backgroundColor = stored.backgroundColor;
  colorLocked = stored.colorLocked;
  paletteId = stored.paletteId;
  backgroundColorOverrides = stored.backgroundColorOverrides;
}
function applyLibrary(stored: StudioPreferences): void {
  applyColors(stored);
  autoBackgrounds = [...stored.autoBackgrounds];
  autoPalettes = [...stored.autoPalettes];
  customPalettes = stored.customPalettes;
}
function savePreferences(): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(currentPreferences()));
  } catch { /* Private browsing or a full storage quota must not interrupt a set. */ }
}
try {
  const stored = readPreferences(localStorage.getItem(PREFERENCES_KEY), localStorage.getItem(LEGACY_PREFERENCES_KEY), PRESETS);
  current = PRESETS.find(item => item.id === stored.background)!;
  Object.assign(settings, current.settings);
  settings.look = stored.look;
  settings.backgroundBrightness = stored.backgroundBrightness;
  applyLibrary(stored);
  savePreferences();
} catch { /* Ignore stale preferences. Media and microphone permissions are never stored here. */ }

const audio = new AudioInput((state, message) => {
  microphoneState = state;
  micButton.textContent = state === 'requesting' ? '接続を中止' : state === 'live' ? 'マイクを停止' : '◉ マイクを開始';
  micButton.setAttribute('aria-pressed', String(state === 'live'));
  element('status').textContent = state === 'idle' ? 'マイク未接続。模様だけ動かしています。' : message;
  if (state === 'live') {
    void refreshDevices();
    const applied = audio.settings;
    if (applied?.echoCancellation || applied?.noiseSuppression || applied?.autoGainControl) {
      element('status').textContent = 'マイク接続中。音声補正が有効な入力です。感度を調整してください。';
    }
  }
});
async function refreshDevices(): Promise<void> {
  const ticket = ++deviceRefresh;
  const list = await audio.devices();
  if (ticket !== deviceRefresh) return;
  const chosen = audio.settings?.deviceId || device.value;
  device.replaceChildren(new Option('標準のマイク', ''));
  list.forEach((entry, index) => {
    if (entry.deviceId && entry.deviceId !== 'default') device.add(new Option(entry.label || `マイク ${index + 1}`, entry.deviceId));
  });
  if ([...device.options].some(option => option.value === chosen)) device.value = chosen;
}
micButton.addEventListener('click', () => {
  if (microphoneState === 'requesting' || microphoneState === 'live') audio.stop();
  else void audio.start(device.value || undefined);
});
device.addEventListener('change', () => {
  if (microphoneState === 'live' || microphoneState === 'requesting') void audio.start(device.value || undefined);
});
const onDeviceChange = () => { if (audio.active) void refreshDevices(); };
navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);

function slider(id: string, label: string, min: number, max: number, step: number, value: number): string {
  return `<label class="parameter" for="${id}"><span>${label}<output id="${id}-value" for="${id}"></output></span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}
function updateSlider(id: string, format: (value: number) => string): void {
  const input = element<HTMLInputElement>(id);
  const value = Number(input.value);
  element<HTMLOutputElement>(`${id}-value`).value = format(value);
  input.style.setProperty('--fill', `${100 * (value - Number(input.min)) / (Number(input.max) - Number(input.min))}%`);
}
const percent = (value: number) => `${Math.round(value * 100)}%`;
const multiple = (value: number) => `${value.toFixed(1)}×`;
// Sensitivity is input gain on a logarithmic slider: 0.05x to 20x, 1x in the middle.
const sensitivityOf = (position: number) => 10 ** position;
const logMultiple = (position: number) => { const value = sensitivityOf(position); return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}×`; };
const motion = [
  { id: 'sensitivity', label: '全体の感度', min: -1.3, max: 1.3, step: .02, value: Math.log10(sensitivity), format: logMultiple },
  { id: 'foregroundTrail', label: '線の残像', min: 0, max: 1, step: .01, value: settings.foregroundTrail, format: percent },
  { id: 'backgroundBrightness', label: '背景の明るさ', min: 0, max: 3, step: .05, value: settings.backgroundBrightness, format: percent },
  { id: 'speed', label: '背景の速さ', min: .1, max: 2, step: .05, value: settings.speed, format: multiple },
  { id: 'warp', label: '背景の歪み', min: 0, max: 1, step: .01, value: settings.warp, format: percent },
  { id: 'trail', label: '背景の残像', min: 0, max: 1, step: .01, value: settings.trail, format: percent },
  { id: 'brightness', label: '出力の明るさ', min: 0, max: 1.5, step: .01, value: settings.brightness, format: percent },
] as const;
for (const item of motion) {
  const target = item.id === 'sensitivity' ? 'foreground-controls' : item.id === 'foregroundTrail' ? 'foreground-effects' : item.id === 'brightness' ? 'output-controls' : 'motion-controls';
  element(target).insertAdjacentHTML('beforeend', slider(item.id, item.label, item.min, item.max, item.step, item.value));
}
element('sensitivity').setAttribute('aria-describedby', 'sensitivity-hint');
element('foregroundTrail').setAttribute('aria-describedby', 'foreground-trail-hint');
element('backgroundBrightness').setAttribute('aria-describedby', 'background-brightness-hint');
const bands = [{ key: 'low', label: '低音' }, { key: 'mid', label: '中音' }, { key: 'high', label: '高音' }] as const;
for (const { key, label } of bands) {
  const id = `sensitivity-${key}`;
  element('foreground-controls').insertAdjacentHTML('beforeend', slider(id, `${label}の感度`, 0, BAND_GAIN_MAX, .05, bandGains[key]));
  element(id).setAttribute('aria-describedby', 'sensitivity-hint');
  updateSlider(id, value => `${value.toFixed(2)}×`);
  element(id).addEventListener('input', () => {
    bandGains[key] = Number(element<HTMLInputElement>(id).value);
    updateSlider(id, value => `${value.toFixed(2)}×`);
    needsDraw = true;
  });
}
for (const item of motion) {
  updateSlider(item.id, item.format);
  element(item.id).addEventListener('input', () => {
    const value = Number(element<HTMLInputElement>(item.id).value);
    if (item.id === 'sensitivity') sensitivity = sensitivityOf(value); else settings[item.id] = value;
    updateSlider(item.id, item.format);
    if (item.id === 'backgroundBrightness') savePreferences();
    needsDraw = true;
  });
}
function syncMotion(): void {
  for (const item of motion) {
    element<HTMLInputElement>(item.id).value = String(item.id === 'sensitivity' ? Math.log10(sensitivity) : settings[item.id]);
    updateSlider(item.id, item.format);
  }
  for (const { key } of bands) {
    const id = `sensitivity-${key}`;
    element<HTMLInputElement>(id).value = String(bandGains[key]);
    updateSlider(id, value => `${value.toFixed(2)}×`);
  }
}
const colorControls = new ColorControls(element('color-inputs'), (slot, color) => {
  applyColors(editBackgroundColor(currentPreferences(), current, slot, color, defaultBackground(current.id, settings.look ?? 'graphic')));
  syncColors(); syncAutoStatus(); needsDraw = true; savePreferences();
});
function syncColors(): void {
  if (!element('logo-maker-controls').contains(document.activeElement)) logoMakerControls?.update(logoPreferences.draft);
  const saved = getBackgroundColors(currentPreferences(), current);
  colorControls.sync(current.id, saved.colors, saved.backgroundColor ?? defaultBackground(current.id, settings.look ?? 'graphic'));
  const selected = allPalettes({ customPalettes }).find(palette => palette.id === paletteId);
  const followsBackground = paletteId === BACKGROUND_PALETTE_ID;
  element('color-mode-label').textContent = `${current.name}の配色`;
  element('background-palette-label').textContent = selected?.name ?? BACKGROUND_PALETTE_NAME;
  element('background-color-status').textContent = selected
    ? `映像は「${selected.name}」を適用中。ここで編集した色は「背景ごとの配色」で使えます。`
    : 'この背景に自動保存されます。背景の切替・再読み込み後も保持します。';
  for (const prefix of ['palette', 'background-palette']) {
    const button = element(`${prefix}-${BACKGROUND_PALETTE_ID}`);
    button.setAttribute('aria-pressed', String(followsBackground));
    button.querySelectorAll<HTMLElement>('.palette-colors span').forEach((part, index) => {
      part.style.backgroundColor = saved.colors[index];
    });
  }
  element('palette-cycle-hint').textContent = '2組以上をチェックすると配色も順送り';
  for (const palette of allPalettes({ customPalettes })) {
    for (const prefix of ['palette', 'background-palette']) {
      element(`${prefix}-${palette.id}`).setAttribute('aria-pressed', String(palette.id === paletteId));
    }
  }
  paletteList.revealSelection();
}
function cycleCheckbox(kind: 'background' | 'palette', id: string, name: string, prefix: string): HTMLLabelElement {
  const label = document.createElement('label'); label.className = 'cycle-toggle';
  const input = document.createElement('input'); input.type = 'checkbox'; input.id = `${prefix}-cycle-${id}`;
  input.setAttribute('aria-label', `自動切替の対象：${name}`);
  input.checked = (kind === 'background' ? autoBackgrounds : autoPalettes).includes(id);
  const text = document.createElement('span'); text.textContent = '自動';
  label.append(input, text);
  input.addEventListener('change', () => {
    applyLibrary(setCycleMembership(currentPreferences(), kind, id, input.checked, PRESETS));
    autoElapsed = 0;
    syncCycleControls(); syncAutoStatus(); savePreferences();
  });
  return label;
}
function syncCycleControls(): void {
  for (const preset of PRESETS) {
    const input = element<HTMLInputElement>(`background-cycle-${preset.id}`);
    input.checked = autoBackgrounds.includes(preset.id);
  }
  for (const id of paletteCycleIDs({ customPalettes })) {
    for (const prefix of ['palette', 'background-palette']) {
      element<HTMLInputElement>(`${prefix}-cycle-${id}`).checked = autoPalettes.includes(id);
    }
  }
  for (const group of document.querySelectorAll<HTMLElement>('.cycle-actions')) {
    const background = group.dataset.cycleKind === 'background';
    const selected = background ? autoBackgrounds.length : autoPalettes.length;
    const total = background ? PRESETS.length : paletteCycleIDs({ customPalettes }).length;
    group.querySelector<HTMLElement>('.cycle-count')!.textContent = `${selected} / ${total}`;
    group.querySelector<HTMLButtonElement>('[data-cycle-action="all"]')!.disabled = selected === total;
    group.querySelector<HTMLButtonElement>('[data-cycle-action="clear"]')!.disabled = selected === 0;
  }
}
for (const group of document.querySelectorAll<HTMLElement>('.cycle-actions')) {
  const kind = group.dataset.cycleKind === 'background' ? 'background' : 'palette';
  for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('click', () => {
      const included = button.dataset.cycleAction === 'all';
      applyLibrary(setAllCycleMembership(currentPreferences(), kind, included, PRESETS));
      autoElapsed = 0;
      syncCycleControls(); syncAutoStatus(); savePreferences();
      notify(`${kind === 'background' ? '背景' : '配色'}の自動切替対象をすべて${included ? 'チェックしました。' : 'クリアしました。表示中の背景と色は保ちます。'}`);
    });
  }
}
function syncPaletteNames(): void {
  for (const palette of allPalettes({ customPalettes })) {
    for (const prefix of ['palette', 'background-palette']) {
      const button = element(`${prefix}-${palette.id}`);
      button.querySelector<HTMLElement>('.palette-name')!.textContent = palette.name;
      button.setAttribute('aria-label', `配色：${palette.name}`);
      element(`${prefix}-cycle-${palette.id}`).setAttribute('aria-label', `自動切替の対象：${palette.name}`);
    }
    if (customPalettes.some(item => item.id === palette.id)) {
      const name = element<HTMLInputElement>(`palette-name-${palette.id}`);
      name.value = palette.name; name.setAttribute('aria-label', `${palette.name}の名前`);
      element(`delete-palette-${palette.id}`).setAttribute('aria-label', `${palette.name}を削除`);
    }
  }
}
function renderPalettePickers(): void {
  const palettes = allPalettes({ customPalettes });
  element('palettes').replaceChildren(); element('background-palettes').replaceChildren();
  for (const [container, prefix] of [['palettes', 'palette'], ['background-palettes', 'background-palette']]) {
    const entry = document.createElement('div'); entry.className = 'palette-entry';
    const button = document.createElement('button'); button.type = 'button';
    button.id = `${prefix}-${BACKGROUND_PALETTE_ID}`; button.className = 'palette-button';
    button.setAttribute('aria-label', `配色：${BACKGROUND_PALETTE_NAME}`);
    button.title = '背景を替えるたびに、その背景の保存した配色を使います。';
    const swatch = document.createElement('span'); swatch.className = 'palette-colors'; swatch.setAttribute('aria-hidden', 'true');
    for (const color of current.colors) { const part = document.createElement('span'); part.style.backgroundColor = color; swatch.append(part); }
    const label = document.createElement('span'); label.className = 'palette-name'; label.textContent = BACKGROUND_PALETTE_NAME;
    button.append(swatch, label); button.addEventListener('click', restorePalette);
    entry.append(button, cycleCheckbox('palette', BACKGROUND_PALETTE_ID, BACKGROUND_PALETTE_NAME, prefix));
    element(container).append(entry);
  }
  for (const palette of palettes) {
    const custom = customPalettes.some(item => item.id === palette.id);
    for (const [container, prefix] of [['palettes', 'palette'], ['background-palettes', 'background-palette']]) {
      const entry = document.createElement('div'); entry.className = 'palette-entry';
      const button = document.createElement('button');
      button.type = 'button'; button.id = `${prefix}-${palette.id}`; button.className = 'palette-button';
      button.setAttribute('aria-label', `配色：${palette.name}`);
      const swatch = document.createElement('span'); swatch.className = 'palette-colors'; swatch.setAttribute('aria-hidden', 'true');
      for (const color of palette.colors) { const part = document.createElement('span'); part.style.backgroundColor = color; swatch.append(part); }
      const label = document.createElement('span'); label.className = 'palette-name'; label.textContent = palette.name;
      button.append(swatch, label);
      button.addEventListener('click', () => {
        const selected = allPalettes({ customPalettes }).find(item => item.id === palette.id);
        if (!selected) return;
        applyColors(choosePalette(currentPreferences(), selected, defaultBackground(current.id, settings.look ?? 'graphic')));
        syncColors(); syncAutoStatus(); needsDraw = true; savePreferences();
        notify(`${selected.name}の配色にしました。背景を替えてもこの色を使います。`);
      });
      entry.append(button, cycleCheckbox('palette', palette.id, palette.name, prefix));
      if (custom && prefix === 'palette') {
        const editor = document.createElement('div'); editor.className = 'palette-editor';
        const name = document.createElement('input'); name.type = 'text'; name.maxLength = 48; name.value = palette.name;
        name.id = `palette-name-${palette.id}`; name.setAttribute('aria-label', `${palette.name}の名前`);
        const commitName = (): void => {
          applyLibrary(renameCustomPalette(currentPreferences(), palette.id, name.value));
          // Keep focused controls and pending pointer targets in place on blur.
          syncPaletteNames(); syncColors(); savePreferences();
        };
        name.addEventListener('change', commitName);
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitName(); } });
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除';
        remove.id = `delete-palette-${palette.id}`; remove.setAttribute('aria-label', `${palette.name}を削除`);
        remove.addEventListener('click', () => {
          const removedName = allPalettes({ customPalettes }).find(item => item.id === palette.id)?.name ?? palette.name;
          applyLibrary(deleteCustomPalette(currentPreferences(), palette.id, current));
          renderPalettePickers(); syncColors(); syncCycleControls(); syncAutoStatus(); needsDraw = true; savePreferences();
          element('palette-library').querySelector('summary')?.focus(); notify(`${removedName}を削除しました。背景ごとの保存色は残ります。`);
        });
        editor.append(name, remove); entry.append(editor);
      }
      element(container).append(entry);
    }
  }
}
renderPalettePickers();
function restorePalette(): void {
  applyColors(chooseBackgroundPalette(currentPreferences(), current));
  syncColors(); syncAutoStatus(); needsDraw = true; savePreferences();
  notify('背景ごとの配色にしました。各背景に保存した色を使います。');
}
element('preset-colors').addEventListener('click', () => {
  applyColors(restoreBackgroundColors(currentPreferences(), current));
  syncColors(); syncAutoStatus(); needsDraw = true; savePreferences();
  notify(`${current.name}の配色をリセットしました。他の背景の保存色は残ります。`);
});
element('background-preset-colors').addEventListener('click', restorePalette);
syncColors();

function syncLook(): void {
  for (const look of LOOKS) element(`look-${look.id}`).setAttribute('aria-pressed', String(settings.look === look.id));
  element('current-look').textContent = LOOKS.find(look => look.id === settings.look)!.label;
}
for (const look of LOOKS) {
  const button = document.createElement('button'); button.type = 'button';
  button.id = `look-${look.id}`; button.className = `look-button look-${look.id}`;
  button.innerHTML = `<span class="look-art" aria-hidden="true"></span><span><strong>${look.label}</strong><small>${look.description}</small></span>`;
  button.addEventListener('click', () => {
    if (settings.look === look.id) return;
    settings.look = look.id; renderer?.setPreset(current, paused ? 0 : .5);
    needsDraw = true; syncLook(); syncColors(); savePreferences();
    void createThumbnails();
    notify(`背景を${look.label}に切り替えました。白い輪は共通です。`);
  });
  element('looks').append(button);
}
syncLook();

element('preset-count').textContent = `${PRESETS.length}種類`;
function syncAutoStatus(): void {
  const interval = Number(element<HTMLSelectElement>('auto-interval').value);
  const paletteNote = autoPalettes.length > 1 ? `配色${autoPalettes.length}組も順送り`
    : paletteId === BACKGROUND_PALETTE_ID ? '各背景の保存した配色を使用' : '配色は維持';
  const keepsBackground = nextCycleSelection(currentPreferences(), PRESETS, cameraIsActive).backgroundId === current.id;
  const eligible = cameraCycleCandidates(autoBackgrounds, cameraIsActive).length;
  const cameraNote = eligible < autoBackgrounds.length ? ' カメラ停止中の背景はスキップします。' : '';
  element('auto-status').textContent = auto
    ? paused ? '一時停止中は、自動切替も待機します。'
      : `あと${Math.max(1, Math.ceil(interval - autoElapsed))}秒で${keepsBackground ? '同じ背景を継続' : '次の背景へ'}。${paletteNote}。`
    : `対象の背景${eligible}種類を巡回。${paletteNote}。`;
  if (!eligible && !(auto && paused)) element('auto-status').textContent = `${autoBackgrounds.length ? '動作中の対象背景がないため、現在の背景を保持します' : '背景のチェックは0件。現在の背景を保持します'}。${paletteNote}。`;
  element('auto-status').textContent += cameraNote;
}

const thumbImages = new Map<string, HTMLImageElement>();
for (const preset of PRESETS) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'preset'; button.id = `preset-${preset.id}`;
  button.setAttribute('aria-label', `背景：${preset.name}`);
  button.title = preset.description;
  button.innerHTML = `<div class="preset-thumb"><img alt="" width="256" height="144" /><span class="preset-indicator" aria-hidden="true">✓</span></div><span class="preset-caption"><strong>${preset.name}</strong></span>`;
  if (preset.id.startsWith('camera-')) {
    const title = button.querySelector('strong')!;
    title.replaceChildren(document.createTextNode('カメラ・'), document.createElement('wbr'), document.createTextNode(preset.name.replace('カメラ・', '')));
  }
  const image = button.querySelector('img')!;
  // A local solid placeholder is replaced by a still rendered by the actual GLSL.
  image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144"><rect width="256" height="144" fill="${preset.colors[0]}"/></svg>`)}`;
  thumbImages.set(preset.id, image);
  button.addEventListener('click', () => selectPreset(preset));
  const entry = document.createElement('div'); entry.className = 'preset-entry';
  entry.append(button, cycleCheckbox('background', preset.id, preset.name, 'background'));
  element('presets').append(entry);
}
function syncCurrent(): void {
  element('current-name').textContent = current.name;
  element('current-description').textContent = current.description;
  for (const preset of PRESETS) element(`preset-${preset.id}`).setAttribute('aria-pressed', String(current.id === preset.id));
  backgroundList.revealSelection();
}
function selectPreset(preset: ScenePreset): void {
  if (!renderer) return;
  const next = chooseBackground(currentPreferences(), preset);
  current = preset;
  // Keep live adjustments across backgrounds; apply preset defaults only on load/reset.
  applyColors(next);
  renderer.setPreset(preset, paused ? 0 : Number(element<HTMLSelectElement>('transition').value));
  autoElapsed = 0; needsDraw = true;
  syncCurrent(); syncMotion(); syncColors(); syncAutoStatus(); savePreferences();
  notify(`${preset.name}に切り替えました。${colorLocked ? '指定した配色を使っています。' : preset.description + '。'}`);
}
function nextPreset(): void {
  const next = nextCycleSelection(currentPreferences(), PRESETS, cameraIsActive);
  const nextBackground = PRESETS.find(preset => preset.id === next.backgroundId)!;
  if (current.id !== nextBackground.id) selectPreset(nextBackground);
  if (next.paletteId === BACKGROUND_PALETTE_ID) {
    applyColors(chooseBackgroundPalette(currentPreferences(), nextBackground));
  } else if (autoPalettes.length > 1) {
    const palette = allPalettes({ customPalettes }).find(item => item.id === next.paletteId);
    if (palette) applyColors(choosePalette(currentPreferences(), palette, defaultBackground(nextBackground.id, settings.look ?? 'graphic')));
  }
  autoElapsed = 0; needsDraw = true; syncColors(); syncAutoStatus(); savePreferences();
}
element('next').addEventListener('click', nextPreset);
element('auto').addEventListener('click', () => {
  auto = !auto; autoElapsed = 0;
  element('auto').setAttribute('aria-pressed', String(auto));
  element('auto').textContent = `自動切替 ${auto ? 'オン' : 'オフ'}`;
  syncAutoStatus();
});
element('auto-interval').addEventListener('change', () => { autoElapsed = 0; syncAutoStatus(); });
syncCurrent(); syncCycleControls(); syncAutoStatus();

const inspectorTabs = ['color', 'media', 'camera'] as const;
let mediaFolder: MediaFolder | undefined;
function setTab(tab: typeof inspectorTabs[number]): void {
  for (const id of inspectorTabs) {
    const button = element<HTMLButtonElement>(`${id}-tab`);
    button.setAttribute('aria-selected', String(id === tab));
    button.tabIndex = id === tab ? 0 : -1;
    element(`${id}-panel`).hidden = id !== tab;
  }
  mediaFolder?.setActive(tab === 'media');
}
for (const id of inspectorTabs) {
  element(`${id}-tab`).addEventListener('click', () => setTab(id));
  element(`${id}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = inspectorTabs.indexOf(id);
      const next = event.key === 'Home' ? 'color' : event.key === 'End' ? 'camera' : inspectorTabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + inspectorTabs.length) % inspectorTabs.length];
      setTab(next); element(`${next}-tab`).focus();
    }
  });
}
function updateMediaStatus(kind: LayerKind, message: string, error?: boolean): void {
  const name = media.name(kind);
  element(`${kind}-name`).textContent = name || '素材は未設定';
  element(`${kind}-status`).textContent = message;
  element(`${kind}-status`).dataset.error = String(Boolean(error));
  element<HTMLFieldSetElement>(`${kind}-settings`).disabled = !media.has(kind);
  element<HTMLButtonElement>(`${kind}-remove`).disabled = !media.has(kind);
  element<HTMLInputElement>(`${kind}-visible`).checked = media.settings[kind].visible;
  needsDraw = true;
}
const media = new MediaLayers(updateMediaStatus);
const positionPercent = (value: number) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const keyPercent = (value: number) => `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
for (const kind of ['logo', 'video'] as const) {
  const config = media.settings[kind];
  const section = document.createElement('section'); section.className = 'media-slot';
  section.innerHTML = `<div class="media-heading"><h3>${kind === 'logo' ? 'ロゴ・画像' : '重ねる動画'}</h3><label class="check-row"><input id="${kind}-visible" type="checkbox" checked />表示</label></div>
    <p id="${kind}-name" class="file-name">素材は未設定</p>
    <input id="${kind}-file" class="sr-only" type="file" tabindex="-1" aria-label="${kind === 'logo' ? 'ロゴ画像' : '動画'}ファイル" accept="${kind === 'logo' ? '.png,.jpg,.jpeg,.webp,.gif,.svg' : '.mp4,.m4v,.webm'}" />
    <div class="file-actions"><button id="${kind}-upload" class="upload-button" type="button">${kind === 'logo' ? '画像を選ぶ' : '動画を選ぶ'}</button>${kind === 'logo' ? '<button id="sample-logo" type="button">サンプル</button>' : ''}<button id="${kind}-remove" type="button" disabled>外す</button></div>
    <p id="${kind}-status" class="media-status" role="status">${kind === 'logo' ? '透過PNG・JPEG・WebP・SVGなど' : 'MP4・WebM / 無音でループ再生'}</p>
    <fieldset id="${kind}-settings" class="layer-settings" disabled><legend class="sr-only">${kind === 'logo' ? 'ロゴ' : '動画'}の調整</legend>
      ${slider(`${kind}-opacity`, '不透明度', 0, 1, .01, config.opacity)}
      ${slider(`${kind}-scale`, 'サイズ', .1, kind === 'logo' ? 1 : 2, .01, config.scale)}
      ${kind === 'video' ? slider('video-playback-rate', '再生速度', .25, 4, .05, config.playbackRate ?? 1) : ''}
      ${slider(`${kind}-rotation`, '回転', -12, 12, .25, config.rotationSpeed)}
      <div class="setting-row"><label for="${kind}-blend">重ね方</label><select id="${kind}-blend"><option value="normal">通常</option><option value="remove-white">白を透過</option><option value="remove-black">黒を透過</option><option value="screen">スクリーン</option><option value="add">加算</option></select></div>
      <label class="check-row" title="音に合わせて大きさを変える"><input id="${kind}-react" type="checkbox" aria-label="${kind === 'logo' ? 'ロゴ' : '動画'}の大きさを音に合わせて変える" />音に反応</label>
      <div id="${kind}-key-controls" class="media-key-controls" hidden>
        ${slider(`${kind}-key-threshold`, '抜く範囲', 0, .5, .005, config.keyThreshold)}
        ${slider(`${kind}-key-softness`, '境界ぼかし', 0, 1, .01, config.keySoftness)}
      </div>
      <details class="media-position"><summary>位置を調整</summary>
        ${slider(`${kind}-position-x`, '左右', -.5, .5, .005, config.positionX)}
        ${slider(`${kind}-position-y`, '上下', -.5, .5, .005, config.positionY)}
        <button id="${kind}-center" type="button">中央に合わせる</button>
      </details>
    </fieldset>`;
  element('media-slots').append(section);
  element<HTMLInputElement>(`${kind}-file`).addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void mediaFolder?.loadFile(kind, file);
    input.value = '';
  });
  element(`${kind}-upload`).addEventListener('click', () => element<HTMLInputElement>(`${kind}-file`).click());
  element(`${kind}-remove`).addEventListener('click', () => mediaFolder?.remove(kind));
  if (kind === 'video') {
    updateSlider('video-playback-rate', value => `${value.toFixed(2)}×`);
    element('video-playback-rate').addEventListener('input', () => {
      config.playbackRate = Number(element<HTMLInputElement>('video-playback-rate').value);
      updateSlider('video-playback-rate', value => `${value.toFixed(2)}×`);
      needsDraw = true; mediaFolder?.settingsChanged('video', 'playbackRate');
    });
  }
  element(`${kind}-visible`).addEventListener('change', () => { config.visible = element<HTMLInputElement>(`${kind}-visible`).checked; needsDraw = true; mediaFolder?.settingsChanged(kind, 'visible'); });
  const controls = [
    { id: 'opacity', key: 'opacity', format: percent },
    { id: 'scale', key: 'scale', format: percent },
    { id: 'rotation', key: 'rotationSpeed', format: (value: number) => `${value.toFixed(1)} rpm` },
    { id: 'position-x', key: 'positionX', format: positionPercent },
    { id: 'position-y', key: 'positionY', format: positionPercent },
    { id: 'key-threshold', key: 'keyThreshold', format: keyPercent },
    { id: 'key-softness', key: 'keySoftness', format: percent },
  ] as const;
  for (const control of controls) {
    const id = `${kind}-${control.id}`;
    updateSlider(id, control.format);
    element(id).addEventListener('input', () => { config[control.key] = Number(element<HTMLInputElement>(id).value); updateSlider(id, control.format); needsDraw = true; mediaFolder?.settingsChanged(kind, control.key); });
  }
  element<HTMLSelectElement>(`${kind}-blend`).value = config.blend;
  element(`${kind}-blend`).addEventListener('change', () => {
    config.blend = element<HTMLSelectElement>(`${kind}-blend`).value as LayerBlend;
    element(`${kind}-key-controls`).hidden = !config.blend.startsWith('remove-');
    needsDraw = true; mediaFolder?.settingsChanged(kind, 'blend');
  });
  element(`${kind}-center`).addEventListener('click', () => {
    if (!media.alignCenter(kind)) {
      updateMediaStatus(kind, '位置を合わせる形が見つかりません。ロゴが見えるところで試してください。');
      return;
    }
    mediaFolder?.settingsChanged(kind, 'anchorX');
    mediaFolder?.settingsChanged(kind, 'anchorY');
    // Dispatch the same control events so folder and generated-logo saves agree.
    for (const [axis, value] of [['x', config.positionX], ['y', config.positionY]] as const) {
      const input = element<HTMLInputElement>(`${kind}-position-${axis}`);
      input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updateMediaStatus(kind, '表示中の形を中央に合わせました。左右・上下でも調整できます。');
  });
  element(`${kind}-react`).addEventListener('change', () => { config.audioReact = element<HTMLInputElement>(`${kind}-react`).checked; needsDraw = true; mediaFolder?.settingsChanged(kind, 'audioReact'); });
}
function syncMediaSettings(): void {
  for (const kind of ['logo', 'video'] as const) {
    const config = media.settings[kind];
    element<HTMLInputElement>(`${kind}-visible`).checked = config.visible;
    element<HTMLInputElement>(`${kind}-react`).checked = config.audioReact;
    element<HTMLSelectElement>(`${kind}-blend`).value = config.blend;
    element(`${kind}-key-controls`).hidden = !config.blend.startsWith('remove-');
    for (const [id, value, format] of [
      ['opacity', config.opacity, percent], ['scale', config.scale, percent],
      ['rotation', config.rotationSpeed, (value: number) => `${value.toFixed(1)} rpm`],
      ['position-x', config.positionX, positionPercent], ['position-y', config.positionY, positionPercent],
      ['key-threshold', config.keyThreshold, keyPercent],
      ['key-softness', config.keySoftness, percent],
    ] as const) {
      element<HTMLInputElement>(`${kind}-${id}`).value = String(value);
      updateSlider(`${kind}-${id}`, format);
    }
    if (kind === 'video') {
      element<HTMLInputElement>('video-playback-rate').value = String(config.playbackRate ?? 1);
      updateSlider('video-playback-rate', value => `${value.toFixed(2)}×`);
    }
  }
  needsDraw = true;
}
mediaFolder = new MediaFolder(element('media-folder'), media, syncMediaSettings, updateMediaStatus, (kind, generated) => {
  if (kind === 'logo' && !generated && logoPreferences.applied) {
    logoPreferences.applied = null;
    saveLogoPreferences();
  }
});
async function applyGeneratedLogo(design: LogoDesign, restoring = false): Promise<boolean> {
  const normalized = normalizeLogoDesign(design);
  const rendered = renderLogoDesign(normalized);
  if (rendered.empty) return false;
  // Encoding is synchronous so the normal media cancellation path starts before
  // another user action can overtake this apply request.
  const encoded = rendered.canvas.toDataURL('image/png').split(',')[1];
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const file = new File([bytes], '文字から作ったロゴ.png', { type: 'image/png' });
  const loaded = await mediaFolder!.loadGeneratedLogo(file);
  if (!loaded) return false;
  if (restoring) Object.assign(media.settings.logo, logoPreferences.layer);
  else if (media.settings.logo.blend.startsWith('remove-')) media.settings.logo.blend = 'normal';
  logoPreferences.applied = normalized;
  logoPreferences.layer = { ...media.settings.logo };
  saveLogoPreferences();
  syncMediaSettings();
  return true;
}
logoMakerControls = createLogoMakerControls(element('logo-maker-controls'), logoPreferences.draft, design => {
  logoPreferences.draft = design; saveLogoPreferences();
}, design => applyGeneratedLogo(design), () => settings.colors);
const logoLayerControls = new Set(['logo-visible', 'logo-opacity', 'logo-scale', 'logo-rotation', 'logo-blend', 'logo-react', 'logo-position-x', 'logo-position-y', 'logo-key-threshold', 'logo-key-softness']);
for (const event of ['input', 'change']) element('media-panel').addEventListener(event, event => {
  if (logoPreferences.applied && logoLayerControls.has((event.target as HTMLElement).id)) {
    logoPreferences.layer = { ...media.settings.logo };
    saveLogoPreferences();
  }
});
if (logoPreferences.applied) {
  void applyGeneratedLogo(logoPreferences.applied, true).finally(() => mediaFolder?.initialize());
} else void mediaFolder.initialize();
element('sample-logo').addEventListener('click', () => { void mediaFolder?.loadSampleLogo(); });

const camera = new CameraControls(() => {
  needsDraw = true;
  // Status may arrive during construction; wait until the instance is assigned.
  queueMicrotask(() => { cameraIsActive = camera.active; syncAutoStatus(); });
});
const output = new OutputWindow(canvas, notify);
element('output').addEventListener('click', () => { output.open(); needsDraw = true; });
function syncPause(): void {
  element('pause').innerHTML = `${paused ? '再生' : '一時停止'} <kbd>Space</kbd>`;
  element('pause').setAttribute('aria-pressed', String(paused));
  syncAutoStatus();
  needsDraw = true;
}
function togglePause(): void { paused = !paused; syncPause(); }
element('pause').addEventListener('click', togglePause);
syncPause();
if (reducedMotion) notify('動きを抑える設定に合わせて停止中です。「再生」で動かせます。');
function toggleControls(): void {
  hidden = !hidden; document.body.classList.toggle('ui-hidden', hidden);
  element<HTMLButtonElement>('restore').hidden = !hidden;
}
element('hide').addEventListener('click', toggleControls);
element('restore').addEventListener('click', toggleControls);
async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await element('app').requestFullscreen();
  } catch { notify('全画面にできませんでした。ブラウザの表示メニューから切り替えてください。', true); }
}
element('fullscreen').addEventListener('click', () => { void toggleFullscreen(); });
document.addEventListener('fullscreenchange', () => {
  element('fullscreen').innerHTML = `${document.fullscreenElement ? '全画面を終了' : '全画面'} <kbd>F</kbd>`;
});
function toggleBlackout(): void {
  blackedOut = !blackedOut;
  element('blackout-label').hidden = !blackedOut;
  element('blackout-button').setAttribute('aria-pressed', String(blackedOut));
  element('blackout-button').innerHTML = `${blackedOut ? '暗転を解除' : '暗転'} <kbd>B</kbd>`;
  needsDraw = true;
}
element('blackout-button').addEventListener('click', toggleBlackout);
element('reset').addEventListener('click', () => {
  Object.assign(settings, current.settings); sensitivity = 1; Object.assign(bandGains, DEFAULT_BAND_GAINS); settings.foregroundTrail = 0; settings.brightness = 1; settings.backgroundBrightness = DEFAULT_BACKGROUND_BRIGHTNESS;
  if (blackedOut) toggleBlackout();
  renderer?.clear(); syncMotion(); needsDraw = true; savePreferences();
  notify('動き・感度・明るさを初期値に戻しました。色と素材はそのままです。');
});
quality.addEventListener('change', () => {
  try { renderer?.resize(quality.value as 'auto' | 'high' | 'low'); needsDraw = true; }
  catch (error) { failRendering(error); }
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.matches('input, select, textarea') || target.isContentEditable) return;
  if (event.code === 'Space' && target.matches('button')) return;
  switch (event.code) {
    case 'Space': event.preventDefault(); togglePause(); break;
    case 'KeyH': toggleControls(); break;
    case 'KeyF': void toggleFullscreen(); break;
    case 'KeyB': toggleBlackout(); break;
    case 'ArrowRight': if (!target.closest('[role=tablist]')) { event.preventDefault(); nextPreset(); } break;
    case 'Escape': if (hidden) toggleControls(); if (blackedOut) toggleBlackout(); break;
  }
});

function failRendering(error: unknown): void {
  console.error(error);
  renderError.textContent = error instanceof Error ? error.message : '描画を開始できませんでした。再読み込みしてください。';
  renderError.hidden = false; micButton.disabled = true;
  audio.stop(); camera.setAvailable(false); output.close();
}
function initRenderer(): void {
  try {
    renderer = new VisualRenderer(canvas);
    renderer.resize(quality.value as 'auto' | 'high' | 'low');
    renderer.setPreset(current, 0);
    camera.setAvailable(true);
    renderError.hidden = true; micButton.disabled = false; needsDraw = true;
  } catch (error) { renderer = null; failRendering(error); }
}
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault(); renderer?.dispose(); renderer = null;
  failRendering(new Error('描画が中断されました。復旧を待っています。戻らない場合は再読み込みしてください。'));
});
canvas.addEventListener('webglcontextrestored', initRenderer);
function frame(now: number): void {
  const elapsed = Math.max(0, (now - previous) / 1000);
  const dt = Math.min(.05, elapsed); previous = now;
  if (!paused) { time += dt; if (auto && !document.hidden) autoElapsed += elapsed; }
  const features = audio.sample(dt, sensitivity, bandGains);
  const cameraMotion = camera.update(now, paused || document.hidden ? 0 : elapsed);
  const cameraPresentation = camera.presentationFrame();
  cameraIsActive = camera.active;
  const layers = media.frames(elapsed, features.level, paused);
  const interval = Number(element<HTMLSelectElement>('auto-interval').value);
  if (auto && autoElapsed >= interval) nextPreset();
  if (renderer && (!paused || needsDraw)) {
    try {
      renderer.render(time, paused ? 0 : elapsed, features, { ...settings, ...cameraMotion, ...cameraPresentation, brightness: blackedOut ? 0 : settings.brightness }, layers);
      needsDraw = false; frames++;
    } catch (error) { renderer.dispose(); renderer = null; failRendering(error); }
  }
  const cameraPolicy = cameraLayerPolicy(current.id, cameraPresentation.performanceMode, cameraIsActive, cameraPresentation.liveOpacity);
  const cameraVisible = renderer?.hasCameraOutput === true;
  const outputMessage = blackedOut && cameraVisible ? '暗転中です。カメラは動作しています。'
    : cameraVisible && !cameraPolicy.cameraVisible ? 'カメラ映像を出力中 · 切替中'
    : cameraVisible ? cameraPolicy.cameraBackground ? 'カメラ背景を出力中 · 二重には重ねません' : `カメラ映像を出力中 · 常時カメラON ${Math.round(cameraPolicy.overlayOpacity * 100)}%`
    : cameraPolicy.fallback ? 'カメラ停止中 · 代替の背景を表示しています。'
    : cameraPresentation.performanceMode === 'live' && !cameraIsActive ? '常時カメラON · カメラを開始すると演者を重ねます。'
    : 'カメラ映像は出力していません。';
  const outputStatus = element('camera-output-status');
  if (outputStatus.textContent !== outputMessage) outputStatus.textContent = outputMessage;
  outputStatus.dataset.active = String(cameraVisible && !blackedOut);
  const cameraBadge = element('camera-output-badge');
  cameraBadge.hidden = !cameraVisible || blackedOut;
  cameraBadge.textContent = paused ? 'カメラ映像 · 静止中' : 'カメラ映像 · 出力中';
  if (now - lastMeterUpdate > 80) {
    meters.forEach((meter, i) => { meter.value = features[(['low', 'mid', 'high'] as const)[i]]; });
    lastMeterUpdate = now;
  }
  if (now - fpsStarted >= 1000) {
    element('fps').textContent = paused ? '停止中' : `${Math.round(frames * 1000 / (now - fpsStarted))} fps`;
    fpsStarted = now; frames = 0;
    syncAutoStatus();
  }
  frameId = requestAnimationFrame(frame);
}

// Render static, accurate thumbnails with one reusable small WebGL context.
let thumbnailRevision = 0;
async function createThumbnails(): Promise<void> {
  const ticket = ++thumbnailRevision;
  const look = settings.look;
  const preview = document.createElement('canvas');
  let painter: VisualRenderer | null = null;
  try {
    painter = new VisualRenderer(preview); painter.resize('low', 256);
    for (const preset of PRESETS) {
      if (ticket !== thumbnailRevision) break;
      painter.setPreset(preset, 0); painter.clear();
      const still: VisualSettings = { ...preset.settings, trail: 0, brightness: 1, backgroundBrightness: DEFAULT_BACKGROUND_BRIGHTNESS, look, colors: [...preset.colors] };
      // The background uses ambient motion; audio only gives the foreground a representative pose.
      painter.render(0, 1 / 30, { level: .55, low: .42, mid: .48, high: .38, pulse: .2 }, still);
      thumbImages.get(preset.id)!.src = preview.toDataURL('image/png');
      await new Promise<void>(resolve => setTimeout(resolve, 30));
    }
  } catch { /* A preview allocation failure must not interrupt the main output. */ }
  finally {
    painter?.dispose();
    // Thumbnail canvases are short lived; release their contexts immediately
    // so repeated look changes cannot evict the live output's WebGL context.
    preview.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

document.addEventListener('visibilitychange', () => { previous = performance.now(); });
window.addEventListener('pagehide', () => { audio.stop(); camera.stop(); mediaFolder?.dispose(); media.dispose(); output.dispose(); });
initRenderer();
frameId = requestAnimationFrame(frame);
void createThumbnails();
if (import.meta.hot) import.meta.hot.dispose(() => {
  logoMakerControls?.dispose();
  cancelAnimationFrame(frameId); audio.stop(); camera.dispose(); mediaFolder?.dispose(); media.dispose(); output.dispose(); renderer?.dispose();
  navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
});
