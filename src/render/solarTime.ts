export const SUNRISE_TIME = 1 / 6;
export const SUNSET_TIME = 5 / 6;
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
