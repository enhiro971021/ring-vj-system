/** Scale xy and offset xy for a centred CSS-style `cover` crop.
 * Coordinates are bottom-up texture UVs; the upload handles the vertical flip.
 * A negative horizontal scale mirrors the crop around the source centre.
 */
export function cameraCoverTransform(
  sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number, mirror = true,
): [number, number, number, number] {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every(v => Number.isFinite(v) && v > 0)) {
    return mirror ? [-1, 1, 1, 0] : [1, 1, 0, 0];
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const outputAspect = outputWidth / outputHeight;
  const scaleX = Math.min(1, outputAspect / sourceAspect) * (mirror ? -1 : 1);
  const scaleY = Math.min(1, sourceAspect / outputAspect);
  return [scaleX, scaleY, (1 - scaleX) * .5, (1 - scaleY) * .5];
}
