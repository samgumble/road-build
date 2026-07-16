import type { Stage } from '../../core/types';
import type { RoadEdge, RoadGraph } from './graph';

export type ConnectionKind = 'end' | 'seam' | 'junction';

export interface JunctionArm {
  edgeId: number;
  heading: number;
  stage: Stage;
}

export interface JunctionApproach extends JunctionArm {
  stopX: number;
  stopZ: number;
  stopHeading: number;
}

export interface JunctionPlan {
  nodeId: number;
  x: number;
  z: number;
  kind: ConnectionKind;
  arms: JunctionApproach[];
  topologySignature: string;
  surfaceSignature: string;
  majorEdgeIds: number[];
  stoppedEdgeIds: number[];
  signalGroups: number[][];
}

interface ArmPair {
  first: JunctionApproach;
  second: JunctionApproach;
  error: number;
  lowerEdgeId: number;
  higherEdgeId: number;
}

const CLEAR_PAIR_ERROR = 15 * Math.PI / 180;
const CLEAR_PAIR_GAP = 15 * Math.PI / 180;
const SIGNAL_PAIR_ERROR = 20 * Math.PI / 180;

function oppositeError(a: number, b: number): number {
  const delta = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  return Math.abs(Math.PI - delta);
}

function pairCandidates(arms: JunctionApproach[]): ArmPair[] {
  const pairs: ArmPair[] = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const first = arms[i];
      const second = arms[j];
      pairs.push({
        first,
        second,
        error: oppositeError(first.heading, second.heading),
        lowerEdgeId: Math.min(first.edgeId, second.edgeId),
        higherEdgeId: Math.max(first.edgeId, second.edgeId),
      });
    }
  }
  return pairs.sort((a, b) => a.error - b.error
    || a.lowerEdgeId - b.lowerEdgeId
    || a.higherEdgeId - b.higherEdgeId);
}

function groupOppositeApproaches(arms: JunctionApproach[]): number[][] {
  const used = new Set<number>();
  const groups: number[][] = [];
  for (const pair of pairCandidates(arms)) {
    if (pair.error > SIGNAL_PAIR_ERROR) break;
    if (used.has(pair.first.edgeId) || used.has(pair.second.edgeId)) continue;
    used.add(pair.first.edgeId);
    used.add(pair.second.edgeId);
    groups.push([pair.lowerEdgeId, pair.higherEdgeId]);
  }
  for (const arm of arms) {
    if (!used.has(arm.edgeId)) groups.push([arm.edgeId]);
  }
  return groups.sort((a, b) => a[0] - b[0]);
}

function classifyApproaches(arms: JunctionApproach[], kind: ConnectionKind): {
  majorEdgeIds: number[];
  stoppedEdgeIds: number[];
  signalGroups: number[][];
} {
  if (kind !== 'junction') {
    return { majorEdgeIds: [], stoppedEdgeIds: [], signalGroups: [] };
  }

  const pairs = pairCandidates(arms);
  const best = pairs[0];
  const second = pairs[1];
  const hasClearPair = best !== undefined
    && best.error <= CLEAR_PAIR_ERROR
    && (second === undefined || second.error - best.error >= CLEAR_PAIR_GAP);

  if (hasClearPair) {
    const majorEdgeIds = [best.lowerEdgeId, best.higherEdgeId];
    const minorArms = arms.filter((arm) => !majorEdgeIds.includes(arm.edgeId));
    const stoppedEdgeIds = minorArms.map((arm) => arm.edgeId).sort((a, b) => a - b);
    return {
      majorEdgeIds,
      stoppedEdgeIds,
      signalGroups: [majorEdgeIds, ...groupOppositeApproaches(minorArms)],
    };
  }

  return {
    majorEdgeIds: [],
    stoppedEdgeIds: arms.map((arm) => arm.edgeId).sort((a, b) => a - b),
    signalGroups: groupOppositeApproaches(arms),
  };
}

function armFor(edge: RoadEdge, nodeId: number): JunctionArm | null {
  if (edge.samples.length < 2) return null;
  const atA = edge.a === nodeId;
  if (!atA && edge.b !== nodeId) return null;
  const origin = atA ? edge.samples[0] : edge.samples[edge.samples.length - 1];
  const next = atA ? edge.samples[1] : edge.samples[edge.samples.length - 2];
  return {
    edgeId: edge.id,
    heading: Math.atan2(next.z - origin.z, next.x - origin.x),
    stage: edge.stage,
  };
}

export function planJunction(graph: RoadGraph, nodeId: number): JunctionPlan | null {
  const node = graph.nodes.get(nodeId);
  if (!node) return null;

  const arms = graph.edgesAtNode(nodeId)
    .map((id) => armFor(graph.edges.get(id)!, nodeId))
    .filter((arm): arm is JunctionArm => arm !== null)
    .sort((a, b) => a.edgeId - b.edgeId)
    .map((arm): JunctionApproach => ({
      ...arm,
      stopX: node.x + Math.cos(arm.heading) * 4.5,
      stopZ: node.z + Math.sin(arm.heading) * 4.5,
      stopHeading: arm.heading + Math.PI,
    }));
  const kind: ConnectionKind = arms.length <= 1
    ? 'end'
    : arms.length === 2
      ? 'seam'
      : 'junction';
  const topologySignature = `${kind}|${arms
    .map((arm) => `${arm.edgeId}:${arm.heading.toFixed(5)}`)
    .join('|')}`;
  const surfaceSignature = arms
    .map((arm) => `${arm.edgeId}:${arm.stage}`)
    .join('|');
  const policy = classifyApproaches(arms, kind);

  return {
    nodeId,
    x: node.x,
    z: node.z,
    kind,
    arms,
    topologySignature,
    surfaceSignature,
    ...policy,
  };
}
