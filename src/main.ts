import { EventBus } from './core/events';
import { Loop } from './core/loop';
import { createRng } from './core/rng';
import { Heightfield } from './sim/terrain/heightfield';
import { createScene } from './render/scene';
import { TerrainRenderer } from './render/terrainRenderer';
import { RoadRenderer } from './render/roadRenderer';
import { RoadsideRenderer } from './render/roadsideRenderer';
import { CameraRig } from './input/cameraRig';
import { DrawTool } from './input/drawTool';
import { RoadGraph } from './sim/roads/graph';
import { makeSampler } from './sim/roads/path';
import { BuildQueue } from './sim/construction/queue';
import { ConstructionRenderer } from './render/constructionRenderer';
import { TrafficSim } from './sim/traffic/traffic';
import { CarRenderer } from './render/carRenderer';
import { GrowthSim } from './sim/growth/growth';
import { generateWilderness, WildernessSim } from './sim/growth/wilderness';
import { QuarrySim } from './sim/quarry';
import { SceneryRenderer } from './render/sceneryRenderer';
import { Atmosphere } from './render/atmosphere';
import { Hud, randomSeed } from './ui/hud';
import { StartScreen } from './ui/startScreen';
import { serialize, deserialize, restoreWorld } from './sim/save';
import { AmbientAudio } from './audio/ambient';
import { QUALITY } from './render/quality';
import { createPostFx } from './render/postfx';

// Important 3: saves used to live under one shared key (`groundwork-save`), so visiting with a
// different `?seed=` would silently ignore that seed's own progress (deserialize's seed mismatch
// check just fell back to a fresh world) and then the 10s autosave interval would overwrite the
// previous seed's save entirely. Each seed now gets its own save slot, and a small separate key
// tracks which seed was last played so a plain visit (no `?seed=` in the URL) resumes it.
const LEGACY_SAVE_KEY = 'groundwork-save';
const LAST_SEED_KEY = 'groundwork-last-seed';
const AUTOSAVE_INTERVAL = 10; // seconds

function saveKeyFor(seed: string): string {
  return `groundwork-save:${seed}`;
}

/**
 * One-time migration: if the old shared-key save exists, move it into its own seed's slot (read
 * from the save JSON itself, not from any current URL/last-seed state, since this predates the
 * per-seed scheme entirely) and record that seed as last-played. Removes the legacy key either
 * way so this only ever runs once. No-ops quietly on any storage/parse failure.
 */
function migrateLegacySave(): void {
  try {
    const raw = window.localStorage.getItem(LEGACY_SAVE_KEY);
    if (raw === null) return;
    const save = deserialize(raw);
    if (save) {
      window.localStorage.setItem(saveKeyFor(save.seed), raw);
      window.localStorage.setItem(LAST_SEED_KEY, save.seed);
    }
    window.localStorage.removeItem(LEGACY_SAVE_KEY);
  } catch {
    // localStorage unavailable/corrupt — nothing to migrate.
  }
}

