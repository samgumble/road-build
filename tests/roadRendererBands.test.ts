import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, STAGE_COLOR } from '../src/render/roadRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import { Heightfield } from '../src/sim/terrain/heightfield';
import type { P2, RoadSample } from '../src/core/types';

// Flat, densely-sampled straight-line stub sampler (1 unit apart) so arclength distances line up
// with control-point coordinates — same pattern rollerDarkening.test.ts already uses.
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

function colorToHex(cssHex: string): number {
  return new THREE.Color(cssHex).getHex();
}

function meshColorHex(mesh: THREE.Mesh): number {
  return (mesh.material as THREE.MeshStandardMaterial).color.getHex();
}

/** Sums the world-space arclength footprint of every mesh in `group` whose material color
 * matches `hex`, by reading each mesh's own ribbon geometry bounding box along X (the stub
 * sampler's straight line runs along +X, so X-extent is a reliable arclength proxy here). Used to
 * sanity-check band boundaries land roughly where expected without hand-rolling geometry math in
 * every test. */
function totalXExtentForColor(group: THREE.Group, hex: number): number {
  let total = 0;
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    if (meshColorHex(child) !== hex) continue;
    child.geometry.computeBoundingBox();
    const bbox = child.geometry.boundingBox;
    if (!bbox || !Number.isFinite(bbox.min.x)) continue;
    total += bbox.max.x - bbox.min.x;
  }
  return total;
}

describe('RoadRenderer multi-band partial progress (Task 36)', () => {
  it('renders up to 5 bands along arclength when multiple fronts are concurrently in-flight', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, stubSampler);
    const scene = new THREE.Scene();
    const hf = new Heightfield('bands-test-seed');
    const renderer = new RoadRenderer(scene, graph, bus, hf);

    const LEN = 200;
    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: LEN, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    expect(edge.length).toBeCloseTo(LEN, 0);

    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;
    expect(group).toBeTruthy();

    // Simulate a train mid-flight: graded has completed (edge.stage advances), gravel/paved fronts
    // are both genuinely in-flight at distinct arclengths (respecting the 30u spacing rule),
    // painted hasn't started. This is exactly the event shape queue.ts's updateTrain emits — real
    // BuildQueue jobs set `edge.stage` directly BEFORE emitting `construction:stage` (see
    // `updateTrain`/`updateCrew` in queue.ts), so this synthetic test mirrors that ordering too
    // rather than relying on the (read-only, from RoadRenderer's side) stage event alone.
    edge.stage = 'graded';
    bus.emit('construction:stage', { edgeId, stage: 'graded', crew: 0 });
    bus.emit('construction:progress', {
      edgeId, stage: 'gravel', t: 90,
      pos: { x: 90, y: 1, z: 0 }, heading: 0, vehicle: 'truck', demolish: false, crew: 0, onBreak: false,
    });
    bus.emit('construction:progress', {
      edgeId, stage: 'paved', t: 40,
      pos: { x: 40, y: 1, z: 0 }, heading: 0, vehicle: 'paver', demolish: false, crew: 0, onBreak: false,
    });
    renderer.update(0.2); // flush the 0.15s rebuild throttle

    const pavedHex = colorToHex(STAGE_COLOR.paved); // gravel and paved/painted share ribbon colors
    const gravelHex = colorToHex(STAGE_COLOR.gravel);
    const gradedHex = colorToHex(STAGE_COLOR.graded);

    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(meshes.length).toBeGreaterThan(0);
    const colorsPresent = new Set(meshes.map(meshColorHex));

    // Band 2 (paved, [0,40]) and band 3 (gravel, [40,90]) must both be present as distinct ribbon
    // colors; band 4 (graded, [90,200]) uses the graded color for the remainder since the graded
    // front itself has already completed (edge.stage === 'graded', so frontT('graded') === length,
    // collapsing the graded band to fill everything past the gravel front).
    expect(colorsPresent.has(pavedHex)).toBe(true);
    expect(colorsPresent.has(gravelHex)).toBe(true);
    expect(colorsPresent.has(gradedHex)).toBe(true);

    // Sanity on extents: the paved band should span roughly [0,40] (~40u) and the gravel band
    // roughly [40,90] (~50u) — generous tolerance since the paved band internally also splits at
    // the roller's trailing color (still the same STAGE_COLOR.paved hex for the "fresh" half).
    const gravelExtent = totalXExtentForColor(group, gravelHex);
    expect(gravelExtent).toBeGreaterThan(30);
    expect(gravelExtent).toBeLessThan(70);
  });

  it('a fully-idle edge (no live front) still renders uniformly at its persisted edge.stage — single-front behavior unchanged', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, stubSampler);
    const scene = new THREE.Scene();
    const hf = new Heightfield('bands-test-seed-2');
    const renderer = new RoadRenderer(scene, graph, bus, hf);

    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    const edge = graph.edges.get(edgeId)!;
    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;

    // Real BuildQueue jobs set `edge.stage` directly before emitting each `construction:stage`
    // event (see queue.ts) — mirror that ordering here too (see the sibling test above).
    for (const stage of ['graded', 'gravel', 'paved', 'painted'] as const) {
      edge.stage = stage;
      bus.emit('construction:stage', { edgeId, stage, crew: 0 });
    }
    renderer.update(0.2);

    const paintedHex = colorToHex(STAGE_COLOR.painted);
    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    // Every full-width ribbon mesh should be the painted color (plus the centerline dash mesh,
    // which uses its own distinct color) — no stray gravel/graded/paved-colored remnants once
    // every stage event has landed and no live progress is pending.
    const ribbonHexes = new Set(meshes.map(meshColorHex));
    expect(ribbonHexes.has(paintedHex)).toBe(true);
    expect(ribbonHexes.has(colorToHex(STAGE_COLOR.graded))).toBe(false);
    expect(ribbonHexes.has(colorToHex(STAGE_COLOR.gravel))).toBe(false);
  });

  it('the survey pass still renders as a single discrete boundary (unaffected by the multi-band train split)', () => {
    const bus = new EventBus();
    const graph = new RoadGraph(bus, stubSampler);
    const scene = new THREE.Scene();
    const hf = new Heightfield('bands-test-seed-3');
    const renderer = new RoadRenderer(scene, graph, bus, hf);

    const [edgeId] = graph.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;

    bus.emit('construction:progress', {
      edgeId, stage: 'surveyed', t: 20,
      pos: { x: 20, y: 1, z: 0 }, heading: 0, vehicle: 'surveyor', demolish: false, crew: 0, onBreak: false,
    });
    renderer.update(0.2);

    // Only survey-dash geometry should exist — no buildable-stage ribbon at all yet.
    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(meshes.length).toBeGreaterThan(0);
    const gradedHex = colorToHex(STAGE_COLOR.graded);
    expect(meshes.some((m) => meshColorHex(m) === gradedHex)).toBe(false);
  });
});
