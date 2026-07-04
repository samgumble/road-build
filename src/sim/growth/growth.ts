import type { P2 } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { Heightfield } from '../terrain/heightfield';
import { sampleHeadingAt } from '../roads/path';
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

// Task 30: houses/buildings sit in a band this far from the nearest road-sample centerline
// (still respecting MIN_ROAD_CLEARANCE as the absolute floor), so frontages read as a consistent
// street setback rather than a radial scatter. A little play across the band (rather than a fixed
// distance) plus along-road jitter keeps neighboring houses from lining up on a single ring.
const SETBACK_MIN = 8;
const SETBACK_MAX = 10;
// rad — random wobble applied on top of the "face the road" heading so a street doesn't read as
// perfectly regimented.
const FACING_JITTER = 0.15;
// u — small jitter applied along the road's tangent direction after projecting to the setback
// band, so houses along the same stretch of road don't all land in a perfect line abreast of one
// another.
const ALONG_ROAD_JITTER = 1.5;

// Fields prefer a cell within this radius of an existing house record (farmstead grouping).
const FIELD_HOUSE_SEARCH_RADIUS = 14;
// rad — wobble applied to a field's road-aligned rotation.
const FIELD_ROT_JITTER = 0.1;

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
    const near = this.nearestRoadInfo(x, z);
    if (near.dist >= MIN_ROAD_CLEARANCE || near.dist === Infinity) return { x, z };
    // push (x,z) directly away from the nearest sample out to MIN_ROAD_CLEARANCE
    let dx = x - near.x, dz = z - near.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    return { x: near.x + dx * MIN_ROAD_CLEARANCE, z: near.z + dz * MIN_ROAD_CLEARANCE };
  }

  /**
   * Finds the nearest painted-road sample to (x, z) across every edge, along with that sample's
   * road heading (via `sampleHeadingAt`) so callers can both set back from the centerline and
   * orient buildings/fields relative to the road's direction. Returns `dist: Infinity` (heading 0)
   * when there are no painted roads at all.
   */
  private nearestRoadInfo(x: number, z: number): { x: number; z: number; dist: number; heading: number } {
    let best = { x, z, dist: Infinity, heading: 0 };
    for (const edge of this.graph.edges.values()) {
      for (let i = 0; i < edge.samples.length; i++) {
        const s = edge.samples[i];
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < best.dist) {
          best = { x: s.x, z: s.z, dist: d, heading: sampleHeadingAt(edge.samples, i) };
        }
      }
    }
    return best;
  }

  /**
   * Places a house/building so it faces the nearest road at a consistent [SETBACK_MIN,
   * SETBACK_MAX] distance from the road centerline sample, replacing the old radial push. The
   * "facing" direction is the vector from the building to the road sample — matching
   * sceneryRenderer.ts's existing convention for a house/building's front (see its window-quad
   * placement, which offsets by `(cos(rot), sin(rot))` from the instance): `rot` there IS the
   * direction the front/door faces, so setting `rot = atan2(toRoad.z, toRoad.x)` makes the door
   * point at the road. Falls back to `clearOfRoads`'s hard-clearance push (random rot) when there
   * are no painted roads yet, matching pre-Task-30 behavior for that edge case.
   */
  private placeFacingRoad(cx: number, cz: number): { x: number; z: number; rot: number } {
    const near = this.nearestRoadInfo(cx, cz);
    if (near.dist === Infinity) {
      const { x, z } = this.clearOfRoads(cx, cz);
      return { x, z, rot: this.rng() * Math.PI * 2 };
    }

    // Direction from the road sample outward to the original spawn point decides which side of
    // the road this building sits on; project onto that direction at a distance drawn from the
    // setback band (with a little jitter along the road's tangent so buildings don't all land in
    // a perfect line abreast of each other).
    let outX = cx - near.x, outZ = cz - near.z;
    const outLen = Math.hypot(outX, outZ);
    if (outLen < 1e-6) {
      // spawn point coincides with the road sample (degenerate/very rare) — pick an arbitrary
      // perpendicular-to-road side deterministically from rng rather than dividing by zero.
      const perp = near.heading + Math.PI / 2;
      outX = Math.cos(perp);
      outZ = Math.sin(perp);
    } else {
      outX /= outLen;
      outZ /= outLen;
    }

    const setback = SETBACK_MIN + this.rng() * (SETBACK_MAX - SETBACK_MIN);
    const along = (this.rng() * 2 - 1) * ALONG_ROAD_JITTER;
    const tanX = Math.cos(near.heading), tanZ = Math.sin(near.heading);

    let x = near.x + outX * setback + tanX * along;
    let z = near.z + outZ * setback + tanZ * along;

    // The sample nearest to `(cx, cz)` isn't necessarily the sample nearest to the moved-out
    // candidate `(x, z)` (moving `setback` + `along` u away can bring a different, closer sample
    // along the road's curve into range) — re-query from the candidate and re-project along ITS
    // perpendicular so the actual nearest-sample distance settles inside the setback band and the
    // facing direction is computed against the true nearest sample, not a stale one. A few
    // iterations converge quickly since each re-projection only has to correct for how much the
    // nearest sample moved, which shrinks fast (sample spacing ~2u vs an 8-10u setback).
    let finalNear = near;
    for (let iter = 0; iter < 4; iter++) {
      const settled = this.nearestRoadInfo(x, z);
      if (settled.dist === Infinity) break;
      finalNear = settled;
      if (Math.abs(settled.dist - setback) <= 0.01) break;
      let sx = x - settled.x, sz = z - settled.z;
      const sLen = Math.hypot(sx, sz) || 1;
      sx /= sLen;
      sz /= sLen;
      x = settled.x + sx * setback;
      z = settled.z + sz * setback;
    }

    // Face the road: direction from the (final) building position back to the road sample,
    // + small jitter so a straight street doesn't read as perfectly regimented.
    const toRoad = Math.atan2(finalNear.z - z, finalNear.x - x);
    const rot = toRoad + (this.rng() * 2 - 1) * FACING_JITTER;
    return { x, z, rot };
  }

  /**
   * Places a field aligned to the road direction, preferring a spot within
   * FIELD_HOUSE_SEARCH_RADIUS of an existing house record (farmstead grouping: fields snug beside
   * a farmhouse). Falls back to the previous clearOfRoads-based placement with road-aligned
   * rotation when no house is nearby yet.
   */
  private placeField(cx: number, cz: number): { x: number; z: number; rot: number } {
    const near = this.nearestRoadInfo(cx, cz);
    const heading = near.dist === Infinity ? this.rng() * Math.PI * 2 : near.heading;
    const rot = heading + (this.rng() * 2 - 1) * FIELD_ROT_JITTER;

    let nearestHouse: { x: number; z: number } | null = null;
    let nearestHouseDist = FIELD_HOUSE_SEARCH_RADIUS;
    for (const r of this.records) {
      if (r.kind !== 'house') continue;
      const d = Math.hypot(r.x - cx, r.z - cz);
      if (d < nearestHouseDist) {
        nearestHouseDist = d;
        nearestHouse = r;
      }
    }

    if (!nearestHouse) {
      const { x, z } = this.clearOfRoads(cx, cz);
      return { x, z, rot };
    }

    // Nudge the field toward the house, staying clear of the road, so it reads as sitting beside
    // the farmhouse rather than at the raw cell center.
    const toward = { x: (cx + nearestHouse.x) / 2, z: (cz + nearestHouse.z) / 2 };
    const { x, z } = this.clearOfRoads(toward.x, toward.z);
    return { x, z, rot };
  }

  private spawn(kind: GrowthKind, cx: number, cz: number): void {
    const jx = (this.rng() * 2 - 1) * JITTER;
    const jz = (this.rng() * 2 - 1) * JITTER;

    let x: number, z: number, rot: number;
    if (kind === 'house' || kind === 'building') {
      ({ x, z, rot } = this.placeFacingRoad(cx + jx, cz + jz));
    } else if (kind === 'field') {
      ({ x, z, rot } = this.placeField(cx + jx, cz + jz));
    } else {
      // trees: unchanged — clearOfRoads + random rotation.
      ({ x, z } = this.clearOfRoads(cx + jx, cz + jz));
      rot = this.rng() * Math.PI * 2;
    }

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
