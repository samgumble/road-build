import type { V3 } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { buildLaneGraph, findRoute } from '../roads/lanes';
import type { Lane, LaneGraph } from '../roads/lanes';
import type { SpawnRecord } from '../growth/growth';

/** Fixed palette of 8 muted car tones, picked per-car by rng. */
const COLOR_PALETTE: number[] = [
  0x8a8f94, // slate grey
  0x5c6b73, // steel blue-grey
  0x9c8060, // tan
  0x6e5a4e, // brown
  0x7a3b3b, // muted brick red
  0x455a4a, // muted green
  0x3f4a5a, // navy grey
  0xb5ab94, // sand
];

const ACCEL = 3; // u/s^2
const DECEL = 6; // u/s^2
const HARD_GAP = 5; // u, gapSpeed = 0 below this
const SOFT_GAP = 14; // u, gapSpeed reaches "unconstrained" at this gap
const GAP_SPEED_CAP = 14; // u/s, the "unconstrained" gap speed ceiling
const JUNCTION_APPROACH = 6; // u from lane end where a car must hold the junction lock
// Task 44 review finding 1 (short-lane stalls): this is a CEILING on the release point, not the
// release point itself — see `releaseAt()` below. On any lane shorter than
// JUNCTION_APPROACH + JUNCTION_RELEASE (~10u), a fixed 4u release mark sits past where the car is
// forced to brake for the NEXT junction's approach zone (which starts at `lane.length -
// JUNCTION_APPROACH`), so the car could never reach the release mark under its own power and
// always fell through to the 8s stale-lock safety net instead.
const JUNCTION_RELEASE = 4; // u into the next lane where the lock is released, on a lane long enough to reach it
const SPAWN_INTERVAL = 1; // seconds, max one spawn per second

// Task 44 (deadlock fix): "don't block the box" — a car may only ACQUIRE a junction lock if the
// lane it's about to enter has at least this much clear space ahead of wherever the car would
// enter it (s=0). This is the same HARD_GAP used for same-lane car-following, so a car never
// commits to a junction it can't actually clear — the dominant deadlock cause (circular lock+gap
// waits) never forms in the first place. See task-44-report.md for the diagnosed cycle.
const BOX_CLEARANCE = HARD_GAP;

// Task 44 (deadlock fix): safety net for any residual cycle (e.g. one that forms across more than
// two junctions, or before this fix existed in a save). A car that holds a junction lock but has
// been essentially stationary for this many sim-seconds voluntarily releases the lock and re-queues
// behind a small per-car jittered back-off (drawn from the sim rng, so it stays deterministic)
// before it's allowed to contend for a lock again. This never despawns/teleports the car — it just
// waits a bit longer, then re-tries normally.
const STALE_LOCK_TIMEOUT = 8; // sim-seconds
const STALE_SPEED_EPS = 0.05; // u/s, "essentially stationary" threshold
const STALE_BACKOFF_MIN = 0.5; // seconds
const STALE_BACKOFF_MAX = 2; // seconds

// Task 47 (Groundwork fast-follow): "lock-free ring-saturation freeze" safety net. T44's own "don't
// block the box" rule (part 2 above, `exitLaneClear`) created a NEW residual freeze mode it didn't
// anticipate: on a saturated ring where every lane's queue backs up to within BOX_CLEARANCE of s=0,
// every front car eventually reaches `releaseAt` in its OWN current lane and releases its held lock
// (the lane-scaled release fires at `releaseAt(lane)` <= 4u regardless of what's happening ahead) —
// but then can NEVER acquire the NEXT junction's lock, because `exitLaneClear` permanently fails
// (the next lane is itself jam-packed within BOX_CLEARANCE of s=0, and never clears because ITS
// front car is in the exact same situation). Once every car in the cycle has released its own lock
// this way, `junctionLocks` is completely empty — nobody holds anything — so T44's existing
// stale-lock safety net (which only arms while `c.heldNodeId !== null`) never engages for anyone,
// and the ring freezes permanently with zero locks held (distinct from T44's original leaked-lock
// deadlock, where at least one lock was always held by a phantom/live car).
//
// Fix: track how long a car has been stationary AND specifically box-blocked (i.e. every OTHER
// acquisition condition holds — it doesn't already hold a different lock, no backoff is pending —
// but `exitLaneClear` is what's failing) even though it holds NO lock at all. After
// `BOX_BLOCKED_TIMEOUT` sim-seconds of that, a small per-car seeded jittered override lets it
// acquire the lock and proceed anyway, DESPITE `exitLaneClear` failing — one car creeping forward
// is enough to open a gap and break the cycle for everyone behind it. Deliberately mirrors T44's
// existing stale-lock safety net in spirit (same timeout scale, same seeded-rng jitter so replays
// stay deterministic, never despawns/teleports) but is a genuinely separate mechanism/field since
// it must arm precisely when NO lock is held, which is the case T44's `stalledHeldSeconds` net
// structurally cannot cover.
const BOX_BLOCKED_TIMEOUT = 8; // sim-seconds
const BOX_BLOCKED_BACKOFF_MIN = 0.5; // seconds — re-applied after the override so this car doesn't
const BOX_BLOCKED_BACKOFF_MAX = 2; // seconds   immediately re-trigger every following tick either.

