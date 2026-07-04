import { describe, it, expect } from 'vitest';
import { BuildQueue, MAX_CREWS } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import type { Stage } from '../src/core/types';

function findAnchor(hf: Heightfield, span: number): { x: number; z: number } {
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + span, z)) { anchor = { x, z }; break outer; }
  return anchor;
}

/** Finds `count` anchors for span-length edges, each on a distinct z-row at least `span + 16`
 * apart from every previously-picked row so the edges never overlap/snap into each other (graph
 * commits snap control points to an 8u grid — see SNAP in core/constants.ts). Used by the
 * multi-crew tests below to commit several genuinely independent edges at once and let the queue
 * fan them out across crews. Scans the FULL x/z grid per row (rather than reusing findAnchor's
 * early-exit) so a row whose first reachable land happens to coincide with an earlier row's still
 * finds a distinct point instead of silently returning the same anchor twice. */
function findParallelAnchors(hf: Heightfield, span: number, count: number): { x: number; z: number }[] {
  const anchors: { x: number; z: number }[] = [];
  const usedZ: number[] = [];
  for (let row = 0; row < count; row++) {
    let anchor: { x: number; z: number } | null = null;
    outer: for (let z = -160; z <= 160; z += 8) {
      if (usedZ.some((uz) => Math.abs(uz - z) < span + 16)) continue;
      for (let x = -160; x <= 160; x += 8) {
        if (hf.isLand(x, z) && hf.isLand(x + span, z)) { anchor = { x, z }; break outer; }
      }
    }
    if (!anchor) throw new Error(`could not find anchor for row ${row}`);
    usedZ.push(anchor.z);
    anchors.push(anchor);
  }
  return anchors;
}

function setup() {
  const bus = new EventBus();
  const hf = new Heightfield('q-test', bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  const anchor = findAnchor(hf, 32);
  const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
  return { bus, hf, graph, queue, edgeId, anchor };
}

const run = (queue: BuildQueue, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) queue.update(1 / 60);
};

