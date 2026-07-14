import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_MAX_TIMESCALE, atmosphereTimeScale, solarTimeOfDay, sunElevation } from '../src/render/solarTime';

describe('calm lighting at high sim speeds', () => {
  it('passes normal speeds through and caps fast-forward at the atmosphere ceiling', () => {
    expect(atmosphereTimeScale(1)).toBe(1);
    expect(atmosphereTimeScale(4)).toBe(4);
    // 16x sim speed must NOT strobe the day/night cycle — lighting caps at the ceiling
    expect(atmosphereTimeScale(16)).toBe(ATMOSPHERE_MAX_TIMESCALE);
    expect(ATMOSPHERE_MAX_TIMESCALE).toBeLessThanOrEqual(4);
  });
});

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
