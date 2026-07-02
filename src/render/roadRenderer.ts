import * as THREE from 'three';
import type { RoadSample, Stage } from '../core/types';
import { STAGES } from '../core/types';
import { ROAD_WIDTH } from '../core/constants';
import { EventBus } from '../core/events';
import { RoadGraph, RoadEdge } from '../sim/roads/graph';
import type { Heightfield } from '../sim/terrain/heightfield';

const REBUILD_THROTTLE = 0.15; // seconds, per edge, during progress events
const SHEEN_DURATION = 25; // seconds for fresh-asphalt roughness lerp

const STAGE_COLOR: Record<Stage, string> = {
  surveyed: '#e8641b',
  graded: '#8a6f4d',
  gravel: '#9b958a',
  paved: '#3c3f41',
  painted: '#3c3f41', // painted reuses paved's full-width ribbon color; center-line added separately
};

const STAGE_YLIFT: Record<Stage, number> = {
  surveyed: 0.02,
  graded: 0.06,
  gravel: 0.12,
  paved: 0.18,
  painted: 0.18,
};

const SURVEY_WIDTH = 0.8;
const SURVEY_OPACITY = 0.55;
const CENTERLINE_WIDTH = 0.35;
const CENTERLINE_COLOR = '#e8e4d8';
const CENTERLINE_YLIFT = 0.24;

const BRIDGE_COLOR = '#7a7a72';
const BRIDGE_RAIL_WIDTH = 0.4;
const BRIDGE_RAIL_HEIGHT = 0.8;
const BRIDGE_PYLON_RADIUS = 0.9;
const BRIDGE_PYLON_SPACING = 16;

/** Previous stage in the construction order; 'surveyed' has no previous stage. */
function prevStage(stage: Stage): Stage | null {
  const i = STAGES.indexOf(stage);
  return i > 0 ? STAGES[i - 1] : null;
}

interface SamplePoint {
  x: number;
  y: number;
  z: number;
  dist: number; // cumulative arclength from sample[0]
}

function cumulativeDistances(samples: RoadSample[]): SamplePoint[] {
  const out: SamplePoint[] = [];
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) {
      acc += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z, samples[i].y - samples[i - 1].y);
    }
    out.push({ x: samples[i].x, y: samples[i].y, z: samples[i].z, dist: acc });
  }
  return out;
}

/** Perpendicular (XZ, normalized) at sample i, derived from neighbor direction. Falls back to the previous perpendicular when the local direction is degenerate. */
function perpendicularsFor(pts: SamplePoint[]): Array<{ px: number; pz: number }> {
  const out: Array<{ px: number; pz: number }> = [];
  let prevPerp = { px: 0, pz: 1 };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    let perp: { px: number; pz: number };
    if (len < 1e-6) {
      perp = prevPerp;
    } else {
      perp = { px: -dz / len, pz: dx / len };
    }
    out.push(perp);
    prevPerp = perp;
  }
  return out;
}

function lerpPoint(a: SamplePoint, b: SamplePoint, u: number): SamplePoint {
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    dist: a.dist + (b.dist - a.dist) * u,
  };
}

function lerpPerp(a: { px: number; pz: number }, b: { px: number; pz: number }, u: number): { px: number; pz: number } {
  const px = a.px + (b.px - a.px) * u;
  const pz = a.pz + (b.pz - a.pz) * u;
  const len = Math.hypot(px, pz) || 1;
  return { px: px / len, pz: pz / len };
}

/**
 * Builds a triangle-strip ribbon geometry spanning arclength [from, to] of `samples`,
 * offset left/right by `width/2` along the XZ perpendicular, lifted by `yLift` on Y.
 * Returns an empty (zero-vertex) geometry if the range is degenerate or out of bounds.
 */
