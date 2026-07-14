import type { Heightfield } from '../terrain/heightfield';
import { RoadGraph } from '../roads/graph';
import { EventBus } from '../../core/events';
import { createRng } from '../../core/rng';
import { ROAD_ENGINEERED_HALF_WIDTH, WORLD_SIZE } from '../../core/constants';
import { STAGES } from '../../core/types';

const GRADED_INDEX = STAGES.indexOf('graded');

const HALF = WORLD_SIZE / 2;

// Ambient wilderness (Task 31): a sparse, seeded scatter of trees across the island, generated
// once at boot from the same seed as the Heightfield and NEVER saved — it's derived state,
// regenerated deterministically on every load (see save.ts's doc comment). This is deliberately
// separate from GrowthSim's road-driven development trees: wilderness exists everywhere land
// allows, independent of roads, and is cleared (not grown) by construction.

const MAX_SLOPE = 0.5;

// Target density ~1 site per 250 u^2 of land. A pure Poisson-disc sampler is overkill for this —
// instead we scan the island on a grid whose stride matches that target density (so a full,
// unrejected grid would land almost exactly the right count), jitter each candidate within its
// cell for a natural (non-grid-aligned) look, and reject any candidate too close to an already
// accepted site. Land/slope-gated candidates are rejected before ever touching the spatial hash.
const TARGET_DENSITY_AREA = 250; // u^2 per site
const STRIDE = Math.sqrt(TARGET_DENSITY_AREA); // ~15.8u
const MIN_SPACING = 10; // u, minimum distance between accepted sites
const JITTER = STRIDE * 0.5; // u, candidate jitter within its grid cell

const SITE_TREE_MIN = 1;
const SITE_TREE_MAX = 3; // inclusive

export interface WildernessTree {
  x: number;
  z: number;
  rot: number;
  count: number; // 1-3 trees clustered at this site
}

/** Spatial hash over accepted sites so a MIN_SPACING rejection check stays O(1) amortized instead
 * of O(n) per candidate (which would make the whole scan O(n^2) over several hundred sites). */
class SpatialHash {
  private cellSize: number;
  private buckets = new Map<string, { x: number; z: number }[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }

  private cellOf(x: number, z: number): [number, number] {
    return [Math.floor(x / this.cellSize), Math.floor(z / this.cellSize)];
  }

  /** True if any existing point lies within `minDist` of (x, z). */
  hasNeighborWithin(x: number, z: number, minDist: number): boolean {
    const [ci, cj] = this.cellOf(x, z);
    const reach = Math.ceil(minDist / this.cellSize);
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const bucket = this.buckets.get(this.key(ci + di, cj + dj));
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.hypot(p.x - x, p.z - z) < minDist) return true;
        }
      }
    }
    return false;
  }

  insert(x: number, z: number): void {
    const [ci, cj] = this.cellOf(x, z);
    const k = this.key(ci, cj);
    let bucket = this.buckets.get(k);
    if (!bucket) { bucket = []; this.buckets.set(k, bucket); }
    bucket.push({ x, z });
  }
}

/**
 * Generates a deterministic scatter of wilderness tree sites across the island: seeded RNG, a
 * grid-stride candidate scan (stride tuned to the target density) with per-candidate jitter for a
 * natural look, land-only + slope-gated, and a spatial-hash-accelerated rejection so no accepted
 * site sits within MIN_SPACING of another. Same `seed` always produces the exact same result
 * (deep-equal), independent of any other world state — this is pure worldgen, not tied to roads.
 */
export function generateWilderness(hf: Heightfield, seed: string): WildernessTree[] {
  const rng = createRng(seed);
  const hash = new SpatialHash(MIN_SPACING);
  const sites: WildernessTree[] = [];

  for (let gz = -HALF; gz <= HALF; gz += STRIDE) {
    for (let gx = -HALF; gx <= HALF; gx += STRIDE) {
      const x = gx + (rng() * 2 - 1) * JITTER;
      const z = gz + (rng() * 2 - 1) * JITTER;

      if (!hf.isLand(x, z)) continue;
      if (hf.slopeAt(x, z) > MAX_SLOPE) continue;
      if (hash.hasNeighborWithin(x, z, MIN_SPACING)) continue;

      hash.insert(x, z);
      const rot = rng() * Math.PI * 2;
      const count = SITE_TREE_MIN + Math.floor(rng() * (SITE_TREE_MAX - SITE_TREE_MIN + 1));
      sites.push({ x, z, rot, count: Math.min(SITE_TREE_MAX, count) });
    }
  }

  return sites;
}

// Trees within this distance of any non-bridge road sample are cleared as the excavator's
// corridor passes through: half the road width plus a small margin so trees flanking the ribbon
// (not just directly on the centerline) get cleared too.
const CLEAR_RADIUS = ROAD_ENGINEERED_HALF_WIDTH;

/**
 * Tracks which generated wilderness trees are still "active" (not yet cleared by road
 * construction). Listens for `construction:stage` reaching `'graded'` on any edge and clears every
 * active tree within CLEAR_RADIUS of one of that edge's non-bridge samples — deterministic given
 * the same build order, since it only depends on the graph's sample positions at the moment an
 * edge reaches graded. Emits `wilderness:cleared` with the indices (into the ORIGINAL trees array
 * passed to the constructor) that were just cleared, so the renderer can fade exactly those
 * instances out.
 */
export class WildernessSim {
  private cleared: boolean[];
  /** Per-edge arclength the grading front has already swept (progressive clearing) — samples at
   * or before this station were checked once and never need rescanning. */
  private sweptTo = new Map<number, number>();

