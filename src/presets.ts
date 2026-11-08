export type ColorPalette = [string, string, string];
export type VisualLook = 'graphic' | 'neon';
export const LOOKS: { id: VisualLook; label: string; description: string }[] = [
  { id: 'graphic', label: '鮮色グラフィック', description: '鮮やかな色面と、切れのある陰影。' },
  { id: 'neon', label: 'ネオン立体', description: '深い背景に、光と反射が浮かぶ。' },
];
export interface ScenePreset {
  id: string;
  name: string;
  description: string;
  pattern: number;
  variant: number;
  colors: ColorPalette;
  settings: { warp: number; trail: number; speed: number };
}

/** Mid-chroma OKLCH palettes: color stays distinct; background luma is capped at output. */
export const PALETTES: { id: string; name: string; colors: ColorPalette }[] = [
  // Red subject, lavender sky, pale pink light.
  { id: 'flyer', name: 'フライヤー', colors: ['#e64f47', '#c9bbe3', '#ffd9d6'] },
  { id: 'original', name: '深緑と朱', colors: ['#458955', '#c8664e', '#94a463'] },
  { id: 'cobalt', name: '群青と空', colors: ['#347ec4', '#7a97d7', '#49a3b8'] },
  { id: 'candy', name: '紫と桃', colors: ['#8d6cc2', '#c97aaf', '#865691'] },
  { id: 'amber', name: '琥珀と金', colors: ['#bc961a', '#b47825', '#827d39'] },
  { id: 'crimson', name: '深紅', colors: ['#b64e53', '#c56f99', '#8b492a'] },
  { id: 'mono', name: '灰と白', colors: ['#5d5d5d', '#808080', '#9b9b9b'] },
  { id: 'sakura', name: '桜', colors: ['#cc79a9', '#c46378', '#94669f'] },
  { id: 'ice', name: '氷', colors: ['#37a6b7', '#2987b5', '#4baaa5'] },
  { id: 'jade', name: '翡翠', colors: ['#629742', '#46b37c', '#9d9f37'] },
  { id: 'sunset', name: '夕焼け', colors: ['#d07843', '#90589d', '#bf5e61'] },
  { id: 'flame', name: '炎', colors: ['#a64831', '#c28e24', '#ba6826'] },
  { id: 'indigo', name: '藍', colors: ['#4f5aac', '#827ece', '#3f7dae'] },
];

export const PRESETS: ScenePreset[] = [
  { id: 'mist-rings', name: '霧', description: '深緑に薄い朱を混ぜた霧が、音と独立して漂う', pattern: 15, variant: 0, colors: ['#33b373', '#f23814', '#fafcff'], settings: { warp: 1, trail: 0, speed: 1 } },
  { id: 'flow', name: '流紋', description: '精密な点の列が、一つの大きな曲面として波打つ', pattern: 0, variant: 0, colors: ['#42e9d5', '#215cff', '#f1ffff'], settings: { warp: 0.85, trail: 0.08, speed: 0.65 } },
  { id: 'aurora', name: '光の幕', description: '奥行きの異なる光の幕を、遅れて届く波が貫く', pattern: 10, variant: 0, colors: ['#f24250', '#6b51ff', '#ffffff'], settings: { warp: 0.7, trail: 0.08, speed: 0.7 } },
  { id: 'starlight', name: '群体', description: '編まれた流線の束が、画面の端から端へ流れる', pattern: 11, variant: 0, colors: ['#267aff', '#e4f5ff', '#ff462e'], settings: { warp: 0.35, trail: 0.08, speed: 0.65 } },
  { id: 'razor', name: '変形格子', description: '空間を覆う格子が、離れた二つの力場で曲がる', pattern: 3, variant: 0, colors: ['#54c7e1', '#e7f8ff', '#a789ff'], settings: { warp: 0.8, trail: 0.06, speed: 0.7 } },
  { id: 'plasma', name: '結節', description: 'シアンの長い軌跡が絡まり、赤い結び目に集まる', pattern: 13, variant: 0, colors: ['#168da9', '#f02c70', '#ffce70'], settings: { warp: 0.9, trail: 0.06, speed: 0.8 } },
  { id: 'current', name: '潮流', description: '斜めに流れる帯が、画面の端から端までゆるやかに曲がる', pattern: 16, variant: 0, colors: ['#2f7f8a', '#4a3f7a', '#dff7ff'], settings: { warp: 0.6, trail: 0.04, speed: 0.7 } },
  { id: 'dots', name: 'ドットの波', description: '平らな丸の格子を、大きさの波が横切っていく', pattern: 18, variant: 0, colors: ['#ff7a9a', '#4fc3c7', '#fff5a0'], settings: { warp: 0.3, trail: 0.0, speed: 0.8 } },
  { id: 'origami', name: '折り紙', description: '四角いタイルが順にめくれて、表と裏の色が入れ替わる', pattern: 19, variant: 0, colors: ['#f2b544', '#3a5ad1', '#ffffff'], settings: { warp: 0.3, trail: 0.0, speed: 0.75 } },
  { id: 'ridges', name: '山並み', description: '薄紫の空の下に、赤い山の稜線が何層にも重なって流れる', pattern: 20, variant: 0, colors: ['#e5433f', '#c9bbe3', '#ffd9d6'], settings: { warp: 0.4, trail: 0.0, speed: 0.6 } },
  { id: 'prismatic', name: '光の屈折', description: '青緑と紫の柔らかな光面が流れ、境目に屈折した色が浮かぶ', pattern: 21, variant: 0, colors: ['#07bcb0', '#4930ce', '#ed57a4'], settings: { warp: 0.65, trail: 0.03, speed: 0.75 } },
  { id: 'ink', name: 'にじむインク', description: '大きな色面がゆっくり膨らみ、境界でにじみながら混ざり合う', pattern: 22, variant: 0, colors: ['#ed2440', '#1727ba', '#9b37ba'], settings: { warp: 0.65, trail: 0.02, speed: 0.7 } },
  { id: 'ribbons', name: '細胞', description: '大小のセルが密度を変えながら、連続した膜を作る', pattern: 14, variant: 0, colors: ['#858da8', '#c9ccd9', '#5b6480'], settings: { warp: 0.7, trail: 0.05, speed: 0.7 } },
  { id: 'camera-duotone', name: 'カメラ・デュオトーン', description: 'カメラの姿を柔らかな色面と陰影に変える', pattern: 100, variant: 0, colors: ['#347ec4', '#7a97d7', '#49a3b8'], settings: { warp: 0, trail: 0.05, speed: 1 } },
  { id: 'camera-halftone', name: 'カメラ・ハーフトーン', description: 'カメラの姿を配色に合わせた細かな網点で描く', pattern: 101, variant: 0, colors: ['#8d6cc2', '#c97aaf', '#865691'], settings: { warp: 0, trail: 0.05, speed: 1 } },
];

/** Exact sRGB components for uniforms; malformed saved colors get a safe fallback. */
export function hexToRgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return [1, 1, 1];
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}
