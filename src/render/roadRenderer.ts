import * as THREE from 'three';
import type { RoadSample, Stage } from '../core/types';
import { STAGES } from '../core/types';
import { ROAD_WIDTH } from '../core/constants';
import { EventBus } from '../core/events';
import { RoadGraph, RoadEdge } from '../sim/roads/graph';
import type { Heightfield } from '../sim/terrain/heightfield';
import { easeOutCubic, clamp01 } from './easing';

const REBUILD_THROTTLE = 0.15; // seconds, per edge, during progress events
const SHEEN_DURATION = 25; // seconds for fresh-asphalt roughness lerp

export const STAGE_COLOR: Record<Stage, string> = {
  surveyed: '#e8641b',
  graded: '#8a6f4d',
  gravel: '#9b958a',
  paved: '#3c3f41',
  painted: '#3c3f41', // painted reuses paved's full-width ribbon color; center-line added separately
};

// The roller (see constructionRenderer.ts) trails the paver by this many arclength units during
// the 'paved' stage; duplicated here (rather than imported) because it's a small rendering-tuning
// constant, not a shared sim contract, and the two renderers otherwise have no reason to share a
// module. Mirroring it lets the road ribbon show a slightly darker "already compacted" shade
// behind the roller's position and the lighter freshly-laid color ahead of it, without having to
// thread the roller's position through the construction:progress event contract.
export const ROLLER_TRAIL_DISTANCE = 8;
export const PAVED_COMPACTED_COLOR = '#2f3234'; // paved, darkened ~20% — compacted asphalt behind the roller

const STAGE_YLIFT: Record<Stage, number> = {
  surveyed: 0.02,
  graded: 0.06,
  gravel: 0.12,
  paved: 0.18,
  painted: 0.18,
};

const SURVEY_WIDTH = 0.8;
const SURVEY_OPACITY = 0.55;
// Widened from 0.35 (playtest fix: dashes were vanishing at distance — partly a raw pixel-coverage
// issue at long camera range, addressed together with the stronger polygon offset below).
const CENTERLINE_WIDTH = 0.5;
const CENTERLINE_COLOR = '#e8e4d8';
const CENTERLINE_YLIFT = 0.24;

const BRIDGE_COLOR = '#7a7a72';
const BRIDGE_RAIL_WIDTH = 0.4;
const BRIDGE_RAIL_HEIGHT = 0.8;
const BRIDGE_PYLON_RADIUS = 0.9;
// Exported (Task 22): constructionRenderer.ts's crane choreography lowers deck segments in the
// same 16u increments pylons are spaced at, so the two files share this one constant rather than
// each defining their own "span length" that could silently drift out of sync.
export const BRIDGE_PYLON_SPACING = 16;

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

// How many samples to look ahead/behind (each direction) when estimating the tangent at a
// vertex. A window of 1 (immediate neighbors only) tracks a Catmull-Rom curve tightly enough
// that a sharp back-and-forth in the user's drawn control points can flip the tangent direction
// almost 180 degrees between consecutive samples; because the perpendicular is derived straight
// from that tangent with no miter clamping, the ribbon's inner edge folds back on itself at the
// bend, reading as a visible notch/pinch in the road surface. Averaging the tangent over a wider
// span smooths that direction change across several samples, trading a touch of "sharpness" at
// genuine hairpins for a ribbon edge that never self-overlaps.
const TANGENT_WINDOW = 2;

/** Perpendicular (XZ, normalized) at sample i, derived from a smoothed neighbor direction (see
 * TANGENT_WINDOW). Falls back to the previous perpendicular when the local direction is
 * degenerate (e.g. duplicate points). */
