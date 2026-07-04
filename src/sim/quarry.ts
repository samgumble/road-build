import type { P2, RoadSample } from '../core/types';
import { EventBus } from '../core/events';
import { RoadGraph } from './roads/graph';
import { Heightfield } from './terrain/heightfield';
import { createRng } from '../core/rng';
import { WORLD_SIZE } from '../core/constants';

// Task 34: quarry landmark. One quarry per island, placed the moment the FIRST road ever commits.
// Placement is pure sim state (must survive save/load, see save.ts's `quarry` field) computed by a
// deterministic seeded search so a given seed + first-edge geometry always yields the exact same
// site, whether placed live on the first road commit or re-derived on load from an older save that
// predates this feature (same function, same inputs -> same output).

const HALF = WORLD_SIZE / 2;

const MIN_DIST_FROM_ROAD = 40; // u, from every sample of the triggering first edge
const FOOTPRINT_SLOPE_RADIUS = 10; // u, slope is checked across this footprint
const MAX_SLOPE = 0.25;
const COASTAL_SEARCH_RADIUS = 30; // u; prefer a site within this distance of a below-water cell
const COASTAL_SEARCH_STEP = 6; // u, ring-scan stride when probing for nearby water

// Candidate scan: a fixed seeded order over a grid across the island, coarser than wilderness's
// tree scan (a quarry is one sparse landmark, not hundreds of sites) but still fine enough to find
// a qualifying coastal cell reliably.
const SCAN_STRIDE = 12; // u

/** True if every scanned point across a FOOTPRINT_SLOPE_RADIUS-ish footprint around (x,z) is
 * land and shallow enough. Mirrors the "10u footprint" wording in the spec: sample the center plus
 * four cardinal offsets at the radius, rather than just the single center point, so a site whose
 * center is flat but whose edge dips into water/steep terrain is rejected. */
function footprintQualifies(hf: Heightfield, x: number, z: number): boolean {
  const offsets: P2[] = [
    { x: 0, z: 0 },
    { x: FOOTPRINT_SLOPE_RADIUS, z: 0 },
    { x: -FOOTPRINT_SLOPE_RADIUS, z: 0 },
    { x: 0, z: FOOTPRINT_SLOPE_RADIUS },
    { x: 0, z: -FOOTPRINT_SLOPE_RADIUS },
  ];
  for (const o of offsets) {
    const px = x + o.x, pz = z + o.z;
    if (!hf.isLand(px, pz)) return false;
    if (hf.slopeAt(px, pz) > MAX_SLOPE) return false;
  }
  return true;
}

/** True if (x,z) has a below-water (non-land) cell within COASTAL_SEARCH_RADIUS — a coarse ring
 * scan, cheap enough to run per-candidate since candidates are sparse (SCAN_STRIDE=12u grid). */
function isCoastalAdjacent(hf: Heightfield, x: number, z: number): boolean {
  for (let r = COASTAL_SEARCH_STEP; r <= COASTAL_SEARCH_RADIUS; r += COASTAL_SEARCH_STEP) {
    const steps = Math.max(8, Math.round((2 * Math.PI * r) / COASTAL_SEARCH_STEP));
    for (let i = 0; i < steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      if (!hf.isLand(px, pz)) return true;
    }
  }
  return false;
}

/** Minimum distance from (x,z) to any of the triggering edge's samples. */
function distToSamples(x: number, z: number, samples: ReadonlyArray<RoadSample>): number {
  let best = Infinity;
  for (const s of samples) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < best) best = d;
  }
  return best;
}

export interface QuarryPlacement {
  x: number;
  z: number;
  rot: number;
}

/**
 * Deterministic seeded search for a suitable quarry site, run once when the first road ever
 * commits. Scans candidates in a fixed seeded order (a shuffled grid over the island, stride
 * SCAN_STRIDE) and takes the FIRST one that qualifies: land + low slope over a ~10u footprint,
 * >= MIN_DIST_FROM_ROAD from every sample of the triggering edge, and coastal-adjacent (within
 * COASTAL_SEARCH_RADIUS of a below-water cell). If nothing qualifies (e.g. a small/landlocked
 * island), falls back to the nearest flat land cell >= MIN_DIST_FROM_ROAD away, ignoring the
 * coastal preference. Same `seed` + same first edge samples always produce the same result.
 */
export function placeQuarry(
  hf: Heightfield,
  firstEdgeSamples: ReadonlyArray<RoadSample>,
  seed: string,
): QuarryPlacement | null {
  const rng = createRng(seed);

  // Build the fixed candidate grid, then shuffle it deterministically (Fisher-Yates driven by the
  // seeded rng) so "scan candidates in a fixed seeded order" is satisfied without candidate order
  // depending on iteration order of anything else.
  const candidates: P2[] = [];
  for (let gz = -HALF; gz <= HALF; gz += SCAN_STRIDE) {
    for (let gx = -HALF; gx <= HALF; gx += SCAN_STRIDE) {
      candidates.push({ x: gx, z: gz });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let fallback: (P2 & { dist: number }) | null = null;

  for (const c of candidates) {
    if (!footprintQualifies(hf, c.x, c.z)) continue;
    const dist = distToSamples(c.x, c.z, firstEdgeSamples);
    if (dist < MIN_DIST_FROM_ROAD) continue;

    // Track the nearest flat/land/distance-qualifying cell as a fallback in case nothing is also
    // coastal-adjacent.
    if (!fallback || dist < fallback.dist) fallback = { x: c.x, z: c.z, dist };

    if (isCoastalAdjacent(hf, c.x, c.z)) {
      const rot = rng() * Math.PI * 2;
      return { x: c.x, z: c.z, rot };
    }
  }

  if (fallback) {
    const rot = rng() * Math.PI * 2;
    return { x: fallback.x, z: fallback.z, rot };
  }

  return null; // no qualifying land at all (shouldn't happen on a real island, but stay defensive)
}

/**
 * Places the quarry exactly once, on the FIRST road commit ever (listens for the first
 * `roads:edgeAdded`, then detaches). Emits an additive `quarry:placed {x,z,rot}` event when
 * placement succeeds. `placement` is exposed for save serialization; `restore()` lets save.ts seed
 * an already-placed quarry back in without re-triggering placement or a duplicate event on the
 * next `roads:edgeAdded` (which restoreWorld's replayed edges would otherwise fire).
 */
export class QuarrySim {
  private _placement: QuarryPlacement | null = null;
  private armed = true; // becomes false once a quarry exists (placed or restored) — never re-fires
  private unsubscribe: (() => void) | null = null;

  constructor(
    private hf: Heightfield,
    private graph: RoadGraph,
    private bus: EventBus,
    private seed: string,
  ) {
    this.unsubscribe = this.bus.on('roads:edgeAdded', (e) => this.onEdgeAdded(e.edgeId));
  }

  get placement(): QuarryPlacement | null {
    return this._placement;
  }

  /** Seeds an already-known placement (from a save) without emitting `quarry:placed` and disarms
   * further auto-placement. */
  restore(placement: QuarryPlacement | null): void {
    if (placement) {
      this._placement = placement;
      this.disarm();
    }
  }

  private disarm(): void {
    this.armed = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onEdgeAdded(edgeId: number): void {
    if (!this.armed) return;
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    this.disarm(); // only ever the FIRST road commit gets to trigger this, success or not

    const placement = placeQuarry(this.hf, edge.samples, this.seed);
    if (!placement) return;
    this._placement = placement;
    this.bus.emit('quarry:placed', placement);
  }
}
