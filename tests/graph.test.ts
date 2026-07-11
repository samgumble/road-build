import { describe, it, expect } from 'vitest';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';

const stubSampler = (ctrl: P2[]): RoadSample[] =>
  ctrl.map((p) => ({ x: p.x, y: 1, z: p.z, bridge: false }));

const denseSampler = (ctrl: P2[]): RoadSample[] => {
  const out: RoadSample[] = [];
  for (let leg = 0; leg < ctrl.length - 1; leg++) {
    const a = ctrl[leg], b = ctrl[leg + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let i = 0; i < steps; i++) {
      const u = i / steps;
      out.push({ x: a.x + (b.x - a.x) * u, y: 1, z: a.z + (b.z - a.z) * u, bridge: false });
    }
  }
  const last = ctrl[ctrl.length - 1];
  out.push({ x: last.x, y: 1, z: last.z, bridge: false });
  return out;
};

const mk = () => new RoadGraph(new EventBus(), stubSampler);

describe('RoadGraph', () => {
  it('snaps to the SNAP grid', () => {
    expect(RoadGraph.snap(11, -3)).toEqual({ x: 8, z: 0 });
  });
  it('commits a simple chain as one edge with end nodes', () => {
    const g = mk();
    const ids = g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }]);
    expect(ids).toHaveLength(1);
    expect(g.nodes.size).toBe(2);
    expect(g.edges.get(ids[0])!.stage).toBe('surveyed');
    expect(g.edges.get(ids[0])!.ctrl).toHaveLength(3);
  });
  it('splits a new chain at an existing node (T junction)', () => {
    const g = mk();
    g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    const ids = g.commitChain([{ x: 16, z: 0 }, { x: 16, z: 16 }]);
    expect(ids).toHaveLength(1);
    expect(g.nodes.size).toBe(3);
  });
  it('splits an existing edge when a chain touches its interior control point', () => {
    const g = mk();
    const [first] = g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }]);
    g.commitChain([{ x: 8, z: 0 }, { x: 8, z: 16 }]);
    expect(g.edges.has(first)).toBe(false);     // original replaced
    expect(g.edges.size).toBe(3);               // two halves + the new road
    expect(g.nodes.size).toBe(4);
  });
  it('does not create a duplicate parallel edge when a chain retraces an existing edge between two interior points', () => {
    const g = mk();
    g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }, { x: 24, z: 0 }, { x: 32, z: 0 }]);
    g.commitChain([{ x: 8, z: 16 }, { x: 8, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 16 }]);
    // original split into 3 at the two cut points, plus the two new stubs = 5 edges
    expect(g.edges.size).toBe(5);
    // no two edges share the same unordered node pair
    const pairs = [...g.edges.values()].map((e) => [e.a, e.b].sort().join('-'));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(g.nodes.size).toBe(6);
  });
  it('removeEdge prunes orphan nodes and emits events', () => {
    const bus = new EventBus();
    const g = new RoadGraph(bus, stubSampler);
    let removed = -1;
    bus.on('roads:edgeRemoved', (e) => (removed = e.edgeId));
    const [id] = g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    g.removeEdge(id);
    expect(removed).toBe(id);
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
  });

  describe('closed loops (Task 41)', () => {
    it('commits a closed chain (stroke returns to its start) as two half-loop edges sharing a midpoint node', () => {
      const g = mk();
      // A square loop back to the start: (0,0) -> (16,0) -> (16,16) -> (0,16) -> (0,0)
      const ids = g.commitChain([
        { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 }, { x: 0, z: 16 }, { x: 0, z: 0 },
      ]);
      expect(ids).toHaveLength(2);
      // start node + a new midpoint node = 2 nodes total (no separate "end" node — it's the start)
      expect(g.nodes.size).toBe(2);
      const [e1, e2] = ids.map((id) => g.edges.get(id)!);
      // the two halves share exactly the start node and the midpoint node between them
      const nodeIds = new Set([e1.a, e1.b, e2.a, e2.b]);
      expect(nodeIds.size).toBe(2);
      // both halves chain together: e1 ends where e2 starts (or vice versa), forming a ring
      expect([e1.b, e1.a].includes(e2.a) || [e1.b, e1.a].includes(e2.b)).toBe(true);
      // both born surveyed
      expect(e1.stage).toBe('surveyed');
      expect(e2.stage).toBe('surveyed');
      // both halves have interior control points (not degenerate 2-point stubs)
      expect(e1.ctrl.length).toBeGreaterThanOrEqual(3);
      expect(e2.ctrl.length).toBeGreaterThanOrEqual(3);
    });
    it('splits the loop at the control point nearest half the total arclength', () => {
      const g = mk();
      // Rectangle: perimeter legs of 8, 24, 8, 24 = total 64. Half = 32, reached exactly at the
      // third vertex (8 + 24 + 8 = 40 is past it; 8+24=32 lands exactly there).
      const ids = g.commitChain([
        { x: 0, z: 0 }, { x: 0, z: 8 }, { x: 24, z: 8 }, { x: 24, z: 0 }, { x: 0, z: 0 },
      ]);
      expect(ids).toHaveLength(2);
      const [e1, e2] = ids.map((id) => g.edges.get(id)!);
      // the midpoint node should sit at (24, 8) -- the vertex closest to half-arclength
      const midCandidate = [...g.nodes.values()].find((n) => n.x === 24 && n.z === 8);
      expect(midCandidate).toBeDefined();
      expect([e1.a, e1.b, e2.a, e2.b]).toContain(midCandidate!.id);
    });
    it('emits normal roads:changed / roads:edgeAdded events for both halves (no special-casing)', () => {
      const bus = new EventBus();
      const g = new RoadGraph(bus, stubSampler);
      const added: number[] = [];
      let changedCount = 0;
      bus.on('roads:edgeAdded', (e) => added.push(e.edgeId));
      bus.on('roads:changed', () => changedCount++);
      const ids = g.commitChain([
        { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 }, { x: 0, z: 16 }, { x: 0, z: 0 },
      ]);
      expect(ids).toHaveLength(2);
      expect(added.sort()).toEqual([...ids].sort());
      expect(changedCount).toBe(1);
    });
    it('skips a degenerate tiny closed loop (fewer than 3 distinct control points)', () => {
      const g = mk();
      // A "loop" that immediately doubles back: (0,0) -> (8,0) -> (0,0). Only 2 distinct points.
      const ids = g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 0, z: 0 }]);
      expect(ids).toHaveLength(0);
      expect(g.edges.size).toBe(0);
      expect(g.nodes.size).toBe(0);
    });
    it('skips a closed loop whose half-split would produce an interior-less (2-point) half', () => {
      const g = mk();
      // A minimal triangle-ish loop with exactly 3 distinct points before returning to start:
      // (0,0) -> (8,0) -> (8,8) -> (0,0). 4 ctrl points total (incl. closing point). Splitting at
      // the nearest-half-arclength vertex could land adjacent to the start, producing a 2-point
      // (interior-less) half. That whole loop should be treated as degenerate and skipped.
      const ids = g.commitChain([
        { x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 8 }, { x: 0, z: 0 },
      ]);
      // Either it finds a valid split (both halves >= 3 ctrl points) or it skips entirely --
      // but it must NEVER produce a 2-point half.
      for (const id of ids) {
        expect(g.edges.get(id)!.ctrl.length).toBeGreaterThanOrEqual(3);
      }
    });
    it('is deterministic: committing the same closed chain twice (fresh graphs) yields identical topology', () => {
      const loop = [
        { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 }, { x: 0, z: 16 }, { x: 0, z: 0 },
      ];
      const g1 = mk();
      const g2 = mk();
      const ids1 = g1.commitChain(loop);
      const ids2 = g2.commitChain(loop);
      expect(ids1.length).toBe(ids2.length);
      expect(g1.nodes.size).toBe(g2.nodes.size);
      const shape = (g: RoadGraph, ids: number[]) =>
        ids.map((id) => g.edges.get(id)!.ctrl.length).sort();
      expect(shape(g1, ids1)).toEqual(shape(g2, ids2));
    });
  });

  describe('magnetSnap', () => {
    it('returns an existing node exact position when within radius', () => {
      const g = mk();
      g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
      // node sits at (16, 0); a cursor a few units off should snap to it exactly,
      // not to the bare grid point nearest the cursor itself.
      expect(g.magnetSnap(18, 2, 6)).toEqual({ x: 16, z: 0 });
    });
    it('returns an edge interior control point when that is nearest', () => {
      const g = mk();
      g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }]);
      // (8,0) is an interior ctrl point (not a node) of the single edge; a cursor near it
      // should snap onto it.
      expect(g.magnetSnap(9, 1, 6)).toEqual({ x: 8, z: 0 });
    });
    it('connects to the rendered centerline of a long road with no interior control point', () => {
      const bus = new EventBus();
      const g = new RoadGraph(bus, denseSampler);
      const [original] = g.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);

      const snapped = g.magnetSnap(20, 5, 6);
      expect(snapped).toEqual({ x: 24, z: 0 }); // road centerline, not bare-grid fallback (24,8)
      const [branch] = g.commitChain([snapped, { x: 24, z: 24 }]);

      expect(g.edges.has(original)).toBe(false);
      expect(g.edges.size).toBe(3); // two cleaned halves + the connected branch
      const junction = [...g.nodes.values()].find((node) => node.x === 24 && node.z === 0)!;
      expect(junction).toBeDefined();
      expect(g.edgesAtNode(junction.id)).toHaveLength(3);
      expect(g.edges.has(branch)).toBe(true);
    });
    it('falls back to grid snap when nothing is within radius', () => {
      const g = mk();
      g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
      // far away from any existing node/ctrl point — should fall back to RoadGraph.snap.
      expect(g.magnetSnap(200, 200, 6)).toEqual(RoadGraph.snap(200, 200));
    });
  });
});
