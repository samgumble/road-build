import { describe, it, expect } from 'vitest';
import { GrowthSim } from '../src/sim/growth/growth';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';

function world() {
  const bus = new EventBus();
  const hf = new Heightfield('grow-test', bus);
  const g = new RoadGraph(bus, makeSampler(hf));
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
  g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  const sim = new GrowthSim(g, hf, bus, createRng('grow'));
  bus.emit('roads:changed', {});
  return { bus, sim };
}

describe('GrowthSim', () => {
  it('spawns trees first, then houses, near painted roads', () => {
    const { bus, sim } = world();
    const kinds: string[] = [];
    bus.on('growth:spawn', (e) => kinds.push(e.kind));
    for (let i = 0; i < 60 * 300; i++) sim.update(1 / 60); // 5 sim-minutes
    expect(kinds.filter((k) => k === 'tree').length).toBeGreaterThan(0);
    const firstTree = kinds.indexOf('tree'), firstHouse = kinds.indexOf('house');
    if (firstHouse !== -1) expect(firstTree).toBeLessThan(firstHouse);
    expect(sim.houseCount).toBe(kinds.filter((k) => k === 'house').length);
  });
  it('spawns nothing with no painted roads', () => {
    const bus = new EventBus();
    const hf = new Heightfield('grow-test-2', bus);
    const g = new RoadGraph(bus, makeSampler(hf));
    const sim = new GrowthSim(g, hf, bus, createRng('grow'));
    let n = 0;
    bus.on('growth:spawn', () => n++);
    for (let i = 0; i < 60 * 60; i++) sim.update(1 / 60);
    expect(n).toBe(0);
  });
});
