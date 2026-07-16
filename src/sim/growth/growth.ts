import type { P2 } from '../../core/types';
import { STAGES } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { Heightfield } from '../terrain/heightfield';
import { sampleHeadingAt } from '../roads/path';
import { GRID_SIZE, CELL, WORLD_SIZE, ROAD_ENGINEERED_HALF_WIDTH, ROAD_WIDTH } from '../../core/constants';

const GRADED_INDEX = STAGES.indexOf('graded');

const HALF = WORLD_SIZE / 2;

const RECOMPUTE_INTERVAL = 2; // sim-seconds, throttle for distance-field recompute on roads:changed
const MAX_ROAD_DIST_CELLS = 6; // ~24u; cells beyond this never accumulate development
// Tuned (Task 23) against user feedback that development felt "too eager": at a fresh road's
// closest ring (d=0) with the per-cell RATE_VARIANCE multiplier below, this rate lands first
// trees ~65-115s, first fields ~135-230s, and first houses no sooner than ~230s (~3.8 sim-min).
// Visible buildings arrive later through the developed-neighbor upgrade gate. Previously 0.008,
// which put houses under 1.5 sim-min.
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
// Shared with SceneryRenderer: a field is a rendered square, so road clearance must account for
// its whole footprint rather than treating the record's center as a point. The circumradius makes
// this safe at curves/endpoints and for any rotation; the final 0.5u leaves a narrow visible verge.
export const FIELD_SIZE = 10;
const FIELD_FOOTPRINT_RADIUS = FIELD_SIZE / Math.SQRT2;
export const FIELD_ROAD_CLEARANCE = ROAD_ENGINEERED_HALF_WIDTH + FIELD_FOOTPRINT_RADIUS + 0.5;

// A cell crossing the 'tree' threshold spawns trees only with this probability; every qualifying
// cell along a corridor would otherwise plant 2-3 trees every 4u (CELL), which at typical canopy
// radii reads as a solid hedge rather than scattered woodland. Thinning to ~40% of cells, each
// with fewer trees (see TREE_COUNT_MIN/MAX below), keeps the "development spreads from the road"
// feel while leaving visible gaps of bare ground between clumps.
const TREE_SPAWN_CHANCE = 0.4;
const TREE_COUNT_MIN = 1;
const TREE_COUNT_MAX = 2; // inclusive-exclusive count is TREE_COUNT_MIN + floor(rng * (MAX - MIN + 1))

// Task 35: a cell "upgrades" its house record to a building once its own dev accumulator reaches
// this level AND at least HOUSE_UPGRADE_MIN_NEIGHBORS of its 4 orthogonal neighbor cells are
// themselves "developed" (dev >= the house threshold, i.e. 0.75 — see THRESHOLDS below). Upgrading
// mutates the record's `kind` in place (same id, same x/z/rot) rather than removing+respawning, so
// it reads as "this house became a building" rather than a demolish+rebuild. A cell can upgrade at
// most once because after upgrading its only house record is no longer kind 'house' — nothing left
// to match a second time.
const HOUSE_UPGRADE_DEV = 1.35;
const HOUSE_UPGRADE_MIN_NEIGHBORS = 2;

// Task 35: stranded decay. A record is "stranded" once its cell's road-distance field reads -1
// (i.e. farther than MAX_ROAD_DIST_CELLS cells — exactly the ~24u figure from Addendum D's spec —
// from any painted road after the BFS last recomputed). It then sits in a grace period; if still
// stranded once the grace elapses, it fades out over STRANDED_FADE_S and is finally removed.
const STRANDED_GRACE_S = 60; // sim-seconds before a stranded record starts fading
const STRANDED_FADE_S = 30; // sim-seconds fade duration (renderer-side animation; sim just times it)
// Dev is decayed back toward this floor (not all the way to 0) when a record over its cell is
// removed, so the cell doesn't need to fully re-climb from scratch to regrow — matching the user
// decision that regrowth should be "possible... but not instant".
const STRANDED_DEV_DECAY_TARGET = 0.4;

// Task 42 ("Groundwork"): corridor clearing — roads clear GROWN scenery (trees/fields/houses/
// buildings, ALL kinds, unlike stranded decay which applies uniformly regardless of kind too) that
// sits in their own build corridor, mirroring wilderness.ts's WildernessSim clearing exactly (same
// CLEAR_RADIUS formula, same "any stage >= graded counts, restores re-emit the saved stage not a
// literal 'graded' event" lesson). Unlike stranded decay (60s grace + 30s fade, rescuable),
// clearing is immediate + quick (no grace period at all — the excavator is physically there right
// now) and NEVER rescuable: demolishing the road later does not un-clear a record it displaced.
// Records within this distance of any non-bridge road sample are cleared as the excavator's
// corridor passes through: asphalt + compacted shoulder + ditch + vegetation safety margin,
// identical to wilderness.ts and sourced from the renderer's shared footprint constants.
const CLEAR_RADIUS = ROAD_ENGINEERED_HALF_WIDTH;
// sim-seconds — quick fade matching wilderness.ts's WILDERNESS_FADE_DURATION feel (the renderer's
// own constant is separate, see sceneryRenderer.ts), deliberately far shorter than
// STRANDED_FADE_S/STRANDED_GRACE_S: a record physically in the roadbed doesn't get a grace period,
// it's simply gone as the grading pass reaches it.
const CLEAR_FADE_S = 1.5;

// Living Towns: one coarse, seeded value-noise field shapes development into contiguous pockets
// instead of letting every equally-roaded cell urbanize at nearly the same rate. This is derived
// from world coordinates + the world seed, so it needs no save field and old saves gain the same
// morphology deterministically when loaded.
const MORPHOLOGY_CELL = 56;
const MORPHOLOGY_MIN = 0.12;
const MORPHOLOGY_MAX = 1.2;
const JUNCTION_CENTER_RADIUS = 24;

function morphologyHash(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 0x1f123bb5) ^ Math.imul(iz, 0x5f356495) ^ Math.floor(seed * 0x7fffffff)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