export function buildRibbonGeometry(
  samples: RoadSample[],
  width: number,
  yLift: number,
  from: number,
  to: number,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  if (samples.length < 2 || to <= from) return geo;

  const pts = cumulativeDistances(samples);
  const perps = perpendicularsFor(pts);
  const total = pts[pts.length - 1].dist;
  const lo = Math.max(0, from);
  const hi = Math.min(total, to);
  if (hi <= lo) return geo;

  // Build the ordered list of (point, perp) pairs spanning [lo, hi], including
  // interpolated boundary vertices at exactly lo and hi.
  const half = width / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const pushPair = (p: SamplePoint, perp: { px: number; pz: number }) => {
    const vi = positions.length / 3;
    positions.push(p.x + perp.px * half, p.y + yLift, p.z + perp.pz * half);
    normals.push(0, 1, 0);
    positions.push(p.x - perp.px * half, p.y + yLift, p.z - perp.pz * half);
    normals.push(0, 1, 0);
    return vi;
  };

  let firstVi = -1;
  let prevVi = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = pts[i].dist;
    if (d < lo) {
      // check if the boundary falls between this sample and the next
      if (i + 1 < pts.length && pts[i + 1].dist > lo) {
        const u = (lo - d) / (pts[i + 1].dist - d);
        const p = lerpPoint(pts[i], pts[i + 1], u);
        const perp = lerpPerp(perps[i], perps[i + 1], u);
        const vi = pushPair(p, perp);
        firstVi = vi;
        prevVi = vi;
      }
      continue;
    }
    if (d > hi) {
      // emit interpolated boundary at hi using previous and this sample, then stop
      if (i > 0 && pts[i - 1].dist < hi) {
        const u = (hi - pts[i - 1].dist) / (d - pts[i - 1].dist);
        const p = lerpPoint(pts[i - 1], pts[i], u);
        const perp = lerpPerp(perps[i - 1], perps[i], u);
        const vi = pushPair(p, perp);
        if (prevVi >= 0) {
          indices.push(prevVi, vi, prevVi + 1);
          indices.push(prevVi + 1, vi, vi + 1);
        }
        prevVi = vi;
      }
      break;
    }
    // d in [lo, hi]
    if (Math.abs(d - lo) < 1e-9 && firstVi === -1) {
      const vi = pushPair(pts[i], perps[i]);
      firstVi = vi;
      prevVi = vi;
      continue;
    }
    const vi = pushPair(pts[i], perps[i]);
    if (prevVi >= 0) {
      indices.push(prevVi, vi, prevVi + 1);
      indices.push(prevVi + 1, vi, vi + 1);
    }
    prevVi = vi;
  }
  // If we never hit the `d > hi` break (hi === total, exact end), we're done — last pushed pair is the endpoint.

  if (positions.length === 0) return geo;

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/** Merges several BufferGeometries (position+normal only, non-indexed triangles) into one. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const g of geos) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const index = g.getIndex();
    if (!pos || !nrm) continue;
    if (index) {
      for (let k = 0; k < index.count; k++) {
        const vi = index.getX(k);
        positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        normals.push(nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi));
      }
    } else {
      for (let vi = 0; vi < pos.count; vi++) {
        positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        normals.push(nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi));
      }
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

/** Builds a dashed ribbon: alternating "on" segments of `dashLen`, skipping `dashLen` in between, across [from, to]. */
function buildDashedRibbonGeometry(
  samples: RoadSample[],
  width: number,
  yLift: number,
  from: number,
  to: number,
  dashLen: number,
): THREE.BufferGeometry {
  const segs: THREE.BufferGeometry[] = [];
  let cursor = from;
  let on = true;
  while (cursor < to) {
    const segEnd = Math.min(to, cursor + dashLen);
    if (on) segs.push(buildRibbonGeometry(samples, width, yLift, cursor, segEnd));
    cursor = segEnd;
    on = !on;
  }
  const merged = mergeGeometries(segs);
  segs.forEach((g) => g.dispose());
  return merged;
}

interface BridgeRun {
  fromDist: number;
  toDist: number;
}

/** Finds maximal consecutive runs of bridge==true samples, expressed as arclength ranges. */
function findBridgeRuns(samples: RoadSample[]): BridgeRun[] {
  const pts = cumulativeDistances(samples);
  const runs: BridgeRun[] = [];
  let runStart = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].bridge) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      runs.push({ fromDist: pts[runStart].dist, toDist: pts[i - 1].dist });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ fromDist: pts[runStart].dist, toDist: pts[samples.length - 1].dist });
  return runs;
}

function makeStandardMaterial(color: string, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.9,
    transparent: opacity < 1,
    opacity,
  });
}

interface PendingProgress {
  stage: Stage;
  t: number;
}

interface EdgeVisual {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  lastRebuildAt: number;
  pending: PendingProgress | null;
  freshAsphaltAt: number | null; // performance.now()/1000-style seconds when 'paved' stage began, or null
}

export class RoadRenderer {
  private visuals = new Map<number, EdgeVisual>();
  private clockSeconds = 0;

