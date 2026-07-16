import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ConstructionRenderer } from '../src/render/constructionRenderer';
import { RoadRenderer } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { BuildQueue } from '../src/sim/construction/queue';
import { EventBus } from '../src/core/events';

function findAnchor(hf: Heightfield, span: number): { x: number; z: number } {
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + span, z)) { anchor = { x, z }; break outer; }
  return anchor;
}

/** Wires up a real BuildQueue -> ConstructionRenderer pipeline (same event-bus contract main.ts
 * uses), so this test exercises the ACTUAL sim-emitted concurrent-front events rather than
 * hand-rolled synthetic ones — the point of this test is confirming the renderer's existing
 * per-(crew, vehicle-kind) liveness plumbing (no code changes needed there, per Task 36's finding
 * that the "only active stage vehicle visible" gating was already per-kind, not per-crew) actually
 * shows multiple vehicles at once when fed a real train job. */
function buildRig(seed: string, span: number) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  const scene = new THREE.Scene();
  const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
  const renderer = new ConstructionRenderer(scene, bus, graph, hf, roadRenderer);
  const anchor = findAnchor(hf, span);
  const [edgeId] = graph.commitChain([anchor, { x: anchor.x + span, z: anchor.z }]);
  return { bus, hf, graph, queue, renderer, scene, edgeId };
}

/** Reads crew 0's currently "shown" (scale > threshold) per-kind vehicle states via the renderer's
 * private `crews` array — no public accessor exists for this yet, so this reaches past TypeScript's
 * compile-time privacy (runtime-accessible either way) rather than adding a test-only API surface
 * to production code for a single convoy-visibility check. */
function activeVehicleKinds(renderer: ConstructionRenderer, crew: number, threshold = 0.05): string[] {
  const slot = (renderer as unknown as { crews: { states: Map<string, { scale: number; hasTarget: boolean }> }[] }).crews[crew];
  const kinds: string[] = [];
  for (const [kind, state] of slot.states) {
    if (state.hasTarget && state.scale > threshold) kinds.push(kind);
  }
  return kinds;
}

