import { describe, it, expect } from 'vitest';
import { makeSampler, validateChain, sampleAt } from '../src/sim/roads/path';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { MAX_ROAD_GRADE, WATER_LEVEL } from '../src/core/constants';

const hf = new Heightfield('path-test');
// find a guaranteed-land point to anchor tests
function landPoint(): { x: number; z: number } {
  for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 48, z)) return { x, z };
  throw new Error('no land');
}

describe('road path sampling', () => {
  it('samples a curve at ~2u spacing with no grade over the limit', () => {
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 24, z: p.z }, { x: p.x + 48, z: p.z }]);
    expect(s.length).toBeGreaterThan(10);
    for (let i = 1; i < s.length; i++) {
      const run = Math.hypot(s[i].x - s[i-1].x, s[i].z - s[i-1].z);
      expect(Math.abs(s[i].y - s[i-1].y) / run).toBeLessThanOrEqual(MAX_ROAD_GRADE + 1e-6);
    }
  });
  it('keeps deck above water and flags bridge samples over water', () => {
    // straight chain across the island edge into water and back is hard to construct
    // generically, so instead assert: any sample whose ground is underwater is a bridge
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }]);
    for (const smp of s) {
      if (hf.heightAt(smp.x, smp.z) < WATER_LEVEL + 0.4) {
        expect(smp.bridge).toBe(true);
        expect(smp.y).toBeGreaterThanOrEqual(WATER_LEVEL + 2.0);
      }
    }
  });
  it('validates chains: rejects single point and off-world, accepts land-to-land', () => {
    const p = landPoint();
    expect(validateChain([{ x: p.x, z: p.z }], hf)).toBe(false);
    expect(validateChain([{ x: p.x, z: p.z }, { x: 9999, z: 0 }], hf)).toBe(false);
    expect(validateChain([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }], hf)).toBe(true);
  });
  it('sampleAt interpolates position and heading along arclength', () => {
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }]);
    const mid = sampleAt(s, 24);
    expect(mid.pos.x).toBeGreaterThan(p.x + 16);
    expect(mid.pos.x).toBeLessThan(p.x + 32);
    expect(Math.abs(Math.cos(mid.heading))).toBeGreaterThan(0.9); // heading ~ +x
  });
});