// Task 32: trip-endpoint weighting toward settlement nodes. Weight map recompute is throttled the
// same way GrowthSim throttles its road-distance recompute (see growth.ts's RECOMPUTE_INTERVAL
// doc comment) so a flurry of growth:spawn events during active development doesn't repeatedly
// re-scan every node's neighborhood.
const WEIGHT_RECOMPUTE_INTERVAL = 2; // sim-seconds
const SETTLEMENT_SEARCH_RADIUS = 20; // u, matches Addendum D Task 32's "within 20u" spec
const HOUSE_WEIGHT = 3;
const BUILDING_WEIGHT = 5;
const BASE_NODE_WEIGHT = 1;

// Task 32: commute pulse — spawn-interval multiplier as a function of timeOfDay (0..1, where 0/1
// is midnight). Two gaussian-ish bumps at the morning/evening commute peaks, a dip at deep night.
// Implemented as a multiplier on the spawn timer's effective rate (bigger multiplier = faster
// spawning = busier), so `SPAWN_INTERVAL` is divided by this value.
const MORNING_PEAK = 0.3;
const EVENING_PEAK = 0.75;
const PEAK_SIGMA = 0.06;
const PEAK_BUMP = 0.6; // peaks reach 1 + 0.6 = 1.6x rate
const NIGHT_CENTER = 0.95;
const NIGHT_SIGMA = 0.08;
const NIGHT_DIP = 0.6; // deep night dips toward 1 - 0.6 = 0.4x rate

