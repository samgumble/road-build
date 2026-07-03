import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
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
});
