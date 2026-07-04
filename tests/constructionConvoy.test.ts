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
  return { bus, hf, graph, queue, renderer, edgeId };
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
});