function smooth01(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

function valueNoise2d(x: number, z: number, seed: number, scale: number): number {
  const gx = x / scale, gz = z / scale;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const tx = smooth01(gx - ix), tz = smooth01(gz - iz);
  const a = morphologyHash(ix, iz, seed);
  const b = morphologyHash(ix + 1, iz, seed);
  const c = morphologyHash(ix, iz + 1, seed);
  const d = morphologyHash(ix + 1, iz + 1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

/** Seeded development-rate multiplier for a world position. Broad low-frequency pockets create
 * neighborhoods and rural gaps; a smaller octave prevents perfectly round blobs. A real
 * three-way painted-road junction raises the local floor so connected networks naturally form
 * compact centers. Pure/exported so pacing and determinism stay directly testable. */
export function settlementMorphology(
  x: number,
  z: number,
  seed: number,
  junctionDistance: number,
): number {
  const broad = valueNoise2d(x, z, seed, MORPHOLOGY_CELL);
  const detail = valueNoise2d(x, z, seed + 0.371, MORPHOLOGY_CELL / 2);
  const noise = broad * 0.78 + detail * 0.22;
  const density = smooth01((noise - 0.38) / 0.34);
  const pocket = MORPHOLOGY_MIN + (MORPHOLOGY_MAX - MORPHOLOGY_MIN) * density;
  if (!Number.isFinite(junctionDistance) || junctionDistance >= JUNCTION_CENTER_RADIUS) return pocket;
  const junction = 0.72 + 0.5 * smooth01(1 - junctionDistance / JUNCTION_CENTER_RADIUS);
  return Math.max(pocket, junction);
}

/** Distance to the nearest node where at least three PAINTED roads meet. Shared by simulation
 * morphology and render-side skyline shaping so both systems agree on where a town center is. */
export function paintedJunctionDistance(graph: RoadGraph, x: number, z: number): number {
  let best = Infinity;
  for (const node of graph.nodes.values()) {
    let paintedDegree = 0;
    for (const edgeId of graph.edgesAtNode(node.id)) {
      if (graph.edges.get(edgeId)?.stage === 'painted') paintedDegree++;
    }
    if (paintedDegree < 3) continue;
    best = Math.min(best, Math.hypot(node.x - x, node.z - z));
  }
  return best;
}

export type GrowthKind = 'tree' | 'field' | 'house' | 'building' | 'park';

// Living Towns parcel variety: a coordinate-seeded fraction of house-threshold parcels become
// pocket parks (a green field-footprint patch plus a couple of its own tree records) instead of
// yet another house. Like the morphology field above, the roll derives from cell coordinates +
// the world seed — no rng stream consumption, no save field, and old saves gain the same parks
// deterministically wherever their cells hadn't spawned a house yet. The salts just decorrelate
// these rolls from the morphology noise that shares `morphologyHash`.
const PARK_CHANCE = 0.2;
const PARK_SALT_I = 15485863;
const PARK_SALT_J = 32452843;
const PARK_TREES = 2; // pocket trees spawned as ordinary tree records (full decay/clearing lifecycle)

// Living Towns low-rise damping: not every qualifying block goes high-rise. When a cell first
// passes the upgrade neighbor gate, it rolls a seeded tolerance for how many buildings it accepts
// within LOWRISE_DENSITY_RADIUS before permanently staying a house — scattering towers through
// low-rise streets instead of extruding continuous walls. Coordinate-seeded for the same reasons
// as PARK_* above.
const LOWRISE_DENSITY_RADIUS = 20; // u
const LOWRISE_SALT_I = 7919;
const LOWRISE_SALT_J = 104729;

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
//   building progression bit: first ~323s, median ~357s. This bit no longer directly spawns a
//              second structure; visible towers arrive later through HOUSE_UPGRADE_DEV plus its
//              developed-neighbor and low-rise-density gates.
// Previously 0.25/0.5/0.75/0.95 with a fixed (no-variance) 0.008 rate, which put houses under 1.5
// sim-minutes and buildings under 2.
const THRESHOLDS: Threshold[] = [
  { value: 0.22, bit: 1 << 0, kind: 'tree' },
  { value: 0.45, bit: 1 << 1, kind: 'field' },
  { value: 0.75, bit: 1 << 2, kind: 'house' },
  { value: 1.05, bit: 1 << 3, kind: 'building' },
];

// Task 35: a neighbor cell counts as "developed" for upgrade-eligibility purposes once its dev
// accumulator has crossed the same threshold a cell needs to spawn its own house — i.e. the
// 'house' entry above. Read once as a plain number rather than re-finding it in THRESHOLDS on
// every neighbor check.
const NEIGHBOR_DEVELOPED_DEV = THRESHOLDS[2].value;

/** Groundwork (Task 35 follow-up) Finding 1: `updateStrandedDecay`'s removal branch used to zero
 * a cell's ENTIRE spawnMask whenever any one record over that cell was removed, clearing every
 * other co-located record's kind bit too even though only one record actually left. A cell can
 * hold up to 4 co-located records (tree(s) + field + house/building all placed near the same cell
 * center); their fates can diverge across re-road/re-strand cycles, and the stranded-decay target
 * dev (0.4) sits above the tree threshold (0.22), so a blanket clear silently re-arms tree
 * regrowth even when the tree record itself never left. Looks up the single bit a given record's
 * `kind` owns in `spawnMask` — an upgraded record (kind 'building', but its cell's `spawnMask`
 * still carries the 'house' bit from before the upgrade) clears BOTH bits, since the house-stage
 * record is gone too (it became this same building record, not a separate one still present). */
function bitsForKind(kind: GrowthKind): number {
  // A park occupies the cell's house slot (it spawned INSTEAD of the house at that threshold), so
  // removing it frees the house bit — the parcel can regrow a house later, same as any other
  // removed record freeing its own slot.
  if (kind === 'park') return THRESHOLDS.find((t) => t.kind === 'house')!.bit;
  if (kind === 'building') {
    const buildingBit = THRESHOLDS.find((t) => t.kind === 'building')!.bit;
    const houseBit = THRESHOLDS.find((t) => t.kind === 'house')!.bit;
    return buildingBit | houseBit;
  }
  return THRESHOLDS.find((t) => t.kind === kind)!.bit;
}

/**
 * Finding 2 (Task 35 follow-up "Groundwork"): a record's in-flight grace/fade timer, expressed as
 * a sim-time OFFSET already elapsed (seconds into `STRANDED_GRACE_S` or `STRANDED_FADE_S`) rather
 * than an absolute `simTime` — a fresh `GrowthSim` instance's `simTime` always starts at 0 on
 * reload, so persisting an absolute timestamp would be meaningless (and would need to be adjusted
 * by however long the save sat unloaded, which isn't tracked or desired: the fix here is "resume
 * the same timeline", not "keep counting wall-clock time while the game was closed"). Exactly one
 * of `stranded`/`fading` is present per entry — a record is never in both phases at once. Absent
 * entirely for a record with no in-flight timer (the common case).
 */
export interface DecayEntry {
  id: number;
  stranded?: number; // seconds already elapsed into the STRANDED_GRACE_S grace period
  fading?: number; // seconds already elapsed into the STRANDED_FADE_S fade
}

export interface SpawnRecord {
  kind: GrowthKind;
  x: number;
  z: number;
  rot: number;
  // Task 35: stable id, monotonic within a GrowthSim instance, persisted in saves (SaveV3). Older
  // saves (v1/v2, no ids) get sequential ids assigned during migration — see save.ts.
  id: number;
}

// Reserve the largest possible rendered structure footprint, not only today's house mesh: every
// house can upgrade in place to a width-scaled 5x5 tower. A 9u center gap safely contains two
// 4.1u circumradii plus a narrow visual alley at any pair of rotations.
export const STRUCTURE_MIN_CENTER_DISTANCE = 9;

function isStructure(kind: GrowthKind): boolean {
  return kind === 'house' || kind === 'building';
}

export function structurePlacementClear(
  records: ReadonlyArray<Pick<SpawnRecord, 'kind' | 'x' | 'z'>>,
  x: number,
  z: number,
): boolean {
  const minDistanceSq = STRUCTURE_MIN_CENTER_DISTANCE * STRUCTURE_MIN_CENTER_DISTANCE;
  return records.every((record) => !isStructure(record.kind) || (
    (record.x - x) * (record.x - x) + (record.z - z) * (record.z - z) >= minDistanceSq
  ));
}

/** Render-only migration for legacy saves authored before structure clearance existed. The first
 * structure keeps its authoritative position; later collisions move outward from their road-facing
 * front in deterministic rings. Simulation/save coordinates remain untouched, while reloads stop
 * drawing two full footprints in the same space. */
export function resolveStructureRenderLayout(records: ReadonlyArray<SpawnRecord>): SpawnRecord[] {
  const resolved: SpawnRecord[] = [];
  const step = STRUCTURE_MIN_CENTER_DISTANCE + 1;
  const angleOffsets = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, Math.PI];

  for (const record of records) {
    if (!isStructure(record.kind) || structurePlacementClear(resolved, record.x, record.z)) {
      resolved.push({ ...record });
      continue;
    }

    let placed: SpawnRecord | null = null;
    const outward = record.rot + Math.PI;
    for (let ring = 1; ring <= 6 && !placed; ring++) {
      for (const offset of angleOffsets) {
        const angle = outward + offset;
        const candidate = {
          ...record,
          x: record.x + Math.cos(angle) * step * ring,
          z: record.z + Math.sin(angle) * step * ring,
        };
        if (structurePlacementClear(resolved, candidate.x, candidate.z)) {
          placed = candidate;
          break;
        }
      }
    }
    resolved.push(placed ?? { ...record });
  }
  return resolved;
}

function cellIndex(i: number, j: number): number {
  return j * GRID_SIZE + i;
}

function cellCenter(i: number, j: number): P2 {
  return { x: i * CELL - HALF, z: j * CELL - HALF };
}

/** Maps a world position back to its nearest grid cell (i, j), clamped to the grid — inverse of
 * `cellCenter`, used to look up a spawn record's own cell (e.g. for road-distance/spawnMask
 * checks) even though records are jittered off their cell's exact center. */
function cellOf(x: number, z: number): { i: number; j: number } {
  const i = Math.min(GRID_SIZE - 1, Math.max(0, Math.round((x + HALF) / CELL)));
  const j = Math.min(GRID_SIZE - 1, Math.max(0, Math.round((z + HALF) / CELL)));
  return { i, j };
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
  private settlementMult = new Float32Array(GRID_SIZE * GRID_SIZE);

  private simTime = 0;
  private lastRecomputeAt = -Infinity;
  private recomputePending = false;
  private developmentPaused = false;

  private houses = 0;
  private records: SpawnRecord[] = [];
  private nextRecordId = 1;

  // Task 35: upgrade bookkeeping — a bit per cell (separate from spawnMask's threshold bits) so an
  // already-upgraded cell is never rescanned. Task 35: stranded-decay bookkeeping, keyed by record
  // id (not array index, which shifts on removal) — `strandedSince` marks when a record first read
  // as stranded (cleared if it stops being stranded before the grace elapses, e.g. re-roading);
  // `fading` marks the sim-time a record's fade animation started, once the grace period elapses.
  private upgradedCell = new Uint8Array(GRID_SIZE * GRID_SIZE);
  private strandedSince = new Map<number, number>(); // id -> simTime first observed stranded
  private fadingSince = new Map<number, number>(); // id -> simTime fade began (post-grace)

  // Task 42: corridor-clearing bookkeeping, keyed by record id like strandedSince/fadingSince
  // above — id -> simTime the quick clearing fade started. Deliberately separate from
  // strandedSince/fadingSince: a record here is NEVER also tracked by those maps (clearing is
  // immediate, no grace period, and mutually exclusive with the stranded-decay pipeline — see
  // `updateStrandedDecay`'s guard against a record already clearing) and is never rescuable (no
  // `growth:rescued` path touches this map at all).
  private clearingSince = new Map<number, number>();
  /** Per-edge arclength the grading front has already swept (progressive corridor clearing). */
  private corridorSweptTo = new Map<number, number>();

  constructor(
    private graph: RoadGraph,
    private hf: Heightfield,
    private bus: EventBus,
    private rng: () => number,
    private morphologySeed: number | null = null,
  ) {
    this.bus.on('roads:changed', () => {
      this.recomputePending = true;
      this.settlementMult.fill(0); // a newly-connected junction can reshape nearby future growth
    });
    // Task 42: an edge's construction reaching (or being restored at/past) 'graded' clears any
    // grown record sitting in its corridor. Mirrors WildernessSim's own listener in wilderness.ts
    // exactly, including its critical restore lesson (see the doc comment there): a RESTORED edge
    // re-emits construction:stage with whatever stage was SAVED (often past a literal 'graded'
    // event, e.g. 'gravel'/'paved'/'painted'), never 'removed'/'surveyed'. Any stage at/past
    // 'graded' implies the corridor was already cut, so it must clear regardless of which exact
    // stage triggered this event.
    // Progressive clearing (player request "trees are removed during the step after surveying"):
    // corridor records start their quick clearing fade AS the grading front passes them, not all
    // at once when the stage completes. Demolition progress never clears records.
    this.bus.on('construction:progress', (e) => {
      if (e.demolish || e.stage !== 'graded') return;
      this.clearCorridor(e.edgeId, e.t);
    });
    this.bus.on('construction:stage', (e) => {
      if (e.stage === 'removed') {
        this.corridorSweptTo.delete(e.edgeId);
        return;
      }
      if (STAGES.indexOf(e.stage) < GRADED_INDEX) return;
      this.clearCorridor(e.edgeId);
    });
  }

  get houseCount(): number {
    return this.houses;
  }

  /** Pauses only positive world development (dev accumulation, threshold spawns, and upgrades).
   * Road-distance maintenance and destructive lifecycles keep advancing so construction can still
   * clear its corridor and already-stranded scenery can finish fading while growth is paused. */
  get isDevelopmentPaused(): boolean {
    return this.developmentPaused;
  }

  setDevelopmentPaused(paused: boolean): void {
    this.developmentPaused = paused;
  }

  get spawned(): ReadonlyArray<SpawnRecord> {
    return this.records;
  }

  /** Read-only view of the per-cell development accumulator, for save serialization. */
  get devLevels(): ReadonlyArray<number> {
    return Array.from(this.dev);
  }

  /** Test/diagnostic-only: the raw spawnMask bitfield for cell (i, j) — exposes per-kind bit
   * state (Finding 1, Task 35 follow-up "Groundwork") so tests can directly verify that removing
   * one co-located record's kind bit leaves sibling kinds' bits untouched, rather than inferring it
   * indirectly through regrowth timing. Not used by any production code path. */
  spawnMaskAt(i: number, j: number): number {
    return this.spawnMask[cellIndex(i, j)];
  }

  /**
   * Finding 2 (Task 35 follow-up "Groundwork"): read-only snapshot of every record currently
   * mid-grace or mid-fade, as sim-time-relative offsets (see `DecayEntry`'s doc comment) — for save
   * serialization. Order is not significant; only present for records with an in-flight timer.
   */
  get decayState(): DecayEntry[] {
    const out: DecayEntry[] = [];
    for (const [id, since] of this.strandedSince) out.push({ id, stranded: this.simTime - since });
    for (const [id, since] of this.fadingSince) out.push({ id, fading: this.simTime - since });
    return out;
  }

  /**
   * Task 42: read-only snapshot of every record id currently mid-corridor-clearing-fade — used only
   * by the renderer's `rebuild()` path (via main.ts, right after a `restoreWorld` call) so a record
   * whose clearing fade was (re-)started by `restore()`'s own corridor re-scan renders already
   * mid-fade instead of popping in at full scale for ~CLEAR_FADE_S before abruptly vanishing on
   * `growth:remove` with no fade ever shown. Deliberately just a plain id list (no elapsed-offset,
   * unlike `decayState`'s stranded/fading entries): `restore()` always starts a FRESH clearing fade
   * (see its own doc comment for why there's nothing to resume), so the renderer only needs to know
   * WHICH ids to start a fresh `CLEAR_FADE_DURATION` fade for, not how far into it they already are.
   */
  get clearingIds(): ReadonlyArray<number> {
    return Array.from(this.clearingSince.keys());
  }

  /**
   * Restores sim state from a save (Task 15): replaces the `dev` accumulator and replays the
   * `spawned` list directly into `records`/`houses`/`spawnMask` without re-emitting `growth:spawn`
   * (the caller is responsible for restoring the renderer separately, e.g. via
   * `SceneryRenderer.rebuild()`, so scenery pops back in with no animation). Thresholds already
   * crossed by the restored `dev` level are marked in `spawnMask` so `update()` won't re-spawn them.
   * Triggers a road-distance recompute on the next `update()` since the graph was just rebuilt too.
   *
   * Finding 2 (Task 35 follow-up "Groundwork"): `decay` (optional, defaults to empty — v1/v2
   * migrated saves and any caller predating this param have no decay state to restore) re-arms
   * `strandedSince`/`fadingSince` from each entry's saved offset so an in-flight grace/fade
   * timeline CONTINUES from where it was saved rather than restarting — `this.simTime` is always 0
   * at the point `restore()` runs (a fresh `GrowthSim` instance, no `update()` calls yet), so
   * `since = this.simTime - offset` yields a negative "since" that makes `updateStrandedDecay`'s
   * `this.simTime - since >= THRESHOLD` checks land exactly `offset` seconds further along the
   * timeline than a record that just became stranded. A record with no matching `decay` entry (the
   * common case — not currently stranded) is simply left with no timer, same as before.
   *
   * Task 42: corridor clearing is deliberately NOT part of the persisted `decay` shape at all (no
   * `clearingSince` offset is saved/restored) — see this task's spec: since clearing is re-derived
   * from the current graph on every restore anyway (mirroring WildernessSim's own restore lesson in
   * wilderness.ts), there is nothing to lose by always starting a FRESH CLEAR_FADE_S fade for any
   * restored record still sitting in a >= graded edge's corridor, rather than trying to resume a
   * saved offset for what's already an ~1.5s animation. `restoreWorld` (save.ts) force-sets each
   * edge's `stage` and re-emits `construction:stage` with that (possibly-past-'graded') stage BEFORE
   * calling this method — i.e. before `this.records` exists to match against — so this method's own
   * scan at the end (mirroring `clearCorridor`, driven directly off `this.graph`'s current edges
   * rather than waiting for another `construction:stage` event that will never re-fire) is the ONLY
   * path that can re-clear those records post-restore.
   */
  restore(dev: ArrayLike<number>, spawned: ReadonlyArray<SpawnRecord>, decay: ReadonlyArray<DecayEntry> = []): void {
    this.dev.set(dev);
    this.spawnMask.fill(0);
    this.upgradedCell.fill(0);
    this.strandedSince.clear();
    this.fadingSince.clear();
    this.clearingSince.clear();
    // Task 35: a pre-Task-35 save's records have no `id` (migration in save.ts assigns one, but
    // defend here too in case a caller passes raw records some other way) — assign sequential ids
    // to any record missing one, deterministically in array order.
    let maxId = 0;
    this.records = spawned.map((r) => {
      const id = typeof r.id === 'number' && Number.isFinite(r.id) ? r.id : this.nextRecordId++;
      if (id > maxId) maxId = id;
      return { ...r, id };
    });
    this.nextRecordId = Math.max(this.nextRecordId, maxId + 1);
    this.houses = this.records.filter((r) => r.kind === 'house').length;

    const liveIds = new Set(this.records.map((r) => r.id));
    for (const entry of decay) {
      if (!liveIds.has(entry.id)) continue; // defend against a stale/corrupt save referencing a dead id
      if (typeof entry.stranded === 'number' && Number.isFinite(entry.stranded)) {
        this.strandedSince.set(entry.id, this.simTime - entry.stranded);
      } else if (typeof entry.fading === 'number' && Number.isFinite(entry.fading)) {
        this.fadingSince.set(entry.id, this.simTime - entry.fading);
      }
    }

    for (let j = 0; j < GRID_SIZE; j++) {
      for (let i = 0; i < GRID_SIZE; i++) {
        const idx = cellIndex(i, j);
        const level = this.dev[idx];
        for (const th of THRESHOLDS) {
          if (level >= th.value) this.spawnMask[idx] |= th.bit;
        }
        // Deliberately NOT marking `upgradedCell` here just because `level >= HOUSE_UPGRADE_DEV`:
        // unlike spawnMask's thresholds (which must never re-fire a spawn for a cell that already
        // has one), a restored cell whose record is STILL kind 'house' at this dev level hasn't
        // actually upgraded yet — it should get exactly one more chance to do so on the next
        // `update()`, the same as any other cell reaching this dev level live. `tryUpgrade` itself
        // sets `upgradedCell[idx] = 1` unconditionally once it runs (whether or not a house was
        // found to upgrade), so the "once per record" guarantee still holds without this needing to
        // pre-empt it — a restored 'building' record simply has no house left for `tryUpgrade` to
        // find, so its (single, harmless) next check is a no-op.
      }
    }

    this.recomputePending = true;

    // Task 42: re-derive corridor clearing against the graph's CURRENT edges — see this method's
    // doc comment above for why this can't simply rely on catching a live `construction:stage`
    // event. Every edge already at/past 'graded' by the time this runs (restoreWorld forces stages
    // before calling restore()) clears any just-restored record still sitting in its corridor.
    for (const edge of this.graph.edges.values()) {
      if (STAGES.indexOf(edge.stage) < GRADED_INDEX) continue;
      this.clearCorridor(edge.id);
    }
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

  /** Pushes (x,z) away from roads until the nearest sample satisfies `minClearance`. Re-querying
   * after each projection handles curves where moving away from one sample exposes a closer one. */
  private clearOfRoads(x: number, z: number, minClearance = MIN_ROAD_CLEARANCE): { x: number; z: number } {
    let px = x, pz = z;
    for (let iter = 0; iter < 5; iter++) {
      const near = this.nearestRoadInfo(px, pz);
      if (near.dist >= minClearance || near.dist === Infinity) return { x: px, z: pz };

      let dx = px - near.x, dz = pz - near.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        // Exactly on the centerline: choose a stable perpendicular rather than leaving the point
        // unmoved (the old `|| 1` fallback kept dx/dz at zero and could strand scenery on-road).
        const perpendicular = near.heading + Math.PI / 2;
        dx = Math.cos(perpendicular);
        dz = Math.sin(perpendicular);
      } else {
        dx /= len;
        dz /= len;
      }
      px = near.x + dx * minClearance;
      pz = near.z + dz * minClearance;
    }
    return { x: px, z: pz };
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

  private nearestPaintedJunctionDistance(x: number, z: number): number {
    return paintedJunctionDistance(this.graph, x, z);
  }

  private settlementMultFor(idx: number, x: number, z: number): number {
    if (this.morphologySeed === null) return 1; // legacy/test callers retain established pacing
    let mult = this.settlementMult[idx];
    if (mult === 0) {
      mult = settlementMorphology(x, z, this.morphologySeed, this.nearestPaintedJunctionDistance(x, z));
      this.settlementMult[idx] = mult;
    }
    return mult;
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
      const { x, z } = this.clearOfRoads(cx, cz, FIELD_ROAD_CLEARANCE);
      return { x, z, rot };
    }

    // Nudge the field toward the house, staying clear of the road, so it reads as sitting beside
    // the farmhouse rather than at the raw cell center.
    const toward = { x: (cx + nearestHouse.x) / 2, z: (cz + nearestHouse.z) / 2 };
    const { x, z } = this.clearOfRoads(toward.x, toward.z, FIELD_ROAD_CLEARANCE);
    return { x, z, rot };
  }

  private spawn(kind: GrowthKind, cx: number, cz: number): void {
    const jx = (this.rng() * 2 - 1) * JITTER;
    const jz = (this.rng() * 2 - 1) * JITTER;

    let x: number, z: number, rot: number;
    if (kind === 'house' || kind === 'building') {
      ({ x, z, rot } = this.placeFacingRoad(cx + jx, cz + jz));
    } else if (kind === 'field' || kind === 'park') {
      // Parks share the field's 10x10 footprint and therefore its footprint-aware clearance
      // (HANDOFF "Scenery footprints" invariant) — same placement, different dressing.
      ({ x, z, rot } = this.placeField(cx + jx, cz + jz));
    } else {
      // trees: unchanged — clearOfRoads + random rotation.
      ({ x, z } = this.clearOfRoads(cx + jx, cz + jz));
      rot = this.rng() * Math.PI * 2;
    }

    // Consume the parcel threshold but decline the structure when its future tower footprint would
    // collide with an existing house/building. This avoids unbounded retries or pushing a parcel
    // into a different cell/road corridor while guaranteeing later in-place upgrades remain clear.
    if (isStructure(kind) && !structurePlacementClear(this.records, x, z)) return;

    const id = this.nextRecordId++;
    this.records.push({ kind, x, z, rot, id });
    this.bus.emit('growth:spawn', { kind, x, z, rot, id });
    if (kind === 'house') this.houses++;
  }

  update(dt: number): void {
    this.simTime += dt;

    if (this.recomputePending && this.simTime - this.lastRecomputeAt >= RECOMPUTE_INTERVAL) {
      this.recomputeRoadDist();
      this.lastRecomputeAt = this.simTime;
      this.recomputePending = false;
    }

    if (!this.developmentPaused) this.updateDevelopment(dt);

    // Cleanup remains live while positive development is paused: otherwise building a road with
    // growth paused would leave corridor trees frozen mid-fade and stranded settlements immortal.
    this.updateStrandedDecay();
    this.updateClearing();
  }

  private updateDevelopment(dt: number): void {
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

        const rate = DEV_RATE_BASE * mult * this.settlementMultFor(idx, x, z) * (1 - d / DEV_RATE_DIST_DIVISOR);
        if (rate <= 0) continue;
        this.dev[idx] += dt * rate;

        const mask = this.spawnMask[idx];
        const level = this.dev[idx];
        for (const th of THRESHOLDS) {
          if (level < th.value) break;
          if (mask & th.bit) continue;
          this.spawnMask[idx] |= th.bit;
          if (th.kind === 'field') {
            // Field/grass patches no longer spawn (removed per repeated player feedback — "remove
            // grass spawning from the environment growth"). The bit is still consumed so the cell
            // isn't re-rolled; `placeField` stays for parks, and saved field records still restore.
            continue;
          } else if (th.kind === 'building') {
            // The building threshold is retained as a consumed/save-compatible progression bit,
            // but it must not place a SECOND structure on the parcel. Towers arise only through
            // `tryUpgrade`, which mutates the existing house record in place once its developed-
            // neighbor and low-rise-density gates pass.
            continue;
          } else if (th.kind === 'tree') {
            // Thinned + scattered (see TREE_SPAWN_CHANCE) so corridors read as woodland, not a
            // hedge; the bit is still set above so a skipped cell isn't re-rolled every frame.
            if (this.rng() >= TREE_SPAWN_CHANCE) continue;
            const count = TREE_COUNT_MIN + Math.floor(this.rng() * (TREE_COUNT_MAX - TREE_COUNT_MIN + 1));
            for (let k = 0; k < count; k++) this.spawn('tree', x, z);
          } else if (
            th.kind === 'house' && this.morphologySeed !== null &&
            morphologyHash(i + PARK_SALT_I, j + PARK_SALT_J, this.morphologySeed) < PARK_CHANCE
          ) {
            // Living Towns parcel variety (see PARK_* above): this parcel greens over instead of
            // housing — the park takes the house slot, plus a couple of its own pocket trees.
            this.spawn('park', x, z);
            for (let k = 0; k < PARK_TREES; k++) this.spawn('tree', x, z);
          } else {
            this.spawn(th.kind, x, z);
          }
        }

        if (level >= HOUSE_UPGRADE_DEV && !this.upgradedCell[idx]) {
          this.tryUpgrade(i, j, idx);
        }
      }
    }
  }

  /**
   * Task 35: upgrades an existing house record in cell (i, j) to a building once the cell's own
   * dev has reached HOUSE_UPGRADE_DEV and at least HOUSE_UPGRADE_MIN_NEIGHBORS of its 4 orthogonal
   * neighbor cells are themselves developed (dev >= NEIGHBOR_DEVELOPED_DEV). Marks the cell
   * upgraded either way once the dev condition is met, so a cell that qualifies on dev but lacks
   * neighbors yet is re-checked next tick rather than every frame forever — actually: only marked
   * once an upgrade actually happens, or once no house record exists in the cell to upgrade at all
   * (nothing to upgrade — mirrors a spawnMask bit meaning "handled", not "eligible").
   *
   * Groundwork batch-review Finding 1 (Critical): target selection used to match ANY house record
   * in the cell, including one already mid-corridor-clearing (`clearingSince`) or mid-stranded-fade
   * (`fadingSince`) — both states where the record is actively animating out and moments from being
   * removed by `updateClearing`/`updateStrandedDecay`. Upgrading it first would fire
   * `growth:upgrade` (mutating `kind` to 'building' in place) for a record that's about to vanish
   * regardless, which is visually nonsensical and races the two lifecycle pipelines over the same
   * id. Fix: skip any candidate house whose id is in `clearingSince` OR `fadingSince` — matching
   * `updateStrandedDecay`'s own guard against racing `clearingSince` (see there). A grace-only
   * record (`strandedSince` set, not yet fading) is deliberately included in this same skip too —
   * simpler as one rule ("any decay timer in flight blocks upgrade") than special-casing "grace is
   * fine, fade/clearing is not," even though a grace-only record isn't visually animating yet.
   *
   * When the only matching house is skipped for this reason, `upgradedCell[idx]` is deliberately
   * NOT marked — this is a transient state (the record will either be rescued, becoming eligible
   * again, or removed, which resets `upgradedCell[idx]` back to 0 via `removeRecordAt` anyway), so
   * leaving the cell un-marked just re-checks it next tick, mirroring the "not enough developed
   * neighbors yet" early-return just above it.
   */
  private tryUpgrade(i: number, j: number, idx: number): void {
    const neighbors: Array<[number, number]> = [
      [i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1],
    ];
    let developedNeighbors = 0;
    for (const [ni, nj] of neighbors) {
      if (ni < 0 || nj < 0 || ni >= GRID_SIZE || nj >= GRID_SIZE) continue;
      if (this.dev[cellIndex(ni, nj)] >= NEIGHBOR_DEVELOPED_DEV) developedNeighbors++;
    }
    if (developedNeighbors < HOUSE_UPGRADE_MIN_NEIGHBORS) return; // not yet — recheck next tick

    // Living Towns low-rise damping (see LOWRISE_* above): the moment the neighbor gate first
    // passes, check the built mass already standing nearby against this cell's seeded tolerance
    // (1..3 buildings). At or over tolerance, the cell is PERMANENTLY marked handled — this block
    // stays low-rise, breaking up continuous tower walls. Deterministic: same seed and event order
    // reach this check with the same records every time.
    if (this.morphologySeed !== null) {
      const tolerance = 1 + Math.floor(morphologyHash(i + LOWRISE_SALT_I, j + LOWRISE_SALT_J, this.morphologySeed) * 3);
      const center = cellCenter(i, j);
      let nearbyBuildings = 0;
      for (const r of this.records) {
        if (r.kind !== 'building') continue;
        if (Math.hypot(r.x - center.x, r.z - center.z) <= LOWRISE_DENSITY_RADIUS) nearbyBuildings++;
      }
      if (nearbyBuildings >= tolerance) {
        this.upgradedCell[idx] = 1;
        return;
      }
    }

    let target: SpawnRecord | null = null;
    let targetSkippedForDecay = false;
    for (const r of this.records) {
      if (r.kind !== 'house') continue;
      const c = cellOf(r.x, r.z);
      if (c.i !== i || c.j !== j) continue;
      if (this.clearingSince.has(r.id) || this.fadingSince.has(r.id) || this.strandedSince.has(r.id)) {
        targetSkippedForDecay = true; // Finding 1: mid-clearing/mid-fade/mid-grace — not eligible
        continue;
      }
      target = r;
      break;
    }

    if (targetSkippedForDecay && !target) return; // recheck next tick — nothing to mark handled

    this.upgradedCell[idx] = 1; // handled either way — no house here means nothing to upgrade, ever
    if (!target) return;

    target.kind = 'building';
    this.houses--;
    this.bus.emit('growth:upgrade', { id: target.id });
  }

  /**
   * Task 35: stranded decay. A record is "stranded" once its own cell reads -1 in `roadDist` (more
   * than MAX_ROAD_DIST_CELLS cells — ~24u — from any painted road as of the last BFS recompute).
   * Runs every `update()` (not just on recompute) so grace/fade timers advance smoothly, but the
   * underlying roadDist field itself only changes when `recomputeRoadDist` runs.
   *
   * Timeline per record: not stranded -> (becomes stranded) start grace clock -> if still stranded
   * after STRANDED_GRACE_S, start fade clock + emit `growth:stranded` once -> if still stranded
   * after STRANDED_FADE_S more, remove the record, clear the cell's spawnMask bits (regrowth
   * possible), decay that cell's dev toward STRANDED_DEV_DECAY_TARGET, decrement houseCount for a
   * house, and emit `growth:remove`. Re-roading (the cell's roadDist becomes >= 0 again) at any
   * point before removal cancels both timers — the record is safe again.
   */
  private updateStrandedDecay(): void {
    if (!this.records.length) return;

    const toRemove: number[] = []; // indices into this.records, descending order for safe splice
    for (let ri = this.records.length - 1; ri >= 0; ri--) {
      const r = this.records[ri];
      // Task 42: a record already mid-corridor-clearing is owned entirely by `updateClearing`
      // below — it's never simultaneously "stranded" in any meaningful sense (a cell inside a
      // road's own corridor is, by construction, within MAX_ROAD_DIST_CELLS of that very road), but
      // guard explicitly anyway so the two pipelines can never race to remove/rescue the same id.
      if (this.clearingSince.has(r.id)) continue;
      const { i, j } = cellOf(r.x, r.z);
      const idx = cellIndex(i, j);
      const stranded = this.roadDist[idx] === -1;

      if (!stranded) {
        // Safe again — cancel any in-flight timers for this record. Critical 3 (Groundwork round
        // fix wave): only emit `growth:rescued` when a timer was ACTUALLY in flight (grace or fade)
        // — a record that was never stranded to begin with has nothing to rescue, and this branch
        // runs every tick for every non-stranded record, so gating on "was there a timer" keeps this
        // an edge-triggered event (fires once per rescue) rather than a per-tick spam.
        const wasStranded = this.strandedSince.has(r.id);
        const wasFading = this.fadingSince.has(r.id);
        if (wasStranded) this.strandedSince.delete(r.id);
        if (wasFading) this.fadingSince.delete(r.id);
        if (wasStranded || wasFading) this.bus.emit('growth:rescued', { id: r.id });
        continue;
      }

      if (!this.fadingSince.has(r.id)) {
        let since = this.strandedSince.get(r.id);
        if (since === undefined) {
          since = this.simTime;
          this.strandedSince.set(r.id, since);
        }
        if (this.simTime - since >= STRANDED_GRACE_S) {
          this.strandedSince.delete(r.id);
          this.fadingSince.set(r.id, this.simTime);
          this.bus.emit('growth:stranded', { id: r.id });
        }
        continue;
      }

      const fadeStart = this.fadingSince.get(r.id)!;
      if (this.simTime - fadeStart >= STRANDED_FADE_S) {
        this.fadingSince.delete(r.id);
        toRemove.push(ri);
      }
    }

    for (const ri of toRemove) this.removeRecordAt(ri);
  }

  /**
   * Shared removal bookkeeping for a record leaving `this.records` for good — used by both
   * stranded-decay's fade-complete path and Task 42's corridor-clearing fade-complete path (see
   * `updateClearing` below), since both ultimately do the exact same thing to the sim's state: drop
   * the record, decrement `houses` for a house, clear only that record's own spawnMask kind bit(s)
   * (Finding 1 — see `bitsForKind`'s doc comment), reset the cell's upgrade-attempted flag so a
   * future record here gets its own upgrade check, decay the cell's dev toward
   * STRANDED_DEV_DECAY_TARGET (harmless/consistent to apply here too — a corridor-cleared cell is
   * about to be permanently covered by road anyway, but keeping this uniform means a strip of
   * un-roaded ground beside the corridor that happened to share this exact cell center still regrows
   * at the same reduced pace as any other decayed cell, rather than needing a separate rule), and
   * emit `growth:remove` — the one event every consumer (SceneryRenderer's slot-freeing, TrafficSim's
   * settlement-weight eviction) already listens for, so corridor-cleared records need zero additive
   * wiring anywhere outside this file.
   */
  private removeRecordAt(ri: number): void {
    const [removed] = this.records.splice(ri, 1);
    if (removed.kind === 'house') this.houses--;
    const { i, j } = cellOf(removed.x, removed.z);
    const idx = cellIndex(i, j);
    this.spawnMask[idx] &= ~bitsForKind(removed.kind);
    this.upgradedCell[idx] = 0;
    this.dev[idx] = Math.min(this.dev[idx], STRANDED_DEV_DECAY_TARGET);
    this.bus.emit('growth:remove', { id: removed.id });
  }

  /**
   * Task 42: an edge just reached (or was restored at/past) 'graded' — find every grown record
   * overlapping the corridor around one of that edge's non-bridge samples and begin its quick
   * clearing fade (unless already clearing). Point-like records use the same center radius as
   * `WildernessSim.clearCorridor`; fields add their square footprint's circumradius so grass cannot
   * remain over asphalt merely because the field center is outside the corridor. This operates on
   * GrowthSim's own `records` (every kind — tree/field/house/building) and starts a
   * timed fade (`clearingSince`) rather than an immediate boolean flip, so the renderer gets a
   * chance to play the fade before the record actually disappears (see `updateClearing`).
   */
  /** Clears records near the edge's non-bridge samples up to arclength `upTo` (the grading
   * front's position; Infinity = the whole corridor, used by the stage-completion/restore paths).
   * Each (edge, sample) stretch is swept at most once via `corridorSweptTo`, so per-tick progress
   * events only ever test the newly passed stretch. */
  private clearCorridor(edgeId: number, upTo = Infinity): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    const from = this.corridorSweptTo.get(edgeId) ?? -1;
    if (upTo <= from) return;
    this.corridorSweptTo.set(edgeId, upTo);

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
      for (const r of this.records) {
        if (this.clearingSince.has(r.id)) continue; // already clearing — don't restart its fade
        const footprintRadius = r.kind === 'field' ? FIELD_FOOTPRINT_RADIUS : 0;
        if (Math.hypot(s.x - r.x, s.z - r.z) <= CLEAR_RADIUS + footprintRadius) {
          // Task 42: corridor clearing pre-empts stranded-decay outright — a record that happened
          // to already be mid-grace/mid-fade when the road's corridor reached it is simply
          // reclassified as "clearing" (its stranded/fading timers are irrelevant now: the road is
          // there, it's gone either way, just on the quick timeline instead of the slow one).
          this.strandedSince.delete(r.id);
          this.fadingSince.delete(r.id);
          this.clearingSince.set(r.id, this.simTime);
          this.bus.emit('growth:cleared', { id: r.id, kind: r.kind });
        }
      }
    }
  }

  /**
   * Task 42: advances every in-flight corridor-clearing fade and removes a record once
   * CLEAR_FADE_S has elapsed since its `growth:cleared` — reuses `removeRecordAt` (same
   * spawnMask/houses/dev bookkeeping and `growth:remove` emit as stranded-decay's own removal), so
   * every existing consumer of `growth:remove` (SceneryRenderer, TrafficSim) needs no changes to
   * handle corridor-cleared records. Deliberately NO rescue path exists for this map: unlike
   * `updateStrandedDecay`'s roadDist-driven rescue (a record is only ever removed if its cell STAYS
   * disconnected from roads for the full grace+fade), a corridor-cleared record's road is, by
   * definition, the reason it's clearing — there is no "safe again" state to detect here, and even
   * demolishing that same road afterward (walking its stage back to 'removed'/'surveyed') must NOT
   * resurrect the record (see this task's spec: "a cleared tree is gone").
   */
  private updateClearing(): void {
    if (!this.clearingSince.size) return;
    const toRemove: number[] = [];
    for (let ri = this.records.length - 1; ri >= 0; ri--) {
      const r = this.records[ri];
      const since = this.clearingSince.get(r.id);
      if (since === undefined) continue;
      if (this.simTime - since >= CLEAR_FADE_S) {
        this.clearingSince.delete(r.id);
        toRemove.push(ri);
      }
    }
    for (const ri of toRemove) this.removeRecordAt(ri);
  }
}
