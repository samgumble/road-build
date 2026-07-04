import { STAGES } from '../../core/types';
import type { Stage, VehicleKind } from '../../core/types';
import { ROAD_WIDTH, CELL } from '../../core/constants';
import { RoadGraph, RoadEdge } from '../roads/graph';
import { sampleAt, sampleHeadingAt } from '../roads/path';
import { Heightfield } from '../terrain/heightfield';
import { EventBus } from '../../core/events';
import { createRng } from '../../core/rng';

// --- Terrain clamp radii (Task 24: "grass/ground still rendering above the road", second
// occurrence after T18) ----------------------------------------------------------------------
// Perpendicular (across-the-road) radii: `CLAMP_FLAT_RADIUS` is the world-unit distance within
// which `Heightfield.clampBelow` applies a true hard ceiling (no allowance at all) — covering the
// visible ribbon corridor (ROAD_WIDTH/2) plus a full grid cell so ANY grid vertex whose bilinear
// interpolation could bleed into a visible-corridor query point (up to a full cell's diagonal,
// ~5.7u, at a road's start/end cap — see CLAMP_ALONG_RADIUS below) is unambiguously inside the
// flat zone. `CLAMP_OUTER_RADIUS` is the rim where the allowance finishes rising back to +2.5
// (embankments beyond the road blend smoothly, no cliff) — one more grid cell past the flat zone.
//
// Along-the-road radius: reaching a full grid cell (or its diagonal) perpendicular is safe,
// because elevation barely changes across a single road cross-section — but an EARLIER version
// of this fix sized the reach isotropically (same radius in every direction), which also reached
// far enough ALONG a curved/hilly road's own arclength to pull in a *different* sample whose true
// target elevation legitimately differs by several units, clamping terrain down that was
// correctly following a closer, higher sample. `tests/queue.test.ts`'s "grading deforms terrain
// toward the road profile" caught this regression on real (non-synthetic) hilly terrain. Samples
// are spaced ~2u apart (see `SPACING` in `path.ts`); `CLAMP_ALONG_RADIUS` is kept well under that
// so no single clampBelow call can ever reach past its own immediate neighbor sample.
// `Heightfield.clampBelow`'s `heading` parameter makes the perpendicular/along reach genuinely
// independent (an ellipse in the road's local frame) rather than one blended circle.
//
// Exported so `save.ts`'s restore path (which duplicates this finalization clamp for edges
// loaded already at/past 'graded') can mirror the exact same rule rather than drifting out of
// sync with its own copy of these numbers.
export const CLAMP_FLAT_RADIUS = ROAD_WIDTH / 2 + CELL;
export const CLAMP_OUTER_RADIUS = CLAMP_FLAT_RADIUS + CELL;
export const CLAMP_ALONG_FLAT_RADIUS = 3;
export const CLAMP_ALONG_RADIUS = CLAMP_ALONG_FLAT_RADIUS + 1;

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

// --- Survey work phase (Task 21) ------------------------------------------------------------
// Every fresh build job begins with a survey pass — a `surveyor` vehicle walks the edge once at
// SURVEY_SPEED before any graded work starts. Edges are already born 'surveyed' (see
// `RoadGraph.makeEdge`), so this phase never triggers a `construction:stage` transition; it just
// gives the renderer a leading unit + planted stakes to animate ahead of the excavator. Demolish
// jobs (walking a built road back down) and resumed jobs starting at/after 'graded' (i.e. anything
// already past 'surveyed', per `enqueueResume`) skip it entirely — there's nothing left to survey.
const SURVEY_SPEED = 20;

// The brief's sketch mentions `ROAD_WIDTH * 1.4`, but that footprint (8.4 units either side of a
// 6-unit road) is wide enough that a single forward pass repeatedly overwrites the same grid
// cells with different vehicle-height targets as it moves through curved elevation, causing the
// final terrain to overshoot the true road profile at ridges/dips. Grading directly under the
// road's own half-width converges tightly to the target profile in one forward pass and still
// comfortably covers the paved ribbon.
const GRADE_RADIUS = ROAD_WIDTH / 2;

// --- Task 33: work rhythm (breaks) -----------------------------------------------------------
// Every crew takes a short break every 3-5 sim-minutes of ACTIVE work (survey exempt — see
// `surveying` guard at the call site). The window is deliberately wide (180-300s) and re-rolled
// (seeded) after every break so the cadence never looks metronomic across a long play session.
const BREAK_INTERVAL_MIN = 180; // 3 sim-minutes
const BREAK_INTERVAL_MAX = 300; // 5 sim-minutes
const BREAK_DURATION = 6; // seconds, stationary