  constructor(
    private trees: ReadonlyArray<WildernessTree>,
    private bus: EventBus,
    private graph: RoadGraph,
  ) {
    this.cleared = new Array(trees.length).fill(false);
    // Progressive clearing (player request "trees are removed during the step after surveying"):
    // trees fall AS the excavator's grading front passes them, not all at once when the whole
    // stage completes. Demolition progress never fells trees.
    this.bus.on('construction:progress', (e) => {
      if (e.demolish || e.stage !== 'graded') return;
      this.clearCorridor(e.edgeId, e.t);
    });
    this.bus.on('construction:stage', (e) => {
      // A LIVE build always fires a discrete 'graded' transition exactly once as the excavator
      // finishes that stage. But a RESTORED edge (save.ts's restoreWorld) force-sets `edge.stage`
      // directly to whatever stage it was saved at and re-emits `construction:stage` with THAT
      // stage — which may be 'gravel', 'paved', or 'painted' if the save happened well past
      // grading, never a literal 'graded' event. Any of those stages implies grading already
      // happened, so the corridor must still clear; 'removed' and 'surveyed' do not. With the
      // progressive listener above this is the tail sweep + the restore path.
      if (e.stage === 'removed') {
        this.sweptTo.delete(e.edgeId);
        return;
      }
      if (STAGES.indexOf(e.stage) < GRADED_INDEX) return;
      this.clearCorridor(e.edgeId);
    });
  }

  /** Trees not yet cleared, COMPACTED into a fresh array — this list's own index position is NOT
   * stable across the tree's lifetime: clearing site 5 out of [0,1,2,3,4,5,6] shifts every tree
   * after it down by one in the array this getter returns. `wilderness:cleared`'s `indices` payload
   * always refers to the ORIGINAL (constructor-order) index, which this compacted view does not
   * preserve — a consumer that needs to correlate a later `wilderness:cleared` index against
   * whatever it rendered from `active` (e.g. after a restore that pre-cleared >= 1 site) will
   * misindex. Use `activeWithIndex` instead for anything that needs to stay correlated with
   * `wilderness:cleared` (see `SceneryRenderer.setWilderness`, Critical 2 of the Groundwork round
   * fix wave). Kept only for callers that truly don't care about later clears (there are none left
   * in this codebase as of that fix, but the getter is harmless to keep for tests/diagnostics). */
  get active(): ReadonlyArray<WildernessTree> {
    const out: WildernessTree[] = [];
    for (let i = 0; i < this.trees.length; i++) if (!this.cleared[i]) out.push(this.trees[i]);
    return out;
  }

  /** Trees not yet cleared, each paired with its ORIGINAL (constructor-order) index — the same
   * index space `wilderness:cleared`'s `indices` payload uses. This is the correct source for
   * anything that will later react to `wilderness:cleared` by index (Critical 2, Groundwork round
   * fix wave): unlike `active`'s compacted array, an entry's `originalIndex` here never shifts as
   * other sites clear, so a renderer seeded from this list (even one seeded AFTER some sites were
   * already cleared, e.g. by a restored save) stays correctly correlated with every subsequent
   * live clear. */
  get activeWithIndex(): ReadonlyArray<{ tree: WildernessTree; originalIndex: number }> {
    const out: { tree: WildernessTree; originalIndex: number }[] = [];
    for (let i = 0; i < this.trees.length; i++) {
      if (!this.cleared[i]) out.push({ tree: this.trees[i], originalIndex: i });
    }
    return out;
  }

  /** Minor 9 (Groundwork round fix wave, accepted design): clearing is one-directional. Once a
   * tree's index is marked `cleared`, nothing in this class ever un-marks it — demolishing the road
   * that cleared a corridor (edge stage walked back down to 'removed'/'surveyed') does NOT bring
   * its wilderness trees back. This is deliberate, not an oversight: wilderness is sparse, one-time
   * worldgen dressing rather than a resource meant to be farmed by build/demolish cycles, and
   * regrowing it would need tracking each tree's clearing edge and re-validating against whatever
   * else may have since built over that ground — real complexity for a look nobody asked for. */
  /** Clears active trees near the edge's non-bridge samples up to arclength `upTo` (the grading
   * front's position; Infinity = the whole corridor). Each (edge, sample) is swept at most once
   * via `sweptTo`, so per-tick progress events only ever test the newly passed stretch. */
  private clearCorridor(edgeId: number, upTo = Infinity): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const from = this.sweptTo.get(edgeId) ?? -1;
    if (upTo <= from) return;
    this.sweptTo.set(edgeId, upTo);

    const clearedIndices: number[] = [];
    let d = 0;
    for (let i = 0; i < edge.samples.length; i++) {
      if (i > 0) {
        d += Math.hypot(
          edge.samples[i].x - edge.samples[i - 1].x,
          edge.samples[i].z - edge.samples[i - 1].z,
        );
      }
      if (d > upTo) break;
      if (d <= from) continue; // already swept by an earlier progress event
      const s = edge.samples[i];
      if (s.bridge) continue;
      for (let t = 0; t < this.trees.length; t++) {
        if (this.cleared[t]) continue;
        const tree = this.trees[t];
        if (Math.hypot(s.x - tree.x, s.z - tree.z) <= CLEAR_RADIUS) {
          this.cleared[t] = true;
          clearedIndices.push(t);
        }
      }
    }

    if (clearedIndices.length) this.bus.emit('wilderness:cleared', { indices: clearedIndices });
  }
}
