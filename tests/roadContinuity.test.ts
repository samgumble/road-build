import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { ConstructionRenderer } from '../src/render/constructionRenderer';
import { buildRibbonGeometry, RoadRenderer } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';

function bridgeSampler(ctrl: P2[]): RoadSample[] {
  const [a, b] = ctrl;
  const length = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
  const out: RoadSample[] = [];
  for (let i = 0; i <= length; i++) {
    const u = i / length;
    out.push({
      x: a.x + (b.x - a.x) * u,
      y: 5,
      z: a.z + (b.z - a.z) * u,
      bridge: i >= 10 && i <= 30,
    });
  }
  return out;
}

function progress(bus: EventBus, edgeId: number, t: number): void {
  bus.emit('construction:progress', {
    edgeId,
    stage: 'gravel',
    t,
    pos: { x: t, y: 5, z: 0 },
    heading: 0,
    vehicle: 'truck',
    demolish: false,
    crew: 0,
    onBreak: false,
  });
}

describe('road and bridge continuity', () => {
  it('winds endpoint coverage upward so it renders from the gameplay camera', () => {
    const samples = bridgeSampler([{ x: 0, z: 0 }, { x: 8, z: 0 }]);
    const geo = buildRibbonGeometry(samples, 6, 0.1, 0, 8, 0, true, true);
    const positions = geo.getAttribute('position');
    const index = geo.getIndex()!;

    // Endpoint disks are appended after the ribbon strip. Find their triangles by starting at the
    // final 32 indices (16 triangles per disk) and verify the first visible face points +Y.
    const tri = index.count - 32 * 3;
    const a = index.getX(tri), b = index.getX(tri + 1), c = index.getX(tri + 2);
    const va = new THREE.Vector3(positions.getX(a), positions.getY(a), positions.getZ(a));
    const vb = new THREE.Vector3(positions.getX(b), positions.getY(b), positions.getZ(b));
    const vc = new THREE.Vector3(positions.getX(c), positions.getY(c), positions.getZ(c));
    const normalY = vb.sub(va).cross(vc.sub(va)).y;
    expect(normalY).toBeGreaterThan(0);
  });

  it('finishes and unmasks a short final bridge span after the gravel front leaves the run', () => {
    const bus = new EventBus();
    const hf = new Heightfield('bridge-final-span', bus);
    const graph = new RoadGraph(bus, bridgeSampler);
    const scene = new THREE.Scene();
    const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
    const constructionRenderer = new ConstructionRenderer(scene, bus, graph, hf, roadRenderer);
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    // The 20u bridge run splits into [10,26] + a short final [26,30] span. Entering the final
    // span settles the first. The gravel front then leaves the run before the final span's 1.85s
    // descend+bounce animation can finish — the exact timing that used to strand the deck mask.
    progress(bus, edgeId, 10);
    progress(bus, edgeId, 26);
    progress(bus, edgeId, 31);
    for (let i = 0; i < 3 * 60; i++) constructionRenderer.update(1 / 60, false);

    const visual = (roadRenderer as unknown as {
      visuals: Map<number, { bridgeMaskTo: number | null }>;
    }).visuals.get(edgeId)!;
    expect(visual.bridgeMaskTo).toBeNull();
  });

  it('adds full-width endpoint coverage so two painted road ribbons meet at a degree-2 corner', () => {
    const bus = new EventBus();
    const hf = new Heightfield('road-endpoint-caps', bus);
    const graph = new RoadGraph(bus, bridgeSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, hf);

    const [east] = graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
    const [north] = graph.commitChain([{ x: 40, z: 0 }, { x: 40, z: 40 }]);
    for (const edgeId of [east, north]) {
      graph.edges.get(edgeId)!.stage = 'painted';
      bus.emit('construction:stage', { edgeId, stage: 'painted', crew: 0 });
    }

    for (const edgeId of [east, north]) {
      const group = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      const capCount = group.children.reduce((sum, child) => {
        if (!(child instanceof THREE.Mesh)) return sum;
        return sum + Number(child.geometry.userData.roadEndpointCaps ?? 0);
      }, 0);
      expect(capCount).toBe(2);
    }
  });
});
