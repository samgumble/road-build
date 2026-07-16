import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { RoadGraph } from '../src/sim/roads/graph';
import { planJunction } from '../src/sim/roads/junctionPlan';

const plannerSampler = (ctrl: P2[]): RoadSample[] => ctrl.map((p) => ({
  x: p.x, y: 1, z: p.z, bridge: false,
}));

function makeGraph(): RoadGraph {
  return new RoadGraph(new EventBus(), plannerSampler);
}

function paint(graph: RoadGraph): void {
  for (const edge of graph.edges.values()) edge.stage = 'painted';
}

function paintedT() {
  const graph = makeGraph();
  const [west] = graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  const [east] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [north] = graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, west, east, north };
}

function paintedThreeArmY() {
  const graph = makeGraph();
  const edgeIds = [
    graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }])[0],
    graph.commitChain([{ x: 0, z: 0 }, { x: -8, z: 16 }])[0],
    graph.commitChain([{ x: 0, z: 0 }, { x: -8, z: -16 }])[0],
  ];
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, edgeIds };
}

function paintedCorner() {
  const graph = makeGraph();
  graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId };
}

function paintedClearFourArm() {
  const graph = makeGraph();
  const [west] = graph.commitChain([{ x: 0, z: 0 }, { x: -16, z: 0 }]);
  const [east] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [north] = graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  const [northEast] = graph.commitChain([{ x: 0, z: 0 }, { x: 12, z: 12 }]);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, west, east, north, northEast };
}

function paintedClearFiveArm() {
  const graph = makeGraph();
  const commitArm = (x: number, z: number): number => graph.commitChain([
    { x: 0, z: 0 }, { x, z },
  ])[0];
  const west = commitArm(-16, 0);
  const east = commitArm(16, 0);
  // These two approaches are 164.7 degrees apart: safely within the 20-degree
  // opposite tolerance without challenging the unique east/west through pair.
  const minorA = commitArm(8, 24);
  const minorB = commitArm(-16, -24);
  const minorC = commitArm(-16, 8);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, west, east, minorA, minorB, minorC };
}

describe('planJunction', () => {
  it('classifies tied road ends as an uncontrolled seam', () => {
    const graph = makeGraph();
    graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    graph.commitChain([{ x: 16, z: 0 }, { x: 24, z: 8 }]);
    const node = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
    const plan = planJunction(graph, node.id)!;
    expect(plan.kind).toBe('seam');
    expect(plan.arms).toHaveLength(2);
  });

  it('classifies loop split nodes as seams and T nodes as junctions', () => {
    const loop = makeGraph();
    loop.commitChain([
      { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 },
      { x: 0, z: 16 }, { x: 0, z: 0 },
    ]);
    for (const node of loop.nodes.values()) expect(planJunction(loop, node.id)!.kind).toBe('seam');

    const tee = makeGraph();
    // Keep the intended tie-in point in the control polyline so RoadGraph can split it into a
    // shared topology node; this sampler deliberately returns only the supplied controls.
    tee.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }, { x: 32, z: 0 }]);
    tee.commitChain([{ x: 16, z: 0 }, { x: 16, z: 24 }]);
    const node = [...tee.nodes.values()].find((n) => tee.edgesAtNode(n.id).length === 3)!;
    expect(planJunction(tee, node.id)!.kind).toBe('junction');
  });

  it('separates stable topology identity from stage-only surface state', () => {
    const graph = makeGraph();
    const [a] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    const [b] = graph.commitChain([{ x: 16, z: 0 }, { x: 24, z: 8 }]);
    const node = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
    const before = planJunction(graph, node.id)!;
    graph.edges.get(a)!.stage = 'painted';
    const after = planJunction(graph, node.id)!;
    expect(after.topologySignature).toBe(before.topologySignature);
    expect(after.surfaceSignature).not.toBe(before.surfaceSignature);
    expect(after.arms.map((arm) => arm.edgeId)).toEqual([a, b].sort((x, y) => x - y));
  });

  it('finds the through pair of a clear T and stops only the minor arm', () => {
    const { graph, nodeId, west, east, north } = paintedT();
    const plan = planJunction(graph, nodeId)!;
    expect(plan.majorEdgeIds).toEqual([west, east].sort((a, b) => a - b));
    expect(plan.stoppedEdgeIds).toEqual([north]);
    expect(plan.signalGroups).toEqual([
      [west, east].sort((a, b) => a - b),
      [north],
    ]);

    const minor = plan.arms.find((arm) => arm.edgeId === north)!;
    expect(minor.stopX).toBeCloseTo(0);
    expect(minor.stopZ).toBeCloseTo(4.5);
    expect(minor.stopHeading).toBeCloseTo(minor.heading + Math.PI);
  });

  it('uses all-way stop and deterministic groups for an ambiguous junction', () => {
    const { graph, nodeId, edgeIds } = paintedThreeArmY();
    const plan = planJunction(graph, nodeId)!;
    expect(plan.majorEdgeIds).toEqual([]);
    expect(plan.stoppedEdgeIds).toEqual([...edgeIds].sort((a, b) => a - b));
    expect(plan.signalGroups.flat().sort((a, b) => a - b)).toEqual([...edgeIds].sort((a, b) => a - b));
  });

  it('never assigns controls to a degree-two seam', () => {
    const { graph, nodeId } = paintedCorner();
    const plan = planJunction(graph, nodeId)!;
    expect(plan.stoppedEdgeIds).toEqual([]);
    expect(plan.signalGroups).toEqual([]);
  });

  it('keeps conflicting minor arms in separate phases at a clear degree-four junction', () => {
    const { graph, nodeId, west, east, north, northEast } = paintedClearFourArm();
    const plan = planJunction(graph, nodeId)!;
    expect(plan.majorEdgeIds).toEqual([west, east].sort((a, b) => a - b));
    expect(plan.stoppedEdgeIds).toEqual([north, northEast].sort((a, b) => a - b));
    expect(plan.signalGroups).toEqual([
      [west, east].sort((a, b) => a - b),
      [north],
      [northEast],
    ]);
  });

  it('pairs only near-opposite minor arms at a clear degree-five junction', () => {
    const { graph, nodeId, west, east, minorA, minorB, minorC } = paintedClearFiveArm();
    const plan = planJunction(graph, nodeId)!;
    expect(plan.majorEdgeIds).toEqual([west, east].sort((a, b) => a - b));
    expect(plan.stoppedEdgeIds).toEqual([minorA, minorB, minorC].sort((a, b) => a - b));
    expect(plan.signalGroups).toEqual([
      [west, east].sort((a, b) => a - b),
      [minorA, minorB].sort((a, b) => a - b),
      [minorC],
    ]);
  });
});
