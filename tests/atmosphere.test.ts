import { describe, expect, it } from 'vitest';
import { WEATHER_PROFILES } from '../src/core/weather';
import {
  weatherAtmosphereValues,
  weatherCloudWeight,
  weatherRainVertexCount,
} from '../src/render/weatherTuning';
import {
  ATMOSPHERE_MAX_TIMESCALE,
  ambientFillForElevation,
  atmosphereTimeScale,
  environmentFillForElevation,
  exposureForElevation,
  solarTimeOfDay,
  sunElevation,
} from '../src/render/solarTime';

describe('blended weather atmosphere composition', () => {
  it('keeps clear weather identical to the authored atmosphere values', () => {
    const values = weatherAtmosphereValues(WEATHER_PROFILES.clear, 620, 900);
    expect(values.fogNear).toBe(620);
    expect(values.fogFar).toBe(900);
    expect(values.sunScale).toBe(1);
    expect(values.hemiScale).toBe(1);
    expect(values.rainOpacity).toBe(0);
  });

  it('preserves the island-scale visibility and solar-key floors in heavy rain', () => {
    const values = weatherAtmosphereValues(WEATHER_PROFILES['heavy-rain'], 620, 900);
    const light = weatherAtmosphereValues(WEATHER_PROFILES['light-rain'], 620, 900);
    expect(values.fogNear).toBeGreaterThanOrEqual(480);
    expect(values.fogFar).toBeGreaterThanOrEqual(720);
    expect(values.fogNear).toBeLessThan(light.fogNear);
    expect(values.fogFar).toBeLessThan(light.fogFar);
    expect(values.sunScale).toBeGreaterThanOrEqual(0.65);
    expect(values.rainOpacity).toBeGreaterThan(0.8);
  });

  it('makes coastal fog denser than heavy rain without drawing rain streaks', () => {
    const fog = weatherAtmosphereValues(WEATHER_PROFILES['coastal-fog'], 620, 900);
    const rain = weatherAtmosphereValues(WEATHER_PROFILES['heavy-rain'], 620, 900);
    expect(fog.fogNear).toBeGreaterThanOrEqual(380);
    expect(fog.fogFar).toBeGreaterThanOrEqual(620);
    expect(fog.fogFar).toBeLessThan(rain.fogFar);
    expect(fog.rainOpacity).toBe(0);
  });

  it('changes continuously when rain begins inside an already overcast blend', () => {
    const base = { ...WEATHER_PROFILES.overcast };
    const dry = weatherAtmosphereValues({ ...base, rain: 0 }, 620, 900);
    const trace = weatherAtmosphereValues({ ...base, rain: 0.001 }, 620, 900);
    expect(Math.abs(trace.fogNear - dry.fogNear)).toBeLessThan(1);
    expect(Math.abs(trace.fogFar - dry.fogFar)).toBeLessThan(1);
    expect(Math.abs(trace.sunScale - dry.sunScale)).toBeLessThan(0.01);
  });

  it('keeps fog ordered and all presentation scales bounded across every profile', () => {
    for (const snapshot of Object.values(WEATHER_PROFILES)) {
      const values = weatherAtmosphereValues(snapshot, 620, 900);
      expect(values.fogNear).toBeLessThan(values.fogFar);
      for (const key of ['sunScale', 'hemiScale', 'cloudOpacity', 'rainOpacity'] as const) {
        expect(values[key]).toBeGreaterThanOrEqual(0);
        expect(values[key]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fades cloud groups at coverage boundaries and bounds rain draw cardinality', () => {
    expect(weatherCloudWeight(0.5, 3, 9)).toBe(1);
    expect(weatherCloudWeight(0.5, 4, 9)).toBe(0.5);
    expect(weatherCloudWeight(0.5, 5, 9)).toBe(0);
    expect(weatherRainVertexCount(0, 1500)).toBe(0);
    expect(weatherRainVertexCount(0.5, 1500)).toBe(1500);
    expect(weatherRainVertexCount(1, 1500)).toBe(3000);
  });
});

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