function resolveSeed(): { seed: string; fromUrl: boolean } {
  const params = new URLSearchParams(window.location.search);
  const urlSeed = params.get('seed');
  if (urlSeed) return { seed: urlSeed, fromUrl: true };

  try {
    const lastSeed = window.localStorage.getItem(LAST_SEED_KEY);
    if (lastSeed) return { seed: lastSeed, fromUrl: false };
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

  const { renderer, scene, camera, sun, hemi, onResize } = rig;

  // Task 28: high tier runs an EffectComposer (bloom + vignette + OutputPass); low tier renders
  // directly, same as before this task. `renderFrame` below is the single source of truth both
  // the main loop and the HUD's on-demand redraw use, so the two paths can never drift apart.
  const postFx = QUALITY === 'high' ? createPostFx(renderer, scene, camera) : null;
  const renderFrame = () => (postFx ? postFx.render() : renderer.render(scene, camera));
  onResize(() => postFx?.setSize(window.innerWidth, window.innerHeight));

  migrateLegacySave();
  const { seed } = resolveSeed();
  try {
    window.localStorage.setItem(LAST_SEED_KEY, seed);
  } catch {
    // ignore — worst case a plain revisit falls back to a fresh random seed instead of resuming
  }

  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const terrain = new TerrainRenderer(scene, hf, bus);

  const graph = new RoadGraph(bus, makeSampler(hf));
  const roadRenderer = new RoadRenderer(scene, graph, bus, hf);
  const buildQueue = new BuildQueue(graph, hf, bus);
  // Task 34: quarry landmark — placed deterministically on the FIRST road commit ever. Constructed
  // before any `restoreWorld` call below (same reasoning as WildernessSim just below) so a restored
  // save's replayed first edge either seeds an already-known placement via `restoreWorld`'s
  // `quarry.restore()` call, or (a save predating this feature) computes one fresh from the
  // restored graph.
  const quarry = new QuarrySim(hf, graph, bus, 'quarry-' + hf.seed);
  const constructionRenderer = new ConstructionRenderer(scene, bus, graph, hf, roadRenderer, quarry);

  const traffic = new TrafficSim(graph, bus, createRng('traffic-' + hf.seed));
  traffic.targetPopulation = 6; // Task 13 scales this with houses: 6 + houses, capped at 80
  const carRenderer = new CarRenderer(scene);

  const morphologySeed = createRng('growth-morphology-' + hf.seed)();
  const growth = new GrowthSim(graph, hf, bus, createRng('growth-' + hf.seed), morphologySeed);
  const sceneryRenderer = new SceneryRenderer(scene, hf, bus);
  const roadsideRenderer = new RoadsideRenderer(scene, graph, hf, bus);

  // Task 31: ambient wilderness — sparse seeded trees scattered across the island, generated
  // deterministically from the same seed as the Heightfield. Unlike GrowthSim's road-driven
  // spawns, this is derived worldgen state: NOT part of the save file (see save.ts's doc comment
  // on SaveV1), regenerated identically every boot. WildernessSim is constructed here (before any
  // `restoreWorld` call below) so that if a save exists, restoreWorld's replayed
  // `construction:stage` events for already-graded+ edges are seen by this sim too, re-deriving
  // the correct cleared set purely from the restored road graph rather than needing its own save
  // slot.
  const wildernessSites = generateWilderness(hf, 'wilderness-' + hf.seed);
  const wildernessSim = new WildernessSim(wildernessSites, bus, graph);

  const cameraRig = new CameraRig(camera, canvas);

  const atmosphere = new Atmosphere(scene, sun, hemi, renderer, bus, createRng('atmosphere-' + hf.seed));
  atmosphere.setCameraTarget(cameraRig.target);

  const audio = new AmbientAudio(bus);
  // Autoplay policy: the AudioContext can only be created from a user gesture, so we build it
  // lazily on the first qualifying gesture and never again (`start()` no-ops on repeat calls).
  // Task 29 (iOS quirk): pointerdown alone doesn't reliably count as a user-activation gesture on
  // iOS Safari in every version/context, and touch input's pointerdown-then-pointerup sequence
  // means touchend is a safe second trigger to also listen for — both are {once:true} and
  // AmbientAudio.start() is itself idempotent, so whichever fires first wins and the other is inert.
  canvas.addEventListener('pointerdown', () => audio.start(), { once: true });
  canvas.addEventListener('touchend', () => audio.start(), { once: true });

  // Draw tool owns LMB (survey preview + stakes + commit, demolish-click); `drawTool.mode` is
  // flipped between 'draw' / 'demolish' / 'none' by the HUD toolbar below.
  const drawTool = new DrawTool(canvas, camera, terrain.mesh, graph, hf, scene, (edgeId) =>
    buildQueue.enqueueDemolish(edgeId),
  );

  // Task 29 (mobile): the instant a second finger lands, CameraRig starts a two-finger gesture and
  // DrawTool must cede cleanly — cancel any in-progress single-finger draw chain via the same path
  // pointercancel already uses, rather than letting the second touch corrupt the chain.
  cameraRig.onTwoFingerStart = () => drawTool.cancelActiveDrag();

  let lastFrameTime = performance.now();
  let populationTimer = 0;

  const loop = new Loop(
    (dt) => {
      // Task 33: night slowdown reads Atmosphere's `night` flag (render-side state) but the sim
      // itself stays a pure function of its inputs — same dt/night sequence always yields the
      // same result, exactly like traffic's timeOfDay input just below.
      buildQueue.update(dt, atmosphere.night);
      // Task 32: commute pulse reads Atmosphere's timeOfDay (render-side state) but the sim itself
      // stays a pure function of its inputs — same dt/timeOfDay sequence always yields the same
      // result.
      traffic.update(dt, atmosphere.timeOfDay);
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
      roadRenderer.update(dt, atmosphere.rainAmount);
      drawTool.update(dt);
      // Important 10: the day/night cycle is meant to accelerate with the HUD's speed control
      // (1x/4x/16x, via `loop.timeScale`) the same way the fixed-step sim does — Atmosphere's own
      // doc comment already (incorrectly) claimed timeScale was "baked in" to its dt, but this
      // render callback computes `dt` straight from wall-clock time with no timeScale applied at
      // all, so the day cycle previously ran at real-world speed regardless of the selected speed.
      atmosphere.update(dt * loop.timeScale);
      // Task 46 (Groundwork stutter fix): ConstructionRenderer's vehicle position/heading damping
      // needs to know how much SIM time this rendered frame actually covered (see
      // ConstructionRenderer.update's `timeScale` param doc) — but its many wall-clock-calibrated
      // liveness windows (IDLE_TIMEOUT, break theater, etc., all keyed off `this.clock`) must stay
      // real-time, so (unlike sceneryRenderer/carRenderer/atmosphere just below/above) `dt` itself
      // is NOT scaled here; timeScale is passed through as a separate argument instead.
      constructionRenderer.update(dt, atmosphere.night, loop.timeScale);
      carRenderer.update(traffic.cars, atmosphere.night, dt * loop.timeScale);
      // Important 5 (Groundwork round fix wave): SceneryRenderer's fade/recover/pop-in animations
      // (growth:stranded's decay fade, growth:rescued's recovery ease, wilderness:cleared's fade)
      // must advance on SIM time, not wall-clock time — the sim events that start/stop them
      // (growth:remove in particular) fire on `loop`'s fixed-step sim time, which itself already
      // runs at `loop.timeScale`x speed (see Loop's fixed-step accumulator). Passing raw `dt` here
      // (previously unscaled, unlike atmosphere/carRenderer just above) meant the sim's own removal
      // could arrive up to 16x faster than this renderer's local fade timer at the fastest speed
      // setting, popping buildings out instantly at ~1.5% through their local fade rather than
      // smoothly finishing together.
      sceneryRenderer.update(dt * loop.timeScale);
      // Audio intentionally stays real-time: `update()` uses `dt` only for its own wall-clock
      // scheduling (bird/cricket timers, pad chord crossfades), not to advance the day cycle —
      // `timeOfDay` is read from `atmosphere.timeOfDay`, which is already correctly scaled above.
      audio.update(dt, atmosphere.timeOfDay, camera.position.x);
      // Task 38: feed Atmosphere's eased daylight signal into the water shader so lakes/ponds dim
      // at night along with the rest of the lit scene instead of glowing at a constant brightness.
      terrain.update(dt, atmosphere.daylight);
      renderFrame();
    },
  );

  // Boot-load: restore from this seed's own save slot if one exists, with a graceful fallback to
  // a fresh world on corrupt/missing data (deserialize already returns null for those). Each seed
  // has its own key, so a different seed's save is never touched.
  let restoredRoads = false;
  try {
    const raw = window.localStorage.getItem(saveKeyFor(seed));
    if (raw) {
      const save = deserialize(raw);
      if (save && save.seed === seed) {
        restoreWorld(save, { bus, hf, graph, growth, queue: buildQueue, quarry });
        // Finding 2 (Task 35 follow-up "Groundwork"): pass along any records that were mid-fade at
        // save time so `rebuild()` restores them at the correct partial-fade progress instead of
        // popping back in at full scale with a freshly-restarted fade animation.
        // Task 42: also pass along any ids `growth.restore()`'s own corridor re-scan (just run
        // inside `restoreWorld` above) started a fresh clearing fade for, so those records render
        // already mid-fade instead of popping in at full scale before abruptly vanishing.
        sceneryRenderer.rebuild(growth.spawned, growth.decayState, growth.clearingIds);
        // Important 4 (Groundwork round fix wave): seed TrafficSim's settlement-weighting
        // houses/buildings arrays from the just-restored growth records — without this, those
        // arrays only ever grew via live `growth:spawn` events, so every reload of an established
        // town reset traffic weighting back to uniform until fresh houses/buildings grew again.
        traffic.restore(growth.spawned);
        atmosphere.timeOfDay = save.timeOfDay;
        restoredRoads = save.edges.length > 0;
      }
    }
  } catch {
    // Corrupt localStorage entry or storage unavailable — proceed with the freshly generated world.
  }

  // Task 31: place wilderness AFTER any restore above — `sceneryRenderer.rebuild()` (restore path)
  // zeroes every tree/house/building InstancedMesh's count and re-places only the saved growth
  // records, so placing wilderness any earlier would just get wiped out by that reset. Using
  // `wildernessSim.activeWithIndex` (rather than the raw `wildernessSites`, or the plain, compacted
  // `active`) means a restored world's already-cleared corridor trees never render as
  // placed-then-immediately-faded (they're simply never placed, matching a fresh boot exactly)
  // while ALSO keeping the renderer's site tracking keyed by original index — Critical 2 (Groundwork
  // round fix wave): `active`'s compacted array silently misindexed any live `wilderness:cleared`
  // that arrived after a restore had already pre-cleared >= 1 site.
  sceneryRenderer.setWilderness(wildernessSim.activeWithIndex);
  // Seed settlement-aware utility poles after restore (live growth events keep this current).
  roadsideRenderer.setSettlements(growth.spawned);

  const navigateToSeed = (newSeed: string) => {
    // Each seed owns its own save slot (starting empty for a seed that's never been visited),
    // so there's nothing to clear here — just navigate. `main()`'s boot sequence on the new
    // page load resolves the seed from the URL and records it as last-played.
    const url = new URL(window.location.href);
    url.searchParams.set('seed', newSeed);
    window.location.search = url.searchParams.toString();
  };

  const hud = new Hud({
    bus,
    drawTool,
    loop,
    seed,
    renderFrame,
    canvas,
    audio,
    getSiteOverview: () => ({
      roads: graph.edges.size,
      scheduledJobs: buildQueue.queueLength,
      activeCrews: buildQueue.activeCrewCount,
      cars: traffic.cars.length,
      homes: growth.houseCount,
      buildings: growth.spawned.filter((record) => record.kind === 'building').length,
      paused: loop.isPaused,
      growthPaused: growth.isDevelopmentPaused,
    }),
    getEdgeLength: (edgeId) => graph.edges.get(edgeId)?.length ?? 0,
    getGrowthPaused: () => growth.isDevelopmentPaused,
    setGrowthPaused: (paused) => growth.setDevelopmentPaused(paused),
    onNewWorld: navigateToSeed,
    // Undo-last-survey: withdraw each edge the last commit created. enqueueDemolish already does
    // the right thing per edge state — a still-'surveyed' pending edge instant-removes, and one a
    // crew has started on converts to a demolition walk-back. Filter ids the player already
    // demolished by hand during the window so we never queue a demolish for a missing edge.
    onUndoSurvey: (edgeIds) => {
      for (const edgeId of edgeIds) {
        if (graph.edges.has(edgeId)) buildQueue.enqueueDemolish(edgeId);
      }
    },
  });
  hud.suppressHintIfRoadsExist(restoredRoads);
  // Chain-rejection feedback: the DrawTool already fades an invalid preview; this pairs the fade
  // with a short notice saying WHY (too short / off-island / water endpoint) through the same
  // channel milestone notices use.
  drawTool.onRejected = (reason) => hud.showNotice(reason);
  // Undo window: every successful commit (re-)opens the HUD's transient UNDO SURVEY chip.
  drawTool.onCommitted = (edgeIds) => hud.openUndoWindow(edgeIds);

  // The title screen owns keyboard/focus while it is visible and keeps the fixed-step sim frozen;
  // the render loop still paints behind it, so dismissal crossfades directly into a fully-ready
  // world with no loading flash. Its primary user gesture also unlocks Web Audio (canvas-only
  // gesture listeners above cannot see a click on this DOM overlay).
  let startScreenOpen = true;
  loop.setPaused(true);
  new StartScreen({
    seed,
    hasRoads: restoredRoads,
    inertRoot: document.getElementById('hud')!,
    onContinue: () => {
      startScreenOpen = false;
      audio.start();
      loop.setPaused(false);
      hud.syncControls();
    },
    onNewWorld: () => navigateToSeed(randomSeed()),
  });
  document.addEventListener('keydown', (event) => {
    if (!startScreenOpen) hud.handleKeyboardShortcut(event);
  });

  const save = () => {
    try {
      const json = serialize({ seed, timeOfDay: atmosphere.timeOfDay, graph, growth, quarry });
      window.localStorage.setItem(saveKeyFor(seed), json);
    } catch {
      // localStorage unavailable/full — autosave silently no-ops rather than crashing the game
    }
  };

  window.setInterval(save, AUTOSAVE_INTERVAL * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  // Task 47 item 2 ("combined easement x grading load"): bracket each rendered frame's WHOLE batch
  // of fixed sim-steps (up to ~128 at 16x HUD speed) so `Heightfield`'s per-`flattenCircle`
  // easement replay (Task 43) is deferred and deduped once per batch rather than once per
  // grading tick — see task-47-report.md for the measured perf numbers this fixes. Sim-deterministic
  // (the replay's result is order-independent — see `Heightfield`'s doc comment on
  // `beginDeformBatch`), so this only changes WHEN the replay happens, never the sim's own
  // step-by-step outcome.
  loop.onBatchStart = () => hf.beginDeformBatch();
  loop.onBatchEnd = () => hf.endDeformBatch();

  loop.start();
}

main();
