import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { RoadGraph } from '../src/sim/roads/graph';
import { planRoadsideDetails } from '../src/render/roadsideRenderer';
import { RoadsideRenderer } from '../src/render/roadsideRenderer';
import { BRIDGE_RAIL_OFFSET, STAGE_YLIFT } from '../src/render/roadRenderer';
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

  it('rails both verges of every road-to-bridge approach, on the land side only', () => {
    const bus = new EventBus();
    // straight 80u road along x with a bridge span between x=20 and x=60; flat land everywhere so
    // no drop/water guardrails muddy the assertion — every rail must come from the approaches.
    // Sampled at 2u (the real sampler's spacing) so the setback walk lands where it would in game.
    const bridgeSampler = (ctrl: P2[]): RoadSample[] => {
      const out: RoadSample[] = [];
      const a = ctrl[0], b = ctrl[ctrl.length - 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.round(length / 2);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const x = a.x + (b.x - a.x) * u;
        const z = a.z + (b.z - a.z) * u;
        out.push({ x, y: 0, z, bridge: x > 20 && x < 60 });
      }
      return out;
    };
    const graph = new RoadGraph(bus, bridgeSampler);
    graph.commitChain([{ x: 0, z: 0 }, { x: 80, z: 0 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const flat = { heightAt: () => 0, isLand: () => true };

    const plan = planRoadsideDetails(graph, flat, []);
    expect(plan.guardrails.length).toBeGreaterThanOrEqual(8); // 2 rails x 2 verges x 2 approaches

    for (const rail of plan.guardrails) {
      // never out on the deck: every approach rail stands on the land run
      expect(rail.x <= 20 + 1e-6 || rail.x >= 60 - 1e-6).toBe(true);
      // and hugs one of the two transitions rather than scattering down the road
      const nearTransition = Math.min(Math.abs(rail.x - 20), Math.abs(rail.x - 60));
      expect(nearTransition).toBeLessThanOrEqual(12);
    }
    // both verges of the road are railed (road runs along x, so verges sit at +/-z)
    expect(plan.guardrails.some((rail) => rail.z > 0)).toBe(true);
    expect(plan.guardrails.some((rail) => rail.z < 0)).toBe(true);
    // deterministic like every other detail
    expect(planRoadsideDetails(graph, flat, [])).toEqual(plan);
  });

  it('poses approach rails on the bridge rail line at road height, never down on the terrain', () => {
    const bus = new EventBus();
    // road on a 4u embankment; terrain sits 1u below (too shallow for drop rails, so every rail
    // in the plan comes from the bridge approaches). The deck's own rails run at BRIDGE_RAIL_OFFSET
    // from the centerline at deck height — the approach rails must continue that exact line.
    const bridgeSampler = (ctrl: P2[]): RoadSample[] => {
      const out: RoadSample[] = [];
      const a = ctrl[0], b = ctrl[ctrl.length - 1];
      const steps = Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const x = a.x + (b.x - a.x) * u;
        out.push({ x, y: 4, z: a.z + (b.z - a.z) * u, bridge: x > 20 && x < 60 });
      }
      return out;
    };
    const graph = new RoadGraph(bus, bridgeSampler);
    graph.commitChain([{ x: 0, z: 0 }, { x: 80, z: 0 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const embankment = { heightAt: () => 3, isLand: () => true };

    const plan = planRoadsideDetails(graph, embankment, []);
    expect(plan.guardrails.length).toBeGreaterThanOrEqual(8);
    for (const rail of plan.guardrails) {
      // laterally on the deck-rail line (road runs along x, so the offset shows up in z)…
      expect(Math.abs(rail.z)).toBeCloseTo(BRIDGE_RAIL_OFFSET, 5);
      // …and vertically anchored to the road surface, not the terrain 1u below
      expect(rail.y).toBeCloseTo(4 + STAGE_YLIFT.paved, 5);
    }
  });

  it('keeps cosmetic roadside props out of intersection aprons', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, sampler);
    graph.commitChain([{ x: 0, z: 0 }, { x: 24, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 40 }]);
    for (const edge of graph.edges.values()) edge.stage = 'painted';
    const flat = { heightAt: () => 0, isLand: () => true };
    const settlements = [{ id: 1, kind: 'building' as const, x: 24, z: 8 }];

    const plan = planRoadsideDetails(graph, flat, settlements);
    const props = [
      ...plan.gravelScatter, ...plan.reflectors, ...plan.utilityPoles,
      ...plan.streetlamps, ...plan.culverts,
    ];
    expect(props.length).toBeGreaterThan(0); // stations away from the junction still get furniture
    for (const prop of props) {
      expect(Math.hypot(prop.x - 24, prop.z - 0)).toBeGreaterThan(9);
    }
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
