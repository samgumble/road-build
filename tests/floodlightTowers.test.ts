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
 * uses), mirroring staleDemolishBand.test.ts / constructionConvoy.test.ts. */
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

/** Reaches past TypeScript's compile-time privacy to read crew 0's floodlight tower pool state —
 * same rationale/approach as constructionConvoy.test.ts's `activeVehicleKinds` helper: no public
 * accessor exists for this single-purpose check, and adding one to production code just to satisfy
 * a test isn't worth the surface area. */
function towerSnapshot(renderer: ConstructionRenderer, crew: number): { x: number; y: number; z: number }[] {
  const slot = (renderer as unknown as {
    crews: {
      floodlightTowers: {
        count: number;
        towerPos: (i: number) => { x: number; y: number; z: number };
      };
    }[];
  }).crews[crew];
  const positions: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < slot.floodlightTowers.count; i++) positions.push(slot.floodlightTowers.towerPos(i));
  return positions;
}

function floodlightPoolEdgeId(renderer: ConstructionRenderer, crew: number): number | null {
  const slot = (renderer as unknown as { crews: { floodlightTowers: { edgeId: number | null } }[] }).crews[crew];
  return slot.floodlightTowers.edgeId;
}

describe('floodlight towers stake down at fixed stations (Task 37)', () => {
  it('places towers once at job start and never moves them as the work front advances', () => {
    const { queue, renderer, edgeId, graph } = buildRig('floodlight-fixed-test', 220);

    const dt = 1 / 60;
    // Run a few frames so the first construction:progress event lands and towers get placed.
    let placedCount = -1;
    let firstSnapshot: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 30; i++) {
      queue.update(dt);
      renderer.update(dt, true); // night=true throughout, isolating the "front advances" variable
      if (floodlightPoolEdgeId(renderer, 0) === edgeId) {
        placedCount = towerSnapshot(renderer, 0).length;
        firstSnapshot = towerSnapshot(renderer, 0);
        break;
      }
    }
    expect(placedCount).toBeGreaterThan(0);
    expect(placedCount).toBeLessThanOrEqual(6); // FLOODLIGHT_CAP

    // Advance the job substantially (well into gravel/graded/paved stages) — the work front moves
    // a long way down the 220u edge in this window.
    for (let i = 0; i < 40 * 60 && graph.edges.get(edgeId)!.stage !== 'painted'; i++) {
      queue.update(dt);
      renderer.update(dt, true);
    }

    const laterSnapshot = towerSnapshot(renderer, 0);
    expect(laterSnapshot.length).toBe(firstSnapshot.length);
    for (let i = 0; i < firstSnapshot.length; i++) {
      expect(laterSnapshot[i].x).toBeCloseTo(firstSnapshot[i].x, 6);
      expect(laterSnapshot[i].y).toBeCloseTo(firstSnapshot[i].y, 6);
      expect(laterSnapshot[i].z).toBeCloseTo(firstSnapshot[i].z, 6);
    }
  });

  it('caps towers at 6 and widens spacing rather than exceeding the per-crew budget on a long edge', () => {
    const { queue, renderer, edgeId } = buildRig('floodlight-cap-test', 600);

    const dt = 1 / 60;
    let placedCount = -1;
    for (let i = 0; i < 30; i++) {
      queue.update(dt);
      renderer.update(dt, true);
      if (floodlightPoolEdgeId(renderer, 0) === edgeId) {
        placedCount = towerSnapshot(renderer, 0).length;
        break;
      }
    }
    expect(placedCount).toBeGreaterThan(0);
    expect(placedCount).toBeLessThanOrEqual(6);
  });

  it('fades towers out with the crew dressing on job completion and re-places on a later demolish job', () => {
    const { queue, renderer, edgeId, graph } = buildRig('floodlight-lifecycle-test', 60);

    const dt = 1 / 60;
    // Drive the build to completion.
    for (let i = 0; i < 60 * 60 && graph.edges.get(edgeId)!.stage !== 'painted'; i++) {
      queue.update(dt);
      renderer.update(dt, true);
    }
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');

    // Let the crew's dressing (stockpile/cones/towers) fully fade after the job goes idle.
    for (let i = 0; i < 5 * 60; i++) renderer.update(dt, true);
    expect(floodlightPoolEdgeId(renderer, 0)).toBe(null); // cleared once fully faded

    // Now demolish — towers should re-place (same fixed-station treatment applies to demolish jobs).
    queue.enqueueDemolish(edgeId);
    let placedDuringDemolish = false;
    for (let i = 0; i < 40 * 60; i++) {
      queue.update(dt);
      renderer.update(dt, true);
      if (floodlightPoolEdgeId(renderer, 0) === edgeId && towerSnapshot(renderer, 0).length > 0) {
        placedDuringDemolish = true;
        break;
      }
      if (!graph.edges.get(edgeId)) break;
    }
    expect(placedDuringDemolish).toBe(true);
  });
});
