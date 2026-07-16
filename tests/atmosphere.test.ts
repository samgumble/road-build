import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_MAX_TIMESCALE,
  ambientFillForElevation,
  atmosphereTimeScale,
  environmentFillForElevation,
  exposureForElevation,
  solarTimeOfDay,
  sunElevation,
} from '../src/render/solarTime';

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

describe('continuous lighting adaptation', () => {
  it('keeps useful ambient form through twilight without flattening midday', () => {
    expect(ambientFillForElevation(1)).toBeCloseTo(0.46, 6);
    expect(ambientFillForElevation(0)).toBeCloseTo(0.38, 6);
    expect(ambientFillForElevation(-1)).toBeCloseTo(0.28, 6);
  });

  it('raises exposure gradually as the sun falls instead of crushing dusk and night', () => {
    expect(exposureForElevation(1)).toBeCloseTo(1, 6);
    expect(exposureForElevation(0)).toBeGreaterThan(1.04);
    expect(exposureForElevation(-1)).toBeCloseTo(1.12, 6);
  });

  it('keeps procedural environment fill restrained but present overnight', () => {
    expect(environmentFillForElevation(1)).toBeCloseTo(0.24, 6);
    expect(environmentFillForElevation(0)).toBeCloseTo(0.16, 6);
    expect(environmentFillForElevation(-1)).toBeCloseTo(0.06, 6);
  });
});
