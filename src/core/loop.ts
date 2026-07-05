import { SIM_DT } from './constants';

export function stepAccumulator(acc: number, dt: number, maxSteps: number): { steps: number; remainder: number } {
  let steps = Math.floor(acc / dt);
  if (steps > maxSteps) steps = maxSteps;
  return { steps, remainder: Math.min(acc - steps * dt, dt) };
}

export class Loop {
  timeScale = 1;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  /**
   * Task 47 item 2 ("combined easement x grading load"): optional hooks bracketing one rendered
   * frame's whole BATCH of fixed sim-steps below (not each individual step) — set by main.ts to
   * `hf.beginDeformBatch`/`hf.endDeformBatch` so `Heightfield.flattenCircle`'s per-call easement
   * replay (Task 43) can be deferred and deduped once per batch instead of once per
   * `flattenCircle` call (measured worst case without this: ~154ms/batch at 16x with a built-out
   * map — see task-47-report.md). `Loop` itself stays engine/heightfield-agnostic — these are
   * plain optional callbacks, undefined by default (a no-op) for every existing/future caller that
   * doesn't care about deform batching (e.g. every test that constructs a bare `Loop`).
   */
  onBatchStart?: () => void;
  onBatchEnd?: () => void;
  constructor(private update: (dt: number) => void, private render: (alpha: number) => void) {}
  start(): void {
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.acc += Math.min((now - this.last) / 1000, 0.25) * this.timeScale;
      this.last = now;
      // Scale the cap with timeScale: an unscaled cap of 8 silently throttles high HUD speeds
      // (e.g. 16x only ever running 8 of the 16 steps/frame it needs at 60Hz).
      const cap = Math.ceil(8 * Math.max(1, this.timeScale));
      const { steps, remainder } = stepAccumulator(this.acc, SIM_DT, cap);
      if (steps > 0) {
        this.onBatchStart?.();
        try {
          for (let i = 0; i < steps; i++) this.update(SIM_DT);
        } finally {
          this.onBatchEnd?.();
        }
      }
      this.acc = remainder;
      this.render(this.acc / SIM_DT);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }
}
