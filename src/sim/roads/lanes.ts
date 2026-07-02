import { LANE_OFFSET } from '../../core/constants';
import type { RoadSample, V3 } from '../../core/types';
import type { RoadGraph } from './graph';

export interface Lane {
  id: number;
  edgeId: number;
  from: number;
  to: number;
  points: V3[];
  /**
   * Length of the lane's offset path (`points`), NOT the edge centerline.
   * `length` and `points` are offset-path values and MUST be used together
   * for s-parameterization; do not mix with `edge.length`/`edge.samples`.
   */
  length: number;
  maxSpeed: number[];
}

export interface LaneGraph {
  lanes: Map<number, Lane>;
  outgoing: Map<number, number[]>;
  /** True node positions (not offset lane endpoints), keyed by node id. */
  nodePos: Map<number, { x: number; z: number }>;
}

/**
 * Compute the right-hand offset direction for a given travel direction.
 * For a normalized direction vector d in XZ plane, right = (-d.z, d.x)
 */
function getRightVector(dx: number, dz: number): [number, number] {
  const len = Math.hypot(dx, dz);
  if (len < 0.0001) return [0, 0];
  const ndx = dx / len;
  const ndz = dz / len;
  return [-ndz, ndx];
}

/**
 * Compute curvature over a 3-sample window.
 * Curvature = |heading change| / arc length
 */
function computeCurvature(samples: RoadSample[], i: number): number {
  if (i < 1 || i > samples.length - 2) return 0;

  const prev = samples[i - 1];
  const curr = samples[i];
  const next = samples[i + 1];

  // heading change
  const h1 = Math.atan2(curr.z - prev.z, curr.x - prev.x);
  const h2 = Math.atan2(next.z - curr.z, next.x - curr.x);
  let dh = h2 - h1;
  // normalize to [-pi, pi]
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;

  // arc length from prev to next
  const s1 = Math.hypot(curr.x - prev.x, curr.y - prev.y, curr.z - prev.z);
  const s2 = Math.hypot(next.x - curr.x, next.y - curr.y, next.z - curr.z);
  const arcLen = s1 + s2;

  if (arcLen < 0.0001) return 0;
  return Math.abs(dh) / arcLen;
}

/**
 * Offset a lane from samples using LANE_OFFSET to the right.
 */
function offsetLane(samples: RoadSample[], direction: 'forward' | 'reverse'): V3[] {
  const points: V3[] = [];
  const samples_to_process = direction === 'forward' ? samples : [...samples].reverse();

  for (let i = 0; i < samples_to_process.length; i++) {
    const s = samples_to_process[i];

    // compute direction from neighbors
    let dx = 0, dz = 0;
    if (i === 0) {
      // first point: direction to next
      if (samples_to_process.length > 1) {
        const next = samples_to_process[1];
        dx = next.x - s.x;
        dz = next.z - s.z;
      }
    } else if (i === samples_to_process.length - 1) {
      // last point: direction from prev
      const prev = samples_to_process[i - 1];
      dx = s.x - prev.x;
      dz = s.z - prev.z;
    } else {
      // middle: direction from prev to next
      const prev = samples_to_process[i - 1];
      const next = samples_to_process[i + 1];
      dx = next.x - prev.x;
      dz = next.z - prev.z;
    }

    // get right vector
    const [rx, rz] = getRightVector(dx, dz);

    // offset point
    points.push({
      x: s.x + rx * LANE_OFFSET,
      y: s.y,
      z: s.z + rz * LANE_OFFSET,
    });
  }

  return points;
}

/**
 * Compute maxSpeed array from curvature.
 * maxSpeed[i] = min(9, 2.2 / (curvature + 0.02))
 */
function computeMaxSpeed(samples: RoadSample[]): number[] {
  return samples.map((_, i) => {
    const curv = computeCurvature(samples, i);
    return Math.min(9, 2.2 / (curv + 0.02));
  });
}

/**
 * Compute lane length from the sample points.
 */
function computeLaneLength(points: V3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return length;
}

