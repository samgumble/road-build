import { describe, it, expect } from 'vitest';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { GrowthSim } from '../src/sim/growth/growth';
import { BuildQueue } from '../src/sim/construction/queue';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';

function freshWorld(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  const queue = new BuildQueue(graph, hf, bus);
  return { bus, hf, graph, growth, queue };
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
  it('returns null when an edge has an invalid stage or malformed ctrl', () => {
    const base = {
      version: 1,
      seed: 'x',
      timeOfDay: 0,
      growth: { dev: [], spawned: [] },
    };
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'bogus' }] })),
    ).toBeNull();
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: [{ x: 0 }], stage: 'graded' }] })),
    ).toBeNull();
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: 'not-an-array', stage: 'graded' }] })),
    ).toBeNull();
  });
  it('returns null for non-finite timeOfDay or ctrl coordinates', () => {
    const base = {
      version: 1,
      seed: 'x',
      growth: { dev: [], spawned: [] },
    };
    // 1e400 overflows to Infinity once JSON.parse evaluates it as a number literal — this is how
    // a hand-edited/corrupted save file could smuggle a non-finite value through JSON, since
    // JSON.stringify on an in-memory NaN/Infinity would instead just emit `null`.
    expect(
      deserialize(JSON.stringify({ ...base, timeOfDay: 0.5, edges: [] }).replace('0.5', '1e400')),
    ).toBeNull();
    expect(
      deserialize(
        JSON.stringify({ ...base, timeOfDay: 0, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'graded' }] }).replace(
          '"x":0',
          '"x":1e400',
        ),
      ),
    ).toBeNull();
    expect(
      deserialize(
        JSON.stringify({ ...base, timeOfDay: 0, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'graded' }] }).replace(
          '"z":0}',
          '"z":1e400}',
        ),
      ),
    ).toBeNull();
  });
  it('resumes construction of mid-stage edges after restore', () => {
    const w = freshWorld('resume-test');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (w.hf.isLand(x, z) && w.hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
    const [id] = w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
    w.graph.edges.get(id)!.stage = 'gravel'; // simulate autosave mid-build
    const json = serialize({ seed: 'resume-test', timeOfDay: 0.5, graph: w.graph, growth: w.growth });
    const w2 = freshWorld('resume-test');
    restoreWorld(deserialize(json)!, w2);
    const [rid] = [...w2.graph.edges.keys()];
    for (let i = 0; i < 60 * 120; i++) w2.queue.update(1 / 60);
    expect(w2.graph.edges.get(rid)!.stage).toBe('painted');
  });
});
