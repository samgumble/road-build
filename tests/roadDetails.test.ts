import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, buildRibbonGeometry } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import { Heightfield } from '../src/sim/terrain/heightfield';
import type { P2, RoadSample, Stage } from '../src/core/types';
import { ROAD_WIDTH } from '../src/core/constants';

function sampler(bridge: boolean) {
  return (ctrl: P2[]): RoadSample[] => {
    const [a, b] = ctrl;
    const out: RoadSample[] = [];
    const length = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
    for (let i = 0; i <= length; i++) {
      const u = i / length;
      out.push({ x: a.x + (b.x - a.x) * u, y: 1, z: a.z + (b.z - a.z) * u, bridge });
    }
    return out;
  };
}

function renderedEdge(stage: Stage, bridge = false): THREE.Group {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, sampler(bridge));
  const scene = new THREE.Scene();
  const renderer = new RoadRenderer(scene, graph, bus, new Heightfield(`road-detail-${stage}-${bridge}`));
  const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
  const edge = graph.edges.get(edgeId)!;
  edge.stage = stage;
  bus.emit('construction:stage', { edgeId, stage, crew: 0 });
  renderer.update(0.2);
  return scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
}

describe('road integration details', () => {
  it('adds a wider terrain-hugging shoulder once grading begins', () => {
    const group = renderedEdge('graded');
    const shoulder = group.children.find((child) => child.userData.roadDetail === 'shoulder') as THREE.Mesh;

    expect(shoulder).toBeTruthy();
    shoulder.geometry.computeBoundingBox();
    const bounds = shoulder.geometry.boundingBox!;
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(ROAD_WIDTH + 2);
    expect(shoulder.userData.weatherSurface).toBe('earth');
  });

  it('adds subtle paired tire wear only to completed painted asphalt', () => {
    const paved = renderedEdge('paved');
    const painted = renderedEdge('painted');

    expect(paved.children.some((child) => child.userData.roadDetail === 'tireWear')).toBe(false);
    const wear = painted.children.find((child) => child.userData.roadDetail === 'tireWear') as THREE.Mesh;
    expect(wear).toBeTruthy();
    expect((wear.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    expect((wear.material as THREE.MeshStandardMaterial).opacity).toBeLessThan(0.3);
    expect(wear.userData.weatherSurface).toBe('asphalt');
  });

  it('does not draw terrain shoulders alongside bridge decks', () => {
    const group = renderedEdge('painted', true);
    expect(group.children.some((child) => child.userData.roadDetail === 'shoulder')).toBe(false);
  });

  it('cuts shallow drainage ditches outside both ground-road shoulders', () => {
    const group = renderedEdge('graded');
    const ditch = group.children.find((child) => child.userData.roadDetail === 'ditch') as THREE.Mesh;
    expect(ditch).toBeTruthy();
    ditch.geometry.computeBoundingBox();
    const bounds = ditch.geometry.boundingBox!;
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(ROAD_WIDTH + 3);
    expect(ditch.userData.weatherSurface).toBe('earth');
  });

  it('drapes conforming ribbons onto the terrain: up-slope they sit on the grass, down-slope they never sink below road height', () => {
    const samples: RoadSample[] = [];
    for (let x = 0; x <= 48; x += 2) samples.push({ x, y: 1, z: 0, bridge: false });
    const crossSlope = (_x: number, z: number) => z * 0.5; // terrain rises with +z, falls with -z

    // uphill verge (offset +6, width 4 -> vertices at z in [4, 8]): terrain is ABOVE road height,
    // so every vertex must follow the terrain surface rather than floating at road height.
    const uphill = buildRibbonGeometry(samples, 4, 0.02, 0, 48, 6, false, false, undefined, crossSlope);
    const up = uphill.getAttribute('position') as THREE.BufferAttribute;
    expect(up.count).toBeGreaterThan(0);
    for (let i = 0; i < up.count; i++) {
      expect(up.getY(i)).toBeCloseTo(Math.max(1, up.getZ(i) * 0.5) + 0.02, 3);
    }

    // downhill verge (offset -6): terrain is BELOW road height — the strip must clamp to road
    // height rather than dropping under the asphalt edge.
    const downhill = buildRibbonGeometry(samples, 4, 0.02, 0, 48, -6, false, false, undefined, crossSlope);
    const down = downhill.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < down.count; i++) {
      expect(down.getY(i)).toBeCloseTo(1.02, 3);
    }
  });

  it('does not float drainage ditches beside bridge decks', () => {
    const group = renderedEdge('painted', true);
    expect(group.children.some((child) => child.userData.roadDetail === 'ditch')).toBe(false);
    expect(group.children.some((child) => child.userData.roadDetail === 'surfaceWear')).toBe(false);
    expect(group.children.some((child) => child.userData.roadDetail === 'puddles')).toBe(false);
  });
});
