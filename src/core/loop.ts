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
      for (let i = 0; i < steps; i++) this.update(SIM_DT);
      this.acc = remainder;
      this.render(this.acc / SIM_DT);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }
}
