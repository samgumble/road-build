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
});
