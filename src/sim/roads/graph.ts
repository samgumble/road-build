import { SNAP } from '../../core/constants';
import type { P2, RoadSample, Stage } from '../../core/types';
import { EventBus } from '../../core/events';

export interface RoadEdge {
  id: number; a: number; b: number;
  ctrl: P2[]; samples: RoadSample[]; length: number; stage: Stage;
}

const key = (p: P2) => `${p.x},${p.z}`;

export class RoadGraph {
  nodes = new Map<number, { id: number; x: number; z: number }>();
  edges = new Map<number, RoadEdge>();
  private points = new Map<string, { kind: 'node' | 'edge'; id: number; ctrlIndex?: number }>();
  private nextNode = 1;
  private nextEdge = 1;

  constructor(private bus: EventBus, private sampler: (ctrl: P2[]) => RoadSample[]) {}

  static snap(x: number, z: number): P2 {
    return { x: Math.round(x / SNAP) * SNAP || 0, z: Math.round(z / SNAP) * SNAP || 0 };
  }

  /**
   * Magnetic snap for the draw tool (Fix: "separate roads should snap together"): finds the
   * nearest existing NODE or edge-interior CONTROL POINT within `radius` of (x, z) and returns
   * its exact position, so a new chain drawn near — but not exactly on — an existing junction or
   * mid-edge point still lands precisely on it (commitChain's cut-detection then forms a proper
   * junction). Falls back to the bare grid snap when nothing existing is within radius. Pure:
   * only reads `nodes`/`edges`, never mutates.
   */
  magnetSnap(x: number, z: number, radius: number): P2 {
    let best: P2 | null = null;
    let bestDist = radius;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d <= bestDist) { bestDist = d; best = { x: n.x, z: n.z }; }
    }
    for (const e of this.edges.values()) {
      for (let i = 1; i < e.ctrl.length - 1; i++) {
        const p = e.ctrl[i];
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= bestDist) { bestDist = d; best = { x: p.x, z: p.z }; }
      }
    }
    // A visually long road can have only two authoritative control points, so limiting magnetic
    // connection targets to interior controls makes its entire middle impossible to connect to.
    // Sampled centerlines are the same geometry the player sees; snap their nearest point back to
    // the topology grid. `addNode` resolves that point into a real split during commitChain.
    for (const e of this.edges.values()) {
      for (const sample of e.samples) {
        const d = Math.hypot(sample.x - x, sample.z - z);
        if (d < bestDist - 1e-6) {
          bestDist = d;
          best = RoadGraph.snap(sample.x, sample.z);
        }
      }
    }
    return best ?? RoadGraph.snap(x, z);
  }

  private polyLength(s: RoadSample[]): number {
    let L = 0;
    for (let i = 1; i < s.length; i++) L += Math.hypot(s[i].x - s[i-1].x, s[i].y - s[i-1].y, s[i].z - s[i-1].z);
    return L;
  }

  private addNode(p: P2): number {
    const existing = this.points.get(key(p));
    if (existing?.kind === 'node') return existing.id;
    if (existing?.kind === 'edge') return this.splitEdge(existing.id, existing.ctrlIndex!).nodeId;
    const centerline = this.nearestEdgeSample(p, SNAP / 2 + 0.01);
    if (centerline) return this.splitEdgeAtPoint(centerline.edgeId, p).nodeId;
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    return id;
  }

  private nearestEdgeSample(p: P2, radius: number): { edgeId: number; distance: number } | null {
    let best: { edgeId: number; distance: number } | null = null;
    for (const edge of this.edges.values()) {
      for (const sample of edge.samples) {
        const distance = Math.hypot(sample.x - p.x, sample.z - p.z);
        if (distance > radius || (best && distance >= best.distance)) continue;
        best = { edgeId: edge.id, distance };
      }
    }
    return best;
  }

  private makeEdge(a: number, b: number, ctrl: P2[], stage: Stage): number {
    const id = this.nextEdge++;
    const samples = this.sampler(ctrl);
    this.edges.set(id, { id, a, b, ctrl, samples, length: this.polyLength(samples), stage });
    for (let i = 1; i < ctrl.length - 1; i++) {
      if (!this.points.has(key(ctrl[i]))) this.points.set(key(ctrl[i]), { kind: 'edge', id, ctrlIndex: i });
    }
    return id;
  }

  private unindexEdge(e: RoadEdge): void {
    for (let i = 1; i < e.ctrl.length - 1; i++) {
      const rec = this.points.get(key(e.ctrl[i]));
      if (rec?.kind === 'edge' && rec.id === e.id) this.points.delete(key(e.ctrl[i]));
    }
  }

  splitEdge(edgeId: number, ctrlIndex: number): { nodeId: number; left: number; right: number } {
    // DOCUMENTED-SKIP: unlike `commitChain`/`removeEdge`, this doesn't also emit `roads:changed` —
    // only the per-edge `roads:edgeRemoved`/`roads:edgeAdded` pair below. Callers that split as part
    // of a larger chain commit (the normal path, via `commitChain`) get a `roads:changed` from that
    // outer call anyway; a bare/direct `splitEdge` call would miss the lane/growth rebuild it
    // implies. This is a rare corner (direct callers outside `commitChain` are test-only today) and
    // the fix — emitting `roads:changed` here too — would mean a double rebuild on the far more
    // common commitChain path, which isn't worth the extra recompute cost for this edge case.
    const e = this.edges.get(edgeId)!;
    return this.replaceEdgeWithSplit(e, e.ctrl, ctrlIndex);
  }

  /** Inserts a snapped connection point into the nearest control-polyline leg, then performs the
   * same normal edge replacement as an existing interior-control split. This is what turns a
   * centerline magnetic snap into a real shared graph node rather than two coincident visuals. */
  private splitEdgeAtPoint(edgeId: number, p: P2): { nodeId: number; left: number; right: number } {
    const edge = this.edges.get(edgeId)!;
    let bestSegment = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < edge.ctrl.length - 1; i++) {
      const a = edge.ctrl[i], b = edge.ctrl[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      const u = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0;
      const distance = Math.hypot(p.x - (a.x + dx * u), p.z - (a.z + dz * u));
      if (distance < bestDistance) { bestDistance = distance; bestSegment = i; }
    }
    const expanded = [
      ...edge.ctrl.slice(0, bestSegment + 1),
      { ...p },
      ...edge.ctrl.slice(bestSegment + 1),
    ];
    return this.replaceEdgeWithSplit(edge, expanded, bestSegment + 1);
  }

  private replaceEdgeWithSplit(
    e: RoadEdge,
    ctrl: P2[],
    ctrlIndex: number,
  ): { nodeId: number; left: number; right: number } {
    this.unindexEdge(e);
    this.edges.delete(e.id);
    const p = ctrl[ctrlIndex];
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    const left = this.makeEdge(e.a, id, ctrl.slice(0, ctrlIndex + 1), e.stage);
    const right = this.makeEdge(id, e.b, ctrl.slice(ctrlIndex), e.stage);
    this.bus.emit('roads:edgeRemoved', { edgeId: e.id });
    this.bus.emit('roads:edgeAdded', { edgeId: left });
    this.bus.emit('roads:edgeAdded', { edgeId: right });
    return { nodeId: id, left, right };
  }

  commitChain(rawCtrl: P2[]): number[] {
    const ctrl: P2[] = [];
    for (const r of rawCtrl) {
      const p = RoadGraph.snap(r.x, r.z);
      if (!ctrl.length || key(ctrl[ctrl.length - 1]) !== key(p)) ctrl.push(p);
    }
    if (ctrl.length < 2) return [];
    // find split positions: interior chain points that hit existing nodes/edge points
    const cuts = [0];
    for (let i = 1; i < ctrl.length - 1; i++) if (this.points.has(key(ctrl[i]))) cuts.push(i);
    cuts.push(ctrl.length - 1);
    const ids: number[] = [];
    for (let c = 0; c < cuts.length - 1; c++) {
      const sub = ctrl.slice(cuts[c], cuts[c + 1] + 1);
      const a = this.addNode(sub[0]);
      const b = this.addNode(sub[sub.length - 1]);
      if (a === b) {
        // Closed chain (T41 "closed-loop roads"): a stroke that returns to its own start snaps
        // onto the same node at both ends (T18's magnetSnap onto the start stake makes this the
        // common case, not a rare one) — the old behavior silently discarded the whole sub-chain
        // here, which is exactly the "can't complete a loop" bug. Commit it as TWO half-loop edges
        // instead: split `sub` at the control point nearest half its total arclength, mint a
        // midpoint node there, and wire edges start->mid and mid->start. Both halves then behave
        // as perfectly normal edges (own construction job, own lanes both directions, own
        // rendering) — nothing downstream needs to know the road happens to form a ring.
        const halfIds = this.commitClosedLoop(sub, a);
        for (const id of halfIds) {
          ids.push(id);
          this.bus.emit('roads:edgeAdded', { edgeId: id });
        }
        // Degenerate loop (commitClosedLoop bailed): if `a` was a brand-new node minted just now
        // by the addNode(sub[0]) call above (i.e. it's still edgeless), prune it rather than
        // leaving an orphan node with nothing attached — mirrors removeEdge's own orphan cleanup.
        if (halfIds.length === 0 && this.edgesAtNode(a).length === 0) this.pruneOrphanNode(a);
        continue;
      }
      if (sub.length === 2 && this.hasEdgeBetween(a, b)) continue;
      const id = this.makeEdge(a, b, sub, 'surveyed');
      ids.push(id);
      this.bus.emit('roads:edgeAdded', { edgeId: id });
    }
    if (ids.length) this.bus.emit('roads:changed', {});
    return ids;
  }

  /**
   * Splits a closed sub-chain (`sub[0]` and `sub[last]` are the same snapped point, already
   * resolved to node `startNode`) into two half-loop edges sharing a new midpoint node. Returns
   * the committed edge ids, or `[]` if the loop is degenerate (see below) — callers must not
   * assume a non-empty result.
   *
   * Split point: the interior control-point index nearest half the chain's total arclength
   * (measured along `sub`'s own control points, not the sampled/curved path — cheap, deterministic,
   * and plenty accurate for choosing a topological split point).
   *
   * Degenerate cases deliberately left as a no-op (matching the old flat `if (a === b) continue`
   * for anything that still can't form a real loop):
   *  - fewer than 3 DISTINCT control points (e.g. an immediate there-and-back double-tap) — there's
   *    no interior point to split at, so this is exactly as degenerate as any other zero-length
   *    chain and stays skipped.
   *  - a split point that would leave either half with fewer than 3 control points (2 = just the
   *    two endpoint nodes, no interior point at all). `hasEdgeBetween`'s interior-less dedupe
   *    exists precisely to reject a second edge like that between the same two nodes, so rather
   *    than fight it, treat the whole loop as too small to safely halve and skip it entirely.
   */
  private commitClosedLoop(sub: P2[], startNode: number): number[] {
    // sub[0] === sub[last] (same snapped point) — distinct points are sub[0..last-1].
    const distinct = sub.slice(0, sub.length - 1);
    if (distinct.length < 3) return [];

    const legLen: number[] = [0];
    for (let i = 1; i < sub.length; i++) {
      legLen.push(legLen[i - 1] + Math.hypot(sub[i].x - sub[i - 1].x, sub[i].z - sub[i - 1].z));
    }
    const total = legLen[legLen.length - 1];
    const half = total / 2;

    // Candidate split indices: interior points only (1..sub.length-2) so both halves keep the
    // shared start/end point plus at least one interior point of their own.
    let splitIndex = -1;
    let bestDelta = Infinity;
    for (let i = 1; i < sub.length - 1; i++) {
      const delta = Math.abs(legLen[i] - half);
      if (delta < bestDelta) { bestDelta = delta; splitIndex = i; }
    }
    if (splitIndex < 0) return [];

    const firstHalf = sub.slice(0, splitIndex + 1); // start .. mid
    const secondHalf = sub.slice(splitIndex); // mid .. start
    if (firstHalf.length < 3 || secondHalf.length < 3) return []; // would produce an interior-less half

    const midNode = this.addNode(sub[splitIndex]);
    const idA = this.makeEdge(startNode, midNode, firstHalf, 'surveyed');
    const idB = this.makeEdge(midNode, startNode, secondHalf, 'surveyed');
    return [idA, idB];
  }

  removeEdge(edgeId: number): void {
    const e = this.edges.get(edgeId);
    if (!e) return;
    this.unindexEdge(e);
    this.edges.delete(edgeId);
    for (const nid of [e.a, e.b]) {
      if (this.edgesAtNode(nid).length === 0) this.pruneOrphanNode(nid);
    }
    this.bus.emit('roads:edgeRemoved', { edgeId });
    this.bus.emit('roads:changed', {});
  }

  /** Removes a node with no attached edges from both `nodes` and the `points` index. Caller must
   * have already verified `edgesAtNode(nodeId).length === 0` — shared by `removeEdge`'s orphan
   * cleanup and `commitChain`'s degenerate-closed-loop bail-out. */
  private pruneOrphanNode(nodeId: number): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    this.points.delete(key({ x: n.x, z: n.z }));
    this.nodes.delete(nodeId);
  }

  private hasEdgeBetween(a: number, b: number): boolean {
    for (const e of this.edges.values()) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return true;
    }
    return false;
  }

  edgesAtNode(nodeId: number): number[] {
    const out: number[] = [];
    for (const e of this.edges.values()) if (e.a === nodeId || e.b === nodeId) out.push(e.id);
    return out;
  }
}
