import { describe, it, expect } from 'vitest';
import { makeSampler, validateChain, explainChainRejection, sampleAt, smoothRoadCenterline } from '../src/sim/roads/path';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { MAX_ROAD_GRADE, WATER_LEVEL } from '../src/core/constants';

const hf = new Heightfield('path-test');
// find a guaranteed-land point to anchor tests
function landPoint(): { x: number; z: number } {
  for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 48, z)) return { x, z };
  throw new Error('no land');
}
// find a guaranteed-water point (open sea well away from the island)
function waterPoint(): { x: number; z: number } {
  for (let x = -220; x <= 220; x += 8) for (let z = -220; z <= 220; z += 8)
    if (!hf.isLand(x, z)) return { x, z };
  throw new Error('no water');
}

describe('road path sampling', () => {
  it('smooths short snapped zigzags while preserving exact road endpoints', () => {
    const ctrl = [
      { x: 0, z: 0 },
      { x: 4, z: 4 },
      { x: 8, z: -4 },
      { x: 12, z: 4 },
      { x: 16, z: -4 },
      { x: 20, z: 0 },
    ];

    const smooth = smoothRoadCenterline(ctrl);

    expect(smooth[0]).toEqual(ctrl[0]);
    expect(smooth[smooth.length - 1]).toEqual(ctrl[ctrl.length - 1]);
    expect(Math.max(...smooth.map((p) => Math.abs(p.z)))).toBeLessThan(3);
  });

  it('rounds a normal right-angle corner without overshooting its road envelope', () => {
    const smooth = smoothRoadCenterline([
      { x: 0, z: 0 },
      { x: 24, z: 0 },
      { x: 24, z: 24 },
    ]);

    expect(smooth[0]).toEqual({ x: 0, z: 0 });
    expect(smooth[smooth.length - 1]).toEqual({ x: 24, z: 24 });
    expect(smooth.every((p) => p.x >= 0 && p.x <= 24 && p.z >= 0 && p.z <= 24)).toBe(true);

    // A rounded bend must include samples on both sides of the original corner, rather than
    // retaining one abrupt 90-degree heading change at (24, 0).
    expect(smooth.some((p) => p.x < 24 && p.z > 0)).toBe(true);
  });

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
  it('explains chain rejections with a player-facing reason, and returns null for valid chains', () => {
    const p = landPoint();
    const w = waterPoint();
    // too short: fewer than two snapped points
    expect(explainChainRejection([{ x: p.x, z: p.z }], hf)).toBe('DRAG FURTHER TO SURVEY A ROAD');
    // out of bounds beats the endpoint check
    expect(explainChainRejection([{ x: p.x, z: p.z }, { x: 9999, z: 0 }], hf)).toBe('TOO CLOSE TO THE ISLAND EDGE');
    // an endpoint in open water
    expect(explainChainRejection([{ x: p.x, z: p.z }, { x: w.x, z: w.z }], hf)).toBe('ROADS MUST START AND END ON LAND');
    expect(explainChainRejection([{ x: w.x, z: w.z }, { x: p.x, z: p.z }], hf)).toBe('ROADS MUST START AND END ON LAND');
    // valid chain: no reason
    expect(explainChainRejection([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }], hf)).toBeNull();
    // validateChain stays consistent with the explainer
    expect(validateChain([{ x: p.x, z: p.z }, { x: w.x, z: w.z }], hf)).toBe(false);
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
