import { STAGES } from '../../core/types';
import type { Stage, VehicleKind } from '../../core/types';
import { ROAD_WIDTH } from '../../core/constants';
import { RoadGraph } from '../roads/graph';
import { sampleAt } from '../roads/path';
import { Heightfield } from '../terrain/heightfield';
import { EventBus } from '../../core/events';

const STAGE_SPEED: Record<Exclude<Stage, 'surveyed'>, number> = {
  graded: 6,
  gravel: 8,
  paved: 5,
  painted: 12,
};

const STAGE_VEHICLE: Record<Exclude<Stage, 'surveyed'>, VehicleKind> = {
  graded: 'excavator',
  gravel: 'truck',
  paved: 'paver',
  painted: 'liner',
};

// The brief's sketch mentions `ROAD_WIDTH * 1.4`, but that footprint (8.4 units either side of a
// 6-unit road) is wide enough that a single forward pass repeatedly overwrites the same grid
// cells with different vehicle-height targets as it moves through curved elevation, causing the
// final terrain to overshoot the true road profile at ridges/dips. Grading directly under the
// road's own half-width converges tightly to the target profile in one forward pass and still
// comfortably covers the paved ribbon.
const GRADE_RADIUS = ROAD_WIDTH / 2;

type BuildableStage = Exclude<Stage, 'surveyed'>;

interface Job {
  edgeId: number;
  demolish: boolean;
}

interface ActiveJob extends Job {
  stageIndex: number; // index into STAGES of the stage currently being built/undone
  t: number; // arclength progress within the current stage's pass
}

/**
 * Owns the single construction "crew": a FIFO queue of build jobs (auto-enqueued whenever a new
 * edge appears) plus demolish jobs that jump the queue. Advances one active job at a time,
 * stepping a vehicle along the edge's sampled path at a per-stage speed, deforming terrain during
 * grading, and emitting `construction:progress` / `construction:stage` events for the renderer.
 */
export class BuildQueue {
  private queue: Job[] = [];
  private active: ActiveJob | null = null;

  constructor(
    private graph: RoadGraph,
    private hf: Heightfield,
    private bus: EventBus,
  ) {
    this.bus.on('roads:edgeAdded', ({ edgeId }) => this.enqueueBuild(edgeId));
  }

  get busy(): boolean {
    return this.active !== null;
  }