/** Wrapped (circular) gaussian distance on the [0,1) timeOfDay ring. */
function wrappedGaussian(t: number, center: number, sigma: number): number {
  let d = Math.abs(t - center);
  d = Math.min(d, 1 - d); // shortest distance around the ring
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

/**
 * Rate multiplier on the spawn timer for a given timeOfDay: >1 during commute peaks (busiest ~0.3
 * and ~0.75), <1 at deep night (~0.95), 1 elsewhere. Deterministic pure function of timeOfDay.
 */
function commuteRateMultiplier(timeOfDay: number): number {
  const t = ((timeOfDay % 1) + 1) % 1; // normalize into [0,1)
  const morning = wrappedGaussian(t, MORNING_PEAK, PEAK_SIGMA);
  const evening = wrappedGaussian(t, EVENING_PEAK, PEAK_SIGMA);
  const peakBoost = PEAK_BUMP * Math.max(morning, evening);
  const night = wrappedGaussian(t, NIGHT_CENTER, NIGHT_SIGMA);
  const nightDip = NIGHT_DIP * night;
  // Peaks and night dip are mutually exclusive in practice (far apart on the ring) — combine
  // additively and clamp to a sane floor so nothing ever reaches/crosses zero.
  return Math.max(0.15, 1 + peakBoost - nightDip);
}

interface Car {
  id: number;
  route: Lane[];
  routeIndex: number;
  laneId: number;
  s: number;
  speed: number;
  color: number;
  heldNodeId: number | null; // junction node id whose lock this car currently holds, if any
  // Task 44 (deadlock fix): sim-seconds this car has continuously held heldNodeId while
  // essentially stationary (speed < STALE_SPEED_EPS). Reset to 0 whenever the car moves or
  // releases/acquires a (different) lock. Drives the stale-lock safety net.
  stalledHeldSeconds: number;
  // Task 44 (deadlock fix): sim-time (this.simTime) before which this car must not attempt to
  // acquire a NEW junction lock, set after the safety net force-releases a stale lock so the same
  // car doesn't immediately re-win the same contested lock every tick. 0 = no back-off pending.
  lockBackoffUntil: number;
  // Task 47 (lock-free ring-saturation freeze fix): sim-seconds this car has continuously been
  // stationary AND blocked specifically by the `exitLaneClear` box-clearance check (i.e. it holds
  // NO lock, every other acquisition condition already holds) — see BOX_BLOCKED_TIMEOUT's doc
  // comment. Reset to 0 whenever the car moves, acquires a lock, or is blocked for any OTHER
  // reason. Distinct from `stalledHeldSeconds` (T44), which only tracks time spent HOLDING a lock.
  boxBlockedSeconds: number;
}

export interface TrafficCar {
  id: number;
  pos: V3;
  heading: number;
  speed: number;
  color: number;
}

/** Computes position + heading at arclength `s` along a lane's offset path (`lane.points`). */
function sampleLane(lane: Lane, s: number): { pos: V3; heading: number } {
  const pts = lane.points;
  if (pts.length === 0) return { pos: { x: 0, y: 0, z: 0 }, heading: 0 };
  if (pts.length === 1) return { pos: pts[0], heading: 0 };

  const clamped = Math.max(0, Math.min(lane.length, s));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (clamped <= acc + segLen || i === pts.length - 1) {
      const u = segLen > 1e-9 ? Math.max(0, Math.min(1, (clamped - acc) / segLen)) : 0;
      const pos: V3 = {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        z: a.z + (b.z - a.z) * u,
      };
      const heading = Math.atan2(b.z - a.z, b.x - a.x);
      return { pos, heading };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  return { pos: last, heading: Math.atan2(last.z - prev.z, last.x - prev.x) };
}

/** maxSpeed at arclength `s` along a lane, interpolated across `lane.maxSpeed` (parallel to `lane.points`, and thus `edge.samples`). */
function maxSpeedAt(lane: Lane, s: number): number {
  const arr = lane.maxSpeed;
  if (arr.length === 0) return 9;
  if (arr.length === 1) return arr[0];
  const pts = lane.points;
  const clamped = Math.max(0, Math.min(lane.length, s));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (clamped <= acc + segLen || i === pts.length - 1) {
      const u = segLen > 1e-9 ? Math.max(0, Math.min(1, (clamped - acc) / segLen)) : 0;
      const va = arr[Math.min(i - 1, arr.length - 1)];
      const vb = arr[Math.min(i, arr.length - 1)];
      return va + (vb - va) * u;
    }
    acc += segLen;
  }
  return arr[arr.length - 1];
}

/**
 * Task 44 review finding 1 (short-lane stalls): the junction-lock release point, scaled down for
 * lanes shorter than `JUNCTION_APPROACH + JUNCTION_RELEASE` (~10u) so a car can actually reach it.
 *
 * The original fixed `JUNCTION_RELEASE` (4u) assumed every lane was long enough that the release
 * mark (4u in) always came BEFORE the next junction's approach zone (which starts
 * `JUNCTION_APPROACH` = 6u before the lane's end, i.e. at `lane.length - JUNCTION_APPROACH`).
 * That's false on any lane shorter than ~10u: the approach zone to the NEXT node starts before
 * s=4, so a car holding the PREVIOUS node's lock hits "must acquire the next lock, but still
 * holding this one" (the hold-one-lock rule) before it ever reaches the release mark — the
 * approach check forces its target speed to 0 (see `blockedByJunction` below) and it brakes to a
 * stop short of s=4, permanently: `c.s` stops advancing once speed hits 0, so it can never cross
 * the release mark under its own power either. It falls through to the 8s stale-lock safety net
 * instead of recovering promptly, every single time this geometry occurs. Loop halves and short
 * blocks are routinely this short.
 *
 * `lane.length * 0.4` (40% into the lane) is the primary, geometric term: ROAD_WIDTH is 6u, so a
 * junction's physical footprint (where two roads of that width cross) has a radius of roughly
 * ROAD_WIDTH / 2 = 3u from the node center. A car 40% into even the shortest lanes this fix
 * targets (e.g. 8u, per the review finding's example geometry) is already ~3.2u past the node it
 * just left — physically clear of the junction footprint, exactly the intent `JUNCTION_RELEASE`
 * was always going for on longer lanes.
 *
 * That alone isn't sufficient, though: 40% of an 8u lane is s=3.2, which is still PAST where the
 * NEXT junction's approach zone begins (s = 8 - 6 = 2) — a car would still brake to a stop at
 * s≈2..3.2 before ever reaching the release mark, same bug, just a narrower window. The second
 * `lane.length - JUNCTION_APPROACH` term is the actual correctness clamp: it caps the release
 * point so it never sits inside (or past) the next junction's approach zone, guaranteeing the car
 * can always physically reach `releaseAt` before the approach check could ever force it to stop.
 * Floored at 0 for lanes shorter than JUNCTION_APPROACH itself (release is then immediate — there
 * is no room to be anywhere in the lane without also being in next junction's approach zone).
 * Lanes at or above the original ~10u threshold are unaffected (neither `Math.min` term is
 * smaller than `JUNCTION_RELEASE` there), so this only changes behavior on the short lanes that
 * were actually broken.
 */
function releaseAt(lane: Lane): number {
  return Math.max(0, Math.min(JUNCTION_RELEASE, lane.length * 0.4, lane.length - JUNCTION_APPROACH));
}

/**
 * Ambient traffic simulation: spawns cars between random node pairs, routes them via the lane
 * graph, and advances them along their route with simple car-following (gap-based speed limiting)
 * and single-slot junction locks so cars queue and take turns at intersections rather than
 * clipping through each other. Sim-only — no `three` imports.
 */
export class TrafficSim {
  targetPopulation = 6;

  private lg: LaneGraph;
  private cs: Car[] = [];
  private nextId = 1;
  private spawnTimer = 0;
  private junctionLocks = new Map<number, number>(); // nodeId -> carId holding the lock
  private awaitingFirstUse = new Set<number>();

  // Task 32: settlement positions accumulated from growth:spawn (houses/buildings only), used to
  // build a per-node weight map for trip-endpoint selection. Recompute is throttled the same way
  // GrowthSim throttles its own road-distance recompute.
  //
  // Task 35 (additive): each entry now also carries the growth record's `id` (when the emitting
  // GrowthSim provides one — see events.ts's doc comment on `growth:spawn`'s optional `id`) so a
  // later `growth:upgrade`/`growth:remove` for that id can find and evict/move the right entry
  // instead of these arrays only ever growing. Entries with no id (id undefined — an older/test
  // caller emitting the event by hand) simply can never be evicted this way, matching prior
  // behavior exactly for those callers.
  private houses: Array<{ x: number; z: number; id?: number }> = [];
  private buildings: Array<{ x: number; z: number; id?: number }> = [];
  private nodeWeights = new Map<number, number>();
  private totalWeight = 0;
  private simTime = 0;
  private lastWeightRecomputeAt = -Infinity;
  private weightRecomputePending = true; // compute once up front even with no settlements yet

  constructor(
    private graph: RoadGraph,
    private bus: EventBus,
    private rng: () => number,
  ) {
    this.lg = buildLaneGraph(this.graph);
    bus.on('roads:changed', () => this.onRoadsChanged());
    bus.on('roads:edgeRemoved', ({ edgeId }) => this.awaitingFirstUse.delete(edgeId));
    bus.on('construction:stage', ({ edgeId, stage, crew }) => {
      if (stage === 'painted' && crew >= 0) this.awaitingFirstUse.add(edgeId);
      else if (stage === 'removed') this.awaitingFirstUse.delete(edgeId);
    });
    bus.on('growth:spawn', (e) => {
      if (e.kind === 'house') this.houses.push({ x: e.x, z: e.z, id: e.id });
      else if (e.kind === 'building') this.buildings.push({ x: e.x, z: e.z, id: e.id });
      else return;
      this.weightRecomputePending = true;
    });
    // Task 35: a house upgraded to a building — move its entry from `houses` to `buildings` rather
    // than leaving a stale house-weight entry at that position forever.
    bus.on('growth:upgrade', (e) => {
      const i = this.houses.findIndex((h) => h.id === e.id);
      if (i === -1) return;
      const [moved] = this.houses.splice(i, 1);
      this.buildings.push(moved);
      this.weightRecomputePending = true;
    });
    // Task 35: a stranded record was fully removed — drop it from whichever array holds its id so
    // the weight map stops crediting a settlement that no longer exists.
    bus.on('growth:remove', (e) => {
      const beforeH = this.houses.length;
      this.houses = this.houses.filter((h) => h.id !== e.id);
      const beforeB = this.buildings.length;
      this.buildings = this.buildings.filter((b) => b.id !== e.id);
      if (this.houses.length !== beforeH || this.buildings.length !== beforeB) {
        this.weightRecomputePending = true;
      }
    });
  }

  /**
   * Important 4 (Groundwork round fix wave): seeds `houses`/`buildings` from a restored world's
   * `growth.spawned` records — mirrors the constructor's `growth:spawn` handler exactly (same
   * kind/x/z/id extraction), just applied in bulk to records that already existed at save time
   * rather than arriving one at a time via live events. Without this, `houses`/`buildings` only
   * ever grew via that live event, so reloading a save with an established settlement reset traffic
   * weighting back to uniform (as if nothing had ever been built) until fresh houses/buildings grew
   * again in the newly-loaded world — a save/reload regression a player would read as "my town lost
   * its traffic" even though the buildings themselves were all still there.
   *
   * Called once in main.ts right after `restoreWorld` (which is itself responsible for restoring
   * `growth.spawned` in the first place — this method only reads that already-restored list, it
   * doesn't touch GrowthSim at all). REPLACES (not appends to) any existing `houses`/`buildings`
   * state, matching `rebuild()`'s "full rebuild from a saved list" semantics elsewhere in this
   * codebase (see SceneryRenderer.rebuild) — there is no live traffic state worth preserving across
   * a restore, since restore only ever happens once, at boot, before any live `growth:spawn` could
   * have fired.
   */
  restore(spawned: ReadonlyArray<SpawnRecord>): void {
    this.houses = [];
    this.buildings = [];
    for (const r of spawned) {
      if (r.kind === 'house') this.houses.push({ x: r.x, z: r.z, id: r.id });
      else if (r.kind === 'building') this.buildings.push({ x: r.x, z: r.z, id: r.id });
    }
    this.weightRecomputePending = true;
  }

  private onRoadsChanged(): void {
    this.lg = buildLaneGraph(this.graph);
    // Any car whose current lane no longer exists in the rebuilt graph is despawned (its
    // underlying edge was removed); release any junction lock it held.
    this.cs = this.cs.filter((c) => {
      const stillValid = this.lg.lanes.has(c.laneId);
      if (!stillValid) this.releaseLock(c);
      return stillValid;
    });
    // Nodes changed — the weight map keys (node ids) may now be stale/incomplete; recompute on
    // the same throttle as growth-driven recomputes.
    this.weightRecomputePending = true;
  }

  /** Recomputes `nodeWeights`/`totalWeight` from current node positions + settlement records. */
  private recomputeWeights(): void {
    this.nodeWeights.clear();
    this.totalWeight = 0;
    for (const [nodeId, pos] of this.lg.nodePos) {
      let housesNear = 0;
      let buildingsNear = 0;
      for (const h of this.houses) {
        if (Math.hypot(h.x - pos.x, h.z - pos.z) <= SETTLEMENT_SEARCH_RADIUS) housesNear++;
      }
      for (const b of this.buildings) {
        if (Math.hypot(b.x - pos.x, b.z - pos.z) <= SETTLEMENT_SEARCH_RADIUS) buildingsNear++;
      }
      const weight = BASE_NODE_WEIGHT + HOUSE_WEIGHT * housesNear + BUILDING_WEIGHT * buildingsNear;
      this.nodeWeights.set(nodeId, weight);
      this.totalWeight += weight;
    }
  }

  private releaseLock(c: Car): void {
    if (c.heldNodeId !== null) {
      if (this.junctionLocks.get(c.heldNodeId) === c.id) this.junctionLocks.delete(c.heldNodeId);
      c.heldNodeId = null;
    }
    c.stalledHeldSeconds = 0;
  }

  /**
   * Draws one node id. Weighted by `nodeWeights` when a settlement exists (totalWeight > 0);
   * uniform fallback otherwise (no settlement yet, or a degenerate all-zero weight map).
   */
  private drawNode(nodeIds: number[]): number {
    if (this.totalWeight <= 0) {
      return nodeIds[Math.floor(this.rng() * nodeIds.length)];
    }
    let r = this.rng() * this.totalWeight;
    for (const id of nodeIds) {
      const w = this.nodeWeights.get(id) ?? BASE_NODE_WEIGHT;
      r -= w;
      if (r <= 0) return id;
    }
    // Floating-point fallthrough (r ends up just barely positive) — return the last node.
    return nodeIds[nodeIds.length - 1];
  }

  private pickSpawnPair(): { from: number; to: number; route: Lane[] } | null {
    if (this.weightRecomputePending && this.simTime - this.lastWeightRecomputeAt >= WEIGHT_RECOMPUTE_INTERVAL) {
      this.recomputeWeights();
      this.lastWeightRecomputeAt = this.simTime;
      this.weightRecomputePending = false;
    }

    const nodeIds = [...this.lg.nodePos.keys()];
    if (nodeIds.length < 2) return null;
    // Bounded attempts to find a distinct, routable pair. Origin and destination are drawn
    // independently (each its own weighted draw) — still require distinct + routable.
    for (let attempt = 0; attempt < 20; attempt++) {
      const from = this.drawNode(nodeIds);
      const to = this.drawNode(nodeIds);
      if (from === to) continue;
      const route = findRoute(this.lg, from, to);
      if (route && route.length > 0) return { from, to, route };
    }
    return null;
  }

  /** True if spawning at s=0 on `laneId` would land within HARD_GAP of an existing car. */
  private spawnPointClear(laneId: number): boolean {
    for (const c of this.cs) {
      if (c.laneId !== laneId) continue;
      if (c.s < HARD_GAP) return false;
    }
    return true;
  }

  private trySpawn(): void {
    if (this.cs.length >= this.targetPopulation) return;
    const picked = this.pickSpawnPair();
    if (!picked) return;
    const firstLaneId = picked.route[0].id;
    if (!this.spawnPointClear(firstLaneId)) return;
    const color = COLOR_PALETTE[Math.floor(this.rng() * COLOR_PALETTE.length)];
    const car: Car = {
      id: this.nextId++,
      route: picked.route,
      routeIndex: 0,
      laneId: firstLaneId,
      s: 0,
      speed: 0,
      color,
      heldNodeId: null,
      stalledHeldSeconds: 0,
      lockBackoffUntil: 0,
      boxBlockedSeconds: 0,
    };
    this.cs.push(car);
    this.emitEdgeEntered(car, picked.route[0]);
  }

  private emitEdgeEntered(car: Car, lane: Lane): void {
    const firstUse = this.awaitingFirstUse.delete(lane.edgeId);
    const { pos } = sampleLane(lane, car.s);
    this.bus.emit('traffic:edgeEntered', { edgeId: lane.edgeId, carId: car.id, pos, firstUse });
  }

  /** Nearest car ahead of `c` on the same lane (larger `s`), or null if none. */
  private gapAhead(c: Car): number | null {
    let best: number | null = null;
    for (const other of this.cs) {
      if (other === c) continue;
      if (other.laneId !== c.laneId) continue;
      if (other.s <= c.s) continue;
      const gap = other.s - c.s;
      if (best === null || gap < best) best = gap;
    }
    return best;
  }

  private gapSpeedFor(gap: number | null): number {
    if (gap === null) return Infinity;
    if (gap <= HARD_GAP) return 0;
    if (gap >= SOFT_GAP) return GAP_SPEED_CAP;
    const u = (gap - HARD_GAP) / (SOFT_GAP - HARD_GAP);
    return GAP_SPEED_CAP * u;
  }

  /**
   * Task 44 (deadlock fix), "don't block the box": true if entering `lane` at s=0 right now would
   * land at least BOX_CLEARANCE clear of the nearest car already on it. A car is only allowed to
   * ACQUIRE a junction lock when this holds for the lane it's about to commit to — otherwise it
   * would sit in the intersection holding the lock while unable to actually clear it, which is
   * exactly how the circular lock+gap wait cycles formed (see task-44-report.md). Looking at the
   * lane's occupancy directly (rather than only the lock) also naturally covers single-lane loops
   * back to the same node, since the "next lane" occupancy is checked regardless of who owns its
   * lock.
   */
  private exitLaneClear(laneId: number): boolean {
    for (const other of this.cs) {
      if (other.laneId !== laneId) continue;
      if (other.s < BOX_CLEARANCE) return false;
    }
    return true;
  }

  /**
   * Advances the sim by `dt` seconds. `timeOfDay` (0..1, render-side Atmosphere state) drives the
   * commute-pulse spawn-rate multiplier — the sim itself stays a pure function of its inputs
   * (no wall-clock reads), so passing the same `dt`/`timeOfDay` sequence twice is deterministic.
   * Defaults to a neutral timeOfDay (no pulse) for callers/tests that don't care about commute
   * timing.
   */
  update(dt: number, timeOfDay = 0): void {
    this.simTime += dt;
    const effectiveInterval = SPAWN_INTERVAL / commuteRateMultiplier(timeOfDay);
    this.spawnTimer += dt;
    while (this.spawnTimer >= effectiveInterval) {
      this.spawnTimer -= effectiveInterval;
      this.trySpawn();
    }

    const toDespawn: Car[] = [];

    for (const c of this.cs) {
      const lane = this.lg.lanes.get(c.laneId);
      if (!lane) {
        toDespawn.push(c);
        continue;
      }

      const isLastLane = c.routeIndex >= c.route.length - 1;
      const distToLaneEnd = lane.length - c.s;

      // Release the PREVIOUS junction's lock once `releaseAt(lane)` into the current lane — lane-
      // scaled (see `releaseAt`'s doc comment; Task 44 review finding 1) so short lanes release
      // before the approach-zone check below can ever see this car still holding it. Checked here,
      // BEFORE the acquire attempt for the NEXT junction (rather than only at the end of the tick,
      // as originally), so a release earned by last tick's movement actually counts this tick —
      // otherwise a short lane could sit exactly on the acquire branch's `heldNodeId === null`
      // check with a lock it was already geometrically entitled to have released.
      if (c.heldNodeId !== null && lane.from === c.heldNodeId && c.s >= releaseAt(lane)) {
        this.releaseLock(c);
      }

      // Junction lock handling: within JUNCTION_APPROACH of the lane end and there IS a next
      // lane (i.e. not the final lane of the route), the car must hold the lock on `lane.to`
      // to be allowed to proceed past the approach point.
      let blockedByJunction = false;
      // Task 47: set inside the acquisition branch below when this car's ONLY obstacle to
      // acquiring the next junction's lock is `exitLaneClear` failing — read just after this block
      // to accumulate/reset `c.boxBlockedSeconds`. Declared out here (rather than only inside the
      // `if`) so a car that ISN'T even within JUNCTION_APPROACH this tick (the common case) also
      // correctly resets its streak below, same as `stalledHeldSeconds` already does for the
      // "no lock held" case.
      let boxBlockedOnly = false;
      if (!isLastLane && distToLaneEnd <= JUNCTION_APPROACH) {
        const nodeId = lane.to;
        const holder = this.junctionLocks.get(nodeId);
        if (holder === undefined) {
          // Task 44 (deadlock fix), part 1: never acquire a second lock while still holding one.
          // Two back-to-back short lanes could otherwise put a car within JUNCTION_APPROACH of the
          // NEXT node before it had reached JUNCTION_RELEASE into the lane that carries the lock it
          // already holds — silently overwriting `heldNodeId` and leaking the first lock forever
          // (it belonged to no car that would ever release it). Refusing to acquire until the
          // current lock is released removes THAT leak at the source — but on its own it does NOT
          // close the underlying situation "outright": on a lane shorter than
          // JUNCTION_APPROACH + JUNCTION_RELEASE (~10u), refusing to acquire just means the car
          // brakes to a stop instead of leaking a lock, and — with the ORIGINAL fixed
          // JUNCTION_RELEASE release point — it could never reach that release mark on its own,
          // so it sat there for the full STALE_LOCK_TIMEOUT (8s) every time this geometry occurred
          // (loop halves and short blocks routinely are this short). See `releaseAt()`'s doc
          // comment (Task 44 review finding 1) for the lane-scaled release point that actually
          // closes this stall, rather than merely trading a permanent leak for a repeated 8s wait.
          //
          // Task 44 (deadlock fix), part 2: "don't block the box" — also require the exit lane
          // (`c.route[c.routeIndex + 1]`) to have clear space before committing to the junction, so
          // a car never sits in the intersection holding the lock while itself gap-blocked on the
          // far side. Combined with part 1 this prevents essentially all lock+gap circular waits.
          //
          // Task 44 (deadlock fix), part 3: honor a pending back-off from the stale-lock safety net
          // (see below) so a car that was just force-released doesn't immediately re-win the same
          // contested lock on the very next tick.
          const nextLane = c.route[c.routeIndex + 1];
          const notHoldingAnother = c.heldNodeId === null;
          const backoffClear = c.lockBackoffUntil <= this.simTime;
          const exitClear = !nextLane || this.exitLaneClear(nextLane.id);
          // Task 47 (lock-free ring-saturation freeze fix): this car is "box-blocked-only" when
          // every OTHER acquisition condition already holds and `exitLaneClear` is the SOLE
          // reason it can't acquire — i.e. exactly the state that can never resolve on its own on
          // a saturated ring (see BOX_BLOCKED_TIMEOUT's doc comment). A car failing for any OTHER
          // reason (already holding a different lock, or still in its post-stale-release backoff)
          // is a different situation with its own resolution path (T44's release/backoff cycle),
          // so it does NOT accumulate box-blocked time here.
          boxBlockedOnly = notHoldingAnother && backoffClear && !exitClear;
          const forceOverride = boxBlockedOnly && c.boxBlockedSeconds >= BOX_BLOCKED_TIMEOUT;
          const canAcquire = notHoldingAnother && backoffClear && (exitClear || forceOverride);
          if (canAcquire) {
            this.junctionLocks.set(nodeId, c.id);
            c.heldNodeId = nodeId;
            c.boxBlockedSeconds = 0;
            if (forceOverride) {
              // Same jittered-backoff shape as T44's stale-lock net: this car got a one-time
              // override, not a standing exemption — give it a small seeded cooldown before it can
              // trigger ANOTHER override, so a single persistently-congested car doesn't just
              // repeatedly re-trigger the override every tick once the timeout is first crossed.
              c.lockBackoffUntil = this.simTime + BOX_BLOCKED_BACKOFF_MIN + this.rng() * (BOX_BLOCKED_BACKOFF_MAX - BOX_BLOCKED_BACKOFF_MIN);
            }
          } else {
            blockedByJunction = true;
          }
        } else if (holder !== c.id) {
          blockedByJunction = true;
        } else {
          c.heldNodeId = nodeId;
        }
      }

      // Task 44 (deadlock fix), safety net: track how long this car has held a lock while
      // essentially stationary. If it crosses STALE_LOCK_TIMEOUT, force-release the lock and
      // apply a small seeded jittered back-off before it may contend for a (any) lock again —
      // breaks any residual cycle that part 1/2 above didn't prevent outright (e.g. one spanning
      // more than two junctions), without ever teleporting or despawning the car. Runs BEFORE the
      // gap/target-speed calculation below so a force-release this tick correctly re-blocks the car
      // (it no longer holds the lock it still needs) rather than letting it surge forward on a lock
      // it just gave up.
      if (c.heldNodeId !== null) {
        if (c.speed < STALE_SPEED_EPS) {
          c.stalledHeldSeconds += dt;
          if (c.stalledHeldSeconds >= STALE_LOCK_TIMEOUT) {
            this.releaseLock(c);
            c.lockBackoffUntil = this.simTime + STALE_BACKOFF_MIN + this.rng() * (STALE_BACKOFF_MAX - STALE_BACKOFF_MIN);
            if (!isLastLane && distToLaneEnd <= JUNCTION_APPROACH) blockedByJunction = true;
          }
        } else {
          c.stalledHeldSeconds = 0;
        }
      }

      // Task 47 (lock-free ring-saturation freeze fix), safety net: track how long this car has
      // been stationary AND box-blocked-only (see `boxBlockedOnly` above) — i.e. holding NO lock,
      // with `exitLaneClear` the sole reason it can't acquire the next one. This is the state T44's
      // own `stalledHeldSeconds` net structurally cannot cover (that net only arms while
      // `heldNodeId !== null`). Once every car in a saturated ring's cycle reaches this state
      // simultaneously, `junctionLocks` is completely empty and nobody can ever acquire again
      // without an outside nudge — `forceOverride` (computed above, inside the acquisition branch)
      // is that nudge, applied the very next time this same car reaches the acquisition check
      // (next tick) once its streak crosses BOX_BLOCKED_TIMEOUT. Reset whenever the car moves,
      // isn't box-blocked-only this tick, or successfully acquires (handled above).
      if (boxBlockedOnly && c.speed < STALE_SPEED_EPS) {
        c.boxBlockedSeconds += dt;
      } else if (!boxBlockedOnly) {
        c.boxBlockedSeconds = 0;
      }

      const gap = this.gapAhead(c);
      const gapSpeed = blockedByJunction ? 0 : this.gapSpeedFor(gap);
      const laneCap = maxSpeedAt(lane, c.s);
      const targetSpeed = Math.min(laneCap, gapSpeed);

      if (c.speed < targetSpeed) {
        c.speed = Math.min(targetSpeed, c.speed + ACCEL * dt);
      } else if (c.speed > targetSpeed) {
        c.speed = Math.max(targetSpeed, c.speed - DECEL * dt);
      }

      c.s += c.speed * dt;

      if (c.s >= lane.length) {
        if (isLastLane) {
          // Reached the end of the route — despawn.
          toDespawn.push(c);
          continue;
        }
        // Advance to next lane in the route.
        const overflow = c.s - lane.length;
        c.routeIndex += 1;
        const nextLane = c.route[c.routeIndex];
        c.laneId = nextLane.id;
        c.s = overflow;
        if (nextLane.edgeId !== lane.edgeId) this.emitEdgeEntered(c, nextLane);
      }

      // Release lock once `releaseAt(currentLane)` into the (possibly just-entered) next lane.
      // This mirrors the same check at the top of the loop, needed here too for a car that both
      // enters a new lane AND clears `releaseAt` for it within this same tick (e.g. a very short
      // lane fully crossed in one tick) — the top-of-loop check only sees last tick's lane/s.
      if (c.heldNodeId !== null) {
        const currentLane = this.lg.lanes.get(c.laneId);
        const enteredNextLane = currentLane && currentLane.from === c.heldNodeId;
        if (enteredNextLane && c.s >= releaseAt(currentLane)) {
          this.releaseLock(c);
        }
      }
    }

    if (toDespawn.length) {
      for (const c of toDespawn) this.releaseLock(c);
      const despawnIds = new Set(toDespawn.map((c) => c.id));
      this.cs = this.cs.filter((c) => !despawnIds.has(c.id));
    }
  }

  get cars(): ReadonlyArray<TrafficCar> {
    return this.cs.map((c) => {
      const lane = this.lg.lanes.get(c.laneId);
      if (!lane) return { id: c.id, pos: { x: 0, y: 0, z: 0 }, heading: 0, speed: c.speed, color: c.color };
      const { pos, heading } = sampleLane(lane, c.s);
      return { id: c.id, pos, heading, speed: c.speed, color: c.color };
    });
  }

  laneAndS(carId: number): { laneId: number; s: number } | null {
    const c = this.cs.find((x) => x.id === carId);
    if (!c) return null;
    return { laneId: c.laneId, s: c.s };
  }
}
