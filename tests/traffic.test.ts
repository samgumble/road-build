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
});
