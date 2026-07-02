import { EventBus } from './core/events';
import { Loop } from './core/loop';
import { Heightfield } from './sim/terrain/heightfield';
import { createScene } from './render/scene';
import { TerrainRenderer } from './render/terrainRenderer';
import { RoadRenderer } from './render/roadRenderer';
import { CameraRig } from './input/cameraRig';
import { RoadGraph } from './sim/roads/graph';
import { makeSampler } from './sim/roads/path';
import type { Stage } from './core/types';

function showNoGl(): void {
  const app = document.getElementById('app');
  const nogl = document.getElementById('nogl');
  if (app) app.style.display = 'none';
  if (nogl) nogl.style.display = 'grid';
}

function hasWebGl(canvas: HTMLCanvasElement): boolean {
  try {
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function main(): void {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null;
  if (!canvas) return;

  if (!hasWebGl(canvas)) {
    showNoGl();
    return;
  }

  let rig: ReturnType<typeof createScene>;
  try {
    rig = createScene(canvas);
  } catch {
    showNoGl();
    return;
  }

  const { renderer, scene, camera } = rig;

  const bus = new EventBus();
  const hf = new Heightfield('terra-1', bus);
  const terrain = new TerrainRenderer(scene, hf, bus);
  void terrain;

  const graph = new RoadGraph(bus, makeSampler(hf));
  const roadRenderer = new RoadRenderer(scene, graph, bus, hf);

  const cameraRig = new CameraRig(camera, canvas);

  // --- temporary debug hooks (Task 7 visual verification; remove once construction sim + UI land) ---
  (window as unknown as { __debugRoad: (pts: [number, number][]) => number[] }).__debugRoad =
    (pts) => graph.commitChain(pts.map(([x, z]) => ({ x, z })));

  (window as unknown as { __debugStage: (edgeId: number, stage: Stage) => void }).__debugStage =
    (edgeId, stage) => {
      const edge = graph.edges.get(edgeId);
      if (!edge) return;
      edge.stage = stage;
      bus.emit('construction:stage', { edgeId, stage });
    };
  // --- end temporary debug hooks ---

  let lastFrameTime = performance.now();

  const loop = new Loop(
    () => {
      // sim update — no gameplay systems yet
    },
    () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.25);
      lastFrameTime = now;
      cameraRig.update(dt);
      roadRenderer.update(dt);
      renderer.render(scene, camera);
    },
  );
  loop.start();
}

main();
