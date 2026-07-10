import { describe, expect, it } from 'vitest';
import { solarTimeOfDay, sunElevation } from '../src/render/solarTime';

describe('asymmetric day/night timing', () => {
  it('keeps the sun above the horizon for about two thirds of the cycle', () => {
    const samples = 3600;
    let daylightSamples = 0;
    for (let i = 0; i < samples; i++) {
      if (sunElevation(i / samples) >= 0) daylightSamples++;
    }
    expect(daylightSamples / samples).toBeCloseTo(2 / 3, 2);
  });

  it('preserves a smooth sunrise, noon peak, sunset, and midnight trough', () => {
    expect(sunElevation(1 / 6)).toBeCloseTo(0, 8);
    expect(sunElevation(0.5)).toBeCloseTo(1, 8);
    expect(sunElevation(5 / 6)).toBeCloseTo(0, 8);
    expect(sunElevation(0)).toBeCloseTo(-1, 8);
    expect(solarTimeOfDay(1)).toBeCloseTo(solarTimeOfDay(0), 10);
  });
});
