import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { ConstructionRenderer } from '../src/render/constructionRenderer';
import {
  bridgeApproachRanges,
  buildJunctionPatchGeometry,
  buildRibbonGeometry,
  RoadRenderer,
  trimJunctionStripeRange,
} from '../src/render/roadRenderer';
import { ROAD_SHOULDER_EXTRA_PER_SIDE, ROAD_WIDTH } from '../src/core/constants';
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

function renderedConnections() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, junctionSampler);
  const scene = new THREE.Scene();
  const renderer = new RoadRenderer(scene, graph, bus, new Heightfield('connection-fixture', bus));
  return { bus, graph, scene, renderer };
}

function paintAll(bus: EventBus, graph: RoadGraph): void {
  for (const edge of graph.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
}

function renderedCorner() {
  const fixture = renderedConnections();
  fixture.graph.commitChain([{ x: 0, z: 0 }, { x: 24, z: 0 }]);
  fixture.graph.commitChain([{ x: 24, z: 0 }, { x: 40, z: 16 }]);
  paintAll(fixture.bus, fixture.graph);
  return fixture;
}

function renderedPaintedLoop() {
  const fixture = renderedConnections();
  fixture.graph.commitChain([
    { x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 24 },
    { x: 0, z: 24 }, { x: 0, z: 0 },
  ]);
  paintAll(fixture.bus, fixture.graph);
  return fixture;
}

function connectionMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const root = scene.getObjectByName('road-connection-surfaces') as THREE.Group;
  const meshes: THREE.Mesh[] = [];
  root?.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

const makeRenderedGraph = renderedConnections;

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

    const junctionGroup = scene.getObjectByName('road-connection-surfaces') as THREE.Group;
    expect(junctionGroup).toBeTruthy();
    expect(connectionMeshes(scene).some((child) => child.userData.roadDetail === 'junctionSurface')).toBe(true);

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

  it('follows each arm profile height across a sloped junction patch instead of one flat plane', () => {
    // roads climb with +x (y = 2 + 0.1x); the junction at (24, 0) has arms whose trimmed ends sit
    // at different heights, so a flat max-height patch would float above the downhill arm.
    const slopedSampler = (ctrl: P2[]): RoadSample[] => {
      const out: RoadSample[] = [];
      for (let segment = 0; segment < ctrl.length - 1; segment++) {
        const a = ctrl[segment], b = ctrl[segment + 1];
        const length = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
        for (let i = 0; i < length; i++) {
          const u = i / length;
          const x = a.x + (b.x - a.x) * u;
          out.push({ x, y: 2 + 0.1 * x, z: a.z + (b.z - a.z) * u, bridge: false });
        }
      }
      const last = ctrl[ctrl.length - 1];
      out.push({ x: last.x, y: 2 + 0.1 * last.x, z: last.z, bridge: false });
      return out;
    };
    const bus = new EventBus();
    const graph = new RoadGraph(bus, slopedSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('sloped-junction', bus));
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'painted';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    }

    const patch = connectionMeshes(scene).find(
      (child) => child.userData.roadDetail === 'junctionSurface' && child.userData.junctionStage === 'paved',
    ) as THREE.Mesh;
    expect(patch).toBeTruthy();

    // painted patch lift is 0.18 + 0.003; each hull corner must carry ITS arm's profile height.
    const lift = 0.183;
    const positions = patch.geometry.getAttribute('position') as THREE.BufferAttribute;
    let sawWest = false, sawEast = false, sawNorth = false;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      if (x < 19.5) { sawWest = true; expect(y).toBeCloseTo(2 + 0.1 * 19 + lift, 2); }
      if (x > 28.5) { sawEast = true; expect(y).toBeCloseTo(2 + 0.1 * 29 + lift, 2); }
      if (z > 4.5) { sawNorth = true; expect(y).toBeCloseTo(2 + 0.1 * 24 + lift, 2); }
    }
    expect(sawWest && sawEast && sawNorth).toBe(true);
  });

  it('anchors junction patch corners to the actual trimmed arm cross-sections, not straight heading rays', () => {
    // one arm curves north within the trim reach: its real end cross-section sits at (4, 2) facing
    // +z, so the patch must reach the corners (1, 2) and (7, 2) at that arm's end height.
    const arms = [
      { heading: 0, y: 1, far: { x: 4, z: 2, y: 1.5, heading: Math.PI / 2 } },
      { heading: Math.PI, y: 1, far: { x: -5, z: 0, y: 1, heading: Math.PI } },
    ];
    const geo = buildJunctionPatchGeometry(0, 1, 0, arms, 6);
    const positions = geo.getAttribute('position') as THREE.BufferAttribute;
    const has = (x: number, z: number, y: number) => {
      for (let i = 0; i < positions.count; i++) {
        if (Math.abs(positions.getX(i) - x) < 1e-3
          && Math.abs(positions.getZ(i) - z) < 1e-3
          && Math.abs(positions.getY(i) - y) < 1e-3) return true;
      }
      return false;
    };
    expect(has(7, 2, 1.5)).toBe(true); // real trimmed-end corner of the curved arm
    expect(has(5, 3, 1.5) || has(5, -3, 1.5) || has(5, 3, 1) || has(5, -3, 1)).toBe(false); // no straight-ray ghost corner
  });

  it('sets drainage ditches back from owned junctions further than the surface trim', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('junction-ditch-setback', bus));
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'graded', crew: 0 });
    }

    const junction = [...graph.nodes.values()].find((node) => graph.edgesAtNode(node.id).length === 3)!;
    for (const edgeId of graph.edgesAtNode(junction.id)) {
      const edgeGroup = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      let nearestDitch = Infinity;
      let nearestShoulder = Infinity;
      for (const child of edgeGroup.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const detail = child.userData.roadDetail;
        if (detail !== 'ditch' && detail !== 'shoulder') continue;
        const positions = child.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const d = Math.hypot(positions.getX(i) - junction.x, positions.getZ(i) - junction.z);
          if (detail === 'ditch') nearestDitch = Math.min(nearestDitch, d);
          else nearestShoulder = Math.min(nearestShoulder, d);
        }
      }
      // ditches stop well before the apron; shoulders still meet the surface trim boundary
      expect(nearestDitch).toBeGreaterThanOrEqual(9.5);
      expect(nearestShoulder).toBeLessThanOrEqual(7.5);
    }
  });

  it('keeps shoulders and ditches off neighboring asphalt even at acute junction angles', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('acute-junction-verges', bus));
    // 45-degree Y-junction at (24, 0): the fixed-length verge trims that clear a 90-degree
    // crossing are NOT enough here — a strip 4.35-5u wide trimmed at 5u/9u still lies across the
    // 45-degree neighbor's 6u-wide road surface.
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 56, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'graded', crew: 0 });
    }

    // no shoulder/ditch vertex of one edge may sit inside another edge's road corridor
    for (const edge of graph.edges.values()) {
      const group = scene.children.find((child) => child.userData.edgeId === edge.id) as THREE.Group;
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const detail = child.userData.roadDetail;
        if (detail !== 'shoulder' && detail !== 'ditch') continue;
        const positions = child.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const vx = positions.getX(i), vz = positions.getZ(i);
          for (const other of graph.edges.values()) {
            if (other.id === edge.id) continue;
            for (const s of other.samples) {
              expect(Math.hypot(s.x - vx, s.z - vz)).toBeGreaterThanOrEqual(ROAD_WIDTH / 2 - 1e-6);
            }
          }
        }
      }
    }
  });

  it('extends the junction verge apron out to each arm shoulder start, closing acute-angle wedges', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('apron-extension', bus));
    // 45-degree Y at (24, 0): the acute arms' shoulders start ~9u out (angle-aware setback), so a
    // fixed 5u apron leaves a bare wedge between the apron edge and the shoulder start.
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 56, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'graded', crew: 0 });
    }

    const apron = connectionMeshes(scene).find((child) => child.userData.roadDetail === 'junctionVerge') as THREE.Mesh;
    expect(apron).toBeTruthy();
    const positions = apron.geometry.getAttribute('position') as THREE.BufferAttribute;
    let maxDist = 0;
    for (let i = 0; i < positions.count; i++) {
      maxDist = Math.max(maxDist, Math.hypot(positions.getX(i) - 24, positions.getZ(i)));
    }
    // far apron corners must reach the acute arms' shoulder starts (~9u along + half width),
    // not stop at the fixed 5u reach (whose corners cap out at ~6.6u from the node)
    expect(maxDist).toBeGreaterThanOrEqual(8.5);
  });

  it('keeps center dashes, tire wear, and surface details off neighboring asphalt at acute junctions', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('acute-junction-paint', bus));
    // ~27-degree fork: even the narrow centerline (0.5u) and tire-wear strips (up to 2.07u out)
    // cross the neighbor's 6u road when trimmed at the fixed 5u reach.
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 56, z: 16 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'painted';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    }

    for (const edge of graph.edges.values()) {
      const group = scene.children.find((child) => child.userData.edgeId === edge.id) as THREE.Group;
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const detail = child.userData.roadDetail;
        const isPaint = child.userData.wetPaint === true;
        const isWear = detail === 'tireWear' || detail === 'surfaceWear' || detail === 'puddles';
        if (!isPaint && !isWear) continue;
        const positions = child.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const vx = positions.getX(i), vz = positions.getZ(i);
          for (const other of graph.edges.values()) {
            if (other.id === edge.id) continue;
            for (const s of other.samples) {
              expect(Math.hypot(s.x - vx, s.z - vz)).toBeGreaterThanOrEqual(ROAD_WIDTH / 2 - 1e-6);
            }
          }
        }
      }
    }
  });

  it('paints stop lines and crosswalk bars only on stopped PAINTED arms, and none before paint', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('junction-crosswalks', bus));
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'graded';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'graded', crew: 0 });
    }
    const meshes = connectionMeshes(scene);
    // graded junction: no paint yet
    expect(meshes.some((child) => child.userData.roadDetail === 'junctionPaint')).toBe(false);

    for (const edge of graph.edges.values()) {
      edge.stage = 'painted';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    }
    const paint = connectionMeshes(scene).find((child) => child.userData.roadDetail === 'junctionPaint') as THREE.Mesh;
    expect(paint).toBeTruthy();
    expect(paint.userData.weatherSurface).toBe('paint');
    // This T has a clear east-west major pair, so only the north minor approach is stopped. The
    // current combined paint mesh intentionally keeps its crosswalk with that stopped approach.
    // Geometry remains near the arm mouth, inside the road width, above the asphalt.
    // 5-8u from the node, inside the road width, floating just above the asphalt
    const positions = paint.geometry.getAttribute('position') as THREE.BufferAttribute;
    const armHits = { west: false, east: false, north: false };
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      expect(y).toBeGreaterThan(2.2); // sits above the deck (sampler y=2), never on the terrain
      const dx = x - 24, dz = z;
      const d = Math.hypot(dx, dz);
      expect(d).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(d).toBeLessThanOrEqual(8.5);
      if (dx < -4.9) armHits.west = true;
      if (dx > 4.9) armHits.east = true;
      if (dz > 4.9) armHits.north = true;
    }
    expect(armHits).toEqual({ west: false, east: false, north: true });
  });

  it('lays a shoulder-width verge apron under every junction patch', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, junctionSampler);
    const scene = new THREE.Scene();
    new RoadRenderer(scene, graph, bus, new Heightfield('junction-verge-apron', bus));
    graph.commitChain([{ x: 0, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 24, z: 0 }, { x: 24, z: 32 }]);
    for (const edge of graph.edges.values()) {
      edge.stage = 'painted';
      bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
    }

    const meshes = connectionMeshes(scene);
    const apron = meshes.find((child) => child.userData.roadDetail === 'junctionVerge') as THREE.Mesh;
    expect(apron).toBeTruthy();
    expect(apron.userData.weatherSurface).toBe('gravel'); // painted arms -> gravel verge, like buildShoulders
    apron.geometry.computeBoundingBox();
    const bounds = apron.geometry.boundingBox!;
    const shoulderWidth = ROAD_WIDTH + ROAD_SHOULDER_EXTRA_PER_SIDE * 2;
    // wide enough that each arm's shoulder stub blends into the apron instead of ending raw
    expect(bounds.max.z - bounds.min.z).toBeGreaterThanOrEqual(shoulderWidth - 1e-6);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThanOrEqual(shoulderWidth - 1e-6);
    // and it sits under the surface patch, not over it
    const patch = meshes.find((child) => child.userData.roadDetail === 'junctionSurface') as THREE.Mesh;
    patch.geometry.computeBoundingBox();
    expect(bounds.max.y).toBeLessThan(patch.geometry.boundingBox!.max.y);
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

  it('lowers deck segments span-length LONG along the road and road-width wide across it', () => {
    const bus = new EventBus();
    const hf = new Heightfield('deck-segment-size', bus);
    const graph = new RoadGraph(bus, bridgeSampler);
    const scene = new THREE.Scene();
    const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
    const constructionRenderer = new ConstructionRenderer(scene, bus, graph, hf, roadRenderer);
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });

    progress(bus, edgeId, 10);
    progress(bus, edgeId, 18); // mid first 16u span [10,26]: the segment is descending
    for (let i = 0; i < 12; i++) constructionRenderer.update(1 / 60, false);

    const segment = scene.getObjectByName('crane-deck-segment') as THREE.Mesh;
    expect(segment).toBeTruthy();
    expect(segment.visible).toBe(true);
    // The road runs along +x (heading 0), so local X is the along-road axis: the slab must be
    // 16u LONG along the run and ~one road width ACROSS it — not a 16u-wide plank over a 6u deck.
    expect(segment.scale.x).toBeCloseTo(16, 3);
    expect(segment.scale.z).toBeCloseTo(ROAD_WIDTH * 0.9, 3);
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

  it('uses one shared degree-2 seam with continuous paint and no overlapping caps', () => {
    const { graph, scene } = renderedCorner();
    const node = [...graph.nodes.values()].find((candidate) => graph.edgesAtNode(candidate.id).length === 2)!;
    const connectionGroup = scene.getObjectByName(`road-connection-${node.id}`) as THREE.Group;
    expect(connectionGroup).toBeTruthy();
    expect(connectionGroup.children.filter((child) => child.userData.roadDetail === 'connectionSurface')).toHaveLength(1);
    expect(connectionGroup.children.filter((child) => child.userData.roadDetail === 'connectionCenterline')).toHaveLength(1);

    for (const edgeId of graph.edgesAtNode(node.id)) {
      const group = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      const capCount = group.children.reduce((sum, child) => {
        if (!(child instanceof THREE.Mesh)) return sum;
        return sum + Number(child.geometry.userData.roadEndpointCaps ?? 0);
      }, 0);
      expect(capCount).toBe(1); // remote degree-1 end only
    }
  });

  it('gives both closed-loop nodes seam geometry without controls', () => {
    const { graph, scene } = renderedPaintedLoop();
    for (const node of graph.nodes.values()) {
      const group = scene.getObjectByName(`road-connection-${node.id}`)!;
      expect(group.children.some((child) => child.userData.roadDetail === 'connectionSurface')).toBe(true);
      expect(group.children.some((child) => child.userData.roadDetail === 'junctionSurface')).toBe(false);
    }
  });

  it('rebuilds affected connections once and ignores traffic, growth, weather, and frames', () => {
    const { bus, graph, renderer, scene } = makeRenderedGraph();
    graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
    graph.commitChain([{ x: 32, z: 0 }, { x: 40, z: 8 }]);
    paintAll(bus, graph);
    const node = [...graph.nodes.values()].find((candidate) => candidate.x === 32 && candidate.z === 0)!;
    const before = (scene.getObjectByName(`road-connection-${node.id}`)!.children[0] as THREE.Mesh).geometry;

    bus.emit('traffic:edgeEntered', { edgeId: 1, carId: 1, pos: { x: 0, y: 0, z: 0 }, firstUse: false });
    bus.emit('growth:spawn', { id: 1, kind: 'house', x: 8, z: 8, rot: 0 });
    renderer.update(1 / 60, 1);
    bus.emit('roads:connectionsChanged', { nodeIds: [node.id] }); // unchanged topology signature

    const after = (scene.getObjectByName(`road-connection-${node.id}`)!.children[0] as THREE.Mesh).geometry;
    expect(after).toBe(before);
  });

  it('rebuilds every existing incident edge after a new tie-in', () => {
    const { bus, graph, scene } = makeRenderedGraph();
    const [west] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    const [east] = graph.commitChain([{ x: 16, z: 0 }, { x: 32, z: 0 }]);
    for (const edgeId of [west, east]) {
      graph.edges.get(edgeId)!.stage = 'painted';
      bus.emit('construction:stage', { edgeId, stage: 'painted', crew: 0 });
    }
    const oldByEdge = new Map([west, east].map((edgeId) => {
      const group = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      return [edgeId, new Set(group.children.map((child) => (child as THREE.Mesh).geometry))] as const;
    }));

    graph.commitChain([{ x: 16, z: 0 }, { x: 16, z: 24 }]);

    const junction = [...graph.nodes.values()].find((candidate) => candidate.x === 16 && candidate.z === 0)!;
    expect(graph.edgesAtNode(junction.id)).toHaveLength(3);
    for (const edgeId of [west, east]) {
      const group = scene.children.find((child) => child.userData.edgeId === edgeId) as THREE.Group;
      expect(group.children.every((child) => !oldByEdge.get(edgeId)!.has((child as THREE.Mesh).geometry))).toBe(true);
    }
  });

  it('refreshes exactly the changed edge endpoints and disposes replaced connection geometry', () => {
    const { bus, graph, scene } = makeRenderedGraph();
    graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    const [center] = graph.commitChain([{ x: 16, z: 0 }, { x: 32, z: 0 }]);
    graph.commitChain([{ x: 32, z: 0 }, { x: 48, z: 0 }]);
    graph.commitChain([{ x: 64, z: 0 }, { x: 80, z: 0 }]);
    graph.commitChain([{ x: 80, z: 0 }, { x: 88, z: 8 }]);
    paintAll(bus, graph);

    const nodeAt = (x: number) => [...graph.nodes.values()].find((node) => node.x === x && node.z === 0)!;
    const ids = [nodeAt(16).id, nodeAt(32).id, nodeAt(80).id];
    const before = new Map(ids.map((id) => [id, scene.getObjectByName(`road-connection-${id}`)!]));
    const replacedGeometry = before.get(ids[0])!.children[0] as THREE.Mesh;
    let disposed = false;
    replacedGeometry.geometry.addEventListener('dispose', () => { disposed = true; });

    graph.edges.get(center)!.stage = 'paved';
    bus.emit('construction:stage', { edgeId: center, stage: 'paved', crew: 0 });

    expect(scene.getObjectByName(`road-connection-${ids[0]}`)).not.toBe(before.get(ids[0]));
    expect(scene.getObjectByName(`road-connection-${ids[1]}`)).not.toBe(before.get(ids[1]));
    expect(scene.getObjectByName(`road-connection-${ids[2]}`)).toBe(before.get(ids[2]));
    expect(disposed).toBe(true);
  });

  it('defers new-edge geometry until the topology transaction is complete', () => {
    const { bus, graph, scene } = makeRenderedGraph();
    let renderedDuringEdgeAdded = false;
    bus.on('roads:edgeAdded', ({ edgeId }) => {
      renderedDuringEdgeAdded = scene.children.some((child) => child.userData.edgeId === edgeId);
    });

    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);

    expect(renderedDuringEdgeAdded).toBe(false);
    expect(scene.children.some((child) => child.userData.edgeId === edgeId)).toBe(true);
  });

  it('does not retain cache entries for pruned degree-1 endpoint nodes', () => {
    const { graph, renderer } = makeRenderedGraph();
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
    const caches = renderer as unknown as {
      connectionTopologySignatures: Map<number, string>;
      connectionSurfaceSignatures: Map<number, string>;
    };

    expect(caches.connectionTopologySignatures.size).toBe(0);
    expect(caches.connectionSurfaceSignatures.size).toBe(0);
    graph.removeEdge(edgeId);
    expect(caches.connectionTopologySignatures.size).toBe(0);
    expect(caches.connectionSurfaceSignatures.size).toBe(0);
  });
});
