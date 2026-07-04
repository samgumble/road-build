import { describe, it, expect } from 'vitest';
import { buildLaneGraph, findRoute } from '../src/sim/roads/lanes';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';

const flatSampler = (ctrl: P2[]): RoadSample[] => {
  // densify straight segments at 2u so offsets are smooth
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

function grid(): RoadGraph {
  const g = new RoadGraph(new EventBus(), flatSampler);
  g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
  g.commitChain([{ x: 64, z: 0 }, { x: 64, z: 64 }]);
  g.commitChain([{ x: 0, z: 0 }, { x: 0, z: 64 }, { x: 64, z: 64 }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  return g;
}

describe('lane graph', () => {
  it('creates two directed lanes per painted edge, offset to the right', () => {
    const g = new RoadGraph(new EventBus(), flatSampler);
    g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    for (const e of g.edges.values()) e.stage = 'painted';
    const lg = buildLaneGraph(g);
    expect(lg.lanes.size).toBe(2);
    const eastbound = [...lg.lanes.values()].find((l) => l.points[0].x < 32)!;
    expect(eastbound.points[1].z).toBeGreaterThan(0.5); // +x travel, right side is +z
  });
  it('ignores unpainted edges', () => {
    const g = new RoadGraph(new EventBus(), flatSampler);
    g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    expect(buildLaneGraph(g).lanes.size).toBe(0);
  });
  it('A* finds a route across the grid and prefers the short leg', () => {
    const g = grid();
    const lg = buildLaneGraph(g);
    const a = [...g.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
    const b = [...g.nodes.values()].find((n) => n.x === 64 && n.z === 64)!.id;
    const route = findRoute(lg, a, b)!;
    expect(route).not.toBeNull();
    expect(route[0].from).toBe(a);
    expect(route[route.length - 1].to).toBe(b);
    const total = route.reduce((s, l) => s + l.length, 0);
    expect(total).toBeLessThan(200); // took a 2-edge leg (~128u), not a silly loop
  });

  describe('closed loops (Task 41)', () => {
    function loopGraph(): RoadGraph {
      const g = new RoadGraph(new EventBus(), flatSampler);
      g.commitChain([
        { x: 0, z: 0 }, { x: 32, z: 0 }, { x: 32, z: 32 }, { x: 0, z: 32 }, { x: 0, z: 0 },
      ]);
      for (const e of g.edges.values()) e.stage = 'painted';
      return g;
    }

    it('builds 4 lanes (2 per half-loop edge) once both halves are painted', () => {
      const g = loopGraph();
      expect(g.edges.size).toBe(2);
      const lg = buildLaneGraph(g);
      expect(lg.lanes.size).toBe(4);
    });

    it('findRoute reaches the midpoint node going either direction around the loop', () => {
      const g = loopGraph();
      const lg = buildLaneGraph(g);
      const start = [...g.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
      const [e1, e2] = [...g.edges.values()];
      const midNode = e1.a === start ? e1.b : e1.a;
      // sanity: e2 also touches start and the same midpoint (it's the other half of the ring)
      expect([e2.a, e2.b]).toContain(start);
      expect([e2.a, e2.b]).toContain(midNode);

      const route = findRoute(lg, start, midNode);
      expect(route).not.toBeNull();
      expect(route!.length).toBeGreaterThan(0);
      expect(route![0].from).toBe(start);
      expect(route![route!.length - 1].to).toBe(midNode);

      // The route can only have taken ONE of the two edges (whichever the A* found shorter/first);
      // confirm a route also exists using the OTHER edge by excluding the one just used and
      // checking a route still reaches the midpoint via the remaining lanes (proves both halves
      // are independently traversable, i.e. you can go around the loop either way).
      const usedEdgeIds = new Set(route!.map((l) => l.edgeId));
      const otherEdge = [...g.edges.values()].find((e) => !usedEdgeIds.has(e.id))!;
      expect(otherEdge).toBeDefined();
      // the other edge's lanes exist and connect start<->midNode directly too
      const otherLanes = [...lg.lanes.values()].filter((l) => l.edgeId === otherEdge.id);
      expect(otherLanes.length).toBe(2);
      expect(otherLanes.some((l) => l.from === start && l.to === midNode)).toBe(true);
      expect(otherLanes.some((l) => l.from === midNode && l.to === start)).toBe(true);
    });
  });
});
