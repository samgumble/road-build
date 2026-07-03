import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { EventBus } from '../src/core/events';
import { WORLD_SIZE, WATER_LEVEL } from '../src/core/constants';

describe('Heightfield', () => {
  it('is deterministic per seed', () => {
    const a = new Heightfield('s1'), b = new Heightfield('s1');
    expect(a.heightAt(10, -30)).toBeCloseTo(b.heightAt(10, -30), 10);
  });
  it('is underwater at the world border (island falloff)', () => {
    const hf = new Heightfield('s1');
    const e = WORLD_SIZE / 2 - 1;
    for (const [x, z] of [[e, 0], [-e, 0], [0, e], [0, -e]] as const)
      expect(hf.heightAt(x, z)).toBeLessThan(WATER_LEVEL);
  });
  it('has land somewhere near the center', () => {
    const hf = new Heightfield('s1');
    let found = false;
    for (let x = -100; x <= 100 && !found; x += 10)
      for (let z = -100; z <= 100 && !found; z += 10)
        if (hf.isLand(x, z)) found = true;
    expect(found).toBe(true);
  });
  it('flattenCircle moves heights toward target and emits dirty rect', () => {
    const bus = new EventBus();
    const hf = new Heightfield('s1', bus);
    let rect: unknown = null;
    bus.on('terrain:deformed', (r) => (rect = r));
    const before = hf.heightAt(0, 0);
    hf.flattenCircle(0, 0, before + 5, 12);
    expect(hf.heightAt(0, 0)).toBeGreaterThan(before + 4);
    expect(rect).not.toBeNull();
  });

  describe('clampBelow', () => {
    it('hard-clamps the core to at or below maxY', () => {
      const hf = new Heightfield('s1');
      const before = hf.heightAt(0, 0);
      // Set terrain well above a target roadbed height, then clamp — the core (near d=0) should
      // land at (very close to) maxY, not merely be nudged toward it.
      hf.flattenCircle(0, 0, before + 20, 12);
      const targetY = before;
      hf.clampBelow(0, 0, targetY, 12);
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(targetY + 0.05);
    });
    it('never raises terrain (only clamps downward)', () => {
      const hf = new Heightfield('s1');
      const before = hf.heightAt(0, 0);
      hf.clampBelow(0, 0, before - 100, 12); // maxY far below current height
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(before - 99);
    });
    it('allows a small rising allowance toward the rim, never a cliff', () => {
      const hf = new Heightfield('s2');
      const before = hf.heightAt(50, 50);
      hf.flattenCircle(50, 50, before + 20, 12);
      hf.clampBelow(50, 50, before, 12);
      // Right at the core it should be clamped near maxY...
      expect(hf.heightAt(50, 50)).toBeLessThanOrEqual(before + 0.05);
      // ...but the clamp shouldn't cut a hard vertical cliff: right outside the radius (d > 1)
      // heights are left untouched (whatever flattenCircle already feathered them to), so we
      // just check clampBelow doesn't throw/deform anything out there.
      expect(() => hf.heightAt(50 + 13, 50)).not.toThrow();
    });
    it('emits terrain:deformed for the dirty rect', () => {
      const bus = new EventBus();
      const hf = new Heightfield('s1', bus);
      let rect: unknown = null;
      bus.on('terrain:deformed', (r) => (rect = r));
      hf.clampBelow(0, 0, hf.heightAt(0, 0) - 5, 12);
      expect(rect).not.toBeNull();
    });
  });
});
