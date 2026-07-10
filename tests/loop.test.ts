import { describe, it, expect } from 'vitest';
import { stepAccumulator } from '../src/core/loop';

describe('stepAccumulator', () => {
  it('produces fixed-size steps and a remainder alpha', () => {
    const r = stepAccumulator(0.05, 1 / 60, 8); // 50ms at 60Hz -> 3 steps
    expect(r.steps).toBe(3);
    expect(r.remainder).toBeCloseTo(0.05 - 3 / 60, 10);
  });
  it('caps runaway steps', () => {
    expect(stepAccumulator(10, 1 / 60, 8).steps).toBe(8);
  });
  it('honors a scaled cap so high time-scale is not silently throttled', () => {
    // At timeScale 16, Loop scales the cap to Math.ceil(8 * 16) = 128, so 16/60s of
    // accumulated time (the amount produced by one real 60Hz frame at 16x) should admit
    // all 16 steps instead of being clamped to the unscaled cap of 8.
    expect(stepAccumulator(16 / 60, 1 / 60, Math.ceil(8 * 16)).steps).toBe(16);
  });
  it('holds accumulated simulation time while paused', () => {
    const r = stepAccumulator(0.05, 1 / 60, 8, true);
    expect(r.steps).toBe(0);
    expect(r.remainder).toBe(0);
  });
});