// Task 33: floodlit night crews work a touch slower — applied to every buildable stage's speed,
// never to the survey pass (surveying is exempt per the binding spec).
const NIGHT_SPEED_MULTIPLIER = 0.85;

type BuildableStage = Exclude<Stage, 'surveyed'>;

interface Job {
  edgeId: number;
  demolish: boolean;
  /** Set by `enqueueResume`: the STAGES index a resumed build job should start at (skips already-completed stages). */
  resumeAt?: number;
}

// --- Task 36: pipelined stage train ---------------------------------------------------------
// A fresh (non-resumed, non-demolish) build job runs all 4 buildable stages (graded/gravel/paved/
// painted, indices 0-3 below — NOT the same indexing as `STAGES`, which also has 'surveyed' at 0)
// as concurrent FRONTS along the edge once the survey pass completes, instead of walking them
// strictly one at a time. `FRONT_STAGES[i]` names the stage each front index builds.
const FRONT_STAGES: BuildableStage[] = ['graded', 'gravel', 'paved', 'painted'];
const FRONT_COUNT = FRONT_STAGES.length;

/** A following front may never advance to within this many arclength units of the front ahead of
 * it, unless that leading front has already finished (reached the edge's end). This is what makes
 * the train "pipeline" rather than overlap: each stage's vehicle/crew works its own stretch behind
 * the one ahead, closing the gap only once there's nothing left ahead to run into. */
const TRAIN_SPACING = 30;

/** One work front's progress within a train job — see `ActiveJob.fronts`. */
interface Front {
  t: number; // arclength progress into this front's own stage pass
  done: boolean; // true once this front has reached the edge's end (that stage is complete)
}

interface ActiveJob extends Job {
  stageIndex: number; // index into STAGES of the stage currently being built/undone
  t: number; // arclength progress within the current stage's pass
  /** true while the job is still in its pre-graded survey pass (see SURVEY_SPEED above); once the
   * surveyor reaches the edge's end this flips false and normal staged building begins at
   * stageIndex/t as already set. Always false for demolish jobs and for resumed jobs (they start
   * at/after 'graded', i.e. already past the point a survey pass would cover). */
  surveying: boolean;

  /**
   * Task 36: once survey completes, a fresh (non-resumed) build job switches to running all 4
   * buildable stages as concurrent fronts — see `Front` and `TRAIN_SPACING` above. `null` for
   * demolish jobs and for resumed jobs, both of which collapse to the pre-Task-36 sequential
   * `stageIndex`/`t` walk (see the binding spec's "resume mid-train collapses to sequential" and
   * "demolish conversion mid-train collapses to sequential demolish" allowances) — `stageIndex`/`t`
   * remain the single source of truth for those two cases exactly as before this task.
   */
  fronts: Front[] | null;

  // --- Task 33: work rhythm ------------------------------------------------------------------
  /** Seconds of ACTIVE (non-survey, non-break) work until the next break fires; re-rolled from
   * `[BREAK_INTERVAL_MIN, BREAK_INTERVAL_MAX]` (seeded) every time a break starts. Survey time
   * never counts down this timer (see `surveying` early-return in `updateCrew`). One break clock
   * per CREW (Task 33 as extended by Task 36): a break freezes every one of the crew's active
   * fronts at once, not just one stage's. */
  breakClock: number;
  /** Seconds remaining in the CURRENT break; > 0 while on break. `t`/terrain/vehicle progress is
   * fully frozen while this is > 0 — only `construction:progress` keeps firing (stationary
   * pos/heading) so renderers can react via the additive `onBreak` field. */
  breakRemaining: number;
}

/** Task 25: number of concurrent crew slots. FIFO assignment fills every free slot each time
 * `maybeStartNext` runs, so up to this many edges build/demolish simultaneously. */
export const MAX_CREWS = 3;

/** Task 33: a crew's "last job site" — the end position of its last completed/removed job, used
 * to pick the nearest free crew for a newly-queued job. Defaults to map-center for every crew
 * that hasn't finished a job yet, per the binding spec. */
const MAP_CENTER = { x: 0, z: 0 };

/**
 * Owns the construction crews: up to `MAX_CREWS` concurrent job slots, backed by a single FIFO
 * queue of build jobs (auto-enqueued whenever a new edge appears) plus demolish jobs that jump the
 * queue. Each crew advances its own active job independently, stepping a vehicle along the edge's
 * sampled path at a per-stage speed, deforming terrain during grading, and emitting
 * `construction:progress` / `construction:stage` events (tagged with the 0-based `crew` index)
 * for the renderer/HUD/audio. Per-job semantics (survey phase, stage speeds, grading, resume,
 * demolish conversion) are exactly as they were under the single-crew model — only the number of
 * jobs that can be "active" at once has changed.
 */
