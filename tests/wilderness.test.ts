import { describe, it, expect } from 'vitest';
import { generateWilderness } from '../src/sim/growth/wilderness';
import { WildernessSim } from '../src/sim/growth/wilderness';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import { ROAD_WIDTH, ROAD_ENGINEERED_HALF_WIDTH } from '../src/core/constants';

describe('generateWilderness', () => {
  it('is deterministic: same seed twice produces deep-equal results', () => {
    const hf = new Heightfield('wild-det');
    const a = generateWilderness(hf, 'wild-det-seed');
    const b = generateWilderness(hf, 'wild-det-seed');
    expect(a).toEqual(b);
  });

  it('different seeds produce different forests', () => {
    const hf = new Heightfield('wild-diff');
    const a = generateWilderness(hf, 'seed-one');
    const b = generateWilderness(hf, 'seed-two');
    expect(a).not.toEqual(b);
  });

  it('produces a density in the expected range (several hundred sites for this island size)', () => {
    const hf = new Heightfield('wild-density');
    const sites = generateWilderness(hf, 'wild-density-seed');
    // Sanity range rather than an exact count — approximate Poisson via grid-stride + rejection.
    expect(sites.length).toBeGreaterThan(100);
    expect(sites.length).toBeLessThan(2000);
  });

  it('every site sits on land with slope <= 0.5', () => {
    const hf = new Heightfield('wild-land');
    const sites = generateWilderness(hf, 'wild-land-seed');
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) {
      expect(hf.isLand(s.x, s.z)).toBe(true);
      expect(hf.slopeAt(s.x, s.z)).toBeLessThanOrEqual(0.5);
    }
  });

  it('every site has 1-3 trees', () => {
    const hf = new Heightfield('wild-count');
    const sites = generateWilderness(hf, 'wild-count-seed');
    for (const s of sites) {
      expect(s.count).toBeGreaterThanOrEqual(1);
      expect(s.count).toBeLessThanOrEqual(3);
    }
  });

  it('sites are spaced at least ~10u apart from each other', () => {
    const hf = new Heightfield('wild-spacing');
    const sites = generateWilderness(hf, 'wild-spacing-seed');
    // Grid-hash accelerated check: verify against a plain O(n^2) scan on a sample to keep the
    // test fast-ish while still being a real assertion (full O(n^2) over several hundred sites is
    // still cheap enough to run directly).
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
        expect(d).toBeGreaterThanOrEqual(10 - 1e-6);
      }
    }
  });
});

function stubSampler(hf: Heightfield) {
  return makeSampler(hf);
}

function buildGraph(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, stubSampler(hf));
  return { bus, hf, graph };
}

