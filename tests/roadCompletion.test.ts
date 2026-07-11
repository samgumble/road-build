import { describe, expect, it } from 'vitest';
import { roadStageCue } from '../src/audio/ambient';
import * as THREE from 'three';
import { RoadRenderer } from '../src/render/roadRenderer';
import { EventBus } from '../src/core/events';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import type { P2, RoadSample } from '../src/core/types';

describe('road completion cue profile', () => {
  it('reserves the completion swell for newly painted roads', () => {
    expect(roadStageCue('painted')).toBe('complete');
    expect(roadStageCue('graded')).toBe('progress');
    expect(roadStageCue('removed')).toBe('none');
  });

  it('fades the live opening sheen and does not recreate it during restore replay', () => {
    const bus = new EventBus();
    const sampler = (ctrl: P2[]): RoadSample[] => [
      { x: ctrl[0].x, y: 0, z: ctrl[0].z, bridge: false },
      { x: ctrl[1].x, y: 0, z: ctrl[1].z, bridge: false },
    ];
    const graph = new RoadGraph(bus, sampler);
    const scene = new THREE.Scene();
    const renderer = new RoadRenderer(scene, graph, bus, new Heightfield('completion-pulse'));
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 80, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId, stage: 'painted', crew: 0 });
    renderer.update(2);
    const group = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
    const pulse = group.children.find((child) => child.userData.roadDetail === 'openingPulse') as THREE.Mesh;
    expect((pulse.material as THREE.MeshStandardMaterial).opacity).toBe(0);

    bus.emit('construction:stage', { edgeId, stage: 'painted', crew: -1 });
    expect(group.children.some((child) => child.userData.roadDetail === 'openingPulse')).toBe(false);
  });
});
