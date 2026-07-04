import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { SceneryRenderer } from '../src/render/sceneryRenderer';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { EventBus } from '../src/core/events';
import type { GrowthKind } from '../src/sim/growth/growth';

// SceneryRenderer resolves each category (tree/house/building) asynchronously — either real GLTF
// models (whichever load path the environment's `fetch`/loader stack actually takes) or, on any
// load failure, a procedural fallback (see the constructor's doc comment). Which path wins is
// environment-dependent, and a real GLTF fetch can take longer than a single test's default
// timeout — so ALL tests in this file share ONE SceneryRenderer instance (built + warmed up once in
// `beforeAll`, with a generous timeout), and each test uses its own disjoint coordinate range/id
// block so concurrently-live records from different tests never collide.
let nextId = 1;
function freshId(): number {
  return nextId++;
}

function spawn(bus: EventBus, kind: GrowthKind, x: number, z: number, id: number): void {
  bus.emit('growth:spawn', { kind, x, z, rot: 0, id });
}

/** Spawns a probe record and polls (via short sleeps) until it's actually landed in `instanceStats`
 * — the real readiness signal these tests need, regardless of which load path SceneryRenderer took
 * for that category. Removes the probe again before returning so it doesn't pollute counts. Throws
 * if it never lands within `timeoutMs` (a genuine failure, not a flush-timing flake). */
async function warmUpCategory(bus: EventBus, sr: SceneryRenderer, kind: GrowthKind, timeoutMs: number): Promise<void> {
  const probeId = -1000 - freshId(); // negative, well outside real test ids
  spawn(bus, kind, -9999, -9999, probeId); // far off in a corner; harmless if briefly visible
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stats = sr.instanceStats;
    const landed =
      kind === 'tree' ? stats.treeMeshTotal > 0 :
      kind === 'house' ? stats.houseMeshTotal > 0 :
      kind === 'building' ? stats.buildingMeshTotal > 0 :
      stats.fieldMeshCount > 0;
    if (landed) {
      bus.emit('growth:remove', { id: probeId });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`SceneryRenderer never became ready for kind=${kind} within ${timeoutMs}ms`);
}

let bus: EventBus;
let sr: SceneryRenderer;

