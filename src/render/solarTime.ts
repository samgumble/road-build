export const SUNRISE_TIME = 1 / 6;
export const SUNSET_TIME = 5 / 6;

// Calm lighting at fast-forward: at a raw 16x the full day/night cycle sweeps past every couple
// of minutes and the lighting reads as strobing — noon to midnight and back while you watch one
// road build. The ATMOSPHERE clock therefore caps at 4x no matter how fast the sim runs; crews,
// traffic, and growth still honor the full HUD speed. Lives here (not atmosphere.ts) so tests can
// import it without pulling in the DOM-touching sky/quality modules.
export const ATMOSPHERE_MAX_TIMESCALE = 4;

/** The time scale the atmosphere actually advances at for a given sim (HUD) time scale. */
export function atmosphereTimeScale(simTimeScale: number): number {
  return Math.min(simTimeScale, ATMOSPHERE_MAX_TIMESCALE);
}
const DAY_SPAN = SUNSET_TIME - SUNRISE_TIME; // two thirds of the cycle
const NIGHT_SPAN = 1 - DAY_SPAN; // one third of the cycle

/** Maps the uniform gameplay clock onto a visual solar phase with a long day and short night.
 * The sun spends two thirds of the cycle above the horizon (sunrise 1/6, sunset 5/6), while noon
 * and midnight remain at 0.5 and 0.0. Both piecewise slopes meet continuously at the horizons. */
export function solarTimeOfDay(timeOfDay: number): number {
  const t = ((timeOfDay % 1) + 1) % 1;
  if (t >= SUNRISE_TIME && t <= SUNSET_TIME) {
    return 0.25 + ((t - SUNRISE_TIME) / DAY_SPAN) * 0.5;
  }

  const elapsedNight = t > SUNSET_TIME ? t - SUNSET_TIME : t + 1 - SUNSET_TIME;
  return (0.75 + (elapsedNight / NIGHT_SPAN) * 0.5) % 1;
}

/** Sun elevation in -1..1, peaking at solar noon and reaching its trough at midnight. */
export function sunElevation(timeOfDay: number): number {
  const solarTime = solarTimeOfDay(timeOfDay);
  return Math.sin(2 * Math.PI * (solarTime - 0.25));
}