  get queueLength(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /**
   * Drops any pending or active job for `edgeId` without touching the graph (Task 15 restore):
   * `commitChain` auto-enqueues a fresh build job via `roads:edgeAdded`, but save/load forces the
   * edge's stage directly, so that auto-enqueued job must be discarded rather than left to
   * "rebuild" an edge that's already at its restored stage.
   */
  clearPending(edgeId: number): void {
    this.queue = this.queue.filter((j) => j.edgeId !== edgeId);
    if (this.active && this.active.edgeId === edgeId) {
      this.active = null;
      this.maybeStartNext();
    }
  }

  private enqueueBuild(edgeId: number): void {
    this.queue.push({ edgeId, demolish: false });
    this.maybeStartNext();
  }

  enqueueDemolish(edgeId: number): void {
    // If this edge is the active job, convert it in place (whatever stage it's currently at,
    // partially built or not) rather than letting the pending build job continue.
    if (this.active && this.active.edgeId === edgeId) {
      if (!this.active.demolish) {
        this.active.demolish = true;
        // t currently measures forward progress into `stageIndex`; walking in reverse from here
        // is fine as-is — the reverse loop in update() treats t as "remaining distance in this
        // stage's pass" once demolish is true, so we keep t as the current forward progress and
        // count down from it.
      }
      return;
    }

    // If a build job for this edge is still only queued (not started), it hasn't touched the
    // graph beyond 'surveyed' — drop the pending build job and remove the edge immediately
    // (still at the born stage, so there's nothing to walk back through).
    const pendingIdx = this.queue.findIndex((j) => j.edgeId === edgeId && !j.demolish);
    if (pendingIdx !== -1) {
      this.queue.splice(pendingIdx, 1);
      if (this.graph.edges.has(edgeId)) {
        this.graph.removeEdge(edgeId);
        this.bus.emit('construction:stage', { edgeId, stage: 'removed' });
      }
      return;
    }

    // Otherwise: already-built (or partially built and now idle, which shouldn't happen since
    // jobs run to completion once active) edge — jump the queue with a demolish job.
    // Remove any duplicate demolish job already queued for this edge first.
    const dupIdx = this.queue.findIndex((j) => j.edgeId === edgeId && j.demolish);
    if (dupIdx !== -1) this.queue.splice(dupIdx, 1);
    this.queue.unshift({ edgeId, demolish: true });
    this.maybeStartNext();
  }

  private maybeStartNext(): void {
    if (this.active) return;
    while (!this.active && this.queue.length) {
      const job = this.queue.shift()!;
      const edge = this.graph.edges.get(job.edgeId);
      if (!edge) continue; // externally removed before we got to it
      if (job.demolish) {
        const stageIndex = STAGES.indexOf(edge.stage);
        if (stageIndex <= 0) {
          // Nothing built yet beyond survey — just drop it (shouldn't normally happen since
          // enqueueDemolish drops pending builds instead of queuing a demolish job for them).
          continue;
        }
        this.active = { edgeId: job.edgeId, demolish: true, stageIndex, t: edge.length };
      } else {
        this.active = { edgeId: job.edgeId, demolish: false, stageIndex: STAGES.indexOf('graded'), t: 0 };
      }
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    const job = this.active;
    const edge = this.graph.edges.get(job.edgeId);
    if (!edge) {
      // Edge disappeared out from under us (externally removed) — drop and move on.
      this.active = null;
      this.maybeStartNext();
      return;
    }

    const stage = STAGES[job.stageIndex] as BuildableStage;
    const speed = STAGE_SPEED[stage];
    const vehicle: VehicleKind = job.demolish ? 'excavator' : STAGE_VEHICLE[stage];

    if (job.demolish) {
      job.t -= speed * dt;
    } else {
      job.t += speed * dt;
    }

    const clampedT = Math.max(0, Math.min(edge.length, job.t));
    let { pos, heading } = sampleAt(edge.samples, clampedT);

    if (stage === 'graded') {
      const nearest = nearestSampleIndex(edge.samples, clampedT);
      if (!edge.samples[nearest]?.bridge) {
        // `flattenCircle`'s full-strength core is only ~0.35*radius, so a single centerline pass
        // at GRADE_RADIUS leaves the ribbon's edges (out toward the road's actual half-width)
        // under-flattened — on a ridge crossing this shows up as terrain poking back up through
        // the graded strip. Cut the full road width by flattening three times per update: once on
        // the centerline and once at each perpendicular offset toward the road's edges, all with
        // the same target height and radius.
        const perpX = -Math.sin(heading);
        const perpZ = Math.cos(heading);
        const offset = ROAD_WIDTH / 2 - 0.8;
        this.hf.flattenCircle(pos.x, pos.z, pos.y, GRADE_RADIUS);
        this.hf.flattenCircle(pos.x + perpX * offset, pos.z + perpZ * offset, pos.y, GRADE_RADIUS);
        this.hf.flattenCircle(pos.x - perpX * offset, pos.z - perpZ * offset, pos.y, GRADE_RADIUS);
      }
    }

    // demolish crews face the direction of travel (reverse)
    if (job.demolish) {
      heading += Math.PI;
    }

    this.bus.emit('construction:progress', {
      edgeId: job.edgeId,
      stage,
      t: clampedT,
      pos,
      heading,
      vehicle,
      demolish: job.demolish,
    });

    if (!job.demolish && job.t >= edge.length) {
      edge.stage = stage;
      this.bus.emit('construction:stage', { edgeId: job.edgeId, stage });
      if (stage === 'painted') {
        this.bus.emit('roads:changed', {});
        this.active = null;
        this.maybeStartNext();
      } else {
        job.stageIndex += 1;
        job.t = 0;
      }
    } else if (job.demolish && job.t <= 0) {
      const prevIndex = job.stageIndex - 1;
      if (prevIndex < STAGES.indexOf('graded')) {
        this.graph.removeEdge(job.edgeId);
        this.bus.emit('construction:stage', { edgeId: job.edgeId, stage: 'removed' });
        this.active = null;
        this.maybeStartNext();
      } else {
        const prevStage = STAGES[prevIndex] as Stage;
        edge.stage = prevStage;
        this.bus.emit('construction:stage', { edgeId: job.edgeId, stage: prevStage });
        job.stageIndex = prevIndex;
        job.t = edge.length;
      }
    }
  }
}

/** Finds the index of the sample nearest arclength `t` along `samples`. */
function nearestSampleIndex(samples: { x: number; y: number; z: number; bridge: boolean }[], t: number): number {
  if (samples.length === 0) return -1;
  let acc = 0;
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) {
      const a = samples[i - 1];
      const b = samples[i];
      acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const delta = Math.abs(acc - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}
