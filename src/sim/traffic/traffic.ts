import type { V3 } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { buildLaneGraph, findRoute } from '../roads/lanes';
import type { Lane, LaneGraph } from '../roads/lanes';

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
const JUNCTION_RELEASE = 4; // u into the next lane where the lock is released
const SPAWN_INTERVAL = 1; // seconds, max one spawn per second

interface Car {
  id: number;
  route: Lane[];
  routeIndex: number;
  laneId: number;
  s: number;
  speed: number;
  color: number;
  heldNodeId: number | null; // junction node id whose lock this car currently holds, if any
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

  constructor(
    private graph: RoadGraph,
    bus: EventBus,
    private rng: () => number,
  ) {
    this.lg = buildLaneGraph(this.graph);
    bus.on('roads:changed', () => this.onRoadsChanged());
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
  }

  private releaseLock(c: Car): void {
    if (c.heldNodeId !== null) {
      if (this.junctionLocks.get(c.heldNodeId) === c.id) this.junctionLocks.delete(c.heldNodeId);
      c.heldNodeId = null;
    }
  }

  private pickSpawnPair(): { from: number; to: number; route: Lane[] } | null {
    const nodeIds = [...this.lg.nodePos.keys()];
    if (nodeIds.length < 2) return null;
    // Bounded attempts to find a distinct pair with a valid route.
    for (let attempt = 0; attempt < 20; attempt++) {
      const from = nodeIds[Math.floor(this.rng() * nodeIds.length)];
      const to = nodeIds[Math.floor(this.rng() * nodeIds.length)];
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
    };
    this.cs.push(car);
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

  update(dt: number): void {
    this.spawnTimer += dt;
    while (this.spawnTimer >= SPAWN_INTERVAL) {
      this.spawnTimer -= SPAWN_INTERVAL;
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

      // Junction lock handling: within JUNCTION_APPROACH of the lane end and there IS a next
      // lane (i.e. not the final lane of the route), the car must hold the lock on `lane.to`
      // to be allowed to proceed past the approach point.
      let blockedByJunction = false;
      if (!isLastLane && distToLaneEnd <= JUNCTION_APPROACH) {
        const nodeId = lane.to;
        const holder = this.junctionLocks.get(nodeId);
        if (holder === undefined) {
          this.junctionLocks.set(nodeId, c.id);
          c.heldNodeId = nodeId;
        } else if (holder !== c.id) {
          blockedByJunction = true;
        } else {
          c.heldNodeId = nodeId;
        }
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
      }

      // Release lock once 4u into the (possibly just-entered) next lane.
      if (c.heldNodeId !== null) {
        const currentLane = this.lg.lanes.get(c.laneId);
        const enteredNextLane = currentLane && currentLane.from === c.heldNodeId;
        if (enteredNextLane && c.s >= JUNCTION_RELEASE) {
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