function perpendicularsFor(pts: SamplePoint[]): Array<{ px: number; pz: number }> {
  const out: Array<{ px: number; pz: number }> = [];
  let prevPerp = { px: 0, pz: 1 };
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    // Average the direction of every neighboring segment within +/-TANGENT_WINDOW samples,
    // rather than just the single a->b chord used previously. This is a cheap tangent-smoothing
    // pass (not a true miter join), but it's exactly what eliminates the self-crossing inner edge
    // at sharp bends while leaving straight/gently-curved sections numerically unchanged (their
    // neighboring chords already point the same way, so the average equals the single-chord
    // result to within floating point).
    let dx = 0;
    let dz = 0;
    const lo = Math.max(0, i - TANGENT_WINDOW);
    const hi = Math.min(n - 1, i + TANGENT_WINDOW);
    for (let k = lo; k < hi; k++) {
      let sdx = pts[k + 1].x - pts[k].x;
      let sdz = pts[k + 1].z - pts[k].z;
      const slen = Math.hypot(sdx, sdz);
      if (slen < 1e-6) continue;
      sdx /= slen;
      sdz /= slen;
      dx += sdx;
      dz += sdz;
    }
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

/**
 * A single contiguous bridge run's arclength span plus the arclength stations (measured from the
 * edge's own sample[0], NOT from the run's own start) of every pylon along it — the same stations
 * `buildBridgeParts` plants cylinders at. Exported (Task 22) so `constructionRenderer.ts` can
 * choreograph the crane/pylon-rise/deck-masking sequence without duplicating this geometry math or
 * needing a reference to the `RoadRenderer` instance itself; this is a pure function of an edge's
 * `samples`, so either renderer can call it directly off `RoadGraph.edges.get(id)!.samples`.
 */
export interface BridgeRunInfo {
  fromDist: number;
  toDist: number;
  pylonStations: number[];
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

/**
 * Splits [from, to] into sub-ranges, clipping any portion that overlaps a bridge run to
 * `min(subRangeEnd, maskTo)` — i.e. a bridge run never draws its deck ribbon past `maskTo`,
 * regardless of how far the caller's own `to` extends. Ground outside every bridge run is
 * returned unclipped. Ranges that clip to zero length are dropped. This is the mechanism behind
 * Task 22 deliverable 4: `constructionRenderer.ts` reports `maskTo` as the crane settles each deck
 * segment, and this guarantees the ribbon can never render ahead of (or leave a gap behind) that
 * settled point, no matter which stage/pending-progress split `buildStageSegment` is mid-way
 * through.
 */
function clipRangesForBridgeMask(
  samples: RoadSample[],
  from: number,
  to: number,
  maskTo: number,
): Array<{ from: number; to: number }> {
  const runs = findBridgeRuns(samples);
  if (!runs.length) return [{ from, to }];

  const out: Array<{ from: number; to: number }> = [];
  let cursor = from;
  // Process runs in order; between/around them the range passes through unmodified.
  for (const run of runs) {
    const runFrom = Math.max(run.fromDist, from);
    const runTo = Math.min(run.toDist, to);
    if (runTo <= runFrom) continue; // this run doesn't overlap [from, to] at all

    if (cursor < runFrom) out.push({ from: cursor, to: runFrom });
    const clippedRunTo = Math.min(runTo, maskTo);
    if (clippedRunTo > runFrom) out.push({ from: runFrom, to: clippedRunTo });
    cursor = runTo;
  }
  if (cursor < to) out.push({ from: cursor, to });
  return out;
}

/** Pylon stations for a single run, spaced BRIDGE_PYLON_SPACING apart starting at the run's own
 * start — identical stepping logic to `buildBridgeParts`'s pylon loop (kept in sync deliberately;
 * `buildBridgeParts` now calls this instead of re-deriving its own copy). */
function pylonStationsFor(run: BridgeRun): number[] {
  const stations: number[] = [];
  const runLen = run.toDist - run.fromDist;
  const count = Math.max(1, Math.floor(runLen / BRIDGE_PYLON_SPACING) + 1);
  for (let k = 0; k <= count; k++) {
    const d = run.fromDist + Math.min(runLen, k * BRIDGE_PYLON_SPACING);
    if (d > run.toDist) break;
    stations.push(d);
    if (d >= run.toDist) break;
  }
  return stations;
}

/**
 * Per-edge bridge-run metadata (Task 22 deliverable 1): every contiguous bridge-flagged sample run
 * on this edge, expressed as an arclength span plus its pylon stations. Read-only/stateless — pure
 * geometry derived from `samples.bridge`, with no side effects and no change to what
 * `buildBridgeParts` itself renders.
 */
export function getBridgeRunInfo(samples: RoadSample[]): BridgeRunInfo[] {
  return findBridgeRuns(samples).map((run) => ({
    fromDist: run.fromDist,
    toDist: run.toDist,
    pylonStations: pylonStationsFor(run),
  }));
}

/**
 * `offsetStrength` selects the polygon-offset bias applied toward the camera:
 *  - 'none'    — no offset (thin/decorative geometry that doesn't fight the terrain/ribbon).
 *  - 'ribbon'  — the full-width stage ribbons (graded/gravel/paved/painted), factor/units -2.
 *  - 'stripe'  — the painted centerline dashes: stronger than 'ribbon' (-4/-4) so the dashes
 *                reliably win the depth fight against BOTH the terrain and the asphalt ribbon
 *                sitting just 0.06 world units below them (playtest fix: dashes were vanishing
 *                at distance because they had no offset at all and lost that fight once far
 *                enough from the camera for depth precision to matter).
 */
function makeStandardMaterial(
  color: string,
  opacity = 1,
  offsetStrength: 'none' | 'ribbon' | 'stripe' = 'none',
): THREE.MeshStandardMaterial {
  const offset = offsetStrength !== 'none';
  const magnitude = offsetStrength === 'stripe' ? -4 : offsetStrength === 'ribbon' ? -2 : 0;
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.9,
    transparent: opacity < 1,
    opacity,
    // The terrain grid (4u cells) is coarser than the road's sample spacing, so even
    // fully-graded terrain can interpolate slightly above the ribbon between grid vertices —
    // combined with the terrain renderer's throttled (100ms) normal/geometry recompute during
    // continuous deformation, this can flicker as faint ground bleed-through on the full-width
    // stage ribbons (graded/gravel/paved/painted). Bias the ribbon's depth toward the camera
    // (without changing any actual geometry heights) so it reliably draws on top. Survey dashes
    // don't need this and stay excluded via 'none'.
    polygonOffset: offset,
    polygonOffsetFactor: magnitude,
    polygonOffsetUnits: magnitude,
  });
}

