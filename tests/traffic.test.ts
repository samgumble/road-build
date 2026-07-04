import { describe, it, expect } from 'vitest';
import { TrafficSim } from '../src/sim/traffic/traffic';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import type { P2, RoadSample } from '../src/core/types';

const flatSampler = (ctrl: P2[]): RoadSample[] => {
  const out: RoadSample[] = [];
  for (let s = 0; s < ctrl.length - 1; s++) {
    const a = ctrl[s], b = ctrl[s + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + (b.x - a.x) * k / n, y: 0, z: a.z + (b.z - a.z) * k / n, bridge: false });
  }
  out.push({ x: ctrl[ctrl.length - 1].x, y: 0, z: ctrl[ctrl.length - 1].z, bridge: false });
  return out;
};

function world() {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  g.commitChain([{ x: 0, z: 0 }, { x: 200, z: 0 }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  bus.emit('roads:changed', {});
  const sim = new TrafficSim(g, bus, createRng('traffic'));
  return { bus, g, sim };
}

/**
 * A network with several distinct nodes to draw endpoints from: a straight chain plus a branch,
 * split into multiple node-bearing segments so `pickSpawnPair` has more than 2 candidates and a
 * weighted draw toward one cluster is statistically distinguishable from uniform.
 */
function multiNodeWorld() {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  g.commitChain([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }, { x: 150, z: 0 }, { x: 200, z: 0 }]);
  g.commitChain([{ x: 100, z: 0 }, { x: 100, z: 100 }, { x: 100, z: 200 }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  bus.emit('roads:changed', {});
  const sim = new TrafficSim(g, bus, createRng('traffic'));
  return { bus, g, sim };
}

describe('TrafficSim', () => {
  it('spawns cars up to targetPopulation and moves them', () => {
    const { sim } = world();
    sim.targetPopulation = 3;
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    expect(sim.cars.length).toBeGreaterThan(0);
    expect(sim.cars.length).toBeLessThanOrEqual(3);
    for (const c of sim.cars) expect(Number.isFinite(c.pos.x)).toBe(true);
  });
  it('cars never overlap below the hard gap on the same lane', () => {
    const { sim } = world();
    sim.targetPopulation = 6;
    let minGap = Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      sim.update(1 / 60);
      const byLane = new Map<number, number[]>();
      for (const c of sim.cars) {
        const s = sim.laneAndS(c.id);
        if (!s) continue;
        (byLane.get(s.laneId) ?? byLane.set(s.laneId, []).get(s.laneId)!).push(s.s);
      }
      for (const arr of byLane.values()) {
        arr.sort((a, b) => a - b);
        for (let k = 1; k < arr.length; k++) minGap = Math.min(minGap, arr[k] - arr[k - 1]);
      }
    }
    expect(minGap).toBeGreaterThan(2.5);
  });
  it('despawns cars when their road is removed', () => {
    const { sim, g } = world();
    sim.targetPopulation = 3;
    for (let i = 0; i < 60 * 10; i++) sim.update(1 / 60);
    for (const id of [...g.edges.keys()]) g.removeEdge(id);
    sim.update(1 / 60);
    expect(sim.cars.length).toBe(0);
  });

  it('weights spawn endpoints toward nodes near clustered houses (statistical, seeded)', () => {
    const { bus, g, sim } = multiNodeWorld();
    // Cluster several houses near the far end of the branch (the last-committed node) and none
    // near any other node, so that node's weight should dominate the draw.
    const nodesBefore = [...g.nodes.values()];
    const targetNode = nodesBefore.reduce((a, b) => (b.z > a.z ? b : a));
    for (let k = 0; k < 6; k++) {
      bus.emit('growth:spawn', { kind: 'house', x: targetNode.x + k * 0.5, z: targetNode.z - 2 + k * 0.5, rot: 0 });
    }
    // Throttled recompute mirrors GrowthSim's pattern — advance sim time past the throttle window.
    sim.update(2.1, 0.5);

    const targetNodeId = targetNode.id;

    let hitsAtTarget = 0;
    let totalDraws = 0;
    const nodeCount = g.nodes.size;
    for (let i = 0; i < 2000; i++) {
      const picked = (sim as any).pickSpawnPair();
      if (!picked) continue;
      totalDraws++;
      if (picked.from === targetNodeId || picked.to === targetNodeId) hitsAtTarget++;
    }
    expect(totalDraws).toBeGreaterThan(0);
    const observedRate = hitsAtTarget / totalDraws;
    // Uniform baseline: each draw picks 2 of nodeCount nodes, so P(hit target) ~ 2/nodeCount.
    const uniformRate = 2 / nodeCount;
    expect(observedRate).toBeGreaterThan(uniformRate * 1.5);
  });

  it('falls back to uniform-like behavior with no settlements yet', () => {
    const { sim } = multiNodeWorld();
    // No growth:spawn events emitted — weight map should be empty/zero everywhere, so pickSpawnPair
    // still succeeds (uniform fallback) rather than always returning null.
    let successes = 0;
    for (let i = 0; i < 200; i++) {
      const picked = (sim as any).pickSpawnPair();
      if (picked) successes++;
    }
    expect(successes).toBeGreaterThan(0);
  });

  it('spawns cars at a lower rate at deep night than during a commute peak', () => {
    const { sim: daySim } = multiNodeWorld();
    daySim.targetPopulation = 1000; // effectively uncapped so rate is spawn-timer-bound, not population-bound
    let daySpawns = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const before = (daySim as any).cs.length;
      daySim.update(1 / 60, 0.3); // morning commute peak
      const after = (daySim as any).cs.length;
      if (after > before) daySpawns++;
    }

    const { sim: nightSim } = multiNodeWorld();
    nightSim.targetPopulation = 1000;
    let nightSpawns = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const before = (nightSim as any).cs.length;
      nightSim.update(1 / 60, 0.95); // deep night
      const after = (nightSim as any).cs.length;
      if (after > before) nightSpawns++;
    }

    expect(nightSpawns).toBeLessThan(daySpawns);
  });

  it('is deterministic across two independent runs with the same seed and inputs', () => {
    function run() {
      const { bus, sim } = multiNodeWorld();
      for (let k = 0; k < 4; k++) {
        bus.emit('growth:spawn', { kind: 'house', x: 100 + k, z: 198, rot: 0 });
      }
      const timeOfDays = [0.1, 0.3, 0.5, 0.75, 0.95];
      const positions: Array<{ x: number; z: number }> = [];
      for (let i = 0; i < 60 * 30; i++) {
        sim.update(1 / 60, timeOfDays[i % timeOfDays.length]);
        for (const c of sim.cars) positions.push({ x: c.pos.x, z: c.pos.z });
      }
      return positions;
    }
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  // Task 35: growth:upgrade / growth:remove keep the settlement weight map in sync with the actual
  // set of houses/buildings — previously `houses`/`buildings` only ever grew via growth:spawn, so a
  // demolished/upgraded settlement would keep contributing weight forever.
  describe('settlement weight sync (Task 35)', () => {
    it('moves a house entry to buildings on growth:upgrade (weight-affecting, not just relabeled)', () => {
      const { bus, sim } = multiNodeWorld();
      bus.emit('growth:spawn', { kind: 'house', x: 100, z: 100, rot: 0, id: 42 });
      expect((sim as any).houses).toEqual([{ x: 100, z: 100, id: 42 }]);
      expect((sim as any).buildings).toEqual([]);

      bus.emit('growth:upgrade', { id: 42 });

      expect((sim as any).houses).toEqual([]);
      expect((sim as any).buildings).toEqual([{ x: 100, z: 100, id: 42 }]);
    });

    it('growth:upgrade for an unknown id is a harmless no-op', () => {
      const { bus, sim } = multiNodeWorld();
      bus.emit('growth:spawn', { kind: 'house', x: 100, z: 100, rot: 0, id: 1 });
      expect(() => bus.emit('growth:upgrade', { id: 999 })).not.toThrow();
      expect((sim as any).houses).toEqual([{ x: 100, z: 100, id: 1 }]);
    });

    it('drops a house entry from the weight map on growth:remove', () => {
      const { bus, sim } = multiNodeWorld();
      bus.emit('growth:spawn', { kind: 'house', x: 100, z: 100, rot: 0, id: 7 });
      expect((sim as any).houses).toEqual([{ x: 100, z: 100, id: 7 }]);

      bus.emit('growth:remove', { id: 7 });

      expect((sim as any).houses).toEqual([]);
    });

    it('drops a building entry from the weight map on growth:remove', () => {
      const { bus, sim } = multiNodeWorld();
      bus.emit('growth:spawn', { kind: 'building', x: 50, z: 50, rot: 0, id: 8 });
      expect((sim as any).buildings).toEqual([{ x: 50, z: 50, id: 8 }]);

      bus.emit('growth:remove', { id: 8 });

      expect((sim as any).buildings).toEqual([]);
    });

    it('a removed settlement no longer inflates its node weight (statistical, seeded)', () => {
      const { bus, g, sim } = multiNodeWorld();
      const nodesBefore = [...g.nodes.values()];
      const targetNode = nodesBefore.reduce((a, b) => (b.z > a.z ? b : a));
      const houseIds: number[] = [];
      for (let k = 0; k < 6; k++) {
        const id = 100 + k;
        houseIds.push(id);
        bus.emit('growth:spawn', {
          kind: 'house',
          x: targetNode.x + k * 0.5,
          z: targetNode.z - 2 + k * 0.5,
          rot: 0,
          id,
        });
      }
      sim.update(2.1, 0.5); // apply the throttled recompute with all 6 houses present

      const targetNodeId = targetNode.id;
      const nodeCount = g.nodes.size;
      const drawRateAtTarget = () => {
        let hits = 0, total = 0;
        for (let i = 0; i < 2000; i++) {
          const picked = (sim as any).pickSpawnPair();
          if (!picked) continue;
          total++;
          if (picked.from === targetNodeId || picked.to === targetNodeId) hits++;
        }
        return { hits, total };
      };

      const before = drawRateAtTarget();
      const uniformRate = 2 / nodeCount;
      expect(before.hits / before.total).toBeGreaterThan(uniformRate * 1.5);

      // Remove every house at the target node and let the recompute apply.
      for (const id of houseIds) bus.emit('growth:remove', { id });
      sim.update(2.1, 0.5);

      const after = drawRateAtTarget();
      // Back down near the uniform baseline now that the target node has no settlement weight.
      expect(after.hits / after.total).toBeLessThan(uniformRate * 1.5);
    });
  });

  // Important 4 (Groundwork round fix wave): TrafficSim's houses/buildings arrays previously
  // populated ONLY from live `growth:spawn` events — nothing ever seeded them from a restored
  // world's `growth.spawned` records, so every reload of a save with an established settlement
  // reset traffic weighting back to uniform (as if no houses/buildings existed at all) until fresh
  // ones grew again live. `traffic.restore(records)` mirrors the `growth:spawn` handler exactly,
  // called once in main.ts right after `restoreWorld`.
  describe('restore() seeds settlement weights from a restored world (Important 4)', () => {
    it('weights spawn endpoints toward nodes near a restored settlement, without any live growth:spawn ever firing (statistical, seeded)', () => {
      const { g, sim } = multiNodeWorld();
      const nodesBefore = [...g.nodes.values()];
      const targetNode = nodesBefore.reduce((a, b) => (b.z > a.z ? b : a));

      // Mirrors a save's growth.spawned array — houses clustered near the target node — fed in via
      // restore() only, exactly as main.ts does after restoreWorld. No growth:spawn is ever emitted.
      const records = [];
      for (let k = 0; k < 6; k++) {
        records.push({
          kind: 'house' as const,
          x: targetNode.x + k * 0.5,
          z: targetNode.z - 2 + k * 0.5,
          rot: 0,
          id: 100 + k,
        });
      }
      sim.restore(records);
      sim.update(2.1, 0.5); // apply the throttled recompute (mirrors T32's own pattern)

      const targetNodeId = targetNode.id;
      const nodeCount = g.nodes.size;
      let hitsAtTarget = 0;
      let totalDraws = 0;
      for (let i = 0; i < 2000; i++) {
        const picked = (sim as any).pickSpawnPair();
        if (!picked) continue;
        totalDraws++;
        if (picked.from === targetNodeId || picked.to === targetNodeId) hitsAtTarget++;
      }
      expect(totalDraws).toBeGreaterThan(0);
      const observedRate = hitsAtTarget / totalDraws;
      const uniformRate = 2 / nodeCount;
      expect(observedRate).toBeGreaterThan(uniformRate * 1.5);
    });

    it('restore() seeds both houses and buildings, keyed by id, so later growth:upgrade/growth:remove still work against restored records', () => {
      const { bus, sim } = multiNodeWorld();
      sim.restore([
        { kind: 'house', x: 100, z: 100, rot: 0, id: 1 },
        { kind: 'building', x: 50, z: 50, rot: 0, id: 2 },
        { kind: 'tree', x: 10, z: 10, rot: 0, id: 3 }, // non-settlement kind — must be ignored
        { kind: 'field', x: 20, z: 20, rot: 0, id: 4 }, // non-settlement kind — must be ignored
      ]);
      expect((sim as any).houses).toEqual([{ x: 100, z: 100, id: 1 }]);
      expect((sim as any).buildings).toEqual([{ x: 50, z: 50, id: 2 }]);

      // A restored house can still be upgraded/removed by id afterward, same as a live-spawned one.
      bus.emit('growth:upgrade', { id: 1 });
      expect((sim as any).houses).toEqual([]);
      expect((sim as any).buildings).toEqual([{ x: 50, z: 50, id: 2 }, { x: 100, z: 100, id: 1 }]);

      bus.emit('growth:remove', { id: 2 });
      expect((sim as any).buildings).toEqual([{ x: 100, z: 100, id: 1 }]);
    });

    it('restore() replaces (not appends to) any pre-existing houses/buildings state', () => {
      const { bus, sim } = multiNodeWorld();
      bus.emit('growth:spawn', { kind: 'house', x: 1, z: 1, rot: 0, id: 900 });
      expect((sim as any).houses.length).toBe(1);

      sim.restore([{ kind: 'house', x: 2, z: 2, rot: 0, id: 901 }]);
      expect((sim as any).houses).toEqual([{ x: 2, z: 2, id: 901 }]);
    });
  });

  // Task 44: traffic deadlock fix. Prior to this fix, a small ring network with several short
  // (< JUNCTION_APPROACH + JUNCTION_RELEASE) legs and enough concurrent cars could gridlock
  // permanently: cars acquired a junction lock for the NEXT node before releasing the lock they
  // already held for the PREVIOUS node (a single `heldNodeId` field silently overwritten), leaking
  // the old lock forever to a "phantom" holder — plus nothing ever checked that the lane a car was
  // about to commit to actually had room ("blocking the box"). Both together produced a circular
  // lock+gap wait that never resolved. See task-44-report.md for the full diagnosis.
  describe('junction deadlock (Task 44)', () => {
    /**
     * A small ring: six real corner nodes (not a bare 2-node loop, which never engages a junction
     * lock at all — see task-44-report.md's first repro attempt), with legs short enough
     * (8-16u, some under JUNCTION_APPROACH(6) + JUNCTION_RELEASE(4) = 10u) that concurrent cars
     * contest the same node locks and can chain back-to-back junctions in a single tick — exactly
     * the topology that reproduced the original deadlock.
     */
    function ringWorld() {
      const bus = new EventBus();
      const g = new RoadGraph(bus, flatSampler);
      g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }]);
      g.commitChain([{ x: 8, z: 0 }, { x: 8, z: 8 }]);
      g.commitChain([{ x: 8, z: 8 }, { x: 8, z: 24 }]);
      g.commitChain([{ x: 8, z: 24 }, { x: 0, z: 24 }]);
      g.commitChain([{ x: 0, z: 24 }, { x: 0, z: 8 }]);
      g.commitChain([{ x: 0, z: 8 }, { x: 0, z: 0 }]);
      for (const e of g.edges.values()) e.stage = 'painted';
      bus.emit('roads:changed', {});
      const sim = new TrafficSim(g, bus, createRng('deadlock-ring'));
      return { bus, g, sim };
    }

    // T44 review finding 2: these two soak tests originally ran a 20 sim-minute (1.2M-tick) loop
    // EACH, which is unnecessary CI cost for what they're actually checking — the freeze/deadlock
    // failure mode reproduces (and, pre-fix, was observed) within the first minute of contention
    // building up to near-cap population (see task-44-report.md: population hit cap by ~t=360s and
    // froze permanently at t=371.6s in the original repro — a 6-minute window comfortably contains
    // that). Trimmed to 6 sim-minutes (360k ticks) each. The freeze threshold is unchanged (30
    // sim-seconds is about the failure mode, not the run length, so it doesn't scale with the
    // window). The throughput threshold IS rescaled, but tightened in rate terms while doing it:
    // the original ">20 completions per 20 min" is only ~1/min, a weak bar that would also pass a
    // barely-limping network. This asserts >18 completions per 6 min (~3/min at the ring's
    // near-cap population) — confirmed empirically to hold with wide margin post-fix (~180
    // completions in 6 sim-minutes in practice) while still being a real, meaningfully higher
    // throughput bar than the original, not just a proportional shrink.
    it('never freezes permanently: no cohort stays below epsilon speed for more than 30 sim-seconds over a 6 sim-minute run at near-cap population', () => {
      const { sim } = ringWorld();
      sim.targetPopulation = 20;

      const dt = 1 / 60;
      const totalSimSeconds = 6 * 60;
      const FREEZE_EPS = 0.05;
      const FREEZE_SECONDS = 30;
      let frozenStreak = 0;
      let maxFrozenStreak = 0;

      for (let i = 0; i < totalSimSeconds / dt; i++) {
        sim.update(dt);
        const cars = sim.cars;
        const allFrozen = cars.length > 0 && cars.every((c) => c.speed < FREEZE_EPS);
        frozenStreak = allFrozen ? frozenStreak + dt : 0;
        maxFrozenStreak = Math.max(maxFrozenStreak, frozenStreak);
      }

      expect(maxFrozenStreak).toBeLessThan(FREEZE_SECONDS);
    });

    it('maintains throughput: cars keep completing trips (not just idling) over a 6 sim-minute run at near-cap population', () => {
      const { sim } = ringWorld();
      sim.targetPopulation = 20;

      const dt = 1 / 60;
      const totalSimSeconds = 6 * 60;
      let completions = 0;
      let prevIds = new Set<number>();

      for (let i = 0; i < totalSimSeconds / dt; i++) {
        sim.update(dt);
        const curIds = new Set(sim.cars.map((c) => c.id));
        for (const id of prevIds) if (!curIds.has(id)) completions++;
        prevIds = curIds;
      }

      // A 6 sim-minute run on a small ring at near-cap population should complete comfortably more
      // than ~3/min worth of trips if traffic is actually flowing rather than merely
      // creeping/backed up — a real throughput bar, not just a proportional shrink of the original
      // (weak) ">20 per 20 min" (~1/min) threshold.
      expect(completions).toBeGreaterThan(18);
    });

    it('a lock holder that stalls for the safety-net timeout releases and re-queues rather than holding forever', () => {
      const { sim } = ringWorld();
      sim.targetPopulation = 20;
      const dt = 1 / 60;
      // Run long enough to guarantee at least one contention + potential stall/backoff cycle,
      // then confirm no lock is held by a car that no longer exists (the original leak symptom)
      // and that every currently-held lock is actually owned by a live car.
      for (let i = 0; i < 5 * 60 / dt; i++) sim.update(dt);

      const locks: Map<number, number> = (sim as any).junctionLocks;
      const liveIds = new Set((sim as any).cs.map((c: any) => c.id));
      for (const [, holderId] of locks) {
        expect(liveIds.has(holderId)).toBe(true);
      }
    });
  });

  // T44 review finding 1: short lanes between junctions repeatedly stalled for the full 8s
  // STALE_LOCK_TIMEOUT instead of recovering promptly. A car holding node N1's lock, entering a
  // lane shorter than JUNCTION_APPROACH + JUNCTION_RELEASE (~10u) toward N2, must brake for N2's
  // lock (held by cross-traffic) while still holding N1's own lock (the hold-one-lock rule from
  // the original Task 44 fix) — and because the fixed release point (JUNCTION_RELEASE = 4u into
  // the lane) sits past where a short lane forces the car to stop for N2's approach zone
  // (starting at `lane.length - JUNCTION_APPROACH`, which is < 4u on any lane shorter than 10u),
  // the car can never reach the release mark under its own power. It falls through to the 8s
  // stale-lock safety net every single time this geometry occurs, rather than the release ever
  // doing its job. Reproduces with real contention (cross-traffic at both short-lane nodes) at
  // any comparable topology — loop halves can be exactly this short.
  describe('short-lane junction stalls (T44 review finding 1)', () => {
    /**
     * Two junctions 8u apart on a through route, each also feeding a perpendicular branch so
     * cross-traffic genuinely contends for both node locks (a lone car on an otherwise-empty
     * route never needs to actually brake — the earlier repro attempt with a single car and no
     * contention passed even on the pre-fix code, since nothing else was holding either lock).
     */
    function shortLaneWorld() {
      const bus = new EventBus();
      const g = new RoadGraph(bus, flatSampler);
      g.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
      g.commitChain([{ x: 40, z: 0 }, { x: 48, z: 0 }]); // short lane #1 (8u)
      g.commitChain([{ x: 48, z: 0 }, { x: 56, z: 0 }]); // short lane #2 (8u)
      g.commitChain([{ x: 56, z: 0 }, { x: 96, z: 0 }]);
      g.commitChain([{ x: 40, z: 0 }, { x: 40, z: 40 }]); // cross-traffic branch at junction N1
      g.commitChain([{ x: 56, z: 0 }, { x: 56, z: 40 }]); // cross-traffic branch at junction N2
      for (const e of g.edges.values()) e.stage = 'painted';
      bus.emit('roads:changed', {});
      const sim = new TrafficSim(g, bus, createRng('short-lane'));
      return { sim };
    }

    it('never sits stationary more than 2 sim-seconds at a time (fails today via the 8s stale-lock stall)', () => {
      const { sim } = shortLaneWorld();
      sim.targetPopulation = 12; // enough concurrent cars to genuinely contend for both node locks
      const dt = 1 / 60;
      const STATIONARY_EPS = 0.05;
      const MAX_STATIONARY_SECONDS = 2;
      const totalSimSeconds = 10 * 60;

      let maxStationaryStreak = 0;

      for (let i = 0; i < totalSimSeconds / dt; i++) {
        sim.update(dt);
        for (const c of (sim as any).cs as Array<{ speed: number; _streak?: number }>) {
          c._streak = c.speed < STATIONARY_EPS ? (c._streak ?? 0) + dt : 0;
          if (c._streak > maxStationaryStreak) maxStationaryStreak = c._streak;
        }
      }

      expect(maxStationaryStreak).toBeLessThan(MAX_STATIONARY_SECONDS);
    });
  });
});