  constructor(
    private scene: THREE.Scene,
    private graph: RoadGraph,
    bus: EventBus,
    private hf: Heightfield,
  ) {
    bus.on('roads:edgeAdded', ({ edgeId }) => this.onEdgeAdded(edgeId));
    bus.on('roads:edgeRemoved', ({ edgeId }) => this.disposeEdge(edgeId));
    bus.on('construction:stage', ({ edgeId, stage }) => this.onStage(edgeId, stage));
    bus.on('construction:progress', ({ edgeId, stage, t }) => this.onProgress(edgeId, stage, t));
  }

  private onEdgeAdded(edgeId: number): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    this.rebuild(edge);
  }

  private onStage(edgeId: number, stage: Stage | 'removed'): void {
    if (stage === 'removed') {
      this.disposeEdge(edgeId);
      return;
    }
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const v = this.visuals.get(edgeId);
    if (v) v.pending = null; // full-stage event supersedes any partial progress
    if (stage === 'paved') {
      const vv = this.ensureVisual(edge);
      vv.freshAsphaltAt = this.clockSeconds;
    }
    this.rebuild(edge);
  }

  private onProgress(edgeId: number, stage: Stage, t: number): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const v = this.ensureVisual(edge);
    v.pending = { stage, t };
  }

  private ensureVisual(edge: RoadEdge): EdgeVisual {
    let v = this.visuals.get(edge.id);
    if (!v) {
      const group = new THREE.Group();
      group.userData.edgeId = edge.id;
      this.scene.add(group);
      v = { group, meshes: [], lastRebuildAt: -Infinity, pending: null, freshAsphaltAt: edge.stage === 'paved' || edge.stage === 'painted' ? this.clockSeconds : null };
      this.visuals.set(edge.id, v);
    }
    return v;
  }

  private clearMeshes(v: EdgeVisual): void {
    for (const m of v.meshes) {
      v.group.remove(m);
      m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else mat.dispose();
    }
    v.meshes = [];
  }

  private addMesh(v: EdgeVisual, geo: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    v.group.add(mesh);
    v.meshes.push(mesh);
    return mesh;
  }

  private rebuild(edge: RoadEdge): void {
    const v = this.ensureVisual(edge);
    this.clearMeshes(v);
    v.lastRebuildAt = this.clockSeconds;

    const samples = edge.samples;
    const length = edge.length;

    if (v.pending) {
      const { stage, t } = v.pending;
      const prev = prevStage(stage);
      const clampedT = Math.max(0, Math.min(length, t));
      this.buildStageSegment(v, samples, stage, 0, clampedT);
      if (prev) this.buildStageSegment(v, samples, prev, clampedT, length);
      else this.buildStageSegment(v, samples, 'surveyed', clampedT, length);
    } else {
      this.buildStageSegment(v, samples, edge.stage, 0, length);
    }

    this.buildBridgeParts(v, samples);
  }

  /** Renders the appearance for `stage` across arclength [from, to] on this edge. */
  private buildStageSegment(v: EdgeVisual, samples: RoadSample[], stage: Stage, from: number, to: number): void {
    if (to <= from) return;
    if (stage === 'surveyed') {
      const geo = buildDashedRibbonGeometry(samples, SURVEY_WIDTH, STAGE_YLIFT.surveyed, from, to, 2);
      const mat = makeStandardMaterial(STAGE_COLOR.surveyed, SURVEY_OPACITY);
      this.addMesh(v, geo, mat);
      return;
    }

    const yLift = STAGE_YLIFT[stage];
    const color = STAGE_COLOR[stage];
    const geo = buildRibbonGeometry(samples, ROAD_WIDTH, yLift, from, to);
    const mat = makeStandardMaterial(color);
    const mesh = this.addMesh(v, geo, mat);
    if (stage === 'paved' || stage === 'painted') {
      mat.roughness = 0.35; // fresh asphalt sheen start; advanced in update()
      mesh.userData.freshAsphalt = true;
    }

    if (stage === 'painted') {
      const dashGeo = buildDashedRibbonGeometry(samples, CENTERLINE_WIDTH, CENTERLINE_YLIFT, from, to, 2);
      const dashMat = makeStandardMaterial(CENTERLINE_COLOR);
      this.addMesh(v, dashGeo, dashMat);
    }
  }

  private buildBridgeParts(v: EdgeVisual, samples: RoadSample[]): void {
    const runs = findBridgeRuns(samples);
    if (!runs.length) return;

    const pts = cumulativeDistances(samples);

    for (const run of runs) {
      // side rails: real 0.4 (wide) x 0.8 (tall) box cross-sections following the deck curve,
      // offset to sit just inside the deck edges, resting on top of the paved deck surface.
      const railOffset = ROAD_WIDTH / 2 - 0.2;
      for (const side of [-1, 1]) {
        const railGeo = buildRailBoxGeometry(
          samples,
          side * railOffset,
          BRIDGE_RAIL_WIDTH,
          BRIDGE_RAIL_HEIGHT,
          STAGE_YLIFT.paved,
          run.fromDist,
          run.toDist,
        );
        const railMat = makeStandardMaterial(BRIDGE_COLOR);
        this.addMesh(v, railGeo, railMat);
      }

      // pylons every BRIDGE_PYLON_SPACING along the run
      const runLen = run.toDist - run.fromDist;
      const count = Math.max(1, Math.floor(runLen / BRIDGE_PYLON_SPACING) + 1);
      for (let k = 0; k <= count; k++) {
        const d = run.fromDist + Math.min(runLen, k * BRIDGE_PYLON_SPACING);
        if (d > run.toDist) break;
        const p = samplePointAt(pts, d);
        const groundY = this.hf.heightAt(p.x, p.z);
        const deckY = p.y;
        const pylonHeight = Math.max(0.1, deckY - groundY);
        const cyl = new THREE.CylinderGeometry(BRIDGE_PYLON_RADIUS, BRIDGE_PYLON_RADIUS, pylonHeight, 8);
        cyl.translate(0, pylonHeight / 2, 0);
        cyl.translate(p.x, groundY, p.z);
        const mat = makeStandardMaterial(BRIDGE_COLOR);
        this.addMesh(v, cyl, mat);
        if (d >= run.toDist) break;
      }
    }
  }

  private disposeEdge(edgeId: number): void {
    const v = this.visuals.get(edgeId);
    if (!v) return;
    this.clearMeshes(v);
    this.scene.remove(v.group);
    this.visuals.delete(edgeId);
  }

  update(dt: number): void {
    this.clockSeconds += dt;

    for (const [edgeId, v] of this.visuals) {
      // throttled rebuild of buffered progress
      if (v.pending && this.clockSeconds - v.lastRebuildAt >= REBUILD_THROTTLE) {
        const edge = this.graph.edges.get(edgeId);
        if (edge) this.rebuild(edge);
      }

      // advance fresh-asphalt roughness sheen
      if (v.freshAsphaltAt !== null) {
        const elapsed = this.clockSeconds - v.freshAsphaltAt;
        const u = Math.max(0, Math.min(1, elapsed / SHEEN_DURATION));
        const roughness = 0.35 + (0.9 - 0.35) * u;
        for (const m of v.meshes) {
          if (!m.userData.freshAsphalt) continue;
          (m.material as THREE.MeshStandardMaterial).roughness = roughness;
        }
        if (u >= 1) v.freshAsphaltAt = null;
      }
    }
  }
}