interface PendingProgress {
  stage: Stage;
  t: number;
}

// --- Bridge construction theater (Task 22) ---------------------------------------------------
const PYLON_RISE_DURATION = 1.2; // seconds, easeOutCubic scale-Y 0->1 as the graded work front passes
const RAIL_SETTLE_DURATION = 0.4; // seconds, quick scale/position ease right after a span's deck settles
const BRIDGE_SPAN_LENGTH = BRIDGE_PYLON_SPACING; // deck "segments" for masking/rails match the 16u pylon spacing

/** Per-station pylon rise progress, keyed by a rounded arclength bucket (see `stationKey`) so it
 * survives the throttled `rebuild()` cycle instead of resetting to 0 every 0.15s. `startedAt` is
 * `null` until the graded work front first reaches the station; `elapsed` then counts up toward
 * `PYLON_RISE_DURATION` independent of how many rebuilds happen while it's rising. A demolition
 * (work front receding) sinks the pylon back down via the same `elapsed`, driven in reverse. */
interface PylonRiseState {
  elapsed: number; // 0..PYLON_RISE_DURATION, drives easeOutCubic scale-Y
  rising: boolean; // direction: true = animating toward risen, false = sinking back to 0
}

/** Per-span (16u bucket within a bridge run) rail settle progress — mirrors `PylonRiseState` but
 * keyed per-span rather than per-pylon-station, since rails settle with each deck segment landing,
 * not with the (differently-timed) graded work front. */
interface RailSettleState {
  elapsed: number; // 0..RAIL_SETTLE_DURATION
  settled: boolean; // true once this span's deck has been reported settled by constructionRenderer
}

function stationKey(edgeId: number, station: number): string {
  return `${edgeId}:${Math.round(station * 4)}`; // quarter-unit buckets, plenty precise for a fixed pylon spacing
}

function spanKey(edgeId: number, runFromDist: number, spanIndex: number): string {
  return `${edgeId}:${Math.round(runFromDist * 4)}:${spanIndex}`;
}

interface EdgeVisual {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  lastRebuildAt: number;
  pending: PendingProgress | null;
  freshAsphaltAt: number | null; // performance.now()/1000-style seconds when 'paved' stage began, or null
  gradedT: number; // latest reported graded-stage arclength (drives pylon rise); 0 if never graded
  gradedDemolish: boolean; // latest graded progress event's demolish flag (sinks pylons in reverse)
  bridgeMaskTo: number | null; // arclength (edge-absolute) the deck/rails may draw up to within bridge
                               // runs; null = no masking (unaffected — e.g. edge has no active gravel job)
}

