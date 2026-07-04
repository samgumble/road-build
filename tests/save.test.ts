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
    const json = serialize({ seed: 'save-test', timeOfDay: 0.7, graph: w.graph, growth: w.growth, quarry: w.quarry });
    const save = deserialize(json)!;
    expect(save.version).toBe(3);
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
    const json = serialize({ seed: 'resume-test', timeOfDay: 0.5, graph: w.graph, growth: w.growth, quarry: w.quarry });
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

      const json = serialize({ seed: 'quarry-save-test', timeOfDay: 0.3, graph: w.graph, growth: w.growth, quarry: w.quarry });
      const save = deserialize(json)!;
      expect(save.quarry).toEqual(placement);

      const w2 = freshWorld('quarry-save-test');
      restoreWorld(save, w2);
      expect(w2.quarry.placement).toEqual(placement);
    });

    it('serializes quarry: null when no road has ever been committed', () => {
      const w = freshWorld('quarry-none-test');
      expect(w.quarry.placement).toBeNull();
      const json = serialize({ seed: 'quarry-none-test', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry });
      const save = deserialize(json)!;
      expect(save.quarry).toBeNull();
    });

    it('restoring does not re-place or re-emit quarry:placed for an already-saved quarry', () => {
      const w = freshWorld('quarry-restore-noemit');
      const anchor = findAnchor(w.hf, 64);
      w.graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
      const placement = w.quarry.placement;
      const json = serialize({ seed: 'quarry-restore-noemit', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry });
      const save = deserialize(json)!;

      const w2 = freshWorld('quarry-restore-noemit');
      let placedCount = 0;
      w2.bus.on('quarry:placed', () => { placedCount++; });
      restoreWorld(save, w2);

      expect(w2.quarry.placement).toEqual(placement);
      expect(placedCount).toBe(0); // restore() seeds silently, no duplicate event
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
      expect(save!.version).toBe(3);

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

      const json = serialize({ seed: 'ids-roundtrip', timeOfDay: 0, graph: w.graph, growth: w.growth, quarry: w.quarry });
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
      expect(save!.version).toBe(3);
      const ids = save!.growth.spawned.map((r) => r.id);
      expect(ids).toEqual([1, 2, 3]);
      expect(new Set(ids).size).toBe(3);
    });

    it('a v1 save (no record ids, no quarry) migrates all the way to v3 with ids assigned', () => {
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
      expect(save!.version).toBe(3);
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
});
