import type { P2 } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { Heightfield } from '../terrain/heightfield';
import { GRID_SIZE, CELL, WORLD_SIZE, ROAD_WIDTH } from '../../core/constants';

const HALF = WORLD_SIZE / 2;

const RECOMPUTE_INTERVAL = 2; // sim-seconds, throttle for distance-field recompute on roads:changed
const MAX_ROAD_DIST_CELLS = 6; // ~24u; cells beyond this never accumulate development
// Tuned (Task 23) against user feedback that development felt "too eager": at a fresh road's
// closest ring (d=0) with the per-cell RATE_VARIANCE multiplier below, this rate lands first
// trees ~65-115s, first fields ~135-230s, first houses no sooner than ~230s (~3.8 sim-min), first
// buildings no sooner than ~320s (~5.4 sim-min) — measured by direct simulation, see the numbers
// documented alongside THRESHOLDS below. Previously 0.008, which put houses under 1.5 sim-min.
const DEV_RATE_BASE = 0.0026;
const DEV_RATE_DIST_DIVISOR = 7;
const MAX_SLOPE = 0.5;

// Per-cell multiplier applied to DEV_RATE_BASE, rolled once per cell the first time it starts
// accumulating (see `rateMult` below) and held fixed thereafter. Widens the range in
// DEV_RATE_BASE's doc comment from a single fixed pace into a spread of paces so neighboring
// cells along the same road don't cross thresholds in lockstep (previously every cell at a given
// distance-ring advanced identically, reading as a synchronized "wave" of development sweeping
// outward). +/-25% keeps the earliest/latest cells within the target windows while still visibly
// staggering which cell "wins" next.
const RATE_VARIANCE_MIN = 0.75;
const RATE_VARIANCE_MAX = 1.25;

const JITTER = 2.2; // u — wide enough relative to CELL (4u) that neighboring cells' trees don't line up into a hedge
// u, spawns are pushed away from road samples closer than this. House/building pads flatten a
// FLATTEN_RADIUS=5u circle (see sceneryRenderer.ts) around their spawn point toward the pad's own
// ground height; at the old 5u clearance value, a house sitting right at that minimum has its
// flatten circle's weight function (`1 - smoothstep(0.35, 1.0, d/radius)`, see heightfield.ts)
// still at ~0.98 strength right at the paved edge (road centerline +/- ROAD_WIDTH/2 = 3u away —
// only 2u from a 5u-clearance house's flatten center), which can re-disturb the terrain the road's
// own grading pass already matched to its deck height there. Bumping clearance to 6.5u roughly
// halves that weight (~0.44 at the edge) — measured empirically across several seeds, though, the
// house's own ground-height target also drifts further from the road's graded height as clearance
// grows (more natural terrain variation at a farther sample point), so the net effect on the
// worst-case visible seam is genuinely mixed rather than a clean win: this is a defensible
// mitigation (lower weight = less override of already-correct terrain, per the formula) but not a
// verified fix for every terrain profile. A more thorough fix would need to also tighten
// flattenCircle's falloff curve or shrink FLATTEN_RADIUS, which is a shared function used by road
// grading too and out of scope for this pass.
const MIN_ROAD_CLEARANCE = 6.5;

// A cell crossing the 'tree' threshold spawns trees only with this probability; every qualifying
// cell along a corridor would otherwise plant 2-3 trees every 4u (CELL), which at typical canopy
// radii reads as a solid hedge rather than scattered woodland. Thinning to ~40% of cells, each
// with fewer trees (see TREE_COUNT_MIN/MAX below), keeps the "development spreads from the road"
// feel while leaving visible gaps of bare ground between clumps.
const TREE_SPAWN_CHANCE = 0.4;
const TREE_COUNT_MIN = 1;
const TREE_COUNT_MAX = 2; // inclusive-exclusive count is TREE_COUNT_MIN + floor(rng * (MAX - MIN + 1))

export type GrowthKind = 'tree' | 'field' | 'house' | 'building';

interface Threshold {
  value: number;
  bit: number;
  kind: GrowthKind;
}

// Order matters: checked ascending so lower thresholds are guaranteed to have already fired
// (and thus their spawn events precede) higher ones for any given cell.
//
// Tuned (Task 23) alongside DEV_RATE_BASE/RATE_VARIANCE_* so a cell at the closest road ring
// (d=0) crosses thresholds at, across the +/-25% per-cell rate variance (direct simulation, 200
// cells, dt=1/60):
//   tree:      first ~68s,  median ~86s   (target 45-90s)
//   field:     first ~139s, median ~176s  (target ~2 sim-min)
//   house:     first ~231s, median ~293s  (target >= 3 sim-min / 180s)
//   building:  first ~323s, median ~357s  (target >= 5 sim-min / 300s; only ~half of cells
//              reach 'building' within the 400s simulation window, matching buildings being the
//              rarest/last stage)
// Previously 0.25/0.5/0.75/0.95 with a fixed (no-variance) 0.008 rate, which put houses under 1.5
// sim-minutes and buildings under 2.
const THRESHOLDS: Threshold[] = [
  { value: 0.22, bit: 1 << 0, kind: 'tree' },
  { value: 0.45, bit: 1 << 1, kind: 'field' },
  { value: 0.75, bit: 1 << 2, kind: 'house' },
  { value: 1.05, bit: 1 << 3, kind: 'building' },
];

