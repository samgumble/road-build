import type { WeatherSnapshot } from '../core/weather';

export interface RainVisibility {
  fogNear: number;
  fogFar: number;
  sunScale: number;
}

export const RAIN_FOG_NEAR_FLOOR = 480;
export const RAIN_FOG_FAR_FLOOR = 720;
export const RAIN_SUN_SCALE_FLOOR = 0.65;
export const WEATHER_RAIN_OPACITY = 0.85;
export const WEATHER_FOG_NEAR_FLOOR = 380;
export const WEATHER_FOG_FAR_FLOOR = 620;

export interface WeatherAtmosphereValues {
  fogNear: number;
  fogFar: number;
  sunScale: number;
  hemiScale: number;
  cloudOpacity: number;
  rainOpacity: number;
}

export function weatherCloudWeight(cloudCover: number, groupIndex: number, groupCount: number): number {
  return Math.max(0, Math.min(1, cloudCover * groupCount - groupIndex));
}

export function weatherRainVertexCount(rain: number, dropCount: number): number {
  return Math.floor(Math.max(0, Math.min(1, rain)) * dropCount) * 2;
}

/** Pure weather readability curve. Rain can still compress depth and soften the key light, but
 * never far enough to hide the island-scale road network or flatten construction silhouettes. */
export function rainVisibility(rainAmount: number, baseFogNear: number, baseFogFar: number): RainVisibility {
  const rain = Math.max(0, Math.min(1, rainAmount));
  const denseNear = baseFogNear / 1.5;
  const denseFar = baseFogFar / 1.5;
  return {
    fogNear: baseFogNear + (Math.max(denseNear, Math.min(baseFogNear, RAIN_FOG_NEAR_FLOOR)) - baseFogNear) * rain,
    fogFar: baseFogFar + (Math.max(denseFar, Math.min(baseFogFar, RAIN_FOG_FAR_FLOOR)) - baseFogFar) * rain,
    sunScale: 1 + (RAIN_SUN_SCALE_FLOOR - 1) * rain,
  };
}

/** Composes the blended living-weather snapshot with the established gameplay readability floors.
 * Coastal fog may close in more densely than a storm because it has no rain streaks or softened
 * construction silhouettes; rain always preserves the island-scale 480/720 visibility contract. */
export function weatherAtmosphereValues(
  snapshot: WeatherSnapshot,
  baseFogNear: number,
  baseFogFar: number,
  out?: WeatherAtmosphereValues,
): WeatherAtmosphereValues {
  const rainVisibilityValues = rainVisibility(snapshot.rain, baseFogNear, baseFogFar);
  const weatherFogNear = baseFogNear + (baseFogNear / 2.1 - baseFogNear) * snapshot.fog;
  const weatherFogFar = baseFogFar + (baseFogFar / 2.4 - baseFogFar) * snapshot.fog;
  const protectedFogNear = weatherFogNear
    + (rainVisibilityValues.fogNear - weatherFogNear) * snapshot.rain;
  const protectedFogFar = weatherFogFar
    + (rainVisibilityValues.fogFar - weatherFogFar) * snapshot.rain;

  const values = out ?? {
    fogNear: baseFogNear,
    fogFar: baseFogFar,
    sunScale: 1,
    hemiScale: 1,
    cloudOpacity: 0.36,
    rainOpacity: 0,
  };
  values.fogNear = Math.max(WEATHER_FOG_NEAR_FLOOR, protectedFogNear);
  values.fogFar = Math.max(WEATHER_FOG_FAR_FLOOR, protectedFogFar);
  const plannedSunScale = 1 - 0.55 * Math.max(snapshot.cloudDarkness, snapshot.rain);
  values.sunScale = Math.max(plannedSunScale, RAIN_SUN_SCALE_FLOOR * snapshot.rain);
  values.hemiScale = 1 - 0.28 * snapshot.cloudDarkness;
  values.cloudOpacity = 0.36 + (0.9 - 0.36) * snapshot.cloudCover;
  values.rainOpacity = WEATHER_RAIN_OPACITY * snapshot.rain;
  return values;
}
