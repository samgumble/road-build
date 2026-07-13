import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { RoadGraph } from '../src/sim/roads/graph';
import { planRoadsideDetails } from '../src/render/roadsideRenderer';
import { RoadsideRenderer } from '../src/render/roadsideRenderer';
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
  heightAt: (_x: number, z: number) => z < -4 ? -3 : z > 4 ? 2 : 0,
  isLand: (_x: number, z: number) => z > -5,
};

describe('context-sensitive roadside detail planning', () => {
  it('is deterministic and selects safety/drainage details from terrain context', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, sampler);
    graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }]);
    graph.commitChain([{ x: 40, z: 0 }, { x: 40, z: 40 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const settlements = [{ id: 1, kind: 'house' as const, x: 25, z: 10 }];

    const first = planRoadsideDetails(graph, terrain, settlements);
    const second = planRoadsideDetails(graph, terrain, settlements);
    expect(first).toEqual(second);
    expect(first.guardrails.length).toBeGreaterThan(0);
    expect(first.retainingWalls.length).toBeGreaterThan(0);
    expect(first.culverts.length).toBeGreaterThan(0);
    expect(first.signs.length).toBeGreaterThan(0);
    expect(first.utilityPoles.length).toBeGreaterThan(0);
    expect('junctionAprons' in first).toBe(false); // RoadRenderer owns topology-shaped junctions.
  });

  it('never places ground furniture on bridge samples', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, (ctrl) => sampler(ctrl).map((sample) => ({ ...sample, bridge: true })));
    graph.commitChain([{ x: 0, z: 0 }, { x: 80, z: 0 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const plan = planRoadsideDetails(graph, terrain, []);
    expect(plan.guardrails).toEqual([]);
    expect(plan.retainingWalls).toEqual([]);
    expect(plan.culverts).toEqual([]);
    expect(plan.reflectors).toEqual([]);
    expect(plan.utilityPoles).toEqual([]);
    expect(plan.streetlamps).toEqual([]);
  });

  it('plans streetlamps only on painted stretches near settlements, on the opposite station parity to utility poles', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, sampler);
    graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const settlements = [{ id: 1, kind: 'house' as const, x: 25, z: 10 }];

    const plan = planRoadsideDetails(graph, terrain, settlements);
    expect(plan.streetlamps.length).toBeGreaterThan(0);
    // every lamp stands close to the settlement that justified it (24u sample radius + verge offset)
    for (const lamp of plan.streetlamps) {
      expect(Math.hypot(lamp.x - 25, lamp.z - 10)).toBeLessThanOrEqual(24 + 8);
    }

    // no settlements -> no lamps; unpainted road -> no lamps
    expect(planRoadsideDetails(graph, terrain, []).streetlamps).toEqual([]);
    for (const edge of graph.edges.values()) edge.stage = 'gravel';
    expect(planRoadsideDetails(graph, terrain, settlements).streetlamps).toEqual([]);
  });

  it('night-gates the lamp head glow and light pool through setNight', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, sampler);
    const scene = new THREE.Scene();
    const renderer = new RoadsideRenderer(scene, graph, terrain, bus);
    const group = scene.getObjectByName('roadside-context-details')!;
    const head = group.getObjectByName('streetlamp-heads') as THREE.InstancedMesh;
    const glow = group.getObjectByName('streetlamp-glow') as THREE.InstancedMesh;
    expect(head).toBeTruthy();
    expect(glow).toBeTruthy();

    renderer.setNight(true);
    expect((head.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(1);
    expect((glow.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
    renderer.setNight(false);
    expect((head.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeLessThan(0.2);
    expect((glow.material as THREE.MeshBasicMaterial).opacity).toBe(0);
    renderer.dispose();
  });

  it('uses a fixed bounded set of shared instanced pools', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, sampler);
    const scene = new THREE.Scene();
    const renderer = new RoadsideRenderer(scene, graph, terrain, bus);
    graph.commitChain([{ x: 0, z: 0 }, { x: 80, z: 0 }]);
    const edge = [...graph.edges.values()][0];
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    const group = scene.getObjectByName('roadside-context-details')!;
    expect(group.children.every((child) => child instanceof THREE.InstancedMesh)).toBe(true);
    expect(group.children.length).toBe(13); // 10 context-furniture pools + lamp post/head/glow
    renderer.dispose();
  });
});
