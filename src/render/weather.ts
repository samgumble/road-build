import { createRng } from '../core/rng';
import {
  DEFAULT_WEATHER_SAVE,
  WEATHER_PROFILES,
  type WeatherKind,
  type WeatherSaveState,
  type WeatherSnapshot,
} from '../core/weather';

export { WEATHER_PROFILES } from '../core/weather';
export type { WeatherKind, WeatherSaveState, WeatherSnapshot } from '../core/weather';

const NEXT: Readonly<Record<WeatherKind, readonly WeatherKind[]>> = Object.freeze({
  clear: Object.freeze(['overcast', 'coastal-fog'] as const),
  overcast: Object.freeze(['clear', 'light-rain', 'coastal-fog'] as const),
  'light-rain': Object.freeze(['overcast', 'heavy-rain'] as const),
  'heavy-rain': Object.freeze(['light-rain', 'overcast'] as const),
  'coastal-fog': Object.freeze(['clear', 'overcast'] as const),
});

const DWELL: Readonly<Record<WeatherKind, readonly [number, number]>> = Object.freeze({
  clear: Object.freeze([120, 240] as const),
  overcast: Object.freeze([90, 180] as const),
  'light-rain': Object.freeze([60, 120] as const),
  'heavy-rain': Object.freeze([45, 90] as const),
  'coastal-fog': Object.freeze([60, 150] as const),
});

const TRANSITION_MIN_SECONDS = 8;
const TRANSITION_RANGE_SECONDS = 7;

interface TransitionDraw {
  next: WeatherKind;
  dwell: number;
  duration: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const u = clamp01(value);
  return u * u * (3 - 2 * u);
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * Pure presentation-only weather state machine. Random choices are re-derived from the world seed
 * and a persisted transition index, so restoring never depends on serializing an RNG closure.
 */
export class WeatherController {
  private state: WeatherSaveState;
  private currentSnapshot: WeatherSnapshot;
  private activeTransitionDuration: number;

  constructor(private readonly seed: string, initial: WeatherSaveState = DEFAULT_WEATHER_SAVE) {
    this.state = { ...initial };
    this.currentSnapshot = { ...WEATHER_PROFILES[this.state.current] };
    this.activeTransitionDuration = this.transitionDuration(this.state.transitionIndex);
    this.refreshSnapshot();
  }

  update(dt: number): boolean {
    if (!Number.isFinite(dt) || dt <= 0) return false;

    let seconds = dt;
    let completedTransition = false;

    while (seconds > 0) {
      if (this.state.transition < 1) {
        const duration = this.activeTransitionDuration;
        const secondsToCompletion = duration * (1 - clamp01(this.state.transition));

        if (seconds < secondsToCompletion) {
          this.state.transition = clamp01(this.state.transition + seconds / duration);
          seconds = 0;
        } else {
          seconds -= secondsToCompletion;
          this.state.current = this.state.next;
          this.state.transition = 1;
          this.state.transitionIndex += 1;
          completedTransition = true;
        }
        continue;
      }

      if (seconds < this.state.remaining) {
        this.state.remaining -= seconds;
        seconds = 0;
        continue;
      }

      seconds -= this.state.remaining;
      const draw = this.drawTransition(this.state.current, this.state.transitionIndex);
      this.state.next = draw.next;
      this.state.transition = 0;
      this.state.remaining = draw.dwell;
      this.activeTransitionDuration = draw.duration;
    }

    this.refreshSnapshot();
    return completedTransition;
  }

  get snapshot(): Readonly<WeatherSnapshot> {
    return this.currentSnapshot;
  }

  get saved(): WeatherSaveState {
    return { ...this.state };
  }

  restore(state: WeatherSaveState): void {
    this.state = { ...state };
    this.activeTransitionDuration = this.transitionDuration(this.state.transitionIndex);
    this.refreshSnapshot();
  }

  private transitionRng(index: number): () => number {
    return createRng(`${this.seed}:weather:${index}`);
  }

  private transitionDuration(index: number): number {
    const rng = this.transitionRng(index);
    rng(); // The first draw is reserved for the next-state choice.
    return TRANSITION_MIN_SECONDS + rng() * TRANSITION_RANGE_SECONDS;
  }

  private drawTransition(current: WeatherKind, index: number): TransitionDraw {
    const rng = this.transitionRng(index);
    const candidates = NEXT[current];
    const next = candidates[Math.floor(rng() * candidates.length)];
    const duration = TRANSITION_MIN_SECONDS + rng() * TRANSITION_RANGE_SECONDS;
    const [minimumDwell, maximumDwell] = DWELL[next];
    const dwell = minimumDwell + rng() * (maximumDwell - minimumDwell);
    return { next, dwell, duration };
  }

  private refreshSnapshot(): void {
    const from = WEATHER_PROFILES[this.state.current];
    if (this.state.transition >= 1) {
      Object.assign(this.currentSnapshot, from);
      return;
    }

    const to = WEATHER_PROFILES[this.state.next];
    const progress = smoothstep(this.state.transition);
    // Mutate the stable snapshot directly: this runs every visual frame during transitions, so an
    // Object.assign source literal would create avoidable steady-state garbage.
    this.currentSnapshot.kind = this.state.current;
    this.currentSnapshot.cloudCover = lerp(from.cloudCover, to.cloudCover, progress);
    this.currentSnapshot.cloudDarkness = lerp(from.cloudDarkness, to.cloudDarkness, progress);
    this.currentSnapshot.rain = lerp(from.rain, to.rain, progress);
    this.currentSnapshot.fog = lerp(from.fog, to.fog, progress);
    this.currentSnapshot.wind = lerp(from.wind, to.wind, progress);
    this.currentSnapshot.waterRoughness = lerp(from.waterRoughness, to.waterRoughness, progress);
  }
}