/**
 * Builds a solid rectangular-cross-section "box rail" that follows the deck curve.
 *
 * `samples` is a plain array of deck points (`{x,y,z}`, in order along the curve); arclength
 * distances and per-sample XZ perpendiculars are derived internally. The rail's centerline is
 * that polyline shifted sideways by `sideOffset` along each sample's perpendicular. At each
 * retained sample the cross-section is a `width` (across, along the perpendicular) x `height`
 * (vertical) rectangle whose bottom sits at `deckY + yLift` and whose top is `height` above that.
 * Consecutive rings are stitched into quads (2 triangles each) for the outer, top, inner, and
 * bottom faces, each wound so its normal points away from the box's interior (outer -> +perp,
 * top -> +Y, inner -> -perp, bottom -> -Y); the two open ends are capped with a single quad each,
 * wound to face away from the box along -tangent (start) / +tangent (end). Vertex normals are
 * computed afterward via `computeVertexNormals()` for flat/box-like shading.
 *
 * `from`/`to` optionally restrict the build to an arclength sub-range (defaults to the full
 * length of `samples`).
 */
export function buildRailBoxGeometry(
  samples: Array<{ x: number; y: number; z: number }>,
  sideOffset: number,
  width: number = BRIDGE_RAIL_WIDTH,
  height: number = BRIDGE_RAIL_HEIGHT,
  yLift: number = 0,
  from?: number,
  to?: number,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pts = cumulativeDistances(samples.map((s) => ({ x: s.x, y: s.y, z: s.z, bridge: false })));
  const perps = perpendicularsFor(pts);
  const lo0 = from ?? 0;
  const hi0 = to ?? (pts.length ? pts[pts.length - 1].dist : 0);
  if (pts.length < 2 || hi0 <= lo0) return geo;

  const total = pts[pts.length - 1].dist;
  const lo = Math.max(0, lo0);
  const hi = Math.min(total, hi0);
  if (hi <= lo) return geo;

  const half = width / 2;
  const bottomY = yLift;
  const topY = yLift + height;

  // Collect the ordered (point, perp) samples spanning [lo, hi], including interpolated
  // boundary samples at exactly lo and hi (mirrors buildRibbonGeometry's boundary handling).
  const centers: SamplePoint[] = [];
  const centerPerps: Array<{ px: number; pz: number }> = [];

  const pushCenter = (p: SamplePoint, perp: { px: number; pz: number }) => {
    centers.push({
      x: p.x + perp.px * sideOffset,
      y: p.y,
      z: p.z + perp.pz * sideOffset,
      dist: p.dist,
    });
    centerPerps.push(perp);
  };

  for (let i = 0; i < pts.length; i++) {
    const d = pts[i].dist;
    if (d < lo) {
      if (i + 1 < pts.length && pts[i + 1].dist > lo) {
        const u = (lo - d) / (pts[i + 1].dist - d);
        const p = lerpPoint(pts[i], pts[i + 1], u);
        const perp = lerpPerp(perps[i], perps[i + 1], u);
        pushCenter(p, perp);
      }
      continue;
    }
    if (d > hi) {
      if (i > 0 && pts[i - 1].dist < hi) {
        const u = (hi - pts[i - 1].dist) / (d - pts[i - 1].dist);
        const p = lerpPoint(pts[i - 1], pts[i], u);
        const perp = lerpPerp(perps[i - 1], perps[i], u);
        pushCenter(p, perp);
      }
      break;
    }
    if (Math.abs(d - lo) < 1e-9 && centers.length === 0) {
      pushCenter(pts[i], perps[i]);
      continue;
    }
    pushCenter(pts[i], perps[i]);
  }

  if (centers.length < 2) return geo;

  const positions: number[] = [];
  const indices: number[] = [];

  // Per ring: 4 vertices in order [outer-bottom, outer-top, inner-top, inner-bottom].
  // "Outer" = +half along perp, "inner" = -half along perp.
  const ringIndices: number[] = [];
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    const perp = centerPerps[i];
    const ox = c.x + perp.px * half;
    const oz = c.z + perp.pz * half;
    const ix = c.x - perp.px * half;
    const iz = c.z - perp.pz * half;

    const vi = positions.length / 3;
    positions.push(ox, c.y + bottomY, oz); // outer-bottom
    positions.push(ox, c.y + topY, oz); // outer-top
    positions.push(ix, c.y + topY, iz); // inner-top
    positions.push(ix, c.y + bottomY, iz); // inner-bottom
    ringIndices.push(vi);
  }

  const quad = (a: number, b: number, c: number, d: number) => {
    // a-b-c-d in order around the quad; two CCW (from outside) triangles.
    indices.push(a, b, c);
    indices.push(a, c, d);
  };

  for (let i = 0; i < ringIndices.length - 1; i++) {
    const r0 = ringIndices[i];
    const r1 = ringIndices[i + 1];
    const ob0 = r0, ot0 = r0 + 1, it0 = r0 + 2, ib0 = r0 + 3;
    const ob1 = r1, ot1 = r1 + 1, it1 = r1 + 2, ib1 = r1 + 3;

    // Outer face (facing +perp, away from the rail's own centerline)
    quad(ob0, ob1, ot1, ot0);
    // Top face (facing +Y)
    quad(ot0, ot1, it1, it0);
    // Inner face (facing -perp, toward the rail's own centerline)
    quad(it0, it1, ib1, ib0);
    // Bottom face (facing -Y)
    quad(ib0, ib1, ob1, ob0);
  }

  // End caps (start and end rings), each a single quad closing the rectangle, wound to
  // face away from the box along -tangent (start) / +tangent (end).
  const startR = ringIndices[0];
  quad(startR + 3, startR, startR + 1, startR + 2); // inner-bottom, outer-bottom, outer-top, inner-top
  const endR = ringIndices[ringIndices.length - 1];
  quad(endR, endR + 3, endR + 2, endR + 1); // outer-bottom, inner-bottom, inner-top, outer-top

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function samplePointAt(pts: SamplePoint[], d: number): SamplePoint {
  if (d <= pts[0].dist) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].dist >= d) {
      const u = (d - pts[i - 1].dist) / (pts[i].dist - pts[i - 1].dist || 1);
      return lerpPoint(pts[i - 1], pts[i], u);
    }
  }
  return pts[pts.length - 1];
}
