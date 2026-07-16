import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RoadRenderer, STAGE_COLOR } from '../src/render/roadRenderer';
import { ConstructionRenderer } from '../src/render/constructionRenderer';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { GrowthSim } from '../src/sim/growth/growth';
import { QuarrySim } from '../src/sim/quarry';
import { EventBus } from '../src/core/events';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { createRng } from '../src/core/rng';
import { DEFAULT_WEATHER_SAVE } from '../src/core/weather';
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

// Same shape as stubSampler, but flags a contiguous middle run of samples as `bridge: true` so
// `findBridgeRuns`/`buildBridgeParts` plant pylons along it — used to exercise the restored-bridge
// pylon-seeding regression (see roadRenderer.ts's `onStage`).
const bridgeStubSampler = (ctrl: P2[]): RoadSample[] => {
  const out = stubSampler(ctrl);
  const lo = Math.floor(out.length * 0.25);
  const hi = Math.floor(out.length * 0.75);
  for (let i = lo; i < hi; i++) out[i] = { ...out[i], bridge: true };
  return out;
};

function meshColorHex(mesh: THREE.Mesh): number {
  return (mesh.material as THREE.MeshStandardMaterial).color.getHex();
}

function colorToHex(cssHex: string): number {
  return new THREE.Color(cssHex).getHex();
}

function buildWorld(seed: string, sampler: (ctrl: P2[]) => RoadSample[] = stubSampler) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, sampler);
  const scene = new THREE.Scene();
  const renderer = new RoadRenderer(scene, graph, bus, hf);
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  const quarry = new QuarrySim(hf, graph, bus, 'quarry-' + seed);
  return { bus, hf, graph, scene, renderer, growth, quarry };
}

describe('restoreWorld render sync', () => {
  it('restored painted edges render as painted, not survey dashes', () => {
    const surveyedHex = colorToHex(STAGE_COLOR.surveyed);
    const paintedHex = colorToHex(STAGE_COLOR.painted);

    // Build a source world, paint an edge fully, and serialize it.
    const w1 = buildWorld('restore-render-test');
    const [edgeId] = w1.graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
    w1.graph.edges.get(edgeId)!.stage = 'painted';
    const json = serialize({ seed: 'restore-render-test', timeOfDay: 0.5, graph: w1.graph, growth: w1.growth, quarry: w1.quarry, weather: DEFAULT_WEATHER_SAVE });
    const save = deserialize(json)!;

    // Fresh world + fresh scene + fresh RoadRenderer, then restore into it.
    const w2 = buildWorld('restore-render-test');
    restoreWorld(save, { bus: w2.bus, hf: w2.hf, graph: w2.graph, growth: w2.growth, quarry: w2.quarry });

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

  it('restored bridge edges render pylons fully risen, not zero-scale', () => {
    // Build a source world with a bridge run in the middle of the edge, paint it fully (well past
    // 'graded', so pylons should be fully risen by the time it's saved), and serialize it.
    const w1 = buildWorld('restore-bridge-test', bridgeStubSampler);
    const [edgeId] = w1.graph.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    w1.graph.edges.get(edgeId)!.stage = 'painted';
    const json = serialize({ seed: 'restore-bridge-test', timeOfDay: 0.5, graph: w1.graph, growth: w1.growth, quarry: w1.quarry, weather: DEFAULT_WEATHER_SAVE });
    const save = deserialize(json)!;

    // Fresh world + fresh scene + fresh RoadRenderer, then restore into it. This is the path where
    // `ensureVisual` first runs from `roads:edgeAdded` inside `commitChain`, with `edge.stage` still
    // 'surveyed' — the bug this test guards against.
    const w2 = buildWorld('restore-bridge-test', bridgeStubSampler);
    restoreWorld(save, { bus: w2.bus, hf: w2.hf, graph: w2.graph, growth: w2.growth, quarry: w2.quarry });

    const restoredEdgeId = [...w2.graph.edges.keys()][0];
    const group = w2.scene.children.find((c) => c.userData.edgeId === restoredEdgeId) as THREE.Group;
    expect(group).toBeTruthy();

    const pylonMeshes = group.children.filter(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry instanceof THREE.CylinderGeometry,
    );

    // The bridge run must have produced at least one pylon...
    expect(pylonMeshes.length).toBeGreaterThan(0);
    // ...and every pylon must be rendered at full rise (scale.y ~= 1), not stuck at the
    // zero-height fallback (`Math.max(0.001, riseU)` with `riseU` never advancing past 0).
    for (const mesh of pylonMeshes) {
      expect(mesh.scale.y).toBeCloseTo(1, 2);
    }
  });

  // Critical 1 (Groundwork round fix wave): restoring a v2/v3 save with an already-placed quarry
  // used to leave `ConstructionRenderer`'s quarry prop invisible and shuttle trucks routing toward
  // the map edge instead of the landmark, because `restoreWorld` fed the placement into `QuarrySim`
  // via `quarry.restore()` (no event) and `ConstructionRenderer` is always constructed BEFORE
  // `restoreWorld` runs (see main.ts) — so its constructor-time `quarry?.placement` check saw `null`
  // and it never got a `quarry:placed` event either. Only a save that predated the quarry feature
  // (v1 migration) happened to work, because THAT path (restoreWorld's separate "compute fresh"
  // branch) does emit. This test builds the renderer BEFORE calling restoreWorld — mirroring
  // main.ts's real construction order — and asserts the prop is actually visible/positioned after
  // restore, plus that the shuttle-facing `quarryPosition` getter is populated.
  it('restored quarry renders its prop and is visible to shuttle routing, even though the renderer predates restoreWorld', () => {
    const w1 = buildWorld('restore-quarry-test');
    const anchor = { x: 0, z: 0 };
    w1.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
    expect(w1.quarry.placement).not.toBeNull();
    const placement = w1.quarry.placement!;
    const json = serialize({ seed: 'restore-quarry-test', timeOfDay: 0.5, graph: w1.graph, growth: w1.growth, quarry: w1.quarry, weather: DEFAULT_WEATHER_SAVE });
    const save = deserialize(json)!;

    // Fresh world, and — matching main.ts's real boot order — construct the renderer BEFORE
    // restoreWorld runs, so it can only learn of the restored quarry via the event path.
    const w2 = buildWorld('restore-quarry-test');
    const constructionRenderer = new ConstructionRenderer(w2.scene, w2.bus, w2.graph, w2.hf, w2.renderer, w2.quarry);

    restoreWorld(save, { bus: w2.bus, hf: w2.hf, graph: w2.graph, growth: w2.growth, quarry: w2.quarry });

    expect(w2.quarry.placement).toEqual(placement);
    expect(constructionRenderer.quarryPosition).toEqual({ x: placement.x, z: placement.z });
  });
});
