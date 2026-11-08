/** User gain is applied after background fading, including the outgoing frame. */
export const DEFAULT_BACKGROUND_BRIGHTNESS = 1.75;

/** Exposure, contrast and soft luma ceiling for backgrounds underneath white rings.
 * The ceiling is approached asymptotically (see blend.frag), never clamped, so
 * bright palettes keep their tonal order instead of flattening into grey.
 * Applied to the incoming background before crossfade; stored outgoing frames
 * already carry their own treatment. Geometry and audio response stay intact.
 */
export const BACKGROUND_TREATMENTS: Readonly<Record<string, readonly [number, number, number]>> = {
  'mist-rings': [.70, 1.04, .50],
  flow: [.78, 1.00, .50],
  aurora: [.78, 1.00, .50],
  starlight: [.78, 1.00, .55],
  razor: [.72, 1.00, .55],
  plasma: [.82, 1.00, .55],
  ribbons: [.50, 1.04, .55],
  current: [.55, 1.0, .55],
  dots: [.50, 1.04, .55],
  origami: [.50, 1.04, .55],
  ridges: [.70, 1.00, .55],
  prismatic: [.80, 1.00, .45],
  ink: [.76, 1.00, .45],
};
