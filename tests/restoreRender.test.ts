import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, STAGE_COLOR } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { GrowthSim } from '../src/sim/growth/growth';
import { EventBus } from '../src/core/events';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { createRng } from '../src/core/rng';
import type { P2, RoadSample } from '../src/core/types';

// Flat stub sampler, same pattern as rollerDarkening.test.ts / graph.test.ts.
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

function buildWorld(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, stubSampler);
  const scene = new THREE.Scene();
  const renderer = new RoadRenderer(scene, graph, bus, hf);
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  return { bus, hf, graph, scene, renderer, growth };
}

describe('restoreWorld render sync', () => {
  it('restored painted edges render as painted, not survey dashes', () => {
    const surveyedHex = colorToHex(STAGE_COLOR.surveyed);
    const paintedHex = colorToHex(STAGE_COLOR.painted);

    // Build a source world, paint an edge fully, and serialize it.
    const w1 = buildWorld('restore-render-test');
    const [edgeId] = w1.graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
    w1.graph.edges.get(edgeId)!.stage = 'painted';
    const json = serialize({ seed: 'restore-render-test', timeOfDay: 0.5, graph: w1.graph, growth: w1.growth });
    const save = deserialize(json)!;

    // Fresh world + fresh scene + fresh RoadRenderer, then restore into it.
    const w2 = buildWorld('restore-render-test');
    restoreWorld(save, { bus: w2.bus, hf: w2.hf, graph: w2.graph, growth: w2.growth });

    const restoredEdgeId = [...w2.graph.edges.keys()][0];
    const group = w2.scene.children.find((c) => c.userData.edgeId === restoredEdgeId) as THREE.Group;
    expect(group).toBeTruthy();

    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const colors = meshes.map(meshColorHex);

    // Must contain the painted/paved full-width ribbon color...
    expect(colors).toContain(paintedHex);
    // ...and must NOT be a survey-only group (no full set of survey-orange dashes with nothing else).
    const allSurveyed = colors.length > 0 && colors.every((c) => c === surveyedHex);
    expect(allSurveyed).toBe(false);
    expect(colors).not.toContain(surveyedHex);
  });
});
