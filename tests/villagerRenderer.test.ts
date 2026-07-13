import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { RoadGraph } from '../src/sim/roads/graph';
import { planVillagerRoutes, pingPong, VILLAGER_CAP, VillagerRenderer } from '../src/render/villagerRenderer';
import * as THREE from 'three';

const sampler = (ctrl: P2[]): RoadSample[] => {
  const out: RoadSample[] = [];
  for (let segment = 0; segment < ctrl.length - 1; segment++) {
    const a = ctrl[segment], b = ctrl[segment + 1];
    for (let i = 0; i < 10; i++) {
      const u = i / 10;
      out.push({ x: a.x + (b.x - a.x) * u, y: 0, z: a.z + (b.z - a.z) * u, bridge: false });
    }
  }
  const last = ctrl[ctrl.length - 1];
  out.push({ x: last.x, y: 0, z: last.z, bridge: false });
  return out;
};

const terrain = {
  heightAt: () => 0,
  isLand: () => true,
};

function paintedWorld() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, sampler);
  graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }]);
  for (const edge of graph.edges.values()) edge.stage = 'painted';
  return { bus, graph };
}

describe('villager stroll planning', () => {
  it('routes villagers only along painted edges with a settlement nearby, deterministically', () => {
    const { graph } = paintedWorld();
    const settlements = [{ id: 1, kind: 'house' as const, x: 25, z: 8 }];

    const routes = planVillagerRoutes(graph, settlements);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.length).toBeLessThanOrEqual(VILLAGER_CAP);
    expect(planVillagerRoutes(graph, settlements)).toEqual(routes);

    // no settlements -> nobody strolls; unpainted -> nobody strolls
    expect(planVillagerRoutes(graph, [])).toEqual([]);
    for (const edge of graph.edges.values()) edge.stage = 'gravel';
    expect(planVillagerRoutes(graph, settlements)).toEqual([]);
  });

  it('every route hugs the stretch of road its settlement fronts', () => {
    const { graph } = paintedWorld();
    const settlements = [{ id: 1, kind: 'house' as const, x: 25, z: 8 }];
    for (const route of planVillagerRoutes(graph, settlements)) {
      const edge = graph.edges.get(route.edgeId)!;
      expect(edge).toBeTruthy();
      expect(route.toT).toBeGreaterThan(route.fromT);
      // route window sits within the edge's own arclength
      expect(route.fromT).toBeGreaterThanOrEqual(0);
      expect(route.toT).toBeLessThanOrEqual(edge.length + 1e-6);
    }
  });

  it('pingPong walks 0 -> 1 -> 0 continuously', () => {
    expect(pingPong(0)).toBeCloseTo(0);
    expect(pingPong(0.5)).toBeCloseTo(0.5);
    expect(pingPong(1)).toBeCloseTo(1);
    expect(pingPong(1.5)).toBeCloseTo(0.5);
    expect(pingPong(2)).toBeCloseTo(0);
    expect(pingPong(2.25)).toBeCloseTo(0.25);
  });
});

describe('VillagerRenderer', () => {
  it('builds three shared instanced part meshes, walks villagers by day, and hides them at night', () => {
    const { bus, graph } = paintedWorld();
    const scene = new THREE.Scene();
    const renderer = new VillagerRenderer(scene, graph, terrain, bus);
    bus.emit('growth:spawn', { kind: 'house', x: 25, z: 8, rot: 0, id: 1 });

    const group = scene.getObjectByName('villagers')!;
    expect(group).toBeTruthy();
    expect(group.children.length).toBe(3);
    expect(group.children.every((c) => c instanceof THREE.InstancedMesh)).toBe(true);

    renderer.update(0.5);
    const torso = group.children[0] as THREE.InstancedMesh;
    expect(torso.count).toBeGreaterThan(0);

    bus.emit('atmosphere:phase', { night: true });
    expect(group.visible).toBe(false);
    bus.emit('atmosphere:phase', { night: false });
    expect(group.visible).toBe(true);

    renderer.dispose();
    expect(scene.getObjectByName('villagers')).toBeUndefined();
  });
});
