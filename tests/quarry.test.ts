import { describe, it, expect } from 'vitest';
import { placeQuarry, QuarrySim } from '../src/sim/quarry';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';

function buildGraph(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  return { bus, hf, graph };
}

/** Finds a straight land-only edge anchor, mirroring the pattern used across the existing test
 * suite (wilderness.test.ts, save.test.ts) for a deterministic, reliably-land road. */
function findAnchor(hf: Heightfield, length: number): { x: number; z: number } {
  for (let x = -160; x <= 160; x += 8) {
    for (let z = -160; z <= 160; z += 8) {
      if (hf.isLand(x, z) && hf.isLand(x + length, z)) return { x, z };
    }
  }
  throw new Error('no land anchor found');
}

describe('placeQuarry', () => {
  it('is deterministic: same seed + same first edge samples produce the same site (double-run)', () => {
    const { hf, graph } = buildGraph('quarry-det');
    const anchor = findAnchor(hf, 64);
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const samples = graph.edges.get(edgeId)!.samples;

    const a = placeQuarry(hf, samples, 'quarry-seed-1');
    const b = placeQuarry(hf, samples, 'quarry-seed-1');
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it('different seeds can produce different sites', () => {
    const { hf, graph } = buildGraph('quarry-diff');
    const anchor = findAnchor(hf, 64);
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const samples = graph.edges.get(edgeId)!.samples;

    const a = placeQuarry(hf, samples, 'seed-alpha');
    const b = placeQuarry(hf, samples, 'seed-beta');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Not a strict guarantee for every possible seed pair, but true across many real seeds since
    // the candidate order is fully reshuffled by the seed.
    expect(a).not.toEqual(b);
  });

  it('the chosen site is on land with slope <= 0.25 and >= 40u from every first-edge sample', () => {
    const { hf, graph } = buildGraph('quarry-qualify');
    const anchor = findAnchor(hf, 64);
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const samples = graph.edges.get(edgeId)!.samples;

    const site = placeQuarry(hf, samples, 'quarry-qualify-seed');
    expect(site).not.toBeNull();
    expect(hf.isLand(site!.x, site!.z)).toBe(true);
    expect(hf.slopeAt(site!.x, site!.z)).toBeLessThanOrEqual(0.25);

    let minDist = Infinity;
    for (const s of samples) {
      const d = Math.hypot(s.x - site!.x, s.z - site!.z);
      if (d < minDist) minDist = d;
    }
    expect(minDist).toBeGreaterThanOrEqual(40 - 1e-6);
  });

  it('returns a valid rotation in [0, 2*PI)', () => {
    const { hf, graph } = buildGraph('quarry-rot');
    const anchor = findAnchor(hf, 64);
    const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const samples = graph.edges.get(edgeId)!.samples;
    const site = placeQuarry(hf, samples, 'quarry-rot-seed');
    expect(site).not.toBeNull();
    expect(site!.rot).toBeGreaterThanOrEqual(0);
    expect(site!.rot).toBeLessThan(Math.PI * 2);
  });
});

describe('QuarrySim', () => {
  it('places the quarry on the first road commit and emits quarry:placed', () => {
    const { bus, hf, graph } = buildGraph('quarry-sim-first');
    const sim = new QuarrySim(hf, graph, bus, 'quarry-sim-seed');

    let placedEvent: { x: number; z: number; rot: number } | null = null;
    bus.on('quarry:placed', (e) => { placedEvent = e; });

    expect(sim.placement).toBeNull();

    const anchor = findAnchor(hf, 64);
    graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);

    expect(sim.placement).not.toBeNull();
    expect(placedEvent).not.toBeNull();
    expect(placedEvent).toEqual(sim.placement);
  });

  it('never re-places or re-emits on subsequent road commits', () => {
    const { bus, hf, graph } = buildGraph('quarry-sim-once');
    const sim = new QuarrySim(hf, graph, bus, 'quarry-sim-once-seed');

    const anchor = findAnchor(hf, 64);
    graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    const firstPlacement = sim.placement;
    expect(firstPlacement).not.toBeNull();

    let placedCount = 0;
    bus.on('quarry:placed', () => { placedCount++; });

    const anchor2 = findAnchor(hf, 32);
    // Make sure this second anchor doesn't collide with the first chain's nodes.
    graph.commitChain([{ x: anchor2.x + 200, z: anchor2.z + 200 }, { x: anchor2.x + 232, z: anchor2.z + 200 }]);

    expect(placedCount).toBe(0);
    expect(sim.placement).toEqual(firstPlacement);
  });

  it('is deterministic across two independent sims given the same seed + build sequence', () => {
    const w1 = buildGraph('quarry-sim-det');
    const sim1 = new QuarrySim(w1.hf, w1.graph, w1.bus, 'quarry-sim-det-seed');
    const anchor1 = findAnchor(w1.hf, 64);
    w1.graph.commitChain([anchor1, { x: anchor1.x + 64, z: anchor1.z }]);

    const w2 = buildGraph('quarry-sim-det');
    const sim2 = new QuarrySim(w2.hf, w2.graph, w2.bus, 'quarry-sim-det-seed');
    const anchor2 = findAnchor(w2.hf, 64);
    w2.graph.commitChain([anchor2, { x: anchor2.x + 64, z: anchor2.z }]);

    expect(sim1.placement).toEqual(sim2.placement);
  });

  it('restore() seeds a placement without emitting quarry:placed and disarms auto-placement', () => {
    const { bus, hf, graph } = buildGraph('quarry-restore');
    const sim = new QuarrySim(hf, graph, bus, 'quarry-restore-seed');

    let placedCount = 0;
    bus.on('quarry:placed', () => { placedCount++; });

    sim.restore({ x: 10, z: 20, rot: 1.23 });
    expect(sim.placement).toEqual({ x: 10, z: 20, rot: 1.23 });
    expect(placedCount).toBe(0);

    const anchor = findAnchor(hf, 64);
    graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    expect(placedCount).toBe(0);
    expect(sim.placement).toEqual({ x: 10, z: 20, rot: 1.23 });
  });
});
