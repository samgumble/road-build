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
  /** Set by `enqueueResume`: the STAGES index a resumed build job should start at (skips already-completed stages). */
  resumeAt?: number;
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
    // Important 2: `splitEdge` (see graph.ts) inherits the split edge's stage into both halves —
    // splitting a painted (or otherwise partially-built) road happens whenever a newly-drawn chain
    // crosses/branches off an existing road, via `commitChain`. Unconditionally enqueuing a fresh
    // 'graded'-start build job here would tear a completed road back down to dirt and rebuild it
    // from scratch for both halves. Branch on the edge's actual stage: a genuinely new edge is
    // always born 'surveyed' (see `RoadGraph.makeEdge`'s callers), so only that stage gets a normal
    // build job; anything already past 'surveyed' (i.e. a split-off half of a previously-built
    // road) resumes via `enqueueResume`, which is a no-op for an already-'painted' half.
    this.bus.on('roads:edgeAdded', ({ edgeId }) => {
      const edge = this.graph.edges.get(edgeId);
      if (!edge) return;
      if (edge.stage === 'surveyed') this.enqueueBuild(edgeId);
      else this.enqueueResume(edgeId);
    });
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

  /**
   * Resumes construction of an edge restored mid-build (Task 15 finding): `restoreWorld` forces
   * `edge.stage` directly from the save rather than replaying the crew through it, so without this
   * the edge would sit frozen at that stage forever. Enqueues a build job that starts at the stage
   * AFTER the edge's current (completed) stage — e.g. `stage === 'gravel'` resumes at `'paved'`
   * work, t=0 — and runs through `painted` exactly like a normal build. `'painted'` is already
   * terminal (no-op). `'surveyed'` resumes at `'graded'`, i.e. a normal full build. Does not re-run
   * grading or terrain deform for stages already completed: `stageIndex` is set to the *next*
   * stage, so `update()`'s grading pass only fires if that next stage is itself `'graded'`.
   */
  enqueueResume(edgeId: number): void {
    const edge = this.graph.edges.get(edgeId);
    if (!edge) return;
    if (edge.stage === 'painted') return;
    const nextIndex = STAGES.indexOf(edge.stage) + 1;
    this.queue.push({ edgeId, demolish: false, resumeAt: nextIndex });
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
        // count down from it. Verified this also holds for a job that reached "active" via
        // `enqueueResume`'s `resumeAt` seeding (restore mid-build, see save.ts): `resumeAt` only
        // ever seeds `stageIndex` (which stage we're in) with `t` starting at 0 for that stage
        // (maybeStartNext's else-branch always sets `t: 0`) — `t` is never seeded as a global
        // arclength offset. So regardless of how this job became active, `t` is always "forward
        // distance into the *current* stageIndex's pass," which is exactly what the reverse walk
        // below expects; no special-casing needed for resumed jobs.
      }
      return;
    }

    // If a build job for this edge is still only queued (not started) AND the edge itself hasn't
    // progressed past 'surveyed', there's genuinely nothing built yet — drop the pending build job
    // and remove the edge immediately (instant-remove shortcut, no demolition walk needed).
    // Important 2: a pending job can also exist for an edge that's already NOT 'surveyed' — e.g.
    // a `splitEdge` half that inherited a 'painted'/'gravel'/etc. stage and got an `enqueueResume`
    // job queued behind an unrelated active job. That edge has real built structure to walk back
    // through, so it must get a proper demolition (the branch below), not the instant-remove
    // shortcut, even though its job is technically still "pending".
    const edge = this.graph.edges.get(edgeId);
    const pendingIdx = this.queue.findIndex((j) => j.edgeId === edgeId && !j.demolish);
    if (pendingIdx !== -1 && edge?.stage === 'surveyed') {
      this.queue.splice(pendingIdx, 1);
      this.graph.removeEdge(edgeId);
      this.bus.emit('construction:stage', { edgeId, stage: 'removed' });
      return;
    }
    if (pendingIdx !== -1) {
      // Non-surveyed edge with a pending (not yet started) resume/build job: drop that pending
      // job — the demolish job queued below will handle it — so the crew doesn't try to resume
      // building an edge that's about to be torn down out from under it.
      this.queue.splice(pendingIdx, 1);
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
        const stageIndex = job.resumeAt ?? STAGES.indexOf('graded');
        this.active = { edgeId: job.edgeId, demolish: false, stageIndex, t: 0 };
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
      // Important 4: cars only route over 'painted' edges (see TrafficSim's lane rebuild), and
      // that lane/route cache is only recomputed on `roads:changed`. Previously this event only
      // fired once, at final removal — so a demolition crew could walk an edge backward from
      // 'painted' through 'paved'/'gravel'/'graded' while traffic kept routing cars straight
      // through the (now-torn-up) road the whole time. The very first backward step off
      // 'painted' is exactly the moment the edge stops being drivable, so that's when
      // TrafficSim needs to rebuild lanes and despawn cars on it — not later at removal.
      const wasPainted = edge.stage === 'painted';
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
        if (wasPainted) this.bus.emit('roads:changed', {});
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