export class BuildQueue {
  private queue: Job[] = [];
  private crews: (ActiveJob | null)[] = new Array(MAX_CREWS).fill(null);
  private rng: () => number;

  /** Task 33: nearest-crew assignment. Each crew's last job site — map-center until that crew
   * finishes (or has one converted to removal for) its first job. Updated whenever a crew's job
   * completes (`painted`) or is fully removed (demolish reaching `removed`); NOT updated when a
   * job is merely dropped/reassigned externally (`clearPending`, edge disappearing out from under
   * a crew) since those aren't real completions. */
  private crewLastSite: { x: number; z: number }[] = new Array(MAX_CREWS).fill(null).map(() => ({ ...MAP_CENTER }));

  constructor(
    private graph: RoadGraph,
    private hf: Heightfield,
    private bus: EventBus,
    /** Optional seeded rng (deterministic by default) — drives break cadence jitter. Sim-time
     * based, never wall-clock, so replays/tests stay reproducible. */
    rng?: () => number,
  ) {
    this.rng = rng ?? createRng('build-queue');
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
    return this.crews.some((c) => c !== null);
  }

  get queueLength(): number {
    return this.queue.length + this.crews.filter((c) => c !== null).length;
  }

  /**
   * Drops any pending or active job for `edgeId` without touching the graph (Task 15 restore):
   * `commitChain` auto-enqueues a fresh build job via `roads:edgeAdded`, but save/load forces the
   * edge's stage directly, so that auto-enqueued job must be discarded rather than left to
   * "rebuild" an edge that's already at its restored stage. Frees whichever crew (if any) is
   * currently active on `edgeId` so another queued job can take that slot immediately.
   */
  clearPending(edgeId: number): void {
    this.queue = this.queue.filter((j) => j.edgeId !== edgeId);
    for (let i = 0; i < this.crews.length; i++) {
      if (this.crews[i]?.edgeId === edgeId) {
        this.crews[i] = null;
      }
    }
    this.maybeStartNext();
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
    // If this edge is the active job on ANY crew, convert it in place (whatever stage it's
    // currently at, partially built or not) rather than letting the pending build job continue —
    // unchanged from the single-crew behavior, just scanning every crew slot instead of one.
    const activeCrewIdx = this.crews.findIndex((c) => c?.edgeId === edgeId);
    if (activeCrewIdx !== -1) {
      const active = this.crews[activeCrewIdx]!;
      if (!active.demolish) {
        active.demolish = true;
        if (active.fronts) {
          // Task 36: converting a job mid-train collapses to the pre-Task-36 sequential demolish
          // walk, per the binding spec's documented allowance — demolish from `edge.stage` (the
          // last COMPLETED stage; a train job keeps `edge.stage` updated as each front finishes,
          // exactly like the sequential path always did) rather than from wherever any individual
          // front's own `t` happened to be. Every in-flight front's partial work is simply
          // abandoned here: the demolition walk below re-covers that same ground in reverse, so
          // whatever a not-yet-complete front had already built visually regresses under the
          // demolition crew as it passes back over it (acceptable per spec — documented above and
          // in the Task 36 report).
          active.fronts = null;
          const edgeNow = this.graph.edges.get(edgeId);
          // `edge.stage` is still 'surveyed' if the graded front hasn't finished yet (nothing
          // completed at all) — mirror the sequential path's own convention (a fresh build always
          // starts a demolish-eligible stageIndex at 'graded', t: 0) rather than indexing
          // STAGES.indexOf('surveyed') (0), which would desync `t`'s "forward progress into
          // stageIndex" meaning from a stage whose speed/vehicle table doesn't even cover it.
          const completedStage = edgeNow && edgeNow.stage !== 'surveyed' ? edgeNow.stage : null;
          active.stageIndex = completedStage ? STAGES.indexOf(completedStage) : STAGES.indexOf('graded');
          active.t = completedStage && edgeNow ? edgeNow.length : 0;
        }
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
      // No crew ever worked this edge (it was only pending, dropped instantly) — -1 is the "no
      // crew" sentinel for this synchronous shortcut, distinct from any real 0-based crew index.
      this.bus.emit('construction:stage', { edgeId, stage: 'removed', crew: -1 });
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

  /**
   * Picks which free crew slot should take the next queued job (Task 33): among the currently
   * FREE slots (indices into `this.crews` that are `null`), returns the one whose `crewLastSite`
   * is nearest to `startPos` (the job's own start point — see call site). Ties (including the
   * "every crew still at map-center" starting case) resolve to the LOWEST crew index, matching
   * `findIndex`'s natural left-to-right scan order — this is what keeps the existing
   * multi-crew tests (which never differentiate crew sites) passing unchanged: with all
   * `crewLastSite`s equal, nearest-crew degenerates back to "first free slot in index order".
   */
  private nearestFreeCrew(startPos: { x: number; z: number }): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.crews.length; i++) {
      if (this.crews[i] !== null) continue;
      const site = this.crewLastSite[i];
      const dist = Math.hypot(site.x - startPos.x, site.z - startPos.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** The point a queued `job` will start work from — a build/resume job starts at the edge's
   * first sample, a demolish job starts (walking backward) from the edge's last sample. Used only
   * to pick the nearest free crew (Task 33); falls back to map-center if the edge or its samples
   * are somehow missing (caller already re-checks `edge` existence before using the assigned
   * crew). */
  private jobStartPos(job: Job, edge: { samples: { x: number; z: number }[] }): { x: number; z: number } {
    const samples = edge.samples;
    if (samples.length === 0) return { ...MAP_CENTER };
    return job.demolish ? samples[samples.length - 1] : samples[0];
  }

  /**
   * Fills every free crew slot from the front of the FIFO queue (Task 25: up to MAX_CREWS jobs run
   * concurrently, not just one). Each iteration finds the next runnable queue entry (FIFO order
   * preserved — see class doc) and assigns it to the nearest FREE crew (Task 33), not simply the
   * first free slot in index order. A queue entry whose edge has since disappeared (externally
   * removed) or whose demolish target has nothing built yet is dropped without consuming a slot,
   * exactly as the single-crew version dropped it before retrying the loop.
   */
  private maybeStartNext(): void {
    for (;;) {
      if (this.crews.every((c) => c !== null) || this.queue.length === 0) return;
      const job = this.queue.shift()!;
      const edge = this.graph.edges.get(job.edgeId);
      if (!edge) continue; // externally removed before we got to it
      const freeIdx = this.nearestFreeCrew(this.jobStartPos(job, edge));
      if (freeIdx === -1) continue; // shouldn't happen (loop guard above already checked), defensive
      if (job.demolish) {
        const stageIndex = STAGES.indexOf(edge.stage);
        if (stageIndex <= 0) {
          // Nothing built yet beyond survey — just drop it (shouldn't normally happen since
          // enqueueDemolish drops pending builds instead of queuing a demolish job for them).
          continue;
        }
        this.crews[freeIdx] = {
          edgeId: job.edgeId, demolish: true, stageIndex, t: edge.length, surveying: false, fronts: null,
          breakClock: this.rollBreakInterval(), breakRemaining: 0,
        };
      } else {
        const stageIndex = job.resumeAt ?? STAGES.indexOf('graded');
        // Only a genuinely fresh build (no `resumeAt`) gets a survey pass — a resumed job by
        // definition starts at/after 'graded', i.e. the edge is already past 'surveyed'. Task 36:
        // that same "fresh vs. resumed" split is also exactly when the pipelined train applies —
        // a resumed job collapses to the pre-Task-36 sequential walk (`fronts: null`), per the
        // binding spec's documented allowance. `fronts` for a fresh build is allocated lazily once
        // the survey pass completes (see `updateCrew`), so it starts `null` here regardless.
        const surveying = job.resumeAt === undefined;
        this.crews[freeIdx] = {
          edgeId: job.edgeId, demolish: false, stageIndex, t: 0, surveying, fronts: null,
          breakClock: this.rollBreakInterval(), breakRemaining: 0,
        };
      }
    }
  }

  /** Rolls a fresh (seeded) break interval within [BREAK_INTERVAL_MIN, BREAK_INTERVAL_MAX] sim-
   * seconds of ACTIVE work. Re-rolled on job start and after every break fires. */
  private rollBreakInterval(): number {
    return BREAK_INTERVAL_MIN + this.rng() * (BREAK_INTERVAL_MAX - BREAK_INTERVAL_MIN);
  }

  /**
   * Advances every active crew's job by one step (Task 25: each crew slot is independent — a crew
   * finishing/freeing up mid-loop can immediately be refilled by `maybeStartNext` without waiting
   * for the other crews). Iterates crew slots in order so `crew` attribution on emitted events is
   * stable and low crew indices are filled first as slots free up, matching the FIFO/"fills the
   * first free slot" assignment `maybeStartNext` already performs.
   *
   * `night` (Task 33) is an opaque render-side input, exactly like traffic's `timeOfDay` — the sim
   * stays a pure function of its inputs. Defaults false so every pre-existing call site/test that
   * doesn't care about day/night keeps working unchanged.
   */
  update(dt: number, night = false): void {
    for (let crew = 0; crew < this.crews.length; crew++) {
      const job = this.crews[crew];
      if (job) this.updateCrew(crew, job, dt, night);
    }
  }

  private updateCrew(crew: number, job: ActiveJob, dt: number, night: boolean): void {
    const edge = this.graph.edges.get(job.edgeId);
    if (!edge) {
      // Edge disappeared out from under us (externally removed) — drop and move on.
      this.crews[crew] = null;
      this.maybeStartNext();
      return;
    }

    if (job.surveying) {
      job.t += SURVEY_SPEED * dt;
      const clampedT = Math.max(0, Math.min(edge.length, job.t));
      const { pos, heading } = sampleAt(edge.samples, clampedT);
      this.bus.emit('construction:progress', {
        edgeId: job.edgeId,
        stage: 'surveyed',
        t: clampedT,
        pos,
        heading,
        vehicle: 'surveyor',
        demolish: false,
        crew,
        onBreak: false, // Task 33: survey is exempt from breaks
      });
      if (job.t >= edge.length) {
        // Survey pass complete — no stage transition (the edge is already 'surveyed'). Task 36:
        // a fresh (non-resumed) build job hands off into the pipelined train (`fronts`, allocated
        // here) instead of the old single stageIndex/t walk. `resumeAt` jobs never set
        // `job.surveying` true in the first place (see `maybeStartNext`), so the only other way to
        // reach this handoff is a job that was converted to demolish MID-SURVEY by
        // `enqueueDemolish` (the edge has no built structure yet, so there's nothing to walk back
        // through) — that must fall through to the pre-Task-36 sequential path exactly as before
        // this task (finish the survey harmlessly, then the very next tick's `job.t <= 0` check
        // instant-removes it), NOT be handed a fresh set of fronts to build forward with.
        job.surveying = false;
        if (!job.demolish) {
          job.fronts = Array.from({ length: FRONT_COUNT }, () => ({ t: 0, done: false }));
        } else {
          job.t = 0;
        }
      }
      return;
    }

    // --- Task 33: work rhythm (breaks) --------------------------------------------------------
    // Survey is already handled (and returned) above, so anything reaching here is real staged
    // work — eligible for breaks. A break in progress freezes `t`/terrain progress (and, for a
    // train job, EVERY front's `t`) entirely; `construction:progress` still fires every tick with
    // each working vehicle's CURRENT stationary pos/heading so renderers can react via the
    // additive `onBreak` field, but stage advancement/grading/emission of NEW terrain deformation
    // is skipped for the duration. One break clock per CREW (unchanged from Task 33): a break
    // freezes every one of the crew's active fronts at once, not just one stage's.
    if (job.breakRemaining > 0) {
      job.breakRemaining = Math.max(0, job.breakRemaining - dt);
      if (job.fronts) {
        this.emitTrainBreak(crew, job, edge);
      } else {
        const stage = STAGES[job.stageIndex] as BuildableStage;
        const vehicle: VehicleKind = job.demolish ? 'excavator' : STAGE_VEHICLE[stage];
        const clampedT = Math.max(0, Math.min(edge.length, job.t));
        let { pos, heading } = sampleAt(edge.samples, clampedT);
        if (job.demolish) heading += Math.PI;
        this.bus.emit('construction:progress', {
          edgeId: job.edgeId,
          stage,
          t: clampedT,
          pos,
          heading,
          vehicle,
          demolish: job.demolish,
          crew,
          onBreak: true,
        });
      }
      if (job.breakRemaining <= 0) {
        job.breakClock = this.rollBreakInterval();
      }
      return;
    }

    if (job.fronts) {
      this.updateTrain(crew, job, edge, dt, night);
      return;
    }

    const stage = STAGES[job.stageIndex] as BuildableStage;
    const baseSpeed = STAGE_SPEED[stage];
    const speed = night ? baseSpeed * NIGHT_SPEED_MULTIPLIER : baseSpeed;
    const vehicle: VehicleKind = job.demolish ? 'excavator' : STAGE_VEHICLE[stage];

    if (job.demolish) {
      job.t -= speed * dt;
    } else {
      job.t += speed * dt;
    }

    // Break cadence: ticked down by actual elapsed active-work time (dt), same units the interval
    // is rolled in. Once it lapses, the NEXT tick starts the break (rather than mid-stride this
    // tick) — simple and keeps this tick's progress emission below unaffected.
    job.breakClock -= dt;
    if (job.breakClock <= 0) {
      job.breakRemaining = BREAK_DURATION;
    }

    const clampedT = Math.max(0, Math.min(edge.length, job.t));
    let { pos, heading } = sampleAt(edge.samples, clampedT);

    if (stage === 'graded') {
      this.gradeTerrainAt(edge, clampedT, pos, heading);
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
      crew,
      onBreak: false,
    });

    if (!job.demolish && job.t >= edge.length) {
      edge.stage = stage;
      if (stage === 'graded') {
        this.finalizeGrading(edge);
      }
      this.bus.emit('construction:stage', { edgeId: job.edgeId, stage, crew });
      if (stage === 'painted') {
        this.bus.emit('roads:changed', {});
        // Task 33: record this crew's last job site (the edge's end — where the crew finished)
        // for future nearest-crew assignment.
        const last = edge.samples[edge.samples.length - 1];
        this.crewLastSite[crew] = { x: last.x, z: last.z };
        this.crews[crew] = null;
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
        // Task 33: capture the crew's last site (the edge's start — where the demolition crew
        // ends up) BEFORE removing the edge out from under `samples`.
        const first = edge.samples[0];
        this.crewLastSite[crew] = { x: first.x, z: first.z };
        this.graph.removeEdge(job.edgeId);
        this.bus.emit('construction:stage', { edgeId: job.edgeId, stage: 'removed', crew });
        this.crews[crew] = null;
        this.maybeStartNext();
      } else {
        const prevStage = STAGES[prevIndex] as Stage;
        edge.stage = prevStage;
        this.bus.emit('construction:stage', { edgeId: job.edgeId, stage: prevStage, crew });
        if (wasPainted) this.bus.emit('roads:changed', {});
        job.stageIndex = prevIndex;
        job.t = edge.length;
      }
    }
  }

  /**
   * Task 36: advances every not-yet-complete front of a train job by one tick. A front may only
   * advance while it's at least `TRAIN_SPACING` units behind the front ahead of it, OR that front
   * ahead has already finished (reached the edge's end) — see `TRAIN_SPACING`'s doc comment. Front
   * 0 (graded) has no front ahead of it and is gated only by the survey pass already having
   * completed (guaranteed by the caller: `updateCrew` only reaches here once `job.surveying` is
   * false). `construction:progress` fires once per tick for every front that hasn't finished yet
   * (whether it actually advanced this tick or is currently waiting on the spacing gate) so the
   * renderer's per-(crew, vehicle-kind) liveness timers keep every not-yet-finished front's vehicle
   * on-site and visible, including one idling behind a closer-than-30u leader — this is what reads
   * as a strung-out convoy rather than a single roaming vehicle. Stage completion for front `i`
   * always happens in order: front `i` can only reach the edge's end once front `i-1` is marked
   * `done` (the spacing gate above forbids `front[i].t` from ever reaching `edge.length` while
   * `front[i-1]` is both not-done AND less than `TRAIN_SPACING` ahead — and `front[i-1]` itself
   * can't be less than `TRAIN_SPACING` ahead of a `t` that has already reached `edge.length` unless
   * `edge.length` itself is smaller than `TRAIN_SPACING`, i.e. a very short edge — see the class
   * doc / Task 36 report for that short-edge degenerate case), so `edge.stage`'s "last completed
   * stage" semantics (lanes/growth/wilderness reacting to 'painted' completion) are preserved
   * exactly as the sequential single-front walk always guaranteed.
   *
   * Minor 10 (Groundwork round fix wave): the spacing-gate reasoning above (`front[i].t` can never
   * reach `edge.length` while `front[i-1]` is both not-done and less than `TRAIN_SPACING` ahead)
   * implicitly assumes each `dt` this method is called with is bounded/consistent enough that a
   * single tick's advance (`speed * dt`) can't leapfrog the entire `TRAIN_SPACING` gap in one step —
   * true today because `Loop` (src/core/loop.ts) always calls sim `update()` (and therefore this
   * method, transitively) with the fixed `SIM_DT` from src/core/constants.ts, never a variable
   * wall-clock dt. If a future change ever fed this method a variable or much larger dt (e.g. a
   * "catch up" step after a long pause, or a fixed-step change to a coarser SIM_DT), the ordering
   * guarantee above would need re-deriving against `speed * dt` vs `TRAIN_SPACING`, not assumed to
   * still hold for free.
   */
  private updateTrain(crew: number, job: ActiveJob, edge: RoadEdge, dt: number, night: boolean): void {
    const fronts = job.fronts!;
    let breakClockTicked = false;

    for (let i = 0; i < FRONT_COUNT; i++) {
      const front = fronts[i];
      if (front.done) continue;

      const stage = FRONT_STAGES[i];
      const leader = i > 0 ? fronts[i - 1] : null;
      const gated = leader !== null && !leader.done && front.t > leader.t - TRAIN_SPACING;

      if (!gated) {
        const baseSpeed = STAGE_SPEED[stage];
        const speed = night ? baseSpeed * NIGHT_SPEED_MULTIPLIER : baseSpeed;
        front.t = Math.min(edge.length, front.t + speed * dt);

        // Break cadence (Task 33): one clock per CREW, ticked once per tick (not once per front)
        // by actual elapsed active-work time — mirrors the sequential path's own bookkeeping.
        if (!breakClockTicked) {
          job.breakClock -= dt;
          if (job.breakClock <= 0) job.breakRemaining = BREAK_DURATION;
          breakClockTicked = true;
        }
      }

      const clampedT = Math.max(0, Math.min(edge.length, front.t));
      const { pos, heading } = sampleAt(edge.samples, clampedT);

      if (stage === 'graded' && !gated) {
        this.gradeTerrainAt(edge, clampedT, pos, heading);
      }

      this.bus.emit('construction:progress', {
        edgeId: job.edgeId,
        stage,
        t: clampedT,
        pos,
        heading,
        vehicle: STAGE_VEHICLE[stage],
        demolish: false,
        crew,
        onBreak: false,
      });

      if (front.t >= edge.length) {
        front.done = true;
        edge.stage = stage;
        if (stage === 'graded') this.finalizeGrading(edge);
        this.bus.emit('construction:stage', { edgeId: job.edgeId, stage, crew });
        if (stage === 'painted') {
          this.bus.emit('roads:changed', {});
        }
      }
    }

    if (fronts.every((f) => f.done)) {
      // Task 33: record this crew's last job site (the edge's end — where the crew finished) for
      // future nearest-crew assignment — mirrors the sequential path's own bookkeeping at the same
      // moment ('painted' front completing).
      const last = edge.samples[edge.samples.length - 1];
      this.crewLastSite[crew] = { x: last.x, z: last.z };
      this.crews[crew] = null;
      this.maybeStartNext();
    }
  }

  /** Break-frozen progress emission for a train job (Task 36 extension of Task 33's break theater):
   * every not-yet-complete front reports its current STATIONARY position with `onBreak: true`, same
   * as the sequential path's single stationary emission, so every working vehicle in the convoy
   * reads as paused rather than just the one the sequential model used to track. */
  private emitTrainBreak(crew: number, job: ActiveJob, edge: RoadEdge): void {
    const fronts = job.fronts!;
    for (let i = 0; i < FRONT_COUNT; i++) {
      const front = fronts[i];
      if (front.done) continue;
      const stage = FRONT_STAGES[i];
      const clampedT = Math.max(0, Math.min(edge.length, front.t));
      const { pos, heading } = sampleAt(edge.samples, clampedT);
      this.bus.emit('construction:progress', {
        edgeId: job.edgeId,
        stage,
        t: clampedT,
        pos,
        heading,
        vehicle: STAGE_VEHICLE[stage],
        demolish: false,
        crew,
        onBreak: true,
      });
    }
  }

  /** The per-update 3-track `flattenCircle` grading blend plus trailing/endpoint clamp — shared by
   * both the sequential graded pass and the train's graded front (Task 36 extraction; behavior
   * byte-for-byte unchanged from the pre-Task-36 inline version). */
  private gradeTerrainAt(edge: RoadEdge, clampedT: number, pos: { x: number; y: number; z: number }, heading: number): void {
    const nearest = nearestSampleIndex(edge.samples, clampedT);
    if (edge.samples[nearest]?.bridge) return;
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
    // Mid-construction clamp (Task 24 finding): `flattenCircle`'s blend pulls nearby terrain
    // toward the CURRENT vehicle position's own elevation (`pos.y`) every update as it moves
    // forward along a climbing/dipping profile — on a cross-slope this can actually RAISE a
    // vertex slightly behind-and-to-the-side of the vehicle back up on a later frame, because
    // that frame's (higher/lower) `pos.y` target differs from the true graded profile at the
    // vertex's own location. Clamping at the live `pos` with `pos.y` as the ceiling (an
    // earlier version of this fix) chases the same problem — its ceiling rises and falls with
    // the vehicle too, so it can't out-converge flattenCircle's re-raising.
    //
    // Fix: clamp using the trailing (already-passed) sample's OWN `y`, not the live vehicle
    // position/elevation — exactly the same reasoning the graded-completion finalization pass
    // below already uses per sample, just applied incrementally as the crew advances instead
    // of once at the very end. Every sample the excavator has already passed gets re-clamped,
    // every frame, against its own correct target height, so it converges to the same
    // no-allowance-inside-the-corridor ceiling the finalization sweep guarantees, without
    // waiting for the whole edge to finish.
    for (const i of trailingSampleIndices(edge.samples, nearest)) {
      const s = edge.samples[i];
      if (s.bridge) continue;
      const sHeading = sampleHeadingAt(edge.samples, i);
      this.hf.clampBelow(s.x, s.z, s.y, CLAMP_OUTER_RADIUS, CLAMP_FLAT_RADIUS, sHeading, CLAMP_ALONG_RADIUS, CLAMP_ALONG_FLAT_RADIUS);
    }
    // Endpoint cap (Task 24 finding): the road's very first sample has no "before" neighbor,
    // so it's the one spot where the anisotropic along-axis flat zone can't be helped along by
    // an adjacent sample's own circle — a small (sub-0.1u) residual can otherwise sit at the
    // tip until the graded-completion finalization sweep below reaches it. That's an
    // imperceptible residual, but it's cheap (one extra sample) to just keep the tip
    // re-clamped every update once the crew has moved past it, same as the finalization sweep
    // does for every sample. Only meaningful once the front has actually passed sample 0.
    if (nearest > 0 && !edge.samples[0].bridge) {
      const cap = edge.samples[0];
      this.hf.clampBelow(cap.x, cap.z, cap.y, CLAMP_OUTER_RADIUS, CLAMP_FLAT_RADIUS, sampleHeadingAt(edge.samples, 0), CLAMP_ALONG_RADIUS, CLAMP_ALONG_FLAT_RADIUS);
    }
  }

  /** Hard finalization clamp sweep run once grading is fully complete — shared by both the
   * sequential graded pass and the train's graded front (Task 36 extraction; behavior byte-for-byte
   * unchanged from the pre-Task-36 inline version). */
  private finalizeGrading(edge: RoadEdge): void {
    // Finalization pass (playtest fix: "the land is still rendering above the cleared road
    // in some areas"): the per-update 3-track `flattenCircle` blend above tracks the vehicle
    // as it moves, but its smoothstep falloff can still leave terrain vertices above the
    // roadbed on cross-slopes between passes. Now that grading for this edge is fully
    // complete, sweep every non-bridge sample once more with a hard `clampBelow` so no
    // terrain can poke through the cut, regardless of any blend gaps left by the moving cut.
    // Uses the same anisotropic radii as the per-update clamp above (Task 24) — a hard,
    // allowance-free ceiling across the whole visible corridor plus margin perpendicular to
    // the road, but kept narrow along the road's own arclength so it can't reach a
    // neighboring sample with a meaningfully different target elevation on hilly terrain.
    for (let i = 0; i < edge.samples.length; i++) {
      const s = edge.samples[i];
      if (s.bridge) continue;
      const sHeading = sampleHeadingAt(edge.samples, i);
      this.hf.clampBelow(s.x, s.z, s.y, CLAMP_OUTER_RADIUS, CLAMP_FLAT_RADIUS, sHeading, CLAMP_ALONG_RADIUS, CLAMP_ALONG_FLAT_RADIUS);
    }
  }
}

/**
 * Indices of every sample within `CLAMP_ALONG_RADIUS` arclength of `samples[centerIdx]` (both
 * directions) — the "already-graded neighborhood" re-clamped every update by the mid-construction
 * pass above. Bounded by `CLAMP_ALONG_RADIUS` (the clamp's own along-the-road reach), NOT the
 * (much larger) perpendicular `CLAMP_OUTER_RADIUS` — each of these samples' own `clampBelow` call
 * already reaches every grid vertex it needs to across the road via the perpendicular radius; this
 * just decides which nearby samples are worth re-running every frame so the already-graded trail
 * stays converged while later `flattenCircle` calls at positions further along a (possibly
 * climbing/dipping) profile are actively trying to pull it back up — see the Task 24 comment at
 * the call site. Cheap: samples are ~2u apart and CLAMP_ALONG_RADIUS is only a couple units, so
 * this is normally just the immediate 1-2 neighbors either side of `centerIdx`.
 */
function trailingSampleIndices<T extends { x: number; y: number; z: number; bridge: boolean }>(
  samples: T[],
  centerIdx: number,
): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = centerIdx; i >= 0; i--) {
    if (i < centerIdx) acc += Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].y - samples[i].y, samples[i + 1].z - samples[i].z);
    if (acc > CLAMP_ALONG_RADIUS) break;
    out.push(i);
  }
  acc = 0;
  for (let i = centerIdx + 1; i < samples.length; i++) {
    acc += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y, samples[i].z - samples[i - 1].z);
    if (acc > CLAMP_ALONG_RADIUS) break;
    out.push(i);
  }
  return out;
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