export class RoadRenderer {
  private visuals = new Map<number, EdgeVisual>();
  private clockSeconds = 0;

  // Bridge construction theater (Task 22): persisted per-station/per-span animation state that
  // survives the throttled `rebuild()` cycle (see PylonRiseState/RailSettleState doc comments).
  private pylonRise = new Map<string, PylonRiseState>();
  private railSettle = new Map<string, RailSettleState>();

  constructor(
    private scene: THREE.Scene,
    private graph: RoadGraph,
    bus: EventBus,
    private hf: Heightfield,
  ) {
    bus.on('roads:edgeAdded', ({ edgeId }) => this.onEdgeAdded(edgeId));
    bus.on('roads:edgeRemoved', ({ edgeId }) => this.disposeEdge(edgeId));
    bus.on('construction:stage', ({ edgeId, stage }) => this.onStage(edgeId, stage));
    bus.on('construction:progress', ({ edgeId, stage, t, demolish }) => this.onProgress(edgeId, stage, t, demolish));
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
    // Bug fix (Task 22 critical finding): `ensureVisual`'s `gradedT` seed
    // (`edge.stage === 'surveyed' ? 0 : edge.length`) can never actually fire from anything but 0,
    // because `ensureVisual` is always first reached via `roads:edgeAdded`, which fires inside
    // `commitChain` while `edge.stage` is unconditionally still `'surveyed'` — including during
    // `restoreWorld`, which commits the chain FIRST and only forces `edge.stage` (then emits this
    // very `construction:stage` event) afterward. Left alone, a restored bridge at gravel-or-later
    // permanently renders with zero pylons (the "already past graded" branch in `ensureVisual` is
    // dead code). Heal it here instead: once this edge's stage reaches 'graded' or later, seed
    // `gradedT` to the full edge length and mark every pylon-rise entry for this edge as fully risen
    // BEFORE `rebuild()` below reads them. This runs on every `construction:stage` emit, not just
    // restore's, but that's harmless — by the time a normal build reaches a real stage-completion
    // event, `onProgress`'s per-station tracking already drove `gradedT`/`pylonRise` to the same
    // "fully risen" values, so this is a no-op there. Fresh-draw rise animation is untouched: it's
    // driven entirely by `construction:progress` events via `onProgress`/`advanceBridgeEases`, which
    // this handler never touches.
    if (STAGES.indexOf(stage) >= STAGES.indexOf('graded')) {
      const vv = this.ensureVisual(edge);
      vv.gradedT = edge.length;
      vv.gradedDemolish = false;
      const runs = getBridgeRunInfo(edge.samples);
      for (const run of runs) {
        for (const station of run.pylonStations) {
          const key = stationKey(edgeId, station);
          this.pylonRise.set(key, { elapsed: PYLON_RISE_DURATION, rising: true });
        }
      }
    }
    this.rebuild(edge);
  }

