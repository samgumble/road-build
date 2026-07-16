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

  // Critical 3 (Groundwork round fix wave): `growth:rescued` must recover a mid-fade instance back
  // to full scale (easing, not snapping) rather than leaving it permanently stuck at scale~0 with
  // no sim event ever telling the renderer to bring it back — the bug being that `onStranded`
  // started a fade with nothing ever un-doing it short of `growth:remove`, which never arrives for
  // a rescued record.
  describe('rescue recovery (Critical 3)', () => {
    it('a mid-fade instance eases back to full scale on growth:rescued, not a snap', () => {
      const id = freshId();
      spawn(bus, 'tree', 9100, 9100, id);
      bus.emit('growth:stranded', { id });
      sr.update(15); // 15s into the 30s fade -> scale ~0.5
      const midFadeScale = sr.scaleOf(id)!;
      expect(midFadeScale).toBeCloseTo(0.5, 1);
      expect(sr.isFading(id)).toBe(true);

      bus.emit('growth:rescued', { id });
      // Immediately after rescue, before any further update(), the instance must NOT have snapped
      // to full scale — it should still read at (approximately) the same scale it was rescued at,
      // now tracked as recovering instead of fading.
      expect(sr.isFading(id)).toBe(false);
      expect(sr.isRecovering(id)).toBe(true);
      expect(sr.scaleOf(id)!).toBeCloseTo(midFadeScale, 1);

      // Advance partway through the ~1s recovery ease — scale should be climbing back toward 1,
      // strictly greater than where it was rescued but not yet fully there.
      sr.update(0.5);
      const midRecoveryScale = sr.scaleOf(id)!;
      expect(midRecoveryScale).toBeGreaterThan(midFadeScale);
      expect(midRecoveryScale).toBeLessThan(1);

      // Advance past the recovery duration — fully recovered, back to normal full-scale steady
      // state, no longer tracked in either animation list.
      sr.update(1);
      expect(sr.isRecovering(id)).toBe(false);
      expect(sr.scaleOf(id)!).toBeCloseTo(1, 2);

      bus.emit('growth:remove', { id });
    });

    it('growth:rescued during the grace window (no fade ever started) is a harmless no-op', () => {
      const id = freshId();
      spawn(bus, 'tree', 9110, 9110, id);
      sr.update(1); // let the normal pop-in animation finish -> settles at full scale
      // No growth:stranded ever fired for this id — mirrors a sim-side rescue during grace, where
      // the renderer never had anything to visually alter in the first place.
      expect(() => bus.emit('growth:rescued', { id })).not.toThrow();
      expect(sr.isFading(id)).toBe(false);
      expect(sr.isRecovering(id)).toBe(false);
      expect(sr.scaleOf(id)).toBeCloseTo(1, 2);
      bus.emit('growth:remove', { id });
    });

    it('re-stranding mid-recovery eases back down from the current partial scale, not a snap to full scale first', () => {
      const id = freshId();
      spawn(bus, 'tree', 9120, 9120, id);
      bus.emit('growth:stranded', { id });
      sr.update(15); // 15s into the 30s fade -> scale ~0.5
      const fadeScaleAtRescue = sr.scaleOf(id)!;

      bus.emit('growth:rescued', { id });
      sr.update(0.5); // partway back through the ~1s recovery ease
      const recoveredScaleBeforeReStrand = sr.scaleOf(id)!;
      expect(recoveredScaleBeforeReStrand).toBeGreaterThan(fadeScaleAtRescue);
      expect(recoveredScaleBeforeReStrand).toBeLessThan(1);

      // Re-stranded while still mid-recovery — trace the "other direction" this finding calls for.
      bus.emit('growth:stranded', { id });
      expect(sr.isRecovering(id)).toBe(false);
      expect(sr.isFading(id)).toBe(true);
      // Must NOT have snapped to full scale (1) before starting the new fade — reads at
      // (approximately) wherever the recovery had already eased back to.
      expect(sr.scaleOf(id)!).toBeCloseTo(recoveredScaleBeforeReStrand, 1);

      // The new fade continues shrinking from that point, not from a fresh scale-1 start.
      sr.update(0.5);
      expect(sr.scaleOf(id)!).toBeLessThan(recoveredScaleBeforeReStrand);

      bus.emit('growth:remove', { id });
    });
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
    // Every house/building has AT LEAST one window quad (night polish pass: houses 1-2,
    // buildings a 3-6 row grid); the exact-baseline restore below is the strong compaction check.
    expect(stats.windowMeshCount).toBeGreaterThanOrEqual(baseline.windowMeshCount + expectedByKind.house + expectedByKind.building);

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

  // Finding 2 (Task 35 follow-up "Groundwork"): rebuild() must apply partial fade for records that
  // were mid-fade at save time — no animation, correct scale/sink for the saved offset — rather
  // than popping them back in at full scale with a freshly-restarted fade.
  describe('rebuild() partial-fade restoration (Finding 2)', () => {
    it('renders overlapping saved structures at their authoritative shared coordinates', () => {
      const houseId = freshId();
      const buildingId = freshId();
      sr.rebuild([
        { kind: 'house', x: 8070, z: 8070, rot: 0, id: houseId },
        { kind: 'building', x: 8070, z: 8070, rot: 0, id: buildingId },
      ]);
      const instances = (sr as unknown as {
        byId: Map<number, { x: number; z: number }>;
      }).byId;

      expect(instances.get(houseId)).toMatchObject({ x: 8070, z: 8070 });
      expect(instances.get(buildingId)).toMatchObject({ x: 8070, z: 8070 });
      bus.emit('growth:remove', { id: houseId });
      bus.emit('growth:remove', { id: buildingId });
    });

    it('a record with no decay entry rebuilds at full scale, not fading', () => {
      const id = freshId();
      sr.rebuild([{ kind: 'tree', x: 8000, z: 8000, rot: 0, id }]);
      expect(sr.scaleOf(id)).toBeCloseTo(1, 3);
      expect(sr.isFading(id)).toBe(false);
      bus.emit('growth:remove', { id });
    });

    it('a record with a mid-fade decay entry rebuilds already partially scaled down, continuing to fade', () => {
      const id = freshId();
      // 15s into the 30s fade (STRANDED_FADE_DURATION) -> expected scale 1 - 15/30 = 0.5.
      sr.rebuild([{ kind: 'house', x: 8010, z: 8010, rot: 0, id }], [{ id, fading: 15 }]);
      const scale = sr.scaleOf(id);
      expect(scale).not.toBeNull();
      expect(scale!).toBeCloseTo(0.5, 1);
      expect(sr.isFading(id)).toBe(true);

      // Continues fading from that point — advancing the remaining ~15s completes it.
      sr.update(16);
      expect(sr.isFading(id)).toBe(false);
      bus.emit('growth:remove', { id });
    });

    it('a record saved right at the very start of its fade (offset ~0) rebuilds at full scale but still tracked as fading', () => {
      const id = freshId();
      sr.rebuild([{ kind: 'tree', x: 8020, z: 8020, rot: 0, id }], [{ id, fading: 0 }]);
      expect(sr.scaleOf(id)).toBeCloseTo(1, 2);
      expect(sr.isFading(id)).toBe(true);
      bus.emit('growth:remove', { id });
    });

    it('a record with only a mid-grace decay entry (not yet fading) rebuilds normally, at full scale and not fading', () => {
      const id = freshId();
      sr.rebuild([{ kind: 'field', x: 8030, z: 8030, rot: 0, id }], [{ id, stranded: 45 }]);
      expect(sr.scaleOf(id)).toBeCloseTo(1, 3);
      expect(sr.isFading(id)).toBe(false);
      bus.emit('growth:remove', { id });
    });

    it('rebuild() clears any previously-tracked fade/decay state from an earlier rebuild', () => {
      const idA = freshId();
      sr.rebuild([{ kind: 'tree', x: 8040, z: 8040, rot: 0, id: idA }], [{ id: idA, fading: 10 }]);
      expect(sr.isFading(idA)).toBe(true);

      // A second rebuild() with a disjoint record set must not leave idA's fade entry dangling.
      const idB = freshId();
      sr.rebuild([{ kind: 'tree', x: 8050, z: 8050, rot: 0, id: idB }]);
      expect(sr.isFading(idA)).toBe(false);
      expect(sr.scaleOf(idA)).toBeNull(); // idA's instance no longer exists at all post-rebuild
      bus.emit('growth:remove', { id: idB });
    });
  });

  // Critical 2 (Groundwork round fix wave): `wilderness:cleared`'s `indices` always refer to the
  // ORIGINAL WildernessTree[] index (see events.ts's doc comment). `setWilderness` used to be keyed
  // by the CALLER'S array position instead — harmless when the caller passes every site (position
  // == original index), but wrong the moment the caller passes a COMPACTED subset (main.ts uses
  // `wildernessSim.active`/`activeWithIndex` specifically because a restored world may have already
  // cleared some sites before boot). This reproduces that exact scenario at the renderer level: seed
  // `setWilderness` with a subset that SKIPS an already-cleared low-index site (mirroring a restore),
  // then fire `wilderness:cleared` for a real still-live site's original index, and confirm the
  // renderer fades THAT site — not whatever happens to sit at the same compacted array position.
  describe('setWilderness index correlation across a restore-like precleared gap (Critical 2)', () => {
    it('fades the correct site by original index even when an earlier site was never placed (precleared)', () => {
      // Three original sites: index 0 (precleared — simulates a restore where this site's corridor
      // was already graded before boot, so it's never passed to setWilderness at all), index 1 and
      // index 2 both live. Under the old array-position-keyed bug, passing [site1, site2] (skipping
      // site0) would store site1 at array position 0 and site2 at position 1 — so a
      // `wilderness:cleared` for original index 2 would incorrectly resolve to whatever sits at
      // position 2 (nothing, in this 2-element array) instead of site2's actual placed instances.
      const site1 = { x: 9000, z: 9000, rot: 0, count: 1 };
      const site2 = { x: 9010, z: 9010, rot: 0, count: 1 };
      sr.setWilderness([
        { tree: site1, originalIndex: 1 },
        { tree: site2, originalIndex: 2 },
      ]);

      expect(sr.isWildernessSiteFading(1)).toBe(false);
      expect(sr.isWildernessSiteFading(2)).toBe(false);

      // Live clear targeting original index 2 (site2) — index 0 (precleared, never placed) and
      // index 1 (site1) must NOT be affected.
      bus.emit('wilderness:cleared', { indices: [2] });

      expect(sr.isWildernessSiteFading(2)).toBe(true);
      expect(sr.isWildernessSiteFading(1)).toBe(false);
      expect(sr.isWildernessSiteFading(0)).toBe(false); // never placed — nothing to fade, nothing to misfire onto

      // Let the fade complete so it doesn't leak into later tests' instance counts (matches
      // sceneryRenderer.ts's WILDERNESS_FADE_DURATION of 1.5s).
      sr.update(1.6);
    });
  });

  // Minor 7 (Groundwork round fix wave): `rebuild()` zeroes every tree InstancedMesh's count
  // (orphaning any previously-placed wilderness instances — their slots are gone, reassigned to
  // whatever `rebuild()` places next) but used to leave `wildernessInstancesBySite` untouched. A
  // re-entrant `rebuild()` -> `setWilderness()` cycle (which shouldn't normally happen in main.ts's
  // boot sequence, but nothing enforced that it couldn't) would then leave stale index entries
  // pointing at dangling `Instance` objects whose `.slot` no longer corresponds to anything real —
  // a later `wilderness:cleared` for one of THOSE indices (never re-placed by the second
  // `setWilderness` call, so nothing legitimately occupies that index anymore) would incorrectly
  // still report as "fading" instead of "nothing to fade" (no live entry for that index at all).
  describe('rebuild() resets wilderness tracking so a second setWilderness cycle cannot double-place (Minor 7)', () => {
    it('an index from before a rebuild is not still "known" after rebuild(), even if never re-placed', () => {
      const siteA = { x: 9200, z: 9200, rot: 0, count: 1 };
      sr.setWilderness([{ tree: siteA, originalIndex: 7 }]);
      expect(sr.isWildernessSiteFading(7)).toBe(false); // sanity: not fading yet

      // A rebuild (as a restore does) wipes the tree mesh's live range out from under siteA's
      // instance — its slot is gone/reassigned. Without the Minor 7 fix,
      // `wildernessInstancesBySite` would still map index 7 to that now-dangling Instance object.
      sr.rebuild([]);

      // The second setWilderness cycle intentionally does NOT re-place index 7 (mirrors a real
      // restore where a previously-live site's corridor got cleared in the interim, so main.ts's
      // fresh activeWithIndex list simply omits it this time around).
      const siteB = { x: 9210, z: 9210, rot: 0, count: 1 };
      sr.setWilderness([{ tree: siteB, originalIndex: 8 }]);

      // A live clear naming index 7 must be a no-op: nothing legitimately live occupies that index
      // post-rebuild. Without the fix, the stale dangling entry from before the rebuild would still
      // be found and (incorrectly) pushed into the fading list.
      bus.emit('wilderness:cleared', { indices: [7] });
      expect(sr.isWildernessSiteFading(7)).toBe(false);

      // Index 8 (the real, freshly-placed site) still clears correctly.
      bus.emit('wilderness:cleared', { indices: [8] });
      expect(sr.isWildernessSiteFading(8)).toBe(true);

      sr.update(1.6); // let the fade complete so it doesn't leak into later tests
    });
  });

  // Task 42 ("Groundwork"): road corridor clearing — a QUICK (~1.5s) fade distinct from
  // growth:stranded's much slower (30s) decay fade, triggered by GrowthSim's own growth:cleared
  // event rather than growth:stranded, and reusing growth:remove for final slot-freeing exactly
  // like stranded decay does.
  describe('corridor clearing fade (Task 42)', () => {
    it('growth:cleared starts a quick fade distinct from the 30s stranded fade, growth:remove frees the slot', () => {
      const before = sr.instanceStats.treeMeshTotal;
      const id = freshId();
      spawn(bus, 'tree', 9300, 9300, id);
      expect(sr.instanceStats.treeMeshTotal).toBe(before + 1);

      bus.emit('growth:cleared', { id });
      expect(sr.isFading(id)).toBe(true);

      // Partway through the quick ~1.5s fade — well short of it, so still present and mid-fade.
      sr.update(0.5);
      expect(sr.instanceStats.treeMeshTotal).toBe(before + 1);
      const midScale = sr.scaleOf(id)!;
      expect(midScale).toBeLessThan(1);
      expect(midScale).toBeGreaterThan(0);

      // If this were mistakenly using STRANDED_FADE_DURATION (30s), only 0.5s in would barely have
      // moved (scale ~0.983) — the quick 1.5s duration should read meaningfully further along.
      expect(midScale).toBeLessThan(0.7);

      bus.emit('growth:remove', { id });
      expect(sr.instanceStats.treeMeshTotal).toBe(before);
    });

    it('a growth:cleared instance is not rescuable: growth:rescued is a no-op for it', () => {
      const id = freshId();
      spawn(bus, 'house', 9310, 9310, id);
      bus.emit('growth:cleared', { id });
      sr.update(0.5);
      const midScale = sr.scaleOf(id)!;

      // No sim code path ever emits growth:rescued for a corridor-cleared id, but the renderer
      // should not misbehave even if it somehow arrived — this asserts current behavior rather than
      // prescribing a specific one, since the sim-level contract (no rescue) is what actually
      // matters and is covered in growth.test.ts.
      bus.emit('growth:rescued', { id });
      sr.update(0.01);

      bus.emit('growth:remove', { id });
      expect(sr.scaleOf(id)).toBeNull();
      void midScale;
    });

    it('rebuild() with clearingIds starts a fresh quick fade for a restored record still in its corridor', () => {
      const id = freshId();
      sr.rebuild([{ kind: 'tree', x: 8060, z: 8060, rot: 0, id }], [], [id]);
      expect(sr.isFading(id)).toBe(true);
      // Fresh fade (elapsed 0) — full scale at the very first instant, same as a stranded record
      // saved at offset ~0 (see the analogous rebuild() test above).
      expect(sr.scaleOf(id)).toBeCloseTo(1, 2);

      sr.update(1.6); // past the quick ~1.5s duration
      expect(sr.isFading(id)).toBe(false);
      bus.emit('growth:remove', { id });
    });

    // Groundwork batch-review Finding 3: a growth:cleared record used to leave a stale `recovering`
    // entry alive if it arrived while the renderer was still easing a rescued instance back to full
    // scale (RESCUE_RECOVERY_DURATION ~1s) — the sim's clearing/stranded-decay pipelines are mutually
    // exclusive, but the renderer's own `recovering` animation outlives the sim's instant rescue, so
    // a road corridor reaching a just-rescued record within that ~1s window could still race it.
    // Without evicting `recovering` in `onCleared`, update()'s recovering loop (which runs AFTER the
    // fading loop, each frame) would overwrite the clearing fade's transform with the recovery's,
    // visually snapping the instance back toward full scale/zero sink instead of clearing.
    it('rescue-then-clear within the recovery window evicts the stale recovering entry, clearing fade wins', () => {
      const id = freshId();
      spawn(bus, 'tree', 9320, 9320, id);
      bus.emit('growth:stranded', { id });
      sr.update(15); // 15s into the 30s stranded fade -> scale ~0.5
      const fadeScaleAtRescue = sr.scaleOf(id)!;
      expect(fadeScaleAtRescue).toBeCloseTo(0.5, 1);

      bus.emit('growth:rescued', { id });
      expect(sr.isRecovering(id)).toBe(true);
      expect(sr.isFading(id)).toBe(false);

      // A road corridor reaches this record and clears it well within the ~1s recovery window.
      bus.emit('growth:cleared', { id });
      expect(sr.isRecovering(id)).toBe(false); // stale recovering entry evicted
      expect(sr.isFading(id)).toBe(true); // clearing's own fade now owns this instance

      // Advance well past the recovery ease's own duration (~1s) but still mid the quick ~1.5s
      // clearing fade — if the stale recovering entry had NOT been evicted, its per-frame write
      // would win (it runs after fading's in update()) and this would read back near full scale
      // instead of continuing to shrink toward 0.
      sr.update(0.9);
      expect(sr.isRecovering(id)).toBe(false);
      expect(sr.isFading(id)).toBe(true);
      const scaleMidClear = sr.scaleOf(id)!;
      expect(scaleMidClear).toBeLessThan(0.5); // still clearing, not snapped back toward full scale

      sr.update(1); // past the quick ~1.5s clearing fade entirely
      expect(sr.isFading(id)).toBe(false);
      bus.emit('growth:remove', { id });
    });
  });
});
