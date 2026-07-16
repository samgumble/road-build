import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { SceneryRenderer, skylineHeightScale } from '../src/render/sceneryRenderer';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { EventBus } from '../src/core/events';
import type { GrowthKind } from '../src/sim/growth/growth';

// Same async warm-up pattern as sceneryDecay.test.ts: whichever load path (gltf/fallback) the
// building category takes, spawn a probe and poll until it lands, then run the real assertions.
function spawn(bus: EventBus, kind: GrowthKind, x: number, z: number, id: number): void {
  bus.emit('growth:spawn', { kind, x, z, rot: 0, id });
}

async function warmUpBuildings(bus: EventBus, sr: SceneryRenderer, timeoutMs: number): Promise<void> {
  spawn(bus, 'building', -9999, -9999, -1);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (sr.instanceStats.buildingMeshTotal > 0) {
      bus.emit('growth:remove', { id: -1 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`SceneryRenderer never became ready for buildings within ${timeoutMs}ms`);
}

/** Settlement-center distance stub: the center is at x=0, so distance is just |x|. */
const settlementCenterDistanceAt = (x: number, _z: number): number => Math.abs(x);

describe('skyline variety (height falloff from settlement centers + facade tints)', () => {
  let bus: EventBus;
  let sr: SceneryRenderer;

  beforeAll(async () => {
    bus = new EventBus();
    const hf = new Heightfield('skyline-variety', bus);
    sr = new SceneryRenderer(new THREE.Scene(), hf, bus, settlementCenterDistanceAt);
    await warmUpBuildings(bus, sr, 20000);
  }, 25000);

  it('shapes the pure height curve: tall at the core, damped at the fringe, jitter-bounded', () => {
    // near a connected junction center: downtown towers stand taller than the base model
    expect(skylineHeightScale(5, 0.5)).toBeGreaterThan(1);
    // far from a center (including a simple road with no degree-3 junction): blocks stay low-rise
    expect(skylineHeightScale(80, 0.5)).toBeLessThan(0.85);
    expect(skylineHeightScale(Infinity, 0.5)).toBeLessThan(0.85);
    // monotonic: same jitter, more distance never means a taller tower
    for (let d = 0; d < 60; d += 4) {
      expect(skylineHeightScale(d + 4, 0.31)).toBeLessThanOrEqual(skylineHeightScale(d, 0.31));
    }
    // no road probe available -> jitter-only variation around 1
    expect(skylineHeightScale(null, 0)).toBeGreaterThan(0.8);
    expect(skylineHeightScale(null, 1)).toBeLessThan(1.3);
  });

  it('stretches core buildings taller and fringe buildings shorter in the live instance matrices', () => {
    spawn(bus, 'building', 6, 0, 11);   // 6u from the settlement center: core tower
    spawn(bus, 'building', 80, 40, 12); // 80u out: fringe block
    const core = sr.verticalStretchOf(11)!;
    const fringe = sr.verticalStretchOf(12)!;
    expect(core).toBeGreaterThan(1);
    expect(fringe).toBeLessThan(1);
    expect(core).toBeGreaterThan(fringe);
    bus.emit('growth:remove', { id: 11 });
    bus.emit('growth:remove', { id: 12 });
  });

  it('gives each building a deterministic facade tint from the palette', () => {
    // NOTE: determinism is asserted within ONE renderer (remove + respawn at the same coords) —
    // a second SceneryRenderer in the same test process never resolves its GLTF load (three.js
    // FileLoader in-flight dedup), which is why sceneryDecay.test.ts shares one instance too.
    spawn(bus, 'building', 12, -20, 13);
    const tint = sr.facadeTintOf(13);
    const stretch = sr.verticalStretchOf(13)!;
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    bus.emit('growth:remove', { id: 13 });

    // same coordinates -> same tint and stretch, regardless of spawn order or slot history
    spawn(bus, 'building', 12, -20, 16);
    expect(sr.facadeTintOf(16)).toBe(tint);
    expect(sr.verticalStretchOf(16)).toBeCloseTo(stretch, 6);
    bus.emit('growth:remove', { id: 16 });
  });

  it('keeps the facade tint attached to a surviving building through slot compaction', () => {
    spawn(bus, 'building', 18, 60, 14);
    spawn(bus, 'building', 18, 80, 15);
    const tint15 = sr.facadeTintOf(15);
    const stretch15 = sr.verticalStretchOf(15)!;
    // removing 14 compacts 15 into its slot when they share a variant mesh — tint/stretch must follow
    bus.emit('growth:remove', { id: 14 });
    expect(sr.facadeTintOf(15)).toBe(tint15);
    expect(sr.verticalStretchOf(15)).toBeCloseTo(stretch15, 6);
    bus.emit('growth:remove', { id: 15 });
  });
});
