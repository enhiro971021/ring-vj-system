import { normalizeHex } from './color';
import type { ColorPalette, VisualLook } from './presets';

/** Labels describe the independently coloured parts in the custom shader path. */
const PARTS: Record<string, [string, string, string]> = {
  'camera-duotone': ['映像の暗部', '映像の明部', 'きらめき'],
  'camera-halftone': ['網点の暗部', '網点の明部', 'きらめき'],
  'mist-rings': ['霧', '霧の朱', '霧の明部'],
  flow: ['曲面の主色', '曲面の副色', 'きらめき'],
  aurora: ['幕の主色', '幕の副色', 'きらめき'],
  starlight: ['流線の主色', '流線の副色', 'きらめき'],
  razor: ['壁の格子', '床の格子', 'きらめき'],
  plasma: ['軌跡', '結び目', 'きらめき'],
  ribbons: ['セルの色1', 'セルの色2', 'セルの色3'],
  prismatic: ['透過する光', '光面の色', '屈折する縁'],
  ink: ['インクの主色', 'インクの副色', '混ざり合う色'],
};

export function defaultBackground(preset: string, look: VisualLook): string {
  if (preset === 'mist-rings') return '#000000';
  if (preset === 'ribbons' && look === 'graphic') return '#202226';
  return '#020305';
}

export class ColorControls {
  private readonly rows: { native: HTMLInputElement; hex: HTMLInputElement; label: HTMLElement; row: HTMLElement }[];
  private values: string[] = [];

  constructor(root: HTMLElement, private readonly onChange: (slot: number, color: string) => void) {
    root.innerHTML = Array.from({ length: 4 }, (_, slot) => `
      <div class="color-control">
        <label class="color-part" for="part-color-${slot}" id="part-label-${slot}"></label>
        <div class="color-fields">
          <input id="part-color-${slot}" type="color" aria-labelledby="part-label-${slot}" />
          <label class="color-hex-wrap"><span class="sr-only" id="part-hex-label-${slot}"></span>
            <input id="part-hex-${slot}" class="color-hex" type="text" spellcheck="false" autocomplete="off" maxlength="16" aria-labelledby="part-hex-label-${slot}" aria-describedby="color-format" />
          </label>
        </div>
      </div>`).join('');
    this.rows = Array.from(root.querySelectorAll<HTMLElement>('.color-control'), row => ({
      row, label: row.querySelector<HTMLElement>('.color-part')!,
      native: row.querySelector<HTMLInputElement>('input[type=color]')!,
      hex: row.querySelector<HTMLInputElement>('input[type=text]')!,
    }));
    this.rows.forEach(({ native, hex }, slot) => {
      native.addEventListener('input', () => this.commit(slot, native.value));
      // Complete six-digit values preview immediately; shorthand commits on Enter/blur.
      hex.addEventListener('input', () => {
        hex.removeAttribute('aria-invalid');
        if (/^#?[0-9a-f]{6}$/i.test(hex.value.trim())) this.commit(slot, hex.value, true);
      });
      hex.addEventListener('change', () => this.commit(slot, hex.value));
      hex.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); this.commit(slot, hex.value); }
        if (event.key === 'Escape') { hex.value = this.values[slot]; hex.removeAttribute('aria-invalid'); }
      });
    });
  }

  private commit(slot: number, value: string, keepDraft = false): void {
    const hex = this.rows[slot].hex;
    const color = normalizeHex(value);
    if (!color) {
      hex.setAttribute('aria-invalid', 'true');
      return;
    }
    const draft = hex.value;
    hex.removeAttribute('aria-invalid');
    this.onChange(slot, color);
    hex.value = keepDraft ? draft : color;
  }

  sync(preset: string, colors: ColorPalette, background: string): void {
    this.values = [background, ...colors];
    const labels = ['背景', ...(PARTS[preset] ?? PARTS.flow)];
    this.rows.forEach(({ row, label, native, hex }, slot) => {
      const changed = native.value !== this.values[slot];
      label.textContent = labels[slot];
      row.querySelector<HTMLElement>('.sr-only')!.textContent = `${labels[slot]}のカラーコード`;
      native.value = this.values[slot];
      if (changed || document.activeElement !== hex) {
        hex.value = this.values[slot];
        hex.removeAttribute('aria-invalid');
      }
    });
  }
}