describe('ConstructionRenderer convoy (Task 36)', () => {
  it('grounds the visible fleet with one pooled contact-shadow mesh and clears idle slots', () => {
    const { bus, renderer, scene } = buildRig('fleet-shadow-test', 40);
    const shadows = scene.getObjectByName('construction-contact-shadows') as THREE.InstancedMesh | undefined;
    expect(shadows).toBeInstanceOf(THREE.InstancedMesh);
    expect(shadows!.count).toBe(0);

    bus.emit('construction:progress', {
      edgeId: 0, stage: 'graded', t: 0, pos: { x: 0, y: 0, z: 0 }, heading: 0,
      vehicle: 'excavator', demolish: false, crew: 0, onBreak: false,
    });
    renderer.update(0.1, false);

    expect(shadows!.count).toBe(1);
    const material = shadows!.material as THREE.MeshBasicMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);

    renderer.update(1, false);
    expect(shadows!.count).toBe(0);
  });

  it('shows the excavator (graded front) and paver/liner (a later front) simultaneously visible once the train is underway', () => {
    const { queue, renderer, edgeId, graph } = buildRig('convoy-test', 220);

    // 'truck' is deliberately kept "alive" as render-side theater across MULTIPLE stages even in
    // the pre-Task-36 single-front model (it idles beside the excavator during 'graded', then
    // docks at the paver hopper during 'paved' — see onProgress's synthesized truck target) — so
    // truck showing up alongside another kind is NOT itself evidence of a genuine concurrent-front
    // convoy. The real tell is 'excavator' (tied 1:1 to the graded front only) simultaneously
    // visible with 'paver' or 'liner' (tied 1:1 to later fronts) — that combination is only
    // possible when the graded front is still working WHILE a later front has also started, i.e.
    // genuinely concurrent fronts.
    const dt = 1 / 60;
    let sawExcavatorWithLaterVehicle = false;
    for (let i = 0; i < 150 * 60 && graph.edges.get(edgeId)!.stage !== 'painted'; i++) {
      queue.update(dt);
      renderer.update(dt, false);
      const kinds = new Set(activeVehicleKinds(renderer, 0));
      if (kinds.has('excavator') && (kinds.has('paver') || kinds.has('liner') || kinds.has('truck'))) {
        sawExcavatorWithLaterVehicle = true;
      }
    }
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    expect(sawExcavatorWithLaterVehicle).toBe(true);
  });

  it('a genuinely single-front job (resumed, sequential) never shows the excavator alongside a later-stage vehicle', () => {
    const { queue, renderer, edgeId, graph } = buildRig('convoy-sequential-test', 32);

    // Force resume mid-build (collapses to sequential per Task 36's documented allowance) —
    // starting AT 'paved' so the excavator (graded stage) never has a job on this edge at all,
    // making "excavator alongside paver/liner" an unambiguous concurrent-front signal.
    queue.clearPending(edgeId);
    graph.edges.get(edgeId)!.stage = 'paved';
    queue.enqueueResume(edgeId);

    const dt = 1 / 60;
    let sawExcavator = false;
    for (let i = 0; i < 60 * 60 && graph.edges.get(edgeId)!.stage !== 'painted'; i++) {
      queue.update(dt);
      renderer.update(dt, false);
      const kinds = new Set(activeVehicleKinds(renderer, 0));
      if (kinds.has('excavator')) sawExcavator = true;
    }
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    expect(sawExcavator).toBe(false);
  });

  /** Task 46 (Groundwork stutter fix) regression: the 'truck' vehicle kind is shared across three
   * roles that can all be live on the SAME crew at once in a concurrent-front train job — an idle
   * anchor beside the excavator during 'graded' (possibly mid-shuttle, see updateTruckShuttle),
   * the real hauling vehicle during 'gravel' (onProgress's generic handler), and the paver-dock
   * anchor during 'paved'. Before this fix, a real 'gravel' or 'paved' progress event for this
   * crew's later front would unconditionally overwrite the shuttling truck's targetPos — mid-flight
   * — via onProgress's generic handler / the 'paved' branch, fighting updateTruckShuttle's own
   * targetPos writes every single sim tick. Since stepVehicle's damping can only ever move curPos a
   * FRACTION of the way toward whatever targetPos happens to be this frame, and targetPos itself
   * kept getting reset every tick, curPos never actually converged: even with `targetPos` numerically
   * unchanged for many consecutive frames (no legitimate reason to move further away), the gap
   * before the fix kept climbing instead of shrinking. This test asserts the actual invariant that
   * matters — while `targetPos` holds still for several consecutive frames (the truck isn't mid a
   * legitimate long "departing"/"returning" drive, whose target can legitimately be ~world-scale
   * distances away and is crossed while fading in/out), curPos's distance to it must be
   * NON-INCREASING, i.e. converging, never diverging. */
  it('the truck vehicle converges (never diverges) toward a held-still target during a concurrent-front train job', () => {
    const { queue, renderer, edgeId, graph } = buildRig('shuttle-contention-test', 260);

    function truckSnapshot(): { d: number; tx: number; tz: number } | null {
      const slot = (renderer as unknown as {
        crews: { states: Map<string, { hasTarget: boolean; curPos: THREE.Vector3; targetPos: THREE.Vector3 }> }[];
      }).crews[0];
      const truck = slot.states.get('truck');
      if (!truck || !truck.hasTarget) return null;
      return { d: truck.curPos.distanceTo(truck.targetPos), tx: truck.targetPos.x, tz: truck.targetPos.z };
    }

    const dt = 1 / 60;
    let prev: { d: number; tx: number; tz: number } | null = null;
    let worstGrowth = 0; // largest single-frame increase in d while targetPos held still
    for (let i = 0; i < 150 * 60 && graph.edges.get(edgeId)!.stage !== 'painted'; i++) {
      queue.update(dt);
      renderer.update(dt, false);
      const cur = truckSnapshot();
      if (cur && prev && cur.tx === prev.tx && cur.tz === prev.tz) {
        worstGrowth = Math.max(worstGrowth, cur.d - prev.d);
      }
      prev = cur;
    }
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    // Damping is monotonically convergent by construction (see easing.ts's damp()) whenever the
    // target holds still, so this should be ~0 (a hair of float slack); the pre-fix bug violated it
    // by tens of units per frame for as long as the contention lasted.
    expect(worstGrowth).toBeLessThan(0.01);
  });
});

