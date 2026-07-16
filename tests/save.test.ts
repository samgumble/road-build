import { describe, it, expect } from 'vitest';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { GrowthSim } from '../src/sim/growth/growth';
import { BuildQueue } from '../src/sim/construction/queue';
import { QuarrySim } from '../src/sim/quarry';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import { DEFAULT_WEATHER_SAVE } from '../src/core/weather';
import { WeatherController } from '../src/render/weather';

function freshWorld(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  const queue = new BuildQueue(graph, hf, bus);
  const quarry = new QuarrySim(hf, graph, bus, 'quarry-' + seed);
  return { bus, hf, graph, growth, queue, quarry };
}

function findAnchor(hf: Heightfield, length: number): { x: number; z: number } {
  for (let x = -160; x <= 160; x += 8) {
    for (let z = -160; z <= 160; z += 8) {
      if (hf.isLand(x, z) && hf.isLand(x + length, z)) return { x, z };
    }
  }
  throw new Error('no land anchor found');
}

describe('save/load', () => {
  it('round-trips edges, stages, and timeOfDay', () => {
    const w = freshWorld('save-test');
    const anchor = findAnchor(w.hf, 32);
    const [id] = w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
    w.graph.edges.get(id)!.stage = 'painted';
    const json = serialize({ seed: 'save-test', timeOfDay: 0.7, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
    const save = deserialize(json)!;
    expect(save.version).toBe(4);
    expect(save.junctionControls).toEqual([]);
    expect(save.weather).toEqual(DEFAULT_WEATHER_SAVE);
    const w2 = freshWorld('save-test');
    restoreWorld(save, w2);
    expect(w2.graph.edges.size).toBe(1);
    expect([...w2.graph.edges.values()][0].stage).toBe('painted');
    expect(save.timeOfDay).toBeCloseTo(0.7);
  });
  it('returns null for garbage or wrong version', () => {
    expect(deserialize('not json')).toBeNull();
    expect(deserialize(JSON.stringify({ version: 99 }))).toBeNull();
  });
  it('migrates a v3 save to deterministic clear weather', () => {
    const migrated = deserialize(JSON.stringify({
      version: 3,
      seed: 'weather-v3-migration',
      timeOfDay: 0.35,
      edges: [],
      growth: { dev: [], spawned: [], decay: [] },
      quarry: null,
    }))!;

    expect(migrated.version).toBe(4);
    expect(migrated.junctionControls).toEqual([]);
    expect(migrated.weather).toEqual(DEFAULT_WEATHER_SAVE);
  });
  it('serializes the live controller state rather than the clear migration default', () => {
    const weather = new WeatherController('save-live-weather', {
      current: 'heavy-rain',
      next: 'light-rain',
      transition: 0.25,
      remaining: 41,
      transitionIndex: 8,
    });
    const world = freshWorld('save-live-weather');
    const junctionControls = [{
      x: 8,
      z: -16,
      mode: 'signal' as const,
      maturitySeconds: 120,
      passageEmaPerMinute: 3.5,
    }];
    const save = deserialize(serialize({
      seed: 'save-live-weather',
      timeOfDay: 0.5,
      graph: world.graph,
      growth: world.growth,
      quarry: world.quarry,
      junctionControls,
      weather: weather.saved,
    }))!;

    expect(save.weather).toEqual(weather.saved);
    expect(save.junctionControls).toEqual(junctionControls);
  });
  it('rejects malformed native v4 weather rather than silently resetting it', () => {
    const base = {
      version: 4,
      seed: 'weather-v4-corrupt',
      timeOfDay: 0,
      edges: [],
      growth: { dev: [], spawned: [], decay: [] },
      quarry: null,
      junctionControls: [],
      weather: DEFAULT_WEATHER_SAVE,
    };

    expect(deserialize(JSON.stringify({
      ...base,
      weather: { ...DEFAULT_WEATHER_SAVE, transition: 1.1 },
    }))).toBeNull();
    expect(deserialize(JSON.stringify({
      ...base,
      weather: { ...DEFAULT_WEATHER_SAVE, current: 'hail' },
    }))).toBeNull();
    expect(deserialize(JSON.stringify({
      ...base,
      junctionControls: [{
        x: 0,
        z: 0,
        mode: 'signal',
        maturitySeconds: 301,
        passageEmaPerMinute: 2,
      }],
    }))).toBeNull();
  });
  it('returns null when an edge has an invalid stage or malformed ctrl', () => {
    const base = {
      version: 2,
      seed: 'x',
      timeOfDay: 0,
      growth: { dev: [], spawned: [] },
      quarry: null,
    };
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'bogus' }] })),
    ).toBeNull();
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: [{ x: 0 }], stage: 'graded' }] })),
    ).toBeNull();
    expect(
      deserialize(JSON.stringify({ ...base, edges: [{ ctrl: 'not-an-array', stage: 'graded' }] })),
    ).toBeNull();
  });
  it('returns null for non-finite timeOfDay or ctrl coordinates', () => {
    const base = {
      version: 2,
      seed: 'x',
      growth: { dev: [], spawned: [] },
      quarry: null,
    };
    // 1e400 overflows to Infinity once JSON.parse evaluates it as a number literal — this is how
    // a hand-edited/corrupted save file could smuggle a non-finite value through JSON, since
    // JSON.stringify on an in-memory NaN/Infinity would instead just emit `null`.
    expect(
      deserialize(JSON.stringify({ ...base, timeOfDay: 0.5, edges: [] }).replace('0.5', '1e400')),
    ).toBeNull();
    expect(
      deserialize(
        JSON.stringify({ ...base, timeOfDay: 0, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'graded' }] }).replace(
          '"x":0',
          '"x":1e400',
        ),
      ),
    ).toBeNull();
    expect(
      deserialize(
        JSON.stringify({ ...base, timeOfDay: 0, edges: [{ ctrl: [{ x: 0, z: 0 }], stage: 'graded' }] }).replace(
          '"z":0}',
          '"z":1e400}',
        ),
      ),
    ).toBeNull();
  });
  it('resumes construction of mid-stage edges after restore', () => {
    const w = freshWorld('resume-test');
    const anchor = findAnchor(w.hf, 32);
    const [id] = w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
    w.graph.edges.get(id)!.stage = 'gravel'; // simulate autosave mid-build
    const json = serialize({ seed: 'resume-test', timeOfDay: 0.5, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
    const w2 = freshWorld('resume-test');
    restoreWorld(deserialize(json)!, w2);
    const [rid] = [...w2.graph.edges.keys()];
    for (let i = 0; i < 60 * 120; i++) w2.queue.update(1 / 60);
    expect(w2.graph.edges.get(rid)!.stage).toBe('painted');
  });

  describe('quarry (Task 34)', () => {
    it('round-trips the placed quarry position through serialize/deserialize/restore', () => {
      const w = freshWorld('quarry-save-test');
      const anchor = findAnchor(w.hf, 64);
      w.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      expect(w.quarry.placement).not.toBeNull();
      const placement = w.quarry.placement;

      const json = serialize({ seed: 'quarry-save-test', timeOfDay: 0.3, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.quarry).toEqual(placement);

      const w2 = freshWorld('quarry-save-test');
      restoreWorld(save, w2);
      expect(w2.quarry.placement).toEqual(placement);
    });

    it('serializes quarry: null when no road has ever been committed', () => {
      const w = freshWorld('quarry-none-test');
      expect(w.quarry.placement).toBeNull();
      const json = serialize({ seed: 'quarry-none-test', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.quarry).toBeNull();
    });

    // Critical 1 (Groundwork round fix wave): this test previously asserted that restoring a v2/v3
    // save with an already-known quarry placement emits NO `quarry:placed` event at all. That
    // enshrined a real bug: `ConstructionRenderer` (which draws the quarry prop/pad and steers
    // shuttle trucks toward it) is constructed in main.ts BEFORE `restoreWorld` runs, and only picks
    // up an already-known placement two ways — its constructor's `quarry?.placement` check (dead by
    // definition here, since the renderer is built first) or the `quarry:placed` event. The OTHER
    // migration path (v1 save, no `quarry` field at all — see the "a v1 save... migrates forward"
    // test below) DOES emit on restore, which is why only migrated v1 saves ever actually showed the
    // quarry after reload; every v2/v3 save silently lost it. The fix: restoreWorld now emits
    // `quarry:placed` unconditionally whenever a placement exists after restore (freshly computed OR
    // fed back via `quarry.restore()`), and `placeQuarryProp` is idempotent (re-applying the same
    // placement is a harmless no-op), so re-emitting on an already-known placement is safe. See
    // restoreRender.test.ts's "restored quarry renders its prop" test for the renderer-level
    // regression coverage this fix actually targets.
    it('restoring an already-saved quarry (still) re-emits quarry:placed so a renderer built before restoreWorld picks it up', () => {
      const w = freshWorld('quarry-restore-noemit');
      const anchor = findAnchor(w.hf, 64);
      w.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      const placement = w.quarry.placement;
      const json = serialize({ seed: 'quarry-restore-noemit', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;

      const w2 = freshWorld('quarry-restore-noemit');
      let placedCount = 0;
      let lastPlacement: unknown = null;
      w2.bus.on('quarry:placed', (e) => { placedCount++; lastPlacement = e; });
      restoreWorld(save, w2);

      expect(w2.quarry.placement).toEqual(placement);
      expect(placedCount).toBe(1); // emitted so a pre-constructed renderer learns of the restored quarry
      expect(lastPlacement).toEqual(placement);
    });

    it('a v1 save (no quarry field) migrates forward: deserialize succeeds, and restoring with an existing road places a quarry deterministically', () => {
      const w = freshWorld('quarry-migration');
      const anchor = findAnchor(w.hf, 64);
      w.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);

      // Hand-craft a v1-shaped save (no `quarry` key at all) using this world's real edge data.
      const v1Save = {
        version: 1,
        seed: 'quarry-migration',
        timeOfDay: 0.2,
        edges: [...w.graph.edges.values()].map((e) => ({ ctrl: e.ctrl, stage: e.stage })),
        growth: { dev: w.growth.devLevels, spawned: w.growth.spawned.slice() },
      };
      const json = JSON.stringify(v1Save);

      const save = deserialize(json);
      expect(save).not.toBeNull();
      expect(save!.version).toBe(4);

      const w2 = freshWorld('quarry-migration');
      expect(w2.quarry.placement).toBeNull();
      restoreWorld(save!, w2);
      expect(w2.quarry.placement).not.toBeNull();

      // Deterministic: restoring the SAME v1 save into a second fresh world yields the same site.
      const w3 = freshWorld('quarry-migration');
      restoreWorld(save!, w3);
      expect(w3.quarry.placement).toEqual(w2.quarry.placement);
    });

    it('a v1 save with zero edges migrates forward with no quarry (nothing to anchor a placement to yet)', () => {
      const v1Save = {
        version: 1,
        seed: 'quarry-migration-empty',
        timeOfDay: 0,
        edges: [],
        growth: { dev: [], spawned: [] },
      };
      const save = deserialize(JSON.stringify(v1Save));
      expect(save).not.toBeNull();

      const w = freshWorld('quarry-migration-empty');
      restoreWorld(save!, w);
      expect(w.quarry.placement).toBeNull();
    });
  });

  describe('record ids (Task 35)', () => {
    it('round-trips ids on growth records through serialize/deserialize', () => {
      const w = freshWorld('ids-roundtrip');
      const anchor = findAnchor(w.hf, 64);
      w.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      for (const e of w.graph.edges.values()) e.stage = 'painted';
      w.bus.emit('roads:changed', {});
      for (let i = 0; i < 60 * 420; i++) w.growth.update(1 / 60);
      expect(w.growth.spawned.length).toBeGreaterThan(0);
      const ids = w.growth.spawned.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length); // all unique
      expect(ids.every((id) => typeof id === 'number')).toBe(true);

      const json = serialize({ seed: 'ids-roundtrip', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.growth.spawned.map((r) => r.id)).toEqual(ids);
    });

    it('a v2 save (no record ids) migrates forward: deserialize assigns sequential ids', () => {
      const v2Save = {
        version: 2,
        seed: 'ids-migration',
        timeOfDay: 0,
        edges: [],
        growth: {
          dev: [],
          spawned: [
            { kind: 'tree', x: 1, z: 2, rot: 0 },
            { kind: 'house', x: 3, z: 4, rot: 1 },
            { kind: 'field', x: 5, z: 6, rot: 2 },
          ],
        },
        quarry: null,
      };
      const save = deserialize(JSON.stringify(v2Save));
      expect(save).not.toBeNull();
      expect(save!.version).toBe(4);
      const ids = save!.growth.spawned.map((r) => r.id);
      expect(ids).toEqual([1, 2, 3]);
      expect(new Set(ids).size).toBe(3);
    });

    it('a v1 save (no record ids, no quarry) migrates all the way to v4 with ids assigned', () => {
      const v1Save = {
        version: 1,
        seed: 'ids-migration-v1',
        timeOfDay: 0,
        edges: [],
        growth: {
          dev: [],
          spawned: [
            { kind: 'tree', x: 1, z: 2, rot: 0 },
            { kind: 'building', x: 3, z: 4, rot: 1 },
          ],
        },
      };
      const save = deserialize(JSON.stringify(v1Save));
      expect(save).not.toBeNull();
      expect(save!.version).toBe(4);
      expect(save!.growth.spawned.map((r) => r.id)).toEqual([1, 2]);
      expect(save!.quarry).toBeUndefined(); // still the v1-migration sentinel, unresolved (no edges)
    });

    it('restoring a migrated save into a live GrowthSim yields ids usable for upgrade/remove', () => {
      const v2Save = {
        version: 2,
        seed: 'ids-restore',
        timeOfDay: 0,
        edges: [],
        growth: {
          dev: [],
          spawned: [{ kind: 'house', x: 10, z: 10, rot: 0 }],
        },
        quarry: null,
      };
      const save = deserialize(JSON.stringify(v2Save))!;
      const w = freshWorld('ids-restore');
      restoreWorld(save, w);
      expect(w.growth.spawned.length).toBe(1);
      expect(typeof w.growth.spawned[0].id).toBe('number');
      expect(w.growth.houseCount).toBe(1);
    });
  });

  // Finding 2 (Task 35 follow-up "Groundwork"): stranded-decay grace/fade timelines must survive a
  // save/reload rather than resetting — `growth.decay` persists in-flight timers as sim-time-
  // relative offsets (see GrowthSim.decayState/DecayEntry).
  describe('decay state persistence (Finding 2)', () => {
    /** Land spot far enough from `anchor` (>MAX_ROAD_DIST_CELLS' ~24u) that a record placed there
     * reads as stranded once the road-distance BFS runs, mirroring growth.test.ts's own helper. */
    function findFarLandSpot(hf: Heightfield, anchor: { x: number; z: number }, minDist: number): { x: number; z: number } {
      for (let x = -220; x <= 220; x += 8) {
        for (let z = -220; z <= 220; z += 8) {
          if (Math.hypot(x - anchor.x, z - anchor.z) < minDist) continue;
          if (hf.isLand(x, z) && hf.isLand(x + 32, z)) return { x, z };
        }
      }
      throw new Error('no far land spot found');
    }

    it('a save with no in-flight timers serializes an empty decay array', () => {
      const w = freshWorld('decay-empty-save');
      const anchor = findAnchor(w.hf, 32);
      w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
      for (const e of w.graph.edges.values()) e.stage = 'painted';
      w.bus.emit('roads:changed', {});
      for (let i = 0; i < 60 * 10; i++) w.growth.update(1 / 60);

      const json = serialize({ seed: 'decay-empty-save', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.growth.decay).toEqual([]);
    });

    it('save mid-grace -> restore -> removal happens after the REMAINING grace+fade, not a full restart', () => {
      const w = freshWorld('decay-save-midgrace');
      const anchor = findAnchor(w.hf, 32);
      w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
      for (const e of w.graph.edges.values()) e.stage = 'painted';
      w.bus.emit('roads:changed', {});
      w.growth.update(3); // apply the throttled recompute

      const farSpot = findFarLandSpot(w.hf, anchor, 40);
      w.growth.restore(new Float32Array(w.growth.devLevels.length), [{ kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 }]);
      w.growth.update(1 / 60); // apply pending recompute from restore() -> reads stranded
      for (let i = 0; i < 60 * 40; i++) w.growth.update(1 / 60); // 40s into the 60s grace

      const state = w.growth.decayState;
      expect(state.length).toBe(1);
      expect(state[0].stranded).toBeCloseTo(40, 0);

      const json = serialize({ seed: 'decay-save-midgrace', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.growth.decay).toEqual([{ id: 1, stranded: expect.closeTo(40, 1) }]);

      const w2 = freshWorld('decay-save-midgrace');
      restoreWorld(save, w2);

      const strandedIds: number[] = [];
      const removedIds: number[] = [];
      w2.bus.on('growth:stranded', (e) => strandedIds.push(e.id));
      w2.bus.on('growth:remove', (e) => removedIds.push(e.id));

      // Only ~20s of grace remain (40 already elapsed pre-save) — well under a full 60s from here.
      for (let i = 0; i < 60 * 19; i++) w2.growth.update(1 / 60);
      expect(strandedIds).toEqual([]);
      for (let i = 0; i < 60 * 3; i++) w2.growth.update(1 / 60);
      expect(strandedIds).toEqual([1]);
      expect(removedIds).toEqual([]);

      for (let i = 0; i < 60 * 32; i++) w2.growth.update(1 / 60); // the 30s fade
      expect(removedIds).toEqual([1]);
    });

    it('save mid-fade -> restore -> renderer-observable fading map carries the correct remaining offset, and removal completes on schedule', () => {
      const w = freshWorld('decay-save-midfade');
      const anchor = findAnchor(w.hf, 32);
      w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
      for (const e of w.graph.edges.values()) e.stage = 'painted';
      w.bus.emit('roads:changed', {});
      w.growth.update(3);

      const farSpot = findFarLandSpot(w.hf, anchor, 40);
      w.growth.restore(new Float32Array(w.growth.devLevels.length), [{ kind: 'house', x: farSpot.x, z: farSpot.z, rot: 0, id: 1 }]);
      w.growth.update(1 / 60);
      for (let i = 0; i < 60 * 75; i++) w.growth.update(1 / 60); // past 60s grace, 15s into the 30s fade

      const state = w.growth.decayState;
      expect(state.length).toBe(1);
      expect(state[0].fading).toBeCloseTo(15, 0);

      const json = serialize({ seed: 'decay-save-midfade', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry, weather: DEFAULT_WEATHER_SAVE });
      const save = deserialize(json)!;
      expect(save.growth.decay[0].fading).toBeCloseTo(15, 1);
      expect(save.growth.decay[0].stranded).toBeUndefined();

      const w2 = freshWorld('decay-save-midfade');
      restoreWorld(save, w2);
      // Restored sim's own decayState immediately reflects the resumed offset (the reliable,
      // renderer-independent observable point for "resumed, not restarted" — SceneryRenderer's own
      // partial-fade application on `rebuild()` is covered by tests/sceneryDecay.test.ts).
      const restoredState = w2.growth.decayState;
      expect(restoredState.length).toBe(1);
      expect(restoredState[0].fading).toBeCloseTo(15, 0);

      const removedIds: number[] = [];
      w2.bus.on('growth:remove', (e) => removedIds.push(e.id));
      for (let i = 0; i < 60 * 14; i++) w2.growth.update(1 / 60); // just under the remaining ~15s
      expect(removedIds).toEqual([]);
      for (let i = 0; i < 60 * 3; i++) w2.growth.update(1 / 60); // cross it
      expect(removedIds).toEqual([1]);
    });

    it('migrating a v1/v2 save (no decay field) loads with an empty decay array', () => {
      const v1Save = {
        version: 1,
        seed: 'decay-migration-v1',
        timeOfDay: 0,
        edges: [],
        growth: { dev: [], spawned: [{ kind: 'tree', x: 1, z: 2, rot: 0 }] },
      };
      const save1 = deserialize(JSON.stringify(v1Save));
      expect(save1).not.toBeNull();
      expect(save1!.growth.decay).toEqual([]);

      const v2Save = {
        version: 2,
        seed: 'decay-migration-v2',
        timeOfDay: 0,
        edges: [],
        growth: { dev: [], spawned: [{ kind: 'tree', x: 1, z: 2, rot: 0 }] },
        quarry: null,
      };
      const save2 = deserialize(JSON.stringify(v2Save));
      expect(save2).not.toBeNull();
      expect(save2!.growth.decay).toEqual([]);

      // Restores cleanly into a live world with no in-flight timers.
      const w = freshWorld('decay-migration-v1');
      restoreWorld(save1!, w);
      expect(w.growth.decayState).toEqual([]);
    });

    it('rejects a save with a malformed decay entry (both stranded and fading present)', () => {
      const base = {
        version: 3,
        seed: 'decay-malformed',
        timeOfDay: 0,
        edges: [],
        quarry: null,
      };
      expect(
        deserialize(JSON.stringify({ ...base, growth: { dev: [], spawned: [], decay: [{ id: 1, stranded: 5, fading: 5 }] } })),
      ).toBeNull();
      expect(
        deserialize(JSON.stringify({ ...base, growth: { dev: [], spawned: [], decay: [{ id: 1 }] } })),
      ).toBeNull();
      expect(
        deserialize(JSON.stringify({ ...base, growth: { dev: [], spawned: [], decay: [{ stranded: 5 }] } })),
      ).toBeNull();
    });
  });

  // T41 review (also/Minor from review): a closed loop commits as two half-loop edges sharing a
  // midpoint node (see graph.ts's commitClosedLoop / tests/graph.test.ts's "closed loops (Task 41)"
  // describe block). `restoreWorld` replays each saved edge's `ctrl` chain through
  // `graph.commitChain` independently and in save order — the regression this guards against is
  // node duplication: if replaying the second half's ctrl (mid -> start) didn't recognize the
  // start/mid points as the SAME already-restored nodes from the first half, restore would mint
  // fresh duplicate nodes instead of reconnecting the ring.
  describe('closed loop save/restore (T41 follow-up)', () => {
    /** Finds an 8u-grid-aligned square of land big enough to draw a simple closed-loop stroke:
     * corners (x,z), (x+side,z), (x+side,z+side), (x,z+side), back to (x,z). */
    function findLoopSquare(hf: Heightfield, side: number): { x: number; z: number } {
      for (let x = -160; x <= 160; x += 8) {
        for (let z = -160; z <= 160; z += 8) {
          if (
            hf.isLand(x, z) &&
            hf.isLand(x + side, z) &&
            hf.isLand(x + side, z + side) &&
            hf.isLand(x, z + side)
          ) {
            return { x, z };
          }
        }
      }
      throw new Error('no land square found');
    }

    it('committing a closed loop, saving, and restoring into a fresh world yields 2 edges, 2 nodes, and both halves sharing the same two node ids (no duplication)', () => {
      const w = freshWorld('loop-save-test');
      const c = findLoopSquare(w.hf, 16);
      const ids = w.graph.commitChain([
        { x: c.x, z: c.z },
        { x: c.x + 16, z: c.z },
        { x: c.x + 16, z: c.z + 16 },
        { x: c.x, z: c.z + 16 },
        { x: c.x, z: c.z },
      ]);
      expect(ids).toHaveLength(2);
      expect(w.graph.nodes.size).toBe(2);
      const originalNodeIds = new Set<number>();
      for (const id of ids) {
        const e = w.graph.edges.get(id)!;
        originalNodeIds.add(e.a);
        originalNodeIds.add(e.b);
      }
      expect(originalNodeIds.size).toBe(2);

      const json = serialize({
        seed: 'loop-save-test',
        timeOfDay: 0.4,
        graph: w.graph,
        growth: w.growth,
        quarry: w.quarry,
        weather: DEFAULT_WEATHER_SAVE,
      });
      const save = deserialize(json)!;
      expect(save.edges).toHaveLength(2);

      const w2 = freshWorld('loop-save-test');
      restoreWorld(save, w2);

      expect(w2.graph.edges.size).toBe(2);
      expect(w2.graph.nodes.size).toBe(2);

      const restoredNodeIds = new Set<number>();
      const restoredNodePairs: Array<[number, number]> = [];
      for (const e of w2.graph.edges.values()) {
        restoredNodeIds.add(e.a);
        restoredNodeIds.add(e.b);
        restoredNodePairs.push([e.a, e.b]);
      }
      // Still exactly 2 distinct nodes after restore (no duplication of the shared start/mid nodes).
      expect(restoredNodeIds.size).toBe(2);
      // Both restored halves reference the SAME two node ids as each other (they share endpoints,
      // forming a ring) rather than each half getting its own disconnected pair.
      const [pairA, pairB] = restoredNodePairs;
      const setA = new Set(pairA);
      const setB = new Set(pairB);
      expect(setA).toEqual(setB);
    });
  });
});
