/** Local font recipes shared by text artwork; no animation or saved state. */
export type TextFont = 'gothic-bold' | 'gothic' | 'rounded' | 'mincho' | 'monospace';
export const TEXT_FONTS: readonly { id: TextFont; label: string; family: string; weight: number }[] = [
  { id: 'gothic-bold', label: '太いゴシック', family: '"Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif', weight: 900 },
  { id: 'gothic', label: 'ゴシック', family: '"Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif', weight: 500 },
  { id: 'rounded', label: '丸ゴシック', family: '"Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif', weight: 700 },
  { id: 'mincho', label: '明朝', family: '"Hiragino Mincho ProN", "Yu Mincho", serif', weight: 600 },
  { id: 'monospace', label: '等幅', family: 'Menlo, "Osaka-Mono", "MS Gothic", monospace', weight: 700 },
];
export const MAX_TEXT_CHARACTERS = 120;

/** Normalize pasted line breaks and bound work without splitting Unicode pairs. */
export function normalizeText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n').slice(0, 2).join('\n')).slice(0, MAX_TEXT_CHARACTERS).join('');
}