  private onProgress(edgeId: number, stage: Stage, t: number, demolish: boolean): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const v = this.ensureVisual(edge);
    v.pending = { stage, t };
    if (stage === 'graded') {
      // Pylon rise (deliverable 2) is driven by the graded-stage work front specifically, tracked
      // independent of `pending` so it isn't cleared/reset by a later stage's progress events.
      v.gradedT = t;
      v.gradedDemolish = demolish;
    }
  }

  private ensureVisual(edge: RoadEdge): EdgeVisual {
    let v = this.visuals.get(edge.id);
    if (!v) {
      const group = new THREE.Group();
      group.userData.edgeId = edge.id;
      this.scene.add(group);
      v = {
        group,
        meshes: [],
        lastRebuildAt: -Infinity,
        pending: null,
        freshAsphaltAt: edge.stage === 'paved' || edge.stage === 'painted' ? this.clockSeconds : null,
        gradedT: edge.stage === 'surveyed' ? 0 : edge.length, // already past graded => pylons fully risen
        gradedDemolish: false,
        bridgeMaskTo: null,
      };
      this.visuals.set(edge.id, v);
    }
    return v;
  }

  /**
   * Bridge deck/rail masking hook (Task 22 deliverable 4): `constructionRenderer.ts` calls this as
   * its crane choreography settles each 16u deck segment during the gravel stage, reporting how far
   * (edge-absolute arclength) the deck may now be drawn within this edge's bridge run(s).
   * `settledTo === null` clears masking entirely (deck/rails draw exactly like the existing
   * partial-progress split, unaffected — e.g. once the job leaves 'gravel' and moves on to
   * 'paved'/'painted', the whole run is by definition already settled and behaves exactly as
   * before Task 22). Marks the edge dirty for the next throttled rebuild rather than forcing an
   * immediate one, per the binding spec's "coordinate with the rebuild-throttle."
   */
  setBridgeMask(edgeId: number, settledTo: number | null): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const v = this.ensureVisual(edge);
    if (v.bridgeMaskTo === settledTo) return;
    v.bridgeMaskTo = settledTo;
    // Force a rebuild eagerly the same way onStage does for a real stage transition — masking
    // changes need to track the crane's per-frame settle progress closely enough to read as a
    // continuous descent, not just whatever the unrelated pending-progress throttle happens to do.
    if (this.clockSeconds - v.lastRebuildAt >= REBUILD_THROTTLE) {
      this.rebuild(edge);
    }
  }

  /** Marks span `spanIndex` of the bridge run starting at `runFromDist` on `edgeId` as settled
   * (deliverable 5's "rails appear with a quick settle right after their segment lands"). Called by
   * `constructionRenderer.ts` at the exact moment a deck segment finishes its descent+bounce. */
  markSpanSettled(edgeId: number, runFromDist: number, spanIndex: number): void {
    const key = spanKey(edgeId, runFromDist, spanIndex);
    let s = this.railSettle.get(key);
    if (!s) {
      s = { elapsed: 0, settled: false };
      this.railSettle.set(key, s);
    }
    s.settled = true;
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
      this.buildStageSegment(v, samples, stage, 0, clampedT, /* advancing */ true);
      if (prev) this.buildStageSegment(v, samples, prev, clampedT, length);
      else this.buildStageSegment(v, samples, 'surveyed', clampedT, length);
    } else {
      this.buildStageSegment(v, samples, edge.stage, 0, length);
    }

    // Deliverable 4/5 gating: rails/pylons must never appear before this edge's construction has
    // actually reached a stage where a deck could plausibly exist. `edge.stage` is the graph's own
    // persisted "fully completed through" marker; `v.pending`'s stage (if any) is the *currently
    // in-progress* stage, which for a live 'gravel' job on a bridge run is exactly when the crane
    // choreography (bridgeMaskTo) is the authority instead. A `'surveyed'`/`'graded'` edge with no
    // pending progress at gravel-or-later has no deck at all yet, so nothing should render (a fresh
    // `commitChain` immediately calling `rebuild()` was previously showing full-height rails/pylons
    // on a brand-new, not-yet-built bridge — this flag fixes that).
    const pendingStage = v.pending?.stage;
    const deckStageReached =
      STAGES.indexOf(edge.stage) >= STAGES.indexOf('gravel') ||
      (pendingStage !== undefined && STAGES.indexOf(pendingStage) >= STAGES.indexOf('gravel'));
    this.buildBridgeParts(v, samples, edge.id, deckStageReached);
  }

  /**
   * Renders the appearance for `stage` across arclength [from, to] on this edge. `advancing` is
   * true only for the actively-growing partial segment of an in-progress job (i.e. the [0,
   * clampedT] call from `rebuild()`'s `v.pending` branch) — for 'paved', this additionally splits
   * the segment at the roller's trailing position so already-compacted asphalt reads slightly
   * darker than the freshly-laid strip still ahead of the roller. A fully-`paved` edge with no
   * pending progress (the `else` branch in `rebuild()`) always renders uniformly, since there's no
   * roller actively working it anymore.
   *
   * Bridge deck masking (Task 22 deliverable 4): for stage 'gravel' or later (the stages that
   * represent an actual deck surface, as opposed to 'graded' dirt/formwork), any sub-range that
   * falls inside a bridge run is additionally clipped to `v.bridgeMaskTo` when masking is active —
   * see `clipRangeForBridgeMask`. This never touches non-bridge ground.
   */
  private buildStageSegment(v: EdgeVisual, samples: RoadSample[], stage: Stage, from: number, to: number, advancing = false): void {
    if (to <= from) return;
    if (stage === 'surveyed') {
      const geo = buildDashedRibbonGeometry(samples, SURVEY_WIDTH, STAGE_YLIFT.surveyed, from, to, 2);
      const mat = makeStandardMaterial(STAGE_COLOR.surveyed, SURVEY_OPACITY);
      this.addMesh(v, geo, mat);
      return;
    }

    const deckStage = stage === 'gravel' || stage === 'paved' || stage === 'painted';
    const ranges = deckStage && v.bridgeMaskTo !== null
      ? clipRangesForBridgeMask(samples, from, to, v.bridgeMaskTo)
      : [{ from, to }];

    for (const range of ranges) {
      this.buildStageRange(v, samples, stage, range.from, range.to, advancing);
    }
  }

  /** The unclipped per-range body of `buildStageSegment` (see there for the masking wrapper). */
  private buildStageRange(v: EdgeVisual, samples: RoadSample[], stage: Stage, from: number, to: number, advancing: boolean): void {
    if (to <= from) return;

    if (stage === 'paved' && advancing) {
      // Roller trails the paver by ROLLER_TRAIL_DISTANCE (see constructionRenderer.ts): everything
      // it's already passed over ([from, rollerT]) is fully compacted (darker); the strip between
      // the roller and the paver's leading edge ([rollerT, to]) is freshly laid, still the normal
      // paved color.
      const rollerT = Math.max(from, to - ROLLER_TRAIL_DISTANCE);
      if (rollerT > from) {
        const compactedGeo = buildRibbonGeometry(samples, ROAD_WIDTH, STAGE_YLIFT.paved, from, rollerT);
        const compactedMat = makeStandardMaterial(PAVED_COMPACTED_COLOR, 1, 'ribbon');
        this.addMesh(v, compactedGeo, compactedMat);
      }
      if (rollerT < to) {
        const freshGeo = buildRibbonGeometry(samples, ROAD_WIDTH, STAGE_YLIFT.paved, rollerT, to);
        const freshMat = makeStandardMaterial(STAGE_COLOR.paved, 1, 'ribbon');
        freshMat.roughness = 0.35; // fresh asphalt sheen start; advanced in update()
        const freshMesh = this.addMesh(v, freshGeo, freshMat);
        freshMesh.userData.freshAsphalt = true;
      }
      return;
    }

    const yLift = STAGE_YLIFT[stage];
    const color = STAGE_COLOR[stage];
    const geo = buildRibbonGeometry(samples, ROAD_WIDTH, yLift, from, to);
    const mat = makeStandardMaterial(color, 1, 'ribbon');
    const mesh = this.addMesh(v, geo, mat);
    if (stage === 'paved' || stage === 'painted') {
      mat.roughness = 0.35; // fresh asphalt sheen start; advanced in update()
      mesh.userData.freshAsphalt = true;
    }

    if (stage === 'painted') {
      const dashGeo = buildDashedRibbonGeometry(samples, CENTERLINE_WIDTH, CENTERLINE_YLIFT, from, to, 2);
      const dashMat = makeStandardMaterial(CENTERLINE_COLOR, 1, 'stripe');
      this.addMesh(v, dashGeo, dashMat);
    }
  }

  /**
   * Pure read of currently-persisted pylon-rise/rail-settle state (both in `this.pylonRise`/
   * `this.railSettle`, keyed per-station/per-span so they survive being rebuilt from scratch every
   * throttled `rebuild()` call — see those maps' doc comments); does not itself advance either
   * timer. Time advancement is `advanceBridgeEases`'s sole job, called once per frame from
   * `update()` regardless of whether a geometry rebuild happens to land that same frame.
   *
   * `deckStageReached` (see `rebuild()`) is true once this edge's construction has actually reached
   * 'gravel' or later, either as its persisted `edge.stage` or its currently in-progress pending
   * stage. It gates the "no crane choreography has ever touched this span" default: a span with no
   * `railSettle` entry defaults to hidden unless `deckStageReached` — otherwise a brand-new
   * `'surveyed'`/`'graded'` edge (whose bridge run has no masking info yet simply because no gravel
   * job has started) would show fully-built rails floating over a deck that doesn't exist yet.
   */
  private buildBridgeParts(v: EdgeVisual, samples: RoadSample[], edgeId: number, deckStageReached: boolean): void {
    const runs = findBridgeRuns(samples);
    if (!runs.length) return;

    const pts = cumulativeDistances(samples);

    for (const run of runs) {
      const runLen = run.toDist - run.fromDist;
      const spanCount = Math.max(1, Math.ceil(runLen / BRIDGE_SPAN_LENGTH));

      // Rails (deliverable 5): built per-span (rather than one box for the whole run) so each
      // span's rail can settle in independently, right after that span's deck segment lands.
      // A span with no settle info yet defaults to "already settled" ONLY once `deckStageReached`
      // — this covers a fully 'paved'/'painted' edge rebuilt with no pending progress (see
      // `rebuild()`'s `else` branch), which has no crane sequence driving settle state at all and
      // must render every span at full scale unconditionally. Before gravel work has ever reached
      // this run, every span defaults to hidden instead.
      for (let spanIdx = 0; spanIdx < spanCount; spanIdx++) {
        const spanFrom = run.fromDist + spanIdx * BRIDGE_SPAN_LENGTH;
        const spanTo = Math.min(run.toDist, spanFrom + BRIDGE_SPAN_LENGTH);
        if (spanTo <= spanFrom) continue;

        const key = spanKey(edgeId, run.fromDist, spanIdx);
        let settleState = this.railSettle.get(key);
        const stillMasking = v.bridgeMaskTo !== null;
        if (!settleState) {
          // No crane choreography has ever reported this span. If masking is actively in effect,
          // fall back to the mask boundary (spans already behind it default settled, matching the
          // deck ribbon that's already showing there); otherwise fall back to `deckStageReached` —
          // fully settled for an edge whose deck genuinely already exists (paved/painted, no live
          // crane), hidden for one that hasn't even started gravel work yet.
          const settled = stillMasking ? spanFrom < (v.bridgeMaskTo ?? 0) : deckStageReached;
          settleState = { elapsed: settled ? RAIL_SETTLE_DURATION : 0, settled };
          this.railSettle.set(key, settleState);
        }
        const settleU = easeOutCubic(clamp01(settleState.elapsed / RAIL_SETTLE_DURATION));
        if (settleU <= 0.001) continue; // not settled yet — no rail drawn (deliverable 4/5 coordination)

        const railOffset = ROAD_WIDTH / 2 - 0.2;
        for (const side of [-1, 1]) {
          const railGeo = buildRailBoxGeometry(
            samples,
            side * railOffset,
            BRIDGE_RAIL_WIDTH,
            BRIDGE_RAIL_HEIGHT,
            STAGE_YLIFT.paved,
            spanFrom,
            spanTo,
          );
          const railMat = makeStandardMaterial(BRIDGE_COLOR);
          const mesh = this.addMesh(v, railGeo, railMat);
          // Quick settle: scale up from the deck (Y=STAGE_YLIFT.paved) rather than from the true
          // origin, so the rail appears to rise out of the deck surface itself.
          mesh.position.y = STAGE_YLIFT.paved;
          mesh.scale.y = Math.max(0.001, settleU);
          mesh.position.y -= STAGE_YLIFT.paved * mesh.scale.y; // keep the deck-level face anchored
        }
      }

      // pylons every BRIDGE_PYLON_SPACING along the run (deliverable 2: scale-Y rise as the
      // graded-stage work front passes each station).
      const stations = pylonStationsFor(run);
      for (const d of stations) {
        const p = samplePointAt(pts, d);
        const groundY = this.hf.heightAt(p.x, p.z);
        const deckY = p.y;
        const pylonHeight = Math.max(0.1, deckY - groundY);

        const key = stationKey(edgeId, d);
        let riseState = this.pylonRise.get(key);
        if (!riseState) {
          // First time this station has ever been rendered: if the graded work front has already
          // passed it (gradedT >= d) treat it as already fully risen (covers edges restored/loaded
          // mid-or-post-build, where there was never a live progress event to trigger the rise);
          // otherwise start at 0 and let `update()` grow it once the front reaches this station.
          const alreadyPassed = v.gradedT >= d;
          riseState = { elapsed: alreadyPassed ? PYLON_RISE_DURATION : 0, rising: alreadyPassed };
          this.pylonRise.set(key, riseState);
        }
        const riseU = easeOutCubic(clamp01(riseState.elapsed / PYLON_RISE_DURATION));
        if (riseU <= 0.001) continue; // hasn't started rising yet — nothing to draw

        const cyl = new THREE.CylinderGeometry(BRIDGE_PYLON_RADIUS, BRIDGE_PYLON_RADIUS, pylonHeight, 8);
        cyl.translate(0, pylonHeight / 2, 0); // pivot at the base so scale-Y grows upward from the ground
        const mat = makeStandardMaterial(BRIDGE_COLOR);
        const mesh = this.addMesh(v, cyl, mat);
        mesh.position.set(p.x, groundY, p.z);
        mesh.scale.y = Math.max(0.001, riseU);
      }
    }
  }

  /**
   * Advances every persisted pylon-rise/rail-settle ease timer whose animation is in flight, for
   * every currently-tracked edge — called once per frame from `update()` so the eases progress in
   * real time regardless of whether/when the next throttled geometry rebuild happens to land. A
   * timer reaching its target duration exactly at the moment a mesh visually needs to update its
   * scale relies on the next `rebuild()` (triggered either by the normal progress throttle, by
   * `setBridgeMask`, or — as a fallback — this method's own trigger below) to actually apply it.
   */
  private advanceBridgeEases(dt: number): void {
    for (const [edgeId, v] of this.visuals) {
      const edge = this.graph.edges.get(edgeId);
      if (!edge) continue;
      let touched = false;

      // Pylon rise: grow toward risen for every station at/behind the current graded work front
      // (or sink back toward 0 during a demolish's receding front), independent of any bridgeMask.
      const runs = getBridgeRunInfo(edge.samples);
      for (const run of runs) {
        for (const station of run.pylonStations) {
          const key = stationKey(edgeId, station);
          let s = this.pylonRise.get(key);
          const shouldRise = v.gradedDemolish ? v.gradedT > station : v.gradedT >= station;
          if (!s) {
            if (!shouldRise) continue;
            s = { elapsed: 0, rising: true };
            this.pylonRise.set(key, s);
          }
          const targetElapsed = shouldRise ? PYLON_RISE_DURATION : 0;
          if (s.elapsed === targetElapsed) continue;
          s.rising = shouldRise;
          s.elapsed = shouldRise
            ? Math.min(PYLON_RISE_DURATION, s.elapsed + dt)
            : Math.max(0, s.elapsed - dt);
          touched = true;
        }
      }

      // Rail settle: once a span is marked settled (`markSpanSettled`, called by
      // constructionRenderer.ts as the crane's descent+bounce for that segment completes), ease its
      // rail scale up over RAIL_SETTLE_DURATION. Spans never un-settle (no reverse case here —
      // demolition's reverse teardown is a simple fade per the binding spec, handled entirely by
      // constructionRenderer's crane-less reverse path + this same rail geometry just disappearing
      // via the normal partial-progress split once the mask recedes past it).
      for (const run of runs) {
        const spanCount = Math.max(1, Math.ceil((run.toDist - run.fromDist) / BRIDGE_SPAN_LENGTH));
        for (let spanIdx = 0; spanIdx < spanCount; spanIdx++) {
          const key = spanKey(edgeId, run.fromDist, spanIdx);
          const s = this.railSettle.get(key);
          if (!s || !s.settled || s.elapsed >= RAIL_SETTLE_DURATION) continue;
          s.elapsed = Math.min(RAIL_SETTLE_DURATION, s.elapsed + dt);
          touched = true;
        }
      }

      if (touched && this.clockSeconds - v.lastRebuildAt >= REBUILD_THROTTLE) {
        this.rebuild(edge);
      }
    }
  }

  private disposeEdge(edgeId: number): void {
    const v = this.visuals.get(edgeId);
    if (!v) return;
    this.clearMeshes(v);
    this.scene.remove(v.group);
    this.visuals.delete(edgeId);

    // Bridge theater state (Task 22) is keyed by a prefix containing this edgeId — drop every
    // entry for it so a demolished/removed edge doesn't leak entries forever (an edge's id is
    // never reused, so nothing else could ever collide with these keys anyway, but this keeps the
    // maps bounded by "edges that currently exist" rather than "every edge that ever existed").
    const prefix = `${edgeId}:`;
    for (const key of this.pylonRise.keys()) if (key.startsWith(prefix)) this.pylonRise.delete(key);
    for (const key of this.railSettle.keys()) if (key.startsWith(prefix)) this.railSettle.delete(key);
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

    // Bridge construction theater (Task 22): pylon-rise/rail-settle eases tick every frame,
    // independent of the (unrelated) pending-progress rebuild throttle above.
    this.advanceBridgeEases(dt);
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
