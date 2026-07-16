export const WEATHER_KINDS = [
  'clear',
  'overcast',
  'light-rain',
  'heavy-rain',
  'coastal-fog',
] as const;

export type WeatherKind = typeof WEATHER_KINDS[number];

export interface WeatherSaveState {
  current: WeatherKind;
  next: WeatherKind;
  /** Normalized 0..1 blend progress from current to next. */
  transition: number;
  /** Dwell time remaining after the active transition completes, in sim seconds. */
  remaining: number;
  /** Seed index of the active transition, or the next transition while dwelling. */
  transitionIndex: number;
}

export interface WeatherSnapshot {
  kind: WeatherKind;
  cloudCover: number;
  cloudDarkness: number;
  rain: number;
  fog: number;
  wind: number;
  waterRoughness: number;
}

export const DEFAULT_WEATHER_SAVE: WeatherSaveState = Object.freeze({
  current: 'clear',
  next: 'clear',
  transition: 1,
  remaining: 120,
  transitionIndex: 0,
});

export const WEATHER_PROFILES: Readonly<Record<WeatherKind, WeatherSnapshot>> = Object.freeze({
  clear: Object.freeze({
    kind: 'clear', cloudCover: 0.22, cloudDarkness: 0, rain: 0, fog: 0,
    wind: 0.18, waterRoughness: 0.12,
  }),
  overcast: Object.freeze({
    kind: 'overcast', cloudCover: 0.82, cloudDarkness: 0.45, rain: 0, fog: 0.22,
    wind: 0.38, waterRoughness: 0.34,
  }),
  'light-rain': Object.freeze({
    kind: 'light-rain', cloudCover: 0.92, cloudDarkness: 0.58, rain: 0.5, fog: 0.38,
    wind: 0.55, waterRoughness: 0.55,
  }),
  'heavy-rain': Object.freeze({
    kind: 'heavy-rain', cloudCover: 1, cloudDarkness: 0.82, rain: 1, fog: 0.62,
    wind: 0.88, waterRoughness: 0.82,
  }),
  'coastal-fog': Object.freeze({
    kind: 'coastal-fog', cloudCover: 0.55, cloudDarkness: 0.18, rain: 0, fog: 1,
    wind: 0.12, waterRoughness: 0.2,
  }),
});
