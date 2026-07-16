export const RESTRAINED_GRADE = Object.freeze({
  saturation: 0.96,
  contrast: 1.02,
  warmth: 0.006,
});

export type LinearRgb = readonly [number, number, number];

/** CPU twin of the high-tier post grade. It is intentionally slight: gently unifies the palette
 * while preserving the orange construction language and blue water/sky separation. */
export function gradeLinearColor(color: LinearRgb): [number, number, number] {
  const [r, g, b] = color;
  const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const saturated = [
    luma + (r - luma) * RESTRAINED_GRADE.saturation,
    luma + (g - luma) * RESTRAINED_GRADE.saturation,
    luma + (b - luma) * RESTRAINED_GRADE.saturation,
  ];
  const warmth = [RESTRAINED_GRADE.warmth, RESTRAINED_GRADE.warmth * 0.15, -RESTRAINED_GRADE.warmth * 0.65];
  return saturated.map((channel, i) => Math.max(
    0,
    Math.min(1, (channel - 0.5) * RESTRAINED_GRADE.contrast + 0.5 + warmth[i]),
  )) as [number, number, number];
}