describe('SceneryRenderer decay/upgrade (Task 35)', () => {
  beforeAll(async () => {
    bus = new EventBus();
    const hf = new Heightfield('scenery-decay-test', bus);
    const scene = new THREE.Scene();
    sr = new SceneryRenderer(scene, hf, bus);
    // One-time warm-up for the whole file — whichever load path (gltf/fallback) each category
    // takes, however long it takes (generous timeout since this only pays once for the file).
    await warmUpCategory(bus, sr, 'tree', 20000);
    await warmUpCategory(bus, sr, 'house', 20000);
    await warmUpCategory(bus, sr, 'building', 20000);
  }, 65000);

  it('upgrade swap: removes the house instance and places a building instance with the same id', () => {
    const id = freshId();
    spawn(bus, 'house', 10, 10, id);
    const afterSpawn = sr.instanceStats;
    const housesBefore = afterSpawn.houseMeshTotal;
    const buildingsBefore = afterSpawn.buildingMeshTotal;
    const trackedBefore = afterSpawn.trackedInstances;

    bus.emit('growth:upgrade', { id });

    const afterUpgrade = sr.instanceStats;
    expect(afterUpgrade.houseMeshTotal).toBe(housesBefore - 1);
    expect(afterUpgrade.buildingMeshTotal).toBe(buildingsBefore + 1);
    expect(afterUpgrade.trackedInstances).toBe(trackedBefore); // net zero — swap, not add/remove

    // Clean up so this test doesn't leak state into the next one.
    bus.emit('growth:remove', { id });
  });

  it('stranded fade then remove: growth:stranded starts a fade, growth:remove frees the slot', () => {
    const before = sr.instanceStats.treeMeshTotal;
    const id = freshId();
    spawn(bus, 'tree', 20, 20, id);
    expect(sr.instanceStats.treeMeshTotal).toBe(before + 1);

    bus.emit('growth:stranded', { id });
    sr.update(1); // partway through the fade — instance still present, just scaled down
    expect(sr.instanceStats.treeMeshTotal).toBe(before + 1);

    bus.emit('growth:remove', { id });
    expect(sr.instanceStats.treeMeshTotal).toBe(before);
  });

  it('removing a middle instance compacts via swap-with-last (no gaps, no ghosts)', () => {
    const before = sr.instanceStats;
    const ids = [freshId(), freshId(), freshId(), freshId(), freshId()];
    for (const id of ids) spawn(bus, 'tree', 1000 + id, 0, id);
    expect(sr.instanceStats.treeMeshTotal).toBe(before.treeMeshTotal + 5);

    // Remove the middle one directly (skip the fade — growth:remove is the sim's own final word).
    bus.emit('growth:remove', { id: ids[2] });

    const stats = sr.instanceStats;
    expect(stats.treeMeshTotal).toBe(before.treeMeshTotal + 4);
    expect(stats.trackedInstances).toBe(before.trackedInstances + 4);
    expect(stats.byIdSize).toBe(before.byIdSize + 4);

    // Every remaining id must still resolve to a live, removable instance after compaction moved
    // slots around — proves `byId` bookkeeping followed the swap, not just the raw mesh count.
    for (const id of [ids[0], ids[1], ids[3], ids[4]]) {
      bus.emit('growth:remove', { id });
    }
    expect(sr.instanceStats.treeMeshTotal).toBe(before.treeMeshTotal);
    expect(sr.instanceStats.trackedInstances).toBe(before.trackedInstances);
  });

  it('stress: many spawn/upgrade/remove cycles across kinds leave consistent, gap-free counts', () => {
    const baseline = sr.instanceStats;
    const live = new Map<number, GrowthKind>();
    const kinds: GrowthKind[] = ['tree', 'house', 'building', 'field'];

    // Phase 1: spawn a few hundred records across all kinds, in a coordinate block well away from
    // any other test's ids/positions.
    for (let k = 0; k < 300; k++) {
      const id = freshId();
      const kind = kinds[k % kinds.length];
      spawn(bus, kind, 5000 + (k % 40) * 3, 5000 + Math.floor(k / 40) * 3, id);
      live.set(id, kind);
    }

    // Phase 2: upgrade every third house to a building.
    let counter = 0;
    for (const [id, kind] of [...live.entries()]) {
      if (kind === 'house' && counter++ % 3 === 0) {
        bus.emit('growth:upgrade', { id });
        live.set(id, 'building');
      }
    }

    // Phase 3: remove roughly a third of all remaining records, in a scattered (not purely
    // sequential) order so compaction has to swap across kinds/slots repeatedly.
    const idsToRemove = [...live.keys()].filter((_, i) => i % 3 === 1);
    for (const id of idsToRemove) {
      bus.emit('growth:remove', { id });
      live.delete(id);
    }

    // Phase 4: spawn a fresh batch again (reusing freed slots) to exercise place() picking up
    // right after a bunch of compactions.
    for (let k = 0; k < 100; k++) {
      const id = freshId();
      const kind = kinds[k % kinds.length];
      spawn(bus, kind, 6000 + (k % 20) * 3, 6000 + Math.floor(k / 20) * 3, id);
      live.set(id, kind);
    }

    const stats = sr.instanceStats;
    const expectedByKind = { tree: 0, house: 0, building: 0, field: 0 } as Record<GrowthKind, number>;
    for (const kind of live.values()) expectedByKind[kind]++;

    expect(stats.trackedInstances).toBe(baseline.trackedInstances + live.size);
    expect(stats.byIdSize).toBe(baseline.byIdSize + live.size);
    expect(stats.treeMeshTotal).toBe(baseline.treeMeshTotal + expectedByKind.tree);
    expect(stats.houseMeshTotal).toBe(baseline.houseMeshTotal + expectedByKind.house);
    expect(stats.buildingMeshTotal).toBe(baseline.buildingMeshTotal + expectedByKind.building);
    expect(stats.fieldMeshCount).toBe(baseline.fieldMeshCount + expectedByKind.field);
    // 3 stripe quads per live field, no more no less (Task 35: field stripe compaction).
    expect(stats.fieldStripeMeshCount).toBe(baseline.fieldStripeMeshCount + expectedByKind.field * 3);
    // Every house/building has exactly one window quad.
    expect(stats.windowMeshCount).toBe(baseline.windowMeshCount + expectedByKind.house + expectedByKind.building);

    // Remove everything spawned by this test and confirm every mesh returns to exactly the
    // pre-test baseline — the strongest possible "no ghosts" check: nothing invisible left
    // occupying a slot, and no cross-test slot corruption either.
    for (const id of [...live.keys()]) bus.emit('growth:remove', { id });
    const finalStats = sr.instanceStats;
    expect(finalStats.trackedInstances).toBe(baseline.trackedInstances);
    expect(finalStats.byIdSize).toBe(baseline.byIdSize);
    expect(finalStats.treeMeshTotal).toBe(baseline.treeMeshTotal);
    expect(finalStats.houseMeshTotal).toBe(baseline.houseMeshTotal);
    expect(finalStats.buildingMeshTotal).toBe(baseline.buildingMeshTotal);
    expect(finalStats.fieldMeshCount).toBe(baseline.fieldMeshCount);
    expect(finalStats.fieldStripeMeshCount).toBe(baseline.fieldStripeMeshCount);
    expect(finalStats.windowMeshCount).toBe(baseline.windowMeshCount);
  });
});
