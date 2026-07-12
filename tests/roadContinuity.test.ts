import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { ConstructionRenderer } from '../src/render/constructionRenderer';
import {
  bridgeApproachRanges,
  buildRibbonGeometry,
  RoadRenderer,
  trimJunctionStripeRange,
} from '../src/render/roadRenderer';
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

function junctionSampler(ctrl: P2[]): RoadSample[] {
  const out: RoadSample[] = [];
  for (let segment = 0; segment < ctrl.length - 1; segment++) {
    const a = ctrl[segment], b = ctrl[segment + 1];
    const length = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
    for (let i = 0; i < length; i++) {
      const u = i / length;
      out.push({ x: a.x + (b.x - a.x) * u, y: 2, z: a.z + (b.z - a.z) * u, bridge: false });
    }
  }
  const last = ctrl[ctrl.length - 1];
  out.push({ x: last.x, y: 2, z: last.z, bridge: false });
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
  it('hands every completed road strip to one topology-owned junction surface', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('junction-geometry-owner', bus));
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'painted';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    }

    const junctionGroup = scene.getObjectByName('road-junction-surfaces') as THREE.Group;
    expect(junctionGroup).toBeTruthy();
    expect(junctionGroup.children.some((child) => child.userData.roadDetail === 'junctionSurface')).toBe(true);

    const junction = [...graph.nodes.values()].find((node) => graph.edgesAtNode(node.id).length === 3)!;
    for (const edgeId of graph.edgesAtNode(junction.id)) {
      const edgeGroup = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      const capCount = edgeGroup.children.reduce((sum, child) => {
        if (!(child instanceof THREE.Mesh)) return sum;
        return sum + Number(child.geometry.userData.roadEndpointCaps ?? 0);
      }, 0);
      expect(capCount).toBe(1); // only the remote dead-end; no circular strip overlay at the junction

      // Every edge-owned vertex stays outside the shared conflict area. This guards against a
      // future detail strip (ditch, wear, paint, pulse, etc.) bypassing junction ownership even if
      // the primary asphalt ribbon remains correct.
      let nearest = Infinity;
      for (const child of edgeGroup.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const positions = child.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          nearest = Math.min(nearest, Math.hypot(
            positions.getX(i) - junction.x,
            positions.getZ(i) - junction.z,
          ));
        }
      }
      expect(nearest).toBeGreaterThanOrEqual(5 - 1e-6);
    }
  });

  it('defines tapered ground-to-deck ownership on both sides of a bridge run', () => {
    const approaches = bridgeApproachRanges(bridgeSampler([{ x: 0, z: 0 }, { x: 40, z: 0 }]));
    expect(approaches).toEqual([
      { from: 4, to: 10, startWidth: 8.7, endWidth: 6 },
      { from: 30, to: 36, startWidth: 6, endWidth: 8.7 },
    ]);
  });

  it('renders bridge approaches as dedicated geometry instead of abrupt overlapping strips', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, bridgeSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('bridge-approach-geometry', bus));
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId, stage: 'painted', crew: 0 });

    const edgeGroup = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
    const approaches = edgeGroup.children.filter((child) => child.userData.roadDetail === 'bridgeApproach');
    expect(approaches).toHaveLength(2);

    const xBounds = (detail: string) => edgeGroup.children
      .filter((child) => child.userData.roadDetail === detail)
      .map((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry.computeBoundingBox();
        return [mesh.geometry.boundingBox!.min.x, mesh.geometry.boundingBox!.max.x];
      });
    expect(xBounds('bridgeApproach')).toEqual([[4, 10], [30, 36]]);
    // Remote dead-end disks extend half a road width beyond x=0/40; the inner bounds still stop
    // exactly at the approach ownership limits, with no coplanar surface underneath either taper.
    expect(xBounds('roadSurface')).toEqual([[-3, 4], [10, 30], [36, 43]]);
    expect(xBounds('shoulder')).toEqual([[0, 4], [36, 40]]);
    expect(xBounds('ditch')).toEqual([[0, 4], [36, 40]]);
  });

  it('clears center paint through a connected three-way intersection while preserving ordinary ends', () => {
    expect(trimJunctionStripeRange(0, 40, 40, 3, 1)).toEqual({ from: 5, to: 40 });
    expect(trimJunctionStripeRange(0, 40, 40, 2, 2)).toEqual({ from: 0, to: 40 });
    expect(trimJunctionStripeRange(0, 40, 40, 3, 3)).toEqual({ from: 5, to: 35 });
  });

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