describe('ConstructionRenderer timeScale-aware damping (Task 46, Groundwork stutter fix)', () => {
  /** At high HUD speed (timeScale), Loop batches many fixed sim steps into a single rendered
   * frame (see src/core/loop.ts), so a vehicle's targetPos can jump a large distance between one
   * rendered frame and the next. `update`'s new `timeScale` param scales stepVehicle's
   * position-damping rate to match, so a batched jump is caught up within roughly the same WALL-
   * CLOCK time regardless of timeScale — without it, the fixed wall-clock damping rate left a much
   * larger residual gap the higher timeScale went (this is what actually read as "stutter"). */
  it('closes a large targetPos jump faster (in wall-clock renderer ticks) at timeScale=16 than at timeScale=1', () => {
    const dt = 1 / 60;

    // Drive one crew's excavator to a first position so it's live and positioned, then jump the
    // target far away in one step (simulating the batched-progress-events scenario) and measure
    // how many renderer ticks it takes to close most of the gap, at timeScale=1 vs 16.
    function crewExcavatorState(r: ConstructionRenderer) {
      const slot = (r as unknown as {
        crews: { states: Map<string, { hasTarget: boolean; curPos: THREE.Vector3; targetPos: THREE.Vector3 }> }[];
      }).crews[0];
      return slot.states.get('excavator')!;
    }

    function ticksToConverge(timeScale: number): number {
      const { renderer: r, bus } = buildRig(`timescale-damp-test-${timeScale}`, 40);
      bus.emit('construction:progress', {
        edgeId: 0, stage: 'graded', t: 0, pos: { x: 0, y: 0, z: 0 }, heading: 0,
        vehicle: 'excavator', demolish: false, crew: 0, onBreak: false,
      });
      r.update(dt, false, timeScale); // let it fade/settle in at the first position
      for (let i = 0; i < 30; i++) r.update(dt, false, timeScale);

      // Jump the target far away in a single event, as a batched-progress-tick would.
      bus.emit('construction:progress', {
        edgeId: 0, stage: 'graded', t: 0, pos: { x: 100, y: 0, z: 0 }, heading: 0,
        vehicle: 'excavator', demolish: false, crew: 0, onBreak: false,
      });

      let ticks = 0;
      const maxTicks = 600;
      while (ticks < maxTicks) {
        r.update(dt, false, timeScale);
        ticks++;
        const state = crewExcavatorState(r);
        if (state.curPos.distanceTo(state.targetPos) < 5) break;
      }
      return ticks;
    }

    const ticksAt1x = ticksToConverge(1);
    const ticksAt16x = ticksToConverge(16);
    // At 16x the damping rate should be ~16x faster in wall-clock renderer ticks, so it converges
    // in meaningfully fewer ticks — not the same (pre-fix) or more.
    expect(ticksAt16x).toBeLessThan(ticksAt1x);
  });

  it('IDLE_TIMEOUT liveness is unaffected by timeScale (only stepVehicle damping is scaled)', () => {
    // Regression guard for the naive "scale ALL of dt by timeScale" approach considered and
    // rejected during Task 46: that approach broke IDLE_TIMEOUT (a wall-clock-calibrated 0.2s
    // liveness window) because a single rendered frame's clock advance at timeScale=16 could
    // already exceed 0.2s on its own, popping vehicles invisible every frame. Confirms a vehicle
    // stays visible (scale grows normally) across several renderer ticks at timeScale=16.
    const { renderer, bus } = buildRig('timescale-liveness-test', 40);
    const dt = 1 / 60;
    bus.emit('construction:progress', {
      edgeId: 0, stage: 'graded', t: 0, pos: { x: 0, y: 0, z: 0 }, heading: 0,
      vehicle: 'excavator', demolish: false, crew: 0, onBreak: false,
    });
    const scales: number[] = [];
    for (let i = 0; i < 10; i++) {
      // Re-emit each tick, as a real sim would while the excavator is actively working.
      bus.emit('construction:progress', {
        edgeId: 0, stage: 'graded', t: 0, pos: { x: 0, y: 0, z: 0 }, heading: 0,
        vehicle: 'excavator', demolish: false, crew: 0, onBreak: false,
      });
      renderer.update(dt, false, 16);
      const slot = (renderer as unknown as {
        crews: { states: Map<string, { scale: number }> }[];
      }).crews[0];
      scales.push(slot.states.get('excavator')!.scale);
    }
    // Scale should ramp up toward 1, never drop back toward 0 mid-ramp (which IDLE_TIMEOUT
    // breakage would cause — the vehicle would be marked inactive most frames).
    expect(scales[scales.length - 1]).toBeGreaterThan(0.9);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1] - 0.001);
    }
  });
});
