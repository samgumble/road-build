import { describe, expect, it } from 'vitest';
import { gradeLinearColor, RESTRAINED_GRADE } from '../src/render/colorGrade';
import { rainVisibility } from '../src/render/weatherTuning';

describe('weather legibility', () => {
  it('preserves the dry atmosphere exactly and clamps a full storm to gameplay-safe fog floors', () => {
    expect(rainVisibility(0, 620, 900)).toEqual({ fogNear: 620, fogFar: 900, sunScale: 1 });

    const drizzle = rainVisibility(0.5, 620, 900);
    const storm = rainVisibility(1, 620, 900);
    expect(drizzle.fogNear).toBeLessThan(620);
    expect(drizzle.fogFar).toBeLessThan(900);
    expect(storm.fogNear).toBeGreaterThanOrEqual(480);
    expect(storm.fogFar).toBeGreaterThanOrEqual(720);
    expect(storm.sunScale).toBeGreaterThanOrEqual(0.65);
    expect(storm.fogNear).toBeLessThan(storm.fogFar);
  });

  it('keeps the high-tier grade restrained, bounded, and slightly less saturated', () => {
    const neutral = gradeLinearColor([0.5, 0.5, 0.5]);
    const red = gradeLinearColor([0.9, 0.2, 0.2]);
    const inputChroma = 0.9 - 0.2;
    const outputChroma = Math.max(...red) - Math.min(...red);

    expect(RESTRAINED_GRADE.saturation).toBeGreaterThanOrEqual(0.94);
    expect(RESTRAINED_GRADE.contrast).toBeLessThanOrEqual(1.04);
    expect(Math.max(...neutral.map((channel) => Math.abs(channel - 0.5)))).toBeLessThan(0.03);
    expect(outputChroma).toBeLessThan(inputChroma);
    for (const channel of [...neutral, ...red]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});
