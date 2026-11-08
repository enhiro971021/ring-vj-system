import { normalizeHex } from './color.ts';
import { normalizeText, TEXT_FONTS, type TextFont } from './text-fonts.ts';

export type LogoTemplate = 'circle' | 'hexagon' | 'lines' | 'plain';
export interface LogoDesign { text: string; font: TextFont; color: string; template: LogoTemplate }
export interface RenderedLogoDesign {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  empty: boolean;
  design: LogoDesign;
}
export const LOGO_TEMPLATES: readonly { id: LogoTemplate; label: string }[] = [
  { id: 'circle', label: '円形' },
  { id: 'hexagon', label: '六角形' },
  { id: 'lines', label: '上下ライン' },
  { id: 'plain', label: '文字のみ' },
];
export const DEFAULT_LOGO_DESIGN: Readonly<LogoDesign> = Object.freeze({
  text: 'VJ', font: 'gothic-bold', color: '#ffffff', template: 'circle',
});
const SIZE = 1024;
const CENTER = SIZE / 2;
const TAU = Math.PI * 2;
const BASE_FONT_SIZE = 330;
const LINE_HEIGHT = BASE_FONT_SIZE * 1.18;

/** Pure validation shared by saved drafts and the local logo renderer. */
export function normalizeLogoDesign(value: unknown): LogoDesign {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    text: typeof saved.text === 'string' ? normalizeText(saved.text) : DEFAULT_LOGO_DESIGN.text,
    font: TEXT_FONTS.some(font => font.id === saved.font) ? saved.font as TextFont : DEFAULT_LOGO_DESIGN.font,
    color: typeof saved.color === 'string' ? normalizeHex(saved.color) ?? DEFAULT_LOGO_DESIGN.color : DEFAULT_LOGO_DESIGN.color,
    template: LOGO_TEMPLATES.some(template => template.id === saved.template) ? saved.template as LogoTemplate : DEFAULT_LOGO_DESIGN.template,
  };
}

/** Draw transparent, local artwork once when its design changes. No 3D or media state. */
export function renderLogoDesign(value: LogoDesign, canvas: HTMLCanvasElement = document.createElement('canvas')): RenderedLogoDesign {
  const design = normalizeLogoDesign(value);
  canvas.width = canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ロゴを描くキャンバスを作成できません。');
  const result = { canvas, width: SIZE, height: SIZE, empty: !design.text.trim(), design };
  // Resizing clears all pixels and context state, including on a reused canvas.
  if (result.empty) return result;
  context.strokeStyle = design.color;
  context.fillStyle = design.color;

  if (design.template === 'circle') {
    context.lineWidth = 20;
    context.beginPath(); context.arc(CENTER, CENTER, 404, 0, TAU); context.stroke();
    context.lineWidth = 5;
    context.beginPath(); context.arc(CENTER, CENTER, 440, 0, TAU); context.stroke();
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * TAU;
      context.beginPath();
      context.arc(CENTER + Math.cos(angle) * 355, CENTER + Math.sin(angle) * 355, 8, 0, TAU);
      context.fill();
    }
  } else if (design.template === 'hexagon') {
    for (const [radius, stroke] of [[404, 20], [440, 5]]) {
      context.lineWidth = stroke;
      context.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = i / 6 * TAU - Math.PI / 2;
        const x = CENTER + Math.cos(angle) * radius, y = CENTER + Math.sin(angle) * radius;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath(); context.stroke();
    }
  } else if (design.template === 'lines') {
    context.lineWidth = 20;
    context.lineCap = 'round';
    for (const y of [292, 732]) {
      context.beginPath(); context.moveTo(128, y); context.lineTo(896, y); context.stroke();
    }
  }

  const font = TEXT_FONTS.find(font => font.id === design.font)!;
  context.font = `${font.weight} ${BASE_FONT_SIZE}px ${font.family}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const lines = design.text.split('\n').map((text, i) => {
    const metrics = context.measureText(text);
    const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
    const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : BASE_FONT_SIZE * .8;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : BASE_FONT_SIZE * .2;
    const baseline = i * LINE_HEIGHT;
    return { text, left, width: Math.max(1, left + right), baseline, top: baseline - ascent, bottom: baseline + descent };
  });
  const top = Math.min(...lines.map(line => line.top)), bottom = Math.max(...lines.map(line => line.bottom));
  const measuredWidth = Math.max(...lines.map(line => line.width));
  // These boxes keep text away from frames and the circle's eight inner dots.
  const framed = design.template === 'circle' || design.template === 'hexagon';
  const boxWidth = design.template === 'hexagon' ? 580 : framed ? 600 : design.template === 'lines' ? 760 : 800;
  const boxHeight = design.template === 'hexagon' ? 420 : framed ? 440 : design.template === 'lines' ? 360 : 760;
  const scale = Math.min(1, boxWidth / measuredWidth, boxHeight / Math.max(1, bottom - top));
  const centerY = design.template === 'circle' ? 525 : CENTER;
  context.font = `${font.weight} ${BASE_FONT_SIZE * scale}px ${font.family}`;
  for (const line of lines) {
    context.fillText(line.text,
      CENTER + (-line.width / 2 + line.left) * scale,
      centerY + (line.baseline - (top + bottom) / 2) * scale);
  }
  return result;
}