export interface SpawnRecord {
  kind: GrowthKind;
  x: number;
  z: number;
  rot: number;
}

function cellIndex(i: number, j: number): number {
  return j * GRID_SIZE + i;
}

function cellCenter(i: number, j: number): P2 {
  return { x: i * CELL - HALF, z: j * CELL - HALF };
}

/**
 * Simulates gradual development pressure around painted roads: a per-cell "dev" accumulator rises
 * over time near roads (and only near roads — cells farther than MAX_ROAD_DIST_CELLS never
 * accumulate), gated by land/slope, and crossing successive thresholds spawns trees, fields,
 * houses, then buildings (once per kind per cell). Sim-only — no `three` imports.
 *
 * The road-distance field is a BFS (in cell-graph terms, so distance is measured in whole cells)
 * seeded by every cell within ROAD_WIDTH of any painted edge's sampled centerline. It is recomputed
 * whenever `roads:changed` fires, throttled to at most once per RECOMPUTE_INTERVAL sim-seconds so a
 * flurry of edits during active drawing doesn't repeatedly re-run the BFS; a pending recompute is
 * applied as soon as the throttle window opens (checked every `update`).
 */
export class GrowthSim {
  private dev = new Float32Array(GRID_SIZE * GRID_SIZE);
  private spawnMask = new Uint8Array(GRID_SIZE * GRID_SIZE);
  private roadDist = new Int16Array(GRID_SIZE * GRID_SIZE).fill(-1);
  // Per-cell rate multiplier (RATE_VARIANCE_MIN..MAX), rolled lazily on first accumulation and
  // held fixed thereafter — 0 means "not yet rolled" (see rateMultFor), which is safe since actual
  // multipliers never reach 0.
  private rateMult = new Float32Array(GRID_SIZE * GRID_SIZE);

  private simTime = 0;
  private lastRecomputeAt = -Infinity;
  private recomputePending = false;

  private houses = 0;
  private records: SpawnRecord[] = [];

  constructor(
    private graph: RoadGraph,
    private hf: Heightfield,
    private bus: EventBus,
    private rng: () => number,
  ) {
    this.bus.on('roads:changed', () => {
      this.recomputePending = true;
    });
  }

  get houseCount(): number {
    return this.houses;
  }

  get spawned(): ReadonlyArray<SpawnRecord> {
    return this.records;
  }

  /** Read-only view of the per-cell development accumulator, for save serialization. */
  get devLevels(): ReadonlyArray<number> {
    return Array.from(this.dev);
  }

  /**
   * Restores sim state from a save (Task 15): replaces the `dev` accumulator and replays the
   * `spawned` list directly into `records`/`houses`/`spawnMask` without re-emitting `growth:spawn`
   * (the caller is responsible for restoring the renderer separately, e.g. via
   * `SceneryRenderer.rebuild()`, so scenery pops back in with no animation). Thresholds already
   * crossed by the restored `dev` level are marked in `spawnMask` so `update()` won't re-spawn them.
   * Triggers a road-distance recompute on the next `update()` since the graph was just rebuilt too.
   */
  restore(dev: ArrayLike<number>, spawned: ReadonlyArray<SpawnRecord>): void {
    this.dev.set(dev);
    this.spawnMask.fill(0);
    this.records = spawned.slice();
    this.houses = this.records.filter((r) => r.kind === 'house').length;

    for (let j = 0; j < GRID_SIZE; j++) {
      for (let i = 0; i < GRID_SIZE; i++) {
        const idx = cellIndex(i, j);
        const level = this.dev[idx];
        for (const th of THRESHOLDS) {
          if (level >= th.value) this.spawnMask[idx] |= th.bit;
        }
      }
    }

    this.recomputePending = true;
  }

