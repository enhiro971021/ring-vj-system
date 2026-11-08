type Blend = 'normal' | 'screen' | 'add' | 'remove-white' | 'remove-black';
export type MediaContentCenter = { x: number; y: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Bounds of the visible content; source coordinates start at the top left. */
export function findMediaContentCenter(pixels: Uint8ClampedArray, width: number, height: number, blend: Blend, keyThreshold = .2, keySoftness = .25): MediaContentCenter | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;
  const threshold = Number.isFinite(keyThreshold) ? clamp(keyThreshold, 0, .5) : .2;
  const feather = Math.max(.001, (Number.isFinite(keySoftness) ? clamp(keySoftness, 0, 1) : .25) * .1);
  const start = Math.max(0, threshold - .025), end = start + feather;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    let alpha = pixels[offset + 3] / 255;
    if (alpha < .1) continue;
    const r = pixels[offset] / 255, g = pixels[offset + 1] / 255, b = pixels[offset + 2] / 255;
    if (blend === 'remove-white' || blend === 'remove-black') {
      const distance = blend === 'remove-white' ? 1 - Math.min(r, g, b) : Math.max(r, g, b);
      // Match the shader's smooth key edge; faint compression noise is excluded.
      const t = clamp((distance - start) / (end - start), 0, 1);
      alpha *= t * t * (3 - 2 * t);
    } else if (blend === 'screen' || blend === 'add') alpha *= Math.max(r, g, b);
    if (alpha < .1) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: (minX + maxX + 1) / (2 * width), y: (minY + maxY + 1) / (2 * height) };
}