describe('WildernessSim clearing', () => {
  it('clears wilderness trees from the full shoulder and ditch footprint', () => {
    const { bus, hf, graph } = buildGraph('wild-ditch-clear');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge = graph.edges.get(edgeId)!;
    const sample = edge.samples[Math.floor(edge.samples.length / 2)];
    const oldCorridorEdge = ROAD_WIDTH / 2 + 2;
    const trees = [
      { x: sample.x, z: sample.z + oldCorridorEdge + 0.35, rot: 0, count: 1 },
      { x: sample.x, z: sample.z + ROAD_ENGINEERED_HALF_WIDTH + 2, rot: 0, count: 1 },
    ];
    const sim = new WildernessSim(trees, bus, graph);

    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    expect(sim.active).toEqual([trees[1]]);
  });

  it('clears exactly the trees within the road corridor when an edge reaches graded', () => {
    const { bus, hf, graph } = buildGraph('wild-clear');

    // Build a road so we know exactly where the corridor is.
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge = graph.edges.get(edgeId)!;

    // Hand-craft trees: some inside the corridor (within ROAD_WIDTH/2 + 2 of a sample), some
    // clearly outside. The road runs along x (anchor -> anchor + 64u, same z), so an "outside"
    // tree must be offset in z (perpendicular to the road), not x (which would still land further
    // down the same corridor).
    const corridorHalf = ROAD_WIDTH / 2 + 2;
    const sample = edge.samples[Math.floor(edge.samples.length / 2)];
    const trees = [
      { x: sample.x, z: sample.z, rot: 0, count: 1 }, // dead center — inside
      { x: sample.x, z: sample.z + corridorHalf - 0.5, rot: 0, count: 2 }, // just inside
      { x: sample.x, z: sample.z + corridorHalf + 20, rot: 0, count: 1 }, // well outside (perpendicular)
      { x: anchor.x - 100, z: anchor.z - 100, rot: 0, count: 3 }, // far outside
    ];

    const sim = new WildernessSim(trees, bus, graph);
    expect(sim.active.length).toBe(4);

    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    expect(sim.active.length).toBe(2);
    expect(sim.active.some((t) => t.z === trees[2].z)).toBe(true);
    expect(sim.active.some((t) => t.x === trees[3].x)).toBe(true);
  });

  it('does not clear trees near a bridge sample', () => {
    const bus = new EventBus();
    const hf = new Heightfield('wild-bridge', bus);
    const bridgeSampler = (ctrl: { x: number; z: number }[]) => {
      const base = makeSampler(hf)(ctrl);
      return base.map((s) => ({ ...s, bridge: true }));
    };
    const graph = new RoadGraph(bus, bridgeSampler);
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge = graph.edges.get(edgeId)!;
    const sample = edge.samples[Math.floor(edge.samples.length / 2)];
    const trees = [{ x: sample.x, z: sample.z, rot: 0, count: 1 }];
    const sim = new WildernessSim(trees, bus, graph);

    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    // All samples are bridge samples, so nothing should clear.
    expect(sim.active.length).toBe(1);
  });

  it('emits wilderness:cleared with the indices removed', () => {
    const { bus, hf, graph } = buildGraph('wild-clear-event');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge = graph.edges.get(edgeId)!;
    const sample = edge.samples[Math.floor(edge.samples.length / 2)];
    const trees = [
      { x: sample.x, z: sample.z, rot: 0, count: 1 },
      { x: anchor.x - 100, z: anchor.z - 100, rot: 0, count: 1 },
    ];
    new WildernessSim(trees, bus, graph);

    let clearedIndices: number[] | null = null;
    bus.on('wilderness:cleared', (e) => { clearedIndices = e.indices; });

    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    expect(clearedIndices).toEqual([0]);
  });

  it('restore re-clears the same corridor deterministically (serialize/restore world -> same cleared set)', () => {
    const { bus, hf, graph } = buildGraph('wild-restore');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge = graph.edges.get(edgeId)!;
    const sample = edge.samples[Math.floor(edge.samples.length / 2)];
    const trees = [
      { x: sample.x, z: sample.z, rot: 0, count: 1 },
      { x: anchor.x - 100, z: anchor.z - 100, rot: 0, count: 1 },
    ];
    const sim1 = new WildernessSim(trees, bus, graph);
    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
    expect(sim1.active.length).toBe(1);

    // Simulate a fresh world "restored" from a graph whose edge is already at 'graded' (as
    // restoreWorld does: commitChain then force stage + re-emit construction:stage).
    const bus2 = new EventBus();
    const hf2 = new Heightfield('wild-restore', bus2);
    const graph2 = new RoadGraph(bus2, makeSampler(hf2));
    const [edgeId2] = graph2.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const edge2 = graph2.edges.get(edgeId2)!;
    const sim2 = new WildernessSim(trees, bus2, graph2);
    edge2.stage = 'graded';
    bus2.emit('construction:stage', { edgeId: edgeId2, stage: 'graded', crew: -1 });

    expect(sim2.active.length).toBe(sim1.active.length);
    expect(sim2.active).toEqual(sim1.active);
  });

  it('restore at a stage past graded (e.g. gravel/painted, as a real save.ts restore replays) still re-clears the corridor', () => {
    // Regression: save.ts's restoreWorld force-sets edge.stage directly to whatever stage was
    // saved (which may be well past 'graded' — e.g. 'gravel', 'paved', 'painted') and re-emits
    // construction:stage with THAT stage, not a literal 'graded' event. A sim that only matched
    // `stage === 'graded'` exactly would silently fail to re-clear on a road saved past grading.
    for (const restoredStage of ['gravel', 'paved', 'painted'] as const) {
      const bus = new EventBus();
      const hf = new Heightfield('wild-restore-late', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      let anchor = { x: 0, z: 0 };
      outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
        if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
      const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      const edge = graph.edges.get(edgeId)!;
      const sample = edge.samples[Math.floor(edge.samples.length / 2)];
      const trees = [
        { x: sample.x, z: sample.z, rot: 0, count: 1 }, // inside corridor
        { x: anchor.x - 100, z: anchor.z - 100, rot: 0, count: 1 }, // far outside
      ];
      const sim = new WildernessSim(trees, bus, graph);
      expect(sim.active.length).toBe(2);

      // Mirror restoreWorld: force the stage directly, then emit construction:stage with that
      // (possibly-past-graded) stage — never a literal 'graded' event for this edge.
      edge.stage = restoredStage;
      bus.emit('construction:stage', { edgeId, stage: restoredStage, crew: -1 });

      expect(sim.active.length).toBe(1);
      expect(sim.active[0].x).toBe(trees[1].x);
    }
  });
});
