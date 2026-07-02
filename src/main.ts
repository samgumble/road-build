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
import { Hud, randomSeed } from './ui/hud';
import { serialize, deserialize, restoreWorld } from './sim/save';

const SAVE_KEY = 'groundwork-save';
const AUTOSAVE_INTERVAL = 10; // seconds

function resolveSeed(): { seed: string; fromUrl: boolean } {
  const params = new URLSearchParams(window.location.search);
  const urlSeed = params.get('seed');
  if (urlSeed) return { seed: urlSeed, fromUrl: true };

  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (raw) {
      const save = deserialize(raw);
      if (save) return { seed: save.seed, fromUrl: false };
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through to a fresh random seed
  }

  return { seed: randomSeed(), fromUrl: false };
}

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

  const { seed } = resolveSeed();

  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
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

  // Draw tool owns LMB (survey preview + stakes + commit, demolish-click); `drawTool.mode` is
  // flipped between 'draw' / 'demolish' / 'none' by the HUD toolbar below.
  const drawTool = new DrawTool(canvas, camera, terrain.mesh, graph, hf, scene, (edgeId) =>
    buildQueue.enqueueDemolish(edgeId),
  );

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

  // Boot-load: restore from a same-seed save if one exists, with a graceful fallback to a fresh
  // world on corrupt/missing/mismatched-seed data (deserialize already returns null for those).
  let restoredRoads = false;
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (raw) {
      const save = deserialize(raw);
      if (save && save.seed === seed) {
        restoreWorld(save, { bus, hf, graph, growth, queue: buildQueue });
        sceneryRenderer.rebuild(growth.spawned);
        atmosphere.timeOfDay = save.timeOfDay;
        restoredRoads = save.edges.length > 0;
      }
    }
  } catch {
    // Corrupt localStorage entry or storage unavailable — proceed with the freshly generated world.
  }

  const hud = new Hud({
    bus,
    drawTool,
    loop,
    seed,
    renderFrame: () => renderer.render(scene, camera),
    canvas,
    onNewWorld: (newSeed) => {
      try {
        window.localStorage.removeItem(SAVE_KEY);
      } catch {
        // ignore
      }
      const url = new URL(window.location.href);
      url.searchParams.set('seed', newSeed);
      window.location.search = url.searchParams.toString();
    },
  });
  hud.suppressHintIfRoadsExist(restoredRoads);

  const save = () => {
    try {
      const json = serialize({ seed, timeOfDay: atmosphere.timeOfDay, graph, growth });
      window.localStorage.setItem(SAVE_KEY, json);
    } catch {
      // localStorage unavailable/full — autosave silently no-ops rather than crashing the game
    }
  };

  window.setInterval(save, AUTOSAVE_INTERVAL * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  loop.start();
}

main();
