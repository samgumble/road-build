import { describe, it, expect } from 'vitest';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';

const stubSampler = (ctrl: P2[]): RoadSample[] =>
  ctrl.map((p) => ({ x: p.x, y: 1, z: p.z, bridge: false }));

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
});