export function buildLaneGraph(graph: RoadGraph): LaneGraph {
  const lanes = new Map<number, Lane>();
  const outgoing = new Map<number, number[]>();
  const nodePos = new Map<number, { x: number; z: number }>();

  // Initialize outgoing map with empty arrays for all nodes, and record true node positions
  for (const node of graph.nodes.values()) {
    outgoing.set(node.id, []);
    nodePos.set(node.id, { x: node.x, z: node.z });
  }

  // Process each painted edge
  for (const edge of graph.edges.values()) {
    if (edge.stage !== 'painted') continue;

    // Lane a->b (forward)
    {
      const laneId = edge.id * 2;
      const points = offsetLane(edge.samples, 'forward');
      const length = computeLaneLength(points);
      const maxSpeed = computeMaxSpeed(edge.samples);

      const lane: Lane = {
        id: laneId,
        edgeId: edge.id,
        from: edge.a,
        to: edge.b,
        points,
        length,
        maxSpeed,
      };

      lanes.set(laneId, lane);
      if (!outgoing.has(edge.a)) outgoing.set(edge.a, []);
      outgoing.get(edge.a)!.push(laneId);
    }

    // Lane b->a (reverse)
    {
      const laneId = edge.id * 2 + 1;
      const points = offsetLane(edge.samples, 'reverse');
      const length = computeLaneLength(points);
      const maxSpeed = computeMaxSpeed([...edge.samples].reverse());

      const lane: Lane = {
        id: laneId,
        edgeId: edge.id,
        from: edge.b,
        to: edge.a,
        points,
        length,
        maxSpeed,
      };

      lanes.set(laneId, lane);
      if (!outgoing.has(edge.b)) outgoing.set(edge.b, []);
      outgoing.get(edge.b)!.push(laneId);
    }
  }

  return { lanes, outgoing, nodePos };
}

/**
 * A* routing from one node to another using lanes.
 * Returns the sequence of lanes to take, or null if no path exists.
 */
export function findRoute(lg: LaneGraph, fromNode: number, toNode: number): Lane[] | null {
  // Special case: already at destination
  if (fromNode === toNode) return [];

  // Compute heuristic: euclidean distance between true node positions
  const heuristic = (node: number): number => {
    const destCoords = lg.nodePos.get(toNode);
    const nodeCoord = lg.nodePos.get(node);
    if (!destCoords || !nodeCoord) return 0;
    const dx = destCoords.x - nodeCoord.x;
    const dz = destCoords.z - nodeCoord.z;
    return Math.hypot(dx, dz);
  };

  // A* state
  interface AStarNode {
    lane: Lane;
    gCost: number;
    fCost: number;
    parent: AStarNode | null;
  }

  const openList: AStarNode[] = [];
  const closedSet = new Set<number>(); // lane ids we've fully explored
  const gCostMap = new Map<number, number>(); // best gCost for each lane

  // Find all lanes starting from the source node
  const startLanes = (lg.outgoing.get(fromNode) || [])
    .map((laneId) => lg.lanes.get(laneId)!)
    .filter((lane) => lane !== undefined);

  for (const lane of startLanes) {
    const g = lane.length;
    const h = heuristic(lane.to);
    const f = g + h;
    openList.push({ lane, gCost: g, fCost: f, parent: null });
    gCostMap.set(lane.id, g);
  }

  // Sort by fCost (min-heap: lowest f first)
  openList.sort((a, b) => a.fCost - b.fCost);

  while (openList.length > 0) {
    // Pop lowest fCost
    const current = openList.shift()!;

    // Check if we've reached the goal
    if (current.lane.to === toNode) {
      // Reconstruct path
      const path: Lane[] = [];
      let node: AStarNode | null = current;
      while (node) {
        path.unshift(node.lane);
        node = node.parent;
      }
      return path;
    }

    closedSet.add(current.lane.id);

    // Expand neighbors
    const successors = (lg.outgoing.get(current.lane.to) || [])
      .map((laneId) => lg.lanes.get(laneId)!)
      .filter((lane) => lane !== undefined);

    for (const successor of successors) {
      // Skip if already fully explored
      if (closedSet.has(successor.id)) continue;

      // Exclude the reverse lane unless it's the only option
      if (successor.edgeId === current.lane.edgeId) {
        // This is the reverse lane of the same edge
        if (successors.length > 1) {
          continue;
        }
      }

      const newGCost = current.gCost + successor.length;
      const oldGCost = gCostMap.get(successor.id);

      // Only process if this is a better path
      if (oldGCost !== undefined && newGCost >= oldGCost) {
        continue;
      }

      gCostMap.set(successor.id, newGCost);
      const h = heuristic(successor.to);
      const f = newGCost + h;

      openList.push({
        lane: successor,
        gCost: newGCost,
        fCost: f,
        parent: current,
      });
    }

    // Keep open list sorted (once per outer expansion, not once per successor)
    openList.sort((a, b) => a.fCost - b.fCost);
  }

  // No path found
  return null;
}
