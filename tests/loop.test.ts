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
});
