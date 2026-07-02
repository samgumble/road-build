import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, ROLLER_TRAIL_DISTANCE, PAVED_COMPACTED_COLOR, STAGE_COLOR } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import { Heightfield } from '../src/sim/terrain/heightfield';
import type { P2, RoadSample } from '../src/core/types';

// Flat, densely-sampled straight-line stub sampler (1 unit apart) so arclength distances
// line up with control-point coordinates, matching the pattern used in graph.test.ts.
const stubSampler = (ctrl: P2[]): RoadSample[] => {
  const out: RoadSample[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const a = ctrl[i];
    const b = ctrl[i + 1];
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(dist));
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      out.push({ x: a.x + (b.x - a.x) * u, y: 1, z: a.z + (b.z - a.z) * u, bridge: false });
    }
  }
  const last = ctrl[ctrl.length - 1];
  out.push({ x: last.x, y: 1, z: last.z, bridge: false });
  return out;
};

function meshColorHex(mesh: THREE.Mesh): number {
  return (mesh.material as THREE.MeshStandardMaterial).color.getHex();
}

function colorToHex(cssHex: string): number {
  return new THREE.Color(cssHex).getHex();
}

describe('roller compaction darkening', () => {
  it('splits the paved ribbon into a compacted-darker mesh behind the roller and a fresh mesh ahead of it', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, stubSampler);
    const scene = new THREE.Scene();
    const hf = new Heightfield('roller-test-seed');
    const renderer = new RoadRenderer(scene, graph, bus, hf);

    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.length).toBeCloseTo(64, 0);

    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;
    expect(group).toBeTruthy();

    const compactedHex = colorToHex(PAVED_COMPACTED_COLOR);
    const freshHex = colorToHex(STAGE_COLOR.paved);

    const meshColors = () =>
      group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh).map(meshColorHex);

    // Before any 'paved' progress (still mid-'graded' stage progress), there must be no
    // compacted-color mesh anywhere on this edge.
    bus.emit('construction:stage', { edgeId, stage: 'graded' });
    bus.emit('construction:progress', {
      edgeId, stage: 'graded', t: 10,
      pos: { x: 10, y: 1, z: 0 }, heading: 0, vehicle: 'truck', demolish: false,
    });
    renderer.update(0.2); // flush the 0.15s rebuild throttle
    expect(meshColors()).not.toContain(compactedHex);

    // Enter 'paved' stage, then push partial progress to t=30 on a 64u edge. The roller
    // trails the paver by ROLLER_TRAIL_DISTANCE, so the compacted/fresh split should sit at
    // t=30-ROLLER_TRAIL_DISTANCE=22.
    bus.emit('construction:stage', { edgeId, stage: 'paved' });
    bus.emit('construction:progress', {
      edgeId, stage: 'paved', t: 30,
      pos: { x: 30, y: 1, z: 0 }, heading: 0, vehicle: 'roller', demolish: false,
    });
    renderer.update(0.2); // advance clock past REBUILD_THROTTLE (0.15s) to flush pending progress

    const colorsAfterPaving = meshColors();
    expect(colorsAfterPaving).toContain(compactedHex);
    expect(colorsAfterPaving).toContain(freshHex);
    expect(ROLLER_TRAIL_DISTANCE).toBeLessThan(30); // sanity: split point (30 - 8 = 22) is within [0, 30]
  });
});