describe('BuildQueue', () => {
  it('advances an edge through all stages in order', () => {
    const { bus, queue, edgeId, graph } = setup();
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => { if (e.edgeId === edgeId) stages.push(e.stage); });
    run(queue, 120);
    expect(stages).toEqual(['graded', 'gravel', 'paved', 'painted']);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    expect(queue.busy).toBe(false);
  });
  it('grading deforms terrain toward the road profile', () => {
    const { queue, hf, graph, edgeId } = setup();
    const mid = graph.edges.get(edgeId)!.samples[Math.floor(graph.edges.get(edgeId)!.samples.length / 2)];
    run(queue, 120);
    expect(Math.abs(hf.heightAt(mid.x, mid.z) - mid.y)).toBeLessThan(1.0);
  });
  it('demolish reverses stages and removes the edge', () => {
    const { bus, queue, graph, edgeId } = setup();
    run(queue, 120); // fully built
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => stages.push(e.stage));
    queue.enqueueDemolish(edgeId);
    run(queue, 120);
    expect(stages[stages.length - 1]).toBe('removed');
    expect(graph.edges.has(edgeId)).toBe(false);
  });
  it('demolish emits roads:changed as soon as the edge drops from painted, not only at final removal', () => {
    const { bus, queue, edgeId } = setup();
    run(queue, 120); // fully built to 'painted'
    let changedCount = 0;
    let firstChangeStage: Stage | 'removed' | null = null;
    const stagesAtChange: (Stage | 'removed')[] = [];
    let lastStage: Stage | 'removed' = 'painted';
    bus.on('construction:stage', (e) => { lastStage = e.stage; });
    bus.on('roads:changed', () => {
      changedCount++;
      if (firstChangeStage === null) firstChangeStage = lastStage;
      stagesAtChange.push(lastStage);
    });
    queue.enqueueDemolish(edgeId);
    run(queue, 120); // walk all the way down to removed
    // Traffic (TrafficSim.onRoadsChanged) must be told the instant the road stops being
    // drivable — i.e. the first backward stage transition off 'painted' (to 'paved') — not only
    // once at the very end when the edge is fully removed.
    expect(changedCount).toBeGreaterThanOrEqual(1);
    expect(firstChangeStage).toBe('paved');
  });
  it('splitting a fully-painted edge does not tear it down and rebuild it', () => {
    const bus = new EventBus();
    const hf = new Heightfield('q-test-split', bus);
    const graph = new RoadGraph(bus, makeSampler(hf));
    const queue = new BuildQueue(graph, hf, bus);
    const anchor = findAnchor(hf, 32);
    const mid = { x: anchor.x + 16, z: anchor.z };
    const end = { x: anchor.x + 32, z: anchor.z };

    // 3-point chain so `mid` is a genuine interior control point that a later chain can split at.
    const [edgeId] = graph.commitChain([anchor, mid, end]);
    run(queue, 120);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');

    // Commit a chain from the midpoint outward, off to the side — this splits the painted edge
    // into two halves (see graph.test.ts's "splits an existing edge" case); the split halves
    // inherit the parent's 'painted' stage.
    graph.commitChain([mid, { x: mid.x, z: mid.z + 32 }]);

    expect(graph.edges.has(edgeId)).toBe(false); // original replaced by the split
    const halves = [...graph.edges.values()].filter(
      (e) =>
        e.ctrl.length === 2 &&
        e.ctrl.some((c) => c.x === mid.x && c.z === mid.z) &&
        e.ctrl.every((c) => c.z === anchor.z), // excludes the new perpendicular stub (z varies)
    );
    expect(halves.length).toBe(2); // left half + right half of the original road

    run(queue, 5); // give the crew plenty of time to (wrongly) start rebuilding if it were going to

    // Both split halves of the original road must remain 'painted' — not torn back down to
    // 'graded'/'gravel'/'paved' and rebuilt. (The new perpendicular stub road is a genuinely new
    // 'surveyed' edge and legitimately gets built by the crew — that's correct, not the bug under
    // test — so it's excluded from `halves` above and from these assertions.)
    for (const e of halves) expect(e.stage).toBe('painted');
    // No job was ever enqueued/started for either restored-painted half specifically.
    expect(queue.queueLength).toBeLessThanOrEqual(1); // at most the legitimate new stub-road build job
  });
  it('finalizes grading with a hard clamp so no terrain pokes above the roadbed on completion', () => {
    const { queue, hf, graph, edgeId } = setup();
    run(queue, 120); // full build through 'painted'
    const samples = graph.edges.get(edgeId)!.samples;
    // Check a handful of mid-edge, non-bridge samples.
    const picks = [
      samples[Math.floor(samples.length * 0.25)],
      samples[Math.floor(samples.length * 0.5)],
      samples[Math.floor(samples.length * 0.75)],
    ];
    for (const s of picks) {
      if (s.bridge) continue;
      expect(hf.heightAt(s.x, s.z)).toBeLessThanOrEqual(s.y + 0.05);
    }
  });

  it('demolishing a non-surveyed edge with only a pending (unstarted) job still walks it down properly', () => {
    const bus = new EventBus();
    const hf = new Heightfield('q-test-split-demolish', bus);
    const graph = new RoadGraph(bus, makeSampler(hf));
    const queue = new BuildQueue(graph, hf, bus);
    const anchor = findAnchor(hf, 32);
    const mid = { x: anchor.x + 16, z: anchor.z };
    const end = { x: anchor.x + 32, z: anchor.z };

    const [edgeId] = graph.commitChain([anchor, mid, end]);
    run(queue, 120); // fully build the original edge to 'painted'
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');

    // Split it — both halves inherit 'painted' and get pending `enqueueResume` jobs queued (no-op
    // resume jobs since they're already painted, but still technically "pending" entries).
    graph.commitChain([mid, { x: mid.x, z: mid.z + 32 }]);
    const halfIds = [...graph.edges.keys()].filter((id) => {
      const e = graph.edges.get(id)!;
      return (
        e.ctrl.length === 2 &&
        e.ctrl.some((c) => c.x === mid.x && c.z === mid.z) &&
        e.ctrl.every((c) => c.z === anchor.z) // excludes the new perpendicular stub (z varies)
      );
    });
    expect(halfIds.length).toBe(2);
    const targetId = halfIds[0];

    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => { if (e.edgeId === targetId) stages.push(e.stage); });

    queue.enqueueDemolish(targetId);
    run(queue, 120);

    // A proper demolition walk must have stepped back through the built stages (not an instant
    // remove straight to 'removed' with no intermediate stage events).
    expect(stages[stages.length - 1]).toBe('removed');
    expect(stages.length).toBeGreaterThan(1);
    expect(graph.edges.has(targetId)).toBe(false);
  });

  describe('survey work phase', () => {
    it('a fresh build starts with surveyor progress events, then transitions to excavator', () => {
      const { bus, queue, edgeId } = setup();
      const vehiclesInOrder: string[] = [];
      bus.on('construction:progress', (e) => {
        if (e.edgeId !== edgeId) return;
        if (vehiclesInOrder[vehiclesInOrder.length - 1] !== e.vehicle) vehiclesInOrder.push(e.vehicle);
      });
      run(queue, 1); // just enough to observe the very start of the job
      expect(vehiclesInOrder[0]).toBe('surveyor');
      run(queue, 120); // run out the rest of the build
      expect(vehiclesInOrder).toContain('excavator');
      expect(vehiclesInOrder.indexOf('surveyor')).toBeLessThan(vehiclesInOrder.indexOf('excavator'));
    });

    it('surveyor progress events report stage "surveyed"', () => {
      const { bus, queue, edgeId } = setup();
      let sawSurveyedStage = false;
      bus.on('construction:progress', (e) => {
        if (e.edgeId === edgeId && e.vehicle === 'surveyor') {
          expect(e.stage).toBe('surveyed');
          sawSurveyedStage = true;
        }
      });
      run(queue, 1);
      expect(sawSurveyedStage).toBe(true);
    });

    it('the survey phase does not trigger a stage transition event (edges are already born surveyed)', () => {
      const { bus, queue, edgeId } = setup();
      const stageEvents: Stage[] = [];
      bus.on('construction:stage', (e) => { if (e.edgeId === edgeId) stageEvents.push(e.stage as Stage); });
      run(queue, 1); // still within the survey phase (20 u/s over a 32-unit edge => ~1.6s)
      expect(stageEvents).not.toContain('surveyed');
    });

    it('a full build still completes through all stages to painted', () => {
      const { bus, queue, edgeId, graph } = setup();
      const stages: (Stage | 'removed')[] = [];
      bus.on('construction:stage', (e) => { if (e.edgeId === edgeId) stages.push(e.stage); });
      run(queue, 120);
      expect(stages).toEqual(['graded', 'gravel', 'paved', 'painted']);
      expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    });

    it('resuming a build from a stage past surveyed (e.g. gravel) emits no surveyor events', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-resume-survey', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchor = findAnchor(hf, 32);
      const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);

      // Simulate a restore mid-build (Task 15 style): force the edge to 'gravel' directly (as
      // restoreWorld does) rather than replaying the crew, then resume via enqueueResume.
      queue.clearPending(edgeId); // drop the auto-enqueued fresh build job first
      graph.edges.get(edgeId)!.stage = 'gravel';
      queue.enqueueResume(edgeId);

      let sawSurveyor = false;
      bus.on('construction:progress', (e) => { if (e.vehicle === 'surveyor') sawSurveyor = true; });
      run(queue, 120);
      expect(sawSurveyor).toBe(false);
      expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    });

    it('demolish jobs emit no surveyor events', () => {
      const { bus, queue, graph, edgeId } = setup();
      run(queue, 120); // fully build first
      queue.enqueueDemolish(edgeId);
      let sawSurveyor = false;
      bus.on('construction:progress', (e) => { if (e.vehicle === 'surveyor') sawSurveyor = true; });
      run(queue, 120);
      expect(sawSurveyor).toBe(false);
      expect(graph.edges.has(edgeId)).toBe(false);
    });
  });

  // --- Task 25: multi-crew construction ---------------------------------------------------
  describe('multi-crew (MAX_CREWS)', () => {
    it('two queued edges advance CONCURRENTLY in the same update window', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-concurrent', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const [a1, a2] = findParallelAnchors(hf, 32, 2);
      const [edgeA] = graph.commitChain([a1, { x: a1.x + 32, z: a1.z }]);
      const [edgeB] = graph.commitChain([a2, { x: a2.x + 32, z: a2.z }]);

      // Both jobs must have started immediately (2 free crews, 2 queued jobs) — neither is stuck
      // waiting behind the other in a single-crew FIFO.
      expect(queue.queueLength).toBe(2);

      const progressedA: number[] = [];
      const progressedB: number[] = [];
      bus.on('construction:progress', (e) => {
        if (e.edgeId === edgeA) progressedA.push(e.t);
        if (e.edgeId === edgeB) progressedB.push(e.t);
      });

      // A single small step: if both crews are truly concurrent, both edges must show forward
      // progress from this ONE update call — a single-crew queue would only advance edgeA (or
      // whichever was FIFO-first) and edgeB would see nothing at all.
      queue.update(1 / 60);
      expect(progressedA.length).toBeGreaterThan(0);
      expect(progressedB.length).toBeGreaterThan(0);
    });

    it('4+ queued jobs drain as crews free up (never more than MAX_CREWS active at once)', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-drain', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchors = findParallelAnchors(hf, 32, 5);
      const edgeIds = anchors.map((a) => graph.commitChain([a, { x: a.x + 32, z: a.z }])[0]);

      expect(edgeIds.length).toBe(5);
      // Never more concurrently active+queued crews than MAX_CREWS busy at any single instant —
      // sample right after commit (queue should have started exactly MAX_CREWS, the rest waiting).
      const activeCount = edgeIds.filter((id) => graph.edges.get(id)!.stage !== 'surveyed').length;
      expect(activeCount).toBeLessThanOrEqual(MAX_CREWS);

      // Run long enough for all 5 to fully drain through the queue via crew rotation.
      run(queue, 5 * 120);
      for (const id of edgeIds) {
        expect(graph.edges.get(id)!.stage).toBe('painted');
      }
      expect(queue.busy).toBe(false);
      expect(queue.queueLength).toBe(0);
    });

    it('events carry correct crew attribution — concurrent jobs report distinct crew indices', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-crew-attr', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchors = findParallelAnchors(hf, 32, 3);
      const edgeIds = anchors.map((a) => graph.commitChain([a, { x: a.x + 32, z: a.z }])[0]);

      const crewByEdge = new Map<number, Set<number>>();
      bus.on('construction:progress', (e) => {
        if (!edgeIds.includes(e.edgeId)) return;
        let set = crewByEdge.get(e.edgeId);
        if (!set) { set = new Set(); crewByEdge.set(e.edgeId, set); }
        set.add(e.crew);
      });

      run(queue, 1); // enough for all 3 crews to report several progress events each

      // Each edge's progress events must always report the SAME crew index throughout (a job
      // never silently migrates crews), and the three edges' crews must be pairwise distinct
      // since all 3 started concurrently on 3 separate free slots.
      const crewsUsed = edgeIds.map((id) => {
        const set = crewByEdge.get(id)!;
        expect(set.size).toBe(1); // stable attribution per job
        return [...set][0];
      });
      expect(new Set(crewsUsed).size).toBe(3); // pairwise distinct
      expect(crewsUsed.every((c) => c >= 0 && c < MAX_CREWS)).toBe(true);
    });

    it('restore with 3 non-painted edges resumes on 3 crews concurrently', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-restore-multi', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchors = findParallelAnchors(hf, 32, 3);
      const edgeIds = anchors.map((a) => graph.commitChain([a, { x: a.x + 32, z: a.z }])[0]);

      // Simulate a restore (Task 15 style): drop the auto-enqueued fresh jobs, force each edge to
      // a different non-painted stage directly (as restoreWorld does), then resume all three.
      const stages: Stage[] = ['graded', 'gravel', 'paved'];
      for (let i = 0; i < edgeIds.length; i++) {
        queue.clearPending(edgeIds[i]);
        graph.edges.get(edgeIds[i])!.stage = stages[i];
      }
      for (const id of edgeIds) queue.enqueueResume(id);

      // All three should be picked up onto their own crew immediately (3 free crews, 3 resumable
      // jobs) rather than queued behind each other.
      expect(queue.queueLength).toBe(3);

      const progressed = new Set<number>();
      bus.on('construction:progress', (e) => { if (edgeIds.includes(e.edgeId)) progressed.add(e.edgeId); });
      queue.update(1 / 60);
      expect(progressed.size).toBe(3); // all three advanced in the very first update — concurrent

      run(queue, 3 * 120);
      for (const id of edgeIds) {
        expect(graph.edges.get(id)!.stage).toBe('painted');
      }
    });

    it('demolish-jumps-queue still holds with busy crews (converts in place on whichever crew is active)', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-demolish-busy', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchors = findParallelAnchors(hf, 32, MAX_CREWS + 1);
      const edgeIds = anchors.map((a) => graph.commitChain([a, { x: a.x + 32, z: a.z }])[0]);

      // First MAX_CREWS edges are active (one per crew); the last one is still queued (no free
      // crew slot left) — asserted immediately, before any crew can free up and pick it up.
      const queuedEdge = edgeIds[edgeIds.length - 1];
      const activeEdge = edgeIds[0];
      expect(graph.edges.get(queuedEdge)!.stage).toBe('surveyed');
      expect(queue.queueLength).toBe(MAX_CREWS + 1);

      // Demolishing the edge that was only ever queued (never started, still 'surveyed') takes
      // the instant-remove shortcut regardless of how busy the other crews are — jumping ahead of
      // its own still-pending build job without waiting for a crew to free up.
      queue.enqueueDemolish(queuedEdge);
      expect(graph.edges.has(queuedEdge)).toBe(false);

      // Demolishing an edge that's actively being built on some crew converts that crew's job in
      // place to a demolish job — it must NOT get shoved behind any other queued/active work.
      queue.enqueueDemolish(activeEdge);
      run(queue, 200); // long enough to walk it all the way back down
      expect(graph.edges.has(activeEdge)).toBe(false);
    });
  });

  // --- Task 33: nearest-crew assignment -----------------------------------------------------
  describe('nearest-crew assignment', () => {
    it('a new job goes to the free crew whose last job site is nearest to the new edge (ties -> lowest index)', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-nearest-crew', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);

      // Complete two independent jobs on two different crews so each crew's `crewLastSite`
      // diverges from map-center (0,0) — the third crew is left untouched, still at map-center.
      const anchors = findParallelAnchors(hf, 32, 2);
      const edgeIds = anchors.map((a) => graph.commitChain([a, { x: a.x + 32, z: a.z }])[0]);

      const crewByEdge = new Map<number, number>();
      bus.on('construction:progress', (e) => {
        if (edgeIds.includes(e.edgeId) && !crewByEdge.has(e.edgeId)) crewByEdge.set(e.edgeId, e.crew);
      });
      run(queue, 120); // fully build both to painted
      for (const id of edgeIds) expect(graph.edges.get(id)!.stage).toBe('painted');
      expect(queue.busy).toBe(false); // both crews now free again

      const crewA = crewByEdge.get(edgeIds[0])!;
      const crewB = crewByEdge.get(edgeIds[1])!;
      // Sanity: the two jobs really did run on two distinct crews (parallel anchors, 2 free slots).
      expect(crewA).not.toBe(crewB);

      // crewA's last site is anchors[0]+32 (edge end); crewB's is anchors[1]+32. A fresh job whose
      // start sits right on top of anchors[0] (crewA's finishing spot) should go to crewA even
      // though it's a higher crew index than the still-map-center-default third crew, proving
      // real distance-based selection (not just "any free crew").
      const anchorA = anchors[0];
      const newAnchor = { x: anchorA.x + 32 + 8, z: anchorA.z }; // just past crewA's last site, far from crewB's and from map-center
      const [newEdgeId] = graph.commitChain([newAnchor, { x: newAnchor.x + 16, z: newAnchor.z }]);

      let assignedCrew = -1;
      bus.on('construction:progress', (e) => {
        if (e.edgeId === newEdgeId && assignedCrew === -1) assignedCrew = e.crew;
      });
      queue.update(1 / 60);
      expect(assignedCrew).toBe(crewA);
    });

    it('ties (all free crews at the same last-site, e.g. every crew still at map-center default) resolve to the lowest crew index', () => {
      const { bus, queue, edgeId } = setup();
      // Fresh queue: every crew still defaults to map-center, so the very first job (already
      // committed by `setup()`) must land on crew 0 — exactly the existing FIFO/index-order
      // behavior this refactor must preserve when there's no real distance signal yet.
      let assignedCrew = -1;
      bus.on('construction:progress', (e) => {
        if (e.edgeId === edgeId && assignedCrew === -1) assignedCrew = e.crew;
      });
      queue.update(1 / 60);
      expect(assignedCrew).toBe(0);
    });
  });

  // --- Task 33: work rhythm (breaks + night slowdown) ---------------------------------------
  describe('work rhythm', () => {
    it('break pauses t-advance then resumes (t frozen during the break window, progress continues after)', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-break-freeze', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchor = findAnchor(hf, 400);
      // A long edge so the crew is still mid-'graded' well past the guaranteed-break point
      // (180 sim-seconds of active work) without finishing and rotating off to another job.
      const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 400, z: anchor.z }]);

      const ts: { t: number; onBreak: boolean }[] = [];
      bus.on('construction:progress', (e) => {
        if (e.edgeId === edgeId) ts.push({ t: e.t, onBreak: e.onBreak });
      });

      run(queue, 260); // > total active work time to comfortably cross BREAK_INTERVAL_MIN (180s)

      const breakSamples = ts.filter((s) => s.onBreak);
      expect(breakSamples.length).toBeGreaterThan(0); // a break actually happened

      // While on break, t must stay exactly constant across consecutive onBreak samples.
      const distinctTsDuringBreak = new Set(breakSamples.map((s) => s.t));
      expect(distinctTsDuringBreak.size).toBe(1);

      // After the break window (last onBreak sample), t must resume advancing again.
      const lastBreakIdx = ts.findIndex((s) => s === breakSamples[breakSamples.length - 1]);
      const afterBreak = ts.slice(lastBreakIdx + 1).filter((s) => !s.onBreak);
      expect(afterBreak.length).toBeGreaterThan(0);
      expect(afterBreak[afterBreak.length - 1].t).toBeGreaterThan(breakSamples[0].t);
    });

    it('break cadence falls within the [180, 300] sim-second active-work window', () => {
      const bus = new EventBus();
      const hf = new Heightfield('q-test-break-cadence', bus);
      const graph = new RoadGraph(bus, makeSampler(hf));
      const queue = new BuildQueue(graph, hf, bus);
      const anchor = findAnchor(hf, 400);
      const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 400, z: anchor.z }]);

      let activeElapsed = 0;
      let firstBreakAt = -1;
      let wasOnBreak = false;
      let sawNonSurveyProgress = false;
      bus.on('construction:progress', (e) => {
        if (e.edgeId !== edgeId) return;
        if (e.vehicle === 'surveyor') return; // survey time doesn't count toward break cadence
        sawNonSurveyProgress = true;
        if (e.onBreak && firstBreakAt < 0) firstBreakAt = activeElapsed;
        wasOnBreak = e.onBreak;
      });
      const dt = 1 / 60;
      for (let i = 0; i < 320 * 60 && firstBreakAt < 0; i++) {
        queue.update(dt);
        if (sawNonSurveyProgress && !wasOnBreak) activeElapsed += dt;
      }
      expect(firstBreakAt).toBeGreaterThanOrEqual(180 - 1); // small tolerance for step granularity
      expect(firstBreakAt).toBeLessThanOrEqual(300 + 1);
    });

    it('the survey phase never triggers a break (no onBreak:true events while vehicle is the surveyor)', () => {
      const { bus, queue, edgeId } = setup();
      let sawSurveyorBreak = false;
      bus.on('construction:progress', (e) => {
        if (e.edgeId === edgeId && e.vehicle === 'surveyor' && e.onBreak) sawSurveyorBreak = true;
      });
      run(queue, 3); // covers the whole ~1.6s survey pass plus a margin
      expect(sawSurveyorBreak).toBe(false);
    });

    it('night applies a stage-speed slowdown: the same edge takes ~1/0.85 (~17.6%) longer to reach painted', () => {
      const dayBus = new EventBus();
      const dayHf = new Heightfield('q-test-night-day', dayBus);
      const dayGraph = new RoadGraph(dayBus, makeSampler(dayHf));
      const dayQueue = new BuildQueue(dayGraph, dayHf, dayBus);
      const anchor1 = findAnchor(dayHf, 32);
      const [dayEdgeId] = dayGraph.commitChain([anchor1, { x: anchor1.x + 32, z: anchor1.z }]);

      let dayTicks = 0;
      while (dayGraph.edges.get(dayEdgeId)!.stage !== 'painted' && dayTicks < 100 * 60) {
        dayQueue.update(1 / 60, false);
        dayTicks++;
      }
      expect(dayGraph.edges.get(dayEdgeId)!.stage).toBe('painted');

      const nightBus = new EventBus();
      const nightHf = new Heightfield('q-test-night-night', nightBus);
      const nightGraph = new RoadGraph(nightBus, makeSampler(nightHf));
      const nightQueue = new BuildQueue(nightGraph, nightHf, nightBus);
      const anchor2 = findAnchor(nightHf, 32);
      const [nightEdgeId] = nightGraph.commitChain([anchor2, { x: anchor2.x + 32, z: anchor2.z }]);

      let nightTicks = 0;
      while (nightGraph.edges.get(nightEdgeId)!.stage !== 'painted' && nightTicks < 100 * 60) {
        nightQueue.update(1 / 60, true);
        nightTicks++;
      }
      expect(nightGraph.edges.get(nightEdgeId)!.stage).toBe('painted');

      // Both builds are short (well under BREAK_INTERVAL_MIN=180s of active work), so neither
      // triggers a break — the entire tick-count difference is attributable to the night
      // multiplier. Survey time (SURVEY_SPEED, unaffected by night) is identical in both runs, so
      // it doesn't skew the ratio meaningfully once folded into the total.
      const ratio = nightTicks / dayTicks;
      expect(ratio).toBeGreaterThan(1.1);
      expect(ratio).toBeLessThan(1.25); // ~1/0.85 = 1.176, generous tolerance either side
    });
  });
});
