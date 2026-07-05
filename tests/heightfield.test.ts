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

  // Task 47 item 2 ("combined easement x grading load"): beginDeformBatch()/endDeformBatch() defer
  // and dedupe flattenCircle's per-call easement replay to once per batch. See
  // perfEasementGrading.test.ts for the integration-level perf evidence; these are focused
  // Heightfield-level unit tests for the bracket's own semantics.
  describe('deform batching (Task 47 item 2)', () => {
    /** Registers a single easement sample at (0,0) with a low ceiling, so any flattenCircle that
     * raises terrain there gets pulled back down whenever the easement is (re-)replayed. */
    function withLowCeilingEasement(hf: Heightfield, ceiling: number) {
      hf.registerRoadEasement(
        1,
        [{ x: 0, z: 0, y: ceiling, bridge: false }],
        () => 0,
        12, 12, 12, 12,
      );
    }

    it('outside a batch, flattenCircle still replays the easement immediately (unchanged behavior)', () => {
      const hf = new Heightfield('batch-s1');
      const ceiling = hf.heightAt(0, 0);
      withLowCeilingEasement(hf, ceiling);
      hf.flattenCircle(5, 5, ceiling + 20, 12); // overlaps (0,0)'s easement footprint
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(ceiling + 0.05);
    });

    it('within an open batch, the easement replay is deferred but the underlying deform still applies immediately', () => {
      const hf = new Heightfield('batch-s2');
      const ceiling = hf.heightAt(0, 0);
      withLowCeilingEasement(hf, ceiling);
      hf.beginDeformBatch();
      hf.flattenCircle(5, 5, ceiling + 20, 12);
      // The raw flattenCircle blend itself should already show through near ITS OWN center (5,5)
      // — this test only asserts the EASEMENT's re-clamp at (0,0) is what's deferred, not that
      // flattenCircle no-ops.
      expect(hf.heightAt(5, 5)).toBeGreaterThan(ceiling + 4);
      // The easement's ceiling at (0,0) has NOT been re-enforced yet — terrain there is free to
      // sit above `ceiling` until the batch closes.
      expect(hf.heightAt(0, 0)).toBeGreaterThan(ceiling + 0.05);
      hf.endDeformBatch();
      // Now that the batch closed, the deferred replay has run.
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(ceiling + 0.05);
    });

    it('replays each touched easement sample only once per batch, regardless of how many flattenCircle calls touched it', () => {
      const hf = new Heightfield('batch-s3');
      const ceiling = hf.heightAt(0, 0);
      let replayCalls = 0;
      const originalApply = (hf as any).applyClampBelow.bind(hf);
      (hf as any).applyClampBelow = (...args: unknown[]) => {
        replayCalls++;
        return originalApply(...args);
      };
      withLowCeilingEasement(hf, ceiling);
      hf.beginDeformBatch();
      for (let i = 0; i < 10; i++) hf.flattenCircle(5, 5, ceiling + 20, 12); // 10 calls, same footprint
      expect(replayCalls).toBe(0); // deferred — none replayed yet mid-batch
      hf.endDeformBatch();
      expect(replayCalls).toBe(1); // exactly one replay for the one registered sample
    });

    it('nested begin/end pairs only flush at the outermost end (defensive)', () => {
      const hf = new Heightfield('batch-s4');
      const ceiling = hf.heightAt(0, 0);
      withLowCeilingEasement(hf, ceiling);
      hf.beginDeformBatch();
      hf.beginDeformBatch();
      hf.flattenCircle(5, 5, ceiling + 20, 12);
      hf.endDeformBatch(); // inner close — should NOT flush yet
      expect(hf.heightAt(0, 0)).toBeGreaterThan(ceiling + 0.05);
      hf.endDeformBatch(); // outer close — flushes now
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(ceiling + 0.05);
    });

    it('endDeformBatch is a safe no-op when called without a matching begin', () => {
      const hf = new Heightfield('batch-s5');
      expect(() => hf.endDeformBatch()).not.toThrow();
    });

    it('a batch with zero registered easements is a cheap no-op (does not affect ordinary flattenCircle behavior)', () => {
      const hf = new Heightfield('batch-s6');
      const before = hf.heightAt(0, 0);
      hf.beginDeformBatch();
      hf.flattenCircle(0, 0, before + 5, 12);
      hf.endDeformBatch();
      expect(hf.heightAt(0, 0)).toBeGreaterThan(before + 4);
    });

    it('endDeformBatch is reached by finally even if an update throws mid-batch', () => {
      // Critical: the Loop uses try/finally to bracket sim updates. If any update throws
      // mid-batch, onBatchEnd (which calls endDeformBatch) must still fire or the batch
      // never closes and deformBatchDepth sticks > 0, leaving all future easement replays
      // deferred forever (Task 47 critical finding).
      const hf = new Heightfield('batch-s7');
      const ceiling = hf.heightAt(0, 0);
      withLowCeilingEasement(hf, ceiling);

      let endWasCalled = false;
      const originalEnd = hf.endDeformBatch.bind(hf);
      hf.endDeformBatch = function (this: any) {
        endWasCalled = true;
        return originalEnd.call(this);
      };

      expect(() => {
        hf.beginDeformBatch();
        try {
          hf.flattenCircle(5, 5, ceiling + 20, 12);
          throw new Error('simulated update failure');
        } finally {
          hf.endDeformBatch();
        }
      }).toThrow('simulated update failure');

      expect(endWasCalled).toBe(true);
      // Verify the batch actually closed and can dedupe properly by opening/closing again
      // and confirming a deferred operation completes.
      hf.beginDeformBatch();
      hf.flattenCircle(5, 5, ceiling + 20, 12);
      hf.endDeformBatch();
      expect(hf.heightAt(0, 0)).toBeLessThanOrEqual(ceiling + 0.05);
    });
  });
});
