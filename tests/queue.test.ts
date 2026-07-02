import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import type { Stage } from '../src/core/types';

function setup() {
  const bus = new EventBus();
  const hf = new Heightfield('q-test', bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  // find land chain
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
  const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
  return { bus, hf, graph, queue, edgeId };
}

const run = (queue: BuildQueue, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) queue.update(1 / 60);
};

describe('BuildQueue', () => {
  it('advances an edge through all stages in order', () => {
    const { bus, queue, edgeId, graph } = setup();
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => { if (e.edgeId === edgeId) stages.push(e.stage); });
    run(queue, 120);
    expect(stages).toEqual(['graded', 'gravel', 'paved', 'painted']);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    expect(queue.busy).toBe(false);
  });
  it('grading deforms terrain toward the road profile', () => {
    const { queue, hf, graph, edgeId } = setup();
    const mid = graph.edges.get(edgeId)!.samples[Math.floor(graph.edges.get(edgeId)!.samples.length / 2)];
    run(queue, 120);
    expect(Math.abs(hf.heightAt(mid.x, mid.z) - mid.y)).toBeLessThan(1.0);
  });
  it('demolish reverses stages and removes the edge', () => {
    const { bus, queue, graph, edgeId } = setup();
    run(queue, 120); // fully built
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => stages.push(e.stage));
    queue.enqueueDemolish(edgeId);
    run(queue, 120);
    expect(stages[stages.length - 1]).toBe('removed');
    expect(graph.edges.has(edgeId)).toBe(false);
  });
});
