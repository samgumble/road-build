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

  private polyLength(s: RoadSample[]): number {
    let L = 0;
    for (let i = 1; i < s.length; i++) L += Math.hypot(s[i].x - s[i-1].x, s[i].y - s[i-1].y, s[i].z - s[i-1].z);
    return L;
  }

  private addNode(p: P2): number {
    const existing = this.points.get(key(p));
    if (existing?.kind === 'node') return existing.id;
    if (existing?.kind === 'edge') return this.splitEdge(existing.id, existing.ctrlIndex!).nodeId;
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    return id;
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
    this.unindexEdge(e);
    this.edges.delete(edgeId);
    const p = e.ctrl[ctrlIndex];
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    const left = this.makeEdge(e.a, id, e.ctrl.slice(0, ctrlIndex + 1), e.stage);
    const right = this.makeEdge(id, e.b, e.ctrl.slice(ctrlIndex), e.stage);
    this.bus.emit('roads:edgeRemoved', { edgeId });
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
      if (a === b) continue;
      if (sub.length === 2 && this.hasEdgeBetween(a, b)) continue;
      const id = this.makeEdge(a, b, sub, 'surveyed');
      ids.push(id);
      this.bus.emit('roads:edgeAdded', { edgeId: id });
    }
    if (ids.length) this.bus.emit('roads:changed', {});
    return ids;
  }

  removeEdge(edgeId: number): void {
    const e = this.edges.get(edgeId);
    if (!e) return;
    this.unindexEdge(e);
    this.edges.delete(edgeId);
    for (const nid of [e.a, e.b]) {
      if (this.edgesAtNode(nid).length === 0) {
        const n = this.nodes.get(nid)!;
        this.points.delete(key({ x: n.x, z: n.z }));
        this.nodes.delete(nid);
      }
    }
    this.bus.emit('roads:edgeRemoved', { edgeId });
    this.bus.emit('roads:changed', {});
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
