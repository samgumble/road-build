import type { P2 } from '../../core/types';
import { EventBus } from '../../core/events';
import { RoadGraph } from '../roads/graph';
import { Heightfield } from '../terrain/heightfield';
import { GRID_SIZE, CELL, WORLD_SIZE, ROAD_WIDTH } from '../../core/constants';

const HALF = WORLD_SIZE / 2;

const RECOMPUTE_INTERVAL = 2; // sim-seconds, throttle for distance-field recompute on roads:changed
const MAX_ROAD_DIST_CELLS = 6; // ~24u; cells beyond this never accumulate development
const DEV_RATE_BASE = 0.008;
const DEV_RATE_DIST_DIVISOR = 7;
const MAX_SLOPE = 0.5;

const JITTER = 1.5; // u
const MIN_ROAD_CLEARANCE = 5; // u, spawns are pushed away from road samples closer than this

export type GrowthKind = 'tree' | 'field' | 'house' | 'building';

interface Threshold {
  value: number;
  bit: number;
  kind: GrowthKind;
}

// Order matters: checked ascending so lower thresholds are guaranteed to have already fired
// (and thus their spawn events precede) higher ones for any given cell.
const THRESHOLDS: Threshold[] = [
  { value: 0.25, bit: 1 << 0, kind: 'tree' },
  { value: 0.5, bit: 1 << 1, kind: 'field' },
  { value: 0.75, bit: 1 << 2, kind: 'house' },
  { value: 0.95, bit: 1 << 3, kind: 'building' },
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

        const rate = DEV_RATE_BASE * (1 - d / DEV_RATE_DIST_DIVISOR);
        if (rate <= 0) continue;
        this.dev[idx] += dt * rate;

        const mask = this.spawnMask[idx];
        const level = this.dev[idx];
        for (const th of THRESHOLDS) {
          if (level < th.value) break;
          if (mask & th.bit) continue;
          this.spawnMask[idx] |= th.bit;
          if (th.kind === 'tree') {
            const count = 2 + Math.floor(this.rng() * 2); // 2-3
            for (let k = 0; k < count; k++) this.spawn('tree', x, z);
          } else {
            this.spawn(th.kind, x, z);
          }
        }
      }
    }
  }
}
