import { describe, it, expect } from 'vitest';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { GrowthSim } from '../src/sim/growth/growth';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';

function freshWorld(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  return { bus, hf, graph, growth };
}

describe('save/load', () => {
  it('round-trips edges, stages, and timeOfDay', () => {
    const w = freshWorld('save-test');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (w.hf.isLand(x, z) && w.hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
    const [id] = w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
    w.graph.edges.get(id)!.stage = 'painted';
    const json = serialize({ seed: 'save-test', timeOfDay: 0.7, graph: w.graph, growth: w.growth });
    const save = deserialize(json)!;
    expect(save.version).toBe(1);
    const w2 = freshWorld('save-test');
    restoreWorld(save, w2);
    expect(w2.graph.edges.size).toBe(1);
    expect([...w2.graph.edges.values()][0].stage).toBe('painted');
    expect(save.timeOfDay).toBeCloseTo(0.7);
  });
  it('returns null for garbage or wrong version', () => {
    expect(deserialize('not json')).toBeNull();
    expect(deserialize(JSON.stringify({ version: 99 }))).toBeNull();
  });
});
