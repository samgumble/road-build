import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { SceneryRenderer } from '../src/render/sceneryRenderer';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { EventBus } from '../src/core/events';
import type { GrowthKind } from '../src/sim/growth/growth';

// Night-polish pass: buildings get a GRID of window quads (more rows for taller towers) instead
// of a single quad, so settlements read as lit towns after dark. Same shared-renderer warm-up
// pattern as sceneryDecay.test.ts (a second renderer in one process never resolves its GLTF load).
function spawn(bus: EventBus, kind: GrowthKind, x: number, z: number, id: number): void {
  bus.emit('growth:spawn', { kind, x, z, rot: 0, id });
}

async function warmUp(bus: EventBus, sr: SceneryRenderer, kind: GrowthKind, timeoutMs: number): Promise<void> {
  spawn(bus, kind, -9999, -9999, -1);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stats = sr.instanceStats;
    if ((kind === 'building' ? stats.buildingMeshTotal : stats.houseMeshTotal) > 0) {
      bus.emit('growth:remove', { id: -1 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`SceneryRenderer never became ready for ${kind} within ${timeoutMs}ms`);
}

describe('night window grids', () => {
  let bus: EventBus;
  let sr: SceneryRenderer;
  const removedBeforeReadyId = -900;
  const survivingOverlapId = -901;

  beforeAll(async () => {
    bus = new EventBus();
    const hf = new Heightfield('window-grids', bus);
    sr = new SceneryRenderer(new THREE.Scene(), hf, bus, (x) => Math.abs(x));
    // Reproduce the asset-load race behind orphaned night lights: the authoritative building can
    // be removed while its GLTF category is still loading. A later pending-spawn flush must not
    // resurrect either the skyscraper instance or its separate emissive window-grid instances.
    spawn(bus, 'building', 18, 18, removedBeforeReadyId);
    spawn(bus, 'building', 18, 18, survivingOverlapId);
    bus.emit('growth:remove', { id: removedBeforeReadyId });
    await warmUp(bus, sr, 'house', 20000);
    await warmUp(bus, sr, 'building', 20000);
  }, 45000);

  it('does not resurrect window lights for a building removed before its model is ready', () => {
    const internal = sr as unknown as { byId: Map<number, unknown> };
    expect(internal.byId.has(removedBeforeReadyId)).toBe(false);
    // Removal is keyed by authoritative id, not position: the intentionally overlapping survivor
    // still owns a building and its windows at the exact same parcel center.
    expect(internal.byId.has(survivingOverlapId)).toBe(true);
    expect(sr.instanceStats.buildingMeshTotal).toBe(1);
    expect(sr.instanceStats.windowMeshCount).toBeGreaterThanOrEqual(3);

    bus.emit('growth:remove', { id: survivingOverlapId });
    expect(sr.instanceStats.buildingMeshTotal).toBe(0);
    expect(sr.instanceStats.windowMeshCount).toBe(0);
  });

  it('plants a multi-row window grid on buildings and a modest set on houses', () => {
    const before = sr.instanceStats.windowMeshCount;
    spawn(bus, 'building', 6, 0, 21); // core tower (tall via skyline stretch) -> generous grid
    const afterBuilding = sr.instanceStats.windowMeshCount;
    expect(afterBuilding - before).toBeGreaterThanOrEqual(3);

    spawn(bus, 'house', 6, 40, 22);
    const afterHouse = sr.instanceStats.windowMeshCount;
    expect(afterHouse - afterBuilding).toBeGreaterThanOrEqual(1);
    expect(afterHouse - afterBuilding).toBeLessThanOrEqual(2);

    // full compaction: removing both returns the pool exactly to its starting count
    bus.emit('growth:remove', { id: 21 });
    bus.emit('growth:remove', { id: 22 });
    expect(sr.instanceStats.windowMeshCount).toBe(before);
  });

  it('keeps window grids deterministic and correctly attached through slot compaction', () => {
    const base = sr.instanceStats.windowMeshCount;
    spawn(bus, 'building', 12, 60, 23);
    const grid23 = sr.instanceStats.windowMeshCount - base;
    spawn(bus, 'building', 12, 80, 24);
    const grid24 = sr.instanceStats.windowMeshCount - base - grid23;
    expect(grid23).toBeGreaterThanOrEqual(3);

    // removing 23 compacts 24's slots; exactly 23's grid disappears, 24 keeps its own
    bus.emit('growth:remove', { id: 23 });
    expect(sr.instanceStats.windowMeshCount).toBe(base + grid24);

    // respawning at identical coordinates yields the identical grid size (deterministic)
    spawn(bus, 'building', 12, 60, 25);
    expect(sr.instanceStats.windowMeshCount).toBe(base + grid24 + grid23);
    bus.emit('growth:remove', { id: 24 });
    bus.emit('growth:remove', { id: 25 });
    expect(sr.instanceStats.windowMeshCount).toBe(base);
  });
});
