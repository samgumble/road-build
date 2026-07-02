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
});
