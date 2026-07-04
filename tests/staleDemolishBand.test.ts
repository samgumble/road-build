import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, STAGE_COLOR } from '../src/render/roadRenderer';
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

/** Wires up a real BuildQueue -> RoadRenderer pipeline (same event-bus contract main.ts uses), so
 * this test exercises the ACTUAL sim-emitted train/demolish events rather than hand-rolled
 * synthetic ones — the point is confirming the renderer clears a stale `pending` front entry when
 * the sim converts a still-in-flight train job to demolition (Task 36 critical finding). */
function buildRig(seed: string, span: number) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  const scene = new THREE.Scene();
  const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
  const anchor = findAnchor(hf, span);
  const [edgeId] = graph.commitChain([anchor, { x: anchor.x + span, z: anchor.z }]);
  return { bus, hf, graph, queue, roadRenderer, edgeId };
}

function pavedBandPresent(roadRenderer: RoadRenderer, edgeId: number): boolean {
  const scene = (roadRenderer as unknown as { scene: THREE.Scene }).scene;
  const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group | undefined;
  if (!group) return false;
  const pavedHex = new THREE.Color(STAGE_COLOR.paved).getHex();
  return group.children.some(
    (c) => c instanceof THREE.Mesh && (c.material as THREE.MeshStandardMaterial).color.getHex() === pavedHex,
  );
}

describe('stale demolish band (Task 36 critical finding)', () => {
  it('clears the frozen paved-front band when a mid-flight train job converts to demolition', () => {
    const { queue, roadRenderer, edgeId, graph } = buildRig('stale-demolish-test', 220);

    // Run the train job until gravel has fully completed (edge.stage === 'gravel') AND the paved
    // front has advanced partway (front 2's own construction:progress events start landing) —
    // i.e. exactly the "mid-flight" state the finding describes: edge.stage='gravel', paved front
    // t > 0 but not done.
    const dt = 1 / 60;
    let sawPavedProgress = false;
    bus_loop: for (let i = 0; i < 200 * 60; i++) {
      queue.update(dt);
      roadRenderer.update(dt);
      const edge = graph.edges.get(edgeId);
      if (!edge) break bus_loop;
      if (edge.stage === 'gravel') {
        // Peek at the renderer's own pending state to confirm the paved front has started
        // reporting progress (not just that time has passed).
        const v = (roadRenderer as unknown as {
          visuals: Map<number, { pending: { paved: number | null } | null }>;
        }).visuals.get(edgeId);
        if (v?.pending?.paved !== null && v?.pending?.paved !== undefined && v.pending.paved > 0) {
          sawPavedProgress = true;
          break;
        }
      }
      if (edge.stage === 'paved' || edge.stage === 'painted') {
        // Overshot — the train completed gravel AND paved before we caught the mid-flight window.
        break;
      }
    }
    expect(graph.edges.get(edgeId)!.stage).toBe('gravel');
    expect(sawPavedProgress).toBe(true);

    // Flush the throttled rebuild so the stale paved band (if the bug is present) is actually
    // materialized as a mesh before we convert to demolish.
    roadRenderer.update(0.2);
    expect(pavedBandPresent(roadRenderer, edgeId)).toBe(true);

    // Convert to demolition mid-flight.
    queue.enqueueDemolish(edgeId);

    // Run the demolition for a few seconds.
    for (let i = 0; i < 5 * 60; i++) {
      queue.update(dt);
      roadRenderer.update(dt);
      if (!graph.edges.get(edgeId)) break; // fully removed
    }

    // Flush the renderer throttle one more time.
    roadRenderer.update(0.2);

    // The stale paved band must be gone — demolition has regressed behind it and nothing should
    // still be rendering a frozen paved-colored mesh.
    expect(pavedBandPresent(roadRenderer, edgeId)).toBe(false);
  });
});