  private recomputeRoadDist(): void {
    this.roadDist.fill(-1);
    const queue: number[] = [];
    let qHead = 0;

    const seedCell = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= GRID_SIZE || j >= GRID_SIZE) return;
      const idx = cellIndex(i, j);
      if (this.roadDist[idx] !== -1) return;
      this.roadDist[idx] = 0;
      queue.push(idx);
    };

    const cellRadius = Math.ceil(ROAD_WIDTH / CELL);
    for (const edge of this.graph.edges.values()) {
      if (edge.stage !== 'painted') continue;
      for (const s of edge.samples) {
        const ci = Math.round((s.x + HALF) / CELL);
        const cj = Math.round((s.z + HALF) / CELL);
        for (let dj = -cellRadius; dj <= cellRadius; dj++) {
          for (let di = -cellRadius; di <= cellRadius; di++) {
            const i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= GRID_SIZE || j >= GRID_SIZE) continue;
            const wx = i * CELL - HALF, wz = j * CELL - HALF;
            if (Math.hypot(wx - s.x, wz - s.z) <= ROAD_WIDTH) seedCell(i, j);
          }
        }
      }
    }

    while (qHead < queue.length) {
      const idx = queue[qHead++];
      const d = this.roadDist[idx];
      if (d >= MAX_ROAD_DIST_CELLS) continue; // no need to expand beyond the cells we care about
      const i = idx % GRID_SIZE;
      const j = (idx - i) / GRID_SIZE;
      const neighbors: Array<[number, number]> = [
        [i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1],
      ];
      for (const [ni, nj] of neighbors) {
        if (ni < 0 || nj < 0 || ni >= GRID_SIZE || nj >= GRID_SIZE) continue;
        const nIdx = cellIndex(ni, nj);
        if (this.roadDist[nIdx] !== -1) continue;
        this.roadDist[nIdx] = d + 1;
        queue.push(nIdx);
      }
    }
  }

  /** Pushes (x,z) away from the nearest road sample if it lands within MIN_ROAD_CLEARANCE. */
  private clearOfRoads(x: number, z: number): { x: number; z: number } {
    let nearestDist = Infinity;
    let nearestX = x, nearestZ = z;
    for (const edge of this.graph.edges.values()) {
      for (const s of edge.samples) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < nearestDist) {
          nearestDist = d;
          nearestX = s.x;
          nearestZ = s.z;
        }
      }
    }
    if (nearestDist >= MIN_ROAD_CLEARANCE || nearestDist === Infinity) return { x, z };
    // push (x,z) directly away from the nearest sample out to MIN_ROAD_CLEARANCE
    let dx = x - nearestX, dz = z - nearestZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    return { x: nearestX + dx * MIN_ROAD_CLEARANCE, z: nearestZ + dz * MIN_ROAD_CLEARANCE };
  }

  private spawn(kind: GrowthKind, cx: number, cz: number): void {
    const jx = (this.rng() * 2 - 1) * JITTER;
    const jz = (this.rng() * 2 - 1) * JITTER;
    const { x, z } = this.clearOfRoads(cx + jx, cz + jz);
    const rot = this.rng() * Math.PI * 2;
    this.records.push({ kind, x, z, rot });
    this.bus.emit('growth:spawn', { kind, x, z, rot });
    if (kind === 'house') this.houses++;
  }

  update(dt: number): void {
    this.simTime += dt;

    if (this.recomputePending && this.simTime - this.lastRecomputeAt >= RECOMPUTE_INTERVAL) {
      this.recomputeRoadDist();
      this.lastRecomputeAt = this.simTime;
      this.recomputePending = false;
    }

    for (let j = 0; j < GRID_SIZE; j++) {
      for (let i = 0; i < GRID_SIZE; i++) {
        const idx = cellIndex(i, j);
        const d = this.roadDist[idx];
        if (d < 0 || d > MAX_ROAD_DIST_CELLS) continue;

        const { x, z } = cellCenter(i, j);
        if (!this.hf.isLand(x, z)) continue;
        if (this.hf.slopeAt(x, z) > MAX_SLOPE) continue;

        let mult = this.rateMult[idx];
        if (mult === 0) {
          mult = RATE_VARIANCE_MIN + this.rng() * (RATE_VARIANCE_MAX - RATE_VARIANCE_MIN);
          this.rateMult[idx] = mult;
        }

        const rate = DEV_RATE_BASE * mult * (1 - d / DEV_RATE_DIST_DIVISOR);
        if (rate <= 0) continue;
        this.dev[idx] += dt * rate;

        const mask = this.spawnMask[idx];
        const level = this.dev[idx];
        for (const th of THRESHOLDS) {
          if (level < th.value) break;
          if (mask & th.bit) continue;
          this.spawnMask[idx] |= th.bit;
          if (th.kind === 'tree') {
            // Thinned + scattered (see TREE_SPAWN_CHANCE) so corridors read as woodland, not a
            // hedge; the bit is still set above so a skipped cell isn't re-rolled every frame.
            if (this.rng() >= TREE_SPAWN_CHANCE) continue;
            const count = TREE_COUNT_MIN + Math.floor(this.rng() * (TREE_COUNT_MAX - TREE_COUNT_MIN + 1));
            for (let k = 0; k < count; k++) this.spawn('tree', x, z);
          } else {
            this.spawn(th.kind, x, z);
          }
        }
      }
    }
  }
}
