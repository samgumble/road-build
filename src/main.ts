import { EventBus } from './core/events';
import { Loop } from './core/loop';
import { createRng } from './core/rng';
import { Heightfield } from './sim/terrain/heightfield';
import { createScene } from './render/scene';
import { TerrainRenderer } from './render/terrainRenderer';
import { RoadRenderer } from './render/roadRenderer';
import { CameraRig } from './input/cameraRig';
import { DrawTool } from './input/drawTool';
import { RoadGraph } from './sim/roads/graph';
import { makeSampler } from './sim/roads/path';
import { BuildQueue } from './sim/construction/queue';
import { ConstructionRenderer } from './render/constructionRenderer';
import { TrafficSim } from './sim/traffic/traffic';
import { CarRenderer } from './render/carRenderer';
import { GrowthSim } from './sim/growth/growth';
import { SceneryRenderer } from './render/sceneryRenderer';
import { Atmosphere } from './render/atmosphere';

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

  const { renderer, scene, camera, sun, hemi } = rig;

  const bus = new EventBus();
  const hf = new Heightfield('terra-1', bus);
  const terrain = new TerrainRenderer(scene, hf, bus);

  const graph = new RoadGraph(bus, makeSampler(hf));
  const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
  const buildQueue = new BuildQueue(graph, hf, bus);
  const constructionRenderer = new ConstructionRenderer(scene, bus, graph);

  const traffic = new TrafficSim(graph, bus, createRng('traffic-' + hf.seed));
  traffic.targetPopulation = 6; // Task 13 scales this with houses: 6 + houses, capped at 80
  const carRenderer = new CarRenderer(scene);

  const growth = new GrowthSim(graph, hf, bus, createRng('growth-' + hf.seed));
  const sceneryRenderer = new SceneryRenderer(scene, hf, bus);

  const cameraRig = new CameraRig(camera, canvas);

  const atmosphere = new Atmosphere(scene, sun, hemi, renderer, bus, createRng('atmosphere-' + hf.seed));
  atmosphere.setCameraTarget(cameraRig.target);

  // Draw tool owns LMB (survey preview + stakes + commit, demolish-click); exposed here so a
  // later HUD task (Task 15) can flip `drawTool.mode` between 'draw' / 'demolish' / 'none'.
  const drawTool = new DrawTool(canvas, camera, terrain.mesh, graph, hf, scene, (edgeId) =>
    buildQueue.enqueueDemolish(edgeId),
  );
  (window as unknown as { __drawTool: DrawTool }).__drawTool = drawTool;

  let lastFrameTime = performance.now();
  let populationTimer = 0;

  const loop = new Loop(
    (dt) => {
      buildQueue.update(dt);
      traffic.update(dt);
      growth.update(dt);

      populationTimer += dt;
      if (populationTimer >= 1) {
        populationTimer -= 1;
        traffic.targetPopulation = Math.min(80, 6 + growth.houseCount);
      }
    },
    () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.25);
      lastFrameTime = now;
      cameraRig.update(dt);
      roadRenderer.update(dt);
      drawTool.update(dt);
      atmosphere.update(dt);
      constructionRenderer.update(dt, atmosphere.night);
      carRenderer.update(traffic.cars, atmosphere.night);
      sceneryRenderer.update(dt);
      renderer.render(scene, camera);
    },
  );
  loop.start();
}

main();
